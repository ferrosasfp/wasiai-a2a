# Work Item — [WKH-MCP-X402] MCP Server x402 — Tools para Claude Managed Agent

## Resumen

Construir un MCP Server production-grade montado como plugin Fastify en wasiai-a2a que expone 4 herramientas x402 (`pay_x402`, `get_payment_quote`, `discover_agents`, `orchestrate`) consumibles por Claude Managed Agent y cualquier cliente MCP compatible. El servidor reutiliza el `KiteOzonePaymentAdapter` existente para signing EIP-712, no duplica lógica de pago, y agrega auth propia via `X-MCP-Token`.

---

## Sizing

- **SDD_MODE:** full
- **Flow:** QUALITY
- **Estimación:** L
- **Branch sugerido:** `feat/042-mcp-server-x402`
- **NNN asignado:** 042

**Justificación QUALITY/L:**
- Nuevo protocolo (MCP JSON-RPC 2.0) — spec a implementar desde cero
- Toca el payment signing path (superficie de seguridad crítica)
- Auth propia (`X-MCP-Token`) con rate limiting por token
- 4 tools con schemas de input/output estrictos
- Tests unitarios + integración obligatorios
- Integra con 3 servicios existentes (payment adapter, discover, orchestrate)
- Mínimo 4 waves de implementación

---

## Acceptance Criteria (EARS)

### Tool: pay_x402
- **AC-1:** WHEN a MCP client calls `pay_x402` con `gatewayUrl`, `endpoint`, `method` y `payload` válidos, the system SHALL ejecutar el flujo completo x402 (request inicial → detect 402 → EIP-712 sign via `KiteOzonePaymentAdapter.sign()` → retry con header `payment-signature` → retornar `{ result, txHash, amountPaid }`) en una sola invocación.
- **AC-2:** WHEN la respuesta del gateway externo NO es 402, the system SHALL retornar el resultado directamente sin realizar firma ni pago.
- **AC-3:** IF `KiteOzonePaymentAdapter.sign()` lanza error (ej: `OPERATOR_PRIVATE_KEY` no disponible), THEN the system SHALL retornar MCP error estructurado con `code: -32001` y `message` descriptivo, sin exponer el stack trace.
- **AC-4:** IF el retry con `payment-signature` retorna status distinto de 2xx, THEN the system SHALL retornar MCP error con `code: -32002` incluyendo el HTTP status y body del gateway externo.

### Tool: get_payment_quote
- **AC-5:** WHEN a MCP client calls `get_payment_quote` con `gatewayUrl` y `endpoint`, the system SHALL realizar una petición HEAD/GET al endpoint externo y retornar `{ required: boolean, amount?: string, token?: string, network?: string }` sin ejecutar ningún pago.
- **AC-6:** IF el endpoint externo responde con 402, the system SHALL parsear el body `X402Response` y retornar los campos `maxAmountRequired`, `asset` y `network` del primer elemento de `accepts`.

### Tool: discover_agents
- **AC-7:** WHEN a MCP client calls `discover_agents` con `query` (string) y `maxPrice` (number, opcional) y `capabilities` (string[], opcional), the system SHALL invocar internamente el servicio de discovery existente y retornar la lista de agentes en formato `{ agents: AgentSummary[] }` sin llamadas HTTP adicionales al exterior.
- **AC-8:** WHILE `discover_agents` se ejecuta, the system SHALL aplicar el mismo timeout configurado en `TIMEOUT_ORCHESTRATE_MS` (default 120 s) para prevenir cuelgues indefinidos.

### Tool: orchestrate
- **AC-9:** WHEN a MCP client calls `orchestrate` con `goal` (string) y `budget` (number), the system SHALL invocar el servicio de orquestación existente y retornar `{ orchestrationId, steps, result, kiteTxHash? }`.
- **AC-10:** WHERE el campo `a2aKey` es provisto en la llamada `orchestrate`, the system SHALL inyectarlo como `x-a2a-key` header en la invocación interna al servicio de orquestación en lugar de ejecutar pago x402.

