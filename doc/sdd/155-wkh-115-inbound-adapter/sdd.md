# SDD #155: [WKH-115] Inbound Adapter de Tareas/Bounties Externos → /orchestrate

> SPEC_APPROVED: no
> Fecha: 2026-07-06
> Tipo: feature
> SDD_MODE: full
> Branch: feat/155-wkh-115-inbound-adapter
> Artefactos: doc/sdd/155-wkh-115-inbound-adapter/

---

## 1. Resumen

WasiAI A2A es hoy **pull-only**: los consumidores llaman `/orchestrate`. Esta HU agrega un
**adapter INBOUND source-agnostic** (patrón adapter, push/webhook v1) que ingiere tareas
externas por `POST /inbound/:source/tasks`, autentica la fuente vía **HMAC-SHA256 sobre el body
crudo** (DT-8 resuelto abajo), normaliza el payload a un goal de orchestrate
(`goal`+`budget`+`constraints`) mediante un adapter de referencia genérico, lo rutea
**in-process** al `orchestrateService` existente (mismo patrón que `agent-links.ts` → NO un
HTTP self-call, NO una cola nueva) usando la **agent key a2a configurada por fuente** como
pagador, y trackea el ciclo de vida (`ingested → routed → settled | rejected | failed`) en una
**tabla nueva** `a2a_inbound_tasks` con ownership isolation (`owner_ref` + RLS) y reuso directo
de la protección SSRF existente (`validateOutboundUrl`).

Resultado esperado: una fuente externa (bounty/task platform) puede empujar demanda a WasiAI y
el gateway la ejecuta con su motor de orquestación, **sin confiar ciegamente en montos externos**
(budget siempre capado), **sin honrar escrows externos** (rechazo explícito), y **sin comprometerse
a ninguna 3rd-party específica** (adapter de referencia = webhook HTTP genérico).

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 155 (WKH-115) |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Ingesta push/webhook de tareas externas → normalización → ruteo in-process a `orchestrateService`, con lifecycle propio + ownership + SSRF + cap de budget + rechazo de escrow externo. |
| **Reglas de negocio** | Budget SIEMPRE capado (nunca confiar en monto externo); escrow externo → rechazo; adapter genérico (no 3rd-party); auth de fuente obligatoria; additive-only. |
| **Scope IN** | Migración `a2a_inbound_tasks`, tipos generados, interfaz de adapter, adapter de referencia genérico, service de lifecycle, ruta + auth HMAC, reuso SSRF, tests, docs de mapeo. |
| **Scope OUT** | Marketplace UI, launchpad, 3rd-party específica, poller/pull, cola BullMQ, CRUD dinámico de fuentes, cambios en `/orchestrate`·`/compose`·`/tasks`. |
| **Missing Inputs** | DT-8 (mecanismo de auth) → **resuelto en este SDD**: HMAC-SHA256. DT-9 (alta de fuentes) → env estático. Plataforma de referencia → adapter genérico HTTP (asunción heredada del work-item, no bloqueante). |

### Acceptance Criteria (EARS)

