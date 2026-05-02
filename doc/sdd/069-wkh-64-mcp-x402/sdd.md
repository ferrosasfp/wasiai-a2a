# SDD #069: [MCP-X402] Build wasiai-x402 MCP server for Claude Console managed agents (WKH-64)

> SPEC_APPROVED: no
> Fecha: 2026-04-29
> Tipo: feature
> SDD_MODE: full (QUALITY)
> Branch: feat/069-wkh-64-mcp-x402 (desde main@43091fd)
> Artefactos: doc/sdd/069-wkh-64-mcp-x402/
> Predecesor histórico (NO copiar): doc/sdd/042-mcp-server-x402/ — DONE 2026-04-13, predates mainnet hybrid + envelope v2 + decimals 18

---

## 1. Resumen

Construir un **paquete MCP server standalone** bajo `mcp-servers/wasiai-x402/` que exponga 3 tools (`discover_agents`, `get_payment_quote`, `pay_x402`) consumibles por un agent administrado en Claude Console (Sonnet 4.6) para ejecutar pagos x402 contra `app.wasiai.io` y disparar el E2E live mainnet hybrid (Kite testnet PYUSD inbound → Avalanche C-Chain mainnet USDC outbound) sin código local. El paquete es client-side, vive fuera de `src/`, no se publica a npm en esta HU, y se valida con golden-vector tests determinísticos contra el envelope que prueba el smoke script vigente (`scripts/smoke-prod-via-app-wasiai.mjs:47-68`).

Resultado esperado: un agent en Claude Console invoca `pay_x402` y obtiene una respuesta del gateway `app.wasiai.io` con `kiteTxHash` + `downstreamTxHash` real, sin que la `OPERATOR_PRIVATE_KEY` salga del proceso ni aparezca en logs.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 069 |
| **HU** | WKH-64 |
| **Tipo** | feature |
| **SDD_MODE** | full (QUALITY) |
| **Objetivo** | MCP server con 3 tools que expone el flujo x402 (discover/quote/pay) hacia `app.wasiai.io` desde Claude Console. |
| **Reglas de negocio** | Crypto-sensitive: maneja `OPERATOR_PRIVATE_KEY` y firma EIP-3009. Mainnet exposure: cada `pay_x402` exitoso genera tx real en Avalanche. PK SOLO via env, jamás en logs. |
| **Scope IN** | `mcp-servers/wasiai-x402/{package.json, src/index.mjs, src/sign.mjs, src/config.mjs, src/log.mjs, src/url-validator.mjs, README.md, .env.example, .gitignore, tests/sign.test.mjs, tests/config.test.mjs, tests/url-validator.test.mjs, tests/tools.test.mjs}` |
| **Scope OUT** | NO modificar `src/`, NO publicar a npm, NO E2E con dinero real, NO añadir multi-chain dinámico, NO `compose`/`orchestrate` dentro del MCP, NO polling de tasks (HU posterior si el flow async lo necesita), NO health/version tools, NO modificar `.env.example` raíz. |
| **Missing Inputs** | DT-A, DT-G, tools opcionales — todos resueltos en sección 11 (DT) más abajo. |

### Acceptance Criteria (EARS) — heredados de work-item.md (16 ACs)

Listados textualmente en work-item.md líneas 34-69. Cada AC se mapea a tests en sección 14.

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `scripts/smoke-prod-via-app-wasiai.mjs` (líneas 1-68, full) | Golden vector del envelope x402 vigente en prod. Es el contrato que el facilitator espera; cualquier divergencia rompe `verify()`. | (a) Domain EIP-712 `{name:'PYUSD', version:'1', chainId:2368, verifyingContract:KITE_PYUSD}` (líneas 51-56). (b) Types `TransferWithAuthorization` con 6 campos (líneas 57-60). (c) Message `{from, to, value, validAfter:0n, validBefore=now+300, nonce=randomBytes(32) hex prefijo 0x}` (líneas 48-49, 62). (d) Envelope = `Buffer.from(JSON.stringify({signature, authorization:{...value/validAfter/validBefore como string, nonce hex 0x...}, network:'eip155:2368'})).toString('base64')` (líneas 64-68). (e) Header HTTP = `payment-signature: <envelope>` (línea 119). (f) `value` se serializa con `.toString()` (BigInt → string). |
| `.env.example` (líneas 1-301, full) | Confirmar nombres canónicos de env vars y defaults del repo principal — el MCP cliente reusa los mismos nombres para reducir confusión operacional. | `OPERATOR_PRIVATE_KEY=0xYourOperatorPrivateKey` (línea 135) — placeholder pattern obligatorio. `X402_PAYMENT_TOKEN=0x8E04D...` (línea 114) confirma contract address. `X402_EIP712_DOMAIN_NAME=PYUSD` (línea 117) y `X402_EIP712_DOMAIN_VERSION=1` (línea 120) confirman domain. `KITE_PAYMENT_AMOUNT=1000000000000000000` (línea 106) confirma decimals 18 (1 PYUSD = 10^18 wei). `MCP_MAX_AMOUNT_WEI_DEFAULT` (línea 248) y `MCP_GATEWAY_ALLOWLIST` (línea 235) son env vars del MCP server-side viejo (042) — los reusamos textualmente para el cliente. |
| `src/lib/url-validator.ts` (líneas 1-323, full) | Pattern de SSRF guard ya verificado y test-cubierto en server-side. Incluye IPv4 + IPv6 + IPv4-mapped + zone-id stripping + RFC 1035 trailing dot. | (a) Chequeos en orden: parse → protocol http/https → literal block (`localhost`, `*.local`, `*.localhost`) → allowlist (CSV env) → DNS lookup → reject IPv4 priv (10/8, 127/8, 169.254/16, 172.16-31, 192.168/16, 0.x) e IPv6 priv (`::1`, `::`, `fc..`/`fd..`, `fe[89ab]..`, `::ffff:` mapped). (b) `dns.lookup` no `dns.resolve` (respeta `/etc/hosts`). (c) `Result<URL, Failure>` style — never throws. **Decisión SDD**: no copio el archivo TS — para el paquete `.mjs` standalone hago una versión *simplificada* (subset suficiente para CD-7) en `src/url-validator.mjs` que cubra: parse, protocol https-only (con excepción `localhost`/`127.0.0.1` en `NODE_ENV=development` por AC-8), literal block, RFC1918 + link-local + loopback IPv4, IPv6 `::1`/`fc..`/`fd..`/`fe[89ab]..`. Allowlist por env `MCP_GATEWAY_ALLOWLIST` (CSV). Justificación: copiar 323 líneas con IPv4-mapped + zone-id es overkill para un cliente que sólo apunta a `app.wasiai.io` por default — pero la versión que escribimos NO debe ser regresiva contra el T1-T7 de WKH-62 (Adversary lo audita). |
| `src/mcp/tools/pay-x402.ts` (líneas 1-216, full) | Predecesor server-side (042) — referencia de cómo orquestar el flujo `probe → 402 → sign → retry` con timeout y guard `MCP_MAX_AMOUNT_WEI_DEFAULT`. **No es exemplar 1:1** porque esto vive en server con adapter-pattern; el cliente WKH-64 no tiene adapters, firma directo con viem. | (a) Estructura del flow (líneas 76-215): valida URL → fetch sin firma → si 402, parsea `body.accepts[0]` → guard maxAmountWei → sign → re-fetch con header → return `{status, result, txHash, amountPaid}`. (b) Error handling: `{ok:false, status, body, stage:'probe'\|'settle'}` cuando gateway responde mal (matches AC-4). (c) Timeout via `AbortController` con env `MCP_PAY_TIMEOUT_MS` default 30000. (d) `fetchWithTimeoutMapping` translate `AbortError` a error estructurado. **Adopto el shape `{ok, status, body, stage}` literal** para AC-4. |
| `src/mcp/tools/get-payment-quote.ts` (líneas 1-61, full) | Pattern del quote — GET sin firma, parsear 402, devolver shape minimal. | El work-item AC-2 pide POST (no GET) sin firma porque `compose`/`orchestrate` son POST-only. **Diferencia clave vs predecesor**: en WKH-64 el quote ES un POST con payload (no GET sin body). El predecesor 042 era GET porque atendía endpoints REST genéricos; nosotros sólo soportamos `compose`/`orchestrate`. |
| `src/mcp/tools/discover-agents.ts` (líneas 1-45, full) | Pattern de discovery — pero usa `discoveryService` interno que NO existe en el paquete cliente. | El cliente WKH-64 hace HTTP `GET /api/v1/capabilities?...` directo (AC-1) — más simple. No reusable, sirve sólo como referencia conceptual. |
| `doc/sdd/068-mainnet-support/auto-blindaje.md` | Detectar patrones recurrentes (≥2 HUs) que deban prevenirse en CDs nuevos. | Hallazgos del 2026-04-28: (a) `useOptionalChain` lint en guards `!x \|\| !x.method()`. (b) aliases backward-compat ruidosos. (c) `readonly` field no refleja env-var dinámico — preferir getter. → Aplicable: nuestro `config.mjs` debe leer envs en cada llamada, no cachear en field readonly. |
| `doc/sdd/064-wkh-65-a2a-forward-key/auto-blindaje.md` | Mismo. | (a) cuando se introduce un MIN_LENGTH, auditar TODOS los fixtures de tests que setean esa env. (b) `vitest` no exporta `fail` global — usar `expect.fail`, `vi.fn`, `vi.mock`, `vi.spyOn`. → Aplicable: nuestro test runner para el paquete `.mjs` será **`node --test`** (built-in, zero-dep — ver DT-I), por lo que no aplica vitest, pero la lección "no copiar API de Jest" se mantiene: usar SOLO `node:test` + `node:assert/strict` APIs. |

