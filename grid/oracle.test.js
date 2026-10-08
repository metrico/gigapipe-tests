// Oracle self-check, run without a gigapipe stack: the PromQL evaluator must
// reproduce recorded Prometheus 3.14 output on the PromQL repro dataset and on
// the grid seed, and the LogQL evaluator must reproduce the (T-R, T] windows
// the LogQL repro computed over the same lines as the LogQL seed.

const seed = require('./seed')
const { prom, logql } = require('./oracle')
const { diff } = require('./compare')
const { promRuns, evalAt } = require('./cases')
const truth = require('./selfcheck/truth')
const bench01 = require('./selfcheck/bench01')

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

describe('LogQL oracle on hand-checked windows', () => {
  const streams = [
    { labels: { job: 'j', l: 'a' }, entries: [{ t: 1000, line: 'size=4 x' }, { t: 2000, line: 'size=1 x' }, { t: 3000, line: 'size=7 x' }] },
    { labels: { job: 'j', l: 'b' }, entries: [{ t: 5000, line: 'size=2 x' }] }
  ]
  const U = '| regexp "size=(?P<size>[0-9]+)" | unwrap size'
  const at = (query, time) => logql.evaluate(query, streams, { time })

  it('unwrap aggregations read (T-R, T] and drop the unwrapped label', () => {
    expect(at(`avg_over_time({job="j"} ${U} [2s])`, 3000)).toEqual([{ metric: { job: 'j', l: 'a' }, points: [[3000, 4]] }])
    expect(at(`min_over_time({job="j", l="a"} ${U} [3s])`, 3000)[0].points).toEqual([[3000, 1]])
    expect(at(`max_over_time({job="j", l="a"} ${U} [3s])`, 3000)[0].points).toEqual([[3000, 7]])
    expect(at(`quantile_over_time(0.5, {job="j", l="a"} ${U} [3s])`, 3000)[0].points).toEqual([[3000, 4]])
  })
  it('a range aggregation by/without pools the samples of each group', () => {
    expect(at(`quantile_over_time(0.5, {job="j"} ${U} [5s]) by (job)`, 5000)).toEqual([{ metric: { job: 'j' }, points: [[5000, 3]] }])
    expect(at(`max_over_time({job="j"} ${U} [5s]) without (l)`, 5000)).toEqual([{ metric: { job: 'j' }, points: [[5000, 7]] }])
    expect(at(`max_over_time({job="j"} ${U} [2s]) by (l)`, 5000)).toEqual([{ metric: { l: 'b' }, points: [[5000, 2]] }])
  })
  it('absent_over_time is vector-level and labelled by the equality matchers', () => {
    expect(at('absent_over_time({job="j", l=~"a|b"} [1s])', 4000)).toEqual([{ metric: { job: 'j' }, points: [[4000, 1]] }])
    expect(at('absent_over_time({job="j"} [2s])', 4000)).toEqual([])
    expect(at('absent_over_time({job="none"} [1s])', 1000)).toEqual([{ metric: { job: 'none' }, points: [[1000, 1]] }])
  })
})

describe('PromQL oracle vs Prometheus 3.14 on the repro dataset', () => {
  const fixture = truth.load('bench01')
  const data = bench01.series()
  for (const run of bench01.runs()) {
    it(run.name, () => {
      const want = truth.unpack(run, fixture.runs[run.name])
      expect(diff(prom.evaluate(run.query, data, evalAt(run)), want)).toEqual([])
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
      expect(diff(prom.evaluate(run.query, data, evalAt(run)), want)).toEqual([])
    })
  }
})

describe('LogQL oracle vs the repro windows', () => {
  const fixture = truth.load('bench02')
  const streams = seed.logStreams(fixture.d0 * 1000, { job: 'ga' })
  // The repro keys series as {k=v,...} without quotes and absence as {}.
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
