# Auto-Blindaje — WKH-57 (WAS-V2-3-CLIENT)

Lecciones sistematizadas de WKH-57 para futuras HUs. Consolidar con registros previos de WKH-53, WKH-55, WKH-56.

---

## AB-WKH-57-WAS-V2-3-CLIENT-1: Test isolation con mock chains residuales

**Tipo**: Architecture / Testing  
**Severidad**: MEDIA (impacta reliability en CI/CD random seed)  
**Status**: RESUELTO (fix-pack `5d61add`)

### Problema

Cuando un test suite mockea módulos a nivel module (`vi.mock('upstream-dep')`), el mock **persiste** en la sesión de vitest. Otros tests en el mismo archivo que esperen el **original** del módulo mockeado (no un override) fallan si el orden de ejecución varía.

**Causa específica de WKH-57**:
- T-INT-01 (W2) usó `vi.mock('../lib/downstream-payment.js', { signAndSettleDownstream: vi.fn().mockResolvedValue(...) })`.
- `compose.test.ts` tiene tests previos de WKH-55 (downstream payment WKH-55 tests) que esperan el **mock original** de vitest (el que downstream-payment.js exporta normally).
- **En local** (con seed determinístico), WKH-55 tests se ejecutan primero (mock not-yet-active), luego T-INT-01 la activa → no hay conflicto.
- **En CI** (seed aleatorio), T-INT-01 puede ejecutarse primero → `vi.mock()` activa globalmente → WKH-55 tests ven el nuevo mock → assertion fallan ("expect(mockDownstream).not.toHaveBeenCalled()" falla porque el nuevo mock fue llamado).

### Solución aplicada

Refactorizar T-INT-01 para usar **`vi.spyOn()`** en lugar de `vi.mock()`. 

**Diferencia**:
- `vi.mock()`: **module-level**, reemplaza TODO el módulo para todos los tests subsecuentes.
- `vi.spyOn()`: **function-level**, intercepta calls a un objeto/función específica sin reemplazar el módulo entero.

**Código W2 original** (problematico):
```ts
vi.mock('../lib/downstream-payment.js', {
  signAndSettleDownstream: vi.fn().mockResolvedValue({
    txHash: '0xfeeb',
    blockNumber: 42,
    settledAmount: '50000',
  }),
});
```

**Código post-fix** (aislado):
```ts
describe('composeService — WAS-V2-3-CLIENT integration (WKH-57)', () => {
  it('T-INT-01: ...', async () => {
    // Spy DENTRO del test, no module-level
    const mockDownstream = vi.spyOn(downstreamPaymentModule, 'signAndSettleDownstream')
      .mockResolvedValueOnce({
        txHash: '0xfeeb',
        blockNumber: 42,
        settledAmount: '50000',
      });
    // ... rest of test ...
    expect(mockDownstream).toHaveBeenCalledTimes(1);
    mockDownstream.mockRestore(); // Cleanup (vitest does auto cleanup pero explicit es mejor)
  });
});
```

### Lección para futuras HUs

**Regla**: Prefiere `vi.spyOn()` sobre `vi.mock()` a menos que necesites reemplazar **COMPLETAMENTE** el módulo (ej. changear export default, constants, etc.).

**Si debes usar `vi.mock()`**:
1. Aísla en un `describe` block dedicado que **NO comparta tests con otros describe blocks que dependa del original**.
2. O bien, llama `vi.resetModules()` en `beforeEach` / `afterEach`:
   ```ts
   describe('Feature X with module-level mocks', () => {
     beforeEach(() => {
       vi.resetModules(); // Clear ALL mocks
     });
     
     afterEach(() => {
       vi.resetModules(); // Cleanup
     });
     
     it('test 1', async () => {
       const mod = await import('./feature.js'); // Fresh import
       vi.mock('./dep.js', { ... }); // OK, aislado
       // ...
     });
   });
   ```

**Verificación local pre-commit**:
```bash
npm test -- --reporter=verbose --seed=0        # Determinístico (siempre el mismo orden)
npm test -- --reporter=verbose --seed=random   # Aleatorio (catch order-dependent bugs)
# Si ambos pasan, test isolation está OK.
```

**Aplicable a**: Cualquier HU que toque `src/services/compose.test.ts`, `src/lib/downstream-payment.test.ts`, o tenga module-level `vi.mock()`.

---

## AB-WKH-57-WAS-V2-3-CLIENT-2: Schema drift fallback pattern — generalizable

