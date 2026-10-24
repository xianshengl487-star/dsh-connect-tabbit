/**
 * The Tabbit pi-ai adapter.
 *
 * One adapter instance serves both editions, because `registerAdapter` maps a
 * *set* of providers onto a single adapter — registering each region separately
 * would leave only the last one owned.
 *
 * Every model's `baseUrl` points at its region's loopback shim, so choosing a
 * model is enough to select the region, the gateway, and the account pool behind
 * it.
 *
 * @module dsh-connect-tabbit/adapter
 */
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRetryPolicy, LlmError } from '@deepseek-ai/dsh-llm'
import { forPurpose } from './embedded/request-context.js'
import { modelContext } from './model-context.js'

/** Idle ceiling while one stream read is outstanding. */
// Tool protocol is buffered until valid JSON is complete. SSE keepalives keep
// the HTTP path alive but pi-ai only resets its watchdog on semantic chunks.
// The gateway's 20-minute run budget must expire before this outer watchdog.
const STREAM_IDLE_TIMEOUT_MS = 25 * 60000

/** Image budgets at the `dsh-llm-pi-ai` defaults. */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
}

/** Inert pi-ai auth plane: this route authenticates only through the shim. */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-connect-tabbit: the tabbit route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false
    },
  },
}

/** Required by pi-ai; monetary billing is unavailable for quota subscriptions. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** Context window when the gateway declares no usable ceiling. */
const FALLBACK_CONTEXT_WINDOW = 128000

/**
 * The badge the picker shows for one model, derived from tabbit2api's
 * `access_type`.
 *
 * The distinction matters to the user: `free_unlimited` never touches the
 * quota, `free_metered` spends it, and `premium_only` needs a paid plan. A
 * model whose access type is unknown keeps its bare name rather than being
 * labelled with a guess.
 */
function badgeOf(accessType) {
  if (accessType === 'free_unlimited') return '免费'
  if (accessType === 'free_metered') return '计量'
  if (accessType === 'premium_only') return 'PRO'
  return undefined
}

/**
 * Whether one model may receive images.
 *
 * `auto` follows the gateway's `supports_vision`; `on` / `off` are the user's
 * explicit override. An unrecognised mode degrades to `auto`, so a stale saved
 * value cannot silently drop a capability.
 */
function imageEnabled(entry, imageMode) {
  if (imageMode === 'on') return true
  if (imageMode === 'off') return false
  return entry.supportsVision === true
}

/**
 * Whether a model reasons before answering.
 *
 * tabbit2api does not publish a reasoning flag, so this is inferred from the
 * model id — the only signal available. The inference is deliberately narrow
 * (`thinking` / `reason`): declaring reasoning for a model that does not have
 * it makes pi-ai send `reasoning_effort`, which the gateway forwards to Tabbit
 * and Tabbit may reject. The settings section exposes a per-model override for
 * the cases the guess gets wrong.
 */
export function infersReasoning(entry) {
  if (typeof entry.reasoning === 'boolean') return entry.reasoning
  const id = String(entry?.id ?? '').toLowerCase()
  return id.includes('thinking') || id.includes('reason')
}

/**
 * Map a gateway model onto a pi-ai model descriptor.
 *
 * Two deliberate choices:
 *
 * - **`maxTokens` is not declared.** `dsh-llm-pi-ai` treats a declared value as
 *   the model's configured *output* ceiling and sends it as `max_tokens`; the
 *   gateway's `max_tokens` is a *context* figure, so declaring it would cap
 *   replies at the context size. Leaving it out lets the harness apply its own
 *   default.
 * - **`supportsDeveloperRole: false`.** pi-ai decides the system-prompt role as
 *   `reasoning && compat.supportsDeveloperRole ? 'developer' : 'system'`, and
 *   auto-detects `true` for any URL it does not recognise. This route's baseUrl
 *   is a loopback shim, so nothing matches and every reasoning model would emit
 *   `role: "developer"` — a role Tabbit's web API does not have.
 */
export function toPiModel(entry, baseUrl, providerId, imageMode = 'auto') {
  const reasoning = entry.reasoningOverride === true ? true : entry.reasoningOverride === false ? false : infersReasoning(entry)
  const badge = badgeOf(entry.accessType)
  const { contextWindow } = modelContext(entry, FALLBACK_CONTEXT_WINDOW)
  return {
    id: entry.id,
    // `listModels` forwards only id/name/modalities, so the access badge has
    // nowhere else to travel and is folded into the name. Every DSH-side join
    // keys on the model **id**, so this is display-only.
    name: [entry.name, badge, entry.usageMultiplier === undefined ? undefined : `${entry.usageMultiplier}×用量`].filter(Boolean).join(' · '),
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: imageEnabled(entry, imageMode) ? ['text', 'image'] : ['text'],
    reasoning,
    ...(reasoning
      ? {
          thinkingLevelMap: {
            off: 'off',
            minimal: null,
            low: 'low',
            medium: 'medium',
            high: 'high',
            xhigh: null,
            max: null,
          },
        }
      : {}),
    cost: NO_COST,
    contextWindow,
    compat: { maxTokensField: 'max_tokens', supportsDeveloperRole: false },
  }
}

