# Work Item — [WKH-129] Reembolso completo del dest-cap — `refund_with_dest_policy`

## Resumen

Cuando un step de `/compose` falla tras haber sido debitado vía `debit_with_dest_policy`
(por tener `destination`), el reembolso actual (`refund_a2a_key_spend`) restaura el
`budget` y `daily_spent` del owner PERO no revierte la fila del ledger
`a2a_key_dest_spend_ledger`. Esto consume headroom del cap por destino del vendor aunque
el dinero se haya devuelto. El fix introduce una nueva RPC `refund_with_dest_policy` que
revierte los tres contadores de forma atómica, y la engancha en `budgetService.credit` +
en el refund per-step de `compose.ts`. El objetivo es eliminar la over-restricción del cap
sin alterar el comportamiento monetario (no hay pérdida de dinero en el estado actual).

---

## F0 — Verificación de premisas (archivo:línea)

### 1. Ledger `a2a_key_dest_spend_ledger` — columnas exactas

`supabase/migrations/20260606000000_a2a_key_spend_policies.sql:36-43`

```
id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
key_id      UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE
owner_ref   TEXT NOT NULL
destination TEXT NOT NULL
amount_usd  NUMERIC(18,6) NOT NULL
debited_at  TIMESTAMPTZ NOT NULL DEFAULT now()
```

El ledger es **append-only** — no hay `UPDATE` ni `DELETE` en ninguna función de la
migración. El cap usa `SUM(amount_usd)` sobre el ledger filtrado por ventana
(`rolling` o `total`): `20260606000000_a2a_key_spend_policies.sql:99-109`.

### 2. `debit_with_dest_policy` — cómo inserta y cómo computa el SUM

- Lock key (L72-78), ownership guard (L81-84), lock policy (L86-95), SUM en
  ventana rolling (`amount_usd >= now() - window_secs`) o total (sin filtro
  temporal) en L99-110, check de cap L113-116, PERFORM
  `increment_a2a_key_spend` L123, INSERT ledger L127-128.
  `20260606000000_a2a_key_spend_policies.sql:55-131`.

- El SUM **incluye filas con `amount_usd` negativo** si las hubiera — es un
  `COALESCE(SUM(amount_usd), 0)` sin filtro de signo. Esto valida la estrategia
  de fila compensatoria negativa (append-only friendly).

### 3. `refund_a2a_key_spend` — qué revierte hoy

`supabase/migrations/20260623000000_wkh127_refund_a2a_key_spend.sql:9-57`

Revierte: `budget` (JSONB, `+= p_amount_usd`) + `daily_spent_usd`
(`GREATEST(daily_spent - amount, 0)`). FOR UPDATE en `a2a_agent_keys`. Ownership
Guard DB-layer (L32-35). NO toca `a2a_key_dest_spend_ledger`.

### 4. `budgetService.credit` — firma actual sin destination

`src/services/budget.ts:335-366`

Firma: `credit(keyId, chainId, amountUsd, ownerRef)` — cuatro argumentos, sin
`destination`. Llama `supabase.rpc('refund_a2a_key_spend', ...)` directamente.

### 5. Refund per-step de compose — NO pasa destination

`src/services/compose.ts:339-360`

El catch de `invokeAgent` llama:
```ts
await budgetService.credit(
  scopingKeyRow.id,
  chainId,
  stepDebitedUsd,
  scopingKeyRow.owner_ref,
)
```
Sin pasar el destination del step. El destination estaba disponible en el scope
del debit del mismo step (L174): `normalizeDestination(\`${agent.registry}/${agent.slug}\`)`.

### 6. Debit per-step de compose — pasa destination correctamente

`src/services/compose.ts:168-175`

```ts
const debitResult = await budgetService.debit(
  scopingKeyRow.id, chainId, debitAmount,
  request.delegationContext,
  request.keySessionContext,
  normalizeDestination(`${agent.registry}/${agent.slug}`),  // ← destination
);
```

Confirmado: el débito usa `normalizeDestination` con `registry/slug` — la reversa
debe usar el mismo valor.

### 7. Orchestrate step-0 — NO usa destination (confirmado)

`src/services/orchestrate.ts:497-502`

```ts
const debitRes = await budgetService.debit(
  billingKeyRow.id,
  request.chainId,
  plannedCostUsd,
);
```
Solo 3 argumentos (keyId, chainId, amount). No pasa delegation, session ni
destination. Por lo tanto, el step-0 de orchestrate NO inserta en
`a2a_key_dest_spend_ledger` y NO necesita dest reversal. Scope OUT confirmado.

---

## Sizing

- **SDD_MODE**: full
- **Estimación**: S (pequeña: 1 migración SQL nueva, 2 cambios TS limitados, tests)
- **Smart Sizing**: QUALITY (path de dinero — atomicidad + ownership guard)
- **Branch sugerido**: `fix/126-wkh-129-dest-cap-refund`

---

## Acceptance Criteria (EARS)