### Patrones recurrentes detectados (para CDs)

- **CD-AB-1** (auto-blindaje): preferir getter dinámico sobre field readonly cuando el valor depende de env vars. Aplicable a `config.mjs`.
- **CD-AB-2** (auto-blindaje): cuando se agrega un threshold sobre env var, grep TODOS los fixtures que setean la var antes de mergear. Aplicable a tests de `config.mjs`.
- **CD-AB-3** (auto-blindaje): NO mezclar APIs de Jest/vitest/node:test — pin a `node:test` + `node:assert/strict` en este paquete (DT-I).

### Exemplars verificados (con Glob)

| Para crear | Seguir patrón de | Razón |
|------------|------------------|-------|
| `mcp-servers/wasiai-x402/src/sign.mjs` | `scripts/smoke-prod-via-app-wasiai.mjs:47-68` | Golden vector de domain/types/message/envelope. Cualquier deriva rompe verify del facilitator. |
| `mcp-servers/wasiai-x402/src/url-validator.mjs` | `src/lib/url-validator.ts` (núcleo, no IPv4-mapped completo) | SSRF guard contra hosts privados — pattern test-cubierto en T1-T7 de WKH-62. |
| `mcp-servers/wasiai-x402/src/index.mjs` (flow `pay_x402`) | `src/mcp/tools/pay-x402.ts:76-215` (estructura del flow, no adapter-pattern) | Probe → 402 → guard → sign → retry → parse, con shape de error `{ok:false, status, body, stage}`. |
| `mcp-servers/wasiai-x402/.gitignore` | (estándar Node — no hay exemplar local específico, generamos uno minimal) | Excluir `.env*` salvo `.env.example`, `node_modules/`, `dist/`, `*.log`. |

Verificación con Glob/ls: `mcp-servers/wasiai-x402/` existe pero `src/` está vacío (placeholder generado). No hay `package.json`, `README.md`, ni archivos previos — implementación greenfield.

### Estado de BD

N/A. Este paquete es client-side puro, no toca DB.

### Componentes reutilizables encontrados

- `viem/accounts` (`privateKeyToAccount`, `account.signTypedData`) — usado idéntico en smoke script. **Reusar.**
- `node:crypto.randomBytes` — para nonce 32 bytes.
- No hay otros reusables; el paquete es greenfield bajo `mcp-servers/`.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

> Sólo creates. Nada que modificar fuera de `mcp-servers/wasiai-x402/`.

