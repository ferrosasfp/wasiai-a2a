# Work Item — [WKH-62] [SEC-SSRF-1] SSRF Protection for discoveryEndpoint

## Resumen

`src/services/discovery.ts` hace `fetch(registry.discoveryEndpoint)` sin
validar el destino. Un atacante autenticado puede registrar un endpoint que
resuelva a `169.254.169.254` (cloud metadata), loopback, o red interna y
causar SSRF. La lógica de validación ya existe en `src/mcp/url-validator.ts`
(`validateGatewayUrl`); esta HU la extrae a `src/lib/url-validator.ts`,
la adapta para el dominio registry, y la aplica tanto en el fetch de discovery
como en la escritura (POST/PATCH de registries).

## Sizing

- SDD_MODE: full
- Estimación: M
- Branch sugerido: `feat/058-wkh-62-sec-ssrf-1`
- Flow: QUALITY (security path, severity BLQ-MED)

## Skills router

- security-hardening
- backend-typescript

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `discoveryService.queryRegistry` ejecuta `fetch` sobre
  `registry.discoveryEndpoint`, the system SHALL primero resolver la URL
  contra la lógica SSRF de `src/lib/url-validator.ts` y, si la validación
  falla, rechazar el fetch con un error tipado `SSRFViolationError` sin enviar
  ninguna request de red.

- **AC-2**: WHEN `POST /registries` recibe un body con `discoveryEndpoint` o
  `invokeEndpoint`, the system SHALL llamar a `validateRegistryUrl` sobre cada
  uno de esos campos antes de persistir el registro, y SHALL responder `422
  Unprocessable Entity` con `{ "error": "SSRF_BLOCKED", "field": "<campo>",
  "reason": "<mensaje>" }` si alguno falla.

- **AC-3**: WHEN `PATCH /registries/:id` recibe un body con
  `discoveryEndpoint` o `invokeEndpoint`, the system SHALL aplicar la misma
  validación SSRF que en AC-2 antes de llamar a `registryService.update`.

- **AC-4**: WHILE `DISCOVERY_SSRF_ALLOWLIST` (variable de entorno, CSV de
  hostnames) está configurada y un hostname figura en ella, the system SHALL
  omitir la comprobación de rangos privados para ese hostname y permitir el
  fetch/registro, manteniendo el bloqueo de literal `localhost` / `*.local`.

- **AC-5**: IF `validateRegistryUrl` recibe una URL cuyo hostname resuelve a
  una IP privada, loopback, link-local o de cloud metadata
  (`169.254.169.254`), THEN the system SHALL lanzar `SSRFViolationError` con
  mensaje que identifique la IP bloqueada, sin exponer el stack trace al
  cliente.

- **AC-6**: WHEN `src/mcp/url-validator.ts` importa la lógica de validación,
  the system SHALL seguir funcionando sin breaking change — `validateGatewayUrl`
  mantendrá su firma, lanzará `MCPToolError(-32602)`, y la suite MCP existente
  SHALL pasar verde.

- **AC-7**: WHEN el test runner ejecuta la suite completa, the system SHALL
  mantener un mínimo de 480 tests pasando (baseline actual), con nuevos tests
  unitarios para `src/lib/url-validator.ts` que cubran: IPv4 privado, IPv6
  loopback, `169.254.169.254`, hostname `localhost`, URL inválida, URL pública
  válida, y bypass por allowlist.

## Scope IN

| Archivo | Operación |
|---------|-----------|
| `src/lib/url-validator.ts` | NEW — extraer lógica compartida de `src/mcp/url-validator.ts`; exponer `validateRegistryUrl` + `SSRFViolationError` |
| `src/mcp/url-validator.ts` | MODIFY — re-exportar desde `src/lib/url-validator.ts`; `validateGatewayUrl` sigue lanzando `MCPToolError` (adaptador sobre la nueva función) |
| `src/services/discovery.ts` | MODIFY — llamar `validateRegistryUrl` antes del `fetch` en `queryRegistry` (líneas 153, 190-196) |
| `src/routes/registries.ts` | MODIFY — llamar `validateRegistryUrl` en POST y PATCH para `discoveryEndpoint` e `invokeEndpoint` antes de delegar al service |
| `src/services/registry.ts` | MODIFY (opcional, si DT-1 lo requiere) — añadir llamada a `validateRegistryUrl` como segunda línea de defensa en `register`/`update` |
| `tests/unit/lib/url-validator.test.ts` | NEW — unit tests de `validateRegistryUrl` |
| `tests/unit/services/discovery.ssrf.test.ts` | NEW — tests de `queryRegistry` con endpoint SSRF |
| `tests/integration/registries.ssrf.test.ts` | NEW — tests de POST/PATCH /registries con endpoint SSRF |

