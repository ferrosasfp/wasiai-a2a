# Story File — #174: [WKH-191b] Rewire escrow-aware del settle (flujo normal, two-hop)

> SDD: doc/sdd/174-wkh-191b-escrow-settle-rewire/sdd.md
> Fecha: 2026-07-13
> Branch: feat/191b-escrow-settle-rewire

---

## Goal

Consumir la firma EIP-712 `DebitAuthorization` `valid` que **191a** persiste hoy INERTE y ejecutar
el settle real como un **two-hop on-chain**, flag-gated: (hop 1) `escrow.debit(keyId, amount,
deadline, nonce, signature)` mueve fondos del BUYER del escrow al operador; (hop 2) el operador
reenvía al seller reusando el seam WKH-136 (`settlePaymentIntentOnChain`) **sin cambios**. Con el
flag OFF, sin firma `valid`, o sin escrow en la chain, el comportamiento es **byte-idéntico** al
path operator-custodial de HOY. Cero Solidity, cero cambios al accounting off-chain de `budget`.

---

## Acceptance Criteria (EARS)

> Copiados del SDD/work-item aprobados. QA los verifica en F4.

1. **AC-1 (two-hop):** WHEN `ESCROW_SETTLE_ENABLED=true` AND `ESCROW_DEBIT_CAPTURE_ENABLED=true`
   AND existe una firma con `debit_validation_status='valid'` persistida (191a) para el intent
   AND `resolveEscrowContract(chainKey)` no es `null`, THE system SHALL invocar `escrow.debit(...)`
   (hop 1), esperar su confirmación on-chain, y — solo si hop 1 se confirma exitoso — proceder a
   hop 2 (el sign+settle EIP-3009 operador→seller existente, sin cambios).
2. **AC-2 (fallback default):** WHEN `ESCROW_SETTLE_ENABLED=false` (default), OR no existe firma
   `valid`, OR `resolveEscrowContract(chainKey)` es `null`, THE system SHALL ejecutar el settle
   byte-idénticamente al path operator-custodial actual, sin intentar hop 1.
3. **AC-3 (hop 1 fail-safe):** IF hop 1 revierte, la re-verificación on-chain post-tx lo contradice
   con evidencia de que NADA se movió, o el intento lanza antes de broadcastear, THEN THE system
   SHALL descartar el escrow-settle y caer al path operator-custodial (hop 2 solo), sin bloquear
   ni fallar el settle, y sin haber movido fondos del escrow.
4. **AC-4 (hop 2 fail tras hop 1 exitoso):** IF hop 1 se confirma exitoso PERO hop 2 falla o es
   ambiguo, THEN THE system SHALL persistir el tx hash de hop 1 y marcar el intent
   **reconciliation-pending**, SHALL NOT asumir pago al seller, y SHALL NOT reembolsar al buyer.
5. **AC-5 (exactly-once):** IF el settle se reintenta (recovery / `expireStale` / segunda llamada
   concurrente) para un intent donde hop 1 YA fue ejecutado exitosamente (tx hash persistido),
   THEN THE system SHALL NOT reintentar `escrow.debit()` y SHALL reintentar únicamente hop 2.
6. **AC-6 (chain scope / R-1):** WHERE la chain no tiene escrow configurado (`resolveEscrowContract`
   → `null`, p.ej. la default `kite-ozone-testnet`), THE system SHALL comportarse como AC-2, sin
   error, sin importar el estado del flag.
7. **AC-7 (no duplicar anti-replay):** THE system SHALL leer exclusivamente la firma `valid` más
   reciente para `(intent_id, owner_ref)` y SHALL respetar el índice único parcial
   `uq_debit_sig_valid_nonce (key_id, debit_nonce)` de 191a como única fuente de verdad — sin
   duplicar lógica de anti-replay nueva.

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `supabase/migrations/20260713000001_wkh191b_debit_hop1.sql` | Crear | ALTER TABLE +3 cols nullable + índice parcial + 2 RPC SECURITY DEFINER owner-guarded (`record_debit_hop1`, `record_debit_settle_status`). SQL completo en §W0.1 | `20260713000000_wkh191a_debit_signatures.sql` |
| 2 | `supabase/migrations/20260713000001_wkh191b_debit_hop1_down.sql` | Crear | DROP de ambos RPC + índice + 3 columnas. SQL completo en §W0.1 | `20260713000000_wkh191a_debit_signatures_down.sql` |
| 3 | `src/adapters/escrow/abi.ts` | Modificar | Agregar el evento `Debited` a `ESCROW_ABI` (aditivo, converge byte-a-byte con `WasiAIEscrow.sol:62`). NO tocar nada más | (mismo archivo, `Deposited`) |
| 4 | `src/types/database.types.ts` | Modificar | 3 columnas nullable en Row/Insert/Update de `a2a_payment_intent_debit_signatures` + 2 funciones en `Functions` (`p_nonce: string`). `biome check --write` | (misma tabla, entradas 191a) |
| 5 | `src/adapters/escrow/debit-capture.ts` | Modificar | Agregar `isEscrowSettleEnabled()` + `readValidDebitSignature(...)` (reader owner-guarded + re-valida amount/deadline). NO tocar la captura existente | (mismo archivo) |
| 6 | `src/adapters/escrow/debit-executor.ts` | Crear | `executeDebitHop1(...)` (writeContract `debit` + receipt + re-verify `Debited`) + wallet/public client cache per-ChainKey + `getEscrowReceiptTimeoutMs()` + `_resetDebitExecutor()` + `recordDebitHop1`/`recordDebitSettleStatus` (wrappers RPC) | `src/adapters/base/gasless.ts:235-296,437-475` |
| 7 | `src/services/payment-intent.ts` | Modificar | `settleEscrowAware(...)` (orquestador two-hop) + reemplazar el ÚNICO call-site en `closeSession` (:727) y `settleUpto` (:1063). `settlePaymentIntentOnChain` **SIN CAMBIOS** | (mismo archivo, seam :347-463) |
| 8 | `src/adapters/escrow/debit-executor.test.ts` | Crear | Tests T-8, T-11 (mock viem wallet/public client) | `src/adapters/escrow/debit-capture.test.ts` |
| 9 | `src/adapters/escrow/debit-capture.test.ts` | Modificar | Tests T-2b, T-2c, T-7 (reader) | (mismo archivo) |
| 10 | `src/services/payment-intent.test.ts` | Modificar | Tests T-1, T-2, T-3, T-4, T-4b, T-5, T-6, T-9 (`settleEscrowAware` con executor+seam mockeados) | (mismo archivo) |

