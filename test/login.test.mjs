import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { parseAccountImport, credentialFromCookies, normalizeCredential } from '../lib/credentials.js'
import { AccountStore, syncToGateway } from '../lib/accounts.js'
import { decryptCookie, readLocalAccounts } from '../lib/local-accounts.js'
import { BrowserPipe, LoginManager } from '../lib/login.js'
import { importAccountRows } from '../lib/index.js'

const cn = { id: 'tabbit-cn', defaultTabbitUrl: 'https://web.tabbit.com' }
const global = { id: 'tabbit-global', defaultTabbitUrl: 'https://web.tabbit.ai' }
const options = { region: cn.id, origin: cn.defaultTabbitUrl }
const jwt = (id = 'user-a', extra = {}) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ id, exp: Date.now() / 1000 + 3600, ...extra })).toString('base64url')}.signature`
const token = jwt()
const newStore = () => new AccountStore({ path: join(mkdtempSync(join(tmpdir(), 'tabbit-login-')), 'accounts.json') })
const until = async predicate => {
  const deadline = Date.now() + 2000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)) }
}

test('imports JWT, composite token, Bearer and an exported pool', () => {
  assert.equal(parseAccountImport(token, options)[0].value, token)
  assert.equal(normalizeCredential(`Bearer ${token}|session|device`), `${token}|session|device`)
  assert.equal(parseAccountImport(JSON.stringify({ version: 1, accounts: [{ region: cn.id, name: 'main', value: token }] }), options)[0].name, 'main')
})
test('imports a Cookie header and joins URL-encoded chunked NextAuth cookies in order', () => {
  assert.equal(parseAccountImport(`Cookie: token=${token}; next-auth.session-token=session; device_id=device`, options)[0].value, `${token}|session|device`)
  const cookies = [{ name: 'token', value: token, domain: '.tabbit.com' }, { name: '__Secure-next-auth.session-token.1', value: 'tail', domain: 'web.tabbit.com' }, { name: '__Secure-next-auth.session-token.0', value: 'head%2E', domain: 'web.tabbit.com' }]
  assert.equal(credentialFromCookies(cookies, cn.defaultTabbitUrl, 'device'), `${token}|head.tail|device`)
  assert.equal(parseAccountImport(cookies, options).length, 1)
})
test('rejects expired, masked, malformed and cross-edition imports before saving', () => {
  assert.throws(() => normalizeCredential(jwt('expired', { exp: 1 })), /过期/)
  for (const input of ['aaa.bbb.ccc', 'eyJhb…', '[]', '{}', '[broken']) assert.throws(() => parseAccountImport(input, options))
  assert.throws(() => parseAccountImport({ accounts: [{ region: global.id, value: token }] }, options), /版本/)
  assert.throws(() => credentialFromCookies([{ name: 'token', value: token, domain: 'web.tabbit.com.evil.example' }], cn.defaultTabbitUrl), /没有找到/)
  assert.throws(() => credentialFromCookies([{ name: 'token', value: token, domain: 'web.tabbit.ai' }], cn.defaultTabbitUrl), /没有找到/)
})
test('renewing a login preserves account id, disabled state, check-in and gateway mapping', () => {
  const store = newStore()
  const original = store.add({ name: 'main', value: token, region: cn.id, enabled: false })
  store.setGatewayId(original.id, cn.id, 'remote-1')
  store.markCheckedIn(original.id)
  const renewed = store.upsert({ name: 'main', value: jwt('user-a', { exp: Date.now() / 1000 + 7200 }), region: cn.id })
  assert.equal(renewed.state, 'updated')
  assert.equal(renewed.account.id, original.id)
  assert.equal(renewed.account.enabled, false)
  assert.equal(renewed.account.lastCheckinDay, original.lastCheckinDay)
  assert.equal(store.gatewayIdFor(original.id, cn.id), 'remote-1')
  assert.equal(new AccountStore({ path: store.path }).list().length, 1)
})
test('sync renews credentials, repairs deleted gateway entries, and disables remote accounts', async () => {
  const store = newStore()
  const account = store.add({ name: 'main', value: token, region: cn.id })
  store.setGatewayId(account.id, cn.id, 'remote-1')
  const updates = []
  let remote = [{ id: 'remote-1' }]
  const gateway = { listTokens: async () => remote, updateToken: async (id, patch) => updates.push({ id, patch }), addToken: async () => ({ id: 'remote-2' }) }
  await syncToGateway(store, gateway, cn.id)
  assert.equal(updates[0].patch.value, token)
  remote = []
  await syncToGateway(store, gateway, cn.id)
  assert.equal(store.gatewayIdFor(account.id, cn.id), 'remote-2')
  remote = [{ id: 'remote-2' }]
  store.update(account.id, { enabled: false })
  await syncToGateway(store, gateway, cn.id)
  assert.deepEqual(updates.at(-1), { id: 'remote-2', patch: { enabled: false } })
})
test('batch import commits once, deduplicates, masks results and keeps gateway errors actionable', async () => {
  const store = newStore()
  let saves = 0
  const save = store.save.bind(store)
  store.save = () => { saves++; return save() }
  const rows = parseAccountImport({ accounts: [{ value: token, name: 'main' }, { value: token, name: 'main' }] }, options)
  const result = await importAccountRows(rows, { store, started: [] })
  assert.equal(saves, 1)
  assert.deepEqual(result.imported, { added: 1, updated: 0, present: 1 })
  assert.equal(result.mirrors[0].rows[0].state, 'failed')
  assert.equal(JSON.stringify(result).includes(token), false)
})
test('a disk failure rejects the whole import and rolls back memory', async () => {
  const store = newStore()
  store.save = () => { throw new Error('disk full') }
  await assert.rejects(importAccountRows([{ region: cn.id, value: token }], { store, started: [] }), /disk full/)
  assert.equal(store.list().length, 0)
})
test('Windows v10 cookies validate the host digest and authentication tag', () => {
  const key = randomBytes(32), nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const encrypted = Buffer.concat([Buffer.from('v10'), nonce, cipher.update(Buffer.concat([createHash('sha256').update('web.tabbit.com').digest(), Buffer.from(token)])), cipher.final(), cipher.getAuthTag()])
  assert.equal(decryptCookie(encrypted, key, 'web.tabbit.com', 24), token)
  assert.throws(() => decryptCookie(encrypted, key, 'web.tabbit.ai', 24), /校验/)
  encrypted[30] ^= 1
  assert.throws(() => decryptCookie(encrypted, key, 'web.tabbit.com', 24))
})
test('local import reads only the selected edition and known profile directories', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tabbit-local-'))
  mkdirSync(join(root, 'Default', 'Network'), { recursive: true })
  writeFileSync(join(root, 'Local State'), '{}')
  writeFileSync(join(root, 'Default', 'Network', 'Cookies'), '')
  let closed = false
  const openDatabase = async () => ({
    prepare(sql) { return sql.includes('meta') ? { get: () => ({ value: '24' }) } : { all: (...hosts) => {
      assert.deepEqual(hosts, ['web.tabbit.com', 'tabbit.com', '.tabbit.com'])
      assert.match(sql, /name IN \('token'/)
      return [{ host_key: 'web.tabbit.com', name: 'token', value: token }]
    } } },
    close() { closed = true },
  })
  assert.equal((await readLocalAccounts(cn, { roots: [root], openDatabase }))[0].value.split('|')[0], token)
  assert.equal(closed, true)
  await assert.rejects(readLocalAccounts(cn, { roots: [root], openDatabase: () => { throw new Error('database locked') } }), /占用/)
})
test('login automatically saves exactly once and exposes no credential in status', async () => {
  let reads = 0, saved = 0, closed = 0
  const manager = new LoginManager({ root: 'unused', intervalMs: 2, open: async () => ({ readCredential: async () => ++reads > 1 ? token : undefined, close: async () => { closed++ } }), onCredential: async row => { assert.equal(row.region, cn.id); assert.equal(row.value, token); saved++; return { ok: true } } })
  assert.equal(manager.start(cn, 'main').status, 'starting')
  assert.throws(() => manager.start(global), /已有登录/)
  await until(() => manager.status().status === 'success')
  assert.equal(saved, 1)
  assert.equal(closed, 1)
  assert.equal(JSON.stringify(manager.status()).includes(token), false)
})
test('cancel during startup closes only the managed login window without saving', async () => {
  let completeOpen, saved = false, closed = false
  const manager = new LoginManager({ root: 'unused', open: () => new Promise(resolve => { completeOpen = resolve }), onCredential: () => { saved = true } })
  manager.start(cn)
  await manager.cancel()
  completeOpen({ readCredential: async () => token, close: async () => { closed = true } })
  await until(() => closed)
  assert.equal(manager.status().status, 'cancelled')
  assert.equal(saved, false)
})
test('login timeout and browser closure become visible failures', async () => {
  for (const failure of ['timeout', 'closed']) {
    let closed = false
    const manager = new LoginManager({ root: 'unused', timeoutMs: failure === 'timeout' ? 0 : 10000, open: async () => ({ readCredential: async () => { throw new Error('窗口已关闭') }, close: async () => { closed = true } }), onCredential: () => assert.fail('must not save') })
    manager.start(cn)
    await until(() => manager.status().status === 'error')
    assert.match(manager.status().message, failure === 'timeout' ? /超时/ : /已关闭/)
    assert.equal(closed, true)
  }
})
test('browser debugging pipe handles partial frames, concurrent replies and disconnects', async () => {
  const child = new EventEmitter()
  child.stdio = [null, null, null, new PassThrough(), new PassThrough()]
  const pipe = new BrowserPipe(child, { timeoutMs: 200 })
  const first = pipe.send('Target.getTargets'), second = pipe.send('Network.getCookies')
  child.stdio[4].write('{"id":2,"result":{"cookies":[]}}\0{"id":1,')
  child.stdio[4].write('"result":{"targetInfos":[]}}\0')
  assert.deepEqual(await first, { targetInfos: [] })
  assert.deepEqual(await second, { cookies: [] })
  const pending = pipe.send('Browser.getVersion')
  child.emit('exit', 0)
  await assert.rejects(pending, /已关闭/)
})
