/**
 * Smoke test: a fake tabbit2api + the real plugin modules.
 *
 * Verifies the parts that can be verified without a Tabbit account:
 *   - config schema resolves with defaults
 *   - gateway client speaks the admin + proxy surfaces
 *   - shim enforces loopback + bearer, filters /v1/models, streams through
 *   - tabbit helpers parse pool entries and summarize unknown payloads
 *   - adapter maps a gateway model onto a pi-ai descriptor
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures++
    console.log(`  FAIL ${label}: ${error.message}`)
  }
}
const checkAsync = async (label, fn) => {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures++
    console.log(`  FAIL ${label}: ${error.message}`)
  }
}

// ---------------------------------------------------------------- fake gateway
const MODELS = [
  { id: 'best', object: 'model', name: '最佳', max_tokens: 100000, supports_vision: false, access_type: 'free_unlimited' },
  { id: 'kimi-k3', object: 'model', name: 'Kimi-K3', max_tokens: 1000000, supports_vision: false, access_type: 'premium_only' },
  { id: 'longcat-flash-thinking', object: 'model', name: 'LongCat-Flash-Thinking', max_tokens: 131072, supports_vision: true, access_type: 'free_metered' },
]

const seen = { completions: 0, adminAuth: [] }

const fake = createServer((req, res) => {
  const url = req.url ?? '/'
  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"status":"ok"}')
    return
  }
  if (url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: MODELS }))
    return
  }
  if (url === '/api/admin/login') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ token: 'fake.jwt.token' }))
    return
  }
  if (url.startsWith('/api/admin/')) {
    seen.adminAuth.push(req.headers.authorization)
    if (req.headers.authorization !== 'Bearer fake.jwt.token') {
      res.writeHead(401)
      res.end('{"detail":"unauthorized"}')
      return
    }
    if (url === '/api/admin/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ total_requests: 10, total_success: 9, total_errors: 1, success_rate: 90, total_tokens: 2, active_tokens: 1 }))
      return
    }
    if (url === '/api/admin/tokens' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ tokens: [{ id: 't1', name: '主账号', enabled: true, status: 'active', value_preview: 'eyJhbGci…' }] }))
      return
    }
    if (url === '/api/admin/tokens' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 't2' }))
      })
      return
    }
    if (url === '/api/admin/tokens/t1/test') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, session_id: 's1' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
    return
  }
  if (url === '/v1/chat/completions') {
    seen.completions++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"index":0,"delta":{"content":"你"}}]}\n\n')
    res.write('data: {"choices":[{"index":0,"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  res.writeHead(404)
  res.end('nope')
})

await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
const gatewayUrl = `http://127.0.0.1:${fake.address().port}`

// ---------------------------------------------------------------- modules
const { Config, name: pluginName, inject, catalogAccepts } = await import('../lib/index.js')
const { GatewayClient, REGIONS } = await import('../lib/gateway.js')
const { createTabbitShim } = await import('../lib/shim.js')
const { toPiModel, filterByEnabled, infersReasoning } = await import('../lib/adapter.js')
const { parseTokenValue, userIdOf, summarizeCredits, collectNumbers, summarizeCheckinStatus } = await import('../lib/tabbit.js')
const { AccountStore, syncToGateway, targetsOf } = await import('../lib/accounts.js')

const region = REGIONS[0]

console.log('\n[1] config schema')
// The loader entry id must be the package name: on DSH 0.1.7+ the settings
// service keys a form by the Loader entry id, so the id the profile patch picks
// is the namespace the browser half has to find the Host's section under.
check('plugin exports a loader id equal to the package name', () =>
  assert.equal(pluginName, 'dsh-connect-tabbit'))
check('plugin injects llm', () => assert.deepEqual(inject, ['llm']))
/**
 * Resolve a possibly-volatile resolved field.
 *
 * From schemastery 3.18.3 a field marked volatile resolves to a live `{ get() }`
 * reference instead of a plain value, so that the loader can hot-update it after
 * a settings save. Tests read through that one level.
 */
