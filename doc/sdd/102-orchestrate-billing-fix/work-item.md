# Work Item — [WKH-102] Fix billing: /orchestrate no debita steps 2..N de master keys (TD-WKH-101-ORCH)

## Resumen

`/orchestrate` con master keys (path no-delegación) cobra al caller solo el step 0 del pipeline multi-step. Los steps 1..N ejecutan sin debitar porque `orchestrate.ts` pasa `chainId: undefined` a `composeService.compose`, y el guard `i > 0 && chainId !== undefined` en `compose.ts:130` salta el debit. Es un revenue leak: el caller recibe N agentes pagando como si recibiera 1. La corrección consiste en propagar el `chainId` resuelto en el middleware también para el path master, igualando el comportamiento del path de delegación.

## Sizing

- SDD_MODE: mini
- Estimación: S
- Branch sugerido: `fix/102-orchestrate-billing-fix`
- Flow: FAST+AR — el fix es de 1-2 líneas en `orchestrate.ts`, pero toca el payment path crítico y tiene riesgo de double-charge del step 0; el AR es obligatorio.

## Bug confirmado — archivo:línea

### Causa raíz

`src/services/orchestrate.ts:405-417` — la llamada a `composeService.compose`:

```
chainId: request.delegationContext ? request.chainId : undefined,
```

Para master keys `delegationContext` es siempre `undefined` → `chainId` se pasa como `undefined`.

### Efecto en compose

`src/services/compose.ts:130` — el guard per-step:

```
if (i > 0 && scopingKeyRow && chainId !== undefined) {
```

Con `chainId === undefined` el bloque entero se salta → `budgetService.debit` nunca se llama para steps 1..N → revenue leak.

### Confirmación de que el step 0 SÍ se debita

El step 0 se debita en el middleware `src/middleware/a2a-key.ts:547-551` via `budgetService.debit(keyRow.id, chainId, estimatedCostUsd)`. El `chainId` resuelto se guarda en `request.resolvedChainId` (`a2a-key.ts:529`). El route handler `src/routes/orchestrate.ts:83` ya propaga `chainId: request.resolvedChainId` al `OrchestrateRequest`, por lo que el valor resuelto está disponible — solo el service `orchestrate.ts:416` lo descarta condicionalmente.

### El comment en el código documenta el bug explícitamente

`src/types/index.ts:361-365` (JSDoc de `OrchestrateRequest.chainId`):

> HOY orchestrate NO pasa chainId a compose → steps 2..N no se debitan.
> El under-charge preexistente de master-en-orchestrate queda como deuda técnica TD-WKH-101-ORCH (NO se introduce ni se corrige acá).

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `/orchestrate` ejecuta un pipeline de N steps (N ≥ 2) con una master key, the system SHALL debitar `budgetService.debit` exactamente una vez por cada step `i > 0` (steps 1..N-1), usando el `chainId` resuelto por el middleware.

- **AC-2**: WHEN `/orchestrate` ejecuta un pipeline de N steps con una master key, the system SHALL NO debitar el step 0 en `compose.ts` (el step 0 ya fue debitado por el middleware `a2a-key.ts:547`; el guard `i > 0` en `compose.ts:130` protege este invariante — no debe ser removido).

- **AC-3**: IF el budget de la master key es insuficiente para cubrir el costo de un step `i > 0` en un pipeline multi-step de orchestrate, THEN the system SHALL interrumpir el pipeline y retornar `ComposeResult.success = false` con `error` conteniendo "debit failed" o "insufficient budget", sin ejecutar los steps siguientes.

- **AC-4**: WHEN `/orchestrate` ejecuta un pipeline de 1 step con una master key, the system SHALL retornar el mismo resultado que antes del fix (el guard `i > 0` impide cualquier cambio de comportamiento en pipelines de 1 step).

- **AC-5**: WHEN el path de delegación (session token `wasi_a2a_session_*`) ejecuta `/orchestrate`, the system SHALL mantener el comportamiento existente sin regresión (el fix NO debe alterar la rama `request.delegationContext ? request.chainId : undefined` para delegación).

- **AC-6**: WHEN los tests existentes de `orchestrate.ts` y `routes/orchestrate.ts` verificaban el comportamiento de under-charge (compose llamado sin `chainId`), THEN esos tests SHALL ser actualizados para reflejar el comportamiento correcto (compose recibe `chainId` para master keys). Los tests de delegación existentes deben seguir pasando sin cambios.

## Scope IN

- `src/services/orchestrate.ts` — línea ~416: cambiar la condición del `chainId` de `request.delegationContext ? request.chainId : undefined` a `request.chainId` (pasar el chainId resuelto siempre, independientemente de si hay delegación).
- `src/services/orchestrate.test.ts` — actualizar los mocks/assertions que verificaban que `composeService.compose` era llamado sin `chainId` para el path master; ahora debe verificar que se pasa `chainId`.
- `src/routes/orchestrate.test.ts` — revisar si algún test del route asume el comportamiento de under-charge.
- `src/types/index.ts` — actualizar el JSDoc de `OrchestrateRequest.chainId` para reflejar que el fix fue aplicado (remover el texto "HOY orchestrate NO pasa chainId... TD-WKH-101-ORCH").

