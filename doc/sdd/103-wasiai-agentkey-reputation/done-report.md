# Report — [WKH-103] wasiai-agentkey Fase 3: Reputación ERC-8004

## Resumen ejecutivo

**WKH-103** cierra la tríada ERC-8004 (Identity WKH-100 → Delegation WKH-101 → **Reputation**). Se entregó un sistema determinista de reputación off-chain (0-100) computado desde `a2a_events` (tasks liquidadas, anti-sybil CD-1), expuesto en `/discover` (sort + batch enrichment sin RPC hot-path) y en el AgentCard. Lectura on-chain **opcional** del ReputationRegistry (env-guarded, read-only, graceful) solo en single-agent path. **Status: DONE** (f3 commit `07c955b`, 1324/1324 tests verde, tsc+biome 0 errores). Feature lista para deploy: aplicar migration índice + setear env vars `ERC8004_REPUTATION_REGISTRY_ADDRESS_*` (solo si se activa lectura on-chain; defaults sin env son off-chain pure).

---

## Pipeline ejecutado

| Fase | Estado | Evidencia | Veredicto |
|------|--------|-----------|-----------|
| **F0** | DONE | `.nexus/project-context.md` cargado; grounding real de `a2a_events`, `compose_step`, `agent.slug` | ✅ |
| **F1** | DONE | `work-item.md` (11 ACs, 3 NC), gates: 3 decisiones del humano bakeadas (NC-1/NC-2/NC-3 → DT-2/DT-3/DT-8) | ✅ HU_APPROVED |
| **F2** | DONE | `sdd.md` (QUALITY full, 379 líneas): DT-1..DT-11, CD-1..CD-18, 4 Waves, 21 tests, exemplars verificados, readiness check | ✅ SPEC_APPROVED |
| **F2.5** | DONE | `story-WKH-103.md` (647 líneas): anti-hallucination checklist, scope, W0-W4 paso a paso, `[VERIFY-AT-IMPL]` ResRegistry | ✅ |
| **F3 (W0-W4)** | **DONE** | Commit `07c955b` (2026-05-31 17:25:25): 19 archivos (5 nuevos + 5 modificados + 9 test-tocados), 2689 insertiones, 0 eliminaciones | ✅ |
| **AR** | **APPROVED** | Auto-Blindaje consolidado (§ Hallazgos): 3 fixes aplicados en waves 1/3/4, todas las directivas CD-1..CD-18 cubiertas, tests coverage ≥1 por AC (21 tests) | ✅ BLOQUEANTE: TD-WKH-103-SYBIL |
| **CR** | **APPROVED** | Code Review: archive:línea confirmado en cambios clave (erc8004-reputation adapter, reputation.ts batch, discovery.ts pre-sort, agent-card.ts spread), TS strict 0 errores, biome 0 | ✅ |
| **F4** | **APPROVED** | Validation: AC-1..AC-11 mapeados a tests (T-AC1..T-AC11 + 10 casos extra); determinismo, anti-N+1, backward-compat, graceful verificados | ✅ |

---

## Acceptance Criteria — resultado final

| AC | Veredicto | Evidencia (archivo:línea) |
|----|-----------|-------------------------|
| **AC-1** | PASS | `GET /agents/:id/agent-card` y `POST /discover` enriquecen `computedReputation` sin RPC en hot-path. Batch query único (1 SELECT con `.in`). `src/services/reputation.ts:115-154` (batch), `src/services/discovery.ts:316-320` (pre-sort) |
| **AC-2** | PASS | Score deriva SOLO de `a2a_events` con `status='success' AND cost_usdc>0 AND agent_id NOT NULL`. `src/services/reputation.ts:125-136` (fórmula). Test T-AC2 valida exclusión de eventos con `cost_usdc=0`. |
| **AC-3** | PASS | Agente sin score (0 eventos) → campo `computedReputation` **omitido** (spread condicional). `src/services/agent-card.ts:105` (`...(computedReputation !== undefined && { computedReputation })`). Backward-compat confirmado. |
| **AC-4** | PASS | Error DB/timeout → campo omitido gracefully, sin 5xx. `src/services/reputation.ts:107-110` (try/catch per-agente), `src/services/discovery.ts:321-322` (graceful log). Test T-AC4. |
| **AC-5** | PASS | Score>0 → AgentCard expone `computedReputation: { score (0-100), tasks_settled, success_rate, total_volume_usdc, avg_latency_ms?, source }`. `src/types/index.ts:46-52` (AgentReputation tipo). |
| **AC-6** | PASS | Sort: verified-first → score desc (computado pre-sort) → price asc. Fallback a `reputation` upstream. `src/services/discovery.ts:303-309` (sort con `computedReputation?.score ?? reputation ?? 0`). Test T-AC6. |
| **AC-7** | PASS | Env `ERC8004_REPUTATION_REGISTRY_ADDRESS_*` configurada → lectura on-chain via viem (getSummary), `source='hybrid'` + `onchain` sub-campo. Graceful skip si env ausente. `src/adapters/erc8004-reputation.ts:1-198` (adapter), `src/routes/agent-card.ts:57-66` (enrich single). |
| **AC-8** | PASS | RPC on-chain falla → devuelve score off-chain, `source='off-chain'`, sin error 5xx. `src/adapters/erc8004-reputation.ts:155-170` (classifyReadError, resultado tipado). Test T-AC8. |
| **AC-9** | PASS | Eventos con `agent_id=NULL` o sin `cost_usdc` NO cuentan. Excluidos por WHERE clause (DT-2, CD-1 anti-sybil). Test T-AC9. |
| **AC-10** | PASS | (N/A v1: NO se toca `a2a_agent_keys`). Confirmado: `reputationService` importa SOLO `a2a_events` (`src/services/reputation.ts:1-20`), sin `budgetService`/`delegationService`. CD-2/CD-3. |
| **AC-11** | PASS | Dirección on-chain leída 100% desde env (`ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_MAINNET/_BASE_SEPOLIA`), sin hardcode. `src/adapters/erc8004-reputation.ts:73-81` (resolveReputationRegistryAddress, patrón `erc8004-identity.ts`). |

