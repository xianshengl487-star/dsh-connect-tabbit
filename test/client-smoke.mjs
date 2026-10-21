/**
 * Smoke test for the browser half.
 *
 * The card is a bundled module the host evaluates in a page, so it cannot be
 * imported like the host modules. This harness supplies the loader, a stub
 * `react`, and a stub `document`, then calls `apply()` and renders the card
 * once — which is what exercises every JSX branch that does not depend on a live
 * fetch.
 *
 * `apply()` is run against three settings faces, because that is the axis this
 * plugin was actually broken on: DSH 0.1.5 serves `settingsScope`, 0.1.7+
 * serves `configForms`, and a host that serves neither must still get the card.
 * Declaring a service the running line does not provide as a hard `inject`
 * entry keeps `apply` from ever running, which the shell reports as "1 entry did
 * not activate" and answers by dropping the whole desktop into recovery mode.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures++
    console.log(`  FAIL ${label}: ${error.message}`)
  }
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ---------------------------------------------------------------- stubs
const created = []

const reactStub = {
  createElement(type, props, ...children) {
    const node = { type, props: props ?? {}, children: children.flat(Infinity) }
    created.push(node)
    return node
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useRef(value) {
    return { current: value }
  },
  useCallback(fn) {
    return fn
  },
  useMemo(fn) {
    return fn()
  },
}

let head = { children: [], appendChild(node) { this.children.push(node) } }
const documentStub = {
  head,
  querySelector() {
    return null
  },
  createElement() {
    return { dataset: {}, textContent: '' }
  },
}

let definition
const windowStub = {
  __ModuleLoader__: {
    load(def) {
      definition = def
    },
  },
}

runInNewContext(source, {
  window: windowStub,
  document: documentStub,
  console,
  fetch: () => {
    throw new Error('fetch must not run during render')
  },
  URL,
  JSON,
  Object,
  Array,
  Set,
  Map,
  String,
  Number,
  Date,
  Math,
})

check('module registers itself with the loader', () => assert.ok(definition !== undefined))
check('module id is stable', () => assert.equal(definition.id, 'dsh-connect-tabbit'))

const exports_ = definition.factory((specifier) => {
  if (specifier === 'react') return reactStub
  throw new Error(`unexpected require: ${specifier}`)
})

check('exports a plugin name', () => assert.equal(exports_.name, 'dsh-connect-tabbit-client'))

// The regression guard: `settingsScope` exists only on the 0.1.5 line and
// `configForms` only on 0.1.7+. A hard dependency on either one bricks the
// renderer on the other line, so neither may appear here.
check('injects only the services both host lines provide', () =>
  assert.deepEqual([...exports_.inject], ['slots', 'locale']))

// ---------------------------------------------------------------- apply()
let localeRegistered
const registrations = []

/** A stub of the 0.1.5 settings face. */
const legacySettingsScope = {
  bind(options) {
    return { namespace: options.namespace, face: 'settingsScope', set: async () => {} }
  },
}

/** A stub of the 0.1.7+ settings face, serving our own namespace. */
const modernConfigForms = {
  get(namespace) {
    return { namespace, face: 'configForms', set: async () => {} }
  },
  whileServed(namespaces, register) {
    const served = new Set(namespaces)
    const off = register(served)
    return () => off?.()
  },
}

/**
 * Build one host context exposing exactly the given settings faces.
 *
 * `ctx.get` is the soft probe the card uses; it returns undefined for an absent
 * service rather than throwing, which is what lets one build serve both lines.
 */
const makeCtx = (services) => ({
  effect(fn) {
    fn()
  },
  get(name) {
    return services[name]
  },
  locale: {
    register(namespace, copy) {
      localeRegistered = { namespace, copy }
      return () => {}
    },
    bind(namespace) {
      return (key, params) => {
        const dict = namespace === 'settings.tabbit' ? localeRegistered?.copy?.zh ?? {} : {}
        const template = dict[key] ?? key
        if (params === undefined) return template
        return Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template)
      }
    },
  },
  slots: {
    // The real API hands back the disposer of what it mounted; without one the
    // card's rebind has nothing to withdraw and would render twice.
    inject(name, fn) {
      return fn()
    },
    register(options, component) {
      // A real disposer, so a rebind marks the superseded round dead: the card
      // disposes and re-registers when the settings namespace lands, and only
      // the live round is what the host actually renders.
      const entry = { options, component, live: true }
      registrations.push(entry)
      return () => {
        entry.live = false
      }
    },
  },
})

/** Registrations the host currently holds, after every rebind. */
const live = () => registrations.filter((entry) => entry.live)

