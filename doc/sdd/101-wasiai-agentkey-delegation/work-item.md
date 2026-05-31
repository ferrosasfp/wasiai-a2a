# Work Item — [WKH-101] wasiai-agentkey Fase 2: EIP-712 Delegation + Session Key + Server-Side Enforcement

## Resumen

Fase 2 de `wasiai-agentkey`. El owner de una Agent Key firma un typed-data EIP-712 que contiene una **policy de gasto** (límites por tx, total, TTL/expiry, assets/chains/agents permitidos) y **autoriza una session key efímera** para operar dentro de esos límites. El servidor recupera el firmante, verifica que sea el `funding_wallet` bindeado de la key (ancla de autoridad definitiva), hace cumplir todos los límites en cada `/compose`/`/orchestrate` que use esa session key, y provee revocación inmediata via `revoked_at` persistido. Las keys sin delegación siguen operando exactamente igual que hoy (backward-compat opt-in).

## Sizing

- **SDD_MODE:** full
- **Pipeline:** QUALITY
- **Estimación:** L (crypto-firma + nueva tabla DB + enforcement en hot path middleware)
- **Branch sugerido:** `feat/101-wasiai-agentkey-delegation`
- **Skills relevantes:** blockchain-evm, backend-security

---

## Clarifications resueltas (2026-05-31)

**NC-1 — Ancla de autoridad: `funding_wallet` exclusivo**
El firmante del EIP-712 DEBE ser igual al `funding_wallet` bindeado en la Agent Key. El server usa viem `recoverTypedDataAddress` para recuperar el firmante y lo compara con `callerKey.funding_wallet`. Si la key no tiene `funding_wallet` bindeado, se devuelve error `FUNDING_WALLET_NOT_BOUND`. NO se usa la identidad ERC-8004 como ancla.

**NC-4 — Autenticación de session key: token opaco**
Al crear la delegación, el server emite un token opaco `wasi_a2a_session_<random>`. Se almacena su SHA-256 hash en `a2a_delegations.session_token_hash`. El cliente presenta el token en `x-a2a-key` (o `Authorization: Bearer`), el middleware hace lookup por hash — exactamente igual al flujo del master key. La session EOA address en el typed-data es solo metadata on-chain; no firma requests individuales.

**NC-2 — Revocación: `revoked_at` persistido**
La tabla `a2a_delegations` tiene columna `revoked_at TIMESTAMPTZ`. La revocación es inmediata: `DELETE /auth/delegation/:id` setea `revoked_at = now()`. El enforcement rechaza si `revoked_at IS NOT NULL OR now() > expires_at`. El TTL (`expires_at`) es un límite duro adicional, no el único mecanismo.

**NC-3 — EIP-712 domain sin `verifyingContract`**
El domain EIP-712 es `{ name: string, version: string, chainId: number }` sin `verifyingContract`. Sistema 100% off-chain/server-side. Valores exactos: `name = "WasiAI-a2a Delegation"`, `version = "1"`. Ambos leídos desde env vars `DELEGATION_EIP712_NAME` y `DELEGATION_EIP712_VERSION` (con defaults hardcodeados como fallback solo en desarrollo — no en producción).

---

## Acceptance Criteria (EARS)

**AC-1 — Creación de delegación: endpoint y respuesta**
WHEN the owner sends `POST /auth/delegation` with `{ typed_data, signature, session_key_address, policy }` authenticated with a valid parent Agent Key, the system SHALL recover the signer via viem `recoverTypedDataAddress`, verify the signer equals `callerKey.funding_wallet`, validate all policy fields (types, ranges, required fields), persist the delegation row in `a2a_delegations`, emit an opaque session token `wasi_a2a_session_<random>`, store its SHA-256 hash in `session_token_hash`, and return HTTP 201 `{ delegation_id, session_token, expires_at, policy }`.

**AC-2 — Funding wallet no bindeada bloquea creación**
IF the parent Agent Key does not have a `funding_wallet` bound (field is null or empty), THEN the system SHALL return HTTP 403 `FUNDING_WALLET_NOT_BOUND` and SHALL NOT create the delegation row.

