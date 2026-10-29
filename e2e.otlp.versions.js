const crypto = require('crypto')
const protobuf = require('protobufjs')
const {
  _it,
  axiosGet,
  axiosPost,
  clokiExtUrl,
  clokiWriteUrl,
  otelCollectorUrl,
  start,
  end,
  testID
} = require('./common')
const querier = require('./pyroscope_pb/querier_pb')
const { Dictionary, profile, encodeRequest } = require('./otlp_profiles')

// Versioned telemetry: a rolling deploy.
//
// One service runs three instances. Each one moves from v1 to v2 at its own
// time, and every instance exports its metrics, logs, traces and profiles with
// service.version on the resource. The tests read each signal back by version:
// when a version was first and last seen, how many instances ran each version
// at a given time, a metric joined to the version of the instance that sent it,
// and logs, spans and profiles selected by version.
//
// Exports happen once a minute, at second 30 (+ the instance index) of each
// minute after `start`, so every one-minute PromQL step sees exactly one export
// per instance in its last 65 s. The last export is 8m30s after `start`, which
// is always in the past: `start` is at least ten minutes ago.

const service = 'versions-' + testID
const headers = { 'X-Scope-OrgID': '1' }
const INSTANCES = ['i0', 'i1', 'i2']
const EXPORTS = 9
// Export index at which each instance first runs v2.
const SWITCH = { i0: 3, i1: 5, i2: 7 }
const MIN = 60 * 1000

const exportTime = (k, i) => start + k * MIN + 30 * 1000 + i * 1000
const versionAt = (inst, k) => k < SWITCH[inst] ? 'v1' : 'v2'
const exportsOf = (cb) => {
  INSTANCES.forEach((inst, i) => {
    for (let k = 0; k < EXPORTS; k++) {
      cb(inst, i, k, versionAt(inst, k), exportTime(k, i))
    }
  })
}
const resourceAttrs = (inst, version) => ({
  'service.name': service,
  'service.version': version,
  'service.instance.id': inst
})

// Minimal OTLP/protobuf schemas for metrics, logs and traces. The field
// numbers are those of opentelemetry-proto; only the fields used here.
const root = protobuf.parse(`
syntax = "proto3";
package otlp;
message AnyValue { oneof value { string string_value = 1; } }
message KeyValue { string key = 1; AnyValue value = 2; }
message Resource { repeated KeyValue attributes = 1; }
message Scope { string name = 1; string version = 2; }
message NumberDataPoint {
  fixed64 time_unix_nano = 3;
  double as_double = 4;
}
message Gauge { repeated NumberDataPoint data_points = 1; }
message Metric { string name = 1; Gauge gauge = 5; }
message ScopeMetrics { Scope scope = 1; repeated Metric metrics = 2; }
message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; }
message MetricsData { repeated ResourceMetrics resource_metrics = 1; }
message LogRecord {
  fixed64 time_unix_nano = 1;
  int32 severity_number = 2;
  string severity_text = 3;
  AnyValue body = 5;
}
message ScopeLogs { Scope scope = 1; repeated LogRecord log_records = 2; }
message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; }
message LogsData { repeated ResourceLogs resource_logs = 1; }
message Status { string message = 2; int32 code = 3; }
message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  bytes parent_span_id = 4;
  string name = 5;
  int32 kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  Status status = 15;
}
message ScopeSpans { Scope scope = 1; repeated Span spans = 2; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
message TracesData { repeated ResourceSpans resource_spans = 1; }
`, { keepCase: true }).root

const encode = (type, msg) => {
  const T = root.lookupType('otlp.' + type)
  const err = T.verify(msg)
  if (err) {
    throw new Error(`invalid ${type}: ${err}`)
  }
  return Buffer.from(T.encode(msg).finish())
}
const nanos = (ms) => protobuf.util.Long.fromString(ms + '000000', true)
const attrs = (obj) => Object.entries(obj).map(([key, v]) => ({ key, value: { string_value: v } }))
const scope = { name: 'versions-e2e', version: '1.0.0' }
const id = (key, bytes) => crypto.createHash('md5').update(testID + key).digest().subarray(0, bytes)
const otlpPost = (path, body) => axiosPost(`http://${clokiWriteUrl}${path}`, body, {
  headers: { 'Content-Type': 'application/x-protobuf', ...headers }
})

