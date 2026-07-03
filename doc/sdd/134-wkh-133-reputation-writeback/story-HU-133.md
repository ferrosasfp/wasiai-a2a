# Story File — [WKH-133] Reputation write-back on-chain a ERC-8004

> **Fase F2.5 (Architect → Dev).** Este documento es un **contrato autocontenido**.
> `nexus-dev` implementa SOLO leyendo este archivo. Si algo no está acá, no se hace.
> Fuente: `sdd.md` (misma carpeta). Mode **QUALITY / full**. Money-adjacent + on-chain write + operator key → rigor máximo.
> **Alcance CERRADO (no re-abrir):** forward-only, Base-only v1, flag `ERC8004_REPUTATION_WRITEBACK_ENABLED` **default OFF**, reusar `OPERATOR_PRIVATE_KEY`.

---

## 1. Contexto compacto — qué se construye y por qué

Hoy todo el código ERC-8004 es **read-only** (`src/adapters/erc8004-reputation.ts` invoca `getSummary`, una `view`).
Esta HU agrega el **write path**: tras un evento settleado con éxito (`a2a_events.status='success' AND cost_usdc>0`), el sistema firma y envía **best-effort, async, idempotente** una `giveFeedback(...)` al `ReputationRegistry` ERC-8004 en Base, **sin tocar el hot-path** de `/compose`/`/orchestrate`/`/a2a`.

La escritura:
- Corre **detached** (fire-and-forget, no-await) dentro de `eventService.track()`.
- Es **idempotente** por `event_id` (UNIQUE + `ON CONFLICT DO NOTHING` **antes** de la tx → nunca doble-gasto de gas).
- Es **fail-open**: cualquier error se loguea server-side con código corto y NUNCA marca el evento/settlement subyacente como `failed`.
- Está **100% gated** detrás de `ERC8004_REPUTATION_WRITEBACK_ENABLED` (default OFF). Sin configurar → comportamiento idéntico a hoy (cero tx).

---

## 2. Firma on-chain (RESUELTA en F2 — re-verificar en W0)

```
giveFeedback(
  uint256 agentId,
  int128  value,
  uint8   valueDecimals,
  string  tag1,
  string  tag2,
  string  endpoint,
  string  feedbackURI,
  bytes32 feedbackHash
)  // nonpayable → emite event NewFeedback
```

Verificada contra `abis/ReputationRegistry.json` del repo oficial `erc-8004/erc-8004-contracts@main` (misma fuente que `getSummary` en `erc8004-reputation.ts:22-29`).

**`[VERIFY-AT-IMPL]` (W0.3):** el Dev DEBE re-leer `abis/ReputationRegistry.json` de `erc-8004/erc-8004-contracts@main` y dejar el comentario `// [VERIFY-AT-IMPL resuelto: giveFeedback(...) verificado contra erc-8004/erc-8004-contracts@main, <fecha>]` (patrón idéntico a `erc8004-reputation.ts:60-62`). Si la address desplegada apunta a un ABI distinto → el `writeContract` fallará limpio → fail-open (no rompe nada). NO asumir nada más allá de esta firma.

**Mapping determinista (DT-7) — un evento settleado = un `giveFeedback` con:**

| Campo | Valor v1 | Tipo | Nota |
|---|---|---|---|
| `agentId` | token_id del binding | `uint256`/`bigint` | resuelto vía DT-6, NUNCA hardcode |
| `value` | `100n` | `int128` | señal positiva máxima por task pagada completada |
| `valueDecimals` | `0` | `uint8` | el contrato agrega los per-feedback en `getSummary` |
| `tag1` | `"wasiai"` | `string` | constante del módulo |
| `tag2` | `event.eventType` | `string` | `"compose_step"` \| `"orchestrate_goal"` (valores reales verificados) |
| `endpoint` | `""` | `string` | |
| `feedbackURI` | `""` | `string` | |
| `feedbackHash` | `zeroHash` | `bytes32` | import `{ zeroHash }` from `'viem'` — **`[VERIFY-AT-IMPL]` confirmar export en viem v2** |

Estas constantes viven en el módulo (documentadas), NO en env (no son address/rpc/secret → no aplica CD-4).

---

## 3. Scope IN — archivos exactos a tocar

**Crear:**
1. `supabase/migrations/2026XXXX_wkh133_reputation_writebacks.sql` (+ `..._down.sql`) — tabla idempotencia.
2. `src/adapters/erc8004-reputation-writer.ts` — adapter puro de escritura.
3. `src/adapters/erc8004-reputation-writer.test.ts` — tests del adapter.
4. `src/services/reputation-writeback.ts` — servicio orquestador (secuencia DT-5).
5. `src/services/reputation-writeback.test.ts` — tests del servicio.