**AC-3 — Firmante no coincide con funding_wallet bloquea creación**
IF the recovered signer from the EIP-712 signature does not match `callerKey.funding_wallet` (case-insensitive address comparison), THEN the system SHALL return HTTP 403 `DELEGATION_SIGNER_MISMATCH` and SHALL NOT persist any row.

**AC-4 — Anti-replay: nonce único por delegación**
WHEN creating a delegation, the system SHALL verify that the `nonce` included in the EIP-712 typed-data has not been used before for the same parent Agent Key. IF the nonce was already registered, THEN the system SHALL return HTTP 409 `DELEGATION_NONCE_REPLAY` and SHALL NOT create the delegation.

**AC-5 — Autenticación de session token en middleware**
WHEN a request arrives with a `wasi_a2a_session_` prefixed token in `x-a2a-key` or `Authorization: Bearer`, the system SHALL compute the SHA-256 hash of the token, look up the matching row in `a2a_delegations` by `session_token_hash`, and branch to delegation enforcement. IF no matching row is found, THEN the system SHALL return HTTP 401 `INVALID_SESSION_TOKEN`.

**AC-6 — Enforcement de revocación y expiración**
WHEN a request is authenticated with a session token, the system SHALL check that `revoked_at IS NULL` AND `now() < expires_at`. IF either condition fails, THEN the system SHALL return HTTP 403 `DELEGATION_REVOKED` (if `revoked_at IS NOT NULL`) or HTTP 403 `DELEGATION_EXPIRED` (if `now() >= expires_at`).

**AC-7 — Enforcement del límite por transacción**
WHILE a session key delegation is active, the system SHALL reject any request whose `estimatedCostUsd` exceeds `policy.max_amount_per_tx` with HTTP 403 `DELEGATION_TX_LIMIT_EXCEEDED`.

**AC-8 — Enforcement del límite total acumulado**
WHILE a session key delegation is active, the system SHALL atomically check `total_spent + estimatedCostUsd` against `policy.max_total_amount`. IF the result exceeds the limit, THEN the system SHALL reject with HTTP 403 `DELEGATION_TOTAL_LIMIT_EXCEEDED`. The check-and-debit MUST be atomic (DB-level lock or RPC) to prevent race conditions.

**AC-9 — Aislamiento: session key acotada por budget del parent key**
WHILE a session key delegation is active, the system SHALL debit from `budget[chainId]` of the parent Agent Key via the existing `increment_a2a_key_spend` path in addition to incrementing `total_spent`. IF the parent key budget is exhausted, THEN the system SHALL reject with HTTP 403 `AGENT_KEY_BUDGET_EXHAUSTED`. A session key SHALL NOT be able to spend more than `min(policy.max_total_amount, parent_key_budget[chainId])`.

**AC-10 — Revocación explícita por el owner**
WHEN the owner sends `DELETE /auth/delegation/:delegation_id` authenticated with the parent Agent Key, the system SHALL set `revoked_at = now()` in the `a2a_delegations` row and return HTTP 200. Subsequent requests using the session token for that delegation SHALL receive HTTP 403 `DELEGATION_REVOKED`.

**AC-11 — Listado de delegaciones activas**
WHEN the owner sends `GET /auth/delegation` authenticated with the parent Agent Key, the system SHALL return only the delegations where `owner_ref` matches the caller's owner_ref, with fields `delegation_id`, `session_key_address`, `policy`, `expires_at`, `total_spent`, `revoked_at`, and `status` (`active` | `expired` | `revoked`).

**AC-12 — Ownership Guard en toda query/mutación de delegaciones**
the system SHALL filter every DB query or mutation on `a2a_delegations` by both `delegation_id` AND `owner_ref`. IF a caller attempts to read, use, or revoke a delegation belonging to another owner, THEN the system SHALL return HTTP 403 `OWNERSHIP_MISMATCH`.

**AC-13 — Backward-compatibility: master key sin delegación**
WHILE an Agent Key is used directly (master key token, no `wasi_a2a_session_` prefix), the system SHALL continue to function exactly as today — existing `requirePaymentOrA2AKey` debit path, no change to behavior. No existing endpoint SHALL be affected when no delegation is involved.

