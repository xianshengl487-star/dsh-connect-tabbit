import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEmbeddedGateway } from '../lib/embedded/gateway.js'
import { TabbitUpstream, upstreamError, readSSE } from '../lib/embedded/upstream.js'
import { activeFunctions, buildPrompt, parseResponse, currentRequest } from '../lib/embedded/protocol.js'
import { GatewayClient, REGIONS } from '../lib/gateway.js'
import { createTabbitAdapter, toPiModel } from '../lib/adapter.js'

const catalogReader = async () => [{ id: 'best', name: '默认', description: '', accessType: 'free_unlimited', usageMultiplier: 0 }]
const tools = [{ type: 'function', function: { name: 'open_page', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } }]

test('per-model context survives embedded discovery into DSH without changing reply limits', async () => {
  const service = await createEmbeddedGateway({ region: REGIONS[0], catalogReader: async () => [
    { id: 'longcat-2-0', name: 'LongCat-2.0', contextWindow: 1000000, contextSource: 'tabbit-description' },
    { id: 'glm-5-3-flashx', name: 'GLM-5.3-FlashX' },
  ] })
  const client = new GatewayClient({ ...service, region: REGIONS[0] })
  try {
    await client.addToken({ name: 'test', value: 'test.jwt.value|session|device' })
    const [long, unknown] = await client.listModels()
    assert.equal(toPiModel(long, service.baseUrl, 'tabbit-cn').contextWindow, 1000000)
    assert.equal(long.contextSource, 'tabbit-description')
    assert.equal(toPiModel(long, service.baseUrl, 'tabbit-cn').maxTokens, undefined)
    assert.equal(toPiModel(unknown, service.baseUrl, 'tabbit-cn').contextWindow, 100000)
    assert.equal(unknown.contextSource, 'fallback')
    const { adapter } = createTabbitAdapter({ regions: [{ region: REGIONS[0],
      shim: { baseUrl: () => service.baseUrl, token: () => service.apiKey }, catalog: () => [long, unknown] }] })
    const prepared = await adapter.prepareCall('tabbit-cn', long.id)
    assert.equal(prepared.model.context.contextWindow, 1000000)
    assert.equal(prepared.model.defaultMaxTokens, undefined)
  } finally { await service.close() }
})

test('built-in service is private, region-isolated, ephemeral, and releases its socket', async () => {
  const cn = await createEmbeddedGateway({ region: REGIONS[0], catalogReader })
  const global = await createEmbeddedGateway({ region: REGIONS[1], catalogReader })
  const client = new GatewayClient({ ...cn, region: REGIONS[0] })
  try {
    assert.notEqual(cn.baseUrl, global.baseUrl)
    assert.equal((await fetch(cn.baseUrl + '/v1/models')).status, 401)
    assert.equal((await fetch(cn.baseUrl + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: cn.adminPassword }) })).status, 401)
    assert.equal((await fetch(cn.baseUrl + '/v1/models', { headers: { authorization: 'Bearer ' + cn.apiKey, origin: 'https://evil.example' } })).status, 403)
    assert.equal((await fetch(global.baseUrl + '/v1/models', { headers: { authorization: 'Bearer ' + cn.apiKey } })).status, 401)
    assert.equal((await client.health()).ok, true)
    await client.addToken({ name: 'test', value: 'secret.jwt.credential|nextauth|device' })
    const rows = await client.listTokens()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].value, undefined)
    assert.ok(!JSON.stringify(rows).includes('credential'))
    assert.equal((await client.listModels())[0].usageMultiplier, 0)
    const other = new GatewayClient({ ...global, region: REGIONS[1] })
    assert.equal((await other.listTokens()).length, 0)
  } finally { await cn.close(); await global.close() }
  await assert.rejects(fetch(cn.baseUrl + '/health'))
  await cn.close()
})

