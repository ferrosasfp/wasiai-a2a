# Auto-Blindaje — WKH-61 / SEC-SCOPE-1

Registro de lecciones, edge cases, y descubrimientos durante la implementación de la HU. Cumple metodología QUALITY de NexusAgil: capturar todo lo aprendido para futuras HUs, prevenir regresiones, y documentar decisiones que NO están en el SDD.

---

## Estructura

- **ID**: `AB-WKH-61-N` (N = número de lección)
- **Fecha**: YYYY-MM-DD WN (ej: 2026-04-27 W3, ejecutado en la wave 3)
- **Categoría**: 
  - `DISCOVERY` — hallazgo que cambió el entendimiento
  - `PITFALL` — trampa evitada o error durante la implementación
  - `PATTERN` — patrón útil reutilizable
  - `DEBT` — deuda técnica identificada
  - `LECCIÓN` — conclusión de arquitectura/metodología
- **Severidad**: HIGH / MEDIUM / LOW
- **Aplicable a**: Lista de futuras HUs/épicas que deben aprender esto

---

## AB-WKH-61-1

**Fecha**: 2026-04-27 W0–W1

**Categoría**: LECCIÓN

**Severidad**: HIGH

**Título**: Scope check requiere conocer el target

### Observación

El bug de WKH-61 existía porque el middleware ejecutaba:
```ts
const scopingResult = authzService.checkScoping(keyRow, {});
```

Con un `AuthzTarget` **completamente vacío**. El middleware corre ANTES de que `composeService` y `orchestrateService` resuelvan el agente, por lo tanto:
- `target.registry` no se conoce
- `target.agent_slug` no se conoce
- `target.category` no se conoce

`authzService.checkScoping` chequea exactamente esos campos. Con valores undefined/missing, toda key con `allowed_registries`, `allowed_agent_slugs` o `allowed_categories` configurados recibía `{ allowed: false }`.

### Root Cause

El diseño asumió que el check podía ejecutarse "temprano" (en el middleware) para rechazar inválidas antes de invocar agentes. Pero "temprano" en el middleware es "ciego" respecto al target real.

### La Fix

Mover el check a `composeService.compose`, DESPUÉS de `resolveAgent(step)` (línea 53 en la implementación), donde:
- `agent.registry` está disponible
- `agent.slug` está disponible
- `agent.metadata.category` está disponible (o undefined si el registry no la expone)

### Por qué importa

1. **Correctness**: El check ahora evalúa contra la identidad REAL del agente, no un placeholder vacío.
2. **Debugging**: El error retorna `scopeDeniedTarget: { registry, agent_slug, category }` con los valores reales, permitiendo al caller saber exactamente por qué fue rechazado.
3. **Usabilidad**: Keys sin scoping (`allowed_*=null`) pasan intactas. No hay rechazos falsos por target desconocido.

### Pattern

```
┌─────────────────────────────────────────┐
│ Route handler                           │
│ (request.a2aKeyRow disponible)         │
└─────────────────┬───────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────┐
│ composeService.compose(request)         │
│ {                                       │
│   for each step:                        │
│     1. resolveAgent(step)               │
│     2. [NEW] checkScoping(keyRow, ...)  │  ← TARGET AHORA CONOCIDO
│     3. checkBudget(...)                 │
│     4. invokeAgent(...)                 │
│ }                                       │
└─────────────────────────────────────────┘
```

**Nunca** ejecutes un check que dependa de propiedades del target en una capa que no conoce el target. Mover el check al sitio más tardío donde el target está completamente resuelto.

### Aplicar en

- **WKH-FUTURE-CHECKS**: Rate limiting por categoría de agente → ejecutar post-resolve (no en middleware).
- **WKH-FUTURE-CHECKS**: Presupuesto condicional por registry → ejecutar post-resolve.
- **WKH-SEC-ANYTHING**: Cualquier validación de scoping → post-resolve.
- **Arquitectura general**: Middleware = autenticación + autorización simple (key válida/inactiva). Servicios = validaciones con contexto completo.

