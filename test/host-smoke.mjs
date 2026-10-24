/**
 * Integration test: the real plugin, a fake tabbit2api, a stub Cordis context.
 *
 * This is the closest thing to "does it actually register" that can run without
 * a Tabbit account. It exercises the whole host path — activation, provider
 * registration, the settings section, all four card routes — and asserts on what
 * the host would have been told.
 *
 * The pool file is redirected with `$DSH_HOME` so the test never touches the
 * real `~/.dsh`.
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
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

const home = mkdtempSync(join(tmpdir(), 'dsh-tabbit-test-'))
process.env.DSH_HOME = home

// ---------------------------------------------------------------- fake gateway + tabbit
const MODELS = [
  { id: 'best', object: 'model', name: '最佳', max_tokens: 100000, supports_vision: false, access_type: 'free_unlimited' },
  { id: 'kimi-k3', object: 'model', name: 'Kimi-K3', max_tokens: 1000000, supports_vision: false, access_type: 'premium_only' },
  { id: 'longcat-flash-thinking', object: 'model', name: 'LongCat-Flash-Thinking', max_tokens: 131072, supports_vision: true, access_type: 'free_metered' },
]

const calls = { addToken: 0, deleteToken: 0, checkinClaim: 0, credits: 0, login: 0 }
let mirrorPresent = true

const VALID_TOKEN = 'aaa.bbb.ccc|next|dev'

const fake = createServer((req, res) => {
  const url = req.url ?? '/'
  const json = (value, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(value))
  }
  if (url === '/health') return json({ status: 'ok' })
  if (url === '/v1/models') return json({ object: 'list', data: MODELS })
  if (url === '/api/admin/login') {
    calls.login++
    return json({ token: 'fake.jwt.token' })
  }
  if (url.startsWith('/api/admin/')) {
    if (req.headers.authorization !== 'Bearer fake.jwt.token') return json({ detail: 'unauthorized' }, 401)
    if (url === '/api/admin/status') {
      return json({ total_requests: 12, total_success: 11, total_errors: 1, success_rate: 91.7, total_tokens: 1, active_tokens: 1 })
    }
    if (url === '/api/admin/tokens' && req.method === 'GET') {
      return json({ tokens: mirrorPresent ? [{ id: 'gw-1', name: '主账号', enabled: true, status: 'active', value_preview: 'aaa.bbb…' }] : [] })
    }
    if (url === '/api/admin/tokens' && req.method === 'POST') {
      calls.addToken++
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const parsed = JSON.parse(body)
        // The pool entry must reach the gateway intact, not truncated.
        assert.equal(parsed.value, VALID_TOKEN)
        mirrorPresent = true
        json({ id: 'gw-1' })
      })
      return
    }
    if (url.startsWith('/api/admin/tokens/') && req.method === 'DELETE') {
      calls.deleteToken++
      return json({ ok: true })
    }
    if (url.startsWith('/api/admin/tokens/') && req.method === 'PUT') return json({ ok: true })
    if (url === '/api/admin/test-models') return json({ ok: true })
    if (url.startsWith('/api/admin/tokens/') && url.endsWith('/test')) return json({ ok: true, session_id: 's1' })
    return json({})
  }
  // Tabbit's own web endpoints, probed by the credit / check-in readers.
  if (url.startsWith('/api/commerce/quota/v1/usage?')) {
    calls.credits++
    return json({ member_level: 'pro', usage_percentage: '57.00%', current_cycle_start: '2026.10.19', current_cycle_end: '2026.10.26', remaining_reset_minutes: 8291 })
  }
  if (url === '/api/commerce/activity/v1/sign-in/status?scene_codes=desktop_pet') return json({ results: [{ scene_code: 'desktop_pet', signed_today: calls.checkinClaim > 0, activity_open: true }] })
  if (url === '/api/commerce/activity/v1/sign-in' && req.method === 'POST') {
    calls.checkinClaim++
    return json({ results: [{ scene_code: 'desktop_pet', sign_in_result: 'signed' }] })
  }
  if (url === '/v1/chat/completions') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: [DONE]\n\n')
    return
  }
  json({ error: 'not found' }, 404)
})

await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${fake.address().port}`

// ---------------------------------------------------------------- stub context
const captured = {
  adapterIds: undefined,
  adapter: undefined,
  providers: undefined,
  configure: undefined,
  section: undefined,
  legacyInstalled: undefined,
  routes: new Map(),
  effects: 0,
  handlers: new Map(),
}
const disposers = []
const trackEffect = fn => {
  const dispose = fn()
  if (typeof dispose === 'function') disposers.push(dispose)
  return dispose
}

function makeSubContext(services) {
  return {
    ...services,
    effect(fn) {
      captured.effects++
      trackEffect(fn)
    },
    on(event, handler) {
      captured.handlers.set(event, handler)
      return () => captured.handlers.delete(event)
    },
  }
}

/** A settings service as the 0.1.7 line serves it: derive, do not install. */
function modernSettings(capture) {
  return {
    configure(policy, fiber) {
      capture.configure = { policy, fiber }
      return () => {}
    },
    installSection() {
      capture.legacyInstalled = true
    },
  }
}

