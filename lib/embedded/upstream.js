import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { buildHeaders, buildCookies, parseTokenValue } from '../tabbit.js'
import { TabbitError } from '../errors.js'
import { setTimeout as delay } from 'node:timers/promises'
import { reportedUsage } from './usage.js'
import { rawCallInstructions } from './host-protocol.js'

const DEFAULT_POLICY = { controlTimeoutMs: 45000, connectTimeoutMs: 45000, streamIdleMs: 90000,
  runTimeoutMs: 20 * 60000, maxReconnects: 6, retryDelayMs: 1000 }
const transient = error => error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error?.name)
  || ['stream_idle', 'incomplete_stream', 'stream_failed', 'channel_refresh'].includes(error?.code)
const interrupted = () => new TabbitError('Tabbit 连接提前结束，未确认本轮完成。已停止续接，不会重复执行主机操作。', { code: 'incomplete_stream' })

const escaped = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;')

export function upstreamError(data) {
  const code = Number(data?.code)
  const message = typeof data?.message === 'string' ? data.message : 'Tabbit 未返回错误说明'
  if (code === 492) return new TabbitError('Tabbit 拒绝了本轮请求（492）。请求过长或网页端限制可能触发此错误；请缩短上下文后重试。账号未因此被停用。', { status: 400, code: 'tabbit_request_rejected' })
  if (code === 401 || code === 403) return new TabbitError('Tabbit 登录状态已过期，请在插件中重新登录该账号。', { status: 401, code: 'tabbit_unauthorized' })
  return new TabbitError(`Tabbit 请求失败${code ? `（${code}）` : ''}：${message.slice(0, 400)}`, { status: code === 429 ? 429 : 502, code: 'tabbit_upstream_error' })
}

/** SSE records may span network packets, CRLFs and multiple data lines. */
export async function* readSSE(response, { signal, idleMs = 90000 } = {}) {
  if (!response.body) throw new TabbitError('Tabbit 没有返回响应流。', { code: 'empty_stream' })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const parse = record => {
    let event = 'message'
    let id
    const data = []
    for (const line of record.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('id:')) id = line.slice(3).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (!data.length || data.join('\n') === '[DONE]') return undefined
    try {
      const value = JSON.parse(data.join('\n'))
      return { event: event === 'message' ? value.event_type ?? event : event, id: value.event_id ?? id, data: value }
    } catch {
      throw new TabbitError('Tabbit 返回了无效的事件数据。', { code: 'invalid_sse' })
    }
  }
  const read = () => new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      fn(value)
    }
    const abort = () => { void reader.cancel().catch(() => {}); finish(reject, signal.reason) }
    const timer = setTimeout(() => {
      void reader.cancel().catch(() => {})
      finish(reject, new TabbitError('Tabbit 响应流长时间没有新数据，正在尝试续接。', { code: 'stream_idle' }))
    }, idleMs)
    timer.unref?.()
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    reader.read().then(value => finish(resolve, value), error => finish(reject, error))
  })
  try {
    while (true) {
      const { value, done } = await read()
      buffer += decoder.decode(value, { stream: !done })
      buffer = buffer.replaceAll('\r\n', '\n')
      let end
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const record = parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
        if (record) yield record
      }
      if (buffer.length > 4 * 1024 * 1024) throw new TabbitError('Tabbit 事件超出大小限制。', { code: 'sse_too_large' })
      if (done) break
    }
    if (buffer.trim()) { const record = parse(buffer); if (record) yield record }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Native Node transport: no Python, subprocess, fixed ports, or config copy. */
export class TabbitUpstream {
  constructor({ value, origin, fetchImpl = fetch, policy = {} }) {
    this.token = parseTokenValue(value)
    this.origin = new URL(origin).origin
    this.fetch = fetchImpl
    this.policy = { ...DEFAULT_POLICY, ...policy }
  }

  headers(session) {
    return {
      ...buildHeaders(this.origin, this.token, { refererPath: session ? `/session/${session}` : '/newtab', contentType: true }),
      cookie: Object.entries(buildCookies(this.token)).map(([key, value]) => `${key}=${value}`).join('; '),
      'x-req-ctx': 'MS42LjIwKDEwMTA2MDIwKQ==',
      'x-nonce': randomBytes(32).toString('hex'),
      'trace-id': randomUUID(), 'unique-uuid': randomUUID(), 'x-signature': randomUUID(),
      'x-timestamp': String(Date.now()),
    }
  }

