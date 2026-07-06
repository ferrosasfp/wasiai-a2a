# Story File — #155: [WKH-115] Inbound Adapter de Tareas/Bounties Externos → /orchestrate

> SDD: doc/sdd/155-wkh-115-inbound-adapter/sdd.md
> Fecha: 2026-07-06
> Branch: feat/155-wkh-115-inbound-adapter
> Pipeline: NexusAgil QUALITY · SPEC_APPROVED otorgado

---

## Goal

WasiAI A2A es hoy **pull-only** (`/orchestrate`). Esta HU agrega un **adapter INBOUND
source-agnostic** (push/webhook v1): `POST /inbound/:source/tasks` autentica la fuente por
**HMAC-SHA256 sobre el body crudo**, normaliza el payload a `goal`+`budget`+`constraints` con un
adapter genérico, y lo rutea **in-process** al `orchestrateService` existente (mismo patrón que
`agent-links.ts` → NO HTTP self-call, NO cola), pagando con la **agent key a2a configurada por
fuente**. El ciclo de vida (`ingested → routed → settled | rejected | failed`) se trackea en una
tabla nueva `a2a_inbound_tasks` con ownership isolation. Reglas duras: budget SIEMPRE capado,
escrow externo → rechazo explícito, SSRF sobre URLs embebidas, additive-only.

## Acceptance Criteria (EARS)

> Copiados del SDD aprobado. QA los verifica en F4.

- **AC-1**: WHEN llega `POST /inbound/:source/tasks` con firma HMAC válida, THE system SHALL crear un registro con `status='ingested'`.
- **AC-2**: IF la auth de la fuente falla/falta (firma inválida, timestamp fuera de ventana, fuente no configurada), THEN THE system SHALL responder **401** y SHALL NOT crear registro ni invocar orchestrate.
- **AC-3**: WHEN una tarea es ingerida, THE system SHALL normalizarla a `goal`/`budget`/`constraints` con el mapeo documentado del adapter.
- **AC-4**: WHEN una tarea normalizada es ruteada, THE system SHALL invocarla **in-process** contra `orchestrateService` con la agent key a2a de la fuente, seteando `status='routed'` ANTES de invocar y `'settled'` en éxito o `'failed'` (+razón) en error.
- **AC-5**: IF el payload declara su propio pago/escrow (no a2a), THEN THE system SHALL rechazar (`status='rejected'`, razón explícita) y SHALL NOT crear/acreditar budget de ese monto/escrow.
- **AC-6**: WHEN se deriva el `budget`, THE system SHALL capar al mínimo entre el monto declarado (si existe) y el `max-budget-per-task` de la fuente, y usar el default de la fuente si no se declaró monto.
- **AC-7**: WHERE el payload contiene una URL a fetchear, THE system SHALL validarla con `validateOutboundUrl` (SSRF) ANTES de cualquier fetch, y rechazar la tarea si falla.
- **AC-8**: THE system SHALL implementar la ingesta como interfaz de adapter source-agnostic, con ≥1 adapter de referencia (webhook HTTP genérico) sin comprometerse a una plataforma 3rd-party.
- **AC-9**: WHILE se trackea el lifecycle, THE system SHALL aislar todas las lecturas/escrituras por `owner_ref` — cross-tenant tratado como not-found.

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `supabase/migrations/20260708000000_wkh115_inbound_tasks.sql` | Crear | Tabla `a2a_inbound_tasks` + índices + RLS + trigger. SQL EXACTO en Wave 0 abajo. | `supabase/migrations/20260706000000_wkh137_agent_links.sql` |
| 2 | `supabase/migrations/20260708000000_wkh115_inbound_tasks_down.sql` | Crear | `DROP TABLE IF EXISTS a2a_inbound_tasks CASCADE;` (BEGIN/COMMIT). | `..._wkh137_agent_links_down.sql` |
| 3 | `src/types/database.types.ts` | Modificar (aditivo) | Bloque Row/Insert/Update de `a2a_inbound_tasks`. | bloque `a2a_agent_links` (línea ~448) |
| 4 | `src/adapters/inbound/types.ts` | Crear | `InboundAdapter`, `NormalizedInboundTask`, `AdapterValidateResult`. | `src/adapters/types.ts` (interfaces) |
| 5 | `src/adapters/inbound/generic-webhook.ts` | Crear | Adapter genérico HTTP: `validate`/`normalize` never-throws + `getInboundAdapter`. | `src/services/agent-link.ts` (Result-style) + `src/lib/url-validator.ts` |
| 6 | `src/services/inbound-task.ts` | Crear | HMAC gate + `loadSourceConfig` + CRUD ownership-scoped + `capBudget` + escrow-reject + SSRF gate + ruteo in-process. | `src/services/task.ts` + `src/services/agent-link.ts` + `src/services/signed-auth.ts` |
| 7 | `src/routes/inbound.ts` | Crear | `POST /inbound/:source/tasks`; content-type parser raw-body ENCAPSULADO; mapeo error→HTTP. | `src/routes/agent-links.ts` |
| 8 | `src/index.ts` | Modificar (aditivo) | `await fastify.register(inboundRoutes, { prefix: '/inbound' })`. | línea 160 (`agentLinkRoutes`) |
| 9 | `src/adapters/inbound/generic-webhook.test.ts` | Crear | Tests de normalización/cap/escrow/SSRF/mapeo/never-throw. | `src/adapters/*.test.ts` |
| 10 | `src/services/inbound-task.test.ts` | Crear | Tests lifecycle + ownership cross-tenant + ruteo. | `src/services/agent-link.test.ts` |
| 11 | `src/routes/inbound.test.ts` | Crear | Tests de ruta: 401 sin/mal firma, 201 firma válida. | `src/routes/agent-links.test.ts` |
| 12 | `doc/api/inbound-adapter.md` | Crear | Mapeo payload→goal/budget/constraints + esquema HMAC. | — |

