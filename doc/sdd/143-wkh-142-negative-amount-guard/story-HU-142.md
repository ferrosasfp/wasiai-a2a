# Story File — HU WKH-142: guard de importe negativo en el money-path

> Contrato autocontenido para `nexus-dev`. **NO releas el SDD** — todo lo que
> necesitás está acá. Fuente: `sdd.md` (SPEC_APPROVED).
> Branch: `fix/143-wkh-142-negative-amount-guard`.
> SDD_MODE: full · Estimación: S · Money-path / security.

---

## 1. Contexto compacto (qué se construye y por qué)

WKH-134 dejó abierta la **defensa final** contra importes negativos en el punto
de débito. Hoy un `p_amount_usd`/`priceUsdc` negativo que llegue al RPC de débito
**SUMA** al budget prepago en vez de restar (`new_bal = current − (−X)`), y
neutraliza el check de fondos y el daily-limit. Esta HU cierra 3 huecos:

1. **DB choke-point**: guard `p_amount_usd IS NULL / < 0 / NaN` dentro de
   `increment_a2a_key_spend` (los 4 RPC de débito la atraviesan vía `PERFORM`
   → un IF cierra las 4 rutas, sin duplicar).
2. **App-layer compose**: `compose.isInvalid` hoy NO cubre `< 0` → se agrega.
3. **DB constraint**: `CHECK (price_usdc >= 0)` en `a2a_agents` + clamp de datos
   preexistentes ANTES del constraint.

Además se agrega un **error code estable** (`DEBIT_INVALID_AMOUNT`) mapeado en
las 4 rutas de `budgetService.debit` para consistencia de contrato.

---

## 2. Scope IN — lista exhaustiva de archivos a tocar

| # | Archivo | Acción | Wave |
|---|---|---|---|
| 1 | `supabase/migrations/20260707000000_wkh142_negative_amount_guard.sql` | **CREAR** | W0 |
| 2 | `supabase/migrations/20260707000000_wkh142_negative_amount_guard_down.sql` | **CREAR** | W0 |
| 3 | `src/services/security/errors.ts` | agregar class `InvalidDebitAmountError` | W1 |
| 4 | `src/services/budget.ts` | mapear `INVALID_AMOUNT` en las 4 rutas | W1 |
| 5 | `src/services/delegation.ts` | mapear `INVALID_AMOUNT` → `throw InvalidDebitAmountError` | W1 |
| 6 | `src/services/key-session.ts` | mapear `INVALID_AMOUNT` → `throw InvalidDebitAmountError` | W1 |
| 7 | `src/services/compose.ts` (L207-210) | agregar `\|\| agent.priceUsdc < 0` | W2 |
| 8 | Tests (ver §7) | CREAR/extender | W3 |

**PROHIBIDO tocar cualquier archivo fuera de esta lista.**

---

## 3. Anti-Hallucination Checklist (símbolos verificados — usalos tal cual)

Todos verificados con Read en el codebase. **No inventes rutas, líneas ni firmas.**

- [x] `increment_a2a_key_spend(p_key_id UUID, p_chain_id INT, p_amount_usd NUMERIC, p_owner_ref TEXT) RETURNS void` — cuerpo vigente en `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql:20-93`. Firma de **4 params, NO cambia** (CD-1).
- [x] Ownership guard en ese archivo: `IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN RAISE ... END IF;` (L47-49). El `is_active` check está en L51.
  → **El guard nuevo va EXACTAMENTE entre el `END IF;` (L49) y el `IF NOT v_row.is_active` (L51).**
