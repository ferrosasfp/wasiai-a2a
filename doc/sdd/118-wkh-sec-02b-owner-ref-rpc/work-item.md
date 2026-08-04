# Work Item — [WKH-SEC-02b] Validar `p_owner_ref` dentro de `increment_a2a_key_spend`

## Resumen

Spinoff explícito de WKH-SEC-02 (§8 del report). La RPC Postgres
`increment_a2a_key_spend` es el núcleo de todo débito de budget pero hoy NO
valida `owner_ref` internamente: el ownership check vive solo en la capa app
(WKH-53) o en los RPCs intermedios (`debit_with_dest_policy`,
`debit_delegation_and_parent`, `debit_session_and_parent`). Esta HU agrega
defensa Postgres-level directamente en `increment_a2a_key_spend` para que
cualquier invocación (directa o vía PERFORM desde otro RPC) rechace si el
`owner_ref` pasado no coincide con el `owner_ref` registrado en la fila de
la key. La RPC ya está REVOCADA de `anon`/`authenticated`; esto es defensa
en profundidad, no un fix de vulnerabilidad activa.

---

## Sizing

- **SDD_MODE**: full
- **Estimación**: M
- **Branch sugerido**: `feat/118-wkh-sec-02b-owner-ref-rpc`
- **Clasificación**: QUALITY (RPC fundacional + payment path + lección de overload activa)

---

## F0 Grounding — Callers reales de `increment_a2a_key_spend`

### Definición actual

Archivo: `supabase/migrations/20260406000000_a2a_agent_keys.sql`

Firma actual:
```
CREATE OR REPLACE FUNCTION increment_a2a_key_spend(
  p_key_id    UUID,
  p_chain_id  INT,
  p_amount_usd NUMERIC
) RETURNS void
```
Sin parámetro `p_owner_ref`. Sin validación de ownership DB-layer.

### Callers identificados (grounding real)

| # | Caller | Tipo | Ubicación |
|---|--------|------|-----------|
| 1 | `budgetService.debit` (ruta master key sin destino) | TypeScript directo | `src/services/budget.ts:293-297` |
| 2 | `debit_delegation_and_parent` (PERFORM interno) | SQL PERFORM | `supabase/migrations/20260601000000_a2a_delegations.sql:95` |
| 3 | `debit_session_and_parent` (PERFORM interno — branch sin destino) | SQL PERFORM | `supabase/migrations/20260606000000_a2a_key_spend_policies.sql:216` |

**Nota importante:** `debit_with_dest_policy` también llama `increment_a2a_key_spend` vía PERFORM (línea 123 de `20260606000000_a2a_key_spend_policies.sql`). Esto es el caller #4 (SQL), aunque llega enrutado desde la ruta master-key con destino. Total real: **4 callers** (1 TS directo + 3 SQL PERFORM).

### Cadena de llamadas completa

```
budgetService.debit
  ├── sin destino, sin delegación, sin sesión
  │     → supabase.rpc('increment_a2a_key_spend', {p_key_id, p_chain_id, p_amount_usd})  [caller #1]
  ├── con destino (destination)
  │     → supabase.rpc('debit_with_dest_policy', {...p_owner_ref})
  │           → PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd)      [caller #4]
  ├── con delegación
  │     → supabase.rpc('debit_delegation_and_parent', {...p_owner_ref})
  │           → PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd)      [caller #2]
  └── con sesión
        → supabase.rpc('debit_session_and_parent', {...p_owner_ref, p_destination})
              ├── sin destino → PERFORM increment_a2a_key_spend(...)                      [caller #3]
              └── con destino → PERFORM debit_with_dest_policy(...)
                                      → PERFORM increment_a2a_key_spend(...)              [caller #4 vía sesión]
```

### Observación clave

Los callers SQL (#2, #3, #4) ya hacen su propio Ownership Guard DB-layer ANTES
de llegar al PERFORM de `increment_a2a_key_spend`. El único caller que llega sin
Ownership Guard Postgres-level es el caller #1 (TS directo desde `budget.ts:293`
en la ruta master key sin destino ni delegación). El app-layer de WKH-53 protege
ese path, pero no existe ningún guard Postgres-level para esa ruta específica.

---

## Acceptance Criteria (EARS)

### AC-1 — Guard de ownership en RPC (evento principal)
WHEN `increment_a2a_key_spend` se ejecuta con un `p_owner_ref` que NO coincide
con el `owner_ref` registrado en la fila de `a2a_agent_keys` para `p_key_id`,
the system SHALL lanzar `RAISE EXCEPTION 'OWNERSHIP_MISMATCH: ...'` y hacer
ROLLBACK de la transacción completa.

