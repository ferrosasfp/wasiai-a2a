# Work Item — [WKH-115] Inbound Adapter de Tareas/Bounties Externos → /orchestrate

## Resumen
WasiAI A2A es hoy **pull-only** (los consumidores llaman `/orchestrate`). Esta HU agrega un
**adapter INBOUND source-agnostic** (patrón adapter, push/webhook v1) que ingiere tareas
externas, las normaliza a un goal de orchestrate (`goal`+`budget`+`constraints`), las rutea
**in-process** al motor de orquestación existente (reusando `orchestrateService`, sin HTTP
self-call ni cola nueva) y trackea su ciclo de vida (`ingested → routed → settled | rejected |
failed`) en una tabla nueva, con ownership isolation y reuso de la protección SSRF existente.

## Sizing
- SDD_MODE: full
- Estimación: L
- Branch sugerido: `feat/155-wkh-115-inbound-adapter`

## F0 — Hallazgos de Codebase Grounding

1. **Ruteo a orchestrate = llamada in-process, no HTTP.** El patrón ya existe en el
   codebase: `src/routes/agent-links.ts` (`POST /agents/links/:token/redeem`, WKH-137) NO
   hace un self-call HTTP a `/orchestrate` — llama directo a
   `agentLinkService.redeem()`, que internamente reusa `executeApprovedPlan` del
   `orchestrateService` (`src/services/orchestrate.ts`). El inbound adapter debe seguir el
   mismo patrón: invocar `orchestrateService.planOrchestration` / `executeApprovedPlan`
   directamente desde el service nuevo, no un `fetch()` a sí mismo.
2. **`tasks` (A2A protocol, WKH-23/53/54) NO alcanza para el lifecycle inbound.** `src/types/index.ts`
   fija `TASK_STATES` a los estados A2A estándar (`submitted|working|completed|failed|
   canceled|input-required`, validados por `TASK_STATES.includes` en
   `src/routes/tasks.ts`). El lifecycle pedido por el ticket (`ingested → routed →
   settled`) es semánticamente distinto (es el ciclo de vida de la INGESTA, no de un A2A
   Task) y forzarlo dentro de `tasks.status` rompería ese enum o el contrato de
   `/tasks/:id/status`. → **tabla nueva** `a2a_inbound_tasks` (ver DT-6).
3. **Ownership pattern confirmado y reusable.** `src/services/task.ts` (WKH-54) y
   `src/services/budget.ts`/`identity.ts` (WKH-53) son la referencia exacta: todo query
   filtra `.eq('owner_ref', ownerRef)`, "not found" cubre both not-exists y cross-tenant.
   La tabla nueva debe seguir el mismo contrato.
4. **SSRF protection reusable y domain-neutral ya existe.** `src/lib/url-validator.ts`
   expone `validateOutboundUrl()` (Result-style, nunca throws) y el wrapper
   `validateRegistryUrl()` (throws `SSRFViolationError`). Es exactamente el mismo
   primitivo usado por `discovery.ts` (WKH-62) y el hardening de MCP/compose (WKH-SEC-04).
   Cualquier URL embebida en un payload inbound que el adapter necesite fetchear (ej.
   callback/artifact URL) DEBE pasar por `validateOutboundUrl` antes de un fetch real.
5. **Modelo agent-key existente alcanza para pagar el orchestrate inbound.** `identityService`/
   `budgetService` (`src/services/identity.ts`, `budget.ts`) ya soportan crear/debitar
   agent keys con budget prepago, `allowed_registries`/`allowed_categories`/
   `max_spend_per_call_usd`. No hace falta un modelo de pago nuevo — la fuente inbound se
   configura con una agent key a2a existente que paga sus orchestrate calls (igual que
   cualquier caller autenticado hoy).
6. **BullMQ no existe todavía** (WKH-48, HU separada). El ruteo v1 debe ser inline/
   síncrono dentro del request del webhook (o un outbox simple, sin infraestructura de
   cola nueva).

## Acceptance Criteria (EARS)

- AC-1: WHEN llega un `POST /inbound/:source/tasks` con autenticación de fuente válida
  (shared-secret/HMAC por fuente, ver DT-8), the system SHALL crear un registro de
  ingesta con `status = 'ingested'`.
- AC-2: IF la autenticación de la fuente falla o falta, THEN the system SHALL responder
  401 y SHALL NOT crear ningún registro de ingesta ni invocar orchestrate.
- AC-3: WHEN una tarea es ingerida, the system SHALL normalizarla a un goal de
  orchestrate (`goal`, `budget`, `constraints`) usando el mapeo documentado del adapter
  correspondiente.
