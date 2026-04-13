# Work Item — [WKH-DISCOVER-VERIFIED] Discover — campos `verified` y `status`, filtro activos por defecto

## Resumen

El endpoint `/discover` (GET y POST) retorna agentes sin indicar si están verificados ni si su endpoint responde. Un agente consumidor autónomo no puede distinguir un agente operativo de uno caído. Esta HU agrega los campos `verified` y `status` a `Agent` y a la respuesta de `/discover`, filtrando por defecto solo agentes con `status: "active"`. El filtro `verified=true` es opcional.

## Riesgo

- **Categoría**: `external-input` — cambia el contrato de respuesta de un endpoint público consumido por agentes externos.
- **Impacto**: Cualquier consumidor que parsee `agents[]` sin campos extra no se rompe (campos nuevos, no cambio de campos existentes). El filtro por defecto `status: "active"` **sí cambia el conjunto de resultados** para todos los consumers actuales — es un breaking change de comportamiento, no de schema.
- **Mitigación requerida**: El parámetro `includeInactive=true` permite a consumers legacy recibir el comportamiento anterior. Debe documentarse en el work-item y validarse en F4.

## Sizing

- SDD_MODE: mini
- Estimación: M
- Branch sugerido: `feat/040-discover-verified`

## Acceptance Criteria (EARS)

- AC-1: WHEN `/discover` is called (GET or POST) without `includeInactive`, the system SHALL return only agents whose `status` is `"active"`.
- AC-2: WHEN `/discover` is called with `includeInactive=true` (GET query param) or `{ includeInactive: true }` (POST body), the system SHALL return agents of all statuses.
- AC-3: WHEN `/discover` is called with `verified=true` (GET) or `{ verified: true }` (POST body), the system SHALL return only agents whose `verified` field is `true`.
- AC-4: the system SHALL include a `verified: boolean` field and a `status: "active" | "inactive" | "unreachable"` field on every `Agent` object in the `/discover` response.
- AC-5: WHEN `mapAgent` maps a raw registry response, the system SHALL set `verified` from the registry's agent field mapping (configurable via `AgentFieldMapping`), defaulting to `false` if the field is absent.
- AC-6: WHEN `mapAgent` maps a raw registry response, the system SHALL set `status` from the registry's agent field mapping, defaulting to `"active"` if the field is absent.
- AC-7: IF a registry agent has `verified = true` AND `status = "active"`, THEN the system SHALL rank it above non-verified agents in the sorted result (verified-first tiebreaker, before reputation).
- AC-8: WHEN `GET /discover/:slug` returns a single agent, the system SHALL include `verified` and `status` fields on that agent.
- AC-9: IF `verified=true` filter is combined with `includeInactive=true`, THEN the system SHALL apply both filters independently (AND logic).
- AC-10: the system SHALL expose at least one vitest test that validates the `status: "active"` default filter behavior.

## Scope IN

1. `src/types/index.ts` — extender `Agent` con `verified: boolean` y `status: AgentStatus`; extender `DiscoveryQuery` con `verified?: boolean` e `includeInactive?: boolean`; extender `AgentFieldMapping` con `verified?: string` y `status?: string`.
2. `src/services/discovery.ts` — `mapAgent`: leer campos `verified`/`status` desde el mapping; `discover`: aplicar filtro `status === "active"` por defecto y filtro `verified` opcional.
3. `src/routes/discover.ts` — GET handler: parsear `verified` e `includeInactive` desde querystring; POST handler: parsear ambos desde body; pasar ambos a `discoveryService.discover`.
4. `test/` — test unitario o integration que cubra AC-10.

## Scope OUT

- No se implementa health-check HTTP hacia el endpoint del agente en esta HU (el campo `status` se toma del dato del registry, no de un ping activo).
- No se agrega paginación ni cursor.
- No se modifica `POST /compose` ni `POST /orchestrate`.
- No se cambia el schema de la tabla `a2a_registries` (los campos `verified`/`status` vienen de la respuesta del registry externo, no de la DB).

## Decisiones técnicas

- DT-1: `status` defaultea a `"active"` cuando el registry no lo provee. Justificación: preserva compatibilidad con registries existentes que no exponen status (Community Hub mock, WasiAI registry actual). El Architect puede cambiar esto en F2 si hay evidencia contraria.
- DT-2: `verified` defaultea a `false`. Justificación: principio de menor privilegio — un agente no conocido no se asume verificado.
- DT-3: El tiebreaker de ranking `verified-first` va antes de `reputation` (AC-7). Justificación: la verificación es una señal más fuerte que la reputación auto-reportada.
- DT-4: `includeInactive` como parámetro opt-in (no opt-out). Justificación: el comportamiento seguro por defecto es excluir agentes caídos. Breaking change de comportamiento mitigado por el parámetro de escape.

## Constraint Directives

- CD-1: PROHIBIDO hacer HTTP ping al `invokeUrl` del agente dentro del request de `/discover` para determinar `status` — latencia inaceptable en production (22+ agentes en paralelo).
- CD-2: OBLIGATORIO que `AgentStatus` sea un union type literal TypeScript (`"active" | "inactive" | "unreachable"`), no `string`.
- CD-3: PROHIBIDO el uso de `any` explícito en código nuevo.
- CD-4: OBLIGATORIO que el filtro `status: "active"` sea aplicado en `discoveryService.discover`, no en el route handler — la lógica de negocio no va en la capa de routing.

## Missing Inputs

- [RESUELTO en F2] Confirmar si WasiAI registry o Community Hub mock exponen campos `verified`/`status` en su respuesta — si no los exponen, el default aplica y no hay acción adicional.
- [NEEDS CLARIFICATION] ¿El campo `status` del agente en el registry de WasiAI se llama `status`, `isActive`, u otro nombre? Si el Architect lo determina en F2, agregar al `AgentFieldMapping` default del WasiAI registry.

## Análisis de paralelismo

- Esta HU NO bloquea otras HUs en curso (025, 026, 029, 031, 032, etc.) — es un scope aditivo sobre `/discover`.
- El branch `feat/040-discover-verified` puede correr en paralelo con `feat/029-e2e-tests` siempre que el merge de 040 preceda al merge de 029 para evitar conflictos en los tests de discovery.
- Depende de que `feat/031-discover-post` esté mergeado (el POST /discover debe existir antes de extenderlo). Si 031 está en `in progress`, coordinar merge order.
