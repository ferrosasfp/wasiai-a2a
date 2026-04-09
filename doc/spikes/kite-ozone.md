# SPIKE WKH-19 — Kite Ozone Testnet: Technical Research

**Fecha:** 2026-04-01  
**Autor:** Architect (subagent NexusAgile)  
**Bloquea:** WKH-5 (Kite client con viem)  
**Estado:** COMPLETO — Dev puede arrancar con caveats

---

> ⚠️ **DEPRECATED SECTIONS (updated 2026-04-09 — WKH-36)**
>
> Some contracts and flows referenced in this spike have been deprecated by the Kite team. For the current source of truth, see **`doc/kite-contracts.md`**.
>
> Specifically deprecated:
> - `GokiteAccountFactory` at `0xF0Fc19F0dc393867F19351d25EDfc5E099561cb7` — deprecated, no longer the official factory for Gokite Smart Wallets (confirmed by Kite team in Discord 2026-04-09).
> - `ViaLabs` / `MessageClient.sol` — previous mainnet bridging implementation has been replaced by **Lucid + LayerZero**. The old `bridgeTokens(address asset, uint256 amount, string destination)` signature is no longer active.
> - The `AccountFactory` section below (§4.1 Gokite Contracts table) reflects pre-deprecation state.
>
> This spike is retained **for historical context only**. Do not use the deprecated addresses in any new code or adapter. Consult `doc/kite-contracts.md` before implementing.

---

## 1. Información de Red (Testnet)

> ⚠️ **NOTA IMPORTANTE sobre "Ozone Testnet":**  
> Los docs oficiales de Kite NO usan el nombre "Ozone". El testnet se llama **KiteAI Testnet** o **Kite L1 Testnet**.  
> "Ozone" aparece en referencias de comunidad/social media como nombre de fase/campaña del testnet, pero técnicamente es el mismo chain.

| Parámetro         | Valor                                    |
|-------------------|------------------------------------------|
| **Chain Name**    | KiteAI Testnet                           |
| **RPC URL**       | `https://rpc-testnet.gokite.ai/`         |
| **Chain ID**      | `2368`                                   |
| **Token Symbol**  | `KITE`                                   |
| **Decimals**      | `18` (EVM estándar, confirmado por uso de wei en contratos) |
| **Block Explorer**| `https://testnet.kitescan.ai/`           |
| **ChainList**     | `https://chainlist.org/chain/2368`       |
| **Faucet**        | `https://faucet.gokite.ai`               |

---

## 2. Faucet — Cómo Obtener Tokens de Test

1. Ir a `https://faucet.gokite.ai`
2. Conectar wallet EVM
3. Solicitar tokens KITE para gas
4. Para tokens de pago (Test USDT/USDC), usar el portal: `https://x402-portal-eight.vercel.app/`

**Token de pago en testnet (stablecoin):**  
- Nombre: Test USD / Test USDT  
- Address: `0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63`  
- Explorer: `https://testnet.kitescan.ai/token/0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63`

---

## 3. Block Explorer

- **URL:** `https://testnet.kitescan.ai/`  
- **Tecnología:** Blockscout (open-source)  
- **Health endpoint:** `https://testnet.kitescan.ai/stats-service/health`

---

## 4. Contratos Desplegados en Testnet

### 4.1 Smart Wallet / Account Abstraction (ERC-4337)

| Contrato               | Address                                      |
|------------------------|----------------------------------------------|
| `GokiteAccount.sol`    | `0x93F5310eFd0f09db0666CA5146E63CA6Cdc6FC21` |
| `GokiteAccountFactory.sol` | `0xF0Fc19F0dc393867F19351d25EDfc5E099561cb7` |

### 4.2 Kite App Store / Service Registry

| Contrato          | Address                                      |
|-------------------|----------------------------------------------|
| `ServiceRegistry` | `0xc67a4AbcD8853221F241a041ACb1117b38DA587F` |

### 4.3 x402 / Payment

| Parámetro                         | Valor                                        |
|-----------------------------------|----------------------------------------------|
| **Payment Token (Test USDT)**     | `0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63` |
| **Facilitator Address (Testnet)** | `0x12343e649e6b2b2b77649DFAb88f103c02F3C78b` |
| **Facilitator Service**           | `https://facilitator.pieverse.io`            |
| **Scheme ID**                     | `gokite-aa`                                  |
| **Network ID (en 402 response)**  | `kite-testnet`                               |

