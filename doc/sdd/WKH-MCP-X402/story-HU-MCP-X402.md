# Story File — WKH-MCP-X402 · MCP Server x402 — Tools para Claude Managed Agent

> **SDD:** `doc/sdd/WKH-MCP-X402/sdd.md` (aprobado)
> **Work Item:** `doc/sdd/WKH-MCP-X402/work-item.md`
> **Fecha:** 2026-04-13
> **Branch:** `feat/042-mcp-server-x402`
> **Flow:** QUALITY · Estimación: L · 19 ACs · 14 CDs
> **Lectura Dev:** Este documento es **autocontenido**. No abras el SDD durante la implementación. Si algo no está aquí → PARA y escala a Architect.

---

## 1. Goal

Construir un **plugin Fastify** montado en `POST /mcp` que implementa el subset `tools/list` + `tools/call` del protocolo MCP (JSON-RPC 2.0 sobre HTTP) y expone 4 tools que Claude Managed Agent invoca:

- **`pay_x402`** — ejecuta el flujo cliente x402 completo (fetch → 402 → firma EIP-712 → retry → response).
- **`get_payment_quote`** — pregunta a un endpoint externo si requiere x402 y parsea `X402Response`.
- **`discover_agents`** — busca agentes reutilizando `discoveryService.discover()`.
- **`orchestrate`** — goal-based orchestration reutilizando `orchestrateService.orchestrate()`.

Requisitos no-funcionales: auth propia `X-MCP-Token` + rate-limit por token + métricas Prometheus + cero deps nuevas + TS strict sin `any`/`as unknown as`.

---

## 2. Acceptance Criteria (EARS) — 19 ACs

> Copiados del work-item y del SDD. QA los valida en F4 con evidencia archivo:línea.

### Tool: pay_x402
- **AC-1:** WHEN un MCP client llama `pay_x402` con `gatewayUrl`, `endpoint`, `method` y `payload` válidos, the system SHALL ejecutar el flujo x402 completo (request inicial → detect 402 → EIP-712 sign via `KiteOzonePaymentAdapter.sign()` → retry con header `payment-signature` → retorno `{ status, result, txHash, amountPaid }`) en una sola invocación.
- **AC-2:** WHEN la respuesta del gateway externo NO es 402, the system SHALL retornar el resultado directamente sin realizar firma ni pago.
- **AC-3:** IF `KiteOzonePaymentAdapter.sign()` lanza error (ej: `OPERATOR_PRIVATE_KEY` no disponible), THEN the system SHALL retornar MCP error estructurado con `code: -32001` y `message` descriptivo, sin exponer el stack trace.
- **AC-4:** IF el retry con `payment-signature` retorna status distinto de 2xx, THEN the system SHALL retornar MCP error con `code: -32002` incluyendo el HTTP status y body del gateway externo.

### Tool: get_payment_quote
- **AC-5:** WHEN un MCP client llama `get_payment_quote` con `gatewayUrl` y `endpoint`, the system SHALL hacer GET al endpoint externo y retornar `{ required: boolean, amount?: string, token?: string, network?: string, description?: string }` sin ejecutar pago.
- **AC-6:** IF el endpoint externo responde 402, the system SHALL parsear el body `X402Response` y retornar los campos `maxAmountRequired`, `asset` y `network` del primer elemento de `accepts`.

### Tool: discover_agents
- **AC-7:** WHEN un MCP client llama `discover_agents` con `query` (string) y `maxPrice` (number, opc) y `capabilities` (string[], opc), the system SHALL invocar `discoveryService.discover()` y retornar `DiscoveryResult` sin llamadas HTTP adicionales.
- **AC-8:** WHILE `discover_agents` se ejecuta, the system SHALL aplicar el timeout `TIMEOUT_ORCHESTRATE_MS` (default 120 000 ms).

### Tool: orchestrate
- **AC-9:** WHEN un MCP client llama `orchestrate` con `goal` y `budget`, the system SHALL invocar `orchestrateService.orchestrate()` y retornar `{ orchestrationId, steps, result, kiteTxHash?, reasoning, protocolFeeUsdc }`.
- **AC-10:** WHERE el campo `a2aKey` es provisto, the system SHALL propagarlo al servicio de orchestración (vía `OrchestrateRequest.a2aKey`) que lo inyectará como header `x-a2a-key` en las llamadas a agentes.

### Auth y seguridad
- **AC-11:** WHEN un request llega a `POST /mcp` sin header `X-MCP-Token` válido, the system SHALL retornar `{ jsonrpc: "2.0", error: { code: -32600, message: "Unauthorized" }, id: null }` con HTTP 401.
- **AC-12:** WHILE un token MCP excede `MCP_RATE_LIMIT_MAX` requests por `MCP_RATE_LIMIT_WINDOW_MS`, the system SHALL retornar `{ jsonrpc: "2.0", error: { code: -32029, message: "Too Many Requests" }, id }` con HTTP 429.
- **AC-13:** the system SHALL validar tokens MCP comparando `sha256(X-MCP-Token)` contra `MCP_TOKEN_HASH` (env, único) o `MCP_TOKENS` (env, JSON array de hashes hex64). Si ninguno matchea → 401.

### Protocolo MCP
- **AC-14:** WHEN `POST /mcp` recibe JSON-RPC 2.0 válido con `method: "tools/list"`, the system SHALL retornar manifest de las 4 tools con sus `inputSchema` completos y `description`.
- **AC-15:** IF el body no es JSON-RPC 2.0 válido (falta `jsonrpc`, `method` o `id`), THEN the system SHALL retornar `{ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }` con **HTTP 200**.
- **AC-16:** WHEN `method: "tools/call"` recibe un `name` no reconocido, the system SHALL retornar `{ error: { code: -32601, message: "Method not found" } }`.

### Observabilidad
- **AC-17:** WHEN cualquier tool MCP es invocada, the system SHALL registrar un log estructurado `{ requestId, mcpToken: "<primeros 8 chars>", tool, durationMs, success }` usando `request.log`.
- **AC-18:** WHEN cualquier tool MCP es invocada, the system SHALL incrementar el counter Prometheus `mcp_tool_calls_total{tool, status}` donde `status ∈ {"success","error"}`.

### TypeScript
- **AC-19:** the system SHALL compilar sin errores con `npx tsc --noEmit` en modo strict (sin `any` explícito, sin `as unknown as X`).

---

## 3. Files to Modify/Create

