const {
  _it, axiosGet, axiosPost, clokiExtUrl, clokiWriteUrl, testID, start, end, shard, extraHeaders
} = require('./common')

// Prometheus /api/v1/query_exemplars.
//
// Gigapipe stores the trace id of an OTLP metric data point's first exemplar in
// the sample's string column at ingest, so a metric point can be linked to the
// trace that produced it. This covers reading those back: the endpoint used to
// be wired to the metric-metadata handler, which answered with metadata and so
// looked to a client exactly like "this series has no exemplars".

const svcName = `exemplars-e2e-${testID}`
const metricName = 'exemplar_e2e_latency'
const routes = ['checkout', 'search']
const pointsPerSeries = 10

const otlpHeaders = {
  'Content-Type': 'application/json',
  'X-Scope-OrgID': '1',
  'X-Shard': shard,
  ...extraHeaders
}

// ms epoch -> ns epoch as a decimal string (ns values exceed
// Number.MAX_SAFE_INTEGER, so this is string concatenation, not arithmetic)
const ns = (ms) => ms.toString() + '000000'

// A trace id is 16 bytes. protojson decodes the OTLP `bytes` field from
// base64, while ingest stores it hex-encoded -- so each id is needed in both
// spellings: base64 going in, hex coming back out.
const traceIdBytes = (route, i) => {
  const b = Buffer.alloc(16)
  b.write('e2eexmpl', 0, 'ascii')
  b.writeUInt32BE(routes.indexOf(route) + 1, 8)
  b.writeUInt32BE(i + 1, 12)
  return b
}

// route -> [hex trace id], in the order the data points were sent
const expectedTraceIDs = Object.fromEntries(routes.map(route => [
  route,
  new Array(pointsPerSeries).fill(0).map((_, i) => traceIdBytes(route, i).toString('hex'))
]))

// Data-point timestamps, inside the run's query window.
const pointTimes = new Array(pointsPerSeries).fill(0).map((_, i) => start + i * 15000)

const strAttr = (key, value) => ({key: key, value: {stringValue: value}})

// One gauge, two series (one per route), every data point carrying its own
// exemplar. Distinct ids per point are what makes "every exemplar came back"
// an assertion rather than a coincidence.
const metricsPayload = () => ({
  resourceMetrics: [{
    resource: {
      attributes: [
        strAttr('service.name', svcName),
        strAttr('service.instance.id', 'exemplars-e2e-1')
      ]
    },
    scopeMetrics: [{
      scope: {name: 'qryn-e2e'},
      metrics: [{
        name: metricName,
        gauge: {
          dataPoints: routes.flatMap(route => pointTimes.map((t, i) => ({
            attributes: [strAttr('test_id', testID), strAttr('route', route)],
            timeUnixNano: ns(t),
            asDouble: i + 1,
            exemplars: [{
              timeUnixNano: ns(t),
              asDouble: i + 1,
              traceId: traceIdBytes(route, i).toString('base64')
            }]
          })))
        }
      }]
    }]
  }]
})

const queryExemplars = async (query, bounds) => {
  const params = new URLSearchParams()
  params.append('query', query)
  params.append('start', (bounds || {}).start || `${Math.floor(start / 1000)}`)
  params.append('end', (bounds || {}).end || `${Math.floor(end / 1000)}`)
  return axiosGet(`http://${clokiExtUrl}/api/v1/query_exemplars?${params}`,
    {validateStatus: () => true})
}

// Poll until check(res) passes or ~30s elapse; writer-side inserts are batched,
// so the first reads legitimately come back empty.
const waitFor = async (get, check) => {
  let last
  for (let i = 0; i < 30; i++) {
    last = await get()
    if (check(last)) {
      return last
    }
    await new Promise(f => setTimeout(f, 1000))
  }
  return last
}

// data[] -> {route: entry}, asserting the series identity on the way through
const byRoute = (data) => {
  const res = {}
  for (const entry of data) {
    expect(entry.seriesLabels.__name__).toEqual(metricName)
    expect(entry.seriesLabels.test_id).toEqual(testID)
    // job / instance come from service.name / service.instance.id
    expect(entry.seriesLabels.job).toEqual(svcName)
    res[entry.seriesLabels.route] = entry
  }
  return res
}

_it('should send otlp metrics carrying exemplars', async () => {
  const res = await axiosPost(`http://${clokiWriteUrl}/v1/metrics`,
    JSON.stringify(metricsPayload()), {headers: otlpHeaders})
  expect(res.status).toEqual(200)
  expect(res.data.partialSuccess).toBeUndefined()
})