**Modificar:**
6. `src/types/database.types.ts` — agregar tipo de la tabla `a2a_reputation_writebacks`.
7. `src/services/identity.ts` — agregar helper `resolveErc8004AgentId(slug, chainId)`.
8. `src/services/event.ts` — hook fire-and-forget en `track()`.
9. `src/services/event.test.ts` (extender o crear) — tests del hook.
10. `src/services/identity.test.ts` (extender) — tests del helper.
11. `.env.example` — 2 vars nuevas.

**NO tocar:** `erc8004-reputation.ts`, `erc8004-identity.ts` (permanecen read-only — CD-7), `reputation.ts` (fórmula off-chain intacta), `compose.ts`/`orchestrate.ts` (el hook vive en `track()`, single-point). `src/lib/env.ts` **no requiere cambios** (su lista `required` es solo secrets críticos en prod; las vars nuevas son opcionales/default-OFF).

---

## 4. Anti-Hallucination Checklist (verificado por el Architect — el Dev CONFIRMA en impl)

| Símbolo / path | Estado | Fuente verificada |
|---|---|---|
| `src/adapters/erc8004-reputation.ts` | EXISTE | Read ✔ |
| `resolveReputationRegistryAddress(network)` | EXISTE, exportada | `erc8004-reputation.ts:87` |
| `getBaseChain(network)`, `getBaseNetwork()` | EXISTEN | `src/adapters/base/chain.ts` (import en `erc8004-reputation.ts:38`) |
| `privateKeyToAccount`, `createWalletClient`, `http` | viem v2 | `gasless.ts:2-3`, `base/payment.ts:200-215` |
| `zeroHash` from `'viem'` | **`[VERIFY-AT-IMPL]`** | no usado hoy en `src/` — Dev confirma el export en viem v2 |
| `walletClient.writeContract(...)` | viem v2 | patrón `base/payment.ts` (write real con operator key) |
| `publicClient.waitForTransactionReceipt(...)` | **`[VERIFY-AT-IMPL]`** | no usado hoy en `src/` — Dev confirma la API viem v2 (nombre y shape del receipt) |
| `publicClient.getChainId()` | EXISTE | `erc8004-reputation.ts:172` |
| `ContractFunctionExecutionError` from `'viem'` | EXISTE | `erc8004-reputation.ts:33` |
| `OPERATOR_PRIVATE_KEY` (env) | EXISTE | `.env.example:284`, `env.ts:85` |
| `ERC8004_REPUTATION_REGISTRY_ADDRESS[_BASE_MAINNET\|_BASE_SEPOLIA]` | EXISTEN | `.env.example:591-594` |
| `BASE_MAINNET_RPC_URL` / `BASE_TESTNET_RPC_URL` | EXISTEN | `erc8004-reputation.ts:100-102` |
| `eventService.track()` retorna `A2AEvent` (con `.id`) | EXISTE | `event.ts:53-89` |
| `A2AEvent` shape (`id, eventType, agentId, agentName, registry, status, costUsdc, metadata`) | EXISTE | `event.ts:29-44` |
| `Erc8004IdentityBinding` (`token_id:string, chain_id:number, agent_registry?, agent_slug?`) | EXISTE | `src/types/a2a-key.ts:47-65` |
| `normalizeSlug(s)` | EXISTE (privada en identity.ts) | `identity.ts:29` — reusable dentro del mismo módulo |
| `a2a_agent_keys.erc8004_identity` (jsonb) | EXISTE | `identity.ts:357-361` |
| tabla `a2a_reputation_writebacks` | **NO existe — se crea en W0.1** | — |
| `supabase` client + `SUPABASE_SERVICE_KEY` (BYPASSRLS) | EXISTE | `src/lib/supabase.js` (import `event.ts:6`) |
| Migración patrón (`IF NOT EXISTS`, índice, RLS enable) | EXISTE | `supabase/migrations/20260628000000_wkh54_tasks_owner_ref.sql` |
| Test source-scan pattern | EXISTE | `erc8004-reputation.test.ts:152-179` |

**Regla dura:** si un `[VERIFY-AT-IMPL]` no se confirma en runtime/compilación, el Dev lo resuelve leyendo el ABI/viem — **NUNCA inventa la API**.

---

## 5. Constraint Directives — checklist INVIOLABLE

