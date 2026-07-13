# Story File — HU-189: Panel + endpoint de revisión/override de `arb_hold`

> Contrato autocontenido para el Dev (F3). El Dev SOLO lee este archivo.
> Si algo no está acá, no se hace. Si algo contradice al código real, PARÁ y escalá.
>
> - SDD fuente: `doc/sdd/171-wkh-189-arb-hold-override/sdd.md` (SPEC_APPROVED)
> - Branch: `feat/171-wkh-189-arb-hold-override`
> - Tipo: money-path / admin-privileged / additive migration
> - Estado esperado al cierre: `DONE (código) · PENDING-DEPLOY` (esta HU NO aplica migración a `caldz` ni flipea flags)

---

## 1. Contexto compacto (qué construís y por qué)

WKH-139 v2 deja los intents `session` sobre-tope o irresolubles en estado
`arb_hold` (congelados, cero fondos movidos), con la promesa de "revisión humana"
que **hoy no existe en código**. Construís el **Bloque A**: un camino admin-gated
para (1) **listar** los holds con su evidencia y (2) **resolverlos**
(`release` / `refund` / `split`), **reusando el mismo seam de settle/refund del
árbitro autónomo** (`arbiterService.executeArbitration`), más un panel en el
dashboard existente.

El override es un camino **adicional** gateado por `X-Admin-Token`
(`requireAdminToken` de `dashboard.ts`) + el flag `ARBITER_ENABLED`. No toca el
auto-path (rules/LLM/cap). Como el humano ya está en el loop → **el
`ARBITER_AUTO_CAP_USD` NO aplica** al override; el único límite es el clamp
`[0, deposit]` ("no crear plata").

Invariantes money-path a preservar: exactly-once vía status-gate DB (`FOR UPDATE`
en el RPC), fail-closed, ownership guard (`owner_ref` del row real, nunca del
request), testnet-only.

---

## 2. Scope IN — lista exhaustiva de archivos a tocar

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `supabase/migrations/20260712000000_wkh189_arb_hold_override.sql` | CREAR (SQL exacto en §5) | W0 |
| 2 | `supabase/migrations/20260712000000_wkh189_arb_hold_override_down.sql` | CREAR (SQL exacto en §5) | W0 |
| 3 | `src/types/arbiter.ts` | EDITAR L17 (`ArbiterMethod += 'admin_override'`) | W0 |
| 4 | `src/services/arbiter.ts` | EDITAR: extender `ArbMeta` + `upsertArbitrationRow` + auto-path metas; AGREGAR `listHolds` + `resolveHold` | W1 |
| 5 | `src/services/arbiter.test.ts` | EXTENDER (NO tocar los tests existentes) | W0/W1 |
| 6 | `src/routes/dashboard.ts` | AGREGAR 2 rutas + mapper de error local | W2 |
| 7 | `src/routes/dashboard.test.ts` | EXTENDER (NO tocar los tests existentes) | W2 |
| 8 | `src/static/dashboard.html` | AGREGAR sección "Disputas en revision" | W3 |

**PROHIBIDO tocar cualquier otro archivo.** En particular NO tocar
`src/services/payment-intent.ts` (CD-8), `record_settle_outcome`,
`finalize_payment_intent`, `rules.ts`, `llm-classifier.ts`, `evidence.ts`,
`payments.ts`.

---

## 3. Anti-Hallucination Checklist (verificado en el SDD — NO re-inventes)

Todo lo de abajo fue verificado con Read sobre el código real. Usalo tal cual.

