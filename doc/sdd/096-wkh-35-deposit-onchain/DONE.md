# Report — HU [WKH-35] Fondeo verificado on-chain de agent keys (budget prepago), multi-chain

## Resumen ejecutivo

Se re-habilitó `POST /auth/deposit` (antes en 501 permanente) con verificación on-chain real via viem publicClient por chain, anti-replay atómico en DB, soporte multi-chain Kite/Avalanche/Base, Ownership Guard en app y DB, y decimals derivados del adapter. Un BLOQUEANTE de seguridad (BLQ-MED-1: deposit-hijack via treasury compartido) fue detectado por AR y cerrado en el fix-pack: se agregó binding de funding wallet con prueba de control criptográfica (`POST /auth/funding-wallet`) y el gate `Transfer.from == funding_wallet` antes de acreditar. Estado final: 6/6 ACs PASS, typecheck limpio, 1099 tests passed/0 failed, sin regresión en x402/debit. Implementado y validado; NO desplegado — pendiente aplicar 2 migraciones + env vars en producción/staging.

---

## Pipeline ejecutado

- F0: project-context cargado (`.nexus/project-context.md`); grounding verificado en `work-item.md` §Grounding (8 puntos con archivo:línea).
- F1: `work-item.md` — gate HU_APPROVED 2026-05-29 (delegated by Fernando, clinical review AUTO).
- F2: `sdd.md` — gate SPEC_APPROVED 2026-05-29 (delegated by Fernando, clinical review AUTO). 11 CDs + 2 DTs resueltos.
- F2.5: `story-WKH-35.md` generado. 4 waves: W0 (tipos/migración/errores), W1 (deposit-verifier + registerDeposit), W2 (handler /deposit), W3 (tests + env).
- F3: implementación en 4 waves + fix-pack post-AR (FIX-1 BLQ-MED-1 + FIX-3 AMOUNT_MISMATCH BigInt). Archivos principales listados en §Archivos modificados.
- AR: `ar-report-2.md` — RE-AR veredicto APROBADO. BLQ-MED-1 CERRADO. 1 MENOR cosmético (MNR-1, label de log).
- CR: `cr-report.md` — veredicto APROBADO con MENORES. 11 CDs cumplidos. 3 MENOREs (MNR-1 precisión float — resuelto por FIX-3; MNR-2 label log; MNR-3 Avalanche sin test happy-path dedicado).
- F4: `qa-report.md` — veredicto APROBADO. 6/6 ACs PASS con evidencia archivo:línea. AC extra (deposit-hijack) PASS. 1099 tests PASS/0 FAIL. Typecheck exit 0.

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (verify on-chain antes de acreditar → 200 + balance) | PASS | `auth.ts:262-273` verifyDeposit precede registerDeposit; `deposit-verifier.ts:185-309` receipt check completo; tests `auth.test.ts:182-219`, `deposit-verifier.test.ts:132-173` |
| AC-2 (verificación falla → rechazo sin crédito) | PASS | `auth.ts:268-273` (!result.ok → 4xx sin registerDeposit); 7 reasons cubiertas; `deposit-verifier.test.ts:176-283` T2-T7; `auth.test.ts:222-266` |
| AC-3 (anti-replay: misma tx → 409 sin re-acreditar) | PASS | `migration 20260529000000:17` UNIQUE(chain_id,tx_hash); INSERT atómico con EXCEPTION WHEN unique_violation; `auth.test.ts:269-295`, `budget.test.ts:207-219` |
| AC-4 (chainId declarado != on-chain → rechazo; crédito solo a budget correcto) | PASS | `auth.ts:257-259` CHAIN_MISMATCH; `auth.ts:254` chainId=bundle (CD-5); `deposit-verifier.ts:216-218`; tests `auth.test.ts:297-320`, `deposit-verifier.test.ts:377-394` |
| AC-5 (ownership: solo acredita key con owner_ref del caller) | PASS | `auth.ts:237-239` pre-check; `auth.ts:288-295` ownerRef=callerKey.owner_ref; `migration:63-65` DB-level OWNERSHIP_MISMATCH; tests `auth.test.ts:322-370`, `budget.test.ts:221-233` |
| AC-6 (multi-chain Kite/Avalanche/Base; unsupported → CHAIN_NOT_SUPPORTED) | PASS | `deposit-verifier.ts:67-159` resolución por chain; `auth.ts:242-253` CHAIN_NOT_SUPPORTED; tests `auth.test.ts:372-393`, `deposit-verifier.test.ts:156-173,329-360` |

