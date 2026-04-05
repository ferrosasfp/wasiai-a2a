# Story File — #015: POST /orchestrate — LLM Planning

> SDD: doc/sdd/015-orchestrate-llm-planning/sdd.md
> Fecha: 2026-04-05
> Branch: feat/015-orchestrate-llm-planning

---

## Goal

Convertir POST /orchestrate de un wrapper greedy a un flujo inteligente con LLM planning via Claude Sonnet. El LLM analiza el goal, selecciona agentes optimos, genera inputs dinamicos. Se agrega orchestrationId, protocolFeeUsdc, event tracking, timeout LLM 30s con fallback a greedy.

## Acceptance Criteria (EARS)

1. WHEN POST /orchestrate con `{goal, budget}`, THE sistema SHALL generar un `orchestrationId` (UUID) e invocar Claude Sonnet para analizar el goal y seleccionar agentes del discovery
2. WHEN el LLM planifica, THE sistema SHALL generar steps con inputs dinamicos por agente basandose en name+description+capabilities
3. WHEN la pipeline se completa, THE response SHALL incluir `orchestrationId`, `answer`, `reasoning`, `steps`, `totalCostUsdc`, `protocolFeeUsdc` (1% calculado), `totalLatencyMs`
4. WHEN la pipeline falla por budget o error de agente, THE sistema SHALL retornar 500 con error descriptivo y los steps completados
5. WHEN no hay agentes para el goal, THE sistema SHALL retornar 200 con `answer: null`, `reasoning: "No agents found..."`, steps vacio
6. WHEN la orquestacion se ejecuta, THE sistema SHALL trackear un evento `orchestrate_goal` en `a2a_events` con orchestrationId, goal, status, latencia total y costo total
7. WHEN el LLM planning falla (API caido, respuesta invalida), THE sistema SHALL fallback al algoritmo greedy existente y agregar warning en reasoning
8. WHEN la llamada al LLM planning excede 30s, THE sistema SHALL abortar el planning, fallback a greedy, y continuar con compose. Si discovery + planning ya tomaron >90s, retornar error sin ejecutar compose.

## Files to Modify/Create

| # | Archivo | Accion | Que hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/types/index.ts` | Modificar | Agregar orchestrationId y protocolFeeUsdc a OrchestrateResult, agregar attestationTxHash opcional | Seccion ORCHESTRATE existente |
| 2 | `src/services/orchestrate.ts` | Modificar | Reemplazar planPipeline con LLM planning, agregar timeout 30s, fallback greedy, slug validation, event tracking | `src/services/llm/transform.ts` |
| 3 | `src/routes/orchestrate.ts` | Modificar | Generar orchestrationId en route (no service), pasar al service, agregar al response | `src/routes/compose.ts` |
| 4 | `src/services/orchestrate.test.ts` | Crear | Tests: LLM happy path, fallback, no-agents 200, slug validation, timeout | `src/services/compose.test.ts` |

## Exemplars

### Exemplar 1: LLM call pattern
**Archivo**: `src/services/llm/transform.ts`
**Usar para**: LLM planning en orchestrate.ts
**Patron clave**:
- `import Anthropic from '@anthropic-ai/sdk'`
- `const MODEL = 'claude-sonnet-4-20250514'`
- `const TIMEOUT_MS = 30_000`
- `const client = new Anthropic({ apiKey })`
- AbortController + setTimeout para timeout
- `client.messages.create({ model, max_tokens, system, messages }, { signal })`
- Parse JSON del response text, validar estructura
- try/finally con clearTimeout

### Exemplar 2: Event tracking fire-and-forget
**Archivo**: `src/services/compose.ts` (linea 107)
**Usar para**: Event tracking en orchestrate.ts
**Patron clave**:
- `eventService.track({...}).catch(err => console.error(...))`
- Nunca await — fire-and-forget
- Campos: eventType, agentId, status, latencyMs, costUsdc, goal, metadata

### Exemplar 3: Test mocks
**Archivo**: `src/services/compose.test.ts`
**Usar para**: orchestrate.test.ts
**Patron clave**:
- `vi.mock('./discovery.js', () => ({ discoveryService: { discover: vi.fn() } }))`
- `vi.mock('./compose.js', ...)`
- `beforeEach(() => vi.clearAllMocks())`
- `describe/it/expect` de vitest

## Contrato de Integracion - BLOQUEANTE

### Route -> Service

**Request (route genera orchestrationId, pasa al service):**
```typescript
orchestrateService.orchestrate({
  goal: string,
  budget: number,
  preferCapabilities?: string[],
  maxAgents?: number,
}, orchestrationId: string): Promise<OrchestrateResult>
```

**Response exitoso:**
```typescript
{
  orchestrationId: string,
  answer: unknown,
  reasoning: string,
  pipeline: ComposeResult,
  consideredAgents: Agent[],
  protocolFeeUsdc: number,
  attestationTxHash?: string  // undefined hasta WKH-8
}
```

