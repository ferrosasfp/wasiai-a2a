# Story File — WKH-101 · wasiai-agentkey Fase 2: EIP-712 Delegation + Session Key + Server-Side Enforcement

> **Contrato autocontenido para el Dev (F3).** Es la ÚNICA fuente de verdad para implementar.
> Si algo no está acá, NO lo hagas. Si algo es ambiguo, parar y avisar al orquestador.
> **Modo:** QUALITY · **Estimación:** L · **Branch:** `feat/101-wasiai-agentkey-delegation`
> **Inputs leídos para este Story:** `sdd.md`, `work-item.md`, y código real:
> `src/middleware/a2a-key.ts`, `src/routes/auth.ts`, `src/services/identity.ts`,
> `src/services/budget.ts`, `src/services/authz.ts`, `src/services/compose.ts`,
> `src/routes/compose.ts`, `src/services/orchestrate.ts`, `src/routes/orchestrate.ts`,
> `src/types/a2a-key.ts`, `src/types/index.ts`, `src/services/security/errors.ts`,
> `supabase/migrations/20260529000000_a2a_key_deposits.sql`,
> `supabase/migrations/20260406000000_a2a_agent_keys.sql`,
> `src/middleware/a2a-key.test.ts`.

---

## 0. Contexto compacto — qué se construye y por qué

El owner de una Agent Key (autenticado con su **master key** `wasi_a2a_<hex>`) firma un
typed-data **EIP-712** que contiene una **policy de gasto** (per-tx, total, expiry,
chains/agents/registries permitidos) y autoriza una **session key efímera**. El server:

1. recupera el firmante con viem `recoverTypedDataAddress`,
2. exige que sea el `funding_wallet` bindeado de la key (ancla de autoridad EXCLUSIVA, CD-11),
3. emite un **token opaco** `wasi_a2a_session_<random>` (devuelto UNA sola vez), persiste su SHA-256,
4. en cada `/compose` / `/orchestrate` que use ese token, **enforcea TODOS los límites server-side**,
5. provee **revocación inmediata** (`revoked_at`).

Las keys sin delegación (master key) **siguen funcionando exactamente igual** (backward-compat opt-in, CD-5).

---

## 1. Anti-Hallucination Checklist (LEER ANTES DE TOCAR CÓDIGO)

- [ ] **`[VERIFY-AT-IMPL]` viem v2 EIP-712.** Confirmar en los `.d.ts` de `node_modules/viem` (versión `^2.47.6` del `package.json`) la firma EXACTA de **`recoverTypedDataAddress`** ANTES de codear. Esperado:
      `recoverTypedDataAddress({ domain, types, primaryType, message, signature }): Promise<` `` `0x${string}` `` `>`.
      Verificar: (a) que NO requiere el campo `EIP712Domain` dentro de `types` (viem lo infiere del `domain`); (b) que `as const` en `domain`/`types` basta para tipar sin `any`/`as unknown` (CD-7); (c) si viem exige el tipo `TypedDataDomain`, importarlo de `'viem'`. **PROHIBIDO usar `verifyTypedData`** (DT-1): se usa `recoverTypedDataAddress` para comparar contra `funding_wallet` sin conocer al firmante de antemano. Comando sugerido: `grep -rn "recoverTypedDataAddress" node_modules/viem/_types/utils/signature/ 2>/dev/null` y leer la signatura.
- [ ] **Atomicidad SOLO vía el RPC `debit_delegation_and_parent`.** PROHIBIDO read-then-write app-layer sobre `total_spent` (CD-12). El check `total_spent + amount > max_total` y el debit del parent budget ocurren DENTRO del RPC, bajo `FOR UPDATE`. El service solo invoca `supabase.rpc(...)` y mapea errores por prefijo de mensaje (igual que `budgetService.registerDeposit`, `src/services/budget.ts:91-101`).
- [ ] **Enforcement PER-STEP, no solo step 0 (CORRECCIÓN F2.5 — DT-11).** AC-7 (`max_amount_per_tx`) y AC-8 (`max_total_amount`) se enforzan en CADA débito de step. `/compose` debita per-step en `compose.ts:158` (steps 2..N, guard `i>0 && scopingKeyRow && chainId`). El débito per-step DEBE pasar por la ruta delegation-aware: `budgetService.debit(keyId, chainId, amount, delegationContext)` → si `delegationContext` presente, llama `debit_delegation_and_parent` (RPC atómico) en vez de `increment_a2a_key_spend`. PROHIBIDO dejar el enforcement de total como un único débito en el middleware → eso es el bypass de AC-8 que esta corrección cierra. El step que excede `max_total` corta el pipeline EN ESE STEP (no después): `debit` devuelve `{success:false}` → `compose.ts:163-175` retorna `ComposeResult.error`.
- [ ] **Guardar SOLO el hash del token, NUNCA el token.** Persistir `session_token_hash = SHA-256(token)`. El `token` plano se devuelve UNA vez en la 201 y nunca más. PROHIBIDO loguear el token o la firma (PII-safe).
- [ ] **Sin sub-delegación (CD-9/AC-15).** `POST /auth/delegation` autenticado con un token `wasi_a2a_session_*` → 403 `DELEGATION_NOT_ALLOWED`, 0 rows.
- [ ] **Backward-compat master key (CD-5/AC-13).** El branch de sesión SOLO se activa si `rawKey.startsWith('wasi_a2a_session_')`. El path master key queda línea-por-línea INTACTO. No tocar el orden de checks existente del middleware.
- [ ] **Ancla = `funding_wallet` exclusivo (CD-11).** Comparar el signer recuperado SOLO con `funding_wallet`. Si es `null` → `FUNDING_WALLET_NOT_BOUND`. PROHIBIDO fallback a `owner_ref` o `erc8004_identity.owner_address`.
- [ ] **Ownership Guard en TODA query/mutación de `a2a_delegations`** que reciba un `delegation_id` del caller (`revoke`, `list`): `.eq('id', id).eq('owner_ref', ownerRef)` + 0 rows → `OwnershipMismatchError`. El RPC valida `owner_ref` a nivel DB. **Excepción documentada (DT-6):** `lookupByTokenHash` del hot path NO lleva owner gate (el caller se autentica CON el token; el owner se deriva del row). Documentar con `NOTA PARA AR-CR`.
- [ ] **Montos: NUNCA `Number()`/`parseFloat` para comparar `max_total_amount`** (CD-AB-3). El total se compara en NUMERIC dentro del RPC. El `max_amount_per_tx` per-tx (AC-7) se compara en el service: ver §4 helper `assertPerTxLimit` (comparación decimal segura, no float64 lossy).
- [ ] **Domain binding (DT-1).** El `typed_data.domain` que envía el cliente DEBE coincidir con el domain del server (`name`/`version`/`chainId`) ANTES de recuperar. Domain divergente → tratar como signer mismatch (no aceptar). Pasar `typed_data.message` tal cual al recover (NO reconstruirlo).
- [ ] **Sin hardcodes prod (CD-6).** `DELEGATION_EIP712_NAME`, `DELEGATION_EIP712_VERSION`, `KITE_CHAIN_ID` desde env. Defaults SOLO como fallback dev.
- [ ] **TS strict (CD-7).** Sin `any`, sin `as unknown` salvo el cast documentado de builders mock supabase en tests (`as unknown as ReturnType<typeof supabase.from>`).
- [ ] **Mocks no rotos (CD-AB-1).** Antes de cerrar cualquier wave que agregue imports a `auth.ts`/`a2a-key.ts`: agregar `vi.mock('../services/delegation.js', ...)` a TODO test file que monte esos módulos (`auth.test.ts`, `auth.erc8004.test.ts`, `a2a-key.test.ts`) con TODOS los named exports del service. Correr `tsc --noEmit` (no solo `tsconfig.build.json`) para detectar fixtures rotos.

---

## 2. Orden de Waves (W0 serial; W1+ dependen de W0)

| Wave | Objetivo | Depende de |
|------|----------|-----------|
| **W0** | Tipos + error classes + migration (tabla + RPC) + env | — (serial, primero) |
| **W1** | `delegation.ts` (service core + EIP-712 + RPC client + Ownership Guard) | W0 |
| **W2** | Endpoints REST `POST/DELETE/GET /auth/delegation` | W1 |
| **W3** | Branch `wasi_a2a_session_` en middleware + enforcement STEP 0 + set `delegationContext` | W1 |
| **W4** | **Débito per-step delegation-aware (DT-11/DT-12)** + scoping per-agent | W1, W3 |
| **W5** | Tests (T1–T20 + T7b/T8b multi-step) | W1–W4 |

