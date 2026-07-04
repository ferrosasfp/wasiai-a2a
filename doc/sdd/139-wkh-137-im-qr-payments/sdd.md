# SDD #139: [WKH-137 v1] Invocation Links — mint + redeem de token opaco single-use price-capped

> SPEC_APPROVED: no
> Fecha: 2026-07-04
> Tipo: feature (money-path)
> SDD_MODE: full
> Branch: feat/139-wkh-137-invocation-links
> Artefactos: doc/sdd/139-wkh-137-im-qr-payments/

---

## 1. Resumen

Se construye una **primitiva protocolar nueva**: un *invocation link* — un token
opaco, single-use, con price-cap, atado a un agente-target y al `owner_ref` del
minter. Un caller autenticado (Agent Key **master**) mintea el link (`POST
/agents/:slug/link`) definiendo `maxPriceUsdc` (+ TTL); cualquier canal externo
(bot, página QR — **fuera de esta HU**) lo redime (`POST
/agents/links/:token/redeem`) con un input, y el gateway invoca al agente **bajo
la key/owner del link**, capeado al `maxPriceUsdc`, marcando el token consumido de
forma **atómica** (single-use inviolable, cero doble-redeem/doble-cobro bajo
concurrencia).

El redeem **reusa el money-path existente** (`orchestrateService.executeApprovedPlan`,
WKH-131) — no reinventa settle/fee/receipt/refund. La única pieza nueva de
dinero es el **status-gate atómico** del single-use, modelado como espejo directo
del ciclo `open → closing → settled/refunded` de `a2a_payment_intents` (WKH-135).