### 3.a Archivos NUEVOS dentro de `src/mcp/`

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/mcp/types.ts` | Crear | Tipos MCP: `MCPRequest`, `MCPResponse`, `MCPError`, `ToolContext`, `ToolContent`, `ToolName` union, `MCP_ERRORS` const, `MCPToolError` class | E2 |
| 2 | `src/mcp/schemas.ts` | Crear | JSON Schema Draft-07 para las 4 tools + `TOOLS_MANIFEST` array + `TOOL_DESCRIPTIONS` | — (inline) |
| 3 | `src/mcp/auth.ts` | Crear | `createMcpAuthHandler()` — preHandler async que valida `X-MCP-Token` con `timingSafeEqual` y retorna 401 JSON-RPC si falla | E13 |
| 4 | `src/mcp/auth.test.ts` | Crear | Tests unitarios auth (AC-11, AC-13, config-missing 503) — ver §7 | E12 |
| 5 | `src/mcp/rate-limit.ts` | Crear | `mcpRateLimitConfig()` — `keyGenerator` por token + `errorResponseBuilder` Error con `.statusCode=429/.code='RATE_LIMIT_EXCEEDED'/.retryAfterMs` | E5 |
| 6 | `src/mcp/rate-limit.test.ts` | Crear | Test AC-12: 31 requests → 429 con `-32029` | E12 |
| 7 | `src/mcp/router.ts` | Crear | `dispatch(req, ctx)` — valida shape JSON-RPC, rutea `tools/list`/`tools/call`, maneja errores, wrap success en `{ content: [{ type: "text", text: JSON.stringify(output) }] }` | — |
| 8 | `src/mcp/router.test.ts` | Crear | Tests AC-14/15/16/17 — ver §7 | E12 |
| 9 | `src/mcp/metrics.ts` | Crear | `incrementMcpToolCall(tool, status)` + `renderMcpMetrics(): string` — Map in-memory + formato Prometheus | E10 |
| 10 | `src/mcp/metrics.test.ts` | Crear | Test AC-18: formato correcto + labels `{tool,status}` | — |
| 11 | `src/mcp/index.ts` | Crear | Plugin Fastify: `POST /` con `config.rateLimit` + `preHandler: [auth]` + body handler que llama `dispatch()` | E11 |
| 12 | `src/mcp/tools/pay-x402.ts` | Crear | `payX402(input, ctx)` — flujo completo cliente x402 usando `KiteOzonePaymentAdapter.sign()` | E1/E2/E4 |
| 13 | `src/mcp/tools/pay-x402.test.ts` | Crear | Tests AC-1/2/3/4 + guard `maxAmountWei` | E12 |
| 14 | `src/mcp/tools/get-payment-quote.ts` | Crear | `getPaymentQuote(input, ctx)` — GET y parsea `X402Response` | E3/E4 |
| 15 | `src/mcp/tools/get-payment-quote.test.ts` | Crear | Tests AC-5/6 | E12 |
| 16 | `src/mcp/tools/discover-agents.ts` | Crear | `discoverAgents(input, ctx)` — llama `discoveryService.discover()` con timeout via `Promise.race` + AbortController | E6 |
| 17 | `src/mcp/tools/discover-agents.test.ts` | Crear | Tests AC-7/8 — mock `discoveryService.discover` completo (CD-9) | E12 |
| 18 | `src/mcp/tools/orchestrate.ts` | Crear | `orchestrate(input, ctx)` — llama `orchestrateService.orchestrate()` con `a2aKey` propagado | E7/E8 |
| 19 | `src/mcp/tools/orchestrate.test.ts` | Crear | Tests AC-9/10 — verificar propagación de `a2aKey` | E12 |

### 3.b Archivos EXISTENTES que se modifican (cambios mínimos aditivos)

| # | Archivo | Acción | Qué hacer | LoC |
|---|---------|--------|-----------|-----|
| A | `src/index.ts` | Modificar | Agregar `import mcpPlugin from './mcp/index.js';` + `await fastify.register(mcpPlugin, { prefix: '/mcp' });` **después** de la línea 95 (`metricsRoutes`) y antes de `const port = ...` | +2 |
| B | `src/types/index.ts` | Modificar | Agregar campo opcional `a2aKey?: string` a interface `OrchestrateRequest` (L196-205) **y** a interface `ComposeRequest` (L142-146) | +2 |
| C | `src/services/orchestrate.ts` | Modificar | En el body del método `orchestrate()` propagar `request.a2aKey` hacia `composeService.compose(...)` — **aditivo**, campo opcional | +1 |
| D | `src/services/compose.ts` | Modificar | En `compose(request)` leer `request.a2aKey`; en `invokeAgent(agent, input, a2aKey?)` agregar header `'x-a2a-key': a2aKey` cuando sea truthy. Firma extendida con parámetro opcional | +4 |
| E | `src/routes/metrics.ts` | Modificar | Agregar `import { renderMcpMetrics } from '../mcp/metrics.js';` y, **inmediatamente antes** del `return reply.type(...)...` (L140), `lines.push(renderMcpMetrics());` | +2 |
| F | `.env.example` | Modificar | Agregar bloque MCP (4 vars con comentarios — ver §6.1) | +10 |

**Total impacto fuera de `src/mcp/`:** ~21 LoC, 0 breaking changes, 0 deps nuevas.

---

## 4. Constraint Directives — 14 CDs (INVIOLABLES)

### OBLIGATORIO

- **CD-5:** Cada tool retorna errores en formato MCP JSON-RPC 2.0 (`{ error: { code, message, data? } }`). Nunca raw HTTP errors ni stack traces al cliente.
- **CD-6:** Tests obligatorios cubren: auth válida, auth inválida, rate limit excedido, cada tool happy path, cada tool error path, `tools/list`, parse errors, method not found.
- **CD-9:** Todo mock de `discoveryService.discover()` retorna `DiscoveryResult` completo incluyendo `registries: string[]` (aunque sea `[]`). Referencia: AB-035 #1.
- **CD-10:** Relative imports en tests MCP verificados — `src/mcp/*.test.ts` usa `../` (1 nivel) para `src/`, `src/mcp/tools/*.test.ts` usa `../../` para `src/`. Verificar con `node -e "require.resolve('./path')"` si dudás. Referencia: AB-029 #1.
- **CD-11:** Pin `@fastify/rate-limit@^10.3.0` (ya instalado). NO agregar otras versiones ni otros plugins de rate-limit.
- **CD-12:** `errorResponseBuilder` retorna instancia real de `Error` con `.statusCode/.code/.retryAfterMs` (nunca plain object). Referencia: AB-026 #3. Ver Exemplar 5.
- **CD-13:** Comparación de hash SHA-256 del token MCP usa `crypto.timingSafeEqual(Buffer.from(h1,'hex'), Buffer.from(h2,'hex'))`. Longitud garantizada 32 bytes.
- **CD-14:** El plugin MCP se registra en `src/index.ts` **después** de `metricsRoutes` (línea 95 actual). El `registerRateLimit(fastify)` ya fue invocado antes — es precondición.

### PROHIBIDO

- **CD-1:** NO reimplementar EIP-712 signing. Todo signing pasa por `KiteOzonePaymentAdapter.sign()` importado desde `src/adapters/kite-ozone/payment.js` vía `getPaymentAdapter()` (ver Exemplar 1). **Grep post-implementación:** `grep -rE "signTypedData|EIP712" src/mcp/` debe retornar 0 líneas.
- **CD-2:** NO usar `any`, `as any`, `as unknown as T`, `// @ts-ignore`, `// @ts-expect-error` en `src/mcp/`. Si un cast es inevitable, usar `as unknown` seguido de type-guard runtime. **Grep post:** `grep -rE "\\bany\\b|as unknown as|@ts-ignore" src/mcp/` debe retornar 0 líneas.
- **CD-3:** NO loggear el valor completo de `X-MCP-Token`. Solo los primeros 8 caracteres. **Grep post:** el token plaintext no debe aparecer completo en `request.log.*` llamadas.
- **CD-4:** NO hardcodear URLs, tokens, hashes, límites o fees. Todo desde env vars con defaults documentados en `.env.example`.
- **CD-7:** `pay_x402` NO ejecuta `adapter.settle()` ni `adapter.verify()`. Solo `adapter.sign()`. **Grep post:** `grep -E "adapter\\.(settle|verify)" src/mcp/tools/pay-x402.ts` debe retornar 0 líneas.
- **CD-8:** NO correr `biome check --write --unsafe` sobre tests que contengan `vi.fn().mockImplementation(function() {...})`. Rompe el constructor-mock pattern. Referencia: AB-038 #1.

### Auto-blindaje — patrones recurrentes prevenidos

| CD | Error recurrente que previene | Referencia |
|----|-------------------------------|------------|
| CD-8 | Biome rompe `function()` en mocks de constructor | WKH-038 AB #1 |
| CD-9 | Mock incompleto de `DiscoveryResult` (falta `registries`) | WKH-035 AB #1 |
| CD-10 | Relative imports mal calculados en tests profundos | WKH-029 AB #1 |
| CD-12 | Plain objects en `errorResponseBuilder` no se serializan | WKH-026 AB #3 |
| CD-13 | Comparación directa `===` de hashes → timing attack | WKH-026 AB #4 (derivado) |

---

## 5. Exemplars — fragmentos reales del codebase

### Exemplar 1 — `KiteOzonePaymentAdapter.sign()` (ÚNICO camino EIP-712)

**Archivo:** `src/adapters/kite-ozone/payment.ts` L236-274
**Usar para:** `src/mcp/tools/pay-x402.ts`
**Patrón clave:**

```ts
// CORRECTO — import y uso
import { getPaymentAdapter } from '../../adapters/registry.js';

const adapter = getPaymentAdapter();
const signResult = await adapter.sign({
  to: accepts[0].payTo as `0x${string}`,  // 0x prefix obligatorio
  value: accepts[0].maxAmountRequired,    // wei string
  timeoutSeconds: accepts[0].maxTimeoutSeconds,  // opcional, default 300
});
// signResult: { xPaymentHeader: string (base64), paymentRequest: X402PaymentRequest }
// signResult.xPaymentHeader → se usa como valor del header 'payment-signature' en el retry
```

**Errores del adapter:**
- `Error('OPERATOR_PRIVATE_KEY not set ...')` → capturar y mapear a `MCPToolError(-32001, 'Signing failed: ' + err.message)`.
- Cualquier otra excepción → idem `-32001`.

### Exemplar 2 — Tipos x402 (importar, NO redefinir)

**Archivos:** `src/adapters/types.ts` L35-43 + `src/types/index.ts` L233-262

```ts
// Imports correctos
import type { SignRequest, SignResult } from '../../adapters/types.js';
import type { X402Response, X402PaymentPayload } from '../../types/index.js';

// SignRequest shape:
//   { to: `0x${string}`, value: string, timeoutSeconds?: number }

// X402Response shape (body 402):
//   { error: string, accepts: X402PaymentPayload[], x402Version: 2 }

// X402PaymentPayload[0] shape usado por pay_x402:
//   { maxAmountRequired: string, payTo: string, asset: string,
//     network: string, maxTimeoutSeconds: number, description: string, ... }
```

### Exemplar 3 — `X402Response` shape para `get_payment_quote`

**Archivo:** `src/types/index.ts` L258-262

```ts
// Tras recibir 402:
const body = await response.json() as X402Response;
const first = body.accepts[0];
return {
  required: true,
  amount: first.maxAmountRequired,
  token: first.asset,
  network: first.network,
  description: first.description,
};
```

### Exemplar 5 — Rate-limit Error-object pattern (CD-12)

**Archivo:** `src/middleware/rate-limit.ts` L19-32

```ts
// COPIAR ESTE SHAPE en src/mcp/rate-limit.ts
const mcpRateLimitErrorBuilder = (
  _request: unknown,
  context: { ban?: boolean; ttl: number },
) => {
  const err = new Error('Too Many Requests') as Error & {
    statusCode: number;
    code: string;
    retryAfterMs: number;
  };
  err.statusCode = context.ban ? 403 : 429;
  err.code = 'RATE_LIMIT_EXCEEDED';
  err.retryAfterMs = context.ttl;
  return err;  // PROHIBIDO retornar plain object (AB-026 #3)
};

export function mcpRateLimitConfig() {
  return {
    max: parseInt(process.env.MCP_RATE_LIMIT_MAX ?? '30', 10),
    timeWindow: parseInt(process.env.MCP_RATE_LIMIT_WINDOW_MS ?? '60000', 10),
    keyGenerator: (req: FastifyRequest) => {
      const t = req.headers['x-mcp-token'];
      return typeof t === 'string' && t.length > 0 ? t : req.ip;
    },
    errorResponseBuilder: mcpRateLimitErrorBuilder,
  };
}
```

### Exemplar 6 — `discoveryService.discover()`

**Archivo:** `src/services/discovery.ts` L15-19

```ts
import { discoveryService } from '../../services/discovery.js';

const result: DiscoveryResult = await discoveryService.discover({
  query: input.query,                  // opcional
  capabilities: input.capabilities,    // opcional
  maxPrice: input.maxPrice,            // opcional
  limit: input.limit ?? 20,
});
// result: { agents: Agent[], total: number, registries: string[] }  <- mock debe incluir registries (CD-9)
```

### Exemplar 7 — `orchestrateService.orchestrate()`

**Archivo:** `src/services/orchestrate.ts` L224-227

```ts
import { orchestrateService } from '../../services/orchestrate.js';
import crypto from 'node:crypto';

const orchestrationId = crypto.randomUUID();
const result = await orchestrateService.orchestrate(
  {
    goal: input.goal,
    budget: input.budget,
    preferCapabilities: input.preferCapabilities,
    maxAgents: input.maxAgents,
    a2aKey: input.a2aKey,  // NUEVO campo opcional (Archivo B de §3.b)
  },
  orchestrationId,
);
// result: { orchestrationId, answer, reasoning, pipeline: ComposeResult, consideredAgents, protocolFeeUsdc, attestationTxHash? }
```

### Exemplar 10 — Prometheus text format

**Archivo:** `src/routes/metrics.ts` L131-138

```ts
// FORMATO OBLIGATORIO para src/mcp/metrics.ts
export function renderMcpMetrics(): string {
  const lines: string[] = [];
  lines.push('# HELP mcp_tool_calls_total Total MCP tool calls by tool and status');
  lines.push('# TYPE mcp_tool_calls_total counter');
  for (const [tool, counts] of mcpStats.entries()) {
    lines.push(`mcp_tool_calls_total{tool="${tool}",status="success"} ${counts.success}`);
    lines.push(`mcp_tool_calls_total{tool="${tool}",status="error"} ${counts.error}`);
  }
  return lines.join('\n');
}
```

### Exemplar 11 — Registro del plugin en `src/index.ts`

**Archivo:** `src/index.ts` L94-96

```ts
// Prometheus metrics (Doctor 4: APM)
await fastify.register(metricsRoutes, { prefix: '/metrics' });

// WKH-MCP-X402: MCP Server plugin (CD-14: DESPUÉS de metricsRoutes, ANTES de server start)
await fastify.register(mcpPlugin, { prefix: '/mcp' });

// Start server
const port = parseInt(process.env.PORT ?? '3001', 10);
```

### Exemplar 12 — Test con `Fastify.inject()` + `vi.mock()`

**Archivo:** `src/routes/auth.test.ts` L1-40

```ts
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks SIEMPRE al tope, antes de imports del módulo bajo test
vi.mock('../services/discovery.js', () => ({
  discoveryService: {
    discover: vi.fn(),
  },
}));

import mcpPlugin from './index.js';
import { discoveryService } from '../services/discovery.js';

const mockDiscover = vi.mocked(discoveryService.discover);

describe('MCP router', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(rateLimit, { global: true, max: 60, timeWindow: 60000 });
    await app.register(mcpPlugin, { prefix: '/mcp' });
  });

  afterAll(async () => { await app.close(); });

  it('AC-14: tools/list returns 4 tools', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'x-mcp-token': VALID_TOKEN, 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools).toHaveLength(4);
    expect(body.result.tools.map(t => t.name)).toEqual(
      expect.arrayContaining(['pay_x402', 'get_payment_quote', 'discover_agents', 'orchestrate']),
    );
  });
});
```

### Exemplar 13 — preHandler async con 401/403 JSON-RPC

**Archivo:** `src/middleware/a2a-key.ts` L83-113

```ts
// src/mcp/auth.ts — shape obligatorio
import { preHandlerAsyncHookHandler, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';

export function createMcpAuthHandler(): preHandlerAsyncHookHandler {
  const hashes = loadMcpTokenHashes();  // lee MCP_TOKEN_HASH + MCP_TOKENS al startup
  if (hashes.length === 0) {
    // fail-closed: se devuelve 503 en cada request
    return async (_req, reply) => {
      reply.status(503).send({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'MCP auth not configured' },
        id: null,
      });
    };
  }
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.headers['x-mcp-token'];
    if (typeof token !== 'string' || token.length === 0) {
      reply.status(401).send({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Unauthorized' },
        id: null,
      });
      return;
    }
    const tokenHash = Buffer.from(
      crypto.createHash('sha256').update(token).digest('hex'),
      'hex',
    );
    // CD-13: timing-safe — NO early return
    let match = false;
    for (const h of hashes) {
      const expected = Buffer.from(h, 'hex');
      if (expected.length === tokenHash.length && crypto.timingSafeEqual(expected, tokenHash)) {
        match = true;  // NO break — compara todos
      }
    }
    if (!match) {
      reply.status(401).send({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Unauthorized' },
        id: null,
      });
      return;
    }
    // attach tokenPrefix al request via decoration (CD-3: solo 8 chars)
    (request as FastifyRequest & { mcpTokenPrefix?: string }).mcpTokenPrefix = token.slice(0, 8);
  };
}
```

---

## 6. Contratos — shapes exactos

### 6.1 Env vars nuevas (archivo F de §3.b)

```bash
# ─────────────────────────────────────────────────────────────
# MCP Server (WKH-MCP-X402)
# ─────────────────────────────────────────────────────────────
# Token MCP — SHA-256 hash de un bearer compartido con el cliente (ej: Claude Managed Agent).
# Generar con: echo -n "mi-token-secreto" | sha256sum
MCP_TOKEN_HASH=

# Alternativa multi-token: JSON array de hashes SHA-256 (hex64 cada uno).
# Ejemplo: ["abc123...","def456..."]
MCP_TOKENS=

# Rate limit por token MCP (independiente del global).
MCP_RATE_LIMIT_MAX=30
MCP_RATE_LIMIT_WINDOW_MS=60000

# Timeout del fetch de pay_x402 (ms).
MCP_PAY_TIMEOUT_MS=30000
```

### 6.2 Códigos de error JSON-RPC — tabla canónica (DT-8)

```ts
// src/mcp/types.ts
export const MCP_ERRORS = {
  PARSE_ERROR: -32700,        // AC-15: body no es JSON-RPC válido
  INVALID_REQUEST: -32600,    // AC-11: Unauthorized
  METHOD_NOT_FOUND: -32601,   // AC-16: tool name desconocido / método root
  INVALID_PARAMS: -32602,     // schema validation del input del tool
  TOOL_EXECUTION: -32001,     // AC-3: sign() failed / servicio interno throw
  UPSTREAM_GATEWAY: -32002,   // AC-4: retry 402 devolvió !2xx / maxAmountWei excedido
  TOO_MANY_REQUESTS: -32029,  // AC-12: rate limit excedido
} as const;
```

### 6.3 Shapes de tool (input/output)

**`pay_x402`:**
- **Input:** `{ gatewayUrl: string (uri), endpoint: string, method?: "GET"|"POST"|"PUT"|"DELETE" (default "POST"), payload?: unknown, headers?: Record<string,string>, maxAmountWei?: string (pattern ^\d+$) }`
- **Output:** `{ status: number, result: unknown, txHash?: string, amountPaid?: string }`

**`get_payment_quote`:**
- **Input:** `{ gatewayUrl: string (uri), endpoint: string }`
- **Output:** `{ required: boolean, amount?: string, token?: string, network?: string, description?: string }`

**`discover_agents`:**
- **Input:** `{ query?: string, maxPrice?: number, capabilities?: string[], limit?: number (default 20, max 100) }`
- **Output:** `DiscoveryResult` — `{ agents: Agent[], total: number, registries: string[] }` (reusar type existente).

**`orchestrate`:**
- **Input:** `{ goal: string, budget: number (>0), preferCapabilities?: string[], maxAgents?: number (1..20), a2aKey?: string }`
- **Output:** `{ orchestrationId: string, steps: ComposeStep[], result: unknown, kiteTxHash?: string, reasoning: string, protocolFeeUsdc: number }`

### 6.4 Envelope MCP `tools/call` (DT-10)

El router **siempre** envuelve el output de tool en:

```json
{
  "jsonrpc": "2.0",
  "id": <id>,
  "result": {
    "content": [{ "type": "text", "text": "<JSON.stringify(toolOutput)>" }],
    "isError": false
  }
}
```

En error de tool:
```json
{
  "jsonrpc": "2.0",
  "id": <id>,
  "error": { "code": -32001, "message": "..." }
}
```

### 6.5 Shape `tools/list` response (AC-14)

```json
{
  "jsonrpc": "2.0",
  "id": <id>,
  "result": {
    "tools": [
      { "name": "pay_x402", "description": "...", "inputSchema": { ... } },
      { "name": "get_payment_quote", "description": "...", "inputSchema": { ... } },
      { "name": "discover_agents", "description": "...", "inputSchema": { ... } },
      { "name": "orchestrate", "description": "...", "inputSchema": { ... } }
    ]
  }
}
```

### 6.6 Signatures exactas de funciones

```ts
// src/mcp/types.ts
export type ToolName = 'pay_x402' | 'get_payment_quote' | 'discover_agents' | 'orchestrate';
export interface ToolContext {
  requestId: string;
  tokenPrefix: string;  // primeros 8 chars del token (CD-3)
  log: FastifyBaseLogger;
}
export class MCPToolError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
    this.name = 'MCPToolError';
  }
}

// src/mcp/router.ts
export async function dispatch(
  req: unknown,
  ctx: ToolContext,
): Promise<MCPResponse>;

// src/mcp/tools/pay-x402.ts
export async function payX402(input: PayX402Input, ctx: ToolContext): Promise<PayX402Output>;

// src/mcp/tools/get-payment-quote.ts
export async function getPaymentQuote(input: GetPaymentQuoteInput, ctx: ToolContext): Promise<GetPaymentQuoteOutput>;

// src/mcp/tools/discover-agents.ts
export async function discoverAgents(input: DiscoverAgentsInput, ctx: ToolContext): Promise<DiscoveryResult>;

// src/mcp/tools/orchestrate.ts
export async function orchestrate(input: OrchestrateToolInput, ctx: ToolContext): Promise<OrchestrateToolOutput>;

// src/mcp/metrics.ts
export function incrementMcpToolCall(tool: ToolName, status: 'success' | 'error'): void;
export function renderMcpMetrics(): string;
```

---

## 7. Test Expectations — 19 tests mapeados 1:1 a ACs

| Test file | AC(s) | Tipo | Descripción |
|-----------|-------|------|-------------|
| `src/mcp/tools/pay-x402.test.ts` | AC-1 | unit | `402 → sign → retry 200 retorna txHash` (mock `fetch` + `vi.mock('../../adapters/registry.js')`) |
| `src/mcp/tools/pay-x402.test.ts` | AC-2 | unit | `response no-402 pasa directo`: `expect(mockSign).not.toHaveBeenCalled()` |
| `src/mcp/tools/pay-x402.test.ts` | AC-3 | unit | `sign() throws → MCPToolError(-32001)` con `message` pero sin stack en el MCP response |
| `src/mcp/tools/pay-x402.test.ts` | AC-4 | unit | `retry devuelve 500 → MCPToolError(-32002)` con `data: { status, body }` |
| `src/mcp/tools/get-payment-quote.test.ts` | AC-5 | unit | `endpoint no-402 → { required: false }` |
| `src/mcp/tools/get-payment-quote.test.ts` | AC-6 | unit | `endpoint 402 → parsea accepts[0]` retorna `amount/token/network/description` |
| `src/mcp/tools/discover-agents.test.ts` | AC-7 | unit | `llama discoveryService.discover` con `{ query, capabilities, maxPrice, limit: 20 }`; mock retorna `DiscoveryResult` **completo** (CD-9) |
| `src/mcp/tools/discover-agents.test.ts` | AC-8 | unit | `timeout TIMEOUT_ORCHESTRATE_MS`: mock `discover` jamás resuelve, test con env `TIMEOUT_ORCHESTRATE_MS=50`, esperar rejection con `-32001` en <200ms |
| `src/mcp/tools/orchestrate.test.ts` | AC-9 | unit | `happy path` retorna `orchestrationId + steps + result + reasoning + protocolFeeUsdc` |
| `src/mcp/tools/orchestrate.test.ts` | AC-10 | unit | `a2aKey se propaga`: `expect(mockOrchestrate).toHaveBeenCalledWith(expect.objectContaining({ a2aKey: 'wasi_a2a_...' }), expect.any(String))` |
| `src/mcp/auth.test.ts` | AC-11 | integration | `sin X-MCP-Token → HTTP 401 body { jsonrpc:"2.0", error:{ code:-32600, message:"Unauthorized" }, id: null }` |
| `src/mcp/rate-limit.test.ts` | AC-12 | integration | 31 requests con mismo token en la misma ventana → req 31 retorna HTTP 429 body `{ error:{ code:-32029, message:"Too Many Requests" } }` |
| `src/mcp/auth.test.ts` | AC-13 | integration | 3 sub-tests: `match MCP_TOKEN_HASH`, `match MCP_TOKENS array (segundo elemento)`, `no-match → 401` |
| `src/mcp/router.test.ts` | AC-14 | integration | `tools/list` retorna array de 4 tools con `name/description/inputSchema` |
| `src/mcp/router.test.ts` | AC-15 | integration | `body { "foo": 1 }` (no JSON-RPC) → HTTP 200 + body `{ error:{ code:-32700 } }` |
| `src/mcp/router.test.ts` | AC-16 | integration | `tools/call` con `params.name: "unknown_tool"` → `-32601` |
| `src/mcp/router.test.ts` | AC-17 | integration | spy `request.log.info`: encontrar call con `{ requestId, mcpToken: '8chars', tool, durationMs, success }` |
| `src/mcp/metrics.test.ts` | AC-18 | unit | `incrementMcpToolCall('pay_x402','success')` + `renderMcpMetrics()` contiene `mcp_tool_calls_total{tool="pay_x402",status="success"} 1` y `{...,status="error"} 0` |
| CI script | AC-19 | build | `npx tsc --noEmit` exit code 0 |

### Tests adicionales (auto-blindaje)

- `src/mcp/auth.test.ts` — `startup falla cuando MCP_TOKENS es JSON malformado` (defensa AB-035)
- `src/mcp/auth.test.ts` — `sin MCP_TOKEN_HASH ni MCP_TOKENS → 503` (fail-closed)
- `src/mcp/tools/pay-x402.test.ts` — `maxAmountWei guard: gateway pide más → -32002 sin llamar sign()`

### Criterio Test-First

| Tipo | Test-first? |
|------|-------------|
| Lógica de negocio (tools) | Sí |
| Router JSON-RPC | Sí |
| Auth / rate-limit | Sí |
| Config de plugin (`index.ts`) | No (wiring) |
| `.env.example` | No |

---

## 8. Waves de implementación

### Wave -1 — Environment Gate (OBLIGATORIO antes de tocar código)

```bash
# Verificar stack y deps existentes
cat package.json | grep -E '"fastify"|"@fastify/rate-limit"|"vitest"'
# Debe mostrar: "fastify": "^5.8.4", "@fastify/rate-limit": "^10.3.0", "vitest": "^4.1.4"

# Verificar archivos base de Scope IN
ls src/adapters/kite-ozone/payment.ts \
   src/adapters/types.ts \
   src/services/discovery.ts \
   src/services/orchestrate.ts \
   src/services/compose.ts \
   src/types/index.ts \
   src/routes/metrics.ts \
   src/middleware/rate-limit.ts \
   src/index.ts \
   .env.example
# Todos deben existir — si falta alguno, PARAR y escalar

# Verificar que NO existe src/mcp/ aún
test ! -d src/mcp/ && echo "OK: carpeta src/mcp/ libre" || echo "WARN: src/mcp/ ya existe"

# Verificar typecheck limpio de base
npx tsc --noEmit && echo "OK: baseline typecheck limpio"

# Verificar que getPaymentAdapter existe (requerido por E1)
grep -n "getPaymentAdapter" src/adapters/registry.ts && echo "OK"
```

**Si algo falla → PARAR y reportar al orquestador.**

### Wave 0 — Setup (serial)

- [ ] **W0.1** Crear carpeta `src/mcp/` y `src/mcp/tools/`.
- [ ] **W0.2** Agregar bloque MCP a `.env.example` (§6.1). Archivo F de §3.b.
- [ ] **W0.3** Verificar que `package.json` NO se modifica (0 deps nuevas — CD-11).

**Verificación W0:** `grep '^MCP_' .env.example | wc -l` → 5 líneas (5 vars).

### Wave 1 — Tipos, schemas, auth, metrics (paralelizable)

- [ ] **W1.1** Crear `src/mcp/types.ts` con todas las interfaces/enums de §6.2 y §6.6 (Archivo 1).
- [ ] **W1.2** Crear `src/mcp/schemas.ts` con `INPUT_SCHEMAS: Record<ToolName, JSONSchema>`, `TOOLS_MANIFEST`, `TOOL_DESCRIPTIONS` (Archivo 2). Usar shapes de §6.3.
- [ ] **W1.3** Crear `src/mcp/auth.ts` siguiendo Exemplar 13 (Archivo 3). Implementar `loadMcpTokenHashes()` que lee env y valida formato hex64.
- [ ] **W1.4** Crear `src/mcp/metrics.ts` siguiendo Exemplar 10 (Archivo 9). Map `<ToolName, {success, error}>` inicializado con 4 entries a 0.
- [ ] **W1.5** Crear `src/mcp/rate-limit.ts` siguiendo Exemplar 5 (Archivo 5).
- [ ] **W1.6** Crear `src/mcp/auth.test.ts` — 5 tests (AC-11 + AC-13 x3 + malformed MCP_TOKENS + 503 fail-closed) (Archivo 4).
- [ ] **W1.7** Crear `src/mcp/metrics.test.ts` — AC-18 (Archivo 10).

**Verificación W1:**
```bash
npx tsc --noEmit                                          # 0 errores
npx vitest run src/mcp/auth.test.ts src/mcp/metrics.test.ts  # verde
grep -rE "\\bany\\b|as unknown as|@ts-ignore" src/mcp/    # 0 líneas (CD-2)
```

### Wave 2 — Router + plugin + wiring (depende de W1)

- [ ] **W2.1** Crear `src/mcp/router.ts` (Archivo 7). Implementar `dispatch()`:
  - Valida `jsonrpc === "2.0"`, `typeof method === "string"`, `id` ∈ `string|number|null` → si falla → `-32700`.
  - `method === "tools/list"` → retorna `{ tools: TOOLS_MANIFEST }`.
  - `method === "tools/call"`:
    - Valida `params.name` ∈ `ToolName` → else `-32601`.
    - Valida `params.arguments` contra `INPUT_SCHEMAS[name]` usando el `ajv` compartido de Fastify (instanciar local con `new Ajv({ strict: false })` si hace falta).
    - Invoca el tool correspondiente con `(arguments, ctx)`.
    - **Timer:** `const t0 = Date.now();` al inicio, `durationMs = Date.now() - t0` al final.
    - **Log:** `ctx.log.info({ requestId, mcpToken: ctx.tokenPrefix, tool: name, durationMs, success: true }, 'mcp tool call')` (AC-17).
    - **Metrics:** `incrementMcpToolCall(name, 'success'|'error')` (AC-18).
    - **Wrap output:** `{ content: [{ type: 'text', text: JSON.stringify(output) }], isError: false }` (DT-10).
  - Catch: si error es `MCPToolError` → propagar `{ code, message, data }`; else → `-32001` con `err.message` (sin stack).
  - Cualquier otro `method` → `-32601`.

- [ ] **W2.2** Crear `src/mcp/index.ts` — plugin Fastify `POST /` (Archivo 11):
  ```ts
  import type { FastifyPluginAsync } from 'fastify';
  import { createMcpAuthHandler } from './auth.js';
  import { mcpRateLimitConfig } from './rate-limit.js';
  import { dispatch } from './router.js';
  import type { ToolContext } from './types.js';

  const mcpPlugin: FastifyPluginAsync = async (fastify) => {
    fastify.post<{ Body: unknown }>(
      '/',
      {
        config: { rateLimit: mcpRateLimitConfig() },
        preHandler: [createMcpAuthHandler()],
      },
      async (request, reply) => {
        const tokenPrefix =
          (request as typeof request & { mcpTokenPrefix?: string }).mcpTokenPrefix ?? '';
        const ctx: ToolContext = {
          requestId: request.id,
          tokenPrefix,
          log: request.log,
        };
        const response = await dispatch(request.body, ctx);
        // AC-15: MCP responses (even errors) HTTP 200 unless auth/rate-limit rejected earlier
        return reply.status(200).send(response);
      },
    );
  };
  export default mcpPlugin;
  ```

- [ ] **W2.3** Modificar `src/index.ts` (Archivo A) — registrar plugin (Exemplar 11, CD-14).

- [ ] **W2.4** Crear `src/mcp/router.test.ts` (Archivo 8) — AC-14, AC-15, AC-16, AC-17 (spy log).

- [ ] **W2.5** Crear `src/mcp/rate-limit.test.ts` (Archivo 6) — AC-12 (31 requests).

**Verificación W2:**
```bash
npx tsc --noEmit
npx vitest run src/mcp/
# Smoke local:
PORT=3001 MCP_TOKEN_HASH=$(echo -n test | sha256sum | cut -d' ' -f1) npm run dev &
sleep 2
curl -s -X POST http://localhost:3001/mcp \
  -H "X-MCP-Token: test" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' | jq '.result.tools | length'
# Expected: 4
curl -s -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' -w "%{http_code}\n"
# Expected: 401
kill %1
```

### Wave 3 — Tools `pay_x402` + `get_payment_quote` (paralelizable tras W2)

- [ ] **W3.1** Crear `src/mcp/tools/pay-x402.ts` (Archivo 12). Flujo:
  1. `const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), parseInt(process.env.MCP_PAY_TIMEOUT_MS ?? '30000', 10));`
  2. `const res1 = await fetch(input.gatewayUrl + input.endpoint, { method: input.method ?? 'POST', body: input.payload ? JSON.stringify(input.payload) : undefined, headers: { 'content-type': 'application/json', ...input.headers }, signal: ctl.signal });`
  3. Si `res1.status !== 402` → `clearTimeout(timer); return { status: res1.status, result: await parseBody(res1) };` (AC-2).
  4. Si `res1.status === 402`:
     - `const body = await res1.json() as X402Response;`
     - Validar `body.accepts?.[0]` existe → si no → `throw new MCPToolError(-32002, 'Invalid 402 response: missing accepts[0]')`.
     - Si `input.maxAmountWei && BigInt(body.accepts[0].maxAmountRequired) > BigInt(input.maxAmountWei)` → `throw new MCPToolError(-32002, 'Gateway requested amount exceeds maxAmountWei guard', { requested: body.accepts[0].maxAmountRequired, max: input.maxAmountWei })`.
     - **Sign (CD-1):** try/catch `signResult = await adapter.sign({ to, value, timeoutSeconds })`. Catch → `throw new MCPToolError(-32001, 'Signing failed: ' + (err as Error).message)` (AC-3).
  5. **Retry:** `const res2 = await fetch(..., { ..., headers: { ...headers, 'payment-signature': signResult.xPaymentHeader }, signal: ctl.signal });`
  6. Si `!res2.ok` → `throw new MCPToolError(-32002, 'Upstream gateway error after payment', { status: res2.status, body: await res2.text() })` (AC-4).
  7. `clearTimeout(timer); return { status: res2.status, result: await parseBody(res2), txHash: res2.headers.get('payment-response') ?? undefined, amountPaid: body.accepts[0].maxAmountRequired };`

  **PROHIBIDO:** importar `settle` o `verify` del adapter (CD-7).

- [ ] **W3.2** Crear `src/mcp/tools/get-payment-quote.ts` (Archivo 14). Flujo simple:
  - GET `input.gatewayUrl + input.endpoint`.
  - Si `status !== 402` → `return { required: false };` (AC-5).
  - Si `status === 402` → parse body y retornar `{ required: true, amount, token, network, description }` (AC-6).

- [ ] **W3.3** Crear `src/mcp/tools/pay-x402.test.ts` (Archivo 13). Mocks:
  - `vi.mock('../../adapters/registry.js', () => ({ getPaymentAdapter: () => ({ sign: vi.fn() }) }))`
  - `global.fetch = vi.fn()` (spy).
  - 5 tests: AC-1, AC-2, AC-3, AC-4, guard maxAmountWei.

- [ ] **W3.4** Crear `src/mcp/tools/get-payment-quote.test.ts` (Archivo 15). Mocks `fetch`. 2 tests: AC-5, AC-6.

**Verificación W3:**
```bash
npx vitest run src/mcp/tools/pay-x402.test.ts src/mcp/tools/get-payment-quote.test.ts
grep -E "adapter\\.(settle|verify)" src/mcp/tools/pay-x402.ts        # 0 líneas (CD-7)
grep -rE "signTypedData|EIP712_TYPES" src/mcp/                      # 0 líneas (CD-1)
```

### Wave 4 — Tools `discover_agents` + `orchestrate` + wiring final (depende de W3)

- [ ] **W4.0** **Precondición** — cambios aditivos en tipos/servicios (Archivos B, C, D):
  - [ ] B. En `src/types/index.ts`: agregar `a2aKey?: string;` a `OrchestrateRequest` (L196-205) y a `ComposeRequest` (L142-146).
  - [ ] C. En `src/services/orchestrate.ts`: propagar `request.a2aKey` al llamar `composeService.compose({ steps, maxBudget, a2aKey: request.a2aKey })`.
  - [ ] D. En `src/services/compose.ts`:
    - En `compose(request)` destructurar `const { steps, maxBudget, a2aKey } = request;`
    - Extender `invokeAgent(agent, input, a2aKey?: string)` para aceptar el parámetro opcional.
    - Dentro de `invokeAgent`, si `a2aKey` truthy: `headers['x-a2a-key'] = a2aKey;`
    - En la llamada a `this.invokeAgent(agent, input)` (L70) pasar `a2aKey`.
  - [ ] Verificar tests existentes: `npx vitest run src/services/orchestrate.test.ts src/services/compose.test.ts` siguen verdes (cambio aditivo, no breaking).

- [ ] **W4.1** Crear `src/mcp/tools/discover-agents.ts` (Archivo 16):
  ```ts
  const timeoutMs = parseInt(process.env.TIMEOUT_ORCHESTRATE_MS ?? '120000', 10);
  const timeoutPromise = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new MCPToolError(MCP_ERRORS.TOOL_EXECUTION, 'Discovery timeout')), timeoutMs),
  );
  return await Promise.race([
    discoveryService.discover({ query: input.query, capabilities: input.capabilities, maxPrice: input.maxPrice, limit: input.limit ?? 20 }),
    timeoutPromise,
  ]);
  ```

- [ ] **W4.2** Crear `src/mcp/tools/orchestrate.ts` (Archivo 18):
  ```ts
  const orchestrationId = crypto.randomUUID();
  const result = await orchestrateService.orchestrate(
    {
      goal: input.goal,
      budget: input.budget,
      preferCapabilities: input.preferCapabilities,
      maxAgents: input.maxAgents,
      a2aKey: input.a2aKey,   // AC-10: propaga
    },
    orchestrationId,
  );
  return {
    orchestrationId,
    steps: result.pipeline.steps.map(toComposeStepSummary),  // ComposeStep-like subset
    result: result.answer,
    kiteTxHash: result.attestationTxHash,
    reasoning: result.reasoning,
    protocolFeeUsdc: result.protocolFeeUsdc,
  };
  ```

- [ ] **W4.3** Crear `src/mcp/tools/discover-agents.test.ts` (Archivo 17) — AC-7 (mock **completo** con `registries: []` — CD-9), AC-8 (timeout con env `TIMEOUT_ORCHESTRATE_MS=50`).

- [ ] **W4.4** Crear `src/mcp/tools/orchestrate.test.ts` (Archivo 19) — AC-9 (happy), AC-10 (verifica `expect.objectContaining({ a2aKey: 'wasi_a2a_test' })`).

- [ ] **W4.5** Modificar `src/routes/metrics.ts` (Archivo E) — agregar `import { renderMcpMetrics } from '../mcp/metrics.js';` al tope y `lines.push(renderMcpMetrics());` inmediatamente antes de `return reply.type(...).send(...)` (L140).

**Verificación W4:**
```bash
npx tsc --noEmit
npx vitest run                                                    # TODOS los tests verdes
# Smoke /metrics:
curl -s http://localhost:3001/metrics | grep "^mcp_tool_calls_total"
# Expected: 8 líneas (4 tools x 2 status), todas con valor 0
```

### Wave 5 — Verificación final

- [ ] **W5.1** `npx tsc --noEmit` → exit 0 (AC-19).
- [ ] **W5.2** `npx vitest run` → 19+ tests verdes.
- [ ] **W5.3** Checks anti-hallucination (grep CDs):
  ```bash
  grep -rE "\\bany\\b" src/mcp/ | grep -v "//"                 # 0 (CD-2)
  grep -rE "as unknown as" src/mcp/                            # 0 (CD-2)
  grep -rE "@ts-ignore|@ts-expect-error" src/mcp/              # 0 (CD-2)
  grep -E "adapter\\.(settle|verify)" src/mcp/tools/pay-x402.ts  # 0 (CD-7)
  grep -rE "signTypedData|EIP712" src/mcp/                     # 0 (CD-1)
  ```
- [ ] **W5.4** `git diff package.json` → solo cambios en `scripts` si existen; **NO** deps nuevas (DT-1, CD-11).
- [ ] **W5.5** Smoke final con curl (ver §10 Readiness).

### Verificación incremental

| Wave | Comando | Criterio |
|------|---------|----------|
| W0 | `grep '^MCP_' .env.example \| wc -l` | = 5 |
| W1 | `npx tsc --noEmit && npx vitest run src/mcp/auth.test.ts src/mcp/metrics.test.ts` | verde |
| W2 | `npx vitest run src/mcp/ && curl smoke tools/list` | 4 tools |
| W3 | `npx vitest run src/mcp/tools/pay-x402.test.ts src/mcp/tools/get-payment-quote.test.ts` + greps CD | verde + 0 |
| W4 | `npx vitest run` (todo el repo) | verde |
| W5 | greps CD-1..CD-14 + `tsc --noEmit` | 0 / exit 0 |

---

## 9. Out of Scope — NO tocar

- `src/adapters/kite-ozone/payment.ts` — solo leer; **NO** modificar (CD-1).
- `src/middleware/rate-limit.ts` — NO tocar el global, solo se agrega el inline config para la route MCP.
- `src/middleware/error-boundary.ts` — MCP formatea error **antes** del boundary; NO modificar el boundary.
- `src/middleware/security-headers.ts` — ya aplica globalmente; NO reaplicar.
- `src/middleware/a2a-key.ts` — es un exemplar; NO modificar.
- Routes existentes: `/discover`, `/orchestrate`, `/compose`, `/auth/*`, `/tasks`, `/dashboard`, `/.well-known`, `/agents`, `/gasless`, `/registries`, `/mock-registry` — NO tocar.
- **NO** instalar `@modelcontextprotocol/sdk` (DT-1).
- **NO** agregar nuevas rutas a `src/mcp/` (solo `POST /`).
- **NO** implementar `resources/*`, `prompts/*`, SSE ni stdio transport.
- **NO** persistir tokens MCP en DB (auth estática por env en esta HU).
- **NO** "mejorar" código adyacente fuera de §3.b.

---

## 10. Readiness Check — smoke tests finales

```bash
# 1. Build limpio
npx tsc --noEmit
# exit: 0

# 2. Tests
npx vitest run
# expected: 19+ tests green, 0 red

# 3. Grep CDs
grep -rE "\\bany\\b" src/mcp/ | grep -v "^\\s*//"                       # 0
grep -rE "as unknown as|@ts-ignore|@ts-expect-error" src/mcp/            # 0
grep -E "adapter\\.(settle|verify)" src/mcp/tools/pay-x402.ts            # 0
grep -rE "signTypedData|EIP712" src/mcp/                                 # 0

