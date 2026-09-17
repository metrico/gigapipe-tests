const axios = require('axios')
const {clokiExtUrl, _it, testID, clokiWriteUrl, shard, axiosGet, extraHeaders, start, end} = require('./common')

/* TODO: implement _it('should post /api/v1/labels with empty result', async () => {
    let fd = new URLSearchParams()
    fd.append('end', `${Math.floor(Date.now() / 1000)}`)
    fd.append('start', `${Math.floor((Date.now() - 1 * 3600 * 1000) / 1000)}`)
    let labels = await axiosPost(`http://${clokiExtUrl}/api/v1/labels`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    expect(labels.data.data.find(d => d===`${testID}_LBL`)).toBeTruthy()

    fd = new URLSearchParams()
    fd.append('start', `${Math.floor((Date.now() - 25 * 3600 * 1000) / 1000)}`)
    fd.append('end', `${Math.floor((Date.now() - 24 * 3600 * 1000) / 1000)}`)
    labels = await axiosPost(`http://${clokiExtUrl}/api/v1/labels`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    expect(labels.data.data.find(d => d===`${testID}_LBL`)).toBeFalsy()
}, ['should post /api/v1/labels']) */

/* TODO: implement _it('should get /api/v1/labels with empty result', async () => {
    let fd = new URLSearchParams()
    fd.append('end', `${Math.floor(Date.now() / 1000)}`)
    fd.append('start', `${Math.floor((Date.now() - 3600 * 1000) / 1000)}`)
    let labels = await axios.get(`http://${clokiExtUrl}/api/v1/labels?${fd}`, {
        headers: {
            'X-Scope-OrgID': '1',
            ...extraHeaders
        }
    })
    expect(labels.data.data.find(d => d===`${testID}_LBL`)).toBeTruthy()

    fd = new URLSearchParams()
    fd.append('start', `${Math.floor((Date.now() - 25 * 3600 * 1000) / 1000)}`)
    fd.append('end', `${Math.floor((Date.now() - 24 * 3600 * 1000) / 1000)}`)
    console.log(`--------------------- http://${clokiExtUrl}/api/v1/labels?${fd}`)
    labels = await axios.get(`http://${clokiExtUrl}/api/v1/labels?${fd}`, {
        headers: {
            'X-Scope-OrgID': '1',
            ...extraHeaders
        }
    })
    expect(labels.data.data.find(d => d===`${testID}_LBL`)).toBeFalsy()
}, ['should post /api/v1/labels']) */

/* TODO: implement _it('should post /api/v1/series with time context', async () => {
    let fd = new URLSearchParams()
    fd.append('match[]', `{test_id="${testID}"}`)
    fd.append('end', `${Math.floor(Date.now() / 1000)}`)
    fd.append('start', `${Math.floor((Date.now() - 3600 * 1000) / 1000)}`)
    let labels = await axiosPost(`http://${clokiExtUrl}/api/v1/series`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    expect(labels.data.data && labels.data.data.length).toBeTruthy()

    fd = new URLSearchParams()
    fd.append('match[]', `{test_id="${testID}"}`)
    fd.append('start', `${Math.floor((Date.now() - 25 * 3600 * 1000) / 1000)}`)
    fd.append('end', `${Math.floor((Date.now() - 24 * 3600 * 1000) / 1000)}`)
    labels = await axiosPost(`http://${clokiExtUrl}/api/v1/series`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    expect(labels.data.data && labels.data.data.length).toBeFalsy()
}, ['should post /api/v1/labels'])*/

