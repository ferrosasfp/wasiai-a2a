# Story File — #139: [WKH-137 v1] Invocation Links (mint + redeem)

> SDD: doc/sdd/139-wkh-137-im-qr-payments/sdd.md
> Fecha: 2026-07-04
> Branch: feat/139-wkh-137-invocation-links
> SDD_MODE: full / money-path QUALITY

> **Dev: leé SOLO este archivo. No releas el SDD.** Si algo falta o un símbolo no
> existe → PARÁ y escalá a Architect (ver Escalation Rule). Los símbolos marcados
> `[VERIFY-AT-IMPL]` DEBEN confirmarse con Grep/Read antes de usarlos; si difieren
> de lo descrito, escalá.

---

## Goal

Construir una primitiva nueva: un **invocation link** — token opaco, single-use,
price-capped, atado a un agente-target + al `owner_ref`/key del minter. Un caller
autenticado con **Agent Key master** lo mintea (`POST /agents/:slug/link`); cualquier
canal externo lo redime (`POST /agents/links/:token/redeem`) con un input, y el
gateway invoca al agente **bajo la key/owner del link**, capeado a `maxPriceUsdc`,
marcando el token consumido de forma **atómica** (cero doble-redeem / doble-cobro).
El redeem **reusa** el money-path existente (`executeApprovedPlan`) — NO reinventa
settle/fee/receipt/refund. La única pieza nueva de dinero es el status-gate atómico
del single-use.

Todo es **aditivo**: tabla nueva + 2 RPC + 1 service + 2 endpoints + tipos + tests.
NADA de `compose.ts`/`orchestrate.ts`/`agent-price.ts` se modifica (solo se LLAMAN).

## Acceptance Criteria (EARS) — copiados del SDD aprobado

- **AC-1** — WHEN un caller con **Agent Key master** invoca `POST /agents/:slug/link`
  con `{maxPriceUsdc, ttlSeconds?}`, THE system SHALL mintear un token opaco (persiste
  SOLO `SHA-256(token)`) atado a `{slug, owner_ref del caller, key_id, chain_id,
  maxPriceUsdc, expiresAt}` y SHALL retornarlo **una única vez** en el 201.
- **AC-2** — WHEN `POST /agents/links/:token/redeem` recibe un token válido/no-expirado/
  no-usado, THE system SHALL resolver el precio vía `resolveAgentPriceUsdc`, y SI
  `currentPriceUsdc <= maxPriceUsdc` ENTONCES SHALL invocar por el execute existente
  **bajo el owner/key del link**, y SHALL marcar el token consumido **atómicamente**.
- **AC-3** — IF el redeem resuelve `currentPriceUsdc > maxPriceUsdc`, THEN → `409
  PRICE_EXCEEDS_LINK_CAP` SIN debitar, SIN invocar y **SIN consumir** el token.
- **AC-4** — IF token inexistente/expirado/usado → `404 LINK_NOT_FOUND` / `410
  LINK_EXPIRED` / `409 LINK_ALREADY_USED`, sin debit ni invocación.
- **AC-5** — WHILE un link no fue redimido ni expiró, THE system SHALL NO exponer
  endpoint que modifique `slug`/`owner_ref`/`maxPriceUsdc` (mint-once, sin PATCH).
- **AC-6** — WHEN un redeem exitoso debita al owner, THE system SHALL aplicar las
  mismas invariantes que el execute de hoy (protocol fee, receipt, Ownership Guard).
- **AC-7** — WHERE el token es consumido por un canal externo, su exposición SHALL NO
  otorgar más que "ejecutar este agente una vez hasta este price-cap".

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `supabase/migrations/20260706000000_wkh137_agent_links.sql` | Crear | Tabla `a2a_agent_links` + índices + RLS deny-by-default + trigger `updated_at` + RPC `claim_agent_link` + `settle_agent_link` (hardening completo) | `supabase/migrations/20260704000000_wkh135_payment_intents.sql` |
| 2 | `supabase/migrations/20260706000000_wkh137_agent_links_down.sql` | Crear | DROP de los 2 RPC (firmas exactas) + DROP TABLE, envuelto en `BEGIN;…COMMIT;` | `supabase/migrations/20260704000000_wkh135_payment_intents_down.sql` |
| 3 | `src/types/index.ts` | Modificar | Agregar `AgentLinkRow`, `CreateAgentLinkInput`, `MintAgentLinkResponse`, `AgentLinkClaim` | tipos de key-session en el mismo archivo |
| 4 | `src/types/database.types.ts` | Modificar | Agregar `a2a_agent_links` Row/Insert/Update + Functions `claim_agent_link`/`settle_agent_link` | entradas `a2a_payment_intents` / `debit_session_and_parent` |
| 5 | `src/services/agent-link.ts` | Crear | `mint()`, `lookupByTokenHash()`, `getKeyById()`, `redeem()` + error classes | `src/services/key-session.ts` |
| 6 | `src/routes/agent-links.ts` | Crear | `POST /agents/:slug/link` (mint, free auth) + `POST /agents/links/:token/redeem` (público, billing interno) | `src/routes/auth/key-session.ts` (POST) + `src/routes/orchestrate.ts` (`/execute`) |
| 7 | `src/index.ts` | Modificar | `await fastify.register(agentLinkRoutes, { prefix: '/agents' })` junto a las otras rutas `/agents` | `src/index.ts` L151-155 |
| 8 | `src/services/agent-link.test.ts` | Crear | Tests unit del service (mint/redeem/errores/concurrencia/ownership) | `src/services/money-path.concurrency.test.ts`, `payment-intent.test.ts` |
| 9 | `src/routes/agent-links.test.ts` | Crear | Tests de ruta (auth mint, público redeem, mapeo HTTP, reject session/link prefix, slug `links`) | `src/routes/orchestrate.test.ts` |
| 10 | `test/verify-rls-enabled.test.ts` (o test SQL-estructural nuevo) | Modificar/Crear | Verificar `ENABLE ROW LEVEL SECURITY` sobre `a2a_agent_links` en la migración `.sql` | `test/verify-rls-enabled.test.ts` (bloque "SQL estructural — up migration") |

