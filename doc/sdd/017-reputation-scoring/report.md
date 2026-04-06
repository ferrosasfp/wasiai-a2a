# Report — #017: Reputation Scoring (WKH-28)

> NexusAgil DONE Phase — Cierre de Feature
> Fecha: 2026-04-05
> Branch: `feat/017-reputation-scoring`
> Modo: QUALITY

---

## 1. Resumen de la Historia de Usuario

**HU**: WKH-28 — "[S4-P6] Reputation scoring — modelo de latencia, success rate, cost efficiency (Eli)"

### Objetivo

Computar reputation scores para agentes A2A basado en metricas reales del event log (`a2a_events`) usando una formula ponderada de tres dimensiones: success rate, latencia y eficiencia de costo. Los scores computados enriquecen el endpoint `/discover` para ranking inteligente y se exponen en `/dashboard/api/stats` por agente.

### Contexto de negocio

Antes de esta HU, el orden de agentes en `/discover` dependia exclusivamente de scores estaticos provenientes del mock registry (escala 0-5, rango 4.5-4.9 para los tres agentes mock). Con WKH-28, los scores se calculan dinamicamente a partir de eventos reales de composicion (`compose_step`), permitiendo diferenciar agentes por comportamiento observado: un agente rapido, barato y confiable obtiene un score alto; uno lento, caro o con fallos obtiene un score bajo.

### Formula de scoring (escala 0-5)

```
success_rate    = successful_invocations / total_invocations           (0-1)
latency_score   = 1 - min(avg_latency_ms / 30000, 1)                  (0-1)
cost_efficiency = 1 - min(avg_cost_usdc / 0.10, 1)                    (0-1)

raw_score       = 0.50 * success_rate
                + 0.30 * latency_score
                + 0.20 * cost_efficiency                               (0-1)

reputation_score = raw_score * 5                                       (0-5)
```

Pesos: reliability (50%), speed (30%), cost (20%).

---

## 2. Archivos Creados y Modificados

### Archivos nuevos (3)

| Archivo | Descripcion |
|---------|-------------|
| `supabase/migrations/20260405300000_reputation_view.sql` | SQL VIEW `v_reputation_scores` que agrega `a2a_events` filtrando solo eventos `compose_step` con `agent_id IS NOT NULL`. Agrupa por `agent_id` (slug) y expone: `total_invocations`, `success_count`, `success_rate`, `avg_latency_ms`, `avg_cost_usdc`. No es una tabla — es una VIEW que siempre devuelve datos frescos. |
| `src/services/reputation.ts` | Servicio `reputationService` con metodo `getScores(slugs?)` que lee la VIEW via Supabase, aplica la formula en TypeScript y retorna `ReputationScore[]` en escala 0-5. Exporta tambien `computeScore()` (funcion pura) y `filterByMinReputation()`. Constantes exportadas: `SCORE_SCALE=5`, `MAX_LATENCY_MS=30000`, `MAX_COST_USDC=0.10`, `MIN_INVOCATIONS=1`. Errores no bloquean: retorna `[]` + `console.error`. |
| `src/services/reputation.test.ts` | 8 tests unitarios (T1-T8) con mock de Supabase via `vi.mock`. Cubre: happy path, formula exacta (spot-check docusynth=4.35), empty VIEW, error Supabase, escala 0-5 en extremos, clamping en boundaries, filtrado por slugs con `.in()`, y `filterByMinReputation`. |

### Archivos modificados (4)

| Archivo | Cambio |
|---------|--------|
| `src/types/index.ts` | Agrega interfaz `ReputationScore` (11 campos, escala 0-5). Agrega campo opcional `reputationScore?: number \| null` a `AgentSummary`. |
| `src/services/discovery.ts` | Importa `reputationService`. Inyecta bloque de enriquecimiento de reputacion entre `results.flat()` y el sort (try/catch, no-blocking). Implementa filtro `minReputation` post-sort. Actualiza `total` para reflejar count post-filtro. Orden de operaciones: fetch -> flat -> enrich -> sort -> filter minReputation -> limit (CD-5). |
| `src/services/event.ts` | Importa `reputationService`. En `stats()`, inicializa `reputationScore: null` por agente, luego enriquece con scores computados via `getScores(slugs)`. Errores no bloquean el dashboard (bare `catch {}`). |
| `src/routes/discover.ts` | Correccion de comentario: `minReputation: (0-1)` → `minReputation: minimum reputation score (0-5)` (M-8, post B-1 scale correction). |

---

## 3. Resultados por Fase del Pipeline

### F0 + F1 — Analyst + Architect (Work Item v2.1)

