// Records Prometheus ground truth for the oracle self-check.
//
//   node grid/selfcheck/record-prom.js seed   <prom-url> [--write]
//   node grid/selfcheck/record-prom.js bench01 <prom-url> [--write]
//
// <prom-url> is a Prometheus 3.14 with --web.enable-remote-write-receiver and
// a 30d out-of-order window. --write remote-writes the dataset first.

const fetch = require('node-fetch')
const { pushTimeseries } = require('prometheus-remote-write')
const seed = require('../seed')
const { promRuns } = require('../cases')
const bench01 = require('./bench01')
const truth = require('./truth')

const datasets = {
  seed: () => ({
    series: seed.promSeries(truth.SEED_D0, { test_id: truth.SEED_TEST_ID }),
    runs: promRuns(truth.SEED_D0, truth.SEED_TEST_ID)
  }),
  bench01: () => ({ series: bench01.series(), runs: bench01.runs() })
}

const write = async (url, series) => {
  const batch = 144
  const longest = Math.max(...series.map(s => s.samples.length))
  for (let from = 0; from < longest; from += batch) {
    const ts = series.map(s => ({
      labels: s.labels,
      samples: s.samples.slice(from, from + batch).map(p => ({ value: p.v, timestamp: p.t }))
    })).filter(s => s.samples.length)
    const res = await pushTimeseries(ts, {
      url: `${url}/api/v1/write`,
      fetch: (input, opts) => fetch(input, {
        ...opts,
        headers: { ...opts.headers, 'Content-Type': 'application/x-protobuf', 'X-Prometheus-Remote-Write-Version': '0.1.0' }
      })
    })
    if (Math.floor(res.status / 100) !== 2) throw new Error(`remote write: ${res.status} ${res.statusText}`)
  }
}

const query = async (url, run) => {
  const qs = new URLSearchParams({ query: run.query })
  if (run.instant) qs.set('time', (run.time / 1000).toFixed(3))
  else {
    qs.set('start', (run.start / 1000).toFixed(3))
    qs.set('end', (run.end / 1000).toFixed(3))
    qs.set('step', String(run.step / 1000))
  }
  const res = await fetch(`${url}/api/v1/${run.instant ? 'query' : 'query_range'}?${qs}`)
  const body = await res.json()
  if (body.status !== 'success') throw new Error(`${run.name}: ${JSON.stringify(body)}`)
  return body
}

const main = async () => {
  const [name, url] = process.argv.slice(2)
  if (!datasets[name] || !url) throw new Error('usage: record-prom.js seed|bench01 <prom-url> [--write]')
  const { series, runs } = datasets[name]()
  if (process.argv.includes('--write')) await write(url, series)
  const out = { dataset: name, prometheus: (await (await fetch(`${url}/api/v1/status/buildinfo`)).json()).data.version, runs: {} }
  for (const run of runs) out.runs[run.name] = truth.pack(run, await query(url, run))
  truth.save(name, out)
  console.log(`${truth.fixturePath(name)}: ${runs.length} runs`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
