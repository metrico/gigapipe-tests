// LogQL reference evaluator over seeded log lines, following Loki 3.x behind
// its default query frontend: a range query evaluates on epoch k*step with
// start floored and end ceiled to step; an instant query evaluates at T; a
// range aggregation at T is (T-offset-R, T-offset]. Zero values are dropped.
// Supports the subset the grid cases use. Times are milliseconds.

const { labelKey, matches, window, quantile, variance, aggregate, toSeries } = require('./oracle.common')

const UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }

const RANGE_FNS = new Set(['count_over_time', 'rate', 'bytes_over_time', 'bytes_rate',
  'absent_over_time', 'sum_over_time', 'avg_over_time', 'min_over_time', 'max_over_time',
  'first_over_time', 'last_over_time', 'stddev_over_time', 'stdvar_over_time',
  'quantile_over_time'])
const VECTOR_AGGS = new Set(['sum', 'min', 'max', 'avg', 'count', 'stddev', 'stdvar'])
const UNWRAPPED = new Set(['sum_over_time', 'avg_over_time', 'min_over_time', 'max_over_time',
  'first_over_time', 'last_over_time', 'stddev_over_time', 'stdvar_over_time',
  'quantile_over_time'])

// ---------------------------------------------------------------- parser

const tokenize = (src) => {
  const re = /\s*(?:(\[(?:\d+(?:ms|s|m|h|d|w))+\])|((?:\d+(?:ms|s|m|h|d|w))+)(?![\w.])|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|("(?:[^"\\]|\\.)*"|`[^`]*`)|(\|=|\|~|!=|!~|=~|=|\||[(){},]))/y
  const toks = []
  let pos = 0
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break
    re.lastIndex = pos
    const m = re.exec(src)
    if (!m) throw new Error(`logql oracle: cannot tokenize at ${pos}: ${src.slice(pos)}`)
    if (m[1] !== undefined) toks.push({ k: 'range', v: parseDuration(m[1].slice(1, -1)) })
    else if (m[2] !== undefined) toks.push({ k: 'dur', v: parseDuration(m[2]) })
    else if (m[3] !== undefined) toks.push({ k: 'num', v: parseFloat(m[3]) })
    else if (m[4] !== undefined) toks.push({ k: 'id', v: m[4] })
    else if (m[5] !== undefined) toks.push({ k: 'str', v: m[5][0] === '`' ? m[5].slice(1, -1) : JSON.parse(m[5]) })
    else toks.push({ k: 'op', v: m[6] })
    pos = re.lastIndex
  }
  return toks
}

