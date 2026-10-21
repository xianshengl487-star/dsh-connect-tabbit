import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { activeFunctions, parseResponse, buildPrompt, currentRequest } from '../lib/embedded/protocol.js'
import { progressBlocks, rawCallInstructions } from '../lib/embedded/host-protocol.js'
import { taskContext, mustContinue } from '../lib/embedded/task-state.js'
import { createEmbeddedGateway } from '../lib/embedded/gateway.js'
import { TabbitUpstream } from '../lib/embedded/upstream.js'
import { GatewayClient, REGIONS } from '../lib/gateway.js'
import { createTabbitShim } from '../lib/shim.js'
import { createTabbitAdapter } from '../lib/adapter.js'

const region = REGIONS[0]
const catalogReader = async () => [{ id: 'best', name: '默认' }]
const tools = [{ type: 'function', function: { name: 'write', parameters: { type: 'object', properties: {
  file_path: { type: 'string' }, content: { type: 'string' }, count: { type: 'integer' },
}, required: ['file_path', 'content'] } } }]
const functions = activeFunctions(tools)
const code = 'from pathlib import Path\nroot = Path(r"E:\\new\\test")\nprint("quote \\\"", 1)\n# literal </dsh_function_call> and <dsh_progress>data</dsh_progress>\n'
const raw = `<dsh_function_call name="write"><dsh_arguments>{"file_path":"E:/test/render.py"}</dsh_arguments><dsh_string name="content"><![CDATA[${code}]]></dsh_string></dsh_function_call>`
const pendingMessages = () => [
  { role: 'user', content: '请制作并渲染一条视频，最终交付 MP4 和源代码。' },
  { role: 'assistant', tool_calls: [{ id: 'todo1', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ todos: [
    { content: '验证环境', status: 'completed' }, { content: '编写并渲染视频', status: 'in_progress' }, { content: '检查 MP4', status: 'pending' },
  ] }) } }] },
  { role: 'tool', tool_call_id: 'todo1', content: 'Updated todo list: 1 pending, 1 in progress, 1 completed.' },
  { role: 'user', content: '继续' },
  { role: 'user', content: 'Time sampled while preparing turn 10 step 1: now' },
]

test('CDATA tools preserve multiline source, quotes, Windows paths and embedded protocol text exactly', () => {
  const parsed = parseResponse(raw, functions)
  assert.equal(parsed.reason, 'tool_calls')
  const args = JSON.parse(parsed.message.tool_calls[0].function.arguments)
  assert.equal(args.content, code)
  assert.equal(args.file_path, 'E:/test/render.py')
  const legacy = '<dsh_function_call>' + JSON.stringify({ name: 'write', arguments: args }) + '</dsh_function_call>'
  assert.equal(JSON.parse(parseResponse(legacy, functions).message.tool_calls[0].function.arguments).content, code)
  assert.deepEqual(progressBlocks(raw), [], 'code is never streamed as a progress update')
  assert.match(buildPrompt([{ role: 'user', content: 'write source' }], functions), /CDATA/)
})

test('raw calls fail closed on unknown names, non-string fields, duplicates and incomplete wrappers', () => {
  for (const invalid of [raw.replace('name="write"', 'name="unknown"'), raw.replace('name="content"', 'name="count"'),
    raw.replace('{"file_path":"E:/test/render.py"}', '{"file_path":"E:/test/render.py","content":"duplicate"}'),
    raw.replace(']]></dsh_string>', '</dsh_string>'), raw.slice(0, -'</dsh_function_call>'.length)]) {
    assert.throws(() => parseResponse(invalid, functions), e => e.code === 'tool_protocol_error')
  }
  const two = raw + raw
  assert.throws(() => parseResponse(two, functions, undefined, false), e => e.code === 'tool_protocol_error')
})

test('continue restores the actual goal and unfinished observed todos, preserving the end of long requests', () => {
  const task = taskContext(pendingMessages())
  assert.match(task.goal, /最终交付 MP4/)
  assert.equal(task.current, '继续')
  assert.equal(task.pending.length, 2)
  assert.equal(task.guard, true)
  assert.equal(mustContinue(parseResponse('环境已确认，下一步开始写代码。', functions), task), true)
  const long = '请制作视频。' + '设计要求。'.repeat(3000) + '最后必须交付 OUTPUT_SENTINEL.mp4'
  assert.match(currentRequest([{ role: 'user', content: long }]), /OUTPUT_SENTINEL/)
  assert.ok(currentRequest([{ role: 'user', content: long }]).length < 5100)
})

