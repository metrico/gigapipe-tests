const axios = require('axios')
const protobufjs = require('protobufjs')
const path = require('path')
const {_it, clokiWriteUrl, clokiExtUrl, testID, start, end, shard, extraHeaders, axiosGet} = require('./common')

const otlpHeaders = (contentType) => ({
    'Content-Type': contentType,
    'X-Scope-OrgID': '1',
    'X-Shard': shard,
    ...extraHeaders
})

// ms epoch -> ns epoch as a decimal string (string concat: ns values exceed
// Number.MAX_SAFE_INTEGER)
const ns = (ms) => ms.toString() + '000000'

// Poll get() every second until check(res) passes or ~30s elapse; writer-side
// inserts are batched so the first read attempts may come back empty.
const waitFor = async (get, check) => {
    let last
    for (let i = 0; i < 30; i++) {
        last = await get()
        if (check(last)) {
            return last
        }
        await new Promise(f => setTimeout(f, 1000))
    }
    return last
}

const strAttr = (key, value) => ({key: key, value: {stringValue: value}})

// service.name is unique per run: target_info carries no test_id data-point
// attribute, so its job label is the only thing scoping it to this run
const metricsSvcName = `otlp-e2e-${testID}`

// normalize a Loki query_range response for snapshotting: mask the run-unique
// test_id, rebase value timestamps onto the run's start, order streams
const adjustOtlpLogResult = (resp, id) => {
    resp.data.data.result = resp.data.data.result.map(stream => {
        expect(stream.stream.test_id).toEqual(id)
        stream.stream.test_id = 'TEST_ID'
        stream.values = stream.values.map(v => [v[0] - start * 1000000, ...v.slice(1)])
        return stream
    })
    resp.data.data.result.sort((a, b) => {
        const s1 = JSON.stringify(Object.entries(a.stream).sort())
        const s2 = JSON.stringify(Object.entries(b.stream).sort())
        return s1.localeCompare(s2)
    })
}

// normalize a Prometheus query_range response for snapshotting: mask the
// run-unique test_id and job labels, rebase timestamps, order series
const adjustPromResult = (resp) => {
    resp.data.data.result = resp.data.data.result.map(s => {
        if (s.metric.test_id) {
            expect(s.metric.test_id.substring(0, testID.length)).toEqual(testID)
            s.metric.test_id = 'TEST_ID'
        }
        if (s.metric.job) {
            expect(s.metric.job).toEqual(metricsSvcName)
            s.metric.job = 'JOB'
        }
        // the writer's service-name discovery copies the job label into a
        // service_name label on every series
        if (s.metric.service_name) {
            expect(s.metric.service_name).toEqual(metricsSvcName)
            s.metric.service_name = 'JOB'
        }
        s.values = s.values.map(v => [v[0] - Math.floor(start / 1000), ...v.slice(1)])
        return s
    })
    resp.data.data.result.sort((a, b) => {
        const s1 = JSON.stringify(Object.entries(a.metric).sort())
        const s2 = JSON.stringify(Object.entries(b.metric).sort())
        return s1.localeCompare(s2)
    })
}

const logsPayload = (id) => {
    const logRecords = []
    for (let t = start, i = 0; t < end; t += 15000, i++) {
        logRecords.push({
            timeUnixNano: ns(t),
            severityNumber: i % 2 ? 17 : 9,
            severityText: i % 2 ? 'ERROR' : 'INFO',
            body: {stringValue: `OTLP_LOG_${i}`},
            attributes: [strAttr('otlp.record.attr', 'record_val')]
        })
    }
    return {
        resourceLogs: [{
            resource: {attributes: [strAttr('service.name', 'otlp-e2e'), strAttr('test_id', id)]},
            scopeLogs: [{
                scope: {name: 'qryn-e2e'},
                logRecords: logRecords
            }]
        }]
    }
}

const sendOtlpLogs = async (id) => {
    const ExportLogsServiceRequest = protobufjs
        .loadSync(path.join(__dirname, './otlp.logs.proto'))
        .lookupType('ExportLogsServiceRequest')
    const message = ExportLogsServiceRequest.fromObject(logsPayload(id))
    const body = ExportLogsServiceRequest.encode(message).finish()
    const res = await axios.post(`http://${clokiWriteUrl}/v1/logs`, body, {
        headers: otlpHeaders('application/x-protobuf')
    })
    expect(res.status).toEqual(200)
}

