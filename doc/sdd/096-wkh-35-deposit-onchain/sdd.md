# SDD #096: [WKH-35] Fondeo verificado on-chain de agent keys (budget prepago), multi-chain

> SPEC_APPROVED: no
> Fecha: 2026-05-29
> Tipo: feature
> SDD_MODE: full
> Branch: feat/096-wkh-35-deposit-onchain
> Artefactos: doc/sdd/096-wkh-35-deposit-onchain/

---

## 1. Resumen

Re-habilitar `POST /auth/deposit` (hoy HTTP 501 en `src/routes/auth.ts:98-109`) para que un caller
autenticado (a2a-key / Bearer `wasi_a2a_*`) fondee su agent-key con **prueba on-chain real** de un
depósito ya confirmado. El caller envía el `txHash` del depósito; el gateway lee el **receipt
on-chain con un viem `publicClient` nuevo por chain** (capacidad que NO existe hoy — Grounding §3),
valida `status=success`, monto, token/asset, recipient esperado (treasury/operator por chain) y
chainId, y solo si todo pasa acredita `budget[chainId]` vía un `register_a2a_key_deposit` **idempotente
y atómico** que persiste la tx consumida (anti-replay) y cruza por `owner_ref` (Ownership Guard).

Resultado esperado: un caller puede cargar saldo prepago real en Kite / Avalanche / Base, sin riesgo
de doble crédito, sin crédito optimista, y sin cross-tenant leak. Desbloquea el path (b) "budget
prepago" (hoy nadie puede fondear).

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 096 |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Re-habilitar `/deposit` con verificación on-chain (txHash+receipt), anti-replay atómico, ownership y matching de chain, multi-chain. |
| **Reglas de negocio** | Cero crédito sin prueba on-chain confirmada (CD-4). Una tx jamás se acredita dos veces (CD-2). El crédito va exclusivamente a `budget[chainId]` de la chain verificada (CD-5). Solo se acredita la key cuyo `owner_ref` == caller (CD-1). |
| **Scope IN** | `src/routes/auth.ts` (deposit handler real); nuevo módulo de verificación de receipt on-chain por chain (`src/adapters/deposit-verifier.ts`); `src/services/budget.ts` (`registerDeposit` firma nueva); nueva migración (`a2a_key_deposits` + `register_a2a_key_deposit` v2); nuevos publicClients por adapter; tests unit + e2e. |
| **Scope OUT** | x402 per-request (EIP-3009 live); debit per-step / `increment_a2a_key_spend`; UI/CLI; `POST /bind/:chain` (sigue 501); deploy de contrato escrow; cambios al `PaymentAdapter.verify()` x402. |
| **Missing Inputs** | Ninguno bloqueante. DT-1/DT-2/DT-3 resueltas por el orquestador (ver §4). |

### Acceptance Criteria (EARS)

- **AC-1** — WHEN un caller autenticado envía `POST /auth/deposit` con la prueba (`tx_hash`) de un
  depósito on-chain para una chain soportada, THE system SHALL verificar on-chain (monto, token/asset,
  recipient esperado, chainId, `status=success`, confirmaciones) ANTES de acreditar, y SHALL retornar
  el nuevo balance de esa chain con HTTP 200 solo si la verificación pasa.
- **AC-2** — IF la verificación on-chain falla (tx inexistente, `status != success`, monto/token/
  recipient/chain mismatch, o confirmaciones insuficientes), THEN THE system SHALL rechazar con un
  error explícito y SHALL NOT llamar `registerDeposit()` (cero crédito).
- **AC-3** — IF una tx de depósito ya fue acreditada previamente, THEN THE system SHALL rechazar el
  reintento sin volver a acreditar, y SHALL persistir cada tx consumida de forma única (no se acredita
  la misma tx dos veces ni bajo concurrencia).
- **AC-4** — WHEN un depósito verificado en chain `C` se acredita, THE system SHALL incrementar
  exclusivamente `budget[chainId(C)]`, y SHALL rechazar si el `chain_id` declarado por el caller no
  coincide con el de la tx verificada on-chain.
- **AC-5** — WHILE se acredita un depósito a una key, THE system SHALL acreditar únicamente la key cuyo
  `owner_ref` coincide con el del caller autenticado; IF el `key_id` objetivo pertenece a otro owner,
  THEN THE system SHALL rechazar con error de ownership y SHALL NOT acreditar.
