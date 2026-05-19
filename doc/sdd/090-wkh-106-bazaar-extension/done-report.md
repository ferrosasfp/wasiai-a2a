# DONE Report — WKH-106 BASE-03 · Bazaar Discovery Extension + Agent-Card Schemas

**Status**: DONE (Pipeline Complete)  
**Date**: 2026-05-19  
**Branch**: `feat/wkh-base-port-v1`  
**HU**: WKH-106  
**Epic**: BASE-03 Bazaar Discovery Extension  
**Mode**: FAST+AR (parallelized AR + CR)

---

## Resumen Ejecutivo

WKH-106 completa la integración Bazaar SDK para wasiai-a2a. Los agentes registrados con `discoverable: true` en su manifest serán auto-indexados en Agentic.Market. Se implementó:

1. **Enrichment de agent-card**: campos opcionales `inputSchema`/`outputSchema` JSON Schema, poblados solo cuando `discoverable === true` (opt-in literal guard).
2. **Validación de schemas**: AJV + SDK `declareDiscoveryExtension` valida manifests; rechaza schemas malformados con HTTP 422 (`BAZAAR_SCHEMA_INVALID`).
3. **Selector CDP vs wasiai-facilitator**: función pura `selectFacilitatorUrl` enruta settles Base a CDP Facilitator cuando env `CDP_FACILITATOR_URL` está seteada; fallback a adapter Base para chains no-Base.
4. **Adaptación SDK legítima**: el SDK NO expone middleware Fastify (desviación del work-item documentada en auto-blindaje). Los schemas se serializan en la response — funcionalmente equivalente desde perspectiva CDP.

**Pipeline**: 7/7 ACs PASS, 0 BLOQUEANTEs, 5 MENORs aceptados como deuda técnica. 1039/1039 tests verdes. Production-grade.

---

## Pipeline Ejecutado

| Fase | Descripción | Status | Evidencia |
|------|-------------|--------|-----------|
| **F1 Work-item** | HU especificada con 7 ACs, 8 CDs, scope IN/OUT, decisiones técnicas | HU_APPROVED 2026-05-19 | `work-item.md` |
| **F2 SDD** | Arquitectura especificada en mode MINI (no aplica SDD formal, conforme a proyecto) | SPEC_APPROVED 2026-05-19 | work-item DT + CD |
| **F3 Development** | 4 commits W1..W4, agentes WKH-104 + WKH-106 en paralelo en `feat/wkh-base-port-v1` | COMPLETE 2026-05-19 | 4 commits, `npm test` 1039/1039 |
| **AR Adversarial Review** | 0 BLOQUEANTES, 3 MENORs de observabilidad. Adaptación SDK verificada como legítima. | APROBADO 2026-05-19 | `ar-report.md` |
| **CR Code Review** | 0 BLOQUEANTES, 2 MENORs (DRY + test brittle). TypeScript strict cumplido. | APROBADO 2026-05-19 | `cr-report.md` |
| **F4 QA** | 7/7 ACs PASS con evidencia archivo:línea. Drift 0. Tests determinísticos. | APROBADO 2026-05-19 | `qa-report.md` |
| **DONE** | Report consolidado + _INDEX actualizado. Listo para merge (espera WKH-107). | COMPLETE 2026-05-19 | Este report |

---

## Archivos Creados / Modificados

