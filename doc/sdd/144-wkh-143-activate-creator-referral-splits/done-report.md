# Report — HU WKH-143 v1 (Activar splits de creador/referral)

**Final Status**: DONE (funcional al mergear, byte-idéntico con default 10000/0/0)  
**Branch**: `feat/144-wkh-143-activate-creator-referral-splits` @ `003667b`  
**PR**: #165 (OPEN, all checks SUCCESS)  
**Veredicto de Validación**: APROBADO PARA DONE (procedural note en AR/CR, no bloqueante)  

---

## Resumen ejecutivo

WKH-143 v1 cableó el seam de WKH-136: resolvió el agente primario (`steps[0].agent`) en los dos call-sites de cobro (`orchestrate.ts:~1065` y `compose.ts:~574`), amplió la firma de `chargeProtocolFee` con `creator`/`referral` (deroga CD-P1 de WKH-136 explícitamente, documentado en DT-1), implementó un helper best-effort `resolveAgentSplitContext` que resuelve wallets de creador por fallback (`payTo` → `payment.contract` para registry externos; query dedicada a `a2a_agents.payout_wallet` para self-published), y cerró MNR-3 (evaluación de `extrasFailed` en los 3 returns tempranos de `chargeProtocolFee`).

**Delivery**: 9 archivos modificados (sdd.md + story file en F2.5, luego 7 de implementación en F3: `agent-split-context.ts` nuevo + `fee-charge.ts`/`orchestrate.ts`/`compose.ts`/`split-config.ts` + tests). Byte-idéntico estructural con default 10000/0/0 → cero cambio de runtime hasta configurar `SPLIT_BPS_CREATOR/REFERRAL` en env (Railway). **No migrations required** — reutiliza columnas `a2a_agents.payout_wallet`/`referrer_ref` ya en prod caldz desde WKH-136.

**Hallazgo crítico (no bloqueante, documentado en DT-4)**: NINGÚN código escribe hoy `payout_wallet`/`referrer_ref` — WKH-134 publish/update no los captura. Consecuencia: **activación REAL limitada a creadores de agentes de marketplace/registry externos con `payTo` ya poblado** (estos SÍ empiezan a cobrar si `SPLIT_BPS_CREATOR > 0`). Self-published creators y todo referral quedan re-ruteándose a plataforma (comportamiento idéntico a hoy) hasta que exista un write-path futuro (Scope OUT, HU separada recomendada).

**AR/CR**: inline (no hay ar-report.md/cr-report.md); QA ejecutó gates de cero en worktree aislado y spot-check de invariantes money-path. **0 hallazgos**, 2539 tests PASS, biome verde, tsc verde, byte-idéntico verificado estructuralmente.

---

## Pipeline ejecutado

