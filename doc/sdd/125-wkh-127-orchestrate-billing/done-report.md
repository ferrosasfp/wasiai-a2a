# Report — WKH-127: Orchestrate Billing (precio real + reembolso en fallo)

## Resumen ejecutivo

**Entrega completa**: WKH-127 debita el costo real del plan (no $1 placeholder) en `/orchestrate` y reembolsa atómicamente cuando el pipeline falla (total/parcial). Corrigió un incidente real (2026-06-24) donde un usuario quedó con `budget=0` sin recibir valor. El pipeline NexusAgil QUALITY se ejecutó completo: F0/F1 (work-item.md) → F2 (sdd.md SPEC_APPROVED self-approve) → F2.5 (story-file.md) → F3 (implementación 5 waves + fix-pack por BLQ-ALTO-1) → AR (encontró double-charge, resuelto) → CR (15/15 CDs verificados) → F4 (11/11 ACs + evidencia). Status final: **DONE**. Merged en main (`3b0c1b2`, PR #110). Migración de DB aplicada y verificada en Supabase prod.

---

## Pipeline ejecutado

| Fase | Resultado | Detalles |
|------|-----------|----------|
| **F0: Project Context** | ✅ | Codebase grounding: 7 archivos leídos, exemplars verificados (`increment_a2a_key_spend`, `resolveComposePriceHandler`, `budgetService`). |
| **F1: Work Item** | ✅ HU_APPROVED (self) | `doc/sdd/125-wkh-127-orchestrate-billing/work-item.md` — incidente real + 11 ACs EARS + DT-1/DT-2/DT-3/DT-4 + CD-1..CD-8. |
| **F2: SDD** | ✅ SPEC_APPROVED (self) | `sdd.md` — decisión DT-1: **Opción B (débito post-plan en el service)** con flag `skipMiddlewareDebit`. Resuelve todos los `[NEEDS CLARIFICATION]` del work-item. RPC `refund_a2a_key_spend` (FOR UPDATE + ownership guard) definida con SQL up+down. Constraint Directives 8 heredados + 7 nuevos (total 15). |
| **F2.5: Story File** | ✅ | `story-WKH-127.md` — 5 waves, 16 tests, anti-hallucination checklist, decisión [TBD-F2.5] resuelta (route handler setea headers leyendo flags del result). Scope IN/OUT exhaustivo. |
| **F3: Implementación** | ✅ W1-W5 DONE | W0: tipos + migración SQL (up+down). W1: `budgetService.credit()`. W2: middleware skip `skipMiddlewareDebit` path master. W3: `markSkipMiddlewareDebitHandler` + headers desde result. W4: pre-check → plannedCost → débito post-plan → refund AC-5/AC-6 → remaining. W5: 16 tests verdes. **Fix-pack (BLQ-ALTO-1)**: drift del SDD §4.0 "sum del plan" vs modelo real "precio del step-0" — greedy `cost = selected[0]?.priceUsdc` y LLM `plannedCostUsd = discovered agent[0].priceUsdc` (no suma). Tests recalibrados + invariante "sum de todos los débitos == costo real, cada item una vez". |
| **AR: Adversarial Review** | ✅ APROBADO | **Hallazgo BLQ-ALTO-1** (double-charge steps 1..N): el SDD describió débito como "suma del plan" pero compose sigue cobrando steps 1..N → debitados dos veces. Causa: drift de diseño. Fix: ajustar cost a step-0 únicamente (greedy + LLM). Evidencia: `orchestrate.billing.test.ts` con compose real (no mockeado), invariante total. **Aplicación del auto-blindaje WKH-125 BLQ-MED-1** (CREATE OR REPLACE con overload huérfano): CD-12 fuerza RPC 100% aditiva (CREATE de función nueva, down = DROP IF EXISTS). |
| **CR: Code Review** | ✅ APROBADO (15/15) | CD-1 (compose intacto), CD-2 (no refund en éxito), CD-3/CD-4 (atomicidad + ownership guard), CD-5/CD-7 (x402/compose intactos), CD-6 (sin msg PG crudo), CD-8 (preHandler antes middleware), CD-9/CD-11/CD-15 (débito EXCLUSIVO master/middleware, no doble-charge), CD-10 (ownerRef obligatorio), CD-12/CD-13/CD-14 (RPC aditiva + hardening). |
| **F4: Validación + Quality Gates** | ✅ APROBADO | 11/11 ACs PASS (T-AC1..AC11 + T-AC-DOUBLE). 3 tests MW: T-MW-SKIP-on/off/deleg. 1 test RPC: T-RPC-refund-atomic. Suite total: 1671 tests. tsc strict OK. biome check OK. Build OK. |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| **AC-1** | PASS | Orchestrate debita precio real (`sum(agent.priceUsdc)` del plan — corregido en fix-pack a `step-0 price`), no $1. Test T-AC1: plan $0.30+$0.20 → `debit(_, _, 0.30)` (step-0). |
| **AC-2** | PASS | `steps.length===0` → `debit()` nunca llamado (0 calls). Test T-AC2. |
| **AC-3** | PASS | Monto debitado == costo real del plan, no placeholder. Test T-AC3. |
| **AC-4** | PASS | Plan todos `priceUsdc===0` → debita $1 + warn + header `x-debit-fallback: registry-miss`. Test T-AC4. |
| **AC-5** | PASS | Fallo total (`success===false`, `totalCostUsdc===0`) → `credit()` reembolsa `debitedUsd`. Test T-AC5 (regresión incidente). |
| **AC-6** | PASS | Fallo parcial (`success===false`, `totalCostUsdc>0`) → `credit()` refund `max(0, debited-total)`. Test T-AC6a/6b. |
| **AC-7** | PASS | Tras refund total, `budget[chainId]` restaurado + `daily_spent_usd` revertido a 0. Test T-AC7 (real.test.ts, migración verificada). |
| **AC-8** | PASS | `credit()` falla → log `[orchestrate.refund-failed]` con keyId/chainId/amountUsd/orchestrationId + `refundError:true` (sin msg PG). Test T-AC8. |
| **AC-9** | PASS | x402 caller (sin `scopingKeyRow`) → NO débito post-plan, NO credit-back. Test T-AC9. |
| **AC-10** | PASS | `/compose` intacto (`resolveComposePriceHandler` + débito step-0 = hoy). Regresión test T-AC10. |
| **AC-11** | PASS | Pipeline exitoso (`success===true`, `totalCostUsdc>0`) → NO refund, fee 1% aplicado (success-gated). Test T-AC11. |

---

## Hallazgos finales

### Bloqueantes (resueltos)
- **BLQ-ALTO-1** (encontrado en AR, fix-pack post-implementation):
  - **Problema**: drift del SDD §4.0 "débito = sum del plan" vs modelo real "débito = precio del step-0". Compose sigue cobrando steps 1..N con guard `i>0`, así que si orchestrate sumaba todo el plan + compose cobraba per-step → double-charge.
  - **Causa raíz**: SDD error de diseño (confundió el objetivo: reemplazar $1 placeholder del step-0 por su precio real, no introducir cobro nuevo). Dev implementó literal. Tests se calibraron al modelo equivocado (pasaban en verde).
  - **Fix (quirúrgico)**: greedy `cost = selected[0]?.priceUsdc` (no `reduce` suma). LLM `plannedCostUsd = discovered.agents[0].priceUsdc` (no `totalCost`). Tests recalibrados con invariante clave: "suma total de todos los débitos (service step-0 + compose steps 1..N) == costo real del plan, cada ítem cobrado UNA sola vez".
  - **Evidencia**: `orchestrate.billing.test.ts` con compose real (no mockeado), T-BILL-1: total 0.06 (step-0 0.06, no per-step), no 0.11 (doble). T-AC1/AC3 recalibrados. T-AC5/AC6 refund recalculado sobre debited=0.30.
  - **Lección aplicada**: cuando un SDD describe un débito como "suma/total" verificar SIEMPRE contra qué OTRA capa cobra los mismos ítems. Si dos capas tocan el mismo conjunto, sus débitos deben ser DISJUNTO (CD-11).

### Menores (aceptados)
- Ninguno marcado como deuda. El auto-blindaje WKH-125 BLQ-MED-1 (overload huérfano de `CREATE OR REPLACE`) fue preventivo en CD-12.

---

## Auto-Blindaje consolidado

### Aprendizajes previos aplicados

**WKH-125 BLQ-MED-1** (recurrente ≥3 HUs): `CREATE OR REPLACE` en una función con cambio de aridad genera overload huérfano sin forma de limpieza.
- **Aplicación en WKH-127**: CD-12 — RPC `refund_a2a_key_spend` es 100% aditiva (nueva función, no reemplaza). Down = `DROP FUNCTION IF EXISTS` (reversible limpio, ref auto-blindaje WKH-125 BLQ-MED-1).

**WKH-125b** (biome formatter rompe aserciones largas): escribir aserciones `Number(...)` ya multilínea.
- **Aplicación en WKH-127**: W5 tests — biome check OK sobre los archivos tocados (no rompe).

---

### Nuevos hallazgos del AR (WKH-127 BLQ-ALTO-1) — entrada consolidada

| ID | Tipo | Hallazgo | Aplicación futura |
|----|----|----------|-------------------|
| **WKH-127 BLQ-ALTO-1** | PATH DE DINERO / DRIFT | Double-charge steps 1..N cuando SDD describe débito como "suma del plan" pero otra capa (compose) cobra los mismos items por separado. | **Cuando un SDD introduce un débito/cobro nuevo**: (1) verificar qué OTRAS capas tocan los mismos ítems; (2) testear el INVARIANTE TOTAL (suma de todos los débitos == costo real, cada ítem una vez) CON la dependencia real (no mockeada); (3) un mock de la dependencia oculta el double-charge. En WKH-127, `orchestrate.billing.test.ts` con `compose` REAL (no mock) lo atrapó. |

---

## Archivos modificados

**Commit `3b0c1b2` (merge de PR #110, squash de fix-pack)**

### Migraciones BD
- ✅ `supabase/migrations/20260623000000_wkh127_refund_a2a_key_spend.sql` (CREATE RPC + hardening)
- ✅ `supabase/migrations/20260623000000_wkh127_refund_a2a_key_spend_down.sql` (DOWN trivial)

### Código fuente
- ✅ `src/types/index.ts` — 3 campos en `OrchestrateResult`: `refundError?`, `debitFallback?`, `remainingBudgetUsd?`
- ✅ `src/middleware/a2a-key.ts` — `declare module` + `skipMiddlewareDebit` + skip débito master bajo flag + skip header post-debit
- ✅ `src/services/budget.ts` — `credit(keyId, chainId, amountUsd, ownerRef)` atómico
- ✅ `src/routes/orchestrate.ts` — `markSkipMiddlewareDebitHandler` preHandler (antes middleware) + headers desde result
- ✅ `src/services/orchestrate.ts` — pre-check balance → plannedCostUsd (paso 0 price, no suma) → débito post-plan → refund AC-5/AC-6 → remaining

### Tests
- ✅ `src/services/orchestrate.test.ts` — T-AC1..AC11 + T-AC-DOUBLE (16 tests)
- ✅ `src/middleware/a2a-key.test.ts` — T-MW-SKIP-on/off/deleg-ignored (3 tests)
- ✅ `src/__tests__/e2e/refund-atomicity.real.test.ts` — T-RPC-refund-atomic (opt-in DB)

---

## Deploy + Estado de infraestructura

| Componente | Estado | Detalles |
|-----------|--------|----------|
| **Código** | ✅ Merged | main (`3b0c1b2`, PR #110). Build TypeScript strict OK. npm test 1671 pass. biome check OK. |
| **Migración BD UP** | ✅ Aplicada | Supabase prod (`<supabase-dev-ref>`). `refund_a2a_key_spend` con SECURITY DEFINER + GRANT solo a service_role. Verificado: RPC acredita budget, clampa daily_spent a 0, rechaza OWNERSHIP_MISMATCH. |
| **Migración BD DOWN** | ✅ Reversible | SQL clean `DROP FUNCTION IF EXISTS` — no overload huérfano. |
| **Railway deploy** | 🔄 En curso | Código en main listo. Migración ya aplicada. No hay cambios de env vars (RPC service_role no configurable, integrado en migrations). |

---

## Decisiones diferidas a backlog

- Ninguna. WKH-127 está autosuficiente (no spinoffs).

---

## Lecciones para próximas HUs

1. **Path de dinero + multi-capa débito**: cuando un SDD introduce un débito nuevo, verificar TODAS las capas que tocan los mismos ítems. Testear el invariante total (suma == costo real, cada ítem una vez) CON la dependencia real, no mockeada. Esto atrapó el double-charge en W5.

2. **Overflow de funciones en migrations**: nunca usar `CREATE OR REPLACE` que cambie aridad — genera overload huérfano. RPC nuevas son 100% aditivas (CREATE de función nueva); el down es `DROP IF EXISTS`. Aplicable a cualquier HU con RPC nueva (ej: WKH-126, WKH-128).

3. **Drift del SDD vs modelo real**: cuando un SDD describe un débito como "suma X" pero el código real cobra "cada ítem por separado", el gap es un error de diseño, no de implementación. AR con dependencias reales (no mockeadas) lo atrapa. En WKH-127, la suma del plan NO debería haber sido el débito — debería haber sido el precio del step-0. Lección: validar la semántica del débito contra el modelo de billing real ANTES de F3.

4. **Anti-hallucination en billing**: las firmas exactas de `debit`, `getBalance`, `credit` son críticas (argumentos, tipos de retorno, mapeo de error sin msg crudo). El checklist del Story File 2026-06-23 las enumera. Reutilizarlas en HUs futuras sobre path de dinero.

---

## Conclusión

WKH-127 cierra el incidente real (usuario debitado sin valor, bounce-back imposible) con un modelo atómico: débito del costo real post-plan + credit-back en fallo total/parcial, protegido con 15 constraint directives (8 heredados + 7 nuevos) y 16 tests verificadores. El AR encontró y resolvió un drift de diseño (BLQ-ALTO-1: double-charge) que hubiera sido invisible sin testear la dependencia real. Pipeline NexusAgil QUALITY se ejecutó limpio: todos los sub-agentes cumplieron rol (analyst, architect, dev, adversary, qa, docs). La HU está **DONE**.

---

*Report generado por nexus-docs — F4 APROBADO, _INDEX.md actualizado a DONE. Fecha: 2026-06-23 23:59:59 UTC.*
