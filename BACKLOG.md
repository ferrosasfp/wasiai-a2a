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

## E13: Security Hardening — POST-SPRINT 2026-04-27

Identificados en security audit comprehensive del sprint 2026-04-27. Mitigations parciales aplicadas en PR #36 (3 hot-fixes), pendientes mitigations completas en HUs dedicadas.

### BLQ-ALTO (alta prioridad)
- [ ] **WKH-59 (SEC-DRAIN-1)**: `/gasless/transfer` permite drain del operator wallet con $1 budget — re-estimar `estimatedCostUsd` por value real, aplicar `max_spend_per_call_usd` cap. Estimación: M.
- [ ] **WKH-60 (SEC-RCE-1)**: L2 transform cache poisoning + `new Function()` = RCE multi-tenant — reemplazar `new Function` por `node:vm` sandbox + HMAC sobre transform_fn + `owner_ref` en cache key. Estimación: L (HU dedicada).
- [ ] **WKH-SEC-02 (BLQ-ALTO-3 partial)**: Mitigation completa de RPC schema hijacking — agregar `p_owner_ref` validation dentro de `increment_a2a_key_spend` y `register_a2a_key_deposit`. Mitigation parcial (`SET search_path` + `REVOKE anon`) en PR #36. Estimación: S.

### BLQ-MED
- [ ] **WKH-61 (SEC-SCOPE-1)**: `requirePaymentOrA2AKey` llama `checkScoping(target={})` — feature scoping completamente broken. Mover check al servicio post-resolución del agent. Estimación: M.
- [ ] **WKH-62 (SEC-SSRF-1)**: `/discover` sin SSRF protection — aplicar `validateGatewayUrl` en `discoveryService.queryRegistry`. Estimación: S.
- [ ] **WKH-63 (SEC-REG-1)**: registries CRUD sin ownership — agregar columna `registries.owner_ref` + filtros. Mitigation parcial (block update/delete `wasiai`) en PR #36. Estimación: M.
- [ ] **BLQ-MED-5** (sin Jira aún): `budgetService.debit` sin `ownerId` — viola convención CLAUDE.md, falta defensa en profundidad. Estimación: XS.

### BLQ-BAJO + MNR — backlog ordinario (ver sprint report)

### Tickets relacionados
- **WKH-58 (WAS-V2-3-CLIENT-3)**: facilitator HTTP 500 en `/v2/settle` — bloqueante upstream para cerrar `/compose` E2E. Estimación: depende del facilitator.

---

*Última actualización: 2026-04-27 (sprint security audit + hackathon close)*
