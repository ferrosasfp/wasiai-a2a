# Work Item — [WKH-91] Discord formatter polish — truncate, hostname, test hardening

## Resumen

Consolida 7 MNRs (4 AR + 3 CR, deduplicados) y 2 observaciones cosmetics de F4 QA emergentes de WKH-90 (Discord-aware payload formatting). No introduce cambios de contrato ni implicaciones de seguridad. Scope es exclusivo a `alerts.mjs` (producción) y `alerts.test.mjs` (tests).

Originado en: WKH-90 `done-report.md` — MNR-1/2/3/4 + MNR-CR-1/2/3/4 (3 dedup) + cosmetic QA x2.

## Sizing

- SDD_MODE: mini
- Estimación: S
- Pipeline: FAST AUTO
- Branch sugerido: feat/081-wkh-91-discord-formatter-polish

## Skills Router

- skill/node-testing — test hardening, mock patterns, unconditional assertions
- skill/api-contract — Discord embed field limits, hostname parsing

## Acceptance Criteria (EARS)

**AC-1** (MNR-1 / MNR-CR-1): WHEN `formatForDiscord` builds an embed and `title` length exceeds 256 characters, the system SHALL truncate the title to 255 characters and append `…` (U+2026), producing a final string of exactly 256 characters.

**AC-2** (MNR-1 / MNR-CR-1): WHEN `formatForDiscord` builds an embed and `description` length exceeds 4096 characters, the system SHALL truncate the description to 4095 characters and append `…` (U+2026), producing a final string of exactly 4096 characters.

**AC-3** (MNR-2): WHEN `sendAlert` parses `webhookUrl` to detect Discord, the system SHALL use `parsed.hostname` (port-stripped) instead of `parsed.host`, so that a URL with an explicit non-default port (e.g. `https://discord.com:8080/…`) is still recognised as a Discord host.

**AC-4** (MNR-3 / MNR-CR-4): WHEN `T-AL-DISC-06` executes, the system SHALL reach its body-shape assertions unconditionally — the test MUST NOT contain a conditional `if (captured)` guard. The test MUST use a structurally-invalid URL (one that `new URL()` rejects but Node `fetch` also rejects) or mock the `URL` constructor to force the throw, ensuring the raw-path branch is exercised deterministically and all assertions always run.

**AC-5** (MNR-4): WHEN `alerts.mjs` is imported by an external consumer, `formatForDiscord` SHALL be marked `@internal` in its JSDoc block (or removed from the public export surface if no external consumer is confirmed). No API contract change; annotation only.

**AC-6** (MNR-CR-2): the system SHALL define a named constant `DEFAULT_SEVERITY_LABEL = 'unknown'` and use it in `formatForDiscord` in place of the inline string literal `'unknown'` at line `:114` (`sev || 'unknown'`).

**AC-7** (MNR-CR-3): WHEN `formatForDiscord` resolves the embed timestamp, the system SHALL replace the nested ternary at `alerts.mjs:128-133` with a helper function `pickFirstNonEmpty(...candidates)` that iterates the candidates array and returns the first non-empty string, or `undefined` if none qualify.

**AC-8** (F4 cosmetic): the system SHALL update the block comment at `tests/alerts.test.mjs:216` from `"T-AL-DISC-01..04"` to `"T-AL-DISC-01..07"` to reflect the actual seven-test suite count.

**AC-9** (F4 observation): WHEN `sendAlert` receives an HTTP 429 response from the webhook endpoint, the system SHALL return `{sent: false, status: 429, reason: 'webhook status 429'}` without throwing. A dedicated unit test `T-AL-DISC-08` SHALL assert this exact shape.

## Scope IN

- `mcp-servers/wasiai-x402/src/alerts.mjs` — truncation logic (AC-1/2), `hostname` fix (AC-3), `DEFAULT_SEVERITY_LABEL` const (AC-6), `pickFirstNonEmpty` helper (AC-7), `@internal` annotation (AC-5)
- `mcp-servers/wasiai-x402/tests/alerts.test.mjs` — T-AL-DISC-06 hardening (AC-4), comment fix (AC-8), new T-AL-DISC-08 (AC-9)

