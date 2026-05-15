# Work Item — [WKH-59] Middleware /compose debit reads real agent price from registry

## Resumen

El middleware `requirePaymentOrA2AKey` debita un placeholder fijo de $1.00 USD por cada request a `/compose`. El precio real de los agentes en el registry (e.g. kyc=0.001, corridor=0.05, cashout=0.01) se ignora, creando una discrepancia 50x vs lo que expone `/discover`. Esta HU introduce un preHandler en `/compose` que resuelve el precio real del agente (`agent.priceUsdc`) antes del debit del middleware, inyectándolo como campo augmentado en `request`. El middleware lo consume sin cambiar su lógica central.

---

## Sizing

- **SDD_MODE**: full
- **Pipeline**: QUALITY (no negociable — toca payment path crítico)
- **Estimación**: M (4-6 archivos modificados, lógica cross-cutting, tests obligatorios)
- **Branch sugerido**: `feat/087-wkh-59-real-agent-price-debit`

---

## Audit de codebase (F0 findings)

### Campo en ComposeStep

**[DISCREPANCIA RESUELTA]** La HU describe el campo como `steps[].agentSlug` pero el tipo real en `src/types/index.ts:162-171` es:

```typescript
export interface ComposeStep {
  agent: string;  // ← campo real (Agent ID or slug)
  registry?: string;
  input: Record<string, unknown>;
  passOutput?: boolean;
}
```

El SDD y los ACs usan `step.agent` (nombre real). No hay `agentSlug`.

### Middleware — líneas clave

`src/middleware/a2a-key.ts:122-130` — placeholder actual:
```typescript
// WKH-59: rutas que mueven valor on-chain (POST /gasless/transfer) inyectan
// el costo real vía request.gaslessEstimatedCostUsd desde un preHandler upstream.
// El resto de las rutas siguen con $1 placeholder (backward-compat).
const estimatedCostUsd =
  typeof request.gaslessEstimatedCostUsd === 'number'
    ? request.gaslessEstimatedCostUsd
    : 1.0;
```

El patrón de extensión es claro: agregar un nuevo campo augmentado `request.composeEstimatedCostUsd` que el middleware consume en la misma expresión ternaria (o cadena de ternarios), manteniendo el fallback $1 para rutas sin inyección.

### Sistema de cache

**[DECISIÓN DT-B AJUSTADA]** No existe Redis client en `src/lib/` (`package.json` no tiene `ioredis`/`redis` dep). El cache de transforms existe en `src/services/llm/transform.ts` como Map en proceso. El cache de `resolveAgentPriceUsdc` DEBE implementarse como `Map<string, {price: number; expiresAt: number}>` en proceso con TTL 60s — sin Redis, sin dependencia externa.

### PG function `increment_a2a_key_spend`

`supabase/migrations/20260406000000_a2a_agent_keys.sql:56-121` — la firma es:
```sql
CREATE OR REPLACE FUNCTION increment_a2a_key_spend(
  p_key_id    UUID,
  p_chain_id  INT,
  p_amount_usd NUMERIC  -- ← acepta NUMERIC, no INT
) RETURNS void
```

`NUMERIC` en PG acepta decimales arbitrarios (0.001 es válido). **No se requiere cambio de schema.**

### resolveAgentPriceUsdc — no existe

No hay función existente con este nombre en `src/services/`. El flujo más cercano es `composeService.resolveAgent(step)` en `src/services/compose.ts:263-272` que retorna `Agent | null`. `Agent.priceUsdc` (tipo `number`) ya está mapeado por `discoveryService.mapAgent`. La nueva función puede delegar en `discoveryService.getAgent(slug)` o reutilizar `composeService.resolveAgent`.

Encaje recomendado: nuevo archivo `src/services/agent-price.ts` (servicio standalone con cache) en lugar de extender `compose.ts` o `discovery.ts` — mantiene separación de concerns y facilita testing aislado.

### DT-A — Debit por step vs suma pre-debit

**Arquitectura actual**: el middleware ejecuta ONCE antes del route handler. Para debit-por-step el middleware solo puede deducir el precio del **primer step** (el body.steps[0] está disponible en el preHandler de compose). Los steps posteriores se debitan en el route handler/service.

**Implicación crítica**: el patrón actual de "un debit en middleware" no es compatible con "un debit por step" sin reestructuración mayor. La solución correcta para esta HU es:

- El preHandler en `/compose` resuelve el precio del **primer step** e inyecta `request.composeEstimatedCostUsd`
- El middleware debita ese monto (primer step)
- Los steps 2..N se debitan directamente en `composeService.compose` vía `budgetService.debit` (mismo PG function, mismos atomicity guarantees)
- Esto ya era el comportamiento implícito del compose: `totalCost += agent.priceUsdc` (línea 137), solo falta el debit real para steps 2..N

