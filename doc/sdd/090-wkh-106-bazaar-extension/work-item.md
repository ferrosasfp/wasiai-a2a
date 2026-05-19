# Work Item — [WKH-106] BASE-03 · Bazaar Discovery Extension + Agent-Card Schemas

## Resumen

Integrar el SDK `@x402/extensions/bazaar` de Coinbase para que los agentes registrados
en wasiai-a2a con `discoverable: true` en su manifest sean auto-indexados en
Agentic.Market sin registro manual. La integración enriquece `agent-card.ts` con
`inputSchema`/`outputSchema` JSON Schema, agrega un selector env-driven CDP vs
wasiai-facilitator para settles sobre Base, y monta el middleware Bazaar únicamente
en routes de agentes Base con opt-in explícito. Default conservador (`discoverable: false`).

## Sizing

- SDD_MODE: mini
- Pipeline: FAST+AR
- Estimación: M (≈ 8h — deps+tipos: 1h, agent-card enrich + manifest: 2h, selector CDP: 2h, tests: 2h, README: 1h)
- Branch sugerido: `feat/wkh-base-port-v1` (compartida con wave BASE-01/02)

## Acceptance Criteria (EARS)

- AC-1: WHEN `GET /agents/:slug/agent-card` is called for an agent whose manifest has `discoverable: true`, the system SHALL include `inputSchema` and `outputSchema` fields in the response body, each being a valid JSON Schema draft-7 object.
- AC-2: WHEN a compose settle is initiated and `CDP_FACILITATOR_URL` is set in env AND the resolved chain key begins with `base-`, the system SHALL route the settle call to the CDP Facilitator URL instead of the wasiai-facilitator URL.
- AC-3: WHEN an agent manifest has `discoverable: false` OR the `discoverable` field is absent, the system SHALL NOT mount the Bazaar middleware on that agent's route AND the agent-card response SHALL NOT include `inputSchema` or `outputSchema`.
- AC-4: IF a manifest declares `discoverable: true` but provides a malformed `inputSchema` or `outputSchema` (not a valid JSON Schema draft-7 object), THEN the system SHALL reject the manifest at load/registration time with an error message that identifies which schema field is invalid and why.
- AC-5: WHILE `CDP_FACILITATOR_URL` is NOT set in env, the system SHALL route all Base settles to the existing wasiai-facilitator path, preserving current behavior with no regression.
- AC-6: WHEN `@x402/extensions/bazaar` middleware is mounted for a discoverable agent route, the system SHALL pass the agent's `inputSchema` and `outputSchema` to the middleware constructor so CDP Facilitator can extract them after the first settle.
- AC-7: IF the resolved chain key does NOT begin with `base-`, THEN the system SHALL NOT apply the CDP Facilitator selector regardless of the value of `CDP_FACILITATOR_URL`, leaving Kite and Avalanche settle paths unmodified.

## Scope IN

- `package.json` — add `@x402/extensions/bazaar` as a pinned (exact version, no caret) dependency
- `src/adapters/types.ts` — extend `ChainKey` union with `'base-mainnet'` and `'base-sepolia'`
- `src/adapters/registry.ts` — add `'base-mainnet'` and `'base-sepolia'` to `SUPPORTED_CHAINS` and `buildBundle` dispatcher (stubs that throw `NOT_IMPLEMENTED` until BASE-01 merges, but registered so chain-resolver tests compile)
- `src/adapters/chain-resolver.ts` — add Base aliases (`8453 → base-mainnet`, `84532 → base-sepolia`, etc.)
- `src/types/index.ts` — extend `Agent.metadata` inferred shape with optional `discoverable?: boolean`, `inputSchema?: JSONSchema`, `outputSchema?: JSONSchema` (documented as `Record<string, unknown>` extensions, not breaking the existing `metadata` field type)
- `src/services/agent-card.ts` — `buildAgentCard()` conditionally appends `inputSchema` and `outputSchema` to the returned card when `agent.metadata.discoverable === true`; validates schemas via AJV (meta-schema validation) before inclusion
- `src/routes/agent-card.ts` — wire Bazaar middleware mount logic: if agent is discoverable AND chain is Base, instantiate and apply middleware from `@x402/extensions/bazaar`
- `src/lib/bazaar.ts` — NEW: factory that creates the Bazaar middleware instance from agent metadata; encapsulates the SDK import so it can be tree-shaken / conditionally imported
- `src/lib/cdp-selector.ts` — NEW: pure function `selectFacilitatorUrl(chainKey: ChainKey, agentManifestFacilitatorUrl?: string): string` that applies env-driven CDP vs wasiai-facilitator logic (CD-2); used by compose/settle paths
- `src/services/compose.ts` — call `selectFacilitatorUrl` in `invokeAgent` when performing settle on Base chains
- `README.md` — add section "Publishing your agent to Agentic.Market" (3-step guide)
- `test/bazaar.test.ts` — schema validation tests + selector logic unit tests + middleware mount tests
- `.env.example` — document `CDP_FACILITATOR_URL` (optional, Base-only)

