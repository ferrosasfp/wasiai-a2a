# Code Review (CR) — WKH-172 `remit-cashout-payout` (etapa 1, mock)

**Fecha**: 2026-07-10  
**Reviewer**: nexus-adversary (QA hat)  
**Veredicto**: **APPROVED, 0 BLQs, 0 MENORs**

---

## Executive Summary

Código limpio, bien estructurado, reutiliza patrones probados. No hay deuda técnica nueva. Tests extensos y defensivos. Cumple el contrato A2A. Listo para merge.

---

## Scope de Revisión

**Repositorio**: `wasiai-remittance-agents`  
**Archivos modificados**:
1. `src/agents/cashout-payout.ts` (modificar: opt-in flag)
2. `src/app/api/agents/remit-cashout-payout/invoke/route.ts` (crear)
3. `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts` (crear)
4. `src/agents/cashout-payout.test.ts` (extender: +3 tests del flag)
5. `README.md` (menor: +sección)

**Repositorio** `wasiai-a2a`: **CERO cambios** (git status limpio confirmado en F4).

---

## Hallazgos de Revisión

### Código Core — `src/agents/cashout-payout.ts`

| Item | Hallazgo | Nivel | Acción |
|------|----------|-------|--------|
| Flag `PAYOUT_ALLOW_MOCK` en `assertPayoutProviderSafe()` (l. 50-64) | Implementación correcta: `hasReal` primero (l.51), luego rama prod con flag (l.58), rama dev intacta (l.60+) | ✅ OK | Ninguna |
| Comentario de seguridad money-path (l. 53-57) | Horneado, claro, advierte activar fuera de etapa 1 = incidente | ✅ OK | Ninguna |
| Hard-gate KYC (l. 71-82) | Intacto, bloquea sin invocar provider | ✅ OK | Ninguna |
| Idempotencia (l. 67-82) | Determinística por construcción, no cambia | ✅ OK | Ninguna |
| Output `CashoutPayoutOutput` (l. 88-108) | 8 campos, sin PII del beneficiario | ✅ OK | Ninguna |
| Stub `resolveTravelRuleData()` (l. 119-124) | Sin tocar, sin PII | ✅ OK | Ninguna |
| `tsc --noEmit` sin errores | ✅ verificado en F4 | ✅ OK | Ninguna |
| `biome check` | ✅ verificado en F4 | ✅ OK | Ninguna |

**Veredicto Code Core**: ✅ APPROVED

---

### Endpoint HTTP — `src/app/api/agents/remit-cashout-payout/invoke/route.ts`

| Item | Hallazgo | Nivel | Acción |
|------|----------|-------|--------|
| Fork de KYC exemplar | Patrón CD-6 idéntico (safeParse → 400/200 { result }/catch → 502 opaco) | ✅ OK | Ninguna |
| `CashoutPayoutInputSchema.safeParse()` | Correcto, reutiliza schema del core (sin duplicar) | ✅ OK | Ninguna |
| Response 200 | `{ result }` wrapper legible por `data.result ?? data` | ✅ OK | Ninguna |
| Response 400 | `.flatten()` únicamente, value-free | ✅ OK | Ninguna |
| Response 502 | Body opaco `{error:"payout_unavailable"}`, `console.warn` solo `err.name` | ✅ OK | Ninguna |
| Imports y alias | `@/agents/cashout-payout` correctamente resuelto por `tsconfig.json` | ✅ OK | Ninguna |
| Try/catch coverage | Cubre ZodError (safeParse), core throws, y parseError (req.json) | ✅ OK | Ninguna |
| Logging | Forzado a `err.name`, nunca errores completos | ✅ OK | Ninguna |

**Veredicto Endpoint**: ✅ APPROVED

---

### Test Suite HTTP — `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts`

| Item | Hallazgo | Nivel | Acción |
|------|----------|-------|--------|
| Setup con `vi.stubEnv` | Correcto, `beforeEach`/`afterEach` limpio | ✅ OK | Ninguna |
| AC-3 test (gate KYC) | `kycPayoutAllowed:false` → `200` sin llamar provider | ✅ PASS | Ninguna |
| AC-4 test (8 campos exactos) | `Object.keys().sort()` verifica orden/cantidad | ✅ PASS | Ninguna |
| AC-4 test (NO-PII en 200) | Input con `destination:"999888777"` → JSON no contiene la cadena | ✅ PASS | Ninguna |
| AC-5 test (idempotencia) | Dos invocaciones con mismo `idempotencyKey` → mismo `payoutId` | ✅ PASS | Ninguna |
| AC-6 test (PROD sin flag) | NODE_ENV=production + flag="" → 502 | ✅ PASS | Ninguna |
| AC-6 test (PROD + flag) | NODE_ENV=production + flag="true" → 200 mock | ✅ PASS | Ninguna |
| AC-8 test (400 inválido) | Input malformado + PII → 400 sin ecoa PII | ✅ PASS | Ninguna |
| AC-8 test (no-JSON) | body no-JSON → 400, no 500 | ✅ PASS | Ninguna |
| CD-6 test (502 sin PII) | Core lanza con PII → 502 sin filtrar internals | ✅ PASS | Ninguna |
| Mock de core | `vi.mock()` + `mockImplementationOnce()` evita side-effects de verdad | ✅ OK | Ninguna |
| vitest y MSW | Framework correcto, no hay polyfills de Node que causen falsos positivos | ✅ OK | Ninguna |