const readOtlpLogs = async (id) => {
    const params = new URLSearchParams()
    params.append('query', `{test_id="${id}"}`)
    params.append('start', ns(start))
    params.append('end', ns(end))
    params.append('limit', '2000')
    params.append('direction', 'BACKWARD')
    // the two level batches flush independently (and may land on different
    // shards), so wait until every record of both levels is queryable
    const res = await waitFor(
        () => axiosGet(`http://${clokiExtUrl}/loki/api/v1/query_range?${params}`),
        r => {
            const got = r.data.data.result
            const lines = got.map(s => s.values.length).reduce((a, b) => a + b, 0)
            return lines >= 40 && new Set(got.map(s => s.stream.level)).size >= 2
        }
    )
    const streams = res.data.data.result
    expect(streams.length > 0).toBeTruthy()
    // severity_text is kept as the "level" stream label, one stream per level
    const levels = new Set(streams.map(s => s.stream.level))
    expect(levels.has('INFO')).toBeTruthy()
    expect(levels.has('ERROR')).toBeTruthy()
    const lines = streams.map(s => s.values.map(v => v[1])).reduce((a, b) => a.concat(b), [])
    expect(lines.filter(l => /^OTLP_LOG_\d+$/.test(l)).length > 0).toBeTruthy()
    adjustOtlpLogResult(res, id)
    expect(res.data).toMatchSnapshot()
}

_it('should send otlp logs', async () => {
    await sendOtlpLogs(`${testID}_OTLP`)
})

_it('should read otlp logs', async () => {
    await readOtlpLogs(`${testID}_OTLP`)
}, ['should send otlp logs'])

const metricsPayload = (id) => {
    const points = []
    for (let t = start; t < end; t += 15000) {
        points.push(t)
    }
    const attrs = [strAttr('test_id', id)]
    return {
        resourceMetrics: [{
            resource: {attributes: [
                strAttr('service.name', metricsSvcName),
                strAttr('service.instance.id', 'otlp-e2e-1'),
                // target_info is only emitted for resources carrying
                // attributes beyond the job/instance identity
                strAttr('deployment.environment', 'e2e')
            ]},
            scopeMetrics: [{
                scope: {name: 'qryn-e2e'},
                metrics: [
                    {
                        name: 'otlp_e2e_gauge',
                        gauge: {
                            dataPoints: points.map((t, i) => ({
                                attributes: attrs, timeUnixNano: ns(t), asDouble: i % 10
                            }))
                        }
                    },
                    {
                        name: 'otlp_e2e_requests',
                        sum: {
                            aggregationTemporality: 2,
                            isMonotonic: true,
                            dataPoints: points.map((t, i) => ({
                                attributes: attrs, startTimeUnixNano: ns(start), timeUnixNano: ns(t), asDouble: i
                            }))
                        }
                    },
                    {
                        name: 'otlp_e2e_duration',
                        histogram: {
                            aggregationTemporality: 2,
                            dataPoints: points.map((t, i) => ({
                                attributes: attrs,
                                startTimeUnixNano: ns(start),
                                timeUnixNano: ns(t),
                                count: (i * 3).toString(),
                                sum: i * 1.5,
                                bucketCounts: [i.toString(), i.toString(), i.toString()],
                                explicitBounds: [0.1, 1]
                            }))
                        }
                    }
                ]
            }]
        }]
    }
}

const promQueryRange = async (q) => {
    const params = new URLSearchParams()
    params.append('query', q)
    params.append('start', `${Math.floor(start / 1000)}`)
    params.append('end', `${Math.floor(end / 1000)}`)
    params.append('step', '15')
    return axiosGet(`http://${clokiExtUrl}/api/v1/query_range?${params}`)
}

_it('should send otlp metrics', async () => {
    const res = await axios.post(`http://${clokiWriteUrl}/v1/metrics`,
        JSON.stringify(metricsPayload(`${testID}_OTLP`)), {
            headers: otlpHeaders('application/json')
        })
    expect(res.status).toEqual(200)
    expect(res.data.partialSuccess).toBeUndefined()
})