| Archivo | Acción | Descripción | Exemplar | Wave |
|---------|--------|-------------|----------|------|
| `mcp-servers/wasiai-x402/package.json` | Crear | `"type":"module"`, `"main":"src/index.mjs"`, `"bin":{"wasiai-x402":"src/index.mjs"}`, `"scripts":{"start":"node src/index.mjs","test":"node --test tests/"}`, deps: `@modelcontextprotocol/sdk@^1.0.0`, `viem@^2.21.0`, `dotenv@^16.4.0`. NO devDeps externas (test runner = `node --test` builtin). `engines.node >=20.10.0`. | n/a (estándar) | W0 |
| `mcp-servers/wasiai-x402/tsconfig.json` | NO crear | DT-A resuelto = `.mjs`. No hay TS. | — | — |
| `mcp-servers/wasiai-x402/.gitignore` | Crear | `.env`, `.env.local`, `.env.*.local`, `node_modules/`, `dist/`, `*.log`, `coverage/`. NO excluir `.env.example`. | estándar Node | W0 |
| `mcp-servers/wasiai-x402/.env.example` | Crear | TODAS las vars (AC-14): `OPERATOR_PRIVATE_KEY=0xYourOperatorPrivateKey` (placeholder), `WASIAI_GATEWAY_URL=https://app.wasiai.io` (default), `KITE_CHAIN_ID=2368`, `KITE_PYUSD=0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`, `X402_EIP712_DOMAIN_NAME=PYUSD`, `X402_EIP712_DOMAIN_VERSION=1`, `MCP_MAX_AMOUNT_WEI_DEFAULT=` (vacío = sin guard por default), `MCP_GATEWAY_ALLOWLIST=` (vacío = solo bloqueos privados), `MCP_PAY_TIMEOUT_MS=30000`, `NODE_ENV=production`. Cada var con comentario sobre nombre / obligatoria? / default / formato / ejemplo. | `.env.example` raíz líneas 110-135, 230-248 | W0 |
| `mcp-servers/wasiai-x402/src/log.mjs` | Crear | Logger JSON-line: `info(event, fields)`, `warn(event, fields)`, `error(event, fields)`. Auto-redacta `OPERATOR_PRIVATE_KEY` y truncate de `signature` a 10 chars + `…`. Single function `redact(obj)` que recorre keys conocidas y reemplaza por `[REDACTED]`. **Append-only** stderr (stdout queda libre para MCP stdio transport — DT-F). | inline (no exemplar local — patrón estándar) | W1 |
| `mcp-servers/wasiai-x402/src/config.mjs` | Crear | `loadConfig()` que lee env (no cachea — CD-AB-1) y valida fail-fast: PK obligatoria + match `/^0x[0-9a-fA-F]{64}$/` (AC-6); gateway URL → `validateGatewayUrl()` (AC-8); chainId entero positivo; contract address `/^0x[0-9a-fA-F]{40}$/`. Retorna `{operatorAddress, gatewayUrl, chainId, contract, domainName, domainVersion, maxAmountWeiDefault, payTimeoutMs}`. **Nunca expone la PK en el objeto retornado** — sólo `operatorAddress` (derivable via `privateKeyToAccount(pk).address`). La PK queda capturada en clausura interna del módulo `sign.mjs` (vía `getOperatorAccount()` que la lee on-demand en cada call). | `src/lib/url-validator.ts` (validateRegistryUrl pattern, líneas 315-323) | W1 |
| `mcp-servers/wasiai-x402/src/url-validator.mjs` | Crear | `async validateGatewayUrl(rawUrl, {allowDevPrivate=false})`. Pasos: (1) parse → invalid-url. (2) protocol https only; allow `http://localhost`/`http://127.0.0.1` SOLO si `NODE_ENV=development` (AC-8). (3) literal block: `localhost`, `*.local`, `*.localhost`, trailing-dot stripped (RFC 1035). (4) allowlist `MCP_GATEWAY_ALLOWLIST` (CSV) — bypass private-IP. (5) `dns.lookup(host, {all:true})` → reject IPv4 priv (10/8, 127/8, 169.254/16, 172.16-31, 192.168/16, 0/8) + IPv6 priv (`::1`, `::`, `fc..`/`fd..`, `fe[89ab]..`). Throws `SSRFViolationError` con `category` enum-like string. | `src/lib/url-validator.ts:209-323` (núcleo simplificado) | W1 |
| `mcp-servers/wasiai-x402/src/sign.mjs` | Crear | Pure module (sin I/O HTTP). Exports: `getOperatorAddress()` (lee PK on-demand y retorna `account.address`), `signX402Envelope({to, value, validBefore, nonce, chainId, contract, domainName, domainVersion})` retorna `{signature, envelopeBase64, authorization}`. Internal: `privateKeyToAccount(pk).signTypedData({domain, types, primaryType:'TransferWithAuthorization', message})`. Determinístico dado `{value, validBefore, nonce, chainId, contract}` + PK. PK leída desde env en cada call (CD-AB-1). | `scripts/smoke-prod-via-app-wasiai.mjs:47-68` (1:1 envelope match) | W1 |
| `mcp-servers/wasiai-x402/src/index.mjs` | Crear | Bootstrap: `dotenv.config()` (warn-once si `.env` ausente y `NODE_ENV!==production`); `loadConfig()` (fail-fast); inicia MCP `Server` del SDK con stdio transport (DT-F); registra 3 tools (handlers definidos abajo); arranca `server.connect(stdio)`. Cada tool handler es una función async que recibe input, sanitiza (AC-10: ignora `OPERATOR_PRIVATE_KEY`/`signature`/`authorization` si vienen en input + warn-once), hace fetch + log JSON. Errores → respuesta tool-error con shape estructurado (sin stack, sin PK). | `src/mcp/tools/pay-x402.ts:76-215` (estructura del flow), MCP SDK docs | W2 |
| `mcp-servers/wasiai-x402/README.md` | Crear | 3 secciones canónicas (AC-13): (a) Setup local. (b) Deploy a Claude Console managed env (paso a paso, con foto del bundle layout). (c) Security warnings (PK custody, mainnet exposure, rotación, blast radius — incluye link al WKH-44 protocol fee impact). | n/a (escritura nueva basada en AC-13) | W3 |
| `mcp-servers/wasiai-x402/tests/sign.test.mjs` | Crear | 8 tests: golden vector determinístico, value=0n rejection, validBefore in past, nonce length≠32, chainId mismatch, signature shape (`/^0x[0-9a-f]{130}$/i`), envelope JSON parseable + has 3 keys, network string `eip155:<chainId>`. Mocks: PK fija `0x'+ '11'.repeat(32)`, validBefore = `1700000000n`, nonce = `0x' + '22'.repeat(32)`. | `node:test` + `node:assert/strict` | W1 |
| `mcp-servers/wasiai-x402/tests/config.test.mjs` | Crear | 7 tests: PK ausente → throws + msg sin valor; PK 63 chars → throws; PK 65 chars → throws; PK válida → returns config; gateway URL ausente → fallback `https://app.wasiai.io` + warn-once spy; gateway URL `http://10.0.0.1` → throws SSRF (cubre AC-8); gateway URL `http://localhost` con `NODE_ENV=development` → permitido. | `node:test` | W1 |
| `mcp-servers/wasiai-x402/tests/url-validator.test.mjs` | Crear | 9 tests: parse fail, ftp:// rejected, http:// rejected (prod), `localhost` rejected, `localhost.` (trailing dot) rejected, `foo.local` rejected, `169.254.169.254` rejected, `10.0.0.1` rejected, `::1` rejected, `app.wasiai.io` ok, `MCP_GATEWAY_ALLOWLIST=internal.example.com` permite ese host con DNS privado bypassed. | `src/lib/url-validator.test.ts` (estructura, no copia 1:1) | W1 |
| `mcp-servers/wasiai-x402/tests/tools.test.mjs` | Crear | 12 tests: AC-1 discover happy + filter pass-through. AC-2 quote 402 capture + parse. AC-3 pay full flow (mocked fetch double-call: 402 then 200). AC-4 gateway 500 → `{ok:false,stage:'probe',status:500,body}`. AC-4 retry 402 → `{ok:false,stage:'settle'}`. AC-5 sign throw → `{ok:false,stage:'sign'}`. AC-9 PK redaction (spy `console.*` + spy `process.stderr.write` — assert ZERO matches con la PK fija). AC-10 input con `OPERATOR_PRIVATE_KEY` → ignored + warn-once. AC-11 `maxAmountRequired` excede guard → abort pre-sign. AC-16 logs JSON line-per-event con keys `{ts,level,tool,stage,gateway,operator,ok}`. Mock `fetch` global (override `globalThis.fetch`). Mock viem account (PK fija). | `src/mcp/tools/pay-x402.test.ts:1-end` (estructura), `node:test` | W2 |

### 4.2 Modelo de datos

N/A. Este paquete no toca BD ni state.

### 4.3 Componentes / Servicios

```
mcp-servers/wasiai-x402/
├── src/
│   ├── index.mjs           ← bootstrap MCP server + 3 tool handlers
│   ├── config.mjs          ← env loading + fail-fast validation (no cachea)
│   ├── log.mjs             ← JSON-line logger to stderr + auto-redact
│   ├── url-validator.mjs   ← SSRF guard (gateway URL + allowlist)
│   └── sign.mjs            ← pure EIP-3009 signing module (testable)
├── tests/
│   ├── sign.test.mjs       ← golden vector + invariants (8 tests)
│   ├── config.test.mjs     ← env validation (7 tests)
│   ├── url-validator.test.mjs ← SSRF rejection cases (9 tests)
│   └── tools.test.mjs      ← E2E con fetch mocked (12 tests)
├── package.json            ← deps + scripts (test=node --test)
├── .env.example            ← TODAS las env vars documentadas
├── .gitignore              ← .env*, node_modules, dist, logs
└── README.md               ← Setup + Deploy a Claude Console + Security
```

**Diagrama de flujo `pay_x402`** (AC-3):

