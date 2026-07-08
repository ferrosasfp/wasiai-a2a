# Report — HU [WKH-163] La remesa insignia se trunca por el backstop léxico de WKH-152 (dropea `cashout-matcher`)

**Fecha cierre**: 2026-07-09  
**Commit merge**: 17f0ae1 (main, post-fix)  
**Branch**: fix/164-wkh-163-cashout-matcher-relevance-fix  
**Veredicto final**: **DONE** — Entregado, todos los ACs satisfechos, zero regressions.

---

## Resumen ejecutivo

El backstop léxico per-step de WKH-152 truncaba la remesa insignia "Send $400 to my mom in Peru" (dropeaba `cashout-matcher`, la pata que entrega el dinero) porque el token puramente numérico `"400"` hacía echo con el `input` tailoreado de `kyc-validator` y `corridor-discoverer`, activando el drop del plan mixto. **Fix ejecutado (2 partes):**

1. **Opción 1 (causa raíz):** `llmGoalTokens = goalTokens \ {t : /^\d+$/.test(t)}` — excluye tokens puramente numéricos del set de relevancia del path LLM (goal-side, scoped). El plan insignia queda all-disjoint → CD-15 conserva los 3 steps.

2. **Opción 2 (defense-in-depth):** Terminal delivery guard — rescata el step terminal si-y-solo-si sería dropeado Y `llmDropped ≥ 2` (incompatible con T-152-1, donde `llmDropped=1`).

**Resultado:** remesa insignia restaurada (EN + ES), sin neutralizar el drop genuino de WKH-152 (T-152-1 sigue verde), sin reintroducir false-negative multilingüe (T-152-2b intacta), débito == ejecución airtight (AC-7).

---

## Pipeline ejecutado

