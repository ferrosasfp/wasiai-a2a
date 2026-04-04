# SDD #011 — WKH-10: LLM Planning

**HU:** [S4-P1] LLM Planning — Claude selecciona agentes por goal en /orchestrate  
**Branch:** feat/wkh-10-llm-planner  
**SDD_MODE:** full  
**Fecha:** 2026-04-04

---

## Context Map (Codebase Grounding)

### Archivos leidos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/services/orchestrate.ts` | Archivo a modificar — contiene stub `planPipeline` | Patrón: service object literal, exports nombrados, TypeScript estricto |
| `src/services/compose.ts` | Exemplar de servicio con lógica asíncrona | Patrón: imports desde `../types/index.js`, helpers privados, service object |
| `src/services/discovery.ts` | Exemplar de service con múltiples métodos | Patrón: `discoveryService = { async method() {} }` |
| `src/services/task.ts` | Exemplar de servicio con Supabase | Patrón: imports tipados, interfaces internas |
| `src/types/index.ts` | Types existentes a reutilizar | `Agent`, `ComposeStep`, `OrchestrateRequest`, `OrchestrateResult` |
| `package.json` | Verificar dependencias | `@anthropic-ai/sdk` NO está — debe instalarse |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/services/llm/planner.ts` | `src/services/compose.ts` | Service object literal, TypeScript estricto, imports desde `../types/index.js` |
| Modificar `src/services/orchestrate.ts` | Patrón existente en el mismo archivo | Solo reemplazar llamada a `planPipeline` |

### Estado de BD relevante
No aplica — no hay cambios de BD.

### Componentes reutilizables encontrados
- `Agent`, `ComposeStep`, `OrchestrateRequest` desde `src/types/index.js` — reutilizar
- Lógica fallback `planPipeline` en `orchestrate.ts` — mantener como fallback privado

---

## Arquitectura

### Módulo nuevo: `src/services/llm/planner.ts`

```typescript
// Función pública exportada
export async function planOrchestration(
  goal: string,
  agents: Agent[],
  budget: number,
  maxAgents: number
): Promise<{ steps: ComposeStep[]; reasoning: string }>
```

**Flujo:**
1. Construir prompt con goal + lista de agentes (id, name, capabilities, priceUsdc)
2. Llamar `anthropic.messages.create()` con modelo `claude-sonnet-4-20250514`, timeout 30s
3. Parsear respuesta JSON: `{ steps: [{agent, registry, input, passOutput}], reasoning: string }`
4. Validar que todos los `agent` en steps existen en la lista de agentes disponibles
5. Si falla (timeout, JSON inválido, agentes inválidos): lanzar error para que orquestador use fallback

### Modificación: `src/services/orchestrate.ts`

- Importar `planOrchestration` desde `./llm/planner.js`
- En `orchestrate()`: envolver `this.planPipeline()` en try/catch
- Si `ANTHROPIC_API_KEY` existe: intentar `planOrchestration` primero
- Si falla: fallback silencioso a `planPipeline`
- Si `planOrchestration` retorna error de capacidades faltantes: propagar como HTTP 422

### Estructura del prompt LLM

```
System: Eres un orquestador de agentes AI. Dado un goal en lenguaje natural 
y una lista de agentes disponibles, selecciona los agentes necesarios y ordénalos 
en un pipeline óptimo. Responde SOLO con JSON válido.

User: Goal: {goal}
Budget total: {budget} USDC
Max agentes: {maxAgents}

Agentes disponibles:
{JSON de agentes con: id, name, description, capabilities, priceUsdc, registry, slug}

Responde con este schema exacto:
{
  "steps": [
    {
      "agent": "<slug del agente>",
      "registry": "<nombre del registry>",
      "input": { ... },
      "passOutput": true|false
    }
  ],
  "reasoning": "Explicación de por qué estos agentes en este orden"
}

Si no puedes armar un pipeline válido con los agentes disponibles, responde:
{
  "error": "Cannot build pipeline",
  "missingCapabilities": ["cap1", "cap2"]
}
```

---

## Plan de implementación (Waves)

### W0 — Setup (serial)
1. Instalar `@anthropic-ai/sdk` en package.json
2. Crear directorio `src/services/llm/`
3. Crear `src/services/llm/planner.ts`

### W1 — Integración (paralelo)
4. Modificar `src/services/orchestrate.ts` para usar planner
5. Crear `test/llm-planner.test.ts`

### W2 — Verificación
6. typecheck + tests

---

## Archivos del plan

| Archivo | Acción | Exemplar |
|---------|--------|---------|
| `src/services/llm/planner.ts` | CREATE | `src/services/compose.ts` |
| `src/services/orchestrate.ts` | MODIFY | Patrón existente |
| `test/llm-planner.test.ts` | CREATE | `src/services/compose.test.ts` |
| `package.json` | MODIFY | — |

---

## Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- Patrón de service: object literal `export const xService = { ... }` O función exportada nomeada — alinearse con `planner.ts` siendo una función pura
- Imports: usar `@anthropic-ai/sdk` (instalar), tipos desde `../types/index.js`
- TypeScript strict: no `any`, no `as unknown`
- Timeout: AbortController con 30_000 ms

### PROHIBIDO
- NO modificar `discovery.ts`, `compose.ts`, routes, ni tipos
- NO hardcodear el modelo (usar constante o parámetro con default `claude-sonnet-4-20250514`)
- NO lanzar excepciones no manejadas en el path de fallback
- NO agregar dependencias que no sean `@anthropic-ai/sdk`
- NO cambiar el schema de `OrchestrateRequest` / `OrchestrateResult`
- NO hacer streaming LLM

---

## Manejo de errores

| Error | Comportamiento |
|-------|---------------|
| ANTHROPIC_API_KEY no configurada | Fallback directo a `planPipeline` |
| Timeout 30s | Fallback a `planPipeline` (log warning) |
| JSON inválido en respuesta LLM | Fallback a `planPipeline` (log warning) |
| LLM retorna `missingCapabilities` | Propagar como error con `{ missingCapabilities }` → HTTP 422 en route |
| Agentes en steps no existen en disponibles | Fallback a `planPipeline` |

---

## Implementation Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene al menos 1 archivo asociado en la tabla
[x] Cada archivo tiene un Exemplar válido
[x] No hay [NEEDS CLARIFICATION] pendientes
[x] Constraint Directives incluyen al menos 3 PROHIBIDO (6)
[x] Context Map tiene al menos 2 archivos leidos (6)
[x] Scope IN y OUT explícitos
[x] No aplica BD
```

Status: ✅ LISTO PARA IMPLEMENTAR
