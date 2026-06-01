# Auto-Blindaje — WKH-103 (Reputación ERC-8004)

Consolidación de lecciones del pipeline QUALITY: F0→F1→F2→F2.5→F3(W0-W4)→AR→CR→F4→DONE.

---

## Lecciones de ejecución (F3 Waves 1-4)

### [2026-05-31 17:16] Wave 1 — Test-guard de aislamiento de módulo demasiado estricto
- **Error**: El test T-AC10 hacía `expect(src).not.toContain('budget'|'delegation'|'a2a_agent_keys')` sobre el source completo. Falló porque los comentarios/JSDoc del service citan las constraints "CD-2/CD-3", "a2a_agent_keys" y "delegation" en prosa explicativa.
- **Causa raíz**: El guard confundía referencias en comentarios (legítimas, documentan la regla) con uso real (imports / `.from()`).
- **Fix**: El guard ahora assertea sobre (a) líneas `import` reales — sin `budget`/`delegation`/`redis`; (b) `.from('...')` calls — el único set permitido es `{'a2a_events'}`; (c) ausencia literal de `.from('a2a_agent_keys')`.
- **Aplicar en**: Cualquier test-guard de "no importa X / no toca tabla Y": chequear el statement (import / `.from()`), nunca el texto crudo del source, porque los comentarios mencionan las reglas a propósito. Mismo patrón aplicado al guard W3 del adapter (`writeContract`/`WalletClient`/`privateKeyToAccount`): se assertea sobre `codeOnly` (líneas no-comentario), no sobre el source completo.

### [2026-05-31 17:24] Wave 4 — Test de fetch-count roto por el fetch interno de Supabase (PostgREST)
- **Error**: `discovery.ssrf.test.ts > T-DISC-03` esperaba `mockFetch` llamado 1 vez pero recibió 2, tras agregar `attachReputations` a `discover()`.
- **Causa raíz**: ese test mockea `registry.js`/`identity.js`/`circuit-breaker.js` y `vi.stubGlobal('fetch')`, pero NO mockea `supabase.js` ni `reputation.js`. El nuevo `computeReputationBatch` corría contra el cliente real de Supabase, cuyo transporte PostgREST usa `fetch` internamente → un 2º `fetch()` contabilizado por el spy global.
- **Fix**: `vi.mock('./reputation.js', ...)` en `discovery.ssrf.test.ts` devolviendo `Map` vacío (CD-15: reflejar el export nuevo consumido en código bajo test).
- **Aplicar en**: TODO test que (a) hace `vi.stubGlobal('fetch')` y assertea el call-count, Y (b) ejercita un code-path que ahora llama un service que usa Supabase. Si el service no está mockeado, su fetch interno (PostgREST) infla el contador. Mockear el service o `supabase.js`. Auditados todos los callers de `discover()`/`getAgent()` (solo `discovery.test.ts` —mockea supabase— y este —ahora fixeado—).

### [2026-05-31 17:22] Wave 3 — Resolución del `[VERIFY-AT-IMPL]` del ReputationRegistry
- **Hallazgo**: el ABI oficial del ReputationRegistry ERC-8004 SÍ es accesible (no quedó como stub). Se leyó `abis/ReputationRegistry.json` del repo `erc-8004/erc-8004-contracts@main` (2026-05-31).
- **Decisión**: la única lectura agregada `view` es `getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) → (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)`. El adapter la invoca con `[], '', ''` (sin filtros) y surfacea el crudo como string `"count:summaryValue:decimals"` (anti-precision-loss, nunca Number() sobre bigint). Cita al repo + addresses canónicas (Base 8453/84532) documentadas en el JSDoc; addresses SOLO desde env (CD-4).
- **Aplicar en**: futuras integraciones de los registries ERC-8004 — la fuente de verdad del ABI es `abis/*.json` del repo oficial, no los `.sol` (no están en `src/`).

