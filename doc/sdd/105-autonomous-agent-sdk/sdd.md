# SDD — [WKH-105] Autonomía agéntica: SDK + agente de referencia (TypeScript)

> Estado: **DRAFT → para SPEC_APPROVED**
> Modo: QUALITY (full SDD)
> Input: `doc/sdd/105-autonomous-agent-sdk/work-item.md` (11 ACs) + 3 decisiones del humano (NC-1/NC-2/NC-3, bakeadas abajo como DT/CD)
> Server **read-only** (CD-4): WKH-105 es 100% client-side. NO se toca `src/`.

---

## 0. Decisiones del humano (bakeadas — fuente de verdad)

| NC | Decisión del humano | Dónde se baka | Estado |
|----|---------------------|---------------|--------|
| NC-1 | SDK en `packages/agent-sdk/`. Agente de referencia en `examples/autonomous-agent.ts` que importa el SDK. | DT-1, DT-9, CD-6 | Resuelve **[NEEDS CLARIFICATION-1]** del work-item (MI-1) |
| NC-2 | El agente **MINTEA su propia identidad ERC-8004 REAL** con su wallet. ABI confirmado del repo oficial (ver §3). AgentCard = `data:` URI base64 auto-contenido. Mint **gateado por env** (gas en Base) pero capacidad REAL, no stub. | DT-4, DT-5, DT-6, CD-7 | Resuelve **[VERIFY-AT-IMPL]** (DT-4 work-item, MI-2) y **[NEEDS CLARIFICATION-2]** (MI-3, → gated) |
| NC-3 | El agente opera contra el **primer agente descubrible** (`/discover` dinámico), sin slug fijo. | DT-7, DT-10 | Resuelve **[NEEDS CLARIFICATION-3]** (MI-4, → first-from-discover) |

**Resultado:** los 3 `[NEEDS CLARIFICATION]` del work-item quedan resueltos. NO quedan TBDs abiertos (ver Readiness Check §11).

---

## 1. Context Map (archivo:línea — leído y verificado)