> **CORRECCIÓN F2.5 (gap de correctitud).** El enforcement de monto NO es un solo débito en step 0. `/compose` y `/orchestrate` debitan **por step** (`budgetService.debit`, `compose.ts:158`). Sin el fix, una session key gastaría más que `max_total_amount` repartido en varios steps → bypass de AC-8. W4 hace la **ruta de débito delegation-aware**: `budgetService.debit(...)` detecta `delegationContext` y llama `debit_delegation_and_parent` (atómico) en vez de `increment_a2a_key_spend`. Ver `sdd.md` DT-11/DT-12.

---

## 3. Constraint Directives resumidas (heredadas; cobertura completa en `sdd.md` §4)

| CD | Resumen |
|----|---------|
| CD-1 | EIP-712 + secp256k1 vía viem. PROHIBIDO ethers.js. |
| CD-2 | Ownership Guard en `a2a_delegations` (app-layer en revoke/list; DB-layer en RPC). |
| CD-3 | Enforcement 100% server-side; nunca confiar en campos de control del cliente. |
| CD-4 | Anti-replay: `UNIQUE(key_id, nonce)`. Sin nonce → rechazo. |
| CD-5 | Backward-compat: branch SOLO si prefijo session; master path intacto. |
| CD-6 | Sin hardcodes prod: domain name/version + chainId desde env. |
| CD-7 | TS strict, sin `any`, sin `as unknown` para eludir tipos viem. |
| CD-8 | Ambos límites: policy (per-tx/total) Y parent budget[chainId]. |
| CD-9 | Sin sub-delegación → 403 `DELEGATION_NOT_ALLOWED`. |
| CD-10 | `revoked_at` re-chequeado en CADA request (middleware + RPC bajo lock). |
| CD-11 | Ancla = `funding_wallet` exclusivo, sin fallback. |
| CD-12 | Check-and-debit de `total_spent` atómico a nivel DB (RPC), cero read-then-write. |
| CD-AB-1 | No romper mocks factory: agregar exports nuevos a `vi.mock(...)`; mockear `delegation.js` en test files que importen `auth.ts`/`a2a-key.ts`. |
| CD-AB-3 | Comparaciones de montos: NUMERIC en RPC, sin `Number()/parseFloat` para el total. |
| CD-AB-4 | El nuevo branch session token cambia 401/403 en rutas autenticadas → `grep -rn "wasi_a2a_session_\|delegation" src/**/*.test.ts` y revisar e2e antes de cerrar. |

---

## 4. error_code taxonomy (completa, con HTTP status)

| error_code | HTTP | Dónde se emite | Disparador |
|-----------|------|----------------|-----------|
| `FUNDING_WALLET_NOT_BOUND` | **403** | `POST /auth/delegation` | parent key sin `funding_wallet` (AC-2). **Reusar `FundingWalletNotBoundError` existente** (`errors.ts:59`). |
| `DELEGATION_SIGNER_MISMATCH` | **403** | `POST /auth/delegation` | recover != funding_wallet (case-insensitive) o domain divergente o recover falla (AC-3). |
| `DELEGATION_NONCE_REPLAY` | **409** | `POST /auth/delegation` | `(key_id, nonce)` ya existe → 23505 mapeado (AC-4). |
| `INVALID_SESSION_TOKEN` | **401** | middleware (branch session) | `lookupByTokenHash` → null (AC-5). |
| `DELEGATION_REVOKED` | **403** | middleware + RPC | `revoked_at IS NOT NULL` (AC-6/AC-10). |
| `DELEGATION_EXPIRED` | **403** | middleware + RPC | `now() >= expires_at` (AC-6). |
| `DELEGATION_TX_LIMIT_EXCEEDED` | **403** | middleware (step 0, `exceedsPerTxLimit`) + `budgetService.debit` (steps 2..N, antes del RPC) | `stepCost > max_amount_per_tx` POR STEP (AC-7). En compose multi-step se mapea a `ComposeResult.error` → 400. |
| `DELEGATION_TOTAL_LIMIT_EXCEEDED` | **403** | RPC `debit_delegation_and_parent` (invocado en CADA débito de step) | `total_spent + stepCost > max_total` (AC-8). Corta el pipeline en el step que excede. |
| `AGENT_KEY_BUDGET_EXHAUSTED` | **403** | RPC (`INSUFFICIENT_BUDGET` propagado) | parent budget[chainId] insuficiente (AC-9). Mapear `INSUFFICIENT_BUDGET` del RPC → este code. |
| `DELEGATION_CHAIN_NOT_ALLOWED` | **403** | middleware (post chain-resolve) | `allowed_chains` NO vacío y `chainId ∉ allowed_chains` (DT-3). |
| `OWNERSHIP_MISMATCH` | **403** | revoke/list + RPC | cross-tenant (AC-12). Reusar `OwnershipMismatchError` (`errors.ts:9`). |
| `DELEGATION_NOT_ALLOWED` | **403** | `POST /auth/delegation` | token autenticador es `wasi_a2a_session_*` (AC-15/CD-9). |

> **DT-3 RESUELTO (orquestador):** `policy.allowed_chains` **vacío o ausente = SIN restricción de chain** (paridad con master keys: `allowed_*` null = sin restricción). Los guardrails duros son monto per-tx + total + expiry. Solo si `allowed_chains` tiene elementos Y el `chainId` resuelto NO está en la lista → 403 `DELEGATION_CHAIN_NOT_ALLOWED`. **Bakear esto en el comentario del enforcement y en el test T17.**

---

## 5. Env vars

| Var | Uso | Default (SOLO dev fallback, CD-6) |
|-----|-----|-----------------------------------|
| `DELEGATION_EIP712_NAME` | `domain.name` del EIP-712 | `'WasiAI-a2a Delegation'` |
| `DELEGATION_EIP712_VERSION` | `domain.version` del EIP-712 | `'1'` |
| `KITE_CHAIN_ID` | `domain.chainId` (Number) — AC-14 | (sin default seguro; ver nota) |

> **NOTA `KITE_CHAIN_ID`:** hoy NO existe ninguna referencia a `KITE_CHAIN_ID` en `src/`. El work-item (AC-14) y el SDD lo declaran como la fuente del `domain.chainId`. **Agregarlo a `.env.example`.** En el `buildDomain()`, leer `Number(process.env.KITE_CHAIN_ID)`. Si está ausente o NaN en runtime, el domain del cliente NO matcheará (defensa: el server valida igualdad de domain antes de recuperar → 403 SIGNER_MISMATCH). El default dev solo aplica a name/version, NO al chainId (no inventar un chainId).

Agregar al `.env.example` (NO commitear valores secretos; solo placeholders):
```
DELEGATION_EIP712_NAME=WasiAI-a2a Delegation
DELEGATION_EIP712_VERSION=1
# chainId del domain EIP-712 (AC-14). Debe coincidir con el chainId que el
# cliente usa al firmar el typed-data de delegación.
KITE_CHAIN_ID=
```

---

## W0 — Tipos, errores, migration, env (SERIAL, primero)

**Objetivo:** contratos cerrados antes de cualquier lógica. **Cubre:** schema, error taxonomy, env (AC-4/AC-14 base, CD-1..CD-12 estructura).

### W0.1 — `src/types/a2a-key.ts` (modificar — append al final, antes de los error codes block)

Agregar estos tipos (firmas EXACTAS, sin `any`):

