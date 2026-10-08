// LogQL grid suite: every enabled case in grid/logql.cases.json must equal the
// Loki 3.x reference computed from the lines this suite writes.
const { _it, testID } = require('./common')
const seed = require('./grid/seed')
const { logql } = require('./grid/oracle')
const { diff } = require('./grid/compare')
const { logqlRuns, evalAt } = require('./grid/cases')
const client = require('./grid/client')

// Case ids that run.
const ENABLED = new Set([])

const TEST_ID = `${testID}_grid_logql`
const D0 = seed.anchor(Date.now())
const STREAMS = seed.logStreams(D0, { test_id: TEST_ID })
const SEEDED = 'grid logql: seed'

_it(SEEDED, async () => {
  await client.pushLogs(STREAMS)
  const end = D0 + seed.LOGQL.spanMinutes * seed.MINUTE
  const got = await client.waitForSeries('logql', `{test_id="${TEST_ID}"}`, D0, end, STREAMS.length)
  expect(got).toEqual(STREAMS.length)
})

for (const run of logqlRuns(D0, TEST_ID).filter(r => ENABLED.has(r.id))) {
  _it(`grid logql: ${run.name}`, async () => {
    const got = await client.queryLogql(run)
    const want = logql.evaluate(run.query, STREAMS, evalAt(run))
    expect(diff(got, want, { values: run.check === 'values' })).toEqual([])
  }, [SEEDED])
}

it.todo('grid logql: bytes_over_time/bytes_rate values')
