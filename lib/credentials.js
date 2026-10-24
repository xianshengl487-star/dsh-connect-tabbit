import { randomUUID } from 'node:crypto'

/** Decode only for expiry, labels and duplicate detection; this is not verification. */
export function tokenPayload(value) {
  try {
    return JSON.parse(Buffer.from(value.split('|')[0].split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

export function accountIdentity(value) {
  const payload = tokenPayload(value)
  const id = payload?.id ?? payload?.sub
  return typeof id === 'string' && id !== '' ? `${payload.iss ?? ''}:${id}` : undefined
}

function decode(value) {
  try { return decodeURIComponent(value) } catch { return value }
}

/** Accept only cookies belonging to this edition, including chunked HttpOnly sessions. */
export function credentialFromCookies(cookies, origin, deviceId) {
  const host = new URL(origin).hostname
  const candidates = cookies.filter(cookie => {
    const domain = String(cookie.domain ?? '').replace(/^\./, '')
    return (!domain || host === domain || host.endsWith(`.${domain}`)) &&
      (cookie.expires === undefined || cookie.expires <= 0 || cookie.expires > Date.now() / 1000)
  })
  const get = name => candidates.find(cookie => cookie.name === name)?.value ?? ''
  const jwt = decode(get('token'))
  if (!jwt) throw new Error('没有找到这个版本的 Tabbit 登录凭据，请先登录对应版本。')
  const sessionName = ['next-auth.session-token', '__Secure-next-auth.session-token', 'authjs.session-token', '__Secure-authjs.session-token']
    .find(name => get(name) || candidates.some(cookie => cookie.name.startsWith(`${name}.`)))
  const session = sessionName === undefined ? '' : get(sessionName) || candidates
    .filter(cookie => cookie.name.startsWith(`${sessionName}.`) && /^\d+$/.test(cookie.name.slice(sessionName.length + 1)))
    .sort((a, b) => Number(a.name.slice(sessionName.length + 1)) - Number(b.name.slice(sessionName.length + 1)))
    .map(cookie => cookie.value).join('')
  return normalizeCredential(`${jwt}|${decode(session)}|${deviceId || get('device_id') || randomUUID()}`)
}

export function normalizeCredential(value) {
  const text = String(value ?? '').trim().replace(/^Bearer\s+/i, '')
  if (text.split('|').length > 3) throw new Error('凭据最多包含 JWT、会话和设备标识三个部分。')
  const [jwt, nextAuth = '', deviceId = ''] = text.split('|').map(part => part.trim())
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt) || !tokenPayload(jwt)) {
    throw new Error('无法识别 Tabbit 凭据，请粘贴 JWT、Cookie 或导出的账号 JSON。')
  }
  if ([jwt, nextAuth, deviceId].some(part => /[\r\n;\s]/.test(part))) throw new Error('凭据包含无效字符。')
  const payload = tokenPayload(jwt)
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) throw new Error('Tabbit 登录已过期，请重新登录后导入。')
  return nextAuth || deviceId ? `${jwt}|${nextAuth}|${deviceId || randomUUID()}` : jwt
}

/** Parse an entire batch before writing, so one malformed entry cannot partially import. */
export function parseAccountImport(input, { region, origin, name } = {}) {
  const text = typeof input === 'string' ? input.trim() : ''
  let parsed = input
  if (text.startsWith('{') || text.startsWith('[')) {
    try { parsed = JSON.parse(text) } catch { throw new Error('账号 JSON 格式不正确。') }
  }
  const toRow = (entry, index) => {
    if (entry?.region && entry.region !== region) throw new Error('导入账号的版本与当前所选版本不一致。')
    const value = typeof entry === 'string' ? entry : entry?.value ?? entry?.jwt ?? entry?.token
    let credential
    if (typeof value === 'string' && /(?:^|;\s*)token=/.test(value.replace(/^Cookie:\s*/i, ''))) {
      const cookies = value.replace(/^Cookie:\s*/i, '').split(';').map(pair => {
        const split = pair.indexOf('=')
        return { name: pair.slice(0, split).trim(), value: pair.slice(split + 1).trim() }
      })
      credential = credentialFromCookies(cookies, origin)
    } else if (Array.isArray(entry?.cookies)) {
      credential = credentialFromCookies(entry.cookies, origin, entry.deviceId ?? entry.device_id)
    } else {
      credential = normalizeCredential(value)
      if (entry && typeof entry === 'object' && !credential.includes('|') && (entry.nextAuth || entry.nextauth || entry.device_id)) {
        credential = normalizeCredential(`${credential}|${entry.nextAuth ?? entry.nextauth ?? ''}|${entry.device_id ?? ''}`)
      }
    }
    const payload = tokenPayload(credential)
    return { region, value: credential, name: entry?.name || name || payload?.name || payload?.email || `Tabbit 账号 ${index + 1}` }
  }
  if (Array.isArray(parsed) && parsed.length && parsed.every(item => typeof item?.name === 'string' && typeof item?.value === 'string' && ('domain' in item || item.name === 'token'))) {
    return [toRow({ cookies: parsed }, 0)]
  }
  const entries = Array.isArray(parsed?.accounts) ? parsed.accounts : Array.isArray(parsed?.tokens) ? parsed.tokens : Array.isArray(parsed) ? parsed : [parsed]
  if (!entries.length || entries.length > 100) throw new Error('一次可导入 1–100 个账号。')
  return entries.map(toRow)
}