```
agent → tool(pay_x402, {endpoint:'/api/v1/compose', method:'POST', payload:{...}})
  │
  ▼
[1] sanitize input (AC-10): drop OPERATOR_PRIVATE_KEY/signature/authorization keys
  │
  ▼
[2] validateGatewayUrl(WASIAI_GATEWAY_URL) — SSRF guard (CD-7)
  │
  ▼
[3] fetch(gateway+endpoint, {method, headers:{content-type}, body:JSON.stringify(payload)})
  │
  ├─ status ∉ {200,402} → return {ok:false, stage:'probe', status, body}        (AC-4)
  ├─ status == 200 → return {ok:true, status:200, result, txHash:undefined}     (free endpoint)
  ▼
[4] parse 402 body → accepts[0] {payTo, maxAmountRequired, network, ...}
  │
  ▼
[5] guard: if maxAmountRequired > MCP_MAX_AMOUNT_WEI_DEFAULT (or input.maxAmountWei)
  │   → return {ok:false, stage:'sign', error:'amount exceeds guard'}            (AC-11)
  ▼
[6] sign.mjs: signX402Envelope({to:payTo, value:BigInt(maxAmountRequired), ...})
  │   → throws → return {ok:false, stage:'sign', error:msg-sin-PK}               (AC-5)
  ▼
[7] fetch(gateway+endpoint, {..., headers:{...,'payment-signature':envelopeBase64}})
  │   AbortController timeout = MCP_PAY_TIMEOUT_MS
  ├─ status != 200 → return {ok:false, stage:'settle', status, body}             (AC-4)
  ▼
[8] return {ok:true, status:200, result:body, latencyMs, kiteTxHash:body.kiteTxHash}
```

### 4.4 Flujo principal (Happy Path)

1. Operador setea `OPERATOR_PRIVATE_KEY` + `WASIAI_GATEWAY_URL=https://app.wasiai.io` en el managed env de Claude Console.
2. Agent en Claude Console invoca `discover_agents({query:"AVAX price"})`.
3. MCP server hace `GET https://app.wasiai.io/api/v1/capabilities?query=AVAX+price&limit=20` → devuelve agents array.
4. Agent invoca `get_payment_quote({endpoint:'/api/v1/compose', method:'POST', payload:{steps:[...]}})`.
5. MCP server hace POST sin firma → recibe 402 → parsea `accepts[0]` → devuelve quote.
6. Agent invoca `pay_x402({endpoint:'/api/v1/compose', method:'POST', payload:{...}})`.
7. MCP server: probe → 402 → guard maxAmount → sign EIP-3009 PYUSD/Kite (DT-B/C/D) → retry con `payment-signature` → 200 con `kiteTxHash` + `downstreamTxHash`.
8. Agent retorna respuesta al usuario con tx hashes en explorers.

### 4.5 Flujo de error

| Trigger | Respuesta del tool | AC |
|---------|--------------------|----|
| `OPERATOR_PRIVATE_KEY` ausente | Server NO arranca, exit ≠ 0, msg `"OPERATOR_PRIVATE_KEY is required and must be a 0x-prefixed 32-byte hex"` (sin valor parcial) | AC-6 |
| Gateway URL inválida (private IP, scheme http en prod, `localhost` fuera de dev) | Server NO arranca, exit ≠ 0, msg con categoría SSRF | AC-8 |
| Gateway 5xx en probe | Tool devuelve `{ok:false, status:5xx, body, stage:'probe'}` | AC-4 |
| Gateway 402 sin `accepts[0]` | Tool devuelve `{ok:false, stage:'probe', error:'invalid 402: missing accepts[0]'}` | AC-4 |
| `maxAmountRequired` > guard | Tool devuelve `{ok:false, stage:'sign', error:'amount exceeds maxAmountWei guard', requested, max}` (sin firmar) | AC-11 |
| `signTypedData` throws | Tool devuelve `{ok:false, stage:'sign', error:'signing failed: <descripción sin PK>'}` | AC-5 |
| Retry no-200 | Tool devuelve `{ok:false, stage:'settle', status, body}` (NO inventa tx hashes) | AC-4 |
| Timeout (`MCP_PAY_TIMEOUT_MS`) | Tool devuelve `{ok:false, stage:'probe'\|'settle', error:'gateway timeout after Nms'}` | AC-4 |
| Input incluye `OPERATOR_PRIVATE_KEY` | Server ignora el campo, loggea `warn-once` con key sanitizada (AC-10), continúa con env | AC-10 |

---

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir

- **CD-1** (heredado del work-item): Sin hardcodes — gateway URL, contract, chainId, decimals todos via env con defaults.
- **CD-2** (heredado): PK SOLO via env. PROHIBIDO en logs, error messages, traces, telemetry, response bodies. Test SHALL probar este invariant (AC-9) con spy sobre `console.*` + `process.stderr.write`.
- **CD-3** (heredado): Compatibilidad con `@modelcontextprotocol/sdk` ≥1.0.0. Pin exacto `^1.0.0` en package.json. Si MCP SDK cambió API en 2.x, F2 reabre.
- **CD-4** (heredado): Stateless — cada tool call independiente. Sin in-memory cache de signatures, sin sesión, sin state cross-call.
- **CD-5** (heredado): Match exacto del envelope con `scripts/smoke-prod-via-app-wasiai.mjs:64-68`. Golden vector test PIN OBLIGATORIO en `tests/sign.test.mjs`. Cualquier deriva en orden de keys, encoding, decimal/hex format → BLOQUEANTE en AR.
- **CD-6** (heredado): Logs JSON-line-per-event con `{ts, level, tool, stage, gateway, operator, ok}`. PROHIBIDO `console.log` plano excepto banner de startup. **Logger escribe a stderr** (stdout reservado para MCP stdio transport — DT-F).
- **CD-7** (heredado): SSRF — PROHIBIDO requests a hosts privados (RFC1918, loopback, link-local) salvo `NODE_ENV=development` con `localhost`/`127.0.0.1`. Reusa pattern de `src/lib/url-validator.ts` (subset).
- **CD-8** (heredado): `.gitignore` excluye `.env*` salvo `.env.example` (verificado en AR).
- **CD-9** (heredado): `npm install && npm test` corre en CI sin red. Tests con mocks de `fetch` (override `globalThis.fetch`).
- **CD-10** (heredado): Output del envelope determinístico dado `{value, validAfter, validBefore, nonce, chainId, contract, PK}`. Sólo `nonce` y `validBefore` son no-deterministicos en runtime — los tests los inyectan.

### CDs nuevos (specific de F2)

- **CD-11**: Test runner = `node --test` builtin (DT-I). PROHIBIDO añadir vitest/jest/mocha. Justificación: zero-dep en deploy a Claude Console (no `devDependencies` que un `npm install --production` filtraría, pero el sentido es minimizar surface). Tests usan `node:test` + `node:assert/strict` exclusivamente. Sin `expect.fail`, `vi.fn`, `jest.spyOn`.
- **CD-12** (auto-blindaje WKH-068): `config.mjs` lee envs **on-demand** (no cachea en field readonly) — un cambio del env-var entre tool-calls debe reflejarse. Aplicable también a `MCP_MAX_AMOUNT_WEI_DEFAULT` que puede cambiar en runtime sin reiniciar server.
- **CD-13** (auto-blindaje WKH-064): cuando se introduce un threshold sobre env (ej. PK length 64 chars), grep TODOS los fixtures en `tests/` que setean esa env y verificar que cumplen el threshold antes de mergear. Aplicable a futuras iteraciones del paquete.
- **CD-14**: PK NUNCA expuesta en el objeto retornado por `loadConfig()`. Sólo `operatorAddress` (derivado). El módulo `sign.mjs` lee `process.env.OPERATOR_PRIVATE_KEY` en cada call (rotación-friendly, fail-fast si se borró post-startup).
- **CD-15**: Logger redacta automáticamente keys conocidas: `OPERATOR_PRIVATE_KEY`, `privateKey`, `pk`, `signature` (truncado 10 chars + `…`), `authorization.signature`, `xPaymentHeader`. Test cubre el invariant (AC-9).
- **CD-16**: PROHIBIDO `process.exit()` desde dentro de un tool handler. Sólo desde startup (config validation). Un tool runtime crash NO debe matar el server (Claude Console reiniciará con state-loss).

