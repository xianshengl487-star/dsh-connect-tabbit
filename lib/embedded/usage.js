import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

const count = n => Number.isSafeInteger(n) && n >= 0

/** Accept counters, never infer token usage from account counts or quota %. */
export function reportedUsage(data) {
  // These are envelopes, not an unrestricted recursive search through tool
  // results: a quoted usage object in model content must not become a receipt.
  const containers = [data, data?.payload, data?.payload?.chunk_payload]
  for (const envelope of containers) {
    const u = envelope?.usage ?? envelope?.token_usage ?? envelope?.usage_metadata
    if (!u || typeof u !== 'object') continue
    const input = u.prompt_tokens ?? u.input_tokens
    const output = u.completion_tokens ?? u.output_tokens
    if (!count(input) || !count(output)) continue
    const total = count(u.total_tokens) ? u.total_tokens : input + output
    if (!count(total) || total < input + output) continue
    return { prompt_tokens: input, completion_tokens: output, total_tokens: total }
  }
}

/** Model-independent approximation, NOT an upstream tokenizer or a bill. */
export function estimateTokens(text = '') {
  if (!text) return 0
  let wide = 0, other = 0
  for (const char of text) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)) wide++
    else other += char.length
  }
  return wide + Math.ceil(other / 4)
}

export function measuredUsage(prompt, output, reported) {
  const usage = reported ?? { prompt_tokens: estimateTokens(prompt), completion_tokens: estimateTokens(output) }
  return { ...usage, total_tokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
    source: reported ? 'reported' : 'estimated',
    ...(reported ? {} : { method: 'cjk-characters-plus-other-utf16-divided-by-4', excludes: 'hidden reasoning, image and server-side tokens' }) }
}

const empty = () => ({ requests: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
const validTotals = row => row && ['requests', 'prompt_tokens', 'completion_tokens', 'total_tokens'].every(key => count(row[key]))

/** Only counts and bounded request metadata are stored; never prompts or keys. */
export class UsageLedger {
  constructor({ path, logger } = {}) {
    this.path = path; this.logger = logger
    this.reported = empty(); this.estimated = empty(); this.recent = []
    this.startedAt = new Date().toISOString()
    if (path) {
      try {
        const saved = JSON.parse(readFileSync(path, 'utf8'))
        if (saved.version === 1 && validTotals(saved.reported) && validTotals(saved.estimated)) {
          this.reported = saved.reported; this.estimated = saved.estimated
          this.startedAt = saved.startedAt
          this.recent = Array.isArray(saved.recent) ? saved.recent.slice(0, 50) : []
        }
      } catch (error) { if (error.code !== 'ENOENT') this.logger?.warn?.('Tabbit Token 记录无法读取，将重新计数。') }
    }
  }

  record(row) {
    const total = this[row.usage.source]
    total.requests++
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) total[key] += row.usage[key]
    this.recent.unshift(row); this.recent.length = Math.min(this.recent.length, 50)
    if (!this.path) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temporary = this.path + '.tmp'
      writeFileSync(temporary, JSON.stringify(this.snapshot()), { mode: 0o600 })
      renameSync(temporary, this.path)
      this.storageError = undefined
    } catch {
      this.storageError = 'Token 记录暂时无法写入磁盘，当前运行期间仍继续计数。'
      this.logger?.warn?.(this.storageError)
    }
  }

  snapshot() {
    return { version: 1, startedAt: this.startedAt, reported: { ...this.reported }, estimated: { ...this.estimated },
      recent: this.recent, ...(this.storageError ? { storageError: this.storageError } : {}) }
  }
}
