# SDD — WKH-MCP-X402 · MCP Server x402 — Tools para Claude Managed Agent

**Status:** DRAFT (pending `SPEC_APPROVED`)
**Flow:** QUALITY · **Mode:** full · **Estimación:** L · **Branch:** `feat/042-mcp-server-x402`
**Work Item:** `doc/sdd/WKH-MCP-X402/work-item.md`
**ACs cubiertos:** AC-1 … AC-19 (19/19)

---

## 0. Resumen ejecutivo

Se construye un **plugin Fastify** montado en `/mcp` que implementa el subset del **Model Context Protocol** necesario para que Claude Managed Agent (y cualquier cliente MCP compatible) consuma cuatro tools x402 del gateway WasiAI A2A:

| Tool | Responsabilidad | Reusa |
|------|-----------------|-------|
| `pay_x402` | Ejecuta el flujo completo cliente x402 (fetch → detect 402 → firma EIP-712 → retry con `payment-signature`) | `KiteOzonePaymentAdapter.sign()` |
| `get_payment_quote` | Pregunta a un endpoint externo si requiere x402 y parsea `X402Response` | (sin reuso de servicios internos) |
| `discover_agents` | Busca agentes en los registries registrados | `discoveryService.discover()` |
| `orchestrate` | Goal-based orchestration | `orchestrateService.orchestrate()` |

El transporte MCP elegido es **JSON-RPC 2.0 puro sobre HTTP POST** (sin SDK, sin SSE, sin stdio) — ver **DT-1**.

---

## 1. Context Map — archivos leídos y patrones extraídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/adapters/kite-ozone/payment.ts` (L236-274) | `sign()` es el único camino autorizado para firmar EIP-712 (CD-1) | Firma: `(opts: SignRequest) => Promise<SignResult>`. `SignRequest = { to: 0x..., value: string (wei), timeoutSeconds?: number }`. `SignResult = { xPaymentHeader: string (base64), paymentRequest: X402PaymentRequest }`. Lanza `Error('OPERATOR_PRIVATE_KEY not set — x402 client signing disabled')` si falta env. |
| `src/adapters/types.ts` (L35-43) | Contrato estable de `SignRequest`/`SignResult` | Dos interfaces ya tipadas — se importan tal cual, **no** se redefinen en `src/mcp/`. |
| `src/middleware/x402.ts` (L57-80) | `decodeXPayment()` parsea el header — NO se reusa pero informa el payload | El cliente envía el header `payment-signature` con el base64 generado por `sign()`. Nada más. |
| `src/middleware/x402.ts` (L30-55) | `buildX402Response()` genera el body 402 | El servidor externo responde con `{ error, accepts: X402PaymentPayload[], x402Version: 2 }`. `pay_x402` consume ese shape. |
| `src/middleware/rate-limit.ts` (completo) | Cómo se integra `@fastify/rate-limit` en este repo | Wrapper con `errorResponseBuilder` que retorna un `Error` con `.statusCode`, `.code`, `.retryAfterMs` (ver Auto-blindaje 026 — "plain objects no son Errors"). |
| `src/middleware/error-boundary.ts` (completo) | Pipe de errores centralizado | `setErrorHandler` global ya aplica la normalización — MCP **debe** traducir **antes** de tirar al boundary, porque MCP necesita forma JSON-RPC, no `{ error, code, requestId }`. |
| `src/services/discovery.ts` (L15-107) | Firma de `discoveryService.discover(query: DiscoveryQuery)` | Retorna `DiscoveryResult = { agents: Agent[], total: number, registries: string[] }`. Acepta `{ query?, capabilities?, maxPrice?, limit?, includeInactive?, verified?, registry? }`. |
| `src/services/orchestrate.ts` (L224-422) | Firma `orchestrate(req, orchestrationId)` | Retorna `OrchestrateResult = { orchestrationId, answer, reasoning, pipeline: ComposeResult, consideredAgents, protocolFeeUsdc }`. `OrchestrateRequest = { goal, budget, preferCapabilities?, maxAgents? }`. |
| `src/routes/orchestrate.ts` (L9-96) | Cómo se invoca el servicio desde una route | Genera `orchestrationId = crypto.randomUUID()`, agrega `orchestrationId` al error y re-throw. Usa `request.paymentTxHash` para adjuntar `kiteTxHash`. |
| `src/routes/discover.ts` (L62-110) | Normalización de input POST → `DiscoveryQuery` | `capabilities` puede venir como string o array; se normaliza. |
| `src/routes/metrics.ts` (L37-63, L72-144) | Pattern Prometheus con Map in-memory | Plugin `FastifyPluginAsync` expone `GET /` que serializa `stats` + `# HELP/# TYPE/<metric>` líneas. Para MCP: se agrega un `Map<tool, { success: number; error: number }>` y se concatena al output. **Ver DT-9** para la extensión. |
| `src/routes/auth.test.ts` (L1-80) | Pattern de test con `Fastify.inject()` + `vi.mock()` | `vi.mock('../services/...')` al tope del archivo (antes de imports del módulo bajo test). `vi.mocked(...)` para tipar mocks. |
| `src/middleware/rate-limit.test.ts` (completo) | Pattern para test de rate-limit | Usa `app.inject()` y chequea `statusCode`, body JSON, y header `retry-after`. |
| `src/middleware/a2a-key.ts` (completo) | Pattern de preHandler async que lee header + retorna 403 estructurado | Auth MCP sigue el mismo shape (un solo handler en array). |
| `src/middleware/security-headers.ts` | `onSend` hook global ya aplica `x-content-type-options` y `x-frame-options` | No hace falta reaplicar en el plugin MCP. |
| `src/index.ts` (L24-95) | Orden de registro de plugins | Lugar donde se agrega `await fastify.register(mcpPlugin, { prefix: '/mcp' })` — **después** de `metricsRoutes` (L95). |
| `package.json` | Stack versions | Fastify 5.8.4, `@fastify/rate-limit` 10.3.0, vitest 4.1.4, Node ≥20. |
| `.env.example` (L90-107) | Convenciones para envs | Grupos con separadores ASCII; defaults documentados. |

