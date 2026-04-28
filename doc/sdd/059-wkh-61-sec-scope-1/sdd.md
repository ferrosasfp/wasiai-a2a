# SDD — WKH-61 / SEC-SCOPE-1

> Spec Driven Document para `requirePaymentOrA2AKey` — fix de scoping con target vacío.
>
> Input: `doc/sdd/059-wkh-61-sec-scope-1/work-item.md` (HU_APPROVED).
> Output esperado: parche que mueve `authzService.checkScoping` del middleware al loop por step de `composeService.compose`, dejando el flujo orchestrate cubierto por delegación.

---

## 1. Context Map (Codebase Grounding)

Archivos leídos para extraer patrones reales (no inventados):

| Archivo | Líneas | Por qué se leyó | Patrón extraído |
|---|---|---|---|
| `src/middleware/a2a-key.ts` | 1-218 | Sitio del bug — `checkScoping({})` línea 152. | Augmenta `request.a2aKeyRow` (línea 193). El middleware es el ÚNICO sitio donde `keyRow` está disponible en su forma completa antes de los services. Errores 403 retornan `{ error, error_code }` shape (líneas 39-45). Codes existentes: `KEY_NOT_FOUND`, `KEY_INACTIVE`, `DAILY_LIMIT`, `INSUFFICIENT_BUDGET`, `SCOPE_DENIED`, `PER_CALL_LIMIT`. |
| `src/services/authz.ts` | 1-78 | Función pura objetivo. | API: `checkScoping(keyRow, target): AuthzResult` con `target: AuthzTarget`. Valida `allowed_registries`, `allowed_agent_slugs`, `allowed_categories` y `max_spend_per_call_usd`. Retorna `{ allowed: false, reason: string }` con prefijo `SCOPE_DENIED:`. **No tocar la lógica core (CD-5).** |
| `src/services/compose.ts` | 1-314 | Sitio donde se hará el fix W2. | Loop `for i in steps` (línea 51), `resolveAgent` línea 53, falla con `Agent not found` línea 60. `invokeAgent` línea 78. `agent.metadata` se lee como `Record<string, unknown> \| undefined` (líneas 253-258). Existe pattern `payTo` que ya escribe defensivo: `const meta = agent.metadata as Record<string, unknown> \| undefined`. Esto es exemplar para construir el target. |
| `src/services/orchestrate.ts` | 1-471 | Verificar que no llama `resolveAgent` directo. | Confirma DT-4 del work-item: `orchestrate` arma `steps[]` y delega TODO a `composeService.compose({ steps, maxBudget, a2aKey })` (línea 403). `a2aKey` (string del header) ya se propaga; **el row completo (`a2aKeyRow`) NO se propaga hoy**. |
| `src/types/index.ts` | 100-263 | Confirma forma de `Agent`, `ComposeRequest`, `OrchestrateRequest`. | `Agent.metadata?: Record<string, unknown>`. `ComposeRequest = { steps, maxBudget?, a2aKey? }`. `OrchestrateRequest` tiene `a2aKey?: string` (línea 263) pero NO el row. |
| `src/types/a2a-key.ts` | 1-110 | `AuthzTarget`, `A2AAgentKeyRow`. | `AuthzTarget = { registry?, agent_slug?, category?, estimated_cost_usd? }`. `A2AAgentKeyRow.allowed_categories: string[] \| null`. |
| `src/services/discovery.ts` | 1-376 | Verificar mapping de category — DT-3 abierto. | **`mapAgent` NO setea `category` en el objeto Agent**. Setea `metadata: raw` (línea 251), preservando el raw del registry tal-cual. Por lo tanto `agent.metadata.category` solo existe si el registry upstream lo expone con esa clave. wasiai-v2 (canonical) lo expone; otros marketplaces pueden no exponerlo. |
| `src/routes/compose.ts` | 1-80 | Cómo el handler arma `ComposeRequest`. | El handler **NO** propaga hoy `request.a2aKeyRow` a `composeService.compose`. Tampoco propaga `a2aKey`. Esto es un gap menor del path actual (fuera del bug pero relacionado: hoy `compose.compose({ steps, maxBudget })` se llama sin keyRow ni keyHeader). |
| `src/routes/orchestrate.ts` | 1-99 | Idem para orchestrate. | El handler **NO** propaga `request.a2aKeyRow`. Sí propaga `a2aKey: undefined` (no existe en el body). |
| `src/services/budget.ts` | 1-86 | Exemplar de check post-resolve con `ownerId`. | Pattern: el caller pasa `ownerId` como argumento explícito; el service confía. Aplicable para nuestro `keyRow`: caller (route handler) pasa el row, el service lo recibe y consume. |
| `src/services/authz.test.ts` | 1-178 | Tests existentes a no romper. | 16 tests cubren registry/slug/category/cost. **El test "denies when allowed_registries set but target has no registry"** (líneas 75-82) confirma que pasar `{}` como target deniega — eso es el comportamiento que el bug aprovecha. Esos tests siguen verdes (no tocamos `authz.ts`). |
| `src/middleware/a2a-key.test.ts` | 1-150 | Patrón de mocking del middleware. | Mocks: `identityService.lookupByHash`, `budgetService.{getBalance,debit}`, `getPaymentAdapter`, `getChainConfig`. Helper `makeKeyRow` con todos los campos. **Importante**: hoy hay tests que verifican el flow completo del middleware (incluyendo el paso "5. checkScoping"). Esos tests **deben actualizarse** para no esperar 403 SCOPE_DENIED desde el middleware. |
| `src/services/compose.test.ts` | 1-823 | Patrón de mock para tests de compose. | Mocks `discoveryService.getAgent`, `registryService.getEnabled`, `getPaymentAdapter`, `signAndSettleDownstream`. Helper `makeAgent` (líneas 48-64) con `metadata: {}` por defecto. AB-WKH-57-WAS-V2-3-CLIENT-1 advierte: preferir `vi.spyOn` sobre `vi.mock` para evitar contaminación entre tests. |

