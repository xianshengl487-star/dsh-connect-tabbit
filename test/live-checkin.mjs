/** Live daily check-in verification with the real stored CN account (read status first, claim only if not signed). */
import { AccountStore } from '../lib/accounts.js'
import { readCheckinStatus, claimCheckin, parseTokenValue } from '../lib/tabbit.js'

const store = new AccountStore()
const accounts = store.accountsFor('tabbit-cn')
if (!accounts.length) throw new Error('no tabbit-cn account in pool')
const account = accounts.find(row => row.enabled !== false) ?? accounts[0]
console.log(JSON.stringify({ account: account.name, enabled: account.enabled !== false }))
const status = await readCheckinStatus({ origin: 'https://web.tabbit.com', token: parseTokenValue(account.value) })
console.log(JSON.stringify({ status: { known: status.known, todayCheckedIn: status.todayCheckedIn, activityOpen: status.activityOpen, day: status.day } }))
if (status.known && !status.todayCheckedIn) {
  const claimed = await claimCheckin({ origin: 'https://web.tabbit.com', token: parseTokenValue(account.value) })
  console.log(JSON.stringify({ claimed }))
  const after = await readCheckinStatus({ origin: 'https://web.tabbit.com', token: parseTokenValue(account.value) })
  console.log(JSON.stringify({ after: { known: after.known, todayCheckedIn: after.todayCheckedIn, day: after.day } }))
} else {
  console.log(JSON.stringify({ skipped: 'already signed today or status unknown' }))
}
