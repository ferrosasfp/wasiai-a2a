# WasiAI A2A Protocol — Project Context

> Este archivo es cargado por los agentes NexusAgil antes de operar.
> Contiene las reglas críticas, patrones y contexto que cualquier IA necesita para trabajar correctamente en este proyecto.

---

## Qué es WasiAI A2A Protocol

Servicio de discovery, composición y orquestación de agentes autónomos. Implementa Google A2A Protocol (estándar abierto, 50+ partners) como capa de interoperabilidad entre marketplaces de agentes.

**Posicionamiento:** WasiAI A2A es el protocolo de discovery y orquestación — la capa que falta para que los agentes en cualquier marketplace se encuentren, compongan y paguen solos. Zero human in the loop.

**Repo:** github.com/ferrosasfp/wasiai-a2a
**Puerto:** 3001 (default)
**Stack:** Fastify + Supabase PostgreSQL + Redis + BullMQ + Claude Sonnet + TypeScript

---

## Arquitectura

```
Agentes Autónomos (cualquier framework)
    ↓ A2A Protocol (Google standard)
WasiAI A2A Gateway (ESTE SERVICIO)
  Endpoints:
  - POST /registries → Registrar marketplaces
  - POST /discover → Buscar en todos los registrados
  - POST /compose → Pipelines multi-agente
  - POST /orchestrate → Goal-based con LLM
  - GET /agents/:id/agent-card → A2A Agent Card JSON
  Features:
  - Agent Cards automáticos
  - Schema inference (LLM para marketplaces sin A2A)
  - Transform caching
  - Tasks + Streaming + Push Notifications (A2A standard)
    ↓
WasiAI Registry + Kite Registry + Otros
    ↓
Kite L1 (x402 + Agent Passport)
```

---

## Relación con otros proyectos

| Proyecto | Relación |
|----------|----------|
| **wasiai-v2** | Marketplace que consume este servicio. También es un registry. |
| **Kite marketplace** | Otro registry potencial (cuando tenga API pública) |
| **Otros marketplaces** | Pueden registrarse via POST /registries |

---

## Golden Path — Stack inmutable

### Backend
- **Framework:** Fastify — el más rápido en Node.js, listo para escala
- **DB:** Supabase PostgreSQL (`bdwvrwzvsldephfibmuu`) — compartido con wasiai-v2 dev, tablas con prefijo `a2a_`
- **Queue:** Redis + BullMQ — pipelines async, no bloquear requests
- **Cache:** Redis — cache de discovery, schemas inferidos, transformaciones
- **LLM:** Claude Sonnet (`claude-sonnet-4-20250514`) — transform y orchestrate
- **Protocol:** Google A2A (JSON-RPC 2.0) — estándar abierto
- **Runtime:** Node.js 20+
- **Lenguaje:** TypeScript strict — sin `any` explícito en producción
- **Tests:** vitest
- **Lint:** eslint

### Blockchain (Kite)
- **Network:** Kite Testnet (Chain ID 2368) → Mainnet (2366) para producción
- **RPC Testnet:** https://rpc-testnet.gokite.ai/
- **RPC Mainnet:** https://rpc.gokite.ai/
- **Explorer Testnet:** https://testnet.kitescan.ai/
- **Explorer Mainnet:** https://kitescan.ai/
- **Identity:** Kite Passport (ERC-8004)
- **Payments:** x402 HTTP-native micropayments
- **Lib:** viem v2 — **PROHIBIDO ethers.js**

---

## Reglas absolutas (nunca violar)

1. **Sin hardcodes** — URLs, keys, endpoints siempre desde env vars
2. **Sin datos simulados en producción** — métricas, calls siempre reales o cero
3. **Sin secrets en código** — todo desde variables de entorno
4. **Sin ethers.js** — viem en todo el codebase
5. **JSON-RPC 2.0** para métodos A2A (message/send, task/get, etc.)
6. **REST** para endpoints administrativos (/registries, /health)
7. **Puerto 3001** — evitar conflicto con Next.js (3000)
8. **TypeScript strict** — no `any`, no `as unknown`
9. **Tests obligatorios** — cada endpoint tiene al menos 1 test
10. **Push siempre:** `git push origin main`

