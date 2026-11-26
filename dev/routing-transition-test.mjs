import assert from 'node:assert/strict'
import { planStrategyTransition, validateTransitionCredentials } from '../lib/routing-transition.js'

const state = {
  version: 1,
  providers: {
    codex: {
      selected: 'codex-a.json',
      baseline: { 'codex-a.json': { disabled: false }, 'codex-b.json': { disabled: false } },
    },
    antigravity: {
      selected: 'antigravity.json',
      baseline: { 'antigravity.json': { disabled: false } },
    },
  },
}

assert.deepEqual(planStrategyTransition(state, 'fill-first', 'round-robin'), {
  restore: ['codex', 'antigravity'],
  rollback: [
    { provider: 'codex', selected: 'codex-a.json' },
    { provider: 'antigravity', selected: 'antigravity.json' },
  ],
})
assert.deepEqual(planStrategyTransition(state, 'fill-first', 'fill-first'), { restore: [], rollback: [] })
assert.deepEqual(planStrategyTransition(state, 'round-robin', 'fill-first'), { restore: [], rollback: [] })
assert.deepEqual(planStrategyTransition({ version: 1, providers: {} }, 'fill-first', 'round-robin'), { restore: [], rollback: [] })
assert.equal(validateTransitionCredentials(state, planStrategyTransition(state, 'fill-first', 'round-robin'), [
  { name: 'codex-a.json' }, { name: 'codex-b.json' }, { name: 'antigravity.json' },
]), true)
assert.equal(validateTransitionCredentials(state, planStrategyTransition(state, 'fill-first', 'round-robin'), [
  { name: 'codex-a.json' }, { name: 'antigravity.json' },
]), false)
assert.equal(validateTransitionCredentials({
  version: 1,
  providers: { codex: { selected: 'codex-a.json', baseline: { 'codex-a.json': { disabled: false }, 'codex-deleted.json': { disabled: false } } } },
}, planStrategyTransition({
  version: 1,
  providers: { codex: { selected: 'codex-a.json', baseline: { 'codex-a.json': { disabled: false }, 'codex-deleted.json': { disabled: false } } } },
}, 'fill-first', 'round-robin'), [{ name: 'codex-a.json' }]), false)

console.log('6 routing-transition tests passed')
