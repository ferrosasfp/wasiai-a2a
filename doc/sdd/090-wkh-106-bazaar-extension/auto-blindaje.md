# Auto-Blindaje — WKH-106 BASE-03 Bazaar Discovery Extension

Errores y desviaciones detectadas durante F3 (Implementation). Cada entrada
registra causa raíz + fix + dónde más aplicar el aprendizaje.

---

### [2026-05-19 W0] API real de `@x402/extensions/bazaar` NO es Fastify middleware

- **Error**: el work-item asumía que `@x402/extensions/bazaar` exponía un
  middleware Fastify que se monta condicionalmente en la ruta de agent-card
  (`fastify.register(bazaarMiddleware, { prefix: '/agents/:slug' })`).
- **Causa raíz**: el subpath `./bazaar` exporta:
  - `declareDiscoveryExtension(config)` — builder puro que dado
    `{ method, input, inputSchema, bodyType, output }` retorna
    `Record<string, DiscoveryExtension>` con `info` + `schema`.
  - `validateDiscoveryExtension(extension)` — valida la `info` contra el
    schema del extension.
  - `validateAndExtract(extension)` — combina validar + extraer.
  - `bazaarResourceServerExtension` — objeto de tipo `ResourceServerExtension`
    (NO un plugin Fastify; es un descriptor para servidores x402 que sirven
    402 Payment Required).
  - `withBazaar(client)` — extensor de `HTTPFacilitatorClient` para listar /
    buscar recursos en el CDP catalog.
  - Helpers de sanitización: `sanitizeResourceServiceMetadata`,
    `sanitizeTags`, `isValidIconUrl`, etc.

  Tipos de schema: `$schema: "https://json-schema.org/draft/2020-12/schema"`
  (NO draft-7). El work-item DT-1 menciona draft-7; ajustamos a draft-2020-12
  porque ese es el meta-schema que el SDK valida internamente.

- **Fix** (re-interpretación del scope):
  1. **No-op para mount-middleware approach**: NO se monta nada en
     `src/routes/agent-card.ts`. AC-3 / AC-6 se cumplen serializando los
     campos `inputSchema` / `outputSchema` en la response JSON del agent-card
     SOLO cuando `agent.metadata.discoverable === true` (opt-in CD-1).
  2. **Validación en `buildAgentCard`**: usamos `declareDiscoveryExtension`
     del SDK para validar que el shape de `inputSchema` declarado en el
     manifest sea consistente con la spec Bazaar (AC-4 / CD-7). Si falla,
     se lanza `BazaarSchemaError` que el route handler mapea a 422.
  3. **`src/lib/bazaar.ts`** queda como factory que envuelve
     `declareDiscoveryExtension` + `validateDiscoveryExtension` para encapsular
     el SDK y permitir tests sin recargar el módulo.
  4. **Selector CDP (`selectFacilitatorUrl`)** sigue como lo plantea DT-3 —
     función pura sin acoplamiento con el SDK.

- **Aplicar en**:
  - AR/CR: verificar que NO existe `fastify.register(bazaarMiddleware, ...)`
    en `src/routes/agent-card.ts` (el work-item asume eso pero la API real
    no expone un plugin Fastify).
  - Si en el futuro Coinbase publica un middleware Fastify oficial, este
    refactor se puede revisitar.

---

### [2026-05-19 W0] AJV meta-schema — draft-7 vs draft-2020-12

- **Error**: work-item DT-1 dice "meta-schema draft-7". El SDK Bazaar usa
  `$schema: "https://json-schema.org/draft/2020-12/schema"`.
- **Causa raíz**: documentación del work-item desactualizada respecto del
  release real del SDK (v2.12.0).
- **Fix**: el constructor de AJV usa `new Ajv({ strict: false, allErrors: true })`
  sin forzar meta-schema específico. AJV v8 acepta múltiples drafts y el
  campo `$schema` en el manifest del agente determina qué validator usar.
  Para validación local de los schemas declarados en el manifest, usamos
  `declareDiscoveryExtension` del SDK (que ya bake-in la regla "draft-2020-12
  para el envelope") + AJV plano para validar las sub-propiedades
  `inputSchema`/`outputSchema` declaradas por el dev.

  Si el manifest declara `inputSchema` con `$schema: draft-07`, AJV lo
  acepta — la decisión del meta-schema es del dev del agente, no de
  wasiai-a2a. Solo verificamos que el campo es un objeto JSON Schema
  syntactically-válido (vía `ajv.compile()` no falle).

- **Aplicar en**: cualquier consumer futuro de schemas declarados en
  manifests — no asumir draft-7 hardcoded.

---

### [2026-05-19 W0] WKH-104 ya completó parte del Scope IN

- **Observación (no es error)**: WKH-104 mergeó previamente (commits
  3b4ab0d, 2a07542, f9ce6ce, 8793306) los items:
  - `src/adapters/types.ts` ya incluye `'base-mainnet'` y `'base-sepolia'`
    en la union `ChainKey`.
  - `src/adapters/chain-resolver.ts` ya tiene aliases para Base.
  - `src/adapters/registry.ts` ya despacha `createBaseAdapters`.
- **Acción**: NO duplicar ese trabajo en WKH-106. El scope efectivo se
  reduce a Bazaar + selector + agent-card enrichment.
- **Aplicar en**: orquestador debe limpiar el Scope IN del work-item en
  futuras HUs si hay overlap entre HUs concurrentes en la misma branch
  compartida.