- `arbiterService.executeArbitration(intentId, ownerRef, settleUsd, meta, allowStaleRecovery=false)` — firma real en `arbiter.ts:423-429`. Es el ÚNICO choke-point del monto forzado. **Reusalo, no lo clones (CD-1).**
- `interface ArbMeta` — `arbiter.ts:193-201`. Campos actuales: `decision, method, atStakeUsd, ambiguityReason, llmReasoning, evidenceDigest, sellerRef`.
- `upsertArbitrationRow(intentId, ownerRef, meta, settleUsd, status)` — `arbiter.ts:208-243`. ÚNICO write a `a2a_arbitrations`. Objeto del upsert en L217-228.
- `receiptTypeFor(decision)` — `arbiter.ts:173-178`. Ya mapea `release/refund/split/hold`. **No agregás tipos de recibo** (`receipt.ts:18-25` ya los tiene).
- `TESTNET_CHAIN_IDS: ReadonlySet<number> = new Set([2368, 43113, 84532])` — `arbiter.ts:44` (module-private, NO exportado). El guard fail-closed vive en `openDispute` en `arbiter.ts:302-305`. `resolveHold` debe replicar `if (!TESTNET_CHAIN_IDS.has(chain_id)) throw new ArbiterError('CHAIN_NOT_SUPPORTED')`.
- `isArbiterEnabled()` — `arbiter.ts:65-67`, exportado. `=== 'true'` exacto.
- `ArbiterError` + `ArbiterErrorCode` — `types/arbiter.ts:20-36`. Códigos existentes: `INVALID_INPUT | OWNERSHIP_MISMATCH | INTENT_NOT_FOUND | INTENT_NOT_OPEN | CHAIN_NOT_SUPPORTED | ARBITER_DISABLED | INTERNAL`. **NO agregás códigos nuevos.**
- `ArbiterOutcome` — `types/arbiter.ts:62-72`: `{ decision, method, settleUsd, residualUsd, atStakeUsd, status, txHash, ambiguityReason, llmReasoning }`. `resolveHold` devuelve esto (lo produce `executeArbitration` vía `outcome(...)`).
- `requireAdminToken` — `dashboard.ts:30-60` (preHandler, `timingSafeEqual`, fail-closed prod si `DASHBOARD_ADMIN_TOKEN` unset → 503; 401 si header ausente/inválido). Reusalo tal cual como `preHandler`.
- Patrón de registro de ruta en `dashboard.ts`: `fastify.get('/api/...', { config: { rateLimit: false }, preHandler: requireAdminToken }, handler)` — ver `dashboard.ts:94-96` y `121-123`. El plugin se registra bajo prefijo `/dashboard` (`index.ts:167`), así que el path real es `/dashboard/api/...`.
- Mapper de error disclosure-safe de referencia: `sendArbiterError` en `payments.ts:78-99`. **NO lo importes** (es privado de payments.ts); replicá su lógica local en `dashboard.ts` (§7).
- Gate de flag de referencia: `payments.ts:295-297` (`if (!isArbiterEnabled()) return reply.status(404).send({ error_code: 'NOT_FOUND' });` como PRIMERA línea del handler).
- `holdArbitration` — `arbiter.ts:728-758`. Es lo que produce `arb_hold` (gateado en `disputed`, L738-739). No lo tocás.
- `recoverArbClosing` — `arbiter.ts:650-693`. Llama al RPC con `p_arb_amount=0`; guard `prev_status !== 'arb_closing' return` (L668). **Invariante R-1/CD-8: nunca recibe `arb_hold` porque `expireStale` solo sweepea `arb_closing` (payment-intent.ts:1177) y `disputed` (payment-intent.ts:1192), NUNCA `arb_hold`.** No lo tocás.
- `applyRecovery` — `arbiter.ts:586-643`. Guard in-flight `if (!row.settle_outcome && !allowStaleRecovery)` (L600) → no-op. Es lo que garantiza exactly-once en override concurrente (CD-10).
- Migración fuente byte-a-byte del RPC a ensanchar: `supabase/migrations/20260704100000_wkh139_arbiter.sql`. El predicado a cambiar es `IF v_status = 'disputed'`. El CHECK actual: `method IN ('rules','llm','hold')`.
- `esc(s)` — `dashboard.html:140-145` (XSS-safe). Usalo en todo dato de servidor.
- Tests colocados: servicio en `src/services/arbiter.test.ts`; rutas en `src/routes/dashboard.test.ts`; test estructural de migración → colocarlo en `arbiter.test.ts` con `readFileSync` de la `.sql` (patrón `spend-policy.test.ts:362-407`, aserciones `toContain`). NO existe `src/db/__tests__/`.

**Si algo de esta lista no coincide con el código al abrirlo → PARÁ y escalá. No adivines.**

---

## 4. Constraint Directives (inline — inviolables)

