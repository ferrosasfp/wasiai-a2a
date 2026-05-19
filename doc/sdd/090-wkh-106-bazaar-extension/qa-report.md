# QA Report — WKH-106 BASE-03 Bazaar Discovery Extension (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-05-19
**Branch**: `feat/wkh-base-port-v1`
**Commits WKH-106**: `b20d731` (W1) · `b2bccea` (W2) · `ded6a36` (W3) · `e5d84d4` (W4)

---

## Runtime / Integration Checks

- **DB state**: N/A — WKH-106 no toca DB (DT-2: `discoverable` en JSONB metadata, zero-migration).
- **Env parity**: `CDP_FACILITATOR_URL` documentado en `.env.example:460` (línea `CDP_FACILITATOR_URL=`) con semántica completa (set vs. unset, Base-only, greppable log). No hay deployment target para verificar programáticamente (Railway env vars requieren verificación manual por operador).
- **Migration**: N/A — ninguna migration en WKH-106.
- **Package pin**: `package.json:22` → `"@x402/extensions": "2.12.0"` sin caret. CD-3 cumplido.

---

## Quality Gates

| Gate | Status | Evidencia |
|------|--------|-----------|
| `npm test` 1039/1039 | PASS | `Test Files 71 passed (71) · Tests 1039 passed (1039) · Duration 2.05s` — verificado independientemente |
| `npm run build` strict verde | PASS | exit 0, sin output de error (tsc -p tsconfig.build.json) — verificado independientemente |
| `npm audit --omit=dev` | PASS (pre-existente) | 2 vulns: `@anthropic-ai/sdk` (moderate) + `fast-uri <=3.1.1` (high). Ambas pre-existentes en main. `fast-uri` transitiva de fastify@5.8.5, deduplicada — WKH-106 NO las introdujo. Tracker: WKH-SEC-XX (out of scope). |
| Lint | PASS (confirmado por CR report) | CR report: "TypeScript strict cumplido sin `any`", exit limpio en CI |

---

## ACs

| AC | Status | Evidencia archivo:línea |
|----|--------|-------------------------|
| AC-1: `GET /agents/:slug/agent-card` con `discoverable: true` SHALL incluir `inputSchema`/`outputSchema` válidos JSON Schema | PASS | `src/services/agent-card.ts:107-117` spread condicional. Tests: `src/services/agent-card.test.ts:155-171` (unit, `expect(card.inputSchema).toEqual(validInputSchema)`) + `src/routes/agent-card.test.ts:127-156` (integration via `app.inject`, `expect(res.statusCode).toBe(200)` + deep-equal body) |
| AC-2: `CDP_FACILITATOR_URL` set + chainKey `base-*` → settle routea via CDP | PASS | `src/lib/cdp-selector.ts:53,60-61` — `chainKey.startsWith('base-')` + `cdpFacilitatorUrl.length > 0` → retorna CDP URL. Tests: `src/lib/cdp-selector.test.ts:44-65` (puro, 4 casos base-mainnet/sepolia × con/sin manifest). Compose-layer: `src/services/compose.test.ts:1434-1474` — AC-2: `expect(selectorLog).toContain('selected=https://x402.org/facilitator')` + `cdpEnvSet=true` |
| AC-3: `discoverable: false` o ausente → response NO incluye `inputSchema`/`outputSchema` | PASS | `src/services/agent-card.ts:16-18` — `isDiscoverable()` exige `=== true` literal. Tests: `src/services/agent-card.test.ts:173-206` (false y absent), `src/routes/agent-card.test.ts:158-213` (HTTP integration, `expect(body.inputSchema).toBeUndefined()`) |
| AC-4: schema malformado + `discoverable: true` → rechazo en load/registration con field identifier | PASS | `src/lib/bazaar.ts:109-157` — `validateAgentSchemas` lanza `BazaarSchemaError` con `field: 'inputSchema' \| 'outputSchema'`. Route handler: `src/routes/agent-card.ts:58-65` mapea a HTTP 422 con `error_code: 'BAZAAR_SCHEMA_INVALID'` + `field`. Tests: `src/routes/agent-card.test.ts:215-275` (422 por inputSchema inválido → `expect(body.field).toBe('inputSchema')`, 422 por outputSchema inválido → `expect(body.field).toBe('outputSchema')`) |
| AC-5: README documenta el flow en 3 pasos | PASS | `README.md:648-686` — sección "Publishing your agent to Agentic.Market". 3 pasos literales: (1) Declare opt-in + schemas, (2) Verify agent-card endpoint, (3) Configure CDP Facilitator on Base. Incluye greppable log line, CD-1 warning, error_code reference. |
| AC-6: middleware (o equivalente) pasa `inputSchema`/`outputSchema` para que CDP los extraiga | PASS (adaptado, documentado) | API real del SDK no expone middleware Fastify — ver `auto-blindaje.md`. Adaptación: schemas serializados en agent-card response (`src/services/agent-card.ts:144-145`) que CDP Facilitator indexa via polling `GET /agents/:slug/agent-card`. `buildBazaarDiscoveryExtension` en `src/lib/bazaar.ts:178-201` produce el descriptor SDK. AR/CR validaron equivalencia funcional. |
| AC-7: chainKey NO-base → selector NO aplica regardless de `CDP_FACILITATOR_URL` | PASS | 3 capas de defensa: (1) `src/lib/cdp-selector.ts:55-57` — `!isBaseChain → return agentManifestFacilitatorUrl` sin tocar CDP URL; (2) `src/services/compose.ts:420` — bloque entero en `if (chainKey?.startsWith('base-'))`; (3) Tests `src/services/compose.test.ts:1518-1554` (Kite) + `1557-1594` (Avalanche) — `expect(selectorLog).toBeUndefined()` con `CDP_FACILITATOR_URL` seteado. `src/lib/cdp-selector.test.ts:16-41` (4 non-base chains × 2 casos = 8 tests). |

