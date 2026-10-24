/**
 * The tabbit2api gateway client.
 *
 * tabbit2api (https://github.com/hoinata/tabbit2api) is a FastAPI service that
 * turns Tabbit's web endpoints into OpenAI- and Claude-compatible APIs. It owns
 * the account pool (it calls them "tokens"), the model catalog, and the session
 * cache. By default this service now runs inside the plugin; an external
 * tabbit2api can still be selected through gatewayMode: external.
 *
 * Two independent surfaces are used:
 *
 * - **Proxy surface** (`/v1/*`) — OpenAI-compatible. Bearer is the gateway's
 *   own optional `api_key`, not a Tabbit credential.
 * - **Admin surface** (`/api/admin/*`) — JSON, JWT-authenticated with the panel
 *   password (default `admin`). This is where the pool lives.
 *
 * Credentials live in AccountStore. The built-in gateway keeps only an
 * in-memory execution copy, and list endpoints return masked previews.
 *
 * @module dsh-connect-tabbit/gateway
 */
import { TabbitError, fromGatewayStatus, gatewayUnreachable, badJson } from './errors.js'
import { validContextWindow } from './model-context.js'

/**
 * The two Tabbit editions, modelled as independent regions.
 *
 * They are separate providers in DSH because they are separate accounts with
 * separate quotas: the CN edition bills against `web.tabbit.com`, the global
 * edition against `web.tabbit.ai`. A user may run one gateway for each, so each
 * region carries its own gateway URL.
 */
export const REGIONS = [
  {
    id: 'tabbit-cn',
    configKey: 'cn',
    displayName: 'Tabbit 国内版',
    defaultGatewayUrl: 'http://127.0.0.1:8800',
    defaultTabbitUrl: 'https://web.tabbit.com',
  },
  {
    id: 'tabbit-global',
    configKey: 'global',
    displayName: 'Tabbit 国际版',
    defaultGatewayUrl: 'http://127.0.0.1:8801',
    defaultTabbitUrl: 'https://web.tabbit.ai',
  },
]

/** Default request budget for a control-plane call. */
const CONTROL_TIMEOUT_MS = 15000

/** How long a model listing is trusted before it is refetched. */
const MODELS_TIMEOUT_MS = 20000

/**
 * Strip a trailing slash so `${base}/v1/models` never becomes `//v1/models`.
 *
 * The gateway is happy either way, but a doubled slash makes the paths in log
 * lines and error messages hard to read.
 */
export function normalizeBaseUrl(value, fallback) {
  const text = typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  return text.replace(/\/+$/, '')
}

/**
 * Decode a JWT payload without verifying it.
 *
 * The admin token is issued by the gateway and only ever presented back to it,
 * so signature verification would prove nothing here; the payload is read for
 * its `exp` alone, to know when to log in again instead of waiting for a 401.
 */
function jwtExpiryMs(token) {
  if (typeof token !== 'string') return 0
  const parts = token.split('.')
  if (parts.length < 2) return 0
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const exp = Number(payload?.exp)
    return Number.isFinite(exp) ? exp * 1000 : 0
  } catch {
    return 0
  }
}