---

## 2. Decisiones técnicas (DT)

### DT-1 — Mecanismo de propagación del `keyRow`

**Decisión**: Extender `ComposeRequest` con campo opcional `scopingKeyRow?: A2AAgentKeyRow`. Los route handlers de `/compose` y `/orchestrate` pasan `request.a2aKeyRow` ahí. `OrchestrateRequest` se extiende análogamente.

**Justificación**:
- El work-item lo recomienda explícitamente (DT-1).
- Mantiene la backward-compat: callers existentes que no pasen el campo siguen funcionando (el check se omite — coincide con AC-5: keys sin scoping pasan).
- Evita inyección global o un singleton en el service (sin shared state, sin `AsyncLocalStorage`).
- Coincide con el patrón ya usado para `a2aKey?: string` en `ComposeRequest` (línea 161 de `types/index.ts`): campo opcional en el request, propagado por el handler.

**Alternativas descartadas**:
- Refactor de `composeService` a clase con `keyRow` en constructor: scope creep, romperia 480 baseline tests. NO.
- `AsyncLocalStorage` para "ambient" keyRow: agrega complejidad de runtime y no se usa hoy en otros lados del codebase. NO.

### DT-2 — Timing del check dentro del loop

**Decisión**: el check se ejecuta inmediatamente DESPUÉS de `this.resolveAgent(step)` y ANTES de `this.invokeAgent(...)` (entre líneas 53 y 78 actuales de `compose.ts`).

**Justificación**:
- Si el agente no fue encontrado, el error existente "Agent not found" tiene precedencia (AC-2: `agent === null` → return early antes del scoping check, no se invoca `invokeAgent`).
- Si el agente fue resuelto pero scoping falla, abort inmediato (AC-7) y NUNCA se llama `invokeAgent` para ese step ni para los siguientes.
- El budget check `maxBudget && totalCost + agent.priceUsdc > maxBudget` (líneas 63-71) puede ejecutarse antes o después del scoping. **Decisión**: scoping primero. Razón: scoping es estructural (¿podés llamar a este agente?), budget es por costo. Si la key no puede llamar, no tiene sentido evaluar budget.

