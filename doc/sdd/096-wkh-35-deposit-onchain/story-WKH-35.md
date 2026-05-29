# Story File — WKH-35: Fondeo verificado on-chain de agent keys (budget prepago), multi-chain

> Contrato autocontenido para el Dev (F3). **Implementá SOLO lo que está acá.**
> NO vuelvas a leer el SDD. Si una firma/import/símbolo NO está confirmado acá ni
> en el código real, está marcado `VERIFICAR en <archivo>` — NO lo inventes.
>
> - SDD origen: `doc/sdd/096-wkh-35-deposit-onchain/sdd.md`
> - Branch: `feat/096-wkh-35-deposit-onchain`
> - Stack: TypeScript strict (sin `any`), viem v2 (prohibido ethers), Fastify, Supabase (SERVICE_ROLE → bypassa RLS), vitest.

---

## 0. Contexto compacto (qué se construye y por qué)

`POST /auth/deposit` hoy devuelve **501** (`src/routes/auth.ts:98-109`). Lo re-habilitamos para que
un caller autenticado (a2a-key vía `x-a2a-key` o Bearer `wasi_a2a_*`) fondee SU agent-key con **prueba
on-chain real** de un depósito ya confirmado:

1. El caller manda `tx_hash` del depósito.
2. El gateway lee el **receipt on-chain con un viem `publicClient` NUEVO por chain** (capacidad que NO
   existe hoy en `src/`) y valida `status=success`, confirmaciones, chainId, token, recipient (treasury)
   y monto.
3. Solo si todo pasa, acredita `budget[chainId]` vía `register_a2a_key_deposit` **v2** (idempotente +
   atómica + Ownership Guard + anti-replay por `UNIQUE(chain_id, tx_hash)`).

Resultado: caller carga saldo prepago real en Kite / Avalanche / Base, sin doble crédito, sin crédito
optimista, sin cross-tenant leak.

---

## 1. Scope IN — archivos a tocar (lista exhaustiva)

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `supabase/migrations/20260529000000_a2a_key_deposits.sql` | **Crear** | W0 |
| 2 | `supabase/migrations/20260529000000_a2a_key_deposits_down.sql` | **Crear** | W0 |
| 3 | `src/services/security/errors.ts` | **Modificar** (agregar `DepositAlreadyCreditedError`) | W0 |
| 4 | `src/adapters/deposit-verifier.ts` | **Crear** | W0 (tipos) → W1 (lógica) |
| 5 | `src/services/budget.ts` | **Modificar** (`registerDeposit` firma nueva) | W1 |
| 6 | `src/routes/auth.ts` | **Modificar** (handler real `/deposit`) | W2 |
| 7 | `src/adapters/deposit-verifier.test.ts` | **Crear** | W3 |
| 8 | `src/services/budget.test.ts` | **Modificar** | W3 |
| 9 | `src/routes/auth.test.ts` | **Modificar** (reemplazar test del 501) | W3 |
| 10 | `.env.example` | **Modificar** (documentar env nuevas) | W3 |

**PROHIBIDO tocar fuera de esta lista.** En particular NO tocar:
`increment_a2a_key_spend`, x402 (`PaymentAdapter.verify/settle`), debit per-step,
`src/types/a2a-key.ts` (`DepositInput`/`DepositResponse` ya existen — reusar tal cual).

---

## 2. Anti-Hallucination Checklist (verificado contra el código real)

Estos símbolos EXISTEN y se usan tal cual. NO los redefinas, NO inventes variantes.

| Símbolo / API | Dónde vive (confirmado) | Uso |
|---------------|-------------------------|-----|
| `DepositInput {key_id, chain_id, token, amount, tx_hash}` | `src/types/a2a-key.ts:42-48` | body del request — reusar |
| `DepositResponse {balance, chain_id}` | `src/types/a2a-key.ts:71-74` | respuesta 200 — reusar |
| `resolveCallerKey(request): Promise<A2AAgentKeyRow \| null>` | `src/routes/auth.ts:21-45` | auth del deposit — reusar (NO modificar su firma) |
| `OwnershipMismatchError` (`code='OWNERSHIP_MISMATCH'`) | `src/services/security/errors.ts:9-15` | reusar |
| `logOwnershipMismatch(op, keyId, ownerId)` (overload posicional) | `src/services/security/errors.ts:37-41` | `op` ∈ `'getBalance' \| 'deactivate'` en la forma posicional — **NO** existe `'registerDeposit'` en `OwnershipOp`. Si querés loguear ownership en `registerDeposit`, usá la forma posicional con `'getBalance'` O agregá `'registerDeposit'` a `OwnershipOp` (W0.2, opcional) |
| `resolveChainKey({headerOverride?, agentManifestChain?}): ChainKey \| undefined` | `src/adapters/chain-resolver.ts:77-88` | si `headerOverride` presente pero no reconocido → `undefined` (NO cae a default) |
| `normalizeChainSlug(raw: string): ChainKey \| undefined` | `src/adapters/chain-resolver.ts:61-66` | acepta slug Y chainId numérico (ej `'2368'`, `'base'`, `'43113'`) |
| `getAdaptersBundle(chainKey?): AdaptersBundle \| undefined` | `src/adapters/registry.ts:213-220` | no-throw; `undefined` si no inicializada |
| `AdaptersBundle.chainConfig {name, chainId, explorerUrl}` | `src/adapters/types.ts:140-144` | el `chainId` del crédito sale de acá (CD-5) |
| `AdaptersBundle.payment.supportedTokens: TokenSpec[]` | `src/adapters/types.ts:81` | `supportedTokens[0]` = token esperado |
| `TokenSpec {symbol: string, address: \`0x${string}\`, decimals: number}` | `src/adapters/types.ts:6-10` | `decimals` para `formatUnits` (CD-10) |
| `ChainKey` (union 6 slugs) | `src/adapters/types.ts:122-128` | `kite-ozone-testnet \| kite-mainnet \| avalanche-fuji \| avalanche-mainnet \| base-sepolia \| base-mainnet` |
| `getKiteChain()` → `kiteTestnet \| kiteMainnet` (viem `defineChain`) | `src/adapters/kite-ozone/chain.ts:49-51` | objeto `chain` para publicClient Kite |
| `getBaseChain(network)` → `base \| baseSepolia` (de `viem/chains`) | `src/adapters/base/chain.ts:45-47` | objeto `chain` para publicClient Base |
| `getBaseNetwork(opts?)` | `src/adapters/base/chain.ts:27-43` | resuelve `'testnet' \| 'mainnet'` |
| `getAvalancheChain(network)` → `avalanche \| avalancheFuji` (de `viem/chains`) | `src/adapters/avalanche/chain.ts:30-32` | objeto `chain` para publicClient Avalanche |
| `getAvalancheNetwork(opts?)` | `src/adapters/avalanche/chain.ts:22-28` | resuelve `'fuji' \| 'mainnet'` |
| `privateKeyToAccount(pk).address` | `viem/accounts` (patrón `gasless.ts:284`, `base/payment.ts:183`) | fallback treasury (DT-2) |
| `createPublicClient`, `http`, `getTransactionReceipt`, `getBlockNumber`, `getChainId`, `formatUnits`, `decodeEventLog`, `parseAbiItem` | `viem` (todas APIs estándar viem v2, ya instalado) | lectura on-chain |
| `supabase.rpc(name, params)` | `src/lib/supabase.js` (patrón `budget.ts:52-56,75-79`) | call a la PG fn |

