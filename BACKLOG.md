# BACKLOG — WasiAI A2A Protocol

> **Última actualización**: 2026-04-27 — Hackathon Kite cerrado. Ver `doc/sdd/_INDEX.md` para HUs DONE en detalle.

## Épicas — Estado post-hackathon

### E1: Core Infrastructure ✅ DONE
- [x] HU-001: Setup Fastify + health endpoint
- [x] HU-002: PostgreSQL + migrations setup (Supabase)
- [x] HU-003: Redis + BullMQ setup (no aplica — replaced by Supabase realtime)

### E2: Registry Management ✅ DONE
- [x] HU-010: POST /registries
- [x] HU-011: GET /registries
- [x] HU-012: DELETE /registries/:id
- [x] HU-013: WasiAI pre-registrado por defecto
- [x] HU-014 (NEW): Block update/delete del canonical (PR #36, security hot-fix)
- [ ] HU-015 (TODO): Multi-tenant ownership en registries — ver SEC-REG-1 (WKH-63)

### E3: Discovery ✅ DONE
- [x] HU-020: POST /discover básica
- [x] HU-021: Discovery con filtros
- [x] HU-022: Ranking/scoring (WKH-15-W4)
- [x] HU-023 (NEW): Defensive fallback price_per_call (WKH-57, PR #33)

### E4: Agent Cards (A2A Protocol) ✅ DONE
- [x] HU-030: GET /agents/:id/agent-card
- [x] HU-031: Schema validation
- [x] HU-032: Skills mapping

### E5: Compose (Pipelines) ✅ DONE
- [x] HU-040: POST /compose básico
- [x] HU-041: Transform entre agentes (LLM Bridge Pro — WKH-57)
- [x] HU-042: Error handling y rollback
- [x] HU-043 (NEW): Google A2A fast-path (WKH-56, PR #28)
- [x] HU-044 (NEW): payTo fallback metadata.payment.contract (PR #35)

### E6: Orchestrate (Goal-based) ✅ DONE
- [x] HU-050: POST /orchestrate — goal parsing
- [x] HU-051: Agent selection logic
- [x] HU-052: Pipeline generation

### E7: A2A JSON-RPC
Implementación del protocolo A2A de Google.

- [ ] HU-060: message/send
- [ ] HU-061: message/stream (SSE)
- [ ] HU-062: task/get, task/list
- [ ] HU-063: task/cancel
- [ ] HU-064: task/subscribe

### E7: A2A JSON-RPC ✅ DONE
- [x] HU-060..064 (mensaje/send, stream, task/get, list, cancel, subscribe)

### E8: Kite Integration ✅ DONE
- [x] HU-070: x402 payment flow (WKH-37 v2 + WKH-52 PYUSD)
- [x] HU-071: Agent Passport verification (WKH-29 gasless)
- [x] HU-072: 1% protocol fee (WKH-44)
- [x] HU-073 (NEW): Cross-chain Fuji USDC settle (WKH-55, PR #26)

### E9: Schema Inference ✅ DONE
- [x] HU-080: Inferir schemas
- [x] HU-081: Cache (L1 in-memory + L2 Supabase con schema_hash WKH-57)
- [x] HU-082: Transform caching (LLM Bridge Pro WKH-57)

---

## Hackathon Kite — CERRADO ✅
**Fecha cierre**: 2026-04-27 — todos los épicos must-have + nice-to-have entregados.
- 5/5 cross-chain Fuji USDC settles on-chain (smoke E2E 2026-04-26)
- 463 → 480 tests passing (12 PRs merged en sprint 2026-04-26..27)
- WKH-56 + WKH-57 productivos en Railway (`wasiai-a2a-production.up.railway.app`)

---

## Post-Hackathon

### E10: Multi-Rail Payment Adapters
Extender WasiAI-a2a como gateway neutral multi-rail (no sólo Kite x402).

- [ ] HU-090: Adapter `tempo-mpp` — integrar Machine Payments Protocol (Stripe + Paradigm, mainnet live 2026-03-18)
  - Co-existe con `kite-ozone` bajo `src/adapters/`
  - MPP revive HTTP 402 para pagos machine-to-machine (open-source spec)
  - Validadores anchor: Visa, Stripe, Zodia Custody
  - Gas en stablecoins USD, finalidad ~0.6s, EVM-friendly
  - Docs: https://docs.tempo.xyz, https://stripe.com/blog/machine-payments-protocol
  - **Valor**: posiciona a WasiAI como "A2A gateway neutral" (Kite + Tempo + futuros), no wrapper de un solo rail
- [ ] HU-091: Selector de rail por policy (cost, latency, geography)
- [ ] HU-092: Unificar chain de pago (hoy a2a orquesta en Kite pero agentes wasiai-v2 cobran USDC en Avalanche — deuda de negocio)

### E11: Technical Debt (saved from hackathon)
- [ ] HU-100: `AGENT_BLOCKLIST` env var → tabla DB con razón + expiración
- [ ] HU-101: Compose registry case-sensitivity fix
- [ ] HU-102: Documentar reproducción E2E en README

### E12: WKH-55 Technical Debt ✅ MOSTLY DONE (post-sprint 2026-04-27, PR #34)

**TD-WKH-55-LIGHT** — 6 de 7 items cerrados en PR #34 (chore/td-wkh-55-cleanup):
- [x] TD-WKH-55-1: race condition JSDoc note ✓
- [x] TD-WKH-55-2: comments ES → EN ✓
- [x] TD-WKH-55-3: `_warnedDefaultUsdc` underscore removed ✓
- [x] TD-WKH-55-4: `DownstreamLogger` consolidado en `types/index.ts` ✓
- [x] TD-WKH-55-5: test names descriptivos ✓
- [x] TD-WKH-55-6: NO-OP (no había `toMatchObject` en el archivo) ✓
- [x] TD-WKH-55-7: streaming JSON note ✓

Detalle preservado abajo para histórico.

- [x] **TD-WKH-55-1**: Race condition balance/settle (AR-MNR-2)
  - **Descripción**: Dos invokes paralelos del mismo agente pueden ambos pasar el pre-flight balance check pero solo 1 settle con éxito.
  - **Archivo**: `src/lib/downstream-payment.ts:343-370` (readOperatorBalance)
  - **Solución V2**: Investigar optimistic locking en Fuji nonce (si `wasiai-facilitator` soporta idempotency key)
  - **Estimación**: L
  - **Prioridad**: BAJA (concurrencia baja esperada)

- [ ] **TD-WKH-55-2**: Comments ES/EN consistency (CR-MNR-1)
  - **Descripción**: Comentarios mezclados español/inglés, algunos sin tildes (ej: "inyeccion" → "inyección")
  - **Archivos**: `src/lib/downstream-payment.ts` (múltiples líneas)
  - **Solución**: Unificar a inglés (idioma codebase)
  - **Estimación**: S
  - **Prioridad**: BAJA

- [ ] **TD-WKH-55-3**: Underscore prefix pattern (CR-MNR-2)
  - **Descripción**: `_warnedDefaultUsdc` usa underscore (patrón Python, no idiomatic en TS)
  - **Archivo**: `src/lib/downstream-payment.ts:38`
  - **Solución**: Renombrar a `warnedDefaultUsdc` (sin underscore)
  - **Estimación**: XS
  - **Prioridad**: BAJA

- [ ] **TD-WKH-55-4**: DownstreamLogger consolidation (CR-MNR-3)
  - **Descripción**: `DownstreamLogger` interface definida en 3 sitios (types + constant + usage)
  - **Archivos**: `src/types/index.ts`, `src/lib/downstream-payment.ts`
  - **Solución**: Exportar ÚNICO desde `types/index.ts`, importar en downstream-payment
  - **Estimación**: S
  - **Prioridad**: BAJA

- [ ] **TD-WKH-55-5**: Test naming clarity (CR-MNR-6)
  - **Descripción**: Tests T-W2-01..14 numeración mecánica, poco descriptivos
  - **Archivo**: `src/lib/downstream-payment.test.ts`
  - **Solución**: Renombrar a descriptivos (T-FlagOff, T-PreflightBalance, T-InsufficientBalance, etc.)
  - **Estimación**: M
  - **Prioridad**: BAJA

- [ ] **TD-WKH-55-6**: toMatchObject → exact matchers (AR-MNR-3)
  - **Descripción**: Mock response shape usa `toMatchObject` (permisivo, puede tener campos extra). Mejorar precisión.
  - **Archivo**: `src/lib/downstream-payment.test.ts` (tests `/verify` + `/settle` response)
  - **Solución**: Cambiar a exact shape matchers (ej: `expect(res).toEqual({...})`)
  - **Estimación**: S
  - **Prioridad**: BAJA

- [ ] **TD-WKH-55-7**: Streaming JSON optimization (CR-MNR-5)
  - **Descripción**: Body x402 serializa 2 veces (JSON.stringify + parse interno facilitator). Perf despreciable (< 1ms).
  - **Archivo**: `src/lib/downstream-payment.ts:220` (postFacilitator)
  - **Solución**: Stream JSON OPCIONAL (backpressure handling si facilitator rate-limits)
  - **Estimación**: M
  - **Prioridad**: BAJA (optimización cosmética)

---

## E13: Security Hardening ✅ DONE (cerrado 2026-04-27..2026-06-20)

Identificados en security audit comprehensive del sprint 2026-04-27. Todos los items BLQ-ALTO y BLQ-MED fueron resueltos en HUs dedicadas (SDD-058..062, SDD-116..119).

### BLQ-ALTO (alta prioridad)
- [x] **WKH-59 (SEC-DRAIN-1)** → **DONE** (SDD-061, feat/061-wkh-59-sec-drain-1): `/gasless/transfer` permite drain del operator wallet con $1 budget — re-estimar `estimatedCostUsd` por value real, aplicar `max_spend_per_call_usd` cap. Estimación: M.
- [x] **WKH-60 (SEC-RCE-1)** → **DONE** (SDD-062, feat/062-wkh-60-sec-rce-1): L2 transform cache poisoning + `new Function()` = RCE multi-tenant — reemplazar `new Function` por `node:vm` sandbox + HMAC sobre transform_fn + `owner_ref` en cache key. Estimación: L (HU dedicada).
- [x] **WKH-SEC-02 (BLQ-ALTO-3)** → **DONE** (SDD-116/118/119, feat/116-wkh-sec-02-rls + SEC-02b + SEC-02c): Mitigation completa de RPC schema hijacking — agregar `p_owner_ref` validation dentro de `increment_a2a_key_spend` y `register_a2a_key_deposit`. Mitigation parcial (`SET search_path` + `REVOKE anon`) en PR #36. Estimación: S.

### BLQ-MED
- [x] **WKH-61 (SEC-SCOPE-1)** → **DONE** (SDD-059, feat/059-wkh-61-sec-scope-1): `requirePaymentOrA2AKey` llama `checkScoping(target={})` — feature scoping completamente broken. Mover check al servicio post-resolución del agent. Estimación: M.
- [x] **WKH-62 (SEC-SSRF-1)** → **DONE** (SDD-058, feat/058-wkh-62-sec-ssrf-1): `/discover` sin SSRF protection — aplicar `validateGatewayUrl` en `discoveryService.queryRegistry`. Estimación: S.
- [x] **WKH-63 (SEC-REG-1)** → **DONE** (SDD-060, feat/060-wkh-63-sec-reg-1): registries CRUD sin ownership — agregar columna `registries.owner_ref` + filtros. Mitigation parcial (block update/delete `wasiai`) en PR #36. Estimación: M.
- [x] **BLQ-MED-5** → **DONE** (resuelto como parte de WKH-53 ownership guards + WKH-SEC-02b) — viola convención CLAUDE.md, falta defensa en profundidad. Estimación: XS.

### BLQ-BAJO + MNR — backlog ordinario (ver sprint report)

### Tickets relacionados
- **WKH-58 (WAS-V2-3-CLIENT-3)**: facilitator HTTP 500 en `/v2/settle` — bloqueante upstream para cerrar `/compose` E2E. Estimación: depende del facilitator.

---

## E14: Hardening Refinements — POST-AUDIT 2026-05-29

Items escalados como MENORES durante WKH-AUDIT-A2A (remediación auditoría profesional, status A− → A+).

- [x] **WKH-AUDIT-MINOR-001**: Centralizar `isProduction` en `src/lib/env.ts` → **RESUELTO por WKH-098**
  - **Descripción**: `process.env.NODE_ENV === 'production'` aparece en múltiples ubicaciones (dashboard.ts, index.ts). Crear constante exportada para reducir duplicación y mejorar testability.
  - **Archivos**: `src/routes/dashboard.ts`, `src/index.ts`, (crear) `src/lib/env.ts` ✓
  - **Estimación**: S
  - **Prioridad**: BAJA (cosmética, refactor)
  - **Cierre**: feat/098-a2a-cleanup-aplus commit 75626ac

- [x] **WKH-AUDIT-MINOR-002**: Normalizar `NODE_ENV` check pattern → **RESUELTO por WKH-098**
  - **Descripción**: Código mezcla `NODE_ENV === 'production'` (afirmación) con `NODE_ENV !== 'production'` (negación). Estandarizar a un patrón y documentar en project-context + CLAUDE.md.
  - **Archivos**: CLAUDE.md, `.nexus/project-context.md`, todos archivos que verifiquen NODE_ENV ✓
  - **Estimación**: S
  - **Prioridad**: BAJA (documentación)
  - **Cierre**: `isProduction()` centralizado en `src/lib/env.ts` con normalización `.trim().toLowerCase()` (AC-4)

- [x] **WKH-CLEANUP-LINT-001**: Resolver 42 lint pre-existentes en `src/adapters/` + test files → **RESUELTO por WKH-098**
  - **Descripción**: Biome reporta 42 errores en archivos excluidos de Scope IN (test fixtures, adapters). No introducidos por WKH-AUDIT-A2A; deuda técnica pre-existente.
  - **Archivos**: `src/adapters/__tests__/`, `src/middleware/*.test.ts`, otros ✓
  - **Estimación**: M (bajo riesgo, cambios mecánicos)
  - **Prioridad**: BAJA (limpieza cosmética)
  - **Cierre**: biome check --write + noConsole directives (AC-2, feat/098-a2a-cleanup-aplus commits df79ac8 + dc41ead)

---

## E15: Pitch-prep findings — POST-HACKATHON 2026-06-14

Detectados al auditar el material del pitch (deck + flashcards) contra el código, antes del pitch Kite del 16-jun. Capturados para revisar DESPUÉS del 16. Tocan capa de pago/identidad → ruta QUALITY.

- [x] **WKH-118 (FEE-COMPOSE)**: Cobrar el protocol fee 1% también en `/compose` → **DONE** (SDD-115, feat/115-wkh-118-fee-compose, commit 78d91b9)
  - **Descripción**: Hoy `chargeProtocolFee` (1%, `src/services/fee-charge.ts`, default 0.01, gated por env `WASIAI_PROTOCOL_FEE_WALLET`) se invoca SOLO en `src/services/orchestrate.ts`. `/compose` NO cobra fee. El demo usa `/compose`, así que no genera revenue, y el deck quedó honesto en "1% por orquestación". Decisión de producto (2026-06-14, Fernando): cobrar 1% en ambos modos.
  - **Archivos**: `src/services/compose.ts` (replicar el patrón de `orchestrate.ts:~244-280`), `src/services/fee-charge.ts` (reusar `chargeProtocolFee`/`getProtocolFeeRate`), tests.
  - **Riesgo**: toca la ruta de pago del demo (débito extra). Requiere re-test E2E del demo de AgentShop antes de prod.
  - **Estimación**: M · **Prioridad**: MEDIA · **Ruta**: QUALITY (financiero)
  - **Al cerrar**: revertir el deck a "1% por cada /compose u /orchestrate".

- [ ] **WKH-119 (PASSPORT-AUTH)**: Identidad Passport-nativa end-to-end
  - **Descripción**: Hoy el Kite Agent Passport es solo *binding* (`src/services/identity.ts:bindPassport`, gated por `PASSPORT_BINDING_ENABLED=false`); NO autentica el request. La auth real corre sobre la agent-key propia + identidad ERC-8004. Activar la autenticación Passport-nativa (firma/verify) cuando Kite nos liste en su discovery (el `payment_target_forbidden` se desbloquea con el listing).
  - **Archivos**: `src/services/identity.ts`, `src/routes/auth.ts`, middleware de auth.
  - **Dependencia externa**: listing de Kite (no lo controlamos).
  - **Estimación**: L · **Prioridad**: MEDIA (desbloquea el claim "el Passport firma la identidad")

- [ ] **WKH-120 (XCHAIN-WALLETS)**: Cross-chain con destinatarios distintos (no self-transfer)
  - **Descripción**: Las 3 tx cross-chain del demo (Kite/Avalanche/Base, slide Built-on-Kite del deck) son self-transfers: `from == to == operator (0xf432baf…)`. Un jurado que clickee ve una wallet pagándose a sí misma. Regenerar con wallets de agente destino distintas (como ya hacen las 3 tx de AgentShop en Kite: `to=0x94dcdb…`).
  - **Archivos**: scripts de generación de tx demo / config de wallets de agente por red.
  - **Estimación**: S · **Prioridad**: BAJA (cosmético de evidencia; hoy mitigado con la frase "wallets de demo")

> **Nota de negocio (NO es HU de código)**: cerrar un **partner de compliance/MTL regulado** para producción con dinero real (referenciado en flashcards P44/P52). Es legal/business, no ingeniería.

---

## E16: Agent Key robustness ✅ DONE (cerrado 2026-06-19..2026-06-21)

Research en `doc/agent-key-vs-passport.md`. Todos los items WKH-121..125 entregados y mergeados. RLS Postgres-level (WKH-SEC-02/02b/02c) + escrow no-custodial (WKH-126a/b/c) también cerrados en este sprint.

- [x] **WKH-121 (KEY-SESSIONS)** → **DONE** (SDD-110, feat/110-wkh-121-key-sessions): Jerarquía de claves + session keys (user → agent → session)
  - **Gap**: hoy la Agent Key es un bearer `key_hash` único de larga vida (`src/types/a2a-key.ts`). El Passport usa 3 capas con **sesiones time-boxed** ("una sesión, una firma"), acotando el blast radius si una clave se filtra.
  - **Scope**: derivar session keys efímeras de la agent key, con TTL + cuotas propias por sesión (budget/daily scope por sesión). Tabla `a2a_key_sessions` + middleware que valide la sesión.
  - **Archivos**: `src/services/identity.ts`, `src/middleware/a2a-key.ts`, migración DB.
  - **Estimación**: L · **Prioridad**: ALTA

- [x] **WKH-122 (KEY-REVOKE)** → **DONE** (SDD-111, feat/111-wkh-122-session-revoke): Revocación granular e instantánea
  - **Gap**: hoy solo `identity.deactivate(keyId)` apaga TODA la key (todo o nada). El Passport revoca una sesión sin tocar la key del agente/usuario.
  - **Scope**: revocar por sesión/scope; lista de revocación con efecto inmediato en el middleware.
  - **Archivos**: `src/services/identity.ts`, `src/middleware/a2a-key.ts`. (Depende de WKH-121.)
  - **Estimación**: M · **Prioridad**: ALTA

- [x] **WKH-123 (KEY-SIGNED-AUTH)** → **DONE** (SDD-112, feat/112-wkh-123-signed-auth): Auth por firma / passkey en vez de bearer secreto
  - **Gap**: hoy se autentica con un secreto bearer (sha256 lookup). Si se filtra, se usa directo. El Passport aprueba sesiones con passkey/firma.
  - **Scope**: request firmado (EIP-712 o WebAuthn/passkey) — una key filtrada no es usable sin la firma. Coexiste con el bearer para back-compat.
  - **Archivos**: `src/middleware/a2a-key.ts`, `src/services/identity.ts`.
  - **Estimación**: L · **Prioridad**: ALTA

- [x] **WKH-124 (KEY-RECEIPTS)** → **DONE** (SDD-113, feat/113-wkh-124-receipts): Recibos inmutables + proof-chain (PoAI-style)
  - **Gap**: hay eventos + settlement on-chain, pero no una cadena de prueba **session → agent → user** anclada para resolución de disputas (lo que el Passport llama Proof of AI).
  - **Scope**: recibo inmutable por pago con el linaje session/agent/user, anclado on-chain o firmado; endpoint de verificación.
  - **Archivos**: `src/services/event.ts`, `src/services/fee-charge.ts` / settlement, posible attestation on-chain.
  - **Estimación**: L · **Prioridad**: MEDIA

- [x] **WKH-125 (KEY-CONSTRAINTS)** → **DONE** (SDD-114, feat/114-wkh-125-constraints; fix WKH-125b SDD-120): Constraints programables más ricas (destino + velocidad)
  - **Gap**: hoy hay `daily_limit` + `max_spend_per_call` + allowlists (qué agentes), pero no **cap por destino/vendor** ni **velocidad/ventana de tiempo** arbitraria. El Passport: "no gastar más de $50 con vendors aprobados".
  - **Scope**: políticas por destino (cap por agente/vendor) + ventanas de tiempo (no solo daily).
  - **Archivos**: `src/services/budget.ts`, `src/types/a2a-key.ts`, migración DB.
  - **Estimación**: M · **Prioridad**: MEDIA

> **Nota**: opcional, menor prioridad — **DID + auth que prueba sin revelar al usuario** (el Passport usa DIDs). Evaluar dentro de WKH-123 si aplica.

---

## E17: Post-E16 Closures ✅ DONE (2026-06-20..2026-06-22)

Items cerrados después del sprint E16, en el mismo push hacia el cierre del hackathon.

- [x] **WKH-SEC-02 (RLS Postgres-level)** → **DONE** — ENABLE ROW LEVEL SECURITY en 7 tablas con owner_ref (SDD-116, feat/116-wkh-sec-02-rls). Spinoffs: SEC-02b owner-ref en RPC `increment_a2a_key_spend` (SDD-119), SEC-02c RLS en `registries` + `kite_schema_transforms` (SDD-118).
- [x] **WKH-126a (Escrow Solidity)** → **DONE** — `WasiAIEscrow.sol` (Foundry, UUPS): deposit/debit/debitBatch/withdraw + EIP-712. Deployado en Base Sepolia + Avalanche Fuji + Kite testnet (SDD-121, feat/121-wkh-126a-escrow-contract).
- [x] **WKH-126b (Escrow TS integration)** → **DONE** — escrow-verifier + routing condicional /deposit + ABI EIP-712 + tests (SDD-117, feat/117-wkh-126-escrow-noncustodial).
- [x] **WKH-126c (Escrow per-chain routing)** → **DONE** — `escrowEnabledForChain` helper + fallback a treasury en cadenas sin contrato (SDD-122, fix/122-wkh-126c-escrow-per-chain-routing).
- [x] **WKH-118 (FEE-COMPOSE)** → **DONE** — 1% protocol fee también en /compose (SDD-115). Ver E15 arriba.

**Estado al cierre (2026-06-23)**:
- Tests: **1628 passing / 0 failing** (vitest run)
- SDDs totales: 122 (todos DONE — 0 in-progress)
- Chains live: Kite testnet + Avalanche Fuji + Base Sepolia (E2E verificado on-chain)
- Escrow no-custodial: deployado en 3 cadenas, feature-gated (`ESCROW_ENABLED=false` por defecto)

*Última actualización: 2026-06-23 (reconciliación tracking: 12 SDDs "in progress" → DONE; E13 + E16 cerrados; WKH-118/SEC-02/escrow WKH-126 DONE; 1628 tests verdes)*
