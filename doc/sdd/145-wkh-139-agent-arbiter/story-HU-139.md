# Story File — #145: [WKH-139 v2] Agente-Árbitro Autónomo de Disputas

> SDD: `doc/sdd/145-wkh-139-agent-arbiter/sdd.md` (fuente de verdad; NO hace falta releerlo)
> Fecha: 2026-07-04
> Branch: `feat/145-wkh-139-agent-arbiter`
> Pipeline: QUALITY — **money-path, alta sensibilidad** (el árbitro mueve plata sin humano en el loop).

---

## Goal

Construir un **agente-árbitro autónomo** que resuelve una disputa sobre un payment-intent
`session` (WKH-135) decidiendo `release` (todo al Seller), `refund` (todo al Buyer) o `split`
(parcial), y lo **ejecuta reusando los primitivos de settle/refund ya probados** del intent
`session` (`settlePaymentIntentOnChain` + RPCs `record_settle_outcome`/`finalize_payment_intent`).
La decisión es **rules-first** (determinística, anclada en evidencia on-chain/DB); el LLM se invoca
**sólo ante contradicción de evidencia** y **nunca mueve fondos**. Sobre un tope (`ARBITER_AUTO_CAP_USD`)
o ante ambigüedad irresoluble → **hold, cero movimiento**. Todo detrás de flag `ARBITER_ENABLED`
default OFF (**byte-idéntico apagado**). Sólo testnet.

---

## Acceptance Criteria (EARS) — copiados del SDD aprobado

- **AC-1**: WHEN se abre una disputa sobre un `session` intent y la evidencia determinística
  (ledger de vouchers + estado del intent + proof-chain de recibos) es inequívoca, THE system
  SHALL resolver mediante reglas determinísticas SIN invocar al LLM.
- **AC-2**: IF el motor de reglas no puede decidir sin ambigüedad genuina (proof-chain con
  integridad rota, o fuentes de evidencia que se contradicen), THEN THE system SHALL escalar a una
  decisión asistida por LLM **acotada a `{release,refund,split}`** y SHALL NUNCA permitir que el LLM
  ejecute movimiento de fondos.
- **AC-3**: WHEN el árbitro alcanza una decisión dentro del tope, THE system SHALL ejecutarla a
  través de los primitivos de settle/refund existentes (monto de settle **forzado por el árbitro**)
  y SHALL emitir un recibo inmutable (WKH-124) documentando desenlace, monto, método (rules/llm) y —
  si hubo LLM — el razonamiento registrado.
- **AC-4**: WHILE un intent está en estado de disputa (`disputed`/`arb_closing`/`arb_hold`), THE
  system SHALL NOT permitir que `closeSession` (cierre normal) settlee el mismo intent
  concurrentemente (previene doble-settle).
- **AC-5**: WHERE el árbitro mueve fondos, THE system SHALL restringir sus acciones a chain IDs de
  testnet (`2368`, `43113`, `84532`) y SHALL NOT operar sobre mainnet.
- **AC-6**: IF `authorized_usd` supera `ARBITER_AUTO_CAP_USD` (env, default 25), OR el desenlace no
  se pudo determinar sin ambigüedad (rules + LLM agotados), THEN THE system SHALL transicionar el
  intent a `arb_hold`, emitir un recibo `arbitration_hold`, y **NO mover fondos**.
- **AC-7**: WHERE `ARBITER_ENABLED` !== `'true'`, THE system SHALL comportarse **byte-idéntico** al
  estado actual: endpoints de disputa 404 y ningún intent entra jamás en un estado de disputa.

---

## ⚠️ DECISIÓN DE DISEÑO CRÍTICA (leer ANTES de W0/W2) — reconciliación finalize/arb_closing

El SDD define `arb_closing` como estado **distinto** de `closing` (§4.2) **y** exige reusar
`record_settle_outcome` + `finalize_payment_intent` **sin duplicar la máquina de refund** (§4.6, CD-6/CD-12).
Pero esos dos RPCs, hoy, están **status-gated a `status = 'closing'`** (verificado en la migración
WKH-135: `IF v_status <> 'closing' THEN RETURN;`). Sobre un intent en `arb_closing` harían **no-op** —
el refund/credit-back **no se aplicaría**. Es una incompatibilidad real de money-path.

**Resolución adoptada (Option B — la más segura y fiel):** en la migración de arbitraje (W0.1),
**`CREATE OR REPLACE`** `record_settle_outcome` y `finalize_payment_intent` **ensanchando SÓLO el
predicado de status** de `= 'closing'` a `IN ('closing','arb_closing')`. **NO se toca ninguna rama de
movimiento de dinero** (la lógica de `refund_a2a_key_spend`, los outcomes, el clamp — todo verbatim).

- Es **additive y byte-idéntico para todo intent que NO sea de arbitraje**: ningún intent del
  money-path normal llega jamás a `arb_closing` (sólo el árbitro lo produce), así que su
  comportamiento no cambia en un solo byte → **preserva CD-11 (flag OFF byte-idéntico)**.
- Preserva CD-6/CD-12 en espíritu: **la máquina de refund no se duplica ni se reescribe**; sólo el
  gate de status se ensancha.
- El `_down` restaura ambos RPCs a su predicado `= 'closing'` original.

