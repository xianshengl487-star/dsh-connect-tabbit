/** Scan a copied Global-edition cookie store (read-only) to detect an intl login without touching the running browser. */
import { copyFileSync } from 'node:fs'
import { readLocalAccounts } from '../lib/local-accounts.js'
import { REGIONS } from '../lib/gateway.js'

const region = REGIONS.find(row => row.id === 'tabbit-global')
const source = process.env.TABBIT_GLOBAL_COOKIES
const copy = process.env.TABBIT_GLOBAL_COOKIES_COPY
if (source && copy) copyFileSync(source, copy)
const result = await readLocalAccounts(region, {
  ...(copy ? { openDatabase: async () => new (await import('node:sqlite')).DatabaseSync(copy, { readOnly: true }) } : {}),
})
console.log(JSON.stringify({
  region: region.id,
  found: result.length,
  accounts: result.map(row => ({ name: row.name, hasValue: typeof row.value === 'string' && row.value.length > 10 })),
}))
