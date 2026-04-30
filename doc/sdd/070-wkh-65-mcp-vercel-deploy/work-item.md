# Work Item — [WKH-65] [MCP-VERCEL] HTTP transport for wasiai-x402 + Vercel remote deploy

> Fase F1 (analyst) — modo AUTO FAST+AR. Ticket: https://ferrosasfp.atlassian.net/browse/WKH-65
> Predecesor inmediato: `doc/sdd/069-wkh-64-mcp-x402/` (DONE 2026-04-30, commit 6b22e09)

## Product Context

[SIN PRODUCT CONTEXT — work-item self-contained, narrativa en CLAUDE.md, HACKATHON-FINAL.md, y description del ticket Jira]

## Resumen

Agregar transport HTTP Streamable a `mcp-servers/wasiai-x402/` y desplegarlo en Vercel como función serverless, exponiendo un endpoint público (`https://wasiai-x402-mcp.vercel.app/api/mcp`) que los Claude Console managed agents puedan consumir como Remote MCP vía "Add Remote MCP" UI. El paquete ya tiene los 3 handlers stdio (WKH-64, DONE). Esta HU agrega: auth bearer token (timing-safe), `WebStandardStreamableHTTPServerTransport` del MCP SDK 1.29.0 (ya instalado, Web Standards API — compatible con Vercel Serverless), `vercel.json` con timeout 60s, extracción de handlers a `src/handlers.mjs` para reuso stdio↔HTTP sin duplicación, y tests para el HTTP path.

## Sizing

- **SDD_MODE**: mini (FAST+AR — nuevo HTTP surface, auth, deploy config, pero scope acotado a un paquete ya existente, 0 cambios a `src/` del repo principal)
- **Estimación**: S (6-8 archivos nuevos/modificados, todo dentro de `mcp-servers/wasiai-x402/`, sin schema changes ni DB)
- **Pipeline**: FAST+AR — toca auth (bearer token validation) y abre un endpoint público; Adversary Review obligatorio
- **Branch sugerido**: `feat/070-wkh-65-mcp-vercel-deploy` desde `main@6b22e09`
- **Skills router**: (1) `mcp-protocol` (MCP SDK 1.29.0 — `WebStandardStreamableHTTPServerTransport`), (2) `vercel-serverless` (Vercel functions, Web Standards API, Serverless config)

### Veredicto sizing FAST+AR vs QUALITY

**FAST+AR confirmado**. Argumentos a favor de no escalar a QUALITY:
1. Paquete ya existente con estructura de módulos bien definida — no hay greenfield de arquitectura, sólo agregar un transport.
2. `WebStandardStreamableHTTPServerTransport` ya está en SDK 1.29.0 instalado — DT-A verificado, no hay exploración.
3. Scope está acotado: 0 cambios a `src/` del repo principal, 0 cambios a DB, 0 cambios a wasiai-v2.
4. Handlers ya encapsulados (exportados como funciones puras en `src/index.mjs`) — refactor a `src/handlers.mjs` es movimiento mecánico.

Argumentos a favor de AR obligatorio (no bajar a FAST puro):
- Abre un endpoint público autenticado con bearer token — superficie de ataque nueva.
- CORS misconfiguration podría permitir leakage cross-origin.
- Cold-start race condition en stateless mode podría introducir inconsistencias.
- Bearer token replay si no se toman precauciones de transport (HTTPS-only en Vercel es default, pero debe documentarse).

---

## Acceptance Criteria (EARS)

### Funcionales — happy path HTTP

