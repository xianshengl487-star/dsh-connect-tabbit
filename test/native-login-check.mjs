import { openLoginBrowser, findLoginBrowser } from '../lib/login.js'

console.log(JSON.stringify({ browser: findLoginBrowser() }))
const browser = await openLoginBrowser({ origin: 'https://web.tabbit.com', root: 'E:/op2025/dsh-local-plugins/tabbit/.verification-profile' })
try {
  const credential = await browser.readCredential()
  console.log(JSON.stringify({ browserControl: 'connected', credentialPresent: !!credential }))
} finally {
  await browser.close()
}
