# Auto-Blindaje — WKH-101 (Dev / F3)

### [2026-05-31] W1 — viem EIP-712 message: number vs bigint
- **Error**: `tsc` TS2322 al pasar `typedData.message` directo a `recoverTypedDataAddress`. viem infiere los tipos EIP-712 `uint64`/`uint256[]` como `bigint`, pero `DelegationTypedDataMessage.policy.expires_at` es `number` (el JSON del cliente trae numbers).
- **Causa raíz**: viem 2.50.4 deriva el shape del `message` desde los `types` (`as const`). Un campo declarado `uint64` exige `bigint` en runtime/tipo, no `number`.
- **Fix**: construir el objeto `message` que se pasa a viem convirtiendo `expires_at` → `BigInt(...)` y `allowed_chains` → `.map(BigInt)`. NO reconstruye valores, solo re-tipa. El `[VERIFY-AT-IMPL]` se confirmó leyendo `node_modules/viem/_types/utils/signature/recoverTypedDataAddress.d.ts` y `types/typedData.d.ts` (no requiere `EIP712Domain` en `types`; `as const` basta, sin `any`).
- **Aplicar en**: cualquier futura firma EIP-712 con campos uint/int en viem — convertir a bigint al pasar el message.

### [2026-05-31] W4 — `toHaveBeenCalledWith` se rompe al agregar un 4º arg opcional
- **Error**: 4 tests de `compose.test.ts` (T-COMPOSE-DEBIT-1/2/7/9) fallaron tras agregar `request.delegationContext` como 4º arg de `budgetService.debit` en `compose.ts:158`.
- **Causa raíz**: `toHaveBeenCalledWith('k1', 2368, 0.05)` es estricto con args extra; al pasar un 4º `undefined`, ya no matchea.
- **Fix**: actualizar las aserciones del path master a incluir el 4º arg `undefined` (`...0.05, undefined`). Backward-compat real preservada (master key → ctx undefined).
- **Aplicar en**: cualquier HU que agregue un param opcional a una fn mockeada con aserciones `toHaveBeenCalledWith` exactas — buscar todos los call-sites en tests.

### [2026-05-31] W2 — prefijo de ruta duplicado `/auth/auth/delegation`
- **Error**: nombré las rutas como `POST /auth/delegation` dentro del plugin `authRoutes`, que `src/index.ts:121` registra con `prefix: '/auth'` → URL final `/auth/auth/delegation`.
- **Causa raíz**: confundir la URL pública (`/auth/delegation`) con el path interno del plugin (que NO lleva el prefix). El exemplar `/erc8004/bind` ya usa path sin `/auth`.
- **Fix**: cambiar los paths internos a `/delegation`, `/delegation/:id`. URL pública resultante = `/auth/delegation` (correcta).
- **Aplicar en**: toda ruta nueva en un plugin con prefix — el path interno NO incluye el prefix.

### [2026-05-31] W5 — biome formatter como gate de `npm run lint`
- **Error**: `npm run lint` (biome check) falla con diffs de formato aunque el código compile.
- **Causa raíz**: biome `check` corre lint + formato; los archivos nuevos no estaban formateados según el estilo del repo.
- **Fix**: `npm run format` (biome format --write) y luego eliminar un parámetro realmente sin usar (`policy` en `parseDelegationTypedData`) + aplicar optional-chain sugerido.
- **Aplicar en**: correr `npm run format` antes de `npm run lint` en cada wave que cree archivos.