Resultado esperado: una tabla nueva `a2a_agent_links` + 2 RPC atómicos + 1 service
+ 2 endpoints, todo aditivo, sin tocar `compose`/`orchestrate` internamente.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 139 (WKH-137 v1) |
| **Tipo** | feature / money-path |
| **SDD_MODE** | full |
| **Objetivo** | Mint + redeem de un invocation link opaco, single-use, price-capped, reusando el execute capeado de WKH-131. |
| **Reglas de negocio** | Single-use inviolable; price-cap inviolable (server-side); token opaco no adivinable, hash-only; Ownership Guard `owner_ref`; RLS deny-by-default; fail-closed. |
| **Scope IN** | Tabla `a2a_agent_links` + migración up/down; RPC `claim_agent_link` + `settle_agent_link`; `src/services/agent-link.ts`; `src/routes/agent-links.ts` (mint + redeem); tipos; tests money-path. |
| **Scope OUT** | Bot Telegram/WhatsApp; QR/imagen; página de redeem; seller sin HTTP; onboarding desde cero; mint desde session key (diferido, ver DT-6); metered/subscription (es `session`/`upto`, WKH-135). |
| **Missing Inputs** | Ninguno bloqueante para el v1. Los `[NEEDS CLARIFICATION]` del work-item (#1,#2,#3,#4,#5) son de HUs diferidas (canal/seller/onboarding), NO de esta. |

### Acceptance Criteria (EARS) — heredados del work-item, restated

- **AC-1** — WHEN un caller autenticado con **Agent Key master** invoca `POST
  /agents/:slug/link` con `{maxPriceUsdc, ttlSeconds?}`, THE system SHALL mintear un
  token opaco (persiste SOLO `SHA-256(token)`) atado a `{slug, owner_ref del caller,
  key_id, chain_id, maxPriceUsdc, expiresAt}` y SHALL retornarlo **una única vez** en
  el body del 201.
- **AC-2** — WHEN `POST /agents/links/:token/redeem` recibe un token válido, no
  expirado y no usado, THE system SHALL resolver el precio actual vía
  `resolveAgentPriceUsdc`, y SI `currentPriceUsdc <= maxPriceUsdc` ENTONCES SHALL
  invocar el agente por el path de execute existente **bajo el `owner_ref`/key del
  link**, y SHALL marcar el token consumido de forma **atómica** (no redimible dos
  veces).
- **AC-3** — IF el redeem resuelve `currentPriceUsdc > maxPriceUsdc`, THEN THE system
  SHALL responder `409 PRICE_EXCEEDS_LINK_CAP` SIN debitar, SIN invocar y **SIN
  consumir** el token (retryable / expira por TTL).
- **AC-4** — IF el redeem recibe un token inexistente, expirado o ya consumido, THEN
  THE system SHALL responder `404 LINK_NOT_FOUND`, `410 LINK_EXPIRED` o `409
  LINK_ALREADY_USED` respectivamente, sin ningún debit ni intento de invocación.
- **AC-5** — WHILE un link no fue redimido ni expiró, THE system SHALL NO exponer
  ningún endpoint que permita modificar `slug`, `owner_ref` o `maxPriceUsdc`
  (mint-once, sin PATCH).
- **AC-6** — WHEN un redeem exitoso debita al owner del link, THE system SHALL aplicar
  las mismas invariantes que el execute de hoy (protocol fee, receipt, Ownership Guard
  `owner_ref`) — el redeem NO es un bypass nuevo del guard.
- **AC-7** — WHERE el token es consumido por un canal externo, THE system SHALL diseñar
  el token para que su exposición NO otorgue más que "ejecutar este agente una vez
  hasta este price-cap" — nunca acceso al balance completo, a otros agentes, ni a
  gestión de la key (mint/list/revoke).

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/services/key-session.ts` | Exemplar #1: token opaco hash-only, `owner_ref`/`key_id` desde el row del caller (nunca del request), lookup sin owner-gate autenticado por token, Ownership Guard en list/revoke, mapeo de errores por prefijo de RPC | Prefijo constante + `crypto.randomBytes(48).toString('hex')` + `createHash('sha256')`; `lookupByTokenHash` (única fn sin owner-gate, documentada); `getParentKey(keyId)` (SELECT `*` by id, `asAgentKeyRow`) |
| `src/routes/auth/key-session.ts` | Exemplar #2: ruta de *management free* (crea sesión) con `resolveCallerKey` + gate que **rechaza tokens de sesión** como authenticator (`rawKey.startsWith(PREFIX)` → 403) antes de auth | Mint = free management op → `resolveCallerKey`, NO `requirePaymentOrA2AKey`; reject session-prefix; 201 con token una vez |
| `supabase/migrations/20260603000000_a2a_key_sessions.sql` | Exemplar #3: tabla con `owner_ref` desnormalizado + UNIQUE(token_hash) + RPC `debit_session_and_parent` (FOR UPDATE + Ownership Guard DB-level + hardening search_path/REVOKE/GRANT) | Estructura de tabla + índices; RPC `SECURITY DEFINER` con lock, guard `IS DISTINCT FROM`, `ALTER FUNCTION ... SET search_path` + `REVOKE ... FROM PUBLIC,anon,authenticated` + `GRANT ... TO service_role` |
| `supabase/migrations/20260704000000_wkh135_payment_intents.sql` | Exemplar #4 (el más cercano): single-use money-path atómico. Ciclo `open → closing → settled/refunded/failed`, status-gate para exactly-once, money-effect DENTRO de la tx status-gated, `record_settle_outcome` antes del finalize, RLS deny-by-default, trigger `updated_at` | `claim`/`finalize` pattern; `IF v_status <> 'closing' THEN RETURN` (idempotencia); `CHECK (status IN (...))`; `UNIQUE settle_tx_hash`; RLS `ENABLE ROW LEVEL SECURITY` sin policy permisiva |
| `supabase/migrations/20260704000000_wkh135_payment_intents_down.sql` | Convención down migration (R-1) | `BEGIN; DROP FUNCTION ...(tipos exactos); DROP TABLE ...; COMMIT;` |
| `src/routes/orchestrate.ts` (`/execute`, L287-464) | Exemplar #5: cómo construir un `OrchestratePlanResult` server-side (steps + `costPerStep` re-resueltos + `plannedCostUsd` + `feeUsdc` + `billingKeyRow`) y llamar `executeApprovedPlan` con `maxQuotedCostUsdc`; mapeo `__quoteStale` → 409 | El redeem arma un plan **de un solo step** `[{agent: slug, input}]` con `billingKeyRow = owner key del link`, `maxQuotedCostUsdc = maxPriceUsdc`, `chainId = link.chain_id` |
| `src/services/orchestrate.ts` (`executeApprovedPlan`, L880-1080) | Confirmar el punto de reuso del settle: cap-gate ANTES de cualquier débito (L920-934 → `__quoteStale`), débito step-0 por `budgetService.debit` con `owner_ref`, credit-back en fallo | El cap se enforcea DENTRO de execute (fuente de verdad server-side); `__quoteStale` garantiza **cero débito** → base de la reapertura del token en AC-3 |
| `src/services/agent-price.ts` | `resolveAgentPriceUsdc(slug, registry?, forceRefresh?)` — reuso tal cual (solo lectura, Scope IN work-item) | Cache in-process 60s; `forceRefresh` para bust; retorna `null` si el agente no existe |
| `src/middleware/a2a-key.ts` (L63-67, L512/753/975) | Decorators `request.a2aKeyRow: A2AAgentKeyRow` y `request.resolvedChainId: number` disponibles post-auth | El mint lee `a2aKeyRow` (master) + `resolvedChainId` para persistir `key_id`/`owner_ref`/`chain_id` |
| `src/types/a2a-key.ts` (L69-114) | `A2AAgentKeyRow { id, owner_ref, budget: Record<string,string>, ... }` + `asAgentKeyRow` | Tipo del row de la key para el billing del redeem |
| `src/index.ts` (L143-153) | Registro de rutas; `/agents` prefix ya usado por `agentCardRoutes` + `agentsRoutes` (Fastify soporta varios plugins por prefijo) | La ruta nueva `agentLinkRoutes` se registra bajo `/agents` (mismo prefijo) — verificar cero colisión de rutas exactas |
| `doc/sdd/138-wkh-136-atomic-splits-bps/auto-blindaje.md` | Auto-Blindaje reciente (money-path) | Ver CD-9/CD-10/CD-11 (heredados de errores recurrentes) |

### Exemplars (verificados con Glob/Read)

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `supabase/migrations/…_wkh137_agent_links.sql` | `20260704000000_wkh135_payment_intents.sql` | Tabla single-use + RPC atómico status-gated + RLS + trigger |
| `supabase/migrations/…_wkh137_agent_links_down.sql` | `20260704000000_wkh135_payment_intents_down.sql` | DROP con firmas exactas |
| `src/services/agent-link.ts` | `src/services/key-session.ts` | Token opaco hash-only + mint + lookup + owner-guard + mapeo de errores RPC |
| `src/routes/agent-links.ts` (mint) | `src/routes/auth/key-session.ts` (POST) | Management op free: `resolveCallerKey` + reject session prefix |
| `src/routes/agent-links.ts` (redeem, construcción del plan) | `src/routes/orchestrate.ts` (`/execute`) | Armar `OrchestratePlanResult` de 1 step + `executeApprovedPlan` capeado |
| `test/…/agent-link.test.ts` | `src/services/money-path.concurrency.test.ts`, `payment-intent.test.ts` | Concurrencia (doble-redeem), price-cap, ownership, expiry |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `a2a_agent_links` | **No** (se crea en W0) | `token_hash` UNIQUE, `owner_ref`, `key_id`, `slug`, `registry`, `max_price_usdc`, `chain_id`, `status`, `expires_at`, `redeemed_at`, `settle_tx_hash`, `consumed_cost_usdc`, `error_message`, timestamps |
| `a2a_agent_keys` | Sí | `id`, `owner_ref`, `budget` — se LEE (owner key del link); nunca se muta desde este service salvo vía RPC de débito existente |
| `a2a_payment_intents` | Sí (WKH-135) | referencia de patrón; NO se toca |

### Componentes reutilizables encontrados

- `resolveAgentPriceUsdc` (`src/services/agent-price.ts`) — precio server-side. Reusar.
- `orchestrateService.executeApprovedPlan` (`src/services/orchestrate.ts`) — settle/fee/receipt/refund + cap-gate. Reusar (NO reinventar).
- `keySessionService.getParentKey` — patrón de carga de la owner key by id (mismo SELECT `*` sin owner-gate, autenticado por posesión del token). Replicar en `agent-link.ts` (no acoplar cross-service).
- `resolveCallerKey`, `rawKeyFromRequest`, `KEY_SESSION_TOKEN_PREFIX` (`src/routes/auth/parsers.ts`) — auth + reject-session-prefix en el mint.
- `createBackpressureHandler`, `createTimeoutHandler`, rate-limit middlewares — preHandlers del redeem.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `supabase/migrations/YYYYMMDD000000_wkh137_agent_links.sql` | Crear | Tabla `a2a_agent_links` + RPC `claim_agent_link` + `settle_agent_link` + RLS + trigger `updated_at` | `…wkh135_payment_intents.sql` |
| `supabase/migrations/YYYYMMDD000000_wkh137_agent_links_down.sql` | Crear | DROP RPCs (firmas exactas) + DROP TABLE | `…wkh135_payment_intents_down.sql` |
| `src/types/index.ts` (o `src/types/a2a-key.ts`) | Modificar | Tipos `AgentLinkRow`, `CreateAgentLinkInput`, `MintAgentLinkResponse`, `AgentLinkClaim` | tipos de `key-session` en `src/types/index.ts` |
| `src/types/database.types.ts` | Modificar | Regenerar/añadir `a2a_agent_links` Row/Insert + Functions `claim_agent_link`/`settle_agent_link` | entradas de `a2a_payment_intents` |
| `src/services/agent-link.ts` | Crear | `mint()`, `lookupByTokenHash()`, `getKeyById()`, `redeem()` (claim → execute → settle) + error classes | `src/services/key-session.ts` |
| `src/routes/agent-links.ts` | Crear | `POST /agents/:slug/link` (mint, free auth) + `POST /agents/links/:token/redeem` (público, billing interno) | `auth/key-session.ts` + `orchestrate.ts` |
| `src/index.ts` | Modificar | `register(agentLinkRoutes, { prefix: '/agents' })` | L144-153 |
| `src/services/agent-link.test.ts` | Crear | Tests unit del service (mint/redeem/errores/concurrencia) | `payment-intent.test.ts` |
| `src/routes/agent-links.test.ts` | Crear | Tests de ruta (auth mint, público redeem, mapeo HTTP) | `orchestrate.test.ts` |

> **Ninguna modificación a `compose.ts` ni a `orchestrate.ts` (solo se LLAMAN).**
> `agent-price.ts` solo se lee/importa. (Scope IN del work-item.)

### 4.2 Modelo de datos

**Tabla `a2a_agent_links`** (patrón `a2a_payment_intents`):

| Columna | Tipo | Nota |
|---------|------|------|
| `id` | UUID PK default gen_random_uuid() | |
| `token_hash` | TEXT NOT NULL **UNIQUE** | `SHA-256(token)` — hot-path lookup; UNIQUE = índice O(1) (no crear índice redundante) |
| `owner_ref` | TEXT NOT NULL | Ownership Guard (CD-2), desde el row del minter |
| `key_id` | UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE | key que se debita al redimir |
| `slug` | TEXT NOT NULL | agente target |
| `registry` | TEXT | hint opcional (nullable) |
| `max_price_usdc` | NUMERIC(20,8) NOT NULL **CHECK (max_price_usdc >= 0)** | price-cap |
| `chain_id` | INT NOT NULL | resuelto en el mint (para el débito) |
| `status` | TEXT NOT NULL DEFAULT 'open' **CHECK (status IN ('open','redeeming','redeemed','failed'))** | single-use FSM |
| `redeemed_at` | TIMESTAMPTZ | set al terminal `redeemed` |
| `settle_tx_hash` | TEXT | auditoría (del pipeline) |
| `consumed_cost_usdc` | NUMERIC(20,8) | costo real cobrado |
| `expires_at` | TIMESTAMPTZ NOT NULL | now()+ttl (server-side) |
| `error_message` | TEXT | outcome failed |
| `created_at` / `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | `updated_at` vía trigger `trigger_set_updated_at` |

Índices: `idx_a2a_agent_links_key_owner (key_id, owner_ref)`, `idx_a2a_agent_links_owner (owner_ref)`, `idx_a2a_agent_links_status (status)`.
RLS: `ALTER TABLE a2a_agent_links ENABLE ROW LEVEL SECURITY` **deny-by-default, sin policy permisiva** (service_role bypassa por BYPASSRLS).

**FSM del token (single-use):**

```
        mint                 claim (atómico)        settle (status-gated)
  ──────────────►  open  ──────────────────►  redeeming  ─────┬──────►  redeemed   (terminal, éxito)
                    ▲                                          ├──────►  open        (reopen: __quoteStale, cero débito garantizado)
                    └──────────────────────────────────────────┘
                                                               └──────►  failed      (terminal: throw ambiguo, fail-closed)
```

**RPC 1 — `claim_agent_link(p_token_hash TEXT)` RETURNS row** (mirror `close_payment_intent_for_settle`):
- `SELECT ... FROM a2a_agent_links WHERE token_hash = p_token_hash FOR UPDATE`.
- `NOT FOUND` → `RAISE 'LINK_NOT_FOUND'`.
- `status = 'open' AND NOW() >= expires_at` → `RAISE 'LINK_EXPIRED'`.
- `status IN ('redeeming','redeemed')` → `RAISE 'LINK_ALREADY_USED'` (el 2º redeem concurrente pierde el lock-race → cae acá).
- `status = 'failed'` → `RAISE 'LINK_ALREADY_USED'` (terminal).
- `status = 'open'` (no expirado) → `UPDATE ... SET status='redeeming'` y devuelve `{id, owner_ref, key_id, slug, registry, max_price_usdc, chain_id}`.
- Hardening: `SECURITY DEFINER` + `SET search_path` + `REVOKE ... FROM PUBLIC,anon,authenticated` + `GRANT ... TO service_role`.

**RPC 2 — `settle_agent_link(p_id, p_owner_ref, p_outcome, p_tx_hash, p_cost, p_error)` RETURNS void** (mirror `finalize_payment_intent`, idempotente + status-gated):
- `SELECT owner_ref, status ... WHERE id = p_id FOR UPDATE`; `NOT FOUND` → RAISE; `owner_ref IS DISTINCT FROM p_owner_ref` → `RAISE 'OWNERSHIP_MISMATCH'`.
- `IF status <> 'redeeming' THEN RETURN` (idempotencia: exactly-once bajo retry).
- `p_outcome = 'redeemed'` → `status='redeemed', redeemed_at=now(), settle_tx_hash=p_tx_hash, consumed_cost_usdc=p_cost`.
- `p_outcome = 'reopen'` → `status='open'` (retryable — usado SOLO cuando execute devolvió `__quoteStale`, que garantiza cero débito).
- `p_outcome = 'failed'` → `status='failed', error_message=p_error` (terminal, throw ambiguo → NO reabrir para no habilitar doble-cobro).

> **NOTA money-path (crítica, hereda lección WKH-135):** el status-flip del single-use
> vive en la MISMA tx que su decisión (RPC). El **dinero** (débito/fee/refund) lo mueve
> `executeApprovedPlan` (path existente), que ya es status-gated e idempotente por su
> propio `orchestrationId`. El link NO mueve dinero — solo gobierna el single-use. Como
> el claim (`open→redeeming`) y la ejecución del dinero están **separados por una llamada
> HTTP externa** (no se puede sostener un `FOR UPDATE` sobre un invoke remoto), el patrón
> es claim-antes-de-invoke (igual que `closing` antes del settle en WKH-135), NUNCA
> "debitar y después marcar".

### 4.3 Componentes / Servicios

**`agentLinkService` (`src/services/agent-link.ts`):**

- `mint(minterKey: A2AAgentKeyRow, slug: string, input: CreateAgentLinkInput, chainId: number): Promise<MintAgentLinkResponse>`
  - Valida `maxPriceUsdc` (decimal `> 0`, patrón `POSITIVE_DECIMAL_RE` de key-session) y `ttlSeconds` (entero `>0`, `<= LINK_MAX_TTL_SECONDS` env con fail-safe default, p.ej. 86400).
  - `expiresAt = now + ttl` (server-side).
  - Token opaco `wasi_a2a_link_<randomBytes(48).hex>`; persiste SOLO `SHA-256`.
  - INSERT con `owner_ref`/`key_id` desde `minterKey` (NUNCA del request), `chain_id` desde `chainId`, `slug` del path param.
  - Devuelve `{ link_id, token (una vez), slug, max_price_usdc, expires_at }`.
- `lookupByTokenHash(hash): Promise<AgentLinkRow | null>` — SELECT `*` by `token_hash`, PGRST116→null. **Única fn sin owner-gate** (el redeemer se autentica por posesión del token; documentar como key-session L262-276). NO es IDOR.
- `getKeyById(keyId): Promise<A2AAgentKeyRow | null>` — carga la owner key (patrón `getParentKey`). Server-side, sin owner-gate (el keyId sale del link, no del request).
- `redeem(token: string, redeemInput: object): Promise<RedeemResult>` — orquesta el flujo 4.4.

**Route (`src/routes/agent-links.ts`):**
- `POST /agents/:slug/link` — preHandlers: rate-limit. Handler: `resolveCallerKey` + **reject session prefix** (`KEY_SESSION_TOKEN_PREFIX`) → 403 SESSION_NOT_ALLOWED (CD-6) + reject link-prefix también → llama `mint`. 201.
- `POST /agents/links/:token/redeem` — **público** (sin `requirePaymentOrA2AKey`). preHandlers: rate-limit + backpressure + timeout. Handler: llama `redeem`, mapea outcome a HTTP.

### 4.4 Flujo principal (Happy Path — redeem)

1. Canal externo POST `/agents/links/:token/redeem` con `{ input }`.
2. `hash = SHA-256(token)`; `lookupByTokenHash(hash)`.
   - `null` → **404 LINK_NOT_FOUND**.
   - `status != 'open'` → **409 LINK_ALREADY_USED**. `now >= expires_at` → **410 LINK_EXPIRED**.
3. `price = resolveAgentPriceUsdc(link.slug, link.registry, forceRefresh=true)`.
   - `price === null` → **404** (agente no existe) o **503** si discovery throws (mapeo del preHandler existente).
   - `price > link.max_price_usdc` → **409 PRICE_EXCEEDS_LINK_CAP**, cero DB write (AC-3).
4. `claim_agent_link(hash)` (atómico `open→redeeming`).
   - RPC RAISE `LINK_ALREADY_USED`/`LINK_EXPIRED`/`LINK_NOT_FOUND` → mismo mapeo HTTP (concurrencia: el 2º redeem cae acá).
5. `ownerKey = getKeyById(link.key_id)`; construye plan de 1 step `[{agent: link.slug, registry: link.registry, input}]`, `billingKeyRow = ownerKey`, `maxQuotedCostUsdc = link.max_price_usdc`, `chainId = link.chain_id` (patrón `/orchestrate/execute`).
6. `result = executeApprovedPlan(request, plan, orchestrationId)` — hace cap-gate + débito + invoke + fee + receipt + refund-en-fallo (path existente).
   - `result` normal → `settle_agent_link(id, owner, 'redeemed', txHash, cost)` → **200** con `{ answer, pipeline, protocolFeeUsdc, kiteTxHash, remainingBudgetUsd }`.
   - `result.__quoteStale` (precio drifteó `> cap` post-claim; **cero débito** garantizado por el cap-gate L920-934) → `settle_agent_link(id, owner, 'reopen', …)` → **409 PRICE_EXCEEDS_LINK_CAP**.
7. Fin.

### 4.5 Flujo de error

1. **Token inexistente** → 404 LINK_NOT_FOUND (paso 2). Disclosure-safe (no revela owner).
2. **Token expirado** → 410 LINK_EXPIRED (paso 2 o RPC bajo lock).
3. **Token ya usado / redeem concurrente** → 409 LINK_ALREADY_USED. El claim atómico (`FOR UPDATE` + status-gate) garantiza que de N redeems concurrentes **exactamente uno** transiciona `open→redeeming`; los demás caen en `LINK_ALREADY_USED`. **Cero doble-cobro** (CD-4).
4. **Precio excede cap (pre-claim)** → 409 PRICE_EXCEEDS_LINK_CAP, sin write, retryable (AC-3).
5. **Precio drifteó `> cap` post-claim** → execute retorna `__quoteStale` (cero débito) → `reopen` → 409 PRICE_EXCEEDS_LINK_CAP (retryable).
6. **`executeApprovedPlan` THROW** (registry unavailable / error inesperado — débito **ambiguo**) → `settle_agent_link(id, owner, 'failed', error)` (terminal, fail-closed: NO reabrir para no habilitar retry con posible doble-cobro) → **502/500**. El caller puede mintear un link nuevo. (Tradeoff documentado para AR — RIESGO-3.)
7. **Owner key sin fondos** → `executeApprovedPlan` retorna graceful `pipeline.success=false` con `remainingBudgetUsd` (no throw, no `__quoteStale`) → se trata como paso 6 outcome normal: single-use **consumido** (`redeemed`) con `pipeline.success=false`. (El link se gastó; el buyer no fue debitado — el path existente ya no cobra si el débito falla. Documentado como RIESGO-4.)

---

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir

- **CD-OBL-1** — Token opaco: `wasi_a2a_link_<crypto.randomBytes(48).hex>`; persistir SOLO `SHA-256`. Mismo patrón que `key-session.ts` L186-189.
- **CD-OBL-2** — RPC atómicos `SECURITY DEFINER` con `FOR UPDATE`, guard `owner_ref IS DISTINCT FROM`, `SET search_path = public, pg_temp`, `REVOKE ... FROM PUBLIC, anon, authenticated`, `GRANT ... TO service_role`. Espejo de `debit_session_and_parent` / `finalize_payment_intent`.
- **CD-OBL-3** — Reusar `orchestrateService.executeApprovedPlan` + `resolveAgentPriceUsdc` para el settle/precio. **No** reimplementar débito/fee/receipt/refund.
- **CD-OBL-4** — El cap-gate autoritativo es `maxQuotedCostUsdc` dentro de execute (server-side). El precio del request/canal NUNCA es fuente de verdad (mismo principio que `/orchestrate/execute` CD-2).
- **CD-OBL-5** — TypeScript strict, sin `any`/`as unknown` salvo el narrowing acotado NUMERIC→string documentado (patrón key-session L221).

### PROHIBIDO (heredados del work-item + nuevos)

- **CD-1** (heredado) — PROHIBIDO persistir el token crudo. Solo `SHA-256`.
- **CD-2** (heredado) — OBLIGATORIO `owner_ref` en TODA query de `a2a_agent_links` de mint/list/gestión (Ownership Guard, CLAUDE.md WKH-53). Excepción **única y documentada**: `lookupByTokenHash` / `claim_agent_link` autenticados por posesión del token (NO IDOR — igual que `key-session.lookupByTokenHash` L262).
- **CD-3** (heredado) — PROHIBIDO exceder el price-cap sin rechazo explícito (AC-3). Precio resuelto server-side.
- **CD-4** (heredado) — PROHIBIDO reusar un token consumido. Claim + status-gate atómico; N redeems concurrentes → 1 solo invoca.
- **CD-5** — PROHIBIDO mover dinero fuera del path existente (`executeApprovedPlan`). El link NO debita/settlea/refunda por su cuenta.
- **CD-6** — PROHIBIDO permitir mint desde un **session token** en v1 (rechazar prefijo `wasi_a2a_sess_` → 403 SESSION_NOT_ALLOWED). Razón: `request.a2aKeyRow` para un caller de sesión es la **parent master key** (a2a-key.ts:512/753) y el `keySessionContext` (el cap de la sesión) NO se persiste en el link → un link session-minted debitaría la master **bypasseando el cap de la sesión** (money-path leak / cap-bypass). Diferido a HU futura con dual-ledger billing. Ver DT-6.
- **CD-7** — PROHIBIDO cualquier endpoint PATCH/PUT sobre un link (AC-5: mint-once inmutable). Solo mint + redeem (+ opcional list/revoke con Ownership Guard, si se agrega — no es AC de esta HU).
- **CD-8** — PROHIBIDO reabrir (`reopen`) un link tras un `throw` de execute (débito ambiguo). Reopen SOLO en `__quoteStale` (cero débito garantizado por el cap-gate).
- **CD-9** (Auto-Blindaje WKH-133/134/136) — PROHIBIDO `x: cond ? v : undefined` en objetos tipados con opcionales (`exactOptionalPropertyTypes:true`). Usar asignación condicional `if (v !== undefined) obj.x = v`. Referencia: WKH-136 auto-blindaje #"Wave 0/2".
- **CD-10** (Auto-Blindaje WKH-136) — En mocks de supabase awaitables/thenable, `biome-ignore lint/suspicious/noThenProperty` **puntual** por línea, nunca a nivel archivo.
- **CD-11** (Auto-Blindaje WKH-136) — Down migration con firmas `DROP FUNCTION ...(tipos exactos)` (R-1). Verificar cada tipo del RPC.
- **CD-12** — PROHIBIDO crear un índice explícito sobre `token_hash` (el `UNIQUE` ya da el btree O(1) — lección WKH-101 citada en key-sessions L18-19).
- **CD-13** — NO tocar `compose.ts`, `orchestrate.ts` (service), `agent-price.ts` (solo lectura/import). NO agregar dependencias nuevas.

---

## 6. Scope

**IN:** tabla + migración up/down; 2 RPC; `agent-link.ts`; `agent-links.ts` (mint + redeem); tipos; registro en index.ts; tests money-path.

**OUT:** bot/canal IM; QR/imagen/página; seller sin HTTP; onboarding desde cero; mint desde session key (DT-6, diferido); metered/subscription; list/revoke de links (no es AC de esta HU — puede agregarse aditivo pero no es requerido).

---

## 7. Decisiones técnicas (DT-N)

- **DT-1** (heredado) — El link es una **autorización pre-firmada**, no una wallet: el minter (con Agent Key) decide "autorizo hasta $X para este agente"; el canal solo redime. Reusa el modelo de session keys (sin wallet al usuario final).
- **DT-2** (heredado) — Single-use, NO suscripción. Un link = exactamente una invocación. Recurrencia = `session`/`upto` (WKH-135), no esta HU.
- **DT-3** (heredado) — Mint requiere Agent Key **master** existente (auth previa). Sin onboarding desde cero.
- **DT-4 (nuevo, resuelto)** — El link ata **un agente-target (`slug`)** + `max_price_usdc` + `owner`. El **input** se provee en el **redeem** (no se pre-encoda en el mint). Razón: mantiene el token mínimo/opaco y flexible; consistente con AC-7 (un leak solo permite "ejecutar este agente una vez ≤ cap"). Pre-binding de input = mejora futura, no v1.
- **DT-5 (nuevo, resuelto)** — El redeem factura vía `executeApprovedPlan` con un **plan de 1 step** y `billingKeyRow = owner key del link`. Se reusa 100% el settle/fee/receipt/refund/cap-gate (no reinventar). `__quoteStale` (cap-gate) es la señal de "precio drifteó > cap → cero débito → reopen".
- **DT-6 (nuevo, resuelto — narrowing de AC-1)** — v1 rechaza **session tokens** como authenticator del mint (CD-6). AC-1 menciona "session key"; el Architect lo acota a Agent Key master por seguridad money-path (evita cap-bypass de la sesión al no persistir `keySessionContext`). Session-key minting = HU futura con dual-ledger billing. **Flag explícito para el humano/AR** (no es `[NEEDS CLARIFICATION]` bloqueante: es una decisión de CÓMO que reduce superficie de ataque; el QUÉ — "mintear con una key existente autenticada" — se preserva).
- **DT-7 (nuevo, resuelto)** — Router precedence: `POST /agents/:slug/link` (paramétrico) vs `POST /agents/links/:token/redeem` (segmento estático `links`). Fastify prioriza estático sobre paramétrico → `links` no colisiona. Riesgo residual: un `slug` literalmente llamado `links` quedaría sombreado en el mint. Mitigación: reservar `links` como slug no-minteable (rechazo 400 en el mint si `slug === 'links'`). Ver RIESGO-5.

---

## 8. Riesgos

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|--------|-------|---------|-----------|
| RIESGO-1 | Link leak (chat público) canjeable por cualquiera hasta el cap | M | M | Single-use + price-cap + TTL corto + token 48-byte no adivinable (AC-7). Segundo factor (PIN/IP) NO se implementa en v1 — decisión ratificada (diferido). |
| RIESGO-2 | Race en redeem concurrente → doble invoke/cobro | B | A | `claim_agent_link` `FOR UPDATE` + status-gate `open→redeeming`; solo 1 gana. Test de concurrencia obligatorio. |
| RIESGO-3 | `executeApprovedPlan` throw con débito ambiguo → si se reabre, doble-cobro en retry | B | A | CD-8: throw → `failed` terminal (fail-closed), nunca reopen. Reopen SOLO en `__quoteStale`. |
| RIESGO-4 | Owner key sin fondos → link se consume sin invocación útil | M | B | Path existente retorna graceful (no throw, no débito) → link `redeemed` con `pipeline.success=false`. Buyer no debitado. Documentado. |
| RIESGO-5 | Slug `links` sombrea la ruta de redeem | B | M | DT-7: reservar `links` como slug no-minteable (400). Test de routing. |
| RIESGO-6 | Ownership: nueva tabla sin `owner_ref`/RLS desde día 1 | B | A | `owner_ref` NOT NULL + RLS deny-by-default en la migración (CD-2). Verificable en `verify-rls-enabled.test.ts`. |
| RIESGO-7 | `exactOptionalPropertyTypes`/biome en mocks (recurrente WKH-133/134/136) | M | B | CD-9/CD-10. |

---

## 9. Dependencias

- WKH-121 (session keys / token opaco hash-only) — **DONE**, patrón base.
- WKH-131 (`/orchestrate/plan`+`/execute`, `executeApprovedPlan`) — **DONE**, punto de reuso del settle.
- WKH-135 (`a2a_payment_intents` single-use atómico) — **DONE**, patrón del status-gate.
- WKH-59 (`resolveAgentPriceUsdc`) — **DONE**, precio server-side.
- WKH-SEC-02 (RLS deny-by-default) — **DONE**, patrón RLS.
- Migración aplicada en Supabase (caldz/prod + dev) — ver `scripts/migrate-preflight.mjs`.

---

## 10. Waves de Implementación

### Wave 0 (Serial Gate — contratos/tipos/DB)
- **W0.1** — Migración `…_wkh137_agent_links.sql`: tabla + índices + RLS + trigger + RPC `claim_agent_link` + `settle_agent_link` (hardening completo). Exemplar: `…wkh135_payment_intents.sql`.
- **W0.2** — Migración down (`_down.sql`) con firmas DROP exactas (CD-11).
- **W0.3** — Tipos `AgentLinkRow`/`CreateAgentLinkInput`/`MintAgentLinkResponse`/`AgentLinkClaim` + entradas `a2a_agent_links` + Functions en `database.types.ts`.
- Verificación: `tsc --noEmit` + `migrate:preflight` sobre Postgres efímero.

### Wave 1 (Parallelizable — service + mint)
- **W1.1** — `src/services/agent-link.ts`: `mint()`, `lookupByTokenHash()`, `getKeyById()` + error classes. Exemplar: `key-session.ts`.
- **W1.2** — `src/routes/agent-links.ts` mint handler `POST /agents/:slug/link` + reject session/link prefix + reserva slug `links`. Exemplar: `auth/key-session.ts` (POST).

### Wave 2 (Depende de W0 + W1 — redeem)
- **W2.1** — `agentLinkService.redeem()`: claim → getKeyById → construir plan 1-step → `executeApprovedPlan` capeado → `settle_agent_link`. Exemplar: `orchestrate.ts` `/execute` (L365-450) + `finalize_payment_intent` semántica.
- **W2.2** — `agent-links.ts` redeem handler público + preHandlers (rate-limit/backpressure/timeout) + mapeo HTTP (404/410/409/200/502). Exemplar: `orchestrate.ts` preHandlers.
- **W2.3** — `src/index.ts`: registrar `agentLinkRoutes` bajo `/agents`; verificar cero colisión.

### Wave 3 (Final — tests + verificación)
- **W3.1** — `agent-link.test.ts` + `agent-links.test.ts` (ver §11).
- **W3.2** — `tsc --noEmit` + `biome check` + suite completa + money-path concurrency verde.

| Tarea | Depende de | Razón |
|-------|-----------|-------|
| W1.x | W0 | tipos + RPC deben existir |
| W2.x | W0, W1 | redeem usa mint/service/RPC |
| W3.x | W0-W2 | tests sobre todo lo anterior |

---

## 11. Test Plan (≥1 por AC + money-path)

| Test | AC / riesgo que cubre | Wave | Framework |
|------|----------------------|------|-----------|
| mint feliz: 201 + token una vez + solo hash en DB | AC-1, CD-1 | W1 | vitest |
| mint rechaza session token (403 SESSION_NOT_ALLOWED) | CD-6, DT-6 | W1 | vitest |
| mint rechaza `maxPriceUsdc<=0` / ttl inválido (400) | AC-1 | W1 | vitest |
| mint rechaza slug `links` (400) | DT-7, RIESGO-5 | W1 | vitest |
| redeem feliz: precio ≤ cap → invoca + debita owner + 200 + link `redeemed` | AC-2, AC-6 | W2 | vitest |
| redeem precio > cap (pre-claim) → 409 PRICE_EXCEEDS, link sigue `open`, cero débito | AC-3, CD-3 | W2 | vitest |
| redeem precio drift > cap (post-claim, `__quoteStale`) → reopen `open`, cero débito | AC-3, RIESGO-3 | W2 | vitest |
| redeem token inexistente → 404 | AC-4 | W2 | vitest |
| redeem token expirado → 410 | AC-4 | W2 | vitest |
| redeem token ya usado → 409 LINK_ALREADY_USED | AC-4, CD-4 | W2 | vitest |
| **doble-redeem concurrente** (2 requests, mismo token) → exactamente 1 invoca+cobra, el otro 409; cero doble-cobro | AC-2/CD-4, RIESGO-2 | W3 | vitest (patrón `money-path.concurrency.test.ts`) |
| redeem cross-owner: link de owner A, key de owner B nunca se debita (owner guard en settle RPC) | AC-6, RIESGO-6 | W2/W3 | vitest |
| execute throw → link `failed` terminal, NO reopen, NO doble-cobro en retry | CD-8, RIESGO-3 | W2 | vitest |
| RLS: `a2a_agent_links` deny-by-default | RIESGO-6 | W3 | `verify-rls-enabled.test.ts` |
| AC-5: no existe endpoint de mutación (mint-once) | AC-5, CD-7 | W2 | vitest (assert 404/405 en PATCH) |

---

## 12. Readiness Check

```
[x] Cada AC tiene ≥1 archivo asociado en 4.1 (AC-1..7 → migración/service/route/tests)
[x] Cada archivo en 4.1 tiene Exemplar verificado con Read/Glob (rutas reales confirmadas)
[x] No hay [NEEDS CLARIFICATION] pendientes (los del work-item son de HUs diferidas, no de esta)
[x] Constraint Directives incluyen ≥3 PROHIBIDO (CD-1..13)
[x] Context Map tiene ≥2 archivos leídos (11 archivos + 1 auto-blindaje)
[x] Scope IN y OUT explícitos y no ambiguos
[x] BD: `a2a_agent_links` nueva (verificado que NO existe); `a2a_agent_keys`/`a2a_payment_intents` existen
[x] Happy Path completo (§4.4)
[x] Flujo de error definido (§4.5, 7 casos)
[x] Money-path: single-use atómico, price-cap server-side, Ownership Guard, RLS, idempotencia status-gated — todos especificados con exemplar
```

**SDD LISTO para SPEC_APPROVED.** Un único punto que el humano debe *ratificar*
(no bloquea, ya resuelto por seguridad): **DT-6/CD-6** — v1 no permite mint desde
session key (se difiere por el cap-bypass). Si el humano quiere session-minting en
v1, se reabre como Missing Input (requiere persistir `keySessionContext` + dual-ledger
billing en redeem).

---

*SDD generado por nexus-architect (F2) — FULL / money-path QUALITY.*
