# Work Item — [WKH-61] [SEC-SCOPE-1] requirePaymentOrA2AKey — checkScoping con target vacío

## Resumen

El middleware `requirePaymentOrA2AKey` invoca `authzService.checkScoping(keyRow, {})` con un `AuthzTarget` completamente vacío en el paso 5 del preHandler. Esto hace que cualquier key que tenga `allowed_registries`, `allowed_agent_slugs` o `allowed_categories` configurados sea denegada en el 100% de las requests (porque `target.registry`, `target.agent_slug` y `target.category` siempre son `undefined`). El scoping check está diseñado para ejecutarse con conocimiento del agente destino real — información que solo existe DESPUÉS de que `composeService` y `orchestrateService` resuelven el agente. La solución es remover el check del middleware y moverlo a los servicios, post-resolución de agente.

**Severidad**: BLQ-MED del security audit 2026-04-27. Feature de keys restringidas completamente inoperativa.

## Sizing

- SDD_MODE: full
- Estimación: M
- Branch sugerido: `feat/059-wkh-61-sec-scope-1`
- Flow: QUALITY

## Skills relevantes

- `security-auth` — auth path crítico, scoping de API keys
- `service-layer` — mover lógica del middleware a los servicios

## Acceptance Criteria (EARS)

- **AC-1**: WHEN a key with `allowed_registries=['wasiai']` invokes POST /compose with a step where the resolved agent has `registry='wasiai'`, the system SHALL return HTTP 200 (scoping check passes).

- **AC-2**: WHEN a key with `allowed_registries=['wasiai']` invokes POST /compose with a step where the resolved agent has `registry='other-registry'`, the system SHALL return HTTP 403 with `error_code: 'SCOPE_DENIED'` and abort pipeline execution before invoking any agent.

- **AC-3**: WHEN a key with `allowed_agent_slugs=['wasi-chainlink-price']` invokes POST /compose with a step that resolves to an agent with slug other than `'wasi-chainlink-price'`, the system SHALL return HTTP 403 with `error_code: 'SCOPE_DENIED'`.

- **AC-4**: WHEN a key with `allowed_categories=['defi']` invokes POST /compose or POST /orchestrate with a step that resolves to an agent whose category is NOT `'defi'`, the system SHALL return HTTP 403 with `error_code: 'SCOPE_DENIED'`.

- **AC-5**: WHEN a key has `allowed_registries=null`, `allowed_agent_slugs=null`, and `allowed_categories=null` (no scoping), the system SHALL allow the request through the scoping check without any scope-related rejection (backward compatibility).

- **AC-6**: WHEN the scoping check for a step runs, the system SHALL evaluate `target.registry`, `target.agent_slug`, and `target.category` using the values from the fully-resolved `Agent` object (post-`resolveAgent`), not from the raw `ComposeStep` input fields.

- **AC-7**: IF `authzService.checkScoping` returns `allowed: false` for any step in a multi-step compose pipeline, THEN the system SHALL abort the entire pipeline immediately, returning HTTP 403, without executing any subsequent steps.

- **AC-8**: WHEN the middleware `requirePaymentOrA2AKey` executes for a request authenticated via A2A key, the system SHALL NOT call `authzService.checkScoping` (the broken `checkScoping({})` call at line 152 SHALL be removed).

## Scope IN

- `src/middleware/a2a-key.ts` — remover el `checkScoping({})` de la línea 152 (el check broken del paso 5). El `keyRow` resuelto y adjuntado a `request.a2aKeyRow` permanece sin cambios.
- `src/services/authz.ts` — mejorar tipo de `target` a `Required<Pick<AuthzTarget, 'registry' | 'agent_slug'>> & Pick<AuthzTarget, 'category' | 'estimated_cost_usd'>` o mantener `AuthzTarget` y mejorar el JSDoc que describe cuándo debe llamarse.
- `src/services/compose.ts` — agregar llamada a `authzService.checkScoping(keyRow, target)` inmediatamente después de `resolveAgent`, donde `target` se construye desde el `Agent` resuelto. Necesita recibir el `keyRow` desde `ComposeRequest` o por inyección.
- `src/services/orchestrate.ts` — la orquestación delega en `composeService.compose`, por lo que el fix en compose cubre este flujo. Verificar que `a2aKey` se propaga correctamente para que compose pueda acceder al `keyRow` si es necesario.
- `src/types/index.ts` o `src/types/a2a-key.ts` — si se extiende `ComposeRequest` para cargar el `keyRow` (ver DT-1).

## Scope OUT