```ts
// ============================================================
// DELEGATION (WKH-101 — Fase 2: EIP-712 session keys)
// ============================================================

/** Policy de gasto serializada en el typed-data y en a2a_delegations.policy (JSONB). */
export interface DelegationPolicy {
  max_amount_per_tx: string;   // USD decimal, p.ej. "0.50" (string, sin pérdida float — CD-AB-3)
  max_total_amount: string;    // USD decimal, p.ej. "100.00"
  expires_at: number;          // epoch seconds (uint64)
  allowed_chains: number[];    // uint256[] — lista blanca; VACÍO = sin restricción (DT-3)
  allowed_agent_slugs: string[];
  allowed_registries: string[];
}

/** Mensaje EIP-712 (primaryType = "Delegation"). */
export interface DelegationTypedDataMessage {
  session_key: `0x${string}`;
  policy: DelegationPolicy;
  nonce: `0x${string}`;        // bytes32 hex
}

/** Domain EIP-712 sin verifyingContract (NC-3). */
export interface DelegationEip712Domain {
  name: string;
  version: string;
  chainId: number;
}

/** typed-data completo recibido del cliente (auditoría → typed_data_raw). */
export interface DelegationTypedData {
  domain: DelegationEip712Domain;
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string;         // debe ser 'Delegation'
  message: DelegationTypedDataMessage;
}

export type DelegationStatus = 'active' | 'expired' | 'revoked';

/** Row de a2a_delegations. */
export interface DelegationRow {
  id: string;                  // UUID
  key_id: string;              // UUID parent key
  owner_ref: string;           // desnormalizado (Ownership Guard, CD-2)
  session_key_address: string; // lowercase
  session_token_hash: string;  // SHA-256(token)
  policy: DelegationPolicy;
  total_spent: string;         // NUMERIC → string desde Supabase
  expires_at: string;          // ISO timestamp
  revoked_at: string | null;   // null = activa
  typed_data_raw: DelegationTypedData;
  nonce: string;               // bytes32 hex
  created_at: string;
}

/** Input del POST /auth/delegation. */
export interface CreateDelegationInput {
  typed_data: DelegationTypedData;
  signature: string;
  session_key_address: string;
  policy: DelegationPolicy;
}

/** Respuesta 201 del POST /auth/delegation (token devuelto UNA vez). */
export interface CreateDelegationResponse {
  delegation_id: string;
  session_token: string;       // wasi_a2a_session_<random> — plano, solo en la 201
  expires_at: string;
  policy: DelegationPolicy;
}

/** Item del GET /auth/delegation (sin token, con status derivado). */
export interface DelegationListItem {
  delegation_id: string;
  session_key_address: string;
  policy: DelegationPolicy;
  expires_at: string;
  total_spent: string;
  revoked_at: string | null;
  status: DelegationStatus;
}

/**
 * Contexto compacto de delegación que viaja por la request hasta el débito
 * per-step (DT-11/DT-12). Lo setea el middleware (branch session, W3) en
 * `request.delegationContext`; lo propagan las rutas a compose/orchestrate;
 * lo consume `budgetService.debit` para enrutar al RPC atómico.
 */
export interface DelegationDebitContext {
  delegationId: string;   // a2a_delegations.id
  ownerRef: string;       // = parentKey.owner_ref (Ownership Guard DB-layer)
  keyId: string;          // = parentKey.id (cross-check con la delegación)
  maxAmountPerTx: string; // policy.max_amount_per_tx — AC-7 per-step en budget.debit
}

/** Error codes de delegación (middleware + endpoints). */
export type SessionKeyErrorCode =
  | 'FUNDING_WALLET_NOT_BOUND'
  | 'DELEGATION_SIGNER_MISMATCH'
  | 'DELEGATION_NONCE_REPLAY'
  | 'INVALID_SESSION_TOKEN'
  | 'DELEGATION_REVOKED'
  | 'DELEGATION_EXPIRED'
  | 'DELEGATION_TX_LIMIT_EXCEEDED'
  | 'DELEGATION_TOTAL_LIMIT_EXCEEDED'
  | 'AGENT_KEY_BUDGET_EXHAUSTED'
  | 'DELEGATION_CHAIN_NOT_ALLOWED'
  | 'OWNERSHIP_MISMATCH'
  | 'DELEGATION_NOT_ALLOWED';
```

### W0.2 — `src/types/index.ts`

`export * from './a2a-key.js';` ya existe (línea 740) → `DelegationDebitContext` y demás tipos nuevos de `a2a-key.ts` se re-exportan automáticamente.

**SÍ hay que modificar `index.ts`** (CORRECCIÓN F2.5 — DT-11/DT-12) para enrutar el contexto al débito per-step:

1. **`ComposeRequest`** (`src/types/index.ts:208-237`) — agregar campo opcional al final de la interface:
```ts
  /**
   * WKH-101 (DT-11): contexto de delegación para el débito per-step (steps 2..N).
   * Cuando está presente, budgetService.debit enruta al RPC atómico
   * debit_delegation_and_parent (AC-7 per-step + AC-8/AC-9). undefined → master
   * key (camino actual increment_a2a_key_spend, CD-5 intacto).
   */
  delegationContext?: DelegationDebitContext;
```

2. **`OrchestrateRequest`** (`src/types/index.ts:336-349`) — agregar DOS campos:
```ts
  /** WKH-101 (DT-11): contexto de delegación propagado a composeService.compose. */
  delegationContext?: DelegationDebitContext;
  /**
   * WKH-101 (DT-12): chainId resuelto (request.resolvedChainId), propagado a
   * compose para que el débito per-step de steps 2..N funcione bajo delegación.
   * HOY orchestrate NO pasa chainId a compose → steps 2..N no se debitan.
   * Opción B (recomendada): solo se setea cuando hay delegationContext (path
   * master de orchestrate queda intacto, CD-5).
   */
  chainId?: number;
```

3. Importar `DelegationDebitContext` en `index.ts` si no resuelve por el re-export (debería resolver vía `export *`; si TS se queja, `import type { DelegationDebitContext } from './a2a-key.js';`).

Verificar con `tsc --noEmit` que resuelven.

### W0.3 — `src/services/security/errors.ts` (modificar)

Agregar las error classes nuevas siguiendo el patrón exacto (`readonly code = '...' as const` + `name`). **`FundingWalletNotBoundError` YA existe (L59) — reusar, no duplicar.**

```ts
export class DelegationSignerMismatchError extends Error {
  readonly code = 'DELEGATION_SIGNER_MISMATCH' as const;
  constructor() { super('Delegation signer does not match funding wallet'); this.name = 'DelegationSignerMismatchError'; }
}
export class DelegationNonceReplayError extends Error {
  readonly code = 'DELEGATION_NONCE_REPLAY' as const;
  constructor() { super('Delegation nonce already used'); this.name = 'DelegationNonceReplayError'; }
}
export class DelegationRevokedError extends Error {
  readonly code = 'DELEGATION_REVOKED' as const;
  constructor() { super('Delegation has been revoked'); this.name = 'DelegationRevokedError'; }
}
export class DelegationExpiredError extends Error {
  readonly code = 'DELEGATION_EXPIRED' as const;
  constructor() { super('Delegation has expired'); this.name = 'DelegationExpiredError'; }
}
export class DelegationTxLimitExceededError extends Error {
  readonly code = 'DELEGATION_TX_LIMIT_EXCEEDED' as const;
  constructor() { super('Per-transaction limit exceeded'); this.name = 'DelegationTxLimitExceededError'; }
}
export class DelegationTotalLimitExceededError extends Error {
  readonly code = 'DELEGATION_TOTAL_LIMIT_EXCEEDED' as const;
  constructor() { super('Total delegation budget exceeded'); this.name = 'DelegationTotalLimitExceededError'; }
}
export class DelegationNotAllowedError extends Error {
  readonly code = 'DELEGATION_NOT_ALLOWED' as const;
  constructor() { super('Sub-delegation is not allowed'); this.name = 'DelegationNotAllowedError'; }
}
export class InvalidSessionTokenError extends Error {
  readonly code = 'INVALID_SESSION_TOKEN' as const;
  constructor() { super('Session token not found'); this.name = 'InvalidSessionTokenError'; }
}
export class DelegationChainNotAllowedError extends Error {
  readonly code = 'DELEGATION_CHAIN_NOT_ALLOWED' as const;
  constructor() { super('Chain not in delegation allowed_chains'); this.name = 'DelegationChainNotAllowedError'; }
}
export class AgentKeyBudgetExhaustedError extends Error {
  readonly code = 'AGENT_KEY_BUDGET_EXHAUSTED' as const;
  constructor() { super('Parent agent key budget exhausted'); this.name = 'AgentKeyBudgetExhaustedError'; }
}
```

Extender el union `OwnershipOp` (L139-143) — agregar las nuevas operaciones:
```ts
export type OwnershipOp =
  | 'getBalance'
  | 'deactivate'
  | 'registryUpdate'
  | 'registryDelete'
  | 'delegationRevoke'
  | 'delegationList';
```
> El overload posicional de `logOwnershipMismatch` solo acepta `'getBalance' | 'deactivate'`. Para `delegationRevoke`/`delegationList` usar la **forma objeto**: `logOwnershipMismatch({ op: 'delegationRevoke', resourceId: delegationId, callerOwnerRef: ownerRef })`.

### W0.4 — `supabase/migrations/<TS>_a2a_delegations.sql` + `_down.sql`

Nombre: usar timestamp posterior al último (`20260531000000_*` existe → usar p.ej. `20260601000000_a2a_delegations.sql`). Confirmar con `ls supabase/migrations | tail`.

