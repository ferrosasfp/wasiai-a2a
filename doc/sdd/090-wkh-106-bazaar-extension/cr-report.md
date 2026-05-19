# CR Report — WKH-106 BASE-03 Bazaar Discovery Extension

**Mode**: AUTO FAST+AR · paralelo con AR · foco en calidad
**Branch**: `feat/wkh-base-port-v1`
**Commits revisados**: `b20d731` (W1) · `b2bccea` (W2) · `ded6a36` (W3) · `e5d84d4` (W4)
**Reviewer**: nexus-adversary (CR)
**Date**: 2026-05-19

## Veredicto

**APROBADO**

No hay BLOQUEANTEs. 2 observaciones MENORes (no bloquean DONE). La adaptación al SDK real (no es Fastify middleware) es legítima, documentada, testeada, y estructuralmente más simple que la asumida en el work-item.

## 1. Code quality

### Naming — OK
- `selectFacilitatorUrl` (`src/lib/cdp-selector.ts:47`): claro, verbo + objeto.
- `buildBazaarDiscoveryExtension` (`src/lib/bazaar.ts:178`): factory verb correcto.
- `validateAgentSchemas` (`src/lib/bazaar.ts:109`): claro qué valida.
- `BazaarSchemaError` (`src/lib/bazaar.ts:58`): error class con `field` discriminator (`'inputSchema' | 'outputSchema' | 'manifest'`).
- `isDiscoverable` (`src/services/agent-card.ts:16`): predicado claro y aislado.

### DRY — OK con observación
- `validateAgentSchemas` (bazaar.ts:109-158): las dos ramas (`inputSchema` y `outputSchema`) son **estructuralmente idénticas**. **MNR-1** abajo.
- `selectFacilitatorUrl` simple y pura — sin duplicación.

### SOLID — OK
- **SRP**: `cdp-selector.ts` pure function sin acoplamiento (DT-3/CD-6). `bazaar.ts` 3 responsabilidades cohesivas.
- **OCP**: extender con nuevas chains base NO requiere tocar `selectFacilitatorUrl`.
- **DIP**: el route handler depende de la abstracción `BazaarSchemaError`.

### Comments — OK
- WHY comments densos: deviation del SDK documentada en `bazaar.ts:11-22`, AC tags en cada chequeo.
- `compose.ts:406-415` explica el log + referencia a `src/adapters/base/payment.ts:163-170`.

## 2. Test quality assessment

### `cdp-selector.test.ts` (17 tests) — OK
- Cubre **todos los branches**: chains × manifest × env permutations.
- Cumple **CD-6**: ningún test mockea `process.env`, valores explícitos como parámetros.
- Edge case bien cubierto: `cdpFacilitatorUrl: ''` (empty string) → retorna manifest URL.

### `bazaar.test.ts` (15 tests) — OK con observación menor
- `validateAgentSchemas`: happy + rejected shapes + rejected compileability + field message.
- `buildBazaarDiscoveryExtension`: 3 SDK variants.
- `BazaarSchemaError`: 3 tests.
- **MNR-2**: test "rejects outputSchema that is malformed" (línea 75-88) podría volverse flaky si AJV cambia detección. Sugerencia: usar input inequívoco.

### `agent-card.test.ts` (+10 tests) — OK
- AC-1 (schemas surface cuando `discoverable: true`).
- AC-3 (omit cuando false / absent).
- CD-1 (truthy promotion bloqueada con 3 valores no-bool).
- AC-4 (malformed input/output/string-primitive).
- AC-3 defense-in-depth: malformed con `discoverable: false` NO throw. **Excelente** — opt-out es kill-switch de validación.

### `agent-card.route.test.ts` (+6 tests) — OK
- Integration via `app.inject()` — buen approach.
- AC-1 body deep-equal verificado.
- AC-4 status 422 + `error_code: 'BAZAAR_SCHEMA_INVALID'` + `field` discriminator.

