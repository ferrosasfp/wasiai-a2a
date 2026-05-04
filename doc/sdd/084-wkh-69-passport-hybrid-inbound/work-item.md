# Work Item — [WKH-69] [KITE-PASSPORT] Model B Hybrid — Passport inbound + operator outbound cross-chain

## Resumen

Implement the Model B Hybrid integration approved in spike WKH-68: Kite Passport as the inbound user-facing authorization mechanism, while keeping `OPERATOR_PRIVATE_KEY` for cross-chain outbound settlement. The orchestrator (`wasiai-a2a`) becomes agnostic to who funded the inbound payment — Passport session wallet or raw EOA. Scope: env config correctness for mainnet USDC, telemetry tagging of `payment_origin`, documentation of the Passport onboarding flow, an opt-in `requirePassport` middleware, and a full mock-based test suite that validates the Passport session signature shape against our existing verifier path. This is the **hackathon Kite proof-of-integration** — not a post-hackathon item.

## Sizing

- SDD_MODE: full
- Estimación: L
- Branch sugerido: `feat/084-wkh-69-passport-hybrid-inbound` desde `main` HEAD post-WKH-87 (commit `ce393e9`)

---

## Acceptance Criteria (EARS)

**AC-1** — WHEN `wasiai-a2a` receives an inbound x402 `payment-signature` header whose EIP-3009 `authorization.from` field is a Kite Passport session wallet (distinct from the user's underlying Passport wallet), the system SHALL route the signature through the existing `getPaymentAdapter().verify()` and `.settle()` path without any code-path divergence from the raw-EOA flow.

**AC-2** — WHEN the facilitator adapter is configured for Kite mainnet (`KITE_NETWORK=mainnet`), the 402 response `accepts[0].asset` SHALL equal the USDC contract address (`X402_PAYMENT_TOKEN` env var, defaulting to `0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e`) — not the PYUSD testnet address.

**AC-3** — WHEN `KITE_NETWORK=mainnet` is active and `X402_EIP712_DOMAIN_NAME` is unset, the system SHALL use `"USDC"` as the EIP-712 domain name for `TransferWithAuthorization` signature construction and verification.

**AC-4** — WHEN a payment completes successfully and the `payment-signature` header authorization carries a `from` address that matches a known Passport session wallet pattern (base58 public key derivation), the system SHALL persist `payment_origin: "passport"` in the `metadata` JSONB of the corresponding `a2a_events` row. WHEN the `from` address is a standard 20-byte EOA with no Passport session pattern, the system SHALL persist `payment_origin: "eoa"`.

**AC-5** — the system SHALL provide `doc/passport-onboarding.md` documenting the user-facing flow: install `kpass` CLI, `kpass signup init`, `kpass agent:register`, `kpass agent:session create`, approve via `approval_url`, execute via `kpass agent:session execute --url <wasiai-a2a endpoint>`.

**AC-6** — WHEN `npm test` is run, the test suite SHALL include at least one test that constructs a mock `payment-signature` header whose `authorization.from` is a Passport-derived session address (constructed from the `public_key` field documented in `poc-results.md`: base58-encoded 32-byte ed25519-style key → EVM address derivation) and asserts that `decodeXPayment` parses the header correctly and the mocked adapter accepts it.

**AC-7** — WHEN `npm test` is run, the system SHALL pass all pre-existing tests (baseline ≥ 794 tests as of post-WKH-87 `ce393e9`) with zero regressions.

**AC-8** — WHILE `KITE_NETWORK=testnet` (default), the system SHALL continue accepting PYUSD-signed EIP-3009 payloads on chain 2368 unchanged — no modification to the testnet code path.

**AC-9** — the system SHALL NOT modify the outbound cross-chain settlement path: `OPERATOR_PRIVATE_KEY` SHALL remain the sole signer for downstream x402 payments to Avalanche agents, regardless of whether the inbound payment was Passport-funded or EOA-funded.

**AC-10** — WHERE `PASSPORT_REQUIRE_INBOUND=true` env flag is set, the system SHALL reject inbound x402 requests whose `authorization.from` cannot be identified as a Passport session address with HTTP 403 and a JSON body `{"error": "Passport session required", "error_code": "PASSPORT_REQUIRED"}`. WHERE `PASSPORT_REQUIRE_INBOUND` is unset or any other value, the system SHALL allow both Passport and EOA payments (opt-in only, no default enforcement).

---

## Scope IN

| File / Module | Change |
|---------------|--------|
| `src/adapters/kite-ozone/payment.ts` | Read `KITE_NETWORK` mainnet defaults — already done; verify USDC domain name `"USDC"` is correct. May need `payment_origin` detection helper (see DT-4). |
| `src/middleware/event-tracking.ts` | Pass `payment_origin` into `eventService.track()` `metadata` when `request.paymentTxHash` is set. |
| `src/middleware/passport.ts` (new) | `requirePassport` opt-in preHandler — guards AC-10. |
| `src/middleware/x402.ts` | Surface Passport session address detection for `payment_origin` (DT-4). |
| `src/services/event.ts` | Accept `payment_origin` in `metadata` input; no schema change (JSONB). |
| `test/passport-*.test.ts` (new) | Mock tests for AC-6 (Passport shape validation). |
| `doc/passport-onboarding.md` (new) | AC-5 onboarding guide. |
| `.env.example` | Add `PASSPORT_REQUIRE_INBOUND=` placeholder with comment. |

---

## Scope OUT

- No Node/TypeScript SDK wrapping of `kpass` CLI subprocess — stay agnostic to *how* the payment was funded
- No modification to `src/adapters/kite-ozone/chain.ts` — chain definitions are already correct
- No production Railway env var changes until W1 confirms signature shape against a real Passport-funded tx (CD-WKH69-1)
- No DB migration — `a2a_events.metadata` is JSONB; `payment_origin` goes there, not a new column
- No MCP or `/orchestrate` route changes — payment path is transparent
- No cross-chain outbound changes (AC-9)
- No real E2E funding smoke test in this HU — that is a post-merge gate for the human (see Missing Inputs)
- No modification to `OPERATOR_PRIVATE_KEY` usage in `src/services/downstream-payment.ts` or similar

---

## Decisiones técnicas (DT-N)

**DT-1: payment_origin detection strategy — heuristic on `authorization.from` address**
Passport session wallets are derived from a base58-encoded 32-byte ed25519 keypair (field `public_key` in session response). The resulting EVM address is a standard 20-byte hex. Distinguishing a "Passport session address" from a plain EOA programmatically requires either:
  (a) a Kite Passport API lookup, or
  (b) a heuristic (e.g., compare `from` against a known session registry, or pattern-match on how Passport derives addresses).
In the absence of a Node SDK, **option (a) is blocked**. Option (b) is unreliable as a sole mechanism. **Decision**: `payment_origin` defaults to `"eoa"` and can be overridden by the client setting a `x-passport-session: true` request header alongside `payment-signature`. The middleware trusts this header only as a telemetry hint (not for access control). Access control (AC-10) uses the `PASSPORT_REQUIRE_INBOUND` env flag with a list of known Passport wallet addresses `[NEEDS CLARIFICATION — see Missing Inputs]` or alternatively validates the EIP-712 domain name matches `"USDC"` (mainnet-only pattern). This design is conservative and avoids inventing detection logic not confirmed by the spike.

**DT-2: EIP-712 domain name for Kite mainnet — `"USDC"` confirmed**
`poc-results.md` + `decision-doc.md` confirm that Kite Passport sessions use USDC on chain 2366. The `payment.ts` adapter already defaults `DEFAULT_EIP712_DOMAIN_NAME_MAINNET = 'USDC'` (line 93 of `payment.ts`). No code change required for AC-3 if `KITE_NETWORK=mainnet` is set. The env var `X402_EIP712_DOMAIN_NAME` can override. This is already implemented — AC-3 is a verification AC, not new code.

**DT-3: `requirePassport` middleware — opt-in via env flag, NOT default**
`PASSPORT_REQUIRE_INBOUND=true` mounts the guard. Without it, the middleware is a no-op array `[]` (same pattern as `requireForwardKey()` and WKH-75 bearer rotation). This preserves 100% backward compat for EOA-funded flows. The flag is per-deployment, not per-route, for simplicity (single hackathon integration, no per-route granularity needed now).

**DT-4: `payment_origin` field placement — `metadata` JSONB, not a new column**
`a2a_events` has a `metadata: Record<string, unknown>` column. Adding `payment_origin: "passport" | "eoa"` to `metadata` requires zero DB migration and zero change to `EventRow` type. This is consistent with how `endpoint`, `method`, `statusCode` are already stored in `metadata`. The dashboard can query `metadata->>'payment_origin'` in a future HU if adoption metrics are needed.

**DT-5: Mock Passport signature strategy for tests**
Passport session `public_key` is base58-encoded and ed25519-style (~32 bytes). To derive an EVM address, the spike shows it likely maps to a secp256k1 curve address for EVM compatibility (EIP-3009 requires an EVM address as `from`). Tests SHALL construct a deterministic mock: use a known 32-byte hex private key, derive its EVM address via `privateKeyToAccount`, and document the assumption that "Passport session = EVM address of a temporary keypair" in a comment block. The test validates that our `decodeXPayment` + verify path accepts this shape — structural correctness, not cryptographic proof of Passport's internals.

**DT-6: No subprocess wrapping of `kpass` CLI**
`poc-results.md` identifies CLI-only SDK as a friction point. Wrapping `kpass` as a Node subprocess (fragile, PATH-dependent, breaks in Railway) is explicitly rejected. `wasiai-a2a` stays agnostic: it receives x402 payments over HTTP. The caller handles Passport negotiation externally.

**DT-7: Smoke test E2E funding — deferred human gate**
Real E2E requires funding the Passport wallet (prod `0x7aB8760225Ffd90F23bd0B5BfC5B04965976AdB3`) with USDC on chain 2366. This cannot be automated overnight. `doc/passport-onboarding.md` SHALL include a "Smoke Test" section documenting the manual verification steps for the human to execute post-merge.

---

## Constraint Directives (CD-N)

**CD-WKH53** (inherited): OBLIGATORIO — toda query o mutación sobre `a2a_agent_keys` en `src/services/` DEBE incluir `.eq('owner_ref', ownerId)`. Aplica a cualquier código nuevo o modificado en esta HU.

**CD-WKH75** (inherited): OBLIGATORIO — bearer rotation discipline. No modificar `src/cron/` ni `src/lib/kv.ts` fuera del scope de esta HU.

**CD-WKH88** (inherited): OBLIGATORIO — HTTP method gates en cron endpoints. No crear endpoints `GET` donde deba ser `POST`.

**CD-WKH69-1**: PROHIBIDO modificar variables de entorno en el entorno Railway de producción hasta que W1 confirme el shape exacto de la firma Passport contra una transacción real. Toda configuración de env se documenta en `doc/passport-onboarding.md` como "pendiente validación".

**CD-WKH69-2**: PROHIBIDO romper backward-compatibility con flows EOA raw existentes. `KITE_NETWORK=testnet` (default) DEBE seguir produciendo el mismo resultado que antes de esta HU.

**CD-WKH69-3**: PROHIBIDO eliminar o modificar el uso de `OPERATOR_PRIVATE_KEY` en el path de outbound settlement. Sigue siendo el único firmante para pagos downstream a agentes Avalanche.

**CD-WKH69-4**: Las cuentas Passport del spike (prod `user_019de709-...` + staging `user_019de70e-...`) NO se borran. Son baseline de testing. El archivo `.kite-passport/agent.json` permanece gitignored.

**CD-WKH69-5**: PROHIBIDO hardcodear JWT, `agent_token`, `user_id`, `agent_id` o cualquier Passport credential en código o en tests. Todo valor sensible DEBE leerse de env vars o de archivos gitignored.

**CD-WKH69-6**: OBLIGATORIO — todo test que mockee un Passport-shape signature DEBE incluir un comment block `// PASSPORT-MOCK-SHAPE:` documentando: (a) el keypair derivation assumption, (b) qué campo del delegation struct corresponde a cada test field, (c) qué open question del spike resuelve o asume por defecto.

---

## Missing Inputs

| Item | Bloqueante? | Resolución |
|------|-------------|------------|
| Real Passport-funded x402 transaction — exact wire shape of `authorization.from` field (Passport session address vs user wallet address) | No — resolvible con mock en W1; bloqueante solo para E2E smoke | Gate humano post-merge: fondear `0x7aB8760225Ffd90F23bd0B5BfC5B04965976AdB3` con ~$5 USDC mainnet y ejecutar `kpass agent:session execute` contra prod |
| Canonical USDC contract en Kite prod (chain 2366) — confirmar si es idéntico al staging `0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e` | No — default ya está en payment.ts; confirmar antes de cambiar Railway | `[NEEDS CLARIFICATION — verificar con Kite team o explorando kitescan.ai para el contract en 2366]` |
| `payment_origin` detection strategy — si Kite ofrece una API pública para lookup de session addresses | No — DT-1 adopta la estrategia conservadora con `x-passport-session` header hint | `[NEEDS CLARIFICATION — baja prioridad, no bloquea MVP]` |
| Staging faucet bug — si se arregló y permite E2E en testnet | No — staging es opcional para este HU | Seguimiento externo con Kite |

---

## Análisis de paralelismo

Esta HU es el único trabajo activo en el branch `feat/084-wkh-69-passport-hybrid-inbound`. No bloquea otras HUs en curso (todas las WKH 075-083 están en estado DONE). No puede correr en paralelo consigo misma (single dev). Las WKH bloqueadas por esta:

- Dashboard analytics con `payment_origin` breakdown (futura HU no abierta aún) — puede abrirse post-merge de 084.
- Passport webhook/event API integration (open question #6 del spike) — post-hackathon.

---

## Waves de implementación (referencia para Architect)

| Wave | Descripción | Entregable |
|------|-------------|-----------|
| W0 | Preparation — capturar/confirmar shape de session signature (sin fondear). Setup env vars para mainnet en local. | `doc/passport-onboarding.md` draft + env audit |
| W1 | Inbound contract verification — tests con mock Passport-shape signature. Confirmar que `decodeXPayment` + `verify` path acepta el shape. Implementar `payment_origin` detection. | `test/passport-*.test.ts` + `src/middleware/x402.ts` minor update |
| W2 | Documentación + UX — finalizar `doc/passport-onboarding.md` con smoke test section. | `doc/passport-onboarding.md` final |
| W3 | Telemetry — `payment_origin` en `a2a_events.metadata` via `event-tracking.ts`. | `src/middleware/event-tracking.ts` update |
| W4 | Hardening — `src/middleware/passport.ts` requirePassport opt-in. `.env.example` update. | `src/middleware/passport.ts` + `.env.example` |

---

## Referencias

- Spike WKH-68 artefacts: `doc/sdd/spike-kite-passport/` (decision-doc.md · poc-results.md · discovery-notes.md)
- Kite Passport quickstart: https://agentpassport.ai/quickstart/
- Prod Passport account: `user_019de709-4367-7d4f-b21f-f188b7aff8db` / wallet `0x7aB8760225Ffd90F23bd0B5BfC5B04965976AdB3` (chain 2366)
- USDC contract staging: `0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e` (chain 2366 — confirmar en prod)
- Baseline tests: ≥ 794 (post-WKH-87, commit `ce393e9`)
