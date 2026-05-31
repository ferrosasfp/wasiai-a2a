# SDD — WKH-101 · wasiai-agentkey Fase 2: EIP-712 Delegation + Session Key + Server-Side Enforcement

> **Fase:** F2 (Specification-Driven Design) · **Modo:** QUALITY · **Estimación:** L
> **Branch:** `feat/101-wasiai-agentkey-delegation`
> **Input:** `doc/sdd/101-wasiai-agentkey-delegation/work-item.md` (15 ACs EARS + 12 CDs, HU_APPROVED)
> **Ancla de autoridad:** `funding_wallet` (NC-1) · **Auth session:** token opaco `wasi_a2a_session_` (NC-4) · **Revocación:** `revoked_at` (NC-2) · **EIP-712 domain:** sin `verifyingContract` (NC-3)

---

## 0. Context Map — archivos leídos (grounding verificado)

| Archivo | Líneas clave | Qué extraje / patrón a replicar |
|---------|-------------|--------------------------------|
| `src/middleware/a2a-key.ts` | 93-311 | Factory `requirePaymentOrA2AKey`. Resolución del rawKey: `x-a2a-key` > `Authorization: Bearer wasi_a2a_*` (L102-117). Hash SHA-256 (L144), `lookupByHash` (L147), `is_active` (L153), daily-limit (L158-171), per-call (L178-186), resolución de chain/bundle → `chainId = bundle.chainConfig.chainId` (L228), inyección `request.resolvedChainId` (L235), **debit optimista** vía `budgetService.debit(keyId, chainId, estimatedCostUsd)` (L253-257), `request.a2aKeyRow = keyRow` (L285), header `x-a2a-remaining-budget` (L294). `send403(reply, code, message)` helper (L49-55). Augmentation `declare module 'fastify'` (L27-34). **El branch del session token va ANTES de la resolución del rawKey master-key (L140), después de extraer `rawKey`.** |
| `src/services/identity.ts` | 47-103 | `identityService.lookupByHash(keyHash)` (L89-103): `.from('a2a_agent_keys').select('*').eq('key_hash', keyHash).single()`, PGRST116 → null. Patrón de emisión de token: `createKey` (L52-84) genera `wasi_a2a_<32 random bytes hex>` + `SHA-256` + insert. Ownership Guard pattern: `.eq('id', keyId).eq('owner_ref', ownerId).select('id')` + `data.length===0 → OwnershipMismatchError` (L109-124, 136-164). |
| `src/services/budget.ts` | 16-106 | `budgetService.debit(keyId, chainId, amountUsd)` → `supabase.rpc('increment_a2a_key_spend', {...})` (L48-64) devuelve `{success, error?}`. `getBalance(keyId, chainId, ownerId)` con Ownership Guard (L20-42). `registerDeposit` mapea errores PG por prefijo de mensaje → error classes tipadas (L74-105). **Patrón RPC nuevo: usar `supabase.rpc(...)`, mapear `error.message.includes('CODE')` a error class.** |
| `src/services/compose.ts` | 60-327 | `composeService.compose({ steps, scopingKeyRow, chainId, ... })`. Per-step debit `i>0 && scopingKeyRow && chainId` (L130-176) vía `budgetService.debit(scopingKeyRow.id, chainId, debitAmount)`. **El enforcement de delegación per-tx + total debe correr JUNTO a cada debit (step 0 en middleware, steps 2..N acá).** Step 0 ya fue debitado por el middleware (CD-11 guard `i>0`). |
| `src/routes/auth.ts` | 1-707 | Estructura de plugin Fastify. `resolveCallerKey(request)` (L98-127): replica el branch x-a2a-key>Bearer y devuelve `A2AAgentKeyRow|null`. **Patrón "owner firma, server verifica con viem"**: `/funding-wallet` (L186-257) usa `recoverMessageAddress({ message, signature })` (L214-217) + compara `.toLowerCase()` (L223). `/erc8004/bind` (L453-624): validación de input estricta, error_code map, `try/catch` con instanceof error classes. `ADDRESS_RE` (L49), `TX_HASH_RE` (L277). **Para delegación: `recoverTypedDataAddress` reemplaza `recoverMessageAddress`.** |
| `src/services/security/errors.ts` | 1-202 | Error classes con `readonly code` + `name`. Patrón a replicar para las 9 error classes nuevas. `logOwnershipMismatch` (L154-202) admite forma posicional `(op, keyId, ownerId)` y forma objeto `{op, resourceId, callerOwnerRef, actualOwnerRef?}`. El union `OwnershipOp` (L139-143). |
| `supabase/migrations/20260529000000_a2a_key_deposits.sql` | 1-103 | **Patrón canónico de migration con RPC:** tabla con UNIQUE constraint anti-replay (L17), `FOR UPDATE` lock (L52-56), `RAISE EXCEPTION 'CODE: detalle'` (L59, 64, 78), `EXCEPTION WHEN unique_violation` → traducción a error de negocio (L74-79), `SECURITY DEFINER` (L91), **hardening obligatorio**: `SET search_path = public, pg_temp` + `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE TO service_role` (L96-103). |
| `supabase/migrations/20260406000000_a2a_agent_keys.sql` | 56-121 | `increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd)` con `FOR UPDATE`, lazy daily reset, check budget (`INSUFFICIENT_BUDGET`), debit con `jsonb_set` (L113-119). **Este RPC NO cambia** — la delegación lo invoca tal cual (DT-5). |
| `supabase/migrations/20260531000000_erc8004_token_unique.sql` | 1-25 | Patrón de índice parcial UNIQUE como barrera atómica + defensa en profundidad. `BEGIN;`/`COMMIT;`. |
| `supabase/migrations/20260427160000_secure_rpc_search_path.sql` | 1-25 | Hardening de RPCs SECURITY DEFINER: search_path + REVOKE/GRANT. |
| `src/routes/compose.ts` | 99-184 | `composeService.compose({ scopingKeyRow: request.a2aKeyRow, chainId: request.resolvedChainId, ... })` (L153-167). PreHandler chain: forward-key → timeout → `resolveComposePriceHandler` → `requirePaymentOrA2AKey` (L104-119). |
| `src/types/a2a-key.ts` | 12-144 | `A2AAgentKeyRow` (L34-61) tiene `funding_wallet: string \| null`, `owner_ref`, `budget`. `Erc8004IdentityBinding` como modelo de tipo JSONB. Patrón de error-code union (L133-138). |

**Stack confirmado:** viem `^2.47.6` (package.json) → `recoverTypedDataAddress` disponible en viem v2. Supabase service-role (bypassa RLS → Ownership Guard en app-layer es obligatorio). Fastify. vitest. TypeScript strict (sin `any`, sin `as unknown` salvo el cast documentado de mocks supabase).

---

## 1. Arquitectura

### 1.1 Diagrama de flujo