**Heredados del work-item:**
- [ ] **CD-1**: PROHIBIDO bloquear la respuesta de `/compose`/`/orchestrate`/`/a2a` esperando la tx. La llamada en `track()` es NO awaited.
- [ ] **CD-2**: PROHIBIDO doble-write por evento. OBLIGATORIO el claim `INSERT ... ON CONFLICT (event_id) DO NOTHING` **ANTES** de la tx. Ante fallo, PROHIBIDO reintento síncrono en el mismo request.
- [ ] **CD-3**: OBLIGATORIO fail-open. Todo error RPC/contrato/gas → log server-side con **código corto** (NUNCA `error.message` crudo a ningún caller) y NUNCA marca el evento/task subyacente como `failed`.
- [ ] **CD-4**: PROHIBIDO hardcodear registry address / RPC URL / chain params. Todo desde env (resolvers existentes).
- [ ] **CD-5**: OBLIGATORIO gate detrás de `ERC8004_REPUTATION_WRITEBACK_ENABLED` default OFF. Sin configurar → cero tx.
- [ ] **CD-6**: PROHIBIDO exponer el operator private key o material de firma en logs/respuestas/metadata. SOLO `txHash` puede loguearse/persistirse. El result del writer NUNCA incluye pk ni `account`.

**Nuevos del SDD:**
- [ ] **CD-7**: `erc8004-reputation-writer.ts` es el ÚNICO módulo autorizado a `createWalletClient`/`writeContract` para reputación. `erc8004-reputation.ts` y `erc8004-identity.ts` PERMANECEN read-only — PROHIBIDO agregarles escritura.
- [ ] **CD-8**: OBLIGATORIO guard `getChainId()` **antes** de `writeContract` → `CHAIN_MISMATCH` sin tx si la red no coincide.
- [ ] **CD-9**: `agentId` on-chain SOLO vía binding verificado (DT-6). PROHIBIDO escribir feedback para slug sin identidad ERC-8004 o con resolución ambigua (0/>1 match) → skip.
- [ ] **CD-10**: `a2a_reputation_writebacks` NO lleva `owner_ref` (estado de sistema global). PROHIBIDO exponerla por ruta HTTP. RLS `ENABLE` deny-by-default. **(Nota para AR: la ausencia de `owner_ref` es intencional y correcta — NO es IDOR.)**

**Derivados del Auto-Blindaje histórico (prevención de errores documentados):**
- [ ] **CD-11**: PROHIBIDO non-null assertions (`x!.y`) — el codebase los prohíbe (`lint/style/noNonNullAssertion`) y biome no los arregla en modo unsafe. Usar guard explícito. *(WKH-131 auto-blindaje §W3.4)*
- [ ] **CD-12**: PROHIBIDO usar cualquier valor controlado por el caller como clave de idempotencia de gasto. La clave DEBE ser server-generada. Acá la clave es `a2a_events.id` = UUID Postgres (nunca del body). *(WKH-131 FIX-PACK BLQ-MED-1)*
- [ ] **CD-13**: En tests, resetear TODO cache module-level en `beforeEach` (`_resetErc8004ReputationWriter()`, etc.) y mockear bindings/writer por-slug con `mockImplementation`, NUNCA `mockResolvedValue` único para escenarios multi-agente. *(WKH-131 auto-blindaje W1/W3)*

---

## 6. Waves de implementación

Orden obligatorio: **W0 (serial) → (W1 ∥ W2) → W3 → W4.**

### W0 — Serial (contratos, tipos, migración, ABI, env). BLOQUEA a W1+.

**W0.1 — Migración `supabase/migrations/2026XXXX_wkh133_reputation_writebacks.sql`** (+ `..._down.sql`).
Formato = `wkh54` migration (header con contexto, `IF NOT EXISTS`, índice, RLS enable).

```sql
-- ============================================================
-- Migration: 2026XXXX_wkh133_reputation_writebacks
-- WKH-133: idempotency + observability para el write-back de reputación
-- on-chain a ERC-8004 (Base). event_id = a2a_events.id (UUID server-gen)
-- es la CLAVE de idempotencia (UNIQUE) — barrera anti-doble-gasto de gas.
-- Estado de sistema global (SIN owner_ref, como a2a_events/registries):
-- solo el service (SUPABASE_SERVICE_KEY) escribe/lee; ninguna ruta la expone.
-- RLS ENABLE = deny-by-default (defensa en profundidad, patrón WKH-SEC-02).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.a2a_reputation_writebacks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID NOT NULL UNIQUE,          -- FK lógica a a2a_events.id
  agent_slug       TEXT NOT NULL,
  onchain_agent_id TEXT NOT NULL,                 -- token_id ERC-8004 (string, anti-precision-loss)
  chain_id         INTEGER NOT NULL,
  status           TEXT NOT NULL,                 -- 'pending' | 'confirmed' | 'failed'
  tx_hash          TEXT,                          -- solo cuando status='confirmed'
  error_code       TEXT,                          -- código corto (NUNCA error.message crudo — CD-6/CD-3)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- UNIQUE(event_id) ya crea índice; índice extra para el sweeper futuro por status.
CREATE INDEX IF NOT EXISTS idx_a2a_reputation_writebacks_status
  ON public.a2a_reputation_writebacks (status);

ALTER TABLE public.a2a_reputation_writebacks ENABLE ROW LEVEL SECURITY;
```

