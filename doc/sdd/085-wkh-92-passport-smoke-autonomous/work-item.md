# Work Item — [WKH-92] Autonomous Passport x402 Smoke Runner

## Resumen

Script Node.js reutilizable (`scripts/smoke-passport-autonomous.mjs`) que ejecuta
el flujo completo Passport→x402 contra un servicio configurable sin intervención
humana post-bootstrap. Requiere una sesión Passport activa (creada una vez por
humano); si no existe, sale con código 1 y JSON estructurado indicando el gate.
Incluye suite de tests con subprocess stub (no HTTP real) y runbook operativo.

Motivado por el smoke E2E manual capturado en PR #78 contra Parallel ($0.01 USDC,
HTTP 200 confirmado). La HU convierte ese paso manual en artefacto CI-reusable y
prueba de cero-deuda documentada para el hackathon.

## Sizing

- SDD_MODE: mini
- Estimación: S (3 archivos nuevos, 0 cambios en `src/`)
- Branch sugerido: feat/085-wkh-92-passport-smoke-autonomous
- Skills: [cli-scripting, api-testing]

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `scripts/smoke-passport-autonomous.mjs` is installed, the system
  SHALL be executable via `node scripts/smoke-passport-autonomous.mjs` without
  compilation and SHALL exit with code 0 when the full smoke flow succeeds.

- **AC-2**: WHEN the script runs and `kpass agent:session status` returns no active
  session, the system SHALL exit with code 1 and print to stdout a JSON object with
  shape `{ "status": "human_gate_required", "reason": string, "next_step": string }`
  with no additional output on stdout.

- **AC-3**: WHEN an active Passport session exists, the system SHALL execute the
  following steps in sequence and report each as a structured event on stdout:
  (1) capture pre-execution balance via `kpass` CLI,
  (2) execute `kpass agent:session execute` against `SMOKE_TARGET_URL` with
  `SMOKE_TARGET_BODY`,
  (3) capture post-execution balance via `kpass` CLI,
  (4) verify that balance delta matches `EXPECTED_COST_USDC` within the configured
  tolerance, and exit with code 0 if all steps pass.

- **AC-4**: WHILE the script is configuring its run parameters, the system SHALL
  read the following environment variables and apply their values:
  `SMOKE_TARGET_URL` (default: Parallel `https://parallelmpp.dev/api/search`),
  `SMOKE_TARGET_BODY` (default: `{"objective":"latest news on crypto"}`),
  `EXPECTED_COST_USDC` (default: `"0.01"`),
  `MIN_BALANCE_USDC` (default: `"0.05"`).
  IF `MIN_BALANCE_USDC` is set and the pre-execution balance is below it, THEN the
  system SHALL exit with code 1 and JSON `{ "status": "insufficient_balance", ... }`.

- **AC-5**: WHILE the script is running, the system SHALL write all structured
  results (step outcomes, balance snapshots, final verdict) as JSON objects to
  stdout only, SHALL write human-readable progress messages to stderr only, and
  SHALL NEVER log the values of JWT tokens, agent_token, session_id plaintext, or
  any credential — only hashed identifiers (first 8 chars of SHA-256) are permitted.

- **AC-6**: WHEN `test/smoke-passport-autonomous.test.mjs` is executed via
  `npm test --run`, the system SHALL pass a minimum of 6 test cases covering:
  no-session exit-1 path (AC-2), insufficient-balance exit-1 path (AC-4),
  successful flow exit-0 path (AC-3), balance-diff within tolerance (AC-3 step 4),
  balance-diff outside tolerance exits with code 2 (AC-3/DT-3), and subprocess
  stub invocation count verification — all using `kpass` CLI subprocess stubs
  without real HTTP calls.

- **AC-7**: WHEN `npm test --run` is executed against the full test suite, the
  system SHALL pass a minimum of 810 tests (current baseline), with zero
  regressions introduced by this HU.

- **AC-8**: WHEN `doc/runbooks/passport-smoke-autonomous.md` is present, the
  runbook SHALL document: prerequisites (kpass CLI installed, session bootstrap
  steps), all configurable env vars with default values, all exit codes with
  their meanings, example invocation commands, and a CI integration example.

## Scope IN