---

## Google A2A Protocol — Referencia rápida

### Operaciones core (JSON-RPC)
| Método | Descripción |
|--------|-------------|
| `message/send` | Enviar mensaje a agente, retorna Task o Message |
| `message/stream` | Igual pero con streaming SSE |
| `task/get` | Obtener estado de task |
| `task/list` | Listar tasks con filtros |
| `task/cancel` | Cancelar task |
| `task/subscribe` | Suscribirse a updates de task |

### Agent Card (JSON)
```json
{
  "name": "Agent Name",
  "description": "What the agent does",
  "url": "https://a2a.wasiai.io/agents/my-agent",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true
  },
  "skills": [
    { "id": "skill-1", "name": "Skill Name", "description": "..." }
  ],
  "inputModes": ["text", "data"],
  "outputModes": ["text", "data"],
  "authentication": {
    "schemes": ["bearer", "x402"]
  }
}
```

### Task States
- `submitted` → `working` → `completed` | `failed` | `canceled`
- `input-required` (human-in-the-loop)

---

## Estructura de directorios

```
wasiai-a2a/
├── src/
│   ├── index.ts              ← Entry point, Fastify server
│   ├── types/
│   │   └── index.ts          ← A2A types, Task, Message, Part, etc.
│   ├── routes/
│   │   ├── registries.ts     ← CRUD de marketplaces
│   │   ├── discover.ts       ← Discovery multi-registry
│   │   ├── compose.ts        ← Pipelines multi-agente
│   │   ├── orchestrate.ts    ← Goal-based con LLM
│   │   └── a2a/              ← JSON-RPC endpoints A2A
│   │       ├── message.ts
│   │       └── task.ts
│   ├── services/
│   │   ├── registry.ts       ← Registry management
│   │   ├── discovery.ts      ← Multi-registry discovery
│   │   ├── compose.ts        ← Pipeline execution
│   │   ├── orchestrate.ts    ← LLM-based orchestration
│   │   ├── transform.ts      ← Schema transformation (LLM)
│   │   └── agent-card.ts     ← Agent Card generation
│   └── lib/
│       ├── db.ts             ← PostgreSQL client
│       ├── redis.ts          ← Redis client
│       ├── queue.ts          ← BullMQ setup
│       └── viem.ts           ← Kite chain client
├── test/
│   └── ...
├── .nexus/                   ← Artefactos NexusAgil
│   ├── project-context.md    ← ESTE ARCHIVO
│   └── ...
├── .agent/skills/nexus-agile/ ← Metodología
├── doc/sdd/                   ← SDDs por HU
│   └── _INDEX.md
├── package.json
├── tsconfig.json
└── CLAUDE.md
```

---

## Endpoints principales

| Method | Endpoint | Descripción |
|--------|----------|-------------|
| `POST` | `/registries` | Registrar marketplace |
| `GET` | `/registries` | Listar marketplaces registrados |
| `DELETE` | `/registries/:id` | Eliminar marketplace |
| `POST` | `/discover` | Discovery multi-registry |
| `POST` | `/compose` | Pipeline multi-agente |
| `POST` | `/orchestrate` | Goal-based (LLM decide agentes) |
| `GET` | `/agents/:id/agent-card` | Agent Card A2A JSON |
| `POST` | `/a2a` | JSON-RPC 2.0 endpoint (A2A methods) |
| `GET` | `/health` | Health check |

---

## Interoperabilidad con marketplaces

