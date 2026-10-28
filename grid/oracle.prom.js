// PromQL reference evaluator over seeded samples, following Prometheus 3.x:
// a range query evaluates at start + k*step; a range vector at T is (T-R, T];
// the lookback is (T-5m, T]; a subquery's inner grid is epoch k*SS.
// Supports the subset the grid cases use. Times are milliseconds.

const { labelKey, matches, window, quantile, variance, aggregate, toSeries } = require('./oracle.common')

const LOOKBACK = 5 * 60 * 1000
const DEFAULT_SUBQUERY_STEP = 60 * 1000

const AGGS = new Set(['sum', 'min', 'max', 'avg', 'count', 'group'])
const OVER_TIME = new Set(['avg_over_time', 'min_over_time', 'max_over_time', 'sum_over_time',
  'count_over_time', 'first_over_time', 'last_over_time', 'present_over_time', 'stddev_over_time',
  'stdvar_over_time', 'quantile_over_time', 'absent_over_time'])
// Functions whose output keeps the metric name.
const KEEP_NAME = new Set(['first_over_time', 'last_over_time'])
const COUNTERS = new Set(['rate', 'increase', 'delta', 'irate', 'idelta', 'deriv', 'resets', 'changes'])

// ---------------------------------------------------------------- parser

const UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000, y: 31536000000 }

const tokenize = (src) => {
  const re = /\s*(?:(\d+(?:ms|s|m|h|d|w|y))+|(\d+(?:\.\d+)?(?:e[+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_:]*)|("(?:[^"\\]|\\.)*")|(=~|!~|!=|=|[(){}[\],:@]))/y
  const toks = []
  let pos = 0
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break
    re.lastIndex = pos
    const m = re.exec(src)
    if (!m) throw new Error(`promql oracle: cannot tokenize at ${pos}: ${src.slice(pos)}`)
    const text = m[0].trim()
    if (m[1] !== undefined) toks.push({ k: 'dur', v: text })
    else if (m[2] !== undefined) toks.push({ k: 'num', v: parseFloat(text) })
    else if (m[3] !== undefined) toks.push({ k: 'id', v: text })
    else if (m[4] !== undefined) toks.push({ k: 'str', v: JSON.parse(text) })
    else toks.push({ k: 'op', v: text })
    pos = re.lastIndex
  }
  return toks
}

const parseDuration = (s) => {
  let ms = 0
  for (const [, n, u] of s.matchAll(/(\d+)(ms|s|m|h|d|w|y)/g)) ms += parseInt(n) * UNITS[u]
  return ms
}

const parse = (src) => {
  const toks = tokenize(src)
  let i = 0
  const peek = () => toks[i]
  const next = () => toks[i++]
  const isOp = (v) => peek() && peek().k === 'op' && peek().v === v
  const isId = (v) => peek() && peek().k === 'id' && peek().v === v
  const expect = (v) => {
    const t = next()
    if (!t || t.v !== v) throw new Error(`promql oracle: expected ${v} in ${src}`)
    return t
  }
  const labelList = () => {
    expect('(')
    const ls = []
    while (!isOp(')')) {
      ls.push(next().v)
      if (isOp(',')) next()
    }
    expect(')')
    return ls
  }
  const matchers = () => {
    expect('{')
    const ms = []
    while (!isOp('}')) {
      const name = next().v
      const op = next().v
      const value = next().v
      ms.push({ name, op, value })
      if (isOp(',')) next()
    }
    expect('}')
    return ms
  }
  const modifiers = (node) => {
    for (;;) {
      if (isId('offset')) {
        next()
        node.offset = parseDuration(next().v)
      } else if (isOp('@')) {
        next()
        node.at = Math.round(next().v * 1000)
      } else return node
    }
  }
  const primary = () => {
    const t = peek()
    if (t.k === 'num') return { type: 'num', value: next().v }
    if (isOp('(')) {
      next()
      const e = expr()
      expect(')')
      return e
    }
    if (isOp('{')) return { type: 'vs', matchers: matchers(), offset: 0, at: null }
    const name = next().v
    if (AGGS.has(name)) {
      let grouping = null
      if (isId('by') || isId('without')) grouping = { mode: next().v, labels: labelList() }
      expect('(')
      const e = expr()
      expect(')')
      if (isId('by') || isId('without')) grouping = { mode: next().v, labels: labelList() }
      return { type: 'agg', op: name, grouping, expr: e }
    }
    if (isOp('(')) {
      next()
      const args = []
      while (!isOp(')')) {
        args.push(expr())
        if (isOp(',')) next()
      }
      expect(')')
      return { type: 'call', fn: name, args }
    }
    const ms = [{ name: '__name__', op: '=', value: name }]
    if (isOp('{')) ms.push(...matchers())
    return { type: 'vs', matchers: ms, offset: 0, at: null }
  }
  const expr = () => {
    let node = primary()
    for (;;) {
      if (isOp('[')) {
        next()
        const range = parseDuration(next().v)
        if (isOp(':')) {
          next()
          const step = peek().k === 'dur' ? parseDuration(next().v) : null
          expect(']')
          node = { type: 'subq', expr: node, range, step, offset: 0, at: null }
        } else {
          expect(']')
          if (node.type !== 'vs') throw new Error('promql oracle: range on a non-selector')
          node = { type: 'ms', vs: node, range }
        }
      } else if (isId('offset') || isOp('@')) {
        modifiers(node.type === 'ms' ? node.vs : node)
      } else return node
    }
  }
  const e = expr()
  if (i !== toks.length) throw new Error(`promql oracle: trailing input in ${src}`)
  return e
}

