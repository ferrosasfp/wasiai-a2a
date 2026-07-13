# CR Report — HU WKH-195 · Fee-charge + compose decimals-aware

> Rol: nexus-adversary (Code Review de calidad). Cita archivo:línea.
> Fecha: 2026-07-13. Branch base: main. Diff: `git diff` sobre 2 fuentes + 3 tests.

## Resumen ejecutivo

Implementación **fiel al Story File**, sin drift de scope, sin regresión.
`tsc --noEmit` = 0 errores. Suite completa **2972 passed | 10 skipped (2982)**.
Biome limpio sobre los 5 archivos tocados. **Sin hallazgos BLOQUEANTE ni MENOR.**

Verdict global: **APROBADO**.

## Evidencia de gates

- `./node_modules/.bin/tsc --noEmit` → exit 0, 0 errores.
- `./node_modules/.bin/vitest run` → 162 files passed | 4 skipped; **2972 tests passed | 10 skipped (2982)**. +9 tests nuevos (T1-A..D, T2-A..D, T3) sobre baseline ~2963.
- `./node_modules/.bin/biome check` (5 archivos) → "Checked 5 files. No fixes applied", exit 0.
- Sin ciclo de import: `grep -nE "from './(fee-charge|compose)" src/services/payment-intent.ts` → 0 coincidencias.

## Check 1 — Fidelidad SDD/Story File · OK

- `feeUsdcToWei` mantiene firma `(feeUsdc: number): string` y deriva decimals adentro: `src/services/fee-charge.ts:174-178`. Cuerpo = `const adapter = getPaymentAdapter(); const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18; return usdToAtomic(feeUsdc, decimals);`. Firma pública intacta → `fee-split.ts` hereda sin tocar código (AC-6/CD-3).
- `compose.ts` hoistea el adapter y reusa `sign`: `src/services/compose.ts:823-828`. `const adapter = getPaymentAdapter()` → decimals → `usdToAtomic(agent.priceUsdc, decimals)` → `adapter.sign({...})`. El `× 1e12` inline fue eliminado.
- Ambos importan `usdToAtomic` (no lo re-declaran): `fee-charge.ts:41`, `compose.ts:43`. `payment-intent.ts:158` (usdToAtomic) intacto.
- `fee-split.ts` **sin cambios de código**: no aparece en `git diff --name-only` (solo `fee-split.test.ts`). Confirmado.
- Anclas NO tocadas verificadas: settle de compose sigue en `getPaymentAdapter().settle(...)` fuera del branch (`compose.ts:932`); call-sites/sign/settle de fee-charge (`:393/:448/:471`) fuera del hunk.

## Check 2 — Calidad de los 9 tests nuevos · OK

- **Convergencia Kite 18d string-exacta** contra fórmula legacy independiente inline:
  - T1-A `fee-charge.test.ts:611-617`: `feeUsdcToWei(usd) === legacyWei(usd)` para `[1.5, 0.333333, 100, 0.000001]` (≥3, incluye precisión 6d). `legacyWei` = `String(BigInt(Math.round(usd*1e6)) * BigInt(1e12))` — anclaje independiente, falsificable bajo mutación.
  - T2-A `compose.test.ts:3350-3369`: `mockSign.mock.calls[0][0].value === legacyWei(price)` para 4 precios.
  - T3 `fee-split.test.ts:608-622`: leg plataforma firma `=== feeUsdcToWei(amount)` **y** `=== legacyWei(amount)`. La 2ª aserción ancla a la fórmula legacy independiente → no tautológico; la 1ª prueba que fee-split enruta por el mismo helper (hereda el fix, AC-6).