- **CD-1**: OBLIGATORIO reusar el seam vía `executeArbitration`. PROHIBIDO clonar settle/refund/finalize/emit-recibo para el override.
- **CD-2**: PROHIBIDO debilitar `TESTNET_CHAIN_IDS` o `ARBITER_AUTO_CAP_USD` del auto-path. El override es camino adicional gateado por admin, NO un bypass.
- **CD-3**: OBLIGATORIO exactly-once vía status-gate DB. El override SOLO transiciona `arb_hold` bajo el `FOR UPDATE` del RPC. PROHIBIDO `UPDATE` de status en la app antes del RPC (la lectura de status en `resolveHold` es advisory, no mutante).
- **CD-4**: OBLIGATORIO Ownership Guard: `owner_ref` se lee del row real del intent y se pasa así a `executeArbitration`/RPC. NUNCA se construye/acepta desde el request del admin.
- **CD-5**: El `GET` de listado es **intencionalmente cross-tenant** (admin ve holds de TODOS los owners) — excepción DELIBERADA al Ownership Guard estándar de `CLAUDE.md`, gateada SOLO por `requireAdminToken`. **Superficie de alto privilegio** (documentar en comentario de código para auditorías futuras).
- **CD-6**: PROHIBIDO tocar `record_settle_outcome` / `finalize_payment_intent` (gate `IN ('closing','arb_closing')` byte-idéntico). SOLO `close_payment_intent_for_arbitration` se ensancha.
- **CD-7**: OBLIGATORIO que `ARBITER_ENABLED !== 'true'` bloquee panel/endpoints (404 `{error_code:'NOT_FOUND'}` byte-idéntico), igual que `/session/:id/dispute` hoy.
- **CD-8**: PROHIBIDO agregar `arb_hold` al set de estados que `expireStale` sweepea hacia `recoverArbClosing`. El ensanche del RPC es seguro SOLO porque `recoverArbClosing` nunca recibe un `arb_hold`. Regresión: T-10.
- **CD-9**: OBLIGATORIO que `resolveHold` **NO** consulte `getArbiterAutoCapUsd()`. El único límite es el clamp `[0, deposit]`. Regresión: T-7.
- **CD-10**: `resolveHold` invoca `executeArbitration` con `allowStaleRecovery=false` (default — no pasar el 5º argumento). Override concurrente en rama recovery = no-op in-flight. Regresión: T-8.
- **CD-11**: tras agregar `'admin_override'` a `ArbiterMethod`, correr `npx tsc --noEmit` y revisar todo consumidor del tipo. (Aprendizaje WKH-146/124: extender una unión rompe consumidores fuera de Scope IN.) Actualizar TODAS las construcciones de `ArbMeta` del auto-path con los 3 campos nuevos = `null`.
- **CD-12**: correr `biome check` sobre cada archivo nuevo/tocado ANTES de cerrar cada wave. Para test doubles awaitables usar `// biome-ignore lint/suspicious/noThenProperty` puntual (aprendizaje WKH-139), no reescribir.

---

## 5. W0 — Migración + tipos (SERIAL, contratos primero)

### 5.1 Archivo UP — `supabase/migrations/20260712000000_wkh189_arb_hold_override.sql`

Escribí el archivo EXACTAMENTE con este contenido:

```sql
-- ============================================================
-- Migration: 20260712000000_wkh189_arb_hold_override
-- WKH-189: habilita el override humano admin-gated de intents en 'arb_hold'.
-- Aditiva sobre WKH-139 v2. NO toca record_settle_outcome/finalize_payment_intent
-- (CD-6), ni charge/compose/orchestrate. Cambios:
--   1. close_payment_intent_for_arbitration: ensancha SOLO el predicado del
--      status-gate de la rama que transiciona a arb_closing:
--      'disputed' -> IN ('disputed','arb_hold'). Toda la logica de dinero
--      (clamp [0,deposit], persistencia en consumed_usd, rama recovery
--      'arb_closing') queda BYTE-IDENTICA (patron Option B).
--   2. a2a_arbitrations.method CHECK += 'admin_override'.
--   3. a2a_arbitrations += resolved_by / resolved_at / resolution_note (nullable).
-- ============================================================

BEGIN;

-- 1. Columnas de auditoria humana (additive, nullable)
ALTER TABLE a2a_arbitrations ADD COLUMN IF NOT EXISTS resolved_by      TEXT;
ALTER TABLE a2a_arbitrations ADD COLUMN IF NOT EXISTS resolved_at      TIMESTAMPTZ;
ALTER TABLE a2a_arbitrations ADD COLUMN IF NOT EXISTS resolution_note  TEXT;

-- 2. Ensanchar CHECK a2a_arbitrations.method (+admin_override)
ALTER TABLE a2a_arbitrations DROP CONSTRAINT IF EXISTS a2a_arbitrations_method_check;
ALTER TABLE a2a_arbitrations ADD CONSTRAINT a2a_arbitrations_method_check
  CHECK (method IN ('rules','llm','hold','admin_override'));

-- 3. Ensanchar close_payment_intent_for_arbitration (Option B)
--    Cuerpo VERBATIM de 20260704100000_wkh139_arbiter.sql, cambiando UNA linea:
--    'IF v_status = ''disputed''' -> 'IF v_status IN (''disputed'',''arb_hold'')'.
--    NINGUNA rama de dinero cambia. Re-declara search_path/REVOKE/GRANT.
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

> **VERIFY-AT-IMPL antes de escribir**: abrí `20260704100000_wkh139_arbiter.sql`,
> localizá `close_payment_intent_for_arbitration`, y confirmá que el cuerpo de arriba
> es **byte-idéntico salvo el predicado** (`IF v_status = 'disputed'` → `IF v_status IN ('disputed','arb_hold')`).
> Si el cuerpo original difiere en cualquier otra línea (nombres de vars, orden de
> columnas del RETURNS TABLE, clamp), **copiá el original y cambiá SOLO esa línea** —
> el original manda sobre este snippet.

### 5.2 Archivo DOWN — `supabase/migrations/20260712000000_wkh189_arb_hold_override_down.sql`

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

### 5.3 Tipos — `src/types/arbiter.ts:17`

```ts
/** Cómo se decidió: `rules` (determinístico), `llm` (asistido), `hold` (frozen), `admin_override` (resuelto por humano admin, WKH-189). */
export type ArbiterMethod = 'rules' | 'llm' | 'hold' | 'admin_override';
```

### 5.4 Gate de cierre W0

- [ ] `npx tsc --noEmit` verde (CD-11 — revisar que ningún consumidor de `ArbiterMethod` rompa; hoy no hay `switch` exhaustivo, solo asignaciones, pero verificar).
- [ ] Test estructural de la migración (T-11) verde.
- [ ] `biome check` sobre los archivos tocados (CD-12).

---

## 6. W1 — Servicio (`resolveHold` + `listHolds`) en `src/services/arbiter.ts`

### 6.1 Extender `ArbMeta` (`arbiter.ts:193-201`)

Agregar 3 campos:
```ts
interface ArbMeta {
  decision: ArbiterDecision;
  method: ArbiterMethod;
  atStakeUsd: number;
  ambiguityReason: string | null;
  llmReasoning: string | null;
  evidenceDigest: string | null;
  sellerRef: string;
  resolvedBy: string | null;      // WKH-189
  resolvedAt: string | null;      // WKH-189 (ISO)
  resolutionNote: string | null;  // WKH-189
}
```

**CD-11 — actualizar TODAS las construcciones de `ArbMeta` del auto-path** para pasar
`resolvedBy: null, resolvedAt: null, resolutionNote: null`:
- `resolveDispute`: el objeto `meta` en `arbiter.ts:396-404`.
- El hold del LLM-null en `arbiter.ts:367-375` (objeto inline pasado a `holdArbitration`).
- Los spreads `{ ...meta, decision:'hold', method:'hold' }` en `arbiter.ts:407-411` (heredan los null del meta base — OK, pero confirmá que el meta base ya los tiene).
- `recoverArbClosing`: `recoveryMeta` en `arbiter.ts:675-683`.

> Si `tsc` marca algún otro sitio que construye `ArbMeta` sin los 3 campos, agregalos con `null`. NO uses `?:` opcional (la convención del proyecto es `T | null` explícito, ver `types/arbiter.ts:9`).

### 6.2 Extender `upsertArbitrationRow` (`arbiter.ts:208-243`)

Agregar al objeto del upsert (junto a `evidence_digest`, antes de `status`):
```ts
        resolved_by: meta.resolvedBy,
        resolved_at: meta.resolvedAt,
        resolution_note: meta.resolutionNote,
