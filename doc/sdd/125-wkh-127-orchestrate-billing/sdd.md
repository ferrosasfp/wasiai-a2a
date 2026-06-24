# SDD #125: [BUG] Orchestrate Billing — precio real + reembolso en fallo (WKH-127)

> SPEC_APPROVED: no
> Fecha: 2026-06-23
> Tipo: bugfix / billing
> SDD_MODE: full (bugfix con dos sub-problemas acoplados + atomicidad PG + tests)
> Branch: fix/125-wkh-127-orchestrate-billing
> Artefactos: doc/sdd/125-wkh-127-orchestrate-billing/

---

## 1. Resumen

`/orchestrate` hoy debita un placeholder de **$1 USD flat** (vía el middleware
`requirePaymentOrA2AKey`, `a2a-key.ts:286-291` → `estimatedCostUsd = 1.0` porque
orchestrate no inyecta ningún campo de precio) y **nunca reembolsa** si el
pipeline falla. Incidente real (2026-06-24): un usuario con `budget[43113]=1`
corrió una orquestación que falló por config faltante del gateway y quedó con
`budget=0`, `daily_spent=1`, sin haber recibido valor.

Este SDD resuelve **(A)** que orchestrate debite el **costo real del plan
seleccionado** (`sum(agent.priceUsdc)`) y **(B)** un **credit-back atómico**
cuando el pipeline falla (total AC-5 / parcial AC-6), preservando CD-2 (sin
revenue leak en pipelines exitosos) y CD-5/CD-7 (x402 y compose intactos).

La decisión arquitectónica central (**DT-1**) es resuelta en este SDD a favor de
la **Opción B (débito post-plan en el service)**, con una señal limpia
`request.skipMiddlewareDebit` + un pre-check de balance barato para preservar el
early-fail sin gastar LLM. Ver §4.0.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 125 |
| **Tipo** | bugfix / billing |
| **SDD_MODE** | full |
| **Objetivo** | (A) debitar el costo real del plan en orchestrate; (B) credit-back atómico en fallo total/parcial sin tocar compose/x402 |
| **Reglas de negocio** | Sin revenue leak en éxito (CD-2); atomicidad del refund (CD-3); ownership guard en toda mutación de `a2a_agent_keys` (CD-4); refund nunca crea dinero (no acredita más de lo debitado) |
| **Scope IN** | `src/routes/orchestrate.ts`, `src/middleware/a2a-key.ts`, `src/services/orchestrate.ts`, `src/services/budget.ts`, `src/types/index.ts`, migración SQL up+down, tests |
| **Scope OUT** | `src/routes/compose.ts`, `src/services/compose.ts` (guard `i>0`), `runX402Fallback`, `chargeProtocolFee` internals, escrow WKH-126, débitos per-step (steps 1..N) |
| **Missing Inputs** | DT-1 (resuelto en §4.0); interfaz RPC credit-back (resuelto §4.2); aplicabilidad a delegación/session (resuelto §4.6) |

### Acceptance Criteria (EARS) — heredados del work-item, sin cambios

