# Work Item — [WKH-SEC-01] Security Hardening — HSTS + CORS restrictivo + requireAuth en /registries

## Resumen

Tres vulnerabilidades de seguridad detectadas en auditoría del 2026-04-20 que quedaron pendientes del trabajo del 2026-04-12. Se requiere: (1) proteger los endpoints de escritura de `/registries` con el middleware de autenticación `a2a-key` ya existente, (2) reemplazar el CORS wildcard `*` por una configuración env-aware que en producción solo permita origins declarados explícitamente, y (3) agregar el header `Strict-Transport-Security` al middleware de security headers existente. Los patrones y el middleware de auth ya existen en el codebase — esta HU aplica lo que ya está construido donde falta.

## Sizing

- SDD_MODE: mini
- Estimación: S
- Branch sugerido: `feat/043-wkh-sec-01-hardening`
- Pipeline: QUALITY (toca superficie de auth + CORS — no aplica FAST aunque el esfuerzo sea bajo)

## Skills Router

- `security-hardening` — auth middleware, CORS policy, security headers HTTP
- `fastify-middleware` — integración de preHandler hooks en rutas Fastify existentes

## Acceptance Criteria (EARS)

- **AC-1**: WHEN a `POST /registries` request arrives without a valid `x-a2a-key` header or a valid `Authorization: Bearer wasi_a2a_*` token, the system SHALL respond with HTTP 401 or 403 and reject the request before executing any business logic.

- **AC-2**: WHEN a `DELETE /registries/:id` request arrives without a valid `x-a2a-key` header or a valid `Authorization: Bearer wasi_a2a_*` token, the system SHALL respond with HTTP 401 or 403 and reject the request before executing any business logic.

- **AC-3**: WHEN the server sends any HTTP response, the system SHALL include the header `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`.

- **AC-4**: WHILE `NODE_ENV=production` and `CORS_ALLOWED_ORIGINS` is set, the system SHALL reject CORS preflight and cross-origin requests from origins not listed in `CORS_ALLOWED_ORIGINS` — the `Access-Control-Allow-Origin` header SHALL NOT be set to `*`.

- **AC-5**: WHILE `NODE_ENV=development` (or `NODE_ENV` is absent), the system SHALL allow all origins (`*`) for CORS to facilitate local development and testing.

- **AC-6**: WHILE `NODE_ENV=production` and `CORS_ALLOWED_ORIGINS` is not set, the system SHALL default to blocking all cross-origin requests (no wildcard fallback) and log a warning at startup.

- **AC-7**: IF the total test suite is run after the changes, THEN the system SHALL have all previously passing tests continue to pass, and the new tests covering AC-1 through AC-6 SHALL pass.

## Scope IN

| Archivo | Cambio |
|---------|--------|
| `src/routes/registries.ts` | Agregar `preHandler: requirePaymentOrA2AKey(...)` en `POST /` y `DELETE /:id` |
| `src/index.ts` (línea ~36) | Reemplazar `cors({ origin: '*' })` por configuración env-aware leyendo `CORS_ALLOWED_ORIGINS` |
| `src/middleware/security-headers.ts` | Agregar header `Strict-Transport-Security` en el hook `onSend` existente |
| `src/middleware/security-headers.test.ts` | Agregar test AC-3 (HSTS header presente) |
| `src/routes/registries.test.ts` (nuevo) | Tests AC-1 y AC-2: POST y DELETE sin auth → 401/403 |
| `src/__tests__/cors.test.ts` (nuevo) | Tests AC-4 y AC-5: CORS prod vs dev behavior |
| `.env.example` | Documentar variable `CORS_ALLOWED_ORIGINS` con descripción y ejemplo |

## Scope OUT

- `src/middleware/a2a-key.ts` — NO modificar. La firma del middleware se usa tal como está. Timing-safe compare es otra HU.
- `src/routes/compose.ts` y `src/routes/orchestrate.ts` — ya tienen auth, no tocar.
- `src/mcp/` — fuera de scope de esta HU.
- `GET /registries` y `GET /registries/:id` — endpoints de lectura permanecen públicos (no requieren auth).
- `PATCH /registries/:id` — [NEEDS CLARIFICATION]: el humano no mencionó este endpoint en el scope. Queda fuera hasta recibir confirmación explícita.
- Refactoring de cualquier middleware existente.
- Certificados TLS / configuración de reverse proxy (HSTS solo a nivel de header HTTP).

