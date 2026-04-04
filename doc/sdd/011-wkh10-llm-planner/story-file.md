# Story File #011 — WKH-10: LLM Planning

> **Contrato para Dev.** Lee SOLO este archivo. No leas el SDD ni el Work Item.
> Si algo no está claro, escala al Architect — NO inventes.

---

## Goal

Crear `src/services/llm/planner.ts` con una función `planOrchestration` que use Claude Sonnet para seleccionar agentes semánticamente dado un goal en lenguaje natural. Modificar `src/services/orchestrate.ts` para usar esta función con fallback a precio.

---

## Acceptance Criteria

| ID | Criterio |
|----|----------|
| AC1 | WHEN POST /orchestrate recibe `goal: "analiza token X"`, THEN retorna pipeline con agentes relevantes (capabilities como `token-analysis`, `market-data`) |
| AC2 | WHEN Claude no puede armar pipeline, THEN HTTP 422 con `missingCapabilities: string[]` |
| AC3 | WHEN ANTHROPIC_API_KEY no config o LLM falla (timeout/error), THEN fallback a selección por precio, no lanzar 500 |
| AC4 | WHEN se llama LLM, THEN prompt incluye agentes disponibles, respuesta es JSON con `steps[]` y `reasoning` |
| AC5 | `planOrchestration(goal, agents, budget, maxAgents)` debe existir y exportarse en `src/services/llm/planner.ts` |

---

## Files to Modify/Create

| Archivo | Acción | Exemplar |
|---------|--------|---------|
| `src/services/llm/planner.ts` | CREATE | `src/services/compose.ts` (patrón TypeScript) |
| `src/services/orchestrate.ts` | MODIFY | Patrón existente — reemplazar llamada a `planPipeline` |
| `test/llm-planner.test.ts` | CREATE | `src/services/compose.test.ts` si existe, sino `src/services/task.test.ts` |
| `package.json` | MODIFY | Agregar `@anthropic-ai/sdk` en `dependencies` |

---

## Exemplars (código real del proyecto)

### Patrón de imports en services (de compose.ts)
```typescript
import type {
  Agent,
  ComposeStep,
} from '../types/index.js'
```

### Patrón de export de service (de orchestrate.ts)
```typescript
export const orchestrateService = {
  async orchestrate(request: OrchestrateRequest): Promise<OrchestrateResult> {
    // ...
  },
}
```

### Tipos relevantes (de src/types/index.ts)
```typescript
interface Agent {
  id: string; name: string; slug: string; description: string
  capabilities: string[]; priceUsdc: number
  registry: string; invokeUrl: string
}

interface ComposeStep {
  agent: string          // slug del agente
  registry?: string
  input: Record<string, unknown>
  passOutput?: boolean
}
```

---

## Implementación: Wave 0 — Setup (serial)

### Tarea 0.1 — Instalar @anthropic-ai/sdk
```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
npm install @anthropic-ai/sdk
```
Verificar que aparece en `package.json` `dependencies`.

### Tarea 0.2 — Crear directorio
```bash
mkdir -p src/services/llm
```

### Tarea 0.3 — Crear `src/services/llm/planner.ts`

```typescript
/**
 * LLM Planner — WKH-10
 * Usa Claude Sonnet para seleccionar agentes semánticamente dado un goal.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { Agent, ComposeStep } from '../../types/index.js'

const MODEL = 'claude-sonnet-4-20250514'
const TIMEOUT_MS = 30_000

/** Resultado válido del LLM */
interface LLMPlanSuccess {
  steps: ComposeStep[]
  reasoning: string
}

/** El LLM no pudo armar pipeline — faltan capacidades */
export interface LLMMissingCapabilities {
  error: 'missing_capabilities'
  missingCapabilities: string[]
}

export type LLMPlanResult = LLMPlanSuccess | LLMMissingCapabilities

/**
 * Planifica un pipeline usando Claude Sonnet.
 * 
 * @returns LLMPlanSuccess si armó pipeline, LLMMissingCapabilities si no puede,
 *          o throws si hubo error técnico (caller hace fallback).
 */
export async function planOrchestration(
  goal: string,
  agents: Agent[],
  budget: number,
  maxAgents: number,
): Promise<LLMPlanResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured')
  }

  const client = new Anthropic({ apiKey })

  const agentList = agents.map(a => ({
    slug: a.slug,
    registry: a.registry,
    name: a.name,
    description: a.description,
    capabilities: a.capabilities,
    priceUsdc: a.priceUsdc,
  }))

  const systemPrompt = `Eres un orquestador de agentes AI. Dado un goal en lenguaje natural y una lista de agentes disponibles, selecciona los agentes necesarios y ordénalos en un pipeline óptimo. Responde SOLO con JSON válido, sin markdown, sin explicaciones fuera del JSON.`

  const userPrompt = `Goal: ${goal}
