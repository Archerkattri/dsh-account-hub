/**
 * Usage-window normalization for the account page.
 *
 * Every provider reports quota differently, so the host reduces each source to
 * one shape the page renders: a window label ("5h" or "weekly"), the percentage
 * used, and the instant it resets. No credential material enters this module.
 */

/** Recognized window spellings, normalized to the two Antigravity windows. */
export function normalizeWindow(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '5h' || text === 'five-hour' || text === 'five_hour' || text === 'fivehour') return '5h'
  if (text === 'weekly' || text === 'week' || text === '7d' || text === 'seven-day' || text === 'seven_day') return 'weekly'
  return undefined
}

/** Short display label for one window. */
export function windowLabel(window) {
  if (window === '5h') return '5h'
  if (window === 'weekly') return 'week'
  if (window === 'monthly') return 'month'
  return 'limit'
}

/** Prefer the specific 5h window first, then the weekly cap. */
export function windowOrder(window) {
  if (window === '5h') return 0
  if (window === 'weekly') return 1
  if (window === 'monthly') return 2
  return 3
}

/** Clamp a percentage into 0..100 and round it. */
export function percentUsed(remainingFraction) {
  const fraction = Number(remainingFraction)
  if (!Number.isFinite(fraction)) return undefined
  return Math.max(0, Math.min(100, Math.round((1 - fraction) * 100)))
}

/** ISO timestamp to epoch seconds, or undefined when unparsable. */
export function epochSeconds(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const millis = Date.parse(value)
  return Number.isNaN(millis) ? undefined : Math.round(millis / 1000)
}

/** Compact group name: "Claude and GPT models" -> "Claude/GPT". */
export function groupLabel(name) {
  if (typeof name !== 'string') return undefined
  const trimmed = name.trim()
  if (trimmed.length === 0) return undefined
  return trimmed
    .replace(/\s+models?$/i, '')
    .replace(/\s+and\s+/i, '/')
    .trim()
}

/**
 * Reduce an Antigravity `retrieveUserQuotaSummary` payload to usage windows.
 * Missing groups or buckets are skipped: the upstream omits a group it has no
 * quota data for, and that must never fail the whole page.
 * @param payload - decoded quota summary.
 * @returns windows sorted by time window, then group.
 */
export function parseAntigravityUsage(payload) {
  const groups = Array.isArray(payload?.groups) ? payload.groups : []
  const windows = []
  for (const [index, group] of groups.entries()) {
    const groupName = groupLabel(group?.displayName ?? group?.display_name) ?? `Group ${index + 1}`
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const window = normalizeWindow(bucket?.window)
      const usedPercent = percentUsed(bucket?.remainingFraction ?? bucket?.remaining_fraction)
      if (window === undefined || usedPercent === undefined) continue
      const resetsAtEpoch = epochSeconds(bucket?.resetTime ?? bucket?.reset_time)
      windows.push({
        group: groupName,
        window,
        usedPercent,
        ...(resetsAtEpoch === undefined ? {} : { resetsAtEpoch }),
      })
    }
  }
  return windows.sort((left, right) =>
    windowOrder(left.window) - windowOrder(right.window)
    || String(left.group).localeCompare(String(right.group)))
}

/** Map Codex's primary/secondary signals onto the same usage shape. */
export function codexUsageWindows(limits) {
  const windows = []
  const push = (limit, window) => {
    if (window === undefined || !Number.isFinite(limit?.usedPercent)) return
    windows.push({
      window,
      usedPercent: Math.max(0, Math.min(100, limit.usedPercent)),
      ...(Number.isFinite(limit?.resetsAtEpoch) ? { resetsAtEpoch: limit.resetsAtEpoch } : {}),
    })
  }
  push(limits?.primary, windowForMinutes(limits?.primary?.windowMinutes))
  push(limits?.secondary, windowForMinutes(limits?.secondary?.windowMinutes))
  return windows
}

/** Classify a Codex limit window by its declared length in minutes. */
export function windowForMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined
  if (Math.abs(minutes - 300) <= 30) return '5h'
  if (Math.abs(minutes - 10080) <= 1440) return 'weekly'
  return undefined
}

/**
 * Reduce OpenCode Go `/inference/go/v1/usage` to the shared usage shape.
 * OpenCode reports percent-used directly (not a remaining fraction).
 * @param payload - decoded usage response.
 * @returns windows sorted by length.
 */
export function parseOpenCodeUsage(payload) {
  const usage = payload?.usage ?? {}
  const windows = []
  const mapping = [['rolling', '5h'], ['weekly', 'weekly'], ['monthly', 'monthly']]
  for (const [key, window] of mapping) {
    const entry = usage[key]
    const percent = Number(entry?.percent)
    if (!Number.isFinite(percent)) continue
    windows.push({
      window,
      usedPercent: Math.max(0, Math.min(100, Math.round(percent))),
      ...(epochSeconds(entry?.resetsAt) === undefined ? {} : { resetsAtEpoch: epochSeconds(entry.resetsAt) }),
    })
  }
  return windows.sort((left, right) => windowOrder(left.window) - windowOrder(right.window))
}