# 4. Levantar server con config mínima
export MCP_TOKEN_HASH=$(printf 'demo-token' | sha256sum | cut -d' ' -f1)
export KITE_OPERATOR_PRIVATE_KEY=0x$(printf '%.0s0' {1..64})  # placeholder solo para que boot no falle
npm run dev &
SERVER_PID=$!
sleep 3

# 5. tools/list con token válido → 4 tools
curl -s -X POST http://localhost:3001/mcp \
  -H "X-MCP-Token: demo-token" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' | jq '.result.tools | length'
# expected: 4

# 6. Sin token → 401 JSON-RPC
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
# expected: 401

# 7. Body no-JSON-RPC → 200 + -32700
curl -s -X POST http://localhost:3001/mcp \
  -H "X-MCP-Token: demo-token" \
  -H "Content-Type: application/json" \
  -d '{"foo":"bar"}' | jq '.error.code'
# expected: -32700

# 8. Method unknown → -32601
curl -s -X POST http://localhost:3001/mcp \
  -H "X-MCP-Token: demo-token" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"unknown","id":2}' | jq '.error.code'
# expected: -32601

# 9. Rate limit: 31 requests → el 31 es 429
for i in {1..31}; do
  curl -s -o /dev/null -w "%{http_code} " -X POST http://localhost:3001/mcp \
    -H "X-MCP-Token: demo-token" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"tools/list","id":'$i'}'