```
                         CREACIÓN (POST /auth/delegation)
  owner (master key) ──► auth.ts handler
       │                   1. resolveCallerKey → parent keyRow (master, no session)
       │                   2. CD-9/AC-15: si el token es wasi_a2a_session_ → 403 DELEGATION_NOT_ALLOWED
       │                   3. AC-2: parent.funding_wallet null → 403 FUNDING_WALLET_NOT_BOUND
       │                   4. validar input (typed_data, signature, session_key_address, policy)
       │                   5. recoverTypedDataAddress(typed_data, signature) → signer
       │                   6. AC-3: signer.toLowerCase() != funding_wallet → 403 DELEGATION_SIGNER_MISMATCH
       │                   7. validar policy ≡ typed_data.message.policy; expires_at coherente
       │                   8. delegationService.create(...) → INSERT (UNIQUE(key_id,nonce))
       │                        ├─ 23505 → DELEGATION_NONCE_REPLAY (409)  [AC-4/CD-4]
       │                        └─ devuelve { delegation_id, token, expires_at, policy }
       └─◄ 201 { delegation_id, session_token, expires_at, policy }   (token sólo una vez)

                         USO (POST /compose | /orchestrate con session token)
  session client ──► requirePaymentOrA2AKey (middleware)
       │                rawKey extraído (x-a2a-key | Bearer)
       │                ┌─ prefijo wasi_a2a_session_ ?  ────────── SÍ ──────────┐
       │                │  branch DELEGATION                                    │
       │                │   1. hash = SHA-256(token)                            │
       │                │   2. delegationService.lookupByTokenHash(hash)        │
       │                │        └─ null → 401 INVALID_SESSION_TOKEN  [AC-5]    │
       │                │   3. AC-6: revoked_at != null → 403 DELEGATION_REVOKED│
       │                │           now() >= expires_at → 403 DELEGATION_EXPIRED│
       │                │   4. cargar parent keyRow (por key_id, sin owner gate:│
       │                │      lectura interna server-side — ver DT-9)          │
       │                │   5. resolver chain/bundle → chainId (igual master)   │
       │                │   6. AC-7: estimatedCostUsd > policy.max_amount_per_tx │
       │                │           → 403 DELEGATION_TX_LIMIT_EXCEEDED          │
       │                │   7. AC-8/AC-9 (CD-8/CD-12): RPC ATÓMICO              │
       │                │      debit_delegation_and_parent(...)                 │
       │                │        ├─ total_spent+amount > max_total → 403 TOTAL  │
       │                │        ├─ parent budget insuf → 403 BUDGET_EXHAUSTED  │
       │                │        └─ OK → total_spent += amount, budget -= amount │
       │                │   8. request.a2aKeyRow = parent keyRow                 │
       │                │      request.delegationRow = delegation (nuevo)       │
       │                └───────────────────────────────────────────────────────┘
       │                └─ NO → flujo master key EXISTENTE (AC-13/CD-5, intacto)
       └─◄ ejecuta compose/orchestrate igual que hoy
```

### 1.2 Componentes nuevos / modificados

| Componente | Tipo | Responsabilidad |
|-----------|------|-----------------|
| `supabase/migrations/NNN_a2a_delegations.sql` (+ `_down`) | **nuevo** | Tabla `a2a_delegations` + índices + RPC `debit_delegation_and_parent` (atómico, CD-12) + hardening. |
| `src/types/a2a-key.ts` | **modif.** | `DelegationPolicy`, `DelegationRow`, `DelegationStatus`, `CreateDelegationInput`, `CreateDelegationResponse`, `DelegationListItem`, `SessionKeyErrorCode`, `DelegationTypedData`. |
| `src/types/index.ts` | **modif.** | Re-exports de los tipos nuevos. |
| `src/services/delegation.ts` | **nuevo** | `verifyTypedData` (EIP-712 domain+types+recover), `create`, `lookupByTokenHash`, `list`, `revoke`, helpers de enforcement (`assertPerTxLimit`), `debitDelegationAndParent`. Ownership Guard obligatorio (CD-2). |
| `src/services/security/errors.ts` | **modif.** | 9 error classes nuevas + extender union `OwnershipOp` con `'delegationRevoke'`/`'delegationList'`. |
| `src/routes/auth.ts` | **modif.** | `POST /auth/delegation`, `DELETE /auth/delegation/:id`, `GET /auth/delegation`. |
| `src/middleware/a2a-key.ts` | **modif.** | Branch `wasi_a2a_session_` → enforcement de delegación; augmentation `request.delegationRow`. |
| `.env.example` | **modif.** | `DELEGATION_EIP712_NAME`, `DELEGATION_EIP712_VERSION`. |
| `test/` (varios) | **nuevo/modif.** | ≥15 tests por AC + casos de ataque. |

### 1.3 Tabla `a2a_delegations` (migration)

Schema exacto del work-item (L84-103) con las siguientes precisiones de F2:

```sql
CREATE TABLE IF NOT EXISTS a2a_delegations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id              UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  owner_ref           TEXT NOT NULL,                  -- desnormalizado (Ownership Guard, CD-2)
  session_key_address TEXT NOT NULL,                  -- EOA del typed-data (metadata, lowercase)
  session_token_hash  TEXT NOT NULL UNIQUE,           -- SHA-256(wasi_a2a_session_<random>)
  policy              JSONB NOT NULL,                 -- DelegationPolicy serializado
  total_spent         NUMERIC(20,8) NOT NULL DEFAULT 0,
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ,                    -- null = activa
  typed_data_raw      JSONB NOT NULL,                 -- auditoría (CD-3)
  nonce               TEXT NOT NULL,                  -- bytes32 hex anti-replay
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_a2a_delegations_key_nonce UNIQUE (key_id, nonce)  -- AC-4/CD-4
);

-- UNIQUE en session_token_hash ya crea índice; el explícito es redundante pero
-- el work-item lo pide. Se omite duplicado (UNIQUE → índice O(1) para lookup AC-5).
CREATE INDEX IF NOT EXISTS idx_a2a_delegations_key_owner
  ON a2a_delegations (key_id, owner_ref);
-- Listado activo eficiente por owner (AC-11).
CREATE INDEX IF NOT EXISTS idx_a2a_delegations_owner
  ON a2a_delegations (owner_ref);
```

> **DT-NOTA (idx token_hash):** el work-item pide `idx_a2a_delegations_token_hash`. La columna ya es `UNIQUE`, que en Postgres crea automáticamente un índice btree O(1). Crear un segundo índice no-único sobre la misma columna es redundante. **Decisión F2:** no crear el índice explícito duplicado; documentar en el SDD que el `UNIQUE` cubre el lookup del hot path. (Si el Adversary lo prefiere explícito por trazabilidad, es cosmético — no bloqueante.)

### 1.4 RPC atómico `debit_delegation_and_parent` (CD-8/CD-12 — corazón de la HU)

El doble débito (delegación `total_spent` + parent `budget[chainId]`) DEBE ser atómico en una sola transacción DB. El work-item DT-7 sugiere un `UPDATE ... WHERE total_spent + amount <= max_total RETURNING`. F2 lo eleva a un RPC que combina ambos checks bajo el mismo lock, reusando `increment_a2a_key_spend` por dentro:

```sql
CREATE OR REPLACE FUNCTION debit_delegation_and_parent(
  p_delegation_id UUID,
  p_owner_ref     TEXT,     -- Ownership Guard a nivel DB (CD-2)
  p_key_id        UUID,     -- parent key (cross-check con la delegación)
  p_chain_id      INT,
  p_amount_usd    NUMERIC
) RETURNS NUMERIC AS $$       -- devuelve el nuevo total_spent
DECLARE
  v_owner       TEXT;
  v_key_id      UUID;
  v_revoked     TIMESTAMPTZ;
  v_expires     TIMESTAMPTZ;
  v_total       NUMERIC;
  v_max_total   NUMERIC;
  v_new_total   NUMERIC;
BEGIN
  -- 1. Lock de la delegación (atómico) — patrón FOR UPDATE.
  SELECT owner_ref, key_id, revoked_at, expires_at, total_spent,
         (policy->>'max_total_amount')::NUMERIC
    INTO v_owner, v_key_id, v_revoked, v_expires, v_total, v_max_total
    FROM a2a_delegations
    WHERE id = p_delegation_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELEGATION_NOT_FOUND: %', p_delegation_id;
  END IF;

  -- 2. Ownership Guard a nivel DB (CD-2) — service usa SERVICE_ROLE (bypassa RLS).
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not owned by caller', p_delegation_id;
  END IF;

  -- 2b. La delegación debe pertenecer a la parent key declarada (defensa en prof.).
  IF v_key_id IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not bound to key %', p_delegation_id, p_key_id;
  END IF;

  -- 3. Revocación / expiry re-chequeados bajo lock (defensa contra TOCTOU, CD-10).
  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'DELEGATION_REVOKED: %', p_delegation_id;
  END IF;
  IF NOW() >= v_expires THEN
    RAISE EXCEPTION 'DELEGATION_EXPIRED: %', p_delegation_id;
  END IF;

  -- 4. Check-and-debit del total acumulado (AC-8/CD-12, condicional en una sentencia).
  v_new_total := v_total + p_amount_usd;
  IF v_max_total IS NOT NULL AND v_new_total > v_max_total THEN
    RAISE EXCEPTION 'DELEGATION_TOTAL_LIMIT_EXCEEDED: % + % > %', v_total, p_amount_usd, v_max_total;
  END IF;

  -- 5. Debit del PARENT budget reusando la fn existente (AC-9/DT-5).
  --    Si el parent no tiene budget, increment_a2a_key_spend RAISE
  --    'INSUFFICIENT_BUDGET' → se propaga; la transacción ROLLBACK total_spent.
  PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);

  -- 6. Recién acá incrementamos total_spent (sólo si el parent debit pasó).
  UPDATE a2a_delegations
    SET total_spent = v_new_total
    WHERE id = p_delegation_id;

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
```