- **AC-1**: WHEN `/orchestrate` recibe request autenticada con Agent Key y el plan produce steps con costo calculable, THEN the system SHALL debitar `sum(agent.priceUsdc)` del plan en lugar del placeholder $1.
- **AC-2**: WHEN el plan resulta en `steps.length === 0`, THEN the system SHALL NOT debitar ningún monto.
- **AC-3**: WHEN el costo real del plan es conocido antes del débito, THEN the system SHALL usar ese valor en el débito (vía la coordinación middleware↔service definida en §4.0, no necesariamente `request.orchestrateEstimatedCostUsd` — ver DT-1).
- **AC-4**: WHEN el costo total real es `0` (todos `priceUsdc === 0`), THEN the system SHALL aplicar el fallback $1 + `warn` + header `x-debit-fallback: registry-miss` (espejo DT-C de WKH-59).
- **AC-5**: WHEN `pipeline.success === false` Y `pipeline.totalCostUsdc === 0` (fallo total), THEN the system SHALL emitir credit-back atómico que restituya el monto debitado.
- **AC-6**: WHEN `pipeline.success === false` Y `pipeline.totalCostUsdc > 0` (fallo parcial), THEN the system SHALL reembolsar `max(0, debited - totalCostUsdc)`; si `totalCostUsdc >= debited`, no reembolsa.
- **AC-7**: WHEN un orchestrate falla total (AC-5) y el refund completa, THEN `budget[chainId]` y `daily_spent_usd` quedan en estado de consumo neto cero para ese request.
- **AC-8**: WHEN el credit-back falla (DB/timeout), THEN the system SHALL loguear `[orchestrate.refund-failed]` con `keyId`, `chainId`, `amountUsd`, `orchestrationId`, y retornar `refundError: true` en el body (sin mensaje crudo de PG, CD-6).
- **AC-9**: WHEN `/orchestrate` es llamado por caller x402, THEN the system SHALL NOT intentar credit-back (comportamiento pre-WKH-127 intacto).
- **AC-10**: WHEN `/compose` es llamado, THEN the system SHALL NOT verse afectado (`resolveComposePriceHandler` + débito step-0 intactos).
- **AC-11**: WHEN un pipeline exitoso de orchestrate corre, THEN the system SHALL debitar el costo real sin reembolso y el fee del 1% se aplica normalmente (success-gated).

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `src/routes/orchestrate.ts` | Punto de entrada del débito y del response | preHandler chain L46-58: `requireForwardKey → backpressure → timeout → requirePaymentOrA2AKey`. NO inyecta ningún campo de precio → middleware usa $1 (confirmado). El response se arma en L102: `reply.status(status).send({ kiteTxHash, ...result })`. `request.a2aKeyRow` y `request.resolvedChainId` existen post-middleware. |
| `src/routes/compose.ts` | Exemplar del patrón "preHandler inyecta precio real ANTES del middleware" | `resolveComposePriceHandler` (L62-143): resuelve precio, maneja 404/503/fallback $1 + header `x-debit-fallback`, inyecta `request.composeEstimatedCostUsd` (L124). Corre ANTES de `requirePaymentOrA2AKey` (L160). El fee best-effort post-compose (L247-292) es el exemplar del manejo de error que NO rompe el response. |
| `src/middleware/a2a-key.ts` | Dónde se calcula `estimatedCostUsd` y dónde se debita | L286-291: prioridad `composeEstimatedCostUsd > gaslessEstimatedCostUsd > 1.0`. L852-861: débito step-0 master (3-arg o 6-arg con `composeDestination`). L297+ branch session, L293+ branch delegación. L919: augmenta `a2aKeyRow`. L829: `resolvedChainId`. L57-68: bloque `declare module 'fastify'` con la request augmentation. |
| `src/services/orchestrate.ts` | Dónde se conoce el costo del plan y el resultado del pipeline | L330-346 (LLM path): `budgetedAgents` + `totalCost` calculado (sum de `agent.priceUsdc` dentro del budget). `greedyPlan` (L189-219): `selected` array, su cost se puede sumar igual. L362 `steps.length===0` → return early (AC-2). L406-425: `composeService.compose(...)` → `pipeline`. L437 `if (pipeline.success)` (fee success-gated, AC-11). L484-515: arma `OrchestrateResult`. Tiene `request.scopingKeyRow` (= a2aKeyRow), `request.chainId`, `delegationContext`, `keySessionContext`. |
| `src/services/budget.ts` | Dónde vive `debit()` y dónde irá `credit()` | `debit()` L72-326: rutas key-session / delegación / dest-aware / master. La ruta master (L300-325) hace SELECT cold-path de `owner_ref` y llama RPC `increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref)`. Mapea `OWNERSHIP_MISMATCH` sin propagar msg crudo (L319). NO existe `credit()`/`refund()`. `getBalance(keyId, chainId, ownerId)` L39-61 — pre-check barato. |
| `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql` | Exemplar EXACTO de la RPC atómica con FOR UPDATE + ownership guard | `increment_a2a_key_spend` (L20-93): `SELECT ... FOR UPDATE` (L35-38), `IF NOT FOUND → KEY_NOT_FOUND` (L40), `IF owner_ref IS DISTINCT FROM p_owner_ref → OWNERSHIP_MISMATCH` (L47-49), lazy daily reset (L56-62), UPDATE budget + `daily_spent_usd` (L85-91). Hardening: `SET search_path` + `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role` (L95-101). |
| `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc_down.sql` | Exemplar del down reversible | Patrón DROP + CREATE de la firma previa. La nueva RPC de refund es 100% aditiva → su down es un simple `DROP FUNCTION IF EXISTS`. |
| `src/types/index.ts` | Donde viven `ComposeResult`, `OrchestrateResult`, `OrchestrateRequest` | `ComposeResult` L287-305: `success: boolean`, `totalCostUsdc: number`, `errorCode?`. `OrchestrateResult` L418-430: spread condicional `feeChargeError`/`feeChargeTxHash` (exemplar para agregar `refundError`). `OrchestrateRequest` L387+: ya propaga `scopingKeyRow`, `chainId`, `delegationContext`, `keySessionContext`. |

### Exemplars verificados (paths confirmados con Glob/Read)

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| RPC `refund_a2a_key_spend` (migración nueva) | `increment_a2a_key_spend` en `20260609000000_wkh_sec02b_owner_ref_rpc.sql:20-101` | Misma estructura FOR UPDATE + ownership guard + hardening; invierte el signo del débito |
| `budgetService.credit()` en `budget.ts` | Ruta master de `budgetService.debit()` `budget.ts:300-325` | SELECT cold-path de owner_ref + `supabase.rpc(...)` + mapeo de error sin propagar PG crudo |
| Pre-check de balance (early-fail) | `budgetService.getBalance()` `budget.ts:39-61` | Lectura barata `budget[chainId]` con ownership guard, sin debitar |
| Fallback $1 + header en orchestrate | `resolveComposePriceHandler` `compose.ts:105-120` | `warn` + `reply.header('x-debit-fallback','registry-miss')` |
| Manejo de refund que no rompe response | fee best-effort `orchestrate.ts:435-482` y `compose.ts:247-292` | error queda en variable local + log, response procede; spread condicional `...(x !== undefined && { x })` |
| `refundError` en `OrchestrateResult` | `feeChargeError` `types/index.ts:427` | Spread condicional opcional en el result |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `a2a_agent_keys` | Sí | `id` UUID, `owner_ref` TEXT, `budget` JSONB (`{ "<chainId>": "<saldo>" }`), `daily_spent_usd` NUMERIC, `daily_reset_at` TIMESTAMPTZ, `is_active` BOOL |
| RPC `increment_a2a_key_spend(uuid,int,numeric,text)` | Sí | débito atómico FOR UPDATE + ownership guard (firma de 4 params post-SEC-02b) |
| RPC `refund_a2a_key_spend(...)` | **No — la crea esta HU** | credit-back atómico FOR UPDATE + ownership guard (§4.2) |

### Componentes reutilizables encontrados

- `budgetService.getBalance(keyId, chainId, ownerId)` — reutilizar como pre-check de balance barato (Opción B early-fail), no crear lectura nueva.
- Patrón de mapeo de error de `debit()` (no propagar msg crudo de PG) — reutilizar en `credit()`.
- Spread condicional `...(feeChargeError !== undefined && { feeChargeError })` — reutilizar para `refundError`.

---

## 4. Diseño Técnico

### 4.0 DT-1 — DECISIÓN: Opción B (débito post-plan en el service) — RESUELVE [NEEDS CLARIFICATION]

**Decisión: se adopta la Opción B con una señal `request.skipMiddlewareDebit` + pre-check de balance barato.**

