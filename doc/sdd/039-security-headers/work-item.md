# Work Item — [WKH-QG-HEADERS] Security Headers (X-Content-Type-Options + X-Frame-Options)

## Resumen
Agregar dos security headers HTTP faltantes (`X-Content-Type-Options: nosniff` y `X-Frame-Options: DENY`) como hook global en el servidor Fastify. Detectado por nexus-doctors security scanner. No se instala ninguna dependencia adicional.

## Sizing
- SDD_MODE: fast
- Estimación: S
- Branch sugerido: feat/039-security-headers

## Acceptance Criteria (EARS)

- AC-1: WHEN any HTTP response is sent by the server, the system SHALL include the header `X-Content-Type-Options: nosniff`.
- AC-2: WHEN any HTTP response is sent by the server, the system SHALL include the header `X-Frame-Options: DENY`.
- AC-3: IF a vitest test sends a request to any endpoint (e.g. `/health`), THEN the test SHALL assert that both security headers are present in the response.

## Scope IN

- `src/middleware/security-headers.ts` — nuevo archivo con `registerSecurityHeaders(fastify)` usando `fastify.addHook('onSend', ...)`
- `src/middleware/security-headers.test.ts` — vitest: assert headers en respuesta a `/health`
- `src/index.ts` — importar y registrar `registerSecurityHeaders(fastify)` junto al resto de middleware

## Scope OUT

- NO instalar `@fastify/helmet` ni ninguna dependencia nueva
- NO modificar ninguna ruta existente individualmente
- NO tocar headers de CORS, CSP, HSTS u otros headers de seguridad fuera del scope declarado

## Decisiones técnicas

- DT-1: Hook `onSend` en lugar de plugin registrado — es suficiente para headers globales sin overhead de plugin lifecycle. Consistente con el patrón de `registerRequestIdHook` ya existente.
- DT-2: Dos headers fijos hardcodeados en el middleware (valores `nosniff` y `DENY` no son configurables) — son valores canónicos sin variantes válidas.

## Constraint Directives

- CD-1: PROHIBIDO instalar nuevas dependencias npm para esta HU.
- CD-2: OBLIGATORIO que el hook aplique a TODAS las respuestas, incluyendo errores 4xx/5xx.
- CD-3: OBLIGATORIO tener al menos 1 test con evidencia `archivo:línea` para AC-3.

## Missing Inputs

- Ninguno. HU es autosuficiente.
