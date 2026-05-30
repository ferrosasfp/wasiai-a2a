# Work Item — [WKH-AUDIT-A2A-CLEANUP] Limpieza final — repo A+ (tsc + lint + isProduction)

## Resumen

Cerrar la deuda de calidad pre-existente que quedó fuera del scope de WKH-097
(auditoría profesional). El repo produce 6 errores en `npx tsc --noEmit` (todos
en archivos de test), ~11 diagnósticos de biome lint (mix de formato y
lint-rules), y tiene una declaración `isProduction` local duplicada entre
`src/index.ts` y `src/routes/dashboard.ts`. Este WKH elimina todo el ruido sin
tocar la lógica de producción.

## Sizing

- SDD_MODE: mini
- Estimación: S
- Branch sugerido: `feat/098-a2a-cleanup-aplus`

---

## Inventario real de errores (ground truth)

### A) TypeScript (`npx tsc --noEmit`) — 6 archivos de test

El problema raíz es único y transversal: WKH-35 agregó el campo
`funding_wallet: string | null` a la interfaz `A2AAgentKeyRow`
(`src/types/a2a-key.ts:27`). Los helpers `makeKeyRow()` de los archivos de test
no incluyen ese campo en su objeto spread, lo que rompe la asignación bajo
`strict: true`. El build de prod pasa porque `tsconfig.build.json` excluye
`src/**/*.test.ts` y `src/**/__tests__/**`. El `tsconfig.json` base los incluye,
por eso `npx tsc --noEmit` falla.

| Archivo | Error esperado | Fix |
|---------|---------------|-----|
| `src/services/compose.test.ts` | `makeKeyRow` return object falta `funding_wallet` | Agregar `funding_wallet: null` al objeto base del helper |
| `src/services/authz.test.ts` | ídem | ídem |
| `src/routes/gasless.test.ts` | ídem | ídem |
| `src/middleware/x402.chain-aware.test.ts` | ídem | ídem |
| `src/middleware/a2a-key.test.ts` | ídem | ídem |
| `src/__tests__/e2e/setup.ts` | ídem — `makeKeyRow` exportada | ídem |

Fix categoría: behavior-preserving. Los `makeKeyRow()` ya devuelven null para
campos opcionales similares (`erc8004_identity`, `kite_passport`, etc.).
`funding_wallet: null` es semánticamente correcto (el wallet no está ligado
en los fixtures de test genéricos). No cambia ninguna aserción existente.

### B) Biome lint (`npm run lint`) — diagnósticos por archivo

Clasificación por tipo de diagnóstico:

**Auto-fixable con `biome check --write` (formato puro):**

| Archivo | Diagnóstico esperado | Tipo |
|---------|---------------------|------|
| `src/adapters/__tests__/avalanche.test.ts` | trailing whitespace / indentación / quote style | format |
| `src/adapters/__tests__/chain-resolver.test.ts` | trailing whitespace / import order | format + organizeImports |
| `src/adapters/__tests__/registry.test.ts` | trailing whitespace / quote style | format |
| `src/lib/bazaar.test.ts` | trailing whitespace / import order | format |
| `src/mcp/rate-limit.test.ts` | trailing whitespace / quote style | format |
| `src/adapters/deposit-verifier.test.ts` | trailing whitespace / import order | format |

**Requieren revisión manual (lint-rules, código de prod):**

| Archivo | Diagnóstico esperado | Tipo | Behavior-preserving? |
|---------|---------------------|------|----------------------|
| `src/adapters/avalanche/attestation.ts` | `noConsole` — `console.warn` en `attest()` | lint | SÍ — reemplazar con `// biome-ignore lint/suspicious/noConsole: stub intentional` o suprimir con directiva |
| `src/adapters/avalanche/payment.ts` | `noConsole` — `console.warn` en `getUsdcAddress()` | lint | SÍ — misma supresión |
| `src/adapters/deposit-verifier.ts` | posible `noExplicitAny` o import order | lint | SÍ |
| `src/adapters/kite-ozone/index.ts` | posible `noNonNullAssertion` (`opts!.network`) | lint | SÍ — agregar guard `opts?.network ?? 'testnet'` o `biome-ignore` con justificación |
| `src/adapters/registry.ts` | posible `noConsole` — `console.warn` + `console.log` | lint | SÍ — supresión o extracción a logger |

