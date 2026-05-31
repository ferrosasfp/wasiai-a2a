# Story File — [WKH-100] wasiai-agentkey: ERC-8004 Identity Binding (Fase 1)

> **Contrato autocontenido para el Dev (F3).** Este es el ÚNICO documento que el Dev
> lee para implementar. Si algo no está acá, no se hace. Derivado de `sdd.md`
> (SPEC_APPROVED) y `work-item.md` (12 ACs EARS + 9 CDs).
>
> **Qué se construye y por qué:** Fase 1 de identidad ERC-8004. El server lee
> (read-only, viem) el `IdentityRegistry` ERC-8004 (ERC-721) en Base, verifica que el
> caller posee el AgentID (`ownerOf(tokenId) == funding_wallet`) y bindea el AgentID a
> su Agent Key escribiendo el JSONB `erc8004_identity`. La misma AgentID que sirve para
> *pagar* (Agent Key) ahora sirve para *descubrir* (AgentCard en `/discover`) vía un
> puente opt-in (`agent_slug` dentro del JSONB + reverse-lookup). El server NUNCA
> mintea ni firma transacciones.

---

## 0. Anti-Hallucination Checklist (LEER ANTES DE CODEAR — OBLIGATORIO)

El Dev **DEBE** cumplir esto. Marcar cada ítem antes de cerrar la wave correspondiente.

- [ ] **[VERIFY-AT-IMPL] ABI ERC-721.** Antes de usar `ownerOf`/`tokenURI`, confirmar
  contra `https://github.com/erc-8004/erc-8004-contracts` (o el explorer de Base para la
  address del registry) que ambas firmas son **idénticas a ERC-721 estándar**:
  `ownerOf(uint256) → address` y `tokenURI(uint256) → string`. Son funciones estándar;
  si difieren (firma no-estándar) → **STOP y escalar al humano**, NO inventes. (DT-3)
- [ ] **[VERIFY-AT-IMPL] Sintaxis filtro JSONB en `@supabase/supabase-js`.** El codebase
  HOY no usa filtros JSONB `->>` ni `.not()`/`.maybeSingle()` en `src/services/`
  (grep: 0 ocurrencias). Antes de codear `resolveIdentityForSlug`, verificar contra la
  versión instalada de `@supabase/supabase-js` cuál de estas formas funciona:
  `.eq('erc8004_identity->>agent_slug', slug)` o
  `.filter('erc8004_identity->>agent_slug', 'eq', slug)`. **Si ninguna funciona como
  espera PostgREST → fallback en JS**: traer candidatas con
  `.not('erc8004_identity', 'is', null).eq('is_active', true)` y filtrar `agent_slug`
  en JS (la defensa de shape `b.agent_slug === slug` ya queda en el código). NO es
  bloqueante; es verificación física. (DT-12 / §1.4.1 SDD)
- [ ] **NO inventar APIs/paths/librerías.** Todos los exemplars de este Story File ya
  están verificados con Read. Si necesitás algo nuevo no listado → `Glob`/`Grep` primero.
- [ ] **viem v2 ONLY** — `createPublicClient`/`readContract`/`http`. CERO `ethers`. (CD-5)
- [ ] **NO tocar budget / RPCs de pago.** No importar `budgetService`. No llamar
  `increment_a2a_key_spend` ni `register_a2a_key_deposit`. (CD-2 / AC-12)
- [ ] **NO enviar tx on-chain.** Sin `WalletClient`, sin `writeContract`, sin
  `privateKeyToAccount`, sin `OPERATOR_PRIVATE_KEY` en `erc8004-identity.ts`. (CD-8)
- [ ] **NO hardcodear** addresses/chainId/RPC/timeout en `src/`. Todo por env. (CD-4/CD-10wk)
- [ ] **NO `Number()` sobre `token_id`/addresses.** Usar `BigInt(token_id)` para el
  `readContract`; comparar addresses con `.toLowerCase()`. (CD-11)
- [ ] **NO `npm run format` global.** Usar `npx biome check --write <archivo-in-scope>`
  archivo por archivo. (CD-12)
- [ ] **TS strict sin `any`** — ABI `as const`, results tipados. `tsc -p tsconfig.build.json`
  debe pasar. (CD-6)
- [ ] **Scope OUT respetado:** sin `POST /auth/erc8004/register` (mint), sin EIP-712 /
  session keys (Fase 2 WKH-101), sin Reputation/Validation Registry (Fase 3), sin RLS.

---

## 1. Orden de waves (W0 PRIMERO, serial)

```
W0  Tipos + ABI-host + env + errores         (serial, contratos)   ── sin deps
W1  Reader on-chain read-only                 depende de W0
W2  Service bind + reverse-lookup             depende de W0
W3  Rutas /auth/erc8004/*                      depende de W1, W2
W4  Middleware lazy flag (identity_verified)   depende de W0
W5  Puente identidad → discovery (AC-8)        depende de W0, W2
W6  Tests unit (≥1 por AC)                     depende de W1-W5
W7  Test integración e2e bind→discover (AC-8)  depende de W1-W5
```

**Regla:** terminar W0 completa antes de empezar W1+. W1/W2/W4 son paralelizables entre
sí tras W0. W3 necesita W1+W2. W5 necesita W2. W6/W7 al final.

---

## 2. CDs aplicables (resumen — detalle en `sdd.md` §4)

| CD | Regla (resumida) |
|---|---|
| **CD-1/CD-4** | Registry address, chainId, RPC URL, timeout → SOLO env. `REGISTRY_NOT_CONFIGURED` si ausente. Sin hex `0x8004…` literal en `src/`. |
| **CD-2** | Identidad desacoplada del budget. Service/handlers NO importan `budgetService`. `resolveIdentityForSlug` hace `.select('erc8004_identity')` — NUNCA `budget`. |
| **CD-3** | Ownership Guard: todo UPDATE sobre `a2a_agent_keys` con `.eq('id', keyId).eq('owner_ref', ownerId)`. 0 rows → `OwnershipMismatchError`. |
| **CD-5** | viem v2 ONLY. Cero `ethers`. |
| **CD-6** | TS strict, sin `any`. ABI `as const`. |
| **CD-7** | Sin backend propietario de identidad. `verified:true` viene del binding `ownerOf`-verificado local, NUNCA del payload del registry externo (anti-spoof). |
| **CD-8** | Server NUNCA mintea/firma. Sin `WalletClient`/`writeContract`/`privateKeyToAccount` en el adapter. |
| **CD-9** | Backward-compat, opt-in, sin migration job. `erc8004_identity = null` válido. |
| **CD-10** (nuevo) | Posesión por owner real: `ownerOf == funding_wallet`. PROHIBIDO bindear con solo `tokenURI` resoluble. |
| **CD-11** (nuevo) | Comparaciones on-chain sin pérdida: `BigInt`/string + lowercase. NUNCA `Number()`. |
| **CD-12** (nuevo) | Lint/format scoped: `biome check --write <file>` por archivo. No `npm run format` global. |
| **CD-13** (nuevo) | Anti-SSRF: PROHIBIDO `fetch`/HTTP server-side al `tokenURI` en Fase 1. Devolver URI cruda. |
| **CD-14** (nuevo) | Distinguir revert (token inexistente → `TOKEN_NOT_FOUND`/404) de fallo transporte (`RPC_UNAVAILABLE`/503). |

---

## 3. error_code taxonomy (exacta — usar literal en los handlers)

| `error_code` | HTTP | Cuándo | AC |
|---|---|---|---|
| `INVALID_INPUT` | 400 | `token_id` no numérico/negativo/vacío/`> 2^256-1`; o `agent_slug` inválido | DT-14 |
| `FUNDING_WALLET_NOT_BOUND` | 400 | `callerKey.funding_wallet` es null. **Sin RPC.** | AC-3 |
| `IDENTITY_OWNERSHIP_MISMATCH` | 403 | `ownerOf(tokenId).toLowerCase() !== funding_wallet.toLowerCase()`. **Sin write.** | AC-4 |
| `OWNERSHIP_MISMATCH` | 403 | UPDATE devuelve 0 rows (Ownership Guard) → `OwnershipMismatchError` | CD-3 |
| `ERC8004_ALREADY_BOUND` | 409 | ya existe `erc8004_identity.token_id` para el mismo `chain_id`. **Sin RPC, sin overwrite.** | AC-5 |
| `ERC8004_TOKEN_NOT_FOUND` | 404 | `ownerOf`/`tokenURI` revierte (token inexistente). reason `TOKEN_NOT_FOUND` del reader. | CD-14 |
| `ERC8004_CHAIN_MISMATCH` | 502 | `getChainId()` del RPC != chainId esperado de la red. reason `CHAIN_MISMATCH`. | CD-14 |
| `RPC_UNAVAILABLE` | 503 | transporte caído / timeout. Body: `{ ok:false, reason:'RPC_UNAVAILABLE' }`. **Sin throw, sin budget.** | AC-11 |
| `REGISTRY_NOT_CONFIGURED` | 503 | env de registry ausente/ inválida (misconfig fail-loud). Body: `{ ok:false, reason:'REGISTRY_NOT_CONFIGURED' }`. | AC-10 |

> Nota: el shape de respuesta de error sigue el patrón del codebase
> (`reply.status(N).send({ error_code: '...' })`, ver `auth.ts:161,198`). Para
> `RPC_UNAVAILABLE`/`REGISTRY_NOT_CONFIGURED` el work-item (AC-11) exige literalmente
> `{ ok:false, reason:'RPC_UNAVAILABLE' }` → enviar ese body además del status.

---

## 4. Env vars (uso exacto)

| Env var | Uso | Default / fallback |
|---|---|---|
| `ERC8004_REGISTRY_ADDRESS_BASE_MAINNET` | address del IdentityRegistry en Base mainnet (8453) | — |
| `ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA` | address del IdentityRegistry en Base Sepolia (84532) | — |
| `ERC8004_REGISTRY_ADDRESS` | fallback global si no hay per-red | — |
| `BASE_MAINNET_RPC_URL` | RPC mainnet (YA existe en `.env.example:441`) | `https://mainnet.base.org` |
| `BASE_TESTNET_RPC_URL` | RPC Sepolia (YA existe en `.env.example:437`) | `https://sepolia.base.org` |
| `BASE_NETWORK` | resuelve mainnet/testnet vía `getBaseNetwork()` (YA existe) | `testnet` |
| `ERC8004_RPC_TIMEOUT_MS` | timeout del transport http | `8000` |

- `resolveRegistryAddress(network)`: per-red → fallback global. Validar contra
  `ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/`. Ausente/inválida → reason `REGISTRY_NOT_CONFIGURED`
  (fail-loud, sin RPC). **CD-1/CD-4: NO hex literal en `src/`.**
