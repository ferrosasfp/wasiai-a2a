# Auto-Blindaje — WKH-105 (Autonomous Agent SDK)

### [2026-05-31 19:38] Wave 6 — Mock `writeContract` compartido entre provision y mint
- **Error**: en `identity.test.ts`, AC-4 leía `writeContract.mock.calls[0]` esperando el call del mint, y AC-5 asertaba `writeContract` con `not.toHaveBeenCalled()`. Ambos fallaban.
- **Causa raíz**: `provision()` (precondición del mint, porque setea `#key`) usa el MISMO `walletClient.writeContract` para el `transfer` ERC-20. Por eso `calls[0]` es el transfer, no el `register`, y en el caso gate-OFF el spy ya tenía 1 llamada (el transfer).
- **Fix**: aislar el call relevante por `functionName` — `calls.find(c => c.functionName === 'register')` para AC-4; `filter(... === 'register')` con `toHaveLength(0)` para AC-5.
- **Aplicar en**: cualquier test que comparta un mock de `writeContract`/`writeContract`-like entre dos pasos del flujo (provision + mint, o futuras combinaciones). No asumir índice posicional; filtrar por `functionName`/`address`.
