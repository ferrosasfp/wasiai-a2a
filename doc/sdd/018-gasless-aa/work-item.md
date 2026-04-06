# SDD-018 -- Gasless Integration: EIP-3009 Stablecoin Transfers (WKH-29)

| Campo | Valor |
|-------|-------|
| HU | WKH-29 |
| Epic | WKH-4 (Sprint 4 -- Polish + Diferenciadores) |
| Tipo | feature (hackathon bonus) |
| Mode | QUALITY |
| Branch | `feat/018-gasless-aa` |
| Base | `main` |
| Sizing | **S** (~100 LOC lib + ~40 LOC integration + ~80 LOC tests) |
| Prioridad | Medium |
| Riesgo | Bajo -- testnet only, dependencia de servicio externo (gasless.gokite.ai) |
| Red | **Testnet only** (Kite Testnet, chain 2368). Mainnet → iteracion post-hackathon (ver Jira backlog) |

---

## Contexto de negocio

La integracion gasless es un **bono de evaluacion** del hackathon Kite Y un diferenciador de producto real. Permite que los usuarios/agentes ejecuten transfers de stablecoins on-chain sin necesidad de tener KITE tokens para gas. El relayer paga el gas.

### Token gasless en testnet (verificado en vivo)

Endpoint: `GET https://gasless.gokite.ai/supported_tokens`

| Red | Token | Symbol | Address | Decimals | EIP-712 name | EIP-712 version | min_transfer |
|-----|-------|--------|---------|----------|-------------|-----------------|--------------|
| **Testnet** | PYUSD | PYUSD | `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` | 18 | "PYUSD" | "1" | 0.01 PYUSD |

**Nota**: El token x402 existente (`0x0fF5...e63`, Test USDT) NO es soportado por el relayer gasless. En testnet el relayer solo soporta PYUSD. Son paths independientes.

**Mainnet (USDC.e)**: Soportado por el relayer (`0x7aB6f3ed...149e`, chain 2366) pero fuera de scope de esta iteracion. Requiere chain definition mainnet + PublicClient dinámico. Ver Jira backlog para post-hackathon.

### El proyecto ya tiene:
- `viem` configurado con Kite (chain 2368 testnet) en `src/lib/kite-chain.ts`
- Wallet client EIP-712 en `src/lib/x402-signer.ts` (firma x402 authorizations)
- Settlement on-chain via Pieverse facilitator en `src/middleware/x402.ts`
- NO hay llamadas directas a `sendTransaction`/`writeContract`

### Decision arquitectonica

**EIP-3009 relayer (`gasless.gokite.ai`)** en vez de `gokite-aa-sdk`:
- Reutiliza patron EIP-712 `signTypedData` existente en x402-signer.ts
- No agrega dependencia ethers.js (proyecto usa viem)
- Caso de uso principal (pago por servicios de agentes) = stablecoin transfer
- Minimo footprint, maximo impacto

---

## Context Map -- Archivos leidos y patrones encontrados

| Archivo | Patron relevante | Impacto |
|---------|-----------------|---------|
| `src/lib/kite-chain.ts` | `defineChain()` con Kite Testnet (id:2368, rpc: rpc-testnet.gokite.ai) | Reusar chain definition |
| `src/lib/x402-signer.ts` | `createWalletClient` + `privateKeyToAccount` + `signTypedData` EIP-712, lazy singleton, `OPERATOR_PRIVATE_KEY` | **Patron a seguir**: mismo patron para gasless-signer.ts |
| `src/services/kite-client.ts` | `createPublicClient` singleton, `requireKiteClient()` guard | Usar para `getBlock("latest")` (necesario para `validAfter`) |
| `src/middleware/x402.ts` | `KITE_PAYMENT_TOKEN` = `0x0fF5...e63`, settlement via Pieverse | Token DIFERENTE al del gasless relayer -- no reutilizar |
| `src/index.ts` | Fastify + rutas registradas, `kiteClient` import para init | Registrar ruta gasless |
| `package.json` | `viem: ^2.47.6`, NO ethers.js | Sin nuevas deps |
| `.env.example` | `KITE_RPC_URL`, Pieverse vars | Agregar GASLESS_ENABLED, OPERATOR_PRIVATE_KEY |
| `src/types/index.ts` | `X402PaymentPayload`, `AgentSummary`, `ReputationScore` | Agregar tipos gasless |

### Patrones de codigo detectados

