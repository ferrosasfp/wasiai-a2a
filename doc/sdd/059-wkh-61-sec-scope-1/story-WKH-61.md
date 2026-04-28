# Story File — WKH-61 / SEC-SCOPE-1

> **Para el Dev**: este archivo es **autocontenido**. NO necesitás leer el
> work-item ni el SDD para implementar; toda la información operativa está acá.
> Si necesitás más contexto: `doc/sdd/059-wkh-61-sec-scope-1/sdd.md` (decisiones
> técnicas) y `work-item.md` (ACs originales).
>
> **Branch**: `feat/059-wkh-61-sec-scope-1`
> **Baseline target**: 518 tests verde post-WKH-62 → ~530 post-WKH-61
> **Flow**: QUALITY (todas las gates obligatorias)

---

## §1 — Contexto compacto (qué construir y por qué)

### El bug

`src/middleware/a2a-key.ts:152` ejecuta:

```ts
const scopingResult = authzService.checkScoping(keyRow, {});
```

El target es `{}` — vacío. `authzService.checkScoping` (en
`src/services/authz.ts:21-77`) chequea `target.registry`, `target.agent_slug`,
`target.category`. Con un target vacío, **toda key con `allowed_registries`,
`allowed_agent_slugs` o `allowed_categories` configurados recibe HTTP 403
SCOPE_DENIED en el 100% de las requests** — antes incluso de saber a qué
agente apunta el caller.

Severidad: **BLQ-MED del security audit 2026-04-27**. Feature de keys
restringidas (scoping) está completamente inoperativa hoy.

### El fix (resumen)

1. **Borrar el check del middleware** (W1) — el middleware no sabe el agente
   destino, no puede chequear scoping correctamente.
2. **Mover el check a `composeService.compose`** (W2) — ejecutarlo por step,
   inmediatamente después de `resolveAgent` (cuando el `Agent` está disponible)
   y antes de `invokeAgent`.
3. **Propagar el `keyRow` desde el route handler** vía `ComposeRequest`
   extendido con `scopingKeyRow?: A2AAgentKeyRow`. Idem en `OrchestrateRequest`.
4. **Mapear `errorCode === 'SCOPE_DENIED'` a HTTP 403** en los route handlers
   (compose.ts, orchestrate.ts).
5. **Backward-compat total**: keys sin scoping (`allowed_*=null`) o callers
   x402 (sin `scopingKeyRow`) NO ejecutan el check → comportamiento idéntico
   al baseline.

---

## §2 — Scope IN (lista exhaustiva de archivos a tocar)

### Archivos modificados

| # | Archivo | Cambio | Wave |
|---|---------|--------|------|
| 1 | `src/middleware/a2a-key.ts` | Borrar el bloque `// 5. Check scoping` (líneas 151-159). Quitar import `authzService` (línea 15). Renumerar pasos posteriores (6→5, 7→6, 8→7, 9→8). | W1 |
| 2 | `src/middleware/a2a-key.test.ts` | Actualizar el test `AC-3: SCOPE_DENIED — registry not in allowed list` (línea 283-297) para esperar **200** (no 403) y NO verificar `error_code`. Renombrar a `REGRESSION-WKH-61: middleware no longer rejects keys with allowed_registries`. | W0 + W1 |
| 3 | `src/types/index.ts` | Extender `ComposeRequest` con `scopingKeyRow?: A2AAgentKeyRow`. Extender `ComposeResult` con `errorCode?: 'SCOPE_DENIED'` y `scopeDeniedTarget?: { registry, agent_slug, category? }`. Extender `OrchestrateRequest` con `scopingKeyRow?: A2AAgentKeyRow`. Asegurar import/re-export de `A2AAgentKeyRow` (ya existe línea 631 según SDD). | W2 + W3 |
| 4 | `src/services/compose.ts` | Importar `authzService` y `AuthzTarget`. Definir helper privado `readCategory(agent: Agent): string \| undefined`. Destructurar `scopingKeyRow` en `compose(request)`. Agregar el check post-`resolveAgent` (después del null-check, antes del budget-check) — retornar early con `errorCode: 'SCOPE_DENIED'` y `scopeDeniedTarget` si la key deniega. | W2 |
| 5 | `src/routes/compose.ts` | Pasar `scopingKeyRow: request.a2aKeyRow` al llamar `composeService.compose` (línea 59-62). En el `if (!result.success)` (línea 67-72), mapear `result.errorCode === 'SCOPE_DENIED' → status 403`, default `400`. | W2 |
| 6 | `src/services/orchestrate.ts` | En la llamada `composeService.compose` (línea 403-407), agregar `scopingKeyRow: request.scopingKeyRow`. | W3 |
| 7 | `src/routes/orchestrate.ts` | Pasar `scopingKeyRow: request.a2aKeyRow` al llamar `orchestrateService.orchestrate` (línea 67-75). En el `reply.send` final (línea 80-81), mapear `result.pipeline.errorCode === 'SCOPE_DENIED' → status 403`. | W3 |