**Tipo**: Architecture / API Integration  
**Severidad**: MEDIA (aplicable a múltiples integraciones externas)  
**Status**: DOCUMENTADO

### Patrón implementado en WKH-57

Cuando una API externa drifts en su schema (ej. field names cambían, nuevos campos son NULL donde solían estar populated), un patrón **defensivo** de fallback:

```
canonical_field → try parse
  IF null/undefined:
    → fallback_field → try parse
      IF null/undefined:
        → safe_default (0, empty, etc)
```

**Implementación WKH-57**:
```ts
const V2_PRICE_FALLBACK_FIELD = 'price_per_call' as const;
const _warnedFallbackSlugs = new Set<string>();

function resolvePriceWithFallback(
  raw: Record<string, unknown>,
  canonicalPath: string,
  slug: string,
): number {
  // Try canonical (configured in registry)
  const canonical = getNestedValue(raw, canonicalPath);
  if (canonical !== null && canonical !== undefined) {
    return parsePriceSafe(canonical);
  }
  
  // Fallback to alternate field
  const fallback = getNestedValue(raw, V2_PRICE_FALLBACK_FIELD);
  if (fallback === null || fallback === undefined) {
    return 0;
  }
  
  // Warn once per slug per process lifetime
  if (!_warnedFallbackSlugs.has(slug)) {
    _warnedFallbackSlugs.add(slug);
    console.warn(
      `[Discovery] price_per_call_usdc is null for agent "${slug}" — using fallback "price_per_call"`,
    );
  }
  
  return parsePriceSafe(fallback);
}
```

### Generalización para futuras APIs

**Template para WKH-58+** (schema drift handling):

```ts
// Configuration per registry
const FALLBACK_FIELDS: Record<string, { canonical: string; fallback: string }> = {
  'wasiai-v2': {
    canonical: 'price_per_call_usdc',
    fallback: 'price_per_call',
  },
  'future-api': {
    canonical: 'amount_usdc',
    fallback: 'amount_usd', // e.g. rate conversion needed
  },
};

const _warnedFallbacks = new Set<string>();

function resolveFieldWithFallback(
  raw: Record<string, unknown>,
  registryId: string,
  fieldConfig: { canonical: string; fallback: string },
  key: string,
  parser: (raw: unknown) => T,
  defaultValue: T,
): T {
  const canonical = getNestedValue(raw, fieldConfig.canonical);
  if (canonical !== null && canonical !== undefined) {
    return parser(canonical);
  }
  
  const fallback = getNestedValue(raw, fieldConfig.fallback);
  if (fallback === null || fallback === undefined) {
    return defaultValue;
  }
  
  const warnKey = `${registryId}:${key}`;
  if (!_warnedFallbacks.has(warnKey)) {
    _warnedFallbacks.add(warnKey);
    console.warn(
      `[Adapter] ${registryId}: using fallback "${fieldConfig.fallback}" for "${key}"`,
    );
  }
  
  return parser(fallback);
}

// Usage:
const price = resolveFieldWithFallback(
  rawAgentData,
  'wasiai-v2',
  FALLBACK_FIELDS['wasiai-v2'],
  'price',
  parsePriceSafe,
  0,
);
```

### Componentes reutilizables

1. **Field configuration**: Per-registry mapping of `{ canonical, fallback }`.
2. **Safe parser**: Type-specific validation (ej. `parsePriceSafe`, `parseDateSafe`, etc.).
3. **Dedup warn**: Module-scoped `Set<string>` — dedup per-key, lifetime del proceso.
4. **Default value**: Safe fallback cuando no hay valor en ningún campo.

### Decisiones de trade-off

| Aspecto | Opción A | Opción B (elegido) | Razón |
|--------|----------|-------------------|-------|
| **Dedup granularidad** | Global per-field (no duplicate warns ever) | Per-slug per-process (warn 1x per slug per restart) | Logs más claros — distintos slugs pueden tener schema drift reasons diferentes |
| **Fallback name resolution** | Hardcoded literal `'price_per_call'` (WKH-57) | Config via registry schema (expandible pero complejo) | Hackathon simplicity — si v2 cambia nombre, hardcoded update es OK; si expansión futura, refactor a config |
| **Number parsing strictness** | Lenient via `Number.parseFloat` (WKH-57) | Strict regex pre-parse (optional via parser func) | `Number.parseFloat` es estándar, pero futuras APIs pueden custom-parser |

### Aplicable a

- WKH-58: wasiai-v2 schema normalization (eliminar fallback cuando canonical siempre populated).
- WKH-26+: Marketplace integrations (Fleek, etc.) con schema drift.
- Cualquier adaptador a API externa versionada.