**RPC URL env por chain (confirmado en los adapters — NO hardcodear, NO inventar nombres):**

| Chain | RPC URL env (confirmado) | Source |
|-------|--------------------------|--------|
| Kite testnet | `KITE_RPC_URL` | `kite-ozone/client.ts:9` |
| Kite mainnet | `KITE_MAINNET_RPC_URL ?? KITE_RPC_URL` | `.env.example:125`, Grounding §3 SDD |
| Avalanche mainnet | `AVALANCHE_RPC_URL` | `avalanche/payment.ts:139` |
| Avalanche fuji | `FUJI_RPC_URL` | `avalanche/payment.ts:140` |
| Base mainnet | `BASE_MAINNET_RPC_URL` | `base/payment.ts:159` |
| Base sepolia | `BASE_TESTNET_RPC_URL` | `base/payment.ts:160` |

---

## 3. Env vars NUEVAS (a documentar en `.env.example`, W3.2)

> NO hardcodear ningún valor en `src/`. Todo se lee de `process.env`. Defaults SEGUROS (fail-loud si falta lo crítico).

| Env var | Propósito | Default seguro | Notas |
|---------|-----------|----------------|-------|
| `A2A_DEPOSIT_MIN_CONFIRMATIONS` | confirmaciones mínimas global (fallback) | `1` (si no seteado) | testnet tolera 1; mainnet recomendado `3+` |
| `A2A_DEPOSIT_MIN_CONFIRMATIONS_KITE` | confirmaciones Kite | (cae al global) | opcional override por chain (DT-3) |
| `A2A_DEPOSIT_MIN_CONFIRMATIONS_AVALANCHE` | confirmaciones Avalanche | (cae al global) | opcional override por chain |
| `A2A_DEPOSIT_MIN_CONFIRMATIONS_BASE` | confirmaciones Base | (cae al global) | opcional override por chain |
| `A2A_DEPOSIT_TREASURY_KITE` | recipient esperado Kite | fallback `privateKeyToAccount(OPERATOR_PRIVATE_KEY).address` | DT-2 |
| `A2A_DEPOSIT_TREASURY_AVALANCHE` | recipient esperado Avalanche | fallback operator address | DT-2 |
| `A2A_DEPOSIT_TREASURY_BASE` | recipient esperado Base | fallback operator address | DT-2 |

**Resolución por chain (mapear `ChainKey` → familia de env):**
- `kite-ozone-testnet` / `kite-mainnet` → sufijo `_KITE`
- `avalanche-fuji` / `avalanche-mainnet` → sufijo `_AVALANCHE`
- `base-sepolia` / `base-mainnet` → sufijo `_BASE`

`.env.example` — agregar bloque cerca de `OPERATOR_PRIVATE_KEY` (`:222`) y el bloque RPC, con valores
**vacíos / placeholder** (sin secrets, sin addresses reales):

```bash
# ─────────────────────────────────────────────────────────────
# WKH-35 — Deposit verification (budget prepago)
# Recipient esperado del depósito por chain. Si no se setea, cae al
# operator address derivado de OPERATOR_PRIVATE_KEY (DT-2).
A2A_DEPOSIT_TREASURY_KITE=
A2A_DEPOSIT_TREASURY_AVALANCHE=
A2A_DEPOSIT_TREASURY_BASE=

# Confirmaciones mínimas antes de acreditar (DT-3).
# Global fallback + override por chain. Default 1 (testnet); 3+ recomendado en mainnet.
A2A_DEPOSIT_MIN_CONFIRMATIONS=1
A2A_DEPOSIT_MIN_CONFIRMATIONS_KITE=
A2A_DEPOSIT_MIN_CONFIRMATIONS_AVALANCHE=
A2A_DEPOSIT_MIN_CONFIRMATIONS_BASE=
```

---

## 4. Resolución de los 2 [TBD] del SDD

### TBD-1 (§4.2 SDD) — `SET search_path` en `SECURITY DEFINER` → **RESUELTO: SÍ, aplica.**

El repo exige hardening de `search_path` en funciones `SECURITY DEFINER`. Exemplar confirmado:
`supabase/migrations/20260427160000_secure_rpc_search_path.sql:8-12`:

```sql
ALTER FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric)
  SET search_path = public, pg_temp;
```

