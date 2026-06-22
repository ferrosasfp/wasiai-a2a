# AR Report — WKH-126b · Integración TS del Escrow No-Custodial

> **Adversary (nexus-adversary) · AR · 2026-06-22**
> **Branch:** `feat/117-wkh-126-escrow-noncustodial` (sobre `d076ea8`)
> **Veredicto: APROBADO con MENORs — 0 BLOQUEANTES, 2 MENOR**
>
> _Persistido por el orquestador a partir del output del agente AR (el system prompt del agente le impide escribir .md; el contenido es íntegro suyo)._

## Archivos atacados (leídos completos)
- `src/adapters/escrow/abi.ts`, `src/adapters/escrow/eip712.ts`
- `src/adapters/escrow-verifier.ts`
- `src/routes/auth.ts` (handler `POST /deposit` 614-750; helper `escrowModeEnabled` 125-127)
- `src/adapters/deposit-verifier.ts` (diff: 2 `export` aditivos)
- `src/types/receipt.ts` (diff: union member)
- `.env.example`
- Tests: `escrow-verifier.test.ts`, `escrow/eip712.test.ts`, `auth.escrow.test.ts`

Gates: `tsc --noEmit` → 0 errores. `vitest` escrow (34) + regresión treasury/receipt (65) → verde.

## Resultado por vector de ataque obligatorio

**1. Verify-before-credit (CD-1) — DEFENDIDO.** `auth.ts:680-695`: si `!result.ok || amountUsd===undefined || from===undefined` retorna 400/503 **antes** de `registerDeposit` (710). Verifier fail-loud en cada error; nunca `ok:true` por excepción (try/catch siempre retorna reason).

**2. Anti-replay (CD-2) — DEFENDIDO.** El escrow path llama el **mismo** `budgetService.registerDeposit` (`auth.ts:710-717`) sin bifurcar. `UNIQUE(chain_id, tx_hash)` del RPC `register_a2a_key_deposit` intacto (`budget.ts:314-345`). Mismo `tx_hash` → `DepositAlreadyCreditedError` → 409 (test AC-3).

**3. Ownership Guard / IDOR (CD-4, WKH-53) — DEFENDIDO.** (a) Pre-check `body.key_id !== callerKey.id → 403` (`auth.ts:639-641`). (b) `registerDeposit(callerKey.id, …, ownerRef, …)` con `ownerRef = callerKey.owner_ref` no-undefined (`auth.ts:620, 710-717`). (c) Cero queries nuevas a `.from('a2a_agent_keys')` en el escrow path (grep).

**4. Funding-wallet gate / front-run (BLQ-MED-1 previo) — DEFENDIDO.** `auth.ts:701-706` exige `callerKey.funding_wallet` y `result.from === funding_wallet` (`result.from = Deposited.depositor`). Doble binding (keyId + funding wallet): `Deposited` de otra key → `KEY_ID_MISMATCH`.

**5. keyId desde input crudo (CD-8) — DEFENDIDO.** `auth.ts:671`: `keyIdHash = keccak256(stringToBytes(callerKey.id))`, nunca de `body`. Verifier compara `Deposited.keyId` (topic2 bytes32 indexed) vs `keyIdHash` (`escrow-verifier.ts:206`). Monto acreditado siempre `Deposited.amount` on-chain (`escrow-verifier.ts:207, 222`), nunca `body.amount`.

**6. Feature flag (CD-11) — DEFENDIDO.** `auth.ts:126`: `=== 'true'` estricto. Test parametrizado (`'1'`,`'TRUE'`,`'True'`,`'yes'`,`''` → treasury; solo `'true'` → escrow). Flag off → `verifyEscrowDeposit` nunca llamado (`not.toHaveBeenCalled()`); shape/status idénticos → AC-8 sin regresión.

**7. EIP-712 (eip712.ts) — DEFENDIDO.** Domain con `verifyingContract` + `chainId` (CD-12). `verifyingContract` falsy / no-`/^0x[0-9a-fA-F]{40}$/` / `/^0x0+$/` → `presentable:false` sin firmar (`eip712.ts:110-120`). Recover de sanity con `recoverTypedDataAddress`; `presentable` solo si `=== signer.address`. Typehash por viem (no hardcode). Helper puro, no `writeContract`. `nonce` presente.

**8. Error mapping / disclosure — DEFENDIDO.** `auth.ts:686-694`: `RPC_UNAVAILABLE`/`ESCROW_CONTRACT_NOT_CONFIGURED` → 503; resto → 400; `FUNDING_WALLET_MISMATCH`/`OWNERSHIP_MISMATCH` → 403; `DEPOSIT_ALREADY_CREDITED` → 409. `error_code` enums estables; único 500 (`auth.ts:744-748`) loguea `errorClass`, no el mensaje crudo.

**9. viem-only / no-hardcodes / no-tocar-receiptService — DEFENDIDO.** Grep: 0 direcciones 40-hex, 0 topic/typehash 64-hex en producción escrow; 0 `ethers`. `receiptService` solo `emit(...)` fire-and-forget (`auth.ts:721`), archivo intacto. Direcciones desde `A2A_ESCROW_CONTRACT_<FAMILY>` (`escrow-verifier.ts:94-101`), sin fallback a EOA.

**10. Desviación `src/types/receipt.ts` — ver MNR-1.**

## Findings

### MNR-1 · [Data Integrity / Integration] — `'deposit_verified'` rechazado por CHECK constraint en runtime
- **Archivo:** `src/types/receipt.ts:11` vs `supabase/migrations/20260605000000_a2a_receipts.sql:12`.
- **Evidencia:** columna `receipt_type TEXT NOT NULL CHECK (receipt_type IN ('protocol_fee','budget_debit'))`. La union TS admite `'deposit_verified'` pero Postgres lo rechaza en el `INSERT` de `insert_receipt`.
- **Reproducción:** flag on + depósito escrow válido → `auth.ts:721` `emit({ receiptType:'deposit_verified' })` → RPC → `violates check constraint` → `receipt.ts:138` `console.warn` + return. Depósito devuelve 200; el recibo **no se escribe** en entorno con DB real.
- **Impacto:** AC-11 funcionalmente inerte en prod/staging hasta migración del CHECK. Sin data loss del depósito (budget acreditado). `emit` es never-throw → **NO bloqueante**; coincide con R-3 del SDD. Test AC-11 mockea `emit` (no toca DB real).
- **Sugerencia (no implementada):** migración aditiva `ALTER TABLE a2a_receipts ... CHECK (receipt_type IN ('protocol_fee','budget_debit','deposit_verified'))` como TD operacional acoplada al deploy de 126a.

### MNR-2 · [Cosmético] — Comentario treasury-path en el gate del escrow
- **Archivo:** `src/routes/auth.ts:697-700`. Comentario menciona `Transfer.to`/`Transfer.from` (terminología treasury); en escrow el evento es `Deposited`/`depositor`. Código correcto (usa `result.from`). Cero urgencia.

## Veredicto final
**APROBADO con MENORs.** 0 BLOQUEANTES. 11/11 vectores defendidos con evidencia archivo:línea. MNR-1 (recibo AC-11 no persiste por CHECK — predicho R-3, no bloqueante por never-throw) y MNR-2 (cosmético). Trackear MNR-1 como TD operacional acoplada al deploy de WKH-126a.
