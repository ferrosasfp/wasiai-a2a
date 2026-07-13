# SDD #175: [WKH-191c] Motor de reconciliación — resolver `reconciliation_pending` + drift budget-vs-escrow

> SPEC_APPROVED: no
> Fecha: 2026-07-13
> Tipo: feature (money-path / security)
> SDD_MODE: full
> Branch: feat/191c-reconciliation-engine
> Artefactos: doc/sdd/175-wkh-191c-reconciliation-engine/
> Epic: WKH-191 (fila 172) · Wave 0 · depende de 191a (fila 173) + 191b (fila 174, DONE código · PENDING-DEPLOY)

---

## 1. Resumen

191b deja intents en `a2a_payment_intent_debit_signatures.debit_settle_status =
'reconciliation_pending'` (o el huérfano `'hop1_confirmed'`) cuando el hop 1
(`escrow.debit`, buyer→operador) se confirmó/quedó ambiguo on-chain pero el hop 2
(operador→seller) falló. Es una **doble-contabilización temporal** money-safe: el
buyer quedó debitado off-chain (budget) y NO se reembolsó, y —según el caso— el
operador custodia los fondos on-chain o no.

191c construye el **motor de reconciliación** que, por-intent y tras **re-verificar
on-chain** la realidad del hop 1 (evento `Debited`), resuelve **EXACTAMENTE UN LADO**
(completar hop 2 al seller, o reembolsar al buyer) — nunca ambos, nunca ninguno —
de forma **idempotente**. El refund es **budget-only** (`refund_a2a_key_spend`, sin transfer
on-chain): 191c solo refunda cuando `Debited` NO ocurrió → el escrow del buyer está intacto
on-chain, restaurar el budget off-chain es suficiente y correcto (el buyer retira su escrow por
su propia ruta, siendo el `_depositor`). Agrega además la **detección (solo reporte)** de drift
entre el `budget` off-chain (cache) y `escrowBalance(keyId)` on-chain (libro
autoritativo, decisión del founder — DT-5).

El trigger son 2 endpoints admin-gated bajo el prefijo `/dashboard` (patrón WKH-189):
un `GET` read-only (listado + drift) y un `POST` **fail-closed** que ejecuta la
resolución money-moving. Cero cambios a `contracts/` y a `arbiter.ts`. Testnet-only,
flag-gated por `ESCROW_SETTLE_ENABLED` para toda acción que mueva dinero.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 175 (WKH-191c) |
| **Tipo** | feature / billing / security |
| **SDD_MODE** | full |
| **Objetivo** | Resolver `reconciliation_pending`/`hop1_confirmed` exactly-one-side + reportar drift budget-vs-escrow, vía endpoints admin-gated. |
| **Reglas de negocio** | Exactly-one-side; idempotencia (BLQ-DR); re-verificación on-chain previa; libro autoritativo on-chain (solo reporte); flag-gated money-moving; admin-gated fail-closed; Ownership Guard (WKH-53). |
| **Scope IN** | Ver §6 IN. |
| **Scope OUT** | Ver §6 OUT. |
| **Missing Inputs** | 0 bloqueantes. NC-1 (refund not-confirmed) RESUELTO = budget-only; los 3 Missing Inputs del work-item ratificados en F2 (§9). |

### Acceptance Criteria (EARS)

Heredados del work-item (AC-1..AC-9). Mapeados a archivos en §4.1 y a tests en §"Plan de tests".

1. **AC-1** — WHEN un admin invoca el `GET`, THE system SHALL devolver los intents con
   `debit_settle_status IN ('hop1_confirmed','reconciliation_pending')` con la evidencia
   mínima (`intent_id`, `key_id`, `nonce`, `debit_hop1_tx_hash`, `finalAmountUsd`,
   `owner_ref`) + (aditivo) los `resolving_*` colgados.
2. **AC-2** — WHEN el reconciler procesa un intent, THE system SHALL re-verificar on-chain
   el evento `Debited(keyId,nonce)` correspondiente al `debit_hop1_tx_hash` ANTES de decidir.
3. **AC-3** — IF `Debited` existe (operador custodia `finalAmountUsd`) Y el intent no está
   `settled`, THEN THE system SHALL reintentar EXCLUSIVAMENTE el hop 2 (operador→seller) y
   marcar `resolved_settled`, SIN reembolsar el budget off-chain.
4. **AC-4** — IF `Debited` NO existe (el escrow del buyer NO fue debitado on-chain), THEN THE
   system SHALL resolver como refund **budget-only**: `refund_a2a_key_spend` del monto off-chain
   (dentro del RPC de flip terminal, status-gated) → estado terminal `resolved_refunded`, SIN
   transfer on-chain y SIN tocar `escrowBalance` (el buyer conserva su escrow intacto y lo retira
   por su propia ruta `withdraw`, siendo él el `_depositor`). NC-1 RESUELTO (§10).
5. **AC-5** — WHILE un intent ya tiene un estado terminal `resolved_*`, THE system SHALL
   prevenir una segunda ejecución de la resolución (no-op money-safe).
6. **AC-6** — THE system SHALL garantizar que ningún intent quede simultáneamente/sucesivamente
   `resolved_settled` Y `resolved_refunded` (mutuamente excluyentes; columna single-valued +
   CHECK + transición gated).
7. **AC-7** — WHEN se invoca el chequeo de drift, THE system SHALL comparar la suma de
   `debit_amount_atomic` (statuses `{hop1_confirmed, settled, reconciliation_pending}`) por
   `key_id` contra `escrowBalance(keyId)` on-chain y REPORTAR la discrepancia (sin corregir).
8. **AC-8** — WHERE `ESCROW_SETTLE_ENABLED` está OFF, THE system SHALL permitir listado + drift
   (read-only) pero SHALL rechazar toda acción money-moving del `POST`.