**AC-14 — EIP-712 domain desde env vars**
the system SHALL read the EIP-712 domain `name` from `DELEGATION_EIP712_NAME` and `version` from `DELEGATION_EIP712_VERSION`. The `chainId` in the domain SHALL be read from `KITE_CHAIN_ID` (existing env var). PROHIBIDO hardcodear estos valores en código de producción.

**AC-15 — Sub-delegación bloqueada**
IF a request authenticated with a session token (`wasi_a2a_session_` prefix) attempts to call `POST /auth/delegation`, THEN the system SHALL return HTTP 403 `DELEGATION_NOT_ALLOWED` without creating any row.

---

## Schema de tabla `a2a_delegations`

```sql
CREATE TABLE a2a_delegations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id              UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  owner_ref           TEXT NOT NULL,                        -- copia desnormalizada para Ownership Guard
  session_key_address TEXT NOT NULL,                        -- EOA address del typed-data (metadata)
  session_token_hash  TEXT NOT NULL UNIQUE,                 -- SHA-256(wasi_a2a_session_<random>)
  policy              JSONB NOT NULL,                       -- { max_amount_per_tx, max_total_amount, expires_at, allowed_chains, allowed_agent_slugs, allowed_registries }
  total_spent         NUMERIC(20,8) NOT NULL DEFAULT 0,     -- acumulador, actualizado atómicamente
  expires_at          TIMESTAMPTZ NOT NULL,                 -- límite duro de TTL
  revoked_at          TIMESTAMPTZ,                          -- null = activa; NOT NULL = revocada
  typed_data_raw      JSONB NOT NULL,                       -- el typed-data completo recibido (auditoría)
  nonce               TEXT NOT NULL,                        -- bytes32 hex del nonce anti-replay
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key_id, nonce)                                    -- anti-replay por (key, nonce)
);

CREATE INDEX idx_a2a_delegations_token_hash ON a2a_delegations (session_token_hash);
CREATE INDEX idx_a2a_delegations_key_owner  ON a2a_delegations (key_id, owner_ref);
```

**Nota:** `policy.expires_at` (en el typed-data EIP-712) debe coincidir con la columna `expires_at`; el server los valida como iguales al crear la delegación.

---

## Scope IN

- `src/types/a2a-key.ts` — tipos `DelegationPolicy`, `DelegationRow`, `SessionKeyErrorCode` nuevos
- `src/types/index.ts` — exports nuevos
- `src/services/delegation.ts` (nuevo) — creación, verificación EIP-712 (`recoverTypedDataAddress`), enforcement de policy, revocación; Ownership Guard obligatorio en todas las queries
- `src/routes/auth.ts` — endpoints `POST /auth/delegation`, `DELETE /auth/delegation/:id`, `GET /auth/delegation`
- `src/middleware/a2a-key.ts` — detectar prefijo `wasi_a2a_session_`, branch hacia delegation enforcement; master key sigue flujo existente
- `src/services/security/errors.ts` — nuevas error classes para delegation (FUNDING_WALLET_NOT_BOUND, DELEGATION_SIGNER_MISMATCH, DELEGATION_NONCE_REPLAY, DELEGATION_REVOKED, DELEGATION_EXPIRED, DELEGATION_TX_LIMIT_EXCEEDED, DELEGATION_TOTAL_LIMIT_EXCEEDED, DELEGATION_NOT_ALLOWED, INVALID_SESSION_TOKEN)
- `supabase/migrations/` — migration para tabla `a2a_delegations` + índices
- `.env.example` — vars `DELEGATION_EIP712_NAME`, `DELEGATION_EIP712_VERSION`
- `test/` — tests unitarios e integración de delegation flows
- `doc/sdd/101-wasiai-agentkey-delegation/` — artefactos de la HU

## Scope OUT

