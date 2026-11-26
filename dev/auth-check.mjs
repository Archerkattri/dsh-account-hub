/**
 * Live HTTP auth-boundary regression for the Account Hub.
 *
 * The web server trusts loopback sockets, but a reverse-proxy hop arrives from
 * loopback with an external Host. Sensitive management routes must therefore
 * require a loopback Host too. This probe asserts:
 *   - external-Host mutations (account/routing/login) are refused (403);
 *   - read-only state stays reachable (200) so the settings page renders;
 *   - the local GUI (loopback Host) can still read state.
 * It never performs a local mutation, so it cannot change accounts.
 *
 * Uses node:http (not fetch/undici, which rewrites the Host header to the URL
 * authority and would silently test the loopback path instead).
 *
 *   node dev/auth-check.mjs
 */

import { request as httpRequest } from 'node:http'

const PORT = Number(process.env.DSH_WEB_PORT ?? 3080)
const EXTERNAL = 'external.example.com'
const LOCAL = '127.0.0.1:3080'

function probe(method, path, host, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest({
      host: '127.0.0.1', port: PORT, method, path: `/plugins/account-hub${path}`,
      headers: { host, ...(data !== undefined ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) },
      timeout: 10_000,
    }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    if (data !== undefined) req.write(data)
    req.end()
  })
}

let passed = 0, failed = 0
async function expect(name, method, path, host, body, want) {
  const got = await probe(method, path, host, body)
  if (got === want) { passed += 1; console.log(`ok - ${name} (${got})`) }
  else { failed += 1; console.error(`FAIL - ${name}: got ${got}, want ${want}`) }
}

// External-Host mutations must be refused before any state change.
await expect('external routing refused', 'POST', '/routing', EXTERNAL, { strategy: 'fill-first' }, 403)
await expect('external account selection refused', 'POST', '/account-selection', EXTERNAL, { provider: 'codex', name: 'x' }, 403)
await expect('external account mutation refused', 'POST', '/account', EXTERNAL, { name: 'x', action: 'remove' }, 403)
await expect('external login refused', 'POST', '/login', EXTERNAL, { provider: 'codex' }, 403)
await expect('external affinity refused', 'POST', '/affinity', EXTERNAL, { enabled: true }, 403)
await expect('external sync-models refused', 'POST', '/sync-models', EXTERNAL, {}, 403)
// Read-only state stays open on both paths.
await expect('external state readable', 'GET', '/state', EXTERNAL, undefined, 200)
await expect('local state readable', 'GET', '/state', LOCAL, undefined, 200)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)