> **Ninguna modificación a `src/services/compose.ts`, `src/services/orchestrate.ts`,
> `src/services/agent-price.ts`** — solo se importan/llaman.

---

## Contrato de Integración ⚠️ BLOQUEANTE

Esta HU tiene comunicación entre componentes: canal externo → gateway, y route → `executeApprovedPlan`.

### A) Canal externo → `POST /agents/:slug/link` (MINT)

**Auth:** header `x-a2a-key` (o `Authorization: Bearer wasi_a2a_*`) con **Agent Key master**.
Resolver con `resolveCallerKey(req)`. **Rechazar** tokens de sesión (prefijo
`wasi_a2a_sess_` = `KEY_SESSION_TOKEN_PREFIX`) ANTES de `resolveCallerKey` → 403 (CD-6).

**Request body:**
```json
{
  "maxPriceUsdc": "string decimal > 0 — cap de precio server-side",
  "ttlSeconds": "number entero > 0, opcional (default env, <= LINK_MAX_TTL_SECONDS)"
}
```

**Response 201 (token viaja UNA sola vez):**
```json
{
  "link_id": "uuid",
  "token": "wasi_a2a_link_<96 hex chars> — SOLO acá, nunca más recuperable",
  "slug": "string",
  "max_price_usdc": "string",
  "expires_at": "ISO-8601"
}
```

**Errores mint:**
| HTTP | error_code | Cuándo |
|---|---|---|
| 403 | `SESSION_NOT_ALLOWED` | authenticator es token de sesión (`wasi_a2a_sess_`) — CD-6 |
| 403 | `Invalid or inactive API key` | `resolveCallerKey` null / `!is_active` |
| 400 | `INVALID_INPUT` | `maxPriceUsdc` no decimal `>0`, o `ttlSeconds` inválido/fuera de rango |
| 400 | `SLUG_RESERVED` | `slug === 'links'` (DT-7, reserva de router) |
| 500 | `AGENT_LINK_MINT_FAILED` | fallo inesperado del INSERT |

### B) Canal externo → `POST /agents/links/:token/redeem` (REDEEM)

**Auth:** **público** (sin `requirePaymentOrA2AKey`). El redeemer se autentica por
**posesión del token** (path param `:token`). preHandlers: rate-limit + backpressure + timeout.

**Request body:**
```json
{ "input": { "...": "objeto arbitrario que se pasa como input del step único" } }
```

**Response 200 (redeem OK):** shape del `OrchestrateResult` + `kiteTxHash`, igual que
`/orchestrate/execute` (route L450). Campos reales de `OrchestrateResult` (types/index.ts:470):
```json
{
  "kiteTxHash": "string | undefined",
  "orchestrationId": "string",
  "answer": "unknown — respuesta del agente",
  "reasoning": "string",
  "pipeline": "ComposeResult",
  "consideredAgents": "Agent[]",
  "protocolFeeUsdc": "number",
  "feeChargeError": "string?", "feeChargeTxHash": "string?",
  "refundError": "boolean?", "debitFallback": "boolean?",
  "remainingBudgetUsd": "string?"
}
```

**Errores redeem:**
| HTTP | error_code | Cuándo |
|---|---|---|
| 404 | `LINK_NOT_FOUND` | token inexistente (lookup null) o RPC RAISE `LINK_NOT_FOUND` |
| 410 | `LINK_EXPIRED` | `now >= expires_at` (pre-claim o RPC RAISE `LINK_EXPIRED`) |
| 409 | `LINK_ALREADY_USED` | status `!= 'open'` (pre-claim o RPC RAISE — race concurrente) |
| 409 | `PRICE_EXCEEDS_LINK_CAP` | precio `> max_price_usdc` (pre-claim) O `__quoteStale` (post-claim, tras reopen) |
| 404 | `AGENT_NOT_FOUND` | `resolveAgentPriceUsdc` retorna `null` (agente no existe) |
| 502 | `AGENT_LINK_REDEEM_FAILED` | `executeApprovedPlan` throw (débito ambiguo → link `failed` terminal, CD-8) |