## Scope OUT

- `src/services/compose.ts` — el guard `i > 0 && chainId !== undefined` (línea 130) NO debe modificarse. Es la defensa anti-double-charge documentada en CD-11 del mismo archivo. El fix vive únicamente en `orchestrate.ts`.
- `src/middleware/a2a-key.ts` — sin cambios; el debit del step 0 y la resolución de `chainId` ya son correctos.
- `src/services/budget.ts` — sin cambios.
- El path x402 (sin a2a key) — sin cambios; cuando `chainId === undefined` porque el caller usa x402, el skip del debit per-step es intencional.
- Cambios a la shape del response de `/orchestrate` — backward-compat estricto.
- Migración de base de datos — no necesaria.

## Decisiones técnicas

- **DT-1**: El fix es un one-liner en `orchestrate.ts:416`: reemplazar `request.delegationContext ? request.chainId : undefined` por `request.chainId`. El `chainId` resuelto ya está disponible en `request.chainId` para ambos paths (master y delegación) porque el route handler lo propaga incondicionalmente desde `request.resolvedChainId` (`routes/orchestrate.ts:83`). El guard `i > 0` en compose sigue siendo la única defensa anti-double-charge del step 0, y no se toca.

- **DT-2**: El chainId resuelto aplica a todos los steps del pipeline (single-chain semantics). Todos los steps de un orchestrate usan el mismo chainId que el step 0. Esto es consistente con el modelo WKH-59 "real-price-debit" para compose y con la intención documentada en `ComposeRequest.chainId`. `[NEEDS CLARIFICATION]`: ¿el modelo de orchestrate multichain es single-chain (todos los steps en la misma chain del caller) o cada step puede ir en una chain distinta según el agent card? — si fuera multi-chain, el fix sería más complejo y este work-item debería reducir scope a single-chain confirmado.

- **DT-3**: `[NEEDS CLARIFICATION]`: ¿qué pasa si un step intermedio (step `i > 0`) tiene `agent.priceUsdc === 0` o NaN? El fallback honesto de `compose.ts:140-156` ya cubre esto (debita `1.0` USDC como fallback con un warn log) — se asume que ese comportamiento aplica también en el path orchestrate post-fix, sin cambio adicional.

## Constraint Directives

- **CD-1**: PROHIBIDO remover o condicionar el guard `i > 0` en `compose.ts:130`. Es la defensa anti-double-charge del step 0. Si el AR detecta que el fix mueve esa lógica, es BLOQUEANTE.
- **CD-2**: PROHIBIDO pasar `chainId` hardcodeado. OBLIGATORIO usar `request.chainId` (que viene de `request.resolvedChainId` resuelto por el middleware).
- **CD-3**: PROHIBIDO modificar la shape del response de `/orchestrate` (backward-compat estricto).
- **CD-4**: OBLIGATORIO actualizar los tests existentes que asumían el under-charge; no silenciarlos con `vi.mocked(...).mockReturnValue(...)` sin cambiar las assertions.
- **CD-5**: PROHIBIDO alterar el path de delegación (`wasi_a2a_session_*`). Los tests de delegación de WKH-101 deben seguir pasando sin modificaciones.
- **CD-6**: Sin `any` explícito. TypeScript strict en todo archivo tocado.
- **CD-7**: Ownership Guard intacto — el `scopingKeyRow` y `owner_ref` no se tocan.

## Missing Inputs

- `[NEEDS CLARIFICATION]` **DT-2 — modelo multichain en orchestrate**: ¿orchestrate soporta hoy steps en chains distintas, o todos los steps usan la misma chain del caller? Si el answer es "single-chain siempre" (lo que parece por el modelo actual), el fix es trivial. Si fuera "cada agente puede estar en su propia chain", el debit per-step necesitaría resolver el chainId por agent, lo que está fuera de scope de este work-item. Resoluble en F2 con el Architect.
- `[NEEDS CLARIFICATION]` **comportamiento esperado de tests existentes**: hay tests en `orchestrate.test.ts` que mockan `composeService.compose` y no verifican el `chainId` propagado — ¿se quiere agregar assertions explícitas al fix, o solo asegurar que el código no rompe los tests existentes? Resoluble en F2.

## Análisis de paralelismo

- Esta HU NO bloquea otras HUs activas.
- No hay dependencias con WKH-100 ni WKH-101 (ya DONE).
- Puede ir en paralelo con cualquier HU de feature; solo toca el billing path de orchestrate.
- El fix es prerequisito lógico de cualquier HU futura que confíe en que orchestrate cobra correctamente (e.g., facturación, analytics de revenue).