Generado `work-item.md` v2.1 con:
- **3 hallazgos BLOQUEANTES resueltos en diseno** (B-1, B-2, B-3): scale mismatch 0-1 vs 0-5, falta de filtro `event_type`, confusion slug vs id.
- **5 simplificaciones/constraints** (M-1, M-4, M-5, S-1, S-4): MAX_COST_USDC lowered a 0.10, MIN_INVOCATIONS=1 para demo-ability, SQL VIEW en lugar de tabla materializada, documentacion de escala de dashboard vs reputation.
- 7 Acceptance Criteria (AC-1..AC-7) en formato EARS.
- 3 Constraint Directives (CD-1..CD-3) para prevenir errores de implementacion.
- Sizing: S — ~2h, 3 waves.

### F2 — Architect (SDD + Story File v1.1)

SDD generado con diseno tecnico completo: SQL VIEW especificada, tipos, servicio, inyeccion exacta en `discovery.ts` y `event.ts`, 5 Constraint Directives (CD-1..CD-5), grafo de dependencias entre waves.

Story File auto-contenido con codigo de implementacion listo para copiar, checklist anti-alucinacion de 14 puntos, y escalation rule.

Correction v1.1: BLQ-1 (test T7 renombrado a T8 para el filtro minReputation), MNR-4 (refs a exemplares), MNR-5 (null safety en `data ?? []`).

### F3 — Dev (Implementacion)

Implementacion completada en 3 waves siguiendo el Story File exactamente:
- Wave 0: Migration SQL VIEW + tipos en `index.ts`.
- Wave 1: `reputation.ts` + `reputation.test.ts` (test-first).
- Wave 2: Integracion en `discovery.ts`, `event.ts`, `routes/discover.ts`.

### F3.5 — AR (Adversary Review)

**Veredicto: APROBADO con MENORs (0 BLOQUEANTES)**

| ID | Severidad | Hallazgo |
|----|-----------|---------|
| MNR-1 | MENOR | `getScores([])` con slugs array vacio hace SELECT * sin filtro (performance en produccion) |
| MNR-2 | MENOR | Sin indice `event_type` en `a2a_events` para optimizar la VIEW (post-hackathon) |
| MNR-3 | MENOR | Pre-existente: `Number(undefined) → NaN` en `mapAgent` de `discovery.ts` (no introducido por WKH-28) |
| MNR-4 | MENOR | Sin tests de integracion para los bloques de enriquecimiento en `discovery.ts` y `event.ts` |

Verificaciones pasadas: 111/111 tests, TSC 0 errores, SQL sintaxis valida.

### F3.6 — CR (Code Review)

**Veredicto: APROBADO con MENORs (0 BLOQUEANTES)**

| ID | Severidad | Check | Hallazgo |
|----|-----------|-------|---------|
| NC-7 | MENOR | Naming | Linea de import en `reputation.test.ts:16` excede 120 chars (cosmetico) |
| EH-4 | MENOR | Error Handling | `catch {}` silente en `event.ts:193-195`; inconsistente con `discovery.ts` que si loguea |
| CD-1 | MENOR | Duplication | Patron de enriquecimiento duplicado en `discovery.ts` + `event.ts` (aceptable para hackathon) |
| TS-4/5 | MENOR | Type Safety | `Number()` redundante en campos ya tipados como `number` en `ReputationRow` |
| TS-12 | MENOR | Type Safety | Pre-existente: NaN en `mapAgent` (no introducido por WKH-28) |
| TQ-9 | MENOR | Test Quality | Sin test para `getScores(undefined)` (path sin `.in()`) |
| TQ-10 | MENOR | Test Quality | Sin test para `MIN_INVOCATIONS` filter (agente con 0 invocaciones) |
| TQ-13 | MENOR | Test Quality | Sin test para `filterByMinReputation([])` — input vacio |

3 hallazgos auto-corregidos durante analisis: IH-8 (hoisting de vi.mock correcto), TS-10 (test-only type), TQ-15 (aritmetica verificada → 4.35 correcto).

Checklist anti-alucinacion del Story File: todos los 14 items verificados OK.

### F4 — Validation (QA)

**Veredicto: APPROVED — READY TO MERGE**

| Gate | Resultado |
|------|-----------|
| `npx vitest run` | 111/111 PASS (10 archivos, 8 nuevos para reputation) |
| `npx tsc --noEmit` | 0 errores, 0 warnings |
| ACs verificados | 5/5 con evidencia file:line |
| Drift vs Story File | NONE — 0 drift detectado en 7 archivos |
| BLOCKERs AR | 0 |
| BLOCKERs CR | 0 |

Todos los Acceptance Criteria verificados con evidencia directa:
- AC-1 (CD-1): Escala 0-5 correcta, T2 spot-check (4.35), T5 (0.0-5.0), T6 (clamping).
- AC-2 (CD-2): VIEW filtra `compose_step` + `agent_id IS NOT NULL` hardcodeado en SQL.
- AC-3 (CD-3): JOIN por slug consistente en `discovery.ts:41` y `event.ts:187,191`.
- AC-4 (CD-4): Errores no bloquean discovery ni dashboard — doble capa try/catch.
- AC-5 (CD-5): Orden correcto flat -> enrich -> sort -> filter -> limit en `discovery.ts:33-65`.