`..._down.sql`:
```sql
DROP TABLE IF EXISTS public.a2a_reputation_writebacks;
```

**W0.2 — Extender `src/types/database.types.ts`** con la tabla nueva (Row/Insert/Update), en el mismo bloque `public.Tables` donde está `a2a_events` (patrón `database.types.ts:145-189`). Row shape:
- `id: string`, `event_id: string`, `agent_slug: string`, `onchain_agent_id: string`, `chain_id: number`, `status: string`, `tx_hash: string | null`, `error_code: string | null`, `created_at: string`, `updated_at: string`.
- Insert: `event_id, agent_slug, onchain_agent_id, chain_id, status` requeridos; el resto opcional. Update: todos opcionales.

**W0.3 — En `erc8004-reputation-writer.ts` (crear archivo, ABI primero):** constante `GIVE_FEEDBACK_ABI` (`as const`, SOLO `giveFeedback`, patrón `ERC8004_REPUTATION_ABI` de `erc8004-reputation.ts:63-80`) + comentario `[VERIFY-AT-IMPL resuelto]` citando `erc-8004/erc-8004-contracts@main/abis/ReputationRegistry.json`.

```ts
// [VERIFY-AT-IMPL resuelto] — giveFeedback verificado contra
// abis/ReputationRegistry.json del repo oficial erc-8004/erc-8004-contracts@main (<fecha>).
const GIVE_FEEDBACK_ABI = [
  {
    name: 'giveFeedback',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'endpoint', type: 'string' },
      { name: 'feedbackURI', type: 'string' },
      { name: 'feedbackHash', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;
```

**W0.4 — Resolvers env + tipos de resultado** (en `erc8004-reputation-writer.ts`):
```ts
export function isWritebackEnabled(): boolean {
  return process.env.ERC8004_REPUTATION_WRITEBACK_ENABLED === 'true'; // ON solo con 'true' exacto
}
function resolveWriteReceiptTimeoutMs(): number {
  const raw = process.env.ERC8004_REPUTATION_WRITE_RECEIPT_TIMEOUT_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 90000; // receipt más lento que un read
}
```
Reusar (import de `erc8004-reputation.ts` / `base/chain.ts`): `resolveReputationRegistryAddress`, `getBaseNetwork`, `getBaseChain`. Para RPC y expectedChainId: **replicar los helpers privados** `resolveRpcUrl(network)` y `expectedChainIdFor(network)` (son privados en `erc8004-reputation.ts:99-103,136-138` — copialos, NO los importes; CD-7 mantiene los módulos separados). Tipos:
```ts
export type Erc8004WriteReason =
  | 'RPC_UNAVAILABLE'
  | 'REGISTRY_NOT_CONFIGURED'
  | 'SIGNER_NOT_CONFIGURED'   // OPERATOR_PRIVATE_KEY ausente
  | 'CHAIN_MISMATCH'
  | 'REVERTED'
  | 'RECEIPT_TIMEOUT';
export type Erc8004WriteResult =
  | { ok: true; txHash: string; chainId: number }
  | { ok: false; reason: Erc8004WriteReason };
```
**CD-6:** `Erc8004WriteResult` NUNCA incluye `account`/pk.

**W0.5 — `.env.example`** (junto al bloque `ERC8004_REPUTATION_REGISTRY_ADDRESS`, ~línea 587-594):
```
# WKH-133 — write-back de reputación on-chain (default OFF; Base-only).
# Solo 'true' exacto habilita. Sin esto → 100% read-only (cero tx, comportamiento actual).
ERC8004_REPUTATION_WRITEBACK_ENABLED=false
# Timeout de espera del receipt de la tx giveFeedback (ms). Default 90000.
ERC8004_REPUTATION_WRITE_RECEIPT_TIMEOUT_MS=90000
```
`src/lib/env.ts`: **sin cambios** (las vars son opcionales; no van a `required`).

---

### W1 — Adapter de escritura `src/adapters/erc8004-reputation-writer.ts` (∥ W2, depende de W0)

Responsabilidad ÚNICA: firmar + enviar `giveFeedback` + esperar receipt → `{ ok, txHash } | { ok:false, reason }` **sin throw**. NO lee DB, NO decide idempotencia, NO conoce `a2a_events`.

