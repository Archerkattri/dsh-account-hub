#!/usr/bin/env node
/**
 * Install Google's official Antigravity CLI for the ACP subagent.
 *
 * Reads Google's auto-updater manifest, downloads the unmodified release for
 * this platform, verifies its SHA-512, and installs it under
 * ~/.dsh/tools/antigravity-cli/<version>/ plus a `agy` shim on the user's
 * bin directory. No OAuth token is read, written, or proxied.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, copyFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform, arch } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:https'

export const MANIFEST_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests'

export function targetFor(plat = platform(), cpu = arch()) {
  if (!['win32', 'darwin', 'linux'].includes(plat)) return null
  if (!['x64', 'arm64'].includes(cpu)) return null
  if (plat === 'win32') return 'windows_amd64.json'
  const os = plat === 'darwin' ? 'mac' : 'linux'
  return `${os}_${cpu === 'x64' ? 'amd64' : 'arm64'}.json`
}

export function binaryName(plat = platform()) {
  return plat === 'win32' ? 'agy.exe' : 'antigravity'
}

export function sha512(bytes) {
  return createHash('sha512').update(bytes).digest('hex').toLowerCase()
}

function fetch(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    request(url, { headers: { 'user-agent': 'dsh-antigravity-acp' } }, res => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location && redirects > 0) {
        res.resume()
        return resolve(fetch(res.headers.location, redirects - 1))
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return }
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject).setTimeout(300000, () => reject(new Error('timeout'))).end()
  })
}

export async function resolveManifest(plat = platform(), cpu = arch()) {
  const target = targetFor(plat, cpu)
  if (target === null) throw new Error(`unsupported platform ${plat}/${cpu}`)
  const manifest = JSON.parse((await fetch(`${MANIFEST_BASE}/${target}`)).toString('utf8'))
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? '')) throw new Error('manifest version malformed')
  if (!/^[a-fA-F0-9]{128}$/.test(manifest.sha512 ?? '')) throw new Error('manifest sha512 malformed')
  if (typeof manifest.url !== 'string' || !manifest.url.startsWith('https://storage.googleapis.com/')) throw new Error('manifest url malformed')
  return manifest
}

export function paths(version, plat = platform()) {
  const root = join(homedir(), '.dsh', 'tools', 'antigravity-cli')
  const bin = join(homedir(), '.local', 'bin')
  return {
    root,
    version,
    exe: join(root, version, binaryName(plat)),
    bin,
    shim: join(bin, binaryName(plat)),
  }
}

async function main() {
  const check = process.argv.includes('--check')
  const dry = process.argv.includes('--dry-run')
  const manifest = await resolveManifest()
  const p = paths(manifest.version)
  const installed = existsSync(p.exe) && sha512(readFileSync(p.exe)) === manifest.sha512.toLowerCase()
  console.log(`platform: ${platform()}/${arch()}`)
  console.log(`manifest: ${manifest.version} (${manifest.url})`)
  console.log(`installed: ${installed ? p.exe : 'no'}`)
  if (check) process.exit(installed ? 0 : 1)
  if (dry) { console.log(`would install to ${p.exe}\nwould link ${p.shim}`); return }
  if (!installed) {
    console.log('downloading...')
    const bytes = await fetch(manifest.url)
    if (sha512(bytes) !== manifest.sha512.toLowerCase()) throw new Error('SHA-512 mismatch; refusing to install')
    mkdirSync(join(p.root, manifest.version), { recursive: true })
    writeFileSync(p.exe, bytes, { mode: 0o755 })
    chmodSync(p.exe, 0o755)
    console.log(`installed ${p.exe}`)
  }
  mkdirSync(p.bin, { recursive: true })
  copyFileSync(p.exe, p.shim)
  chmodSync(p.shim, 0o755)
  console.log(`linked ${p.shim}`)
  console.log('Next: run `agy` once to sign in with Google, then restart DeepSeek Harness.')
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  main().catch(error => { console.error(`install failed: ${error.message}`); process.exit(1) })
}
