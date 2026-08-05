# Multi-Chain Registry (WKH-MULTICHAIN / 086)

> **Status**: Implemented (F3 done 2026-05-13) — env-gated mainnet bundles.
> **Owner**: Fernando Rosas
> **Supersedes**: implicit single-chain assumptions in `src/adapters/registry.ts` pre-WKH-MULTICHAIN.
> **Related**: [`CHAIN-ADAPTIVE.md`](CHAIN-ADAPTIVE.md), [`../sdd/086-wkh-multichain-a2a/`](../sdd/086-wkh-multichain-a2a/).

## 1. Resumen

`wasiai-a2a` corre simultáneamente sobre N chains EVM dentro de un solo proceso.
La motivación: el path Kite testnet (PYUSD inbound) y el path Avalanche (USDC inbound/outbound)
viven en el mismo binario, y un solo `wasi_a2a_xxx` key puede sostener saldo en varias chains
al mismo tiempo. La selección por request se hace en `O(1)` vía un `Map<ChainKey, AdaptersBundle>`
sin I/O en el hot path del middleware (CD-6: <50ms overhead).

Antes de WKH-MULTICHAIN, `src/adapters/registry.ts` era un singleton single-chain
(`WASIAI_A2A_CHAIN=<slug>` cargaba UN bundle y todo el codebase asumía esa chain). El refactor
mantiene 100% backward-compat (CD-2): el path histórico `WASIAI_A2A_CHAIN=kite-ozone-testnet`
sigue funcionando byte-idéntico, y `WASIAI_A2A_CHAINS=<csv>` es la entrada nueva multi-chain.

SDD completo: [`../sdd/086-wkh-multichain-a2a/sdd.md`](../sdd/086-wkh-multichain-a2a/sdd.md) §1.

## 2. Modelo arquitectónico

```
┌────────────────────────────────────────────────────────────────────┐
│  src/adapters/registry.ts                                          │
│                                                                    │
│  const _bundles = new Map<ChainKey, AdaptersBundle>()              │
│  let _defaultChainKey: ChainKey | null = null                      │
│                                                                    │
│  initAdapters()                                                    │
│    parse WASIAI_A2A_CHAINS (csv) ?? WASIAI_A2A_CHAIN (legacy)      │
│    for each chainKey →                                             │
│      bundle = await create<Chain>Adapters({ network })             │
│      _bundles.set(chainKey, bundle)                                │
│    _defaultChainKey = chainKeys[0]                                 │
└─────────────────────────────────┬──────────────────────────────────┘
                                  ↓ getAdaptersBundle(chainKey)
┌────────────────────────────────────────────────────────────────────┐
│  src/middleware/a2a-key.ts (per-request, hot path)                 │
│                                                                    │
│  1. chainKey = resolveChainKey({ headerOverride })                 │
│       priority: header → manifest (delegated) → default            │
│  2. bundle  = getAdaptersBundle(chainKey)                          │
│  3. chainId = bundle.chainConfig.chainId         ◄── CD-12         │
│  4. budgetService.debit(keyId, chainId, amountUsd)                 │
│  5. log { chainKey, chainId, asset_symbol }      ◄── CD-7          │
└────────────────────────────────────────────────────────────────────┘
```

`AdaptersBundle` (`src/adapters/types.ts`):

```ts
interface AdaptersBundle {
  payment: PaymentAdapter;
  attestation: AttestationAdapter;
  gasless: GaslessAdapter;
  identity: IdentityBindingAdapter | null;
  chainConfig: { name: string; chainId: number; explorerUrl: string };
}
```

Cada bundle es una instancia con closures (clients viem lazy, etc.). PROHIBIDO `JSON.stringify(bundle)`
(DT-B) y PROHIBIDO mutar campos del bundle desde call-sites externos (CD-18).

## 3. Chain selection priority

La prioridad de resolución (DT-1 + DT-A) está implementada en `src/adapters/chain-resolver.ts`:

```ts
type ResolveInput = {
  headerOverride?: string;        // valor crudo de header `x-payment-chain`
  agentManifestChain?: string;    // delegado al cliente upstream (CD-16)
};
export function resolveChainKey(input: ResolveInput): ChainKey | undefined;
export function normalizeChainSlug(raw: string): ChainKey | undefined;
```