### Auth y seguridad
- **AC-11:** WHEN cualquier request llega a `POST /mcp` sin header `X-MCP-Token` válido, the system SHALL retornar `{ jsonrpc: "2.0", error: { code: -32600, message: "Unauthorized" }, id: null }` con HTTP 401.
- **AC-12:** WHILE un token MCP excede `MCP_RATE_LIMIT_MAX` requests por ventana (default: 30/min, env: `MCP_RATE_LIMIT_MAX`), the system SHALL retornar `{ jsonrpc: "2.0", error: { code: -32029, message: "Too Many Requests" }, id }` con HTTP 429.
- **AC-13:** the system SHALL validar tokens MCP comparando `sha256(X-MCP-Token)` contra `MCP_TOKEN_HASH` (env var) o una lista en `MCP_TOKENS` (JSON array de hashes). Si ninguno hace match, rechazar con 401.

### Protocolo MCP
- **AC-14:** WHEN el endpoint `POST /mcp` recibe un JSON-RPC 2.0 válido con `method: "tools/list"`, the system SHALL retornar el manifest de las 4 tools con sus schemas JSON Schema completos (inputSchema, description).
- **AC-15:** IF el body de `POST /mcp` no es JSON-RPC 2.0 válido (falta `jsonrpc`, `method` o `id`), THEN the system SHALL retornar `{ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }` con HTTP 200.
- **AC-16:** WHEN `method: "tools/call"` recibe un `name` de tool no reconocido, the system SHALL retornar `{ error: { code: -32601, message: "Method not found" } }`.

### Observabilidad
- **AC-17:** WHEN cualquier tool MCP es invocada, the system SHALL registrar un log estructurado con `{ requestId, mcpToken: "<primeros 8 chars>", tool, durationMs, success }` usando el logger de Fastify.
- **AC-18:** WHEN cualquier tool MCP es invocada, the system SHALL incrementar el contador Prometheus `mcp_tool_calls_total{tool, status}` donde `status` es `"success"` o `"error"`.

### TypeScript
- **AC-19:** the system SHALL compilar sin errores con `tsc --noEmit` en modo strict (sin `any` explícito, sin `as unknown as X`).

---

## Scope IN

| Path | Acción |
|------|--------|
| `src/mcp/index.ts` | Plugin Fastify — registro de rutas MCP |
| `src/mcp/router.ts` | JSON-RPC dispatcher: `tools/list`, `tools/call` |
| `src/mcp/auth.ts` | Validación `X-MCP-Token` (preHandler) |
| `src/mcp/rate-limit.ts` | Rate limiting por token (wrapper de `@fastify/rate-limit`) |
| `src/mcp/tools/pay-x402.ts` | Implementación tool `pay_x402` |
| `src/mcp/tools/get-payment-quote.ts` | Implementación tool `get_payment_quote` |
| `src/mcp/tools/discover-agents.ts` | Implementación tool `discover_agents` |
| `src/mcp/tools/orchestrate.ts` | Implementación tool `orchestrate` |
| `src/mcp/schemas.ts` | JSON Schema de input/output de las 4 tools |
| `src/mcp/types.ts` | Tipos TypeScript MCP (MCPRequest, MCPResponse, ToolCall, etc.) |
| `src/index.ts` | Agregar `fastify.register(mcpPlugin, { prefix: '/mcp' })` |
| `test/mcp/` | Tests unitarios e integración por tool |
| `.env.example` | Agregar `MCP_RATE_LIMIT_MAX`, `MCP_TOKEN_HASH`, `MCP_TOKENS` |

---

## Scope OUT

- Otras blockchains (solo Kite/KXUSD)
- Cache o persistencia de llamadas MCP
- Multi-tenant management (no DB de tokens MCP)
- Streaming SSE desde MCP (solo request/response)
- MCP SDK oficial (`@modelcontextprotocol/sdk`) — implementación directa JSON-RPC para evitar deps pesadas [NEEDS CLARIFICATION: si el humano prefiere usar el SDK oficial, esto cambia la arquitectura]
- UI Dashboard para métricas MCP
- Websocket transport para MCP

---

## Decisiones técnicas (DT-N)

- **DT-1:** El MCP Server se monta como plugin Fastify en `/mcp` (no proceso separado), compartiendo logger, rate limiter global y error boundary. Justificación: máxima reutilización de infraestructura existente, sin overhead operacional de un segundo proceso.
- **DT-2:** `pay_x402` usa directamente `KiteOzonePaymentAdapter.sign()` importado desde `src/adapters/kite-ozone/payment.ts`. PROHIBIDO reimplementar EIP-712 signing en el módulo MCP.
- **DT-3:** Auth MCP via `sha256(X-MCP-Token)` comparado contra env vars (`MCP_TOKEN_HASH` o `MCP_TOKENS`). No se persiste en DB en esta iteración — auth estática basada en env.
- **DT-4:** Rate limiting MCP por token usa un `keyGenerator` custom en `@fastify/rate-limit` que extrae `X-MCP-Token`. Límite independiente del rate limit global del servidor.
- **DT-5:** `discover_agents` y `orchestrate` invocan los servicios internos directamente (`discoveryService`, `orchestrateService`) — no hacen HTTP a `localhost:3001`. Esto evita latencia de red y el overhead de auth interno.
- **DT-6:** El JSON-RPC dispatcher sigue el protocolo MCP spec (method `tools/list` + `tools/call`), suficiente para Claude Managed Agent. No se implementa `resources/*` ni `prompts/*` en esta HU.