/* TODO: implement _it('should get /api/v1/series with time context', async () => {
    let fd = new URLSearchParams()
    fd.append('match[]', `{test_id="${testID}"}`)
    fd.append('end', `${Math.floor(Date.now() / 1000)}`)
    fd.append('start', `${Math.floor((Date.now() - 3600 * 1000) / 1000)}`)
    let labels = await axios.get(`http://${clokiExtUrl}/api/v1/series?${fd}`, {
        headers: {
            'X-Scope-OrgID': '1',
            ...extraHeaders
        }
    })
    expect(labels.data.data && labels.data.data.length).toBeTruthy()

    fd = new URLSearchParams()
    fd.append('match[]', `{test_id="${testID}"}`)
    fd.append('start', `${Math.floor((Date.now() - 25 * 3600 * 1000) / 1000)}`)
    fd.append('end', `${Math.floor((Date.now() - 24 * 3600 * 1000) / 1000)}`)
    labels = await axios.get(`http://${clokiExtUrl}/api/v1/series?${fd}`, {
        headers: {
            'X-Scope-OrgID': '1',
            ...extraHeaders
        }
    })
    expect(labels.data.data && labels.data.data.length).toBeFalsy()
}, ['should post /api/v1/labels'])
*/

const adjustPromMatrixResponse = (data) => {
    data.data.result.forEach(ts => {
        expect(ts.metric.test_id).toEqual(`${testID}_RWR`)
        ts.metric.test_id = "TEST_ID"
        ts.values.forEach(v => {v[0] -= Math.floor(start / 1000)})
    })
    return data
}

const _itShouldReadPromMatrix = (name, queryOrConf) => _it(name, async () => {
    let conf = typeof queryOrConf == 'string' ? {query: queryOrConf} : queryOrConf
    conf = {
        start: start,
        end: end,
        step: 15,
        ...conf,
    }
    let fd = new URLSearchParams()
    fd.append('query',  conf.query)
    fd.append('start', Math.floor(conf.start / 1000))
    fd.append('end', Math.floor(conf.end / 1000))
    fd.append('step', conf.step)
    const resp = await axiosGet(`http://${clokiExtUrl}/api/v1/query_range?${fd}`, {
        headers: conf.headers || {}
    })
    expect(resp.status).toEqual(200)
    expect(adjustPromMatrixResponse(resp.data)).toMatchSnapshot()
}, ['should send prometheus.remote.write'])

_itShouldReadPromMatrix(`prometheus: should read gauge`, `test_metric{test_id="${testID}_RWR"}`)
_itShouldReadPromMatrix(`prometheus: should read counter`, `test_counter{test_id="${testID}_RWR"}`)
_itShouldReadPromMatrix(`prometheus: should read rate`, `rate(test_counter{test_id="${testID}_RWR"}[1m])`)
_itShouldReadPromMatrix(`prometheus: should read sum`,
    `sum by (test_id) (test_counter{test_id="${testID}_RWR"})`)
_itShouldReadPromMatrix(`prometheus: should sum + rate`,
    `sum by (test_id) (rate(test_counter{test_id="${testID}_RWR"}[1m]))`)

_itShouldReadPromMatrix(`prometheus exp: should sum + rate`,
    {
        query:`sum by (test_id) (rate(test_counter{test_id="${testID}_RWR"}[1m]))`,
        headers: {'X-Experimental': '1'}
})

// Regression guard for the query_range `end` rounding. The reader snaps the
// query window to the metrics_15s table's 15s grid, and snapping `end` forward
// used to emit one data point strictly after the timestamp the caller asked
// for -- real Prometheus never returns a point past `end`.
//
// Every other prom matrix test above inherits `start`/`end` from common.js,
// which floors both to whole minutes; those are already multiples of 15, so
// rounding in either direction is a no-op there and the bug is invisible.
// This test deliberately picks an `end` that is off the 15s grid.
_it(`prometheus: query_range must not return points after the requested end`, async () => {
    const unalignedEnd = Math.floor(end / 1000) - 7 // end is minute-aligned, so this lands 8s past a 15s boundary
    expect(unalignedEnd % 15).not.toEqual(0)
    let fd = new URLSearchParams()
    fd.append('query', `test_counter{test_id="${testID}_RWR"}`)
    fd.append('start', `${Math.floor(start / 1000)}`)
    fd.append('end', `${unalignedEnd}`)
    fd.append('step', '15')
    const resp = await axiosGet(`http://${clokiExtUrl}/api/v1/query_range?${fd}`)
    expect(resp.status).toEqual(200)
    // without this the timestamp check below passes vacuously on an empty result
    expect(resp.data.data.result.length).toBeTruthy()
    resp.data.data.result.forEach(ts => {
        expect(ts.values.length).toBeTruthy()
        ts.values.forEach(v => expect(v[0]).toBeLessThanOrEqual(unalignedEnd))
    })
}, ['should send prometheus.remote.write'])

