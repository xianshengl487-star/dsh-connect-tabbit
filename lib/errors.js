/**
 * Error vocabulary shared by every module in this bundle.
 *
 * The shim turns an upstream failure into an HTTP status, and DSH decides from
 * that status whether a turn is retried. The distinction that matters is
 * therefore not "what went wrong" but **"would trying again help"**:
 *
 * - `retryable` — the gateway is restarting, a pool account is cooling down, or
 *   upstream rate-limited us. DSH retries a 503, so this becomes a 503.
 * - everything else — a bad model id, a missing account, a rejected key. DSH
 *   refuses to retry a 4xx and the UI shows the message, which is what the user
 *   needs to act on.
 *
 * @module dsh-connect-tabbit/errors
 */

/** A failure that carries the status the shim should answer with. */
export class TabbitError extends Error {
  /**
   * @param message - human-readable cause; surfaced in the DSH turn.
   * @param options.status - HTTP status the shim should answer with.
   * @param options.code - stable machine code, mirrored into the error body.
   * @param options.retryable - whether a retry could plausibly succeed.
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'TabbitError'
    this.status = Number(options.status) || 502
    this.code = options.code ?? 'upstream_error'
    this.retryable = options.retryable === true
  }
}

/**
 * The gateway answered, but with a failure.
 *
 * 429 and 5xx are the gateway's own transient states (rate limit, restarting,
 * upstream 502), so they map to a retryable 503. Everything else keeps its own
 * status so the user sees "401" for a wrong gateway key rather than a generic
 * upstream error.
 */
export function fromGatewayStatus(status, body) {
  const text = typeof body === 'string' ? body.slice(0, 400) : ''
  if (status === 503 && /no available tokens|all cooling down/i.test(text)) {
    return new TabbitError('Tabbit 账号池暂时无可用账号（账号正在冷却）。请查看账号最近的错误，修复后同步账号，或等待冷却结束后重试。', {
      status: 409, code: 'account_pool_cooldown',
    })
  }
  if (status >= 500 && /requires sign-in|renew this account|RSC init error|Session page init error/i.test(text)) {
    return new TabbitError(`Tabbit 会话初始化失败，请重新登录账号或更新网关。${text}`, {
      status: 400, code: 'tabbit_session_failed',
    })
  }
  if (status === 401 || status === 403) {
    return new TabbitError(`tabbit2api 拒绝了网关密钥（HTTP ${status}）${text === '' ? '' : `：${text}`}`, {
      status,
      code: 'gateway_unauthorized',
    })
  }
  if (status === 429 || status >= 500) {
    return new TabbitError(`tabbit2api 暂时不可用（HTTP ${status}）${text === '' ? '' : `：${text}`}`, {
      status: 503,
      code: 'gateway_busy',
      retryable: true,
    })
  }
  return new TabbitError(`tabbit2api 返回 HTTP ${status}${text === '' ? '' : `：${text}`}`, {
    status: 502,
    code: 'gateway_error',
  })
}

/** The gateway could not be reached at all. */
export function gatewayUnreachable(baseUrl, cause) {
  return new TabbitError(`无法连接 tabbit2api 网关 ${baseUrl}：${messageOf(cause)}`, {
    status: 503,
    code: 'gateway_unreachable',
    retryable: true,
  })
}

/** A response body was not the JSON we expect. */
export function badJson(what, cause) {
  return new TabbitError(`${what} 不是合法 JSON：${messageOf(cause)}`, {
    status: 502,
    code: 'bad_json',
  })
}

/** Coerce anything thrown into a readable one-line message. */
export function messageOf(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
