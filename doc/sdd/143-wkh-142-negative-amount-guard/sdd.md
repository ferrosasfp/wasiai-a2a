# SDD — [WKH-142] Defensa en profundidad: guard de importe negativo en el money-path

> Fase F2 (SDD). SDD_MODE: full. Estimación: S. Money-path / security.
> Branch: `fix/143-wkh-142-negative-amount-guard`.
> Input: `doc/sdd/143-wkh-142-negative-amount-guard/work-item.md` (HU_APPROVED).

---

## 1. Context Map — archivos leídos y patrón extraído

| Archivo (verificado) | Por qué | Patrón extraído |
|---|---|---|
| `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql:20-101` | Definición vigente de `increment_a2a_key_spend` (4 params) + hardening | Cuerpo literal a copiar; ownership guard en L47-49; `is_active` en L51; hardening `SET search_path` + `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role` en L95-101 |
| mismo archivo `:108-325` | Los 3 RPC de débito (`debit_with_dest_policy`, `debit_session_and_parent`, `debit_delegation_and_parent`) | **Choke-point confirmado**: los 3 terminan en `PERFORM increment_a2a_key_spend(...)` (L167, L238, L311). Un guard en la función maestra cierra las 4 rutas |
| `supabase/migrations/20260623000000_wkh127_refund_a2a_key_spend.sql` (ref F0) | Ruta de CRÉDITO | Ya defensiva (`<= 0` → no-op). **NO se toca** (CD-2) |
| `src/services/compose.ts:207-218` | `isInvalid` per-step (steps 2..N) | Hoy: `!number \|\| ===0 \|\| NaN`. `debitAmount = (isInvalid ? PLACEHOLDER_FEE_USD : priceUsdc) + stepGasOverhead`. `agent.priceUsdc < 0` se cuela |
| `src/services/budget.ts:102-355` | `budgetService.debit` — mapeo de errores del RPC → códigos estables | 4 rutas: key-session (L103-177), delegación (L179-264), master-dest (L266-313), master (L315-355). Master+dest mapean `msg.includes('CODE')` directo; session+delegación cachan error classes tipadas |
| `src/services/delegation.ts:410-452` | Mapeo msg PG → error classes (delegación) | `if (msg.includes('INSUFFICIENT_BUDGET')) throw new AgentKeyBudgetExhaustedError()` — patrón para agregar `INVALID_AMOUNT` |
| `src/services/key-session.ts:479+` | Mapeo msg PG → error classes (sesión) | Mismo patrón `msg.includes(...)` → `throw new ...Error()` |
| `src/services/security/errors.ts:228-269` | Error classes del money-path | Patrón `class XError extends Error { readonly code = 'CODE' as const; constructor(){ super('...'); this.name='XError'; } }` |
| `supabase/migrations/20260703000000_wkh134_a2a_agents.sql:20-46` | Tabla `a2a_agents` | `price_usdc NUMERIC NOT NULL DEFAULT 0` SIN CHECK. Migración usa `BEGIN;`/`COMMIT;` |
| `supabase/migrations/20260703000000_wkh134_a2a_agents_down.sql` | Patrón down | `BEGIN; ... COMMIT;` idempotente |
| `test/agent-links.migration.test.ts` | Harness de test de migración | **String-based** (`readFileSync` sobre el `.sql`, sin Postgres real) + regex/`toContain` sobre estructura SQL |
| `src/services/money-path.concurrency.test.ts:1-55` | Modelo in-memory de los RPC | Modela `increment_a2a_key_spend` (SELECT FOR UPDATE → INSUFFICIENT_BUDGET → debit) para tests de comportamiento sin PG real |
| `src/services/budget.test.ts:193-247` | Tests de mapeo de error | `mockRpc.mockResolvedValue({ error: { message: 'CODE: ...' } })` → assert `{ success:false, error:'CODE' }` |
| `src/services/compose.test.ts:360-408` | Tests per-step debit | `makeAgent({ priceUsdc })` + assert sobre `budgetService.debit` mock |