### PROHIBIDO

- NO modificar `src/` del repo principal (Scope OUT).
- NO publicar a npm (Scope OUT).
- NO ejecutar tests E2E con dinero real (Scope OUT — gate humano).
- NO añadir tools beyond `discover_agents`/`get_payment_quote`/`pay_x402` (DT-J resuelto = no `health`/`version`/`poll_task`).
- NO hardcodear `0x8E04D...` en código — viene de env `KITE_PYUSD` con default sensato.
- NO usar HTTP transport para MCP (DT-F = stdio only).
- NO inventar paths/APIs/librerías que no haya verificado.

---

## 6. Scope

**IN** (todo bajo `mcp-servers/wasiai-x402/`):

- `package.json`, `.env.example`, `.gitignore`, `README.md`.
- `src/index.mjs`, `src/config.mjs`, `src/log.mjs`, `src/url-validator.mjs`, `src/sign.mjs`.
- `tests/sign.test.mjs`, `tests/config.test.mjs`, `tests/url-validator.test.mjs`, `tests/tools.test.mjs`.

**OUT**:

- NO `src/` del repo principal.
- NO `tsconfig.json` (DT-A = `.mjs`).
- NO `app.wasiai.io` ni `wasiai-v2`.
- NO npm publish, NO Railway deploy, NO CI principal.
- NO multi-chain dinámico (DT-H Kite testnet locked).
- NO authn extra (x-a2a-key, x-wasiai-forward-key) — el flow es pure x402.
- NO `compose`/`orchestrate` tools (los endpoints son targets, NO tools).
- NO `health`/`version` tools (DT-J = no).
- NO `poll_task` (HU posterior si async flow lo requiere — ver DT-K).

---

## 7. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|-------------|---------|------------|
| PK leakage en logs / error messages | B | A (drain operator wallet) | CD-2 + CD-15 + AC-9 + tests con spy `console.*` y `process.stderr.write` con assert ZERO matches. AR audita cada log path. |
| Envelope drift vs facilitator | M | A (4xx en mainnet, demo fail) | CD-5 + golden vector test contra PK/nonce/validBefore fijos. AR computa envelope manual y compara byte a byte. |
| SSRF (agent malicioso pasa endpoint privado) | M | M (acceso a metadata/internal services) | CD-7 + AC-8 + url-validator.mjs (subset de WKH-62). Tests cubren `169.254.169.254`, `10.0.0.1`, `::1`, `localhost.`. |
| Replay attack (nonce predecible) | B | M (tx duplicada, billing doble) | `nonce = randomBytes(32)` por call. Test: 100 sign calls → todos los nonces únicos. |
| Prompt injection vía input (override env) | M | A | AC-10 + CD-14: loadConfig nunca expone PK. Input fields `OPERATOR_PRIVATE_KEY`/`signature`/`authorization` se ignoran + warn-once. |
| Cap bypass (`maxAmountRequired` enorme) | B | A (mainnet drain) | AC-11 + CD-11 guard `MCP_MAX_AMOUNT_WEI_DEFAULT` en `pay_x402` ANTES de firmar. |
| Race conditions / concurrent tool calls | B | M (sign concurrente con state cruzado) | CD-4 stateless. Cada tool call construye su propio nonce + validBefore + AbortController. Test con `Promise.all` de 10 calls concurrentes verifica que cada one tiene nonce distinto y no se pisan logs. |
| MCP SDK breaking change ≥1.0.0 → 2.x | B | M (tool registration falla) | CD-3 pin `^1.0.0`. Architect verifica versión real instalada en F3 W0. |
| `dotenv` leak `.env` real al repo | B | A | CD-8 + AC-15 + test de presencia de `.env*` en `.gitignore` (parsea el archivo y assert). |
| Lockfile drift en deploy a Claude Console | M | M (managed env instala otra versión de viem) | Architect valora `package-lock.json` commiteado en F3 (no bloqueante en F2 — decision diferida). |

---

## 8. Dependencias

- `viem ^2.21.0` (privateKeyToAccount, signTypedData) — usado en server-side, versión vigente.
- `@modelcontextprotocol/sdk ^1.0.0` — pin estricto, F3 W0 verifica el paquete real disponible en npm.
- `dotenv ^16.4.0` — sólo para dev local. En Claude Console managed env las vars vienen del env, `.env` no existe — `dotenv.config()` es no-op silente.
- `node >=20.10.0` (engines) — `fetch` global + `node:test` + `node:assert/strict` + `randomBytes` + WeakRef.

Todas verificadas como existentes en el ecosistema npm vigente al 2026-04-29.

---

## 9. Missing Inputs

- [x] DT-A resuelto en sección 11 = `.mjs`.
- [x] DT-G resuelto en sección 11 = env-only.
- [x] DT-J resuelto en sección 11 = NO `health`/`version` tools.
- [x] DT-K (`poll_task`) resuelto en sección 11 = NO en esta HU; abrir HU posterior si E2E descubre necesidad.
- [x] Gateway URL: default `https://app.wasiai.io` confirmado AC-7.
- [x] Token/chain: PYUSD/Kite testnet 2368 confirmado DT-B/C.
- [x] Smart Sizing: QUALITY confirmado en work-item.

**Sin pendientes [NEEDS CLARIFICATION] bloqueantes.**

---

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| [TBD-1] | §8 | ¿`package-lock.json` commiteado o no? Decisión diferida a F3 W0 (no bloquea SDD). | No |
| [TBD-2] | §13 W3 | ¿Foto/diagrama del bundle layout en README sección "Deploy a Claude Console"? Si Claude Console no acepta imágenes en MCP descriptors, se reemplaza por ASCII. | No |

**Sin [NEEDS CLARIFICATION].**

---

## 11. Decisiones técnicas (DT-N) — definitivas F2

