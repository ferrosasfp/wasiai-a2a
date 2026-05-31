# Integrar el fondeo de un Agent Key (WasiAI-a2a)

Guía para que un dev (o un agente autónomo) cargue saldo USDC en su Agent Key y use `/compose` y `/orchestrate`.

## Modelo de 3 claves (no confundir)
| Entidad | Qué es | De quién |
|---|---|---|
| **Agent Key** `wasi_a2a_*` | API key (token de auth). No es wallet, no tiene private key. Guarda tu saldo `budget[chainId]`. | tu cuenta |
| **Funding wallet** | Tu wallet (MetaMask o private key). Tiene los USDC, firma y paga el gas. | el dev / agente |
| **Treasury / Operator** | Direcciones de WasiAI. El treasury recibe tu USDC; el operator paga a los sub-agentes. | WasiAI |

## Prerrequisitos
- Node + `npm i viem` (o cualquier cliente EVM en tu stack).
- Una funding wallet con **USDC** + un poco de **gas nativo** (AVAX en Avalanche, ETH en Base) en la red elegida.
- La **dirección del treasury** de WasiAI para esa red (te la damos — ver "Pendiente" abajo).

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

### 3. Transferir USDC al treasury (transacción real, PAGA GAS)
Hacés un `transfer` ERC-20 de X USDC desde tu funding wallet a la dirección del treasury, en la red elegida. Guardás el `tx_hash`.
- USDC Avalanche Fuji: `0x5425890298aed601595a70AB815c96711a31Bc65` (6 dec)
- USDC Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 dec)

### 4. Declarar el depósito (WasiAI verifica on-chain antes de acreditar)
```bash
curl -X POST $A2A_BASE/auth/deposit \
  -H "x-a2a-key: $KEY" -H 'Content-Type: application/json' \
  -d '{"key_id":"<key_id>","tx_hash":"0x...","chain_id":43113}'
# -> { "balance": "1", "chain_id": 43113 }
```
Verificamos: status success, chainId match, confirmaciones (Avax 3 / Base 1), Transfer del USDC esperado con `to==treasury`, `from==tu funding wallet`, anti-replay. Solo entonces acreditamos `budget[chainId]` con el monto real on-chain.

### 5. Usar el saldo
```bash
curl $A2A_BASE/auth/me -H "x-a2a-key: $KEY"     # ver budget por red
# Luego /compose o /orchestrate con  -H "x-a2a-key: $KEY"  y  -H "x-payment-chain: avalanche-fuji"
```

## Script runnable
`fund-agent-key.mjs` hace los 5 pasos end-to-end (incluye el transfer on-chain con viem):
```bash
A2A_BASE=https://wasiai-a2a-production.up.railway.app \
FUNDER_PK=0xTuPrivateKey TREASURY=0xTreasuryWasiAI \
NETWORK=avalanche-fuji AMOUNT_USDC=1.0 \
node examples/fund-agent-key.mjs
```

## Variante frontend (humano con MetaMask)
Mismo flujo, pero en vez de una private key usás la wallet conectada:
- Paso 2: `await walletClient.signMessage({ account, message })` con el `walletClient` de viem/wagmi creado desde `window.ethereum` (MetaMask abre popup de firma, gratis).
- Paso 3: `await walletClient.writeContract({...transfer...})` (MetaMask abre popup de confirmación; el usuario paga el gas).
El resto (POST /auth/funding-wallet y /auth/deposit) son llamadas HTTP normales.

## Pendiente (mejora recomendada)
Hoy la **dirección del treasury** y la lista de **tokens/redes soportadas** salen de env del server y se entregan out-of-band. Para integración self-serve conviene exponer un `GET /auth/deposit-info` que devuelva, por red: `treasury`, `token` (address + símbolo + decimales), `chain_id` y `min_confirmations`. Mientras tanto, pedile a WasiAI la dirección del treasury de la red que vas a fondear.