**Regla**: en archivos de producción (`src/adapters/**/*.ts` excluyendo `*.test.ts`),
si el fix de una lint-rule implica cambio de lógica (ej. refactor de flujo,
cambio de guard), se usa `biome-ignore` con justificación en lugar de cambiar
el código. Solo se aplica fix directo cuando es format-puro o supresión de
`noConsole` vía comentario de directiva.

### C) Hardening — centralizar `isProduction`

**Call-sites actuales con el literal:**

| Archivo | Línea | Uso |
|---------|-------|-----|
| `src/index.ts` | 36 | `const isProduction = process.env.NODE_ENV === 'production'` (variable local) |
| `src/routes/dashboard.ts` | 36 | `process.env.NODE_ENV === 'production'` (inline en preHandler) |

**Fix propuesto:** crear `src/lib/env.ts` con:

```ts
export function isProduction(): boolean {
  return process.env.NODE_ENV?.trim().toLowerCase() === 'production';
}
```

Reemplazar los dos call-sites para importar y usar `isProduction()`. La
normalización `.trim().toLowerCase()` es más robusta (resiste `'Production'`,
`' production '`), es behavior-preserving para el valor nominal `'production'`
sin espacios, y no altera la semántica de seguridad (dashboard fail-closed,
CORS restrictivo).

---

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `npx tsc --noEmit` is executed, the system SHALL exit with code 0 and produce zero diagnostic errors.
- **AC-2**: WHEN `npm run lint` (`biome check src/`) is executed, the system SHALL exit with code 0 and produce zero errors or warnings.
- **AC-3**: WHEN `npm test` (`vitest run`) is executed after all changes, the system SHALL pass all existing tests with no regressions (baseline ≥ 1109 tests).
- **AC-4**: WHILE `isProduction` is defined, the system SHALL declare it in exactly one place (`src/lib/env.ts`) and both `src/index.ts` and `src/routes/dashboard.ts` SHALL import it from that module.
- **AC-5**: IF any lint fix on a production adapter file (`src/adapters/**/*.ts`, excluding `*.test.ts`) would alter runtime behavior, THEN the system SHALL use a `biome-ignore` directive with a justification comment instead of changing logic.
- **AC-6**: WHEN `tsc -p tsconfig.build.json` (prod build) is executed, the system SHALL continue to exit with code 0 (no regression).
- **AC-7**: WHEN the dashboard preHandler evaluates `isProduction()`, the system SHALL preserve fail-closed behavior in production (HTTP 503 when `DASHBOARD_ADMIN_TOKEN` is unset + `NODE_ENV=production`).

---

## Scope IN

Archivos de test (fix `funding_wallet`):
- `src/services/compose.test.ts` — `makeKeyRow()` helper
- `src/services/authz.test.ts` — `makeKeyRow()` helper
- `src/routes/gasless.test.ts` — helper de fixture A2AAgentKeyRow
- `src/middleware/x402.chain-aware.test.ts` — fixture A2AAgentKeyRow (si aplica)
- `src/middleware/a2a-key.test.ts` — `makeKeyRow()` helper
- `src/__tests__/e2e/setup.ts` — `makeKeyRow()` exportada

Archivos de lint (auto-fix):
- `src/adapters/__tests__/avalanche.test.ts`
- `src/adapters/__tests__/chain-resolver.test.ts`
- `src/adapters/__tests__/registry.test.ts`
- `src/adapters/deposit-verifier.test.ts`
- `src/lib/bazaar.test.ts`
- `src/mcp/rate-limit.test.ts`

Archivos de prod — lint-rule supresión o fix menor (behavior-preserving):
- `src/adapters/avalanche/attestation.ts` — `noConsole` directive
- `src/adapters/avalanche/payment.ts` — `noConsole` directive(s)
- `src/adapters/deposit-verifier.ts` — lint-rule(s) a confirmar en F3
- `src/adapters/kite-ozone/index.ts` — `noNonNullAssertion` / format
- `src/adapters/registry.ts` — `noConsole` directive(s)

Nuevo helper:
- `src/lib/env.ts` — `isProduction()` export

Modificados por centralización:
- `src/index.ts` — importar `isProduction` de `src/lib/env.ts`
- `src/routes/dashboard.ts` — importar `isProduction` de `src/lib/env.ts`

---

## Scope OUT

