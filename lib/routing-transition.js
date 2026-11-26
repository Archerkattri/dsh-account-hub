import { preferenceFor } from './account-selection.js'

/** Providers whose exclusive state must be cleared when Fill-first is left. */
export function providersToRestore(state, previousStrategy, nextStrategy) {
  if (previousStrategy !== 'fill-first' || nextStrategy === 'fill-first') return []
  return Object.keys(state?.providers ?? {}).filter(provider => preferenceFor(state, provider) !== undefined)
}

/** Plan exclusive state to reapply if restoring pools or changing strategy fails. */
export function planStrategyTransition(state, previousStrategy, nextStrategy) {
  const restore = providersToRestore(state, previousStrategy, nextStrategy)
  return {
    restore,
    rollback: restore.map(provider => ({ provider, selected: state.providers[provider].selected })),
  }
}

/** Validate that all credentials saved in exclusive-selection snapshots still exist. */
export function validateTransitionCredentials(state, transition, files) {
  const names = new Set((Array.isArray(files) ? files : []).map(file => file.name ?? file.id))
  for (const entry of transition.rollback) {
    const preference = state.providers?.[entry.provider]
    const targetExists = names.has(entry.selected)
    const baselineExists = preference?.baseline !== undefined && preference.baseline !== null && typeof preference.baseline === 'object'
    const savedNamesExist = baselineExists && Object.keys(preference.baseline).every(name => names.has(name))
    if (!targetExists || !baselineExists || !savedNamesExist) {
      return false
    }
  }
  return true
}