test('status questions, new tasks, completed plans and real blockers are allowed to end normally', () => {
  const messages = pendingMessages()
  const status = taskContext([...messages, { role: 'user', content: '现在进度怎样？' }])
  assert.equal(status.guard, false)
  const fresh = taskContext([...messages, { role: 'user', content: '请生成一个新示例。' }])
  assert.equal(fresh.pending.length, 0, 'old unrelated todos do not control a fresh request')
  const task = taskContext(messages)
  const blocked = parseResponse('需要账号登录。<dsh_task_status>{"state":"needs_input","reason":"工具返回登录过期，需要重新登录"}</dsh_task_status>', functions)
  assert.equal(mustContinue(blocked, task), false)
  assert.throws(() => parseResponse('<dsh_task_status>{"state":"blocked"}</dsh_task_status>', functions))
  const completed = pendingMessages()
  completed[1].tool_calls[0].function.arguments = JSON.stringify({ todos: [{ content: '成片验证', status: 'completed' }] })
  assert.equal(taskContext(completed).guard, false)
})

test('compacted working context preserves the original request and observed unfinished step', () => {
  const checkpoint = 'This is an automatically generated checkpoint condensing earlier context.\n<compacted-summary>\n当前活跃任务：制作并渲染知识视频，交付 FINAL.mp4。\n</compacted-summary>'
  const working = { role: 'user', content: '[Working Context: plan mode | in progress: 编写渲染场景 | facts: 环境已经验证]' }
  const messages = [{ role: 'user', content: checkpoint }, working]
  assert.match(currentRequest(messages), /FINAL\.mp4/)
  const task = taskContext(messages)
  assert.equal(task.guard, true)
  assert.equal(task.pending[0].task, '编写渲染场景')
  assert.equal(mustContinue(parseResponse('下面继续写代码。', functions), task), true)
  const direct = [{ role: 'user', content: '请制作原始视频。' }, { role: 'user', content: checkpoint }, working]
  assert.equal(currentRequest(direct), '请制作原始视频。')
  assert.equal(taskContext([...messages, { role: 'user', content: '现在进度怎样？' }]).guard, false)
  assert.equal(taskContext([...messages, { role: 'user', content: '请生成另一个小例子。' }]).pending.length, 0)
})

test('raw syntax example includes required file metadata and parses against the actual tool schema', () => {
  const instructions = rawCallInstructions(functions)
  const example = instructions.find(line => line.startsWith('<dsh_function_call'))
  const parsed = parseResponse(example, functions)
  const args = JSON.parse(parsed.message.tool_calls[0].function.arguments)
  assert.equal(typeof args.file_path, 'string')
  assert.equal(args.content, 'EXACT STRING VALUE')
  assert.ok(!buildPrompt([{ role:'user',content:'write code' }], functions).includes('emit its JSON inside'))
})

test('gateway corrects a progress-only stop with an actual call while work remains', async () => {
  let calls = 0
  const service = await createEmbeddedGateway({ region, catalogReader, upstreamFactory: () => ({ async *completion(prompt, _model, _signal, context) {
    calls++
    assert.equal(context.pendingTasks.length, 2)
    if (calls === 1) yield { content: '<dsh_progress>环境已就绪，准备编写。</dsh_progress>下一步开始写代码。' }
    else {
      assert.match(prompt, /unfinished work/)
      assert.match(context.activeGoal, /MP4/)
      yield { content: raw }
    }
  } }) })
  try {
    const gateway = new GatewayClient({ region, ...service })
    await gateway.addToken({ value: 'a.b.c' })
    const response = await gateway.chatCompletions({ model: 'best', stream: false, tools, messages: pendingMessages() })
    const result = await response.json()
    assert.equal(result.choices[0].finish_reason, 'tool_calls')
    assert.equal(result.choices[0].message.tool_calls.length, 1)
    assert.equal(calls, 2)
    const records = (await gateway.adminStatus()).token_usage.recent
    assert.equal(records[1].status, 'retrying')
    assert.equal(records[1].errorCode, 'task_incomplete')
    assert.notEqual((await gateway.listTokens())[0].status, 'cooldown')
  } finally { await service.close() }
})