Orden:

1. **Header `x-payment-chain`** (explícito) — slug o chainId numérico stringificado.
2. **Agent manifest `payment.chain`** — delegado al cliente upstream (wasiai-v2 propaga el header
   desde el agent card). El middleware NO llama a `discoveryService.getAgent()` (CD-16) para
   respetar CD-6 (<50ms overhead).
3. **Default chain** — primer entry de `WASIAI_A2A_CHAINS` (o `WASIAI_A2A_CHAIN` legacy si CSV
   ausente).

Si el header está **presente pero inválido** (slug no reconocido) → HTTP 400
`CHAIN_NOT_SUPPORTED` (CD-14). Si el header está **ausente** → fallback al default (no error).

### Aliases aceptados por `normalizeChainSlug` (DT-E)

| Input | Resuelve a |
|-------|-----------|
| `kite-ozone-testnet`, `kite-testnet`, `2368` | `kite-ozone-testnet` |
| `kite-mainnet`, `2366` | `kite-mainnet` |
| `avalanche-fuji`, `avalanche-testnet`, `avalanche`, `fuji`, `43113` | `avalanche-fuji` |
| `avalanche-mainnet`, `43114` | `avalanche-mainnet` |
| cualquier otro | `undefined` |

`normalizaChainSlug` aplica `String.trim().toLowerCase()` + lookup via `Object.hasOwn`
(CD-19, anti-prototype-pollution).

## 4. Matriz de chains soportadas

| ChainKey | chainId | RPC env var | Stablecoin (canonical) | Facilitator | Estado |
|----------|---------|-------------|------------------------|-------------|--------|
| `kite-ozone-testnet` | 2368 | `KITE_RPC_URL` | PYUSD (`0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`) | Pieverse | live (default WKH-29 path) |
| `kite-mainnet` | 2366 | `KITE_MAINNET_RPC_URL` | USDC.e (`0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e`) | Pieverse | wired (W5), untested mainnet |
| `avalanche-fuji` | 43113 | `FUJI_RPC_URL` | USDC (`0x5425890298aed601595a70AB815c96711a31Bc65`) | wasiai-facilitator (self-hosted) | wired (W1), testable |
| `avalanche-mainnet` | 43114 | `AVALANCHE_RPC_URL` | USDC (`0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`) | wasiai-facilitator (self-hosted) | wired (W5), untested mainnet |

Notas:

- Las direcciones USDC Fuji/Mainnet pueden sobrescribirse vía `FUJI_USDC_ADDRESS` /
  `AVALANCHE_USDC_ADDRESS` (warn-once si ausentes — defaultean a Circle canonical).
- El facilitator Avalanche es **siempre** el self-hosted `wasiai-facilitator` en modo canonical
  x402 (CD-15: prohibido modo `pieverse` para Avalanche). El facilitator routea internamente
  por chain via el body `accepted.network: 'eip155:43113' | 'eip155:43114'`.
- La activación de Kite mainnet usa `WASIAI_A2A_CHAINS=...,kite-mainnet` que dispara una
  mutación temporal de `process.env.KITE_NETWORK = 'mainnet'` confined to `initAdapters()`
  (DT-I). El valor original se restaura via `try/finally` al terminar el `await import()`.
  ⚠️ Por eso el slug NO alcanza: esa mutación sólo alcanza al `chainConfig`; el ADAPTER lee
  `KITE_NETWORK` **después** del `finally` (call-time), así que la activación real exige
  además `KITE_NETWORK=mainnet` de forma permanente — ver §8. Tracked como
  **TD-NEW-KITE-PARAMS** (refactor post-MVP de `kite-ozone/chain.ts` + `payment.ts` para no
  leer env).

## 5. Backward-compat (CD-2)

El path Kite Ozone testnet sigue siendo el default y es 100% byte-idéntico al pre-WKH-MULTICHAIN.