| Artefacto | Qué extraje | Para qué |
|-----------|-------------|----------|
| `examples/fund-agent-key.mjs:30-100` | **Patrón canónico provision** end-to-end: `privateKeyToAccount(normPk(pk))` (`:71`), `createWalletClient`/`createPublicClient` con `http(rpc)` (`:72-73`), `GET /auth/deposit-info` → `networks[].{treasury,token:{symbol,address,decimals},chain_id,min_confirmations}` (`:61-65`), `POST /auth/agent-signup {owner_ref,display_name}` → `{key,key_id}` (`:77`), `account.signMessage({message: WASIAI_BIND_FUNDING_WALLET:${key_id}})` (`:81`), `POST /auth/funding-wallet {wallet,signature}` con header `x-a2a-key` (`:82`), `parseUnits(AMOUNT, token.decimals)` (`:86`), ERC-20 `writeContract({abi:ERC20,functionName:'transfer',args:[treasury,amount]})` (`:87`), `waitForTransactionReceipt({hash, confirmations: min_confirmations})` (`:90`), `POST /auth/deposit {key_id,tx_hash,chain_id}` → `{balance,chain_id}` (`:94`), `GET /auth/me` → `{budget}` (`:98`). Helper `api(path,{method,key,body})` con header `x-a2a-key` (`:51-58`). | Exemplar EXACTO de `provision()` (AC-1/AC-2/AC-3), `client.ts`, `wallet.ts`. **El SDK reproduce este flujo, tipado y mockeable.** |
| `examples/delegation-demo.mjs:11-79` | **Patrón canónico delegate EIP-712**: `generatePrivateKey()` para session key efímera (`:21`), domain `{name:'WasiAI-a2a Delegation', version:'1', chainId}` SIN `verifyingContract` (`:51`), `types.Delegation`+`types.DelegationPolicy` (`:52-66`), **al firmar `expires_at`→`BigInt`, `allowed_chains`→`bigint[]`** (`:68-72`), `account.signTypedData({domain,types,primaryType:'Delegation',message})` (`:73`), `typed_data` con uint como **number** en el JSON al server (`:77`), `POST /auth/delegation {typed_data,signature,session_key_address,policy}` (`:78`), `DELETE /auth/delegation/:id` (`:90`). `CHAIN_ID` env = domain (debe == server). | Exemplar EXACTO de `delegate(policy)` (paso 5). **Crítico: el split bigint(firma) vs number(JSON) — ver auto-blindaje WKH-101 W1, §9.** |
| `src/adapters/erc8004-identity.ts:51-66` | ABI ERC-721 inline `as const`: `ownerOf(uint256)→address`, `tokenURI(uint256)→string`. `ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/` (`:70`). Chain ids Base: mainnet **8453**, sepolia **84532** (`:120-122`). `classifyReadError`: `ContractFunctionExecutionError` → revert; otro → transporte (`:130-133`). Result tipado, **NUNCA throw al handler**. | Patrón de ABI inline `as const` + manejo revert-vs-transporte para `identity.ts` (mint) y para tipar errores del SDK. Chain ids canónicos Base. |
| `src/routes/auth.ts:267-305` | `POST /agent-signup` exige `owner_ref` string no vacío → **201** `{key,key_id,...}`. | Shape real de signup (AC-1). |
| `src/routes/auth.ts:318-389` | `POST /funding-wallet` recupera firmante de `WASIAI_BIND_FUNDING_WALLET:<callerKey.id>` (key_id del **caller autenticado, no del body**) y exige match con `wallet` → **200** `{funding_wallet}`. 403 `FUNDING_WALLET_PROOF_INVALID`, 409 `FUNDING_WALLET_ALREADY_BOUND`. | Shape + códigos de error del bind (AC-1, AC-3). |
| `src/routes/auth.ts:398-419` | `POST /deposit` exige `{key_id:string, tx_hash:/^0x[0-9a-fA-F]{64}$/, chain_id:number}` → verify-before-credit → `{balance,chain_id}`. 400 `INVALID_INPUT`. | Shape del deposit (AC-2). |
| `src/routes/auth.ts:549-575` | `GET /deposit-info` (sin auth) → `{networks:[{chain_id,slug,family,treasury,token:{symbol,address,decimals},min_confirmations}]}`. `treasury` puede ser `null`. | Shape real de deposit-info (AC-2). El SDK debe tolerar `treasury===null`. |
| `src/routes/auth.ts:585-755` | `POST /erc8004/bind` — el **server READ-ONLY** verifica `ownerOf(token_id)==funding_wallet` antes de persistir; body `{token_id, agent_slug?, agent_registry?}` (slug+registry **JUNTOS o NINGUNO**, `:644`). → **200** `{erc8004_identity:{token_id,chain_id,agent_card_url,...}}`. Códigos: 404 `ERC8004_TOKEN_NOT_FOUND`, 403 `IDENTITY_OWNERSHIP_MISMATCH`, 409 `ERC8004_ALREADY_BOUND`/`ERC8004_TOKEN_ALREADY_BOUND`, 503 `RPC_UNAVAILABLE`/`REGISTRY_NOT_CONFIGURED`. | **El SDK MINTEA on-chain (el server NO mintea) y luego llama este bind con el `token_id` resultante** (AC-4). `agent_slug`+`agent_registry` opcionales → el SDK los omite (bind sin ancla, válido). |
| `src/routes/auth.ts:833-879` | `POST /auth/delegation` — el path interno del plugin es `/delegation` (registrado con prefix `/auth` en `src/index.ts`). | Confirmación de la URL pública `/auth/delegation` (auto-blindaje WKH-101 W2). |
| `src/routes/discover.ts:61-108` | `POST /discover` (alias de GET, WKH-031) body `{capabilities?, q?, maxPrice?, minReputation?, limit?, registry?, verified?, includeInactive?}` → `discoveryService.discover(...)`. | Shape del request de discover (AC-6, DT-6). |
| `src/services/discovery.ts:218-273` | `discover()` → `DiscoveryResult { agents: Agent[], total, registries }`. Default: solo `status==='active'`. | Shape de la respuesta de discover (AC-6). |
| `src/types/index.ts:118-150` | `Agent { id, name, slug, description, capabilities[], priceUsdc:number, registry, registry_id, invokeUrl, verified, status, computedReputation?, ... }`. | Tipo del agente para seleccionar el primero dentro de budget por `priceUsdc` (AC-6, DT-10). |
| `src/routes/compose.ts:100-185` | `POST /compose` body `{steps: ComposeStep[], maxBudget?}` (`:15-18`), preHandler `requirePaymentOrA2AKey` debita budget per-call. 400 `VALIDATION_ERROR`, 404 `AGENT_NOT_FOUND`, 503 `REGISTRY_UNAVAILABLE`, **403 `INSUFFICIENT_BUDGET`** (ver §2 DT-8). Respuesta `{kiteTxHash, ...result}`. `ComposeStep` (`src/types/index.ts:227-230`) = `{agent, registry?, ...}`. | Shape de compose + **el código real de budget agotado** (AC-6, AC-7). |
| `src/middleware/a2a-key.ts:70-76, 528-532` | `send403(reply, code, msg)` → **HTTP 403** `{error, error_code:'INSUFFICIENT_BUDGET'}` cuando se paga con `x-a2a-key` y el budget es insuficiente. El **402** real solo ocurre en el fallback x402 puro (`runX402Fallback`, `:104-211`, sin `x-a2a-key`). | **DRIFT vs AC-7 (que dice "402"): con agent key el server devuelve 403 `INSUFFICIENT_BUDGET`.** El SDK debe mapear AMBOS (402 y 403+code) → `InsufficientBudgetError`. Ver §2 DT-8 + §10 OBS-1. |
| `src/routes/agent-card.ts:30-136` | `GET /agents/:slug/agent-card` → A2A AgentCard JSON; incluye `computedReputation` (vía `reputationService`, graceful — omitido/`undefined` si no hay score, `:74-81`). 404 `Agent not found`. | Shape de reputación (AC-8). El SDK extrae `card.computedReputation ?? null`. |
| `package.json:1-50` | **NO hay `workspaces`**. `type:module`. `viem ^2.47.6` (dep). `vitest ^4.1.4`, `typescript ^5.4.0`, `@types/node ^20`, `biome` (devDeps). Scripts `test: vitest run`, `lint: biome check src/`, `build: tsc -p tsconfig.build.json`. | **Hallazgo decisivo de estructura (ver §1.1):** el repo NO es monorepo hoy. Define cómo encaja `packages/agent-sdk/` (DT-1, DT-9, DT-11). |
| `tsconfig.json` / `tsconfig.build.json` | `rootDir:./src`, `include:["src/**/*"]`, `module:Node16`, `moduleResolution:node16`, `strict:true`, `declaration:true`. El build del server compila **solo `src/`** (`tsconfig.build.json` excluye tests). | El tsconfig del server NO ve `packages/` → el SDK necesita su propio `tsconfig.json` (CD-6, DT-9). |
| `vitest.config.ts:4-11` | `include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'test/**/*.test.mjs']`. **NO incluye `packages/**`**. `env: {SUPABASE_URL, SUPABASE_SERVICE_KEY}` (irrelevante para el SDK). | **Hallazgo decisivo de tests:** `vitest run` raíz NO corre tests del SDK con la config actual. Define DT-11 (cómo cumplir CD-9). |
| `examples/*` (`fund-agent-key.mjs`, `delegation-demo.mjs`) | Carpeta `examples/` ya existe con scripts ejecutables `.mjs`. `examples/autonomous-agent.ts` vive acá. | Ubicación del agente de referencia (NC-1). |
| `https://github.com/erc-8004/erc-8004-contracts@main` `contracts/IdentityRegistryUpgradeable.sol:60-78` + `abis/IdentityRegistry.json` | **ABI de mint CONFIRMADO del repo oficial** (clonado y leído 2026-05-31). Ver §3. | Resuelve `[VERIFY-AT-IMPL]` (DT-4 work-item). NO se inventa nada. |
| `doc/sdd/_INDEX.md:89-93` | Últimas DONE: WKH-100/101/102/103/104. Todas con `auto-blindaje.md`. | Fuente del Auto-Blindaje histórico (§9). |

