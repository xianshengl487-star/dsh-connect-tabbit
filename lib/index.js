/**
 * DSH Connect Tabbit — bring Tabbit (CN and global) into DeepSeek Harness.
 *
 * The default gateway runs inside this plugin using Node's built-in APIs.
 * An external tabbit2api is still supported via gatewayMode: external.
 *
 * ```
 * DSH  PiAiAdapter (one profile per edition)
 *  └─ loopback shim (random port + per-process secret)
 *      └─ embedded gateway /v1/chat/completions
 *          └─ Tabbit account pool  →  web.tabbit.com / web.tabbit.ai
 *
 * Settings card
 *  └─ plugin routes  /plugins/dsh-connect-tabbit/*
 *      ├─ models   ← gateway /v1/models
 *      ├─ usage    ← gateway /api/admin/status + direct Tabbit credit reads
 *      ├─ accounts ← local pool (source of truth) mirrored into the gateway
 *      └─ checkin  ← direct Tabbit daily check-in, using the server's day
 * ```
 *
 * Both editions register unconditionally and independently: a region whose
 * gateway is unreachable simply contributes no models, so one dead gateway
 * never costs the user the other edition.
 *
 * @module dsh-connect-tabbit
 */
import { join, dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { createTabbitAdapter } from './adapter.js'
import { createTabbitShim } from './shim.js'
import { REGIONS, GatewayClient } from './gateway.js'
import { createEmbeddedGateway } from './embedded/gateway.js'
import {
  AccountStore,
  checkinAll,
  poolStateOf,
  readAllCredits,
  removeFromGateway,
  syncToGateway,
  targetsOf,
} from './accounts.js'
import {
  DEFAULT_CHECKIN_CLAIM_PATHS,
  DEFAULT_CHECKIN_STATUS_PATHS,
  DEFAULT_CREDITS_PATHS,
  originFor,
  parseTokenValue,
  readModelCatalog,
} from './tabbit.js'
import { messageOf } from './errors.js'
import { parseAccountImport, tokenPayload } from './credentials.js'
import { readLocalAccounts } from './local-accounts.js'
import { LoginManager } from './login.js'

/** Loader row id; also the plugin's identity in the composition. */
/**
 * Plugin name, and the Loader entry id the profile patch mounts it under.
 *
 * Kept equal to the package name for the same reason the sibling connectors do
 * it: on DSH 0.1.7+ the settings service keys a form by its Loader entry id, and
 * the harness resolves a provider's namespace by EXACT match. Making the entry
 * id, the package name and {@link TABBIT_SETTINGS_NS} the same string means the
 * Host installs its section under the one name the browser half looks for,
 * instead of the two halves guessing at each other.
 */
export const name = 'dsh-connect-tabbit'

/** The model registry that must exist before a provider can register. */
export const inject = ['llm']

/**
 * Settings namespace owning this plugin's section.
 *
 * A namespace only becomes configurable once a section is installed into it —
 * `registerConfigurableProviders` merely *addresses* it.
 */
export const TABBIT_SETTINGS_NS = 'dsh-connect-tabbit'

/** One edition's connection settings. */
const REGION_FIELDS = {
  enabled: z.boolean().default(true).description('启用这个版本'),
  gatewayMode: z.union(['auto', 'embedded', 'external']).default('auto').description('网关服务：auto 默认内置并保留旧自定义地址；embedded 强制内置；external 使用外部网关'),
  gatewayUrl: z.string().default('').description('外部网关地址；仅 external 模式使用'),
  gatewayApiKey: z.string().default('').description('网关自身的 api_key（未设置可留空）'),
  adminPassword: z.string().default('admin').description('tabbit2api 管理面板密码'),
  tabbitUrl: z.string().default('').description('Tabbit 网页端地址；留空使用默认域名'),
}

const REGION_SCHEMA = z.object(REGION_FIELDS)

/** Per-model image preference. */
const IMAGE_MODES = ['auto', 'on', 'off']

const IMAGE_OVERRIDES_FIELD = z
  .dict(z.union(IMAGE_MODES))
  .default({})
  .description('逐模型图像输入：auto 跟随网关声明，on/off 强制开关')

const ENABLED_MODEL_IDS_FIELD = z
  .dict(z.array(z.string()))
  .default({})
  .description('逐区域模型白名单；空列表表示不过滤')

const REASONING_OVERRIDES_FIELD = z
  .dict(z.boolean())
  .default({})
  .description('逐模型推理开关；未设置的模型按模型名推断')

const CREDITS_PATHS_FIELD = z
  .array(z.string())
  .default([...DEFAULT_CREDITS_PATHS])
  .description('用量接口附加路径；默认使用 Tabbit 官方周期额度接口')

const CHECKIN_STATUS_PATHS_FIELD = z
  .array(z.string())
  .default([...DEFAULT_CHECKIN_STATUS_PATHS])
  .description('签到状态接口候选路径')

const CHECKIN_CLAIM_PATHS_FIELD = z
  .array(z.string())
  .default([...DEFAULT_CHECKIN_CLAIM_PATHS])
  .description('签到领取接口候选路径')

/**
 * Mark a schema field as settings-writable on the DSH lines that support it.
 *
 * `volatile()` exists from schemastery 3.18.3. On the 0.1.7 line it is not a
 * hint: the settings service builds a plugin's published form with
 * `volatileForm(Config)`, which returns `undefined` unless the schema carries at
 * least one `meta.volatile` field. A plugin whose Config is entirely ordinary
 * therefore publishes NO namespace at all — the form is never served, the card's
 * `whileServed` never fires, and the card comes up read-only with no error
 * anywhere. That is the failure this marking exists to prevent.
 *
 * On older schemastery (the 0.1.5 line) the method is absent and the schema must
 * stay byte-identical to the unmarked original, so this degrades to an identity
 * no-op rather than hand-writing `meta.volatile` and bypassing schemastery's own
 * validation.
 */
function asVolatile(schema) {
  if (typeof schema.volatile === 'function') return schema.volatile()
  return schema
}

/**
 * Resolve a possibly-volatile config field to its value.
 *
 * On the 0.1.7 line a volatile field reaches the plugin as a live `{ get() }`
 * reference so the loader can hot-update it in place. Every ordinary read path
 * has to peel that one level; a spread would copy the reference itself.
 */
function unwrapVolatile(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

/** Deep copy of a config value with every live reference resolved. */
function plainDeep(value) {
  const resolved = unwrapVolatile(value)
  if (Array.isArray(resolved)) return resolved.map(plainDeep)
  if (resolved !== null && typeof resolved === 'object') {
    return Object.fromEntries(Object.entries(resolved).map(([key, child]) => [key, plainDeep(child)]))
  }
  return resolved
}

/** The plugin's whole configuration schema. */
export const Config = z.object({
  cn: REGION_SCHEMA,
  global: REGION_SCHEMA,
  // Volatile: these six are the fields the settings card writes. Marking them
  // is what makes the namespace publishable at all (see {@link asVolatile}),
  // and it also lets a save land in the running plugin instead of forcing a
  // full reload of both region shims.
  enabledModelIds: asVolatile(ENABLED_MODEL_IDS_FIELD),
  imageOverrides: asVolatile(IMAGE_OVERRIDES_FIELD),
  reasoningOverrides: asVolatile(REASONING_OVERRIDES_FIELD),
  creditsPaths: asVolatile(CREDITS_PATHS_FIELD),
  checkinStatusPaths: asVolatile(CHECKIN_STATUS_PATHS_FIELD),
  checkinClaimPaths: asVolatile(CHECKIN_CLAIM_PATHS_FIELD),
})

/** The section this plugin publishes for its settings namespace. */
const TABBIT_SECTION = z.object({
  enabledModelIds: ENABLED_MODEL_IDS_FIELD,
  imageOverrides: IMAGE_OVERRIDES_FIELD,
  reasoningOverrides: REASONING_OVERRIDES_FIELD,
  creditsPaths: CREDITS_PATHS_FIELD,
  checkinStatusPaths: CHECKIN_STATUS_PATHS_FIELD,
  checkinClaimPaths: CHECKIN_CLAIM_PATHS_FIELD,
})

/** Plugin-owned routes the settings card reads. */
const ROUTE_BASE = '/plugins/dsh-connect-tabbit'
const MODELS_PATH = `${ROUTE_BASE}/models`
const USAGE_PATH = `${ROUTE_BASE}/usage`
const ACCOUNTS_PATH = `${ROUTE_BASE}/accounts`
const CHECKIN_PATH = `${ROUTE_BASE}/checkin`

/** How long a fetched usage reading stays fresh. */
const USAGE_TTL_MS = 20 * 1000

/** How long a fetched catalog stays fresh before it is refetched. */
const CATALOG_TTL_MS = 30 * 60 * 1000

/**
 * How often a region whose gateway was down is retried, until it publishes.
 *
 * Ten seconds is a compromise: fast enough that `docker compose up -d` followed
 * by a look at the model picker shows the models, slow enough that a gateway
 * that is never started costs one request every ten seconds and nothing else.
 */
const GATEWAY_WATCH_MS = 10 * 1000

/** On-disk catalog format. */
const CATALOG_FORMAT_VERSION = 1

/** Answer one card request. */
function sendJson(res, status, value) {
  const payload = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' })
  res.end(payload)
}

/** Whether a card request came from this machine. */
function loopbackRequest(req) {
  if (req.socket?.remoteAddress && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false
  const localHost = host => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)
  if (req.headers.host) {
    try { if (!localHost(new URL(`http://${req.headers.host}`).hostname)) return false } catch { return false }
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  try {
    const host = new URL(origin).hostname
    return localHost(host) && (!req.headers.host || new URL(origin).host === req.headers.host)
  } catch {
    return false
  }
}

/** Ceiling for a card request body; a pool entry is the largest thing sent. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Read a JSON request body, tolerating an empty one and refusing a huge one.
 *
 * Over budget, bytes are dropped rather than the socket destroyed: destroying it
 * resets the connection, and the card would report "connection reset" instead of
 * the 413 it was sent. The refusal is reported after the body is drained.
 */
function readJson(req) {
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
        const error = new Error('请求体过大')
        error.code = 'body_too_large'
        reject(error)
        return
      }
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Wrap one card handler so a thrown error still becomes a response.
 *
 * Without this an unexpected throw leaves the browser waiting on a socket that
 * never closes, and the card shows "reading…" forever. A route is a leaf: it
 * must always answer.
 */
function respond(handler) {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      sendJson(res, 500, { error: messageOf(error) })
    }
  }
}

/** Plugin-owned catalog path inside the Harness home. */
export function tabbitCatalogPath(regionId) {
  return join(resolveDshHome(), `.tabbit-catalog.${regionId}.json`)
}

/**
 * The fraction of the previous roster a fresh one must keep to be believed.
 *
 * ## Measured, not guessed
 *
 * A live tabbit2api started with a 20-model roster. Pointing it at a credential
 * it could not authenticate as, then pressing its own "re-read the catalog"
 * button (`POST /api/admin/test-models`), answered:
 *
 * ```
 * {"ok": true, "message": "Successfully updated 1 models from Tabbit API",
 *                              "new_models_count": 1, "total_models_count": 1}
 * ```
 *
 * `ok: true` — while the roster on `/v1/models` had gone from 20 to the single
 * model the unauthenticated query returned. The upstream code clears the map
 * before updating it, so an unauthenticated answer replaces the real roster
 * instead of being rejected, and reports success either way.
 *
 * Because this plugin's refresh button calls that endpoint before re-reading the
 * catalog, believing its answer would empty the user's picker on one press —
 * and the emptied catalog would then be written to disk, so it would survive a
 * restart. So a roster that collapses to a fraction of what it was is read as a
 * failure of the *source*, not a change in the world.
 */
const MIN_SHRINK_RATIO = 0.5

/** Exported for the regression test; see {@link MIN_SHRINK_RATIO}. */
export const catalogAccepts = (previousCount, freshCount) =>
  previousCount < 4 || freshCount >= previousCount * MIN_SHRINK_RATIO

/**
 * The last catalog that actually loaded, per region.
 *
 * A restart must not drop the user to an empty model group when a good catalog
 * was fetched minutes earlier, and a temporary gateway outage must not either.
 * Only model metadata is stored — never a credential.
 */
class CatalogStore {
  constructor(region, logger) {
    this.path = tabbitCatalogPath(region.id)
    this.logger = logger
    this.entries = []
    this.fetchedAt = 0
    this.load()
  }

  load() {
    if (!existsSync(this.path)) return
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (parsed?.version !== CATALOG_FORMAT_VERSION) return
      if (!Array.isArray(parsed.entries)) return
      this.entries = parsed.entries
      this.fetchedAt = Number(parsed.fetchedAt) || 0
    } catch {
      // A damaged cache is ignored; the next fetch replaces it.
    }
  }

  save() {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true })
      writeFileSync(
        this.path,
        JSON.stringify({ version: CATALOG_FORMAT_VERSION, fetchedAt: this.fetchedAt, entries: this.entries }, null, 2),
        'utf8',
      )
    } catch (error) {
      this.logger?.warn?.(`dsh-connect-tabbit: could not save catalog ${this.path}`, error)
    }
  }

  current() {
    return this.entries
  }

  fresh() {
    return Date.now() - this.fetchedAt < CATALOG_TTL_MS
  }

  /**
   * Adopt a fresh roster, unless it is a collapse.
   *
   * @returns whether the roster was adopted, so the caller does not invalidate
   *   the adapter for a catalog that did not actually change.
   */
  replace(entries) {
    const previous = this.entries
    // A roster too small to judge (a fresh install, or a gateway that really
    // does serve two models) is always believed; the rule is about *losing*
    // models, never about how many there are.
    const shrinking = previous.length >= 4 && entries.length < previous.length * MIN_SHRINK_RATIO
    if (shrinking) {
      this.logger?.warn?.(
        `dsh-connect-tabbit: 模型目录从 ${previous.length} 个掉到 ${entries.length} 个，判定为上游失效而非真实变化；保留上一份目录`,
      )
      return false
    }
    this.entries = entries
    this.fetchedAt = Date.now()
    this.save()
    return true
  }
}