const plain = (value) =>
  value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value

check('config resolves with defaults', () => {
  const resolved = new Config({})
  assert.equal(resolved.cn.enabled, true)
  assert.equal(resolved.cn.adminPassword, 'admin')
  assert.equal(resolved.cn.gatewayMode, 'auto')
  assert.equal(resolved.global.enabled, true)
  assert.deepEqual(plain(resolved.enabledModelIds), {})
  assert.ok(Array.isArray(plain(resolved.creditsPaths)) && plain(resolved.creditsPaths).length > 0)
})
check('settings-managed fields are volatile', () => {
  // This is the whole reason the settings card had no settings scope: the
  // service publishes a form only for a schema that carries `meta.volatile`
  // somewhere, so an all-ordinary Config yields no namespace, no error, and a
  // permanently read-only card.
  for (const field of [
    'enabledModelIds',
    'imageOverrides',
    'reasoningOverrides',
    'creditsPaths',
    'checkinStatusPaths',
    'checkinClaimPaths',
  ]) {
    assert.equal(Config.dict?.[field]?.meta?.volatile, true, `${field} must be volatile`)
  }
})
check('connection fields stay ordinary', () => {
  // Gateway address and admin password are edited through the card's own routes;
  // marking them volatile would also make them hot-swappable mid-flight, which
  // the shim is not built for.
  for (const field of ['cn', 'global']) {
    assert.notEqual(Config.dict?.[field]?.meta?.volatile, true, `${field} must stay ordinary`)
  }
})
check('config keeps explicit values', () => {
  const resolved = new Config({ cn: { gatewayUrl: 'http://10.0.0.5:9000', enabled: false } })
  assert.equal(resolved.cn.gatewayUrl, 'http://10.0.0.5:9000')
  assert.equal(resolved.cn.enabled, false)
  assert.equal(resolved.cn.adminPassword, 'admin')
})

console.log('\n[2] gateway client')
const gateway = new GatewayClient({ region, baseUrl: `${gatewayUrl}/`, adminPassword: 'admin' })
check('base url is normalized', () => assert.equal(gateway.baseUrl, gatewayUrl))
await checkAsync('health', async () => assert.equal((await gateway.health()).ok, true))
await checkAsync('listModels maps metadata', async () => {
  const models = await gateway.listModels()
  assert.equal(models.length, 3)
  const kimi = models.find((m) => m.id === 'kimi-k3')
  assert.equal(kimi.maxTokens, 1000000)
  assert.equal(kimi.accessType, 'premium_only')
  assert.equal(kimi.supportsVision, false)
})
await checkAsync('adminStatus', async () => {
  const status = await gateway.adminStatus()
  assert.equal(status.total_requests, 10)
  assert.equal(status.active_tokens, 1)
})
await checkAsync('listTokens hides the credential', async () => {
  const tokens = await gateway.listTokens()
  assert.equal(tokens.length, 1)
  assert.equal(tokens[0].preview, 'eyJhbGci…')
  assert.equal(tokens[0].value, undefined)
})
await checkAsync('addToken', async () => assert.equal((await gateway.addToken({ name: 'x', value: 'y' })).id, 't2'))
await checkAsync('testToken', async () => assert.equal((await gateway.testToken('t1')).ok, true))
await checkAsync('unreachable gateway maps to 503', async () => {
  const dead = new GatewayClient({ region, baseUrl: 'http://127.0.0.1:1' })
  await assert.rejects(() => dead.health(), (error) => {
    assert.equal(error.status, 503)
    assert.equal(error.retryable, true)
    return true
  })
})

