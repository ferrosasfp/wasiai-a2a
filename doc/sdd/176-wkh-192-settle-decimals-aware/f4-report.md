# F4 Validation Report — [WKH-192] Seam `settlePaymentIntentOnChain` decimals-aware (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-13

## Runtime/gate checks (ejecutados por QA, no re-leídos de CR)
- `npx tsc --noEmit` → 0 errores (confirmado en vivo)
- `npx vitest run` → **161 files passed | 4 skipped (165)**, **2933 tests passed | 10 skipped (2943)**, 9.81s (confirmado en vivo, coincide con AR/CR)
- `npm run build` → exit 0 (`tsc -p tsconfig.build.json` + copy static, sin errores)
- `./node_modules/.bin/biome check src/` → "Checked 321 files in 94ms. No fixes applied." (0 findings)
- Scope real (`git diff --stat`): solo `src/services/payment-intent.ts` (+19/-9), `src/services/payment-intent.test.ts` (T-1..T-6 nuevos), `doc/sdd/_INDEX.md` (1 línea, fila 176 bookkeeping — no código). Confirmado con `git diff --stat` sobre los 9 archivos explícitamente Scope OUT (`settle-verifier.ts`, `fee-charge.ts`, `compose.ts`, `arbiter.ts`, `debit-capture.ts`, `debit-executor.ts`, `kite-ozone/payment.ts`, `base/payment.ts`, `contracts/`) → **0 cambios en todos**.

## ACs

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (decimals reales del token, nunca literal 18) | PASS | `payment-intent.ts:372-374` — `const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18; const wei = usdToAtomic(finalAmountUsd, decimals)`. Test `payment-intent.test.ts:1816` (T-2, `usdToAtomic(1.5,6)==='1500000'`) y `:1851` (T-4, Base 6d vía el seam real, `.not.toBe(usdToAtomic(usd,18))` — falsificable). |
| AC-2 (Kite 18d byte-idéntico al `usdToWei` legacy) | PASS | Fórmula `usdToAtomic(usd,18)` = `micro * 10n**12n` idéntica en construcción a la legacy (`payment-intent.ts:158-165`). Test `payment-intent.test.ts:1809` (T-1) compara string-a-string contra fórmula legacy inline independiente (`:1805`) para `{1.5, 0.333333, 100, 0.000001}` (incluye 6 decimales de precisión). T-5 (`:1876`) repite vía el seam completo. AR además corrió fuzz de 200k valores + 14 edge cases → 0 divergencias (ar-report.md:39-42, no re-ejecutado por mí, evidencia documentada por AR aceptada como válida). |
| AC-3 (fallback `?? 18`, nunca throw) | PASS | `payment-intent.ts:373` — `adapter.supportedTokens?.[0]?.decimals ?? 18`, código dentro del `try` externo (`:371-480`, CD-7). Test `payment-intent.test.ts:1826` (T-3) cubre `undefined` y `[]`, asserta `status==='settled'` y `value===usdToAtomic(usd,18)` sin throw en ambos casos. |
| AC-4 (`verifyDefaultChainSettle` recibe el MISMO atómico corregido, sin segunda derivación) | PASS | `payment-intent.ts:439` — `requiredAmountAtomic: BigInt(wei)`, sin cambios de código (misma variable `wei` calculada en `:374`). `settle-verifier.ts` NO tocado (`git diff --stat` = vacío) — deriva su propio token/decimals de forma independiente (`:369` `bundle.payment.supportedTokens[0]`) y solo compara. Test `payment-intent.test.ts:1851` (T-4) asserta `mockVerify.calls[0][0].requiredAmountAtomic === BigInt(usdToAtomic(usd,6))` — convergencia sign↔verify en 6d, previamente hubiera divergido 10¹²x. |
| AC-5 (`settleEscrowAware` hereda el fix sin cambios de código) | PASS | `git diff -- src/services/payment-intent.ts` confirma que el diff completo son 19 líneas insertadas / 9 eliminadas, TODAS dentro de `usdToAtomic` (líneas 145-165) y de `settlePaymentIntentOnChain` (líneas 369-401) — el bloque `settleEscrowAware` (`:486-628`, hop2 call en `:589` `const o2 = await settlePaymentIntentOnChain(base)`) no aparece en el diff. Test `payment-intent.test.ts:1892` (T-6) ejercita `settleEscrowAware` end-to-end con hop1 mockeado (`debit_amount_atomic = usdToAtomic(3.7,6) = '3700000'`) y asserta que hop2 firma el mismo atómico (`mockSign.calls[0][0].value === atomic6`). |
| AC-6 (tests de convergencia Kite ≥3 valores + Base) | PASS | T-1 (`:1809`) cubre 4 valores Kite incl. 6-decimales de precisión (CD-2 pide ≥3). T-2 (`:1816`) `usdToAtomic(1.5,6)==='1500000'` + relación `BigInt(6d)*10n**12n===BigInt(18d)` para 5 valores. Todos con asserts de string/bigint exacta, no aproximada. |

## Drift
- Scope: exacto a Scope IN (`payment-intent.ts` + `.test.ts`); `_INDEX.md` es 1 línea de bookkeeping ya señalada como MNR-1 no-bloqueante en AR (fila queda "in progress", la cierra nexus-docs en DONE — no requiere acción).
- Wave: N/A (HU S, single-file, sin waves internas).
- Spec drift: fórmula (`usdToAtomic`), resolución única de adapter (`grep -c "getPaymentAdapter()" payment-intent.ts` dentro del seam = 1, confirmado leyendo `:372/379/401` — misma instancia `adapter`), y fallback `?? 18` — los 3 puntos clave del SDD/DT-2/DT-3 — coinciden línea a línea con el código real.
- `verifyDefaultChainSettle` (settle-verifier.ts): confirmado SIN cambios (`git diff --stat` vacío) — converge por construcción vía el `wei` corregido en origen, tal como predice DT-4. Ningún adapter (`kite-ozone/payment.ts`, `base/payment.ts`) ni `contracts/` tocados (CD-1/CD-3 respetados, verificado con `git diff --stat` = 0 en los 9 archivos explícitamente Scope OUT).

## Gates (ejecutados por QA en vivo, no solo leídos de CR — ver arriba)
- typecheck / tests / build / biome: PASS, todos re-verificados por mí con el mismo resultado reportado por AR/CR (2933 pass / 10 skip, 0 tsc errors, 0 biome findings, build exit 0).

## AR/CR follow-up
- AR: APROBADO, 0 BLOQUEANTE, 1 MNR (scope de `_INDEX.md`, ver arriba — no accionable, es housekeeping de `nexus-docs`).
- CR: APROBADO, 0 BLOQUEANTE, 0 MNR.
- Sin hallazgos pendientes de resolver.

**Listo para DONE.**