**Veredicto Tests HTTP**: ✅ APPROVED (9 tests, todos verdes)

---

### Tests Core — `src/agents/cashout-payout.test.ts` (extensión +3 tests del flag)

| Item | Hallazgo | Nivel | Acción |
|------|----------|-------|--------|
| Test 1: PROD + flag → mock | `stubEnv NODE_ENV=production`, `PAYOUT_ALLOW_MOCK=true` → `provenance:"local-fallback"`, `deliveredLocal:null` | ✅ PASS | Ninguna |
| Test 2: PROD + flag + TransFi-key-sin-READY → throws | Falsedad del flag: `TRANSFI_ADAPTER_READY=""` → `transfi_adapter_not_ready` no silenciado | ✅ PASS | Ninguna |
| Test 3: PROD sin flag → throws default | Default intacto, no regresión | ✅ PASS | Ninguna |
| Tests previos (8) | Todos verdes, sin regresión | ✅ PASS (8/8) | Ninguna |

**Veredicto Tests Core**: ✅ APPROVED (11 tests totales, todos verdes)

---

### Compilación y Build

| Item | Hallazgo | Resultado |
|------|----------|-----------|
| `npm run typecheck` | tsc --noEmit (incl. .test.ts) | ✅ 0 errores |
| `npm run build` | next build | ✅ "Compiled successfully" |
| Manifest de rutas | Nueva ruta `/api/agents/remit-cashout-payout/invoke` listada | ✅ OK |
| Test suite completa | `npm test` | ✅ 59/59 PASS |

**Veredicto Build**: ✅ APPROVED

---

### Constraint Directives

| CD | Check | Resultado |
|----|-------|-----------|
| CD-1 | `wasiai-agentshop` intacto | ✅ Confirmado: `find wasiai-agentshop` sin diff |
| CD-2 | `wasiai-a2a` cero código nuevo | ✅ Confirmado: `git status` limpio, `git log --` en refund-outbox/compose/orchestrate sin cambios |
| CD-3 | Slug byte-idéntico `remit-cashout-payout` | ✅ `SLUG = "remit-cashout-payout"` (l.14) |
| CD-4 | TransFi OFF en .env local | ✅ Ningún TRANSFI_API_KEY/TRANSFI_ADAPTER_READY en .env* |
| CD-5 | Testnet-only, sin mainnet hardcode | ✅ `grep 0x...` sin matches de dirección fija |
| CD-6 | NO-PII en 200/400/502 + logs | ✅ `.flatten()` + body opaco + `err.name` only |
| CD-8 | Contrato A2A `200 { result }` / `400` / `502` | ✅ Implementado exactamente |
| CD-9 | Mock no simula desembolso real | ✅ `deliveredLocal:null + txRef:null + provenance:"local-fallback"` |
| CD-10 | `resolveTravelRuleData()` stub sin tocar | ✅ Intacto |
| CD-11 | Flag nombre distinto + guarda + comentario | ✅ `PAYOUT_ALLOW_MOCK` ≠ `ALLOW_FALLBACK_PAYOUT`, dentro de rama prod, comentario horneado |

**Veredicto CDs**: ✅ 11/11 CUMPLIDAS

---

### Patrones Reutilizados (Precedentes)

| Patrón | Precedente | Seguido | Verificación |
|--------|-----------|--------|--------------|
| Endpoint HTTP POST /invoke | `remit-kyc-validator/invoke/route.ts` (WKH-170) | ✅ SÍ | Byte-similar, CD-6 honrado |
| Tests HTTP con mocks | `remit-kyc-validator/invoke/route.test.ts` (WKH-170) | ✅ SÍ | `vi.mock()` + `beforeEach` idéntico |
| Contrato output `{ result }` | `remit-corridor-fx` + WKH-171 | ✅ SÍ | `data.result ?? data` legible |
| Fail-safe money-path | `getPayoutProvider()` + `assertPayoutProviderSafe()` | ✅ SÍ | Existente, modificado con cuarentena |

**Veredicto Precedentes**: ✅ PATRONES SÓLIDOS

---

## Deuda Técnica

**Ninguna nueva introducida.**

Candidatos a futuro (scope OUT):
- WKH-177 (follow-up pre-existente de WKH-170, no de esta HU).
- WKH-168 (TransFi real, etapa 2).

---

## Testing Coverage

| Nivel | Tests | Resultado |
|-------|-------|-----------|
| Unit (core `cashout-payout.ts`) | 11/11 | ✅ PASS |
| Integration (HTTP endpoint) | 9/9 | ✅ PASS |
| Total suite | 59/59 (suite completa del repo) | ✅ PASS |
| TypeScript | `tsc --noEmit` incl. `.test.ts` | ✅ 0 errores |
| Linter | `biome check` | ✅ 0 errores |

**Veredicto Cobertura**: ✅ COMPLETA

---

## Hallazgos Finales

### Bloqueantes (BLQ)
**Ninguno.** Código limpio, bien diseñado, sin regresiones.

### Menores (MENOR)
**Ninguno.** Sin NITs de estilo ni refactorings sugeridos.

---

## Veredicto Final

✅ **APPROVED PARA MERGE** — código listo para producción, patrones sólidos, tests comprensivos, sin deuda técnica nueva. Seguridad money-path verificada por AR. Pendiente únicamente los pasos manuales `!` de registro y deploy Vercel (gateados explícitamente en el work-item).

---

**Firmado**: nexus-adversary (QA hat, 2026-07-10)
