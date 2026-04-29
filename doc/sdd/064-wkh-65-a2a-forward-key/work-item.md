# Work Item — [WKH-65] Forward-key middleware para llamadas internas v2 → wasiai-a2a

## Resumen

Se construye un middleware Fastify `requireForwardKey` que valida el header `x-wasiai-forward-key` con `timingSafeEqual` contra la env var `WASIAI_V2_FORWARD_KEY`. Se aplica en `/compose` y `/orchestrate` como capa de autenticación previa a `requirePaymentOrA2AKey`, habilitando que wasiai-v2 (convertido en thin proxy) pueda invocar wasiai-a2a desde Vercel con un shared secret, en defense-in-depth sobre el x-payment del cliente. El middleware es estrictamente opcional: si la env var no está seteada, no se monta y los clientes externos siguen operando sin cambio.

## Sizing

- SDD_MODE: mini
- Estimación: S
- Pipeline: FAST+AR (toca auth surface — adversarial review obligatorio para timing attacks + replay)
- Branch sugerido: `feat/064-wkh-65-a2a-forward-key`

## Skills relevantes

- `security-auth` — timing-safe comparison, env-gated middleware
- `fastify-middleware` — preHandler factory pattern (precedente en `a2a-key.ts`)

## Acceptance Criteria (EARS)

- AC-1: WHEN `WASIAI_V2_FORWARD_KEY` is not set in the environment, the system SHALL NOT mount the `requireForwardKey` middleware and all existing tests SHALL continue to pass without modification.
- AC-2: WHEN a request arrives at `/compose` or `/orchestrate` with a valid `x-wasiai-forward-key` header matching `WASIAI_V2_FORWARD_KEY` AND a valid payment/a2a-key credential, the system SHALL return 200 and process normally.
- AC-3: WHEN a request arrives with an `x-wasiai-forward-key` header whose value does NOT match `WASIAI_V2_FORWARD_KEY`, the system SHALL return 401 with error code `INVALID_FORWARD_KEY` using `timingSafeEqual` comparison with no information leak about the expected value.
- AC-4: WHEN `WASIAI_V2_FORWARD_KEY` is set and a request arrives WITHOUT the `x-wasiai-forward-key` header, the system SHALL pass through to the next middleware (`requirePaymentOrA2AKey`) without rejecting the request.
- AC-5: WHILE performing the `x-wasiai-forward-key` comparison, the system SHALL use `timingSafeEqual` from `node:crypto` with equal-length `Buffer` inputs, padding or short-circuiting safely when lengths differ WITHOUT throwing an exception.
- AC-6: WHEN `x-wasiai-source` header is present in a request, the system SHALL log its value via pino structured logger under a `forwardSource` field and SHALL NOT alter routing, response status, or any downstream behavior.
- AC-7: WHEN `TIMEOUT_COMPOSE_MS` is not set in the environment, the system SHALL use a default timeout of `180000` ms for the compose route, and the corresponding unit test SHALL verify this new default value.
- AC-8: WHEN the full test suite is executed, the system SHALL pass all 612 baseline tests PLUS a minimum of 4 new tests covering AC-1 (middleware not mounted), AC-3 (invalid key → 401 INVALID_FORWARD_KEY), AC-4 (missing header → passthrough), and AC-5 (length-safe timingSafeEqual behavior).

## Scope IN

| Archivo | Operación | Descripción |
|---------|-----------|-------------|
| `src/middleware/forward-key.ts` | NEW | Factory `requireForwardKey()` — env-gated, timingSafeEqual, pino logging de `x-wasiai-source` |
| `src/middleware/__tests__/forward-key.test.ts` | NEW | Tests: ≥4 cubriendo AC-1, AC-3, AC-4, AC-5 |
| `src/middleware/a2a-key.ts` | UPDATE | Agregar slot opcional para preHandler `requireForwardKey` antes de la lógica existente — sin romper API actual |
| `src/routes/compose.ts` | UPDATE | Wiring condicional: si env presente → prepend `requireForwardKey` handler al array `preHandler`; bump `TIMEOUT_COMPOSE_MS` default `120000` → `180000` |
| `src/routes/orchestrate.ts` | UPDATE | Wiring condicional: si env presente → prepend `requireForwardKey` handler al array `preHandler` |
| `.env.example` | UPDATE | Documentar `WASIAI_V2_FORWARD_KEY` (opcional) y nuevo default de `TIMEOUT_COMPOSE_MS` |