```bash
# Comportamiento histórico (pre-WKH-MULTICHAIN)
WASIAI_A2A_CHAIN=kite-ozone-testnet
# → init un solo bundle, getChainConfig() retorna shape idéntico.

# Comportamiento multi-chain nuevo
WASIAI_A2A_CHAINS=kite-ozone-testnet,avalanche-fuji
# → init dos bundles. default = kite-ozone-testnet.
# Requests sin header `x-payment-chain` → debit en chainId 2368 (default Kite).
# Requests con header `x-payment-chain: avalanche-fuji` → debit en chainId 43113.

# Conflicto (ambas seteadas)
WASIAI_A2A_CHAINS=kite-ozone-testnet,avalanche-fuji
WASIAI_A2A_CHAIN=kite-mainnet
# → CSV gana. Log: [Registry] WARNING: both WASIAI_A2A_CHAINS and WASIAI_A2A_CHAIN
#                  are set. Using WASIAI_A2A_CHAINS=kite-ozone-testnet,avalanche-fuji
#                  (singular ignored).
```

AC-2 garantiza que cualquier test que pasaba pre-refactor sigue pasando sin modificación
funcional (solo mocks del registry pueden necesitar actualización si la firma de factory cambió).

## 6. Cómo agregar una chain nueva (checklist post-merge)

1. **Crear `src/adapters/<chain>/`** siguiendo el patrón Avalanche (`chain.ts` + `payment.ts` +
   `attestation.ts` (stub si no aplica) + `gasless.ts` (stub `enabled: false` si no aplica) +
   `identity.ts` (export `null` si no aplica) + `index.ts` con factory `create<Chain>Adapters(opts?)`).
2. **Agregar el slug al `SUPPORTED_CHAINS` tuple `as const`** en `src/adapters/registry.ts`.
3. **Agregar la rama en `buildBundle()`** del registry (`if (chainKey === '<new-slug>')
   return await create<Chain>Adapters({ network })`).
4. **Agregar `ChainKey` al union type** en `src/adapters/types.ts`.
5. **Agregar aliases al `SLUG_ALIASES`** en `src/adapters/chain-resolver.ts` (incluir el chainId
   numérico stringificado para soportar header `x-payment-chain: <chainId>`).
6. **Agregar env vars** a `.env.example` (RPC URL, token address override opcional, facilitator
   override opcional).
7. **Agregar tests** en `src/adapters/__tests__/<chain>.test.ts` (factory shape, USDC asset,
   chainId) y en `src/adapters/__tests__/registry.test.ts` (init wiring, default si aplica).
8. **Documentar en este archivo (§4 matriz)**.
9. **NO** modificar L3 services ni L4 routes — el contrato `AdaptersBundle` desacopla.

Tiempo estimado (mirror de WKH-MULTICHAIN W1): ~4-6h para adapter completo + tests.

## 7. Deposit Avalanche manual (CD-10)

> Procedimiento literal copiado del SDD §10 — para fondear una A2A key con USDC Fuji o
> Avalanche C-Chain mainnet antes de un smoke test.

**Pre-requisitos:**

