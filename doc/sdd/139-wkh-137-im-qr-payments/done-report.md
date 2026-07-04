# Report — HU WKH-137 v1 (Invocation Links)

## Resumen ejecutivo

**Status**: **DONE** (2026-07-04)  
**Qué se entregó**: Primitiva protocolar Invocation Links (mint+redeem de token opaco, single-use, price-capped). Tabla `a2a_agent_links` + 2 RPC atómicos (`claim_agent_link`, `settle_agent_link`) + service + 2 endpoints + tipos. Reusa money-path existente (`executeApprovedPlan`), NO reinventa dinero. Single-use garantizado por status-gate atómico; price-cap server-side; Ownership Guard DB-level + RLS deny-by-default desde el día 1.

**Branch**: `feat/139-wkh-137-invocation-links` @ `16e33b6`  
**PR**: #161 (MERGEABLE, sin mergear por instrucción)  
**Archivos clave**: `doc/sdd/139-wkh-137-im-qr-payments/` (work-item.md, sdd.md, story-HU-137.md, validation.md, auto-blindaje.md)

---

## Pipeline ejecutado

| Fase | Gate | Veredicto | Detalles |
|------|------|-----------|----------|
| **F0** | project-context | ✅ | Codebase grounding: 11 archivos leídos (exemplars + patrones), Context Map completo |
| **F1** | HU_APPROVED | ✅ | work-item.md v1 acotado (consumidor-side, NOT seller-side/bot — explícitamente fuera) |
| **F2** | SPEC_APPROVED | ✅ | sdd.md QUALITY/full money-path, 10 archivos a crear/modificar, 13 CD (obligatorios+prohibidos) |
| **F2.5** | — | ✅ | story-HU-137.md: contrato de integración + files + test plan |
| **F3** | Implementación | ✅ | 2 commits (344e808 + 16e33b6), W0-W3 completadas, 15 tests planeados + 2 extra (routing/agente-inexistente) |
| **AR** | Adversarial Review | 🚨 **BLQ-MED-1** | Leak cross-tenant: redeem público exponía `remainingBudgetUsd`/billing del owner → AC-7 VIOLADA |
| **Fix-Pack** | — | ✅ | `RedeemResult` acotado + `toRedeemResult()` + MNR-a (no-éxito sin cargo → reopen) + MNR-b (settle post-débito separado) |
| **re-AR** | Adversarial Review (post-fix) | ✅ OK | BLQ-1 CERRADO; MNR-c (gas overhead mainnet) documentado como TD explícita |
| **CR** | Code Review | ✅ OK | CD-9/CD-10 (exactOptionalPropertyTypes, biome-ignore puntual) verificados; cero violaciones scope IN |
| **F4** | QA / Validation | ✅ **PASS** | 2413 tests PASS + migración en Postgres efímero verificada (runtime: ALL checks ✅) |

---

## Acceptance Criteria — resultado final

| AC | Texto | Status | Evidencia |
|----|-------|--------|-----------|
| **AC-1** | Mint: token opaco hash-only, retornado 1 vez en 201, atado a slug/owner_ref/key_id/chain_id/maxPriceUsdc | ✅ PASS | `src/services/agent-link.ts:198-232` (token `wasi_a2a_link_<96 hex>`, INSERT solo `token_hash` SHA-256) + test T1 (`agent-link.test.ts:168-189`) + runtime: `information_schema.columns` confirma ÚNICA columna `token_hash`, NO campo para token crudo |
| **AC-2** | Redeem exitoso: precio ≤ cap → invoca bajo owner del link, marca consumido atómicamente | ✅ PASS | `agent-link.ts:289-321` (claim atómico `open→redeeming`) + test T5 (`agent-link.test.ts:217-234`) + runtime: `claim_agent_link` FOR UPDATE confirma transición atómica en Postgres real |
| **AC-3** | Precio > cap (pre-claim) → 409 sin debitar/invocar/consumir; precio drift (post-claim) → reopen sin débito | ✅ PASS | pre-claim: `agent-link.ts:307-318` + test T6 (`agent-link.test.ts:237-251`); post-claim: `agent-link.ts:378-388` + test T7 (`:254-268`); runtime: ambos paths confirmados |
| **AC-4** | Token inexistente/expirado/usado → 404/410/409 sin debit/invocación | ✅ PASS | service: `agent-link.ts:296-305`; route mapping: `agent-links.ts:164-171`; tests: T8-T10 (`agent-link.test.ts` + `agent-links.test.ts:120-141`); runtime: `claim_agent_link` RAISE correctos |
| **AC-5** | Sin endpoint PATCH/PUT (mint-once, inmutable) | ✅ PASS | `src/routes/agent-links.ts` solo 2 `fastify.post` (mint + redeem); test T15 (`agent-links.test.ts:146-162`): PATCH/PUT → 404 real |
| **AC-6** | Redeem aplica invariantes de execute (fee, receipt, Ownership Guard) | ✅ PASS | `agent-link.ts:362-374` reusa `executeApprovedPlan` sin modificar orchestrate.ts; Ownership Guard en `settle_agent_link` RPC (runtime: `OWNERSHIP_MISMATCH` confirma); AC-6 tras fix-pack BLQ-1 |
| **AC-7** | Exposición del token = 1 ejecución ≤ cap, SIN filtrar saldo del owner | ✅ PASS (post-BLQ-1) | **Fix-Pack**: `RedeemResult` acotado (`types/index.ts:599-611`) reemplaza `OrchestrateResult` interno; `toRedeemResult()` (`agent-link.ts:126-138`) es ÚNICA vía de salida; test BLQ-1 (`agent-link.test.ts:338-367`) inyecta leak simulado, asserta NO aparece en body |