**Por qué un RPC y no `UPDATE ... RETURNING` desde el service:** el doble débito (delegación + parent) cruza dos tablas. Un read-then-write en el service (leer total_spent, leer budget, escribir ambos) es exactamente el patrón read-then-write prohibido por CD-12 y abre una race entre requests concurrentes con la misma session key. El RPC con `FOR UPDATE` sobre la delegación + el `FOR UPDATE` interno de `increment_a2a_key_spend` sobre la parent key serializa ambos débitos bajo locks. Si el parent debit falla, `PERFORM` propaga la excepción y todo el `total_spent` hace ROLLBACK (atomicidad transaccional de plpgsql). El `service` mapea los `RAISE EXCEPTION` por prefijo de mensaje a error classes (mismo patrón que `registerDeposit`, budget.ts:91-101).

> **Orden de operaciones crítico (AB-WKH-35-FIX-3 lección de atomicidad):** primero check del total (paso 4), luego parent debit (paso 5), luego `UPDATE total_spent` (paso 6). Si invertiéramos 5 y 6, un parent insuficiente dejaría `total_spent` incrementado tras rollback — pero como todo está en una transacción de función, el rollback es total igualmente; el orden 4→5→6 es defensivo y legible. **El per-tx limit (AC-7) NO va en el RPC** — se chequea en el service/middleware ANTES de llamar al RPC (es un check puramente sobre `policy.max_amount_per_tx` vs `estimatedCostUsd`, no necesita lock).

---

## 2. Decisiones técnicas (DT-N)

### DT-1 — Shape exacto del EIP-712 typed-data (`primaryType = "Delegation"`)

Domain (NC-3, sin `verifyingContract`):
```ts
const domain = {
  name: process.env.DELEGATION_EIP712_NAME ?? 'WasiAI-a2a Delegation',  // default sólo en dev (CD-6)
  version: process.env.DELEGATION_EIP712_VERSION ?? '1',
  chainId: Number(process.env.KITE_CHAIN_ID),   // AC-14
} as const;
```

Types EIP-712 (estructura Solidity-typed para encoding). **Decisión F2:** la `policy` se modela como un struct anidado `DelegationPolicy` con tipos Solidity explícitos. Los arrays de strings (`allowed_agent_slugs`, `allowed_registries`) se codifican como `string[]`; los chains como `uint256[]`. Los montos como `string` (decimal USD, evita pérdida de precisión float — lección AB-WKH-35-FIX-3); `expires_at` como `uint64` (epoch segundos):

```ts
const types = {
  Delegation: [
    { name: 'session_key', type: 'address' },
    { name: 'policy', type: 'DelegationPolicy' },
    { name: 'nonce', type: 'bytes32' },
  ],
  DelegationPolicy: [
    { name: 'max_amount_per_tx', type: 'string' },     // USD decimal, p.ej. "0.50"
    { name: 'max_total_amount', type: 'string' },       // USD decimal, p.ej. "100.00"
    { name: 'expires_at', type: 'uint64' },             // epoch seconds
    { name: 'allowed_chains', type: 'uint256[]' },
    { name: 'allowed_agent_slugs', type: 'string[]' },
    { name: 'allowed_registries', type: 'string[]' },
  ],
} as const;
```

> **`[VERIFY-AT-IMPL]`** — La firma EXACTA de `recoverTypedDataAddress` en viem v2 (`^2.47.6`) debe verificarse en docs antes de codear. Esperado: `recoverTypedDataAddress({ domain, types, primaryType: 'Delegation', message, signature })` → `Promise<0x${string}>`. **NO usar `verifyTypedData`** (DT-1 work-item): el recover permite comparar el firmante con `funding_wallet` sin conocerlo de antemano. **`[VERIFY-AT-IMPL]`** también: que viem no requiera el campo `EIP712Domain` en `types` (viem lo infiere desde `domain`); y que `as const` en `types`/`domain` sea suficiente para el typing estricto sin `as unknown` (CD-7). Si viem exige el tipo `TypedDataDomain`, importarlo de `viem`.

> **`[VERIFY-AT-IMPL]` — canonicalización del message:** el `typed_data` llega serializado del cliente. El server NO debe reconstruir el message desde la `policy` parseada y re-firmar; debe pasar `typed_data.message` tal cual al `recoverTypedDataAddress` (el hash EIP-712 es sensible a tipos exactos). Validar que `typed_data.domain` enviado por el cliente coincide con el domain del server (mismo `name/version/chainId`) ANTES de recuperar — un domain divergente firmado por el funding_wallet en OTRO dominio no debe aceptarse. Marcar verificación de igualdad de domain en el story.

### DT-2 — Mapeo policy → enforcement

| Campo policy | Enforcement | Dónde | Falla |
|--------------|-------------|-------|-------|
| `max_amount_per_tx` | `stepCost > max_per_tx` (POR STEP) | **cada débito de step**: middleware (step 0) + `budgetService.debit` (steps 2..N) — ver DT-11 | 403 `DELEGATION_TX_LIMIT_EXCEEDED` (AC-7) |
| `max_total_amount` | `total_spent + stepCost > max_total` (atómico, POR STEP) | RPC `debit_delegation_and_parent` invocado en CADA débito de step (ver DT-11) | 403 `DELEGATION_TOTAL_LIMIT_EXCEEDED` (AC-8) |
| `expires_at` | `now() >= expires_at` | middleware (pre-debit) + RPC (bajo lock, cada step) | 403 `DELEGATION_EXPIRED` (AC-6) |
| `allowed_chains` | `resolvedChainId ∈ allowed_chains` | middleware, post chain-resolve | 403 `DELEGATION_CHAIN_NOT_ALLOWED` (ver DT-8) |
| `allowed_agent_slugs` / `allowed_registries` | scoping per-step | compose (reusar `authzService.checkScoping`, DT-7) | 403 SCOPE (ver DT-7) |
| `revoked_at` | `!= null` | middleware (pre-debit) + RPC (bajo lock, cada step) | 403 `DELEGATION_REVOKED` (AC-6) |

> **CORRECCIÓN F2.5 (gap de correctitud cerrado por el orquestador):** el enforcement de `max_total_amount` (AC-8) y `max_amount_per_tx` (AC-7) es **PRECISO PER-STEP**, NO un único débito en el step 0. `/compose` y `/orchestrate` debitan el budget **por step** (`budgetService.debit`, `compose.ts:158`). Si la delegación solo enforzara el total en el step 0, una session key podría gastar **más que `max_total_amount`** repartido en varios steps → bypass de AC-8. La solución es DT-11: la ruta de débito es **delegation-aware**. Ver DT-11 para el diseño quirúrgico.