- [x] Hardening vigente (L95-101): `ALTER FUNCTION ... SET search_path = public, pg_temp;` + `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated;` + `GRANT EXECUTE ... TO service_role;` (firma `(uuid, integer, numeric, text)`). **DEBE re-aplicarse (CD-4).**
- [x] Tabla `a2a_agents`: `price_usdc NUMERIC NOT NULL DEFAULT 0` **sin CHECK** (`20260703000000_wkh134_a2a_agents.sql:26`). Migración usa `BEGIN;`/`COMMIT;` (L18, L46).
- [x] `refund_a2a_key_spend` vive en `20260623000000_wkh127_refund_a2a_key_spend.sql` — **NO se toca (CD-2)**. Tampoco `refund_with_dest_policy` / `refund_delegation_and_parent` / `refund_session_and_parent`.
- [x] `compose.isInvalid` en `src/services/compose.ts:207-210`: `typeof agent.priceUsdc !== 'number' || agent.priceUsdc === 0 || Number.isNaN(agent.priceUsdc)`.
- [x] Error class pattern en `src/services/security/errors.ts:228-234` (`AgentKeyBudgetExhaustedError`): `class X extends Error { readonly code = 'CODE' as const; constructor(){ super('...'); this.name='X'; } }`.
- [x] `budget.ts` importa error classes desde `'./security/errors.js'` (L18-33). Rutas: session (catch L137-176), delegación (catch L217-263), master-dest (L287-310), master (L328-352).
- [x] `delegation.ts` importa de `'./security/errors.js'` (L46). Bloque de mapeo msg→class en L410-457; agrupar el nuevo branch con los prefijos del parent RPC (L433-441).
- [x] `key-session.ts` importa de `'./security/errors.js'` (L30-43). Bloque de mapeo en L475-518; agrupar con prefijos del parent RPC (L496-507).
- [x] Timestamp `20260707000000` es posterior al último (`20260706000000_wkh137`) — **sin colisión**.

### `[VERIFY-AT-IMPL]` — puntos a confirmar al implementar
- `[VERIFY-AT-IMPL-1]` El literal `p_amount_usd = 'NaN'::numeric` es el chequeo correcto de NaN en Postgres NUMERIC. **NO usar `x <> x`** (en Postgres numeric `NaN = NaN` es `true`, `NaN <> NaN` es `false` → no detecta). Confirmá al escribir el SQL.
- `[VERIFY-AT-IMPL-2]` El mapeo de `INVALID_AMOUNT` debe agregarse en las **4 rutas** (master, master-dest, session, delegación). Confirmá los 4 números de línea contra el archivo real antes de editar (pueden correrse ±pocas líneas).

---

## 4. Waves de implementación

### W0 — Migración SQL (SERIAL, PRIMERO — es la fuente de verdad del error code)

**Archivo 1 (UP): `20260707000000_wkh142_negative_amount_guard.sql`**

Todo dentro de UN `BEGIN;` / `COMMIT;`. Orden EXACTO:

1. **`CREATE OR REPLACE FUNCTION increment_a2a_key_spend(uuid, integer, numeric, text)`**
   — cuerpo **COPIA LITERAL** de `20260609000000_wkh_sec02b_owner_ref_rpc.sql:20-93`
   (misma firma de 4 params, mismo `DECLARE`, misma lógica), con **UN SOLO bloque
   nuevo insertado** entre el `END IF;` del ownership guard y el `IF NOT v_row.is_active`:

   ```sql
   -- WKH-142 (AC-1): defensa en profundidad. Rechaza NULL / < 0 / NaN ANTES de
   -- tocar budget/daily_spent. Choke-point único: los 4 RPC de débito heredan el
   -- guard vía PERFORM (AC-2). CD-9: 0 sigue siendo válido (estrictamente < 0).
   IF p_amount_usd IS NULL OR p_amount_usd < 0 OR p_amount_usd = 'NaN'::numeric THEN
     RAISE EXCEPTION 'INVALID_AMOUNT: p_amount_usd % must be a non-negative number', p_amount_usd;
   END IF;
   ```
   - `SECURITY DEFINER` y `LANGUAGE plpgsql` se preservan (copia literal del original).
   - **NO** hagas `DROP FUNCTION` previo (la aridad no cambia — DT-2/CD-1).

2. **Hardening re-aplicado (CD-4)** — copia literal de sec02b L95-101:
   ```sql
   ALTER FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric, text)
     SET search_path = public, pg_temp;
   REVOKE EXECUTE ON FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric, text)
     FROM PUBLIC, anon, authenticated;
   GRANT EXECUTE ON FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric, text)
     TO service_role;
   ```

3. **Clamp de datos ANTES del constraint (CD-3):**
   ```sql
   UPDATE public.a2a_agents SET price_usdc = 0 WHERE price_usdc < 0;
   ```

4. **Constraint (después del clamp, misma tx):**
   ```sql
   ALTER TABLE public.a2a_agents
     ADD CONSTRAINT a2a_agents_price_usdc_nonneg CHECK (price_usdc >= 0);
   ```

