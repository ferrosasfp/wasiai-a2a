# Work Item — [WKH-167] `a2a_protocol_fees.fee_total_usdc` — columna aditiva del fee TOTAL

> Nota: el humano está dando de alta este ticket en Jira como "fee_total_usdc" (número
> provisional **WKH-167**, siguiente disponible tras WKH-166 en `_INDEX.md` fila 165). Si el
> número final difiere, es un rename cosmético — no cambia el scope.

## Resumen

`a2a_protocol_fees.fee_usdc` NO es el fee total del protocolo — desde WKH-136 (splits) es
SOLO la pata de plataforma post-split. Esta ambigüedad de nombre de columna ya generó un
falso positivo en una auditoría (comparó `fee_usdc` vs `budget×rate` y vio un "mismatch" que
en realidad es semántica de columna, no un bug — la Σ on-chain real, `fee_usdc` + legs de
`a2a_fee_splits`, sí reconcilia). Se agrega `fee_total_usdc` (= `feeUsdc` = budget×rate = el
mismo `protocolFeeUsdc` que ya se publica en el quote de `/orchestrate/plan`) como columna
NUEVA y ADITIVA, para que el fee total quede legible directo desde `a2a_protocol_fees` sin
tener que joinear con `a2a_fee_splits`.

## Sizing

- SDD_MODE: mini
- Estimación: S
- Branch sugerido: `feat/166-wkh-167-fee-total-usdc`

## F0 — Grounding (archivo:línea)

1. **`src/services/fee-charge.ts:202`** — `feeUsdc` (el TOTAL) ya se calcula acá:
   `const feeUsdc = Number((feeBaseUsdc * feeRate).toFixed(6));`. Es el mismo valor que
   `FeeChargeResult.feeUsdc` retorna al caller y que WKH-133 publica como `protocolFeeUsdc`
   en el quote de `/orchestrate/plan`.
2. **`src/services/fee-charge.ts:264`** — `platformAmount = amounts.platform` es la pata de
   plataforma post-`computeSplits` (WKH-136) — ESTE es el valor que hoy se persiste como
   `fee_usdc` (no se toca).
3. **`src/services/fee-charge.ts:393-401`** — el INSERT real a `a2a_protocol_fees`:
   ```ts
   const feeWei = feeUsdcToWei(platformAmount);
   const { error: insertErr } = (await supabase.from(FEES_TABLE).insert({
     orchestration_id: orchestrationId,
     budget_usdc: feeBaseUsdc,
     fee_rate: feeRate,
     fee_usdc: platformAmount,      // ← pata plataforma, SIN TOCAR
     fee_wallet: walletAddress,
     status: 'pending',
   }))
   ```
   Punto exacto de cambio: agregar `fee_total_usdc: feeUsdc` a este objeto (variable `feeUsdc`
   de la línea 202, ya está en scope de la función — no requiere cálculo nuevo).
4. **Schema actual** — `supabase/migrations/20260421015829_a2a_protocol_fees.sql:7-19`:
   `orchestration_id`, `budget_usdc`, `fee_rate`, `fee_usdc`, `fee_wallet`, `status`,
   `tx_hash`, `error_message`, `created_at`, `updated_at`. Sin columna de fee total hoy.
5. **Patrón de migración del repo** (aditivo) — `supabase/migrations/20260705000000_wkh136_fee_splits.sql:70-72`
   ya muestra el patrón exacto a reusar:
   ```sql
   ALTER TABLE public.a2a_agents
     ADD COLUMN IF NOT EXISTS payout_wallet TEXT,
     ADD COLUMN IF NOT EXISTS referrer_ref  TEXT;
   ```
   Envuelto en `BEGIN; ... COMMIT;`, con un archivo `_down.sql` hermano si aplica reversión
   (ver `20260705000000_wkh136_fee_splits_down.sql`). Naming: `<timestamp:14>_<descripcion>.sql`.
6. **Aditividad confirmada — cero consumers rotos**:
   - `fee-charge.ts:319-325` (idempotency SELECT) usa `.select('status, tx_hash')` —
     columnas explícitas, NO `SELECT *`.
   - `fee-split.ts` NUNCA lee `a2a_protocol_fees` — opera solo sobre `a2a_fee_splits`.
   - `dashboard.ts` (`/dashboard/api/stats`, `/api/events`) usa `eventService` sobre
     `a2a_events`, tabla distinta — no toca `a2a_protocol_fees`.
   - No se encontró ningún `SELECT *` sobre `a2a_protocol_fees` en el codebase. Una columna
     `NUMERIC(18,6) NULL` nueva es 100% aditiva: no rompe lecturas existentes, no requiere
     `NOT NULL`/`DEFAULT` (las filas viejas quedan `NULL` hasta backfill opcional).

