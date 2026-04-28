# Validation Report — WKH-59 / SEC-DRAIN-1 (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-04-27
**Branch**: `feat/061-wkh-59-sec-drain-1` — 6 commits (W0..W5)

---

## Runtime checks

- TypeScript typecheck: `npx tsc --noEmit` — exit 0, zero errors
- Tests full suite: 556 passed (556), 52 test files — exit 0
- New tests breakdown: 14 T-PRICE + 8 T-DRAIN + 2 T-MW-GASLESS = 24 nuevos
- Baseline delta: 532 → 556 (delta +24, dentro del ~552 estimado + 4 edge cases extra T-PRICE-8b/8c/9b/10b)
- DB: no schema changes — Scope OUT explícito (no migration, no supabase changes)
- Env vars: `PYUSD_USD_RATE` y `GASLESS_DEFAULT_CAP_USD` documentadas en `.env.example` líneas 108+114

---

## ACs

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `src/routes/gasless.test.ts` T-DRAIN-1: `mockDebit.toHaveBeenCalledWith(TEST_KEY_ID, 2368, 5)` — debit $5 real, no placeholder; `src/middleware/a2a-key.test.ts` T-MW-GASLESS-2 corrobora |
| AC-2 | PASS | `src/routes/gasless.test.ts` T-DRAIN-2: value=$50 → 403 `error_code:'PER_CALL_LIMIT'`, `mockGaslessTransfer` not called; T-DRAIN-8 verifica boundary inclusivo ($10=cap → 200) |
| AC-3 | PASS | `src/routes/gasless.test.ts` T-DRAIN-3: `mockDebit` retorna `{success:false}` → 403 `INSUFFICIENT_BUDGET`, `mockGaslessTransfer` not called |
| AC-4 | PASS | `src/routes/gasless.test.ts` T-DRAIN-4: keyRow con `daily_limit_usd='2.000000', daily_spent_usd='2.000000'` → 403 `DAILY_LIMIT`, `mockGaslessTransfer` not called; daily limit enforced por PG function via `budgetService.debit` |
| AC-5 | PASS | `src/middleware/a2a-key.test.ts` T-MW-GASLESS-1: ruta `/test-legacy` sin campo inyectado → `mockDebit.toHaveBeenCalledWith(TEST_KEY_ID, 2368, 1.0)` — backward-compat confirmado |
| AC-6 | PASS | `src/routes/gasless.test.ts` T-DRAIN-5 (body sin `value` → 400 "missing required fields") + T-DRAIN-6 (value="not-a-number" → 400 "invalid value") — ambos antes del middleware (`mockLookupByHash` not called) |
| AC-7 | PASS | `src/routes/gasless.test.ts` T-DRAIN-7: `vi.spyOn(app.log,'info')` captura call con message `'gasless transfer executed'` y payload `{keyId, estimatedCostUsd:5, actualValueWei:'5000000', to, txHash:'0xabc123'}` — todos los campos requeridos presentes |
| AC-8 | PASS | `src/lib/price.test.ts` T-PRICE-1 (env unset→1.0 sin warn), T-PRICE-2 (""→1.0 sin warn), T-PRICE-3 ("abc"→1.0+warn), T-PRICE-4 ("200" out-of-range→1.0+warn), T-PRICE-5 ("0.95"→0.95) |
| AC-9 | PASS | `src/lib/price.test.ts` T-PRICE-9 (env unset→10 sin warn), T-PRICE-10 ("0" ≤lower→10+warn), T-PRICE-10b (>upper→10+warn) |

---

## Drift

- Archivos modificados (git diff main...HEAD): 8 files
- Scope IN declarado en Story File §2: 7 archivos de código + auto-blindaje.md = 8 total
- Match exacto: `src/lib/price.ts` (W1), `src/lib/price.test.ts` (W1), `src/routes/gasless.test.ts` (W3), `src/middleware/a2a-key.ts` (W0), `src/middleware/a2a-key.test.ts` (W4), `src/routes/gasless.ts` (W2), `.env.example` (W5), `doc/sdd/061-wkh-59-sec-drain-1/auto-blindaje.md` (doc)
- Scope OUT respetado: cero cambios en `supabase/migrations/`, `src/services/budget.ts`, adapters
- Wave order W0→W1→W2→W3→W4→W5: commits en orden cronológico correcto (verificado en git log)
- CD-1 confirmado: grep `estimatedCostUsd = 1.0` en `a2a-key.ts` → sin resultado (placeholder eliminado)
- CD-7 confirmado: grep `request.body` en `a2a-key.ts` → solo comentario explicativo, no lectura real
- none — zero drift

---

## Gates (ejecutados directamente — no hay cr-report.md en el directorio)

- tsc: PASS — `npx tsc --noEmit` exit 0 (verificado en esta sesión)
- vitest: PASS — 556/556 tests, 52 files, exit 0 (verificado en esta sesión)
- lint/build: NO ejecutados — sin cr-report.md disponible; orquestador confirmó "556/556 tests, TS clean" en el handoff

**Listo para DONE.**