### C) `agentLinkService.redeem` → `orchestrateService.executeApprovedPlan`

Firma verificada (`src/services/orchestrate.ts:880`):
```ts
executeApprovedPlan(
  request: OrchestrateRequest & { maxQuotedCostUsdc?: number },
  plan: OrchestratePlanResult,
  orchestrationId: string,
): Promise<OrchestrateResult | { __quoteStale: true; currentCostUsdc: number; maxQuotedCostUsdc: number }>
```
- El **primer argumento NO es la Fastify request** — es un objeto `OrchestrateRequest`
  literal (ver exemplar `/execute` L413-428). Se construye con:
  `scopingKeyRow = ownerKey` (habilita el débito step-0: `billsStep0 = scopingKeyRow !== undefined`, service L916),
  `delegationContext = undefined`, `keySessionContext = undefined` (path master → master RPC),
  `chainId = link.chain_id`, `maxQuotedCostUsdc = Number(link.max_price_usdc)`,
  `budget = Number(link.max_price_usdc)` `[VERIFY-AT-IMPL: budget seedea la reserva maxBudget; usar max_price_usdc como headroom]`,
  `goal = ''`.
- `plan.billingKeyRow = ownerKey`. Devuelve `{__quoteStale}` cuando el precio drifteó
  `> cap` post-claim → **cero débito garantizado** por el cap-gate (service L920-934).

---

## Constraint Directives

### OBLIGATORIO
- **CD-OBL-1** — Token opaco: `` `wasi_a2a_link_${crypto.randomBytes(48).toString('hex')}` ``;
  persistir SOLO `crypto.createHash('sha256').update(token).digest('hex')`. Patrón exacto
  de `key-session.ts:186-189`. Definir `const AGENT_LINK_TOKEN_PREFIX = 'wasi_a2a_link_'`.
- **CD-OBL-2** — RPC atómicos `SECURITY DEFINER` con `SELECT ... FOR UPDATE`, guard
  `owner_ref IS DISTINCT FROM p_owner_ref` (en `settle`), status-gate `IF v_status <> 'redeeming' THEN RETURN`,
  `SET search_path = public, pg_temp`, `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`,
  `GRANT EXECUTE ... TO service_role`. Espejo de `close_payment_intent_for_settle` /
  `finalize_payment_intent` (migración wkh135).
- **CD-OBL-3** — Reusar `orchestrateService.executeApprovedPlan` (`src/services/orchestrate.ts`)
  + `resolveAgentPriceUsdc` (`src/services/agent-price.ts`) para settle/precio. NO reimplementar
  débito/fee/receipt/refund.
- **CD-OBL-4** — El cap autoritativo es `maxQuotedCostUsdc` DENTRO de execute (server-side).
  El precio del request/canal NUNCA es fuente de verdad.
- **CD-OBL-5** — TypeScript strict, sin `any`/`as unknown` salvo el narrowing NUMERIC→string
  documentado (patrón `key-session.ts:221`, `max_budget_usd as unknown as number`).

### PROHIBIDO
- **CD-1** — Persistir el token crudo. Solo `SHA-256`.
- **CD-2** — Query de `a2a_agent_links` de mint/list/gestión SIN `owner_ref` (Ownership Guard).
  **Excepción única y documentada**: `lookupByTokenHash` / `claim_agent_link` autenticados por
  posesión del token (NO IDOR — replicá el comentario de `key-session.ts:257-262`).
- **CD-3** — Exceder el price-cap sin rechazo explícito (AC-3). Precio server-side.
- **CD-4** — Reusar un token consumido. Claim + status-gate atómico: N redeems concurrentes → 1 solo invoca.
- **CD-5** — Mover dinero fuera de `executeApprovedPlan`. El link NO debita/settlea/refunda por su cuenta.
- **CD-6** — Permitir mint desde **session token** (`wasi_a2a_sess_`) → 403 `SESSION_NOT_ALLOWED`
  (reject ANTES de `resolveCallerKey`). Rechazar también el prefijo link (`wasi_a2a_link_`).
- **CD-7** — Cualquier endpoint PATCH/PUT sobre un link (mint-once inmutable, AC-5). Solo mint + redeem.
- **CD-8** — Reabrir (`reopen`) un link tras un `throw` de execute (débito ambiguo). Reopen SOLO
  en `__quoteStale` (cero débito garantizado). Throw → `settle_agent_link(..., 'failed', ...)` terminal.
- **CD-9** (Auto-Blindaje WKH-133/134/136) — `x: cond ? v : undefined` en objetos con opcionales
  (`exactOptionalPropertyTypes:true`). Usá `if (v !== undefined) obj.x = v`.
- **CD-10** (Auto-Blindaje WKH-136) — En mocks de supabase thenable, `biome-ignore
  lint/suspicious/noThenProperty` **por línea**, nunca a nivel archivo.