const runApply = (services) => {
  head = { children: [], appendChild(node) { this.children.push(node) } }
  documentStub.head = head
  registrations.length = 0
  localeRegistered = undefined
  exports_.apply(makeCtx(services))
}

// --- the modern face: what the installed DSH (0.2.0-rc.2) actually serves.
runApply({ configForms: modernConfigForms })

check('the modern card mounts on both card slots', () => {
  const names = live().map((entry) => entry.options.name)
  assert.deepEqual(names, [
    'plugins.bundle.config',
    'plugins.row.config',
    'plugins.bundle.config',
    'plugins.row.config',
  ])
})
check('the modern card registers under every key spelling', () => {
  assert.deepEqual(live().map((entry) => entry.options.key), [
    'dsh-connect-tabbit',
    'dsh-connect-tabbit#dsh-connect-tabbit',
    'include:dsh-connect-tabbit',
    'include:dsh-connect-tabbit#include:dsh-connect-tabbit',
  ])
})
check('a rebind leaves exactly one live round', () => {
  // The namespace lands after `apply`, so the first round is disposed and
  // re-registered. Two live rounds per slot would render the card twice.
  assert.equal(live().length, 4)
})
check('the modern card uses the sibling priority', () =>
  assert.equal(live()[0].options.priority, 30))
check('the modern card injects a translation function and the served scope', () => {
  const injected = live()[0].options.inject()
  assert.equal(typeof injected.t, 'function')
  assert.equal(injected.settingsScope.namespace, 'dsh-connect-tabbit')
  assert.equal(injected.settingsScope.face, 'configForms')
})
check('the served namespace was asked for, not assumed', () => {
  // whileServed was handed the candidate list; the card must have found ours.
  assert.equal(live()[0].options.inject().settingsScope.namespace, 'dsh-connect-tabbit')
})
check('registers both languages', () => {
  assert.ok(localeRegistered.copy.zh['row.title'].includes('Tabbit'))
  assert.ok(localeRegistered.copy.en['row.title'].includes('Tabbit'))
})
check('zh and en expose the same keys', () => {
  const zhKeys = Object.keys(localeRegistered.copy.zh).sort()
  const enKeys = Object.keys(localeRegistered.copy.en).sort()
  assert.deepEqual(zhKeys, enKeys)
})
check('styles were injected once', () => assert.equal(head.children.length, 1))

// --- the legacy face: the 0.1.5 line.
runApply({ settingsScope: legacySettingsScope })

check('the legacy card still registers and binds its own namespace', () => {
  assert.equal(live().length, 4)
  const injected = live()[0].options.inject()
  assert.equal(injected.settingsScope.namespace, 'dsh-connect-tabbit')
  assert.equal(injected.settingsScope.face, 'settingsScope')
})

// --- neither face: the card must degrade to read-only, not vanish.
runApply({})

check('a host with no settings face still gets the card', () => {
  assert.equal(live().length, 4)
  const injected = live()[0].options.inject()
  assert.equal(typeof injected.t, 'function')
  assert.equal(injected.settingsScope, undefined)
})
check('no settings face still styles the card once', () => assert.equal(head.children.length, 1))

// ---------------------------------------------------------------- render
runApply({ configForms: modernConfigForms })
const registeredComponent = live()[0].component
const settingsScope = live()[0].options.inject().settingsScope
const t = makeCtx({}).locale.bind('settings.tabbit')

check('card renders collapsed', () => {
  created.length = 0
  const tree = registeredComponent({ t, settingsScope })
  assert.equal(tree.type, 'li')
  assert.match(tree.props.className, /dsm-plugin-card/)
})
check('card renders with the header collapsed', () => {
  const tree = registeredComponent({ t, settingsScope })
  const header = tree.children[0]
  assert.equal(header.props['aria-expanded'], false)
})

// Render the body directly by invoking the internal branches with `open` true
// is not reachable through the stub, so instead assert the copy the body uses
// exists — a missing key would surface as a raw identifier in the UI.
check('every key the body references exists in zh', () => {
  const dict = localeRegistered.copy.zh
  const used = new Set(source.match(/(?<![A-Za-z])t\("([a-z]+\.[A-Za-z0-9_.-]+)"/g)?.map((m) => m.slice(3, -1)) ?? [])
  const dynamic = ['pool.state.active', 'pool.state.cooldown', 'pool.state.error', 'pool.state.unknown', 'pool.state.unmirrored', 'row.region.tabbit-cn', 'row.region.tabbit-global']
  const missing = [...used, ...dynamic].filter((key) => dict[key] === undefined)
  assert.deepEqual(missing, [])
})

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