```
> Se preservan `ambiguity_reason`/`llm_reasoning` automáticamente porque `resolveHold`
> los pasa leídos del row original (no null). El auto-path pasa `null` → columnas NULL
> (additive, sin cambio de comportamiento).

### 6.3 Nueva `listHolds()` — CD-5 (cross-tenant, SIN owner filter)

Agregar como método de `arbiterService`. Documentá en comentario que es **cross-tenant deliberado, superficie de alto privilegio (CD-5)**.

```ts
async listHolds(): Promise<AdminHoldItem[]> {
  const { data, error } = await supabase
    .from('a2a_payment_intents')
    .select(
      'id, chain_id, authorized_usd, created_at, ' +
        'a2a_arbitrations(decision, method, ambiguity_reason, at_stake_usd, created_at)',
    )
    .eq('status', 'arb_hold')
    .order('created_at', { ascending: true });
  if (error) {
    log.error({ detail: error.message }, 'listHolds query failed');
    throw new ArbiterError('INTERNAL');
  }
  return (data ?? []).map(toAdminHoldItem);
}
```

Tipo + mapper (definir junto al servicio; `AdminHoldItem` puede ir en `types/arbiter.ts` o local en `arbiter.ts` — VERIFY-AT-IMPL dónde encaja mejor con lo que exporta el módulo):
```ts
export interface AdminHoldItem {
  intentId: string;
  chainId: number;
  atStakeUsd: number;
  decision: string | null;
  method: string | null;
  ambiguityReason: string | null;
  createdAt: string;
}
```
`toAdminHoldItem(row)`: aplana el embed `a2a_arbitrations` (PostgREST devuelve un
array de 0-1 fila por el FK `intent_id → a2a_payment_intents(id)`). Si el embed viene
vacío (upsert falló, R-4): `atStakeUsd = row.authorized_usd`, `decision/method/ambiguityReason = null`.
Si hay fila: `atStakeUsd = arb.at_stake_usd ?? row.authorized_usd`.

> **VERIFY-AT-IMPL**: confirmá que `a2a_arbitrations.intent_id` tiene FK a
> `a2a_payment_intents(id)` (migración WKH-139 L45) para que el embed PostgREST resuelva.

### 6.4 Nueva `resolveHold(intentId, opts)`

```ts
async resolveHold(
  intentId: string,
  opts: {
    decision: 'release' | 'refund' | 'split';
    splitPct?: number;
    resolvedBy: string | null;
    note: string | null;
  },
): Promise<ArbiterOutcome> {
  // a. Validar input → ArbiterError('INVALID_INPUT') si:
  //    - decision no ∈ {'release','refund','split'}
  //    - decision === 'split' y splitPct no es finito en [0,100]
  // b. Leer row REAL del intent (SELECT owner_ref, chain_id, status,
  //    authorized_usd, seller_ref FROM a2a_payment_intents WHERE id=intentId).
  //    !data → INTENT_NOT_FOUND.
  //    status !== 'arb_hold' → INTENT_NOT_OPEN (advisory/fail-fast; el gate
  //    autoritativo es el RPC bajo FOR UPDATE, CD-3).
  //    Query error → INTERNAL (log.error con detail).
  // c. Testnet guard (AC-6, fail-closed): if (!TESTNET_CHAIN_IDS.has(chain_id))
  //    throw new ArbiterError('CHAIN_NOT_SUPPORTED').  ← replica arbiter.ts:303-305.
  // d. Leer a2a_arbitrations original (ambiguity_reason, llm_reasoning) —
  //    best-effort; si falla o no existe, defaults null.
  // e. Computar settleUsd SIN cap (CD-9 — NO llamar getArbiterAutoCapUsd()),
  //    clamp [0, deposit] donde deposit = authorized_usd:
  //      release → deposit
  //      refund  → 0
  //      split   → Math.min(Math.max(0, deposit * splitPct / 100), deposit)
  // f. Construir ArbMeta:
  //    { decision, method: 'admin_override', atStakeUsd: deposit,
  //      ambiguityReason, llmReasoning, evidenceDigest: null, sellerRef,
  //      resolvedBy: opts.resolvedBy, resolvedAt: new Date().toISOString(),
  //      resolutionNote: opts.note }
  // g. return this.executeArbitration(intentId, ownerRef, settleUsd, meta);
  //    ← ownerRef = el leído en (b) (CD-4). allowStaleRecovery queda en false
  //      por default (CD-10, NO pasar el 5º arg).
}
```

**Notas críticas**:
- El residual (`deposit − settleUsd`) NO se maneja acá — lo computa `executeArbitration` (`residualMicro`, `arbiter.ts:441`) y lo reembolsa `finalize_payment_intent` con `p_residual>0`. `release`=split 100, `refund`=split 0, `split`=parcial: son los tres el mismo cómputo (DT-3).
- El status-check (b) es **advisory** (disclosure/fail-fast). El gate real es el RPC: si dos overrides corren, el segundo cae en la rama recovery (`prev_status='arb_closing'`) → `applyRecovery` no-op in-flight (CD-10).
- NO hacés ningún `UPDATE` de status en la app (CD-3). La única transición la hace el RPC.

### 6.5 Gate de cierre W1

- [ ] `biome check` (CD-12, con `// biome-ignore lint/suspicious/noThenProperty` en test doubles awaitables si hace falta).
- [ ] Unit tests T-2/T-3/T-4/T-6/T-7/T-8/T-10 verdes.
- [ ] `npx tsc --noEmit` verde.

---

## 7. W2 — Rutas admin en `src/routes/dashboard.ts`

1. Imports nuevos:
```ts
import { arbiterService, isArbiterEnabled } from '../services/arbiter.js';
import { ArbiterError } from '../types/arbiter.js';
```

