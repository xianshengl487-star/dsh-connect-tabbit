/**
 * The loopback shim.
 *
 * `PiAiAdapter` drives providers through pi-ai's OpenAI-completions API, and
 * tabbit2api already speaks that dialect — so unlike the Qoder bundle there is
 * nothing to translate. The shim exists for three other reasons:
 *
 * 1. **The gateway key stays out of pi-ai.** pi-ai only ever sees a per-process
 *    random secret bound to an ephemeral loopback port.
 * 2. **One stable base URL.** The gateway can be restarted, moved, or started
 *    after DSH; the model list does not have to be rebuilt when it does.
 * 3. **One place to decide retryability.** A gateway that is down becomes a
 *    503, which DSH retries, instead of a 500 that ends the turn.
 *
 * @module dsh-connect-tabbit/shim
 */
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { TabbitError, messageOf } from './errors.js'

/** Reject anything that is not addressed to the loopback interface. */
function hostIsLoopback(host) {
  if (typeof host !== 'string') return false
  const name = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

/** Reject any request that claims a non-loopback origin. */
function originIsLoopback(origin) {
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  try {
    const host = new URL(origin).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

/** Write one JSON body. */
function writeJson(res, status, value) {
  const payload = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Write one OpenAI-shaped error body. */
function writeError(res, status, code, message) {
  writeJson(res, status, { error: { message, type: code, code } })
}

/**
 * Ceiling for one completion request.
 *
 * pi-ai sends the whole conversation each turn, so this is deliberately
 * generous — but it is not unbounded, because the body is buffered in full
 * before it is forwarded, and an unbounded read is how a misbehaving peer
 * turns into an out-of-memory crash rather than a 413.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * Read a request body fully.
 *
 * The ceiling is enforced by *dropping* bytes rather than aborting: an aborted
 * socket resets the connection and the caller sees "connection reset" instead of
 * a status it can act on. The refusal is reported once the body has been
 * drained, which also keeps Node from destroying the socket on its own — a
 * server that answers before consuming the request gets the connection torn
 * down underneath the response.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let refused = false
    req.on('data', (chunk) => {
      if (refused) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        refused = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (refused) {
        reject(new TabbitError('请求体过大', { status: 413, code: 'body_too_large' }))
        return
      }
      resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

/**
 * Start one region's shim.
 *
 * @param options.gateway - the region's {@link GatewayClient}.
 * @param options.resolveModels - `() => model[]`, the live catalog.
 * @param options.resolveEnabledIds - `() => string[]`, the allow-list. Read per
 *   request so a settings change reaches the picker without a restart.
 * @param options.region - the region this shim fronts, for error text.
 * @returns `{ ready, baseUrl, token, close }`.
 */
export function createTabbitShim(options) {
  const { gateway, resolveModels, resolveEnabledIds, region, logger } = options
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /** Constant-time bearer check. */
  function bearerOk(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = Buffer.from(match[1])
    const expected = Buffer.from(SHARED_SECRET)
    if (presented.length !== expected.length) return false
    return timingSafeEqual(presented, expected)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) {
        const status = error instanceof TabbitError ? error.status : 500
        writeError(res, status, error?.code ?? 'internal', messageOf(error))
      } else {
        res.end()
      }
    })
  })

  const ready = new Promise((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  server.listen(0, '127.0.0.1')

  const baseUrl = () => {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('tabbit shim has no listening address')
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req, res) {
    if (!hostIsLoopback(req.headers.host)) {
      writeError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
      return
    }
    if (!originIsLoopback(req.headers.origin)) {
      writeError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
      return
    }
    if (!bearerOk(req)) {
      writeError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
      return
    }
    const url = req.url ?? '/'
    if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
      writeJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
      // The picker's discovery reads this endpoint, so it must narrow the
      // catalog exactly the way the adapter does; otherwise an unchecked model
      // stays visible in one surface after being hidden in the other.
      const enabled = typeof resolveEnabledIds === 'function' ? resolveEnabledIds() : undefined
      const list = Array.isArray(enabled) && enabled.length > 0 ? new Set(enabled) : undefined
      const data = (resolveModels() ?? [])
        .filter((model) => list === undefined || list.has(model.id))
        .map((model) => ({ id: model.id, object: 'model', created: 0, owned_by: region.id }))
      writeJson(res, 200, { object: 'list', data })
      return
    }
    if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
      try {
        await options.beforeChat?.()
      } catch (error) {
        writeError(res, error.status ?? 400, error.code ?? 'account_pool_empty', messageOf(error))
        return
      }
      await chatCompletions(req, res)
      return
    }
    writeError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
  }

  async function chatCompletions(req, res) {
    let raw
    try {
      raw = await readBody(req)
    } catch (error) {
      // A refused body is answered with its own status (413), not folded into
      // "your JSON is broken".
      const status = error instanceof TabbitError ? error.status : 400
      writeError(res, status, error?.code ?? 'invalid_request', messageOf(error))
      return
    }
    let body
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch (error) {
      writeError(res, 400, 'invalid_request', `body is not JSON: ${messageOf(error)}`)
      return
    }

    // The caller's own abort (DSH cancels a turn) must reach the gateway,
    // otherwise a cancelled turn keeps a Tabbit room busy upstream.
    const controller = new AbortController()
    req.on('aborted', () => controller.abort())
    res.on('close', () => { if (!res.writableEnded) controller.abort() })

    let upstream
    try {
      upstream = await gateway.chatCompletions(body, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) {
        res.destroy()
        return
      }
      const status = error instanceof TabbitError ? error.status : 502
      const code = error?.code ?? 'upstream_error'
      if (error?.retryable === true) {
        logger?.warn?.(`dsh-connect-tabbit: ${region.displayName} 上游暂不可用，回 503 让 DSH 重试：${messageOf(error)}`)
      } else {
        logger?.warn?.(`dsh-connect-tabbit: ${region.displayName} 请求失败：${messageOf(error)}`)
      }
      writeError(res, status, code, messageOf(error))
      return
    }

    // Pass the upstream status and content type through unchanged: tabbit2api
    // already answers in the shape pi-ai expects, and rewriting it here is how
    // a stream loses its framing.
    const headers = {}
    const contentType = upstream.headers.get('content-type')
    if (contentType !== null) headers['Content-Type'] = contentType
    const cacheControl = upstream.headers.get('cache-control')
    if (cacheControl !== null) headers['Cache-Control'] = cacheControl
    res.writeHead(upstream.status, headers)

    if (upstream.body === null) {
      res.end()
      return
    }
    const stream = Readable.fromWeb(upstream.body)
    stream.on('error', (error) => {
      logger?.warn?.(`dsh-connect-tabbit: ${region.displayName} 转发流中断：${messageOf(error)}`)
      res.destroy()
    })
    res.on('close', () => {
      if (!stream.destroyed) stream.destroy()
    })
    stream.pipe(res)
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () =>
      new Promise((resolve, reject) => {
        server.close(() => resolve())
        server.closeAllConnections()
        server.once('error', reject)
      }),
  }
}
