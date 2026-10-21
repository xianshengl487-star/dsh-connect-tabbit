import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readModelCatalog, parseTokenValue } from '../tabbit.js'
import { TabbitError } from '../errors.js'
import { TabbitUpstream } from './upstream.js'
import { activeFunctions, buildPrompt, parseResponse, reportedUsage, recentContext } from './protocol.js'
import { UsageLedger, measuredUsage } from './usage.js'
import { progressBlocks } from './host-protocol.js'
import { taskContext, mustContinue } from './task-state.js'

const equal = (a, b) => {
  const x = Buffer.from(typeof a === 'string' ? a : ''), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
const json = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}
const errorBody = error => ({ error: { message: error.message, type: error.code ?? 'upstream_error', code: error.code ?? 'upstream_error' } })
const masked = row => ({ id: row.id, name: row.name, enabled: row.enabled, status: row.status,
  value_preview: row.value.slice(0, 8) + '…', total_requests: row.total_requests, error_count: row.error_count,
  last_used_at: row.last_used_at, added_at: row.added_at })
async function readJSON(req) {
  let length = 0
  const chunks = []
  for await (const chunk of req) {
    length += chunk.length
    if (length > 8 * 1024 * 1024) throw new TabbitError('请求内容超过 8 MB。', { status: 413, code: 'body_too_large' })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw new TabbitError('请求不是有效的 JSON。', { status: 400, code: 'bad_json' }) }
}

