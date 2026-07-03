# Story File — [WKH-134] Publish self-serve de 1 agente (endpoint + flujo servidor)

> **Contrato ejecutable para el Dev (F3). Autosuficiente: seguí las waves en orden.**
> NO necesitás releer el SDD; todo lo accionable está acá. Si algo choca con el
> código real, **PARÁ y avisá al orquestador** (no inventes ni redisñes).
>
> - HU: WKH-134 · Modo: **QUALITY** (endpoint público con input URL-shaped → SSRF + ownership + AR obligatorio)
> - Branch sugerido: `feat/133-wkh-134-agent-selfserve-publish`
> - SDD fuente (NO hace falta releer): `doc/sdd/135-wkh-134-agent-selfserve-publish/sdd.md`

---

## 0. Contexto mínimo (leé esto y arrancá)

**Qué se construye:** un flujo self-serve para que un dev individual publique **1 agente**
(URL + Agent Card mínima) y quede descubrible en `/discover` — sin tener que operar un
`discoveryEndpoint`/`invokeEndpoint` propio (hoy `POST /registries` obliga a "ser un
marketplace entero"). Es **aditivo**: `/registries` sigue igual.

**Decisiones ya tomadas (NO reabrir):**
1. **Endpoint** → `POST /agents` (publicar), `PATCH /agents/:slug` (actualizar),
   `DELETE /agents/:slug` (despublicar), `GET /agents` (listar los míos). Se monta un
   plugin nuevo `agentsRoutes` en el **mismo prefijo `/agents`** que ya usa
   `agentCardRoutes` (Fastify soporta varios plugins por prefijo). No colisiona con
   `GET /agents/:slug/agent-card` (método+path distinto).
2. **Modelo de datos** → tabla **nueva** `a2a_agents` (NO reusar `registries`). La
   discovery **mergea** estos agentes con un **SELECT** (sin fetch outbound, sin self-fetch)
   y los pasa por el **mismo pipeline** que los agentes de marketplace.
3. **Payload mínimo** → `name`, `agentUrl`, `capabilities[≥1]` (req) + `description`,
   `priceUsdc`, `inputSchema`, `outputSchema`, `discoverable` (opt). El gateway ensambla
   el Agent Card A2A de salida — NO se pide un Agent Card completo de entrada.
4. **Auth/monetización** → publish es **GRATIS con `x-a2a-key`** (mismo wrapper
   `requirePaymentOrA2AKey` que registries; sin fee/budget). Anti-spam = auth + owner_ref + SSRF.

**Regla de oro:** reusá 3 piezas ya endurecidas, NO reinventes:
- SSRF: `validateRegistryUrl` (`src/lib/url-validator.ts:335`).
- Ownership/anti-IDOR: `OwnershipMismatchError` + `logOwnershipMismatch` (`src/services/security/errors.ts`).
- Auth: `requirePaymentOrA2AKey` (`src/middleware/a2a-key.ts:1010`).
El nuevo service `agent.ts` es un **clon estructural** de `registry.ts`; el nuevo route
`agents.ts` es un **clon estructural** de `registries.ts`.

**Superficie tocada (Scope IN — lista exhaustiva):**

| Wave | Archivo | Nuevo/Mod | Qué hace |
|------|---------|-----------|----------|
| W0 | `supabase/migrations/20260703000000_wkh134_a2a_agents.sql` | NUEVO | CREATE TABLE `a2a_agents` + índices + RLS deny-by-default |
| W0 | `supabase/migrations/20260703000000_wkh134_a2a_agents_down.sql` | NUEVO | DROP reversible |
| W0 | `src/types/database.types.ts` | MOD | bloque `a2a_agents` Row/Insert/Update (espejo `registries` ~L1925) |
| W0 | `src/types/index.ts` | MOD | `PublishAgentInput`, `UpdateAgentInput`, `SELF_PUBLISHED_REGISTRY_ID`, `SELF_PUBLISHED_REGISTRY_NAME` |
| W0 | `src/services/security/errors.ts` | MOD | extender union `OwnershipOp` con `'agentPublishUpdate' \| 'agentPublishDelete'` |
| W1 | `src/services/agent.ts` | NUEVO | `publishedAgentService`: publish / listAsAgents / getBySlugAsAgent / update / delete |
| W2 | `src/routes/agents.ts` | NUEVO | `POST /` `PATCH /:slug` `DELETE /:slug` `GET /` |
| W2 | `src/services/discovery.ts` | MOD | merge local en `discover()` + local-first en `getAgent()` (aditivo, degradable) |
| W2 | `src/routes/agent-card.ts` | MOD | fallback `RegistryConfig` sintético para self-published (DT-5) |
| W2 | `src/index.ts` | MOD | `await fastify.register(agentsRoutes, { prefix: '/agents' })` |
| W3 | `doc/QUICKSTART-PUBLISH.md` | NUEVO | quickstart 2-call `<5 min` (curl signup + publish + verify) |
| W3 | tests (§6) | NUEVO | 14 tests (4 archivos) |

**Fuera de scope (NO tocar):** `wasiai-sdk` (CD-4), `src/routes/registries.ts`,
`src/services/registry.ts`, `src/routes/discover.ts`, `src/lib/url-validator.ts`, el
schema del Agent Card salvo el fallback sintético en `agent-card.ts`, `GET /registries`.

---

## 1. Constraint Directives — checklist inviolable (tenelo a la vista mientras codeás)

| CD | Regla accionable |
|----|------------------|
| **CD-1** (heredada) | TODA URL saliente del payload (`agentUrl`, y cualquier URL derivada) pasa por `validateRegistryUrl` **antes de persistir** — write-time en el route Y defense-in-depth en el service. `PATCH` re-valida `agentUrl` si viene en el body. PROHIBIDO una validación SSRF nueva/paralela/débil. |
| **CD-2** (heredada) | PROHIBIDO persistir/mutar sin `owner_ref` del caller autenticado. Guard duro `if (!request.a2aKeyRow) → 403 A2A_KEY_REQUIRED` antes del service. NO hay path anónimo/x402-only que publique o mute. |
| **CD-3** (heredada) | AR va a verificar citando archivo:línea: (a) `validateRegistryUrl` corre antes del INSERT, (b) toda mutación filtra por `owner_ref`, (c) ningún error filtra la existencia de un slug de otro owner (404 disclosure-safe). Codeá para pasar esto. |
| **CD-4** (heredada) | PROHIBIDO tocar el repo/paquete `wasiai-sdk`. |
| **CD-5** | El **slug** (PK de `a2a_agents`) se deriva **server-side** del `name` (`toLowerCase().replace(/\s+/g,'-')` con guards de whitespace idénticos a `registryService.register`). PROHIBIDO aceptar un `slug` del body — si viene, se ignora. Ref: WKH-131 auto-blindaje#5, WKH-100 colisión de normalización. |
| **CD-6** | El merge de agentes locales en `discover()` es **aditivo** y pasa por el **mismo** pipeline (status/verified/caps/price/rep/sort/limit). CERO rama que altere el shape del `Agent` para self-published (AC-2, mismo shape). |
| **CD-7** | PROHIBIDO `non-null assertion` (`!`) — biome `lint/style/noNonNullAssertion`. Usar guards explícitos (`const x = arr[0]; if (!x) …`). |
| **CD-8** | TS strict: sin `any` explícito. `as unknown as Json` / `as unknown as Row[]` SOLO en el borde Supabase (narrowing JSONB acotado, exactamente como `registry.ts`). |
| **CD-9** | La discovery NUNCA rompe por los locales: si el SELECT de `a2a_agents` falla, `discover()`/`getAgent()` siguen devolviendo los agentes de registries (try/catch degradable, mismo espíritu que `attachReputations`/`attachIdentities`). |
| **CD-10** | El error handler del route devuelve mensaje **estático** al cliente (F-05). El detalle va a `request.log.warn` server-side. NUNCA leak de `err.message` (puede cargar host/SQL/datum SSRF). |

---

## 2. Anti-Hallucination gates (símbolos verificados — usalos tal cual)

Todos verificados con Read/Grep en el codebase actual. **Si un símbolo no está donde dice, PARÁ.**

| Símbolo / path | Verificado en | Firma / detalle a respetar |
|----------------|---------------|----------------------------|
| `validateRegistryUrl(rawUrl: string): Promise<URL>` | `src/lib/url-validator.ts:335` | throw `SSRFViolationError` en violación. Se `await`ea. |
| `SSRFViolationError` | `src/lib/url-validator.ts:58` | props: `field?: string` (mutable), `reason: string` (readonly), `category: SSRFCategory` (readonly). Se le setea `err.field = 'agentUrl'` antes de re-throw (patrón registries.ts:133). |
| `OwnershipMismatchError` | `src/services/security/errors.ts:12` | genérico, `name='OwnershipMismatchError'`. Mapea a **404** disclosure-safe. |
| `logOwnershipMismatch(...)` | `src/services/security/errors.ts:428/439` | 2 formas: posicional `(op, keyId, ownerId)` o **objeto** `{op, resourceId, callerOwnerRef, actualOwnerRef}`. Usá la forma objeto (WKH-63 fix-pack). PII-safe (hashea). |
| `OwnershipOp` (union) | `src/services/security/errors.ts:405` | union extensible; agregá `'agentPublishUpdate' \| 'agentPublishDelete'`. Ya tiene `'registryUpdate'`/`'registryDelete'` como espejo. |
| `requirePaymentOrA2AKey(opts)` | `src/middleware/a2a-key.ts:1010` | devuelve `preHandlerAsyncHookHandler[]`; setea `request.a2aKeyRow` (con `.owner_ref`) cuando hay a2a-key. Usalo como preHandler igual que registries.ts. |
| `request.a2aKeyRow.owner_ref` | seteado en a2a-key.ts:975 | fuente del `ownerRef`. Guard: `if (!request.a2aKeyRow) → 403`. |
| `mapOwnershipError(err, reply)` | `src/routes/registries.ts:35` | helper LOCAL de registries.ts (mapea `OwnershipMismatchError`→404, `SYSTEM_OWNER_REF`→403). **Replicá un equivalente local en `agents.ts`** (NO importés el privado de registries). |
| `registryService.register/update/delete` | `src/services/registry.ts:154/231/329` | plantilla estructural. Colisión: throw `Registry '${id}' already exists` (:190/:204). UPDATE filtra `.eq('owner_ref', ownerRef)` (:297). PGRST116 = no-rows (:302). |
| `discoveryService.discover(query)` | `src/services/discovery.ts:226` | pipeline: getEnabled→queryRegistry(fetch)→blocklist/status/verified/caps/price→`attachReputations`(:386)→sort→limit→`attachIdentities`(:360). Punto de merge: agregar locales ANTES del pipeline común. |
| `discoveryService.getAgent(slug, registryId?)` | `src/services/discovery.ts:526` | itera registries y fetchea. Agregá lookup local primero. |
| `discoveryService.mapAgent(registry, raw)` | `src/services/discovery.ts:485` | mapper registry→`Agent`. Tu `mapRowToAgent` local debe emitir el **mismo shape** `Agent`. |
| `agentCardService.buildAgentCard(agent, registryConfig, baseUrl, ...)` | `src/services/agent-card.ts:88` | usa `registryConfig` solo para `resolveAuthSchemes(registryConfig)` (:62). NO cambiar su firma. |
| `RegistryConfig` (tipo) | importado en `agent-card.ts:9` + `src/types/index.ts` | necesitás construir uno sintético para el fallback (DT-5). `[VERIFY-AT-IMPL]` los campos exactos leyendo el tipo en `src/types/index.ts` antes de armarlo. |
| `GET /agents/:slug/agent-card` route | `src/routes/agent-card.ts:31` | resuelve `getAgent` (:42) → `registries.find(r => r.name === agent.registry)` (:50) → `if (!registryConfig) 404` (:52). Acá va el fallback sintético. |
| `Agent` interface | `src/types/index.ts` | campos OBLIGATORIOS que tu mapper DEBE setear: `id, name, slug, description, capabilities[], priceUsdc, registry, registry_id, invokeUrl, invocationNote, verified, status`. Opcionales: `metadata, payment, identity, computedReputation, reputation`. |
| `POST /auth/agent-signup` | `src/routes/auth/signup.ts:18` | ya existe; body requiere `owner_ref`, devuelve `key_id`. Es la llamada #1 del quickstart. |
| `index.ts` registro plugins | `src/index.ts:142-147` | `registriesRoutes`→`/registries` (:142); `agentCardRoutes`→`/agents` (:147). Agregá `agentsRoutes`→`/agents` cerca del :147. |
| Migración exemplars | `supabase/migrations/20260401000000_kite_registries.sql`, `..._registries_owner_ref.sql`, `20260610000000_wkh_sec02c_rls_registries.sql` (+ `_down.sql`) | patrón: `BEGIN/COMMIT`, `CREATE TABLE IF NOT EXISTS`, `owner_ref TEXT NOT NULL`, `ENABLE ROW LEVEL SECURITY` **sin FORCE, sin policy** (deny-by-default; service_role bypassa por BYPASSRLS). |

**`[VERIFY-AT-IMPL]` marcadores** (leé el símbolo real antes de usarlo — puede haber
detalles que el Story no fija):
- Campos exactos de `RegistryConfig` (para el sintético) → `src/types/index.ts`.
- Firma/opciones exactas de `requirePaymentOrA2AKey` (qué recibe en `opts`) → `src/middleware/a2a-key.ts:1010` (registries.ts pasa `{ description }`).
- Shape exacto que `mapAgent` produce (para clonar el shape en `mapRowToAgent`) → `discovery.ts:485`.
- Firma del `.eq('owner_ref', ...)` + manejo `PGRST116` → `registry.ts:291-310`.
- Bloque `registries` en `database.types.ts` (para espejar snake_case exacto) → ~L1925.

---

## 3. Contrato de los endpoints (`/agents`)

Todos con preHandler `requirePaymentOrA2AKey` + guard `A2A_KEY_REQUIRED`. Errores → mensaje
estático (CD-10), detalle a `request.log.warn`.

### `POST /agents` — publicar (AC-1)
Request body:
```jsonc
{
  "name": "My Weather Agent",         // req, string no vacío → deriva el slug (CD-5)
  "agentUrl": "https://api.foo.com",  // req, string → SSRF-validado, es el invokeUrl real
  "capabilities": ["weather", "geo"], // req, array ≥1 string → se mapean a skills[]
  "description": "…",                 // opt (default "")
  "priceUsdc": 0.02,                  // opt, number ≥0 (default 0)
  "inputSchema": { },                 // opt (WKH-106 discoverable)
  "outputSchema": { },                // opt
  "discoverable": true                // opt (opt-in schemas)
}
```
Responses:
- `201` `{ slug, name, agentUrl, capabilities, priceUsdc, ... }` (slug derivado server-side).
- `400` `{ error, missing: ["name","agentUrl","capabilities"] }` si faltan mínimos (AC-6).
- `422` `{ error: "SSRF_BLOCKED", field: "agentUrl", reason }` si SSRF (AC-3). **NO persiste.**
- `409` (o `400` explícito) `already exists` si el slug ya existe (AC-4, cualquier owner).
- `403` `{ error_code: "A2A_KEY_REQUIRED" }` si no hay a2a-key (CD-2).

### `PATCH /agents/:slug` — actualizar (AC-4)
- Body: subconjunto de campos publicables. Si trae `agentUrl` → **re-valida SSRF** (CD-1).
- Filtra UPDATE por `.eq('owner_ref', ownerRef)` (TOCTOU).
- Cross-owner → `404` disclosure-safe + `logOwnershipMismatch({op:'agentPublishUpdate', ...})`.

### `DELETE /agents/:slug` — despublicar (AC-4)
- Pre-fetch + `.eq('owner_ref', ownerRef)`. Cross-owner → `404` + `logOwnershipMismatch({op:'agentPublishDelete', ...})`.

### `GET /agents` — listar los míos
- Filtra por `owner_ref` del caller. Devuelve la lista propia (NO todos).

> **Nota:** `POST /agents` (colección) y `DELETE/PATCH /agents/:slug` conviven con
> `GET /agents/:slug/agent-card` (otro plugin, mismo prefijo). Método+path distintos → sin colisión.

---

## 4. Waves ejecutables

### W0 — Serial (contratos, tipos, migración). NADA en paralelo. Bloquea W1/W2.

**W0.1 — Migración** `supabase/migrations/20260703000000_wkh134_a2a_agents.sql`
Espejá el patrón de los 3 exemplars. `BEGIN; … COMMIT;`
```sql
CREATE TABLE IF NOT EXISTS public.a2a_agents (
  slug         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  capabilities JSONB NOT NULL,
  agent_url    TEXT NOT NULL,
  price_usdc   NUMERIC NOT NULL DEFAULT 0,
  metadata     JSONB,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  owner_ref    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_a2a_agents_owner_ref ON public.a2a_agents (owner_ref);
CREATE INDEX IF NOT EXISTS idx_a2a_agents_enabled   ON public.a2a_agents (enabled) WHERE enabled;
ALTER TABLE public.a2a_agents ENABLE ROW LEVEL SECURITY; -- deny-by-default, sin FORCE, sin policy (espejo WKH-SEC-02c)
```
`_down.sql`: `BEGIN; DROP TABLE IF EXISTS public.a2a_agents; COMMIT;` (idempotente, reversible).
> La migración NO se aplica en esta fase (requiere runbook `075-wkh-78-migration-preflight`). El Dev entrega el `.sql` idempotente + `_down.sql`.

**W0.2 — `src/types/database.types.ts`**: bloque `a2a_agents` con `Row`/`Insert`/`Update`
espejando `registries` (~L1925), snake_case, `capabilities`/`metadata` como `Json`.

**W0.3 — `src/types/index.ts`**:
- `export interface PublishAgentInput { name; agentUrl; capabilities: string[]; description?; priceUsdc?; inputSchema?; outputSchema?; discoverable? }`
- `export interface UpdateAgentInput { … }` (subconjunto opcional).
- `export const SELF_PUBLISHED_REGISTRY_ID = 'self-published';`
- `export const SELF_PUBLISHED_REGISTRY_NAME = 'self-published';`

**W0.4 — `src/services/security/errors.ts`**: extender `OwnershipOp` (:405) con
`| 'agentPublishUpdate' | 'agentPublishDelete'`.

### W1 — Service layer `src/services/agent.ts` (NUEVO). Después de W0. Paralelizable con W3 docs.

`publishedAgentService` (clon estructural de `registry.ts`):
- `publish(input: PublishAgentInput, ownerRef: string)`:
  1. `await validateRegistryUrl(input.agentUrl)` (defense-in-depth CD-1; el route ya validó).
  2. valida mínimos (`name`, `agentUrl`, `capabilities.length ≥ 1`).
  3. deriva slug server-side (guards whitespace, CD-5).
  4. pre-check colisión → throw `already exists`.
  5. INSERT con `owner_ref`. Retorna el row mapeado.
- `listAsAgents(opts?)`: `SELECT … WHERE enabled` → `mapRowToAgent`. `registry = SELF_PUBLISHED_REGISTRY_NAME`, `registry_id = SELF_PUBLISHED_REGISTRY_ID`, `invokeUrl = agent_url`, `verified = false`, `status = 'active'`, `metadata` con `inputSchema/outputSchema/discoverable`.
- `getBySlugAsAgent(slug)`: `SELECT … WHERE slug` → `mapRowToAgent | null`.
- `update(slug, updates: UpdateAgentInput, ownerRef)`: pre-fetch → si owner distinto `throw OwnershipMismatchError` + `logOwnershipMismatch({op:'agentPublishUpdate', resourceId: slug, callerOwnerRef: ownerRef, actualOwnerRef})`; si `updates.agentUrl` → re-valida SSRF; UPDATE filtrado `.eq('slug', slug).eq('owner_ref', ownerRef)` (TOCTOU); PGRST116 → tratar como no-encontrado (404).
- `delete(slug, ownerRef)`: igual patrón con `op:'agentPublishDelete'`.

### W2 — Routes + integración discovery + agent-card + index. Después de W1.

**W2.1 — `src/routes/agents.ts`** (NUEVO, clon de `registries.ts`):
- `POST /`: SSRF-loop sobre `['agentUrl']` (patrón registries.ts:125-155) → `422 SSRF_BLOCKED {field,reason}`; guard `A2A_KEY_REQUIRED` (:158); validar mínimos → `400 {missing}`; `publishedAgentService.publish(body, keyRow.owner_ref)`; colisión → `409`; `201`.
- `PATCH /:slug`: si `body.agentUrl` → SSRF-loop; guard key; `.update(slug, body, ownerRef)`; `mapOwnershipError`-equivalente → 404.
- `DELETE /:slug`: guard key; `.delete(slug, ownerRef)`; 404 disclosure-safe.
- `GET /`: guard key; `listAsAgents` filtrado por owner (o método dedicado).
- **`mapOwnershipError` local** (replicá el de registries.ts:35 dentro de `agents.ts`; NO importés el privado). Error handler estático (CD-10).

**W2.2 — `src/services/discovery.ts`** (aditivo, degradable CD-9):
- En `discover()` (:226): tras armar `allAgents` de registries, mergear `await publishedAgentService.listAsAgents()` **dentro de un try/catch** (falla → log + seguir). Respetar `query.registry`: incluir locales solo si `!query.registry || query.registry === SELF_PUBLISHED_REGISTRY_NAME`. NO early-return si solo hay locales (sin registries). Los locales entran ANTES del pipeline común (status/verified/caps/price/rep/sort/limit) → mismo shape (CD-6).
- En `getAgent()` (:526): intentar `publishedAgentService.getBySlugAsAgent(slug)` **primero** (try/catch); si null → seguir con el fetch de registries.

**W2.3 — `src/routes/agent-card.ts`** (fallback DT-5):
- Tras `getAgent` (:42), donde hoy `registries.find(r => r.name === agent.registry)` (:50) y `if (!registryConfig) 404` (:52): si `agent.registry_id === SELF_PUBLISHED_REGISTRY_ID`, construir un `RegistryConfig` **sintético en memoria** (auth vacío → `resolveAuthSchemes` devuelve `[]`) en vez del `find`. `[VERIFY-AT-IMPL]` los campos de `RegistryConfig`.

**W2.4 — `src/index.ts`**: cerca de :147, `await fastify.register(agentsRoutes, { prefix: '/agents' })` + el import del plugin.

### W3 — Docs + tests. Paralelizable con W1/W2.

**W3.1 — `doc/QUICKSTART-PUBLISH.md`**: quickstart "publicar 1 agente en <5 min":
`curl POST /auth/agent-signup` (#1, ya existe) → `curl POST /agents` (#2) → verificar en
`GET /discover?q=weather` (AC-5). Máximo 2 llamadas HTTP.

**W3.2 — Tests** (§6).

---

## 5. Patrones a seguir (referenciando exemplars verificados)

- **SSRF write-time (route):** copiá el bloque `for (const field of ['agentUrl'] as const) { try { await validateRegistryUrl(body[field]) } catch … err.field = field … 422 SSRF_BLOCKED }` de `registries.ts:125-155`.
- **Guard a2a-key:** `registries.ts:158-163` (403 `A2A_KEY_REQUIRED`).
- **Ownership service:** `registry.ts:231-310` (pre-fetch, `OwnershipMismatchError`, `.eq('owner_ref', ownerRef)`, PGRST116).
- **Slug derivation + whitespace guards:** `registry.ts` `register` (`Registry '${id}' already exists`).
- **Mapper shape:** `discovery.ts:485` `mapAgent` (tu `mapRowToAgent` emite idéntico `Agent`).
- **RegistryConfig sintético:** `agent-card.ts:62` `resolveAuthSchemes` (auth vacío → `schemes: []`).
- **Narrowing JSONB:** `registry.ts` (`as unknown as Json` SOLO en el borde Supabase, CD-8).
- **Tests mocks:** `registries.ssrf.test.ts` + `registries.ownership.test.ts` (mock `node:dns`, mock service, inyección de `request.a2aKeyRow`).

---

## 6. Tests requeridos (14 tests — 4 archivos)

Archivos nuevos: `src/routes/agents.publish.test.ts`, `src/routes/agents.ownership.test.ts`,
`src/services/discovery.selfpublished.test.ts`, `src/routes/agent-card.selfpublished.test.ts`.

| Test | Archivo | Cubre | Aserción |
|------|---------|-------|----------|
| T-PUB-01 publish happy-path | agents.publish | **AC-1** | `201`; `publish` llamado con `ownerRef` del `a2aKeyRow`; body devuelve slug derivado |
| T-PUB-02 self-published en `discover()` mismo shape | discovery.selfpublished | **AC-2/CD-6** | mock `listAsAgents` → `discover()` lo incluye con TODOS los campos `Agent`; pasa por sort/limit |
| T-PUB-03 `getAgent(slug)` resuelve local | discovery.selfpublished | **AC-2** | retorna el agente local sin fetch outbound |
| T-PUB-04 `GET /agents/:slug/agent-card` self-published | agent-card.selfpublished | **AC-2/DT-5** | `200` AgentCard válido con `RegistryConfig` sintético (`schemes: []`) |
| T-PUB-05 SSRF en `agentUrl` (169.254.169.254 / 10.0.0.1 / localhost / file:) | agents.publish | **AC-3/CD-1** | `422 SSRF_BLOCKED {field:'agentUrl'}`; `publish` NO llamado |
| T-PUB-06 SSRF defense-in-depth en service | agents.publish | **AC-3/CD-1** | `publish` con IP privada → throw uniforme; no INSERT |
| T-PUB-07 colisión de slug | agents.publish | **AC-4** | `409` (o 400) `already exists`; sin doble-INSERT |
| T-PUB-08 update cross-owner | agents.ownership | **AC-4/DT-2** | owner B `PATCH` slug de owner A → `404`; `logOwnershipMismatch` llamado; UPDATE filtrado por owner_ref |
| T-PUB-09 delete cross-owner | agents.ownership | **AC-4/DT-2** | owner B `DELETE` slug de owner A → `404`; no borra |
| T-PUB-10 quickstart 2-call | agents.publish | **AC-5** | `POST /auth/agent-signup` + `POST /agents` deja el agente descubrible; curl del doc presente |
| T-PUB-11 campos mínimos faltantes | agents.publish | **AC-6** | `POST /agents {}` / sin `capabilities` → `400` listando `name, agentUrl, capabilities` |
| T-PUB-12 sin a2a-key | agents.publish | **CD-2** | `403 A2A_KEY_REQUIRED`; `publish` NO llamado |
| T-PUB-13 error interno no leakea `err.message` | agents.publish | **CD-10** | body `422/400` sin `stack`/host/SQL; detalle solo en log |
| T-PUB-14 slug derivado server-side ignora slug del body | agents.publish | **CD-5** | body con `slug` malicioso → ignorado; PK = derivado del `name` |

Auto-blindaje aplicable a tests: mockear service **por método** (no un único resolvedValue
que contamine); resetear caches module-level en `beforeEach` si aplica. Sin non-null en tests (CD-7).

> La migración se valida vía runbook de preflight al aplicar — NO en test unitario. El `.sql`
> debe ser idempotente y reversible con su `_down.sql`.

---

## 7. Done Definition (tu trabajo termina cuando)

- [ ] W0 completa: migración + `_down` idempotentes; `database.types.ts` con `a2a_agents`; `PublishAgentInput`/`UpdateAgentInput`/constantes en `types/index.ts`; `OwnershipOp` extendida.
- [ ] W1: `src/services/agent.ts` con publish/listAsAgents/getBySlugAsAgent/update/delete; SSRF defense-in-depth; ownership + `.eq('owner_ref', ...)` en toda mutación.
- [ ] W2: `agents.ts` route (POST/PATCH/DELETE/GET) con SSRF write-time + guard key + error estático; `discovery.ts` merge local aditivo/degradable; `agent-card.ts` fallback sintético; `index.ts` registra el plugin.
- [ ] W3: `doc/QUICKSTART-PUBLISH.md` (2-call `<5 min`); 14 tests verdes.
- [ ] CD-1..CD-10 respetados. `[VERIFY-AT-IMPL]` resueltos leyendo el símbolo real.
- [ ] `yarn tsc`/`biome`/`vitest` verdes; sin `any`, sin non-null assertions, sin hardcodes; puerto 3001 intacto.
- [ ] `wasiai-sdk` NO tocado (CD-4). `/registries` y `getEnabled()` NO devuelven self-published (R6).

---

> **Recordá:** el Dev SOLO lee este Story File. Si algo no está acá, no se hace. Ante
> conflicto con el código real → PARÁ y avisá al orquestador. No redisñes.
