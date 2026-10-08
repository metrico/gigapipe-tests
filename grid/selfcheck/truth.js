// Packed ground-truth fixtures for the oracle self-check. A run's result is
// stored as [[metric, firstIndex, values]], where values[k] is the point at
// grid index firstIndex + k (null where the series has no point).

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SEED_D0 = Date.UTC(2026, 9, 1)
const SEED_TEST_ID = 'selfcheck'

const files = {
  seed: 'prom-3.14.seed.json.gz',
  bench01: 'prom-3.14.bench01.json.gz',
  bench02: 'loki-windows.bench02.json.gz'
}

const fixturePath = (name) => path.join(__dirname, files[name])
const load = (name) => JSON.parse(zlib.gunzipSync(fs.readFileSync(fixturePath(name))))
const save = (name, obj) => fs.writeFileSync(fixturePath(name), zlib.gzipSync(JSON.stringify(obj), { level: 9 }))

const grid = (run) => run.instant ? { t0: run.time, step: 1 } : { t0: run.start, step: run.step }

const enc = (v) => Number.isFinite(v) ? v : String(v)
const dec = (v) => typeof v === 'string' ? parseFloat(v.replace(/^\+?Inf$/, 'Infinity').replace(/^-Inf$/, '-Infinity')) : v

// pack converts a Prometheus API body into the packed form.
const pack = (run, body) => {
  const { t0, step } = grid(run)
  const rt = body.data.resultType
  return body.data.result.map(s => {
    const pts = (rt === 'matrix' ? s.values : [s.value])
      .map(([t, v]) => [Math.round((Math.round(parseFloat(t) * 1000) - t0) / step), dec(v)])
    const first = pts[0][0]
    const values = new Array(pts[pts.length - 1][0] - first + 1).fill(null)
    for (const [i, v] of pts) values[i - first] = enc(v)
    return [s.metric, first, values]
  })
}

// unpack returns [{metric, points: [[tMs, v]]}].
const unpack = (run, packed) => {
  const { t0, step } = grid(run)
  return packed.map(([metric, first, values]) => ({
    metric,
    points: values.flatMap((v, k) => v === null ? [] : [[t0 + (first + k) * step, dec(v)]])
  }))
}

module.exports = { SEED_D0, SEED_TEST_ID, files, fixturePath, load, save, pack, unpack }