**Alternativa rechazada**: inyectar la SUMA total pre-ejecución (suma de todos los precios) viola DT-A (preferencia humano: debit atómico por step) y requiere resolver todos los agentes antes de empezar.

---

## Acceptance Criteria (EARS)

### Happy path

- **AC-1**: WHEN POST /compose con `steps[0].agent` que existe en registry con `priceUsdc = X`, THEN el middleware debita `X` USD (no $1.00) para el primer step.

- **AC-2**: WHEN POST /compose con N steps (N > 1), THEN `composeService.compose` debita `priceUsdc` del agente correspondiente por cada step 2..N via `budgetService.debit`, de forma atómica e independiente (no suma pre-debit).

- **AC-3**: WHEN POST /compose con `steps[0].agent` que NO existe en registry, THEN la respuesta es 404 con `error_code: "AGENT_NOT_FOUND"` y no se realiza ningún debit.

### Fallback & degradation

- **AC-4**: WHEN `priceUsdc` del agente es `null`, `undefined`, o `0`, THEN el sistema SHALL debitar $1.00 placeholder, emitir `request.log.warn` con campo `reason: "registry-miss"`, y añadir header de respuesta `x-debit-fallback: registry-miss`.

- **AC-5**: WHEN el lookup de priceUsdc falla por error de DB o timeout, THEN la respuesta es 503 con `error_code: "REGISTRY_UNAVAILABLE"` sin realizar debit alguno.

### Backward compatibility

- **AC-6**: WHEN POST /gasless/transfer, THEN el middleware usa `request.gaslessEstimatedCostUsd` (path no afectado por esta HU). `request.composeEstimatedCostUsd` SHALL ser `undefined` en esa ruta.

- **AC-7**: WHEN POST /discover o POST /orchestrate, THEN el middleware usa el placeholder $1.00 (fuera de scope explícito). Sin preHandler de resolución de precio en esas rutas.

### Cache

- **AC-8**: WHILE cache en proceso tiene una entrada válida para `(slug, registryName)` con TTL no expirado (< 60s), the system SHALL retornar el precio cacheado sin llamada a `discoveryService`. El tiempo de respuesta del lookup SHALL ser < 5ms en cache hit.

- **AC-9**: WHEN el TTL del cache para `(slug, registryName)` expira, THEN el sistema SHALL re-fetch el precio desde `discoveryService` y actualizar la entrada de cache con nuevo TTL de 60s.

### Tests

- **AC-10**: WHEN se ejecutan los tests baseline, THEN 644+ tests existentes SHALL pasar sin regresión, más los nuevos tests cubriendo AC-1 a AC-9.

### E2E

- **AC-11**: WHEN WasiAgentShop demo hace 3 llamadas POST /compose contra agentes con precios reales (kyc=$0.001, corridor=$0.05, cashout=$0.01), THEN el budget total debitado es `$0.061` (no `$3.00`), `/auth/me` refleja `daily_spent_usd` incrementado en $0.061, y no hay respuestas 5xx ni headers `x-debit-fallback`.

---

## Scope IN

| Archivo | Cambio |
|---------|--------|
| `src/middleware/a2a-key.ts` | Extender expresión de `estimatedCostUsd` (líneas 127-130) para consumir `request.composeEstimatedCostUsd` en la cadena de ternarios. Agregar augmentation declaration. |
| `src/routes/compose.ts` | Agregar preHandler `resolveComposePriceHandler` ANTES de `requirePaymentOrA2AKey` que resuelve `step[0].agent → priceUsdc` e inyecta `request.composeEstimatedCostUsd`. Manejo 404 si agente no existe. |
| `src/services/agent-price.ts` | **NUEVO** — función `resolveAgentPriceUsdc(agentSlug: string, registryName?: string): Promise<number | null>` con cache in-process TTL 60s. Delega en `discoveryService.getAgent`. |
| `src/services/compose.ts` | Añadir debit real para steps 2..N dentro del loop `compose()` (post-invoke o pre-invoke según DT-A). Usar `budgetService.debit(keyRow.id, chainId, agent.priceUsdc)`. Requiere pasar `chainId` desde el request. |
| `src/types/index.ts` | Agregar `composeEstimatedCostUsd?: number` a la augmentation de FastifyRequest (declarada en `a2a-key.ts`). |
| `src/services/agent-price.test.ts` | **NUEVO** — unit tests de `resolveAgentPriceUsdc`: cache hit, cache miss, TTL expiry, null price, DB error. |
| `src/middleware/a2a-key.test.ts` | Actualizar AC-1 de middleware: verificar que `debit` se llama con el valor inyectado (no hardcoded 1.0). |
| `src/routes/compose.test.ts` o `src/services/compose.test.ts` | Test de integración: compose con agente de priceUsdc conocido → debit correcto. |