- `scripts/smoke-passport-autonomous.mjs` — new script (~150 LOC)
- `test/smoke-passport-autonomous.test.mjs` — new test file (~120 LOC)
- `doc/runbooks/passport-smoke-autonomous.md` — new runbook (~80 lines)

## Scope OUT

- Any changes to `src/` (zero production code impact)
- Modifications to `kpass` CLI or Kite infrastructure
- Registration of wasiai-a2a in ksearch allowlist (separate Kite-team action,
  tracked in smoke-test-findings.md §3)
- Tempo protocol support (out of scope per smoke-test-findings.md §4 recommendation)
- CI/CD pipeline wiring (follow-up if needed)
- Any changes to existing test files or fixtures
- Any changes to `.env.example` or `package.json` scripts block

## Decisiones Tecnicas (DT-N)

- **DT-1**: Default target is Parallel (`https://parallelmpp.dev/api/search`,
  `POST`, `$0.01 USDC`). Evidence: PR #78 `parallel-200-evidence.json` confirms
  real HTTP 200 + $0.01 spend + x402 payment shape. This is the only ksearch
  service with live wire evidence in this repo.

- **DT-2**: Mock pattern is subprocess stub — `kpass` CLI is called via
  `child_process.execFile` (or equivalent); tests stub that module boundary
  at the subprocess level, not via HTTP. This keeps tests hermetic and avoids
  Kite network dependency in CI.

- **DT-3**: Balance diff tolerance is 1% of `EXPECTED_COST_USDC`. Rationale:
  accommodate minor rounding in USDC decimal representation (6 decimals) without
  masking real drift. If delta is within tolerance → PASS; outside → exit code 2.

- **DT-4**: Exit codes are strictly:
  `0` = full smoke PASS,
  `1` = human gate required (no session OR insufficient balance),
  `2` = smoke assertion failure (wrong balance diff, unexpected HTTP status),
  `3` = runtime error (kpass CLI not found, subprocess timeout, JSON parse error).

## Constraint Directives (CD-N)

- **CD-WKH69-5**: NEVER hardcode tokens, JWTs, or session credentials in script
  or test source. All sensitive values come from environment or kpass CLI output
  at runtime.

- **CD-WKH75-15**: NEVER log JWT values, agent_token values, or session_id
  plaintext on stdout or stderr. Only hashed identifiers (truncated SHA-256,
  first 8 hex chars) are permitted in log output.

- **CD-WKH92-1**: Use the `kpass` CLI binary for all Passport operations. NEVER
  reimplement Passport session management, x402 signing, or balance queries in
  script code — delegate to `kpass` subprocess exclusively.

- **CD-WKH92-2**: NEVER log the literal value of any field named `jwt`,
  `agent_token`, `session_id`, `authorization`, or `x-passport-session` in any
  output channel. If a session_id must appear in structured output for
  traceability, emit only `session_id_hash: sha256(value).slice(0,8)`.

- **CD-WKH92-3**: Script invocations SHALL be idempotent — running the script N
  times against the same session SHALL produce N independent smoke results, each
  spending `EXPECTED_COST_USDC`. No shared state is mutated between runs beyond
  the Passport session balance (which is an external side effect of the payment).

- **CD-WKH92-4**: Tests MUST use subprocess stubs (no real HTTP, no real kpass
  binary required). A test environment where `kpass` is not installed SHALL still
  produce a full green suite for this HU's test file.

## Missing Inputs

- [resuelto en DT-1] Target URL and body — confirmed via `parallel-200-evidence.json`
- [resuelto en DT-2] kpass subprocess interface — confirmed via `smoke-test-findings.md`
  §1 execute command shape
- [NEEDS CLARIFICATION — non-blocking] Whether `kpass balance` is the correct
  subcommand for pre/post balance queries, or if it is embedded in
  `kpass agent:session status --output json`. Architect to confirm via
  `kpass --help` output or passport-onboarding.md §3-4 in F2.

## Analisis de paralelismo

- This HU has zero dependencies on in-progress HUs (all `src/` untouched).
- Can run in parallel with any HU targeting `src/`.
- Does NOT block any other HU — it is a standalone tooling addition.
- Branch base: `main` at commit `3dd781d` (per pipeline input).