**Tabla** (schema exacto del work-item L84-103 + precisiones SDD §1.3):
```sql
BEGIN;

CREATE TABLE IF NOT EXISTS a2a_delegations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id              UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  owner_ref           TEXT NOT NULL,
  session_key_address TEXT NOT NULL,
  session_token_hash  TEXT NOT NULL UNIQUE,
  policy              JSONB NOT NULL,
  total_spent         NUMERIC(20,8) NOT NULL DEFAULT 0,
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ,
  typed_data_raw      JSONB NOT NULL,
  nonce               TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_a2a_delegations_key_nonce UNIQUE (key_id, nonce)  -- AC-4/CD-4
);

-- UNIQUE(session_token_hash) ya crea índice btree O(1) para el lookup del hot
-- path (AC-5). El work-item pide idx_a2a_delegations_token_hash explícito; es
-- REDUNDANTE sobre una columna UNIQUE. Decisión SDD §1.3: NO crear el duplicado.
-- (Si el Adversary lo prefiere explícito por trazabilidad, es cosmético.)
CREATE INDEX IF NOT EXISTS idx_a2a_delegations_key_owner
  ON a2a_delegations (key_id, owner_ref);
CREATE INDEX IF NOT EXISTS idx_a2a_delegations_owner
  ON a2a_delegations (owner_ref);
```

**RPC `debit_delegation_and_parent`** (corazón de la HU — CD-8/CD-12). Copiar de `sdd.md` §1.4 (firma completa abajo). **Patrón calcado de `20260529000000_a2a_key_deposits.sql`** (`FOR UPDATE`, `RAISE EXCEPTION 'CODE: detalle'`, `SECURITY DEFINER`, hardening):

```sql
CREATE OR REPLACE FUNCTION debit_delegation_and_parent(
  p_delegation_id UUID,
  p_owner_ref     TEXT,
  p_key_id        UUID,
  p_chain_id      INT,
  p_amount_usd    NUMERIC
) RETURNS NUMERIC AS $$
DECLARE
  v_owner     TEXT;
  v_key_id    UUID;
  v_revoked   TIMESTAMPTZ;
  v_expires   TIMESTAMPTZ;
  v_total     NUMERIC;
  v_max_total NUMERIC;
  v_new_total NUMERIC;
BEGIN
  -- 1. Lock de la delegación (FOR UPDATE — serializa débitos concurrentes).
  SELECT owner_ref, key_id, revoked_at, expires_at, total_spent,
         (policy->>'max_total_amount')::NUMERIC
    INTO v_owner, v_key_id, v_revoked, v_expires, v_total, v_max_total
    FROM a2a_delegations
    WHERE id = p_delegation_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELEGATION_NOT_FOUND: %', p_delegation_id;
  END IF;

  -- 2. Ownership Guard a nivel DB (CD-2 — service usa SERVICE_ROLE).
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not owned by caller', p_delegation_id;
  END IF;
  -- 2b. La delegación debe pertenecer a la parent key declarada.
  IF v_key_id IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not bound to key %', p_delegation_id, p_key_id;
  END IF;

  -- 3. Revocación / expiry re-chequeados bajo lock (TOCTOU-safe, CD-10).
  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'DELEGATION_REVOKED: %', p_delegation_id;
  END IF;
  IF NOW() >= v_expires THEN
    RAISE EXCEPTION 'DELEGATION_EXPIRED: %', p_delegation_id;
  END IF;

  -- 4. Check del total acumulado (AC-8/CD-12) ANTES del debit del parent.
  v_new_total := v_total + p_amount_usd;
  IF v_max_total IS NOT NULL AND v_new_total > v_max_total THEN
    RAISE EXCEPTION 'DELEGATION_TOTAL_LIMIT_EXCEEDED: % + % > %', v_total, p_amount_usd, v_max_total;
  END IF;

  -- 5. Debit del parent budget reusando la fn existente (AC-9/DT-5).
  --    increment_a2a_key_spend RAISE 'INSUFFICIENT_BUDGET' si no alcanza →
  --    se propaga, toda la tx hace ROLLBACK (total_spent no se incrementa).
  PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);

  -- 6. Recién acá incrementamos total_spent (orden 4→5→6 defensivo).
  UPDATE a2a_delegations SET total_spent = v_new_total WHERE id = p_delegation_id;

  RETURN v_new_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Hardening obligatorio (patrón 20260427160000 / 20260529000000).
ALTER FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric)
  TO service_role;

COMMIT;
```

**`_down.sql`:**
```sql
BEGIN;
DROP FUNCTION IF EXISTS debit_delegation_and_parent(uuid, text, uuid, integer, numeric);
DROP TABLE IF EXISTS a2a_delegations;
COMMIT;
```

### W0.5 — `.env.example`

Agregar las 3 vars (§5). Ubicarlas cerca de las otras vars de auth/chain.

**DoD W0:** `tsc --noEmit` verde (tipos resuelven, re-export OK); migration parsea (revisión manual de sintaxis SQL contra el exemplar); error classes exportadas.

---

## W1 — `src/services/delegation.ts` (nuevo) — service core + EIP-712 + RPC

**Objetivo:** toda la lógica de creación/verificación/lookup/revoke/list/débito. **Cubre:** AC-1, AC-3, AC-4, AC-5(lookup), AC-9, AC-10, AC-11, AC-12, CD-1, CD-2, CD-12.

Imports: `crypto` (node), `supabase` (`../lib/supabase.js`), `recoverTypedDataAddress` (`viem` `[VERIFY-AT-IMPL]`), tipos (`../types/index.js`), error classes (`./security/errors.js`), `logOwnershipMismatch`.

### Firmas EXACTAS (sin `any`):

```ts
// ── EIP-712 builders (CD-6, leen env) ──
function buildDomain(): DelegationEip712Domain {
  return {
    name: process.env.DELEGATION_EIP712_NAME ?? 'WasiAI-a2a Delegation',
    version: process.env.DELEGATION_EIP712_VERSION ?? '1',
    chainId: Number(process.env.KITE_CHAIN_ID),
  };
}

// types EIP-712 — [VERIFY-AT-IMPL] que viem acepta este shape con `as const`
const DELEGATION_TYPES = {
  Delegation: [
    { name: 'session_key', type: 'address' },
    { name: 'policy', type: 'DelegationPolicy' },
    { name: 'nonce', type: 'bytes32' },
  ],
  DelegationPolicy: [
    { name: 'max_amount_per_tx', type: 'string' },
    { name: 'max_total_amount', type: 'string' },
    { name: 'expires_at', type: 'uint64' },
    { name: 'allowed_chains', type: 'uint256[]' },
    { name: 'allowed_agent_slugs', type: 'string[]' },
    { name: 'allowed_registries', type: 'string[]' },
  ],
} as const;

export const delegationService = {
  /**
   * Recupera el firmante del typed-data EIP-712 (AC-1/AC-3).
   * Valida domain == server domain ANTES de recuperar (domain binding, DT-1).
   * [VERIFY-AT-IMPL] firma exacta de recoverTypedDataAddress en viem v2.
   * Throws DelegationSignerMismatchError si el recover falla o domain diverge.
   */
  async verifyTypedData(
    typedData: DelegationTypedData,
    signature: string,
  ): Promise<`0x${string}`>;

  /**
   * Crea la delegación (AC-1/AC-3/AC-4). El handler ya validó funding_wallet (AC-2).
   * Pasos: verifyTypedData → comparar signer.toLowerCase() === parentKey.funding_wallet
   * → validar policy ≡ typed_data.message.policy y expires_at coherente → generar
   * token + hash → INSERT (mapear 23505 → DelegationNonceReplayError).
   * `owner_ref` se copia de parentKey.owner_ref (NO del request).
   */
  async create(
    parentKey: A2AAgentKeyRow,
    input: CreateDelegationInput,
  ): Promise<CreateDelegationResponse>;

  /**
   * Lookup del hot path por hash del token (AC-5).
   * NOTA PARA AR-CR: NO lleva .eq('owner_ref', ...) a propósito (DT-6) — el caller
   * se autentica CON el token; el owner se deriva del row. Igual que
   * identityService.lookupByHash (identity.ts:89-103). NO es IDOR.
   * PGRST116 → null.
   */
  async lookupByTokenHash(hash: string): Promise<DelegationRow | null>;

  /**
   * Carga la parent key del branch de delegación (DT-9). Lectura interna
   * server-side, sin owner gate (el owner ya fue validado al crear la delegación;
   * el caller no eligió el key_id — sale del row que autenticó con su token).
   * NOTA PARA AR-CR: no es IDOR (key_id proviene del row de la delegación).
   */
  async getParentKey(keyId: string): Promise<A2AAgentKeyRow | null>;

  /** Listado del owner con status derivado (AC-11). Ownership Guard: .eq('owner_ref', ownerRef). */
  async list(ownerRef: string): Promise<DelegationListItem[]>;

  /**
   * Revoca (AC-10/AC-12). Ownership Guard: UPDATE revoked_at=now()
   * .eq('id', delegationId).eq('owner_ref', ownerRef).select('id').
   * 0 rows → logOwnershipMismatch({op:'delegationRevoke',...}) + OwnershipMismatchError.
   * Idempotente: si ya estaba revocada, devolver OK (no error).
   */
  async revoke(delegationId: string, ownerRef: string): Promise<void>;

  /**
   * Débito atómico doble (AC-8/AC-9/CD-12). SOLO invoca el RPC; mapea errores
   * por prefijo de mensaje (patrón budget.ts:91-101). Devuelve el nuevo total_spent.
   * Mapeos: 'DELEGATION_TOTAL_LIMIT_EXCEEDED' → DelegationTotalLimitExceededError;
   * 'INSUFFICIENT_BUDGET' → AgentKeyBudgetExhaustedError;
   * 'DELEGATION_REVOKED' → DelegationRevokedError;
   * 'DELEGATION_EXPIRED' → DelegationExpiredError;
   * 'OWNERSHIP_MISMATCH' → OwnershipMismatchError; otro → Error genérico.
   */
  async debitDelegationAndParent(
    delegationId: string,
    ownerRef: string,
    keyId: string,
    chainId: number,
    amountUsd: number,
  ): Promise<string>;
};

/**
 * Helper PURO (AC-7) — POR STEP. Compara stepCost vs max_amount_per_tx.
 * Recibe el límite como STRING (no la policy entera) para poder llamarlo
 * tanto desde el middleware (step 0, con policy en mano) como desde
 * budget.debit (steps 2..N, con solo maxAmountPerTx en el DelegationDebitContext).
 * CD-AB-3: NO usar Number()/parseFloat de forma lossy. Comparar decimal seguro.
 * Devuelve true si el costo SUPERA el límite (caller hace throw/403).
 */
export function exceedsPerTxLimit(maxAmountPerTx: string, stepCostUsd: number): boolean;
```