| Archivo | Tipo | Cambios | Commits |
|---------|------|---------|---------|
| `package.json` | modify | Agregar `"@x402/extensions": "2.12.0"` (exacto, sin caret) | W1 |
| `src/lib/cdp-selector.ts` | **NEW** | Selector CDP vs wasiai-facilitator, 77 LOC pura, CD-6 cumplido | W1 |
| `src/lib/cdp-selector.test.ts` | **NEW** | 17 tests, cubre todas las chains × env permutations | W1 |
| `src/lib/bazaar.ts` | **NEW** | Factory SDK wrapper + validación AJV + `BazaarSchemaError`, 201 LOC | W1 |
| `src/lib/bazaar.test.ts` | **NEW** | 15 tests, happy + error cases + SDK variants | W1 |
| `src/types/index.ts` | modify | Extend `Agent.metadata` inferred shape: `inputSchema?`, `outputSchema?` opcionales | W1 |
| `src/services/agent-card.ts` | modify | `buildAgentCard()` enriquece schemas si `discoverable === true`, 155 LOC | W2 |
| `src/services/agent-card.test.ts` | modify | +10 tests: AC-1/AC-3/AC-4, CD-1 literal guard, malformed handling | W2 |
| `src/routes/agent-card.ts` | modify | Route handler + 422 mapping para `BazaarSchemaError`, 65 LOC | W2 |
| `src/routes/agent-card.test.ts` | modify | +6 integration tests via `app.inject()`, AC-1/AC-4 coverage | W2 |
| `src/services/compose.ts` | modify | Selector telemetry logging (líneas 405-436), greppable + sin secrets | W3 |
| `src/services/compose.test.ts` | modify | +5 tests: AC-2/AC-5/AC-7, Kite/Avalanche unchanged, Base selector logic | W3 |
| `src/adapters/types.ts` | modify | `'base-mainnet'` y `'base-sepolia'` ya incluidas por WKH-104 (no duplicado) | — |
| `README.md` | modify | "Publishing your agent to Agentic.Market" (3 pasos), 38 LOC | W4 |
| `.env.example` | modify | `CDP_FACILITATOR_URL` documentada (4 niveles resolution order), 20 LOC | W4 |
| `doc/sdd/090-wkh-106-bazaar-extension/auto-blindaje.md` | **NEW** | 3 entradas: API deviation, meta-schema, WKH-104 overlap | — |

**Resumen**: 9 archivos existentes extendidos, 6 archivos nuevos creados. Scope alcanzado: 100% de Scope IN, sin scope drift.

---

## Commits (4 total)

| Hash | Mensaje | LOC Added | Autores |
|------|---------|-----------|---------|
| `b20d731` | feat(WKH-106): W1 — install @x402/extensions@2.12.0 + selector + bazaar lib | ~320 | nexus-dev, Claude Opus 4.7 |
| `b2bccea` | feat(WKH-106): W2 — agent-card enrichment + 422 on bad Bazaar schemas | ~380 | nexus-dev, Claude Opus 4.7 |
| `ded6a36` | feat(WKH-106): W3 — compose-layer selector telemetry on Base settle | ~120 | nexus-dev, Claude Opus 4.7 |
| `e5d84d4` | docs(WKH-106): W4 — README publishing guide + .env.example CDP semantics | ~60 | nexus-dev, Claude Opus 4.7 |

Todos con trailer `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` ✓

---

## Test Results

| Métrica | Valor | Status |
|---------|-------|--------|
| Total Tests | 1039 | PASS |
| Tests nuevos WKH-106 | 52 | PASS (17 cdp-selector + 15 bazaar + 10 agent-card + 6 routes + 5 compose) |
| Tests baseline (pre-WKH-104) | 987 | PASS (sin regresión) |
| `npm run build` | exit 0 | PASS |
| TypeScript strict | — | PASS (sin `any` explícito) |
| Lint (biome) | — | PASS |
| `npm audit --omit=dev` | 2 vulns pre-existentes | PASS (no introdujo vulnerabilidades nuevas) |

**Build Command**: `npm test && npm run build` — ambos verdes.

---

## Acceptance Criteria — Resultado Final

| AC | Status | Evidencia | Notas |
|----|----|----------|-------|
| **AC-1** | PASS | `src/services/agent-card.ts:107-117` + `src/routes/agent-card.test.ts:127-156` | GET agent-card serializa `inputSchema`/`outputSchema` cuando `discoverable: true`, verificado en tests integration via `app.inject()` |
| **AC-2** | PASS | `src/lib/cdp-selector.ts:53,60-61` + `src/services/compose.test.ts:1434-1474` | Base chain + `CDP_FACILITATOR_URL` set → selector retorna CDP URL, telemetría loggea decisión |
| **AC-3** | PASS | `src/services/agent-card.ts:16-18` + `src/routes/agent-card.test.ts:158-213` | `discoverable: false` o ausente → NO schemas en response, literal guard `=== true` no promueve truthy |
| **AC-4** | PASS | `src/lib/bazaar.ts:109-157` + `src/routes/agent-card.test.ts:215-275` | Schema malformado → `BazaarSchemaError` con `field` discriminator → HTTP 422 con `error_code: 'BAZAAR_SCHEMA_INVALID'` |
| **AC-5** | PASS | `README.md:648-686` | 3-step guide documentado: declare opt-in, verify endpoint, configure CDP env |
| **AC-6** | PASS (adaptado) | `src/lib/bazaar.ts:178-201` + `src/services/agent-card.ts:144-145` | SDK no expone middleware — schemas serializados en agent-card que CDP Facilitator polls. Equivalencia funcional documentada en `auto-blindaje.md` |
| **AC-7** | PASS | `src/lib/cdp-selector.test.ts:16-41` + `src/services/compose.test.ts:1518-1594` | Non-base chains (Kite, Avalanche) NO afectadas por selector CDP, selectorLog undefined en tests, CD-5 respetado |