#### Evaluación de las tres opciones

| Criterio | A — preHandler (re-planifica) | B — débito post-plan en el service | C — preHandler liviano + cost propagation |
|----------|-------------------------------|-------------------------------------|--------------------------------------------|
| **Latencia / tokens** | ❌ 2× discovery + 2× LLM call (lo más caro de orchestrate; LLM_TIMEOUT 30s c/u) | ✅ 1× discovery + 1× LLM | ⚠️ 1× LLM si se propaga el plan, pero requiere serializar plan completo preHandler→service |
| **Atomicidad débito↔refund** | ⚠️ débito en middleware, refund en route/service → 2 capas | ✅ débito y refund en el MISMO service, mismo scope, misma variable `debitedUsd` | ⚠️ igual que A |
| **Simetría con compose** | ✅ idéntica | ❌ rompe "middleware debita" (nice-to-have, no requisito — work-item DT-1) | ✅ idéntica |
| **Riesgo double-charge** | ⚠️ middleware debita + service podría re-debitar si mal coordinado | ✅ un solo punto de débito (el service); middleware NO debita | ⚠️ medio |
| **Coordinación middleware↔service** | baja | media (1 flag claro `skipMiddlewareDebit`) | alta (serializar el plan completo + chequear staleness) |
| **Early-fail sin gastar LLM** | ✅ nativo (budget check en middleware) | ⚠️ requiere pre-check explícito (resuelto abajo) | ✅ nativo |

**Justificación de B**: la operación más cara y lenta de orchestrate es
`discovery + llmPlan` (`orchestrate.ts:257-310`, LLM con timeout de 30s). La
Opción A/C la ejecutaría **dos veces** salvo que se serialice el plan completo
preHandler→service (Opción C), lo que introduce un riesgo de *staleness* (el plan
del preHandler puede diferir del re-planificado) y una superficie de coordinación
mayor. La Opción B concentra **débito + cálculo de monto + refund** en un único
scope (`orchestrateService.orchestrate`), donde la variable local `debitedUsd` es
la **única fuente de verdad** tanto para el débito como para el cómputo del refund
(AC-5/AC-6). Esto elimina por construcción el riesgo de double-charge y hace el
refund trivialmente consistente (AC-7). La simetría con compose es explícitamente
un nice-to-have en el work-item (DT-1), no un requisito funcional.

#### Señal de coordinación middleware↔service: `request.skipMiddlewareDebit`

Para que el middleware NO debite el placeholder $1 en orchestrate (y SÍ lo siga
haciendo en compose/master/gasless/x402, CD-5/CD-7), se introduce un flag
booleano de request augmentation **`request.skipMiddlewareDebit?: boolean`**,
seteado por un preHandler liviano de orchestrate (`markSkipMiddlewareDebitHandler`)
que corre ANTES de `requirePaymentOrA2AKey` (CD-8).

El middleware, en su path master (y SOLO en master — ver §4.6 sobre
delegación/session), envuelve **el bloque de débito** (`a2a-key.ts:847-893`,
desde la construcción de `debitResult` hasta el `send403` por insufficient
budget) en:

```
if (request.skipMiddlewareDebit) {
  // El service de orchestrate hará el débito post-plan (WKH-127).
  // Se SALTA el débito step-0 pero NO el resto del middleware:
  // lookup, is_active, daily-limit, per-call, signature, chain-resolve,
  // augment a2aKeyRow + resolvedChainId (necesarios para que el service debite).
} else {
  // débito actual intacto (compose/master/gasless)
}
```

**Crítico — qué NO se salta** cuando `skipMiddlewareDebit` está activo: el
middleware DEBE seguir ejecutando lookup de la key, `is_active`, chain-resolve
(`resolveTargetChain` → `request.resolvedChainId`), signature gate, y el augment
`request.a2aKeyRow = keyRow` (L919). El service necesita `a2aKeyRow.id`,
`a2aKeyRow.owner_ref` y `resolvedChainId` para debitar. Solo se salta el **paso 7
(optimistic debit, L831-893)** y el header `x-a2a-remaining-budget` post-débito
(L921-928, que ahora se setearía con un balance no-debitado → se mueve
conceptualmente al post-débito del service, ver Riesgos).

#### Early-fail sin gastar LLM (pre-check de balance barato)

Para no gastar discovery+LLM en un caller sin fondos (preservando la ventaja
nativa de A/C), el preHandler `markSkipMiddlewareDebitHandler` hace **además** un
pre-check barato: si la key es master (no session/delegation — ver §4.6) y
`request.a2aKeyRow` ya está disponible... **PROBLEMA DE ORDEN**: el preHandler de
skip corre ANTES del middleware, por lo que `a2aKeyRow` aún no existe.

**Resolución del orden (DT-1.1)**: el pre-check de balance se hace **dentro del
service**, al inicio de `orchestrateService.orchestrate`, ANTES de `discovery`:
un `budgetService.getBalance(scopingKeyRow.id, chainId, scopingKeyRow.owner_ref)`
(lectura barata, exemplar `budget.ts:39-61`); si el balance es `0` (o menor a un
épsilon), se retorna un `OrchestrateResult` graceful equivalente al de
"insufficient budget" SIN llamar discovery/LLM. Esto preserva el early-fail. El
pre-check solo aplica al **path master con Agent Key** (no x402: x402 no tiene
`scopingKeyRow` → se salta, AC-9; no session/delegation en el débito step-0 — ver
§4.6).

> Nota de honestidad arquitectónica: el early-fail de B es marginalmente más
> tardío que el de A (ocurre tras el lookup de la key en el middleware, no antes),
> pero es ANTES de discovery+LLM, que es el costo dominante. El trade-off es
> aceptable y está explícitamente documentado.

#### Flujo de débito en Opción B

