import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

let definition
const state = ['main', 'credential-to-keep', 'tabbit-cn', undefined]
let hook = 0
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState(initial) { const index = hook++; if (!(index in state)) state[index] = initial; return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next }] },
  useRef: value => ({ current: value }), useEffect() {}, useMemo: fn => fn(), useCallback: fn => fn,
}
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8').replace('exports.apply = apply;', 'exports.forTest = { PoolPanel, accountResultText, RegionUsage, TabbitPluginCard, ContextBadge }; exports.apply = apply;')
runInNewContext(source, { window: { __ModuleLoader__: { load(value) { definition = value } } }, document: {}, console, URL, setTimeout, clearTimeout })
const api = definition.factory(specifier => { if (specifier === 'react') return react; throw new Error(specifier) })
const contextT = (key, values) => `${key}${values ? ' ' + values.size : ''}`
const officialBadge = api.forTest.ContextBadge({ t: contextT, model: { contextWindow: 1000000, contextSource: 'tabbit-description' } })
assert.equal(officialBadge.children[0], 'row.context 1M')
assert.equal(officialBadge.props.title, 'row.contextOfficialHint')
const fallbackBadge = api.forTest.ContextBadge({ t: contextT, model: { contextWindow: 100000, contextSource: 'fallback' } })
assert.equal(fallbackBadge.children[0], 'row.contextFallback 100K')
assert.equal(fallbackBadge.props.title, 'row.contextFallbackHint')
assert.equal(api.forTest.ContextBadge({ t: contextT, model: {} }), null)
console.log('PASS: context badges distinguish official capacity and conservative defaults')
let result
let imports = 0, local = 0, login = 0, cancel = 0
const props = { t: key => key, accounts: [], poolByAccount: new Map(), regions: [{ id: 'tabbit-cn', name: 'CN' }], login: { status: 'idle' }, onImport: async (name, value, region) => { assert.equal(region, 'tabbit-cn'); imports++; return result }, onImportLocal: () => { local++ }, onLogin: () => { login++ }, onCancelLogin: () => { cancel++ } }
const render = () => { hook = 0; return api.forTest.PoolPanel(props) }
const nodes = tree => [tree, ...tree.children.filter(child => child && typeof child === 'object').flatMap(nodes)]
const button = (tree, key) => nodes(tree).find(node => node.type === 'button' && node.children.includes(key))
let tree = render()
assert.ok(button(tree, 'pool.login'))
assert.ok(button(tree, 'pool.importLocal'))
assert.ok(nodes(tree).find(node => node.props.type === 'file' && node.props.accept.includes('.json')))
await button(tree, 'pool.import').props.onClick()
assert.equal(state[1], 'credential-to-keep', 'a failed import must preserve the pasted credential')
result = { ok: true }
await button(render(), 'pool.import').props.onClick()
assert.equal(state[1], '')
assert.equal(state[0], '')
assert.equal(imports, 2)
button(render(), 'pool.login').props.onClick()
button(render(), 'pool.importLocal').props.onClick()
assert.equal(login, 1)
assert.equal(local, 1)
props.login = { status: 'waiting' }
tree = render()
assert.equal(button(tree, 'pool.login').props.disabled, true)
button(tree, 'pool.loginCancel').props.onClick()
assert.equal(cancel, 1)
assert.ok(nodes(tree).some(node => node.props.role === 'status'))
console.log('PASS: login, local/file imports, cancellation, and failed-input preservation')
const embeddedTree = api.forTest.RegionUsage({ t: key => key, entry: { available: true, region: 'tabbit-cn', regionName: 'CN', gatewayMode: 'embedded', gatewayUrl: 'http://127.0.0.1:55555' } })
const embeddedText = nodes(embeddedTree).flatMap(node => node.children.filter(child => typeof child === 'string')).join('\n')
assert.match(embeddedText, /usage.embedded/)
assert.ok(!embeddedText.includes('55555'))
const quotaTree = api.forTest.RegionUsage({ t: key => key, entry: { available: true, region: 'tabbit-cn', regionName: 'CN', credits: [{ accountId: 'a', accountName: 'Account', status: 'ok', kind: 'quota', memberLevel: 'pro', used: 0, remaining: 100, cycleStart: '2026.10.19', cycleEnd: '2026.10.26', resetMinutes: 120 }] } })
const rendered = nodes(quotaTree).flatMap(node => node.children.filter(child => typeof child === 'string')).join('\n')
assert.match(rendered, /usage.used 0%/)
assert.match(rendered, /usage.remaining 100%/)
assert.match(rendered, /2026.10.19 – 2026.10.26/)
assert.match(rendered, /usage.billingHint/)
assert.equal(rendered.includes('usage.creditsUnsupported'), false)
console.log('PASS: quota uses percentages, preserves zero, shows cycle and billing limitations')

const usageTree = api.forTest.RegionUsage({ t: key => key, entry: { available: true, region: 'tabbit-cn', regionName: 'CN', gateway: {
  totalRequests: 1, totalTokens: 1, activeTokens: 1, successRate: 100, tokenUsage: {
    reported: { requests: 0, total_tokens: 0 }, estimated: { requests: 1, prompt_tokens: 1234, completion_tokens: 5, total_tokens: 1239 },
    inflight: 0, reconnects: 1, recent: [{ id: 'r1', at: '2026-10-21T01:00:00Z', model: 'best', attempt: 1, status: 'success',
      usage: { source: 'estimated', prompt_tokens: 1234, completion_tokens: 5, total_tokens: 1239 } }],
  },
} } })
assert.equal(nodes(usageTree).find(n => n.props.label === 'usage.inputTokens').props.value, '1,234')
assert.equal(nodes(usageTree).find(n => n.props.label === 'usage.outputTokens').props.value, '5')
const usageText = nodes(usageTree).flatMap(n => n.children.filter(c => typeof c === 'string')).join('\n')
assert.match(usageText, /usage.notReported/)
assert.match(usageText, /usage.estimatedTokens/)
assert.match(usageText, /usage.tokenHint/)
console.log('PASS: token panel distinguishes estimates, missing receipts and account counts')

state.length = 0
state[0] = true
state[1] = ['tabbit-cn', 'tabbit-global'].map(region => ({ region, id: 'best', name: 'Default' }))
state[2] = ['tabbit-cn', 'tabbit-global'].map(id => ({ id, name: id }))
state[9] = 'ready'
state[14] = state[2].map(r => ({ region: r.id, available: true }))
state[15] = 'ready'
for (let refresh = 0; refresh < 3; refresh++) {
  hook = 0
  const card = api.forTest.TabbitPluginCard({ t: key => key })
  for (const node of nodes(card)) {
    const keys = node.children.filter(n => n && typeof n === 'object' && n.props?.key !== undefined).map(n => n.props.key)
    assert.equal(new Set(keys).size, keys.length, `sibling identity collision after refresh ${refresh}: ${keys.join(',')}`)
  }
  assert.equal(nodes(card).filter(n => n.type === api.forTest.RegionUsage).length, 2)
  state[14] = state[14].map(row => ({ ...row }))
}
console.log('PASS: repeated usage refresh keeps unique sibling identities beside the model regions')
