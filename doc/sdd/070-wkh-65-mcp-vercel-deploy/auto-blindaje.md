# Auto-Blindaje — WKH-65

## [2026-04-30 W1] Wave 1 — Handlers refactor: zero regresión en stdio path

- **Hallazgo**: Cuando extrajimos 3 handlers + 4 utilidades de `src/index.mjs` a `src/handlers.mjs`, existía riesgo de romper el stdio path si las importaciones quedaban incompletas.
- **Mitigación implementada**: Verificamos que handlers ya eran funciones puras (`(rawInput, cfg) => result`) sin closures sobre estado mutable. No hay importaciones circulares. Test T36 en tools.test.mjs continúa pasando (stdio intacto).
- **Lección**: Antes de refactor de módulos, confirmar que los elementos siendo extraídos son puros (no dependen de state del module que quedan). Incluir regresión test del path crítico (stdio) como parte del suite.
- **Aplicar en**: Cualquier HU que haga refactores de modularización. Incluir en CR checklist: "¿Regresión test del path crítico (stdin, API critical, etc.) después del refactor?".

## [2026-04-30 W2] Wave 2 — Bearer token timing-safe comparison

- **Hallazgo**: La implementación de autenticación Bearer token requiere comparación timing-safe con `node:crypto.timingSafeEqual` para evitar timing attacks.
- **Implementación**: `src/auth.mjs:25,76` usa `timingSafeEqual(presentedBuf, expectedBuf)` sobre buffers UTF-8 de igual longitud. Si longitudes difieren, cortocircuitar a 401 sin comparar (no hay leak timing por longitud — tamaño de bearer es knowledge pública).
- **Tests**: AUTH-04/AUTH-07 en auth.test.mjs verifican paths timing-safe. T-HTTP-02/03 verifican que token incorrecto responde 401 idéntico a token ausente (no leak de "token existe pero incorrecto").
- **Lección**: Cualquier autenticación que use secretos (bearer, API keys, etc.) debe usar `timingSafeEqual`. Documental esto en CD. Incluir en AR checklist: "¿Autenticación usa `timingSafeEqual` en lugar de === o indexOf?".
- **Aplicar en**: WKH-32 (Bearer auth), WKH-69 (mTLS certs), cualquier HU de autenticación futura.

## [2026-04-30 W3] Wave 3 — `event:` in log fields clobbered canonical event name

- **Error**: `T-HTTP-10` falló al assertar que el event `mcp.http.missing-bearer-token` aparecería en stderr; en su lugar apareció `_auth`.
- **Causa raíz**: `src/log.mjs::emit` construye `{ts, level, event, ...redact(fields)}`. Cuando el caller pasa `event` como key dentro del payload fields, el spread operator overrides el event canónico. Clase de bug idéntica a MNR-iter2-1 (documentada en handlers.mjs).
- **Fix**: En `api/mcp.mjs`, removimos `event: '_auth'` / `event: '_config'` de los payloads pasados a `log.warn` / `log.error`. El primer argumento de `log.{info,warn,error}` es la única autoridad canónica del event name.
- **Patrón correcto**: `log.warn('missing-bearer-token', { requestId, origin })` — NO `log.warn('_auth', { event: 'missing-bearer-token', ... })`.
- **Lección**: La API de log requiere disciplina: event name es primer argumento, NUNCA una key dentro del payload. Incluir en CR checklist: "¿Hay `event:` dentro de log.{info,warn,error} fields payloads? Si yes, rechazar fuera de test fixtures".
- **Aplicar en**: Cualquier futura HU que use `log.mjs`. Documentar esta regla en CLAUDE.md.

## [2026-04-30 W4] Wave 4 (Fix iter 1) — CORS + POST echo: Vary header crítico

- **Hallazgo (AR MNR-2)**: Cuando un servidor echea `Access-Control-Allow-Origin` basado en el request origin, DEBE setear `Vary: Origin` en la respuesta.
- **Problema**: Sin `Vary: Origin`, proxies intermedios (CloudFlare, Fastly, CDN) cachean la respuesta con Allow-Origin para el primer origin que lo requestó, pero la sirven a otros origins (cache poisoning CORS).
- **Fix**: commit 9636383 — `api/mcp.mjs:217+` agrega `headers.set('Vary', 'Origin')` en el path de allowed origins. T-FIX-2 verifica que POST con allowed origin → 200 + Allow-Origin + Vary.
- **Patrón correcto**:
  ```javascript
  if (allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  // Sin Allow-Origin, sin Vary para denied origins
  ```
