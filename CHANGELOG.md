# Changelog

Versions before 3.0 belonged to earlier, multi-component designs and are not
listed; 3.0 is the single-plugin rewrite that this repository ships.

## 3.3.4

Gemini guidance rewritten: the Google AI Studio / Vertex API-key route and
Google's official Antigravity ACP client are documented as the supported paths,
while the CLIProxy route is described as unsupported for Antigravity rather than
as a blanket "do not use Gemini". No functional change.

## 3.3.3

Documentation and scope correction; no functional change. ACP is now stated
explicitly as out of scope and unimplemented, the Antigravity guidance says not
to connect accounts here and points to the official ACP client as a separate
product, the identity-mask scope is documented as fingerprint mitigation rather
than compliance, and the published-history note explains the release squash.

## 3.3.2

- Proxy repair now guarantees 5 retry rounds with a 30-second ceiling instead of
  lowering the retry budget, so a brief Antigravity throttle is absorbed inside
  the proxy before it reaches the conversation.
- Identity masks and the scoped `429 RESOURCE_EXHAUSTED` stop rule are unchanged.

## 3.3.1

- Added a second identity mask for the current Harness persona form
  (`You are a coding agent powered by the <model> model.`); existing custom rules
  are preserved and missing rules are appended.
- Extracted proxy repair planning into `lib/proxy-fixes.js` with unit tests.
- Documented that Antigravity's `sensitive-patterns-replace` applies to native
  Gemini ingress, not to OpenAI-compatible system messages.

## 3.3.0

- Added 5-hour and weekly quota windows with reset countdowns for every account.
- Antigravity quota is read from Google's quota summary through the proxy's
  management `api-call` with `$TOKEN$` substitution; the plugin never handles the
  access token. Three Cloud Code hosts are tried in order.
- Codex quota signals are normalized into the same window shape.
- Quota reads are cached for one minute; failures degrade to "usage unavailable".
- Added 12 usage-normalization tests.

## 3.2.0

- Added an exclusive per-provider account selector under Fill first, with Auto
  restore of the previous enabled/disabled states and rollback on failure.
- Leaving Fill first restores the saved account pools before the strategy change.
- Added account-selection and routing-transition tests.

## 3.1.0

- Removed phone/Tailscale access from the plugin and streamlined the settings
  page.

## 3.0.0

- Single-plugin rewrite: one host half over a headless CLIProxyAPI, one settings
  page, direct `llm-pi-ai` routes.
- Secrets are stored only in the DSH credential seam; the plugin fails closed
  without a writable seam.
- Local-only guard on sensitive mutations; redacted diagnostics.