**Auto-blindaje leído (últimas 3 DONEs relevantes):**
- `doc/sdd/026-hardening/auto-blindaje.md` → rate-limit v10 + Error objects + FastifyError cast
- `doc/sdd/029-e2e-tests/auto-blindaje.md` → depth de relative paths en tests
- `doc/sdd/038-biome-linter/auto-blindaje.md` → biome no rompe `function()` para constructor mocks
- `doc/sdd/035-bearer-fix/auto-blindaje.md` → mocks deben respetar todas las props del type (`registries: []` en `DiscoveryResult`)

Los CD-8/CD-9 bajo heredan de estos hallazgos.

---

## 2. Decisiones técnicas (DT)

### DT-1 · JSON-RPC directo, sin `@modelcontextprotocol/sdk` ✅ RESUELTA

**Investigación (`npm view @modelcontextprotocol/sdk@1.29.0`):**
```
engines: node >=18
dependencies: {
  "express": "^5.2.1",
  "hono": "^4.11.4",
  "@hono/node-server": "^1.19.9",
  "cors": "^2.8.5",
  "ajv": "^8.17.1", "ajv-formats": "^3.0.1",
  "zod": "^3.25 || ^4.0", "zod-to-json-schema": "^3.25.1",
  "jose": "^6.1.3", "pkce-challenge": "^5.0.0",
  "eventsource": "^3.0.2", "eventsource-parser": "^3.0.0",
  "content-type": "^1.0.5", "cross-spawn": "^7.0.5",
  "raw-body": "^3.0.0", "json-schema-typed": "^8.0.2",
  "express-rate-limit": "^8.2.1"
}
```

**Decisión:** NO usar el SDK. Implementación JSON-RPC directa.

**Justificación:**
- El SDK trae **Express 5 + Hono + Zod + ajv + jose + pkce** como deps — duplica frameworks HTTP, rate limit, schemas y auth que ya resolvemos con Fastify. La instrucción del usuario "production-grade, robusto y escalable" **favorece** minimizar deps y superficies de ataque (jose/pkce abren OAuth flows que no usamos).
- El subset que Claude Managed Agent pide (`tools/list` + `tools/call`) es **muy chico**: dos métodos JSON-RPC, sin streaming, sin resources, sin prompts. Escribirlo manual son ~150 LoC, tipados, sin loaders, sin peer deps que queden colgadas.
- El Golden Path del repo prohíbe `any`/`as unknown` (CD-2) y `zod-to-json-schema` genera schemas que JSON Schema + Fastify ya valida nativamente.
- El SDK no tiene adapter nativo Fastify — habría que envolverlo en un handler HTTP genérico, perdiendo la integración con `@fastify/rate-limit`, error boundary y `reply.elapsedTime`.

**Consecuencia:** 0 deps nuevas. Todo el código MCP se apoya en Fastify + stdlib (`node:crypto`) + `@fastify/rate-limit` v10 (ya instalado).

### DT-2 · Estructura del plugin (single `POST /mcp`)

- El plugin registra **un solo endpoint** `POST /` (prefix `/mcp` aplicado desde `src/index.ts`).
- Todos los `tools/list` y `tools/call` viajan por ese mismo POST — es el transporte MCP "streamable-http" en modo request/response (sin SSE).
- **No** se expone `GET /mcp`, `GET /mcp/tools`, etc. Solo el POST.
- `src/mcp/index.ts` hace el `fastify.post('/', { schema, preHandler: [auth] }, handler)`.

### DT-3 · Schemas por tool (inputSchema + outputSchema)

Cada tool tiene:
- **`inputSchema`** (JSON Schema Draft-07) validado por Fastify en el handler del router (`ajv` que ya trae Fastify).
- **`outputSchema`** (JSON Schema Draft-07) **solo para el manifest** `tools/list` — se documenta pero no se valida en runtime (el router confía que la implementación TS respeta el shape; TS strict + tipos en `types.ts` lo garantizan).

**Shape de los 4 tools (resumen — el detalle exacto va en `src/mcp/schemas.ts`):**

| Tool | `input` | `output` |
|------|---------|----------|
| `pay_x402` | `{ gatewayUrl: string (uri), endpoint: string, method: "GET"\|"POST"\|"PUT"\|"DELETE" (default "POST"), payload?: unknown, headers?: Record<string,string>, maxAmountWei?: string (pattern `^\\d+$`) }` | `{ status: number, result: unknown, txHash?: string, amountPaid?: string }` |
| `get_payment_quote` | `{ gatewayUrl: string (uri), endpoint: string }` | `{ required: boolean, amount?: string, token?: string, network?: string, description?: string }` |
| `discover_agents` | `{ query?: string, maxPrice?: number, capabilities?: string[], limit?: number (default 20, max 100) }` | `{ agents: Agent[], total: number, registries: string[] }` (reusa `DiscoveryResult`) |
| `orchestrate` | `{ goal: string, budget: number (>0), preferCapabilities?: string[], maxAgents?: number (1..20), a2aKey?: string }` | `{ orchestrationId: string, steps: ComposeStep[], result: unknown, kiteTxHash?: string, reasoning: string, protocolFeeUsdc: number }` |

Notas:
- `pay_x402.maxAmountWei` es **opcional** y funciona como "guard": si el 402 pide más, el tool retorna error `-32002` sin firmar (mitigación ante maliciosos gateways).
- `orchestrate.a2aKey`, cuando viene, se inyecta como header `x-a2a-key` al llamar internamente al servicio (ver DT-7).

### DT-4 · Inyección de `requestId` en los tools (contexto por llamada)

- El router JSON-RPC construye un `ToolContext = { requestId: string; tokenPrefix: string; log: FastifyBaseLogger; }` usando `request.id` (ya disponible por `genReqId`) + los primeros 8 chars del token (CD-3) + `request.log`.
- Cada tool recibe `(input, ctx)` — NO recibe `request`/`reply` (desacoplamiento; testable sin Fastify).
- Ejemplo de firma (pattern del repo, ver `src/services/orchestrate.ts` L224):
  ```ts
  export async function payX402(input: PayX402Input, ctx: ToolContext): Promise<PayX402Output> { ... }
  ```