### `compose.test.ts` (+5 tests) — OK
- AC-2 (CDP URL selected en base-mainnet con env): assert 3 substrings del log.
- AC-5 (fallback adapter-default en base-sepolia sin env).
- AC-7 / CD-5 (Kite/Avalanche NO logean): assert `selectorLog === undefined`.
- `beforeEach`/`afterEach` restauran `process.env.CDP_FACILITATOR_URL` — cero leak.

## 3. TypeScript hygiene

### `any` explícito — OK
- No hay `any` explícito en archivos nuevos.
- `Record<string, unknown>` consistentemente para schemas (CD-8).
- Único cast `as unknown[]` en test justificado con comment.

### Casts documentados — OK
- `bazaar.ts:184`: cast `DistributiveOmit` SDK documentado en JSDoc.
- `bazaar.ts:125`: cast después de type-guard `typeof === 'object' && !null && !Array.isArray` — type-safe.

### JSDoc — OK
- `cdp-selector.ts`: top-of-file + por función + por field interface.
- `bazaar.ts`: top-of-file con "IMPORTANT — API DEVIATION FROM WORK-ITEM" prominente.

### Error types — OK
- `BazaarSchemaError extends Error` con `readonly field`/`readonly details`, `name` set en constructor. Test verifica `instanceof Error`.

## 4. Adaptation legitimacy (clave de esta HU)

**El Dev desvió del work-item — pero la desviación es legítima**.

### Equivalencia funcional a AC intent

| AC | Intent del work-item | Implementación real | Equivalente? |
|----|---------------------|---------------------|-------------|
| AC-1 | Agent-card schemas cuando discoverable=true | `buildAgentCard` aplana schemas en response JSON si `discoverable === true` | **SÍ** — superficie idéntica desde el consumidor |
| AC-3 | NO montar middleware + omitir schemas en opt-out | Sin middleware (no aplica), schemas omitidos en builder cuando flag false | **SÍ** — mismo end-state observable |
| AC-4 | Rechazar manifest con schema malformado | `validateAgentSchemas` throws `BazaarSchemaError` → route mapea a 422 | **SÍ** — además identifica `field` |
| AC-6 | Pasar schemas a constructor middleware | Schemas se serializan en agent-card que CDP indexer descubre via `GET /agents/:slug/agent-card` | **SÍ** — flujo CDP es polling-based |

### Más simple que la asumida
- **Menos deps**: sin plugin Fastify condicional.
- **Menos magic**: declarativo (schemas serializados si flag true) vs imperativo (mount/unmount middleware).
- **Menos failure modes**: sin race conditions de "middleware no montado".
- **Tree-shaking-friendly**: SDK import aislado en `src/lib/bazaar.ts`.

### Test coverage cubre el nuevo path
- 6 route integration tests con `app.inject` cubren superficie HTTP que CDP indexer verá.
- 10 unit tests cubren branches del builder.

### Documentation de la deviation
`auto-blindaje.md:8-53` documenta: qué se asumió, qué expone realmente el SDK, cómo re-interpretó el scope, dónde aplicar aprendizaje.

**Veredicto adaptation**: funcionalmente equivalente, estructuralmente más simple, testeada, y documentada. NO es atajo — es corrección al work-item basada en API real.

## 5. Documentation completeness

### README "Publishing your agent to Agentic.Market" — OK
- 3 pasos como AC-5 pide.
- Paso 1: manifest JSON con weather-oracle ejemplo realista.
- Paso 1 incluye regla CD-1 explícita (literal `true`).
- Paso 2: verification via `GET` + `error_code: "BAZAAR_SCHEMA_INVALID"`.
- Paso 3: env config + Base-only behavior.
- Greppable log line documentada para production observability.

### `.env.example` `CDP_FACILITATOR_URL` — OK
- Resolution order documentado 4 niveles.
- Comportamiento WKH-106: set vs unset, AC-5 no-regression, CD-5 Base-only.
- Production value sugerido (`https://x402.org/facilitator`).