## Scope OUT

- NO modificar `src/mcp/tools/` ni otros MCP tools
- NO modificar lógica de `requirePaymentOrA2AKey`
- NO agregar validación SSRF al campo `agentEndpoint` (no se usa para fetch
  server-side actualmente — `[TBD]` para WKH-63 o issue separado)
- NO cambiar schema de base de datos (Supabase `registries` table)
- NO añadir rate-limiting ni auth adicional (fuera de scope)

## Decisiones técnicas

- **DT-1 — Ubicación del validator**: La lógica core (`isPrivateIPv4`,
  `isPrivateIPv6`, `isBlockedHostnameLiteral`, DNS lookup) se mueve a
  `src/lib/url-validator.ts`. `src/mcp/url-validator.ts` la importa y envuelve
  en `MCPToolError`. Esto evita duplicar 180 líneas y mantiene el contrato MCP
  sin tocar. Alternativa descartada: dejar en `src/mcp/` e importar desde
  services — violaría la convención de que `src/services/` no importa de
  `src/mcp/`.

- **DT-2 — Nombre de la env var para allowlist**: `DISCOVERY_SSRF_ALLOWLIST`
  (separado de `MCP_GATEWAY_ALLOWLIST`) para que los dos contextos puedan
  tener allowlists distintas sin acoplamiento. Cada función lee su propia
  variable.

- **DT-3 — Punto de validación en routes vs service**: La validación primaria
  se sitúa en `src/routes/registries.ts` (previo a llamar al service) para
  responder con 422 con campo preciso. `src/services/registry.ts` puede añadir
  una segunda llamada como defensa en profundidad (opcional). `discovery.ts`
  valida en el momento del fetch (no al leer de DB) para cubrir registros que
  existían antes de este fix.

- **DT-4 — Tipo de error en discovery**: `SSRFViolationError extends Error`
  (no `MCPToolError`) se lanza desde `src/lib/url-validator.ts`. El circuit
  breaker de discovery lo captura y propaga como error de registry, mismo
  comportamiento que un registry que devuelve 5xx. El caller de
  `queryAllRegistries` ya tiene manejo de errores por registry.

## Constraint Directives

- **CD-1**: PROHIBIDO que `src/services/` importe de `src/mcp/`. La
  dependencia siempre va en sentido `src/mcp/` → `src/lib/`.
- **CD-2**: PROHIBIDO exponer el stack trace de `SSRFViolationError` al cliente
  HTTP. El handler de routes devuelve solo `{ error, field, reason }`.
- **CD-3**: OBLIGATORIO que `validateGatewayUrl` en `src/mcp/url-validator.ts`
  mantenga exactamente la misma firma: `(rawUrl: string) => Promise<URL>`.
  Breaking change en MCP tools es BLOQUEANTE en AR.
- **CD-4**: OBLIGATORIO env var `DISCOVERY_SSRF_ALLOWLIST` (no hardcode de IPs
  en código). Si se necesita bypass en staging, se agrega al `.env`.
- **CD-5**: OBLIGATORIO baseline 480 tests verde. Si cualquier test existente
  rompe por esta HU, es BLOQUEANTE en AR.
- **CD-6**: PROHIBIDO que `src/lib/url-validator.ts` importe de
  `src/mcp/types.ts` (evitar dependencia circular).

## Missing Inputs

- `agentEndpoint` — ¿debe también validarse contra SSRF? Actualmente no se
  usa en fetches server-side pero se persiste. Marcado `[NEEDS CLARIFICATION]`;
  excluido del scope hasta aclaración.
- Comportamiento en IPv6 mapped (`::ffff:169.254.169.254`) — el validator
  actual no lo cubre. Marcado `[TBD]` para que Architect decida si incluir o
  trackear como deuda técnica.

## Análisis de paralelismo

- Esta HU es prerequisito de **WKH-63** (registries cross-tenant): sin SSRF
  fix, WKH-63 amplifica el vector de ataque. WKH-63 debe bloquearse hasta que
  WKH-62 esté en `main`.
- No bloquea otras HUs en vuelo que no tocan discovery ni registries.
- Puede desarrollarse en paralelo con cualquier HU que no modifique
  `src/services/discovery.ts` o `src/routes/registries.ts`.
