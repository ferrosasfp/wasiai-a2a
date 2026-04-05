# SDD #015: POST /orchestrate — LLM Planning + Event Tracking

> SPEC_APPROVED: no
> Fecha: 2026-04-05
> Tipo: feature
> SDD_MODE: full
> Branch: feat/015-orchestrate-llm-planning
> Artefactos: doc/sdd/015-orchestrate-llm-planning/
> WKH: WKH-13 (absorbe WKH-10)

---

## 1. Resumen

Convertir POST /orchestrate de un wrapper con planificacion greedy a un flujo inteligente con LLM planning via Claude Sonnet. El LLM analiza el goal del usuario, evalua los agentes descubiertos, y genera un plan optimo con inputs dinamicos por agente. Se agrega event tracking a nivel de orquestacion, orchestrationId para trazabilidad, protocolFeeUsdc calculado, timeout de 120s, y fallback al algoritmo greedy si el LLM falla.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 015 |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | LLM planning inteligente en /orchestrate + event tracking + response enriquecido |
| **Reglas de negocio** | 1% protocol fee (calculado, no cobrado). Timeout 120s. Fallback a greedy si LLM falla. |
| **Scope IN** | LLM planner, dynamic inputs, orchestrationId, event tracking, protocolFeeUsdc, timeout, fallback, tipos actualizados |
| **Scope OUT** | Attestation on-chain (WKH-8), streaming, retry logic, cobro real del fee, Agent Passport |
| **Missing Inputs** | N/A |

### Acceptance Criteria (EARS)

1. WHEN POST /orchestrate con `{goal, budget}`, THE sistema SHALL generar un `orchestrationId` (UUID) e invocar Claude Sonnet para analizar el goal y seleccionar agentes del discovery
2. WHEN el LLM planifica, THE sistema SHALL generar steps con inputs dinamicos por agente basandose en name+description+capabilities
3. WHEN la pipeline se completa, THE response SHALL incluir `orchestrationId`, `answer`, `reasoning`, `steps`, `totalCostUsdc`, `protocolFeeUsdc` (1% calculado), `totalLatencyMs`
4. WHEN la pipeline falla por budget o error de agente, THE sistema SHALL retornar 500 con error descriptivo y los steps completados
5. WHEN no hay agentes para el goal, THE sistema SHALL retornar 200 con `answer: null`, `reasoning: "No agents found..."`, steps vacio
6. WHEN la orquestacion se ejecuta, THE sistema SHALL trackear un evento `orchestrate_goal` en `a2a_events` con orchestrationId, goal, status, latencia total y costo total
7. WHEN el LLM planning falla (API caido, respuesta invalida), THE sistema SHALL fallback al algoritmo greedy existente y agregar warning en reasoning
8. WHEN la orquestacion excede 120s, THE sistema SHALL abortar y retornar error con los steps completados hasta ese momento

## 3. Context Map (Codebase Grounding)

### Archivos leidos
| Archivo | Por que | Patron extraido |
|---------|---------|-----------------|
| `src/services/orchestrate.ts` | Core a modificar | planPipeline greedy, estructura del service object |
| `src/routes/orchestrate.ts` | Route handler | requirePayment preHandler, catch generico |
| `src/services/compose.ts` | Pipeline executor | invokeAgent, event tracking fire-and-forget, resolveAgent |
| `src/services/llm/transform.ts` | Exemplar LLM call | Anthropic client, system/user prompt, timeout, JSON parse |
| `src/services/event.ts` | Event tracking | track() signature, EventRow->A2AEvent mapping |
| `src/services/discovery.ts` | Agent discovery | discover() returns DiscoveryResult, parallel queries |
| `src/types/index.ts` | All types | OrchestrateRequest/Result, Agent, ComposeStep |

### Exemplars
| Para crear/modificar | Seguir patron de | Razon |
|---------------------|------------------|-------|
| LLM planning en orchestrate.ts | `src/services/llm/transform.ts` | Mismo patron: Anthropic client, system prompt, JSON response, timeout |
| Event tracking orchestrate | `src/services/compose.ts:107` | Fire-and-forget con .catch() |
| Tipos nuevos | `src/types/index.ts` (seccion ORCHESTRATE) | Append al final de la seccion existente |

### Estado de BD relevante
| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| a2a_events | Si | event_type, agent_id, status, latency_ms, cost_usdc, goal, metadata |

### Componentes reutilizables encontrados
- `Anthropic` client pattern en `src/services/llm/transform.ts` -- reutilizar para LLM planning
- `eventService.track()` en `src/services/event.ts` -- usar directamente
- `discoveryService.discover()` en `src/services/discovery.ts` -- ya se usa
- `composeService.compose()` en `src/services/compose.ts` -- ya se usa
- `crypto.randomUUID()` -- para orchestrationId (Node.js built-in)

## 4. Diseno Tecnico

### 4.1 Archivos a crear/modificar

| Archivo | Accion | Descripcion | Exemplar |
|---------|--------|-------------|----------|
| `src/services/orchestrate.ts` | Modificar | Reemplazar planPipeline greedy con LLM planning, agregar orchestrationId, timeout, fallback, event tracking | `src/services/llm/transform.ts` |
| `src/routes/orchestrate.ts` | Modificar | Agregar orchestrationId al response, manejar timeout | `src/routes/compose.ts` |
| `src/types/index.ts` | Modificar | Agregar orchestrationId y protocolFeeUsdc a OrchestrateResult | Seccion ORCHESTRATE existente |
| `src/services/orchestrate.test.ts` | Crear | Tests para LLM planning, fallback, timeout, no-agents | `src/services/llm/transform.test.ts` |