**Archivo 2 (DOWN): `20260707000000_wkh142_negative_amount_guard_down.sql`**

Dentro de `BEGIN;`/`COMMIT;`:
1. `ALTER TABLE public.a2a_agents DROP CONSTRAINT IF EXISTS a2a_agents_price_usdc_nonneg;`
2. `CREATE OR REPLACE FUNCTION increment_a2a_key_spend(...)` **restaurada SIN el guard**
   — copia literal de sec02b UP L20-101 (cuerpo original + su hardening completo).
   El down NO des-clampea filas (irreversible, aceptable — no hay dato original).

**CDs de W0 (inviolables):**
- El guard queda **ANTES** del `UPDATE a2a_agent_keys` (path de rechazo sin mutación) — AC-1.
- El literal es `= 'NaN'::numeric`, no `<> self` — DT-3.
- El hardening (search_path/REVOKE/GRANT) **NO se pierde** — CD-4.
- El string `INVALID_AMOUNT` aparece **EXACTAMENTE UNA VEZ** en el UP. Los 3 RPC
  hermanos (`debit_with_dest_policy`, `debit_session_and_parent`,
  `debit_delegation_and_parent`) **NO se redefinen** — CD-7.
- El `UPDATE` de clamp **precede** al `ADD CONSTRAINT` en la MISMA tx — CD-3.
- `refund_*` **intactas** — CD-2.

---

### W1 — Error code estable en el mapeo TS (paralelizable con W2)

**Archivo 3 — `src/services/security/errors.ts`:** agregar (patrón de L228-234):
```ts
/** RPC `INVALID_AMOUNT` (importe de débito NULL / negativo / NaN) → 400/input error. */
export class InvalidDebitAmountError extends Error {
  readonly code = 'DEBIT_INVALID_AMOUNT' as const;
  constructor() {
    super('Debit amount must be a non-negative number');
    this.name = 'InvalidDebitAmountError';
  }
}
```

**Archivo 4 — `src/services/budget.ts`:** (4 rutas — mapear `INVALID_AMOUNT` → `DEBIT_INVALID_AMOUNT`)
- Import: agregar `InvalidDebitAmountError` al bloque de imports desde `'./security/errors.js'`.
- **Ruta session** (catch L137-176): agregar, junto a los otros `err instanceof`, ANTES del fallback `SESSION_DEBIT_FAILED`:
  ```ts
  if (err instanceof InvalidDebitAmountError) {
    return { success: false, error: 'DEBIT_INVALID_AMOUNT' };
  }
  ```
- **Ruta delegación** (catch L217-263): mismo branch, ANTES del fallback `DELEGATION_DEBIT_FAILED`.
- **Ruta master-dest** (L287-310, `msg.includes(...)`): agregar ANTES del fallback `DEST_POLICY_DEBIT_FAILED`:
  ```ts
  if (msg.includes('INVALID_AMOUNT')) {
    return { success: false, error: 'DEBIT_INVALID_AMOUNT' };
  }
  ```
- **Ruta master** (L328-352, `msg.includes(...)`): mismo branch, ANTES del fallback `DEBIT_FAILED`.

**Archivo 5 — `src/services/delegation.ts`:** (bloque msg→class, L410-457)
- Import: agregar `InvalidDebitAmountError` al import de `'./security/errors.js'`.
- Agrupar con los prefijos del parent RPC (junto a `DAILY_LIMIT`/`KEY_INACTIVE`, ~L433-441):
  ```ts
  if (msg.includes('INVALID_AMOUNT')) {
    throw new InvalidDebitAmountError();
  }
  ```

**Archivo 6 — `src/services/key-session.ts`:** (bloque msg→class, L475-518)
- Import: agregar `InvalidDebitAmountError` al import de `'./security/errors.js'` (L30-43).
- Agrupar con los prefijos del parent RPC (junto a `INSUFFICIENT_BUDGET`/`DAILY_LIMIT`, ~L496-507):
  ```ts
  if (msg.includes('INVALID_AMOUNT')) {
    throw new InvalidDebitAmountError();
  }
  ```

**CDs de W1:**
- El código de salida es `DEBIT_INVALID_AMOUNT` (no `INVALID_AMOUNT` crudo, no
  `DEBIT_FAILED`) — CD-8.
- El msg crudo de Postgres NUNCA llega al cliente (todos los branches devuelven/
  lanzan un code estable; el detalle va al `log.error` existente) — CD-8.