/**
 * Owns one region: its gateway, catalog, shim and usage cache.
 */
class RegionRuntime {
  constructor(region, gateway, ctx, accountOptions = {}) {
    this.region = region
    this.gateway = gateway
    this.ctx = ctx
    this.logger = ctx.logger
    this.catalog = new CatalogStore(region, ctx.logger)
    this.usage = undefined
    this.usageAt = 0
    this.refreshTimer = undefined
    /** The credit/check-in path that last worked, remembered per region. */
    this.creditsPath = undefined
    this.checkinStatusPath = undefined
    this.checkinClaimPath = undefined
    this.store = accountOptions.store
    this.settings = accountOptions.settings ?? (() => ({}))
    this.accountCount = undefined
    this.syncAccounts = accountOptions.sync
  }

  async refreshAccountState() {
    const localCount = this.store?.accountsFor(this.region.id).filter(row => row.enabled !== false).length ?? 0
    try {
      let rows = await this.gateway.listTokens()
      if (rows.filter(row => row.enabled !== false).length === 0 && localCount > 0 && this.syncAccounts) {
        await this.syncAccounts()
        rows = await this.gateway.listTokens()
      }
      this.accountCount = rows.filter(row => row.enabled !== false).length
    } catch {
      if (localCount > 0) this.accountCount = localCount
    }
  }

