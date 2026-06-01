# Work Item — [WKH-105] Autonomía agéntica: SDK + agente de referencia (TypeScript)

## Resumen

Construir un **SDK cliente TypeScript** (`WasiAgent`) que expone el ciclo de vida
autónomo de un agente sobre wasiai-a2a (provision → fondeo → identidad → operar →
reputación), y un **agente de referencia runnable** (`examples/autonomous-agent.ts`)
que lo usa end-to-end sin intervención humana.

El servidor (src/routes/*, src/services/*, src/adapters/*) queda **read-only**:
WKH-105 es puramente client-side.

---

## F0 — Grounding confirmado

| Artefacto | Ruta confirmada | Relevancia para WKH-105 |
|-----------|----------------|------------------------|
| `POST /auth/agent-signup` | `src/routes/auth.ts:267` | paso 1: crear key |
| `POST /auth/funding-wallet` | `src/routes/auth.ts:319` | paso 2: bindear wallet |
| `GET /auth/deposit-info` | `src/routes/auth.ts:549` | paso 3a: leer treasury/token |
| `POST /auth/deposit` | `src/routes/auth.ts:398` | paso 3c: declarar depósito |
| `GET /auth/me` | `src/routes/auth.ts:508` | consultar balance/estado |
| `POST /auth/erc8004/bind` | `src/routes/auth.ts:585` | paso 4: bindear identidad |
| `POST /auth/delegation` | `src/routes/auth.ts:833` | paso 5 (opcional): delegar |
| `POST /discover` | `src/routes/discover.ts` | paso 6a: descubrir agentes |
| `POST /compose` | `src/routes/compose.ts` | paso 6b: operar/pagar |
| `POST /orchestrate` | `src/routes/orchestrate.ts` | paso 6c: meta-operar |
| `GET /agents/:slug/agent-card` | `src/routes/agent-card.ts:18` | paso 7: reputación |
| `examples/fund-agent-key.mjs` | confirmado | patrón signup+bind+transfer+deposit |
| `examples/delegation-demo.mjs` | confirmado | patrón EIP-712 signTypedData |
| `viem ^2.47.6` | `package.json:22` | firma EIP-191/712, ERC-20 transfer, on-chain write |

**Mensaje canónico funding-wallet**: `WASIAI_BIND_FUNDING_WALLET:<key_id>`
(`src/routes/auth.ts:63-64`).

**ERC-8004 reader existente**: `src/adapters/erc8004-identity.ts` — solo lee
`ownerOf`/`tokenURI` (ERC-721 view). El ABI de mint del IdentityRegistry NO está
implementado en el servidor (`[VERIFY-AT-IMPL]` — ver DT-4).

---

## Sizing

- **SDD_MODE**: full (QUALITY)
- **Estimación**: L (nuevo módulo SDK, crypto/wallet, agente runnable, tests mockeados)
- **Skills**: `blockchain-viem`, `typescript-sdk`
- **Branch sugerido**: `feat/105-autonomous-agent-sdk`

---

## Decisión de estructura — dónde vive el SDK

**Propuesta**: `packages/agent-sdk/` (monorepo-ready, separación limpia del server).

Justificación:
- El server ya tiene su propio `src/` con Fastify. Mezclar SDK cliente en `src/sdk/`
  crea acoplamiento: el server importaría viem wallet clients innecesariamente.
- `packages/agent-sdk/` permite publish independiente (`@wasiai/agent-sdk`) en el futuro.
- `examples/autonomous-agent.ts` vive en `examples/` (igual que los `.mjs` existentes)
  e importa desde `packages/agent-sdk/`.
- Si el humano prefiere `src/sdk/` o `examples/` (inline), el Architect decide en F2.
  Por ahora se propone `packages/agent-sdk/` como default.

**[NEEDS CLARIFICATION-1]**: ¿se prefiere `packages/agent-sdk/` (monorepo) vs `src/sdk/`
(co-located) vs `examples/` (inline sin paquete)? Recomendación: `packages/agent-sdk/`.

---

## Decisión de la identidad mint (paso 4)

El servidor SOLO hace `ownerOf` y `tokenURI` sobre el IdentityRegistry.
La función de mint (`register`/`mint`) del ERC-8004 canónico NO está en el codebase
del servidor. El SDK necesitaría llamar esa función directamente.

**Propuesta**: la identidad mint entra como **paso gated por env**:
- Si `ERC8004_REGISTRY_ADDRESS` y `BASE_TESTNET_RPC_URL` están seteados, el SDK intenta
  mintear on-chain y luego llama `POST /auth/erc8004/bind`.
- Si el ABI de mint resulta incompatible con el contrato real
  ([VERIFY-AT-IMPL]: confirmar firma `register(address owner, string tokenURI)` o similar
  en https://github.com/erc-8004/erc-8004-contracts), el agente omite el mint
  y deja un log `IDENTITY_SKIP: mint ABI not confirmed`.
- El agente de referencia SIEMPRE completa el ciclo incluso sin mint
  (pasos 1-3 + 6-7 son suficientes para demostrar autonomía económica completa).

**[NEEDS CLARIFICATION-2]**: ¿el mint de identidad es OBLIGATORIO para esta entrega
(bloqueante) o OPTIONAL/gated? Recomendación: gated (el ciclo económico es demostrable
sin mint; el mint depende de un ABI externo sin confirmar).

---

## Decisión sobre el agente destino (paso 6 — "pagar a otro agente")

Para demostrar `POST /compose` con debit real, se necesita al menos un agente
descubrible en un registry activo (e.g. `agentshop-*` en wasiai-v2).

**Propuesta**: el agente de referencia usa `POST /discover` primero y selecciona el
primer agente disponible cuyo precio sea <= `MAX_AGENT_BUDGET_USD` (env var). Si no
hay ninguno, el ciclo de referencia se detiene en el paso 5 con log apropiado pero
sin error fatal.

**[NEEDS CLARIFICATION-3]**: ¿hay un agente destino estable en testnet que se pueda
hardwire (slug conocido) en el ejemplo, o se usa el primer agente del discover?
Recomendación: first-from-discover para evitar dependencia en un slug específico.

---

## Acceptance Criteria (EARS)

### Provisión y fondeo

**AC-1**: WHEN `WasiAgent.provision({ ownerRef, funderPk, network, amount })` is
called, the SDK SHALL execute agent-signup → bind-funding-wallet → ERC-20 transfer
→ deposit in sequence, returning `{ key, keyId, balance }` with no human interaction
required.

**AC-2**: WHEN `WasiAgent.provision()` completes, the system SHALL have called
`GET /auth/deposit-info` to resolve treasury address and token decimals, used
`viem.parseUnits(amount, token.decimals)` for the ERC-20 transfer amount, and waited
for `min_confirmations` before calling `POST /auth/deposit`.

**AC-3**: IF the ERC-20 transfer reverts or RPC is unavailable, THEN the SDK SHALL
throw a typed error `ProvisionError` with a `step` field indicating which step failed
(`'transfer'` | `'deposit'` | `'bind'`), leaving partial state observable via
`GET /auth/me`.

### Identidad (gated)

**AC-4**: WHERE env `ENABLE_IDENTITY_MINT=true` AND `ERC8004_REGISTRY_ADDRESS` is set,
the system SHALL call the IdentityRegistry mint function on-chain (via viem
`writeContract`) and then call `POST /auth/erc8004/bind` with the resulting `token_id`.

**AC-5**: WHERE `ENABLE_IDENTITY_MINT` is not set or mint ABI is unconfirmed,
the system SHALL skip the on-chain mint, log `IDENTITY_SKIP: mint ABI not confirmed
[VERIFY-AT-IMPL]`, and continue with the rest of the lifecycle without error.

### Operación y pago

**AC-6**: WHEN `WasiAgent.operate({ goal })` is called, the SDK SHALL call
`POST /discover` with the goal as query, select the first available agent within
budget, and call `POST /compose` or `POST /orchestrate`, returning the response
payload.

**AC-7**: WHEN `POST /compose` is called and the agent key has insufficient budget,
THEN the SDK SHALL throw a typed error `InsufficientBudgetError` (HTTP 402) without
retrying.

### Reputación

**AC-8**: WHEN `WasiAgent.getReputation({ agentSlug })` is called, the system
SHALL call `GET /agents/:slug/agent-card` and return the `computedReputation` field
if present, or `null` if the agent has no score yet.

### Agente de referencia

**AC-9**: WHEN `examples/autonomous-agent.ts` is run with valid env vars
(`FUNDER_PK`, `NETWORK`, `A2A_BASE`), the system SHALL complete the full lifecycle
(provision → [identity-gated] → operate → reputation) and exit 0, printing a
structured log of each step with its result.

**AC-10**: WHEN any step in `examples/autonomous-agent.ts` fails, THEN the system
SHALL exit non-zero, print the error with the failing step name, and NOT leave
dangling credentials in memory.

### Tests unitarios

**AC-11**: the system SHALL provide unit tests (vitest) for `WasiAgent` with
`fetch` and viem wallet mocked, covering AC-1 (happy path), AC-3 (transfer failure),
AC-6 (discover + compose), and AC-7 (402 budget exhausted); tests SHALL NOT make
real network calls.

---

## Scope IN

| Artefacto | Descripción |
|-----------|-------------|
| `packages/agent-sdk/src/index.ts` | Entry point SDK, exporta `WasiAgent` clase |
| `packages/agent-sdk/src/types.ts` | Tipos del SDK (ProvisionResult, ProvisionError, etc.) |
| `packages/agent-sdk/src/client.ts` | HTTP client wrapper (fetch, headers x-a2a-key) |
| `packages/agent-sdk/src/wallet.ts` | Viem wallet helpers (ERC-20 transfer, EIP-191 sign, EIP-712 signTypedData) |
| `packages/agent-sdk/src/identity.ts` | Mint gated [VERIFY-AT-IMPL] + bind ERC-8004 |
| `packages/agent-sdk/package.json` | Paquete ESM, viem como peerDep |
| `packages/agent-sdk/tsconfig.json` | TS strict, target ESM |
| `packages/agent-sdk/test/*.test.ts` | Tests unitarios vitest (AC-11) |
| `examples/autonomous-agent.ts` | Agente de referencia runnable (AC-9/AC-10) |

---

## Scope OUT

| Artefacto | Razón |
|-----------|-------|
| `src/routes/*` | Server read-only — NO cambios |
| `src/services/*` | Server read-only — NO cambios |
| `src/adapters/*` | Server read-only — NO cambios |
| `src/middleware/*` | Server read-only — NO cambios |
| ABIs / contratos on-chain | Solo se usa el ABI de mint [VERIFY-AT-IMPL]; el resto es ERC-721 estándar ya conocido |
| Dashboard / static | Fuera de scope |
| SDK Python / Go | Solo TypeScript en esta entrega |
| Publish a npm | Fuera de scope (monorepo local) |
| RLS / Supabase | Sin cambios de DB |
| Mainnet real con fondos reales | Solo testnet (Base Sepolia / Avalanche Fuji) |

---

## Decisiones técnicas (DT-N)

**DT-1**: El SDK es un paquete ESM TypeScript en `packages/agent-sdk/` con
`viem` como `peerDependency` (ya presente en el workspace), sin bundler propio
en esta entrega (compilar con `tsc`). Justificación: alineado con stack existente.

**DT-2**: `WasiAgent` es una clase stateful que guarda `key`, `keyId`, `account`
(viem LocalAccount) internamente tras `provision()`. No se serializa la private key
a disco en ningún momento.

**DT-3**: El agente de referencia lee toda configuración desde env vars. Lista mínima:
`FUNDER_PK`, `NETWORK`, `AMOUNT`, `OWNER_REF`, `A2A_BASE`. Opcionales:
`ENABLE_IDENTITY_MINT`, `ERC8004_REGISTRY_ADDRESS`, `MAX_AGENT_BUDGET_USD`.
PROHIBIDO hardcodear valores de red/treasury/token.

**DT-4** [VERIFY-AT-IMPL]: La función de mint del IdentityRegistry ERC-8004 canónico
requiere confirmación de ABI antes de implementar `identity.ts`. Candidato:
`register(address owner, string tokenURI) returns (uint256 tokenId)` (basado en
convención ERC-721 + ERC-8004 spec). El Architect y Dev DEBEN verificar
https://github.com/erc-8004/erc-8004-contracts antes de codear. Si el ABI no
coincide, el SDK omite el mint y loguea `IDENTITY_SKIP`.

**DT-5**: El AgentCard para el mint (tokenURI) es un `data:application/json;base64,`
auto-contenido (sin hosting). Formato mínimo: `{ name, description, url }` compatible
con A2A Agent Card. Patrón visto en "Test Agent 004" on-chain.

**DT-6**: En `examples/autonomous-agent.ts`, el discover usa `POST /discover` (no GET)
conforme a WKH-031 (alias POST ya implementado). El primer agente devuelto con
`price_usdc <= MAX_AGENT_BUDGET_USD` es el destino. Si no hay ninguno, exit 0 con log.

**DT-7**: Los tests unitarios mockean `fetch` con vitest `vi.fn()` y mockean el
`WalletClient`/`PublicClient` de viem con `vi.mock('viem')`. NO se hacen llamadas
reales. Los tests del agente de referencia son integración-gated (solo corren con
`RUN_E2E=true`).

**DT-8**: Tipos de error exportados por el SDK: `ProvisionError(step, cause)`,
`InsufficientBudgetError(keyId, chainId, required, available)`,
`IdentityBindError(tokenId, cause)`, `OperationError(endpoint, status, body)`.

---

## Constraint Directives (CD-N)

**CD-1**: PROHIBIDO hardcodear treasury addresses, RPC URLs, chain IDs, token
addresses o contract addresses. Todo desde env vars o desde `GET /auth/deposit-info`.

**CD-2**: PROHIBIDO usar ethers.js. Toda operación on-chain usa viem v2.

**CD-3**: PROHIBIDO `any` explícito. TypeScript strict en todo el SDK.

**CD-4**: PROHIBIDO modificar ningún archivo en `src/` (server read-only).

**CD-5**: PROHIBIDO escribir la private key del agente a stdout, logs, o archivos.
El `account` viem se crea in-memory y nunca se serializa.

**CD-6**: OBLIGATORIO que `packages/agent-sdk/` tenga su propio `package.json` y
`tsconfig.json` sin extender del server.

**CD-7**: OBLIGATORIO que el mint de identidad (AC-4) esté gated por `ENABLE_IDENTITY_MINT=true`
Y por [VERIFY-AT-IMPL] del ABI. Sin ambas condiciones, el SDK NO intenta el mint.

**CD-8**: PROHIBIDO que el SDK haga más de 1 llamada RPC concurrente no coordinada
en el ciclo de provision (riesgo de doble-depósito). Las llamadas a `/deposit` son
secuenciales.

**CD-9**: OBLIGATORIO que los tests (AC-11) pasen sin env vars ni acceso a red.
`vitest run` desde la raíz del workspace NO debe fallar por tests del SDK.

---

## Missing Inputs

| # | Item | Tipo | Estado |
|---|------|------|--------|
| MI-1 | Ubicación del SDK (`packages/agent-sdk/` vs `src/sdk/`) | decisión de estructura | [NEEDS CLARIFICATION-1] → recomendación: `packages/agent-sdk/` |
| MI-2 | ABI del mint ERC-8004 del IdentityRegistry canónico | técnico externo | [VERIFY-AT-IMPL] → resuelto en F2/F3 con lectura de repo |
| MI-3 | ¿Mint de identidad bloqueante o gated? | alcance | [NEEDS CLARIFICATION-2] → recomendación: gated |
| MI-4 | Agente destino para paso 6 (slug hardwired vs first-from-discover) | alcance | [NEEDS CLARIFICATION-3] → recomendación: first-from-discover |
| MI-5 | Gas en Base Sepolia + USDC testnet | prerequisito de entorno | prerequisito real del runner (no del código) — documentar en README del ejemplo |

---

## Análisis de paralelismo

- WKH-105 no bloquea ni depende de ninguna HU abierta (el server está DONE y
  estable desde WKH-104).
- Puede correr en branch propio `feat/105-autonomous-agent-sdk` sin conflicto.
- Si en el futuro se quiere publicar `@wasiai/agent-sdk` a npm, se necesitaría
  una HU de infra de publish (fuera de scope aquí).
