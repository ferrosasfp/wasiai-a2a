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

  const systemPrompt =
    'Eres un orquestador de agentes AI. Dado un goal en lenguaje natural y una lista de agentes disponibles, selecciona los agentes necesarios y ordénalos en un pipeline óptimo. Responde SOLO con JSON válido, sin markdown, sin explicaciones fuera del JSON.'

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
      .map(b => (b as { type: 'text'; text: string }).text)
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