## Contrato de Integración ⚠️ BLOQUEANTE

> Esta HU tiene comunicación entre componentes (fuente externa ↔ ruta, ruta ↔ orchestrateService).

### Fuente externa → `POST /inbound/:source/tasks`

**Headers requeridos:**
| Header | Valor |
|---|---|
| `x-wasiai-timestamp` | unix segundos (string). Ej. `"1751826000"`. |
| `x-wasiai-signature` | hex de 64 chars = `HMAC-SHA256(secret, "<timestamp>.<rawBody>")`. |
| `content-type` | `application/json` |

**Firma** = `HMAC-SHA256(secret_de_la_fuente_en_UTF8, "<timestamp>.<rawBody>")` en hex.
El secreto es `INBOUND_SOURCE_SECRET_<SOURCE>` en UTF-8 (NO un hash previo). El HMAC se calcula
sobre los **bytes exactos** del body recibido (`req.rawBody`), nunca sobre un re-`JSON.stringify`.

**Request body (payload genérico, `application/json`):**
```json
{
  "goal": "string — REQUERIDO, no vacío tras trim",
  "id": "string — opcional, mapea a external_ref",
  "budget_usdc": "number — opcional, finito ≥0; NaN/Infinity/negativo → 400",
  "constraints": "object — opcional; no-object → {}",
  "callback_url": "string — opcional, se valida por SSRF",
  "artifact_url": "string — opcional, se valida por SSRF",
  "payment": "cualquier valor no-null presente ⇒ escrow externo ⇒ rejected",
  "escrow": "cualquier valor no-null presente ⇒ escrow externo ⇒ rejected"
}
```

**Responses:**
| HTTP | Body | Cuándo |
|---|---|---|
| 200 | `{ "status": "settled", "orchestrationId": "...", "answer": ... }` | Ruteo OK (`pipeline.success===true`). |
| 200 | `{ "status": "rejected", "reason": "..." }` | Escrow externo (AC-5) o URL SSRF-inválida (AC-7). |
| 200 | `{ "status": "failed", "reason": "..." }` | orchestrate no-ready / `pipeline.success===false` / throw (fail-closed CD-10). |
| 201 | `{ "status": "ingested", ... }` | (Ver nota) — el SDD §4.4 responde 200 con `status` terminal; el test AC-1 valida la CREACIÓN del row `ingested`. Si se implementa una respuesta 201 intermedia, mantené coherencia con el test. Ante duda → escalá. |
| 400 | `{ "error_code": "INVALID_PAYLOAD" }` | `validate` !ok (goal ausente/vacío, budget_usdc inválido). Sin row. |
| 401 | `{ "error_code": "UNAUTHORIZED" }` | Firma inválida/ausente, timestamp fuera de ventana, fuente sin secret. Cero row, cero orchestrate. |
| 500 | `{ "error_code": "INBOUND_SOURCE_MISCONFIGURED" }` | Key pagadora inexistente/inactiva o config inválida (firma FUE válida). |

> NOTA sobre AC-1 vs. respuesta: el SDD §4.4 modela el request como **síncrono** — el mismo POST
> crea `ingested`, rutea y devuelve el estado terminal (200 `settled`/`rejected`/`failed`). AC-1 se
> valida verificando que el row pasó por `status='ingested'` (spy/orden de escrituras), NO que la
> respuesta HTTP sea 201. Seguí el flujo de 13 pasos (Wave 2). No inventes un modo async.

### Ruta/servicio → `orchestrateService.orchestrate` (in-process)

**Llamada** (SDD §4.4 paso 12):
```
orchestrateService.orchestrate(
  { goal, budget: budgetUsdc, scopingKeyRow: keyRow, chainId: cfg.chainId /* , maxQuotedCostUsdc? */ },
  orchestrationId,
)
```
- `budget: budgetUsdc` es el **cap efectivo** del path atómico (early-fail por fondos + money-path
  debita del prepago de la key). El money-path queda intacto.