⚠️ **OJO — la firma vieja cambia.** Esa migración fija `search_path` sobre la firma
`(uuid, integer, numeric)`. La v2 tiene firma NUEVA `(uuid, integer, numeric, text, text, text)`.
Por eso en la migración nueva (W0.1) hay que **incluir el hardening sobre la firma v2** y los
GRANT/REVOKE equivalentes (ver SQL en §6 W0.1). NO dejes la fn v2 sin `SET search_path`.

### TBD-2 (§4.3 SDD) — objeto `chain` viem por chain → **RESUELTO con exemplars.**

| ChainKey | objeto `chain` viem | Confirmado en |
|----------|---------------------|---------------|
| `kite-ozone-testnet` | `getKiteChain()` (→ `kiteTestnet`, `defineChain`) | `kite-ozone/chain.ts:3,49-51` |
| `kite-mainnet` | `getKiteChain()` (→ `kiteMainnet`) | `kite-ozone/chain.ts:24,49-51` |
| `avalanche-fuji` | `getAvalancheChain('fuji')` (→ `avalancheFuji` de `viem/chains`) | `avalanche/chain.ts:1,30-32` |
| `avalanche-mainnet` | `getAvalancheChain('mainnet')` (→ `avalanche`) | `avalanche/chain.ts` |
| `base-sepolia` | `getBaseChain('testnet')` (→ `baseSepolia` de `viem/chains`) | `base/chain.ts:1,45-47` |
| `base-mainnet` | `getBaseChain('mainnet')` (→ `base`) | `base/chain.ts:45-47` |

> Nota: para el publicClient lo más simple y robusto es derivar el `chain` directamente del `ChainKey`
> con un dispatcher local en el verifier que reuse estos helpers. NO importes `viem/chains` directo en
> el verifier para Kite (Kite NO está en `viem/chains`, usa `defineChain`).

---

## 5. Constraint Directives (los 11 — aplicabilidad global)

| CD | Regla | Aplica en wave |
|----|-------|----------------|
| **CD-1 Ownership Guard** | toda lectura/mutación de `a2a_agent_keys` cruza `owner_ref`; `registerDeposit` recibe `ownerId: string` (NO `string\|undefined`); la PG fn v2 valida `v_owner IS DISTINCT FROM p_owner_ref`. | W0, W1, W2 |
| **CD-2 anti-replay atómico** | `UNIQUE(chain_id, tx_hash)` + INSERT-then-credit en UNA fn plpgsql; `unique_violation` → `RAISE EXCEPTION 'DEPOSIT_ALREADY_CREDITED'`. | W0 |
| **CD-3 sin hardcodes** | treasury, RPC URL, token addr, confirmaciones, topic `Transfer` → todo de env/config o derivado con viem. NUNCA literal. | W1, W3 |
| **CD-4 verify-before-credit** | NUNCA llamar `registerDeposit()` antes de que `verifyDeposit().ok===true`. El crédito usa `amountUsd` derivado on-chain, NO `body.amount`. | W2 |
| **CD-5 chain match** | `chainId` acreditado = `bundle.chainConfig.chainId`. NUNCA `body.chain_id` sin verificar; rechazar si `body.chain_id !== bundle.chainId`. | W1, W2 |
| **CD-6 viem, no ethers, TS strict** | lectura on-chain con viem; sin `any` explícito ni `as unknown`. | W1, W2 |
| **CD-7 no romper paths live** | NO tocar `increment_a2a_key_spend`, x402, debit. Cambio de firma de `registerDeposit` solo afecta el endpoint (estaba 501). | W0, W1 |
| **CD-8 mocks registry completos** | el `vi.mock` del verifier en `auth.test.ts` DEBE exportar `verifyDeposit` completo. Esta HU NO agrega fns al registry. Antes de cerrar: `grep -rn "vi.mock('.*deposit-verifier" src/`. | W3 |
| **CD-9 typecheck autoritativo** | gate = `tsc -p tsconfig.build.json --noEmit`. PROHIBIDO el `tsc --noEmit` pelado. | todas |
| **CD-10 decimals NO literal** | `formatUnits(atomic, token.decimals)` con `decimals` de `supportedTokens[0]`. PROHIBIDO `/1e18`, `/1e6`. Kite=18, Base/Avax=6. | W1 |
| **CD-11 delegación explícita** | afirmar por test los campos explícitos (`minConfirmations`, `decimals`), NO asumir defaults silenciosos. | W1, W3 |

---

## 6. Waves

> **Orden estricto: W0 → W1 → W2 → W3.** W1 depende de W0; W2 depende de W1; W3 cubre W1+W2.

---

### WAVE 0 (Serial Gate) — migración + error class + tipos del verifier

**Objetivo:** dejar listos los contratos sobre los que todo lo demás depende: la migración (tabla +
fn v2), el error class y los tipos del verifier. SIN lógica de verificación todavía.

#### W0.1 — `supabase/migrations/20260529000000_a2a_key_deposits.sql` (CREAR)

CDs: **CD-1, CD-2, CD-5, CD-7**. Exemplar: `20260406000000_a2a_agent_keys.sql` + `20260427160000_secure_rpc_search_path.sql`.

**SQL EXACTO a escribir:**

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

-- 3. Search-path hardening sobre la firma v2 (TBD-1 resuelto — patrón
--    20260427160000_secure_rpc_search_path.sql). SECURITY DEFINER sin
--    search_path fijo = schema-hijacking. Aplicar también GRANT/REVOKE.
ALTER FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric, text, text, text)
  SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric, text, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric, text, text, text)
  TO service_role;
```

> **Atomicidad (CD-2):** INSERT + UPDATE en el cuerpo de UNA fn plpgsql = una transacción. Si el INSERT
> colisiona con el UNIQUE, `RAISE EXCEPTION` aborta todo → cero crédito. Bajo concurrencia, `FOR UPDATE`
> serializa y el segundo INSERT colisiona → solo uno acredita.

#### W0.2 — `supabase/migrations/20260529000000_a2a_key_deposits_down.sql` (CREAR)

Exemplar: `20260406000000_a2a_agent_keys_down.sql`. **SQL EXACTO:**

```sql
-- ============================================================
-- Down Migration: 20260529000000_a2a_key_deposits
-- WKH-35: Drops the deposits table + restores register_a2a_key_deposit v1
-- Idempotent: safe to run multiple times
-- ============================================================