### 1.1 Hallazgo decisivo de estructura — el repo NO es monorepo (hoy)

`package.json` NO declara `workspaces`. El `tsconfig.build.json` compila solo `src/`. El `vitest.config.ts` raíz NO incluye `packages/**`. Por lo tanto `packages/agent-sdk/` debe ser un **sub-paquete TS independiente y auto-contenido** (DT-9):
- Su propio `package.json` (NO extiende) con `viem` como `peerDependency` (CD-6).
- Su propio `tsconfig.json` (NO extiende del server) con `rootDir:./src`, `outDir:./dist`, ESM `NodeNext`, `strict`.
- Su propio `vitest.config.ts` local → los tests del SDK se corren con `vitest run` **desde `packages/agent-sdk/`** (o `npm --prefix packages/agent-sdk test`).
- **Decisión de CD-9 (ver DT-11):** para que el build/test del server NO se rompa y los tests del SDK SÍ corran sin red, se hace correr el suite del SDK como paso separado. Se actualiza el `vitest.config.ts` raíz para **excluir `packages/**`** explícitamente (defensivo, hoy ya no los incluye) y se documenta el comando del SDK. Esto satisface CD-9 ("`vitest run` desde la raíz NO debe fallar por tests del SDK") sin acoplar.

> **Por qué NO monorepo workspaces ahora:** convertir el repo a npm workspaces es cambio de infra que toca el `package.json` raíz, el lockfile y el deploy (Railway) → fuera de scope (work-item Scope OUT: "Publish a npm / infra de publish"). El sub-paquete independiente es la mínima estructura que cumple NC-1 sin riesgo sobre el server productivo.

---

## 2. Decisiones Técnicas (DT)

### DT-1 — Ubicación: `packages/agent-sdk/` sub-paquete TS independiente (NC-1)
SDK en `packages/agent-sdk/`, ESM, `viem` como `peerDependency` (ya presente en el workspace), compilado con `tsc` (sin bundler — work-item DT-1). NO extiende tsconfig/package del server (CD-6). Agente de referencia en `examples/autonomous-agent.ts` que importa **desde el source del SDK** vía path relativo (`../packages/agent-sdk/src/index.js`) — ver DT-9.

### DT-2 — `WasiAgent` clase stateful, PK nunca serializada (work-item DT-2, CD-5)
`WasiAgent` recibe en el constructor un **viem `LocalAccount`** (el caller hace `privateKeyToAccount(...)`; el SDK NUNCA toca la raw PK ni la deriva de un string crudo en su API pública) + config. Guarda internamente `#account` (private field), `#key`, `#keyId` tras `provision()`. La PK/`account` **nunca** se serializa, loguea, ni se expone vía getter (CD-5). `toJSON()`/`toString()` se sobrescriben para redactar credenciales (defensa anti-leak, AC-10).

### DT-3 — Config 100% desde el caller/env, sin hardcodes (work-item DT-3, CD-1)
El constructor recibe `WasiAgentConfig { a2aBase: string, network: string, rpcUrl: string, chainId: number, identityRegistryAddress?: \`0x...\`, enableIdentityMint?: boolean, maxAgentBudgetUsd?: number, fetchImpl?, walletClient?, publicClient? }`. El agente de referencia (`examples/autonomous-agent.ts`) lee estos de **env vars** (DT-8 work-item): `A2A_BASE`, `NETWORK`, `RPC_URL`, `FUNDER_PK`, `AMOUNT`, `OWNER_REF`, `ENABLE_IDENTITY_MINT`, `ERC8004_REGISTRY_ADDRESS`, `MAX_AGENT_BUDGET_USD`. **PROHIBIDO** hardcodear treasury/token/chainId/registry/RPC: treasury+token salen de `GET /auth/deposit-info`; chainId del mismo; registry+RPC de env (CD-1).