**[VERIFY-AT-IMPL — ESCALAR A ARCHITECT SI HAY DUDA]:** esta es la única relajación de la letra
"finalize/record sin cambios" del SDD. Está documentada y es money-safe. Si el Dev encuentra un
camino que evite tocar esos RPCs manteniendo `arb_closing` distinto **y** exactly-once, **PARA y
escala** antes de improvisar. NO uses `status='closing'` para arbitraje (rompería el guard anti-race
de AC-4 y el sweep distinto de `expireStale`).

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `supabase/migrations/20260704100000_wkh139_arbiter.sql` | Crear | Extender status CHECK (+3); tabla `a2a_arbitrations` (RLS deny-by-default); RPC `open_dispute`; RPC `close_payment_intent_for_arbitration` (clamp + persistir monto); **CREATE OR REPLACE** `record_settle_outcome` + `finalize_payment_intent` con gate ensanchado (ver Decisión Crítica); extender `receipt_type` CHECK (+4). | `20260704000000_wkh135_payment_intents.sql` + `20260611000000_a2a_receipts_deposit_verified_check.sql` |
| 2 | `supabase/migrations/20260704100000_wkh139_arbiter_down.sql` | Crear | Reversa: DROP RPCs nuevos + tabla; restaurar ambos CHECK a su set previo; **restaurar `record_settle_outcome`/`finalize_payment_intent` al gate `='closing'`**. | `20260704000000_wkh135_payment_intents_down.sql` |
| 3 | `src/types/arbiter.ts` | Crear | Tipos: `ArbiterDecision`, `ArbiterMethod`, `DisputeEvidence`, `ArbiterOutcome`, `ArbiterError` + `ArbiterErrorCode`. Sin `any`. | `src/types/receipt.ts` |
| 4 | `src/types/receipt.ts` | Modificar | Extender `ReceiptType` con `arbitration_release`/`arbitration_refund`/`arbitration_split`/`arbitration_hold`. | (self) |
| 5 | `src/types/database.types.ts` | Modificar | Agregar tabla `a2a_arbitrations` + los 2 RPCs nuevos a los tipos generados. | patrón WKH-135 en el mismo archivo |
| 6 | `src/services/arbiter/evidence.ts` | Crear | Lector de evidencia **on-chain/DB únicamente**, owner-guarded: estado del intent + ledger de vouchers + proof-chain de recibos (con `verify` de integridad). | `src/services/receipt.ts` (`list`/`getById`, owner-guard) |
| 7 | `src/services/arbiter/rules.ts` | Crear | Motor determinístico **puro** `classify(evidence)` → decisión inequívoca o `{ambiguous, reason}`. Sin I/O. | helpers puros micro-USD de `payment-intent.ts` |
| 8 | `src/services/arbiter/llm-classifier.ts` | Crear | LLM acotado **nunca-throw**: resumen de evidencia → `{decision, splitPct?, reasoning}` o `null`. NUNCA ejecuta fondos. | `src/services/llm/input-retry.ts` |
| 9 | `src/services/arbiter.ts` | Crear | Orquesta: `openDispute` (gate → evidencia → rules→llm→cap → execute/hold) + `executeArbitration` (settle forzado + finalize + recibo + fila `a2a_arbitrations`) + `recoverArbClosing`. | `src/services/payment-intent.ts` (`closeSession`) |
| 10 | `src/services/payment-intent.ts` | Modificar | (a) `closeSession`: guarda que rechaza `prev_status ∈ {disputed,arb_closing,arb_hold}` → `INTENT_NOT_OPEN`. (b) `expireStale`: barrer también `status='arb_closing'` viejos → `recoverArbClosing`. | branches existentes de `closeSession`/`expireStale` |
| 11 | `src/routes/payments.ts` | Modificar | `POST /session/:id/dispute` + `GET /session/:id/dispute`, gated por `ARBITER_ENABLED` (404 si off), write-boundary, mapeo de error disclosure-safe. | `/session/:id/close` |
| 12 | `src/services/arbiter/rules.test.ts` | Crear | Unit del motor determinístico (los 3 casos + las 3 ambigüedades). | `src/services/payment-intent.test.ts` |
| 13 | `src/services/arbiter.test.ts` | Crear | Integración money-path (todos los ACs + casos obligatorios). | `src/services/payment-intent.test.ts` |

> **NO tocar** ningún archivo fuera de esta tabla. En particular: `WasiAIEscrow.sol`/ABI (CD-3),
> `fee-split.ts` (WKH-136), y las **ramas de dinero** de `record_settle_outcome`/`finalize_payment_intent`
> (sólo se ensancha su predicado de status — ver Decisión Crítica).

---

## Anti-Hallucination Checklist (símbolos verificados con Read/Grep — usar EXACTAMENTE estos)

### RPCs existentes (firmas exactas, migración WKH-135)
- `close_payment_intent_for_settle(p_intent_id UUID, p_owner_ref TEXT, p_reported_usage NUMERIC)`
  → `RETURNS TABLE(final_amount NUMERIC, prev_status TEXT, intent_type TEXT, key_id UUID, chain_id INT, pay_to TEXT, authorized_usd NUMERIC, consumed_usd NUMERIC, settle_tx_hash TEXT, settle_outcome TEXT)`.
  Patrón: `SELECT ... FOR UPDATE`; owner guard `IS DISTINCT FROM`; gate `IF v_status = 'open' THEN ... ELSE v_final := 0`. La rama `upto` **persiste** `consumed_usd = v_final` al transicionar (MNR-2) — **este es el patrón a copiar para el clamp del árbitro**.
- `record_settle_outcome(p_intent_id UUID, p_owner_ref TEXT, p_outcome TEXT, p_tx_hash TEXT, p_residual NUMERIC, p_error TEXT)` → `void`. Gate **hoy** `IF v_status <> 'closing' THEN RETURN`.
- `finalize_payment_intent(p_intent_id UUID, p_owner_ref TEXT, p_tx_hash TEXT, p_final_amount NUMERIC, p_residual NUMERIC, p_outcome TEXT, p_error TEXT)` → `void`. Gate **hoy** `IF v_status <> 'closing' THEN RETURN`. Ramas: `'settled'` (session con `p_residual>0` → `refund_a2a_key_spend(v_key,v_chain,p_residual,p_owner_ref)`); `'failed_unequivocal'` (session → refund `v_auth` COMPLETO); `else` → `status='failed'`, **NO refund**.
- Hardening en TODAS: `ALTER FUNCTION ... SET search_path = public, pg_temp;` + `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated;` + `GRANT EXECUTE ... TO service_role;` — **replicar en los 2 RPCs nuevos y re-declarar en los 2 CREATE OR REPLACE**.

