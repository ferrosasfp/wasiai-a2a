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

---

## Fix-pack MENORES (AR/CR) — 2026-05-31

### [2026-05-31] Fix-pack — AR-MNR-1/AR-MNR-2: error mapping + info-leak en débito de delegación
- **Error**: los prefijos `DAILY_LIMIT`, `KEY_INACTIVE`, `KEY_NOT_FOUND`, `DELEGATION_NOT_FOUND` que surgen del RPC chain `debit_delegation_and_parent` → `PERFORM increment_a2a_key_spend` no estaban mapeados en `delegation.ts:debitDelegationAndParent`. Caían en `throw new Error('Failed to debit delegation: <raw PG msg>')` → el fallback de `budget.ts` propagaba `err.message` (mensaje crudo de Postgres con `limit is %`/`daily spend %`) al body, y el middleware los re-lanzaba al outer catch → **503** en vez de 403.
- **Causa raíz**: el set de prefijos mapeados se construyó solo desde el RPC propio de delegación (`DELEGATION_*` + `INSUFFICIENT_BUDGET`), sin considerar que el `PERFORM increment_a2a_key_spend` re-emite los RAISE de la parent key (`DAILY_LIMIT`/`KEY_INACTIVE`/`KEY_NOT_FOUND`) por la misma cadena de error.
- **Fix**: (1) nuevas error classes `DailyLimitExceededError`/`AgentKeyInactiveError`/`AgentKeyNotFoundError`/`DelegationNotFoundError` en `security/errors.ts` (códigos estables `DAILY_LIMIT`/`KEY_INACTIVE`/`KEY_NOT_FOUND`/`DELEGATION_NOT_FOUND`). (2) `delegation.ts` mapea esos prefijos a las clases; el fallback verdaderamente inesperado ahora lanza `Error('DELEGATION_DEBIT_FAILED')` SIN el `msg` crudo. (3) `budget.ts` mapea las clases a su code y el `default` devuelve `'DELEGATION_DEBIT_FAILED'` (no `err.message`) + loguea el detalle vía `console.error` server-side. (4) `a2a-key.ts` step-0 mapea las nuevas clases a `send403delegation` (403) en vez de `throw debitErr` → 503.
- **Aplicar en**: cualquier RPC que haga `PERFORM`/`SELECT ... FROM fn()` sobre otra función plpgsql — enumerar TODOS los `RAISE EXCEPTION` de la cadena completa (no solo los del RPC top-level) antes de definir el set de prefijos a mapear. Nunca propagar `error.message` de Supabase/PG al body del cliente.

### [2026-05-31] Fix-pack — CR-MNR-1: validación de amounts en `parseDelegationPolicy`
- **Error**: `max_amount_per_tx`/`max_total_amount` solo se validaban como `string`, no como decimal positivo. Un `"-5"` o `"abc"` creaba una delegación inútil que recién fallaba (503) en el débito.
- **Causa raíz**: la validación de shape (`typeof === 'string'`) no chequeaba el contenido numérico.
- **Fix**: `parseDelegationPolicy` ahora exige regex `^\d+(\.\d+)?$` y `parseFloat > 0` para ambos campos; si falla → `null` → 400 `INVALID_INPUT` antes de persistir/verificar firma.
- **Aplicar en**: todo campo string que represente un monto/decimal en un body de request — validar formato + rango (> 0) en el parser, no asumir que el shape implica validez semántica.

---

## Technical Debt (NO código — backlog)

### TD-WKH-101-DRIFT
`resolveTargetChain` (`src/middleware/a2a-key.ts:132-171`, branch session) duplica el bloque
de resolución de chain del master (`src/middleware/a2a-key.ts:~449-486`). Es una réplica EXACTA
intencional para no arriesgar backward-compat del master (CD-5). Unificar en una HU futura
extrayendo un helper compartido; tocar el master ahora arriesga el camino master-key. **No bloqueante.**

### TD-WKH-101-RACE-TEST
T18 (atomicidad del débito doble bajo `FOR UPDATE` en `debit_delegation_and_parent`) es mock-only
a nivel unit. La atomicidad real del lock requiere un test de integración contra un Postgres real
(dos débitos concurrentes que compiten por el mismo `total_spent`/budget). Backlog: agregar suite
de integración con DB real. **No bloqueante** (la lógica del RPC ya está en la migración).

### TD-WKH-101-ORCH
Under-charge del master-en-orchestrate: en `orchestrate`, los steps 2..N se debitan sin `chainId`
del bundle (a diferencia de `compose` que ya propaga `request.resolvedChainId`). Para delegación
el débito per-step usa el chain correcto vía `delegationContext`, pero el path master-en-orchestrate
puede sub-cobrar en multichain. Trackear en HU dedicada de orchestrate. **No bloqueante** para WKH-101.