2. Mapper local disclosure-safe (espejo de `payments.ts:78-99`, SIN importar el de payments.ts):
```ts
function sendArbiterAdminError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof ArbiterError) {
    switch (err.code) {
      case 'INVALID_INPUT':       return reply.status(422).send({ error_code: 'INVALID_INPUT' });
      case 'OWNERSHIP_MISMATCH':  return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
      case 'INTENT_NOT_FOUND':    return reply.status(404).send({ error_code: 'INTENT_NOT_FOUND' });
      case 'INTENT_NOT_OPEN':     return reply.status(409).send({ error_code: 'INTENT_NOT_OPEN' });
      case 'CHAIN_NOT_SUPPORTED': return reply.status(422).send({ error_code: 'CHAIN_NOT_SUPPORTED' });
      default:                    return reply.status(500).send({ error_code: 'ARBITER_FAILED' });
    }
  }
  return reply.status(500).send({ error_code: 'ARBITER_FAILED' });
}
```

3. `GET /api/arbitrations/holds` (path real `/dashboard/api/arbitrations/holds`).
Registrar dentro del plugin con `{ config: { rateLimit: false }, preHandler: requireAdminToken }`:
```ts
// CD-5: cross-tenant DELIBERADO (admin ve holds de TODOS los owners). Alto privilegio.
if (!isArbiterEnabled()) {
  return reply.status(404).send({ error_code: 'NOT_FOUND' }); // AC-8/CD-7
}
try {
  const holds = await arbiterService.listHolds();
  return reply.send({ holds, total: holds.length });
} catch (err) {
  request.log.error(
    { detail: err instanceof Error ? err.message : 'unknown' },
    'list holds failed',
  );
  return sendArbiterAdminError(reply, err);
}
```

4. `POST /api/arbitrations/:intentId/resolve` (mismo `config`/`preHandler`):
```ts
if (!isArbiterEnabled()) {
  return reply.status(404).send({ error_code: 'NOT_FOUND' }); // AC-8/CD-7
}
const body = (request.body ?? {}) as {
  decision?: string; splitPct?: number; resolvedBy?: string; note?: string;
};
// Validacion de shape defensiva en la ruta; la autoritativa vive en resolveHold.
if (body.decision !== 'release' && body.decision !== 'refund' && body.decision !== 'split') {
  return reply.status(422).send({ error_code: 'INVALID_INPUT' });
}
try {
  const outcome = await arbiterService.resolveHold(request.params.intentId, {
    decision: body.decision,
    ...(body.splitPct !== undefined ? { splitPct: body.splitPct } : {}),
    resolvedBy: body.resolvedBy ?? null,
    note: body.note ?? null,
  });
  return reply.status(200).send({
    decision: outcome.decision,
    method: outcome.method,
    status: outcome.status,
    settleUsd: outcome.settleUsd,
    residualUsd: outcome.residualUsd,
    txHash: outcome.txHash,
  });
} catch (err) {
  request.log.error(
    { errorClass: err instanceof Error ? err.constructor.name : 'unknown' },
    'resolveHold failed',
  );
  return sendArbiterAdminError(reply, err);
}
```
> Tipar el handler POST con `FastifyRequest<{ Params: { intentId: string } }>`.
> El `...(body.splitPct !== undefined ? ...)` es por `exactOptionalPropertyTypes`
> (CD-15 heredado, ver `types/arbiter.ts:10`) — no pasar `splitPct: undefined`.

### 7.1 Gate de cierre W2

- [ ] `biome check` (CD-12).
- [ ] Integración T-1/T-5/T-9 verdes.
- [ ] `npx tsc --noEmit` verde.

---

## 8. W3 — Panel en `src/static/dashboard.html`

Agregar una sección nueva (mismo estilo que las existentes: `<h3 class="section-title">` + `<div id="...">`). Todo en **español, SIN em dashes**, con `esc()` en todo dato de servidor.

Requisitos:
1. Encabezado `<h3 class="section-title">Disputas en revision</h3>`.
2. Input `<input id="admin-token" placeholder="X-Admin-Token" type="password">` + botón "Cargar holds". Persistir el valor en `localStorage` (leer al cargar la página, guardar al escribir).
3. Input opcional `<input id="resolved-by" placeholder="Tu nombre (auditoria)">` para poblar `resolvedBy`.
4. `<div id="holds-table"></div>` para la tabla.
5. Helper `adminFetch(url, opts)` que agrega el header `X-Admin-Token` (valor del input `#admin-token`) a `opts.headers`. **Los fetch existentes (`fetchJSON`) NO se tocan.**
6. `loadHolds()`: `GET /dashboard/api/arbitrations/holds` vía `adminFetch`.
   - Si status 404 → render estado neutro "Arbitraje deshabilitado o sin holds" (NO error).
   - Si 401 → "Token invalido o ausente".
   - Si OK → tabla con columnas: intent (primeros 8 chars, `esc`), chain, `at_stake_usd`, `ambiguity_reason`, `method`, y por fila 3 botones: **Liberar** (release) / **Reembolsar** (refund) / **Dividir** (split).
