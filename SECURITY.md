# Security

This bundle handles AI subscription credentials, so here is exactly what it
touches and what it does not.

## What it stores, and where

- **OAuth tokens live in CLIProxyAPI's auth directory** (`~/.cli-proxy-api/*.json`
  by default) and nowhere else. This bundle never copies a token, never reads
  one, and never sends one to a browser.
- **The proxy's management key** lives in the DSH credential seam as
  `CLIPROXY_MANAGEMENT_KEY` and is passed to the proxy only over loopback.
  CLIProxyAPI bcrypt-hashes the copy in its `config.yaml`. A pre-existing legacy
  `~/.cli-proxy-api/.account-hub-key` file is migrated into the seam once and
  then removed. The plugin **never creates a plaintext key file**: if no writable
  credential seam is mounted it fails closed (no key is generated and the proxy
  config is left untouched) rather than persisting a secret to disk. Set
  `CLIPROXY_MANAGEMENT_KEY` in the environment to run without a seam.
- The explicit exclusive-account preference, when selected, is stored in
  `~/.cli-proxy-api/.account-hub-selection.json`. It contains only credential
  file names (which may include account identifiers such as email addresses) and
  each account's previous enabled/disabled flag; it never contains access tokens
  or other credentials. The file is ignored by Git. Choosing **Auto**
  restores the saved enabled/disabled state and removes that provider's preference.
  Exclusive selection disables other accounts in that provider pool, so requests
  can fail if the selected account is unavailable or out of quota.
- **Usage windows are read through the proxy, not through the plugin.** For
  Antigravity accounts the plugin asks the proxy's management `api-call` endpoint
  for Google's quota summary and passes `Authorization: Bearer $TOKEN$`; the
  proxy resolves and injects the access token, so the plugin never receives,
  logs, or stores it. Parsed windows (percent used and reset instants) live in
  the plugin's in-memory page state for one minute and are never written to disk.
- **The proxy's client API key** is held in the harness credential store as
  `CLIPROXY_API_KEY`, which is what the `llm-pi-ai` routes resolve.
- **No secret is ever written into plugin files, bundle patches, generated
  profiles, command-line arguments, logs, or Git.** The plugin creates no
  plaintext secret file at all; the credential seam is the only durable store it
  writes. Every diagnostic string passes a redactor (JWTs, `sk-`/`mgmt-`/`dsh-`
  keys, bearer values, session cookies) before it can leave the plugin, and
  `dev/check.mjs` fails the build on any secret-shaped literal in the package
  (scanned recursively) and on any reintroduced plaintext-fallback code path.
- **Legacy-file removal is best effort, not certified secure erasure.**
  `removeLegacyFile` overwrites a pre-existing plaintext file with zeros and
  unlinks it, but copy-on-write filesystems, SSD wear levelling, and journaling
  may retain old blocks. The authoritative copy is the credential seam; this
  only removes the convenient plaintext copy from the directory.

## Network surface

- The proxy listens on `127.0.0.1:8317` only (`host: "127.0.0.1"`).
- Its management API requires the management key, even from localhost, and
  remote management stays disabled.
- The plugin's own HTTP routes are served under `/plugins/account-hub` by the
  harness web server. Read-only state is open on any device; mutations
  (account changes, routing, sign-in) require a loopback socket **and** a
  loopback Host header, so a reverse-proxy hop cannot reach them.

## What it can do on your machine

- Spawn the `cli-proxy-api` process (detached) when it is not running.
- Read and rewrite CLIProxyAPI's own configuration through its management API:
  the Antigravity request rewrite, retry and cooldown routing rules, and the
  rotation strategy. Each write is limited to the documented management
  endpoints; no other file is modified.
- Delete an account through the proxy's credential API. That forgets the local
  token; it does not revoke the grant at the provider. Revoke there if needed.

## Risks you accept

- Signing in to a subscription through a third-party proxy can violate that
  provider's terms. Rotating several accounts to dodge rate limits is the
  documented risky case — the same warning T3 Code gives.
- Google has suspended accounts associated with Antigravity proxying; treat
  Antigravity as the highest-risk provider here.
- The credential directory is readable by your OS user and by any process
  running as that user, including agent tool processes.

## Reporting

Disable or remove the bundle and unset the `CLIPROXY_MANAGEMENT_KEY` credential
if you want it to stop managing the proxy. The proxy keeps running until you
stop it (`taskkill /IM cli-proxy-api.exe` on Windows) or remove it from autostart.