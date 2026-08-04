# Report — HU 218 [WKH-318 corte B] El over-fetch se clampea al techo que el registry declara

## Resumen ejecutivo

**CRÍTICO — LEER PRIMERO:** Esta HU NO arregla producción sin la migración. Con código mergeado y migración sin aplicar, `/discover?limit=50` sigue devolviendo 3 de 23 agentes en bdwv. El clamp existe, funciona, se activa cuando la fila de `registries` declare su `schema.discovery.maxLimit=100`. Eso depende de una migración gated que el founder aplica. Lo que se entrega: mecanismo completo (código, tests, migración template).

Acción del founder: si necesita arreglarlo YA mientras el fix real pasa por CI, puede como paliativo aplicar `DISCOVERY_UPSTREAM_FETCH_LIMIT=100` en Railway (cubre `/compose` 50, `/orchestrate` 50, MCP 20; no cubre `?limit=101+` público). Recomendación: revertir ese paliativo una vez se aplique la migración propia de esta HU.

---

## Pipeline ejecutado

| Fase | Gate | Status | Archivos | Notas |
|---|---|---|---|---|
| F0 | grounding | LISTO | `.nexus/project-context.md` | Branch creada |
| F1 | HU_APPROVED | OK | `work-item.md` | 7 ACs EARS (3 subsumidas) |
| F2 | SPEC_APPROVED | OK | `sdd.md` | 11/11 readiness checks |
| F2.5 | story-file | OK | `story-WKH-318B.md` | 13 tests + 10 mutantes |
| F3 | implementación | OK | 19 archivos | W0→W1→W2→W3→W4 + fix-pack |
| AR | ataque adversarial | RECHAZADO → OK | `ar-report.md` | 2 BLQ-BAJO cerrados; 126 combos verificadas |
| CR | code review | OK CON MENORES | `cr-report.md` | 6 MENORES; ninguno bloquea |
| F4 | validación ACs | RECHAZADO → OK | `qa-report.md` | 7/7 PASS; drift limpiado en d1f805b |

---

## Acceptance Criteria — 7/7 PASS

| AC | Requerimiento | Veredicto | Evidencia |
|---|---|---|---|
| AC-1 | maxLimit declarado + limit del caller → limitParam <= maxLimit | PASS | T-CLAMP-01 discovery.limit.test.ts:246 |
| AC-2 | sin maxLimit → byte-idéntico | PASS | T-CLAMP-02 (4 sub-casos); AR: 126 combos |
| AC-3 | limitParam clampeado + página llena → truncated/page_full | PASS | T-CLAMP-03 discovery.truncation.test.ts:291 |
| AC-4 | wasiai con limitParam <= 100 no recibe 400 | PASS | T-CLAMP-04 + verificación real |
| AC-5 | /compose obtiene pool completo post-fix | PASS | T-CLAMP-05 compose.discovery-pool.test.ts:429 |
| AC-6 | migración → maxLimit=100 sin código extra | PASS | T-CLAMP-06 discovery.limit.test.ts:307 |
| AC-7 | clamp preserva piso pool 50 (una fuente) | PASS | T-CLAMP-07/07b |

---

## Hallazgos finales

**Bloqueantes (2 BLQ-BAJO, cerrados en fix-pack):**
- BLQ-BAJO-1: prosa afirma de más; reescrita con entrada falsificadora
- BLQ-BAJO-2: guard sin test; MA1+MA2 agregadas con aserciones

**Menores (6 CR, ninguno bloquea):**
- M-1: sub-caso faltante en T-CLAMP-02; agregado
- M-2: nombre helper; renombrado
- M-3: crédito typeof; prosa corregida
- M-4: 5 punteros; números actualizados
- M-5: disyunción; completada
- M-6: duplicación tests; parámetro opcional

---

## Suite y gates

- vitest: 5020/19 | 244 archivos
- tsc --noEmit: exit 0
- npm run lint: 442 archivos sin fixes
- migrate-preflight: PASS en ambos .sql

---

## Mutación — 13/13 muertos

10 contrato + 3 fix-pack. CD-7 vigente: aserciones contra upstreamLimits son literales, nunca recalculados.

---

## Deuda abierta (6 items)

| ID | Qué | Dueño | Gatillo |
|---|---|---|---|
| TD-318B-1 | B-3 cerrado sólo para maxLimit | W4 WKH-318 | evidencia B-6 |
| TD-318B-2 | maxLimit < 50 hunde pool | gatillo mecánico | logs BELOW_COMPOSE_POOL |
| TD-318B-3 | POST/PATCH sin validar | HU propia | pedir número |
| TD-318B-4 | fuerza catalogStatus (seguro) | monitoreo | impacto real |
| TD-318B-5 | segunda fuente maxLimit | HU futura | cuando la declare |
| TD-318B-6 | marcador sin control | HU propia | migrate-preflight.mjs |

---

## Archivos modificados (19)

**Lógica (2):** discovery-fetch-limit.ts (3 helpers), discovery.ts (clamp+warns)
**Tipos (1):** types/index.ts (JSDoc)
**Tests (4):** limit.test.ts, truncation.test.ts, sources.test.ts, pool.test.ts
**Migrations (2):** wkh318b_registry_max_limit.sql + _down — NO aplicados
**Docs (3):** backlog.md (B-3), mutation-log.md (13/13), auto-blindaje.md (4 lecciones)

---

## Status final

✅ APROBADO PARA MERGE

- 7/7 ACs con evidencia
- 5020 tests | 244 archivos | tsc 0 | lint 0
- 13/13 mutantes
- 19 archivos; drift limpiado
- 6 deudas con dueños

⛔ NO: aplicar migración (acción founder)
⛔ NO: afirmar "arreglado" sin migración

Rama: feat/218-wkh-318-corte-b-maxlimit-clamp | HEAD: d1f805b
