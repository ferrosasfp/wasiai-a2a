# F4 QA Report — HU WKH-195 · Fee-charge + compose decimals-aware (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-13

## Gates (ejecutados por mí, no solo leídos)
- `./node_modules/.bin/tsc --noEmit` → exit 0, 0 errores.
- `./node_modules/.bin/vitest run` → **2972 passed | 10 skipped (2982)**, 162 files passed | 4 skipped. Coincide con CR/AR report.
- `./node_modules/.bin/vitest run -t "WKH-195"` → **9 passed | 0 failed** (T1-A..D, T2-A..D, T3).
- `npm run build` (`tsc -p tsconfig.build.json`) → exit 0, sin errores.
- `./node_modules/.bin/biome check src/` → "Checked 323 files. No fixes applied." (limpio).

## ACs

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `src/services/fee-charge.ts:172-176` — `feeUsdcToWei(feeUsdc)` resuelve `getPaymentAdapter()`, deriva `decimals = adapter.supportedTokens?.[0]?.decimals ?? 18`, y delega en `usdToAtomic(feeUsdc, decimals)`. Sin `1e12` en el archivo. Test: `fee-charge.test.ts:626-631` (T1-A, Kite 18d byte-idéntico) + `:640-649` (T1-B, Base 6d divergente `'1500000'`). |
| AC-2 | PASS | `src/services/compose.ts:823-829` — hoistea `const adapter = getPaymentAdapter()`, deriva `decimals` con el mismo patrón, y firma con `usdToAtomic(agent.priceUsdc, decimals)` en `adapter.sign({...})`. Test: `compose.test.ts:3354-3369` (T2-A, 4 precios Kite 18d) + `:3372-3383` (T2-B, Base 6d divergente + invariante `×10n**12n`). |
| AC-3 | PASS | Byte-identidad Kite verificada por construcción: `usdToAtomic(usd,18)` = `micro * 10n**12n` (`payment-intent.ts:158-165`), legado = `BigInt(Math.round(usd*1e6)) * BigInt(1e12)` — `10n**12n === BigInt(1e12)` exacto en float64, mismo `Math.round`. Confirmado por `.toBe` string-exacto en T1-A (4 valores incl. 0.000001) y T2-A (4 precios). Corrí ambos tests yo mismo: verdes. |
| AC-4 | PASS | `fee-charge.ts:174` y `compose.ts:824` — `?.[0]?.decimals ?? 18`, sin try/catch nuevo, sin throw. Tests `fee-charge.test.ts:653-...` (T1-C, loop `[undefined, []]` → `not.toThrow()` + valor = legacy) y `compose.test.ts:3386-3405` (T2-C, mismo loop + `result.output === 'ok'`, confirma que compose no gana modo de fallo nuevo). |
| AC-5 | PASS | `import { usdToAtomic } from './payment-intent.js'` en `fee-charge.ts:41` y `compose.ts:43`. Grep de la fórmula BigInt inline (`Math.round(...* 1e6...) * BigInt(1e12)` o `10n ** 12n` duplicada fuera de `payment-intent.ts`) → no encontrada en `fee-charge.ts`/`compose.ts`; único choke-point en `payment-intent.ts:158-165`. Sin ciclo: `grep -n "from './(fee-charge\|from './(compose" src/services/payment-intent.ts` → 0 resultados. |
| AC-6 | PASS | `git diff HEAD -- src/services/fee-split.ts` → **0 líneas** (código sin tocar, confirma herencia transparente). `fee-split.ts:32` sigue importando `feeUsdcToWei` sin cambios. Test de regresión `fee-split.test.ts:605-622` (T3): ejercita `settleFeeSplits` real con config default (10000/0/0), asserta `signArg.value === feeUsdcToWei(amount) === legacyWei(amount)` en Kite 18d. Corrido: PASS. |

## Runtime / Integration
- N/A DB — esta HU no toca schema/migrations. Es aritmética pura (BigInt), sin I/O nuevo.
- N/A env vars — no introduce env vars nuevas.
- Convergencia byte-idéntica verificada por construcción + tests string-exactos (no aproximados), corridos localmente por mí (9/9 verdes).

## Drift
- Scope: exactamente 5 archivos tocados (`fee-charge.ts`, `compose.ts`, `fee-charge.test.ts`, `compose.test.ts`, `fee-split.test.ts`) — coincide 1:1 con Scope IN del work-item. `git diff --name-only HEAD -- src/` confirmado.
- Cero cambios en `payment-intent.ts`, `fee-split.ts` (código), `arbiter.ts`, `contracts/`, `escrow-verifier.ts`, `settle-verifier.ts` — confirmado con `git diff --name-only HEAD` sobre esas rutas → vacío.
- `settle-verifier.ts` / `verifyDefaultChainSettle`: sin cambios (0 diff); recibe `requiredAmountAtomic` ya calculado, decimals-agnóstico — no requería cambios para esta HU.
- Compose settle (`compose.ts:932`) y chainKey/telemetría selector Base (`:910-928`) intactos fuera del hunk tocado (`:817-829`).
- Sin ciclo de import.

## AR/CR follow-up
- AR report: APROBADO, 0 BLQ, 0 MNR.
- CR report: APROBADO, 0 BLQ, 0 MNR.
- Gates que ambos reportaron (tsc/vitest/biome) los re-verifiqué yo mismo y coinciden exactamente en números (2972 passed | 10 skipped).

**Listo para DONE.**
