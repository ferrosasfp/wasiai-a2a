# SDD #171: [WKH-189] Panel + endpoint de revisión/override de `arb_hold`

> SPEC_APPROVED: no
> Fecha: 2026-07-12
> Tipo: feature (money-path, alta sensibilidad — mueve fondos por decisión humana admin)
> SDD_MODE: full
> Branch: feat/171-wkh-189-arb-hold-override
> Artefactos: doc/sdd/171-wkh-189-arb-hold-override/
> Depende de: WKH-139 v2 (fila 145, DONE) — `arbiter.ts`, `types/arbiter.ts`, migración `20260704100000_wkh139_arbiter.sql`, `payments.ts` ya en `main`.

---

## 1. Resumen

WKH-139 v2 dejó los intents `session` sobre-tope o irresolubles en estado
`arb_hold` (congelados, cero fondos movidos), con la promesa de "revisión
humana" (default ratificado #4) que **hoy no existe en código**. Esta HU
construye el **Bloque A**: un endpoint admin-gated para (1) **listar** los holds
pendientes con su evidencia persistida y (2) **resolverlos**
(`release`/`refund`/`split`), **reusando el mismo seam de settle/refund del
árbitro autónomo** (`executeArbitration`, CD-1), más un panel en el dashboard
existente.

El override es un camino **adicional** gateado por `X-Admin-Token`
(`requireAdminToken` de `dashboard.ts`) + el flag `ARBITER_ENABLED`. No toca el
auto-path (rules/LLM/cap). Reusa: el RPC `close_payment_intent_for_arbitration`
(ensanchado additive para aceptar `arb_hold`, DT-1), `settlePaymentIntentOnChain`,
`record_settle_outcome`, `finalize_payment_intent`, `receiptService.emit`, el
testnet-guard `TESTNET_CHAIN_IDS` y el patrón de recovery (`applyRecovery`) — todo
byte-idéntico. El humano ya está en el loop → **el `ARBITER_AUTO_CAP_USD` NO
aplica** al override; el único límite es el clamp `[0, deposit]` ("no crear
plata").

Invariantes money-path preservadas: exactly-once vía status-gate a nivel DB
(`FOR UPDATE` en el RPC), fail-closed, ownership guard (`owner_ref` leído del row
real del intent, nunca del request), testnet-only.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 171 (WKH-189) |
| **Tipo** | feature / billing / money-path / admin-privileged |
| **SDD_MODE** | full |
| **Objetivo** | Endpoint + panel admin para revisar/resolver `arb_hold` reusando el seam de settle del árbitro, sin cap, testnet-only, exactly-once, ownership-guarded. |
| **Scope IN / OUT** | Ver §6. |
| **ACs** | 8 EARS (§2.1). |
| **Missing Inputs** | Los 3 `[NEEDS CLARIFICATION]` del work-item se resuelven acá con defaults conservadores (§10). Cero markers abiertos. El único bloqueante era de grounding (ticket Jira ilegible) — resuelto por el orquestador con la descripción detallada. |

### 2.1 Acceptance Criteria (EARS) — trazados a §7 (waves) y §9 (tests)

- **AC-1**: `GET` admin-gated lista los `arb_hold` con evidencia (`decision`,
  `method`, `ambiguity_reason`, `at_stake_usd`, `chain_id`, `created_at`,
  `intent_id`). → W1 (`listHolds`), W2 (route), T-1.
- **AC-2**: `POST` de resolución sobre un `arb_hold` con decisión válida ejecuta
  el desenlace vía `executeArbitration`, transicionando
  `arb_hold → arb_closing → settled|refunded|failed`. → W0 (RPC), W1
  (`resolveHold`), W2 (route), T-2/T-8.
- **AC-3**: el override emite recibo inmutable (`receiptTypeFor(decision)`) y
  persiste `method='admin_override'`, `resolved_by`, `resolved_at`,
  `resolution_note`, preservando `ambiguity_reason`/`llm_reasoning` del hold
  original. → W0 (columnas), W1 (`upsertArbitrationRow` extendido), T-3.
- **AC-4**: si el intent no está en `arb_hold` (resuelto/inexistente/otro
  estado) → rechazo explícito (404/409) SIN mover fondos. → W1 + RPC status-gate,
  T-4.
- **AC-5**: sin `X-Admin-Token` válido → rechazo de lectura y resolución
  (401/403) sin filtrar datos ajenos ni ejecutar override. → W2
  (`requireAdminToken`), T-5.
- **AC-6**: si el intent resuelve a chain no-testnet → rechazo fail-closed
  (defensa en profundidad, replica `arbiter.ts:303-305`). → W1, T-6.
- **AC-7**: clamp del monto forzado a `[0, authorized_usd]`, nunca > deposit
  (mismo clamp del RPC). → W0 (RPC) + W1, T-7.
- **AC-8**: WHILE `ARBITER_ENABLED !== 'true'` → negar panel/endpoints (404
  byte-idéntico, sin filtrar existencia de disputas). → W2, T-9.

---

## 3. Context Map — archivos leídos y patrón extraído

| Archivo (líneas) | Por qué | Patrón extraído |
|---|---|---|
| `src/services/arbiter.ts` (1-805) | Seam de settle/refund (CD-1) | `executeArbitration(intentId, ownerRef, settleUsd, meta, allowStaleRecovery=false)` es el ÚNICO choke-point del monto forzado. `ArbMeta` (L193-201). `upsertArbitrationRow` (L208-243) es el único write a `a2a_arbitrations`. `emitAndRecord` (L762-783) emite recibo + upsert. `TESTNET_CHAIN_IDS` (L44, module-private). `holdArbitration` (L728-758) transiciona `disputed→arb_hold` status-gated. `applyRecovery` (L586-643) exactly-once. `receiptTypeFor` (L173-178). `isArbiterEnabled` (L65-67). |
| `supabase/migrations/20260704100000_wkh139_arbiter.sql` (1-382) | RPC a ensanchar (DT-1) | `close_payment_intent_for_arbitration` (L144-230): predicado `IF v_status = 'disputed'` (L192) → transición a `arb_closing` + clamp `GREATEST(0, LEAST(v_auth, p_arb_amount))` (L190). Patrón "Option B" ya aplicado a `record_settle_outcome`/`finalize_payment_intent` (L233-372, gate `IN ('closing','arb_closing')`). `a2a_arbitrations` (L43-56): `method` CHECK `IN ('rules','llm','hold')` (L48), sin columnas de auditoría humana. Índice UNIQUE `uq_a2a_arbitrations_intent` (L60). Convención `ALTER FUNCTION ... SET search_path` + `REVOKE`/`GRANT service_role`. |
| `supabase/migrations/20260704100000_wkh139_arbiter_down.sql` (1-60+) | Patrón del down | `BEGIN;` ... `DROP FUNCTION IF EXISTS ... (uuid,text,numeric)`; restaura RPCs con cuerpo verbatim; restaura CHECKs. |
| `src/routes/dashboard.ts` (1-143) | Auth admin + registro | `requireAdminToken` (L30-60): `timingSafeEqual`, fail-closed en prod si `DASHBOARD_ADMIN_TOKEN` unset (503), 401 si header ausente/inválido. Rutas bajo prefijo `/dashboard` (index.ts:167). Patrón `{ config: { rateLimit: false }, preHandler: requireAdminToken }`. Error handler: mensaje estático, detalle a `request.log.error`. |
| `src/routes/payments.ts` (1-373) | Gate flag + error map | `POST /session/:id/dispute` (L289-325): `if (!isArbiterEnabled()) return 404` como PRIMERA línea (CD-11/AC-8). `sendArbiterError` (L78-99): mapa `ArbiterError.code → HTTP` disclosure-safe. `GET /session/:id/dispute` (L328-373) owner-scoped (no sirve para admin cross-tenant). |
| `src/types/arbiter.ts` (1-72) | Tipo a extender | `ArbiterMethod = 'rules' \| 'llm' \| 'hold'` (L17). `ArbiterErrorCode` (L20-27) ya tiene `INVALID_INPUT`/`CHAIN_NOT_SUPPORTED`/`INTENT_NOT_FOUND`/`INTENT_NOT_OPEN`/`OWNERSHIP_MISMATCH`/`INTERNAL` — suficiente, no se agregan códigos. |
| `src/types/receipt.ts` (18-25) | Tipos de recibo | `arbitration_release/refund/split/hold` ya existen — el override NO agrega tipos nuevos (AC-3 reusa `receiptTypeFor`). |
| `src/services/payment-intent.ts` (1139-1237) | Riesgo del ensanche | `expireStale` sweepea SOLO `status='arb_closing'` (L1177) → `recoverArbClosing`, y `status='disputed'` (L1192) → `revertDisputeToOpen`. NO sweepea `arb_hold`. `recoverArbClosing` (arbiter.ts:650-693) guarda `prev_status !== 'arb_closing' return` (L668). Ver §8 (Riesgos). |
| `src/static/dashboard.html` (1-278) | Panel a extender | Pico CSS, secciones `<h3 class="section-title">` + `<div id="...">`. Helper `fetchJSON(url)` (L156-165) SIN headers → los fetch actuales NO mandan `X-Admin-Token` (funciona en dev con token unset). `esc()` (L140-145) para XSS. `refreshAll()` (L267). |
| `src/index.ts` (150-167) | Registro | `dashboardRoutes` en prefijo `/dashboard`. `arbiter.ts` ya se importa desde `payments.ts`. |

---

## 4. Decisiones técnicas (DT-N)

**DT-1 (RPC — NO se crea uno nuevo)**: se ensancha
`close_payment_intent_for_arbitration` siguiendo "Option B": el predicado
`IF v_status = 'disputed'` (migración L192) pasa a
`IF v_status IN ('disputed','arb_hold')` en la rama que transiciona a
`arb_closing`. Todo lo demás (clamp `[0,deposit]`, persistencia en
`consumed_usd`, rama recovery `arb_closing`, forma de retorno) queda
**byte-idéntico**. Razón: ese RPC es el único choke-point del monto forzado
(`FOR UPDATE` + owner guard + clamp); duplicarlo violaría CD-1 y crearía dos
caminos de exactly-once. `record_settle_outcome`/`finalize_payment_intent` NO se
tocan (CD-6) — siguen gateados en `IN ('closing','arb_closing')`, y el flujo del
override entra a `arb_closing` igual que el auto-path, así que ambos ya lo
aceptan sin cambios.

**DT-2 (seam de servicio)**: nueva función
`arbiterService.resolveHold(intentId, { decision, splitPct, resolvedBy, note })`.
NO reimplementa settle/refund: lee el row real del intent (para `owner_ref`,
`chain_id`, `authorized_usd`, `seller_ref`, `status`), lee la fila de
`a2a_arbitrations` original (para preservar `ambiguity_reason`/`llm_reasoning`),
re-valida testnet (AC-6), computa `settleUsd` clampeado sin cap (AC-7), construye
`ArbMeta` con `method='admin_override'` + campos de auditoría humana, y **delega
en `executeArbitration`** (allowStaleRecovery=false). La transición
`arb_hold→arb_closing` la hace el RPC bajo `FOR UPDATE` (CD-3): resolveHold NO
hace ningún `UPDATE` de status en la app.

**DT-3 (residual del split manual — resuelve el NEEDS CLARIFICATION del F1)**:
para `split` el admin pasa `splitPct` = **porcentaje que va al Seller** (0-100).
`settleUsd = clamp(deposit * splitPct / 100, 0, deposit)`. El **residual =
deposit − settleUsd** se reembolsa al Buyer por el MISMO primitivo que el
auto-path: `finalize_payment_intent` con `p_residual > 0` dispara
`refund_a2a_key_spend` (migración L336-337). Es decir, el residual NO se maneja
en `resolveHold` — se hereda 1:1 de `executeArbitration` (que ya computa
`residualMicro = depositMicro − arbMicro`, arbiter.ts:441). `release` = `splitPct
efectivo 100`, `refund` = `splitPct efectivo 0`; los tres desenlaces son casos
del mismo cómputo. Semántica idéntica al split del LLM (arbiter.ts:381-387).

**DT-4 (auth = `requireAdminToken`)**: shared-secret `X-Admin-Token` ya usado en
`dashboard.ts`. No se construye auth nueva. `resolved_by`/`resolution_note` son
auditoría best-effort (texto libre del admin), NO identidad criptográfica —
mismo nivel de garantía que el token compartido (limitación conocida, Scope OUT).

**DT-5 (fuente de verdad del listado)**: la lista de holds se deriva de
`a2a_payment_intents WHERE status='arb_hold'` (el estado money-real, autoritativo),
con embed de `a2a_arbitrations` (evidencia, best-effort). NO se lista desde
`a2a_arbitrations.status='held'` como fuente primaria, porque ese upsert es
best-effort y podría faltar; el hold real vive en el intent. Se usa el embed FK
de PostgREST (`a2a_arbitrations` referencia `a2a_payment_intents(id)`).

**DT-6 (persistencia de auditoría humana)**: se extiende `ArbMeta` con
`resolvedBy: string \| null`, `resolvedAt: string \| null`,
`resolutionNote: string \| null` (default `null` en el auto-path) y
`upsertArbitrationRow` los escribe. Un solo choke-point de escritura a
`a2a_arbitrations` (CD-1 en espíritu: no duplicar el write). El auto-path pasa
`null` → columnas quedan NULL (additive, sin cambio de comportamiento).

**DT-7 (gate del flag)**: `isArbiterEnabled()` como PRIMERA línea de cada handler
(igual que `payments.ts:295`), devolviendo 404 byte-idéntico (AC-8/CD-7). El
`requireAdminToken` (preHandler) corre antes; para un caller sin token el 401 es
el comportamiento estándar del dashboard y no revela nada específico de disputas.

---

## 5. Constraint Directives (CD-N)

Heredados del work-item (CD-1..CD-7) + endurecimientos del SDD (CD-8..CD-12):

**CD-1**: OBLIGATORIO reusar el seam vía `executeArbitration`. PROHIBIDO clonar
settle/refund/finalize/emit-recibo para el override.

**CD-2**: PROHIBIDO debilitar `TESTNET_CHAIN_IDS` o `ARBITER_AUTO_CAP_USD` del
auto-path. El override es camino adicional gateado por admin, NO un bypass de esas
protecciones para rules/LLM.

**CD-3**: OBLIGATORIO exactly-once vía status-gate DB. El override SOLO transiciona
`arb_hold` bajo el `FOR UPDATE` del RPC. PROHIBIDO `UPDATE` de status en la app
antes del RPC (la lectura de status en `resolveHold` es advisory, no mutante).

**CD-4**: OBLIGATORIO Ownership Guard: `owner_ref` se lee del row real del intent
y se pasa así a `executeArbitration`/RPC. NUNCA se construye/acepta desde el
request del admin.

**CD-5**: OBLIGATORIO documentar el scope privilegiado: `GET` de listado es
**intencionalmente cross-tenant** (admin ve holds de TODOS los owners) —
excepción DELIBERADA al Ownership Guard estándar de `CLAUDE.md`, gateada SOLO por
`requireAdminToken`. Marcar como superficie de alto privilegio en el story-file y
para auditorías futuras.

**CD-6**: PROHIBIDO tocar `record_settle_outcome`/`finalize_payment_intent`
(gate `IN ('closing','arb_closing')` byte-idéntico). SOLO
`close_payment_intent_for_arbitration` se ensancha.

**CD-7**: OBLIGATORIO que `ARBITER_ENABLED !== 'true'` bloquee panel/endpoints
(404), igual que `/session/:id/dispute` hoy.

**CD-8 (nuevo — invariante del ensanche)**: PROHIBIDO agregar `arb_hold` al set de
estados que `expireStale` sweepea hacia `recoverArbClosing`. El ensanche del RPC
es seguro SOLO porque `recoverArbClosing` nunca recibe un intent `arb_hold` (ver
§8-R1). Cualquier cambio a `expireStale` que seleccione `arb_hold` reabriría el
hazard de refund-fantasma. Test de regresión T-10.

**CD-9 (nuevo — sin cap en override)**: OBLIGATORIO que `resolveHold` NO consulte
`getArbiterAutoCapUsd()`. El humano está en el loop; el único límite es el clamp
`[0, deposit]`. (Regresión: T-7 verifica un override > cap ejecuta.)

**CD-10 (nuevo — allowStaleRecovery=false)**: `resolveHold` invoca
`executeArbitration` con `allowStaleRecovery=false` (default). Un segundo override
concurrente que caiga en la rama recovery (`prev_status='arb_closing'`,
`settle_outcome=NULL`) debe ser no-op in-flight, NO forzar recovery. (Exactly-once,
T-8.)

**CD-11 (nuevo — TS exhaustivo tras extender `ArbiterMethod`)**: tras agregar
`'admin_override'` a `ArbiterMethod`, correr `npx tsc --noEmit` y revisar todo
consumidor exhaustivo del tipo. (Aprendizaje recurrente WKH-146 / WKH-124: extender
una unión rompe consumidores fuera de Scope IN. Hoy no hay `switch` exhaustivo sobre
`ArbiterMethod` — solo asignaciones y `receiptTypeFor(decision)` sobre
`ArbiterDecision`, que NO cambia — pero verificar es obligatorio antes de cerrar
W0.)

**CD-12 (nuevo — biome por archivo)**: correr `biome check` sobre cada archivo
nuevo/tocado ANTES de cerrar cada wave (aprendizaje WKH-139 auto-blindaje W1/W4:
imports redundantes + `noThenProperty` en test doubles awaitables → usar
`// biome-ignore lint/suspicious/noThenProperty` puntual, no reescribir).

---

## 6. Scope

### IN
- Migración additive nueva (§7-W0): ensanche del predicado de
  `close_payment_intent_for_arbitration`; +`'admin_override'` al CHECK
  `a2a_arbitrations.method`; columnas `resolved_by`/`resolved_at`/`resolution_note`;
  down reversible.
- `src/types/arbiter.ts`: `ArbiterMethod += 'admin_override'`.
- `src/services/arbiter.ts`: `resolveHold` (nueva) + `listHolds` (nueva); extender
  `ArbMeta` + `upsertArbitrationRow` con los 3 campos de auditoría humana.
- `src/routes/dashboard.ts`: `GET /dashboard/api/arbitrations/holds` +
  `POST /dashboard/api/arbitrations/:intentId/resolve` (ambos `requireAdminToken`
  + gate de flag) + mapper de error disclosure-safe local.
- `src/static/dashboard.html`: sección "Disputas en revisión" (tabla + form
  release/refund/split con confirmación + campo admin-token).
- Tests: unit de `resolveHold`/`listHolds` + integración de los 2 endpoints
  (mismo patrón que `arbiter.test.ts`; NO tocar los 88 tests existentes).

### OUT
- Auto-path (`rules.ts`, `llm-classifier.ts`, `evidence.ts`, cap gate,
  `openDispute`/`resolveDispute`) — sin cambios de comportamiento (solo se reusa
  su seam).
- Mainnet — fuera de todo el arbitraje (heredado).
- `ARBITER_AUTO_CAP_USD` en el override (CD-9).
- RBAC/SSO/JWT per-usuario (v1 reusa el token compartido; `resolvedBy` es texto).
- Intents `upto` (arbiter es `session`-only).
- Cooling-off adicional post-override, "undo" de un override terminal, alertas
  Discord (sugerencia diferida §10).
- Ops de activación (migrar `caldz`, flip `ARBITER_ENABLED`) — esta HU es SOLO
  código; queda `DONE (código) · PENDING-DEPLOY`.

---

## 7. Waves de implementación

### W0 — Migración + tipos (SERIAL, contratos primero)

**Archivos**: `supabase/migrations/20260712000000_wkh189_arb_hold_override.sql`,
`supabase/migrations/20260712000000_wkh189_arb_hold_override_down.sql`,
`src/types/arbiter.ts`, `src/db/__tests__/migration-wkh189.test.ts` (o el path de
tests estructurales que use el repo — VERIFY-AT-IMPL con Glob de `*.test.ts` de
migraciones existentes).

**SQL — UP** (`20260712000000_wkh189_arb_hold_override.sql`):

```sql
-- ============================================================
-- Migration: 20260712000000_wkh189_arb_hold_override
-- WKH-189: habilita el override humano admin-gated de intents en 'arb_hold'.
-- Aditiva sobre WKH-139 v2. NO toca record_settle_outcome/finalize_payment_intent
-- (CD-6), ni charge/compose/orchestrate. Cambios:
--   1. close_payment_intent_for_arbitration: ensancha SOLO el predicado del
--      status-gate de la rama que transiciona a arb_closing:
--      'disputed' -> IN ('disputed','arb_hold'). Toda la lógica de dinero
--      (clamp [0,deposit], persistencia en consumed_usd, rama recovery
--      'arb_closing') queda BYTE-IDENTICA (patron Option B).
--   2. a2a_arbitrations.method CHECK += 'admin_override'.
--   3. a2a_arbitrations += resolved_by / resolved_at / resolution_note (nullable).
-- ============================================================

BEGIN;

-- ── 1. Columnas de auditoria humana (additive, nullable) ──
ALTER TABLE a2a_arbitrations ADD COLUMN IF NOT EXISTS resolved_by      TEXT;
ALTER TABLE a2a_arbitrations ADD COLUMN IF NOT EXISTS resolved_at      TIMESTAMPTZ;
ALTER TABLE a2a_arbitrations ADD COLUMN IF NOT EXISTS resolution_note  TEXT;

-- ── 2. Ensanchar CHECK a2a_arbitrations.method (+admin_override) ──
ALTER TABLE a2a_arbitrations DROP CONSTRAINT IF EXISTS a2a_arbitrations_method_check;
ALTER TABLE a2a_arbitrations ADD CONSTRAINT a2a_arbitrations_method_check
  CHECK (method IN ('rules','llm','hold','admin_override'));

-- ── 3. Ensanchar close_payment_intent_for_arbitration (Option B) ──
-- Cuerpo VERBATIM de 20260704100000_wkh139_arbiter.sql, cambiando UNA linea:
-- el predicado 'IF v_status = ''disputed''' -> 'IF v_status IN (''disputed'',''arb_hold'')'.
-- NINGUNA rama de dinero cambia. Re-declara search_path/REVOKE/GRANT.
CREATE OR REPLACE FUNCTION close_payment_intent_for_arbitration(
  p_intent_id  UUID,
  p_owner_ref  TEXT,
  p_arb_amount NUMERIC
) RETURNS TABLE(
  final_amount   NUMERIC,
  prev_status    TEXT,
  intent_type    TEXT,
  key_id         UUID,
  chain_id       INT,
  pay_to         TEXT,
  authorized_usd NUMERIC,
  consumed_usd   NUMERIC,
  settle_tx_hash TEXT,
  settle_outcome TEXT
) AS $$
DECLARE
  v_owner    TEXT;
  v_status   TEXT;
  v_type     TEXT;
  v_key      UUID;
  v_chain    INT;
  v_payto    TEXT;
  v_auth     NUMERIC;
  v_consumed NUMERIC;
  v_tx       TEXT;
  v_outcome  TEXT;
  v_final    NUMERIC;
  v_arb      NUMERIC;
BEGIN
  SELECT pi.owner_ref, pi.status, pi.intent_type, pi.key_id, pi.chain_id,
         pi.pay_to, pi.authorized_usd, pi.consumed_usd, pi.settle_tx_hash,
         pi.settle_outcome
    INTO v_owner, v_status, v_type, v_key, v_chain,
         v_payto, v_auth, v_consumed, v_tx, v_outcome
    FROM a2a_payment_intents pi
    WHERE pi.id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;

  -- Clamp: NUNCA settlea > deposit ni < 0 ("no crear plata"). BYTE-IDENTICO.
  v_arb := GREATEST(0, LEAST(v_auth, COALESCE(p_arb_amount, 0)));

  -- WKH-189: predicado ensanchado. arb_hold entra por la MISMA rama que disputed
  -- (transicion a arb_closing persistiendo el monto forzado). El resto verbatim.
  IF v_status IN ('disputed','arb_hold') THEN
    v_final    := v_arb;
    v_consumed := v_arb;
    UPDATE a2a_payment_intents
      SET status = 'arb_closing', consumed_usd = v_arb
      WHERE id = p_intent_id;
  ELSIF v_status = 'arb_closing' THEN
    -- Recovery: NO re-transiciona, NO re-clampa. Lee el monto persistido.
    v_final := v_consumed;
  ELSE
    RAISE EXCEPTION 'INTENT_NOT_OPEN: intent % is %', p_intent_id, v_status;
  END IF;

  final_amount   := v_final;
  prev_status    := v_status;
  intent_type    := v_type;
  key_id         := v_key;
  chain_id       := v_chain;
  pay_to         := v_payto;
  authorized_usd := v_auth;
  consumed_usd   := v_consumed;
  settle_tx_hash := v_tx;
  settle_outcome := v_outcome;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.close_payment_intent_for_arbitration(uuid, text, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.close_payment_intent_for_arbitration(uuid, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_payment_intent_for_arbitration(uuid, text, numeric)
  TO service_role;

COMMIT;
```

**SQL — DOWN** (`20260712000000_wkh189_arb_hold_override_down.sql`):

```sql
-- ============================================================
-- Down: 20260712000000_wkh189_arb_hold_override
-- Revierte SOLO los cambios de WKH-189. Restaura el predicado del RPC a
-- 'disputed' (cuerpo verbatim de WKH-139 v2), el CHECK method sin
-- 'admin_override', y dropea las 3 columnas de auditoria humana.
-- NOTA OPS: si existen filas con method='admin_override' o intents en
-- 'arb_hold' pendientes, resolverlos ANTES de aplicar este down (el
-- CHECK restaurado rechazaria las filas admin_override).
-- ============================================================

BEGIN;

-- 1. Restaurar close_payment_intent_for_arbitration al predicado 'disputed'.
CREATE OR REPLACE FUNCTION close_payment_intent_for_arbitration(
  p_intent_id  UUID,
  p_owner_ref  TEXT,
  p_arb_amount NUMERIC
) RETURNS TABLE(
  final_amount   NUMERIC, prev_status TEXT, intent_type TEXT, key_id UUID,
  chain_id INT, pay_to TEXT, authorized_usd NUMERIC, consumed_usd NUMERIC,
  settle_tx_hash TEXT, settle_outcome TEXT
) AS $$
DECLARE
  v_owner TEXT; v_status TEXT; v_type TEXT; v_key UUID; v_chain INT;
  v_payto TEXT; v_auth NUMERIC; v_consumed NUMERIC; v_tx TEXT; v_outcome TEXT;
  v_final NUMERIC; v_arb NUMERIC;
BEGIN
  SELECT pi.owner_ref, pi.status, pi.intent_type, pi.key_id, pi.chain_id,
         pi.pay_to, pi.authorized_usd, pi.consumed_usd, pi.settle_tx_hash,
         pi.settle_outcome
    INTO v_owner, v_status, v_type, v_key, v_chain,
         v_payto, v_auth, v_consumed, v_tx, v_outcome
    FROM a2a_payment_intents pi WHERE pi.id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id; END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;
  v_arb := GREATEST(0, LEAST(v_auth, COALESCE(p_arb_amount, 0)));
  IF v_status = 'disputed' THEN
    v_final := v_arb; v_consumed := v_arb;
    UPDATE a2a_payment_intents SET status = 'arb_closing', consumed_usd = v_arb
      WHERE id = p_intent_id;
  ELSIF v_status = 'arb_closing' THEN
    v_final := v_consumed;
  ELSE
    RAISE EXCEPTION 'INTENT_NOT_OPEN: intent % is %', p_intent_id, v_status;
  END IF;
  final_amount := v_final; prev_status := v_status; intent_type := v_type;
  key_id := v_key; chain_id := v_chain; pay_to := v_payto;
  authorized_usd := v_auth; consumed_usd := v_consumed;
  settle_tx_hash := v_tx; settle_outcome := v_outcome;
  RETURN NEXT; RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.close_payment_intent_for_arbitration(uuid, text, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.close_payment_intent_for_arbitration(uuid, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_payment_intent_for_arbitration(uuid, text, numeric)
  TO service_role;

-- 2. Restaurar CHECK method sin admin_override.
ALTER TABLE a2a_arbitrations DROP CONSTRAINT IF EXISTS a2a_arbitrations_method_check;
ALTER TABLE a2a_arbitrations ADD CONSTRAINT a2a_arbitrations_method_check
  CHECK (method IN ('rules','llm','hold'));

-- 3. Dropear columnas de auditoria humana.
ALTER TABLE a2a_arbitrations DROP COLUMN IF EXISTS resolution_note;
ALTER TABLE a2a_arbitrations DROP COLUMN IF EXISTS resolved_at;
ALTER TABLE a2a_arbitrations DROP COLUMN IF EXISTS resolved_by;

COMMIT;
```

**Tipos** (`src/types/arbiter.ts:17`):
```ts
export type ArbiterMethod = 'rules' | 'llm' | 'hold' | 'admin_override';
```
Actualizar el comentario JSDoc (`admin_override` = resuelto por humano admin).
Correr `npx tsc --noEmit` (CD-11).

**Gate de cierre W0**: `npx tsc --noEmit` verde; test estructural de la migración
verde (contar sentencias completas, NO substrings — aprendizaje WKH-116/T-11).

### W1 — Servicio (`resolveHold` + `listHolds`)

**Archivos**: `src/services/arbiter.ts`, `src/services/__tests__/arbiter.test.ts`
(extender, no tocar los existentes).

1. Extender `ArbMeta` (arbiter.ts:193-201) con:
   `resolvedBy: string | null; resolvedAt: string | null; resolutionNote: string | null;`
   Actualizar TODAS las construcciones de `ArbMeta` del auto-path (resolveDispute
   L396-404, recoverArbClosing L675-683, y los spreads L367/407) para pasar
   `resolvedBy: null, resolvedAt: null, resolutionNote: null`.
2. Extender `upsertArbitrationRow` (L208-243): agregar al objeto del upsert
   `resolved_by: meta.resolvedBy, resolved_at: meta.resolvedAt, resolution_note:
   meta.resolutionNote`. (Se preservan `ambiguity_reason`/`llm_reasoning` porque
   `resolveHold` los pasa leídos del row original — no null.)
3. Nueva `listHolds()` (CD-5, cross-tenant, sin owner filter):
   ```ts
   async listHolds(): Promise<AdminHoldItem[]> {
     const { data, error } = await supabase
       .from('a2a_payment_intents')
       .select('id, chain_id, authorized_usd, created_at, ' +
               'a2a_arbitrations(decision, method, ambiguity_reason, at_stake_usd, created_at)')
       .eq('status', 'arb_hold')
       .order('created_at', { ascending: true });
     if (error) { log.error(...); throw new ArbiterError('INTERNAL'); }
     return (data ?? []).map(toAdminHoldItem); // aplana el embed (0-1 fila)
   }
   ```
   `AdminHoldItem` shape (DT-5): `{ intentId, chainId, atStakeUsd, decision,
   method, ambiguityReason, createdAt }`. Si el embed viene vacío (upsert falló),
   `atStakeUsd = authorized_usd`, `decision/method/ambiguityReason = null`.
4. Nueva `resolveHold(intentId, opts)`:
   ```ts
   async resolveHold(
     intentId: string,
     opts: { decision: 'release'|'refund'|'split';
             splitPct?: number; resolvedBy: string|null; note: string|null },
   ): Promise<ArbiterOutcome> {
     // a. Validar input (INVALID_INPUT). split => splitPct finito en [0,100].
     // b. Leer row REAL del intent (owner_ref, chain_id, status, authorized_usd, seller_ref).
     //    !data => INTENT_NOT_FOUND. status !== 'arb_hold' => INTENT_NOT_OPEN (advisory; RPC re-gatea).
     // c. Testnet guard (AC-6): !TESTNET_CHAIN_IDS.has(chain_id) => CHAIN_NOT_SUPPORTED.
     // d. Leer a2a_arbitrations original (ambiguity_reason, llm_reasoning) — best-effort, defaults null.
     // e. Computar settleUsd (SIN cap, CD-9), clamp [0, deposit]:
     //    release => deposit; refund => 0; split => clamp(deposit*splitPct/100, 0, deposit).
     // f. Construir ArbMeta { decision, method:'admin_override', atStakeUsd: deposit,
     //    ambiguityReason, llmReasoning, evidenceDigest: null, sellerRef,
     //    resolvedBy, resolvedAt: new Date().toISOString(), resolutionNote: note }.
     // g. return this.executeArbitration(intentId, ownerRef, settleUsd, meta); // allowStaleRecovery=false
   }
   ```
   Notas: `ownerRef` es el leído en (b) (CD-4). El status-check (b) es advisory
   (disclosure/fail-fast); el gate real es el RPC (CD-3): si dos overrides corren,
   el segundo cae en la rama recovery del RPC (`prev_status='arb_closing'`) →
   `executeArbitration` no-op in-flight (CD-10).

**Gate de cierre W1**: `biome check` (CD-12) + unit tests T-2/3/4/6/7/8/10 verdes;
`npx tsc --noEmit`.

### W2 — Rutas admin (`dashboard.ts`)

**Archivos**: `src/routes/dashboard.ts`, `src/routes/__tests__/dashboard.test.ts`
(nuevo o extender — VERIFY-AT-IMPL con Glob).

1. Importar `arbiterService, isArbiterEnabled` de `../services/arbiter.js` y
   `ArbiterError` de `../types/arbiter.js`.
2. Mapper local disclosure-safe `sendArbiterAdminError(reply, err)` (espejo de
   `payments.ts:78-99`, sin exponer mensaje crudo): `INVALID_INPUT`→422,
   `OWNERSHIP_MISMATCH`→403, `INTENT_NOT_FOUND`→404, `INTENT_NOT_OPEN`→409,
   `CHAIN_NOT_SUPPORTED`→422, default→500 `{ error_code: 'ARBITER_FAILED' }`.
3. `GET /api/arbitrations/holds` (`preHandler: requireAdminToken`,
   `config:{rateLimit:false}`):
   ```ts
   if (!isArbiterEnabled()) return reply.status(404).send({ error_code: 'NOT_FOUND' }); // AC-8
   try { const holds = await arbiterService.listHolds();
         return reply.send({ holds, total: holds.length }); }
   catch (err) { request.log.error({detail:...}, 'list holds failed');
                 return sendArbiterAdminError(reply, err); }
   ```
4. `POST /api/arbitrations/:intentId/resolve` (`preHandler: requireAdminToken`,
   `config:{rateLimit:false}`):
   ```ts
   if (!isArbiterEnabled()) return reply.status(404).send({ error_code: 'NOT_FOUND' }); // AC-8
   const { decision, splitPct, resolvedBy, note } = request.body ?? {};
   // validacion de shape en el route (defensa) + en resolveHold (autoritativa)
   try { const outcome = await arbiterService.resolveHold(request.params.intentId,
           { decision, splitPct, resolvedBy: resolvedBy ?? null, note: note ?? null });
         return reply.status(200).send({ decision: outcome.decision, method: outcome.method,
           status: outcome.status, settleUsd: outcome.settleUsd,
           residualUsd: outcome.residualUsd, txHash: outcome.txHash }); }
   catch (err) { request.log.error({errorClass:...}, 'resolveHold failed');
                 return sendArbiterAdminError(reply, err); }
   ```

**Gate de cierre W2**: `biome check` + integración T-1/T-5/T-9 verdes; `tsc`.

### W3 — Panel dashboard (`dashboard.html`)

**Archivo**: `src/static/dashboard.html`.

- Sección nueva `<h3 class="section-title">Disputas en revision</h3>` + input
  `<input id="admin-token" placeholder="X-Admin-Token">` (persistir en
  `localStorage`) + botón "Cargar holds".
- Helper `adminFetch(url, opts)` que agrega `X-Admin-Token` desde el input a
  `opts.headers` (los fetch existentes NO cambian).
- `loadHolds()`: GET `/dashboard/api/arbitrations/holds`. Si 404 → estado
  "Arbitraje deshabilitado o sin holds" (sin error). Render tabla: intent (8
  chars + `esc`), chain, `at_stake_usd`, `ambiguity_reason`, `method`, y por fila
  botones **Liberar** (release) / **Reembolsar** (refund) / **Dividir** (split, con
  prompt de porcentaje).
- `resolveHold(intentId, decision)`: `confirm()` en español ("Confirmas
  <decision> sobre el intent <id>? Esto mueve fondos y es irreversible.") →
  si split, `prompt()` de porcentaje al Seller (0-100) → POST
  `/dashboard/api/arbitrations/:id/resolve` con `{decision, splitPct?, resolvedBy}`
  (`resolvedBy` = valor de un input opcional). Tras éxito → `loadHolds()` de nuevo.
- Todo en español, SIN em dashes, `esc()` en todo dato de servidor (XSS).

**Gate de cierre W3**: revisar render manual del panel (o test de smoke si el repo
tiene DOM tests — VERIFY-AT-IMPL). No hay build TS de HTML.

---

## 8. Riesgos y mitigaciones

**R-1 (MEDIO — hazard latente del ensanche del RPC)**: al aceptar `arb_hold` en
`close_payment_intent_for_arbitration`, si `recoverArbClosing` (que llama al RPC
con `p_arb_amount=0`) recibiera alguna vez un intent `arb_hold`, lo transicionaría
`arb_hold→arb_closing` con `consumed_usd=0` (refund total) ANTES de que su guard
`prev_status !== 'arb_closing'` (arbiter.ts:668) lo detenga — dejando un
`arb_closing` huérfano que un sweep posterior reembolsaría por completo
("refund-fantasma"). **Mitigación / por qué NO ocurre hoy** (invariante verificado):
(a) `expireStale` sweepea a `recoverArbClosing` SOLO `status='arb_closing'`
(payment-intent.ts:1177), nunca `arb_hold`; (b) NO existe transición
`arb_closing→arb_hold` (solo `holdArbitration` produce `arb_hold`, gateado en
`disputed`, arbiter.ts:739). Por lo tanto `recoverArbClosing` jamás ve un
`arb_hold`. Se blinda con **CD-8** (prohibido sweepear `arb_hold` a recovery) +
**T-10** (regresión: si se fuerza `recoverArbClosing` sobre un `arb_hold`, debe
no mover fondos / documentar el comportamiento). **Recomendación para AR**: revisar
que ninguna otra ruta invoque el RPC con `p_arb_amount=0` sobre un `arb_hold` fuera
de `resolveHold`.

**R-2 (BAJO — override concurrente)**: dos admins resolviendo el mismo hold. El
`FOR UPDATE` serializa; el segundo cae en la rama recovery del RPC → no-op
in-flight (CD-10). Sin double-settle. T-8 lo cubre.

**R-3 (BAJO — dashboard.html no manda token hoy)**: los fetch existentes no envían
`X-Admin-Token`; en prod con token seteado ya están rotos (pre-existente, fuera de
scope). El panel nuevo SÍ manda el token (input dedicado). No regresiona nada.

**R-4 (BAJO — upsert best-effort podría no reflejar `held`)**: por eso el listado
se deriva del intent (`status='arb_hold'`), no de `a2a_arbitrations.status`
(DT-5). El embed de evidencia degrada a `null` sin romper el listado.

---

## 9. Plan de tests (≥1 por AC)

| ID | Cubre | Tipo | Descripción |
|----|-------|------|-------------|
| T-1 | AC-1 | integración | `GET /dashboard/api/arbitrations/holds` con token válido lista holds cross-tenant (2 owners distintos) con evidencia. |
| T-2 | AC-2 | unit | `resolveHold(release)` sobre `arb_hold` → `executeArbitration` settlea al seller, status `executed`, transición `arb_hold→arb_closing→settled`. |
| T-3 | AC-3 | unit | override persiste `method='admin_override'`, `resolved_by`, `resolved_at`, `resolution_note` y **preserva** `ambiguity_reason`/`llm_reasoning` originales; recibo emitido con `receiptTypeFor(decision)`. |
| T-4 | AC-4 | unit | `resolveHold` sobre intent inexistente → `INTENT_NOT_FOUND` (404); sobre `settled`/`open` → `INTENT_NOT_OPEN` (409); **cero** llamadas a settle. |
| T-5 | AC-5 | integración | GET y POST sin `X-Admin-Token` (con `DASHBOARD_ADMIN_TOKEN` seteado) → 401; body/datos ajenos no expuestos; override no ejecutado. |
| T-6 | AC-6 | unit | `resolveHold` sobre intent con `chain_id` mainnet (p.ej. 1) → `CHAIN_NOT_SUPPORTED` (422) fail-closed, sin mover fondos. |
| T-7 | AC-7 / CD-9 | unit | `resolveHold(split, splitPct)` con `at_stake_usd` **> ARBITER_AUTO_CAP_USD** ejecuta igual (sin cap) y clampa `settleUsd` a `[0, deposit]`; `splitPct>100` → clamp a deposit; `release` de deposit grande no excede deposit. |
| T-8 | AC-2 / CD-10 | unit | idempotencia: segundo `resolveHold` (o retry) sobre un intent ya en `arb_closing` con `settle_outcome=NULL` → no-op in-flight (no double-settle), con `allowStaleRecovery=false`. |
| T-9 | AC-8 / CD-7 | integración | con `ARBITER_ENABLED` != 'true', GET y POST → 404 `{error_code:'NOT_FOUND'}` byte-idéntico (incluso con token válido). |
| T-10 | CD-8 / R-1 | unit | regresión: `expireStale` no selecciona `arb_hold`; y `recoverArbClosing` forzado sobre un `arb_hold` no reembolsa el deposit (documenta/blinda el invariante). |
| T-11 | migración | estructural | el `.sql` up contiene el predicado `IN ('disputed','arb_hold')`, el CHECK con `admin_override`, y las 3 columnas; el down los revierte. Contar sentencias completas, NO substrings (WKH-116). |

Patrón de tests: `arbiter.test.ts` existente (test doubles awaitables de supabase
con `// biome-ignore lint/suspicious/noThenProperty`, CD-12). NO tocar los 88 tests
de WKH-139.

---

## 10. Missing Inputs / defaults resueltos

- **`resolvedBy` libre vs allowlist**: RESUELTO → libre en v1 (DT-4), texto de
  auditoría best-effort, mismo nivel de confianza que el token compartido.
  Endurecible sin reabrir la HU.
- **Alerta Discord por override**: DIFERIDO (no bloqueante). El override ya deja
  recibo inmutable + fila `a2a_arbitrations` con `resolved_by/at`. Una alerta
  `alerts.mjs` es sugerencia de bajo costo para una HU follow-up si el humano lo
  pide; NO se incluye en Scope IN.
- **Shape del GET**: RESUELTO (DT-5 / `AdminHoldItem`): `{ intentId, chainId,
  atStakeUsd, decision, method, ambiguityReason, createdAt }` derivado de
  `a2a_payment_intents` + embed `a2a_arbitrations`.
- **Ticket Jira ilegible (bloqueante de grounding en F1)**: se asume que el
  humano lo validó en `HU_APPROVED` (gate ya superado para llegar a F2).

---

## 11. Readiness Check

- [x] Todos los exemplars verificados con Read (paths + líneas reales; ver §3).
- [x] RPC a ensanchar identificado con la línea exacta (migración L192) y el
  patrón "Option B" confirmado en la misma migración (L266, L326).
- [x] Seam de reuse confirmado: `executeArbitration` + `ArbMeta` +
  `upsertArbitrationRow` + `settlePaymentIntentOnChain` + `receiptService.emit`.
- [x] Ownership Guard: `owner_ref` leído del row real (CD-4), listado cross-tenant
  documentado como excepción deliberada (CD-5).
- [x] Exactly-once: status-gate DB (`FOR UPDATE`) + `allowStaleRecovery=false`
  (CD-3/CD-10). Sin `UPDATE` de status en la app.
- [x] Testnet-guard y cap del auto-path intactos (CD-2/CD-9); override sin cap.
- [x] Hazard del ensanche (R-1) identificado, invariante verificado, blindado con
  CD-8 + T-10.
- [x] Flag gate (AC-8/CD-7) + auth admin (AC-5) especificados.
- [x] Test plan ≥1 por AC (T-1..T-11) con tipo y descripción.
- [x] Migración up + down escritas byte-a-byte en el SDD; nombre con timestamp
  posterior (`20260712000000`).
- [x] Cero `[NEEDS CLARIFICATION]` abiertos (§10).
- [ ] SPEC_APPROVED — pendiente gate humano.

**VERIFY-AT-IMPL (para el Dev en F3)**:
- Path exacto de los tests estructurales de migración y de rutas (Glob
  `**/*.test.ts` sobre migraciones/dashboard existentes).
- Confirmar que `a2a_arbitrations.intent_id` tiene la FK a
  `a2a_payment_intents(id)` que habilita el embed PostgREST del `select` de
  `listHolds` (migración L45 lo declara: `REFERENCES a2a_payment_intents(id)`).
- Confirmar el nombre real del constraint `a2a_arbitrations_method_check` en la DB
  (el `DROP CONSTRAINT IF EXISTS` es tolerante, pero verificar que el `ADD
  CONSTRAINT` inline de la migración WKH-139 lo nombró así — al ser inline sin
  `CONSTRAINT name`, Postgres lo auto-nombra `a2a_arbitrations_method_check`;
  coincide con la convención de PG).
```