9. **AC-9** — IF un caller invoca el `POST` sin `X-Admin-Token` válido, THEN THE system SHALL
   rechazar (401/403/503) sin ejecutar ninguna acción money-moving.

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/services/payment-intent.ts` | Seam de settle + BLQ-DR + estados de reconcile | `settlePaymentIntentOnChain({intentId,ownerRef,payTo,finalAmountUsd,chainId})` → `SettleOutcome{status,txHash,finalAmountUsd,failureKind}` NUNCA rechaza; `settleEscrowAware` (los 2 caminos a `reconciliation_pending`, líneas 540 y 590); patrón "veredicto persistido ANTES del side-effect, refund status-gated dentro del RPC" (BLQ-DR). |
| `src/adapters/escrow/debit-executor.ts` | Re-verificación de `Debited` on-chain | `parseAbiItem('event Debited(bytes32 indexed keyId,address indexed operator,uint256 amount,uint256 nonce)')` + `decodeEventLog` filtrando por `logEntry.address===escrowLc` y match `keyId.toLowerCase()` + `nonce===BigInt`. `recordDebitHop1`/`recordDebitSettleStatus` (wrappers RPC owner-guarded). |
| `src/adapters/escrow/debit-capture.ts` | Reader de la firma + flag | `ValidDebitRow`; `readValidDebitSignature` (re-valida amount/deadline; **el deadline caduca a 1h** → en reconcile devuelve null); `isEscrowSettleEnabled()` = `ESCROW_SETTLE_ENABLED==='true' && isDebitCaptureEnabled()`. |
| `src/adapters/escrow-verifier.ts` | Public-client cache + resolver de contrato | `resolveEscrowContract(chainKey)` (lee `A2A_ESCROW_CONTRACT_<FAMILY>`, `null` si ausente); patrón `getEscrowClient` (lazy `createPublicClient` per-ChainKey) + `decodeEventLog(Deposited)` sobre `receipt.logs`. |
| `src/adapters/escrow/abi.ts` | ABI escrow | `ESCROW_ABI` con `Debited`, `escrowBalance(bytes32)→uint256 view`, `debit`. topic0 derivado por viem (NUNCA literal). |
| `src/adapters/settle-verifier.ts` | Re-verificar una tx de resolución previa | `verifyDefaultChainSettle({txHash,payTo,requiredAmountAtomic})→SettleVerification{ok,warn?,reason?}` (Transfer→recipient===payTo, amount≥). Testnet fail-OPEN / mainnet fail-CLOSED. |
| `src/adapters/base/payment.ts` | El transfer operador→destino real | `sign()` genera nonce EIP-3009 **aleatorio** (`randomBytes(32)`) → un settle NO es idempotente on-chain (⇒ la idempotencia DEBE venir del state-machine DB, no del nonce). |
| `contracts/src/WasiAIEscrow.sol` | Confirmar DT-1 + shape de `escrowBalance`/`Debited` | `withdraw(keyId,amount)` exige `msg.sender==_depositor[keyId]` (línea 189) → operador NO puede invocarlo (**confirma DT-1**). `debit` paga a `msg.sender`=operador (línea 154). `escrowBalance` = `_balances[keyId]` (6 dec USDC). `Debited(keyId,operator,amount,nonce)` (línea 62). `keyId` on-chain = `keccak256(stringToBytes(key_id))`. |
| `src/routes/dashboard.ts` | Patrón admin-gated + registro | `requireAdminToken` (opt-in, timing-safe, prod fail-closed 503 si env unset); `fastify.get/post<{Params/Querystring}>` (generic en la llamada); `GET /api/arbitrations/holds` + `POST /api/arbitrations/:intentId/resolve` (cross-tenant admin deliberado); montado con `prefix:'/dashboard'` (`index.ts:167`). |
| `supabase/migrations/20260713000001_wkh191b_debit_hop1.sql` | Base de datos a extender | tabla + CHECK inline de `debit_settle_status` + `idx_debit_sig_settle_status` + RPCs `record_debit_hop1`/`record_debit_settle_status` (SECURITY DEFINER, owner-guard `FOR UPDATE` sobre `a2a_payment_intents`, `search_path` + REVOKE/GRANT `service_role`). |
| `supabase/migrations/20260713000000_wkh191a_debit_signatures.sql` | Shape de la tabla | columnas `debit_key_id_hash`, `debit_amount_atomic NUMERIC(78,0)`, `debit_nonce NUMERIC(78,0)`, `debit_signer_recovered` (address del buyer que firmó), índice único parcial anti-replay. |
| `supabase/migrations/20260625000000_wkh_audit_a2_refund_rows_affected.sql` | El RPC de refund off-chain | `refund_a2a_key_spend(p_key_id UUID, p_chain_id INT, p_amount_usd NUMERIC, p_owner_ref TEXT)→INT` (filas afectadas; owner-guarded; no-op ≤0). |

### Exemplars (verificados con Read/Glob)

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `supabase/migrations/20260713000002_wkh191c_reconciliation.sql` | `20260713000001_wkh191b_debit_hop1.sql` | ALTER additive + RPC SECURITY DEFINER owner-guarded + hardening REVOKE/GRANT. |
| `src/adapters/escrow/reconciler-onchain.ts` | `debit-executor.ts` (líneas 137-234) + `escrow-verifier.ts` (líneas 103-254) | log-scan de `Debited` por tx + public-client cache + `readContract` de `escrowBalance`. |
| `src/services/reconciliation.ts` | `payment-intent.ts` (BLQ-DR §217-471) + `arbiter.ts` (service shape) | seam-based money-path, verdicto persistido antes del side-effect, error class estable. |
| `src/routes/dashboard.ts` (modificar) | `dashboard.ts:176-250` (arb holds) | endpoints admin-gated cross-tenant, generic en `.get/post<>()`. |
| `src/types/database.types.ts` (modificar) | entradas 191a/191b existentes | `Args`/`Returns` de los 2 RPCs nuevos (NUMERIC uint256 → `string`). |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `a2a_payment_intent_debit_signatures` | Sí (191a+191b) | `intent_id`, `owner_ref`, `key_id`, `debit_key_id_hash`, `debit_amount_atomic`, `debit_nonce`, `debit_signer_recovered`, `debit_hop1_tx_hash`, `debit_settle_status` (CHECK a extender). |
| `a2a_payment_intents` | Sí (wkh135) | `id`, `owner_ref`, `key_id`, `pay_to` (seller), `buyer_wallet`, `chain_id`. |
| `a2a_agent_keys` | Sí | `budget` (jsonb per-chain, USD), `owner_ref`. RPC `refund_a2a_key_spend`. |

### Componentes reutilizables encontrados (NO recrear)

- `settlePaymentIntentOnChain` (seam WKH-136) — transfer operador→`payTo` + re-verify. **Reusar tal cual** para el hop 2 retry (`payTo`=seller) y —si se ratifica NC-1— para el transfer del refund (`payTo`=`debit_signer_recovered`).
- `verifyDefaultChainSettle` — re-verificar una tx de resolución previa (crash-recovery).
- `resolveEscrowContract`, `getDefaultChainKey`, `getAdaptersBundle`, `ESCROW_ABI`, `isEscrowSettleEnabled`.
- `refund_a2a_key_spend` — refund del budget off-chain (owner-guarded, rows-affected).
- `requireAdminToken` (dashboard.ts) — para el `GET`; un `requireAdminTokenStrict` nuevo (fail-closed) para el `POST`.

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `supabase/migrations/20260713000002_wkh191c_reconciliation.sql` | Crear | Widen CHECK (+4 estados), +2 columnas nullable, +1 índice parcial, +2 RPCs. | `..._wkh191b_debit_hop1.sql` |
| `supabase/migrations/20260713000002_wkh191c_reconciliation_down.sql` | Crear | Rollback additive. | `..._wkh191b_debit_hop1_down.sql` |
| `src/adapters/escrow/reconciler-onchain.ts` | Crear | `reverifyDebitedByTxHash()` + `readEscrowBalanceAtomic()`. | `debit-executor.ts` + `escrow-verifier.ts` |
| `src/services/reconciliation.ts` | Crear | `reconciliationService`: `listPending()`, `resolveIntent()`, `driftCheck()` + error class. | `payment-intent.ts` |
| `src/routes/dashboard.ts` | Modificar | `GET /api/reconciliation`, `POST /api/reconciliation/:intentId/resolve`, `requireAdminTokenStrict`. | `dashboard.ts` (arb) |
| `src/types/database.types.ts` | Modificar | `Args`/`Returns` de `claim_reconciliation` + `record_reconciliation_resolution`. | entradas 191a/b |
| `src/adapters/escrow/reconciler-onchain.test.ts` | Crear | Tests del log-scan por tx + read escrowBalance. | `debit-executor.test.ts` |
| `src/services/reconciliation.test.ts` | Crear | Tests exactly-one-side / idempotencia / drift / flag. | `payment-intent.test.ts` |
| `src/routes/dashboard.test.ts` (o el existente) | Modificar/Crear | Tests fail-closed + AC-8/AC-9 de los 2 endpoints. | test de dashboard existente |

> **AC ↔ archivo**: AC-1→service.listPending + route GET; AC-2→reconciler-onchain + service.resolveIntent; AC-3/AC-4→service.resolveIntent + migración RPCs; AC-5/AC-6→migración (state-machine/CHECK) + service; AC-7→service.driftCheck + reconciler-onchain; AC-8→service (gate `isEscrowSettleEnabled`); AC-9→route (`requireAdminTokenStrict`).

### 4.2 Modelo de datos (migración additive)

**State-machine de `debit_settle_status`** (columna single-valued → mutua exclusión inherente, AC-6):

```
              (191b)                         (191c)
 hop1_confirmed ─┐                    ┌─► resolving_settle ─► resolved_settled
                 ├─(claim, decide)────┤
 reconciliation_pending ─┘            └─► resolving_refund ─► resolved_refunded
        settled  (terminal happy-path 191b, no lo toca 191c)