---

## AB-WKH-61-2

**Fecha**: 2026-04-27 W2

**Categoría**: PATTERN

**Severidad**: HIGH

**Título**: errorCode discriminator + route handler mapping a HTTP status mantiene service layer pura

### Observación

Durante W2, el SDD decidió agregar `errorCode?: 'SCOPE_DENIED'` a `ComposeResult`. El objetivo era permitir que el route handler mapeara `errorCode === 'SCOPE_DENIED'` a HTTP 403, sin forzar al service a retornar HTTP status codes (eso violaría responsabilidades).

### El patrón

**En el service** (`src/services/compose.ts`):
```ts
if (!scope.allowed) {
  return {
    success: false,
    output: null,
    steps: results,
    totalCostUsdc: totalCost,
    totalLatencyMs: totalLatency,
    error: `Step ${i} denied by scope: ${scope.reason}`,
    errorCode: 'SCOPE_DENIED',  // ← discriminator
    scopeDeniedTarget: { registry, agent_slug, category },
  };
}
```

**En el route handler** (`src/routes/compose.ts`):
```ts
if (!result.success) {
  const status = result.errorCode === 'SCOPE_DENIED' ? 403 : 400;
  return reply.status(status).send({
    ...result,
    requestId: request.id,
  });
}
```

### Por qué funciona

1. **Separación de responsabilidades**: Service no sabe de HTTP. Retorna un result type con un discriminator.
2. **Testeable**: Tests del service NO necesitan monitorear HTTP status. Solo verifican `result.errorCode`.
3. **Reutilizable**: Si mañana queremos un transport gRPC o GraphQL, el service retorna el mismo result type. El handler gRPC/GraphQL mapea el discriminator a su propio código de error.
4. **Extensible**: Si agregamos más errores (BUDGET_DENIED, RATE_LIMITED), agregamos más valores a la union: `errorCode?: 'SCOPE_DENIED' | 'BUDGET_DENIED' | 'RATE_LIMITED'`. Cada handler mapea a su convención.

### Alternativas evitadas

- **❌ Service retorna HTTP status**: `return { status: 403, body: {...} }`. Contamina el service con detalles HTTP. No reutilizable.
- **❌ Service lanza excepciones HTTP**: `throw new ForbiddenException()`. Complica el flujo de control. Difícil testear.
- **❌ Handler decide por inferencia**: `if (result.error?.includes('SCOPE'))`. Frágil; cambios en el mensaje rompen el mapping.

### Aplicar en

- **Todos los services** que retornan `Result<T>` o tipos similares.
- **Nuevos errores** que merecen diferentes HTTP status codes (no solo 400 genérico).
- **Multi-transport** (REST, gRPC, WebSocket) donde el mapping a código de error es distinto por transporte.

### Ejemplos futuros

- `authzService.checkScoping` → `{ allowed: false, reason: string }` (hoy: sin código). Considerar agregar `errorCode?: 'SCOPE_DENIED' | 'SCOPE_INSUFFICIENT'` para diferenciar "acceso denegado" de "aceso insuficiente".
- `budgetService.getBalance` → `{ balance: number }` o error. Si queremos diferenciar "insuficiente" de "key no encontrada", agregar `errorCode`.

---

## AB-WKH-61-3

**Fecha**: 2026-04-27 W2

**Categoría**: LECCIÓN

**Severidad**: MEDIUM

**Título**: Timing de checks post-resolve — usabilidad vs seguridad (trade-off consciente)

### Observación

El SDD consideró dos arquitecturas para mover el check:

**Opción A (considerada, rechazada)**: Middleware pre-resolve
- Middleware corre, valida `allowed_registries` comparando contra... ¿qué? No conoce el agente destino.
- Solución: rechazar TODO si `allowed_*` está configurado (más seguro, pero inutiliza la feature).