---

## Lecciones de arquitectura (SDD + Carry-forward)

### Carry-forward WKH-100 (§FIX-PACK v3) — Campo opcional en tipos compartidos
| HU# | Lección | Status | Aplicado aquí |
|----|---------|--------|---------------|
| WKH-100 | Un campo **requerido** nuevo en `Agent` rompe 24+ fixtures en 9 files. **Opcional** = 0 blast-radius. | ✅ Verificado | **CD-14**: `computedReputation?` optional. W0 gate: `tsc --noEmit` 0 errores. |

### Carry-forward WKH-100 (§Wave4) — Export nuevo + factory-mocks
| HU# | Lección | Status | Aplicado aquí |
|----|---------|--------|---------------|
| WKH-100 | Export nuevo consumido en código bajo test → rompe silenciosamente en runtime si el factory-mock no lo refleja. | ✅ Verificado | **CD-15**: grep `vi.mock('./reputation.js')` en todos callers (discovery, agent-card, ssrf). Reflejado en factories. |

### Carry-forward WKH-101 (§W4) — Arg opcional en funciones mockeadas
| HU# | Lección | Status | Aplicado aquí |
|----|---------|--------|---------------|
| WKH-101 | Nuevo arg opcional (`computedReputation?`) en función mockeada rompe `toHaveBeenCalledWith` exactos. | ✅ Verificado | **CD-16**: `buildAgentCard(..., computedReputation?: AgentReputation)`. Actualizados TODOS los `toHaveBeenCalledWith` en `agent-card.test.ts` (service+route). |

### Carry-forward WKH-101/WKH-102 — Propagar error.message raw
| HU# | Lección | Status | Aplicado aquí |
|----|---------|--------|---------------|
| WKH-101 §AR | PROHIBIDO propagar `error.message` crudo de Supabase/PG. Compute falla → log server-side + campo omitido. | ✅ Verificado | **CD-18**: `src/services/reputation.ts:107-110` try/catch (no throw); log error, return null; campo omitido gracefully. |

### Carry-forward WKH-102 — biome check antes de lint
| HU# | Lección | Status | Aplicado aquí |
|----|---------|--------|---------------|
| WKH-102 | `biome check --write` ANTES de `npm run lint`. organizeImports incluido. | ✅ Verificado | **CD-17**: Ejecutado en TODOS los archivos nuevos/tocados antes del gate de suite. 0 biome errores. |

### Carry-forward WKH-101 (§W1) — `[VERIFY-AT-IMPL]` real del repo oficial
| HU# | Lección | Status | Aplicado aquí |
|----|---------|--------|---------------|
| WKH-101 | NO inventar la firma de un contrato. Verificar en repo oficial ANTES de tipar. Citar commit/tag en JSDoc. | ✅ Verificado | **DT-6**: `erc8004-reputation.ts:48-50` cita `github.com/erc-8004/erc-8004-contracts@main` (abis/ReputationRegistry.json). ABI verificado, firma confirmada. |

### Carry-forward WKH-100 — Batch aggregate anti-N+1 + pre-sort
| HU# | Lección | Status | Aplicado aquí |
|----|---------|--------|---------------|
| WKH-100 | `eventService.stats()` batch: 1 query con reducción JS. Patrón directo. | ✅ Verificado | **DT-10**: `computeReputationBatch(slugs)` → `.in('agent_id', slugs)`, 1 SELECT. **OBS-2**: batch pre-sort (vs post-limit) mantiene "top-N correcto". |

---

## Lecciones nuevas (WKH-103 único)

### Batch score pre-sort para paginación correcta
- **Problema**: si computas el score post-limit, la página retornada NO es "top-N por reputación".
- **Solución**: compute batch sobre `allAgents` PRE-sort (1 query indexada), sort usa el score real, `slice(limit)` obtiene la página justa.
- **Aplicar en**: cualquier enriquecimiento que afecte el sort → hacerlo pre-sort, no post-limit. PERO SOLO si el aggregate es 1 query con `IN()`, no N+1.

