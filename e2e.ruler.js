const {_it, clokiExtUrl, axiosGet, axiosPost, axiosDelete, rulerEnabled} = require("./common");
const yaml = require('yaml')

// CRUD coverage for the recording-rules ruler API. The ruler is mounted by
// default; QRYN_RULER_ENABLED=0|false|no|off disables it on the server, and
// every endpoint then answers 404. The tests gate themselves on the matching
// client-side flag so the suite is a no-op in a ruler-less deployment.
const ok = () => true

// In a clustered deployment the ruler reads and writes the rules_dist
// Distributed table, whose inserts propagate to the shards asynchronously.
// A read issued right after a write may therefore not see it yet, so reads
// that follow a write poll until the expected state settles.
const waitFor = async (fetch, predicate, {timeoutMs = 30000, intervalMs = 500} = {}) => {
    const deadline = Date.now() + timeoutMs
    let res = await fetch()
    while (!predicate(res) && Date.now() < deadline) {
        await new Promise(f => setTimeout(f, intervalMs))
        res = await fetch()
    }
    return res
}

const hasNamespace = (ns, expected) => (res) =>
    res.status === 200 && JSON.stringify(yaml.parse(res.data)[ns]) === JSON.stringify(expected)

// promRule locates one rule of a group inside a Prometheus-format response.
// The group is keyed by name and by file, which the ruler sets to the namespace.
const promRule = (res, namespace, group) => {
    if (res.status !== 200 || res.data.status !== 'success') return undefined
    const g = (res.data.data.groups || [])
        .find(g => g.name === group.name && g.file === namespace)
    return g && g.rules.find(r => r.name === group.rules[0].record)
}

// registerCrud wires the full create/read/delete lifecycle for one rule set.
// The rule sets share the same controller semantics and differ only in path
// prefix, expression language and the read endpoint that renders rules in
// Prometheus wire format.
// allRulesYaml marks rule sets whose bare GET {base} returns every group as
// YAML (the Loki AllRules endpoint). The Prometheus rule set has no such view:
// its bare GET {base} is the Prometheus-format read endpoint instead.
const registerCrud = ({label, base, promBase, namespace, group, allRulesYaml}) => {
    const url = (suffix = '') => `http://${clokiExtUrl}${base}${suffix}`

    _it(`ruler ${label}: should create a rule group`, async () => {
        if (!rulerEnabled()) return
        const res = await axiosPost(url(`/${namespace}`), yaml.stringify(group), {
            headers: {'Content-Type': 'application/yaml'},
            validateStatus: ok
        })
        expect(res.status).toEqual(202)
        expect(res.data).toHaveProperty('status', 'success')
    })

    _it(`ruler ${label}: should read the rule group`, async () => {
        if (!rulerEnabled()) return
        const res = await waitFor(
            () => axiosGet(url(`/${namespace}/${group.name}`), {validateStatus: ok}),
            (r) => r.status === 200)
        expect(res.status).toEqual(200)
        expect(yaml.parse(res.data)).toEqual(group)
    }, [`ruler ${label}: should create a rule group`])

    _it(`ruler ${label}: should list groups in the namespace`, async () => {
        if (!rulerEnabled()) return
        const res = await waitFor(
            () => axiosGet(url(`/${namespace}`), {validateStatus: ok}),
            hasNamespace(namespace, [group]))
        expect(res.status).toEqual(200)
        expect(yaml.parse(res.data)).toHaveProperty(namespace, [group])
    }, [`ruler ${label}: should create a rule group`])

    if (allRulesYaml) {
        _it(`ruler ${label}: should list all groups`, async () => {
            if (!rulerEnabled()) return
            const res = await waitFor(
                () => axiosGet(url(), {validateStatus: ok}),
                hasNamespace(namespace, [group]))
            expect(res.status).toEqual(200)
            expect(yaml.parse(res.data)).toHaveProperty(namespace, [group])
        }, [`ruler ${label}: should create a rule group`])
    }

    _it(`ruler ${label}: should expose rules in prometheus format`, async () => {
        if (!rulerEnabled()) return
        const res = await waitFor(
            () => axiosGet(`http://${clokiExtUrl}${promBase}`, {validateStatus: ok}),
            (r) => promRule(r, namespace, group))
        expect(res.status).toEqual(200)
        expect(res.data).toHaveProperty('status', 'success')
        expect(promRule(res, namespace, group)).toMatchObject({
            type: 'recording',
            query: group.rules[0].expr,
            labels: group.rules[0].labels
        })
    }, [`ruler ${label}: should create a rule group`])

    const readDeps = [
        `ruler ${label}: should read the rule group`,
        `ruler ${label}: should list groups in the namespace`,
        `ruler ${label}: should expose rules in prometheus format`
    ]
    if (allRulesYaml) {
        readDeps.push(`ruler ${label}: should list all groups`)
    }

    _it(`ruler ${label}: should delete the rule group`, async () => {
        if (!rulerEnabled()) return
        const res = await axiosDelete(url(`/${namespace}/${group.name}`), {validateStatus: ok})
        expect(res.status).toEqual(202)
        expect(res.data).toHaveProperty('status', 'success')

        // The group is gone once the tombstone propagates.
        const after = await waitFor(
            () => axiosGet(url(`/${namespace}/${group.name}`), {validateStatus: ok}),
            (r) => r.status === 404)
        expect(after.status).toEqual(404)
    }, readDeps)

    _it(`ruler ${label}: should delete the namespace`, async () => {
        if (!rulerEnabled()) return
        const res = await axiosDelete(url(`/${namespace}`), {validateStatus: ok})
        expect(res.status).toEqual(202)
        const after = await waitFor(
            () => axiosGet(url(`/${namespace}`), {validateStatus: ok}),
            (r) => r.status === 404)
        expect(after.status).toEqual(404)
    }, [`ruler ${label}: should delete the rule group`])
}

const lokiGroup = (name) => ({
    name,
    interval: '10s',
    rules: [{
        record: 'job:log_lines:rate1m',
        expr: 'sum(rate({job="test"}[1m]))',
        labels: {e2e: 'true'}
    }]
})

// Loki rule set — LogQL recording rules, served under /loki/api/v1/rules.
// Its Prometheus-format view is the /prometheus/api/v1/rules debug endpoint.
registerCrud({
    label: 'loki',
    base: '/loki/api/v1/rules',
    promBase: '/prometheus/api/v1/rules',
    allRulesYaml: true,
    namespace: 'ruler_e2e_loki',
    group: lokiGroup('loki_recording_group')
})

// /api/prom/rules is Loki's own Prometheus-compatible ruler API, backed by the
// same store as /loki/api/v1/rules and used interchangeably by Grafana's Loki
// datasource. A separate namespace keeps it independent of the set above.
registerCrud({
    label: 'loki-compat',
    base: '/api/prom/rules',
    promBase: '/prometheus/api/v1/rules',
    allRulesYaml: true,
    namespace: 'ruler_e2e_loki_compat',
    group: lokiGroup('loki_compat_recording_group')
})

// Prometheus rule set — PromQL recording rules, served under /api/v1/rules.
// The bare GET /api/v1/rules is itself the Prometheus-format read endpoint.
registerCrud({
    label: 'prom',
    base: '/api/v1/rules',
    promBase: '/api/v1/rules',
    allRulesYaml: false,
    namespace: 'ruler_e2e_prom',
    group: {
        name: 'prom_recording_group',
        interval: '10s',
        rules: [{
            record: 'job:demo_metric:sum',
            expr: 'sum(demo_metric)',
            labels: {e2e: 'true'}
        }]
    }
})
