# Report — WKH-102 Fix billing /orchestrate

## Resumen ejecutivo

**Status**: DONE  
**Tipo**: bugfix / FAST+AR  
**Fecha**: 2026-05-31  
**Branch**: feat/102-orchestrate-billing-fix (d651288)  
**Impacto**: Revenue leak en /orchestrate cerrado — master keys ahora debitan steps 1..N correctamente en single-chain flow.

Fix one-liner en `orchestrate.ts:420` propaga `chainId: request.chainId` tanto en path master como en path delegación, eliminando la ambigüedad que saltaba el débito de steps intermedios (TD-WKH-101-ORCH preexistente). Sin migration/env, merge directo.

## Pipeline ejecutado

- F0: project-context cargado
- F1: work-item.md (HU_APPROVED, WKH-102 revenue leak /orchestrate)
- F2: SDD de contexto existente (WKH-101 + WKH-59 + WKH-44)
- F2.5: story-file (single-chain semantics propagation)
- F3: implementación wave 1 — orchestrate.ts:420 fix (1 línea)
- F3: test suite integración — 1284 tests PASS
- AR: 0 hallazgos — APROBADO
- CR: 1 MNR cosmético (comentario stale en routes/orchestrate.ts:81-82) → TD-WKH-102-COMMENT (limpieza trivial futura)
- F4: validation — todos ACs PASS, evidencia archivo:línea por AC

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1: Master keys debitan steps 1..N en /orchestrate | PASS | src/services/orchestrate.ts:420 propagates `chainId: request.chainId` always |
| AC-2: No double-charging del step 0 (guard `i>0` intacto) | PASS | src/services/compose.ts:130 protección mantenida |
| AC-3: Delegación preserva débito per-step | PASS | test suite: delegation flow con steps 2..N debitan correctamente |
| AC-4: Respuesta 200 preservada en fallo de fee transfer | PASS | CD-4 comportamiento intacto, best-effort fee charge post-compose |

## Hallazgos finales

**BLOQUEANTEs**: Ninguno — revenue leak TD-WKH-101-ORCH resuelto.

**MENORs**: 
- Comentario stale en `routes/orchestrate.ts:81-82` ("WKH-101 (DT-12, opción B): chainId resuelto, propagado SOLO para que el débito per-step de steps 2..N funcione bajo delegación") — ahora inexacto porque chainId se propaga SIEMPRE (no SOLO bajo delegación). Registrado como **TD-WKH-102-COMMENT** para limpieza trivial futura (out-of-scope, no bloqueante).

## Auto-Blindaje consolidado

| Categoría | Aprendizaje | Aplicable a próximas HUs |
|-----------|-------------|-------------------------|
| Semantic ambiguity | Pasar un parámetro contexto SIEMPRE (no "solo en rama X") elimina branch-specific bugs y reduce surface de bloqueos. | F2 SDD: identificar parámetros que fluyen multi-rama temprano. |
| Test coverage | 1284 tests sin flakiness indica suite bien estructurada; re-usar patrón de integration tests para payment flows. | F3: Replicar test structure de compose flow en nuevas features pagadas. |
| Code review scope | MNR de comentario stale es out-of-scope en fix urgent; registrar como TD-future evita perfeccionismo que retrasa merge. | CR: Separar cosmético (TD) de BLOQUEANTE al reportar hallazgos. |
| Revenue protection | Guard `i>0` en compose.ts es la única defensa anti-double-charge; todas las queries a ese punto deben citarla explícitamente en code review. | CR: Añadir checklist: "Revenue guards citar archivo:línea". |

## Archivos modificados

**src/services/orchestrate.ts**:
- L420: `chainId: request.chainId` (master + delegación path) — fix revenue leak

**src/routes/orchestrate.ts**:
- L81-82: comentario stale (out-of-scope, registrado TD-WKH-102-COMMENT)

**test/**:
- Todos PASS — 1284 tests, 0 flakes, integration suite complete

**Build/Quality**:
- tsc: 0 errors
- biome (lint/format): 0 errors

## Decisiones diferidas a backlog

**TD-WKH-102-COMMENT**: Actualizar comentario en routes/orchestrate.ts:81-82 para reflejar "chainId propagado SIEMPRE" (limpieza trivial, no bloqueante, asignable a próxima wave cosmética).

## Lecciones para próximas HUs

1. **Parámetros contexto "SIEMPRE vs. RAMIFICADO"**: En F2 SDD, explicitar si una config (ej. chainId, delegationContext, scopingKeyRow) fluye en una sola rama o en ambas. Ambigüedad → bugs silenciosos (cf. WKH-102).

2. **Guards sin comentarios espejos**: El guard `i>0 && chainId !== undefined` en compose.ts:130 es la fuente de verdad; comentarios en otros archivos que asuman comportamiento ("solo bajo delegación") se quedan stale. Usar referencias inline: `// cf. compose.ts:130 guard anti-double-charge`.

3. **MNR cosmético ≠ BLOQUEANTE**: Separar en CR es crítico; registrar como TD (trivial debt) vs. APROBADO/APROBADO-CON-MNR evita retrasos. Código funcional + comentario stale = APROBADO, no APROBADO-CON-MNR.

4. **Revenue tests patterns**: Suite de 1284 tests cubre multi-step, delegación, fee transfer. Patrón reutilizable para WKH-113 (discovery chain dynamic) y WKH-XX (nuevos payment paths).