test('continuation recovery is bounded and never marks an unfinished task complete', async () => {
  let calls = 0
  const service = await createEmbeddedGateway({ region, catalogReader, upstreamFactory: () => ({ async *completion() {
    calls++; yield { content: '环境已确认，下一步开始。' }
  } }) })
  try {
    const gateway = new GatewayClient({ region, ...service })
    await gateway.addToken({ value: 'a.b.c' })
    const response = await gateway.chatCompletions({ model: 'best', stream: true, tools, messages: pendingMessages() })
    const text = await response.text()
    assert.equal(calls, 3)
    assert.match(text, /task_incomplete/)
    assert.ok(!text.includes('"finish_reason":"stop"'))
  } finally { await service.close() }
})

test('actual DSH prepared stream receives reasoning and brief progress before a tool response completes', async () => {
  let release
  const ready = new Promise(resolve => { release = resolve })
  let closed = false
  const service = await createEmbeddedGateway({ region, catalogReader, upstreamFactory: () => ({ async *completion() {
    yield { reasoning_content: 'UPSTREAM_REASONING_SENTINEL' }
    yield { content: '<dsh_prog' }
    yield { content: 'ress>正在写入测试源文件。</dsh_progress>' }
    await ready
    closed = true
    yield { content: raw }
  } }) })
  const gateway = new GatewayClient({ region, ...service })
  await gateway.addToken({ value: 'a.b.c' })
  const catalog = () => [{ id: 'best', name: '默认', reasoning: false }]
  const shim = createTabbitShim({ gateway, region, resolveModels: catalog })
  await shim.ready
  try {
    const { adapter } = createTabbitAdapter({ regions: [{ region, shim, catalog }] })
    const prepared = await adapter.prepareCall(region.id, 'best')
    const rows = [], early = []
    const consuming = (async () => {
      for await (const row of prepared.stream({ provider: region.id, model: 'best', messages: [{ role: 'user', content: [{ type: 'text', text: 'Write a test file.' }] }],
        tools: functions, signal: AbortSignal.timeout(5000) })) {
        rows.push(row)
        if (!closed && ['reasoning-delta', 'text-delta'].includes(row.type)) early.push(row)
        if (early.some(r => r.type === 'reasoning-delta') && early.some(r => r.type === 'text-delta')) release()
      }
    })()
    await consuming
    assert.equal(early.find(r => r.type === 'reasoning-delta').text, 'UPSTREAM_REASONING_SENTINEL')
    assert.match(early.find(r => r.type === 'text-delta').text, /正在写入/)
    assert.equal(rows.filter(r => r.type === 'block-end' && r.block?.type === 'tool-call').length, 1)
    assert.equal(rows.find(r => r.type === 'finish').reason.kind, 'tool-calls')
    assert.ok(!rows.filter(r => r.type === 'text-delta').map(r => r.text).join('').includes('CDATA'))
  } finally { release(); await shim.close(); await service.close() }
})

test('official v3 thinking events reach the reasoning channel and are deduplicated on reconnect', async () => {
  let joins = 0
  const thinking = 'event: event_message_chunk\ndata: {"event_id":"1","payload":{"run_id":"r","chunk_type":"thinking","chunk_payload":{"reasoning_content":"provider progress"}}}\n\n'
  const client = new TabbitUpstream({ value: 'a.b.c', origin: 'https://web.tabbit.com', policy: { retryDelayMs: 1 }, fetchImpl: async url => {
    const path = new URL(url).pathname
    if (path === '/panel/session') return Response.json({ chat_session_id: 's' })
    if (path === '/session/s') return new Response('page')
    if (path.endsWith('/runs')) return Response.json({ run_id: 'r' })
    if (path.endsWith('/join')) return new Response(++joins === 1 ? thinking : thinking
      + 'event: assistant_message_delta\ndata: {"event_id":"2","payload":{"run_id":"r","chunk_type":"message_chunk","chunk_payload":{"content":"OK"}}}\n\n'
      + 'event: run_completed\ndata: {"event_id":"3","payload":{"run_id":"r"}}\n\n')
    throw new Error('unexpected path')
  } })
  const rows = []
  for await (const row of client.completion('test', '默认')) rows.push(row)
  assert.equal(rows.filter(r => r.reasoning_content).length, 1)
  assert.equal(rows.find(r => r.content).content, 'OK')
})
