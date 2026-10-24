import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readCredits, readModelCatalog, summarizeCredits, summarizeCheckinStatus, readCheckinStatus, claimCheckin, parseTokenValue } from '../lib/tabbit.js'
import { fromGatewayStatus } from '../lib/errors.js'
import { createTabbitAdapter, toPiModel } from '../lib/adapter.js'
import { createTabbitShim } from '../lib/shim.js'
import { checkinAll } from '../lib/accounts.js'

const token = parseTokenValue(`h.${Buffer.from(JSON.stringify({ id: 'own-account' })).toString('base64url')}.s|session|device`)
const origin = 'https://web.tabbit.com'
const fixture = { member_level: 'pro', usage_percentage: '0.00%', remaining_reset_minutes: 8291, current_cycle_start: '2026.10.19', current_cycle_end: '2026.10.26', membership_entitlement_end_time: '2026.11.19' }

test('live quota shape preserves zero usage and cycle units', () => {
  const row = summarizeCredits(fixture)
  assert.equal(row.kind, 'quota')
  assert.equal(row.unit, 'percent')
  assert.equal(row.used, 0)
  assert.equal(row.remaining, 100)
  assert.equal(row.cycleEnd, '2026.10.26')
  assert.equal(summarizeCredits({ ...fixture, usage_percentage: '12.34%' }).remaining, 87.66)
  assert.throws(() => summarizeCredits({ ...fixture, usage_percentage: 'unavailable' }), /格式已变化/)
})

test('verified quota endpoint repairs old saved guesses without leaking a JWT', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: new URL(url), init })
    return Response.json(fixture)
  })
  const row = await readCredits({ origin, token, paths: ['/proxy/v1/user/credits'] })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url.pathname, '/api/commerce/quota/v1/usage')
  assert.equal(requests[0].url.searchParams.get('user_id'), 'own-account')
  assert.ok(requests[0].url.searchParams.get('timezone'))
  assert.match(requests[0].init.headers.cookie, /next-auth.session-token=session/)
  assert.equal(row.remaining, 100)
  assert.equal(JSON.stringify(row).includes(token.jwt), false)
  assert.equal(row.raw, undefined)
})

test('401 requires login; an unrelated 200 payload is not a zero balance', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 401 }))
  await assert.rejects(readCredits({ origin, token }), { code: 'tabbit_unauthorized' })
  globalThis.fetch.mock.mockImplementation(async () => Response.json({ status: 'ok', user_id: 'own-account' }))
  await assert.rejects(readCredits({ origin, token }), { code: 'quota_schema_changed' })
})

test('chat catalog preserves exact zero/fractional quota rates and live capabilities', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(new URL(url).searchParams.get('scene'), 'chat')
    return Response.json({ status: 'success', models: [
      { display_name: '默认', display_multiplier: 0, model_access_type: 'free_unlimited' },
      { display_name: 'Kimi-K3', display_multiplier: 1.5, supports_images: true, support_thinking: true, use_thinking: true, model_access_type: 'premium_only' },
      { display_name: 'LongCat-2.0', display_multiplier: 0.1 },
    ] })
  })
  const rows = await readModelCatalog({ origin, token })
  assert.equal(rows[0].id, 'best')
  assert.equal(rows[0].usageMultiplier, 0)
  assert.equal(rows[1].usageMultiplier, 1.5)
  assert.equal(rows[1].reasoning, true)
  assert.equal(rows[1].supportsVision, true)
  assert.equal(rows[2].id, 'longcat-2-0')
  assert.match(toPiModel(rows[1], 'http://127.0.0.1/v1', 'tabbit-cn').name, /1.5×用量/)
})

test('official sign-in status is scene-specific; unknown payloads never trigger a claim', async t => {
  assert.equal(summarizeCheckinStatus({ results: [{ scene_code: 'desktop_pet', signed_today: true, activity_open: true }] }).todayCheckedIn, true)
  assert.equal(summarizeCheckinStatus({ results: [{ scene_code: 'other', signed_today: true, activity_open: true }] }).known, false)
  t.mock.method(globalThis, 'fetch', async () => Response.json({ status: 'ok' }))
  await assert.rejects(readCheckinStatus({ origin, token }), { code: 'checkin_schema_changed' })
})

test('sign-in sends the required idempotency reference and recognizes already-signed', async t => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(new URL(url).pathname, '/api/commerce/activity/v1/sign-in')
    const body = JSON.parse(init.body)
    assert.deepEqual(body.scene_codes, ['desktop_pet'])
    assert.match(body.request_no, /^[\da-f-]{36}$/)
    return Response.json({ results: [{ scene_code: 'desktop_pet', sign_in_result: 'already_signed' }] })
  })
  assert.equal((await claimCheckin({ origin, token })).already, true)
})

test('local midnight cannot suppress a server-day check-in', async t => {
  let requests = 0
  let savedDay
  t.mock.method(globalThis, 'fetch', async () => {
    requests++
    return Response.json({ sign_in_date: '2026-10-20', results: [{ scene_code: 'desktop_pet', signed_today: true, activity_open: true }] })
  })
  const rows = await checkinAll([{ accountId: 'own-account', value: `${token.jwt}|session|device`, lastCheckinDay: '2026-10-21' }], { origin, markCheckedIn: (id, now, day) => { savedDay = day } }, new Date('2026-10-21T00:01:00+08:00'))
  assert.equal(requests, 1)
  assert.equal(rows[0].status, 'already')
  assert.equal(savedDay, '2026-10-20')
})