### `auto-blindaje.md` — OK
3 entradas: API deviation, meta-schema draft-7 vs draft-2020-12, WKH-104 overlap. Estructura correcta.

## 6. Production-grade checklist

| Item | Estado | Evidencia |
|------|--------|----------|
| Logging adecuado | OK | `compose.ts:433-435` — structured, greppable, sin verbosity |
| Sin leakage de secrets en log | OK | `compose.ts:432` comment "Does NOT include the CDP key itself" |
| Error messages contextuales | OK | `BAZAAR_SCHEMA_INVALID` + `field` + `details` array |
| Defaults seguros | OK | `discoverable: false`, env-driven CDP, sin hardcoded URL (CD-2) |
| Configurability via env | OK | `process.env.CDP_FACILITATOR_URL` única fuente |
| Backward compat | OK | `AgentCard.inputSchema?`/`outputSchema?` opcionales (DT-6) |
| Sin migrations destructivas | N/A | DT-2: `discoverable` en JSONB — zero migration |
| Tests determinísticos | OK | Pure-function selector, env restore en `afterEach` |

## 7. Observaciones MENORes

### MNR-1 — DRY en `validateAgentSchemas`
- **Archivo**: `src/lib/bazaar.ts:109-158`
- **Severidad**: MENOR
- **Descripción**: las dos ramas duplican estructura (4 checks cada una). Drift posible si se agrega tercer schema en el futuro.
- **Sugerencia**: extraer `checkOneSchema(field, value)` helper.
- **Por qué NO bloqueante**: duplicación local y bounded.

### MNR-2 — Test brittle por detección AJV
- **Archivo**: `src/lib/bazaar.test.ts:75-88`
- **Severidad**: MENOR
- **Descripción**: `{ properties: 'should-be-object-not-string' }` puede no fallar siempre en futuras versiones AJV.
- **Sugerencia**: usar `{ type: 'completely-bogus-type' }` (patrón ya probado en el test anterior).

## 8. Resumen ejecutivo

**APROBADO**. WKH-106 cumple los 7 ACs (verificados en tests integration + unit), cumple las 8 CDs, y la deviation respecto del work-item está justificada, documentada y testeada. La adaptación al SDK real (NO es Fastify middleware) resulta en **menos código, menos magic, y mejor encapsulación** sin sacrificar observable behavior.

Quality posture:
- 1039 tests PASS total (52 nuevos para WKH-106).
- 0 BLOQUEANTEs, 2 MNRs (refactor DRY + un test brittle).
- TypeScript strict cumplido sin `any`.
- Docs production-ready (README 3-step guide + `.env.example` con resolution order).

Fix-pack opcional para los 2 MNRs si el orquestador decide en backlog. **No bloquea DONE.**

## Deduplication con AR

- AR encontró MNR-1 (URL leak risk en log) y MNR-2 (type repetition `as Record<string, unknown> | undefined`) y MNR-3 (missing whitespace test).
- CR encontró MNR-1 (DRY validateAgentSchemas) y MNR-2 (brittle test).
- Sin solapamiento real — AR foco security/regression, CR foco quality/refactor.

## Archivos relevantes

- `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/lib/cdp-selector.ts` + `.test.ts`
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/lib/bazaar.ts` + `.test.ts`
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/services/agent-card.ts` + `.test.ts`
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/routes/agent-card.ts` + `.test.ts`
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/services/compose.ts` (líneas 405-436) + `.test.ts` (líneas 1401-1640)
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/src/types/index.ts` (líneas 506-522)
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/README.md` (líneas 644-686)
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/.env.example` (líneas 436-455)
- `/home/ferdev/.openclaw/workspace/wasiai-a2a/doc/sdd/090-wkh-106-bazaar-extension/auto-blindaje.md`
