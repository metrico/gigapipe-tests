// gigapipe I/O for the grid suites: seeding through the public ingest APIs and
// querying through the public query APIs.

const fetch = require('node-fetch')
const { pushTimeseries } = require('prometheus-remote-write')
const { clokiExtUrl, clokiWriteUrl, axiosGet, axiosPost, extraHeaders, shard } = require('../common')
const { fromApi } = require('./compare')
const { secs } = require('./cases')

const ns = (ms) => `${ms}000000`

// pushProm remote-writes series in time order, batch samples per series per request.
const pushProm = async (series, batch = 144) => {
  const longest = Math.max(...series.map(s => s.samples.length))
  for (let from = 0; from < longest; from += batch) {
    const ts = series
      .map(s => ({ labels: s.labels, samples: s.samples.slice(from, from + batch).map(p => ({ value: p.v, timestamp: p.t })) }))
      .filter(s => s.samples.length)
    const res = await pushTimeseries(ts, {
      url: `http://${clokiWriteUrl}/api/v1/prom/remote/write`,
      fetch: (input, opts) => fetch(input, {
        ...opts,
        headers: {
          ...opts.headers,
          ...extraHeaders,
          'X-Scope-OrgID': '1',
          'X-Shard': shard,
          'Content-Type': 'application/x-protobuf'
        }
      })
    })
    if (Math.floor(res.status / 100) !== 2) throw new Error(`remote write: ${res.status} ${res.statusText}`)
  }
}

// pushLogs sends streams through the Loki push API, batch entries per request.
const pushLogs = async (streams, batch = 2000) => {
  for (const s of streams) {
    for (let from = 0; from < s.entries.length; from += batch) {
      await axiosPost(`http://${clokiWriteUrl}/loki/api/v1/push`, {
        streams: [{ stream: s.labels, values: s.entries.slice(from, from + batch).map(e => [ns(e.t), e.line]) }]
      }, { headers: { 'Content-Type': 'application/json', 'X-Shard': shard } })
    }
  }
}

// seriesCount returns how many series match selector in [startMs, endMs].
const seriesCount = async (api, selector, startMs, endMs) => {
  const qs = new URLSearchParams({ 'match[]': selector })
  if (api === 'prom') {
    qs.set('start', secs(startMs))
    qs.set('end', secs(endMs))
  } else {
    qs.set('start', ns(startMs))
    qs.set('end', ns(endMs))
  }
  const path = api === 'prom' ? '/api/v1/series' : '/loki/api/v1/series'
  const resp = await axiosGet(`http://${clokiExtUrl}${path}?${qs}`)
  return resp.data.data.length
}

// waitForSeries polls until want series are readable.
const waitForSeries = async (api, selector, startMs, endMs, want, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs
  let got = 0
  while (Date.now() < deadline) {
    got = await seriesCount(api, selector, startMs, endMs)
    if (got >= want) return got
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return got
}

// queryProm runs a grid run against the Prometheus API.
const queryProm = async (run) => {
  const qs = new URLSearchParams({ query: run.query })
  if (run.instant) qs.set('time', secs(run.time))
  else {
    qs.set('start', secs(run.start))
    qs.set('end', secs(run.end))
    qs.set('step', String(run.step / 1000))
  }
  const resp = await axiosGet(`http://${clokiExtUrl}/api/v1/${run.instant ? 'query' : 'query_range'}?${qs}`)
  return fromApi(resp.data)
}

// queryLogql runs a grid run against the Loki API.
const queryLogql = async (run) => {
  const qs = new URLSearchParams({ query: run.query, limit: '100000' })
  if (run.instant) qs.set('time', ns(run.time))
  else {
    qs.set('start', ns(run.start))
    qs.set('end', ns(run.end))
    qs.set('step', String(run.step / 1000))
  }
  const resp = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/${run.instant ? 'query' : 'query_range'}?${qs}`)
  return fromApi(resp.data)
}

module.exports = { pushProm, pushLogs, seriesCount, waitForSeries, queryProm, queryLogql }