| DT | Status | Decisión | Justificación |
|----|--------|----------|---------------|
| **DT-A** | RESUELTO F2 | `.mjs` (ESM puro, zero compile) | (1) Deploy a Claude Console = `node src/index.mjs` directo, sin pipeline `tsc`. (2) MCP SDK ≥1.0 ya soporta ESM nativo. (3) `node:test` + `node:assert/strict` builtin (CD-11). (4) Trade-off type safety: aceptamos pérdida — 5 archivos pequeños, golden vector test cubre el shape crítico, JSDoc puede agregarse en F3. (5) viem es ESM-first, sin compat layer requerido. **Justificación adicional**: el predecesor server-side (042) está en TS porque vive en `src/` con `tsc`; aquí el contexto es opuesto (paquete standalone, deploy managed). |
| **DT-B** | VERIFICADO 2026-04-29 | Domain `{name:'PYUSD',version:'1',chainId:2368,verifyingContract:'0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9'}` | Match exacto con `scripts/smoke-prod-via-app-wasiai.mjs:51-56` y `.env.example:114,117,120`. |
| **DT-C** | VERIFICADO 2026-04-29 | Decimals=18, value en wei como BigInt, serializado `.toString()` | `.env.example:106` `KITE_PAYMENT_AMOUNT=1000000000000000000` (10^18 wei = 1 PYUSD). Smoke `:62,66`. |
| **DT-D** | VERIFICADO 2026-04-29 | Envelope = `base64(JSON.stringify({signature, authorization:{from,to,value,validAfter,validBefore,nonce}, network:'eip155:<chainId>'}))` con value/validAfter/validBefore como string y nonce hex 0x bytes32 | Smoke `:64-68`. CD-5. |
| **DT-E** | RESUELTO F2 | `validBefore = now()+300s`, `validAfter=0`, `nonce=randomBytes(32)` hex 0x | Match con smoke `:48-49`. 5 min es ventana razonable: lo suficientemente corta para limitar replay window pero amplia para tolerar latencia mainnet (avg 2s + facilitator overhead). |
| **DT-F** | RESUELTO F2 | MCP transport = stdio (canonical para managed envs) | Claude Console managed envs ejecutan el binario y leen/escriben stdio. HTTP transport requeriría puerto + tunneling (descartado). |
| **DT-G** | RESUELTO F2 | **env-only** — NO override de PK por-call | (1) CD-2 estricto. (2) Claude Console agent injection vector → si por-call fuera permitido, un prompt malicioso podría hacer que el agent firme con OTRA PK (puede ser una trampa). (3) Operacionalmente sólo hay UNA PK del operator wallet en este HU. (4) Si en HU posterior aparece multi-tenant con PKs distintas, se diseña key-id pattern (hash → PK lookup) sin exponer PK en input. |
| **DT-H** | RESUELTO F2 | Network locked = Kite testnet 2368 + PYUSD | El cliente sólo firma INBOUND (Kite). El outbound mainnet (Avalanche C-Chain) es responsabilidad del server post-pago. Mantener cliente single-chain reduce surface y permite que el server siga decidiendo downstream chain via `WASIAI_DOWNSTREAM_NETWORK`. |
| **DT-I** | NUEVO F2 | Test runner = `node --test` builtin + `node:assert/strict` | Zero external test deps. Compatible Node ≥20.10. Sin Jest/vitest API drift (CD-AB-3). |
| **DT-J** | RESUELTO F2 | NO `health`/`version` tools en esta HU | Brief no lo pide (Scope OUT). MCP SDK ya expone `server.list_tools` que cubre intent de "version/capabilities". |
| **DT-K** | RESUELTO F2 (defer) | NO `poll_task` tool | Brief excluye tasks polling. Si en F4/E2E descubrimos que `compose`/`orchestrate` returns 202+taskId en vez de 200+result (flow async), se abre HU posterior. Hoy `compose` retorna 200 sync (smoke confirma). |
| **DT-L** | NUEVO F2 | Logger writes a stderr, stdout reservado para MCP stdio | MCP SDK usa stdout para JSON-RPC frames. Cualquier log a stdout corrompe el transport. Standard Node logging convention. |
| **DT-M** | NUEVO F2 | URL validator standalone (NO copia 1:1 de `src/lib/url-validator.ts`) | El paquete debe ser auto-contenido. Versión simplificada (sin IPv4-mapped completo, sin zone-id stripping) cubre los casos críticos de WKH-62 (literal block + RFC1918 + link-local + loopback IPv4/IPv6). AR audita que no haya regressión observable contra T1-T7 de WKH-62. |
| **DT-N** | NUEVO F2 | dotenv.config() en startup, warn-once si `.env` no existe y `NODE_ENV !== production` | En Claude Console managed `.env` no existe → `dotenv` es no-op silente, vars vienen del env directamente. En dev local, falla suave si falta. |

---

## 12. Plan de Tests — mínimo 1 test por AC

| AC | Test file | Test name | Mock strategy |
|----|-----------|-----------|---------------|
| AC-1 | `tools.test.mjs` | `discover_agents builds GET capabilities with query/maxPrice/capabilities` | Mock `globalThis.fetch` → returns `{agents:[...]}`. Assert URL contiene `?query=X&maxPrice=Y&capabilities=Z`. |
| AC-1 | `tools.test.mjs` | `discover_agents returns body unchanged` | Pass-through assert. |
| AC-2 | `tools.test.mjs` | `get_payment_quote captures 402 and parses accepts[0]` | Mock fetch → 402 with body `{accepts:[{payTo,maxAmountRequired,...}]}`. Assert returned shape contiene los campos. |
| AC-2 | `tools.test.mjs` | `get_payment_quote does NOT include payment-signature header` | Spy on fetch → assert no `payment-signature` in headers. |
| AC-3 | `tools.test.mjs` | `pay_x402 full flow: probe → 402 → sign → retry → 200` | Mock fetch double-call. Assert second call has `payment-signature` header == output of `signX402Envelope`. |
| AC-3 | `sign.test.mjs` | `signX402Envelope GOLDEN VECTOR — PK/nonce/validBefore fixed → deterministic base64` | Compute manual con valores conocidos, comparar exact byte match contra el output. |
| AC-4 | `tools.test.mjs` | `pay_x402: probe returns 500 → {ok:false, stage:'probe'}` | Mock fetch → 500. |
| AC-4 | `tools.test.mjs` | `pay_x402: retry returns 400 → {ok:false, stage:'settle'}` | Mock double-call: 402 then 400. |
| AC-4 | `tools.test.mjs` | `pay_x402: NO mock tx hash on failure` | Assert `result.txHash === undefined` cuando `ok:false`. |
| AC-5 | `tools.test.mjs` | `pay_x402: sign throw → {ok:false, stage:'sign', error sin PK}` | Mock viem account.signTypedData to throw. Assert error message NO contiene la PK. |
| AC-6 | `config.test.mjs` | `loadConfig throws when OPERATOR_PRIVATE_KEY undefined` | `delete process.env.OPERATOR_PRIVATE_KEY`. Assert throw + message exacto + NO valor parcial. |
| AC-6 | `config.test.mjs` | `loadConfig throws when PK is 63 chars (invalid hex)` | `process.env.OPERATOR_PRIVATE_KEY='0x'+'a'.repeat(63)`. |
| AC-6 | `config.test.mjs` | `loadConfig throws when PK is 65 chars` | Assert throw. |
| AC-7 | `config.test.mjs` | `loadConfig fallback to https://app.wasiai.io when WASIAI_GATEWAY_URL unset + warn-once` | Spy on `process.stderr.write` → assert exactly 1 call con mensaje warn. |
| AC-8 | `url-validator.test.mjs` | `rejects http:// in production` | Assert SSRFViolationError. |
| AC-8 | `url-validator.test.mjs` | `rejects 10.0.0.1 / 169.254.169.254 / 192.168.1.1` | DNS-resolved private IP. |
| AC-8 | `url-validator.test.mjs` | `rejects ::1 / fc00::/7 / fe80::/10` | IPv6. |
| AC-8 | `url-validator.test.mjs` | `allows localhost when NODE_ENV=development` | Edge case dev mode. |
| AC-9 | `tools.test.mjs` | `PK NEVER appears in logs across all error paths` | Spy `console.log/info/warn/error/debug` + `process.stderr.write`. Run 10 paths (probe ok, probe 500, sign throw, settle 400, etc.). Assert ZERO matches con la PK fija de test. |
| AC-10 | `tools.test.mjs` | `pay_x402 ignores OPERATOR_PRIVATE_KEY in input + warn-once` | Pass `{...payload, OPERATOR_PRIVATE_KEY:'0x' + '00'.repeat(32)}`. Assert flow uses env PK, not input. Spy stderr → exactly 1 warn-once. |
| AC-10 | `tools.test.mjs` | `pay_x402 ignores signature/authorization in input` | Idem. |
| AC-11 | `tools.test.mjs` | `pay_x402 aborts pre-sign when maxAmountRequired exceeds guard` | Set `MCP_MAX_AMOUNT_WEI_DEFAULT=1000`. Mock 402 with `maxAmountRequired:'9999'`. Assert `{ok:false, stage:'sign', error:'amount exceeds...'}`, no fetch retry, no signTypedData call. |
| AC-12 | (cubierto por sign.test + url-validator.test + config.test) | meta-AC: existencia de tests | n/a |
| AC-13 | (cubierto en F3 + verificado en F4) | README contiene 3 secciones canónicas | grep textual en F4. |
| AC-14 | (cubierto en F4) | `.env.example` documenta TODAS las vars | grep + count en F4. |
| AC-15 | (cubierto en F4) | `.gitignore` excluye `.env*` excepto `.env.example` | parsea archivo, assert reglas. |
| AC-16 | `tools.test.mjs` | `logs are JSON-line-per-event with canonical keys` | Capture stderr, split por `\n`, JSON.parse cada línea, assert `{ts, level, tool, stage, gateway, operator, ok}` presents. **Auto-blindaje WKH-068**: assert `operator` es la address (0x40chars), NO la PK. |

