/**
 * The account pool.
 *
 * ## Why the pool lives here and not in the gateway
 *
 * tabbit2api keeps its own token list, but it deliberately returns only a
 * masked preview (`value_preview`) when listing, and never hands a credential
 * back. That is the right call for a gateway — but it means a plugin cannot
 * read credits or press "签到" for an account it cannot authenticate as.
 *
 * So this bundle owns the pool and the gateway gets a synced copy:
 *
 * ```
 *   ~/.dsh/plugins/dsh-connect-tabbit/accounts.json   ← source of truth
 *            │  push on add / remove / toggle
 *            ▼
 *   tabbit2api  /api/admin/tokens                      ← used for completions
 * ```
 *
 * The file is written with mode `0600` and never leaves the machine. This is
 * the one place in the bundle that stores a secret, and the README says so.
 *
 * ## Check-in is idempotent by construction
 *
 * An account already marked as checked in *today* is reported as `already` and
 * no write is attempted. The date is compared in the account's own local day,
 * not UTC, because Tabbit's daily reset follows the account's timezone.
 *
 * @module dsh-connect-tabbit/accounts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { messageOf } from './errors.js'
import { claimCheckin, parseTokenValue, readCheckinStatus, readCredits } from './tabbit.js'
import { accountIdentity } from './credentials.js'

/** On-disk format this reader accepts; other versions are discarded. */
const ACCOUNTS_FORMAT_VERSION = 1

/** Where the pool lives inside the Harness home. */
export function accountsPath() {
  return join(resolveDshHome(), 'plugins', 'dsh-connect-tabbit', 'accounts.json')
}