**Opción B (elegida)**: Service post-resolve
- El check ejecuta DESPUÉS de que `resolveAgent(step)` retorna el agent completo.
- Sitio correcto: el check evalúa contra la identidad REAL.

### El trade-off

**Pro de post-resolve**:
1. Seguridad correcta: valida contra el agent resuelto, no un placeholder.
2. Usabilidad: error detallado (`scopeDeniedTarget`) permite debugging.
3. Backward-compat: keys sin scoping no ejecutan el check (perfecto).

**Con de post-resolve** (aceptado):
1. Si el pipeline tiene 10 steps y step 5 falla scope, los pasos 0-4 ya fueron **invocados** (latencia, potencial costo).
2. Pero: si la key NO tiene scoping, el check se salta (CD-13) → mejor rendimiento para el 99% de users.
3. Si la key SÍ tiene scoping, rechazar tarde es correcto por seguridad.

### Razón de la decisión

**"Seguridad correcta > Eficiencia prematura"** en auth paths. Si tienes que elegir entre:
- Rechazar temprano pero con información incompleta (incorrecto + confuso)
- Rechazar tarde pero con información correcta (correcto + claro)

Elige lo segundo. El costo de invocar algunos agentes antes de rechazar es aceptable. El costo de rechazar inválidas por información incompleta es inaceptable.

### Lección de arquitectura

Cuando diseñes un pipeline multi-etapa (middleware → service → resolver → invoker), pregúntate:
1. ¿En qué punto tengo TODA la información para hacer este check?
2. ¿Es más tarde que donde hoy está implementado?
3. ¿El costo de mover es justificado por la corrección?

Si la respuesta es "sí, sí, sí", muévelo aunque sea "más tardío". La corrección es más importante que la velocidad de rechazo en auth.

### Aplicar en

- **WKH-FUTURE-AUTH**: Rate limiting por destino → post-resolve.
- **WKH-FUTURE-AUTH**: Permisos condicionales → post-resolve.
- **Diseño de middleware**: Nunca valides propiedades del destino si no las conoces.

---

## AB-WKH-61-4

**Fecha**: 2026-04-27 W2–W4

**Categoría**: DEBT

**Severidad**: MEDIUM

**Título**: Drift entre snake_case (DB/legacy) y camelCase (TS convention) — convención global

### Observación

Durante la implementación de W2, el codebase mostró un patrón inconsistente en convenciones de naming:

**DB schema** (`a2a_agent_keys`):
```sql
allowed_registries TEXT[]  -- snake_case
allowed_agent_slugs TEXT[]
allowed_categories TEXT[]
owner_ref UUID
```

**TypeScript types** (`src/types/a2a-key.ts`):
```ts
interface A2AAgentKeyRow {
  allowed_registries?: string[] | null;  // mantiene snake_case del schema
  allowed_agent_slugs?: string[] | null;
  allowed_categories?: string[] | null;
  owner_ref: string;
}
```

**JSON-RPC / REST responses** (variado):
```json
{
  "error_code": "SCOPE_DENIED",  // snake_case (legacy x402)
  "errorCode": "SCOPE_DENIED",   // camelCase (TS convention)
  "scopeDeniedTarget": {         // camelCase (TS)
    "agent_slug": "wasi-..."     // snake_case (DB field)
  }
}
```

**La cascada**:
1. DB retorna snake_case (Postgres convention).
2. Supabase SDK mapea a snake_case en el TS type (por consistencia con DB).
3. Servicios retornan TS types con snake_case.
4. Route handlers usan JSON.stringify del TS object → resultado: AMBAS convenciones en el JSON.

### Impacto