### Funciones/exports TS existentes
- `settlePaymentIntentOnChain(params: { intentId: string; ownerRef: string; payTo: string; finalAmountUsd: number; chainId: number }): Promise<SettleOutcome>` — **exportada** en `src/services/payment-intent.ts`. IMPORTAR, no duplicar (CD-6).
- `PaymentIntentError` / `PaymentIntentErrorCode` — **exportados** (`'INVALID_INPUT'|'CAP_SIGNATURE_INVALID'|'OWNERSHIP_MISMATCH'|'INTENT_NOT_FOUND'|'INTENT_NOT_OPEN'|'INSUFFICIENT_BUDGET'|'INTERNAL'`).
- `SettleVerdict` = `'settled'|'failed_unequivocal'|'failed_ambiguous'` — **exportado**.
- `SettleOutcome` (en `src/types/index.ts`): `{ status:'settled'|'failed'|'in_progress'; txHash: string|null; finalAmountUsd:number; consumedUsd?; residualUsd?; cappedAt?; error?; failureKind?:'unequivocal'|'ambiguous' }`. **`exactOptionalPropertyTypes` en efecto** (CD-15).
- `recordSettleOutcome` / `finalizePaymentIntent` / `numericToMicro` / `numericToUsd` / `decimalStringToMicroUsd` / `normalizeVerdict` — **PRIVADAS** (module-scoped) en `payment-intent.ts`, NO exportadas. → En `arbiter.ts`: invocar los **RPCs directamente** vía `supabase.rpc('record_settle_outcome',{...})` / `supabase.rpc('finalize_payment_intent',{...})` (mismo patrón que las wrappers privadas) y **replicar** los helpers micro-USD (precedente: WKH-135 ya replicó `decimalStringToMicroUsd` desde delegation.ts — CD-6 pide replicar, no importar privados).
- `receiptService.emit(input: EmitReceiptInput): Promise<void>` — best-effort, nunca-throw. `EmitReceiptInput = { ownerRef, agentKeyId, sessionId, delegationId, receiptType, amountUsd, chainId, txHash, counterparty, orchestrationId }`. Para el árbitro: `sessionId=intentId`, `counterparty=seller_ref`, `receiptType='arbitration_*'`.
- `receiptService.list(ownerRef)` / `receiptService.getById(id, ownerRef)` / `receiptService.verify(id, ownerRef)` — owner-guarded (`.eq('owner_ref', ownerRef)`). Para `evidence.ts`: filtrar recibos por `session_id === intentId` (post-`list`, o query con `.eq('session_id', intentId).eq('owner_ref', ownerRef)`) y correr `verify` para detectar `tamper_detected`.
- LLM infra: `anthropicCircuitBreaker` (de `../../lib/circuit-breaker.js`), `getInputRetryModel`/`getInputRetryMaxTokens`/`getLlmTimeoutMs` (de `./models.js`), `Anthropic` (`@anthropic-ai/sdk`), `getLogger` (`../../lib/logger.js`), `supabase` (`../../lib/supabase.js`).
- Chain: `getChainConfig().chainId` (de `../adapters/registry.js`). Testnet allowlist confirmada en adapters: **kite-ozone `2368`, avalanche-fuji `43113`, base-sepolia `84532`**. Mainnet a rechazar: avalanche `43114`, base `8453` (+ kite-mainnet). **Usar allowlist (permitir sólo el set testnet, rechazar todo lo demás fail-closed)** — no blacklist.
- Route: `resolveCallerKey(req)` (de `./auth/parsers.js`); `callerKey.is_active` / `callerKey.owner_ref`; `req.params.id` (`FastifyRequest<{ Params: { id: string } }>`); `crypto.randomUUID()` server-side; helpers `isNonEmptyString`/`isFiniteNonNegative` ya en `payments.ts`.

### Tablas
- `a2a_payment_intents` — status CHECK **actual**: `('open','closing','settled','refunded','expired','failed')`. Columnas: `authorized_usd`/`consumed_usd` NUMERIC(20,8), `settle_outcome`, `settle_tx_hash UNIQUE`, `residual_usd`, `owner_ref`, `key_id`, `chain_id`, `pay_to`, `seller_ref`, `expires_at`, `updated_at`.
- `a2a_payment_vouchers` — ledger append-only, `UNIQUE(intent_id, voucher_id)`, `owner_ref`, `amount_usd`.
- `a2a_receipts` — `receipt_type` CHECK **actual** (post-126b): `('protocol_fee','budget_debit','deposit_verified')`. Constraint name: `a2a_receipts_receipt_type_check`. HMAC-chain por owner; `session_id`.
- `a2a_arbitrations` — **NUEVA** (ver esquema en W0.1).

---

## Waves

### Wave -1: Environment Gate (verificar ANTES de tocar código)

```bash
npm install 2>/dev/null || echo "Sin package.json"
# Archivos base del Scope IN deben existir:
ls src/services/payment-intent.ts src/routes/payments.ts src/services/receipt.ts \
   src/services/llm/input-retry.ts src/adapters/registry.ts \
   supabase/migrations/20260704000000_wkh135_payment_intents.sql 2>/dev/null || echo "FALTA archivo base"
# Verificar que la migración WKH-135 aplica en el Postgres efímero de test:
npx tsc --noEmit && echo "tsc OK baseline"
```

**Si algo falla:** PARAR y reportar al orquestador. No implementar sobre un entorno roto.

---

### Wave 0 (Serial Gate — DB + tipos; completar antes de todo)

