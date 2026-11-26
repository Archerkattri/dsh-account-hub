<div align="center">
  <img src="icon.svg" width="88" alt="Account Hub icon" />
  <h1>Account Hub</h1>
  <p><strong>One page for every AI subscription you already pay for.</strong><br />
  Sign in once in DeepSeek Harness: accounts, quota, and rotation in one place.</p>

  [![check](https://github.com/Archerkattri/dsh-account-hub/actions/workflows/check.yml/badge.svg)](https://github.com/Archerkattri/dsh-account-hub/actions/workflows/check.yml)
  [![version](https://img.shields.io/github/package-json/v/Archerkattri/dsh-account-hub?label=version)](https://github.com/Archerkattri/dsh-account-hub/blob/main/package.json)
  [![license](https://img.shields.io/github/license/Archerkattri/dsh-account-hub)](LICENSE)
</div>

---

> [!IMPORTANT]
> **Scope.** This bundle manages **accounts only**: sign-in, account cards,
> quota, rotation. Model routes, CLI subagents, and research tooling are *not*
> part of this plugin; they are ordinary profile configuration. It does **not**
> implement, wrap, or configure the official Antigravity ACP client — that is a
> separate application. See [Out of scope](#out-of-scope) and
> [Honest limitations](#honest-limitations).

## Why

Subscriptions are the cheapest tokens you own, but each provider wants its own
login, token refresh, and quota page. Account Hub collapses that into
**Settings -> Accounts**:

- Click a provider, finish the browser sign-in, the account appears.
- Add as many accounts per provider as you like; the local proxy rotates.
- See plan, token health, and 5-hour / weekly quota with reset countdowns.
- Disable, refresh, reset cooldown, rename, or remove any account in place.

The bundle also owns a headless CLIProxyAPI process: it starts on mount, creates
its management key in the DSH credential seam, and a 30-second watchdog respawns
it if it dies. Sign-ins live in the proxy auth directory, so a restart never asks
you to log in again.

## Features

| Area | What you get |
| --- | --- |
| **Providers** | ChatGPT (Codex), Claude, Google Antigravity, Grok, Kimi, Kimi AI, Meta, Devin |
| **Sign-in** | One-click OAuth from the page; the account appears when the callback lands |
| **Accounts** | Unlimited per provider, grouped by provider, with your own display names |
| **Quota** | 5-hour and weekly bars with `resets 3h 12m` countdowns; Antigravity shows its Gemini and Claude/GPT groups separately |
| **Health** | Plan, paid-through date, token expiry, cooldown reason/time, upstream failure text, 2-hour request sparkline, success/failure totals |
| **Actions** | Disable, enable, refresh token, reset cooldown, rename, remove |
| **Rotation** | Round-robin or Fill-first, plus per-provider exclusive selection |
| **Stickiness** | Pin one conversation to one account while it stays healthy |
| **Model sync** | Push the proxy model catalog into your `llm-pi-ai` routes from the page |

## Install

**1. Install CLIProxyAPI** from its repository (Windows: `winget install -e --id LuisPater.CLIProxyAPI`;
macOS: `brew install cliproxyapi`; Linux: the installer in the project docs). The
bundle is tested against CLIProxyAPI 8.1.x.

**2. Add the bundle to your profile**

```bash
# from a local checkout
dsh plugin --profile desktop add <path-to-this-directory>

# or from the published repository, pinned to a release tag
dsh plugin --profile desktop add github:Archerkattri/dsh-account-hub#v3.3.3
```

Pin a tag or commit SHA (as above): an unpinned `github:` spec follows `main`,
so a later push changes what runs on your machine.

From the app: **Plugins -> Add plugin -> this directory**.

**3. Restart DeepSeek Harness once**, then open **Settings -> Accounts**.

The proxy is started for you: headless, detached, no terminal window. If port
`8317` is already served by a CLIProxyAPI you run yourself, the bundle reuses it
instead of spawning a second one.

## The Accounts page

Each provider group contains one card per account:

```
* work | you@example.com        [active]     Disable  Refresh  Rename  Remove
  Plus | paid through Nov 29 | token 4d 23h
  5h    [###.......]  42%   resets 2h 14m
  week  [##........]  17%   resets 3d 04h
  sparkline | 128 ok / 3 failed
  Details > plan, tier, credits, cooldown, failure, models
```

- **Status**: `active`, `cooling down`, `disabled`, or `sign-in needed`.
- **Quota**: used percentage with a live reset countdown; hover for the absolute
  reset time. Colours go amber at 80% and red at 95%.
- **Details** folds everything not needed on every visit.

Quota sources: ChatGPT/Codex uses the proxy's own quota signals; Antigravity is
read from Google's quota summary through the proxy's management `api-call`, so
the access token never enters this plugin (see [SECURITY.md](SECURITY.md)).

### Rotation

| Mode | Behaviour |
| --- | --- |
| **Round-robin** | Spread requests across all enabled accounts of a provider |
| **Fill-first** | Drain one account before moving to the next |

Under **Fill-first** each provider group also offers an exclusive selector: pick
one account and the other accounts for that provider are disabled until you
choose **Auto**, which restores their previous enabled/disabled states. Leaving
Fill-first restores the saved pools automatically. This is deliberate
exclusivity, not failover: a cooling-down or out-of-quota selected account makes
that provider fail until you switch accounts or restore Auto.

**Pin conversations to one account** keeps an established conversation on one
credential while it is healthy, so two accounts do not alternate mid-chat.

## Terms of service

> [!WARNING]
> Some providers prohibit using subscription OAuth through a third-party proxy.
> That is their policy, not a bug in this plugin, and no rotation setting makes
> it safe.

- **Google Antigravity / Gemini**: **do not add Antigravity accounts to this
  plugin.** Google enforces its terms against Antigravity traffic that reaches
  it through a third-party proxy: accounts are suspended
  (`403 PERMISSION_DENIED`, reason `TOS_VIOLATION`), re-login does not restore
  them, and repeat offences escalate. The route Google documents is the
  official, unmodified `antigravity-acp` binary inside an ACP-capable client
  (for example T3 Code or Zed). That client is a separate product; **this
  bundle contains no ACP code and does not implement, wrap, or configure it**,
  and no setting here makes Antigravity proxying compliant.
- **Claude Pro / Max**: Anthropic likewise prohibits routing Claude Pro OAuth
  through third-party proxies. Use the official local Claude Code CLI or Agent
  SDK for that subscription.
- **ChatGPT / Codex**: OpenAI has been comparatively permissive with Codex OAuth
  clients, but proxying still carries policy risk. Avoid multi-account farming
  and rapid IP switching.
- **Multiple accounts** of one service can themselves violate its terms;
  rotation to bypass limits is the documented risky case.

Use official clients where they exist, and keep paid API keys for anything that
must be durable.

## Security

- Secrets live only in the DSH credential seam (`ctx.credentials`); the plugin
  never creates a plaintext key file and fails closed without a writable seam.
- The management key is passed to the proxy over loopback only; the proxy stores
  a bcrypt hash.
- Sensitive mutations are local-only: a loopback socket *and* a loopback `Host`
  are required, so a reverse-proxy hop cannot change accounts.
- Diagnostics are redacted (JWTs, API keys, bearer values, session cookies)
  before they leave the plugin, and a build check fails on any secret-shaped
  literal in the package.

Full details: [SECURITY.md](SECURITY.md).

## How it works

```
Settings -> Accounts
      |  /plugins/account-hub (loopback HTTP)
      v
Account Hub plugin -- management API --> CLIProxyAPI (127.0.0.1:8317) --> providers
      |                                      |
      +- DSH credential seam (keys)          +- provider auth files

Model traffic: llm-pi-ai route -----------> CLIProxyAPI --> provider
```

## Model routes

Accounts alone do not change the model picker. Point an `llm-pi-ai` provider at
the proxy (`openai-completions` on `/v1`, `anthropic-messages` on `/`,
`google-generative-ai` on `/v1beta`); the **Sync models** button keeps its model
list aligned with what the proxy actually serves. Examples are in
[docs/DETAIL.md](docs/DETAIL.md).

## Out of scope

Deliberately not in this plugin, so it stays small and auditable:

- model routes and picker entries (profile configuration),
- ACP / CLI subagents such as Codex, Claude Code, or Antigravity ACP,
- MCP servers, research skills, document tooling.

## Honest limitations

- **No ACP implementation.** The repository contains no ACP client, no
  `antigravity-acp` integration, and no subagent backend. Antigravity ACP users
  must run an official ACP client; this bundle neither provides nor configures
  that path.
- **Identity masks are scoped.** `sensitive-patterns-replace` applies to native
  Gemini ingress only, not to OpenAI-compatible system messages, and it rewrites
  two known Harness identity sentences. It avoids a known false-`429` trigger;
  it is fingerprint mitigation, not compliance, and it does not stop provider
  detection by other means.
- **Rotation is not safety.** Exclusive selection and fill-first affect routing
  only. Multiple subscription accounts, or rotation to dodge limits, remain a
  terms risk that belongs to the user.
- **History.** Published history begins at v3.3.2. Pre-publication commits were
  squashed during release cleanup to remove scratch files and personal
  references; the changelog is the record of behaviour changes since 3.0.

## Development

Installed as a link (`link:`), so edits apply immediately: a host change loads on
an app restart or a bundle disable/enable cycle; a client change needs a page
refresh.

```bash
npm run verify                        # everything below, in order
node dev/check.mjs                    # manifest, BOM, locale, icon, secret scan, syntax
node dev/secrets-test.mjs             # credential seam, fail-closed, migration
node dev/account-selection-test.mjs   # exclusive choice and Auto restore
node dev/routing-transition-test.mjs  # leaving Fill-first and rollback planning
node dev/usage-test.mjs               # quota window parsing and normalization
node dev/proxy-fixes-test.mjs         # identity-mask and proxy repair planning
node dev/render-check.mjs             # renders the settings page with account data
```

Live diagnostics (need the running stack; never print secrets):

```bash
node dev/auth-check.mjs                   # external-Host mutations are refused
node dev/probe.mjs                        # mounts apply() against the live proxy
node dev/rotation-check.mjs <model> <n>   # per-account rotation counters
```

Build a tarball for direct installation:

```bash
npm pack --cache "$TMPDIR/npm-cache"
# then: dsh plugin --profile desktop add ./local-dsh-account-hub-<version>.tgz
```

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLIPROXY_BIN` | `cli-proxy-api` | Proxy executable |
| `CLIPROXY_HOME` | `~/.cli-proxy-api` | Proxy home directory |
| `CLIPROXY_CONFIG` | `<home>/config.yaml` | Proxy config file |
| `CLIPROXY_PORT` | `8317` | Loopback port |
| `CLIPROXY_MANAGEMENT_KEY` | - | Override the stored management key |
| `ACCOUNT_HUB_NO_ANTIGRAVITY_PATCH` | - | `1` disables the automatic Antigravity request repair |

## License

[MIT](LICENSE)