---

## Drift Detection

**Scope drift**: NINGUNO.

WKH-106 commits (`b20d731`..`e5d84d4`) tocaron exclusivamente:
- `src/lib/bazaar.ts`, `src/lib/bazaar.test.ts` (NEW)
- `src/lib/cdp-selector.ts`, `src/lib/cdp-selector.test.ts` (NEW)
- `src/services/agent-card.ts`, `src/services/agent-card.test.ts` (extend)
- `src/routes/agent-card.ts`, `src/routes/agent-card.test.ts` (extend)
- `src/services/compose.ts`, `src/services/compose.test.ts` (extend)
- `src/types/index.ts` (extend — `inputSchema?`/`outputSchema?` opcionales)
- `package.json`, `package-lock.json`, `README.md`, `.env.example`, `doc/sdd/090-wkh-106-bazaar-extension/`

Los archivos `src/adapters/base/`, `src/adapters/__tests__/` en el diff total pertenecen a **WKH-104** (commits `3b4ab0d`..`8793306`), no a WKH-106. Confirmado por `git log --name-only`.

`src/adapters/avalanche/` y `src/adapters/kite-ozone/` — **0 bytes diff** (verificado: `git diff main feat/wkh-base-port-v1 -- src/adapters/avalanche/` → sin output). CD-5 respetado.

**Wave drift**: W1 (selector + bazaar factory + tipos) → W2 (agent-card enrichment + 422) → W3 (compose telemetry) → W4 (docs) — orden coherente con el scope.

**Spec drift**: `isDiscoverable()` (`src/services/agent-card.ts:16-18`) exige `=== true` literal consistente con CD-1. `@x402/extensions: "2.12.0"` sin caret consistente con CD-3. Función `selectFacilitatorUrl` pura sin `process.env` interno consistente con CD-6.

---

## Production-grade Audit (verificación independiente)