// A gauge per instance whose value tells the version apart: v1 instances
// report 10, v2 instances 100. The metric has no version label of its own;
// the writer emits target_info, carrying service_version, next to it.
const INFLIGHT = { v1: 10, v2: 100 }

// SpanKind and StatusCode values from opentelemetry-proto.
const SERVER = 2
const CLIENT = 3
const ERROR = 2

const PUSH = 'versions: should push a rolling deploy on all signals'
_it(PUSH, async () => {
  const resourceMetrics = []
  const resourceLogs = []
  const resourceSpans = []
  exportsOf((inst, i, k, version, ts) => {
    const resource = { attributes: attrs(resourceAttrs(inst, version)) }
    resourceMetrics.push({
      resource,
      scope_metrics: [{
        scope,
        metrics: [{
          name: 'versions_inflight_requests',
          gauge: { data_points: [{ time_unix_nano: nanos(ts), as_double: INFLIGHT[version] }] }
        }]
      }]
    })
    resourceLogs.push({
      resource,
      scope_logs: [{
        scope,
        log_records: [{
          time_unix_nano: nanos(ts),
          severity_number: 9,
          severity_text: 'INFO',
          body: { string_value: `checkout handled by ${inst} running ${version}` }
        }]
      }]
    })
    // One trace per export: two server spans and one failing client span.
    // Every v2 export fails one server span; v1 fails one only in its very
    // first export. Client errors must never count as server errors.
    const traceId = id(`trace-${inst}-${k}`, 16)
    const span = (n, name, kind, error, parent) => ({
      trace_id: traceId,
      span_id: id(`span-${inst}-${k}-${n}`, 8),
      parent_span_id: parent ? id(`span-${inst}-${k}-${parent}`, 8) : Buffer.alloc(0),
      name,
      kind,
      start_time_unix_nano: nanos(ts + n * 10),
      end_time_unix_nano: nanos(ts + n * 10 + 100),
      status: error ? { code: ERROR, message: 'failed' } : {}
    })
    const serverError = version === 'v2' || (inst === 'i0' && k === 0)
    resourceSpans.push({
      resource,
      scope_spans: [{
        scope,
        spans: [
          span(0, 'POST /checkout', SERVER, false),
          span(1, 'POST /cart', SERVER, serverError, 0),
          span(2, 'GET /stock', CLIENT, true, 1)
        ]
      }]
    })
  })
  await otlpPost('/v1/metrics', encode('MetricsData', { resource_metrics: resourceMetrics }))
  await otlpPost('/v1/logs', encode('LogsData', { resource_logs: resourceLogs }))
  await otlpPost('/v1/traces', encode('TracesData', { resource_spans: resourceSpans }))
  await new Promise(resolve => setTimeout(resolve, 2000))
})

// PromQL

const sec = (ms) => Math.floor(ms / 1000)
const promQuery = async (q, timeMs) => {
  const res = await axiosGet(`http://${clokiExtUrl}/api/v1/query?query=${encodeURIComponent(q)}&time=${sec(timeMs)}`,
    { headers })
  return res.data.data.result
}
const byVersion = (result) => Object.fromEntries(result.map(r => [r.metric.service_version, parseFloat(r.value[1])]))
const targetInfo = `target_info{job="${service}", service_version!=""}`
// Every query below is evaluated nine minutes after `start`: after the last
// export, and never in the future.
const evalAt = start + 9 * MIN

_it('versions: should find when each version was first seen', async () => {
  const res = await promQuery(
    `min by (service_version) (min_over_time(timestamp(${targetInfo})[9m:1m]))`, evalAt)
  expect(byVersion(res)).toEqual({
    v1: sec(exportTime(0, 0)),
    v2: sec(exportTime(SWITCH.i0, 0))
  })
}, [PUSH])

_it('versions: should find when each version was last seen', async () => {
  const res = await promQuery(
    `max by (service_version) (max_over_time(timestamp(${targetInfo})[9m:1m]))`, evalAt)
  expect(byVersion(res)).toEqual({
    v1: sec(exportTime(SWITCH.i2 - 1, 2)),
    v2: sec(exportTime(EXPORTS - 1, 2))
  })
}, [PUSH])