### 4.4 Agent Passport

**Aclaración:** El "Agent Passport" es **off-chain/backend**, gestionado vía:
- **Portal:** `https://x402-portal-eight.vercel.app/`
- **MCP Server URL:** `https://neo.dev.gokite.ai/v1/mcp`
- **API Base (en desarrollo):** no pública aún

No hay un contrato de "Agent Passport" con address publicada en los docs. El sistema usa los contratos AA (GokiteAccount) como capa de ejecución on-chain, con identidad gestionada off-chain.

---

## 5. x402 Protocol — Arquitectura Relevante para WKH-5

El flujo de pagos x402 en Kite usa:

1. Service retorna HTTP 402 con payload JSON:
```json
{
  "scheme": "gokite-aa",
  "network": "kite-testnet",
  "maxAmountRequired": "1000000000000000000",
  "asset": "0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63",
  "payTo": "0x<service-wallet>",
  "maxTimeoutSeconds": 300
}
```

2. Agent obtiene `X-Payment` header via MCP tools (`approve_payment`)
3. Agent reintenta con `X-Payment` header
4. Service verifica y llama `POST /v2/settle` en facilitador
5. Facilitador ejecuta `transferWithAuthorization` on-chain

**Método on-chain:** `transferWithAuthorization` (ERC-3009 compatible)  
**Receptor del settle:** wallet configurado en `payTo`

---

## 6. viem Chain Definition

```typescript
import { defineChain } from 'viem'

export const kiteTestnet = defineChain({
  id: 2368,
  name: 'KiteAI Testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'KITE',
    symbol: 'KITE',
  },
  rpcUrls: {
    default: {
      http: ['https://rpc-testnet.gokite.ai/'],
    },
    public: {
      http: ['https://rpc-testnet.gokite.ai/'],
    },
  },
  blockExplorers: {
    default: {
      name: 'KiteScan',
      url: 'https://testnet.kitescan.ai',
    },
  },
  testnet: true,
})
```

> **viem chain oficial:** No existe en el registro oficial de viem/chains. Hay que usar `defineChain` manualmente como arriba.

---

## 7. ABIs

### 7.1 ABIs Publicados

Los docs NO publican ABIs inline. Las fuentes son:

1. **Blockscout Explorer** (ABIs verificados on-chain):
   - GokiteAccount: `https://testnet.kitescan.ai/address/0x93F5310eFd0f09db0666CA5146E63CA6Cdc6FC21`
   - GokiteAccountFactory: `https://testnet.kitescan.ai/address/0xF0Fc19F0dc393867F19351d25EDfc5E099561cb7`
   - ServiceRegistry: `https://testnet.kitescan.ai/address/0xc67a4AbcD8853221F241a041ACb1117b38DA587F`
   - Payment Token: `https://testnet.kitescan.ai/token/0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63`

2. **GitHub referencia x402:**
   - `https://github.com/gokite-ai/x402` — demo facilitators con implementación de referencia

3. **ABI mínimo del token de pago** (ERC-20 + ERC-3009 para `transferWithAuthorization`):
```typescript
// ABI mínimo para interactuar con el payment token
export const paymentTokenAbi = [
  // ERC-20 standard
  {
    "name": "balanceOf",
    "type": "function",
    "stateMutability": "view",
    "inputs": [{"name": "account", "type": "address"}],
    "outputs": [{"name": "", "type": "uint256"}]
  },
  {
    "name": "allowance",
    "type": "function",
    "stateMutability": "view",
    "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}],
    "outputs": [{"name": "", "type": "uint256"}]
  },
  {
    "name": "transfer",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [{"name": "to", "type": "address"}, {"name": "amount", "type": "uint256"}],
    "outputs": [{"name": "", "type": "bool"}]
  },
  // ERC-3009 transferWithAuthorization (usado por x402 facilitator)
  {
    "name": "transferWithAuthorization",
    "type": "function",
    "stateMutability": "nonpayable",
    "inputs": [
      {"name": "from", "type": "address"},
      {"name": "to", "type": "address"},
      {"name": "value", "type": "uint256"},
      {"name": "validAfter", "type": "uint256"},
      {"name": "validBefore", "type": "uint256"},
      {"name": "nonce", "type": "bytes32"},
      {"name": "v", "type": "uint8"},
      {"name": "r", "type": "bytes32"},
      {"name": "s", "type": "bytes32"}
    ],
    "outputs": []
  }
] as const
```