| Item | Status | Evidencia |
|------|--------|-----------|
| Sin `any` explícito en archivos WKH-106 | OK | `grep ": any\|as any\|<any>"` en `src/lib/bazaar.ts`, `src/lib/cdp-selector.ts`, `src/services/agent-card.ts`, `src/routes/agent-card.ts` → 0 hits (el único hit es `"any sample input"` dentro de comentario JSDoc) |
| Default opt-out CD-1 respetado | OK | `isDiscoverable()` → `agent.metadata?.discoverable === true` (strict). Truthy values `'true'`, `1`, `'yes'` no promueven — cubierto en `agent-card.test.ts:208-224` |
| URL CDP no hardcodeada (CD-2) | OK | `src/lib/cdp-selector.ts` — parámetro `cdpFacilitatorUrl?: string` recibido del caller, no leído internamente. Caller en `compose.ts:429` usa `process.env.CDP_FACILITATOR_URL`. `.env.example:460` documenta la var. |
| Secrets seguros en logs | OK con MNR-1 heredado | `compose.ts:433-434` emite URL completa del CDP facilitator. La URL pública (`https://x402.org/facilitator`) no es secreta hoy. AR documentó el risk residual en MNR-1 (observabilidad futura si URL privada con query-string). Aceptado como deuda técnica. |
| Backward compat `AgentCard` | OK | `src/types/index.ts:516,521` — `inputSchema?` y `outputSchema?` opcionales. Consumers sin soporte los ignoran (DT-6). Tests clásicos `agent-card.test.ts:60-141` verdes. |
| AJV singleton (performance) | OK | `src/lib/bazaar.ts:78` — `_ajv = new Ajv(...)` module-level singleton, compile cached per schema. O(1) por request después del primer compile. |
| `@x402/extensions` pinned exacto | OK | `package.json:22` → `"2.12.0"` sin caret. CD-3 cumplido. |

---

## AR/CR Findings Consolidados

| ID | Origen | Descripción | Resolución |
|----|--------|-------------|------------|
| AR-MNR-1 | AR | `compose.ts:434` loggea CDP URL completa (riesgo futuro si URL privada con token) | Aceptado como TD — URL hoy es pública. Backlog WKH-SEC-XX. No bloquea DONE. |
| AR-MNR-2 | AR | `meta = agent.metadata as Record<string, unknown> \| undefined` repetido (patrón pre-existente) | Aceptado como TD (deuda histórica). |
| AR-MNR-3 | AR | Falta test `cdpFacilitatorUrl: '   '` (whitespace) | Aceptado — no es un patrón realista de operator input. |
| CR-MNR-1 | CR | `validateAgentSchemas` duplica estructura para inputSchema/outputSchema — refactor DRY sugerido | Aceptado como TD. Localizado, bounded, no afecta comportamiento. |
| CR-MNR-2 | CR | Test `bazaar.test.ts:75-88` usa `{ properties: 'should-be-object-not-string' }` que puede no fallar en futuras versiones AJV | Aceptado — baja probabilidad. Backlog. |

**Total BLOQUEANTES**: 0 (AR) + 0 (CR) = 0.
**Total MENORes**: 3 (AR) + 2 (CR) = 5, todos aceptados como deuda técnica. Ninguno bloquea DONE.

---

## Resumen Ejecutivo

WKH-106 implementa la Bazaar Discovery Extension para agentes con `discoverable: true` en wasiai-a2a. Los 7 ACs se cumplen con evidencia concreta:

- **AC-1/AC-3**: serialización condicional de schemas en `buildAgentCard()` controlada por `isDiscoverable()` literal-guard.
- **AC-2/AC-5/AC-7**: función pura `selectFacilitatorUrl` con defensa en 3 capas (selector, compose guard, tests Kite/Avalanche).
- **AC-4**: `BazaarSchemaError` con `field` discriminator → HTTP 422 con `error_code: 'BAZAAR_SCHEMA_INVALID'`.
- **AC-5** (README): sección "Publishing your agent to Agentic.Market" con 3 pasos explícitos.
- **AC-6**: adaptación documentada — el SDK no expone middleware Fastify; schemas llegan al CDP Facilitator via agent-card response (equivalencia funcional verificada por AR y CR).

Gates: 1039/1039 tests verdes, build strict sin errores, 2 vulns de audit pre-existentes en main. Sin scope drift, sin Avalanche/Kite tocados, sin `any`, sin hardcodes.

---

**APROBADO PARA DONE.** Pasar a `/nexus-p8-done WKH-106`.