---

## Hallazgos finales

**BLOQUEANTEs:**
- BLQ-MED-1 (deposit-hijack: treasury compartido sin binding del depositante) — levantado por AR, CERRADO en fix-pack. Solución: columna `funding_wallet` + UNIQUE parcial + `POST /auth/funding-wallet` con prueba de control criptográfica (recoverMessageAddress viem real sobre mensaje canónico `WASIAI_BIND_FUNDING_WALLET:<key_id>`); gate `Transfer.from == funding_wallet` aplicado ANTES de registerDeposit (`auth.ts:279-284`). Sin nuevos bloqueantes post-fix.

**MENOREs (aceptados como deuda técnica en backlog):**
- MNR-1 (CR): precisión `Number()` en comparación AMOUNT_MISMATCH — CERRADO por FIX-3 en fix-pack (comparación BigInt exacta via `parseUnits`; `deposit-verifier.ts:282-297`).
- MNR-2 (CR + RE-AR): label `'getBalance'` en `logOwnershipMismatch` dentro de `registerDeposit` (`budget.ts:98`) y label `'deactivate'` dentro de `bindFundingWallet` (`identity.ts:133`). Backlog: agregar `'registerDeposit'` y `'bindFundingWallet'` al union `OwnershipOp` en `errors.ts`. PII-safe, no bloquea.
- MNR-3 (CR): Avalanche sin test de path-feliz dedicado en el verifier (`deposit-verifier.test.ts`). Cobertura equivalente existe vía Base (misma rama, USDC 6-dec). Backlog: agregar 1 caso T1-equivalente para `avalanche-fuji`.
- Observation F4: `DepositInput.amount` podría ser `string | undefined` explícitamente en tipos. Cosmético, sin impacto funcional ni de seguridad.

---

## Auto-Blindaje consolidado

### [2026-05-29] Wave 1 — viem `chain` union demasiado estrecha en `resolveChainObject`

- **Error**: `tsc -p tsconfig.build.json` reportó TS2322 al devolver `ReturnType<typeof getKiteChain> | ReturnType<typeof getBaseChain>` desde `resolveChainObject`. Los objetos `chain` de viem tienen literales `readonly` que NO unionan estructuralmente.
- **Causa raíz**: cada `defineChain` / entrada de `viem/chains` produce un tipo con literales distintos; un union manual de dos `ReturnType` no abarca el tercero (Avalanche) y rompe la asignación.
- **Fix**: tipar el retorno como `Chain` (el tipo base de viem). `createPublicClient` acepta `Chain`, así que el dispatcher devuelve `Chain` y los helpers concretos son asignables a él.
- **Aplicar en**: cualquier dispatcher local que reúna varios `chain` de viem (Kite defineChain + viem/chains) — tipar como `Chain`, no como union de `ReturnType`.

### [2026-05-29] Wave 1 — `decodeEventLog` sin `eventName` no narrowea `args`

- **Error**: TS2339 `Property 'to'/'value' does not exist on type '{} | {}'` al desestructurar `decoded.args` tras `decodeEventLog({ abi: [TRANSFER_EVENT], ... })`.
- **Causa raíz**: sin pasar `eventName`, viem infiere un union de todos los eventos posibles del ABI y `args` queda como `{} | {}`; el check `decoded.eventName !== 'Transfer'` no narrowea el tipo de `args` lo suficiente.
- **Fix**: pasar `eventName: 'Transfer'` a `decodeEventLog` y anotar el retorno con `ReturnType<typeof decodeEventLog<readonly [typeof TRANSFER_EVENT], 'Transfer'>>`. Así `decoded.args` tipa `{ from, to, value }` y la desestructuración compila.
- **Aplicar en**: toda decodificación de un evento ERC-20/ERC-721 conocido con viem — pasar `eventName` explícito para obtener `args` tipados (sin `any`).

### [2026-05-29] Wave 3 — test e2e legacy asertaba el 501 que esta HU elimina

- **Error**: `src/__tests__/e2e/e2e.test.ts` (AC-11) falló: esperaba `501` y recibió `403`. No estaba en el Scope IN del Story File.
- **Causa raíz**: ese test codificaba el contrato VIEJO (`POST /auth/deposit` → 501 "deposit disabled"). WKH-35 re-habilita el endpoint, por lo que la aserción quedó obsoleta.
- **Fix**: actualizar la única aserción stale a la nueva semántica: sin header de auth el endpoint devuelve `403` (unauthenticated), ya no `501`. Cambio mínimo, no se expandió el test.
- **Aplicar en**: cuando una HU re-habilita un endpoint que estaba en `501`/`stub`, buscar tests e2e/integration que asserten el código del stub (`grep -rn "501" src/__tests__`) ANTES de cerrar.

