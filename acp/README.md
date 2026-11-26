# Antigravity ACP companion bundle

This directory is an **optional companion bundle** for Account Hub. It mounts
Google's official Antigravity CLI as an ACP subagent so the agent can delegate
to Antigravity without any OAuth proxying.

It is a separate bundle on purpose: Account Hub manages CLIProxyAPI accounts;
this bundle runs the official client.

## What it does

- Installs Google's **unmodified** `antigravity-cli` binary from Google's own
  auto-updater manifest, verifying the manifest's SHA-512 before use.
- Mounts that binary as an ACP server (`agy acp`) through
  `@deepseek-ai/dsh-subagent-acp`.
- Exposes `subagent_antigravity` for delegation.
- Does **not** read, store, forward, or reuse any OAuth token; does **not**
  wrap `agy -p`; does **not** rotate Antigravity accounts.

## Google's constraints, as published

The permitted setup is narrow, and this bundle stays inside it:

- the official, unmodified binary — fetched from Google's updater manifest;
- native Google sign-in (`oauth-personal`) done interactively by the user;
- single-user, interactive development use;
- Gemini models only through ACP (the CLI's own model list);
- no token extraction or reuse, no `agy -p` inside agent loops, no automated
  multi-account rotation.

## Install

```bash
node acp/install.mjs          # fetch, verify, install, link `agy`
agy                           # sign in with Google once, then exit
```

Restart DeepSeek Harness afterwards. The bundle mounts itself; the CLI must be
on `PATH` (the installer links it into `~/.local/bin`).

Requirements: the profile must already have `@deepseek-ai/dsh-subagent-acp`
installed (Account Hub users normally do via the ACP row this bundle replaces).

## Verify

```bash
node acp/install.mjs --check   # exit 0 when the installed SHA-512 matches
agy --version                  # prints the CLI version
```

`subagent_antigravity` reports the model list the CLI advertises; with a signed
out CLI, delegation fails at the provider, not at the transport.
