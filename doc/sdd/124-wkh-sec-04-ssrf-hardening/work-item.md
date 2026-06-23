# Work Item — [WKH-SEC-04] SSRF Hardening: URL final en MCP tools + revalidación invokeUrl en compose

## Resumen

Dos vulnerabilidades SSRF confirmadas en auditoría project-wide (`doc/sdd/_AUDIT-100-C-input-ssrf-rce.md`):
1. Los MCP tools `pay_x402` y `get_payment_quote` validan `gatewayUrl` pero fetchean `gatewayUrl + endpoint` sin revalidar la URL final, lo que permite un userinfo bypass que enruta a hosts internos.
2. `compose.invokeAgent` ejecuta `fetch(agent.invokeUrl)` sin revalidación SSRF runtime, a diferencia del patrón establecido en `discovery.ts:529`, exponiendo headers de autenticación a posibles hosts atacantes vía TOCTOU/DNS-rebinding.

## Sizing

- SDD_MODE: full
- Estimación: S
- Branch sugerido: `feat/124-wkh-sec-04-ssrf-hardening`

## Skills

- security-hardening
- backend-typescript

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `pay_x402` o `get_payment_quote` reciben un `endpoint` cuya URL final (`gatewayUrl + endpoint`) resuelve a una IP privada, loopback o link-local (incluyendo el vector userinfo `@169.254.169.254`), THEN el sistema SHALL rechazar la request antes del fetch, retornando MCPToolError(-32602) sin ejecutar ninguna llamada de red.

- **AC-2**: WHEN el campo `endpoint` en el schema JSON de `pay_x402` o `get_payment_quote` recibe un valor que NO comienza con `/`, the system SHALL rechazar la validación de schema con un error de formato antes de ejecutar la tool, sin llegar al código de fetching.

- **AC-3**: WHEN `compose.invokeAgent` va a ejecutar `fetch(agent.invokeUrl)`, the system SHALL llamar `validateRegistryUrl(agent.invokeUrl)` antes del fetch; IF `validateRegistryUrl` lanza `SSRFViolationError`, THEN el system SHALL abortar ese step del pipeline con un error estructurado, sin exponer headers `x-a2a-key` ni `PAYMENT-SIGNATURE` al host bloqueado.

- **AC-4**: WHILE `agent.invokeUrl` corresponde a un host público legítimo registrado en un registry válido, the system SHALL completar la invocación de compose sin degradación observable (mismo comportamiento que antes del fix).

- **AC-5**: WHEN se construye la URL final en MCP tools, the system SHALL usar `new URL(endpoint, gatewayUrl)` (o construcción equivalente segura) y validar ESA URL resultante con `validateOutboundUrl` / `validateGatewayUrl` ANTES de cualquier fetch, rechazando si el host difiere del host de `gatewayUrl` o resuelve a IP privada.

## Scope IN

| Archivo | Cambio |
|---------|--------|
| `src/mcp/schemas.ts:29` | Campo `endpoint` de `pay_x402`: agregar `pattern: '^/'` |
| `src/mcp/schemas.ts:45` | Campo `endpoint` de `get_payment_quote`: agregar `pattern: '^/'` |
| `src/mcp/tools/pay-x402.ts:88` | Construir URL final segura y llamar `validateGatewayUrl` sobre ella antes de fetch |
| `src/mcp/tools/get-payment-quote.ts:28` | Construir URL final segura y llamar `validateGatewayUrl` sobre ella antes de fetch |
| `src/services/compose.ts:428` | Agregar `await validateRegistryUrl(agent.invokeUrl)` antes del `fetch`, abortar step en SSRFViolationError |
| Tests: nuevo archivo `src/mcp/tools/pay-x402.ssrf.test.ts` | Tests para userinfo bypass, endpoint path restriction |
| Tests: nuevo archivo `src/mcp/tools/get-payment-quote.ssrf.test.ts` | Tests para el mismo vector en get-payment-quote |
| Tests: extensión de `src/services/discovery.ssrf.test.ts` o nuevo `compose.ssrf.test.ts` | Test compose revalida invokeUrl |

