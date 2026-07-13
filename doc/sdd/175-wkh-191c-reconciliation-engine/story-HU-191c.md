# Story File — HU WKH-191c · Motor de reconciliación (`reconciliation_pending` + drift budget-vs-escrow)

> **Contrato autocontenido para el Dev (F3).** El Dev SOLO lee este archivo. Si algo no
> está acá, no se hace. Deriva de `doc/sdd/175-wkh-191c-reconciliation-engine/sdd.md`
> (SPEC_APPROVED). Anclas de línea verificadas contra el código a la fecha 2026-07-13.
>
> - Epic: WKH-191 (fila 172) · Wave 0 del epic · depende de 191a (fila 173) + 191b (fila 174, código DONE / PENDING-DEPLOY).
> - Branch: `feat/191c-reconciliation-engine`
> - Tipo: feature money-path / security · Testnet-only · flag-gated `ESCROW_SETTLE_ENABLED`.

---

## 1. Contexto compacto (qué se construye y por qué)

191b deja intents "colgados" en
`a2a_payment_intent_debit_signatures.debit_settle_status = 'reconciliation_pending'`
(o el huérfano `'hop1_confirmed'`) cuando el **hop 1** (`escrow.debit`, buyer→operador)
se confirmó o quedó ambiguo on-chain pero el **hop 2** (operador→seller) falló. Es una
**doble-contabilización temporal money-safe**: el buyer quedó debitado off-chain (budget)
y NO se le reembolsó.

191c es el **motor de reconciliación**. Por-intent, y **tras re-verificar on-chain** la
realidad del hop 1 (evento `Debited`), resuelve **EXACTAMENTE UN LADO** — nunca ambos,
nunca ninguno — de forma **idempotente**:

- `Debited` **confirmed** (operador custodia los fondos) → reintenta el **hop 2** al seller
  → `resolved_settled`. NO reembolsa el budget.
- `Debited` **not_confirmed** (el escrow del buyer está intacto on-chain) → **refund
  BUDGET-ONLY** (`refund_a2a_key_spend`, sin transfer on-chain, sin tocar `escrowBalance`)
  → `resolved_refunded`. El buyer retira su escrow por su propia ruta `withdraw` (es el `_depositor`).
- `Debited` **indeterminate** (RPC caído / hash null) → **abort**: no mueve dinero, queda pending.

Agrega además **detección de drift (solo reporte)** entre `budget` off-chain y
`escrowBalance(keyId)` on-chain. El trigger son 2 endpoints admin-gated bajo `/dashboard`
(patrón WKH-189): un `GET` read-only y un `POST` **fail-closed** money-moving.

**Cero cambios a `contracts/` y a `arbiter.ts`.**

---

## 2. Scope IN (lista exhaustiva de archivos a tocar)

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `supabase/migrations/20260713000002_wkh191c_reconciliation.sql` | Crear | W0 |
| 2 | `supabase/migrations/20260713000002_wkh191c_reconciliation_down.sql` | Crear | W0 |
| 3 | `src/types/database.types.ts` | Modificar (agregar 2 entradas RPC) | W0 |
| 4 | `src/adapters/escrow/reconciler-onchain.ts` | Crear | W1 |
| 5 | `src/adapters/escrow/reconciler-onchain.test.ts` | Crear | W1 |
| 6 | `src/services/reconciliation.ts` | Crear | W2 |
| 7 | `src/services/reconciliation.test.ts` | Crear | W2 |
| 8 | `src/routes/dashboard.ts` | Modificar (2 endpoints + `requireAdminTokenStrict`) | W3 |
| 9 | `src/routes/dashboard.test.ts` | Modificar (agregar tests AC-1/AC-8/AC-9) | W3 |

**PROHIBIDO tocar cualquier archivo fuera de esta lista.** En particular: NO `contracts/`,
NO `src/services/arbiter.ts`, NO los RPC de wkh135/191a/191b, NO el seam decimals-aware
(`usdToWei`, WKH-192).

**Scope OUT:** árbitro/disputa, decimals seam WKH-192, activación en prod (191d),
cron/scheduler (191d), corrección automática del budget, alerting Discord (solo response +
`log.warn`), chains nuevas (solo Base Sepolia default chain).

---

## 3. Anti-Hallucination Checklist (específico de esta HU)

Verificado con Read/Glob antes de escribir este contrato. El Dev NO debe inventar nada fuera de esto:

