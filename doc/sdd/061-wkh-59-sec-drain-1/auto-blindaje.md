# Auto-Blindaje — WKH-59 / SEC-DRAIN-1

Errores cometidos durante la implementación y cómo se corrigieron, para
prevenir su repetición en futuras HUs.

---

### [2026-04-27 21:31] W4 — Inline route handlers sin tipo explícito de FastifyRequest/FastifyReply

- **Error**: Al agregar rutas auxiliares de test (`/test-legacy`,
  `/test-gasless-mw`) en `src/middleware/a2a-key.test.ts`, los handlers
  inline (`async (_req, reply) => ...`) y el preHandler inline
  (`async (req) => { req.gaslessEstimatedCostUsd = 5; }`) generaron 5
  errores TS7006 (implicit any) bajo `tsc --noEmit`. Los tests corrían
  igual (vitest no enforcea strict en runtime), pero el `npx tsc
  --noEmit` rompía → violación de DoD §8.
- **Causa raíz**: Cuando una ruta Fastify se define DENTRO de otro
  `describe` y NO está dentro del flujo de inferencia normal de un
  plugin tipado (`FastifyPluginAsync`), TypeScript no puede inferir los
  tipos de los parámetros del handler/preHandler. `tsconfig.json` tiene
  `strict: true` + `noImplicitAny: true`. La inferencia funcionaba en
  los tests de `gasless.test.ts` porque el plugin `gaslessRoutes` ya
  está tipado como `FastifyPluginAsync`, pero al definir rutas
  directamente sobre `Fastify()` en un test, hay que anotar los params.
- **Fix**: anotar explícitamente cada handler/preHandler inline con
  `(req: FastifyRequest, reply: FastifyReply)` o
  `(req: FastifyRequest)` cuando solo se usa request. Los imports
  `FastifyRequest`/`FastifyReply` ya estaban presentes en el archivo.
- **Aplicar en**: cualquier futuro test que registre rutas Fastify
  directamente con `app.post(url, opts, handler)` fuera de un plugin —
  anotar `req`/`reply` explícitamente. Mismo principio aplica si un
  preHandler array contiene funciones inline.
