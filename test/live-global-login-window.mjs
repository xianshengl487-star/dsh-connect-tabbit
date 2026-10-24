/** Global-edition login window smoke check: open the isolated browser on web.tabbit.ai, confirm CDP control, close. */
import { openLoginBrowser, findLoginBrowser } from '../lib/login.js'

console.log(JSON.stringify({ browser: findLoginBrowser() }))
const browser = await openLoginBrowser({ origin: 'https://web.tabbit.ai', root: 'C:/Users/maoyaowei/AppData/Local/Temp/tabbit-global-login-verify' })
try {
  const credential = await browser.readCredential()
  console.log(JSON.stringify({ browserControl: 'connected', origin: 'https://web.tabbit.ai', credentialPresent: !!credential }))
} finally {
  await browser.close()
}