- **CD-11** (Auto-Blindaje WKH-136) — Down migration con `DROP FUNCTION ...(tipos exactos)`.
- **CD-12** — Crear índice explícito sobre `token_hash` (el `UNIQUE` ya da el btree O(1)).
- **CD-13** — Tocar `compose.ts`, `orchestrate.ts` (service), `agent-price.ts` (solo import/lectura).
  NO agregar dependencias nuevas.

---

## Waves

### Wave -1: Environment Gate (verificar ANTES de tocar código)
```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
npm install 2>/dev/null || echo "sin package.json"
# archivos base del Scope IN que se importan
ls src/services/key-session.ts src/routes/auth/parsers.ts src/services/orchestrate.ts \
   src/services/agent-price.ts src/routes/orchestrate.ts \
   supabase/migrations/20260704000000_wkh135_payment_intents.sql 2>/dev/null || echo "FALTA archivo base"
# símbolos reusados existen
grep -q "export async function executeApprovedPlan" src/services/orchestrate.ts && echo "executeApprovedPlan OK"
grep -q "export async function resolveAgentPriceUsdc" src/services/agent-price.ts && echo "resolveAgentPriceUsdc OK"
grep -q "KEY_SESSION_TOKEN_PREFIX = 'wasi_a2a_sess_'" src/routes/auth/parsers.ts && echo "prefix OK"
grep -q "resolveCallerKey" src/routes/auth/parsers.ts && echo "resolveCallerKey OK"
# preHandlers del redeem existen (verificar nombres reales)
grep -rn "createBackpressureHandler\|createTimeoutHandler" src/ | head -3
```
**Si algo falla → PARAR y reportar al orquestador.**

### Wave 0 (Serial Gate — contratos/tipos/DB; completar antes de todo)