  /**
   * Refresh the model catalog from the gateway, keeping the last good one.
   *
   * `replace` may decline a collapse (see {@link MIN_SHRINK_RATIO}); in that
   * case the picker is left alone rather than being rebuilt from a catalog that
   * did not change.
   */
  async refreshCatalog(force = false) {
    if (!force && this.catalog.fresh()) return
    try {
      let entries = await this.gateway.listModels()
      const previous = new Map(this.catalog.current().map(row => [row.id, row]))
      entries = entries.map(row => ({ ...previous.get(row.id), ...row, usageMultiplier: row.usageMultiplier ?? previous.get(row.id)?.usageMultiplier }))
      const account = this.store?.accountsFor(this.region.id).find(row => row.enabled !== false)
      if (account) {
        try {
          const official = await readModelCatalog({ origin: originFor(this.settings(), this.region), token: parseTokenValue(account.value) })
          const byId = new Map(official.map(row => [row.id, row]))
          entries = entries.map(row => ({ ...row, ...byId.get(row.id) }))
        } catch (error) {
          this.logger?.warn?.(`dsh-connect-tabbit: ${this.region.displayName} 官方模型用量信息暂不可用：${messageOf(error)}`)
        }
      }
      if (entries.length > 0 && this.catalog.replace(entries)) {
        this.invalidate?.()
      }
    } catch (error) {
      this.logger?.warn?.(`dsh-connect-tabbit: ${this.region.displayName} 模型目录刷新失败：${messageOf(error)}`)
    }
  }

  /** One entry of this region's catalog. */
  entryFor(modelId) {
    return this.catalog.current().find((entry) => entry.id === modelId)
  }
}

/**
 * Start one region's shim.
 *
 * The gateway is deliberately *not* health-checked here. A local gateway is
 * routinely started after DSH — `docker compose up -d` in another terminal is
 * the normal order — and gating region creation on a one-shot probe would leave
 * the region absent for the rest of the process's life, which is what a real
 * install of this plugin ran into. Whether a region is worth publishing is
 * decided later, from whether it has a catalog to offer; see `publish` below.
 *
 * @returns the runtime plus its shim, or `undefined` when the loopback endpoint
 *   itself could not be started (the only failure that is purely local).
 */
