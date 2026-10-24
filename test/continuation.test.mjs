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
import { forPurpose, requestPurpose, COMPACTION_MARKER } from '../lib/embedded/request-context.js'

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

test('compacted progress-only stops are rejected even when the todo projection is absent', () => {
  const checkpoint = 'This is an automatically generated checkpoint condensing an earlier span.\n<compacted-summary>\n'
    + '主要请求：制作并渲染视频，最终交付可播放 MP4。\n下一步：编写场景并运行单帧测试；尚未交付视频。\n</compacted-summary>'
  const messages = [{ role: 'user', content: checkpoint }, { role: 'user', content: '继续' },
    { role: 'user', content: 'Time sampled while preparing turn 14 step 1: now' }]
  const task = taskContext(messages)
  assert.equal(task.pending.length, 0, 'the reproduced compacted request contains no live todo call')
  const response = '<dsh_progress>读取三个模块后立即编写场景。</dsh_progress>'
    + '设计已锁定、API 已确认，现在把五个场景一次性写入 scenes_a.py，随后跑单帧自检。'
  assert.equal(mustContinue(parseResponse(response, functions), task), true)
  assert.equal(mustContinue(parseResponse('现在一次性写入 scenes_a.py 和配套测试脚本。', functions), task), true)
  assert.equal(mustContinue(parseResponse('<dsh_progress>继续写入。</dsh_progress>', functions), task), true)
  assert.equal(mustContinue(parseResponse('视频已生成，回读与播放核验通过：FINAL.mp4。', functions), task), false)
  assert.equal(mustContinue(parseResponse('代码如下：\n```python\nprint("next step")\n```', functions), task), false)
  assert.equal(mustContinue(parseResponse('视频已生成并通过验证。下一步你可以继续添加配音。', functions), task), false)
  assert.equal(mustContinue(parseResponse(response, functions), taskContext([...messages, { role: 'user', content: '现在进度怎样？' }])), false)
})

test('gateway continues a compacted action without todos instead of returning a successful stop', async () => {
  let calls = 0
  const service = await createEmbeddedGateway({ region, catalogReader, upstreamFactory: () => ({ async *completion() {
    calls++
    yield { content: calls === 1 ? '设计已锁定，现在写入场景文件，随后开始验证。' : raw }
  } }) })
  try {
    const gateway = new GatewayClient({ region, ...service })
    await gateway.addToken({ value: 'a.b.c' })
    const response = await gateway.chatCompletions({ model: 'best', stream: false, tools, messages: [
      { role: 'user', content: '请制作并渲染视频，最终交付 MP4。' }, { role: 'user', content: '继续' },
    ] })
    const result = await response.json()
    assert.equal(result.choices[0].finish_reason, 'tool_calls')
    assert.equal(calls, 2)
    const records = (await gateway.adminStatus()).token_usage.recent
    assert.equal(records[1].status, 'retrying')
    assert.equal(records[1].continuationReason, 'progress_only')
    assert.equal(records[0].finishReason, 'tool_calls')
    assert.equal(records[0].toolCalls, 1)
  } finally { await service.close() }
})

test('replayed reasoning is excluded from the Tabbit transcript while public messages and tool evidence remain', () => {
  const messages = [
    { role: 'user', content: '请保留我的原始要求 USER_SENTINEL。' },
    { role: 'assistant', content: '已检查环境 PUBLIC_SENTINEL。', reasoning_content: 'PRIVATE_REPLAY_SENTINEL'.repeat(2000),
      tool_calls: [{ id: 'observed', type: 'function', function: { name: 'write', arguments: '{"file_path":"E:/test.py","content":"print(1)"}' } }] },
    { role: 'tool', tool_call_id: 'observed', content: 'Created file RESULT_SENTINEL' },
  ]
  const prompt = buildPrompt(messages, functions)
  assert.ok(!prompt.includes('PRIVATE_REPLAY_SENTINEL'))
  for (const value of ['USER_SENTINEL', 'PUBLIC_SENTINEL', 'RESULT_SENTINEL', 'observed', 'print(1)']) assert.ok(prompt.includes(value))
  assert.ok(messages[1].reasoning_content.includes('PRIVATE_REPLAY_SENTINEL'), 'stored history is not mutated')
})

test('compaction purpose survives DSH system-message conversion without replacing its instructions', () => {
  const messages = [{ role: 'system', content: [{ type:'text',text:'HOST_SUMMARY_FORMAT' }] },
    { role:'user',content:[{ type:'text',text:'source material' }] }]
  const request = { purpose:'compaction',messages,tools:[functions[0]] }
  const prepared = forPurpose(request)
  assert.equal(requestPurpose(prepared.messages),'compaction')
  assert.deepEqual(prepared.tools,[])
  assert.ok(prepared.messages[0].content.some(p=>p.text==='HOST_SUMMARY_FORMAT'))
  assert.equal(messages[0].content.length,1,'original host history is not mutated')
  const explicit = forPurpose({ ...request,system:'EXPLICIT_HOST_SUMMARY' })
  assert.ok(explicit.system.startsWith(COMPACTION_MARKER))
  assert.ok(explicit.system.includes('EXPLICIT_HOST_SUMMARY'))
  const normal = { ...request,purpose:'chat' }
  assert.equal(forPurpose(normal),normal)
})