### DT-4 — Mint ERC-8004 REAL gateado por env (NC-2, resuelve [VERIFY-AT-IMPL])
`mintIdentity()` hace un `writeContract` REAL al IdentityRegistry canónico usando la **firma confirmada del repo oficial** (§3): `register(string agentURI) → uint256 agentId`. El `agentId` se extrae del **receipt** parseando el log `Registered(uint256 indexed agentId, string agentURI, address indexed owner)` (o el `Transfer` ERC-721) — NUNCA por re-lectura de un contador global (no determinista bajo concurrencia). Luego `POST /auth/erc8004/bind {token_id}`.

**Gate (CD-7, AC-4/AC-5):** el mint SOLO se ejecuta si `enableIdentityMint===true` **Y** `identityRegistryAddress` está seteada (env `ENABLE_IDENTITY_MINT=true` + `ERC8004_REGISTRY_ADDRESS`). Sin ambas, `mintIdentity()` retorna `{ skipped: true, reason: 'IDENTITY_MINT_DISABLED' }` y el agente de referencia loguea `IDENTITY_SKIP: mint disabled (set ENABLE_IDENTITY_MINT=true + ERC8004_REGISTRY_ADDRESS)` y continúa (AC-5). El ABI **está confirmado** → ya NO aplica el sub-caso "ABI no confirmado" del work-item; el único gate operativo es env (gas en Base).

### DT-5 — AgentCard como `data:` URI base64 auto-contenido (NC-2, work-item DT-5)
El `agentURI` que se pasa a `register(string)` es un `data:application/json;base64,<base64>` construido in-SDK desde un AgentCard mínimo A2A-compatible `{ name, description, url }` (formato de project-context.md:108-127). Base64 vía `Buffer.from(JSON.stringify(card)).toString('base64')`. Sin hosting, sin fetch. El `url` apunta al gateway (`${a2aBase}/agents/<slug-o-address>`).

### DT-6 — `operate({goal})`: POST /discover → primer agente dentro de budget → POST /compose (NC-3, work-item DT-6)
`operate()` llama `POST /discover {q: goal}` (alias POST, WKH-031), filtra `agents` por `status` ya viene activo del server, selecciona el **primer** `agent` con `priceUsdc <= maxAgentBudgetUsd` (default: sin tope si `maxAgentBudgetUsd` undefined), y llama `POST /compose {steps:[{agent: agent.slug, registry: agent.registry_id}]}` con header `x-a2a-key`. Si no hay candidato → retorna `{ operated: false, reason: 'NO_AGENT_IN_BUDGET' }` (el agente de referencia loguea y **exit 0**, NO error — work-item DT-6). NOTA: `compose` envía `registry: agent.registry_id` (PK canónico) — pero `ComposeStep.registry` el server lo resuelve; se documenta que se pasa el identificador que el server espera (verificado: `resolveAgentPriceUsdc(agent, registry)` acepta el registry del step).

### DT-7 — `getReputation({agentSlug})` → GET /agents/:slug/agent-card (work-item AC-8)
Llama `GET /agents/${agentSlug}/agent-card`, retorna `card.computedReputation ?? null` (el campo es opcional/omitido si no hay score — agent-card.ts:74-81). 404 → `OperationError`.

### DT-8 — Mapeo de errores tipados (work-item DT-8) + manejo del DRIFT 402/403
Errores exportados (todos extienden `WasiAgentError` con `.step`/`.code` legibles, NUNCA con la PK ni `error.message` crudo de PG — auto-blindaje §9):
- `ProvisionError(step: 'signup'|'bind'|'transfer'|'deposit', cause)` (AC-3).
- `InsufficientBudgetError(keyId, chainId, detail)` (AC-7).
- `IdentityMintError(stage: 'mint'|'bind', cause)` y `IdentityBindError` (AC-4).
- `OperationError(endpoint, status, body)` (AC-6, genérico).

**DRIFT 402/403 (OBS-1):** el client wrapper mapea a `InsufficientBudgetError` **tanto** `HTTP 402` (x402 puro) **como** `HTTP 403` con `body.error_code === 'INSUFFICIENT_BUDGET'` (path agent-key, que es el que usa el SDK). NUNCA reintenta (AC-7: "without retrying").

### DT-9 — Integración del paquete sin romper el build del server (CD-6, hallazgo §1.1)
- `packages/agent-sdk/package.json`: `{ "name":"@wasiai/agent-sdk", "type":"module", "main":"dist/index.js", "types":"dist/index.d.ts", "exports":{".":"./dist/index.js"}, "peerDependencies":{"viem":"^2.47.6"}, "scripts":{"build":"tsc","test":"vitest run","lint":"biome check ."}, "devDependencies":{"typescript","vitest","@types/node"} }`.
- `packages/agent-sdk/tsconfig.json`: `{ "compilerOptions": {"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","strict":true,"declaration":true,"rootDir":"./src","outDir":"./dist","esModuleInterop":true,"skipLibCheck":true,"forceConsistentCasingInFileNames":true}, "include":["src/**/*"] }`.
- El agente de referencia `examples/autonomous-agent.ts` se ejecuta con `tsx` (ya en devDeps del server) e importa el SDK por **source path relativo** (`../packages/agent-sdk/src/index.js` con extensión `.js` por NodeNext) — NO requiere `npm link` ni build previo para correr el ejemplo, ni publish. El server build (`tsc -p tsconfig.build.json`, solo `src/`) NO ve `packages/` ni `examples/` → **0 impacto en el build/deploy del server**.

### DT-10 — Selección del agente destino determinista (NC-3)
`agents` viene ya filtrado a `status==='active'` por el server (discovery.ts:271-273). El SDK NO re-filtra status; selecciona el **primer** elemento del array cuyo `priceUsdc <= maxAgentBudgetUsd`. El orden lo define el server (verified→reputation→price). Determinista respecto a la respuesta del server.