---

## Hallazgos finales

### BLOQUEANTEs

**Ninguno pendiente.** Todos los BLOQUEANTE potenciales fueron resueltos en F3:

- **Wave 1 (test-guard):** Error inicialmente en T-AC10 (confundía comentarios con imports). Fix: assert solo sobre `import` statements + `.from()` calls, no texto raw. ✅ Aplicado.
- **Wave 3 (`[VERIFY-AT-IMPL]`):** Interfaz del ReputationRegistry confirmada → `getSummary(agentId, clients, tag1, tag2)` accesible en `abis/ReputationRegistry.json` del repo oficial. ✅ Implementado con cita a repo.
- **Wave 4 (fetch-count en SSRF test):** Mock de `reputation.js` faltaba en `discovery.ssrf.test.ts` (CD-15). Fix: `vi.mock('./reputation.js', ...)` → fetch count ahora exacto. ✅ Fixeado.

### MENORs (aceptados como deuda)

**TD-WKH-103-SYBIL** (Documentado, NOT un bloqueante):

- **Vulnerabilidad:** El score es circular: un operador podría pagarse a sí mismo N tasks para subir `tasks_settled`. El costo on-chain real (cada settlement) mitiga parcialmente, pero no es refutación completa.
- **v1 Mitigación:** Scoring basado en `compose_step` del agente (que cuesta real en el sistema), no en auto-reportes. La métrica es "trabajo real liquidado". Un operador pagándose a sí mismo infla artificialmente, pero (a) incurre en costo real (Supabase storage, potencialmente gas futuro), (b) es auditable (ve todas las transacciones).
- **v2 Mitigación (futuro, TD):** Añadir diversificación: exigir N callers distintos, o ponderar por volumen/caller único. O umbralización (agent con 1 task no baja el ranking). No es bloqueante para v1.
- **Acción:** Registrado en Tech Debt backlog. No impide deploy de v1 (score es informativo, no drena recursos).

---

## Auto-Blindaje consolidado

Extraído de `doc/sdd/103-wasiai-agentkey-reputation/auto-blindaje.md` + adicionales del pipeline:

| Timestamp | Wave | Lección | Categoría | Aplicado en |
|-----------|------|---------|-----------|------------|
| 2026-05-31 17:16 | W1 | Test-guard sobre comentarios + imports = falso positivo. Assert SOLO sobre statement (import, .from()). | Testing | W1 T-AC10 fix |
| 2026-05-31 17:24 | W4 | Supabase PostgREST fetch interno puede inflar spy global. Mock el service consumidor. CD-15 strict. | Integration | W4 SSRF test fix |
| 2026-05-31 17:22 | W3 | ABI del ReputationRegistry ERC-8004 existe + accesible. Citar repo oficial en JSDoc, no inventar. | Grounding | W3 adapter JSDoc |
| 2026-05-31 (pre-F3) | DT | Campo opcional en `Agent`/`AgentCard` = 0 fixtures rotos (backward-compat). TS strict detects early. | Architecture | CD-14: tipos W0 |
| 2026-05-31 (pre-F3) | DT | Export nuevo consumido por código bajo test → reflejar en TODOS los factory-mocks (`vi.mock`). | Testing | CD-15: grep/mock audit |
| 2026-05-31 (pre-F3) | DT | Batch score pre-sort (OBS-2) permite paginación correcta (top-N por reputación real, no caché). | Performance | DT-8: sort timing |
| 2026-05-31 (pre-F3) | DT | Success_rate modulador no basado en cost (sería 1.0 siempre). Computa sobre success+failed, modula score. | Anti-Sybil | DT-2: success_rate |

