# SDD — [WKH-134] SDK + publish self-serve de 1 agente

> Fase F2 (Architect). Input: `work-item.md` (esta carpeta) + grounding real en
> el codebase. Producto ya resuelto: **publicar es GRATIS con Agent Key válida**
> (anti-spam vía auth + `owner_ref` + SSRF). El SDK-package cliente TS vive en
> `wasiai-sdk` (repo aparte) — FUERA de scope (CD-4). Esta HU = endpoint/flujo
> servidor + quickstart docs.

---

## 1. Context Map — archivos leídos y patrón extraído

| Archivo | Por qué lo leí | Qué extraje / reuso |
|---------|----------------|---------------------|
| `src/routes/registries.ts` | Exemplar del endpoint gemelo (write con SSRF + ownership) | Patrón exacto: `requirePaymentOrA2AKey` preHandler → guard `if (!request.a2aKeyRow) 403 A2A_KEY_REQUIRED` → validar TODAS las URLs con `validateRegistryUrl` ANTES de persistir → `422 SSRF_BLOCKED {field,reason}` → `mapOwnershipError` (404/403) → mensaje de error estático (F-05, no leak `err.message`) |
| `src/services/registry.ts` | Exemplar del service con ownership guard | Pre-check colisión de slug → `already exists`; `register(config, ownerRef)`; `update/delete` con pre-fetch + `OwnershipMismatchError` (404 disclosure-safe) + `SYSTEM_OWNER_REF` (403) + UPDATE/DELETE filtrado por `.eq('owner_ref', ownerRef)` (TOCTOU); guards de whitespace del slug; defense-in-depth re-valida SSRF en el service |
| `src/routes/discover.ts` | Contrato de `/discover` GET/POST y `/discover/:slug` | Delega todo a `discoveryService.discover()` / `.getAgent()`. NO toca este archivo — la integración va en el service |
| `src/services/discovery.ts` | Cómo se agregan agentes hoy y dónde inyectar los self-published | `discover()` hace **fetch outbound** por cada registry (`queryRegistry`), luego pipeline común (blocklist → status → verified → caps → price → `attachReputations` → sort → limit → `attachIdentities`). `getAgent()` itera registries y fetchea `agentEndpoint`. Punto de inyección: mergear agentes locales (DB, sin fetch) ANTES del pipeline común |
| `src/services/agent-card.ts` | Cómo se construye el AgentCard y qué necesita de `registryConfig` | `buildAgentCard(agent, registryConfig, baseUrl, ...)` solo usa `registryConfig` para `resolveAuthSchemes` (auth.type). Capabilities → skills. `url = ${baseUrl}/agents/${slug}` |
| `src/routes/agent-card.ts` | El `GET /agents/:slug/agent-card` (AC-2) | Resuelve `getAgent(slug)` → busca `registryConfig` por `r.name === agent.registry` en `getEnabled()`. **Riesgo**: un agente self-published no tiene fila en `registries` → 404. Requiere fallback a un `RegistryConfig` sintético (W2) |
| `src/lib/url-validator.ts` | El guard SSRF a reusar (DT-1/CD-1) | `validateRegistryUrl(rawUrl)` → throw `SSRFViolationError {reason,category,field}` (allowlist env `DISCOVERY_SSRF_ALLOWLIST`). 5 stages: parse, protocol http(s), literal block (localhost/*.local), allowlist, private/loopback/link-local IP (v4+v6, ::ffff mapped) |
| `src/services/security/errors.ts` | Errores de ownership a reusar (DT-2/CD-2) | `OwnershipMismatchError` (genérico), `logOwnershipMismatch({op, resourceId, callerOwnerRef, actualOwnerRef})` PII-safe (hash). `OwnershipOp` es una union extensible → agrego `agentPublishUpdate`/`agentPublishDelete` |
| `src/middleware/a2a-key.ts` (L1010-1047) | Firma de `requirePaymentOrA2AKey` | Devuelve `preHandlerAsyncHookHandler[]`; setea `request.a2aKeyRow` (con `owner_ref`) cuando hay a2a-key; delega a x402 si no hay key. Mismo wrapper que registries → **efectivamente gratis** para holders de a2a-key (no hay precio x402 configurado en el body) |
| `src/routes/auth/signup.ts` | `POST /auth/agent-signup` (AC-5, llamada #1) | Devuelve `{key_id, ...}` con `owner_ref` del body; ya existe. La HU agrega **1 sola** llamada nueva (publish) → 2 HTTP calls totales |
| `src/routes/mock-registry.ts` | Contra-ejemplo de "gateway hospeda lista local" | Confirma que un self-fetch (gateway fetchea su propio endpoint) es un anti-patrón; además `localhost`/IP privada sería **bloqueado por el propio SSRF guard** → descarta la opción "registry sintético apuntando a sí mismo" |
| `src/types/index.ts` (`Agent`, L122) | Shape exacto que debe emitir el mapper (AC-2) | Campos obligatorios: `id, name, slug, description, capabilities[], priceUsdc, registry, registry_id, invokeUrl, invocationNote, verified, status`; opcionales `metadata, payment, identity, computedReputation` |
| `src/types/database.types.ts` (L1925 `registries`) | Modelo de tipos Supabase a espejar | Agrego bloque `a2a_agents` Row/Insert/Update siguiendo el patrón (snake_case, `owner_ref`, JSONB para capabilities/schemas) |
| `supabase/migrations/20260401000000_kite_registries.sql`, `20260427210000_registries_owner_ref.sql`, `20260610000000_wkh_sec02c_rls_registries.sql` | Patrón de migración: CREATE TABLE idempotente, `owner_ref TEXT NOT NULL DEFAULT`, índices, `BEGIN/COMMIT`, RLS `ENABLE ROW LEVEL SECURITY` deny-by-default (service_role bypass, sin FORCE) | Espejo directo para `a2a_agents` |
| `src/routes/registries.ssrf.test.ts`, `registries.ownership.test.ts` | Patrón de tests (mock `node:dns`, mock service, inyección de `a2aKeyRow`) | Reuso 1:1 la estrategia de mocks para los tests SSRF/ownership del nuevo endpoint |
| `doc/sdd/128.../auto-blindaje.md`, `097.../auto-blindaje.md` | Auto-Blindaje histórico (ver §8) | CDs preventivos derivados |

---

## 2. Decisiones técnicas (DT-N)

### DT-1 — Reusar `validateRegistryUrl` / `SSRFViolationError` sin variantes *(heredada del work-item)*
Toda URL saliente del payload (`agentUrl` y cualquier URL derivada) pasa por
`validateRegistryUrl` de `src/lib/url-validator.ts` **antes de persistir**, con
el mismo mapeo `422 SSRF_BLOCKED {field, reason}` que `POST /registries`. Ídem
defense-in-depth en el service (`agentService.publish` re-valida). Prohibida una
validación paralela o debilitada. **Justificación**: cero superficie SSRF nueva;
el validador ya cubre v4/v6/::ffff/metadata (WKH-62) y es el mismo dominio de
incidentes que generó 3 HUs previas.

### DT-2 — Reusar el patrón `owner_ref` + `OwnershipMismatchError` *(heredada)*
`publish` recibe `ownerRef` desde `request.a2aKeyRow.owner_ref`; `update`/`delete`
aplican pre-fetch + `OwnershipMismatchError` (→ 404 disclosure-safe) y filtran el
UPDATE/DELETE por `.eq('owner_ref', ownerRef)` (defensa TOCTOU). Se reusa
`logOwnershipMismatch({op})` extendiendo `OwnershipOp` con
`agentPublishUpdate`/`agentPublishDelete`. **Justificación**: idéntico al guard
de registries (WKH-63) ya endurecido; no se reinventa nada.

### DT-3 — **RESUELTA (3 decisiones que el analyst delegó)**

#### DT-3a — Path/nombre del endpoint → **`POST /agents`** (+ `PATCH`/`DELETE /agents/:slug`)
- **Elegido**: `POST /agents` (publicar), `PATCH /agents/:slug` (actualizar),
  `DELETE /agents/:slug` (despublicar), opcional `GET /agents` (listar los míos).
- **Descartado `POST /registries/agent`**: acopla semánticamente a "registry";
  publicar 1 agente **no** es registrar un marketplace. Confunde el contrato de
  `GET /registries`.
- **Descartado `POST /publish`**: verbo suelto, no-RESTful, namespace huérfano.
- **Justificación**: el recurso es un *agent*. El prefijo `/agents` ya existe
  (montado en `index.ts:147` con `GET /agents/:slug/agent-card`). `POST /agents`
  (colección) y `DELETE /agents/:slug` **no colisionan** con `GET /:slug/agent-card`
  (método+path distintos). Se puede montar un plugin nuevo `agentsRoutes` en el
  **mismo** prefijo `/agents` (Fastify soporta múltiples plugins por prefijo).

#### DT-3b — Modelo de datos → **tabla nueva `a2a_agents`** + merge local en `discovery` (sin self-fetch)
- **Elegido**: tabla nueva `a2a_agents` (owner_ref, slug PK, name, description,
  capabilities JSONB, agent_url, price_usdc, metadata JSONB, enabled). La
  discovery **mergea** estos agentes leyéndolos de la DB (1 SELECT), sin fetch
  outbound, y los hace pasar por el **mismo pipeline** de `discover()` (garantiza
  AC-2 "mismo shape").
- **Descartado — reusar `registries` con discriminador `type`**:
  1. `registries.discovery_endpoint`/`invoke_endpoint` son `NOT NULL` → forzaría
     valores sintéticos ("fake") por fila-agente (hack explícito que el work-item
     admite como opción pero ensucia el modelo).
  2. `GET /registries` y `registryService.list()/getEnabled()` empezarían a
     devolver "agentes" como si fueran marketplaces → rompe el contrato de
     consumidores (p. ej. wasiai-v2).
  3. La opción "registry sintético cuyo `discoveryEndpoint` apunta al gateway/al
     propio agente" implica un **self-fetch HTTP**; peor: apuntar a `localhost`/IP
     interna sería **bloqueado por el propio SSRF guard** (loopback/private-IP).
     Contradicción irresoluble → descartada.
  4. Escala mal: N agentes = N filas-registry = **N fetches outbound** por cada
     `/discover`. Con tabla nueva es **1 SELECT** para todos.
- **Descartado por qué NO duplica el guard de ownership**: `OwnershipMismatchError`
  y `logOwnershipMismatch` son genéricos y compartidos (no acoplados a
  `registries`); `validateRegistryUrl` es neutral. El nuevo `agentService`
  reusa esas tres piezas → cumple CD-2/CD-3 sin re-implementar seguridad.
- **Impacto en migración**: una tabla **aditiva** es más segura que un `ALTER`
  sobre la tabla caliente `registries` (sin backfill de discriminador, sin riesgo
  sobre filas existentes). RLS deny-by-default espejando WKH-SEC-02c.
- **Impacto en `discovery.ts`** (acotado y aditivo): (i) `discover()` mergea
  `agentService.listAsAgents()` y NO retorna temprano si hay agentes locales aunque
  no haya registries; (ii) `getAgent(slug)` consulta local primero; (iii) el
  filtro `query.registry` incluye locales solo si `!registry || registry === 'self-published'`.

#### DT-3c — Shape del payload → **campos mínimos descubribles** (el gateway ensambla el Agent Card)
- **Elegido** (mínimo viable, AC-6):
  ```jsonc
  // POST /agents
  {
    "name": "My Weather Agent",        // req — deriva el slug
    "agentUrl": "https://...",         // req — SSRF-validado; es el invokeUrl real
    "capabilities": ["weather", "geo"],// req — ≥1; se mapean a skills[]
    "description": "…",                // opt (default "")
    "priceUsdc": 0.02,                 // opt (default 0)
    "inputSchema": { … },              // opt (WKH-106 discoverable)
    "outputSchema": { … },             // opt
    "discoverable": true               // opt (opt-in schemas — WKH-106)
  }
  ```
- **Descartado exigir un Agent Card A2A completo**: rompe el objetivo "<5 min /
  2 llamadas" (AC-5) y el "mínimo viable descubrible". El AgentCard A2A **de
  salida** ya lo construye `agentCardService.buildAgentCard` a partir de estos
  campos (capabilities→skills, url, auth) — no hay razón para pedirlo de entrada.
- **Validación (AC-6)**: si falta `name`, `agentUrl` o `capabilities[≥1]` → `400`
  listando los campos faltantes (mismo patrón que registries).

### DT-4 — Auth: mismo wrapper que `POST /registries` → publish **gratis** con a2a-key
`preHandler: requirePaymentOrA2AKey({description})` + guard duro
`if (!request.a2aKeyRow) return 403 A2A_KEY_REQUIRED`. No hay path x402-anónimo
(CD-2). Idéntico a registries → sin fee/budget para holders de a2a-key
(el decisión de producto ya resuelta). El anti-spam es auth + ownership + SSRF.

### DT-5 — AgentCard de self-published: `RegistryConfig` sintético en la route
`GET /agents/:slug/agent-card` (y `buildAgentCard`) requieren un `registryConfig`.
Un self-published agent no tiene fila en `registries`. Se define
`SELF_PUBLISHED_REGISTRY_ID = 'self-published'` (constante) y, cuando
`agent.registry_id === SELF_PUBLISHED_REGISTRY_ID`, la route arma un
`RegistryConfig` **sintético en memoria** (auth vacío → `authentication.schemes: []`)
en vez de buscarlo en `getEnabled()`. Cambio acotado y aditivo en `agent-card.ts`.

### DT-6 — `invokeUrl = agentUrl` (invocación directa vía compose)
El mapper setea `Agent.invokeUrl = agent_url`. Compose ya re-valida `invokeUrl`
con SSRF en runtime (WKH-SEC-04), así que el agente self-published es invocable
por `/compose`/`/orchestrate` como cualquier otro. `invocationNote` estándar.

---

## 3. Constraint Directives (CD-N)

Heredadas del work-item (INVIOLABLES):
- **CD-1**: PROHIBIDO introducir validación SSRF nueva/distinta de
  `validateRegistryUrl` para `agentUrl` o cualquier URL derivada. Toda URL
  saliente pasa por el validador existente (write-time en route **y**
  defense-in-depth en service).
- **CD-2**: PROHIBIDO persistir/mutar un agente sin `owner_ref` del caller
  autenticado. No hay path anónimo/x402-only que publique o mute.
- **CD-3**: OBLIGATORIO que AR verifique citando archivo:línea: (a) el endpoint
  llama a `validateRegistryUrl` antes de persistir, (b) toda mutación filtra por
  `owner_ref`, (c) ningún mensaje de error filtra la existencia de un slug de
  otro owner (404 disclosure-safe idéntico a registries).
- **CD-4**: PROHIBIDO tocar el repo/paquete `wasiai-sdk` desde esta HU.

Nuevas del SDD:
- **CD-5** *(auto-blindaje 128/097)*: PROHIBIDO usar un valor controlado por el
  cliente como clave de idempotencia/identidad de un recurso con efectos.
  El **slug** (PK de `a2a_agents`) se deriva server-side del `name`
  (`toLowerCase().replace(/\s+/g,'-')`) con los mismos guards de whitespace que
  `registryService.register` (leading/trailing + colapsable interno) — no se
  acepta un slug del body. Ref: WKH-131 auto-blindaje#5 (idempotencia server-side),
  WKH-100 (colisión de normalización de slug).
- **CD-6**: OBLIGATORIO que el merge de agentes locales en `discover()` sea
  aditivo y pase por el **mismo** pipeline (status/verified/caps/price/rep/sort/
  limit) — cero rama que altere el shape del `Agent` para self-published (AC-2).
- **CD-7**: PROHIBIDO `non-null assertion` (`!`) — el codebase lo prohíbe
  (`lint/style/noNonNullAssertion`). Usar guards explícitos. Ref: WKH-131
  auto-blindaje#4.
- **CD-8** *(TypeScript strict, project-context §8)*: sin `any` explícito, sin
  `as unknown` fuera del narrowing acotado JSONB ya usado en `registry.ts`.
- **CD-9**: la degradación de discovery NUNCA rompe: si el SELECT de agentes
  locales falla, `discover()`/`getAgent()` siguen devolviendo los agentes de
  registries (mismo espíritu que `attachReputations`/`attachIdentities`).
- **CD-10**: el error handler del endpoint devuelve mensaje **estático** al
  cliente (F-05); el detalle va a `request.log.warn` server-side. Nunca leak de
  `err.message` (puede cargar host/SQL/datum SSRF).

---

## 4. Waves de implementación

### W0 — Serial (contratos, tipos, migración). NADA en paralelo.
1. **Migración** `supabase/migrations/20260703000000_wkh134_a2a_agents.sql`
   (+ `_down.sql`): `CREATE TABLE IF NOT EXISTS a2a_agents` con
   `slug TEXT PRIMARY KEY`, `name`, `description`, `capabilities JSONB NOT NULL`,
   `agent_url TEXT NOT NULL`, `price_usdc NUMERIC NOT NULL DEFAULT 0`,
   `metadata JSONB`, `enabled BOOLEAN NOT NULL DEFAULT true`,
   `owner_ref TEXT NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`;
   índices `idx_a2a_agents_owner_ref`, `idx_a2a_agents_enabled (WHERE enabled)`;
   `ALTER TABLE a2a_agents ENABLE ROW LEVEL SECURITY` (deny-by-default,
   service_role bypass, sin FORCE — espejo WKH-SEC-02c). Envuelto en `BEGIN/COMMIT`.
   *(Requiere runbook `075-wkh-78-migration-preflight` al aplicar — NO se aplica
   en esta fase; el Dev entrega el `.sql`.)*
2. **`src/types/database.types.ts`**: bloque `a2a_agents` (Row/Insert/Update)
   espejando el patrón de `registries` (L1925).
3. **`src/types/index.ts`**: `PublishAgentInput` (name, agentUrl, capabilities,
   description?, priceUsdc?, inputSchema?, outputSchema?, discoverable?) +
   `export const SELF_PUBLISHED_REGISTRY_ID = 'self-published'` +
   `SELF_PUBLISHED_REGISTRY_NAME`.
4. **`src/services/security/errors.ts`**: extender la union `OwnershipOp` con
   `'agentPublishUpdate' | 'agentPublishDelete'`.

### W1 — Service layer (después de W0; paralelizable con W3 docs)
5. **`src/services/agent.ts`** (NUEVO) — `publishedAgentService`:
   - `publish(input, ownerRef)`: valida SSRF (`validateRegistryUrl(input.agentUrl)`),
     valida campos mínimos, deriva slug (guards whitespace), pre-check colisión
     (`409`/throw `already exists`), INSERT con `owner_ref`. Defense-in-depth
     re-valida SSRF.
   - `listAsAgents(opts?)`: SELECT enabled → `mapRowToAgent` (registry=
     `SELF_PUBLISHED_REGISTRY_*`, registry_id=id, invokeUrl=agent_url, verified=false,
     status='active', metadata con inputSchema/outputSchema/discoverable).
   - `getBySlugAsAgent(slug)`: SELECT por slug → `mapRowToAgent` | null.
   - `update(slug, updates, ownerRef)` / `delete(slug, ownerRef)`: pre-fetch +
     `OwnershipMismatchError` (404) + `.eq('owner_ref', ownerRef)` (TOCTOU) +
     `logOwnershipMismatch`. Re-valida SSRF si `agentUrl` está en el update.

### W2 — Routes + integración discovery (después de W1)
6. **`src/routes/agents.ts`** (NUEVO): `POST /` (publish), `PATCH /:slug`,
   `DELETE /:slug`, `GET /` (list-mine). PreHandler `requirePaymentOrA2AKey` +
   guard `A2A_KEY_REQUIRED`. Mapeo de errores idéntico a registries
   (`mapOwnershipError`-equivalente → 404/409/422/400), mensaje estático (CD-10).
7. **`src/services/discovery.ts`**: `discover()` mergea `listAsAgents()` (respeta
   filtro `query.registry`), sin early-return si hay locales; `getAgent()` intenta
   local primero. Todo dentro del try/degradación (CD-9).
8. **`src/routes/agent-card.ts`**: fallback a `RegistryConfig` sintético cuando
   `agent.registry_id === SELF_PUBLISHED_REGISTRY_ID` (DT-5).
9. **`src/index.ts`**: `await fastify.register(agentsRoutes, { prefix: '/agents' })`
   (junto al registro de `agentCardRoutes`, mismo prefijo).

### W3 — Docs + tests (paralelizable con W1/W2)
10. **`doc/INTEGRATION.md`** (o `doc/QUICKSTART-PUBLISH.md`): quickstart "publicar
    1 agente en <5 min" — `curl` de `POST /auth/agent-signup` (#1) +
    `POST /agents` (#2) + verificación en `GET /discover?q=...` (AC-5).
11. Tests (ver §6).

---

## 5. Exemplars verificados (paths confirmados con Read/Glob)

| Exemplar (verificado ✅) | Se usa como patrón de |
|--------------------------|------------------------|
| `src/routes/registries.ts` (POST/PATCH/DELETE) | endpoint `agents.ts` (SSRF+ownership+auth+error mapping) |
| `src/services/registry.ts` (`register`/`update`/`delete`) | `agent.ts` service (slug, colisión, ownership, TOCTOU, defense-in-depth) |
| `src/lib/url-validator.ts` (`validateRegistryUrl`) | SSRF (CD-1) — sin cambios |
| `src/services/security/errors.ts` (`OwnershipMismatchError`, `logOwnershipMismatch`, `OwnershipOp`) | ownership (CD-2) — solo extiende la union |
| `src/services/discovery.ts` (`discover`/`getAgent`/`mapAgent`) | punto de merge de agentes locales |
| `src/services/agent-card.ts` (`buildAgentCard`/`resolveAuthSchemes`) | AgentCard sintético (DT-5) |
| `supabase/migrations/20260401000000_kite_registries.sql` + `20260427210000_registries_owner_ref.sql` + `20260610000000_wkh_sec02c_rls_registries.sql` | migración `a2a_agents` (CREATE + owner_ref + RLS) |
| `src/routes/registries.ssrf.test.ts` + `registries.ownership.test.ts` | estrategia de mocks (node:dns, service, a2aKeyRow) para los tests |
| `src/types/database.types.ts` L1925 (`registries`) | tipos Supabase de `a2a_agents` |

---

## 6. Plan de tests (≥1 por AC + SSRF + ownership)

Archivos nuevos: `src/routes/agents.publish.test.ts`,
`src/routes/agents.ownership.test.ts`,
`src/services/discovery.selfpublished.test.ts`,
`src/routes/agent-card.selfpublished.test.ts`.

| Test | Cubre | Aserción |
|------|-------|----------|
| T-PUB-01 publish happy-path (agentUrl público, ≥1 cap, a2a-key) | **AC-1** | `201`; `agentService.publish` llamado con `ownerRef` del `a2aKeyRow`; body devuelve slug derivado |
| T-PUB-02 self-published aparece en `discover()` con mismo shape | **AC-2** | mock `listAsAgents` devuelve 1 agente → `discover()` lo incluye con TODOS los campos `Agent` (registry/registry_id/invokeUrl/status/verified); pasa por el pipeline (sort/limit) |
| T-PUB-03 `getAgent(slug)` resuelve el self-published | **AC-2** | `getAgent('my-agent')` retorna el agente local (sin fetch outbound) |
| T-PUB-04 `GET /agents/:slug/agent-card` para self-published | **AC-2** | `200` con AgentCard válido usando `RegistryConfig` sintético (schemes: []) |
| T-PUB-05 SSRF en `agentUrl` (169.254.169.254 / 10.0.0.1 / localhost / file:) | **AC-3 / CD-1** | `422 SSRF_BLOCKED {field:'agentUrl'}`; `publish` **NO** llamado (no persiste) |
| T-PUB-06 SSRF defense-in-depth en el service | **AC-3 / CD-1** | `agentService.publish` con IP privada → throw uniforme; no INSERT |
| T-PUB-07 colisión de slug (mismo name, cualquier owner) | **AC-4** | `409` (o 400 explícito) `already exists`; no doble-INSERT |
| T-PUB-08 update cross-owner | **AC-4 / DT-2** | owner B intenta `PATCH /agents/:slug` de owner A → `404` disclosure-safe; `logOwnershipMismatch` llamado; UPDATE filtrado por owner_ref |
| T-PUB-09 delete cross-owner | **AC-4 / DT-2** | owner B `DELETE /agents/:slug` de owner A → `404`; no borra |
| T-PUB-10 quickstart 2-call (signup → publish) | **AC-5** | secuencia `POST /auth/agent-signup` + `POST /agents` deja el agente descubrible; doc-example curl presente |
| T-PUB-11 campos mínimos faltantes | **AC-6** | `POST /agents {}` / sin `capabilities` → `400` listando `name, agentUrl, capabilities` |
| T-PUB-12 sin a2a-key (x402 anónimo) | **CD-2** | `403 A2A_KEY_REQUIRED`; `publish` NO llamado |
| T-PUB-13 error interno no leakea `err.message` | **CD-10** | body `422/400` sin `stack` ni host/SQL; detalle solo en log |
| T-PUB-14 slug derivado server-side, ignora slug del body | **CD-5** | body con `slug` malicioso → se ignora; PK = derivado del `name` |

*(La migración se valida vía runbook de preflight al aplicar — no en test unitario;
el `.sql` debe ser idempotente y reversible con su `_down.sql`.)*

---

## 7. Riesgos para el Adversarial Review (AR)

- **R1 (SSRF)**: verificar que `validateRegistryUrl(agentUrl)` corre **antes** del
  INSERT en la route Y en `agentService.publish` (defense-in-depth), y que
  `PATCH` re-valida `agentUrl` si viene en el body. Vector: `agentUrl` con
  `::ffff:169.254.169.254`, `http://localhost.`, `http://[::1]`.
- **R2 (IDOR/ownership)**: `PATCH`/`DELETE /agents/:slug` deben filtrar por
  `owner_ref` y devolver 404 disclosure-safe (no distinguir "no existe" de "es de
  otro owner"). Vector: owner B mutando slug de owner A.
- **R3 (self-fetch / DoS discovery)**: confirmar que el merge de locales es un
  SELECT (no un fetch) y que un fallo del SELECT NO rompe `discover()` (CD-9).
- **R4 (leak de error)**: body de error sin `err.message` (CD-10).
- **R5 (slug injection)**: slug derivado server-side; body `slug` ignorado (CD-5).
- **R6 (contrato registries)**: `GET /registries` y `getEnabled()` NO deben
  devolver agentes self-published (viven en tabla aparte — verificar que no hay
  cross-contamination).
- **R7 (RLS)**: la migración habilita RLS deny-by-default; el guard real sigue
  siendo app-layer (`.eq('owner_ref', ...)`) porque el cliente usa
  `SUPABASE_SERVICE_KEY` (BYPASSRLS) — igual que `tasks`/`registries`.

---

## 8. Auto-Blindaje histórico aplicado (últimas HUs DONE)

Leídos: `128/auto-blindaje.md` (WKH-131), `097/auto-blindaje.md`,
`119/auto-blindaje.md`, `M9/auto-blindaje.md`. Patrones recurrentes aplicados:
- **Idempotencia/identidad server-side** (128#5, 100): slug derivado server-side,
  jamás del cliente → **CD-5**.
- **No `non-null assertion` a medias** (128#4): guards explícitos → **CD-7**.
- **Narrowing JSONB acotado** (M9): usar el patrón `as unknown as Json`/`as unknown
  as Row[]` SOLO en el borde Supabase, como en `registry.ts` → **CD-8**.
- **Mensaje de error estático** (097 F-05): nunca leak `err.message` → **CD-10**.

---

## 9. Readiness Check

- [x] Todos los `[NEEDS CLARIFICATION]` del work-item resueltos:
  - endpoint → `POST /agents` (DT-3a)
  - modelo de datos → tabla nueva `a2a_agents` + merge local (DT-3b)
  - shape del payload → campos mínimos (DT-3c)
  - fee/budget → **gratis** con a2a-key, wrapper de registries (DT-4)
- [x] Exemplars verificados con Read (paths reales, §5).
- [x] SSRF (DT-1/CD-1) y ownership (DT-2/CD-2/CD-3) reusan piezas existentes — sin
      reinventar ni debilitar.
- [x] CDs del work-item heredados (CD-1..CD-4) + nuevos (CD-5..CD-10).
- [x] Waves ordenadas: W0 serial (migración/tipos/contratos) → W1 service →
      W2 routes+discovery → W3 docs+tests.
- [x] Test plan ≥1 por AC (AC-1..AC-6) + SSRF (T-PUB-05/06) + ownership
      (T-PUB-08/09) + auth (T-PUB-12).
- [x] Stack respetado: Fastify + Supabase + TS strict + vitest + biome; sin
      hardcodes; puerto 3001; sin tocar `wasiai-sdk` (CD-4).
- [x] Cero `[NEEDS CLARIFICATION]` sin resolver.

**Estado: LISTO para SPEC gate (SPEC_APPROVED).**