## Decisiones técnicas

- **DT-1**: Reutilizar `requirePaymentOrA2AKey` de `src/middleware/a2a-key.ts` sin modificarlo. Patrón idéntico a cómo lo usan `/compose` y `/orchestrate`. No duplicar lógica de auth.
- **DT-2**: El valor de HSTS se declara como constante string en `security-headers.ts` (no env var). `max-age=31536000; includeSubDomains; preload` es el valor estándar de producción — no tiene variantes legítimas por entorno.
- **DT-3**: La lista de origins CORS se lee de `CORS_ALLOWED_ORIGINS` como string con separador coma (e.g., `https://app.wasiai.io,https://wasiai.io`). `@fastify/cors` acepta un array de strings — se hace `split(',').map(s => s.trim())` en la inicialización.
- **DT-4**: En producción sin `CORS_ALLOWED_ORIGINS`, denegar todos los orígenes (no fallback a `*`). Comportamiento fail-secure. Se loguea `warn` al startup para alertar al operador.
- **DT-5**: La configuración CORS se inicializa en `src/index.ts` en el momento del `fastify.register(cors, ...)` — no en un archivo de config separado. Scope de cambio mínimo.

## Constraint Directives

- **CD-1**: PROHIBIDO modificar la firma de `requirePaymentOrA2AKey` ni su comportamiento interno. El middleware se usa como import, no se altera.
- **CD-2**: OBLIGATORIO mantener `GET /registries` y `GET /registries/:id` sin autenticación — son endpoints de lectura pública.
- **CD-3**: PROHIBIDO hardcodear origins CORS. OBLIGATORIO leerlos desde `CORS_ALLOWED_ORIGINS` env var.
- **CD-4**: OBLIGATORIO que los 276+ tests existentes pasen sin modificación. Si algún test unitario de registries asume que POST/DELETE son sin auth, el Dev DEBE actualizar esos tests para proveer credenciales válidas (mockeadas).
- **CD-5**: PROHIBIDO usar `any` explícito en TypeScript en el código nuevo (regla global del proyecto).
- **CD-6**: El header HSTS SOLO se debe emitir cuando la conexión es HTTPS, o la lógica puede emitirlo siempre (el reverse proxy en producción termina TLS). [NEEDS CLARIFICATION]: el humano especificó "agregar el header" sin condición de transport. Se asume emisión incondicional dado que el reverse proxy de producción maneja TLS, pero el Architect puede refinar en F2.

## Missing Inputs

- [NEEDS CLARIFICATION] `PATCH /registries/:id` — ¿también requiere auth? No fue mencionado explícitamente en el scope de la HU. Queda fuera hasta confirmación.
- [NEEDS CLARIFICATION] CD-6 — emisión condicional de HSTS según X-Forwarded-Proto vs emisión siempre. Decisión delegada a Architect en F2.
- [resuelto en F2] Parámetros exactos de `requirePaymentOrA2AKey` para el contexto de registries (qué `PaymentMiddlewareOptions` pasar si el endpoint no cobra nada).

## Análisis de paralelismo

Los tres fixes tocan archivos distintos y son independientes entre sí:

| Fix | Archivos tocados | Puede ir en paralelo con |
|-----|-----------------|--------------------------|
| Auth en /registries | `src/routes/registries.ts` | Fix 2 y Fix 3 |
| CORS env-aware | `src/index.ts` | Fix 1 y Fix 3 |
| HSTS header | `src/middleware/security-headers.ts` | Fix 1 y Fix 2 |

Sin embargo, dado que el SDD_MODE es `mini` y la estimación es S, el Dev puede implementar los tres en secuencia en la misma wave sin overhead de coordinación. El Architect decide en F2 si conviene una o tres waves.

Esta HU no bloquea otras HUs en curso (025, 026, 029, 037 no tocan los mismos archivos), y no tiene dependencias sobre ninguna HU en progress.

---

*Generado por nexus-analyst | 2026-04-20 | WKH-SEC-01*
