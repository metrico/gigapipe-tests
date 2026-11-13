const {
  _it,
  axiosGet,
  axiosPost,
  clokiExtUrl,
  clokiWriteUrl,
  start,
  end,
  testID
} = require('./common')

// TraceQL metrics filtered or grouped by a span attribute. The attribute lives
// in the attributes index, not on the span row, so every one of these queries
// joins the two: on a cluster that join reads two distributed tables.
const metricsTestID = testID + 'tqm'
const headers = { 'X-Scope-OrgID': '2' }
// 6 spans with env=a, 4 with env=b.
const ENVS = ['a', 'a', 'a', 'a', 'a', 'a', 'b', 'b', 'b', 'b']

_it('traceql metrics: initialize', async () => {
  const tracePrefix = (parseInt(testID.substring(2)).toString(16) + 'e0000000000000000000000000000')
    .substring(0, 29)
  const spans = ENVS.map((env, i) => ({
    id: ('0000000000000000' + (i + 1)).substr(-16),
    traceId: tracePrefix + ('000' + i.toString(16)).substr(-3),
    timestamp: (start + i * 1000) + '000',
    duration: '1000',
    name: 'metrics span',
    tags: { testId: metricsTestID, env },
    localEndpoint: { serviceName: 'traceql-metrics' }
  }))
  await axiosPost('http://' + clokiWriteUrl + '/tempo/spans', JSON.stringify(spans), {
    headers: { 'Content-Type': 'application/json', ...headers }
  })
  await new Promise(resolve => setTimeout(resolve, 1000))
})

const metricsGet = async (path, q, extra) => {
  const req = 'http://' + clokiExtUrl + path +
    `?start=${Math.floor(start / 1000)}&end=${Math.floor(end / 1000) + 60}` +
    `&q=${encodeURIComponent(q)}` + (extra || '')
  const res = await axiosGet(req, { headers })
  return res.data.series
}
const queryRange = (q) => metricsGet('/api/metrics/query_range', q, '&step=60s')

const sumSamples = (series) => series.reduce((acc, s) =>
  acc + s.samples.reduce((a, p) => a + (p.value || 0), 0), 0)
const labelValue = (s, key) => {
  const l = s.labels.find(l => l.key === key || l.key.endsWith('.' + key))
  return l && l.value.stringValue
}
const filterAndGroupDeps = ['traceql metrics: initialize']

_it('traceql metrics: should filter by a span attribute', async () => {
  const series = await queryRange(`{span.testId="${metricsTestID}" && span.env="a"} | count_over_time()`)
  expect(sumSamples(series)).toBe(6)
}, filterAndGroupDeps)

_it('traceql metrics: should group by a span attribute', async () => {
  const series = await queryRange(`{span.testId="${metricsTestID}"} | count_over_time() by (span.env)`)
  const byEnv = {}
  for (const s of series) {
    byEnv[labelValue(s, 'env')] = sumSamples([s])
  }
  expect(byEnv).toEqual({ a: 6, b: 4 })
}, filterAndGroupDeps)

_it('traceql metrics: should filter an instant query by a span attribute', async () => {
  const series = await metricsGet('/api/metrics/query',
    `{span.testId="${metricsTestID}" && span.env="b"} | count_over_time()`)
  expect(series.reduce((acc, s) => acc + s.value, 0)).toBe(4)
}, filterAndGroupDeps)

_it('traceql metrics: should filter a histogram by a span attribute', async () => {
  const series = await queryRange(`{span.testId="${metricsTestID}" && span.env="a"} | histogram_over_time(duration)`)
  expect(sumSamples(series)).toBe(6)
}, filterAndGroupDeps)

_it('traceql metrics: should compare by a span attribute', async () => {
  const series = await queryRange(`{span.testId="${metricsTestID}"} | compare({span.env="b"})`)
  const count = (type, env) => sumSamples(series.filter(s =>
    labelValue(s, '__meta_type') === type && labelValue(s, 'env') === env))
  expect(count('selection', 'b')).toBe(4)
  expect(count('baseline', 'a')).toBe(6)
}, filterAndGroupDeps)
