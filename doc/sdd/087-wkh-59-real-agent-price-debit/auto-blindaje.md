# Auto-Blindaje — WKH-59 (real-agent-price-debit)

> Errores cometidos por el Dev durante F3 y cómo se corrigieron.
> Documento vivo durante la implementación.

---

### [2026-05-14 19:05] Wave W4 — Multi-step debit tests fall into invokeAgent x402 sign path

- **Error**: `T-COMPOSE-DEBIT-1..5` fallaron con `Step 0 failed: No payTo address...`. Los tests asumían que con `priceUsdc > 0` el flujo pasaba directo a `fetch(agent.invokeUrl)`.
- **Causa raíz**: `composeService.invokeAgent` ejecuta el código de firma x402 cuando `agent.priceUsdc > 0 && !a2aKey`. Sin pasar `a2aKey` en el `compose()` call, los tests entran al branch x402 y intentan firmar — falla por falta de `metadata.payTo`.
- **Fix**: pasar `a2aKey: 'wasi_a2a_test'` en cada `composeService.compose({...})` de los tests WKH-59. Esto refleja el flujo real: la ruta `/compose` ya propaga el header `x-a2a-key` al service como `a2aKey`. Cuando hay `a2aKey`, el service NO firma x402 (el middleware ya debitó).
- **Aplicar en**: cualquier test futuro de `composeService.compose` que use `priceUsdc > 0` debe pasar `a2aKey` o stubear `metadata.payTo` en el agent. Documentar el invariante en `composeService.compose` también: tests deben respetar la rama `!a2aKey` (path x402) vs rama `a2aKey` (path a2a-key/middleware-debited).

---

### [2026-05-14 19:10] ITER-2 BLQ-MED-1 — Fallback honesto solo en preHandler, faltaba en service

- **Error**: AR (iter-1) detectó que `src/services/compose.ts:127-146` debitaba `agent.priceUsdc` raw cuando `i > 0`. Cuando `priceUsdc === 0` (config error en registry) o `null`, el código NO aplicaba el fallback $1 + warn log requerido por AC-4 + CD-4. Solo el preHandler de step 0 (`src/routes/compose.ts:63-77`) tenía el fallback. Asimetría entre step 0 (protegido) y steps 2..N (vulnerables).
- **Causa raíz**: el diseño inicial del SDD W4 asumió que `agent.priceUsdc` siempre sería un number > 0 al llegar al service (post-discovery). En la práctica, mapAgent de discovery puede dejar `priceUsdc=0` cuando el registry expone precio mal-formado y el fallback de `resolvePriceWithFallback` no encuentra alternativa. El AC-4 cubría TODOS los steps, no solo step 0.
- **Fix**: replicar la lógica del preHandler dentro del service loop. Agregué `logger?: DownstreamLogger` opcional a `ComposeRequest` (reusando el tipo canónico de WKH-55) para emitir el warn log sin acoplar el service a Fastify. La ruta pasa `request.log` (Pino), estructuralmente compatible. Fallback a `console.warn` cuando logger no está. NO se puede setear el header `x-debit-fallback` desde el service (response ya en pipeline) — documentado explícitamente como limitación en código y en SDD DT-J.
- **Aplicar en**: cualquier futuro flow de debit per-step (e.g. `/orchestrate` cuando se porte el patrón) debe usar el mismo guard `isInvalid = typeof !== 'number' || === 0 || NaN` + warn log + fallback $1. NO confiar en que upstream (preHandler/middleware) ya validó el price — defensa en profundidad por step. Cuando un service necesita emitir logs estructurados sin acoplarse a Fastify, reusar `DownstreamLogger` (`{ warn, info }`) y aceptar `logger?` opcional en el Request type.

---