> **CORRECCIÓN F2.5 — la firma cambió** respecto al borrador anterior (era `(policy, estimatedCostUsd)`). Ahora recibe `maxAmountPerTx: string` directo. El middleware (step 0) lo llama con `delegation.policy.max_amount_per_tx`; `budget.debit` (steps 2..N) lo llama con `delegationContext.maxAmountPerTx`. AC-7 se enforza **per-step** en CADA débito, no solo en step 0.

### Detalles de implementación obligatorios:

- **Token (DT-5):** `crypto.randomBytes(48).toString('hex')` → `wasi_a2a_session_<96hex>`. `hash = crypto.createHash('sha256').update(token).digest('hex')`. Persistir `session_token_hash`, devolver `session_token` solo en la 201.
- **Domain binding:** en `verifyTypedData`, comparar `typedData.domain.name/version/chainId` contra `buildDomain()`. Si difiere → `DelegationSignerMismatchError` (no recuperar). Pasar `typedData.message` tal cual al recover. Envolver el recover en try/catch → catch → `DelegationSignerMismatchError`.
- **`create` valida policy:** `input.policy` debe ser igual a `input.typed_data.message.policy` (la policy del typed-data firmado es la que gobierna; CD-3). `expires_at` de la columna se deriva de `policy.expires_at` (epoch seconds → ISO). Validar `expires_at` futuro.
- **INSERT:** `owner_ref` y `key_id` salen de `parentKey`, NUNCA del request. Mapear error `23505` → `DelegationNonceReplayError`.
- **`exceedsPerTxLimit`:** comparación decimal segura. Aceptable: comparar como strings normalizadas o con una librería de decimal si existe en el repo; **NO** convertir `max_amount_per_tx` a float64 si introduce pérdida. Confirmar si el repo ya tiene un util decimal; si no, comparar con cuidado (el `estimatedCostUsd` ya es `number` del pipeline — el riesgo está en el lado del string de la policy).

**DoD W1:** `tsc --noEmit` verde; service exporta todas las firmas; sin `any`/`as unknown` (salvo cast viem si `[VERIFY-AT-IMPL]` lo exige y está documentado).

---

## W2 — Endpoints REST en `src/routes/auth.ts` (modificar)

**Objetivo:** los 3 endpoints. **Cubre:** AC-1, AC-2, AC-10, AC-11, AC-12, AC-15/CD-9.

Patrón de cada handler: **clonar `POST /erc8004/bind` (auth.ts:453-624)** para input validation + error_code map + `resolveCallerKey` + try/catch con `instanceof`.

### `POST /auth/delegation`
```
1. callerKey = await resolveCallerKey(req); if (!callerKey?.is_active) → 403 'Invalid or inactive API key'.
2. CD-9/AC-15: si el rawKey autenticador es session token → 403 DELEGATION_NOT_ALLOWED, 0 rows.
   ⚠ resolveCallerKey hace lookupByHash sobre a2a_agent_keys; un session token NO matchea →
   callerKey = null → ya cae en el 403 del paso 1. PERO para emitir el code EXACTO
   DELEGATION_NOT_ALLOWED, detectar el prefijo ANTES: extraer rawKey con el mismo branch
   (x-a2a-key > Bearer) y si startsWith('wasi_a2a_session_') → 403 DELEGATION_NOT_ALLOWED.
   Implementar un helper local rawKeyFromRequest(req) o inline el branch (auth.ts:104-116).
3. AC-2: if (!callerKey.funding_wallet) → 403 FUNDING_WALLET_NOT_BOUND.
4. Validar input body: typed_data (objeto con domain/types/primaryType==='Delegation'/message),
   signature (string no vacío), session_key_address (ADDRESS_RE existente, auth.ts:49),
   policy (campos requeridos, tipos). Falla → 400 INVALID_INPUT.
5. try { result = await delegationService.create(callerKey, input); return 201 result; }
   catch:
     DelegationSignerMismatchError → 403 DELEGATION_SIGNER_MISMATCH
     DelegationNonceReplayError    → 409 DELEGATION_NONCE_REPLAY
     (FundingWalletNotBoundError si create lo re-valida → 403)
     default → 500 DELEGATION_CREATE_FAILED (log con errorClass, sin token/firma).
```

### `DELETE /auth/delegation/:id`
```
1. callerKey = resolveCallerKey; if (!callerKey?.is_active) → 403.
2. (opcional) rechazar session token igual que arriba — la revocación es operación de owner.
3. try { await delegationService.revoke(req.params.id, callerKey.owner_ref); return 200 { revoked: true }; }
   catch OwnershipMismatchError → 403 OWNERSHIP_MISMATCH; default → 500.
```

### `GET /auth/delegation`
```
1. callerKey = resolveCallerKey; if (!callerKey?.is_active) → 403.
2. const items = await delegationService.list(callerKey.owner_ref); return 200 { delegations: items };
```

**DoD W2:** `tsc --noEmit` verde; handlers registrados en el plugin `authRoutes`; mocks de `delegation.js` agregados a `auth.test.ts` (CD-AB-1).

---

## W3 — Branch session en `src/middleware/a2a-key.ts` (modificar)

**Objetivo:** detectar el prefijo session y enforcear en hot path. **Cubre:** AC-5, AC-6, AC-7, AC-8, AC-9, AC-13/CD-5, AC-14 (chain), DT-3, CD-8, CD-10, CD-12.

### Augmentation (extender el `declare module 'fastify'`, a2a-key.ts:27-34):
```ts
declare module 'fastify' {
  interface FastifyRequest {
    // ...existentes...
    delegationRow?: DelegationRow;            // WKH-101
    delegationContext?: DelegationDebitContext; // WKH-101 DT-11 (débito per-step)
  }
}
```

### Punto de inserción (CRÍTICO, DT-5/DT-10):
El branch va **después** de extraer `rawKey` (a2a-key.ts:103-117) y **antes** de la resolución master-key (a2a-key.ts:140 `let keyRow: ... = null`). El regex Bearer YA captura `wasi_a2a_session_*` (empieza con `wasi_a2a_`), NO tocar el regex.