- [x] `settlePaymentIntentOnChain({intentId,ownerRef,payTo,finalAmountUsd,chainId}) → Promise<SettleOutcome>` existe en `src/services/payment-intent.ts:355`. NUNCA rechaza; `SettleOutcome.status ∈ {'settled','failed','in_progress'}` con `txHash|null`, `failureKind?: 'unequivocal'|'ambiguous'`. **Reusar tal cual para el hop2 retry.**
- [x] `refund_a2a_key_spend(p_key_id UUID, p_chain_id INT, p_amount_usd NUMERIC, p_owner_ref TEXT) RETURNS INT` (filas afectadas; owner-guard `FOR UPDATE`; no-op si `≤0`) → `supabase/migrations/20260625000000_wkh_audit_a2_refund_rows_affected.sql:30`. Entrada en `database.types.ts:3168` (`Returns: number`). **El refund vive DENTRO de `record_reconciliation_resolution`, no en el service TS.**
- [x] `verifyDefaultChainSettle({txHash,payTo,requiredAmountAtomic}) → Promise<SettleVerification>` en `src/adapters/settle-verifier.ts:360`. `SettleVerification = { ok: boolean; reason?; warn?: boolean }` (`settle-verifier.ts:46-78`). Testnet fail-OPEN (`ok:true,warn:true`) / mainnet fail-CLOSED (`ok:false,warn:true`). **Para el crash-recovery.**
- [x] `resolveEscrowContract(chainKey) → 0x…|null` en `src/adapters/escrow-verifier.ts:94` (lee `A2A_ESCROW_CONTRACT_<FAMILY>`).
- [x] `getDefaultChainKey() → ChainKey|null` en `src/adapters/registry.ts:258`. `getAdaptersBundle(chainKey)` en `src/adapters/registry.ts:237` (para `supportedTokens[0].decimals`).
- [x] `isEscrowSettleEnabled() → boolean` en `src/adapters/escrow/debit-capture.ts:69`. **Gate de toda acción money-moving.**
- [x] `ESCROW_ABI` (`Deposited`, `Debited`, `debit`, `escrowBalance(bytes32)→uint256 view`) en `src/adapters/escrow/abi.ts:19-71`. topic0 derivado por viem (`parseAbiItem`/`decodeEventLog`), **NUNCA literal**.
- [x] Patrón log-scan de `Debited` verificado en `src/adapters/escrow/debit-executor.ts:200-234`: filtro `logEntry.address.toLowerCase()===escrowLc` + `decodeEventLog` de `parseAbiItem('event Debited(bytes32 indexed keyId,address indexed operator,uint256 amount,uint256 nonce)')` + match `decoded.args.keyId.toLowerCase()===keyIdHash.toLowerCase() && decoded.args.nonce===nonce`.
- [x] Patrón public-client cacheado per-ChainKey verificado en `escrow-verifier.ts:105-118` (`_clients` Map + `getEscrowClient`) y `debit-executor.ts:102-118`. `_resetEscrowVerifier()` / `_resetDebitExecutor()` para tests.
- [x] `requireAdminToken` (opt-in, timing-safe, prod fail-closed 503) en `src/routes/dashboard.ts:59-89`. Endpoints admin: `GET /api/arbitrations/holds` (`dashboard.ts:176`) + `POST /api/arbitrations/:intentId/resolve` (`dashboard.ts:202`, `fastify.post<{Params:{intentId:string}}>`). Montado con `prefix:'/dashboard'`.
- [x] Migración base 191b: `supabase/migrations/20260713000001_wkh191b_debit_hop1.sql`. CHECK inline de `debit_settle_status` en línea 16-18 con 3 valores `('hop1_confirmed','settled','reconciliation_pending')`; índice `idx_debit_sig_settle_status` (línea 21); RPCs owner-guarded `FOR UPDATE` sobre `a2a_payment_intents` (líneas 43-52, 95-104) con hardening `search_path`+REVOKE/GRANT.
- [x] `WasiAIEscrow.sol`: `withdraw` exige `msg.sender==_depositor[keyId]` (línea 189) → operador NO puede refundar on-chain (confirma refund budget-only). `escrowBalance=_balances[keyId]` (línea 116-117, 6 dec). `Debited(keyId,operator,amount,nonce)` (línea 62). `keyId` on-chain = `keccak256(stringToBytes(key_id))`.
- [x] Columnas de `a2a_payment_intent_debit_signatures` disponibles: `intent_id`, `owner_ref`, `key_id`, `debit_key_id_hash`, `debit_amount_atomic NUMERIC(78,0)`, `debit_nonce NUMERIC(78,0)`, `debit_signer_recovered`, `debit_hop1_tx_hash`, `debit_settle_status`, `debit_validation_status`. `a2a_payment_intents`: `id`, `owner_ref`, `key_id`, `pay_to` (seller), `chain_id`.
- [x] **NUMERIC uint256 (`debit_amount_atomic`, `debit_nonce`) SIEMPRE `string`/`BigInt`, NUNCA `number`** (>2^53). En `database.types.ts` los params NUMERIC uint256 van como `string` (aprendizaje WKH-191a; ver `record_debit_hop1` `p_nonce:string` en `database.types.ts:2784`).
- [x] Generic de Fastify va en `.get/post<>()`, NUNCA en el `request` (WKH-189).
- [x] **Aprendizaje WKH-191b (auto-blindaje CR MNR-1): PROHIBIDO `expect(true).toBe(true)` como cobertura falsa.** Integraciones SQL no simulables (transición condicional del CHECK, refund status-gated dentro del RPC, owner-guard `FOR UPDATE`) se documentan como **integración explícita pendiente** (comentario honesto), NO se tautologizan. Toda cross-reference a otro test se verifica con `grep` antes de commitear.

---

## 4. Constraint Directives (inline, INVIOLABLES)

### OBLIGATORIO

- **CD-1 (EXACTLY-ONE-SIDE)** — un intent resuelve hop2 **XOR** refund, nunca ambos ni ninguno. Enforcement: columna `debit_settle_status` single-valued + CHECK + transición gated (`resolved_settled` ⇐ SOLO desde `resolving_settle`; `resolved_refunded` ⇐ SOLO desde `resolving_refund`).
- **CD-2 (IDEMPOTENCIA / BLQ-DR)** — el estado terminal se persiste ATÓMICAMENTE con el money side-effect off-chain (el refund del budget vive DENTRO de `record_reconciliation_resolution`, status-gated) → retry = no-op. La idempotencia NO puede apoyarse en el nonce EIP-3009 del hop2/refund (es aleatorio) → se apoya en el state-machine DB (`resolving_*`→`resolved_*`) + re-verificación de `debit_resolution_tx_hash` antes de re-enviar on-chain.
- **CD-3 (RE-VERIFICACIÓN ON-CHAIN PREVIA)** — decidir el lado SOLO tras `reverifyDebitedByTxHash`. `indeterminate` → **abort** (nunca decidir sobre incertidumbre). Nunca decidir sobre el `debit_settle_status` persistido (puede ser tentativo).
- **CD-4 (LIBRO AUTORITATIVO ON-CHAIN, sin autocorrección)** — `escrowBalance` es fuente de verdad para el drift; **SOLO reportar, nunca sobrescribir `budget`**.
- **CD-8 (OWNERSHIP GUARD, WKH-53)** — todo RPC/query nuevo filtra por `owner_ref`. El refund usa el `owner_ref` **REAL leído de la fila del intent**, NUNCA asumido por el caller admin. Los RPCs nuevos hacen `FOR UPDATE` sobre `a2a_payment_intents` + comparan `owner_ref` (espejo 191b).
- **Patrón viem/DB** — `parseAbiItem`/`decodeEventLog`/`ESCROW_ABI` (topic0 derivado, NUNCA literal); public-client cacheado per-ChainKey; NUMERIC uint256 SIEMPRE `string`/`BigInt`.
- **Hardening RPC** — en ambos RPCs nuevos: `SET search_path=public,pg_temp` + `REVOKE ... FROM PUBLIC,anon,authenticated` + `GRANT ... TO service_role` (espejo 191b).