### DT-11 — Tests unitarios sin red (work-item DT-7, AC-11, CD-9)
- `fetch` se inyecta vía `config.fetchImpl` (default `globalThis.fetch`) y se mockea con `vi.fn()` que devuelve respuestas `{ ok, status, json }` simuladas. **NO** `vi.stubGlobal` global con call-count cruzado (auto-blindaje WKH-103, §9): la inyección por config evita el problema de fetch interno.
- `walletClient`/`publicClient` viem se inyectan vía config (`config.walletClient`/`config.publicClient`) y se mockean (`writeContract`, `waitForTransactionReceipt`, `sendTransaction`) — NO `vi.mock('viem')` global (más frágil; la inyección es más limpia y testeable).
- Suite del SDK corre con `vitest run` **dentro de `packages/agent-sdk/`** (DT-9). El `vitest.config.ts` raíz se actualiza para **excluir `packages/**`** (defensivo) → `vitest run` raíz del server sigue verde (CD-9). Los tests del SDK corren SIN env vars ni red.
- E2E del agente de referencia: gateado por `RUN_E2E=true` (work-item DT-7), corre el ciclo real contra testnet (Base Sepolia / Avalanche Fuji). NO corre en CI por defecto.

---

## 3. ABI del mint ERC-8004 — CONFIRMADO del repo oficial

**Fuente:** `github.com/erc-8004/erc-8004-contracts@main` (clonado y leído 2026-05-31).
**Archivos:** `contracts/IdentityRegistryUpgradeable.sol:60-90` + `abis/IdentityRegistry.json`.

El IdentityRegistry es un **ERC-721** (`__ERC721_init("AgentIdentity","AGENT")`). Tiene `register` **sobrecargado** en 3 variantes:

```solidity
function register() external returns (uint256 agentId);                                   // mint sin URI
function register(string memory agentURI) external returns (uint256 agentId);              // ← LA QUE USA EL SDK
function register(string memory agentURI, MetadataEntry[] memory metadata) external returns (uint256 agentId);
```

Comportamiento de `register(string agentURI)` (`:69-78`):
1. `agentId = $._lastId++` (auto-incremental, NO lo provee el caller).
2. `_safeMint(msg.sender, agentId)` → **la identidad se mintea a `msg.sender`** = la wallet del agente (autonomía: el agente es dueño de su propio AgentID). Coincide con `_safeMint(owner) ⇒ ownerOf(agentId)==agentWallet`, exactamente lo que `POST /erc8004/bind` verifica contra `funding_wallet`.
3. `_setTokenURI(agentId, agentURI)`.
4. `emit Registered(agentId, agentURI, msg.sender)`.

**Evento para extraer el `agentId` del receipt** (`:39`, confirmado en ABI):
```solidity
event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
```
Como `agentId` es `indexed`, sale del `topics[1]` del log. Alternativa: el `Transfer(address,address,uint256)` ERC-721 (`tokenId` indexed). **El SDK parsea el log `Registered` del receipt** (DT-4) — determinista, no re-lee `_lastId`.

**ABI inline `as const` para el SDK** (patrón erc8004-identity.ts:51-66):
```ts
const IDENTITY_REGISTRY_ABI = [
  { name: 'register', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }] },
  { type: 'event', name: 'Registered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ] },
] as const;
```

**Direcciones canónicas confirmadas (README del repo, solo para doc — el SDK las toma de env, CD-1):**
| Red | IdentityRegistry |
|-----|------------------|
| Base Mainnet (8453) | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| Base Sepolia (84532) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |

> **Conclusión:** el `[VERIFY-AT-IMPL]` queda **RESUELTO**. El work-item había propuesto `register(address owner, string tokenURI)` — **INCORRECTO**; la firma real es `register(string agentURI)` con mint a `msg.sender`. El mint es **REAL, no stub**; el único gate es env (gas en Base) por CD-7.

---

## 4. Constraint Directives (CD) — heredadas del work-item + nuevas