_it('should read otlp metrics', async () => {
    const gauge = await waitFor(
        () => promQueryRange(`otlp_e2e_gauge{test_id="${testID}_OTLP"}`),
        r => r.data.data.result.length > 0 && r.data.data.result[0].values.length >= 40
    )
    expect(gauge.data.data.result.length).toEqual(1)
    expect(gauge.data.data.result[0].values.length > 0).toBeTruthy()
    // job / instance come from service.name / service.instance.id
    expect(gauge.data.data.result[0].metric.job).toEqual(metricsSvcName)
    expect(gauge.data.data.result[0].metric.instance).toEqual('otlp-e2e-1')
    adjustPromResult(gauge)
    expect(gauge.data).toMatchSnapshot()
}, ['should send otlp metrics'])

_it('should read otlp counter with _total suffix', async () => {
    const total = await waitFor(
        () => promQueryRange(`otlp_e2e_requests_total{test_id="${testID}_OTLP"}`),
        r => r.data.data.result.length > 0 && r.data.data.result[0].values.length >= 40
    )
    expect(total.data.data.result.length).toEqual(1)
    expect(total.data.data.result[0].values.length > 0).toBeTruthy()
    adjustPromResult(total)
    expect(total.data).toMatchSnapshot()
}, ['should send otlp metrics'])

_it('should read otlp histogram series', async () => {
    const buckets = await waitFor(
        () => promQueryRange(`otlp_e2e_duration_bucket{test_id="${testID}_OTLP"}`),
        r => r.data.data.result.length >= 3 && r.data.data.result.every(s => s.values.length >= 40)
    )
    // explicit bounds 0.1, 1 plus the implicit +Inf bucket
    expect(buckets.data.data.result.length).toEqual(3)
    expect(buckets.data.data.result.map(s => s.metric.le)).toContain('+Inf')
    const count = await waitFor(
        () => promQueryRange(`otlp_e2e_duration_count{test_id="${testID}_OTLP"}`),
        r => r.data.data.result.length > 0 && r.data.data.result[0].values.length >= 40
    )
    expect(count.data.data.result.length).toEqual(1)
    const sum = await waitFor(
        () => promQueryRange(`otlp_e2e_duration_sum{test_id="${testID}_OTLP"}`),
        r => r.data.data.result.length > 0
    )
    expect(sum.data.data.result.length).toEqual(1)
    adjustPromResult(buckets)
    expect(buckets.data).toMatchSnapshot()
    adjustPromResult(count)
    expect(count.data).toMatchSnapshot()
    adjustPromResult(sum)
    expect(sum.data).toMatchSnapshot()
}, ['should send otlp metrics'])

_it('should read otlp target_info', async () => {
    const ti = await waitFor(
        () => promQueryRange(`target_info{job="${metricsSvcName}"}`),
        r => r.data.data.result.length > 0 && r.data.data.result[0].values.length >= 40
    )
    expect(ti.data.data.result.length > 0).toBeTruthy()
    expect(ti.data.data.result[0].metric.deployment_environment).toEqual('e2e')
    adjustPromResult(ti)
    expect(ti.data).toMatchSnapshot()
}, ['should send otlp metrics'])

_it('should report partial success for delta otlp metrics', async () => {
    const payload = {
        resourceMetrics: [{
            resource: {attributes: []},
            scopeMetrics: [{
                metrics: [{
                    name: 'otlp_e2e_delta',
                    sum: {
                        aggregationTemporality: 1,
                        isMonotonic: true,
                        dataPoints: [{timeUnixNano: ns(end), asDouble: 1}]
                    }
                }]
            }]
        }]
    }
    const res = await axios.post(`http://${clokiWriteUrl}/v1/metrics`, JSON.stringify(payload), {
        headers: otlpHeaders('application/json')
    })
    // delta temporality is rejected via partial_success, never via an error code
    expect(res.status).toEqual(200)
    expect(res.data.partialSuccess.rejectedDataPoints).toEqual('1')
    expect(res.data.partialSuccess.errorMessage).toBeTruthy()
})

_it('should reject malformed otlp metrics', async () => {
    const garbage = await axios.post(`http://${clokiWriteUrl}/v1/metrics`, '{"resourceMetrics": [{', {
        headers: otlpHeaders('application/json'),
        validateStatus: () => true
    })
    expect(garbage.status).toEqual(400)
    expect(garbage.data.message).toBeTruthy()

    const badType = await axios.post(`http://${clokiWriteUrl}/v1/metrics`, 'not otlp', {
        headers: otlpHeaders('text/plain'),
        validateStatus: () => true
    })
    expect(badType.status).toEqual(400)
})