### DT-5 · Auth — `sha256(X-MCP-Token)` contra `MCP_TOKEN_HASH` + `MCP_TOKENS`

- `MCP_TOKEN_HASH` (env, opcional) — un único hash hex64.
- `MCP_TOKENS` (env, opcional) — JSON array de hashes hex64: `'["hash1","hash2",...]'`.
- Se cargan **ambos** al startup; si **ninguno** está definido el endpoint retorna 503 con `Service MCP auth not configured` (como hace x402 cuando falta `KITE_WALLET_ADDRESS`).
- Comparación con `crypto.timingSafeEqual(Buffer.from(sha256(token), 'hex'), Buffer.from(expected, 'hex'))` — evita timing attacks (buffers son de 32 bytes, misma longitud garantizada).
- `MCP_TOKENS` parse malformado → startup falla rápido (`JSON.parse` + validación `Array.isArray && every(string hex64)`).
- **Token plaintext nunca entra al log**; solo los primeros 8 chars (CD-3). El hash tampoco se loguea.

### DT-6 · Rate limit por token — `keyGenerator` custom

- Usa `@fastify/rate-limit` con opciones **inline** (no plugin global re-registrado). Pattern: cada route puede declarar su propio `config.rateLimit`.
- `keyGenerator: (req) => req.headers['x-mcp-token'] ?? req.ip` — si por alguna razón el token no llegó (caso que el auth ya rechazó, pero defensivo), cae a IP.
- Límite **independiente** del global. Default: `MCP_RATE_LIMIT_MAX=30`, ventana `MCP_RATE_LIMIT_WINDOW_MS=60000`.
- `errorResponseBuilder` retorna un **Error** (no plain object — Auto-blindaje 026 #3) con `.statusCode = 429`, `.code = 'RATE_LIMIT_EXCEEDED'`, `.retryAfterMs`. El router **captura** esto **antes** del error boundary global y lo traduce a `{ jsonrpc: "2.0", error: { code: -32029, message: "Too Many Requests" }, id }` con HTTP 429 (AC-12).
- Derivación `statusCode` desde `context.ban ? 403 : 429` — no usar `context.statusCode` (Auto-blindaje 026 #4).

### DT-7 · `discover_agents` y `orchestrate` llaman servicios in-process

- **Nunca** HTTP a `localhost:3001/discover` — directo `discoveryService.discover(query)` y `orchestrateService.orchestrate(req, orchestrationId)`.
- Para `orchestrate`, cuando viene `a2aKey`, **no se hace bypass**: el servicio interno orchestrate no chequea auth (la chequea el middleware de la route `/orchestrate`). Nuestro tool MCP **opera como un caller interno de confianza** — el a2aKey solo se usa para propagar el crédito/budget del key al flujo de pagos cuando el orchestrate necesita pagar al agente final.
  - **Decisión concreta:** el tool MCP almacena la `a2aKey` en un campo contextual de `request` y lo pasa a un helper que, cuando el flujo necesite invocar al agente remoto, aplica el header `x-a2a-key` — **pero este path requiere que `orchestrateService.orchestrate()` acepte un parámetro nuevo `a2aKeyOverride?: string`** (NUEVO). **Ver impacto en §3.**
  - Alternativa simpler (preferida para AC-10): se introduce un parámetro opcional en `OrchestrateRequest` (`a2aKey?: string`) que la capa `orchestrateService` propaga a `composeService.compose()` (que ya usa headers por registry). **Esta es la ruta elegida.** Requiere toque mínimo en `src/types/index.ts` y `src/services/orchestrate.ts` + `src/services/compose.ts`.
- Para `discover_agents`: se reaplica el timeout `TIMEOUT_ORCHESTRATE_MS` (default 120 000 ms) con `AbortController` envolviendo la promesa. AC-8.

> **Nota de scope**: el cambio a `OrchestrateRequest` es **mínimo** y se mantiene **retro-compat** (campo opcional). Si el Adversary rechaza tocar tipos globales, plan B es que el tool MCP internamente llame `composeService.compose()` con el `a2aKey` como header en lugar de pasar por `orchestrateService.orchestrate()` — pero pierde el LLM planning, por eso se prefiere plan A. Ver **W4.3**.

### DT-8 · Error codes MCP JSON-RPC

| Código | Uso |
|--------|-----|
| `-32700` | Parse error (body no es JSON válido o no es JSON-RPC 2.0) — AC-15 |
| `-32600` | Invalid Request / Unauthorized (token inválido/missing) — AC-11 |
| `-32601` | Method not found — para método root (ni `tools/list` ni `tools/call`) o tool name no reconocido en `tools/call` — AC-16 |
| `-32602` | Invalid params (schema validation del input del tool) |
| `-32001` | Tool execution error — signing failed, servicio interno lanzó, etc. — AC-3 |
| `-32002` | Upstream gateway error — 402 retry devolvió !2xx, max amount excedido — AC-4 |
| `-32029` | Too Many Requests (custom, fuera del rango reservado -32000..-32099; alineado con HTTP 429) — AC-12 |

El mapeo está centralizado en `src/mcp/types.ts` como `const MCP_ERRORS = { PARSE_ERROR: -32700, ... } as const`.

### DT-9 · Métricas Prometheus `mcp_tool_calls_total{tool,status}`

- El plugin metrics actual (`src/routes/metrics.ts`) usa `stats: Map<string, RouteStat>` — no vamos a tocar ese archivo.
- En su lugar, `src/mcp/metrics.ts` expone un `Map<string, { success: number; error: number }>` y una función `renderMcpMetrics(): string` que retorna las líneas Prometheus.
- **Integración:** `src/routes/metrics.ts` hoy es un único handler que termina con `reply.type(...).send(lines.join('\n'))`. No podemos modificarlo sin tocarlo. Decisión: el plugin MCP **no** escribe en `src/routes/metrics.ts`. En cambio, el handler metrics actual se mantiene **y** el plugin MCP registra **su propio** sub-endpoint `GET /mcp/metrics` (opcional — puede leerlo Prometheus como un scrape target adicional) **O** se agrega un hook `fastify.decorate('mcpMetrics', {...})` y se modifica mínimamente `metrics.ts` para concatenar.

  **Decisión final (DT-9):** tocar `src/routes/metrics.ts` **es aceptable** porque (a) la modificación es aditiva (agregar 5 líneas que llaman a `renderMcpMetrics()` al final del `lines`), (b) el archivo ya agrega "Node.js process metrics" con el mismo patrón al final (L132-138). Se añade al final del handler justo antes de `return reply.type(...)...`.

  El W2 introduce un hook más limpio si da el tiempo: `fastify.decorate('prometheusContributors', [renderMcpMetrics])` y metrics.ts itera. **Pero para esta HU** se hace la concatenación directa (3 LoC en metrics.ts).

### DT-10 · No usar el SDK significa: no emitir `result.content[].type="text"` envelopes

MCP spec define que `tools/call` retorna `{ content: [{ type: "text", text: "..." }], isError?: boolean }`. Para máxima interoperabilidad con Claude Managed Agent:

- **`tools/call` SÍ devuelve `{ content: ToolContent[], isError?: boolean }`** (envelope MCP estándar).
- `ToolContent = { type: "text", text: string }` — serializamos el output del tool como `JSON.stringify(output)` dentro del `text` — este es el pattern que el SDK oficial aplica. Así Claude no necesita un shape custom.
- Si `isError: true`, el content contiene `JSON.stringify({ error: { code, message } })`.

Esto agrega un wrap en el router pero mantiene compatibilidad con cualquier MCP client.

---

## 3. Exemplars verificados (paths reales — Glob/Read confirmados)

| # | Exemplar | Ruta | Uso |
|---|----------|------|-----|
| E1 | `KiteOzonePaymentAdapter.sign()` — único path para EIP-712 | `src/adapters/kite-ozone/payment.ts` L236-274 | `pay_x402` lo importa y llama |
| E2 | Tipos `SignRequest`/`SignResult` | `src/adapters/types.ts` L35-43 | Import directo |
| E3 | `X402Response` shape | `src/types/index.ts` L258-262 | `get_payment_quote` + `pay_x402` parse |
| E4 | `X402PaymentPayload` shape | `src/types/index.ts` L233-253 | idem |
| E5 | Pattern `@fastify/rate-limit` con Error object en errorResponseBuilder | `src/middleware/rate-limit.ts` L19-32 | `src/mcp/rate-limit.ts` lo copia y ajusta `keyGenerator` |
| E6 | `discoveryService.discover()` firma + `DiscoveryQuery`/`DiscoveryResult` | `src/services/discovery.ts` L19 + `src/types/index.ts` L110-125 | `discover_agents` lo llama |
| E7 | `orchestrateService.orchestrate()` firma | `src/services/orchestrate.ts` L224-227 | `orchestrate` tool lo llama |
| E8 | Generación de `orchestrationId` | `src/routes/orchestrate.ts` L57 | `crypto.randomUUID()` |
| E9 | Pattern `AbortController` para timeout | `src/services/orchestrate.ts` L114-115, L176 | Aplicable a `pay_x402` fetch |
| E10 | Pattern Prometheus text `# HELP / # TYPE / metric{labels} value` | `src/routes/metrics.ts` L72-138 | `renderMcpMetrics()` |
| E11 | Registro del plugin en index | `src/index.ts` L77-95 | Se agrega `await fastify.register(mcpPlugin, { prefix: '/mcp' })` **después** de metricsRoutes (L95) |
| E12 | Pattern test Fastify `inject()` + `vi.mock` | `src/routes/auth.test.ts` L22-50 + `src/middleware/rate-limit.test.ts` | Todos los tests MCP siguen este shape |
| E13 | Pattern preHandler async que retorna 401/403 estructurado | `src/middleware/a2a-key.ts` L88-113 | `src/mcp/auth.ts` (pero devuelve 401 JSON-RPC shape) |
| E14 | `FastifyError` cast through `unknown` | Auto-blindaje 026 #1 | Para traducir errores del rate-limit capturados en catch |

Todos los paths verificados con `Glob`/`Read`. **No hay referencias huérfanas en este SDD.**

---

## 4. Constraint Directives (CD) — heredados + nuevos

**Heredados del work-item (CD-1 … CD-7):**

- **CD-1:** PROHIBIDO reimplementar EIP-712 signing. Todo signing pasa por `KiteOzonePaymentAdapter.sign()` (`src/adapters/kite-ozone/payment.ts`).
- **CD-2:** PROHIBIDO usar `any`, `as unknown as T`, `as any`, `// @ts-ignore` en `src/mcp/`. Si un cast inevitable aparece, debe justificarse como `as unknown` seguido de type guard runtime — ver AB-026 #1.
- **CD-3:** PROHIBIDO loggear el valor completo de `X-MCP-Token`. Solo los primeros 8 chars en logs.
- **CD-4:** PROHIBIDO hardcodear URLs, tokens, hashes, límites o fees. Todo desde env vars con defaults documentados en `.env.example`.
- **CD-5:** OBLIGATORIO que cada tool retorne errores en formato MCP JSON-RPC 2.0 (`{ error: { code, message, data? } }`), nunca raw HTTP errors ni stack traces al cliente.
- **CD-6:** OBLIGATORIO tests para: auth válida, auth inválida, rate limit excedido, cada tool en happy path, cada tool en su error path principal, `tools/list`, parse errors, method not found.
- **CD-7:** PROHIBIDO que `pay_x402` ejecute `settle()` del payment adapter. `pay_x402` solo **firma** y adjunta el header — el settle lo hace el gateway externo vía su propio facilitator.

**Nuevos (agregados en F2 según auto-blindaje histórico):**

- **CD-8:** PROHIBIDO llamar `biome check --write --unsafe` sobre archivos de test que contengan `vi.fn().mockImplementation(function() {...})` o mocks usados con `new` — rompe el constructor-mock pattern (AB-038 #1). Si ocurre, revertir manualmente a `function()` con `// biome-ignore lint/complexity/useArrowFunction: ...`.
- **CD-9:** OBLIGATORIO que todo mock de `discoveryService.discover()` en tests retorne `DiscoveryResult` **completo** — incluye el campo `registries: string[]` aunque sea `[]` (AB-035 #1).
- **CD-10:** OBLIGATORIO que los tests en `src/mcp/*.test.ts` calculen los relative imports desde su ubicación real — verificar con `node -e "require.resolve(...)"` antes de commit (AB-029 #1). Como todos los archivos de test MCP viven en `src/mcp/` o `src/mcp/tools/`, el depth es `../` o `../../`.
- **CD-11:** OBLIGATORIO pinear cualquier plugin Fastify nuevo a la major version compatible con Fastify 5. (Para esta HU, `@fastify/rate-limit@^10.3.0` ya está instalado y sirve — no se agregan deps).
- **CD-12:** OBLIGATORIO que cualquier `errorResponseBuilder` (rate-limit u otro) retorne una instancia real de `Error` con `.statusCode/.code/.retryAfterMs`, **nunca** un plain object (AB-026 #3).
- **CD-13:** OBLIGATORIO `timingSafeEqual` para la comparación de hashes SHA-256 del token MCP.
- **CD-14:** PROHIBIDO que el plugin MCP se registre **antes** de `registerRateLimit(fastify)` en `src/index.ts` — el global rate limit debe estar instanciado para que el plugin pueda invocarlo. Orden correcto: después de `metricsRoutes` (línea 95 actual).

---

## 5. Waves de implementación

### W0 — Setup inicial (serial, precondiciones)

- **W0.1** Crear estructura `src/mcp/` con `.gitkeep` o directamente con los archivos vacíos.
- **W0.2** Agregar entradas a `.env.example`:
  ```bash
  # ─── MCP Server (WKH-MCP-X402) ───────────────────────────
  # Token MCP — SHA-256 hash de un token bearer compartido con el cliente (Claude Managed Agent)
  MCP_TOKEN_HASH=
  # Alternativa multi-token: JSON array de hashes SHA-256 (hex64 cada uno)
  # Ejemplo: '["abc...64","def...64"]'
  MCP_TOKENS=
  # Rate limit por token MCP
  MCP_RATE_LIMIT_MAX=30
  MCP_RATE_LIMIT_WINDOW_MS=60000
  ```
- **W0.3** No se instalan deps nuevas (DT-1).

**Verificación W0 done:** `grep MCP_ .env.example` devuelve 4 líneas; `ls src/mcp/` existe.

### W1 — Tipos, schemas, auth (paralelizable tras W0)

Archivos:
- `src/mcp/types.ts` — `MCPRequest`, `MCPResponse`, `MCPError`, `ToolContext`, `MCP_ERRORS`, `ToolName` union, `ToolContent`.
- `src/mcp/schemas.ts` — `INPUT_SCHEMAS: Record<ToolName, JSONSchema>`, `OUTPUT_SCHEMAS: Record<ToolName, JSONSchema>`, `TOOL_DESCRIPTIONS: Record<ToolName, string>`. Exporta también `TOOLS_MANIFEST` (array para `tools/list`).
- `src/mcp/auth.ts` — `createMcpAuthHandler(): preHandlerAsyncHookHandler` que lee `X-MCP-Token`, calcula `sha256`, compara con `timingSafeEqual` contra lista de hashes, devuelve 401 con body JSON-RPC en fallo (AC-11). Uso de `MCP_TOKEN_HASH` + `MCP_TOKENS`.
- `src/mcp/auth.test.ts` — tests unitarios de auth:
  - Token válido → pasa
  - Token inválido → 401 + body JSON-RPC `-32600`
  - Sin header → 401
  - Sin ningún env configurado → 503 (fail closed)
  - `MCP_TOKENS` malformado al init → error de startup
  - Timing-safe: no early-return ante prefix match

**Verificación W1 done:** `npx tsc --noEmit` pasa, `npx vitest run src/mcp/auth.test.ts` pasa con 6+ tests verdes.

### W2 — Router JSON-RPC + tools/list + rate limit + plugin index (paralelizable tras W1)

Archivos:
- `src/mcp/rate-limit.ts` — `mcpRateLimitConfig()` que retorna `RateLimitPluginOptions` con `keyGenerator` custom (`X-MCP-Token` → fallback IP) + `errorResponseBuilder` (Error con `.statusCode=429`, `.code='RATE_LIMIT_EXCEEDED'`, `.retryAfterMs`).
- `src/mcp/router.ts` — exporta `dispatch(request: MCPRequest, ctx: ToolContext): Promise<MCPResponse>`. Implementa:
  - Validación shape JSON-RPC 2.0 (`jsonrpc === "2.0"`, `method` string, `id` presente) → `-32700` si falla (AC-15).
  - `method === "tools/list"` → retorna `TOOLS_MANIFEST` (AC-14).
  - `method === "tools/call"` → valida `params.name` ∈ `ToolName` → `-32601` si no (AC-16). Despacha a `src/mcp/tools/<tool>.ts`. Valida `params.arguments` contra `INPUT_SCHEMAS[name]` → `-32602` si falla.
  - Cualquier otro método → `-32601`.
  - Wrap error thrown por tool:
    - Si el error implementa `MCPToolError` con `{ code, message, data }` → se propaga tal cual.
    - Cualquier otro error → `-32001` con `message = err.message` (sin stack). AC-3.
  - Wrap el success en `{ content: [{ type: "text", text: JSON.stringify(output) }] }` (DT-10).
- `src/mcp/index.ts` — plugin Fastify:
  ```ts
  const mcpPlugin: FastifyPluginAsync = async (fastify) => {
    fastify.post<{ Body: unknown }>('/', {
      config: { rateLimit: mcpRateLimitConfig() },
      preHandler: [createMcpAuthHandler()],
    }, async (request, reply) => {
      const ctx: ToolContext = { requestId: request.id, tokenPrefix: ..., log: request.log };
      const response = await dispatch(request.body as MCPRequest, ctx);
      // Always HTTP 200 for valid JSON-RPC — MCP spec; non-2xx only for auth/rate-limit (handled earlier)
      return reply.status(200).send(response);
    });
  };
  export default mcpPlugin;
  ```
- `src/index.ts` — agregar `await fastify.register(mcpPlugin, { prefix: '/mcp' })` después de línea 95 (metricsRoutes) y antes del bloque `console.log` de startup.
- `src/mcp/router.test.ts` — tests:
  - `tools/list` retorna 4 tools con inputSchema (AC-14)
  - Body no-JSON-RPC → `-32700` HTTP 200 (AC-15)
  - Method desconocido → `-32601`
  - `tools/call` con tool inexistente → `-32601` (AC-16)
  - Rate limit excedido → HTTP 429 body `-32029` (AC-12)
- `src/mcp/rate-limit.test.ts` — test específico: 31 requests con mismo token → el 31 es 429.

**Verificación W2 done:** `npx vitest run src/mcp/router.test.ts src/mcp/rate-limit.test.ts` pasa. Smoke: `curl -X POST http://localhost:3001/mcp -H "X-MCP-Token: ..." -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'` retorna 4 tools.

### W3 — Tools `pay_x402` + `get_payment_quote` (serial, depende de W2)

Archivos:
- `src/mcp/tools/pay-x402.ts`:
  - Firma: `payX402(input: PayX402Input, ctx: ToolContext): Promise<PayX402Output>`
  - Flujo:
    1. `fetch(gatewayUrl + endpoint, { method, body: JSON.stringify(payload), headers })`.
    2. Si `!response.ok && status !== 402` → retornar `{ status, result: await response.text()/json() }` directo (AC-2).
    3. Si `status === 402` → parsear body como `X402Response`. Validar `accepts[0]` existe y `maxAmountRequired`. Si `input.maxAmountWei` está set y `BigInt(accepts[0].maxAmountRequired) > BigInt(input.maxAmountWei)` → throw `MCPToolError(-32002, 'Gateway requested amount exceeds maxAmountWei guard')`.
    4. `const signResult = await adapter.sign({ to: accepts[0].payTo, value: accepts[0].maxAmountRequired, timeoutSeconds: accepts[0].maxTimeoutSeconds })` — captura errores de `sign()` como `-32001`.
    5. Retry: `fetch(gatewayUrl+endpoint, { method, body, headers: { ...headers, 'payment-signature': signResult.xPaymentHeader } })`.
    6. Si retry `!2xx` → throw `MCPToolError(-32002, msg, { status, body })` (AC-4).
    7. Si retry 2xx → leer `payment-response` header (txHash) y retornar `{ status, result: await response.json(), txHash, amountPaid: accepts[0].maxAmountRequired }`.
  - Timeout por fetch: `AbortController` con `MCP_PAY_TIMEOUT_MS` (default 30000).
- `src/mcp/tools/get-payment-quote.ts`:
  - Firma: `getPaymentQuote(input, ctx): Promise<GetPaymentQuoteOutput>`
  - Flujo: `fetch(gatewayUrl+endpoint, { method: 'GET' })` → si 402, parsear como `X402Response` y retornar `{ required: true, amount: accepts[0].maxAmountRequired, token: accepts[0].asset, network: accepts[0].network, description: accepts[0].description }` (AC-5, AC-6). Si !402 → `{ required: false }`.
- `src/mcp/tools/pay-x402.test.ts` — mocks: `fetch` global con `vi.spyOn(global, 'fetch')`, `KiteOzonePaymentAdapter` con `vi.mock('../../adapters/kite-ozone/payment.js')`. Casos:
  - AC-1 happy path (402 → sign → retry 200)
  - AC-2 no-402 response directo
  - AC-3 `sign()` throws → `-32001` retornado
  - AC-4 retry 500 → `-32002` con status+body
  - `maxAmountWei` guard: gateway pide más → `-32002`
- `src/mcp/tools/get-payment-quote.test.ts` — mocks `fetch`. Casos:
  - AC-5 endpoint no-402 → `{ required: false }`
  - AC-6 endpoint 402 → parsea accepts[0]

**Verificación W3 done:** tests pasan, `pay_x402` no importa `settle`/`verify` del adapter (CD-7 enforced por revisar imports manualmente + adversary). Grep: `grep -E "adapter\\.(settle|verify)" src/mcp/tools/pay-x402.ts` retorna **0 matches**.

### W4 — Tools `discover_agents` + `orchestrate` + wiring final

Archivos:
- `src/mcp/tools/discover-agents.ts`:
  - Firma: `discoverAgents(input, ctx): Promise<DiscoveryResult>`
  - Llama `discoveryService.discover({ query, capabilities, maxPrice, limit: input.limit ?? 20 })`.
  - Wrap en `Promise.race` con `new Promise((_, rej) => setTimeout(() => rej(new MCPToolError(-32001, 'Discovery timeout')), TIMEOUT_ORCHESTRATE_MS))` — AC-8.
- `src/mcp/tools/orchestrate.ts`:
  - Firma: `orchestrate(input, ctx): Promise<OrchestrateToolOutput>`
  - Genera `const orchestrationId = crypto.randomUUID()`.
  - Llama `orchestrateService.orchestrate({ goal, budget, preferCapabilities, maxAgents, a2aKey: input.a2aKey }, orchestrationId)`.
  - Retorna `{ orchestrationId, steps: result.pipeline.steps.map(toComposeStep), result: result.answer, kiteTxHash: undefined, reasoning: result.reasoning, protocolFeeUsdc: result.protocolFeeUsdc }` — AC-9.
  - **W4.0** (precondición): agregar campo opcional `a2aKey?: string` a `OrchestrateRequest` en `src/types/index.ts`. Propagarlo en `orchestrateService.orchestrate()` → `composeService.compose({ steps, maxBudget, a2aKey: request.a2aKey })`. Agregar `a2aKey?: string` a `ComposeRequest` y en `composeService.invokeAgent()` agregar `x-a2a-key` al header cuando viene (AC-10).
    - **Riesgo**: toca 4 archivos (`types/index.ts`, `services/orchestrate.ts`, `services/compose.ts`, test existente `src/services/orchestrate.test.ts` si chequea input shape).
    - **Mitigación**: cambio es aditivo (campo opcional). Compila sin romper callers actuales. Los tests existentes siguen verdes.
- `src/mcp/tools/discover-agents.test.ts` — mock `discoveryService.discover` (CD-9 — mock completo con `registries: []`). Casos:
  - AC-7 happy path retorna agents+total+registries
  - AC-8 timeout — mock que nunca resuelve, test con timeout reducido vía `MCP_DISCOVER_TIMEOUT_MS_TEST`
- `src/mcp/tools/orchestrate.test.ts` — mock `orchestrateService.orchestrate`. Casos:
  - AC-9 happy path
  - AC-10 `a2aKey` presente se propaga (`expect(mockOrchestrate).toHaveBeenCalledWith(expect.objectContaining({ a2aKey: 'wasi_a2a_...' }), ...)`)
- `src/mcp/metrics.ts` — `renderMcpMetrics(): string` y `incrementMcpToolCall(tool, status)`. Expone `Map<ToolName, { success: number; error: number }>`.
- `src/mcp/router.ts` (update) — en el catch del dispatch, antes de retornar, llama `incrementMcpToolCall(name, 'error')`. En el success, `incrementMcpToolCall(name, 'success')`. Registra log estructurado `{ requestId, mcpToken, tool, durationMs, success }` (AC-17).
- `src/routes/metrics.ts` (update minimal — DT-9) — importar `renderMcpMetrics` y en el handler, después de "Node.js process metrics" (L138), hacer `lines.push(renderMcpMetrics())`. **Una sola línea de `import` + una línea de `push`.**
- `src/mcp/metrics.test.ts` — tests unitarios de `renderMcpMetrics()`: formato correcto `# HELP`, `# TYPE counter`, labels `{tool="...",status="..."}`.

**Verificación W4 done:** `npx tsc --noEmit` pasa. Todos los tests MCP verdes. `curl /metrics` muestra `mcp_tool_calls_total{tool="pay_x402",status="success"} 0` (contador inicia en 0).

---

## 6. Plan de tests (cobertura por AC)

| AC | Archivo de test | Test case |
|----|-----------------|-----------|
| AC-1 | `src/mcp/tools/pay-x402.test.ts` | `it('AC-1: 402 → sign → retry 200 retorna txHash')` |
| AC-2 | `src/mcp/tools/pay-x402.test.ts` | `it('AC-2: response no-402 pasa directo sin firmar')` — `expect(mockSign).not.toHaveBeenCalled()` |
| AC-3 | `src/mcp/tools/pay-x402.test.ts` | `it('AC-3: sign() throws → MCP error -32001')` |
| AC-4 | `src/mcp/tools/pay-x402.test.ts` | `it('AC-4: retry !2xx → MCP error -32002 con status+body')` |
| AC-5 | `src/mcp/tools/get-payment-quote.test.ts` | `it('AC-5: endpoint no-402 → { required: false }')` |
| AC-6 | `src/mcp/tools/get-payment-quote.test.ts` | `it('AC-6: endpoint 402 → parsea accepts[0]')` |
| AC-7 | `src/mcp/tools/discover-agents.test.ts` | `it('AC-7: llama discoveryService.discover y retorna shape DiscoveryResult')` |
| AC-8 | `src/mcp/tools/discover-agents.test.ts` | `it('AC-8: aplica timeout TIMEOUT_ORCHESTRATE_MS')` |
| AC-9 | `src/mcp/tools/orchestrate.test.ts` | `it('AC-9: retorna orchestrationId + steps + result + reasoning')` |
| AC-10 | `src/mcp/tools/orchestrate.test.ts` | `it('AC-10: a2aKey se propaga a orchestrateService.orchestrate')` |
| AC-11 | `src/mcp/auth.test.ts` | `it('AC-11: sin X-MCP-Token → 401 JSON-RPC -32600')` |
| AC-12 | `src/mcp/rate-limit.test.ts` | `it('AC-12: 31 requests mismo token → 429 -32029')` |
| AC-13 | `src/mcp/auth.test.ts` | `it('AC-13: match contra MCP_TOKEN_HASH')` + `it('AC-13: match contra MCP_TOKENS array')` + `it('AC-13: no-match → 401')` |
| AC-14 | `src/mcp/router.test.ts` | `it('AC-14: tools/list retorna 4 tools con inputSchema')` |
| AC-15 | `src/mcp/router.test.ts` | `it('AC-15: body no-JSON-RPC → -32700 HTTP 200')` |
| AC-16 | `src/mcp/router.test.ts` | `it('AC-16: tools/call con name desconocido → -32601')` |
| AC-17 | `src/mcp/router.test.ts` | `it('AC-17: logs estructurado con requestId, mcpToken (8 chars), tool, durationMs, success')` — spy del `request.log.info` |
| AC-18 | `src/mcp/metrics.test.ts` | `it('AC-18: incrementMcpToolCall genera label {tool,status} counter')` |
| AC-19 | CI/build | `npx tsc --noEmit` limpio en todo `src/mcp/**` |

**Totales:** 19 tests mínimos mapeados 1:1 a ACs + tests adicionales de CD-8/CD-9 (mock shapes).

**Archivos de test nuevos:** 6 (`auth.test.ts`, `router.test.ts`, `rate-limit.test.ts`, `metrics.test.ts`, `tools/pay-x402.test.ts`, `tools/get-payment-quote.test.ts`, `tools/discover-agents.test.ts`, `tools/orchestrate.test.ts`). Organizados **co-ubicados** con los módulos (pattern del repo — ver `src/routes/auth.test.ts`, `src/middleware/rate-limit.test.ts`).

---

## 7. Impacto fuera de `src/mcp/`

| Archivo | Cambio | LoC estimado | Justificación |
|---------|--------|--------------|---------------|
| `src/index.ts` | Agregar `import mcpPlugin from './mcp/index.js';` + `await fastify.register(mcpPlugin, { prefix: '/mcp' });` | +2 | Registro del plugin (requerido) |
| `src/types/index.ts` | Agregar `a2aKey?: string` a `OrchestrateRequest` y a `ComposeRequest` | +2 | AC-10 (ver DT-7) |
| `src/services/orchestrate.ts` | Propagar `a2aKey` del request a `composeService.compose()` | +2 | AC-10 |
| `src/services/compose.ts` | Aceptar `a2aKey` en `ComposeRequest` y agregar header `x-a2a-key` en `invokeAgent()` | +5 | AC-10 |
| `src/routes/metrics.ts` | `import { renderMcpMetrics } from '../mcp/metrics.js';` + `lines.push(renderMcpMetrics());` antes del `reply.type(...)` | +2 | DT-9 / AC-18 |
| `.env.example` | Agregar bloque MCP (4 vars) | +8 | CD-4 |

**Total impacto fuera de `src/mcp/`:** ~21 LoC, ninguna ruptura de contratos públicos (todo aditivo).

---

## 8. Manifiesto `tools/list` (shape exacto que Claude verá)

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "pay_x402",
        "description": "Pay an x402-protected HTTP endpoint end-to-end: fetch the endpoint, detect 402, sign EIP-712 via Kite wallet, retry with payment-signature header, and return the final response.",
        "inputSchema": { "type": "object", "required": ["gatewayUrl", "endpoint"], "properties": { ... } }
      },
      { "name": "get_payment_quote", ... },
      { "name": "discover_agents", ... },
      { "name": "orchestrate", ... }
    ]
  }
}
```

Los schemas completos se escriben en `src/mcp/schemas.ts` (W1).

---

## 9. Seguridad — Threat Model sintético

| Amenaza | Mitigación |
|---------|------------|
| Token MCP leaked en logs | CD-3 + tests que grep logs por el token completo |
| Timing attack sobre comparación de hash | DT-5 `timingSafeEqual` (CD-13) |
| Cliente malicioso envía gatewayUrl a un host interno (SSRF) | **Mitigación parcial en W3:** validar `gatewayUrl` protocol ∈ {http,https} y opcional allowlist via `MCP_GATEWAY_ALLOWLIST` (env, CSV). Si no set, warn en log la primera vez. **No bloqueante para este SDD — ver Readiness §10.** |
| Gateway pide monto absurdo → drena wallet | `maxAmountWei` guard opcional por request (DT-3) |
| Rate limit bypass cambiando IP pero manteniendo token | keyGenerator usa token > IP (DT-6) |
| Abuse de `tools/list` (unauth recon) | `tools/list` **también** requiere auth (preHandler aplica antes del router) — AC-11/14 |
| Settle inesperado desde `pay_x402` | CD-7 + grep post-W3 |
| Flood de errores → metrics memory leak | `Map<ToolName, ...>` tiene **máximo 4 entries** fijas (una por tool). O(1) constante. |

---

## 10. Readiness Check

| # | Criterio | Estado |
|---|----------|--------|
| 1 | `npx tsc --noEmit` pasa en todo el repo con `src/mcp/` incluido | ✅ (a verificar en F3) |
| 2 | `npx vitest run` pasa con los 19+ tests nuevos | ✅ (a verificar en F3) |
| 3 | `grep -E "\\bany\\b\\|as unknown" src/mcp/` retorna 0 líneas (CD-2) | ✅ (enforced por revisión Adversary) |
| 4 | `grep -E "adapter\\.(settle\\|verify)" src/mcp/tools/pay-x402.ts` retorna 0 líneas (CD-7) | ✅ |
| 5 | `.env.example` tiene las 4 nuevas vars MCP_* con comentario (CD-4) | ✅ |
| 6 | `curl POST /mcp -H "X-MCP-Token: <valid>" -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'` retorna 4 tools | ✅ (smoke test en F3) |
| 7 | `curl POST /mcp` sin header → 401 con `{jsonrpc,error:{code:-32600,message:"Unauthorized"},id:null}` | ✅ (smoke test AC-11) |
| 8 | `/metrics` incluye líneas `mcp_tool_calls_total{...}` | ✅ |
| 9 | `@modelcontextprotocol/sdk` NO está en `package.json` | ✅ (DT-1) |
| 10 | No se instalan deps nuevas (`git diff package.json` solo toca scripts si algo) | ✅ |
| 11 | `src/mcp/` no tiene `as unknown as` ni `any` ni `// @ts-ignore` | ✅ (CD-2) |
| 12 | `MCP_GATEWAY_ALLOWLIST` decidido (opt-in, default "permitir todo") | ⚠️ DECIDIDO — opt-in env. Default **NO** bloquea (pragmático para hackathon). Documentado en `.env.example` con WARNING. Si el humano quiere enforcement estricto → marcar como `[NEEDS CLARIFICATION]` y bloquear SPEC_APPROVED. |
| 13 | Toques fuera `src/mcp/` documentados (21 LoC, 5 archivos) | ✅ §7 |
| 14 | Auto-blindaje patterns (CD-8..CD-14) copiados al Story File | ✅ (se hace en F2.5) |

**No hay `[NEEDS CLARIFICATION]` pendiente** — el único ítem dudoso (allowlist) está decidido como opt-in con default permisivo + WARNING documentado. Si el humano prefiere enforcement estricto, lo indica en el gate `SPEC_APPROVED`.

---

## 11. Resumen ejecutivo para SPEC_APPROVED gate

- **Stack:** 0 deps nuevas. Fastify 5 + `@fastify/rate-limit@10` ya instalado + `node:crypto`. SDK MCP oficial rechazado por deps pesadas (Express+Hono+Zod+jose).
- **Superficie:** 12 archivos nuevos en `src/mcp/` + 5 archivos tocados (5 líneas o menos cada uno).
- **ACs:** 19/19 mapeados a tests. Waves: W0 setup → W1 auth+types → W2 router+rate-limit+wiring → W3 pay+quote → W4 discover+orchestrate+metrics.
- **Seguridad:** timing-safe token compare, maxAmountWei guard, 8-char token en logs, rate limit por token, CD-7 enforced por grep.
- **Auto-blindaje aplicado:** CD-8..CD-14 bloquean los 4 errores recurrentes (mocks, rate-limit Error objects, Fastify 5 plugin pinning, relative path depth).
- **Riesgo residual:** cambio a `OrchestrateRequest` (campo opcional) — aditivo, no-breaking.
- **Listo para SPEC_APPROVED** si el humano acepta el default permisivo de `MCP_GATEWAY_ALLOWLIST`.

---

*SDD emitido por nexus-architect · F2 · WKH-MCP-X402 · 2026-04-13*
