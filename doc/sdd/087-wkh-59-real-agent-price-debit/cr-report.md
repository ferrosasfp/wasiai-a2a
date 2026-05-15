# CR Report — WKH-59

> Date: 2026-05-14 · Reviewer: nexus-adversary (CR phase) · Branch: `feat/087-wkh-59-real-agent-price-debit`

## Veredicto

**APROBADO con observaciones**

Implementación completa de WKH-59 (iter-1 + fix iter-2 del BLQ-MED-1) cumple todos los ACs con evidencia ejecutable. AR bloqueante cerrado correctamente con DT-J + 3 tests (T-COMPOSE-DEBIT-7/8/9). Baseline 941/941 PASS. Observaciones residuales son MENORES y no bloquean DONE.

---

## AC closure

| AC | Verificación archivo:línea | Estado |
|----|----------------------------|--------|
| AC-1 priceUsdc step 0 | `src/routes/compose.ts:79-80` + `src/middleware/a2a-key.ts:133-138` + T-MW-COMPOSE-1 `a2a-key.test.ts:994-1009` | PASS |
| AC-2 priceUsdc step 2..N | `src/services/compose.ts:128-160` + T-COMPOSE-DEBIT-1/2 `compose.test.ts:1108-1145` | PASS |
| AC-3 404 AGENT_NOT_FOUND | `src/routes/compose.ts:54-60` + T-ROUTE-PRICE-2 `compose.test.ts:230-244` + T-E2E-PRICE-3 `:379-392` | PASS |
| AC-4 fallback step 0 | `src/routes/compose.ts:63-77` + T-ROUTE-PRICE-3 `compose.test.ts:246-261` | PASS |
| AC-4 fallback step 1+ (DT-J, sin header) | `src/services/compose.ts:138-154` + T-COMPOSE-DEBIT-7/8/9 `compose.test.ts:1289-1399` | PASS |
| AC-5 503 REGISTRY_UNAVAILABLE | `src/routes/compose.ts:81-95` + T-ROUTE-PRICE-4 + T-E2E-PRICE-5 | PASS |
| AC-6 gasless intacto | `src/middleware/a2a-key.ts:133-138` + T-MW-GASLESS-1/2 | PASS |
| AC-7 /discover, /orchestrate $1 (DT-I) | ternario default `1.0` + sdd.md DT-I + T-MW-COMPOSE-3 | PASS |
| AC-8 cache hit <5ms | `src/services/agent-price.ts:46-50` + T-PRICE-2 | PASS |
| AC-9 TTL re-fetch | `src/services/agent-price.ts:48` strict gt + T-PRICE-3 (advanceTimersByTime) | PASS |
| AC-10 no regresión 644+ baseline | `npm test` 941/941 (68 files) | PASS |
| AC-11 E2E $0.061 simulado | T-E2E-PRICE-2 `compose.test.ts:342-377` asserta `totalCostUsdc === 0.061` | PASS (QA F4 valida testnet real) |

---

## CD compliance