- Cualquier archivo dentro del scope validado de WKH-097 (`feat/097-wkh-audit-a2a-hardening`)
- Lógica de negocio en adapters (pagos, verificación, gasless)
- Supabase queries o servicios
- Rutas que no son `index.ts` ni `dashboard.ts`
- Migraciones de base de datos
- Scripts bajo `scripts/`
- Archivos bajo `mcp/` salvo `rate-limit.test.ts` (lint-format únicamente)
- Refactor de `console.warn` a Pino logger en adapters (TD pendiente, fuera de este WKH)

---

## Decisiones técnicas

- **DT-1**: `funding_wallet: null` en fixtures de test — no cambiar el type a
  `string | null | undefined`. El campo es `string | null` en la interfaz
  (`src/types/a2a-key.ts:27`); `null` es el valor semánticamente correcto para
  "wallet no ligado". Agregar el campo al spread object de cada `makeKeyRow()`.

- **DT-2**: Para `noConsole` en adapters de producción, usar directivas
  `biome-ignore lint/suspicious/noConsole: <razón>` en lugar de eliminar los
  `console.warn`. Los `console.warn` de adapters son diagnósticos operacionales
  intencionados (misconfiguración de env vars). Eliminarlos cambiaría el
  comportamiento observable en producción. Refactor a logger Pino es TD separado.

- **DT-3**: `src/lib/env.ts` como módulo nuevo (no `src/config/env.ts`) para
  mantener consistencia con `src/lib/` como destino de helpers de bajo nivel
  (`src/lib/supabase.ts`, `src/lib/redis.ts`, etc.).

- **DT-4**: El orden de operaciones en F3 es: (1) correr `biome check --write src/`
  para auto-fixes, (2) correr `npx tsc --noEmit` para identificar los errores
  exactos de `funding_wallet`, (3) aplicar fixes manuales, (4) verificar que
  `npm run lint` salga 0, (5) crear `env.ts` y refactorizar call-sites, (6) `npm test`.

---

## Constraint Directives

- **CD-1**: PROHIBIDO cambiar la lógica de ningún archivo de producción — solo
  formato, directivas de supresión lint, o importar helper existente.
- **CD-2**: OBLIGATORIO que `npm test` pase con ≥ 1109 tests tras cada cambio
  de archivo de producción. Si un cambio rompe un test, se revierte y se usa
  `biome-ignore` en su lugar.
- **CD-3**: PROHIBIDO eliminar o modificar `console.warn` calls en adapters.
  Solo se agrega la directiva de supresión biome sobre la línea afectada.
- **CD-4**: OBLIGATORIO que `isProduction()` en `src/lib/env.ts` sea una función
  (no una constante de módulo) para que la evaluación ocurra en runtime, no en
  import time — preservando el comportamiento de seguridad existente.
- **CD-5**: PROHIBIDO tocar `tsconfig.json` o `tsconfig.build.json`.
- **CD-6**: PROHIBIDO usar `@ts-ignore` o `@ts-expect-error` — el fix debe ser
  semánticamente correcto (agregar el campo faltante, no suprimir el error).

---

## Missing Inputs

Ninguno bloqueante. Los diagnósticos exactos de biome se confirman al correr
`biome check src/` en F3 (los archivos se inspeccionaron manualmente pero el
output exact de biome depende de la versión instalada `^2.4.11`). El inventario
de la sección B es suficientemente preciso para diseñar las waves de F3.

---

## Test Plan

1. `npx tsc --noEmit` → exit 0, 0 errores
2. `npm run lint` (`biome check src/`) → exit 0, 0 errores
3. `npm test` → ≥ 1109 tests passing, 0 failures
4. `tsc -p tsconfig.build.json` → exit 0 (regresion prod build)
5. Smoke check manual: `isProduction()` importa correcto en ambos call-sites
   (grep `from '../lib/env.js'` y `from '../../lib/env.js'` según profundidad)

---

## Análisis de paralelismo

- Este WKH no bloquea ninguna otra HU activa.
- Puede ejecutarse en paralelo con WKH de features nuevas siempre que no
  toquen `src/index.ts`, `src/routes/dashboard.ts`, ni los archivos de test
  listados en Scope IN.
- El único conflicto potencial es si otra HU agrega campos a `A2AAgentKeyRow`
  simultáneamente — en ese caso el `makeKeyRow()` de este WKH tendría que incluir
  ese campo también. Probabilidad baja dado que WKH-096 acaba de completar la
  última adición (`funding_wallet`).
