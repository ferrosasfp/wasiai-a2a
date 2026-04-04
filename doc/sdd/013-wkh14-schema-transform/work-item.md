# Work Item #013 — WKH-14 Schema Transform

| Campo | Valor |
|-------|-------|
| **#** | 013 |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Cuando el output de step N en un pipeline compose no coincide con el inputSchema esperado por step N+1, Claude transforma automáticamente el payload. La transformación se cachea por par (sourceAgentId, targetAgentId) en Supabase `kite_schema_transforms`, evitando llamadas LLM repetidas. |
| **Reglas de negocio** | 1) Solo transformar si los schemas son incompatibles. 2) El cache key es (sourceAgentId, targetAgentId). 3) Cache hit: <50ms. Cache miss con LLM: ~2s. 4) La función de transformación se persiste como string JS evaluable. 5) La tabla usa prefijo `kite_` por ser del hackathon. |
| **Scope IN** | `src/services/llm/transform.ts` (nuevo), integración en `src/services/compose.ts`, migration SQL `kite_schema_transforms`, tipos en `src/types/index.ts`, tests |
| **Scope OUT** | Redis, UI, /orchestrate, agent discovery, pagos x402, schema inference de marketplaces |
| **Branch** | `feat/wkh-14-schema-transform` |

## Acceptance Criteria (EARS)

| # | Criterio | Formato |
|---|----------|---------|
| AC1 | WHEN el output de step N es incompatible con el inputSchema de step N+1, THEN `transformSchema` SHALL generar una función JS que mapea el payload | Event-Driven |
| AC2 | WHEN `transformSchema` se llama con schemas ya cacheados en `kite_schema_transforms`, THEN SHALL retornar la transformación sin llamar al LLM en <50ms | Event-Driven |
| AC3 | WHEN la transformación se genera por primera vez (cache miss), THEN SHALL persistirse en `kite_schema_transforms` con sourceAgentId y targetAgentId | Event-Driven |
| AC4 | WHEN el output de step N es compatible con el inputSchema de step N+1, THEN `composeService.compose` SHALL pasar el output directo sin transformar | Event-Driven |
| AC5 | WHEN `composeService.compose` devuelve el resultado, THEN el campo `cacheHit` en metadata de cada step SHALL indicar true/false según si usó cache | Event-Driven |
| AC6 | IF la transformación LLM falla (error de API, JSON inválido), THEN SHALL propagar el error con mensaje descriptivo sin corromper el pipeline | Unwanted |

## DoD
- Pipeline con 2 agentes de schemas distintos funciona end-to-end
- Segunda llamada al mismo par usa cache (<50ms vs ~2s LLM)
- Tests cubren: cache miss → LLM → persist, cache hit, schemas compatibles, transform error
- TypeScript strict sin `any` explícito
- Build pasa (`tsc`)
