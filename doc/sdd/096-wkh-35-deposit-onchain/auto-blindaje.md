# Auto-Blindaje — WKH-35 (Deposit verified on-chain)

Registro de errores cometidos durante F3 y su corrección. Protege futuras HUs.

### [2026-05-29] Wave 1 — viem `chain` union demasiado estrecha en `resolveChainObject`
- **Error**: `tsc -p tsconfig.build.json` reportó TS2322 al devolver
  `ReturnType<typeof getKiteChain> | ReturnType<typeof getBaseChain>` desde
  `resolveChainObject`. Los objetos `chain` de viem tienen literales `readonly`
  (ej. `blockExplorers.default.name: "SnowTrace"` vs `"KiteScan"`) que NO
  unionan estructuralmente.
- **Causa raíz**: cada `defineChain` / entrada de `viem/chains` produce un tipo
  con literales distintos; un union manual de dos `ReturnType` no abarca el
  tercero (Avalanche) y rompe la asignación.
- **Fix**: tipar el retorno como `Chain` (el tipo base de viem). `createPublicClient`
  acepta `Chain`, así que el dispatcher devuelve `Chain` y los helpers concretos
  son asignables a él.
- **Aplicar en**: cualquier dispatcher local que reúna varios `chain` de viem
  (Kite defineChain + viem/chains) → tipar como `Chain`, no como union de
  `ReturnType`.

### [2026-05-29] Wave 1 — `decodeEventLog` sin `eventName` no narrowea `args`
- **Error**: TS2339 `Property 'to'/'value' does not exist on type '{} | {}'` al
  desestructurar `decoded.args` tras `decodeEventLog({ abi: [TRANSFER_EVENT], ... })`.
- **Causa raíz**: sin pasar `eventName`, viem infiere un union de todos los eventos
  posibles del ABI y `args` queda como `{} | {}`; el check `decoded.eventName !== 'Transfer'`
  no narrowea el tipo de `args` lo suficiente.
- **Fix**: pasar `eventName: 'Transfer'` a `decodeEventLog` y anotar el retorno con
  `ReturnType<typeof decodeEventLog<readonly [typeof TRANSFER_EVENT], 'Transfer'>>`.
  Así `decoded.args` tipa `{ from, to, value }` y la desestructuración compila.
- **Aplicar en**: toda decodificación de un evento ERC-20/ERC-721 conocido con
  viem → pasar `eventName` explícito para obtener `args` tipados (sin `any`).

### [2026-05-29] Wave 3 — test e2e legacy asertaba el 501 que esta HU elimina
- **Error**: `src/__tests__/e2e/e2e.test.ts` (AC-11) falló: esperaba `501` y
  recibió `403`. No estaba en el Scope IN del Story File.
- **Causa raíz**: ese test codificaba el contrato VIEJO (`POST /auth/deposit` →
  501 "deposit disabled"). WKH-35 re-habilita el endpoint, por lo que la
  aserción quedó obsoleta — es la consecuencia INTENCIONADA del cambio, no una
  regresión de lógica.
- **Fix**: actualizar la única aserción stale a la nueva semántica: sin header
  de auth el endpoint devuelve `403` (unauthenticated), ya no `501`. Cambio
  mínimo, no se expandió el test.
- **Aplicar en**: cuando una HU re-habilita un endpoint que estaba en `501`/`stub`,
  buscar tests e2e/integration que asserten el código del stub (`grep -rn "501"
  src/__tests__`) ANTES de cerrar — el Story File puede no listarlos en Scope IN
  pero romperán la suite.

---

## FIX-PACK (post AR+CR) — 2026-05-29

### [2026-05-29] FIX-1 (BLQ-MED-1) — treasury compartido permitía hijack del txHash
- **Error**: el verifier validaba `Transfer.to == treasury` pero ignoraba
  `Transfer.from`. Como el treasury es compartido, un atacante podía front-run
  el `txHash` de un depósito ajeno y reclamarlo como propio (acreditar a SU key).