```ts
// después del bloque `if (!rawKey) { runX402Fallback; return; }` (a2a-key.ts:119-123)
// y después de calcular estimatedCostUsd (a2a-key.ts:133-138):

if (rawKey.startsWith('wasi_a2a_session_')) {
  // ── BRANCH DELEGACIÓN (WKH-101) ──
  try {
    // 1. lookup por hash (AC-5)
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const delegation = await delegationService.lookupByTokenHash(hash);
    if (!delegation) {
      return reply.status(401).send({ error: 'Session token not found', error_code: 'INVALID_SESSION_TOKEN' });
    }
    // 2. revoked / expired (AC-6) — pre-debit (re-chequeado bajo lock en RPC, CD-10)
    if (delegation.revoked_at !== null) return send403delegation(reply, 'DELEGATION_REVOKED', ...);
    if (Date.now() >= new Date(delegation.expires_at).getTime()) return send403delegation(reply, 'DELEGATION_EXPIRED', ...);
    // 3. cargar parent key (DT-9)
    const parentKey = await delegationService.getParentKey(delegation.key_id);
    if (!parentKey || !parentKey.is_active) return send403delegation(reply, 'KEY_INACTIVE', ...);
    // 4. resolver chain/bundle → chainId — REUSAR el bloque existente (a2a-key.ts:188-235).
    //    Extraer ese bloque a un helper local resolveChainForRequest(request, reply)
    //    o duplicar con cuidado. Setear request.resolvedChainId = chainId.
    // 5. DT-3 allowed_chains: si policy.allowed_chains.length > 0 && !includes(chainId)
    //    → 403 DELEGATION_CHAIN_NOT_ALLOWED. VACÍO = sin restricción.
    // 6. AC-7 per-tx del STEP 0:
    //    if (exceedsPerTxLimit(delegation.policy.max_amount_per_tx, estimatedCostUsd))
    //    → 403 DELEGATION_TX_LIMIT_EXCEEDED.
    // 7. AC-8/AC-9 débito ATÓMICO del STEP 0 (CD-12):
    //    await delegationService.debitDelegationAndParent(
    //       delegation.id, parentKey.owner_ref, parentKey.id, chainId, estimatedCostUsd);
    //    catch DelegationTotalLimitExceededError → 403 DELEGATION_TOTAL_LIMIT_EXCEEDED
    //          AgentKeyBudgetExhaustedError      → 403 AGENT_KEY_BUDGET_EXHAUSTED
    //          DelegationRevokedError            → 403 DELEGATION_REVOKED (TOCTOU)
    //          DelegationExpiredError            → 403 DELEGATION_EXPIRED (TOCTOU)
    //          OwnershipMismatchError            → 403 OWNERSHIP_MISMATCH
    // 8. augment + SET delegationContext para los steps 2..N (DT-11):
    //    const effectiveRow = { ...parentKey, allowed_registries:..., allowed_agent_slugs:... }; // ver W4 scoping
    //    effectiveRow.erc8004_verified = isIdentityVerified(parentKey);
    //    request.a2aKeyRow = effectiveRow;
    //    request.delegationRow = delegation;
    //    request.delegationContext = {
    //       delegationId: delegation.id,
    //       ownerRef: parentKey.owner_ref,
    //       keyId: parentKey.id,
    //       maxAmountPerTx: delegation.policy.max_amount_per_tx,
    //    };  // ← imprescindible: las rutas lo propagan a compose para el débito per-step
    //    reply.header('x-a2a-remaining-budget', await budgetService.getBalance(parentKey.id, chainId, parentKey.owner_ref));
    return; // fin del branch — NO seguir al flujo master key
  } catch (err) {
    // log sin token; 503 service error (igual que el catch master, a2a-key.ts:295-307)
    return reply.status(503).send({ error: 'SERVICE_ERROR', message: 'Delegation service temporarily unavailable' });
  }
}
// ── flujo master key EXISTENTE, INTACTO (a2a-key.ts:140+) ──
```

> **Reuso de la resolución de chain (a2a-key.ts:188-235):** el bloque que resuelve `chainKey`/`bundle`/`chainId` es idéntico en ambos branches. **Refactorizar a un helper privado** `resolveTargetChain(request, reply): { chainId: number; chainKey: string; assetSymbol: string } | null` (devuelve null si ya envió respuesta de error) para no duplicar y no divergir. Si el refactor es riesgoso para backward-compat, duplicar el bloque PERO documentar que ambos deben mantenerse sincronizados. **No cambiar el comportamiento del master path (CD-5).**

> **`send403delegation`:** el `send403` existente (a2a-key.ts:49-55) tiene un union de codes acotado que NO incluye los de delegación. Crear un helper paralelo o ensanchar el tipo. Mantener el shape `{ error, error_code }` consistente.

> **Import nuevo:** `import { delegationService, exceedsPerTxLimit } from '../services/delegation.js';` — esto rompe los mocks de `a2a-key.test.ts` (CD-AB-1): agregar `vi.mock('../services/delegation.js', () => ({ delegationService: { lookupByTokenHash: vi.fn(), getParentKey: vi.fn(), debitDelegationAndParent: vi.fn() }, exceedsPerTxLimit: vi.fn() }))`.

**DoD W3:** `tsc --noEmit` verde; master key tests existentes (`a2a-key.test.ts`) siguen verdes; nuevo branch cubierto por tests T5/T6/T7/T17.

---

## W4 — Débito per-step delegation-aware (DT-11/DT-12) + scoping per-agent — CORRECCIÓN F2.5

**Objetivo:** cerrar el gap de correctitud — que AC-7 (`max_amount_per_tx`) y AC-8 (`max_total_amount`) se enforceen **per-step** (no solo en step 0), y que `allowed_agent_slugs`/`allowed_registries` se enforceen per-step (scoping). **Cubre:** AC-7 per-step, AC-8 per-step, AC-9 per-step, DT-7 (scoping). CD-5/CD-8/CD-12 preservados.

### Por qué (el gap, en una frase)
`/compose` y `/orchestrate` debitan el budget **por step** (`budgetService.debit`, `compose.ts:158`). Si la delegación solo enforzara el total en step 0, una session key gastaría **más que `max_total_amount`** repartido en varios steps → **bypass de AC-8**. La solución: la ruta de débito es delegation-aware.

### W4.1 — `src/services/budget.ts`: `debit` delegation-aware (corazón del fix)

Extender `debit(...)` con un 4º parámetro **opcional** `delegationContext` (backward-compat: master key no lo pasa). Call-site real verificado: `src/services/budget.ts:48-64`.

```ts
import { delegationService, exceedsPerTxLimit } from './delegation.js';
import {
  DelegationTotalLimitExceededError,
  AgentKeyBudgetExhaustedError,
  DelegationRevokedError,
  DelegationExpiredError,
  OwnershipMismatchError,
} from './security/errors.js';
import type { DelegationDebitContext } from '../types/index.js';

async debit(
  keyId: string,
  chainId: number,
  amountUsd: number,
  delegationContext?: DelegationDebitContext,   // ← NUEVO opcional (DT-11)
): Promise<{ success: boolean; error?: string }> {
  // ── RUTA DELEGACIÓN (DT-11) ──
  if (delegationContext) {
    // AC-7 PER-STEP: per-tx ANTES del RPC (no necesita lock).
    if (exceedsPerTxLimit(delegationContext.maxAmountPerTx, amountUsd)) {
      return { success: false, error: 'DELEGATION_TX_LIMIT_EXCEEDED' };
    }
    // AC-8 + AC-9 ATÓMICO: el RPC chequea+debita total_spent y parent budget.
    try {
      await delegationService.debitDelegationAndParent(
        delegationContext.delegationId,
        delegationContext.ownerRef,
        delegationContext.keyId,
        chainId,
        amountUsd,
      );
      return { success: true };
    } catch (err) {
      // Mapear a { success:false, error:<code> } para que compose corte el
      // pipeline (mismo shape que la ruta master). NO re-lanzar.
      if (err instanceof DelegationTotalLimitExceededError) return { success: false, error: 'DELEGATION_TOTAL_LIMIT_EXCEEDED' };
      if (err instanceof AgentKeyBudgetExhaustedError)      return { success: false, error: 'AGENT_KEY_BUDGET_EXHAUSTED' };
      if (err instanceof DelegationRevokedError)            return { success: false, error: 'DELEGATION_REVOKED' };
      if (err instanceof DelegationExpiredError)            return { success: false, error: 'DELEGATION_EXPIRED' };
      if (err instanceof OwnershipMismatchError)            return { success: false, error: 'OWNERSHIP_MISMATCH' };
      return { success: false, error: err instanceof Error ? err.message : 'DELEGATION_DEBIT_FAILED' };
    }
  }
  // ── RUTA MASTER KEY — INTACTA (camino actual, CD-5) ──
  const { error } = await supabase.rpc('increment_a2a_key_spend', {
    p_key_id: keyId,
    p_chain_id: chainId,
    p_amount_usd: amountUsd,
  });
  if (error) return { success: false, error: error.message };
  return { success: true };
}
```

> **⚠ CD-AB-1 / circular-import watch:** `budget.ts` ahora importa `delegation.ts`, y `delegation.ts` NO debe importar `budget.ts` (evitar ciclo). `delegation.ts` solo importa `supabase`/`crypto`/`viem`/tipos/errores → sin ciclo. Verificar con `tsc --noEmit`. Los test files que mockean `../services/budget.js` (`a2a-key.test.ts`, `compose.test.ts`) NO se rompen porque la firma de `debit` solo AGREGA un param opcional. **PERO** `budget.test.ts` (si existe) ahora necesita `vi.mock('../services/delegation.js', ...)`. Confirmar con `grep -rn "services/budget" src/**/*.test.ts` qué suites tocar.