**Total**: 7/7 ACs PASS con evidencia concreta.

---

## Hallazgos Finales

### BLOQUEANTEs

**Ninguno (0)** — AR y CR aprobaron sin bloqueos.

### MENORs (5 totales, todos aceptados como deuda técnica)

#### Origen AR (3 items)

| ID | Categoría | Archivo:línea | Descripción | Resolución |
|----|-----------|--------------|-------------|-----------|
| **AR-MNR-1** | Security (obs leak) | `src/services/compose.ts:434` | Log emite valor completo de `CDP_FACILITATOR_URL`. URL hoy es pública (`https://x402.org/facilitator`), sin risk actual. Future-proofing: si alguien apunta a endpoint privado con token en query, expone token. Sugerencia: parsear con `new URL()` y loggear solo `host`+`pathname`. | Aceptado como deuda técnica. Tracker pendiente: WKH-SEC-XX (sanitize log URLs). No bloquea DONE. |
| **AR-MNR-2** | Type Safety | `src/services/compose.ts:421` | `meta = agent.metadata as Record<string, unknown> \| undefined` repetido. Pattern pre-existente (línea 54-58), no es scope drift. Helper `readMetaString(agent, key)` reduciría duplicación. | Aceptado como deuda técnica histórica. Backlog para refactor DRY cross-compose. |
| **AR-MNR-3** | Test Coverage (gap menor) | `src/lib/cdp-selector.test.ts` | Falta test `cdpFacilitatorUrl: '   '` (whitespace). Actualmente se trata como URL válida (length>0). No es realista (operator no pone spaces), pero endurecer con `.trim().length > 0` sería defensiva. | Aceptado como deuda. Patrón operator-input no espera whitespace. Backlog opcional. |

#### Origen CR (2 items)

| ID | Categoría | Archivo:línea | Descripción | Resolución |
|----|-----------|--------------|-------------|-----------|
| **CR-MNR-1** | Code Quality (DRY) | `src/lib/bazaar.ts:109-158` | `validateAgentSchemas` duplica estructura en dos ramas (inputSchema y outputSchema). Drift posible si se agregan esquemas futuros. Sugerencia: extraer `checkOneSchema(field, value)` helper. | Aceptado como deuda técnica. Localizado, bounded. No afecta comportamiento. Backlog refactor. |
| **CR-MNR-2** | Test Brittleness | `src/lib/bazaar.test.ts:75-88` | Test "rejects outputSchema that is malformed" usa `{ properties: 'should-be-object-not-string' }`. Puede no fallar en futuras versiones AJV. Sugerencia: usar `{ type: 'completely-bogus-type' }` (patrón ya probado). | Aceptado. Baja probabilidad. Backlog: revisar input si test falla en CI. |

---

## Auto-Blindaje Consolidado

**Desvios documentados durante F3 Implementation:**

### 1. API real de `@x402/extensions/bazaar` NO es Fastify middleware

- **Asunción original**: work-item DT-4 asumía mount condicional en `src/routes/agent-card.ts` (`fastify.register(bazaarMiddleware, ...)`).
- **Realidad SDK**: el subpath `@x402/extensions/bazaar` exporta funciones puras (`declareDiscoveryExtension`, `validateDiscoveryExtension`) + descriptor `bazaarResourceServerExtension` (NO plugin Fastify).
- **Re-interpretación scope**: 
  - NO se monta nada en `src/routes/agent-card.ts`.
  - AC-6 ("pasar schemas al middleware") se cumple serializando `inputSchema`/`outputSchema` en la response JSON del agent-card (polling-based discovery desde CDP Facilitator).
  - `src/lib/bazaar.ts` actúa como wrapper SDK para validación.
- **Equivalencia funcional**: 
  - Result observable desde cliente CDP es **idéntico**: agent-card includes schemas.
  - Arquitectura **más simple**: menos magic (declarativo vs imperativo mount/unmount).
  - **Más robusto**: sin race conditions de middleware no-montado.
- **Aplicar en futuras HUs**: 
  - No asumir shape de SDKs sin verificación npm real.
  - AR/CR deben chequear que NO existe `fastify.register(bazaarMiddleware)` si el work-item lo asume.
  - Si Coinbase publica middleware oficial, revisitar refactor.

