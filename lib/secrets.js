/**
 * Secret hygiene for the Account Hub.
 *
 * Rules (aligned with the production invariants of upstream bridge projects):
 * - Secret values live only in the DSH credential seam (`ctx.credentials`) or
 *   the process environment at runtime. They are never written into plugin
 *   files, bundle patches, generated profiles, logs, or error text. The plugin
 *   never creates a plaintext secret file: when no writable seam is mounted it
 *   fails closed rather than persisting a secret to disk.
 * - Pre-existing legacy plaintext secret files are migrated into the credential
 *   seam once and then removed (best effort — see removeLegacyFile).
 * - Anything that could carry a secret into a log or an HTTP error body is
 *   redacted first.
 *
 * @module @local/dsh-account-hub/lib/secrets
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'

/** Credential references owned by this plugin. */
export const REFS = Object.freeze({
  managementKey: 'CLIPROXY_MANAGEMENT_KEY',
})

/**
 * Patterns whose matches must never reach a log, an error message, or a
 * response body. Covers JWTs (ChatGPT access/session tokens), OpenAI-style
 * keys, this plugin's management keys, proxy client keys, and bearer values.
 */
const SECRET_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bmgmt-[A-Za-z0-9]{8,}\b/g,
  /\bdsh-[a-f0-9]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /(__Secure-next-auth\.session-token=)[^;\s"']+/g,
]

/**
 * Redact every known secret shape from a string.
 * @param text - any diagnostic text.
 * @returns the text with secret-shaped spans replaced.
 */
export function redact(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, match =>
      match.startsWith('__Secure-next-auth.session-token=')
        ? '__Secure-next-auth.session-token=[redacted]'
        : '[redacted]')
  }
  return out
}

/**
 * Resolve the credential service from a plugin context without requiring it:
 * headless profiles may mount this plugin without the credential seam.
 * @param ctx - plugin context.
 * @returns the credential provider, or undefined.
 */
export function credentialsOf(ctx) {
  try {
    return ctx.get?.('credentials') ?? ctx.credentials
  } catch {
    return undefined
  }
}

/**
 * Read one secret: credential seam first, then the process environment.
 * Never caches — a changed credential must reach the next operation.
 * @param ctx - plugin context.
 * @param ref - credential reference name.
 * @returns the value, or undefined when unconfigured.
 */
export async function readSecret(ctx, ref) {
  const creds = credentialsOf(ctx)
  if (creds !== undefined) {
    try {
      const resolved = await creds.resolve(ref)
      if (resolved !== undefined && resolved.value.length > 0) return resolved.value
    } catch { /* fall through to ambient */ }
  }
  const ambient = process.env[ref]
  return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
}

/**
 * Store one secret in the credential seam.
 * @param ctx - plugin context.
 * @param ref - credential reference name.
 * @param value - non-empty secret value.
 * @returns true when stored; false when no writable seam is mounted.
 */
export async function writeSecret(ctx, ref, value) {
  const creds = credentialsOf(ctx)
  if (creds === undefined || typeof value !== 'string' || value.trim().length === 0) return false
  await creds.set(ref, value.trim())
  return true
}

/**
 * Remove one secret from the credential seam.
 * @param ctx - plugin context.
 * @param ref - credential reference name.
 */
export async function deleteSecret(ctx, ref) {
  const creds = credentialsOf(ctx)
  if (creds === undefined) return
  try { await creds.unset(ref) } catch { /* absent is fine */ }
}

/**
 * Remove a pre-existing legacy plaintext secret file: overwrite its bytes with
 * zeros, then unlink it. This is BEST EFFORT, not guaranteed secure erasure —
 * copy-on-write filesystems, SSD wear levelling, and journaling may retain old
 * blocks. The authoritative copy is the credential seam; this only removes the
 * convenient plaintext copy from the directory. Never used to create a file.
 * @param file - absolute path of the legacy file.
 */
export function removeLegacyFile(file) {
  try {
    if (!existsSync(file)) return
    const size = readFileSync(file).length
    writeFileSync(file, Buffer.alloc(size))
    unlinkSync(file)
  } catch { /* best effort: the credential copy is authoritative */ }
}

/**
 * Migrate one legacy plaintext file into the credential seam, then remove it.
 * Idempotent: a missing file or an already-stored credential is a no-op.
 * @param ctx - plugin context.
 * @param file - absolute path of the legacy file.
 * @param ref - credential reference to store the value under.
 * @returns whether a migration happened.
 */
export async function migrateLegacyFile(ctx, file, ref) {
  if (!existsSync(file)) return false
  let value
  try { value = readFileSync(file, 'utf8').trim() } catch { return false }
  if (value.length === 0) { removeLegacyFile(file); return false }
  const stored = await writeSecret(ctx, ref, value)
  if (stored) removeLegacyFile(file)
  return stored
}