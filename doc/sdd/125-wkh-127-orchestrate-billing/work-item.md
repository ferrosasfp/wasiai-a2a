# Work Item — [WKH-127] Orchestrate Billing: precio real + reembolso en fallo

## Resumen

El endpoint `/orchestrate` debita al usuario $1 USD flat (placeholder backward-compat)
independientemente del costo real del pipeline planificado, y no reembolsa el débito si el
pipeline falla (incluyendo fallos de infraestructura como `ANTHROPIC_API_KEY` o
`FACILITATOR_API_KEY` no configuradas). Incidente real (2026-06-24): un usuario con
`budget[43113]=1` corrió una orquestación que falló por config faltante del gateway; quedó
con `budget=0` y `daily_spent=1`. Esta HU corrige (A) el débito para que refleje el costo real
planificado y (B) introduce un camino de reembolso (credit-back) para fallos totales del
pipeline donde el usuario no recibió valor.

---

## Sizing

- **SDD_MODE**: full
- **Estimación**: L (path de pago crítico, dos sub-problemas acoplados, atomicidad, tests)
- **Metodología**: QUALITY (path de dinero — obligatorio AR + CR + QA)
- **Branch sugerido**: `fix/125-wkh-127-orchestrate-billing`

---

## Skills relevantes

- `payment-billing` (débito, refund, atomicidad PG)
- `fastify-middleware` (preHandler chain, request augmentation)

---

## Acceptance Criteria (EARS)

### (A) Precio real en /orchestrate

**AC-1**: WHEN `/orchestrate` recibe una request autenticada con Agent Key y el plan LLM (o greedy) produce un set de steps con costo total calculable, THEN the system SHALL debitar el costo total planificado (`sum(agent.priceUsdc)` del plan seleccionado) en lugar del placeholder de $1.

**AC-2**: WHEN el plan planificado resulta en `steps.length === 0` (sin agentes dentro del budget o no encontrados), THEN the system SHALL NOT debitar ningún monto del budget del usuario (débito cero o no aplicado).

**AC-3**: WHEN el costo real del plan es conocido antes del débito del middleware, THEN the system SHALL inyectar ese valor via `request.orchestrateEstimatedCostUsd` (nuevo campo, análogo a `composeEstimatedCostUsd`) de modo que el middleware de debit (`requirePaymentOrA2AKey`) lo use en lugar del placeholder.

**AC-4**: WHEN el plan se construye pero el costo total real es `0` (todos los agentes tienen `priceUsdc === 0`), THEN the system SHALL aplicar el mismo fallback de $1 + warn + header `x-debit-fallback: registry-miss` que ya usa `/compose` (DT-C de WKH-59), para evitar debitar $0 por un posible error de config.

### (B) Reembolso en fallo

**AC-5**: WHEN el pipeline de orquestación retorna `pipeline.success === false` Y `pipeline.totalCostUsdc === 0` (ningún step settleó exitosamente, fallo total), THEN the system SHALL emitir un credit-back atómico que restituya el monto debitado en el step-0 (`estimatedCostUsd`) al budget de la key del usuario.

**AC-6**: WHEN el pipeline retorna `pipeline.success === false` Y `pipeline.totalCostUsdc > 0` (al menos un step settleó pero el pipeline falló parcialmente), THEN the system SHALL reembolsar únicamente la diferencia (`estimatedCostUsd - pipeline.totalCostUsdc`) si esta es positiva; si `totalCostUsdc >= estimatedCostUsd`, no se reembolsa (el usuario ya consumió lo suficiente).

**AC-7**: WHEN un `/orchestrate` falla completamente (fallo total, AC-5) y el reembolso es ejecutado, THEN after the refund completes, the system SHALL leave the user's `budget[chainId]` y `daily_spent_usd` in a state consistent with zero net consumption for that request (budget restaurado al valor previo al débito).

**AC-8**: WHEN el credit-back falla (error de DB o timeout), THEN the system SHALL loguear el fallo con `[orchestrate.refund-failed]` incluyendo `keyId`, `chainId`, `amountUsd` y `orchestrationId`, y retornar la respuesta de error al usuario con un campo `refundError: true` en el body, para habilitar reconciliación manual.

