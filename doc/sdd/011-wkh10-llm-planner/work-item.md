# Work Item #011 — WKH-10

| Campo | Valor |
|-------|-------|
| **#** | 011 |
| **HU** | WKH-10 |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Reemplazar el stub `planPipeline()` en `orchestrateService` con planificación real usando Claude Sonnet, de modo que POST /orchestrate con un goal en lenguaje natural retorne un pipeline semánticamente óptimo seleccionado por LLM. |
| **Branch** | feat/wkh-10-llm-planner |

## Acceptance Criteria (EARS)

| ID | Criterio | Formato |
|----|----------|---------|
| AC1 | WHEN POST /orchestrate recibe `goal: "analiza token X"`, THEN el servicio SHALL seleccionar los agentes con capabilities relevantes (e.g., `token-analysis`, `market-data`) y retornar un pipeline ordenado semánticamente. | Event-Driven |
| AC2 | WHEN Claude no puede construir un pipeline válido con los agentes disponibles, THEN el endpoint SHALL retornar HTTP 422 con un campo `missingCapabilities` listando qué hace falta. | Event-Driven |
| AC3 | WHEN ANTHROPIC_API_KEY no está configurada o la llamada LLM falla (timeout >30s o error de red), THEN el servicio SHALL caer al fallback por precio (lógica actual de `planPipeline`) y continuar sin lanzar 500. | Unwanted |
| AC4 | WHEN se llama al LLM, THEN el prompt SHALL incluir la lista de agentes disponibles con sus capabilities, y la respuesta SHALL ser JSON con `steps[]` y `reasoning`. | Event-Driven |
| AC5 | WHILE el módulo `src/services/llm/planner.ts` existe, THE sistema SHALL exportar una función `planOrchestration(goal, agents, budget, maxAgents)` que devuelva `{ steps: ComposeStep[], reasoning: string }`. | State-Driven |

## Scope IN

- Nuevo archivo `src/services/llm/planner.ts` con función `planOrchestration`
- Modificar `src/services/orchestrate.ts` para usar `planOrchestration` en lugar de `planPipeline`
- Instalar `@anthropic-ai/sdk` si no está en `package.json` (confirmado: NO está)
- Timeout 30s en la llamada LLM
- Fallback a lógica de precio si LLM falla
- Tests en `test/llm-planner.test.ts`

## Scope OUT

- NO modificar `discovery.ts`, `compose.ts`, ni routes
- NO cambiar el schema de `OrchestrateRequest` / `OrchestrateResult`
- NO agregar streaming LLM
- NO UI / CLI

## Reglas de negocio

- Modelo: `claude-sonnet-4-20250514`
- Timeout: 30 000 ms
- Respuesta LLM debe ser JSON parseable con `steps[]` y `reasoning`
- Si LLM devuelve JSON inválido → fallback silencioso (no 500)
- La función `planPipeline` puede quedarse como fallback privado

## Missing Inputs

Ninguno — ANTHROPIC_API_KEY confirmada en env de OpenClaw (mismo token).