- `.env.example`: agregar las 3 vars `ERC8004_REGISTRY_ADDRESS_*` + `ERC8004_RPC_TIMEOUT_MS`
  con comentario documentando Base mainnet/Sepolia. Las addresses canónicas que el operador
  pondrá en su `.env` (NO en código): mainnet `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`,
  Sepolia `0x8004A818BFB912233c491871b3d84c89A494BD9e` (work-item CD-1 — van como
  **comentario de ejemplo** en `.env.example`, jamás como literal en `src/`).

---

## WAVE 0 — Tipos + ABI-host + env + errores (contratos)

**Objetivo:** definir todos los contratos (tipos TS, error classes, env) que las demás
waves consumen. Sin lógica. **Cubre:** DT-4, DT-6, parte de AC-8/AC-9; base de todas.

### Archivos a modificar

**`src/types/a2a-key.ts`**
- Agregar interface `Erc8004IdentityBinding`:
```ts
export interface Erc8004IdentityBinding {
  token_id: string;        // uint256 serializado como string decimal (sin pérdida — CD-11)
  chain_id: number;        // 8453 | 84532
  agent_card_url: string;  // tokenURI resuelto; '' si resolve falló al bindear (DT-15)
  owner_address: string;   // lowercase (== funding_wallet al momento del bind)
  verified_at: string;     // ISO 8601 del verify server-side
  agent_slug?: string;     // AC-8 puente identidad-unificada. Opt-in (DT-20).
}
```
- Re-tipar el campo del row:
  `erc8004_identity: Erc8004IdentityBinding | null;` (reemplaza `Record<string, unknown> | null`, l.24).
- Agregar campo **transient** (NO columna DB, in-memory):
  `erc8004_verified?: boolean;` en `A2AAgentKeyRow` (DT-17).
- En `AgentMeResponse.bindings` (l.92): re-tipar
  `erc8004_identity: Erc8004IdentityBinding | null;` (AC-7 — es asignable a JSON, no rompe).

**`src/types/index.ts`**
- Agregar tipo compartido:
```ts
export interface AgentCardIdentity {
  erc8004_token_id: string;  // = token_id del binding
  chain_id: number;          // 8453 | 84532
  verified: true;            // literal: solo se surfacea si verificado on-chain
}
```
- `AgentCard` (l.491-526): agregar campo opcional top-level `identity?: AgentCardIdentity;`
  (mismo patrón no-breaking que `inputSchema?`/`outputSchema?`).
- `Agent` (l.118-135): agregar `identity?: AgentCardIdentity;` (opcional, omitido cuando ausente).

**`src/services/security/errors.ts`** — agregar 4 error classes (patrón l.9-15):
```ts
export class Erc8004AlreadyBoundError extends Error {
  readonly code = 'ERC8004_ALREADY_BOUND' as const;
  constructor() { super('ERC-8004 identity already bound'); this.name = 'Erc8004AlreadyBoundError'; }
}
export class Erc8004TokenNotFoundError extends Error {
  readonly code = 'ERC8004_TOKEN_NOT_FOUND' as const;
  constructor() { super('ERC-8004 token not found'); this.name = 'Erc8004TokenNotFoundError'; }
}
export class Erc8004ChainMismatchError extends Error {
  readonly code = 'ERC8004_CHAIN_MISMATCH' as const;
  constructor() { super('ERC-8004 chain mismatch'); this.name = 'Erc8004ChainMismatchError'; }
}
export class IdentityOwnershipMismatchError extends Error {
  readonly code = 'IDENTITY_OWNERSHIP_MISMATCH' as const;
  constructor() { super('ownerOf does not match funding_wallet'); this.name = 'IdentityOwnershipMismatchError'; }
}
```
> Nota: estas error classes son opcionales como vehículo — el handler puede mapear los
> `reason` del reader directamente a status+error_code sin lanzarlas. Crearlas igual
> para consistencia con el codebase y reuso en tests. **NO modificar el union `OwnershipOp`**
> (DT-13: `bindErc8004Identity` reusa el label `'deactivate'`).

**`.env.example`** — agregar el bloque de env de §4 (ver arriba), tras el bloque Base
existente (l.434-465).

### Done de W0
- `tsc -p tsconfig.build.json` pasa (los nuevos tipos compilan, sin `any`).
- `biome check --write` sobre cada archivo tocado (scoped — CD-12).
- Sin lógica nueva; solo contratos.

---

## WAVE 1 — Reader on-chain read-only

**Objetivo:** módulo independiente env-driven (estilo `deposit-verifier.ts`), read-only.
**Cubre:** AC-1 (lectura), AC-2 (lectura), AC-10, AC-11; CD-5/CD-8/CD-13/CD-14.

### Archivo a crear: `src/adapters/erc8004-identity.ts`

**Imports:** `import type { Chain, PublicClient } from 'viem'; import { createPublicClient, http } from 'viem'; import { getBaseChain, getBaseNetwork } from './base/chain.js';`
**PROHIBIDO** importar `privateKeyToAccount`, `WalletClient`, `writeContract` (CD-8).

**Tipos del result (definir en este archivo):**
```ts
export type Erc8004ReadReason =
  | 'RPC_UNAVAILABLE'         // transporte caído / timeout
  | 'REGISTRY_NOT_CONFIGURED' // address de registry ausente o inválida
  | 'TOKEN_NOT_FOUND'         // ownerOf/tokenURI revierte (token inexistente)
  | 'CHAIN_MISMATCH';         // getChainId() != chainId esperado de la red

export interface Erc8004VerifyResult {
  ok: boolean;
  reason?: Erc8004ReadReason;
  owner?: `0x${string}`;   // ownerOf(tokenId)
  matches?: boolean;       // owner.toLowerCase() === expectedOwner.toLowerCase()
  chainId?: number;
}
export interface Erc8004ResolveResult {
  ok: boolean;
  reason?: Erc8004ReadReason;
  tokenUri?: string;       // tokenURI crudo (ipfs:// | https:// | data:)
  chainId?: number;
}
```

**ABI mínimo ERC-721 (inline `as const` — patrón `gasless.ts:219-227`):**
```ts
const ERC8004_REGISTRY_ABI = [
  { name: 'ownerOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }] },
  { name: 'tokenURI', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }] },
] as const;
```
> **[VERIFY-AT-IMPL]** confirmar estas firmas contra `erc-8004-contracts` (checklist §0).

**Helpers (env-driven, sin hardcodes):**
```ts
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
type BaseNet = 'mainnet' | 'testnet';

function resolveRegistryAddress(network: BaseNet): `0x${string}` | null {
  const perNet = network === 'mainnet'
    ? process.env.ERC8004_REGISTRY_ADDRESS_BASE_MAINNET
    : process.env.ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA;
  const raw = perNet ?? process.env.ERC8004_REGISTRY_ADDRESS;
  if (raw && ADDRESS_RE.test(raw)) return raw as `0x${string}`;
  return null; // → REGISTRY_NOT_CONFIGURED
}
function resolveRpcUrl(network: BaseNet): string | undefined {
  return network === 'mainnet'
    ? process.env.BASE_MAINNET_RPC_URL
    : process.env.BASE_TESTNET_RPC_URL;
}
function resolveTimeoutMs(): number {
  const raw = process.env.ERC8004_RPC_TIMEOUT_MS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 8000;
}
```

**Lazy client cache propio (NO compartir con deposit-verifier — DT-7):**
```ts
const _clients = new Map<'base-mainnet' | 'base-sepolia', PublicClient>();
function getReaderClient(network: BaseNet): PublicClient | null {
  const key = network === 'mainnet' ? 'base-mainnet' : 'base-sepolia';
  const cached = _clients.get(key);
  if (cached) return cached;
  const rpcUrl = resolveRpcUrl(network);
  if (!rpcUrl) return null;
  const client = createPublicClient({
    chain: getBaseChain(network) as Chain,
    transport: http(rpcUrl, { timeout: resolveTimeoutMs() }),
  }) as PublicClient;
  _clients.set(key, client);
  return client;
}
/** TEST-ONLY — limpia el cache (patrón _resetVerifier). */
export function _resetErc8004Reader(): void { _clients.clear(); }
```

**Interfaz + API pública (`Erc8004IdentityReader` — interfaz nueva, DT-11):**
```ts
export interface Erc8004IdentityReader {
  verifyOwnership(args: { tokenId: bigint; expectedOwner: string }): Promise<Erc8004VerifyResult>;
  resolve(args: { tokenId: bigint }): Promise<Erc8004ResolveResult>;
}
export function getErc8004Reader(): Erc8004IdentityReader;
```
**Lógica `verifyOwnership`:**
1. `network = getBaseNetwork()`. `expectedChainId = network==='mainnet' ? 8453 : 84532`.
2. `if (!resolveRegistryAddress(network))` → `{ ok:false, reason:'REGISTRY_NOT_CONFIGURED' }`.
3. `const client = getReaderClient(network); if (!client)` → `{ ok:false, reason:'RPC_UNAVAILABLE' }`.
4. (opcional defensivo) `getChainId()` en try/catch; si `!== expectedChainId` → `{ ok:false, reason:'CHAIN_MISMATCH' }`. Si la llamada de chainId falla por transporte → `RPC_UNAVAILABLE`.
5. `readContract({ address, abi: ERC8004_REGISTRY_ABI, functionName:'ownerOf', args:[tokenId] })` en try/catch:
   - reverte (viem `ContractFunctionExecutionError`/`ContractFunctionRevertedError`) → `{ ok:false, reason:'TOKEN_NOT_FOUND' }` (**CD-14**: distinguir de transporte).
   - error de transporte → `{ ok:false, reason:'RPC_UNAVAILABLE' }`.
6. `owner = result` (viem devuelve `0x…` checksummed); `matches = owner.toLowerCase() === expectedOwner.toLowerCase()` (**CD-11**, case-insensitive — DT-5).
7. return `{ ok:true, owner, matches, chainId: expectedChainId }`.

**Lógica `resolve`:** misma resolución de network/registry/client; `readContract` con
`functionName:'tokenURI'`. Revert → `TOKEN_NOT_FOUND`. Transporte → `RPC_UNAVAILABLE`.
OK → `{ ok:true, tokenUri, chainId }`. **NO hacer fetch del URI (CD-13).**

**Reglas:** NUNCA `throw` hacia el handler para fallos esperados (siempre result tipado).
`tokenId` SIEMPRE entra como `bigint` (el handler ya validó+convirtió). Sin estado mutable
salvo el `Map` lazy.

### Done de W1
- `tsc` pasa, sin `any`. `biome check --write src/adapters/erc8004-identity.ts`.
- Sin imports prohibidos (grep `WalletClient|writeContract|privateKeyToAccount|ethers` → 0).
- Tests de W6 (`erc8004-identity.test.ts`) verdes para AC-2/AC-10/AC-11 + revert vs transporte.

