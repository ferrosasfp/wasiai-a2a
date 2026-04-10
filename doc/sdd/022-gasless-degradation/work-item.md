# Work Item -- [WKH-38] Gasless graceful degradation

## Resumen

Make the gasless module handle "not yet configured" and "operator wallet unfunded" states gracefully. `/gasless/status` ALWAYS returns 200 with structured state (`unconfigured` / `unfunded` / `ready`). `/gasless/transfer` returns 503 when not fully operational. This decouples demo readiness from the Kite testnet PYUSD faucet timeline.

## Sizing

- SDD_MODE: mini
- Estimation: S
- Branch: feat/022-gasless-degradation
- Flow: FAST+AR

## Riesgo (FAST+AR categories)

| Category | Applies | Justification |
|----------|---------|---------------|
| external-api | YES | Wraps Kite gasless relayer (gasless.gokite.ai); degradation behavior changes when relayer/wallet unavailable |
| external-input | YES | OPERATOR_PRIVATE_KEY is external input -- absent, malformed, or valid-but-unfunded are all states that must degrade gracefully |
| server-actions-writes | NO | -- |
| auth-rbac | NO | -- |
| streaming-refactor | NO | -- |
| admin-panel | NO | -- |
| rls-policies | NO | -- |

Verdict: 2 risk categories apply. FAST+AR confirmed.

## Acceptance Criteria (EARS)

- AC-1: WHEN GASLESS_ENABLED=true AND OPERATOR_PRIVATE_KEY is absent, the system SHALL register `/gasless/*` routes AND `GET /gasless/status` SHALL return 200 with `funding_state: "unconfigured"`.
- AC-2: WHEN GASLESS_ENABLED=true AND OPERATOR_PRIVATE_KEY is present but malformed (not valid hex private key), `GET /gasless/status` SHALL return 200 with `funding_state: "unconfigured"` and `operatorAddress: null`.
- AC-3: WHEN GASLESS_ENABLED=true AND OPERATOR_PRIVATE_KEY is valid but wallet PYUSD balance is 0, `GET /gasless/status` SHALL return 200 with `funding_state: "unfunded"`.
- AC-4: WHEN GASLESS_ENABLED=true AND OPERATOR_PRIVATE_KEY is valid AND wallet has PYUSD balance > 0, `GET /gasless/status` SHALL return 200 with `funding_state: "ready"`.
- AC-5: WHILE `funding_state` is NOT `"ready"`, `POST /gasless/transfer` SHALL return 503 with `{ error: "gasless_not_operational", message, documentation }`.
- AC-6: WHEN GASLESS_ENABLED is falsy or absent, the system SHALL still register `/gasless/*` routes AND `GET /gasless/status` SHALL return 200 with `funding_state: "disabled"`.
- AC-7: the system SHALL NEVER throw at module import time regardless of env var state (no top-level crash).
- AC-8: the system SHALL NEVER expose OPERATOR_PRIVATE_KEY in any response body or log message.
- AC-9: WHEN all changes are applied, the existing 112+ tests SHALL still pass with zero regressions.

## Scope IN

| # | File | Change |
|---|------|--------|
| 1 | `src/lib/gasless-signer.ts` | Extend `getGaslessStatus()` to return `funding_state` enum; add PYUSD balance check via viem; handle malformed PK without throw |
| 2 | `src/routes/gasless.ts` | Add `POST /gasless/transfer` route with 503 guard; enrich `/status` response body with `funding_state`, `chain_id`, `relayer`, `documentation` fields |
| 3 | `src/index.ts` | Remove conditional registration gate -- always register `/gasless/*` routes (status must be available even when disabled) |
| 4 | `src/types/index.ts` | Extend `GaslessStatus` interface with `funding_state: 'disabled' \| 'unconfigured' \| 'unfunded' \| 'ready'` and optional enrichment fields |
| 5 | `src/lib/gasless-signer.test.ts` | Add tests for: PK absent, PK malformed, PK valid + balance 0 (mock), PK valid + balance > 0 (mock), transfer 503 guard |

## Scope OUT

- Mainnet support (testnet only)
- Actual faucet integration or auto-funding
- Changes to x402 middleware or x402-signer
- UI/dashboard changes for gasless status
- Rate limiting on gasless endpoints

## Decisiones tecnicas (DT-N)

- DT-1: Always register gasless routes (remove `if (GASLESS_ENABLED)` gate in index.ts). Rationale: `/gasless/status` must be discoverable even when module is disabled, mirroring Stripe/Sentry pattern described in HU.
- DT-2: Balance check uses `publicClient.readContract()` with ERC-20 `balanceOf(operator)` on the PYUSD token address. Mock in tests. Rationale: only way to determine "unfunded" vs "ready" without external API call.
- DT-3: `funding_state` is a new field on `GaslessStatus` (additive, not breaking). Existing `enabled` field remains for backward compat.

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO exponer OPERATOR_PRIVATE_KEY en logs o responses (heredado de WKH-29).
- CD-2: PROHIBIDO usar ethers.js -- viem only.
- CD-3: OBLIGATORIO que `getGaslessStatus()` NEVER throws -- all errors degrade to a safe state.
- CD-4: PROHIBIDO hardcodear contract addresses -- use existing `FALLBACK_TOKEN.address` or dynamic discovery.
- CD-5: OBLIGATORIO que `/gasless/transfer` POST route reuse existing `signTransferWithAuthorization` + `submitGaslessTransfer` pipeline (no duplication).

## Missing Inputs

- None (all information provided in HU).

## Analisis de paralelismo

- This HU does NOT block other HUs.
- This HU depends on WKH-29 (already DONE, commit e32f7ce).
- Can run in parallel with any non-gasless work.