1. `markSkipMiddlewareDebitHandler` (preHandler nuevo, antes del middleware) setea `request.skipMiddlewareDebit = true`. CD-8.
2. `requirePaymentOrA2AKey` corre: si es x402 → `runX402Fallback` intacto (no ve el flag, AC-9). Si es master Agent Key → hace TODO menos el débito step-0; augmenta `a2aKeyRow` + `resolvedChainId`.
3. El route handler llama `orchestrateService.orchestrate(...)` (sin cambios en la firma del call-site salvo propagar lo ya disponible).
4. El service: pre-check balance → discovery → llmPlan → calcula `plannedCostUsd = sum(agent.priceUsdc)` del plan seleccionado.
   - Si `steps.length === 0` → return graceful, **débito 0** (AC-2).
   - Si `plannedCostUsd === 0` → `plannedCostUsd = 1.0` + warn + `x-debit-fallback: registry-miss` (AC-4). El header se setea vía el `reply` propagado (ver §4.3).
5. El service debita `debitedUsd = plannedCostUsd` vía `budgetService.debit(scopingKeyRow.id, chainId, debitedUsd)` (ruta master, 3-arg — sin destino step-0, igual que hoy el middleware lo hacía). Si el débito falla (insufficient) → return graceful insufficient-budget, sin ejecutar compose.
6. El service ejecuta `composeService.compose(...)` (igual que hoy).
7. **Post-compose**: el service decide refund según AC-5/AC-6 (§4.4) usando `debitedUsd` (fuente de verdad) y `pipeline.totalCostUsdc`.

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `supabase/migrations/2026MMDD000000_wkh127_refund_a2a_key_spend.sql` | Crear | RPC `refund_a2a_key_spend` atómica (FOR UPDATE + ownership guard) | `20260609000000_wkh_sec02b_owner_ref_rpc.sql:20-101` |
| `supabase/migrations/2026MMDD000000_wkh127_refund_a2a_key_spend_down.sql` | Crear | `DROP FUNCTION IF EXISTS refund_a2a_key_spend(...)` (aditivo → down trivial) | `..._down.sql` patrón |
| `src/services/budget.ts` | Modificar | Agregar `credit(keyId, chainId, amountUsd, ownerRef)` que envuelve la RPC | ruta master de `debit()` L300-325 |
| `src/types/index.ts` | Modificar | (a) `refundError?: boolean` en `OrchestrateResult`; (b) confirmar `OrchestrateRequest` ya tiene lo necesario (no cambia) | `feeChargeError` L427 |
| `src/middleware/a2a-key.ts` | Modificar | (a) `skipMiddlewareDebit?: boolean` en el `declare module 'fastify'` (L57-68); (b) en el path master, envolver el bloque de débito step-0 (L847-893) en `if (!request.skipMiddlewareDebit)` | bloque de débito existente |
| `src/routes/orchestrate.ts` | Modificar | (a) agregar `markSkipMiddlewareDebitHandler` ANTES de `requirePaymentOrA2AKey` (L54); (b) propagar `reply`-driven header al service o leer el resultado del refund para `refundError`; el response ya hace spread de `...result` (L102) | `resolveComposePriceHandler` patrón de preHandler |
| `src/services/orchestrate.ts` | Modificar | Pre-check balance; calcular `plannedCostUsd`; debitar post-plan; post-compose refund (AC-5/AC-6); idempotencia por `orchestrationId`; `refundError` en el result | fee best-effort L435-482 |
| `src/services/orchestrate.test.ts` (o nuevo) | Crear/Modificar | Tests ≥1 por AC (§7) | tests existentes del service |
| `src/middleware/a2a-key.test.ts` | Modificar | T-MW-SKIP: con `skipMiddlewareDebit` → NO debita; sin él → debita $1 (regresión) | tests T-MW-COMPOSE existentes |

### 4.2 Modelo de datos — DT-2: RPC `refund_a2a_key_spend` (credit-back atómico)

**Decisión DT-2: crear una RPC NUEVA `refund_a2a_key_spend` (no reutilizar
`increment_a2a_key_spend` con signo negativo).** Razones:

1. Reutilizar `increment` con `-amount` rompería sus checks (`INSUFFICIENT_BUDGET`
   compara `v_current_bal < p_amount_usd` con `p_amount_usd` negativo → siempre
   pasa; `DAILY_LIMIT` con negativo no tiene sentido) y mezclaría semánticas
   débito/crédito en una sola función.
2. Una función explícita de refund permite documentar y testear las invariantes
   propias del credit-back: **no crear dinero** y revertir `daily_spent_usd`.

**Firma**: `refund_a2a_key_spend(p_key_id UUID, p_chain_id INT, p_amount_usd NUMERIC, p_owner_ref TEXT) RETURNS void`

**Invariantes obligatorias**:
- `FOR UPDATE` sobre la fila (CD-3, atomicidad).
- Ownership guard `owner_ref IS DISTINCT FROM p_owner_ref → OWNERSHIP_MISMATCH` (CD-4).
- `p_amount_usd > 0` (un refund nunca es negativo; si `<= 0` → no-op silencioso o RAISE — ver SQL).
- **No-crear-dinero / clamp del daily_spent**: `daily_spent_usd` se decrementa pero nunca por debajo de 0 (`GREATEST(daily_spent_usd - p_amount_usd, 0)`). El budget se incrementa por `p_amount_usd` (crédito directo). La idempotencia / anti-doble-refund se garantiza en la **capa de aplicación** (orchestrate, vía `orchestrationId` — §4.4), no en la RPC, porque la RPC es stateless respecto del request (igual que `increment` no es idempotente por sí misma).

