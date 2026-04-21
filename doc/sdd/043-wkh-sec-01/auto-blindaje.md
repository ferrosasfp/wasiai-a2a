# Auto-Blindaje — WKH-SEC-01 F3

### [2026-04-20 19:47] Wave 1 — Fastify route generics don't flow through when handler is 3rd arg with `{ preHandler }` options
- **Error**: `tsc --noEmit` produjo TS2345 en los 3 handlers (POST/PATCH/DELETE) de `src/routes/registries.ts` cuando agregué `{ preHandler }` como 2do argumento. La firma que infiere Fastify queda `RouteGenericInterface` (Body/Params como `unknown`), que no es asignable al `FastifyRequest<{ Body: {...} }>` que espera el handler.
- **Causa raíz**: `fastify.post('/', opts, async (request: FastifyRequest<{...}>, ...) => ...)` no propaga los generics. Hay que tiparlos en el método: `fastify.post<{ Body: ... }>(...)` — patrón ya usado en `src/routes/compose.ts:19`.
- **Fix**: Mover el generic al call de `fastify.post/patch/delete` y quitar el `FastifyRequest<{...}>` del handler (pasa a inferirse).
- **Aplicar en**: Cualquier ruta futura que mezcle `{ preHandler }` + tipado de Body/Params.