async function startRegion(region, gateway, ctx, enabledIdsFor, accountOptions) {
  const runtime = new RegionRuntime(region, gateway, ctx, accountOptions)

  const shim = createTabbitShim({
    gateway,
    region,
    resolveModels: () => runtime.catalog.current(),
    resolveEnabledIds: () => enabledIdsFor(region.id),
    logger: ctx.logger,
    beforeChat: async () => {
      await runtime.refreshAccountState()
      if (runtime.accountCount === 0) {
        const error = new Error(`${region.displayName}账号池为空，请先登录该版本，或选择已有账号的 Tabbit 版本。`)
        error.code = 'account_pool_empty'
        error.status = 400
        throw error
      }
    },
  })
  try {
    await shim.ready
  } catch (error) {
    ctx.logger.error(`dsh-connect-tabbit: ${region.displayName} 回环端点启动失败`, error)
    return undefined
  }
  return { runtime, shim }
}

/**
 * Register every Tabbit region.
 *
 * Activation is best-effort by design: this plugin contributes optional model
 * routes, and a failure to do so must never take the profile down with it.
 */
export async function apply(ctx, config = {}) {
  try {
    await activate(ctx, config)
  } catch (error) {
    ctx.logger.error('dsh-connect-tabbit: 激活失败；Tabbit 模型将不可用', error)
  }
}