-- Drop the v2 function (firma nueva con 6 args).
DROP FUNCTION IF EXISTS register_a2a_key_deposit(UUID, INT, NUMERIC, TEXT, TEXT, TEXT);

-- Drop the anti-replay table (FK depende de a2a_agent_keys; se dropea primero).
DROP TABLE IF EXISTS a2a_key_deposits;

-- Restore v1 (sin owner_ref, sin txHash) — firma vieja (uuid, int, numeric).
CREATE OR REPLACE FUNCTION register_a2a_key_deposit(
  p_key_id UUID,
  p_chain_id INT,
  p_amount_usd NUMERIC
)
RETURNS TEXT AS $$
DECLARE
  v_budget JSONB;
  v_chain TEXT := p_chain_id::TEXT;
  v_current NUMERIC;
  v_new NUMERIC;
BEGIN
  SELECT budget INTO v_budget FROM a2a_agent_keys WHERE id = p_key_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'key_not_found'; END IF;
  v_current := COALESCE((v_budget ->> v_chain)::NUMERIC, 0);
  v_new := v_current + p_amount_usd;
  UPDATE a2a_agent_keys
  SET budget = jsonb_set(COALESCE(v_budget, '{}'::jsonb), ARRAY[v_chain], to_jsonb(v_new::TEXT))
  WHERE id = p_key_id;
  RETURN v_new::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Restore v1 search_path hardening (patrón 20260427160000).
ALTER FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric)
  TO service_role;
```

#### W0.3 — `src/services/security/errors.ts` (MODIFICAR — agregar `DepositAlreadyCreditedError`)

CDs: **CD-2**. Exemplar: `OwnershipMismatchError` (`errors.ts:9-15`).

Agregar (mismo patrón, código distinto):

```ts
export class DepositAlreadyCreditedError extends Error {
  readonly code = 'DEPOSIT_ALREADY_CREDITED' as const;
  constructor() {
    super('Deposit already credited');
    this.name = 'DepositAlreadyCreditedError';
  }
}
```

**Opcional (si CR lo pide):** agregar `'registerDeposit'` al union `OwnershipOp` (`errors.ts:22-26`).
NO es obligatorio para esta wave. Si NO lo agregás, en `budget.ts` usá `logOwnershipMismatch('getBalance', ...)`
(forma posicional) o simplemente lanzá `OwnershipMismatchError()` sin loguear.

#### W0.4 — `src/adapters/deposit-verifier.ts` (CREAR — SOLO tipos en W0)

CDs: **CD-6**. Exemplar: `src/adapters/types.ts`.

Definir el contrato (sin lógica). Tipos **exactos** (del SDD §4.3, confirmados):

```ts
import type { ChainKey, AdaptersBundle } from './types.js';

export type DepositVerificationReason =
  | 'TX_NOT_FOUND'
  | 'TX_REVERTED'
  | 'INSUFFICIENT_CONFIRMATIONS'
  | 'RECIPIENT_MISMATCH'
  | 'TOKEN_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'CHAIN_MISMATCH'
  | 'RPC_UNAVAILABLE';

export interface DepositVerification {
  ok: boolean;
  reason?: DepositVerificationReason;   // poblado solo si ok=false (AC-2)
  amountAtomic?: bigint;                // monto transferido en unidades atómicas
  amountUsd?: string;                   // amountAtomic formateado vía decimals del token (DT-6)
  token?: `0x${string}`;                // token contract verificado
  tokenSymbol?: string;                 // símbolo (supportedTokens[0].symbol) — para auditoría/registerDeposit
  recipient?: `0x${string}`;            // recipient verificado (== treasury esperado)
  confirmations?: number;
}

export interface VerifyDepositArgs {
  chainKey: ChainKey;
  bundle: AdaptersBundle;
  txHash: `0x${string}`;
  expectedAmountUsd?: string;           // body.amount declarado (opcional; comparar → AMOUNT_MISMATCH)
}