Para el cliente:
```json
{
  "success": false,
  "errorCode": "SCOPE_DENIED",  // camelCase, confuso
  "error": "Step 0 denied by scope: ...",
  "scopeDeniedTarget": {
    "registry": "wasiai",       // camelCase
    "agent_slug": "...",        // snake_case, inconsistente!
    "category": "defi"          // camelCase
  }
}
```

Clientes esperando una convención única se encuentran con ambas. Integraciones REST/gRPC sufren.

### Por qué no se resolvió en WKH-61

El alcance de WKH-61 es el bug de scope check. Resolver el drift global requiere:
1. Decidir: ¿camelCase o snake_case para el API?
2. Refactor todas las rutas (`src/routes/*.ts`) para transformar responses.
3. Actualizar documentación de API.
4. Tests de regresión.

Eso es una **epic separada** (sugerido: `WKH-GLOBAL-API-CLEANUP`), no una HU de bugfix.

**Decisión en WKH-61**: Mantener la convención heredada (drift existente). No lo hacemos peor, pero tampoco lo arreglamos.

### Lección

**Para próximas HUs**: Si vas a agregar campos a un response (como `errorCode`, `scopeDeniedTarget`), **decide una convención global y usa UNA SOLA en ese response**. No mezcles snake_case y camelCase en el mismo objeto.

### Patrón recomendado (futuro)

Crear un `ResponseNormalizer` middleware que transforme todas las responses a camelCase (o snake_case, según decisión global):

```ts
// src/middleware/response-normalizer.ts
app.hook('onSend', async (request, reply, payload) => {
  if (reply.getHeader('content-type')?.includes('application/json')) {
    const obj = JSON.parse(payload);
    const normalized = snakeToCamelCase(obj);
    reply.send(normalized);
  }
});
```

Así, cada service y route NO necesita pensar en convención. El middleware lo hace.

### Aplicar en

- **WKH-GLOBAL-API-CLEANUP**: Epic de limpieza de convención JSON.
- **Nuevas HUs**: Si agregan response fields, usar la convención que decida el global cleanup.
- **Documentación de API**: Registrar cuál es la convención oficial (camelCase recomendado para REST/JSON).

---

## Resumen ejecutivo de lecciones

| AB-ID | Título | Categoría | Severidad | Aplicar a | Prioridad |
|-------|--------|-----------|-----------|-----------|-----------|
| AB-WKH-61-1 | Scope check requiere target | LECCIÓN | HIGH | Arquitectura de checks futuros | ALTA |
| AB-WKH-61-2 | errorCode discriminator mantiene service puro | PATTERN | HIGH | Todos los result types | ALTA |
| AB-WKH-61-3 | Timing post-resolve > eficiencia prematura | LECCIÓN | MEDIUM | Diseño de middleware, auth paths | MEDIA |
| AB-WKH-61-4 | Convención global snake_case vs camelCase | DEBT | MEDIUM | WKH-GLOBAL-API-CLEANUP | MEDIA |

---

## Matriz de aplicabilidad

### Afecta a

- **WKH-62 (SEC-REG-1)**: Uso de patrón AB-WKH-61-1 para registration scoping.
- **WKH-63 (SEC-DRAIN-1)**: Diseño similar (scope check post-resolve) → importa AB-WKH-61-1.
- **WKH-60 (SEC-RCE-1)**: Validaciones de destino → AB-WKH-61-1.
- **Cualquier HU de auth/security**: Lecciones AB-WKH-61-1, AB-WKH-61-2.
- **WKH-GLOBAL-API-CLEANUP (futura)**: AB-WKH-61-4 documenta el problema.

---

## Signature

- **HU**: WKH-61 / SEC-SCOPE-1
- **Branch**: `feat/059-wkh-61-sec-scope-1`
- **Completado**: 2026-04-27
- **Generado por**: `nexus-docs` agent
- **Validado por**: Pipeline QUALITY (F3 implementation + AR + CR + F4 QA)

---

*Auto-Blindaje — Documento inmutable — Registra lecciones del pipeline para futuras HUs.*