### Archivos nuevos (tests)

| # | Archivo | Tests | Wave |
|---|---------|-------|------|
| 8 | `src/routes/compose.test.ts` | NUEVO. ≥1 integration test con `fastify.inject()` validando 403 SCOPE_DENIED end-to-end. | W4 |
| 9 | `src/routes/orchestrate.test.ts` | NUEVO. ≥1 integration test análogo. | W4 |

### Archivos modificados — tests

| # | Archivo | Tests agregados | Wave |
|---|---------|----------------|------|
| 10 | `src/services/compose.test.ts` | 9 tests nuevos en un nuevo `describe('composeService.compose — WKH-61 scoping per step', ...)` | W2 + W4 |

### Total esperado

- **Archivos modificados de producción**: 6 (`a2a-key.ts`, `types/index.ts`, `compose.ts`, `routes/compose.ts`, `orchestrate.ts`, `routes/orchestrate.ts`)
- **Archivos nuevos de test**: 2 (`routes/compose.test.ts`, `routes/orchestrate.test.ts`)
- **Archivos modificados de test**: 2 (`a2a-key.test.ts`, `services/compose.test.ts`)
- **Tests agregados**: ~12 (1 W0 regression + 9 service unit + 2 route integration)
- **Tests modificados**: 1 (el `AC-3 SCOPE_DENIED` del middleware)

---

## §3 — Acceptance Criteria + Plan de tests

| AC | EARS | Test ID | Archivo | Tipo |
|----|------|---------|---------|------|
| AC-1 | WHEN key allows registry='wasiai', step resolves to wasiai → HTTP 200 | T-SCOPE-1 | `src/services/compose.test.ts` | service-unit |
| AC-2 | WHEN key allows registry='wasiai', step resolves to other → HTTP 403 SCOPE_DENIED, abort pipeline | T-SCOPE-2 + T-ROUTE-1 | `compose.test.ts` + `routes/compose.test.ts` | service + integration |
| AC-3 | WHEN key allows slug='X', step resolves to slug='Y' → HTTP 403 SCOPE_DENIED | T-SCOPE-3 | `compose.test.ts` | service-unit |
| AC-4 | WHEN key allows category='defi', agent.metadata.category!='defi' → HTTP 403 SCOPE_DENIED | T-SCOPE-4 + T-ROUTE-2 | `compose.test.ts` + `routes/orchestrate.test.ts` | service + integration |
| AC-5 | WHEN allowed_*=null → request pasa sin verificación de scope (backward-compat) | T-SCOPE-5 + T-SCOPE-9 | `compose.test.ts` | service-unit |
| AC-6 | WHEN scoping check ejecuta → usa `agent.registry`, `agent.slug`, `agent.metadata.category` post-`resolveAgent` (NO `step.registry` raw) | T-SCOPE-6 | `compose.test.ts` | service-unit |
| AC-7 | IF step N falla scope → pipeline aborta antes de step N+1, no se invoca | T-SCOPE-7 | `compose.test.ts` | service-unit (multi-step) |
| AC-8 | WHEN middleware ejecuta para A2A key → NO llama `checkScoping` (línea 152 borrada) | REGRESSION-WKH-61 | `middleware/a2a-key.test.ts` | middleware-unit |
| Corner | keyRow allows category='defi', agent SIN metadata.category → SCOPE_DENIED | T-SCOPE-8 | `compose.test.ts` | service-unit |

---

## §4 — Waves W0..W4 (orden obligatorio)

### W0 — Test de regresión (PRE-FIX, valida el bug)

**Serial. Bloquea W1.** No paraleliza con nada.

**Objetivo**: confirmar que pre-fix una key con `allowed_registries=['wasiai']`
recibe 403 hoy en `/test` (cualquier ruta usando el middleware), y dejar
la expectativa **POST-FIX** (200) para que el test pase tras W1.

**Acciones**:
1. Editar el test existente `AC-3: SCOPE_DENIED — registry not in allowed list`
   en `src/middleware/a2a-key.test.ts:283-297`:
   - Cambiar el nombre a: `REGRESSION-WKH-61: key with allowed_registries no longer 403s at middleware level`.
   - Cambiar `expect(response.statusCode).toBe(403)` → `expect(response.statusCode).toBe(200)`.
   - Borrar la línea `expect(response.json().error_code).toBe('SCOPE_DENIED')`.
   - Agregar comentario: `// WKH-61 fix: middleware ya no chequea scope; eso vive en composeService post-resolve.`
2. Verificar que `mockDebit.mockResolvedValue({ success: true })` está mockeado en el `beforeEach` o en el test (revisar el setup del describe).

