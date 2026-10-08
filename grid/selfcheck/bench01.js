// The PromQL repro harness dataset and cases (gigapipe
// scripts/bench/grid-alignment): 7 days of 5m samples from a fixed D0, in a
// phase-0 family and a +20s family.

const D0 = Date.UTC(2026, 8, 28)
const N = 7 * 24 * 12
const SPACING = 300000
const FAMILIES = [['', 0], ['_p20', 20000]]
const DEFS = [
  ['gx', 'a', () => 1], ['gx', 'b', () => 1],
  ['gy', 'a', i => i], ['gy', 'b', i => 2 * i],
  ['gc', 'a', i => 10 * i], ['gc', 'b', i => 30 * i]
]

const series = () => {
  const out = []
  for (const [suffix, phase] of FAMILIES) {
    for (const [name, l, fn] of DEFS) {
      const samples = []
      for (let i = 0; i < N; i++) samples.push({ t: D0 + i * SPACING + phase, v: fn(i) })
      out.push({ labels: { __name__: name + suffix, l }, samples })
    }
  }
  return out
}

const RANGE_START = 172800
const RANGE_END = 259200
const INSTANT_AT = 302400
const OFFSETS = { 300: [0, 60, 240], 3600: [0, 60, 420, 1800], instant: [0, 60, 420, 1800] }

// [id, query, steps]; steps null marks an instant case.
const CASES = [
  ['bare_x', '{gx}', [300, 3600]],
  ['bare_y', '{gy}', [300, 3600]],
  ['avg_ot_1h_x', 'avg_over_time({gx}[1h])', [3600]],
  ['avg_ot_1h_y', 'avg_over_time({gy}[1h])', [3600]],
  ['max_ot_5m_x', 'max_over_time({gx}[5m])', [3600]],
  ['max_ot_5m_y', 'max_over_time({gy}[5m])', [3600]],
  ['rate_5m', 'rate({gc}[5m])', [300, 3600]],
  ['increase_5m', 'increase({gc}[5m])', [300, 3600]],
  ['rate_15m', 'rate({gc}[15m])', [300, 3600]],
  ['increase_15m', 'increase({gc}[15m])', [300, 3600]],
  ['rate_1h', 'rate({gc}[1h])', [3600]],
  ['irate_15m', 'irate({gc}[15m])', [300, 3600]],
  ['deriv_15m_y', 'deriv({gy}[15m])', [300, 3600]],
  ['absent_ot_5m_x', 'absent_over_time({gx}[5m])', [3600]],
  ['sum_by_x', 'sum by (l) ({gx})', [300, 3600]],
  ['sum_by_y', 'sum by (l) ({gy})', [300, 3600]],
  ['sum_rate', 'sum(rate({gc}[5m]))', [300, 3600]],
  ['sum_rate_15m', 'sum(rate({gc}[15m]))', [300, 3600]],
  ['offset_7m_y', '{gy} offset 7m', [300, 3600]],
  ['at_y', '{gy} @ {at}', [3600]],
  ['subq_max_y', 'max_over_time({gy}[1h:5m])', [3600]],
  ['subq_max_x', 'max_over_time({gx}[1h:5m])', [3600]],
  ['i_bare_x', '{gx}', null],
  ['i_bare_y', '{gy}', null],
  ['i_avg_ot_1h_y', 'avg_over_time({gy}[1h])', null],
  ['i_max_ot_5m_y', 'max_over_time({gy}[5m])', null],
  ['i_rate_5m', 'rate({gc}[5m])', null],
  ['i_increase_5m', 'increase({gc}[5m])', null],
  ['i_rate_15m', 'rate({gc}[15m])', null],
  ['i_increase_15m', 'increase({gc}[15m])', null],
  ['i_irate_15m', 'irate({gc}[15m])', null],
  ['i_deriv_15m_y', 'deriv({gy}[15m])', null],
  ['i_sum_by_y', 'sum by (l) ({gy})', null],
  ['i_sum_rate', 'sum(rate({gc}[5m]))', null],
  ['i_sum_rate_15m', 'sum(rate({gc}[15m]))', null],
  ['i_offset_7m_y', '{gy} offset 7m', null],
  ['i_subq_max_y', 'max_over_time({gy}[1h:5m])', null]
]

// runs mirrors the harness sweep: same names, windows and offsets.
const runs = () => {
  const out = []
  for (const [suffix] of FAMILIES) {
    const family = suffix ? suffix.slice(1) : 'phase0'
    for (const [id, tmpl, steps] of CASES) {
      const query = tmpl.replace(/\{(gx|gy|gc)\}/g, (_, m) => m + suffix)
      for (const step of steps || ['instant']) {
        for (const offset of OFFSETS[step]) {
          const at = (D0 / 1000 + INSTANT_AT + offset)
          const run = {
            name: `${id}/${family} step=${step} offset=${offset}`,
            id,
            family,
            offset,
            query: query.replace('{at}', String(at)),
            instant: !steps
          }
          if (steps) {
            run.step = step * 1000
            run.start = D0 + (RANGE_START + offset) * 1000
            run.end = D0 + (RANGE_END + offset) * 1000
          } else {
            run.time = at * 1000
          }
          out.push(run)
        }
      }
    }
  }
  return out
}

module.exports = { D0, series, runs }