---

## Exemplars

### Exemplar 1: walletClient + writeContract + receipt (para debit-executor.ts, Archivo #6)
**Archivo**: `src/adapters/base/gasless.ts:235-296` (clients), `:437-475` (submit + receipt)
**Usar para**: `getEscrowWalletClient`/`getEscrowPublicClient`/`executeDebitHop1`
**Patrón clave**:
- Cache lazy per-key: `if (cached) return cached; ... _map.set(key, client); return client;`. Acá la
  clave es `ChainKey` (no `BaseNetwork`) → usar `Map<ChainKey, ...>`.
- Wallet: `privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY as \`0x${string}\`)` +
  `createWalletClient({ account, chain: resolveChainObject(chainKey), transport: buildRpcTransport({ primary: resolveRpcUrl(chainKey), fallbackEnv: resolveRpcFallbackEnv(chainKey), chainId }) })`.
  Sin PK / sin RPC → devolver `{ kind:'not_moved', reason:'OPERATOR_KEY_OR_RPC_UNSET' }` (NO lanzar).
- Public: `createPublicClient({ chain: resolveChainObject(chainKey) as Chain, transport: buildRpcTransport(...) })`.
- Submit: `txHash = await wallet.writeContract({ address, abi: ESCROW_ABI, functionName:'debit', args:[...], chain, account: wallet.account ?? null })` dentro de `try/catch` → catch = pre-broadcast → `not_moved`.
- Receipt: `waitForTransactionReceipt({ hash, timeout })` — timeout THROW (catch) separado de revert
  (`receipt.status !== 'success'`). Gasless usa `WaitForTransactionReceiptTimeoutError` para el timeout.
- Env timeout: patrón `RECEIPT_TIMEOUT_MS_DEFAULT = 60_000` + `process.env.<VAR>` parse `>0`
  (`gasless.ts:76,229-232`). Acá la var es `ESCROW_DEBIT_RECEIPT_TIMEOUT_MS` (default `60_000`).

### Exemplar 2: escaneo de logs + decodeEventLog por evento del escrow (para re-verify `Debited`)
**Archivo**: `src/adapters/escrow-verifier.ts:182-227`
**Usar para**: paso 5 de `executeDebitHop1` (matchear el evento `Debited`)
**Patrón clave**:
- `const escrowLc = escrowContract.toLowerCase();`
- `for (const log of receipt.logs) { if (log.address.toLowerCase() !== escrowLc) continue; try { decoded = decodeEventLog({ abi:[DEBITED_EVENT], eventName:'Debited', data: log.data, topics: log.topics }) } catch { continue } ... }`
- Matchear `decoded.args.keyId.toLowerCase() === keyIdHash.toLowerCase()` (y `nonce`).
- No encontrado → `{ kind:'ambiguous', reason:'DEBITED_EVENT_NOT_FOUND', txHash }` (receipt success sin
  evento = contradicción; NUNCA asumir confirmado).
- `DEBITED_EVENT` derivar del ABI (`ESCROW_ABI` filtrado o `parseAbiItem`), NUNCA hardcodear topic0.

### Exemplar 3: reader owner-guarded + cast supabase (para readValidDebitSignature, Archivo #5)
**Archivo**: `src/adapters/escrow/debit-capture.ts:121-130` (read owner-guarded), `:73-89` (gate chain+token+parseUnits)
**Usar para**: `readValidDebitSignature`
**Patrón clave**:
- `supabase.from('a2a_payment_intent_debit_signatures').select('debit_signature, debit_amount_atomic, debit_deadline, debit_nonce, debit_key_id_hash, debit_hop1_tx_hash, debit_settle_status').eq('intent_id', intentId).eq('owner_ref', ownerRef).eq('debit_validation_status','valid').order('captured_at', { ascending:false }).limit(1).maybeSingle()`.
- **CD-S2**: `const row = data as unknown as ValidDebitRow | null` (select tipado a mano → cast).
- Re-validar amount: `token = getAdaptersBundle(chainKey)?.payment.supportedTokens[0]; serverAtomic = parseUnits(finalAmountUsd.toString(), token.decimals)` — espejo EXACTO de `debit-capture.ts:88-89`. Mismatch `BigInt(row.debit_amount_atomic) !== serverAtomic` → devolver `null` (fallback).
- Re-validar deadline: `now = BigInt(Math.floor(Date.now()/1000)); dl = BigInt(row.debit_deadline);` si `now > dl` o `dl > now + 3600n` → `null`. (Espejo de `debit-capture.ts:141-149`, `MAX_DEADLINE_TTL_SECONDS = 3600n`.)

### Exemplar 4: seam WKH-136 + ramas de fallo del caller (para settleEscrowAware, Archivo #7)
**Archivo**: `src/services/payment-intent.ts:347-463` (seam, NO tocar), `:727-836` (closeSession fallo), `:1063-1162` (settleUpto fallo)
**Usar para**: `settleEscrowAware` + reemplazo del call-site
**Patrón clave**:
- El seam **NUNCA rechaza**: siempre devuelve `SettleOutcome` (`status:'settled'|'failed'`, `failureKind:'unequivocal'|'ambiguous'`). `settleEscrowAware` debe honrar el mismo contrato (CD-S5).
- El caller ya trata `failureKind==='unequivocal'` → `finalize('failed_unequivocal')` = **refund**;
  `'ambiguous'` → `RECONCILE:` + `finalize('failed_ambiguous')` = **failed, NO refund**. `settleEscrowAware`
  NO cambia esas ramas: solo devuelve el `SettleOutcome` correcto (con remap `unequivocal→ambiguous`
  cuando hop 1 ya movió fondos — CD-S4).
