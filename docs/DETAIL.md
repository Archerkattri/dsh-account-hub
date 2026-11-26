# Account Hub

Manage the AI subscriptions you already pay for from one page in DeepSeek
Harness: **Settings → Accounts**.

The bundle runs a headless [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
on loopback and drives its management API for you. It owns the proxy process,
the OAuth sign-ins, the account cards, quota, and rotation. Model traffic does
not pass through the plugin: your harness reaches the proxy through ordinary
`llm-pi-ai` provider routes.

## What the page does

- **One-click sign-in** for ChatGPT (Codex), Claude, Google Antigravity, Grok,
  Kimi, Kimi AI, Meta, and Devin. The provider page opens in a tab; the account
  appears when the callback lands.
- **Unlimited accounts per provider**, grouped by provider, with optional
  display names.
- **Per-account health**: status, plan, paid-through date, token expiry,
  cooldown reason and time, last two hours of request buckets, success/failure
  totals, and the upstream failure message when one exists.
- **Quota windows**: 5-hour and weekly bars with reset countdowns. ChatGPT/Codex
  uses the proxy's quota signals; Antigravity uses Google's quota summary,
  fetched through the proxy's management `api-call`, so the plugin never handles
  the access token.
- **Controls**: disable, enable, refresh the OAuth token, reset a cooldown,
  rename, remove.
- **Routing**: round-robin or fill-first, per-provider exclusive selection with
  Auto restore, and conversation stickiness ("pin conversations to one
  account").
- **Model sync**: push the proxy's model catalog into the profile's `llm-pi-ai`
  routes from the page.

## Scope

Included: the CLIProxyAPI process lifecycle, account sign-in and health, quota,
rotation, and model-catalog sync.

Deliberately not included: model route definitions, CLI/ACP subagents (Codex,
Claude Code, Antigravity ACP), MCP servers, research tooling. Those are profile
configuration, not account management.

## Terms of service

Some providers prohibit using subscription OAuth through a third-party proxy.
That is their policy, not a bug, and no setting here makes it safe.

- **Google Antigravity / Gemini**: accounts reached through third-party proxies
  are suspended (`403 PERMISSION_DENIED`, reason `TOS_VIOLATION`); re-login does
  not restore them and repeat offences escalate. The compliant path is Google's
  official Antigravity CLI as an ACP server (`agy acp`), driven by an ACP
  subagent backend. This bundle does not implement that path.
- **Claude Pro / Max**: Anthropic likewise prohibits proxying Claude Pro OAuth.
  Use the official local Claude Code CLI or Agent SDK.
- **ChatGPT / Codex**: OpenAI has been permissive with Codex OAuth clients, but
  proxying carries policy risk. Avoid multi-account farming and rapid IP
  switching.

Multiple accounts of one service can themselves violate its terms; rotation to
bypass limits is the documented risky case.

## How it works

```
Settings → Accounts
      │  /plugins/account-hub (loopback HTTP)
      ▼
Account Hub plugin ── management API ──▶ CLIProxyAPI (127.0.0.1:8317) ──▶ providers
      │                                        │
      └─ DSH credential seam (keys)            └─ provider auth files

Model traffic: llm-pi-ai route ─────────────────▶ CLIProxyAPI ──▶ provider
```

The plugin starts the proxy headless on mount (no console window), migrates any
legacy plaintext management key into the credential seam once, and runs a
30-second watchdog that respawns a dead proxy. Sign-ins live in the proxy's auth
directory, so restarts do not ask you to log in again.

The management key is generated once when the seam is writable and stored there;
the proxy keeps only a bcrypt hash. Without a writable seam the plugin fails
closed rather than writing a plaintext key.

## Antigravity request repair

Google's Cloud Code Assist endpoint behind the Antigravity channel answers
requests whose system prompt carries another agent's identity sentence with a
fake `429 RESOURCE_EXHAUSTED`, then cools the credential down. On first contact
the plugin writes three proxy settings, each only when absent:

1. `sensitive-patterns-replace` rules that mask the Harness identity sentences
   (`sensitive-patterns-replace` is applied to native Gemini ingress only, so
   keep agent-identity wording out of OpenAI-compatible system prompts).
2. A scoped `request-scoped-errors` rule: a `429 RESOURCE_EXHAUSTED` stops the
   request instead of walking the account pool.
3. A retry floor: 5 proxy retry rounds with a 30-second ceiling, so a brief
   throttle is absorbed before it reaches the conversation.

Set `ACCOUNT_HUB_NO_ANTIGRAVITY_PATCH=1` to skip all three.

## Security

- OAuth tokens stay in the proxy's auth directory; the plugin never copies,
  logs, or sends them to a browser.
- The management key lives only in the DSH credential seam; diagnostics are
  redacted before they leave the plugin.
- Sensitive mutations require a loopback socket **and** a loopback `Host`, so a
  reverse-proxy hop cannot change accounts. Read-only state stays readable.
- A build check scans every package file for secret-shaped literals.

Details: [SECURITY.md](../SECURITY.md).

## Development

See the repository [README](../README.md#development). Quick checks:

```bash
npm run verify          # static checks + all unit suites
node dev/render-check.mjs
node dev/auth-check.mjs  # live, needs the running stack
```

## Limitations

- The plugin manages CLIProxyAPI; capabilities (providers, models, refresh
  behaviour) are the proxy's, not the plugin's.
- Be aware of provider terms before adding a subscription account.
- Quota figures are cached for one minute and can lag the provider slightly.
