# Work Item — [WKH-118] FEE-COMPOSE

## Resumen

Extender el cobro del protocol fee del 1% al endpoint `/compose`, replicando
el patrón best-effort ya operativo en `/orchestrate` (WKH-44). Hoy
`chargeProtocolFee` solo se invoca desde `orchestrateService`; las
composiciones explícitas vía `/compose` no generan revenue. La decisión de
producto (Fernando) es cobrar 1% en ambos modos. El cobro es best-effort
(nunca rompe la composición), idempotente por UUID de request, y gateado por
`WASIAI_PROTOCOL_FEE_WALLET` (igual que orchestrate).

---

## Sizing

- SDD_MODE: full
- Estimación: M
- Esfuerzo relativo: 1 servicio modificado (`compose.ts`), 1 route modificada
  (`routes/compose.ts`), 1 test nuevo, 0 migraciones DB.
- Branch sugerido: `feat/115-wkh-118-fee-compose`

---

## Skills Router

- `backend-typescript` — modificación de service + route en Fastify/TS strict
- `blockchain-payments` — integración EIP-712 best-effort, patron viem, idempotencia en `a2a_protocol_fees`

---

## Acceptance Criteria (EARS)

- **AC-1**: WHEN a `/compose` pipeline completes with `result.success === true`,
  the system SHALL call `chargeProtocolFee` with `orchestrationId = request.id`
  (UUID v4), `budgetUsdc = result.totalCostUsdc` (suma de débitos efectivos de
  todos los steps), and `feeRate = getProtocolFeeRate()`.

- **AC-2**: WHILE `chargeProtocolFee` is executing after a successful compose,
  the system SHALL NOT block nor reject the HTTP 200 response — the fee charge
  SHALL be best-effort (any failure captured in a local variable, response
  proceeds regardless).

- **AC-3**: IF `chargeProtocolFee` returns `{ status: 'already-charged' }` for
  a given `request.id`, THEN the system SHALL treat it as a no-op (no double
  debit, no error), identical to the orchestrate pattern.

- **AC-4**: IF `WASIAI_PROTOCOL_FEE_WALLET` is unset or empty, THEN
  `chargeProtocolFee` SHALL return `{ status: 'skipped', reason: 'WALLET_UNSET' }`
  and the compose response SHALL NOT include a fee error field.

- **AC-5**: WHEN `result.success === false` (any step failed or budget exceeded),
  the system SHALL NOT call `chargeProtocolFee` — fee is only charged on
  fully successful pipelines.