## Scope OUT

- NO modificar adapters de Avalanche ni Kite (Bazaar es Base-only)
- NO implementar un MCP directory server propio (usar el de Coinbase en `GET /v2/x402/discovery/mcp`)
- NO retroactive indexing de agentes ya registrados sin `discoverable: true`
- NO implementar un adapter completo de Base (eso es BASE-01 / WKH-104); esta HU solo registra los stubs de ChainKey
- NO modificar la tabla `a2a_registries` ni el schema de DB (Bazaar metadata vive en `Agent.metadata`, no en DB)
- NO implementar autenticación contra la API de Agentic.Market

## Decisiones técnicas (DT-N)

- DT-1: Schema validation library — usar **AJV v8** (ya presente como dep transitiva via Fastify/`@fastify/ajv-compiler`). Importar `Ajv` + `addFormats` y usar `ajv.compile(schema)` contra el meta-schema draft-7 para validar `inputSchema`/`outputSchema` al cargar el manifest. NO agregar una nueva dep de schema-validation; AJV ya está disponible en el runtime.
- DT-2: `discoverable` flag vive en `Agent.metadata`, no en una columna nueva de DB. Esto mantiene zero-migration: los registries que ya almacenan metadata JSONB pueden incluir el campo sin cambios de schema.
- DT-3: El selector CDP vs wasiai-facilitator (`src/lib/cdp-selector.ts`) es una función pura (sin efectos, sin imports de viem) testeada de forma aislada. La lógica: si `CDP_FACILITATOR_URL` está seteado Y `chainKey.startsWith('base-')` → retornar `CDP_FACILITATOR_URL`; en cualquier otro caso retornar la URL existente del adapter (`adapter.getNetwork()` o env var del adapter correspondiente). NO modificar la interfaz `PaymentAdapter`.
- DT-4: Bazaar middleware se monta en `src/routes/agent-card.ts` como Fastify plugin condicional, evaluado en request-time (no en boot-time). Esto permite que el server bootee sin `CDP_FACILITATOR_URL` y sin Base chains activas.
- DT-5: `@x402/extensions/bazaar` se pina con versión exacta (ej. `"1.0.0"`) en `package.json`. Si la versión exacta en npm no existe al momento de la implementación, el Architect debe resolver en F2 buscando el semver publicado real en `npmjs.com/package/@x402/extensions`.
- DT-6: Los campos `inputSchema` / `outputSchema` en el Agent Card son extensiones NO-BREAKING al objeto A2A spec existente. El shape del `AgentCard` interface en `types/index.ts` se extiende con `inputSchema?: Record<string, unknown>` y `outputSchema?: Record<string, unknown>` (los campos son opcionales y los consumers que no los entienden los ignoran).

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO montar Bazaar middleware sin `discoverable: true` explícito en el manifest del agente. Default opt-out es inviolable — ningún agente debe ser indexado sin consentimiento explícito del dev.
- CD-2: PROHIBIDO hardcodear la URL del CDP Facilitator. Debe venir exclusivamente de `CDP_FACILITATOR_URL` env var.
- CD-3: OBLIGATORIO pinear `@x402/extensions/bazaar` con versión exacta sin caret (e.g. `"1.0.0"`, NO `"^1.0.0"`).
- CD-4: Tests E2E que requieran `CDP_API_KEY` real DEBEN marcarse con `it.skip` o `describe.skipIf(process.env.CDP_API_KEY)` en la suite principal. Solo corren en CI manual.
- CD-5: PROHIBIDO modificar el comportamiento de settle en Kite ni Avalanche. El selector CDP es exclusivamente para `chainKey.startsWith('base-')`.
- CD-6: OBLIGATORIO que la función `selectFacilitatorUrl` sea pura (sin side-effects, sin imports de viem, sin estado global). Los tests no deben mockear env vars globales — recibe los valores como parámetros.
- CD-7: La validación de JSON Schema en `buildAgentCard()` DEBE ocurrir antes de serializar la response. Si el schema es inválido y `discoverable: true`, la request DEBE fallar con 422 (no silenciosamente retornar la card sin schemas).
- CD-8: PROHIBIDO usar `any` explícito en los tipos nuevos. Los schemas son `Record<string, unknown>` hasta que haya un tipo JSON Schema tipado en el proyecto.