### DT-3 — Construcción de `AuthzTarget` desde `Agent` resuelto

**Decisión**: el target se construye con:
```text
target = {
  registry: agent.registry,           // siempre presente — Agent.registry: string
  agent_slug: agent.slug,             // siempre presente — Agent.slug: string
  category: readCategory(agent),      // helper interno, retorna string | undefined
  // estimated_cost_usd se OMITE: el middleware ya validó max_spend_per_call_usd
  // con el placeholder $1 (línea 116 a2a-key.ts). Re-validar acá daría falsos positivos
  // en pipelines multi-step donde el budget ya se chequeó vía maxBudget.
}
```

**`readCategory(agent)`**: helper privado en `compose.ts` (no exportado, pure). Lee `agent.metadata?.category` con un type-guard:
```text
function readCategory(agent: Agent): string | undefined {
  const meta = agent.metadata as Record<string, unknown> | undefined;
  const cat = meta?.category;
  return typeof cat === 'string' ? cat : undefined;
}
```

**Justificación de "category=metadata.category"**:
- `Agent` (en `types/index.ts`) **no tiene** un campo `category` top-level — solo `capabilities: string[]`.
- `discovery.ts:251` hace `metadata: raw`, lo cual preserva el campo `category` del response upstream cuando el registry lo expone.
- wasiai-v2 marketplace expone `category` en el agent card (verificado vía pattern del work-item; mismo pattern usado por `payTo` en `compose.ts:253-263`).
- **Trade-off explícito**: si un registry NO expone `category`, una key con `allowed_categories=['defi']` rechazará todos los agentes de ese registry. Esto **es correcto** — la key no debería poder invocar agentes sin categoría declarada cuando explícitamente filtra por categoría.
- **NO se usa `agent.capabilities[0]` como proxy** porque las capabilities son tags semánticos (e.g. `'price-feed'`, `'transformation'`) y mezclarlos con categorías rompería el contrato: una key con `allowed_categories=['defi']` no debería matchear un agente con `capabilities=['defi-trading']` por casualidad.

### DT-4 — `OrchestrateRequest.scopingKeyRow`

**Decisión**: extender `OrchestrateRequest` con `scopingKeyRow?: A2AAgentKeyRow`. El handler de `/orchestrate` lo pasa. `orchestrateService.orchestrate` lo propaga a `composeService.compose({ steps, maxBudget, a2aKey, scopingKeyRow })` (línea 403 de orchestrate.ts).

**Justificación**:
- El bug en orchestrate es transitivo: orchestrate llama compose, y compose hoy nunca recibe el row → check imposible.
- Propagar mantiene un único punto de verdad (el loop en `compose.ts`). No duplicamos el check en `orchestrate.ts`.
- Backward-compat: callers que no pasen `scopingKeyRow` siguen funcionando.

### DT-5 — Shape del 403 desde compose service

**Decisión**: `compose` no es un Fastify handler, retorna un `ComposeResult`. Cuando el scoping falla, retornamos:
```text
{
  success: false,
  output: null,
  steps: results,           // steps ya completados en el pipeline
  totalCostUsdc: totalCost,
  totalLatencyMs: totalLatency,
  error: `Step ${i} denied by scope: ${reason}`,
  errorCode: 'SCOPE_DENIED',
  scopeDeniedTarget: { registry, agent_slug: slug, category }
}
```

**Justificación**:
- `ComposeResult.error` ya existe (línea 169 types/index.ts) — string.
- Agregar `errorCode?: 'SCOPE_DENIED'` y `scopeDeniedTarget?: { registry, agent_slug, category }` como campos OPCIONALES en `ComposeResult` cumple AC-2 (debugging).
- En `routes/compose.ts:67-72`, el route handler ya hace `reply.status(400).send({ ...result, requestId })` cuando `!result.success`. Cambiamos a: si `result.errorCode === 'SCOPE_DENIED'` → `status(403)`. Caso default → `status(400)` (preserva el comportamiento actual).
- Análogo en `routes/orchestrate.ts`: hoy retorna `reply.send({ kiteTxHash, ...result })` siempre 200. Si `result.pipeline.errorCode === 'SCOPE_DENIED'` → ajustamos status. **Trade-off**: orchestrate hoy 200-siempre, AC-2 pide 403 ⇒ **rompemos esa convención SOLO para scope-denied** (decisión consciente; orchestrate puede retornar success:false hoy con 200, eso seguía siendo un comportamiento legacy aceptado pero el AC explícito de WKH-61 manda).

