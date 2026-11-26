import assert from 'node:assert/strict'
import {
  codexUsageWindows,
  epochSeconds,
  groupLabel,
  parseAntigravityUsage,
  percentUsed,
  windowForMinutes,
} from '../lib/usage.js'

// Window spellings collapse to the two Antigravity windows.
assert.equal(windowForMinutes(300), '5h')
assert.equal(windowForMinutes(10080), 'weekly')
assert.equal(windowForMinutes(1440), undefined)

// Group labels lose the "models" suffix and join partners.
assert.equal(groupLabel('Gemini Models'), 'Gemini')
assert.equal(groupLabel('Claude and GPT models'), 'Claude/GPT')
assert.equal(groupLabel('  '), undefined)

// Remaining fraction becomes a rounded used percentage, clamped.
assert.equal(percentUsed(1), 0)
assert.equal(percentUsed(0.9725596), 3)
assert.equal(percentUsed(0), 100)
assert.equal(percentUsed(1.4), 0)
assert.equal(percentUsed('not a number'), undefined)

// ISO reset instants become epoch seconds.
assert.equal(epochSeconds('2026-11-25T04:27:04Z'), Math.round(Date.parse('2026-11-25T04:27:04Z') / 1000))
assert.equal(epochSeconds('nope'), undefined)

const summary = {
  groups: [
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { window: 'weekly', remainingFraction: 1, resetTime: '2026-12-01T23:27:04Z' },
        { window: '5h', remainingFraction: 0.5, resetTime: '2026-11-25T04:27:04Z' },
      ],
    },
    {
      displayName: 'Gemini Models',
      buckets: [
        { window: 'weekly', remainingFraction: 0.9825165, resetTime: '2026-12-01T23:27:04Z' },
        { window: '5h', remainingFraction: 0.9725596, resetTime: '2026-11-25T04:27:04Z' },
      ],
    },
  ],
}
const windows = parseAntigravityUsage(summary)
assert.deepEqual(windows.map(entry => [entry.group, entry.window, entry.usedPercent]), [
  ['Claude/GPT', '5h', 50],
  ['Gemini', '5h', 3],
  ['Claude/GPT', 'weekly', 0],
  ['Gemini', 'weekly', 2],
])
assert.equal(windows[0].resetsAtEpoch, Math.round(Date.parse('2026-11-25T04:27:04Z') / 1000))

// A group without usable buckets is skipped, never fatal.
assert.deepEqual(parseAntigravityUsage({ groups: [{ displayName: 'Empty', buckets: [] }] }), [])
assert.deepEqual(parseAntigravityUsage({}), [])
assert.deepEqual(parseAntigravityUsage(undefined), [])

// Both buckets of a group, missing fraction skipped.
assert.deepEqual(parseAntigravityUsage({
  groups: [{ displayName: 'Gemini', buckets: [{ window: '5h' }, { window: 'weekly', remainingFraction: 232 }] }],
}).map(entry => [entry.window, entry.usedPercent]), [['weekly', 0]])

// Codex signals map onto the same shape, 5-hour first.
const codex = codexUsageWindows({
  primary: { usedPercent: 42, windowMinutes: 300, resetsAtEpoch: 1_795_481_304 },
  secondary: { usedPercent: 17, windowMinutes: 10080 },
})
assert.deepEqual(codex, [
  { window: '5h', usedPercent: 42, resetsAtEpoch: 1_795_481_304 },
  { window: 'weekly', usedPercent: 17 },
])
assert.deepEqual(codexUsageWindows({}), [])
assert.deepEqual(codexUsageWindows({ primary: { usedPercent: 5 } }), [])

console.log('12 usage tests passed')