- Firma del seam (params exactos): `{ intentId, ownerRef, payTo, finalAmountUsd, chainId }`. El call-site
  de closeSession pasa `payTo: row.pay_to, finalAmountUsd: finalUsd, chainId: row.chain_id`. `row.key_id`
  está disponible (191a lo usa en `:691`); `settleEscrowAware` agrega `keyId: row.key_id`.

### Exemplar 5: RPC SECURITY DEFINER owner-guarded (para la migración, Archivo #1)
**Archivo**: `supabase/migrations/20260713000000_wkh191a_debit_signatures.sql:56-140`
**Usar para**: `record_debit_hop1` / `record_debit_settle_status`
**Patrón clave**:
- Owner-guard: `SELECT owner_ref INTO v_owner FROM a2a_payment_intents WHERE id = p_intent_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'INTENT_NOT_FOUND: %'; ...; IF v_owner IS DISTINCT FROM p_owner_ref THEN RAISE EXCEPTION 'OWNERSHIP_MISMATCH: ...'; END IF;`
- Cierre GRANTS (verbatim, ajustando firma): `ALTER FUNCTION ... SET search_path = public, pg_temp; REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role;`
- `NUMERIC(78,0)` para uint256; `$$ LANGUAGE plpgsql SECURITY DEFINER;`

---

## Constraint Directives

### OBLIGATORIO
- **CD-1 (flag AND default-OFF):** `isEscrowSettleEnabled()` = `process.env.ESCROW_SETTLE_ENABLED === 'true' && isDebitCaptureEnabled()`. Ambos deben estar ON. Default/unset → path de HOY.
- **CD-2 (byte-idéntico flag-OFF/sin-firma/sin-escrow/hop1-fail):** en TODOS esos casos `settleEscrowAware` delega en `settlePaymentIntentOnChain(base)` con los MISMOS params — cero cambio de latencia perceptible, cero excepción no capturada. El flag-OFF debe salir en la **1ª línea** (fast-path, sin lecturas DB ni on-chain).
- **CD-3 (exactly-once hop 1, persistir ANTES de hop 2):** si `row.debit_hop1_tx_hash` está seteado → skip hop 1, ir directo a hop 2. Tras un hop 1 `confirmed`, llamar `recordDebitHop1(...)` **ANTES** de invocar el seam (hop 2). BLQ-DR.
- **CD-4 (nunca asumir pago ni refund con hop1-ok/hop2-fail):** hop 1 confirmed + hop 2 failed → `recordDebitSettleStatus('reconciliation_pending')` + devolver `SettleOutcome{ status:'failed', failureKind:'ambiguous', error:'RECONCILE-ESCROW: ...' }`. **reconciliation-pending NUNCA reembolsa.**
- **CD-7 (reuso EXACTO):** usar `DEBIT_AUTHORIZATION_TYPES`/`recoverDebitAuthorization` de `eip712.ts` y `ESCROW_ABI.debit` de `abi.ts` ya definidos por 191a. 191b consume la firma **cruda persistida** (`row.debit_signature`), NO re-firma nada.
- **CD-8 (esperar min confirmaciones de hop 1 antes de hop 2):** `waitForTransactionReceipt({ hash, timeout: getEscrowReceiptTimeoutMs(), confirmations: resolveMinConfirmations(chainKey) })`.
- **CD-S1 (auto-blindaje 191a/189):** `biome check --write` sobre CADA archivo tocado (código + test + `database.types.ts`) antes del gate de wave. NUMERIC uint256 (`p_nonce`, `debit_amount_atomic`, `debit_nonce`) → tipar **`string`** en `database.types.ts`; leer con `BigInt(...)`, NUNCA `Number()`.
- **CD-S2 (auto-blindaje 189):** el `select` tipado a mano de `readValidDebitSignature` → `data as unknown as ValidDebitRow | null`.
- **CD-S3 (money-path):** re-validar `amount` firmado == monto a settlear y la ventana de `deadline` **ANTES** de cualquier `writeContract`. Mismatch → fallback, jamás debitar (no confiar en el revert del contrato como 1ª baranda).
- **CD-S4 (remap obligatorio):** tras hop 1 confirmado, si hop 2 falla con `failureKind==='unequivocal'`, **forzar** `failureKind:'ambiguous'` en el `SettleOutcome` devuelto (los fondos del buyer ya salieron on-chain → reembolsar off-chain = doble-crédito).
- **CD-S5 (nunca rechazar):** `settleEscrowAware` va envuelto en `try/catch` externo; cualquier throw inesperado (reader, executor, RPC) → fallback `return settlePaymentIntentOnChain(base)`. NUNCA rechazar la promise (espejo CD-7 del seam).
- **Ownership Guard (WKH-53/CD-6):** `readValidDebitSignature` filtra por `.eq('owner_ref', ownerRef)`; los 2 RPC hacen owner-guard DB-level (`OWNERSHIP_MISMATCH`).

