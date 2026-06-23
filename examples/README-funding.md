# Integrar el fondeo de un Agent Key (WasiAI-a2a)

Guía para que un dev (o un agente autónomo) cargue saldo USDC en su Agent Key y use `/compose` y `/orchestrate`.

## Modelo de claves (no confundir)
| Entidad | Qué es | De quién |
|---|---|---|
| **Agent Key** `wasi_a2a_*` | API key (token de auth). No es wallet, no tiene private key. Guarda tu saldo `budget[chainId]`. | tu cuenta |
| **Funding wallet** | Tu wallet (MetaMask o private key). Tiene los USDC, firma y paga el gas. | el dev / agente |
| **Escrow no-custodial** | Contrato on-chain que custodia tu depósito. El operador **no puede mover los fondos sin tu firma** (EIP-712). Modo por defecto en prod. | contrato (vos controlás) |
| **Treasury / Operator** | Direcciones de WasiAI. Fallback legacy: solo se usa si la red no tiene escrow activo. | WasiAI |

## Prerrequisitos
- Node + `npm i viem` (o cualquier cliente EVM en tu stack).
- Una funding wallet con **USDC/PYUSD** + un poco de **gas nativo** (AVAX en Avalanche, ETH en Base, KITE en Kite) en la red elegida.
- A dónde depositar (`escrow_contract` o `treasury`) sale de `GET /auth/deposit-info` — no hace falta saberlo de antemano.

## Paso a paso

### 1. Crear el Agent Key
```bash
curl -X POST $A2A_BASE/auth/agent-signup \
  -H 'Content-Type: application/json' \
  -d '{"owner_ref":"dev-demo","display_name":"dev demo"}'
# -> { "key": "wasi_a2a_....", "key_id": "uuid" }   (guardá 'key', se muestra una sola vez)
```

### 2. Vincular tu funding wallet (firma, SIN gas)
Firmás el mensaje canónico `WASIAI_BIND_FUNDING_WALLET:<key_id>` con tu wallet (personal_sign / EIP-191) y lo mandás:
```bash
curl -X POST $A2A_BASE/auth/funding-wallet \
  -H "x-a2a-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"wallet":"0xTuWallet","signature":"0xFirma"}'
# -> { "funding_wallet": "0xtuwallet" }
```
Esto ata tu key a TU wallet (gate anti front-run). Es solo una firma: no mueve fondos, no paga gas.

### 3. Depositar on-chain (transacción real, PAGA GAS)
Con **escrow** activo (default en prod) son dos txs desde tu funding wallet:
1. `approve(escrow_contract, amount)` sobre el token — autorizás al contrato a tomar tus USDC.
2. `deposit(keyId, amount)` sobre el `escrow_contract` — donde `keyId = keccak256(utf8(key_id))`.

El `escrow_contract` y el `token.address` salen de `GET /auth/deposit-info`. Guardás el `tx_hash` del **deposit**.
- USDC Avalanche Fuji: `0x5425890298aed601595a70AB815c96711a31Bc65` (6 dec)
- USDC Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 dec)

Fallback legacy (solo si la red **no** tiene escrow): un único `transfer` ERC-20 al `treasury`.

### 4. Declarar el depósito (WasiAI verifica on-chain antes de acreditar)
```bash
curl -X POST $A2A_BASE/auth/deposit \
  -H "x-a2a-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"key_id":"<key_id>","tx_hash":"0x...","chain_id":43113}'
# -> { "balance": "1", "chain_id": 43113 }
```
Con escrow verificamos: status success, chainId match, confirmaciones (Avax 3 / Base 1 / Kite 1), evento `Deposited(keyId, from, amount)` del contrato con `keyId` esperado y `from==tu funding wallet`, anti-replay. Solo entonces acreditamos `budget[chainId]` con el monto real on-chain. (En modo treasury se valida el `Transfer` con `to==treasury` en vez del evento `Deposited`.)

### 5. Usar el saldo
```bash
curl $A2A_BASE/auth/me -H "x-a2a-key: $KEY"     # ver budget por red
# Luego /compose o /orchestrate con  -H "x-a2a-key: $KEY"  y  -H "x-payment-chain: avalanche-fuji"
```

## Script runnable
`fund-agent-key.mjs` hace los 5 pasos end-to-end con viem (detecta escrow vs treasury solo):
```bash
A2A_BASE=https://wasiai-a2a-production.up.railway.app \
FUNDER_PK=0xTuPrivateKey NETWORK=avalanche-fuji AMOUNT=1.0 \
node examples/fund-agent-key.mjs
```
Redes soportadas en el script: `avalanche-fuji`, `base-sepolia`, `kite-ozone-testnet` (esta última usa `KITE_RPC_URL`). El script llama a `GET /auth/deposit-info` y toma `escrow_contract`/`treasury`, `token` y `decimales` automáticamente; si la red tiene `escrow_mode`, hace `approve` + `deposit` al contrato, si no, el `transfer` legacy al treasury.

## Variante frontend (humano con MetaMask)
Mismo flujo, pero en vez de una private key usás la wallet conectada:
- Paso 2: `await walletClient.signMessage({ account, message })` con el `walletClient` de viem/wagmi creado desde `window.ethereum` (MetaMask abre popup de firma, gratis).
- Paso 3 (escrow): `writeContract({...approve...})` y luego `writeContract({...deposit...})` (dos popups de confirmación; el usuario paga el gas). En modo treasury es un único `writeContract({...transfer...})`.
El resto (POST /auth/funding-wallet y /auth/deposit) son llamadas HTTP normales. Esto es exactamente lo que hace el widget de [wasiai.io/a2a](https://wasiai.io/a2a/).