---

## Scope OUT

- NO modificar lógica de `/gasless/transfer` ni su preHandler de estimación de costo
- NO modificar `/discover` ni `/orchestrate` — mantienen placeholder $1
- NO modificar schema de tablas `a2a_agent_keys` ni `agents`
- NO modificar `wasiai-v2` ni `wasiai-agentshop`
- NO modificar `increment_a2a_key_spend` PG function (acepta NUMERIC, no requiere cambio)
- NO añadir dependencia externa de Redis o cache distribuido
- NO romper la API pública de ningún endpoint
- NO cambiar el debit del primer step en el middleware por un sistema multi-step en middleware (eso requeriría redesign de scope mayor)

---

## Decisiones Técnicas

### DT-A: Debit per-step — arquitectura híbrida
**Decisión**: Debit del primer step en middleware (via `request.composeEstimatedCostUsd`), debit de steps 2..N en `composeService.compose()` usando `budgetService.debit` directamente.

**Justificación**: El middleware corre una vez antes del route handler. Inyectar el precio del step[0] mantiene el invariante existente (debit antes de ejecución para el primer step). Para steps subsiguientes, el compose service ya tiene acceso al `chainId` (desde `request.a2aKeyRow` propagado como `scopingKeyRow`) y puede debitar atómicamente por step. Esto es architecturalmente consistente con el patrón "charge first, deliver after".

**Implicación de implementación**: `ComposeRequest` necesita recibir `chainId: number` del caller (route handler), extraído del bundle resuelto por el middleware. Alternativamente el middleware puede augmentar `request.resolvedChainId`.

### DT-B: Cache in-process Map con TTL 60s
**Decisión**: `Map<string, {price: number; expiresAt: number}>` en módulo `src/services/agent-price.ts`. Sin Redis.

**Justificación**: No existe cliente Redis en el proyecto (`package.json` no tiene `ioredis`). El cache in-process es suficiente para TTL 60s con la carga de un servicio single-instance. Multiples instancias en Railway tienen TTL independence (aceptable — el precio no cambia en < 60s típicamente).

**Clave de cache**: `${slug}::${registryName ?? '_all_'}` para evitar colisiones entre registries con agentes de mismo slug.

### DT-C: Fallback $1 con warn log + header
**Decisión**: Si `priceUsdc` es null, undefined, o 0 → fallback $1.00, `log.warn({reason: 'registry-miss', slug})`, header `x-debit-fallback: registry-miss`.

**Justificación**: La consistencia de precios es un invariante de seguridad, pero bloquear totalmente por un miss de precio rompe backward-compat. El warn + header permite monitoreo de fallbacks. El valor 0 también activa el fallback porque un precio cero es más probablemente un error de configuración del registry que un agente gratuito legítimo.

### DT-D (nuevo): Propagación de chainId al compose service
**Decisión**: El middleware ya augmenta `request.a2aKeyRow`. El route handler de compose extrae el `chainId` del bundle via un nuevo campo augmentado `request.resolvedChainId: number` seteado por el middleware, y lo pasa al `ComposeRequest`.

**Justificación**: `composeService.compose()` necesita el `chainId` para llamar `budgetService.debit(keyRow.id, chainId, price)`. El chainId ya está resuelto por el middleware (bundle selection). Reutilizar ese valor evita re-resolución y mantiene CD-12 ("chainId para debit y getBalance del MISMO bundle").

### DT-E (nuevo): 404 para agente no encontrado en preHandler
**Decisión**: Si `step[0].agent` no se resuelve → responder 404 con `error_code: "AGENT_NOT_FOUND"` en el preHandler, antes de llegar al middleware de debit.

**Justificación**: El middleware no puede saber si el debit tendrá un agente real. Si el preHandler de precio corre ANTES del middleware (orden en `preHandler` array), puede short-circuit con 404 antes del debit. Esto es semánticamente correcto: no se debita por requests a agentes inexistentes.

**Orden en compose.ts preHandler array**:
```
[requireForwardKey, createTimeoutHandler, resolveComposePriceHandler, ...requirePaymentOrA2AKey]
```

---

## Constraint Directives