| CD | Defensa archivo:línea | Estado |
|----|----------------------|--------|
| CD-1 TS strict, no `any` | 0 hits grep `: any\|as any` en WKH-59. `as unknown` en `compose.test.ts:1367` justificado defensive null cast en test | PASS |
| CD-2 debit atómico vía PG | `src/services/compose.ts:156-160` usa `budgetService.debit` (RPC) | PASS |
| CD-3 cache hit <5ms | `src/services/agent-price.ts:46-50` retorno temprano sin I/O | PASS |
| CD-4 fallback honesto + warn | step 0: `routes/compose.ts:66-75` (warn + header + $1). steps 1+: `services/compose.ts:144-153` (warn — sin header DT-J) | PASS |
| CD-5 no regresión baseline | 941/941 PASS | PASS |
| CD-6 no leak owner_ref | logs usan `slug`, `step`, `reason` — NUNCA owner_ref | PASS |
| CD-7 middleware NO lee body | grep `request.body` solo en comentario `a2a-key.ts:130` | PASS |
| CD-8 resolveAgentPriceUsdc única ubicación | solo en `services/agent-price.ts:40` + imports | PASS |
| CD-9 `composeEstimatedCostUsd` ≠ `gaslessEstimatedCostUsd` | declarados separados en `a2a-key.ts:30-32` | PASS |
| CD-10 Fastify short-circuit reply.sent | `routes/compose.ts:56-60,91-95` + T-ROUTE-PRICE-2,4 asserta mockCompose.not.toHaveBeenCalled() | PASS |
| CD-11 guard `i > 0` único | `services/compose.ts:128` + T-COMPOSE-DEBIT-6 | PASS |
| CD-12 chainId del MISMO bundle | `a2a-key.ts:228,235` → `compose.ts` NO importa resolveChainKey | PASS |
| CD-13 `_resetAgentPriceCache` test-only | solo en agent-price.ts:69 + test | PASS |
| CD-14 no `failNext` | 0 hits en código WKH-59 (solo comentarios) | PASS |
| CD-15 preHandler NO valida steps.length | `routes/compose.ts:39-46` shape-guard mínimo; validación rich en handler | PASS |

---

## Hallazgos

### Bloqueantes: NINGUNO

### Observaciones (no bloquean)

- **OBS-1**: `services/compose.ts:145` fallback `console.warn` cuando `logger` undefined (callers directos sin Pino). Documentado en DT-J + auto-blindaje. By design.
- **OBS-2**: `routes/compose.test.ts:91` setup default `mockResolvedValue` (sin Once) en tests legacy WKH-61 — patrón de setup compartido, aceptable.
- **OBS-3**: `services/compose.test.ts:1367` `as unknown as { priceUsdc: number | null }` en test defensivo para simular registry malformado. Único, justificado.
- **OBS-4** (backlog AR): MNR-1 thundering herd, MNR-2 cache key `''`, MNR-3 orchestrate (resuelto vía DT-I) — backlog post-DONE.
- **OBS-5**: `npm run lint` reporta format issue en `types/index.ts:212-218` PRE-EXISTING WKH-61 (fuera de scope WKH-59).

---

## Quality metrics

| Métrica | Valor |
|---------|-------|
| `any` explícito en WKH-59 | 0 |
| `as any` | 0 |
| `as unknown` introducidos | 1 (test defensivo justificado) |
| TODOs/FIXMEs nuevos | 0 |
| `console.log` introducidos | 0 |
| Tests `.skip/.only/xit` | 0 |
| `failNext` patterns | 0 |
| Tests dependientes de orden | 0 |
| Test files PASS | 68/68 |
| Tests PASS | 941/941 |
| Test duration | 2.03s |
| Scope drift (archivos fuera Scope IN) | 0 |
| `/gasless/transfer` regresión | NONE (intacto) |
| `/discover` regresión | NONE |
| `/orchestrate` regresión | NONE (DT-I) |
| PG function `increment_a2a_key_spend` | INTACTA |
| Schema Supabase | INTACTO |

---

## Recomendación a F4 QA

Implementación lista para F4. QA debe:

1. Validar AC-11 con run real contra WasiAgentShop (kyc $0.001 + corridor $0.05 + cashout $0.01 = $0.061) midiendo `daily_spent_usd` antes/después en `a2a_agent_keys` (Supabase prod).
2. Confirmar headers `x-debit-fallback: registry-miss` y `x-a2a-remaining-budget` en responses cuando aplican.
3. Confirmar logs estructurados `compose-price.fallback per-step` en stdout/Pino del server.
4. Smoke /gasless/transfer + /discover + /orchestrate post-cambio (regresión AC-6/AC-7).

Las 5 observaciones son informativas para el done-report; ninguna requiere acción del Dev pre-QA.