/** Local day key, e.g. `2026-10-20`, used to make check-in idempotent. */
export function dayKey(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Whether a stored value looks like a Tabbit pool entry.
 *
 * The JWT is the only required segment; a bare `jwt` is a valid (if less
 * capable) credential, so the check is "non-empty and looks like a JWT" rather
 * than "has three segments".
 */
export function looksLikeToken(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return false
  const { jwt } = parseTokenValue(text)
  return jwt.split('.').length >= 2
}

/** The pool, backed by one JSON file. */
export class AccountStore {
  constructor(options = {}) {
    this.path = options.path ?? accountsPath()
    this.logger = options.logger
    this.accounts = []
    this.load()
  }

  load() {
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (parsed?.version !== ACCOUNTS_FORMAT_VERSION) return
      if (!Array.isArray(parsed.accounts)) return
      this.accounts = parsed.accounts.filter((account) => typeof account?.id === 'string')
    } catch (error) {
      // A damaged pool must not take the provider down; it degrades to empty.
      this.logger?.warn?.(`dsh-connect-tabbit: could not read ${this.path}`, error)
    }
  }

  save() {
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      writeFileSync(
        temporary,
        JSON.stringify({ version: ACCOUNTS_FORMAT_VERSION, accounts: this.accounts }, null, 2),
        { encoding: 'utf8', mode: 0o600 },
      )
      renameSync(temporary, this.path)
      chmodSync(this.path, 0o600)
    } catch (error) {
      rmSync(temporary, { force: true })
      this.logger?.warn?.(`dsh-connect-tabbit: could not write ${this.path}`, error)
      throw new Error('无法保存 Tabbit 账号，请检查本机账号目录的写入权限。')
    }
  }

  commit(change) {
    const before = structuredClone(this.accounts)
    try {
      const result = change()
      this.save()
      return result
    } catch (error) {
      this.accounts = before
      throw error
    }
  }

  /** A fresh login renews the existing identity in its own edition. */
  upsert({ name, value, region }, { persist = true } = {}) {
    const identity = accountIdentity(value)
    const existing = this.accounts.find(account => account.region === region &&
      (account.value.split('|')[0] === value.split('|')[0] || (identity !== undefined && accountIdentity(account.value) === identity)))
    if (!existing) return { account: this.add({ name, value, region }, { persist }), state: 'added' }
    const state = existing.value === value && (!name || existing.name === name) ? 'present' : 'updated'
    if (state === 'present') return { account: existing, state }
    const change = () => {
      existing.value = value
      if (typeof name === 'string' && name.trim()) existing.name = name.trim()
      return { account: existing, state }
    }
    return persist ? this.commit(change) : change()
  }

  list() {
    return this.accounts
  }

  /** The accounts bound to one edition. */
  accountsFor(regionId) {
    return this.accounts.filter((account) => account.region === regionId)
  }

  find(id) {
    return this.accounts.find((account) => account.id === id)
  }

  /**
   * Persist the entitlement level observed from the official credits endpoint.
   * Premium-only models need a member account or the upstream answers with a
   * silent empty body, so the gateway pool routes on this field.
   */
  setMemberLevel(id, memberLevel, { persist = true } = {}) {
    const account = this.find(id)
    if (account === undefined || account.memberLevel === memberLevel) return false
    const change = () => { account.memberLevel = memberLevel }
    persist ? this.commit(change) : change()
    return true
  }

  /**
   * Add one account.
   *
   * An account belongs to exactly one edition: a CN cookie cannot authenticate
   * against the global site, so binding the region here is what lets the
   * check-in and credit readers address the right origin, and what keeps one
   * account from being mirrored into both gateways.
   *
   * A duplicate credential is rejected rather than merged: two rows for the
   * same account would double-count the quota and make check-in ambiguous.
   */
  add({ name, value, region, enabled = true }, { persist = true } = {}) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!looksLikeToken(text)) throw new Error('这不是有效的 Tabbit 凭据（应为 jwt 或 jwt|nextauth|device_id）')
    if (typeof region !== 'string' || region === '') throw new Error('缺少所属版本')
    if (this.accounts.some((account) => account.value === text)) throw new Error('这个账号已经在池里了')
    const account = {
      id: randomUUID(),
      name: typeof name === 'string' && name.trim() !== '' ? name.trim() : `账号 ${this.accounts.length + 1}`,
      value: text,
      region,
      enabled: enabled !== false,
      createdAt: new Date().toISOString(),
      lastCheckinAt: undefined,
      lastCheckinDay: undefined,
      // Filled in when the account is mirrored into a gateway.
      gatewayIds: {},
    }
    const change = () => {
      this.accounts.push(account)
      return account
    }
    return persist ? this.commit(change) : change()
  }

  update(id, patch) {
    const account = this.find(id)
    if (account === undefined) throw new Error('账号不存在')
    return this.commit(() => {
    if (typeof patch.name === 'string' && patch.name.trim() !== '') account.name = patch.name.trim()
    if (typeof patch.enabled === 'boolean') account.enabled = patch.enabled
    if (typeof patch.value === 'string') {
      const text = patch.value.trim()
      if (!looksLikeToken(text)) throw new Error('这不是有效的 Tabbit 凭据')
      account.value = text
      // Keep the mirror id so sync can replace its credential instead of
      // leaving the gateway executing an orphaned, stale login.
    }
    return account
    })
  }

  remove(id) {
    return this.commit(() => {
    const before = this.accounts.length
    this.accounts = this.accounts.filter((account) => account.id !== id)
    if (this.accounts.length === before) throw new Error('账号不存在')
    return { ok: true }
    })
  }

  /** Record a successful check-in for one account. */
  markCheckedIn(id, now = new Date(), upstreamDay) {
    const account = this.find(id)
    if (account === undefined) return
    this.commit(() => {
      account.lastCheckinAt = now.toISOString()
      account.lastCheckinDay = /^\d{4}-\d{2}-\d{2}$/.test(upstreamDay ?? '') ? upstreamDay : dayKey(now)
    })
  }

  /** Remember which gateway token mirrors one account. */
  setGatewayId(id, regionId, tokenId) {
    const account = this.find(id)
    if (account === undefined) return
    this.commit(() => {
      if (account.gatewayIds === undefined) account.gatewayIds = {}
      account.gatewayIds[regionId] = tokenId
    })
  }

  /** The gateway token id recorded for one account, if any. */
  gatewayIdFor(id, regionId) {
    return this.find(id)?.gatewayIds?.[regionId]
  }
}

/**
 * Normalize the gateway's account status into the three states the card shows.
 *
 * tabbit2api's own vocabulary is `active` / `cooldown` / `banned` (plus
 * `unknown` before the first probe); anything unrecognised is reported as
 * `unknown` rather than guessed, so a future state does not silently read as
 * "healthy".
 */
export function poolStateOf(status) {
  const text = typeof status === 'string' ? status.toLowerCase() : ''
  if (text === 'active') return 'active'
  if (text === 'cooldown') return 'cooldown'
  if (text === 'banned' || text === 'error') return 'error'
  return 'unknown'
}

/**
 * Push one edition's accounts into its gateway.
 *
 * Only accounts the gateway does not already know about are added; an existing
 * mirror is left alone so the gateway's own counters survive a re-sync. Removal
 * is handled by {@link removeFromGateway}, which the delete path calls before
 * dropping the local row.
 *
 * Never throws: a gateway that is down simply leaves the mirrors stale, which
 * the next sync repairs.
 */