## Missing Inputs

- [RESUELTO POR ORQUESTADOR 2026-05-19] `@x402/extensions/bazaar` NO es un paquete standalone — es un **subpath de `@x402/extensions`**. Verificación en npm:
  - `@x402/extensions` v2.12.0 (publicado 2026-05-13 por Coinbase, mantenedores `erik_cb carsonroscoe_cb`) — **ÉSTE es el paquete a instalar**
  - Import path: `import { ... } from '@x402/extensions/bazaar'` (subpath del package)
  - Pin a versión exacta: `"@x402/extensions": "2.12.0"` (sin caret per CD-3)
  - Paquetes relacionados (NO instalar): `@x402/core@2.12.0` (transitive via @x402/extensions), `@coinbase/x402@2.1.0` (legacy)
  - El Dev DEBE verificar el shape del export con `npm view @x402/extensions exports` antes de codear el wire-up del middleware. Si el subpath `bazaar` no es accesible directamente, fallback a `import { bazaar } from '@x402/extensions'` o lo que la API real exponga.
- [BLOQUEANTE] BASE-01 (WKH-104) debe estar mergeado a `feat/wkh-base-port-v1` antes de que el selector CDP tenga un adapter real de Base para delegar. Los stubs de esta HU compilan pero el path de Base settle permanece `NOT_IMPLEMENTED` hasta que BASE-01 aterrice.
- [RESUELTO] Selector logic: vive en `src/lib/cdp-selector.ts`, no en el adapter, para evitar acoplamiento con la interfaz `PaymentAdapter`.
- [RESUELTO] Schema validation library: AJV vía `@fastify/ajv-compiler` transitiva — no agrega dep nueva.

## Análisis de paralelismo

- BLOQUEADO POR: WKH-104 (BASE-01) — el adapter Base debe existir para que el selector CDP tenga algo a delegar. Esta HU puede avanzar en paralelo en cuanto a agent-card enrichment y schema validation, pero el path de settle sobre Base queda como stub `NOT_IMPLEMENTED`.
- INDEPENDIENTE DE: WKH-105 (BASE-02 — self-hosted facilitator). Bazaar usa CDP Facilitator, no el self-hosted.
- INDEPENDIENTE DE: WKH-107, WKH-108 (si existen en el batch).
- Esta HU NO bloquea ninguna HU conocida actualmente.
- Orden recomendado de merge: WKH-104 → WKH-106 → WKH-105 (WKH-105 independiente pero conveniente mergear después de WKH-106 para que los tests del selector Base vean el adapter completo).

## Riesgos

- R-1 (ALTO): `@x402/extensions/bazaar` puede no estar publicado en npm o tener una API incompatible con la documentación. Mitigación: el Architect verifica el paquete en F2; si no existe, degradar a SPIKE.
- R-2 (MEDIO): El selector CDP mal implementado podría afectar el path de Kite/Avalanche si la condición `startsWith('base-')` tiene un bug. Mitigación: CD-5 + tests unitarios del selector con todos los ChainKey values explícitos.
- R-3 (BAJO): La URL pública del staging service (requerida para que CDP Facilitator haga callbacks) puede no estar disponible en el momento del test de integración. Mitigación: CD-4 (skip en CI automático); la validación E2E es manual.
- R-4 (BAJO): AJV meta-schema draft-7 puede estar a una versión distinta entre la instancia de Fastify y la que queremos usar para validación de manifests. Mitigación: usar `new Ajv({ strict: false })` con el meta-schema importado del paquete `ajv` directamente, no del compilador de Fastify.

## Skills Router

- `payment-adapter` — selector CDP vs wasiai-facilitator, integrate Bazaar SDK settle path
- `api-design` — agent-card schema extension, JSON Schema validation, manifest opt-in flag