- AC-4: WHEN una tarea normalizada es ruteada, the system SHALL invocarla in-process
  contra `orchestrateService` (reusando `planOrchestration`/`executeApprovedPlan`, patrón
  de `agent-link.ts`) usando la agent key a2a configurada para esa fuente, actualizando
  `status = 'routed'` antes de invocar y `'settled'` en éxito o `'failed'` (+ razón) en
  error.
- AC-5: IF el payload externo declara su propio mecanismo de pago/escrow (no a2a),
  THEN the system SHALL rechazar la tarea (`status = 'rejected'`, razón explícita en el
  registro) y SHALL NOT crear ni acreditar budget a partir de ese monto/escrow declarado.
- AC-6: WHEN se deriva el `budget` del orchestrate para una tarea inbound, the system
  SHALL capar el monto al mínimo entre el monto declarado externamente (si existe) y el
  `max-budget-per-task` configurado para la fuente, y SHALL usar el budget default de la
  fuente si no se declaró monto.
- AC-7: WHERE el payload inbound contiene una URL que el adapter debe fetchear (ej.
  callback/artifact URL), the system SHALL validarla con `validateOutboundUrl` (SSRF)
  antes de cualquier fetch, y SHALL rechazar la tarea si la validación falla.
- AC-8: the system SHALL implementar la ingesta inbound como una interfaz de adapter
  source-agnostic, con al menos 1 adapter de referencia (webhook HTTP genérico)
  implementado y sin comprometerse a ninguna plataforma 3rd-party específica.
- AC-9: WHILE se trackea el lifecycle de una tarea inbound, the system SHALL aislar
  todas las lecturas/escrituras por `owner_ref` (mismo contrato que `tasks`/
  `a2a_agent_keys`, WKH-53/54) — cross-tenant read/write tratado como not-found.

## Scope IN
- Migración SQL: tabla nueva `a2a_inbound_tasks` (`owner_ref`, `source`, `external_ref`,
  `status` enum `ingested|routed|settled|rejected|failed`, `goal`, `budget_usdc`,
  `constraints jsonb`, `orchestration_id` nullable, `error_reason` nullable,
  `created_at`/`updated_at`) + índice `owner_ref` + RLS (patrón WKH-SEC-02).
- `src/adapters/inbound/types.ts` — interfaz del adapter (`normalize(payload) →
  {goal, budget, constraints}`, `validate(payload)`).
- `src/adapters/inbound/generic-webhook.ts` — adapter de referencia (HTTP genérico, NO
  atado a ninguna plataforma específica).
- `src/services/inbound-task.ts` — lifecycle CRUD ownership-scoped + cap de budget +
  rechazo de escrow externo + invocación in-process a `orchestrateService`.
- `src/routes/inbound.ts` — `POST /inbound/:source/tasks`, auth por shared-secret/HMAC
  configurada por fuente (env-driven, sin CRUD dinámico en v1).
- Reuso explícito de `validateOutboundUrl`/`SSRFViolationError`
  (`src/lib/url-validator.ts`) para URLs embebidas en el payload.
- Tests: unit (normalización, cap de budget, rechazo de escrow), ownership
  (cross-tenant), SSRF (URL embebida maliciosa), auth (401 sin secret).
- Mapeo documentado (comentarios + SDD) del payload genérico → goal/budget/constraints.

## Scope OUT
- Marketplace UI / dashboard de fuentes inbound.
- "Agent token launchpad" (descartado explícitamente en el ticket).
- Comprometerse a una 3rd-party específica (Pump GO u otra) salvo decisión humana
  explícita — el adapter de referencia es genérico/HTTP.
- Poller/pull-based ingestion — extensión futura de la misma interfaz de adapter
  (`fetch()` en vez de `normalize(payload)` sobre webhook), no en v1.
- Cola async (BullMQ) — depende de WKH-48, no existe hoy; v1 es inline/in-process.
- CRUD dinámico de fuentes tipo `/registries` (auto-registro de nuevas fuentes vía API) —
  v1 usa configuración estática por env; una API de auto-registro es HU separada.
- Cambios en `/orchestrate`, `/compose`, `/tasks` existentes (additive-only).

## Decisiones técnicas (DT-N)

- DT-1 (fuente v1): adapter de referencia = **webhook HTTP genérico**, no atado a
  ninguna plataforma (el ticket prohíbe comprometerse a Pump GO sin decisión explícita).
- DT-2 (push vs pull): **push (webhook)** para v1 — más simple que un poller con estado
  propio. El poller queda como extensión futura de la misma interfaz de adapter.