- ⚠️ **VERIFY-AT-IMPL (gap real detectado en grounding)**: `orchestrate(request, id)` está tipado
  `(request: OrchestrateRequest, ...)` y `OrchestrateRequest` (`src/types/index.ts:473-502`) **NO
  declara `maxQuotedCostUsdc`** (esa propiedad vive en `OrchestrateExecuteRequest` /
  `OrchestratePlanResult`, y el path atómico de `orchestrate()` tiene el cap-gate **inactivo** —
  ver `orchestrate.ts:406`). Pasar `maxQuotedCostUsdc` como propiedad de un object-literal fresco
  romperá `tsc` strict (excess-property check). **Guía**: construí el request como
  `OrchestrateRequest` (sin `maxQuotedCostUsdc`); el cap real es `budget: budgetUsdc`. Si al
  implementar necesitás forzar el cap-gate del execute, eso NO está en el path `orchestrate()`
  atómico → **PARÁ y escalá a Architect** (no cambies a `executeApprovedPlan` por tu cuenta; es
  decisión de diseño).

---

## Exemplars

### Exemplar 1: Ruta delgada + preHandler + mapeo error→HTTP
**Archivo**: `src/routes/agent-links.ts` (redeem, líneas 132-199)
**Usar para**: Archivo #7 (`src/routes/inbound.ts`)
**Patrón clave**:
- `FastifyPluginAsync`, `fastify.post<{ Params: {...} }>('/:source/tasks', { config: { rateLimit: orchestrateRateLimit() }, preHandler: [createBackpressureHandler(), createTimeoutHandler(...)] }, handler)`.
- `if (reply.sent) return;` bail-early tras timeout (líneas 149, 159).
- Cada error-clase → su HTTP code (`if (err instanceof XError) return reply.status(N).send({ error_code })`), con `fastify.log.error({ errorClass: err instanceof Error ? err.constructor.name : 'unknown' }, ...)` genérico al final.
- Registro del plugin en `src/index.ts:160` (`await fastify.register(agentLinkRoutes, { prefix: '/agents' })`).

### Exemplar 2: HMAC verify never-throws (length-check + hex malformado)
**Archivo**: `src/services/signed-auth.ts:155-194` (`verifyHmacRequestSignature`)
**Usar para**: Archivo #6 — `verifySourceAuth`
**Patrón clave**:
- Rechazar hex malformado ANTES de `Buffer.from`: `if (!HMAC_HEX_RE.test(signature)) return false;` (regex `^[0-9a-f]{64}$`, definila local si no está exportada).
- `createHmac('sha256', key).update(canonical).digest()` → `expected: Buffer`.
- `Buffer.from(signature, 'hex')` dentro de `try/catch { return false }`.
- **Length-check ANTES de `timingSafeEqual`**: `if (provided.length !== expected.length) return false;`.
- Canonical del inbound = `"<timestamp>.<rawBody>"` (rawBody = `Buffer`/string exacto). La HMAC key = el secreto en UTF-8 (`Buffer.from(secret, 'utf8')`), NO un hash previo.
- Ventana anti-replay: `Math.abs(now - Number(timestamp)) <= INBOUND_HMAC_TOLERANCE_SEC` (default 300). `timestamp` no-numérico/NaN → falla (401).

### Exemplar 3: CRUD ownership-scoped + jsonb narrowing
**Archivo**: `src/services/task.ts` (completo)
**Usar para**: Archivo #6 — CRUD de `a2a_inbound_tasks`
**Patrón clave**:
- Cada método recibe `ownerRef: string`. Toda query filtra `.eq('id', id).eq('owner_ref', ownerRef)`.
- `get` → `.maybeSingle()` → `data ? rowToInbound(data as unknown as InboundTaskRow) : undefined` (cross-tenant = undefined).
- `updateStatus` → `.update({...}).eq('id',id).eq('owner_ref',ownerRef).select().single()`.
- `InboundTaskRow` interface local; jsonb `constraints` narrowed con `as unknown as` (mismo comentario que `task.ts:82-83`).
- Insert: `row as Database['public']['Tables']['a2a_inbound_tasks']['Insert']`.
- Error-clases custom al final del archivo (`class InboundTaskNotFoundError extends Error`).

### Exemplar 4: Invocación in-process a orchestrate con key propia como pagador
**Archivo**: `src/services/agent-link.ts:340-395`
**Usar para**: Archivo #6 — ruteo in-process
**Patrón clave**:
- `import { orchestrateService } from './orchestrate.js';`
- Resolver la key pagadora → pasarla como `scopingKeyRow`.
- Reusar el money-path (NO debitar por tu cuenta; orchestrate lo hace).
- El SDD usa `orchestrate()` (plan+execute atómico), no `executeApprovedPlan` — ver Contrato de Integración arriba.

### Exemplar 5: SSRF Result-style (never-throws)
**Archivo**: `src/lib/url-validator.ts` (`validateOutboundUrl`, ~línea 235)
**Usar para**: Archivo #6 — SSRF gate (AC-7)
**Patrón clave**:
- `import { validateOutboundUrl } from '../lib/url-validator.js';`
- `const r = validateOutboundUrl(url); if (!r.ok) { /* reject con reason r.reason */ }`.
- PROHIBIDO un validador nuevo (CD-OBL-3).