### PROHIBIDO

- **CD-5** — NO tocar `contracts/` ni `arbiter.ts`/lógica de disputa.
- **CD-6 (FLAG-GATED MONEY-MOVING)** — NO ejecutar hop2-retry ni refund con `ESCROW_SETTLE_ENABLED` OFF; el `GET` read-only SÍ corre.
- **CD-7 (ADMIN-GATED FAIL-CLOSED)** — NO exponer el `POST` money-moving sin `X-Admin-Token`; fail-closed (503 si env unset, dev Y prod).
- **NO `withdraw()`** del contrato para el refund (imposible: exige `_depositor`).
- **NO transfer on-chain operador→buyer en el lado refund** (budget-only; sería doble-pago + pérdida del operador — DT-R4/NC-1). El refund SOLO acredita el budget off-chain. **El caso `Debited='confirmed'` siempre va a hop2, nunca a refund.**
- **NO usar `settleEscrowAware` para el hop2-retry** (re-lee la firma cuyo deadline caduca a 1h + escribe `debit_settle_status='settled'` fuera del state-machine de 191c). Usar el seam `settlePaymentIntentOnChain` **directo** (DT-R2). *Desviación de la letra del work-item — el Adversary debe verla.*
- **NO recomputar/corregir** el `budget` agregado desde `escrowBalance` (solo reporte).
- **NO agregar scheduler/cron in-proceso** (el endpoint es el deliverable; cron externo = 191d).
- **NO agregar dependencias nuevas; NO modificar** los RPC de wkh135/191a/191b existentes.
- **NO `expect(true).toBe(true)`** como cobertura (auto-blindaje 191b).

---

## 5. State-machine de `debit_settle_status` (columna single-valued → mutua exclusión, AC-6)

```
              (191b)                         (191c)
 hop1_confirmed ─┐                    ┌─► resolving_settle ─► resolved_settled
                 ├─(claim, decide)────┤
 reconciliation_pending ─┘            └─► resolving_refund ─► resolved_refunded
        settled  (terminal happy-path 191b — 191c NO lo toca)
```

- `confirmed` (on-chain) → lado **settle**.
- `not_confirmed` → lado **refund** (budget-only).
- `indeterminate` → **abort**, queda pending.

---

## 6. Waves (archivos exactos por wave)

### W0 (Serial Gate) — contrato de datos

#### W0.1 — `supabase/migrations/20260713000002_wkh191c_reconciliation.sql`

SQL completo (exemplar `..._wkh191b_debit_hop1.sql`). Additive; filas existentes intactas.