> Decisión de scope sobre "no acreditar más de lo debitado": la RPC acredita
> exactamente `p_amount_usd`. La garantía de que `p_amount_usd <= debitedUsd` para
> ese request vive en `orchestrate.ts` (el caller calcula `refundUsd` como
> `min(debitedUsd, ...)` y nunca lo llama dos veces para el mismo
> `orchestrationId`). Esto es consistente con cómo `increment` confía en el
> call-site para el monto. **No** se intenta rastrear "lo debitado por request" en
> DB (sería sobre-ingeniería fuera de scope; no hay tabla de ledger por
> orchestration en step-0).

#### Exemplar SQL — UP (`refund_a2a_key_spend`)

```sql
-- ============================================================
-- Migration: 2026MMDD000000_wkh127_refund_a2a_key_spend
-- WKH-127 (AC-5/AC-6/AC-7, CD-3/CD-4): credit-back atómico para reembolsar el
-- débito step-0 de /orchestrate cuando el pipeline falla. Espejo INVERSO de
-- increment_a2a_key_spend (20260609000000): FOR UPDATE + Ownership Guard, pero
-- acredita budget y revierte daily_spent (clamp a 0). Aditiva: el down dropea.
-- ============================================================

CREATE OR REPLACE FUNCTION refund_a2a_key_spend(
  p_key_id     UUID,
  p_chain_id   INT,
  p_amount_usd NUMERIC,
  p_owner_ref  TEXT
) RETURNS void AS $$
DECLARE
  v_row          a2a_agent_keys%ROWTYPE;
  v_chain_key    TEXT;
  v_current_bal  NUMERIC;
  v_new_bal      NUMERIC;
  v_new_daily    NUMERIC;
BEGIN
  -- CD-3: lock atómico (mismo estilo que increment_a2a_key_spend).
  SELECT * INTO v_row
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  -- CD-4: Ownership Guard DB-level (defensa en profundidad; service usa SERVICE_ROLE).
  IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;

  -- Un refund nunca es negativo ni cero. Defensivo: no-op si <= 0.
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RETURN;
  END IF;

  -- Credit budget for the chain (inverso del débito de increment).
  v_chain_key   := p_chain_id::TEXT;
  v_current_bal := COALESCE((v_row.budget ->> v_chain_key)::NUMERIC, 0);
  v_new_bal     := v_current_bal + p_amount_usd;

  -- AC-7: revertir el incremento del daily_spent, clamp a 0 (no crear "deuda").
  v_new_daily := GREATEST(v_row.daily_spent_usd - p_amount_usd, 0);

  UPDATE a2a_agent_keys
  SET
    budget          = jsonb_set(budget, ARRAY[v_chain_key], to_jsonb(v_new_bal::TEXT)),
    daily_spent_usd = v_new_daily,
    last_used_at    = NOW()
  WHERE id = p_key_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Hardening (consistente con los RPCs hermanos, 20260609000000:95-101).
ALTER FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  TO service_role;
```

#### Exemplar SQL — DOWN (reversible)

```sql
-- WKH-127 down: la RPC es 100% aditiva (no reemplaza ninguna función previa),
-- por lo que el rollback es un simple DROP. Reversibilidad total (sin overloads
-- huérfanos, ref auto-blindaje WKH-125 BLQ-MED-1).
DROP FUNCTION IF EXISTS refund_a2a_key_spend(uuid, integer, numeric, text);
```

### 4.3 Componentes / Servicios

**`budgetService.credit()`** (en `budget.ts`) — espejo de la ruta master de `debit()`:
- Firma: `credit(keyId: string, chainId: number, amountUsd: number, ownerRef: string): Promise<{ success: boolean; error?: string }>`.
- A diferencia de `debit()` (que hace SELECT cold-path para derivar owner_ref), `credit()` recibe `ownerRef` **explícito como argumento** (el caller orchestrate ya lo tiene en `scopingKeyRow.owner_ref`) → evita un SELECT extra y refuerza CD-4 (ownerId obligatorio, `string` no `string | undefined`).
- Llama `supabase.rpc('refund_a2a_key_spend', { p_key_id, p_chain_id, p_amount_usd, p_owner_ref })`.
- Mapeo de error sin propagar msg crudo de PG (CD-6): `OWNERSHIP_MISMATCH` y `KEY_NOT_FOUND` → códigos estables; cualquier otro → `console.error('[budget] refund failed', {...})` + `{ success: false, error: 'REFUND_FAILED' }`.

**`orchestrateService.orchestrate()`** (en `orchestrate.ts`) — cambios:
1. **Pre-check balance** (early-fail) al inicio, antes de discovery: si `scopingKeyRow` presente (master Agent Key) y `getBalance === 0` → return graceful sin gastar LLM.
2. **Cálculo de `plannedCostUsd`**: en el LLM path, reutilizar `totalCost` ya calculado (L330-339); en greedy path, sumar `selected[].priceUsdc`. Refactor mínimo: exponer la suma como una variable local del scope `orchestrate`. Fallback $1 si `plannedCostUsd === 0` (AC-4) + `warn` + header.
3. **Débito post-plan**: si `scopingKeyRow` presente y `steps.length > 0`, llamar `budgetService.debit(scopingKeyRow.id, chainId, debitedUsd)` (3-arg master). Si falla → return graceful insufficient.
4. **Post-compose refund**: §4.4.

> Header `x-debit-fallback: registry-miss`: orchestrate hoy no propaga `reply` al
> service. Para AC-4 se opta por que el **service devuelva una señal**
> (`debitFallback: true` en un campo interno del result o un flag) y el **route
> handler** (que sí tiene `reply`) setee el header. Alternativa equivalente:
> propagar `reply` al service (como hace gasless en `gasless.ts`). **Decisión**:
> el route handler setea el header leyendo un flag del result (menos acoplamiento
> service↔reply). Detalle exacto del flag se fija en F2.5; ambas opciones son
> SDD-consistentes y no inventan APIs.

### 4.4 Flujo principal (Happy Path) y lógica de refund (DT-3)