### Exemplar 6: Resolver key row de la fuente
**Archivo**: `src/services/identity.ts:91-113` (`lookupByHash`) + `src/routes/auth/parsers.ts:99-128`
**Usar para**: Archivo #6 — resolver pagador
**Patrón clave**:
- `const keyHash = crypto.createHash('sha256').update(cfg.a2aKeyRaw).digest('hex');`
- `const keyRow = await identityService.lookupByHash(keyHash);`
- `if (!keyRow || !keyRow.is_active) → INBOUND_SOURCE_MISCONFIGURED (500)`.
- `ownerRef = keyRow.owner_ref`.

### Exemplar 7: Migración tabla + RLS + trigger
**Archivo**: `supabase/migrations/20260706000000_wkh137_agent_links.sql:18-50`
**Usar para**: Archivos #1, #2
**Patrón clave**:
- `CREATE TABLE IF NOT EXISTS` + `owner_ref TEXT NOT NULL` + `CHECK (status IN (...))` + índices `CREATE INDEX IF NOT EXISTS`.
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` (deny-by-default, SIN policy permisiva).
- `DROP TRIGGER IF EXISTS ...; CREATE TRIGGER ... BEFORE UPDATE ... EXECUTE FUNCTION trigger_set_updated_at();`
- Down: `BEGIN; DROP TABLE IF EXISTS ...; COMMIT;`

### Exemplar 8: Bloque de tipos generados
**Archivo**: `src/types/database.types.ts` bloque `a2a_agent_links` (línea ~448-510)
**Usar para**: Archivo #3
**Patrón clave**:
- Insertar bloque `a2a_inbound_tasks: { Row: {...}; Insert: {...}; Update: {...}; Relationships: [] }` en orden alfabético dentro de `public.Tables`.
- `Row`: todos los campos. `Insert`: campos con default/nullable como `?`. `Update`: todos `?`. `constraints` como `Json`. Sin FK → `Relationships: []`.

---

## Constraint Directives (checklist BLOQUEANTE)

> El gate de cada wave FALLA si cualquier CD aplicable no se cumple. Auditar explícitamente.

### OBLIGATORIO
- [ ] **CD-OBL-1**: Ruteo in-process vía `orchestrateService.orchestrate` — PROHIBIDO `fetch()` a `/orchestrate` (self-call).
- [ ] **CD-OBL-2**: `.eq('owner_ref', ownerRef)` en TODA query sobre `a2a_inbound_tasks`; cross-tenant = not-found. RLS en la migración.
- [ ] **CD-OBL-3 (=CD-3)**: Reusar `validateOutboundUrl`/`SSRFViolationError` — PROHIBIDO validador nuevo. Validar ANTES de cualquier fetch.
- [ ] **CD-OBL-4**: HMAC con patrón `signed-auth.ts`: hex malformado rechazado antes de `Buffer.from`; length-check antes de `timingSafeEqual`; HMAC sobre `req.rawBody` CRUDO, nunca re-serialización.
- [ ] **CD-OBL-5**: Secretos/keys/budgets/chain por fuente SOLO desde env (`INBOUND_SOURCE_*_<SOURCE>`). Sin hardcodes.

### PROHIBIDO
- [ ] **CD-1**: NO comprometerse a una 3rd-party específica — adapter genérico/HTTP.
- [ ] **CD-2**: NO crear/acreditar budget de un monto/escrow externo sin pasar por `capBudget`. Escrow declarado ⇒ `rejected`.
- [ ] **CD-5**: NO introducir cola nueva (BullMQ) — ruteo inline/in-process.
- [ ] **CD-6**: NO aceptar el webhook sin auth válida — 401 ANTES de tocar DB o invocar orchestrate.
- [ ] **CD-7**: additive-only — NO modificar `/orchestrate`·`/compose`·`/tasks`. El content-type parser raw-body ENCAPSULADO al plugin `inbound.ts` (NO global).
- [ ] **CD-8** (TS strict): `noUncheckedIndexedAccess` activo — NO indexar arrays con literal usando el valor como no-undefined sin guarda. Usar constantes nombradas o `?? '<literal>'`. — ref WKH-114#1.
- [ ] **CD-9** (never-throw sobre input externo — **CRÍTICO**): `validate`/`normalize` NUNCA throwean sobre payload malformado. Verificar tipo ANTES de spread/iterar (`[...x]` sobre no-iterable, `Object.keys(x)` sobre no-objeto). El gate defensivo va DENTRO del guard. — ref WKH-114#3 (drenó el money-path).
- [ ] **CD-10** (fail-closed — **CRÍTICO**): NO literal fail-open (`{status:'settled'}`/marcar éxito) en ningún `catch` ni rama de error del ruteo. Toda salida ≠ `pipeline.success===true` ⇒ `status='failed'`. Auditar CADA `catch`. — ref WKH-144.
- [ ] **CD-11** (lint/format): `biome check --write` sobre archivos/tests nuevos antes del gate (`useOptionalChain`: `Boolean(x?.m())` en vez de `x !== null && x.m()`). — ref WKH-114/144.

---

## Test Expectations

| Test | ACs | Framework | Qué verifica |
|------|-----|-----------|--------------|
| `inbound.test.ts` → firma válida crea `ingested` | AC-1 | vitest | Row pasa por `status='ingested'` (orden de escrituras). |
| `inbound.test.ts` → sin firma / firma inválida / ts fuera de ventana / fuente sin secret | AC-2 | vitest | 401, cero row, cero orchestrate (spy en `orchestrateService`). |
| `generic-webhook.test.ts` → mapeo payload→goal/budget/constraints | AC-3 | vitest | `normalize` produce el `NormalizedInboundTask` esperado; goal vacío → `validate` !ok. |
| `inbound-task.test.ts` → ruteo llama orchestrate con `scopingKeyRow` de la fuente + routed→settled | AC-4 | vitest | spy: `orchestrate` invocado in-process con `budget` capado; row `routed` antes, `settled` después; `pipeline.success===false`/throw → `failed` (CD-10). |
| `inbound-task.test.ts` → `payment`/`escrow` → `rejected`, cero budget | AC-5 | vitest | row `rejected`+razón; orchestrate NUNCA invocado; sin budget acreditado. |
| `generic-webhook.test.ts` + `inbound-task.test.ts` → cap de budget | AC-6 | vitest | declared>cap → cap; ausente → default; declared inválido → 400. |
| `inbound-task.test.ts` → URL embebida maliciosa (localhost/169.254.169.254/private) → `rejected` | AC-7 | vitest | `validateOutboundUrl` reusado; row `rejected` razón `ssrf:*`; sin fetch. |
| `generic-webhook.test.ts` → interfaz source-agnostic + never-throws | AC-8 | vitest | adapter cumple `InboundAdapter`; sin acoplamiento a plataforma; `normalize` never-throws sobre payloads basura (CD-9: `[]`, `null`, `42`, `{constraints:5}`, `{goal:[]}`, string). |
| `inbound-task.test.ts` → cross-tenant read/write = not-found | AC-9 | vitest | `get`/`updateStatus` con `ownerRef` distinto → undefined/NotFound; todas las queries filtran `owner_ref`. |

**Test-First**: SÍ (lógica de negocio + APIs). Escribí los tests de cada wave junto con el código de esa wave; el gate exige el test verde.
**Mocking**: seguí el harness de `src/services/agent-link.test.ts` (mock de supabase) y `src/routes/agent-links.test.ts` (mock de orchestrate/identity). Spy en `orchestrateService.orchestrate` para AC-2/AC-4/AC-5.

---

## Waves

### Wave -1: Environment Gate (verificar ANTES de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
npm install 2>/dev/null || echo "sin package.json"
# Archivos base del Scope IN deben existir:
ls src/routes/agent-links.ts src/services/task.ts src/services/agent-link.ts \
   src/services/signed-auth.ts src/lib/url-validator.ts src/services/identity.ts \
   src/services/orchestrate.ts src/adapters/types.ts src/types/database.types.ts \
   supabase/migrations/20260706000000_wkh137_agent_links.sql 2>/dev/null || echo "FALTA archivo base"
# La carpeta inbound NO existe todavía (la crea esta HU) — es esperado:
ls src/adapters/inbound/ 2>/dev/null && echo "OJO: ya existe" || echo "OK: se crea en W0"
# Baseline verde antes de empezar:
npx tsc --noEmit && npx biome check src/ && echo "BASELINE OK"
```
**Si algo falla → PARAR y reportar al orquestador. No implementar sobre entorno roto.**