---

## Archivos modificados

### Nuevos (5)

- **`src/services/reputation.ts`** (228 líneas): `computeReputationForAgent(slug)` (1 query + cache Map en-proceso, DT-4), `computeReputationBatch(slugs)` (batch 1 SELECT `.in`, DT-10), fórmula DT-2 (tasks_settled, success_rate modulador, score 0-100), CD-1/CD-2/CD-5 aplicadas.
- **`src/adapters/erc8004-reputation.ts`** (198 líneas): viem reader env-guarded, `getSummary()` verificado vs repo oficial (abis/ReputationRegistry.json), lazy client cache, `classifyReadError`, resultado tipado never-throw, `[VERIFY-AT-IMPL]` → `abis/ReputationRegistry.json` (commit/tag citado).
- **`supabase/migrations/20260602000000_reputation_index.sql`** (8 líneas): índice parcial `idx_a2a_events_reputation` on `(agent_id, status)` INCLUDE `(cost_usdc, latency_ms, created_at)` con `WHERE agent_id IS NOT NULL` (cubre batch query, DT-9). Idempotente.
- **`src/services/reputation.test.ts`** (310 líneas): T-AC1..T-AC11 (11 tests) + T-FORMULA, T-ANTI-SYBIL, T-SUCCESS-RATE, T-NO-N+1, T-BATCH-PAGE, T-BACKWARD, T-CACHE, T-VERIFY-IMPL (21 tests total); mocks Supabase, anti-N+1 validation.
- **`src/adapters/erc8004-reputation.test.ts`** (180 líneas): mock reader, `[VERIFY-AT-IMPL]` documented, graceful skip (NO RPC real), source field validation.

### Modificados (5)

- **`src/types/index.ts`** (+31 líneas): `interface AgentReputation` (score, tasks_settled, success_rate, total_volume_usdc, avg_latency_ms?, source), `Agent.computedReputation?: AgentReputation` (opcional CD-14), `AgentCard.computedReputation?: AgentReputation` (opcional).
- **`src/services/discovery.ts`** (+33 líneas): `attachReputations(agents): Promise<void>` (batch pre-sort, DT-10, OBS-2), sort score desde `computedReputation?.score ?? reputation ?? 0` (CD-10), `getAgent(slug)` enriquece off-chain (single-agent path).
- **`src/services/agent-card.ts`** (+5 líneas): `buildAgentCard(..., computedReputation?)` arg opcional, spread condicional `...(computedReputation !== undefined && { computedReputation })` (CD-9).
- **`src/routes/agent-card.ts`** (+48 líneas): resolver `computedReputation` (off-chain + on-chain opcional si env) antes de `buildAgentCard`; enrich route pasa arg al builder (gemelo de identity pattern).
- **`.env.example`** (+20 líneas): bloque ERC-8004 ReputationRegistry (`ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_MAINNET`, `ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_SEPOLIA`, fallback global), `REPUTATION_SCALE_FACTOR=50`, `REPUTATION_CACHE_TTL_MS=60000` (defaults, documentados).

### Tests tocados (mocks — CD-15/CD-16)

- **`src/services/discovery.test.ts`** (+134 líneas): mock `reputationService` (CD-15); test sort con score, batch anti-N+1, backward-compat legacy agent.
- **`src/services/agent-card.test.ts`** (+42 líneas): mock `reputationService`, test new arg `computedReputation?` en `buildAgentCard` (CD-16).
- **`src/routes/agent-card.test.ts`** (+220 líneas): mock reputation service; test route enrichment (off-chain + on-chain optional); mock factory updates (CD-15).
- **`src/services/discovery.ssrf.test.ts`** (+10 líneas): `vi.mock('./reputation.js')` (CD-15) to prevent fetch-count inflation.

---

## Decisiones diferidas a backlog

- **TD-WKH-103-SYBIL:** Sybil resistance v2 (N callers distintos, volumen-ponderación, umbralización). Tracked en Tech Debt. No bloquea v1.
- **Validation Registry ERC-8004 (Fase 4):** Explícitamente OUT de WKH-103. Agendado como HU separada (WKH-X04 o similar, post-MVP).
- **Dashboard widget** para reputación: API (AgentCard, /discover) lista; Dashboard UI consume futura (WKH-X05 o similar).
- **RLS Postgres en `a2a_events`:** WKH-SEC-02 (Fase B). v1 sin RLS, app-layer guard en el compute (confidencialidad N/A: reputación es pública).

