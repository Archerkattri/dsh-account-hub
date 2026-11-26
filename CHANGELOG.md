# Changelog

Versions before 3.0 belonged to earlier, multi-component designs and are not
listed; 3.0 is the single-plugin rewrite that this repository ships.

## 3.3.3

Corrections and the ACP companion; no functional change to Account Hub itself.

- Added the optional `acp/` companion bundle: it downloads Google's unmodified
  Antigravity CLI from the official updater manifest, verifies the SHA-512,
  links `agy`, and mounts `agy acp` through `@deepseek-ai/dsh-subagent-acp` as
  `subagent_antigravity`. No OAuth token is read, stored, or proxied; it does
  not wrap `agy -p` and does not rotate accounts.
- Rewrote the Gemini guidance: the AI Studio / Vertex API-key route and the
  official ACP client are the supported paths; the CLIProxy route is documented
  as unsupported for Antigravity instead of a blanket prohibition.
- Documented the identity-mask scope (native Gemini ingress only; fingerprint
  mitigation, not compliance) and the published-history note.