```sql
-- ============================================================
-- Migration: 20260713000002_wkh191c_reconciliation
-- WKH-191c: motor de reconciliación. Extiende ADITIVAMENTE la tabla de 191a/191b
-- con el state-machine de resolución (resolving_* / resolved_*), 2 columnas de
-- evidencia de la resolución, un índice parcial de resoluciones colgadas, y 2 RPCs
-- SECURITY DEFINER owner-guarded (claim atómico + flip terminal money-atomic con el
-- refund del budget DENTRO del RPC, status-gated). NO toca contracts/, NO toca los
-- RPC de wkh135/191a/191b. El refund es BUDGET-ONLY (nunca mueve fondos on-chain).
-- Patrón: 20260713000001_wkh191b_debit_hop1.sql.
-- ============================================================

BEGIN;

-- ── 1. Widen CHECK de debit_settle_status (3 → 7 valores) ──
-- VERIFY-AT-IMPL (R-5): el nombre auto-generado del CHECK inline de 191b es
-- <tabla>_<col>_check (convención Postgres). Confirmar con `\d
-- a2a_payment_intent_debit_signatures` en dev que el DROP CONSTRAINT matchea el
-- nombre real; el IF EXISTS evita el fallo pero también un no-op silencioso — tras
-- aplicar, verificar que un UPDATE a 'resolving_settle' NO es rechazado por el CHECK.
ALTER TABLE a2a_payment_intent_debit_signatures
  DROP CONSTRAINT IF EXISTS a2a_payment_intent_debit_signatures_debit_settle_status_check;
ALTER TABLE a2a_payment_intent_debit_signatures
  ADD  CONSTRAINT a2a_payment_intent_debit_signatures_debit_settle_status_check
  CHECK (debit_settle_status IS NULL OR debit_settle_status IN
    ('hop1_confirmed','settled','reconciliation_pending',
     'resolving_settle','resolving_refund','resolved_settled','resolved_refunded'));

-- ── 2. Columnas nullable aditivas (evidencia de la resolución) ──
ALTER TABLE a2a_payment_intent_debit_signatures
  ADD COLUMN IF NOT EXISTS debit_resolution_tx_hash TEXT,        -- tx del hop2-retry (NULL en refund budget-only)
  ADD COLUMN IF NOT EXISTS debit_resolved_at        TIMESTAMPTZ; -- timestamp del flip terminal

-- ── 3. Índice parcial (surface de resoluciones colgadas; NO toca el índice de 191b) ──
CREATE INDEX IF NOT EXISTS idx_debit_sig_resolving
  ON a2a_payment_intent_debit_signatures (debit_settle_status)
  WHERE debit_settle_status IN ('resolving_settle','resolving_refund');

-- ============================================================
-- RPC: claim_reconciliation (SECURITY DEFINER, owner-guarded, atómico gana-uno)
-- Transición condicional pending → resolving_*. Solo UN caller gana (guard de
-- concurrencia). Re-claim del MISMO marker permitido (retry / crash-recovery);
-- marker OPUESTO o terminal resolved_* → 0 filas → claimed=false. NUNCA mueve dinero.
-- p_side ∈ ('settle','refund').
-- ============================================================
CREATE OR REPLACE FUNCTION claim_reconciliation(
  p_intent_id UUID,
  p_owner_ref TEXT,
  p_key_id    UUID,
  p_nonce     NUMERIC,
  p_side      TEXT
) RETURNS TABLE(
  claimed            BOOLEAN,
  resolution_tx_hash TEXT,
  signer_recovered   TEXT,
  amount_atomic      TEXT,
  key_id_hash        TEXT
) AS $$
DECLARE
  v_owner   TEXT;
  v_target  TEXT;
  v_rows    INT;
BEGIN
  IF p_side NOT IN ('settle','refund') THEN
    RAISE EXCEPTION 'INVALID_SIDE: %', p_side;
  END IF;
  v_target := CASE p_side WHEN 'settle' THEN 'resolving_settle' ELSE 'resolving_refund' END;

  -- Ownership Guard DB-level (CD-8/WKH-53), espejo 191b.
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

  -- Transición condicional atómica: gana-uno. Re-claim del mismo v_target permitido.
  UPDATE a2a_payment_intent_debit_signatures
     SET debit_settle_status = v_target
   WHERE key_id = p_key_id
     AND debit_nonce = p_nonce
     AND debit_validation_status = 'valid'
     AND debit_settle_status IN ('hop1_confirmed','reconciliation_pending', v_target);
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows > 0 THEN
    SELECT TRUE,
           s.debit_resolution_tx_hash,
           s.debit_signer_recovered,
           s.debit_amount_atomic::TEXT,
           s.debit_key_id_hash
      INTO claimed, resolution_tx_hash, signer_recovered, amount_atomic, key_id_hash
      FROM a2a_payment_intent_debit_signatures s
      WHERE s.key_id = p_key_id
        AND s.debit_nonce = p_nonce
        AND s.debit_validation_status = 'valid';
  ELSE
    claimed := FALSE;
  END IF;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.claim_reconciliation(uuid, text, uuid, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.claim_reconciliation(uuid, text, uuid, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_reconciliation(uuid, text, uuid, numeric, text)
  TO service_role;

-- ============================================================
-- RPC: record_reconciliation_resolution (SECURITY DEFINER, owner-guarded,
-- status-gated, MONEY-ATOMIC). Flip terminal resolving_* → resolved_*. El refund del
-- budget (SOLO lado refund) ocurre DENTRO de la MISMA tx que el flip, status-gated →
-- exactamente una vez (CD-2). Un retry ve resolved_* → applied=false → NO re-credita.
-- p_terminal_status ∈ ('resolved_settled','resolved_refunded'):
--   resolved_settled  ⇐ SOLO desde resolving_settle
--   resolved_refunded ⇐ SOLO desde resolving_refund   (enforcement CD-1/AC-6)
-- p_refund_amount_usd: >0 SOLO en resolved_refunded; NULL en resolved_settled.
-- ============================================================
CREATE OR REPLACE FUNCTION record_reconciliation_resolution(
  p_intent_id        UUID,
  p_owner_ref        TEXT,
  p_key_id           UUID,
  p_nonce            NUMERIC,
  p_terminal_status  TEXT,
  p_tx_hash          TEXT,
  p_chain_id         INT,
  p_refund_amount_usd NUMERIC
) RETURNS TABLE(applied BOOLEAN) AS $$
DECLARE
  v_owner    TEXT;
  v_required TEXT;
  v_rows     INT;
BEGIN
  IF p_terminal_status NOT IN ('resolved_settled','resolved_refunded') THEN
    RAISE EXCEPTION 'INVALID_TERMINAL_STATUS: %', p_terminal_status;
  END IF;
  -- CD-1/AC-6: cada terminal solo desde su resolving_* correspondiente.
  v_required := CASE p_terminal_status
                  WHEN 'resolved_settled'  THEN 'resolving_settle'
                  ELSE 'resolving_refund'
                END;

  -- Ownership Guard DB-level (CD-8), espejo 191b.
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

  -- Flip terminal status-gated. debit_resolution_tx_hash con COALESCE (la 1ª gana).
  UPDATE a2a_payment_intent_debit_signatures
     SET debit_settle_status      = p_terminal_status,
         debit_resolution_tx_hash = COALESCE(debit_resolution_tx_hash, p_tx_hash),
         debit_resolved_at        = now()
   WHERE key_id = p_key_id
     AND debit_nonce = p_nonce
     AND debit_validation_status = 'valid'
     AND debit_settle_status = v_required;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows > 0 THEN
    applied := TRUE;
    -- Money-atomic: SOLO el lado refund acredita el budget, DENTRO de esta tx,
    -- status-gated (exactamente una vez). refund_a2a_key_spend es owner-guarded y
    -- no-op si el monto ≤0. NUNCA mueve fondos on-chain (budget-only, DT-R4/NC-1).
    IF p_terminal_status = 'resolved_refunded'
       AND p_refund_amount_usd IS NOT NULL
       AND p_refund_amount_usd > 0 THEN
      PERFORM refund_a2a_key_spend(p_key_id, p_chain_id, p_refund_amount_usd, p_owner_ref);
    END IF;
  ELSE
    applied := FALSE; -- ya terminal / marker equivocado → no-op idempotente (CD-2)
  END IF;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.record_reconciliation_resolution(uuid, text, uuid, numeric, text, text, integer, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.record_reconciliation_resolution(uuid, text, uuid, numeric, text, text, integer, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_reconciliation_resolution(uuid, text, uuid, numeric, text, text, integer, numeric)
  TO service_role;

COMMIT;
```

#### W0.1b — `supabase/migrations/20260713000002_wkh191c_reconciliation_down.sql`

Additive-reversible. Restaura el CHECK de 191b (3 valores) — exemplar `..._wkh191b_..._down.sql`.

