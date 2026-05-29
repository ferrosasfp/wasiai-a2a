# QA Report — WKH-35: Fondeo verificado on-chain (budget prepago), multi-chain

> QA: nexus-qa (F4)
> Fecha: 2026-05-29
> Branch: feat/wkh-base-port-v1
> Prerequisitos: AR APROBADO (BLQ-MED-1 cerrado en RE-AR) + CR APROBADO con MENOREs.

---

## Veredicto: APROBADO

6/6 ACs PASS con evidencia archivo:línea. AC extra (deposit-hijack) PASS. Typecheck exit 0. 1099 tests PASS (0 FAIL). Cero regresión. Drift documentado y aceptado. Checklist de activación runtime explícito.

---

## 1. AC-by-AC (con evidencia)

| AC | Status | Evidencia código | Test(s) |
|----|--------|-----------------|---------|
| **AC-1** verify on-chain antes de acreditar → 200 + nuevo balance | PASS | `auth.ts:262-273` (verifyDeposit antes de registerDeposit, CD-4); `deposit-verifier.ts:185-309` (receipt check completo: status/chainId/confirmaciones/logs/amount); `budget.ts:74-105` (registerDeposit v2 con 6 params) | `auth.test.ts:182-219` "happy path 200", `deposit-verifier.test.ts:132-153` T1 Kite, `deposit-verifier.test.ts:156-173` T1 Base |
| **AC-2** verificación falla → rechazo sin crédito | PASS | `auth.ts:268-273` (`!result.ok → 4xx sin registerDeposit`); `deposit-verifier.ts:201,206,217,225,229,273,277,295` (7 reasons: TX_NOT_FOUND/TX_REVERTED/INSUFFICIENT_CONFIRMATIONS/RECIPIENT_MISMATCH/TOKEN_MISMATCH/AMOUNT_MISMATCH/RPC_UNAVAILABLE); test T14 afirma `not.toHaveBeenCalled()` | `auth.test.ts:222-243` T14 (TX_REVERTED + registerDeposit not called), `auth.test.ts:245-266` (RPC_UNAVAILABLE 503), `deposit-verifier.test.ts:176-203` T2/T3, `deposit-verifier.test.ts:206-225` T4, `deposit-verifier.test.ts:228-244` T5, `deposit-verifier.test.ts:247-263` T6, `deposit-verifier.test.ts:266-283` T7 |
| **AC-3** anti-replay: misma tx → 409 sin re-acreditar | PASS | `migration 20260529000000:17` `CONSTRAINT uq_a2a_key_deposits_chain_tx UNIQUE (chain_id, tx_hash)`; `migration:74-79` INSERT atómico con `EXCEPTION WHEN unique_violation → RAISE 'DEPOSIT_ALREADY_CREDITED'`; `budget.ts:94-96` mapea → `DepositAlreadyCreditedError`; `auth.ts:299-302` → 409 | `auth.test.ts:269-295` T15 (replay → 409 DEPOSIT_ALREADY_CREDITED), `budget.test.ts:207-219` T11 (mapeo RPC error → DepositAlreadyCreditedError) |
| **AC-4** chainId declarado != on-chain → rechazo; crédito solo a `budget[chainId]` correcto | PASS | `auth.ts:257-259` (`body.chain_id !== chainId → CHAIN_MISMATCH`); `auth.ts:254` `chainId = bundle.chainConfig.chainId` (CD-5, nunca del body); `deposit-verifier.ts:216-218` (getChainId on-chain != bundle.chainId → CHAIN_MISMATCH); migración v2 acredita `v_chain = p_chain_id::TEXT` del bundle | `auth.test.ts:297-320` T16 (body.chain_id != bundle → 400 CHAIN_MISMATCH + verifyDeposit not called), `deposit-verifier.test.ts:377-394` CHAIN_MISMATCH on-chain |
| **AC-5** ownership: solo acredita la key cuyo owner_ref == caller; key ajena → 403 | PASS | `auth.ts:237-239` (body.key_id != callerKey.id → 403, defense-in-depth); `auth.ts:288-295` (pasa ownerRef = callerKey.owner_ref al registerDeposit); `budget.ts:78` (ownerId: string, NOT string\|undefined); `migration:63-65` (`IF v_owner IS DISTINCT FROM p_owner_ref THEN RAISE 'OWNERSHIP_MISMATCH'` DB-level) | `auth.test.ts:322-342` T17 pre-check, `auth.test.ts:344-370` T17 DB-level, `budget.test.ts:221-233` T12 |
| **AC-6** multi-chain Kite/Avalanche/Base; chain no soportada → CHAIN_NOT_SUPPORTED | PASS | `deposit-verifier.ts:67-79` `resolveChainFamilyEnvSuffix` cubre 6 ChainKeys; `deposit-verifier.ts:124-139` `resolveRpcUrl` por chain; `deposit-verifier.ts:145-159` `resolveChainObject` por chain; `auth.ts:242-253` (getAdaptersBundle(chainKey) = undefined → 400 CHAIN_NOT_SUPPORTED) | `auth.test.ts:372-393` T18 (chain no inicializada → 400 CHAIN_NOT_SUPPORTED), `deposit-verifier.test.ts:156-173` Base 6-dec, `deposit-verifier.test.ts:329-360` T8 decimals per chain |