**AC-9**: WHEN `/orchestrate` es llamado por un caller x402 (no Agent Key), THEN the system SHALL NOT intentar ningún credit-back (el flujo x402 no tiene budget de Agent Key que reembolsar); el comportamiento pre-WKH-127 se preserva intacto para ese path.

### (C) No-regresión

**AC-10**: WHEN `/compose` es llamado (cualquier caso), THEN the system SHALL NOT verse afectado por los cambios de esta HU; el flujo `resolveComposePriceHandler` + débito step-0 de compose debe permanecer intacto.

**AC-11**: WHEN un pipeline exitoso de `/orchestrate` es ejecutado, THEN the system SHALL debitar el costo planificado (precio real) sin reembolso, y el protocol fee del 1% se aplica normalmente (success-gated, igual que hoy).

---

## Scope IN

| Archivo | Cambio esperado |
|---------|----------------|
| `src/routes/orchestrate.ts` | Agregar preHandler que planifique y calcule costo real antes del debit; inyectar `request.orchestrateEstimatedCostUsd` |
| `src/middleware/a2a-key.ts` | Extender el bloque `estimatedCostUsd` (líneas 286-291) para leer `request.orchestrateEstimatedCostUsd` con la misma prioridad que `composeEstimatedCostUsd`; agregar hook post-ejecución para disparar credit-back en fallo |
| `src/services/orchestrate.ts` | Exponer el costo del plan planificado para que el preHandler lo use; coordinar señal de fallo total vs fallo parcial para el credit-back |
| `src/services/budget.ts` | Agregar función `credit(keyId, chainId, amountUsd, ownerRef)` atómica para el credit-back; usar la PG function existente o nueva RPC equivalente a `increment_a2a_key_spend` con signo negativo |
| `src/types/index.ts` | Agregar `orchestrateEstimatedCostUsd?: number` al tipo de request augmentation |
| `test/` (nuevos archivos) | Tests unitarios/integración para: (a) precio real en orchestrate, (b) credit-back en fallo total, (c) credit-back parcial, (d) no-regresión compose |

---

## Scope OUT

- `/compose` y su `resolveComposePriceHandler` — NO tocar; su debit de precio real ya funciona
- Guard `i>0` anti-double-charge en `src/services/compose.ts` — NO tocar (CD-1 existente)
- Escrow no-custodial (WKH-126a/b/c) — no hay impacto en el contrato ni el verifier
- Protocol fee (1%) — NO cambiar la lógica de `chargeProtocolFee`; solo asegurar coherencia con el nuevo monto de debit base
- Flujo x402 inbound (`runX402Fallback`) — NO tocar; AC-9 explicita la separación
- `debit_delegation_and_parent` y paths de delegación/session — el credit-back se aplica solo en el path master key de orchestrate (step-0); los debits per-step (steps 1..N en compose) no se reembolsan por esta HU

---

## Decisiones técnicas (DT-N)

**DT-1: Opción de inyección del precio — preHandler vs mover el débito a post-plan**

Hay dos enfoques para resolver el precio real:

| Opción | Descripción | Pros | Contras |
|--------|-------------|------|---------|
| **A — preHandler** (análogo a compose) | Agregar un preHandler antes de `requirePaymentOrA2AKey` que invoque discovery + LLM planning, calcule el costo y augmente `request.orchestrateEstimatedCostUsd`. El middleware debita ese valor. | Simetría con compose. El middleware no cambia. Budget check antes de gastar tiempo en LLM. | Duplica el trabajo: discovery + LLM se hacen DOS veces (en preHandler y en el service). Costo de 2x LLM call en orchestrate (latencia + tokens). |
| **B — mover el débito a post-plan** | El middleware NO debita en el preHandler para orchestrate. El service planifica, calcula el costo, debita en el service, y maneja el credit-back internamente. | Sin duplicación de LLM. Control fino del timing. | Rompe la simetría del middleware. El middleware necesita saber si ya se cobró. Complejidad de coordinación. |
| **C — preHandler liviano + cost propagation** | Un preHandler hace discovery + greedy/LLM mínimo para estimar el costo (sin ejecutar el plan completo), augmente `request.orchestrateEstimatedCostUsd`, y el service re-planifica (acepta la doble planificación pero el segundo LLM call puede saltarse si se pasa el plan del preHandler). | Simetría con compose. Una sola modificación al middleware. | Mayor complejidad de coordinación entre preHandler y service. |

