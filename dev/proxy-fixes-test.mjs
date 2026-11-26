import assert from 'node:assert/strict'
import {
  ANTIGRAVITY_ERROR_RULE,
  IDENTITY_MASKS,
  MAX_RETRY_INTERVAL_SECONDS,
  MIN_REQUEST_RETRY,
  planProxyFixes,
} from '../lib/proxy-fixes.js'

const OLD_MASK = IDENTITY_MASKS[0].pattern
const NEW_MASK = IDENTITY_MASKS[1].pattern

// An untouched proxy gets both masks, the scoped 429 rule, and a retry floor.
const empty = planProxyFixes({})
assert.equal(empty.changed, true)
assert.equal(empty.addedMasks, 2)
assert.equal(empty.scopedRuleAdded, true)
assert.equal(empty.retriesRaised, true)
assert.equal(empty.intervalRaised, true)
assert.deepEqual(empty.patch.oauth.providers.antigravity['sensitive-patterns-replace'], IDENTITY_MASKS)
assert.deepEqual(empty.patch.oauth['request-scoped-errors'].antigravity, [ANTIGRAVITY_ERROR_RULE])
assert.equal(empty.patch.routing.retry['request-retry'], MIN_REQUEST_RETRY)
assert.equal(empty.patch.routing.retry['max-retry-interval'], MAX_RETRY_INTERVAL_SECONDS)

// Older patch: only the old mask and the rule exist, retries were lowered to 1.
const older = planProxyFixes({
  oauth: {
    providers: { antigravity: { 'sensitive-patterns-replace': [{ pattern: OLD_MASK, replacement: 'keep me' }] } },
    'request-scoped-errors': { antigravity: [{ status: 429, match: ['RESOURCE_EXHAUSTED'], action: 'stop' }] },
  },
  routing: { retry: { 'request-retry': 1, 'max-retry-interval': 30 } },
})
assert.equal(older.addedMasks, 1)
assert.equal(older.scopedRuleAdded, false)
assert.equal(older.retriesRaised, true)
assert.equal(older.intervalRaised, false)
assert.deepEqual(older.patch.oauth.providers.antigravity['sensitive-patterns-replace'], [
  { pattern: OLD_MASK, replacement: 'keep me' },
  IDENTITY_MASKS[1],
])
assert.equal(older.patch.oauth['request-scoped-errors'], undefined)
assert.deepEqual(older.patch.routing, { retry: { 'request-retry': MIN_REQUEST_RETRY, 'max-retry-interval': 30 } })

// A fully patched proxy is left alone.
const patched = planProxyFixes({
  oauth: {
    providers: { antigravity: { 'sensitive-patterns-replace': [{ pattern: OLD_MASK, replacement: 'a' }, { pattern: NEW_MASK, replacement: 'b' }] } },
    'request-scoped-errors': { antigravity: [ANTIGRAVITY_ERROR_RULE] },
  },
  routing: { retry: { 'request-retry': MIN_REQUEST_RETRY, 'max-retry-interval': MAX_RETRY_INTERVAL_SECONDS } },
})
assert.deepEqual(patched, {
  patch: {}, addedMasks: 0, scopedRuleAdded: false, retriesRaised: false, intervalRaised: false, changed: false,
})

// Unrelated custom rules are preserved while missing masks are appended.
const unrelated = planProxyFixes({
  oauth: { providers: { antigravity: { 'sensitive-patterns-replace': [{ pattern: 'unrelated\\.', replacement: 'x' }, { pattern: OLD_MASK, replacement: 'y' }] } } },
})
assert.equal(unrelated.addedMasks, 1)
assert.equal(unrelated.patch.oauth.providers.antigravity['sensitive-patterns-replace'].length, 3)

console.log('6 proxy-fix tests passed')