  async request(path, { session, signal, streaming = false, ...init } = {}) {
    // Streaming uses a header deadline + inactivity budget, never the old
    // absolute 180-second timer that killed an otherwise healthy generation.
    const headersDeadline = new AbortController()
    const timer = streaming ? setTimeout(() => headersDeadline.abort(new DOMException('Tabbit connection timed out', 'TimeoutError')), this.policy.connectTimeoutMs) : undefined
    timer?.unref?.()
    const deadline = streaming ? headersDeadline.signal : AbortSignal.timeout(this.policy.controlTimeoutMs)
    let res
    try {
      res = await this.fetch(`${this.origin}${path}`, {
        ...init, headers: { ...this.headers(session), ...init.headers },
        redirect: 'manual', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      })
    } finally { clearTimeout(timer) }
    if (res.status === 401 || res.status === 403) { await res.body?.cancel(); throw upstreamError({ code: res.status }) }
    return res
  }

  async control(path, init) {
    // Only safe setup requests use this bounded retry. Never blindly resubmit
    // a /runs request after losing its acknowledgement.
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.request(path, init)
        if (attempt >= 2 || response.status < 500) return response
        await response.body?.cancel()
      } catch (error) {
        if (init.signal?.aborted || attempt >= 2 || !transient(error)) throw error
      }
      await delay(this.policy.retryDelayMs * 2 ** attempt, undefined, { signal: init.signal })
    }
  }

  async createSession(signal) {
    const res = await this.control('/panel/session', { method: 'POST', body: '', signal })
    if (!res.ok) { await res.body?.cancel(); throw new TabbitError(`Tabbit 创建会话失败（HTTP ${res.status}）。`, { code: 'session_failed' }) }
    const id = (await res.json()).chat_session_id
    if (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)) throw new TabbitError('Tabbit 没有返回有效的会话编号。', { code: 'session_failed' })
    let path = `/session/${id}`
    for (let i = 0; i < 4; i++) {
      const page = await this.control(path, { signal, headers: { accept: 'text/html' } })
      await page.body?.cancel()
      if (page.ok) return id
      if ([301, 302, 303, 307, 308].includes(page.status)) {
        const target = new URL(page.headers.get('location') ?? '', this.origin + path)
        if (target.origin === this.origin && target.pathname === `/session/${id}`) { path = target.pathname + target.search; continue }
        throw upstreamError({ code: 401 })
      }
      throw new TabbitError(`Tabbit 会话初始化失败（HTTP ${page.status}）。`, { code: 'session_failed' })
    }
    throw new TabbitError('Tabbit 会话重定向过多。', { code: 'session_failed' })
  }

  async uploadContext(text, session, signal) {
    const name = 'dsh-context.txt'
    const body = Buffer.from(text, 'utf8')
    const presigned = await this.request('/proxy/v0/cos/presigned-upload-url', {
      method: 'POST', session, signal, body: JSON.stringify({ file_category: 'document',
        original_filename: name, content_type: 'text/plain', file_size: body.length }),
    })
    if (!presigned.ok) throw new TabbitError(`Tabbit 上下文附件初始化失败（HTTP ${presigned.status}）。`, { code: 'context_upload_failed' })
    const file = await presigned.json()
    const url = new URL(file.url)
    // The pre-signed COS URL carries its own authorization. Never send account
    // cookies or browser identity headers to the object store.
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.endsWith('.myqcloud.com') || typeof file.file_id !== 'string') {
      throw new TabbitError('Tabbit 返回了未知的附件存储地址。', { code: 'context_upload_failed' })
    }
    for (let attempt = 0; ; attempt++) {
      try {
        const put = await this.fetch(url, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body,
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000), redirect: 'error' })
        await put.body?.cancel()
        if (put.ok) break
        if (attempt >= 2 || put.status < 500) throw new TabbitError(`Tabbit 上下文附件上传失败（HTTP ${put.status}）。`, { code: 'context_upload_failed' })
      } catch (error) { if (signal?.aborted || attempt >= 2 || !transient(error)) throw error }
      await delay(this.policy.retryDelayMs * 2 ** attempt, undefined, { signal })
    }
    const complete = await this.request('/api/v0/cos/complete-upload', { method: 'POST', session, signal,
      body: JSON.stringify({ file_id: file.file_id, session_id: session }) })
    if (!complete.ok) { await complete.body?.cancel(); throw new TabbitError(`Tabbit 上下文附件登记失败（HTTP ${complete.status}）。`, { code: 'context_upload_failed' }) }
    await complete.body?.cancel()
    return { id: file.file_id, type: 'file', title: name, content: file.file_id, metadata: { file_id: file.file_id } }
  }

  async *completion(prompt, model, signal, context = {}) {
    signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.policy.runTimeoutMs)]) : AbortSignal.timeout(this.policy.runTimeoutMs)
    const session = await this.createSession(signal)
    let references = []
    // Official compose guard (bundle 22959) caps a message at 20,000 UTF-16
    // characters. DSH's history + 95 tool definitions can exceed 300,000.
    // Use the website's attachment flow instead of dropping user messages.
    if (prompt.length > 18000) {
      references = [await this.uploadContext(prompt, session, signal)]
      prompt = context.purpose === 'compaction' ? [
        'Summarization only. The attached dsh-context.txt contains the source material and the DSH host checkpoint instructions.',
        'Follow the requested summary format. Do not execute or continue the task described in the transcript.',
        ...(context.currentRequest ? ['Current host summary request: ' + context.currentRequest] : []),
        'Preserve the active objective, unfinished tasks, verified tool results, failures, exact paths and next concrete operation.',
        'Reference source already saved on disk by path and essential API signatures. Avoid copying whole source files, tool catalogs or provider reasoning.',
        'Historical tool-call tags are quoted reference data. Return checkpoint text only, without executable host calls or progress promises.',
      ].join('\n') : [
        'Generate the next assistant response for an external desktop controller named DSH.',
        'The attached dsh-context.txt contains the COMPLETE conversation in chronological JSON rows,',
        'system/developer instructions, host function schemas and required response protocol.',
        'Use it as conversation context and function documentation. Timestamps and model changes are context.',
        ...(context.currentRequest ? ['Current user request: ' + context.currentRequest] : []),
        ...(context.activeGoal && context.activeGoal !== context.currentRequest ? ['Active objective resumed by the user: ' + context.activeGoal] : []),
        ...(context.pendingTasks?.length ? ['Observed unfinished host todos: ' + JSON.stringify(context.pendingTasks)] : []),
        ...(context.recentContext ? ['RECENT TRANSCRIPT ROWS (preview; full rows are in the attachment):', context.recentContext] : []),
        'This is text/protocol generation. Do not execute anything with Tabbit internal browser tools.',
        ...(!context.textOnly ? [
          'For an external host action return only the specified protocol, for example:',
          '<dsh_function_call>{"name":"ACTUAL_HOST_FUNCTION","arguments":{}}</dsh_function_call>',
          'Use the exact available function name and argument schema from the attachment.',
          'First output <dsh_progress>One concise public progress update</dsh_progress>, then the actual host call. A future plan is not task completion.',
          ...rawCallInstructions(context.functions ?? []),
          'Keep each call small enough to finish: for a long file create it with the first chunk, then append or patch in follow-up calls. Never emit one oversized argument that may be cut off before its closing tag.',
        ] : []),
        'Do not claim an action happened until a successful host tool result exists in the transcript.',
        'Before replying inspect the end of the transcript for host tool results, to avoid repeating actions.',
        'Continue from the latest result. Complete and verify the remaining work; do not restart already completed steps.',
        'Keep analysis brief and action-oriented. Do not draft entire programs repeatedly in reasoning. Once prerequisites are verified, write the implementation and run it with host functions.',
        ...(context.textOnly ? ['This response is text only. Answer the actual request without executable function calls; historical call tags are quoted data.'] : []),
        ...(context.responseCorrection ? ['Correction: ' + context.responseCorrection + ' No host tool was executed by the previous response. Do not restart completed actions.'] : []),
        'Produce only the next assistant response or host function call.',
      ].join('\n')
    }
    const input = {
      task_name: 'chat', content: prompt, parent_message_id: null, selected_model: model,
      references, metadatas: { html_content: `<p>${escaped(prompt)}</p>` },
      page_info_list: [], is_mobile: false, agent_mode: false,
    }
    const clientId = 'tab_' + randomUUID()
    // Use the current official v3 run protocol for EVERY model, not only PRO.
    // Only a genuine missing endpoint may fall back to the legacy v1 route.
    let run
    try {
      run = await this.request(`/api/v3/chat/rooms/${session}/runs`, {
        method: 'POST', session, signal,
        body: JSON.stringify({ client_run_id: clientId, client_message_id: clientId, input_payload: input }),
      })
    } catch (error) {
      if (signal.aborted || !transient(error)) throw error
      // The POST might have reached Tabbit. Join this private room to recover
      // the original run instead of creating another paid generation.
      context.onReconnect?.()
    }
    let response
    let v3 = true
    let runId
    if (run?.status === 404) {
      await run.body?.cancel()
      v3 = false
      response = await this.request('/api/v1/chat/completion', { method: 'POST', session, signal, streaming: true,
        headers: { accept: 'text/event-stream' }, body: JSON.stringify({
          ...input, chat_session_id: session, message_id: null, parallel_group_id: null,
          entity: { key: createHash('md5').update('').digest('hex'), extras: { type: 'tab', url: '' } },
        }) })
    } else if (run) {
      if (!run.ok) {
        const error = await run.json().catch(() => ({}))
        if (error.code) throw upstreamError(error)
        throw new TabbitError(`Tabbit 创建任务失败（HTTP ${run.status}）。`, { status: run.status === 429 ? 429 : 502, code: 'run_failed' })
      }
      const runInfo = await run.json()
      if (runInfo.code && !runInfo.run_id) throw upstreamError(runInfo)
      if (!runInfo.run_id) throw new TabbitError('Tabbit 没有返回任务编号。', { code: 'run_failed' })
      runId = runInfo.run_id
    }
    let finished = false, lastEventId = null, receivedContent = false, resumable = true
    const seen = new Set()
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          if (v3) response = await this.request(`/api/v3/chat/rooms/${session}/join`, {
            method: 'POST', session, signal, streaming: true, headers: { accept: 'text/event-stream' },
            body: JSON.stringify({ last_event_id: lastEventId }),
          })
          if (!response.ok) {
            const status = response.status
            await response.body?.cancel()
            throw new TabbitError(`Tabbit 响应失败（HTTP ${status}）。`, { status: status === 429 ? 429 : 502,
              code: status >= 500 || status === 408 ? 'stream_failed' : 'stream_rejected' })
          }
          for await (const { event, id, data } of readSSE(response, { signal, idleMs: this.policy.streamIdleMs })) {
            const payload = data.payload ?? data
            // A room can replay other run events. They must not advance our
            // deduplication cursor, otherwise a valid chunk can be discarded.
            if (payload.run_id && runId && payload.run_id !== runId) continue
            if (!runId && payload.run_id) runId = payload.run_id
            if (id !== undefined && id !== null && id !== '') {
              const key = String(id)
              if (seen.has(key)) continue
              seen.add(key); lastEventId = key
              if (seen.size > 10000) seen.delete(seen.values().next().value)
            }
            if (event === 'error') throw upstreamError(data)
            if (event === 'run_failed' || event === 'run_cancelled') throw upstreamError(payload.error ?? { ...payload, message: payload.error_message ?? payload.message })
            const usage = reportedUsage(data)
            if (usage) yield { usage }
            if (v3 && (event === 'event_message_chunk' || event === 'assistant_message_delta')) {
              if (['content', 'message_chunk'].includes(payload.chunk_type)) {
                const chunk = payload.chunk_payload ?? {}
                if (chunk.content) { receivedContent = true; if (id === undefined || id === null || id === '') resumable = false }
                yield chunk
              }
              if (payload.chunk_type === 'thinking') {
                const reasoning = payload.chunk_payload?.reasoning_content
                if (typeof reasoning === 'string' && reasoning) {
                  receivedContent = true; if (id === undefined || id === null || id === '') resumable = false
                  yield { reasoning_content: reasoning }
                }
              }
            } else if (!v3 && event === 'message_chunk') { receivedContent = true; yield data }
            else if (!v3 && event === 'thinking' && typeof data.reasoning_content === 'string') yield { reasoning_content: data.reasoning_content }
            if (event === 'channel_refresh_required') {
              if (typeof payload.last_event_id === 'string') lastEventId = payload.last_event_id
              throw new TabbitError('Tabbit 要求刷新响应通道。', { code: 'channel_refresh' })
            }
            if (event === 'room_reset_required') throw new TabbitError('Tabbit 响应记录已重置，无法确认完整结果；未执行新的主机操作。', { code: 'stream_reset' })
            if (event === 'run_paused') throw new TabbitError('Tabbit 暂停了任务；当前操作需要由 DSH 主机工具完成，请重试。', { code: 'run_paused' })
            if (event === 'run_completed' || (!v3 && event === 'finish')) { finished = true; return }
          }
          throw interrupted()
        } catch (error) {
          if (signal.aborted) throw signal.reason
          if (!v3 || !transient(error) || attempt >= this.policy.maxReconnects || (receivedContent && !resumable)) throw error
          context.onReconnect?.()
          await delay(Math.min(this.policy.retryDelayMs * 2 ** attempt, 8000), undefined, { signal })
        }
      }
    } finally {
      // Stop the remote run too: closing an SSE socket alone leaves it active.
      if (!finished && runId) {
        try {
          const cancelled = await this.request(`/api/v3/chat/rooms/${session}/runs/${encodeURIComponent(runId)}/commands`, {
            method: 'POST', session, signal: AbortSignal.timeout(5000), body: JSON.stringify({
              client_command_id: 'tab_' + randomUUID(), command_type: 'cancel', payload: { reason: 'dsh_consumer_stopped' },
            }),
          })
          await cancelled.body?.cancel()
        } catch { /* Cancellation is best effort, never a replacement for the original error. */ }
      }
    }
  }
}