**Recomendación para el Architect**: Opción **B** (débito post-plan en el service) es técnicamente más limpia y evita el problema de duplicar el LLM call, que es la operación más costosa y lenta de orchestrate. La simetría con compose es un nice-to-have, no un requisito funcional. El Architect debe decidir en F2 si preservar el modelo "middleware debita" o mover el débito al service. [NEEDS CLARIFICATION: el Architect debe evaluar si el model middleware-first es una restricción de arquitectura o puede quebrarse para orchestrate].

**DT-2: Función de credit-back en budget.ts**

La PG function `increment_a2a_key_spend` solo suma (crédito positivo al spend). Para un refund se necesita una nueva RPC o bien usar la misma con un valor negativo. El Architect debe evaluar:
- Crear `decrement_a2a_key_spend` (RPC nueva, espejo con p_amount negativo válido)
- O llamar `increment_a2a_key_spend` con `-amountUsd` (si PG lo acepta con checks)
- O crear una función `refund_a2a_key_spend` que sea explícitamente un credit-back con las mismas protecciones FOR UPDATE y ownership guard

La opción atómica es obligatoria (CD-3). El Architect define en F2.

**DT-3: Granularidad del reembolso (fallo total vs parcial)**

AC-5 y AC-6 definen el modelo de reembolso parcial. El `pipeline.totalCostUsdc` ya es calculado por `composeService.compose()` y expuesto en el result. El service de orchestrate ya tiene acceso a este valor post-ejecución. La lógica de "cuánto reembolsar" vive naturalmente en `orchestrate.ts` después de `composeService.compose()`.

**DT-4: orchestrateEstimatedCostUsd vs reutilizar composeEstimatedCostUsd**

Si se elige la opción A/C (preHandler), se necesita un campo de request augmentation diferente a `composeEstimatedCostUsd` para evitar colisiones de nombres en el middleware (CD-9 de WKH-59 establece que ambos son distintos). Campo sugerido: `orchestrateEstimatedCostUsd`.

---

## Constraint Directives (CD-N)

**CD-1 — PROHIBIDO double-charge**: el guard `i>0` en `src/services/compose.ts` que previene el double-charge del step-0 en compose NO debe ser removido ni alterado. Esta HU no toca compose internals.

**CD-2 — PROHIBIDO revenue leak en pipeline exitoso**: un `/orchestrate` que retorna `pipeline.success === true` con `totalCostUsdc > 0` NUNCA debe recibir un credit-back. El credit-back es exclusivo de fallo total o fallo parcial (AC-5/AC-6). Cualquier regresión que reembolse un pipeline exitoso es BLOQUEANTE en AR.

**CD-3 — OBLIGATORIO atomicidad del credit-back**: la función de credit-back en DB DEBE usar `FOR UPDATE` en el mismo estilo que `increment_a2a_key_spend`. No se permite un credit-back no atómico (race condition entre débito y reembolso).

**CD-4 — OBLIGATORIO Ownership Guard**: cualquier nueva query/mutación sobre `a2a_agent_keys` (incluyendo la función de credit-back) DEBE filtrar por `owner_ref` conforme a WKH-53/SEC-02b. El Architect debe verificar que la nueva RPC de credit-back valide `p_owner_ref`.

**CD-5 — PROHIBIDO tocar el flujo x402**: el branch `runX402Fallback` en el middleware no debe ser modificado. AC-9 confirma que el credit-back no aplica a callers x402.

