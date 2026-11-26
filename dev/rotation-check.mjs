/**
 * Rotation check: send a few prompts through the proxy and report how the
 * per-account counters moved. With one account everything lands there; with two
 * or more you can see the split, and with `fill-first` you can see one account
 * being drained before the next.
 *
 *   CLIPROXY_API_KEY=<proxy client key> node dev/rotation-check.mjs [model] [count]
 *
 * Reads the account list from the running Harness plugin endpoint
 * (ACCOUNT_HUB_URL overrides `http://127.0.0.1:3080/plugins/account-hub`).
 */

const base = process.env.ACCOUNT_HUB_URL ?? 'http://127.0.0.1:3080/plugins/account-hub'
const proxy = process.env.CLIPROXY_URL ?? 'http://127.0.0.1:8317'
const apiKey = process.env.CLIPROXY_API_KEY
const model = process.argv[2] ?? 'gemini-3-flash'
const count = Number(process.argv[3] ?? 4)

if (apiKey === undefined || apiKey.length === 0) {
  console.error('set CLIPROXY_API_KEY to one of the proxy config api-keys')
  process.exit(2)
}

/** Read the plugin's account view. */
async function state() {
  const response = await fetch(`${base}/state`)
  if (!response.ok) throw new Error(`state ${response.status}`)
  return response.json()
}

/** One conversation turn through the proxy. */
async function prompt(index) {
  const response = await fetch(`${proxy}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 8,
      stream: false,
      messages: [{ role: 'user', content: `rotation check ${index}` }],
    }),
  })
  const text = await response.text()
  if (response.ok) return 'ok'
  try {
    const parsed = JSON.parse(text)
    return parsed?.error?.code ?? parsed?.error?.type ?? `http ${response.status}`
  } catch {
    return `http ${response.status}`
  }
}

const before = await state()
const snapshot = new Map(before.accounts.map(account => [account.name, { ok: account.success, fail: account.failed }]))

const outcomes = []
for (let index = 1; index <= count; index += 1) {
  outcomes.push(await prompt(index))
  await new Promise(resolve => setTimeout(resolve, 400))
}

const after = await state()
console.log(`model ${model} · routing ${after.routing} · ${count} requests`)
console.log(`outcomes: ${outcomes.join(', ')}`)
for (const account of after.accounts) {
  const prior = snapshot.get(account.name) ?? { ok: 0, fail: 0 }
  const deltaOk = account.success - prior.ok
  const deltaFail = account.failed - prior.fail
  if (deltaOk === 0 && deltaFail === 0) continue
  console.log(`  ${account.provider}/${account.displayLabel ?? account.label}: +${deltaOk} ok, +${deltaFail} failed`)
}
