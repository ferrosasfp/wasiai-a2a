# Auto-Blindaje — WKH-6

## Error #1 — Tipo inexistente en Fastify

**Wave:** 0  
**Archivo:** `src/middleware/x402.ts`  
**Error:** `TS2724: '"fastify"' has no exported member named 'FastifyPreHandlerHookHandler'`  
**Causa:** El Story File importa `FastifyPreHandlerHookHandler` desde `'fastify'`, pero ese tipo no existe. El tipo correcto es `preHandlerHookHandler`.  
**Corrección mínima aplicada:** Reemplazar `FastifyPreHandlerHookHandler` por `preHandlerHookHandler` en el import y en las declaraciones de tipo.  
**Impacto:** Corrección de nombre de tipo — cero impacto en lógica de negocio.
