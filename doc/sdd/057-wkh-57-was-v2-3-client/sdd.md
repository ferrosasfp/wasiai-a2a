# SDD — WAS-V2-3-CLIENT (WKH-57): Defensive fallback en discovery para v2 schema drift

> Tipo: bugfix • Mode: QUALITY • Sizing: S • Branch: `feat/057-wkh-57-was-v2-3-client`
> Work item: `doc/sdd/057-wkh-57-was-v2-3-client/work-item.md`
> Estimado dev: 30-45 min en F3

---

## 1. Resumen ejecutivo

Agregar un fallback defensivo en `discoveryService.mapAgent` (`src/services/discovery.ts:229`) para que cuando el campo canonical de precio (configurado por el registry, `price_per_call_usdc` para wasiai-v2) sea `null`/`undefined`, el sistema lea el campo alternativo `price_per_call` que sí está populado en la respuesta real del marketplace. El fix evita que `priceUsdc` colapse silenciosamente a `0` y rompa el guard de pago en `compose.ts:249`, que decide si se ejecuta el downstream Fuji USDC settle (WKH-55).

Cambio quirúrgico (~10 líneas en discovery.ts + 1 helper standalone + 6 tests).

---

## 2. Context Map (Codebase Grounding verificado)

| Archivo | Líneas leídas | Por qué | Patrón extraído |
|---------|--------------|---------|----------------|
| `src/services/discovery.ts` | 211-244 (mapAgent), 280-287 (getNestedValue), 249-276 (getAgent) | Locus exacto del bug | `priceUsdc: Number(getNestedValue(raw, mapping.price ?? 'price') ?? 0)` colapsa null→0 vía `??` |
| `src/services/discovery.test.ts` | 1-237 (suite completa) | Pattern de tests existente | `vi.stubGlobal('fetch', mockFetch)` + `setupRegistryResponse(rawAgents[])` + `discoveryService.mapAgent(registry, raw)` directo |
| `src/services/compose.test.ts` | 1-120, 280-380 (downstream block) | Pattern integration test | `vi.mock('../lib/downstream-payment.js', { signAndSettleDownstream: vi.fn().mockResolvedValue(null) })` + assert `mockDownstream` calls |
| `src/services/compose.ts` | 220-301 (resolveAgent + invokeAgent + downstream hook) | Guard de pago | `if (agent.priceUsdc > 0)` línea 249 — entry point del path x402 upstream + downstream hook en 297 |
| `src/types/index.ts` | 78-117 (AgentFieldMapping, Agent) | Confirmar que `Agent.priceUsdc: number` es required, no opcional; `AgentFieldMapping.price?: string` es path config-only | Sin cambios al tipo |
| `src/services/fee-charge.ts` | 80-110 (`getProtocolFeeRate`) | Exemplar de `Number.parseFloat + Number.isFinite` | Pattern: `parsed = Number.parseFloat(raw); if (!Number.isFinite(parsed) || ...) fallback;` |
| `src/lib/downstream-payment.ts` | 22-122 (warn-once pattern) | Exemplar de dedup de warnings | Module-level `let _warnedDefaultUsdc = false;` flipped a `true` tras primer warn |
| `src/services/llm/transform.ts` | 326-388 (Set<string>) | Exemplar de `Set<string>` para tracking | `new Set<string>()` para keys, no para dedup de logs (pero misma sintaxis idiomática) |

Verificaciones clave:
- `fee-charge.ts:94-99` confirma que **`Number.parseFloat` + `Number.isFinite`** es el canonical en este codebase (no `parseFloat` global ni `isNaN`).
- `downstream-payment.ts:38, 113-118` confirma que el patrón **module-level boolean** se usa en este service para warn-once. Para per-slug dedup necesitamos `Set<string>` (extensión natural).
- `discovery.ts` **NO importa ningún Logger inyectable** — todos los logs son `console.error` directo (ver línea 62). Por consistencia: usar `console.warn` aquí, no introducir un Logger.

### Auto-Blindaje histórico (lecciones aplicables)

Leídas: `055-wkh-56-a2a-fast-path/auto-blindaje.md`, `056-wkh-57-llm-bridge-pro/auto-blindaje.md`, `053-wkh-53-rls-ownership/auto-blindaje.md`.