---

## WAVE 2 — Service: bind + reverse-lookup + helper

**Objetivo:** persistencia con Ownership Guard + reverse-lookup público para discovery.
**Cubre:** AC-1 (write), AC-6 (helper), AC-8 (resolver); CD-2/CD-3/DT-19.

### Archivo a modificar: `src/services/identity.ts`

**Imports nuevos:** agregar `Erc8004AlreadyBoundError` (si se usa), tipos
`Erc8004IdentityBinding` (de `../types/index.js` o `../types/a2a-key.js` según re-export),
`AgentCardIdentity`. **NO importar `budgetService`** (CD-2).

**Método 1 — `bindErc8004Identity` (calcado de `bindFundingWallet`, l.110-138):**
```ts
async bindErc8004Identity(
  keyId: string,
  ownerId: string,
  binding: Erc8004IdentityBinding,  // ya validado por el handler
): Promise<Erc8004IdentityBinding> {
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .update({ erc8004_identity: binding })   // escribe el JSONB completo; NO toca budget (CD-2)
    .eq('id', keyId)
    .eq('owner_ref', ownerId)                // Ownership Guard COMPLETO (CD-3)
    .select('id');
  if (error) throw new Error(`Failed to bind erc8004 identity: ${error.message}`);
  if (!data || data.length === 0) {
    logOwnershipMismatch('deactivate', keyId, ownerId); // DT-13: reusa label existente
    throw new OwnershipMismatchError();
  }
  return binding;
}
```
- NO re-consulta idempotencia (eso es del handler, DT-8). NO menciona `budget`/
  `increment_a2a_key_spend`/`register_a2a_key_deposit` (CD-2/AC-12).

**Método 2 — `resolveIdentityForSlug` (reverse-lookup PÚBLICO, sin Ownership Guard — DT-19):**
```ts
async resolveIdentityForSlug(slug: string): Promise<AgentCardIdentity | null> {
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .select('erc8004_identity')                 // SOLO esta columna — NUNCA budget (CD-2/DT-19)
    .eq('erc8004_identity->>agent_slug', slug)  // [VERIFY-AT-IMPL] filtro JSONB (checklist §0)
    .not('erc8004_identity', 'is', null)
    .eq('is_active', true)                       // solo keys activas surfacean
    .limit(1)
    .maybeSingle();
  if (error || !data?.erc8004_identity) return null;
  const b = data.erc8004_identity as Erc8004IdentityBinding;
  if (!b.agent_slug || b.agent_slug !== slug) return null; // defensa de shape
  return { erc8004_token_id: b.token_id, chain_id: b.chain_id, verified: true };
}
```
- **DT-19 / nota para AR/CR:** este SELECT NO lleva `.eq('owner_ref', ...)` **a propósito**.
  Es lectura PÚBLICA por `agent_slug` (no por `keyId` del caller) y devuelve SOLO
  `{ token_id, chain_id, verified }` — datos públicamente verificables on-chain. NO trae
  `budget`/`funding_wallet`/PII. **NO es IDOR.** No marcar como falso-positivo contra la
  regla de Ownership Guard de CLAUDE.md.
- **[VERIFY-AT-IMPL]:** si el filtro JSONB `->>` no funciona en la versión instalada de
  `@supabase/supabase-js`, aplicar el fallback en JS (checklist §0): traer candidatas con
  `.not('erc8004_identity','is',null).eq('is_active',true)` y filtrar `agent_slug === slug`
  en JS. La defensa de shape ya cubre el match.

**Método/función 3 — helper `isIdentityVerified` (AC-6, export desde este archivo):**
```ts
export function isIdentityVerified(row: Pick<A2AAgentKeyRow, 'erc8004_identity'>): boolean {
  return row.erc8004_identity != null;
}
```
- Puro, sin RPC. Derivado de `erc8004_identity != null` (DT-17).

### Done de W2
- `tsc` pasa, sin `any`. `biome check --write src/services/identity.ts`.
- grep en `identity.ts`: 0 ocurrencias de `budgetService`/`increment_a2a_key_spend`/
  `register_a2a_key_deposit`/`funding_wallet` en el SELECT del reverse-lookup (CD-2).
- Tests W6 verdes: bind OK, Ownership Guard 0-rows, resolver match/no-match/inactive/
  sin-agent_slug, assert SELECT solo trae `erc8004_identity`.

---

## WAVE 3 — Rutas `/auth/erc8004/*`

**Objetivo:** endpoints REST montados bajo prefix `/auth` (index.ts:121).
**Cubre:** AC-1, AC-2, AC-3, AC-4, AC-5, AC-11, AC-12; CD-2/CD-13/CD-14/DT-14/DT-15/DT-16.

### Archivo a modificar: `src/routes/auth.ts`

**Imports nuevos:** `getErc8004Reader` de `../adapters/erc8004-identity.js`;
las error classes ERC-8004 de `../services/security/errors.js` (si se usan); tipo
`Erc8004IdentityBinding`. **NO importar `budgetService`** (CD-2/AC-12).

**Helper de validación de `token_id` (DT-14, en el archivo):**
```ts
const TOKEN_ID_RE = /^[0-9]+$/;
const UINT256_MAX = (1n << 256n) - 1n;
function parseTokenId(raw: unknown): bigint | null {
  let s: string;
  if (typeof raw === 'string') s = raw.trim();
  else if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) s = String(raw);
  else return null;
  if (s === '' || !TOKEN_ID_RE.test(s)) return null;  // CD-11: NUNCA Number()
  let v: bigint;
  try { v = BigInt(s); } catch { return null; }
  if (v < 0n || v > UINT256_MAX) return null;
  return v;
}
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
```

**Endpoint A — `POST /erc8004/bind`** (AC-1/AC-3/AC-4/AC-5/AC-11/AC-12). Pasos exactos:
```
1. callerKey = await resolveCallerKey(req); if (!callerKey?.is_active) → 403 { error:'Invalid or inactive API key' }
2. body = req.body as { token_id?: unknown; agent_slug?: unknown } | undefined
   tokenId = parseTokenId(body?.token_id); if (tokenId === null) → 400 { error_code:'INVALID_INPUT' }
2b. agent_slug OPCIONAL: si body.agent_slug presente:
      typeof string && SLUG_RE.test(trim) → usar trim; si no → 400 INVALID_INPUT
    ausente → binding sin agent_slug (no surfacea en discovery — DT-20)
3. if (!callerKey.funding_wallet) → 400 { error_code:'FUNDING_WALLET_NOT_BOUND' }  // SIN RPC (AC-3)
4. network = getBaseNetwork(); expectedChainId = network==='mainnet'?8453:84532
   IDEMPOTENCIA (AC-5/DT-8, SIN RPC, leyendo callerKey.erc8004_identity ya en el row):
   const existing = callerKey.erc8004_identity;
   if (existing && existing.token_id === tokenId.toString() && existing.chain_id === expectedChainId)
      → 409 { error_code:'ERC8004_ALREADY_BOUND' }   // sin overwrite
5. reader = getErc8004Reader();
   v = await reader.verifyOwnership({ tokenId, expectedOwner: callerKey.funding_wallet })
   if (!v.ok) switch (v.reason):
     'RPC_UNAVAILABLE'         → 503 { ok:false, reason:'RPC_UNAVAILABLE' }       (AC-11)
     'REGISTRY_NOT_CONFIGURED' → 503 { ok:false, reason:'REGISTRY_NOT_CONFIGURED' }
     'TOKEN_NOT_FOUND'         → 404 { error_code:'ERC8004_TOKEN_NOT_FOUND' }
     'CHAIN_MISMATCH'          → 502 { error_code:'ERC8004_CHAIN_MISMATCH' }
   if (v.ok && !v.matches) → 403 { error_code:'IDENTITY_OWNERSHIP_MISMATCH' }    (AC-4, SIN write)
6. r = await reader.resolve({ tokenId })
   agent_card_url = (r.ok && r.tokenUri) ? r.tokenUri : ''   // DT-15: no bloquear bind por tokenURI vacío
7. binding: Erc8004IdentityBinding = {
     token_id: tokenId.toString(),          // string decimal (CD-11)
     chain_id: expectedChainId,
     agent_card_url,
     owner_address: callerKey.funding_wallet.toLowerCase(),
     verified_at: new Date().toISOString(),
     ...(agent_slug && { agent_slug }),      // AC-8 opt-in (DT-20)
   }
8. try { await identityService.bindErc8004Identity(callerKey.id, callerKey.owner_ref, binding) }
   catch (err) {
     if (err instanceof OwnershipMismatchError) → 403 { error_code:'OWNERSHIP_MISMATCH' }
     log + 500 { error_code:'ERC8004_BIND_FAILED' }
   }
9. → 200 { erc8004_identity: binding }
```
- **CD-2/AC-12:** este handler NUNCA llama budget. Sin debit, sin credit.

**Endpoint B — `GET /erc8004/resolve/:token_id`** (AC-2/AC-11). **Auth pública** (lectura
on-chain, consistente con `GET /deposit-info`, auth.ts:371). Pasos:
```
1. tokenId = parseTokenId(req.params.token_id); if (null) → 400 { error_code:'INVALID_INPUT' }
2. r = await getErc8004Reader().resolve({ tokenId })
   if (!r.ok) switch (r.reason):
     'RPC_UNAVAILABLE'         → 503 { ok:false, reason:'RPC_UNAVAILABLE' }
     'REGISTRY_NOT_CONFIGURED' → 503 { ok:false, reason:'REGISTRY_NOT_CONFIGURED' }
     'TOKEN_NOT_FOUND'         → 404 { error_code:'ERC8004_TOKEN_NOT_FOUND' }
     'CHAIN_MISMATCH'          → 502 { error_code:'ERC8004_CHAIN_MISMATCH' }
3. scheme handling SIN fetch (CD-13/DT-16):
   if (/^https?:\/\//i.test(r.tokenUri)) →
      200 { token_id: tokenId.toString(), chain_id: r.chainId, agent_card_url: r.tokenUri, url: r.tokenUri, raw: null }
   else (ipfs: / data: / otro) →
      200 { token_id: tokenId.toString(), chain_id: r.chainId, agent_card_url: r.tokenUri, scheme: <prefijo-antes-de-':'> }
```
- **PROHIBIDO `fetch` server-side del `tokenUri`** (CD-13, anti-SSRF). Devolver la URI cruda.

### Done de W3
- `tsc` pasa, sin `any`. `biome check --write src/routes/auth.ts`.
- grep en el bloque erc8004 de `auth.ts`: 0 `budgetService`/`fetch(`/`writeContract`.
- Tests W6 (`auth.erc8004.test.ts`) verdes para AC-1/2/3/4/5/11/12 + casos de error DT-14/15/16.