- NO modificar el shape de la tabla `a2a_agent_keys` en Supabase (ningún ALTER TABLE, ninguna migración).
- NO modificar el comportamiento del flujo x402 (solo el path A2A key está afectado).
- NO romper el comportamiento de keys sin scoping (`null`/`[]` en los tres campos de allowed_*).
- NO modificar `src/services/authz.ts` más allá de ajuste de tipos/JSDoc — la lógica de scoping ya es correcta.
- NO cambiar la superficie pública de los endpoints (request/response shape).
- Tests existentes: baseline de 480 tests debe seguir verde.

## Decisiones técnicas

- **DT-1**: Mecanismo para pasar `keyRow` a `composeService` — RECOMENDADO extender `ComposeRequest` con campo opcional `scopingKeyRow?: A2AAgentKeyRow`. El middleware adjunta `request.a2aKeyRow` al request; el route handler lo incluye en el `ComposeRequest` cuando está presente. `composeService.compose` lo consume internamente para el check por step. **Alternativa descartada**: inyectar `keyRow` solo en `resolveAgent` — no aplica porque el check necesita ocurrir post-resolución en el loop de steps.

- **DT-2**: Timing del check dentro de `composeService.compose` — el check SHALL ejecutarse DESPUÉS de `resolveAgent` (línea ~53) y ANTES de `invokeAgent` (línea ~78). Si el agente no fue encontrado (`agent === null`), el error existente de "Agent not found" tiene precedencia; el check de scoping solo aplica si el agente fue resuelto correctamente.

- **DT-3**: Construcción del `AuthzTarget` — mapeo desde `Agent` resuelto: `{ registry: agent.registry, agent_slug: agent.slug, category: (agent.metadata?.category as string | undefined) }`. El campo `category` viene de `agent.metadata.category` (string o undefined). Si `metadata.category` no existe, `target.category` queda `undefined` y el check de `allowed_categories` rechazará (correcto — key con scoping de categoría no puede invocar agente sin categoría declarada). [NEEDS CLARIFICATION: confirmar si `metadata.category` es el campo canónico usado en el catálogo de agentes del registry wasiai-v2, o si hay un campo diferente].

- **DT-4**: `orchestrateService` no invoca directamente `composeService.resolveAgent` — llama `composeService.compose`. El fix en `compose.ts` cubre el flujo orchestrate automáticamente siempre que `request.a2aKeyRow` se propague como `scopingKeyRow` en el `OrchestrateRequest` → `ComposeRequest` chain. Extender `OrchestrateRequest` con `scopingKeyRow?: A2AAgentKeyRow` opcionalmente.

## Constraint Directives

- **CD-1**: PROHIBIDO llamar `authzService.checkScoping` con un `AuthzTarget` vacío o con campos faltantes cuando la key tiene scoping configurado. Todo llamador SHALL construir el target con valores reales del agente resuelto.
- **CD-2**: OBLIGATORIO mantener backward-compat: keys con `allowed_registries=null`, `allowed_agent_slugs=null`, `allowed_categories=null` deben seguir teniendo `checkScoping` retornando `{ allowed: true }` (el comportamiento actual de authz.ts es correcto para este caso — no tocar).
- **CD-3**: PROHIBIDO modificar el schema de `a2a_agent_keys` en DB. No agregar columnas, no modificar columnas existentes.
- **CD-4**: OBLIGATORIO que el baseline de 480 tests permanezca verde. Agregar mínimo 4 tests nuevos cubriendo AC-1, AC-2, AC-5, AC-8.
- **CD-5**: PROHIBIDO hardcodear valores de registry, slug o category en el código de producción.
- **CD-6**: La lógica de scoping en `authz.ts` NO debe cambiar funcionalmente — solo puede recibir mejoras de tipo o JSDoc.

## Missing Inputs

- [NEEDS CLARIFICATION — resuelto en F2] ¿El campo `metadata.category` es el canónico para categorizar agentes en los registries conectados (wasiai-v2, kite)? ¿O se usa `capabilities[0]` como proxy de categoría? Esto afecta la construcción de `AuthzTarget.category` en DT-3.
- [resuelto en F2] Verificar si `OrchestrateRequest` necesita extenderse con `scopingKeyRow` o si el chain `orchestrate → compose` ya propaga suficiente contexto.

## Análisis de paralelismo

- Esta HU NO bloquea otras HUs activas (es un bugfix de auth path aislado).
- No hay dependencias hacia adelante conocidas que esperen que scoping funcione (la feature estaba broken, así que ningún caller de producción depende de ella hoy).
- Puede ejecutarse en paralelo con cualquier HU de feature que no toque `src/middleware/a2a-key.ts`, `src/services/compose.ts`, o `src/services/orchestrate.ts`.
