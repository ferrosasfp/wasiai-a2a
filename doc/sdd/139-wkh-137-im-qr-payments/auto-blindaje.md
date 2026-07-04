# Auto-Blindaje — WKH-137 (Invocation Links)

### [2026-07-04] Wave 2 — Fastify route generic con options object
- **Error**: `TS2345: Argument of type ... is not assignable to RouteHandlerMethod`
  al anotar el handler inline (`req: FastifyRequest<{Params; Body}>`) en una ruta
  que tiene un objeto de opciones (`{ config, preHandler }`) como 2º argumento.
- **Causa raíz**: con `exactOptionalPropertyTypes:true`, Fastify infiere
  `RouteGenericInterface` (params/body = `unknown`) desde la firma con options y
  colisiona con la anotación inline del handler (params concretos).
- **Fix**: mover el genérico al call `fastify.post<{ Params; Body }>(path, opts, handler)`
  y dejar el handler sin anotación (`async (req, reply) => ...`). En rutas SIN
  options (mint) la anotación inline funciona.
- **Aplicar en**: cualquier ruta nueva con `preHandler`/`config` + params/body tipados.