| CD | Directiva | Origen |
|----|-----------|--------|
| **CD-1** | PROHIBIDO hardcodear treasury/RPC/chainId/token/registry/contract addresses. Todo desde env o `GET /auth/deposit-info`. | work-item CD-1 |
| **CD-2** | PROHIBIDO ethers.js. Toda operación on-chain con **viem v2**. | work-item CD-2 / golden-path |
| **CD-3** | PROHIBIDO `any` explícito / `as unknown` en el SDK. TypeScript strict. | work-item CD-3 |
| **CD-4** | PROHIBIDO modificar `src/` (server read-only). Ni rutas, ni services, ni adapters, ni tipos. | work-item CD-4 |
| **CD-5** | PROHIBIDO escribir la PK/`account` a stdout, logs, archivos o serialización (`toJSON`/`toString` redactan). `account` in-memory, nunca expuesto por getter. | work-item CD-5 |
| **CD-6** | OBLIGATORIO `packages/agent-sdk/` con su PROPIO `package.json` + `tsconfig.json`, sin extender del server. | work-item CD-6 |
| **CD-7** | OBLIGATORIO que el mint (AC-4) esté gateado por `ENABLE_IDENTITY_MINT=true` **Y** `ERC8004_REGISTRY_ADDRESS` seteada. Sin ambas → NO intenta el mint, loguea `IDENTITY_SKIP`, continúa. | work-item CD-7 (ajustado: ABI confirmado, gate = env) |
| **CD-8** | PROHIBIDO >1 RPC write concurrente no coordinado en provision. `/deposit` y el mint son **secuenciales** (await estricto). Anti doble-depósito / doble-mint. | work-item CD-8 |
| **CD-9** | OBLIGATORIO que `vitest run` desde la raíz del repo (server) NO falle por tests del SDK. Suite del SDK corre desde `packages/agent-sdk/`. | work-item CD-9 |
| **CD-10** *(nuevo)* | OBLIGATORIO: al firmar EIP-712 en `delegate()`, convertir `expires_at`→`BigInt` y `allowed_chains`→`bigint[]` para el `signTypedData`, pero enviar uint como **number** en el `typed_data` JSON al server. **PROHIBIDO** pasar el message JSON crudo a `signTypedData`. Ref: WKH-101 auto-blindaje W1 (§9). | nuevo (recurrente) |
| **CD-11** *(nuevo)* | OBLIGATORIO: NUNCA propagar `error.message` crudo de un HTTP error / cadena viem al campo público del error tipado. Capturar status+code estables; el detalle raw solo a un campo `cause` no serializado por default. Ref: WKH-101/WKH-103 (§9). | nuevo (recurrente) |
| **CD-12** *(nuevo)* | OBLIGATORIO: `npm run format`/`biome check --write` ANTES de cerrar cada wave. Ref: WKH-101/102/103 (§9). El SDK incluye su propio `biome check`. | nuevo (recurrente) |
| **CD-13** *(nuevo)* | OBLIGATORIO: el `agentId`/`token_id` post-mint se extrae **parseando el log del receipt** (`Registered`/`Transfer`), NUNCA re-leyendo `_lastId` (no determinista bajo concurrencia). | nuevo (correctness) |

---

## 5. Tipos del SDK (`packages/agent-sdk/src/types.ts`)

```ts
export interface WasiAgentConfig {
  a2aBase: string;
  network: string;               // slug, p.ej. 'base-sepolia' (matchea /auth/deposit-info)
  rpcUrl: string;
  chainId: number;
  identityRegistryAddress?: `0x${string}`;
  enableIdentityMint?: boolean;
  maxAgentBudgetUsd?: number;
  // inyectables para test (DT-11) — opcionales, defaults reales
  fetchImpl?: typeof fetch;
  walletClient?: WalletClient;   // viem
  publicClient?: PublicClient;   // viem
}
export interface ProvisionInput { ownerRef: string; amount: string; displayName?: string; }
export interface ProvisionResult { keyId: string; balance: string; chainId: number; }  // NUNCA incluye la PK
export interface MintResult { skipped: boolean; reason?: string; tokenId?: string; chainId?: number; agentCardUri?: string; }
export interface OperateInput { goal: string; }
export interface OperateResult { operated: boolean; reason?: string; agentSlug?: string; payload?: unknown; txHash?: string; }
export interface ReputationResult { /* = AgentReputation | null */ }
export type ProvisionStep = 'signup' | 'bind' | 'transfer' | 'deposit';
// + clases de error (DT-8)
```
> El `key` (token `wasi_a2a_*`) se guarda **interno** (`#key`) y se usa para los headers; **no** se devuelve en `ProvisionResult` (anti-leak; el caller no lo necesita para operar vía el SDK). El agente de referencia tampoco lo imprime (CD-5).

---

## 6. API pública del SDK (`WasiAgent`)

| Método | Firma | ACs | Flujo |
|--------|-------|-----|-------|
| `constructor` | `(account: LocalAccount, config: WasiAgentConfig)` | — | Guarda `#account`, `#config`. Crea `wallet`/`public` viem (o usa los inyectados). |
| `provision` | `(input: ProvisionInput): Promise<ProvisionResult>` | AC-1/2/3 | `GET /deposit-info` → signup → bind (`signMessage`) → `parseUnits` + ERC-20 `transfer` → `waitForTransactionReceipt(min_confirmations)` → `POST /deposit`. Secuencial (CD-8). Cada step en su try → `ProvisionError(step)`. |
| `mintIdentity` | `(card?: Partial<AgentCard>): Promise<MintResult>` | AC-4/5 | Gate CD-7. Construye `data:` URI (DT-5) → `register(string)` `writeContract` → parsea log `Registered` (CD-13) → `POST /erc8004/bind {token_id}`. |
| `delegate` | `(policy: DelegationPolicy): Promise<{delegationId, sessionKeyAddress}>` | (paso 5) | session key efímera → EIP-712 (CD-10) → `POST /auth/delegation`. |
| `discover` | `(query: {goal?: string; ...}): Promise<Agent[]>` | AC-6 | `POST /discover`. |
| `operate` | `(input: OperateInput): Promise<OperateResult>` | AC-6/7 | discover → primer agente en budget (DT-10) → `POST /compose`. 402/403-INSUFFICIENT_BUDGET → `InsufficientBudgetError` (DT-8). |
| `getReputation` | `(input: {agentSlug: string}): Promise<ReputationResult|null>` | AC-8 | `GET /agents/:slug/agent-card` → `computedReputation ?? null`. |

`client.ts` = wrapper `fetch` con header `x-a2a-key` (patrón `api()` de fund-agent-key.mjs:51-58), mapea status→error tipado (CD-11, DT-8).
`wallet.ts` = helpers viem: ERC-20 transfer, EIP-191 `signMessage`, EIP-712 `signTypedData` (CD-10), `writeContract` mint + parse de log.
`identity.ts` = `data:` URI builder + mint gated + bind (CD-7/CD-13).