- Todos los cambios son **aditivos** (una branch nueva por bloque) — no modificar
  branches existentes.

---

### W2 — compose.isInvalid (paralelizable con W1)

**Archivo 7 — `src/services/compose.ts:207-210`:** agregar `|| agent.priceUsdc < 0`:
```ts
const isInvalid =
  typeof agent.priceUsdc !== 'number' ||
  agent.priceUsdc === 0 ||
  agent.priceUsdc < 0 ||
  Number.isNaN(agent.priceUsdc);
```
- **CD-5:** el fix DEBE ser explícitamente `agent.priceUsdc < 0`. NO reemplazar
  `Number.isNaN` (NaN ya está cubierto). El short-circuit de `typeof !== 'number'`
  garantiza que `< 0` solo se evalúa sobre un `number`.
- No tocar `debitAmount` (L217-218) ni el `warn` (L220+): con `isInvalid=true`, el
  fallback `PLACEHOLDER_FEE_USD` ya aplica.

---

### W3 — Tests (después de W0-W2)

Ver §7.

---

## 5. Reuso / Grep (cómo lo hace hoy el codebase — imitá, no inventes)

- **Mapeo de los otros errores del RPC hoy:**
  - Rutas directas (`msg.includes(...)` → `return { success:false, error:'CODE' }`):
    `budget.ts` master L334-352 y master-dest L287-310. Mapean `OWNERSHIP_MISMATCH`,
    `INSUFFICIENT_BUDGET`→`AGENT_KEY_BUDGET_EXHAUSTED`, `DAILY_LIMIT`, `KEY_INACTIVE`,
    `KEY_NOT_FOUND`, con fallback `DEBIT_FAILED`/`DEST_POLICY_DEBIT_FAILED`.
  - Rutas tipadas (`msg.includes(...)` → `throw new XError()` en el service, cacheado
    en `budget.ts`): `delegation.ts` L410-457 y `key-session.ts` L475-518.
    `budget.ts` cachea esas classes (L137-176 session, L217-263 delegación) → code.
  - **Patrón exacto a copiar** para `INVALID_AMOUNT`: agregá una branch más siguiendo
    el mismo estilo del bloque en el que insertás.
- **Patrón de hardening del RPC:** `SET search_path` + `REVOKE ... FROM PUBLIC, anon,
  authenticated` + `GRANT ... TO service_role` (sec02b L95-101). Copiá literal.
- **`refund_a2a_key_spend`:** ya defensiva (`IF p_amount_usd IS NULL OR <= 0 THEN
  RETURN;`). **NO la toques** (CD-2). Ningún caller legítimo pasa negativos al débito
  → el guard nuevo no rompe flujos existentes.

---

## 6. Constraint Directives (inviolables — heredadas del work-item + SDD)

- **CD-1:** NO modificar la firma/aridad de `increment_a2a_key_spend` (uuid, integer, numeric, text). Solo insertar el IF.
- **CD-2:** NO tocar `refund_*` (ruta de crédito, ya defensiva).
- **CD-3:** el `UPDATE` de clamp precede al `ADD CONSTRAINT` en la MISMA tx.
- **CD-4:** re-aplicar el hardening completo al recrear la función (no perderlo).
- **CD-5:** compose fix explícito `agent.priceUsdc < 0` (no `Number.isNaN`).
- **CD-6:** guard NULL / `< 0` / `'NaN'::numeric` en un ÚNICO IF; prefijo estable `INVALID_AMOUNT:`.
- **CD-7:** `INVALID_AMOUNT` aparece **exactamente una vez** en la migración UP.
- **CD-8:** code de salida `DEBIT_INVALID_AMOUNT`; msg crudo de PG nunca llega al cliente.
- **CD-9:** `p_amount_usd = 0` sigue VÁLIDO. Guard estrictamente `< 0` (o NULL/NaN), nunca `<= 0`.

---

## 7. Tests requeridos (≥1 por AC + no-regresión)

`vitest`. Los tests de migración son **estructurales** (readFileSync sobre el `.sql`
+ regex/`indexOf`/`toContain`): el repo **NO tiene Postgres in-process** (no hay
`pg-mem`/`PGlite`/`newDb`). Modelos exemplar: `test/agent-links.migration.test.ts`,
`src/services/budget.test.ts:216-247`, `src/services/compose.test.ts:380-408`,
`src/services/money-path.concurrency.test.ts:20-45`.