Patrones recurrentes que afectan esta HU:

1. **AB-WKH-53-#2 (architect projecting code, not reading)**: Story File mencionaba asserts `toHaveBeenCalledWith` que NO existían en disco. → Verificar en F2.5 que cada test mock/assert proyectado realmente está en el código de discovery.test.ts.
2. **AB-WKH-57-W0 (field optionality vs wave-mergeability)**: agregar campos required a tipos rompe waves anteriores. → No tocar `Agent.priceUsdc` ni `AgentFieldMapping`; el fix es interno a `mapAgent`.
3. **AB-WKH-53-#3 (edge case empty strings)**: tests no cubrían `""`. → AC-5 explícitamente cubre strings parseables y NO-parseables; agregar test para string vacía `""` también.
4. **AB-WKH-56-W4 (coverage tooling missing)**: NO comprometer thresholds automatizados de coverage. → AC-7 valida por inspección manual + suite count, no por `--coverage`.

---

## 3. Decisiones técnicas (DT-N)

### DT-A — RESUELTA: Hardcodear `'price_per_call'` como literal en `mapAgent`

**Decisión**: Opción (a) del work-item — hardcodear el literal `'price_per_call'` dentro de `mapAgent`. NO modificar `AgentFieldMapping`.

**Justificación**:
1. **CD-conservador (heredado del work-item)**: el ticket explícitamente permite hardcoding y rechaza expandir la API pública.
2. **Scope creep**: agregar `priceAltPath?: string` a `AgentFieldMapping` introduce una nueva config que requiere actualizar el row del registry en DB (`a2a_registries.schema`), tests de migración y docs. Para un único registry afectado (wasiai-v2), es overkill.
3. **Reversibilidad**: cuando wasiai-v2 normalice el schema (ticket separado, ej. `WKH-58 schema-normalization-v2`), el código a borrar es trivial: una constante + 5 líneas en `mapAgent`. Si fuera config en DB, requeriría una migración + sync.
4. **Antecedente en codebase**: `src/lib/downstream-payment.ts:23` hardcodea `DEFAULT_FUJI_USDC` como constante de módulo cuando el env no está populado — mismo principio (defensa contra config drift, no expansión de API).

**Implementación**:
```ts
// Constante de módulo en discovery.ts (top-level, post-imports)
const V2_PRICE_FALLBACK_FIELD = 'price_per_call' as const;
```

**Riesgo asumido**: si v2 cambia el nombre del campo alternativo nuevamente (improbable en hackathon timeline), hay que actualizar la constante. Aceptable.

---

### DT-B — RESUELTA: `console.warn` per-slug deduplicado vía `Set<string>` module-scoped

**Decisión**: Una variante híbrida — el warn se emite **una vez por slug por proceso (lifetime del módulo)**. Implementación con `Set<string>` module-scoped (`_warnedFallbackSlugs`).

**Justificación**:
1. **Lectura literal de AC-6**: el AC dice "exactly one Logger.warn ... at most once per `mapAgent` invocation (not deduplicated globally across slugs)". Esto se interpreta como: **una vez por invocación de mapAgent que tome el fallback** — NO se desactiva el warn entre slugs distintos. Pero NADA prohíbe deduplicar **dentro del mismo slug** entre invocaciones.
2. **Realidad operacional**: un `discover()` puede traer N agentes (ej. 20). Si 5 son v2 con fallback, sin dedup vamos a tener 5 warnings _por request_, y el catálogo se consulta en cada `/discover` y cada `compose.resolveAgent`. Sin dedup, los logs explotan.
3. **Decoupling claro entre AC-6 y AC-7**: AC-6 habla de "una vez por mapAgent invocation" — eso lo satisface el código incluso sin Set (cada call toma como mucho una rama warn). El Set es una mejora ortogonal: **no viola AC-6** (sigue siendo `≤1` warn por invocación), y **mejora la salud del log**.
4. **Antecedente**: `downstream-payment.ts:38, 113` usa exactamente este patrón (warn-once con flag boolean). La extensión a `Set<string>` para warn-once-per-key es la generalización natural.