console.log('\n[3] shim')
const shim = createTabbitShim({
  gateway,
  region,
  resolveModels: () => [
    { id: 'best' },
    { id: 'kimi-k3' },
    { id: 'longcat-flash-thinking' },
  ],
  resolveEnabledIds: () => ['best', 'longcat-flash-thinking'],
})
await shim.ready
const base = shim.baseUrl()
check('shim listens on loopback', () => assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/))
await checkAsync('rejects a missing bearer', async () => {
  const response = await fetch(`${base}/v1/models`)
  assert.equal(response.status, 401)
})
await checkAsync('rejects a wrong bearer', async () => {
  const response = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer nope' } })
  assert.equal(response.status, 401)
})
await checkAsync('filters /v1/models by the allow-list', async () => {
  const response = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${shim.token()}` } })
  const body = await response.json()
  assert.deepEqual(body.data.map((m) => m.id), ['best', 'longcat-flash-thinking'])
})
await checkAsync('proxies a streaming completion', async () => {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'best', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  })
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.match(text, /"content":"你"/)
  assert.match(text, /\[DONE\]/)
  assert.equal(seen.completions, 1)
})
await checkAsync('refuses an oversized completion body with a readable status', async () => {
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'best', messages: [{ role: 'user', content: 'x'.repeat(9 * 1024 * 1024) }] }),
  })
  // Not a connection reset: the caller gets a status it can act on.
  assert.equal(response.status, 413)
})
await shim.close()

console.log('\n[4] tabbit helpers')
check('parses jwt|nextauth|device', () => {
  const token = parseTokenValue('aaa.bbb.ccc|next|dev')
  assert.equal(token.jwt, 'aaa.bbb.ccc')
  assert.equal(token.nextAuth, 'next')
  assert.equal(token.deviceId, 'dev')
})
check('tolerates a bare jwt', () => {
  const token = parseTokenValue('aaa.bbb.ccc')
  assert.equal(token.nextAuth, undefined)
  assert.ok(token.deviceId.length > 0)
})
check('reads the user id from the payload', () => {
  const payload = Buffer.from(JSON.stringify({ id: 'u-42' })).toString('base64url')
  assert.equal(userIdOf(`h.${payload}.s`), 'u-42')
})
check('summarizes an unknown credit payload', () => {
  const summary = summarizeCredits({ data: { balance: 1200, monthly_credits: { total: 5000, used: 3800 } } })
  assert.equal(summary.remaining, 1200)
  assert.equal(summary.total, 5000)
  assert.equal(summary.used, 3800)
})
check('collects nothing from a scalar body', () => assert.deepEqual(collectNumbers('x'), []))
check('reads check-in status flags', () => {
  assert.equal(summarizeCheckinStatus({ data: { today_checked_in: true } }).todayCheckedIn, true)
  assert.equal(summarizeCheckinStatus({ data: { checked_in: false } }).todayCheckedIn, false)
  assert.equal(summarizeCheckinStatus({}).todayCheckedIn, false)
})

console.log('\n[5] adapter')
check('maps a gateway model', () => {
  const model = toPiModel({ id: 'best', name: '最佳', accessType: 'free_unlimited', maxTokens: 100000, supportsVision: false }, 'http://127.0.0.1:1/v1', 'tabbit-cn')
  assert.equal(model.id, 'best')
  assert.equal(model.name, '最佳 · 免费')
  assert.equal(model.api, 'openai-completions')
  assert.equal(model.contextWindow, 100000)
  assert.deepEqual(model.input, ['text'])
  assert.equal(model.reasoning, false)
  assert.equal(model.compat.supportsDeveloperRole, false)
})
check('infers reasoning from the model id', () => {
  assert.equal(infersReasoning({ id: 'longcat-flash-thinking' }), true)
  assert.equal(infersReasoning({ id: 'best' }), false)
  const model = toPiModel({ id: 'longcat-flash-thinking', name: 'x', supportsVision: true, maxTokens: 131072 }, 'http://127.0.0.1:1/v1', 'tabbit-cn')
  assert.equal(model.reasoning, true)
  assert.deepEqual(model.input, ['text', 'image'])
  assert.equal(model.thinkingLevelMap.off, 'off')
})
check('honours an image override', () => {
  const model = toPiModel({ id: 'kimi-k3', name: 'k', supportsVision: false }, 'http://127.0.0.1:1/v1', 'tabbit-cn', 'on')
  assert.deepEqual(model.input, ['text', 'image'])
})
check('empty allow-list means no filter', () => {
  assert.equal(filterByEnabled([{ id: 'a' }, { id: 'b' }], []).length, 2)
  assert.deepEqual(filterByEnabled([{ id: 'a' }, { id: 'b' }], ['b']).map((m) => m.id), ['b'])
})

console.log('\n[6] catalog collapse guard')

// Measured against a live tabbit2api: with a credential it could not
// authenticate as, its own "re-read the catalog" endpoint answered ok:true while
// /v1/models went from 20 models to 1. This plugin's refresh button calls that
// endpoint, so believing it would empty the picker on one press.
check('the measured 20 -> 1 collapse is refused', () => {
  assert.equal(catalogAccepts(20, 1), false)
  assert.equal(catalogAccepts(20, 9), false)
  assert.equal(catalogAccepts(20, 10), true)
})
check('growth and steady rosters are accepted', () => {
  assert.equal(catalogAccepts(20, 20), true)
  assert.equal(catalogAccepts(20, 24), true)
  assert.equal(catalogAccepts(1, 1), true)
})
check('a small roster is never second-guessed', () => {
  // A gateway that really does serve two models must not be pinned to three by
  // a rule meant to catch a 20 -> 1 collapse.
  assert.equal(catalogAccepts(3, 1), true)
  assert.equal(catalogAccepts(3, 0), true)
})

console.log('\n[7] pool isolation')
// Two editions, two gateways. An account belongs to exactly one of them: a CN
// cookie means nothing to the global site, so mirroring it across would put a
// permanently failing row in the other pool.
const isolationHome = mkdtempSync(join(tmpdir(), 'dsh-tabbit-pool-'))
const store = new AccountStore({ path: join(isolationHome, 'accounts.json') })

check('an account cannot be added without an edition', () => {
  assert.throws(() => store.add({ name: 'x', value: 'aaa.bbb.ccc' }), /缺少所属版本/)
})
check('records the edition', () => {
  const account = store.add({ name: 'cn', value: 'cn1.bbb.ccc', region: 'tabbit-cn' })
  assert.equal(account.region, 'tabbit-cn')
  store.add({ name: 'global', value: 'gl1.bbb.ccc', region: 'tabbit-global' })
  assert.deepEqual(store.accountsFor('tabbit-cn').map((a) => a.name), ['cn'])
  assert.deepEqual(store.accountsFor('tabbit-global').map((a) => a.name), ['global'])
})
await checkAsync('each gateway receives only its own accounts', async () => {
  const seen = { 'tabbit-cn': [], 'tabbit-global': [] }
  const fakeGateway = (regionId) => ({
    async addToken({ name, value }) {
      seen[regionId].push({ name, value })
      return { id: `${regionId}-${name}` }
    },
  })
  await syncToGateway(store, fakeGateway('tabbit-cn'), 'tabbit-cn')
  await syncToGateway(store, fakeGateway('tabbit-global'), 'tabbit-global')
  assert.deepEqual(seen['tabbit-cn'], [{ name: 'cn', value: 'cn1.bbb.ccc' }])
  assert.deepEqual(seen['tabbit-global'], [{ name: 'global', value: 'gl1.bbb.ccc' }])
})
check('check-in targets are scoped to one edition', () => {
  assert.deepEqual(targetsOf(store, 'tabbit-cn').map((t) => t.accountName), ['cn'])
  assert.deepEqual(targetsOf(store, 'tabbit-global').map((t) => t.accountName), ['global'])
})
check('a disabled account is not a target', () => {
  const id = store.accountsFor('tabbit-cn')[0].id
  store.update(id, { enabled: false })
  assert.deepEqual(targetsOf(store, 'tabbit-cn'), [])
})

fake.close()
console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
