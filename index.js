/**
 * Account Hub — host half (v3).
 *
 * One plugin for the whole subscription stack:
 * - Owns one local CLIProxyAPI instance: headless auto-start on mount, a
 *   liveness watchdog, management-key handling, and the Accounts JSON API
 *   under `/plugins/account-hub` (sign-in, listing, enable/disable, refresh,
 *   cooldown reset, removal, model sync, routing, and provider-exclusive account selection).
 *
 * Secret hygiene: management keys live in the DSH credential seam
 * (`ctx.credentials`), never in plugin files, patches, logs, or error bodies.
 * Exclusive account-selection metadata contains only account names and previous
 * status flags in a local ignored file; no credential material is copied.
 *
 * Nothing here calls a model. The model routes themselves are ordinary
 * `llm-pi-ai` provider profiles that point at the CLIProxyAPI port directly.
 *
 * @module @local/dsh-account-hub
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { REFS, redact, readSecret, writeSecret, migrateLegacyFile, removeLegacyFile } from './lib/secrets.js'
import { preferenceFor, planAccountSelection, shouldRestoreBeforeStatusAction } from './lib/account-selection.js'
import { planStrategyTransition, validateTransitionCredentials } from './lib/routing-transition.js'
import { codexUsageWindows, parseAntigravityUsage } from './lib/usage.js'
import { planProxyFixes } from './lib/proxy-fixes.js'

/** The web-server service is required: every endpoint below is served by it. */
export const inject = ['webServer', 'llm']

const BASE_PATH = '/plugins/account-hub'

/** Providers the bundled proxy can sign in, in display order. */
const PROVIDERS = [
  { id: 'codex', name: 'ChatGPT', hint: 'ChatGPT Plus / Pro subscription' },
  { id: 'claude', name: 'Claude', hint: 'Claude Pro / Max subscription' },
  { id: 'antigravity', name: 'Google Antigravity', hint: 'Google account with Gemini access' },
  { id: 'xai', name: 'Grok', hint: 'X Premium subscription' },
  { id: 'kimi', name: 'Kimi', hint: 'Moonshot Kimi account' },
  { id: 'kimi-ai', name: 'Kimi AI', hint: 'Moonshot Kimi AI account' },
  { id: 'meta', name: 'Meta', hint: 'Meta AI account' },
  { id: 'devin', name: 'Devin', hint: 'Devin account' },
]

/** Where the proxy keeps its configuration and credentials. */
function paths() {
  const home = process.env.CLIPROXY_HOME ?? join(homedir(), '.cli-proxy-api')
  return {
    home,
    config: process.env.CLIPROXY_CONFIG ?? join(home, 'config.yaml'),
    legacyKeyFile: join(home, '.account-hub-key'),
    port: Number(process.env.CLIPROXY_PORT ?? 8317),
    binary: process.env.CLIPROXY_BIN ?? 'cli-proxy-api',
  }
}

/** Fail-closed message when no writable credential seam is mounted. */
const NO_SEAM_MESSAGE = 'no writable credential service is mounted; the management key was not stored. Mount the DSH credential service or set CLIPROXY_MANAGEMENT_KEY in the environment.'

/** One shared in-flight readiness promise; re-checked after it settles. */
let readiness

/**
 * Ask the proxy whether it is listening. Any HTTP answer counts, 401 included.
 * @param port - loopback port the proxy listens on.
 * @returns true when something answered.
 */
