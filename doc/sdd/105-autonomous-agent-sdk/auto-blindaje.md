# Auto-Blindaje — WKH-105 (Autonomous Agent SDK)

### [2026-05-31 19:38] Wave 6 — Mock `writeContract` compartido entre provision y mint
- **Error**: en `identity.test.ts`, AC-4 leía `writeContract.mock.calls[0]` esperando el call del mint, y AC-5 asertaba `writeContract` con `not.toHaveBeenCalled()`. Ambos fallaban.
- **Causa raíz**: `provision()` (precondición del mint, porque setea `#key`) usa el MISMO `walletClient.writeContract` para el `transfer` ERC-20. Por eso `calls[0]` es el transfer, no el `register`, y en el caso gate-OFF el spy ya tenía 1 llamada (el transfer).
- **Fix**: aislar el call relevante por `functionName` — `calls.find(c => c.functionName === 'register')` para AC-4; `filter(... === 'register')` con `toHaveLength(0)` para AC-5.
- **Aplicar en**: cualquier test que comparta un mock de `writeContract`/`writeContract`-like entre dos pasos del flujo (provision + mint, o futuras combinaciones). No asumir índice posicional; filtrar por `functionName`/`address`.

### [2026-06-01 02:30] Fix-pack — `error_code` vive en `cause` no-enumerable del OperationError
- **Error**: el retry de deposit necesita leer `error_code` para decidir reintentar vs fallar, pero `OperationError` NO expone `error_code` como campo propio.
- **Causa raíz**: `A2AClient.#mapError` guarda el body crudo del server (que contiene `error_code`) en `cause`, definido como **no-enumerable** (anti-leak CD-11). No aparece en `JSON.stringify`, pero SÍ es accesible por property access (`err.cause`).
- **Fix**: helper `depositErrorCode(err)` que verifica `instanceof OperationError`, lee `err.cause` (object), y extrae `error_code` solo si es string. No loguea ni serializa el body completo.
- **Aplicar en**: cualquier lógica futura que necesite ramificar por `error_code` del server desde un error del SDK → leer `cause.error_code` por acceso directo, NUNCA esperar un campo enumerable ni serializar el body.

### [2026-06-01 02:31] Fix-pack — `/auth/me` devuelve `budget` (map por chainId), no `balance` escalar
- **Error**: tentación de leer `me.balance` tras `DEPOSIT_ALREADY_CREDITED`. No existe tal campo.
- **Causa raíz**: `GET /auth/me` (src/routes/auth.ts:514-534) devuelve `budget: Record<chainIdString, string>`, no un `balance` escalar. `POST /auth/deposit` SÍ devuelve `{ balance, chain_id }`, pero `/me` no.
- **Fix**: en el path ALREADY_CREDITED leer `me.budget?.[String(chainId)] ?? '0'` (mismo default '0' que `budgetService.getBalance`).
- **Aplicar en**: cualquier lectura de saldo vía `/auth/me` → indexar `budget` por `String(chainId)`, default `'0'`.