### DT-6 — `a2aKey` (string header) vs `scopingKeyRow` (DB row)

**Decisión**: son dos campos distintos. `a2aKey` queda como está (header propagado downstream para sub-agentes). `scopingKeyRow` es nuevo (lookup ya hecho por el middleware).

**Justificación**:
- `a2aKey` es un secret — el handler hoy NO lo extrae del request (ver gap más abajo). El middleware lo consumió y descartó.
- `scopingKeyRow` es metadata DB ya validada. Pasar el row es seguro y eficiente (zero extra DB call).
- **Gap pre-existente fuera de scope**: `routes/compose.ts:59-62` no pasa `a2aKey` a `composeService.compose`. Ese problema afecta downstream-payment, NO scoping. **No lo arreglamos en esta HU**: lo registramos en `Tech Debt` (sección 9) y abrimos issue separado.

---

## 3. Constraint Directives (CD)

Heredan los del work-item + nuevos por SDD:

- **CD-1** (heredado work-item): TS strict — sin `any` explícito. Los nuevos campos opcionales en `ComposeRequest`/`OrchestrateRequest` usan tipo concreto `A2AAgentKeyRow`.
- **CD-2** (heredado work-item): Backward-compat. Keys con `allowed_*=null/[]` deben pasar. Tests de regresión obligatorios.
- **CD-3** (heredado work-item): Error 403 con `{ error_code: 'SCOPE_DENIED', target: { registry, agent_slug, category } }` para debugging.
- **CD-4** (heredado work-item): NO modificar shape de `a2a_agent_keys` ni schema DB.
- **CD-5** (heredado work-item): NO modificar lógica core de `authz.ts`. Solo se permite mejorar JSDoc.
- **CD-6** (heredado work-item): Tests cubren TODOS los `allowed_*` arrays — registries, slugs, categories — y la combinación.
- **CD-7** (heredado work-item): Baseline 480 tests verde. Aceptable agregar tests; NO se aceptan tests existentes rotos sin justificación documentada.
- **CD-8** (nuevo): NO leer `agent.capabilities[0]` como proxy de categoría (DT-3). Solo `agent.metadata.category` con type-guard.
- **CD-9** (nuevo): NO reintroducir el check en el middleware. La línea 152 de `a2a-key.ts` queda eliminada para siempre.
- **CD-10** (nuevo): El check ejecuta UNA VEZ por step, post-resolve, pre-invoke. NUNCA dentro de `invokeAgent` (para no incrementar la latencia del invoke con I/O extra; el check es síncrono pero la regla preserva el contrato).
- **CD-11** (nuevo, anti-AB-WKH-57): tests del fix usan `vi.spyOn` cuando sea posible para no contaminar mocks de los tests de compose existentes (WKH-55, WKH-56, WKH-57). Si se requiere `vi.mock` module-level, aislarlo en `describe` block dedicado con `beforeEach(vi.resetModules)`. Patrón: heredado de `auto-blindaje.md` WKH-57 / WAS-V2-3-CLIENT-1.
- **CD-12** (nuevo, anti-AB-WKH-57-W2): si los tests existentes de compose usan mock chains de Supabase con `.eq()` count exacto, NO los rompemos — el fix no toca Supabase ni `kite_schema_transforms`. Verificar al final con `npm run test`.
- **CD-13** (nuevo): el check NO debe ejecutarse para callers x402 (sin `scopingKeyRow`). Si `request.scopingKeyRow === undefined`, `composeService.compose` salta el check y procede normal. Esto preserva el path x402 100% intacto.

---

## 4. Waves de implementación

### W0 — Test que reproduce el bug (serial, no paraleliza con W1+)

