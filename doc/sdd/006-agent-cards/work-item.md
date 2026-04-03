# WKH-15 — Agent Cards (Google A2A spec)

> **SDD:** 006 | **Fecha:** 2026-04-03 | **Talla:** S-M | **Branch:** `feat/wkh-15-agent-cards`

---

## Descripción

Endpoint `GET /agents/:id/agent-card` que genera un Agent Card JSON conforme al estándar Google A2A Protocol para cualquier agente descubierto via los registries. El endpoint reutiliza `discoveryService.getAgent()` para resolver el agente y luego transforma el tipo `Agent` interno al schema A2A `AgentCard`.

Adicionalmente, el gateway expone su propio Agent Card en `GET /.well-known/agent.json` conforme al requerimiento del A2A spec para que el servicio sea descubrible como agente A2A.

> **Nota:** El parámetro `:id` en la ruta se resuelve como **slug** (no UUID). `discoveryService.getAgent()` busca por slug.

---

## A2A Spec Coverage (v1)

Campos del Agent Card spec que implementamos vs. los que diferimos:

| Campo | ¿Implementado? | Notas |
|-------|:-:|-------|
| `name` | ✅ | |
| `description` | ✅ | |
| `url` | ✅ | |
| `capabilities` | ✅ | `streaming`, `pushNotifications` (ambos `false` en v1) |
| `skills` | ✅ | Mapeados desde `agent.capabilities[]` |
| `inputModes` | ✅ | `["text/plain"]` default |
| `outputModes` | ✅ | `["text/plain"]` default |
| `authentication` | ✅ | Schemes dinámicos según `registry.auth.type` |
| `provider` | ❌ | Diferido a v2 |
| `version` | ❌ | Diferido a v2 |
| `defaultInputModes` / distinción con `inputModes` | ❌ | En v1 usamos solo `inputModes` |

---

## Acceptance Criteria (EARS)

| # | Tipo | Criterio |
|---|------|----------|
| AC-1 | WHEN | WHEN un cliente hace `GET /agents/:id/agent-card` con un slug válido, THEN el sistema retorna HTTP 200 con un JSON conforme al subset documentado del schema Agent Card de Google A2A (ver tabla "A2A Spec Coverage") |
| AC-2 | WHEN | WHEN el agente no existe en ningún registry, THEN el sistema retorna HTTP 404 con `{ "error": "Agent not found" }` |
| AC-3 | IF | IF el agente tiene capabilities, THEN se mapean a `skills[]` con `id`, `name` y `description` |
| AC-4 | WHEN | WHEN se genera el Agent Card, THEN incluye `capabilities.streaming: false`, `capabilities.pushNotifications: false` (valores por defecto, no soportados aún) |
| AC-5 | WHEN | WHEN se genera el Agent Card, THEN `authentication.schemes` se deriva dinámicamente del `registry.auth.type` del agente: `'bearer'` → `["bearer"]`, `'header'` → `["apiKey"]`, Kite/x402 → `["x402"]`, sin auth → `[]` |
| AC-6 | IF | IF el query param `?registry=<id>` está presente, THEN la búsqueda se filtra a ese registry |
| AC-7 | WHEN | WHEN un cliente hace `GET /.well-known/agent.json`, THEN el sistema retorna HTTP 200 con el Agent Card del propio gateway WasiAI A2A (name="WasiAI A2A Gateway", skills: discover/compose/orchestrate) |

---

## Scope

### IN
- Tipo `AgentCard` en `src/types/index.ts`
- Servicio `src/services/agent-card.ts` con función `buildAgentCard(agent: Agent, registryConfig: RegistryConfig, baseUrl: string): AgentCard`
- Función `buildSelfAgentCard(baseUrl: string): AgentCard` para el gateway self-card
- Ruta `GET /agents/:id/agent-card` en nueva ruta `src/routes/agent-card.ts`
- Ruta `GET /.well-known/agent.json` en `src/index.ts` o `src/routes/well-known.ts`
- Registro de las rutas en `src/index.ts`
- Helper `resolveAuthSchemes(registryConfig): string[]` en el servicio
- Test unitario para `buildAgentCard` y `buildSelfAgentCard`
- Test de integración para ambos endpoints

### OUT
- Streaming / push notifications (futuro)
- Persistencia de Agent Cards en DB (se generan on-the-fly)
- Autenticación del endpoint (público por ahora)
- Campos `provider`, `version`, `defaultInputModes` del A2A spec (v2)

---

## Diseño técnico

### Tipo AgentCard (`src/types/index.ts`)
```typescript
export interface AgentCard {
  name: string
  description: string
  url: string
  capabilities: {
    streaming: boolean
    pushNotifications: boolean
  }
  skills: AgentSkill[]
  inputModes: string[]
  outputModes: string[]
  authentication: {
    schemes: string[]
  }
}

export interface AgentSkill {
  id: string
  name: string
  description: string
}
```