```sql
-- ============================================================
-- Down: 20260713000002_wkh191c_reconciliation
-- Revierte SOLO lo de 191c. NO destruye datos de 191a/191b. Restaura el CHECK de
-- 191b (3 valores). NOTA: si existen filas en estados resolving_*/resolved_*, el
-- restore del CHECK las rechazaría — el down asume que no hay resoluciones en vuelo
-- (revert en dev/CI antes de datos reales).
-- ============================================================

BEGIN;
DROP FUNCTION IF EXISTS record_reconciliation_resolution(uuid, text, uuid, numeric, text, text, integer, numeric);
DROP FUNCTION IF EXISTS claim_reconciliation(uuid, text, uuid, numeric, text);
DROP INDEX IF EXISTS idx_debit_sig_resolving;
ALTER TABLE a2a_payment_intent_debit_signatures
  DROP COLUMN IF EXISTS debit_resolved_at,
  DROP COLUMN IF EXISTS debit_resolution_tx_hash;
ALTER TABLE a2a_payment_intent_debit_signatures
  DROP CONSTRAINT IF EXISTS a2a_payment_intent_debit_signatures_debit_settle_status_check;
ALTER TABLE a2a_payment_intent_debit_signatures
  ADD  CONSTRAINT a2a_payment_intent_debit_signatures_debit_settle_status_check
  CHECK (debit_settle_status IS NULL OR debit_settle_status IN
    ('hop1_confirmed','settled','reconciliation_pending'));
COMMIT;
```

#### W0.2 — `src/types/database.types.ts` (agregar 2 entradas RPC)

Ubicar la sección de RPCs (donde vive `record_debit_hop1` en `database.types.ts:2771`) y
agregar (NUMERIC uint256 → `string`; `p_refund_amount_usd`/`p_chain_id` numéricos NO-uint256 → `number`):

```ts
      claim_reconciliation: {
        Args: {
          p_intent_id: string;
          p_owner_ref: string;
          p_key_id: string;
          // NUMERIC uint256 → string (precisión > 2^53).
          p_nonce: string;
          p_side: string; // 'settle' | 'refund'
        };
        Returns: {
          claimed: boolean;
          resolution_tx_hash: string | null;
          signer_recovered: string | null;
          amount_atomic: string | null;
          key_id_hash: string | null;
        }[];
      };
      record_reconciliation_resolution: {
        Args: {
          p_intent_id: string;
          p_owner_ref: string;
          p_key_id: string;
          // NUMERIC uint256 → string.
          p_nonce: string;
          p_terminal_status: string; // 'resolved_settled' | 'resolved_refunded'
          p_tx_hash: string | null;
          p_chain_id: number;
          p_refund_amount_usd: number | null;
        };
        Returns: {
          applied: boolean;
        }[];
      };
```

> **Verificación W0:** migración aplica en dev; `\d a2a_payment_intent_debit_signatures`
> confirma CHECK ensanchado (7 valores) + las 2 columnas + índice `idx_debit_sig_resolving`;
> `\df claim_reconciliation record_reconciliation_resolution` lista los 2 RPCs; `tsc --noEmit`
> pasa con las entradas nuevas.

---

### W1 (Parallelizable) — on-chain reader

#### W1.1 — `src/adapters/escrow/reconciler-onchain.ts` (crear)

Exemplar: `debit-executor.ts:200-234` (log-scan) + `escrow-verifier.ts:105-118, 146-151` (public-client cache + `getTransactionReceipt`) + `escrow-verifier.ts:229-243` (readContract shape del `escrowBalance` no existe aún → usar `client.readContract`).

Público, no-throw defensivo. Reusa `ESCROW_ABI` y el `parseAbiItem` del `Debited`:

- `reverifyDebitedByTxHash(args: { chainKey: ChainKey; escrowContract: 0x…; txHash: string | null; keyIdHash: string; nonce: bigint }): Promise<'confirmed' | 'not_confirmed' | 'indeterminate'>`
  - `txHash` null / no empieza con `0x` → `'indeterminate'` (huérfano sin hash: NO asumir not_confirmed; surface para revisión — evita refund erróneo).
  - public-client cacheado per-ChainKey (Map propio, espejo `_clients` de `escrow-verifier.ts`; NO reusar el Map de otro módulo). RPC ausente → `'indeterminate'`.
  - `getTransactionReceipt({hash})` → throw / no encontrado → `'indeterminate'` (CD-3: nunca decidir sobre incertidumbre).
  - `receipt.status !== 'success'` (revert) → `'not_confirmed'` (el debit no ocurrió).
  - Scan `receipt.logs`: filtro `logEntry.address.toLowerCase()===escrowContract.toLowerCase()` + `decodeEventLog({abi:[DEBITED_EVENT], eventName:'Debited', data, topics})` (try/catch continue) + match `decoded.args.keyId.toLowerCase()===keyIdHash.toLowerCase() && decoded.args.nonce===nonce` → `'confirmed'`.
  - success SIN match → `'not_confirmed'`.
- `readEscrowBalanceAtomic(args: { chainKey: ChainKey; escrowContract: 0x…; keyIdHash: 0x… }): Promise<bigint | null>`
  - `client.readContract({ address: escrowContract, abi: ESCROW_ABI, functionName: 'escrowBalance', args: [keyIdHash] })`. Error / RPC caído → `null` (drift no-computable para esa key → se reporta como tal).
- `_resetReconcilerOnchain(): void` — TEST-ONLY, limpia el cache (patrón `_resetEscrowVerifier`).

> **DEBITED_EVENT** = `parseAbiItem('event Debited(bytes32 indexed keyId, address indexed operator, uint256 amount, uint256 nonce)')` — byte-idéntico a `debit-executor.ts:53-55` y a `ESCROW_ABI.Debited`. topic0 derivado por viem, NUNCA literal.

#### W1.2 — `src/adapters/escrow/reconciler-onchain.test.ts` (crear)

Exemplar `debit-executor.test.ts`. Mock del public-client (`vi.mock` de `viem` `createPublicClient` o del helper de RPC). Tests en §7 (T-1..T-4).

> **Verificación W1:** `tsc --noEmit` + tests del reader verdes. `./node_modules/.bin/biome check --write src/adapters/escrow/reconciler-onchain.ts`.

---

### W2 (Depende de W0 + W1) — servicio exactly-one-side

#### W2.1 — `src/services/reconciliation.ts` (crear)

Exemplar: `payment-intent.ts` (BLQ-DR, seam, error class) + `arbiter.ts` (service shape). Exporta `reconciliationService` + `class ReconciliationError extends Error`.