test('empty region is hidden and stale selections fail with account guidance', async () => {
  const region = { id: 'tabbit-global', displayName: 'Tabbit 国际版' }
  const { adapter } = createTabbitAdapter({ regions: [{ region, shim: { baseUrl: () => 'http://127.0.0.1:1', token: () => 'secret' }, catalog: () => [{ id: 'best', name: 'Default' }] }], accountCountFor: () => 0 })
  assert.deepEqual(await adapter.listModels(region.id), [])
  await assert.rejects(adapter.prepareCall(region.id, 'best'), { code: 'ACCOUNT_POOL_EMPTY' })
  await assert.rejects(async () => { for await (const _ of adapter.stream({ provider: region.id, model: 'best' })) {} }, /国际版.*没有已启用的账号/)
})

test('cooldown and protocol errors do not become endlessly retryable 503 errors', () => {
  const error = fromGatewayStatus(503, '{"detail":"no available tokens (all cooling down)"}')
  assert.equal(error.status, 409)
  assert.equal(error.retryable, false)
  assert.equal(error.code, 'account_pool_cooldown')
  assert.equal(fromGatewayStatus(502, 'RSC init error 307').status, 400)
  assert.equal(fromGatewayStatus(502, 'connection reset').retryable, true)
})

test('real pi-ai adapter authenticates through shim and forwards actual usage', async () => {
  const region = { id: 'tabbit-cn', displayName: 'Tabbit 国内版' }
  let called = false
  const gateway = { async chatCompletions(body) {
    called = true
    assert.equal(body.model, 'best')
    const data = [
      { id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
      { id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
    ]
    return new Response(data.map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } }
  const catalog = () => [{ id: 'best', name: '默认', accessType: 'free_unlimited', usageMultiplier: 0 }]
  const shim = createTabbitShim({ gateway, region, resolveModels: catalog })
  await shim.ready
  try {
    const { adapter } = createTabbitAdapter({ regions: [{ region, shim, catalog }], accountCountFor: () => 1 })
    const chunks = []
    for await (const chunk of adapter.stream({ provider: region.id, model: 'best', messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }], tools: [] })) chunks.push(chunk)
    assert.equal(called, true)
    assert.equal(chunks.find(row => row.type === 'usage')?.usage.totalTokens, 4)
    assert.equal(chunks.find(row => row.type === 'text-delta')?.text, 'OK')
  } finally { await shim.close() }
})

test('DSH receives executable tool blocks and replays the matching tool result', async () => {
  const region = { id: 'tabbit-cn', displayName: 'Tabbit 国内版' }
  let round = 0
  const gateway = { async chatCompletions(body) {
    round++
    assert.equal(body.tools[0].function.name, 'open_page')
    if (round === 2) {
      assert.equal(body.messages.find(row => row.role === 'assistant').tool_calls[0].id, 'call_browser')
      assert.equal(body.messages.find(row => row.role === 'tool').tool_call_id, 'call_browser')
    }
    const delta = round === 1 ? { tool_calls: [{ index: 0, id: 'call_browser', type: 'function', function: { name: 'open_page', arguments: '{"url":"https://www.bilibili.com"}' } }] } : { content: '已打开 B 站。' }
    const rows = [
      { id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] },
      { id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: round === 1 ? 'tool_calls' : 'stop' }] },
    ]
    return new Response(rows.map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } }
  const catalog = () => [{ id: 'best', name: '默认' }]
  const shim = createTabbitShim({ gateway, region, resolveModels: catalog })
  await shim.ready
  try {
    const { adapter } = createTabbitAdapter({ regions: [{ region, shim, catalog }] })
    const request = { provider: region.id, model: 'best', messages: [{ role: 'user', content: [{ type: 'text', text: '打开 B 站' }] }], tools: [{ name: 'open_page', description: 'Open page', parameters: { type: 'object', properties: { url: { type: 'string' } } } }] }
    // Exercise the agent loop's actual prepareCall() entry point as well as
    // the public direct stream path; the captured stream bypasses the latter.
    const prepared = await adapter.prepareCall(region.id, 'best')
    const chunks = []
    for await (const row of prepared.stream(request)) chunks.push(row)
    const call = chunks.find(row => row.type === 'block-end')?.block
    assert.equal(call?.type, 'tool-call')
    assert.equal(call.name, 'open_page')
    assert.equal(chunks.find(row => row.type === 'finish').reason.kind, 'tool-calls')
    assert.equal(chunks.some(row => row.type === 'usage'), false, 'unknown usage must not become a zero bill')
    request.messages.push({ role: 'assistant', source: { provider: region.id, model: 'best' }, content: [call] }, { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'Opened successfully' }] })
    const followup = []
    for await (const row of adapter.stream(request)) followup.push(row)
    assert.equal(followup.find(row => row.type === 'text-delta').text, '已打开 B 站。')
  } finally { await shim.close() }
})

test('a streamed gateway error reaches DSH as a failed turn', async () => {
  const region = { id: 'tabbit-cn', displayName: 'Tabbit 国内版' }
  const gateway = { async chatCompletions() {
    return new Response('data: {"error":{"message":"upstream unavailable","type":"upstream_error","code":"tabbit_upstream_error"}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } }
  const catalog = () => [{ id: 'best', name: '默认' }]
  const shim = createTabbitShim({ gateway, region, resolveModels: catalog })
  await shim.ready
  try {
    const { adapter } = createTabbitAdapter({ regions: [{ region, shim, catalog }] })
    const chunks = []
    for await (const row of adapter.stream({ provider: region.id, model: 'best', messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }], tools: [] })) chunks.push(row)
    assert.equal(chunks.find(row => row.type === 'finish').reason.kind, 'error')
  } finally { await shim.close() }
})