> ⚠️ El ABI de `transferWithAuthorization` es una estimación basada en el estándar ERC-3009. **Verificar el ABI real en el explorer antes de usar en producción.**

---

## 8. Unknowns Pendientes

| # | Unknown | Impacto | Cómo resolver |
|---|---------|---------|---------------|
| 1 | ABI completo de `GokiteAccount.sol` | ALTO para Mode 3 (SDK) | Verificar en `testnet.kitescan.ai` o esperar SDK oficial |
| 2 | ABI completo del payment token ERC-3009 | MEDIO | Verificar en explorer (puede estar ya verificado) |
| 3 | Endpoint oficial del `x402` repo (está en 404 en github) | MEDIO | El repo `gokite-ai/x402` no cargó — verificar directamente |
| 4 | RPC URL de backup / alternativa | BAJO | Solo hay un RPC público documentado |
| 5 | "Ozone" vs "Testnet" — ¿son el mismo chain? | RESUELTO | Sí, "Ozone" es nombre de campaña, Chain ID 2368 es el testnet |
| 6 | SDK/API para Mode 2 y Mode 3 | INFO | En desarrollo, "coming soon" — usar MCP/Mode 1 por ahora |
| 7 | Agent Passport contract address | INFO | No hay contrato directo; la identidad es off-chain via portal |
| 8 | WebSocket RPC URL | BAJO | No documentada; usar HTTP polling |

---

## 9. Resumen de Addresses y URLs

```
# Network
RPC:           https://rpc-testnet.gokite.ai/
Chain ID:      2368
Explorer:      https://testnet.kitescan.ai/
Faucet:        https://faucet.gokite.ai/
Portal:        https://x402-portal-eight.vercel.app/
MCP Server:    https://neo.dev.gokite.ai/v1/mcp

# Contracts (Testnet)
GokiteAccount:        0x93F5310eFd0f09db0666CA5146E63CA6Cdc6FC21
GokiteAccountFactory: 0xF0Fc19F0dc393867F19351d25EDfc5E099561cb7
ServiceRegistry:      0xc67a4AbcD8853221F241a041ACb1117b38DA587F
Payment Token (USDT): 0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63
Facilitator:          0x12343e649e6b2b2b77649DFAb88f103c02F3C78b

# Facilitator API
https://facilitator.pieverse.io/v2/verify
https://facilitator.pieverse.io/v2/settle
```

---

## 10. Conclusión — ¿Puede arrancar WKH-5?

### ✅ SÍ, el Dev puede arrancar WKH-5 con la info actual.

**Lo que está listo:**
- Chain ID, RPC URL, Explorer, Faucet — **100% confirmados** de docs oficiales
- viem chain definition — **lista para copiar**, no hay definición oficial pero `defineChain` es suficiente
- Token de pago (Test USDT) y su address — **confirmados** del Service Provider Guide
- Facilitador x402 (Pieverse) con endpoints — **confirmados**
- Esquema de pago (`gokite-aa`, `kite-testnet`) — **confirmado** del ejemplo real de 402 response

**Lo que hay que resolver durante WKH-5:**
1. Obtener ABIs completos del explorer (Blockscout los expone, es una llamada de ~5 min)
2. Verificar que el ABI de `transferWithAuthorization` coincide con el token desplegado
3. Revisar el repo `gokite-ai/x402` para el facilitator reference implementation

**No hay blockers críticos.** Los únicos unknowns son ABIs (obtenibles en minutos desde el explorer) y el SDK avanzado (que se necesitaría para Mode 3, no para el MVP del hackathon).

---

## Agent Passport — Investigación Profunda

> **Fecha investigación:** 2026-04-01  
> **Investigador:** Architect (subagent NexusAgile — spike profundo)  
> **Contexto:** El spike previo concluyó "Agent Passport no tiene contrato propio". Esta sección profundiza con evidencia completa de todas las fuentes disponibles.

---

### AP.1 ¿Qué es exactamente el Agent Passport en Kite?

El "Kite Agent Passport" (o "Kite Passport") es **una capa de infraestructura de identidad + pago delegado**, **no un NFT ni un smart contract independiente**.

**Definición oficial** (fuente: `https://docs.gokite.ai/kite-agent-passport/kite-agent-passport`):
> "Kite Agent Passport is the infrastructure layer that enables autonomous AI agents to make secure, delegated payments on behalf of users. It solves the fundamental problem of how AI agents can transact value in a safe, controlled, and user-approved manner—combining identity, authentication, delegation, and on-chain payment processing in one system."

