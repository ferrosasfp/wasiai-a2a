# Validation Report — WKH-126b · Integración TS del Escrow No-Custodial (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-06-22
**Branch**: `feat/117-wkh-126-escrow-noncustodial` (working tree sin commit)
**QA**: nexus-qa (F4)

---

## Runtime checks

### tsc --noEmit
`npx tsc --noEmit` → exit 0, 0 errores. Confirmado independientemente (no re-ejecucion del CR; el CR ya lo habia validado pero se corrio para cierre del pipeline).

### Suite vitest
`npx vitest run` → **1615 passed, 0 failed** (3 pending/todo preexistentes).
Escrow-specific: `escrow-verifier.test.ts` + `escrow/eip712.test.ts` + `auth.escrow.test.ts` → **34 passed, 0 failed**.
Total tests en suite: 1618 (1615 pass + 3 pending). Coincide exactamente con lo reportado por CR.

### Regresion AC-8 (critico)
`auth.escrow.test.ts:194` — `'ESCROW_MODE_ENABLED unset → uses verifyDeposit (treasury), escrow NOT called (AC-8)'`: assert `mockVerifyEscrowDeposit.not.toHaveBeenCalled()` + `res.statusCode === 200`. El path treasury queda identico: `auth.ts:666-679` usa ternario donde el branch `verifyDeposit` preserva el handler sin bifurcar pasos 5b/6/7.

### Env parity
`.env.example:295-300` documenta las 6 vars nuevas:
- `ESCROW_MODE_ENABLED`
- `A2A_ESCROW_CONTRACT_KITE`
- `A2A_ESCROW_CONTRACT_AVALANCHE`
- `A2A_ESCROW_CONTRACT_BASE`
- `ESCROW_EIP712_NAME`
- `ESCROW_EIP712_VERSION`

Grep de hardcodes en produccion (`src/adapters/escrow-verifier.ts`, `src/adapters/escrow/abi.ts`, `src/adapters/escrow/eip712.ts`, `src/routes/auth.ts`): 0 matches para `0x[0-9a-fA-F]{39,}`. Direcciones desde `process.env[A2A_ESCROW_CONTRACT_${family}]` (`escrow-verifier.ts:98`). CD-3 cumplido.

### Migracion DB (DT-9)
No se agrega ninguna migracion. El directorio `supabase/migrations/` no tiene archivo nuevo para esta HU (ultimo: `20260607000000_wkh_sec02_rls.sql`). Correcto segun DT-9: NO se agrega `escrow_balance`.

**Gap conocido confirmado (MNR-1 del AR)**: `supabase/migrations/20260605000000_a2a_receipts.sql:12` — `CHECK (receipt_type IN ('protocol_fee','budget_debit'))` — no incluye `'deposit_verified'`. El tipo `ReceiptType` en `src/types/receipt.ts:14` si lo declara. Impacto: en DB real, `receiptService.emit({ receiptType: 'deposit_verified' })` falla en el INSERT y degrada a `console.warn` (`receipt.ts:138`). El deposito 200 no se ve afectado (emit es never-throw). Esta TD es operacional acoplada al deploy de WKH-126a. Flag `ESCROW_MODE_ENABLED` esta off en prod → no hay impacto activo.

---

## ACs

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `escrow-verifier.test.ts:148` — "returns ok with amountUsd/from/tokenSymbol — Kite 18 dec"; `escrow-verifier.test.ts:177` — "returns ok — Base 6 dec". Implementacion: `escrow-verifier.ts:127-246` (`verifyEscrowDeposit`). Verify-before-credit: `auth.ts:666-695` (verifier llamado en paso 5, antes del `registerDeposit` en paso 6). |
| AC-2 | PASS | `escrow-verifier.test.ts:204` — "confirmations < min → INSUFFICIENT_CONFIRMATIONS". Implementacion: `escrow-verifier.ts:176-180` (calculo confirmaciones vs `resolveMinConfirmations`). |
| AC-3 | PASS | `auth.escrow.test.ts:251` — "escrow mode + DepositAlreadyCreditedError → 409". Implementacion: mismo `budgetService.registerDeposit` + mismo RPC `register_a2a_key_deposit` con `UNIQUE(chain_id, tx_hash)` intacto (`auth.ts:710-717`). |
| AC-4 | PASS | `eip712.test.ts:43` — "produces a signature whose recovered === signer.address → presentable". Round-trip real con cuenta viem + `recoverTypedDataAddress` independiente. Implementacion: `eip712.ts:103-148` (`buildDebitAuthorization`). Nota: enforcement on-chain es WKH-126a; la integracion TS garantiza que no se construye/presenta autorizacion invalida (CD-7). |
| AC-5 | PASS | `eip712.test.ts:75` — "verifyingContract zero → does NOT sign, presentable:false"; `eip712.test.ts:90` — "verifyingContract malformed → does NOT sign". Implementacion: `eip712.ts:110-120` (guard `ADDRESS_RE + /^0x0+$/` antes de firmar — CD-12). |
| AC-6 | PASS | `auth.escrow.test.ts:275` — "escrow mode + from != callerKey.funding_wallet → 403 FUNDING_WALLET_MISMATCH". Implementacion: `auth.ts:701-706` — `result.from.toLowerCase() !== callerKey.funding_wallet.toLowerCase()` → 403. `result.from` es `Deposited.depositor` on-chain (no de body). |
| AC-7 | PASS | `auth.escrow.test.ts:299` — "registerDeposit gets callerKey.owner_ref as 4th arg" — assert `mockRegisterDeposit.toHaveBeenCalledWith(TEST_KEY_ID, 2368, '10', 'user-1', ...)`. `auth.escrow.test.ts:328` — "OwnershipMismatchError → 403". Implementacion: `auth.ts:710-717` — `budgetService.registerDeposit(callerKey.id, chainId, result.amountUsd, ownerRef, txHash, result.tokenSymbol)` donde `ownerRef = callerKey.owner_ref` (`auth.ts:620`). |
| AC-8 | PASS | `auth.escrow.test.ts:194` — flag unset → `mockVerifyEscrowDeposit.not.toHaveBeenCalled()` + 200. `auth.escrow.test.ts:451` — parametrizado con `'1'/'TRUE'/'True'/'yes'/''` → treasury en cada caso. Implementacion: `auth.ts:125-127` — `=== 'true'` estricto (CD-11). |
| AC-9 | PASS | `auth.escrow.test.ts:219` — flag `'true'` → `mockVerifyEscrowDeposit.toHaveBeenCalledTimes(1)` + body `{ balance: '10.000000', chain_id: 2368 }` (mismo shape). Assert tambien `keyIdHash: EXPECTED_KEY_ID_HASH` (CD-8). Implementacion: ternario `auth.ts:666-679`. |
| AC-10 | PASS | `escrow-verifier.test.ts:233` — "resolveEscrowContract resolves per A2A_ESCROW_CONTRACT_<FAMILY>" para kite/avalanche/base. `escrow-verifier.test.ts:246` — ausente → `null` → `ESCROW_CONTRACT_NOT_CONFIGURED`, sin fallback a `OPERATOR_PRIVATE_KEY`. Implementacion: `escrow-verifier.ts:94-101` (`resolveEscrowContract`). |
| AC-11 | PASS (mock-level) | `auth.escrow.test.ts:352` — "receiptService.emit('deposit_verified', txHash)" con assert `objectContaining({ receiptType: 'deposit_verified', txHash: VALID_TX, agentKeyId, ownerRef, amountUsd, chainId })`. `auth.escrow.test.ts:385` — emit throwing no rompe el 200. Implementacion: `auth.ts:721-732` (fire-and-forget `void receiptService.emit(...)`). **Nota**: AC-11 validado a nivel mock (no e2e contra DB real). En prod el CHECK constraint de `a2a_receipts` rechaza `deposit_verified` (MNR-1 del AR / R-3 del Story File). El deposito 200 sigue intacto. TD acoplada al deploy de 126a (flag off en prod → sin impacto activo). |