### Auth Scheme Resolution

```typescript
function resolveAuthSchemes(registryConfig: RegistryConfig): string[] {
  if (!registryConfig.auth?.type) return []

  switch (registryConfig.auth.type) {
    case 'bearer': return ['bearer']
    case 'header': return ['apiKey']
    default: break
  }

  // Kite registries or explicit x402
  if (registryConfig.type === 'kite' || registryConfig.auth.type === 'x402') {
    return ['x402']
  }

  return []
}
```

### Servicio (`src/services/agent-card.ts`)
- `buildAgentCard(agent: Agent, registryConfig: RegistryConfig, baseUrl: string): AgentCard`
  - Mapea `agent.capabilities[]` → `skills[]`
  - URL: `${baseUrl}/agents/${agent.slug}`
  - Defaults: streaming=false, pushNotifications=false
  - Auth: `resolveAuthSchemes(registryConfig)` (dinámico, NO hardcoded)
- `buildSelfAgentCard(baseUrl: string): AgentCard`
  - name: `"WasiAI A2A Gateway"`
  - description: `"A2A-compliant gateway that discovers, composes, and orchestrates AI agents from multiple registries"`
  - url: `baseUrl`
  - capabilities: `{ streaming: false, pushNotifications: false }`
  - skills: `[{ id: "discover", name: "Discover Agents", description: "..." }, { id: "compose", name: "Compose Agents", description: "..." }, { id: "orchestrate", name: "Orchestrate Agents", description: "..." }]`
  - authentication: `{ schemes: [] }` (gateway endpoints son públicos)

### Ruta agent-card (`src/routes/agent-card.ts`)
- Patrón idéntico a `discover.ts`: `FastifyPluginAsync`, export default
- Reutiliza `discoveryService.getAgent(id, registry)` — nota: `id` es **slug**
- Necesita acceso al registry config para pasar a `buildAgentCard`
- Registrada como `fastify.register(agentCardRoutes, { prefix: '/agents' })`

### Ruta well-known (`src/routes/well-known.ts` o inline en `src/index.ts`)
- `GET /.well-known/agent.json` → `buildSelfAgentCard(baseUrl)`
- Registrada en el root sin prefijo

---

## Dependencias

| Tipo | Dependencia | Estado |
|------|-------------|--------|
| Interna | `discoveryService.getAgent()` | ✅ Existe |
| Interna | Tipo `Agent` | ✅ Existe |
| Interna | Registry config (para auth.type) | ✅ Existe en config |
| Infra | Ninguna nueva | — |

---

## DoR Checklist

- [x] ACs definidos en formato EARS
- [x] Scope IN/OUT claro
- [x] Diseño técnico con tipos y estructura
- [x] Dependencias identificadas
- [x] Sin bloqueos técnicos
- [x] Branch sugerido
- [x] A2A spec coverage documentado

---

## Sizing: **S-M** (Small-Medium)

| Factor | Valor | Razón |
|--------|-------|-------|
| Archivos nuevos | 3 | `agent-card.ts` (servicio), `agent-card.ts` (ruta), `well-known.ts` (ruta) |
| Archivos modificados | 2 | `types/index.ts`, `index.ts` |
| Complejidad | Baja-Media | Mapeo Agent → AgentCard + auth dinámica + self-card |
| Riesgo | Bajo | Reutiliza discovery existente |
| Tests | 3-4 | unit buildAgentCard, unit resolveAuthSchemes, unit buildSelfAgentCard, integration endpoints |
| Estimación | ~3h | |

---

## Waves (paralelismo)

| Wave | Tareas | Paralelo |
|------|--------|----------|
| W1 | Tipos `AgentCard` + `AgentSkill` en `types/index.ts` | — |
| W2 | Servicio `agent-card.ts` (`buildAgentCard` + `resolveAuthSchemes` + `buildSelfAgentCard`) + tests unitarios | Simultáneo |
| W3 | Rutas `agent-card.ts` + `well-known.ts` + registro en `index.ts` + tests integración | Después de W2 |

---

## Branch

```
feat/wkh-15-agent-cards
```

---

## Notas

- El _INDEX.md muestra que el siguiente SDD es 005 (hay gap — 005 puede estar reservado para otra HU). Este SDD se numera como 006 según instrucción del orquestador.
- `project-context.md` ya lista `GET /agents/:id/agent-card` como endpoint planificado y `src/services/agent-card.ts` como archivo esperado.
- El parámetro `:id` se trata como **slug** en todas las rutas. `discoveryService.getAgent()` resuelve por slug, no por UUID.