7. `resolveHoldUI(intentId, decision)`:
   - `confirm("Confirmas <decision> sobre el intent <id8>? Esto mueve fondos y es irreversible.")`. Si cancela → return.
   - Si `decision === 'split'`: `prompt("Porcentaje al Seller (0-100)")` → parsear a número; si inválido → avisar y return.
   - `POST /dashboard/api/arbitrations/:id/resolve` vía `adminFetch` con body `{ decision, splitPct?, resolvedBy, note }` (`resolvedBy` del input `#resolved-by`; `note` opcional).
   - Tras éxito → `loadHolds()` de nuevo. Tras error → mostrar el `error_code`.
8. NO agregar `loadHolds()` a `refreshAll()` (dashboard.html:267) — se dispara manualmente con "Cargar holds" (el auto-refresh de 5s NO debe llamar al endpoint admin-gated sin token).

### 8.1 Gate de cierre W3

- [ ] Revisar render manual (no hay build TS de HTML). Sin em dashes. `esc()` en todo dato.
- [ ] `biome check` no aplica a `.html`; verificar solo que no rompiste el `<script>`.

---

## 9. Tests requeridos (T-1..T-11)

Patrón: `src/services/arbiter.test.ts` (servicio, in-memory FIEL a la semántica SQL,
test doubles awaitables con `// biome-ignore lint/suspicious/noThenProperty`) y
`src/routes/dashboard.test.ts` (rutas, `Fastify()` + `app.inject`, mock de servicios).
**NO tocar los tests existentes** (los 88 de WKH-139 en arbiter.test.ts + los de dashboard.test.ts).

| ID | Cubre | Tipo | Archivo | Descripción / setup |
|----|-------|------|---------|---------------------|
| T-1 | AC-1 | integración | dashboard.test.ts | `GET /dashboard/api/arbitrations/holds` con token válido lista holds cross-tenant (2 owners distintos) con evidencia. Mock `arbiterService.listHolds` → 2 items de owners distintos; assert ambos en la respuesta + `total===2`. `ARBITER_ENABLED='true'` + `DASHBOARD_ADMIN_TOKEN` set. |
| T-2 | AC-2 | unit | arbiter.test.ts | `resolveHold(release)` sobre intent `arb_hold` → `executeArbitration` settlea al seller; status `executed`; transición `arb_hold→arb_closing→settled`. Setup: intent en `arb_hold`, `chain_id=2368`, `mockSettle` → settled. Assert `settleUsd===deposit`, `residualUsd===0`, tx presente. |
| T-3 | AC-3 | unit | arbiter.test.ts | override persiste `method='admin_override'`, `resolved_by`, `resolved_at`, `resolution_note` en el upsert y **preserva** `ambiguity_reason`/`llm_reasoning` del hold original; recibo emitido con `receiptTypeFor(decision)`. Assert sobre el objeto pasado a `supabase.from('a2a_arbitrations').upsert(...)` y sobre `mockEmit`. |
| T-4 | AC-4 | unit | arbiter.test.ts | `resolveHold` sobre intent inexistente → `INTENT_NOT_FOUND`; sobre `settled`/`open` → `INTENT_NOT_OPEN`; **cero** llamadas a `settlePaymentIntentOnChain`/`mockSettle`. |
| T-5 | AC-5 | integración | dashboard.test.ts | GET y POST sin `X-Admin-Token` (con `DASHBOARD_ADMIN_TOKEN` seteado) → 401; datos ajenos no expuestos; `resolveHold`/`listHolds` NO invocados (assert mock no llamado). |
| T-6 | AC-6 | unit | arbiter.test.ts | `resolveHold` sobre intent con `chain_id` mainnet (p.ej. 1) → `CHAIN_NOT_SUPPORTED` fail-closed; sin mover fondos (mockSettle no llamado). |
| T-7 | AC-7 / CD-9 | unit | arbiter.test.ts | `resolveHold(split, splitPct)` con `at_stake_usd` **> ARBITER_AUTO_CAP_USD** (setear `ARBITER_AUTO_CAP_USD=25`, deposit=1000) ejecuta igual (sin cap) y clampa `settleUsd` a `[0,deposit]`; `splitPct>100` → clamp a deposit; `release` de deposit grande no excede deposit. |
| T-8 | AC-2 / CD-10 | unit | arbiter.test.ts | idempotencia: segundo `resolveHold` (o retry) sobre intent ya en `arb_closing` con `settle_outcome=NULL` → no-op in-flight (rama `applyRecovery` L600), sin double-settle, con `allowStaleRecovery=false`. |
| T-9 | AC-8 / CD-7 | integración | dashboard.test.ts | con `ARBITER_ENABLED` != 'true', GET y POST → 404 `{error_code:'NOT_FOUND'}` byte-idéntico, INCLUSO con token válido. |
| T-10 | CD-8 / R-1 | unit | arbiter.test.ts | regresión del hazard: (a) documentar/verificar que `expireStale` NO selecciona `arb_hold` (solo `arb_closing` payment-intent.ts:1177 y `disputed` L1192); (b) `recoverArbClosing` forzado sobre un `arb_hold` NO reembolsa el deposit. Blinda el invariante que hace seguro el ensanche. |
| T-11 | migración | estructural | arbiter.test.ts | `readFileSync` del `.sql` up (patrón `spend-policy.test.ts:362-407`): contiene el predicado `IN ('disputed','arb_hold')`, el CHECK con `admin_override`, y las 3 columnas (`resolved_by`/`resolved_at`/`resolution_note`); el `.sql` down los revierte (predicado `= 'disputed'`, CHECK sin `admin_override`, 3 `DROP COLUMN`). **Contar sentencias completas, NO substrings** (aprendizaje WKH-116): p.ej. verificar exactamente 1 ocurrencia del predicado ensanchado en el up y que el down NO lo contiene; para las 3 columnas, assert las 3 `ADD COLUMN` presentes en up y las 3 `DROP COLUMN` en down. |