## Acceptance Criteria (EARS)

- AC-1: WHEN `chargeProtocolFee` inserta una fila `pending` en `a2a_protocol_fees` para una
  orquestación NUEVA, the system SHALL persistir `fee_total_usdc` igual al valor de `feeUsdc`
  calculado en `fee-charge.ts:202` (`feeBaseUsdc × feeRate`, redondeado a 6 decimales) — el
  mismo valor que `protocolFeeUsdc` en el quote y que `FeeChargeResult.feeUsdc`.
- AC-2: the system SHALL seguir persistiendo `fee_usdc` con el valor de `platformAmount`
  (la pata de plataforma post-split, WKH-136) sin ningún cambio de valor ni de semántica.
- AC-3: WHERE la migración `ADD COLUMN fee_total_usdc` se aplica sobre una base con filas
  existentes, the system SHALL preservar esas filas legibles sin error (columna nueva
  nullable, sin `NOT NULL` ni `DEFAULT` obligatorio) — cero regresión en cualquier query o
  consumer existente sobre `a2a_protocol_fees`.
- AC-4: IF se suma `fee_usdc + Σ(a2a_fee_splits.amount_usdc)` para una `orchestration_id`
  dada (post-fix), THEN the system SHALL producir un valor igual a `fee_total_usdc` de esa
  misma fila (invariante de reconciliación — el split nunca cambia el total, WKH-132/WKH-136).
- AC-5: the system SHALL NO modificar el cálculo del fee (`feeUsdc`, `getProtocolFeeRate`),
  el engine de splits (`computeSplits`/`resolveRecipients`/`settleFeeSplits`), ni el shape
  público de `FeeChargeResult` — el cambio es estrictamente un campo persistido adicional.

## Scope IN

- `src/services/fee-charge.ts` — el objeto de `insert(...)` en `chargeProtocolFee`
  (~línea 394-401): agregar `fee_total_usdc: feeUsdc`.
- Migración nueva `supabase/migrations/<timestamp>_wkh167_fee_total_usdc.sql` (+ `_down.sql`
  hermano si el repo lo exige — confirmar patrón exacto en F2) con
  `ALTER TABLE a2a_protocol_fees ADD COLUMN IF NOT EXISTS fee_total_usdc NUMERIC(18,6)`.
- Tests — `src/services/fee-charge.test.ts` (y `fee-charge-splits.test.ts` si mockea el
  insert): assertion nueva sobre `fee_total_usdc` en el payload del insert.
- `.env.example` — actualizar `SPLIT_BPS_PLATFORM`/`SPLIT_BPS_CREATOR`/`SPLIT_BPS_REFERRAL`
  de `10000/0/0` a los valores REALES de prod `8000/1500/500` (confirmado como config prod
  actual en `doc/architecture/FEE-MODEL.md:34-36` y en `project-context.md:251`). Doc-only,
  no afecta código (el runtime lee `process.env` — el .env.example es solo la plantilla).

## Scope OUT

- El cálculo del fee (`getProtocolFeeRate`, `feeUsdc = feeBaseUsdc × feeRate`) — SIN CAMBIOS.
- El engine de splits (`computeSplits`, `resolveRecipients`, `settleFeeSplits`,
  `reverseFeeSplits` en `fee-split.ts`) — SIN CAMBIOS.
- La tabla `a2a_fee_splits` (schema, filas, lógica) — SIN CAMBIOS.
- El valor persistido en `fee_usdc` — SIN CAMBIOS (sigue siendo la pata plataforma).
- Cualquier endpoint público nuevo que exponga `fee_total_usdc` (dashboard, API) — fuera de
  scope; esta HU es solo la persistencia en DB. Si se quiere exponer, es HU de seguimiento.
- Backfill de filas HISTÓRICAS — evaluado, ver Missing Inputs (no bloqueante).

## Decisiones técnicas (DT-N)

- DT-1: `fee_total_usdc` se escribe en el MISMO INSERT que ya existe (no un UPDATE
  separado ni una segunda escritura) — cero cambio de flujo de control, cero riesgo nuevo de
  race/idempotencia (reusa la misma unicidad `PK orchestration_id`).