**CD-6 — PROHIBIDO propagar mensaje crudo de PG al cliente**: el error `refundError` en el body (AC-8) es un flag booleano, no incluye mensajes internos de Postgres.

**CD-7 — PROHIBIDO modificar compose.ts** (rutas/services): el scope de esta HU no incluye cambios a `src/routes/compose.ts` ni `src/services/compose.ts` salvo los estrictamente necesarios para pasar información de costo entre orchestrate y el middleware.

**CD-8 — OBLIGATORIO: el nuevo preHandler (si se elige Opción A/C) debe correr ANTES de `requirePaymentOrA2AKey`**, siguiendo el patrón de `resolveComposePriceHandler` en compose.

---

## Missing Inputs

- **[NEEDS CLARIFICATION en F2]**: DT-1 — El Architect debe decidir si el débito de orchestrate se mueve al service (Opción B) o se mantiene en el middleware (Opción A/C con posible doble LLM call). La elección impacta directamente el diseño del SDD.
- **[RESUELTO en F2]**: La interfaz exacta de la nueva RPC de credit-back (nombre, parámetros, constraints de PG) la define el Architect en el SDD.
- **[RESUELTO en F2]**: Si el credit-back aplica también a paths de delegación/session en orchestrate (hoy orchestrate puede tener `delegationContext` o `keySessionContext`). La HU actual lo marca fuera de scope para el step-0 pero el Architect debe confirmar.

---

## Análisis de paralelismo

- Esta HU no bloquea otras HUs conocidas actualmente.
- Tiene dependencia hacia atrás de: WKH-59 (real-price-debit compose, DONE), WKH-53/SEC-02b (ownership guard, DONE), WKH-101 (delegation billing, DONE), WKH-121 (session billing, DONE).
- No puede correr en paralelo con HUs que modifiquen `src/middleware/a2a-key.ts` o `src/services/budget.ts` para evitar conflictos.
- Branch: `fix/125-wkh-127-orchestrate-billing` desde `main`.

---

## Análisis de waves (referencia para F2.5)

Sugerencia inicial para el Architect (no vinculante):

| Wave | Qué | Archivos |
|------|-----|----------|
| W1 | DB: RPC de credit-back atómico con ownership guard | migración SQL nueva |
| W2 | `budget.ts`: agregar `credit()` usando la nueva RPC | `src/services/budget.ts` |
| W3 | Orchestrate: inyección de precio real (preHandler o post-plan según DT-1) | `src/routes/orchestrate.ts`, `src/middleware/a2a-key.ts`, `src/types/index.ts` |
| W4 | Orchestrate service: lógica de credit-back post-compose | `src/services/orchestrate.ts` |
| W5 | Tests: billing correcto, credit-back total, credit-back parcial, no-regresión compose | `test/` |

---

## Evidencia de verificación F0

| Afirmación HU | Archivo:línea | Estado |
|---------------|---------------|--------|
| Placeholder $1 en estimatedCostUsd | `src/middleware/a2a-key.ts:286-291` | CONFIRMADO |
| `/orchestrate` no inyecta `composeEstimatedCostUsd` | `src/routes/orchestrate.ts:46-58` — lista de preHandlers sin price resolver | CONFIRMADO |
| `/compose` sí inyecta el precio real | `src/routes/compose.ts:160` — `resolveComposePriceHandler` antes de `requirePaymentOrA2AKey` | CONFIRMADO |
| Débito optimista pre-ejecución sin refund | `src/middleware/a2a-key.ts:831` — comentario BLQ-1/2/3/4; `budget.ts` — sin función `credit`/`refund` | CONFIRMADO |
| Fee de protocolo solo si success | `src/services/orchestrate.ts:437` — `if (pipeline.success)` | CONFIRMADO |
| `totalCostUsdc` conocido post-compose | `src/services/orchestrate.ts:492` — `costUsdc: pipeline.totalCostUsdc` | CONFIRMADO |
| Costo del plan conocido en el service | `src/services/orchestrate.ts:331-346` — `budgetedAgents` + `totalCost` calculado antes de llamar compose | CONFIRMADO |