---

## Hallazgos finales

### BLOQUEANTEs (resueltos)

- **BLQ-MED-1 (leak cross-tenant)**: Redeem público exponía `remainingBudgetUsd` + 4 campos de billing del owner → AC-7 VIOLADA.
  - **Causa raíz**: shape `OrchestrateResult` interno reusado directamente en canal externo sin filtro.
  - **Resolución**: `RedeemResult` acotado + `toRedeemResult()` allow-list explícita. Test BLQ-1 confirma leak CERRADO. **ESTADO: CERRADO**.

### MENOREs (aceptadas o resueltas)

- **MNR-a (fondos insuficientes → quemaba link)**: Execute sin cargo consumía el link terminal (quemaba single-use) → AC-3 LEVE VIOLADA.
  - **Causa raíz**: no se distinguía "no ejecutó" de "ejecutó con cargo".
  - **Resolución**: guard `pipeline.success===false && totalCostUsdc===0` → `reopen` + 503 retryable. **ESTADO: CERRADO**.

- **MNR-b (settle-fail post-débito → ambiguo 502)**: RPC settle fallaba DESPUÉS del débito → confusión con fallo pre-dinero.
  - **Causa raíz**: bookkeeping y ejecución bajo mismo try.
  - **Resolución**: settle en su propio try/catch; fallo post-débito → log + devolver éxito igual (dinero ya se movió). **ESTADO: CERRADO**.

- **MNR-c (gas overhead mainnet excede cap)**: `STEP_GAS_OVERHEAD_USD` (default 0, testnet sin impacto) puede exceder el cap nominal del link en mainnet.
  - **Causa raíz**: Heredado de `executeApprovedPlan`; cap-gate no contempla gas.
  - **Estado**: Documentado como **DEUDA TÉCNICA EXPLÍCITA** en `auto-blindaje.md:66-79` — acción diferida al ir a mainnet con `STEP_GAS_OVERHEAD_USD > 0`. **NO BLOQUEA v1 testnet (overhead=0 por default)**.

---

## Auto-Blindaje consolidado

### [2026-07-04] Wave 2 — Fastify route generic con options object
- **Error**: `TS2345` anotación inline handler con opciones en ruta.
- **Fix**: Mover genérico al call `fastify.post<{ Params; Body }>(path, opts, handler)`, handler sin anotación.
- **Aplicar en**: Rutas nuevas con `preHandler`/`config` tipadas.

### [2026-07-04] FIX-PACK BLQ-1 — redeem público filtraba saldo del owner (cross-tenant leak)
- **Fix**: `RedeemResult` acotado (SOLO `orchestrationId`, `answer`, `protocolFeeUsdc`, `pipeline{success,output}`).
- **Aplicar en**: Toda respuesta de endpoint público (auth por token) que reuse shape interno rico — mapear con allow-list, NUNCA spread directo.

### [2026-07-04] FIX-PACK MNR-a — execute no-exitoso quemaba el link
- **Fix**: Guard `pipeline.success===false && totalCostUsdc===0` → `reopen` + 503 retryable.
- **Aplicar en**: Single-use que consume tras money-path graceful-fail (no-cargo) — chequear cargo real antes de marcar consumido.

### [2026-07-04] FIX-PACK MNR-b — charged-but-502 si settle falla post-débito
- **Fix**: Settle en su propio try/catch; fallo post-débito → log reconciliación + devolver éxito (dinero ya movido).
- **Aplicar en**: Todo bookkeeping post-débito irreversible — fallo no debe revertir/ocultar el resultado del dinero.

### [2026-07-04] MNR-c (documentado, SIN cambio de lógica)
- **Observación**: Gas overhead puede exceder cap nominal en mainnet.
- **Estado**: TD explícita, acción diferida pre-mainnet.

---

## Archivos modificados

### Base de datos
```
supabase/migrations/20260706000000_wkh137_agent_links.sql
supabase/migrations/20260706000000_wkh137_agent_links_down.sql
```

### Service + Types
```
src/services/agent-link.ts (NUEVO)
src/services/agent-link.test.ts (NUEVO)
src/types/index.ts (modificado: agregar AgentLinkRow, CreateAgentLinkInput, MintAgentLinkResponse, RedeemResult)
src/types/database.types.ts (modificado: a2a_agent_links + Functions)
```

