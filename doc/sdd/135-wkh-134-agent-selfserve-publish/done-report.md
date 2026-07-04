# Report — HU [WKH-134] SDK + publish self-serve de 1 agente

**Status**: DONE  
**Date**: 2026-07-03  
**Branch**: `feat/135-wkh-134-agent-selfserve-publish` @ `41e57f1` (PR #158, MERGEABLE)  
**Mode**: QUALITY

---

## Resumen ejecutivo

Se entregó un flujo self-serve para que developers individuales publiquen **1 agente directamente** (URL + Agent Card mínima) sin requerir operar un marketplace entero. El endpoint `POST /agents` + tabla nueva `a2a_agents` + merge local en discovery permite publicar gratis con `x-a2a-key`, descubrirse inmediatamente en `/discover`, e invocarse vía `/compose`. **AR/CR ciclo completo con fix-pack**: un bloqueante económico crítico (`priceUsdc` negativo → inflado de budget) fue cazado, aislado en write-boundary (422) + read-boundary (clamp), testeado y cerrado. Validación F4: 33 tests PASS, 0 FAIL; migración Postgres verificada en sandbox; CI del PR verde (5/5 checks). **Ártefactos inmutables**: work-item.md, sdd.md, story-HU-134.md, auto-blindaje.md, validation.md — PR #158 listo para merge por humano.

---

## Pipeline ejecutado

| Fase | Status | Evidencia |
|------|--------|-----------|
| **F0** | ✅ | project-context cargado; grounding codebase real verificado (exemplars ~L1925 `database.types.ts`, `registries.ts`, `discovery.ts`, `url-validator.ts`, seguridad/ownership) |
| **F1** | ✅ | `work-item.md`: HU_APPROVED (codebase grounding F1 + WKH-62/WKH-63 reusos validados; monetización=GRATIS con a2a-key decidida) |
| **F2** | ✅ | `sdd.md`: SPEC_APPROVED — 9 DTs resueltas (endpoints, modelo `a2a_agents`, payload, auth, RegistryConfig sintético, auto-derivación slug, merge discovery, SSRF/ownership reusos, slugs server-side). 10 CDs firmadas (SSRF, auth, ownership, CI, logging, pricing, degradación discovery, no non-null, JSONB narrowing). Exemplars verificados con Read. |
| **F2.5** | ✅ | `story-HU-134.md`: Story File — waves ejecutables (W0 serial migraciones/tipos, W1 service, W2 routes+discovery, W3 docs+tests), contrato de endpoints (POST/PATCH/DELETE/GET `/agents`), anti-hallucination gates, ejemplares de código. |
| **F3** | ✅ | **Wave W0**: migración `20260703000000_wkh134_a2a_agents.sql` idempotente + `_down.sql` reversible; tipos en `database.types.ts` + `types/index.ts` (PublishAgentInput, constants SELF_PUBLISHED); extender OwnershipOp. **Wave W1**: `src/services/agent.ts` (publish/listAsAgents/getBySlugAsAgent/update/delete, SSRF defense-in-depth, ownership guards, slug derivation, colisión check). **Wave W2**: `src/routes/agents.ts` (POST/PATCH/DELETE/GET, SSRF write-time loop, A2A_KEY_REQUIRED guard, error mapping estático CD-10); `src/services/discovery.ts` merge local (try/catch CD-9); `src/routes/agent-card.ts` fallback RegistryConfig sintético (DT-5); `src/index.ts` registra plugin. **Wave W3**: `doc/QUICKSTART-PUBLISH.md` (2-call <5 min), 14 tests en 4 archivos. |
| **AR** | ✅ BLQ-ALTO-1 + MNR | **Bloqueante económico crítico**: `POST /agents` y `PATCH /agents/:slug` aceptaban `priceUsdc<0`, permitiendo inflado de budget prepago. **Fix-pack `41e57f1`**: (1) Write-boundary: `isValidPriceUsdc()` en route + `assertValidPriceUsdc()` en service rechazan con 422 — solo acepta `number` finito `>=0`; (2) Read-boundary: `parsePriceSafe()` extraído a `src/lib/price.ts`, reusado en `mapRowToAgent`/`mapRowToRecord` para clampear negativos/no-finitos ya en DB a 0. **Menores**: MNR-1 (capabilities no sanear → añadir `stringCapabilities` filtro) + MNR-2 (PATCH `name` sin guards whitespace → reusar `assertValidName`). Todos resueltos en `41e57f1`. |
| **CR** | ✅ | Code Review: citación archivo:línea de validaciones SSRF (routes:94-120, service:243-250), ownership (service:376-393, 473-491), guards ownership `.eq('owner_ref', ownerRef)` (TOCTOU :447-448, :497), error mapping estático, no non-null assertions, TS strict. Verde. |
| **F4** | ✅ APROBADO | **Validación F4**: `npx tsc --noEmit` ✅, `npx vitest run` (6 archivos WKH-134) → **PASS 33 FAIL 0**; CI PR #158 → **5/5 checks verdes** (build-test, coverage, light-smoke, Vercel, Preview); `gh pr view 158 --json mergeable` → `CLEAN`. Migración Postgres 15 sandbox: tabla creada + índices + RLS deny-by-default confirmed (role nobypass `SELECT * FROM a2a_agents` → 0 rows), idempotencia ✅, reversible ✅. |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| **AC-1** (publish self-serve sin discoveryEndpoint propio) | ✅ PASS | Impl: `src/routes/agents.ts:79-208` (POST `/`, `requirePaymentOrA2AKey`, sin exigir marketplace) + `src/services/agent.ts:237-307` (publish). Test: `agents.publish.test.ts:137-153` (201, publish called with ownerRef, slug derivado). |
| **AC-2** (aparece en /discover, /discover/:slug, agent-card, mismo shape) | ✅ PASS | Impl: `src/services/discovery.ts` merge local (L233-250, L282-285; `getAgent()` L551-561) + `src/routes/agent-card.ts:49-67` (fallback sintético DT-5, `schemes: []`). Test: `discovery.selfpublished.test.ts:71-102` (mismo shape Agent + sobrevive sort/limit/filter), `:105-115` (getAgent local-first), `agent-card.selfpublished.test.ts:92` (GET /agents/:slug/agent-card self-published → 200, card válido). |
| **AC-3** (SSRF blocking en agentUrl → 422, no persiste) | ✅ PASS | Impl: write-time SSRF-loop (`routes/agents.ts:94-120`, reusa `validateRegistryUrl`) + service defense-in-depth (`:243-250`). Test: `agents.publish.test.ts:154-187` (metadata IP/private/file: → 422, publish NO llamado), `:190-210` (service-level, insert NO llamado). |
| **AC-4** (ownership: colisión slug + cross-owner mutation → disclosure-safe 404) | ✅ PASS | Impl: colisión pre-check (`src/services/agent.ts:274-277,300-301`, no INSERT en dup); ownership PATCH/DELETE (`:376-393,473-491`, `OwnershipMismatchError` + `.eq('owner_ref', ownerRef)` TOCTOU `:447-448,497`). Test: `agents.publish.test.ts:213-229` (409, no leak slug), `agents.ownership.test.ts:113-132` (PATCH cross-owner → 404 + logOwnershipMismatch, UPDATE no corre), `:135-152` (DELETE cross-owner → 404, DELETE no corre). |
| **AC-5** (quickstart ≤2 HTTP calls, <5 min sin escribir marketplace) | ✅ PASS | Doc: `doc/QUICKSTART-PUBLISH.md:13-71` (Call #1 `POST /auth/agent-signup` existente, Call #2 `POST /agents` nueva, verify en `/discover?q=weather` = 2 exact HTTP). Test: `agents.publish.test.ts:232` (signup+publish secuencia deja agente descubrible). |
| **AC-6** (campos mínimos faltantes → 400 con lista) | ✅ PASS | Impl: `src/routes/agents.ts:131-143` (missing: string[] con name/agentUrl/capabilities). Test: `agents.publish.test.ts:252` (POST /agents {} → 400 listando 3 campos obligatorios). |

---

## Hallazgos finales

### BLOQUEANTEs
- **BLQ-ALTO-1 (money-path `priceUsdc` negativo)**: RESUELTO en fix-pack `41e57f1`
  - Vector: `POST /agents priceUsdc:-1000` → INSERT sin validar → `mapRowToAgent` no clampea → `/discover` devuelve precio negativo → `/compose` debita negativo (invierte, infla budget).
  - Fix: Write-boundary (route `isValidPriceUsdc` + service `assertValidPriceUsdc`, 422 rechazo); Read-boundary (`parsePriceSafe` clamp a 0 para legacy). Ciclo cerrado.
  - Evidencia: AR report (validation.md:19-27), 2 tests nuevos en `agent.pricing.test.ts`, PR checks verde.

### MENOREs
- **MNR-1 (capabilities sin sanear)**: RESUELTO en `41e57f1`
  - Problema: POST aceptaba mixed types en capabilities array.
  - Fix: `stringCapabilities` filtra a strings en POST, valida `length>=1` en POST/PATCH.
  - Evidencia: tests `agents.publish.test.ts:349-378`.

- **MNR-2 (PATCH `name` sin whitespace guard)**: RESUELTO en `41e57f1`
  - Problema: PATCH de `name` no aplicaba guards de leading/trailing space.
  - Fix: `assertValidName` reusa guards de publish en update.
  - Evidencia: tests `agents.pricing.test.ts:162-191`.

- **Follow-up (fuera de scope WKH-134)**: Guard profundo en RPC `increment_a2a_key_spend` — defensa final independiente de cómo llegó el precio (money-invariant DB-level). Documentado como TD separado en `auto-blindaje.md:58-64`, **no bloqueante para DONE** (el write/read-boundary de `a2a_agents` cierra el vector de esta HU). Aplica a futuras HUs que toquen spending RPCs.

---

## Auto-Blindaje consolidado

### [2026-07-03 16:57] W2 — `exactOptionalPropertyTypes` rechaza `undefined` explícito
- **Error**: tsc TS2379 al construir objetos con props opcionales.
- **Fix**: asignación condicional (`if (typeof body.x === 'string') input.x = body.x`), nunca `x: cond ? v : undefined`.
- **Aplicar en**: cualquier construction de objeto tipado con props opcionales desde HTTP body.

### [2026-07-03 16:59] W2 — merge en `discover()` rompe test stub de fetch
- **Error**: `discovery.ssrf.test.ts` T-DISC-03 → 0 agentes tras agregar `listAsAgents()`. Service nuevo toca supabase vía `fetch` global (PostgREST), consume mockResolvedValue.
- **Fix**: `vi.mock('./agent.js', ...)` devolviendo `listAsAgents → []` (exactamente como WKH-100/WKH-103 hicieron).
- **Aplicar en**: toda nueva dependencia de service agregada a `discover()` must mockear en TODOS los tests que stubean fetch.

### [2026-07-03 17:15] FIX-PACK AR — BLQ-ALTO-1 money-path `priceUsdc` sin validar
- **Error**: write-boundary no validaba, read-boundary solo `typeof===number ? v : 0` sin clampear negativos.
- **Fix**: (1) Write: `isValidPriceUsdc` (route) + `assertValidPriceUsdc` (service), solo >=0 finito; (2) Read: `parsePriceSafe` (lib/price.ts) reusado en mappers, clampea <0 a 0.
- **Patrón**: TODO campo money-path DEBE validar write-boundary (rechazo) + clampear read-boundary (legacy). Reusar mismo safeguard, no clones.

### [2026-07-03 17:16] FIX-PACK AR — MNR-1/MNR-2 validación de `capabilities` y `name`
- **Error**: PATCH no validaba capabilities, no filtraba string[] en POST, PATCH name sin guards whitespace.
- **Fix**: `stringCapabilities` filtra+valida en route (POST/PATCH), `sanitizeCapabilities` en service, `assertValidName` reusan guards.
- **Patrón**: PATCH parcial = CREATE con mismos guards; no asumir update exime de validar.

### **Lecciones para próximas HUs**
1. **Dinámico discovery con tablas nuevas**: toda nueva fuente local (tabla, cache, etc.) que se mergea con discovery DEBE mockearse en tests que stubean fetch; senão, la llamada de supabase consume el mock.
2. **exactOptionalPropertyTypes strict**: nunca `undefined` explícito en opcional; construir objeto con asignación condicional.
3. **Money-path defensa doble**: write-boundary (rechazo) + read-boundary (clamp) SEPARADOS pero coordinados. Reusar `parsePriceSafe` u equivalente, no inventar nuevos.
4. **PATCH = CREATE con mismos guards**: no hay "es sólo un update, saltéa validación". PATCH reuusa TODA la validación de create para cada campo tocado.

---

## Archivos modificados

### Wave W0 (Tipos + migración)
- `supabase/migrations/20260703000000_wkh134_a2a_agents.sql` (NUEVO) — CREATE TABLE + índices + RLS deny-by-default
- `supabase/migrations/20260703000000_wkh134_a2a_agents_down.sql` (NUEVO) — DROP reversible
- `src/types/database.types.ts` — bloque `a2a_agents` (Row/Insert/Update)
- `src/types/index.ts` — `PublishAgentInput`, `UpdateAgentInput`, `SELF_PUBLISHED_REGISTRY_ID`, `SELF_PUBLISHED_REGISTRY_NAME`
- `src/services/security/errors.ts` — extender `OwnershipOp` con `'agentPublishUpdate'|'agentPublishDelete'`

### Wave W1 (Service)
- `src/services/agent.ts` (NUEVO) — `publishedAgentService` (publish/listAsAgents/getBySlugAsAgent/update/delete, SSRF, ownership)
- `src/lib/price.ts` (NUEVO) — `parsePriceSafe()` (extraído en fix-pack para read-boundary)

### Wave W2 (Routes + integración)
- `src/routes/agents.ts` (NUEVO) — POST/PATCH/DELETE/GET `/agents` (SSRF write-time, A2A_KEY guard, error estático)
- `src/services/discovery.ts` — merge local en `discover()` (L233-250, L282-285), local-first `getAgent()` (L551-561), try/catch degradable
- `src/routes/agent-card.ts` — fallback `RegistryConfig` sintético para self-published (DT-5)
- `src/index.ts` — registro plugin `agentsRoutes` en `/agents`

### Wave W3 (Tests + docs)
- `doc/QUICKSTART-PUBLISH.md` (NUEVO) — 2-call quickstart <5 min
- `src/routes/agents.publish.test.ts` (NUEVO) — T-PUB-01..14 + pricing tests
- `src/routes/agents.ownership.test.ts` (NUEVO) — T-PUB-08,09 (PATCH/DELETE cross-owner)
- `src/services/discovery.selfpublished.test.ts` (NUEVO) — T-PUB-02,03 (merge, shape, getAgent local)
- `src/routes/agent-card.selfpublished.test.ts` (NUEVO) — T-PUB-04 (GET agent-card self-published)
- `src/services/agent.pricing.test.ts` (NUEVO) — defensive pricing tests (fix-pack)

**Total**: 19 archivos (14 nuevos, 5 modificados). Scope exacto coincide con Story File §Scope IN; 2 archivos adicionales (`lib/price.ts`, `agent.pricing.test.ts`) son extracciones del fix-pack documentadas en auto-blindaje.

---

## Decisiones diferidas a backlog

### Ninguna spinoff de esta HU. TD pendiente (separado):
- **TD: Guard profundo RPC de débito** — `increment_a2a_key_spend` / `compose.isInvalid` — rechazar amount/precio negativo o no-finito en el punto de débito final (money-invariant DB-level, defensa en profundidad independiente del path `a2a_agents`). Trackearlo como HU/TD propia, fuera de esta rama. Documentado en `auto-blindaje.md:58-64`.

---

## Status final

- **PR #158**: MERGEABLE (5/5 CI checks verdes, mergeable per gh API)
- **Action humano**: merge a main (solo humano decide push)
- **Deployo**: sin cambios en esta HU (endpoint gratis, no facturación, no secrets nuevos, no env vars críticas)
- **Runway**: downstream en wasiai-v2 pueden consumir `POST /agents` + `/discover` self-published inmediatamente post-merge sin cambio en su code.

---

## Resumen para orquestador

✅ **DONE: WKH-134 Publish self-serve de 1 agente**

**Qué se entregó:**
- Endpoint `POST /agents` (gratis con `x-a2a-key`) + tabla `a2a_agents` + merge local en discovery.
- Developers publican agente en 2 HTTP calls (<5 min), sin operar marketplace.
- Ciclo AR/CR completo con fix-pack: BLQ-ALTO-1 (money-path `priceUsdc` negativo) cazado, aislado, validado.

**Validación F4:**
- Tests: 33 PASS, 0 FAIL (`vitest` 6 archivos WKH-134)
- Migración: Postgres 15 sandbox — tabla + RLS + idempotencia ✅
- CI: 5/5 checks verdes

**PR #158 state:**
- Branch: `feat/135-wkh-134-agent-selfserve-publish` @ `41e57f1`
- Mergeable: YES (CLEAN, sin conflictos)
- Action: awaiting human merge to main

**Auto-Blindaje consolidado:** 4 lecciones (exactOptionalPropertyTypes, mock nuevas dependencias discovery, money-path double-boundary, PATCH=CREATE guards) aplicables a futuras HUs.

---

**Report path**: `doc/sdd/135-wkh-134-agent-selfserve-publish/done-report.md`  
**Branch for merge**: `feat/135-wkh-134-agent-selfserve-publish`  
**Status in _INDEX**: DONE (fila 135)
