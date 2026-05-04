# Work Item — [WKH-87] Public Docs Refinements (Node version + chain.ts inline + decimal drift)

## Resumen

Carry-forward de 8 MNRs (3 del Re-AR iter 2 + 5 del CR) del WKH-82 sprint (Public Docs & Onboarding, DONE 2026-05-02). Correcciones exclusivamente en `docs/` — cero cambios a `src/`. El scope cubre: corregir el requisito de versión Node en getting-started.md (18+ → 20+), agregar la definición inline copy-pasteable de `chain.ts` en networks.md, añadir equivalentes curl/bash al Step 4, documentar la sección "Versioning & Stability", el error response shape con ejemplo JSON-RPC, y samples TS individuales para los 4 tools del MCP self-hosted. El bug de decimal drift en `src/` queda **explícitamente fuera de scope** y se trackea como HU separada.

## Sizing

- SDD_MODE: mini
- Estimación: S
- Branch sugerido: docs/083-wkh-87-public-docs-refinements

## Skills Router

- `docs-writer` — correcciones técnicas a documentación pública
- `api-reviewer` — verificación de line-range citations y error shapes

## Acceptance Criteria (EARS)

- AC-1: WHEN a developer reads `docs/getting-started.md` Prerequisites, the system SHALL require Node.js **20+** (not 18+), and SHALL include a note that `crypto.getRandomValues` as a global requires Node 19+ (aligned with `package.json` `engines: ">=20.0.0"`).

- AC-2: WHEN a developer reads `docs/networks.md`, the system SHALL include an inline, copy-pasteable TypeScript block containing both `kiteTestnet` and `kiteMainnet` `defineChain` definitions (mirroring `src/adapters/kite-ozone/chain.ts`), so that the `import { kiteTestnet } from './chain'` reference in getting-started samples resolves without requiring access to `src/`.

- AC-3: WHEN a developer reads `docs/getting-started.md` Step 4 (Sign EIP-712), the system SHALL include a `bash`/`curl` + `openssl` (or `node -e`) equivalent alongside the existing TypeScript+viem snippets for constructing and encoding the `payment-signature` header, so that non-TypeScript integrators can follow the step without a build toolchain.

- AC-4: WHEN a developer reads `docs/api-reference.md`, the system SHALL include a "Versioning & Stability" section documenting the v1 contract policy: what constitutes a breaking change, the deprecation notice period, and how clients should detect version in the `GET /health` response.

- AC-5: WHEN a developer reads `docs/api-reference.md`, the system SHALL include a concrete JSON-RPC 2.0 error response shape example showing both the standard error envelope (`{ "jsonrpc": "2.0", "id": N, "error": { "code": ..., "message": ..., "data": ... } }`) and the gateway's REST error envelope (`{ "error": "...", "statusCode": N }`), with at least one concrete example per shape.

- AC-6: WHEN a developer reads `docs/mcp-integration.md` Surface A (self-hosted), the system SHALL include an individual TypeScript (`fetch`-based) sample for each of the 4 tools: `pay_x402`, `get_payment_quote`, `discover_agents`, and `orchestrate`, alongside the existing curl samples.

- AC-7: WHEN `docs/api-reference.md` cites a line range inside `src/index.ts` (currently "lines 100–121"), the system SHALL either verify that the citation is still accurate against current HEAD or replace it with a stable function-name reference (e.g. "route registrations starting at `fastify.register(registriesRoutes...)`") that does not drift with line number changes.

## Scope IN

- `docs/getting-started.md` — Prerequisites Node version, Step 4 curl/bash equivalent, decimal drift known-quirk note (already partially present; verify completeness)
- `docs/networks.md` — Inline `chain.ts` TypeScript block (copy-pasteable `kiteTestnet` + `kiteMainnet` definitions)
- `docs/api-reference.md` — "Versioning & Stability" section, error response shape example, line-range citation re-verification (line 378)
- `docs/mcp-integration.md` — Individual TS `fetch`-based samples for all 4 self-hosted tools

## Scope OUT

- `src/` — zero code changes (decimal drift bug in `payment.ts:216,334` and middleware default `1e18` is a separate HU)
- `docs/getting-started.md` line 23 note about 18-decimal `maxAmountRequired` placeholder — already present as WARNING block (lines ~198–221); no change needed beyond verifying the Node version line
- `mcp-servers/` — no changes to the Vercel MCP server code
- `test/` — no test changes
- Surface B (hosted Vercel MCP) TS samples — out of scope; curl samples already exist and the hosted surface is an external deployment
- Any new endpoints or API changes

## Decisiones técnicas (DT-N)

- DT-1: The `chain.ts` inline block in `docs/networks.md` SHALL reproduce the exact exported identifiers (`kiteTestnet`, `kiteMainnet`, `getKiteChain`, `getKiteNetwork`) matching `src/adapters/kite-ozone/chain.ts` at current HEAD (commit `e448993`). Rationale: getting-started samples already use `import { kiteTestnet } from './chain'`; developers copy-pasting samples need a self-contained definition without needing to clone the repo.

- DT-2: For AC-3 (Step 4 curl/bash equivalent), the sample SHALL use `node -e` one-liner with the built-in `crypto` module to generate the nonce and construct the base64 payload, rather than a shell-only approach. Rationale: `openssl rand` produces binary not hex; a minimal `node -e` snippet is portable, does not require additional tooling, and aligns with the Node 20+ requirement already established by AC-1.

- DT-3: For AC-7 (line-range citation), re-verify `src/index.ts` route registrations against HEAD before deciding. Current HEAD lines 100–121 match the route block exactly — if verified accurate, replace with a stable anchor comment reference (`// Routes` block at `src/index.ts`) rather than hardcoded line numbers. Rationale: line numbers drift with every commit; function names and block comments are stable.

## Constraint Directives (CD-N)

- CD-WKH87-1: All TypeScript samples in `docs/` MUST compile against current `src/` types and imports (no type drift). Any type or import that cannot be verified against `src/` MUST be marked `// NOTE: verify against your local src/` inline.
- CD-WKH87-2: All bash/curl samples MUST be runnable as-is. Every secret or user-supplied value MUST use an explicit placeholder in the form `<YOUR_VARIABLE_NAME>` — no silent assumptions.
- CD-WKH87-3: NEVER reference `decimals: 18` or `1000000000000000000` (1e18 string) as a correct payment value in any new sample. If the placeholder appears as a known quirk, it MUST be accompanied by the existing WARNING block or an explicit inline comment explaining it is a legacy default, NOT the token's real decimal count.
- CD-WKH87-4: The `chain.ts` inline block (AC-2) MUST be kept in sync with `src/adapters/kite-ozone/chain.ts`. If the source file is updated in a future HU, `docs/networks.md` MUST be updated in the same PR.

## Missing Inputs

- [resuelto en F2] Exact wording for "Versioning & Stability" policy (v1 contract terms) — Architect to define based on existing `GET /health` response and known API freeze post-hackathon.
- [resuelto en F2] Step 4 curl/bash sample exact shape — Architect to confirm `node -e` approach fits within DT-2 scope.

## Análisis de paralelismo

- Esta HU no bloquea ninguna HU de código activa — es doc-only.
- Puede correr en paralelo con cualquier HU de `src/` sin conflicto de merge.
- Branch `docs/083-wkh-87-public-docs-refinements` desde `main` HEAD post-WKH-86 (commit `e448993`).