### DT-3 — Per-chain vs global: `total_spent` GLOBAL, `allowed_chains` filtra

El work-item modela `total_spent` como **un único acumulador NUMERIC** (no per-chain) y `policy.allowed_chains` como lista blanca. **Decisión F2:**
- `total_spent` es **global** (cross-chain): la policy autoriza un presupuesto total en USD independiente de la chain. Coherente con que el RPC debita la parent `budget[chainId]` (per-chain) Y el `total_spent` global en la misma transacción.
- `policy.allowed_chains` (uint256[]) restringe en qué chains puede operar la session key. El middleware, tras resolver `chainId` (a2a-key.ts:228), valida `allowed_chains.includes(chainId)`. Lista vacía o ausente → **interpretación segura: rechaza todo / o permite el chain default**. **Decisión F2: lista vacía = sin restricción de chain** (consistente con que `allowed_*` null en master keys = sin restricción, identity.ts). Si `allowed_chains` tiene elementos y `chainId` no está → 403 `DELEGATION_CHAIN_NOT_ALLOWED`. Esto NO es un AC explícito pero deriva de DT-2 del work-item (`allowed_chains` está en la policy); se cubre con un test de ataque y se documenta como enforcement adicional.

> Si el Adversary considera que `allowed_chains` vacío debería **rechazar** todo (deny-by-default), es una decisión de seguridad razonable opuesta; se deja marcada como **[DECISIÓN-REVISABLE en SPEC_APPROVED]**: F2 propone *empty = unrestricted* por paridad con el modelo de scoping de master keys, pero acepta cambiar a deny-by-default si el clinical review lo pide.

### DT-4 — Atomicidad del débito doble → ver §1.4 (RPC `debit_delegation_and_parent`)

Single RPC, `FOR UPDATE` sobre delegación + `PERFORM increment_a2a_key_spend` (que tiene su propio `FOR UPDATE` sobre la parent key). Una transacción, dos locks ordenados, rollback total si cualquiera falla. CD-12 satisfecho (cero read-then-write en app-layer para `total_spent`).

### DT-5 — Emisión y almacenamiento del session token (NC-4 / DT-4 work-item)

```ts
const random = crypto.randomBytes(48).toString('hex');  // 96 hex chars
const token = `wasi_a2a_session_${random}`;
const hash = crypto.createHash('sha256').update(token).digest('hex');
// persistir hash en session_token_hash; devolver `token` SÓLO en la 201.
```

Prefijo `wasi_a2a_session_` (subprefijo de `wasi_a2a_`). **Implicación crítica de naming:** el branch del middleware master-key actual matchea `startsWith('wasi_a2a_')` (a2a-key.ts:113) y el de Bearer en auth.ts:112. El branch de session debe chequearse PRIMERO con `startsWith('wasi_a2a_session_')`; el master-key `lookupByHash` sobre un token de sesión devolverá null (KEY_NOT_FOUND) porque el hash del token de sesión vive en `a2a_delegations`, no en `a2a_agent_keys`. **El orden importa:** `if (rawKey.startsWith('wasi_a2a_session_')) { branch delegación } else { flujo master existente }`. Ver DT-10 para el regex Bearer.

### DT-6 — Lookup del session token: tabla separada, sin Ownership Guard en el lookup del hot path

`delegationService.lookupByTokenHash(hash)` hace `.from('a2a_delegations').select('*').eq('session_token_hash', hash).single()` → row o null (PGRST116). **NO** lleva `.eq('owner_ref', ...)` porque en el hot path el caller se autentica CON el token; el owner se deriva del row, no se conoce de antemano (igual que `lookupByHash` de master keys, identity.ts:89-103, que tampoco filtra por owner en el lookup de auth). El Ownership Guard aplica a las operaciones por `delegation_id` desde el owner autenticado: `revoke` y `list` (AC-12/CD-2). Documentar este matiz con `NOTA PARA AR-CR` en el código (igual que `resolveIdentityForAgent`, identity.ts:263-266).

### DT-7 — Scoping `allowed_agent_slugs` / `allowed_registries` reusa `authzService.checkScoping`

La policy de delegación tiene `allowed_agent_slugs` y `allowed_registries`. El enforcement per-agent ya existe en `composeService.compose` vía `authzService.checkScoping(scopingKeyRow, target)` (compose.ts:83-108), que lee `scopingKeyRow.allowed_registries/allowed_agent_slugs`. **Decisión F2:** cuando el caller es una session key, el middleware construye un `scopingKeyRow` efectivo cuyos campos `allowed_*` son los de la **policy de delegación** (no los de la parent key), de modo que `composeService` aplica el scoping de la delegación sin cambios. Esto se logra inyectando un row derivado (clon de la parent key con `allowed_registries`/`allowed_agent_slugs` reemplazados por los de la policy). **`[VERIFY-AT-IMPL]`**: confirmar el shape exacto que `checkScoping` espera (`AuthzTarget` y campos del keyRow) leyendo `src/services/authz.ts` en F2.5/F3 — no fue leído en este grounding; el story DEBE incluir su lectura. Mientras tanto, AC-7/AC-8/AC-9 (límites de gasto) son el enforcement obligatorio; el scoping per-agent es enforcement adicional derivado de la policy.

> **[VERIFY-AT-IMPL] / NEEDS-READ:** `src/services/authz.ts` no fue leído en F2. El story file (F2.5) DEBE incluir su Read antes de implementar el scoping per-agent de la delegación. Si `checkScoping` no se presta a inyección de policy, fallback: chequear `allowed_agent_slugs`/`allowed_registries` de la policy directamente en el middleware contra el target — pero el target real se conoce post-resolveAgent (compose), no en el middleware. **Esta es la única zona del SDD con grounding incompleto; está acotada a enforcement adicional, no a un AC bloqueante.**

### DT-8 — `allowed_chains` enforcement en middleware (ver DT-3)

### DT-9 — Carga de la parent key en el branch de delegación

Tras el lookup de la delegación, el middleware necesita la parent `A2AAgentKeyRow` (para `request.a2aKeyRow`, que compose consume como `scopingKeyRow` y para el `budget` parent). **Decisión F2:** `delegationService` expone `getParentKey(keyId)` que hace `.from('a2a_agent_keys').select('*').eq('id', keyId).single()` — lectura interna server-side, sin owner gate (el owner de la delegación YA fue validado como dueño de la key al crearla: `a2a_delegations.owner_ref` se copió de la parent en create; y la FK `key_id REFERENCES a2a_agent_keys` garantiza consistencia). Documentar `NOTA PARA AR-CR`: no es IDOR porque el caller no eligió el `key_id` (sale del row de la delegación que él autenticó con su token).

### DT-10 — Branch Bearer/header consistente con el patrón existente

El middleware (a2a-key.ts:102-117) y `resolveCallerKey` (auth.ts:102-116) extraen `rawKey` con el mismo patrón: `x-a2a-key` primero, luego `Authorization: Bearer` con regex `/^bearer\s+(.+)$/i` y `match[1].startsWith('wasi_a2a_')`. El prefijo `wasi_a2a_session_` empieza con `wasi_a2a_`, así que el regex Bearer YA lo captura. **No hay que tocar el regex**, sólo agregar el branch de prioridad sobre el `rawKey` ya extraído.

### DT-11 — Enforcement per-step delegation-aware: el branch vive en `budgetService.debit` (CORRECCIÓN F2.5)

**El problema (gap de correctitud).** El débito de budget NO ocurre una sola vez. Hoy:
- **step 0**: el middleware (`a2a-key.ts:253` master / branch session en W3) debita `estimatedCostUsd`.
- **steps 2..N de `/compose`**: `composeService.compose` debita per-step vía `budgetService.debit(scopingKeyRow.id, chainId, debitAmount)` en `compose.ts:158`, guardado por `i > 0 && scopingKeyRow && chainId !== undefined` (`compose.ts:130`).

