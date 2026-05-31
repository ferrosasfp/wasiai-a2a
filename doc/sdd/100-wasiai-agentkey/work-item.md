# Work Item — [WKH-100] wasiai-agentkey: ERC-8004 Identity Binding (Fase 1)

## Resumen

Implementar la **Fase 1** de `wasiai-agentkey`: verificar y bindear un AgentID ERC-8004 ya
minteado externamente por el owner en Base (chainId 8453 mainnet / 84532 Sepolia), hostear el
AgentCard A2A en wasiai-a2a, y **bindear el AgentID al Agent Key existente** escribiendo el
campo `erc8004_identity` ya presente en `a2a_agent_keys`. El objetivo es que los callers puedan
(a) bindear un AgentID on-chain que ya poseen (el server solo lee/verifica, nunca mintea), (b)
resolver el AgentCard leyendo el IdentityRegistry canónico ERC-8004 en Base, y (c) que
`/discover` pueda surfacear el flag `identity_verified: true` para agentes con identidad
on-chain confirmada.

**Prueba de posesión:** el server lee `ownerOf(tokenId)` del IdentityRegistry y exige que sea
igual a `callerKey.funding_wallet` (case-insensitive). El owner no firma nada nuevo — la
`funding_wallet` ya fue probada on-chain via WKH-35.

Posicionamiento: alternativa **abierta y trustless** (estándar ERC-8004 ratificado ene 2026)
frente al Agent Passport cerrado de Kite. La identidad del agente es portable entre chains y
controlada por el owner, no por un proveedor.

---

## Sizing

- **SDD_MODE:** full
- **Estimación:** L
- **Flow:** QUALITY (toca auth + superficie on-chain nueva + columna `erc8004_identity` en tabla
  crítica de seguridad)
- **Branch sugerido:** `feat/100-wasiai-agentkey-erc8004`

---

## Skills relevantes

- `blockchain-evm` (ERC-8004 IdentityRegistry, viem, Base)
- `backend-ts` (Fastify routes, identity service, ownership guard pattern)

---

## Context grounding (F0)

### Archivos tocados o leídos durante este F0

| Archivo | Relevancia |
|---------|-----------|
| `src/types/a2a-key.ts` | `A2AAgentKeyRow.erc8004_identity: Record<string, unknown> \| null` — campo YA existe en el tipo y en la tabla DB |
| `src/services/identity.ts` | `identityService` — createKey, lookupByHash, deactivate, bindFundingWallet. El binding ERC-8004 es análogo a `bindFundingWallet` |
| `src/middleware/a2a-key.ts` | `requirePaymentOrA2AKey` — augmenta `request.a2aKeyRow`; el campo `erc8004_identity` ya está en el row |
| `src/routes/auth.ts` | `POST /funding-wallet` (proof-of-control via signature) — patrón idéntico para bindear `erc8004_identity` |
| `src/adapters/types.ts` | `IdentityBindingAdapter` (interfaz ya definida: `bind`, `verify`) + `AdaptersBundle.identity: IdentityBindingAdapter \| null` |
| `src/adapters/base/identity.ts` | `export const baseIdentity = null` — placeholder explícito dejado para esta HU |
| `src/adapters/avalanche/identity.ts` | `export const avalancheIdentity = null` — idem |
| `src/adapters/base/chain.ts` | `getBaseChain('mainnet') → base (8453)`, `getBaseChain('testnet') → baseSepolia (84532)` |
| `src/adapters/deposit-verifier.ts` | Patrón lazy-cached `publicClient` por `ChainKey` — mismo patrón para el IdentityRegistry reader |
| `supabase/migrations/20260406000000_a2a_agent_keys.sql` | `erc8004_identity JSONB` — columna ya existe en producción |
| `src/services/agent-card.ts` | `buildAgentCard` — candidato a recibir `identity_verified` en la AgentCard |
| `doc/sdd/spike-kite-passport/decision-doc.md` | Kite Passport = propietario + single-chain Kite only → ERC-8004 es la alternativa trustless abierta confirmada |

