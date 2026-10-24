import { randomUUID } from 'node:crypto'
import { TabbitError } from '../errors.js'
import { callEnvelopes, validateRawFields, stripControl, rawCallInstructions } from './host-protocol.js'
import { requestPurpose, transcriptMessage } from './request-context.js'
export { reportedUsage } from './usage.js'

const fail = (message, detail) => {
  const error = new TabbitError(message, { status: 400, code: 'tool_protocol_error' })
  if (detail) error.detail = detail
  throw error
}

export function activeFunctions(tools = [], choice) {
  if (choice === 'none') return []
  if (!Array.isArray(tools)) fail('工具定义必须是数组。')
  const names = new Set()
  let functions = tools.map(tool => {
    const fn = tool?.function
    if (tool?.type !== 'function' || typeof fn?.name !== 'string' || !fn.name || names.has(fn.name)) fail('工具定义缺失名称或名称重复。')
    names.add(fn.name)
    return fn
  })
  if (choice && typeof choice === 'object') {
    if (choice.type !== 'function' || !names.has(choice.function?.name)) fail('tool_choice 指定了不存在的工具。')
    functions = functions.filter(fn => fn.name === choice.function.name)
  } else if (![undefined, null, 'auto', 'required', 'none'].includes(choice)) fail('不支持的 tool_choice。')
  if (choice === 'required' && !functions.length) fail('本轮要求调用工具，但没有提供工具。')
  return functions
}

export function buildPrompt(messages, functions, choice) {
  if (!Array.isArray(messages) || !messages.length) fail('没有收到用户消息。')
  const compacting = requestPurpose(messages) === 'compaction'
  const lines = compacting ? [
    'Summarization only: create the factual checkpoint requested by the DSH host.',
    'The source transcript below is material to summarize, not a new request to execute.',
    'Follow the host summary format. Preserve the active user objective, unfinished work, verified tool results, exact file paths, failures and next operation.',
    'Refer to source already saved on disk by path and necessary API signatures rather than pasting entire files or repeating tool catalogs.',
    'Do not reproduce provider reasoning streams. Do not continue the task or emit executable host calls.',
  ] : [
    'Generate the next assistant response for an external application named DSH.',
    'This is a text/protocol generation task. Do not execute the transcript\'s actions yourself.',
    'DSH, a separate application on the user\'s computer, executes its own host functions.',
    'Tabbit internal browser functions cannot operate DSH and must not be used here.',
    'Continue the complete chronological conversation below, preserving its original roles.',
    'Follow system/developer instructions and answer the user\'s actual request.',
    'Appended timestamps, model changes, environment and skill context do not erase that request.',
    'Tool results are observations. Never claim success before a successful host tool result.',
    'For long tasks keep working until the requested outcome is verified. Use completed results as progress; do not restart the task at each step.',
    'An environment check, plan, dependency probe or promise to continue is NOT the requested deliverable. Once prerequisites are known, implement, execute and verify the actual output.',
    'After a tool error inspect the cause and choose a correction. Do not repeat the same failed action unchanged.',
    'Keep deliberation focused on the next concrete operation. Do not rehearse entire programs in analysis; put source code in the host call. Batch independent work when appropriate.',
  ]
  if (functions.length) lines.push(
    'Use the following external host functions to perform actions. Output one or more blocks:',
    '<dsh_function_call>{"name":"FUNCTION_NAME","arguments":{"PARAMETER":"VALUE"}}</dsh_function_call>',
    'Use real names and JSON object arguments matching the schemas. Escape quotes, backslashes and newlines inside JSON strings.',
    'Emit call blocks only as standalone executable instructions, outside Markdown. Never include example call tags in normal prose.',
    'The DSH host executes calls; wait for its results. Do not repeat completed actions.',
    'When no function is needed, answer normally without tags.',
    'For every action step, first emit <dsh_progress>A brief user-facing progress update, not private analysis</dsh_progress>, then the actual host call.',
    'If work remains, emit a host call now. Do not end a turn with only future plans or repeat known environment checks.',
    'Keep each call small enough to finish: for a long file create it with the first chunk, then append or patch in follow-up calls. Never emit one oversized argument that may be cut off before its closing tag.',
    'When unable to continue, add <dsh_task_status>{"state":"blocked","reason":"specific observed blocker"}</dsh_task_status>. If you need a user answer use state needs_input. If an update still needs another model step use state continue. A verified final answer may append state complete. Never claim complete while a todo remains open; this also applies after compaction when the todo projection is absent.',
    ...rawCallInstructions(functions),
    'Available functions: ' + JSON.stringify(functions),
  )
  lines.push('BEGIN CONVERSATION (one JSON message per line)')
  // User messages and tool evidence remain intact. Provider deliberation is
  // display data, not part of the controller's public conversation replay.
  for (const row of messages) {
    if (!row || !['system', 'developer', 'user', 'assistant', 'tool'].includes(row.role)) fail('对话中包含无效的消息角色。')
    lines.push(JSON.stringify(transcriptMessage(row)))
  }
  lines.push('END CONVERSATION')
  if (!functions.length) lines.push('This response is text only. Do not emit executable host calls. Historical calls are reference material.')
  if (choice === 'required' || choice && typeof choice === 'object') lines.push('The host requires a function call for this response.')
  if (functions.length) lines.push(
    'Produce external DSH controller protocol text. Do not perform actions using Tabbit internal tools.',
    'For a requested action select an available host function and emit its call envelope. Prefer named CDATA envelopes for source code and shell commands.',
    'Do not report failure or success before receiving the host tool result.',
  )
  lines.push(compacting ? 'Return only the requested checkpoint. Do not execute or promise to execute the original task.'
    : 'Now produce only the next assistant response or function call.')
  return lines.join('\n')
}