### 4.2 Modelo de datos

No hay cambios de BD. Se usa `a2a_events` existente con `event_type: 'orchestrate_goal'` y `metadata: { orchestrationId }`.

### 4.3 LLM Planning -- Diseno del Prompt

**System prompt**: Experto en orquestacion de agentes IA. Dado un goal y lista de agentes disponibles (name, description, capabilities, priceUsdc), seleccionar los agentes optimos y generar un plan de ejecucion.

**User prompt**: Goal + budget + array de agentes (name, description, capabilities, priceUsdc por cada uno).

**Response esperada** (JSON):
```json
{
  "selectedAgents": [
    {
      "slug": "agent-slug",
      "registry": "registry-name",
      "input": { "query": "specific input for this agent" },
      "reasoning": "Why this agent was selected"
    }
  ],
  "reasoning": "Overall strategy explanation",
  "passOutputBetweenSteps": true
}
```

**Fallback**: Si el LLM falla (timeout, parse error, API down) -> usar el algoritmo greedy existente + `reasoning: "[FALLBACK] LLM planning failed: {error}. Using greedy selection."`.

### 4.4 Flujo principal (Happy Path)

1. Request llega a POST /orchestrate con `{goal, budget, preferCapabilities?, maxAgents?}`
2. Service genera `orchestrationId = crypto.randomUUID()`
3. Service llama `discoveryService.discover()` para obtener agentes candidatos
4. Service llama Claude Sonnet con goal + agentes -> recibe plan con agents seleccionados e inputs dinamicos
5. Service convierte el plan en `ComposeStep[]` y llama `composeService.compose()`
6. Service calcula `protocolFeeUsdc = totalCostUsdc * 0.01`
7. Service trackea evento `orchestrate_goal` en a2a_events (fire-and-forget)
8. Route retorna `{ orchestrationId, answer, reasoning, pipeline, consideredAgents, protocolFeeUsdc }`

### 4.5 Flujo de error

1. Si no hay agentes descubiertos -> 200 con answer:null, reasoning explicativo
2. Si LLM falla -> fallback a greedy, warning en reasoning
3. Si compose falla -> 500 con error detallado + steps completados
4. Si timeout 120s -> AbortController cancela, retorna steps parciales

### 4.6 Timeout -- Implementacion

Usar `AbortController` + `setTimeout(120_000)` wrapeando todo el flujo del service. El abort signal se propaga al LLM call (soportado por Anthropic SDK) y se verifica entre steps del compose.

## 5. Constraint Directives (Anti-Alucinacion)

### OBLIGATORIO seguir
- Patron de LLM call: seguir `src/services/llm/transform.ts` (Anthropic client, system/user prompt, JSON parse, timeout)
- Event tracking: seguir patron fire-and-forget de `src/services/compose.ts:107`
- Imports: solo modulos que EXISTEN -- `@anthropic-ai/sdk`, `../lib/supabase.js`, etc.
- Respuesta del LLM: parsear como JSON, validar estructura antes de usar
- `orchestrationId`: usar `crypto.randomUUID()` (Node.js built-in, no uuid package)

### PROHIBIDO
- NO agregar dependencias nuevas (Anthropic SDK ya esta en package.json)
- NO crear archivos fuera de los listados en 4.1
- NO modificar compose.ts ni discovery.ts ni event.ts
- NO hardcodear el model ID -- usar constante `MODEL` como en transform.ts
- NO hacer el LLM call sin timeout (max 30s para LLM, 120s total)
- NO cobrar el protocolFeeUsdc -- solo calcular
- NO implementar attestation (scope de WKH-8)
- NO bloquear el pipeline con event tracking -- siempre fire-and-forget

## 6. Scope

**IN:**
- LLM-based planPipeline con Claude Sonnet
- Inputs dinamicos por agente generados por LLM
- orchestrationId (UUID) en request y response
- protocolFeeUsdc calculado (1% del totalCostUsdc)
- Event tracking `orchestrate_goal` en a2a_events
- Timeout 120s con AbortController
- Fallback a greedy si LLM falla
- Tipos actualizados en types/index.ts
- Tests unitarios

**OUT:**
- Attestation on-chain (WKH-8)
- Streaming response
- Retry logic en caso de fallo de agente
- Cobro real del protocol fee
- Cache de planes de orquestacion
- Modificar compose, discovery o event services

## 7. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigacion |
|--------|-------------|---------|------------|
| LLM devuelve JSON invalido | M | M | Parse con try/catch + fallback a greedy |
| LLM selecciona agentes que no existen | B | A | Validar slugs contra lista de discovered agents |
| Timeout 120s insuficiente para pipelines grandes | B | M | Configurable via env var si necesario |
| ANTHROPIC_API_KEY no configurado | B | A | Check al inicio del planning, fallback inmediato |

## 8. Dependencias

- `@anthropic-ai/sdk` -- ya en package.json
- `ANTHROPIC_API_KEY` -- ya en .env
- `a2a_events` tabla -- ya existe (WKH-27)
- `discoveryService`, `composeService`, `eventService` -- ya existen

## 9. Missing Inputs

N/A -- todo disponible.

## 10. Uncertainty Markers

| Marker | Seccion | Descripcion | Bloqueante? |
|--------|---------|-------------|-------------|
| [TBD] | 4.3 | Prompt exacto del LLM se refinara durante implementacion | No |

> Sin markers bloqueantes.

---

*SDD generado por NexusAgil -- FULL*