### PROHIBIDO
- NO dependencias nuevas (viem/supabase ya presentes).
- NO tocar `contracts/` (CD-5). El evento `Debited` en `abi.ts` es la vista TS que ya converge con `WasiAIEscrow.sol:62` — solo se agrega al ABI TS, cero Solidity.
- NO tocar `src/services/arbiter.ts` ni ningún camino de disputa/override (CD-6).
- NO modificar `settlePaymentIntentOnChain` (el seam WKH-136, auditado) — debe quedar **byte-idéntico**. Solo se invoca internamente.
- NO agregar un `settle_outcome` nuevo ni tocar `finalize_payment_intent`/`record_settle_outcome` (RPC money-path auditados). reconciliation-pending se expresa con el `failed_ambiguous` EXISTENTE + evidencia en la fila de la firma.
- NO cambiar el accounting off-chain (`debitBuyer`/`increment/refund_a2a_key_spend`) — Scope OUT.
- NO tocar rutas (`src/routes/payments.ts`): el reader lee de DB, no del body.
- NO implementar el motor de reconciliación formal (job/alerting/drift budget-vs-escrowBalance) — es 191c.

## Test Expectations

| Test | ACs que cubre | Archivo | Tipo |
|------|--------------|---------|------|
| T-1 (happy path) | AC-1 | `payment-intent.test.ts` | unit |
| T-2 (flag OFF byte-idéntico) | AC-2 | `payment-intent.test.ts` | unit |
| T-2b (sin firma valid) | AC-2 | `debit-capture.test.ts` | unit |
| T-2c (amount mismatch) | AC-2/AC-7 | `debit-capture.test.ts` | unit |
| T-3 (hop 1 not_moved → fallback) | AC-3 | `payment-intent.test.ts` | unit |
| T-4 (hop 2 fail tras hop 1 → reconcile, remap) | AC-4 | `payment-intent.test.ts` | unit |
| T-4b (hop 1 ambiguous → reconcile sin refund) | AC-4 | `payment-intent.test.ts` | unit |
| T-5 (exactly-once: hop1 ya persistido) | AC-5 | `payment-intent.test.ts` | unit |
| T-6 (chain sin escrow → fallback) | AC-6 | `payment-intent.test.ts` | unit |
| T-7 (reader most-recent valid + record_debit_hop1 idempotente COALESCE) | AC-7 | `debit-capture.test.ts` | unit |
| T-8 (confirmations pasado + `Debited` no encontrado → ambiguous) | CD-8/§6 | `debit-executor.test.ts` | unit |
| T-9 (executor/reader lanza → settleEscrowAware cae al seam, no rechaza) | CD-S5 | `payment-intent.test.ts` | unit |
| T-10 (ownership: RPC con owner ajeno → RAISE) | Ownership | (documentar; unit sobre wrapper o SQL manual) | unit |
| T-11 (receipt reverted → not_moved → fallback; money-safe) | R-2 | `debit-executor.test.ts` | unit |

### Criterio Test-First
Lógica de negocio + money-path → **Test-first SÍ** para T-1..T-11. Framework: **vitest** (mismo que
`debit-capture.test.ts`/`payment-intent.test.ts`). Firmante = firma cruda persistida (fixture 191a);
mockear el viem wallet/public client (espejo del mock de `escrow-verifier.test.ts`).

---

## Waves

### Wave -1: Environment Gate (OBLIGATORIO — verificar antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
npm install 2>/dev/null || echo "Sin package.json"
# Archivos base del Scope IN deben existir:
ls src/services/payment-intent.ts \
   src/adapters/escrow/debit-capture.ts \
   src/adapters/escrow/abi.ts \
   src/adapters/escrow/eip712.ts \
   src/adapters/escrow-verifier.ts \
   src/adapters/deposit-verifier.ts \
   src/adapters/base/gasless.ts \
   src/types/database.types.ts \
   supabase/migrations/20260713000000_wkh191a_debit_signatures.sql \
   2>/dev/null || echo "FALTA archivo base — PARAR"
# Typecheck + tests baseline verdes ANTES de empezar:
npx tsc --noEmit 2>&1 | head -5
npx vitest run src/adapters/escrow src/services/payment-intent.test.ts 2>&1 | tail -15
```

**Si algo falla en Wave -1:** PARAR y reportar al orquestador. No implementar sobre entorno roto.

### Wave 0 (Serial Gate — migración + tipos + ABI; base de todo)

- [ ] **W0.1** Crear `supabase/migrations/20260713000001_wkh191b_debit_hop1.sql` con el SQL COMPLETO
  (columnas + índice + 2 RPC) y `..._down.sql`. **SQL exacto abajo.**
- [ ] **W0.2** `src/adapters/escrow/abi.ts`: agregar el evento `Debited` a `ESCROW_ABI` (aditivo).
- [ ] **W0.3** `src/types/database.types.ts`: 3 columnas nullable + 2 RPC. `biome check --write`.

**SQL exacto de W0.1** (`20260713000001_wkh191b_debit_hop1.sql`):

```sql
-- ============================================================
-- Migration: 20260713000001_wkh191b_debit_hop1
-- WKH-191b: consumo de la firma DebitAuthorization (two-hop settle). Extiende
-- ADITIVAMENTE la tabla de 191a con la evidencia del hop 1 ejecutado + el estado
-- del ciclo de vida del consumo. NO toca a2a_payment_intents ni sus RPC (wkh135),
-- NO toca capture_debit_signature (191a). NUNCA mueve dinero.
-- Patrón: 20260713000000_wkh191a_debit_signatures.sql.
-- ============================================================

BEGIN;

-- ── Columnas nullable aditivas (DT-9) ──
ALTER TABLE a2a_payment_intent_debit_signatures
  ADD COLUMN IF NOT EXISTS debit_hop1_tx_hash      TEXT,          -- tx de escrow.debit() (hop 1)
  ADD COLUMN IF NOT EXISTS debit_hop1_confirmed_at TIMESTAMPTZ,   -- confirmación on-chain de hop 1
  ADD COLUMN IF NOT EXISTS debit_settle_status     TEXT
    CHECK (debit_settle_status IS NULL OR
           debit_settle_status IN ('hop1_confirmed','settled','reconciliation_pending'));