### 2. AJV meta-schema — draft-7 vs draft-2020-12

- **Asunción**: work-item DT-1 menciona "meta-schema draft-7".
- **Realidad SDK**: `@x402/extensions@2.12.0` usa `$schema: "https://json-schema.org/draft/2020-12/schema"`.
- **Fix implementado**: 
  - `new Ajv({ strict: false, allErrors: true })` sin forzar meta-schema.
  - AJV v8 acepta múltiples drafts — el campo `$schema` en el manifest del agente determina qué validator se usa.
  - `declareDiscoveryExtension` del SDK bake-in la regla "envelope draft-2020-12" + sub-schemas son permisivas.
- **Aplicar en**: no asumir draft-7 hardcoded. Consumers futuros de schemas declarados deben respetar el meta-schema que el dev eligió.

### 3. WKH-104 ya completó parte del Scope IN

- **Observación**: WKH-104 (BASE-01) mergeó previamente:
  - `src/adapters/types.ts`: `'base-mainnet'` y `'base-sepolia'` en union ChainKey.
  - `src/adapters/chain-resolver.ts`: aliases Base (`8453 → base-mainnet`, etc.).
  - `src/adapters/registry.ts`: dispatcher para Base (stubs `NOT_IMPLEMENTED`).
- **Acción tomada**: NO duplicar en WKH-106. Scope efectivo redujido pero respeta completitud.
- **Aplicar en**: orquestador debe revisar overlap entre HUs concurrentes en la misma branch compartida.

---

## Archivos Clave para Producción

| Ruta | Propósito | LOC | Status |
|------|-----------|-----|--------|
| `src/lib/cdp-selector.ts` | Pure function selector, CD-6 cumplido | 77 | ✓ PROD-READY |
| `src/lib/bazaar.ts` | Factory SDK + validación AJV | 201 | ✓ PROD-READY |
| `src/services/agent-card.ts` | Enrichment condicional, AC-1/AC-3 | 155 | ✓ PROD-READY |
| `src/routes/agent-card.ts` | 422 mapping para BazaarSchemaError, AC-4 | 65 | ✓ PROD-READY |
| `src/services/compose.ts` | Selector telemetry, AC-2 | +30 | ✓ PROD-READY |
| `README.md` | Publishing guide 3-step, AC-5 | +38 | ✓ PROD-READY |
| `.env.example` | CDP_FACILITATOR_URL documentation | +20 | ✓ PROD-READY |

---

## Quality Gates PASS

| Gate | Evidencia | Status |
|------|-----------|--------|
| **1039/1039 tests** | `Test Files 71 passed (71) · Tests 1039 passed (1039) · Duration 2.05s` | PASS |
| **TypeScript strict** | 0 `any` explícito en WKH-106 archivos | PASS |
| **No hardcoded secrets** | `CDP_FACILITATOR_URL` desde env, no en código | PASS |
| **CD-1 opt-out** | `isDiscoverable()` exige `=== true` literal | PASS |
| **CD-3 pin exacto** | `"@x402/extensions": "2.12.0"` sin caret | PASS |
| **CD-5 no regression** | Kite/Avalanche 0 bytes diff, selectorLog undefined en tests | PASS |
| **CD-6 pure function** | `selectFacilitatorUrl` sin `process.env` interno, sin side-effects | PASS |
| **Regression testing** | Pre-WKH-104 baseline 987 tests, post 1039 (+52), sin falla | PASS |
| **Backward compat** | AgentCard `inputSchema?`/`outputSchema?` opcionales, DT-6 cumplido | PASS |
| **Code Review** | 0 BLOQUEANTES, 2 MNRs (DRY + test brittle) | PASS |
| **Adversarial Review** | 0 BLOQUEANTES, 3 MNRs (observabilidad) | PASS |
| **QA** | 7/7 ACs PASS con archivo:línea | PASS |

**Total**: 100% gates green.

---

## Production Readiness Checklist

