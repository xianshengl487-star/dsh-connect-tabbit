import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { credentialFromCookies } from './credentials.js'

export function findLoginBrowser({ platform = process.platform, env = process.env } = {}) {
  const candidates = []
  if (env.TABBIT_BROWSER_PATH) candidates.push(env.TABBIT_BROWSER_PATH)
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    for (const base of [local, join(local, 'Programs'), env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      candidates.push(join(base, 'Tabbit Browser', 'Application', 'Tabbit Browser.exe'), join(base, 'Tabbit', 'Application', 'Tabbit Browser.exe'))
    }
    for (const drive of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      candidates.push(`${drive}:/Tabbit Browser/Application/Tabbit Browser.exe`)
    }
    for (const drive of 'CDEFGHIJKLMNOPQRSTUVWXYZ') candidates.push(`${drive}:/tabbit/Application/Tabbit Browser.exe`)
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Tabbit.app/Contents/MacOS/Tabbit', '/Applications/Tabbit Browser.app/Contents/MacOS/Tabbit Browser')
  }
  const binary = candidates.find(file => existsSync(file))
  if (!binary) throw new Error('没有找到 Tabbit 浏览器。请先安装 Tabbit，或使用下方“导入账号”。')
  return binary
}

/** Chromium's private debugging pipe avoids exposing a browser-control TCP port. */
export class BrowserPipe {
  constructor(child, { timeoutMs = 15000 } = {}) {
    this.child = child
    this.timeoutMs = timeoutMs
    this.nextId = 0
    this.pending = new Map()
    this.buffer = ''
    child.stdio[4].setEncoding('utf8')
    child.stdio[4].on('data', chunk => {
      this.buffer += chunk
      let end
      while ((end = this.buffer.indexOf('\0')) !== -1) {
        const message = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        let data
        try { data = JSON.parse(message) } catch { continue }
        const pending = this.pending.get(data.id)
        if (!pending) continue
        this.pending.delete(data.id)
        clearTimeout(pending.timer)
        if (data.error) pending.reject(new Error('无法读取登录窗口，请关闭后重新点击“登录 Tabbit”。'))
        else pending.resolve(data.result)
      }
    })
    const fail = () => {
      this.closed = true
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Tabbit 登录窗口已关闭，请重新登录。'))
      }
      this.pending.clear()
    }
    child.once('error', fail)
    child.once('exit', fail)
    child.stdio[3].on('error', fail)
    child.stdio[4].on('error', fail)
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('Tabbit 登录窗口已关闭。'))
    return new Promise((resolveMessage, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Tabbit 登录窗口响应超时，请重试。')) }, this.timeoutMs)
      this.pending.set(id, { resolve: resolveMessage, reject, timer })
      this.child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`)
    })
  }

  async close() {
    if (this.closed) return
    try { await this.send('Browser.close') }
    catch { if (!this.closed) this.child.kill() }
  }
}

export async function openLoginBrowser({ origin, root, binary = findLoginBrowser() }) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const directory = mkdtempSync(join(root, 'login-'))
  const child = spawn(binary, [
    `--user-data-dir=${directory}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', `${origin}/newtab`,
  ], { windowsHide: false, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  const pipe = new BrowserPipe(child)
  const close = async () => {
    await pipe.close()
    if (child.exitCode === null && !pipe.closed) await new Promise(resolveExit => {
      const timer = setTimeout(() => { child.kill(); resolveExit() }, 2000)
      child.once('exit', () => { clearTimeout(timer); resolveExit() })
    })
    // Only this invocation's newly-created, isolated profile may be removed.
    if (resolve(directory).startsWith(`${resolve(root)}${sep}`)) {
      try { rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }) }
      catch { /* A browser child may still hold a file; the private profile can be removed later. */ }
    }
  }
  try {
    const { targetInfos } = await pipe.send('Target.getTargets')
    const target = targetInfos.find(info => info.type === 'page' && info.url.startsWith(origin))
    const { targetId } = target ?? await pipe.send('Target.createTarget', { url: `${origin}/newtab` })
    const { sessionId } = await pipe.send('Target.attachToTarget', { targetId, flatten: true })
    return {
      async readCredential() {
        const { cookies } = await pipe.send('Network.getCookies', { urls: [`${origin}/`] }, sessionId)
        if (!cookies.some(cookie => cookie.name === 'token')) return undefined
        return credentialFromCookies(cookies, origin)
      },
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

/** Login is independent of the card lifecycle; closing settings cannot lose a completed login. */
export class LoginManager {
  constructor({ root, onCredential, open = openLoginBrowser, timeoutMs = 10 * 60 * 1000, intervalMs = 1500 }) {
    this.root = root
    this.onCredential = onCredential
    this.open = open
    this.timeoutMs = timeoutMs
    this.intervalMs = intervalMs
  }

  status() {
    const session = this.session
    if (!session) return { status: 'idle' }
    return { id: session.id, region: session.region, status: session.status, message: session.message, result: session.result }
  }

  start(region, name) {
    if (['waiting', 'starting', 'saving'].includes(this.session?.status)) throw new Error('已有登录窗口，请完成登录或先取消。')
    const session = { id: randomUUID(), region: region.id, status: 'starting', expiresAt: Date.now() + this.timeoutMs }
    this.session = session
    const finish = async () => {
      clearTimeout(session.timer)
      await session.browser?.close()
    }
    session.finish = finish
    const poll = async () => {
      if (session.status !== 'waiting') return
      try {
        if (Date.now() >= session.expiresAt) throw new Error('登录等待已超时，请重新点击“登录 Tabbit”。')
        const value = await session.browser.readCredential()
        if (session.status !== 'waiting') return
        if (value) {
          session.status = 'saving'
          session.result = await this.onCredential({ value, region: region.id, name })
          session.status = 'success'
          await finish()
          return
        }
        session.timer = setTimeout(poll, this.intervalMs)
        session.timer.unref?.()
      } catch (error) {
        if (session.status === 'cancelled') return
        session.status = 'error'
        session.message = error.message
        await finish()
      }
    }
    void (async () => {
      try {
        session.browser = await this.open({ origin: region.defaultTabbitUrl, root: this.root })
        if (session.status === 'cancelled') return await finish()
        session.status = 'waiting'
        await poll()
      } catch (error) {
        if (session.status === 'cancelled') return
        session.status = 'error'
        session.message = error.message
        await finish()
      }
    })()
    return this.status()
  }

  async cancel() {
    const session = this.session
    if (!session || !['starting', 'waiting'].includes(session.status)) return this.status()
    session.status = 'cancelled'
    await session.finish()
    return this.status()
  }
}