**11/11 ACs PASS con evidencia archivo:linea.**

---

## Drift detection

**Scope**: archivos modificados/creados en el working tree:
- Creados: `src/adapters/escrow/abi.ts`, `src/adapters/escrow/eip712.ts`, `src/adapters/escrow-verifier.ts`, `src/adapters/escrow-verifier.test.ts`, `src/adapters/escrow/eip712.test.ts`, `src/routes/auth.escrow.test.ts` — todos en Scope IN (Story File §1).
- Modificados: `src/routes/auth.ts`, `.env.example` — ambos en Scope IN.
- Modificado: `src/types/receipt.ts` — fuera del Scope IN declarado en §1, pero declarado en auto-blindaje y justificado: cambio aditivo sin cast (`ReceiptType + 'deposit_verified'` en `receipt.ts:14`), con JSDoc VERIFY-AT-IMPL (`receipt.ts:9-13`). AR y CR lo inspeccionaron y confirmaron que no es drift oculto.
- Otros modificados (`BACKLOG.md`, `HACKATHON-FINAL.md`, `doc/sdd/_INDEX.md`): documentacion del pipeline, no son cambios funcionales.

**`deposit-verifier.ts`**: modificacion aditiva — exportar `resolveRpcUrl`/`resolveChainObject` (opcion (a) del Story File §4.1.1). No es cambio de logica.

**Wave drift**: ningun indicio de que los waves no se siguieron (tipos W0 presentes en los archivos base, cuerpo W1/W2/W3 completo, tests W4 cubren todo).

**Spec drift**: spot-check — `escrowModeEnabled()` en `auth.ts:125-127` coincide con la especificacion exacta del Story File §4.2.2. Ternario en `auth.ts:666-679` coincide con §4.2.3. `buildDebitAuthorization` en `eip712.ts:103-148` coincide con §4.3.1.

**Drift**: ninguno fuera del auto-blindaje declarado y aprobado por AR/CR.

---

## Gates (confirmados del CR report + corrida independiente)

| Gate | CR report | QA independiente | Estado |
|------|-----------|-----------------|--------|
| `tsc --noEmit` | 0 errores | exit 0, 0 errores | PASS |
| Lint (biome) | 0 errores (1 info preexistente en reputation.ts) | no re-ejecutado (confirmado CR) | PASS |
| Suite vitest | 1615 + 34 | 1615 passed total, 34 escrow, 0 failed | PASS |

---

## AR/CR follow-up

- **AR MNR-1** (`receipt_type` CHECK constraint): documentado como TD operacional acoplada al deploy de WKH-126a. No bloqueante. Estado: aceptado como TD.
- **AR MNR-2** (comentario treasury en `auth.ts:697-700`): cosmetico, no corregido. Aceptable.
- **CR MNR-1** (comentario JSDoc engañoso `eip712.ts:20-21` — describe bytes32 pero la constante es regex de address): no corregido. Impacto nulo en runtime. Aceptable como TD menor.
- **CR MNR-2** (`escrowBalance` sin consumidor): scope intencional DT-9. Documentado. Aceptable.

Todos los MNRs aceptados como TD. 0 BLQ pendientes.

---

**11/11 ACs PASS con evidencia archivo:linea. Gates verdes. 0 hallazgos runtime bloqueantes. Listo para DONE.**
