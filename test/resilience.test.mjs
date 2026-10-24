import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { TabbitUpstream, readSSE } from '../lib/embedded/upstream.js'
import { createEmbeddedGateway } from '../lib/embedded/gateway.js'
import { recentContext, activeFunctions } from '../lib/embedded/protocol.js'
import { estimateTokens, reportedUsage } from '../lib/embedded/usage.js'
import { GatewayClient, REGIONS } from '../lib/gateway.js'
import { createTabbitShim } from '../lib/shim.js'
import { createTabbitAdapter } from '../lib/adapter.js'

const region = REGIONS[0]
const event = (id, type, payload = {}) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ event_id: id, payload: { run_id: 'r1', ...payload } })}\n\n`
const content = (id, text) => event(id, 'event_message_chunk', { chunk_type: 'message_chunk', chunk_payload: { content: text } })
const finish = id => event(id, 'run_completed')
const catalogReader = async () => [{ id: 'best', name: '默认', accessType: 'free_unlimited' }]
const tools = [{ type: 'function', function: { name: 'open_page', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } }]

function transport(handleJoin, options = {}) {
  const calls = [], cursors = []
  let submissions = 0, cancellations = 0
  const client = new TabbitUpstream({ value: 'a.b.c', origin: 'https://web.tabbit.com',
    policy: { retryDelayMs: 1, maxReconnects: 2, ...options.policy }, fetchImpl: async (input, init) => {
      const path = new URL(input).pathname
      calls.push(path)
      if (path === '/panel/session') return Response.json({ chat_session_id: 's1' })
      if (path === '/session/s1') return new Response('page')
      if (path.endsWith('/runs')) {
        submissions++
        if (options.lostAck) throw new TypeError('connection lost after POST')
        return Response.json({ run_id: 'r1' })
      }
      if (path.endsWith('/commands')) {
        cancellations++
        assert.equal(JSON.parse(init.body).command_type, 'cancel')
        assert.equal(init.signal.aborted, false, 'remote cancellation must use a fresh deadline')
        return Response.json({ ok: true })
      }
      if (path.endsWith('/join')) { cursors.push(JSON.parse(init.body).last_event_id); return handleJoin(cursors.length, init) }
      throw new Error('unexpected path ' + path)
    } })
  return { client, cursors, calls, counts: () => ({ submissions, cancellations }) }
}
const collect = async (client, signal, context) => {
  let text = '', usage
  for await (const row of client.completion('synthetic task', '默认', signal, context)) { text += row.content ?? ''; usage = row.usage ?? usage }
  return { text, usage }
}

test('v3 resumes the same run from its last event and deduplicates replay', async () => {
  const upstream = transport(n => new Response(n === 1 ? content('1', 'Alpha') : content('1', 'Alpha') + content('2', 'Beta')
    + event('3', 'run_completed', { usage: { input_tokens: 40, output_tokens: 2 } })))
  let reconnects = 0
  const result = await collect(upstream.client, undefined, { onReconnect: () => reconnects++ })
  assert.equal(result.text, 'AlphaBeta')
  assert.equal(result.usage.total_tokens, 42)
  assert.deepEqual(upstream.cursors, [null, '1'])
  assert.deepEqual(upstream.counts(), { submissions: 1, cancellations: 0 })
  assert.equal(reconnects, 1)
})

test('SSE handles split UTF-8, CRLF, envelope event types and event IDs', async () => {
  const bytes = Buffer.from('id: 7\r\ndata: ' + JSON.stringify({ event_type: 'run_completed', payload: { text: '中文' } }) + '\r\n\r\n')
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } }))
  const rows = []
  for await (const row of readSSE(response)) rows.push(row)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, '7')
  assert.equal(rows[0].event, 'run_completed')
  assert.equal(rows[0].data.payload.text, '中文')
})

test('a healthy long stream outlives the control deadline without resubmission', async () => {
  const upstream = transport((_n, init) => new Response(new ReadableStream({ start(controller) {
    let i = 0
    const timer = setInterval(() => {
      if (i === 5) { controller.enqueue(Buffer.from(finish('9'))); controller.close(); clearInterval(timer) }
      else controller.enqueue(Buffer.from(content(String(++i), 'X')))
    }, 25)
    init.signal.addEventListener('abort', () => { clearInterval(timer); controller.error(init.signal.reason) }, { once: true })
  } })), { policy: { controlTimeoutMs: 50, connectTimeoutMs: 40, streamIdleMs: 80, runTimeoutMs: 1000 } })
  const result = await collect(upstream.client)
  assert.equal(result.text, 'XXXXX')
  assert.equal(upstream.counts().submissions, 1)
})

test('idle socket reconnects, whereas replay without event IDs fails without duplicating text', async () => {
  // Node 22's test runner cancels a still-pending promise once the only
  // remaining handle is an unref'd timer. The idle watchdog is unref'd on
  // purpose in production, so keep the loop alive for the duration of this test.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    const idle = transport(n => n === 1 ? new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from(content('1', 'A'))) } }))
      : new Response(content('2', 'B') + finish('3')), { policy: { streamIdleMs: 20 } })
    assert.equal((await collect(idle.client)).text, 'AB')
    assert.deepEqual(idle.cursors, [null, '1'])
    const noIds = transport(() => new Response('event: event_message_chunk\ndata: {"payload":{"chunk_type":"message_chunk","chunk_payload":{"content":"A"}}}\n\n'))
    await assert.rejects(collect(noIds.client), e => e.code === 'incomplete_stream')
    assert.equal(noIds.cursors.length, 1)
    assert.deepEqual(noIds.counts(), { submissions: 1, cancellations: 1 })
  } finally { clearInterval(keepAlive) }
})

test('lost submit acknowledgement joins the existing private room, never posts a second run', async () => {
  const upstream = transport(() => new Response(content('1', 'OK') + finish('2')), { lostAck: true })
  assert.equal((await collect(upstream.client)).text, 'OK')
  assert.deepEqual(upstream.counts(), { submissions: 1, cancellations: 0 })
})

test('reconnects are bounded; reset is not a successful finish', async () => {
  const unavailable = transport(() => new Response('', { status: 503 }))
  await assert.rejects(collect(unavailable.client), e => e.code === 'stream_failed')
  assert.equal(unavailable.cursors.length, 3)
  assert.equal(unavailable.counts().cancellations, 1)
  const reset = transport(() => new Response(content('1', 'partial') + event('2', 'room_reset_required', { reason: 'terminal_snapshot_available', status: 'COMPLETED' })))
  await assert.rejects(collect(reset.client), e => e.code === 'stream_reset')
  assert.equal(reset.cursors.length, 1)
})

test('consumer cancellation closes the stream and sends a remote cancel command', async () => {
  const controller = new AbortController()
  const upstream = transport(() => new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from(content('1', 'partial'))) } })))
  const running = collect(upstream.client, controller.signal)
  await delay(15)
  controller.abort(new DOMException('cancelled by user', 'AbortError'))
  await assert.rejects(running, e => e.name === 'AbortError')
  assert.deepEqual(upstream.counts(), { submissions: 1, cancellations: 1 })
})

test('usage recognizes official envelopes and zeroes but rejects quoted or invalid counters', () => {
  assert.deepEqual(reportedUsage({ payload: { usage: { input_tokens: 10, output_tokens: 3 } } }), { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 })
  assert.equal(reportedUsage({ usage: { prompt_tokens: 0, completion_tokens: 0 } }).total_tokens, 0)
  for (const row of [{ usage: { prompt_tokens: -1, completion_tokens: 1 } },
    { usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 2 } },
    { content: JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 3 } }) }]) assert.equal(reportedUsage(row), undefined)
  assert.equal(estimateTokens('中文abcd'), 3)
})

test('gateway exposes and persists distinct reported/estimated counters without a fabricated bill', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'tabbit-usage-'))
  const usagePath = join(folder, 'usage.json')
  let reported = false
  let service = await createEmbeddedGateway({ region, usagePath, catalogReader, upstreamFactory: () => ({ async *completion() {
    yield { content: '测试 OK' }
    if (reported) yield { payload: { usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 } } }
  } }) })
  try {
    let gateway = new GatewayClient({ ...service, region })
    await gateway.addToken({ value: 'private.jwt.credential', name: 'private-account' })
    const request = { model: 'best', stream: false, messages: [{ role: 'user', content: '中文测试' }] }
    let result = await (await gateway.chatCompletions(request)).json()
    assert.equal(result.usage, undefined)
    assert.equal(result.dsh_usage.source, 'estimated')
    assert.ok(result.dsh_usage.prompt_tokens > 0)
    reported = true
    result = await (await gateway.chatCompletions(request)).json()
    assert.equal(result.usage.total_tokens, 14)
    assert.equal(result.dsh_usage.source, 'reported')
    const before = (await gateway.adminStatus()).token_usage
    assert.equal(before.reported.total_tokens, 14)
    assert.equal(before.estimated.requests, 1)
    const persisted = readFileSync(usagePath, 'utf8')
    assert.ok(!persisted.includes('private.jwt') && !persisted.includes('中文测试') && !persisted.includes('private-account'))
    await service.close()
    service = await createEmbeddedGateway({ region, usagePath, catalogReader })
    gateway = new GatewayClient({ ...service, region })
    const after = (await gateway.adminStatus()).token_usage
    assert.deepEqual(after.reported, before.reported)
    assert.deepEqual(after.estimated, before.estimated)
    assert.equal(after.recent.length, 2)
  } finally { await service.close(); rmSync(folder, { recursive: true, force: true }) }
})

test('gateway keeps a slow tool response alive and repairs invalid JSON once before emitting one call', async () => {
  let calls = 0
  const service = await createEmbeddedGateway({ region, catalogReader, heartbeatMs: 5, upstreamFactory: () => ({ async *completion(prompt) {
    calls++
    await delay(25)
    if (calls === 1) yield { content: '<dsh_function_call>{invalid}</dsh_function_call>' }
    else { assert.match(prompt, /No host tool was executed/); yield { content: '<dsh_function_call>{"name":"open_page","arguments":{"url":"https://example.com"}}</dsh_function_call>' } }
  } }) })
  try {
    const gateway = new GatewayClient({ ...service, region })
    await gateway.addToken({ value: 'a.b.c' })
    const response = await gateway.chatCompletions({ model: 'best', stream: true, tools, messages: [{ role: 'user', content: 'open example' }] })
    const text = await response.text()
    assert.match(text, /: dsh-tabbit keepalive/)
    assert.equal((text.match(/"name":"open_page"/g) || []).length, 1)
    assert.equal(calls, 2)
    assert.equal((await gateway.adminStatus()).token_usage.recent.length, 2)
    assert.notEqual((await gateway.listTokens())[0].status, 'cooldown')
  } finally { await service.close() }
})

test('DSH compaction omits live tools and safely preserves quoted historical call tags', async () => {
  const service = await createEmbeddedGateway({ region, catalogReader, upstreamFactory: () => ({ async *completion(prompt, _model, _signal, context) {
    assert.ok(!prompt.includes('Available functions:'))
    assert.equal(context.purpose, 'compaction')
    assert.match(prompt, /summarization only/i)
    assert.ok(!prompt.includes('Once prerequisites are known, implement'))
    yield { content: '## Current Work\n- Example: <dsh_function_call>{invalid historical JSON}</dsh_function_call>\n## Next Step\n- Continue verified work.' }
  } }) })
  const gateway = new GatewayClient({ ...service, region })
  await gateway.addToken({ value: 'a.b.c' })
  const catalog = () => [{ id: 'best', name: '默认' }]
  const shim = createTabbitShim({ gateway, region, resolveModels: catalog })
  await shim.ready
  try {
    const { adapter } = createTabbitAdapter({ regions: [{ region, shim, catalog }] })
    const prepared = await adapter.prepareCall(region.id, 'best')
    const rows = []
    for await (const row of prepared.stream({ provider: region.id, model: 'best', purpose: 'compaction', tools: [activeFunctions(tools)[0]],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize, do not execute.' }] }] })) rows.push(row)
    assert.equal(rows.find(row => row.type === 'finish').reason.kind, 'stop')
    assert.ok(rows.some(row => row.type === 'text-delta' && row.text.includes('historical JSON')))
    assert.ok(!rows.some(row => row.block?.type === 'tool-call' || row.type === 'usage'))
  } finally { await shim.close(); await service.close() }
})

test('long-task preview preserves the latest tool result and retains full rows in the attachment', () => {
  const messages = [{ role: 'user', content: 'read ' + 'old reference '.repeat(5000) },
    { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'open_page', arguments: '{"url":"https://example.com"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'Window title verified: Example' }]
  const preview = recentContext(messages)
  assert.match(preview, /Window title verified: Example/)
  assert.match(preview, /c1/)
  assert.ok(preview.length < 7200)
  const escaped = recentContext([{ role: 'tool', content: '"\\'.repeat(15000) }])
  assert.ok(escaped.length <= 7000, 'JSON escaping must not push the inline message above the official limit')
  assert.equal(JSON.parse(escaped).full_message_in_attachment, true)
})