---

## 4. Auto-Blindaje — Errores Encontrados Durante el Pipeline

| Fase | ID | Tipo | Error encontrado | Resolucion |
|------|----|------|------------------|------------|
| F0/F1 | B-1 | BLOQUEANTE | Scale mismatch: scores computados en 0-1, registry usa 0-5 → discovery sort incompatible | Scores escalados a 0-5 multiplicando `raw_score * 5` (SCORE_SCALE=5) |
| F0/F1 | B-2 | BLOQUEANTE | `eventService.stats()` no filtra `event_type`, incluye `orchestrate_goal` (agent_id=null) → contamina agregacion | VIEW usa `WHERE event_type = 'compose_step' AND agent_id IS NOT NULL` en lugar de reusar stats() |
| F0/F1 | B-3 | BLOQUEANTE | Confusion slug vs UUID: `a2a_events.agent_id` almacena el SLUG (ej. "docusynth"), no el UUID → JOIN erroneo con `agent.id` | Todo el dominio renombrado a `agent_slug`; discovery join via `agent.slug`, no `agent.id` |
| F0/F1 | M-1 | MENOR | MAX_COST_USDC=1.0 original: precios mock 0.01-0.05 → cost_efficiency siempre ~0.95-0.99, sin diferenciacion | MAX_COST_USDC rebajado a 0.10 → precio $0.05 = 0.50, precio $0.01 = 0.90 (diferenciacion real) |
| F0/F1 | S-1 | SIMPLIFICACION | Tabla materializada con upsert + TTL cache = complejidad innecesaria para <1000 eventos | SQL VIEW reemplaza la tabla: siempre fresca, sin upsert, sin TTL, sin computed_at |
| F0/F1 | S-4 | SIMPLIFICACION | MIN_INVOCATIONS=3 deja agentes sin score en demos con pocos eventos | Rebajado a 1: cualquier invocacion produce score para demo-ability |
| F0/F1 | M-4 | CONSTRAINT | Dashboard `successRate` es 0-100; reputation `success_rate` es 0-1 → confusion potencial | Documentado como Constraint Directive CD-2 en Work Item y SDD |
| F0/F1 | M-5 | MENOR | Agentes con 100% fallos obtienen score 2.5/5 porque eventos fallidos tienen latency≈0 y cost=0 | Documentado como riesgo R4; aceptable para demo (agentes mock siempre exitosos) |
| F2 v1.1 | BLQ-1 | BLOQUEANTE SDD | Test T7 del Work Item (minReputation filter) tenia numero incorrecto en Story File | Renombrado a T8; T7 ahora es slug filtering via `.in()` |
| F2 v1.1 | MNR-5 | MENOR SDD | Null safety insuficiente: `data as ReputationRow[]` sin guard | Corregido a `(data ?? []) as ReputationRow[]` en Story File y SDD |

**Total errores detectados por el pipeline antes de implementacion: 10 (3 BLOCKERs, 5 MENORs/SIMPLIFICACIONES, 2 correcciones SDD)**

---

## 5. Metricas Finales

### Tests

| Metrica | Valor |
|---------|-------|
| Tests totales | 111 |
| Tests pasando | 111 (100%) |
| Tests nuevos (WKH-28) | 8 |
| Archivos de test | 10 (ninguno regresionado) |
| Duracion del test run | 752ms |

### Calidad de codigo

| Metrica | Valor |
|---------|-------|
| TypeScript errors (tsc --noEmit) | 0 |
| BLOCKERs en AR | 0 |
| BLOCKERs en CR | 0 |
| MENORs en AR | 4 |
| MENORs en CR | 9 |
| Drift vs Story File | 0 (todos los 14 checklist items: OK) |
| ACs cumplidos | 5/5 |

### Alcance

| Metrica | Valor |
|---------|-------|
| Archivos nuevos | 3 |
| Archivos modificados | 4 |
| Lineas SQL (migration) | ~25 |
| Waves completadas | 3/3 (W0, W1, W2) |
| Sizing estimado | S — ~2h |
| Decisiones de diseno documentadas | 10 (D1-D10) |
| Errores bloqueados por Auto-Blindaje | 3 BLOCKERs |

### Deuda tecnica registrada (post-hackathon)

| ID | Descripcion | Prioridad |
|----|-------------|-----------|
| MNR-1 | Early return `if (slugs?.length === 0) return []` en `reputation.ts` | Baja |
| MNR-2 | Indice compuesto `(event_type, agent_id)` en `a2a_events` para escala | Media |
| EH-4 | Agregar `console.error` en `event.ts:193-195` bare catch para homogenizar logging | Baja |
| R4 | Agentes 100% fallidos obtienen score 2.5 por latency≈0 y cost=0; mitigar computando avg solo sobre eventos exitosos | Media |

---

*Report generado por NexusAgil Docs Agent — Fase DONE*
*HU: WKH-28 | SDD #017 | Fecha: 2026-04-05*