Si la delegación solo enforzara `total_spent` en el step 0, los steps 2..N debitarían el **parent budget** vía `increment_a2a_key_spend` (camino actual) **sin tocar `delegation.total_spent`** → una session key con `max_total_amount = "1.00"` podría gastar 1.00 en step 0 + N steps adicionales del parent budget → **bypass de AC-8**. Y `max_amount_per_tx` (AC-7) es naturalmente **por step** (cada step = un pago downstream a un agente).

**La solución quirúrgica: ruta de débito delegation-aware.** En vez de reescribir el loop de `compose.ts`, hacemos que `budgetService.debit(...)` (o, más limpio, una variante consciente del contexto) detecte si la request opera bajo una delegación y, si sí, invoque `delegationService.debitDelegationAndParent(...)` (RPC atómico §1.4) en lugar de `increment_a2a_key_spend`. Si NO hay delegación (master key), camino actual SIN cambios (CD-5).

**Dónde vive el branch (decisión F2.5):** en **`src/services/budget.ts`**, agregando un parámetro opcional `delegationContext?: DelegationDebitContext` a `budgetService.debit(...)`. Esto evita reescribir el loop de compose y centraliza la decisión en un solo punto. El call-site de `compose.ts:158` solo cambia para **pasar** ese contexto (recibido vía `ComposeRequest.delegationContext`). El step 0 (middleware, branch session W3) llama directamente a `delegationService.debitDelegationAndParent` (no necesita pasar por `budget.debit` porque el branch session ya tiene el `delegation` en mano).

```ts
// src/types/index.ts (o a2a-key.ts) — contexto compacto que viaja por la request
export interface DelegationDebitContext {
  delegationId: string;
  ownerRef: string;   // = parentKey.owner_ref (Ownership Guard a nivel DB)
  keyId: string;      // = parentKey.id
}

// src/services/budget.ts — firma EXTENDIDA (backward-compat: param opcional)
async debit(
  keyId: string,
  chainId: number,
  amountUsd: number,
  delegationContext?: DelegationDebitContext,   // <- NUEVO, opcional
): Promise<{ success: boolean; error?: string }> {
  if (delegationContext) {
    // RUTA DELEGACIÓN (AC-7 ya chequeado per-step ANTES por el caller;
    // AC-8 + AC-9 atómicos acá vía el RPC).
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
      // mapear a { success:false, error:<code> } para que compose corte
      // el pipeline a mitad de camino (mismo shape que el camino master).
      return { success: false, error: errCode(err) };
    }
  }
  // RUTA MASTER KEY — INTACTA (camino actual, CD-5).
  const { error } = await supabase.rpc('increment_a2a_key_spend', { ... });
  ...
}
```

> **AC-7 (per-tx) per-step:** el `exceedsPerTxLimit(policy, stepCost)` se chequea **antes** de cada débito. Para step 0, en el branch session del middleware (W3). Para steps 2..N, dentro de `compose.ts` ANTES de `budgetService.debit` — pero como `compose.ts` no debe conocer la `policy`, el check per-tx per-step se resuelve pasando `maxAmountPerTx` dentro del `DelegationDebitContext` y haciendo el assert dentro de `budget.debit` (ruta delegación) ANTES de llamar al RPC. Decisión F2.5: **incluir `maxAmountPerTx: string` en `DelegationDebitContext`** y que `budget.debit` (ruta delegación) haga `if (exceedsPerTxLimit({max_amount_per_tx} as any, amountUsd)) return { success:false, error:'DELEGATION_TX_LIMIT_EXCEEDED' }` ANTES del RPC. Así AC-7 se enforza per-step sin que compose conozca la policy completa. (El helper `exceedsPerTxLimit` se generaliza a recibir un `maxAmountPerTx: string` en vez de la `policy` entera — ver §W1.)

**Cambios quirúrgicos en compose/orchestrate (relajación documentada de "PROHIBIDO tocar"):**

| Archivo:línea | Cambio EXACTO | Por qué imprescindible |
|---------------|---------------|------------------------|
| `src/types/index.ts:208-237` (`ComposeRequest`) | Agregar campo opcional `delegationContext?: DelegationDebitContext`. | Transportar el contexto al loop sin reescribirlo. |
| `src/services/compose.ts:158` | Pasar 4º arg: `budgetService.debit(scopingKeyRow.id, chainId, debitAmount, request.delegationContext)`. **Una sola línea.** El guard `i > 0 && scopingKeyRow && chainId !== undefined` se mantiene IDÉNTICO. | Propagar el contexto al débito per-step. Cuando es master key, `delegationContext` es `undefined` → ruta actual intacta (CD-5). |
| `src/routes/compose.ts:153-167` | Agregar a la llamada `composeService.compose({...})`: `delegationContext: request.delegationContext` (la request lo lleva seteado por el middleware branch session — ver abajo). | Inyectar el contexto desde la request al service. |
| `src/middleware/a2a-key.ts:27-34` (augmentation) | Agregar `delegationContext?: DelegationDebitContext;` (además de `delegationRow`). El branch session lo setea. | El call-site de la ruta lo lee de `request`. |
| `src/types/index.ts:336-349` (`OrchestrateRequest`) | Agregar `delegationContext?: DelegationDebitContext`. | Idem para orchestrate. |
| `src/routes/orchestrate.ts:71-81` | Agregar `delegationContext: request.delegationContext` a la llamada `orchestrateService.orchestrate({...})`. | Propagar. |
| `src/services/orchestrate.ts:405-410` | Agregar a `composeService.compose({...})`: `delegationContext: request.delegationContext` **Y** `chainId: ...`. | **BUG PREEXISTENTE DETECTADO:** orchestrate HOY NO pasa `chainId` a compose (`orchestrate.ts:405-410`), por lo que el guard `chainId !== undefined` de `compose.ts:130` hace que **los steps 2..N de orchestrate NO se debiten en absoluto**. Para que el enforcement per-step de delegación funcione en `/orchestrate`, hay que propagar el `chainId` resuelto. Ver DT-12. |

**Atomicidad y "corte a mitad de camino" (AC-8 preciso):** como el débito de cada step pasa por el RPC atómico, el step en que `total_spent + stepCost > max_total` falla **en ese step** → `budgetService.debit` devuelve `{ success:false }` → `compose.ts:163-175` corta el pipeline retornando `ComposeResult.error` (mapeado a 400/403 por la ruta). Los steps ya ejecutados quedaron debitados (fee-on-attempt, consistente con WKH-59); el step que excede y los siguientes NO corren. Esto es exactamente "se corta a mitad de camino, no después" (requisito del orquestador). El step 0 (middleware) corta antes incluso de entrar a compose.

> **CD-12 / CD-8 preservados:** cero read-then-write en app-layer; cada step delega a `debitDelegationAndParent` (RPC bajo `FOR UPDATE`). El doble límite (delegación total + parent budget) se evalúa atómicamente por step. CD-5 (master key) intacto: `delegationContext === undefined` → rama `increment_a2a_key_spend` sin cambios.

### DT-12 — Propagar `chainId` a compose desde orchestrate (fix del bug preexistente, acotado)

`orchestrate.ts:405-410` llama `composeService.compose({ steps, maxBudget, a2aKey, scopingKeyRow })` **sin `chainId`**. Consecuencia hoy: los steps 2..N de `/orchestrate` no se debitan (`compose.ts:130` guard `chainId !== undefined`). Para que el enforcement per-step de delegación opere en `/orchestrate`, el `chainId` resuelto por el middleware (`request.resolvedChainId`) debe llegar a compose.