_it('should answer query_exemplars with the stored trace ids', async () => {
  const res = await waitFor(
    () => queryExemplars(`${metricName}{test_id="${testID}"}`),
    r => r.status === 200 && (r.data.data || []).length >= routes.length
  )
  expect(res.status).toEqual(200)
  expect(res.data.status).toEqual('success')
  // The old behaviour was the metadata payload: an object keyed by metric
  // name, not a list of series. Asserting the shape catches a regression back
  // to it even if a series happens to have no exemplars.
  expect(Array.isArray(res.data.data)).toBeTruthy()
  expect(res.data.data.length).toEqual(routes.length)

  const series = byRoute(res.data.data)
  expect(Object.keys(series).sort()).toEqual([...routes].sort())

  for (const route of routes) {
    const got = series[route].exemplars.map(e => e.labels.trace_id)
    // Grafana reads the trace id off this label, so the name is part of the
    // contract, not an implementation detail.
    for (const e of series[route].exemplars) {
      expect(Object.keys(e.labels)).toEqual(['trace_id'])
    }
    expect(got.sort()).toEqual([...expectedTraceIDs[route]].sort())
  }
}, ['should send otlp metrics carrying exemplars'])

_it('should return every exemplar of a series, not just one', async () => {
  // A join that keeps one row per fingerprint would collapse a series' many
  // exemplars down to one and still look like a working endpoint, so the count
  // is asserted on its own.
  const res = await waitFor(
    () => queryExemplars(`${metricName}{test_id="${testID}"}`),
    r => r.status === 200 &&
      ((r.data.data || [])[0] || {exemplars: []}).exemplars.length >= pointsPerSeries
  )
  const series = byRoute(res.data.data)
  for (const route of routes) {
    expect(series[route].exemplars.length).toEqual(pointsPerSeries)
    const ids = series[route].exemplars.map(e => e.labels.trace_id)
    expect(new Set(ids).size).toEqual(pointsPerSeries)
  }
}, ['should answer query_exemplars with the stored trace ids'])

_it('should carry a value and a timestamp on each exemplar', async () => {
  const res = await queryExemplars(`${metricName}{test_id="${testID}"}`)
  expect(res.status).toEqual(200)
  const series = byRoute(res.data.data)
  const first = series[routes[0]].exemplars
  const startSec = start / 1000
  const endSec = end / 1000
  for (const e of first) {
    // Prometheus sends the exemplar value as a JSON *string* and the timestamp
    // as a JSON number -- it registers a custom encoder whose MarshalFloat
    // quotes the value and whose MarshalTimestamp does not. A client that
    // type-checks either one breaks if they come back the other way round, so
    // the types are asserted, not just the magnitudes.
    expect(typeof e.value).toEqual('string')
    expect(typeof e.timestamp).toEqual('number')
    // Fidelity limit, tracked in metrico/gigapipe#1037: ingest keeps only the
    // exemplar's trace id, so the value reported here is the data point's own
    // value. For these points the two were sent equal, so the assertion is on
    // the range the values were drawn from rather than on exemplar fidelity.
    const value = Number(e.value)
    expect(Number.isNaN(value)).toBeFalsy()
    expect(value).toBeGreaterThanOrEqual(1)
    expect(value).toBeLessThanOrEqual(pointsPerSeries)
    expect(e.timestamp).toBeGreaterThanOrEqual(startSec)
    expect(e.timestamp).toBeLessThanOrEqual(endSec)
  }
  const times = first.map(e => e.timestamp)
  // ordered by timestamp within the series
  expect([...times].sort((a, b) => a - b)).toEqual(times)
}, ['should answer query_exemplars with the stored trace ids'])

_it('should find the selector inside an expression', async () => {
  // Prometheus answers this endpoint for every vector selector in the
  // expression, not only for a bare one -- Grafana sends the panel's whole
  // query, which is normally wrapped in rate() or histogram_quantile().
  const res = await queryExemplars(`rate(${metricName}{test_id="${testID}"}[5m])`)
  expect(res.status).toEqual(200)
  expect(res.data.data.length).toEqual(routes.length)
  const series = byRoute(res.data.data)
  for (const route of routes) {
    const got = series[route].exemplars.map(e => e.labels.trace_id)
    expect(got.sort()).toEqual([...expectedTraceIDs[route]].sort())
  }
}, ['should answer query_exemplars with the stored trace ids'])