### W4.2 — Propagar `delegationContext` (y `chainId`) hasta el loop de compose

**Cambios quirúrgicos línea-a-línea (relajación documentada de "PROHIBIDO tocar"):**

| Archivo:línea real | Cambio EXACTO | Por qué imprescindible |
|--------------------|---------------|------------------------|
| `src/services/compose.ts:158` | `budgetService.debit(scopingKeyRow.id, chainId, debitAmount, request.delegationContext)` — agregar el 4º arg. **El guard `i > 0 && scopingKeyRow && chainId !== undefined` (compose.ts:130) NO cambia.** | Pasar el contexto al débito per-step. Master key → `request.delegationContext` undefined → ruta `increment_a2a_key_spend` intacta (CD-5). |
| `src/routes/compose.ts:153-167` | Agregar al objeto `composeService.compose({...})`: `delegationContext: request.delegationContext,` | Inyectar el contexto desde la request (lo setea el middleware branch session, W3). |
| `src/routes/orchestrate.ts:71-81` | Agregar a `orchestrateService.orchestrate({...})`: `delegationContext: request.delegationContext,` y `chainId: request.resolvedChainId,` | Propagar a orchestrate. |
| `src/services/orchestrate.ts:405-410` | Agregar a `composeService.compose({...})`: `delegationContext: request.delegationContext,` **+ `chainId` (DT-12, opción B):** `chainId: request.delegationContext ? request.chainId : undefined,` | **BUG PREEXISTENTE:** orchestrate HOY no pasa `chainId` a compose (orchestrate.ts:405-410) → el guard `chainId !== undefined` (compose.ts:130) hace que steps 2..N de orchestrate NO se debiten. Para que el débito per-step de delegación funcione en orchestrate, hay que pasar el chainId. **Opción B (recomendada):** SOLO bajo delegación, dejando el path master de orchestrate INTACTO (CD-5 estricto). |

> **DT-12 — DECISIÓN-REVISABLE (escalar al orquestador antes de codear):** la opción B (chainId solo bajo delegación) preserva CD-5 al 100% pero deja como deuda técnica que las **master keys en `/orchestrate` no debitan steps 2..N** (under-charge preexistente, NO introducido por esta HU). La opción A (chainId siempre) lo corregiría pero **cambia el comportamiento del path master en orchestrate** → puede romper tests e2e de orchestrate. **El Dev implementa B** salvo que el orquestador indique A. Documentar la TD del under-charge de orchestrate-master como `TD-WKH-101-ORCH` para una HU futura.

### W4.3 — Scoping per-agent (DT-7, enforcement adicional)

**Hallazgo de `src/services/authz.ts` (leído):** `authzService.checkScoping(keyRow, target): AuthzResult` es una función **PURA, síncrona, sin DB** que lee `allowed_registries`/`allowed_agent_slugs`/`allowed_categories` del `keyRow` (cada uno si es no-null y `.length > 0`). `composeService.compose` la invoca con `scopingKeyRow` (= `request.a2aKeyRow`) en `compose.ts:83-108`; `orchestrate.ts:409` propaga el mismo `scopingKeyRow`.

**Implementación (en W3 paso 8 del middleware):** inyectar el `effectiveRow` (spread de parentKey con los `allowed_*` de la policy) como `request.a2aKeyRow`:

```ts
const effectiveRow: A2AAgentKeyRow = {
  ...parentKey,
  allowed_registries: delegation.policy.allowed_registries.length > 0
    ? delegation.policy.allowed_registries : null,
  allowed_agent_slugs: delegation.policy.allowed_agent_slugs.length > 0
    ? delegation.policy.allowed_agent_slugs : null,
};
effectiveRow.erc8004_verified = isIdentityVerified(parentKey);
request.a2aKeyRow = effectiveRow;
```
Así `composeService.compose` aplica el scoping de la delegación SIN tocar `compose.ts`/`authz.ts`/`orchestrate.ts`. Lista vacía → `null` → `checkScoping` no restringe (paridad con master keys, coherente con DT-3).

> **Nota de consistencia del id:** `compose.ts:158` usa `scopingKeyRow.id` (= `parentKey.id`, preservado por el spread) → el débito per-step va contra la parent key correcta, y el `delegationContext.keyId` (= `parentKey.id`) cruza correctamente en el RPC (defensa `v_key_id IS DISTINCT FROM p_key_id`, §1.4 paso 2b).

**Archivos W4:** `src/services/budget.ts` (W4.1), `src/services/compose.ts:158` (1 línea), `src/routes/compose.ts:153` (1 línea), `src/routes/orchestrate.ts:71` (2 líneas), `src/services/orchestrate.ts:405` (2 líneas), `src/middleware/a2a-key.ts` (effectiveRow + delegationContext, ya en W3). El scoping NO toca `authz.ts`.

**DoD W4:**
- `tsc --noEmit` verde (sin ciclo budget↔delegation).
- Test per-step: T7b (per-tx en step 2..N), T8b (multi-step total → corte a mitad).
- Test de scoping per-agent (session key con `allowed_agent_slugs` restringido → step denegado SCOPE_DENIED).
- `compose.test.ts` y suites de orchestrate existentes NO rotas (master key path intacto — `delegationContext` undefined).

---

## W5 — Tests (cierre)

**Archivos:**
- `src/services/delegation.test.ts` (nuevo) — unit del service + EIP-712 + RPC mapeo.
- `src/routes/auth.delegation.test.ts` (nuevo) — los 3 endpoints + AC-15.
- extensión de `src/middleware/a2a-key.test.ts` — branch session, AC-5/6/7/8/9/13, T17/T18/T19.
- `src/services/budget.test.ts` (nuevo o extensión) — `debit` delegation-aware: ruta delegación vs master (T7b, T14), mapeo de errores del RPC.
- `src/services/compose.test.ts` (extensión) — débito per-step bajo delegación, corte multi-step (T8b). Mockear `../services/budget.js` (la firma extendida es backward-compat).

**Mock pattern (CD-AB-1/CD-AB-2):** seguir `a2a-key.test.ts:21-40` — `vi.mock('../services/identity.js'...)`, `vi.mock('../services/budget.js'...)`. Agregar `vi.mock('../services/delegation.js', ...)` con TODOS los exports. Para `delegation.test.ts` (que mockea supabase): builders supabase con `mockImplementation`+contador (≥2 queries en `create`), castear con `as unknown as ReturnType<typeof supabase.from>` (NO `as` directo → TS2352). Mockear `recoverTypedDataAddress` de viem.