## Scope OUT

- `src/lib/url-validator.ts`: NO modificar — el core validator ya es correcto y maneja todos los rangos privados incluyendo 169.254.x.x y userinfo
- `src/mcp/url-validator.ts`: NO modificar la interfaz pública (`validateGatewayUrl`) — solo se usa, no se cambia
- Endpoints REST (`/registries`, `/discover`, `/orchestrate`): ya tienen validación correcta, fuera de scope
- `gasless.ts` MNR-1 (validación de `to`): clasificado como MENOR en auditoría, NO incluir en esta HU
- Errores de mensaje crudo al cliente (MNR-2 de auditoría en registries/orchestrate/dashboard): NO incluir
- DB schema, migrations, RLS: no afectados
- MCP tools `discover_agents` y `orchestrate`: no tienen el patrón de concat, fuera de scope

## Decisiones técnicas (DT-N)

- **DT-1**: Para la construcción segura de la URL final en MCP tools, usar `new URL(endpoint, gatewayUrl).toString()` — esto normaliza correctamente el userinfo bypass porque `new URL("@169.254.169.254/foo", "https://ok.com")` resuelve al host `169.254.169.254`, que luego es rechazado por `validateGatewayUrl`. Alternativa `gatewayUrl + endpoint` queda prohibida porque no normaliza el userinfo. La llamada a `validateGatewayUrl` se hace sobre la URL final construida, no sobre `gatewayUrl` sola.

- **DT-2**: En `compose.ts`, usar `validateRegistryUrl` (no `validateGatewayUrl`) porque `invokeUrl` pertenece al dominio de los registries (usa `DISCOVERY_SSRF_ALLOWLIST`). Mismo patrón que `discovery.ts:529`. En caso de `SSRFViolationError`, marcar el step como fallido con error descriptivo sin propagar el invokeUrl al cliente.

- **DT-3**: El `pattern: '^/'` en schema `endpoint` es primera línea de defensa (bloqueo temprano antes de construir la URL). No reemplaza la validación de la URL final — ambas defensas son necesarias (defense-in-depth). El pattern debe aplicarse tanto en el schema JSON de `INPUT_SCHEMAS` como en el tipo TypeScript correspondiente en `src/mcp/types.ts` si tiene validación de runtime.

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO llamar `validateGatewayUrl` solo sobre `input.gatewayUrl` antes del fetch de la URL final. La validación DEBE ejecutarse sobre la URL construida `new URL(input.endpoint, input.gatewayUrl).toString()`. La validación actual de `gatewayUrl` puede permanecer como primera defensa pero NO como única defensa.

- **CD-2**: PROHIBIDO silenciar/ignorar el `SSRFViolationError` en `compose.invokeAgent` — el error DEBE abortar el step actual y ser registrado con `logger.warn` (mismo patrón que `discovery.ts:531`). No se propagará al pipeline global como error irrecuperable; se lanza para que el llamador del step lo maneje.

- **CD-3**: OBLIGATORIO que los nuevos tests MCP sigan el patrón de `discovery.ssrf.test.ts`: mock de `node:dns` con `vi.mock`, `vi.stubGlobal('fetch', mockFetch)`, y assert que `fetch` NO fue llamado cuando la URL final resuelve a IP privada.

- **CD-4**: PROHIBIDO modificar la firma pública de `validateGatewayUrl` ni `validateRegistryUrl` — son contratos compartidos.

## Missing Inputs

- Ninguno bloqueante. Los hallazgos son confirmados con línea exacta en la auditoría. El patrón de fix es claro y ya existe en `discovery.ts:529`.

## Análisis de paralelismo

- Esta HU es independiente de WKH-123 (si existe en el batch) en términos de archivos modificados.
- No bloquea ni es bloqueada por otras HUs activas. La rama `fix/117-session-dest-cap` (branch actual del repo) no toca los archivos en scope.
- Puede desplegarse en producción de forma autónoma sin coordinación con otras HUs pendientes.
