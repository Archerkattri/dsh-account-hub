/**
 * Unit tests for the credential-seam secret hygiene — no network, no Harness.
 * Run: node dev/secrets-test.mjs
 *
 * Fixtures assemble secret-shaped strings at runtime so no secret literal lives
 * in the repository (the static secret scan covers this file too).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REFS, redact, readSecret, writeSecret, deleteSecret,
  migrateLegacyFile, removeLegacyFile, credentialsOf,
} from '../lib/secrets.js'

let passed = 0
const test = (name, fn) => {
  try { fn(); passed += 1; console.log(`ok - ${name}`) }
  catch (error) { console.error(`FAIL - ${name}\n  ${error.message}`); process.exitCode = 1 }
}
const atest = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`ok - ${name}`) }
  catch (error) { console.error(`FAIL - ${name}\n  ${error.message}`); process.exitCode = 1 }
}

/** A Map-backed credential seam, like the DSH credential service. */
function seamCtx(store = new Map()) {
  return {
    credentials: {
      async resolve(ref) { return store.has(ref) ? { value: store.get(ref) } : undefined },
      async set(ref, value) { store.set(ref, value) },
      async unset(ref) { store.delete(ref) },
    },
  }
}
/** A context with no credential service mounted. */
const seamLessCtx = {}

const dir = mkdtempSync(join(tmpdir(), 'ah-secrets-'))
const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
process.on('exit', cleanup)

// ── Seam resolution ──
test('credentialsOf finds the seam and tolerates its absence', () => {
  assert.ok(credentialsOf(seamCtx()) !== undefined)
  assert.equal(credentialsOf(seamLessCtx), undefined)
})

await atest('writeSecret stores into the seam and readSecret returns it', async () => {
  const ctx = seamCtx()
  const value = 'mgmt-' + 'a1b2c3d4e5f6a7b8c9d0e1f2'
  assert.equal(await writeSecret(ctx, REFS.managementKey, value), true)
  assert.equal(await readSecret(ctx, REFS.managementKey), value)
})

await atest('writeSecret fails closed with no seam (no plaintext fallback)', async () => {
  const value = 'mgmt-' + 'ffffffffffffffffffffffff'
  assert.equal(await writeSecret(seamLessCtx, REFS.managementKey, value), false)
})

await atest('writeSecret rejects empty and whitespace values', async () => {
  const ctx = seamCtx()
  assert.equal(await writeSecret(ctx, REFS.managementKey, ''), false)
  assert.equal(await writeSecret(ctx, REFS.managementKey, '   '), false)
})

await atest('readSecret falls back to the runtime environment when no seam', async () => {
  const ref = REFS.managementKey
  const prior = process.env[ref]
  process.env[ref] = 'mgmt-' + '0123456789abcdef01234567'
  try {
    assert.equal(await readSecret(seamLessCtx, ref), process.env[ref])
  } finally {
    if (prior === undefined) delete process.env[ref]; else process.env[ref] = prior
  }
})

await atest('readSecret prefers the seam over the environment', async () => {
  const ref = REFS.managementKey
  const prior = process.env[ref]
  process.env[ref] = 'mgmt-' + 'envvvvvvvvvvvvvvvvvvvvvv'
  const ctx = seamCtx()
  await writeSecret(ctx, ref, 'mgmt-' + 'seamssssssssssssssssssss')
  try {
    assert.equal(await readSecret(ctx, ref), 'mgmt-' + 'seamssssssssssssssssssss')
  } finally {
    if (prior === undefined) delete process.env[ref]; else process.env[ref] = prior
  }
})

await atest('deleteSecret removes the stored value', async () => {
  const ctx = seamCtx()
  await writeSecret(ctx, REFS.managementKey, 'x'.repeat(40))
  await deleteSecret(ctx, REFS.managementKey)
  assert.equal(await readSecret(ctx, REFS.managementKey), undefined)
})

// ── Legacy migration (migration-only, never a durable plaintext store) ──
await atest('migrateLegacyFile stores into the seam then removes the file', async () => {
  const file = join(dir, 'legacy-token')
  const value = 'eyJ' + 'hbGciOiJSUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'sig'
  writeFileSync(file, value + '\n', 'utf8')
  const ctx = seamCtx()
  assert.equal(await migrateLegacyFile(ctx, file, REFS.managementKey), true)
  assert.equal(await readSecret(ctx, REFS.managementKey), value)
  assert.equal(existsSync(file), false)
})

await atest('migrateLegacyFile with no seam leaves the file (no secret loss)', async () => {
  const file = join(dir, 'legacy-key-noseam')
  writeFileSync(file, 'mgmt-' + 'bbbbbbbbbbbbbbbbbbbbbbbb', 'utf8')
  assert.equal(await migrateLegacyFile(seamLessCtx, file, REFS.managementKey), false)
  assert.equal(existsSync(file), true) // preserved until a seam can store it
  removeLegacyFile(file)
})

await atest('migrateLegacyFile removes an empty legacy file', async () => {
  const file = join(dir, 'legacy-empty')
  writeFileSync(file, '   \n', 'utf8')
  assert.equal(await migrateLegacyFile(seamCtx(), file, REFS.managementKey), false)
  assert.equal(existsSync(file), false)
})

test('removeLegacyFile removes a file and is a no-op when absent', () => {
  const file = join(dir, 'to-remove')
  writeFileSync(file, 'secret', 'utf8')
  removeLegacyFile(file)
  assert.equal(existsSync(file), false)
  removeLegacyFile(join(dir, 'does-not-exist')) // must not throw
})

// ── Redaction ──
test('redaction removes JWTs, keys, bearer values, and session cookies', () => {
  const jwt = 'eyJ' + 'hbGciOiJSUzI1NiJ9' + '.' + 'eyJzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
  const openaiKey = 'sk-' + 'abcdefghijklmnopqrstuvwx'
  const mgmtKey = 'mgmt-' + 'abcdef1234567890'
  const proxyKey = 'dsh-' + '0123456789abcdef01234567'
  const cookie = '__Secure-next-auth.session-token=' + 'eyJabc.def.ghi'
  const out = redact(`token=${jwt} key=${openaiKey} ${mgmtKey} ${proxyKey} Bearer abcdefghijklmnop ${cookie}`)
  for (const secret of [jwt, openaiKey, mgmtKey, proxyKey, 'Bearer abcdefghijklmnop']) {
    assert.ok(!out.includes(secret), `leaked: ${secret.slice(0, 8)}…`)
  }
  assert.ok(out.includes('__Secure-next-auth.session-token=[redacted]'))
})

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`)