**Objetivo**: confirmar pre-fix que keys con scoping reciben 403 hoy en cualquier request a /compose, validando la severidad BLQ-MED.

**Archivos**:
- `src/middleware/a2a-key.test.ts` (modificar) — agregar test:
  ```text
  it('REGRESSION-WKH-61: key with allowed_registries currently 403s any request (bug repro)', async () => {
    const keyRow = makeKeyRow({ allowed_registries: ['wasiai'] });
    mockLookupByHash.mockResolvedValue(keyRow);
    mockDebit.mockResolvedValue({ success: true });
    const res = await app.inject({
      method: 'POST', url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });
    // PRE-FIX: 403 SCOPE_DENIED. POST-FIX: 200 (scoping NO se chequea en middleware).
    expect(res.statusCode).toBe(200);    // value POST-FIX
    expect(res.json().a2aKeyId).toBe(TEST_KEY_ID);
  });
  ```
- W0 deja el test escrito **con la expectativa POST-FIX**. Eso es: si W0 corre solo, el test FALLA confirmando el bug. Si W1 (la fix) ya corrió, el test PASA. Esto convierte el bug-repro en regression test.

**Done de W0**: 1 test agregado en `src/middleware/a2a-key.test.ts` que falla con la implementación actual (verificando el bug) y pasa después de W1.

### W1 — Remover `checkScoping({})` del middleware (paralelizable con W2/W3)

**Objetivo**: AC-8 — quitar el bloque `5. Check scoping via authzService` del middleware.

**Archivos**:
- `src/middleware/a2a-key.ts` (líneas 151-159) — eliminar el bloque completo. Renumerar pasos 6→5, 7→6, 8→7, 9→8.
- `src/middleware/a2a-key.ts` — quitar import `import { authzService } from '../services/authz.js';` (líneas 15) — ya no se usa en este archivo.
- `src/middleware/a2a-key.test.ts` — actualizar cualquier test existente que asuma 403 SCOPE_DENIED desde el middleware (búsqueda: `'SCOPE_DENIED'` en el archivo). Migrar la expectativa a 200 (porque el middleware ya no valida scope).

**Done de W1**:
- `grep -n 'authzService' src/middleware/a2a-key.ts` retorna 0 matches.
- Test W0 (regresión) pasa.
- `npm test src/middleware/a2a-key.test.ts` verde.

### W2 — Agregar `checkScoping` en `compose.ts` post-resolve

**Objetivo**: AC-1, AC-2, AC-3, AC-4, AC-6, AC-7. El check vive en el loop por step.

**Archivos**:
- `src/types/index.ts` — extender `ComposeRequest`:
  ```text
  export interface ComposeRequest {
    steps: ComposeStep[];
    maxBudget?: number;
    a2aKey?: string;
    /** WKH-61: row de la a2a_agent_keys del caller, para scoping post-resolve. */
    scopingKeyRow?: A2AAgentKeyRow;
  }
  ```
  + import del tipo `A2AAgentKeyRow` desde `./a2a-key.js` (re-exportado en línea 631).
- `src/types/index.ts` — extender `ComposeResult`:
  ```text
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
- `src/services/compose.ts`:
  1. Importar `authzService` y `AuthzTarget`.
  2. Definir helper `readCategory(agent: Agent): string | undefined` (módulo-privado).
  3. En `compose(request)`, destructurar `scopingKeyRow` de `request`.
  4. Tras `resolveAgent` (línea 53) + el null-check (líneas 54-62), agregar:
     ```text
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
           error: `Step ${i} denied by scope: ${scope.reason}`,
           errorCode: 'SCOPE_DENIED',
           scopeDeniedTarget: { registry: agent.registry, agent_slug: agent.slug, category: target.category },
         };
       }
     }
     ```
- `src/routes/compose.ts`:
  1. En el handler, antes de llamar `composeService.compose`, leer `request.a2aKeyRow` y pasarlo:
     ```text
     const result = await composeService.compose({
       steps: body.steps,
       maxBudget: body.maxBudget,
       scopingKeyRow: request.a2aKeyRow,
     });
     ```
  2. Después del `if (!result.success)`:
     ```text
     if (!result.success) {
       const status = result.errorCode === 'SCOPE_DENIED' ? 403 : 400;
       return reply.status(status).send({
         ...result,
         requestId: request.id,
       });
     }
     ```

**Done de W2**:
- AC-1, AC-2, AC-3, AC-4, AC-6, AC-7 pasan en tests integration (W4).
- Tests unitarios de `composeService.compose` cubren al menos el branch "scoping deny en step N → abort, no se invoca step N+1".
- `tsc --noEmit` clean.

### W3 — Propagar `scopingKeyRow` en `orchestrate` (paralelizable con W4)

**Objetivo**: AC-4 (parte orchestrate), AC-5 path orchestrate.

**Archivos**:
- `src/types/index.ts` — extender `OrchestrateRequest`:
  ```text
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
- `src/services/orchestrate.ts` — en la línea 403 (la llamada a `composeService.compose`):
  ```text
  const pipeline = await composeService.compose({
    steps,
    maxBudget: budget - feeUsdc,
    a2aKey: request.a2aKey,
    scopingKeyRow: request.scopingKeyRow,
  });
  ```