- **AC-1**: WHEN POST /api/mcp con JSON-RPC `initialize`, the system SHALL responder 200 con `serverInfo` `{name:"wasiai-x402", version:"0.1.0"}` y `capabilities.tools:{}`.
- **AC-2**: WHEN POST /api/mcp con JSON-RPC `tools/list`, the system SHALL retornar array con exactamente 3 tools (`discover_agents`, `get_payment_quote`, `pay_x402`) con sus schemas intactos.
- **AC-3**: WHEN POST /api/mcp con JSON-RPC `tools/call` para cualquiera de los 3 tools, the system SHALL delegar al handler correspondiente en `src/handlers.mjs` y devolver el mismo resultado que el transport stdio bajo idénticas condiciones.
- **AC-4**: WHEN se invoca `pay_x402` via HTTP transport, the system SHALL ejecutar el flujo completo x402 (probe→sign→retry) igual que stdio — mismo shape de response, mismo envelope, mismos guards AC-11 del WI-064.

### Auth

- **AC-5**: IF la request a POST /api/mcp no incluye header `Authorization`, THEN the system SHALL responder 401 con body `{"error":"unauthorized"}` ANTES de parsear el JSON-RPC body.
- **AC-6**: IF el header `Authorization` no matchea `Bearer <token>` exacto (comparación timing-safe HMAC-SHA256), THEN the system SHALL responder 401 con body `{"error":"unauthorized"}`. La respuesta SHALL ser idéntica a AC-5 (no leak info sobre si el token existe o no).
- **AC-7**: IF `MCP_BEARER_TOKEN` no está seteada al arrancar la función, THEN the system SHALL fallar con status 500 y log de error estructurado BEFORE procesar cualquier request. La función NO arranca en estado sin auth.

### Seguridad / Constraint HTTP

- **AC-8**: WHILE la función corre, the system SHALL NEVER loggear `OPERATOR_PRIVATE_KEY`, `MCP_BEARER_TOKEN`, ni el valor del header `Authorization`. Tests SHALL cubrir este invariant con spy sobre `process.stderr.write`.
- **AC-9**: WHEN la función recibe una request con origin no listado en `MCP_CORS_ALLOWED_ORIGINS` (o sin esa var), the system SHALL responder headers CORS restrictivos: `Access-Control-Allow-Origin` ausente o igual al origin exacto declarado. Preflight OPTIONS SHALL responder 204 con headers CORS correctos.
- **AC-10**: WHERE `vercel.json` declara la función `api/mcp.mjs`, the system SHALL configurar `maxDuration: 60` (≥ latencia ~18-25s del flow x402 + buffer).

### Deploy / Config

- **AC-11**: WHEN se deploya a Vercel con `vercel deploy`, the system SHALL leer `OPERATOR_PRIVATE_KEY`, `MCP_BEARER_TOKEN`, y `WASIAI_GATEWAY_URL` exclusivamente de Vercel environment secrets (NO hardcoded, NO en `vercel.json` en texto plano).
- **AC-12**: WHEN `vercel.json` se commitea, the system SHALL referenciar env vars por nombre de variable (Vercel env var reference), no por valor.

### Tests

- **AC-13**: WHERE existe el suite de tests, the system SHALL incluir tests para el HTTP path que cubran: (a) request sin `Authorization` → 401, (b) request con token incorrecto → 401, (c) request con token correcto + `initialize` → 200, (d) `tools/list` → 3 tools, (e) `tools/call` discover_agents → delega al handler (mock fetch), (f) PK y bearer token ausentes en logs (spy). Sin requests HTTP reales (mocks de `globalThis.fetch`). Tests corren con `node --test`.
- **AC-14**: WHEN `README.md` se actualiza, the system SHALL incluir sección "Deploy a Vercel" con pasos exactos: (a) `vercel login`, (b) `vercel env add MCP_BEARER_TOKEN` + `OPERATOR_PRIVATE_KEY` + `WASIAI_GATEWAY_URL`, (c) `vercel deploy`, (d) cómo configurar el endpoint en Claude Console "Add Remote MCP" con el bearer token.
- **AC-15**: WHEN `.env.example` se actualiza, the system SHALL documentar `MCP_BEARER_TOKEN` con: nombre, obligatoria=sí (para HTTP), formato `hex 64 chars (openssl rand -hex 32)`, ejemplo redactado.