// ---------------------------------------------------------------- helpers

const dropName = (labels) => {
  const { __name__, ...rest } = labels
  return rest
}

// extrapolatedRate mirrors promql/functions.go extrapolatedRate.
const extrapolatedRate = (ss, rangeStart, rangeEnd, rangeMs, isCounter, isRate) => {
  if (ss.length < 2) return null
  const first = ss[0]
  const last = ss[ss.length - 1]
  let result = last.v - first.v
  if (isCounter) {
    let prev = first.v
    for (const p of ss.slice(1)) {
      if (p.v < prev) result += prev
      prev = p.v
    }
  }
  let toStart = (first.t - rangeStart) / 1000
  let toEnd = (rangeEnd - last.t) / 1000
  const sampled = (last.t - first.t) / 1000
  const avg = sampled / (ss.length - 1)
  const threshold = avg * 1.1
  if (toStart >= threshold) toStart = avg / 2
  if (isCounter && result > 0 && first.v >= 0) {
    const toZero = sampled * (first.v / result)
    if (toZero < toStart) toStart = toZero
  }
  if (toEnd >= threshold) toEnd = avg / 2
  let factor = (sampled + toStart + toEnd) / sampled
  if (isRate) factor /= rangeMs / 1000
  return result * factor
}

const deriv = (ss) => {
  if (ss.length < 2) return null
  if (ss.every(p => p.v === ss[0].v)) return 0
  const t0 = ss[0].t
  let n = 0; let sx = 0; let sy = 0; let sxy = 0; let sx2 = 0
  for (const p of ss) {
    const x = (p.t - t0) / 1000
    n++; sx += x; sy += p.v; sxy += x * p.v; sx2 += x * x
  }
  const cov = sxy - sx * sy / n
  const varx = sx2 - sx * sx / n
  return cov / varx
}

const rangeFn = (fn, ss, ctx) => {
  const vs = ss.map(p => p.v)
  switch (fn) {
    case 'avg_over_time': return vs.reduce((a, b) => a + b, 0) / vs.length
    case 'min_over_time': return Math.min(...vs)
    case 'max_over_time': return Math.max(...vs)
    case 'sum_over_time': return vs.reduce((a, b) => a + b, 0)
    case 'count_over_time': return vs.length
    case 'first_over_time': return vs[0]
    case 'last_over_time': return vs[vs.length - 1]
    case 'present_over_time': return 1
    case 'stddev_over_time': return Math.sqrt(variance(vs))
    case 'stdvar_over_time': return variance(vs)
    case 'quantile_over_time': return quantile(ctx.param, vs)
    case 'rate': return extrapolatedRate(ss, ctx.lo, ctx.hi, ctx.range, true, true)
    case 'increase': return extrapolatedRate(ss, ctx.lo, ctx.hi, ctx.range, true, false)
    case 'delta': return extrapolatedRate(ss, ctx.lo, ctx.hi, ctx.range, false, false)
    case 'irate':
    case 'idelta': {
      if (ss.length < 2) return null
      const a = ss[ss.length - 2]
      const b = ss[ss.length - 1]
      const d = fn === 'irate' && b.v < a.v ? b.v : b.v - a.v
      if (fn === 'idelta') return d
      return b.t === a.t ? null : d / ((b.t - a.t) / 1000)
    }
    case 'deriv': return deriv(ss)
    case 'resets': return ss.slice(1).filter((p, k) => p.v < ss[k].v).length
    case 'changes': return ss.slice(1).filter((p, k) => p.v !== ss[k].v).length
  }
  throw new Error(`promql oracle: function ${fn}`)
}

