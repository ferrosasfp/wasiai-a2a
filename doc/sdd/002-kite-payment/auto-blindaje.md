# Auto-Blindaje — WKH-6

## Error #1 — Tipo inexistente en Fastify

**Wave:** 0  
**Archivo:** `src/middleware/x402.ts`  
**Error:** `TS2724: '"fastify"' has no exported member named 'FastifyPreHandlerHookHandler'`  
**Causa:** El Story File importa `FastifyPreHandlerHookHandler` desde `'fastify'`, pero ese tipo no existe. El tipo correcto es `preHandlerHookHandler`.  
**Corrección mínima aplicada:** Reemplazar `FastifyPreHandlerHookHandler` por `preHandlerHookHandler` en el import y en las declaraciones de tipo.  
**Impacto:** Corrección de nombre de tipo — cero impacto en lógica de negocio.

## Error #2 — Generic no fluye con patrón options object en Fastify

**Wave:** 1  
**Archivos:** `src/routes/orchestrate.ts`, `src/routes/compose.ts`  
**Error:** `TS2345` — al pasar `{ preHandler, handler }` como options object separado, el generic del handler (`FastifyRequest<{ Body: ... }>`) no puede unificarse con `RouteHandlerMethod<RouteGenericInterface>`.  
**Causa:** El Story File usa el patrón `fastify.post('/', { preHandler }, async (request: FastifyRequest<Generic>, ...)` que en TypeScript strict no infiere el generic correctamente. El fix es mover el generic al nivel del `fastify.post<Generic>`.  
**Corrección mínima aplicada:** `fastify.post<{ Body: ... }>(...)` con handler tipado via `request.body` sin re-declarar el tipo del parámetro, compatible con Fastify v4/v5.  
**Impacto:** Cero impacto en lógica de negocio.

## Nota — Errores pre-existentes en main (fuera de scope WKH-6)

**Archivos afectados:** `src/services/discovery.ts`, `src/routes/registries.ts`  
**Confirmación:** Verificado con `git stash` — los mismos errores existen en `main` antes de cualquier cambio de WKH-6.  
**Causa probable:** Trabajo de WKH-7 (feat/wkh-7 — Supabase registry) que dejó `getAll()` retornando Promise en lugar de array, pero `discovery.ts` sigue usando el valor como si fuera síncrono.  
**Acción WKH-6:** NINGUNA. Story File prohíbe explícitamente tocar `src/services/discovery.ts` y `src/routes/registries.ts`. Estos errores son pre-existentes y deben resolverse en una story separada.  
**Impacto en WKH-6:** Los archivos creados/modificados por WKH-6 compilan sin errores propios.
