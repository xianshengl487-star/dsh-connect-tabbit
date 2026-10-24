/** Real account checks. Built-in service is the default; the stored pool is read only. */
import assert from 'node:assert/strict'
import { GatewayClient, REGIONS } from '../lib/gateway.js'
import { createEmbeddedGateway } from '../lib/embedded/gateway.js'
import { AccountStore } from '../lib/accounts.js'
import { createTabbitShim } from '../lib/shim.js'
import { createTabbitAdapter } from '../lib/adapter.js'

export async function verifyLive(fullChain = false) {
  const region = REGIONS.find(row => row.id === (process.env.TABBIT_REGION ?? 'tabbit-cn'))
  assert.ok(region, 'unknown region')
  const embedded = process.env.TABBIT_GATEWAY_URL ? undefined : await createEmbeddedGateway({ region })
  let shim
  try {
    const gateway = new GatewayClient({ region, baseUrl: process.env.TABBIT_GATEWAY_URL ?? embedded.baseUrl,
      apiKey: embedded?.apiKey ?? process.env.TABBIT_GATEWAY_API_KEY,
      adminPassword: embedded?.adminPassword ?? process.env.TABBIT_ADMIN_PASSWORD ?? 'admin' })
    if (embedded) {
      const store = new AccountStore()
      for (const account of store.accountsFor(region.id)) await gateway.addToken({ name: account.name, value: account.value, enabled: account.enabled })
    }
    assert.equal((await gateway.health()).ok, true)
    const [catalog, status, accounts] = await Promise.all([gateway.listModels(), gateway.adminStatus(), gateway.listTokens()])
    assert.ok(catalog.length > 0, 'no catalog; log in to this edition first')
    assert.ok(catalog.every(row => row.id && row.name))
    assert.equal(typeof status.total_requests, 'number')
    assert.ok(accounts.every(row => !Object.hasOwn(row, 'value')))
    console.log(JSON.stringify({ gateway: embedded ? 'embedded' : 'external', models: catalog.length, accounts: accounts.length, controlPlane: 'passed' }))
    if (!fullChain) return
    shim = createTabbitShim({ gateway, region, resolveModels: () => catalog })
    await shim.ready
    assert.equal((await fetch(`${shim.baseUrl()}/v1/models`)).status, 401)
    const models = await fetch(`${shim.baseUrl()}/v1/models`, { headers: { authorization: `Bearer ${shim.token()}` } })
    assert.equal((await models.json()).data.length, catalog.length)
    if (process.env.TABBIT_TEST_COMPLETION === '1') {
      assert.ok(accounts.some(row => row.enabled !== false), 'login before testing a completion')
      const { adapter } = createTabbitAdapter({ regions: [{ region, shim, catalog: () => catalog }] })
      let text = '', reason
      for await (const row of adapter.stream({ provider: region.id, model: 'best', messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply only OK.' }] }], tools: [], signal: AbortSignal.timeout(60000) })) {
        if (row.type === 'text-delta') text += row.text
        if (row.type === 'finish') reason = row.reason
      }
      assert.equal(reason.kind, 'stop')
      assert.ok(text.trim())
      console.log(JSON.stringify({ completion: 'passed', text: text.trim() }))
    }
    console.log('PASS: gateway -> shim -> DSH adapter; stored accounts were not modified')
  } finally { await shim?.close(); await embedded?.close() }
}