### Reuso stdio (no regresión)

- **AC-16**: WHILE el refactor de `src/handlers.mjs` está aplicado, the system SHALL mantener el transport stdio (`StdioServerTransport`) funcionando sin cambios de comportamiento — `npm start` (stdio) y `node api/mcp.mjs` (HTTP) deben coexistir.

---

## Scope IN

Todo dentro de `mcp-servers/wasiai-x402/`:

1. `src/handlers.mjs` (nuevo) — extracción de los handlers ya exportados de `src/index.mjs` + utilidades asociadas (`sanitizeInput`, `resolveEndpoint`, `resolveMaxAmountGuard`, `TOOL_DESCRIPTORS`, handlers de los 3 tools). Ver "Decisión refactor" abajo.
2. `src/index.mjs` (modificar) — reemplazar definiciones inline de handlers/utils por imports de `src/handlers.mjs`. Bootstrap stdio sin cambios de comportamiento.
3. `src/auth.mjs` (nuevo) — bearer token validation: `validateBearerToken(authHeader, expectedToken)` con timing-safe compare vía `node:crypto.timingSafeEqual`. Throws `AuthError` si falla; retorna `true` si ok.
4. `api/mcp.mjs` (nuevo) — Vercel Serverless Function. Imports: `WebStandardStreamableHTTPServerTransport` de `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`, handlers de `src/handlers.mjs`, auth de `src/auth.mjs`, config de `src/config.mjs`, log de `src/log.mjs`. Maneja: (a) OPTIONS preflight CORS, (b) auth bearer antes de parsear body, (c) instancia `WebStandardStreamableHTTPServerTransport` en modo stateless (`sessionIdGenerator: undefined`), (d) conecta `Server` al transport, (e) delega request, (f) retorna `Response`.
5. `vercel.json` (nuevo) — config: `functions["api/mcp.mjs"].maxDuration = 60`, runtime Node.js, region `iad1` (Virginia — cercana a Claude Console infra). NO rewrites ni routes complejas.
6. `tests/http.test.mjs` (nuevo) — tests del HTTP path (AC-13). Mock `WebStandardStreamableHTTPServerTransport` para evitar dependency en MCP SDK internals. `node --test`.
7. `README.md` (modificar) — nueva sección "Deploy a Vercel" (AC-14).
8. `.env.example` (modificar) — agregar `MCP_BEARER_TOKEN` y `MCP_CORS_ALLOWED_ORIGINS` (AC-15).
9. `package.json` (modificar si necesario) — agregar script `test:http` y script `vercel:deploy` si el team lo quiere. NO agregar `vercel` como dep de producción (sólo CLI dev-side).

## Scope OUT

- NO modificar `src/sign.mjs`, `src/url-validator.mjs`, `src/config.mjs`, `src/log.mjs` — reusables 1:1 sin cambios.
- NO modificar `src/` del repo principal (`wasiai-a2a/src/`).
- NO modificar `app.wasiai.io` ni `wasiai-v2`.
- NO publicar a npm.
- NO agregar Edge Runtime (`api/mcp.mjs` es Serverless Node.js, no Edge — Edge tiene APIs Node limitadas que bloquean `node:crypto.timingSafeEqual`).
- NO rate limiting en esta HU (deferido a HU posterior por DT-E).
- NO soporte SSE GET streaming (el Streamable HTTP transport en stateless mode usa POST; GET SSE es para clientes legacy — Claude Console usa POST).
- NO autenticación mutual TLS ni x-a2a-key — sólo bearer token en esta HU.
- NO modificar `.env.example` raíz del repo principal.
- NO cambiar el formato del envelope x402 ni los handlers de `src/handlers.mjs` (sólo moverlos de `src/index.mjs`).
- NO cambios a `vercel.json` del repo principal (si existe).