| Fase | Gatekeep | Veredicto | Fecha | Evidencia |
|------|----------|-----------|-------|-----------|
| **F0** | Project context + code grounding | ✓ | 2026-07-08 | `work-item.md`: mecanismo leído en `orchestrate.ts:356-906` completo, DT-1/DT-2 confirmadas. |
| **F1** | Work-item + 8 ACs (EARS) | ✓ `HU_APPROVED` | 2026-07-08 | `work-item.md:131-159` — AC-1..AC-8 definidos, ratificados por el Analyst. |
| **F2** | SDD + Constraint Directives | ✓ `SPEC_APPROVED` | 2026-07-08 | `sdd.md:1-402` — resueltos los 2 `[NEEDS CLARIFICATION]` (DT-1/DT-2), CD-15 preservada, 9 tests T-152-* reconciliados sin edición. |
| **F2.5** | Story File — Dev playbook | ✓ | 2026-07-08 | `story-HU-163.md:1-371` — 4 waves (W0 fix + W2 guard + W3 tests), snippets A-D exactos, exemplars verificados. |
| **F3** | Implementación wave por wave | ✓ | 2026-07-09 | Commits en `fix/164-wkh-163-cashout-matcher-relevance-fix`: Opción 1 + Opción 2 + 4 tests nuevos, zero drift. |
| **AR** | Adversarial Review (seguridad money-path) | ✓ `APROBADO` (1 MNR) | 2026-07-09 | `ar-report.md:1-26` — 7 vectores de ataque OK (débito, never-empty, multilingüe, no-neutral genuino, gaming, numeric, T-152-*). MNR-1 = terminal-guard trade-off documentado (no bloqueante). |
| **CR** | Code Review (calidad + scope) | ✓ `APROBADO` (2 NITs foldeados) | 2026-07-09 | `cr-report.md:1-21` — `llmGoalTokens`, terminal-guard, T-163-1..4, CD-8/CD-9 respetados. NITs cosméticos (paridad EN/ES en debit assert, cross-ref WKH-163). |
| **F4** | QA / Validation (evidencia AC + gates) | ✓ `APROBADO PARA DONE` | 2026-07-09 | `validation.md:1-51` — 8/8 ACs PASS (AC-1..AC-8 con archivo:línea), zero drift, 2805 tests verdes. |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia (test:línea) | Evidencia (código:línea) |
|----|--------|------------------------|--------------------------|
| **AC-1** (goal EN insignia → 3 steps) | ✓ PASS | `orchestrate.test.ts:2616-2644` (T-163-1: los 3 slugs en `composeCall.steps`, sin `dropped`/`no_relevant_agent`, debit=0.5) | `orchestrate.ts:857-859` (`llmGoalTokens` exclude `/^\d+$/`), `:894` (gate usa `llmGoalTokens.size`), `:904` (filtro usa `llmGoalTokens`) |
| **AC-2** (goal ES insignia → 3 steps) | ✓ PASS | `orchestrate.test.ts:2648-2676` (T-163-2: mismo fixture, goal "Enviar 400 dolares…", mismos 3 slugs, debit=0.5) | Mismo bloque `:857-904` (goal-side, idioma-agnostic) |
| **AC-3** (multilingüe all-disjoint → `ready`) | ✓ PASS | `orchestrate.test.ts:2230-2309` (T-152-2b: goal ES vs agentes EN, sin `no_relevant_agent`/`dropped`, debit=0.4 byte-identical) | `orchestrate.ts:931-935` (CD-15: `applyDrop` requires `relevantSteps.length>0`), NO tocado por esta HU |
| **AC-4** (nonsense/sin agente → `no_relevant_agent`) | ✓ PASS | `orchestrate.test.ts:2473-2517` (T-152-6: all-demo), `:1882-1914` (T-W5: greedy) | `orchestrate.ts:937-949` (early-return exclusivo de `allStepsAreDemos`/`fallbackNoRelevance`), byte-identical |
| **AC-5** (nunca `steps:[]` por el backstop) | ✓ PASS | `orchestrate.test.ts:2170-2223` (T-152-2: all-disjoint → conserva 2), T-152-2b idem | `orchestrate.ts:931-935` (`applyDrop=false` si `relevantSteps.length===0`) |
| **AC-6** (drop del mixto genuino intacto) | ✓ PASS | `orchestrate.test.ts:2121-2162` (T-152-1: defi sigue dropeado, `llmDropped=1<2` → NO rescata), `:2339-2380` (T-152-4: recompute step-0) | `orchestrate.ts:919-925` (terminal-guard exige `droppedCount>=2`; T-152-1 tiene 1 → inert) |
| **AC-7** (débito == ejecución) | ✓ PASS | `orchestrate.test.ts:2616-2644` (T-163-1, `debit` 1 call, steps dropeados ausentes en `compose`), `:2752-2808` (T-163-4) | Filtro en `planOrchestration:851-935` ANTES de `budgetService.debit:1228` y `composeService.compose:1292` |
| **AC-8** (determinístico, sin LLM/red) | ✓ PASS | T-163-* usan `setLlmResponse` mockeado 1 sola vez (sin invocaciones de red adicionales por el guard) | `orchestrate.ts:857-859` (regex puro `/^\d+$/`), `:911-927` (terminal-guard: solo `.filter`/`.includes`, sin `await`) |

---

## Hallazgos finales

### BLOQUEANTEs
**Ninguno.** El fix es money-safe, airtight sobre débito==ejecución.

### MENOREs (MNR-1) — aceptado como documentado, no bloquea
**MNR-1 (terminal-guard trade-off):** el guard rescata el terminal aun si es genuinamente off-topic mientras `droppedCount>=2`. Es la decisión explícita CD-4 (proteger la pata de entrega contra desajuste multi-leg), el mal menor vs el bug insignia. El caller paga 1 step extra de su propio budget (sin leak cross-tenant). **Referencia:** `ar-report.md:22-23`.

---

## Auto-Blindaje consolidado

**Sin Auto-Blindaje específico generado en F3.** El fix es acotado y fue diseñado para evitar hallazgos:

- **Heredado de WKH-152/159** (aplicado a esta HU sin novedad):
  - CD-8 (`noUncheckedIndexedAccess`): respetado en el terminal-guard (const + `!== undefined`, sin `!`). ✓
  - CD-9 (biome inline multilínea): todos los nuevos tests/requests en multilínea, pasado el linter. ✓
  - CD-10 (never-empty-plan): el fix no vacía planes, solo REDUCE drops por relocalización semántica. ✓

- **Patrones reutilizados sin desviación:**
  - DT-1 (input-widening de WKH-152) **preservado** — variante (b) eligida (excluir solo puramente numéricos, mantener corpus con `input`). T-152-5 sigue verde. ✓
  - DT-3 (blast radius mínimo): `tokenizeForRelevance`, `textOverlapsGoal`, `goalTokens`, `fallbackNoRelevance`, early-return `no_relevant_agent` — **zero tocadas**. ✓