---

## 7. Waves de implementación

> **W0 serial primero** (estructura + tipos + config). W1+ dependen de W0 pero entre sí son acoplados por el cliente HTTP, así que se sugiere orden secuencial dado el tamaño.

| Wave | Archivos | Contenido | Gate |
|------|----------|-----------|------|
| **W0** (serial, contratos) | `packages/agent-sdk/package.json`, `tsconfig.json`, `vitest.config.ts`, `biome.json` (o reuso), `src/types.ts`, `src/errors.ts`, `src/config.ts` | Estructura del paquete (DT-9), tipos (§5), clases de error (DT-8/CD-11), validación de config (CD-1). Update defensivo `vitest.config.ts` raíz: excluir `packages/**` (CD-9). | `tsc --noEmit` en el SDK = 0 errores. `vitest run` raíz del server sigue verde. |
| **W1** (SDK client + wallet) | `src/client.ts`, `src/wallet.ts` | `fetch` wrapper con `x-a2a-key` + mapeo de errores (DT-8/CD-11). Helpers viem: transfer, signMessage, signTypedData (CD-10), mint+parse-log (CD-13). | unit. |
| **W2** (SDK provision) | `src/agent.ts` (`provision`) | signup→bind→transfer→deposit secuencial (CD-8), `ProvisionError(step)` (AC-1/2/3). | unit AC-1/AC-3. |
| **W3** (SDK identity mint) | `src/identity.ts`, `src/agent.ts` (`mintIdentity`) | `data:` URI (DT-5), mint gated REAL (CD-7), bind (AC-4/AC-5). ABI §3. | unit AC-4 (mint mockeado) + AC-5 (skip). |
| **W4** (SDK operate + delegate + reputation) | `src/agent.ts` (`discover`,`operate`,`delegate`,`getReputation`), `src/index.ts` | discover→first-in-budget→compose (AC-6), 402/403→InsufficientBudgetError (AC-7), reputación (AC-8), delegate EIP-712 (CD-10). Export barrel. | unit AC-6/AC-7/AC-8. |
| **W5** (agente de referencia) | `examples/autonomous-agent.ts`, `examples/README-autonomous-agent.md` | Ciclo end-to-end desde env (AC-9), exit 0/1 + log estructurado por step, anti-leak en error (AC-10). Importa SDK por source path (DT-9). | manual/e2e gated. |
| **W6** (tests) | `packages/agent-sdk/test/*.test.ts` | vitest mockeado (AC-11): AC-1 happy, AC-3 transfer-fail, AC-4 mint, AC-5 skip, AC-6 discover+compose, AC-7 402/403, AC-8 reputación. Sin red (CD-9/DT-11). | `vitest run` del SDK = verde sin env/red. `biome check` (CD-12). |

---

## 8. Plan de tests (≥1 por AC)

| Test | AC | Qué cubre | Archivo | Mock |
|------|----|-----------|---------|------|
| T-AC1 provision happy | AC-1/AC-2 | signup→bind→transfer→deposit en orden; `parseUnits(amount, decimals)`; espera `min_confirmations`; retorna `{keyId,balance,chainId}` SIN key/PK. | `test/provision.test.ts` | `fetchImpl` mock (deposit-info, signup, funding-wallet, deposit), `walletClient.writeContract`, `publicClient.waitForTransactionReceipt` |
| T-AC3 transfer fail | AC-3 | `writeContract` revierte → `ProvisionError` con `step==='transfer'`. RPC down → idem. Estado parcial observable. | `test/provision.test.ts` | walletClient rechaza |
| T-AC4 mint identity | AC-4 | gate ON → `register(string)` con `data:` URI base64; `token_id` extraído del log `Registered`; `POST /erc8004/bind {token_id}`. | `test/identity.test.ts` | walletClient.writeContract → receipt con log `Registered`; fetch bind 200 |
| T-AC5 mint skip | AC-5 | gate OFF (`enableIdentityMint` falsy o sin address) → `{skipped:true}`, NO writeContract, sin error. | `test/identity.test.ts` | — |
| T-AC6 operate | AC-6 | discover devuelve 2 agentes; selecciona el primero con `priceUsdc<=budget`; `POST /compose {steps:[{agent,registry}]}`; retorna payload. Sin candidato → `{operated:false,reason:'NO_AGENT_IN_BUDGET'}`. | `test/operate.test.ts` | fetch discover + compose |
| T-AC7 budget exhausted | AC-7 | compose → **403 `INSUFFICIENT_BUDGET`** → `InsufficientBudgetError`, sin retry. **Y** caso 402 → mismo error (DRIFT OBS-1). | `test/operate.test.ts` | fetch 403/402 |
| T-AC8 reputation | AC-8 | agent-card con `computedReputation` → lo retorna; sin campo → `null`. | `test/reputation.test.ts` | fetch agent-card |
| T-AC10 no-leak on error | AC-10 | en cualquier error, `JSON.stringify(agent)`/`toString` NO contienen la PK ni el key token. | `test/agent.test.ts` | — |
| T-AC11 no-network guard | AC-11/CD-9 | `vitest run` del SDK corre sin env vars ni red (todos los fetch/viem inyectados/mockeados; ningún `globalThis.fetch` real invocado). | todos | inyección por config |
| E2E (gated `RUN_E2E`) | AC-9/AC-10 | `examples/autonomous-agent.ts` real contra testnet: provision→[mint]→operate→reputation, exit 0; un step que falla → exit≠0 + step name. | `examples/autonomous-agent.ts` (manual) | red REAL (testnet) |

