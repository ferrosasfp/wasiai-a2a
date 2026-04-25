# BACKLOG — WasiAI A2A Protocol

## Épicas

### E1: Core Infrastructure
Setup básico del servicio con Fastify, PostgreSQL, Redis.

- [ ] HU-001: Setup Fastify + health endpoint
- [ ] HU-002: PostgreSQL + migrations setup
- [ ] HU-003: Redis + BullMQ setup

### E2: Registry Management
CRUD de marketplaces que se pueden consultar.

- [ ] HU-010: POST /registries — registrar marketplace
- [ ] HU-011: GET /registries — listar marketplaces
- [ ] HU-012: DELETE /registries/:id — eliminar
- [ ] HU-013: WasiAI pre-registrado por defecto

### E3: Discovery
Búsqueda multi-registry de agentes.

- [ ] HU-020: POST /discover — búsqueda básica
- [ ] HU-021: Discovery con filtros (category, capability)
- [ ] HU-022: Ranking/scoring de resultados

### E4: Agent Cards (A2A Protocol)
Generación de Agent Cards según estándar Google A2A.

- [ ] HU-030: GET /agents/:id/agent-card
- [ ] HU-031: Schema validation
- [ ] HU-032: Skills mapping

### E5: Compose (Pipelines)
Ejecución de pipelines multi-agente.

- [ ] HU-040: POST /compose — pipeline básico
- [ ] HU-041: Transform entre agentes (LLM)
- [ ] HU-042: Error handling y rollback

### E6: Orchestrate (Goal-based)
LLM decide qué agentes usar.

- [ ] HU-050: POST /orchestrate — goal parsing
- [ ] HU-051: Agent selection logic
- [ ] HU-052: Pipeline generation

### E7: A2A JSON-RPC
Implementación del protocolo A2A de Google.

- [ ] HU-060: message/send
- [ ] HU-061: message/stream (SSE)
- [ ] HU-062: task/get, task/list
- [ ] HU-063: task/cancel
- [ ] HU-064: task/subscribe

### E8: Kite Integration
Pagos y attestations en Kite.

- [ ] HU-070: x402 payment flow
- [ ] HU-071: Agent Passport verification
- [ ] HU-072: 1% protocol fee

### E9: Schema Inference
LLM inference para marketplaces sin A2A.

- [ ] HU-080: Inferir schemas de responses
- [ ] HU-081: Cache de schemas inferidos
- [ ] HU-082: Transform caching

---

## Prioridad Hackathon (6 mayo deadline)

**Must have:**
- E1 (Infrastructure) — sin esto no hay nada
- E2 (Registries) — necesario para multi-marketplace
- E3 (Discovery) — el core del producto
- E5 (Compose) — demo de pipelines
- E8 (Kite) — requisito del hackathon

**Nice to have:**
- E4 (Agent Cards) — standard compliance
- E6 (Orchestrate) — diferenciador
- E7 (A2A JSON-RPC) — full protocol
- E9 (Schema Inference) — interop avanzada

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

### E12: WKH-55 Technical Debt (Post-DONE)

**TD-WKH-55-LIGHT** — Sugerencias CR + upgrade arquitectónico menor. NO bloquea producción.

- [ ] **TD-WKH-55-1**: Race condition balance/settle (AR-MNR-2)
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

*Última actualización: 2026-04-24*