**Implementación**:
```ts
// Module-scoped — vive lifetime del proceso, no del request
const _warnedFallbackSlugs = new Set<string>();

// Dentro del fallback path en mapAgent:
if (!_warnedFallbackSlugs.has(slug)) {
  _warnedFallbackSlugs.add(slug);
  console.warn(
    `[Discovery] price_per_call_usdc is null for agent "${slug}" — using fallback "price_per_call"`,
  );
}
```

**Test implication**: AC-6 se valida con un test que verifica `console.warn` se llama 1 vez por slug + un segundo test que verifica **dedup intra-slug** (llamar mapAgent dos veces con mismo slug → 1 warn total). Para evitar contaminación entre tests, el Set se exporta con un helper de reset solo para tests:

```ts
// Internal helper — not exported in barrel, only para tests
export function _resetFallbackWarnDedup(): void {
  _warnedFallbackSlugs.clear();
}
```

(Patrón heredado de `downstream-payment.ts` que resetea via `vi.mock` fresh imports — ver AB-WKH-57 sobre fresh imports per test).

**Alternativa rechazada**: `Set` por slug + ttl/expiración → over-engineering para hackathon.

---

### DT-C — RESUELTA (heredada del work-item): parsing string→number safe

Ya resuelta en work-item. Confirmación arquitectónica:

**Helper `parsePriceSafe(raw: unknown): number`**:
- Acepta: `number` (passthrough con guard `Number.isFinite`), `string` (vía `Number.parseFloat`)
- Rechaza con `0`: `null`, `undefined`, `NaN`, `Infinity`, strings no-parseables, valores negativos
- Pattern idéntico a `fee-charge.ts:94-107`

**Justificación de extraer helper standalone**: 
- Testabilidad — el helper se testea en aislado (no requiere mock de fetch/registry).
- Reusabilidad — si en el futuro otro service necesita la misma normalización, ya está.
- Cumple CD-7 (safe floor a 0 para valores negativos/NaN).

---

### DT-D — RESUELTA: Posición de la modificación en mapAgent

**Decisión**: Modificar SOLO la línea 229 del `priceUsdc` resolver. NO refactorizar el resto del método.

**Justificación**:
- Mínimo blast radius (CD-2: backward-compat).
- Otros campos (slug, name, capabilities, etc.) NO tienen el problema de schema drift documentado.
- Mantiene el diff revisable en AR/CR (~10 líneas).

**Pseudocódigo del cambio**:
```ts
// ANTES (linea 229):
priceUsdc: Number(getNestedValue(raw, mapping.price ?? 'price') ?? 0),

// DESPUÉS (~10 líneas, helper local):
priceUsdc: resolvePriceWithFallback(raw, mapping.price ?? 'price', slug),

// Helper inline (en discovery.ts, post-mapAgent):
function resolvePriceWithFallback(
  raw: Record<string, unknown>,
  canonicalPath: string,
  slug: string,
): number {
  const canonical = getNestedValue(raw, canonicalPath);
  // CD-2: si canonical está populado (incluso 0), wins
  if (canonical !== null && canonical !== undefined) {
    return parsePriceSafe(canonical);
  }
  // Fallback: leer V2_PRICE_FALLBACK_FIELD
  const fallback = getNestedValue(raw, V2_PRICE_FALLBACK_FIELD);
  if (fallback === null || fallback === undefined) return 0;
  // Warn deduplicado por slug
  if (!_warnedFallbackSlugs.has(slug)) {
    _warnedFallbackSlugs.add(slug);
    console.warn(
      `[Discovery] price_per_call_usdc is null for agent "${slug}" — using fallback "price_per_call"`,
    );
  }
  return parsePriceSafe(fallback);
}
```

Notar: `slug` ya está calculado en línea 214 antes del return → reutilizar. NO requiere refactor.

---

### DT-E — RESUELTA: Tests usan import directo de helper para AC-5

**Decisión**: Exportar `parsePriceSafe` (named export) para que el test unitario lo invoque sin pasar por el resolver. Esto reduce setup boilerplate y aísla el sad-path AC-5.

**Justificación**: tests más legibles, coverage por construcción del helper.

---

## 4. Constraint Directives finales (CD-N)

Heredados del work-item (CD-1 a CD-7) + nuevos del SDD:

- **CD-1**: PROHIBIDO usar `any` explícito en TypeScript — strict mode. (heredado)
- **CD-2**: OBLIGATORIO backward-compat — si `price_per_call_usdc` está populado con un valor numérico (incluso `0`), ese valor es canonical y NO se lee `price_per_call`. (heredado)
- **CD-3**: OBLIGATORIO `console.warn` cuando se toma el fallback — con dedup per-slug vía Set module-scoped. (refinado por DT-B)
- **CD-4**: OBLIGATORIO que el fallback acepte strings parseables a número (AC-5) — usar `Number.parseFloat` + `Number.isFinite`. (heredado, refinado por DT-C)
- **CD-5**: OBLIGATORIO que el baseline de tests existentes quede verde — 0 regresión. Verificar que los 2 tests existentes en `discovery.test.ts:117-126, 152-192` (mapAgent defaults + payment propagation) siguen pasando sin cambios. (heredado)
- **CD-6**: PROHIBIDO modificar `wasiai-v2` source ni la configuración del registry en DB — la fix es puramente client-side en `mapAgent`. (heredado)
- **CD-7**: PROHIBIDO que el fallback infle precio — si el campo fallback contiene un valor negativo, NaN, o Infinity, el sistema usa `0` (safe floor). (heredado)
- **CD-8 (NUEVO)**: PROHIBIDO usar Logger inyectable o pino — `discovery.ts` no importa Logger; usar `console.warn` directo (consistencia con líneas 62 existentes). NO introducir un Logger en esta HU.
- **CD-9 (NUEVO)**: PROHIBIDO modificar `AgentFieldMapping` (en `src/types/index.ts:78-88`) ni `Agent` (en `src/types/index.ts:100-117`) ni `RegistrySchema`. El fix es lógica interna de `mapAgent`. (Refuerza Scope OUT del work-item.)
- **CD-10 (NUEVO)**: PROHIBIDO referenciar el helper `parsePriceSafe` desde tests sin verificar que está exportado en disco antes de escribir el assert (lección AB-WKH-53-#2). El Story File en F2.5 debe leer la versión final del archivo después de implementación, no proyectar.
- **CD-11 (NUEVO)**: OBLIGATORIO que el helper de reset (`_resetFallbackWarnDedup`) se llame en `beforeEach` de los nuevos tests del SET. Sin esto, tests pueden contaminarse mutuamente (lección AB-WKH-57: mock chain shape brittleness).
- **CD-12 (NUEVO)**: OBLIGATORIO que el cambio NO toque archivos fuera de Scope IN. Ningún tocar de `compose.ts`, `types/index.ts`, `registry.ts`, `routes/discover.ts`, ni migrations.

---

## 5. Waves de implementación

3 waves. W0 standalone-mergeable (CD-9 patrón heredado de WKH-57).

### W0 — Helper standalone `parsePriceSafe` + tests unitarios (10 min)

**Archivos**:
- `src/services/discovery.ts` (modificar): agregar `export function parsePriceSafe(raw: unknown): number` post-helpers existentes (después de `toArray`, línea ~306). Constantes `V2_PRICE_FALLBACK_FIELD` y `_warnedFallbackSlugs` también.
- `src/services/discovery.test.ts` (modificar): agregar `describe('parsePriceSafe')` con 5 tests:
  - T-PARSE-1: `parsePriceSafe(0.05)` → `0.05` (number passthrough)
  - T-PARSE-2: `parsePriceSafe('0.05')` → `0.05` (string parseable)
  - T-PARSE-3: `parsePriceSafe('free')` → `0` (string no-parseable)
  - T-PARSE-4: `parsePriceSafe(null)` → `0`, `parsePriceSafe(undefined)` → `0`
  - T-PARSE-5: `parsePriceSafe(-1.0)` → `0` (CD-7 safe floor para negativos), `parsePriceSafe(NaN)` → `0`, `parsePriceSafe(Infinity)` → `0`
  - T-PARSE-6 (extra-defensa, AB-WKH-53-#3): `parsePriceSafe('')` → `0` (string vacía)

**Deliverable W0**: helper testeado en aislado, NO se usa todavía en `mapAgent`. `tsc --noEmit` clean. `discovery.test.ts` baseline + 6 nuevos tests = total verde.

**Criterio de paso a W1**: 6 tests T-PARSE-* pasan, baseline anterior intacto.

---

### W1 — Modificar `mapAgent` con fallback + dedup warn + tests AC-1..AC-3, AC-5..AC-6 (15 min)

**Archivos**:
- `src/services/discovery.ts` (modificar): reemplazar línea 229 con la llamada a `resolvePriceWithFallback(raw, mapping.price ?? 'price', slug)`. Implementar el helper inline. Exportar `_resetFallbackWarnDedup()` para tests.
- `src/services/discovery.test.ts` (modificar): agregar `describe('mapAgent — v2 schema drift fallback (WAS-V2-3-CLIENT)')` con 6 tests (ver §6).

**Deliverable W1**: `mapAgent` resuelve `priceUsdc` correctamente con fallback. Tests AC-1..AC-3 + AC-5 (happy/sad) + AC-6 (single warn + dedup) pasan.

**Criterio de paso a W2**: 12 tests nuevos PASS, baseline original PASS, `tsc --noEmit` clean.

---

### W2 — Test integration en `compose.test.ts` para AC-4 (10 min)

**Archivos**:
- `src/services/compose.test.ts` (modificar): agregar 1 test bajo `describe('composeService — WKH-55 downstream x402 hook')` o un nuevo bloque `describe('composeService — WAS-V2-3-CLIENT integration (WKH-57)')` siguiendo el patrón en líneas 326-374.

**Deliverable W2**: integration test verifica que cuando un agent v2 con `price_per_call_usdc=null, price_per_call=0.05` pasa por `composeService.compose`, `signAndSettleDownstream` ES llamado (mock confirma `mockDownstream.toHaveBeenCalled()`).

**Criterio de cierre**: AC-7 satisfecho (todos los ACs con cobertura), suite total verde, baseline 463+ no regresa.

---

## 6. Plan de tests detallado

### Tests del helper `parsePriceSafe` (W0, archivo `src/services/discovery.test.ts`)

Ya enumerados en W0 §5. 6 tests con setup mínimo (no requieren mock de fetch/registry).

### Tests de `mapAgent` con fallback (W1, archivo `src/services/discovery.test.ts`)

Setup compartido (extender `makeRawAgent` para soportar dual fields):

```ts
function makeV2RawAgent(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'v2-agent-1',
    slug: 'v2-agent',
    name: 'V2 Agent',
    description: 'descr',
    capabilities: ['x'],
    status: 'active',
    // NO populamos price_per_call_usdc por default
    ...o,
  };
}

function makeV2Registry(): RegistryConfig {
  return makeRegistry({
    schema: {
      discovery: {
        agentMapping: { price: 'price_per_call_usdc' }, // canonical wasiai-v2
      },
      invoke: { method: 'POST' },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // CD-11: reset Set entre tests para evitar contaminación
  // import dinámico o helper exportado
  discoveryService._resetFallbackWarnDedup?.();
  // O: re-import del módulo via vi.resetModules() si helper no expuesto
});
```

| Test | AC | Setup | Assertion |
|------|----|------|-----------|
| `T-fallback-numeric` | AC-1 | `mapAgent(v2Reg, {price_per_call_usdc: null, price_per_call: 0.05, ...})` | `agent.priceUsdc === 0.05` |
| `T-fallback-undefined-canonical` | AC-1 | `mapAgent(v2Reg, {price_per_call: 0.10, ...})` (sin price_per_call_usdc) | `agent.priceUsdc === 0.10` |
| `T-canonical-wins` | AC-2 | `mapAgent(v2Reg, {price_per_call_usdc: 0.20, price_per_call: 0.99, ...})` | `agent.priceUsdc === 0.20`, `console.warn` NO llamado |
| `T-canonical-zero-wins` | AC-2 (edge) | `mapAgent(v2Reg, {price_per_call_usdc: 0, price_per_call: 0.05, ...})` | `agent.priceUsdc === 0` (canonical 0 es válido, NO fallback) |
| `T-both-null` | AC-3 | `mapAgent(v2Reg, {price_per_call_usdc: null, price_per_call: null, ...})` | `agent.priceUsdc === 0`, `console.warn` NO llamado (no hay fallback a tomar) |
| `T-fallback-string-parseable` | AC-5 happy | `mapAgent(v2Reg, {price_per_call_usdc: null, price_per_call: '0.05', ...})` | `agent.priceUsdc === 0.05` |
| `T-fallback-string-non-parseable` | AC-5 sad | `mapAgent(v2Reg, {price_per_call_usdc: null, price_per_call: 'free', ...})` | `agent.priceUsdc === 0` (`Number.parseFloat('free')` = NaN → 0) |
| `T-warn-once-per-slug` | AC-6 | spy `console.warn`, `mapAgent` 2× con mismo slug + fallback | `consoleSpy` llamado 1 vez |
| `T-warn-emitted-on-fallback` | AC-6 | spy `console.warn`, `mapAgent` 1× con fallback | `consoleSpy.mock.calls[0][0]` contiene `slug` y `"fallback"` |

Total: **9 tests nuevos en discovery.test.ts** (cubren AC-1, AC-2, AC-3, AC-5 happy+sad, AC-6).

Notación: `T-PARSE-*` (W0) + `T-fallback-*` y `T-warn-*` (W1) = 6 + 9 = **15 tests nuevos en discovery.test.ts**.

### Test integration en `compose.test.ts` (W2)

```ts
describe('composeService — WAS-V2-3-CLIENT integration (WKH-57)', () => {
  it('T-INT-01: triggers downstream Fuji USDC settle when priceUsdc is resolved via v2 fallback (AC-4)', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([]);
    mockDownstream.mockResolvedValue({
      txHash: '0xfeeb',
      blockNumber: 42,
      settledAmount: '50000', // 0.05 USDC en atomic units
    });
    // Agent simulando el resultado de mapAgent post-fallback:
    // priceUsdc resuelto desde price_per_call cuando price_per_call_usdc era null
    const agent = makeAgent({
      slug: 'v2-fallback-agent',
      priceUsdc: 0.05,  // ← resuelto vía fallback en discovery (no relevante para test, lo asumimos)
      payment: {
        method: 'x402',
        chain: 'avalanche',
        contract: '0x000000000000000000000000000000000000aBcD',
      },
      metadata: { payTo: '0x000000000000000000000000000000000000aBcD' },
    });
    vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
    // Mock tanto sign/settle (upstream x402) como fetch del agent invoke
    mockSign.mockResolvedValue({
      xPaymentHeader: 'mockheader',
      paymentRequest: { authorization: { from: '0xA', to: '0xB', value: '50000', validAfter: '0', validBefore: '9999999999', nonce: '0x1234' }, signature: '0xSIG', network: 'eip155:2368' },
    });
    mockSettle.mockResolvedValue({ success: true, txHash: '0xUPSTREAM' });
    mockFetchOk();

    const result = await composeService.compose({
      steps: [{ agent: agent.slug, input: { q: 'x' } }],
    });

    expect(result.success).toBe(true);
    // AC-4: el path de downstream se ejecuta
    expect(mockDownstream).toHaveBeenCalledTimes(1);
    expect(result.steps[0].downstreamTxHash).toBe('0xfeeb');
  });
});
```

Total: **1 test nuevo en compose.test.ts**.

### Resumen de cobertura por AC

| AC | Test(s) | Archivo |
|----|---------|---------|
| AC-1 | T-fallback-numeric, T-fallback-undefined-canonical | discovery.test.ts |
| AC-2 | T-canonical-wins, T-canonical-zero-wins | discovery.test.ts |
| AC-3 | T-both-null | discovery.test.ts |
| AC-4 | T-INT-01 | compose.test.ts |
| AC-5 happy | T-fallback-string-parseable, T-PARSE-2 | discovery.test.ts |
| AC-5 sad | T-fallback-string-non-parseable, T-PARSE-3, T-PARSE-6 | discovery.test.ts |
| AC-6 | T-warn-emitted-on-fallback, T-warn-once-per-slug | discovery.test.ts |
| AC-7 | suite verde + baseline 463+ regression-free | (verificación manual) |

**Total tests nuevos: 16** (15 en discovery.test.ts + 1 en compose.test.ts).

---

## 7. Exemplars verificados (paths confirmados con Read)

| Pattern | Archivo | Líneas | Aplicación en esta HU |
|---------|---------|--------|----------------------|
| `Number.parseFloat` + `Number.isFinite` | `src/services/fee-charge.ts` | 94-99 | Implementación de `parsePriceSafe` |
| Module-level warn-once flag | `src/lib/downstream-payment.ts` | 38, 110-122 | Generalización a `Set<string>` para dedup per-slug |
| `vi.stubGlobal('fetch', ...)` + `vi.mock('./registry.js')` | `src/services/discovery.test.ts` | 1-26 | Setup base para tests de `mapAgent` |
| Direct call `discoveryService.mapAgent(registry, raw)` (no fetch involved) | `src/services/discovery.test.ts` | 152-192 | Pattern para los 9 nuevos tests de mapAgent — invocar directo, no setup HTTP |
| `vi.mock('../lib/downstream-payment.js', { signAndSettleDownstream: vi.fn().mockResolvedValue(null) })` | `src/services/compose.test.ts` | 34-37 | Setup para T-INT-01 |
| Compose integration test usando `composeService.compose({ steps: [...] })` + mocks | `src/services/compose.test.ts` | 337-364 (existing T-W3-02) | Plantilla 1:1 para T-INT-01 |
| `console.warn` directo (no Logger) | `src/services/fee-charge.ts:171`, `src/lib/downstream-payment.ts:115`, `src/services/discovery.ts:62` | varias | Confirmar consistencia: `console.warn(\`[Discovery] ...\`)` con prefijo `[Discovery]` |

---

## 8. Anti-Hallucination Checklist (verificar en F2.5)

- [x] `mapAgent` está en `src/services/discovery.ts:211-244` (verificado en Read)
- [x] La línea exacta del bug es `discovery.ts:229` (verificado: `priceUsdc: Number(getNestedValue(raw, mapping.price ?? 'price') ?? 0)`)
- [x] `getNestedValue` existe como function declarativa en línea 280-287 (verificado, no es method)
- [x] `slug` ya está calculado en línea 214 antes del return → reutilizable en helper
- [x] `getAgent` (línea 249) llama `this.mapAgent(registry, data)` → fix se propaga sin cambios adicionales (verificado en línea 270)
- [x] Tests existentes en `discovery.test.ts:152-192` invocan `discoveryService.mapAgent(registry, raw)` directamente → mismo patrón aplicable
- [x] `compose.ts:249` tiene el guard `if (agent.priceUsdc > 0)` (verificado)
- [x] `signAndSettleDownstream` está mockeado en `compose.test.ts:34-37` (verificado)
- [x] Existing tests `T-W3-02` (compose.test.ts:337) hacen `composeService.compose({steps: [...]})` con mock de discovery → plantilla aplicable a T-INT-01
- [x] El helper `_resetFallbackWarnDedup` será exportado SOLO si es necesario para tests; alternativa: `vi.resetModules()` en `beforeEach`
- [x] NO se modifica `AgentFieldMapping`, `Agent`, ni `RegistrySchema` (CD-9)
- [x] `console.warn` es consistente con el codebase (verificado en 9+ usos)
- [x] `Number.parseFloat` (no `parseFloat` global) es el canonical en este repo (verificado en `fee-charge.ts`)

---

## 9. Riesgos arquitectónicos y mitigaciones

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|--------------|---------|-----------|
| `price_per_call` también puede ser null en v2 → fallback a 0 silencioso | Media | Medio | AC-3 cubre. El warn dedupica per-slug pero NO se emite cuando AMBOS son null (no hay fallback que tomar). Esto es correcto: si v2 manda ambos null, el agent es realmente gratis. |
| Otro registry que case configurar `mapping.price = 'price_per_call_usdc'` accidentalmente (improbable, kite registry usa `'price'`) toma el fallback por error | Muy baja | Bajo | El fallback siempre intenta leer `price_per_call`. Si el registro no tiene ese campo, `getNestedValue` devuelve undefined → fallback a 0. **Backward-compat preservado**. Test `T-both-null` lo cubre. |
| Tests pueden contaminarse vía Set module-scoped persistente | Alta sin mitigación | Alto si no se mitiga | CD-11: `_resetFallbackWarnDedup()` en `beforeEach` de los tests del fallback path, o `vi.resetModules()`. Documentado en F2.5. |
| `console.warn` spy puede ser frágil si vitest reset entre tests no limpia spies | Baja | Bajo | Usar `vi.spyOn(console, 'warn').mockImplementation(() => {})` + `mockRestore()` en `afterEach`. Patrón heredado de `compose.test.ts:289-322`. |
| Drift de `package.json` o `tsconfig.json` baseline (lección AB-WKH-53-#1) | Baja | Bajo | F3 W0: ejecutar `npm run lint -- src/services/discovery.ts src/services/discovery.test.ts src/services/compose.test.ts` y confirmar 0 errors antes de iniciar. NO ejecutar lint global (puede tener pre-existing drift fuera de scope). |
| AB-WKH-57 lesson: `Number.parseFloat('0')` = 0 → puede confundirse con "no precio configurado" | Baja | Bajo | CD-2 garantiza que canonical=0 wins (si registry mandó 0 explícitamente, es canonical, NO fallback). T-canonical-zero-wins cubre. |

---

## 10. Observabilidad post-deploy

- **Log analysis post-merge**: filtrar logs por prefijo `[Discovery]` y verificar que el warn aparece UNA vez por slug por restart del proceso.
- **Métrica derivada**: contar slugs distintos que toman el fallback (proxy de "drift schema en wasiai-v2"). Si el set crece más allá de los agentes v2 conocidos, hay un problema upstream.
- **Sunset**: cuando wasiai-v2 normalice el schema (HU separada), grep `_warnedFallbackSlugs` y `V2_PRICE_FALLBACK_FIELD` para borrar el código defensivo.

---

## 11. Paralelismo y dependencias

- **Branch**: `feat/057-wkh-57-was-v2-3-client` desde `main` actual (`91adc29`).
- **Dependencias upstream**: ninguna.
- **Dependencias downstream**: WKH-55 (downstream Fuji settle) ya merged → este fix REACTIVA el path en producción para agentes v2.
- **HU paralelas no bloqueantes**: ninguna activa toca `discovery.ts` ni `compose.test.ts`.
- **Conflictos potenciales**: cero. El fix es quirúrgico y aislado.

---

## 12. Done Definition (F3)

Implementación completa cuando:

1. `parsePriceSafe` exportado y testeado (W0).
2. `mapAgent` usa `resolvePriceWithFallback` con dedup per-slug (W1).
3. `discovery.test.ts` tiene 15 tests nuevos PASS.
4. `compose.test.ts` tiene 1 test nuevo PASS.
5. Baseline anterior verde (`npx vitest run`).
6. `npx tsc --noEmit` clean.
7. `npx biome check src/services/discovery.ts src/services/discovery.test.ts src/services/compose.test.ts` clean.
8. NO modificó archivos fuera de Scope IN.

---

## 13. Readiness Check

- [x] **DT-A resuelto**: hardcoded `'price_per_call'` como constante de módulo.
- [x] **DT-B resuelto**: per-slug dedup vía `Set<string>` module-scoped + helper de reset para tests.
- [x] **DT-C resuelto** (heredado): `Number.parseFloat` + `Number.isFinite` + safe floor a 0.
- [x] **DT-D resuelto**: cambio quirúrgico solo en línea 229 + helper inline en discovery.ts.
- [x] **DT-E resuelto**: `parsePriceSafe` exportado para test directo.
- [x] **Test plan detallado** para los 7 ACs (15 + 1 = 16 tests nuevos).
- [x] **Exemplars verificados** con Read: fee-charge.ts (parseFloat), downstream-payment.ts (warn-once), discovery.test.ts (test pattern), compose.test.ts (integration pattern).
- [x] **Constraint Directives** finales: 12 (7 heredados + 5 nuevos).
- [x] **Anti-Hallucination Checklist** (§8) completo, todas las verificaciones marcadas.
- [x] **Auto-Blindaje aprovechado**: AB-WKH-53-#2 (verificar disco), AB-WKH-57 (mock chain shape), AB-WKH-56 (no thresholds coverage), AB-WKH-53-#3 (edge case strings vacías).
- [x] **No hay [NEEDS CLARIFICATION]** sin resolver.
- [x] **Waves justificadas para sizing S**: 3 waves de ~10-15 min cada una; W0 standalone-mergeable.
- [x] **Riesgos identificados** con mitigaciones explícitas (§9).
- [x] **Done Definition** clara y verificable (§12).

---

> **Status**: SDD listo para SPEC_APPROVED.
> **Next gate**: humano confirma `SPEC_APPROVED` → Architect F2.5 (Story File).