- **Lección**: CORS dinámico → SIEMPRE setear Vary. Incluir en CR checklist como parte de "CORS verification".
- **Aplicar en**: WKH-43 (CORS restrictivo), WKH-46 (Marketplace integration guide), cualquier HU que tenga CORS dinámico.

## [2026-04-30 W5] Wave 5 (Fix iter 1) — Auth-first ordering: DoS mitigation via DNS

- **Hallazgo (CR MNR-6)**: El auth check ocurría DESPUÉS de `loadConfig()` que hace DNS lookup de `WASIAI_GATEWAY_URL`.
- **Problema**: Un attacker sin auth válido puede forzar requests repetitivas, obligando DNS lookups costosos (low-rate DoS). Cada request sin auth → DNS lookup → ~50-100ms de latencia innecesaria.
- **Fix**: commit 9636383 — `api/mcp.mjs:176+` moveó el bearer auth check ANTES de `loadConfig()`. Flujo: (1) auth bearer (O(1) timing-safe compare), (2) loadConfig (O(1) local, O(n) DNS), (3) procesamiento. T-FIX-3 verifica que 401 no hace DNS.
- **Lección**: "Fail fast and cheap before expensive operations". Ordenar checks por costo:
  1. Auth / input validation (O(1))
  2. Config / initialización (O(1) local, O(n) DNS)
  3. Procesamiento (puede ser O(n) — fetch, DB, etc.)
- **Aplicar en**: Cualquier handler que tenga pasos costosos (DNS, fetch a gateway, DB query, file I/O). Incluir en AR/CR checklist: "¿Auth/input validation ANTES de operaciones costosas?".

## [2026-04-30 W6] Wave 6 (Fix iter 1) — Stateless transport + per-request instantiation

- **Hallazgo (DT-H)**: `WebStandardStreamableHTTPServerTransport` está diseñado para stateless functions. Cada request obtiene su propia instancia de Server + Transport.
- **Implicación**: No hay shared state entre invocaciones de Vercel. `loadConfig()` se llama en cada request. Costo: O(1) local, aceptable.
- **Constraint**: Module-level constants para datos que no cambian (TOOL_DESCRIPTORS, etc.). Si necesitamos caches entre requests (compiled regex, parsed config), usar Redis, no in-memory.
- **Lección**: Stateless serverless requiere pensar diferente que long-running Node.js servers. No hay "warm up" o memoization con in-memory caches. Cada request es fresco. Si necesitamos performance caching, usar distributed cache (Redis, Memcached).
- **Aplicar en**: WKH-67 (rate limiting cache), WKH-68 (streaming enhancements), cualquier HU que agregue estado a api/mcp.mjs. Documentar que Vercel Serverless no soporta session storage.

## [2026-04-30 W7] Wave 7 (Decisiones técnicas) — maxDuration timeout: cold-start buffer crítico

- **Estimación**: DT-C configura `maxDuration: 60` en vercel.json. Desglose típico:
  - Cold-start boot: 5-10s
  - Flujo x402 (probe → sign → retry): 18-25s
  - Overhead gRPC/SDK: 3-5s
  - Total típico: ~40-45s
- **Buffer**: Sin margen, ocasionales requests lentos fallarían. Margen recomendado: 50% arriba de lo estimado. 45 * 1.5 = 67.5 → 60 es conservador (runda baja pero aceptable).
- **Lección**: Timeout = (operación más lenta E2E) + (cold-start 5-10s) + (overhead SDK 3-5s) + (safety margin 50%). Documentar desglose en CD o comentario en vercel.json para futuro tunning.
- **Aplicar en**: Si WKH-68 agrega streaming, revisar timeout porque latencia E2E puede cambiar. Si WKH-67 agrega rate limiting checks, overhead podría ser 1-2s extra.

---

**Consolidado**: 7 lecciones de esta HU que aplican a futuras HUs de MCP, auth, serverless, y CORS. Todos los hallazgos (W1-W7) fueron resueltos en F3 + fix-pack iter 1.