**Happy path (pipeline exitoso, AC-11)**:
1. Pre-check balance > 0 → discovery → plan → `debitedUsd = plannedCostUsd` debitado.
2. `composeService.compose` → `pipeline.success === true`, `pipeline.totalCostUsdc > 0`.
3. **NO refund** (CD-2). Fee 1% success-gated se aplica (intacto, L437).
4. Response: `{ kiteTxHash, ...result }` sin `refundError`.

**Lógica de refund post-compose (DT-3, AC-5/AC-6/AC-7)** — vive en `orchestrate.ts` tras `composeService.compose`:

```
// Pseudocódigo de decisión (NO es código de producción)
refundUsd = 0
if (scopingKeyRow && !pipeline.success) {       // solo master Agent Key (AC-9: x402 no entra)
  if (pipeline.totalCostUsdc === 0) {
    refundUsd = debitedUsd                       // AC-5 fallo total
  } else {
    refundUsd = max(0, debitedUsd - pipeline.totalCostUsdc)  // AC-6 fallo parcial
  }
}
if (refundUsd > 0) {
  result = await budgetService.credit(scopingKeyRow.id, chainId, refundUsd, scopingKeyRow.owner_ref)
  if (!result.success) {
    log('[orchestrate.refund-failed]', { keyId, chainId, amountUsd: refundUsd, orchestrationId })  // AC-8
    refundError = true
  }
}
```

**Idempotencia / anti-doble-refund**: el refund se ejecuta UNA sola vez por
invocación de `orchestrate()` (un único `orchestrationId` por request, generado en
`orchestrate.ts:61`). No hay reintentos internos. El `refundUsd` se computa una
vez de `debitedUsd` (variable local del scope, fuente de verdad) y `credit()` se
llama a lo sumo una vez. No existe path que llame `orchestrate()` dos veces con el
mismo `orchestrationId` (es `crypto.randomUUID()` fresco por request). Por tanto
**no se requiere un guard de idempotencia en DB** para el step-0; documentarlo
como invariante en el SDD y testearlo (T-AC-DOUBLE).

### 4.5 Flujo de error

1. **Caller sin fondos (pre-check)**: balance 0 → graceful result, sin discovery/LLM, sin débito.
2. **Débito post-plan falla (insufficient)**: graceful result insufficient-budget, sin ejecutar compose.
3. **Pipeline falla total (AC-5)**: refund `debitedUsd` → budget restaurado (AC-7).
4. **Pipeline falla parcial (AC-6)**: refund `max(0, debitedUsd - totalCostUsdc)`.
5. **Refund falla (AC-8)**: log `[orchestrate.refund-failed]` + `refundError: true` en body, sin msg crudo de PG (CD-6). El usuario recibe su error de orquestación + el flag para reconciliación manual.
6. **x402 caller (AC-9)**: `scopingKeyRow` undefined → ni débito post-plan ni refund (path pre-WKH-127 intacto).

### 4.6 Aplicabilidad a delegación / session keys (resuelve Missing Input)