- DT-3 (pago/escrow): la fuente inbound se configura con una **agent key a2a existente**
  que paga sus orchestrate calls (reuso de `identityService`/`budgetService`, sin modelo
  de pago nuevo). El inbound **NO crea budget de la nada**. Si el bounty externo declara
  su propio escrow/pago que WasiAI no puede honrar → **rechazo con razón clara** (AC-5).
- DT-4 (budget): derivado del monto del bounty externo pero **capado** al
  `max-budget-per-task` configurado por fuente; si no hay monto declarado, se usa el
  budget default de la fuente (AC-6). Nunca se confía ciegamente en un número externo.
- DT-5 (ruteo): llamada **in-process** a `orchestrateService` (mismo patrón que
  `agent-link.ts` → `executeApprovedPlan`), NO un HTTP self-call, NO una cola nueva.
- DT-6 (lifecycle): tabla nueva `a2a_inbound_tasks` (NO reusa `tasks` — estados y
  semántica distintos, ver hallazgo F0 #2), con `owner_ref` + ownership guard + RLS
  (patrón WKH-53/54/SEC-02).
- DT-7 (SSRF): reuso directo de `validateOutboundUrl`/`SSRFViolationError`
  (`src/lib/url-validator.ts`) para cualquier URL embebida en el payload externo que el
  adapter deba fetchear.
- DT-8 (auth del webhook): shared-secret/HMAC por fuente, configurado vía env
  (mecanismo exacto — HMAC-SHA256 sobre el body vs bearer estático — a decidir en F2;
  ver Missing Inputs #1).
- DT-9 (registro de fuentes v1): configuración estática por env (no CRUD dinámico); el
  adapter de referencia cubre 1 fuente configurada.

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO comprometerse a una 3rd-party específica (ej. Pump GO) en el adapter
  de referencia — debe ser genérico/HTTP.
- CD-2: PROHIBIDO crear o acreditar budget a partir de un monto/escrow declarado
  externamente sin pasar por el cap configurado (AC-5/AC-6).
- CD-3: OBLIGATORIO reusar `validateOutboundUrl`/`SSRFViolationError` existentes para
  cualquier URL embebida en el payload que se fetchee — prohibido un fetch nuevo sin esa
  validación.
- CD-4: OBLIGATORIO ownership guard `owner_ref` en toda query sobre `a2a_inbound_tasks`
  (patrón WKH-53/54) + RLS habilitada en la migración (patrón WKH-SEC-02).
- CD-5: PROHIBIDO introducir una cola nueva (BullMQ) en v1 — ruteo inline/in-process;
  async/cola queda condicionado a WKH-48 (fuera de scope acá).
- CD-6: PROHIBIDO aceptar el webhook sin autenticación de fuente — todo POST sin
  secret/HMAC válido se rechaza 401 antes de tocar DB o invocar orchestrate.
- CD-7: additive-only — prohibido modificar el comportamiento de `/orchestrate`,
  `/compose` o `/tasks` existentes.

## Missing Inputs

- [resuelto en F2 con default] Mecanismo exacto de auth por-fuente: propuesta = HMAC-SHA256
  sobre el body (más robusto contra replay/tampering); alternativa más simple = bearer
  estático por fuente. Architect decide en F2 según esfuerzo/beneficio.
- [resuelto con default, no bloqueante] Alta de fuentes nuevas en v1: env var estática
  (DT-9). Una API de auto-registro tipo `/registries` queda para HU futura si hay demanda.
- [NEEDS CLARIFICATION, no bloqueante] El ticket no especifica una plataforma de
  referencia concreta más allá de prohibir Pump GO sin decisión explícita — este work-item
  asume que el adapter **genérico HTTP** ES el adapter de referencia que satisface AC-8.
  Si el humano tiene una plataforma específica en mente para el reference adapter,
  indicarlo antes de F2.

## Análisis de paralelismo
- No bloquea ninguna otra HU activa. No depende de WKH-48 (BullMQ) para v1 (ruteo
  inline) — sí es un consumidor natural de esa cola cuando exista (extensión futura).
- Puede correr en paralelo con cualquier otra HU que no toque `src/routes/orchestrate.ts`,
  `src/services/orchestrate.ts` o migraciones concurrentes sobre Supabase (riesgo de
  merge, no de lógica — mismo cuidado que cualquier HU con migración nueva).
- Es prerequisito conceptual (no técnico) para futuras integraciones de "fuentes push
  reales" (bounty platforms específicas) — esas serían adapters adicionales sobre esta
  misma interfaz, HUs separadas.