/** A region's private, in-process OpenAI gateway, disposed with the plugin. */
export async function createEmbeddedGateway({ region, origin = region.defaultTabbitUrl, logger, upstreamFactory, catalogReader = readModelCatalog,
  usagePath, heartbeatMs = 10000 }) {
  const apiKey = randomBytes(32).toString('base64url')
  const adminPassword = randomBytes(32).toString('base64url')
  const adminToken = randomBytes(32).toString('base64url')
  const tokens = new Map()
  const inflight = new Set()
  const logs = []
  const ledger = new UsageLedger({ path: usagePath, logger })
  let reconnects = 0
  let models = []
  let catalogAt = 0
  let fetchingCatalog
  let index = 0, total = 0, success = 0
  let closed = false

  const refreshModels = async () => {
    if (fetchingCatalog) return fetchingCatalog
    const token = [...tokens.values()].find(row => row.enabled)
    if (!token) return models
    fetchingCatalog = (async () => {
      const rows = await catalogReader({ origin, token: parseTokenValue(token.value) })
      if (!rows.length) throw new TabbitError('Tabbit 模型目录为空。', { code: 'catalog_empty' })
      models = rows.map(row => ({
        id: row.id, object: 'model', name: row.name, description: row.description,
        max_tokens: 100000, supports_vision: row.supportsVision, supports_streaming: true,
        access_type: row.accessType, display_multiplier: row.usageMultiplier,
        reasoning: row.reasoning, owned_by: 'tabbit',
      }))
      catalogAt = Date.now()
      return models
    })()
    try { return await fetchingCatalog } finally { fetchingCatalog = undefined }
  }

  async function complete(req, res, body) {
    const functions = activeFunctions(body.tools, body.tool_choice)
    const prompt = buildPrompt(body.messages, functions, body.tool_choice)
    const task = taskContext(body.messages)
    logger?.info?.(`dsh-connect-tabbit: model=${body.model || 'best'} messages=${body.messages.length} functions=${functions.length} chars=${prompt.length} context=${prompt.length > 18000 ? 'attachment' : 'inline'}`)
    const enabled = [...tokens.values()].filter(row => row.enabled && row.status !== 'expired' && (!row.cooldownUntil || row.cooldownUntil <= Date.now()))
    if (!enabled.length) throw new TabbitError('这个版本没有可用的账号，请先登录或启用账号。', { status: 409, code: 'account_pool_empty' })
    const token = enabled[index++ % enabled.length]
    if (!models.length) await refreshModels()
    else if (Date.now() - catalogAt > 30 * 60000) {
      try { await refreshModels() } catch { logger?.warn?.('Tabbit 模型目录暂时无法更新，本轮继续使用已验证的目录。') }
    }
    const model = models.find(row => row.id === (body.model || 'best'))
    if (!model) throw new TabbitError('当前账号没有这个模型，请刷新模型列表后重新选择。', { status: 400, code: 'model_not_available' })
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(new DOMException('Tabbit 本轮生成超过 20 分钟。', 'TimeoutError')), 20 * 60000)
    deadline.unref?.()
    inflight.add(controller)
    const cancel = () => { if (!res.writableEnded) controller.abort() }
    req.once('aborted', cancel)
    res.once('close', cancel)
    const id = 'chatcmpl-' + randomUUID().replaceAll('-', '')
    const base = { id, created: Math.floor(Date.now() / 1000), model: model.id }
    const sse = data => { if (!res.destroyed) res.write('data: ' + JSON.stringify(data) + '\n\n') }
    const chunk = (delta, reason = null, usage) => sse({ ...base, object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: reason }], ...(usage ? { usage } : {}) })
    const start = Date.now()
    let failure
    let heartbeat
    try {
      const upstream = upstreamFactory ? upstreamFactory(token) : new TabbitUpstream({ value: token.value, origin })
      // Nothing is marked successful until a terminal upstream event and valid
      // host protocol have both arrived. In particular, no fake zero usage.
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
        chunk({ role: 'assistant', content: '' })
        heartbeat = setInterval(() => { if (!res.destroyed) res.write(': dsh-tabbit keepalive\n\n') }, heartbeatMs)
        heartbeat.unref?.()
      }
      let parsed, usage, measurement, repair, attempt, formatFixes = 0, continuationFixes = 0
      const emittedProgress = []
      let reasoning = ''
      for (attempt = 0; attempt < 5; attempt++) {
        let text = '', attemptReasoning = '', attemptError, retrying = false, progressCursor = 0
        parsed = undefined
        usage = undefined
        const attemptPrompt = repair ? prompt + '\nHOST CORRECTION: ' + repair
          + '\nNo host tool was executed. Produce an actual next host call. For code use named call envelopes with CDATA strings. Do not repeat an action already confirmed by a tool result.' : prompt
        try {
          for await (const data of upstream.completion(attemptPrompt, model.name, controller.signal, {
            currentRequest: task.current, activeGoal: task.goal, pendingTasks: task.pending,
            recentContext: recentContext(body.messages, 5000), textOnly: !functions.length, functions,
            responseCorrection: repair,
            onReconnect: () => { reconnects++ },
          })) {
            usage = reportedUsage(data) ?? usage
            if (typeof data.reasoning_content === 'string') {
              attemptReasoning += data.reasoning_content
              reasoning += data.reasoning_content
              if (reasoning.length > 4 * 1024 * 1024) throw new TabbitError('Tabbit 推理输出过大。', { code: 'response_too_large' })
              if (body.stream) chunk({ reasoning_content: data.reasoning_content })
            }
            if (typeof data.content === 'string') {
              text += data.content
              if (text.length > 4 * 1024 * 1024) throw new TabbitError('Tabbit 输出过大。', { code: 'response_too_large' })
              if (body.stream && !functions.length) chunk({ content: data.content })
              if (functions.length) for (const progress of progressBlocks(text)) {
                if (progress.end <= progressCursor) continue
                progressCursor = progress.end
                if (progress.text && emittedProgress.at(-1) !== progress.text) {
                  emittedProgress.push(progress.text)
                  if (body.stream) chunk({ content: progress.text + '\n\n' })
                }
              }
            }
          }
          parsed = parseResponse(text, functions, body.tool_choice, body.parallel_tool_calls !== false)
          if (functions.length && mustContinue(parsed, task)) {
            throw new TabbitError('任务仍有未完成事项，本轮只返回了进度说明而没有下一步工具调用。', { status: 400, code: 'task_incomplete' })
          }
        } catch (error) {
          attemptError = error
          // Calls are still buffered, so nothing has run on the host. Correct
          // malformed responses within the budget; never replay an emitted call.
          if (!functions.length || controller.signal.aborted) throw error
          if (error.code === 'tool_protocol_error' && formatFixes < 2) {
            formatFixes++
            logger?.warn?.(`dsh-connect-tabbit: tool format correction ${formatFixes}/2: ${error.message}`)
            repair = error.message + ' Use CDATA for each code/string argument instead of quoting it inside JSON.'
          } else if (error.code === 'task_incomplete' && continuationFixes < 2) {
            continuationFixes++
            repair = 'The host todo list still contains unfinished work. Your last output was only a progress update: '
              + JSON.stringify(text.slice(0, 700)) + '. Continue the original requested deliverable now with an actual host call. '
              + 'Do not probe an already-known environment again. If genuinely blocked, return dsh_task_status blocked with the observed reason.'
          } else throw error
          retrying = true
          parsed = undefined
        } finally {
          measurement = measuredUsage(attemptPrompt, attemptReasoning + text, usage)
          ledger.record({ id, attempt: attempt + 1, model: model.id, at: new Date().toISOString(),
            status: controller.signal.aborted ? 'cancelled' : retrying ? 'retrying' : attemptError ? 'failed' : 'success',
            reasoningChars: attemptReasoning.length, progressUpdates: progressBlocks(text).length,
            ...(attemptError?.code ? { errorCode: attemptError.code } : {}), usage: measurement })
        }
        if (parsed) break
      }
      if (!parsed) throw new TabbitError('任务仍未完成，已达到本轮自动修正上限；没有将未完成任务标为成功。', { status: 400, code: 'task_incomplete' })
      const { message, reason } = parsed
      if (!message.content && ['blocked', 'needs_input'].includes(parsed.taskStatus?.state)) message.content = parsed.taskStatus.reason
      const nonstreamMessage = { ...message,
        ...(functions.length && emittedProgress.length ? { content: [...emittedProgress, message.content].filter(Boolean).join('\n\n') } : {}),
        ...(reasoning ? { reasoning_content: reasoning } : {}),
      }
      if (body.stream) {
        if (functions.length) {
          if (message.content) chunk({ content: message.content })
          if (message.tool_calls) chunk({ tool_calls: message.tool_calls.map((call, i) => ({ ...call, index: i })) })
        }
        // OpenAI usage remains official-only. The explicit extension and card
        // expose estimates without converting them into a fake zero-cost bill.
        sse({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: reason }],
          ...(usage ? { usage } : {}), dsh_usage: { ...measurement, attempts: attempt + 1 } })
        res.end('data: [DONE]\n\n')
      } else json(res, 200, { ...base, object: 'chat.completion', choices: [{ index: 0, message: nonstreamMessage, finish_reason: reason }], ...(usage ? { usage } : {}),
        dsh_usage: { ...measurement, attempts: attempt + 1 } })
      token.status = 'active'; token.error_count = 0; token.cooldownUntil = undefined
      success++
    } catch (error) {
      failure = error
      // Rejected requests, protocol errors and cancellation do not poison the
      // account pool. Only actual auth failures or rate limits alter availability.
      if (error.code === 'tabbit_unauthorized') token.status = 'expired'
      if (error.status === 429) { token.status = 'cooldown'; token.cooldownUntil = Date.now() + 30000 }
      if (!controller.signal.aborted) token.error_count++
      if (res.headersSent) { sse(errorBody(error)); res.end('data: [DONE]\n\n') }
      else throw error
    } finally {
      clearInterval(heartbeat)
      clearTimeout(deadline)
      total++; token.total_requests++; token.last_used_at = new Date().toISOString()
      inflight.delete(controller)
      req.off('aborted', cancel); res.off('close', cancel)
      logs.unshift({ model: model.id, token_name: token.name, status: failure ? 'error' : 'success',
        error: failure?.message ?? '', duration: (Date.now() - start) / 1000 })
      logs.length = Math.min(logs.length, 50)
    }
  }

  async function handle(req, res) {
    const host = req.headers.host ?? ''
    if (!/^127\.0\.0\.1:\d+$/.test(host) || req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'local service only' })
    const path = new URL(req.url, `http://${host}`).pathname
    if (path === '/health' && req.method === 'GET') return json(res, 200, { status: 'healthy', service: 'DSH Tabbit embedded gateway', region: region.id })
    if (path === '/api/admin/login' && req.method === 'POST') {
      // Possession of the private proxy secret is required even at login.
      if (!equal(req.headers.authorization, 'Bearer ' + apiKey)) return json(res, 401, { error: 'unauthorized' })
      if (!equal((await readJSON(req)).password, adminPassword)) return json(res, 401, { error: 'unauthorized' })
      return json(res, 200, { token: adminToken })
    }
    const isAdmin = path.startsWith('/api/admin/')
    if (!equal(req.headers.authorization, 'Bearer ' + (isAdmin ? adminToken : apiKey))) return json(res, 401, { error: 'unauthorized' })
    if (path === '/v1/models' && req.method === 'GET') {
      if (!models.length && tokens.size) await refreshModels()
      return json(res, 200, { object: 'list', data: models })
    }
    if (path === '/v1/chat/completions' && req.method === 'POST') return complete(req, res, await readJSON(req))
    if (path === '/api/admin/status' && req.method === 'GET') return json(res, 200, {
      total_requests: total, total_success: success, total_errors: total - success,
      success_rate: total ? Math.round(success / total * 1000) / 10 : 0,
      total_tokens: tokens.size, active_tokens: [...tokens.values()].filter(row => row.enabled && row.status !== 'expired' && (!row.cooldownUntil || row.cooldownUntil <= Date.now())).length,
      recent_logs: logs,
      token_usage: { ...ledger.snapshot(), inflight: inflight.size, reconnects },
    })
    if (path === '/api/admin/tokens' && req.method === 'GET') return json(res, 200, { tokens: [...tokens.values()].map(masked) })
    if (path === '/api/admin/tokens' && req.method === 'POST') {
      const body = await readJSON(req)
      if (typeof body.value !== 'string' || !body.value.trim() || body.value.length > 48000) throw new TabbitError('账号凭据格式不正确。', { status: 400, code: 'invalid_token' })
      const id = randomUUID()
      tokens.set(id, { id, name: String(body.name ?? ''), value: body.value, enabled: body.enabled !== false,
        status: 'unknown', total_requests: 0, error_count: 0, added_at: new Date().toISOString() })
      return json(res, 200, { id })
    }
    const match = /^\/api\/admin\/tokens\/([^/]+)(\/test)?$/.exec(path)
    if (match) {
      const token = tokens.get(decodeURIComponent(match[1]))
      if (!token) return json(res, 404, { error: 'account not found' })
      if (match[2] && req.method === 'POST') {
        await catalogReader({ origin, token: parseTokenValue(token.value) })
        token.status = 'active'; token.error_count = 0; token.cooldownUntil = undefined
        return json(res, 200, { ok: true })
      }
      if (!match[2] && req.method === 'DELETE') { tokens.delete(token.id); return json(res, 200, { ok: true }) }
      if (!match[2] && req.method === 'PUT') {
        const body = await readJSON(req)
        if (body.value !== undefined) {
          if (typeof body.value !== 'string' || !body.value.trim() || body.value.length > 48000) throw new TabbitError('账号凭据格式不正确。', { status: 400, code: 'invalid_token' })
          token.value = body.value
        }
        if (typeof body.name === 'string') token.name = body.name
        if (typeof body.enabled === 'boolean') token.enabled = body.enabled
        token.status = 'unknown'; token.error_count = 0; token.cooldownUntil = undefined
        return json(res, 200, { ok: true })
      }
    }
    if (path === '/api/admin/test-models' && req.method === 'POST') {
      await refreshModels()
      return json(res, 200, { ok: true, total_models_count: models.length })
    }
    return json(res, 404, { error: 'not found' })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(error => {
      if (res.destroyed) return
      if (!res.headersSent) json(res, error.status ?? 500, errorBody(error))
      else res.end()
    })
  })
  server.requestTimeout = 0
  server.headersTimeout = 15000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  server.unref()
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  logger?.info?.(`dsh-connect-tabbit: ${region.displayName} 内置网关已启动 ${baseUrl}`)
  return {
    baseUrl, apiKey, adminPassword,
    close: async () => {
      if (closed) return
      closed = true
      for (const controller of inflight) controller.abort()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      tokens.clear(); models = []; logs.length = 0
    },
  }
}
