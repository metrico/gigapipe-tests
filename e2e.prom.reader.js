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