**Done de W0**:
- Test modificado.
- Correr `npm test src/middleware/a2a-key.test.ts` — debe FALLAR ahora (porque el código del middleware sigue retornando 403). El fallo CONFIRMA el bug.
- **NO commitear todavía** — esperá W1.

---

### W1 — Borrar el check del middleware

**Serial. Habilita que W0 pase.** Paralelizable con W2/W3 una vez iniciado.

**Acciones**:
1. En `src/middleware/a2a-key.ts`:
   - Borrar el bloque líneas 151-159 (las 9 líneas del comentario `// 5. Check scoping via authzService` + el `if`).
   - Borrar el import de la línea 15: `import { authzService } from '../services/authz.js';`.
   - Renumerar comentarios de pasos: `// 6. Check per_call_limit` → `// 5.`, `// 7. Optimistic debit` → `// 6.`, `// 8. Augment request` → `// 7.`, `// 9. Set remaining budget header` → `// 8.`.
2. Correr `grep -n 'authzService' src/middleware/a2a-key.ts` → debe retornar **0 matches**.
3. Correr `npm test src/middleware/a2a-key.test.ts` → debe pasar verde (W0 ahora cumple su expectativa POST-FIX).
4. Correr `npm run typecheck` → clean (no debe haber `unused variable` ni errores).

**Done de W1**:
- 0 matches de `authzService` en `a2a-key.ts`.
- Test W0 (regression) verde.
- Tests del middleware todos verdes.
- TS strict clean.

---

### W2 — Mover el check a `composeService.compose`

**Paralelizable con W3** (una vez W1 mergeado en branch).

**Acciones**:

**W2.a — Tipos (`src/types/index.ts`)**:

1. Confirmar que `A2AAgentKeyRow` está re-exportado (revisar línea ~631; según SDD ya existe). Si no, agregar el re-export:
   ```ts
   export type { A2AAgentKeyRow } from './a2a-key.js';
   ```
2. Extender `ComposeRequest` (líneas 155-161):
   ```ts
   export interface ComposeRequest {
     steps: ComposeStep[];
     maxBudget?: number;
     a2aKey?: string;
     /** WKH-61: row de la a2a_agent_keys del caller, para scoping post-resolve. */
     scopingKeyRow?: A2AAgentKeyRow;
   }
   ```
3. Extender `ComposeResult` (líneas 163-170):
   ```ts
   export interface ComposeResult {
     success: boolean;
     output: unknown;
     steps: StepResult[];
     totalCostUsdc: number;
     totalLatencyMs: number;
     error?: string;
     /** WKH-61: discriminator para que el route handler mapee a 403. */
     errorCode?: 'SCOPE_DENIED';
     /** WKH-61: target denegado, para debugging. */
     scopeDeniedTarget?: { registry: string; agent_slug: string; category?: string };
   }
   ```

**W2.b — Service (`src/services/compose.ts`)**:

1. Agregar imports al top del archivo (junto a los existentes):
   ```ts
   import { authzService } from './authz.js';
   import type { AuthzTarget } from '../types/index.js';
   ```
   Nota: `AuthzTarget` está definido en `src/types/a2a-key.ts:52-57` y debería estar re-exportado desde `index.ts`. Si no lo está, importarlo directamente desde `'../types/a2a-key.js'`.

2. Definir helper privado **a nivel de módulo** (NO en el objeto `composeService`), siguiendo el patrón de `buildAuthHeaders` (líneas 28-42):
   ```ts
   /**
    * WKH-61: lee category del Agent.metadata con type-guard.
    * Retorna `undefined` si metadata.category no es un string (registries que no exponen category).
    */
   function readCategory(agent: Agent): string | undefined {
     const meta = agent.metadata as Record<string, unknown> | undefined;
     const cat = meta?.category;
     return typeof cat === 'string' ? cat : undefined;
   }
   ```

3. En `composeService.compose(request)`:
   - Línea 46: agregar `scopingKeyRow` al destructure: `const { steps, maxBudget, a2aKey, scopingKeyRow } = request;`
   - DESPUÉS del null-check del agente (línea 62, después del primer `return` del "Agent not found") y ANTES del budget-check (línea 63), agregar el bloque:
     ```ts
     // WKH-61: scoping check post-resolve, pre-invoke. Skip si caller es x402 (sin keyRow).
     if (scopingKeyRow) {
       const target: AuthzTarget = {
         registry: agent.registry,
         agent_slug: agent.slug,
         category: readCategory(agent),
       };
       const scope = authzService.checkScoping(scopingKeyRow, target);
       if (!scope.allowed) {
         return {
           success: false,
           output: null,
           steps: results,
           totalCostUsdc: totalCost,
           totalLatencyMs: totalLatency,
           error: `Step ${i} denied by scope: ${scope.reason ?? 'SCOPE_DENIED'}`,
           errorCode: 'SCOPE_DENIED',
           scopeDeniedTarget: {
             registry: agent.registry,
             agent_slug: agent.slug,
             ...(target.category !== undefined && { category: target.category }),
           },
         };
       }
     }
     ```