**`class ReconciliationError extends Error`** con `code: 'INTENT_NOT_FOUND'|'NOT_PENDING'|'FLAG_OFF'|'INDETERMINATE'|'SETTLE_FAILED'|'INTERNAL'` (mapeado a HTTP en el route; disclosure-safe, patrón `PaymentIntentError`).

**`listPending(): Promise<PendingRow[]>` (AC-1)** — SELECT sobre `a2a_payment_intent_debit_signatures` JOIN `a2a_payment_intents` WHERE `debit_settle_status IN ('hop1_confirmed','reconciliation_pending','resolving_settle','resolving_refund')`. Cross-tenant admin DELIBERADO (patrón `listHolds`, `dashboard.ts:184`). Devuelve `{ intent_id, key_id, nonce, debit_hop1_tx_hash, finalAmountUsd, owner_ref, debit_settle_status }`. `finalAmountUsd = formatUnits(BigInt(debit_amount_atomic), token.decimals)` con `token = getAdaptersBundle(getDefaultChainKey()).payment.supportedTokens[0]`.

**`resolveIntent(intentId): Promise<ResolveOutcome>` (AC-2..AC-6)** — orquesta exactly-one-side. Flujo:

1. **Gate flag** — `isEscrowSettleEnabled()` OFF → `{ status: 'flag_off' }`, return. Cero lectura de dinero (AC-8/CD-6).
2. **Leer la fila** (JOIN intent+firma). Sin firma `valid` en estado pending → `ReconciliationError('NOT_PENDING')`. Extraer `debit_hop1_tx_hash`, `debit_key_id_hash`, `debit_nonce` (string), `debit_signer_recovered`, `debit_amount_atomic` (string), `pay_to` (seller), `chain_id`, `owner_ref` (**REAL, nunca asumido** — CD-8), `key_id`.
3. **Re-verificar on-chain** (CD-3) — `reverifyDebitedByTxHash({ chainKey, escrowContract, txHash: debit_hop1_tx_hash, keyIdHash: debit_key_id_hash, nonce: BigInt(debit_nonce) })`:
   - `'indeterminate'` → **abort**: NO mover dinero, dejar el estado, return `{ status: 'indeterminate' }` (se reintenta luego).
   - `'confirmed'` → lado **SETTLE** (`p_side='settle'`).
   - `'not_confirmed'` → lado **REFUND** (`p_side='refund'`).
4. **CLAIM** — `supabase.rpc('claim_reconciliation', { p_intent_id, p_owner_ref, p_key_id, p_nonce, p_side })`. `claimed===false` → otro run ganó / ya terminal → return `{ status: 'already_resolved' }` (no-op, AC-5).
5. **Crash-recovery** (SOLO lado settle; el refund no tiene tx on-chain) — si el claim devolvió `resolution_tx_hash` previo: `verifyDefaultChainSettle({ txHash, payTo: pay_to, requiredAmountAtomic: BigInt(...) })`:
   - `ok:true` → la tx anterior SÍ movió → saltar al paso 7 (flip terminal), NO re-enviar.
   - `warn:true` (RPC no disponible) → **abort** (no re-enviar a ciegas → evita double-move) → `{ status: 'indeterminate' }`.
   - `ok:false` sin warn (definitivo) → seguro re-enviar (paso 6).
6. **Mover el lado claimeado**:
   - **SETTLE**: `settlePaymentIntentOnChain({ intentId, ownerRef, payTo: pay_to (seller), finalAmountUsd, chainId })` (seam WKH-136 DIRECTO, hop 2 puro; DT-R2). NO `settleEscrowAware`.
     - `status:'settled'` → paso 7 con `terminal='resolved_settled'`, `tx_hash=result.txHash`, `refundAmount=null`.
     - `status:'failed'` → **abort money-safe**: dejar `resolving_settle` (surface en el `GET`), NO flip, NO refund → `{ status: 'settle_failed' }`.
   - **REFUND (budget-only)**: NO llamar a ningún seam on-chain. `terminal='resolved_refunded'`, `tx_hash=null`, `refundAmount=finalAmountUsd`. El paso 7 acredita el budget DENTRO del RPC (status-gated, una vez). **PROHIBIDO** cualquier transfer operador→buyer.
7. **Flip terminal + money-atomic** — `supabase.rpc('record_reconciliation_resolution', { p_intent_id, p_owner_ref, p_key_id, p_nonce, p_terminal_status: terminal, p_tx_hash, p_chain_id: chain_id, p_refund_amount_usd: refundAmount })`. El refund del budget ocurre DENTRO del RPC (una vez, CD-2). `applied===false` (ya terminal) → no-op idempotente. Return `{ status: terminal==='resolved_settled' ? 'settled' : 'refunded', side, txHash }`.

**`driftCheck(): Promise<DriftRow[]>` (AC-7)** — por cada `key_id` con firmas escrow: `sumDebitedAtomic` = SUM(`debit_amount_atomic`) WHERE `debit_settle_status IN ('hop1_confirmed','settled','reconciliation_pending')` + `readEscrowBalanceAtomic({...keyIdHash})` + `budget[chain_id]` de `a2a_agent_keys`. Reporta el tuple `{ key_id, sumDebitedAtomic, escrowBalanceAtomic, budgetUsd, deltaAtomic, exceedsThreshold }`. **SOLO reporte, NO corrige budget** (CD-4). `exceedsThreshold` según `RECONCILE_DRIFT_ALERT_THRESHOLD_ATOMIC` (default 0 → reporta cualquier delta ≠0) + `log.warn` cuando excede.

> Nota decimals: `budget` es USD y `escrowBalance`/`sumDebitedAtomic` son atomic 6-dec →
> reportar valores RAW sin forzar la ecuación (el decimals seam es WKH-192, OUT). El delta
> se computa sobre las unidades atomic (`sumDebitedAtomic` vs `escrowBalanceAtomic`).

#### W2.2 — `src/services/reconciliation.test.ts` (crear)