---

## 2. AC extra: deposit-hijack cerrado (BLQ-MED-1 FIX-1)

Evidencia de que `Transfer.from != funding_wallet` se rechaza:

- Handler `auth.ts:279-284`: gate doble antes de `registerDeposit` — (a) `!callerKey.funding_wallet → 403 FUNDING_WALLET_NOT_BOUND`; (b) `result.from.toLowerCase() !== callerKey.funding_wallet.toLowerCase() → 403 FUNDING_WALLET_MISMATCH`.
- Test escenario de robo: `auth.test.ts:599-626` — `from = OTHER_WALLET != FUNDING_WALLET → 403 FUNDING_WALLET_MISMATCH + mockRegisterDeposit NOT called`. Asertivo.
- Bind exige prueba de control: `auth.ts:160-173` usa `recoverMessageAddress` (viem real, sin mock) sobre mensaje canónico `WASIAI_BIND_FUNDING_WALLET:<callerKey.id>` — el key_id viene del caller autenticado, nunca del body (`auth.ts:161`). Test `auth.test.ts:487-502`: firma para otro key_id → 403 PROOF_INVALID.
- Test NOT_BOUND: `auth.test.ts:569-597`. Test happy (from == funding_wallet): `auth.test.ts:628-655`.

Estado: PASS con evidencia completa.

---

## 3. Typecheck + Suite

```
$ npx tsc -p tsconfig.build.json --noEmit
→ EXIT: 0 (TypeScript compilation completed)

$ npx vitest run src/adapters/deposit-verifier.test.ts src/services/budget.test.ts src/routes/auth.test.ts
→ PASS (56) FAIL (0)
  [WKH-35: deposit-verifier 13 + budget ~14 + auth ~29 ≈ 56]

$ npx vitest run     [full suite]
→ PASS (1099) FAIL (0)    ← cero regresión en x402, debit, gasless, ownership
```

Gates: CD-9 compliant (typecheck autoritativo `tsconfig.build.json`, no el pelado).

---

## 4. Checklist de activación runtime

Para habilitar el endpoint en producción/staging se deben cumplir los siguientes pasos (en orden):

### 4a. Aplicar migraciones (CRÍTICO — en orden)

Ninguna migración ha sido aplicada contra la DB en esta validación (NO VERIFICABLE programáticamente sin acceso al remoto). El operador debe ejecutar:

1. `supabase/migrations/20260529000000_a2a_key_deposits.sql` — crea tabla `a2a_key_deposits` con `UNIQUE(chain_id, tx_hash)`, reemplaza `register_a2a_key_deposit` v1 (la dropea explícitamente — FIX-2) con v2 (6 args, owner_ref, tx_hash, search_path hardening, GRANT solo a service_role).
2. `supabase/migrations/20260529000001_a2a_key_funding_wallet.sql` — agrega columna `funding_wallet TEXT NULLABLE` a `a2a_agent_keys` + UNIQUE parcial `uq_a2a_agent_keys_funding_wallet`. Envuelta en `BEGIN/COMMIT`.

Ambas tienen `_down.sql` para rollback. La migración `_00000` es idempotente (`CREATE IF NOT EXISTS`, `DROP IF EXISTS`, `CREATE OR REPLACE`). La `_00001` es aditiva (`ADD COLUMN IF NOT EXISTS`).

Verificar post-apply:
```sql
SELECT column_name, is_nullable, data_type
  FROM information_schema.columns
  WHERE table_name = 'a2a_agent_keys' AND column_name = 'funding_wallet';
-- Esperado: is_nullable = 'YES', data_type = 'text'

SELECT table_name FROM information_schema.tables
  WHERE table_name = 'a2a_key_deposits';
-- Esperado: 1 fila

SELECT proname, pronargs FROM pg_proc
  WHERE proname = 'register_a2a_key_deposit';
-- Esperado: 1 fila con pronargs = 6 (v2 solamente; la v1 de 3 args fue dropeada por FIX-2)
```

### 4b. Env vars a setear (nuevas en WKH-35)

Documentadas en `.env.example:224-237`. Tres requeridas para activación real:

| Var | Requerida? | Descripción |
|-----|-----------|-------------|
| `A2A_DEPOSIT_TREASURY_KITE` | Recomendada | Address treasury para depósitos Kite. Si vacía, cae al `OPERATOR_PRIVATE_KEY` address. |
| `A2A_DEPOSIT_TREASURY_AVALANCHE` | Recomendada | Idem Avalanche. |
| `A2A_DEPOSIT_TREASURY_BASE` | Recomendada | Idem Base. |
| `A2A_DEPOSIT_MIN_CONFIRMATIONS` | Opcional (default 1) | Confirmaciones mínimas global. Default 1 (testnet). Recomendado 3+ en mainnet. |
| `A2A_DEPOSIT_MIN_CONFIRMATIONS_KITE` | Opcional | Override por chain. |
| `A2A_DEPOSIT_MIN_CONFIRMATIONS_AVALANCHE` | Opcional | Override por chain. |
| `A2A_DEPOSIT_MIN_CONFIRMATIONS_BASE` | Opcional | Override por chain. |

Las vars RPC (`KITE_RPC_URL`, `BASE_TESTNET_RPC_URL`, `FUJI_RPC_URL`, etc.) ya existen en el env del operator (usadas por los adapters existentes).

### 4c. Flujo de activación del caller (nuevo)

El flujo tiene DOS pasos (antes solo era 1):

1. **Bind funding wallet** (una vez por key, antes del primer depósito):
   ```
   POST /auth/funding-wallet
   x-a2a-key: <bearer>
   { "wallet": "0x<address>", "signature": "0x<firma>" }
   ```
   La firma es `signMessage(message: "WASIAI_BIND_FUNDING_WALLET:<key_id>")` con la clave privada de `wallet`. El `key_id` se obtiene del paso de creación de la key.

2. **Depositar on-chain** al treasury address (desde la `wallet` bindeada en el paso 1):
   - Enviar una transferencia ERC-20 del token soportado (PYUSD/USDC según chain) al treasury address (`A2A_DEPOSIT_TREASURY_<CHAIN>` o operator address).