**No es ERC-721 ni ERC-8004.** Es un sistema de tres capas:

| Capa | Componente | Tecnología |
|------|-----------|-----------|
| **Passport** | Identity, auth, delegation | Off-chain (API + portal). User/Agent IDs, Sessions, Delegations |
| **Payment** | On-chain value transfer | ERC-3009 `transferWithAuthorization` vía x402 protocol |
| **MCP Tool** | Agent integration | Model Context Protocol server en `https://neo.dev.gokite.ai/v1/mcp` |

**En el conceptual (Core Concepts docs):** "Kite Passport" aparece como:
> "Cryptographic identity card that creates complete trust chain from user to agent to action. Binds to existing identities (Gmail, Twitter) via cryptographic proofs. Contains capabilities: spending limits, service access. Enables selective disclosure."

Sin embargo, en la implementación real del testnet, el "Passport" es **gestionado off-chain** a través del portal y APIs, usando los contratos AA (GokiteAccount ERC-4337) como capa de ejecución on-chain.

---

### AP.2 ¿Existe un contrato Agent Passport en Kite testnet?

**Respuesta corta: NO hay un contrato dedicado "Agent Passport" con address publicada.**

Evidencia de ausencia:
1. La lista oficial de contratos (`https://docs.gokite.ai/kite-chain/3-developing/smart-contracts-list`) lista **solo 4 contratos**: GokiteAccount, GokiteAccountFactory, ServiceRegistry, y los contratos bridge — ninguno se llama "Passport".
2. Búsquedas en docs.gokite.ai con "passport", "ERC-8004" no arrojan páginas de contrato con address.
3. El GitHub de gokite-ai (`https://github.com/gokite-ai`) no tiene repos públicos con código de un contrato Passport.

**Qué hace las veces de "Passport" on-chain:**
- La **identidad del agente** (Agent ID, User ID) es gestionada off-chain por el backend de Kite.
- Las **Sessions** (autorizaciones de gasto) pueden tener registro on-chain vía `GokiteAccount.sol` (ERC-4337 AA wallet), pero no como un NFT.
- El **pago real** usa `transferWithAuthorization` (ERC-3009) sobre el token `0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63`.

**ERC-8004 — ¿Relevante?**
No hay ninguna mención de ERC-8004 en la documentación oficial de Kite ni en su GitHub. El estándar conceptual mencionado en la arquitectura de Kite está construido sobre DID (Decentralized Identifiers) y BIP-32, no sobre una ERC específica de NFT de identidad.

---

### AP.3 ¿Cómo se crea/mintea un Agent Passport?

**Método actual (Mode 1 — único modo funcional en testnet):**

El flujo es completamente off-chain/portal-driven:

1. **Portal (invitation only):** `https://x402-portal-eight.vercel.app/`
   - Usuario se registra con email (Privy AA wallet)
   - Sistema crea automáticamente una AA wallet (GokiteAccount)
   - Usuario crea un "Agent" en la UI del portal
   - Portal asigna un **Agent ID** (identificador único, gestionado off-chain)
   
2. **MCP Server:** `https://neo.dev.gokite.ai/v1/mcp`
   - Una vez que el Agent ID está creado, se usa el MCP server
   - El agente (Claude Desktop, Cursor, etc.) se conecta vía OAuth
   - Se crean "Sessions" (presupuestos de gasto con límites de tiempo y monto)

**No hay función `mint()` ni `createPassport()` expuesta on-chain.** La "creación" es un registro en el backend de Kite que se vincula a la wallet AA del usuario.

**⚠️ Limitación crítica:** Actualmente **solo por invitación**. No hay registro abierto en testnet.

---

### AP.4 ¿Hay ABI disponible para el Passport?

**No existe un ABI de "Agent Passport"** porque no es un smart contract independiente.

Los ABIs relevantes que sí existen:

| Contrato | Dónde obtener ABI |
|----------|-------------------|
| `GokiteAccount.sol` (AA wallet, ERC-4337) | `https://testnet.kitescan.ai/address/0x93F5310eFd0f09db0666CA5146E63CA6Cdc6FC21` |
| `GokiteAccountFactory.sol` | `https://testnet.kitescan.ai/address/0xF0Fc19F0dc393867F19351d25EDfc5E099561cb7` |
| Payment Token (ERC-20 + ERC-3009) | `https://testnet.kitescan.ai/token/0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63` |
| `ServiceRegistry` | `https://testnet.kitescan.ai/address/0xc67a4AbcD8853221F241a041ACb1117b38DA587F` |