---

### Wave 0 (Serial Gate — contratos/tipos/migración)

**W0.1 — Migración** → Archivo #1 + #2 → Exemplar 7.
Crear `supabase/migrations/20260708000000_wkh115_inbound_tasks.sql` con este SQL EXACTO (SDD §4.2):

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

`_down.sql`:
```sql
-- Down migration: 20260708000000_wkh115_inbound_tasks
BEGIN;
DROP TABLE IF EXISTS a2a_inbound_tasks CASCADE;
COMMIT;
```

> ⚠️ La migración NO se aplica contra bdwv en esta HU (activación separada, patrón WKH-54/137).
> Verificación de que parsea es opcional en Postgres efímero — NO tocar bdwv.

**W0.2 — Tipos generados** → Archivo #3 → Exemplar 8.
Agregar el bloque `a2a_inbound_tasks` a `src/types/database.types.ts` (aditivo, orden alfabético en `public.Tables`). Mapear los tipos SQL: `id/owner_ref/source/status/goal` string; `external_ref/error_reason` `string | null`; `budget_usdc` `number | null`; `constraints` `Json`; `orchestration_id` `string | null`; `created_at/updated_at` string. `Insert`: opcionales los que tienen default/nullable. `Update`: todos opcionales. `Relationships: []`.

**W0.3 — Interfaz adapter** → Archivo #4 → Exemplar `src/adapters/types.ts`.
Crear `src/adapters/inbound/types.ts` (SDD §4.3):
```ts
export interface NormalizedInboundTask {
  goal: string;                       // no vacío
  budgetUsdc: number | null;          // monto declarado (≥0 finito) o null
  constraints: Record<string, unknown>;
  externalRef: string | null;
  embeddedUrls: string[];             // URLs a validar por SSRF (AC-7)
  declaresExternalEscrow: boolean;    // AC-5
}
export type AdapterValidateResult = { ok: true } | { ok: false; reason: string };
export interface InboundAdapter {
  readonly source: string;
  validate(payload: unknown): AdapterValidateResult;   // shape check, NUNCA throws
  normalize(payload: unknown): NormalizedInboundTask;  // solo tras validate ok, NUNCA throws
}
```