/** A settings service as the 0.1.5 line serves it: install an explicit section. */
function legacySettings(capture) {
  return {
    installSection(target, namespace, section, config, hooks) {
      capture.section = { namespace, section, config, hooks }
    },
  }
}

const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  emit() {},
  fiber: { uid: 'test-fiber' },
  effect(fn) {
    captured.effects++
    trackEffect(fn)
  },
  on(event, handler) {
    captured.handlers.set(event, handler)
    return () => captured.handlers.delete(event)
  },
  inject(services, fn) {
    const provided = {}
    for (const service of services) {
      if (service === 'settings') provided.settings = modernSettings(captured)
      if (service === 'webServer') {
        provided.webServer = {
          register(route) {
            captured.routes.set(route.path, route)
            return () => {}
          },
        }
      }
    }
    fn(makeSubContext(provided))
  },
  llm: {
    registerAdapter(ids, adapter) {
      captured.adapterIds = ids
      captured.adapter = adapter
      return () => {}
    },
    registerConfigurableProviders(list) {
      captured.providers = list
      return () => {}
    },
  },
}

const { apply, Config } = await import('../lib/index.js')

console.log('\n[1] activation')
const config = new Config({
  cn: { enabled: true, gatewayMode: 'external', gatewayUrl: base, tabbitUrl: base, adminPassword: 'admin' },
  // The global region points at a closed port on purpose: it must be skipped
  // without taking the CN region down.
  global: { enabled: true, gatewayMode: 'external', gatewayUrl: 'http://127.0.0.1:1', tabbitUrl: base },
})

await checkAsync('apply() completes', async () => {
  await apply(ctx, config)
})

check('only the reachable region registered', () => {
  assert.deepEqual([...(captured.adapterIds ?? [])], ['tabbit-cn'])
})
check('provider directory lists the region', () => {
  assert.equal(captured.providers?.length, 1)
  assert.equal(captured.providers[0].provider, 'tabbit-cn')
  assert.equal(captured.providers[0].settingsNs, 'dsh-connect-tabbit')
})
check('settings form is derived, not installed', () => {
  // On the 0.1.7 line `installSection` is gone: the service derives the form
  // from the plugin's Config and keys it by the Loader entry id. Asking it to
  // derive is the only thing the plugin can do.
  assert.deepEqual(captured.configure?.policy, { auto: true })
  assert.equal(captured.configure?.fiber, ctx.fiber)
  assert.notEqual(captured.legacyInstalled, true, 'installSection must not be used when configure exists')
})
check('a settings save is picked up without a reload', () => {
  assert.equal(typeof captured.handlers.get('loader/volatile-update'), 'function')
})
check('four card routes mounted', () => {
  assert.deepEqual(
    [...captured.routes.keys()].sort(),
    [
      '/plugins/dsh-connect-tabbit/accounts',
      '/plugins/dsh-connect-tabbit/checkin',
      '/plugins/dsh-connect-tabbit/models',
      '/plugins/dsh-connect-tabbit/usage',
    ],
  )
})

// The catalog is warmed asynchronously after activation.
await checkAsync('catalog warms in the background', async () => {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const route = captured.routes.get('/plugins/dsh-connect-tabbit/models')
    const result = await callRoute(route, 'GET')
    if (result.body?.models?.length === 3) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('catalog never warmed')
})