async function listening(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/v1/models`, {
      signal: AbortSignal.timeout(1500),
      headers: { authorization: 'Bearer liveness-probe' },
    })
    return true
  } catch {
    return false
  }
}

/**
 * Read a plaintext management key out of the proxy's YAML. A value the proxy
 * has already replaced with a bcrypt hash is skipped: a hash cannot
 * authenticate.
 * @param file - absolute config path.
 * @returns the plaintext key, or undefined when the file names none.
 */
function readManagementKey(file) {
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, 'utf8')
  const match = text.match(/^[ \t]*(?:secret-key|secret_key)[ \t]*:[ \t]*["']?([^"'\s#]+)/m)
  const value = match?.[1]
  if (value === undefined) return undefined
  return /^\$(?:2[abxy]|argon2)/.test(value) ? undefined : value
}

/**
 * Resolve the management key: environment, credential seam, a one-time legacy
 * migration, proxy config plaintext, then generate-and-store. A newly generated
 * key is stored ONLY in the credential seam; the plugin never writes a plaintext
 * key file. With no writable seam it fails closed instead of persisting a secret.
 * @param ctx - plugin context.
 * @param config - absolute config path.
 * @param legacyKeyFile - legacy plaintext key path (migrated, never created).
 * @returns the key and whether a start is needed for it to take effect.
 */
async function ensureManagementKey(ctx, config, legacyKeyFile) {
  const fromEnv = process.env.CLIPROXY_MANAGEMENT_KEY
  if (fromEnv !== undefined && fromEnv.length > 0) return { key: fromEnv, fresh: false }
  // The credential service can be transiently unavailable during a remount;
  // retry briefly so a startup race never regenerates a working key.
  let stored
  for (let attempt = 0; attempt < 3 && stored === undefined; attempt += 1) {
    stored = await readSecret(ctx, REFS.managementKey)
    if (stored === undefined && attempt < 2) await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (stored !== undefined) return { key: stored, fresh: false }
  if (existsSync(legacyKeyFile)) {
    // One-time migration of a pre-existing plaintext key into the seam, then
    // remove the file. Fail closed: if no writable seam is mounted, abort rather
    // than operate on a plaintext-only key (the file is left for a later retry).
    const legacy = readFileSync(legacyKeyFile, 'utf8').trim()
    if (legacy.length > 0) {
      if (!(await writeSecret(ctx, REFS.managementKey, legacy))) throw new Error(NO_SEAM_MESSAGE)
      removeLegacyFile(legacyKeyFile)
      return { key: legacy, fresh: false }
    }
    removeLegacyFile(legacyKeyFile)
  }
  const fromConfig = readManagementKey(config)
  if (fromConfig !== undefined) {
    // The proxy config holds a plaintext key; mirror it into the seam. Fail closed
    // if the seam cannot store it, so the plugin never relies on a secret that is
    // not in the credential seam.
    if (!(await writeSecret(ctx, REFS.managementKey, fromConfig))) throw new Error(NO_SEAM_MESSAGE)
    return { key: fromConfig, fresh: false }
  }
  const key = `mgmt-${randomBytes(12).toString('hex')}`
  // Seam-first rotation: the new key must be durably stored in the credential
  // seam BEFORE the proxy config changes. The plugin never writes a plaintext
  // key file. If no writable seam is mounted, abort without touching the config
  // — a rotated proxy key with no stored copy is unrecoverable, and a plaintext
  // fallback would break the no-persisted-secrets guarantee.
  const inSeam = await writeSecret(ctx, REFS.managementKey, key)
  if (!inSeam) {
    throw new Error(NO_SEAM_MESSAGE)
  }
  mkdirSync(join(config, '..'), { recursive: true })
  const prior = existsSync(config) ? readFileSync(config, 'utf8') : ''
  let next
  if (/^management:/m.test(prior)) {
    // Update the existing block in place. Appending a second management block
    // makes the YAML invalid and the proxy refuses to start.
    next = prior.replace(
      /(management:[ \t]*\n(?:[ \t]+[^\n]*\n)*?[ \t]+secret-key:[ \t]*)["']?[^"'\n]+["']?/,
      `$1"${key}"`,
    )
    if (next === prior) {
      next = prior.replace(/^(management:[ \t]*)$/m, `$1\n  secret-key: "${key}"`)
    }
  } else {
    const header = prior.trim().length > 0 && !prior.endsWith('\n') ? '\n' : ''
    next = `${prior}${header}management:\n  allow-remote: false\n  secret-key: "${key}"\n`
  }
  writeFileSync(config, next, 'utf8')
  return { key, fresh: true }
}

/**
 * Stop whatever instance currently owns the port so a freshly written
 * management key can take effect.
 */
function stopProxy() {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/F', '/IM', 'cli-proxy-api.exe'], { stdio: 'ignore', windowsHide: true })
    return
  }
  spawn('pkill', ['-f', 'cli-proxy-api'], { stdio: 'ignore' })
}

/**
 * Start the proxy detached and headless so it outlives this Harness process
 * and never opens a console window.
 * @param binary - executable name or absolute path.
 * @param config - absolute config path.
 */
function spawnProxy(binary, config) {
  const child = spawn(binary, ['--config', config], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => {})
  child.unref()
}

/**
 * Wait until the proxy answers or the deadline passes.
 * @param port - loopback port.
 * @param timeoutMs - how long to wait.
 * @returns true when it answered.
 */
async function waitForProxy(port, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await listening(port)) return true
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  return false
}

/**
 * Resolve the proxy's state once per call: installed, running, managed, and
 * accepting our key. Concurrent callers share one in-flight attempt; once it
 * settles the next call checks liveness again, so a dead proxy is respawned.
 * @param ctx - plugin context.
 * @returns readiness facts shared by every endpoint.
 */
function ensureReady(ctx) {
  readiness ??= (async () => {
    const { home, config, legacyKeyFile, port, binary } = paths()
    mkdirSync(home, { recursive: true })
    const { key, fresh } = await ensureManagementKey(ctx, config, legacyKeyFile)
    if (fresh && (await listening(port))) {
      stopProxy()
      await new Promise(resolve => setTimeout(resolve, 1200))
    }
    if (!(await listening(port))) {
      spawnProxy(binary, config)
      if (!(await waitForProxy(port))) {
        return {
          ok: false,
          port,
          config,
          error: `CLIProxyAPI did not start on port ${port}. Install it with "winget install -e --id LuisPater.CLIProxyAPI" (or set CLIPROXY_BIN), then reload this page.`,
        }
      }
    }
    const probe = await fetch(`http://127.0.0.1:${port}/v8/management/credentials`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined)
    const status = probe?.status ?? 0
    if (status === 401 || status === 403) {
      return {
        ok: false,
        port,
        config,
        error: 'CLIProxyAPI rejected the saved management key. Set the CLIPROXY_MANAGEMENT_KEY credential to the proxy’s current management.secret-key, or remove that credential and the secret-key line in the proxy config, then reload this page to generate a fresh key.',
      }
    }
    if (status === 404) {
      return {
        ok: false,
        port,
        config,
        error: 'CLIProxyAPI has no management API configured. Remove the CLIPROXY_MANAGEMENT_KEY credential and reload this page so a management key can be generated, or start the proxy with management.secret-key set.',
      }
    }
    return { ok: true, port, config, key }
  })().catch(error => ({ ok: false, port: 0, config: '', error: redact(String(error?.message ?? error)) }))
    .finally(() => { readiness = undefined })
  return readiness
}

/**
 * Call one management endpoint and decode its JSON.
 * @param ready - readiness facts.
 * @param path - management path below `/v8/management`.
 * @param init - optional fetch options.
 * @returns the decoded body.
 */
