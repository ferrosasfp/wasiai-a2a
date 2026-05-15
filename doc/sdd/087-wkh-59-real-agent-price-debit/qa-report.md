# QA Report — WKH-59
> Date: 2026-05-14 · QA: nexus-qa · Branch: feat/087-wkh-59-real-agent-price-debit

## Veredicto

**PASS_WITH_NOTES**

---

## Runtime checks

| Gate | Comando | Resultado | Evidencia |
|------|---------|-----------|-----------|
| Tests (full suite) | `npm test` | PASS | 941/941, 68 files, 2.02s |
| Typecheck | `tsc --noEmit -p tsconfig.build.json` | PASS | 0 errors — "TypeScript compilation completed" |
| Lint WKH-59 files | `npm run lint` | PASS (pre-existing errores ignorados) | agent-price.ts, compose.ts, a2a-key.ts, compose.test.ts — 0 errores en archivos WKH-59. Error de formato en `types/index.ts:212-218` es pre-existente WKH-61 (CR OBS-5). Errores de formato/lint en `src/adapters/` son pre-WKH-59. |
| Build | `npm run build` | PASS | `tsc -p tsconfig.build.json` completa sin errores |
| Scope drift (archivos) | `git diff --name-only main...HEAD -- 'src/**/*.ts'` | PASS | 9 archivos exactos del Scope IN — 0 archivos extra |
| No migrations | schema check | N/A | WKH-59 no toca DB schema — `increment_a2a_key_spend` acepta NUMERIC, sin cambio |
| No Redis dependency | `package.json` | PASS | 0 dependencias ioredis/redis introducidas |

---

## AC verification

| AC | Texto (EARS compacto) | Status | Evidencia archivo:línea |
|----|-----------------------|--------|------------------------|
| AC-1 | WHEN POST /compose con `steps[0].agent` que existe en registry con `priceUsdc=X`, THEN middleware debita `X` USD para el primer step | PASS | `src/middleware/a2a-key.ts:133-138` (ternario composeEstimatedCostUsd-first) + `src/routes/compose.ts:79-80` (inyección del precio) + T-MW-COMPOSE-1 `src/middleware/a2a-key.test.ts:994-1009` (assert `debit(keyId, 2368, 0.001)`) |
| AC-2 | WHEN POST /compose con N>1 steps, THEN composeService debita `priceUsdc` por cada step 2..N vía `budgetService.debit`, atómico e independiente | PASS | `src/services/compose.ts:128-173` (guard `i > 0`, debit loop, abort on failure) + T-COMPOSE-DEBIT-1 `compose.test.ts:1083-1110` (assert 1 debit para 2 steps, amount=0.05) + T-COMPOSE-DEBIT-2 `compose.test.ts:1112-1146` (assert 2 debits para 3 steps, amounts=0.05+0.01) |
| AC-3 | WHEN `steps[0].agent` NO existe en registry, THEN 404 `AGENT_NOT_FOUND`, sin debit | PASS | `src/routes/compose.ts:54-60` (null check → 404) + T-ROUTE-PRICE-2 `compose.test.ts:230-244` (assert 404, mockCompose.not.toHaveBeenCalled) + T-E2E-PRICE-3 `compose.test.ts:379-392` (assert status 404, 0 downstream calls) |
| AC-4 | WHEN `priceUsdc` es null/undefined/0, THEN debit $1.00, warn log `reason: registry-miss`, header `x-debit-fallback: registry-miss` | PASS (con nota DT-J) | Step 0: `src/routes/compose.ts:63-77` (warn+header+$1.0) + T-ROUTE-PRICE-3 `compose.test.ts:246-261` (assert header). Steps 2..N: `src/services/compose.ts:138-154` (warn log — sin header, DT-J limitación documentada) + T-COMPOSE-DEBIT-7/8/9 `compose.test.ts:1289-1399` (assert debit $1, warn con reason+slug+step) |
| AC-5 | WHEN lookup de priceUsdc falla por DB error/timeout, THEN 503 `REGISTRY_UNAVAILABLE`, sin debit | PASS | `src/routes/compose.ts:81-95` (catch → 503) + T-ROUTE-PRICE-4 `compose.test.ts:263-276` (assert 503, mockCompose not called) + T-E2E-PRICE-5 `compose.test.ts:416-429` (0 debits) |
| AC-6 | WHEN POST /gasless/transfer, THEN middleware usa `request.gaslessEstimatedCostUsd` (path no afectado) | PASS | `src/middleware/a2a-key.ts:133-138` (ternario: gaslessEstimatedCostUsd segundo en cadena, preservado) + T-MW-GASLESS-1/2 (tests existentes passing en 941/941) |
| AC-7 | WHEN POST /discover o /orchestrate, THEN middleware usa placeholder $1.00 | PASS | `src/middleware/a2a-key.ts:138` (fallback `1.0` cuando ningún campo seteado) + T-MW-COMPOSE-3 `a2a-key.test.ts:1028-1043` (assert debit con 1.0) + DT-I documentado en sdd.md §5 |
| AC-8 | WHILE cache tiene entrada válida (TTL < 60s), retornar precio cacheado sin llamar discoveryService; tiempo < 5ms | PASS | `src/services/agent-price.ts:46-50` (retorno temprano `entry.expiresAt > now` — 0 I/O) + T-PRICE-2 `agent-price.test.ts:52-61` (assert getAgent llamado 1 vez, no 2; segunda call es cache hit) |
| AC-9 | WHEN TTL de cache expira, re-fetch desde discoveryService y actualizar TTL | PASS | `src/services/agent-price.ts:48` (strict `>` check — boundary correcta) + T-PRICE-3 `agent-price.test.ts:63-75` (vi.advanceTimersByTime(61_000) → getAgent llamado 2 veces, segundo precio actualizado) |
| AC-10 | WHEN se ejecutan tests baseline, 644+ tests pasan sin regresión | PASS | `npm test` → 941/941 PASS, 68 files, 2.02s. Baseline superado (941 >> 644) |
| AC-11 | WHEN WasiAgentShop hace 3 calls POST /compose (kyc=0.001 + corridor=0.05 + cashout=0.01), THEN budget total=$0.061 | PASS_SIM (real testnet NO VERIFICABLE) | T-E2E-PRICE-2 `compose.test.ts:342-377` (mocks: 3-step pipeline, assert `totalCostUsdc === 0.061`, mockCompose recibe scopingKeyRow+chainId). La validación con A2A key real vs Railway prod/staging requiere credenciales de testnet no disponibles en QA — esperable según instrucciones QA. Smoke checklist al final. |