/** The real activation sequence, called under {@link apply}'s guard. */
async function activate(ctx, config) {
  // Preferences are read through a mutable holder so the settings surface can
  // change them without re-registering the adapter; the adapter re-reads them
  // every time it builds a model list, and the shim re-reads them per listing.
  //
  // On the 0.1.7 line the six settings-managed fields arrive as live `{ get() }`
  // references, so the holder must hold resolved values: a spread would copy the
  // references and every downstream read would compare against an object.
  let preferences = plainDeep(config) ?? {}
  let invalidateAdapter = () => {}

  /** Re-read the live config after the settings service commits a save. */
  const refreshPreferences = () => {
    preferences = plainDeep(config) ?? {}
  }

  const enabledIdsFor = (regionId) => {
    const byRegion = preferences.enabledModelIds
    if (byRegion === null || typeof byRegion !== 'object') return []
    const list = byRegion[regionId]
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id.length > 0) : []
  }

  const imageModeFor = (modelId) => {
    const overrides = preferences.imageOverrides
    if (overrides === null || typeof overrides !== 'object') return 'auto'
    const saved = overrides[modelId]
    return saved === 'on' || saved === 'off' ? saved : 'auto'
  }

  const reasoningFor = (modelId) => {
    const overrides = preferences.reasoningOverrides
    if (overrides === null || typeof overrides !== 'object') return undefined
    const saved = overrides[modelId]
    return typeof saved === 'boolean' ? saved : undefined
  }

  const store = new AccountStore({ logger: ctx.logger })
  let pendingMutation = Promise.resolve()
  const mutateAccounts = action => {
    const result = pendingMutation.then(action, action)
    pendingMutation = result.catch(() => undefined)
    return result
  }

  const started = []
  let disposed = false
  ctx.effect(() => () => { disposed = true })
  for (const region of REGIONS) {
    const settings = preferences[region.configKey] ?? {}
    if (settings.enabled === false) {
      ctx.logger.info(`dsh-connect-tabbit: ${region.displayName} 已在设置中停用`)
      continue
    }
    let embedded
    // Preserve legacy custom external URLs. Default 8800/8801 values migrate
    // to the private in-process service unless external is explicitly chosen.
    const external = settings.gatewayMode === 'external' || (settings.gatewayMode !== 'embedded' && settings.gatewayUrl?.trim() && settings.gatewayUrl.trim().replace(/\/+$/, '') !== region.defaultGatewayUrl)
    if (!external) {
      try {
        embedded = await createEmbeddedGateway({ region, origin: originFor(settings, region), logger: ctx.logger,
          usagePath: join(dirname(store.path), `token-usage-${region.id}.json`) })
        ctx.effect(() => () => { void embedded.close() })
      } catch (error) {
        ctx.logger.error(`dsh-connect-tabbit: ${region.displayName} 内置网关启动失败`, error)
        continue
      }
    }
    const gateway = new GatewayClient({
      region,
      baseUrl: embedded?.baseUrl ?? (settings.gatewayUrl || region.defaultGatewayUrl),
      apiKey: embedded?.apiKey ?? settings.gatewayApiKey ?? '',
      adminPassword: embedded?.adminPassword ?? settings.adminPassword ?? 'admin',
    })
    gateway.mode = embedded ? 'embedded' : 'external'
    const entry = await startRegion(region, gateway, ctx, enabledIdsFor, { store, settings: () => preferences[region.configKey] ?? {}, sync: () => mutateAccounts(() => syncToGateway(store, gateway, region.id)) })
    if (entry !== undefined) started.push(entry)
  }

  if (started.length === 0) {
    // Only a local failure gets here — a bound loopback port. A gateway that is
    // merely down does not: its region is built and retried in the background.
    ctx.logger.warn('dsh-connect-tabbit: 两个 Tabbit 区域的回环端点都启动失败；模型路由不可用')
    // The settings card is still mounted below so the user can fix the address
    // from inside DSH instead of editing files.
  }

  /** Region runtime by id, for the card routes. */
  const runtimeById = new Map(started.map(({ runtime }) => [runtime.region.id, runtime]))
  const accountDeps = { store, started, ctx }
  const login = new LoginManager({
    root: join(dirname(store.path), 'browser-login'),
    onCredential: async row => {
      const payload = tokenPayload(row.value)
      return mutateAccounts(() => importAccountRows([{ ...row, name: row.name || payload?.name || payload?.email || 'Tabbit 账号' }], accountDeps))
    },
  })
  ctx.effect(() => () => { void login.cancel() })

  // A region is published only once it has a catalog to offer. Registering a
  // provider whose gateway is down puts a dead route in the picker: selecting it
  // sends a request nothing answers, which the UI reports as a provider
  // rejection and blames the user's account for a channel that should never
  // have been offered.
  //
  // That gate is applied per region, in the background, rather than once at
  // activation: a gateway that comes up after DSH must still be picked up.
  const publishable = new Set()
  const announced = new Set()
  let publishedOnce = false
  let releaseAdapter
  let releaseDirectory

  const publish = () => {
    const regions = started.filter(({ runtime }) => publishable.has(runtime.region.id))
    if (regions.length === 0) return

    const { adapter, invalidate } = createTabbitAdapter({
      regions: regions.map(({ runtime, shim }) => ({
        region: runtime.region,
        shim,
        catalog: () => runtime.catalog.current(),
      })),
      imageModeFor,
      enabledIdsFor,
      reasoningFor,
      accountCountFor: id => runtimeById.get(id)?.accountCount,
      resolveAttachments: () => ctx.get('attachments'),
    })
    invalidateAdapter = invalidate
    for (const { runtime } of started) {
      runtime.invalidate = () => {
        invalidate()
        ctx.emit('llm/adapters-updated')
      }
    }

    // Release before registering: the second region to arrive widens the
    // provider id list, and those ids are still held by the first registration.
    releaseAdapter?.()
    releaseDirectory?.()
    try {
      releaseAdapter = ctx.llm.registerAdapter(
        regions.map(({ runtime }) => runtime.region.id),
        adapter,
      )
      releaseDirectory = ctx.llm.registerConfigurableProviders(
        regions.map(({ runtime }) => ({
          provider: runtime.region.id,
          displayName: runtime.region.displayName,
          settingsNs: TABBIT_SETTINGS_NS,
          settingsPath: [],
          declared: false,
        })),
      )
      if (!publishedOnce) {
        publishedOnce = true
        ctx.logger.info(
          `dsh-connect-tabbit: 已发布 ${regions.map(({ runtime }) => runtime.region.displayName).join('、')}`,
        )
      }
      // A region that arrives late widens the provider list after first paint,
      // so the client has to be told to look again.
      ctx.emit('llm/adapters-updated')
    } catch (error) {
      releaseAdapter?.()
      releaseDirectory?.()
      releaseAdapter = undefined
      releaseDirectory = undefined
      ctx.logger.error('dsh-connect-tabbit: provider 注册失败', error)
    }
  }

  /**
   * One pass of the gateway watch.
   *
   * A region becomes publishable the moment its gateway answers with a catalog.
   * Failures are announced once per region per process: a gateway that never
   * comes up must not fill the log every ten seconds.
   */
  const watchOnce = async () => {
    for (const { runtime } of started) {
      await runtime.refreshAccountState()
      if (publishable.has(runtime.region.id)) continue
      try {
        const health = await runtime.gateway.health()
        if (!health.ok) throw new Error(`HTTP ${health.status}`)
        await runtime.refreshCatalog(true)
        if (runtime.catalog.current().length > 0) publishable.add(runtime.region.id)
      } catch (error) {
        if (!announced.has(runtime.region.id)) {
          announced.add(runtime.region.id)
          ctx.logger.info(
            `dsh-connect-tabbit: ${runtime.region.displayName} 网关 ${runtime.gateway.baseUrl} `
            + `暂不可用（${messageOf(error)}）；将在后台重试`,
          )
        }
      }
    }
    publish()
  }

  if (started.length > 0) {
    // The first pass is awaited: a gateway that is already up publishes before
    // activation returns, so the provider is in the picker at first paint. A
    // gateway that is down fails that pass fast (connection refused, not a
    // timeout) and is then retried in the background instead of given up on.
    await watchOnce()
    ctx.effect(() => {
      let stopped = false
      const timer = setInterval(() => {
        if (!stopped) void watchOnce()
      }, GATEWAY_WATCH_MS)
      return () => {
        stopped = true
        clearInterval(timer)
      }
    })
  }

  ctx.effect(() => () => {
    releaseAdapter?.()
    releaseDirectory?.()
    for (const { runtime, shim } of started) {
      if (runtime.refreshTimer !== undefined) clearInterval(runtime.refreshTimer)
      shim.close()
    }
  })

  // Publish the settings surface. Two lines, one namespace:
  //
  //  * 0.1.7+ — the settings service derives a form for this Loader entry from
  //    `Config` itself and keys it by the entry id. There is nothing to name and
  //    no section to install; `installSection` no longer exists. The one thing a
  //    plugin must still do is declare which fields are settings-writable, by
  //    marking them volatile (see {@link asVolatile}) — without that the form is
  //    not published and the card silently degrades to read-only.
  //  * 0.1.5 — the service has no such derivation, so the plugin installs an
  //    explicit section. Kept as a fallback for pinned older builds.
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    if (typeof settings.configure === 'function') {
      ctx.effect(() => settings.configure({ auto: true }, ctx.fiber))
      return
    }
    try {
      settings.installSection(ctx, TABBIT_SETTINGS_NS, TABBIT_SECTION, plainDeep(config), {
        setSource(source) {
          preferences = { ...preferences, ...source() }
        },
        onChange() {
          invalidateAdapter()
          ctx.emit('llm/adapters-updated')
        },
      })
    } catch (error) {
      ctx.logger.warn('dsh-connect-tabbit: 设置分区不可用', error)
    }
  })

  // A settings save lands in the running plugin, not in a reload: the loader
  // updates the volatile references in place and announces it here. Re-read the
  // holder and let the picker rebuild from the new selection.
  ctx.on('loader/volatile-update', () => {
    refreshPreferences()
    invalidateAdapter()
    ctx.emit('llm/adapters-updated')
  })

  /**
   * The card's model route.
   *
   * `refresh=1` re-reads the catalog from the gateway *and* asks the gateway to
   * re-read Tabbit's own catalog, because both move on their own: Tabbit adds
   * and retires models, and the gateway caches the map.
   */
  ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.effect(() =>
        webCtx.webServer.register({
          kind: 'exact',
          path: MODELS_PATH,
          handler: respond(async (req, res) => {
            if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
            if (!loopbackRequest(req)) return sendJson(res, 403, { error: 'origin-not-trusted' })
            const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
            const force = params.get('refresh') === '1'
            if (force) {
              for (const { runtime } of started) {
                try {
                  await runtime.gateway.refreshModels()
                } catch (error) {
                  // A gateway that cannot re-read Tabbit still serves its own
                  // cached map; the local refresh below picks that up.
                  ctx.logger.warn(
                    `dsh-connect-tabbit: ${runtime.region.displayName} 网关模型刷新失败：${messageOf(error)}`,
                  )
                }
                try {
                  await runtime.refreshCatalog(true)
                } catch (error) {
                  ctx.logger.warn(
                    `dsh-connect-tabbit: ${runtime.region.displayName} 本地目录刷新失败：${messageOf(error)}`,
                  )
                }
              }
            }
            const models = []
            for (const { runtime } of started) {
              for (const entry of runtime.catalog.current()) {
                models.push({
                  id: entry.id,
                  name: entry.name,
                  description: entry.description,
                  region: runtime.region.id,
                  regionName: runtime.region.displayName,
                  accessType: entry.accessType,
                  usageMultiplier: entry.usageMultiplier,
                  metadataSource: entry.metadataSource,
                  supportsVision: entry.supportsVision === true,
                  contextWindow: entry.contextWindow ?? entry.maxTokens,
                  contextSource: entry.contextSource ?? 'gateway',
                })
              }
            }
            const overrides = preferences.imageOverrides
            const enabled = preferences.enabledModelIds
            const reasoning = preferences.reasoningOverrides
            sendJson(res, 200, {
              models,
              imageOverrides: overrides !== null && typeof overrides === 'object' ? overrides : {},
              reasoningOverrides: reasoning !== null && typeof reasoning === 'object' ? reasoning : {},
              enabledModelIds: enabled !== null && typeof enabled === 'object' ? enabled : {},
              regions: started.map(({ runtime }) => ({
                id: runtime.region.id,
                name: runtime.region.displayName,
                gatewayUrl: runtime.gateway.baseUrl,
                gatewayMode: runtime.gateway.mode,
                modelCount: runtime.catalog.current().length,
                accountCount: runtime.accountCount,
              })),
              refreshedAt: Date.now(),
            })
          }),
        }),
      )
    } catch (error) {
      ctx.logger.warn('dsh-connect-tabbit: 模型路由不可用', error)
    }
  })

  /**
   * The card's usage route: pool health from the gateway, credits straight from
   * Tabbit.
   *
   * The two sources fail independently and are reported independently — a dead
   * gateway must not hide the account list, and an unsupported credit path must
   * not hide the pool.
   */
  ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.effect(() =>
        webCtx.webServer.register({
          kind: 'exact',
          path: USAGE_PATH,
          handler: respond(async (req, res) => {
            if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
            if (!loopbackRequest(req)) return sendJson(res, 403, { error: 'origin-not-trusted' })
            const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
            const force = params.get('refresh') === '1'
            const telemetryOnly = params.get('telemetry') === '1'
            const regions = await Promise.all(
              REGIONS.map(async (region) => {
                const runtime = runtimeById.get(region.id)
                const base = {
                  region: region.id,
                  regionName: region.displayName,
                  gatewayUrl: runtime?.gateway.baseUrl,
                  gatewayMode: runtime?.gateway.mode,
                }
                if (runtime === undefined) {
                  return { ...base, available: false, reason: 'gateway-unreachable' }
                }
                if (!force && runtime.usage !== undefined && (telemetryOnly || Date.now() - runtime.usageAt < USAGE_TTL_MS)) {
                  // Token telemetry is local and cheap; quota stays cached so
                  // an open card does not repeatedly contact Tabbit commerce.
                  let gateway = runtime.usage.gateway
                  try { gateway = gatewayUsage(await runtime.gateway.adminStatus()) } catch { /* keep last reading */ }
                  return { ...base, available: true, ...runtime.usage, gateway }
                }
                const usage = await readRegionUsage(runtime, store, preferences)
                runtime.usage = usage
                runtime.usageAt = Date.now()
                return { ...base, available: true, ...usage }
              }),
            )
            sendJson(res, 200, { regions })
          }),
        }),
      )
    } catch (error) {
      ctx.logger.warn('dsh-connect-tabbit: 用量路由不可用', error)
    }
  })

  /** The card's account-pool route. */
  ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.effect(() =>
        webCtx.webServer.register({
          kind: 'exact',
          path: ACCOUNTS_PATH,
          handler: respond(async (req, res) => {
            if (!loopbackRequest(req)) return sendJson(res, 403, { error: 'origin-not-trusted' })
            if (req.method === 'GET') {
              sendJson(res, 200, { accounts: maskedAccounts(store), path: store.path, login: login.status() })
              return
            }
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
            let body
            try {
              body = await readJson(req)
            } catch (error) {
              // An oversized body and a malformed one are different faults; the
              // card should not tell the user their JSON is broken when it was
              // simply too big.
              if (error?.code === 'body_too_large') return sendJson(res, 413, { error: '请求体过大' })
              return sendJson(res, 400, { error: 'invalid-json' })
            }
            try {
              const action = () => handleAccountAction(body, { ...accountDeps, login })
              const result = body?.action === 'login-status' ? await action() : await mutateAccounts(action)
              if (body?.action !== 'login-status') for (const { runtime } of started) runtime.usageAt = 0
              sendJson(res, 200, { ...result, accounts: maskedAccounts(store) })
            } catch (error) {
              sendJson(res, 400, { error: messageOf(error) })
            }
          }),
        }),
      )
    } catch (error) {
      ctx.logger.warn('dsh-connect-tabbit: 账号路由不可用', error)
    }
  })

  /** The card's check-in route. */
  ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.effect(() =>
        webCtx.webServer.register({
          kind: 'exact',
          path: CHECKIN_PATH,
          handler: respond(async (req, res) => {
            if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
            if (!loopbackRequest(req)) return sendJson(res, 403, { error: 'origin-not-trusted' })
            // An optional accountIds list narrows the run to the rows the card
            // asked for (single-account button) instead of every edition.
            let selection
            try {
              const body = await readJson(req)
              if (Array.isArray(body?.accountIds)) selection = new Set(body.accountIds.filter(id => typeof id === 'string'))
            } catch { /* an empty or malformed body still means "check in all" */ }
            const regions = []
            for (const { runtime } of started) {
              const settings = preferences[runtime.region.configKey] ?? {}
              const targets = targetsOf(store, runtime.region.id)
                .filter(target => selection === undefined || selection.has(target.accountId))
              const rows = await checkinAll(targets, {
                origin: originFor(settings, runtime.region),
                checkinStatusPaths: preferences.checkinStatusPaths,
                checkinClaimPaths: preferences.checkinClaimPaths,
                rememberCheckinPath: (path) => {
                  runtime.checkinStatusPath = path
                },
                rememberCheckinClaimPath: (path) => {
                  runtime.checkinClaimPath = path
                },
              markCheckedIn: (id, now, day) => store.markCheckedIn(id, now, day),
              })
              regions.push({ region: runtime.region.id, regionName: runtime.region.displayName, rows })
            }
            sendJson(res, 200, { regions, accounts: maskedAccounts(store) })
          }),
        }),
      )
    } catch (error) {
      ctx.logger.warn('dsh-connect-tabbit: 签到路由不可用', error)
    }
  })

  // Warm the catalogs without blocking activation: the providers are registered
  // either way, and an empty catalog is how DSH hides a model group.
  for (const { runtime } of started) {
    void runtime.refreshCatalog(true).then(() => {
      if (disposed) return
      runtime.refreshTimer = setInterval(() => {
        void runtime.refreshCatalog(true)
      }, CATALOG_TTL_MS)
      runtime.refreshTimer.unref?.()
    })
  }
}