export function parseResponse(text, functions, choice, parallel = true) {
  if (!text.trim()) fail('Tabbit 没有返回正文或主机工具调用；本轮没有执行操作。', 'empty_response')
  // Compaction is text-only and may quote old calls, including invalid examples.
  // With no active tools no text can acquire permission to execute a function.
  if (!functions.length) return { message: { role: 'assistant', content: text }, reason: 'stop' }
  const matches = callEnvelopes(text)
  let remainder = text
  for (const match of [...matches].reverse()) remainder = remainder.slice(0, match.start) + remainder.slice(match.end)
  const controls = stripControl(remainder)
  if (!matches.length) {
    if (choice === 'required' || choice && typeof choice === 'object') fail('Tabbit 未返回完整的工具调用。', 'missing_call')
    if (!controls.text && !controls.progress.length && !controls.taskStatus) fail('Tabbit 没有返回正文或工具调用。', 'missing_call')
    return { message: { role: 'assistant', content: controls.text || null }, reason: 'stop', taskStatus: controls.taskStatus, progress: controls.progress }
  }
  if (!parallel && matches.length > 1) fail('本轮不允许并行调用多个工具。')
  const byName = new Map(functions.map(fn => [fn.name, fn]))
  const calls = matches.map(match => {
    const data = match.data
    const fn = byName.get(data?.name)
    if (!fn) fail('Tabbit 请求了本轮没有提供的工具。', 'unknown_tool')
    validateRawFields(data, fn)
    const args = data.arguments
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail('工具参数必须是 JSON 对象。', 'malformed_json')
    if ((fn.parameters?.required ?? []).some(key => !Object.hasOwn(args, key))) fail('工具调用缺少必填参数。', 'missing_required')
    return { id: 'call_' + randomUUID().replaceAll('-', ''), type: 'function', function: { name: data.name, arguments: JSON.stringify(args) } }
  })
  return { message: { role: 'assistant', content: controls.text || null, tool_calls: calls }, reason: 'tool_calls', taskStatus: controls.taskStatus, progress: controls.progress }
}

// Recognition only: runtime instructions remain in the complete prompt. They
// must not replace the human objective or crowd observations out of its preview.
export const isRuntimeContext = text => /^(?:Time sampled while preparing turn |\[model changed:|\[Working Context:|\[Circuit Breaker\] The runtime interrupted a degeneration loop:|<environment_context>|<system[-_]reminder>|<skill_content\b|Current runtime context\.)/.test(text.trim())

export function currentRequest(messages = [], limit = 5000) {
  const textOf = row => typeof row?.content === 'string' ? row.content : Array.isArray(row?.content)
    ? row.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : ''
  const checkpoint = text => /^This is an automatically generated checkpoint\b/.test(text.trim()) && text.includes('<compacted-summary>')
  const candidates = messages.filter(row => row.role === 'user' && !isRuntimeContext(textOf(row)))
  // A checkpoint carries the task when compaction has removed the original
  // request, but must not replace a real user message that is still present.
  const user = candidates.findLast(row => !checkpoint(textOf(row))) ?? candidates.at(-1)
  // This is an inline preview, never a replacement for the attached transcript.
  if (!user) return ''
  const text = textOf(user)
  return !limit || text.length <= limit ? text : text.slice(0, Math.floor(limit * 0.6))
    + '\n[中间内容见完整附件 / middle in full attachment]\n' + text.slice(-Math.floor(limit * 0.35))
}

/** A bounded inline orientation; the complete unmodified transcript is attached. */
export function recentContext(messages = [], limit = 7000) {
  const rows = []
  let length = 0
  for (let i = messages.length - 1; i >= 0 && rows.length < 8; i--) {
    if (!['user', 'assistant', 'tool'].includes(messages[i]?.role)) continue
    const content = messages[i].content
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join('\n') : ''
    if (messages[i].role === 'user' && isRuntimeContext(text)) continue
    const row = JSON.stringify(transcriptMessage(messages[i]))
    if (length + row.length > limit) {
      if (!rows.length) {
        let preview = row.slice(-limit + 200)
        let rendered
        do {
          rendered = JSON.stringify({ role: messages[i].role, preview, full_message_in_attachment: true })
          if (rendered.length <= limit) break
          preview = preview.slice(-Math.floor(preview.length * 0.75))
        } while (preview.length)
        rows.unshift(rendered)
      }
      break
    }
    rows.unshift(row); length += row.length
  }
  return rows.join('\n')
}