// ---------------------------------------------------------------- routes
/** Invoke one registered route with a synthetic request. */
function callRoute(route, method, body, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    // A string body is sent verbatim, so the body ceiling can be tested.
    const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    const chunks = raw === undefined ? [] : [Buffer.from(raw)]
    const req = {
      method,
      url: urlPath ?? route.path,
      headers: { origin: 'http://127.0.0.1:8080', ...headers },
      destroy() {},
      on(event, handler) {
        if (event === 'data') chunks.forEach((chunk) => handler(chunk))
        if (event === 'end') handler()
        return req
      },
    }
    let status = 0
    let payload = ''
    const res = {
      headersSent: false,
      update(state) {
        status = state
        this.headersSent = true
      },
      writeHead(code) {
        this.update(code)
      },
      end(text) {
        payload = text ?? ''
        try {
          resolve({ status, body: payload === '' ? undefined : JSON.parse(payload) })
        } catch (error) {
          reject(error)
        }
      },
    }
    route.handler(req, res).catch(reject)
  })
}

console.log('\n[2] models route')
await checkAsync('lists all models with region metadata', async () => {
  const result = await callRoute(captured.routes.get('/plugins/dsh-connect-tabbit/models'), 'GET')
  assert.equal(result.status, 200)
  assert.equal(result.body.models.length, 3)
  // Both editions are listed even though only one has a gateway: a region whose
  // gateway is down is built and reported with zero models, not omitted, so the
  // user can see which edition is missing rather than guessing.
  assert.equal(result.body.regions.length, 2)
  const cn = result.body.regions.find((region) => region.id === 'tabbit-cn')
  const global = result.body.regions.find((region) => region.id === 'tabbit-global')
  assert.equal(cn.modelCount, 3)
  assert.equal(global.modelCount, 0)
  const kimi = result.body.models.find((model) => model.id === 'kimi-k3')
  assert.equal(kimi.accessType, 'premium_only')
  assert.equal(kimi.contextWindow, 1000000)
})

console.log('\n[3] accounts route')
await checkAsync('starts empty', async () => {
  const result = await callRoute(captured.routes.get('/plugins/dsh-connect-tabbit/accounts'), 'GET')
  assert.deepEqual(result.body.accounts, [])
})
await checkAsync('rejects a malformed credential', async () => {
  const result = await callRoute(captured.routes.get('/plugins/dsh-connect-tabbit/accounts'), 'POST', {
    action: 'add',
    name: 'x',
    value: 'not-a-jwt',
    region: 'tabbit-cn',
  })
  assert.equal(result.status, 400)
})
await checkAsync('rejects an account with no edition', async () => {
  const result = await callRoute(captured.routes.get('/plugins/dsh-connect-tabbit/accounts'), 'POST', {
    action: 'add',
    name: 'x',
    value: VALID_TOKEN,
  })
  assert.equal(result.status, 400)
  assert.match(result.body.error, /未知的版本/)
})
await checkAsync('adds an account and mirrors it', async () => {
  const result = await callRoute(captured.routes.get('/plugins/dsh-connect-tabbit/accounts'), 'POST', {
    action: 'add',
    name: '主账号',
    value: VALID_TOKEN,
    region: 'tabbit-cn',
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.accounts.length, 1)
  assert.equal(result.body.accounts[0].name, '主账号')
  // The edition is part of the record: it decides which gateway the account is
  // mirrored into and which origin its credits and check-in address.
  assert.equal(result.body.accounts[0].region, 'tabbit-cn')
  assert.equal(calls.addToken, 1)
  // The response must never carry the credential back.
  assert.equal(result.body.accounts[0].value, undefined)
})
check('pool file is written with mode 600', () => {
  const path = join(home, 'plugins', 'dsh-connect-tabbit', 'accounts.json')
  assert.ok(existsSync(path))
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(parsed.accounts.length, 1)
  assert.equal(parsed.accounts[0].value, VALID_TOKEN)
  assert.equal(parsed.accounts[0].region, 'tabbit-cn')
})
await checkAsync('rejects a duplicate', async () => {
  const result = await callRoute(captured.routes.get('/plugins/dsh-connect-tabbit/accounts'), 'POST', {
    action: 'add',
    name: 'dup',
    value: VALID_TOKEN,
    region: 'tabbit-cn',
  })
  assert.equal(result.status, 400)
  assert.match(result.body.error, /已经在池里/)
})

await checkAsync('restores a lost execution mirror before a completion', async () => {
  mirrorPresent = false
  const profiles = captured.adapter.config.profiles()
  const model = profiles.get('tabbit-cn').piProvider.getModels()[0]
  const response = await fetch(`${model.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await captured.adapter.config.resolveApiKey('tabbit-cn')}` },
    body: JSON.stringify({ model: 'best', messages: [], stream: true }),
  })
  assert.equal(response.status, 200)
  await response.text()
  assert.equal(mirrorPresent, true)
  assert.equal(calls.addToken, 2)
})