- **AC-6** — WHERE la chain del depósito está inicializada en el registry (`getAdaptersBundle`), THE
  system SHALL soportar el fondeo verificado para Kite / Avalanche / Base reutilizando la resolución
  per-request (`x-payment-chain`); IF la chain no está soportada/inicializada, THEN THE system SHALL
  retornar `CHAIN_NOT_SUPPORTED`.

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/routes/auth.ts` | Endpoint `/deposit` 501 (`:98-109`); auth helper `resolveCallerKey` (`:21-45`) | El endpoint NO usa `requirePaymentOrA2AKey`; auth se hace inline vía `resolveCallerKey` (x-a2a-key > Bearer `wasi_a2a_*`). `budgetService` import comentado (`:15-16`) listo para re-enable. Patrón de respuesta `reply.status(n).send({...})`. |
| `src/services/budget.ts` | `registerDeposit` (`:70-84`), `getBalance` Ownership Guard (`:19-41`) | `registerDeposit(keyId, chainId, amountUsd: string)` hace `supabase.rpc('register_a2a_key_deposit', {p_key_id, p_chain_id, p_amount_usd})`. NO recibe `ownerId` ni `txHash`. `getBalance` cruza `.eq('owner_ref', ownerId)` y mapea `PGRST116 → OwnershipMismatchError` (`:31-36`). |
| `src/middleware/a2a-key.ts` | `resolveChainKey` + `getAdaptersBundle` + `request.resolvedChainId` (`:188-235`); `owner_ref` del caller en `request.a2aKeyRow.owner_ref` (`:264`) | El `chainId` para mutaciones SIEMPRE sale de `bundle.chainConfig.chainId` (CD-12), nunca de un valor del caller. `assetSymbol = bundle.payment.supportedTokens[0]?.symbol`. El header `x-payment-chain` ya resuelve la chain. |
| `src/adapters/types.ts` | `PaymentAdapter` (`:78-91`), `TokenSpec` (`:6-10`), `AdaptersBundle` (`:135-145`), `ChainKey` (`:122-128`) | `supportedTokens: TokenSpec[]` con `{symbol, address: 0x${string}, decimals}`. `AdaptersBundle.chainConfig = {name, chainId, explorerUrl}`. NO hay método de lectura de receipt en `PaymentAdapter`. |
| `src/adapters/base/payment.ts` | RPC URL + token + decimals por chain | `getRpcUrl(network)` lee `BASE_MAINNET_RPC_URL` / `BASE_TESTNET_RPC_URL`. `getUsdcAddress(network)` con env override + fallback + warn-once + `ADDRESS_RE`. `supportedTokens` → `{USDC, addr, 6}`. WalletClient lazy-cacheado por network. |
| `src/adapters/kite-ozone/payment.ts` | Token + decimals + RPC Kite | `supportedTokens` → `{PYUSD|USDC.e, addr, 18}` (18 decimals testnet/mainnet). `getKiteRpcUrl()` lee `KITE_MAINNET_RPC_URL ?? KITE_RPC_URL` / `KITE_RPC_URL`. `getPaymentToken()` env override + warn-once. |
| `src/adapters/avalanche/payment.ts` | RPC + token Avalanche | `getRpcUrl(network)` → `AVALANCHE_RPC_URL` / `FUJI_RPC_URL`. `supportedTokens` USDC (6 dec). Mismo patrón que Base. |
| `src/adapters/kite-ozone/client.ts` | **Exemplar del publicClient** | `createPublicClient({chain, transport: http(rpcUrl)})`, lazy singleton, `getChainId()` para health, `getClient()/requireClient()/_resetClient()`. Este es el patrón a replicar para `getTransactionReceipt`. |
| `src/adapters/kite-ozone/gasless.ts` | publicClient `readContract` real | `getOperatorTokenBalance` usa `client.readContract({address, abi, functionName, args})` — patrón viem read on-chain con try/catch → null. `operatorAddress = privateKeyToAccount(pk).address` (`:284`). |
| `src/adapters/registry.ts` | Resolución de bundle por chain | `getAdaptersBundle(chainKey)` no-throw → `undefined` si no inicializada (`:213-220`). `getDefaultChainKey()`, `getInitializedChainKeys()`. |
| `supabase/migrations/20260406000000_a2a_agent_keys.sql` | Schema + PG functions | `a2a_agent_keys` (`:8-38`), `budget JSONB {"<chainId>":"<amount>"}` (`:14-15`). `register_a2a_key_deposit` (`:126-147`) usa `FOR UPDATE`, NO idempotente, NO `owner_ref`, NO txHash. `increment_a2a_key_spend` (`:56-121`) — NO TOCAR. `SECURITY DEFINER` (bypass RLS). |
| `src/types/a2a-key.ts` | Tipos ya definidos | `DepositInput {key_id, chain_id, token, amount, tx_hash}` (`:42-48`) y `DepositResponse {balance, chain_id}` (`:71-74`) **ya existen** — reutilizar, NO redefinir. |
| `src/services/security/errors.ts` | `OwnershipMismatchError` + `logOwnershipMismatch` | `code = 'OWNERSHIP_MISMATCH'`; logger PII-safe (hashea ids). Reusar para el deposit ownership. |
| `src/services/budget.test.ts` | **Exemplar mock supabase** | `vi.mock('../lib/supabase.js', () => ({supabase:{from, rpc}}))`; `chainMock()` helper; `mockRpc.mockResolvedValue({data, error})`. |
| `src/services/kite-client.test.ts` | **Exemplar mock viem publicClient** | `vi.mock('viem', () => ({createPublicClient: vi.fn(()=>({getChainId})), http, defineChain}))`; `vi.resetModules()` + re-import para reconfigurar env. |
| `src/adapters/__tests__/base.test.ts` | **Exemplar mock viem (importOriginal) + fetch** | `vi.mock('viem', async (importOriginal)=>({...actual, createWalletClient: vi.fn()}))`; `vi.stubGlobal('fetch', mockFetch)`; `_reset*()` en `beforeEach`. |
| `src/routes/auth.test.ts` | **Exemplar route test (Fastify inject)** | `Fastify()` + `app.register(authRoutes, {prefix:'/auth'})`; `vi.mock` de `identity.js` y `budget.js`; `makeKeyRow()`; ya tiene un test del 501 (`:138-156`) que hay que **actualizar** al nuevo comportamiento. |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/adapters/deposit-verifier.ts` (NUEVO) | `src/adapters/kite-ozone/client.ts` (publicClient) + `src/adapters/kite-ozone/gasless.ts` (`readContract`) | Mismo patrón de `createPublicClient` + `http(rpcUrl)` + try/catch; `getTransactionReceipt` es API estándar de `PublicClient`. |
| publicClient por chain (en verifier) | `src/adapters/base/payment.ts` `getRpcUrl(network)` + lazy cache | RPC URL por env por chain, lazy, sin hardcode. |
| `register_a2a_key_deposit` v2 (migración nueva) | `register_a2a_key_deposit` actual (`:126-147`) + `increment_a2a_key_spend` (`:56-121`, patrón `FOR UPDATE` + RAISE EXCEPTION) | Reusa `FOR UPDATE`, agrega INSERT anti-replay + filtro `owner_ref` en la misma tx. |
| `budgetService.registerDeposit` firma nueva | firma actual (`:70-84`) | Mismo wrapper `supabase.rpc` con params extra. |
| `src/adapters/deposit-verifier.test.ts` (NUEVO) | `src/services/kite-client.test.ts` + `src/adapters/__tests__/base.test.ts` | Mock viem publicClient + receipt fixtures. |
| Tests `/deposit` en `src/routes/auth.test.ts` | tests existentes del mismo archivo + `budget.test.ts` mock | Fastify inject + mocks de verifier/budget. |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `a2a_agent_keys` | Sí | `id`, `owner_ref`, `budget JSONB`, `is_active` (migración `20260406...:8-38`). NO se altera el schema de esta tabla. |
| `a2a_key_deposits` | **No (a crear)** | tabla nueva anti-replay (ver §4.2). |
| `register_a2a_key_deposit` (PG fn) | Sí (firma vieja) | Se reemplaza con v2 (más params). |
| `increment_a2a_key_spend` (PG fn) | Sí | **NO TOCAR** (CD-7). |