// An instance is live on a version while it exported target_info for it in
// the last 65 s: one export interval plus a margin. The plain 5-minute
// lookback would keep an instance on its old version long after it moved.
_it('versions: should count the live instances of each version', async () => {
  const q = `count by (service_version) (max by (job, instance, service_version) (count_over_time(${targetInfo}[65s]) > 0))`
  // `m` minutes after start, the last 65 s hold export m-1 of every instance.
  const expected = (m) => {
    const counts = {}
    for (const inst of INSTANCES) {
      const version = versionAt(inst, m - 1)
      counts[version] = (counts[version] || 0) + 1
    }
    return counts
  }
  for (let m = 1; m <= EXPORTS; m++) {
    expect({ m, counts: byVersion(await promQuery(q, start + m * MIN)) })
      .toEqual({ m, counts: expected(m) })
  }
  // Spot checks of the rollout itself, independent of the helper above.
  expect(byVersion(await promQuery(q, start + 2 * MIN))).toEqual({ v1: 3 })
  expect(byVersion(await promQuery(q, start + 5 * MIN))).toEqual({ v1: 2, v2: 1 })
  expect(byVersion(await promQuery(q, start + 7 * MIN))).toEqual({ v1: 1, v2: 2 })
  expect(byVersion(await promQuery(q, evalAt))).toEqual({ v2: 3 })
}, [PUSH])

_it('versions: should join a metric to the version of its instance', async () => {
  const q = `sum by (service_version) (versions_inflight_requests{job="${service}"}` +
    ' * on (job, instance) group_left (service_version) ' +
    `max by (job, instance, service_version) (count_over_time(${targetInfo}[65s]) > 0))`
  // Five minutes after start, i0 runs v2 and i1, i2 still run v1.
  expect(byVersion(await promQuery(q, start + 5 * MIN)))
    .toEqual({ v1: 2 * INFLIGHT.v1, v2: INFLIGHT.v2 })
  expect(byVersion(await promQuery(q, evalAt))).toEqual({ v2: 3 * INFLIGHT.v2 })
}, [PUSH])

// LogQL

const logLines = async (q) => {
  const res = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/query_range?direction=BACKWARD&limit=1000` +
    `&query=${encodeURIComponent(q)}&start=${start}000000&end=${end + MIN}000000`, { headers })
  return res.data.data.result
}

_it('versions: should select logs by service_version', async () => {
  const count = (streams) => streams.reduce((acc, s) => acc + s.values.length, 0)
  const instances = (streams) => [...new Set(streams.map(s => s.stream.service_instance_id))].sort()
  // v1: i0 3 exports, i1 5, i2 7. v2: the remaining 6, 4 and 2.
  const v1 = await logLines(`{service_name="${service}", service_version="v1"}`)
  expect(count(v1)).toBe(15)
  expect(instances(v1)).toEqual(INSTANCES)
  const v2 = await logLines(`{service_name="${service}", service_version="v2"}`)
  expect(count(v2)).toBe(12)
  expect(v2.every(s => s.values.every(([, line]) => line.endsWith('running v2')))).toBe(true)
  const v2OnI2 = await logLines(`{service_name="${service}", service_version="v2", service_instance_id="i2"}`)
  expect(count(v2OnI2)).toBe(EXPORTS - SWITCH.i2)
}, [PUSH])

_it('versions: should count logs by service_version', async () => {
  const res = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/query?query=` +
    encodeURIComponent(`sum by (service_version) (count_over_time({service_name="${service}"}[10m]))`) +
    `&time=${evalAt}000000`, { headers })
  expect(byVersion(res.data.data.result)).toEqual({ v1: 15, v2: 12 })
}, [PUSH])

// TraceQL

const serverErrors = `resource.service.name="${service}" && kind=server && status=error`

const searchTraces = async (q) => {
  const res = await axiosGet(`http://${clokiExtUrl}/api/search` +
    `?start=${sec(start)}&end=${sec(end) + 60}&q=${encodeURIComponent(q)}&limit=100`, { headers })
  return res.data.traces
}

_it('versions: should search server errors by version', async () => {
  expect((await searchTraces(`{${serverErrors}}`)).length).toBe(13)
  expect((await searchTraces(`{${serverErrors} && resource.service.version="v2"}`)).length).toBe(12)
  expect((await searchTraces(`{${serverErrors} && resource.service.version="v1"}`)).length).toBe(1)
  // Every v1 trace has a failing client span; none of them is a server error.
  expect((await searchTraces(`{resource.service.name="${service}" && kind=client && status=error && resource.service.version="v1"}`)).length)
    .toBe(15)
}, [PUSH])