- `src/routes/orchestrate.ts` — pasar `scopingKeyRow` y mapear `pipeline.errorCode === 'SCOPE_DENIED'` a 403:
  ```text
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
  // ...
  const status = result.pipeline.errorCode === 'SCOPE_DENIED' ? 403 : 200;
  return reply.status(status).send({ kiteTxHash, ...result });
  ```

**Done de W3**:
- `tsc --noEmit` clean.
- AC-4 pasa para orchestrate path en W4.

### W4 — Tests integration cubriendo todos los ACs

**Objetivo**: cubrir AC-1..AC-8.

**Archivos**:
- `src/services/compose.test.ts` — agregar `describe('composeService.compose — WKH-61 scoping per step', ...)` con tests:
  - `T-SCOPE-1` (AC-1): keyRow allows wasiai, agent registered in wasiai → success.
  - `T-SCOPE-2` (AC-2): keyRow allows wasiai, agent registered in 'other' → returns `success:false, errorCode:'SCOPE_DENIED', scopeDeniedTarget:{registry:'other',...}`. **`invokeAgent` NO se llamó** (assert `mockFetch.mock.calls.length === 0` para ese step).
  - `T-SCOPE-3` (AC-3): keyRow allows slug='X', agent.slug='Y' → SCOPE_DENIED.
  - `T-SCOPE-4` (AC-4): keyRow allows category='defi', agent.metadata.category='social' → SCOPE_DENIED.
  - `T-SCOPE-5` (AC-5): keyRow con `allowed_*=null` → success (backward-compat).
  - `T-SCOPE-6` (AC-6): el check usa `agent.registry` (post-resolve) y NO `step.registry` (input field). Test: step pide `registry:'wasiai'`, pero discoveryService devuelve agent con `registry:'fallback-other'` → check evalúa contra `'fallback-other'`.
  - `T-SCOPE-7` (AC-7): pipeline 3-step, step 2 falla scope → step 3 NUNCA se invoca. `results.length === 1` (solo step 0 ejecutado y exitoso). Verificación con counter de mockFetch.
  - `T-SCOPE-8` (AC-5 corner): keyRow con `allowed_categories=['defi']`, agent SIN `metadata.category` → SCOPE_DENIED (correcto: la key explícita por categoría no acepta agentes sin categoría declarada).
  - `T-SCOPE-9` (CD-13): `scopingKeyRow === undefined` (path x402) → check no se ejecuta, success path.
- `src/routes/compose.test.ts` (NUEVO archivo) — test integration con Fastify:
  - `T-ROUTE-1` (AC-2 end-to-end): POST /compose con header x-a2a-key, key con allowed_registries=['x'], step resolves to registry='y' → HTTP 403 con body `{ errorCode:'SCOPE_DENIED', scopeDeniedTarget:{...}, ... }`.
  - **Pre-condición**: archivo NO existe hoy (`src/routes/compose.ts` no tiene tests). El nuevo archivo establece el patrón. Mock de `requirePaymentOrA2AKey` con stub que setea `request.a2aKeyRow`.