- [ ] **W0.1** — Migración `20260706000000_wkh137_agent_links.sql` (Archivo #1). Estructura:

  **Tabla `a2a_agent_links`:**
  | Columna | Tipo |
  |---|---|
  | `id` | `UUID PRIMARY KEY DEFAULT gen_random_uuid()` |
  | `token_hash` | `TEXT NOT NULL UNIQUE` (CD-12: NO índice extra) |
  | `owner_ref` | `TEXT NOT NULL` |
  | `key_id` | `UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE` |
  | `slug` | `TEXT NOT NULL` |
  | `registry` | `TEXT` (nullable) |
  | `max_price_usdc` | `NUMERIC(20,8) NOT NULL CHECK (max_price_usdc >= 0)` |
  | `chain_id` | `INT NOT NULL` |
  | `status` | `TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','redeeming','redeemed','failed'))` |
  | `redeemed_at` | `TIMESTAMPTZ` |
  | `settle_tx_hash` | `TEXT` |
  | `consumed_cost_usdc` | `NUMERIC(20,8)` |
  | `expires_at` | `TIMESTAMPTZ NOT NULL` |
  | `error_message` | `TEXT` |
  | `created_at` / `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` |

  Índices: `idx_a2a_agent_links_key_owner (key_id, owner_ref)`, `idx_a2a_agent_links_owner (owner_ref)`,
  `idx_a2a_agent_links_status (status)`.
  RLS: `ALTER TABLE a2a_agent_links ENABLE ROW LEVEL SECURITY;` (deny-by-default, SIN policy permisiva).
  Trigger: `set_a2a_agent_links_updated_at BEFORE UPDATE ... EXECUTE FUNCTION trigger_set_updated_at();`
  (mismo patrón que wkh135 L76-79).

  **RPC 1 — `claim_agent_link(p_token_hash TEXT)`** RETURNS `TABLE(id UUID, owner_ref TEXT,
  key_id UUID, slug TEXT, registry TEXT, max_price_usdc NUMERIC, chain_id INT)`:
  - `SELECT ... FROM a2a_agent_links WHERE token_hash = p_token_hash FOR UPDATE;`
  - `NOT FOUND` → `RAISE EXCEPTION 'LINK_NOT_FOUND: %', p_token_hash;`
  - `status = 'open' AND NOW() >= expires_at` → `RAISE EXCEPTION 'LINK_EXPIRED';`
  - `status IN ('redeeming','redeemed','failed')` → `RAISE EXCEPTION 'LINK_ALREADY_USED';`
    (el 2º redeem concurrente pierde el lock-race → cae acá)
  - `status = 'open'` (no expirado) → `UPDATE a2a_agent_links SET status='redeeming' WHERE id=v_id;`
    y `RETURN NEXT` con las columnas del link.
  - Hardening completo (CD-OBL-2).

  **RPC 2 — `settle_agent_link(p_id UUID, p_owner_ref TEXT, p_outcome TEXT, p_tx_hash TEXT,
  p_cost NUMERIC, p_error TEXT)`** RETURNS `void`:
  - `SELECT owner_ref, status ... WHERE id = p_id FOR UPDATE;` `NOT FOUND` → RAISE;
    `owner_ref IS DISTINCT FROM p_owner_ref` → `RAISE EXCEPTION 'OWNERSHIP_MISMATCH';`
  - `IF v_status <> 'redeeming' THEN RETURN;` (idempotencia exactly-once)
  - `p_outcome = 'redeemed'` → `status='redeemed', redeemed_at=now(), settle_tx_hash=p_tx_hash, consumed_cost_usdc=p_cost`
  - `p_outcome = 'reopen'` → `status='open'` (SOLO tras `__quoteStale`, cero débito)
  - `else` (`'failed'`) → `status='failed', error_message=p_error` (terminal, NO reabrir — CD-8)
  - Hardening completo (CD-OBL-2).

- [ ] **W0.2** — Migración down `20260706000000_wkh137_agent_links_down.sql` (Archivo #2):
  ```sql
  BEGIN;
  DROP FUNCTION IF EXISTS settle_agent_link(uuid, text, text, text, numeric, text);
  DROP FUNCTION IF EXISTS claim_agent_link(text);
  DROP TABLE IF EXISTS a2a_agent_links;
  COMMIT;
  ```

- [ ] **W0.3** — Tipos (Archivos #3 y #4):
  - `src/types/index.ts`: `AgentLinkRow` (columnas de la tabla; NUMERIC como `string`),
    `CreateAgentLinkInput { maxPriceUsdc: string; ttlSeconds?: number }`,
    `MintAgentLinkResponse { link_id, token, slug, max_price_usdc, expires_at }`,
    `AgentLinkClaim { id, owner_ref, key_id, slug, registry, max_price_usdc, chain_id }`.
  - `src/types/database.types.ts`: entrada `a2a_agent_links` (Row/Insert/Update) + Functions
    `claim_agent_link` / `settle_agent_link`. `[VERIFY-AT-IMPL: seguir el shape generado de
    a2a_payment_intents / debit_session_and_parent en el mismo archivo]`.

- [ ] **Verificación W0**: `npx tsc --noEmit` verde + `node scripts/migrate-preflight.mjs`
  `[VERIFY-AT-IMPL: confirmar el nombre exacto del script de preflight]` sobre Postgres efímero.

### Wave 1 (Parallelizable — service mint + route mint; dep: W0)

- [ ] **W1.1** — `src/services/agent-link.ts` (Archivo #5), parte mint. Seguir `key-session.ts`:
  - `const AGENT_LINK_TOKEN_PREFIX = 'wasi_a2a_link_'`, `const POSITIVE_DECIMAL_RE = /^\d+(\.\d+)?$/`.
  - `function maxTtlSeconds(): number` leyendo `process.env.LINK_MAX_TTL_SECONDS` con fail-safe
    default 86400 (espejo de `maxTtlSeconds` en key-session L70-73).
  - Error classes: `InvalidAgentLinkInputError { code:'INVALID_INPUT' }`,
    `SlugReservedError { code:'SLUG_RESERVED' }`, `AgentLinkNotFoundError { code:'LINK_NOT_FOUND' }`,
    `AgentLinkExpiredError { code:'LINK_EXPIRED' }`, `AgentLinkAlreadyUsedError { code:'LINK_ALREADY_USED' }`,
    `PriceExceedsLinkCapError { code:'PRICE_EXCEEDS_LINK_CAP' }`, `AgentNotFoundError { code:'AGENT_NOT_FOUND' }`.
    Reusar `OwnershipMismatchError` de `./security/errors.js`.
  - `async mint(minterKey: A2AAgentKeyRow, slug: string, input: CreateAgentLinkInput, chainId: number): Promise<MintAgentLinkResponse>`:
    - `if (slug === 'links') throw new SlugReservedError()` (DT-7).
    - valida `maxPriceUsdc` decimal `>0` y `ttlSeconds` (opcional; si presente entero `>0` y `<= maxTtlSeconds()`;
      si ausente usar un default, p.ej. `maxTtlSeconds()`) → `InvalidAgentLinkInputError`.
    - `expiresAt = new Date(Date.now() + ttl*1000).toISOString()`.
    - token + hash (CD-OBL-1). INSERT con `owner_ref = minterKey.owner_ref`, `key_id = minterKey.id`,
      `chain_id = chainId`, `slug` del path (NUNCA del request). `.select('id').single()`.
    - devuelve `{ link_id, token, slug, max_price_usdc: input.maxPriceUsdc, expires_at: expiresAtIso }`.
  - `async lookupByTokenHash(hash): Promise<AgentLinkRow | null>` — SELECT `*` by `token_hash`,
    `.single()`, PGRST116 → null. **Única fn sin owner-gate** — copiar el comentario NO-IDOR de key-session L257-262.
  - `async getKeyById(keyId): Promise<A2AAgentKeyRow | null>` — SELECT `*` de `a2a_agent_keys` by `id`,
    `asAgentKeyRow`, PGRST116 → null (patrón `getParentKey` key-session L283-296). Server-side, sin owner-gate
    (el keyId sale del link, no del request).

- [ ] **W1.2** — `src/routes/agent-links.ts` (Archivo #6), handler mint `POST /:slug/link`
  (queda bajo prefix `/agents` → path final `/agents/:slug/link`). Seguir `auth/key-session.ts` POST:
  - `const rawKey = rawKeyFromRequest(req); if (rawKey?.startsWith(KEY_SESSION_TOKEN_PREFIX)) return reply.status(403).send({ error_code: 'SESSION_NOT_ALLOWED' })`
    (import `KEY_SESSION_TOKEN_PREFIX`, `rawKeyFromRequest`, `resolveCallerKey` de `./auth/parsers.js`).
    Rechazar también `rawKey?.startsWith(AGENT_LINK_TOKEN_PREFIX)` → 403.
  - `const callerKey = await resolveCallerKey(req); if (!callerKey?.is_active) return reply.status(403)...`.
  - parsear body `{ maxPriceUsdc, ttlSeconds? }` (shape); `chainId = req.resolvedChainId`
    `[VERIFY-AT-IMPL: resolvedChainId lo setea la middleware post-auth (a2a-key.ts:341); en el mint free
    con resolveCallerKey confirmá que resolvedChainId está disponible — si NO, resolver el chainId por
    default vía getAdaptersBundle().chainConfig.chainId como en key-session.ts:119]`.
  - `try { const result = await agentLinkService.mint(callerKey, req.params.slug, input, chainId); return reply.status(201).send(result) } catch` → mapear
    `InvalidAgentLinkInputError`→400 INVALID_INPUT, `SlugReservedError`→400 SLUG_RESERVED, else→500 AGENT_LINK_MINT_FAILED.

### Wave 2 (Depende de W0+W1 — redeem)

- [ ] **W2.1** — `agentLinkService.redeem(token: string, redeemInput: Record<string, unknown>): Promise<OrchestrateResult>`
  (Archivo #5, parte redeem). Orquestar (seguir `/orchestrate/execute` L345-450 para la construcción del plan):
  1. `hash = createHash('sha256').update(token).digest('hex')`; `link = await lookupByTokenHash(hash)`.
     - `link === null` → `throw new AgentLinkNotFoundError()`.
     - `link.status !== 'open'` → `throw new AgentLinkAlreadyUsedError()`.
     - `Date.now() >= new Date(link.expires_at).getTime()` → `throw new AgentLinkExpiredError()`.
  2. `price = await resolveAgentPriceUsdc(link.slug, link.registry ?? undefined, true)` (forceRefresh).
     - `price === null` → `throw new AgentNotFoundError()`.
     - `price > Number(link.max_price_usdc)` → `throw new PriceExceedsLinkCapError()` (pre-claim, cero DB write, AC-3).
  3. `claim = await supabase.rpc('claim_agent_link', { p_token_hash: hash })` → mapear errores por prefijo
     de mensaje (patrón `key-session.ts:475-517`): `LINK_NOT_FOUND`→`AgentLinkNotFoundError`,
     `LINK_EXPIRED`→`AgentLinkExpiredError`, `LINK_ALREADY_USED`→`AgentLinkAlreadyUsedError`. Extraer el row del link.
  4. `ownerKey = await getKeyById(claim.key_id)` `[VERIFY-AT-IMPL: si null → tratar como AGENT_LINK_REDEEM_FAILED
     y settle 'failed']`.
  5. Construir `plan: OrchestratePlanResult` de **1 step** (todos los campos de la interfaz, ver exemplar):
     `steps = [{ agent: claim.slug, input: redeemInput, ...(claim.registry ? { registry: claim.registry } : {}) }]`
     (CD-9: no poner `registry: undefined`); `costPerStep = [price]`; `totalCostUsdc = price`;
     `protocolFeeUsdc = Number((price * getProtocolFeeRate()).toFixed(6))` `[VERIFY-AT-IMPL: getProtocolFeeRate
     import path — mismo que orchestrate route]`; `maxQuotedCostUsdc = Number(claim.max_price_usdc)`;
     `plannedCostUsd = price`; `feeUsdc = protocolFeeUsdc`; `usedFallback = false`; `debitFallback = false`;
     `billingKeyRow = ownerKey`; `discoveredAgents = []`; `consideredAgents = []`; `reasoning = 'redeem: single-step plan'`;
     `planStatus = 'ready'`; `orchestrationId = crypto.randomUUID()`.
  6. `result = await orchestrateService.executeApprovedPlan({ goal:'', budget: Number(claim.max_price_usdc),
     scopingKeyRow: ownerKey, delegationContext: undefined, keySessionContext: undefined,
     chainId: claim.chain_id, maxQuotedCostUsdc: Number(claim.max_price_usdc) }, plan, plan.orchestrationId)`.
  7. Outcome:
     - `'__quoteStale' in result` → `settle_agent_link(claim.id, claim.owner_ref, 'reopen', null, null, null)` →
       `throw new PriceExceedsLinkCapError()` (post-claim, cero débito garantizado).
     - normal → `settle_agent_link(claim.id, claim.owner_ref, 'redeemed', <txHash>, <cost>, null)` →
       `return result`. `[VERIFY-AT-IMPL: de dónde sale el settle_tx_hash — result.feeChargeTxHash o el tx del
       pipeline; si no hay, pasar null. cost = result.pipeline totalCostUsdc o price]`.
  8. `executeApprovedPlan` **throw** (catch) → `settle_agent_link(claim.id, claim.owner_ref, 'failed', null, null, <msg>)`
     terminal (CD-8, NO reopen) → re-throw como fallo → route mapea 502.

- [ ] **W2.2** — `src/routes/agent-links.ts`, handler redeem `POST /links/:token/redeem` (público). preHandlers:
  rate-limit + `createBackpressureHandler()` + `createTimeoutHandler(...)` `[VERIFY-AT-IMPL: imports exactos
  y firma, tal como los usa orchestrate.ts L322-335 — SIN requirePaymentOrA2AKey]`. Handler:
  - parsear `{ input }` del body (objeto). `try { const result = await agentLinkService.redeem(req.params.token, input); return reply.status(200).send({ kiteTxHash: req.paymentTxHash, ...result }) } catch`:
    map `AgentLinkNotFoundError`→404 LINK_NOT_FOUND, `AgentLinkExpiredError`→410 LINK_EXPIRED,
    `AgentLinkAlreadyUsedError`→409 LINK_ALREADY_USED, `PriceExceedsLinkCapError`→409 PRICE_EXCEEDS_LINK_CAP,
    `AgentNotFoundError`→404 AGENT_NOT_FOUND, else→502 AGENT_LINK_REDEEM_FAILED (log `errorClass`, nunca msg crudo).

- [ ] **W2.3** — `src/index.ts` (Archivo #7): `await fastify.register(agentLinkRoutes, { prefix: '/agents' });`
  junto a las otras rutas `/agents` (L151-155). DT-7: la ruta estática `POST /links/:token/redeem` tiene
  precedencia Fastify sobre `POST /:slug/link`; la reserva de slug `links` en el mint (W1.1) cierra el gap.

### Wave 3 (Final — tests + verificación; ver Test Expectations)

- [ ] **W3.1** — Archivos #8, #9, #10 (ver tabla Test Expectations).
- [ ] **W3.2** — `npx tsc --noEmit` + `npx biome check` (o el comando lint del repo) + suite completa verde,
  con foco en los tests money-path / concurrencia.

### Verificación Incremental
| Wave | Verificación |
|------|--------------|
| W0 | `tsc --noEmit` + migrate-preflight verde |
| W1 | `tsc --noEmit` + tests mint verdes |
| W2 | `tsc --noEmit` + tests redeem/concurrencia verdes |
| W3 | full QA + biome + suite money-path verde |

---

## Test Expectations (15 tests)

| # | Test | ACs / riesgo | Archivo | Framework/Tipo |
|---|------|-------------|---------|----------------|
| 1 | mint feliz: 201 + token una vez + solo `token_hash` en DB (nunca el crudo) | AC-1, CD-1 | agent-link.test.ts | vitest / unit |
| 2 | mint rechaza session token (403 `SESSION_NOT_ALLOWED`) | CD-6, DT-6 | agent-links.test.ts | vitest / route |
| 3 | mint rechaza `maxPriceUsdc<=0` / ttl inválido (400 `INVALID_INPUT`) | AC-1 | agent-link.test.ts | vitest / unit |
| 4 | mint rechaza slug `links` (400 `SLUG_RESERVED`) | DT-7, RIESGO-5 | agent-link.test.ts | vitest / unit |
| 5 | redeem feliz: precio ≤ cap → invoca + debita owner + 200 + link `redeemed` | AC-2, AC-6 | agent-link.test.ts | vitest / unit |
| 6 | redeem precio > cap (pre-claim) → 409 `PRICE_EXCEEDS_LINK_CAP`, link sigue `open`, cero débito | AC-3, CD-3 | agent-link.test.ts | vitest / unit |
| 7 | redeem precio drift > cap (post-claim, `__quoteStale`) → reopen `open`, cero débito | AC-3, RIESGO-3 | agent-link.test.ts | vitest / unit |
| 8 | redeem token inexistente → 404 `LINK_NOT_FOUND` | AC-4 | agent-links.test.ts | vitest / route |
| 9 | redeem token expirado → 410 `LINK_EXPIRED` | AC-4 | agent-link.test.ts | vitest / unit |
| 10 | redeem token ya usado → 409 `LINK_ALREADY_USED` | AC-4, CD-4 | agent-link.test.ts | vitest / unit |
| 11 | **doble-redeem concurrente** (2 requests, mismo token) → exactamente 1 invoca+cobra, el otro 409; cero doble-cobro | AC-2/CD-4, RIESGO-2 | agent-link.test.ts | vitest (patrón `money-path.concurrency.test.ts`) |
| 12 | redeem cross-owner: link de owner A, key de owner B nunca se debita (owner guard en `settle_agent_link` RPC → `OWNERSHIP_MISMATCH`) | AC-6, RIESGO-6 | agent-link.test.ts | vitest / unit |
| 13 | execute throw → link `failed` terminal, NO reopen, NO doble-cobro en retry | CD-8, RIESGO-3 | agent-link.test.ts | vitest / unit |
| 14 | RLS: `a2a_agent_links` con `ENABLE ROW LEVEL SECURITY` en la migración (deny-by-default) | RIESGO-6 | verify-rls-enabled.test.ts | vitest / SQL-estructural |
| 15 | AC-5: no existe endpoint de mutación (PATCH/PUT sobre link → 404/405) | AC-5, CD-7 | agent-links.test.ts | vitest / route |

**Criterio Test-First**: Sí (lógica de negocio money-path + APIs). Escribí el test antes del código en W1/W2.

**Nota test 14**: el `verify-rls-enabled.test.ts` actual valida un set canónico de 10 tablas vía
`RLS_TABLES` (en `scripts/verify-rls-enabled.mjs`). NO agregues `a2a_agent_links` a ese set canónico
(ripplea el conteo `toHaveLength(10)` y no está en scope). En su lugar, agregá un bloque SQL-estructural
que lea la migración `20260706000000_wkh137_agent_links.sql` con `readFileSync` y asserte
`ENABLE ROW LEVEL SECURITY` + `CHECK (status IN (...))` (patrón del bloque "SQL estructural — up migration",
verify-rls-enabled.test.ts:111-139). `[VERIFY-AT-IMPL: confirmá si el repo prefiere un archivo de test nuevo
`agent-links.migration.test.ts` en vez de tocar verify-rls-enabled.test.ts]`.

---

## Anti-Hallucination Checklist (verificado con Read/Grep durante F2.5)

- [x] `orchestrateService.executeApprovedPlan` existe — `src/services/orchestrate.ts:880`, firma confirmada
      (arg1 = `OrchestrateRequest & {maxQuotedCostUsdc?}` objeto literal, NO Fastify request; retorna
      `OrchestrateResult | {__quoteStale,...}`).
- [x] `resolveAgentPriceUsdc(agentSlug, registryName?, forceRefresh=false)` — `src/services/agent-price.ts:44`,
      retorna `Promise<number | null>`.
- [x] `resolveCallerKey` / `rawKeyFromRequest` / `KEY_SESSION_TOKEN_PREFIX = 'wasi_a2a_sess_'` — `src/routes/auth/parsers.ts:99,135,260`.
- [x] Patrón token opaco `crypto.randomBytes(48).toString('hex')` + `createHash('sha256')` + `POSITIVE_DECIMAL_RE`
      + `maxTtlSeconds()` fail-safe — `src/services/key-session.ts:47,70,186-189`.
- [x] `lookupByTokenHash` NO-IDOR + `getParentKey` (SELECT `*` by id, `asAgentKeyRow`) — `key-session.ts:263,283`.
- [x] Ownership Guard `owner_ref IS DISTINCT FROM` + `FOR UPDATE` + status-gate `IF v_status <> ... RETURN`
      + hardening (`SET search_path`/`REVOKE`/`GRANT`) — `20260704000000_wkh135_payment_intents.sql` (RPC 3/5).
- [x] Down migration `DROP FUNCTION ...(tipos exactos)` en `BEGIN;…COMMIT;` — `…_payment_intents_down.sql`.
- [x] Decorators `request.a2aKeyRow` / `request.resolvedChainId` / `request.paymentTxHash` — `src/middleware/a2a-key.ts:63,67,341` + orchestrate route L441.
- [x] Registro de rutas `/agents` (varios plugins por prefijo) — `src/index.ts:151-155`.
- [x] `OrchestrateResult` / `OrchestratePlanResult` / `ComposeStep` shapes — `src/types/index.ts:470,499,282`.
- [x] RLS structural test pattern (`readFileSync` + `ENABLE ROW LEVEL SECURITY`) — `test/verify-rls-enabled.test.ts:111`.
- [ ] `[VERIFY-AT-IMPL]` restantes (el Dev DEBE confirmar antes de usar): nombre del script `migrate-preflight`;
      disponibilidad de `resolvedChainId` en el mint free (fallback `getAdaptersBundle().chainConfig.chainId`);
      import de `getProtocolFeeRate`; imports/firmas exactas de `createBackpressureHandler`/`createTimeoutHandler`
      y el rate-limit; origen del `settle_tx_hash`/`cost` en el settle OK; database.types shape generado.

---

## Out of Scope (Dev NO toca)

- `src/services/compose.ts`, `src/services/orchestrate.ts`, `src/services/agent-price.ts` (solo import/lectura).
- Bot Telegram/WhatsApp, QR/imagen, página de redeem, seller sin HTTP, onboarding desde cero.
- Mint desde session key (diferido, CD-6/DT-6). Metered/subscription (`session`/`upto`, WKH-135).
- List/revoke de links (no es AC de esta HU; aditivo futuro con Ownership Guard).
- NO agregar dependencias nuevas. NO "mejorar" código adyacente. NO endpoints PATCH/PUT (CD-7).

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala a Architect.** No inventar, no asumir.
- Un símbolo `[VERIFY-AT-IMPL]` no matchea con el codebase real.
- Un exemplar citado ya no existe / cambió de firma.
- La tabla/columnas de BD difieren de lo esperado.
- El redeem necesitaría tocar `executeApprovedPlan` (señal de que el reuso no encaja → escalar, NO reimplementar).

---

*Story File generado por nexus-architect — F2.5 / money-path QUALITY.*