// ---------------------------------------------------------------- evaluator

// rangeVector returns [{labels, samples, lo, hi}] for a matrix selector or a
// subquery evaluated at T.
const rangeVector = (node, T, data) => {
  if (node.type === 'ms') {
    const hi = (node.vs.at ?? T) - node.vs.offset
    const lo = hi - node.range
    return data.filter(s => matches(s.labels, node.vs.matchers))
      .map(s => ({ labels: s.labels, samples: window(s.samples, lo, hi), lo, hi, range: node.range }))
      .filter(s => s.samples.length > 0)
  }
  if (node.type === 'subq') {
    const hi = (node.at ?? T) - node.offset
    const lo = hi - node.range
    const step = node.step || DEFAULT_SUBQUERY_STEP
    const series = new Map()
    for (let t = (Math.floor(lo / step) + 1) * step; t <= hi; t += step) {
      for (const el of instant(node.expr, t, data)) {
        const k = labelKey(el.labels)
        if (!series.has(k)) series.set(k, { labels: el.labels, samples: [], lo, hi, range: node.range })
        series.get(k).samples.push({ t, v: el.v })
      }
    }
    return [...series.values()]
  }
  throw new Error(`promql oracle: ${node.type} is not a range vector`)
}

const selectorOf = (node) => node.type === 'ms' ? node.vs : null

// instant evaluates node at T and returns [{labels, v}].
const instant = (node, T, data) => {
  switch (node.type) {
    case 'num': return [{ labels: {}, v: node.value }]
    case 'vs': {
      const hi = (node.at ?? T) - node.offset
      const out = []
      for (const s of data) {
        if (!matches(s.labels, node.matchers)) continue
        const w = window(s.samples, hi - LOOKBACK, hi)
        if (w.length) out.push({ labels: s.labels, v: w[w.length - 1].v })
      }
      return out
    }
    case 'call': {
      const { fn, args } = node
      const param = args.length === 2 ? args[0].value : undefined
      const arg = args[args.length - 1]
      if (fn === 'absent_over_time') {
        if (rangeVector(arg, T, data).length > 0) return []
        const vs = selectorOf(arg)
        const labels = {}
        for (const m of (vs ? vs.matchers : [])) {
          if (m.op === '=' && m.name !== '__name__') labels[m.name] = m.value
        }
        return [{ labels, v: 1 }]
      }
      if (OVER_TIME.has(fn) || COUNTERS.has(fn)) {
        const out = []
        for (const s of rangeVector(arg, T, data)) {
          const v = rangeFn(fn, s.samples, { param, lo: s.lo, hi: s.hi, range: s.range })
          if (v !== null) out.push({ labels: KEEP_NAME.has(fn) ? s.labels : dropName(s.labels), v })
        }
        return out
      }
      throw new Error(`promql oracle: function ${fn}`)
    }
    case 'agg':
      return aggregate(node.op, node.grouping, instant(node.expr, T, data), ['__name__'])
  }
  throw new Error(`promql oracle: cannot evaluate ${node.type}`)
}

// rangeGrid returns start + k*step for every point <= end.
const rangeGrid = (start, end, step) => {
  const ts = []
  for (let t = start; t <= end; t += step) ts.push(t)
  return ts
}

/**
 * evaluate runs query over data at the given evaluation times.
 * @param query {string}
 * @param data {{labels: Object, samples: {t: number, v: number}[]}[]}
 * @param at {{start: number, end: number, step: number} | {time: number}}
 * @returns {{metric: Object, points: [number, number][]}[]} sorted by labels
 */
const evaluate = (query, data, at) => {
  const ast = parse(query)
  const times = at.time !== undefined ? [at.time] : rangeGrid(at.start, at.end, at.step)
  return toSeries(times, T => instant(ast, T, data))
}

module.exports = { evaluate, parse, rangeGrid, LOOKBACK }
