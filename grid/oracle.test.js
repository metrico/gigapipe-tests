// Oracle self-check, run without a gigapipe stack: the PromQL evaluator must
// reproduce Prometheus 3.14 on the 01 harness dataset and on the grid seed,
// and the LogQL evaluator must reproduce the 02 harness's (T-R, T] windows.

const seed = require('./seed')
const { prom, logql } = require('./oracle')
const { diff } = require('./compare')
const { promRuns } = require('./cases')
const truth = require('./selfcheck/truth')
const bench01 = require('./selfcheck/bench01')

const at = (run) => run.instant ? { time: run.time } : run

describe('grid seed', () => {
  it('anchors D0 at floor(now - 3d, 1d) UTC', () => {
    expect(seed.anchor(Date.UTC(2026, 9, 8, 17, 30))).toEqual(Date.UTC(2026, 9, 5))
    expect(seed.anchor(Date.UTC(2026, 9, 8))).toEqual(Date.UTC(2026, 9, 5))
    expect(seed.anchor(Date.UTC(2026, 9, 8) - 1)).toEqual(Date.UTC(2026, 9, 4))
  })
})

describe('grid evaluation times', () => {
  it('PromQL range queries evaluate at start + k*step, never past end', () => {
    expect(prom.rangeGrid(7000, 1207000, 300000)).toEqual([7000, 307000, 607000, 907000, 1207000])
    expect(prom.rangeGrid(7250, 900000, 300000)).toEqual([7250, 307250, 607250])
  })
  it('LogQL range queries evaluate on epoch k*step, start floored and end ceiled', () => {
    expect(logql.rangeGrid(60000, 960000, 300000)).toEqual([0, 300000, 600000, 900000, 1200000])
    expect(logql.rangeGrid(300000, 900000, 300000)).toEqual([300000, 600000, 900000])
  })
})

describe('PromQL oracle vs Prometheus 3.14 on the 01 harness dataset', () => {
  const fixture = truth.load('bench01')
  const data = bench01.series()
  for (const run of bench01.runs()) {
    it(run.name, () => {
      const want = truth.unpack(run, fixture.runs[run.name])
      expect(diff(prom.evaluate(run.query, data, at(run)), want)).toEqual([])
    })
  }
})

describe('PromQL oracle vs Prometheus 3.14 on the grid seed', () => {
  const fixture = truth.load('seed')
  const data = seed.promSeries(truth.SEED_D0, { test_id: truth.SEED_TEST_ID })
  const runs = promRuns(truth.SEED_D0, truth.SEED_TEST_ID)

  it('holds ground truth for exactly the cases in prom.cases.json', () => {
    const names = new Set(runs.map(r => r.name))
    expect(runs.filter(r => !(r.name in fixture.runs)).map(r => r.name)).toEqual([])
    expect(Object.keys(fixture.runs).filter(n => !names.has(n))).toEqual([])
  })

  for (const run of runs) {
    it(run.name, () => {
      const want = truth.unpack(run, fixture.runs[run.name] || [])
      expect(diff(prom.evaluate(run.query, data, at(run)), want)).toEqual([])
    })
  }
})

describe('LogQL oracle vs the 02 harness windows', () => {
  const fixture = truth.load('bench02')
  const streams = seed.logStreams(fixture.d0 * 1000, { job: 'ga' })
  // The harness keys series as {k=v,...} without quotes and absence as {}.
  const harnessKey = (query, metric) => query.startsWith('absent_over_time')
    ? '{}'
    : '{' + Object.keys(metric).sort().map(k => `${k}=${metric[k]}`).join(',') + '}'

  for (const [name, run] of Object.entries(fixture.runs)) {
    it(name, () => {
      const times = []
      if (run.instant) times.push(run.start * 1000)
      else for (let t = run.start; t <= run.end; t += run.step) times.push(t * 1000)
      const toPoints = ([first, values]) => values.flatMap((v, k) => v === null ? [] : [[times[first + k], v]])
      const want = Object.entries(run.series).map(([key, packed]) => ({ metric: { key }, points: toPoints(packed) }))
      const got = logql.evaluate(run.query, streams, { times })
        .map(s => ({ metric: { key: harnessKey(run.query, s.metric) }, points: s.points }))
      expect(diff(got, want)).toEqual([])
    })
  }
})