Estructura (exemplars: `erc8004-reputation.ts` + `gasless.ts:52-64` + `base/payment.ts:189-222`):
- Imports viem: `createWalletClient`, `createPublicClient`, `http`, `ContractFunctionExecutionError`, `zeroHash`, `privateKeyToAccount` (de `viem/accounts`), `getBaseChain`/`getBaseNetwork` de `./base/chain.js`.
- Lazy caches propios module-level: `_walletClients: Map<'base-mainnet'|'base-sepolia', WalletClient>` y `_publicClients: Map<...>` (patrón `_clients` de `erc8004-reputation.ts:113`).
- `_resetErc8004ReputationWriter()` TEST-ONLY que limpia AMBOS caches (CD-13).
- Getter wallet client: si `!process.env.OPERATOR_PRIVATE_KEY` → devolver null (NO throw acá; el caller mapea a `SIGNER_NOT_CONFIGURED`). Construir `privateKeyToAccount(pk as 0x...)` + `createWalletClient({ account, chain: getBaseChain(network), transport: http(rpcUrl) })`.
- `classifyWriteError(err)`: `ContractFunctionExecutionError` → `'REVERTED'`; resto → `'RPC_UNAVAILABLE'`.

Firma pública:
```ts
export interface Erc8004ReputationWriter {
  giveFeedback(args: {
    agentId: bigint;
    value: bigint;        // 100n (DT-7)
    valueDecimals: number; // 0
    tag1: string;          // "wasiai"
    tag2: string;          // event.eventType
  }): Promise<Erc8004WriteResult>;
}
export const erc8004ReputationWriter: Erc8004ReputationWriter = { /* ... */ };
```

Secuencia interna de `giveFeedback`:
1. `network = getBaseNetwork()`.
2. `address = resolveReputationRegistryAddress(network)`; si null → `{ ok:false, reason:'REGISTRY_NOT_CONFIGURED' }`.
3. `rpcUrl = resolveRpcUrl(network)`; si undefined → `{ ok:false, reason:'RPC_UNAVAILABLE' }`.
4. wallet client (si pk ausente → `{ ok:false, reason:'SIGNER_NOT_CONFIGURED' }`) + public client.
5. **CD-8 guard:** `const onchainChainId = await publicClient.getChainId()` (en try/catch → `RPC_UNAVAILABLE`); si `!== expectedChainIdFor(network)` → `{ ok:false, reason:'CHAIN_MISMATCH' }` **sin enviar tx**.
6. `try`: `const txHash = await walletClient.writeContract({ address, abi: GIVE_FEEDBACK_ABI, functionName: 'giveFeedback', args: [agentId, value, valueDecimals, tag1, tag2, '', '', zeroHash], chain: getBaseChain(network), account })`.
   *(`endpoint=''`, `feedbackURI=''`, `feedbackHash=zeroHash` — DT-7.)*
7. `await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: resolveWriteReceiptTimeoutMs() })`. Si el receipt indica `status !== 'success'` (revert on-chain) → `{ ok:false, reason:'REVERTED' }`. Timeout → `{ ok:false, reason:'RECEIPT_TIMEOUT' }`.
   **`[VERIFY-AT-IMPL]`**: confirmar en viem v2 el nombre `waitForTransactionReceipt`, el campo `timeout`, y el shape del receipt (`receipt.status === 'success'`).
8. Éxito → `{ ok:true, txHash, chainId: expectedChainIdFor(network) }`.
9. `catch (err)` → `{ ok:false, reason: classifyWriteError(err) }`. **NUNCA loguear la pk (CD-6).**

**Test `erc8004-reputation-writer.test.ts`** (patrón `erc8004-reputation.test.ts`): ver §7.

---

### W2 — Helper de identidad en `src/services/identity.ts` (∥ W1, depende de W0)

Nuevo método en el objeto `identityService` (mismo módulo, reusa `normalizeSlug` privada de `identity.ts:29`):

```ts
async resolveErc8004AgentId(slug: string, chainId: number): Promise<bigint | null> {
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .select('erc8004_identity')   // SOLO esta columna — NUNCA budget (CD-2/DT-19 de resolveIdentityForAgent)
    .eq('is_active', true)
    .not('erc8004_identity', 'is', null);
  if (error || !data) return null;

  const nSlug = normalizeSlug(slug);
  const matches: bigint[] = [];
  for (const row of data) {
    const b = row.erc8004_identity as Erc8004IdentityBinding | null;
    if (!b) continue;
    if (!b.agent_slug) continue;                  // binding v1 sin ancla → skip
    if (normalizeSlug(b.agent_slug) !== nSlug) continue;
    if (b.chain_id !== chainId) continue;
    matches.push(BigInt(b.token_id));             // token_id es string decimal (anti-precision-loss)
  }
  // Exactamente 1 match → escribir. 0 o >1 → null (fail-safe: nunca al agente equivocado, CD-9).
  if (matches.length === 1) {
    const only = matches[0];
    if (only === undefined) return null;          // CD-11: guard explícito, sin non-null assertion
    return only;
  }
  return null;
}
```

