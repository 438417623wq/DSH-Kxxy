/**
 * Front-end assembly smoke test.
 *
 * `lib/client.js` is a browser module: it hands itself to `window.__ModuleLoader__`
 * and receives React through a `require` shim. Loading it here with minimal stubs
 * is enough to catch the class of bug that static syntax checks miss — an object
 * literal that reuses a key (e.g. a read-only HTTP helper named `get` silently
 * shadowing the state getter), a missing export, or a broken registration.
 *
 * No rendering happens: `h` returns a plain descriptor and hooks return their
 * initial value, so nothing touches a DOM.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (value) => ({ current: value }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn(),
  Fragment: 'Fragment',
  Component: class {},
  Suspense: 'Suspense',
}

const PRIMITIVES_STUB = new Proxy({}, { get: (_target, key) => `primitive:${String(key)}` })

function installBrowserStubs() {
  const registrations = []
  const cleanups = []
  const documentStub = {
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { append() {} },
    querySelector: () => null,
  }
  let loaded = null
  globalThis.window = { __ModuleLoader__: { load: (definition) => { loaded = definition } } }
  globalThis.document = documentStub
  return {
    get loaded() { return loaded },
    registrations,
    cleanups,
    ctx: {
      effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup },
      locale: { register() {} },
      sidebarRightTabs: { register() {} },
      slots: {
        // The real host re-injects when a target slot appears; calling straight away
        // is enough to observe what the plugin registers.
        inject(_name, run) { return run() },
        register(spec, component) { registrations.push({ spec, component }) },
      },
    },
  }
}

test('the client module assembles into a working sidebar pane without a DOM', async () => {
  const browser = installBrowserStubs()
  try {
    await import('../plugins/dsh-codex-sidebar/lib/client.js')
    const definition = browser.loaded
    assert.ok(definition, 'client.js must register itself with the module loader')
    assert.equal(definition.id, 'dsh-codex-sidebar')

    const plugin = definition.factory((name) => {
      if (name === 'react') return REACT_STUB
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return PRIMITIVES_STUB
      throw new Error(`unexpected require: ${name}`)
    })
    assert.deepEqual(plugin.inject, ['slots', 'locale', 'sidebarRightTabs'])
    plugin.apply(browser.ctx)

    const names = browser.registrations.map((entry) => entry.spec.name)
    assert.deepEqual(names, ['sidebar.right.tab.guide.entry', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])

    const pane = browser.registrations.find((entry) => entry.spec.name === 'sidebar.right.pane.tab')
    const { model } = pane.spec.inject('session-1')

    // `model.get()` is the synchronous state getter. A second helper sharing that
    // key would turn it into a Promise and every read below would be undefined.
    assert.equal(typeof model.get, 'function')
    const snapshot = model.get()
    assert.equal(snapshot.phase, 'loading')
    assert.equal(snapshot.pendingAccess, 'approval')
    assert.equal(snapshot.workspace, null)
    assert.deepEqual(snapshot.history, [])
    assert.equal(typeof model.lookup, 'function', 'read-only lookups live on their own key')
    for (const key of ['update', 'subscribe', 'refresh', 'post', 'setFold', 'scrollFor', 'markdown', 'dispose']) {
      assert.equal(typeof model[key], 'function', `model.${key} must be callable`)
    }

    // Subscribers observe every publish, including the draft counter used to detect
    // whether the user typed while a request was in flight.
    const seen = []
    const stop = model.subscribe((next) => seen.push(next))
    model.update({ draft: 'hello' })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].draft, 'hello')
    assert.equal(seen[0].draftVersion, 1)
    stop()
    model.update({ draft: 'later' })
    assert.equal(seen.length, 1, 'unsubscribed listeners must not fire again')

    // The cached session keeps the same model instance.
    assert.equal(pane.spec.inject('session-1').model, model)
    assert.notEqual(pane.spec.inject('session-2').model, model)
  } finally {
    delete globalThis.window
    delete globalThis.document
  }
})