test('long compaction attachment asks only for a checkpoint, never task execution', async () => {
  let posted
  const client = new TabbitUpstream({ value:'a.b.c',origin:'https://web.tabbit.com',fetchImpl:async url => {
    throw new Error('unexpected network request: '+new URL(url).pathname)
  } })
  client.createSession = async ()=>'summary-room'
  client.uploadContext = async source=>{ assert.ok(source.length>18000); return {id:'file',type:'file'} }
  client.request = async (path, init) => {
    if (path.endsWith('/runs')) { posted=JSON.parse(init.body).input_payload.content; return Response.json({run_id:'summary-run'}) }
    if (path.endsWith('/join')) return new Response('event: event_message_chunk\ndata: {"event_id":"1","payload":{"run_id":"summary-run","chunk_type":"message_chunk","chunk_payload":{"content":"Checkpoint only"}}}\n\n'
      +'event: run_completed\ndata: {"event_id":"2","payload":{"run_id":"summary-run"}}\n\n')
    throw new Error('unexpected path')
  }
  const result=[]
  for await(const row of client.completion('source '.repeat(3000),'默认',undefined,{purpose:'compaction',textOnly:true,currentRequest:'Summarize existing work.'})) result.push(row)
  assert.match(posted,/Summarization only/)
  assert.ok(!posted.includes('First output <dsh_progress>'))
  assert.ok(!posted.includes('write the implementation and run it'))
  assert.equal(result.find(row=>row.content).content,'Checkpoint only')
})

// A model that hits its output ceiling mid-call leaves the opening tag without
// `</dsh_function_call>`. The old blanket "use CDATA" correction could not fix
// that and exhausted the budget, surfacing a bare PI_AI_ERROR. These regressions
// pin the failure classification and the chunk-aware repair.

test('truncated envelopes are classified for a chunk-aware repair', () => {
  const cutInsideString = raw.slice(0, raw.indexOf('<dsh_string'))
  const cutBeforeTagEnd = '<dsh_function_call name="write"><dsh_arguments>{"file_path":"E:/test/render.py"}'
  for (const cut of [raw.slice(0, -'</dsh_function_call>'.length), cutInsideString, cutBeforeTagEnd]) {
    assert.throws(() => parseResponse(cut, functions), e => e.code === 'tool_protocol_error' && e.detail === 'truncated_call')
  }
  assert.throws(() => parseResponse('I will write the file next.', functions, 'required'),
    e => e.code === 'tool_protocol_error' && e.detail === 'missing_call')
})

test('gateway re-emits a truncated tool call with chunking guidance and recovers', async () => {
  let calls = 0, correction = ''
  const truncated = raw.slice(0, raw.indexOf('<dsh_string'))
  const service = await createEmbeddedGateway({ region, catalogReader, upstreamFactory: () => ({ async *completion(prompt) {
    calls++
    if (calls === 1) yield { content: truncated }
    else { correction = prompt; yield { content: raw } }
  } }) })
  try {
    const gateway = new GatewayClient({ region, ...service })
    await gateway.addToken({ value: 'a.b.c' })
    const response = await gateway.chatCompletions({ model: 'best', stream: false, tools, messages: [{ role: 'user', content: 'write a file' }] })
    const result = await response.json()
    assert.equal(result.choices[0].finish_reason, 'tool_calls')
    assert.equal(result.choices[0].message.tool_calls.length, 1)
    assert.equal(calls, 2)
    assert.match(correction, /ended inside a <dsh_function_call>/)
    assert.match(correction, /closing <\/dsh_function_call>/)
    assert.match(correction, /4000/)
    const records = (await gateway.adminStatus()).token_usage.recent
    assert.equal(records[1].errorCode, 'tool_protocol_error')
    assert.equal(records[1].truncationCorrections, 1)
  } finally { await service.close() }
})

test('repeated truncation is bounded and never reported as a successful stop', async () => {
  let calls = 0
  const truncated = raw.slice(0, raw.indexOf('<dsh_string'))
  const service = await createEmbeddedGateway({ region, catalogReader, upstreamFactory: () => ({ async *completion() {
    calls++; yield { content: truncated }
  } }) })
  try {
    const gateway = new GatewayClient({ region, ...service })
    await gateway.addToken({ value: 'a.b.c' })
    const response = await gateway.chatCompletions({ model: 'best', stream: true, tools, messages: [{ role: 'user', content: 'write a file' }] })
    const text = await response.text()
    assert.equal(calls, 3)
    assert.match(text, /工具调用中途被截断/)
    assert.ok(!text.includes('"finish_reason":"stop"'))
    assert.ok(!text.includes('"finish_reason":"tool_calls"'))
  } finally { await service.close() }
})

test('a required call that arrives as prose is corrected with an explicit call instruction', async () => {
  let calls = 0, correction = ''
  const service = await createEmbeddedGateway({ region, catalogReader, upstreamFactory: () => ({ async *completion(prompt) {
    calls++
    if (calls === 1) yield { content: 'I will write the file now.' }
    else { correction = prompt; yield { content: raw } }
  } }) })
  try {
    const gateway = new GatewayClient({ region, ...service })
    await gateway.addToken({ value: 'a.b.c' })
    const response = await gateway.chatCompletions({ model: 'best', stream: false, tools, tool_choice: 'required',
      messages: [{ role: 'user', content: 'write a file' }] })
    const result = await response.json()
    assert.equal(result.choices[0].finish_reason, 'tool_calls')
    assert.equal(calls, 2)
    assert.match(correction, /contained no complete <dsh_function_call>/)
    assert.match(correction, /Do not answer in prose/)
  } finally { await service.close() }
})
