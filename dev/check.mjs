/**
 * Static checks that need no running Harness or proxy. Run in CI and before a
 * release: `node dev/check.mjs`.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const problems = []
const notes = []

/** Fail one check. */
function fail(message) {
  problems.push(message)
}

// 1. Manifest parses, has no BOM, and points at files that exist.
const manifestPath = join(root, 'package.json')
const manifestBytes = readFileSync(manifestPath)
if (manifestBytes[0] === 0xef && manifestBytes[1] === 0xbb && manifestBytes[2] === 0xbf) {
  fail('package.json starts with a byte-order mark; the loader will reject it as invalid JSON')
}
let manifest
try {
  manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''))
} catch (error) {
  fail(`package.json is not valid JSON: ${error.message}`)
}
if (manifest !== undefined) {
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (String(target).includes('*')) {
      // A wildcard export names a pattern, not one file: check its directory.
      const directory = join(root, dirname(String(target)))
      if (!existsSync(directory)) fail(`exports["${subpath}"] pattern directory is missing: ${dirname(String(target))}`)
      continue
    }
    const file = join(root, String(target))
    if (!existsSync(file)) fail(`exports["${subpath}"] points at a missing file: ${target}`)
  }
  if (manifest.dsh?.bundle?.patch !== undefined && !existsSync(join(root, String(manifest.dsh.bundle.patch)))) {
    fail(`dsh.bundle.patch points at a missing file: ${manifest.dsh.bundle.patch}`)
  }
  if (manifest.dsh?.client?.platform !== 'web') fail('dsh.client.platform must be "web"')
  if (typeof manifest.version !== 'string') fail('manifest has no version')
}

// 2. Every runtime file is BOM-free: a BOM in a JS or JSON file breaks parsing.
for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json']) {
  const path = join(root, file)
  if (!existsSync(path)) {
    fail(`missing runtime file: ${file}`)
    continue
  }
  const bytes = readFileSync(path)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail(`${file} starts with a byte-order mark`)
}

// 3. The client factory id must equal the package name, or the module table will
//    not match it to the graph row.
const client = readFileSync(join(root, 'client.js'), 'utf8')
const idMatch = client.match(/__ModuleLoader__\.load\(\{\s*\n\s*id:\s*'([^']+)'/)
if (idMatch === null) fail('client.js does not register a module loader factory with an id')
else if (manifest !== undefined && idMatch[1] !== manifest.name) {
  fail(`client.js registers id "${idMatch[1]}" but the package is "${manifest.name}"`)
}

// 4. The bundle patch must insert the package it belongs to.
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
if (!patch.includes('insert:')) fail('cordis.patch.yml has no insert: list')
if (manifest !== undefined && !patch.includes(manifest.name)) fail(`cordis.patch.yml does not insert ${manifest.name}`)

// 4b. The installable artifact must not ship development probes or CI config.
if (manifest !== undefined) {
  for (const excluded of ['dev', '.github']) {
    if ((manifest.files ?? []).includes(excluded)) {
      fail(`package.json "files" ships "${excluded}"; development/CI files must stay out of the installable artifact`)
    }
  }
}

// 4c. No plaintext secret fallback: the host module must never write a plaintext
//     key file, and must resolve the web token through the seam only.
const indexText = readFileSync(join(root, 'index.js'), 'utf8')
if (/writeFileSync\(\s*legacyKeyFile/.test(indexText)) {
  fail('index.js writes a plaintext legacy key file; secrets must live only in the credential seam')
}
if (/Seam-less headless fallback/.test(indexText)) {
  fail('index.js still reads a plaintext token file as a fallback; the seam is the only durable store')
}

// 5. Locale metadata: title, description, and a detail document that exists.
for (const locale of ['en', 'zh']) {
  const path = join(root, 'locale', `${locale}.json`)
  if (!existsSync(path)) continue
  let meta
  try {
    meta = JSON.parse(readFileSync(path, 'utf8')).meta ?? {}
  } catch (error) {
    fail(`locale/${locale}.json is not valid JSON: ${error.message}`)
    continue
  }
  if (typeof meta.title !== 'string' || meta.title.length === 0) fail(`locale/${locale}.json has no meta.title`)
  if (typeof meta.description !== 'string' || meta.description.length === 0) fail(`locale/${locale}.json has no meta.description`)
  if (typeof meta.detail === 'string' && !existsSync(join(root, meta.detail))) {
    fail(`locale/${locale}.json names a missing detail document: ${meta.detail}`)
  }
}

// 6. Icon: exists, is SVG, and stays well under the 256 KiB limit.
const iconPath = join(root, 'icon.svg')
if (!existsSync(iconPath)) fail('icon.svg is missing')
else {
  const icon = readFileSync(iconPath, 'utf8')
  if (!icon.trimStart().startsWith('<svg')) fail('icon.svg does not start with <svg')
  const size = readFileSync(iconPath).length
  if (size > 256 * 1024) fail(`icon.svg is ${size} bytes, above the 256 KiB limit`)
  notes.push(`icon.svg ${size} bytes`)
}

// 7. Secret scan: no secret-shaped literal may live in any package file.
//    Test fixtures must assemble such strings at runtime, not embed them.
const SECRET_SHAPES = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bmgmt-[A-Za-z0-9]{8,}\b/,
  /\bdsh-[a-f0-9]{16,}\b/,
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/,
  /__Secure-next-auth\.session-token=[A-Za-z0-9._-]{12,}/,
]
/** Recursively collect scannable files under a package-relative directory. */
function walk(dir, out = []) {
  const abs = join(root, dir)
  if (!existsSync(abs)) return out
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = join(dir, entry.name)
    if (entry.isDirectory()) walk(rel, out)
    else if (/\.(js|mjs|cjs|json|md|yml|yaml)$/.test(entry.name)) out.push(rel)
  }
  return out
}
const scanFiles = ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'SECURITY.md', 'CHANGELOG.md']
for (const dir of ['lib', 'dev', 'docs', 'locale']) walk(dir, scanFiles)
for (const file of scanFiles) {
  const path = join(root, file)
  if (!existsSync(path)) continue
  const text = readFileSync(path, 'utf8')
  for (const shape of SECRET_SHAPES) {
    if (shape.test(text)) fail(`${file} contains a secret-shaped literal (${shape}); secrets must never be committed`)
  }
}
notes.push(`secret scan covered ${scanFiles.length} files`)

// 8. Syntax: every runtime and dev JavaScript file parses.
const syntaxFiles = ['index.js', 'client.js']
for (const rel of walk('lib').concat(walk('dev'))) {
  if (/\.(js|mjs|cjs)$/.test(rel)) syntaxFiles.push(rel)
}
for (const file of syntaxFiles) {
  const bytes = readFileSync(join(root, file))
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail(`${file} starts with a byte-order mark`)
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8' })
  if (result.status !== 0) fail(`${file} failed syntax check: ${result.stderr.trim().split('\n')[0]}`)
}
notes.push(`syntax checked ${syntaxFiles.length} files`)

if (problems.length > 0) {
  console.error('account-hub check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`account-hub check passed (${manifest?.name}@${manifest?.version})`)
for (const note of notes) console.log(`  · ${note}`)