/**
 * Narrow a catalog to the models the user enabled.
 *
 * An **empty list means "no filter"**, following the convention the Qoder and
 * WorkBuddy bundles use: a fresh install has saved nothing and must still see
 * every model. Once the list is non-empty it becomes an allow-list.
 *
 * Shared because two readers must agree — the adapter builds the model list DSH
 * routes through, and the shim answers `GET /v1/models`.
 */
export function filterByEnabled(models, enabled) {
  const list = Array.isArray(enabled) ? enabled.filter((id) => typeof id === 'string' && id.length > 0) : []
  if (list.length === 0) return models
  const allowed = new Set(list)
  return models.filter((entry) => allowed.has(entry.id))
}

/**
 * Assemble one adapter covering every started region.
 *
 * @param options.regions - `[{ region, shim, catalog }]`.
 * @param options.imageModeFor - `(modelId) => string`, read per model build.
 * @param options.enabledIdsFor - `(regionId) => string[]`, read per model build.
 * @param options.reasoningFor - `(modelId) => boolean | undefined`, the user's
 *   per-model reasoning override; `undefined` keeps the inferred value.
 */
export function createTabbitAdapter(options) {
  const runtimes = options.regions
  if (runtimes.length === 0) throw new Error('dsh-connect-tabbit: no regions to adapt')
  const imageModeFor = options.imageModeFor ?? (() => 'auto')
  const enabledIdsFor = options.enabledIdsFor ?? (() => [])
  const reasoningFor = options.reasoningFor ?? (() => undefined)

  const buildModels = (runtime) => {
    if (options.accountCountFor?.(runtime.region.id) === 0) return []
    const baseUrl = `${runtime.shim.baseUrl()}/v1`
    const enabled = enabledIdsFor(runtime.region.id)
    return filterByEnabled(runtime.catalog(), enabled).map((entry) => {
      const override = reasoningFor(entry.id)
      const annotated = override === undefined ? entry : { ...entry, reasoningOverride: override }
      return toPiModel(annotated, baseUrl, runtime.region.id, imageModeFor(entry.id))
    })
  }

  const buildProfiles = () => {
    const profiles = new Map()
    for (const runtime of runtimes) {
      const providerId = runtime.region.id
      const displayName = runtime.region.displayName
      const provider = {
        ...createProvider({
          id: providerId,
          name: displayName,
          auth: {
            apiKey: {
              name: 'Tabbit loopback shim token',
              async resolve({ credential }) {
                const apiKey = credential?.key
                return apiKey === undefined || apiKey.length === 0
                  ? undefined
                  : { auth: { apiKey }, source: displayName }
              },
            },
          },
          models: buildModels(runtime),
          api: openAICompletionsApi(),
        }),
        getModels: () => buildModels(runtime),
      }
      profiles.set(providerId, {
        provider: providerId,
        displayName,
        streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        retryPolicy: resolveRetryPolicy(undefined, `dsh-connect-tabbit.${providerId}.retryPolicy`),
        configuredMaxTokens: new Map(),
        modelErrors: new Map(),
        ...REQUEST_IMAGE_BUDGETS,
        piProvider: provider,
      })
    }
    return profiles
  }

  let profiles = buildProfiles()

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    // Resolve at request time: attachment services may mount after this adapter.
    resolveAttachments: options.resolveAttachments,
    auth: INERT_AUTH,
    resolveApiKey: async (provider) => {
      const runtime = runtimes.find((entry) => entry.region.id === provider)
      return runtime?.shim.token()
    },
  })

  // An existing conversation can still name a now-hidden empty region.
  // Refuse that stale selection before pi-ai turns a missing account into AUTH.
  const requireAccount = provider => {
    if (options.accountCountFor?.(provider) !== 0) return
    const region = runtimes.find(row => row.region.id === provider)?.region
    throw new LlmError(`${region?.displayName ?? provider}没有已启用的账号。请先登录该版本，或选择已有账号的 Tabbit 版本。`, 'ACCOUNT_POOL_EMPTY')
  }
  const originalStream = adapter.stream.bind(adapter)
  const withReportedUsage = async function* (source) {
    for await (const chunk of source) {
      // pi-ai synthesizes a zero counter when a compatible upstream omits usage.
      // A completed answer with no counters is unknown usage, not a free bill.
      if (chunk.type === 'usage' && !Object.values(chunk.usage).some(value => typeof value === 'number' && value > 0)) continue
      yield chunk
    }
  }
  adapter.stream = async function* (request) {
    requireAccount(request.provider)
    yield* withReportedUsage(originalStream(forPurpose(request)))
  }
  const originalPrepare = adapter.prepareCall.bind(adapter)
  adapter.prepareCall = async (provider, ...args) => {
    requireAccount(provider)
    const prepared = await originalPrepare(provider, ...args)
    // DSH's agent loop invokes this captured stream directly; it does not
    // call adapter.stream(). Apply the same usage rule on both entry points.
    return { ...prepared, stream: request => withReportedUsage(prepared.stream(forPurpose(request))) }
  }

  return {
    adapter,
    invalidate: () => {
      profiles = buildProfiles()
    },
    providerIds: runtimes.map((runtime) => runtime.region.id),
  }
}
