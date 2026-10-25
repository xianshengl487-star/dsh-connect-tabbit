/** Live matrix diagnosis: each enabled account × representative models, one tiny completion each. */
import { createEmbeddedGateway } from '../lib/embedded/gateway.js'
import { AccountStore } from '../lib/accounts.js'
import { GatewayClient, REGIONS } from '../lib/gateway.js'

const regionId = process.env.TABBIT_REGION ?? 'tabbit-global'
const region = REGIONS.find(row => row.id === regionId)
const store = new AccountStore()
const accounts = store.accountsFor(region.id).filter(row => row.enabled !== false)
const modelIds = (process.env.TABBIT_MODELS ?? 'claude-sonnet-5-5,best,kimi-k3').split(',').map(s => s.trim()).filter(Boolean)

for (const account of accounts) {
  const embedded = await createEmbeddedGateway({ region })
  const gateway = new GatewayClient({ region, baseUrl: embedded.baseUrl, apiKey: embedded.apiKey, adminPassword: embedded.adminPassword })
  try {
    await gateway.addToken({ name: account.name, value: account.value, enabled: true, memberLevel: account.memberLevel })
    const catalog = await gateway.listModels()
    for (const modelId of modelIds) {
      const row = catalog.find(m => m.id === modelId)
      const result = await probe(embedded, modelId)
      console.log(JSON.stringify({ account: account.name, memberLevel: account.memberLevel ?? null, model: modelId, accessType: row?.accessType ?? '?', ok: result.ok, text: result.text.slice(0, 60) }))
    }
  } finally {
    await gateway.close?.()
    await embedded.close()
  }
}

async function probe(embedded, modelId) {
  try {
    const res = await fetch(`${embedded.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${embedded.apiKey}` },
      body: JSON.stringify({ model: modelId, stream: false, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] }),
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) return { ok: false, text: `HTTP ${res.status}: ${(await res.text()).slice(0, 140)}` }
    const data = await res.json()
    const text = data.choices?.[0]?.message?.content ?? ''
    return text.trim() ? { ok: true, text } : { ok: false, text: '(empty body)' }
  } catch (error) {
    return { ok: false, text: String(error?.message ?? error).slice(0, 140) }
  }
}
