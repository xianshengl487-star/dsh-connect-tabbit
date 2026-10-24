/** Context capacity is separate from a model's maximum reply length. */
export const UNKNOWN_CONTEXT_WINDOW = 100000

export function validContextWindow(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (typeof value === 'string' && !value.trim()) return undefined
  const tokens = Number(value)
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined
}

/** Only explicit context statements count; parameter counts and quotas do not. */
export function officialContext(row) {
  for (const field of ['context_window', 'context_length', 'max_context_tokens', 'max_context_length', 'contextWindow']) {
    const contextWindow = validContextWindow(row[field])
    if (contextWindow) return { contextWindow, contextSource: 'tabbit-field' }
  }
  const description = typeof row.description === 'string' ? row.description : ''
  const quantity = '(\\d+(?:\\.\\d+)?)\\s*(百万|万|[MK])?'
  // The live LongCat description uses 上文 rather than 上下文.
  const context = '(?:上下文|上文|context(?:\\s+(?:window|length))?)'
  const after = new RegExp(quantity + '\\s*(?:tokens?\\s*)?' + context, 'i').exec(description)
  const before = new RegExp(context + '\\s*(?:为|是|支持|up\\s+to|of|:|：)?\\s*' + quantity + '\\s*(?:tokens?)?', 'i').exec(description)
  const match = after ?? before
  if (!match) return {}
  const multiplier = { m: 1000000, k: 1000, '万': 10000, '百万': 1000000 }[match[2]?.toLowerCase()] ?? 1
  const contextWindow = validContextWindow(Number(match[1]) * multiplier)
  return contextWindow ? { contextWindow, contextSource: 'tabbit-description' } : {}
}

/** Older external gateways expose context as max_tokens; retain compatibility. */
export function modelContext(entry, fallback = UNKNOWN_CONTEXT_WINDOW) {
  const contextWindow = validContextWindow(entry.contextWindow) ?? validContextWindow(entry.maxTokens)
  return contextWindow
    ? { contextWindow, contextSource: entry.contextSource ?? 'gateway' }
    : { contextWindow: fallback, contextSource: 'fallback' }
}