```

Cambios SQL (todos additive; filas existentes intactas):

1. **Widen CHECK** de `debit_settle_status` (de 3 → 7 valores):
   ```sql
   ALTER TABLE a2a_payment_intent_debit_signatures
     DROP CONSTRAINT IF EXISTS a2a_payment_intent_debit_signatures_debit_settle_status_check;
   ALTER TABLE a2a_payment_intent_debit_signatures
     ADD  CONSTRAINT a2a_payment_intent_debit_signatures_debit_settle_status_check
     CHECK (debit_settle_status IS NULL OR debit_settle_status IN
       ('hop1_confirmed','settled','reconciliation_pending',
        'resolving_settle','resolving_refund','resolved_settled','resolved_refunded'));
   ```
   > **VERIFY-AT-IMPL**: el nombre auto-generado del CHECK inline de 191b es
   > `<tabla>_<col>_check` (convención Postgres). El Dev DEBE confirmar con `\d` que el
   > `DROP CONSTRAINT IF EXISTS` matchea; si difiere, ajustar el nombre (el `IF EXISTS`
   > evita el fallo pero también un no-op silencioso — verificar que efectivamente dropea).

2. **+2 columnas nullable**:
   ```sql
   ALTER TABLE a2a_payment_intent_debit_signatures
     ADD COLUMN IF NOT EXISTS debit_resolution_tx_hash TEXT,        -- tx de hop2-retry o refund-transfer
     ADD COLUMN IF NOT EXISTS debit_resolved_at        TIMESTAMPTZ; -- timestamp de la resolución terminal
   ```

3. **+1 índice parcial** (surface de resoluciones colgadas; NO toca el índice de 191b):
   ```sql
   CREATE INDEX IF NOT EXISTS idx_debit_sig_resolving
     ON a2a_payment_intent_debit_signatures (debit_settle_status)
     WHERE debit_settle_status IN ('resolving_settle','resolving_refund');
   ```

4. **RPC `claim_reconciliation`** — SECURITY DEFINER, owner-guarded, atómico. Transición
   condicional pending→`resolving_*` (el guard de concurrencia: solo UN caller gana).
   ```
   claim_reconciliation(p_intent_id UUID, p_owner_ref TEXT, p_key_id UUID,
                        p_nonce NUMERIC, p_side TEXT /* 'settle'|'refund' */)
     RETURNS TABLE(claimed BOOLEAN, resolution_tx_hash TEXT,
                   signer_recovered TEXT, amount_atomic TEXT, key_id_hash TEXT)
   ```
   Lógica: `FOR UPDATE` sobre `a2a_payment_intents` (owner-guard como 191b) →
   `UPDATE ... SET debit_settle_status = ('resolving_settle'|'resolving_refund')
   WHERE key_id=p_key_id AND debit_nonce=p_nonce AND debit_validation_status='valid'
   AND debit_settle_status IN ('hop1_confirmed','reconciliation_pending', <mismo resolving_*>)`.
   `GET DIAGNOSTICS` → `claimed = row_count>0`. Devuelve los campos de la fila
   (`debit_resolution_tx_hash`, `debit_signer_recovered`, `debit_amount_atomic`,
   `debit_key_id_hash`) para el crash-recovery y el transfer. Re-claim del **mismo** marker
   permitido (retry); marker **opuesto** o terminal `resolved_*` → 0 filas → `claimed=false`.

5. **RPC `record_reconciliation_resolution`** — SECURITY DEFINER, owner-guarded, status-gated,
   **money-atomic** (patrón BLQ-DR: el refund del budget vive DENTRO del RPC, gated).
   ```
   record_reconciliation_resolution(p_intent_id UUID, p_owner_ref TEXT, p_key_id UUID,
       p_nonce NUMERIC, p_terminal_status TEXT /* 'resolved_settled'|'resolved_refunded' */,
       p_tx_hash TEXT, p_chain_id INT, p_refund_amount_usd NUMERIC /* NULL en settle */)
     RETURNS TABLE(applied BOOLEAN)
   ```
   Lógica: owner-guard `FOR UPDATE`. `UPDATE ... SET debit_settle_status=p_terminal_status,
   debit_resolution_tx_hash=COALESCE(debit_resolution_tx_hash,p_tx_hash), debit_resolved_at=now()
   WHERE key_id/nonce/valid AND debit_settle_status = <resolving requerido por p_terminal_status>`
   (`resolved_settled` ⇐ solo desde `resolving_settle`; `resolved_refunded` ⇐ solo desde
   `resolving_refund` — enforcement de AC-6). `GET DIAGNOSTICS applied=row_count>0`. **Si
   `applied` Y `p_terminal_status='resolved_refunded'` Y `p_refund_amount_usd>0`** → dentro
   de la MISMA tx llama la lógica de `refund_a2a_key_spend` (o `PERFORM refund_a2a_key_spend(...)`)
   con el `owner_ref` real → el crédito del budget ocurre **exactamente una vez** (status-gated).
   Un retry ve `resolved_refunded` → `applied=false` → NO re-credita.

Hardening (obligatorio, espejo 191b): `SET search_path = public, pg_temp` + `REVOKE ... FROM
PUBLIC, anon, authenticated` + `GRANT ... TO service_role` en ambos RPCs.

### 4.3 Componentes / Servicios

**`src/adapters/escrow/reconciler-onchain.ts`** (público, no-throw defensivo):

- `reverifyDebitedByTxHash(args:{chainKey, escrowContract, txHash, keyIdHash, nonce})
   : Promise<'confirmed' | 'not_confirmed' | 'indeterminate'>`
  - `getTransactionReceipt(txHash)` (public-client cacheado, patrón `escrow-verifier.ts`).
    Throw/no-encontrado/RPC-caído → `'indeterminate'` (NUNCA decidir sobre incertidumbre, CD-3).
  - `receipt.status !== 'success'` (revert) → `'not_confirmed'` (el debit no ocurrió).
  - Scan `receipt.logs` filtrando `address===escrowContract.toLowerCase()` + `decodeEventLog`
    de `Debited` + match `keyId.toLowerCase()===keyIdHash.toLowerCase() && nonce===BigInt(nonce)`
    → match → `'confirmed'`; success sin match → `'not_confirmed'`.
  - `txHash` null/inválido → `'indeterminate'` (huérfano sin hash: no se puede re-verificar
    por tx → NO asumir not_confirmed, surface para revisión — evita un refund erróneo).
- `readEscrowBalanceAtomic(args:{chainKey, escrowContract, keyIdHash}): Promise<bigint | null>`
  - `readContract({address:escrowContract, abi:ESCROW_ABI, functionName:'escrowBalance',
    args:[keyIdHash]})`. Error/RPC-caído → `null` (drift no-computable para esa key, se reporta).

**`src/services/reconciliation.ts`** (`reconciliationService`):

- `listPending(): Promise<PendingRow[]>` (AC-1) — SELECT sobre la tabla JOIN
  `a2a_payment_intents` WHERE `debit_settle_status IN ('hop1_confirmed',
  'reconciliation_pending','resolving_settle','resolving_refund')`. Cross-tenant admin
  DELIBERADO (patrón `listHolds`). Deriva `finalAmountUsd = Number(formatUnits(
  BigInt(debit_amount_atomic), token.decimals))`.
- `resolveIntent(intentId): Promise<ResolveOutcome>` (AC-2..AC-6) — orquesta la resolución
  exactly-one-side (§4.4). **Gate `isEscrowSettleEnabled()` al inicio** (AC-8/CD-6): OFF →
  `{status:'flag_off'}` sin tocar dinero.
- `driftCheck(): Promise<DriftRow[]>` (AC-7) — por `key_id` con firmas escrow, computa
  `sumDebitedAtomic` (statuses `{hop1_confirmed,settled,reconciliation_pending}`) +
  `readEscrowBalanceAtomic` + lee `a2a_agent_keys.budget[chain_id]`. Reporta el tuple + delta.
  **Solo reporte** (DT-5/CD-4), NO recompute del agregado. Flag `exceedsThreshold` según
  `RECONCILE_DRIFT_ALERT_THRESHOLD_ATOMIC` (default 0 → reporta cualquier ≠0).
- `class ReconciliationError extends Error` con `code` estable
  (`INTENT_NOT_FOUND|NOT_PENDING|FLAG_OFF|INDETERMINATE|SETTLE_FAILED|INTERNAL`) →
  mapeado a HTTP en el route (disclosure-safe, patrón `PaymentIntentError`).

### 4.4 Flujo principal — resolución exactly-one-side (`resolveIntent`)

> Money-path CRÍTICO. El invariante (handoff-191c): resolver EXACTAMENTE UN LADO,
> idempotente, tras re-verificar on-chain. La idempotencia **NO** puede apoyarse en el
> nonce EIP-3009 del hop2/refund (es aleatorio, §3 `base/payment.ts`) → se apoya en el
> **state-machine DB** (`resolving_*` → `resolved_*`) + re-verificación on-chain.

1. **Gate flag** — `isEscrowSettleEnabled()` OFF → `flag_off`, return (AC-8).
2. **Leer la fila** (owner-guarded implícito: se lee el `owner_ref` REAL del intent/firma;
   CD-8 — nunca asumido). Si no hay firma `valid` en estado pending → `NOT_PENDING`.
   Extrae `debit_hop1_tx_hash`, `debit_key_id_hash`, `debit_nonce`, `debit_signer_recovered`,
   `debit_amount_atomic`, `pay_to` (seller), `chain_id`, `owner_ref`.
3. **Re-verificar on-chain** (AC-2/CD-3) — `reverifyDebitedByTxHash(...)`:
   - `'indeterminate'` → **abort**: NO mover dinero, dejar el estado como está, `INDETERMINATE`
     (se reintenta luego). *Nunca decidir sobre incertidumbre.*
   - `'confirmed'` → **lado SETTLE** (operador custodia `finalAmountUsd`).
   - `'not_confirmed'` → **lado REFUND** (operador no custodia; escrow del buyer intacto).
4. **CLAIM** — `claim_reconciliation(..., p_side)` (transición pending→`resolving_settle|refund`).
   `claimed=false` → otro run ganó / ya terminal → **no-op** (`already_resolved`, AC-5).
5. **Crash-recovery** — si el claim devolvió un `resolution_tx_hash` previo (run anterior
   murió tras enviar): `verifyDefaultChainSettle({txHash, payTo, requiredAmountAtomic})`:
   - `ok:true` (la tx anterior SÍ movió) → saltar a paso 7 (flip terminal), NO re-enviar.
   - `ok:false` definitivo → seguro re-enviar (paso 6).
   - `warn:true` (RPC no disponible) → **abort** (no re-enviar a ciegas ⇒ evita double-move).
6. **Mover el lado claimeado**:
   - **SETTLE**: `settlePaymentIntentOnChain({intentId, ownerRef, payTo:pay_to (seller),
     finalAmountUsd, chainId})` (el seam WKH-136, hop 2 puro operador→seller; DT-R2).
     - `status:'settled'` → paso 7 con `terminal='resolved_settled'`, `refundAmount=NULL`.
     - `failed` (unequivocal|ambiguous) → **abort** money-safe: dejar `resolving_settle`
       (surface), NO flip, NO refund. (`SETTLE_FAILED`.)
   - **REFUND (budget-only, NC-1 RESUELTO)**: `terminal='resolved_refunded'`,
     `refundAmount=finalAmountUsd`, `tx_hash=NULL` — **NO transfer on-chain**. El operador nunca
     recibió los fondos (no hubo `Debited`) y el escrow del buyer está intacto → NO se toca
     `escrowBalance`; el buyer retira su escrow por su propia ruta `withdraw` (él es el
     `_depositor`). El paso 7 acredita el budget off-chain dentro del RPC status-gated
     (exactamente una vez, BLQ-DR). Un transfer operador→buyer sería doble-pago + pérdida del
     operador → PROHIBIDO en el lado refund.
7. **Flip terminal + money-atomic** — `record_reconciliation_resolution(..., p_terminal_status,
   p_tx_hash, p_chain_id, p_refund_amount_usd)`. Gated: solo aplica desde el `resolving_*`
   correspondiente (AC-6). El refund del budget (refund side) ocurre DENTRO del RPC →
   exactamente una vez (AC-5). `applied=false` (ya terminal) → no-op idempotente.

### 4.5 Flujo de error

| Condición | Respuesta |
|-----------|-----------|
| `ESCROW_SETTLE_ENABLED` OFF + `POST` money-moving | 409 `FLAG_OFF` (AC-8) — sin tocar dinero. |
| `POST` sin/`X-Admin-Token` inválido | 401 (token malo) / 503 (env unset, fail-closed) — sin ejecutar nada (AC-9). |
| `reverifyDebitedByTxHash` → `indeterminate` (RPC caído / hash null) | 200 `{status:'indeterminate'}` — no se mueve dinero, se reintenta luego. |
| hop2 retry falla (unequivocal/ambiguous) | 200 `{status:'settle_failed'}` — queda `resolving_settle`, surface en el `GET`. |
| Intent no está en estado pending / claim perdido | 200 `{status:'already_resolved'}` (idempotente, AC-5). |
| Error interno (builder supabase, BigInt) | 500 `INTERNAL` (mensaje estático, detalle logueado). El service NUNCA rechaza el side-effect a medias. |

### 4.6 Endpoints (route)

- `GET /dashboard/api/reconciliation` — preHandler `requireAdminToken` (opt-in, read-only,
  AC-1/AC-7). Query `?drift=1` (o siempre incluir `drift` en el payload). Response:
  `{ pending: PendingRow[], drift: DriftRow[], flagEnabled: boolean }`. `rateLimit:false`.
- `POST /dashboard/api/reconciliation/:intentId/resolve` — preHandler
  **`requireAdminTokenStrict`** (fail-closed, AC-9). Ejecuta `resolveIntent(intentId)`.
  Gate `isEscrowSettleEnabled()` dentro del service (AC-8). Response `{status, side?, txHash?}`.
  - `requireAdminTokenStrict`: si `DASHBOARD_ADMIN_TOKEN` **no** está configurado → 503
    `service_unavailable` SIEMPRE (dev y prod — a diferencia del opt-in; este `POST` mueve
    dinero). Si está configurado → comparación timing-safe (mismo `timingSafeEqual` de
    `dashboard.ts`); mismatch/faltante → 401.

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir

- **CD-1 (EXACTLY-ONE-SIDE)** — un intent resuelve hop2 XOR refund, nunca ambos ni ninguno.
  Enforcement: columna single-valued + CHECK + transición gated (`resolved_settled`⇐`resolving_settle`,
  `resolved_refunded`⇐`resolving_refund`).
- **CD-2 (IDEMPOTENCIA / BLQ-DR)** — el estado terminal se persiste ATÓMICAMENTE con el money
  side-effect off-chain (refund del budget DENTRO de `record_reconciliation_resolution`,
  status-gated) → retry = no-op. El on-chain (hop2/refund transfer) se protege con el marker
  `resolving_*` + re-verificación de `debit_resolution_tx_hash` antes de re-enviar.
- **CD-3 (RE-VERIFICACIÓN ON-CHAIN PREVIA)** — decidir el lado SOLO tras `reverifyDebitedByTxHash`.
  `indeterminate` → abort. Nunca decidir sobre el estado DB persistido (puede ser tentativo).
- **CD-4 (LIBRO AUTORITATIVO ON-CHAIN, sin autocorrección)** — `escrowBalance` es fuente de verdad
  para el drift; SOLO reportar, nunca sobrescribir `budget`.
- **CD-8 (OWNERSHIP GUARD, WKH-53)** — todo RPC/query nuevo filtra por `owner_ref`; el refund usa
  el `owner_ref` REAL leído de la fila del intent, nunca asumido por el caller admin. Los RPCs
  nuevos hacen `FOR UPDATE` sobre `a2a_payment_intents` + comparan `owner_ref` (espejo 191b).
- **Patrón viem/DB** — `parseAbiItem`/`decodeEventLog`/`ESCROW_ABI` (topic0 derivado, NUNCA literal);
  public-client cacheado per-ChainKey; NUMERIC uint256 (`amount_atomic`/`nonce`) SIEMPRE como
  `string`/`BigInt`, NUNCA `number` (>2^53); `database.types.ts` con `string` para esos params
  (aprendizaje WKH-191a). Generic de Fastify en `.get/post<>()`, no en el `request` (WKH-189).
- **Hardening RPC** — `SET search_path=public,pg_temp` + `REVOKE FROM PUBLIC,anon,authenticated`
  + `GRANT TO service_role` (espejo 191b).

### PROHIBIDO

- **CD-5 (NO CONTRATO / NO ÁRBITRO)** — NO tocar `contracts/` ni `arbiter.ts`/lógica de disputa.
- **CD-6 (FLAG-GATED MONEY-MOVING)** — NO ejecutar hop2-retry ni refund con `ESCROW_SETTLE_ENABLED`
  OFF; el `GET` read-only SÍ corre.
- **CD-7 (ADMIN-GATED FAIL-CLOSED)** — NO exponer el `POST` money-moving sin `X-Admin-Token`;
  fail-closed (503 si env unset).
- NO usar `withdraw()` del contrato para el refund (imposible: exige `_depositor`).
- NO ejecutar transfer on-chain operador→buyer en el lado refund (budget-only; sería doble-pago
  + pérdida del operador — DT-R4/NC-1). El refund solo acredita el budget off-chain.
- NO usar `settleEscrowAware` para el hop2-retry (escribiría `debit_settle_status='settled'` vía
  `record_debit_settle_status` fuera del state-machine de 191c + re-leería la firma; DT-R2). Usar
  el seam `settlePaymentIntentOnChain` directo.
- NO recomputar/corregir el `budget` agregado desde `escrowBalance` (DT-5).
- NO agregar scheduler/cron in-proceso (el endpoint es el deliverable; cron externo = 191d).
- NO agregar dependencias nuevas; NO modificar los RPC de wkh135/191a/191b existentes.
- NO tocar el seam decimals-aware (WKH-192, Scope OUT).

### Decisiones técnicas nuevas (DT-R)

- **DT-R1** — Estados terminales = `resolved_settled` / `resolved_refunded`; markers in-flight
  = `resolving_settle` / `resolving_refund`. Un solo columna single-valued garantiza AC-6.
- **DT-R2** — El hop2-retry usa `settlePaymentIntentOnChain` (seam base) DIRECTO, no
  `settleEscrowAware`. Razón: `settleEscrowAware` (a) re-lee la firma (deadline caduca a 1h →
  ya inválida en reconcile) y (b) al `settled` escribe `debit_settle_status='settled'` (fuera del
  state-machine de 191c). El seam directo es hop 2 puro (operador→seller) y NO duplica lógica de
  hop 1 (cumple el espíritu de Scope IN). *Desviación de la letra del work-item — surface al
  Adversary.*
- **DT-R3** — El crash-recovery re-verifica `debit_resolution_tx_hash` con `verifyDefaultChainSettle`
  antes de re-enviar → cierra la ventana double-move salvo el gap facilitator-ambiguo (R-3).
- **DT-R4 (NC-1 RESUELTO)** — Refund cuando `Debited` NO existe = **budget-only**
  (`refund_a2a_key_spend` dentro del RPC de flip terminal, status-gated). NO transfer on-chain,
  NO se toca `escrowBalance` — el escrow del buyer está intacto y lo retira él mismo. Un transfer
  operador→buyer sería doble-pago + pérdida del operador (PROHIBIDO). El caso `Debited='confirmed'`
  siempre va a hop2 (AC-3), nunca a refund.

## 6. Scope

**IN:**
- Migración additive (state-machine +4 estados, +2 columnas, +1 índice, +2 RPCs).
- `reconciler-onchain.ts` (re-verify `Debited` por tx + read `escrowBalance`).
- `reconciliationService` (listPending / resolveIntent exactly-one-side / driftCheck).
- 2 endpoints admin-gated (`GET` opt-in read-only + `POST` fail-closed money-moving).
- Reuso de `settlePaymentIntentOnChain`, `verifyDefaultChainSettle`, `refund_a2a_key_spend`.
- Flag-gating (`isEscrowSettleEnabled`) de las acciones money-moving.
- Config del umbral de drift (`RECONCILE_DRIFT_ALERT_THRESHOLD_ATOMIC`, default 0).

**OUT:**
- Árbitro/disputa (WKH-139 v2, Wave 1). Cero cambios a `arbiter.ts`.
- Seam decimals-aware (WKH-192). Cero cambios a `usdToWei`/decimals de settle.
- Activación de 191b en prod (191d). Cron externo (191d).
- Corrección automática del `budget` agregado (DT-5).
- Cambios a `contracts/`. Chains nuevas (solo Base Sepolia).
- Alerting Discord del drift (solo response HTTP + `log.warn`; wiring `alerts.mjs` diferido).

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| **R-1** Un Dev implementa el refund not-confirmed como transfer on-chain (fondos que el operador no recibió → pérdida) en vez de budget-only. | B | A | NC-1 RESUELTO = budget-only (DT-R4/§10); CD PROHIBIDO explícito + test que verifica que el refund NO llama al seam on-chain y solo credita el budget. |
| **R-2** Double-move (hop2+refund, o doble hop2/refund) por concurrencia o retry. | B | A | State-machine `resolving_*`→`resolved_*` con transición condicional atómica (`claim_reconciliation` gana-uno) + refund del budget status-gated dentro del RPC (CD-2). |
| **R-3** Gap facilitator-ambiguo: la tx de resolución se broadcasteó pero el proceso murió antes de persistir `debit_resolution_tx_hash` → un retry re-verifica sin hash. | B | M | El seam re-verifica on-chain internamente antes de reportar `settled`; el estado queda `resolving_*` (surface en el `GET`) para verificación manual — igual filosofía money-safe que 191b (nunca peor que un pending auditable). Documentar. |
| **R-4** WKH-192 (decimals seam) bloquea el hop 2 en Base → el settle side no completa hasta que 191d/192 lo resuelvan. | A | M | 191c es code-complete; hasta 192, el settle side deja fondos custodiados + surface (no pierde). Dependencia explícita (§8). |
| **R-5** `DROP CONSTRAINT IF EXISTS` no matchea el nombre auto-generado → CHECK no se ensancha → los `INSERT`/`UPDATE` de los nuevos estados fallan. | B | M | VERIFY-AT-IMPL en §4.2 (confirmar nombre con `\d`); test de migración / smoke del `UPDATE` a `resolving_settle`. |
| **R-6** Drift check compara unidades distintas (budget USD micro vs escrowBalance atomic 6-dec). | M | B | Reportar valores RAW + `sumDebitedAtomic` sin forzar ecuación (decimals seam = WKH-192, OUT); flag por umbral atomic. Solo reporte (DT-5). |

## 8. Dependencias

- **191a (fila 173)** + **191b (fila 174)** — tabla + RPCs + `settleEscrowAware`/seam + estados
  `reconciliation_pending`/`hop1_confirmed`. Código DONE (PENDING-DEPLOY); base suficiente para F2/F3.
- **WKH-192 (decimals seam)** — bloquea la EJECUCIÓN real del hop 2 en Base (R-4), NO el código de 191c.
- **191d (activación)** — aplica migraciones + flags Railway + cron externo. Secuenciar DESPUÉS de 191c.
- Env: `A2A_ESCROW_CONTRACT_<FAMILY>`, `OPERATOR_PRIVATE_KEY`, RPC de la default chain,
  `DASHBOARD_ADMIN_TOKEN`, `ESCROW_SETTLE_ENABLED`+`ESCROW_DEBIT_CAPTURE_ENABLED`,
  `RECONCILE_DRIFT_ALERT_THRESHOLD_ATOMIC` (opcional, default 0).

## 9. Missing Inputs

- [x] **NC-1 (RESUELTO)** — refund cuando `Debited` NO existe = **budget-only** (sin transfer
  on-chain, sin tocar `escrowBalance`). Ratificado por el orquestador. Ver DT-R4 / §10.
- [x] Fail-closed del `POST` money-moving — **RATIFICADO en F2**: sí, `requireAdminTokenStrict`
  (503 si env unset). (Missing Input #1 del work-item.)
- [x] Wiring de cron externo — **RATIFICADO en F2**: diferido a 191d; el endpoint es el deliverable.
  (Missing Input #2 del work-item.)
- [x] Umbral/alerting del drift — **RATIFICADO en F2**: reportar cualquier ≠0
  (`RECONCILE_DRIFT_ALERT_THRESHOLD_ATOMIC` default 0); alerting Discord diferido (solo response +
  `log.warn`). (Missing Input #3 del work-item.)
- [x] Naming del estado terminal — **RESUELTO**: DT-R1.

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| **NC-1 (RESUELTO)** | 4.4 paso 6 REFUND / DT-R4 / AC-4 | Cuando `reverifyDebitedByTxHash='not_confirmed'` el operador NUNCA recibió los fondos y el escrow del buyer está intacto on-chain. La resolución ratificada es **budget-only**: `refund_a2a_key_spend` del monto off-chain dentro del RPC de flip terminal (status-gated, BLQ-DR), SIN transfer on-chain y SIN tocar `escrowBalance` — el buyer retira su escrow por su propia ruta `withdraw` (él es el `_depositor`). Un transfer operador→buyer sería doble-pago + pérdida del operador. La DT-1 original del F1 (transfer directo operador→buyer) era un error de premisa; queda descartada. El caso `Debited='confirmed'` siempre va a hop2 al seller (AC-3), nunca a refund. **Ratificado por el orquestador — ya NO bloquea.** | No (resuelto) |

> NC-1 resuelto (budget-only). No quedan markers bloqueantes.

---

## Plan de Implementación — Waves

### Wave 0 (Serial Gate) — contrato de datos
- [ ] **W0.1** Migración `20260713000002_wkh191c_reconciliation.sql` (+down): widen CHECK,
  +2 columnas, +índice, +2 RPCs (`claim_reconciliation`, `record_reconciliation_resolution`).
  → Exemplar: `..._wkh191b_debit_hop1.sql`. **VERIFY-AT-IMPL nombre del CHECK (R-5).**
- [ ] **W0.2** Entradas `Args`/`Returns` de los 2 RPCs en `database.types.ts` (NUMERIC→`string`).

### Wave 1 (Parallelizable) — on-chain reader
- [ ] **W1.1** `reconciler-onchain.ts`: `reverifyDebitedByTxHash` + `readEscrowBalanceAtomic`.
  → Exemplar: `debit-executor.ts` (log-scan) + `escrow-verifier.ts` (public-client + readContract).

### Wave 2 (Depende de W0 + W1) — servicio exactly-one-side
- [ ] **W2.1** `reconciliation.ts`: `listPending`, `resolveIntent` (§4.4), `driftCheck`,
  `ReconciliationError`. Reusa seam/`verifyDefaultChainSettle`/RPCs nuevos. Depende de W0.1, W1.1.

### Wave 3 (Final) — endpoints + drift wiring
- [ ] **W3.1** `dashboard.ts`: `requireAdminTokenStrict` + `GET /api/reconciliation` +
  `POST /api/reconciliation/:intentId/resolve`. Depende de W2.1.

### Test Plan (≥1 por AC)

| Test | AC | Wave | Framework |
|------|-----|------|-----------|
| `reverifyDebitedByTxHash`: receipt con `Debited` match → `confirmed` | AC-2/AC-3 | W1 | vitest |
| `reverifyDebitedByTxHash`: receipt success sin `Debited` / revert → `not_confirmed` | AC-2/AC-4 | W1 | vitest |
| `reverifyDebitedByTxHash`: RPC throw / txHash null → `indeterminate` (no decide) | AC-2/CD-3 | W1 | vitest |
| `readEscrowBalanceAtomic`: readContract OK → bigint; error → null | AC-7 | W1 | vitest |
| `resolveIntent` confirmed → llama seam `payTo=seller`, NO refund budget, flip `resolved_settled` | AC-3 | W2 | vitest |
| `resolveIntent` not_confirmed → refund budget (`refund_a2a_key_spend`), flip `resolved_refunded`; (si NC-1=transfer) `payTo===debit_signer_recovered` (nunca otro) | AC-4/NC-1 | W2 | vitest |
| `resolveIntent` idempotente: 2ª corrida sobre intent ya `resolved_*` → no-op (claim `false`), sin 2º side-effect | AC-5 | W2 | vitest |
| exactly-one-side: `record_reconciliation_resolution('resolved_settled')` desde `resolving_refund` → `applied=false` (no cruza lados) | AC-6 | W2 | vitest |
| `resolveIntent` con `isEscrowSettleEnabled()` OFF → `flag_off`, cero side-effect | AC-8 | W2 | vitest |
| `resolveIntent` `indeterminate` (RPC caído) → abort, no mueve dinero | CD-3/R-3 | W2 | vitest |
| crash-recovery: `resolution_tx_hash` previo `ok:true` → NO re-envía, flip terminal | R-3/CD-2 | W2 | vitest |
| `driftCheck`: reporta `sumDebitedAtomic` vs `escrowBalance` + delta, NO corrige budget | AC-7/CD-4 | W2 | vitest |
| `GET /api/reconciliation`: lista pending + drift (read-only, con flag OFF) | AC-1/AC-8 | W3 | vitest |
| `POST .../resolve` sin `X-Admin-Token` (env set) → 401; env unset → 503 (fail-closed) | AC-9/CD-7 | W3 | vitest |

> Integraciones SQL (transición condicional del CHECK, refund status-gated dentro del RPC,
> owner-guard `FOR UPDATE`) se verifican en la migración (no simulables sin Postgres) — NO usar
> `expect(true).toBe(true)` (aprendizaje WKH-191b CR MNR-1); documentar como integración explícita.

### Verificación Incremental

| Wave | Verificación |
|------|--------------|
| W0 | migración aplica en dev; `\d` confirma CHECK ensanchado + RPCs; tsc de `database.types.ts`. |
| W1 | tsc + tests del reader. `./node_modules/.bin/biome check --write`. |
| W2 | tsc + tests del servicio (exactly-one-side / idempotencia / drift / flag). |
| W3 | tsc + tests de ruta + full QA (fail-closed, flag OFF). biome 0. |

### Estimación
- Archivos nuevos: 5 (1 migración +1 down, 1 adapter, 1 service, +tests). Modificados: 2
  (`dashboard.ts`, `database.types.ts`). Tests nuevos: ~14. Líneas estimadas: ~700-900.

---

## Readiness Check

```
[x] Cada AC (1-9) tiene ≥1 archivo asociado en §4.1
[x] Cada archivo en §4.1 tiene Exemplar verificado con Read/Glob (paths reales confirmados)
[x] Sin [NEEDS CLARIFICATION] pendientes — NC-1 RESUELTO (budget-only)
[x] Constraint Directives incluyen >3 PROHIBIDO
[x] Context Map tiene >2 archivos leídos (12 leídos)
[x] Scope IN/OUT explícitos
[x] BD: tablas verificadas que existen (191a/191b/wkh135)
[x] Happy Path completo (§4.4)
[x] Flujo de error definido (§4.5)
```

> **READY FOR SPEC_APPROVED.** Settle side, refund budget-only, drift solo-reporte, endpoints
> admin fail-closed, state-machine + idempotencia — todo especificado y verificado. Sin markers
> bloqueantes.

---

*SDD generado por NexusAgil — Architect F2 — WKH-191c*
