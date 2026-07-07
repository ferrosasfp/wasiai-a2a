# Work Item — [WKH-157] Discover free-text (`q`) recall fix — broaden-retry sin filtro upstream

## Resumen
El endpoint público `GET/POST /discover` con búsqueda libre (`q=sentiment`, `q="send money"`) devuelve 0 o pocos resultados aunque existan agentes relevantes (`wasi-defi-sentiment`, `sentiment-analyzer`, `wasi-chainlink-price`). Causa raíz (auditoría e2e 2026-07-07, E2E-1): `discoveryService.discover()` reenvía `query.query` a cada registry upstream (`discovery.ts:450-451`); el filtro local por substring (`discovery.ts:319-326`) solo corre sobre lo que el upstream YA devolvió — nunca puede recuperar agentes que el registry descartó con su propio criterio de búsqueda. Fix: cuando el resultado post-filtro es 0 y había `query.query`, reintentar UNA vez sin reenviar el free-text upstream (mismo patrón que el broaden-retry de capabilities de WKH-151), dejando que el filtro local (más permisivo, substring en name/description/capabilities) actúe sobre el set completo.

## Sizing
- SDD_MODE: mini (bugfix acotado, 1 archivo de servicio + tests)
- Estimación: S
- Branch sugerido: `fix/159-wkh-157-discover-freetext-filter`

## Acceptance Criteria (EARS)

- AC-1: WHEN un caller invoca `discoveryService.discover({ query: q, ... })` y el pipeline completo (upstream + filtros locales) devuelve 0 agentes, the system SHALL reintentar UNA vez la consulta a los registries SIN reenviar `q` como query param upstream, y aplicar el filtro local de substring (name/description/capabilities) sobre ese set retried.
- AC-2: WHILE el primer intento (con `q` reenviado upstream) ya devuelve ≥1 agente tras los filtros locales, the system SHALL NOT ejecutar el retry (cero llamadas extra en el happy path — mismo criterio de costo que CD-3/CD-5 de WKH-151).
- AC-3: IF el retry sin `q` upstream también devuelve 0 agentes tras el filtro local, THEN the system SHALL devolver el resultado vacío original (`agents: [], total: 0`) sin retries adicionales.
- AC-4: the system SHALL preservar la firma y el comportamiento de `discoveryService.discover({ capabilities, maxPrice, limit })` tal como la llama `orchestrate.ts:520-524` — sin agregar el campo `query`, sin alterar el broaden-retry existente de capabilities (WKH-151, `orchestrate.ts:526-539`). El path del planner NO se toca.
- AC-5: the system SHALL preservar el orden de sort verified-first → reputación → precio (`discovery.ts:349-355`) igual para el resultado directo y el resultado del retry.
- AC-6: the system SHALL mantener verdes los tests existentes de discovery (`discovery.test.ts`, `discovery.ssrf.test.ts`, `discovery.selfpublished.test.ts`, `discover.test.ts`, `discover-agents.test.ts`) sin modificar sus expectativas actuales (regresión cero).
- AC-7: WHEN el retry se dispara, the system SHALL loguearlo (mismo patrón de telemetría additive que WKH-151: marcador booleano, sin costo adicional de negocio — este endpoint no debita presupuesto).

## Scope IN
- `src/services/discovery.ts` — método `discover()` (lógica de retry gateada en `query.query` + resultado 0) y `queryRegistry()` (soporte para omitir el `queryParam` en el intento de retry).
- `src/services/discovery.test.ts` — tests nuevos para el retry (query relevante que el upstream mockeado descarta pero el filtro local matchea tras el retry).
- `src/routes/discover.test.ts` / `src/mcp/tools/discover-agents.test.ts` — verificar que no rompen (ambos consumen `discoveryService.discover` con `query`).

## Scope OUT
- `src/services/orchestrate.ts` — el broaden-retry de `preferCapabilities` (WKH-151, filas 157 del `_INDEX.md`) queda intacto; el planner nunca pasa `query.query` (confirmado leyendo `orchestrate.ts:520-524`, solo `capabilities`/`maxPrice`/`limit`).
- `src/services/compose.ts` — no consume `query.query` en discovery (fuera de este fix).
- Cambios al algoritmo de búsqueda de cada registry upstream — no controlamos ese código.
- Cualquier cambio al sort, sistema de reputación, filtros `verified`/`status`/`maxPrice` — sin tocar.

## Decisiones técnicas (DT-N)
- DT-1: Retry sin reenvío de `q` upstream (en vez de dejar de reenviar `q` SIEMPRE) — conservador: preserva el comportamiento actual en el happy path (registries con buen search backend siguen recibiendo el hint `q`, potencialmente más rápido/relevante), y solo cae al fallback permisivo cuando el resultado es 0. Mismo criterio de mínimo blast-radius que WKH-151 (fila 157 `_INDEX.md`).
- DT-2: El gate del retry es "`query.query` truthy AND 0 resultados post-filtro" — igual estructura al broaden-retry de capabilities de WKH-151 (`orchestrate.ts:539`), reutilizando el patrón ya validado en producción.
- DT-3: El retry vive en `discoveryService.discover()` (capa de servicio), no en `routes/discover.ts` — así beneficia a AMBOS consumidores del free-text (`GET/POST /discover` y el MCP tool `discover_agents`) con una sola implementación.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar `orchestrate.ts` — el path del planner (capabilities + su propio broaden-retry WKH-151) no se toca en esta HU.
- CD-2: PROHIBIDO modificar el orden de sort (`verified` → `reputation` → `price`, `discovery.ts:349-355`).
- CD-3: PROHIBIDO ejecutar más de 1 retry por llamada a `discover()` (cero riesgo de loop/latencia descontrolada).
- CD-4: OBLIGATORIO que el retry sea additive/degradable: si el retry mismo falla (error de red en algún registry), debe comportarse igual que el flujo actual (`catch` → `[]` para ese registry, `discovery.ts:261-281`), nunca romper el endpoint.
- CD-5: money-path intacto — `/discover` no debita presupuesto ni toca `a2a_agent_keys`; este fix no introduce ningún cambio de billing.

## Missing Inputs
- Ninguno bloqueante. Confirmado por lectura de código (F0): `orchestrate.ts:520-524` solo pasa `capabilities`/`maxPrice`/`limit` a `discoveryService.discover()` — el planner NUNCA popula `query.query`, por lo que el retry de esta HU (gateado en `query.query` truthy) nunca se dispara en el path del planner. Money-path safe.

## Análisis de paralelismo
- No bloquea ni es bloqueada por ninguna HU en curso (última fila del `_INDEX.md` es 158, WKH-153, DONE).
- Puede correr en paralelo con cualquier otra HU que no toque `src/services/discovery.ts` o `src/routes/discover.ts`.
- Relacionada pero independiente de WKH-151 (fila 157) — mismo patrón de diseño, distinto choke-point (discovery.ts vs orchestrate.ts), sin overlap de archivos.