> T-11 anti-substring: no uses solo `toContain('admin_override')` (aparece en el
> comentario también). Verificá la sentencia SQL completa (`CHECK (method IN ('rules','llm','hold','admin_override'))`)
> y contá ocurrencias donde importe (p.ej. `sql.split('admin_override').length - 1`).

---

## 10. Done Definition

- [ ] Los 8 archivos de Scope IN (§2) modificados/creados; ningún otro tocado.
- [ ] Migración up + down escritas byte-a-byte (§5), predicado ensanchado a `IN ('disputed','arb_hold')`, resto del RPC verbatim vs WKH-139.
- [ ] `ArbiterMethod` extendido; TODAS las construcciones de `ArbMeta` del auto-path pasan los 3 campos = `null` (CD-11).
- [ ] `resolveHold` reusa `executeArbitration` (CD-1), sin cap (CD-9), testnet-guard (AC-6), `owner_ref` del row real (CD-4), `allowStaleRecovery=false` (CD-10), sin `UPDATE` de status en app (CD-3).
- [ ] `listHolds` cross-tenant documentado como alto privilegio (CD-5).
- [ ] 2 rutas admin bajo `requireAdminToken` + gate `isArbiterEnabled` (404 byte-idéntico, CD-7/AC-8); errores disclosure-safe.
- [ ] `record_settle_outcome`/`finalize_payment_intent`/`expireStale` NO tocados (CD-6/CD-8).
- [ ] Panel en dashboard.html: español, sin em dashes, `esc()` en todo dato, token en `localStorage`, NO en `refreshAll`.
- [ ] T-1..T-11 verdes; los 88 tests de WKH-139 + los de dashboard.test.ts intactos.
- [ ] `npx tsc --noEmit` verde; `biome check` verde en cada archivo tocado (CD-12).
- [ ] Suite completa (`npm test` o el runner del repo) verde.
- [ ] Estado final: `DONE (código) · PENDING-DEPLOY` (NO aplicar migración a `caldz`, NO flipear flags — es Bloque ops fuera de esta HU).

---

## 11. VERIFY-AT-IMPL (confirmar al abrir el código, antes de escribir)

1. Cuerpo real de `close_payment_intent_for_arbitration` en `20260704100000_wkh139_arbiter.sql` — copiar verbatim, cambiar SOLO el predicado. El original manda sobre el snippet de §5.1.
2. FK `a2a_arbitrations.intent_id → a2a_payment_intents(id)` (habilita el embed PostgREST de `listHolds`) — migración WKH-139 (~L45).
3. Nombre real del constraint del CHECK method: al ser inline sin nombre en WKH-139, Postgres lo auto-nombra `a2a_arbitrations_method_check` (convención PG). El `DROP CONSTRAINT IF EXISTS` es tolerante igual.
4. Dónde exportar `AdminHoldItem` (types/arbiter.ts vs local) según lo que ya exporta el módulo del servicio.
5. Que los tests de rutas usan `app.inject` (confirmar con `dashboard.test.ts` existente) y los de servicio mockean `supabase.rpc`/`supabase.from` (confirmar con `arbiter.test.ts`).