async function manage(ready, path, init = {}) {
  const response = await fetch(`http://127.0.0.1:${ready.port}/v8/management${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${ready.key}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  const body = text.length > 0 ? JSON.parse(text) : {}
  if (!response.ok) {
    const message = typeof body?.error === 'string' ? body.error : `management ${response.status}`
    const error = new Error(redact(message))
    error.status = response.status
    throw error
  }
  return body
}

/** Read one numeric quota signal, tolerating strings and "None" spellings. */
function signalNumber(signals, key) {
  const raw = signals?.[key]
  if (raw === undefined || raw === null) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/** Reduce the proxy's cooldown entries to the nearest one. */
function nearestCooldown(cooldowns) {
  if (!Array.isArray(cooldowns) || cooldowns.length === 0) return undefined
  const sorted = [...cooldowns].sort(
    (a, b) => Number(a?.remaining_seconds ?? Infinity) - Number(b?.remaining_seconds ?? Infinity),
  )
  const first = sorted[0]
  return {
    scope: first?.scope,
    model: first?.model_key,
    reason: first?.reason,
    retryAt: first?.retry_at,
    remainingSeconds: Number(first?.remaining_seconds ?? NaN) || undefined,
  }
}

/** Read the upstream failure the proxy last recorded for a credential. */
function upstreamFailure(statusMessage) {
  if (typeof statusMessage !== 'string' || statusMessage.trim().length === 0) return undefined
  try {
    const parsed = JSON.parse(statusMessage)
    const error = parsed?.error ?? parsed
    if (typeof error?.message !== 'string') return undefined
    return {
      message: redact(error.message),
      plan: error.plan_type,
      resetsInSeconds: Number(error.resets_in_seconds ?? NaN) || undefined,
    }
  } catch {
    return { message: redact(statusMessage) }
  }
}

/** Reduce one proxy credential record to what the page renders. */
function normalize(file) {
  const recent = Array.isArray(file.recent_requests) ? file.recent_requests : []
  const signals = file.quota?.signals ?? {}
  const primaryUsed = signalNumber(signals, 'X-Codex-Primary-Used-Percent')
  const secondaryUsed = signalNumber(signals, 'X-Codex-Secondary-Used-Percent')
  const limits = {
    primary: primaryUsed === undefined ? undefined : {
      usedPercent: primaryUsed,
      windowMinutes: signalNumber(signals, 'X-Codex-Primary-Window-Minutes'),
      resetsAtEpoch: signalNumber(signals, 'X-Codex-Primary-Reset-At'),
    },
    secondary: secondaryUsed === undefined ? undefined : {
      usedPercent: secondaryUsed,
      windowMinutes: signalNumber(signals, 'X-Codex-Secondary-Window-Minutes'),
      resetsAtEpoch: signalNumber(signals, 'X-Codex-Secondary-Reset-At'),
    },
    credits: signals['X-Codex-Credits-Balance'] ?? undefined,
    activeLimit: signals['X-Codex-Active-Limit'] ?? undefined,
  }
  return {
    id: file.id ?? file.name,
    name: file.name ?? file.id,
    provider: file.provider ?? file.type ?? 'unknown',
    label: file.label ?? file.email ?? file.account ?? file.name,
    email: file.email ?? file.account ?? undefined,
    status: file.status ?? (file.disabled === true ? 'disabled' : 'active'),
    statusMessage: file.status_message === undefined ? undefined : redact(String(file.status_message)),
    disabled: file.disabled === true,
    unavailable: file.unavailable === true,
    requiresSignIn: file.requires_sign_in === true,
    plan: file.id_token?.plan_type ?? signals['X-Codex-Plan-Type'] ?? undefined,
    subscriptionUntil: file.id_token?.chatgpt_subscription_active_until ?? undefined,
    expiresAt: file.access_token_expires_at ?? undefined,
    quotaBlocked: file.quota_blocked === true,
    cooldowns: Array.isArray(file.cooldowns) ? file.cooldowns : [],
    cooldown: nearestCooldown(file.cooldowns),
    failure: upstreamFailure(file.status_message),
    limits,
    usage: codexUsageWindows(limits),
    success: Number(file.success ?? 0),
    failed: Number(file.failed ?? 0),
    recent: recent.slice(-12).map(bucket => ({
      time: bucket.time,
      success: Number(bucket.success ?? 0),
      failed: Number(bucket.failed ?? 0),
    })),
    createdAt: file.created_at ?? undefined,
  }
}

/** Write a JSON response. */
function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

/** Read a JSON request body with a bound. */
async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text.length === 0 ? {} : JSON.parse(text)
}

/**
 * Make the proxy safe for this Harness: mask each known agent-identity
 * sentence, stop a poisoned request from walking the whole account pool, and
 * keep retries low. Idempotent — each piece is written only when absent.
 * @param ready - readiness facts.
 * @returns what was changed.
 */
async function provisionProxyFixes(ready) {
  if (process.env.ACCOUNT_HUB_NO_ANTIGRAVITY_PATCH === '1') return { skipped: true }
  const config = await manage(ready, '/config')
  const plan = planProxyFixes(config)
  if (!plan.changed) return { changed: false }
  await manage(ready, '/config', { method: 'PATCH', body: JSON.stringify(plan.patch) })
  return {
    changed: true,
    masked: plan.addedMasks,
    scopedRuleAdded: plan.scopedRuleAdded,
    retriesRaised: plan.retriesRaised,
    intervalRaised: plan.intervalRaised,
  }
}

/** Report whether this package's browser half is in the running client graph. */
function describeClient(ctx) {
  try {
    const modules = ctx.get?.('clientModules') ?? ctx.clientModules
    if (modules === undefined) return { available: false }
    const graph = modules.graph()
    const row = graph?.entries?.find?.(entry => entry.id === '@local/dsh-account-hub')
    return row === undefined
      ? { available: true, registered: false }
      : { available: true, registered: true, url: row.url, rev: row.rev }
  } catch (error) {
    return { available: false, error: String(error?.message ?? error) }
  }
}

/** Read whether one conversation is pinned to one account. */
async function readAffinity(ready) {
  try {
    const value = await manage(ready, '/config/routing/session-affinity')
    return typeof value === 'boolean' ? value : undefined
  } catch {
    return undefined
  }
}

/** Read how the proxy chooses between accounts. */
async function readRoutingStrategy(ready) {
  try {
    const strategy = await manage(ready, '/config/routing/strategy')
    return typeof strategy === 'string' ? strategy : undefined
  } catch {
    return undefined
  }
}

/** Cache of per-credential model listings (one minute of freshness). */
const modelCache = new Map()

/** Antigravity quota hosts, tried in order: the daily host answers first. */
const ANTIGRAVITY_QUOTA_URLS = [
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
]

/**
 * Cloud Code rejects quota reads from clients that do not identify as the
 * Antigravity hub, so the request carries the hub's own user agent.
 */
const ANTIGRAVITY_QUOTA_USER_AGENT = 'antigravity/hub/2.23.0 darwin/arm64'

/** One minute of quota freshness; failures are retried sooner. */
const QUOTA_TTL_MS = 60_000
const QUOTA_ERROR_TTL_MS = 15_000

/** Cache of per-credential usage windows keyed by auth_index. */
const quotaCache = new Map()

/**
 * Ask the proxy to query one Antigravity account's usage summary. The proxy
 * substitutes `$TOKEN$`, so this plugin never handles the access token.
 * @param ready - running proxy handle.
 * @param authIndex - the credential's runtime auth_index.
 * @returns `{ windows }` or `{ windows: [], error }` with a redacted message.
 */
async function antigravityUsage(ready, authIndex) {
  const key = String(authIndex ?? '')
  if (key.length === 0) return { windows: [] }
  const cached = quotaCache.get(key)
  if (cached !== undefined) {
    const ttl = cached.value.error === undefined ? QUOTA_TTL_MS : QUOTA_ERROR_TTL_MS
    if (Date.now() - cached.at < ttl) return cached.value
  }

  let lastError
  for (const url of ANTIGRAVITY_QUOTA_URLS) {
    try {
      const result = await manage(ready, '/requests/api-call', {
        method: 'POST',
        body: JSON.stringify({
          auth_index: key,
          method: 'POST',
          url,
          header: {
            Authorization: 'Bearer $TOKEN$',
            'Content-Type': 'application/json',
            'User-Agent': ANTIGRAVITY_QUOTA_USER_AGENT,
          },
          data: '{}',
        }),
      })
      const upstream = Number(result?.status_code ?? 0)
      if (upstream !== 200) {
        lastError = new Error(`usage endpoint answered ${upstream === 0 ? 'nothing' : upstream}`)
        continue
      }
      const payload = JSON.parse(String(result.body ?? '{}'))
      const windows = parseAntigravityUsage(payload)
      if (windows.length === 0) {
        lastError = new Error('usage response contained no quota windows')
        continue
      }
      const value = { windows }
      quotaCache.set(key, { at: Date.now(), value })
      return value
    } catch (error) {
      lastError = error
    }
  }
  const value = { windows: [], error: redact(String(lastError?.message ?? lastError ?? 'usage unavailable')) }
  quotaCache.set(key, { at: Date.now(), value })
  return value
}

/** Which models one credential can actually serve. */
async function accountModels(ready, name) {
  const cached = modelCache.get(name)
  if (cached !== undefined && Date.now() - cached.at < 60_000) return cached.models
  try {
    const body = await manage(ready, `/credentials/models?name=${encodeURIComponent(name)}`)
    const models = Array.isArray(body.models)
      ? body.models.map(model => model?.id ?? model?.name).filter(id => typeof id === 'string')
      : []
    modelCache.set(name, { at: Date.now(), models })
    return models
  } catch {
    return undefined
  }
}

/** Read the user's own display names for accounts. */
function readLabels() {
  const file = join(paths().home, '.account-hub-labels.json')
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Persist the display names. */
function writeLabels(labels) {
  const file = join(paths().home, '.account-hub-labels.json')
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, `${JSON.stringify(labels, null, 2)}\n`, 'utf8')
}

/** Apply display names to a normalized account. */
function withDisplayLabel(account, labels) {
  const display = labels[account.name]
  return typeof display === 'string' && display.length > 0
    ? { ...account, displayLabel: display }
    : account
}

/** Read the plugin's non-secret explicit account selection state. */
function readAccountSelections() {
  const file = join(paths().home, '.account-hub-selection.json')
  if (!existsSync(file)) return { version: 1, providers: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed?.version !== 1 || parsed.providers === null || typeof parsed.providers !== 'object') {
      return { version: 1, providers: {} }
    }
    const providers = {}
    for (const [provider, preference] of Object.entries(parsed.providers)) {
      const validBaseline = preference?.baseline !== null && typeof preference?.baseline === 'object'
        && Object.entries(preference.baseline).every(([name, value]) => typeof name === 'string'
          && name.length <= 512 && value !== null && typeof value === 'object'
          && typeof value.disabled === 'boolean')
      if (!PROVIDERS.some(entry => entry.id === provider)
          || preference === null || typeof preference !== 'object'
          || typeof preference.selected !== 'string' || preference.selected.length > 512
          || !validBaseline
          || (preference.baseline[preference.selected] !== undefined
            && preference.baseline[preference.selected].disabled !== false)) {
        continue
      }
      // Keep stale names in persisted metadata until the next selection plan
      // prunes them against the live credential listing. Missing baselines do
      // not invalidate the active choice or hide the Auto recovery control.
      const baseline = Object.fromEntries(Object.entries(preference.baseline)
        .filter(([name]) => name !== preference.selected || preference.baseline[name]?.disabled === false))
      const selectedStillEligible = baseline[preference.selected] === undefined
        || baseline[preference.selected].disabled === false
      if (!selectedStillEligible) continue
      providers[provider] = { ...preference, baseline }
    }
    return { version: 1, providers }
  } catch {
    return { version: 1, providers: {} }
  }
}

/** Persist explicit account selection metadata (names only, never credentials). */
function writeAccountSelections(state) {
  const file = join(paths().home, '.account-hub-selection.json')
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  mkdirSync(join(file, '..'), { recursive: true })
  try {
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary) } catch { /* best effort cleanup */ }
    throw error
  }
}

/** Apply an exclusive account selection for one provider and persist only names/statuses. */
async function withSelectionMutation(operation) {
  // Serialize selection, recovery, and strategy transitions within this plugin
  // instance so concurrent GUI requests cannot interleave status patches.
  while (selectionMutation !== undefined) {
    try { await selectionMutation } catch { /* a prior request reports its own failure */ }
  }
  const current = Promise.resolve().then(operation)
  selectionMutation = current
  try { return await current } finally {
    if (selectionMutation === current) selectionMutation = undefined
  }
}

async function setProviderAccount(ready, provider, selectedName, options = {}) {
  return withSelectionMutation(() => doSetProviderAccount(ready, provider, selectedName, options))
}

async function chooseProviderAccount(ready, provider, selectedName) {
  return withSelectionMutation(async () => {
    const strategy = await readRoutingStrategy(ready)
    const active = preferenceFor(readAccountSelections(), provider)
    if (strategy !== 'fill-first' && selectedName !== null && active === undefined) {
      return { error: 'switch rotation to Fill first before selecting a single account', status: 409 }
    }
    try {
      return await doSetProviderAccount(ready, provider, selectedName)
    } catch (error) {
      return { error: redact(String(error?.message ?? error)), status: 400 }
    }
  })
}

let selectionMutation

async function doSetProviderAccount(ready, provider, selectedName, options = {}) {
  if (provider === null || typeof provider !== 'string' || !PROVIDERS.some(entry => entry.id === provider)) {
    throw new Error('unknown provider')
  }
  const state = readAccountSelections()
  const previous = preferenceFor(state, provider)
  if (selectedName === null || selectedName === undefined || selectedName === '') {
    if (previous === undefined) return { changed: false }
  }
  if (typeof selectedName === 'string' && selectedName.length > 512) throw new Error('account name is too long')

  const listing = options.listing ?? await manage(ready, '/credentials')
  const plan = planAccountSelection(listing.files, provider, selectedName, previous)
  const before = new Map((listing.files ?? []).map(file => [file.name ?? file.id, file.disabled === true]))
  const preferenceFile = join(paths().home, '.account-hub-selection.json')
  const previousPreferenceFile = existsSync(preferenceFile) ? readFileSync(preferenceFile) : undefined
  const applied = []
  const providers = { ...(state.providers ?? {}) }
  if (options.keepPreference === true && plan.preference === undefined && previous !== undefined) {
    providers[provider] = previous
  } else if (plan.preference === undefined) delete providers[provider]
  else providers[provider] = plan.preference
  // Write the restore snapshot before disabling anything. On the next mount,
  // startup reconciliation below reasserts this selection, completing a partial
  // apply while preserving the baseline needed for Auto recovery.
  if (plan.preference !== undefined || options.keepPreference === true) writeAccountSelections({ version: 1, providers })
  try {
    for (const change of plan.changes) {
      await manage(ready, '/credentials/status', {
        method: 'PATCH',
        body: JSON.stringify({ name: change.name, disabled: change.disabled }),
      })
      applied.push(change.name)
    }
    if (plan.preference === undefined && options.keepPreference !== true) writeAccountSelections({ version: 1, providers })
    if (options.keepPreference === true && previous !== undefined) {
      const latest = readAccountSelections()
      const latestProviders = { ...(latest.providers ?? {}) }
      latestProviders[provider] = { ...previous, baseline: plan.baseline ?? previous.baseline }
      writeAccountSelections({ version: 1, providers: latestProviders })
    }
    return { changed: true, selected: plan.preference?.selected ?? null, disabledCount: plan.changes.filter(change => change.disabled).length }
  } catch (error) {
    // Restore the previous durable selection preference before restoring proxy
    // statuses so a later Auto operation still has the correct baseline.
    try {
      if (previousPreferenceFile === undefined) {
        if (existsSync(preferenceFile)) unlinkSync(preferenceFile)
      } else {
        const rollbackFile = `${preferenceFile}.${process.pid}.rollback`
        writeFileSync(rollbackFile, previousPreferenceFile, { flag: 'w', mode: 0o600 })
        renameSync(rollbackFile, preferenceFile)
      }
    } catch { /* surface the original management error */ }
    for (const name of applied.reverse()) {
      try {
        await manage(ready, '/credentials/status', {
          method: 'PATCH',
          body: JSON.stringify({ name, disabled: before.get(name) === true }),
        })
      } catch { /* keep the original error; next state refresh shows live status */ }
    }
    throw error
  }
}

/** Read the proxy's own client API key out of its configuration. */
function proxyClientKey() {
  const { config } = paths()
  if (!existsSync(config)) return undefined
  const lines = readFileSync(config, 'utf8').split(/\r?\n/)
  const start = lines.findIndex(line => /^\s*api-keys:\s*$/.test(line))
  if (start < 0) return undefined
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    const match = line.match(/^\s*-\s*["']?([^"'\s#]+)["']?\s*$/)
    if (match !== null) return match[1]
    if (/^\S/.test(line)) break
  }
  return undefined
}

/** Which provider route one proxy model belongs to. */
function routeForModel(id) {
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (/image/i.test(id)) return undefined
  if (/^claude-/i.test(id)) return 'cliproxy-claude'
  if (/^gemini-/i.test(id)) return 'cliproxy-gemini'
  if (/^(gpt|codex|o\d)/i.test(id) || /^gpt-oss/i.test(id)) return 'cliproxy-gpt'
  return undefined
}

/** Ask the proxy for every model it can currently serve. */
async function proxyCatalog(ready) {
  const key = proxyClientKey()
  if (key === undefined) throw new Error('the proxy has no client api-key configured')
  const response = await fetch(`http://127.0.0.1:${ready.port}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`the proxy answered ${response.status} for its model list`)
  const body = await response.json()
  const grouped = new Map()
  for (const entry of Array.isArray(body?.data) ? body.data : []) {
    const id = entry?.id
    const route = routeForModel(id)
    if (route === undefined) continue
    if (!grouped.has(route)) grouped.set(route, new Set())
    grouped.get(route).add(id)
  }
  return grouped
}

/** Reconcile one provider's model list with the proxy's catalog (additive). */
function reconcileModels(existing, ids) {
  const byId = new Map()
  for (const model of Array.isArray(existing) ? existing : []) {
    if (typeof model?.id === 'string') byId.set(model.id, model)
  }
  const next = []
  for (const id of [...ids].sort()) {
    next.push(byId.get(id) ?? { id, input: ['text'] })
  }
  for (const [id, model] of byId) {
    if (!ids.has(id)) next.push(model)
  }
  return next
}

/** Read the model routes the running Harness has registered. */
async function describeRoutes(ctx) {
  const routes = []
  for (const provider of ctx.llm.listProviders()) {
    const key = provider?.id ?? provider?.provider ?? provider?.name
    if (typeof key !== 'string') continue
    const label = typeof provider?.name === 'string' ? provider.name : key
    let models = []
    let failure
    try {
      const listed = await ctx.llm.listModels(key)
      models = listed.map(model => model?.id ?? model?.name).filter(id => typeof id === 'string')
    } catch (error) {
      failure = redact(String(error?.message ?? error))
    }
    routes.push({
      provider: key,
      label,
      models,
      ...(failure === undefined ? {} : { error: failure }),
    })
  }
  return routes
}

/**
 * Whether a request comes from the genuine local GUI: a loopback socket AND a
 * loopback Host header. The web server trusts loopback sockets, but any
 * reverse-proxy hop (e.g. a tailnet forwarder) arrives on loopback while
 * carrying the external Host — so a Host check is required to keep sensitive
 * management local-only.
 * @param request - incoming request.
 * @returns true only for a local loopback GUI request.
 */
function isLocalGui(request) {
  const remote = request.socket?.remoteAddress ?? ''
  const socketLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const hostHeader = String(request.headers.host ?? '')
  const hostLoopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(hostHeader)
  return socketLoopback && hostLoopback
}

/**
 * Answer one `/plugins/account-hub` request.
 * @param ctx - plugin context carrying the LLM service.
 * @param request - incoming request.
 * @param response - server response.
 */
async function handle(ctx, request, response) {
  const url = new URL(request.url ?? '/', 'http://account-hub.invalid')
  const route = url.pathname.slice(BASE_PATH.length) || '/'
  const method = request.method ?? 'GET'

  // ── Local-only guard for sensitive management ──
  // Account mutations, routing, and sign-in change credentials or proxy
  // behavior, so they must only be reachable from the local GUI — never through
  // a reverse-proxy hop. Read-only state stays open so the page renders anywhere.
  const sensitive =
    (route === '/account-selection' && method === 'POST')
    || (route === '/account' && method === 'POST')
    || (route === '/routing' && method === 'POST')
    || (route === '/affinity' && method === 'POST')
    || (route === '/sync-models' && method === 'POST')
    || (route === '/login' && (method === 'POST' || method === 'DELETE'))
  if (sensitive && !isLocalGui(request)) {
    sendJson(response, 403, { error: 'account management is local-only; open the Harness on this machine to change accounts' })
    return
  }

  const ready = await ensureReady(ctx)
  const routes = await describeRoutes(ctx).catch(() => [])

  if (!ready.ok) {
    sendJson(response, 200, {
      proxy: { running: false, port: ready.port, error: ready.error },
      accountSelections: readAccountSelections().providers ?? {},
      accounts: [],
      providers: PROVIDERS,
      routes,
      fixes: {},
    })
    return
  }

  const fixes = await provisionProxyFixes(ready).catch(error => ({ error: redact(String(error?.message ?? error)) }))
  const routing = await readRoutingStrategy(ready)
  const affinity = await readAffinity(ready)
  const client = describeClient(ctx)

  if (method === 'GET' && route === '/state') {
    let files = []
    let accountsError
    try {
      const body = await manage(ready, '/credentials')
      // The auth directory also holds this plugin's own dotfiles; they are not
      // accounts and must not render as broken cards.
      files = (Array.isArray(body.files) ? body.files : []).filter(file => {
        const name = file?.name ?? file?.id
        return typeof name === 'string' && !name.startsWith('.')
      })
    } catch (error) {
      accountsError = redact(String(error.message))
    }
    const accounts = files.map(normalize)
    const byName = new Map(files.map(file => [file.name ?? file.id, file]))
    const labels = readLabels()
    const selectionState = readAccountSelections()
    await Promise.all(accounts.map(async account => {
      account.models = await accountModels(ready, account.name)
      // Antigravity reports its 5-hour and weekly windows through an upstream
      // quota call; Codex windows arrive in the credential's own signals.
      if (account.provider === 'antigravity') {
        const usage = await antigravityUsage(ready, byName.get(account.name)?.auth_index)
        account.usage = usage.windows
        if (usage.error !== undefined) account.usageError = usage.error
      }
      const preference = preferenceFor(selectionState, account.provider)
      account.selectedForProvider = preference?.selected === account.name
      account.selectableForProvider = preference === undefined
        ? !account.disabled && !account.unavailable && !account.requiresSignIn
        : preference.baseline?.[account.name]?.disabled !== true && !account.unavailable && !account.requiresSignIn
    }))
    sendJson(response, 200, {
      proxy: { running: true, port: ready.port, error: accountsError },
      accountSelections: selectionState.providers ?? {},
      accounts: accounts.map(account => withDisplayLabel(account, labels)),
      providers: PROVIDERS,
      routes,
      routing,
      affinity,
      fixes,
      client,
    })
    return
  }

  if (method === 'POST' && route === '/sync-models') {
    const editor = ctx.get?.('configEditor') ?? ctx.configEditor
    if (editor === undefined) {
      sendJson(response, 503, { error: 'the profile configuration editor is not available in this build' })
      return
    }
    let grouped
    try {
      grouped = await proxyCatalog(ready)
    } catch (error) {
      sendJson(response, 502, { error: redact(String(error?.message ?? error)) })
      return
    }
    const entry = editor.entries().find(candidate => candidate?.options?.id === 'llm-pi-ai'
      && candidate?.options?.name === '@deepseek-ai/dsh-llm-pi-ai')
    if (entry === undefined) {
      sendJson(response, 409, { error: 'no llm-pi-ai row in this profile' })
      return
    }
    let summary = { added: [], removed: [], routes: [] }
    try {
      await editor.edit(entry, (current, inherited) => {
        const base = { ...inherited, ...current }
        const providers = { ...(base.providers ?? {}) }
        for (const [routeKey, ids] of grouped) {
          const profile = providers[routeKey]
          if (profile === undefined) continue
          const before = Array.isArray(profile.models) ? profile.models.map(model => model?.id) : []
          const after = reconcileModels(profile.models, ids)
          providers[routeKey] = { ...profile, models: after }
          summary.routes.push(routeKey)
          for (const model of after) if (!before.includes(model.id)) summary.added.push(`${routeKey}/${model.id}`)
        }
        return { ...base, providers }
      })
    } catch (error) {
      sendJson(response, 500, { error: redact(String(error?.message ?? error)) })
      return
    }
    sendJson(response, 200, { status: 'ok', ...summary })
    return
  }

  if (route === '/account-selection' && method === 'POST') {
    const body = await readJson(request)
    const provider = String(body.provider ?? '')
    const selectedName = body.name === null || body.name === undefined || body.name === ''
      ? null
      : String(body.name)
    if (!PROVIDERS.some(entry => entry.id === provider)) {
      sendJson(response, 400, { error: 'unknown provider' })
      return
    }
    const result = await chooseProviderAccount(ready, provider, selectedName)
    if (result.error !== undefined) {
      sendJson(response, result.status ?? 502, { error: result.error })
      return
    }
    sendJson(response, 200, {
      status: 'ok',
      selected: result.selected,
      changed: result.changed,
      message: result.selected === null ? 'Auto restored; the provider account pool is back.' : 'Only the selected account is enabled for this provider.',
    })
    return
  }

  if (method === 'POST' && route === '/affinity') {
    const body = await readJson(request)
    const enabled = body.enabled === true
    await manage(ready, '/config/routing/session-affinity', {
      method: 'PUT',
      body: JSON.stringify(enabled),
    })
    sendJson(response, 200, { status: 'ok', affinity: enabled })
    return
  }

  if (method === 'POST' && route === '/routing') {
    const body = await readJson(request)
    const strategy = String(body.strategy ?? '')
    if (strategy !== 'round-robin' && strategy !== 'fill-first') {
      sendJson(response, 400, { error: 'strategy must be round-robin or fill-first' })
      return
    }
    const result = await withSelectionMutation(async () => {
      const currentStrategy = await readRoutingStrategy(ready)
      const previousSelections = readAccountSelections()
      const transition = planStrategyTransition(previousSelections, currentStrategy, strategy)
      if (transition.restore.length === 0) {
        await manage(ready, '/config/routing/strategy', { method: 'PUT', body: JSON.stringify(strategy) })
        return { changed: false }
      }
      let listing
      try {
        listing = await manage(ready, '/credentials')
      } catch (error) {
        return { error: redact(String(error?.message ?? error)), status: 502 }
      }
      if (!validateTransitionCredentials(previousSelections, transition, listing.files)) {
        return { error: 'cannot safely switch routing: an exclusive account or saved account is missing; restore Auto or remove the stale selection first', status: 409 }
      }

      const stateFile = join(paths().home, '.account-hub-selection.json')
      const previousStateFile = existsSync(stateFile) ? readFileSync(stateFile) : undefined
      const restored = []
      try {
        for (const provider of transition.restore) {
          restored.push(provider)
          await doSetProviderAccount(ready, provider, null, { listing, keepPreference: true })
        }
        const current = readAccountSelections()
        const providers = { ...(current.providers ?? {}) }
        for (const provider of transition.restore) delete providers[provider]
        writeAccountSelections({ version: 1, providers })
        await manage(ready, '/config/routing/strategy', { method: 'PUT', body: JSON.stringify(strategy) })
        return { changed: true }
      } catch (error) {
        // Keep the saved selections in storage after a transition failure and
        // reassert their exclusive statuses from the captured listing.
        try {
          if (previousStateFile === undefined) {
            if (existsSync(stateFile)) unlinkSync(stateFile)
          } else {
            const temporary = `${stateFile}.${process.pid}.transition-rollback`
            writeFileSync(temporary, previousStateFile, { flag: 'w', mode: 0o600 })
            renameSync(temporary, stateFile)
          }
        } catch { /* preserve the operation error */ }
        for (const provider of restored.reverse()) {
          const previous = previousSelections.providers[provider]
          try { await doSetProviderAccount(ready, provider, previous.selected, { listing }) }
          catch { /* original error wins; next state refresh shows live status */ }
        }
        return { error: redact(String(error?.message ?? error)), status: 502 }
      }
    })
    if (result.error !== undefined) {
      sendJson(response, result.status ?? 502, { error: result.error })
      return
    }
    sendJson(response, 200, { status: 'ok', strategy })
    return
  }

  if (method === 'POST' && route === '/login') {
    const body = await readJson(request)
    const provider = String(body.provider ?? '')
    if (!PROVIDERS.some(entry => entry.id === provider)) {
      sendJson(response, 400, { error: `unknown provider "${provider}"` })
      return
    }
    // Adding an account while exclusive selection is active must not silently
    // widen that provider's pool. Restore Auto before beginning a new sign-in.
    if (preferenceFor(readAccountSelections(), provider) !== undefined) {
      await setProviderAccount(ready, provider, null)
    }
    const result = await manage(
      ready,
      `/oauth/auth-url?provider=${encodeURIComponent(provider)}&is_webui=true`,
    )
    sendJson(response, 200, {
      state: result.state,
      url: result.url,
      flow: result.flow ?? 'browser',
      userCode: result.user_code ?? undefined,
    })
    return
  }

  if (method === 'GET' && route === '/login/status') {
    const state = url.searchParams.get('state') ?? ''
    const result = await manage(ready, `/oauth/status?state=${encodeURIComponent(state)}`)
    sendJson(response, 200, result)
    return
  }

  if (method === 'DELETE' && route === '/login') {
    const state = url.searchParams.get('state') ?? ''
    const result = await manage(ready, `/oauth/session?state=${encodeURIComponent(state)}`, {
      method: 'DELETE',
    })
    sendJson(response, 200, result)
    return
  }

  if (method === 'POST' && route === '/account') {
    const body = await readJson(request)
    const name = String(body.name ?? '')
    const action = String(body.action ?? '')
    if (name.length === 0) {
      sendJson(response, 400, { error: 'account name is required' })
      return
    }
    if (action === 'rename') {
      const label = String(body.label ?? '').trim()
      if (label.length === 0 || label.length > 80) {
        sendJson(response, 400, { error: 'a label of 1–80 characters is required' })
        return
      }
      const labels = readLabels()
      labels[name] = label
      writeLabels(labels)
      sendJson(response, 200, { status: 'ok', label })
      return
    }
    if (action === 'disable' || action === 'enable') {
      const listing = await manage(ready, '/credentials')
      const target = (listing.files ?? []).find(file => (file.id ?? file.name) === name)
      const provider = target?.provider ?? target?.type
      const preference = provider === undefined ? undefined : preferenceFor(readAccountSelections(), provider)
      if (shouldRestoreBeforeStatusAction(preference, action)) {
        // Card-level enable/disable exits exclusive mode first, restoring the
        // saved provider pool. Then apply the requested action to this account.
        await setProviderAccount(ready, provider, null)
      }
      const result = await manage(ready, '/credentials/status', {
        method: 'PATCH',
        body: JSON.stringify({ name, disabled: action === 'disable' }),
      })
      sendJson(response, 200, result)
      return
    }
    if (action === 'refresh') {
      // The v8 management API requires a target: `name` for one account or
      // `all: true` for the pool. An empty body is a 400.
      const result = await manage(ready, '/credentials/refresh', {
        method: 'POST',
        body: JSON.stringify({ name }),
      })
      sendJson(response, 200, result)
      return
    }
    if (action === 'remove') {
      // Removing the selected credential should leave the rest of its provider
      // pool usable and clear a preference that can no longer be restored.
      const listing = await manage(ready, '/credentials')
      const removedFile = (listing.files ?? []).find(file => (file.id ?? file.name) === name)
      if (removedFile === undefined) {
        sendJson(response, 404, { error: 'account not found' })
        return
      }
      const removedProvider = removedFile?.provider ?? removedFile?.type
      const selected = removedProvider === undefined ? undefined : preferenceFor(readAccountSelections(), removedProvider)
      if (selected !== undefined && Object.hasOwn(selected.baseline ?? {}, name)) {
        // Restore the other provider accounts before removing any saved member
        // of the exclusive pool so Auto cannot later undo the user's deletion.
        await setProviderAccount(ready, removedProvider, null)
      }
      const labels = readLabels()
      if (labels[name] !== undefined) {
        delete labels[name]
        writeLabels(labels)
      }
      const result = await manage(ready, `/credentials?name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
      })
      sendJson(response, 200, result)
      return
    }
    if (action === 'reset-cooldown') {
      const listing = await manage(ready, '/credentials')
      const target = (listing.files ?? []).find(file => (file.id ?? file.name) === name)
      if (target?.auth_index === undefined) {
        sendJson(response, 404, { error: 'account not found' })
        return
      }
      const result = await manage(ready, '/routing/cooldown/reset', {
        method: 'POST',
        body: JSON.stringify({ auth_index: target.auth_index }),
      })
      sendJson(response, 200, result)
      return
    }
    sendJson(response, 400, { error: `unknown action "${action}"` })
    return
  }

  sendJson(response, 404, { error: 'not found' })
}

/**
 * Mount the host half. The proxy starts right here — headless, detached, no
 * console window — so every model route works as soon as the Harness opens.
 * A watchdog re-checks liveness every 30 seconds and respawns the proxy if it
 * died. Legacy plaintext secrets are migrated into the credential seam once.
 * Credentials live in the proxy auth dir and the seam with refresh tokens, so
 * a respawn never asks the user to sign in again.
 * @param ctx - plugin context carrying the web server service.
 */
export function apply(ctx) {
  const { legacyKeyFile } = paths()
  void (async () => {
    try {
      await migrateLegacyFile(ctx, legacyKeyFile, REFS.managementKey)
    } catch { /* migration is best effort; the seam is the only durable store */ }
  })()

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: BASE_PATH,
    handler: (request, response) => handle(ctx, request, response).catch(error => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: redact(String(error?.message ?? error)) })
      } else {
        response.end()
      }
    }),
  }))
  ctx.effect(() => {
    let stopped = false
    let timer
    let recoveredSelections = false
    const tick = async () => {
      if (stopped) return
      try {
        const ready = await ensureReady(ctx)
        if (ready.ok && !recoveredSelections) {
          // Reassert a persisted exclusive choice once per mount. This completes
          // a partially applied selection after a process restart and ensures
          // the selected account remains the sole enabled credential.
          let complete = true
          await withSelectionMutation(async () => {
            for (const [provider, preference] of Object.entries(readAccountSelections().providers ?? {})) {
              try { await doSetProviderAccount(ready, provider, preference.selected) }
              catch { complete = false /* retry on the next watchdog tick */ }
            }
          })
          recoveredSelections = complete
        }
      } catch { /* surfaced by /state */ }
      if (!stopped) timer = setTimeout(tick, 30_000)
    }
    void tick()
    return () => { stopped = true; if (timer !== undefined) clearTimeout(timer) }
  })
}