**Gate W0**: `npx tsc --noEmit` verde. `biome check` verde sobre los archivos nuevos.

---

### Wave 1 (Parallelizable — adapter de referencia)

**W1.1** → Archivo #5 (`src/adapters/inbound/generic-webhook.ts`) → Exemplar 1 (Result-style) + 5. Depende de W0.3.

Implementar `InboundAdapter` para el payload genérico. **Mapeo EXACTO (SDD §4.6)**:

| Campo payload | Tipo | Mapea a | Regla |
|---|---|---|---|
| `goal` | string | `goal` | **Requerido**, no vacío tras trim. Ausente/vacío/no-string → `validate` !ok. |
| `id` | string | `externalRef` | Opcional. No-string → `null`. |
| `budget_usdc` | number | `budgetUsdc` | Opcional. Finito ≥0; NaN/Infinity/negativo/no-number → `validate` !ok. Ausente → `null`. |
| `constraints` | object | `constraints` | Opcional. No-object plano → `{}`. NUNCA iterar sin verificar objeto plano (CD-9). |
| `callback_url` / `artifact_url` | string | `embeddedUrls[]` | Opcional. Si string → push para SSRF. No-string → ignorar. |
| `payment` / `escrow` | presente (no-null) | `declaresExternalEscrow=true` | La mera presencia de un pago propio ⇒ escrow externo (AC-5). |

**CD-9 CRÍTICO** — `validate` y `normalize` NUNCA throwean:
- Primer guard: `if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return { ok:false, reason:'payload must be a json object' }`.
- `const b = payload as Record<string, unknown>`.
- Verificar `typeof b.goal === 'string'` ANTES de `.trim()`.
- `budget_usdc`: verificar `typeof === 'number' && Number.isFinite && >= 0` antes de usarlo; presente-e-inválido → !ok.
- `constraints`: usar solo si `typeof === 'object' && !== null && !Array.isArray`; si no → `{}`. NUNCA `Object.keys`/spread sin ese guard.
- `normalize` asume `validate` ya pasó pero igual NO debe throwear ante basura (mismo guarding defensivo).
- Test con payloads basura: `[]`, `null`, `42`, `"str"`, `{constraints:5}`, `{goal:[]}`, `{goal:"x",budget_usdc:"NaN"}`.

Agregar `getInboundAdapter(source: string): InboundAdapter` → devuelve el adapter genérico para v1 (registro estático, DT-9); source desconocido igual usa el genérico. Comentario con el mapeo (CD-1: genérico, sin campos de plataforma concreta).

**Gate W1**: `tsc` + `biome` verdes; `generic-webhook.test.ts` verde (AC-3, AC-6 parcial, AC-8, CD-9).

---

### Wave 2 (Service — lifecycle + auth + ruteo). Depende de W0 + W1.

**W2.1** → Archivo #6 (`src/services/inbound-task.ts`) → Exemplars 2, 3, 4, 5, 6.

Exportar `inboundTaskService` con:

- **`loadSourceConfig(source): SourceConfig | null`** — sanitizar `source` a `[A-Z0-9_]` uppercased. Leer env:
  - `INBOUND_SOURCE_SECRET_<S>` (requerido; falta → `null`).
  - `INBOUND_SOURCE_A2A_KEY_<S>` (raw a2a key pagadora; requerido).
  - `INBOUND_SOURCE_MAX_BUDGET_<S>` (cap; requerido, parse finito >0; inválido → `null`).
  - `INBOUND_SOURCE_DEFAULT_BUDGET_<S>` (finito ≥0).
  - `INBOUND_SOURCE_CHAIN_<S>` (opcional → `getAdaptersBundle()?.chainConfig.chainId` como default, patrón `agent-links.ts:99-101`).
  - Cualquier requerido inválido → `null`.