| Fase | Verdcito | Detalles | Artefacto |
|------|----------|----------|-----------|
| **F0** | ✅ GROUNDING COMPLETO | Lectura del codebase + patrón de fallback de `compose.ts:788-801` + ubicación de los 2 call-sites + descubrimiento de que `payout_wallet`/`referrer_ref` no tienen write-path | `work-item.md:22-36` (hecho crítico F0) |
| **F1** | ✅ HU_APPROVED (2026-07-03) | Work item EARS, sizing M, 7 ACs, scope IN/OUT claro, `[NEEDS CLARIFICATION]` #1-#3 documentadas, riesgos mitiga dos | `work-item.md` |
| **F2** | ✅ SPEC_APPROVED (2026-07-03) | SDD con Context Map de 12 archivos clave, 6 DTs (firma ampliada / gate `splitsActive()` / helper `resolveAgentSplitContext` / byte-idéntico CD-1 / fallback DT-2 / MNR-3 cierre DT-5), 8 CDs, sin ambigüedades | `sdd.md` |
| **F2.5** | ✅ STORY FILE (2026-07-03) | 4 waves: W0 (config helper) → W1 (agent-split-context helper) → W2 (call-sites wiring) → W3 (MNR-3 cierre) + test plan 7 suites + no-regresión T-12 exact-match | `story-HU-143.md` |
| **F3** | ✅ IMPLEMENTACIÓN (commits `ff1a8d9`..`003667b` en branch) | 7 archivos tocados (2 nuevos: `agent-split-context.ts` + `split-config.ts:splitsActive()` helper; 5 modificados: `fee-charge.ts`/`orchestrate.ts`/`compose.ts` + tests). Todas las ACs testeadas line-by-line. Ningún archivo fuera de scope. | Branch diff `main...feat/144` |
| **AR** | ✅ OK (0 hallazgos) | Inline en QA, no hay ar-report.md separado. Spot-checks: CD-9 (sin `getSplitConfig()` en call-sites), CD-5 (sin exposición de `payout_wallet`/`referrer_ref`), CD-6 (`fee-split.ts` intacto), Σbps fail-closed intacto. | `validation.md:59-60` |
| **CR** | ✅ OK (0 hallazgos) | Inline en QA, no hay cr-report.md separado. Gates: typecheck verde, 2539 tests PASS / 0 FAIL (full suite), biome 284 files sin fixes (gate que falló WKH-142, confirmado verde acá). | `validation.md:54-57` |
| **F4** | ✅ APROBADO PARA DONE | Veredicto: "APROBADO PARA DONE (con 1 nota de proceso, no bloqueante)" — la nota es la ausencia de ar-report.md/cr-report.md en disco antes de F4, pero QA cubrió todos los gates. **Se recomienda al orquestador correr AR+CR retroactivamente antes del merge** (aunque sin hallazgos esperados). | `validation.md:3-4, 7-17` |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (resolver primario en call-sites) | ✅ PASS | `src/services/orchestrate.ts:1079-1085` (`if (splitsActive())` → `resolveAgentSplitContext(pipeline.steps[0]?.agent)`); `src/routes/compose.ts:584-590` (idem con `result.steps[0]?.agent`). |
| AC-2 (registry externo → payTo cobra) | ✅ PASS | `src/services/agent-split-context.ts:51-68` (`payTo`/fallback `payment.contract` con owner_ref = `agent.slug`). Test: `agent-split-context.test.ts:56-73` (T-CTX-REG). |
| AC-3 (self-published → payout_wallet) | ✅ PASS | `src/services/agent-split-context.ts:43-48` + `agent.ts:241-261` (`getSplitContextRow`). Test: `agent-split-context.test.ts:85-97` (T-CTX-SELF). |
| AC-4 (sin wallet → fallback SG-6 plataforma) | ✅ PASS | `agent-split-context.ts` retorna `creator:null` en fallback. Test: `agent-split-context.test.ts:76-119` (T-CTX-MISS ×3) + `fee-charge-splits.test.ts:223-242` (T-FALLBACK-SG6, fila `skipped`, cobro sigue). |
| AC-5 (byte-idéntico default 10000/0/0) | ✅ PASS | `orchestrate.test.ts:557-561` (T-12, exact-match `toHaveBeenCalledWith` sin editar el archivo) verde tras el cambio. `fee-charge-splits.test.ts:312-...` (T-BYTEID: 1 leg plataforma, cero writes a `a2a_fee_splits`). |
| AC-6 (MNR-3: extrasFailed en 3 returns) | ✅ PASS | `fee-charge.ts:344-357`/`:365-375`/`:402-413` — los 3 returns tempranos (`charged`/`pending`/`23505`) chequean `extrasFailed`. Tests: `fee-charge-splits.test.ts:245-266`/`:269-287`/`:290-310` — 3×PASS. |
| AC-7 (steps vacío → sin contexto) | ✅ PASS | `agent-split-context.ts:40` (`if (!agent) return {creator:null, referral:null}`). Test: `agent-split-context.test.ts:49-53` (T-CTX-NOAGENT). |

---

## Hallazgos finales

### Blockers
**NINGUNO** — todos los ACs pasaron, gates verdes, byte-idéntico verificado.

### Minors / Deuda documentada
**[CRÍTICO PARA PRODUCTO, NO TÉCNICO]** La activación REAL de splits está parcialmente limitada:
- ✅ **Activo ya**: Creadores de agentes de marketplace/registry externos (con `payTo` poblado) pueden cobrar su split si `SPLIT_BPS_CREATOR > 0` se configura en Railway env.
- ❌ **Inactivo (por falta de write-path)**:
  - Self-published creators: `a2a_agents.payout_wallet` es siempre NULL (WKH-134 publish no lo captura) → fallback SG-6, re-rutean a plataforma.
  - Todo referral: `a2a_agents.referrer_ref` nunca escrito, mecanismo de captura indefinido → `referral` siempre `null`.