**W2.c — Route (`src/routes/compose.ts`)**:

1. En el handler (línea 59-62), pasar el row:
   ```ts
   const result = await composeService.compose({
     steps: body.steps,
     maxBudget: body.maxBudget,
     scopingKeyRow: request.a2aKeyRow,
   });
   ```
2. Reemplazar el bloque `if (!result.success)` (líneas 67-72) por:
   ```ts
   if (!result.success) {
     const status = result.errorCode === 'SCOPE_DENIED' ? 403 : 400;
     return reply.status(status).send({
       ...result,
       requestId: request.id,
     });
   }
   ```

**W2.d — Tests service (`src/services/compose.test.ts`)**:

Agregar un nuevo `describe` block al final del archivo. Patrón: usar `vi.spyOn` cuando sea posible (CD-11). Si necesitás `vi.mock` adicional, aislalo en este describe con `beforeEach`/`afterEach` que resetean.

```ts
describe('composeService.compose — WKH-61 scoping per step', () => {
  // ... helpers para construir keyRow con scoping
});
```

Tests obligatorios (los 9):

- **T-SCOPE-1 (AC-1)**: keyRow `allowed_registries=['wasiai']`, step resuelve `agent.registry='wasiai'` → `result.success === true`.
- **T-SCOPE-2 (AC-2)**: keyRow `allowed_registries=['wasiai']`, step resuelve `agent.registry='other'` → `result.success === false`, `result.errorCode === 'SCOPE_DENIED'`, `result.scopeDeniedTarget.registry === 'other'`. **`mockFetch` count debe ser 0** (no se invocó al agente). Patrón: `expect(mockFetch).not.toHaveBeenCalled()`.
- **T-SCOPE-3 (AC-3)**: keyRow `allowed_agent_slugs=['allowed-slug']`, agent.slug=`'other-slug'` → `errorCode === 'SCOPE_DENIED'`, `scopeDeniedTarget.agent_slug === 'other-slug'`.
- **T-SCOPE-4 (AC-4)**: keyRow `allowed_categories=['defi']`, `agent.metadata.category='social'` → `errorCode === 'SCOPE_DENIED'`, `scopeDeniedTarget.category === 'social'`.
- **T-SCOPE-5 (AC-5)**: keyRow con `allowed_registries=null, allowed_agent_slugs=null, allowed_categories=null` → success path normal, **sin** `errorCode`.
- **T-SCOPE-6 (AC-6)**: el step pide `agent='X'` con `registry: 'wasiai'`, pero `discoveryService.getAgent` retorna `Agent` con `registry='other'` (simulando fallback de registry). keyRow `allowed_registries=['wasiai']` → `errorCode === 'SCOPE_DENIED'` (porque el check evalúa contra el `agent.registry` real, no el field del step).
- **T-SCOPE-7 (AC-7)**: pipeline 3 steps. Step 0 OK, step 1 falla scope, step 2 NUNCA se invoca. Verificar: `result.steps.length === 1`, `result.errorCode === 'SCOPE_DENIED'`, `mockFetch.mock.calls.length === 1` (solo step 0). Plantilla análoga al T-7 budget rejection (`compose.test.ts:236-279`).
- **T-SCOPE-8 (corner)**: keyRow `allowed_categories=['defi']`, agent SIN `metadata.category` (e.g. `metadata: {}`) → `errorCode === 'SCOPE_DENIED'`. Verifica que `readCategory` retorna `undefined` y `authzService` lo deniega correctamente. **CD-8: NO usar `agent.capabilities[0]` como proxy.**
- **T-SCOPE-9 (CD-13, AC-5 path x402)**: `compose({ steps, maxBudget, scopingKeyRow: undefined })` → check NO se ejecuta, el agente se invoca normalmente, `result.success === true` aunque la key tuviera scoping (no se pasa, no se chequea).

Mock setup mínimo para los tests (aprovechar el setup existente del archivo):
- `vi.mocked(discoveryService.getAgent).mockResolvedValue(makeAgent({...}))`.
- `mockFetchOk({ result: '...' })` para los happy paths.
- Helper local `makeKeyRow(overrides): A2AAgentKeyRow` — copiar el helper de `middleware/a2a-key.test.ts:87-111` (NO importarlo cross-file).

**Done de W2**:
- AC-1, AC-2, AC-3, AC-4, AC-6, AC-7, corner T-SCOPE-8, T-SCOPE-9 (path x402) verdes.
- `npm run typecheck` clean.
- `npm test src/services/compose.test.ts` verde — 9 tests nuevos + tests T-1..T-9 baseline pasan.

