/**
 * Direct Tabbit account APIs, verified against the official web client.
 *
 * ## Why this module talks to Tabbit instead of the gateway
 *
 * tabbit2api proxies *chat completions* only. Credits and check-in are account
 * actions the panel does not model, so a plugin that wants to show "本月剩余
 * 积分" and press "签到" has to reach `web.tabbit.com` itself.
 *
 * ## What is verified and what is not
 *
 * The **request shape** below is taken from tabbit2api's own client, which is
 * the closest thing to a specification Tabbit's private web API has: the
 * `token` cookie carries the JWT, `next-auth.session-token` carries the NextAuth
 * session, the pool entry is `jwt|nextauth|device_id`, and every call needs the
 * `x-chrome-id-consistency-request` header plus a `referer` on the same origin.
 *
 * Official bundle 8136-00c88a16073e70e9.js uses commerce/quota/v1/usage;
 * 30923-35d23d10abd3183a.js requests the model catalog with scene=chat.
 * Usage is a cycle percentage; display_multiplier is a relative quota cost.
 * Neither is a monetary token price. See docs/tabbit-api-evidence.md.
 *
 * @module dsh-connect-tabbit/tabbit
 */
import { randomUUID } from 'node:crypto'
import { TabbitError, messageOf } from './errors.js'

/** The browser identity tabbit2api presents; Tabbit's WAF checks these. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'

/** Chrome-extension client id baked into tabbit2api. */
const DEFAULT_CLIENT_ID = '2dd8eb4c1ed9c344d173'

/** Default probe order for the credit reading. */
export const DEFAULT_CREDITS_PATHS = [
  '/api/commerce/quota/v1/usage?user_id={user_id}&timezone={timezone}',
]

/** Default probe order for "have I checked in today". */
export const DEFAULT_CHECKIN_STATUS_PATHS = [
  '/api/commerce/activity/v1/sign-in/status?scene_codes=desktop_pet',
]

/** Default probe order for claiming the daily check-in. */
export const DEFAULT_CHECKIN_CLAIM_PATHS = [
  '/api/commerce/activity/v1/sign-in',
]

/** Control-plane budget for one upstream read. */
const PROBE_TIMEOUT_MS = 12000

/**
 * Split a pool entry into its three parts.
 *
 * The format is `jwt|nextauth|device_id`, and older entries may carry only the
 * first one or two segments, so every field past the JWT is optional.
 */
export function parseTokenValue(value) {
  const text = typeof value === 'string' ? value : ''
  const parts = text.split('|')
  const jwt = parts[0] ?? ''
  const nextAuth = parts[1] ?? ''
  const deviceId = parts[2] ?? ''
  return {
    jwt,
    nextAuth: nextAuth === '' ? undefined : nextAuth,
    deviceId: deviceId === '' ? randomUUID() : deviceId,
  }
}

/**
 * Read the Tabbit user id out of the JWT payload.
 *
 * Tabbit sends it as a cookie (`user_id`, `SAPISID`) and inside the
 * consistency header, so the payload has to be decoded. An opaque or damaged
 * token yields a fresh uuid rather than failing: the id is an identity hint,
 * not a credential, and a wrong one only makes the upstream reject the call.
 */
export function userIdOf(jwt) {
  const parts = typeof jwt === 'string' ? jwt.split('.') : []
  if (parts.length < 2) return randomUUID()
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    const id = payload?.id ?? payload?.sub
    return typeof id === 'string' && id !== '' ? id : randomUUID()
  } catch {
    return randomUUID()
  }
}

/** Normalize an origin so `referer` is always same-origin. */
function originOf(baseUrl, fallback) {
  const text = typeof baseUrl === 'string' && baseUrl.trim() !== '' ? baseUrl.trim() : fallback
  return text.replace(/\/+$/, '')
}

/**
 * The header set Tabbit expects.
 *
 * `x-chrome-id-consistency-request` is not decorative: it names the client id,
 * the device id and the account id in one string, and Tabbit's edge rejects a
 * request that omits it.
 */