**Nota de infraestructura de test (relevante para AC-5):** el repo NO tiene un
runner de Postgres in-process (grep de `pg-mem`/`PGlite`/`newDb`/`Client(` → sin
match). Los tests de migración son **estructurales** (regex sobre el `.sql`). La
verificación del CHECK contra un INSERT real es responsabilidad de la verificación
en Postgres efímero / staging (fuera del suite unit), documentada abajo.

---

## 2. Decisiones técnicas (DT-N)

- **DT-1 (heredada del work-item):** guard SOLO en `increment_a2a_key_spend`
  (choke-point único). Los 4 RPC de débito atraviesan esa función vía `PERFORM`
  → un IF cierra las 4 rutas. NO duplicar en los otros 3.
- **DT-2 (heredada):** `CREATE OR REPLACE` sin `DROP FUNCTION` previo — la aridad
  (uuid, integer, numeric, text) NO cambia; solo se agrega un IF al cuerpo. NO
  aplica el gotcha de sobrecarga de WKH-SEC-02b (ese fue por cambio de aridad 3→4).
- **DT-3 (heredada):** el guard rechaza explícitamente `'NaN'::numeric`. En
  Postgres `NUMERIC` admite `NaN` y `NaN < 0` evalúa `false`; además `NaN <> NaN`
  es `false` (Postgres define `NaN = NaN` como `true`). Por eso el chequeo debe ser
  `p_amount_usd = 'NaN'::numeric` (NO el truco IEEE `x <> x`).
- **DT-4 (heredada):** el `UPDATE` de clamp precede al `ALTER TABLE ADD CONSTRAINT`
  en la MISMA migración/transacción (`BEGIN;`/`COMMIT;`). Migración auto-suficiente,
  reproducible en dev/staging/prod sin script manual previo (CD-3).