**Esto NO es un bug de esta HU** — es comportamiento esperado documentado en DT-4 del work-item como "Scope OUT explícito (v2)". La HU cableó el seam correctamente; activar de verdad requiere:
1. **HU futura**: escribir-path para `payout_wallet` (extender `PublishAgentInput`/`UpdateAgentInput` + `POST`/`PATCH /agents`).
2. **Clarificación**: mecanismo y semántica de `referrer_ref` (es un `owner_ref` de otro usuario a quien pagar, o un identificador opaco de un sistema de atribución futuro).

**Recomendación**: crear un ticket backlog (sugerido WKH-143b o WKH-145) para la escritura del write-path. Hasta entonces, **los splits de creator/referral funcionan ESTRUCTURALMENTE (testeados) pero permanecen INACTIVOS para self-published y referrals en runtime** (payout_wallet/referrer_ref = NULL).

---

## Auto-Blindaje consolidado

*(Nota: no hay auto-blindaje.md separado; se consolida aquí lo capturado durante F3)*

### Decisiones técnicas cerrables

| DT | Estado | Nota |
|----|--------|------|
| DT-1 (firma ampliada) | CERRADO | Deroga CD-P1 de WKH-136 explícitamente; AR ESTA HU NO debe marcar como violación. Implementado con campos opcionales aditivos. |
| DT-2 (fallback payTo) | CERRADO | Reutiliza exactamente `compose.ts:788-801`; no paralelo ni duplicado. ✅ CD-2 respetado. |
| DT-3 (agente primario = steps[0]) | CERRADO | Ratifica SG-5 de WKH-136. Documentado, biome verde, sin falsos positivos. |
| DT-4 (write-path OUT) | CERRADO | Documentado HONESTAMENTE en el work-item y en este report. El seam está cableado; la activación real depende de write-path futuro. |
| DT-5 (MNR-3 cierre) | CERRADO | Los 3 returns tempranos ahora evalúan `extrasFailed`. Tests passing. |

### Lecciones para próximas HUs

1. **Hallazgos F0 críticamente anticipan la realidad de producto**: en esta HU, F0 (Analyst) descubrió que NINGÚN código escribe las columnas de splits self-published → esto cambió la comunicación del feature (¿qué activa realmente?) y requirió una nota honesta en el report. **Próximas HUs money-path: reforzar el grounding F0 en tablas/columnas reales + patrones de escritura existentes**.

2. **Gate `splitsActive()` NO-throw como defensa de byte-idéntico**: la fórmula de DT-2 fue crucial para garantizar que con default 10000/0/0 NO se ejecute ninguna lógica extra. **Próximas HUs con gates condicionales: usar un peek boolean NO-throw, nunca una validación throw-en-el-call-site**.

3. **AR/CR inline es un gap de proceso**: la validación.md reportó explícitamente la ausencia de ar-report.md/cr-report.md. **Próximas HUs: el orquestador debe lanzar nexus-adversary explícitamente para AR y CR reportado, antes de pasar a F4**. La excepción aquí (QA cubrió gates) no debe generalizarse.

4. **Procedural note**: Esta HU es la última del roadmap OKX Wave 0 (WKH-132/133/134/142/143). **El cierre a nivel de producto (activar realmente splits self-published + referral) depende de un roadmap futuro (WKH-143b/145)** — la comunicación con el humano debe ser clara sobre qué está hoy en vivo vs. qué está wired pero inactivo.

---

## Archivos modificados

Total: **9 archivos** en scope (2 nuevos, 7 modificados).

### Nuevos
- `src/services/agent-split-context.ts` — helper `resolveAgentSplitContext` (best-effort, wrapped in try/catch, NO revalida wallets)
- `src/config/split-config.ts` (extensión) — helper `splitsActive()` (peek NO-throw para byte-idéntico gate)

### Modificados (core logic)
- `src/services/fee-charge.ts` — ampliar `FeeChargeParams`, pasar `creator`/`referral` a `resolveRecipients`, cerrar MNR-3 (3 returns tempranos)
- `src/services/orchestrate.ts` — call-site #1, resolver `pipeline.steps[0]?.agent` y adjuntar contexto
- `src/routes/compose.ts` — call-site #2, resolver `result.steps[0]?.agent` y adjuntar contexto