---

### W3 — Propagar `scopingKeyRow` en orchestrate

**Paralelizable con W2.d** (depende de tipos de W2.a).

**Acciones**:

**W3.a — Tipos (`src/types/index.ts`)**:

Extender `OrchestrateRequest` (líneas 252-263):
```ts
export interface OrchestrateRequest {
  goal: string;
  budget: number;
  preferCapabilities?: string[];
  maxAgents?: number;
  a2aKey?: string;
  /** WKH-61: row de a2a_agent_keys, propagado a composeService.compose. */
  scopingKeyRow?: A2AAgentKeyRow;
}
```

**W3.b — Service (`src/services/orchestrate.ts`)**:

En la línea 403-407 (la llamada a `composeService.compose`):
```ts
const pipeline = await composeService.compose({
  steps,
  maxBudget: budget - feeUsdc,
  a2aKey: request.a2aKey,
  scopingKeyRow: request.scopingKeyRow,
});
```

**W3.c — Route (`src/routes/orchestrate.ts`)**:

1. En la llamada a `orchestrateService.orchestrate` (líneas 67-75), pasar:
   ```ts
   const result = await orchestrateService.orchestrate(
     {
       goal: body.goal.trim(),
       budget: body.budget,
       preferCapabilities: body.preferCapabilities,
       maxAgents: body.maxAgents,
       scopingKeyRow: request.a2aKeyRow,
     },
     orchestrationId,
   );
   ```
2. Reemplazar `return reply.send({ kiteTxHash, ...result })` (línea 81) por:
   ```ts
   const status = result.pipeline.errorCode === 'SCOPE_DENIED' ? 403 : 200;
   const kiteTxHash = request.paymentTxHash;
   return reply.status(status).send({ kiteTxHash, ...result });
   ```

**Done de W3**:
- TS strict clean.
- AC-4 path orchestrate verde en W4.

---

### W4 — Tests integration de routes

**Serial DESPUÉS de W2 + W3** (depende de los tipos extendidos y los handlers actualizados).

**Acciones**:

**W4.a — `src/routes/compose.test.ts` (NUEVO archivo)**:

Patrón base: copiar el header de `src/routes/tasks.test.ts:1-56` (mock pass-through del middleware que setea `request.a2aKeyRow`).

Mocks obligatorios:
- `vi.mock('../middleware/a2a-key.js', ...)` con un pass-through que setea `a2aKeyRow` configurable por test.
- `vi.mock('../services/compose.js')` para retornar respuestas controladas.
- `vi.mock('../middleware/timeout.js')` y `vi.mock('../middleware/rate-limit.js')` con pass-throughs.

Tests obligatorios:

- **T-ROUTE-1 (AC-2 end-to-end)**: POST /compose con header `x-a2a-key`, mock setea `a2aKeyRow={ allowed_registries: ['x'] }`, mock de `composeService.compose` retorna `{ success: false, errorCode: 'SCOPE_DENIED', scopeDeniedTarget: {...}, ... }` → response `statusCode === 403`, body contiene `errorCode: 'SCOPE_DENIED'` y `requestId`.
- **T-ROUTE-1b (regresión)**: POST /compose con `composeService.compose` retornando `{ success: false, error: 'Budget exceeded' }` (sin `errorCode`) → response `statusCode === 400` (preserva el comportamiento existente).
- **T-ROUTE-1c (happy path)**: POST /compose con success → response 200 con `kiteTxHash`.

**W4.b — `src/routes/orchestrate.test.ts` (NUEVO archivo)**:

Mismo patrón que W4.a.

Tests obligatorios:

- **T-ROUTE-2 (AC-4 end-to-end)**: POST /orchestrate, mock de `orchestrateService.orchestrate` retorna `{ pipeline: { errorCode: 'SCOPE_DENIED', ... }, ... }` → response `statusCode === 403`.
- **T-ROUTE-2b (regresión)**: POST /orchestrate, success path → 200 (preserva legacy behavior cuando no hay errorCode).

**Done de W4**:
- 2 archivos nuevos creados.
- ≥3 tests en `routes/compose.test.ts` (1 SCOPE + 1 budget regresión + 1 happy).
- ≥2 tests en `routes/orchestrate.test.ts` (1 SCOPE + 1 happy).
- `npm test` retorna **518 baseline + 12 nuevos − 0 rotos = ~530 verdes**.

---

## §5 — Anti-Hallucination Checklist (verificá ANTES de codear)