-- Query de 191c: firmas con hop 1 movido pero settle no completado.
CREATE INDEX IF NOT EXISTS idx_debit_sig_settle_status
  ON a2a_payment_intent_debit_signatures (debit_settle_status)
  WHERE debit_settle_status IN ('hop1_confirmed','reconciliation_pending');

-- ============================================================
-- RPC: record_debit_hop1 (SECURITY DEFINER, owner-guarded, idempotente)
-- Persiste el tx hash de hop 1 ANTES de intentar hop 2 (BLQ-DR). Idempotente:
-- COALESCE → la 1ª escritura gana; un retry NO sobreescribe el hash. Devuelve el
-- hash EFECTIVO de la fila. NUNCA mueve dinero.
-- ============================================================
CREATE OR REPLACE FUNCTION record_debit_hop1(
  p_intent_id UUID,
  p_owner_ref TEXT,
  p_key_id    UUID,
  p_nonce     NUMERIC,
  p_tx_hash   TEXT
) RETURNS TABLE(persisted_tx_hash TEXT) AS $$
DECLARE
  v_owner TEXT;
  v_hash  TEXT;
BEGIN
  -- Ownership Guard DB-level (CD-6/WKH-53).
  SELECT owner_ref INTO v_owner
    FROM a2a_payment_intents
    WHERE id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;

  UPDATE a2a_payment_intent_debit_signatures
     SET debit_hop1_tx_hash      = COALESCE(debit_hop1_tx_hash, p_tx_hash),
         debit_hop1_confirmed_at = COALESCE(debit_hop1_confirmed_at, now()),
         debit_settle_status     = COALESCE(debit_settle_status, 'hop1_confirmed')
   WHERE key_id = p_key_id
     AND debit_nonce = p_nonce
     AND debit_validation_status = 'valid'
  RETURNING debit_hop1_tx_hash INTO v_hash;

  persisted_tx_hash := v_hash;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.record_debit_hop1(uuid, text, uuid, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.record_debit_hop1(uuid, text, uuid, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_debit_hop1(uuid, text, uuid, numeric, text)
  TO service_role;

-- ============================================================
-- RPC: record_debit_settle_status (SECURITY DEFINER, owner-guarded)
-- Flip terminal del ciclo de vida del consumo tras resolver hop 2. NO mueve dinero.
-- p_status ∈ ('settled','reconciliation_pending').
-- ============================================================
CREATE OR REPLACE FUNCTION record_debit_settle_status(
  p_intent_id UUID,
  p_owner_ref TEXT,
  p_key_id    UUID,
  p_nonce     NUMERIC,
  p_status    TEXT
) RETURNS void AS $$
DECLARE
  v_owner TEXT;
BEGIN
  IF p_status NOT IN ('settled','reconciliation_pending') THEN
    RAISE EXCEPTION 'INVALID_SETTLE_STATUS: %', p_status;
  END IF;

  SELECT owner_ref INTO v_owner
    FROM a2a_payment_intents
    WHERE id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;

  UPDATE a2a_payment_intent_debit_signatures
     SET debit_settle_status = p_status
   WHERE key_id = p_key_id
     AND debit_nonce = p_nonce
     AND debit_validation_status = 'valid';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.record_debit_settle_status(uuid, text, uuid, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.record_debit_settle_status(uuid, text, uuid, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_debit_settle_status(uuid, text, uuid, numeric, text)
  TO service_role;

COMMIT;
```

**SQL exacto de W0.1 down** (`20260713000001_wkh191b_debit_hop1_down.sql`):

```sql
-- ============================================================
-- Down: 20260713000001_wkh191b_debit_hop1
-- Revierte SOLO lo de 191b. No destruye datos de 191a (la tabla persiste; solo
-- se dropean las 3 columnas aditivas + el índice + los 2 RPC).
-- ============================================================

BEGIN;
DROP FUNCTION IF EXISTS record_debit_settle_status(uuid, text, uuid, numeric, text);
DROP FUNCTION IF EXISTS record_debit_hop1(uuid, text, uuid, numeric, text);
DROP INDEX IF EXISTS idx_debit_sig_settle_status;
ALTER TABLE a2a_payment_intent_debit_signatures
  DROP COLUMN IF EXISTS debit_settle_status,
  DROP COLUMN IF EXISTS debit_hop1_confirmed_at,
  DROP COLUMN IF EXISTS debit_hop1_tx_hash;
COMMIT;
```

**Evento `Debited` de W0.2** (agregar al array `ESCROW_ABI` en `abi.ts`, junto a los demás items):

```ts
{
  type: 'event',
  name: 'Debited',
  inputs: [
    { name: 'keyId', type: 'bytes32', indexed: true },
    { name: 'operator', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'nonce', type: 'uint256', indexed: false },
  ],
  anonymous: false,
},
```

**Tipos de W0.3** (`database.types.ts`, tabla `a2a_payment_intent_debit_signatures`):
- Row: agregar `debit_hop1_tx_hash: string | null`, `debit_hop1_confirmed_at: string | null`, `debit_settle_status: string | null`.
- Insert/Update: los 3 como `?: string | null`.
- `Functions`: `record_debit_hop1` (Args: `{ p_intent_id: string; p_owner_ref: string; p_key_id: string; p_nonce: string; p_tx_hash: string }`, Returns: `{ persisted_tx_hash: string | null }[]`) y `record_debit_settle_status` (Args: `{ p_intent_id: string; p_owner_ref: string; p_key_id: string; p_nonce: string; p_status: string }`, Returns: `undefined`/`void`). **`p_nonce: string`** (NUMERIC uint256, CD-S1).

**Verificación W0:** `npx tsc --noEmit` pasa; `biome check --write` sobre los 2 archivos TS tocados.

### Wave 1 (reader de la firma valid — depende de W0)

- [ ] **W1.1** `src/adapters/escrow/debit-capture.ts` (Archivo #5): agregar (sin tocar lo existente):
  - `export function isEscrowSettleEnabled(): boolean { return process.env.ESCROW_SETTLE_ENABLED === 'true' && isDebitCaptureEnabled(); }`
  - `export interface ValidDebitRow { debit_signature: string; debit_amount_atomic: string; debit_deadline: number; debit_nonce: string; debit_key_id_hash: string; debit_hop1_tx_hash: string | null; debit_settle_status: string | null; }`
  - `export async function readValidDebitSignature(args: { intentId: string; ownerRef: string; chainKey: ChainKey; finalAmountUsd: number }): Promise<ValidDebitRow | null>` — Exemplar 3. Devuelve la fila o `null` (→ fallback) si: no hay fila, amount-mismatch, o deadline fuera de ventana. **NUNCA lanza** (envolver en try/catch → `null` — CD-S5 defensa en profundidad; el caller también lo envuelve).
  - **NOTA:** `debit_deadline` es `BIGINT` → en `database.types.ts` es `number`; leer con `BigInt(row.debit_deadline)`. `debit_amount_atomic`/`debit_nonce` son `NUMERIC` → `string` → `BigInt(...)`.

**Verificación W1:** `npx tsc --noEmit` + `npx vitest run debit-capture.test.ts` (T-2b, T-2c, T-7 verdes). `biome check --write`.

### Wave 2 (ejecutor hop 1 — depende de W0.2, paraleliza con W1)

- [ ] **W2.1** Crear `src/adapters/escrow/debit-executor.ts` (Archivo #6) — Exemplar 1 + 2:
  - `getEscrowWalletClient(chainKey)` / `getEscrowPublicClient(chainKey)` — cache `Map<ChainKey, ...>`, PK desde `OPERATOR_PRIVATE_KEY`, `resolveChainObject`/`resolveRpcUrl`/`resolveRpcFallbackEnv`/`buildRpcTransport`. Sin PK / sin RPC → el executor devuelve `not_moved` (no lanzar).
  - `getEscrowReceiptTimeoutMs()` — env `ESCROW_DEBIT_RECEIPT_TIMEOUT_MS`, default `60_000`, parse `>0` (patrón `gasless.ts:229-232`).
  - `_resetDebitExecutor()` — TEST-ONLY, limpia ambos caches (patrón `_resetEscrowVerifier`).
  - `executeDebitHop1(args: { chainKey: ChainKey; escrowContract: \`0x${string}\`; keyIdHash: string; amount: bigint; deadline: bigint; nonce: bigint; signature: string }): Promise<Hop1Outcome>` donde:
    ```ts
    type Hop1Outcome =
      | { kind: 'confirmed'; txHash: \`0x${string}\`; blockNumber: bigint }
      | { kind: 'not_moved'; reason: string; txHash?: \`0x${string}\` }
      | { kind: 'ambiguous'; reason: string; txHash?: \`0x${string}\` };
    ```
    Pasos §6 del SDD: (1) wallet/public o `not_moved:'OPERATOR_KEY_OR_RPC_UNSET'`; (2) `writeContract debit` en try/catch → catch = `not_moved` (pre-broadcast, AC-3); (3) `waitForTransactionReceipt({ hash, timeout, confirmations: resolveMinConfirmations(chainKey) })` en try/catch → catch = `ambiguous:'RECEIPT_TIMEOUT'` + txHash; (4) `receipt.status !== 'success'` → `not_moved:'REVERTED'` + txHash; (5) escanear `receipt.logs` por el evento `Debited` del escrow (Exemplar 2) → no encontrado = `ambiguous:'DEBITED_EVENT_NOT_FOUND'`; (6) `confirmed`.
  - `recordDebitHop1(args: { intentId; ownerRef; keyId; nonce: string; txHash })` → `supabase.rpc('record_debit_hop1', { p_intent_id, p_owner_ref, p_key_id, p_nonce, p_tx_hash })`; devolver `data?.[0]?.persisted_tx_hash`.
  - `recordDebitSettleStatus(args: { intentId; ownerRef; keyId; nonce: string; status: 'settled' | 'reconciliation_pending' })` → `supabase.rpc('record_debit_settle_status', {...})`.
  - **`DEBITED_EVENT`**: derivar del ABI, NUNCA hardcodear topic0. Ej: `const DEBITED_EVENT = ESCROW_ABI.find(i => i.type === 'event' && i.name === 'Debited')` o `parseAbiItem('event Debited(bytes32 indexed keyId, address indexed operator, uint256 amount, uint256 nonce)')`.

**Verificación W2:** `npx tsc --noEmit` + `npx vitest run debit-executor.test.ts` (T-8, T-11). `biome check --write`.

### Wave 3 (wiring del two-hop en el service — depende de W1, W2)

- [ ] **W3.1** `src/services/payment-intent.ts` (Archivo #7): agregar `settleEscrowAware` + reemplazar los 2 call-sites.
  - **Firma:** `async function settleEscrowAware(params: { intentId: string; ownerRef: string; payTo: string; finalAmountUsd: number; chainId: number; keyId: string }): Promise<SettleOutcome>`.
  - `const base = { intentId, ownerRef, payTo, finalAmountUsd, chainId }` (los params EXACTOS del seam).
  - **Cuerpo (todo dentro de un try/catch externo → `catch { return settlePaymentIntentOnChain(base); }` — CD-S5):**
    0. `if (!isEscrowSettleEnabled()) return settlePaymentIntentOnChain(base);` **1ª línea, fast-path** (CD-1/CD-2/AC-2).
    1. `const chainKey = getDefaultChainKey(); if (!chainKey) return settlePaymentIntentOnChain(base); const escrowContract = resolveEscrowContract(chainKey); if (!escrowContract) return settlePaymentIntentOnChain(base);` (AC-6).
    2. `const row = await readValidDebitSignature({ intentId, ownerRef, chainKey, finalAmountUsd }); if (!row) return settlePaymentIntentOnChain(base);` (AC-2/AC-7 — el reader ya re-validó amount/deadline).
    3. **Exactly-once:** `if (row.debit_hop1_tx_hash) { /* hop 1 ya ejecutado → skip, ir a hop 2 */ }` else ejecutar hop 1 (paso 4).
    4. **Hop 1:** `const o1 = await executeDebitHop1({ chainKey, escrowContract, keyIdHash: row.debit_key_id_hash, amount: BigInt(row.debit_amount_atomic), deadline: BigInt(row.debit_deadline), nonce: BigInt(row.debit_nonce), signature: row.debit_signature });`
       - `o1.kind === 'not_moved'` → `return settlePaymentIntentOnChain(base);` (fallback, cero evidencia — AC-3).
       - `o1.kind === 'ambiguous'` → `await recordDebitSettleStatus({ intentId, ownerRef, keyId, nonce: row.debit_nonce, status:'reconciliation_pending' });` (+ `recordDebitHop1` con el tx tentativo si `o1.txHash` existe); `return { status:'failed', txHash:null, finalAmountUsd, failureKind:'ambiguous', error: 'RECONCILE-ESCROW: hop1 ambiguous ('+o1.reason+')' };` (CD-4, sin hop 2).
       - `o1.kind === 'confirmed'` → `await recordDebitHop1({ intentId, ownerRef, keyId, nonce: row.debit_nonce, txHash: o1.txHash });` **ANTES** de hop 2 (BLQ-DR/CD-3), luego seguir a paso 5.
    5. **Hop 2 (seam sin cambios):** `const o2 = await settlePaymentIntentOnChain(base);`
       - `o2.status === 'settled'` → `await recordDebitSettleStatus({..., status:'settled' });` `return o2;` (happy path, seller cobró).
       - `o2.status === 'failed'` (unequivocal O ambiguous) → `await recordDebitSettleStatus({..., status:'reconciliation_pending' });` `return { status:'failed', txHash:null, finalAmountUsd, failureKind:'ambiguous', error: 'RECONCILE-ESCROW: hop1='+row.debit_hop1_tx_hash_efectivo+' hop2-failed: '+(o2.error ?? 'unknown') };` **remap unequivocal→ambiguous (CD-S4)** — NUNCA refund.
       - (Si `o2.status === 'in_progress'` — no ocurre en el path de settle real, pero por robustez → `return o2;` sin marcar reconcile.)
  - **Reemplazo call-site closeSession (:727-733):** `const outcome = await settleEscrowAware({ intentId, ownerRef, payTo: row.pay_to, finalAmountUsd: finalUsd, chainId: row.chain_id, keyId: row.key_id });` — el resto de closeSession (:735-836) **SIN CAMBIOS**.
  - **Reemplazo call-site settleUpto (:1063-1069):** idéntico, `finalAmountUsd: finalUsd`, `keyId: row.key_id`, `chainId: row.chain_id`. El resto (:1071-1162) **SIN CAMBIOS**.
  - `settlePaymentIntentOnChain` (:347-463) **NO se toca** (byte-idéntico, DT-7).

**Verificación W3:** `npx tsc --noEmit` + `npx vitest run payment-intent.test.ts` (T-1, T-2, T-3, T-4, T-4b, T-5, T-6, T-9). `biome check --write`.

### Verificación Incremental

| Wave | Verificación al completar |
|------|--------------------------|
| W0 | `tsc --noEmit` + `biome check --write` |
| W1 | `tsc` + `vitest run debit-capture.test.ts` + `biome` |
| W2 | `tsc` + `vitest run debit-executor.test.ts` + `biome` |
| W3 | `tsc` + `vitest run` full (los 3 archivos de test) + `biome` |

---

## Detalle de tests (setup exacto)

- **T-1 (AC-1 happy path):** `ESCROW_SETTLE_ENABLED='true'`, `ESCROW_DEBIT_CAPTURE_ENABLED='true'`; mock `readValidDebitSignature` → fila `valid` sin `debit_hop1_tx_hash`; mock `executeDebitHop1` → `{ kind:'confirmed', txHash:'0xhop1', blockNumber:1n }`; mock `settlePaymentIntentOnChain` → `{ status:'settled', txHash:'0xhop2' }`. Assert: `recordDebitHop1` llamado **ANTES** de `settlePaymentIntentOnChain` (spy call order); `recordDebitSettleStatus('settled')` llamado; `outcome.txHash === '0xhop2'`.
- **T-2 (AC-2 flag OFF):** `ESCROW_SETTLE_ENABLED` unset. Assert: `settleEscrowAware` retorna el resultado del seam en la 1ª línea; `readValidDebitSignature` **NUNCA** llamado (0 lecturas DB); `executeDebitHop1` **NUNCA** llamado; outcome === baseline.
- **T-2b (AC-2 sin firma):** flag ON, escrow OK, `readValidDebitSignature` → `null`. Assert: fallback al seam; `executeDebitHop1` nunca llamado.
- **T-2c (AC-2/AC-7 amount mismatch):** en `debit-capture.test.ts`: fila `valid` con `debit_amount_atomic` != `parseUnits(finalUsd, decimals)` → `readValidDebitSignature` retorna `null`. Assert: sin hop 1.
- **T-3 (AC-3 not_moved):** `executeDebitHop1` → `{ kind:'not_moved', reason:'REVERTED' }`. Assert: `settleEscrowAware` retorna el seam; `recordDebitSettleStatus`/`recordDebitHop1` **NUNCA** llamados; settle completa como HOY.
- **T-4 (AC-4 hop2 fail):** hop1 → confirmed (recordDebitHop1 ok); seam → `{ status:'failed', failureKind:'unequivocal', error:'settle failed' }`. Assert: outcome `failureKind === 'ambiguous'` (**remap**), `error` empieza con `'RECONCILE-ESCROW:'`, `recordDebitSettleStatus('reconciliation_pending')` llamado. Verificar en el caller (closeSession) que se invoca `finalize` con `'failed_ambiguous'` (NO `'failed_unequivocal'`) → **NO refund** (spy sobre `finalizePaymentIntent`).
- **T-4b (AC-4 hop1 ambiguous):** `executeDebitHop1` → `{ kind:'ambiguous', reason:'RECEIPT_TIMEOUT', txHash:'0xhop1' }`. Assert: seam (hop 2) **NUNCA** llamado; `recordDebitSettleStatus('reconciliation_pending')` llamado; outcome `failureKind:'ambiguous'`, `error` `'RECONCILE-ESCROW: hop1 ambiguous (RECEIPT_TIMEOUT)'`; sin refund.
- **T-5 (AC-5 exactly-once):** fila `valid` con `debit_hop1_tx_hash='0xhop1'` ya seteado. Assert: `executeDebitHop1` **NUNCA** llamado; va directo al seam; en `settled` → `recordDebitSettleStatus('settled')`.
- **T-6 (AC-6 chain sin escrow):** `resolveEscrowContract` mock → `null` (default kite). Assert: fallback al seam sin importar el flag; cero hop 1.
- **T-7 (AC-7 reader + idempotencia):** en `debit-capture.test.ts`: verificar que el query usa `WHERE debit_validation_status='valid' ORDER BY captured_at DESC LIMIT 1` + `.eq('owner_ref', ownerRef)`. Idempotencia RPC: documentar que `record_debit_hop1` con COALESCE no sobreescribe (2ª llamada retorna el hash existente — puede ser test de integración SQL o assert sobre el wrapper con mock del RPC devolviendo el mismo hash).
- **T-8 (CD-8 confirmations + evento):** en `debit-executor.test.ts`: mock public client; assert `waitForTransactionReceipt` recibió `confirmations: resolveMinConfirmations(chainKey)`; receipt `status:'success'` **sin** log `Debited` → `{ kind:'ambiguous', reason:'DEBITED_EVENT_NOT_FOUND' }`.
- **T-9 (CD-S5 no rechaza):** mock `readValidDebitSignature` o `executeDebitHop1` que **lanza**. Assert: `settleEscrowAware` NO rechaza; cae al seam; `closeSession` retorna `SettleOutcome` normal.
- **T-10 (Ownership):** `record_debit_hop1`/`record_debit_settle_status` con `p_owner_ref` ajeno → RAISE `OWNERSHIP_MISMATCH`. (Test de integración SQL, o documentar como cubierto por el guard idéntico a `capture_debit_signature` ya testeado en 191a.)
- **T-11 (R-2 narrow window):** en `debit-executor.test.ts`: receipt `status:'reverted'` (simula `NonceAlreadyUsed`) → `{ kind:'not_moved', reason:'REVERTED' }`. Assert: `settleEscrowAware` cae al seam. Comentar en el test la money-safety (operador nets zero).

---

## Out of Scope

- `contracts/` (cualquier `.sol` — CD-5). El evento `Debited` va SOLO al ABI TS (`abi.ts`).
- `src/services/arbiter.ts` / cualquier disputa/override (CD-6).
- `src/routes/payments.ts` (el reader lee de DB, no del body; 191a ya persiste los campos `debit*`).
- `settlePaymentIntentOnChain` (:347-463) — **byte-idéntico**, solo se invoca.
- `finalize_payment_intent` / `record_settle_outcome` (RPC money-path auditados) — reconciliation-pending usa el `failed_ambiguous` existente.
- Accounting off-chain: `debitBuyer`, `increment_a2a_key_spend`, `refund_a2a_key_spend`, `openSession`, `addVoucher`.
- Motor de reconciliación formal / drift-alerting / resolución automática de `reconciliation_pending` / `withdraw()` → **191c**.
- Config/deploy del escrow o verificación `OPERATOR_PRIVATE_KEY == _operator` on-chain → **191d**.
- NO "mejorar" código adyacente. NO agregar funcionalidad no listada.

## Notas heredadas del SDD (contexto money-safety)

- **R-1 / MI-1 (NO bloquea el código, SÍ la activación end-to-end):** el seam WKH-136 usa `usdToWei` (18d hardcodeado, `payment-intent.ts:145-149`); el escrow vive en Base Sepolia (USDC 6d). En un default-chain Base, hop 2 no converge → `settle.success===false` → reconciliation-pending. **191b es money-safe igual** (nunca paga mal ni reembolsa indebido). Hacer el seam decimals-aware está FUERA de 191b (DT-5/CD-2). NO intentar arreglarlo acá.
- **R-2 (narrow window, money-safe):** hop 1 confirmado pero crash antes de `record_debit_hop1` → retry re-intenta hop 1 → revert `NonceAlreadyUsed` → `not_moved` → fallback; el operador ya recibió los fondos en hop 1 ⇒ nets zero. 191c reconcilia. No-destructivo.
- **R-4 (inerte hasta 191d):** con `OPERATOR_PRIVATE_KEY ≠ _operator`, todo `debit()` revierte `NotOperator` → `not_moved` → fallback siempre. 191b queda correcto e inerte.

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala a Architect.** No inventar, no asumir, no improvisar.

Situaciones de escalation:
- `database.types.ts` no tiene la estructura de tabla/funciones esperada para extender.
- `resolveChainObject`/`resolveRpcUrl`/`resolveRpcFallbackEnv`/`resolveMinConfirmations`/`buildRpcTransport` no están exportadas donde el SDD dice (`deposit-verifier.ts`).
- `decodeEventLog` sobre el evento `Debited` no matchea el shape del contrato.
- El caller (closeSession/settleUpto) necesita cambios fuera del call-site único → PARAR (rompería el byte-idéntico).
- Ambigüedad en un AC o en la clasificación de una rama del two-hop.

---

*Story File generado por NexusAgil — F2.5*