1. **Lazy singleton con guard**: `x402-signer.ts` y `kite-client.ts` usan singletons con lazy init
2. **EIP-712 signing con viem**: `signTypedData()` en x402-signer.ts -- mismo patron para EIP-3009
3. **Separacion Public/Wallet client**: `kite-client.ts` = PublicClient (read), `x402-signer.ts` = WalletClient (sign)
4. **No secrets in logs**: CD-1 del proyecto -- nunca logear private keys ni signatures
5. **Tests colocados**: `*.test.ts` junto al source file

---

## Acceptance Criteria (EARS format)

### AC-1: Gasless stablecoin transfer via EIP-3009 relayer
**WHEN** the system needs to transfer stablecoins gasless on Kite testnet,
**THE SYSTEM SHALL** sign an EIP-3009 `TransferWithAuthorization` message using the operator wallet and submit it to `https://gasless.gokite.ai/testnet`, receiving a `txHash` in response.

### AC-2: EIP-712 signature compatible con viem
**WHEN** the gasless signer generates the `TransferWithAuthorization` signature,
**THE SYSTEM SHALL** use viem's `signTypedData()` with the EIP-712 domain obtained from `/supported_tokens` (name, version, chainId, verifyingContract) and decompose the signature into `v`, `r`, `s` components via `hexToSignature()`.

### AC-3: Temporal constraints respetadas
**WHEN** constructing the gasless transfer request,
**THE SYSTEM SHALL** set `validAfter` to the latest block timestamp minus 1 second (ensuring validity in the next block per EIP-3009), and `validBefore` to `validAfter` plus 25 seconds (within the 30-second window required by the relayer).

### AC-4: Token discovery via /supported_tokens
**WHEN** the gasless module needs to determine the supported token,
**THE SYSTEM SHALL** query `GET https://gasless.gokite.ai/supported_tokens`, extract the testnet token, and cache the result in memory.
**IF** the endpoint is unreachable,
**THE SYSTEM SHALL** fall back to hardcoded testnet values: PYUSD `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` (decimals: 18, name: "PYUSD", version: "1").
**THE SYSTEM SHALL** validate that the transfer amount meets the `minimum_transfer_amount` from the token config (0.01 PYUSD).

### AC-5: Feature flag
**WHEN** `GASLESS_ENABLED=true` and a gasless transfer is requested,
**THE SYSTEM SHALL** execute the transfer via the gasless relayer using PYUSD (token soportado por testnet).
**NOTE**: El token gasless (PYUSD) es diferente al token x402 (Test USDT). Son paths independientes en esta iteracion. La integracion profunda con el settlement x402 queda como iteracion futura (mainnet con USDC.e).

### AC-6: Error handling robusto
**WHEN** the gasless relayer returns an error or is unreachable,
**THE SYSTEM SHALL** log the error (without sensitive data per CD-1) and return error to caller.
**THE SYSTEM SHALL NOT** crash or block other requests -- gasless failure is isolated.

### AC-7: Status endpoint
**WHEN** `GET /gasless/status` is called,
**THE SYSTEM SHALL** return: gasless enabled (bool), network, supported token (from discovery), operator public address (never private key).

---

## Scope

### IN
- `src/lib/gasless-signer.ts` -- **NUEVO**: EIP-3009 gasless transfer module
  - `signTransferWithAuthorization(to, value)` -- firma EIP-712 con viem
  - `submitGaslessTransfer(payload)` -- POST al relayer
  - `getSupportedToken()` -- query /supported_tokens con cache + fallback
  - Lazy singleton walletClient (patron x402-signer.ts)
  - Endpoint hardcoded a testnet (`https://gasless.gokite.ai/testnet`)
- `src/lib/gasless-signer.test.ts` -- **NUEVO**: tests unitarios
- `src/types/index.ts` -- tipos `GaslessTransferRequest`, `GaslessTransferResponse`, `GaslessSupportedToken`
- `src/routes/gasless.ts` -- **NUEVO**: ruta `GET /gasless/status`
- `src/index.ts` -- registrar ruta gasless (condicional a `GASLESS_ENABLED`)
- `.env.example` -- agregar `GASLESS_ENABLED`, `OPERATOR_PRIVATE_KEY`
- `doc/sdd/018-gasless-aa/` -- documentacion SDD

### OUT
- `gokite-aa-sdk` / ethers.js (requiere ethers, fuera de stack)
- Modificar middleware x402 (`requirePayment`) -- paths independientes por ahora
- Paymaster / gas sponsorship ERC-4337 completo
- Smart account (AA wallet) creation o management
- UI para gasless transfers
- Multi-chain (solo Kite Testnet en esta iteracion)
- **Mainnet support (Kite Mainnet, chain 2366, USDC.e)** -- requiere `kiteMainnet` chain definition, PublicClient dinamico, y chainId dinamico. **Documentado en Jira backlog post-hackathon (ver Referencias)**
- Integracion profunda gasless ↔ x402 settlement (requiere mismo token en ambos paths -- iteracion futura)