- [ ] **Línea 152 de `src/middleware/a2a-key.ts`** existe y contiene exactamente `const scopingResult = authzService.checkScoping(keyRow, {});` (verificá con `Read`).
- [ ] **`authzService.checkScoping(keyRow, target): AuthzResult`** firma confirmada en `src/services/authz.ts:21`. **NO modificar la lógica core de authz.ts (CD-6).**
- [ ] **`AuthzTarget`** tipo confirmado en `src/types/a2a-key.ts:52-57` con campos `registry?, agent_slug?, category?, estimated_cost_usd?`.
- [ ] **`A2AAgentKeyRow`** está definido en `src/types/a2a-key.ts` y re-exportado por `src/types/index.ts` (verificá línea ~631 antes de importar — si NO está re-exportado, agregá el re-export, NO importes directamente del archivo `a2a-key.ts` desde producción salvo que el patrón ya exista).
- [ ] **`Agent.metadata`** es `Record<string, unknown> | undefined`. NO existe campo `Agent.category` top-level.
- [ ] **`agent.metadata.category`** se usa con type-guard como en `src/services/compose.ts:253-263` (patrón `payTo` exemplar). **CD-8: PROHIBIDO usar `agent.capabilities[0]` como proxy de category.**
- [ ] **`composeService.compose` resolveAgent** está en `src/services/compose.ts:53`. El null-check sigue líneas 54-62. El budget-check sigue líneas 63-71. El scoping check va **entre** ambos.
- [ ] **`orchestrateService` llama `composeService.compose` en la línea 403** — NO llama `resolveAgent` directamente. El fix en compose cubre el path orchestrate por delegación (DT-4).
- [ ] **`request.a2aKeyRow`** está populado por el middleware en `src/middleware/a2a-key.ts:193`. Disponible en route handlers post-`requirePaymentOrA2AKey`. Patrón de uso: `src/routes/tasks.ts:32` (`request.a2aKeyRow?.owner_ref`).
- [ ] **`src/routes/compose.test.ts` y `src/routes/orchestrate.test.ts` NO existen hoy** (verificá con `ls src/routes/`). W4 los crea.
- [ ] **`vi.spyOn` preferido sobre `vi.mock`** (CD-11, AB-WKH-57): si tu nuevo describe rompe mocks de tests existentes en `compose.test.ts`, aislá con `beforeEach(() => vi.resetModules())` o usá `vi.spyOn` localmente.
- [ ] **NO toques mocks de Supabase** en `compose.test.ts` (CD-12, AB-WKH-57-W2): el fix no toca DB ni `kite_schema_transforms`. Si rompés un mock de `.eq()` chain, retrocedé.
- [ ] **NO modificar `src/services/authz.ts`** lógica funcional. Solo se permite agregar JSDoc o tipo más estricto en la firma (no requerido para esta HU; preferí cero cambios al archivo).
- [ ] **NO modificar `a2a_agent_keys` schema en DB** (CD-3 / CD-4 work-item).
- [ ] **NO hardcodear** valores de registry, slug, category en producción (CD-5 work-item). En tests, hardcodear valores literales `'wasiai'`, `'defi'` está OK porque son fixtures.

---

## §6 — Constraint Directives heredados (resumen)

| CD | Origen | Regla |
|----|--------|-------|
| CD-1 | work-item + SDD | TS strict, sin `any` explícito. Nuevos campos opcionales tipados con `A2AAgentKeyRow`. |
| CD-2 | work-item + SDD | Backward-compat: keys con `allowed_*=null` o callers x402 (sin `scopingKeyRow`) NO ejecutan el check. |
| CD-3 | work-item | Error 403 con `{ errorCode: 'SCOPE_DENIED', scopeDeniedTarget: {...} }` para debugging. |
| CD-4 | work-item | NO modificar shape de `a2a_agent_keys` ni schema DB. |
| CD-5 | work-item | NO hardcodear registry/slug/category en producción. |
| CD-6 | work-item + SDD | NO modificar lógica core de `authz.ts`. |
| CD-7 | work-item | Baseline 518 tests verde. Tests existentes solo se modifican con justificación documentada (W0/W1: el test SCOPE_DENIED del middleware). |
| CD-8 | SDD | PROHIBIDO usar `agent.capabilities[0]` como proxy de category. Solo `agent.metadata.category` con type-guard. |
| CD-9 | SDD | PROHIBIDO reintroducir `checkScoping` en el middleware. Línea 152 borrada para siempre. |
| CD-10 | SDD | El check ejecuta UNA VEZ por step, post-resolve, pre-invoke. NUNCA dentro de `invokeAgent`. |
| CD-11 | SDD anti-AB-WKH-57 | Preferir `vi.spyOn` sobre `vi.mock` para evitar contaminación entre tests. Si requerís `vi.mock` module-level, aislá en `describe` dedicado. |
| CD-12 | SDD anti-AB-WKH-57-W2 | NO romper mock chains de Supabase con `.eq()` count exacto. El fix no toca Supabase. |
| CD-13 | SDD | El check NO se ejecuta para callers x402 (`scopingKeyRow === undefined` → skip). Path x402 100% intacto. |