Budget total: ${budget} USDC
Max agentes: ${maxAgents}

Agentes disponibles:
${JSON.stringify(agentList, null, 2)}

Responde con este schema exacto (elige los agentes más relevantes para el goal):
{
  "steps": [
    {
      "agent": "<slug del agente>",
      "registry": "<nombre del registry>",
      "input": { "goal": "${goal}" },
      "passOutput": true
    }
  ],
  "reasoning": "Explicación de por qué estos agentes en este orden"
}

Si NO puedes armar un pipeline válido con los agentes disponibles, responde:
{
  "error": "missing_capabilities",
  "missingCapabilities": ["capability_que_falta_1", "capability_que_falta_2"]
}`

  // AbortController para timeout
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      },
      { signal: controller.signal },
    )

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()

    const parsed = JSON.parse(text) as Record<string, unknown>

    // Error de capacidades faltantes
    if (parsed.error === 'missing_capabilities') {
      return {
        error: 'missing_capabilities',
        missingCapabilities: (parsed.missingCapabilities as string[]) ?? [],
      }
    }

    // Validar steps
    const steps = parsed.steps as ComposeStep[]
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('LLM returned empty steps')
    }

    // Validar que los slugs existen en la lista disponible
    const availableSlugs = new Set(agents.map(a => a.slug))
    for (const step of steps) {
      if (!availableSlugs.has(step.agent)) {
        throw new Error(`LLM returned unknown agent slug: ${step.agent}`)
      }
    }

    return {
      steps,
      reasoning: String(parsed.reasoning ?? ''),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}
```

**Verificar:** `npx tsc --noEmit`

---

## Implementación: Wave 1 — Integración (paralelo con tests)

### Tarea 1.1 — Modificar `src/services/orchestrate.ts`

Reemplazar el bloque en `orchestrate()` que llama a `planPipeline`:

**ANTES (líneas actuales):**
```typescript
    // Step 2: Plan pipeline (simple strategy for now)
    // TODO: Use LLM to plan optimal pipeline based on goal and available agents
    const { steps, reasoning } = this.planPipeline(
      goal, 
      discovered.agents, 
      budget, 
      maxAgents
    )
```

**DESPUÉS:**
```typescript
    // Step 2: Plan pipeline — LLM con fallback a precio
    let steps: ComposeStep[]
    let reasoning: string

    const useLLM = !!process.env.ANTHROPIC_API_KEY
    if (useLLM) {
      try {
        const { planOrchestration, type LLMMissingCapabilities } = await import('./llm/planner.js')
        const result = await planOrchestration(goal, discovered.agents, budget, maxAgents)
        
        if ('error' in result && result.error === 'missing_capabilities') {
          const err = result as LLMMissingCapabilities
          throw Object.assign(new Error('Cannot build pipeline: missing capabilities'), {
            code: 'MISSING_CAPABILITIES',
            missingCapabilities: err.missingCapabilities,
          })
        }
        
        steps = result.steps
        reasoning = result.reasoning
      } catch (err: unknown) {
        // Propagar errores de capacidades faltantes
        if (err instanceof Error && 'code' in err && err.code === 'MISSING_CAPABILITIES') {
          throw err
        }
        // Fallback silencioso para errores técnicos
        console.warn('[Orchestrate] LLM planner failed, falling back to price strategy:', (err as Error).message)
        const fallback = this.planPipeline(goal, discovered.agents, budget, maxAgents)
        steps = fallback.steps
        reasoning = fallback.reasoning
      }
    } else {
      const fallback = this.planPipeline(goal, discovered.agents, budget, maxAgents)
      steps = fallback.steps
      reasoning = fallback.reasoning
    }
```