---

## AB-WKH-57-WAS-V2-3-CLIENT-3: Number.parseFloat permisividad — trade-off documented

**Tipo**: Parsing / Type Safety  
**Severidad**: BAJA (WKH-57 context acepta trade-off, pero documenta para futuras)  
**Status**: ACEPTADO CON DOCUMENTACIÓN

### Problema

`Number.parseFloat()` en JavaScript es **muy permisivo**:

```js
Number.parseFloat('0.05')        // → 0.05 (normal)
Number.parseFloat('0.05abc')     // → 0.05 (!) ← parseFloat ignora sufijo
Number.parseFloat('abc0.05')     // → NaN (prefix invalidates)
Number.parseFloat('')            // → NaN
Number.parseFloat('Infinity')    // → Infinity (rejected by Number.isFinite)
Number.parseFloat('-0.05')       // → -0.05 (negative, rejected by >= 0 guard)
```

### Decision in WKH-57

Para AC-5 (string parsing), **aceptamos la permisividad** porque:
1. wasiai-v2 API devuelve precios siempre "clean" (ej. `"0.05"`, no `"0.05xyz"`).
2. Riesgo muy bajo en producción.
3. Simplicity para hackathon timeline.
4. `Number.isFinite()` guard atrapa casos malos (NaN, Infinity).

**Implementación**:
```ts
export function parsePriceSafe(raw: unknown): number {
  // ... type checks ...
  if (typeof raw === 'string') {
    if (raw === '') return 0;
    const parsed = Number.parseFloat(raw);  // ← lenient
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  return 0;
}
```

**Test**: T-PARSE-2 valida `'0.05'` → 0.05, T-PARSE-3 valida `'free'` → 0.

### Para futuras HUs: Strictness guidance

**Si necesitás STRICTNESS** (ej. financial, cryptographic amounts):
```ts
const PRICE_REGEX = /^\d+(\.\d+)?$/;  // Integer or float, no sufijo

function parsePriceStrict(raw: unknown): number {
  if (typeof raw !== 'string') {
    // handle number/null/undefined separately
  }
  if (!PRICE_REGEX.test(raw)) {
    console.warn(`Invalid price format: "${raw}" (expected digits.digits)`);
    return 0;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
```

**Test**: Agregar T-PRICE-STRICT-invalid: `parsePriceStrict('0.05xyz')` → 0 (rejected).

**Recomendación**:
- **Fields financieros** (prices, amounts, fees): Prefiere **strict** parsing.
- **Fields informativos** (descriptions, labels): **Lenient** es OK.
- **Documento en AC**: Si lenient, documentá qué sufijos son ignorados.

---

## AB-WKH-57-HEREDADAS (consolidación con WKH-53, 55, 56)

### AB-WKH-53-#2: Read before write, never project

**Fuente**: WKH-53 RLS Ownership Guards  
**Aplicación en WKH-57**: CD-10 en SDD — verificar en F2.5 que helpers/imports existen en disco antes de escribir test asserts.

**Relato**: Story File proyectaba asserções como `expect(mockDownstream).toHaveBeenCalledWith(...)` sin verificar primero que `mockDownstream` existe. En realidad existía, pero el patrón "proyectar sin leer" es frágil. Lección: **Always Read antes de Write**.

**En WKH-57**: Antes de escribir T-INT-01, Dev leyó `compose.test.ts:1-60` para confirmar que `mockDownstream`, `mockFetchOk`, `discoveryService`, `composeService` están importados/mockeados. Confirmado → escribir test confiado.

**Aplicable a**: Todo trabajo en archivos existentes. Pre-requisito: leer líneas relevantes de disco.

---

### AB-WKH-57: Brittle mock chains — reset Set en beforeEach

**Fuente**: WKH-57 mismo  
**Aplicación**: CD-11 en SDD — `_resetFallbackWarnDedup()` en `beforeEach` de tests que ejercitan fallback warn path.

**Problema**: `_warnedFallbackSlugs` Set es module-scoped. Sin reset, tests posteriores ven Set ya populado con slugs de tests anteriores → `warnSpy.toHaveBeenCalledTimes(1)` falla (warn no se emite segunda vez porque slug ya está en Set).

**Solución**: Cada test en el describe block de W1 llama `_resetFallbackWarnDedup()` en `beforeEach`:
```ts
describe('mapAgent — v2 schema drift fallback', () => {
  beforeEach(() => {
    _resetFallbackWarnDedup();  // Clear Set
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });
  
  it('T-warn-once-per-slug: ...', () => {
    // Set limpio, spy limpio → test aislado
  });
});
```