---

## §7 — Exemplars verificados (file:line)

| Patrón | Archivo:líneas | Uso en este story |
|--------|---------------|-------------------|
| Type-guard sobre `agent.metadata` (`payTo` fallback) | `src/services/compose.ts:253-263` | Plantilla 1:1 para `readCategory(agent)` en W2.b. |
| Early return con `ComposeResult` shape | `src/services/compose.ts:54-62` (Agent not found) y `:63-71` (Budget exceeded) | Plantilla del return-on-scope-deny en W2.b. |
| Helper privado a nivel módulo | `src/services/compose.ts:28-42` (`buildAuthHeaders`) | Plantilla para `readCategory` (NO meterlo en `composeService` object). |
| Caller pasa row, service confía | `src/services/budget.ts:19-41` (`getBalance(keyId, chainId, ownerId)`) | Mismo pattern: `compose` recibe `scopingKeyRow` por arg. |
| Campo opcional en request type | `src/types/index.ts:159-160` (`a2aKey?: string`) | Plantilla para `scopingKeyRow?: A2AAgentKeyRow` (W2.a, W3.a). |
| Route handler usa `request.a2aKeyRow` | `src/routes/tasks.ts:31-37` (helper `getOwnerRef`) | Plantilla para leer el row en `routes/compose.ts` y `routes/orchestrate.ts`. |
| Mock pass-through de middleware en tests | `src/routes/tasks.test.ts:19-31` | Plantilla para `routes/compose.test.ts` y `routes/orchestrate.test.ts` en W4. |
| Multi-step abort + count fetch | `src/services/compose.test.ts:236-279` (T-7 budget rejection) | Plantilla para T-SCOPE-7 (verifica `mockFetch.mock.calls.length`). |
| 403 shape en route handler | `src/middleware/a2a-key.ts:39-45` (`send403`) | Inspiración para el `errorCode` mapping en `routes/compose.ts` y `routes/orchestrate.ts`. |
| Test existente a modificar | `src/middleware/a2a-key.test.ts:283-297` (`AC-3: SCOPE_DENIED`) | W0: cambiar expectativa 403 → 200 y renombrar. |

Todos verificados con `Read` en el SDD §1 (Context Map).

---

## §8 — Pre-Implementation Checklist (correr ANTES de la wave 0)

```bash
# 1. Confirmá que estás en la branch correcta
git checkout feat/059-wkh-61-sec-scope-1

# 2. Baseline verde antes de tocar nada
npm test 2>&1 | tail -20
# → debe mostrar ~518 passed (post-WKH-62)

# 3. Verificá los exemplars referenciados
grep -n 'authzService.checkScoping(keyRow, {})' src/middleware/a2a-key.ts
# → debe match en línea 152

grep -n 'agent.metadata as Record<string, unknown>' src/services/compose.ts
# → debe match en línea 253

# 4. Verificá que routes/compose.test.ts y routes/orchestrate.test.ts NO existen
ls src/routes/compose.test.ts src/routes/orchestrate.test.ts 2>&1
# → debe retornar "No such file or directory" para ambos

# 5. Confirmá que A2AAgentKeyRow está re-exportado desde types/index.ts
grep -n "A2AAgentKeyRow" src/types/index.ts
# → debe haber al menos un re-export. Si no, planeá agregarlo en W2.a.

# 6. Tipo Agent en types/index.ts
grep -n "interface Agent" src/types/index.ts
# → confirmá que Agent.metadata es `Record<string, unknown> | undefined`
```

Si cualquier paso falla → **NO empieces a codear**. Reportá al orquestador.

---

## §9 — Done Definition (cuándo terminó tu trabajo)

- [ ] **W0**: test existente `AC-3 SCOPE_DENIED` modificado a expectativa POST-FIX. Falla pre-W1, pasa post-W1.
- [ ] **W1**: `grep -n 'authzService' src/middleware/a2a-key.ts` retorna 0. Tests del middleware verdes.
- [ ] **W2**: `composeService.compose` ejecuta scoping check post-`resolveAgent` cuando `scopingKeyRow` está presente. 9 tests nuevos en `compose.test.ts` verdes (T-SCOPE-1..9).
- [ ] **W3**: `orchestrateService` y `routes/orchestrate.ts` propagan `scopingKeyRow`. Mapeo 403 cuando `errorCode === 'SCOPE_DENIED'`.
- [ ] **W4**: 2 archivos nuevos `routes/compose.test.ts` y `routes/orchestrate.test.ts` con ≥3 + ≥2 tests respectivamente.
- [ ] **TS strict clean**: `npm run typecheck` (o `tsc --noEmit`) sin errores.
- [ ] **Lint clean**: `npm run lint` (Biome) sin warnings nuevos.
- [ ] **Baseline preservado**: `npm test` retorna **~530 verdes (518 baseline + 12 nuevos)**, **0 rotos**.
- [ ] **Coverage de ACs**: AC-1..AC-8 todos con test asignado y verde (ver tabla §3).
- [ ] **Auto-Blindaje**: si encontrás un error nuevo durante la implementación (mock chain roto, edge case no previsto, drift de tipo), documentalo en `doc/sdd/059-wkh-61-sec-scope-1/auto-blindaje.md` con formato `[YYYY-MM-DD WN] título` + Error/Causa/Fix/Aplicar-en. **Mandatorio si hay ≥1 issue durante F3.**
- [ ] **NO commitear** hasta que todos los anteriores estén verdes. AR/CR/QA del pipeline NexusAgil decidirán el merge.