**W0.1 — Migración `20260704100000_wkh139_arbiter.sql`** (Exemplar: migración WKH-135 + `..._deposit_verified_check.sql`)

Contenido, en orden:

1. **Extender status CHECK** de `a2a_payment_intents` (additive, DROP/ADD CONSTRAINT):
   ```
   status CHECK IN ('open','closing','settled','refunded','expired','failed',
                    'disputed','arb_closing','arb_hold')
   ```
   Semántica: `disputed` = disputa abierta, dinero NO movido; `arb_closing` = árbitro ejecutando el
   settle forzado (monto ya persistido en `consumed_usd`), recuperable; `arb_hold` = sobre-tope o
   ambigüedad irresoluble, congelado, dinero NO movido.

2. **Tabla `a2a_arbitrations`** (RLS deny-by-default, `ENABLE ROW LEVEL SECURITY`, sin policy
   permisiva — service_role bypassa por BYPASSRLS; patrón WKH-135):
   | Columna | Tipo | Nota |
   |---------|------|------|
   | `id` | UUID PK DEFAULT gen_random_uuid() | |
   | `intent_id` | UUID NOT NULL REFERENCES a2a_payment_intents(id) ON DELETE CASCADE | |
   | `owner_ref` | TEXT NOT NULL | Ownership Guard (CD-2) |
   | `decision` | TEXT CHECK IN ('release','refund','split','hold') | |
   | `method` | TEXT CHECK IN ('rules','llm','hold') | |
   | `at_stake_usd` | NUMERIC(20,8) NOT NULL | = `authorized_usd` (base del cap, AC-6) |
   | `settle_usd` | NUMERIC(20,8) NOT NULL DEFAULT 0 | monto forzado al Seller (0 si refund/hold) |
   | `ambiguity_reason` | TEXT NULL | por qué se escaló / por qué hold |
   | `llm_reasoning` | TEXT NULL | auditable si `method='llm'` (CD-4) |
   | `evidence_digest` | TEXT NULL | hash/resumen de la evidencia consultada |
   | `status` | TEXT CHECK IN ('decided','executed','held') | |
   | `created_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | |
   Índices: `(intent_id)`, `(owner_ref)`. **UNIQUE parcial** `(intent_id)` (1 arbitraje activo por intent).

3. **RPC `open_dispute(p_intent_id UUID, p_owner_ref TEXT)`** `RETURNS TABLE(intent_type TEXT, key_id UUID, chain_id INT, pay_to TEXT, seller_ref TEXT, authorized_usd NUMERIC, consumed_usd NUMERIC, expires_at TIMESTAMPTZ)` — Exemplar: `close_payment_intent_for_settle`.
   - `SELECT ... FOR UPDATE` sobre `a2a_payment_intents`.
   - `NOT FOUND` → `RAISE EXCEPTION 'INTENT_NOT_FOUND: %'`.
   - `owner_ref IS DISTINCT FROM p_owner_ref` → `RAISE EXCEPTION 'OWNERSHIP_MISMATCH: ...'`.
   - **Gate anti-race (AC-4):** `IF v_status <> 'open' THEN RAISE EXCEPTION 'INTENT_NOT_OPEN: ...'`.
     Este gate + `FOR UPDATE` = anti-race con `close_payment_intent_for_settle` (ambos exigen `open`
     bajo row-lock; el perdedor ve no-open y aborta → doble-settle imposible).
   - `UPDATE ... SET status = 'disputed' WHERE id = p_intent_id`.
   - Devolver el snapshot (nombres OUT calificados/distintos de columnas — **CD-14**, ej. `intent_type := v_type;`).

4. **RPC `close_payment_intent_for_arbitration(p_intent_id UUID, p_owner_ref TEXT, p_arb_amount NUMERIC)`** — **misma forma de retorno que `close_payment_intent_for_settle`** (`final_amount, prev_status, intent_type, key_id, chain_id, pay_to, authorized_usd, consumed_usd, settle_tx_hash, settle_outcome`). Exemplar: la rama `upto` de `close_payment_intent_for_settle` (persiste `consumed_usd`).
   - `SELECT ... FOR UPDATE` + owner guard + `NOT FOUND` → `INTENT_NOT_FOUND`.
   - **Clamp**: `v_arb := GREATEST(0, LEAST(v_auth, COALESCE(p_arb_amount, 0)));` (el árbitro NUNCA settlea > deposit — invariante "no crear plata").
   - Gate:
     - `IF v_status = 'disputed' THEN` → `v_final := v_arb; v_consumed := v_arb; UPDATE ... SET status='arb_closing', consumed_usd = v_arb WHERE id = p_intent_id;` (persiste el monto forzado — MNR-2).
     - `ELSIF v_status = 'arb_closing' THEN` → recovery: **NO re-transiciona, NO re-clampa**; `v_final := v_consumed;` (lee el monto ya persistido) — espejo exacto de la rama `closing` de `close_payment_intent_for_settle`.
     - `ELSE` → `RAISE EXCEPTION 'INTENT_NOT_OPEN: ...'`.
   - Devolver la tabla (columnas calificadas — CD-14).

5. **CREATE OR REPLACE `record_settle_outcome`** y **`finalize_payment_intent`** — copiar el cuerpo **verbatim** de la migración WKH-135, cambiando **UNA** línea en cada uno: el gate `IF v_status <> 'closing' THEN RETURN;` → `IF v_status NOT IN ('closing','arb_closing') THEN RETURN;`. **Nada más.** Re-declarar el hardening (`SET search_path` + REVOKE/GRANT). (Ver Decisión Crítica.)

6. **Extender `receipt_type` CHECK** (DROP/ADD `a2a_receipts_receipt_type_check`, Exemplar `..._deposit_verified_check.sql`):
   ```
   receipt_type IN ('protocol_fee','budget_debit','deposit_verified',
                    'arbitration_release','arbitration_refund',
                    'arbitration_split','arbitration_hold')
   ```

7. Hardening en `open_dispute` y `close_payment_intent_for_arbitration`: `SECURITY DEFINER` +
   `ALTER FUNCTION ... SET search_path = public, pg_temp;` + `REVOKE ... FROM PUBLIC, anon, authenticated;` + `GRANT ... TO service_role;` (firmas con tipos exactos).

**W0.1b — `_down`** (Exemplar `..._payment_intents_down.sql`): `BEGIN; DROP FUNCTION IF EXISTS close_payment_intent_for_arbitration(uuid,text,numeric); DROP FUNCTION IF EXISTS open_dispute(uuid,text); DROP TABLE IF EXISTS a2a_arbitrations;` + **restaurar** `record_settle_outcome`/`finalize_payment_intent` al gate `= 'closing'` (CREATE OR REPLACE con el cuerpo original) + restaurar ambos CHECK (`status` y `receipt_type`) a su set previo; `COMMIT;`.

**W0.2 — Tipos**
- `src/types/receipt.ts`: extender `ReceiptType` con los 4 nuevos (`arbitration_release`/`arbitration_refund`/`arbitration_split`/`arbitration_hold`).
- `src/types/arbiter.ts` (nuevo, Exemplar `receipt.ts`):
  ```
  export type ArbiterDecision = 'release' | 'refund' | 'split' | 'hold';
  export type ArbiterMethod   = 'rules' | 'llm' | 'hold';
  export type ArbiterErrorCode =
    | 'INVALID_INPUT' | 'OWNERSHIP_MISMATCH' | 'INTENT_NOT_FOUND'
    | 'INTENT_NOT_OPEN' | 'CHAIN_NOT_SUPPORTED' | 'ARBITER_DISABLED' | 'INTERNAL';
  export class ArbiterError extends Error { readonly code: ArbiterErrorCode; /* ... */ }
  export interface DisputeEvidence {
    intentId: string; authorizedUsd: number; consumedUsd: number; chainId: number;
    payTo: string; sellerRef: string; voucherCount: number; vouchersTotalUsd: number;
    proofChainOk: boolean;            // false si algún recibo falla verify (tamper)
    receiptSettleTotalUsd: number | null;  // Σ recibos de settle/budget de la sesión (null si ninguno)
  }
  export interface ArbiterOutcome {
    decision: ArbiterDecision; method: ArbiterMethod;
    settleUsd: number; residualUsd: number; atStakeUsd: number;
    status: 'executed' | 'held';
    txHash: string | null; ambiguityReason: string | null; llmReasoning: string | null;
  }
  ```
  **CD-15**: con `exactOptionalPropertyTypes`, campos opcionales → asignación condicional, nunca `x: cond ? v : undefined`. Declarar los nullables como `T | null` (no `?:`), como en `receipt.ts`.
- `src/types/database.types.ts`: agregar `a2a_arbitrations` (Row/Insert/Update) + los 2 RPCs nuevos a `Functions` (patrón de las otras entradas WKH-135 en el mismo archivo).

**Verificación W0:** migración aplica y revierte en Postgres efímero; `npx tsc --noEmit` limpio.

---

### Wave 1 (Parallelizable — módulos independientes; dependen de W0)

**W1.1 — `src/services/arbiter/evidence.ts`** (Exemplar `receipt.ts`)
- `export async function readEvidence(intentId: string, ownerRef: string): Promise<DisputeEvidence>`.
- **SÓLO on-chain/DB (CD-8):** lee (a) el snapshot del intent devuelto por `open_dispute` (o un SELECT owner-guarded sobre `a2a_payment_intents`), (b) `a2a_payment_vouchers` filtrando `.eq('intent_id', intentId).eq('owner_ref', ownerRef)` → `voucherCount`, `vouchersTotalUsd`, (c) recibos de la sesión (`.eq('session_id', intentId).eq('owner_ref', ownerRef)`) + `receiptService.verify` de cada uno → `proofChainOk`, `receiptSettleTotalUsd`.
- **PROHIBIDO** cualquier input off-chain de las partes (texto libre, adjuntos). Owner-guard en toda query (CD-2). Montos en micro-USD entero para comparaciones (replicar `numericToMicro`).

**W1.2 — `src/services/arbiter/rules.ts`** (motor **puro**, sin I/O)
- `export function classify(ev: DisputeEvidence): { decision: 'release'|'refund'|'split'; settleUsd: number } | { ambiguous: true; reason: string }`.
- Orden exacto de reglas (micro-USD, con tolerancia de micro-USD para comparaciones):
  1. **G-INTEGRITY**: `!ev.proofChainOk` → `{ ambiguous, reason:'proof_chain_tampered' }`.
  2. **A-EMPTY-LEDGER**: `ev.consumedUsd > 0 && ev.voucherCount === 0` → `{ ambiguous, reason:'evidence_incomplete' }`.
  3. **A-RECEIPT-MISMATCH**: `ev.receiptSettleTotalUsd !== null` y `|receiptSettleTotalUsd − consumedUsd| > tol` → `{ ambiguous, reason:'meter_receipt_mismatch' }`.
  4. **R-REFUND**: `consumedUsd == 0` → `refund`, `settleUsd = 0`.
  5. **R-RELEASE**: `consumedUsd >= authorizedUsd` → `release`, `settleUsd = authorizedUsd`.
  6. **R-SPLIT**: `0 < consumedUsd < authorizedUsd` y `|vouchersTotalUsd − consumedUsd| <= tol` → `split`, `settleUsd = consumedUsd`. (Si el ledger NO corrobora dentro de tolerancia → cae a A-RECEIPT-MISMATCH/ambiguous.)
- Ambigüedad genuina = **sólo** reglas 1–3 (contradicción/integridad rota). Ninguna otra rama escala.

**W1.3 — `src/services/arbiter/llm-classifier.ts`** (Exemplar `input-retry.ts` — **espejo estructural**)
- `export async function classifyAmbiguous(summary: {...montos/conteos/flags on-chain...}): Promise<{ decision:'release'|'refund'|'split'; splitPct?: number; reasoning: string } | null>`.
- Cliente Anthropic lazy singleton; `anthropicCircuitBreaker.execute(() => client.messages.create({ model: getInputRetryModel(), max_tokens: getInputRetryMaxTokens(), ... }, { signal }))`; `AbortController` + `setTimeout(() => controller.abort(), getLlmTimeoutMs())` con `clearTimeout` en `finally`.
- **CD-9 (nunca-throw):** TODA ruta de salida devuelve `null` — `getAnthropicClient()===null`, breaker abierto, timeout/abort, JSON no parseable, shape inválido, `decision` fuera de `{release,refund,split}`, `splitPct` fuera de `[0,100]`. `try/catch` con `return null` (como `input-retry.ts:116`). Logs SIN datos sensibles (sólo flags/conteos, nunca inputs de partes).
- **CD-1/CD-8:** el input es un **resumen de evidencia on-chain/DB** (montos, conteos, flags de integridad), NUNCA texto libre de las partes. El schema de salida está **acotado**; el LLM **no** toca fondos.

**Verificación W1:** `tsc` + `rules.test.ts` unit (W4 los detalla, pero corré rules aquí).

---

### Wave 2 (Integración — depende de W0 + W1)

**W2.1 — `src/services/arbiter.ts`** (Exemplar `closeSession` de `payment-intent.ts`)

`export const arbiterService = { openDispute, executeArbitration, recoverArbClosing }`.

- **`openDispute(intentId, ownerRef)`**:
  1. `supabase.rpc('open_dispute', { p_intent_id, p_owner_ref })`; error → `mapArbPgError` (mirror de `mapPgError`: `INTENT_NOT_FOUND`/`OWNERSHIP_MISMATCH`/`INTENT_NOT_OPEN` → `ArbiterError`).
  2. **Testnet guard (AC-5/CD-5, fail-closed):** `if (![2368,43113,84532].includes(row.chain_id)) throw new ArbiterError('CHAIN_NOT_SUPPORTED')` **antes** de tocar fondos.
  3. `readEvidence(intentId, ownerRef)`.
  4. `const r = classify(evidence)`. Si `r.ambiguous` → `const llm = await classifyAmbiguous(summary)`; si `llm === null` → **HOLD** (`ambiguityReason = r.reason`). Si `llm` → traducir a `settleUsd = clamp(decision==='split' ? deposit*splitPct/100 : decision==='release' ? deposit : 0, 0, deposit)`, `method='llm'`, guardar `llmReasoning`.
  5. **Cap gate (AC-6/CD-7, ANTES de ejecutar, para rules Y llm):** `atStakeUsd = authorizedUsd`; si `atStakeUsd > getArbiterAutoCapUsd()` → **HOLD**.
  6. HOLD → `holdArbitration` (abajo). Si no → `executeArbitration(...)`.
- **`executeArbitration(intentId, ownerRef, decision, method, settleUsd, ...meta)`** (money-path — copiar la estructura de `closeSession`):
  1. `supabase.rpc('close_payment_intent_for_arbitration', { p_intent_id, p_owner_ref, p_arb_amount: settleUsd })` → `row`. `arbAmount = numericToMicro(row.consumed_usd)/1e6` (lee el clamp persistido). `residual = deposit − arbAmount`.
  2. Si `row.prev_status === 'arb_closing'` → **recovery**: `verdict = normalizeVerdict(row.settle_outcome)`; `finalize_payment_intent(..., verdict, ...)` idempotente; devolver según verdict (espejo del bloque `closing` de `closeSession`, incl. `!row.settle_outcome && !allowStaleRecovery → in_progress` no-op — **CD-13**).
  3. **arbAmount <= 0 (refund)**: `record_settle_outcome('settled', null, residual, ...)` + `finalize_payment_intent(..., p_tx_hash:null, p_final_amount:0, p_residual:residual, p_outcome:'settled', ...)` → refund completo al Buyer, sin tx on-chain (espejo del `finalMicro<=0` de `closeSession`).
  4. **arbAmount > 0 (release/split)**: `const outcome = await settlePaymentIntentOnChain({ intentId, ownerRef, payTo: row.pay_to, finalAmountUsd: arbAmount, chainId: row.chain_id })` (**seam importado, CD-6**).
     - `settled` → `record_settle_outcome('settled', txHash, residual)` + `finalize('settled', residual)` → Seller cobra `arbAmount`, Buyer recupera `residual` (release ⇒ residual 0; split ⇒ residual>0).
     - `failed`/`unequivocal` → `record_settle_outcome('failed_unequivocal',...)` + `finalize('failed_unequivocal')` → Buyer recupera el deposit COMPLETO (herencia BLQ-ALTO-1).
     - `failed`/`ambiguous` → `record_settle_outcome('failed_ambiguous',...)` + `finalize('failed_ambiguous')` + `log.warn` RECONCILE (NO refund).
  5. **Recibo inmutable (CD-4):** `receiptService.emit({ ownerRef, agentKeyId:row.key_id, sessionId:intentId, delegationId:null, receiptType: decision==='release'?'arbitration_release':decision==='refund'?'arbitration_refund':'arbitration_split', amountUsd: arbAmount, chainId: row.chain_id, txHash, counterparty: sellerRef, orchestrationId:null })`.
  6. **Fila `a2a_arbitrations`**: insert/update `status='executed'`, `decision`, `method`, `at_stake_usd`, `settle_usd`, `llm_reasoning`, `evidence_digest`, `ambiguity_reason`.
- **`holdArbitration(...)`** (AC-6/CD-10): `UPDATE a2a_payment_intents SET status='arb_hold'` (RPC o update owner-guarded — **[VERIFY-AT-IMPL]**: reusar un RPC o un update directo owner-guarded; NO mover dinero); `receiptService.emit({ receiptType:'arbitration_hold', amountUsd:0, ... })`; fila `a2a_arbitrations(decision='hold', method='hold', status='held', ambiguity_reason)`. **Cero movimiento de fondos.**
- **`recoverArbClosing(intentId, ownerRef, allowStaleRecovery)`**: espejo de la rama `closing` de `closeSession` — re-invoca `close_payment_intent_for_arbitration` (prev_status='arb_closing' + verdict persistido) y aplica `finalize` idempotente (CD-13). Usado por `expireStale`.
- **`getArbiterAutoCapUsd()`**: env `ARBITER_AUTO_CAP_USD`, default **25**; parse → validar (>0, finito) → fallback + `log.warn` → nunca throw (patrón `resolveTtlSeconds`/`models.ts`).
- **`isArbiterEnabled()`**: `process.env.ARBITER_ENABLED === 'true'` (default OFF).

**W2.2 — `src/services/payment-intent.ts`** (2 cambios quirúrgicos)
- **(a) Guarda anti-race en `closeSession` (AC-4):** justo tras obtener `row` (después de `if (!row) throw INTENT_NOT_FOUND`), antes del bloque `if (row.prev_status !== 'open')`, agregar:
  ```
  if (row.prev_status === 'disputed' || row.prev_status === 'arb_closing' || row.prev_status === 'arb_hold') {
    throw new PaymentIntentError('INTENT_NOT_OPEN');
  }
  ```
  Es el **único cambio de lógica** en el path existente y es **rama muerta con flag OFF** (ningún intent alcanza esos estados). Hoy ese fallthrough devuelve `'settled'` erróneamente — esta guarda lo corrige.
- **(b) Sweep en `expireStale`:** agregar una tercera query `.eq('status','arb_closing').lt('updated_at', staleIso)` (mismo umbral `resolveClosingStaleMs()`), y en el loop, para esas filas, llamar `recoverArbClosing(stale.id, stale.owner_ref, true)`.
  - **[VERIFY-AT-IMPL — dependencia circular]:** `arbiter.ts` importa `settlePaymentIntentOnChain` de `payment-intent.ts`; si `payment-intent.ts` importa `arbiterService` estáticamente → ciclo. **Romper con import dinámico** dentro del loop: `const { arbiterService } = await import('./arbiter.js');`. Confirmar que no rompe el bundling/tests.

**Verificación W2:** `tsc` + tests de integración money-path.

---

### Wave 3 (Rutas + flag)

**W3.1 — `src/routes/payments.ts`** (Exemplar `/session/:id/close`)
- **`POST /session/:id/dispute`**:
  ```
  fastify.post('/session/:id/dispute', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!isArbiterEnabled()) return reply.status(404).send({ error_code: 'NOT_FOUND' }); // AC-7 byte-idéntico
    const callerKey = await resolveCallerKey(req);
    if (!callerKey?.is_active) return reply.status(403).send({ error: 'Invalid or inactive API key' });
    try {
      const outcome = await arbiterService.openDispute(req.params.id, callerKey.owner_ref);
      return reply.status(200).send({ decision: outcome.decision, method: outcome.method,
        status: outcome.status, settleUsd: outcome.settleUsd, residualUsd: outcome.residualUsd, txHash: outcome.txHash });
    } catch (err) { return sendArbiterError(reply, err); }
  });
  ```
- **`GET /session/:id/dispute`** (estado, owner-guarded): si `!isArbiterEnabled()` → 404; si no, leer la fila `a2a_arbitrations` por `intent_id` + owner-guard y el `status` del intent; devolver estado. `null`/otro owner → 404 disclosure-safe.
- **`sendArbiterError(reply, err)`** (nuevo helper en `payments.ts`, mirror de `sendPaymentError`): `ArbiterError` → HTTP: `INVALID_INPUT`→422, `OWNERSHIP_MISMATCH`→403, `INTENT_NOT_FOUND`→404, `INTENT_NOT_OPEN`→409, `CHAIN_NOT_SUPPORTED`→422, `ARBITER_DISABLED`→404, default→500 `{ error_code:'ARBITER_FAILED' }`. También manejar `PaymentIntentError` (por si burbujea). Nunca propagar el mensaje crudo (disclosure-safe).
- **Gating byte-idéntico (CD-11):** el `if (!isArbiterEnabled()) return 404` es lo **primero** en ambos handlers, antes de auth/parsing. Con flag OFF, el comportamiento observable es "la ruta no existe".

**Verificación W3:** `tsc` + tests de ruta (flag on/off).

---

### Wave 4 (Tests + verificación) — Exemplar `payment-intent.test.ts`

**W4.1 — `src/services/arbiter/rules.test.ts`** (unit puro):
- `consumed==0 → refund` (settle 0).
- `consumed>=deposit → release` (settle=deposit).
- `0<consumed<deposit` con ledger corroborando → `split` (settle=consumed).
- `!proofChainOk → ambiguous('proof_chain_tampered')`.
- `consumed>0 & voucherCount==0 → ambiguous('evidence_incomplete')`.
- `receipt vs consumed mismatch → ambiguous('meter_receipt_mismatch')`.

**W4.2 — `src/services/arbiter.test.ts`** (integración money-path, DB in-memory fiel):

| Test | AC / caso |
|------|-----------|
| rules-inequívoco: consumed==0 → refund, SIN LLM, recibo `arbitration_refund` | AC-1 |
| release=deposit / split=partial / refund=0 → settle+residual correctos; recibos correctos | AC-3 |
| ambiguo → `classifyAmbiguous` → decisión acotada, ejecuta, recibo con `llm_reasoning` | AC-2/AC-3 |
| LLM devuelve `null` (breaker/timeout) → `arb_hold`, recibo `arbitration_hold`, **cero fondos** | AC-2/AC-6 (fail-closed) |
| at_stake > cap → `arb_hold` + recibo, **NO settle** (aún con decisión rules inequívoca) | AC-6 (sobre-tope→flag) |
| **anti-race doble-settle**: intent `disputed`, `closeSession` concurrente → `INTENT_NOT_OPEN` (409), NO settlea | AC-4 |
| **exactly-once**: `finalize` re-invocada 3× (recovery) → refund/settle **1 sola vez** | AC-3/AC-4 |
| settle forzado on-chain falla `unequivocal` → refund deposit; `ambiguous` → RECONCILE (sin refund) | AC-3 (fail-closed) |
| chain mainnet (43114/8453) → `CHAIN_NOT_SUPPORTED`, cero fondos | AC-5 |
| **flag OFF byte-idéntico**: `POST /dispute` → 404 **y** `closeSession` idéntico (guarda inerte) | AC-7 |
| ownership: dispute sobre intent de otro owner → `OWNERSHIP_MISMATCH` (403) | CD-2 |

**W4.3 — QA final:** `npm test` + `npx tsc --noEmit` + `npx biome check src/` limpios (**CD-16**: sin imports no usados; correr biome sobre TODOS los archivos nuevos antes de cerrar).

---

## Constraint Directives (del SDD — NO relajar)

### OBLIGATORIO
- **CD-2**: Ownership Guard `owner_ref` en TODA tabla/query/RPC nueva de disputas.
- **CD-4**: recibo inmutable (`receiptService.emit`) por CADA decisión, **incluido `hold`**; si hubo LLM, `llm_reasoning` en `a2a_arbitrations`.
- **CD-6**: reusar `settlePaymentIntentOnChain` + `record_settle_outcome` + `finalize_payment_intent`; **no duplicar** sign/settle/verify ni la máquina de refund. (Única relajación autorizada: ensanchar el gate de status — ver Decisión Crítica.)
- **CD-7**: cap gate `at_stake_usd > ARBITER_AUTO_CAP_USD` → `arb_hold` **antes** de cualquier settle, para rules Y llm.
- **CD-9**: `llm-classifier` NUNCA lanza hacia el árbitro — toda ruta → `null`. Schema acotado a `{release,refund,split(+pct)}`.
- **CD-10**: fail-closed — LLM `null` o sobre-tope → `arb_hold`, jamás auto-release/refund a ciegas.
- **CD-11**: flag `ARBITER_ENABLED` default OFF; con OFF, **cero cambio** en el money-path (byte-idéntico).
- **CD-12/CD-13**: refund dentro de la tx status-gated de `finalize` (reuso); en `arb_closing` discriminar in-flight (`settle_outcome=NULL` + `!allowStaleRecovery` → `in_progress` no-op) vs huérfano.
- **CD-14**: RPCs `RETURNS TABLE` — columnas calificadas / OUT con nombre distinto (evitar "column reference is ambiguous"). `SECURITY DEFINER` + `SET search_path` + REVOKE/GRANT.
- **CD-15**: `exactOptionalPropertyTypes` — nunca `x: cond ? v : undefined`; asignación condicional. Nullables como `T | null`.
- **CD-16**: `biome check src/` sobre los nuevos antes de cerrar cada wave; sin imports "por si acaso".
- Montos en **micro-USD entero** para toda comparación/aritmética (replicar `numericToMicro`).

### PROHIBIDO
- NO dependencias nuevas (Anthropic SDK, viem, supabase ya presentes).
- NO darle al LLM autoridad de ejecución ni ampliar su schema más allá de los 3 desenlaces (**CD-1**).
- NO evidencia off-chain de las partes (texto libre, adjuntos) — **CD-8**.
- NO settlear > `authorized_usd` (clamp `[0, deposit]` en el RPC).
- NO tocar `WasiAIEscrow.sol`/ABI (**CD-3**) ni `fee-split.ts` (WKH-136).
- NO tocar las **ramas de dinero** de `record_settle_outcome`/`finalize_payment_intent`/`settlePaymentIntentOnChain` (sólo el gate de status, additive).
- NO habilitar arbitraje sobre mainnet (**CD-5**) — allowlist testnet fail-closed.
- NO `any`/`as unknown` fuera de los narrowings acotados ya presentes en el patrón.
- NO archivos fuera de la tabla "Files to Modify/Create".

---

## Out of Scope

- Mainnet. Disputas sobre `upto` (v1 sólo `session`). UI/dashboard/override humano (sólo se expone `arb_hold` + recibo + flag). Red multi-árbitro/votación. Modificar `WasiAIEscrow.sol`/ABI. Reuso de `fee-split.ts`. Inputs off-chain como evidencia. NO "mejorar" código adyacente ni refactors no solicitados.

---

## Escalation Rule

**Si algo no está en este Story File, Dev PARA y escala a Architect.** No inventar, no asumir.

Escalation obligatoria en estos puntos:
- La **Decisión Crítica** (finalize/arb_closing): si encontrás un camino money-safe que evite tocar el gate de esos RPCs manteniendo `arb_closing` distinto y exactly-once → escalá antes de codear W0.1 punto 5.
- El **[VERIFY-AT-IMPL] de dependencia circular** en `expireStale` (import dinámico de `arbiter.js`): si el import dinámico rompe tests/bundling → escalá.
- El **`holdArbitration`** update de `status='arb_hold'`: confirmar si va por RPC nuevo o update directo owner-guarded (no mueve dinero en ningún caso).
- Si un exemplar ya no existe, un import no está disponible, o `database.types.ts` no tiene la forma esperada.

---

*Story File generado por NexusAgil — F2.5. Money-path QUALITY.*