---

## WAVE 4 — Middleware lazy flag `identity_verified` (AC-6)

**Objetivo:** exponer `erc8004_verified` derivado en el row in-memory, SIN RPC. **Cubre:** AC-6.

### Archivos a modificar

**`src/middleware/a2a-key.ts`** — tras `request.a2aKeyRow = keyRow;` (l.284):
```ts
keyRow.erc8004_verified = isIdentityVerified(keyRow); // AC-6, derivado, sin RPC (DT-17)
request.a2aKeyRow = keyRow;
```
Import: `import { isIdentityVerified } from '../services/identity.js';`

**`src/routes/auth.ts`** — en `resolveCallerKey` (l.57-…), antes de devolver el `callerKey`
resuelto, setear `callerKey.erc8004_verified = isIdentityVerified(callerKey)` (si no-null).
(El tipo `erc8004_verified?: boolean` ya se agregó en W0.)

**`src/services/identity.ts`** — `isIdentityVerified` ya creado en W2 (export).

### Done de W4
- `tsc` pasa. `biome check --write` sobre los 2 archivos.
- Sin RPC nuevo por request (grep: no `readContract`/`createPublicClient` en el middleware).
- Test W6: row con `erc8004_identity != null` → `erc8004_verified === true`; null → `false`.

---

## WAVE 5 — Puente identidad → discovery (AC-8 end-to-end)

**Objetivo:** surfacear `identity` en AgentCard (`/agents/:slug/agent-card`) y en el `Agent`
de `/discover`. **Cubre:** AC-8 (card + resolver + enrich), AC-9 (backward-compat); CD-2/CD-7.

### Archivos a modificar

**`src/services/agent-card.ts`** — `buildAgentCard` gana 4º arg opcional:
```ts
buildAgentCard(
  agent: Agent,
  registryConfig: RegistryConfig,
  baseUrl: string,
  identity?: AgentCardIdentity,   // NUEVO, opcional (resuelto por el route ANTES de llamar)
): AgentCard {
  ...
  return {
    ...,
    ...(inputSchema !== undefined && { inputSchema }),
    ...(outputSchema !== undefined && { outputSchema }),
    ...(identity !== undefined && { identity }),   // spread condicional, no-breaking (DT-6)
  };
}
```
Import: `AgentCardIdentity` de `../types/index.js`.

**`src/routes/agent-card.ts`** — resolver + inyectar antes de `buildAgentCard` (l.46-51):
```ts
import { identityService } from '../services/identity.js';
...
const identity = await identityService.resolveIdentityForSlug(agent.slug);
const card = agentCardService.buildAgentCard(
  agent, registryConfig, baseUrl, identity ?? undefined,
);
```

**`src/services/discovery.ts`** — enrich batch post-limit (DT-18):
- En `discover()`, justo antes del `return` (l.210), sobre `limited` (l.208):
```ts
const enriched = await this.attachIdentities(limited);
return { agents: enriched, total: allAgents.length, registries: registries.map((r) => r.name) };
```
- En `getAgent()` (l.336-375), antes de `return this.mapAgent(...)`: resolver identidad para
  el slug y setear `agent.identity` (un solo lookup) antes de devolver.
- Nuevo método privado/helper `attachIdentities`:
```ts
async attachIdentities(agents: Agent[]): Promise<Agent[]> {
  await Promise.all(agents.map(async (a) => {
    try {
      const identity = await identityService.resolveIdentityForSlug(a.slug);
      if (identity) a.identity = identity;       // omitido si null (AC-9/CD-9)
    } catch { /* falla DB → ese agent sin identity, NO rompe discover (DT-18) */ }
  }));
  return agents;
}
```
Import: `import { identityService } from './identity.js';`
- **Sin RPC al servir discovery** (CD-8 — el verify ya ocurrió al bindear). Solo el SELECT
  JSONB del resolver (W2).

### Done de W5
- `tsc` pasa. `biome check --write` sobre los 3 archivos.
- Backward-compat: agente sin key-identity → `identity` AUSENTE (no `null`) en AgentCard/Agent.
- Tests W6: `buildAgentCard` con/sin identity; `discover()`/`getAgent()` enrich; falla DB graciosa.

---

## WAVE 6 — Tests unit (≥1 por AC)

**Objetivo:** ≥1 test por AC (12) + sub-tests AC-8 + casos de error. Mock `publicClient`
(viem) y `supabase`, mismo estilo que `deposit-verifier.test.ts` (mock con
`vi.mock('viem', ...)` preservando lo real + `vi.fn()` para `readContract`/`getChainId`).
**CI determinista — NO red real.**

### Archivos

**`src/adapters/erc8004-identity.test.ts`** (nuevo) — mock viem:
- AC-2: `tokenURI` https → result `{ ok, tokenUri:'https://…' }`; ipfs → `{ ok, tokenUri:'ipfs://…' }`.
- AC-10: sin env `ERC8004_REGISTRY_ADDRESS*` → `{ ok:false, reason:'REGISTRY_NOT_CONFIGURED' }`.
- AC-11: `readContract` rejects (transporte) → `{ ok:false, reason:'RPC_UNAVAILABLE' }`, sin throw.
- CD-14: revert (mock `readContract` lanza `ContractFunctionExecutionError`) → `TOKEN_NOT_FOUND` (no RPC).
- AC-4 base: `ownerOf` != expectedOwner → `{ ok:true, matches:false }`.
- `getChainId()` != esperado → `CHAIN_MISMATCH`.
- `_resetErc8004Reader()` en `afterEach`; env set/clear por test.

**`src/routes/auth.erc8004.test.ts`** (nuevo) — mock reader + supabase + spy budget:
- AC-1: bind OK → 200, body `erc8004_identity` con shape exacto (token_id string, chain_id,
  owner_address lowercase, verified_at ISO, agent_slug si enviado). supabase update → 1 row.
- AC-2: `GET /resolve/:token_id` https → `{ url, raw:null }`; ipfs → `{ scheme:'ipfs' }`.
- AC-3: `funding_wallet` null → 400 `FUNDING_WALLET_NOT_BOUND`; **spy: reader NO invocado**.
- AC-4: `ownerOf != funding_wallet` → 403 `IDENTITY_OWNERSHIP_MISMATCH`; supabase update NO llamado.
- AC-5: row con identity (mismo token_id+chain_id) → 409 `ERC8004_ALREADY_BOUND`; **reader NO invocado, sin overwrite**.
- AC-7: `GET /me` → `bindings.erc8004_identity` con `verified_at` (row con binding).
- AC-9: key con `erc8004_identity=null` autentica/debita igual (reuso suite middleware).
- AC-11: reader devuelve `RPC_UNAVAILABLE` en bind y resolve → 503 `{ ok:false, reason:'RPC_UNAVAILABLE' }`; sin throw.
- AC-12: **spies sobre `budgetService.*`/`increment_a2a_key_spend`/`register_a2a_key_deposit` → 0 calls** durante el bind.
- DT-14: `token_id` no-numérico/negativo/vacío/`>uint256max` → 400 `INVALID_INPUT`.
- DT-15: `ownerOf` OK pero `resolve` falla → bind con `agent_card_url:''`.
- CD-3: UPDATE 0 rows → 403 `OWNERSHIP_MISMATCH`.
- DT-5: `ownerOf` checksummed vs funding_wallet lowercase → match.

**`src/services/agent-card.test.ts`** (extensión, harness l.39-60):
- AC-8 (card): `buildAgentCard(agent, cfg, url, identity)` emite `identity:{...}`; sin 4º arg → sin campo.

**`src/services/discovery.test.ts`** (extensión) — mock fetch + supabase:
- AC-8 (resolver): `resolveIdentityForSlug(slug)` con row `erc8004_identity.agent_slug===slug` &
  `is_active=true` → `{erc8004_token_id, chain_id, verified:true}`; sin match / inactive /
  sin `agent_slug` → `null`. **Assert: el SELECT pide SOLO `erc8004_identity` (no `budget`/`funding_wallet`)** (CD-2/DT-19).
- AC-8 (enrich): `discover()`/`getAgent()` setean `Agent.identity` cuando hay match; sin
  match → campo ausente; falla DB en un lookup → ese agent sin identity, discover NO rompe.

### Done de W6
- `npx vitest run` (o el runner del repo) verde para todos los archivos nuevos/extendidos.
- `tsc` pasa. `biome check --write` por archivo de test tocado.

---

## WAVE 7 — Test integración e2e identidad-unificada (AC-8)

**Objetivo:** probar el puente bind → discover end-to-end. **Cubre:** AC-8 (e2e), AC-9.

### Archivo a crear: `src/__tests__/erc8004-identity-bridge.e2e.test.ts`

Mock RPC (reader: `ownerOf` = funding_wallet, `tokenURI` = una URL) + supabase row real-shape
+ registry mock (para que `discover`/`getAgent` devuelvan un `Agent` con el `slug` bindeado).

Casos:
1. **Bind con `agent_slug`:** `POST /auth/erc8004/bind` con `{ token_id, agent_slug:'foo' }`
   (funding_wallet = ownerOf) → 200; persiste `erc8004_identity` con `agent_slug:'foo'`.
2. **Surfacing en agent-card:** `GET /agents/foo/agent-card` →
   `identity:{ erc8004_token_id, chain_id, verified:true }` presente.
3. **Surfacing en discover:** `GET /discover` y `POST /discover` → el `Agent` con `slug:'foo'`
   trae `identity:{...verified:true}`.
4. **Backward-compat (AC-9):** agente sin key-identity (otro slug) → `identity` AUSENTE.

### Done de W7
- `npx vitest run src/__tests__/erc8004-identity-bridge.e2e.test.ts` verde.
- `tsc` pasa. `biome check --write` del archivo.

---

## 5. Definition of Done global (toda la HU)

- [ ] W0-W7 completas en orden; cada wave con su Done cumplido.
- [ ] `tsc -p tsconfig.build.json` limpio (sin `any`, sin errores).
- [ ] `npx biome check --write` sobre **cada** archivo in-scope (scoped — CD-12). Lint clean.
- [ ] `npx vitest run` verde para los archivos nuevos/extendidos (≥1 test por AC + e2e).
- [ ] grep CD-checks: sin hex `0x8004…` literal en `src/`; sin `ethers`; sin `writeContract`/
  `WalletClient`/`privateKeyToAccount` en `erc8004-identity.ts`; sin `budgetService` ni
  `increment_a2a_key_spend`/`register_a2a_key_deposit` en los handlers/service de esta HU;
  sin `fetch(` del `tokenUri` en la ruta resolve.