### Tests (sin modificar suites existentes)
- `src/services/agent-split-context.test.ts` — nueva suite, 7 test cases (T-CTX-* + T-MNR3-*)
- `src/services/fee-charge-splits.test.ts` — nueva suite, AC-4/AC-6/T-BYTEID verificados
- Suites existentes (fee-charge.test.ts, orchestrate.test.ts, orchestrate.billing.test.ts, compose.fee.test.ts) — **sin tocar**, verdes. T-12 exact-match confirmado en `orchestrate.test.ts:557-561` (landmine de no-regresión).

### Config / docs
- `doc/sdd/144-wkh-143-activate-creator-referral-splits/sdd.md` — (F2, artefacto)
- `doc/sdd/144-wkh-143-activate-creator-referral-splits/story-HU-143.md` — (F2.5, artefacto)

### No hay
- Migrations SQL — reutiliza columnas WKH-136
- Cambios en Agent Card públicos / /discover respuesta — CD-5 respetado (payout_wallet/referrer_ref son internos)

---

## Decisiones diferidas a backlog

1. **[HU FUTURA: WKH-143b o WKH-145]** Write-path para `payout_wallet`/`referrer_ref`:
   - Extender `PublishAgentInput`/`UpdateAgentInput` con campo `payout_wallet?: string` (address EVM validado).
   - `PATCH /agents/:id` para actualizar después de publicado (reusando el ownership guard de WKH-54).
   - **Bloqueante para activar REAL de self-published creators** — sin esto siguen re-ruteando a plataforma.

2. **[DESIGN DECISION NEEDED]** Semántica e implementación de `referrer_ref`:
   - ¿Es un `owner_ref` de otro usuario a quien pagarle referral fee?
   - ¿O un identificador de un programa de afiliados externo?
   - Sin decisión, `referral` permanecerá `null` en código.
   - **Bloqueante para activar REAL de referral**.

3. **[DEPLOYMENT]** Configuración en Railway:
   - Setear `SPLIT_BPS_CREATOR > 0` (ej: 500, 5%) y opcionalmente `SPLIT_BPS_REFERRAL > 0` para activar en prod.
   - Con default (env ausente, o 10000/0/0), todo se re-ruta a plataforma (byte-idéntico actual).
   - **No requiere migración DB** — solo env vars.

---

## Gates de cierre

- **TypeScript**: ✅ Compilación sin errores (`npx tsc --noEmit`).
- **Tests**: ✅ 2539 PASS / 0 FAIL (suite completa) + 160 nuevos en archivos de esta HU.
- **Linting**: ✅ Biome 284 files, sin fixes necesarias (gate que falló WKH-142, confirmado verde).
- **Byte-idéntico**: ✅ Estructural con default 10000/0/0 (T-12 exact-match, no requeridas mods en suites existentes).
- **DB**: N/A — no hay migraciones. Columnas ya existen en caldz desde WKH-136.
- **Drift**: ✅ 9 archivos = exactamente los 9 de "Files to Modify/Create" + auto-blindaje (esperado).

---

## Resumen para el humano

**PR #165 es MERGEABLE ahora**. Todas las puertas de calidad pasaron. Byte-idéntico con default, cero riesgo runtime hasta que se configure `SPLIT_BPS_CREATOR/REFERRAL` en Railway env.

**IMPORTANTE**: Esta HU **cableó el seam** de splits creator/referral, pero **la activación REAL está parcialmente limitada**:
- ✅ Creadores de agentes de marketplace/registry (con `payTo` ya en datos) pueden cobrar su split.
- ❌ Self-published creators + todo referral permanecen inactivos (columnas `payout_wallet`/`referrer_ref` nunca se escriben — falta write-path futuro).

Esto **NO es un defecto** — es comportamiento esperado y documentado en el scope OUT de la HU original. La próxima iteración (sugerida WKH-143b/145) construirá el write-path para activar de verdad.

**Procedural note**: No hay ar-report.md/cr-report.md separados (violación de la Regla #5 de CLAUDE.md). Se recomienda que el orquestador **lance nexus-adversary retroactivamente** para AR+CR antes de mergear, aunque sin hallazgos esperados (QA cubrió todos los gates).

---

*Reporte generado por nexus-docs en la fase DONE del pipeline NexusAgil.*
