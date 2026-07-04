# Validation Report — WKH-134 Publish self-serve de 1 agente (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-03
**Branch**: `feat/135-wkh-134-agent-selfserve-publish` @ `41e57f1` (PR #158)

## Runtime checks (evidencia real)

- **Migración (sandbox Postgres 15, `docker run --rm postgres:15-alpine`, NO Supabase/prod)**:
  aplicada `20260703000000_wkh134_a2a_agents.sql`:
  - `\d public.a2a_agents` → `slug` PK (`a2a_agents_pkey`), `owner_ref`/`name`/`capabilities`/`agent_url`/`price_usdc`/`enabled`/`created_at` `is_nullable = NO` (query directa a `information_schema.columns`) ✅.
  - `pg_class.relrowsecurity = t`, `relforcerowsecurity = f`, `pg_policies` → 0 filas ⇒ RLS `ENABLE` sin policies = deny-by-default confirmado. Prueba en vivo: `CREATE ROLE test_authenticated ... NOBYPASSRLS` + `GRANT SELECT` + 1 fila insertada por `postgres` → `SELECT * FROM a2a_agents` desde `test_authenticated` devuelve **0 rows** (RLS bloquea de verdad, no solo declarado) ✅.
  - Idempotencia: re-aplicar `up.sql` → `NOTICE: relation already exists, skipping` en las 3 relaciones, exit limpio ✅.
  - `_down.sql` → `DROP TABLE`, tabla desaparece (`\d` → "Did not find any relation"); re-aplicar `_down.sql` → `NOTICE: table does not exist, skipping` (idempotente, reversible) ✅.
- **`npx tsc --noEmit`** → `TypeScript compilation completed`, exit 0 ✅.
- **`npx vitest run` (6 archivos WKH-134)** → `agents.publish.test.ts`, `agents.ownership.test.ts`, `discovery.selfpublished.test.ts`, `agent-card.selfpublished.test.ts`, `agent.pricing.test.ts`, `discovery.ssrf.test.ts` → **PASS (33) FAIL (0)**, exit 0.
- **CI del PR #158** (`gh pr checks 158`) → 5/5 checks verdes (`build-test`, `coverage`, `light-smoke`, `Vercel`, `Vercel Preview Comments`). `gh pr view 158 --json mergeable` → `MERGEABLE` / `mergeStateStatus: CLEAN`.

## BLQ-ALTO-1 (money-path, fix-pack `41e57f1`) — CERRADO, evidencia directa

| Vector | Status | Evidencia |
|---|---|---|
| `POST /agents` con `priceUsdc<0`/NaN/Infinity → 422, `publish` NO llamado | ✅ | Impl: `src/routes/agents.ts:64-66` (`isValidPriceUsdc`) + `:148-158`. Test: `src/routes/agents.publish.test.ts:335-347` (`POST priceUsdc negative → 422`). |
| `PATCH /agents/:slug` con `priceUsdc<0` → 422, `update` NO llamado | ✅ | Impl: `src/routes/agents.ts:265-275`. Test: `src/routes/agents.publish.test.ts:380-391` (`PATCH priceUsdc negative → 422`). |
| Service defense-in-depth: `publish`/`update` rechazan precio inválido antes de INSERT/UPDATE | ✅ | Impl: `src/services/agent.ts:178-183` (`assertValidPriceUsdc`), llamado en `publish` (`:264`) y `update` (`:409-410`). Test: `src/services/agent.pricing.test.ts:94-120` (publish, negative/NaN/Infinity → throw, `state.insertedRow` null) y `:153-159` (update, `state.updateCalled=false`). |
| `mapRowToAgent`/`mapRowToRecord` clampean `price_usdc<0` ya persistido en DB → 0 (read-boundary) | ✅ | Impl: `src/services/agent.ts:117` y `:140` (`parsePriceSafe(row.price_usdc)`, definido en `src/lib/price.ts:114-125`). Test: `src/services/agent.pricing.test.ts:194-205` (`listAsAgents clamps a negative price_usdc already in DB to 0`) — un agente con `price_usdc:-1000` en DB llega a discovery con `priceUsdc:0`. |
| Un precio negativo NO puede llegar a `/compose` con débito negativo | ✅ | Combinación write-boundary (rechazo 422, nunca persiste) + read-boundary (clamp a 0 para legacy/manual-insert) cierra ambos extremos del path. `discover()`/`getAgent()` (consumidos por `/compose`) solo ven `Agent.priceUsdc` post-`parsePriceSafe`, nunca el valor crudo de DB. |

**Nota (no bloqueante)**: el guard profundo en el RPC `increment_a2a_key_spend`/`compose.isInvalid` (defensa final independiente de cómo llegó el precio) queda **fuera de esta HU** — documentado explícitamente como follow-up separado en `doc/sdd/135-wkh-134-agent-selfserve-publish/auto-blindaje.md:58-64`. Aceptado como TD, no bloqueante para DONE (el write/read-boundary de `a2a_agents` ya cierra el vector concreto de esta HU).

## ACs

| AC | Status | Evidencia (impl + test) |
|----|--------|--------------------------|
| AC-1 (publish self-serve sin discoveryEndpoint propio) | ✅ PASS | Impl: `src/routes/agents.ts:79-208` (`POST /`, preHandler `requirePaymentOrA2AKey`, sin exigir `discoveryEndpoint`/`invokeEndpoint`) + `src/services/agent.ts:237-307` (`publish`). Test: `src/routes/agents.publish.test.ts:137-153` (`publish happy-path → 201, publish called with ownerRef, returns derived slug`). |
| AC-2 (aparece en /discover, /discover/:slug, agent-card, mismo shape) | ✅ PASS | Impl: `src/services/discovery.ts` merge local (`discover()` L233-250, L282-285; `getAgent()` L551-561) + `src/routes/agent-card.ts:49-67` (fallback `RegistryConfig` sintético DT-5). Test: `src/services/discovery.selfpublished.test.ts:71-102` (`T-PUB-02`, mismo shape `Agent` + sobrevive sort/limit/filter), `:105-115` (`T-PUB-03`, `getAgent` local-first sin fetch) y `src/routes/agent-card.selfpublished.test.ts:92` (`GET /agents/:slug/agent-card` self-published → 200 con card válido). |
| AC-3 (SSRF blocking en agentUrl → 422, no persiste) | ✅ PASS | Impl: `src/routes/agents.ts:94-120` (SSRF-loop write-time, reusa `validateRegistryUrl`) + `src/services/agent.ts:243-250` (defense-in-depth). Test: `src/routes/agents.publish.test.ts:154-187` (`T-PUB-05`, metadata IP/private/`file:` → 422, `mockPublish` no llamado) y `:190-210` (`T-PUB-06`, service-level, `mockInsert` no llamado). |
| AC-4 (ownership/anti-IDOR: colisión de slug + cross-owner mutation) | ✅ PASS | Impl: colisión `src/services/agent.ts:274-277,300-301` (pre-check + `23505`); ownership `update`/`delete` `:376-393,473-491` (`OwnershipMismatchError` + `.eq('owner_ref', ownerRef)` TOCTOU `:447-448,497`). Test: `src/routes/agents.publish.test.ts:213-229` (`T-PUB-07`, 409, sin leak de slug) + `src/routes/agents.ownership.test.ts:113-132` (`T-PUB-08`, PATCH cross-owner → 404 disclosure-safe + `logOwnershipMismatch`, UPDATE no corre) y `:135-152` (`T-PUB-09`, DELETE cross-owner → 404, DELETE no corre). |
| AC-5 (quickstart ≤2 llamadas HTTP, <5 min) | ✅ PASS | Doc: `doc/QUICKSTART-PUBLISH.md:13-71` (Call #1 `POST /auth/agent-signup`, Call #2 `POST /agents`, verificación `GET /discover?q=weather` — exactamente 2 llamadas HTTP). Test: `src/routes/agents.publish.test.ts:232` (`T-PUB-10`, secuencia signup+publish deja el agente descubrible). |
| AC-6 (campos mínimos faltantes → 400 con lista) | ✅ PASS | Impl: `src/routes/agents.ts:131-143` (`missing: string[]` con `name`/`agentUrl`/`capabilities`). Test: `src/routes/agents.publish.test.ts:252` (`T-PUB-11`, `POST /agents {}` → 400 listando los 3 campos). |

## Drift

- `git diff --name-only main...HEAD`: 19 archivos. 17/19 coinciden exactamente con la tabla "Superficie tocada" del Story File (§ Scope IN). Los 2 restantes (`src/lib/price.ts` NUEVO, `src/services/agent.pricing.test.ts` NUEVO) no estaban en el Story File original pero son la extracción/test del fix-pack BLQ-ALTO-1 documentado en `auto-blindaje.md:36-56` — adición legítima post-AR, no scope creep no documentado.
- Waves respetadas en los commits: `e0c5857` (feat, W0→W1→W2→W3 completo) → `41e57f1` (fix, AR fix-pack: BLQ-ALTO-1 + MNR-1/MNR-2, sin lógica nueva fuera de precio/capabilities/name guards).
- MNR-1 (capabilities no filtradas a string[]) y MNR-2 (whitespace guard de `name` en PATCH) del AR: **ambos resueltos** en `41e57f1`, ver `src/routes/agents.ts:69-72,277-291` y `src/services/agent.ts:191-198,204-212,413-416`; tests `src/routes/agents.publish.test.ts:349-378`, `src/services/agent.pricing.test.ts:131-150,162-191`.
- Follow-up guard profundo RPC/compose: documentado explícitamente como TD separado en `auto-blindaje.md:58-64` (no bloqueante, ver sección BLQ arriba).
- `wasiai-sdk` no tocado (CD-4) ✅. `src/routes/registries.ts` / `src/services/registry.ts` / `src/lib/url-validator.ts` sin cambios (no aparecen en el diff) — `GET /registries` y `getEnabled()` siguen sin devolver self-published (R6) ✅.

## Gates (confirmado desde CI/commits, sin re-ejecutar el combo completo)

- `tsc`/`vitest` (subset WKH-134): re-ejecutados puntualmente en esta sesión (arriba) → verde.
- Suite completa + `biome check`: confirmado por el PR body de `e0c5857`→`41e57f1` (`tsc --noEmit: OK`, `biome check: OK`, `vitest run: 2268 passed / 10 skipped`) + CI del PR (`build-test`, `coverage`, `light-smoke`) verde — no re-ejecutado el combo completo.

## AR/CR follow-up

- BLQ-ALTO-1 (money-path, `priceUsdc` sin validar) → **RESUELTO** en `41e57f1`, ver sección dedicada arriba.
- MNR-1 (capabilities sin sanear) / MNR-2 (whitespace guard de `name` en PATCH) → **RESUELTOS** en `41e57f1`.
- Follow-up de seguridad (guard profundo RPC de débito `increment_a2a_key_spend`/`compose.isInvalid`) → documentado como TD separado, no bloqueante, fuera de scope de esta HU.
- Cero hallazgos BLOQUEANTES sin resolver.

**Listo para DONE.**