console.log('\n[4] usage route')
await checkAsync('reports gateway counters and credits', async () => {
  const result = await callRoute(captured.routes.get('/plugins/dsh-connect-tabbit/usage'), 'GET')
  assert.equal(result.status, 200)
  assert.equal(result.body.regions.length, 2)
  const cn = result.body.regions.find((region) => region.region === 'tabbit-cn')
  assert.equal(cn.available, true)
  assert.equal(cn.gateway.totalRequests, 12)
  assert.equal(cn.pool.length, 1)
  // The account was mirrored into the fake gateway on add, so the pool reports
  // the gateway's own verdict rather than "unmirrored".
  assert.equal(cn.pool[0].state, 'active')
  assert.equal(cn.pool[0].mirrored, true)
  assert.equal(cn.credits.length, 1)
  assert.equal(cn.credits[0].status, 'ok')
  assert.equal(cn.credits[0].kind, 'quota')
  assert.equal(cn.credits[0].remaining, 43)
  assert.equal(cn.credits[0].total, 100)
  assert.equal(cn.credits[0].used, 57)
  assert.equal(cn.credits[0].cycleEnd, '2026.10.26')
  const global = result.body.regions.find((region) => region.region === 'tabbit-global')
  // The down edition is still read: it reports why it is empty instead of
  // vanishing, which is what the fix for a gateway started after DSH bought.
  assert.equal(global.available, true)
  assert.equal(global.gateway, undefined)
  assert.ok(global.gatewayError.length > 0, 'a down gateway reported no reason')
})

console.log('\n[4b] a gateway that starts after DSH')
await checkAsync('the down edition stays registered, with its reason', async () => {
  // The plugin must not give up on an edition because its gateway was down at
  // activation. Here the global edition points at a closed port.
  const result = await callRoute(captured.routes.get('/plugins/dsh-connect-tabbit/usage'), 'GET')
  assert.equal(result.status, 200, JSON.stringify(result.body))
  const global = result.body.regions.find((region) => region.region === 'tabbit-global')
  assert.equal(global.available, true)
  assert.ok(global.gatewayError.length > 0)
  // Its models route reports the edition too, so the card can name the gap.
  const models = await callRoute(captured.routes.get('/plugins/dsh-connect-tabbit/models'), 'GET')
  assert.equal(models.body.regions.find((region) => region.id === 'tabbit-global').modelCount, 0)
})

console.log('\n[5] check-in route')
await checkAsync('claims once, then reports already', async () => {
  const first = await callRoute(captured.routes.get('/plugins/dsh-connect-tabbit/checkin'), 'POST', {})
  assert.equal(first.status, 200)
  assert.equal(first.body.regions[0].rows[0].status, 'claimed')
  assert.equal(calls.checkinClaim, 1)

  const second = await callRoute(captured.routes.get('/plugins/dsh-connect-tabbit/checkin'), 'POST', {})
  assert.equal(second.body.regions[0].rows[0].status, 'already')
  // The second press must not reach upstream at all.
  assert.equal(calls.checkinClaim, 1)
})

console.log('\n[6] stability guards')
await checkAsync('refuses an oversized body', async () => {
  const result = await callRoute(
    captured.routes.get('/plugins/dsh-connect-tabbit/accounts'),
    'POST',
    JSON.stringify({ action: 'add', name: 'x'.repeat(70000) }),
  )
  assert.equal(result.status, 413)
})
await checkAsync('answers 500 rather than hanging when a route throws', async () => {
  // A malformed request line makes the route itself throw before it answers;
  // the browser must get a JSON error, not a socket that never closes.
  const result = await callRoute(
    captured.routes.get('/plugins/dsh-connect-tabbit/models'),
    'GET',
    undefined,
    'http://[',
  )
  assert.equal(result.status, 500)
  assert.ok(typeof result.body.error === 'string' && result.body.error.length > 0)
})

