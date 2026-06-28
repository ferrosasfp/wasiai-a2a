# Testnet 100% — acciones que requieren tu wallet/keys (FOUNDER)

Estos 3 items NO son code-fixable: necesitan una wallet fondeada, una sesion
Passport aprobada con passkey, o una private key de sponsor. Quedan listos para
que solo los ejecutes. Todo es TESTNET (Kite / Fuji / Base Sepolia), nada de
mainnet.

Gateway de prod (testnet money tables, DB caldz):
`https://wasiai-a2a-production.up.railway.app`

---

## 1. Agent key registrada en caldz + fondeada (valida el path PREPAGO)

**Por que:** el flujo x402 por-llamada ya esta probado live. Lo que falta probar
end-to-end es el modelo PREPAGO (agent key con budget). Las unicas keys locales
viven en la DB `bdwv` (la equivocada); el gateway lee `caldz`. Necesitamos una
key creada contra el gateway de prod (que escribe en caldz) y con budget cargado
via el escrow no-custodial.

**Paso 1 — crear la key (escribe en caldz):**
```bash
curl -s -X POST https://wasiai-a2a-production.up.railway.app/auth/agent-signup \
  -H 'content-type: application/json' \
  -d '{"owner_ref":"founder-testnet","display_name":"testnet-100 prepaid","daily_limit_usd":50,"max_spend_per_call_usd":5}'
```
Devuelve `{ key_id: "wasi_a2a_...", key_id_hash: "0x...", ... }`.
- `key_id` = el secreto que va en el header `x-a2a-key` (guardalo, no se vuelve a mostrar).
- `key_id_hash` = el bytes32 que el contrato escrow usa como `keyId` para depositar.

**Paso 2 — fondear el budget via escrow (deposito on-chain, testnet):**
Bindea tu funding wallet y depositas USDC de testnet al contrato escrow; el
gateway verifica el deposito y acredita el budget. El flujo HTTP completo
(signup -> bind funding-wallet -> deposit on-chain -> POST /auth/deposit ->
budget acreditado) esta implementado y ya corrio en las 3 cadenas. Usa el script
de deposito como referencia ejecutable:
```bash
# exporta tu private key de la funding wallet (testnet, con USDC + gas)
export FUNDER_PK=0x<tu_private_key_testnet>
export A2A_KEY=wasi_a2a_<la_key_del_paso_1>
node scripts/smoke-prod-deposit.mjs   # deposita y verifica el credito de budget
```
(Si preferis hacerlo desde la pagina: `wasiai.io/a2a` tiene el widget MetaMask
para fondear el escrow en vivo.)

**Paso 3 — validar el path prepago end-to-end:**
```bash
export A2A_KEY=wasi_a2a_<la_key>
node scripts/smoke-e16-agent-key.mjs        # superficie de gestion de la key
node scripts/smoke-compose-pipeline.mjs     # /compose pagando con x-a2a-key (prepago)
```
Exito = compose/orchestrate descuentan del budget de la key (no x402 por-llamada)
y el ledger (budget + daily + dest-cap) cierra.

---

## 2. Sesion Passport (kpass) aprobada con passkey (valida Passport autonomo)

**Por que:** `smoke-passport-autonomous.mjs` corta con
`human_gate_required: no_active_session`. El binding Passport pide una sesion
kpass viva (aprobada una vez con passkey), que dura ~24h.

**Paso 1 — login + sesion (una sola vez, requiere tu passkey):**
```bash
kpass login init --email <tu_email> --client agent --output json --no-interactive
# revisa el mail, pasa el codigo de 8 chars:
KPASS_LOGIN_CODE=<codigo> kpass login verify --login-id <login_id> --output json
# crea la sesion de agente (aprobas con passkey en el dispositivo):
kpass agent:session create --ttl 24h --output json
```

**Paso 2 — correr el smoke con la sesion activa:**
```bash
export SMOKE_KPASS_BIN=$(which kpass)
node scripts/smoke-passport-autonomous.mjs
```
Exito = el flujo autonomo Passport pasa el human-gate y settlea via Passport/x402.

> Nota: hoy el binding Passport esta gateado (`PASSPORT_BINDING_ENABLED=false`).
> Para el demo, presentalo como "integrado, pendiente de listing en Kite", no
> como auth en vivo (ver el reframe del deck).