- DT-2: tipo `NUMERIC(18,6)` — idéntico a `budget_usdc`/`fee_usdc` (misma precisión, mismo
  patrón de la tabla).
- DT-3: columna `NULLABLE`, sin `DEFAULT` — las filas nuevas la completan siempre (viene del
  INSERT); las filas viejas quedan `NULL` explícito hasta que se decida backfill (ver Missing
  Inputs). Evita forzar un `DEFAULT 0` que sería engañoso (0 no es "fee total desconocido").

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO modificar el valor o la semántica de `fee_usdc` (sigue siendo la pata
  plataforma, WKH-136) — money-path invariante.
- CD-2: PROHIBIDO modificar `feeUsdc`/`getProtocolFeeRate`/`computeSplits`/
  `resolveRecipients` — el cálculo del fee y del split quedan byte-idénticos.
- CD-3: OBLIGATORIO que la migración use `ADD COLUMN IF NOT EXISTS` (idempotente,
  re-aplicable) siguiendo el patrón de `20260705000000_wkh136_fee_splits.sql:70-72`.
- CD-4: PROHIBIDO agregar `NOT NULL` sin `DEFAULT` a la nueva columna (rompería el INSERT
  legacy si algún call-site quedara sin actualizar, y bloquearía la migración sobre filas
  existentes).
- CD-5: OBLIGATORIO verificar en F2/F3 que NINGÚN consumer nuevo haga `SELECT *` sobre
  `a2a_protocol_fees` (hoy no hay ninguno — mantener esa invariante).

## Missing Inputs

- [NEEDS CLARIFICATION, NO bloqueante] ¿Backfillear `fee_total_usdc` en filas existentes de
  `a2a_protocol_fees`? Fórmula: `fee_total_usdc = fee_usdc + Σ(a2a_fee_splits.amount_usdc)`
  para esa `orchestration_id`, sumando TODAS las filas de `a2a_fee_splits`
  independientemente del `status` (los legs `skipped` ya tienen `amount_usdc = 0` porque su
  bps se re-ruteó a `fee_usdc`/plataforma — SG-6 — así que no se doble-cuentan; los `failed`
  representan el split matemático calculado en su momento, no el settle, y también deben
  sumar). Para `orchestration_id` sin ninguna fila en `a2a_fee_splits` (config default
  `10000/0/0`, 1 solo recipient), `fee_total_usdc = fee_usdc` directo. Recomendación del
  Analyst: SÍ backfillear — es barato de derivar y cierra el hueco que originó la auditoría
  ambigua — pero NO bloquea `HU_APPROVED`; el Architect puede resolverlo en F2 como un
  `UPDATE` separado (fuera del INSERT hot-path) o diferirlo a una HU de seguimiento.
- [NEEDS CLARIFICATION, NO bloqueante] ¿La migración se aplica a `caldz` (prod/mainnet)
  AHORA junto con `bdwv`, o se difiere a la próxima tanda mainnet? Recomendación del
  Analyst: aplicarla AHORA en ambas — es un `ADD COLUMN` nullable puramente aditivo (sin
  riesgo de romper nada en prod), y el repo tiene precedente reciente de gaps de seguridad
  por fixes aplicados solo en `bdwv` sin espejar a `caldz` (WKH-155→WKH-164, ver
  `auditoria-e2e-integral-2026-07-08`). El costo de aplicarla ahora en las dos es mínimo; el
  costo de arrastrar drift entre dev/prod no lo es.

## Análisis de paralelismo

- Esta HU toca EXCLUSIVAMENTE el INSERT de `chargeProtocolFee` en `fee-charge.ts` (un objeto
  literal, ~3 líneas) + una migración nueva de tabla propia. No pisa ninguna de las HUs
  actualmente `in progress` en `_INDEX.md` (filas 159/160/161/162/163 — WKH-157/152/158/
  159/160), que tocan `orchestrate.ts` (discovery/planner/relevance-guard) y `discovery.ts`,
  archivos distintos y sin overlap de líneas con `fee-charge.ts`.
- No bloquea ni es bloqueada por ninguna HU en curso — puede ir en paralelo con cualquiera
  de las anteriores.
- No genera contención de migración: es la única HU activa que toca
  `a2a_protocol_fees`/`fee-charge.ts`.
