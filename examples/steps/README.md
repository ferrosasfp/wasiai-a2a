# Fondeo paso a paso (1 script por paso)

Misma secuencia que `examples/fund-agent-key.mjs`, pero partida en 6 pasos para correrlos
de a uno y ver el resultado de cada endpoint. El estado compartido vive en
`/tmp/wasi-run/state.json` (cada paso lee lo que dejó el anterior).

## Requisitos
- `npm i viem` (ya es dependencia del repo).
- Una funding wallet con el token (USDC/PYUSD) + gas nativo en la red elegida.

## Mínimo de depósito

El gateway aplica un **mínimo por transacción** (`A2A_DEPOSIT_MIN_USDC`, hoy 1 USDC) y lo
publica en `GET /auth/deposit-info` como `deposit_minimum_usdc` + `deposits_enabled`. El
paso 2 lo guarda en el estado y el paso 4 lo usa como monto por defecto, así que estos
scripts se auto-configuran: no hay un número clavado que se desactualice.

Un depósito por debajo del mínimo se rechaza con `400 DEPOSIT_BELOW_MINIMUM` **después**
de que la transferencia ya ocurrió, y la treasury es custodial: esos fondos quedan en la
billetera del operador y no se acreditan. Por eso el paso 4 corta antes de firmar si
`AMOUNT` no llega al mínimo, y el paso 2 corta si `deposits_enabled` es `false`.

## Orden

| Paso | Script | Endpoint / acción | Necesita |
|------|--------|-------------------|----------|
| 1 | `1-signup.mjs` | `POST /auth/agent-signup` | `A2A_BASE`, `OWNER_REF` |
| 2 | `2-deposit-info.mjs` | `GET /auth/deposit-info` | `A2A_BASE`, `NETWORK` |
| 3 | `3-bind-wallet.mjs` | `POST /auth/funding-wallet` (firma) | `A2A_BASE`, `FUNDER_PK` |
| 4 | `4-transfer.mjs` | transfer ERC-20 → treasury (paga gas) | `A2A_BASE`, `FUNDER_PK`, `AMOUNT` (opcional) |
| 5 | `5-deposit.mjs` | `POST /auth/deposit` (verify-before-credit) | `A2A_BASE` |
| 6 | `6-me.mjs` | `GET /auth/me` | `A2A_BASE` |

## Ejecutar

```bash
export A2A_BASE=https://wasiai-a2a-production.up.railway.app
export FUNDER_PK=0xTuPrivateKey        # la wallet que tiene los USDC
export NETWORK=avalanche-fuji
export AMOUNT=1                        # opcional: si no la ponés, el paso 4 usa el mínimo publicado
export OWNER_REF=wkh35-manual          # prefijo barrido por el cleanup

node examples/steps/1-signup.mjs
node examples/steps/2-deposit-info.mjs
node examples/steps/3-bind-wallet.mjs
node examples/steps/4-transfer.mjs
node examples/steps/5-deposit.mjs
node examples/steps/6-me.mjs
```

## Limpieza

Estos pasos dejan una Agent Key de prueba y sus deposits. Para borrarlos, eliminá las
filas de `a2a_agent_keys` y `a2a_key_deposits` cuyo `owner_ref` sea `LIKE 'wkh35-%'`.

El script de barrido es utilería interna de operaciones y **no se versiona en este
repositorio**: si trabajás en el equipo, pedilo; si no, el criterio de arriba es todo lo
que hace.