### [2026-05-29] FIX-1 (BLQ-MED-1) — treasury compartido permitía hijack del txHash

- **Error**: el verifier validaba `Transfer.to == treasury` pero ignoraba `Transfer.from`. Como el treasury es compartido, un atacante podía front-run el `txHash` de un depósito ajeno y reclamarlo como propio.
- **Causa raíz**: confiar solo en el recipient. El depositante real no se vinculaba a ninguna key.
- **Fix**: (1) nueva columna `funding_wallet` + UNIQUE parcial; (2) endpoint `POST /auth/funding-wallet` que exige prueba de control (firma viem sobre el mensaje canónico `WASIAI_BIND_FUNDING_WALLET:<key_id>`, key_id del caller autenticado, nunca del body); (3) el verifier ahora DEVUELVE `from` y el handler de `/deposit` exige `from == key.funding_wallet` (403 NOT_BOUND si no hay wallet, 403 MISMATCH si no coincide) ANTES de acreditar.
- **Aplicar en**: cualquier verificación on-chain contra un recipient compartido (treasury/pool) DEBE además vincular y exigir el `from`. Validar solo `to` nunca prueba quién pagó.

### [2026-05-29] FIX-3 (MNR) — AMOUNT_MISMATCH con `Number()` perdía precisión

- **Error**: comparar `Number(amountUsd) !== Number(expectedAmountUsd)`. `Number('1.000000000000000001') === Number('1')` por el redondeo de float64.
- **Causa raíz**: float64 no representa 18 decimales sin pérdida.
- **Fix**: reparsear el monto declarado a unidades atómicas con los MISMOS `token.decimals` vía `parseUnits(expected, decimals)` y comparar `bigint` contra `amountAtomic` (`bigint`). `parseUnits` lanza si el string es inválido o excede los decimales del token → se trata como `AMOUNT_MISMATCH`.
- **Aplicar en**: toda comparación de montos on-chain — comparar en unidades atómicas (`bigint`), nunca como `Number`/float.

### [2026-05-29] Backlog cosmético (pendiente, no tocado)

- `budget.ts` `registerDeposit`: el `logOwnershipMismatch('getBalance', ...)` usa la etiqueta `op:'getBalance'` aunque la operación es `registerDeposit`. Backlog: agregar `'registerDeposit'` al union `OwnershipOp` y usarlo.
- `identity.ts` `bindFundingWallet`: el `logOwnershipMismatch('deactivate', ...)` usa la etiqueta `op:'deactivate'` aunque la operación es `bindFundingWallet`. Backlog: agregar `'bindFundingWallet'` al union `OwnershipOp` y usarlo.
- `registerDeposit`/PG fn: el monto pasa por `parseFloat(amountUsd)` (JS) y `NUMERIC(18,6)` (DB). Montos extremos (>1e15 o sub-1e-6) podrían redondear. Los tokens soportados están dentro del rango seguro; backlog: validar rango/escala antes del `parseFloat` o pasar el string atómico a la PG fn.

---

## Archivos modificados

**Adapters / verificación on-chain:**
- `src/adapters/deposit-verifier.ts` — nuevo módulo; viem publicClient por chain; resolución de RPC/treasury/chain/confirmaciones desde env; verificación de receipt, logs Transfer, decimals del adapter; devuelve `from` (FIX-1).

**Routes:**
- `src/routes/auth.ts` — re-habilita `POST /auth/deposit` (quita 501); orquesta verify → funding-wallet gate → registerDeposit; agrega `POST /auth/funding-wallet` (bind con prueba de control criptográfica, recoverMessageAddress viem real).

**Services:**
- `src/services/budget.ts` — `registerDeposit` refactorizado a 6 params (`keyId, chainId, amountUsd, ownerId, txHash, token?`); mapeo de errores PG a error classes tipadas.
- `src/services/identity.ts` — nueva función `bindFundingWallet(keyId, wallet, ownerId)` con Ownership Guard doble (id + owner_ref); manejo de 23505 → FundingWalletAlreadyBoundError.
- `src/services/security/errors.ts` — 4 nuevas clases de error: `FundingWalletProofInvalidError`, `FundingWalletAlreadyBoundError`, `FundingWalletNotBoundError`, `FundingWalletMismatchError`.

