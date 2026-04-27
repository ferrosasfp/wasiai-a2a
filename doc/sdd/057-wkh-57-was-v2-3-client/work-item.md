# Work Item — [WAS-V2-3-CLIENT] Defensive fallback en discovery para v2 schema drift

> Jira: WKH-57 (https://ferrosasfp.atlassian.net/browse/WKH-57)
> ID estable: WAS-V2-3-CLIENT

## Resumen

`wasiai-v2` devuelve el precio del agente en el campo `price_per_call` (no `price_per_call_usdc`). El registry de wasiai-v2 tiene `agentMapping.price = 'price_per_call_usdc'`, pero cuando ese campo es `null` o `undefined` en la respuesta, `mapAgent` colapsa a `priceUsdc = 0`. Con `priceUsdc = 0`, el guard de `invokeAgent` en `compose.ts` (línea `if (agent.priceUsdc > 0)`) nunca ejecuta el downstream Fuji USDC settle, rompiendo el path E2E de pago. La solución es agregar un fallback en `mapAgent` (y opcionalmente en `getAgent`) para leer `price_per_call` cuando `price_per_call_usdc` es nulo, sin modificar wasiai-v2 ni cambiar el comportamiento cuando `price_per_call_usdc` tiene valor.

---

## Sizing

- SDD_MODE: mini
- Estimacion: S
- Pipeline: QUALITY — toca path indirecto de pagos; un bug aqui puede causar cobros dobles o skips silenciosos en downstream settle
- Branch sugerido: `feat/057-wkh-57-was-v2-3-client`
- Estimado dev: ~30-45 min en F3

## Smart Sizing — Clasificacion

**QUALITY** — Justificacion:
1. El fix modifica `mapAgent`, que es invocado en TODOS los paths de discovery: `discover`, `queryRegistry`, y `getAgent`. Cualquier regresion afecta el catalogo entero.
2. El path afectado (`priceUsdc` incorrecto) impacta directamente el guard de pago en `compose.ts:L249` — un falso cero suprime silenciosamente el downstream x402 settle (Fuji USDC).
3. Aunque el cambio es pequenio (~5 lineas), el blast radius es amplio y requiere AR que verifique que el fallback no infle precios de forma inesperada.

## Skills Router

- **skill/schema-normalization** — field aliasing, null-coalescing, defensive type narrowing en boundary de API externa
- **skill/payment-path** — guard de pago en compose, downstream settle trigger, priceUsdc sematics

---

## Acceptance Criteria (EARS)

- **AC-1:** WHEN `mapAgent` processes a raw v2 agent response where `price_per_call_usdc` is `null` or `undefined` AND `price_per_call` is a numeric value (e.g. `0.05`), THEN the system SHALL set `agent.priceUsdc` equal to the numeric value of `price_per_call`.

- **AC-2:** WHEN `mapAgent` processes a raw v2 agent response where both `price_per_call_usdc` and `price_per_call` are populated with DISTINCT numeric values, THEN the system SHALL prefer `price_per_call_usdc` (canonical field) and SHALL NOT use `price_per_call` as the source.

- **AC-3:** WHEN `mapAgent` processes a raw agent response where both `price_per_call_usdc` and `price_per_call` are `null`, `undefined`, or absent, THEN the system SHALL set `agent.priceUsdc` to `0` (existing behavior preserved).

- **AC-4:** WHEN `composeService.compose` is invoked with a step whose agent has `priceUsdc > 0` resolved via the v2 fallback (i.e., `price_per_call_usdc` was null but `price_per_call` had a value), THEN the system SHALL enter the downstream Fuji USDC settle path in `invokeAgent`, initiating the `signAndSettleDownstream` call.

- **AC-5:** WHEN `mapAgent` reads `price_per_call` as a fallback AND that field is a string that is parseable to a finite number (e.g. `"0.05"`), THEN the system SHALL parse it to `number` and set `agent.priceUsdc` to that value; IF the string is not parseable (`"free"`, `"N/A"`), THEN the system SHALL set `agent.priceUsdc` to `0`.

- **AC-6:** WHEN `mapAgent` takes the `price_per_call` fallback path for a given slug, THEN the system SHALL emit exactly one `Logger.warn` (or `console.warn`) containing the slug and indicating the fallback was used; this warning SHALL appear at most once per `mapAgent` invocation (not deduplicated globally across slugs).

- **AC-7:** WHEN the full test suite runs after WAS-V2-3-CLIENT changes are applied, THEN all pre-existing tests (baseline 463) SHALL pass without modification, AND the new tests in `src/services/discovery.test.ts` SHALL cover: AC-1 (null canonical, numeric fallback), AC-2 (both populated — canonical wins), AC-3 (both null/undefined — zero), AC-5 happy path (string parseable), AC-5 sad path (non-numeric string — zero). AND at least one integration test in `src/services/compose.test.ts` SHALL verify that `signAndSettleDownstream` is called when `priceUsdc` is resolved via fallback.

---

## Codebase Grounding — Hallazgos clave

### Linea exacta del problema

`src/services/discovery.ts:229`:
```typescript
priceUsdc: Number(getNestedValue(raw, mapping.price ?? 'price') ?? 0),
```

- `mapping.price` para wasiai-v2 apunta a `'price_per_call_usdc'` (campo configurado en el registro del registry).
- Cuando v2 devuelve `price_per_call_usdc: null`, `getNestedValue` retorna `null`.
- `null ?? 0` colapsa a `0`.
- `Number(0)` = `0`.

### Donde se usa `priceUsdc` en compose

`src/services/compose.ts:249`:
```typescript
if (agent.priceUsdc > 0) {
```
Este guard controla si se construye el payment header y se llama `signAndSettleDownstream`. Con `priceUsdc = 0`, todo el bloque de pago se salta silenciosamente.

### `getAgent` vs `mapAgent`

`getAgent` (linea 249-276 de discovery.ts) llama internamente a `this.mapAgent(registry, data)`. El fix en `mapAgent` cubre automaticamente el path de `getAgent` que usa `composeService.resolveAgent`.

### `AgentFieldMapping.price` (src/types/index.ts:84)

El campo `price?: string` en `AgentFieldMapping` es el path al campo de precio en la respuesta del registry. Para wasiai-v2, este path apunta a `price_per_call_usdc`. El fallback debe leer un campo secundario cuando el primario es null — esto NO requiere cambiar `AgentFieldMapping` porque el fallback es logica interna de `mapAgent`, no configuracion del registry.

---

## Scope IN

| Archivo | Tipo | Operacion |
|---------|------|-----------|
| `src/services/discovery.ts` | service | Modificar: `mapAgent` — agregar fallback `price_per_call` cuando `mapping.price` path devuelve null/undefined; agregar `console.warn` cuando se toma el fallback |
| `src/services/discovery.test.ts` | test | Agregar: 5 nuevos tests cubriendo AC-1, AC-2, AC-3, AC-5 (happy+sad path) |
| `src/services/compose.test.ts` | test | Agregar: 1 test de integracion que mockea agente v2 con `priceUsdc` resuelto via fallback y verifica que `signAndSettleDownstream` es llamado |

---

## Scope OUT

- `src/types/index.ts` — NO modificar `AgentFieldMapping`; el fallback es logica interna, no cambio de schema de configuracion
- `wasiai-v2` source — NO tocar; esta HU es la mitigacion client-side
- `src/services/compose.ts` — NO tocar el guard de pago ni `invokeAgent`; la correccion es upstream en `mapAgent`
- Otros paths de discovery: `discover`, `queryRegistry` — el fix en `mapAgent` los cubre automaticamente, no requieren cambios directos
- `src/services/registry.ts` — fuera de scope
- `doc/sdd/055-*`, `doc/sdd/056-*` — ya cerrados, NO reabrir
- `supabase/migrations/` — ningun cambio de DB necesario

---

## Decisiones tecnicas (DT-N)

- **DT-A (OPEN):** Configuracion del nombre del campo fallback — opciones: (a) hardcodear `'price_per_call'` como fallback literal dentro de `mapAgent` (simple, acoplado a wasiai-v2 schema); (b) agregar un campo opcional `priceAltPath?: string` a `AgentFieldMapping` (flexible, pero expande el tipo publico). La opcion (a) es preferida segun CD-conservador (no expandir scope); si Architect elige (b), debe documentar en SDD. El riesgo de (a) es que si v2 cambia el nombre del campo alternativo, hay que hardcodear otro fallback. El riesgo de (b) es complejidad de configuracion innecesaria para un solo registry.

- **DT-B (OPEN):** Scope del `console.warn` por fallback — opciones: (a) warn incondicional en cada llamada a `mapAgent` que toma el fallback (simple, puede generar noise en logs si el discovery llama mapAgent para muchos agentes); (b) Set en memoria por slug para deduplicar advertencias (evita noise, pero introduce estado mutable en el modulo). Dado que `mapAgent` es llamado per-agente y el endpoint `/discover` puede devolver N agentes en batch, la opcion (a) puede generar N warnings por request. La opcion (b) es mas limpia para produccion pero introduce estado global. Architect decide; si la deduplicacion no importa para el hackathon, (a) es suficiente.

- **DT-C (RESUELTO):** Parsing de string a number para AC-5 — usar `parseFloat(value)` con check `isFinite(result)`. Si no es finito, retornar 0. Esto cubre strings como `"0.05"`, `"1"`, pero rechaza `"free"`, `"N/A"`, `"Infinity"`.

---

## Constraint Directives (CD-N)

- **CD-1:** PROHIBIDO usar `any` explicito en TypeScript — strict mode.
- **CD-2:** OBLIGATORIO backward-compat — si `price_per_call_usdc` esta populado con un valor numerico (incluso 0.0), ese valor es el canonical y NO se lee `price_per_call`.
- **CD-3:** OBLIGATORIO `Logger.warn` (o `console.warn`) cuando se toma el fallback — al menos un warning por invocacion de `mapAgent` que use la ruta alternativa.
- **CD-4:** OBLIGATORIO que el fallback acepte strings parseables a numero (AC-5) — no asumir que `price_per_call` siempre es `number`.
- **CD-5:** OBLIGATORIO que el baseline de 463 tests quede verde — 0 regresion.
- **CD-6:** PROHIBIDO modificar `wasiai-v2` source ni la configuracion del registry en DB — la fix es puramente client-side en `mapAgent`.
- **CD-7:** PROHIBIDO que el fallback infle precio — si el campo fallback contiene un valor negativo o NaN, el sistema SHALL usar 0 (safe floor).

---

## Missing Inputs

- **[OPEN] DT-A:** Nombre del campo alternativo — el ticket dice `price_per_call`. Verificar con `curl` al endpoint real de wasiai-v2 antes de F3 si el nombre exacto del campo es `price_per_call` o podria ser `price_per_call_amount` u otra variante. Si no se puede verificar antes de F3, hardcodear `'price_per_call'` como dice el ticket y documentar asuncion en SDD.
- **[OPEN] DT-B:** Deduplicacion del warn — resolver en F2.
- **[RESUELTO]** Linea exacta del bug — `src/services/discovery.ts:229` confirmado por lectura del codigo.
- **[RESUELTO]** Blast radius — el fix en `mapAgent` cubre automaticamente `getAgent`, `queryRegistry` y `discover`. No se necesitan cambios adicionales en rutas.

---

## Analisis de paralelismo

- Esta HU NO bloquea otras HUs activas conocidas.
- WAS-V2-3-CLIENT NO tiene dependencias en WKH-56 ni WKH-57 LLM Bridge Pro (ya mergeados a main).
- Overlap con WKH-26 (Hardening) y WKH-37 (x402-v2): bajo riesgo — WAS-V2-3-CLIENT toca solo `discovery.ts` y tests; no hay conflicto con esas ramas en vuelo.
- Branch `feat/057-wkh-57-was-v2-3-client` puede abrirse desde `main` actual sin conflicto.