---

## Missing Inputs

| Input | Estado | Mitigacion |
|-------|--------|------------|
| `/supported_tokens` respuesta | **RESUELTO** -- verificado en vivo | Testnet: PYUSD `0x8E04...2ec9` |
| EIP-712 domain values testnet | **RESUELTO** -- verificado en vivo | name="PYUSD" version="1" chainId=2368 |
| Rate limits del relayer | Desconocido | Retry basico: 1 retry con 2s delay |
| Balance PYUSD en wallet operadora (testnet) | Verificar pre-test | Faucet: faucet.gokite.ai o mint si disponible |
| Endpoint submit formato exacto | Parcial (del gist) | `POST https://gasless.gokite.ai/testnet` con body JSON |

---

## Dependencias

| Dependencia | Tipo | Estado |
|-------------|------|--------|
| `viem ^2.47.6` | npm (existente) | Ya instalado |
| `src/lib/kite-chain.ts` | Codigo interno | Estable, reusar chain definition |
| `src/services/kite-client.ts` | Codigo interno | Estable, usar `requireKiteClient()` para `getBlock("latest")` |
| `src/lib/x402-signer.ts` | Codigo interno (patron) | Referencia de patron, sin modificar |
| Kite Gasless Relayer | Servicio externo | `https://gasless.gokite.ai` -- verificado activo |

---

## DoR (Definition of Ready)

| Check | Status |
|-------|--------|
| AC definidos en EARS | OK |
| Tokens verificados en vivo | OK |
| Tipos existentes revisados | OK |
| Dependencias identificadas | OK |
| Branch definido | OK |
| Env vars documentadas | OK |
| Patron EIP-712 existente entendido | OK |
| Documentacion Kite gasless leida | OK |
| Missing inputs criticos resueltos | OK |

---

## Waves (implementacion sugerida)

### Wave 0 -- Tipos + env vars
- Tipos en `src/types/index.ts`: `GaslessTransferRequest`, `GaslessTransferResponse`, `GaslessSupportedToken`
- `.env.example`: agregar `GASLESS_ENABLED=false`, `OPERATOR_PRIVATE_KEY=`

### Wave 1 -- Gasless signer core (AC-1, AC-2, AC-3, AC-4)
- Crear `src/lib/gasless-signer.ts`:
  - Lazy singleton WalletClient (patron x402-signer.ts)
  - `getSupportedToken()` -- query `https://gasless.gokite.ai/supported_tokens`, extraer testnet, cache en memoria, fallback hardcoded a PYUSD testnet
  - `signTransferWithAuthorization(to, value)` -- firma EIP-712 con domain del token descubierto
  - `submitGaslessTransfer(payload)` -- POST a `https://gasless.gokite.ai/testnet`
  - `getGaslessStatus()` -- retorna estado del modulo
- Tests unitarios con mocks de fetch, signTypedData, getBlock

### Wave 2 -- Route + registration (AC-5, AC-6, AC-7)
- `src/routes/gasless.ts` -- `GET /gasless/status`
- Registrar en `src/index.ts` condicional a `GASLESS_ENABLED`
- Error handling: try/catch, nunca crash

---

## Decisiones tecnicas

| # | Decision | Justificacion |
|---|----------|---------------|
| DT-1 | EIP-3009 relayer en vez de gokite-aa-sdk | Evita ethers.js; reutiliza patron EIP-712; alineado con stablecoin transfers |
| DT-2 | Modulo `gasless-signer.ts` separado de `x402-signer.ts` | Responsabilidades distintas: x402 firma authorizations, gasless firma TransferWithAuthorization |
| DT-3 | Feature flag `GASLESS_ENABLED` default `false` | No debe romper funcionalidad existente. Opt-in |
| DT-4 | `validAfter` = `block.timestamp - 1` | EIP-3009: transfer valido cuando `block.timestamp >= validAfter`. Restar 1s garantiza validez en el proximo bloque |
| DT-5 | Decomposicion v/r/s con `hexToSignature()` de viem | Nativo de viem, sin deps extra |
| DT-6 | Cache de `/supported_tokens` en memoria | Evita query en cada transfer. TTL: duracion del proceso |
| DT-7 | Testnet only en esta iteracion | Mainnet requiere `kiteMainnet` chain definition + PublicClient dinamico + chainId dinamico (chain 2366). Documentado en Jira backlog post-hackathon |
| DT-8 | Paths gasless y x402 independientes | En testnet usan tokens diferentes (PYUSD vs Test USDT). Convergencia es iteracion futura cuando ambos paths converjan en un mismo token |