---

## Constraint Directives (CD-N)

- **CD-1:** PROHIBIDO reimplementar EIP-712 signing. Todo signing pasa por `KiteOzonePaymentAdapter.sign()`.
- **CD-2:** PROHIBIDO usar `any`, `as unknown`, o `as unknown as T` en el módulo `src/mcp/`. TypeScript strict total.
- **CD-3:** PROHIBIDO loggear el valor completo de `X-MCP-Token`. Solo los primeros 8 caracteres en logs.
- **CD-4:** PROHIBIDO hardcodear URLs, tokens, hashes o límites. Todo desde env vars con defaults explícitos documentados.
- **CD-5:** OBLIGATORIO que cada tool retorne errores en formato MCP JSON-RPC 2.0 (`{ error: { code, message } }`), nunca raw HTTP errors.
- **CD-6:** OBLIGATORIO tests para: auth válida, auth inválida, rate limit excedido, cada tool en happy path, y `tools/list`.
- **CD-7:** PROHIBIDO que `pay_x402` ejecute settle (cobrar al facilitador) — ese es el flujo del servidor receptor. `pay_x402` solo firma y adjunta el header al request saliente; el settle lo hace el gateway externo.

---

## Wave Plan (QUALITY)

| Wave | Contenido | Archivos clave |
|------|-----------|----------------|
| W1 — Scaffolding + Auth | Tipos MCP, schemas, plugin base, preHandler auth, test auth | `src/mcp/types.ts`, `src/mcp/schemas.ts`, `src/mcp/auth.ts`, `src/mcp/index.ts` |
| W2 — Router + tools/list | JSON-RPC dispatcher, `tools/list`, rate limit por token | `src/mcp/router.ts`, `src/mcp/rate-limit.ts` |
| W3 — Tools pay + quote | `pay_x402`, `get_payment_quote` con tests | `src/mcp/tools/pay-x402.ts`, `src/mcp/tools/get-payment-quote.ts` |
| W4 — Tools discover + orchestrate | `discover_agents`, `orchestrate`, registro en `src/index.ts` | `src/mcp/tools/discover-agents.ts`, `src/mcp/tools/orchestrate.ts`, `src/index.ts` |

---

## Missing Inputs

- **[NEEDS CLARIFICATION]** MCP SDK: ¿usar `@modelcontextprotocol/sdk` oficial o implementación JSON-RPC directa? Impacta deps y estructura del router. Se asume implementación directa hasta aclaración.
- **[resuelto en F2]** Formato exacto del `tools/call` response para cada tool — se define en F2 con schemas completos.
- **[resuelto en F2]** Estrategia de validación de múltiples tokens MCP (`MCP_TOKEN_HASH` single vs `MCP_TOKENS` array) — detalle de implementación para F2.

---

## Análisis de paralelismo

| HU activa | ¿Bloquea WKH-MCP-X402? | Notas |
|-----------|------------------------|-------|
| WKH-037-X402-V2 (in progress) | **Potencial bloqueo parcial** | `pay_x402` depende de `KiteOzonePaymentAdapter`. Si X402-V2 modifica la interfaz `sign()` o `SignRequest`, W3 debe esperar que X402-V2 mergeé. Recomendado: esperar merge de WKH-037 antes de implementar W3. |
| WKH-026-hardening (in progress) | No bloquea | MCP reutiliza middleware de hardening existente, compatible. |
| WKH-025-a2a-key (in progress) | No bloquea | `orchestrate` tool puede usar el path A2A key ya implementado. |
| WKH-029-e2e-tests (in progress) | No bloquea | Tests MCP son independientes. |

**Recomendación:** iniciar W1 + W2 en paralelo con HUs activas. Bloquear W3 hasta que WKH-037 (x402 v2 migration) esté en DONE, para no implementar sobre una interfaz que va a cambiar.
