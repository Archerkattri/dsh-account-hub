import assert from 'node:assert/strict'
import { planAccountSelection, shouldRestoreBeforeStatusAction } from '../lib/account-selection.js'
import { planStrategyTransition } from '../lib/routing-transition.js'

const files = [
  { name: 'codex-a.json', provider: 'codex', disabled: false },
  { name: 'codex-b.json', provider: 'codex', disabled: false },
  { name: 'codex-paused.json', provider: 'codex', disabled: true },
  { name: 'claude-a.json', provider: 'claude', disabled: false },
]

const selected = planAccountSelection(files, 'codex', 'codex-b.json', undefined)
assert.deepEqual(selected.changes, [
  { name: 'codex-a.json', disabled: true },
])
assert.equal(selected.preference.selected, 'codex-b.json')
assert.equal(selected.preference.baseline['codex-paused.json'].disabled, true)
assert.equal(files[0].disabled, false, 'planning must not mutate input records')

const restored = planAccountSelection(
  [
    { name: 'codex-a.json', provider: 'codex', disabled: true },
    { name: 'codex-b.json', provider: 'codex', disabled: false },
    { name: 'codex-paused.json', provider: 'codex', disabled: true },
    ...files.filter(file => file.provider === 'claude'),
  ],
  'codex', null, selected.preference,
)
assert.deepEqual(restored.changes, [{ name: 'codex-a.json', disabled: false }])
assert.equal(restored.preference, undefined)

const withNewAccount = planAccountSelection(
  [...files, { name: 'codex-new.json', provider: 'codex', disabled: false }],
  'codex', 'codex-b.json', selected.preference,
)
assert.equal(withNewAccount.changes.find(change => change.name === 'codex-new.json')?.disabled, true)
assert.equal(withNewAccount.preference.baseline['codex-new.json'].disabled, false)

const reselectedWithNewAccount = planAccountSelection(
  [
    { name: 'codex-a.json', provider: 'codex', disabled: true },
    { name: 'codex-b.json', provider: 'codex', disabled: false },
    { name: 'codex-paused.json', provider: 'codex', disabled: true },
    { name: 'codex-new.json', provider: 'codex', disabled: false },
  ], 'codex', 'codex-b.json', withNewAccount.preference,
)
assert.equal(reselectedWithNewAccount.preference.baseline['codex-new.json'].disabled, false)
assert.equal(reselectedWithNewAccount.changes.some(change => change.name === 'codex-new.json' && change.disabled === true), true)

const restoredWithNewAccount = planAccountSelection(
  [
    { name: 'codex-a.json', provider: 'codex', disabled: true },
    { name: 'codex-b.json', provider: 'codex', disabled: false },
    { name: 'codex-paused.json', provider: 'codex', disabled: true },
    { name: 'codex-new.json', provider: 'codex', disabled: true },
  ], 'codex', null, reselectedWithNewAccount.preference,
)
assert.deepEqual(restoredWithNewAccount.changes, [
  { name: 'codex-a.json', disabled: false },
  { name: 'codex-new.json', disabled: false },
])

assert.deepEqual(planStrategyTransition(
  { version: 1, providers: { codex: selected.preference } }, 'fill-first', 'round-robin',
), {
  restore: ['codex'],
  rollback: [{ provider: 'codex', selected: 'codex-b.json' }],
})
assert.deepEqual(planStrategyTransition(
  { version: 1, providers: { codex: selected.preference } }, 'round-robin', 'fill-first',
).restore, [])
assert.equal(shouldRestoreBeforeStatusAction(selected.preference, 'disable'), true)
assert.equal(shouldRestoreBeforeStatusAction(selected.preference, 'enable'), true)
assert.equal(shouldRestoreBeforeStatusAction(undefined, 'disable'), false)
assert.equal(shouldRestoreBeforeStatusAction(selected.preference, 'refresh'), false)

assert.throws(() => planAccountSelection(files, 'codex', 'claude-a.json', undefined), /does not belong/)
assert.throws(() => planAccountSelection(files, 'codex', 'codex-paused.json', undefined), /disabled before selection/)
assert.throws(() => planAccountSelection([
  { name: 'codex-gone.json', provider: 'codex', disabled: false, unavailable: true },
], 'codex', 'codex-gone.json', undefined), /unavailable/)

console.log('12 account-selection tests passed')