/**
 * Read one region's usage: pool health from the gateway, then credits from
 * Tabbit for every enabled account, serially.
 *
 * Every part is guarded: the panel's job is to report, not to fail.
 */
function gatewayUsage(status) {
  return {
    totalRequests: Number(status?.total_requests) || 0,
    totalSuccess: Number(status?.total_success) || 0,
    totalErrors: Number(status?.total_errors) || 0,
    successRate: Number(status?.success_rate) || 0,
    // Legacy tabbit2api names these account counts total_tokens/active_tokens.
    totalTokens: Number(status?.total_tokens) || 0,
    activeTokens: Number(status?.active_tokens) || 0,
    tokenUsage: status?.token_usage,
  }
}

async function readRegionUsage(runtime, store, preferences) {
  const settings = preferences[runtime.region.configKey] ?? {}
  const result = {
    gateway: undefined,
    gatewayError: undefined,
    pool: [],
    credits: [],
    creditsSupported: true,
    creditsError: undefined,
  }

  try {
    const status = await runtime.gateway.adminStatus()
    result.gateway = gatewayUsage(status)
  } catch (error) {
    result.gatewayError = messageOf(error)
  }

  try {
    const tokens = await runtime.gateway.listTokens()
    const byGatewayId = new Map(tokens.map((token) => [token.id, token]))
    for (const account of store.accountsFor(runtime.region.id)) {
      const tokenId = store.gatewayIdFor(account.id, runtime.region.id)
      const mirror = tokenId === undefined ? undefined : byGatewayId.get(tokenId)
      result.pool.push({
        accountId: account.id,
        accountName: account.name,
        enabled: account.enabled !== false,
        mirrored: mirror !== undefined,
        state: mirror === undefined ? 'unmirrored' : poolStateOf(mirror.status),
        totalRequests: mirror?.totalRequests ?? 0,
        errorCount: mirror?.errorCount ?? 0,
        lastUsedAt: mirror?.lastUsedAt,
      })
    }
  } catch (error) {
    result.poolError = messageOf(error)
  }

  const targets = targetsOf(store, runtime.region.id)
  if (targets.length > 0) {
    const rows = await readAllCredits(targets, {
      origin: originFor(settings, runtime.region),
      creditsPaths: preferences.creditsPaths,
      rememberCreditsPath: (path) => {
        runtime.creditsPath = path
      },
    })
    result.credits = rows
    const failed = rows.filter((row) => row.status === 'failed')
    if (failed.length === rows.length && failed.length > 0) {
      result.creditsSupported = failed.some((row) => row.code !== 'credits_unsupported')
      result.creditsError = failed[0]?.message
    }
  }

  return result
}

