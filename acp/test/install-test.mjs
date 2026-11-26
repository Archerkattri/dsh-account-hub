import assert from 'node:assert/strict'
import { targetFor, binaryName, sha512, MANIFEST_BASE } from '../install.mjs'

assert.match(MANIFEST_BASE, /^https:\/\//)
assert.equal(targetFor('win32', 'x64'), 'windows_amd64.json')
assert.equal(targetFor('win32', 'arm64'), 'windows_amd64.json')
assert.equal(targetFor('darwin', 'arm64'), 'mac_arm64.json')
assert.equal(targetFor('linux', 'x64'), 'linux_amd64.json')
assert.equal(targetFor('freebsd', 'x64'), null)
assert.equal(targetFor('linux', 'ia32'), null)
assert.equal(binaryName('win32'), 'agy.exe')
assert.equal(binaryName('darwin'), 'antigravity')
assert.match(sha512(Buffer.from('abc')), /^[a-f0-9]{128}$/)
console.log('acp installer tests passed')