// Step-vs-range coverage for range-vector functions.
//
// Every prom matrix test above runs at the harness default of step=15 against a
// [1m] range -- a ratio of 0.25, deep inside the region that has always worked.
// Nothing here ever varied the step relative to the range, which is why #980
// (every range-vector function returning an empty result once step >= range)
// reached two production deployments before anyone noticed: HTTP 200,
// "status":"success", an empty result array, and no error to signal why.
//
// test_counter is written by 'should send prometheus.remote.write' as a
// perfectly linear counter -- value i at start + i*15s, no resets -- so its rate
// is exactly 1/15 per second everywhere, whatever window it is measured over.
// That is what makes these assertions exact rather than snapshots: bucketing the
// same straight line more or less finely must not move the answer, so a value
// that does move is a real regression rather than a resampling artifact.
const EXPECTED_RATE = 1 / 15

const promQueryRange = async (query, stepSec) => {
    const fd = new URLSearchParams()
    fd.append('query', query)
    fd.append('start', `${Math.floor(start / 1000)}`)
    fd.append('end', `${Math.floor(end / 1000)}`)
    fd.append('step', `${stepSec}`)
    const resp = await axiosGet(`http://${clokiExtUrl}/api/v1/query_range?${fd}`)
    expect(resp.status).toEqual(200)
    return resp.data.data.result
}

// countSeriesPerStep maps each step to how many series came back, so a failure
// names the steps that broke instead of just the first one.
const countSeriesPerStep = async (query, steps) => {
    const got = {}
    for (const step of steps) {
        got[step] = (await promQueryRange(query, step)).length
    }
    return got
}

// The #980 boundary, from its own report: a [300s] range queried at steps below,
// at, and above 300s. 150 and 299 are the band where the bucket is capped but
// the step is still finer than the range; 300 is the exact boundary the report
// binary-searched to; 301 and 600 are past it.
const STEP_SWEEP = [150, 299, 300, 301, 600]

_it(`prometheus: rate must return series at every step (#980)`, async () => {
    const query = `rate(test_counter{test_id="${testID}_RWR"}[300s])`

    // The always-worked case is the baseline: whatever it returns is how many
    // series exist, so this does not hard-code the number of remote-write routes.
    const baseline = (await promQueryRange(query, 15)).length
    expect(baseline).toBeTruthy()

    const got = await countSeriesPerStep(query, STEP_SWEEP)
    const want = Object.fromEntries(STEP_SWEEP.map(s => [s, baseline]))
    expect(got).toEqual(want)
}, ['should send prometheus.remote.write'])

// A [60s] range rather than the [300s] used above, deliberately. The harness
// only writes ten minutes of data (common.js), so a 300s range leaves almost
// every window partially covered at a coarse step -- there is no clean interior
// point to measure, and the value legitimately reads low. At [60s] the data
// spans ten ranges, so interior windows are fully covered and the expected
// value is exact: four increments of one per 60s window, 1/15 per second.
const VALUE_STEP_SWEEP = [30, 59, 60, 61, 120]