export async function verifyDeposit(
  args: VerifyDepositArgs,
): Promise<DepositVerification>;
```

> En W0 podés stubear el cuerpo con `throw new Error('not implemented')` para que typecheckee, o dejar
> el contrato como declaración y completar en W1. Lo importante: el tipo `DepositVerification` y la firma
> `verifyDeposit` quedan fijos para que W1/W2 dependan de ellos.

**DoD W0:**
- [ ] Los 2 archivos SQL creados (up + down).
- [ ] `DepositAlreadyCreditedError` exportado en `errors.ts`.
- [ ] `deposit-verifier.ts` exporta `DepositVerification`, `DepositVerificationReason`, `VerifyDepositArgs`, `verifyDeposit`.
- [ ] `tsc -p tsconfig.build.json --noEmit` limpio (CD-9).
- [ ] Sin `any` (CD-6).

---

### WAVE 1 (Parallelizable) — verifier + service

**Objetivo:** implementar la lectura on-chain (`verifyDeposit`) y la firma nueva de `registerDeposit`.
W1.1 depende de W0.4; W1.2 depende de W0.1 + W0.3.

#### W1.1 — `src/adapters/deposit-verifier.ts` (IMPLEMENTAR lógica)

CDs: **CD-3, CD-4 (provee el gate), CD-5, CD-6, CD-10, CD-11**.
Exemplar: `kite-ozone/client.ts` (publicClient lazy) + `gasless.ts:280-300` (`privateKeyToAccount`, `readContract` try/catch).

**Mecánica (sin `any`):**

1. **publicClient por chain — lazy cache `Map<ChainKey, PublicClient>`.** Construir con
   `createPublicClient({ chain, transport: http(rpcUrl) })`.
   - `chain` por `ChainKey` (TBD-2 resuelto, §4): dispatcher local que reusa `getKiteChain()` /
     `getBaseChain(network)` / `getAvalancheChain(network)`. Para Kite mainnet vs testnet, derivar el
     network del `ChainKey` (`kite-mainnet` → mainnet). Idem Base/Avax.
   - `rpcUrl` por `ChainKey` desde la MISMA env-resolution del adapter (tabla §2). Si el RPC URL es
     `undefined` → devolver `{ ok: false, reason: 'RPC_UNAVAILABLE' }` (fail-loud, NO acreditar — CD-4).
   - Agregá un export `_resetVerifier()` TEST-ONLY que limpie el cache (patrón `_resetClient()` de
     `kite-ozone/client.ts:41-44` y `_resetWalletClient()` de `base/payment.ts:459-464`).
2. `receipt = await client.getTransactionReceipt({ hash: txHash })` dentro de try/catch → si throw /
   no encontrado → `{ ok:false, reason:'TX_NOT_FOUND' }`.
3. `if (receipt.status !== 'success') → { ok:false, reason:'TX_REVERTED' }` (AC-2).
4. **chainId match (AC-4 / CD-5):** `const onchainChainId = await client.getChainId()` (o `chain.id`).
   Afirmar `onchainChainId === bundle.chainConfig.chainId`; si no → `{ ok:false, reason:'CHAIN_MISMATCH' }`.
5. **confirmaciones (DT-3 / CD-11):** `const latest = await client.getBlockNumber()`;
   `const confirmations = Number(latest - receipt.blockNumber) + 1`;
   `const min = resolveMinConfirmations(chainKey)` (lee `A2A_DEPOSIT_MIN_CONFIRMATIONS_<FAMILIA>` →
   fallback `A2A_DEPOSIT_MIN_CONFIRMATIONS` → fallback `1`, parseado con `Number.parseInt`, validar `>=1`).
   Si `confirmations < min` → `{ ok:false, reason:'INSUFFICIENT_CONFIRMATIONS', confirmations }`.
6. **token + recipient + amount (AC-1):**
   - `const token = bundle.payment.supportedTokens[0]` → `token.address` (esperado), `token.decimals`, `token.symbol`.
   - `const expectedTreasury = resolveTreasury(chainKey)` = `A2A_DEPOSIT_TREASURY_<FAMILIA>` (validar
     formato `0x[0-9a-fA-F]{40}` con un `ADDRESS_RE` como `base/payment.ts:78`); fallback
     `privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY as \`0x${string}\`).address` (DT-2). Si no hay
     treasury NI operator key → tratar como `RECIPIENT_MISMATCH` (fail-loud, cero crédito).
   - Recorrer `receipt.logs`; buscar el log emitido por `token.address` (comparar lowercase) cuyo evento
     sea ERC-20 `Transfer(address indexed from, address indexed to, uint256 value)` y `to == expectedTreasury`.
   - Decodificar con viem `decodeEventLog({ abi: [transferAbiItem], data, topics })` donde
     `transferAbiItem = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')`.
     **NO hardcodear el topic0** (CD-3) — viem lo deriva del ABI.
   - Si no hay un log del `token.address` → `{ ok:false, reason:'TOKEN_MISMATCH' }`.
   - Si hay log del token pero ningún `to == expectedTreasury` → `{ ok:false, reason:'RECIPIENT_MISMATCH' }`.
   - El `value` del log es `amountAtomic: bigint`.
7. **amount → USD (DT-6 / CD-10):** `const amountUsd = formatUnits(amountAtomic, token.decimals)`.
   PROHIBIDO literal (`/1e18`). Si `args.expectedAmountUsd` está presente, comparar contra `amountUsd`
   (normalizar ambos antes de comparar, p.ej. `Number(a) === Number(b)` o string normalizado — VERIFICAR
   tolerancia con CR; el SDD pide "string normalizado"); si difiere → `{ ok:false, reason:'AMOUNT_MISMATCH' }`.
8. **éxito:** `{ ok:true, amountAtomic, amountUsd, token: token.address, tokenSymbol: token.symbol, recipient: expectedTreasury, confirmations }`.

> El crédito SIEMPRE usa el `amountUsd` derivado on-chain, NUNCA `body.amount` (CD-4).
> Por qué leer el log y no `tx.value`: los depósitos son ERC-20 (PYUSD/USDC), no native value.

**Helpers locales sugeridos (no inventar APIs externas):**
- `resolveChainFamilyEnvSuffix(chainKey): 'KITE' | 'AVALANCHE' | 'BASE'`
- `resolveMinConfirmations(chainKey): number`
- `resolveTreasury(chainKey): \`0x${string}\` | null`
- `getVerifierClient(chainKey): PublicClient | null` (lazy cache + RPC url resolution)

#### W1.2 — `src/services/budget.ts` (MODIFICAR `registerDeposit`)

CDs: **CD-1, CD-7**. Exemplar: firma actual (`budget.ts:70-84`) + `getBalance` ownership (`:19-41`).

**Firma final EXACTA (confirmada contra SDD §4.3):**

```ts
async registerDeposit(
  keyId: string,
  chainId: number,
  amountUsd: string,
  ownerId: string,   // CD-1 — NO `string | undefined`
  txHash: string,    // CD-2
  token?: string,
): Promise<string>
```

**Implementación:**
- Importar `DepositAlreadyCreditedError` (y `OwnershipMismatchError` ya está importado) de `./security/errors.js`.
- `const { data, error } = await supabase.rpc('register_a2a_key_deposit', { p_key_id: keyId, p_chain_id: chainId, p_amount_usd: parseFloat(amountUsd), p_owner_ref: ownerId, p_tx_hash: txHash, p_token: token ?? null });`
- Mapeo de errores (`error.message` viene del `RAISE EXCEPTION` de la PG fn):
  - `if (error)`:
    - contiene `'DEPOSIT_ALREADY_CREDITED'` → `throw new DepositAlreadyCreditedError();`
    - contiene `'OWNERSHIP_MISMATCH'` → `throw new OwnershipMismatchError();` (opcional `logOwnershipMismatch('getBalance', keyId, ownerId)` — ver W0.3)
    - else → `throw new Error(\`Failed to register deposit: ${error.message}\`);` (preserva el contrato actual)
