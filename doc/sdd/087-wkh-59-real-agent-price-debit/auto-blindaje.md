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
