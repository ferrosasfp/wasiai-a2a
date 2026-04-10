# Work Item — [WKH-DOCS-SYNC] Sync .env.example and README.md with current features

## Resumen

Bring `.env.example` and `README.md` into sync with all features shipped since the last README rewrite (WKH-28). `.env.example` is missing 10+ env vars that the codebase already reads. `README.md` is missing the Bearer auth section (Authorization: Bearer wasi_a2a_xxx as alternative to x-a2a-key header). Both files are developer-facing documentation -- zero code changes.

## Sizing

- SDD_MODE: mini
- Estimacion: S
- Branch sugerido: feat/036-docs-sync
- Flow: FAST (docs only, zero code)

## Acceptance Criteria (EARS)

- AC-1: WHEN a developer reads `.env.example`, the file SHALL contain entries (with comments and defaults) for every env var that the codebase reads via `process.env.*`, including at minimum: RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, TIMEOUT_ORCHESTRATE_MS, TIMEOUT_COMPOSE_MS, BACKPRESSURE_MAX, WASIAI_A2A_CHAIN, CHAIN_EXPLORER_URL, PAYMENT_WALLET_ADDRESS, ANTHROPIC_API_KEY, SHUTDOWN_GRACE_MS, CB_ANTHROPIC_FAILURES, CB_ANTHROPIC_WINDOW_MS, CB_ANTHROPIC_COOLDOWN_MS, CB_REGISTRY_FAILURES, CB_REGISTRY_WINDOW_MS, CB_REGISTRY_COOLDOWN_MS, NODE_ENV, BASE_URL.

- AC-2: WHEN a developer reads the README.md "Payment Flow" section, the system SHALL document `Authorization: Bearer wasi_a2a_xxx` as an alternative auth header accepted alongside `x-a2a-key`, with a curl example.

- AC-3: WHEN a developer reads the README.md env var table, every variable listed in `.env.example` SHALL also appear in the README table with Required/Default/Description columns, and vice-versa (no drift between the two files).

## Scope IN

- `.env.example` -- add missing env var entries with section headers and defaults
- `README.md` -- add Bearer auth documentation to the authentication/payment section

## Scope OUT

- No code changes (src/*)
- No new env vars -- only documenting vars that already exist in code
- No changes to project-context.md
- No test changes

## Decisiones tecnicas (DT-N)

- DT-1: The user listed `CIRCUIT_BREAKER_THRESHOLD` and `CIRCUIT_BREAKER_RESET_MS` but the actual env vars in code are `CB_ANTHROPIC_FAILURES`, `CB_ANTHROPIC_WINDOW_MS`, `CB_ANTHROPIC_COOLDOWN_MS`, `CB_REGISTRY_FAILURES`, `CB_REGISTRY_WINDOW_MS`, `CB_REGISTRY_COOLDOWN_MS`. These are already in the README env table but missing from `.env.example`. Use the real var names.
- DT-2: The user listed `BACKPRESSURE_MAX_ORCHESTRATE` but the actual env var is `BACKPRESSURE_MAX` (no _ORCHESTRATE suffix). Use the real var name.
- DT-3: README already documents GET /health, POST /discover dual, invocationNote proxy pattern, and event tracking dashboard. Only Bearer auth is missing. The other README sections the user mentioned are already present (verified by grep).

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO modificar archivos en src/
- CD-2: PROHIBIDO inventar env vars que no existan en el codigo
- CD-3: OBLIGATORIO mantener el orden de secciones existente en .env.example (Kite Chain, Supabase, etc.) y agregar nuevas secciones al final agrupadas logicamente

## Missing Inputs

- [resuelto] Exact env var names verified against source code -- user's names were approximate, real names confirmed via grep.

## Analisis de paralelismo

- Esta HU no bloquea ninguna otra.
- Puede ejecutarse en paralelo con cualquier HU activa -- es docs-only.
- Depende implicitamente de que WKH-25 (a2a-key), WKH-26 (hardening), WKH-32 (bearer-auth), WKH-34 (event-tracking) ya esten mergeados o al menos sus env vars estabilizados.
