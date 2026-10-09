// Helpers shared by the PromQL and LogQL reference evaluators.

const labelKey = (labels) => JSON.stringify(Object.keys(labels).sort().map(k => [k, labels[k]]))

// matches applies label matchers; a regex matcher is anchored.
const matches = (labels, ms) => ms.every(({ name, op, value }) => {
  const v = labels[name] || ''
  switch (op) {
    case '=': return v === value
    case '!=': return v !== value
    case '=~': return new RegExp(`^(?:${value})$`).test(v)
    case '!~': return !new RegExp(`^(?:${value})$`).test(v)
  }
  throw new Error(`oracle: matcher op ${op}`)
})

// window returns the items with lo < t <= hi; items are sorted by t.
const window = (items, lo, hi) => {
  let a = 0
  let b = items.length
  while (a < b) {
    const m = (a + b) >> 1
    if (items[m].t > lo) b = m
    else a = m + 1
  }
  const out = []
  for (let k = a; k < items.length && items[k].t <= hi; k++) out.push(items[k])
  return out
}

// quantile interpolates linearly between ranks, as Prometheus does.
const quantile = (q, vs) => {
  if (vs.length === 0) return NaN
  if (q < 0) return -Infinity
  if (q > 1) return Infinity
  const s = [...vs].sort((x, y) => x - y)
  const rank = q * (s.length - 1)
  const lo = Math.max(0, Math.floor(rank))
  const hi = Math.min(s.length - 1, lo + 1)
  const w = rank - Math.floor(rank)
  return s[lo] * (1 - w) + s[hi] * w
}

const variance = (vs) => {
  const mean = vs.reduce((a, b) => a + b, 0) / vs.length
  return vs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / vs.length
}

/**
 * aggregate groups an instant vector by `grouping` ({mode: 'by'|'without',
 * labels} or null for all) and reduces each group with op.
 * @param dropOnWithout {string[]} labels removed under `without`
 */
const aggregate = (op, grouping, vector, dropOnWithout = []) => {
  const groups = new Map()
  for (const el of vector) {
    let labels
    if (!grouping) labels = {}
    else if (grouping.mode === 'by') {
      labels = {}
      for (const l of grouping.labels) if (el.labels[l] !== undefined) labels[l] = el.labels[l]
    } else {
      labels = { ...el.labels }
      for (const l of [...dropOnWithout, ...grouping.labels]) delete labels[l]
    }
    const k = labelKey(labels)
    if (!groups.has(k)) groups.set(k, { labels, vs: [] })
    groups.get(k).vs.push(el.v)
  }
  return [...groups.values()].map(({ labels, vs }) => {
    const sum = vs.reduce((a, b) => a + b, 0)
    const reducers = {
      sum: () => sum,
      avg: () => sum / vs.length,
      min: () => Math.min(...vs),
      max: () => Math.max(...vs),
      count: () => vs.length,
      group: () => 1,
      stddev: () => Math.sqrt(variance(vs)),
      stdvar: () => variance(vs)
    }
    if (!reducers[op]) throw new Error(`oracle: aggregation ${op}`)
    return { labels, v: reducers[op]() }
  })
}

// toSeries evaluates at every time and collects the points per label set,
// skipping a point when skip(v) holds; series come back sorted by labels.
const toSeries = (times, evalAt, skip = () => false) => {
  const series = new Map()
  for (const T of times) {
    for (const el of evalAt(T)) {
      if (skip(el.v)) continue
      const k = labelKey(el.labels)
      if (!series.has(k)) series.set(k, { metric: el.labels, points: [] })
      series.get(k).points.push([T, el.v])
    }
  }
  return [...series.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, s]) => s)
}

module.exports = { labelKey, matches, window, quantile, variance, aggregate, toSeries }