test('full messages, typed content, original user tags, call IDs and tool results survive projection', () => {
  const messages = [
    { role: 'user', content: '<user_input><goal>打开B站</goal></user_input>' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'open_page', arguments: '{"url":"https://www.bilibili.com"}' } }] },
    { role: 'tool', tool_call_id: 'call_123', content: [{ type: 'text', text: 'opened' }] },
    { role: 'user', content: 'Time sampled while preparing turn 1 step 2: now' },
  ]
  const prompt = buildPrompt(messages, activeFunctions(tools))
  for (const row of messages) assert.ok(prompt.includes(JSON.stringify(row)))
  assert.match(currentRequest(messages), /打开B站/)
  assert.throws(() => parseResponse('<dsh_function_call>{"name":"unknown","arguments":{}}</dsh_function_call>', activeFunctions(tools)))
  assert.throws(() => parseResponse('<dsh_function_call>{"name":"open_page","arguments":{}}</dsh_function_call>', activeFunctions(tools)))
  assert.throws(() => activeFunctions(tools, { type: 'function', function: { name: 'unknown' } }))
  assert.equal(activeFunctions(tools, 'none').length, 0)
})

test('stream emits validated host tool calls and upstream errors never produce successful finish', async () => {
  let rejected = false
  let lastPrompt
  const service = await createEmbeddedGateway({ region: REGIONS[0], catalogReader, upstreamFactory: () => ({
    async *completion(prompt) {
      lastPrompt = prompt
      if (rejected) throw upstreamError({ code: 492, message: '欢迎使用 Tabbit 浏览器' })
      yield { content: '<dsh_function_call>{"name":"open_page","arguments":{"url":"https://www.bilibili.com"}}</dsh_function_call>' }
    },
  }) })
  const gateway = new GatewayClient({ ...service, region: REGIONS[0] })
  const body = { model: 'best', stream: true, tools, messages: [{ role: 'user', content: '打开B站' }] }
  try {
    await gateway.addToken({ value: 'fake.credential.value', name: 'a' })
    const response = await gateway.chatCompletions(body)
    const chunks = []
    for await (const item of readSSE(response)) chunks.push(item.data)
    assert.match(lastPrompt, /打开B站/)
    assert.equal(chunks.filter(row => row.choices?.[0]?.finish_reason === 'tool_calls').length, 1)
    const call = chunks.find(row => row.choices?.[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls[0]
    assert.equal(call.index, 0)
    assert.equal(call.function.name, 'open_page')
    assert.equal(chunks.some(row => row.usage), false)
    rejected = true
    // Several rejected requests must not cool down an otherwise valid account.
    for (let i = 0; i < 4; i++) {
      const response = await gateway.chatCompletions(body)
      const text = await response.text()
      assert.match(text, /tabbit_request_rejected/)
      assert.ok(!text.includes('"finish_reason":"stop"'))
    }
    const row = (await gateway.listTokens())[0]
    assert.equal(row.status, 'active')
    rejected = false
    const retry = await gateway.chatCompletions({ ...body, stream: false })
    assert.equal((await retry.json()).choices[0].finish_reason, 'tool_calls')
  } finally { await service.close() }
})

test('actual DSH runtime and skill rows cannot replace the current user request preview', () => {
  const user = '请用本机 Edge 打开 B 站，并确认窗口标题。'
  const messages = [
    { role: 'user', content: user },
    { role: 'user', content: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' },
    { role: 'user', content: '<skill_content name="dsh-browser-workflow">browser instructions</skill_content>' },
    { role: 'user', content: '<system-reminder>The following tools are available: ...</system-reminder>' },
    { role: 'user', content: 'Time sampled while preparing turn 4, step 1: now' },
  ]
  assert.equal(currentRequest(messages), user)
  const prompt = buildPrompt(messages, activeFunctions(tools))
  for (const row of messages) assert.ok(prompt.includes(JSON.stringify(row)), 'the inline preview must not truncate the complete transcript')
})

test('long context uses official upload flow without truncation or leaking cookies to COS', async () => {
  let uploaded, requestBody
  const calls = []
  const client = new TabbitUpstream({ value: 'header.payload.signature|private-nextauth|device', origin: 'https://web.tabbit.com', fetchImpl: async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/panel/session')) return Response.json({ chat_session_id: 'session-1' })
    if (url.endsWith('/session/session-1')) return new Response('<html></html>')
    if (url.endsWith('/presigned-upload-url')) return Response.json({ url: 'https://test.cos.ap-beijing.myqcloud.com/context?secret=signature', file_id: 'file-1' })
    if (url.includes('.myqcloud.com/')) {
      assert.equal(init.headers.cookie, undefined)
      assert.equal(init.headers.authorization, undefined)
      assert.equal(init.redirect, 'error')
      uploaded = init.body.toString('utf8')
      return new Response('')
    }
    if (url.endsWith('/complete-upload')) return Response.json({ status: 'success' })
    if (url.endsWith('/runs')) { requestBody = JSON.parse(init.body); return Response.json({ run_id: 'run-1' }) }
    if (url.endsWith('/join')) return new Response('event: event_message_chunk\ndata: {"payload":{"chunk_type":"message_chunk","chunk_payload":{"content":"OK"}}}\n\nevent: run_completed\ndata: {}\n\n')
    throw new Error('unexpected path')
  } })
  const prompt = '原始完整历史'.repeat(12000) + '\n<goal>最后用户请求</goal>'
  let text = ''
  for await (const data of client.completion(prompt, '默认', undefined, { currentRequest: '最后用户请求' })) text += data.content ?? ''
  assert.equal(text, 'OK')
  assert.equal(uploaded, prompt)
  assert.ok(requestBody.input_payload.content.length < 20000)
  assert.match(requestBody.input_payload.content, /最后用户请求/)
  assert.equal(requestBody.input_payload.references[0].metadata.file_id, 'file-1')
  assert.equal(calls.some(path => path.endsWith('/api/v1/chat/completion')), false)
})

test('only missing v3 endpoint falls back, foreign redirects and incomplete streams fail', async () => {
  const make = handler => new TabbitUpstream({ value: 'a.b.c', origin: 'https://web.tabbit.com', fetchImpl: handler })
  const foreign = make(async input => String(input).endsWith('/panel/session') ? Response.json({ chat_session_id: 's1' }) : new Response(null, { status: 307, headers: { location: 'https://other.example/session/s1' } }))
  await assert.rejects(foreign.createSession(), e => e.code === 'tabbit_unauthorized')
  let fallback = false
  const legacy = make(async input => {
    const url = String(input)
    if (url.endsWith('/panel/session')) return Response.json({ chat_session_id: 's1' })
    if (url.endsWith('/session/s1')) return new Response('page')
    if (url.endsWith('/runs')) return new Response('', { status: 404 })
    if (url.endsWith('/api/v1/chat/completion')) { fallback = true; return new Response('event: message_chunk\ndata: {"content":"OK"}\n\n') }
    throw new Error('unexpected')
  })
  await assert.rejects(async () => { for await (const _ of legacy.completion('test', '默认')) {} }, e => e.code === 'incomplete_stream')
  assert.equal(fallback, true)
  const rejected = make(async input => {
    const url = String(input)
    if (url.endsWith('/panel/session')) return Response.json({ chat_session_id: 's1' })
    if (url.endsWith('/session/s1')) return new Response('page')
    if (url.endsWith('/runs')) return Response.json({ code: 492, message: '欢迎使用 Tabbit 浏览器' }, { status: 429 })
    throw new Error('must not fall back')
  })
  await assert.rejects(async () => { for await (const _ of rejected.completion('test', '默认')) {} }, e => e.code === 'tabbit_request_rejected' && e.status === 400)
})