### Estado de los identity adapters en el codebase actual

`baseIdentity = null` y `avalancheIdentity = null` son **placeholders explícitos** que esta HU
convierte en adapters reales. El contrato de interfaz `IdentityBindingAdapter` (`bind` +
`verify`) ya está definido en `src/adapters/types.ts`. Los bundles ya tienen `identity: null`
como campo con tipo `IdentityBindingAdapter | null`.

### Contrato ERC-8004 (grounded)

- **EIP**: https://eips.ethereum.org/EIPS/eip-8004 (ratificado ene 2026)
- **Contratos**: https://github.com/erc-8004/erc-8004-contracts
- **IdentityRegistry (canónico)**: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (Base mainnet 8453)
- **IdentityRegistry (Base Sepolia)**: `0x8004A818BFB912233c491871b3d84c89A494BD9e`
- **Característica central**: ERC-721 + URIStorage — cada AgentID es un NFT cuyo `tokenURI`
  apunta a un AgentCard A2A JSON.
- **ABI mínimo necesario (server read-only)**: `ownerOf(uint256)`, `tokenURI(uint256)`.
  El server NUNCA llama `mint`. El ABI de escritura (mint) no se importa en `src/`.
  Verificar ABI exacto en `github.com/erc-8004/erc-8004-contracts` antes de implementar para
  confirmar que no hay funciones no-estándar respecto a ERC-721.

---

## Acceptance Criteria (EARS)

### AC-1 — Bind AgentID al Agent Key
WHEN the owner calls `POST /auth/erc8004/bind` with a valid `token_id` and an authenticated
Agent Key, the system SHALL read `ownerOf(token_id)` from the IdentityRegistry on Base via
viem `publicClient`, verify it matches `callerKey.funding_wallet` (case-insensitive), and write
`erc8004_identity = { token_id, chain_id, agent_card_url, owner_address, verified_at }` to
`a2a_agent_keys` filtered by BOTH `.eq('id', keyId).eq('owner_ref', ownerId)` (Ownership Guard
WKH-53).

### AC-2 — Resolve on-chain
WHEN the system calls `GET /auth/erc8004/resolve/:token_id`, the system SHALL read
`tokenURI(token_id)` from the IdentityRegistry on Base via viem `publicClient` and return the
AgentCard JSON (or `{ url, raw }` if the URI is a URL).

