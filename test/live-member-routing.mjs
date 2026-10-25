/** Live member-routing acceptance: a premium-only model on the real global pool must log member-routed and complete. */
import { createEmbeddedGateway } from '../lib/embedded/gateway.js'
import { AccountStore } from '../lib/accounts.js'
import { GatewayClient, REGIONS } from '../lib/gateway.js'

const region = REGIONS.find(row => row.id === 'tabbit-global')
const store = new AccountStore()
const accounts = store.accountsFor(region.id).filter(row => row.enabled !== false)
const members = accounts.filter(row => row.memberLevel && !/^(none|free|normal|standard|普通|免费|非会员|0)$/i.test(row.memberLevel))
if (!members.length) throw new Error('no member account with a recognized level; refresh credits on the card first')
if (accounts.length < 2) throw new Error('need at least two accounts in the pool to prove routing')

const routingLog = []
const logger = { info: msg => routingLog.push(String(msg)), warn: msg => routingLog.push('WARN ' + String(msg)) }
const embedded = await createEmbeddedGateway({ region, logger })
const gateway = new GatewayClient({ region, baseUrl: embedded.baseUrl, apiKey: embedded.apiKey, adminPassword: embedded.adminPassword })
try {
  for (const account of accounts) await gateway.addToken({ name: account.name, value: account.value, enabled: true, memberLevel: account.memberLevel })
  const premiumModel = process.env.TABBIT_PREMIUM_MODEL ?? 'kimi-k3'
  const res = await fetch(`${embedded.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${embedded.apiKey}` },
    body: JSON.stringify({ model: premiumModel, stream: false, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] }),
    signal: AbortSignal.timeout(180000),
  })
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content ?? ''
  const routed = routingLog.find(line => line.includes('member-routed'))
  const accountLine = routed?.match(/account=([^ ]+)/)?.[1]
  console.log(JSON.stringify({
    premiumModel,
    completion: text.trim() ? 'passed' : 'FAILED',
    text: text.trim().slice(0, 40),
    memberRouted: Boolean(routed),
    routedAccount: accountLine ?? null,
    isMemberAccount: members.some(row => row.name === accountLine),
  }))
} finally {
  await gateway.close?.()
  await embedded.close()
}