### Sybil resistance en scoring systems (TD-WKH-103-SYBIL)
- **Vulnerabilidad**: un operador pagándose a sí mismo N tasks infla `tasks_settled` artificialmente.
- **v1 Mitigación**: scoring basado en **costo on-chain real** (cada settlement), no auto-reporte. Auditable.
- **v2 Mitigación (futuro, TD)**: diversificación (N callers, umbralización, volumen-ponderación).
- **Aplicar en**: scoring systems basados en acciones del usuario → documentar como TD si permite self-dealing. Aceptable si el costo es real.

---

## Consolidación final

| # | Categoría | Lección | HU-origen | Estado |
|----|-----------|---------|-----------|--------|
| 1 | Testing | Test-guard sobre statements, no texto raw | WKH-103 W1 | ✅ Aplicado |
| 2 | Integration | Mock el service consumidor (no solo transporte) | WKH-103 W4 | ✅ Aplicado |
| 3 | Types | Campo opcional en tipos compartidos = 0 fixtures rotos + tsc --noEmit | WKH-100 carry | ✅ Aplicado |
| 4 | Mocking | Export nuevo + reflejar en factory-mocks (vi.mock) | WKH-100 carry | ✅ Aplicado |
| 5 | Mocking | Arg opcional en fn mockeada → revisar `toHaveBeenCalledWith` | WKH-101 carry | ✅ Aplicado |
| 6 | Error Handling | PROHIBIDO error.message raw; log + omitir campo | WKH-101 carry | ✅ Aplicado |
| 7 | Formatting | biome check --write ANTES de lint | WKH-102 carry | ✅ Aplicado |
| 8 | Grounding | `[VERIFY-AT-IMPL]` contra repo oficial + JSDoc cita | WKH-101 carry | ✅ Aplicado |
| 9 | Performance | Batch aggregate 1 query con `IN()` (anti-N+1) | WKH-100 carry | ✅ Aplicado |
| 10 | Architecture | Batch score pre-sort (no post-limit) = page correcta | WKH-103 OBS-2 | ✅ Aplicado |
| 11 | Security | Sybil resistance: cost real vs self-dealing. TD para v2 | WKH-103 nuevo | ✅ TD-WKH-103-SYBIL (RESUELTO WKH-104) |

---

**Consolidación completada:** 2026-05-31 | **Commits abarcados:** 07c955b (F3) | **Tests:** 1324/1324 PASS | **tsc+biome:** 0 errores

---

## TD-WKH-103-SYBIL ✅ RESUELTO (WKH-104)

**Estado anterior:** Sybil resistance v1 (cost real on-chain). La deuda abierta era que un operador pagándose a sí mismo N tasks desde N callers distintos puede escalar `tasks_settled` linealmente, un "self-dealing Sybil" inherente al sistema permissionless sin identidad/stake.

**Estado nuevo (WKH-104):** 
- `compose.ts` emite `caller_ref_hash` (HMAC-SHA256 del `owner_ref`, nunca raw) en metadata de `compose_step`.
- `reputation.ts` capea por caller: cada `(agent_id, caller_ref_hash)` aporta `min(count, K)` tasks (K=`REPUTATION_MAX_TASKS_PER_CALLER`, default 5).
- El residual **inherente** (atacante con N caller-keys distintas aún puede escalar linealmente) queda documentado en el done-report.md como "no deuda nueva", aceptado en backlog → **WKH-SEC-03** (identity-based Sybil post-WKH-54 RLS).

**Verificación:** AC-9/AC-10/AC-11/AC-12 PASS. Helper `hashCallerRef()` implementado, tests 3 scenarios (owner_ref, null, fallback warn). Reputation capping verificado en tests (mínimo 5 tasks/caller, diferenciados).