---

## 3. FUNDER_PK — sponsor wallet fondeada (valida smokes de deposito/downstream)

**Por que:** los smokes de deposito y de downstream con dinero
(`smoke-prod-deposit*.mjs`, `smoke-base-downstream*.mjs`) necesitan una wallet
sponsor con USDC + gas de testnet para originar las transferencias.

**Que preparar:**
- Una wallet de testnet con saldo en las cadenas que quieras validar:
  - Base Sepolia: USDC testnet + ETH de gas
  - Fuji (Avalanche testnet): USDC testnet + AVAX de gas
  - Kite testnet: PYUSD/USDC testnet + gas
- Export antes de correr cualquier smoke de deposito:
```bash
export FUNDER_PK=0x<private_key_testnet_con_fondos>
```
- Faucets: usa los faucets de cada testnet (o `kpass faucet drop` para el entorno Kite).

**No reutilices** una key de mainnet ni una con fondos reales. Es solo testnet.

---

## 4. WKH-120 — settlements con destino distinto en Kite + Base (config registry)

**Por que:** los 3 links de settlement del slide 5b del deck eran self-transfers
(`from == to == operator`). En Avalanche/Fuji YA quedo limpio: el deck apunta a
`0x789469fd...` (operator -> wasi-chainlink-price `0x9316...`, destino distinto
verificado on-chain). Pero **Kite y Base solo tienen agentes demo registrados**
cuyo `payment.payTo` es el propio operador -> en esas 2 cadenas el gateway solo
puede producir self-transfers. NO es bug de codigo; es config del registry.

**Que hace falta (por cada cadena, Kite y Base):** registrar al menos un agente
con un `payment.payTo` que NO sea el operador y `payment.chain` = esa cadena, y
despues correr un `/compose` contra ese agente para generar el settlement limpio.

**Paso 1 — registrar un agente con payout propio en la cadena:**
```bash
# ejemplo para Base Sepolia; repetir con chain=kite-ozone-testnet para Kite
curl -s -X POST https://wasiai-a2a-production.up.railway.app/registries/<registry>/agents \
  -H 'content-type: application/json' -H 'x-a2a-key: wasi_a2a_<admin_key>' \
  -d '{
    "slug":"wasi-price-base",
    "name":"Price feed (Base)",
    "priceUsdc":0.001,
    "payment":{"chain":"base-sepolia","payTo":"0x<wallet_de_payout_distinta>"}
  }'
```
(El shape exacto del registro depende de tu API de registry; lo importante es
`payment.payTo != operador` y `payment.chain` = la cadena objetivo.)

**Paso 2 — generar el settlement limpio y capturar el hash:**
```bash
export A2A_KEY=wasi_a2a_<key_con_budget>
node scripts/smoke-base-sepolia.mjs        # Base; usar el smoke de Kite para Kite
# anota el tx hash outbound (gateway -> wallet de payout)
```

**Paso 3 — verificar destino distinto on-chain y actualizar el deck:**
```bash
# confirma que el recipient del Transfer != operador 0xf432...47Ba
# luego reemplaza en deck-inversores-en/es.html (slide 5b) el href de Kite/Base
```
Cuando los 3 (Kite, Avalanche, Base) tengan destino distinto verificable, WKH-120
queda cerrado y los 3 links del slide 5b son evidencia 100% limpia.

> Avalanche ya esta cerrado en el deck (`0x789469fd...`). Faltan Kite y Base.

---

## Checklist rapido

- [ ] Key creada en caldz (`/auth/agent-signup`) + `key_id` guardado
- [ ] Budget fondeado via escrow (`smoke-prod-deposit.mjs` o widget wasiai.io/a2a)
- [ ] Path prepago validado (`smoke-compose-pipeline.mjs` descuenta del budget)
- [ ] Sesion kpass creada (passkey) + `smoke-passport-autonomous.mjs` verde
- [ ] `FUNDER_PK` exportada + smokes de deposito verdes en las cadenas elegidas
- [ ] WKH-120: agente con payout propio registrado en Kite + Base, settlements
      limpios regenerados, deck slide 5b actualizado (Avalanche ya esta hecho)

Cuando estos 5 esten en verde, el path prepago + Passport + deposito quedan
probados en testnet y el ecosistema esta al 100% en testnet de punta a punta.