- **Fase 3 reputación on-chain** (WKH-102/103) — explícitamente fuera
- **RLS Postgres sobre `a2a_delegations`** (WKH-SEC-02 carry-forward) — solo app-layer guard en esta HU
- **UI/frontend de delegación** — no aplica (API only)
- **Kite Passport / ERC-8004 como ancla de autoridad** — resuelto: solo `funding_wallet`; ERC-8004 neutral a esta HU
- **Multichain EIP-712 domain por chain** — un solo domain; la policy especifica `allowed_chains` pero el domain usa el chain declarado en `KITE_CHAIN_ID`
- **Smart contract on-chain de delegación** — todo server-side; no deployment de contrato
- **Sub-delegación** — la session key NO puede crear delegaciones (AC-15)
- **Per-request signing por session key EOA** — el token opaco cubre autenticación; EIP-191 per-request es Fase futura
- **`verifyingContract` en EIP-712 domain** — sin contrato on-chain, omitido por decisión NC-3

---

## Decisiones técnicas (DT-N)

**DT-1: viem API para verificación EIP-712**
Usar `recoverTypedDataAddress` de viem v2 (no `verifyTypedData` — el recover permite comparar con `funding_wallet` sin conocer el expected signer de antemano). Verificar firma exacta en viem v2 docs antes de implementar. El story file debe marcar "verificar overloads en viem v2 antes de codear".

**DT-2: EIP-712 typed-data structure**
`primaryType = "Delegation"`. Domain: `{ name: "WasiAI-a2a Delegation", version: "1", chainId: <KITE_CHAIN_ID> }` (sin `verifyingContract`). Mensaje: `{ session_key: address, policy: { max_amount_per_tx: string, max_total_amount: string, expires_at: uint64, allowed_chains: uint256[], allowed_agent_slugs: string[], allowed_registries: string[] }, nonce: bytes32 }`. Tipos Solidity exactos para EIP-712 encoding a definir en F2 SDD.

**DT-3: Nonce anti-replay**
Nonce = `bytes32` hex generado por el cliente (ej. `crypto.randomBytes(32).toString('hex')`). El server persiste `(key_id, nonce)` con constraint UNIQUE. El nonce NO es un counter DB — es random para evitar que el server prediga el siguiente nonce. El server rechaza si ya existe la combinación `(key_id, nonce)` antes de insertar la delegación.

**DT-4: Token opaco `wasi_a2a_session_`**
El server genera `wasi_a2a_session_<48 random bytes hex>` al crear la delegación. Almacena `SHA-256(token)` en `session_token_hash`. El token se devuelve una sola vez en la respuesta 201 — no se puede recuperar después (misma semántica que el master key). El middleware detecta el prefijo `wasi_a2a_session_` para branching; si el token no tiene ese prefijo, sigue el flujo master key existente.

**DT-5: Relación con `budget[chainId]` del parent key**
La policy de delegación ACOTA el gasto (`max_per_tx`, `max_total_amount`) pero el debit SIEMPRE fluye adicionalmente por `increment_a2a_key_spend` del parent Agent Key. Si el parent se queda sin budget, la session key también falla. Si la session key agota `max_total_amount`, la delegación se desactiva aunque el parent tenga budget. Ambos checks son obligatorios.

**DT-6: Storage — tabla `a2a_delegations` separada**
Nueva tabla (no JSONB en `a2a_agent_keys`). Justificación: índice en `session_token_hash` para lookup O(1) en hot path; constraint UNIQUE `(key_id, nonce)` para anti-replay; `revoked_at` indexable; listado por owner eficiente. Schema definido en la sección anterior.

**DT-7: Atomicidad en check-and-debit de `total_spent`**
El incremento de `total_spent` debe ser atómico. Usar `UPDATE a2a_delegations SET total_spent = total_spent + $amount WHERE id = $id AND total_spent + $amount <= policy->>'max_total_amount' RETURNING id` — si no retorna row, la delegación se agotó. Esto previene race conditions en requests concurrentes con la misma session key.

---

## Constraint Directives (CD-N)

**CD-1:** OBLIGATORIO EIP-712 + secp256k1 para toda firma de delegación. PROHIBIDO ethers.js en cualquier parte del codebase. PROHIBIDO cualquier backend propietario externo para verificación de firmas.

**CD-2:** OBLIGATORIO Ownership Guard en toda query/mutación sobre `a2a_delegations` desde services: filtro por `delegation_id` Y `owner_ref`. PROHIBIDO query sobre delegaciones sin filtro de owner (mismo patrón que WKH-53 sobre `a2a_agent_keys`).