> Nota: `src/lib/env.ts` no existe como módulo standalone. La validación de env se hace inline en el middleware factory y en las rutas, siguiendo el patrón existente en `src/routes/compose.ts` (línea 26: `process.env.TIMEOUT_COMPOSE_MS ?? '120000'`).

## Scope OUT

- NO tocar `src/services/gasless*` ni adapters de gasless
- NO tocar `src/services/facilitator*` ni el facilitator client
- NO modificar la lógica interna de `requirePaymentOrA2AKey` (solo agregar slot opcional)
- NO agregar rate-limit nuevo
- NO refactorizar middlewares existentes
- NO tocar el lado wasiai-v2 (ese es un trabajo separado del migration plan)
- NO implementar replay protection (fuera de scope de esta HU — marcado como `[TBD]` para WKH futura si Fernando lo prioriza)

## Decisiones técnicas (DT-N)

- DT-1: **Forward-key middleware OPCIONAL** — si `WASIAI_V2_FORWARD_KEY` no está seteado en el entorno, el middleware NO se monta en ninguna ruta. Backward compat garantizada: los clientes externos siguen usando solo x-payment/x-a2a-key sin cambio alguno.
- DT-2: **`timingSafeEqual` con `node:crypto`** — hay precedente en `src/middleware/a2a-key.ts` (línea 8: `import crypto from 'node:crypto'`). Buffers de igual length: si los strings difieren en longitud, comparar el hash contra un buffer dummy del mismo tamaño para no revelar longitud mediante timing.
- DT-3: **Header `x-wasiai-source: v2-proxy` se loguea, no se valida** — logging con pino `request.log.info({ forwardSource })` para tracing pero sin efectos en routing ni en auth decisions.
- DT-4: **Orden de middlewares**: `requireForwardKey` (si activo) → `createTimeoutHandler` → `requirePaymentOrA2AKey`. El forward-key falla rápido antes de tocar la lógica de budget/payment.
- DT-5: **`TIMEOUT_COMPOSE_MS` default bump** `120000` → `180000` ms — el proxy añade latencia de red (Vercel → Railway). El override via env sigue funcionando para backward compat.

## Constraint Directives (CD-N)

- CD-1: OBLIGATORIO TypeScript strict — cero `any` explícito.
- CD-2: OBLIGATORIO que el middleware sea completamente inoperante cuando `WASIAI_V2_FORWARD_KEY` es `undefined` o string vacío — no montar, no validar, no loguear sobre la key.
- CD-3: OBLIGATORIO usar `crypto.timingSafeEqual` (no `===` ni `.equals()` directo sobre strings).
- CD-4: PROHIBIDO loguear el valor de `WASIAI_V2_FORWARD_KEY` ni el valor recibido en `x-wasiai-forward-key` en ningún nivel de log (error, warn, info, debug). Solo loguear el resultado booleano o el error code.
- CD-5: OBLIGATORIO que los tests cubran happy path + al menos 3 edge cases (key inválida, header ausente, comportamiento de longitud diferente en timingSafeEqual).
- CD-6: OBLIGATORIO mantener los 612 tests baseline pasando — ningún test existente puede romper.
- CD-7: PROHIBIDO añadir replay protection en esta HU — si se necesita, abrir nueva HU con análisis de nonce/timestamp window.

## Missing Inputs

- [resuelto en F2] Estrategia exacta para "length-safe timingSafeEqual": hash ambos lados (HMAC SHA-256) vs padding vs dummy buffer — el Architect decide en F2 basándose en las opciones documentadas en DT-2.
- [resuelto en F2] Ubicación exacta del wiring: si el slot en `a2a-key.ts` es el lugar correcto o si las rutas componen directamente — el Architect resuelve en SDD.
- [NEEDS CLARIFICATION] Replay protection: ¿WKH-65 debe incluir protección contra replay (e.g., `x-wasiai-nonce` + timestamp window)? El scope actual dice NO (CD-7), pero si Fernando requiere defensa adicional, esto cambia el sizing de FAST+AR a QUALITY.

## Análisis de paralelismo

- WKH-65 NO bloquea otras HUs de wasiai-a2a (es puramente aditiva, env-gated).
- WKH-65 ES prerequisito de la fase wasiai-v2 thin-proxy del migration plan (necesita que el endpoint esté listo antes de que v2 cambie sus rutas).
- Puede correr en paralelo con cualquier HU que no toque `src/routes/compose.ts` o `src/routes/orchestrate.ts`.
- No hay conflicto con las HUs in-progress del INDEX que operan sobre otros módulos.