---

## Constraint Directives

| # | Constraint |
|---|-----------|
| CD-1 | **NUNCA logear** `OPERATOR_PRIVATE_KEY`, signatures, ni payloads sensibles. Solo logear txHash. |
| CD-2 | Gasless signer en `src/lib/gasless-signer.ts` -- **NO mezclar** con `x402-signer.ts` |
| CD-3 | TypeScript strict, sin `any` |
| CD-4 | Feature flag `GASLESS_ENABLED` -- default `false`, opt-in |
| CD-5 | Gasless y x402 son paths independientes. No modificar x402 middleware |
| CD-6 | `validBefore` = `validAfter + 25s` (dentro del limite de 30s del relayer) |
| CD-7 | No agregar `ethers.js` como dependencia |
| CD-8 | Endpoint hardcoded a testnet (`https://gasless.gokite.ai/testnet`). Mainnet queda fuera de scope (ver Jira backlog) |
| CD-9 | Validar que `value >= minimum_transfer_amount` (0.01 PYUSD = 10000000000000000 wei con 18 decimals) antes de firmar |

---

## EIP-712 Schema para firma gasless (EIP-3009 TransferWithAuthorization)

```typescript
// Domain -- se obtiene de /supported_tokens (testnet only en esta iteracion)
// Testnet: { name: "PYUSD", version: "1", chainId: 2368, verifyingContract: "0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9" }
const domain = {
  name: token.eip712_name,           // "PYUSD"
  version: String(token.eip712_version), // "1"
  chainId: 2368,                     // Kite Testnet (hardcoded en esta iteracion)
  verifyingContract: token.address as `0x${string}`,
} as const

// Types -- EIP-3009 TransferWithAuthorization
const types = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const
```

### Request payload al relayer

```typescript
interface GaslessTransferRequest {
  from: string        // Operator wallet address
  to: string          // Recipient address
  value: string       // Amount in smallest unit (18 decimals PYUSD)
  validAfter: string  // Unix timestamp (block.timestamp - 1)
  validBefore: string // Unix timestamp (validAfter + 25s)
  tokenAddress: string // From /supported_tokens
  nonce: string       // 0x + 32 random bytes hex
  v: number           // Signature component
  r: string           // Signature component
  s: string           // Signature component
}
```

### Response del relayer

```typescript
interface GaslessTransferResponse {
  txHash: string  // Transaction hash on Kite chain
}
```

---

## Archivos a crear/modificar

| Archivo | Accion | Descripcion |
|---------|--------|-------------|
| `src/lib/gasless-signer.ts` | CREAR | Core: EIP-3009 firma + submit + token discovery |
| `src/lib/gasless-signer.test.ts` | CREAR | Tests unitarios (mocks de fetch + signTypedData + getBlock) |
| `src/types/index.ts` | MODIFICAR | Agregar tipos gasless |
| `src/routes/gasless.ts` | CREAR | Ruta GET /gasless/status |
| `src/index.ts` | MODIFICAR | Registrar ruta gasless (condicional) |
| `.env.example` | MODIFICAR | Agregar GASLESS_ENABLED, OPERATOR_PRIVATE_KEY |

---

## Referencias

- [Kite Stablecoin Gasless Transfer](https://docs.gokite.ai/kite-chain/stablecoin-gasless-transfer)
- [Kite Gasless Integration docs](https://docs.gokite.ai/kite-chain/9-gasless-integration)
- [TypeScript EIP-3009 gist (ethers.js)](https://gist.github.com/thor-wong/2438c0e3970e22c75f4302ac2d75ac1b) -- adaptar a viem
- [Kite Smart Contracts List](https://docs.gokite.ai/kite-chain/3-developing/smart-contracts-list)
- SDD-008 (x402 Compose) -- patron de referencia para EIP-712 signing
- `/supported_tokens` response verificada en vivo: 2026-04-05
- **Jira backlog post-hackathon**: [WKH-33](https://ferrosasfp.atlassian.net/browse/WKH-33) -- "Gasless mainnet support (USDC.e on Kite Mainnet)" -- agregar `kiteMainnet` chain definition (chain 2366), refactor PublicClient/WalletClient para ser network-aware, y switch dinamico de chainId en EIP-712 domain

---

*Generado: 2026-04-05 | Analyst+Architect F0+F1 | SDD-018 v3 (post-AR v2)*
*Correcciones v3: Option B aprobada -- testnet only (PYUSD). Mainnet (USDC.e, chain 2366) movido a Jira backlog post-hackathon. Removidos: GASLESS_NETWORK env var, environment-aware design, dynamic chainId. Agregado CD-9 (validacion minimum_transfer).*