Exemplar `payment-intent.test.ts` / `arbiter.test.ts`. Mock de `supabase.rpc`, del seam `settlePaymentIntentOnChain`, de `reverifyDebitedByTxHash`/`readEscrowBalanceAtomic`, de `verifyDefaultChainSettle`, y de `isEscrowSettleEnabled`. Tests en §7 (T-5..T-12).

> **Verificación W2:** `tsc --noEmit` + tests del servicio (exactly-one-side / idempotencia / drift / flag) verdes. biome 0.

---

### W3 (Final) — endpoints + drift wiring

#### W3.1 — `src/routes/dashboard.ts` (modificar)

Agregar (mismo módulo que los endpoints de arbitrations, `dashboard.ts:170-250`):

1. **`requireAdminTokenStrict`** — nuevo preHandler fail-closed (a diferencia del opt-in `requireAdminToken` de `dashboard.ts:59`):
   - `DASHBOARD_ADMIN_TOKEN` **no configurado** → 503 `service_unavailable` SIEMPRE (dev Y prod — este `POST` mueve dinero, CD-7).
   - configurado → comparación timing-safe (reusar `timingSafeEqual` + `Buffer` de `dashboard.ts:81-88`); mismatch/faltante → 401.

2. **`GET /dashboard/api/reconciliation`** — `{ config: { rateLimit: false }, preHandler: requireAdminToken }` (opt-in, read-only, AC-1/AC-7). Response: `{ pending: PendingRow[], drift: DriftRow[], flagEnabled: boolean }` (`flagEnabled = isEscrowSettleEnabled()`). Corre con flag OFF (read-only). try/catch → 500 disclosure-safe.

3. **`POST /dashboard/api/reconciliation/:intentId/resolve`** — `fastify.post<{ Params: { intentId: string } }>('/api/reconciliation/:intentId/resolve', { config: { rateLimit: false }, preHandler: requireAdminTokenStrict }, ...)`. Ejecuta `reconciliationService.resolveIntent(request.params.intentId)`. El gate `isEscrowSettleEnabled()` vive DENTRO del service (AC-8). Mapear `ReconciliationError.code → HTTP` (patrón `sendArbiterAdminError`, `dashboard.ts:28`): `NOT_PENDING→409`, `INTENT_NOT_FOUND→404`, `FLAG_OFF→409`, `INDETERMINATE→200 {status:'indeterminate'}`, `SETTLE_FAILED→200 {status:'settle_failed'}`, default→500. Response happy: `{ status, side?, txHash? }`.

#### W3.2 — `src/routes/dashboard.test.ts` (modificar)

Agregar tests AC-1/AC-8/AC-9 (T-13, T-14). Exemplar: los tests existentes de dashboard.

> **Verificación W3:** `tsc --noEmit` + tests de ruta verdes + full QA (fail-closed, flag OFF). biome 0.

---

## 7. Tests requeridos (≥1 por AC — archivo/setup exactos)

| # | Test | AC | Archivo | Setup |
|---|------|-----|---------|-------|
| T-1 | `reverifyDebitedByTxHash`: receipt con `Debited` match (keyId+nonce) → `'confirmed'` | AC-2/AC-3 | `reconciler-onchain.test.ts` | mock `getTransactionReceipt` → `{status:'success', logs:[Debited encodeado del escrow]}` |
| T-2 | `reverifyDebitedByTxHash`: receipt `success` sin `Debited` **y** receipt `reverted` → `'not_confirmed'` | AC-2/AC-4 | `reconciler-onchain.test.ts` | 2 casos: logs vacíos/otra address; `status:'reverted'` |
| T-3 | `reverifyDebitedByTxHash`: `getTransactionReceipt` throw / RPC ausente / `txHash=null` → `'indeterminate'` (NO decide) | AC-2/CD-3 | `reconciler-onchain.test.ts` | mock throw + `txHash:null` |
| T-4 | `readEscrowBalanceAtomic`: `readContract` OK → `bigint`; error → `null` | AC-7 | `reconciler-onchain.test.ts` | mock `readContract` resolve/reject |
| T-5 | `resolveIntent` **confirmed** → llama seam `settlePaymentIntentOnChain` con `payTo===pay_to (seller)`, **NO** llama `refund_a2a_key_spend`, flip `resolved_settled` | AC-3 | `reconciliation.test.ts` | reverify→`confirmed`, claim→`{claimed:true}`, seam→`settled`; assert `payTo` del seam + `p_terminal_status:'resolved_settled'` |
| T-6 | `resolveIntent` **not_confirmed** → refund BUDGET-ONLY vía `record_reconciliation_resolution('resolved_refunded', p_refund_amount_usd>0)`, **NO llama ningún seam on-chain** (money-safety crítico), `p_tx_hash===null` | AC-4/R-1 | `reconciliation.test.ts` | reverify→`not_confirmed`; **assert que el mock del seam `settlePaymentIntentOnChain` NO fue invocado** + `record_reconciliation_resolution` con `p_refund_amount_usd` = finalAmountUsd |
| T-7 | `resolveIntent` idempotente: 2ª corrida sobre intent ya terminal → `claim_reconciliation` devuelve `{claimed:false}` → `already_resolved`, sin 2º side-effect (seam/refund no invocados) | AC-5 | `reconciliation.test.ts` | claim→`{claimed:false}`; assert seam+RPC-terminal NO invocados |
| T-8 | exactly-one-side (mutua exclusión): documentar como **integración SQL** que `record_reconciliation_resolution('resolved_settled')` desde `resolving_refund` → `applied=false` (no cruza lados). NO tautológico | AC-6 | `reconciliation.test.ts` | comentario honesto: gating por CHECK/status vive en el RPC (§6 W0.1), verificado en la migración; test TS asserta que el service pide el `p_terminal_status` correcto por lado |
| T-9 | `resolveIntent` con `isEscrowSettleEnabled()` OFF → `{status:'flag_off'}`, cero side-effect (ni lectura de fila) | AC-8 | `reconciliation.test.ts` | `isEscrowSettleEnabled` mock→false; assert supabase/seam NO invocados |
| T-10 | `resolveIntent` `indeterminate` (RPC caído) → abort, `{status:'indeterminate'}`, no mueve dinero | CD-3/R-3 | `reconciliation.test.ts` | reverify→`indeterminate`; assert claim/seam/refund NO invocados |
| T-11 | crash-recovery: `claim` devuelve `resolution_tx_hash` previo + `verifyDefaultChainSettle→{ok:true}` → NO re-envía el seam, flip terminal | R-3/CD-2 | `reconciliation.test.ts` | claim→`{claimed:true, resolution_tx_hash:'0x..'}`, verify→`{ok:true}`; assert seam NO invocado, `record_reconciliation_resolution` sí |
| T-12 | `driftCheck`: reporta `sumDebitedAtomic` vs `escrowBalanceAtomic` + delta, `exceedsThreshold` correcto, **NO** llama refund/update de budget | AC-7/CD-4 | `reconciliation.test.ts` | mock SUM + `readEscrowBalanceAtomic`; assert ningún RPC de escritura |
| T-13 | `GET /api/reconciliation`: lista `pending` + `drift` read-only, corre con flag OFF (`flagEnabled:false`) | AC-1/AC-8 | `dashboard.test.ts` | app fastify + mock `reconciliationService`; header `X-Admin-Token` si env set |
| T-14 | `POST .../resolve` sin `X-Admin-Token` (env SET) → 401; env UNSET → 503 (fail-closed); token válido → delega a `resolveIntent` | AC-9/CD-7 | `dashboard.test.ts` | 3 sub-casos sobre `DASHBOARD_ADMIN_TOKEN` |