- [ ] `.env.example` documenta las 3 `ERC8004_REGISTRY_ADDRESS_*` + `ERC8004_RPC_TIMEOUT_MS`.
- [ ] Backward-compat: rutas existentes intactas con `erc8004_identity = null` (AC-9/CD-9).
- [ ] Anti-Hallucination Checklist (§0) totalmente marcado, incl. ambos `[VERIFY-AT-IMPL]`.
- [ ] NO se tocaron: `src/adapters/base/identity.ts`, `src/adapters/base/index.ts`,
  `src/adapters/registry.ts`, `src/adapters/types.ts` (DT-10/DT-11 — desviación de scope
  ya validada en SPEC_APPROVED).

---

## 6. Archivos in-scope (lista exhaustiva — el Dev SOLO toca estos)

| Wave | Archivo | Acción |
|---|---|---|
| W0 | `src/types/a2a-key.ts` | modificar (interface + re-tipar + transient field) |
| W0 | `src/types/index.ts` | modificar (`AgentCardIdentity`, `AgentCard.identity?`, `Agent.identity?`) |
| W0 | `src/services/security/errors.ts` | modificar (4 error classes; NO tocar `OwnershipOp`) |
| W0 | `.env.example` | modificar (env vars ERC-8004) |
| W1 | `src/adapters/erc8004-identity.ts` | **crear** |
| W2 | `src/services/identity.ts` | modificar (bind + resolver + helper) |
| W3 | `src/routes/auth.ts` | modificar (2 endpoints + validador token_id) |
| W4 | `src/middleware/a2a-key.ts` | modificar (set `erc8004_verified`) |
| W4 | `src/routes/auth.ts` | modificar (`resolveCallerKey` set flag) |
| W5 | `src/services/agent-card.ts` | modificar (4º arg `identity?`) |
| W5 | `src/routes/agent-card.ts` | modificar (resolver+inyectar) |
| W5 | `src/services/discovery.ts` | modificar (`attachIdentities` + `discover`/`getAgent`) |
| W6 | `src/adapters/erc8004-identity.test.ts` | **crear** |
| W6 | `src/routes/auth.erc8004.test.ts` | **crear** |
| W6 | `src/services/agent-card.test.ts` | modificar (extensión) |
| W6 | `src/services/discovery.test.ts` | modificar (extensión) |
| W7 | `src/__tests__/erc8004-identity-bridge.e2e.test.ts` | **crear** |

**FUERA de scope (NO tocar):** `src/adapters/base/identity.ts`, `src/adapters/base/index.ts`,
`src/adapters/registry.ts`, `src/adapters/types.ts`, cualquier archivo de budget/pago.

---

# FIX-PACK POST-AR — BLQ-MED-1 (identity-badge spoofing) — DT-21

> **CONTRATO DEL FIX. Esto SUPERSEDE las partes del Story File anteriores que
> resuelvan identidad por `agent_slug`.** El AR marcó BLOQUEANTE: el `verified:true`
> de discovery se podía falsificar declarando el `agent_slug` de otro agente en el
> body del bind. El fix lo cierra resolviendo por **`token_id` declarado on-chain por
> el propio agente**, no por slug aseverado por el caller. Lee el ADDENDUM DT-21 del
> `sdd.md` (§3.bis) para el detalle de diseño. Ref completa: `sdd.md` DT-21.0..21.8.

## FP.0 El bug (qué NO debe seguir pasando)

- `src/routes/auth.ts:463-474` toma `agent_slug` del body, valida solo forma (regex),
  NUNCA prueba que el caller controle ese slug; `:545` lo persiste.
- `src/services/identity.ts:206-229` (`resolveIdentityForSlug`) empareja por
  `b.agent_slug === slug` → `verified:true` sale de un dato aseverado por el caller.
- `src/services/discovery.ts:228-240` (`attachIdentities`) y `:398-402` (`getAgent`)
  llaman `resolveIdentityForSlug(agent.slug)`.

Ataque: atacante bindea SU token (ownerOf==su funding_wallet ✓) declarando el
`agent_slug` de Acme → el card/discover de Acme muestran `verified:true` con el token
del atacante. Sin unicidad de slug → poisoning. **Esto debe quedar imposible.**

## FP.1 Anti-Hallucination del fix (LEER, marcar antes de cerrar)

- [ ] **[VERIFY-AT-IMPL] Campo `registrations` del AgentCard (A2A/ERC-8004).** El
  codebase HOY no referencia `registrations`/`trustModels`/CAIP-10 (grep: 0 en `src/`).
  NO inventes el estándar. Implementá `extractDeclaredTokenId` leyendo `agent.metadata`
  con el orden de FP.3 y **DEFAULT SEGURO: sin declaración parseable → `null` → SIN
  badge**. Si confirmás contra el estándar real una forma distinta del `agentId` CAIP-10,
  ajustá el parser pero mantené el default seguro.
- [ ] **`token_id` SIEMPRE string decimal** — nunca `Number()` (CD-11). El parser
  CAIP-10 valida `^[0-9]+$` sobre el segmento tokenId.
- [ ] **grep `resolveIdentityForSlug`** en TODO el repo (src + tests + mocks) ANTES de
  renombrar/eliminar el export. Hay mocks con factory manual (`vi.mock(..., () => ({
  identityService: {...} }))`) que rompen si el export desaparece sin actualizar el mock
  (lección Auto-Blindaje Wave 4). Actualizá `auth.test.ts`, `a2a-key.test.ts`,
  `erc8004-identity-bridge.e2e.test.ts` y cualquier otro que mockee `identity.js`.
- [ ] **No fetch del registry/tokenURI en serve-time** (CD-13): `extractDeclaredTokenId`
  solo lee `agent.metadata` ya en memoria.
- [ ] **`.select('erc8004_identity')` only** en el resolver y en el pre-check de unicidad
  (CD-2: nunca `budget`/`funding_wallet`).

## FP.2 `src/services/identity.ts` — reemplazar resolver + unicidad en bind

1. **Eliminar/deprecate `resolveIdentityForSlug`** (l.206-229). Crear en su lugar:

```ts
// Reverse-lookup PÚBLICO por token_id (DT-21.3). NO Ownership Guard (DT-19 sigue
// aplicando: no es IDOR — sin keyId del caller; expone SOLO {token_id,chain_id,verified}).
async resolveIdentityForToken(
  tokenId: string,
  chainId: number,
): Promise<AgentCardIdentity | null> {
  // [VERIFY-AT-IMPL] intentá primero filtro server-side por igualdad indexable:
  //   .eq('erc8004_identity->>token_id', tokenId).eq('erc8004_identity->>chain_id', String(chainId))
  // si la versión de PostgREST no lo soporta como esperás → fallback JS (abajo).
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .select('erc8004_identity')      // SOLO esta columna (CD-2)
    .eq('is_active', true)
    .not('erc8004_identity', 'is', null);
  if (error || !data) return null;
  for (const row of data as Array<{ erc8004_identity: Erc8004IdentityBinding | null }>) {
    const b = row.erc8004_identity;
    if (!b) continue;
    if (b.token_id === tokenId && b.chain_id === chainId) {
      return { erc8004_token_id: b.token_id, chain_id: b.chain_id, verified: true };
    }
  }
  return null;
}
```

2. **Unicidad token↔key activa** (DT-21.6). En `bindErc8004Identity` (o pre-check en el
   handler antes del UPDATE): antes de persistir, verificar que NO exista OTRA key activa
   (`id != keyId`) con el MISMO `token_id`+`chain_id`. Si existe → lanzar
   `Erc8004TokenAlreadyBoundError`. El re-bind del MISMO owner sobre su MISMA key (AC-5)
   NO colisiona (mismo `id`). Implementación sugerida (lectura `.select('id')` filtrando
   por igualdad de token + `is_active` + `neq('id', keyId)`); si agregás el índice parcial
   UNIQUE, mapeá `error.code === '23505'` → `Erc8004TokenAlreadyBoundError` (igual que
   `bindFundingWallet`, identity.ts:142). Mantené el pre-check app-layer igual (defensa en
   profundidad).

## FP.3 `src/services/discovery.ts` — `extractDeclaredTokenId` + usar token, no slug

1. Helper local (junto a `readPayment`/`mapAgent`):

```ts
// DT-21.2 — lee la identidad ERC-8004 DECLARADA por el agente en su AgentCard
// (agent.metadata, payload crudo del registry — discovery.ts:353). Solo memoria,
// sin fetch/RPC. DEFAULT SEGURO: nada parseable → null → SIN badge.
function extractDeclaredTokenId(
  agent: Agent,
): { tokenId: string; chainId: number } | null {
  const meta = agent.metadata;
  if (!meta || typeof meta !== 'object') return null;
  const allowed = new Set([8453, 84532]); // Base mainnet/sepolia
  // 1) Estándar A2A/ERC-8004: metadata.registrations[].agentId (CAIP-10-like
  //    eip155:<chainId>:<registry>/<tokenId>).
  // 2) Fallback: metadata.erc8004 = {token_id, chain_id} | top-level erc8004_token_id.
  // (Parsear, validar tokenId ^[0-9]+$, chainId ∈ allowed; primera coincidencia.)
  // ... retornar { tokenId, chainId } o null.
}
```
   *El Dev define el parser exacto del `agentId` CAIP-10 según FP.1. tokenId como string.*

2. `attachIdentities(agents)` (l.228-240): por cada agente,
   `const decl = extractDeclaredTokenId(a)`; si `!decl` → **skip (sin badge, sin query)**;
   si no, `resolveIdentityForToken(decl.tokenId, decl.chainId)` → setear `a.identity` solo
   si hay match. Mantener `Promise.all` + degradación graciosa (falla DB → sin identity,
   no rompe discover).
3. `getAgent(slug)` (l.398-402): idéntico — `extractDeclaredTokenId(agent)` (no
   `agent.slug`).

## FP.4 `src/routes/agent-card.ts` — resolver por token declarado

Reemplazar la resolución por slug por: `const decl = extractDeclaredTokenId(agent);
const identity = decl ? await identityService.resolveIdentityForToken(decl.tokenId,
decl.chainId) : undefined;` antes de `buildAgentCard(agent, cfg, url, identity ??
undefined)`. `buildAgentCard` NO cambia de firma.

## FP.5 `src/routes/auth.ts` — `agent_slug` deja de ser trust (DT-21.7)

- Mantener `agent_slug?` en el shape JSONB como **hint informativo sin efecto en
  `verified`** (backward-compat con bindings ya escritos; NO migrar datos). El handler
  PUEDE seguir aceptándolo/persistiéndolo, pero el badge ya no depende de él.
