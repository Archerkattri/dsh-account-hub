/**
 * Render smoke test for the client half: loads client.js with a stubbed module
 * loader and a minimal React shim, then walks the component tree with real
 * account data from the running Harness (falling back to fixtures). It catches
 * the errors a browser would show as a blank settings page - an undefined
 * variable, a bad hook order, a branch that only renders for one account shape.
 *
 *   node dev/render-check.mjs [state-json-url]
 */

const stateUrl = process.argv[2] ?? 'http://127.0.0.1:3080/plugins/account-hub/state'

let loaded
globalThis.window = {
  __ModuleLoader__: { load(definition) { loaded = definition } },
  open() { return undefined },
}

/** Fetch the live account view, or use a fixture when the Harness is not up. */
async function readState() {
  try {
    const response = await fetch(stateUrl, { signal: AbortSignal.timeout(4000) })
    if (response.ok) return await response.json()
  } catch {
    // fall through to the fixture
  }
  return {
    proxy: { running: true, port: 8317 },
    routing: 'round-robin',
    geminiChannel: [],
    fixes: { changed: false },
    client: { available: true, registered: true },
    providers: [
      { id: 'codex', name: 'ChatGPT', hint: 'ChatGPT Plus / Pro' },
      { id: 'claude', name: 'Claude', hint: 'Claude Pro / Max' },
      { id: 'antigravity', name: 'Google Antigravity', hint: 'Google account' },
      { id: 'xai', name: 'Grok', hint: 'X Premium' },
    ],
    routes: [{ provider: 'cliproxy-gpt', label: 'ChatGPT (CLIProxy)', models: ['gpt-6-sol', 'gpt-5.6-sol'] }],
    routing: 'fill-first',
    accountSelections: { codex: { selected: 'codex-fixture.json' } },
    accounts: [
      {
        id: 'codex-fixture.json',
        name: 'codex-fixture.json',
        provider: 'codex',
        label: 'fixture@example.com',
        displayLabel: 'work',
        email: 'fixture@example.com',
        status: 'error',
        disabled: false,
        unavailable: false,
        selectableForProvider: true,
        selectedForProvider: true,
        requiresSignIn: false,
        plan: 'plus',
        subscriptionUntil: '2026-11-29T19:09:25+00:00',
        expiresAt: '2026-12-01T17:34:29Z',
        quotaBlocked: true,
        cooldowns: [{ remaining_seconds: 60 }],
        cooldown: { scope: 'credential', reason: 'credential_quota', remainingSeconds: 60 },
        failure: { message: 'The usage limit has been reached', resetsInSeconds: 3600 },
        limits: {
          primary: { usedPercent: 100, windowMinutes: 300, resetsAtEpoch: 1795295555 },
          secondary: { usedPercent: 16, windowMinutes: 10080, resetsAtEpoch: 1795882355 },
          credits: '0',
          activeLimit: 'premium',
        },
        success: 3,
        failed: 1,
        recent: Array.from({ length: 12 }, (_, index) => ({ time: `t${index}`, success: 1, failed: 0 })),
        usage: [
          { window: '5h', usedPercent: 100, resetsAtEpoch: 1795295555 },
          { window: 'weekly', usedPercent: 16, resetsAtEpoch: 1795882355 },
        ],
        models: ['gpt-6-sol', 'gpt-6-astra'],
      },
      {
        id: 'codex-second.json',
        name: 'codex-second.json',
        provider: 'codex',
        label: 'second@example.com',
        displayLabel: 'personal',
        email: 'second@example.com',
        status: 'active',
        disabled: false,
        unavailable: false,
        selectableForProvider: true,
        selectedForProvider: false,
        requiresSignIn: false,
        usage: [],
        models: ['gpt-6-sol'],
      },
      {
        id: 'antigravity-fixture.json',
        name: 'antigravity-fixture.json',
        provider: 'antigravity',
        label: 'fixture@example.com',
        email: 'fixture@example.com',
        status: 'active',
        disabled: false,
        unavailable: false,
        selectableForProvider: true,
        selectedForProvider: false,
        requiresSignIn: false,
        usage: [
          { group: 'Claude/GPT', window: '5h', usedPercent: 0, resetsAtEpoch: 1795295555 },
          { group: 'Gemini', window: '5h', usedPercent: 3, resetsAtEpoch: 1795295555 },
          { group: 'Claude/GPT', window: 'weekly', usedPercent: 0, resetsAtEpoch: 1795882355 },
          { group: 'Gemini', window: 'weekly', usedPercent: 2, resetsAtEpoch: 1795882355 },
        ],
        models: ['gemini-4-hydrogen-xhigh'],
      },
    ],
  }
}