> **Regla de tests (auto-blindaje 191b):** PROHIBIDO `expect(true).toBe(true)`. Las
> integraciones SQL no simulables sin Postgres (transición condicional del CHECK, refund
> status-gated dentro del RPC, owner-guard `FOR UPDATE`) se documentan como **integración
> explícita** con comentario honesto (como T-8) + se verifican en la migración (§6 W0.1),
> NO se tautologizan. Toda cross-reference a otro test se verifica con `grep` antes de commitear.

---

## 8. Patrones a seguir (exemplars verificados)

| Para | Seguir | Ancla |
|------|--------|-------|
| Migración additive + RPC SECURITY DEFINER owner-guarded + hardening | `20260713000001_wkh191b_debit_hop1.sql` | líneas 31-119 |
| Down reversible | `20260713000001_wkh191b_debit_hop1_down.sql` | completo |
| log-scan `Debited` por tx | `debit-executor.ts` | líneas 200-234 |
| public-client cache per-ChainKey + `getTransactionReceipt` | `escrow-verifier.ts` | líneas 105-118, 146-151 |
| `readContract` shape (address/abi/functionName/args) | `settle-verifier.ts` / viem estándar | — |
| seam money-path (NUNCA rechaza, verdicto persistido antes del side-effect) | `payment-intent.ts` | líneas 355-471 |
| error class → HTTP disclosure-safe | `dashboard.ts` `sendArbiterAdminError` | líneas 28-49 |
| endpoints admin-gated cross-tenant, generic en `.get/post<>()` | `dashboard.ts` | líneas 176-250 |
| preHandler admin timing-safe | `dashboard.ts` `requireAdminToken` | líneas 59-89 |
| entradas `Args`/`Returns` de RPC (NUMERIC uint256 → string) | `database.types.ts` `record_debit_hop1` | líneas 2771-2793 |
| refund off-chain owner-guarded (rows-affected) | `refund_a2a_key_spend` | migración `20260625000000...:30` |

---

## 9. Done Definition

- [ ] W0: migración `..._wkh191c_reconciliation.sql` (+down) creada; aplica en dev; `\d` confirma CHECK 7-valores + 2 columnas + índice `idx_debit_sig_resolving`; `\df` lista los 2 RPCs; **VERIFY-AT-IMPL del nombre del CHECK confirmado (R-5)**.
- [ ] W0: `database.types.ts` con las 2 entradas RPC; `tsc --noEmit` verde.
- [ ] W1: `reconciler-onchain.ts` (`reverifyDebitedByTxHash` + `readEscrowBalanceAtomic` + `_resetReconcilerOnchain`); tests T-1..T-4 verdes.
- [ ] W2: `reconciliation.ts` (`listPending` / `resolveIntent` exactly-one-side / `driftCheck` / `ReconciliationError`); tests T-5..T-12 verdes.
- [ ] W3: `dashboard.ts` con `requireAdminTokenStrict` + `GET` + `POST`; tests T-13/T-14 verdes.
- [ ] Los 14 tests verdes; **ningún `expect(true).toBe(true)`**; integraciones SQL documentadas explícitas.
- [ ] `tsc --noEmit` 0 errores + `./node_modules/.bin/biome check --write src/` 0 findings.
- [ ] CDs respetados: refund NUNCA llama seam on-chain (T-6); exactly-one-side gated en el RPC; owner_ref REAL leído de la fila; cero cambios a `contracts/`/`arbiter.ts`; sin deps nuevas; sin cron.
- [ ] `POST` fail-closed (503 si env unset); `GET` corre con flag OFF.

---

## 10. Readiness Check (F2.5)

```
[x] Scope IN exhaustivo (9 archivos, tabla §2) — nada fuera de la lista
[x] Cada wave tiene archivos exactos + verificación incremental
[x] Cada AC (1-9) tiene ≥1 test asociado (§7, T-1..T-14) con archivo/setup
[x] W0 trae el SQL COMPLETO (widen CHECK + 2 columnas + índice + 2 RPCs money-atomic + down)
[x] Anti-Hallucination Checklist con anclas de línea VERIFICADAS (§3)
[x] CDs inline heredados del SDD (exactly-one-side, idempotencia, on-chain autoritativo,
    re-verificación previa, refund budget-only, no double-credit, Ownership Guard, no contracts/)
[x] Aprendizaje auto-blindaje 191b integrado (no `expect(true).toBe(true)`)
[x] Sin [NEEDS CLARIFICATION] — NC-1 RESUELTO (budget-only)
[x] Done Definition + verificación por wave
```

> **READY FOR F3.** El Dev tiene el contrato completo, autocontenido, wave por wave.

---

*Story File generado por NexusAgil — Architect F2.5 — WKH-191c.*