- Agregar el manejo del nuevo error: `catch (err) { if (err instanceof
  Erc8004TokenAlreadyBoundError) return reply.status(409).send({ error_code:
  'ERC8004_TOKEN_ALREADY_BOUND' }); ... }` en el `try` del bind (auth.ts:549-566).

## FP.6 `src/services/security/errors.ts` — nuevo error class

```ts
export class Erc8004TokenAlreadyBoundError extends Error {
  readonly code = 'ERC8004_TOKEN_ALREADY_BOUND' as const;
  constructor() { super('ERC-8004 token already bound to another active key'); this.name = 'Erc8004TokenAlreadyBoundError'; }
}
```
(Mismo patrón que `FundingWalletAlreadyBoundError`, errors.ts.)

## FP.7 `src/types/index.ts` — sin cambios de shape

`AgentCardIdentity` (l.148-152), `Agent.identity?` (l.140) y `AgentCard.identity?`
(l.548) quedan **igual**. El fix es de mecanismo de resolución, no de shape de salida.
Opcional: documentar en el comentario del campo `agent_slug` (en `Erc8004IdentityBinding`,
`a2a-key.ts`) que es un hint informativo y NO controla `verified` (DT-21.7).

## FP.8 Tests del fix (OBLIGATORIOS)

| Test | Archivo | Aserción |
|---|---|---|
| **SEC anti-spoof BLQ-MED-1** | `auth.erc8004.test.ts` (o e2e) | atacante bindea token T (ownerOf==su wallet); card de la víctima declara token V≠T → `/discover` + agent-card de la víctima **NO** traen `identity`. Solo el agente cuyo card declara T surfacea el badge. **El ataque falla.** |
| **SEC unicidad token** | `auth.erc8004.test.ts` | token T bindeado a key A; 2º bind de MISMO T+chainId a key B activa distinta → **409 `ERC8004_TOKEN_ALREADY_BOUND`**, sin write. Re-bind de A sobre su misma key → OK (idempotencia AC-5) |
| **unit `resolveIdentityForToken`** | `discovery.test.ts` o `identity.test.ts` | match por `token_id`+`chain_id` activo → `{erc8004_token_id,chain_id,verified:true}`; chainId distinto / inactive / no match → null; **SELECT solo `erc8004_identity`** (no budget) |
| **unit `extractDeclaredTokenId`** | `discovery.test.ts` | `metadata.registrations` CAIP-10 válido → `{tokenId,chainId}`; fallback `metadata.erc8004`; vacío / tokenId no numérico / chainId fuera de {8453,84532} → `null` (default seguro) |
| **enrich discover (DT-21)** | `discovery.test.ts` | `discover()`/`getAgent()` setean `identity` SOLO cuando el token declarado está bindeado+verificado; sin declaración válida → skip; falla DB → sin identity, no rompe |
| **e2e bridge (reescrito)** | `erc8004-identity-bridge.e2e.test.ts` | el agente cuyo card declara token T (en `metadata.registrations`) + T bindeado → badge en agent-card y discover; agente sin declaración / sin bind → sin badge (AC-9) |
| **mocks actualizados** | `auth.test.ts`, `a2a-key.test.ts`, e2e | reflejar `resolveIdentityForToken` (no `resolveIdentityForSlug`) en los factory mocks de `identityService` (Auto-Blindaje Wave 4) |

## FP.9 Done Definition del fix

- [ ] El ataque BLQ-MED-1 ya NO funciona (test SEC anti-spoof verde): declarar el token
      de otro agente NO produce badge; el badge solo aparece cuando el card del propio
      agente declara el token que está bindeado+verificado localmente.
- [ ] Unicidad token↔key activa: 2º bind del mismo token a otra key → 409 (test verde).
- [ ] MNR-1 resuelto: resolución por igualdad `token_id` (indexable), skip si no hay
      declaración (sin full-table scan por slug).
- [ ] `resolveIdentityForSlug` ya no existe (o queda deprecated sin uso); todos los
      callers usan `resolveIdentityForToken`; mocks actualizados; `npm test` verde.
- [ ] CD-13/CD-2/CD-8/CD-3/CD-7/AC-9 intactos (grep de verificación).
- [ ] `biome check --write` SOLO sobre archivos in-scope del fix (CD-12).

**Archivos in-scope del fix:** `src/services/identity.ts`, `src/services/discovery.ts`,
`src/routes/agent-card.ts`, `src/routes/auth.ts`, `src/services/security/errors.ts`,
`src/types/index.ts` (comentario), + tests (`auth.erc8004.test.ts`, `discovery.test.ts`,
`agent-card.test.ts`, `erc8004-identity-bridge.e2e.test.ts`, `auth.test.ts`,
`a2a-key.test.ts`). NO tocar el adapter `erc8004-identity.ts` ni archivos de budget.

---

**FUERA de scope (sección original, NO tocar):** `src/adapters/base/identity.ts`, `src/adapters/base/index.ts`,
`src/adapters/registry.ts`, `src/adapters/types.ts`, cualquier archivo de budget/pago.

---

# FIX-PACK v2 POST-re-AR — MNR-1 (match bidireccional) + MNR-2 (UNIQUE en DB) — DT-22

> **CONTRATO DEL FIX v2. SUPERSEDE las partes del fix-pack v1 (DT-21) que resuelvan
> el badge cruzando SOLO por `token_id`.** El re-AR del v1 (commit `6057d7e`) quedó
> APROBADO CON MENORES; el humano decidió cerrar los 2 MENORES ahora (badge trustless
> de verdad). Lee el ADDENDUM DT-22 del `sdd.md` (§11) para el detalle de diseño.
> Ref completa: `sdd.md` DT-22.0..22.9.

## FPv2.0 Los 2 MENORES (qué NO debe seguir pasando)

- **MNR-1 (vector inverso — el importante):** `resolveIdentityForToken`
  (`src/services/identity.ts:244-271`) surfacea `verified:true` cruzando SOLO por
  `token_id`+`chain_id` (l.262). NO prueba que el operador del agente sea el dueño
  del token. **Ataque:** el atacante crea un agente A' cuyo card declara el token V
  de la víctima (público, ya bindeado por la víctima); `extractDeclaredTokenId(A')`
  devuelve V; `resolveIdentityForToken(V, C)` encuentra el binding de la víctima →
  A' surfacea `verified:true` con identidad ajena. **Debe quedar imposible.**
- **MNR-2 (race de unicidad):** la unicidad token↔key activa hoy es SOLO un pre-check
  app-layer (`src/services/identity.ts:182-198`, check-then-write). Dos binds
  concurrentes del mismo token a keys distintas pueden pasar ambos el pre-check.
  Falta la barrera atómica en DB.

## FPv2.1 Anti-Hallucination del fix v2 (LEER, marcar antes de cerrar)

- [ ] **Identificador estable del `Agent` = `(registry, slug)`** — NO inventes URL
  canónica. `mapAgent` (`src/services/discovery.ts:435-468`) deriva `registry:
  registry.name` (l.461) y `slug` (l.438/446). `invokeUrl` es un template, NO
  identidad; `Agent.id` puede colisionar entre registries. El match usa `(registry,
  slug)` **case-insensitive + trim** en ambos lados.
- [ ] **[VERIFY-AT-IMPL] regex de `agent_registry`** — no hay un patrón canónico hoy;
  usá uno permisivo (p.ej. `^[\w][\w .:/-]{0,127}$`) confirmando contra los
  `registry.name` reales del repo. **DEFAULT SEGURO:** inválido → 400 `INVALID_INPUT`.
- [ ] **CD-15 (auto-blindaje RECURRENTE — 3 entradas)** — renombrar
  `resolveIdentityForToken` → `resolveIdentityForAgent` rompe factory-mocks
  SILENCIOSAMENTE (TypeError en runtime, NO en `tsc`). ANTES de renombrar:
  `grep -rn "resolveIdentityForToken" src/` (callers) **y**
  `grep -rn "vi.mock('../services/identity.js'" src/` (y `../../services/identity.js`).
  Actualizá TODOS los factory-mocks: `auth.test.ts`, `a2a-key.test.ts`,
  `agent-card.test.ts` (mockea `discovery.js`), `erc8004-identity-bridge.e2e.test.ts`,
  `discovery.test.ts`, `identity.test.ts` y cualquier otro que aparezca en el grep.
- [ ] **`agent_registry`/`agent_slug` van JUNTOS o NINGUNO** — uno sin el otro → 400
  `INVALID_INPUT`. Ninguno → bind válido SIN ancla de badge (backward-compat).
- [ ] **`.select('erc8004_identity')` only** en el resolver; `.select('id')` en el
  pre-check (CD-2: nunca budget/funding_wallet).
- [ ] **Bindings v1 sin ancla → SIN badge (DEFAULT SEGURO)** — la key NO se degrada
  (autentica/debita igual, AC-9). NO migrar datos.
- [ ] **supabase multi-query mock (auto-blindaje recurrente)** — `bindErc8004Identity`
  hace pre-check + UPDATE (2 `supabase.from`). Mockear con `mockImplementation` +
  contador local (NO `mockReturnValueOnce` encadenado); castear builders
  `as unknown as ReturnType<typeof supabase.from>`.

## FPv2.2 `src/types/a2a-key.ts` — extender `Erc8004IdentityBinding` (W0)

`agent_slug` deja de ser hint informativo (DT-21.7) y **pasa a ser ancla de trust**
(ahora cruzado con el token on-chain-poseído). Se agrega `agent_registry` para
resolver colisiones de slug entre registries. SIN columna nueva, SIN migration de datos.

```ts
export interface Erc8004IdentityBinding {
  token_id: string;
  chain_id: number;
  agent_card_url: string;
  owner_address: string;
  verified_at: string;
  // DT-22 (MNR-1) — ancla del LADO BINDER del match bidireccional. El owner declara
  // QUÉ agente de discovery opera esta identidad: (registry, slug) (= mapAgent:
  // registry.name + slug). El badge surfacea SOLO si el agente A declara este token
  // Y este binding declara operar (A.registry, A.slug). Promoción de agent_slug a
  // ancla de trust (cruzado con el token poseído on-chain). Van JUNTOS o NINGUNO.
  agent_registry?: string;   // == Agent.registry. Match case-insensitive.
  agent_slug?: string;       // == Agent.slug. Match case-insensitive.
}
```

## FPv2.3 `src/types/index.ts` — documentar contrato del badge (W0)

Actualizar el comentario de `AgentCardIdentity` (l.148-152) con QUÉ atesta
`verified:true` (DT-22.4): vínculo bidireccional probado (3 anclajes: card declara
token + token bindeado+`ownerOf`-verificado + binding declara operar este agente).
Shape de `AgentCardIdentity` NO cambia.

## FPv2.4 `src/services/identity.ts` — `resolveIdentityForToken` → `resolveIdentityForAgent` (W2)