**Types:**
- `src/types/a2a-key.ts` — campo `funding_wallet: string | null` en el row type de `A2AAgentKey`.

**Migraciones:**
- `supabase/migrations/20260529000000_a2a_key_deposits.sql` — tabla `a2a_key_deposits` con UNIQUE(chain_id,tx_hash); DROP explícito de la v1 de `register_a2a_key_deposit` (3 args); nueva v2 (6 args, owner_ref, tx_hash, search_path hardening, GRANT solo a service_role).
- `supabase/migrations/20260529000000_a2a_key_deposits_down.sql` — rollback fiel: recrea v1, dropea v2, dropea tabla.
- `supabase/migrations/20260529000001_a2a_key_funding_wallet.sql` — agrega columna `funding_wallet TEXT NULLABLE` a `a2a_agent_keys` + UNIQUE parcial `uq_a2a_agent_keys_funding_wallet`; envuelta en BEGIN/COMMIT.
- `supabase/migrations/20260529000001_a2a_key_funding_wallet_down.sql` — rollback: dropea columna y UNIQUE.

**Config / docs:**
- `.env.example` — 7 vars nuevas: `A2A_DEPOSIT_TREASURY_{KITE,AVALANCHE,BASE}` + `A2A_DEPOSIT_MIN_CONFIRMATIONS` + 3 overrides por chain.

**Tests:**
- `src/adapters/deposit-verifier.test.ts` — 13 tests; T1 cubre Kite 18-dec y Base 6-dec exacto; T2-T9 cubren cada reason de fallo; T8 afirma decimals per chain; CHAIN_MISMATCH on-chain.
- `src/services/budget.test.ts` — 4+ tests nuevos; afirman los 6 params exactos de registerDeposit incl. p_owner_ref/p_tx_hash/p_token; mapeos de error.
- `src/routes/auth.test.ts` — T13-T19 + extras; happy path 200; fail-paths con registerDeposit/verifyDeposit not called; test escenario de robo (from != funding_wallet → 403); tests de bind con firmas ECDSA reales (no mockeadas).
- `src/__tests__/e2e/e2e.test.ts` — actualización de 1 aserción stale (501 → 403 sin auth).

---

## Checklist de activación runtime (pendiente)

Las siguientes acciones son necesarias para que el endpoint sea funcional en producción/staging. NO se realizaron en esta HU (no es responsabilidad del Dev/QA — requieren acceso al remoto).

### 1. Aplicar migraciones (en orden)

```bash
# Ejecutar contra la DB target (supabase link o psql directo)
supabase db push --include-all
# o bien aplicar manualmente en orden:
# 1. supabase/migrations/20260529000000_a2a_key_deposits.sql
# 2. supabase/migrations/20260529000001_a2a_key_funding_wallet.sql
```

Verificación post-apply:
```sql
-- Columna funding_wallet presente
SELECT column_name, is_nullable, data_type
  FROM information_schema.columns
  WHERE table_name = 'a2a_agent_keys' AND column_name = 'funding_wallet';
-- Esperado: is_nullable = 'YES', data_type = 'text'

-- Tabla de anti-replay presente
SELECT table_name FROM information_schema.tables
  WHERE table_name = 'a2a_key_deposits';
-- Esperado: 1 fila

-- Solo existe la v2 de la PG fn (6 args); la v1 fue dropeada
SELECT proname, pronargs FROM pg_proc
  WHERE proname = 'register_a2a_key_deposit';
-- Esperado: 1 fila con pronargs = 6
```

Rollback disponible en `*_down.sql` correspondientes.

### 2. Setear env vars nuevas

| Var | Requerida | Descripción |
|-----|-----------|-------------|
| `A2A_DEPOSIT_TREASURY_KITE` | Recomendada | Address treasury para depósitos Kite. Si vacía, cae al operator address derivado de OPERATOR_PRIVATE_KEY. |
| `A2A_DEPOSIT_TREASURY_AVALANCHE` | Recomendada | Idem Avalanche. |
| `A2A_DEPOSIT_TREASURY_BASE` | Recomendada | Idem Base. |
| `A2A_DEPOSIT_MIN_CONFIRMATIONS` | Opcional (default 1) | Confirmaciones mínimas globales. Default 1 (testnet-safe). Recomendado 3+ en mainnet. |
| `A2A_DEPOSIT_MIN_CONFIRMATIONS_KITE` | Opcional | Override por chain. |
| `A2A_DEPOSIT_MIN_CONFIRMATIONS_AVALANCHE` | Opcional | Override por chain. |
| `A2A_DEPOSIT_MIN_CONFIRMATIONS_BASE` | Opcional | Override por chain. |