---

## Archivos modificados

| Archivo | Cambios | Impacto |
|---------|---------|--------|
| `src/services/orchestrate.ts` | +31 líneas / -2 líneas, `:849-927` | Opción 1 (`llmGoalTokens` + gate + filtro) + Opción 2 (terminal-guard) + comentarios WKH-163 |
| `src/services/orchestrate.ts` | `:1016-1023` | Reutilizado sin cambios (recompute de billing WKH-127/132) |
| `src/services/orchestrate.test.ts` | +274 líneas, `:2614-2808` | T-163-1, T-163-2, T-163-3, T-163-4 + fixtures reusadas (`wkh152Agents`/`wkh152Discovery`) |
| `doc/sdd/_INDEX.md` | 2 filas (163 + 164) | Fila 164 actualizada a DONE + link report; fila 163 (WKH-160) sin cambios |

**Git diff summary (main → 17f0ae1):**
```
 src/services/orchestrate.ts          |  33 ++-
 src/services/orchestrate.test.ts     | 274 +++
 2 files changed, 307 insertions(+), 2 deletions(-)
```

---

## Decisiones diferidas a backlog

### WKH-160 (fila 163) — Embeddings de relevancia semántica
**Status:** `in progress` (fuera de scope de esta HU).  
**Razón:** El residual estructural (overlap léxico binario incompatible con multilingüe) es el fix de fondo. Esta HU mitiga 2 clases: numérica (Opción 1) y multi-leg (Opción 2). El case single-leg non-numeric sigue siendo vulnerable. La migración pgvector + Voyage AI / OpenAI embeddings está en F0/F1 de WKH-160.  
**Relación con esta HU:** El SDD de WKH-160 (`sdd.md:394-398`) ya avisa sobre conflicto de merge con filas 161/162/163 en el bloque `:869-906`. Recomendación: esperar merge de WKH-163 (esta HU) ANTES de que WKH-160 reescriba ese bloque para shadow-mode.

---

## Lecciones para próximas HUs

1. **Residuals documentados son blueprints de bugs.** El propio SDD de WKH-152 (`:409-417`) ya había marcado "un step válido-pero-disjunto PODRÍA dropearse si OTRO step del mismo plan matchea". Esta HU es la manifestación en el flujo insignia de remesas 6 meses después. **Acción:** en SDD posteriores, marcar residuals con un `[FOLLOW-UP HU: número]` si hay evidencia de riesgo de negocio.

2. **`input` tailoreado en corpus de relevancia es de doble filo.** DT-1 de WKH-152 (ampliar corpus con `input`) fue deliberado para "false-negative-safe". Pero un monto (`amountUSD`) es señal universal en agentes financieros — demasiado débil. **Acción para embeddings (WKH-160):** marcar la distinción "tokens de contexto" vs "tokens de identidad del step" para clasificar más finamente.

3. **Terminal delivery no es siempre la pata de fondo.** Opción 2 asume que el último step entrega; en algunas cadenas podría no serlo. **Acción:** si future backstops tocan orden de steps, verificar contratos de `passOutput` rechain en los tests.

4. **Money-path invariants son aditivos, no secuenciales.** Débito == ejecución (AC-7) debe valer en CADA fase. Si AR detecta "borderline" (tipo MNR-1 aquí, que es inocuo pero documental), reportar al Architect antes de marcar CR APROBADO.

---

## Veredicto final

✅ **APROBADO PARA DONE**

- Todos 8 ACs verificados con archivo:línea (AC-1..AC-8 PASS)
- Zero bloqueantes, 1 MNR documentado (trade-off explícito)
- Zero regresiones (9 T-152-* verdes sin edición, 35 money-path tests idem)
- Débito == ejecución airtight (CD-1/AC-7 verificado)
- Determinismo puro en memoria (CD-5/AC-8 verificado)
- CI verde: `tsc --noEmit` 0 + biome limpio + `npm test` 2805 PASS / 0 FAIL
- Commit 17f0ae1 mergeado a main

**Responsable de presentar al cliente:** orquestador (remesa insignia restaurada, sin regressions).

---

*Done report generado por NexusAgil — nexus-docs · 2026-07-09 · WKH-163 · money-path insignia*