### AC-2 — Callers TS actualizados (no regresión)
WHEN `budgetService.debit` ejecuta la ruta master key sin destino (caller #1),
the system SHALL pasar `p_owner_ref` a `increment_a2a_key_spend` y el servicio
SHALL continuar debitando correctamente para un owner válido.

### AC-3 — Callers SQL (PERFORM) actualizados
WHEN `debit_delegation_and_parent`, `debit_session_and_parent` o
`debit_with_dest_policy` ejecutan `PERFORM increment_a2a_key_spend(...)`,
the system SHALL incluir el parámetro `p_owner_ref` en cada PERFORM, y el débito
SHALL completarse sin error para un `owner_ref` correcto.

### AC-4 — Migración reversible (down script)
WHEN el down script de esta HU se aplica, the system SHALL restaurar
`increment_a2a_key_spend` a su firma de 3 parámetros (sin `p_owner_ref`) y
los RPCs dependientes a sus versiones previas, sin pérdida de datos.

### AC-5 — Cero regresión funcional
WHILE el servicio está en producción post-migración, the system SHALL mantener
todos los tests existentes en verde (tsc 0 errores, biome 0 errores, suite de
tests actual PASS) y los endpoints de compose/orchestrate SHALL retornar HTTP
200 para keys válidas.

### AC-6 — Error mapping en app layer
IF `increment_a2a_key_spend` lanza `OWNERSHIP_MISMATCH` vía la ruta del caller
#1 (budget.ts ruta master), THEN the system SHALL mapear el error a
`{ success: false, error: 'OWNERSHIP_MISMATCH' }` sin propagar el mensaje crudo
de Postgres al cliente (patrón existente de los otros mapeos en budget.ts).

---

## Scope IN

- `supabase/migrations/YYYYMMDDNNNNNN_wkh_sec02b_owner_ref_rpc.sql` — nueva
  migración con DROP + CREATE de `increment_a2a_key_spend` (firma extendida con
  `p_owner_ref TEXT`) + CREATE OR REPLACE de los 3 RPCs SQL que hacen PERFORM
- `supabase/migrations/YYYYMMDDNNNNNN_wkh_sec02b_owner_ref_rpc_down.sql` — down
  script reversible
- `src/services/budget.ts` — ruta master key sin destino (caller #1): pasar
  `p_owner_ref` al RPC; mapeo del nuevo error OWNERSHIP_MISMATCH
- Tests en `test/` o `src/` que cubran el nuevo guard (mínimo: owner válido pasa,
  owner inválido rechaza)

## Scope OUT

- `src/services/delegation.ts` — NO modificar; `debit_delegation_and_parent` ya
  hace su propio Ownership Guard antes del PERFORM; solo se actualiza el PERFORM
  dentro de la migración SQL.
- `src/services/key-session.ts` — NO modificar (mismo caso que delegation).
- `src/routes/` — ningún endpoint cambia su interfaz HTTP.
- WKH-SEC-02c (RLS en `registries`/`kite_schema_transforms`) — fuera de scope.
- Cambios en la lógica de negocio del débito (daily reset, chain budget check) —
  solo se agrega el guard, no se tocan las otras validaciones.
- `register_a2a_key_deposit` — función hermana en la misma migración original;
  ya tiene `p_owner_ref` y Ownership Guard (WKH-35 v2). No tocar.

---

## Decisiones técnicas (DT-N)

### DT-1 — Estrategia de migración: Opción A vs Opción B [NEEDS CLARIFICATION]

**Opción A** (DROP + recrear):
- `DROP FUNCTION increment_a2a_key_spend(uuid, integer, numeric)` (firma exacta)
- `CREATE OR REPLACE FUNCTION increment_a2a_key_spend(uuid, integer, numeric, text)`
- Actualizar los 3 RPCs SQL dependientes (CREATE OR REPLACE o DROP+CREATE según
  necesiten) en la MISMA migración (atómico).
- Actualizar caller #1 TS en `budget.ts`.
- Mismo patrón que BLQ-MED-1 en WKH-125 (precedente exitoso en este codebase).

**Opción B** (nueva función wrapper):
- Crear `increment_a2a_key_spend_owned(p_key_id, p_chain_id, p_amount_usd, p_owner_ref)`
  que valida ownership y llama a la original.
- Actualizar los 4 callers para usar la nueva función.
- Mantener la original deprecada (pero funcional) hasta próxima ventana de limpieza.
- Riesgo: la original sigue existiendo sin guard → confusión semántica a futuro.

**Recomendación preliminar del Analyst**: Opción A (DROP + recrear), dado que:
1. BLQ-MED-1 de WKH-125 ya demostró que el patrón DROP funciona en este codebase.
2. La Opción B deja código duplicado y un vector de confusión: ¿cuál usar?
3. El cambio es atómico (todos los callers en una sola migración).

Sin embargo, la decisión final recae en el Architect (F2) porque implica evaluar
el riesgo de downtime de la migración en producción con callers activos.

[NEEDS CLARIFICATION — Architect F2]: ¿La migración puede ejecutarse con el
servicio en vivo (Railway rolling deploy), o se requiere ventana de mantenimiento
dada la naturaleza del DROP? El DROP + recrear es instantáneo en Postgres
(DDL transaccional), pero si hay llamadas en vuelo al momento del DROP pueden
fallar. Evaluar si el volumen de tráfico en ese momento justifica ventana.

### DT-2 — Posición del guard dentro de la función

El guard de ownership DEBE colocarse DESPUÉS del `SELECT * ... FOR UPDATE` (que
ya existe) y ANTES de cualquier debit. Esto garantiza que el lock se adquiere
antes de la validación (mismo patrón que `debit_with_dest_policy`, líneas 72-83).
El `IF NOT FOUND` existente ya cubre `KEY_NOT_FOUND`; el guard de ownership es un
check adicional sobre la fila lockeada.

### DT-3 — `p_owner_ref` en los PERFORM SQL internos

Los RPCs SQL que llaman `PERFORM increment_a2a_key_spend(...)` ya reciben
`p_owner_ref` como parámetro (lo usan para su propio Ownership Guard). Por lo
tanto el único cambio SQL en esos RPCs es agregar `p_owner_ref` al PERFORM:
`PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref)`.
La lógica de negocio de esos RPCs no cambia.

### DT-4 — Cómo obtiene `p_owner_ref` el caller #1 (budget.ts ruta master)

En la ruta master key sin destino (`budget.ts:292-303`), la función `debit()`
recibe `keyId` pero NO recibe `ownerId` directamente. En la ruta con destino
(líneas 242-250) se hace un SELECT cold-path para obtener `owner_ref`. Para la
ruta master, el Architect DEBE decidir si:

(a) Se agrega `ownerId: string` a la firma de `debit()` [NEEDS CLARIFICATION —
    impacto en todos los call-sites de `budgetService.debit`], o
(b) Se hace el mismo SELECT cold-path que ya existe en la ruta con destino (solo
    cuando se va a llamar a `increment_a2a_key_spend`), o
(c) Se refactoriza `debit()` para que `ownerId` sea siempre obligatorio (alinea
    con la Security Convention de CLAUDE.md).

El Architect evaluará cuál minimiza superficie de cambio sin introducir regresión.

---

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO usar `CREATE OR REPLACE` para cambiar la firma de
  `increment_a2a_key_spend` sin DROP previo. Debe usarse el patrón
  `DROP FUNCTION IF EXISTS increment_a2a_key_spend(uuid, integer, numeric)` +
  `CREATE OR REPLACE` (lección BLQ-MED-1 de WKH-125, documentada en
  `20260606000000_a2a_key_spend_policies.sql:157`).

- **CD-2**: OBLIGATORIO que el down script restaure EXACTAMENTE la firma y el
  cuerpo original de `increment_a2a_key_spend` (3 parámetros, sin guard) y los
  RPCs dependientes, para garantizar rollback atómico reversible.

- **CD-3**: PROHIBIDO propagar el mensaje crudo de Postgres `OWNERSHIP_MISMATCH`
  al cliente HTTP. Debe mapearse a `{ success: false, error: 'OWNERSHIP_MISMATCH' }`
  en `budget.ts` (mismo patrón que `debit_with_dest_policy`, líneas 275-278).

- **CD-4**: OBLIGATORIO que la migración sea idempotente en reintento: si la
  migración falla a mitad, el re-run del down + up no debe dejar la DB en estado
  inconsistente.

- **CD-5**: PROHIBIDO modificar la lógica de validación existente dentro de
  `increment_a2a_key_spend` (daily reset, chain budget check, KEY_INACTIVE,
  KEY_NOT_FOUND). Solo se agrega el guard de ownership entre el FOR UPDATE y el
  check de `is_active`.

---

## Missing Inputs

- **[NEEDS CLARIFICATION — Architect F2]** Decisión DT-1: ¿Opción A (DROP+recrear,
  recomendada) o Opción B (nueva función wrapper)? Evaluar riesgo de downtime en
  Railway rolling deploy.
- **[NEEDS CLARIFICATION — Architect F2]** Decisión DT-4: ¿Cómo obtiene `ownerId`
  el caller #1? ¿Ampliar firma de `debit()`, SELECT cold-path, o refactor completo?
  El impacto en call-sites de `debit()` debe ser evaluado en F2 con grounding de
  todos los callers de `budgetService.debit` (compose.ts, orchestrate.ts, etc.).
- **[RESUELTO en F2]** El timestamp exacto de la migración (YYYYMMDD) lo decide
  el Architect al generar el SDD.

---

## Análisis de paralelismo

- Esta HU NO bloquea otras HUs actualmente en pipeline (no hay WIP en el INDEX
  que dependa de `increment_a2a_key_spend`).
- Esta HU ES prerrequisito lógico de cualquier futura HU que agregue RPCs nuevos
  que llamen `increment_a2a_key_spend` directamente.
- Puede ir en paralelo con WKH-SEC-02c (RLS en `registries`/`kite_schema_transforms`)
  ya que no tocan los mismos archivos.
- Branch: `feat/118-wkh-sec-02b-owner-ref-rpc` (aislado, sin conflicto con main).