**Total tests planeados**: 8 (sign) + 7 (config) + 9 (url-validator) + 12 (tools) = **36 tests**, 16+ ACs cubiertos.

**Tests adicionales (defense-in-depth)**:
- `sign.test.mjs`: nonce uniqueness over 100 calls (replay defense).
- `tools.test.mjs`: 10 concurrent `pay_x402` calls (Promise.all) — assert isolated state, distinct nonces, no log corruption.
- `config.test.mjs`: PK con whitespace `' 0x...'` → throws (no auto-trim).

---

## 13. Waves de Implementación

### Wave 0 — Serial Gate (scaffold + config infraestructura)

> Sin esta wave nada más compila/instala. Serial obligatorio.

| Tarea | Archivo | Verificación al completar |
|-------|---------|--------------------------|
| W0.1 | `package.json` | `npm install` corre limpio en sandbox; `node --version >= 20.10` se satisface; deps resuelven a versiones del registry. |
| W0.2 | `.gitignore` | `git check-ignore .env` retorna 0 (excluido); `.env.example` NO excluido. |
| W0.3 | `.env.example` | Todas las env vars documentadas (count manual: ≥10 vars). |
| W0.4 | (verificación) | Confirmar versión exacta de `@modelcontextprotocol/sdk` instalada y que su API actual exporte `Server` + `StdioServerTransport`. Si la API cambió (≥2.x), reabrir SDD. **Resolver TBD-1 (lockfile commit Y/N)** aquí. |

### Wave 1 — Paralelizable (módulos puros, testables sin red)

| Tarea | Archivo | Depende de | Verificación |
|-------|---------|------------|--------------|
| W1.1 | `src/log.mjs` | W0 | Lint + 0 imports externos (excepto node:*). |
| W1.2 | `src/url-validator.mjs` + `tests/url-validator.test.mjs` | W0 | `node --test tests/url-validator.test.mjs` pasa 9/9. |
| W1.3 | `src/config.mjs` + `tests/config.test.mjs` | W0, W1.1 (logger), W1.2 (validator) | `node --test tests/config.test.mjs` pasa 7/7. |
| W1.4 | `src/sign.mjs` + `tests/sign.test.mjs` | W0 | `node --test tests/sign.test.mjs` pasa 8/8 incluyendo golden vector match exacto. |

> Verificación incremental al cierre de W1: `npm test` pasa 24/24 (sin tools.test todavía).

### Wave 2 — Integración (depende de W1)

| Tarea | Archivo | Depende de | Verificación |
|-------|---------|------------|--------------|
| W2.1 | `src/index.mjs` (bootstrap + 3 tool handlers) | W1.1, W1.2, W1.3, W1.4 | `node src/index.mjs --self-check` (mode dev) registra 3 tools en MCP server sin crashear. |
| W2.2 | `tests/tools.test.mjs` | W2.1 | `node --test tests/tools.test.mjs` pasa 12/12. |

> Verificación incremental al cierre de W2: `npm test` total = 36/36.

### Wave 3 — Final (docs + smoke local)

| Tarea | Archivo | Depende de | Verificación |
|-------|---------|------------|--------------|
| W3.1 | `README.md` con 3 secciones canónicas | W2 | grep textual: "## Setup local", "## Deploy a Claude Console", "## Security warnings". |
| W3.2 | Smoke local manual (no mainnet) | W2 | `node src/index.mjs` arranca, MCP introspection muestra 3 tools, `discover_agents` mockeado funciona contra `app.wasiai.io` (capabilities es endpoint público — sí toca red, pero no firma ni gasta). **Gate humano** post-merge para correr `pay_x402` real con $5 USDC. |

> Verificación incremental al cierre de W3: AR ejecuta vectores adversariales (sección 15), QA verifica todos los ACs con grep+test, Docs cierra con `done-report.md` + `_INDEX.md` update.

---

## 14. Dependencies entre tareas

```
W0.1 (package.json)
  └─→ W0.2 (.gitignore)
  └─→ W0.3 (.env.example)
  └─→ W0.4 (verify SDK version) — gate antes de W1

W1.1 (log.mjs) ──┐
W1.2 (url-validator.mjs) ──┤
                           ├─→ W1.3 (config.mjs) ──┐
W1.4 (sign.mjs) ───────────┘                       │
                                                   ├─→ W2.1 (index.mjs)
                                                   │     │
                                                   │     └─→ W2.2 (tools.test.mjs)
                                                   │
                                                   └─→ W3.1 (README.md)
                                                         └─→ W3.2 (smoke local)
```

W1.1, W1.2, W1.4 son **paralelizables** entre sí. W1.3 depende de W1.1 y W1.2.

---

## 15. Adversary Directives (para Wave 5 / AR — sección obligatoria)

> Vectores específicos a probar por el agente Adversary. Si CUALQUIERA falla → BLOQUEANTE.

### V1 — PK leakage en logs (audit comprehensive)

- **V1.1**: probe a `pay_x402` con PK fija `0xDEAD...DEAD` (32 bytes, distinguible). Run los 10 paths de error (probe ok, probe 500, probe network err, sign throw, settle 400, settle 500, timeout, guard exceeded, invalid 402, missing accepts). Capture todo lo que va a `process.stderr.write` + `process.stdout.write` + `console.*` (5 methods). Assert ZERO matches a la substring `DEAD...DEAD`. NEGATIVE: si appears even once → BLOQUEANTE.
- **V1.2**: invocar tool con `payload.OPERATOR_PRIVATE_KEY = '0xCAFE...CAFE'` y assert que NI el env-PK NI el input-PK aparecen en logs.
- **V1.3**: `Error.stack` desde `signTypedData` mock-throw — assert stack truncated ANTES del frame con la PK.

### V2 — Envelope drift vs facilitator (golden vector reproduction)

- **V2.1**: tomar el smoke script vigente (`scripts/smoke-prod-via-app-wasiai.mjs`), reemplazar la PK por una de test, fijar `Date.now()` y `randomBytes` (mock determinístico), correr el smoke contra un mock facilitator que captura el header `payment-signature`. Correr `pay_x402` con los mismos inputs + mismo mock de tiempo/random. Comparar el envelope base64 byte-a-byte. Si difiere en 1 byte → BLOQUEANTE (CD-5).
- **V2.2**: mutar 1 campo del envelope (ej. `network: 'eip155:2369'` en vez de `2368`) y verificar que el test golden detecta la mutación.