- **CD-1**: TypeScript strict — sin `any` explícito, sin `as unknown` para escapar tipos
- **CD-2**: Debit sigue atómico via `increment_a2a_key_spend` PG function. NO debit manual via UPDATE directo
- **CD-3**: Performance: lookup < 50ms (DB miss), < 5ms (cache hit). No agregar I/O en el hot path del middleware
- **CD-4**: Fallback honesto — NO silent fallback. SIEMPRE warn log + response header `x-debit-fallback: registry-miss`
- **CD-5**: NO regresión en 644+ tests baseline
- **CD-6**: NO leak de `owner_ref` de otros keys en logs ni errores. Ownership guard permanece en `budgetService.debit` (patrón WKH-53)
- **CD-7**: El middleware NO lee `request.body` — solo campos augmentados del request. El preHandler de compose sí puede leer body (es su responsabilidad)
- **CD-8**: `resolveAgentPriceUsdc` SOLO en `src/services/agent-price.ts`. NO duplicar lógica en middleware ni en route handler
- **CD-9**: El nuevo campo augmentado es `request.composeEstimatedCostUsd` (distinguible de `request.gaslessEstimatedCostUsd`). Nombres no colisionan
- **CD-10**: Si el preHandler de precio retorna 404/503, el middleware NO corre (Fastify short-circuits cuando `reply.sent = true`)

---

## Missing Inputs

- `[RESUELTO]` Campo en ComposeStep: es `step.agent` (no `agentSlug`)
- `[RESUELTO]` PG function: acepta NUMERIC, float values son válidos
- `[RESUELTO]` Cache: in-process Map (no Redis disponible)
- `[RESUELTO]` resolveAgentPriceUsdc: no existe, crear en `src/services/agent-price.ts`
- `[NEEDS CLARIFICATION — no bloqueante]` Steps 2..N debit: la propagación de `chainId` al compose service requiere augmentar `request.resolvedChainId` en el middleware. Confirmar en SDD si el Architect prefiere alternativa (pasar por `ComposeRequest` vs field augmentado). Decisión DT-D documenta el approach por defecto.
- `[NEEDS CLARIFICATION — no bloqueante]` Para el test E2E AC-11 (WasiAgentShop demo), se requiere acceso a una A2A key testnet con budget conocido. QA debe confirmar credenciales disponibles en F4.

---

## Análisis de paralelismo y waves recomendadas para F3

### Dependencias entre componentes

```
Wave 1 (fundación):
  - src/services/agent-price.ts (nuevo, sin deps externas excepto discoveryService)
  - src/services/agent-price.test.ts (unit tests del service)
  → SIN dependencias de otros cambios

Wave 2 (middleware extension):
  - src/types/index.ts (agregar composeEstimatedCostUsd a FastifyRequest augmentation)
  - src/middleware/a2a-key.ts (extender ternario, consumir nuevo campo)
  - src/middleware/a2a-key.test.ts (actualizar AC-1 del middleware)
  → Depende de W1 (necesita el campo augmentado definido)

Wave 3 (route + compose service):
  - src/routes/compose.ts (preHandler resolveComposePriceHandler + 404 guard)
  - src/services/compose.ts (debit steps 2..N + recibir chainId)
  → Depende de W1 + W2

Wave 4 (tests integración + E2E):
  - compose route test actualizado
  - compose service test con debit multi-step
  - E2E test AC-11 (WasiAgentShop 3 calls)
  → Depende de W1 + W2 + W3
```

### Paralelismo con otras HUs

- Esta HU NO bloquea WKH-60, WKH-61, WKH-63 (ya DONE)
- Esta HU puede correr en paralelo con cualquier HU que no toque `src/middleware/a2a-key.ts`, `src/routes/compose.ts`, o `src/services/compose.ts`
- Si hay HU activa tocando compose/middleware: coordinar rama

---

## Categoría de riesgo

| Riesgo | Nivel | Mitigación |
|--------|-------|-----------|
| Payment path — debit incorrecto | ALTO | AC-1..AC-5, AR debe verificar no double-debit y no under-debit |
| Backward-compat /gasless/transfer | ALTO | AC-6, tests específicos de no-regresión |
| Race condition double-debit (step 1 en middleware + step 1 en compose) | ALTO | DT-A clarifica que compose solo debita steps 2..N. AR debe verificar |
| Cache poisoning (precio obsoleto) | MEDIO | TTL 60s, cache key scoped por slug+registry |
| owner_ref leak en error paths | MEDIO | CD-6, patrón WKH-53 vigente |
| Test flakiness en E2E testnet | BAJO | Mocking en unit/integration, E2E opcional con real testnet |

**AR MUST attack**:
1. Double-debit: ¿puede el primer step ser debitado dos veces? (middleware + compose service)
2. Zero-price bypass: ¿puede un atacante registrar un agente con priceUsdc=0 para evadir debits?
3. Fallback honesty: ¿el warn + header es realmente emitido en todos los paths de fallback?
4. owner_ref en logs: ningún log debe exponer owner_ref de otros tenants