---

## Decisión refactor — extracción a `src/handlers.mjs`

**Decisión: SI — extraer.**

Justificación basada en lectura de `mcp-servers/wasiai-x402/src/index.mjs` (623 LOC):

Los handlers ya están implementados como funciones exportadas que reciben `(rawInput, cfg)`:
- `discoverAgentsHandler(rawInput, cfg)`
- `getPaymentQuoteHandler(rawInput, cfg)`
- `payX402Handler(rawInput, cfg)`

Además exportan utilidades puras:
- `sanitizeInput(toolName, input)`
- `resolveEndpoint(endpoint, gatewayUrl)`
- `resolveMaxAmountGuard(perCall, envDefault)`
- `TOOL_DESCRIPTORS` (array constante)
- `isRedirectError(e)` (helper interno, puede quedar en handlers.mjs)
- `REDIRECT_REFUSED_MSG` (constante)

**No hay cierre sobre estado de bootstrap** — cada handler recibe `cfg` como argumento. La extracción es mecánica: mover los `export function` y `export const` a `src/handlers.mjs`, actualizar `src/index.mjs` para importarlos, e importarlos también desde `api/mcp.mjs`.

Costo: ~10 líneas de import changes en `src/index.mjs`. Beneficio: evita duplicar ~350 LOC de lógica de handlers en `api/mcp.mjs`, asegura que stdio y HTTP usan exactamente la misma lógica (0 drift), y simplifica future maintenance.

Alternativa rechazada (mantener inline + duplicar): duplicaría los 3 handlers + 4 utilidades (350 LOC aprox.) — inaceptable dado que el refactor es de riesgo bajo y los handlers ya tienen la API correcta.

---

## Decisiones técnicas (DT-N)

- **DT-A** [VERIFICADO F1]: Transport HTTP = `WebStandardStreamableHTTPServerTransport` (ya en SDK 1.29.0, import path: `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`). Acepta `Request` nativo y retorna `Promise<Response>` — encaja 1:1 con Vercel Serverless handler signature. La clase Node.js `StreamableHTTPServerTransport` (wraps `@hono/node-server`) NO es la correcta para Vercel — usar `WebStandardStreamableHTTPServerTransport` directamente.

- **DT-B** [CONFIRMADO]: Vercel runtime = Node.js Serverless Function (`"runtime":"nodejs22.x"` o default de Vercel para node 20+). No Edge. Razón: Edge runtime no expone `node:crypto.timingSafeEqual` ni `node:crypto.randomBytes` (usados en `src/sign.mjs` y `src/auth.mjs`).

- **DT-C** [CONFIRMADO]: Function timeout = 60s (`maxDuration: 60` en `vercel.json`). Justificación: flujo x402 típico es 18-25s (probe + sign + settle + Kite + Avalanche). 30s es insuficiente para cold-start + latencia total. 60s es el máximo en Vercel Hobby; si se requiere plan Pro para más, documentar en README.

- **DT-D** [CONFIRMADO]: Bearer token format = `Bearer <hex 64-chars>` generado con `openssl rand -hex 32`. Comparación timing-safe con `node:crypto.timingSafeEqual` sobre buffers UTF-8 de igual longitud. Si longitudes difieren, responder 401 sin comparación (no hay leak timing por longitud — el tamaño del token es knowledge pública del formato).

- **DT-E** [DEFERIDO]: Rate limiting no entra en esta HU. Vercel tiene rate limiting básico por IP en el plan Pro. Para demo, aceptable. HU posterior si es necesario.

- **DT-F** [CONFIRMADO]: Transport mode = **stateless** (`sessionIdGenerator: undefined`). Justificación: Vercel Serverless functions son stateless por diseño (no hay in-memory session entre invocaciones). Claude Console MCP client soporta stateless mode en Streamable HTTP (post-MCP spec 2024-11-05). No se usa SSE GET standalone — cada request POST es self-contained.