const traceMetrics = async (q) => {
  const res = await axiosGet(`http://${clokiExtUrl}/api/metrics/query_range` +
    `?start=${sec(start)}&end=${sec(end) + 60}&step=60s&q=${encodeURIComponent(q)}`, { headers })
  const byVer = {}
  for (const s of res.data.series) {
    const l = s.labels.find(l => l.key === 'resource.service.version' || l.key.endsWith('service.version'))
    byVer[l && l.value.stringValue] = s.samples.reduce((a, p) => a + (p.value || 0), 0)
  }
  return byVer
}

_it('versions: should count server errors by version', async () => {
  expect(await traceMetrics(`{${serverErrors}} | count_over_time() by (resource.service.version)`))
    .toEqual({ v1: 1, v2: 12 })
}, [PUSH])

_it('versions: should rate server errors by version', async () => {
  // A rate is per second over each 60 s step, so the samples sum to count / 60.
  const rates = await traceMetrics(`{${serverErrors}} | rate() by (resource.service.version)`)
  expect(Object.keys(rates).sort()).toEqual(['v1', 'v2'])
  expect(rates.v1 * 60).toBeCloseTo(1, 6)
  expect(rates.v2 * 60).toBeCloseTo(12, 6)
}, [PUSH])

// Profiles. OTLP resource attributes keep their dotted names as profile
// labels, so a selector names the version as "service.version", quoted.

const __it = (name, fn, deps) => _it(name, () => {
  if (!otelCollectorUrl) {
    return
  }
  return fn()
}, deps)

const CPU_TYPE = 'samples:samples:count:cpu:nanoseconds'
const PROFILES = 'versions: should push profiles of both versions'

// One CPU profile per instance and version, at the instance's first export of
// that version, each with a frame only that version has.
__it(PROFILES, async () => {
  for (const [i, inst] of INSTANCES.entries()) {
    for (const [version, k] of [['v1', 0], ['v2', SWITCH[inst]]]) {
      const dict = new Dictionary()
      const body = encodeRequest({
        dict,
        resourceAttrs: resourceAttrs(inst, version),
        profiles: [profile(dict, {
          sampleType: ['samples', 'count'],
          periodType: ['cpu', 'nanoseconds'],
          timeUnixNanoStr: exportTime(k, i) + '000000',
          samples: [{ stack: dict.stack([`checkout.${version}`, 'main']), values: [version === 'v1' ? 5 : 7] }]
        })]
      })
      await axiosPost(`${otelCollectorUrl}/v1development/profiles`, body, {
        headers: { 'Content-Type': 'application/x-protobuf', ...headers }
      })
    }
  }
  await new Promise(resolve => setTimeout(resolve, 2000))
})

const flamegraph = async (selector) => {
  const req = new querier.SelectMergeStacktracesRequest()
  req.setProfileTypeid(CPU_TYPE)
  req.setLabelSelector(selector)
  req.setStart(start)
  req.setEnd(end + MIN)
  const res = await axiosPost(`http://${clokiExtUrl}/querier.v1.QuerierService/SelectMergeStacktraces`,
    req.serializeBinary(), { responseType: 'arraybuffer', headers })
  return querier.SelectMergeStacktracesResponse.deserializeBinary(res.data).toObject().flamegraph
}

__it('versions: should select profiles by "service.version"', async () => {
  const v2 = await flamegraph(`{service_name="${service}", "service.version"="v2"}`)
  expect(v2.namesList).toContain('checkout.v2')
  expect(v2.namesList).not.toContain('checkout.v1')
  expect(v2.total).toBe(3 * 7)
  const v1 = await flamegraph(`{service_name="${service}", "service.version"="v1"}`)
  expect(v1.namesList).toContain('checkout.v1')
  expect(v1.namesList).not.toContain('checkout.v2')
  expect(v1.total).toBe(3 * 5)
}, [PROFILES])

__it('versions: should select profiles of one instance by "service.version"', async () => {
  const fg = await flamegraph(`{service_name="${service}", "service.version"="v2", "service.instance.id"="i1"}`)
  expect(fg.namesList).toContain('checkout.v2')
  expect(fg.total).toBe(7)
}, [PROFILES])