### Componentes reutilizables encontrados

- `DepositInput` / `DepositResponse` en `src/types/a2a-key.ts` — usar tal cual.
- `resolveCallerKey` en `src/routes/auth.ts:21-45` — reusar para autenticar el deposit (mismo patrón que `/me`).
- `resolveChainKey` + `getAdaptersBundle` (`src/adapters/chain-resolver.ts`, `src/adapters/registry.ts`) — reusar para resolver chain + bundle desde `x-payment-chain`.
- `OwnershipMismatchError` + `logOwnershipMismatch` (`src/services/security/errors.ts`) — reusar.
- publicClient pattern de `kite-ozone/client.ts` — replicar en el verifier.

---

## 4. Diseño Técnico

### 4.0 Decisiones técnicas confirmadas (DT)

> Las 3 DTs marcadas `[NEEDS CLARIFICATION]` en el work-item fueron **resueltas por el orquestador**.
> Aquí quedan documentadas como confirmadas. **Cero `[NEEDS CLARIFICATION]` pendientes.**

| DT | Decisión confirmada | Justificación |
|----|---------------------|---------------|
| **DT-1 (mecanismo)** | **txHash + receipt on-chain.** El caller manda `tx_hash`; el gateway lee el receipt con un viem `publicClient` nuevo por chain y valida `status=success`, monto, token/asset, recipient esperado y chainId. **NO** se reusa `PaymentAdapter.verify()` (valida firmas EIP-3009, no receipts — Grounding §2/§3). | El depósito es un evento que ya ocurrió on-chain → necesita prueba de finalidad, no una firma. |
| **DT-2 (recipient esperado)** | **treasury/operator por chain, leído de env/config (sin hardcode, CD-3).** No hay contrato escrow en el codebase → transfer directo a un recipient esperado. Se lee de env `A2A_DEPOSIT_TREASURY_<CHAIN>` con **fallback al operator address** derivado de `OPERATOR_PRIVATE_KEY` (`privateKeyToAccount(pk).address`, patrón `gasless.ts:284`). | El operator wallet es el destino real de fondos hoy (gasless/fee). Env-configurable permite rotar treasury sin redeploy. |
| **DT-3 (confirmaciones)** | **configurable por chain vía env, default seguro.** Env `A2A_DEPOSIT_MIN_CONFIRMATIONS_<CHAIN>`; default global `A2A_DEPOSIT_MIN_CONFIRMATIONS` (default `1` en testnets, recomendado `3+` en mainnets vía env). Se computa `confirmations = latestBlock - receipt.blockNumber + 1`. | Testnets toleran 1 confirmación; mainnets requieren más. Sin hardcode → operador decide por env. |
| **DT-4 (anti-replay storage)** | **tabla dedicada `a2a_key_deposits` con `UNIQUE(chain_id, tx_hash)`**, auditable, no infla el row de la key. INSERT del tx + crédito en la **misma transacción PG** (`register_a2a_key_deposit` v2). | Tabla > columna JSONB: auditable, índice único nativo, cierra la race de doble crédito a nivel DB. |
| **DT-5 (resolución de chain)** | reutilizar `resolveChainKey({headerOverride})` + `x-payment-chain` + `getAdaptersBundle()`; el `chainId` del crédito sale del **bundle** (CD-5/CD-12), nunca de `body.chain_id` sin verificar. | Patrón ya probado en `a2a-key.ts:188-235`. |
| **DT-6 (amount → USD)** | la conversión monto-atómico-on-chain → USD usa `decimals` del `supportedTokens[0]` del adapter (NO literal). `usd = Number(formatUnits(receiptValue, decimals))` (stablecoins ~1:1 USD). | Carry-forward decimals-drift WKH-67 (_INDEX #072): PYUSD 18 dec (Kite), USDC 6 dec (Base/Avalanche). |

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `supabase/migrations/20260529000000_a2a_key_deposits.sql` | **Crear** | Tabla `a2a_key_deposits` + `register_a2a_key_deposit` v2 (idempotente, atómica, `owner_ref` + txHash). | `20260406000000_a2a_agent_keys.sql` |
| `supabase/migrations/20260529000000_a2a_key_deposits_down.sql` | **Crear** | Down migration (DROP tabla + restaurar fn v1). | `20260406000000_a2a_agent_keys_down.sql` |
| `src/adapters/deposit-verifier.ts` | **Crear** | Módulo que dado `(chainKey, txHash)` lee el receipt vía publicClient, computa confirmaciones, extrae transfer recipient/amount/token y devuelve `DepositVerification`. | `kite-ozone/client.ts` + `gasless.ts` readContract |
| `src/services/budget.ts` | **Modificar** | `registerDeposit(keyId, chainId, amountUsd, ownerId, txHash)` → rpc v2 con `p_owner_ref` + `p_tx_hash`; mapear error de duplicado → `DepositAlreadyCreditedError`, ownership → `OwnershipMismatchError`. | firma actual `:70-84`, `getBalance` ownership `:19-41` |
| `src/routes/auth.ts` | **Modificar** | Reemplazar el handler 501 (`:98-109`) por el flujo real: auth → validar input → resolver chain/bundle → verificar receipt → registerDeposit atómico → 200 balance. Re-habilitar import de `budgetService` (`:15-16`). | `/me` handler + `resolveCallerKey` |
| `src/services/security/errors.ts` | **Modificar** | Agregar `DepositAlreadyCreditedError` (`code='DEPOSIT_ALREADY_CREDITED'`) reusando el patrón de `OwnershipMismatchError`. | `OwnershipMismatchError` |
| `src/adapters/deposit-verifier.test.ts` | **Crear** | Unit: verify ok, status fail, amount mismatch, token mismatch, recipient mismatch, chain mismatch, confirmaciones insuficientes, tx inexistente — por las 3 chains. | `kite-client.test.ts` + `base.test.ts` |
| `src/services/budget.test.ts` | **Modificar** | Cubrir nueva firma de `registerDeposit` (owner_ref + tx_hash en rpc params; duplicado → error; ownership → error). | tests existentes del archivo |
| `src/routes/auth.test.ts` | **Modificar** | Reemplazar test del 501 (`:138-156`) por: 200 happy path, 4xx verify fail, 409 replay, 403 ownership, 400 chain mismatch, `CHAIN_NOT_SUPPORTED`. Agregar `vi.mock` del verifier. | tests existentes del archivo |
| `.env.example` | **Modificar** | Documentar `A2A_DEPOSIT_TREASURY_*` y `A2A_DEPOSIT_MIN_CONFIRMATIONS*` (sin valores reales). | bloque RPC/operator existente |

> **Nota:** `src/types/a2a-key.ts` NO se modifica — `DepositInput`/`DepositResponse` ya existen.

### 4.2 Modelo de datos (migración nueva)

Tabla anti-replay dedicada. El INSERT del tx + el crédito al budget ocurren en la **misma función PG**
(misma transacción implícita), cerrando la race de doble crédito (CD-2).

```sql
-- ============================================================
-- Migration: 20260529000000_a2a_key_deposits
-- WKH-35: Fondeo verificado on-chain (anti-replay + ownership)
-- ============================================================

-- 1. Tabla anti-replay (auditable; no infla el row de la key) — DT-4 / CD-2
CREATE TABLE IF NOT EXISTS a2a_key_deposits (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id      UUID          NOT NULL REFERENCES a2a_agent_keys(id),
  owner_ref   TEXT          NOT NULL,              -- snapshot del owner que acreditó
  chain_id    INT           NOT NULL,
  tx_hash     TEXT          NOT NULL,
  amount_usd  NUMERIC(18,6) NOT NULL,
  token       TEXT,                                 -- símbolo/asset acreditado (auditoría)
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- CD-2: unicidad a nivel DB; el mismo (chain, tx) jamás se acredita dos veces.
  CONSTRAINT uq_a2a_key_deposits_chain_tx UNIQUE (chain_id, tx_hash)
);

CREATE INDEX IF NOT EXISTS idx_a2a_key_deposits_key
  ON a2a_key_deposits (key_id);

-- 2. register_a2a_key_deposit v2 — idempotente + atómica + ownership (CD-1/CD-2/CD-5)
--    Reemplaza la v1 (sin owner_ref, sin txHash). Firma NUEVA → la única
--    call-site es budgetService.registerDeposit (endpoint estaba 501).
CREATE OR REPLACE FUNCTION register_a2a_key_deposit(
  p_key_id     UUID,
  p_chain_id   INT,
  p_amount_usd NUMERIC,
  p_owner_ref  TEXT,
  p_tx_hash    TEXT,
  p_token      TEXT DEFAULT NULL
)
RETURNS TEXT AS $$
DECLARE
  v_budget   JSONB;
  v_owner    TEXT;
  v_active   BOOLEAN;
  v_chain    TEXT := p_chain_id::TEXT;
  v_current  NUMERIC;
  v_new      NUMERIC;
BEGIN
  -- Lock the key row (atomic) — patrón FOR UPDATE de increment_a2a_key_spend.
  SELECT budget, owner_ref, is_active
    INTO v_budget, v_owner, v_active
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  -- CD-1: Ownership Guard a nivel DB (service usa SERVICE_ROLE → bypassa RLS).
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key_id % does not belong to caller', p_key_id;
  END IF;

  IF NOT v_active THEN
    RAISE EXCEPTION 'KEY_INACTIVE: key_id % is deactivated', p_key_id;
  END IF;

  -- CD-2: anti-replay. El UNIQUE(chain_id, tx_hash) hace que el segundo
  -- INSERT con el mismo (chain, tx) levante unique_violation; lo traducimos
  -- a un error explícito y NO acreditamos (la tx queda abortada/rollback).
  BEGIN
    INSERT INTO a2a_key_deposits (key_id, owner_ref, chain_id, tx_hash, amount_usd, token)
    VALUES (p_key_id, p_owner_ref, p_chain_id, p_tx_hash, p_amount_usd, p_token);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DEPOSIT_ALREADY_CREDITED: chain % tx % already credited', v_chain, p_tx_hash;
  END;

  -- Crédito al budget de la chain verificada (CD-5: chain del bundle).
  v_current := COALESCE((v_budget ->> v_chain)::NUMERIC, 0);
  v_new := v_current + p_amount_usd;

  UPDATE a2a_agent_keys
  SET budget = jsonb_set(COALESCE(v_budget, '{}'::jsonb), ARRAY[v_chain], to_jsonb(v_new::TEXT))
  WHERE id = p_key_id;

  RETURN v_new::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

> **Atomicidad (CD-2):** el INSERT en `a2a_key_deposits` y el `UPDATE` del budget viven en el cuerpo
> de UNA función plpgsql → una sola transacción. Si el INSERT falla por `unique_violation`, el
> `RAISE EXCEPTION` aborta toda la transacción → cero crédito. Bajo dos requests concurrentes con el
> mismo `(chain, tx)`, el `FOR UPDATE` serializa y el segundo INSERT colisiona con el UNIQUE → solo
> uno acredita.
>
> **Search-path hardening:** seguir el patrón de `20260427160000_secure_rpc_search_path.sql` si el
> repo lo exige para funciones `SECURITY DEFINER` (verificar en F3 con `Read` de esa migración).

### 4.3 Componentes / Servicios

**`src/adapters/deposit-verifier.ts` (NUEVO)** — capacidad on-chain nueva (Grounding §3).

Responsabilidad: dado `(chainKey: ChainKey, bundle: AdaptersBundle, txHash, expectedAmountAtomic?)`,
leer el receipt y devolver un veredicto tipado. Sin `any`, sin `as unknown` (CD-6).

```ts
// Tipos de diseño (no código final)
export interface DepositVerification {
  ok: boolean;
  reason?:                         // poblado solo si ok=false (AC-2)
    | 'TX_NOT_FOUND'
    | 'TX_REVERTED'
    | 'INSUFFICIENT_CONFIRMATIONS'
    | 'RECIPIENT_MISMATCH'
    | 'TOKEN_MISMATCH'
    | 'AMOUNT_MISMATCH'
    | 'CHAIN_MISMATCH'
    | 'RPC_UNAVAILABLE';
  amountAtomic?: bigint;           // monto transferido en unidades atómicas
  amountUsd?: string;              // amountAtomic formateado vía decimals del token (DT-6)
  token?: `0x${string}`;           // token contract verificado
  recipient?: `0x${string}`;       // recipient verificado (== treasury esperado)
  confirmations?: number;
}

export async function verifyDeposit(args: {
  chainKey: ChainKey;
  bundle: AdaptersBundle;
  txHash: `0x${string}`;
}): Promise<DepositVerification>;
```

Mecánica interna (viem):
1. **publicClient por chain** — lazy cache `Map<ChainKey, PublicClient>` construido con
   `createPublicClient({ chain, transport: http(rpcUrl) })`. `chain` = el objeto viem del bundle
   (Kite via `getKiteChain()`, Base/Avalanche via viem/chains). `rpcUrl` desde la MISMA env-resolution
   que el adapter de esa chain (`KITE_RPC_URL` / `FUJI_RPC_URL` / `AVALANCHE_RPC_URL` /
   `BASE_TESTNET_RPC_URL` / `BASE_MAINNET_RPC_URL`). Si el RPC URL no está → `RPC_UNAVAILABLE`
   (fail-loud, NO acreditar).
2. `receipt = await client.getTransactionReceipt({ hash: txHash })` → si throw / no encontrado →
   `TX_NOT_FOUND`.
3. `if (receipt.status !== 'success') → TX_REVERTED` (AC-2).
4. **chainId match (AC-4 / CD-5)** — `await client.getChainId()` (o el `chain.id` del client) debe
   ser `bundle.chainConfig.chainId`. El verifier SOLO usa el publicClient de la chain del bundle, así
   que la chain de la tx ES la del bundle por construcción; aun así se afirma explícitamente.
5. **confirmaciones (DT-3 / AC-2)** — `latest = await client.getBlockNumber()`;
   `confirmations = Number(latest - receipt.blockNumber) + 1`; si `< minConfirmations(chainKey)` →
   `INSUFFICIENT_CONFIRMATIONS`.
6. **token + recipient + amount (AC-1)** — el token esperado = `bundle.payment.supportedTokens[0]`
   (address + decimals). Se busca en `receipt.logs` el evento ERC-20 `Transfer(address,address,uint256)`
   emitido por el `token.address` cuyo `to == expectedTreasury(chainKey)`. El `expectedTreasury` =
   `A2A_DEPOSIT_TREASURY_<CHAIN>` env, fallback `privateKeyToAccount(OPERATOR_PRIVATE_KEY).address`
   (DT-2). Si no hay un Transfer al treasury con el token esperado → `RECIPIENT_MISMATCH` /
   `TOKEN_MISMATCH`. El `value` del log es `amountAtomic`.
   - `Transfer` topic0 = `keccak256("Transfer(address,address,uint256)")`; decodificar con
     `decodeEventLog`/`parseAbiItem` de viem (NO hardcodear el hash — derivarlo con viem).
7. **amount → USD (DT-6)** — `amountUsd = formatUnits(amountAtomic, token.decimals)`. Si el caller
   declaró `body.amount`, comparar contra `amountUsd` con tolerancia exacta de string normalizado; si
   difiere → `AMOUNT_MISMATCH` (el crédito usa SIEMPRE el `amountUsd` derivado on-chain, nunca el
   declarado — CD-4).

> **Por qué leer el log y no `tx.value`:** los depósitos son de stablecoin ERC-20 (PYUSD/USDC), no
> native value. El `Transfer` log del token contract es la fuente de verdad del monto+recipient.

**`src/services/budget.ts` (MODIFICAR)** — firma nueva:

```ts
async registerDeposit(
  keyId: string,
  chainId: number,
  amountUsd: string,
  ownerId: string,      // CD-1 (no `string | undefined`)
  txHash: string,       // CD-2
  token?: string,
): Promise<string>
```
- rpc → `register_a2a_key_deposit` v2 con `p_owner_ref: ownerId`, `p_tx_hash: txHash`, `p_token: token`.
- Mapear `error.message` que contenga `DEPOSIT_ALREADY_CREDITED` → `throw new DepositAlreadyCreditedError()`.
- Mapear `OWNERSHIP_MISMATCH` → `throw new OwnershipMismatchError()` + `logOwnershipMismatch('getBalance'... )`
  (o agregar op `'registerDeposit'` a `OwnershipOp` si CR lo pide — opcional).

### 4.4 Flujo principal (Happy Path) — `POST /auth/deposit`

1. **Auth** — `resolveCallerKey(request)` (mismo helper que `/me`). Si null o `!is_active` → 403.
   `ownerRef = callerKey.owner_ref`.
2. **Validar input** — body es `DepositInput` `{key_id, chain_id, token, amount, tx_hash}`. Validar:
   `key_id` no vacío; `tx_hash` formato `0x[0-9a-fA-F]{64}`; `chain_id` número. Si falta algo → 400.
   - **Ownership pre-check (defense-in-depth, CD-1):** `body.key_id === callerKey.id`? Si difiere → 403
     ownership (un caller solo fondea SU propia key; el `owner_ref` del rowque resolvió ES el del key).
3. **Resolver chain + bundle (DT-5 / AC-6)** — `chainKey = resolveChainKey({ headerOverride:
   x-payment-chain })`. Si header presente pero no reconocido → 400 `CHAIN_NOT_SUPPORTED`. Si ausente,
   se permite derivar de `body.chain_id` vía `normalizeChainSlug(String(body.chain_id))` (acepta
   numeric chainId). `bundle = getAdaptersBundle(chainKey)`; si `undefined` → 400 `CHAIN_NOT_SUPPORTED`.
   `chainId = bundle.chainConfig.chainId` (CD-5).
4. **chain_id match (AC-4)** — si `body.chain_id !== chainId` → 400 `CHAIN_MISMATCH`.
5. **Verificar on-chain (AC-1 / CD-4)** — `result = await verifyDeposit({chainKey, bundle, txHash})`.
   Si `!result.ok` → 4xx con `error_code = result.reason` (NO se llama registerDeposit — CD-4).
6. **Acreditar atómico (AC-3 / AC-5)** — `balance = await budgetService.registerDeposit(callerKey.id,
   chainId, result.amountUsd!, ownerRef, txHash, result.tokenSymbol)`.
   - Si `DepositAlreadyCreditedError` → 409 `DEPOSIT_ALREADY_CREDITED`.
   - Si `OwnershipMismatchError` → 403 ownership.
7. **Respuesta** — 200 `{ balance, chain_id: chainId }` (`DepositResponse`).

### 4.5 Flujo de error

| Condición | Respuesta | AC |
|-----------|-----------|----|
| No auth / key inactiva | 403 `{error:'Invalid or inactive API key'}` | AC-1 |
| Input inválido (tx_hash mal formado, falta campo) | 400 `{error_code:'INVALID_INPUT'}` | AC-1 |
| `body.key_id !== callerKey.id` | 403 ownership (defense-in-depth) | AC-5 |
| Chain no soportada / no inicializada | 400 `{error_code:'CHAIN_NOT_SUPPORTED'}` | AC-6 |
| `body.chain_id != bundle.chainId` | 400 `{error_code:'CHAIN_MISMATCH'}` | AC-4 |
| Verify falla (tx inexistente/reverted/mismatch/confirms) | 4xx `{error_code: <reason>}`, sin crédito | AC-2 |
| tx ya acreditada | 409 `{error_code:'DEPOSIT_ALREADY_CREDITED'}` | AC-3 |
| key de otro owner (DB-level) | 403 `{error_code:'OWNERSHIP_MISMATCH'}` | AC-5 |
| RPC caído | 503/4xx `{error_code:'RPC_UNAVAILABLE'}`, sin crédito | AC-2/CD-4 |

---

## 5. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (OBLIGATORIO)

- **CD-1 (Ownership Guard)**: toda mutación/lectura sobre `a2a_agent_keys` en el flujo de deposit DEBE
  filtrar por `owner_ref`. `registerDeposit()` recibe `ownerId: string` (NO `string | undefined`) y la
  PG fn v2 cruza `v_owner IS DISTINCT FROM p_owner_ref → OWNERSHIP_MISMATCH`. PROHIBIDO acreditar sin
  verificar `owner_ref`. **Cumplido en:** §4.2 (PG fn), §4.3 (`registerDeposit` firma), §4.4 paso 6.
- **CD-2 (anti-replay)**: PROHIBIDO acreditar la misma tx > 1 vez. Unicidad a nivel DB
  (`UNIQUE(chain_id, tx_hash)`); INSERT + crédito atómicos. **Cumplido en:** §4.2 (tabla + fn v2).
- **CD-3 (sin hardcodes)**: PROHIBIDO hardcodear treasury, RPC URLs, token addresses o confirmaciones.
  Todo desde env/config por chain. **Cumplido en:** §4.0 DT-2/DT-3, §4.3 (publicClient RPC env, treasury
  env, `Transfer` topic derivado con viem no hardcodeado).
- **CD-4 (verify-before-credit)**: PROHIBIDO llamar `registerDeposit()` antes de que el verify pase.
  Cero crédito optimista. El crédito usa el `amountUsd` derivado on-chain, no el declarado. **Cumplido
  en:** §4.4 (paso 5 antes de 6), §4.5.
- **CD-5 (chain match)**: el `chainId` acreditado DEBE ser el del bundle resuelto/verificado, nunca
  `body.chain_id` sin verificar. **Cumplido en:** §4.4 pasos 3-4, §4.2 (crédito a `v_chain`).
- **CD-6 (sin ethers, TS strict)**: lectura on-chain con **viem** (PROHIBIDO ethers.js); sin `any`
  explícito ni `as unknown`. **Cumplido en:** §4.3 (publicClient, decodeEventLog, formatUnits).
- **CD-7 (no romper paths live)**: PROHIBIDO modificar x402 per-request, debit per-step o
  `increment_a2a_key_spend`. El cambio de firma de `registerDeposit` NO afecta otros call-sites (única
  call-site era el endpoint, que estaba 501 — verificado: `budgetService` import comentado en
  `auth.ts:15-16`). **Cumplido en:** §4.1 (Scope OUT respetado).

### Nuevos (de este SDD)

- **CD-8 (mocks del registry completos — Auto-Blindaje WKH-111/#093)**: si se agrega una función nueva
  al registry consumida por un módulo compartido, ANTES de mergear correr
  `grep -rn "vi.mock('.*adapters/registry" src/` y verificar que TODOS los mocks exporten lo nuevo.
  Esta HU NO agrega funciones al registry (reusa `getAdaptersBundle`), pero el verifier será mockeado
  en `auth.test.ts` — el `vi.mock` del verifier debe exportar `verifyDeposit` completo.
- **CD-9 (typecheck autoritativo — Auto-Blindaje WKH-111/#093)**: el typecheck de producción es
  `tsc -p tsconfig.build.json --noEmit`. PROHIBIDO usar `tsc --noEmit` pelado como criterio (mezcla
  tests + rootDir, ruido TS6059 preexistente no accionable).
- **CD-10 (decimals NO literal — Auto-Blindaje WKH-67/#072 carry-forward)**: PROHIBIDO usar un
  decimals literal (`/1e18`, `/1e6`) en la conversión amount→USD. SIEMPRE `formatUnits(atomic,
  token.decimals)` con `decimals` del `bundle.payment.supportedTokens[0]`. Kite=18, Base/Avalanche=6.
- **CD-11 (delegación de firma/timeout explícita — Auto-Blindaje WKH-112/#094)**: N/A directo (no se
  firma nada aquí), pero su lección general aplica: cuando este SDD prescribe un campo explícito
  (p.ej. `minConfirmations`, `decimals`), NO asumir defaults silenciosos del entorno; afirmarlo por test.

### PROHIBIDO (resumen)

- NO escribir el SQL como archivo de migración ejecutable en F2 (va diseñado aquí; el Dev lo crea en F3).
- NO agregar dependencias nuevas (viem ya está; no ethers, no web3.js).
- NO modificar `increment_a2a_key_spend`, x402, ni el debit per-step.
- NO redefinir `DepositInput`/`DepositResponse` (ya existen en `src/types/a2a-key.ts`).
- NO hardcodear treasury/RPC/token/confirmaciones.
- NO acreditar el `body.amount` declarado por el caller — solo el derivado on-chain.
- NO usar `tsc --noEmit` pelado como gate de typecheck.

---

## 6. Scope

**IN:** ver §2 Scope IN + §4.1.

**OUT:** x402 per-request; debit per-step / `increment_a2a_key_spend`; UI/CLI; `POST /bind/:chain`;
deploy de escrow; cambios a `PaymentAdapter.verify()`; reescritura de `project-context.md`.

---

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| El depósito real podría no emitir un `Transfer` ERC-20 estándar (token no estándar) | B | A | Los tokens son PYUSD/USDC (ERC-20 estándar con `Transfer`). Verifier devuelve `TOKEN_MISMATCH` fail-loud si no lo encuentra → cero crédito (CD-4). |
| Race de doble crédito bajo concurrencia | B | A | `UNIQUE(chain_id,tx_hash)` + `FOR UPDATE` + INSERT-then-credit atómico (§4.2). |
| RPC URL ausente/caído por chain → no se puede verificar | M | M | `RPC_UNAVAILABLE` fail-loud, sin crédito (CD-4). Operador setea env RPC. |
| Treasury env no configurado → cae al operator address; si difiere del destino real del depósito → `RECIPIENT_MISMATCH` | M | M | Documentar `A2A_DEPOSIT_TREASURY_*` en `.env.example`; fallback al operator es el destino real hoy (gasless/fee). |
| Ripple en tests legacy por nueva firma `registerDeposit` | B | M | Única call-site era el endpoint (501); `budget.test.ts` se actualiza; grep de call-sites en F3 (CD-7). |
| Confirmaciones mal calibradas (testnet 1 vs mainnet) | B | M | Env por chain con default 1 testnet; documentar recomendación mainnet (DT-3). |

## 8. Dependencias

- viem v2 (ya instalado) — `createPublicClient`, `getTransactionReceipt`, `getBlockNumber`,
  `decodeEventLog`/`parseAbiItem`, `formatUnits`, `privateKeyToAccount`.
- Registry inicializado (`initAdapters()`) con la(s) chain(s) target — ya en startup.
- Migración aplicada antes de habilitar el endpoint en prod (pre-flight runbook WKH-78).
- Env por chain: RPC URL (ya existe), `A2A_DEPOSIT_TREASURY_*` (nuevo), `A2A_DEPOSIT_MIN_CONFIRMATIONS*`
  (nuevo), `OPERATOR_PRIVATE_KEY` (ya existe, fallback treasury).

## 9. Missing Inputs

- [ ] Ninguno bloqueante. DT-1/2/3 resueltas (§4.0). Treasury/confirmaciones por env con default seguro.

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| [TBD] | §4.2 | Confirmar en F3 si el repo exige `SET search_path` en funciones `SECURITY DEFINER` (patrón `20260427160000_secure_rpc_search_path.sql`) — replicar si aplica. | No |
| [TBD] | §4.3 | Confirmar en F3 el objeto `chain` viem exacto a pasar al publicClient por chain (Kite `getKiteChain()`, Base `baseSepolia/base`, Avalanche `avalancheFuji/avalanche`) — los exemplars existen. | No |

> Gate: cero `[NEEDS CLARIFICATION]`. Los dos `[TBD]` son confirmaciones de detalle de impl. (no de
> diseño/negocio) que el Dev resuelve con `Read` de exemplars ya identificados.

---

## 11. Waves de Implementación

### Wave 0 (Serial Gate) — contratos, tipos, migración, errores

- [ ] **W0.1** Crear migración `20260529000000_a2a_key_deposits.sql` + `_down.sql` (tabla anti-replay +
      `register_a2a_key_deposit` v2). Exemplar: `20260406000000_a2a_agent_keys.sql`.
- [ ] **W0.2** Agregar `DepositAlreadyCreditedError` a `src/services/security/errors.ts`. Exemplar:
      `OwnershipMismatchError`.
- [ ] **W0.3** Definir tipos del verifier (`DepositVerification`, reasons) en `deposit-verifier.ts`
      (sin lógica aún, solo el contrato). Exemplar: `adapters/types.ts`.
- [ ] Verificación: `tsc -p tsconfig.build.json --noEmit` limpio.

### Wave 1 (Parallelizable) — verifier + service

- [ ] **W1.1** Implementar `src/adapters/deposit-verifier.ts` (publicClient por chain, getReceipt,
      confirmaciones, Transfer-log decode, treasury/token/amount, formatUnits). Exemplar:
      `kite-ozone/client.ts` + `gasless.ts`. Depende: W0.3.
- [ ] **W1.2** Modificar `budgetService.registerDeposit` (firma nueva + mapeo de errores). Exemplar:
      firma actual + `getBalance`. Depende: W0.1, W0.2.
- [ ] Verificación: `tsc -p tsconfig.build.json --noEmit` + tests unit nuevos por W1.

### Wave 2 (Integración) — endpoint

- [ ] **W2.1** Reescribir handler `POST /auth/deposit` en `src/routes/auth.ts` (flujo §4.4) +
      re-habilitar import `budgetService`. Depende: W1.1, W1.2.
- [ ] Verificación: tests e2e del endpoint (las 3 chains) verdes.

### Wave 3 (Final) — tests + docs env

- [ ] **W3.1** Tests: `deposit-verifier.test.ts` (nuevo), actualizar `budget.test.ts`, actualizar
      `auth.test.ts` (reemplazar test del 501). Depende: W1, W2.
- [ ] **W3.2** Documentar env nuevas en `.env.example`.
- [ ] Verificación: `npm test` full verde + `tsc -p tsconfig.build.json --noEmit` + grep call-sites
      `registerDeposit` + grep `vi.mock('.*adapters/registry'` (CD-8).

### Dependencias entre waves

| Tarea | Depende de | Razón |
|-------|-----------|-------|
| W1.1 | W0.3 | Necesita los tipos del verifier. |
| W1.2 | W0.1, W0.2 | Necesita la fn v2 (params) y el error class. |
| W2.1 | W1.1, W1.2 | Orquesta verifier + service. |
| W3.x | W1, W2 | Tests cubren el código ya escrito. |

---

## 12. Plan de Tests (≥1 por AC)

| Test | AC que cubre | Archivo | Wave | Framework |
|------|-------------|---------|------|-----------|
| verify OK → `{ok:true, amountUsd, recipient, token}` (las 3 chains) | AC-1, AC-6 | `src/adapters/deposit-verifier.test.ts` | W1 | vitest |
| receipt `status='reverted'` → `TX_REVERTED` | AC-2 | `deposit-verifier.test.ts` | W1 | vitest |
| `getTransactionReceipt` throw → `TX_NOT_FOUND` | AC-2 | `deposit-verifier.test.ts` | W1 | vitest |
| confirmaciones < min → `INSUFFICIENT_CONFIRMATIONS` | AC-2 | `deposit-verifier.test.ts` | W1 | vitest |
| recipient != treasury → `RECIPIENT_MISMATCH` | AC-2 | `deposit-verifier.test.ts` | W1 | vitest |
| token != supportedTokens[0] → `TOKEN_MISMATCH` | AC-2 | `deposit-verifier.test.ts` | W1 | vitest |
| amount declarado != on-chain → `AMOUNT_MISMATCH` | AC-2 | `deposit-verifier.test.ts` | W1 | vitest |
| decimals correcto por chain: PYUSD 18 → USD, USDC 6 → USD (CD-10) | AC-1 | `deposit-verifier.test.ts` | W1 | vitest |
| RPC URL ausente → `RPC_UNAVAILABLE` | AC-2 | `deposit-verifier.test.ts` | W1 | vitest |
| `registerDeposit` pasa `p_owner_ref`+`p_tx_hash` a rpc; retorna balance | AC-1, AC-5 | `src/services/budget.test.ts` | W1 | vitest |
| rpc error `DEPOSIT_ALREADY_CREDITED` → `DepositAlreadyCreditedError` | AC-3 | `budget.test.ts` | W1 | vitest |
| rpc error `OWNERSHIP_MISMATCH` → `OwnershipMismatchError` | AC-5 | `budget.test.ts` | W1 | vitest |
| `/deposit` happy path → 200 + `{balance, chain_id}` | AC-1 | `src/routes/auth.test.ts` | W3 | vitest |
| `/deposit` verify fail → 4xx + sin llamar `registerDeposit` (CD-4) | AC-2 | `auth.test.ts` | W3 | vitest |
| `/deposit` replay → 409 `DEPOSIT_ALREADY_CREDITED` | AC-3 | `auth.test.ts` | W3 | vitest |
| `/deposit` `body.chain_id != bundle.chainId` → 400 `CHAIN_MISMATCH` | AC-4 | `auth.test.ts` | W3 | vitest |
| `/deposit` key de otro owner → 403 ownership | AC-5 | `auth.test.ts` | W3 | vitest |
| `/deposit` chain no inicializada → 400 `CHAIN_NOT_SUPPORTED` | AC-6 | `auth.test.ts` | W3 | vitest |
| `/deposit` sin auth → 403 | AC-1 | `auth.test.ts` | W3 | vitest |

### Cómo se mockea hoy (verificado)

- **viem publicClient** — `vi.mock('viem', () => ({ createPublicClient: vi.fn(()=>({ getTransactionReceipt,
  getBlockNumber, getChainId })), http, ... }))`. Exemplar exacto: `src/services/kite-client.test.ts:8-12`
  y `src/adapters/__tests__/base.test.ts:21-30` (`importOriginal` para conservar `formatUnits`/
  `decodeEventLog`/`parseAbiItem`). Receipts y logs se inyectan como fixtures.
- **supabase** — `vi.mock('../lib/supabase.js', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }))`
  + `mockRpc.mockResolvedValue({data, error})`. Exemplar: `src/services/budget.test.ts:10-15`.
- **route** — `Fastify()` + `app.register(authRoutes, {prefix:'/auth'})` + `app.inject(...)`. Mocks de
  `../services/identity.js`, `../services/budget.js` y (nuevo) `../adapters/deposit-verifier.js`.
  Exemplar: `src/routes/auth.test.ts:80-93`.
- **typecheck** — `tsc -p tsconfig.build.json --noEmit` (CD-9, no el pelado).

---

## 13. Readiness Check (F2)

```
READINESS CHECK:
[x] Cada AC (AC-1..AC-6) tiene >=1 archivo asociado en §4.1 y >=1 test en §12.
[x] Cada archivo en §4.1 tiene Exemplar válido verificado con Glob/Read (Context Map §3).
[x] No hay [NEEDS CLARIFICATION] pendientes (DT-1/2/3 resueltas en §4.0). Solo 2 [TBD] no bloqueantes.
[x] Constraint Directives incluyen >=3 PROHIBIDO (CD-1..CD-11 + bloque PROHIBIDO §5).
[x] Context Map tiene >=2 archivos leídos (17 archivos leídos en §3).
[x] Scope IN y OUT explícitos y no ambiguos (§2, §6).
[x] BD: tablas verificadas — a2a_agent_keys EXISTE, a2a_key_deposits a CREAR (§3 / §4.2).
[x] Happy Path completo (§4.4, 7 pasos).
[x] Flujo de error definido (§4.5, >=8 casos).
[x] Auto-Blindaje histórico aplicado: WKH-111/#093 (mocks registry CD-8, typecheck CD-9),
    WKH-67/#072 (decimals CD-10), WKH-112/#094 (delegación explícita CD-11).
```

Todos los checks pasan. SDD listo para gate SPEC_APPROVED.

---

*SDD generado por NexusAgil — FULL*
