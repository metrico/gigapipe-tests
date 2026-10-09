// Seed data for the grid suites. Every timestamp is a whole number of
// milliseconds since the epoch; generators are pure functions of D0.

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// anchor returns D0 = floor(now - 3d, 1d), UTC.
const anchor = (nowMs) => Math.floor((nowMs - 3 * DAY) / DAY) * DAY

// ---------------------------------------------------------------- PromQL

const PROM = {
  spacing: 5 * MINUTE,
  span: 2 * DAY,
  // [from, to) after D0 with no samples in any series.
  gap: [20 * HOUR, 22 * HOUR],
  // Sample index at which every counter restarts from its own increment.
  resetAt: 360,
  // Phase families: same series, shifted past the 5m epoch grid. +7s puts a
  // sample inside (T, T+15s) of every 5m-aligned evaluation point.
  families: [
    { name: 'phase0', suffix: '', phase: 0, spacing: 5 * MINUTE, counter: true },
    { name: 'p20', suffix: '_p20', phase: 20 * SECOND, spacing: 5 * MINUTE, counter: true },
    { name: 'p7', suffix: '_p7', phase: 7 * SECOND, spacing: 5 * MINUTE, counter: true },
    { name: 'sparse', suffix: '_sparse', phase: 20 * SECOND, spacing: HOUR, counter: false }
  ],
  metrics: { gx: 'grid_x', gy: 'grid_y', gc: 'grid_c' }
}

const LS = ['a', 'b']

// Gauges: non-linear, non-periodic over the span, with negatives and zeros.
const gaugeX = (i, li) => ((i * 37 + li * 11) % 23) - 6 + (i % 5) * 0.25
const gaugeY = (i, li) => 100 + ((i * i * 7 + i * 3 + li * 5) % 41) * (li + 1) - (i % 3) * 7.5
// Counter increments are uneven and sometimes 0.
const counterInc = (i, li) => ((i * i * 13 + i * 5 + li * 3) % 17) + li * 0.5

const inGap = (offsetMs) => offsetMs >= PROM.gap[0] && offsetMs < PROM.gap[1]

/**
 * promSeries returns every seeded PromQL series:
 * [{labels: {__name__, l, ...base}, samples: [{t, v}]}], samples in time order.
 * @param d0 {number}
 * @param base {Object<string, string>} labels added to every series
 */
const promSeries = (d0, base) => {
  const out = []
  for (const f of PROM.families) {
    const n = Math.floor(PROM.span / f.spacing)
    const defs = [['gx', gaugeX], ['gy', gaugeY]]
    for (const [key, fn] of defs) {
      LS.forEach((l, li) => {
        const samples = []
        for (let i = 0; i < n; i++) {
          if (inGap(i * f.spacing)) continue
          samples.push({ t: d0 + i * f.spacing + f.phase, v: fn(i, li) })
        }
        out.push({ labels: { ...base, __name__: PROM.metrics[key] + f.suffix, l }, samples })
      })
    }
    if (!f.counter) continue
    LS.forEach((l, li) => {
      const samples = []
      let v = 0
      for (let i = 0; i < n; i++) {
        v = i === PROM.resetAt ? counterInc(i, li) : v + counterInc(i, li)
        if (inGap(i * f.spacing)) continue
        samples.push({ t: d0 + i * f.spacing + f.phase, v })
      }
      out.push({ labels: { ...base, __name__: PROM.metrics.gc + f.suffix, l }, samples })
    })
  }
  return out
}

// ---------------------------------------------------------------- LogQL

const LOGQL = {
  spanMinutes: 26 * 60,
  // a/1, a/2, b/1 are dense; a/1 also has a line on every 5m boundary;
  // c/1 is sparse (one line every 17m).
  streams: [{ l: 'a', pod: '1' }, { l: 'a', pod: '2' }, { l: 'b', pod: '1' }, { l: 'c', pod: '1' }]
}

const logMsg = (size, n) => {
  let s = `size=${size} `
  while (s.length < n) s += 'x'
  return s
}

/**
 * logStreams returns every seeded LogQL stream:
 * [{labels: {l, pod, ...base}, entries: [{t, line}]}], entries in time order.
 * Dense streams carry 0..6 lines a minute from +20s, with ms jitter and
 * varying lengths; each line starts with `size=N`.
 * @param d0 {number}
 * @param base {Object<string, string>}
 */
const logStreams = (d0, base) => {
  const per = LOGQL.streams.map(() => [])
  for (let m = 0; m < LOGQL.spanMinutes; m++) {
    const h = Math.floor(m / 60)
    for (let si = 0; si < 3; si++) {
      const n = ((m * m * 7 + m * 3 + si * 5) % 11) % 5 + (h + si) % 3
      for (let j = 0; j < n; j++) {
        const t = d0 + (m * 60 + 20 + 9 * j + 2 * si) * SECOND + (j * 137 + si * 11) % 1000
        const size = (m * 31 + j * 7 + si * 13) % 97 + 1
        per[si].push({ t, line: logMsg(size, 12 + (m * 13 + j * 5 + si * 17) % 41) })
      }
    }
    if (m % 5 === 0) {
      per[0].push({ t: d0 + m * MINUTE, line: logMsg(m % 50 + 3, 30 + m % 23) })
    }
    if (m % 17 === 3) {
      per[3].push({ t: d0 + m * MINUTE + 20 * SECOND + 250, line: logMsg(m % 40 + 2, 25) })
    }
  }
  return LOGQL.streams.map((s, si) => ({
    labels: { ...base, ...s },
    entries: per[si].sort((a, b) => a.t - b.t)
  }))
}

module.exports = {
  SECOND,
  MINUTE,
  HOUR,
  DAY,
  anchor,
  PROM,
  LOGQL,
  promSeries,
  logStreams
}