### AC-3 — Funding wallet requerida antes del bind
IF the caller's Agent Key does not have a `funding_wallet` bound (i.e., `funding_wallet IS
NULL`), THEN the system SHALL return HTTP 400 with `error_code: FUNDING_WALLET_NOT_BOUND` and
SHALL NOT attempt any on-chain read or write to `erc8004_identity`.

### AC-4 — Ownership mismatch rechazado
IF `ownerOf(token_id)` on the IdentityRegistry does NOT match `callerKey.funding_wallet`
(case-insensitive), THEN the system SHALL return HTTP 403 with
`error_code: IDENTITY_OWNERSHIP_MISMATCH` and SHALL NOT write to `erc8004_identity`.

### AC-5 — Idempotencia anti-doble-bind
IF `a2a_agent_keys.erc8004_identity` already contains a `token_id` for the same `chain_id`,
THEN the system SHALL return HTTP 409 with `error_code: ERC8004_ALREADY_BOUND` and SHALL NOT
overwrite the existing binding.

### AC-6 — Verificación server-side lazy
WHEN the middleware `requirePaymentOrA2AKey` resolves a key row and `erc8004_identity` is
non-null, the system SHALL expose `identity_verified: true` on `request.a2aKeyRow` so route
handlers can read it without a new RPC call per request.

### AC-7 — Surfacing en /me
WHEN the owner calls `GET /auth/me`, the system SHALL include `bindings.erc8004_identity`
(already returned by the current `/me` handler) with the stored JSONB value, including
`verified_at` if present.

### AC-8 — Surfacing en AgentCard de discover
WHEN an agent has `erc8004_identity != null` in its Agent Key row, the system SHALL include
`identity: { erc8004_token_id, chain_id, verified: true }` in the AgentCard returned by
`GET /agents/:id/agent-card` and surfaced via `POST /discover`.

### AC-9 — Backward-compatible: keys sin identidad siguen funcionando
WHILE a key has `erc8004_identity = null`, the system SHALL authenticate, debit budget, and
respond to all existing routes exactly as before this HU. The identity binding SHALL be
opt-in; the absence of `erc8004_identity` SHALL NOT degrade or block any existing flow.

### AC-10 — Sin hardcodes de addresses
the system SHALL read the IdentityRegistry address, chain ID, and RPC URL from env vars
(`ERC8004_REGISTRY_ADDRESS`, `BASE_MAINNET_RPC_URL` / `BASE_TESTNET_RPC_URL`) and SHALL NOT
have any of those values hardcoded in `src/`.

### AC-11 — Graceful degradation si RPC no disponible
IF the Base RPC is unavailable during a `resolve` or `bind` call, THEN the system SHALL
return `{ ok: false, reason: 'RPC_UNAVAILABLE' }` and SHALL NOT throw an unhandled exception or
credit/debit any balance.

### AC-12 — Desacoplamiento economía / identidad
WHILE the ERC-8004 identity binding process is running, the system SHALL NOT modify
`budget[chainId]` or call `increment_a2a_key_spend` or `register_a2a_key_deposit`. The
economic flow (verify-before-credit, debit por step) SHALL remain untouched.

---

## Scope IN

| Componente | Descripción |
|-----------|-------------|
| `src/adapters/base/identity.ts` | Implementar `BaseIdentityAdapter` que cumple `IdentityBindingAdapter`: solo lectura via viem en Base (testnet + mainnet). Métodos: `verify(tokenId, fundingWallet)` + `resolve(tokenId)` |
| `src/services/identity.ts` | Agregar `bindErc8004Identity(keyId, ownerId, identityData)` con ownership guard |
| `src/routes/auth.ts` | Agregar rutas `POST /auth/erc8004/bind` y `GET /auth/erc8004/resolve/:token_id` |
| `src/services/agent-card.ts` | Extender `buildAgentCard` para incluir `identity` cuando el key row tiene `erc8004_identity` |
| `src/types/a2a-key.ts` | Tipar el shape concreto de `erc8004_identity` (reemplazar `Record<string, unknown>` por interface `Erc8004IdentityBinding`) |
| `src/adapters/types.ts` | Confirmar / ajustar `IdentityBindingAdapter` si el ABI real requiere firma distinta |
| `src/adapters/registry.ts` | Activar `baseIdentity` (reemplazar null por instancia de `BaseIdentityAdapter`) |
| Migration SQL | Si se necesita índice sobre `erc8004_identity` — no nueva columna (ya existe) |
| Tests (vitest) | Unit tests para `BaseIdentityAdapter.verify` (mock viem), integration test `POST /auth/erc8004/bind` |
| `.env.example` | Agregar `ERC8004_REGISTRY_ADDRESS`, documentar para Base mainnet y testnet |

## Scope OUT

| Item | Razón |
|------|-------|
| `POST /auth/erc8004/register` (mint desde server) | NC-1 resuelto: server es read-only en Fase 1. El owner mintea externamente |
| Cualquier transacción saliente al IdentityRegistry | NC-1 resuelto: CD-8 es incondicional |
| ETH para gas en el operator wallet | NC-1 resuelto: no hay transacciones salientes |
| `OPERATOR_PRIVATE_KEY` para identidad | NC-1 resuelto: no se usa en esta HU |
| Firma EIP-712 / secp256k1 como prueba de posesión | NC-2 resuelto: se usa `funding_wallet == ownerOf` |
| Wallet de identidad separada de `funding_wallet` | NC-2 resuelto: se reutiliza `funding_wallet` de WKH-35 |
| Job de migración para keys existentes | NC-3 resuelto: migración voluntaria (opt-in), sin job automático |
| Delegación EIP-712 + session key efímera | Fase 2 — WKH-101 |
| Reputación on-chain (Reputation Registry ERC-8004) | Fase 3 — WKH-102 |
| Validation Registry ERC-8004 | Fase 3 — WKH-103 |
| Kite Passport integration | WKH-84 ya implementó inbound, es independiente de ERC-8004 |
| Deploy de contratos propios | CD-1: usar registry canónico ya deployado |
| RLS Postgres (ALTER TABLE ENABLE ROW LEVEL SECURITY) | WKH-SEC-02 trackeado, pendiente, no en scope aquí |
| Identity adapters para Avalanche / Kite chains | `avalancheIdentity = null` se mantiene; ERC-8004 es canónico en Base |
| UI / dashboard para visualizar identidad | No hay UI en este repo |

---

## Decisiones Técnicas (DT-N)

**DT-1 — Qué chain es la "canónica" para identidad**
Base mainnet (8453). Base Sepolia (84532) para dev/test. Mismo patrón que el deposit-verifier:
`BASE_NETWORK` env resuelve testnet vs mainnet. IdentityRegistry usa CREATE2 → misma address
en ambas (distinto para Base Sepolia según la info provista, ver CD-1).

**DT-2 — Server es read-only respecto al IdentityRegistry (NC-1 resuelto)**
El owner mintea el NFT externamente (wallet, script, otro servicio). Llama
`POST /auth/erc8004/bind` con el `token_id` resultante. El server solo llama `ownerOf` y
`tokenURI` para verificar y resolver. Sin ETH para gas en el server, sin riesgo de drain. Sin
`OPERATOR_PRIVATE_KEY` para identidad. Esta decisión es incondicional para Fase 1.

**DT-3 — ABI del IdentityRegistry**
El server solo necesita dos funciones de lectura: `ownerOf(uint256) → address` y
`tokenURI(uint256) → string`. No se importa la ABI de `mint`. Verificar ABI exacto en
`github.com/erc-8004/erc-8004-contracts` antes de codear para confirmar que no hay funciones
no-estándar respecto a ERC-721. El Architect valida esto en F2.

**DT-4 — Shape del JSONB `erc8004_identity`**
Definir como interface TypeScript en `src/types/a2a-key.ts`:
```
interface Erc8004IdentityBinding {
  token_id: string;       // BigInt serializado como string
  chain_id: number;       // 8453 mainnet | 84532 testnet
  agent_card_url: string; // tokenURI resuelto
  owner_address: string;  // lowercase checksummed (= funding_wallet al momento del bind)
  verified_at: string;    // ISO timestamp del último verify server-side
}
```
Reemplaza `Record<string, unknown> | null`.

**DT-5 — Prueba de posesión: `funding_wallet == ownerOf(tokenId)` (NC-2 resuelto)**
El caller llama `POST /auth/erc8004/bind` con `{ token_id }`. El server:
1. Lee `callerKey.funding_wallet` del row autenticado (ya presente en `request.a2aKeyRow`).
2. Si `funding_wallet` es null → error `FUNDING_WALLET_NOT_BOUND` (AC-3).
3. Llama `ownerOf(token_id)` en el IdentityRegistry via viem.
4. Compara `ownerOf.toLowerCase() === funding_wallet.toLowerCase()`.
5. Si no coincide → error `IDENTITY_OWNERSHIP_MISMATCH` (AC-4).
6. Si coincide → escribe `erc8004_identity` con Ownership Guard completo.
Reutiliza la infraestructura WKH-35 ya auditada. Sin firma nueva, sin nueva wallet.

**DT-6 — Surfacing en AgentCard**
Agregar campo top-level `identity` en la AgentCard (no anidado en `capabilities`) para no
romper parsers que solo esperan `streaming + pushNotifications`. El A2A spec no define este
campo; es una extensión local.

**DT-7 — Lazy cache del publicClient para Base IdentityRegistry**
Mismo patrón que `deposit-verifier.ts`: `Map<'base-mainnet'|'base-sepolia', PublicClient>` con
init lazy. No compartir el cache entre el deposit-verifier y el identity reader (instancias
independientes por módulo).

**DT-8 — Idempotencia del bind**
Check a nivel de servicio: leer el campo actual antes del UPDATE. Si `erc8004_identity` ya
tiene `token_id` para el mismo `chain_id` → 409 sin tocar la DB. El UPDATE usa el Ownership
Guard completo (id + owner_ref).

**DT-9 — Backward-compatibility (NC-3 resuelto)**
`erc8004_identity = null` es el estado válido y permanente para las keys que no hacen el bind.
No hay migration job. El campo es opt-in. El middleware, las rutas de budget, y todas las rutas
existentes tratan `erc8004_identity = null` sin modificación de behavior.

---

## Constraint Directives (CD-N)

**CD-1 — Registry canónico pre-deployado en Base**
PROHIBIDO deployar contratos propios. OBLIGATORIO usar:
- Base mainnet 8453: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- Base Sepolia 84532: `0x8004A818BFB912233c491871b3d84c89A494BD9e`
Addresses vienen de env (`ERC8004_REGISTRY_ADDRESS`) — no hardcodeadas en `src/`.

**CD-2 — Identidad desacoplada del budget**
PROHIBIDO modificar `budget[chainId]`, `increment_a2a_key_spend`, o
`register_a2a_key_deposit` en ninguna ruta de esta HU. El flujo económico NO cambia.

**CD-3 — Ownership Guard (WKH-53)**
OBLIGATORIO: cualquier `UPDATE` sobre `a2a_agent_keys` para escribir `erc8004_identity` DEBE
filtrar `.eq('id', keyId).eq('owner_ref', ownerId)`. Si el UPDATE retorna 0 rows →
`OwnershipMismatchError`. Este patrón ya existe en `identityService.bindFundingWallet` —
replicarlo exacto.

**CD-4 — Sin hardcodes**
PROHIBIDO hardcodear addresses de contratos, chain IDs, RPC URLs, o cualquier secret en
`src/`. Todo desde env vars.

**CD-5 — viem obligatorio, ethers.js prohibido**
OBLIGATORIO usar viem v2 para toda interacción EVM (publicClient, readContract). PROHIBIDO
importar ethers o cualquier otro cliente EVM.

**CD-6 — TypeScript strict sin `any`**
PROHIBIDO `any` explícito. Los tipos del ABI ERC-721/ERC-8004 se expresan con `as const`
ABI arrays tipados de viem.

**CD-7 — Delegación (Fase 2) es EVM-native, NO off-chain propietario**
PROHIBIDO introducir en esta HU cualquier dependencia de backend propietario externo para
identidad o autoridad delegada. Cuando llegue Fase 2, será EIP-712 + secp256k1 puro.

**CD-8 — Server NUNCA mintea ni firma tx de identidad en Fase 1 (incondicional)**
PROHIBIDO que el server envíe transacciones al IdentityRegistry o a cualquier otro contrato
para registrar/mintear identidades. El `BaseIdentityAdapter` solo llama `readContract` /
`publicClient`. No importar `WalletClient` ni `writeContract` en el adapter de identidad.

**CD-9 — Backward-compatible, sin migration job, identity es opt-in**
PROHIBIDO crear jobs automáticos o scripts que modifiquen `erc8004_identity` en bulk sobre
keys existentes. OBLIGATORIO que todas las rutas existentes funcionen sin cambios cuando
`erc8004_identity = null`. La ausencia de identidad no es un error ni degrada ningún flujo.

---

## HUs futuras (Scope OUT explícito)

| HU futura | Descripción |
|-----------|-------------|
| WKH-101 (Fase 2) | Delegación EIP-712 + secp256k1: policy firmada por owner + session key efímera + enforcement server-side de límites/TTL |
| WKH-102 (Fase 3) | Reputación on-chain (Reputation Registry ERC-8004) sobre tasks liquidadas |
| WKH-103 (Fase 3) | Validation Registry ERC-8004 (más complejo, diferido) |
| WKH-SEC-02 | Postgres RLS real sobre `a2a_agent_keys` (complementa app-layer guard) |

---

## Análisis de paralelismo

- **Esta HU NO bloquea a otras HUs activas.**
- **Puede ir en paralelo con** cualquier HU que no toque `src/routes/auth.ts` o
  `src/services/identity.ts`. Si hay una HU de features sobre `/discover`, coordinar para que
  el campo `identity` en AgentCard no genere conflicto de merge.
- **Las HUs futuras WKH-101/102/103 DEPENDEN** de esta HU para tener `erc8004_identity` como
  base.

---

## Resumen para el orquestador

**Sizing:** QUALITY (L) — toca auth surface, columna de seguridad, nueva superficie on-chain
en Base, patrón ownership guard crítico.

**ACs:** 12 en formato EARS. Cubren: bind con ownership proof, resolve, funding-wallet-requerida,
ownership mismatch, idempotencia, backward-compat, exposición en /me, AgentCard, restricciones
de hardcode, graceful degradation, y desacoplamiento económico.

**Scope Fase 1 definitivo:** server read-only respecto al IdentityRegistry + prueba de posesión
via `funding_wallet == ownerOf` + binding `erc8004_identity` en la tabla existente + surfacing
en AgentCard / discover. Sin mint desde server. Fases 2 y 3 explícitamente OUT.

**CDs clave:** CD-1 (registry canónico), CD-2 (budget intocable), CD-3 (Ownership Guard WKH-53),
CD-5 (viem only), CD-8 (server read-only, incondicional), CD-9 (backward-compat, no migration job).

**Todos los NEEDS CLARIFICATION resueltos.** Work-item listo para HU_APPROVED.

---

## Clarifications resueltas (2026-05-31)

- **NC-1 — Quién paga el gas (resuelto: Opción A):** Server read-only. El owner mintea/registra
  el AgentID on-chain con su propia wallet externamente; el server nunca mintea ni firma
  transacciones de identidad. Las rutas de Fase 1 son exclusivamente `POST /auth/erc8004/bind`
  (verifica + bindea) y `GET /auth/erc8004/resolve/:token_id` (lectura). `POST /auth/erc8004/register`
  queda fuera de scope. CD-8 pasa a ser incondicional.

- **NC-2 — Prueba de posesión (resuelto: Opción A):** `funding_wallet == ownerOf(tokenId)`. Se
  reutiliza el funding-wallet bindeado de WKH-35. Al bindear identidad, el server lee
  `ownerOf(tokenId)` del registry en Base y exige que sea igual a `callerKey.funding_wallet`
  (case-insensitive). Si el key no tiene `funding_wallet` → error `FUNDING_WALLET_NOT_BOUND`.
  Si `ownerOf != funding_wallet` → error `IDENTITY_OWNERSHIP_MISMATCH`. Estos casos son AC-3
  y AC-4 respectivamente.

- **NC-3 — Migración de keys existentes (resuelto: Opción A):** Las keys existentes con
  `erc8004_identity = null` siguen funcionando sin cambios. El binding es opt-in por owner. Sin
  job de migración automático. AC-9 y CD-9 formalizan esta decisión.