- **Base 6d falsificable**:
  - T1-B `fee-charge.test.ts:620-630`: `feeUsdcToWei(1.5) === '1500000'` **y** `.not.toBe(legacyWei(1.5))` **y** invariante `BigInt(x6) * 10n**12n === BigInt(legacyWei)`. Triple anclaje.
  - T2-B `compose.test.ts:3372-3383`: `signed === atomic6(price)` **y** `.not.toBe(legacyWei)` **y** `BigInt(signed)*10n**12n === BigInt(legacyWei)`. `atomic6` local replica `usdToAtomic(_,6)=micro` — decisión explícita "para no importar" (espejo del patrón exemplar payment-intent.test.ts que usa legacyWei inline); sigue siendo falsificable por el `.not.toBe` y el cross-check.
- **Fallback ?? 18 sin throw**:
  - T1-C `fee-charge.test.ts:633-644`: loop `[undefined, []]` → `not.toThrow()` **y** `=== legacyWei`.
  - T2-C `compose.test.ts:3386-3405`: loop `[undefined, []]` → `value === legacyWei` **y** `result.output === 'ok'` (no agrega modo de fallo, CD-4/CD-B).
- **fee-split AC-6**: T3 (arriba) prueba herencia sin cambio de código.
- **Refactor a `vi.hoisted` sólido**: `mockSupportedTokens` en `vi.hoisted(() => ({current: [...]}))` en los 3 archivos (`fee-charge.test.ts:29-33`, `compose.test.ts:46-50`, `fee-split.test.ts:34-38`), consumido dentro de la factory `vi.mock('../adapters/registry.js')` (CD-7). Rest param `(..._a: unknown[])` evita TS2554/TS2556 (CD-6). `beforeEach`/`afterEach` resetean a 18d → no filtra a suites posteriores. tsc 0 errores lo confirma.
- **T1-D `fee-charge.test.ts:647-...`** y **T2-D `compose.test.ts:3408-...`**: leg plataforma / settle path `:932` no se rompen (`status charged`, `mockSettle` invocado, promise nunca rechaza). No tautológicos.

## Check 3 — Legibilidad / DRY · OK

- Import de `usdToAtomic` sin ciclo (grep 0 coincidencias). Un único choke-point de la fórmula (CD-1).
- Derivación de decimals **idéntica** en los 2 seams: `adapter.supportedTokens?.[0]?.decimals ?? 18` (`fee-charge.ts:176`, `compose.ts:824`). Mismo patrón, mismo comentario `// CD-4`.
- Sin dead code: el `× 1e12` legacy eliminado en ambos; JSDoc de `feeUsdcToWei` actualizado (`fee-charge.ts:157-172`) y comentario MONEY-PATH de compose reescrito (`compose.ts:817-822`).

## Check 4 — Consistencia con WKH-192 · OK

- Sigue el patrón canónico de `payment-intent.ts:370-382` (adapter → `supportedTokens?.[0]?.decimals ?? 18` → `usdToAtomic`). Mocks de test espejo de `payment-intent.test.ts:29-44`. Byte-idéntico en Kite 18d por construcción (no por muestreo).

## Check 5 — Manejo de errores / tipos · OK

- Fallback `?? 18` sin `throw`: preserva la garantía CD-B (chargeProtocolFee nunca rechaza) y no agrega modo de fallo en `compose.invokeAgent` (T1-C/T2-C lo prueban).
- `?.[0]?.decimals` sobre `supportedTokens?: TokenSpec[]` tipado; `usdToAtomic` retorna `string`; aritmética `bigint` pura en el helper. tsc strict 0 errores. Sin `any`.

## Check 6 — Regresión · OK

- Suite preexistente de los 3 archivos (que NO declaran `supportedTokens` por test → caen a fallback 18d) sigue verde byte-idéntica. Ej. `fee-split.test.ts:291-293` (`feeUsdcToWei(0.8/0.15/0.05)`) verde sin cambios. Total 2972 passed, 0 fallos, +9 nuevos.

## Veredicto final

**APROBADO** — 0 BLOQUEANTE, 0 MENOR. tsc 0 errores, suite 2972/2982 verde (10 skipped preexistentes), biome limpio. Fidelidad total al Story File, sin scope drift, sin regresión. Gate PASA.