---

## 9. Auto-Blindaje histórico aplicado (WKH-100/101/102/103/104)

Patrones recurrentes (≥2 HUs) detectados en los `auto-blindaje.md` y bakeados como CD/DT:

| Patrón recurrente | HUs | Bakeado en |
|-------------------|-----|------------|
| **viem EIP-712: convertir uint a `BigInt` al firmar, number en JSON** | WKH-101 W1 | **CD-10** + DT (delegate). |
| **[VERIFY-AT-IMPL] contra repo oficial, NUNCA inventar ABI, citar fuente** | WKH-101 W1, WKH-103 W3 | **§3** (ABI confirmado del repo, firma real ≠ la propuesta del work-item). |
| **`biome check --write`/`format` ANTES de lint en cada wave** | WKH-101 W5, WKH-102, WKH-103 | **CD-12**. |
| **factory-mock debe reflejar TODOS los exports consumidos** | WKH-100 ×2, WKH-103 W4 | **DT-11**: inyección por config en vez de `vi.mock`/`vi.stubGlobal` global → elimina la clase de bug. |
| **NUNCA propagar `error.message` crudo de PG/HTTP al cliente** | WKH-101 fix-pack, WKH-103 CD-18 | **CD-11** (errores tipados con code estable; raw solo en `cause` no serializado). |
| **`vi.stubGlobal('fetch')` + call-count se infla por fetch interno** | WKH-103 W4 | **DT-11**: `fetchImpl` inyectado, no stub global. |
| **path interno del plugin NO lleva el prefix** | WKH-101 W2 | informativo: la URL pública es `/auth/delegation` (confirmado §1). |

---

## 10. Observaciones / Drift detectado

- **OBS-1 (DRIFT AC-7 — no bloqueante, bakeado):** AC-7 dice "HTTP 402". El server con `x-a2a-key` (camino del SDK) devuelve **HTTP 403** `{error_code:'INSUFFICIENT_BUDGET'}` (a2a-key.ts:528-532); el 402 puro solo ocurre en x402 sin agent-key. El SDK mapea **ambos** a `InsufficientBudgetError` (DT-8). El AC-7 se considera cumplido por el comportamiento real, documentado aquí. NO requiere cambio de server (CD-4).
- **OBS-2 (estructura):** el repo NO es monorepo; `packages/agent-sdk/` es sub-paquete independiente (§1.1, DT-9). Si en el futuro se adoptan npm workspaces, será una HU de infra (work-item Scope OUT).
- **OBS-3 (prerequisito de entorno, no de código):** el E2E real requiere gas nativo en Base Sepolia + USDC testnet en la funding wallet (MI-5). Se documenta en `examples/README-autonomous-agent.md`. NO es parte del código ni de los unit tests.
- **OBS-4 (compose registry):** `operate()` pasa `registry: agent.registry_id` en el `ComposeStep`; el server resuelve precio/agente con ese identificador (compose.ts:48-52 vía `resolveAgentPriceUsdc`). Si en F3 se observa que el server espera `agent.registry` (display name) en vez del `registry_id`, el Dev ajusta el campo según el comportamiento real verificado (no bloqueante; ambos campos están en `Agent`).

---

## 11. Readiness Check — para SPEC_APPROVED

| Item | Estado | Evidencia |
|------|--------|-----------|
| Todos los `[NEEDS CLARIFICATION]` resueltos | ✅ PASS | NC-1/NC-2/NC-3 bakeados (§0); MI-1/MI-3/MI-4 cerrados. |
| `[VERIFY-AT-IMPL]` del mint ABI resuelto | ✅ PASS | §3: `register(string agentURI)→uint256` confirmado del repo oficial (NO inventado). Firma del work-item era incorrecta; corregida. |
| Exemplars verificados con paths reales | ✅ PASS | §1 Context Map — todos los archivo:línea leídos (auth.ts, discover.ts, compose.ts, a2a-key.ts, erc8004-identity.ts, examples/*, package.json, tsconfig, vitest.config). |
| Estructura del paquete definida sin romper el server | ✅ PASS | §1.1 + DT-9: sub-paquete independiente; build server solo `src/`; vitest raíz excluye `packages/**` (CD-9). |
| Waves definidas (W0 serial primero) | ✅ PASS | §7: W0→W6. |
| Plan de tests ≥1 por AC | ✅ PASS | §8: AC-1..AC-11 + E2E gated cubiertos. |
| CD heredados + nuevos | ✅ PASS | §4: CD-1..CD-9 heredados + CD-10/11/12/13 nuevos (anti-recurrencia §9). |
| PK nunca serializada | ✅ PASS | DT-2/CD-5: `#account` private, `toJSON`/`toString` redactan, `key`/PK fuera de `ProvisionResult`. |
| Server read-only | ✅ PASS | CD-4: ningún archivo de `src/` en Scope IN. |
| TBDs abiertos | ✅ NINGUNO | — |
| Drift documentado | ✅ PASS | §10 OBS-1 (402/403) bakeado en DT-8. No requiere cambio de server. |

**Veredicto Readiness: PASS** — el SDD está listo para `SPEC_APPROVED`. Observaciones (OBS-1/2/3/4) son no bloqueantes y están bakeadas en DT/CD; ninguna requiere decisión humana adicional ni cambio del server.