// --- React shim ------------------------------------------------------------

const FIXTURES = new Map()
let cursor = 0
let queue = []

function element(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity) }
}

const React = {
  createElement: element,
  useState(initial) {
    const value = cursor < queue.length ? queue[cursor] : initial
    cursor += 1
    return [value, () => undefined]
  },
  useEffect() { return undefined },
  useRef(value) { return { current: value } },
  useCallback(callback) { return callback },
  useMemo(factory) { return factory() },
}

/** Render one component function with a hook queue of initial values. */
function renderComponent(component, props) {
  const previousCursor = cursor
  const previousQueue = queue
  cursor = 0
  queue = FIXTURES.get(component.name) ?? []
  try {
    return component(props)
  } finally {
    cursor = previousCursor
    queue = previousQueue
  }
}

/** Walk a tree, expanding every component function it meets. */
function walk(node, path, errors, depth = 0) {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return
  if (Array.isArray(node)) {
    node.forEach((child, index) => walk(child, `${path}[${index}]`, errors, depth))
    return
  }
  if (typeof node.type === 'function') {
    const name = node.type.name || 'anonymous'
    if (depth > 24) {
      errors.push(`${path}: component depth exceeded at ${name}`)
      return
    }
    try {
      const rendered = renderComponent(node.type, { ...node.props, children: node.children })
      walk(rendered, `${path}>${name}`, errors, depth + 1)
    } catch (error) {
      errors.push(`${path}>${name}: ${error.message}`)
    }
    return
  }
  walk(node.children, `${path}>${String(node.type)}`, errors, depth + 1)
}

// --- run ------------------------------------------------------------------

await import(new URL('../client.js', import.meta.url).href)

if (loaded === undefined) throw new Error('client.js did not call __ModuleLoader__.load')
const plugin = loaded.factory(specifier => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require("${specifier}")`)
})

const registrations = []
plugin.apply({
  slots: {
    inject(_slot, register) { register() },
    register(options, component) { registrations.push({ options, component }) },
  },
})

const state = await readState()
const section = registrations.find(entry => entry.options.name === 'settings.section')
const icon = registrations.find(entry => entry.options.name === 'settings.section.icon')
if (section === undefined) throw new Error('no settings.section registration')

FIXTURES.set(section.component.name, [
  state,
  undefined,
  false,
  { provider: 'codex', url: 'https://example.invalid/sign-in', state: 'abc' },
  'Model lists updated',
  '',
  false,
  false,
])

const errors = []
const tree = renderComponent(section.component, { close() {} })
walk(tree, 'settings.section', errors)
if (icon !== undefined) {
  try {
    icon.component({ size: 16, active: true })
  } catch (error) {
    errors.push(`settings.section.icon: ${error.message}`)
  }
}

// Also render the empty and no-proxy shapes, which take different branches.
FIXTURES.set(section.component.name, [
  { proxy: { running: false, error: 'not installed' }, accounts: [], providers: [], routes: [] },
  undefined, false, undefined, undefined, '', false, false,
])
walk(renderComponent(section.component, { close() {} }), 'settings.section(empty)', errors, 1)

if (errors.length > 0) {
  console.error('render check failed:')
  for (const failure of errors) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`render check passed: ${registrations.length} slot registrations, account data ${state.accounts?.length ?? 0} accounts`)