/** One gateway instance. */
export class GatewayClient {
  /**
   * @param options.baseUrl - gateway root, e.g. `http://127.0.0.1:8800`.
   * @param options.apiKey - the gateway's own `api_key` (may be empty).
   * @param options.adminPassword - admin panel password.
   * @param options.region - the region this gateway serves, for error text.
   */
  constructor(options) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl, options.region?.defaultGatewayUrl ?? 'http://127.0.0.1:8800')
    this.apiKey = typeof options.apiKey === 'string' ? options.apiKey : ''
    this.adminPassword = typeof options.adminPassword === 'string' && options.adminPassword !== '' ? options.adminPassword : 'admin'
    this.region = options.region
    /** Cached admin JWT and the moment it stops being usable. */
    this.adminToken = undefined
    this.adminTokenExpiresAt = 0
  }

  /** A short label for error messages. */
  get label() {
    return this.region?.displayName ?? this.baseUrl
  }

  /** Absolute URL for one gateway path. */
  url(path) {
    return `${this.baseUrl}${path}`
  }

  /**
   * One HTTP call with a timeout.
   *
   * `AbortSignal.timeout` is used rather than a manual timer so the socket is
   * released even when the caller's own signal never fires.
   */
  async request(path, init = {}) {
    const { timeoutMs = CONTROL_TIMEOUT_MS, ...rest } = init
    // A completion carries its own budget from the caller, so `timeoutMs: 0`
    // means "no deadline of our own" rather than "abort immediately".
    const signal = rest.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined)
    let response
    try {
      response = await fetch(this.url(path), {
        ...rest,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      // A caller-initiated abort must not be rewritten as "gateway down": DSH
      // aborts the turn when the user cancels, and that is not a gateway fault.
      if (rest.signal?.aborted === true) throw error
      throw gatewayUnreachable(this.baseUrl, error)
    }
    return response
  }

  /** Read a JSON body, or throw a mapped error. */
  async json(response, what) {
    const text = await response.text()
    if (!response.ok) throw fromGatewayStatus(response.status, text)
    if (text === '') return {}
    try {
      return JSON.parse(text)
    } catch (error) {
      throw badJson(`${this.label} 的${what}响应`, error)
    }
  }

  /**
   * Whether the gateway is answering.
   *
   * `GET /health` is the documented liveness probe. Some deployments answer it
   * with `{"status":"ok"}` and others with a bare 200, so only the status code
   * is trusted.
   */
  async health() {
    const response = await this.request('/health', { timeoutMs: 5000 })
    return { ok: response.ok, status: response.status }
  }

  /** The OpenAI-compatible model catalog, with tabbit2api's extra metadata. */
  async listModels() {
    const response = await this.request('/v1/models', {
      timeoutMs: MODELS_TIMEOUT_MS,
      headers: this.proxyHeaders(),
    })
    const body = await this.json(response, '模型列表')
    const data = Array.isArray(body?.data) ? body.data : []
    return data
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '')
      .map((entry) => ({
        id: entry.id,
        name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
        description: typeof entry.description === 'string' ? entry.description : '',
        // tabbit2api publishes the context ceiling as `max_tokens`.
        contextWindow: validContextWindow(entry.context_window) ?? validContextWindow(entry.max_tokens) ?? 0,
        contextSource: typeof entry.context_source === 'string' ? entry.context_source : 'gateway',
        maxTokens: validContextWindow(entry.context_window) ?? validContextWindow(entry.max_tokens) ?? 0,
        supportsVision: entry.supports_vision === true,
        supportsStreaming: entry.supports_streaming !== false,
        // `free_unlimited` | `free_metered` | `premium_only`
        accessType: typeof entry.access_type === 'string' ? entry.access_type : 'free_metered',
        usageMultiplier: typeof entry.display_multiplier === 'number' && Number.isFinite(entry.display_multiplier) && entry.display_multiplier >= 0 ? entry.display_multiplier : undefined,
        reasoning: typeof entry.reasoning === 'boolean' ? entry.reasoning : undefined,
        ownedBy: typeof entry.owned_by === 'string' ? entry.owned_by : 'tabbit',
      }))
  }

  /** Headers for the proxy surface. */
  proxyHeaders() {
    const headers = { accept: 'application/json' }
    if (this.apiKey !== '') headers.authorization = `Bearer ${this.apiKey}`
    return headers
  }

  /**
   * Log in to the admin surface and cache the JWT.
   *
   * The expiry is read from the token itself so a long-running host refreshes
   * *before* the first 401 rather than on it. A gateway that issues an
   * opaque token (no decodable `exp`) is re-logged-in on every 401 instead.
   */
  async ensureAdminToken(force = false) {
    if (!force && this.adminToken !== undefined && (this.adminTokenExpiresAt === 0 || Date.now() < this.adminTokenExpiresAt - 30000)) {
      return this.adminToken
    }
    const response = await this.request('/api/admin/login', {
      method: 'POST',
      headers: { ...this.proxyHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ password: this.adminPassword }),
    })
    if (response.status === 401) {
      throw new TabbitError(`${this.label} 网关管理密码不正确（默认 admin，可在 tabbit2api 管理面板修改）`, {
        status: 401,
        code: 'admin_unauthorized',
      })
    }
    const body = await this.json(response, '管理登录')
    const token = body?.token
    if (typeof token !== 'string' || token === '') {
      throw new TabbitError(`${this.label} 网关没有返回管理令牌`, { status: 502, code: 'admin_login_failed' })
    }
    this.adminToken = token
    this.adminTokenExpiresAt = jwtExpiryMs(token)
    return token
  }

  /** One authenticated admin call. */
  async admin(path, init = {}) {
    const token = await this.ensureAdminToken()
    const response = await this.request(path, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    })
    if (response.status === 401) {
      // The cached token was rejected — it may have expired early or the panel
      // password changed. One retry with a fresh login keeps a rotating secret
      // from turning into a permanently broken panel.
      this.adminToken = undefined
      const retried = await this.request(path, {
        ...init,
        headers: {
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          authorization: `Bearer ${await this.ensureAdminToken(true)}`,
          ...(init.headers ?? {}),
        },
      })
      return this.json(retried, '管理接口')
    }
    return this.json(response, '管理接口')
  }

  /** Gateway counters and recent log lines. */
  async adminStatus() {
    return this.admin('/api/admin/status')
  }

  /**
   * The account pool, as the gateway sees it.
   *
   * `value_preview` is what the gateway returns instead of the credential, so
   * the card can show which account a row is without ever holding the secret.
   */
  async listTokens() {
    const body = await this.admin('/api/admin/tokens')
    const tokens = Array.isArray(body?.tokens) ? body.tokens : []
    return tokens.map((token) => ({
      id: String(token?.id ?? ''),
      name: typeof token?.name === 'string' ? token.name : '',
      enabled: token?.enabled !== false,
      status: typeof token?.status === 'string' ? token.status : 'unknown',
      preview: typeof token?.value_preview === 'string' ? token.value_preview : '',
      addedAt: typeof token?.added_at === 'string' ? token.added_at : undefined,
      lastUsedAt: typeof token?.last_used_at === 'string' ? token.last_used_at : undefined,
      totalRequests: Number(token?.total_requests) || 0,
      errorCount: Number(token?.error_count) || 0,
    }))
  }

  /** Add one account to the pool. */
  async addToken({ name, value, enabled = true }) {
    const body = await this.admin('/api/admin/tokens', {
      method: 'POST',
      body: JSON.stringify({ name, value, enabled }),
    })
    return { id: String(body?.id ?? '') }
  }

  /** Patch one account. */
  async updateToken(id, patch) {
    await this.admin(`/api/admin/tokens/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
    return { ok: true }
  }

  /** Remove one account. */
  async deleteToken(id) {
    await this.admin(`/api/admin/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return { ok: true }
  }

  /**
   * Probe one account by opening a Tabbit chat session.
   *
   * This is the gateway's own liveness test for a credential, and it is the
   * only way to tell a dead cookie from a merely idle one.
   */
  async testToken(id) {
    const body = await this.admin(`/api/admin/tokens/${encodeURIComponent(id)}/test`, { method: 'POST' })
    return { ok: body?.ok === true, error: typeof body?.error === 'string' ? body.error : undefined }
  }

  /** Ask the gateway to re-read Tabbit's model catalog. */
  async refreshModels() {
    return this.admin('/api/admin/test-models', { method: 'POST' })
  }

  /**
   * Stream one chat completion through the proxy surface.
   *
   * The raw `Response` is returned so the shim can pipe the body without
   * buffering a stream it does not understand; only the status is inspected
   * here, to turn a gateway failure into a typed error before any byte is
   * written to the client.
   */
  async chatCompletions(body, signal) {
    const response = await this.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        ...this.proxyHeaders(),
        'content-type': 'application/json',
        accept: body?.stream === false ? 'application/json' : 'text/event-stream',
      },
      body: JSON.stringify(body),
      // A completion can legitimately run for minutes; the caller's signal is
      // the only budget that applies.
      signal,
      timeoutMs: 0,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw fromGatewayStatus(response.status, text)
    }
    return response
  }
}