**Decisión**: el débito post-plan y el credit-back del step-0 aplican **solo al
path master key**. Bajo delegación/session, el step-0 hoy se debita en el
middleware vía `debitDelegationAndParent` / `debitSessionAndParent`
(`a2a-key.ts:293+` y `:297+`), que actualizan contadores `total_spent` /
`spent_usd` de la delegación/sesión además del budget de la parent key.
Reembolsar eso requeriría revertir también esos contadores (fuera de scope,
work-item Scope OUT: "el credit-back se aplica solo en el path master key de
orchestrate (step-0)").

**Implicación de diseño para `skipMiddlewareDebit`**: el flag se respeta **solo en
el path master** del middleware. En los branches delegación/session el flag se
**ignora** (el débito step-0 sigue ocurriendo en el middleware como hoy). Esto
implica que, bajo delegación/session, orchestrate **no** debita el costo real
post-plan (sigue el placeholder $1 del middleware) y **no** reembolsa. Es una
limitación conocida y explícita (consistente con Scope OUT). El pre-check de
balance y el débito post-plan del service se **gatean por `scopingKeyRow` presente
Y `delegationContext`/`keySessionContext` ausentes**.

> Esto evita un double-charge: si el middleware ya debitó bajo delegación, el
> service NO debe re-debitar. El gate `!delegationContext && !keySessionContext`
> en el service es la defensa.

---

## 5. Constraint Directives (heredados + nuevos)

### Heredados del work-item (sin cambios)

- **CD-1** — PROHIBIDO tocar el guard `i>0` anti-double-charge de `compose.ts`.
- **CD-2** — PROHIBIDO revenue leak en pipeline exitoso (`success===true` con `totalCostUsdc>0` NUNCA recibe refund). Regresión = BLOQUEANTE en AR.
- **CD-3** — OBLIGATORIO atomicidad del credit-back (FOR UPDATE, estilo `increment_a2a_key_spend`).
- **CD-4** — OBLIGATORIO Ownership Guard (`p_owner_ref`) en la RPC de refund y en `credit()`.
- **CD-5** — PROHIBIDO tocar `runX402Fallback`.
- **CD-6** — PROHIBIDO propagar msg crudo de PG al cliente; `refundError` es un boolean.
- **CD-7** — PROHIBIDO modificar `compose.ts` (route/service) salvo lo estrictamente necesario (en este SDD: NADA de compose se toca — el débito post-plan vive en orchestrate).
- **CD-8** — OBLIGATORIO: el preHandler nuevo (`markSkipMiddlewareDebitHandler`) corre ANTES de `requirePaymentOrA2AKey`.

### Nuevos (específicos de este SDD)

- **CD-9** — OBLIGATORIO: el flag `skipMiddlewareDebit` solo suprime el débito en el **path master** del middleware. En delegación/session el flag se IGNORA (el débito step-0 sigue en el middleware). El service debita post-plan SOLO si `scopingKeyRow` presente Y `delegationContext`/`keySessionContext` ausentes (evita double-charge).
- **CD-10** — OBLIGATORIO: `credit()` recibe `ownerRef: string` (NO `string | undefined`) como argumento explícito (refuerzo CD-4, paridad con el patrón Ownership Guard de CLAUDE.md).
- **CD-11** — PROHIBIDO debitar dos veces el step-0: el débito vive EXCLUSIVAMENTE en el service (path master con skip activo) o EXCLUSIVAMENTE en el middleware (delegación/session/compose). Nunca ambos.
- **CD-12** — OBLIGATORIO: la RPC de refund debe ser ADITIVA (CREATE de una función nueva, sin DROP de funciones previas). El down es un `DROP FUNCTION IF EXISTS`. **No** usar `CREATE OR REPLACE` que cambie aridad de una función existente (ref auto-blindaje WKH-125 BLQ-MED-1 — recurrente ≥3 HUs).
- **CD-13** — OBLIGATORIO: hardening de la RPC nueva (`SET search_path = public, pg_temp` + `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role`), espejo de los RPCs hermanos (`20260609000000:95-101`).
- **CD-14** — PROHIBIDO crear dinero: el refund nunca acredita más que `debitedUsd` del request; `daily_spent_usd` se clampa con `GREATEST(..., 0)` en la RPC.
- **CD-15** — OBLIGATORIO: el pre-check de balance y el débito post-plan se saltan si `scopingKeyRow` es undefined (caller x402 → AC-9 intacto).

### OBLIGATORIO seguir (patrones)

- RPC: copiar la estructura de `increment_a2a_key_spend` (`20260609000000:20-101`).
- `credit()`: seguir la ruta master de `debit()` (`budget.ts:300-325`).
- Manejo de error que no rompe response: seguir el fee best-effort (`orchestrate.ts:435-482`).
- Spread condicional `refundError`: seguir `feeChargeError` (`orchestrate.ts:513-514`).

---

## 6. Scope

**IN**: `src/routes/orchestrate.ts`, `src/middleware/a2a-key.ts` (flag + skip del
débito master), `src/services/orchestrate.ts` (pre-check + débito post-plan +
refund), `src/services/budget.ts` (`credit()`), `src/types/index.ts`
(`skipMiddlewareDebit`, `refundError`), 2 archivos de migración (up+down), tests.

**OUT**: `src/routes/compose.ts`, `src/services/compose.ts`, `runX402Fallback`,
`chargeProtocolFee` internals, escrow WKH-126, débitos per-step (steps 1..N),
refund bajo delegación/session (§4.6), guard de idempotencia en DB (no necesario,
§4.4).

---

## 7. Test Plan (≥1 test por AC — 11 ACs)

| Test (id sugerido) | AC | Archivo | Qué verifica |
|--------------------|----|---------|--------------|
| T-AC1-real-price | AC-1 | `orchestrate.test.ts` | plan con 2 agentes ($0.30+$0.20) → `debit()` llamado con $0.50, NO $1 |
| T-AC2-zero-steps | AC-2 | `orchestrate.test.ts` | `steps.length===0` → `debit()` NUNCA llamado (spy 0 calls) |
| T-AC3-uses-real-cost | AC-3 | `orchestrate.test.ts` | el monto debitado == `sum(plan priceUsdc)`, no el placeholder |
| T-AC4-zero-cost-fallback | AC-4 | `orchestrate.test.ts` | plan con todos `priceUsdc===0` → debita $1 + warn + header `x-debit-fallback: registry-miss` |
| T-AC5-total-fail-refund | AC-5 | `orchestrate.test.ts` | `success===false` + `totalCostUsdc===0` → `credit()` llamado con `debitedUsd` (regresión del incidente real) |
| T-AC6-partial-fail-refund | AC-6 | `orchestrate.test.ts` | `success===false` + `totalCostUsdc=0.20`, `debited=0.50` → `credit()` con $0.30; y caso `totalCostUsdc>=debited` → `credit()` NO llamado |
| T-AC7-budget-restored | AC-7 | `budget` RPC test / service test | tras refund total, `budget[chainId]` == valor previo al débito y `daily_spent` revertido (clamp 0) |
| T-AC8-refund-error-flag | AC-8 | `orchestrate.test.ts` | `credit()` rechaza → log `[orchestrate.refund-failed]` (con keyId/chainId/amountUsd/orchestrationId) + `refundError:true` en body, sin msg PG |
| T-AC9-x402-no-refund | AC-9 | `orchestrate.test.ts` | caller sin `scopingKeyRow` (x402) → ni `debit()` post-plan ni `credit()` (spies 0 calls) |
| T-AC10-compose-intact | AC-10 | `compose.test.ts` (regresión, sin modificar lógica) | `resolveComposePriceHandler` + débito step-0 de compose siguen igual; orchestrate no afecta compose |
| T-AC11-success-no-refund | AC-11 | `orchestrate.test.ts` | `success===true` + `totalCostUsdc>0` → `credit()` NUNCA llamado (CD-2); fee 1% success-gated aplicado |
| T-AC-DOUBLE-refund | CD-11/§4.4 | `orchestrate.test.ts` | un solo `orchestrate()` → `credit()` llamado a lo sumo 1 vez (anti-doble-refund) |
| T-MW-SKIP-on | CD-9 | `a2a-key.test.ts` | master key + `skipMiddlewareDebit=true` → `debit()` del middleware NO llamado; `a2aKeyRow`+`resolvedChainId` SÍ augmentados |
| T-MW-SKIP-off | CD-9 (regresión) | `a2a-key.test.ts` | master key sin el flag (compose/legacy) → debita $1 (o composeEstimatedCostUsd) como hoy |
| T-MW-SKIP-deleg-ignored | CD-9/§4.6 | `a2a-key.test.ts` | branch delegación/session IGNORA el flag → débito step-0 ocurre en el middleware (no double-charge con el service) |
| T-RPC-refund-atomic | CD-3/CD-4/CD-14 | migración / e2e DB (opt-in) | `refund_a2a_key_spend` acredita budget, clampa daily_spent a 0, y rechaza `OWNERSHIP_MISMATCH` con owner_ref incorrecto |

> Framework: vitest. Los tests de RPC contra DB real siguen el patrón opt-in de
> `*.real.test.ts` (skippean sin credenciales), como `delegation-atomicity.real.test.ts`.

---

## 8. Waves de implementación

| Wave | Qué | Archivos | Depende de |
|------|-----|----------|-----------|
| **W0 (serial gate)** | Tipos: `skipMiddlewareDebit` + `refundError`; migración SQL up+down de `refund_a2a_key_spend` | `src/types/index.ts`, `src/middleware/a2a-key.ts` (solo el `declare module`), 2 migraciones | — |
| **W1** | `budgetService.credit()` envolviendo la RPC | `src/services/budget.ts` | W0 (tipos + RPC) |
| **W2** | Middleware: skip del débito master bajo `skipMiddlewareDebit` (master only, ignora deleg/session) | `src/middleware/a2a-key.ts` | W0 |
| **W3** | Orchestrate route: `markSkipMiddlewareDebitHandler` ANTES del middleware; header fallback; spread `refundError` | `src/routes/orchestrate.ts` | W2 |
| **W4** | Orchestrate service: pre-check balance + `plannedCostUsd` + débito post-plan + refund AC-5/AC-6 + idempotencia + `refundError` | `src/services/orchestrate.ts` | W1, W2, W3 |
| **W5** | Tests (todos los de §7) | `orchestrate.test.ts`, `a2a-key.test.ts`, `*.real.test.ts` | W1-W4 |

W0 es serial (contratos/tipos/RPC). W1 y W2 son paralelizables entre sí tras W0.

---

## 9. Riesgos

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|-----------|
| Double-charge step-0 (middleware + service ambos debitan) | M | A (path de dinero) | CD-9/CD-11: skip solo en master; service gatea por `!delegationContext && !keySessionContext`; T-MW-SKIP-deleg-ignored |
| Revenue leak: refund en pipeline exitoso | B | A | CD-2: refund solo si `!pipeline.success`; T-AC11 lo cubre; AR BLOQUEANTE |
| Header `x-a2a-remaining-budget` queda con balance pre-débito (skip salta L921-928) | M | B | El service, tras debitar, puede setear/recalcular el header vía el route handler post-orchestrate, o se documenta que el header refleja el saldo post-débito real. Resolver detalle en F2.5 |
| `CREATE OR REPLACE` con cambio de aridad genera overload huérfano | B | A | CD-12: RPC 100% aditiva, sin DROP de previas; down = DROP IF EXISTS (ref WKH-125 BLQ-MED-1) |
| Refund crea "deuda" en daily_spent (negativo) | B | M | CD-14: `GREATEST(daily_spent - amount, 0)` en la RPC |
| Early-fail de B más tardío que A (gasta lookup antes de fallar) | B | B | Pre-check de balance en el service ANTES de discovery/LLM (el costo dominante); documentado en §4.0 |
| Biome formatter rompe el check en aserciones largas de los tests | M | B | Ref auto-blindaje WKH-125b: escribir aserciones `Number(...)` ya multilínea; correr `biome check` sobre los archivos tocados antes de cerrar W5 |

## 10. Dependencias

- WKH-59 (real-price-debit compose, DONE) — exemplar del preHandler de precio.
- WKH-SEC-02b (owner_ref RPC, DONE) — exemplar exacto de la RPC atómica.
- WKH-101/121 (delegation/session billing, DONE) — define los branches que el flag debe ignorar.
- No correr en paralelo con HUs que toquen `a2a-key.ts` o `budget.ts`.

## 11. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| (ninguno) | — | DT-1 resuelto (Opción B, §4.0); RPC definida (§4.2); aplicabilidad deleg/session resuelta (§4.6) | No |
| [TBD-F2.5] | §4.3, §9 | Mecánica exacta del header (`x-debit-fallback` y `x-a2a-remaining-budget`): flag-en-result + route setea, vs propagar `reply` al service. Ambas SDD-consistentes, sin inventar APIs. Se fija en el Story File | No (no bloquea SPEC_APPROVED) |

> Gate: no quedan `[NEEDS CLARIFICATION]`. El único `[TBD-F2.5]` es de detalle de
> implementación (no de negocio) y se resuelve en F2.5 con dos opciones ya
> acotadas.

---

## Readiness Check

```
READINESS CHECK (WKH-127):
[x] Cada AC (1-11) tiene >=1 archivo asociado en tabla 4.1 y >=1 test en §7
[x] Cada archivo en 4.1 tiene Exemplar verificado con Read/Glob (paths reales)
[x] No hay [NEEDS CLARIFICATION] pendientes (DT-1 resuelto: Opción B)
[x] Constraint Directives: 8 heredados + 7 nuevos (>=3 PROHIBIDO)
[x] Context Map: 7 archivos leídos + estado BD verificado
[x] Scope IN/OUT explícitos y no ambiguos
[x] BD: tabla a2a_agent_keys y RPC increment verificadas; RPC refund definida con SQL up+down
[x] Happy Path completo (§4.4) + Flujo de error completo (§4.5, 6 casos)
[x] DT-1 (corazón del SDD) decidido con justificación técnica explícita (§4.0)
[x] RPC credit-back: nombre, firma, SQL up+down, atomicidad, ownership guard, anti-crear-dinero (§4.2)
[x] Idempotencia/anti-doble-refund resuelta (§4.4) + test (T-AC-DOUBLE)
[x] Auto-blindaje histórico aplicado: WKH-125 BLQ-MED-1 (overload) → CD-12; WKH-125b (biome) → Riesgos
```

---

*SDD generado por NexusAgil — F2 (FULL/BUGFIX) — WKH-127*