**Decisión F2.5 (mínimo cambio):**
- Agregar `chainId?: number` a `OrchestrateRequest` (`src/types/index.ts:336-349`).
- `src/routes/orchestrate.ts:71-81`: pasar `chainId: request.resolvedChainId`.
- `src/services/orchestrate.ts:405-410`: pasar `chainId: request.chainId` a `composeService.compose({...})`.

**Backward-compat:** para una **master key** en `/orchestrate`, esto activa el débito per-step de steps 2..N que hoy NO ocurre (fix de un under-charge preexistente). Esto **cambia comportamiento** del path master en orchestrate multi-step. **[DECISIÓN-REVISABLE — escalar al orquestador]:** ¿el fix del chainId en orchestrate (que también afecta master keys) está en scope de WKH-101, o se acota SOLO al path de delegación? Dos opciones:
- **(A) Fix completo:** propagar `chainId` siempre → master keys también empiezan a debitar steps 2..N en orchestrate (corrige el under-charge, pero cambia comportamiento master → puede romper tests e2e de orchestrate). 
- **(B) Acotado a delegación:** en `orchestrate.ts:405`, pasar `chainId` SOLO cuando hay `delegationContext` (`chainId: request.delegationContext ? request.chainId : undefined`), dejando el path master de orchestrate INTACTO (no debita steps 2..N, como hoy). Preserva CD-5 estrictamente; el under-charge de master en orchestrate queda como deuda técnica separada.

**Recomendación F2.5: opción (B)** — preserva CD-5 al 100% (master key sin cambios de comportamiento, tests verdes), cierra el gap de delegación (que es el objeto de la HU), y deja el under-charge preexistente de master-en-orchestrate como TD explícita fuera de scope. El Dev implementa (B) salvo que el orquestador indique (A).

---

## 3. Waves de implementación

> W0 es **serial** (contratos/tipos/migration/errores). W1+ dependen de W0. W5 (tests) puede ir incremental pero se cierra al final.

### W0 — Contratos, tipos, migration, errores, env (SERIAL, primero)
1. `src/types/a2a-key.ts`: `DelegationPolicy`, `DelegationRow`, `DelegationStatus = 'active'|'expired'|'revoked'`, `CreateDelegationInput`, `CreateDelegationResponse`, `DelegationListItem`, `SessionKeyErrorCode`, `DelegationTypedData`.
2. `src/types/index.ts`: re-exports.
3. `src/services/security/errors.ts`: 9 error classes (`FundingWalletNotBoundError` ya existe → reusar; `DelegationSignerMismatchError`, `DelegationNonceReplayError`, `DelegationRevokedError`, `DelegationExpiredError`, `DelegationTxLimitExceededError`, `DelegationTotalLimitExceededError`, `DelegationNotAllowedError`, `InvalidSessionTokenError`, `DelegationChainNotAllowedError`). Extender union `OwnershipOp`.
4. `supabase/migrations/NNN_a2a_delegations.sql` + `_down.sql`: tabla + índices + RPC `debit_delegation_and_parent` + hardening (search_path/REVOKE/GRANT).
5. `.env.example`: `DELEGATION_EIP712_NAME`, `DELEGATION_EIP712_VERSION`.

### W1 — Service core + verificación EIP-712 (depende W0)
6. `src/services/delegation.ts`:
   - `buildDomain()` / `buildTypes()` (lee env, CD-6).
   - `verifyTypedData(typedData, signature) → Promise<address>` usando `recoverTypedDataAddress` `[VERIFY-AT-IMPL]`.
   - `create(parentKey, typedData, signature, sessionKeyAddress, policy)`: recover→compare funding_wallet, validar policy/expires, generar token, hash, INSERT (mapear 23505 → `DelegationNonceReplayError`). Devuelve `{ delegation_id, token, expires_at, policy }`.
   - `lookupByTokenHash(hash)` (DT-6).
   - `getParentKey(keyId)` (DT-9).
   - `list(ownerRef)` (Ownership Guard, AC-11, deriva `status`).
   - `revoke(delegationId, ownerRef)` (Ownership Guard UPDATE `revoked_at=now()`, 0 rows → OwnershipMismatchError, AC-10/AC-12).
   - `debitDelegationAndParent(delegationId, ownerRef, keyId, chainId, amount)` → RPC; mapea errores.
   - `assertPerTxLimit(policy, amount)` helper puro (AC-7).

### W2 — Endpoints REST (depende W1)
7. `src/routes/auth.ts`:
   - `POST /auth/delegation`: resolveCallerKey → CD-9 (token session → 403 DELEGATION_NOT_ALLOWED) → AC-2 funding_wallet → validar input → `delegationService.create` → 201.
   - `DELETE /auth/delegation/:id`: resolveCallerKey (master) → `delegationService.revoke(id, owner_ref)` → 200 / 403 OWNERSHIP_MISMATCH.
   - `GET /auth/delegation`: resolveCallerKey → `delegationService.list(owner_ref)` → 200.

### W3 — Middleware branch + enforcement step 0 en hot path (depende W1)
8. `src/middleware/a2a-key.ts`:
   - augmentation `request.delegationRow?: DelegationRow` + `request.delegationContext?: DelegationDebitContext` (DT-11).
   - branch `rawKey.startsWith('wasi_a2a_session_')` (DT-5/DT-10): lookup → AC-5/AC-6 → resolver chain (reusar bloque existente) → DT-3 allowed_chains → AC-7 per-tx del STEP 0 → RPC débito atómico del STEP 0 (AC-8/AC-9) vía `delegationService.debitDelegationAndParent` → set `request.a2aKeyRow = effectiveRow` + `request.delegationRow` + **`request.delegationContext = { delegationId, ownerRef, keyId, maxAmountPerTx }`** (para que los steps 2..N lo propaguen).
   - master key path INTACTO (AC-13/CD-5): `delegationContext` queda `undefined`.

### W4 — Enforcement per-step delegation-aware + scoping (depende W1/W3) — CORRECCIÓN F2.5
9. **Débito delegation-aware (DT-11, corazón del fix):**
   - `src/services/budget.ts`: extender `debit(...)` con `delegationContext?: DelegationDebitContext`. Branch: si presente → AC-7 per-step (`exceedsPerTxLimit`) + `delegationService.debitDelegationAndParent` (AC-8/AC-9 atómico); si ausente → `increment_a2a_key_spend` (camino actual intacto).
   - `src/types/index.ts`: `DelegationDebitContext` + `ComposeRequest.delegationContext?` + `OrchestrateRequest.delegationContext?` + `OrchestrateRequest.chainId?` (DT-12).
   - `src/services/compose.ts:158`: pasar 4º arg `request.delegationContext` (una línea; guard `i>0 && scopingKeyRow && chainId` intacto).
   - `src/routes/compose.ts:153`: pasar `delegationContext: request.delegationContext`.
   - `src/routes/orchestrate.ts:71` + `src/services/orchestrate.ts:405`: propagar `delegationContext` y `chainId` (DT-12, opción B recomendada).
10. **Scoping per-agent (DT-7, enforcement adicional):** inyección del `effectiveRow` derivado de la policy en el middleware branch (W3 paso set `a2aKeyRow`). `authz.ts` ya leído (Story §W4): `checkScoping` es función pura que lee `allowed_*` del row → spread con los `allowed_*` de la policy. NO toca `compose.ts`/`authz.ts`/`orchestrate.ts` para el scoping.

### W5 — Tests (cierre)
10. ≥15 tests por AC + ataques (ver §5).

---

## 4. Cobertura de Constraint Directives