/** The pool as the browser may see it: no credential, ever. */
function maskedAccounts(store) {
  return store.list().map((account) => ({
    id: account.id,
    name: account.name,
    region: account.region,
    enabled: account.enabled !== false,
    preview: previewOf(account.value),
    createdAt: account.createdAt,
    lastCheckinAt: account.lastCheckinAt,
    lastCheckinDay: account.lastCheckinDay,
    gatewayIds: account.gatewayIds ?? {},
  }))
}

/** First characters of the JWT, enough to tell two accounts apart. */
function previewOf(value) {
  const text = typeof value === 'string' ? value : ''
  return text.length > 10 ? `${text.slice(0, 8)}…` : '…'
}

/**
 * The started runtime that belongs to one edition, if its gateway is up.
 *
 * An account's mirror lives in its own edition's gateway, so every pool
 * mutation has to answer "which runtime owns this account" exactly once.
 */
function runtimeOf(started, regionId) {
  return started.find((item) => item.runtime.region.id === regionId)?.runtime
}

/**
 * One account action, dispatched by `action`.
 *
 * Kept in one place so every mutation goes through the same guard: the local
 * pool is written first (it is the source of truth) and the gateway mirror is
 * updated best-effort afterwards.
 */
async function handleAccountAction(body, deps) {
  const { store, started, ctx, login } = deps
  const action = typeof body?.action === 'string' ? body.action : ''

  if (action === 'login-status') return { ok: true, login: login.status() }
  if (action === 'login-cancel') return { ok: true, login: await login.cancel() }
  if (['login', 'import', 'import-local'].includes(action)) {
    const region = REGIONS.find(candidate => candidate.id === body.region)
    if (!region) throw new Error('请选择 Tabbit 国内版或国际版。')
    if (action === 'login') return { ok: true, login: login.start(region, typeof body.name === 'string' ? body.name.trim() : '') }
    const rows = action === 'import-local'
      ? await readLocalAccounts(region)
      : parseAccountImport(body.value, { region: region.id, origin: region.defaultTabbitUrl, name: body.name })
    return importAccountRows(rows, deps)
  }

  if (action === 'add') {
    const region = REGIONS.find((candidate) => candidate.id === body.region)
    if (region === undefined) throw new Error(`未知的版本：${body.region ?? '（空）'}`)
    const account = store.add({
      name: body.name,
      value: body.value,
      region: region.id,
      enabled: body.enabled !== false,
    })
    // Mirror into this edition's gateway only. A CN cookie means nothing to the
    // global gateway, and pushing it there would put a permanently failing row
    // in that pool.
    const mirrors = []
    const runtime = runtimeOf(started, region.id)
    if (runtime === undefined) {
      mirrors.push({ region: region.id, ok: false, message: '该版本的网关当前不可用；已存入本地池，网关恢复后可同步' })
    } else {
      try {
        const { id } = await runtime.gateway.addToken({
          name: account.name,
          value: account.value,
          enabled: account.enabled !== false,
        })
        store.setGatewayId(account.id, region.id, id)
        mirrors.push({ region: region.id, ok: true })
      } catch (error) {
        mirrors.push({ region: region.id, ok: false, message: messageOf(error) })
      }
    }
    return { ok: true, account: { id: account.id }, mirrors }
  }

  if (action === 'update') {
    const account = store.update(body.id, { name: body.name, enabled: body.enabled, value: body.value })
    // A renamed or toggled account keeps its mirror; a replaced credential
    // dropped it, so re-sync just that row — and only in its own edition.
    const runtime = runtimeOf(started, account.region)
    const tokenId = store.gatewayIdFor(account.id, account.region)
    if (runtime !== undefined && tokenId !== undefined) {
      try {
        await runtime.gateway.updateToken(tokenId, {
          ...(body.name === undefined ? {} : { name: account.name }),
          ...(body.enabled === undefined ? {} : { enabled: account.enabled }),
          ...(body.value === undefined ? {} : { value: account.value }),
        })
      } catch (error) {
        ctx.logger.warn(`dsh-connect-tabbit: 账号同步到 ${runtime.region.displayName} 失败`, error)
      }
    }
    return { ok: true }
  }

  if (action === 'remove') {
    const account = store.find(body.id)
    if (account === undefined) throw new Error('账号不存在')
    const runtime = runtimeOf(started, account.region)
    if (runtime !== undefined) await removeFromGateway(store, runtime.gateway, account.region, account.id)
    store.remove(body.id)
    return { ok: true }
  }

  if (action === 'sync') {
    // Each gateway receives only the accounts bound to its own edition; the
    // filter lives in `syncToGateway`.
    const mirrors = []
    for (const { runtime } of started) {
      const rows = await syncToGateway(store, runtime.gateway, runtime.region.id)
      mirrors.push({ region: runtime.region.id, rows })
    }
    return { ok: true, mirrors }
  }

  if (action === 'test') {
    const account = store.find(body.id)
    if (account === undefined) throw new Error('账号不存在')
    const runtime = runtimeOf(started, account.region)
    if (runtime === undefined) {
      return { ok: false, rows: [{ region: account.region, ok: false, message: '该版本的网关当前不可用' }] }
    }
    const tokenId = store.gatewayIdFor(account.id, account.region)
    if (tokenId === undefined) {
      return {
        ok: false,
        rows: [{ region: account.region, ok: false, message: '该账号还没有同步到这个网关' }],
      }
    }
    try {
      const result = await runtime.gateway.testToken(tokenId)
      return { ok: result.ok, rows: [{ region: account.region, ok: result.ok, message: result.error }] }
    } catch (error) {
      return { ok: false, rows: [{ region: account.region, ok: false, message: messageOf(error) }] }
    }
  }

  throw new Error(`未知操作：${action}`)
}

/** Return counts and mirror warnings only; credentials stay on the host. */
export async function importAccountRows(rows, { store, started }) {
  const counts = { added: 0, updated: 0, present: 0 }
  // AccountStore's transaction makes a batch all-or-nothing on a disk failure.
  store.commit(() => { for (const row of rows) counts[store.upsert(row, { persist: false }).state]++ })
  const mirrors = []
  for (const region of new Set(rows.map(row => row.region))) {
    const runtime = runtimeOf(started, region)
    if (!runtime) mirrors.push({ region, rows: [{ state: 'failed', message: '账号已保存；该版本网关不可用，启动后请点击“同步到网关”。' }] })
    else {
      mirrors.push({ region, rows: await syncToGateway(store, runtime.gateway, region) })
      runtime.usageAt = 0
    }
  }
  return { ok: true, imported: counts, mirrors }
}