**AC-1** — WHEN un step de `/compose` falla después de haber sido debitado vía
`debit_with_dest_policy` (i.e. `stepDebitedUsd > 0`, `destination` presente, sin
delegación/session), the system SHALL revertir la fila del ledger
`a2a_key_dest_spend_ledger` además del `budget` y `daily_spent`, de modo que el
`SUM` del cap por destino quede igual al valor previo al débito fallido.

**AC-2** — WHEN se invoca `refund_with_dest_policy(p_key_id, p_chain_id, p_amount_usd,
p_owner_ref, p_destination)`, the system SHALL ejecutar en una sola transacción
atómica: (a) restaurar `budget[chain_id] += p_amount_usd`, (b) revertir
`daily_spent_usd` con clamp a 0 (`GREATEST(..., 0)`), y (c) insertar una fila
compensatoria en `a2a_key_dest_spend_ledger` con `amount_usd = -p_amount_usd`,
idéntica key, owner, destination y timestamp de ahora.

**AC-3** — WHEN se invoca `refund_with_dest_policy` con un `p_owner_ref` que no
coincide con `a2a_agent_keys.owner_ref`, the system SHALL lanzar
`OWNERSHIP_MISMATCH` y hacer ROLLBACK de toda la transacción, sin modificar
ninguna tabla.

**AC-4** — WHILE la política del destino usa `window_type = 'rolling'`, the system
SHALL incluir la fila compensatoria negativa dentro del SUM del cap solo cuando
`debited_at >= now() - window_secs`. Al insertar la fila con `NOW()` (momento del
refund), esto es siempre verdadero para ventanas estándar (el refund ocurre dentro
de la ventana del débito original).

**AC-5** — IF `p_amount_usd <= 0` OR `p_amount_usd IS NULL` THEN the system SHALL
retornar sin efecto (no-op defensivo), igual que `refund_a2a_key_spend` L38-40.

**AC-6** — WHEN un step de `/compose` falla y el path es master key sin
delegación/session, the system SHALL invocar `refund_with_dest_policy` si hay
`destination` disponible para ese step, y `refund_a2a_key_spend` (comportamiento
actual sin cambio) si no hay `destination` (ej. si `debitAmount` se tomó por
fallback sin destino).

**AC-7** — WHEN la nueva RPC se instala vía migración aditiva, the system SHALL
mantener `debit_with_dest_policy`, `refund_a2a_key_spend`, y todas las RPCs
hermanas con su aridad existente intacta (sin DROP de funciones pre-existentes en
el up script).

---

## Scope IN

| Artefacto | Cambio |
|-----------|--------|
| `supabase/migrations/YYYYMMDDNNNNNN_wkh129_refund_with_dest_policy.sql` | CREATE OR REPLACE `refund_with_dest_policy` (up) |
| `supabase/migrations/YYYYMMDDNNNNNN_wkh129_refund_with_dest_policy_down.sql` | DROP IF EXISTS (down reversible) |
| `src/services/budget.ts` | Nueva función `creditWithDest(keyId, chainId, amountUsd, ownerRef, destination)` o extensión de `credit` con `destination?` opcional; llama `refund_with_dest_policy` cuando hay destination |
| `src/services/compose.ts` | Refund per-step (L346-350): pasar `destination` cuando está disponible; llamar `creditWithDest` si destination, `credit` si no |
| Tests (compose refund con dest reversal, RPC) | Test unitario del catch de compose con destination presente y ausente |

---

## Scope OUT

- NO modificar `debit_with_dest_policy` ni la lógica del cap-check de WKH-125
- NO modificar `refund_a2a_key_spend` (sigue siendo la RPC del caso sin destination)
- NO tocar orchestrate step-0 — usa debit 3-arg, no inserta en ledger (confirmado F0)
- NO implementar dest reversal para delegación/session — el refund per-step ya
  excluye esos paths (`!request.delegationContext && !request.keySessionContext`,
  `compose.ts:341-343`), el scope de WKH-128 los dejó fuera explícitamente
- NO agregar columna `session_id` ni `delegation_id` al ledger
- NO limpiar filas antiguas del ledger (pruning/cleanup queda fuera de scope)

---

## Decisiones técnicas (DT-N)

**DT-1 — Fila compensatoria negativa vs DELETE vs UPDATE**

Opciones evaluadas:

| Opción | Pro | Contra |
|--------|-----|--------|
| **A) INSERT fila negativa** (append-only) | Mantiene historial completo; el SUM ya filtra correctamente (`COALESCE(SUM(...),0)` sin filtro de signo); no rompe el índice; back-compat con ventanas rolling/total | El SUM retorna el neto, no el bruto — aceptable para el invariante del cap |
| B) DELETE de la fila del débito | Semánticamente limpio | Requiere `ledger_id` en el refund (no disponible en el catch de compose); rompe append-only; audit trail perdido |
| C) UPDATE `amount_usd = 0` | Simple | Rompe append-only; audit trail oscuro |

**Decisión recomendada: Opción A** — append-only con fila compensatoria negativa.
No requiere cambios en el esquema del ledger ni en la firma de compose. La RPC solo
necesita `(key_id, chain_id, amount_usd, owner_ref, destination)` — misma info
disponible en el catch del step. [ARCHITECT confirma en F2]

