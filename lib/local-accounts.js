import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createDecipheriv, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { credentialFromCookies, tokenPayload } from './credentials.js'

/** Ask Windows to unwrap this user's Tabbit encryption key over private stdio. */
export function unprotectWindows(value) {
  return new Promise((resolve, reject) => {
    const script = 'Add-Type -AssemblyName System.Security; try { $v=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::Unprotect($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r)) } catch { [Console]::Error.Write("无法读取 Tabbit 的本机登录密钥"); exit 1 }'
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    const output = []
    const timer = setTimeout(() => { child.kill(); reject(new Error('读取本机登录状态超时。')) }, 10000)
    child.stdout.on('data', chunk => output.push(chunk))
    child.once('error', () => { clearTimeout(timer); reject(new Error('无法调用 Windows 登录凭据服务。')) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error('无法读取 Tabbit 的本机登录密钥，请使用“登录 Tabbit”。'))
      resolve(Buffer.from(Buffer.concat(output).toString('utf8').trim(), 'base64'))
    })
    child.stdin.on('error', () => { clearTimeout(timer); reject(new Error('Windows 登录凭据服务已关闭。')) })
    child.stdin.end(value.toString('base64'))
  })
}

export function decryptCookie(encrypted, key, host, version) {
  const buffer = Buffer.from(encrypted)
  if (!['v10', 'v11'].includes(buffer.subarray(0, 3).toString())) throw new Error('此 Tabbit 登录状态需要在浏览器中重新登录后导入。')
  const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(3, 15))
  decipher.setAuthTag(buffer.subarray(-16))
  let result = Buffer.concat([decipher.update(buffer.subarray(15, -16)), decipher.final()])
  if (version >= 24) {
    const expected = createHash('sha256').update(host).digest()
    if (!result.subarray(0, 32).equals(expected)) throw new Error('Tabbit 登录状态校验失败，请重新登录。')
    result = result.subarray(32)
  }
  return result.toString('utf8')
}

/** Read only Tabbit authentication cookies; never copy a browser's cookie database. */
export async function readLocalAccounts(region, { roots, unwrap = unprotectWindows, openDatabase } = {}) {
  if (process.platform !== 'win32' && !roots) throw new Error('此系统请使用“登录 Tabbit”或导入凭据。')
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const directories = roots ?? ['Tabbit Browser', 'Tabbit'].map(name => join(local, name, 'User Data'))
  const host = new URL(region.defaultTabbitUrl).hostname
  const domain = host.replace(/^web\./, '')
  const accounts = []
  let locked = false
  let expired = false
  let unreadable = false
  for (const root of directories) {
    if (!existsSync(join(root, 'Local State'))) continue
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8'))
    const profiles = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^(Default|Profile \d+)$/.test(entry.name))
    let key
    for (const profile of profiles) {
      const file = join(root, profile.name, 'Network', 'Cookies')
      if (!existsSync(file)) continue
      let db
      try {
        db = openDatabase ? await openDatabase(file) : new (await import('node:sqlite')).DatabaseSync(file, { readOnly: true })
        const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value) || 0
        const rows = db.prepare("SELECT host_key, name, value, encrypted_value FROM cookies WHERE host_key IN (?, ?, ?) AND (name IN ('token','device_id','next-auth.session-token','__Secure-next-auth.session-token','authjs.session-token','__Secure-authjs.session-token') OR name GLOB 'next-auth.session-token.[0-9]*' OR name GLOB '__Secure-next-auth.session-token.[0-9]*' OR name GLOB 'authjs.session-token.[0-9]*' OR name GLOB '__Secure-authjs.session-token.[0-9]*')").all(host, domain, `.${domain}`)
        if (!rows.some(row => row.name === 'token')) continue
        const encryptedKey = Buffer.from(state.os_crypt?.encrypted_key ?? '', 'base64')
        if (rows.some(row => !row.value)) {
          if (encryptedKey.subarray(0, 5).toString() !== 'DPAPI') throw new Error('unsupported-key')
          key ??= await unwrap(encryptedKey.subarray(5))
        }
        const cookies = rows.map(row => ({ domain: row.host_key, name: row.name, value: row.value || decryptCookie(row.encrypted_value, key, row.host_key, version) }))
        const prefsPath = join(root, profile.name, 'Preferences')
        const prefs = existsSync(prefsPath) ? JSON.parse(readFileSync(prefsPath, 'utf8')) : {}
        let value
        try { value = credentialFromCookies(cookies, region.defaultTabbitUrl, prefs.tab_user_prefs?.pref_values?.['tab.instance.device_id']) }
        catch (error) { if (/过期/.test(error.message)) { expired = true; continue }; throw error }
        const payload = tokenPayload(value)
        accounts.push({ region: region.id, value, name: payload?.name || payload?.email || prefs.profile?.name || `Tabbit ${profile.name}` })
      } catch (error) {
        if (/busy|locked|unable to open/i.test(error.message) || error.code === 'EBUSY') locked = true
        else unreadable = true
      } finally {
        db?.close()
      }
    }
    key?.fill(0)
  }
  if (!accounts.length) {
    if (expired) throw new Error('本机 Tabbit 登录已过期，请点击“登录 Tabbit”重新登录。')
    if (locked) throw new Error('Tabbit 浏览器正在占用登录文件。请退出 Tabbit 后重试导入，或直接点击“登录 Tabbit”。')
    if (unreadable) throw new Error('无法读取本机 Tabbit 登录状态，请点击“登录 Tabbit”重新登录。')
    throw new Error('没有找到这个版本的本机登录账号，请选择正确版本或点击“登录 Tabbit”。')
  }
  return accounts
}