| CD | Cómo se satisface |
|----|-------------------|
| **CD-1** EIP-712/secp256k1, no ethers | `recoverTypedDataAddress` de viem (DT-1). Grep confirma cero ethers en repo. |
| **CD-2** Ownership Guard en `a2a_delegations` | `revoke`/`list` filtran por `owner_ref` (app-layer, identity.ts pattern); RPC débito valida `owner_ref` a nivel DB (§1.4 paso 2). Lookup del hot path documentado como no-IDOR (DT-6). |
| **CD-3** enforcement server-side, no confiar en cliente | Todos los límites en middleware+RPC; `typed_data_raw` se guarda para auditoría; la policy persistida (no la del request runtime) gobierna el enforcement. |
| **CD-4** anti-replay nonce | `UNIQUE(key_id, nonce)` (§1.3) → 23505 → `DelegationNonceReplayError`. Sin nonce → validación rechaza (W2). |
| **CD-5** backward-compat | Branch SOLO si `wasi_a2a_session_`; master path línea-por-línea intacto. Test AC-13 lo prueba. |
| **CD-6** sin hardcodes prod | `DELEGATION_EIP712_NAME/VERSION` + `KITE_CHAIN_ID` desde env; defaults sólo como fallback dev (no en prod — mismo patrón que el resto). |
| **CD-7** TS strict, no any/as unknown | Tipos explícitos; `as const` en domain/types; único `as unknown as` permitido = cast de builders mock supabase en tests (lección AB-WKH-100). |
| **CD-8** ambos límites (delegación + parent budget) | RPC debita ambos atómicamente; per-tx check antes. min(policy, budget) emergente. |
| **CD-9** sin sub-delegación | `POST /auth/delegation` rechaza token `wasi_a2a_session_` → 403 DELEGATION_NOT_ALLOWED (AC-15). |
| **CD-10** revoked_at inmediato | Chequeo en middleware (pre-debit) Y bajo lock en el RPC (TOCTOU-safe). |
| **CD-11** ancla = funding_wallet exclusivo | recover comparado SÓLO con `funding_wallet`; null → FUNDING_WALLET_NOT_BOUND, sin fallback a owner_ref/erc8004. |
| **CD-12** check-and-debit atómico DB | RPC `debit_delegation_and_parent`, UPDATE condicional bajo `FOR UPDATE`, cero read-then-write en app. |

### Security checklist (auditoría profesional, "más pro que Kite")
- **Anti-replay:** `UNIQUE(key_id, nonce)` + nonce random bytes32 (no counter predecible).
- **Token leak:** sólo el SHA-256 hash se persiste; el token plano se devuelve una vez (semántica master key). Nunca logueado.
- **Aislamiento:** session key ≤ min(policy.max_total, parent budget[chain]) garantizado por el doble débito atómico.
- **TOCTOU:** revoked/expired re-chequeados bajo `FOR UPDATE` en el RPC, no sólo en el read del middleware.
- **Sub-delegación:** bloqueada (CD-9).
- **Domain binding:** el domain firmado se valida contra el server domain (DT-1 `[VERIFY-AT-IMPL]`) → una firma de otro dominio no se acepta.
- **Precisión de montos:** USD como string en la policy; comparaciones de límite en NUMERIC (DB) — evita la pérdida float (lección AB-WKH-35-FIX-3). El service NO debe usar `Number()`/`parseFloat` para comparar `max_total_amount`; delega al RPC NUMERIC.
- **PII-safe logs:** `logOwnershipMismatch` hashea ids; no loguear el token ni la firma.

### Constraint Directives derivados del Auto-Blindaje histórico (≥2 HUs recurrentes)

> Patrones de error recurrentes detectados en WKH-100, WKH-35, WKH-097:

- **CD-AB-1 (recurrente WKH-100 ×3): nuevos named exports / nuevos imports de service rompen mocks factory.** PROHIBIDO cerrar una wave sin: (a) `grep -rn "vi.mock('../services/identity.js'"` y los módulos `delegation.js`/`security/errors.js` recién importados, agregando los exports nuevos a TODO factory `vi.mock(path, () => ({...}))` que reemplace esos módulos; (b) si `auth.ts`/`a2a-key.ts` importan `delegationService`, sus test files (`auth.test.ts`, `a2a-key.test.ts`, `auth.erc8004.test.ts`) deben mockear `../services/delegation.js`. Ref: WKH-100 auto-blindaje #1, #2, #5.
- **CD-AB-2 (recurrente WKH-100): mocks supabase multi-query con `mockImplementation`+contador, no `mockReturnValueOnce` encadenado.** `delegationService.create` hace ≥2 queries (lookup nonce / insert). Castear builders con `as unknown as ReturnType<typeof supabase.from>` (no `as` directo: TS2352). Ref: WKH-100 auto-blindaje #3.
- **CD-AB-3 (recurrente WKH-35/WKH-100): comparaciones de montos on-chain/policy en unidades atómicas/NUMERIC, NUNCA `Number()`/`parseFloat`.** Los límites `max_total_amount`/`max_amount_per_tx` se comparan vía NUMERIC en el RPC, y el per-tx en el service debe parsear con cuidado (string→comparación decimal, no float64). Ref: WKH-35 auto-blindaje FIX-3.
- **CD-AB-4 (recurrente WKH-35): nuevo endpoint que cambia un contrato rompe tests e2e que asertan el comportamiento viejo.** `POST /auth/delegation` y el branch de session token cambian el comportamiento del 401/403 en rutas autenticadas. `grep -rn "wasi_a2a_session_\|delegation" src/__tests__` y revisar e2e ANTES de cerrar. Ref: WKH-35 auto-blindaje #3.
- **CD-AB-5 (recurrente WKH-35/WKH-100): viem typing — `recoverTypedDataAddress` con tipos `as const`.** Anotar tipos de retorno y `as const` en domain/types para que `args`/firma tipen sin `any`. Ref: WKH-35 auto-blindaje Wave1 #1/#2. Correr `tsc --noEmit` (no sólo `tsconfig.build.json`) antes de cerrar W5 para detectar fixtures rotos (lección WKH-100 FIX-PACK v3).

---

## 5. Plan de tests (≥15 ACs + ataques)

> Tests nuevos en `src/services/delegation.test.ts`, `src/routes/auth.delegation.test.ts`, y extensión de `src/middleware/a2a-key.test.ts` (o `test/`). Cada AC → ≥1 test. vitest.