| # | AC | Qué cubre | Archivo | Tipo |
|---|---|---|---|---|
| T1 | AC-1 | El UP contiene el guard `IF p_amount_usd IS NULL OR ... < 0 OR = 'NaN'::numeric` + `RAISE EXCEPTION 'INVALID_AMOUNT'` dentro de `increment_a2a_key_spend`, y aparece ANTES (indexOf menor) del `UPDATE a2a_agent_keys` | `test/negative-amount-guard.migration.test.ts` (nuevo) | Estructural |
| T2 | AC-1 (comportamiento) | Modelo in-memory / `mockRpc` error: `increment_a2a_key_spend(..., amount<0)` → `INVALID_AMOUNT` y el balance NO cambia | extender `money-path.concurrency.test.ts` o `budget.test.ts` | Comportamiento |
| T3 | AC-2 | `INVALID_AMOUNT` aparece **exactamente una vez** en el UP (choke-point); los 3 RPC `debit_*` NO se redefinen en la migración | `test/negative-amount-guard.migration.test.ts` | Estructural |
| T4 | AC-3 | compose per-step con `priceUsdc: -1` → `budgetService.debit` recibe `PLACEHOLDER_FEE_USD + gas` (NO negativo) + `warn` reason `registry-miss` | `src/services/compose.test.ts` (nuevo caso) | Unit |
| T5 | AC-4 | En el UP, `UPDATE ... SET price_usdc = 0 WHERE price_usdc < 0` aparece ANTES (indexOf menor) del `ADD CONSTRAINT` | `test/negative-amount-guard.migration.test.ts` | Estructural |
| T6 | AC-5 (presencia) | El UP declara `ADD CONSTRAINT a2a_agents_price_usdc_nonneg CHECK (price_usdc >= 0)`; el down hace `DROP CONSTRAINT IF EXISTS` | `test/negative-amount-guard.migration.test.ts` | Estructural |
| T7 | Error code | `budgetService.debit` mapea `INVALID_AMOUNT` (rpc error) → `{ success:false, error:'DEBIT_INVALID_AMOUNT' }` en rutas master y master-dest | `src/services/budget.test.ts` (modelo L216-247) | Unit |
| T8 | Error code | `delegation.ts`/`key-session.ts` lanzan `InvalidDebitAmountError` ante `INVALID_AMOUNT`; `budget.ts` lo mapea a `DEBIT_INVALID_AMOUNT` en session/delegación | `src/services/delegation.test.ts` + `key-session.test.ts` | Unit |
| T9 | **No-regresión** | Débito POSITIVO legítimo (`priceUsdc: 1.0`) sigue: `debit` recibe `1.0 + gas` (no fallback), retorna `success:true`; suite money-path verde | `compose.test.ts` + `budget.test.ts` | Unit |

**AC-5 — verificación real (fuera del suite unit):** el suite valida la PRESENCIA
del constraint (T6). Que un `INSERT INTO a2a_agents (..., price_usdc) VALUES (..., -1)`
sea rechazado con `23514` se valida en **Postgres efímero / staging** al aplicar
la migración (mismo proceso que WKH-136). **Responsabilidad de F4 (QA)** —
documentar evidencia. NO es bloqueante para el Dev.

---

## 8. Done Definition

- [ ] W0: los 2 archivos de migración creados; UP con guard + hardening re-aplicado + clamp + constraint en una tx; down con drop + función restaurada sin guard.
- [ ] `INVALID_AMOUNT` aparece exactamente 1 vez en el UP; `refund_*` no tocadas; los 3 RPC hermanos no redefinidos.
- [ ] W1: `InvalidDebitAmountError` en `errors.ts`; mapeo en las 4 rutas de `budget.debit` (+ imports en los 3 services).
- [ ] W2: `|| agent.priceUsdc < 0` en `compose.ts:207-210`.
- [ ] W3: T1-T9 escritos y verdes.
- [ ] `npm run build` (tsc strict, sin `any`) y `npm test` verdes.
- [ ] `git grep INVALID_AMOUNT supabase/migrations/20260707000000*` → 1 sola ocurrencia en el UP.
- [ ] Ningún archivo fuera del Scope IN (§2) modificado.