- **`verifySourceAuth(source, rawBody, timestamp, signature): SourceConfig | null`** — Exemplar 2. `loadSourceConfig`; si null → null. Regex hex 64. `Math.abs(now - Number(timestamp)) <= tolerance` (`INBOUND_HMAC_TOLERANCE_SEC` default 300; NaN → fail). `createHmac('sha256', Buffer.from(cfg.secret,'utf8')).update(\`${timestamp}.${rawBody}\`).digest()`. length-check + `timingSafeEqual`. Válido → devuelve `cfg`; si no → `null`.
- **CRUD ownership-scoped** (Exemplar 3): `create(ownerRef, input)`, `updateStatus(ownerRef, id, status, patch)`, `get(ownerRef, id)`. TODAS con `.eq('id',id).eq('owner_ref',ownerRef)`. `InboundTaskRow` local + narrowing `as unknown as`. Error-clase `InboundTaskNotFoundError`.
- **`capBudget(declared: number | null, cfg): number`** → `declared === null ? cfg.defaultBudgetUsdc : Math.min(declared, cfg.maxBudgetUsdc)` (AC-6/CD-2).
- **`ingest(source, cfg, payload): IngestResult`** — orquesta el **flujo de 13 pasos** (SDD §4.4):

  1. (route ya stasheó `req.rawBody` y verificó auth → `cfg`).
  2. (route pasó headers `x-wasiai-timestamp`/`x-wasiai-signature` a `verifySourceAuth`).
  3. Firma válida + ts en ventana → `cfg`. (Inválida/ausente/fuera-de-ventana/sin-secret → `null` → route responde **401**, cero DB, cero orchestrate — AC-2/CD-6.)
  4. `getInboundAdapter(source).validate(payload)` → `!ok` → **400** `INVALID_PAYLOAD` (sin row).
  5. `normalize(payload)` → `NormalizedInboundTask`.
  6. Resolver key pagadora (Exemplar 6): `lookupByHash(sha256(cfg.a2aKeyRaw))` → `if (!keyRow || !keyRow.is_active)` → **500** `INBOUND_SOURCE_MISCONFIGURED`. `ownerRef = keyRow.owner_ref`.
  7. `create(ownerRef, { source, external_ref, goal, constraints, status:'ingested' })` → **`status='ingested'`** (AC-1).
  8. **AC-5 escrow gate**: si `normalized.declaresExternalEscrow` → `updateStatus(ownerRef, id, 'rejected', { error_reason:'external escrow/payment not honored (a2a-only)' })` → return `{status:'rejected', reason}`. NUNCA acreditar budget (CD-2). **FIN.**
  9. **AC-7 SSRF gate**: por cada `url` en `normalized.embeddedUrls` → `validateOutboundUrl(url)`; si algún `!ok` → `updateStatus(..., 'rejected', { error_reason:'ssrf: <reason>' })` → return `{status:'rejected'}`. **FIN.** (Validar ANTES de cualquier fetch — CD-OBL-3.)
  10. **AC-6 cap**: `budgetUsdc = capBudget(normalized.budgetUsdc, cfg)`.
  11. `updateStatus(ownerRef, id, 'routed', { budget_usdc: budgetUsdc, orchestration_id: <uuid> })` → **`status='routed'` ANTES de invocar** (AC-4). Generá `orchestrationId` con `crypto.randomUUID()`.
  12. **AC-4 ruteo in-process**: `orchestrateService.orchestrate({ goal, budget: budgetUsdc, scopingKeyRow: keyRow, chainId: cfg.chainId }, orchestrationId)` (ver VERIFY-AT-IMPL del Contrato de Integración sobre `maxQuotedCostUsdc`). Envolver en `try/catch`.
  13. Éxito (`result.pipeline.success === true`) → `updateStatus(..., 'settled', {})` → return `{status:'settled', orchestrationId, answer: result.answer}`.

  **Flujo de error (SDD §4.5) — CD-10 fail-closed CRÍTICO:**
  - orchestrate no-ready / `result.pipeline.success !== true` / throw → `updateStatus(..., 'failed', { error_reason })` → return `{status:'failed', reason}`. **NUNCA `settled` en ninguna rama de error.** Auditá cada `catch` por defaults que asuman éxito.
  - Si `updateStatus('settled')` falla DESPUÉS de que orchestrate ya debitó (money moved) → loguear para reconciliación y devolver el resultado igual; NO degradar a un error que sugiera "no se cobró" (patrón `agent-link.ts` MNR-b). NO re-invocar orchestrate.

**Gate W2**: `tsc` + `biome` verdes; `inbound-task.test.ts` verde (AC-4, AC-5, AC-6, AC-7, AC-9, CD-10).

---

### Wave 3 (Route + wiring). Depende de W2.

**W3.1** → Archivo #7 (`src/routes/inbound.ts`) → Exemplar 1.
- `FastifyPluginAsync`. `fastify.post<{ Params: { source: string } }>('/:source/tasks', { config: { rateLimit: orchestrateRateLimit() }, preHandler: [createBackpressureHandler(), createTimeoutHandler(...)] }, handler)`.
- **Content-type parser raw-body ENCAPSULADO al plugin** (CD-7): dentro del plugin,
  `fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => { (req as any).rawBody = body; try { done(null, body.length ? JSON.parse(body.toString('utf8')) : {}) } catch (e) { done(e as Error, undefined) } })`.
  Fastify encapsula parsers añadidos dentro de un plugin **sin `fastify-plugin`** → NO afecta otros routes.
  - ⚠️ **VERIFY-AT-IMPL (SDD §4.0/§7)**: confirmá con un test que otros routes siguen parseando JSON normal (el parser NO se filtró). **Fallback si se filtra**: `preParsing` hook scoped al route que capture el raw buffer. Si ninguno funciona limpio → **PARÁ y escalá a Architect**.