- Lee SOLO `erc8004_identity` (NUNCA `budget` — patrón `resolveIdentityForAgent`, `identity.ts:359`).
- Match SOLO por `slug`+`chainId` (limitación v1 documentada en DT-6: colisión de slug entre registries → `>1` → skip).
- **CD-11:** guard explícito en el `matches[0]` (biome trata el index access como posiblemente undefined; NO usar `matches[0]!`).

**Test:** extender `src/services/identity.test.ts` — ver §7 (T-CD9).

---

### W3 — Servicio orquestador `src/services/reputation-writeback.ts` (depende de W1 + W2)

Implementa la secuencia **DT-5** at-most-once. **NUNCA throw** (fail-open CD-3).

```ts
export interface WritebackEvent {
  id: string;            // a2a_events.id (UUID server-gen — clave idempotencia, CD-12)
  eventType: string;     // → tag2
  agentId: string | null;  // = agent.slug (así lo puebla compose.ts:684 / orchestrate.ts)
  status: 'success' | 'failed';
  costUsdc: number;
}

export const reputationWritebackService = {
  async onSettledEvent(event: WritebackEvent): Promise<void> {
    try {
      // 1. GATE
      if (!isWritebackEnabled()) return;                      // CD-5
      if (event.status !== 'success' || event.costUsdc <= 0) return; // AC-5 (paridad tasks_settled)
      const network = getBaseNetwork();
      if (!resolveReputationRegistryAddress(network)) return; // AC-2 skip silencioso
      const slug = event.agentId;
      if (!slug) return;
      const chainId = expectedChainIdFor(network);

      // 2. RESOLVE agentId (DT-6)
      const onchainAgentId = await identityService.resolveErc8004AgentId(slug, chainId);
      if (onchainAgentId === null) return;                    // CD-9 skip (0/>1 match o sin binding)

      // 3. CLAIM idempotencia — ANTES de la tx (CD-2). ON CONFLICT DO NOTHING.
      const { data: claimed, error: claimErr } = await supabase
        .from('a2a_reputation_writebacks')
        .insert({
          event_id: event.id,
          agent_slug: slug,
          onchain_agent_id: onchainAgentId.toString(),
          chain_id: chainId,
          status: 'pending',
        })
        .onConflict('event_id')      // [VERIFY-AT-IMPL] confirmar API supabase-js: .upsert(..., { onConflict, ignoreDuplicates:true }) vs .insert().onConflict()
        .select();
      if (claimErr) { /* log código corto */ return; }
      if (!claimed || claimed.length === 0) return;           // 0 filas → ya reclamado → NO tx (anti-doble-gasto)

      // 4. TX
      const result = await erc8004ReputationWriter.giveFeedback({
        agentId: onchainAgentId,
        value: 100n,
        valueDecimals: 0,
        tag1: 'wasiai',
        tag2: event.eventType,
      });

      // 5. PERSIST
      if (result.ok) {
        await supabase.from('a2a_reputation_writebacks')
          .update({ status: 'confirmed', tx_hash: result.txHash, updated_at: new Date().toISOString() })
          .eq('event_id', event.id);
      } else {
        // CD-3: código corto, NUNCA error.message crudo. NO reintento síncrono (AC-4).
        await supabase.from('a2a_reputation_writebacks')
          .update({ status: 'failed', error_code: result.reason, updated_at: new Date().toISOString() })
          .eq('event_id', event.id);
        log.warn({ eventId: event.id, reason: result.reason }, '[ReputationWriteback] giveFeedback failed');
      }
    } catch (err) {
      // Fail-open absoluto (CD-3): NUNCA propagar. Log código corto, sin pk, sin error.message al caller.
      log.error({ err }, '[ReputationWriteback] unexpected error');
    }
  },
};
```

**`[VERIFY-AT-IMPL]` claim API:** confirmar la forma exacta del `INSERT ... ON CONFLICT DO NOTHING` en la versión de `@supabase/supabase-js` del repo. Dos formas válidas equivalentes:
- `.upsert({...}, { onConflict: 'event_id', ignoreDuplicates: true }).select()` → filas devueltas = solo las insertadas (las ignoradas por conflicto NO se devuelven). **0 filas devueltas = ya reclamado → NO tx.**
- Verificar contra otros usos de upsert/onConflict en `src/services/` antes de elegir. La semántica requerida es la del snippet: **claim gana solo si inserta; si ya existe → 0 filas → return sin tx.**