- `src/routes/orchestrate.test.ts` (NUEVO archivo) — análogo:
  - `T-ROUTE-2` (AC-4 end-to-end): POST /orchestrate con allowed_categories=['defi'], LLM plan resolves a un agente non-defi → HTTP 403.

**Done de W4**:
- 9 tests nuevos en `src/services/compose.test.ts`.
- ≥1 test integration en `src/routes/compose.test.ts` (nuevo).
- ≥1 test integration en `src/routes/orchestrate.test.ts` (nuevo).
- `npm test` retorna **480 + (1 W0) + (~9 W4 service) + (~2 W4 route) = ~492 tests verde**, baseline 480 intacto.

---

## 5. Exemplars verificados (paths confirmados con Read)

| Patrón | Path:líneas | Para qué |
|---|---|---|
| Cómo leer `agent.metadata` con type-guard | `src/services/compose.ts:253-263` (payTo fallback) | Plantilla 1:1 para `readCategory(agent)`. Mismo `const meta = agent.metadata as Record<string, unknown> \| undefined`. |
| Cómo retornar early desde `compose` con shape `ComposeResult` | `src/services/compose.ts:54-62` ("Agent not found") y `63-71` ("Budget exceeded") | Plantilla para el return-on-scope-deny en W2. |
| Cómo hacer un check post-resolve con ownerId | `src/services/budget.ts:19-41` (`getBalance`) | Mismo patrón "caller pasa el row, service confía". |
| Cómo extender un type de request sin romper callers | `src/types/index.ts:159-161` (`ComposeRequest.a2aKey?: string`) | Campo opcional, se agrega `scopingKeyRow?` siguiendo el mismo estilo. |
| Cómo el route handler usa `request.a2aKeyRow` | `src/routes/tasks.ts:32-34` (`const ownerRef = request.a2aKeyRow?.owner_ref`) | Plantilla para leer el row en `routes/compose.ts` y `routes/orchestrate.ts`. |
| Mocking del middleware en tests de routes | `src/routes/tasks.test.ts:19-27` (mock pass-through que setea `a2aKeyRow`) | Plantilla para los tests integration de W4. |
| `vi.spyOn` patrón aislado | `src/services/compose.test.ts:715-823` (WAS-V2-3-CLIENT integration block) | Aplicación de CD-11 / AB-WKH-57. |
| Patrón de assertion 403 con error_code | `src/middleware/a2a-key.ts:39-45` (`send403`) | Shape de respuesta para route handlers post-fix. |
| Test que verifica `mockFetch` count tras error | `src/services/compose.test.ts:236-280` (T-7 budget rejection) | Plantilla para T-SCOPE-7 (multi-step abort, no invoke). |

Todos los paths verificados con `Read`.

---

## 6. Plan de tests (cobertura por AC)

| AC | Test | Archivo | Tipo |
|----|------|---------|------|
| AC-1 | T-SCOPE-1 | `src/services/compose.test.ts` | service-unit |
| AC-2 | T-SCOPE-2 + T-ROUTE-1 | `compose.test.ts` + `routes/compose.test.ts` | service + integration |
| AC-3 | T-SCOPE-3 | `compose.test.ts` | service-unit |
| AC-4 | T-SCOPE-4 + T-ROUTE-2 | `compose.test.ts` + `routes/orchestrate.test.ts` | service + integration |
| AC-5 | T-SCOPE-5 + T-SCOPE-9 | `compose.test.ts` | service-unit (backward-compat) |
| AC-6 | T-SCOPE-6 | `compose.test.ts` | service-unit |
| AC-7 | T-SCOPE-7 | `compose.test.ts` | multi-step integration |
| AC-8 | REGRESSION-WKH-61 + W1 update | `middleware/a2a-key.test.ts` | middleware-unit |
| Corner | T-SCOPE-8 (category=undefined + allow=['defi']) | `compose.test.ts` | service-unit |

**Total tests nuevos**: ≥12 (1 W0 + 9 W2/W4 service + 2 W4 route).