Las vars RPC (`KITE_RPC_URL`, `BASE_TESTNET_RPC_URL`, `FUJI_RPC_URL`) ya existen — no requieren cambio.

### 3. Flujo de activación del caller (nuevo — 3 pasos)

El flujo de fondeo requiere 3 pasos donde antes no había ninguno:

**Paso 1 — Bind de funding wallet (una vez por key, antes del primer depósito):**
```
POST /auth/funding-wallet
x-a2a-key: <bearer>
Content-Type: application/json
{ "wallet": "0x<address>", "signature": "0x<firma>" }
```
La firma es `signMessage(message: "WASIAI_BIND_FUNDING_WALLET:<key_id>")` con la clave privada de `wallet`. El `key_id` se obtiene del paso de creación de la key.

**Paso 2 — Transferir on-chain (desde la wallet bindeada):**
Enviar una transferencia ERC-20 del token soportado (PYUSD/USDC según chain) al treasury address configurado (`A2A_DEPOSIT_TREASURY_<CHAIN>` o operator address). La tx DEBE enviarse desde la `wallet` bindeada en el paso 1.

**Paso 3 — Registrar depósito (después de confirmaciones suficientes):**
```
POST /auth/deposit
x-a2a-key: <bearer>
Content-Type: application/json
{ "key_id": "<id>", "chain_id": <chainId>, "token": "PYUSD", "tx_hash": "0x<hash>" }
```
El `Transfer.from` de la tx on-chain debe coincidir con la `funding_wallet` bindeada.

---

## Decisiones diferidas a backlog

- **Backlog MNR-2**: agregar `'registerDeposit'` y `'bindFundingWallet'` al union `OwnershipOp` en `src/services/security/errors.ts` para mejorar trazabilidad de logs de seguridad.
- **Backlog MNR-3**: agregar test T1-equivalente para `avalanche-fuji` en `src/adapters/deposit-verifier.test.ts` (6-dec USDC, chainId 43113). Cierra el gap "las 3 chains" con test explícito.
- **Backlog parseFloat**: validar rango/escala antes del `parseFloat(amountUsd)` en `budget.ts` o pasar el string atómico directamente a la PG fn para montos extremos (actualmente dentro del rango seguro de stablecoins en uso).
- **Backlog WKH-SEC-02 (TD-SEC-01)**: RLS Postgres-level en `a2a_agent_keys`. La defensa hoy es solo app-layer (Ownership Guard). Plan ya trackeado.
- **Backlog `DepositInput.amount`**: declarar `amount?: string` explícitamente en el tipo en lugar de depender del cast `Partial<DepositInput>`. Cosmético.
- **Nota**: la activación de este endpoint desbloquea el path (b) de economía agentica (budget prepago). Habilita demos E2E de carga de saldo y el settlement del 1% fee sobre budget real.

---

## Lecciones para próximas HUs

1. **Verificación on-chain contra recipient compartido exige binding del sender.** Validar solo `Transfer.to == treasury` no es suficiente: cualquier tx al treasury puede ser reclamada por cualquier caller autenticado. La regla es: receptor compartido → el sistema DEBE vincular al sender con el caller antes de acreditar. Patrón: proof-of-control de la wallet + gate `Transfer.from == bound_wallet` ANTES del crédito.

2. **Comparaciones de montos on-chain deben ser en `bigint`, nunca en `Number`/float.** `formatUnits` produce strings con decimales variables; `Number()` sobre ellos pierde precisión para >15-16 dígitos significativos. Usar `parseUnits(expected, decimals)` y comparar `bigint` contra `bigint`. Aplica a toda lógica de monto on-chain: amount checks, fee checks, balance gates.

3. **Al re-habilitar un endpoint que estaba en 501, buscar tests que asserten el 501.** `grep -rn "501" src/__tests__` antes de cerrar F3. El Story File puede no listar esos tests en Scope IN pero romperán la suite. Es la consecuencia intencionada del cambio, no una regresión.

4. **Dispatchers de objetos `chain` de viem deben retornar `Chain`, no unions de `ReturnType`.** Cada `defineChain` / `viem/chains` produce literales `readonly` distintos; un union manual de dos `ReturnType` no abarca el tercero. Tipar el retorno como `Chain` (supertipo de viem) es el patrón correcto. Aplica a cualquier función que reúna chains de fuentes heterogéneas (defineChain local + viem/chains importadas).