- `return data as string;`

> El único call-site de `registerDeposit` era el endpoint (501). Verificar en F3:
> `grep -rn "registerDeposit" src/` → debe aparecer SOLO en `budget.ts`, `auth.ts` (W2) y los tests (CD-7).

**DoD W1:**
- [ ] `verifyDeposit` implementado, devuelve `DepositVerification` para las 3 chains.
- [ ] `registerDeposit` con firma nueva, mapeo de errores correcto.
- [ ] `tsc -p tsconfig.build.json --noEmit` limpio (CD-9), sin `any` (CD-6).
- [ ] Tests unit de W1 verdes (ver §6 W3 — los tests se escriben en W3 pero validan W1).

---

### WAVE 2 (Integración) — endpoint `POST /auth/deposit`

**Objetivo:** reescribir el handler 501 por el flujo real, orquestando verify → registerDeposit.
Depende de W1.1 + W1.2.

#### W2.1 — `src/routes/auth.ts` (MODIFICAR handler `/deposit` + re-habilitar import)

CDs: **CD-1, CD-4, CD-5**. Exemplar: handler `/me` (`auth.ts:114-141`) + `resolveCallerKey` (`:21-45`).

**Imports a re-habilitar / agregar (arriba del archivo):**

```ts
import { budgetService } from '../services/budget.js';
import { verifyDeposit } from '../adapters/deposit-verifier.js';
import { resolveChainKey, normalizeChainSlug } from '../adapters/chain-resolver.js';
import { getAdaptersBundle } from '../adapters/registry.js';
import {
  OwnershipMismatchError,
  DepositAlreadyCreditedError,
} from '../services/security/errors.js';
import type { DepositInput } from '../types/index.js';
```

> VERIFICAR el path exacto de `DepositInput` en el barrel: el SDD/types lo definen en
> `src/types/a2a-key.ts:42-48`. Confirmá si se re-exporta desde `src/types/index.js` (si no, importá
> desde `'../types/a2a-key.js'`). NO inventes el path.

**Reemplazar el bloque `auth.ts:98-109` por el flujo §4.4 (7 pasos):**

```ts
fastify.post('/deposit', async (req: FastifyRequest, reply: FastifyReply) => {
  // 1. Auth — mismo helper que /me.
  const callerKey = await resolveCallerKey(req);
  if (!callerKey?.is_active) {
    return reply.status(403).send({ error: 'Invalid or inactive API key' });
  }
  const ownerRef = callerKey.owner_ref;

  // 2. Validar input (DepositInput).
  const body = req.body as Partial<DepositInput> | undefined;
  const txHash = body?.tx_hash;
  const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
  if (
    !body ||
    typeof body.key_id !== 'string' || body.key_id.trim() === '' ||
    typeof txHash !== 'string' || !TX_HASH_RE.test(txHash) ||
    typeof body.chain_id !== 'number' || !Number.isFinite(body.chain_id)
  ) {
    return reply.status(400).send({ error_code: 'INVALID_INPUT' });
  }

  // 2b. Ownership pre-check (defense-in-depth, CD-1): un caller solo fondea SU key.
  if (body.key_id !== callerKey.id) {
    return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
  }

  // 3. Resolver chain + bundle (DT-5 / AC-6 / CD-5).
  const headerChain = req.headers['x-payment-chain'];
  const chainKey =
    typeof headerChain === 'string'
      ? resolveChainKey({ headerOverride: headerChain })
      : normalizeChainSlug(String(body.chain_id));
  if (!chainKey) {
    return reply.status(400).send({ error_code: 'CHAIN_NOT_SUPPORTED' });
  }
  const bundle = getAdaptersBundle(chainKey);
  if (!bundle) {
    return reply.status(400).send({ error_code: 'CHAIN_NOT_SUPPORTED' });
  }
  const chainId = bundle.chainConfig.chainId; // CD-5

  // 4. chain_id match (AC-4).
  if (body.chain_id !== chainId) {
    return reply.status(400).send({ error_code: 'CHAIN_MISMATCH' });
  }

  // 5. Verificar on-chain ANTES de acreditar (AC-1 / CD-4).
  const result = await verifyDeposit({
    chainKey,
    bundle,
    txHash: txHash as `0x${string}`,
    expectedAmountUsd: body.amount,
  });
  if (!result.ok || result.amountUsd === undefined) {
    const status = result.reason === 'RPC_UNAVAILABLE' ? 503 : 400;
    return reply.status(status).send({ error_code: result.reason ?? 'VERIFICATION_FAILED' });
  }

  // 6. Acreditar atómico (AC-3 / AC-5). NUNCA antes del verify (CD-4).
  try {
    const balance = await budgetService.registerDeposit(
      callerKey.id,
      chainId,
      result.amountUsd,
      ownerRef,
      txHash,
      result.tokenSymbol,
    );
    // 7. Respuesta (DepositResponse).
    return reply.status(200).send({ balance, chain_id: chainId });
  } catch (err) {
    if (err instanceof DepositAlreadyCreditedError) {
      return reply.status(409).send({ error_code: 'DEPOSIT_ALREADY_CREDITED' });
    }
    if (err instanceof OwnershipMismatchError) {
      return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
    }
    fastify.log.error(
      { errorClass: err instanceof Error ? err.constructor.name : 'unknown' },
      'deposit failed',
    );
    return reply.status(500).send({ error_code: 'DEPOSIT_FAILED' });
  }
});
```

> El bloque de comentario `BLQ-5` (`:95-96`) y el import comentado de `budgetService` (`:15-16`) se
> quitan. La doc-string del archivo (`:6 POST /deposit`) se puede actualizar a "real deposit".

