import { TabbitError } from '../errors.js'

const fail = message => { throw new TabbitError(message, { status: 400, code: 'tool_protocol_error' }) }
const ownObject = value => value && typeof value === 'object' && !Array.isArray(value)

/** Read complete top-level call envelopes, ignoring closing tags in JSON/CDATA. */
export function callEnvelopes(text) {
  const calls = []
  const opening = /<dsh_function_call(?:\s+name="([\w.:-]+)")?\s*>/g
  let match
  while ((match = opening.exec(text))) {
    const start = opening.lastIndex
    let quoted = false, escaped = false, end = -1
    for (let i = start; i < text.length; i++) {
      if (match[1] && text.startsWith('<![CDATA[', i)) {
        const close = text.indexOf(']]>', i + 9)
        if (close < 0) fail('多行工具参数的 CDATA 尚未结束。')
        i = close + 2; continue
      }
      if (!match[1]) {
        if (quoted) {
          if (escaped) escaped = false
          else if (text[i] === '\\') escaped = true
          else if (text[i] === '"') quoted = false
          continue
        }
        if (text[i] === '"') { quoted = true; continue }
      }
      if (text.startsWith('</dsh_function_call>', i)) { end = i; break }
    }
    if (end < 0) fail('Tabbit 未返回完整的工具调用。')
    const source = text.slice(start, end)
    let data
    if (!match[1]) {
      try { data = JSON.parse(source) } catch { fail('工具参数不是有效的 JSON。请用 CDATA 多行参数传递代码。') }
    } else {
      const argsMatch = /^\s*<dsh_arguments>([\s\S]*?)<\/dsh_arguments>/.exec(source)
      if (!argsMatch) fail('多行工具调用缺少 dsh_arguments JSON 对象。')
      let args
      try { args = JSON.parse(argsMatch[1]) } catch { fail('工具参数元数据不是有效的 JSON。') }
      if (!ownObject(args)) fail('工具参数必须是 JSON 对象。')
      const rawNames = []
      let tail = source.slice(argsMatch[0].length)
      while (tail.trim()) {
        const field = /^\s*<dsh_string name="([\w.-]+)">\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/dsh_string>/.exec(tail)
        if (!field) fail('多行参数必须使用带名称的 dsh_string 和完整 CDATA。')
        const key = field[1]
        if (['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(args, key)) fail('工具参数重复或包含不允许的属性。')
        Object.defineProperty(args, key, { value: field[2], enumerable: true })
        rawNames.push(key)
        tail = tail.slice(field[0].length)
      }
      data = { name: match[1], arguments: args }
      data.rawNames = rawNames
    }
    const after = end + '</dsh_function_call>'.length
    calls.push({ start: match.index, end: after, data })
    opening.lastIndex = after
  }
  return calls
}

export function validateRawFields(data, fn) {
  for (const key of data.rawNames ?? []) {
    const schema = fn.parameters?.properties?.[key]
    if (!schema || !(schema.type === 'string' || Array.isArray(schema.type) && schema.type.includes('string'))) {
      fail('CDATA 只能用于当前工具声明的字符串参数。')
    }
  }
}

/** Only explicit brief progress before the first call is streamed as prose. */
export function progressBlocks(text) {
  const firstCall = text.indexOf('<dsh_function_call')
  const prefix = firstCall < 0 ? text : text.slice(0, firstCall)
  return [...prefix.matchAll(/<dsh_progress>([\s\S]*?)<\/dsh_progress>/g)]
    .map(match => ({ end: match.index + match[0].length, text: match[1].trim().slice(0, 1200) }))
}

export function stripControl(text) {
  let taskStatus
  let rest = text.replace(/<dsh_task_status>\s*([\s\S]*?)\s*<\/dsh_task_status>/g, (_match, source) => {
    if (taskStatus) fail('本轮包含重复的任务状态。')
    try { taskStatus = JSON.parse(source) } catch { fail('任务状态不是有效的 JSON。') }
    if (!['continue', 'complete', 'blocked', 'needs_input'].includes(taskStatus?.state)) fail('任务状态无效。')
    if (['blocked', 'needs_input'].includes(taskStatus.state) && !String(taskStatus.reason ?? '').trim()) fail('暂停任务必须说明具体原因。')
    return ''
  })
  const progress = progressBlocks(rest)
  rest = rest.replace(/<dsh_progress>[\s\S]*?<\/dsh_progress>/g, '')
  if (/<\/?dsh_(?:function_call|task_status|progress)\b/.test(rest)) fail('工具协议或进度标记不完整。')
  return { text: rest.replace(/```(?:xml|json)?\s*```/g, '').trim(), taskStatus, progress }
}

export function rawCallInstructions(functions) {
  const fn = functions.find(fn => fn.name === 'write' && fn.parameters?.properties?.content?.type === 'string')
    ?? functions.find(fn => Object.values(fn.parameters?.properties ?? {}).some(p => p.type === 'string'))
  const field = fn?.parameters?.properties?.content?.type === 'string' ? 'content'
    : Object.entries(fn?.parameters?.properties ?? {}).find(([, p]) => p.type === 'string')?.[0]
  if (!fn || !field) return []
  const metadata = Object.fromEntries((fn.parameters.required ?? []).filter(key => key !== field)
    .filter(key => fn.parameters.properties?.[key]?.type === 'string')
    .map(key => [key, key === 'file_path' ? 'E:/YOUR_PROJECT/script.py' : `ACTUAL_${key}`]))
  return [
    'For code, shell commands, Windows paths or long text, use this alternative call envelope. Do NOT JSON-escape the CDATA string:',
    `<dsh_function_call name="${fn.name}"><dsh_arguments>${JSON.stringify(metadata)}</dsh_arguments><dsh_string name="${field}"><![CDATA[EXACT STRING VALUE]]></dsh_string></dsh_function_call>`,
    'This is a syntax example. Use actual values and paths from the task, not the example path.',
    'Put other parameters in dsh_arguments as a JSON object. Put each long string in one dsh_string whose name is an actual string parameter. Include all required arguments. Never put the same key in both places.',
    'Preserve exact quotes, backslashes and newlines inside CDATA. If the value contains ]]>, use the ordinary JSON call format instead.',
    'On Windows, write multi-line Python/JS source to a file, then invoke that file with the host shell. Avoid nested python -c / PowerShell quote escaping.',
  ]
}
