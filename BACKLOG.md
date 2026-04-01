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

*Última actualización: 2026-03-31*