**Mapa de errores HTTP (confirmá contra §4.5 SDD):**

| Condición | HTTP | body |
|-----------|------|------|
| No auth / key inactiva | 403 | `{error:'Invalid or inactive API key'}` |
| Input inválido | 400 | `{error_code:'INVALID_INPUT'}` |
| `body.key_id !== callerKey.id` | 403 | `{error_code:'OWNERSHIP_MISMATCH'}` |
| Chain no soportada/inicializada | 400 | `{error_code:'CHAIN_NOT_SUPPORTED'}` |
| `body.chain_id !== bundle.chainId` | 400 | `{error_code:'CHAIN_MISMATCH'}` |
| Verify falla (no RPC) | 400 | `{error_code:<reason>}` |
| RPC caído | 503 | `{error_code:'RPC_UNAVAILABLE'}` |
| tx ya acreditada | 409 | `{error_code:'DEPOSIT_ALREADY_CREDITED'}` |
| key de otro owner (DB-level) | 403 | `{error_code:'OWNERSHIP_MISMATCH'}` |

**DoD W2:**
- [ ] Handler real reemplaza el 501; import `budgetService` re-habilitado.
- [ ] Flujo respeta CD-4 (verify antes de credit), CD-5 (chainId del bundle).
- [ ] `tsc -p tsconfig.build.json --noEmit` limpio (CD-9), sin `any`.
- [ ] Tests e2e del endpoint verdes (se escriben en W3).

---

### WAVE 3 (Final) — tests + docs env

**Objetivo:** cubrir los 19 tests del plan, actualizar tests legacy, documentar env. Depende de W1+W2.

#### W3.1 — Tests

**Cómo mockear (exemplars confirmados — NO inventar):**
- **viem publicClient** → `vi.mock('viem', async (importOriginal) => { const actual = await importOriginal<typeof import('viem')>(); return { ...actual, createPublicClient: vi.fn(() => ({ getTransactionReceipt, getBlockNumber, getChainId })) }; })`. El `...actual` CONSERVA `formatUnits`, `decodeEventLog`, `parseAbiItem`, `http`. Exemplar: `src/adapters/__tests__/base.test.ts:21-30`. (Para Kite `defineChain` la variante de `kite-client.test.ts:8-12` también sirve, pero acá necesitás `formatUnits`/`decodeEventLog` reales → usá `importOriginal`.)
- **supabase** → `vi.mock('../lib/supabase.js', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }))` + `mockRpc.mockResolvedValue({ data, error })`. Exemplar: `src/services/budget.test.ts:10-15`.
- **route** → `Fastify()` + `app.register(authRoutes, { prefix: '/auth' })` + `app.inject(...)`. Mock de `../services/identity.js`, `../services/budget.js` y (NUEVO) `../adapters/deposit-verifier.js`. Exemplar: `src/routes/auth.test.ts:22-36, 80-93`. Helper `makeKeyRow()` (`:52-76`), `TEST_KEY` (`:45`), `TEST_KEY_ID` (`:50`).

**`src/adapters/deposit-verifier.test.ts` (CREAR) — 9 tests (W1):**

| # | Test | AC | Cómo mockear |
|---|------|----|--------------|
| T1 | verify OK → `{ok:true, amountUsd, recipient, token, tokenSymbol}` (las 3 chains: Kite 18 dec, Avax/Base 6 dec) | AC-1, AC-6 | receipt fixture `status:'success'` + log `Transfer` al treasury; `getChainId`→chainId del bundle; `getBlockNumber` ≥ blockNumber + min |
| T2 | receipt `status:'reverted'` → `TX_REVERTED` | AC-2 | receipt `status:'reverted'` |
| T3 | `getTransactionReceipt` throw → `TX_NOT_FOUND` | AC-2 | `mockGetReceipt.mockRejectedValue(...)` |
| T4 | confirmaciones < min → `INSUFFICIENT_CONFIRMATIONS` | AC-2 | `getBlockNumber` < `blockNumber + min`; setear `A2A_DEPOSIT_MIN_CONFIRMATIONS=3` |
| T5 | recipient != treasury → `RECIPIENT_MISMATCH` | AC-2 | log `Transfer` con `to` distinto del treasury |
| T6 | token != supportedTokens[0] → `TOKEN_MISMATCH` | AC-2 | log emitido por otra `address` |
| T7 | amount declarado != on-chain → `AMOUNT_MISMATCH` | AC-2 | pasar `expectedAmountUsd` distinto del log value |
| T8 | decimals correcto por chain: PYUSD 18 → USD, USDC 6 → USD (CD-10/CD-11) | AC-1 | dos casos: `value` con 18 dec (Kite) y 6 dec (Base); assert `amountUsd` exacto |
| T9 | RPC URL ausente → `RPC_UNAVAILABLE` | AC-2 | `delete process.env.<RPC_URL>` antes de invocar; usar `_resetVerifier()` |

> El verifier lee `process.env` para RPC/treasury/confirmaciones → setear/borrar env en `beforeEach`/`afterEach`
> y llamar `_resetVerifier()` (CD-11: afirmar, no asumir). Guardá/restaurá `ORIGINAL_ENV` como en
> `kite-client.test.ts:36-52`.

**`src/services/budget.test.ts` (MODIFICAR) — actualizar + 3 tests (W1):**

> ⚠️ El test existente (`budget.test.ts:157-173`) llama `registerDeposit('key-1', 2368, '10.00')` con
> 3 args y espera `rpc(..., {p_key_id, p_chain_id, p_amount_usd})`. **HAY QUE ACTUALIZARLO** a la firma
> nueva (6 args) y los params nuevos.