Reemplazar `resolveIdentityForToken(tokenId, chainId)` (l.244-271) por:

```ts
async resolveIdentityForAgent(
  tokenId: string,
  chainId: number,
  agentRegistry: string,
  agentSlug: string,
): Promise<AgentCardIdentity | null> {
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .select('erc8004_identity')        // SOLO esta columna (CD-2/DT-19)
    .eq('is_active', true)
    .not('erc8004_identity', 'is', null);
  if (error || !data) return null;
  const nReg = agentRegistry.trim().toLowerCase();
  const nSlug = agentSlug.trim().toLowerCase();
  for (const row of data as Array<{ erc8004_identity: Erc8004IdentityBinding | null }>) {
    const b = row.erc8004_identity;
    if (!b) continue;
    if (b.token_id !== tokenId || b.chain_id !== chainId) continue;   // lado token/agente
    if (!b.agent_registry || !b.agent_slug) continue;                 // sin ancla → sin badge
    if (b.agent_registry.trim().toLowerCase() !== nReg) continue;      // lado binder: registry
    if (b.agent_slug.trim().toLowerCase() !== nSlug) continue;         // lado binder: slug
    return { erc8004_token_id: b.token_id, chain_id: b.chain_id, verified: true };
  }
  return null;
}
```
- [VERIFY-AT-IMPL] podés intentar el filtro server-side por igualdad indexable de
  `token_id`/`chain_id` (`.eq('erc8004_identity->>token_id', tokenId)` etc.); el match
  de `(registry, slug)` se hace SIEMPRE en JS (case-insensitive). Fallback JS si
  PostgREST no soporta el operador `->>` como esperás.
- El pre-check de unicidad en `bindErc8004Identity` (l.182-198) **se mantiene**
  (defensa en profundidad). El mapeo `error.code === '23505'` →
  `Erc8004TokenAlreadyBoundError` (l.209) **se mantiene** (ahora respaldado por el
  índice DB de FPv2.7).

## FPv2.5 `src/services/discovery.ts` + `src/routes/agent-card.ts` — pasar `(registry, slug)` (W5)

- `attachIdentities` (l.335-352): `resolveIdentityForAgent(decl.tokenId, decl.chainId,
  a.registry, a.slug)` (en vez de `resolveIdentityForToken(decl.tokenId, decl.chainId)`).
  Skip si `!decl`. Mantener `Promise.all` + degradación graciosa.
- `getAgent` (l.507-519): `resolveIdentityForAgent(decl.tokenId, decl.chainId,
  agent.registry, agent.slug)`.
- `src/routes/agent-card.ts`: idem — `resolveIdentityForAgent(decl.tokenId,
  decl.chainId, agent.registry, agent.slug)` antes de `buildAgentCard` (firma NO cambia).
- `extractDeclaredTokenId` (l.135-169) NO cambia.

## FPv2.6 `src/routes/auth.ts` — bind persiste `(agent_registry, agent_slug)` (W3)

- Validar `agent_registry` OPCIONAL del body (igual estilo que `agent_slug`,
  l.464-475): `string`, trim, regex permisivo (FPv2.1), no vacío → si inválido 400
  `INVALID_INPUT`.
- **Regla JUNTOS o NINGUNO (DT-22.7):** si llega `agent_slug` sin `agent_registry`
  (o viceversa) → 400 `INVALID_INPUT`. Si llegan ambos → ancla válida. Si ninguno →
  bind sin ancla (válido, sin badge).
- El binding (l.540-547): `...(agentRegistry && agentSlug && { agent_registry:
  agentRegistry, agent_slug: agentSlug })`.
- El catch ya mapea `Erc8004TokenAlreadyBoundError` → 409 (l.562-566): **se mantiene**.

## FPv2.7 MIGRATION — índice UNIQUE parcial (MNR-2) (nueva, aditiva)

**Crear DOS archivos** (convención `supabase/migrations/`, calcada de
`20260529000001_a2a_key_funding_wallet.sql` + su `_down`):

`supabase/migrations/20260531000000_erc8004_token_unique.sql`:
```sql
BEGIN;
-- WKH-100 FIX v2 (MNR-2): a lo sumo UNA key activa puede reclamar un mismo
-- (token_id, chain_id) ERC-8004. Cierra la race del pre-check app-layer.
-- El código mapea 23505 → Erc8004TokenAlreadyBoundError (identity.ts:209).
-- Aditivo + idempotente. NO migra datos (AC-9/CD-9).
-- NOTA DEPLOY: si ya existen >=2 keys activas con el mismo token_id+chain_id
-- (race de v1), este CREATE falla. Verificá/limpiá duplicados antes:
--   SELECT erc8004_identity->>'token_id', erc8004_identity->>'chain_id', count(*)
--   FROM a2a_agent_keys WHERE is_active AND erc8004_identity IS NOT NULL
--   GROUP BY 1,2 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_a2a_agent_keys_erc8004_token
  ON a2a_agent_keys (
    (erc8004_identity->>'token_id'),
    (erc8004_identity->>'chain_id')
  )
  WHERE is_active AND erc8004_identity IS NOT NULL;
COMMIT;
```

`supabase/migrations/20260531000000_erc8004_token_unique_down.sql`:
```sql
BEGIN;
DROP INDEX IF EXISTS uq_a2a_agent_keys_erc8004_token;
COMMIT;
```
- Doble función: barrera atómica (MNR-2) + índice funcional que acelera el
  reverse-lookup (cubre TD-ERC8004-03).
- Si hay un `test/migrate-preflight.test.ts` que valida pares up/down, confirmá que
  el nuevo par no lo rompe (grep el patrón que valida).

## FPv2.8 Tests del fix v2 (OBLIGATORIOS)

| Test | Archivo | Aserción |
|---|---|---|
| **SEC-INV** (MNR-1 vector inverso) | `auth.erc8004.test.ts` / `discovery.test.ts` | víctima bindea V declarando `(regV, slugV)`; agente del atacante `(regX, slugX)` declara V en su card → `resolveIdentityForAgent(V, C, regX, slugX)` → `null`; discover+agent-card del atacante SIN `identity`. **El vector inverso falla.** |
| **SEC-MATCH** | `discovery.test.ts` / e2e | binding de T declara `(regA, slugA)`; agente `(regA, slugA)` declara T → `{verified:true}`; badge presente |
| **SEC-NOMATCH** | `discovery.test.ts` | binding de T declara `(regA, slugA)`; agente B `(regB, slugB)` declara T → `null`; B sin badge |
| **SEC-ORIG** (vector original re-verificado) | `auth.erc8004.test.ts` | slug spoof clásico sigue cerrado (binding de V declara `(regV, slugV)` ≠ agente del atacante) |
| **SEC-LEGACY** (AC-9) | `discovery.test.ts` / `auth.test.ts` | binding v1 sin `agent_registry`/`agent_slug` → `null` (sin badge); key autentica + debita igual |
| **SEC-UNIQUE-DB** (MNR-2) | `auth.erc8004.test.ts` | 2º bind del MISMO T+chain a key B activa → `UPDATE` devuelve `23505` → `Erc8004TokenAlreadyBoundError` → 409, sin write. Re-bind de A sobre su misma key (AC-5) → OK |
| **unit `resolveIdentityForAgent`** | `identity.test.ts` / `discovery.test.ts` | match SOLO si token+chain+registry(ci)+slug(ci); falta cualquiera → null; SELECT solo `erc8004_identity` |
| **mocks actualizados (CD-15)** | `auth.test.ts`, `a2a-key.test.ts`, `agent-card.test.ts`, e2e | reemplazar `resolveIdentityForToken` por `resolveIdentityForAgent` en cada `vi.mock` factory de `identityService` |

## FPv2.9 Done Definition del fix v2

- [ ] **MNR-1 cerrado:** declarar el token de otro agente NO produce badge (SEC-INV
      verde); el badge solo aparece con match bidireccional (card declara token ∧
      binding declara operar este agente ∧ token bindeado+`ownerOf`-verificado).
- [ ] **MNR-2 cerrado:** índice UNIQUE parcial aplicado; 2º bind concurrente del mismo
      token a otra key activa → 409 vía `23505` (SEC-UNIQUE-DB verde).
- [ ] Vector original (slug spoof) sigue cerrado (SEC-ORIG verde).
- [ ] Backward-compat: binding v1 sin ancla → sin badge, key no degradada (SEC-LEGACY,
      AC-9 verde).
- [ ] `resolveIdentityForToken` ya no existe; todos los callers usan
      `resolveIdentityForAgent`; **todos los factory-mocks actualizados (CD-15)**;
      `npm test` verde.
- [ ] Match `(registry, slug)` case-insensitive + trim; perf por igualdad de
      `token_id` indexable (no full-table scan por agente).
- [ ] CD-13/CD-2/CD-8/CD-3/CD-6/AC-9 intactos (grep de verificación).
- [ ] `biome check --write` SOLO sobre archivos in-scope del fix v2 (CD-12).

**Archivos in-scope del fix v2:** `src/types/a2a-key.ts`, `src/types/index.ts`
(comentario), `src/services/identity.ts`, `src/services/discovery.ts`,
`src/routes/agent-card.ts`, `src/routes/auth.ts`,
`supabase/migrations/20260531000000_erc8004_token_unique.sql` (+ `_down.sql`), + tests
(`auth.erc8004.test.ts`, `discovery.test.ts`, `identity.test.ts`,
`agent-card.test.ts`, `erc8004-identity-bridge.e2e.test.ts`, `auth.test.ts`,
`a2a-key.test.ts`). NO tocar el adapter `erc8004-identity.ts` ni archivos de budget.

---

# FIX-PACK v3 (re-AR v2 → BLQ-MED-1: badge spoofing por colisión de normalización de registry name)

> Diseño completo en `sdd.md` §12 (DT-23). Esto es el contrato autocontenido del Dev.
> Resuelve UN bloqueante (BLQ-MED-1) + un MNR (MNR-1 drift, solo doc). NO ampliar scope.

## FPv3.0 Anti-Hallucination Checklist (LEER ANTES DE CODEAR)

- [ ] La causa raíz es que el match cruza `agent_registry` == `registry.name` (display,
      mutable) con dos normalizaciones DIVERGENTES: PK = `name.toLowerCase().replace(/\s+/g,'-')`
      (`registry.ts:167`) vs badge = `.trim().toLowerCase()` (`identity.ts:270,283`).
- [ ] El ancla nueva es el **PK `id` del registry** (único + inmutable), NO el name.
- [ ] `Agent.registry` (display name) **NO se elimina** — se AGREGA `Agent.registry_id`.
      Romper `registry` rompería consumidores/UX (backward-compat).