---

## Drift detection

**0 drifts** en scope de código.

- Archivos modificados: exactamente los 9 listados en Scope IN del Story File. Verificado con `git diff --name-only main...HEAD -- 'src/**/*.ts'`.
- Archivos doc extra: `doc/sdd/087-wkh-59-real-agent-price-debit/` (ar-report.md, auto-blindaje.md, sdd.md, story-WKH-59.md, work-item.md) + `doc/sdd/_INDEX.md:77` — todos son artefactos de pipeline esperados, no scope creep.
- Wave order: W0→W1→W2→W3→W4→W5 confirmado en commits `76a4adf`→`9cd68e9`→`be6a068`→`c963ec9`→`d0e60f7`→`ba0232e`. Fix-pack `5d8f4ef` (BLQ-MED-1) y docs `56a7196` son iter-2 post-AR — correctos.
- DT-A..DT-J todos respetados (verificado por lectura de código).
- CD-11 guard `i > 0` presente en `compose.ts:128` — anti-double-debit intacto.
- CD-13: `_resetAgentPriceCache` SOLO en `agent-price.test.ts:37` — no importado en producción.
- Spec drift: 0. SDD §3 flow diagram mapea 1:1 con implementación en compose.ts preHandler array (líneas 104-119).

---

## Security gates

| Item | Check | Status | Evidencia |
|------|-------|--------|-----------|
| owner_ref leak en logs (CD-6) | grep owner_ref en logs de WKH-59 | PASS | warn logs usan únicamente `{reason, slug, step}` y `{reason, slug, registry}` — sin owner_ref. `compose.ts:84` comenta explícitamente "CD-6: NO incluir owner_ref". grep en compose.ts lines 65-95 + 144-153 confirmado. |
| Service role RLS bypass (WKH-53) | budgetService.debit ownership | PASS | `budget.ts:47-63`: `debit()` no requiere `ownerId` porque delega a `increment_a2a_key_spend` PG RPC que tiene su propia lógica interna. `getBalance()` tiene el guard `.eq('owner_ref', ownerId)` en línea 28. Patrón WKH-53 preservado. |
| Cache cross-tenant | ¿cache contiene datos owner-scoped? | PASS | Cache key es `${slug}::${registryName ?? '_all_'}` (`agent-price.ts:19-23`). Precio del agente es dato público del registry (no privado del tenant). Por diseño: el registry es global y el precio no varía por owner. T-PRICE-7/8 verifican scoping por slug+registry — sin owner dimension. |
| CD-7: middleware NO lee body | grep request.body en a2a-key.ts | PASS | `a2a-key.ts:130` solo contiene `request.body` en un comentario explicativo, no en código ejecutable. Confirmado: middleware solo lee `request.composeEstimatedCostUsd`, `request.gaslessEstimatedCostUsd`. |
| CD-12 chainId del mismo bundle | grep resolveChainKey en compose.ts | PASS | `services/compose.ts` no importa `resolveChainKey`. chainId viene únicamente de `request.chainId` (propagado desde `request.resolvedChainId` seteado en `a2a-key.ts:235`). |