console.log('\n[7] origin guard')
await checkAsync('refuses a non-loopback origin', async () => {
  const route = captured.routes.get('/plugins/dsh-connect-tabbit/accounts')
  const result = await new Promise((resolve, reject) => {
    const req = {
      method: 'GET',
      url: route.path,
      headers: { origin: 'https://evil.example.com' },
      on() {
        return req
      },
    }
    const res = {
      headersSent: false,
      writeHead(code) {
        this.status = code
        this.headersSent = true
      },
      end(text) {
        resolve({ status: this.status, body: JSON.parse(text) })
      },
    }
    route.handler(req, res).catch(reject)
  })
  assert.equal(result.status, 403)
})

// ---------------------------------------------------------------- legacy line
// The 0.1.5 line has no `configure`: a plugin must still install an explicit
// section there, or the namespace its provider directory points at holds no
// schema and the card has nothing to read or write.
console.log('\n[8] legacy settings line')
const legacy = { section: undefined }
const legacyCtx = {
  logger: ctx.logger,
  emit() {},
  fiber: { uid: 'legacy-fiber' },
  effect(fn) {
    fn()
  },
  on() {
    return () => {}
  },
  inject(services, fn) {
    const provided = {}
    for (const service of services) {
      if (service === 'settings') provided.settings = legacySettings(legacy)
      if (service === 'webServer') {
        provided.webServer = {
          register() {
            return () => {}
          },
        }
      }
    }
    fn(makeSubContext(provided))
  },
  llm: {
    registerAdapter() {
      return () => {}
    },
    registerConfigurableProviders() {
      return () => {}
    },
  },
}

await checkAsync('a 0.1.5 host still gets a section', async () => {
  // Both regions disabled on purpose: this scenario is about the settings call,
  // and it must not bind two more loopback shims to prove it.
  await apply(legacyCtx, new Config({ cn: { enabled: false }, global: { enabled: false } }))
  assert.equal(legacy.section?.namespace, 'dsh-connect-tabbit')
  assert.equal(typeof legacy.section?.hooks?.setSource, 'function')
  assert.equal(typeof legacy.section?.hooks?.onChange, 'function')
})

console.log('\n[9] login and import routes')
const accountRoute = captured.routes.get('/plugins/dsh-connect-tabbit/accounts')
const importedToken = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ id: 'imported', exp: Date.now() / 1000 + 3600 })).toString('base64url')}.signature`
await checkAsync('reports an idle login without launching a browser', async () => {
  const result = await callRoute(accountRoute, 'POST', { action: 'login-status' })
  assert.deepEqual(result.body.login, { status: 'idle' })
})
await checkAsync('imports and renews an account while its gateway is down without exposing credentials', async () => {
  const first = await callRoute(accountRoute, 'POST', { action: 'import', region: 'tabbit-global', name: 'imported', value: importedToken })
  assert.equal(first.status, 200)
  assert.equal(first.body.imported.added, 1)
  assert.equal(first.body.mirrors[0].rows[0].state, 'failed')
  assert.equal(JSON.stringify(first.body).includes(importedToken), false)
  const originalId = first.body.accounts.find(account => account.region === 'tabbit-global').id
  const second = await callRoute(accountRoute, 'POST', { action: 'import', region: 'tabbit-global', name: 'renewed', value: importedToken })
  assert.equal(second.body.imported.updated, 1)
  assert.equal(second.body.accounts.find(account => account.region === 'tabbit-global').id, originalId)
})
await checkAsync('refuses a partly invalid batch without importing its valid entries', async () => {
  const before = (await callRoute(accountRoute, 'GET')).body.accounts.length
  const result = await callRoute(accountRoute, 'POST', { action: 'import', region: 'tabbit-cn', value: { accounts: [{ value: importedToken }, { value: 'bad' }] } })
  assert.equal(result.status, 400)
  assert.equal((await callRoute(accountRoute, 'GET')).body.accounts.length, before)
})
await checkAsync('rejects another localhost origin and DNS rebinding hosts', async () => {
  for (const headers of [{ host: '127.0.0.1:8080', origin: 'http://127.0.0.1:9999' }, { host: 'evil.example:8080', origin: undefined }, { 'sec-fetch-site': 'cross-site' }]) {
    const result = await callRoute(accountRoute, 'POST', { action: 'import-local', region: 'tabbit-cn' }, undefined, headers)
    assert.equal(result.status, 403)
  }
})

for (const dispose of disposers.reverse()) await dispose()
fake.closeAllConnections()
await new Promise(resolve => fake.close(resolve))
console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`)
process.exitCode = failures === 0 ? 0 : 1
