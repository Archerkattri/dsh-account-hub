/**
 * Development probe: mounts the host half with a fake Cordis context and calls
 * the real `/state` handler against a running proxy. It exercises the whole
 * request path — proxy readiness, management calls, normalization — without
 * restarting DeepSeek Harness.
 *
 * Safety: resolves the management key from the local credential store so it
 * never regenerates a key (which would stop the live proxy).
 *
 *   node dev/probe.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Resolve the management key without printing it: env first, then the local
// DSH credential store, then the legacy key file. Never generate a new one.
if (process.env.CLIPROXY_MANAGEMENT_KEY === undefined) {
  const candidates = [
    join(homedir(), '.dsh', '.credentials.yaml'),
    join(process.env.CLIPROXY_HOME ?? join(homedir(), '.cli-proxy-api'), '.account-hub-key'),
  ]
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const match = text.match(/CLIPROXY_MANAGEMENT_KEY:\s*["']?([^\s"']+)/)
    const value = match?.[1] ?? (file.endsWith('.account-hub-key') ? text.trim() : undefined)
    if (value !== undefined && value.length > 0 && !value.startsWith('$2')) {
      process.env.CLIPROXY_MANAGEMENT_KEY = value
      break
    }
  }
}

const moduleUrl = new URL('../index.js', import.meta.url)
const { apply } = await import(moduleUrl)

let route
const disposers = []
const ctx = {
  get() { return undefined },
  effect(register) {
    const dispose = register()
    if (typeof dispose === 'function') disposers.push(dispose)
  },
  webServer: {
    register(registration) { route = registration; return () => {} },
  },
  llm: {
    listProviders() {
      return [
        { id: 'cliproxy-gpt', name: 'ChatGPT (CLIProxy)' },
        { id: 'cliproxy-gemini', name: 'Gemini (CLIProxy)' },
      ]
    },
    async listModels(provider) {
      return provider === 'cliproxy-gemini'
        ? [{ id: 'gemini-3-flash' }, { id: 'gemini-4-argon' }]
        : [{ id: 'gpt-6-sol' }]
    },
  },
}

apply(ctx)
if (route === undefined) throw new Error('apply() did not register a route')

const chunks = []
const response = {
  headersSent: false,
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true },
  end(body) { chunks.push(body) },
}

await route.handler({ method: 'GET', url: '/plugins/account-hub/state' }, response)

const body = JSON.parse(chunks.join(''))
console.log('status', response.status)
console.log('proxy', JSON.stringify(body.proxy))
console.log('fixes', JSON.stringify(body.fixes))
console.log('routes', body.routes.map(entry => `${entry.provider}:${entry.models.length}`).join(', '))
for (const account of body.accounts) {
  console.log('account', JSON.stringify({
    provider: account.provider,
    label: account.label,
    plan: account.plan,
    status: account.status,
    cooldown: account.cooldown,
    failure: account.failure?.message,
    limits: account.limits,
    models: Array.isArray(account.models) ? account.models.length : undefined,
  }))
}

// Dispose effects (watchdog timer, phone proxy) so the probe exits.
for (const dispose of disposers) dispose()