---

## Observabilidad

| Evento | Ubicación | Cuándo se emite | Shape verificada |
|--------|-----------|-----------------|------------------|
| `compose-price.fallback` (warn) | `src/routes/compose.ts:66-73` | Step 0: priceUsdc === 0 | `{reason: 'registry-miss', slug, registry}` |
| `compose-price.fallback per-step` (warn) | `src/services/compose.ts:146-153` | Steps 2..N: priceUsdc === 0 o null o NaN | `{reason: 'registry-miss', slug, step}` — verificado en T-COMPOSE-DEBIT-8 |
| `compose-price.registry-unavailable` (error) | `src/routes/compose.ts:84-90` | discovery throws | `{err: message_string, slug}` — sin owner_ref |
| `a2a-key.debit` (info) | `src/middleware/a2a-key.ts:243-252` | Cada debit del middleware | `{keyId, chainKey, chainId, asset_symbol, amountUsd}` — existente pre-WKH-59 |
| Header `x-debit-fallback: registry-miss` | `src/routes/compose.ts:74` | Step 0 fallback ÚNICAMENTE | Verificado en T-ROUTE-PRICE-3 + T-E2E-PRICE-4 |
| Header `x-a2a-remaining-budget` | `src/middleware/a2a-key.ts:293` | Post-debit exitoso | Existente pre-WKH-59, sigue funcionando |
| **NOTA DT-J**: header `x-debit-fallback` NO se emite para steps 2..N | `src/services/compose.ts:133-137` | — | Limitación documentada en SDD §5 DT-J y auto-blindaje.md. Observable solo via warn log. Aceptable. |

---

## Rollback plan

- **Trigger**: deploy falla en Railway post-merge, o comportamiento inesperado en producción.
- **Revert**: `git revert <merge-commit-hash>` → PR → merge → redeploy en Railway. Retorna a placeholder $1 (estado pre-WKH-59). Sin impacto schema — no hay migración que revertir.
- **Cache in-process**: se limpia automáticamente al restart del proceso (Map en memoria). Sin persistencia, sin necesidad de flush manual.
- **Debits ya realizados**: los debits con precios reales ejecutados antes del revert quedan registrados en `a2a_agent_keys.budget` (PG function atómica). No son reversibles sin operación manual de Supabase. Impacto económico: precios reales < placeholder $1, entonces el revert a $1 es más conservador para el operador.
- **Backward-compat**: `/gasless/transfer`, `/discover`, `/orchestrate` no son afectados ni antes ni después del revert.

---

## Smoke checklist para el operador (AC-11 real testnet)

Para validar AC-11 con testnet real post-merge:

1. Obtener una A2A key con budget suficiente ($0.20+) en Railway staging.
2. Verificar `/auth/me` → anotar `daily_spent_usd` inicial (T0).
3. Ejecutar 3 llamadas secuenciales a POST `/compose`:
   - `{ "steps": [{ "agent": "kyc", "input": {...} }] }` → esperar 200
   - `{ "steps": [{ "agent": "corridor", "input": {...} }] }` → esperar 200
   - `{ "steps": [{ "agent": "cashout", "input": {...} }] }` → esperar 200
4. Verificar que NINGUNA respuesta tiene header `x-debit-fallback` (indica precios reales).
5. Verificar `/auth/me` → `daily_spent_usd` debe incrementar en $0.061 (kyc=$0.001 + corridor=$0.05 + cashout=$0.01). NO $3.00.
6. Verificar que no hay respuestas 5xx.

---

## Recomendación para DONE

**GO**

- 941/941 tests PASS, 0 regresiones, build limpio, typecheck limpio.
- AC-1 a AC-10 verificados con evidencia archivo:línea directa.
- AC-11: lógica verificada con T-E2E-PRICE-2 (simulado); validación testnet real es post-merge (no bloqueante según instrucciones QA F4).
- BLQ-MED-1 de AR correctamente resuelto en iter-2: `src/services/compose.ts:138-154` + T-COMPOSE-DEBIT-7/8/9.
- Scope drift: 0. Security gates: 5/5 PASS. Observabilidad: 7 eventos/headers documentados.
- Observaciones CR (OBS-1..OBS-5): todas menores, ninguna requiere acción pre-DONE.