- **DT-G** [NUEVO]: CORS — la variable `MCP_CORS_ALLOWED_ORIGINS` (CSV) controlará qué origins pueden hacer requests. Default vacío = denegar todos los cross-origin (Claude Console no requiere CORS si usa el mismo origin o si el API client no corre en browser — verificar con Adversary). Preflight OPTIONS responde 204 con headers apropiados sólo para origins permitidos.

- **DT-H** [NUEVO]: `api/mcp.mjs` instancia un nuevo `Server` + `WebStandardStreamableHTTPServerTransport` por request (stateless). No hay singleton entre invocaciones. Esto implica que `loadConfig()` se llama en cada request — aceptable dado que es O(1) y falla rápido si env vars faltan.

---

## Constraint Directives (CD-N)

- **CD-1**: `OPERATOR_PRIVATE_KEY` y `MCP_BEARER_TOKEN` SOLO via Vercel environment secrets (o `.env` local en dev). PROHIBIDO en código, en `vercel.json` como valor literal, en logs, en response bodies.
- **CD-2**: Bearer token comparison OBLIGATORIO timing-safe (`node:crypto.timingSafeEqual`). PROHIBIDO comparación con `===` o `indexOf` o cualquier método que haga cortocircuito.
- **CD-3**: OBLIGATORIO reusar `src/sign.mjs`, `src/url-validator.mjs`, `src/config.mjs`, `src/log.mjs`, y los handlers de `src/handlers.mjs` — NO duplicar lógica en `api/mcp.mjs`.
- **CD-4**: `api/mcp.mjs` DEBE importar handlers desde `src/handlers.mjs` (no inline los handlers). El match exacto con stdio es invariant.
- **CD-5**: Logs estructurados (heredar de `log.mjs`). PROHIBIDO `console.log` plano en `api/mcp.mjs` o `src/auth.mjs`. Stderr en Vercel va a Vercel Logs.
- **CD-6**: PROHIBIDO commitear bearer token real. `.env.example` usa placeholder `your-secret-hex-64-chars-here`.
- **CD-7**: `api/mcp.mjs` DEBE fallar con 500 (y log de error antes de procesar requests) si `MCP_BEARER_TOKEN` o `OPERATOR_PRIVATE_KEY` están ausentes — igual que `loadConfig()` con `ConfigError`. PROHIBIDO arrancar con auth desactivado.
- **CD-8**: `WebStandardStreamableHTTPServerTransport` DEBE instanciarse en modo **stateless** (`sessionIdGenerator: undefined`). PROHIBIDO usar `sessionIdGenerator: () => crypto.randomUUID()` (stateful requiere in-memory session que no persiste entre Vercel invocations).
- **CD-9**: `redirect:'error'` en todos los `fetch()` de `api/mcp.mjs` — ya garantizado porque se reusan los handlers que implementan BLQ-iter3-1.
- **CD-10**: `vercel.json` MUST NOT incluir `env` con valores literales de secrets. Usar referencias a Vercel env vars o dejar que Vercel los inyecte por nombre.

---

## Missing Inputs

- **[NEEDS CLARIFICATION en F2]** DT-G: ¿Claude Console "Add Remote MCP" envía requests desde browser (requiere CORS) o desde un backend proxy que no necesita CORS? Si es backend proxy, `MCP_CORS_ALLOWED_ORIGINS` puede dejarse vacío sin impacto funcional. Adversary debe verificar este punto.
- **[NEEDS CLARIFICATION en F2]** ¿`vercel.json` declara `region: "iad1"` o usar el default de Vercel? Si `app.wasiai.io` está en `iad1`, pinearlo reduciría latencia. Si `app.wasiai.io` está en otra región, el default puede ser mejor. Architect decide.
- **[RESUELTO F1]** DT-A: `WebStandardStreamableHTTPServerTransport` confirmado en SDK 1.29.0.
- **[RESUELTO F1]** DT-B: Node.js Serverless (no Edge) confirmado.
- **[RESUELTO F1]** DT-F: stateless mode confirmado para Vercel.
- **[RESUELTO F1]** Refactor handlers: SI — `src/handlers.mjs`.
- **[RESUELTO F1]** Smart Sizing: FAST+AR confirmado (no QUALITY).