- **DT-5 (posición del guard):** el IF se inserta ENTRE el ownership guard
  (sec02b L49, `END IF;`) y el check `is_active` (L51), tal como especifica el
  work-item (Scope IN L100-101). Satisface AC-1 ("antes de tocar budget/daily_spent,
  sin cambios a la fila"): la única mutación es el `UPDATE` final (L85-91), muy
  posterior. Mantener el orden exacto minimiza el diff y respeta CD-1.
- **DT-6 (RESUELVE el Missing Input — error code estable):** el RPC hace
  `RAISE EXCEPTION 'INVALID_AMOUNT: ...'` (prefijo estable, mismo estilo que
  `INSUFFICIENT_BUDGET`/`OWNERSHIP_MISMATCH`/`KEY_NOT_FOUND`). El código de salida
  estable de `budgetService.debit` es **`DEBIT_INVALID_AMOUNT`**, mapeado en las
  **4 rutas** para consistencia de contrato:
    - Rutas directas (master L315-355, master-dest L266-313): agregar
      `if (msg.includes('INVALID_AMOUNT')) return { success:false, error:'DEBIT_INVALID_AMOUNT' };`
      ANTES del fallback genérico (`DEBIT_FAILED` / `DEST_POLICY_DEBIT_FAILED`).
    - Rutas tipadas (delegación `delegation.ts`, sesión `key-session.ts`): agregar
      `if (msg.includes('INVALID_AMOUNT')) throw new InvalidDebitAmountError();`
      en su bloque de mapeo, y cachear `InvalidDebitAmountError` en `budget.ts`
      (bloques catch de session L137-176 y delegación L217-263) → mismo código
      `DEBIT_INVALID_AMOUNT`.
  - Nueva error class `InvalidDebitAmountError` en `src/services/security/errors.ts`
    con `readonly code = 'DEBIT_INVALID_AMOUNT' as const` (patrón L228-269).
  - **Justificación de mapear las 4** (y no solo las 2 que nombra el Missing Input):
    dejar las rutas session/delegación cayendo en `SESSION_DEBIT_FAILED` /
    `DELEGATION_DEBIT_FAILED` (semántica "error de servidor / 503") para lo que es
    un error de input cliente/config sería una inconsistencia de contrato que el AR
    marcaría. `DEBIT_INVALID_AMOUNT` es un error de input (4xx-class), no un 503.
  - **Propiedad de seguridad garantizada en las 4 rutas independientemente del
    mapeo:** cualquier error del RPC ya devuelve `success:false` → compose corta el
    pipeline y el débito NO se aplica. El mapeo es consistencia de contrato /
    observabilidad; el dinero está seguro aunque el código fuese genérico.
- **DT-7 (down migration):** el down (a) hace `DROP CONSTRAINT IF EXISTS`
  `a2a_agents_price_usdc_nonneg` y (b) restaura `increment_a2a_key_spend` al cuerpo
  SIN el guard (copia literal de sec02b UP L20-101, con su hardening). El down NO
  des-clampea filas (irreversible y aceptable — no hay dato original que recuperar).
- **DT-8 (compose fix):** en `compose.ts` se agrega `|| agent.priceUsdc < 0` a la
  condición `isInvalid` (L207-210). El short-circuit de `typeof !== 'number'`
  garantiza que `< 0` solo se evalúa sobre un `number` (safe). CD-5: NO usar
  `Number.isNaN` como el cambio (NaN ya está cubierto por el check existente).

---

## 3. Constraint Directives (CD-N)

Heredadas del work-item (CD-1..CD-5) + específicas del SDD (CD-6..CD-9):

- **CD-1:** PROHIBIDO modificar la firma/aridad de `increment_a2a_key_spend`
  (uuid, integer, numeric, text). Solo agregar el IF al cuerpo (copiar literal +
  insertar el bloque).
- **CD-2:** PROHIBIDO tocar `refund_a2a_key_spend` / `refund_with_dest_policy` /
  `refund_delegation_and_parent` / `refund_session_and_parent` (ruta de crédito,
  ya defensivas).
- **CD-3:** OBLIGATORIO que el `ADD CONSTRAINT` esté precedido, en la MISMA
  transacción (`BEGIN;`/`COMMIT;`), por el `UPDATE` de clamp. Nunca asumir "no hay
  filas negativas hoy".
- **CD-4:** OBLIGATORIO re-aplicar el hardening (`SET search_path = public, pg_temp`,
  `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE ... TO
  service_role`) al recrear la función — no perderlo en el `CREATE OR REPLACE`.
- **CD-5:** el fix de `compose.isInvalid` debe ser explícitamente `agent.priceUsdc < 0`
  (NO `Number.isNaN` como el cambio nuevo).
- **CD-6 (SDD):** el guard debe rechazar `NULL`, `< 0` y `'NaN'::numeric` en un
  ÚNICO IF; el `RAISE` usa el prefijo estable `INVALID_AMOUNT:` (sin variantes).
- **CD-7 (SDD):** el string `INVALID_AMOUNT` debe aparecer **exactamente una vez**
  en la migración (choke-point único, DT-1). Los otros 3 RPC de débito NO se
  redefinen en esta migración.
- **CD-8 (SDD):** el código de salida estable es `DEBIT_INVALID_AMOUNT` (no
  `INVALID_AMOUNT` crudo, no `DEBIT_FAILED`). El mensaje crudo de Postgres NUNCA
  llega al cliente (patrón M5/AR-MNR-2 ya vigente en budget.ts L166/L252/L307/L330).
- **CD-9 (SDD):** `p_amount_usd = 0` sigue siendo VÁLIDO (débito de costo cero
  legítimo). El guard es estrictamente `< 0` (o NULL/NaN), nunca `<= 0`.

---

## 4. Waves de implementación

> W0 es SERIAL y va PRIMERO (migración = fuente de verdad del código estable que
> luego mapea el TS). W1 y W2 son paralelizables entre sí (archivos disjuntos).

### W0 — Migración SQL (serial, primero)
Archivos:
- `supabase/migrations/20260707000000_wkh142_negative_amount_guard.sql` (nuevo)
- `supabase/migrations/20260707000000_wkh142_negative_amount_guard_down.sql` (nuevo)

Contenido UP (dentro de `BEGIN;`/`COMMIT;`):
1. `CREATE OR REPLACE FUNCTION increment_a2a_key_spend(uuid, integer, numeric, text)`
   — cuerpo COPIA LITERAL de sec02b L20-93, con el bloque nuevo insertado entre el
   `END IF;` del ownership guard (L49) y el `IF NOT v_row.is_active` (L51):
   ```sql
   -- WKH-142 (AC-1): defensa en profundidad. Rechaza NULL / < 0 / NaN ANTES de
   -- tocar budget/daily_spent. Choke-point único: los 4 RPC de débito heredan el
   -- guard vía PERFORM. CD-9: 0 sigue siendo válido (estrictamente < 0).
   IF p_amount_usd IS NULL OR p_amount_usd < 0 OR p_amount_usd = 'NaN'::numeric THEN
     RAISE EXCEPTION 'INVALID_AMOUNT: p_amount_usd % must be a non-negative number', p_amount_usd;
   END IF;
   ```
2. Hardening re-aplicado (CD-4): `ALTER FUNCTION ... SET search_path` + `REVOKE` +
   `GRANT` (copia literal de sec02b L95-101).
3. `UPDATE public.a2a_agents SET price_usdc = 0 WHERE price_usdc < 0;` (CD-3, antes del constraint)
4. `ALTER TABLE public.a2a_agents ADD CONSTRAINT a2a_agents_price_usdc_nonneg CHECK (price_usdc >= 0);`

Contenido DOWN (dentro de `BEGIN;`/`COMMIT;`, DT-7):
1. `ALTER TABLE public.a2a_agents DROP CONSTRAINT IF EXISTS a2a_agents_price_usdc_nonneg;`
2. `CREATE OR REPLACE FUNCTION increment_a2a_key_spend(...)` restaurada SIN el guard
   (copia literal de sec02b UP L20-101, incluyendo hardening).

### W1 — Error code estable en el mapeo TS (paralelizable con W2)
Archivos:
- `src/services/security/errors.ts` — nueva class `InvalidDebitAmountError`
  (`code = 'DEBIT_INVALID_AMOUNT'`), patrón L228-269.
- `src/services/budget.ts` — agregar branch `INVALID_AMOUNT → DEBIT_INVALID_AMOUNT`:
  ruta master (antes de `DEBIT_FAILED` L350-351), ruta master-dest (antes de
  `DEST_POLICY_DEBIT_FAILED` L308-309), y `catch (InvalidDebitAmountError)` en los
  bloques session (L137-176) y delegación (L217-263) → `DEBIT_INVALID_AMOUNT`.
- `src/services/delegation.ts` — `if (msg.includes('INVALID_AMOUNT')) throw new InvalidDebitAmountError();`
  en el bloque de mapeo (~L410-452), agrupado con los prefijos del parent RPC.
- `src/services/key-session.ts` — mismo agregado en su bloque de mapeo (~L479+).

### W2 — compose.isInvalid (paralelizable con W1)
Archivo:
- `src/services/compose.ts:207-210` — agregar `|| agent.priceUsdc < 0` (DT-8, CD-5).

### W3 — Tests (después de W0-W2)
Ver §6.

---

## 5. Exemplars verificados (paths confirmados)

| Exemplar | Path:línea | Uso |
|---|---|---|
| RPC vigente + hardening | `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql:20-101` | Cuerpo literal a copiar + posición del guard (L49↔L51) |
| PERFORM del choke-point | mismo `:167, :238, :311` | Confirma que un guard cierra las 4 rutas |
| Tabla a2a_agents | `supabase/migrations/20260703000000_wkh134_a2a_agents.sql:26` | `price_usdc NUMERIC` sin CHECK |
| Migración con BEGIN/COMMIT | `supabase/migrations/20260703000000_wkh134_a2a_agents.sql:18,46` | Patrón transaccional |
| Error class del money-path | `src/services/security/errors.ts:228-234` | Patrón para `InvalidDebitAmountError` |
| Mapeo directo msg→code | `src/services/budget.ts:334-352` (master), `287-310` (dest) | Dónde insertar el branch |
| Mapeo msg→error class | `src/services/delegation.ts:421-422` | Patrón `throw new ...Error()` |
| isInvalid per-step | `src/services/compose.ts:207-218` | Punto exacto del fix |
| Harness migración (string) | `test/agent-links.migration.test.ts:11-58` | Modelo de test estructural |
| Modelo in-memory RPC | `src/services/money-path.concurrency.test.ts:20-45` | Modelo para test de comportamiento del guard |
| Test de mapeo de error | `src/services/budget.test.ts:216-247` | Modelo `mockRpc` → assert code |
| Test per-step debit | `src/services/compose.test.ts:380-408` | Modelo para el test de priceUsdc<0 |

---

## 6. Plan de tests (≥1 por AC + no-regresión)

Todos con `vitest`. Naming/estructura per los exemplars citados.

| # | AC | Qué cubre | Archivo | Tipo |
|---|---|---|---|---|
| T1 | AC-1 | La migración contiene el guard `IF p_amount_usd IS NULL OR ... < 0 OR = 'NaN'::numeric` + `RAISE EXCEPTION 'INVALID_AMOUNT'` dentro de `increment_a2a_key_spend`, ubicado ANTES del `UPDATE a2a_agent_keys` (sin mutación previa) | `test/negative-amount-guard.migration.test.ts` (nuevo) | Estructural (readFileSync + regex/index-of) |
| T2 | AC-1 (comportamiento) | Modelo in-memory: `increment_a2a_key_spend(..., amount<0)` → lanza `INVALID_AMOUNT` y el balance NO cambia | extender `src/services/money-path.concurrency.test.ts` (o `budget.test.ts` con `mockRpc` error) | Comportamiento |
| T3 | AC-2 | `INVALID_AMOUNT` aparece **exactamente una vez** en la migración (choke-point) y los 3 RPC `debit_*` NO se redefinen en ella (heredan vía PERFORM) | `test/negative-amount-guard.migration.test.ts` | Estructural |
| T4 | AC-3 | compose per-step con `priceUsdc: -1` → `budgetService.debit` recibe `PLACEHOLDER_FEE_USD + gas` (NO negativo) + `warn` reason `registry-miss` | `src/services/compose.test.ts` (nuevo caso, modelo L380-408) | Unit |
| T5 | AC-4 | El `UPDATE ... SET price_usdc = 0 WHERE price_usdc < 0` aparece ANTES del `ADD CONSTRAINT` en el archivo (`indexOf` UPDATE < `indexOf` ADD CONSTRAINT) | `test/negative-amount-guard.migration.test.ts` | Estructural |
| T6 | AC-5 | La migración declara `ADD CONSTRAINT a2a_agents_price_usdc_nonneg CHECK (price_usdc >= 0)`; el down hace `DROP CONSTRAINT IF EXISTS` | `test/negative-amount-guard.migration.test.ts` | Estructural |
| T7 | Missing Input | `budgetService.debit` mapea `INVALID_AMOUNT` (rpc error) → `{ success:false, error:'DEBIT_INVALID_AMOUNT' }` en las rutas master y master-dest | `src/services/budget.test.ts` (modelo L216-247) | Unit |
| T8 | Missing Input | `delegation.ts`/`key-session.ts` lanzan `InvalidDebitAmountError` ante `INVALID_AMOUNT`; `budget.ts` lo mapea a `DEBIT_INVALID_AMOUNT` en session/delegación | `src/services/delegation.test.ts` + `key-session.test.ts` | Unit |
| T9 | **No-regresión** | Débito POSITIVO legítimo (`priceUsdc: 1.0`) sigue: `debit` recibe `1.0 + gas` (no fallback) y retorna `success:true`; suite existente de money-path verde | `src/services/compose.test.ts` + `budget.test.ts` (casos existentes + assert explícito) | Unit |

**AC-5 — verificación real (fuera del suite unit):** el suite no tiene Postgres
in-process, por lo que T6 valida la PRESENCIA del constraint. La validación de que
un `INSERT INTO a2a_agents (..., price_usdc) VALUES (..., -1)` es rechazado con
`23514` se hace en Postgres efímero / staging al aplicar la migración (mismo
proceso que se usó en WKH-136). Documentar la evidencia en F4 (QA).

---

## 7. Riesgos

- **Riesgo migración sobre datos (ALTO, mitigado DT-4/CD-3):** filas
  `price_usdc < 0` preexistentes en prod harían fallar el `ADD CONSTRAINT`. El
  `UPDATE` de clamp en la MISMA transacción lo neutraliza. Riesgo real BAJO (tabla
  nueva de 2026-07-03) pero no cero.
- **Riesgo CREATE OR REPLACE en el choke-point (MEDIO):** un error al copiar el
  cuerpo rompería TODOS los débitos (4 rutas). Mitigación: copia literal + un solo
  IF (DT-2); tests de no-regresión (T9) + verificación en Postgres efímero antes de
  merge.
- **Riesgo falso positivo (BAJO):** `amount = 0` debe seguir válido (CD-9). El
  guard es estrictamente `< 0`.
- **Riesgo de scope creep en el mapeo TS (BAJO):** DT-6 toca 4 archivos
  (`errors.ts`, `budget.ts`, `delegation.ts`, `key-session.ts`). Todos son cambios
  **aditivos** (una branch nueva, sin modificar branches existentes) → blast radius
  acotado.

### Señales para el AR (adversarial review)
1. Verificar que el guard queda ANTES del `UPDATE` (no mutación en el path de rechazo).
2. Verificar `= 'NaN'::numeric` (NO `<> self`, que en Postgres numeric es `false`).
3. Verificar que el hardening (search_path/REVOKE/GRANT) NO se perdió en el
   `CREATE OR REPLACE` (CD-4) — regresión de seguridad silenciosa si falta.
4. Verificar que `INVALID_AMOUNT` aparece 1 sola vez y que los 3 RPC hermanos NO
   se redefinieron (choke-point, CD-7).
5. Verificar que el msg crudo de PG NO se propaga al cliente (solo `DEBIT_INVALID_AMOUNT`).
6. Verificar que `refund_*` quedó intacta (CD-2) — grep en el diff.
7. Confirmar que el clamp precede al constraint en la misma tx (CD-3).

---

## 8. Readiness Check

- [x] Work-item leído; Scope IN/OUT, ACs (AC-1..AC-5), DT/CD heredados incorporados.
- [x] Choke-point confirmado con Read (los 3 RPC → `PERFORM increment_a2a_key_spend`).
- [x] Exemplars verificados con Read (todos los paths de §5 existen y las líneas se leyeron).
- [x] Missing Input resuelto (DT-6): error code estable `DEBIT_INVALID_AMOUNT`,
      mapeo en las 4 rutas, nueva class `InvalidDebitAmountError`.
- [x] `[NEEDS CLARIFICATION]` del work-item (CHECK en `a2a_agent_keys.daily_limit_usd`/
      `max_spend_per_call_usd`) → confirmado **Scope OUT** (follow-up separado, no
      bloqueante). `a2a_agent_keys.budget` JSONB → **Scope OUT** (requiere trigger).
- [x] Migración auto-suficiente (clamp + constraint + función en una tx, `BEGIN`/`COMMIT`).
- [x] Down migration especificada (drop constraint + restore función sin guard).
- [x] Plan de test cubre los 5 ACs + el error code + no-regresión (positivo).
- [x] Nombre de migración sin colisión (`20260707000000`, posterior al último
      `20260706000000_wkh137`).
- [x] Limitación honesta documentada: AC-5 (INSERT real 23514) se valida en
      Postgres efímero/staging, no en el suite unit string-based.
- [x] Cero `[NEEDS CLARIFICATION]` abiertos.

**Estado: LISTO para SPEC_APPROVED.**