export function buildHeaders(origin, token, options = {}) {
  const { jwt, deviceId } = token
  const userId = userIdOf(jwt)
  return {
    'user-agent': USER_AGENT,
    'sec-ch-ua': '"Tabbit Browser";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-platform': '"Windows"',
    'sec-ch-ua-mobile': '?0',
    'x-chrome-id-consistency-request':
      `version=1,client_id=${options.clientId ?? DEFAULT_CLIENT_ID},` +
      `device_id=${deviceId},sync_account_id=${userId},` +
      'signin_mode=all_accounts,signout_mode=show_confirmation',
    referer: `${origin}${options.refererPath ?? '/newtab'}`,
    origin,
    accept: 'application/json, text/plain, */*',
    ...(options.contentType === true ? { 'content-type': 'application/json' } : {}),
  }
}

/** The cookie set Tabbit expects on every authenticated call. */
export function buildCookies(token) {
  const { jwt, nextAuth } = token
  const userId = userIdOf(jwt)
  const cookies = {
    token: jwt,
    user_id: userId,
    managed: 'tab_browser',
    NEXT_LOCALE: 'zh',
    SAPISID: userId,
  }
  if (nextAuth !== undefined) cookies['next-auth.session-token'] = nextAuth
  return cookies
}

/** Serialize cookies for a `cookie:` header. */
function cookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')
}

/**
 * One authenticated Tabbit call.
 *
 * A 401/403 is reported as `unauthorized` so the pool can mark that account
 * dead; a 404 is reported as `not_found` so a path probe can move on; anything
 * else is a plain failure.
 */
