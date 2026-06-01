# @wasiai/agent-sdk

SDK TypeScript para agentes económicos autónomos sobre el protocolo WasiAI-a2a.
Cubre el ciclo de vida completo sin intervención humana:

```
provision → mintIdentity (gated) → operate (paga budget) → delegate → getReputation
```

## Uso mínimo

```ts
import { privateKeyToAccount } from 'viem/accounts';
import { WasiAgent } from '@wasiai/agent-sdk';

const account = privateKeyToAccount(process.env.FUNDER_PK as `0x${string}`);
const agent = new WasiAgent(account, {
  a2aBase: 'https://wasiai-a2a-production.up.railway.app',
  network: 'base-sepolia',
  rpcUrl: 'https://sepolia.base.org',
  chainId: 84532, // chain de pago/funding (debe coincidir con el server)
});

await agent.provision({ ownerRef: 'mi-app', amount: '1.0' });
const op = await agent.operate({ goal: 'summarize text' });
```

## Configuración (`WasiAgentConfig`)

| Campo | Tipo | Notas |
|-------|------|-------|
| `a2aBase` | `string` | Base URL del servicio A2A |
| `network` | `string` | slug que matchea `/auth/deposit-info` (ej. `base-sepolia`) |
| `rpcUrl` | `string` | RPC de la chain de pago |
| `chainId` | `number` | viem chain + chain de pago/funding (debe `==` server) |
| `delegationChainId` | `number?` | chainId del domain EIP-712 de delegación. Ver abajo. |
| `identityRegistryAddress` | `0x${string}?` | registry ERC-8004 (mint) |
| `enableIdentityMint` | `boolean?` | gate del mint on-chain (default off) |
| `maxAgentBudgetUsd` | `number?` | tope por agente (undefined = sin tope) |

## Delegación EIP-712 y `delegationChainId`

El server arma el domain EIP-712 de la delegación con
`chainId: Number(KITE_CHAIN_ID)` — la **chain de delegación**, que puede diferir
de la chain de pago/funding (`config.chainId`).

Por eso el SDK separa ambos:

- `chainId` → chain de pago/funding (transfers ERC-20, deposit, mint).
- `delegationChainId` → chainId del domain EIP-712 que firma `delegate()`.
  Si se omite, usa `chainId`.

**`delegationChainId` DEBE coincidir con el `KITE_CHAIN_ID` del server
(default `8453`).** Si no coinciden, la firma EIP-712 de la delegación no
validará server-side.

```ts
const agent = new WasiAgent(account, {
  a2aBase: '...',
  network: 'base-sepolia',
  rpcUrl: 'https://sepolia.base.org',
  chainId: 84532,        // pago en Base Sepolia
  delegationChainId: 8453, // delegación firmada sobre Base mainnet (KITE_CHAIN_ID)
});
```

## Notas de identidad (ERC-8004)

`mintIdentity()` mintea on-chain (`register(string)`) y luego hace bind via
`POST /auth/erc8004/bind`. El bind es **verificación de ownership + persist en
DB, sin write on-chain** → no produce `tx_hash`. Por eso `MintResult` expone
solo `mintTxHash` (el único tx del flujo), no un `bindTxHash`.
