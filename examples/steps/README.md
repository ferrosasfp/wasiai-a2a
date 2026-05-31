# Fondeo paso a paso (1 script por paso)

Misma secuencia que `examples/fund-agent-key.mjs`, pero partida en 6 pasos para correrlos
de a uno y ver el resultado de cada endpoint. El estado compartido vive en
`/tmp/wasi-run/state.json` (cada paso lee lo que dejó el anterior).

## Requisitos
- `npm i viem` (ya es dependencia del repo).
- Una funding wallet con el token (USDC/PYUSD) + gas nativo en la red elegida.

## Orden

| Paso | Script | Endpoint / acción | Necesita |
|------|--------|-------------------|----------|
| 1 | `1-signup.mjs` | `POST /auth/agent-signup` | `A2A_BASE`, `OWNER_REF` |
| 2 | `2-deposit-info.mjs` | `GET /auth/deposit-info` | `A2A_BASE`, `NETWORK` |
| 3 | `3-bind-wallet.mjs` | `POST /auth/funding-wallet` (firma) | `A2A_BASE`, `FUNDER_PK` |
| 4 | `4-transfer.mjs` | transfer ERC-20 → treasury (paga gas) | `A2A_BASE`, `FUNDER_PK`, `AMOUNT` |
| 5 | `5-deposit.mjs` | `POST /auth/deposit` (verify-before-credit) | `A2A_BASE` |
| 6 | `6-me.mjs` | `GET /auth/me` | `A2A_BASE` |

## Ejecutar

```bash
export A2A_BASE=https://wasiai-a2a-production.up.railway.app
export FUNDER_PK=0xTuPrivateKey        # la wallet que tiene los USDC
export NETWORK=avalanche-fuji
export AMOUNT=0.05
export OWNER_REF=wkh35-manual          # prefijo barrido por el cleanup

node examples/steps/1-signup.mjs
node examples/steps/2-deposit-info.mjs
node examples/steps/3-bind-wallet.mjs
node examples/steps/4-transfer.mjs
node examples/steps/5-deposit.mjs
node examples/steps/6-me.mjs
```

## Limpieza
```bash
./scripts/cleanup-wkh-35-prod-testkey.sh   # borra keys + deposits con owner_ref LIKE 'wkh35-%'
```