**Aplicable a**: Cualquier HU que use module-scoped `Set<string>` o estado mutable en helpers. Always reset en `beforeEach`.

---

### AB-WKH-56-W4: Coverage tooling no disponible

**Fuente**: WKH-56 (A2A Fast-Path)  
**Aplicación**: AC-7 en WKH-57 — verifica por inspección manual + green run, no por `--coverage`.

**Problema**: `npm run test -- --coverage` o `c8` tool no está en repo. AC-7 no se valida con porcentaje de coverage.

**Solución**: AC-7 se valida por:
1. **Test count delta**: Baseline 463 + 16 nuevo = 479. Verificar exacto con `npm test` output.
2. **Green run**: Todos 479 tests PASS.
3. **Manual inspection**: Revisar que cada AC tiene al menos 1 test.

**Aplicable a**: Futuras HUs en modo QUALITY. No intentes coverage %. Usa test count + manual review.

---

### AB-WKH-53-#3: Edge case empty strings

**Fuente**: WKH-53 Ownership Guards (test coverage gaps)  
**Aplicación en WKH-57**: T-PARSE-6 — test explícito para `parsePriceSafe('')` → 0.

**Problema**: `Number.parseFloat('')` retorna `NaN`, que es cubierto por `Number.isFinite` guard. Pero **explícito es mejor que implícito** — agrega test que documenta behavior.

**En WKH-57**:
```ts
it('T-PARSE-6: empty string returns 0 (AB-WKH-53-#3 edge)', () => {
  expect(parsePriceSafe('')).toBe(0);
});
```

**Lección**: Cuando un helper retorna safe default para inputs edge (vacío, null, undefined, NaN), **agrega un test explícito** incluso si el guard la cubre implícitamente.

**Aplicable a**: Todo parsing helper. Cover edge cases: `null`, `undefined`, `''`, `0`, `-0`, `NaN`, `Infinity`, negative values.

---

## Tabla consolidada: Auto-Blindaje WKH-53 → 57

| Lección | Fuente | Severidad | Status | Aplicable a futuras |
|---------|--------|-----------|--------|---------------------|
| AB-WKH-53-#2: Read before write | WKH-53 RLS | CRÍTICA | ACTIVO | Todos |
| AB-WKH-53-#3: Edge case empty strings | WKH-53 RLS | MEDIA | ACTIVO | Parsing helpers |
| AB-WKH-55-payment-path-guard | WKH-55 downstream | MEDIA | ACTIVO | Fallback logic con conditionales |
| AB-WKH-56-W4: Coverage tooling N/A | WKH-56 A2A fast-path | MEDIA | ACTIVO | QUALITY mode (no coverage %) |
| **AB-WKH-57-WAS-V2-3-CLIENT-1: Mock isolation** | **WKH-57 WAS-V2-3** | **MEDIA** | **RESUELTO** | **Module-level vi.mock() calls** |
| **AB-WKH-57-WAS-V2-3-CLIENT-2: Schema fallback pattern** | **WKH-57 WAS-V2-3** | **MEDIA** | **DOCUMENTADO** | **API schema drift (WKH-58+)** |
| **AB-WKH-57-WAS-V2-3-CLIENT-3: ParseFloat permisividad** | **WKH-57 WAS-V2-3** | **BAJA** | **ACEPTADO** | **Financial parsing (strictness guidance)** |

---

## Checklist para próximas HUs

- [ ] **AB-WKH-53-#2**: Read disk antes de escribir; no proyectes.
- [ ] **AB-WKH-53-#3**: Test edge cases (empty strings, nulls, zeros).
- [ ] **AB-WKH-56-W4**: No `--coverage` flags; valida manualmente.
- [ ] **AB-WKH-57-1**: Prefiere `vi.spyOn()` sobre `vi.mock()` module-level.
- [ ] **AB-WKH-57-2**: Fallback pattern aplicable → genera helpers reutilizables.
- [ ] **AB-WKH-57-3**: ParseFloat trade-off → documenta en AC si lenient.
- [ ] **CD-11**: Reset Set/module-state en `beforeEach` si hay dedup.

---

> **Consolidación status**: ✅ COMPLETO
> **Historial**: AB-WKH-53 (3) + AB-WKH-55 (1) + AB-WKH-56 (1) + AB-WKH-57 (3) = 8 lecciones activas.
> **Próximo**: Mantener este registro + agregar WKH-58+ cuando se complete.
