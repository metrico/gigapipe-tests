// Normalises query API responses and diffs them against oracle results.
// A result is [{metric: {label: value}, points: [[tMs, value], ...]}].

const IGNORED_LABELS = ['service_name']

const seriesKey = (metric, ignore = IGNORED_LABELS) => '{' + Object.keys(metric)
  .filter(k => !ignore.includes(k))
  .sort()
  .map(k => `${k}=${JSON.stringify(metric[k])}`)
  .join(',') + '}'

// fromApi converts a Prometheus or Loki matrix/vector response body.
const fromApi = (body) => {
  const { resultType, result } = body.data
  if (resultType !== 'matrix' && resultType !== 'vector') {
    throw new Error(`unexpected resultType ${resultType}`)
  }
  return result.map(s => ({
    metric: s.metric,
    points: (resultType === 'matrix' ? s.values : [s.value])
      .map(([t, v]) => [Math.round(parseFloat(t) * 1000), parseFloat(v)])
  }))
}

const eq = (a, b) => {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b)
  if (a === b) return true
  return Math.abs(a - b) <= 1e-9 + 1e-6 * Math.min(Math.abs(a), Math.abs(b))
}

const iso = (ms) => new Date(ms).toISOString()

/**
 * diff compares got against want point by point and returns [] on a match,
 * or human-readable mismatches (at most `limit`, then a count of the rest).
 * With values: false only series and timestamps are compared.
 */
const diff = (got, want, { limit = 10, values = true } = {}) => {
  const index = (res) => {
    const m = new Map()
    for (const s of res) {
      const k = seriesKey(s.metric)
      if (!m.has(k)) m.set(k, new Map())
      for (const [t, v] of s.points) m.get(k).set(t, v)
    }
    return m
  }
  const g = index(got)
  const w = index(want)
  const out = []
  const keys = [...new Set([...g.keys(), ...w.keys()])].sort()
  for (const k of keys) {
    const gs = g.get(k) || new Map()
    const ws = w.get(k) || new Map()
    const ts = [...new Set([...gs.keys(), ...ws.keys()])].sort((a, b) => a - b)
    for (const t of ts) {
      if (!ws.has(t)) out.push(`${k} ${iso(t)} extra ${gs.get(t)}`)
      else if (!gs.has(t)) out.push(`${k} ${iso(t)} missing (want ${ws.get(t)})`)
      else if (values && !eq(gs.get(t), ws.get(t))) out.push(`${k} ${iso(t)} got ${gs.get(t)} want ${ws.get(t)}`)
    }
  }
  if (out.length > limit) return [...out.slice(0, limit), `... and ${out.length - limit} more`]
  return out
}

const pointCount = (res) => res.reduce((n, s) => n + s.points.length, 0)

module.exports = { fromApi, diff, eq, seriesKey, pointCount }