- **AC-1**: WHEN llega un `POST /inbound/:source/tasks` con firma HMAC válida de la fuente, THE system SHALL crear un registro de ingesta con `status = 'ingested'`.
- **AC-2**: IF la autenticación de la fuente falla o falta (firma inválida, timestamp fuera de ventana, fuente no configurada), THEN THE system SHALL responder 401 y SHALL NOT crear ningún registro ni invocar orchestrate.
- **AC-3**: WHEN una tarea es ingerida, THE system SHALL normalizarla a `goal`/`budget`/`constraints` usando el mapeo documentado del adapter correspondiente.
- **AC-4**: WHEN una tarea normalizada es ruteada, THE system SHALL invocarla in-process contra `orchestrateService` (reusando `planOrchestration`/`executeApprovedPlan` vía `orchestrateService.orchestrate`) con la agent key a2a de la fuente, seteando `status='routed'` antes de invocar y `'settled'` en éxito o `'failed'` (+razón) en error.
- **AC-5**: IF el payload declara su propio mecanismo de pago/escrow (no a2a), THEN THE system SHALL rechazar la tarea (`status='rejected'`, razón explícita) y SHALL NOT crear ni acreditar budget a partir de ese monto/escrow.
- **AC-6**: WHEN se deriva el `budget` inbound, THE system SHALL capar al mínimo entre el monto declarado (si existe) y el `max-budget-per-task` de la fuente, y SHALL usar el budget default de la fuente si no se declaró monto.
- **AC-7**: WHERE el payload contiene una URL que el adapter debe fetchear, THE system SHALL validarla con `validateOutboundUrl` (SSRF) antes de cualquier fetch, y SHALL rechazar la tarea si la validación falla.
- **AC-8**: THE system SHALL implementar la ingesta como interfaz de adapter source-agnostic, con ≥1 adapter de referencia (webhook HTTP genérico) sin comprometerse a ninguna plataforma 3rd-party.
- **AC-9**: WHILE se trackea el lifecycle, THE system SHALL aislar todas las lecturas/escrituras por `owner_ref` (mismo contrato que `tasks`/`a2a_agent_keys`, WKH-53/54) — cross-tenant tratado como not-found.

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos (verificados con Read)

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/routes/agent-links.ts` (WKH-137) | Patrón central de ruteo in-process (redeem NO hace HTTP self-call) | Route delgado → service; el service reusa `orchestrateService`; mapeo de error-clases → HTTP codes; `preHandler` backpressure+timeout; `reply.sent` bail-early. |
| `src/services/agent-link.ts` (WKH-137) | Cómo un service nuevo invoca `orchestrateService` con una key propia como pagador | `orchestrateService.executeApprovedPlan({... scopingKeyRow: ownerKey, chainId, maxQuotedCostUsdc: cap})`; error-clases con `code`; settle exactly-once; NUNCA debita por su cuenta (reusa money-path). |
| `src/services/orchestrate.ts:386-495` | Firma real de `orchestrate`/`planOrchestration`/`executeApprovedPlan` + `OrchestrateRequest` | `orchestrate(request, orchestrationId)` = plan+execute atómico; `scopingKeyRow` es el pagador master; `budget`+`maxQuotedCostUsdc` son el cap; early-fail por fondos con `budgetService.getBalance`. |
| `src/services/task.ts` (WKH-54) | Contrato de ownership de la tabla nueva | Todo método recibe `ownerRef`; `.eq('id',id).eq('owner_ref',ownerRef)`; not-found ⟺ cross-tenant; `TaskRow` local + narrowing jsonb `as unknown as`; error-clase `TaskNotFoundError`. |
| `src/lib/url-validator.ts` (WKH-62) | Reuso SSRF | `validateOutboundUrl(rawUrl)` Result-style (nunca throws) + `SSRFViolationError`; `.ok` gate antes de fetch. |
| `src/services/budget.ts:40-103` | Cómo la agent key paga y cómo se lee balance | `getBalance(keyId,chainId,ownerId)` con owner guard + `OwnershipMismatchError`; `debit(...)` es el money-path (NO se llama directo acá, lo hace orchestrate). |
| `src/services/identity.ts:91-113` | Resolver la raw a2a key de la fuente → row | `identityService.lookupByHash(sha256(rawKey))` → `A2AAgentKeyRow \| null`; `is_active` check. |
| `src/routes/auth/parsers.ts:99-128` | Cómo se hashea/resuelve una a2a key | `crypto.createHash('sha256').update(rawKey).digest('hex')` → `lookupByHash`. |
| `src/services/signed-auth.ts:155-194` | **Exemplar HMAC** (verifyHmacRequestSignature) | `createHmac('sha256', key).update(canonical).digest()`; check de longitud ANTES de `timingSafeEqual`; rechazo de hex malformado antes de `Buffer.from`. |
| `src/routes/tasks.ts:26-34` | De dónde sale `owner_ref` en rutas autenticadas por middleware | `request.a2aKeyRow.owner_ref`. (Inbound NO usa ese middleware; deriva owner del key row de la fuente — ver 4.3.) |
| `src/index.ts:144-176` | Dónde registrar la ruta nueva | `fastify.register(xRoutes, { prefix: '/x' })`; agregar `inboundRoutes` con prefix `/inbound`. |

### Exemplars (verificados con Glob/Read)

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `supabase/migrations/20260708000000_wkh115_inbound_tasks.sql` | `supabase/migrations/20260706000000_wkh137_agent_links.sql` + `20260628000000_wkh54_tasks_owner_ref.sql` | Tabla `owner_ref`+CHECK status+índices+RLS deny-by-default+trigger `trigger_set_updated_at`. |
| `src/adapters/inbound/types.ts` | `src/adapters/types.ts` (interfaces de adapter existentes) | Convención de interfaces de adapter del proyecto. |
| `src/adapters/inbound/generic-webhook.ts` | `src/services/agent-link.ts` (Result-style + never-throw) + `src/lib/url-validator.ts` | Normalización defensiva que nunca throwea sobre input externo. |
| `src/services/inbound-task.ts` | `src/services/task.ts` (ownership CRUD) + `src/services/agent-link.ts` (invoca orchestrate) | Lifecycle scoped + ruteo in-process. |
| `src/routes/inbound.ts` | `src/routes/agent-links.ts` | Route delgado + preHandler + mapeo error→HTTP. |
| `src/types/database.types.ts` (modificar, aditivo) | Bloque existente `a2a_agent_links` (línea ~448) | Agregar Row/Insert/Update de `a2a_inbound_tasks` para que `supabase.from()` tipe. |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `a2a_inbound_tasks` | **NO** (la crea esta HU) | ver §4.2 |
| `a2a_agent_keys` | Sí | `id`, `owner_ref`, `key_hash`, `is_active`, `budget` (jsonb) — la fuente paga con una de estas. |
| `tasks` | Sí | Exemplar de ownership; NO se toca (additive-only). |

Función SQL `trigger_set_updated_at()` **existe** (usada por `a2a_agent_links`, `a2a_payment_intents`, etc.) → reusable en el trigger de la tabla nueva.

### Componentes reutilizables encontrados

- `validateOutboundUrl` / `SSRFViolationError` en `src/lib/url-validator.ts` — reusar para AC-7.
- `orchestrateService.orchestrate` en `src/services/orchestrate.ts` — reusar para AC-4 (in-process, money-path intacto).
- `identityService.lookupByHash` en `src/services/identity.ts` — resolver la key de la fuente.
- Patrón HMAC `createHmac + timingSafeEqual + length-check` de `src/services/signed-auth.ts` — reusar para el auth del webhook.
- `trigger_set_updated_at()` (SQL) — reusar en la migración.

---

## 4. Diseño Técnico

### 4.0 DT-8 RESUELTO — Auth del webhook: HMAC-SHA256 sobre el body crudo

**Decisión: HMAC-SHA256 sobre el body crudo, esquema Stripe-style (timestamp firmado + ventana de tolerancia).** Se descarta el bearer estático.

**Justificación (esfuerzo/beneficio):**
- El codebase YA tiene el primitivo exacto (`signed-auth.ts`, `receipt.ts`, `transform-hmac.ts`): `createHmac('sha256', key).update(...).digest()` + length-check + `timingSafeEqual`. Costo marginal ≈ una función de verificación (~30 líneas) reusando el patrón. **El esfuerzo extra vs bearer es mínimo.**
- Beneficio: HMAC sobre el body protege contra **tampering** (la firma cubre el payload completo) y, con el timestamp firmado + ventana, contra **replay**. Un bearer estático viaja en cada request (interceptable, logueable) y no protege el body.

**Esquema concreto (a documentar para las fuentes):**
- Headers requeridos: `x-wasiai-timestamp` (unix segundos, string) y `x-wasiai-signature` (hex de 64 chars = HMAC-SHA256).
- Firma = `HMAC-SHA256(secret_de_la_fuente, "<timestamp>.<rawBody>")` en hex.
- Secreto por fuente env-driven: `INBOUND_SOURCE_SECRET_<SOURCE>` (source uppercased, sanitizado `[A-Z0-9_]`). El HMAC key es el secreto en UTF-8 (no un hash previo; documentar claro para la fuente).
- Ventana de tolerancia: `|now - timestamp| ≤ INBOUND_HMAC_TOLERANCE_SEC` (default 300). Fuera de ventana → 401 (anti-replay).
- Comparación en tiempo constante: rechazar hex malformado ANTES de `Buffer.from`; length-check ANTES de `timingSafeEqual` (patrón `signed-auth.ts:177-193`).
- **Body crudo**: el HMAC se calcula sobre los bytes exactos recibidos, no sobre un re-`JSON.stringify` (que divergiría en orden de claves/espacios). Se captura vía un `addContentTypeParser('application/json', ...)` **encapsulado dentro del plugin `inbound.ts`** (Fastify encapsula content-type parsers añadidos dentro de un plugin sin `fastify-plugin`) que stashea `req.rawBody: Buffer` y luego parsea el JSON normal. **Aditivo y scoped** — no afecta a ningún otro route (CD-7). VERIFY-AT-IMPL: confirmar encapsulación del parser dentro del plugin (fallback: preParsing hook scoped al route).
- Fuente no configurada (falta `INBOUND_SOURCE_SECRET_<SOURCE>`) → 401 (no se filtra qué fuentes existen; mismo código que firma inválida).

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué hace | Exemplar |
|---------|--------|----------|----------|
| `supabase/migrations/20260708000000_wkh115_inbound_tasks.sql` | Crear | Tabla `a2a_inbound_tasks` + índices + RLS + trigger updated_at | `20260706000000_wkh137_agent_links.sql` |
| `supabase/migrations/20260708000000_wkh115_inbound_tasks_down.sql` | Crear | `DROP TABLE IF EXISTS a2a_inbound_tasks CASCADE;` | `..._agent_links_down.sql` |
| `src/types/database.types.ts` | Modificar (aditivo) | Row/Insert/Update de `a2a_inbound_tasks` para tipar `supabase.from()` | bloque `a2a_agent_links` |
| `src/adapters/inbound/types.ts` | Crear | `InboundAdapter`, `NormalizedInboundTask`, `AdapterValidateResult` | `src/adapters/types.ts` |
| `src/adapters/inbound/generic-webhook.ts` | Crear | Adapter de referencia HTTP genérico (`validate`+`normalize`, never-throws) | `agent-link.ts` (Result-style) |
| `src/services/inbound-task.ts` | Crear | Lifecycle CRUD ownership-scoped + cap budget + rechazo escrow + SSRF gate + ruteo in-process + auth HMAC | `task.ts` + `agent-link.ts` |
| `src/routes/inbound.ts` | Crear | `POST /inbound/:source/tasks`; content-type parser raw-body encapsulado; mapeo error→HTTP | `agent-links.ts` |
| `src/index.ts` | Modificar (aditivo) | `fastify.register(inboundRoutes, { prefix: '/inbound' })` | línea 160 (agentLinkRoutes) |
| `src/adapters/inbound/generic-webhook.test.ts` | Crear | Tests de normalización/cap/escrow/SSRF/mapeo | `src/adapters/*.test.ts` |
| `src/services/inbound-task.test.ts` | Crear | Tests lifecycle + ownership cross-tenant | `src/services/*.test.ts` |
| `src/routes/inbound.test.ts` | Crear | Tests de ruta: 401 sin/mal firma, 201 con firma válida | `src/routes/*.test.ts` |
| `doc/api/inbound-adapter.md` | Crear | Mapeo documentado payload→goal/budget/constraints + esquema HMAC | — |

### 4.2 Modelo de datos — `a2a_inbound_tasks`

```sql
CREATE TABLE IF NOT EXISTS a2a_inbound_tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_ref        TEXT NOT NULL,                         -- Ownership Guard (CD-4); del key row de la fuente
  source           TEXT NOT NULL,                         -- :source del path (sanitizado)
  external_ref     TEXT,                                  -- id externo (del payload), nullable
  status           TEXT NOT NULL DEFAULT 'ingested'
                   CHECK (status IN ('ingested','routed','settled','rejected','failed')),
  goal             TEXT NOT NULL,                         -- goal normalizado
  budget_usdc      NUMERIC(20,8),                         -- budget CAPADO; NULL hasta 'routed'
  constraints      JSONB NOT NULL DEFAULT '{}'::jsonb,
  orchestration_id UUID,                                  -- nullable hasta 'routed'
  error_reason     TEXT,                                  -- nullable; poblado en rejected/failed
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_a2a_inbound_tasks_owner  ON a2a_inbound_tasks (owner_ref);
CREATE INDEX IF NOT EXISTS idx_a2a_inbound_tasks_source ON a2a_inbound_tasks (source);
CREATE INDEX IF NOT EXISTS idx_a2a_inbound_tasks_status ON a2a_inbound_tasks (status);

-- RLS deny-by-default (patrón WKH-SEC-02). service_role bypassa por BYPASSRLS;
-- el guard real es el filtro app-layer .eq('owner_ref', ...). Sin policy permisiva.
ALTER TABLE a2a_inbound_tasks ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_a2a_inbound_tasks_updated_at ON a2a_inbound_tasks;
CREATE TRIGGER set_a2a_inbound_tasks_updated_at
  BEFORE UPDATE ON a2a_inbound_tasks
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
```

> **Activación (NO en esta HU):** aplicar esta migración a la DB **bdwv testnet** es un paso de activación separado (igual que WKH-54/137). El SDD deja la migración lista + el `_down` reversible; el Dev NO la aplica ni la corre contra bdwv. Verificación de que compila/parsea: opcional en Postgres efímero (patrón WKH-136), sin tocar bdwv.

### 4.3 Componentes / Servicios

**`src/adapters/inbound/types.ts`**
```
NormalizedInboundTask {
  goal: string;                       // no vacío
  budgetUsdc: number | null;          // monto declarado (≥0 finito) o null si no declaró
  constraints: Record<string, unknown>;
  externalRef: string | null;
  embeddedUrls: string[];             // URLs a validar por SSRF (AC-7)
  declaresExternalEscrow: boolean;    // AC-5: trae su propio pago/escrow no-a2a
}
AdapterValidateResult = { ok: true } | { ok: false; reason: string }
InboundAdapter {
  readonly source: string;
  validate(payload: unknown): AdapterValidateResult;   // shape check, NUNCA throws
  normalize(payload: unknown): NormalizedInboundTask;  // solo tras validate ok, NUNCA throws
}
```

**`src/adapters/inbound/generic-webhook.ts`** — implementa `InboundAdapter` para el payload genérico (ver mapeo §4.6). `validate`/`normalize` defensivos: chequeo de tipos de cada campo antes de usar; jamás spread/iteración de un valor no verificado (CD-9). `getInboundAdapter(source)` devuelve el adapter genérico para v1 (registro estático, DT-9); source desconocido igual usa el genérico (v1) — la diferenciación real es por config/secret, no por adapter.

**`src/services/inbound-task.ts`** — expone:
- `verifySourceAuth(source, rawBody, timestamp, signature): SourceConfig | null` — HMAC gate (§4.0). Devuelve la config de la fuente si válida, `null` si no (route → 401). Carga `SourceConfig` de env; si falta el secret → `null`.
- `loadSourceConfig(source): SourceConfig | null` — lee env: `INBOUND_SOURCE_SECRET_<S>`, `INBOUND_SOURCE_A2A_KEY_<S>` (raw a2a key pagadora), `INBOUND_SOURCE_MAX_BUDGET_<S>` (cap, requerido, finito >0), `INBOUND_SOURCE_DEFAULT_BUDGET_<S>` (finito ≥0), `INBOUND_SOURCE_CHAIN_<S>` (opcional → default del adapters bundle). Cualquier requerido inválido → `null`.
- `ingest(source, config, payload): IngestResult` — orquesta el lifecycle (§4.4).
- CRUD ownership-scoped espejo de `task.ts`: `create(ownerRef, input)`, `updateStatus(ownerRef, id, status, patch)`, `get(ownerRef, id)` — **todas** con `.eq('id',id).eq('owner_ref',ownerRef)`; cross-tenant = not-found (AC-9/CD-4). `InboundTaskRow` local + narrowing `as unknown as` (patrón `task.ts`, jsonb `constraints`).
- Helper `capBudget(declared: number | null, cfg): number` — `declared===null ? cfg.defaultBudgetUsdc : Math.min(declared, cfg.maxBudgetUsdc)` (AC-6/CD-2).

**Pagador (owner_ref):** el `owner_ref` de la tarea inbound = `owner_ref` del key row de la fuente, resuelto vía `identityService.lookupByHash(sha256(cfg.a2aKeyRaw))`. Si `null` o `!is_active` → la fuente está mal configurada → 500 `INBOUND_SOURCE_MISCONFIGURED` (NO 401: la firma fue válida, el fallo es de config server-side). Ese key row se pasa como `scopingKeyRow` a orchestrate (paga con su budget prepago).

### 4.4 Flujo principal (Happy Path)

1. `POST /inbound/:source/tasks` llega. El content-type parser encapsulado stashea `req.rawBody`.
2. Route lee headers `x-wasiai-timestamp` / `x-wasiai-signature` → `inboundTaskService.verifySourceAuth(source, req.rawBody, ts, sig)`.
3. Firma válida + timestamp en ventana → devuelve `SourceConfig`. (Inválida/ausente/fuera de ventana/fuente sin secret → `null` → **401**, cero DB write, cero orchestrate — AC-2/CD-6.)
4. `getInboundAdapter(source).validate(payload)` → si `!ok` → **400** `INVALID_PAYLOAD` (sin row; el shape no es una ingesta válida).
5. `normalize(payload)` → `NormalizedInboundTask`.
6. Resolver key pagadora: `lookupByHash(sha256(cfg.a2aKeyRaw))` → `ownerRef = keyRow.owner_ref` (mal config → 500).
7. `create(ownerRef, {source, externalRef, goal, constraints, status:'ingested'})` → **`status='ingested'`** (AC-1).
8. **AC-5 escrow gate**: si `normalized.declaresExternalEscrow` → `updateStatus(ownerRef, id, 'rejected', {error_reason:'external escrow/payment not honored (a2a-only)'})` → responder 200 `{status:'rejected', reason}`. **NUNCA** se acredita budget (CD-2). FIN.
9. **AC-7 SSRF gate**: por cada `url` en `normalized.embeddedUrls` → `validateOutboundUrl(url)`; si algún `!ok` → `updateStatus(..., 'rejected', {error_reason:'ssrf: <reason>'})` → 200 `{status:'rejected'}`. FIN. (Validación ANTES de cualquier fetch — CD-3.)
10. **AC-6 cap**: `budgetUsdc = capBudget(normalized.budgetUsdc, cfg)`.
11. `updateStatus(ownerRef, id, 'routed', {budget_usdc: budgetUsdc, orchestration_id: <uuid>})` → **`status='routed'` ANTES de invocar** (AC-4).
12. **AC-4 ruteo in-process**: `orchestrateService.orchestrate({ goal, budget: budgetUsdc, scopingKeyRow: keyRow, chainId: cfg.chainId, maxQuotedCostUsdc: budgetUsdc }, orchestrationId)`. (`orchestrate` internamente = `planOrchestration` + `executeApprovedPlan`; money-path intacto; la key de la fuente debita su budget.)
13. Éxito (`result.pipeline.success === true`) → `updateStatus(..., 'settled', {})` → 200 `{status:'settled', orchestrationId, answer}`.

### 4.5 Flujo de error

1. **Auth inválida/ausente/fuera de ventana/fuente no configurada** → 401 `UNAUTHORIZED`, cero row, cero orchestrate (AC-2).
2. **Payload shape inválido** (`validate` !ok) → 400 `INVALID_PAYLOAD`, sin row.
3. **Fuente mal configurada** (key pagadora inexistente/inactiva, max-budget inválido) → 500 `INBOUND_SOURCE_MISCONFIGURED`.
4. **Escrow externo declarado** → row `rejected` + razón, 200 (AC-5). **Sin budget acreditado.**
5. **URL SSRF-inválida** → row `rejected` + razón `ssrf:...`, 200 (AC-7).
6. **orchestrate devuelve plan no-ready / `pipeline.success===false` / throw** → `updateStatus(..., 'failed', {error_reason})` → 200 `{status:'failed', reason}`. **Fail-closed: cualquier salida no-`success===true` ⇒ `failed`, nunca `settled` (CD-10).**
7. **Fallo del `updateStatus` DESPUÉS de que orchestrate ya debitó** (money moved) → loguear para reconciliación y devolver el resultado igual; NO degradar a error que sugiera "no se cobró" (patrón `agent-link.ts` MNR-b). El débito ya ocurrió dentro de orchestrate (idempotencia del money-path, no se re-invoca).

### 4.6 Mapeo documentado — payload genérico → goal/budget/constraints

Payload del webhook genérico (`application/json`):

| Campo payload | Tipo | Mapea a | Regla |
|---------------|------|---------|-------|
| `goal` | string | `goal` | **Requerido**, no vacío tras trim. Ausente/vacío/no-string → `validate` !ok → 400. |
| `id` | string | `externalRef` | Opcional. No-string → `null`. |
| `budget_usdc` | number | `budgetUsdc` | Opcional. Debe ser finito ≥0; presente pero NaN/Infinity/negativo/no-number → `validate` !ok → 400 (no se adivina). Ausente → `null` → default de la fuente (AC-6). |
| `constraints` | object | `constraints` | Opcional. No-object → `{}`. Nunca se itera sin verificar que es objeto plano (CD-9). |
| `callback_url` / `artifact_url` | string | `embeddedUrls[]` | Opcional. Si string → se agrega para SSRF (AC-7). |
| `payment` / `escrow` | presente (cualquier valor no-null) | `declaresExternalEscrow=true` | AC-5: la mera presencia de un mecanismo de pago propio ⇒ rechazo. |

El mapeo vive en `generic-webhook.ts` (comentarios) + `doc/api/inbound-adapter.md`. Es genérico: NO asume campos de ninguna plataforma concreta (CD-1).

---

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-OBL-1**: Ruteo in-process vía `orchestrateService.orchestrate` (reusa `planOrchestration`+`executeApprovedPlan`) — patrón `agent-link.ts`. PROHIBIDO un `fetch()` a `/orchestrate` (self-call).
- **CD-OBL-2**: Ownership guard `.eq('owner_ref', ownerRef)` en TODA query sobre `a2a_inbound_tasks` (patrón `task.ts`); cross-tenant = not-found. RLS habilitada en la migración (patrón WKH-SEC-02).
- **CD-OBL-3 (=CD-3 heredado)**: Reusar `validateOutboundUrl`/`SSRFViolationError` de `src/lib/url-validator.ts` para toda URL embebida antes de cualquier fetch. PROHIBIDO un validador nuevo.
- **CD-OBL-4**: Auth HMAC con el patrón `signed-auth.ts`: rechazar hex malformado antes de `Buffer.from`, length-check antes de `timingSafeEqual`. HMAC sobre el body CRUDO (`req.rawBody`), nunca sobre re-serialización.
- **CD-OBL-5**: Secretos/keys/budgets/chain por fuente SOLO desde env (`INBOUND_SOURCE_*_<SOURCE>`). Sin hardcodes (Golden Path).

### PROHIBIDO
- **CD-1 (heredado)**: PROHIBIDO comprometerse a una 3rd-party específica (ej. Pump GO) — el adapter de referencia es genérico/HTTP.
- **CD-2 (heredado)**: PROHIBIDO crear o acreditar budget a partir de un monto/escrow declarado externamente sin pasar por `capBudget` (AC-5/AC-6). Escrow externo declarado ⇒ `rejected`.
- **CD-5 (heredado)**: PROHIBIDO introducir una cola nueva (BullMQ) — ruteo inline/in-process (WKH-48 fuera de scope).
- **CD-6 (heredado)**: PROHIBIDO aceptar el webhook sin auth de fuente válida — 401 ANTES de tocar DB o invocar orchestrate.
- **CD-7 (heredado)**: additive-only — PROHIBIDO modificar el comportamiento de `/orchestrate`, `/compose`, `/tasks`. El content-type parser raw-body debe estar ENCAPSULADO al plugin `inbound.ts` (no global).
- **CD-8 (TS strict, recurrente)**: PROHIBIDO indexar arrays con literal y usar el valor como no-undefined sin guarda — `noUncheckedIndexedAccess` activo. Usar constantes nombradas o `?? '<literal>'`. — referencia: WKH-114 auto-blindaje#1.
- **CD-9 (never-throw sobre input externo, recurrente)**: `validate`/`normalize` NUNCA deben throwear sobre payload malformado (spread/iteración de un valor no verificado — ej. `[...x]` con `x` no-iterable, `Object.keys(x)` sobre no-objeto). Verificar tipo ANTES de spread/iterar; el gate defensivo va DENTRO del guard, no fuera. — referencia: WKH-114 auto-blindaje#3 (`[...criteria]` no-iterable drenó el money-path).
- **CD-10 (fail-closed money-path, recurrente)**: PROHIBIDO un literal fail-open (`{status:'settled'}` / marcar éxito) en cualquier `catch` o rama de error del ruteo. Toda salida que NO sea `pipeline.success===true` ⇒ `status='failed'`. Auditar cada `catch` por defaults que asuman éxito. — referencia: WKH-144 auto-blindaje (fail-open latente en catch/fallbacks del verifier).
- **CD-11 (lint/format)**: Correr `biome check --write` sobre archivos/tests nuevos antes del gate (multi-line objects, `useOptionalChain`: usar `Boolean(x?.m())` en vez de `x !== null && x.m()`). — referencia: WKH-114/144 auto-blindaje.

---

## 6. Scope

**IN:**
- Migración `a2a_inbound_tasks` (+down) con owner_ref+RLS+índices+trigger.
- `src/types/database.types.ts` (aditivo: tipos de la tabla nueva).
- `src/adapters/inbound/types.ts` + `generic-webhook.ts` (interfaz + adapter de referencia).
- `src/services/inbound-task.ts` (auth HMAC + lifecycle + cap + escrow-reject + SSRF gate + ruteo in-process).
- `src/routes/inbound.ts` + registro en `src/index.ts` (aditivo).
- Tests (adapter, service, route).
- `doc/api/inbound-adapter.md` (mapeo + esquema HMAC).

**OUT:**
- Marketplace UI / dashboard de fuentes; launchpad; 3rd-party específica; poller/pull; cola BullMQ; CRUD dinámico de fuentes; cambios en `/orchestrate`·`/compose`·`/tasks`; aplicar la migración contra bdwv (activación separada).

---

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Content-type parser raw-body filtra a otros routes (rompe additive-only) | M | A | Encapsular el parser dentro del plugin `inbound.ts` (Fastify encapsula parsers no-`fastify-plugin`). VERIFY-AT-IMPL con test de que otros routes siguen parseando JSON normal; fallback: `preParsing` hook scoped al route. |
| `supabase.from('a2a_inbound_tasks')` no tipa (tabla no en generated types) | A | M | Agregar la tabla a `database.types.ts` (aditivo, patrón `a2a_agent_links`) + narrowing `as unknown as InboundTaskRow` (patrón `task.ts`). |
| orchestrate debita pero el `updateStatus('settled')` falla (money moved, row queda 'routed') | B | M | Loguear reconciliación y devolver resultado (patrón `agent-link.ts` MNR-b); NO re-invocar orchestrate (no double-charge). |
| Monto externo malicioso (enorme/negativo) | M | A | `capBudget` (min con cap) + `validate` rechaza negativo/NaN/Infinity (CD-2/CD-9). El budget real está topado por el prepago de la key de la fuente. |
| Replay de un webhook capturado | M | M | Timestamp firmado + ventana `INBOUND_HMAC_TOLERANCE_SEC` (default 300). |
| Migración concurrente (otra HU con migración) | B | B | Timestamp `20260708000000` posterior al último (`20260707`); mismo cuidado de merge que cualquier HU con migración. |

## 8. Dependencias

- `orchestrateService.orchestrate` (existe, `src/services/orchestrate.ts:397`).
- `validateOutboundUrl` (existe, `src/lib/url-validator.ts:235`).
- `identityService.lookupByHash` (existe, `src/services/identity.ts:91`).
- `trigger_set_updated_at()` SQL (existe en migraciones previas).
- No depende de WKH-48 (BullMQ) — ruteo inline.

## 9. Missing Inputs

- [x] Mecanismo de auth por-fuente → **resuelto**: HMAC-SHA256 sobre body crudo (§4.0).
- [x] Alta de fuentes v1 → env estático `INBOUND_SOURCE_*_<SOURCE>` (DT-9).
- [ ] Plataforma de referencia concreta → **asunción heredada del work-item**: el adapter genérico HTTP ES el reference adapter (AC-8). No bloqueante; si el humano tiene una plataforma específica, es un adapter adicional (HU futura) sobre esta misma interfaz.

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| VERIFY-AT-IMPL | 4.0 / 7 | Encapsulación del content-type parser raw-body dentro del plugin (fallback preParsing hook). | No — hay fallback claro |
| Asunción heredada | 9 | Adapter genérico = reference adapter (no plataforma concreta). Documentada en work-item Missing Inputs #3. | No |

> No hay `[NEEDS CLARIFICATION]` sin resolver. DT-8 resuelto en §4.0.

---

## 11. Plan de Implementación (Waves)

### Wave 0 (Serial Gate — contratos/tipos/migración)
- [ ] **W0.1**: Migración `20260708000000_wkh115_inbound_tasks.sql` + `_down.sql` → Exemplar: `20260706000000_wkh137_agent_links.sql`.
- [ ] **W0.2**: `src/types/database.types.ts` — agregar Row/Insert/Update de `a2a_inbound_tasks` (aditivo) → Exemplar: bloque `a2a_agent_links`.
- [ ] **W0.3**: `src/adapters/inbound/types.ts` — `InboundAdapter`, `NormalizedInboundTask`, `AdapterValidateResult` → Exemplar: `src/adapters/types.ts`.

### Wave 1 (Parallelizable — adapter de referencia)
- [ ] **W1.1**: `src/adapters/inbound/generic-webhook.ts` — `validate`/`normalize` never-throws + mapeo §4.6 (CD-9) → Exemplar: `agent-link.ts` Result-style. Depende de W0.3.

### Wave 2 (Service — lifecycle + auth + ruteo, depende de W0+W1)
- [ ] **W2.1**: `src/services/inbound-task.ts` — auth HMAC + `loadSourceConfig` + CRUD ownership-scoped + `capBudget` + escrow-reject + SSRF gate + ruteo in-process (CD-OBL-1/2/3/4, CD-2/CD-10) → Exemplar: `task.ts` + `agent-link.ts`. Depende de W0.1/W0.2/W1.1.

### Wave 3 (Route + wiring, depende de W2)
- [ ] **W3.1**: `src/routes/inbound.ts` — `POST /inbound/:source/tasks`, content-type parser raw-body encapsulado, mapeo error→HTTP → Exemplar: `agent-links.ts`. Depende de W2.1.
- [ ] **W3.2**: `src/index.ts` — `fastify.register(inboundRoutes, { prefix: '/inbound' })` (aditivo).

### Wave 4 (Tests + docs, depende de todo)
- [ ] **W4.1**: Tests (ver §12).
- [ ] **W4.2**: `doc/api/inbound-adapter.md` (mapeo + HMAC).

---

## 12. Test Plan (≥1 test por AC)

| Test | AC que cubre | Wave | Framework | Qué verifica |
|------|-------------|------|-----------|--------------|
| `inbound.test.ts` → firma válida crea `ingested` | AC-1 | W4 | vitest | 201 + row `status='ingested'`. |
| `inbound.test.ts` → sin firma / firma inválida / timestamp fuera de ventana / fuente sin secret | AC-2 | W4 | vitest | 401, cero row, cero orchestrate (spy en orchestrateService). |
| `generic-webhook.test.ts` → mapeo payload→goal/budget/constraints | AC-3 | W4 | vitest | `normalize` produce el `NormalizedInboundTask` esperado; goal vacío → `validate` !ok. |
| `inbound-task.test.ts` → ruteo llama orchestrate con `scopingKeyRow` de la fuente + estados routed→settled | AC-4 | W4 | vitest | spy: `orchestrateService.orchestrate` invocado in-process con `budget` capado; row `routed` antes, `settled` después; `pipeline.success===false`/throw → `failed` (CD-10). |
| `inbound-task.test.ts` → payload con `payment`/`escrow` → `rejected`, cero budget | AC-5 | W4 | vitest | row `status='rejected'` + razón; orchestrate NUNCA invocado; sin budget acreditado. |
| `generic-webhook.test.ts`/`inbound-task.test.ts` → cap de budget | AC-6 | W4 | vitest | declared>cap → cap; declared ausente → default; declared inválido → 400. |
| `inbound-task.test.ts` → URL embebida maliciosa (localhost/169.254.169.254/private) → `rejected` | AC-7 | W4 | vitest | `validateOutboundUrl` reusado; row `rejected` razón `ssrf:*`; sin fetch. |
| `generic-webhook.test.ts` → interfaz de adapter source-agnostic | AC-8 | W4 | vitest | adapter genérico cumple `InboundAdapter`; sin acoplamiento a plataforma; `normalize` never-throws sobre payloads basura (CD-9). |
| `inbound-task.test.ts` → cross-tenant read/write = not-found | AC-9 | W4 | vitest | `get`/`updateStatus` con `ownerRef` distinto → undefined/NotFound; todas las queries filtran `owner_ref`. |

> Todos los tests siguen el patrón vitest existente (`src/services/*.test.ts`, `src/routes/*.test.ts`), mockeando supabase/orchestrate donde aplique.

---

## 13. Readiness Check

```
READINESS CHECK:
[x] Cada AC (1..9) tiene ≥1 archivo asociado en tabla 4.1 y ≥1 test en §12
[x] Cada archivo en 4.1 tiene un Exemplar verificado con Glob/Read (paths reales confirmados)
[x] No hay [NEEDS CLARIFICATION] pendientes (DT-8 resuelto en §4.0)
[x] Constraint Directives incluyen >3 PROHIBIDO (CD-1,2,5,6,7,8,9,10,11) + 5 OBLIGATORIO
[x] Context Map tiene >2 archivos leídos (11 archivos, todos Read verificados)
[x] Scope IN/OUT explícitos y no ambiguos
[x] BD: tabla nueva especificada; `trigger_set_updated_at` verificada que existe; `a2a_agent_keys`/`tasks` verificadas
[x] Happy Path completo (§4.4, 13 pasos)
[x] Flujo de error definido (§4.5, 7 casos)
[x] Auto-Blindaje histórico incorporado (CD-8/9/10/11 desde WKH-114 y WKH-144)
[x] Migración marcada como activación separada (NO se aplica en esta HU)
```

Todos los checks pasan. SDD listo para gate **SPEC_APPROVED**.

---

*SDD generado por NexusAgil — FULL — nexus-architect F2*