**CD-3:** OBLIGATORIO enforcement server-side de los límites `max_amount_per_tx`, `max_total_amount`, `expires_at`, `revoked_at`, y nonce-replay. PROHIBIDO confiar en ningún campo de control del cliente para hacer cumplir la policy.

**CD-4:** OBLIGATORIO anti-replay: cada typed-data de creación incluye un `nonce` (bytes32). El servidor persiste `(key_id, nonce)` con UNIQUE constraint. PROHIBIDO crear delegación sin nonce. PROHIBIDO crear delegación si el nonce ya existe para ese key_id.

**CD-5:** OBLIGATORIO backward-compat: keys existentes sin delegación NO se ven afectadas. El middleware brancha SOLO si el token tiene prefijo `wasi_a2a_session_`. PROHIBIDO cambiar el comportamiento de ningún endpoint existente cuando el caller usa master key.

**CD-6:** PROHIBIDO hardcodes en producción. `DELEGATION_EIP712_NAME`, `DELEGATION_EIP712_VERSION`, `KITE_CHAIN_ID` desde env vars. PROHIBIDO hardcodear chain IDs, domain strings, o addresses de contrato en código que corra en producción.

**CD-7:** OBLIGATORIO TypeScript strict. PROHIBIDO `any` explícito. PROHIBIDO `as unknown` para eludir tipos de viem.

**CD-8:** OBLIGATORIO verificar ambos límites antes de dejar pasar el request: (1) `policy.max_amount_per_tx` y `policy.max_total_amount` de la delegación, y (2) `budget[chainId]` del parent Agent Key. La session key NO PUEDE exceder ninguno de los dos.

**CD-9:** PROHIBIDO que una session key cree sub-delegaciones. OBLIGATORIO que el server rechace `POST /auth/delegation` si el token autenticador tiene prefijo `wasi_a2a_session_`, con HTTP 403 `DELEGATION_NOT_ALLOWED`.

**CD-10:** OBLIGATORIO persistir `revoked_at` para revocación inmediata. PROHIBIDO depender solo del TTL/`expires_at` para declarar una delegación inactiva: si fue revocada explícitamente, el `revoked_at` se chequea en CADA request.

**CD-11:** OBLIGATORIO que el ancla de autoridad sea exclusivamente el `funding_wallet` bindeado. PROHIBIDO usar `erc8004_identity.owner_address` o `owner_ref` (string) como ancla de firma. Si `funding_wallet` es null → error `FUNDING_WALLET_NOT_BOUND`, no fallback.

**CD-12:** OBLIGATORIO que el check-and-debit de `total_spent` sea atómico a nivel DB (UPDATE condicional en una sola sentencia). PROHIBIDO patrón read-then-write en código de aplicación para `total_spent`.

---

## Missing Inputs

- Ninguno. Los 4 NC bloqueantes están resueltos.
- **[RESUELTO - NC-1]** Ancla: `funding_wallet` exclusivo.
- **[RESUELTO - NC-4]** Session key auth: token opaco `wasi_a2a_session_`.
- **[RESUELTO - NC-2]** Revocación: `revoked_at` persistido + `expires_at` como límite duro.
- **[RESUELTO - NC-3]** EIP-712 domain sin `verifyingContract`: `{ name, version, chainId }`.

---

## Análisis de paralelismo

- **Depende de:** WKH-35 (funding-wallet binding, DONE merged) — el ancla es `funding_wallet`, que ya existe en prod.
- **Depende de:** WKH-100 (Fase 1 ERC-8004, DONE merged) — aunque la ancla de autoridad no usa ERC-8004, la Fase 1 fue prerequisito conceptual.
- **Bloquea:** WKH-102/WKH-103 (Fase 3 reputación) — conceptualmente, no de código.
- **Puede ir en paralelo con:** cualquier HU que no toque `src/middleware/a2a-key.ts` o `src/routes/auth.ts`.
- **Riesgo de conflicto:** HUs que modifiquen `requirePaymentOrA2AKey` o `auth.ts` deben coordinarse con esta rama antes de merge.
