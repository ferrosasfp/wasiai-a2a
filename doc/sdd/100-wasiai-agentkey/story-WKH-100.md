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