---

## Análisis de paralelismo

- **NO bloquea otras HUs server-side**. Todo el trabajo es dentro de `mcp-servers/wasiai-x402/` — 0 cambios a `src/` del repo principal.
- **NO depende de HUs en flight**. Los handlers ya existen (WKH-64 DONE). La infra Vercel no depende de Railway.
- **Puede correr en paralelo con**: WKH-SEC-02 (RLS), WKH-54 (tasks ownership), cualquier HU server-side — no comparten archivos.
- **Esta HU es prerequisito para**: demo de Claude Console "Add Remote MCP" con el endpoint público. La validación E2E (Claude Console → `https://wasiai-x402-mcp.vercel.app/api/mcp` → `app.wasiai.io` → Avalanche) es gate humano post-deploy.
- **Branch base**: `main@6b22e09` (commit post-merge WKH-64). El predecesor está merged.

---

## Categorías de riesgo (para Adversary Review — AR)

1. **Auth bypass** (ALTO impacto, MEDIO prob): si la comparación bearer token tiene timing leak o el check se hace después del parse del body, un attacker podría hacer brute-force timing. Mitigado por CD-2 (`timingSafeEqual`) + AC-5 (check ANTES del parse). AR debe verificar el orden de operaciones en `api/mcp.mjs`.

2. **CORS misconfiguration** (MEDIO impacto, MEDIO prob): si `Access-Control-Allow-Origin: *` se setea por error, cualquier página web puede hacer POST al endpoint con el bearer token del usuario. AR debe verificar que el default es "deny" y que el handler OPTIONS no expone el token.

3. **Replay de envelope x402** (MEDIO impacto, BAJO prob en prod): el envelope firmado en `pay_x402` tiene `validBefore = now+300`. Si la función Vercel es slow (cold-start + flow = ~40s) y el `validBefore` es demasiado corto, el facilitator rechaza. DT-C (60s timeout) mitiga el cold-start, pero AR debe verificar que el `validBefore` en `sign.mjs` sigue siendo suficiente.

4. **Cold-start race + stateless transport** (BAJO impacto, BAJO prob): `WebStandardStreamableHTTPServerTransport` instanciado por-request. Si hay inicialización async no awaiteada en el module-level, dos concurrent requests podrían interferir. AR debe verificar que `api/mcp.mjs` no tiene state compartido entre requests.

5. **Env var leak en Vercel Logs** (ALTO impacto, BAJO prob si CD-5 se respeta): Vercel Logs captura stderr de la función. Si `log.mjs` o `api/mcp.mjs` logean el bearer token o la PK, quedan expuestos en el dashboard de Vercel. AC-8 + CD-1 + CD-5 mitigan. AR debe hacer grep de `process.env.MCP_BEARER_TOKEN` y `process.env.OPERATOR_PRIVATE_KEY` en `api/mcp.mjs` + `src/auth.mjs`.

6. **Path traversal / URL manipulation en Vercel routing** (BAJO impacto): si `vercel.json` tiene rewrites que re-ruteen `/api/mcp/*` a handlers inesperados. AR verifica que `vercel.json` no tiene rewrites/routes que expandan el surface de `api/mcp.mjs`.

7. **Bearer token en URL** (MEDIO impacto si ocurre): Claude Console podría enviar el token en query string en lugar de header si está mal configurado. El endpoint NO debe aceptar token en query string. AR verifica que `src/auth.mjs` sólo acepta el header `Authorization`.
