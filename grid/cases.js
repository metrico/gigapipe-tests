// Expands grid/prom.cases.json and grid/logql.cases.json into runs. Offsets
// are seconds added to the fixture's base start (or instant time) and may
// carry milliseconds; every run time is in milliseconds.

const { PROM } = require('./seed')
const promCases = require('./prom.cases.json')
const logqlCases = require('./logql.cases.json')

const secs = (ms) => (ms / 1000).toFixed(3).replace(/\.?0+$/, '')

const promFamily = (name) => {
  const f = PROM.families.find(f => f.name === name)
  if (!f) throw new Error(`unknown prom family ${name}`)
  return f
}

/**
 * promRuns returns one run per case, family, step and offset:
 * {name, id, family, query, instant, step, offset, start, end, time}.
 * @param d0 {number}
 * @param testId {string} value of the test_id label on every seeded series
 */
const promRuns = (d0, testId) => {
  const runs = []
  for (const c of promCases.cases) {
    for (const famName of c.families || promCases.default_families) {
      const fam = promFamily(famName)
      let query = c.query
      for (const [key, metric] of Object.entries(PROM.metrics)) {
        if (!query.includes(`{${key}}`)) continue
        if (key === 'gc' && !fam.counter) throw new Error(`${c.id}: family ${famName} has no counter`)
        query = query.split(`{${key}}`).join(`${metric}${fam.suffix}{test_id="${testId}"}`)
      }
      const steps = c.instant ? ['instant'] : c.steps.map(String)
      for (const step of steps) {
        const offsets = (c.offsets && c.offsets[step]) || promCases.default_offsets[step]
        if (!offsets) throw new Error(`${c.id}: no offsets for step ${step}`)
        for (const offset of offsets) {
          const off = Math.round(offset * 1000)
          const at = d0 + promCases.instant_at_after_d0_s * 1000 + off
          const run = {
            name: `${c.id}/${famName} step=${step} offset=${offset}`,
            id: c.id,
            family: famName,
            query: query.split('{at}').join(secs(at)),
            instant: !!c.instant,
            offset
          }
          if (c.instant) {
            run.time = at
          } else {
            run.step = parseInt(step) * 1000
            run.start = d0 + promCases.range_start_after_d0_s * 1000 + off
            run.end = d0 + promCases.range_end_after_d0_s * 1000 + off
          }
          runs.push(run)
        }
      }
    }
  }
  return runs
}

/**
 * logqlRuns returns one run per case, path, range and shape. A path template
 * places the case's parser stages ahead of its line_format breakpoint.
 * Each run is {name, id, path, r, query, instant, step, offset, start, end, time, check}.
 * @param d0 {number}
 * @param testId {string}
 */
const logqlRuns = (d0, testId) => {
  const runs = []
  const selector = (key) => {
    const s = logqlCases.selectors[key]
    if (s === undefined) throw new Error(`unknown logql selector ${key}`)
    return s.split('{id}').join(testId)
  }
  for (const c of logqlCases.cases) {
    for (const path of c.paths || logqlCases.default_paths) {
      for (const r of c.ranges || logqlCases.default_ranges) {
        const query = c.query
          .replace(/\{log(?::(\w+))?\}/g, (_, key) => logqlCases.paths[path]
            .split('{sel}').join(selector(key || ''))
            .split('{stages}').join(c.stages || ''))
          .split('{r}').join(r)
        const base = { id: c.id, path, r, query, check: c.check || 'values' }
        for (const [step, offset] of logqlCases.ranges[r].shapes) {
          const off = offset * 1000
          runs.push({
            ...base,
            name: `${c.id}/${path} [${r}] step=${step} offset=${offset}`,
            instant: false,
            offset,
            step: step * 1000,
            start: d0 + logqlCases.range_start_after_d0_s * 1000 + off,
            end: d0 + logqlCases.range_end_after_d0_s * 1000 + off
          })
        }
        for (const offset of logqlCases.instant_offsets) {
          runs.push({
            ...base,
            name: `${c.id}/${path} [${r}] step=instant offset=${offset}`,
            instant: true,
            offset,
            time: d0 + logqlCases.instant_at_after_d0_s * 1000 + offset * 1000
          })
        }
      }
    }
  }
  return runs
}

// evalAt returns the oracle's evaluation times for a run.
const evalAt = (run) => run.instant ? { time: run.time } : { start: run.start, end: run.end, step: run.step }

module.exports = { promRuns, logqlRuns, evalAt, secs }
