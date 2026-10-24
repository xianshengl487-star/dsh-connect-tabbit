/** Import the detected Global-edition browser login into the plugin's account pool (same as the settings-card import button). */
import { readLocalAccounts } from '../lib/local-accounts.js'
import { AccountStore } from '../lib/accounts.js'
import { REGIONS } from '../lib/gateway.js'

const region = REGIONS.find(row => row.id === 'tabbit-global')
const found = await readLocalAccounts(region)
if (!found.length) throw new Error('no global login detected in local browser profiles')
const store = new AccountStore()
for (const account of found) {
  store.upsert({ name: account.name, value: account.value, region: region.id })
}
const pool = store.accountsFor(region.id)
console.log(JSON.stringify({
  imported: found.length,
  poolSize: pool.length,
  pool: pool.map(row => ({ name: row.name, region: row.region, enabled: row.enabled !== false })),
}))