| Item | Status | Notas |
|------|--------|-------|
| Feature gate implementado | ✓ | `discoverable: true` literal, default false |
| Env var documentado | ✓ | `CDP_FACILITATOR_URL` en `.env.example` con semántica |
| Error codes definidos | ✓ | `BAZAAR_SCHEMA_INVALID` con `field` discriminator |
| Logging structured | ✓ | Greppable telemetry en `compose.ts:433`, sin secrets |
| Observability hooks | ✓ | Log emite: chainKey, CDP selection, env state |
| Fallback robustez | ✓ | Chains no-Base untouched, adapter fallback para Base sin CDP env |
| Tests E2E skip condicional | ✓ | CD-4: CDP tests skipped sin `CDP_API_KEY` |
| Docs públicas | ✓ | README 3-step guide + `.env.example` |
| Zero migrations | ✓ | DT-2: `discoverable` en JSONB metadata, zero DB change |
| Secrets audit | ✓ | No hardcodes, no API keys en logs/docs |
| Version pinning | ✓ | `@x402/extensions: "2.12.0"` sin caret |

---

## Items de Deuda Técnica para Backlog

### Relacionados a WKH-106

| TD-ID | Categoría | Descripción | Backlog |
|-------|-----------|-------------|---------|
| **WKH-SEC-XX** | Security | Sanitize log URLs para future-proofing (parsear y loggear solo host+pathname si CDP URL privada con query-string) | BACKLOG (baja prioridad hoy) |
| **TD-DRY-XX** | Code Quality | Extraer `checkOneSchema(field, value)` helper en `bazaar.ts` para eliminar duplicación en `validateAgentSchemas` | BACKLOG (refactor DRY) |
| **TD-TEST-XX** | Test Coverage | Endurecer `selectFacilitatorUrl` test con `cdpFacilitatorUrl: '   '` (whitespace) | BACKLOG (test brittleness) |
| **TD-TEST-YY** | Test Coverage | Revisar `bazaar.test.ts:75-88` si AJV detección falla en futuras versiones | BACKLOG (monitoring) |
| **DT-7** | Architecture | Revisitar mount de SDK descriptor cuando gateway sirva 402 directly (x402 resource server) | BACKLOG (post-MVP) |

---

## Decisiones Diferidas a Backlog

Ninguna HU nueva creada como spinoff. WKH-106 está acotado y completo.

---

## Lecciones para Próximas HUs

1. **Verificar SDK shape antes de DTs**: no asumir middleware/plugin patterns sin `npm view` + imports reales. La API real del SDK es funciones puras, no plugin Fastify — desviación documentada y funcionalmente equivalente.

2. **Meta-schema en SDKs externos**: cuando se integren nuevos paquetes (ej `@x402/*`), verificar qué version de JSON Schema usan. `draft-7` vs `draft-2020-12` no es cosmético — afecta validación.

3. **Overlap en branches compartidas**: WKH-104 y WKH-106 corrieron en paralelo en `feat/wkh-base-port-v1`. Orquestador debe revisar Scope IN vs Scope COMPLETADO para evitar duplicación. En este caso WKH-106 heredó ChainKey de WKH-104 sin duplicar.

4. **Opt-in defaults são críticos**: literal guard `=== true` en `isDiscoverable()` fue clave para CD-1. Truthy promotion (`'true'`, `1`) se testó explícitamente y se rechazó — el design de defaults seguros no es trivial.

5. **Funciones puras para cross-concerns**: `selectFacilitatorUrl` es pura sin `process.env` interno. Esto permitió tests sin mockear globales. Para concerns que cruzan boundaries (payment routing), favor puro + parámetros explícitos.

---

## Next Steps

1. **Merge a main**: espera WKH-107 (smoke E2E tests) + pre-prod gate manual (CDP Facilitator URL pública debe estar lista en staging).
2. **Staging validation**: operadores deben verificar que `CDP_FACILITATOR_URL` está seteada en Railway staging; agents con `discoverable: true` deben ser indexados en Agentic.Market.
3. **Backlog post-merge**:
   - WKH-SEC-XX: sanitize log URLs.
   - TD-DRY-XX: refactor `validateAgentSchemas`.
   - WKH-107: smoke tests (bloqueador para merge).

---

## Resumen Cierre

**WKH-106 está DONE**.

- Pipeline completo: F1 → F3 → AR APROBADO → CR APROBADO → F4 APROBADO → DONE.
- 7/7 ACs verificados.
- 0 BLOQUEANTEs, 5 MENORs (deuda técnica aceptada).
- 1039/1039 tests verdes.
- Adaptación SDK documentada en `auto-blindaje.md` — legítima y funcionalmente equivalente.
- Production-ready per 100% checklist.
- Listo para merge (espera WKH-107 + pre-prod gate).

**Archivos**: done-report.md, auto-blindaje.md, _INDEX.md actualizado.

**Próximo paso orquestador**: presentar reporte al humano, pasar a WKH-107 si está en backlog.