- Handler: leer `req.rawBody` + headers `x-wasiai-timestamp`/`x-wasiai-signature` → `verifySourceAuth`. Null → **401** `UNAUTHORIZED`. Luego `ingest(source, cfg, req.body)`. Mapear el resultado a HTTP:
  - `verifySourceAuth` null → **401** `{ error_code:'UNAUTHORIZED' }`.
  - `INVALID_PAYLOAD` → **400** `{ error_code:'INVALID_PAYLOAD' }`.
  - `INBOUND_SOURCE_MISCONFIGURED` → **500** `{ error_code:'INBOUND_SOURCE_MISCONFIGURED' }`.
  - `{status:'settled'|'rejected'|'failed'}` → **200** con el body correspondiente.
  - `if (reply.sent) return;` bail-early tras timeout. `fastify.log.error({errorClass})` genérico en el catch final.
- `export default inboundRoutes;`

**W3.2** → Archivo #8 (`src/index.ts`) → línea 160.
- `import inboundRoutes from './routes/inbound.js';` (junto a los demás imports de routes).
- `await fastify.register(inboundRoutes, { prefix: '/inbound' });` (aditivo, junto a los otros register; NO tocar los existentes).

**Gate W3**: `tsc` + `biome` verdes; `inbound.test.ts` verde (AC-1, AC-2) + test de no-filtración del parser.

---

### Wave 4 (Tests restantes + docs). Depende de todo.

**W4.1** → Archivos #9, #10, #11 — completar los 12 tests de la tabla Test Expectations, mapeados a su AC. Harness: `agent-link.test.ts` (supabase mock) + `agent-links.test.ts` (orchestrate/identity mock).

**W4.2** → Archivo #12 (`doc/api/inbound-adapter.md`) — documentar:
- Esquema HMAC (headers, cómo firmar `"<ts>.<rawBody>"`, ventana de tolerancia, env vars por fuente).
- Tabla de mapeo payload→goal/budget/constraints (SDD §4.6).
- Lifecycle `ingested → routed → settled | rejected | failed` + tabla de responses HTTP.

**Gate W4**: `tsc` verde + `biome check src/` verde + `npx vitest run` de los 3 archivos de test verde + **baseline completo verde** (`npx tsc --noEmit && npx biome check src/`, sin romper tests preexistentes).

---

### Verificación Incremental

| Wave | Verificación al completar |
|------|--------------------------|
| W-1 | Baseline `tsc` + `biome` verde antes de empezar |
| W0 | `tsc --noEmit` verde |
| W1 | `tsc` + `biome` + `generic-webhook.test.ts` verde |
| W2 | `tsc` + `biome` + `inbound-task.test.ts` verde |
| W3 | `tsc` + `biome` + `inbound.test.ts` verde (incl. no-filtración parser) |
| W4 | Full QA: 12 tests verdes + baseline completo sin regresiones |

---

## Definition of Done

- [ ] 9 ACs cubiertos con ≥1 test cada uno (tabla Test Expectations).
- [ ] Additive-only: cero cambio a `/orchestrate`·`/compose`·`/tasks`; parser raw-body encapsulado (verificado por test).
- [ ] Ownership (`.eq('owner_ref',...)` en TODAS las queries) + RLS en la migración.
- [ ] No-budget-de-la-nada: `capBudget` siempre; escrow externo → `rejected` sin acreditar.
- [ ] HMAC (hex-check + length-check + timingSafeEqual + ventana) sobre body crudo.
- [ ] SSRF reusa `validateOutboundUrl` antes de cualquier fetch.
- [ ] Fail-closed (CD-10): toda salida ≠ `pipeline.success===true` ⇒ `failed`.
- [ ] never-throw (CD-9) en `validate`/`normalize` (tests con payloads basura).
- [ ] `tsc --noEmit` + `biome check src/` verdes; 12 tests verdes; baseline sin regresiones.
- [ ] Migración `20260708000000_wkh115_inbound_tasks.sql` + `_down` creadas, **NO aplicadas** (activación separada).
- [ ] `doc/api/inbound-adapter.md` con mapeo + esquema HMAC.

## Out of Scope

- Marketplace UI / dashboard de fuentes; launchpad; 3rd-party específica; poller/pull; cola BullMQ; CRUD dinámico de fuentes.
- Cambios en `/orchestrate`·`/compose`·`/tasks`.
- **Aplicar la migración contra bdwv** (activación separada).
- NO "mejorar" código adyacente; NO agregar funcionalidad no listada.

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala a Architect. No inventar. No asumir.**

Situaciones de escalation específicas de esta HU:
- El content-type parser raw-body se filtra a otros routes y ni encapsulación ni `preParsing` scoped lo evitan (VERIFY-AT-IMPL W3.1).
- `orchestrate()` rechaza el request por `maxQuotedCostUsdc` u otro campo, y `budget` solo no alcanza para el cap requerido (VERIFY-AT-IMPL Contrato de Integración).
- `trigger_set_updated_at()` no existe en el schema local al verificar la migración.
- Un exemplar referenciado no existe o cambió de firma.
- Ambigüedad entre respuesta 200-terminal (SDD §4.4) y 201-ingested del template.

---

*Story File generado por NexusAgil — F2.5 — nexus-architect*
