// PromQL grid suite: every enabled case in grid/prom.cases.json must equal the
// Prometheus 3.x reference computed from the samples this suite writes.
const { _it, testID } = require('./common')
const seed = require('./grid/seed')
const { prom } = require('./grid/oracle')
const { diff } = require('./grid/compare')
const { promRuns, evalAt } = require('./grid/cases')
const client = require('./grid/client')

// Case ids that run.
const ENABLED = new Set([
  'irate_15m', 'deriv_15m_y', 'i_irate_15m', 'i_deriv_15m_y',
  'unaligned_bare_x', 'unaligned_bare_y', 'unaligned_avg_ot_1h_y', 'unaligned_max_ot_5m_y',
  'unaligned_rate_15m', 'unaligned_absent_ot_5m_x', 'unaligned_offset_7m_y', 'unaligned_sum_by_y',
  'i_unaligned_bare_x', 'i_unaligned_bare_y', 'i_unaligned_max_ot_5m_y', 'i_unaligned_rate_15m',
  'i_unaligned_offset_7m_y'
])

const TEST_ID = `${testID}_grid_prom`
const D0 = seed.anchor(Date.now())
const SERIES = seed.promSeries(D0, { test_id: TEST_ID })
const SEEDED = 'grid prom: seed'

_it(SEEDED, async () => {
  await client.pushProm(SERIES)
  const got = await client.waitForSeries('prom', `{test_id="${TEST_ID}"}`, D0, D0 + seed.PROM.span, SERIES.length)
  expect(got).toEqual(SERIES.length)
})

for (const run of promRuns(D0, TEST_ID).filter(r => ENABLED.has(r.id))) {
  _it(`grid prom: ${run.name}`, async () => {
    const got = await client.queryProm(run)
    const want = prom.evaluate(run.query, SERIES, evalAt(run))
    expect(diff(got, want)).toEqual([])
  }, [SEEDED])
}