**Errores:**
| Caso | Comportamiento |
|---|---|
| No agents found | Return OrchestrateResult con answer:null, reasoning explicativo, pipeline vacio |
| LLM falla | Fallback greedy, warning en reasoning, pipeline normal |
| Compose falla | Throw Error (route retorna 500) |
| Discovery+planning >90s | Throw Error timeout |

### Service -> LLM (Anthropic)

**Prompt input:** goal + budget + max 10 agentes (slug, registry, name, description, capabilities, priceUsdc)

**LLM response (JSON):**
```json
{
  "selectedAgents": [
    { "slug": "x", "registry": "y", "input": { "query": "..." }, "reasoning": "..." }
  ],
  "reasoning": "Overall strategy..."
}
```

**Validation post-LLM:**
1. Parse JSON (falla -> fallback greedy)
2. Validar selectedAgents es array no vacio (vacio -> fallback greedy)
3. Filtrar slugs contra discovered agents (slug no existe -> descartar)
4. Si todos descartados -> fallback greedy
5. Verificar sum(priceUsdc) <= budget (excede -> truncar)

## Constraint Directives

### OBLIGATORIO
- Patron LLM: seguir `src/services/llm/transform.ts` exactamente
- Event tracking: fire-and-forget con .catch()
- orchestrationId: `crypto.randomUUID()` en route handler
- Slug validation: filtrar plan LLM contra discovered agents
- passOutput: true para index > 0, false para index 0
- agentId: null en evento orchestrate_goal (no hay single agent)
- Max 10 agentes en prompt LLM (limitar discovered.agents.slice(0, 10))

### PROHIBIDO
- NO agregar dependencias nuevas
- NO modificar compose.ts, discovery.ts, event.ts
- NO hardcodear model ID — usar constante MODEL
- NO hacer LLM call sin timeout (30s max)
- NO cobrar protocolFeeUsdc — solo calcular
- NO implementar attestation (WKH-8)
- NO bloquear pipeline con event tracking
- NO usar uuid package — usar crypto.randomUUID()

## Test Expectations

| Test | ACs que cubre | Framework | Tipo |
|------|--------------|-----------|------|
| `src/services/orchestrate.test.ts` | AC1-AC8 | vitest | unit |

### Tests requeridos:
1. T-1: LLM happy path — mock LLM response, verify steps tienen inputs dinamicos (AC1, AC2)
2. T-2: Response incluye orchestrationId + protocolFeeUsdc (AC3)
3. T-3: No agents found retorna 200 con answer:null (AC5)
4. T-4: LLM falla -> fallback greedy con warning (AC7)
5. T-5: LLM devuelve slug invalido -> descarta y usa validos (slug validation)
6. T-6: Event tracking llamado con orchestrate_goal (AC6)
7. T-7: protocolFeeUsdc = totalCostUsdc * 0.01 (AC3)

### Criterio Test-First: Si — logica de negocio

## Waves

### Wave -1: Environment Gate

```bash
# Verificar ANTHROPIC_API_KEY disponible
echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:+SET}" 2>/dev/null || true

# Verificar archivos base existen
ls src/services/orchestrate.ts src/routes/orchestrate.ts src/types/index.ts src/services/llm/transform.ts

# Verificar dependencia
grep anthropic package.json
```

### Wave 0 (Serial Gate)
- [ ] W0.1: Actualizar tipos en `src/types/index.ts` — agregar orchestrationId, protocolFeeUsdc, attestationTxHash? a OrchestrateResult

### Wave 1 (Core — secuencial por dependencia)
- [ ] W1.1: Crear tests `src/services/orchestrate.test.ts` (test-first) -> Exemplar 3
- [ ] W1.2: Reescribir `src/services/orchestrate.ts` — LLM planning + fallback + event tracking -> Exemplar 1, 2

### Wave 2 (Integracion)
- [ ] W2.1: Modificar `src/routes/orchestrate.ts` — orchestrationId en route, pasar a service -> Archivo #3

### Wave 3 (Verificacion)
- [ ] W3.1: typecheck + tests + server starts

### Verificacion Incremental

| Wave | Verificacion al completar |
|------|--------------------------|
| W0 | typecheck pasa |
| W1 | typecheck + tests pasan |
| W2 | typecheck + tests + server starts |
| W3 | full QA |

## Out of Scope

- Attestation on-chain (WKH-8)
- Streaming response
- Retry logic
- Cobro real del protocol fee
- Cache de planes
- Modificar compose.ts, discovery.ts, event.ts
- NO mejorar codigo adyacente
- NO agregar funcionalidad no listada

## Escalation Rule

> Si algo no esta en este Story File, Dev PARA y pregunta a Architect.
> No inventar. No asumir. No improvisar.

---

*Story File generado por NexusAgil — F2.5*