### Routes
```
src/routes/agent-links.ts (NUEVO: POST /agents/:slug/link + POST /agents/links/:token/redeem)
src/routes/agent-links.test.ts (NUEVO)
src/index.ts (modificado: registrar agentLinkRoutes)
```

### Testing
```
test/agent-links.migration.test.ts (NUEVO: verificación RLS/estructura DB efímero)
```

**Scope IN verificado**: 10 archivos exactos del Story File. **Cero modificaciones** a `src/services/compose.ts`, `src/services/orchestrate.ts` (service), `src/services/agent-price.ts` (solo lectura).

---

## Decisiones diferidas a backlog

Las siguientes son **explícitamente OUT de esta HU**, marcadas para HUs futuras:

1. **Bot Telegram/WhatsApp** — requiere repo nuevo consumidor de API a2a (análogo a Chaski/yarvis), Missing Inputs #1/#2. **Sugerencia**: HU separada (canal-layer).

2. **Seller sin HTTP** — cambio de modelo de invocación, requiere spike/epic separado (relay, webhook invertido, polling). **Bloqueado** hasta que el humano resuelva Missing Input #3 (arquitectura del lado seller). **Sugerencia**: WKH-137-seller o epic WKH-SELLER-HTTP-FREE.

3. **QR/página de redeem** — renderización del link como QR o página web = responsabilidad del canal (fuera de a2a).

4. **Onboarding desde cero sin Agent Key** — requiere flujo de signup nuevo (fuera de scope a2a). **Sugerencia**: WKH-ONBOARDING-IM.

5. **Session-key minting (DT-6)** — v1 rechaza session tokens en mint (CD-6) para evitar cap-bypass. Diferido a HU futura con dual-ledger billing. **Flag explícito**: no es `[NEEDS CLARIFICATION]` bloqueante, es decisión de seguridad ratificada.

**Nota de Retro**: El git diff muestra que no se generaron archivos `ar-report.md` / `cr-report.md` dentro de `doc/sdd/139-…/`. El trabajo de AR (hallazgo BLQ-1 + fix) fue documentado inline en `auto-blindaje.md`. Se recomienda al orquestador normalizar la generación de esos 2 reportes como artefactos separados en HUs futuras (regla CLAUDE.md: "evidencia archivo:línea por fase").

---

## Lecciones para próximas HUs

1. **Shape interno ≠ shape de canal externo** — reusar un type rico (ej. `OrchestrateResult`) en un endpoint público sin filtrar (AC-7, IDOR-like) es un pattern recurrente. Solución: allow-list explícita con `toXxxResult()` helper, test inyecta leak simulado para confirmar ausencia.

2. **Single-use + money-path graceful-fail** — ejecutables que pueden NO cobrar (fondos insuficientes, graceful return) requieren distinguir "no ejecutó" de "ejecutó pero falló" ANTES de marcar el recurso consumido. Test con `pipeline.success===false && totalCostUsdc===0`.

3. **Settle post-débito es su propia transacción** — cuando el bookkeeping corre DESPUÉS de un débito irreversible, su fallo NO debe confundirse con fallo PRE-dinero. Patrón: try/catch separado post-débito, log de reconciliación, devolver éxito del dinero igual.

4. **Gas overhead drifts con mainnet** — cap-gates que comparan precios DEBEN contemplar overhead. En testnet con overhead=0 no hay impacto; en mainnet requiere validación explícita. Doc: "cap es pre-gas o post-gas? mainnet = post-gas".

5. **Ownership Guard day-1, no deuda** — tabla nueva CON `owner_ref` + RLS deny-by-default desde la migración (no post-hoc) — verificable en runtime (`information_schema.table_privileges`). Lesson de WKH-53/SEC-02.

---

## Verification Summary

| Verificación | Resultado | Confianza |
|---|---|---|
| **tsc --noEmit** | ✅ GREEN (exit 0) | 100% |
| **vitest run** | ✅ 2413 PASS / 0 FAIL | 100% |
| **Migración up (Postgres efímero)** | ✅ Todas las columnas/constraints/índices/RLS como esperado | 100% |
| **Migración down (reversible)** | ✅ Funciones + tabla DROP correctamente | 100% |
| **RPC comportamiento (runtime)** | ✅ claim/settle atómicos, status-gates, ownership checks reales | 100% |
| **Scope drift** | ✅ CERO cambios fuera de `Scope IN` (confirmado git diff --stat) | 100% |
| **AC coverage** | ✅ AC-1..7 cubiertos 1:1 + tests por AC | 100% |

---

## Status Final

**✅ F4: PASS** — Listo para **DONE**.

PR #161 es **MERGEABLE** (todas las comprobaciones verdes). Instrucción explícita: NO mergear en esta fase (orquestador/humano lo decide).

---

*Generado por nexus-docs (Fase DONE, 2026-07-04). Artefactos consolidados de F0-F4 del pipeline QUALITY.*
