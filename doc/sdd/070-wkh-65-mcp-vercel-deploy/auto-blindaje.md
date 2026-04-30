# Auto-Blindaje — WKH-65

## [2026-04-29 W3] Wave 3 — `event:` in log fields clobbered canonical event name

- **Error**: `T-HTTP-10` failed asserting that the `mcp.http.missing-bearer-token` event appeared in stderr; instead the `event` field was `_auth`.
- **Causa raíz**: `src/log.mjs::emit` builds `{ts, level, event, ...redact(fields)}`. When a caller passes `event` as a key inside the fields payload, the spread overrides the canonical event name. This is the exact same class as MNR-iter2-1 (already documented in handlers.mjs).
- **Fix**: In `api/mcp.mjs`, removed `event: '_auth'` / `event: '_config'` from the field payloads passed to `log.warn` / `log.error`. The first argument of `log.{info,warn,error}` is the only authoritative event name.
- **Aplicar en**: any future `log.*` call site — never include `event` as a key in the payload object. Adversary Review on this PR should grep for `\bevent:` inside `fields` arguments to `log.warn|log.error|log.info` and reject any match outside test fixtures.