Para la **integración del Passport vía MCP**, los únicos "métodos" expuestos son 2 MCP tools:

```typescript
// MCP Tool 1: get_payer_addr
// Input: none
// Output: { payer_addr: string }  // AA wallet address del usuario

// MCP Tool 2: approve_payment
// Input:
{
  payer_addr: string,    // AA wallet del usuario
  payee_addr: string,    // wallet del servicio
  amount: string,        // en token units
  token_type: string,    // e.g. "USDC"
  merchant_name?: string
}
// Output: signed X-Payment payload para header HTTP
```

---

### AP.5 ¿Qué datos almacena el Passport?

Basado en los docs, el Passport gestiona:

**Off-chain (backend/portal):**
- **User ID** — identidad del humano dueño de los fondos
- **Agent ID** — identidad del AI agent (por cada agente creado en el portal)
- **Service ID** — identidades de proveedores de servicio
- **Agent-Level Spending Policy** — límites máximos por mes, por transacción, merchants permitidos
- **Sessions** — presupuestos master: tiempo límite, gasto total máximo, merchants
- **Delegations** — pagos específicos autorizados, vinculados a una Session

**On-chain (GokiteAccount / ERC-4337):**
- `addSessionKeyRule(sessionKeyAddress, agentId, functionSelector, valueLimit)` — reglas de session keys
- Historial de transacciones en el explorer de Kite
- Balances del token de pago (Test USDT)

**Conceptualmente (documentado pero no en contrato visible):**
- DID del agente: `did:kite:alice.eth/chatgpt/portfolio-manager-v1`
- Standing Intent (SI): autorización firmada del usuario al agente
- Delegation Token (DT): autorización del agente a la session key
- Verifiable Credentials (VCs): attestations de compliance, reputación

---

### AP.6 ¿Está relacionado con GokiteAccount (Account Abstraction)?

**Sí, directamente.** La relación es:

```
User (EOA wallet) 
  └─ crea/controla ──► GokiteAccount (AA wallet, ERC-4337)
                            └─ es la "Kite Passport wallet" del usuario
                            └─ ejecuta pagos con session keys
                            └─ addSessionKeyRule(agentId, limits...)
                            
Agent ID (off-chain)
  └─ vinculado a ──► GokiteAccount del usuario
  └─ opera con ──── session keys efímeras
  └─ firma con ──── Standing Intent + Delegation Token
```

La wallet AA (`GokiteAccount`) **es** la parte on-chain del Passport. El Agent ID es el identificador off-chain que mapea al agente contra esa wallet.

---

### AP.7 Modos de Desarrollo — Estado actual

| Modo | Nombre | Estado | Descripción |
|------|--------|--------|-------------|
| **Mode 1** | Client Agent with MCP | ✅ **FUNCIONAL** | El dev construye un AI client que soporta MCP. Users registran su propio Passport y configuran MCP. **Este es el único modo funcional hoy.** |
| **Mode 2** | Developer as End User | 🚧 Coming Soon | El dev tiene su propio Passport y paga por los customers (billing propio). Via SDK/API en desarrollo. |
| **Mode 3** | Deep Platform Integration | 🚧 Coming Soon | El dev gestiona todo el ciclo via API: crear agentes, sessions, registro on-chain. REST API + Blockchain SDK en desarrollo. |

**Alternativa funcional hoy (sin invitación):**

Si no hay invitación al portal, la alternativa es implementar el flujo x402 directamente:

1. Crear una wallet en Kite testnet
2. Obtener Test USDT del faucet
3. Usar el facilitator de Pieverse (`https://facilitator.pieverse.io`) directamente
4. Implementar el protocolo x402 (`gokite-aa` scheme) sin pasar por el portal

Esto bypasea el "Passport" oficial pero permite probar el flujo de pagos on-chain. El "Passport" en este caso sería manual: el dev maneja su propia wallet AA y session keys.

---

### AP.8 Recursos de implementación disponibles

