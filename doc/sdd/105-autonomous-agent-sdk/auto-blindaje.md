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

---

## LECCIÓN CRÍTICA — Mocks NO detectan races on-chain (2026-05-31, E2E en vivo)

**Hallazgo**: La suite completa de 18 vitest tests (mockeados, sin red) pasó 100%, pero cuando se ejecutó el agente **en vivo contra prod** (Base Sepolia mainnet), **3 race conditions** bloquearon la provision y el mint:

1. **Deposit confirmation off-by-one lag**: `provision()` esperaba `min_confirmations` bloques client-side, pero el RPC del server rezagó 1 bloque → `INSUFFICIENT_CONFIRMATIONS`.
2. **Token visibility lag**: `mintIdentity()` llamaba bind inmediatamente tras mint on-chain, pero el RPC del server no vio aún el token → `ERC8004_TOKEN_NOT_FOUND`.
3. **Budget debit chain mismatch**: `operate()` no envió header `x-payment-chain`, servidor debitó de chain incorrecta → `INSUFFICIENT_BUDGET` pese a tener fondos.

**Causa raíz del gap de tests**:
- Mock `walletClient.writeContract`: devuelve `{hash, status:'success'}` inmediatamente, no simula confirmaciones reales.
- Mock `fetch`: devuelve `{balance: '100'}` en el body, no simula RPC lag ni timing real.
- Suite: no mockea `waitForTransactionReceipt` con lag (bloque N+1), ni servidor con `sleepMs` en RPC check.
- Resultado: tests PASS pero integración FALLA.

**Fix (4 commits, feat/105-deposit-retry)**:
- `306c2b6`: retry/backoff en deposit (6x5s), retry solo `INSUFFICIENT_CONFIRMATIONS`/`TX_NOT_FOUND`.
- `2b619e9`: retry/backoff en bind (6x5s), retry solo `ERC8004_TOKEN_NOT_FOUND`.
- `6402bce`: agregar header `x-payment-chain` en request (resolver chain correcta).
- `e0e210f`: agregar `RPC_UNAVAILABLE` como retryable (blips transitorios).

**Lección para próximas HUs** (especialmente on-chain):
1. **Mock con timing real**: Si hacés `waitForTransactionReceipt`, mockear con lag (sleep antes de retornar receipt).
2. **E2E en vivo para on-chain**: Tests unitarios son necesarios pero insuficientes. Validación POST-DONE contra testnet real es obligatoria.
3. **Retry/backoff es no-negotiable**: Todo lo que dependa de RPC o confirmaciones necesita retry con backoff exponencial + jitter. No asumir timing determinista.
4. **Header propagation**: Siempre documentá qué headers HTTP necesita el servidor para resolver contexto (chain, owner, etc.). Auto-test: `request()` agrega headers según config.

**Consolidación**: Esta lección está embebida en 3 nuevos CDs:
- **CD-14** (nuevo): "E2E validación post-DONE en testnet real para features on-chain".
- **CD-15** (nuevo): "Retry/backoff configurable en todo call a RPC o HTTP que dependa de confirmaciones/timing".
- **CD-16** (nuevo): "Header propagation testeable: cada header crítico (x-payment-chain, x-a2a-key, etc.) testeado tanto en ausencia como en valor".

**Estado actual**: Auto-blindaje WKH-105 = 8 entradas (4 unitarias + 4 consolidadas de fix-pack + 3 lecciones críticas). Las 3 nuevas CDs se propagan a todas las HUs futuras que toquen on-chain o RPC.