const parseDuration = (s) => {
  let ms = 0
  for (const [, n, u] of s.matchAll(/(\d+)(ms|s|m|h|d|w)/g)) ms += parseInt(n) * UNITS[u]
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
    if (!t || t.v !== v) throw new Error(`logql oracle: expected ${v} in ${src}`)
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
  const selector = () => {
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
  const stage = () => {
    const t = next()
    if (['|=', '!=', '|~', '!~'].includes(t.v)) return { type: 'filter', op: t.v, value: next().v }
    if (t.v !== '|') throw new Error(`logql oracle: unexpected ${t.v} in ${src}`)
    const name = next().v
    switch (name) {
      case 'line_format': return { type: 'line_format', template: next().v }
      case 'regexp': return { type: 'regexp', re: next().v }
      case 'logfmt': return { type: 'logfmt' }
      case 'unwrap': return { type: 'unwrap', label: next().v }
    }
    throw new Error(`logql oracle: stage ${name}`)
  }
  const logRange = () => {
    const node = { matchers: selector(), stages: [], range: null, offset: 0 }
    for (;;) {
      const t = peek()
      if (t.k === 'range') node.range = next().v
      else if (isId('offset')) {
        next()
        node.offset = next().v
      } else if (t.k === 'op' && ['|=', '!=', '|~', '!~', '|'].includes(t.v)) node.stages.push(stage())
      else break
    }
    if (node.range === null) throw new Error(`logql oracle: no range in ${src}`)
    return node
  }
  const expr = () => {
    if (isOp('(')) {
      next()
      const e = expr()
      expect(')')
      return e
    }
    const name = next().v
    if (VECTOR_AGGS.has(name)) {
      let grouping = null
      if (isId('by') || isId('without')) grouping = { mode: next().v, labels: labelList() }
      expect('(')
      const e = expr()
      expect(')')
      if (isId('by') || isId('without')) grouping = { mode: next().v, labels: labelList() }
      return { type: 'agg', op: name, grouping, expr: e }
    }
    if (RANGE_FNS.has(name)) {
      expect('(')
      let param
      if (peek().k === 'num') {
        param = next().v
        expect(',')
      }
      const lr = logRange()
      expect(')')
      let grouping = null
      if (isId('by') || isId('without')) grouping = { mode: next().v, labels: labelList() }
      return { type: 'range', fn: name, param, grouping, ...lr }
    }
    throw new Error(`logql oracle: unsupported ${name} in ${src}`)
  }
  const e = expr()
  if (i !== toks.length) throw new Error(`logql oracle: trailing input in ${src}`)
  return e
}

// ---------------------------------------------------------------- pipeline

// addLabel follows Loki: an extracted label that collides with a stream
// label is stored as <name>_extracted.
const addLabel = (labels, stream, name, value) => {
  labels[stream[name] !== undefined ? `${name}_extracted` : name] = value
}

// run applies the pipeline to one entry; it returns {labels, value} or null
// when the entry is filtered out.
const run = (stages, stream, entry) => {
  const line = entry.line
  const labels = { ...stream }
  let value
  for (const s of stages) {
    switch (s.type) {
      case 'filter': {
        const hit = s.op[1] === '~' ? new RegExp(s.value).test(line) : line.includes(s.value)
        if (hit !== (s.op[0] === '|')) return null
        break
      }
      case 'line_format':
        if (s.template !== '{{__line__}}') throw new Error(`logql oracle: line_format ${s.template}`)
        break
      case 'regexp': {
        const m = new RegExp(s.re.replace(/\(\?P</g, '(?<')).exec(line)
        if (m && m.groups) for (const [k, v] of Object.entries(m.groups)) addLabel(labels, stream, k, v ?? '')
        break
      }
      case 'logfmt':
        for (const [, k, v1, v2] of line.matchAll(/([A-Za-z_][\w.]*)=(?:"((?:[^"\\]|\\.)*)"|(\S*))/g)) {
          addLabel(labels, stream, k, v1 ?? v2)
        }
        break
      case 'unwrap':
        value = parseFloat(labels[s.label])
        delete labels[s.label]
        if (Number.isNaN(value)) return null
        break
    }
  }
  return { labels, value, bytes: Buffer.byteLength(entry.line) }
}

// ---------------------------------------------------------------- evaluator

const reduce = (node, items) => {
  const r = node.range / 1000
  const vs = items.map(x => x.value)
  const sum = vs.reduce((a, b) => a + b, 0)
  switch (node.fn) {
    case 'count_over_time': return items.length
    case 'rate': return (node.unwrap ? sum : items.length) / r
    case 'bytes_over_time': return items.reduce((a, x) => a + x.bytes, 0)
    case 'bytes_rate': return items.reduce((a, x) => a + x.bytes, 0) / r
    case 'sum_over_time': return sum
    case 'avg_over_time': return sum / vs.length
    case 'min_over_time': return Math.min(...vs)
    case 'max_over_time': return Math.max(...vs)
    case 'first_over_time': return vs[0]
    case 'last_over_time': return vs[vs.length - 1]
    case 'stddev_over_time': return Math.sqrt(variance(vs))
    case 'stdvar_over_time': return variance(vs)
    case 'quantile_over_time': return quantile(node.param, vs)
  }
  throw new Error(`logql oracle: function ${node.fn}`)
}

// group keeps the `by` labels of an entry or drops the `without` ones.
const group = (labels, grouping) => {
  if (!grouping) return labels
  if (grouping.mode === 'without') {
    const out = { ...labels }
    for (const l of grouping.labels) delete out[l]
    return out
  }
  const out = {}
  for (const l of grouping.labels) if (labels[l] !== undefined) out[l] = labels[l]
  return out
}

// prepare runs the pipeline over every matched stream and returns the entries
// per output label set (after the range by/without), in time order.
const prepare = (node, streams) => {
  node.unwrap = node.stages.some(s => s.type === 'unwrap')
  if (UNWRAPPED.has(node.fn) && !node.unwrap) throw new Error(`logql oracle: ${node.fn} needs unwrap`)
  const series = new Map()
  for (const s of streams) {
    if (!matches(s.labels, node.matchers)) continue
    for (const e of s.entries) {
      const out = run(node.stages, s.labels, e)
      if (!out) continue
      const labels = group(out.labels, node.grouping)
      const k = labelKey(labels)
      if (!series.has(k)) series.set(k, { labels, items: [] })
      series.get(k).items.push({ t: e.t, value: out.value, bytes: out.bytes })
    }
  }
  for (const s of series.values()) s.items.sort((a, b) => a.t - b.t)
  return [...series.values()]
}

// instant evaluates node at T and returns [{labels, v}].
const instant = (node, T, streams, cache) => {
  if (node.type === 'range') {
    if (!cache.has(node)) cache.set(node, prepare(node, streams))
    const hi = T - node.offset
    const lo = hi - node.range
    if (node.fn === 'absent_over_time') {
      if (cache.get(node).some(s => window(s.items, lo, hi).length > 0)) return []
      const labels = {}
      for (const m of node.matchers) if (m.op === '=') labels[m.name] = m.value
      return [{ labels, v: 1 }]
    }
    const out = []
    for (const s of cache.get(node)) {
      const w = window(s.items, lo, hi)
      if (w.length) out.push({ labels: s.labels, v: reduce(node, w) })
    }
    return out
  }
  return aggregate(node.op, node.grouping, instant(node.expr, T, streams, cache))
}

// rangeGrid returns the Loki frontend grid: epoch k*step from floor(start)
// to ceil(end), inclusive.
const rangeGrid = (start, end, step) => {
  const ts = []
  for (let t = Math.floor(start / step) * step; t <= Math.ceil(end / step) * step; t += step) ts.push(t)
  return ts
}

/**
 * evaluate runs query over streams at the given evaluation times.
 * @param query {string}
 * @param streams {{labels: Object, entries: {t: number, line: string}[]}[]}
 * @param at {{start: number, end: number, step: number} | {time: number} | {times: number[]}}
 * @returns {{metric: Object, points: [number, number][]}[]} sorted by labels
 */
const evaluate = (query, streams, at) => {
  const ast = parse(query)
  const times = at.times || (at.time !== undefined ? [at.time] : rangeGrid(at.start, at.end, at.step))
  const cache = new Map()
  return toSeries(times, T => instant(ast, T, streams, cache), v => v === 0)
}

module.exports = { evaluate, parse, rangeGrid }