- **AC-6**: WHEN `chargeProtocolFee` returns `{ status: 'charged' }` and
  `request.a2aKeyRow?.owner_ref` is present, the system SHALL emit a
  `protocol_fee` receipt via `receiptService.emit` (fire-and-forget, best-effort
  — identical to orchestrate's WKH-124 pattern).

- **AC-7**: WHEN two concurrent requests with the same `request.id` attempt to
  charge the fee simultaneously, the system SHALL resolve idempotently via
  `a2a_protocol_fees.orchestration_id` (PK unique violation → `already-charged`)
  without double-charging.

---

## Monto base del fee en `/compose`

**Decisión**: el 1% se calcula sobre `result.totalCostUsdc` — la suma de
`agent.priceUsdc` de todos los steps que ejecutaron exitosamente (acumulado en
`compose.ts:215`: `totalCost += agent.priceUsdc`). Este es el monto
efectivamente gastado, no el `maxBudget` declarado en la request.

**Justificación**: es el equivalente más justo y consistente con orchestrate,
donde `budgetUsdc = budget` (el monto total de la sesión de orquestación, que
incluye todos los agents seleccionados por el LLM). En compose, el análogo
exacto es `totalCostUsdc` — lo que se consumió realmente en el pipeline.

**Supuesto marcado**: si `totalCostUsdc === 0` (pipeline de 0 pasos o todos
gratuitos), el fee resultante es `$0.00` y `chargeProtocolFee` lo procesa
normalmente (fee cero no dispara el safety guard `feeUsdc > budgetUsdc`).
[ASSUMPTION — confirmar si fee de $0 debe ser skipped silenciosamente o cobrado
como $0. Comportamiento de orchestrate: se cobra porque el guard sólo falla si
fee > budget, y 0 ≤ 0 es válido].

---

## Idempotencia

**Decisión**: usar `request.id` (UUID v4 generado por `genReqId =
crypto.randomUUID()` en `src/middleware/request-id.ts`) como valor de
`orchestration_id` en `a2a_protocol_fees`.

**Justificación**:
- `request.id` ya es UUID v4 garantizado por `Fastify({ genReqId })`.
- La columna `orchestration_id UUID PRIMARY KEY` en `a2a_protocol_fees`
  (`supabase/migrations/20260421015829_a2a_protocol_fees.sql`) acepta cualquier
  UUID — no es semánticamente restringida a "orchestrations".
- Cero cambios de schema DB; cero nuevas migraciones.
- Colisión práctica imposible (UUID v4 → 2^122 espacio).
- En compose el `request.id` es único por invocación HTTP → idempotencia
  exactamente equivalente a la de orchestrate.

**Alternativa descartada**: generar un `compose_id` adicional (uuid en el route
handler) — añade complejidad sin beneficio vs usar `request.id` que ya existe.

---

## Punto de inserción del cobro

El cobro se inserta en `src/routes/compose.ts`, en el route handler POST `/`,
inmediatamente después de `composeService.compose()` retorna con
`result.success === true`, y ANTES de construir la respuesta final. Pattern
espejo de orchestrate (ver `src/services/orchestrate.ts:437-482`):

```
const result = await composeService.compose(...)
if (reply.sent) return         // timeout guard (existente)
if (result.success) {
  // [INSERTAR AQUÍ] chargeProtocolFee(...)
  // [INSERTAR AQUÍ] receiptService.emit(...) best-effort si charged + owner_ref
}
// ... respuesta existente
```

**Alternativa evaluada**: insertar en `composeService.compose()` (el service).
Descartada porque compose no tiene acceso a `request.id` (es un artefacto HTTP,
no de dominio), y añadir ese parámetro al `ComposeRequest` type mezcla
preocupaciones HTTP con lógica de dominio. El pattern de orchestrate también
cobra en la capa de service, pero allí `orchestrationId` es generado dentro del
service mismo (`crypto.randomUUID()` en `orchestrateService`). En compose el id
equivalente está en la capa HTTP. Mantener el cobro en el route handler es la
opción que no requiere cambiar el tipo `ComposeRequest`.

---

## Scope IN

| Archivo | Cambio |
|---------|--------|
| `src/routes/compose.ts` | Importar `chargeProtocolFee`, `getProtocolFeeRate` desde `../services/fee-charge.js`; importar `receiptService` desde `../services/receipt.js`; agregar bloque best-effort post-compose (AC-1..AC-6) |
| `test/compose-fee.test.ts` (nuevo) | Test unitario: fee cobrado en compose exitoso; skipped en compose fallido; idempotencia retorna already-charged |

## Scope OUT

- `src/services/compose.ts` — NO se modifica el service (no recibe `composeId`)
- `src/services/fee-charge.ts` — NO se modifica (se reutiliza sin cambios)
- `supabase/migrations/` — NO se agrega migración (columna `orchestration_id` ya es UUID genérico)
- `src/services/orchestrate.ts` — NO se toca
- Dashboard / analytics — NO es scope de esta HU
- Recibo WKH-124 en `/compose` — SI es scope (AC-6), pero solo el `emit` fire-and-forget, sin nuevo endpoint

---

## Decisiones técnicas (DT-N)

- **DT-1**: El monto base del fee en compose es `result.totalCostUsdc` (suma
  acumulada de `agent.priceUsdc` de todos los steps exitosos). No es `maxBudget`
  (budget declarado) ni el precio del paso 0. Justificación: cobra sobre lo
  efectivamente consumido, equivalente semántico a lo que orchestrate llama
  "budget" (que también es el total gastado en el pipeline).

- **DT-2**: El identificador de idempotencia para `a2a_protocol_fees.orchestration_id`
  es `request.id` (UUID v4, generado por `crypto.randomUUID()` en `genReqId`).
  No se genera un nuevo UUID en el handler. No se modifica el schema de la tabla.

- **DT-3**: El cobro del fee se ubica en `src/routes/compose.ts` (route handler),
  no en `src/services/compose.ts` (service). Razón: `request.id` pertenece a la
  capa HTTP; insertar en el service requeriría cambiar `ComposeRequest` con un
  campo semánticamente HTTP, violando separación de preocupaciones.

- **DT-4**: El recibo `protocol_fee` (AC-6) se emite con `fire-and-forget`
  (`receiptService.emit(...).catch(warn)`) solo cuando `feeResult.status ===
  'charged'` y `request.a2aKeyRow?.owner_ref` está presente. El path x402 (sin
  `a2aKeyRow`) no emite recibo — idéntico al comportamiento de orchestrate
  (`request.scopingKeyRow?.owner_ref`).

- **DT-5**: El compose retorna `totalCostUsdc` en su respuesta ya. La HU NO
  agrega campos nuevos al response body (`feeChargeError`, `feeChargeTxHash`).
  Justificación: orchestrate los agrega, pero en compose el caller ya recibe
  `totalCostUsdc` y la opacidad del fee es por diseño. [SUPUESTO — si el
  producto requiere exponer `protocolFeeUsdc` en el response de compose,
  marcarlo como aditivo en F2].

---

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO que el fallo de `chargeProtocolFee` interrumpa la
  respuesta 200 de compose. Todo error de fee DEBE capturarse en una variable
  local y logearse como `warn`/`error`; la respuesta se construye
  independientemente del resultado del fee.

- **CD-2**: OBLIGATORIO reutilizar `chargeProtocolFee` de `src/services/fee-charge.ts`
  sin duplicar su lógica. PROHIBIDO copiar el bloque EIP-712 sign+settle en
  el route de compose.

- **CD-3**: PROHIBIDO usar el `maxBudget` de la request body como `budgetUsdc`
  para el fee. El único valor válido es `result.totalCostUsdc` (lo gastado real).

- **CD-4**: PROHIBIDO llamar a `chargeProtocolFee` cuando `result.success ===
  false`. El fee solo se cobra sobre pipelines completados.

- **CD-5**: OBLIGATORIO que el campo `orchestration_id` pasado a
  `chargeProtocolFee` sea `request.id` (UUID v4 del HTTP request). No generar
  un UUID adicional en el handler.

- **CD-6**: El recibo `protocol_fee` (AC-6) DEBE ser fire-and-forget con `.catch`
  que solo loguea — idéntico al patrón de orchestrate. PROHIBIDO `await`-ear el
  emit de recibo.

---

## Missing Inputs

- [resuelto en F2] ¿El response body de compose debe exponer `protocolFeeUsdc`
  y `feeChargeTxHash`? DT-5 asume que NO (scope mínimo). El Architect puede
  añadirlo como TD en la SDD si el producto lo requiere.
- [resuelto en F2] ¿El test existente en `test/` necesita mocking de
  `chargeProtocolFee` o Supabase? El Architect define la estrategia de test
  (vitest + mock de supabase o integration test).

---

## Análisis de paralelismo

- **WKH-118 no bloquea otras HUs** conocidas en backlog (fee es additive, no
  cambia contratos públicos de `/compose`).
- **WKH-124 (receipts)**: ya está DONE. La integración del emit de recibo en
  compose (AC-6) es aditiva — `receiptService` ya existe y es consumible.
- **Dependencia entrante**: WKH-118 depende de WKH-44 (DONE — `chargeProtocolFee`
  ya implementado) y WKH-124 (DONE — `receiptService.emit` disponible).
- **Puede ir en paralelo con**: cualquier HU que no toque `src/routes/compose.ts`
  ni `src/services/fee-charge.ts`.
- **Conflicto potencial**: si una HU en vuelo modifica `src/routes/compose.ts`
  (ej. WKH-125 ya está DONE, WKH-121/122/123 ya DONE) — revisar git diff antes
  de branchar.