### Niveles de soporte A2A
```typescript
type A2ASupport = 'full' | 'partial' | 'none'

interface RegistryConfig {
  name: string
  discoveryEndpoint: string
  invokeEndpoint: string
  a2aSupport: A2ASupport
  // Si no tiene A2A:
  defaultInputSchema?: JSONSchema
  defaultOutputSchema?: JSONSchema
  inferSchemas?: boolean  // LLM inference
}
```

### Estrategia por marketplace
| Marketplace | A2A Support | Estrategia |
|-------------|-------------|------------|
| WasiAI | full | Agent Cards nativos |
| Kite | none (hoy) | LLM inference + cache |
| Nuevo con A2A | full | Interoperabilidad automática |
| Nuevo sin A2A | none | Config manual o inference |

---

## Transformación de datos entre agentes

```
Agente A (output)
    ↓
WasiAI A2A Gateway:
  1. Lee outputSchema de A (Agent Card)
  2. Lee inputSchema de B (Agent Card)
  3. ¿Compatible? → Pasa directo (0 costo)
  4. ¿Incompatible? → LLM transforma
  5. Cachea transformación para próximas
    ↓
Agente B (input adaptado)
```

---

## Business Model

| Revenue Stream | Cómo funciona |
|----------------|---------------|
| 1% protocol fee | Por cada compose/orchestrate |
| Discovery premium | Features avanzados |
| B2B licensing | Otros marketplaces integran |

---

## Variables de entorno requeridas

```bash
# Server
PORT=3001
NODE_ENV=development|production

# Supabase (compartido con wasiai-v2 dev)
SUPABASE_URL=https://bdwvrwzvsldephfibmuu.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
DATABASE_URL=postgresql://postgres:[pwd]@db.bdwvrwzvsldephfibmuu.supabase.co:5432/postgres

# Redis
REDIS_URL=redis://...

# LLM (Claude Sonnet via Anthropic)
ANTHROPIC_API_KEY=...  # Mismo token de OpenClaw

# Kite (blockchain)
KITE_RPC_URL=https://rpc-testnet.gokite.ai/
KITE_CHAIN_ID=2368
OPERATOR_PRIVATE_KEY=0x...

# WasiAI Registry (pre-registrado)
WASIAI_API_URL=https://app.wasiai.io/api/v1
WASIAI_API_KEY=wasi_...
```

---

## Hackathon Kite — Timeline

| Fecha | Entregable |
|-------|------------|
| 6 abril | Milestone: proyecto + equipo + idea ✅ |
| 7-20 abril | Desarrollo core + integración Kite |
| 21-30 abril | Demo E2E funcionando |
| 6 mayo | Finale: presentación |

---

## Tablas DB (prefijo a2a_)

```sql
-- Registries (marketplaces registrados)
a2a_registries (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  discovery_endpoint TEXT,
  invoke_endpoint TEXT,
  a2a_support TEXT DEFAULT 'none',  -- 'full' | 'partial' | 'none'
  default_input_schema JSONB,
  default_output_schema JSONB,
  infer_schemas BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
)

-- Tasks (A2A standard)
a2a_tasks (
  id UUID PRIMARY KEY,
  context_id TEXT,
  status TEXT DEFAULT 'submitted',  -- submitted|working|completed|failed|canceled
  messages JSONB DEFAULT '[]',
  artifacts JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
)

-- Transform cache (schemas inferidos/transformaciones)
a2a_transform_cache (
  id UUID PRIMARY KEY,
  source_schema_hash TEXT NOT NULL,
  target_schema_hash TEXT NOT NULL,
  transform_template JSONB NOT NULL,
  hit_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
)
```

---

## Deuda técnica conocida

| # | Deuda | Impacto | Estado |
|---|-------|---------|--------|
| 1 | Discovery sin API Kite | No podemos descubrir en Kite | Bloqueado por Kite |
| 2 | Pagos no implementados | No cobra 1% fee | Pendiente integración x402 |

---

*Última actualización: 2026-03-31 | Versión: 0.1.0*