| Recurso | URL | Estado |
|---------|-----|--------|
| Portal (invitation-only) | `https://x402-portal-eight.vercel.app/` | ✅ Activo |
| MCP Server | `https://neo.dev.gokite.ai/v1/mcp` | ✅ Activo |
| x402 Demo Service (weather) | `https://x402.dev.gokite.ai/api/weather` | ✅ Activo |
| Facilitator (Pieverse) | `https://facilitator.pieverse.io` | ✅ Activo |
| x402 reference impl | `https://github.com/gokite-ai/x402` | ⚠️ Repo existe, no verificado acceso |
| Faucet | `https://faucet.gokite.ai/` | ✅ Activo |
| Explorer | `https://testnet.kitescan.ai/` | ✅ Activo |

---

### AP.9 Conclusión Final: ¿Podemos implementar Agent Passport hoy en testnet?

#### ✅ Sí, pero con limitaciones importantes.

**Lo que SÍ podemos hacer hoy:**

1. **Flujo x402 completo (sin Passport formal):**
   - Crear wallet en Kite testnet
   - Obtener Test USDT via faucet
   - Implementar el protocolo x402 con scheme `gokite-aa`
   - Usar el facilitador Pieverse para settle on-chain
   - **Esto es suficiente para el hackathon** como service provider o consumer directo

2. **Integración MCP (si tenemos invitación al portal):**
   - Registrar agente en `https://x402-portal-eight.vercel.app/`
   - Conectar via MCP server `https://neo.dev.gokite.ai/v1/mcp`
   - Usar tools `get_payer_addr` y `approve_payment`
   - **Requiere invitación** — contactar al equipo de Kite

**Lo que NO podemos hacer hoy:**
- Mintear/crear Passports programáticamente (Modes 2 y 3 son "coming soon")
- Acceder a un contrato "Agent Passport" on-chain (no existe)
- Usar ERC-8004 (no está implementado)

**Recomendación para WasiAI Hackathon:**

```
Estrategia: Implementar como SERVICE PROVIDER (más simple)
1. Desplegar nuestro servicio con soporte x402
2. Retornar HTTP 402 con scheme "gokite-aa"
3. Verificar y settle via Pieverse facilitator
4. El "Passport" lo manejan los usuarios con sus propias cuentas del portal

Alternativa si queremos ser CONSUMER:
1. Solicitar invitación al portal de Kite ASAP
2. Crear cuenta + Agent ID manualmente
3. Configurar MCP server en nuestro agente
4. Usar los MCP tools para pagar servicios x402
```

**El concepto "Agent Passport" como NFT/contrato on-chain independiente NO existe en la implementación actual.** Es un sistema de gestión de identidad y pagos delegados, mayormente off-chain, que usa `GokiteAccount` (ERC-4337) como capa de ejecución on-chain.

---

## Referencias

- Docs red: `https://docs.gokite.ai/kite-chain/1-getting-started/network-information`
- Contratos: `https://docs.gokite.ai/kite-chain/3-developing/smart-contracts-list`
- Developer Guide: `https://docs.gokite.ai/kite-agent-passport/developer-guide`
- Service Provider Guide: `https://docs.gokite.ai/kite-agent-passport/service-provider-guide`
- Testnet Notice: `https://docs.gokite.ai/kite-agent-passport/testnet-notice`
- **Agent Passport Intro:** `https://docs.gokite.ai/kite-agent-passport/kite-agent-passport`
- **End User Guide:** `https://docs.gokite.ai/kite-agent-passport/end-user-guide`
- **Core Concepts (Kite Passport concept):** `https://docs.gokite.ai/get-started-why-kite/core-concepts-and-terminology`
- **Architecture Pillars (Programmable Trust Layer):** `https://docs.gokite.ai/get-started-why-kite/architecture-and-design-pillars`
- GitHub org: `https://github.com/gokite-ai`
- x402 repo: `https://github.com/gokite-ai/x402`

- Docs red: `https://docs.gokite.ai/kite-chain/1-getting-started/network-information`
- Contratos: `https://docs.gokite.ai/kite-chain/3-developing/smart-contracts-list`
- Developer Guide: `https://docs.gokite.ai/kite-agent-passport/developer-guide`
- Service Provider Guide: `https://docs.gokite.ai/kite-agent-passport/service-provider-guide`
- Testnet Notice: `https://docs.gokite.ai/kite-agent-passport/testnet-notice`
- GitHub org: `https://github.com/gokite-ai`
- x402 repo: `https://github.com/gokite-ai/x402`
