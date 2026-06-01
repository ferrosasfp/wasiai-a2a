# Autonomous Agent (reference) — `examples/autonomous-agent.ts`

Agente económico **autónomo** de referencia para `@wasiai/agent-sdk` (WKH-105).
Dado una funding wallet (private key) + un goal, corre el ciclo de vida completo
**sin intervención humana**:

```
provision → mintIdentity (gated) → operate (paga budget) → getReputation
```

El SDK se importa por **source path** (`../packages/agent-sdk/src/index.js`,
NodeNext) — **no requiere build previo** del SDK. Se corre con `tsx` (ya en las
devDependencies de la raíz).

## Prerequisitos

- **Gas + USDC de testnet** en la funding wallet en la red elegida
  (OBS-3 / MI-5). El agente hace una transferencia ERC-20 real al treasury y
  paga el gas con esa wallet. Sin saldo, el step `transfer` falla.
- Node >= 20.

## Variables de entorno

| Var | Requerida | Default |
|-----|-----------|---------|
| `FUNDER_PK` | **Sí** | — (sin ella → `exit 1`) |
| `A2A_BASE` | no | `https://wasiai-a2a-production.up.railway.app` |
| `NETWORK` | no | `base-sepolia` (slug de `/auth/deposit-info`) |
| `RPC_URL` | no | por network: base-sepolia → `https://sepolia.base.org`, avalanche-fuji → `https://api.avax-test.network/ext/bc/C/rpc` |
| `CHAIN_ID` | no | por network: base-sepolia → `84532`, avalanche-fuji → `43113` |
| `AMOUNT` | no | `1.0` |
| `OWNER_REF` | no | `autonomous-agent-demo` |
| `GOAL` | no | `summarize text` |
| `ENABLE_IDENTITY_MINT` | no | `false` (mint ERC-8004 solo si `=== 'true'`) |
| `ERC8004_REGISTRY_ADDRESS` | solo si mint | — (address del IdentityRegistry) |
| `MAX_AGENT_BUDGET_USD` | no | sin tope (`undefined`) |

> La PK, la Agent Key (`wasi_a2a_*`) y `err.cause` **NUNCA** se imprimen
> (anti-leak, AC-10/CD-5).

## Correr

```bash
A2A_BASE=https://wasiai-a2a-production.up.railway.app \
FUNDER_PK=0x<tu-private-key> \
NETWORK=base-sepolia \
npx tsx examples/autonomous-agent.ts
```

Con mint de identidad ERC-8004 (gated):

```bash
ENABLE_IDENTITY_MINT=true \
ERC8004_REGISTRY_ADDRESS=0x<IdentityRegistry> \
FUNDER_PK=0x<tu-private-key> \
NETWORK=base-sepolia \
npx tsx examples/autonomous-agent.ts
```

> El mint usa `register(string agentURI) → uint256 agentId` a `msg.sender` y
> parsea el `agentId` del evento `Registered` del receipt (CD-13). El
> `agentURI` es el AgentCard como `data:application/json;base64,...`.
>
> Las direcciones canónicas del `IdentityRegistry` ERC-8004 en Base son
> referencia de documentación (ver SDD §3); el código **nunca** las hardcodea —
> salen de env.

## Códigos de salida

- `exit 0` — ciclo completo, o skip esperado (`OPERATE_SKIP` sin agente en
  budget; `IDENTITY_SKIP` mint deshabilitado).
- `exit 1` — falla de step. Imprime `STEP_FAILED step=... code=... message=...`
  (sin secretos).