async function call(origin, token, { method = 'GET', path, body, refererPath }) {
  const headers = buildHeaders(origin, token, { refererPath, contentType: body !== undefined })
  headers.cookie = cookieHeader(buildCookies(token))
  let response
  try {
    response = await fetch(`${origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'manual',
    })
  } catch (error) {
    throw new TabbitError(`无法连接 Tabbit（${origin}${path}）：${messageOf(error)}`, {
      status: 502,
      code: 'tabbit_unreachable',
      retryable: true,
    })
  }
  const text = await response.text().catch(() => '')
  if (response.status === 401 || response.status === 403) {
    throw new TabbitError(`Tabbit 拒绝了这个账号（HTTP ${response.status}），登录态可能已过期`, {
      status: 401,
      code: 'tabbit_unauthorized',
    })
  }
  if (response.status === 404) {
    throw new TabbitError(`Tabbit 没有这个接口：${method} ${path}`, { status: 404, code: 'not_found' })
  }
  if (!response.ok) {
    throw new TabbitError(`Tabbit 返回 HTTP ${response.status}：${text.slice(0, 200)}`, {
      status: 502,
      code: 'tabbit_error',
    })
  }
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new TabbitError(`Tabbit 响应不是 JSON：${messageOf(error)}`, { status: 502, code: 'bad_json' })
  }
}

/**
 * Walk an arbitrary JSON body and collect numbers under recognised names.
 *
 * Tabbit's credit payload is undocumented and will change; rather than pin a
 * schema, every numeric field whose key looks like a balance is collected. The
 * panel shows what was found and names the field it came from, so a wrong guess
 * is visible instead of authoritative.
 */
const CREDIT_KEYS = [
  'credits',
  'credit',
  'balance',
  'remaining',
  'remain',
  'total',
  'used',
  'quota',
  'points',
  'score',
  'amount',
  'limit',
  'monthly_credits',
  'daily_credits',
]

export function collectNumbers(value, out = [], depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, out, depth + 1)
    return out
  }
  for (const [key, entry] of Object.entries(value)) {
    const lower = key.toLowerCase()
    if (typeof entry === 'number' && Number.isFinite(entry) && CREDIT_KEYS.some((needle) => lower.includes(needle))) {
      out.push({ key, value: entry })
    } else if (typeof entry === 'object') {
      collectNumbers(entry, out, depth + 1)
    }
  }
  return out
}

/** Turn a raw credit payload into something a card can render. */
export function summarizeCredits(raw) {
  const body = raw?.data ?? raw
  if (body && Object.hasOwn(body, 'usage_percentage')) {
    const text = body.usage_percentage
    const used = typeof text === 'number' ? text : typeof text === 'string' && /^\d+(?:\.\d+)?%?$/.test(text.trim()) ? Number(text.trim().replace(/%$/, '')) : NaN
    if (!Number.isFinite(used) || used < 0) throw new TabbitError('Tabbit 返回的用量百分比格式已变化，请刷新或更新插件。', { code: 'quota_schema_changed' })
    return {
      kind: 'quota', unit: 'percent', used, total: 100,
      remaining: Math.max(0, Number((100 - used).toFixed(4))),
      memberLevel: typeof body.member_level === 'string' ? body.member_level : undefined,
      cycleStart: body.current_cycle_start,
      cycleEnd: body.current_cycle_end,
      resetMinutes: body.remaining_reset_minutes != null && Number.isFinite(Number(body.remaining_reset_minutes)) ? Number(body.remaining_reset_minutes) : undefined,
      membershipEnd: body.membership_entitlement_end_time ?? body.membership_end_time,
      fields: [],
    }
  }
  const numbers = collectNumbers(raw)
  // De-duplicate by key so a repeated nested field does not produce two rows.
  const seen = new Set()
  const fields = []
  for (const entry of numbers) {
    const id = `${entry.key}=${entry.value}`
    if (seen.has(id)) continue
    seen.add(id)
    fields.push(entry)
  }
  const byKey = (needle) => fields.find((entry) => entry.key.toLowerCase().includes(needle))
  const remaining = byKey('remaining') ?? byKey('balance') ?? byKey('credits') ?? byKey('points')
  const total = byKey('total') ?? byKey('limit') ?? byKey('quota')
  const used = byKey('used')
  return {
    fields,
    remaining: remaining?.value,
    total: total?.value,
    used: used?.value,
  }
}

/**
 * Read credits for one account, trying each configured path until one answers.
 *
 * `remember` receives the path that worked so the caller can cache it; without
 * that, every panel refresh would replay the whole probe list.
 */
export async function readCredits({ origin, token, paths, remember }) {
  // Old installations saved the guessed defaults. Always try the verified API
  // first so upgrading also repairs those saved configurations.
  const candidates = [...new Set([...DEFAULT_CREDITS_PATHS, ...(Array.isArray(paths) ? paths : [])])]
  const failures = []
  for (const path of candidates) {
    try {
      const resolved = path.replaceAll('{user_id}', encodeURIComponent(userIdOf(token.jwt)))
        .replaceAll('{timezone}', encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'))
      const raw = await call(origin, token, { path: resolved })
      const summary = summarizeCredits(raw)
      if (summary.kind !== 'quota' && summary.fields.length === 0) {
        throw new TabbitError('Tabbit 用量接口未返回可识别的额度，请检查账号所属版本或更新插件。', { code: 'quota_schema_changed' })
      }
      remember?.(path)
      return { path, ...summary }
    } catch (error) {
      if (error?.code === 'not_found') {
        failures.push(`${path} → 404`)
        continue
      }
      throw error
    }
  }
  throw new TabbitError('Tabbit 用量接口暂不可用，请检查账号所属版本或稍后刷新。', {
    status: 404,
    code: 'credits_unsupported',
  })
}

/** Live chat-model metadata. Multipliers describe quota use, never currency. */
export async function readModelCatalog({ origin, token }) {
  const raw = await call(origin, token, { path: '/proxy/v1/model_config/models?a=0&scene=chat' })
  if (!Array.isArray(raw?.models) || raw.models.length === 0 || raw.status && raw.status !== 'success') {
    throw new TabbitError('Tabbit 未返回有效的聊天模型目录', { code: 'catalog_schema_changed' })
  }
  return raw.models.filter(row => typeof row?.display_name === 'string' && row.display_name.trim()).map(row => ({
    id: ['默认', '最佳', 'Best', 'Default'].includes(row.display_name) ? 'best' : row.display_name.toLowerCase().replaceAll(' ', '-').replaceAll('.', '-'),
    name: row.display_name,
    description: typeof row.description === 'string' ? row.description : '',
    supportsVision: row.supports_images === true,
    reasoning: row.support_thinking === true && row.use_thinking === true,
    accessType: row.model_access_type,
    usageMultiplier: typeof row.display_multiplier === 'number' && Number.isFinite(row.display_multiplier) && row.display_multiplier >= 0 ? row.display_multiplier : undefined,
    metadataSource: 'tabbit',
  }))
}

/**
 * Whether today's check-in has already been claimed.
 *
 * The answer is read from a boolean somewhere in the payload; when no boolean
 * is recognisable the status is reported as `unknown` and a claim is *not*
 * attempted, because claiming twice could burn a reward.
 */
export function summarizeCheckinStatus(raw) {
  if (Array.isArray(raw?.results)) {
    const row = raw.results.find(row => row?.scene_code === 'desktop_pet')
    return {
      known: typeof row?.signed_today === 'boolean' && typeof row?.activity_open === 'boolean',
      todayCheckedIn: row?.signed_today === true,
      active: row?.activity_open === true,
      flags: [],
      scene: 'desktop_pet',
      day: typeof raw.sign_in_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.sign_in_date) ? raw.sign_in_date : undefined,
    }
  }
  const flags = []
  const walk = (value, depth = 0) => {
    if (depth > 6 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    for (const [key, entry] of Object.entries(value)) {
      const lower = key.toLowerCase()
      if (typeof entry === 'boolean' && /(check|sign|done|claim|today|activity|already)/.test(lower)) {
        flags.push({ key, value: entry })
      } else if (typeof entry === 'object') {
        walk(entry, depth + 1)
      }
    }
  }
  walk(raw)
  const checked = flags.find((flag) => /(done|claim|today|already)/.test(flag.key.toLowerCase()) && flag.value === true)
  const active = flags.find((flag) => /activity/.test(flag.key.toLowerCase()))
  return {
    known: flags.some(flag => /(checked|signed|done|claimed|today|already)/i.test(flag.key)),
    flags,
    todayCheckedIn: checked !== undefined,
    active: active === undefined ? true : active.value,
  }
}

/** Read the check-in status for one account. */
export async function readCheckinStatus({ origin, token, paths, remember }) {
  const candidates = [...new Set([...DEFAULT_CHECKIN_STATUS_PATHS, ...(Array.isArray(paths) ? paths : [])])]
  const failures = []
  for (const path of candidates) {
    try {
      const raw = await call(origin, token, { path })
      const summary = summarizeCheckinStatus(raw)
      if (!summary.known) throw new TabbitError('Tabbit 签到状态格式已变化，未执行签到，请更新插件。', { code: 'checkin_schema_changed' })
      remember?.(path)
      return { path, ...summary }
    } catch (error) {
      if (error?.code === 'not_found') {
        failures.push(`${path} → 404`)
        continue
      }
      throw error
    }
  }
  throw new TabbitError(`没有找到可用的签到状态接口（已尝试 ${failures.join('、')}）`, {
    status: 404,
    code: 'checkin_unsupported',
  })
}

/** Claim the daily check-in for one account. */
export async function claimCheckin({ origin, token, paths, remember }) {
  const candidates = [...new Set([...DEFAULT_CHECKIN_CLAIM_PATHS, ...(Array.isArray(paths) ? paths : [])])]
  const failures = []
  for (const path of candidates) {
    try {
      const body = path === DEFAULT_CHECKIN_CLAIM_PATHS[0] ? { scene_codes: ['desktop_pet'], request_no: randomUUID() } : {}
      const raw = await call(origin, token, { method: 'POST', path, body, refererPath: '/newtab' })
      const result = raw?.results?.find(row => row?.scene_code === 'desktop_pet')
      if (path === DEFAULT_CHECKIN_CLAIM_PATHS[0] && result?.sign_in_result !== 'already_signed') {
        // Only already_signed is observed in a live response. Confirm a new
        // claim using the documented status fields instead of guessing enums.
        const status = await readCheckinStatus({ origin, token })
        if (!status.known || !status.todayCheckedIn) throw new TabbitError('Tabbit 未确认签到成功，请刷新签到状态后再试。', { code: 'checkin_not_confirmed' })
      }
      remember?.(path)
      return { path, already: result?.sign_in_result === 'already_signed', day: raw?.sign_in_date }
    } catch (error) {
      if (error?.code === 'not_found') {
        failures.push(`${path} → 404`)
        continue
      }
      throw error
    }
  }
  throw new TabbitError(`没有找到可用的签到接口（已尝试 ${failures.join('、')}）`, {
    status: 404,
    code: 'checkin_unsupported',
  })
}

/** Resolve the Tabbit origin for one region configuration. */
export function originFor(settings, region) {
  return originOf(settings?.tabbitUrl, region.defaultTabbitUrl)
}