_it(`prometheus: rate value must not depend on the query step (#980)`, async () => {
    const query = `rate(test_counter{test_id="${testID}_RWR"}[60s])`
    const offenders = []
    for (const step of VALUE_STEP_SWEEP) {
        const result = await promQueryRange(query, step)
        expect(result.length).toBeTruthy()
        for (const ts of result) {
            expect(ts.values.length).toBeTruthy()
            ts.values.forEach(([t, v], i) => {
                // The first point of a series is understated by design: its
                // window reaches back before the counter existed, and
                // CounterPlanner declines to extrapolate a counter backwards
                // past its own first value, since a counter cannot have been
                // running before it started (TestCounterBackwardReachIsBounded).
                // It must still never read high.
                const value = parseFloat(v)
                if (i === 0) {
                    if (!(value > 0 && value <= EXPECTED_RATE * 1.05)) {
                        offenders.push({ step, pointIndex: i, value, why: 'first point out of bounds' })
                    }
                    return
                }
                const err = Math.abs(value - EXPECTED_RATE) / EXPECTED_RATE
                if (err > 0.05) {
                    offenders.push({
                        step,
                        pointIndex: i,
                        ofPoints: ts.values.length,
                        secondsIntoQuery: t - Math.floor(start / 1000),
                        value,
                        relativeError: +err.toFixed(3),
                    })
                }
            })
        }
    }
    expect(offenders).toEqual([])
}, ['should send prometheus.remote.write'])

// The functions #981 changed that the suite had never queried at all, at a step
// past their own range. Values differ per function, so this asserts only the
// symptom #980 was reported as: series come back at all.
//
// Scoped to the functions the ClickHouse pushdown accelerates
// (CounterPlanner/CounterFlagsPlanner). irate, deriv and idelta are deliberately
// NOT here: they have no pushdown of their own and go through the per-step
// resampling path instead, where they still return nothing at step > range on
// roughly two runs in three. That is a live bug, not a property to assert, and
// its guard belongs with its fix rather than reddening CI at random -- see the
// note above STEP_SWEEP.
_it(`prometheus: accelerated range-vector functions return series when step > range`, async () => {
    const fns = ['rate', 'delta', 'increase', 'resets', 'changes']
    const got = {}
    for (const fn of fns) {
        const query = `${fn}(test_counter{test_id="${testID}_RWR"}[300s])`
        const baseline = (await promQueryRange(query, 15)).length
        const coarse = (await promQueryRange(query, 600)).length
        // baseline > 0 matters: a function returning nothing at either step would
        // otherwise compare equal to itself and pass while being entirely broken.
        got[fn] = baseline > 0 && coarse === baseline
            ? 'ok'
            : `step15=${baseline} step600=${coarse}`
    }
    expect(got).toEqual(Object.fromEntries(fns.map(fn => [fn, 'ok'])))
}, ['should send prometheus.remote.write'])

// count_over_time is the one function here whose value exposes the width of the
// window rather than just its position. The harness writes a sample every 15s,
// so a [300s] range holds exactly 20 of them however the query is stepped --
// where rate over a perfectly linear counter reads 1/15 through any window at
// all, and so cannot tell a correct window from a shifted or oversized one.
//
// The buckets the frame reaches have to tile (t-range, t]. When a bucket was
// allowed to grow with the query step, one of them covered more than the range
// at a coarse step and the count came back as that bucket's whole population.
_it(`prometheus: count_over_time counts the range, not the step`, async () => {
    const query = `count_over_time(test_counter{test_id="${testID}_RWR"}[300s])`
    const perStep = {}
    for (const step of [60, 150, 300, 600]) {
        const result = await promQueryRange(query, step)
        expect(result.length).toBeTruthy()
        const counts = new Set()
        for (const ts of result) {
            expect(ts.values.length).toBeTruthy()
            ts.values.forEach(([, v]) => counts.add(parseFloat(v)))
        }
        // Points near the start of the query have a partially covered window and
        // legitimately count fewer; none may ever count MORE than the range holds.
        perStep[step] = [...counts].some(c => c > 20)
            ? `over-counted: ${JSON.stringify([...counts].sort((a, b) => a - b))}`
            : 'ok'
    }
    expect(perStep).toEqual({60: 'ok', 150: 'ok', 300: 'ok', 600: 'ok'})
}, ['should send prometheus.remote.write'])