También agregar el import al inicio del archivo:
```typescript
import type { ComposeStep } from '../types/index.js'
```

**Verificar:** `npx tsc --noEmit`

### Tarea 1.2 — Agregar manejo HTTP 422 en route `src/routes/orchestrate.ts`

Buscar el handler POST /orchestrate y agregar:

```typescript
    } catch (err: unknown) {
      // Capacidades faltantes — 422
      if (err instanceof Error && 'code' in err && err.code === 'MISSING_CAPABILITIES') {
        return reply.code(422).send({
          error: 'Cannot build pipeline',
          missingCapabilities: (err as { missingCapabilities: string[] }).missingCapabilities,
        })
      }
      throw err  // Re-throw para 500
    }
```

### Tarea 1.3 — Crear `test/llm-planner.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { planOrchestration } from '../src/services/llm/planner.js'
import type { Agent } from '../src/types/index.js'

const mockAgents: Agent[] = [
  {
    id: '1', name: 'Token Analyzer', slug: 'token-analyzer',
    description: 'Analyzes token metrics', capabilities: ['token-analysis', 'market-data'],
    priceUsdc: 0.01, registry: 'wasiai', invokeUrl: 'https://example.com/invoke/token-analyzer',
  },
  {
    id: '2', name: 'Price Feed', slug: 'price-feed',
    description: 'Provides token prices', capabilities: ['market-data', 'price-feed'],
    priceUsdc: 0.005, registry: 'wasiai', invokeUrl: 'https://example.com/invoke/price-feed',
  },
]

describe('planOrchestration', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('throws when ANTHROPIC_API_KEY is not set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    await expect(planOrchestration('analiza token X', mockAgents, 1, 5)).rejects.toThrow(
      'ANTHROPIC_API_KEY not configured'
    )
  })

  it('returns missing_capabilities error when LLM cannot build pipeline', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    
    // Mock Anthropic SDK
    vi.mock('@anthropic-ai/sdk', () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'missing_capabilities',
                missingCapabilities: ['blockchain-analysis', 'defi-data']
              })
            }]
          })
        }
      }))
    }))

    const result = await planOrchestration('analiza defi protocol', mockAgents, 1, 5)
    expect(result).toMatchObject({
      error: 'missing_capabilities',
      missingCapabilities: expect.arrayContaining(['blockchain-analysis'])
    })
  })

  it('validates that returned agent slugs exist in available agents', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key')
    
    vi.mock('@anthropic-ai/sdk', () => ({
      default: vi.fn().mockImplementation(() => ({
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [{
              type: 'text',
              text: JSON.stringify({
                steps: [{ agent: 'nonexistent-agent', registry: 'wasiai', input: {}, passOutput: false }],
                reasoning: 'test'
              })
            }]
          })
        }
      }))
    }))

    await expect(planOrchestration('analiza token', mockAgents, 1, 5)).rejects.toThrow(
      'unknown agent slug'
    )
  })
})
```

---

## Wave 2 — Verificación final

```bash
npx tsc --noEmit
npx vitest run test/llm-planner.test.ts
```

---

## Constraint Directives

### OBLIGATORIO
- Seguir patrón TypeScript strict del proyecto (no `any`, no `as unknown`)
- Imports desde `../../types/index.js` (con `.js`)
- Usar `AbortController` para timeout de 30s

### PROHIBIDO
- NO modificar `discovery.ts`, `compose.ts`, ni schemas de tipos
- NO hardcodear `claude-sonnet-4-20250514` en lugares que no sea la constante `MODEL`
- NO lanzar excepciones no manejadas en el path de fallback
- NO agregar dependencias extra
- NO cambiar `OrchestrateRequest` / `OrchestrateResult`
- NO hacer streaming

---

## Out of Scope

- `discovery.ts`, `compose.ts`, `registry.ts` — NO tocar
- Routes existentes de otros endpoints — NO tocar
- Cambios en Supabase / Redis
- UI, CLI, scripts

---

## Escalation Rule

Si algo no está en este Story File, **PARA** y pregunta al Architect. No inventes.