Imports: `isWritebackEnabled`, `erc8004ReputationWriter`, `Erc8004WriteResult` de `../adapters/erc8004-reputation-writer.js`; `resolveReputationRegistryAddress` de `../adapters/erc8004-reputation.js`; `getBaseNetwork` de `../adapters/base/chain.js`; `identityService` de `./identity.js`; `supabase` de `../lib/supabase.js`; `log` (confirmar el logger del repo — usar el mismo que `reputation.ts`/`compose.ts`). Replicar `expectedChainIdFor` (privado).

**Test `reputation-writeback.test.ts`** — cubre AC-1..AC-6 (mock writer + helper + supabase). Ver §7.

---

### W4 — Hook en `src/services/event.ts::track()` (depende de W3)

Tras el `insert().select().single()` exitoso, ANTES del `return`. NO awaited. NO altera el `A2AEvent` retornado. NO agrega throw.

En `event.ts`, dentro de `track()` justo antes de `return rowToEvent(...)` (línea ~88):
```ts
const mapped = rowToEvent(data as unknown as EventRow);

// WKH-133: write-back de reputación on-chain — fire-and-forget, gated OFF por default.
// NO awaited: track() retorna apenas termina el insert (CD-1/AC-7 — no aumenta p95).
if (isWritebackEnabled()) {
  void reputationWritebackService
    .onSettledEvent({
      id: mapped.id,
      eventType: mapped.eventType,
      agentId: mapped.agentId,
      status: mapped.status,
      costUsdc: mapped.costUsdc,
    })
    .catch(() => { /* fail-open: nunca romper track() (CD-3) */ });
}

return mapped;
```

Imports nuevos en `event.ts`: `isWritebackEnabled` de `../adapters/erc8004-reputation-writer.js`; `reputationWritebackService` de `./reputation-writeback.js`.

**Notas:**
- El gate `if (isWritebackEnabled())` acá evita construir el objeto/promesa cuando el flag está OFF (además del gate interno del service — doble barrera, CD-5). Con flag OFF, `onSettledEvent` NUNCA se invoca.
- `mapped.status` es la union `'success' | 'failed'` de dominio; encaja directo en `WritebackEvent.status`.

**Test:** extender `src/services/event.test.ts` — ver §7 (T-AC2-flag, T-AC7).

---

## 7. Plan de tests (13 tests — ≥1 por AC + CDs críticos)

Todos CI-deterministas, sin red real (mock `viem` + mock `supabase` + mock del adapter/helper). Env set/clear por test + `_reset*()` en `beforeEach` (CD-13). Mock multi-agente con `mockImplementation`, NO `mockResolvedValue` único.

| # | Test id | AC / CD | Archivo | Qué verifica |
|---|---|---|---|---|
| 1 | T-AC1 | AC-1 | `reputation-writeback.test.ts` | evento `status='success', costUsdc>0` + identidad resuelta + flag ON → `writer.giveFeedback` invocado **1 vez** con `agentId` correcto |
| 2 | T-AC2-flag | AC-2/CD-5 | `event.test.ts` | flag OFF → `onSettledEvent`/writer NUNCA invocado; `track()` retorna la fila normal |
| 3 | T-AC2-cfg | AC-2 | `reputation-writeback.test.ts` | registry/rpc no configurado → skip silencioso, writer NO invocado, sin throw |
| 4 | T-AC3 | AC-3/CD-2 | `reputation-writeback.test.ts` | claim `ON CONFLICT DO NOTHING` devuelve **0 filas** (evento ya attestado) → writer NO invocado (idempotencia, no doble-gasto) |
| 5 | T-AC4 | AC-4/CD-3 | `reputation-writeback.test.ts` | writer `{ok:false, reason:'REVERTED'\|'RPC_UNAVAILABLE'}` → row `status='failed'` + `error_code` corto + log server-side, sin throw, sin reintento sync, evento NO marcado failed |
| 6 | T-AC5-failed | AC-5 | `reputation-writeback.test.ts` | evento `status='failed'` → writer NO invocado (ni claim) |
| 7 | T-AC5-zerocost | AC-5 | `reputation-writeback.test.ts` | evento `cost_usdc<=0` → writer NO invocado (paridad `tasks_settled`) |
| 8 | T-AC6-sign | AC-6/CD-6 | `erc8004-reputation-writer.test.ts` | adapter construye account desde `OPERATOR_PRIVATE_KEY`; pk ausente → `{ok:false, reason:'SIGNER_NOT_CONFIGURED'}` sin throw; el result serializado (`JSON.stringify`) NUNCA contiene la pk |
| 9 | T-AC7 | AC-7/CD-1 | `event.test.ts` | `track()` resuelve/retorna la fila **aunque** `onSettledEvent` cuelgue o rechace (fire-and-forget, no-await) |
| 10 | T-CD8 | CD-8 | `erc8004-reputation-writer.test.ts` | `getChainId()` != esperado → `{ok:false, reason:'CHAIN_MISMATCH'}` y `writeContract` NUNCA llamado |
| 11 | T-CD9 | CD-9 | `identity.test.ts` + `reputation-writeback.test.ts` | slug sin binding → `resolveErc8004AgentId` null → skip; **>1 match** → null → skip (usar `mockImplementation` por-slug) |
| 12 | T-SCAN | CD-4/CD-6 | `erc8004-reputation-writer.test.ts` | source-scan (patrón `erc8004-reputation.test.ts:152-179`): sin address hex-40 hardcodeada; el código lee `process.env.ERC8004_REPUTATION_...`; cita `erc-8004/erc-8004-contracts`; el CÓDIGO no contiene la string del pk |
| 13 | T-DT7 | DT-7 | `erc8004-reputation-writer.test.ts` | `writeContract` recibe args `[agentId, 100n, 0, 'wasiai', <eventType>, '', '', zeroHash]` |