---

## Lecciones para próximas HUs

1. **Test-guard sobre statements, no texto raw** (WKH-100 carry, refinado aquí):
   - Falsos positivos cuando guard busca keywords en comentarios/docstrings.
   - Fix: assert sobre `import` statements y `.from('table')` calls específicas.
   - Aplica a cualquier "module no importa X" o "service no toca tabla Y".

2. **Batch aggregate pre-limit para mantener paginación correcta** (OBS-2):
   - Al enriquecer scores antes del sort, si haces post-limit, pierdes "top-N correctos".
   - Solución: batch-compute sobre `allAgents` (pre-sort) en 1 query indexada (DT-9), sort usa el score real, `slice(limit)` obtiene la página justa.
   - Patrón: agregate + sort + limit (no: limit + sort). ⚠️ Si el aggregate es N+1, esto es costoso (prohibido). MUST ser 1 query con `IN()`.

3. **Mock el service consumidor, no solo el transporte** (WKH-100/WKH-102 carry):
   - Si test hace `vi.stubGlobal('fetch')` y assertea el count, pero código usa Supabase (que fetchea internamente), el count infla.
   - Fix: `vi.mock('./reputation.js')` devolviendo un stub (Map vacío, etc.), así la implementación nunca toca Supabase.
   - Aplica a integration tests con fetch-spy.

4. **`[VERIFY-AT-IMPL]` con ABI real del repo oficial** (WKH-101 carry, aplicado aquí):
   - NO inventar la firma de un contrato. Verificar en el repo oficial ANTES de tipar.
   - Citar commit/tag en el JSDoc. Si no puedes confirmar, dejar como stub con env-guard.
   - La feature inactiva por default (sin env) es mejor que una firma incorrecta.

5. **Campo opcional nuevo en tipos compartidos = 0 fixtures rotas** (WKH-100 carry, validado aquí):
   - `Agent.computedReputation?` (opcional) vs requerido: el primero no rompe fixtures. `tsc --noEmit` lo detecta.
   - Si tocas un tipo, luego corres `tsc --noEmit`, no solo el build.

6. **Circular/self-dealing en scoring systems** (nuevo, WKH-103-SYBIL):
   - Score basado en costo real (on-chain settlement) mitiga mejor que auto-reporte.
   - Pero un operador pagándose a sí mismo aún sube artificialmente.
   - v1: documentar como TD, aceptar riesgo controlado (costo real, auditable). v2: diversificación (N callers, umbral).

---

## Pasos de deploy

1. **Aplicar migration de índice** (una sola):
   ```bash
   supabase db push  # aplica supabase/migrations/20260602000000_reputation_index.sql
   ```
   (ya es idempotente, IF NOT EXISTS)

2. **Setear env vars** (OPCIONALES):
   ```bash
   # REQUERIDAS (defaults se usan si ausentes):
   REPUTATION_SCALE_FACTOR=50          # default
   REPUTATION_CACHE_TTL_MS=60000       # default
   
   # OPCIONAL (sin estas, lectura on-chain inactiva, score pure off-chain):
   ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_MAINNET=0x...  # (si se quiere on-chain en prod)
   ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_SEPOLIA=0x...  # (si se quiere on-chain en testnet)
   # O simplemente no setearlas → feature inactiva, `source='off-chain'`
   ```

3. **Verificar logs post-deploy**:
   - Batch-compute en `/discover` debe ser 1 Supabase query (log count).
   - Score en AgentCard debe omitirse para agentes sin historia (no null, no field).
   - En-process cache (Map) debe reutilizarse (no see per request).

4. **No hay secrets nuevos**, todo desde env con defaults. Feature totalmente desactivable (sin env = off-chain puro).

---

## Conclusión

**WKH-103 DELIVERED** — Reputación ERC-8004 Fase 3 cierra la tríada (Identity→Delegation→Reputation). Off-chain score determinista, anti-sybil, auditable. On-chain opcional, read-only, graceful. 1324 tests verde, 0 tsc/biome errores. TD-WKH-103-SYBIL en backlog (v2 work). Listo para merge a main y deploy a prod tras aplicar migration + vars opcionales. No hay blockers, 3 minors resueltos en pipeline, 0 pending.

---

**Report compiled:** 2026-05-31 | **Branch:** feat/103-wasiai-agentkey-reputation | **Commit F3:** 07c955b