| # | Test | AC | Assert |
|---|------|----|--------|
| T10 | `registerDeposit(keyId, chainId, amountUsd, ownerId, txHash, token)` pasa `p_owner_ref`+`p_tx_hash`+`p_token` a rpc; retorna balance | AC-1, AC-5 | `expect(mockRpc).toHaveBeenCalledWith('register_a2a_key_deposit', { p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_tx_hash, p_token })` |
| T11 | rpc error msg con `DEPOSIT_ALREADY_CREDITED` → `DepositAlreadyCreditedError` | AC-3 | `rejects.toThrow(DepositAlreadyCreditedError)` |
| T12 | rpc error msg con `OWNERSHIP_MISMATCH` → `OwnershipMismatchError` | AC-5 | `rejects.toThrow(OwnershipMismatchError)` |
| (existente) | actualizar el test BLQ-4 a la firma de 6 args | AC-10 | params nuevos |

**`src/routes/auth.test.ts` (MODIFICAR) — reemplazar test del 501 + agregar (W3):**

> ⚠️ Reemplazar el test `:138-156` (que espera 501) por el set abajo. Agregar
> `vi.mock('../adapters/deposit-verifier.js', () => ({ verifyDeposit: vi.fn() }))` (CD-8: export completo)
> y mock de `getAdaptersBundle` si el handler lo invoca real (mock de `../adapters/registry.js`).
> El mock de `budgetService.registerDeposit` ya existe (`:30-36`).

| # | Test | AC | Setup clave |
|---|------|----|-------------|
| T13 | happy path → 200 + `{balance, chain_id}` | AC-1 | `lookupByHash`→keyRow; `verifyDeposit`→`{ok:true, amountUsd:'10', tokenSymbol:'PYUSD'}`; `getAdaptersBundle`→bundle con `chainConfig.chainId:2368`; `registerDeposit`→`'10.000000'` |
| T14 | verify fail → 4xx + `registerDeposit` NO llamado (CD-4) | AC-2 | `verifyDeposit`→`{ok:false, reason:'TX_REVERTED'}`; `expect(mockRegisterDeposit).not.toHaveBeenCalled()` |
| T15 | replay → 409 `DEPOSIT_ALREADY_CREDITED` | AC-3 | `registerDeposit`→`mockRejectedValue(new DepositAlreadyCreditedError())` |
| T16 | `body.chain_id != bundle.chainId` → 400 `CHAIN_MISMATCH` | AC-4 | bundle chainId 2368, body.chain_id 43113 (mismo chainKey resuelto pero mismatch — VERIFICAR setup: usar header `x-payment-chain` para forzar el chainKey y mandar `chain_id` distinto) |
| T17 | key de otro owner → 403 ownership | AC-5 | `body.key_id` != `callerKey.id` (pre-check) O `registerDeposit`→`OwnershipMismatchError` (DB-level) — cubrir ambos si posible |
| T18 | chain no inicializada → 400 `CHAIN_NOT_SUPPORTED` | AC-6 | `getAdaptersBundle`→`undefined` |
| T19 | sin auth → 403 | AC-1 | sin header `x-a2a-key`; `lookupByHash` no resuelve |

#### W3.2 — `.env.example` (documentar env nuevas)

Agregar el bloque de §3 (treasury + confirmaciones) cerca de `OPERATOR_PRIVATE_KEY` (`.env.example:222`)
y/o del bloque RPC. **Sin valores reales, sin secrets** (placeholders vacíos / `1` para confirmaciones).

**DoD W3:**
- [ ] `npm test` full verde (los 19 tests + suite existente sin regresiones).
- [ ] `tsc -p tsconfig.build.json --noEmit` limpio (CD-9).
- [ ] `grep -rn "registerDeposit" src/` → solo `budget.ts`, `auth.ts`, tests (CD-7).
- [ ] `grep -rn "vi.mock('.*deposit-verifier" src/` → el mock exporta `verifyDeposit` (CD-8).
- [ ] `.env.example` documenta las 7 env nuevas sin valores reales.
- [ ] Sin `any` ni `as unknown` en producción (CD-6).

---

## 7. Definition of Done (global de la HU)

- [ ] Los 10 archivos de §1 creados/modificados, ninguno fuera de scope.
- [ ] `tsc -p tsconfig.build.json --noEmit` limpio (CD-9).
- [ ] `npm test` verde (19 tests del plan + sin regresiones).
- [ ] Sin `any` explícito ni `as unknown` (CD-6); viem, no ethers.
- [ ] CD-1..CD-11 cumplidos y verificables.
- [ ] Cero crédito sin verify (CD-4); cero doble crédito (CD-2); cero cross-tenant (CD-1).
- [ ] `increment_a2a_key_spend`, x402 y debit per-step intactos (CD-7).
- [ ] `DepositInput`/`DepositResponse` reusados, NO redefinidos.
- [ ] Env nuevas en `.env.example`, sin secrets, sin hardcode en `src/` (CD-3).

---

## 8. Notas de verificación pendientes para el Dev (NO inventar)

1. **`DepositInput` import path** — confirmar si `src/types/index.js` re-exporta `DepositInput`/`DepositResponse`
   (definidos en `src/types/a2a-key.ts:42-48,71-74`). Si NO, importar desde `'../types/a2a-key.js'`. — VERIFICAR en `src/types/index.ts`.
2. **`x-payment-chain` header** — el flujo usa `req.headers['x-payment-chain']`. Confirmar que el deposit
   NO pasa por el middleware `requirePaymentOrA2AKey` (el endpoint auth-inline con `resolveCallerKey`,
   como `/me`). El header se lee directo del request. — Confirmado: `/me` y `/deposit` NO usan ese middleware (`auth.ts`).
3. **`getChainId` vs `chain.id`** — para el chainId match (W1.1 paso 4) elegí UNO: `await client.getChainId()`
   (RPC call, mockeable) es lo que usan los exemplars (`kite-client.test.ts`). — VERIFICAR cuál mockeás en T1.
4. **Tolerancia de `AMOUNT_MISMATCH`** — el SDD dice "string normalizado"; decidir con CR si comparar como
   `Number()` o string canónico. Por defecto, comparar `Number(amountUsd) === Number(expectedAmountUsd)`. — VERIFICAR con Adversary/CR.
```