| # | AC/Ataque | Archivo | Caso / Aserción |
|---|-----------|---------|-----------------|
| T1 | AC-1 | delegation.test + auth.delegation.test | create happy: recover==funding_wallet → 201 `{delegation_id, session_token (prefijo wasi_a2a_session_), expires_at, policy}`; hash persistido, token NO. |
| T2 | AC-2 | auth.delegation.test | funding_wallet null → 403 FUNDING_WALLET_NOT_BOUND, 0 inserts. |
| T3 | AC-3 | delegation.test | signer != funding_wallet → DelegationSignerMismatchError → 403, 0 rows. |
| T4 | AC-4 | delegation.test | 2º create mismo (key_id,nonce) → 23505 → DelegationNonceReplayError → 409. |
| T5 | AC-5 | a2a-key.test | token wasi_a2a_session_ válido → branch + lookup OK; token inexistente → 401 INVALID_SESSION_TOKEN. |
| T6 | AC-6 | a2a-key.test | revoked_at!=null → 403 DELEGATION_REVOKED; now()>=expires_at → 403 DELEGATION_EXPIRED. |
| T7 | AC-7 (step 0) | a2a-key.test | `estimatedCostUsd > max_amount_per_tx` en el branch session del middleware → 403 DELEGATION_TX_LIMIT_EXCEEDED (antes de debitar). |
| T7b | AC-7 per-step | budget.test | `budgetService.debit(keyId, chainId, amount, ctx)` con `ctx.maxAmountPerTx='0.50'` y `amount=1.00` → `{success:false, error:'DELEGATION_TX_LIMIT_EXCEEDED'}` y **NO** invoca `debitDelegationAndParent` (per-tx se chequea ANTES del RPC). |
| T8 | AC-8 (step 0) | delegation.test (RPC mapeo) | RPC RAISE DELEGATION_TOTAL_LIMIT_EXCEEDED → DelegationTotalLimitExceededError → 403; total_spent no cambia. |
| T8b | AC-8 MULTI-STEP | compose.test | compose con 3 steps bajo `delegationContext`, `max_total` alcanza para 2 steps: `budgetService.debit` mock devuelve success en steps previos y `{success:false, error:'DELEGATION_TOTAL_LIMIT_EXCEEDED'}` en el step que excede → `composeService.compose` retorna `ComposeResult.error` EN ESE STEP (results.length = steps ejecutados, los posteriores NO se ejecutan ni debitan). **Aserción clave: el corte es a mitad de camino, NO después** — `budget.debit` no se invoca para los steps posteriores al que excede; `invokeAgent` tampoco. |
| T9 | AC-9 | delegation.test | RPC RAISE INSUFFICIENT_BUDGET → AgentKeyBudgetExhaustedError → 403; total_spent no cambia. Vía budget.debit (ruta delegación) → `{success:false, error:'AGENT_KEY_BUDGET_EXHAUSTED'}`. |
| T10 | AC-9 | delegation.test | aislamiento: débito exitoso incrementa total_spent (RPC RETURN) y debita parent (PERFORM). |
| T11 | AC-10 | auth.delegation.test + a2a-key.test | DELETE → revoke OK 200; request posterior con token → 403 REVOKED. |
| T12 | AC-11 | auth.delegation.test | GET devuelve solo del owner, con status derivado (active/expired/revoked). |
| T13 | AC-12 | delegation.test | revoke/list owner ajeno → OwnershipMismatchError → 403; RPC owner_ref ajeno → OWNERSHIP_MISMATCH. |
| T14 | AC-13 | a2a-key.test + budget.test | master key (sin prefijo session) → flujo idéntico actual; `budgetService.debit` SIN `delegationContext` → `increment_a2a_key_spend` (NO llama `debitDelegationAndParent`); compose per-step con `request.delegationContext === undefined` → ruta master intacta. (backward-compat) |
| T15 | AC-14 | delegation.test | buildDomain usa DELEGATION_EIP712_NAME/VERSION + KITE_CHAIN_ID; domain divergente → no recover/mismatch. |
| T16 | AC-15 | auth.delegation.test | POST /auth/delegation con token wasi_a2a_session_ → 403 DELEGATION_NOT_ALLOWED, 0 rows. |
| T17 | Ataque DT-3 | a2a-key.test | allowed_chains=[X] y resolvedChainId=Y → 403 DELEGATION_CHAIN_NOT_ALLOWED; allowed_chains=[] → SIN restricción (pasa). |
| T18 | Ataque race | delegation.test | dos debitDelegationAndParent concurrentes → atómico previene exceder max_total (uno pasa, otro lanza TOTAL). |
| T19 | Ataque TOCTOU | delegation.test | revoke entre lookup y debit → RPC re-chequea bajo lock → DelegationRevokedError. |
| T20 | Ataque domain | delegation.test | firma de otro name/version/chainId → domain mismatch o recover != funding_wallet → DelegationSignerMismatchError. |

**DoD W5 (y de la HU):**
- `npx tsc --noEmit` verde (NO solo `tsconfig.build.json` — detectar fixtures rotos, CD-AB-5).
- `npm run lint` verde.
- `npm test` (vitest) verde — T1–T20 + **T7b/T8b (per-step)** + suites existentes (`a2a-key.test.ts`, `auth.test.ts`, `auth.erc8004.test.ts`, `compose.test.ts`, `budget.test.ts`) NO rotas.
- `grep -rn "wasi_a2a_session_\|delegation" src/__tests__/e2e` revisado (CD-AB-4) — e2e no asume comportamiento viejo de 401/403 en rutas autenticadas.
- **CD-AB-4 extra:** `grep -rn "budgetService.debit\|services/budget" src/**/*.test.ts` — verificar que las suites que mockean `budget.js` (`compose.test.ts`, `a2a-key.test.ts`) no se rompen con el 4º param opcional, y que `budget.test.ts` mockea `../services/delegation.js`.
- Cobertura: 15 ACs con ≥1 test + 4 ataques (T17–T20) + 2 per-step (T7b/T8b).

---

## 6. Done Definition (la HU está lista cuando)

- [ ] W0–W5 completas, cada wave con su DoD verde.
- [ ] 15 ACs implementados y testeados; 12 CDs satisfechos; 5 CD-AB respetados.
- [ ] RPC `debit_delegation_and_parent` con hardening (search_path/REVOKE/GRANT) + `_down.sql`.
- [ ] **Enforcement PER-STEP (AC-7/AC-8) verificado:** débito delegation-aware en `budget.debit`; T7b (per-tx step 2..N) y T8b (multi-step total → corte a mitad) verdes. NO hay bypass de `max_total_amount` repartiendo el gasto en varios steps.
- [ ] **DT-12 resuelto:** opción B implementada (chainId a orchestrate solo bajo delegación) salvo indicación contraria del orquestador. TD-WKH-101-ORCH documentada.
- [ ] Token solo hasheado en DB; nunca logueado.
- [ ] Master key path intacto (AC-13 test verde; `budget.debit` sin `delegationContext` → `increment_a2a_key_spend`; compose/orchestrate master sin cambios de comportamiento).
- [ ] Sin `any`/`as unknown` (salvo cast viem documentado + cast mocks supabase en tests). Sin ciclo de import budget↔delegation.
- [ ] `tsc --noEmit` + lint + vitest verdes.
- [ ] `[VERIFY-AT-IMPL]` de viem resuelto y documentado en el código (comentario con la firma confirmada).

---

## 7. Archivos a tocar (Scope IN exhaustivo)

| Archivo | Acción | Wave |
|---------|--------|------|
| `src/types/a2a-key.ts` | modificar (append tipos + `DelegationDebitContext`) | W0 |
| `src/types/index.ts` | modificar (`ComposeRequest.delegationContext`, `OrchestrateRequest.delegationContext`+`chainId`) | W0 |
| `src/services/security/errors.ts` | modificar (10 error classes + union) | W0 |
| `supabase/migrations/<TS>_a2a_delegations.sql` | crear | W0 |
| `supabase/migrations/<TS>_a2a_delegations_down.sql` | crear | W0 |
| `.env.example` | modificar (3 vars) | W0 |
| `src/services/delegation.ts` | crear | W1 |
| `src/routes/auth.ts` | modificar (3 endpoints + helper rawKey) | W2 |
| `src/middleware/a2a-key.ts` | modificar (branch session + augment + helper chain + effectiveRow + delegationContext) | W3/W4 |
| **`src/services/budget.ts`** | **modificar (`debit` delegation-aware, 4º param opcional — DT-11)** | **W4** |
| **`src/services/compose.ts`** | **modificar (1 línea: 4º arg en `debit`, L158)** | **W4** |
| **`src/routes/compose.ts`** | **modificar (1 línea: `delegationContext`, L153)** | **W4** |
| **`src/routes/orchestrate.ts`** | **modificar (2 líneas: `delegationContext`+`chainId`, L71)** | **W4** |
| **`src/services/orchestrate.ts`** | **modificar (2 líneas: `delegationContext`+`chainId` a compose, L405 — DT-12 opción B)** | **W4** |
| `src/services/delegation.test.ts` | crear | W5 |
| `src/routes/auth.delegation.test.ts` | crear | W5 |
| `src/middleware/a2a-key.test.ts` | modificar (branch session) | W5 |
| `src/services/budget.test.ts` | crear/extender (T7b, T14, mapeo RPC) | W5 |
| `src/services/compose.test.ts` | extender (T8b multi-step corte) | W5 |

> **CAMBIOS QUIRÚRGICOS AUTORIZADOS (relajación F2.5 del "PROHIBIDO tocar"):** `compose.ts`/`routes/compose.ts`/`routes/orchestrate.ts`/`services/orchestrate.ts` SE TOCAN **SOLO** lo imprescindible para propagar `delegationContext` (y `chainId` en orchestrate, DT-12 opción B). Cada cambio es **1-2 líneas** documentadas arriba y en `sdd.md` DT-11/DT-12. El loop de compose, los guards (`i>0 && scopingKeyRow && chainId`), y el path master key NO cambian de comportamiento (CD-5). `budget.ts` recibe el branch delegation-aware (el corazón del fix).
>
> **SIGUE PROHIBIDO tocar:** `src/services/authz.ts` (el scoping ya funciona con el `effectiveRow` inyectado — `checkScoping` es pura y lee `allowed_*` del row). Cualquier cambio en compose/orchestrate que NO sea la propagación del contexto/chainId está fuera de scope. NO ampliar a sub-delegación ni Fase 3.
