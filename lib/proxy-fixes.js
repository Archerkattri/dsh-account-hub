/**
 * Proxy configuration repairs the account page applies for this Harness.
 *
 * Google's Cloud Code Assist endpoint behind the Antigravity channel answers a
 * request whose system prompt carries another agent's identity sentence with a
 * fake `429 RESOURCE_EXHAUSTED`. Each rule below rewrites one such sentence on
 * the way out; the conversation is otherwise unchanged. Planning is pure so the
 * merge stays idempotent and testable.
 */

/** Identity sentences known to trip the Antigravity circuit breaker. */
export const IDENTITY_MASKS = [
  {
    pattern: 'You are an AI agent powered by DeepSeek Harness\\.',
    replacement: 'You are a helpful coding assistant.',
  },
  {
    pattern: 'You are a coding agent powered by the [^"\\\\]{1,80} model\\.',
    replacement: 'You are a helpful coding assistant.',
  },
]

/** Status-matched rule that stops one poisoned 429 from walking the pool. */
export const ANTIGRAVITY_ERROR_RULE = Object.freeze({ status: 429, match: ['RESOURCE_EXHAUSTED'], action: 'stop' })

/** Retry floor: enough that a short upstream throttle never reaches the client. */
export const MIN_REQUEST_RETRY = 5
/** Ceiling for the proxy's own retry backoff, in seconds. */
export const MAX_RETRY_INTERVAL_SECONDS = 30

/**
 * Compute the patch that brings a proxy configuration up to date.
 * @param config - the proxy's current `/v8/management/config` body.
 * @returns the patch body (empty when nothing is missing) and a change summary.
 */
export function planProxyFixes(config) {
  const antigravity = config?.oauth?.providers?.antigravity ?? {}
  const patterns = Array.isArray(antigravity['sensitive-patterns-replace'])
    ? antigravity['sensitive-patterns-replace']
    : []
  const missing = IDENTITY_MASKS.filter(mask => !patterns.some(entry => entry?.pattern === mask.pattern))

  const scoped = config?.oauth?.['request-scoped-errors']?.antigravity
  const scopedStop = Array.isArray(scoped)
    && scoped.some(entry => entry?.status === ANTIGRAVITY_ERROR_RULE.status && entry?.action === 'stop')

  const retry = config?.routing?.retry?.['request-retry']
  const maxInterval = config?.routing?.retry?.['max-retry-interval']
  const retryRaised = !(typeof retry === 'number' && retry >= MIN_REQUEST_RETRY)
  const intervalRaised = !(typeof maxInterval === 'number' && maxInterval >= MAX_RETRY_INTERVAL_SECONDS)

  const patch = {}
  if (missing.length > 0) {
    patch.oauth = {
      providers: {
        antigravity: {
          'sensitive-patterns-replace': [...patterns, ...missing],
        },
      },
    }
  }
  if (!scopedStop) {
    patch.oauth = {
      ...(patch.oauth ?? {}),
      'request-scoped-errors': {
        ...(config?.oauth?.['request-scoped-errors'] ?? {}),
        antigravity: [...(Array.isArray(scoped) ? scoped : []), ANTIGRAVITY_ERROR_RULE],
      },
    }
  }
  // Antigravity throttles intermittently even when its quota is healthy. Absorb
  // that inside the proxy with bounded retries so a short window never surfaces
  // as a failed model request in the conversation.
  if (retryRaised || intervalRaised) {
    patch.routing = {
      retry: {
        ...(config?.routing?.retry ?? {}),
        ...(retryRaised ? { 'request-retry': MIN_REQUEST_RETRY } : {}),
        ...(intervalRaised ? { 'max-retry-interval': MAX_RETRY_INTERVAL_SECONDS } : {}),
      },
    }
  }

  return {
    patch,
    addedMasks: missing.length,
    scopedRuleAdded: !scopedStop,
    retriesRaised: retryRaised,
    intervalRaised,
    changed: Object.keys(patch).length > 0,
  }
}