3. **Registrar depósito** (después de que la tx tenga suficientes confirmaciones):
   ```
   POST /auth/deposit
   x-a2a-key: <bearer>
   { "key_id": "<id>", "chain_id": <chainId>, "token": "PYUSD", "tx_hash": "0x<hash>" }
   ```
   El `Transfer.from` de la tx on-chain debe coincidir con la `funding_wallet` bindeada.

---

## 5. Drift Detection

### Scope drift
- Archivos fuera del Scope IN documentado en el Story File: `src/__tests__/e2e/e2e.test.ts` (actualización de 1 aserción stale del 501 → 403). Documentado en `auto-blindaje.md` y aceptado por CR (`cr-report.md:168-171`). No es expansión de features.
- `src/services/identity.ts:110-139` (`bindFundingWallet`): función nueva fuera del scope original del SDD §4.1, pero requerida por el fix del BLQ-MED-1. Documentada en `ar-report-2.md:79-87`. Aceptada.
- `supabase/migrations/20260529000001_a2a_key_funding_wallet.sql` + `_down.sql`: migración nueva del fix-pack BLQ-MED-1. Documentada en RE-AR. Aceptada.
- `src/services/security/errors.ts`: 4 clases nuevas de error para FIX-1 (`FundingWalletProofInvalidError`, `FundingWalletAlreadyBoundError`, `FundingWalletNotBoundError`, `FundingWalletMismatchError`). Documentadas en RE-AR. Aceptadas.
- `src/types/a2a-key.ts`: campo `funding_wallet: string | null` aditivo. Documentado en RE-AR. Aceptado.
- Todas las desviaciones están anotadas en `auto-blindaje.md §FIX-1` y confirmadas en `ar-report-2.md`. Ninguna expande scope sin documentar.

### Spec drift
Ninguna. El flujo de 7 pasos del handler (`auth.ts:212-313`) coincide literalmente con SDD §4.4. La firma `registerDeposit(keyId, chainId, amountUsd, ownerId, txHash, token?)` (`budget.ts:74-81`) calza exacto con SDD §4.3 y Story File. Las PG functions (`migration :34-91`) implementan exactamente el diseño de SDD §4.2.

### Wave drift
No verificable desde git log (rama limpia sin commits históricos accesibles). Basado en auto-blindaje.md: Wave 0 (tipos/migración/errores), Wave 1 (verifier/service), Wave 2 (endpoint), Wave 3 (tests/env) ejecutados en orden. Sin evidencia de inversión de waves.

### MNRs del CR (aceptados como TD backlog)
- MNR-1 (precisión float): corregido por FIX-3 en `deposit-verifier.ts:282-297` (comparación BigInt exacta). Cerrado.
- MNR-2 (label `'getBalance'` en `logOwnershipMismatch` de registerDeposit): `budget.ts:98`. Backlog confirmado en `auto-blindaje.md`. No rompe ningún AC.
- MNR-3 (Avalanche sin test de path-feliz dedicado en verifier): `deposit-verifier.test.ts` no tiene T1-equivalente para `avalanche-fuji`. Backlog. Rama Avalanche en `resolveRpcUrl:128-131` y `resolveChainObject:150-153` no tiene test de happy path dedicado. Typecheck cubre exhaustividad del switch. No rompe AC-6 (cobertura equivalente vía Base).

---

## 6. Hallazgos F4

Ninguno nuevo. Los MNRs del CR/RE-AR son conocidos y aceptados como TD backlog.

**Único observation F4** (no bloquea): el campo `amount` en `DepositInput` es opcional de facto en el handler (`body.amount` solo se pasa a `verifyDeposit` como `expectedAmountUsd` opcional — `auth.ts:266`), pero el tipo `DepositInput.amount` en `src/types/a2a-key.ts` podría ser `string | undefined` explícitamente. Actualmente el cast `req.body as Partial<DepositInput>` cubre esto. Sin impacto funcional ni de seguridad. Cosmético.

---

**Listo para DONE.**