**DT-2 — Extensión de `budgetService.credit` vs nueva función `creditWithDest`**

Opciones:
- **A) Nueva función** `creditWithDest(keyId, chainId, amountUsd, ownerRef, destination)`: explícita, sin riesgo de regresión en los callers de `credit` existentes (orchestrate, etc.).
- B) Parámetro opcional `destination?` en `credit`: menos código, pero cualquier
  caller que no pase destination sigue en el path antiguo (back-compat por
  undefined check).

Ambas son seguras. Preferencia: Opción A (explícita, zero riesgo de regresión).
[ARCHITECT decide en F2]

**DT-3 — Timestamp de la fila compensatoria**

La fila compensatoria se inserta con `debited_at = NOW()` (default de la tabla).
Para ventanas rolling, el SUM filtra `debited_at >= now() - window_secs`. El refund
siempre ocurre dentro de la misma sesión HTTP (segundos después del débito), por lo
que siempre cae dentro de cualquier ventana razonable (mínimo 60s). [ARCHITECT
puede documentar como invariante de operación]

**DT-4 — Hardening de la nueva RPC**

Consistente con las RPCs hermanas (`refund_a2a_key_spend`, `debit_with_dest_policy`):
- `SET search_path = public, pg_temp`
- `REVOKE EXECUTE FROM PUBLIC, anon, authenticated`
- `GRANT EXECUTE TO service_role`
- `SECURITY DEFINER`

---

## Constraint Directives (CD-N)

**CD-1 — OBLIGATORIO atomicidad**: la reversión `budget + daily_spent + ledger`
debe ocurrir en una sola transacción PL/pgSQL con `FOR UPDATE` en `a2a_agent_keys`.
Si cualquier parte falla → ROLLBACK total.

**CD-2 — OBLIGATORIO ownership guard DB-layer**: `refund_with_dest_policy` debe
validar `p_owner_ref` contra `a2a_agent_keys.owner_ref` BAJO LOCK, igual que
`refund_a2a_key_spend` (L32-35). Violación → `RAISE EXCEPTION 'OWNERSHIP_MISMATCH'`.

**CD-3 — OBLIGATORIO migración aditiva**: up script solo usa `CREATE OR REPLACE
FUNCTION`. PROHIBIDO `DROP` de funciones existentes en el up script. Down script =
`DROP FUNCTION IF EXISTS refund_with_dest_policy(...)`.

**CD-4 — PROHIBIDO crear dinero**: la fila compensatoria tiene
`amount_usd = -p_amount_usd`. PROHIBIDO insertar un valor positivo. El neto del
SUM después del refund debe ser ≤ neto antes del débito fallido.

**CD-5 — PROHIBIDO doble-reversa**: si `p_amount_usd <= 0` → no-op inmediato
(RETURN). El caller (compose catch) solo invoca el refund si `stepDebitedUsd > 0`.

**CD-6 — PROHIBIDO tocar `debit_with_dest_policy` ni `refund_a2a_key_spend`**:
las dos RPCs pre-existentes quedan intactas en aridad y comportamiento.

**CD-7 — OBLIGATORIO best-effort en compose**: un fallo de `creditWithDest` NO
cambia el error visible al caller (mismo patrón que WKH-128 en L352-359 de
compose.ts). Solo log estructurado `[compose.refund-failed]` con `keyId, chainId,
amountUsd, destination, step`.

**CD-8 — Ownership Guard (CLAUDE.md Security Conventions)**: la nueva función
`creditWithDest` en `budget.ts` DEBE recibir `ownerRef: string` (no optional). El
caller ya lo tiene en `scopingKeyRow.owner_ref`.

---

## Missing Inputs

- [resuelto en F2] Timestamp exacto de la migración (el Architect elige el
  prefijo YYYYMMDD con el nombre de archivo correcto)
- [resuelto en F2] Nombre final: `creditWithDest` vs extensión de `credit` con
  optional
- [TBD — no bloqueante] Si se agregan tests de integración contra Supabase real
  o solo mocks (depende del harness de test existente — el QA del repo usa mocks)

---

## Análisis de paralelismo

- Esta HU cierra el residual de WKH-127 (billing fix) y WKH-128 (per-step refund).
  No tiene dependencias pendientes activas (ambas HUs están en DONE).
- No bloquea otras HUs conocidas en el BACKLOG.
- Puede ejecutarse en cualquier momento posterior a `HU_APPROVED`; no requiere
  coordinación con otras ramas en vuelo (la rama actual `fix/117-session-dest-cap`
  está sobre otro tema).

---

## Waves sugeridas (para F2.5)

| Wave | Contenido |
|------|-----------|
| W1 | Migración SQL: `refund_with_dest_policy` up + down |
| W2 | `src/services/budget.ts`: `creditWithDest` (o extensión de `credit`) |
| W3 | `src/services/compose.ts`: refund per-step pasa destination → usa `creditWithDest` |
| W4 | Tests: refund con dest, refund sin dest, RPC ownership guard |
