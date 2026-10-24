import { currentRequest } from './protocol.js'

const textOf = row => typeof row?.content === 'string' ? row.content : Array.isArray(row?.content)
  ? row.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : ''
const continuation = text => /^(?:继续|接着|继续执行|继续完成|接着做|continue|resume|go on)[。.!！\s]*$/i.test(text.trim())
const preview = (text, limit) => text.length <= limit ? text : text.slice(0, Math.floor(limit * 0.6))
  + '\n[中间内容见完整附件 / middle in full attachment]\n' + text.slice(-Math.floor(limit * 0.35))

export function taskContext(messages) {
  const current = currentRequest(messages, 0)
  let goal = current
  let goalIndex = messages.findLastIndex(row => row.role === 'user' && textOf(row) === current)
  if (continuation(current)) {
    const before = messages.slice(0, messages.findLastIndex(row => row.role === 'user' && textOf(row) === current))
    // Reuse the existing context-row recognizer rather than allowing a runtime
    // timestamp or skill injection to become the resumed task's objective.
    while (before.length) {
      const candidate = currentRequest(before, 0)
      if (!continuation(candidate)) { goal = candidate; goalIndex = before.findLastIndex(row => row.role === 'user' && textOf(row) === candidate); break }
      const index = before.findLastIndex(row => row.role === 'user' && textOf(row) === candidate)
      if (index < 0) break
      before.length = index
    }
  }
  const informational = /^(?:先别|不要继续|暂停|停止|取消|只(?:告诉|解释|回答)|(?:目前|现在)?(?:进度|状态)|解释|为什么|what(?:'s| is) the status|pause|stop|cancel)/i.test(current.trim())
  const actionable = !informational && (continuation(current) || /制作|生成|渲染|实现|修复|开发|构建|打开|读取|运行|测试|检查|保存|导出|编写|整理|抓取|搜索|请.*(?:执行|完成|写入|创建)|\b(?:create|build|implement|render|generate|fix|execute|open|read|run|test|check|save|export|write|search)\b/i.test(goal))
  let pending = []
  let planIndex = -1
  const results = new Map(messages.filter(row => row.role === 'tool').map(row => [row.tool_call_id, row]))
  for (const row of messages.slice(Math.max(goalIndex, 0))) for (const call of row.tool_calls ?? []) {
    if (!['todo_write', 'update_plan'].includes(call.function?.name)) continue
    const result = results.get(call.id)
    if (!result || /(?:^|\n)(?:error|错误|失败)\b/i.test(textOf(result))) continue
    try {
      const args = JSON.parse(call.function.arguments)
      const plan = args.todos ?? args.plan ?? args.steps
      if (!Array.isArray(plan)) continue
      pending = plan.filter(step => !['completed', 'done', 'cancelled'].includes(step.status))
        .map(step => ({ task: String(step.content ?? step.step ?? step.description ?? step.title ?? '').slice(0, 200), status: step.status }))
      planIndex = messages.indexOf(row)
    } catch { /* Only observed, successfully parsed plan updates are authoritative. */ }
  }
  // Liangshen republishes this observed todo projection after compaction. It
  // remains useful even when the original todo_write left the visible history.
  const workingIndex = messages.findLastIndex(row => row.role === 'user' && /^\[Working Context:/.test(textOf(row).trim()))
  if (workingIndex > Math.max(goalIndex, planIndex)) {
    const working = /(?:^\[Working Context: |\s*\|\s*)in progress: ([\s\S]*?)(?:\s*\||\]\s*$)/.exec(textOf(messages[workingIndex]).trim())
    if (working && !pending.length) pending = [{ task: working[1].slice(0, 200), status: 'in_progress' }]
  }
  return { goal: preview(goal, 5000), current: preview(current, 2200), resumed: continuation(current), pending: pending.slice(0, 12), actionable, guard: actionable && pending.length > 0 }
}

function progressOnly(parsed) {
  const content = String(parsed.message?.content ?? '').trim()
  if (!content) return Boolean(parsed.progress?.length)
  // Detect a promise to perform the next operation, not an optional follow-up
  // or the contents of delivered source code. No todo projection is required.
  const prose = content.replace(/```[\s\S]*?```/g, '')
    .split(/[\n。！？]/).filter(line => !/^\s*(?:如需|如果你|若需要|可选|后续可|你可以|下一步(?:你可以|可以)|if you|optionally|you can)/i.test(line)).join('\n')
  return /(?:接下来|下一步|随后|然后|现在|马上|即将|准备|将(?:会|要)?|先)[^。！？\n]{0,90}(?:写入|编写|执行|运行|生成|渲染|自检|验证|测试|检查|读取|创建|实现|落盘|调用|开始|继续)/.test(prose)
    || /(?:^|\n)\s*(?:next I(?:'ll| will)|I(?:'ll| will)(?: now)?|now I(?:'ll| will)|next step is to|I am (?:going|about) to)\s+(?:write|create|run|execute|render|test|check|read|implement|call|continue)\b/i.test(prose)
}

export function continuationReason(parsed, task) {
  if (parsed.reason === 'tool_calls' || ['blocked', 'needs_input'].includes(parsed.taskStatus?.state)) return undefined
  if (parsed.taskStatus?.state === 'continue') return 'explicit_continue'
  if (task.guard) return 'pending_tasks'
  if (task.actionable && progressOnly(parsed)) return 'progress_only'
  return undefined
}

export const mustContinue = (parsed, task) => Boolean(continuationReason(parsed, task))
