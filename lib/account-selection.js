/**
 * Exclusive provider-account selection layered on CLIProxyAPI credential status.
 * No secrets are stored: the small preference record contains account file
 * names (which can include account identifiers such as email addresses) and each
 * account's original enabled/disabled state so Auto can restore the exact prior
 * pool after the explicit single-account choice is cleared.
 */

/** Return one provider's exclusive-selection preference, if any. */
export function preferenceFor(state, provider) {
  return state?.version === 1 ? state.providers?.[provider] : undefined
}

/** Manual account enable/disable must exit exclusive mode first. */
export function shouldRestoreBeforeStatusAction(preference, action) {
  return preference !== undefined && (action === 'enable' || action === 'disable')
}

/** Create a baseline snapshot without mutating the credential records. */
function snapshot(files) {
  return Object.fromEntries(files.map(file => [file.name ?? file.id, { disabled: file.disabled === true }]))
}

/**
 * Plan the status mutations for selecting one account exclusively or restoring
 * the pre-selection pool with Auto.
 * @param allFiles - current CLIProxyAPI `/credentials` records.
 * @param provider - exact CLIProxy provider id.
 * @param selectedName - account file name, or null to restore Auto.
 * @param previous - existing provider preference.
 * @returns changes plus the new preference (undefined means clear it).
 */
export function planAccountSelection(allFiles, provider, selectedName, previous) {
  const files = (Array.isArray(allFiles) ? allFiles : []).filter(file =>
    (file.provider ?? file.type) === provider
      && typeof (file.name ?? file.id) === 'string'
      && !(file.name ?? file.id).startsWith('.'))
  const uniqueNames = new Set()
  for (const file of files) {
    const name = file.name ?? file.id
    if (uniqueNames.has(name)) throw new Error('proxy returned duplicate account names; refusing to mutate ambiguous credentials')
    uniqueNames.add(name)
  }
  const byName = new Map(files.map(file => [file.name ?? file.id, file]))
  const baseline = previous?.baseline && typeof previous.baseline === 'object'
    ? { ...previous.baseline }
    : snapshot(files)
  for (const name of Object.keys(baseline)) {
    if (!byName.has(name)) delete baseline[name]
  }

  // A newly authenticated account is normally enabled by the proxy, so record
  // it as enabled while selected. A new but already-disabled account remains
  // disabled when Auto is restored.
  if (selectedName !== null && selectedName !== undefined && selectedName !== '') {
    for (const file of files) {
      const name = file.name ?? file.id
      if (baseline[name] === undefined) baseline[name] = { disabled: file.disabled === true }
    }
  }

  if (selectedName === null || selectedName === undefined || selectedName === '') {
    if (previous === undefined) return { changes: [], preference: undefined }
    const changes = []
    for (const [name, prior] of Object.entries(baseline)) {
      const file = byName.get(name)
      if (file === undefined) continue
      const disabled = prior?.disabled === true
      if ((file.disabled === true) !== disabled) changes.push({ name, disabled })
    }
    return { changes, preference: undefined, baseline }
  }

  const target = byName.get(selectedName)
  if (target === undefined) throw new Error('account does not belong to that provider')
  const targetBaseline = baseline[selectedName]
  if (targetBaseline?.disabled === true) throw new Error('an account that was disabled before selection cannot be preferred')
  if (target.unavailable === true || target.requires_sign_in === true) {
    throw new Error('that account is unavailable or needs sign-in')
  }

  const changes = []
  for (const file of files) {
    const name = file.name ?? file.id
    const disabled = name !== selectedName
    if ((file.disabled === true) !== disabled) changes.push({ name, disabled })
  }
  return {
    changes,
    preference: { selected: selectedName, baseline },
  }
}