- [ ] El match de `registry_id` es **igualdad ESTRICTA** (`===`), SIN `.trim().toLowerCase()`
      (ambos lados ya son el PK canónico; re-normalizar reintroduce no-inyectividad).
- [ ] El campo JSONB se sigue llamando `agent_registry`; SOLO cambia el VALOR que guarda
      (PK en vez de display name). NO hay migration de schema NI de datos (branch sin deploy).
- [ ] Slug: NO aplicar `SLUG_RE` al slug upstream en `mapAgent` (cambiaría discovery). Usar
      helper `normalizeSlug` determinista en AMBOS lados del match.
- [ ] CD-2/CD-8/CD-3/CD-6/CD-13/AC-9 intactos. Sin `any`. Sin RPC nuevo. Sin write nuevo
      (solo +1 read de `registries` en bind).
- [ ] CD-15: grepear usos de `REGISTRY_RE` y del nombre del param `agentRegistry` antes de
      renombrar/borrar.

## FPv3.1 Archivos in-scope del fix v3

| Archivo | Cambio |
|---|---|
| `src/types/index.ts` | `Agent` + `registry_id: string` (DT-23.1) |
| `src/services/discovery.ts` | `mapAgent` setea `registry_id: registry.id`; 3 callers de `resolveIdentityForAgent` pasan `a.registry_id` (no `a.registry`) — `:342`, `:517` |
| `src/services/identity.ts` | `resolveIdentityForAgent`: param `agentRegistry`→`agentRegistryId`; match `b.agent_registry === agentRegistryId` (estricto); slug vía `normalizeSlug`; actualizar docstring |
| `src/services/registry.ts` | `register`: regla anti-colisión (whitespace borde+interno) + pre-check `get(id)` antes del insert (DT-23.4) |
| `src/routes/auth.ts` | bind: validar `agent_registry` con `REGISTRY_ID_RE` (PK pattern) + existencia vía `registryService.get`; borrar `REGISTRY_RE` muerto; persistir el PK |
| `src/routes/agent-card.ts` | caller `resolveIdentityForAgent` pasa `agent.registry_id` (`:57-62`) |
| tests | `identity.test.ts`, `discovery.test.ts`, `agent-card.test.ts`, `auth.erc8004.test.ts`, `registries.test.ts` (o `registries.ssrf.test.ts`), `erc8004-identity-bridge.e2e.test.ts` — ajustar SEC existentes al nuevo ancla + nuevos SEC-COLLISION |
| `doc/sdd/100-wasiai-agentkey/sdd.md` | MNR-1 drift: corregir wording líneas ~626 y ~926 (JS fallback, no SQL `->>`) |

NO tocar: budget, reader on-chain, migrations (ninguna nueva — el cambio es de valor, no de schema).

## FPv3.2 Cambios exactos por archivo

### W0 (serial) — tipo + helper (contratos primero)

**`src/types/index.ts`** — `Agent`:
```ts
registry: string;     // display name (sin cambios)
registry_id: string;  // WKH-100 FIX v3 (DT-23): PK canónico del registry. Ancla del match.
```

**`src/services/identity.ts`** — agregar helper module-scope (reusable):
```ts
/** WKH-100 FIX v3 (DT-23 §12.4): canoniza slug de forma determinista en AMBOS
 *  lados del match. El binding ya validó SLUG_RE; el slug del Agent puede venir
 *  sin canonizar del upstream. Idempotente. */
function normalizeSlug(s: string): string {
  return s.trim().toLowerCase();
}
```

### W1 — match anclado al PK

**`src/services/identity.ts:256-292`** `resolveIdentityForAgent`:
- Firma: `agentRegistry: string` → `agentRegistryId: string`.
- Borrar `const nReg = agentRegistry.trim().toLowerCase();`.
- Reemplazar el match de registry por: `if (b.agent_registry !== agentRegistryId) continue;`
  (igualdad ESTRICTA, sin normalizar).
- Reemplazar el match de slug por: `if (normalizeSlug(b.agent_slug) !== normalizeSlug(agentSlug)) continue;`
- Actualizar docstring: el ancla del lado-binder es el **PK del registry** (no el name);
  explicar por qué igualdad estricta (inyectividad).

**`src/services/discovery.ts`** `mapAgent` (`:438-470`): agregar `registry_id: registry.id,`
junto a `registry: registry.name,`. (NO re-normalizar — es la columna PK.)

**`src/services/discovery.ts`** callers (`attachIdentities :342`, `getAgent :517`): cambiar
el 3er arg de `a.registry` / `agent.registry` → `a.registry_id` / `agent.registry_id`.

**`src/routes/agent-card.ts:57-62`**: el caller pasa `agent.registry_id` (no `agent.registry`).
El `registries.find((r) => r.name === agent.registry)` de `:43` (construcción de la card) se
DEJA igual — ese match es por name para resolver el `RegistryConfig` de display, no es trust.

### W2 — bind: validar/persistir el PK

**`src/routes/auth.ts`**:
- Definir `const REGISTRY_ID_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;` (forma idéntica a `SLUG_RE`).
- Borrar `REGISTRY_RE` (`:91`) tras grepear que no se usa en otro lado (CD-15).
- En el bloque `2c` (`:485-496`): validar `trimmed` contra `REGISTRY_ID_RE` (no `REGISTRY_RE`)
  → 400 `INVALID_INPUT` si no matchea.
- Agregar (después de validar el patrón): `const reg = await registryService.get(trimmed);
  if (!reg) return reply.status(400).send({ error_code: 'INVALID_INPUT' });` (DT-23.3.2 —
  rechazar PK inexistente; es read de `registries`, NO RPC, CD-8 OK).
- El binding persiste `agent_registry: agentRegistry` (ya es el PK validado) — sin cambio de forma.

### W3 — regla anti-colisión en POST /registries

**`src/services/registry.ts`** `register` (`:149-186`), antes de `const id = ...`:
```ts
// WKH-100 FIX v3 (DT-23.4): name → PK inyectivo. Rechazar whitespace de borde
// (el .trim() del match diverge del .replace(/\s+/g,'-') del PK) e interno
// colapsable (doble espacio).
if (config.name !== config.name.trim()) {
  throw new Error('Invalid registry name: leading/trailing whitespace');
}
if (/\s\s/.test(config.name)) {
  throw new Error('Invalid registry name: collapsible internal whitespace');
}
```
Y antes del insert, pre-check de colisión de PK:
```ts
const id = config.name.toLowerCase().replace(/\s+/g, '-');
const clash = await this.get(id);
if (clash) throw new Error(`Registry '${id}' already exists`);
```
(El `23505` de `:179-181` se mantiene como defensa final por race.)
El route (`registries.ts:182-188`) ya mapea estos `Error` a 400 con el mensaje — sin cambio
en la route, salvo confirmar que el 400 es el esperado por el test.

### W4 — MNR-1 drift (doc only, NO bloqueante)

**`doc/sdd/100-wasiai-agentkey/sdd.md`** líneas ~626 y ~926: cambiar el wording que dice
"igualdad indexable SQL" por "fallback determinista en JS sobre candidatas activas con identity
no-null (DT-22.5 nota perf); NO usa `->>` por portabilidad de PostgREST". 1 línea cada uno.

## FPv3.3 Tests requeridos

| Test | Archivo | Qué prueba |
|---|---|---|
| **SEC-COLLISION-MATCH** | `identity.test.ts` | binding con `agent_registry="wasiai-"` (PK de `"WasiAI "`) y Agent con `registry_id="wasiai"` → `resolveIdentityForAgent("<tok>", chain, "wasiai", "acme")` → **null** (PKs distintos, igualdad estricta). El ataque de v2 ya NO matchea. |
| **SEC-COLLISION-REG** | `registries.test.ts` (o `.ssrf.test.ts`) | `POST /registries` con `name="WasiAI "` → **400** (whitespace de borde). `name="WasiAI  X"` → 400 (interno doble). `name="WasiAI"` cuando ya existe → 400 (pre-check). |
| **SEC-BIND-PK** | `auth.erc8004.test.ts` | bind con `agent_registry="WasiAI "` (whitespace) → 400 (no pasa `REGISTRY_ID_RE`). bind con `agent_registry="no-existe"` → 400 (pre-check existencia). bind con PK válido existente → 200. |
| **SEC-MATCH-OK (ajustado)** | `identity.test.ts` | match legítimo ahora cruza `registry_id` (PK) estricto + slug `normalizeSlug`. Ajustar fixtures de los SEC existentes (binding guarda PK, no name). |
| **SEC-ORIG / SEC-INV / SEC-LEGACY (ajustados)** | `identity.test.ts` | seguir verdes con el nuevo ancla: vector original (slug spoof) y inverso (token ajeno) sin badge; legacy v1 sin ancla sin badge. |
| **SEC-SLUG-SCOPED** | `identity.test.ts` | atacante con `registry_id` propio declarando `slug` == slug-de-víctima → sin badge (el slug solo discrimina dentro del registry_id; PKs distintos). |
| **bridge e2e (ajustado)** | `erc8004-identity-bridge.e2e.test.ts` | discover/agent-card con `registry_id` real → badge end-to-end OK. |

## FPv3.4 Done Definition del fix v3

- [ ] **BLQ-MED-1 cerrado:** crear `name="WasiAI "` → 400; aun bindeando con PK ajeno el
      match falla por igualdad estricta de PK (SEC-COLLISION-MATCH + SEC-COLLISION-REG verdes).
- [ ] `Agent.registry_id` expuesto en `mapAgent` (= `registry.id`, sin re-normalizar); los
      3 callers pasan `registry_id`.
- [ ] `resolveIdentityForAgent` matchea `b.agent_registry === agentRegistryId` (estricto) +
      `normalizeSlug` en slug; firma usa `agentRegistryId`.
- [ ] Bind valida `agent_registry` con `REGISTRY_ID_RE` + existencia; `REGISTRY_RE` borrado
      (grep CD-15 confirma 0 usos).
- [ ] Regla anti-colisión en `register` (whitespace borde+interno + pre-check `get(id)`).
- [ ] Slug análogo cerrado (SEC-SLUG-SCOPED verde); `mapAgent` NO aplica `SLUG_RE` al upstream.
- [ ] Sin migration de datos (documentado en commit: branch sin deploy, fail-safe).
- [ ] MNR-1 drift: sdd.md líneas ~626/~926 corregidas (JS fallback, no SQL).
- [ ] `Agent.registry` (display) intacto; backward-compat consumidores OK.
- [ ] CD-2/CD-8/CD-3/CD-6/CD-13/AC-9 intactos (grep verificación). Sin `any`. Sin RPC/write nuevo.
- [ ] `npm test` verde; `biome check --write` SOLO sobre archivos in-scope del fix v3 (CD-12).