### V3 — SSRF (8 vectores RFC1918 + 4 IPv6)

- **V3.1**: `WASIAI_GATEWAY_URL=http://169.254.169.254/latest/meta-data` (AWS) → server NO arranca, exit ≠ 0.
- **V3.2**: `http://10.0.0.1`, `http://172.16.0.1`, `http://192.168.1.1`, `http://127.0.0.1` (sin dev mode) → reject.
- **V3.3**: `http://0.0.0.0` (IPv4 unspecified) → reject.
- **V3.4**: `https://localhost.` (trailing dot) → reject (RFC 1035).
- **V3.5**: `https://foo.local` → reject.
- **V3.6**: `https://[::1]` → reject.
- **V3.7**: `https://[fc00::1]` → reject.
- **V3.8**: `https://[fe80::1]` → reject.
- **V3.9**: `https://internal.example.com` con `MCP_GATEWAY_ALLOWLIST=internal.example.com` y DNS resolviendo a `10.0.0.5` → ALLOW (allowlist bypass).
- **V3.10**: DNS rebinding — host externo que resuelve A `127.0.0.1` → reject (`dns.lookup` resuelve antes del fetch).

### V4 — Replay attack

- **V4.1**: 100 sign calls back-to-back. Assert los 100 nonces son distintos (Set size = 100).
- **V4.2**: `validBefore` en past (now - 1) → AR no es server-side, pero el cliente debe rechazar pre-emptively. (Nota: spec actual no exige esto. Si AR considera que sí debería, abrir como menor — no bloqueante.)

### V5 — Prompt injection (input override)

- **V5.1**: payload `{...legit, OPERATOR_PRIVATE_KEY:'0xAAA...'}` → ignored, env-PK usado, warn-once emitido. Assert que NO se firmó con la PK del input.
- **V5.2**: payload `{...legit, signature:'0xFAKE'}` → ignored.
- **V5.3**: payload `{...legit, authorization:{from:'0xATTACKER', to:'0xATTACKER', value:'1'}}` → ignored.
- **V5.4**: payload con anidado `{deeply:{nested:{OPERATOR_PRIVATE_KEY:'0xBBB'}}}` → assert NO se confunde el sanitizer (sólo top-level keys son inspeccionadas — explícitar este alcance en docs).

### V6 — Cap bypass

- **V6.1**: `MCP_MAX_AMOUNT_WEI_DEFAULT=1000` (1000 wei = effectively 0 PYUSD), gateway pide `maxAmountRequired:'1000000000000000000'` (1 PYUSD). Assert: NO se firmó (signTypedData no se llamó), NO se hizo retry HTTP (mock fetch debe NO recibir segundo call), respuesta `{ok:false, stage:'sign', error:'amount exceeds maxAmountWei guard'}`.
- **V6.2**: input.maxAmountWei (per-call) overrides env default. Si por-call dice `'5000000000000000000'` y env dice `'1000'`, gateway pide `'2000000000000000000'` → si per-call gana → ok. Si env gana → blocked. **Definir cuál**: priority = per-call > env > undefined (matches predecesor 042 `pay-x402.ts:69-74`). Test cubre las 4 combinaciones.

### V7 — Race conditions / concurrent tool calls

- **V7.1**: 10 calls `pay_x402` concurrentes (Promise.all). Assert: cada call tiene su propio nonce, AbortController, validBefore. No corruption en logs (cada línea JSON parseable). No state cruzado.
- **V7.2**: 5 calls concurrentes con uno que hace timeout (controlado via mock que retrasa 60s + `MCP_PAY_TIMEOUT_MS=100`). El timeout-call falla con `stage:'probe',error:'gateway timeout'`. Los otros 4 completan ok.

### V8 — Output integrity

- **V8.1**: `pay_x402` returns NEVER includes `signature` in plaintext (debe ser truncado en logs y NO incluido en response). Response shape = `{ok, status, result, txHash?, amountPaid?, latencyMs}` — auditar que no leak de signature por accidente.
- **V8.2**: `discover_agents` returns body unchanged (no transformación, no inyección).

### V9 — Dependencia / supply chain

- **V9.1**: Audit `package.json` — `viem`, `@modelcontextprotocol/sdk`, `dotenv` son los únicos. Sin scripts `postinstall`/`preinstall` que ejecuten código (audit). Sin `prepare`/`prepack`. (Defense-in-depth, no bloqueante en F2 — informativo.)

---

## 16. Readiness Check

> Ejecutado por Architect ANTES de marcar SDD listo para SPEC_APPROVED.

```
READINESS CHECK (F2):
[x] Cada AC (1-16) tiene al menos 1 test plan en sección 12
[x] Cada archivo en tabla 4.1 tiene un Exemplar verificado con Glob/Read
[x] No hay [NEEDS CLARIFICATION] sin resolver
[x] Constraint Directives incluyen ≥3 PROHIBIDO (16 CDs total: 10 heredados + 6 nuevos)
[x] Context Map tiene ≥2 archivos leídos del codebase (8 leídos)
[x] Scope IN y OUT son explícitos y no ambiguos
[x] BD: N/A (paquete client-side, no toca DB)
[x] Flujo principal (Happy Path) completo en §4.4
[x] Flujo de error definido en §4.5 (9 casos cubiertos)
[x] Auto-blindaje histórico revisado (068, 064, 062 — 3 últimos DONE — patrones aplicados como CD-12, CD-13, CD-AB-3)
[x] Adversary Directives documentadas en §15 (9 categorías, 30+ vectores)
[x] Waves con orden lógico (W0 serial → W1 paralelizable → W2 integración → W3 final)
[x] DTs resueltos: A=mjs, B/C/D=verified, E=300s, F=stdio, G=env-only, H=Kite testnet, I=node:test, J=no health/version, K=no poll_task (defer), L=stderr, M=standalone validator, N=dotenv warn-once
[x] Tests planeados: 36 (8+7+9+12) — supera el mínimo de 16 (1 por AC)
```

**Resultado**: SDD listo para review SPEC_APPROVED. Sin TBDs bloqueantes (TBD-1, TBD-2 son no-bloqueantes — diferidos a F3).

---

## 17. Notas para fases siguientes

- **F2.5 (Story File)**: heredar §13 (Waves) + §15 (Adversary Directives) + §12 (Test Plan). El Story File es contrato ejecutable para el Dev — debe ser self-contained.
- **F3 (Dev)**: empezar por W0.1 y NO saltar W0.4 (verificar SDK version). Dev firma Anti-Hallucination Checklist por wave.
- **AR (Adversary)**: ejecutar todos los vectores §15. Bloqueante = V1, V2, V3, V5, V6.
- **CR (Code Review)**: especial atención a `sign.mjs` (golden vector match), `log.mjs` (redaction), `index.mjs` (sanitizer top-level only — V5.4).
- **F4 (QA)**: validar AC-13 (README 3 secciones), AC-14 (env vars documentadas), AC-15 (.gitignore correcto) con grep. Validar AC-1 a AC-12 con tests passing. AC-16 con captura de stderr en smoke.
- **DONE (Docs)**: actualizar `_INDEX.md` con done-report. NO push a npm (Scope OUT).

---

*SDD generado por NexusAgil Architect F2 — 2026-04-29*