_it('should narrow exemplars by a label matcher', async () => {
  const res = await queryExemplars(
    `${metricName}{test_id="${testID}",route="${routes[0]}"}`)
  expect(res.status).toEqual(200)
  expect(res.data.data.length).toEqual(1)
  expect(res.data.data[0].seriesLabels.route).toEqual(routes[0])
  const got = res.data.data[0].exemplars.map(e => e.labels.trace_id)
  expect(got.sort()).toEqual([...expectedTraceIDs[routes[0]]].sort())
}, ['should answer query_exemplars with the stored trace ids'])

_it('should return no exemplars for a series that has none', async () => {
  const res = await queryExemplars(`${metricName}{test_id="${testID}_absent"}`)
  expect(res.status).toEqual(200)
  expect(res.data.status).toEqual('success')
  expect(res.data.data).toEqual([])
}, ['should send otlp metrics carrying exemplars'])

_it('should not mistake a log line for an exemplar', async () => {
  // Log samples keep the log line itself in the same string column exemplar
  // trace ids live in, so without a restriction to metric series every log
  // line in the window would come back as an exemplar.
  const logID = `${testID}_exlog`
  const res = await axiosPost(`http://${clokiWriteUrl}/loki/api/v1/push`, {
    streams: [{
      stream: {test_id: logID, route: 'checkout'},
      values: pointTimes.map(t => [ns(t), 'not a trace id'])
    }]
  }, {headers: {'Content-Type': 'application/json', 'X-Shard': shard}})
  expect(res.status).toBeGreaterThanOrEqual(200)
  expect(res.status).toBeLessThan(300)

  // Give the writer the same batching grace the metric reads get, then assert
  // the log stream is still absent rather than merely slow to appear.
  await new Promise(f => setTimeout(f, 5000))
  const ex = await queryExemplars(`{test_id="${logID}"}`)
  expect(ex.status).toEqual(200)
  expect(ex.data.data).toEqual([])
}, ['should send otlp metrics carrying exemplars'])

_it('should accept fractional unix second bounds', async () => {
  // Prometheus clients are free to send fractional unix seconds. These used to
  // fail to parse and silently fall back to the default window instead of the
  // one the caller asked for.
  //
  // The lower bound is a second early on purpose: the window is half-open at
  // the start, and the first data point sits exactly on `start`, so a bound of
  // start+0.250s would legitimately exclude it and the count below would be
  // measuring the bound rather than the parse.
  const res = await queryExemplars(`${metricName}{test_id="${testID}"}`, {
    start: `${Math.floor(start / 1000) - 1}.250`,
    end: `${Math.floor(end / 1000)}.750`
  })
  expect(res.status).toEqual(200)
  expect(res.data.data.length).toEqual(routes.length)
  const series = byRoute(res.data.data)
  for (const route of routes) {
    expect(series[route].exemplars.length).toEqual(pointsPerSeries)
  }
}, ['should answer query_exemplars with the stored trace ids'])

_it('should honour the requested time window', async () => {
  // Half-open the window just past the fifth point. A bound that was ignored
  // would return all ten.
  const cutoff = Math.floor((pointTimes[4] + 1000) / 1000)
  const res = await queryExemplars(`${metricName}{test_id="${testID}"}`,
    {start: `${Math.floor(start / 1000)}`, end: `${cutoff}`})
  expect(res.status).toEqual(200)
  expect(res.data.data.length).toEqual(routes.length)
  const series = byRoute(res.data.data)
  for (const route of routes) {
    expect(series[route].exemplars.length).toEqual(5)
    expect(series[route].exemplars.map(e => e.labels.trace_id).sort())
      .toEqual(expectedTraceIDs[route].slice(0, 5).sort())
  }
}, ['should answer query_exemplars with the stored trace ids'])

_it('should reject a request with no query', async () => {
  const res = await queryExemplars('')
  expect(res.status).toEqual(400)
})

_it('should reject an unparseable query', async () => {
  const res = await queryExemplars('this is not promql {{{')
  expect(res.status).toEqual(400)
})

_it('should answer a POSTed query', async () => {
  // Grafana POSTs this endpoint when the query is long enough to matter, and
  // the route used to accept GET only.
  const params = new URLSearchParams()
  params.append('query', `${metricName}{test_id="${testID}"}`)
  params.append('start', `${Math.floor(start / 1000)}`)
  params.append('end', `${Math.floor(end / 1000)}`)
  const res = await axiosPost(`http://${clokiExtUrl}/api/v1/query_exemplars`,
    params.toString(),
    {headers: {'Content-Type': 'application/x-www-form-urlencoded'}})
  expect(res.status).toEqual(200)
  expect(res.data.data.length).toEqual(routes.length)
}, ['should answer query_exemplars with the stored trace ids'])