export async function syncToGateway(store, gateway, regionId) {
  const rows = []
  let remoteIds
  if (typeof gateway.listTokens === 'function' && store.accountsFor(regionId).length) {
    try { remoteIds = new Set((await gateway.listTokens()).map(token => token.id)) }
    catch (error) { return store.accountsFor(regionId).map(account => ({ accountId: account.id, name: account.name, state: 'failed', message: messageOf(error) })) }
  }
  for (const account of store.accountsFor(regionId)) {
    const known = store.gatewayIdFor(account.id, regionId)
    if (account.enabled === false) {
      if (known !== undefined && remoteIds?.has(known)) {
        try { await gateway.updateToken(known, { enabled: false }) }
        catch (error) { rows.push({ accountId: account.id, name: account.name, state: 'failed', message: messageOf(error) }); continue }
      }
      rows.push({ accountId: account.id, name: account.name, state: 'skipped' })
      continue
    }
    try {
      if (known !== undefined && (remoteIds === undefined || remoteIds.has(known))) {
        if (typeof gateway.updateToken === 'function') await gateway.updateToken(known, { name: account.name, value: account.value, enabled: true, memberLevel: account.memberLevel })
        rows.push({ accountId: account.id, name: account.name, state: 'present', tokenId: known })
        continue
      }
      const { id } = await gateway.addToken({ name: account.name, value: account.value, enabled: true, memberLevel: account.memberLevel })
      if (!id) throw new Error('网关没有返回账号标识，请重试同步。')
      store.setGatewayId(account.id, regionId, id)
      rows.push({ accountId: account.id, name: account.name, state: 'added', tokenId: id })
    } catch (error) {
      rows.push({ accountId: account.id, name: account.name, state: 'failed', message: messageOf(error) })
    }
  }
  return rows
}

/** Drop one account's mirror from one gateway. */
export async function removeFromGateway(store, gateway, regionId, accountId) {
  const tokenId = store.gatewayIdFor(accountId, regionId)
  if (tokenId === undefined) return { ok: true, removed: false }
  try {
    await gateway.deleteToken(tokenId)
    return { ok: true, removed: true }
  } catch (error) {
    return { ok: false, removed: false, message: messageOf(error) }
  }
}

/** Wait between serial upstream calls; the pool is never hit in parallel. */
function defaultWait(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Read credits for every enabled account, one at a time.
 *
 * Serial by design: Tabbit's edge rate-limits per IP, and a panel that fans out
 * over ten accounts is the fastest way to get the whole machine throttled.
 *
 * Never throws — a failure is a row, so one dead account cannot hide the others.
 */
export async function readAllCredits(targets, deps) {
  const rows = []
  for (const [index, target] of targets.entries()) {
    if (index > 0) await (deps.wait ?? defaultWait)(350)
    rows.push(await readOneCredits(target, deps))
  }
  return rows
}

/** One account's credit reading, reduced to a row. */
async function readOneCredits(target, deps) {
  const base = { accountId: target.accountId, accountName: target.accountName }
  try {
    const reading = await readCredits({
      origin: deps.origin,
      token: parseTokenValue(target.value),
      paths: deps.creditsPaths,
      remember: (path) => deps.rememberCreditsPath?.(path),
    })
    return {
      ...base,
      status: 'ok',
      ...reading,
    }
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      code: error?.code ?? 'error',
      message: messageOf(error),
    }
  }
}

/**
 * Check in every enabled account, one at a time.
 *
 * Read the activity's server date/status before claiming. The server's day can
 * differ from the local date around midnight, so local history is display only.
 */
export async function checkinAll(targets, deps, now = new Date()) {
  const rows = []
  for (const [index, target] of targets.entries()) {
    if (index > 0) await (deps.wait ?? defaultWait)(400)
    rows.push(await checkinOne(target, deps, now))
  }
  return rows
}

/** One account's check-in, reduced to its row. */
async function checkinOne(target, deps, now) {
  const base = { accountId: target.accountId, accountName: target.accountName }
  const token = parseTokenValue(target.value)
  try {
    const status = await readCheckinStatus({
      origin: deps.origin,
      token,
      paths: deps.checkinStatusPaths,
      remember: (path) => deps.rememberCheckinPath?.(path),
    })
    if (status.active === false) {
      return { ...base, status: 'failed', message: '该账号当前没有可参与的签到活动' }
    }
    if (status.todayCheckedIn === true) {
      // The server's activity day can differ from the local calendar day.
      deps.markCheckedIn?.(target.accountId, now, status.day)
      return { ...base, status: 'already' }
    }
    const claim = await claimCheckin({
      origin: deps.origin,
      token,
      paths: deps.checkinClaimPaths,
      remember: (path) => deps.rememberCheckinClaimPath?.(path),
    })
    deps.markCheckedIn?.(target.accountId, now, claim.day ?? status.day)
    return { ...base, status: claim.already ? 'already' : 'claimed', path: claim.path }
  } catch (error) {
    return { ...base, status: 'failed', code: error?.code ?? 'error', message: messageOf(error) }
  }
}

/** One edition's enabled accounts, as check-in / credit targets. */
export function targetsOf(store, regionId) {
  return store
    .accountsFor(regionId)
    .filter((account) => account.enabled !== false)
    .map((account) => ({
      accountId: account.id,
      accountName: account.name,
      value: account.value,
      lastCheckinDay: account.lastCheckinDay,
    }))
}