done; echo
# expected: 200 ... 200 429 (último es 429)

# 10. Métricas Prometheus
curl -s http://localhost:3001/metrics | grep '^mcp_tool_calls_total'
# expected: 8 líneas (4 tools × 2 statuses)

kill $SERVER_PID
```

Todos los checks en verde → **F3 completa, listo para Adversary Review**.

---

## 11. Escalation Rule

> **Si algo NO está en este Story File, Dev PARA y escala a Architect.**
> No inventar. No asumir. No improvisar.

Situaciones que requieren escalación:
- `KiteOzonePaymentAdapter.sign()` cambió de firma desde la lectura del SDD (ej: por merge de WKH-037-X402-V2).
- `DiscoveryResult` o `OrchestrateResult` agregaron campos obligatorios nuevos.
- `@fastify/rate-limit` v10 tiene breaking change en `keyGenerator` (chequear `node_modules/@fastify/rate-limit/types/...`).
- Ambigüedad en cómo mapear `result.pipeline.steps` → `ComposeStep[]` (el shape retornado al MCP).
- Algún AC no se puede cubrir con el plan de test propuesto.
- El cambio aditivo a `ComposeRequest`/`OrchestrateRequest` rompe un test existente y requiere más cambios.

**Protocolo:** comentá en el chat del orquestador el problema + archivo:línea. Architect actualiza el Story File antes de que Dev continúe.

---

*Story File emitido por nexus-architect · F2.5 · WKH-MCP-X402 · 2026-04-13*