- **Causa raíz**: confiar solo en el recipient. El depositante real no se
  vinculaba a ninguna key, así que cualquier caller autenticado podía citar
  cualquier tx confirmada al treasury.
- **Fix**: (1) nueva columna `funding_wallet` + UNIQUE parcial; (2) endpoint
  `POST /auth/funding-wallet` que exige prueba de control (firma viem sobre el
  mensaje canónico `WASIAI_BIND_FUNDING_WALLET:<key_id>`, key_id del caller
  autenticado, nunca del body); (3) el verifier ahora DEVUELVE `from` y el
  handler de `/deposit` exige `from == key.funding_wallet` (403 NOT_BOUND si no
  hay wallet, 403 MISMATCH si no coincide) ANTES de acreditar.
- **Aplicar en**: cualquier verificación on-chain contra un recipient
  compartido (treasury/pool) DEBE además vincular y exigir el `from`. Validar
  solo `to` nunca prueba quién pagó.

### [2026-05-29] FIX-3 (MNR) — AMOUNT_MISMATCH con `Number()` perdía precisión
- **Error**: comparar `Number(amountUsd) !== Number(expectedAmountUsd)`.
  `Number('1.000000000000000001') === Number('1')` por el redondeo de float64,
  así que un monto declarado con sub-ulp distinto pasaba como igual.
- **Causa raíz**: float64 no representa 18 decimales sin pérdida.
- **Fix**: reparsear el monto declarado a unidades atómicas con los MISMOS
  `token.decimals` vía `parseUnits(expected, decimals)` y comparar `bigint`
  contra `amountAtomic` (`bigint`). `parseUnits` lanza si el string es inválido
  o excede los decimales del token → se trata como `AMOUNT_MISMATCH`.
- **Aplicar en**: toda comparación de montos on-chain → comparar en unidades
  atómicas (`bigint`), nunca como `Number`/float.

### [2026-05-29] Backlog cosmético — MNR-2 (CR + RE-AR): labels de log en logOwnershipMismatch
- `budget.ts:98` `registerDeposit`: el `logOwnershipMismatch('getBalance', ...)`
  usa la etiqueta `op:'getBalance'` aunque la operación es `registerDeposit`.
  Diagnóstico levemente engañoso (PII-safe igual). Backlog: agregar
  `'registerDeposit'` al union `OwnershipOp` en `errors.ts` y usarlo.
- `identity.ts:133` `bindFundingWallet`: el `logOwnershipMismatch('deactivate', ...)`
  usa la etiqueta `op:'deactivate'` aunque la operación es `bindFundingWallet`.
  Mismo patrón. Backlog: agregar `'bindFundingWallet'` al union `OwnershipOp`
  en `errors.ts` y usarlo.
- Fuente: MNR-2 del CR (`cr-report.md:209-220`) y nota §4 del RE-AR (`ar-report-2.md:89`).

### [2026-05-29] Backlog — MNR-3 (CR): Avalanche sin test de path-feliz dedicado en el verifier
- `deposit-verifier.test.ts` cubre Kite (18-dec PYUSD) y Base (6-dec USDC) en T1/T8.
  La rama Avalanche en `resolveRpcUrl:128-131` y `resolveChainObject:150-153`
  no tiene un test T1-equivalente con `avalanche-fuji` (chainId 43113, USDC 6-dec,
  env `FUJI_RPC_URL`). Cobertura equivalente existe vía Base (misma semántica);
  typecheck cubre exhaustividad del switch. No rompe AC-6.
- Backlog: agregar 1 caso happy-path para `avalanche-fuji` en `deposit-verifier.test.ts`.
- Fuente: MNR-3 del CR (`cr-report.md:222-235`).

### [2026-05-29] Backlog — parseFloat/NUMERIC(18,6) en montos extremos
- `registerDeposit`/PG fn: el monto pasa por `parseFloat(amountUsd)` (JS) y
  `NUMERIC(18,6)` (DB). Montos extremos (>1e15 o sub-1e-6) podrían redondear.
  Hoy los tokens soportados están dentro del rango seguro; backlog: validar
  rango/escala antes del `parseFloat` o pasar el string atómico a la PG fn.