- Wallet con USDC Fuji (faucet: https://faucet.circle.com/ — selecciona "Avalanche Fuji").
- `OPERATOR_PRIVATE_KEY` del wasiai-a2a operator (Railway env).
- `WASIAI_A2A_KEY_ID` del key target (UUID de `a2a_agent_keys.id`).

**Procedimiento (Fuji):**

1. **Confirmar registry inicializado**: deploy de wasiai-a2a con
   `WASIAI_A2A_CHAINS=kite-ozone-testnet,avalanche-fuji`. Verificar log de startup:

   ```
   [Registry] Adapters initialized: kite-ozone-testnet, avalanche-fuji
   ```

2. **Verificar operator wallet en Fuji**: `snowtrace.io/<operator_address>`. El operator debe
   tener USDC Fuji para downstream (separate concern; el deposit del A2A key budget es una
   operación de BD, no on-chain).

3. **Insertar deposit en BD** (Supabase SQL editor, dev project `<supabase-dev-ref>`):

   ```sql
   SELECT register_a2a_key_deposit(
     '<KEY_ID_UUID>'::uuid,  -- p_key_id
     43113,                   -- p_chain_id (Fuji)
     10.0                     -- p_amount_usd (10 USDC equivalent)
   );
   ```

   Retorna el nuevo balance JSONB.

4. **Verificar via API**:

   ```bash
   curl -X POST https://wasiai-a2a-production.up.railway.app/auth/budget \
     -H "x-a2a-key: <THE_KEY>" \
     -H "x-payment-chain: avalanche-fuji"
   # Esperar: { "chainId": 43113, "balance": "10.000000" }
   ```

5. **Smoke test compose contra Fuji agent**:

   ```bash
   curl -X POST https://wasiai-a2a-production.up.railway.app/compose \
     -H "x-a2a-key: <THE_KEY>" \
     -H "x-payment-chain: avalanche-fuji" \
     -d '{"steps": [{"agent": "<fuji-agent-slug>", "input": {...}}]}'
   # Esperar: response con txHash del downstream USDC settle.
   ```

**Para Avalanche mainnet (smoke post-merge, fuera del hackathon):**

- USDC mainnet (chainId 43114, contrato `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`).
- `register_a2a_key_deposit(<KEY_ID>, 43114, <amount>)`.
- Operator wallet con USDC en C-Chain mainnet (snowtrace.io).
- El agente declara chain `avalanche-mainnet` (o `43114`) **y** el gateway tiene el opt-in
  explícito `WASIAI_DOWNSTREAM_MAINNET_ALLOW=avalanche-mainnet`. Sin esa env (ausente o vacía)
  el leg downstream se saltea con skip-code `MAINNET_NOT_ALLOWED` (fail-CLOSED).
  ⚠️ `WASIAI_DOWNSTREAM_NETWORK` **no la lee ningún archivo de `src/`** (control muerto desde
  WKH-112) — corregido en el fix-pack AR-profundo FIX 1c (2026-07-26).

**Para Kite mainnet (post-merge):**

- Operator wallet con USDC.e en Kite mainnet (`0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e`).
- `register_a2a_key_deposit(<KEY_ID>, 2366, <amount>)`.
- Config de envs: **ver §8 → "Kite mainnet (2366)"**. Son TRES envs acopladas
  (`WASIAI_A2A_CHAINS` con `kite-mainnet` y sin ningún slug Kite testnet +
  `KITE_NETWORK=mainnet` + `KITE_MAINNET_RPC_URL`) y setear sólo una de ellas
  deja el rail roto o el proceso sin arrancar. No las repetimos acá para que no
  vuelvan a divergir: §8 es la fuente única.
  (Corregido en el fix-pack AR-profundo it2 MNR-2: esta viñeta decía sólo
  `KITE_NETWORK=mainnet` + RPC, contradiciendo a §8 nueve líneas más abajo.)

## 8. Activación mainnet (flip flags en Railway)

### Kite mainnet (2366)

> ⚠️ Reescrito el 2026-07-26 (fix-pack AR-profundo it2, MNR-3). La versión it2 de este paso
> decía "⛔ NO setear `KITE_NETWORK=mainnet`; el slug del CSV ya selecciona la red por bundle".
> Eso es **falso a medias** y produce un rail roto: el probe con factories reales mostró que con
> `WASIAI_A2A_CHAINS=kite-mainnet` y `KITE_NETWORK` ausente el proceso arranca con
> `chainConfig.chainId=2366` pero `getPaymentAdapter('kite-mainnet').chainId === 2368` y
> `getToken()` devuelve el PYUSD de **testnet** — porque el `finally` de
> `createKiteOzoneAdapters` restaura la env y el adapter la lee en **call-time**.

1. **Railway env update** — las **tres** envs juntas (no redeploy si el bundle ya está wired):
   - `WASIAI_A2A_CHAINS=kite-mainnet` (+ los slugs de OTROS namespaces que necesites, p.ej.
     `kite-mainnet,avalanche-fuji`). **Ningún slug Kite testnet en el CSV.**
   - `KITE_NETWORK=mainnet` — **obligatoria**. `getKiteChain()` / `getKiteNetworkTag()` la leen
     en call-time (`TD-NEW-KITE-PARAMS`), así que el `{ network: 'mainnet' }` que el registry le
     pasa al factory sólo fija el `chainConfig`; el adapter que FIRMA y el token EIP-712 los
     decide esta env. Sin ella el rail arranca firmando en 2368/PYUSD y el registry lo reporta
     con `code=ADAPTER_CHAIN_ID_DRIFT` (it2 MNR-3).
   - `KITE_MAINNET_RPC_URL=https://rpc.gokite.ai/`.
   - ⛔ **`KITE_NETWORK=mainnet` junto a un slug Kite testnet ⇒ `initAdapters` LANZA**
     (it2 BLQ-ALTO-1). El bundle de `kite-ozone-testnet` se construye SIN `opts`, así que con esa
     env apunta a chainId 2366 con USDC.e de MAINNET: un slug que dice "testnet" moviendo dinero
     real, que además engañaba al gate fail-CLOSED de WKH-144 y al opt-in del leg downstream.
   - ⇒ **los dos rails Kite NO pueden convivir en el mismo proceso** (no existe combinación
     coherente): con `KITE_NETWORK=mainnet` el arranque rompe por el slug testnet; sin ella el
     slug mainnet firma en testnet. El fix de fondo es `TD-NEW-KITE-PARAMS` (§10).
2. **Verificar log de startup**: `[Registry] Adapters initialized: kite-mainnet, ...` **y** que NO
   aparezca ninguna línea `ADAPTER_CHAIN_ID_DRIFT`.
3. **Smoke test obligatorio** post-flip:

   ```bash
   curl https://wasiai-a2a-production.up.railway.app/health
   # → 200 OK
   curl -X POST https://wasiai-a2a-production.up.railway.app/compose \
     -H "x-a2a-key: <key-with-2366-budget>" \
     -H "x-payment-chain: kite-mainnet" \
     -d '{...}'
   # → response con tx hash en kitescan.ai (mainnet explorer)
   ```

4. **Rollback de Kite mainnet** (agregado en el fix-pack AR-profundo CR-MAYOR-2 —
   §8 documentaba la activación pero **no** la vuelta atrás, y los dos runbooks de
   `doc/` la tenían MAL):

   Las dos envs se mueven **JUNTAS**, con la misma lógica que la activación:

   ```bash
   WASIAI_A2A_CHAINS=kite-ozone-testnet   # volver al CSV testnet exacto previo
   KITE_NETWORK=                          # vaciar/unset EN EL MISMO cambio
   ```

   - ⛔ **revertir sólo `KITE_NETWORK`** (dejando `WASIAI_A2A_CHAINS=kite-mainnet`)
     deja el rail ROTO: `chainConfig.chainId` 2366 con el adapter firmando en 2368 /
     PYUSD de testnet ⇒ `ADAPTER_CHAIN_ID_DRIFT`. Es el mismo bundle inconsistente
     que produce la activación a medias, y es el bug que tenían los dos rollbacks de
     `doc/operations/mainnet-activation-runbook.md` y
     `doc/migration/MAINNET-ACTIVATION-RUNBOOK.md`.
   - ⛔ **revertir sólo el CSV** (dejando `KITE_NETWORK=mainnet` con un slug Kite
     testnet) es peor: `initAdapters` **LANZA** y el gateway no arranca.
   - ✅ **Verificación del rollback** (no está hecho hasta que pasen las dos):
     `Adapters initialized` lista sólo slugs testnet **y** no aparece ninguna línea
     `ADAPTER_CHAIN_ID_DRIFT`.
   - `KITE_NETWORK=testnet` y `KITE_NETWORK` ausente son equivalentes: cualquier
     valor distinto de `mainnet` resuelve testnet (`kite-ozone/chain.ts:46`).

### Avalanche mainnet (43114)

1. **Railway env update**:
   - `WASIAI_A2A_CHAINS=...,avalanche-mainnet` (agregar al CSV existente).
   - `AVALANCHE_RPC_URL=https://api.avax.network/ext/bc/C/rpc`.
   - `WASIAI_DOWNSTREAM_MAINNET_ALLOW=avalanche-mainnet` (si el downstream también debe ir a
     mainnet — ver §9 abajo). Ausente/vacía = fail-CLOSED: ninguna mainnet settlea en el leg
     downstream. La vieja `WASIAI_DOWNSTREAM_NETWORK` NO la lee nadie (control muerto).
   - `WASIAI_DOWNSTREAM_X402=true` + operator wallet con USDC en C-Chain mainnet — sin esas dos
     el leg no settlea aunque el opt-in esté seteado. Automatizable con
     `./scripts/activate-mainnet-downstream.sh` (setea el opt-in + el RPC en a2a y habilita la
     chain en el facilitator; el resto lo declara en su output).
2. **Verificar log de startup**: `[Registry] Adapters initialized: ..., avalanche-mainnet`.
3. **Smoke test obligatorio** post-flip (con USDC mainnet en operator wallet, verificable en
   `snowtrace.io`):

   ```bash
   curl -X POST https://wasiai-a2a-production.up.railway.app/compose \
     -H "x-a2a-key: <key-with-43114-budget>" \
     -H "x-payment-chain: avalanche-mainnet" \
     -d '{...}'
   # → response con tx hash en snowtrace.io (mainnet)
   ```

Los flips mainnet no requieren redeploy ni cambios de código (el bundle ya está wired desde W5),
pero **no son "un solo paso de env var"**: Avalanche downstream necesita opt-in + RPC + flag +
fondos, y Kite mainnet necesita las tres envs acopladas de arriba (corregido en it2 MNR-1/MNR-3 —
la frase anterior de este párrafo invitaba a setear una sola variable y quedarse a mitad de camino).

## 9. Coexistencia con downstream payment (DT-8)

`wasiai-a2a` tiene **dos paths de pago independientes** que NO se cruzan:

| Path | Variable de control | Qué controla |
|------|---------------------|--------------|
| **Inbound (debit del A2A key budget)** | `WASIAI_A2A_CHAINS` (y header `x-payment-chain` por request) | En qué chainId del JSONB `budget` se debita el caller cuando consume `/compose` o `/orchestrate` con `x-a2a-key`. |
| **Downstream (sign + settle USDC outbound)** | La chain la declara el AGENTE (`agent.payment.chain` → `normalizeChainSlug`, desde WKH-112). El único control del operador es el gate fail-CLOSED `WASIAI_DOWNSTREAM_MAINNET_ALLOW` (CSV de slugs/chainIds; ausente o vacía ⇒ NINGUNA mainnet settlea → skip-code `MAINNET_NOT_ALLOWED`). | En qué chain el orquestador firma EIP-3009 TransferWithAuthorization contra agentes externos (vía `src/lib/downstream-payment.ts`). ⚠️ `WASIAI_DOWNSTREAM_NETWORK` (WKH-55) era la "variable de control" documentada pero **NO la lee ningún archivo de `src/`**: control muerto, retirado en el fix-pack AR-profundo FIX 1c. |

Ambos pueden estar en chains distintas: el caller paga al gateway en Kite testnet PYUSD (inbound)
mientras el gateway despacha USDC mainnet a N agentes en Avalanche C-Chain (downstream). Es el
modo **mainnet hybrid** que vive en producción desde 2026-04-29.

`AvalanchePaymentAdapter` (inbound) y `downstream-payment.ts` (outbound) comparten el mismo
`wasiai-facilitator` self-hosted, pero las decisiones de routing son independientes.

## 10. Technical debt trackeado

| ID | Descripción | Trigger |
|----|-------------|---------|
| **TD-NEW-KITE-PARAMS** | Refactor de `src/adapters/kite-ozone/chain.ts` + `kite-ozone/payment.ts` + `kite-ozone/index.ts` para aceptar `network` como argumento explícito en lugar de leer `process.env.KITE_NETWORK`. Hoy DT-I muta temporalmente la env var dentro del factory y la restaura en `try/finally`, pero el ADAPTER la lee en **call-time** (getter `chainId`, `getToken()`, dominio EIP-712), o sea DESPUÉS del `finally`. Consecuencias medidas (probe real, it2 MNR-3): (a) `kite-mainnet` sin `KITE_NETWORK=mainnet` arranca con `chainConfig` 2366 y adapter 2368/PYUSD-testnet; (b) los dos slugs Kite **no tienen configuración coherente posible** en el mismo proceso. Mitigación actual: `checkAdapterChainIdDrift` (`registry.ts`) lanza en la dirección peligrosa y loguea `code=ADAPTER_CHAIN_ID_DRIFT` en la segura. Nota (CR-MNR-7): la activación de Kite mainnet NO mueve `attestation` ni `gasless` — los dos tienen `chainId = 2368` HARDCODEADO (`kite-ozone/attestation.ts:8`, `kite-ozone/gasless.ts:258`) y el gasless firma su dominio EIP-712 sobre `kiteTestnet.id` (`gasless.ts:70`) y reporta `network:'kite-testnet'` (`:275`). O sea que con el rail 2366 activo, attest/gasless siguen apuntando a testnet. | Cuando aparezca una HU que requiera ambos chains Kite activos al mismo tiempo (hoy es imposible). |
| **TD-MAINNET-GATE-USA-CHAINCONFIG** | El gate de opt-in mainnet del leg downstream (`downstream-payment.ts`) clasifica el destino por `bundle.chainConfig.chainId`, pero quien firma es el ADAPTER. Mientras exista un adapter que resuelva su chain en call-time (ver TD arriba) los dos pueden divergir. Hoy la divergencia alcanzable es la SEGURA (gate=mainnet / firma=testnet) y la peligrosa la corta `checkAdapterChainIdDrift` al arrancar. | Se cierra solo cuando TD-NEW-KITE-PARAMS elimine la lectura de env en call-time. Revisar de nuevo si se agrega un adapter env-driven. |
| **TD-SOLANA-CAIP2-DENYLIST** | `classifySolanaCaip2` (`chain-resolver.ts`) es una **denylist**: sólo la referencia de mainnet-beta (o un string que contenga `mainnet`) se clasifica `mainnet`; cualquier CAIP-2 desconocido cae en `testnet` (fail-OPEN). Evaluado y NO convertido a allowlist en it2 MNR-4: (a) no es alcanzable por un agente (sale de `SOLANA_CAIP2_CHAIN_ID`, env-only) y el rail está flag-gated OFF, (b) no existe ChainKey `solana-mainnet`, (c) una allowlist de genesis conocidos rompería cualquier cluster local (`solana-test-validator` genera un genesis propio) y obligaría a tocar 3 archivos de test que usan refs sintéticas (`solana:test`, `solana:testcluster`), incluido el del money-path. | Cuando exista un ChainKey `solana-mainnet` o el rail Solana salga de flag OFF: ahí la clasificación pasa a decidir sobre dinero real y debe volverse allowlist (y el cluster local, una excepción explícita por env). |
| **TD-INBOUND-ZERO-PAYTO** ✅ **CERRADA (HU-DOUBLE-PAY)** | ~~El sign x402 **INBOUND** (`compose.ts` → `invokeAgent`, guard `inboundVmUnsupported`) valida el `payTo` del agente sólo por FORMATO~~. Esa rama NO era un leg inbound: era un **SEGUNDO pago de salida** del wallet del operador al mismo agente, en paralelo al leg downstream (doble pago confirmado en prod, 22 de los 25 agentes del catálogo vivo lo disparaban con un caller x402). Se **BORRÓ**. Con ella desapareció el único settle del gateway que aceptaba `payTo = 0x0000…0000`: hoy el ÚNICO leg de salida es el DOWNSTREAM, que lo rechaza con `ZERO_PAY_TO` (`downstream-payment.ts` → `validatePayTo`). No hay asimetría que unificar. | — (cerrada por eliminación; no queda acción) |
| **TD-AVALANCHE-DEPOSIT-AUTOMATION** | Automatizar el deposit Avalanche (§7) reemplazando el SQL `register_a2a_key_deposit` manual por verificación on-chain (lectura del USDC `Transfer` log al wallet del operator + acreditación automática del budget). Mirror del flow Kite existente. | Post-MVP. Requerido si el volumen de smoke tests Avalanche se vuelve operacionalmente costoso. |

Ver también [`CHAIN-ADAPTIVE.md`](CHAIN-ADAPTIVE.md) §7 (Open Questions) y el SDD §11
(Missing Inputs resueltos).

### 10.1 WKH-315 — el depósito prepago Solana: envs nuevas y qué deuda activa

El camino de **ENTRADA** de dinero por Solana (`POST /auth/deposit` con una firma
base58) agrega tres variables de entorno, todas OFF/vacías por default. El registro vive
acá porque es el registro de deudas del multichain; el runbook que le sirve al
**depositante** vive en [`../INTEGRATION.md`](../INTEGRATION.md) §6, y el razonamiento
completo de cada variable, en `.env.example`.

| Env | Qué controla | Default |
|-----|--------------|---------|
| `A2A_DEPOSIT_OWNER_SOLANA` | Pubkey base58 dueña de la cuenta de depósito. **Sin fallback**: ausente o inválida ⇒ camino apagado. El destino publicado NO es esta pubkey sino la **ATA** derivada de (mint, owner). | vacía |
| `A2A_DEPOSIT_ENABLED_SOLANA` | Gate del camino de entrada, comparación literal contra `'true'`. Separado de `SOLANA_ADAPTER_ENABLED` a propósito: encender el rail de SALIDA y abrir una ENTRADA de dinero son dos decisiones. | `false` |
| `A2A_DEPOSIT_OWNER_IS_DEDICATED_SOLANA` | **Afirmación del operador**, no un apagador: declara que la cuenta de depósito es deliberadamente distinta de la del operador. Sin ella, `getSolanaOperatorKeypair()` lanza cuando las dos pubkeys difieren **y el camino de depósito está encendido**. | vacía |

**Orden de activación, no negociable**: migración → `A2A_DEPOSIT_OWNER_SOLANA` → el flag
al final. La migración antes del código no deja ventana; el orden inverso degrada
ruidosamente (el flag OFF hace que el camino no exista) en vez de duplicar un crédito.

**La deuda que este camino ERODA — `TD-SOLANA-CAIP2-DENYLIST`** (fila de la tabla de
arriba). Su condición de reactivación era *"cuando exista un ChainKey `solana-mainnet`
**o** el rail Solana salga de flag OFF"*. De las tres condiciones que hoy la hacen
tolerable, **el depósito eroda la segunda**: poner `A2A_DEPOSIT_ENABLED_SOLANA=true` en
un entorno que además sirve valor real dispara la conversión a **allowlist fail-CLOSED**,
y esa story hay que abrirla ANTES del flip. La deuda **no se cierra en WKH-315** (Scope
OUT del SDD §6): se declara y queda sin dueño asignado.

## 11. Referencias

- **Work item**: [`../sdd/086-wkh-multichain-a2a/work-item.md`](../sdd/086-wkh-multichain-a2a/work-item.md)
- **SDD completo**: [`../sdd/086-wkh-multichain-a2a/sdd.md`](../sdd/086-wkh-multichain-a2a/sdd.md)
- **Story File (F2.5)**: [`../sdd/086-wkh-multichain-a2a/story-file.md`](../sdd/086-wkh-multichain-a2a/story-file.md)
- **Arquitectura general**: [`CHAIN-ADAPTIVE.md`](CHAIN-ADAPTIVE.md)
- **Kite contract details**: [`../kite-contracts.md`](../kite-contracts.md)
- **A2A index**: [`../sdd/_INDEX.md`](../sdd/_INDEX.md)

### ACs cubiertos por tests (F3)

| AC | Wave | Test file |
|----|------|-----------|
| AC-1 (init multi-chain CSV) | W0 | `src/adapters/__tests__/registry.test.ts` |
| AC-2 (legacy single-chain) | W0 | `src/adapters/__tests__/registry.test.ts` |
| AC-3 (unsupported chain throws) | W0 | `src/adapters/__tests__/registry.test.ts` |
| AC-4 (header chainId numeric) | W2 | `src/middleware/a2a-key.test.ts` |
| AC-5/AC-6 (default fallback) | W2 | `src/middleware/a2a-key.test.ts` |
| AC-7 (CHAIN_NOT_SUPPORTED) | W2 | `src/middleware/a2a-key.test.ts` |
| AC-8 (INSUFFICIENT_BUDGET chainId) | W3 | `src/middleware/a2a-key.test.ts` |
| AC-9 (single debit per request) | W3 | `src/middleware/a2a-key.test.ts` |
| AC-10 (discovery payment.chain/asset) | W4 | `src/services/discovery.test.ts` |
| AC-11 (structured log fields) | W2 | `src/middleware/a2a-key.test.ts` |
| AC-12 (baseline + new tests pass) | W6 | `npm test` (908 tests) |
| AC-13/AC-14 (smoke mainnet) | F4 | Post-deploy (out of Dev scope) |

## 12. Change log

| Date | Change | Author |
|------|--------|--------|
| 2026-05-13 | Initial document — multi-chain registry F3 done (W0-W6) | Fernando Rosas |