## Scope OUT

- `mcp-servers/wasiai-x402/README.md` — already documents the feature; no doc update needed for polish
- Any other file in the repository — alerts is a library module; contract and public behavior do not change
- No new environment variables
- No schema changes, no DB changes, no HTTP API changes

## Decisiones tecnicas (DT-N)

- DT-1: Truncation formula is `slice(0, max - 1) + '…'` where max is 256 for title and 4096 for description. This guarantees the resulting string length equals max exactly, placing the ellipsis at the very end. A `truncate(s, max)` helper SHALL be extracted to avoid duplication between title and description.

- DT-2: `pickFirstNonEmpty` is a pure function defined at module scope (not inline arrow inside `formatForDiscord`). Signature: `function pickFirstNonEmpty(...candidates: string[]): string | undefined`. Keeps the function testable in isolation if needed.

- DT-3: T-AL-DISC-06 hardening strategy — use a URL string that `new URL()` accepts as syntactically valid BUT whose `hostname` is not `discord.com`/`discordapp.com`, and simultaneously whose scheme causes Node's `fetch` to reject it (e.g. `javascript:void(0)` or a custom scheme). This eliminates the race between URL parsing and fetch resolution without requiring a global URL constructor mock, keeping the test hermetic.

  Alternative accepted: structurally-invalid string like `'not-a-valid-url'` already used — but the test must mock `fetch` to ALWAYS capture and return success so `captured` is always defined after the call. Either approach satisfies AC-4; the implementation chooses the simpler one.

- DT-4: `@internal` annotation on `formatForDiscord` is a JSDoc-only change. No runtime export is removed in this HU. Removing the export is deferred to a future cleanup if a tree-shaking or API surface audit HU is opened.

## Constraint Directives (CD-N)

Heredados de WKH-90 (todos vigentes):

- CD-9: PROHIBIDO loggear `webhookUrl` o cualquier token/secret en ningún log statement
- CD-12: PROHIBIDO que `sendAlert` lance una excepción bajo cualquier condición (incluye branch Discord y truncation path)
- CD-18: OBLIGATORIO mantener `redirect: 'error'` en el fetch call de `sendAlert`
- CD-WKH90-1: PROHIBIDO agregar nuevas claves a `ALLOWED_BODY_KEYS` en esta HU
- CD-WKH90-2: OBLIGATORIO que cualquier fallo de `new URL(webhookUrl)` caiga al raw-JSON path silenciosamente (sin throw, sin log de la URL)
- CD-WKH90-3: PROHIBIDO hacer `DISCORD_USERNAME` configurable via env var
- CD-WKH90-4: OBLIGATORIO mockear `globalThis.fetch` en todos los tests Discord; prohibido hacer requests reales

Nuevos para WKH-91:

- CD-WKH91-1: Truncation MUST place ellipsis at the very end using `slice(0, max - 1) + '…'`; PROHIBIDO truncar en el medio o usar replace/regex
- CD-WKH91-2: La detección de hostname MUST usar `parsed.hostname` (case-insensitive compare implícito — `URL` ya normaliza a lowercase); PROHIBIDO usar `parsed.host`
- CD-WKH91-3: T-AL-DISC-06 MUST have NO conditional assertions — `if (captured)` guard is PROHIBITED; assertions run unconditionally

## Missing Inputs

- Ninguno bloqueante. El scope está 100 % definido por los 7 MNRs + 2 observaciones de F4 del ciclo WKH-90.

## Analisis de paralelismo

- No bloquea ninguna HU activa.
- No es bloqueada por ninguna HU activa.
- Puede ejecutarse en paralelo con cualquier HU que no toque `mcp-servers/wasiai-x402/src/alerts.mjs` o su test suite.
- Branch base: main HEAD post-WKH-88 commit `1cef60f`.