| # | AC/Ataque | Test | Aserción |
|---|-----------|------|----------|
| T1 | AC-1 | create happy path | recover=funding_wallet → 201 `{delegation_id, session_token (prefijo), expires_at, policy}`; hash persistido, token NO. |
| T2 | AC-2 | funding_wallet null | 403 `FUNDING_WALLET_NOT_BOUND`, 0 rows insertadas. |
| T3 | AC-3 | signer != funding_wallet | 403 `DELEGATION_SIGNER_MISMATCH`, 0 rows. |
| T4 | AC-4 | nonce replay | 2º create mismo `(key_id, nonce)` → 409 `DELEGATION_NONCE_REPLAY` (23505 mapeado). |
| T5 | AC-5 | session token válido en middleware | request con `wasi_a2a_session_*` → branch delegación, lookup OK. Token inexistente → 401 `INVALID_SESSION_TOKEN`. |
| T6 | AC-6 | revoked / expired | `revoked_at != null` → 403 `DELEGATION_REVOKED`; `now()>=expires_at` → 403 `DELEGATION_EXPIRED`. |
| T7 | AC-7 | per-tx limit (step 0) | `stepCost > max_amount_per_tx` → 403 `DELEGATION_TX_LIMIT_EXCEEDED`. |
| T7b | AC-7 per-step | per-tx limit en step 2..N | `budget.debit` con `delegationContext` y `amountUsd > maxAmountPerTx` → `{success:false, error:'DELEGATION_TX_LIMIT_EXCEEDED'}` ANTES del RPC (no llama al RPC). |
| T8 | AC-8 | total limit atómico (step 0) | `total_spent + amount > max_total` → 403 `DELEGATION_TOTAL_LIMIT_EXCEEDED`; total_spent no cambia (rollback). |
| T8b | AC-8 MULTI-STEP | suma de steps excede max_total → corte a mitad | compose 3 steps, `max_total` alcanza para 2: el débito del step que excede devuelve `{success:false}` → `compose` corta el pipeline ahí (no ejecuta steps siguientes), retorna `ComposeResult.error`. Aserción: `debitDelegationAndParent` se invocó por step 0(mw)+steps 2..N hasta el que excede; el RPC del step que excede lanzó `DelegationTotalLimitExceededError`; los steps posteriores NO se debitaron. **Corte a mitad, no después.** |
| T9 | AC-9 | parent budget exhausted | parent `budget[chain]` insuficiente → 403 `AGENT_KEY_BUDGET_EXHAUSTED`/INSUFFICIENT_BUDGET; total_spent no cambia. |
| T10 | AC-9 | aislamiento min(policy, budget) | session no puede gastar > min; debita AMBOS (delegación + parent) por request exitoso. |
| T11 | AC-10 | revoke | DELETE → `revoked_at` set, 200; request posterior con el token → 403 REVOKED. |
| T12 | AC-11 | list | GET devuelve sólo del owner, con `status` derivado (active/expired/revoked). |
| T13 | AC-12 | ownership cross-tenant | owner B intenta revoke/list delegación de owner A → 403 OWNERSHIP_MISMATCH; RPC con owner_ref ajeno → OWNERSHIP_MISMATCH. |
| T14 | AC-13 | backward-compat master key | request con master key (no session) → flujo idéntico al actual; `budget.debit` SIN `delegationContext` → `increment_a2a_key_spend` (camino actual, NO llama `debitDelegationAndParent`); compose per-step con `delegationContext === undefined` → ruta master intacta. |
| T15 | AC-14 | EIP-712 domain desde env | domain usa `DELEGATION_EIP712_NAME/VERSION` + `KITE_CHAIN_ID`; firma con domain divergente → no recover/mismatch. |
| T16 | AC-15 | sub-delegación | `POST /auth/delegation` autenticado con token `wasi_a2a_session_*` → 403 `DELEGATION_NOT_ALLOWED`, 0 rows. |
| T17 | Ataque DT-3 | chain no permitido | `resolvedChainId ∉ allowed_chains` (no vacío) → 403 `DELEGATION_CHAIN_NOT_ALLOWED`. |
| T18 | Ataque race | dos débitos concurrentes misma session | el atómico previene exceder max_total (uno pasa, otro 403). |
| T19 | Ataque TOCTOU | revoke entre read y debit | revoke concurrente → RPC re-chequea bajo lock → 403 REVOKED. |
| T20 | Ataque domain | firma de otro `name/version/chainId` | recover != funding_wallet → 403 SIGNER_MISMATCH. |

> **Cobertura objetivo:** 100% de ACs con test dedicado + 5 casos de ataque (replay, per-tx, total, expiry, revoked, signer mismatch, sub-delegación, budget exhausted, cross-tenant, race, TOCTOU, domain). T7/T8/T9/T17/T18/T19 verifican el corazón de seguridad de la HU.

---

## 6. Exemplars verificados (Glob/Read confirmados)

| Exemplar | Path (existe) | Para qué |
|----------|---------------|----------|
| Migration con RPC atómico + anti-replay + hardening | `supabase/migrations/20260529000000_a2a_key_deposits.sql` | Modelo exacto de `a2a_delegations` + `debit_delegation_and_parent`. |
| RPC `increment_a2a_key_spend` (a reusar) | `supabase/migrations/20260406000000_a2a_agent_keys.sql:56-121` | Lo invoca `PERFORM` el RPC nuevo. |
| Hardening RPC | `supabase/migrations/20260427160000_secure_rpc_search_path.sql` | search_path/REVOKE/GRANT. |
| Service que mapea errores PG → classes | `src/services/budget.ts:48-105` | `debitDelegationAndParent` lo replica. |
| Owner-firma → server-verifica con viem | `src/routes/auth.ts:186-257` (`/funding-wallet`) | Patrón recover+compare (recoverTypedDataAddress en vez de recoverMessageAddress). |
| Validación de input estricta + error_code map | `src/routes/auth.ts:453-624` (`/erc8004/bind`) | Modelo de los 3 endpoints nuevos. |
| Lookup por hash (auth) | `src/services/identity.ts:89-103` | Modelo de `lookupByTokenHash`. |
| Ownership Guard UPDATE | `src/services/identity.ts:109-164` | Modelo de `revoke`. |
| Error classes | `src/services/security/errors.ts:9-132` | Modelo de las 9 nuevas. |
| Branch x-a2a-key/Bearer | `src/middleware/a2a-key.ts:102-117` + `src/routes/auth.ts:98-127` | Punto de inserción del branch session. |
| Scoping per-step | `src/services/compose.ts:83-108` | `checkScoping` (requiere Read de authz.ts en F2.5). |

**Archivo NO leído (gap declarado):** `src/services/authz.ts` — necesario para DT-7 (scoping per-agent de la policy). El story file (F2.5) DEBE incluir su Read antes de W4.

---

## 7. Readiness Check

| Item | Estado |
|------|--------|
| Todos los archivos referenciados verificados con Read/Glob | ✅ (excepto `authz.ts`, gap declarado y acotado a W4 enforcement adicional) |
| 15 ACs mapeados a diseño + test | ✅ (T1–T16 + ataques T17–T20) |
| 12 CDs cubiertos | ✅ (§4) + 5 CD-AB del auto-blindaje |
| RPC atómico diseñado (CD-8/CD-12) | ✅ `debit_delegation_and_parent` (§1.4) |
| Schema migration con UNIQUE(key_id,nonce) + UNIQUE token_hash | ✅ (§1.3) |
| Stack no negociable respetado (viem v2, no ethers, TS strict) | ✅ |
| Hardcodes prohibidos / env vars | ✅ (CD-6, AC-14) |
| Scope OUT respetado (sub-deleg, Fase 3, RLS, verifyingContract) | ✅ |
| `[VERIFY-AT-IMPL]` marcados (firma viem, domain binding, scoping shape) | ✅ (DT-1, DT-7) |
| Enforcement per-step (AC-7/AC-8) corregido (gap F2.5 cerrado) | ✅ DT-11 (branch delegation-aware en `budget.debit`) + DT-12 (chainId a orchestrate). T7b/T8b multi-step agregados. |
| Call-sites de débito re-verificados (archivo:línea) | ✅ `budget.ts:48-64` (`debit`), `compose.ts:130-176` (per-step, guard `i>0 && scopingKeyRow && chainId`), `compose.ts:158` (call), `orchestrate.ts:405-410` (compose sin chainId — bug detectado DT-12), `a2a-key.ts:253` (step 0 master). |
| `[NEEDS CLARIFICATION]` sin resolver | **Ninguno bloqueante.** 1 ítem revisable nuevo: DT-12 (opción A vs B para el chainId en orchestrate). Recomendación F2.5 = B. |

**Veredicto F2.5:** **PASS con 1 observación de decisión (no bloqueante):**
1. **[DECISIÓN-REVISABLE]** DT-12: propagar `chainId` a compose desde orchestrate afecta también master keys (corrige un under-charge preexistente). **Opción B recomendada** (acotar a delegación → CD-5 intacto). El Dev implementa B salvo indicación contraria. DT-3 (allowed_chains empty=unrestricted) ya RESUELTO por el orquestador en el Story. `authz.ts` ya leído (Story §W4).

El gap de correctitud (AC-8 bypass multi-step) queda **CERRADO**: el enforcement es preciso per-step vía la ruta de débito delegation-aware. Cero read-then-write (CD-12), doble límite por step (CD-8), master key intacto (CD-5).