**Tests modificados**: ≤3 en `middleware/a2a-key.test.ts` (los que asumían 403 SCOPE_DENIED desde el middleware deben actualizarse a 200).

---

## 7. Anti-Hallucination checklist

- [x] `src/middleware/a2a-key.ts` línea 152 verificada con Read — `authzService.checkScoping(keyRow, {})` confirmado.
- [x] `src/services/authz.ts:21` confirma firma `checkScoping(keyRow, target): AuthzResult`.
- [x] `src/services/compose.ts:53` confirma `resolveAgent` es el sitio correcto post-resolve.
- [x] `src/services/orchestrate.ts:403` confirma que orchestrate llama compose (no resolveAgent directo).
- [x] `src/types/index.ts:155-161` confirma forma de `ComposeRequest`.
- [x] `src/types/a2a-key.ts:52-57` confirma `AuthzTarget`.
- [x] `src/routes/tasks.ts:32` confirma patrón `request.a2aKeyRow?.owner_ref`.
- [x] `agent.metadata.category` NO es campo top-level de `Agent` — es leído desde `metadata: raw` (`src/services/discovery.ts:251`).
- [x] No existe hoy `src/routes/compose.test.ts` ni `src/routes/orchestrate.test.ts` (verificado con `ls src/routes/`). W4 los crea.

---

## 8. Readiness Check

| Item | Status |
|------|--------|
| Todos los ACs del work-item tienen test asignado | OK |
| Todas las DTs resueltas, sin `[NEEDS CLARIFICATION]` | OK (DT-3 resuelto, DT-4 resuelto) |
| Exemplars verificados con paths reales | OK |
| Constraint Directives heredan + nuevas explícitas | OK |
| Waves ordenadas: W0 (test) → W1 (middleware) → W2 (compose) → W3 (orchestrate) → W4 (tests) | OK |
| Backward-compat preservada (CD-2, CD-13) | OK |
| Stack alineado: TS strict, Fastify, Vitest | OK |
| No se modifican secrets ni schema DB (CD-4) | OK |
| Auto-Blindaje aplicado (CD-11, CD-12 anti-AB-WKH-57) | OK |

**SDD listo para SPEC_APPROVED.**

---

## 9. Tech Debt y notas (fuera de scope)

- **TD-WKH-61-1**: `src/routes/compose.ts:59-62` no propaga `a2aKey` del header al body de `composeService.compose`. Esto impacta downstream payment al invocar sub-agentes con header `x-a2a-key` (línea 247 de compose.ts). NO es el bug de WKH-61, pero conviene cerrarlo en HU separada (sugerido: WKH-MCP-X402-FU). Esta HU puede agregarlo defensivamente sin costo si así se decide en F2.5; el SDD lo deja **fuera de scope** para no inflar el alcance.
- **TD-WKH-61-2**: hoy orchestrate retorna 200 incluso cuando `result.pipeline.success === false` (`src/routes/orchestrate.ts:81`). El fix WKH-61 introduce 403 SOLO para el caso `errorCode === 'SCOPE_DENIED'`. Una limpieza más amplia (otros errores 4xx vs 5xx) queda fuera de scope.

---

## 10. Resumen ejecutivo

- **Bug**: middleware llama `checkScoping({})` con target vacío → toda key con `allowed_*` configurado recibe 403 en cada request.
- **Fix**: borrar el check del middleware (W1), moverlo a `composeService.compose` post-`resolveAgent` por step (W2), propagar `scopingKeyRow` desde el route handler vía `ComposeRequest`. orchestrate cubre por delegación (W3).
- **Backward-compat**: keys sin scoping pasan idénticas al baseline. x402 path 100% intacto (no recibe `scopingKeyRow`).
- **Categoría**: leída de `agent.metadata.category` con type-guard (DT-3); rechaza correctamente agentes sin `category` cuando la key tiene `allowed_categories` configurado.
- **Tests**: 1 regresión (W0) + 9 service tests (W2/W4) + 2 integration tests de routes (W4). Baseline 480 mantenido.
- **CDs clave**: CD-9 (no reintroducir check en middleware), CD-13 (skip si `scopingKeyRow` undefined → x402 puro).