**Patrón de mock viem** (copiar de `erc8004-reputation.test.ts:12-32`, agregando `createWalletClient` con `writeContract` mock y `createPublicClient` con `getChainId` + `waitForTransactionReceipt` mocks):
```ts
const mockWriteContract = vi.fn();
const mockGetChainId = vi.fn();
const mockWaitForReceipt = vi.fn();
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,   // preserva ContractFunctionExecutionError, http, zeroHash reales
    createWalletClient: vi.fn(() => ({ writeContract: mockWriteContract })),
    createPublicClient: vi.fn(() => ({ getChainId: mockGetChainId, waitForTransactionReceipt: mockWaitForReceipt })),
  };
});
```
`beforeEach`: reset todos los mocks + `_resetErc8004ReputationWriter()` + `process.env = { ...ORIGINAL_ENV }` + limpiar vars ERC8004.

---

## 8. Riesgos que el AR va a atacar (anticiparlos)

1. **Doble-gasto** → verificar que NO existe path que llame `giveFeedback` sin haber ganado el claim (0 filas → return). El claim va **antes** de la tx.
2. **Bloqueo hot-path** → confirmar NO hay `await` sobre `onSettledEvent` en `track()`; ningún throw se propaga.
3. **Exposición pk (CD-6)** → source-scan test + `Erc8004WriteResult` sin `account`/pk; ningún `log.*` recibe la pk.
4. **Red/agente equivocado** → guard `getChainId()` (CD-8) + resolución fail-safe con skip ante 0/>1 (CD-9).
5. **Fail-open real** → todo error → `status='failed'` + log código corto; evento/settlement subyacente jamás `failed`.
6. **Ownership** → `a2a_reputation_writebacks` sin `owner_ref` es correcto (estado global); NO es IDOR (DT-4/CD-10). Ninguna ruta la expone.

---

## 9. Done Definition

- [ ] W0→W4 implementadas en los archivos exactos de §3 (nada fuera de scope).
- [ ] Migración + `_down.sql` con `UNIQUE(event_id)` + índice status + RLS enable.
- [ ] `giveFeedback` ABI re-verificado en impl con comentario `[VERIFY-AT-IMPL resuelto]` citando el repo oficial.
- [ ] Claim `ON CONFLICT (event_id) DO NOTHING` **antes** de la tx (barrera anti-doble-gasto verificada en test T-AC3).
- [ ] Hook en `track()` NO awaited + gated OFF por default (T-AC2-flag, T-AC7 verdes).
- [ ] Flag `ERC8004_REPUTATION_WRITEBACK_ENABLED` default OFF; sin config → cero tx.
- [ ] Todos los CD (§5) respetados; `[VERIFY-AT-IMPL]` (zeroHash, waitForTransactionReceipt, claim API supabase) confirmados en runtime/compilación — cero API inventada.
- [ ] 13 tests (§7) verdes. `npm run typecheck` + `npm run lint` (biome, sin non-null assertions) + `npm test` limpios.
- [ ] `erc8004-reputation.ts` y `erc8004-identity.ts` SIN cambios (siguen read-only — CD-7).
```