---

## §10 — Notas para el Dev (gotchas conocidas y tips)

### Orden de chequeos en `composeService.compose`

El loop `for i in steps` debe ejecutar:
1. `resolveAgent(step)` (línea 53).
2. Null-check del agente (líneas 54-62) — early return si no se encuentra.
3. **NUEVO** — Scoping check si `scopingKeyRow` está presente — early return con `errorCode: 'SCOPE_DENIED'`.
4. Budget check (líneas 63-71) — early return si excede maxBudget.
5. `invokeAgent` (línea 78).

**Razón del orden**: scoping ANTES de budget. Si la key no puede llamar al agente por scope, no tiene sentido evaluar costo. Y NUNCA ejecutar `invokeAgent` si scope deniega (AC-7).

### Mapeo de `errorCode` a HTTP status

Solo agregamos `errorCode` para `'SCOPE_DENIED'` (literal type union, NO string). El route handler hace:
```ts
const status = result.errorCode === 'SCOPE_DENIED' ? 403 : 400;
```
Esto preserva el comportamiento legacy (`success: false` sin `errorCode` → 400) y SOLO escala a 403 para scope. Si en el futuro queremos otros codes, extendemos la union (`'SCOPE_DENIED' | 'OTHER'`).

### `scopeDeniedTarget` opcional en el shape

El campo `category` se omite cuando es `undefined` para que el JSON sea limpio:
```ts
scopeDeniedTarget: {
  registry: agent.registry,
  agent_slug: agent.slug,
  ...(target.category !== undefined && { category: target.category }),
}
```
NO uses `category: target.category` directo — eso emitiría `"category": undefined` que algunos JSON serializers manejan distinto.

### Path x402 (CD-13)

Cuando un caller paga vía x402 sin A2A key, el middleware NO setea `request.a2aKeyRow`. El route handler lee `request.a2aKeyRow` (que será `undefined`) y lo pasa al compose. En el service, `if (scopingKeyRow)` es `false` → check skip. **Backward-compat 100%**.

### Test T-SCOPE-7 — multi-step abort

Patrón para verificar que step N+1 NO se invocó:
```ts
expect(result.steps.length).toBe(1);          // solo step 0
expect(mockFetch.mock.calls.length).toBe(1);  // solo 1 llamada HTTP
expect(result.errorCode).toBe('SCOPE_DENIED');
```
Si `mockFetch` se llamó 2 veces, el abort no funcionó.

### Avoid AB-WKH-57 traps

- Si tu nuevo describe en `compose.test.ts` necesita mockear módulos diferentes (e.g. `authz.js`), considerá `vi.spyOn(authzService, 'checkScoping')` en lugar de `vi.mock('../services/authz.js')`. Esto NO contamina los tests T-1..T-9 ya verdes.
- Si necesitás resetear mocks entre tests, usá `beforeEach(() => { vi.clearAllMocks(); /* re-apply default mocks */ })` y NO `vi.resetModules()` — el último te re-importa todo y rompe los `vi.mocked(...)` cacheados al top.

### Si encontrás un test inesperadamente roto

1. Confirmá si es genuino (regresión) o es un edge case del mock setup (e.g. count de `.eq()` chain).
2. Si es genuino → debug y fix en tu wave.
3. Si es mock setup → ajustar el mock SIN cambiar la lógica de producción.
4. Si no podés decidir en 15min → registrá en auto-blindaje y escalá al orquestador. **NO comitees con tests rotos.**

### Out-of-scope reminders (NO los toques)

- TD-WKH-61-1: `routes/compose.ts:59-62` no propaga `a2aKey` (header) al body de compose. Esto afecta downstream payment, NO scoping. **Issue separado.**
- TD-WKH-61-2: orchestrate hoy retorna 200 incluso con `pipeline.success === false` para errores que NO son SCOPE_DENIED. La limpieza completa queda fuera de scope. Solo agregamos el branch específico para SCOPE_DENIED → 403.

---

**Story File listo. Branch: `feat/059-wkh-61-sec-scope-1`. Adelante con W0.**
