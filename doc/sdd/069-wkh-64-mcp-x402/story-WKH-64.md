# Story File — WKH-64 [MCP-X402] wasiai-x402 MCP server for Claude Console managed agents

| Campo | Valor |
|-------|-------|
| **HU** | WKH-64 |
| **#** | 069 |
| **Branch** | `feat/069-wkh-64-mcp-x402` (desde `main@43091fd`) |
| **Status** | `READY_FOR_F3` |
| **SDD_MODE** | full (QUALITY) |
| **Predecesor SDD** | `doc/sdd/069-wkh-64-mcp-x402/sdd.md` (532 líneas, SPEC_APPROVED) |
| **Predecesor histórico (NO copiar)** | `doc/sdd/042-mcp-server-x402/` — DONE 2026-04-13, predates mainnet hybrid + envelope v2 + decimals 18 |
| **Test runner** | `node --test` builtin + `node:assert/strict` |
| **Lenguaje** | `.mjs` (ESM puro, zero compile step) |
| **Total tests** | 36 (8 sign + 7 config + 9 url-validator + 12 tools) |

---

## 0. Contexto mínimo (no leer SDD/work-item para implementar)

Construyes un **paquete MCP server standalone** bajo `mcp-servers/wasiai-x402/` que expone 3 tools (`discover_agents`, `get_payment_quote`, `pay_x402`) consumibles por un agent administrado en Claude Console (Sonnet 4.6). El agent invoca los tools vía MCP stdio, el server hace HTTP contra `app.wasiai.io`, firma EIP-3009 `TransferWithAuthorization` para PYUSD en Kite testnet (chainId 2368) cuando recibe un 402, y devuelve la respuesta del gateway con tx hashes reales.

**Qué NO es**: NO es un cliente CLI; NO se publica a npm en esta HU; NO se ejecutan pagos reales con dinero durante F3 (gate humano post-merge); NO modifica `src/` del repo principal; NO se agrega al deploy de Railway ni al CI principal. Es un paquete **independiente** que vive bajo `mcp-servers/`.

**Por qué importa**: el hackathon de Kite depende de demostrar que un agent gestionado por Anthropic en Claude Console puede ejecutar agentic commerce real (Kite testnet PYUSD inbound + Avalanche C-Chain mainnet USDC outbound) **sin código local**. Bug en domain/types/decimals → firma inválida → 4xx → demo fail. PK leak en logs → drain del operator wallet (~$5 USDC mainnet + control del protocol fee).

---

## 1. Forbidden actions (LEER ANTES DE TIPEAR UNA LÍNEA)

| Prohibición | Justificación |
|-------------|---------------|
| **NO modificar archivos fuera de `mcp-servers/wasiai-x402/`** | Scope IN estricto. Cualquier file outside → STOP + escalar. |
| **NO publicar a npm** | Scope OUT (`npm publish` no se ejecuta). |
| **NO ejecutar pagos reales con dinero** | Tests con mocks; smoke local sin firma. Mainnet exposure recae en gate humano post-merge. |
| **NO commitear `.env`** | `.gitignore` lo excluye. Sólo `.env.example` con placeholders. |
| **NO usar `vitest`, `jest`, `mocha`** | CD-11. Test runner = `node --test` builtin + `node:assert/strict`. |
| **NO escribir TS** | DT-A resuelto = `.mjs`. Cero `tsc`, cero `tsconfig.json`. |
| **NO importar de `src/` del repo principal** | El paquete debe ser self-contained (deploy a Claude Console). |
| **NO loggear PK en NINGÚN momento** | CD-2 + CD-15 + AC-9. Logger redacta automáticamente. |
| **NO inventar mocks que escondan errores reales** | Mocks deben ser fieles al contrato HTTP/EIP-3009. |
| **NO mergear con tests rojos** | Done = 36/36 verde. |
| **NO `process.exit()` desde dentro de un tool handler** | CD-16. Sólo desde startup (config validation). |
| **NO logger a stdout** | DT-L. stdout reservado para MCP stdio JSON-RPC frames. Logger a **stderr**. |
| **NO añadir tools beyond `discover_agents`/`get_payment_quote`/`pay_x402`** | DT-J. NO `health`/`version`/`poll_task` en esta HU. |
| **NO hardcodear `0x8E04D...` en código** | Viene de env `KITE_PYUSD` con default sensato. |
| **NO usar HTTP transport para MCP** | DT-F = stdio only. |
| **NO inventar paths/APIs/librerías sin verificar** | Si una API del MCP SDK no aparece en su README, STOP + escalar. |

Si te encuentras a punto de violar cualquiera de estas → **STOP, abrí [BLOCKER] y escalá al orquestador**.

---

## 2. Anti-Hallucination Checklist (correr ANTES de cada wave)

Antes de empezar **cada** wave, responder explícitamente en el commit-log mental:

```
□ ¿Estoy modificando archivos en Scope IN (sólo bajo mcp-servers/wasiai-x402/)?
□ ¿La firma EIP-712 que voy a escribir match EXACTO el smoke script
   scripts/smoke-prod-via-app-wasiai.mjs:47-68?
   - domain.name='PYUSD' ✓
   - domain.version='1' ✓
   - domain.chainId=2368 ✓
   - domain.verifyingContract=KITE_PYUSD address ✓
   - types.TransferWithAuthorization en orden: from,to,value,validAfter,validBefore,nonce ✓
   - message.validAfter=0n (BigInt) ✓
   - message.nonce='0x'+randomBytes(32).toString('hex') ✓
   - envelope = base64(JSON({signature, authorization:{... value/validAfter/validBefore como string,
     nonce hex 0x...}, network:'eip155:<chainId>'})) ✓
□ ¿La PK aparece en algún lugar que no sea env? Si SÍ → STOP.
□ ¿Logs van a stderr (DT-L)? Si veo `console.log(...)` → STOP, debe ser logger a stderr.
□ ¿Tests usan `node:test` + `node:assert/strict` (DT-I)? Si veo `vitest`, `jest`,
   `vi.fn`, `expect.fail` → STOP, está prohibido (CD-11).
□ ¿Estoy creando un archivo nuevo? Si SÍ → ¿está listado en Scope IN (§3)?
   Si NO → STOP, abrir [BLOCKER].
□ ¿Pasé los tests de la wave anterior antes de empezar la siguiente?
   Si NO → STOP. W1 no arranca hasta W0 verificada. W2 no arranca hasta W1=24/24.
□ ¿El path/API/función que estoy usando del MCP SDK existe en la versión instalada?
   (Verificación W0.4 con `node -e ...`).
```

---

## 3. Scope IN — lista exhaustiva de archivos a tocar

> Si vas a crear un archivo no listado acá → STOP, [BLOCKER], escalar.

```
mcp-servers/wasiai-x402/
├── package.json                    ← W0
├── .gitignore                      ← W0
├── .env.example                    ← W0
├── README.md                       ← W3
├── src/
│   ├── index.mjs                   ← W2 (bootstrap MCP server + 3 tool handlers)
│   ├── config.mjs                  ← W1 (env loading + fail-fast)
│   ├── log.mjs                     ← W1 (JSON-line logger to stderr + redact)
│   ├── url-validator.mjs           ← W1 (SSRF guard standalone)
│   └── sign.mjs                    ← W1 (pure EIP-3009 signing)
└── tests/
    ├── sign.test.mjs               ← W1 (8 tests + golden vector)
    ├── config.test.mjs             ← W1 (7 tests)
    ├── url-validator.test.mjs      ← W1 (9 tests)
    └── tools.test.mjs              ← W2 (12 tests + concurrent + redact)
```

**Verificado**: `mcp-servers/wasiai-x402/` existe pero `src/` está vacío (placeholder generado). No hay `package.json`, `README.md`, ni archivos previos — implementación greenfield.

**NO crear**: `tsconfig.json`, `dist/`, ningún `.ts`, ningún archivo en `src/` del repo principal.

---

## 4. Wave 0 — Scaffold + config infraestructura (SERIAL gate)

> Sin esta wave nada más compila/instala. **Serial obligatorio**.

### W0.0 — Bootstrap directorio + npm init

Comandos exactos (ejecutar desde la raíz del repo):

```bash
mkdir -p mcp-servers/wasiai-x402/src mcp-servers/wasiai-x402/tests
cd mcp-servers/wasiai-x402
npm init -y
```

> Nota: `mcp-servers/wasiai-x402/src/` ya existe (verificado), pero `mkdir -p` es idempotente.

### W0.1 — `package.json`

Sobreescribir `package.json` con esta plantilla literal:

```json
{
  "name": "wasiai-x402",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.mjs",
  "bin": {
    "wasiai-x402": "src/index.mjs"
  },
  "scripts": {
    "start": "node src/index.mjs",
    "test": "node --test tests/",
    "test:sign": "node --test tests/sign.test.mjs",
    "test:config": "node --test tests/config.test.mjs",
    "test:url": "node --test tests/url-validator.test.mjs",
    "test:tools": "node --test tests/tools.test.mjs"
  },
  "engines": {
    "node": ">=20.10.0"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "viem": "^2.21.0",
    "dotenv": "^16.4.0"
  }
}
```

Instalar deps:

```bash
npm install --save @modelcontextprotocol/sdk@^1.0.0 viem@^2.21.0 dotenv@^16.4.0
```

### W0.2 — `.gitignore`

Plantilla literal:

```
# .env files (CD-8 — except .env.example)
.env
.env.local
.env.*.local
.env.production

# Node
node_modules/
dist/
build/

# Logs
*.log
npm-debug.log*

# Coverage
coverage/
.nyc_output/

# OS / Editor
.DS_Store
*.swp
.vscode/
.idea/
```

Verificación:

```bash
cd mcp-servers/wasiai-x402
git check-ignore .env && echo "OK: .env excluded"
git check-ignore .env.example; if [ $? -ne 0 ]; then echo "OK: .env.example NOT excluded"; fi
```

### W0.3 — `.env.example`

Plantilla literal (TODAS las env vars del SDD §4.1, AC-14):

```bash
# ─────────────────────────────────────────────────────────────────
# wasiai-x402 MCP server — example configuration
#
# Copy to .env and fill real values for local dev.
# In Claude Console managed env, set these via the env panel.
# Never commit .env (see .gitignore).
# ─────────────────────────────────────────────────────────────────

# === REQUIRED ===

# Operator wallet private key — funds the EIP-3009 signature on Kite testnet.
# Format: 0x-prefixed 32-byte hex (66 chars total, 64 hex digits).
# Example: 0x1111111111111111111111111111111111111111111111111111111111111111
# WARNING: this PK controls real value. Rotate immediately if leaked.
OPERATOR_PRIVATE_KEY=0xYourOperatorPrivateKey

# === GATEWAY ===

# WasiAI gateway URL (target of the x402 calls).
# Required: NO (defaults to https://app.wasiai.io with warn-once).
# Format: parseable URL, scheme https://. http://localhost only when NODE_ENV=development.
# Example: https://app.wasiai.io
WASIAI_GATEWAY_URL=https://app.wasiai.io

# Allowlist of hosts that bypass the SSRF private-IP guard.
# Required: NO (default empty = no bypass).
# Format: CSV of hostnames (no scheme, no port). Used in dev/staging only.
# Example: internal.example.com,staging.example.com
MCP_GATEWAY_ALLOWLIST=

# === KITE / x402 (defaults match prod) ===

# Kite testnet chain id (used in EIP-712 domain + envelope network field).
# Required: NO (default 2368). Set to 2366 for Kite mainnet (out-of-scope WKH-64).
KITE_CHAIN_ID=2368

# PYUSD contract address on Kite testnet.
# Required: NO (default 0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9).
KITE_PYUSD=0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9

# EIP-712 domain name for PYUSD (must match contract).
# Required: NO (default 'PYUSD').
X402_EIP712_DOMAIN_NAME=PYUSD

# EIP-712 domain version for PYUSD.
# Required: NO (default '1').
X402_EIP712_DOMAIN_VERSION=1

# === GUARDS ===

# Maximum amount in wei the server is willing to sign per pay_x402 call.
# Required: NO (default empty = no guard, NOT recommended in prod).
# Format: integer in wei (BigInt-parseable). Example for 1 PYUSD = 1000000000000000000.
# Per-call override available via input.maxAmountWei (priority: per-call > env > undefined).
MCP_MAX_AMOUNT_WEI_DEFAULT=

# Per-request timeout for HTTP calls to the gateway.
# Required: NO (default 30000 ms).
MCP_PAY_TIMEOUT_MS=30000

# === RUNTIME ===

# Standard Node env (controls strictness of SSRF guard for localhost).
# Required: NO (default 'production'). Set 'development' to allow http://localhost.
NODE_ENV=production
```

### W0.4 — Verificación SDK version (gate antes de W1)

```bash
cd mcp-servers/wasiai-x402
node --version  # debe ser >= 20.10.0
node -e "import('@modelcontextprotocol/sdk/server/index.js').then(m=>console.log(Object.keys(m))).catch(e=>{console.error('FAIL',e.message);process.exit(1)})"
node -e "import('@modelcontextprotocol/sdk/server/stdio.js').then(m=>console.log(Object.keys(m))).catch(e=>{console.error('FAIL',e.message);process.exit(1)})"
```

Resultado esperado: el primer comando imprime un array que **DEBE incluir `Server`**. El segundo comando **DEBE incluir `StdioServerTransport`**.

Si la API cambió (≥2.x):
- **STOP** la implementación.
- Marcar `[BLOCKER]` en el commit-log.
- Escalar al orquestador con: `(a) versión instalada (npm ls @modelcontextprotocol/sdk), (b) keys exportadas reales, (c) referencia al SDD §11 DT-C que pin'a ^1.0.0`.
- NO improvisar adaptación — el SDD reabre.

**Resolver TBD-1 (`package-lock.json` commit Y/N)**: por default, **commitear `package-lock.json`** (deploy a Claude Console reproducible). Si tras `npm install` se generó, agregarlo al commit.

### W0 done definition

- [ ] `mcp-servers/wasiai-x402/{package.json, .gitignore, .env.example}` existen con el contenido literal.
- [ ] `npm install` corrió limpio (sin errores ENOTFOUND / EACCES / 404).
- [ ] `node -e "import('@modelcontextprotocol/sdk/server/index.js')..."` confirma `Server` y `StdioServerTransport` exportados.
- [ ] `git check-ignore .env` retorna 0; `.env.example` NO excluido.
- [ ] `package-lock.json` generado; decisión de commit aplicada.
- [ ] **Listo para commit W0**, NO commitear todavía si pipeline AUTO. Stop here y arrancar W1.

---

## 5. Wave 1 — Módulos puros (paralelizable, testables sin red)

> W1.1, W1.2, W1.4 paralelizables entre sí. W1.3 depende de W1.1 + W1.2. **Anti-Hallucination Checklist § 2 antes de cada uno.**

### W1.1 — `src/log.mjs`

**Imports requeridos**: solo `node:*` (zero externo).

**Exports**:
```js
export function info(event: string, fields: object): void
export function warn(event: string, fields: object): void
export function error(event: string, fields: object): void
export function redact(obj: object): object  // utility, exported for tests
export function resetWarnOnce(): void  // tests-only, resets warn-once cache
export function warnOnce(key: string, event: string, fields: object): void
```

**Lógica crítica** (pseudocódigo):

```js
const REDACT_KEYS = new Set([
  'OPERATOR_PRIVATE_KEY',
  'privateKey',
  'pk',
  'PRIVATE_KEY',
]);
const TRUNCATE_KEYS = new Set([
  'signature',
  'xPaymentHeader',
]);
const _seenWarnOnce = new Set();

function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT_KEYS.has(k)) {
      out[k] = '[REDACTED]';
    } else if (TRUNCATE_KEYS.has(k) && typeof v === 'string') {
      out[k] = v.length > 10 ? v.slice(0, 10) + '…' : v;
    } else if (v && typeof v === 'object') {
      out[k] = redact(v);  // recursive (only redacts known keys, no false positives)
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(level, event, fields) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...redact(fields ?? {}),
  });
  process.stderr.write(line + '\n');  // DT-L: stderr only
}

export function info(event, fields) { emit('info', event, fields); }
export function warn(event, fields) { emit('warn', event, fields); }
export function error(event, fields) { emit('error', event, fields); }

export function warnOnce(key, event, fields) {
  if (_seenWarnOnce.has(key)) return;
  _seenWarnOnce.add(key);
  warn(event, fields);
}

export function resetWarnOnce() { _seenWarnOnce.clear(); }
```

**No tiene tests dedicados — su correcta operación se valida en `tools.test.mjs` (AC-9, AC-16) y `config.test.mjs` (warn-once)**.

### W1.2 — `src/url-validator.mjs`

**Imports**:
```js
import dns from 'node:dns/promises';
```

**Exports**:
```js
export class SSRFViolationError extends Error { constructor(msg, category) {...} }
export async function validateGatewayUrl(rawUrl, options): Promise<URL>
// options = { allowDevPrivate?: boolean, allowlist?: string[] }
```

**Lógica crítica**:

```js
// Steps in order:
// 1. parse → throws SSRFViolationError('invalid url', 'parse')
// 2. protocol https only; allow http://localhost / http://127.0.0.1 only if allowDevPrivate
// 3. literal block: hostname.toLowerCase() ∈ {'localhost'} or matches /\.local\.?$/
//    or /\.localhost\.?$/. Strip trailing '.' (RFC 1035) BEFORE comparison.
// 4. allowlist bypass: if options.allowlist.includes(hostname) → return URL early
// 5. dns.lookup(hostname, {all: true}) → reject if ANY resolved IP is private:
//    IPv4 priv: 10/8, 127/8, 169.254/16, 172.16-31, 192.168/16, 0/8
//    IPv6 priv: '::1', '::', /^fc..|fd..|fe[89ab]..|^::ffff:/i prefixes (matched on
//    expanded form via net.isIPv6 + manual parse).

function isPrivateIPv4(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some(x => Number.isNaN(x) || x < 0 || x > 255)) return false;
  if (o[0] === 10) return true;
  if (o[0] === 127) return true;
  if (o[0] === 169 && o[1] === 254) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 0) return true;
  return false;
}

function isPrivateIPv6(ip) {
  const lc = ip.toLowerCase();
  if (lc === '::1' || lc === '::') return true;
  // ULA fc00::/7 (fc.., fd..)
  if (/^fc[0-9a-f]{2}:/.test(lc) || /^fd[0-9a-f]{2}:/.test(lc)) return true;
  // link-local fe80::/10
  if (/^fe[89ab][0-9a-f]:/.test(lc)) return true;
  // IPv4-mapped (::ffff:x.x.x.x) - extract the v4 and check
  const v4mapped = lc.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4mapped) return isPrivateIPv4(v4mapped[1]);
  return false;
}

export async function validateGatewayUrl(rawUrl, { allowDevPrivate = false, allowlist = [] } = {}) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new SSRFViolationError('invalid url', 'parse'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SSRFViolationError(`disallowed scheme: ${url.protocol}`, 'scheme');
  }
  if (url.protocol === 'http:' && !allowDevPrivate) {
    throw new SSRFViolationError('http:// requires NODE_ENV=development', 'scheme');
  }
  // Strip trailing dot (RFC 1035).
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || /\.local$/.test(host) || /\.localhost$/.test(host)) {
    if (!allowDevPrivate) throw new SSRFViolationError(`literal-blocked host: ${host}`, 'literal');
  }
  if (allowlist.includes(host)) return url;
  // Resolve DNS.
  let resolved;
  try {
    resolved = await dns.lookup(host, { all: true });
  } catch (e) {
    throw new SSRFViolationError(`dns lookup failed: ${e.code ?? e.message}`, 'dns');
  }
  for (const r of resolved) {
    if (r.family === 4 && isPrivateIPv4(r.address) && !allowDevPrivate) {
      throw new SSRFViolationError(`private IPv4: ${r.address}`, 'private-ipv4');
    }
    if (r.family === 6 && isPrivateIPv6(r.address) && !allowDevPrivate) {
      throw new SSRFViolationError(`private IPv6: ${r.address}`, 'private-ipv6');
    }
  }
  return url;
}
```

**Tests requeridos** (`tests/url-validator.test.mjs`, 9 tests):

| # | Test name | Input | Expected |
|---|-----------|-------|----------|
| 1 | `parse fails on garbage url` | `'not a url'` | `SSRFViolationError('invalid url', 'parse')` |
| 2 | `rejects ftp scheme` | `'ftp://example.com'` | `SSRFViolationError(*, 'scheme')` |
| 3 | `rejects http:// in production (allowDevPrivate=false)` | `'http://example.com'` | throws `'scheme'` |
| 4 | `rejects literal localhost in prod` | `'https://localhost'` | throws `'literal'` |
| 5 | `rejects localhost. with trailing dot` | `'https://localhost.'` | throws `'literal'` (RFC 1035) |
| 6 | `rejects foo.local` | `'https://foo.local'` | throws `'literal'` |
| 7 | `rejects 169.254.169.254` (AWS metadata) | mock dns.lookup → `[{family:4, address:'169.254.169.254'}]` | throws `'private-ipv4'` |
| 8 | `rejects 10.0.0.1`, `192.168.1.1`, `172.16.0.1`, `127.0.0.1`, `0.0.0.0` | mock dns | throws `'private-ipv4'` (each as subtest) |
| 9 | `rejects ::1, fc00::1, fe80::1, ::ffff:127.0.0.1` | mock dns IPv6 | throws `'private-ipv6'` (each as subtest) |
| Bonus | `allowlist bypass: app.wasiai.io passes` | real DNS | resolves OK |
| Bonus | `MCP_GATEWAY_ALLOWLIST=internal.example.com permits private DNS` | mock dns → `10.0.0.5`, allowlist=['internal.example.com'] | OK (early return) |

> **Mocking strategy**: usar `t.mock.method(dns, 'lookup', async () => [...])` del `node:test` API. Si no tenés DNS mockeable de esta forma, pasar `dns.lookup` como inyección via param opcional `{ dnsLookup }` con default = `dns.lookup`.

Comando de verificación:
```bash
cd mcp-servers/wasiai-x402 && node --test tests/url-validator.test.mjs
```
**Pasa 9/9 → W1.2 done.**

### W1.3 — `src/config.mjs`

**Depende de**: W1.1 (logger), W1.2 (validator).

**Imports**:
```js
import { privateKeyToAccount } from 'viem/accounts';
import { validateGatewayUrl, SSRFViolationError } from './url-validator.mjs';
import { warnOnce } from './log.mjs';
```

**Exports**:
```js
export class ConfigError extends Error { constructor(msg) {...} }
export async function loadConfig(): Promise<Config>
// Config = {
//   operatorAddress: `0x${string}`,
//   gatewayUrl: URL,
//   chainId: number,
//   contract: `0x${string}`,
//   domainName: string,
//   domainVersion: string,
//   maxAmountWeiDefault: bigint | undefined,
//   payTimeoutMs: number,
//   nodeEnv: string,
// }
```

**Lógica crítica**:

```js
const PK_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export async function loadConfig() {
  // PK validation (AC-6)
  const pkRaw = process.env.OPERATOR_PRIVATE_KEY;
  if (!pkRaw) {
    throw new ConfigError('OPERATOR_PRIVATE_KEY is required and must be a 0x-prefixed 32-byte hex');
  }
  if (!PK_RE.test(pkRaw)) {
    throw new ConfigError('OPERATOR_PRIVATE_KEY is required and must be a 0x-prefixed 32-byte hex');
  }
  // Derive address (this throws if PK is invalid as a key — extra defense).
  let operatorAddress;
  try {
    operatorAddress = privateKeyToAccount(pkRaw).address;
  } catch (e) {
    // Sanitize error: never expose pkRaw.
    throw new ConfigError('OPERATOR_PRIVATE_KEY failed to derive an account');
  }

  // Gateway URL (AC-7, AC-8)
  let rawGateway = process.env.WASIAI_GATEWAY_URL;
  if (!rawGateway) {
    rawGateway = 'https://app.wasiai.io';
    warnOnce('gateway-default', 'config.gateway-default', { gatewayUrl: rawGateway });
  }
  const allowDevPrivate = process.env.NODE_ENV === 'development';
  const allowlist = (process.env.MCP_GATEWAY_ALLOWLIST ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  let gatewayUrl;
  try {
    gatewayUrl = await validateGatewayUrl(rawGateway, { allowDevPrivate, allowlist });
  } catch (e) {
    if (e instanceof SSRFViolationError) {
      throw new ConfigError(`WASIAI_GATEWAY_URL invalid: ${e.message} (category=${e.category})`);
    }
    throw e;
  }

  // Kite chain + contract
  const chainId = Number.parseInt(process.env.KITE_CHAIN_ID ?? '2368', 10);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new ConfigError(`KITE_CHAIN_ID invalid: ${process.env.KITE_CHAIN_ID}`);
  }
  const contract = process.env.KITE_PYUSD ?? '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';
  if (!ADDR_RE.test(contract)) {
    throw new ConfigError(`KITE_PYUSD invalid contract: ${contract}`);
  }

  const domainName = process.env.X402_EIP712_DOMAIN_NAME ?? 'PYUSD';
  const domainVersion = process.env.X402_EIP712_DOMAIN_VERSION ?? '1';

  // Optional guard
  let maxAmountWeiDefault;
  if (process.env.MCP_MAX_AMOUNT_WEI_DEFAULT && process.env.MCP_MAX_AMOUNT_WEI_DEFAULT.trim() !== '') {
    try {
      maxAmountWeiDefault = BigInt(process.env.MCP_MAX_AMOUNT_WEI_DEFAULT);
      if (maxAmountWeiDefault < 0n) throw new Error('negative');
    } catch {
      throw new ConfigError(`MCP_MAX_AMOUNT_WEI_DEFAULT invalid: ${process.env.MCP_MAX_AMOUNT_WEI_DEFAULT}`);
    }
  }

  const payTimeoutMs = Number.parseInt(process.env.MCP_PAY_TIMEOUT_MS ?? '30000', 10);
  if (!Number.isInteger(payTimeoutMs) || payTimeoutMs <= 0) {
    throw new ConfigError(`MCP_PAY_TIMEOUT_MS invalid: ${process.env.MCP_PAY_TIMEOUT_MS}`);
  }

  return {
    operatorAddress,
    gatewayUrl,
    chainId,
    contract,
    domainName,
    domainVersion,
    maxAmountWeiDefault,
    payTimeoutMs,
    nodeEnv: process.env.NODE_ENV ?? 'production',
  };
}
```

**CRÍTICO (CD-14)**: el objeto retornado **NUNCA** incluye la PK. Sólo `operatorAddress`. La PK se lee on-demand en `sign.mjs` (W1.4).

**Tests requeridos** (`tests/config.test.mjs`, 7 tests):

| # | Test name | Setup | Assertion |
|---|-----------|-------|-----------|
| 1 | `throws when OPERATOR_PRIVATE_KEY undefined` | `delete process.env.OPERATOR_PRIVATE_KEY` | `ConfigError` con mensaje exact `'OPERATOR_PRIVATE_KEY is required and must be a 0x-prefixed 32-byte hex'`, NO contiene valor parcial |
| 2 | `throws when PK is 63 hex chars` | `process.env.OPERATOR_PRIVATE_KEY='0x'+'a'.repeat(63)` | `ConfigError`, no PK echo |
| 3 | `throws when PK is 65 hex chars` | similar | `ConfigError` |
| 4 | `throws when PK has whitespace prefix` | `' 0x'+'a'.repeat(64)` | `ConfigError` (no auto-trim) |
| 5 | `valid PK returns config with operatorAddress + NO privateKey field` | PK fija | assert `'privateKey' not in config && 'OPERATOR_PRIVATE_KEY' not in config`, `config.operatorAddress.startsWith('0x')` |
| 6 | `gateway URL fallback to https://app.wasiai.io + warn-once` | `delete WASIAI_GATEWAY_URL`, spy on `process.stderr.write` | exactly 1 stderr call con `event:'config.gateway-default'`, `gatewayUrl:'https://app.wasiai.io'` |
| 7 | `gateway URL http://10.0.0.1 throws SSRF in production` | `WASIAI_GATEWAY_URL='http://10.0.0.1', NODE_ENV='production'` | `ConfigError` mencionando 'scheme' o 'private-ipv4' |
| Bonus | `gateway URL http://localhost permitted with NODE_ENV=development` | dev mode | OK |
| Bonus | `MCP_MAX_AMOUNT_WEI_DEFAULT invalid string throws` | `'not-a-number'` | `ConfigError` |

Comando: `cd mcp-servers/wasiai-x402 && node --test tests/config.test.mjs`. **Pasa 7/7 → W1.3 done.**

### W1.4 — `src/sign.mjs`

**Imports**:
```js
import { privateKeyToAccount } from 'viem/accounts';
```

**Exports**:
```js
export function getOperatorAddress(): `0x${string}`
export async function signX402Envelope(args): Promise<{
  signature: `0x${string}`,
  envelopeBase64: string,
  authorization: { from, to, value, validAfter, validBefore, nonce },
}>
// args = {
//   to: `0x${string}`,           // payTo from 402 challenge (treasury)
//   value: bigint,                // maxAmountRequired in wei
//   validBefore: bigint,          // unix seconds (now()+300)
//   nonce: `0x${string}`,         // 32-byte hex
//   chainId: number,
//   contract: `0x${string}`,
//   domainName: string,
//   domainVersion: string,
// }
```

**Lógica crítica — MATCH EXACTO smoke script `:47-68`**:

```js
function getAccount() {
  // CD-14: read PK on-demand, never cache, never expose.
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) throw new Error('OPERATOR_PRIVATE_KEY missing at sign-time');
  return privateKeyToAccount(pk);
}

export function getOperatorAddress() {
  return getAccount().address;
}

export async function signX402Envelope({
  to, value, validBefore, nonce, chainId, contract, domainName, domainVersion,
}) {
  const account = getAccount();
  const validAfter = 0n;
  const message = {
    from: account.address,
    to,
    value,                 // BigInt — viem serializes
    validAfter,            // 0n
    validBefore,           // BigInt
    nonce,                 // 0x... 32 bytes
  };
  const signature = await account.signTypedData({
    domain: {
      name: domainName,
      version: domainVersion,
      chainId,
      verifyingContract: contract,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message,
  });
  // Envelope — MATCH smoke script :64-68 (DT-D, CD-5).
  // value/validAfter/validBefore as STRING (BigInt → toString()).
  // nonce as 0x bytes32 (already hex string).
  // network as `eip155:<chainId>`.
  const authorization = {
    from: account.address,
    to,
    value: value.toString(),
    validAfter: '0',
    validBefore: validBefore.toString(),
    nonce,
  };
  const envelopeBase64 = Buffer.from(JSON.stringify({
    signature,
    authorization,
    network: `eip155:${chainId}`,
  })).toString('base64');
  return { signature, envelopeBase64, authorization };
}
```

**Tests requeridos** (`tests/sign.test.mjs`, 8 tests + golden vector):

| # | Test name | Setup | Assertion |
|---|-----------|-------|-----------|
| 1 | `GOLDEN VECTOR — fixed inputs produce deterministic envelope` | PK = `'0x'+'11'.repeat(32)`, validBefore=`1700000000n`, nonce=`'0x'+'22'.repeat(32)`, value=`1000000000000000000n`, to=`'0x'+'33'.repeat(20)`, chainId=`2368`, contract=`'0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9'`, domainName='PYUSD', domainVersion='1' | (a) `signature` matches `/^0x[0-9a-f]{130}$/i`. (b) `envelopeBase64` decodes to JSON. (c) JSON has exactly 3 top-level keys: `signature`, `authorization`, `network`. (d) `authorization.from === account.address`. (e) `authorization.value === '1000000000000000000'` (string, no 'n' suffix). (f) `authorization.validAfter === '0'`. (g) `authorization.nonce === '0x'+'22'.repeat(32)` (preserved). (h) `network === 'eip155:2368'`. (i) **Compare full envelope base64 against a hardcoded expected string** captured the first time the test passes (golden), and pin from there. |
| 2 | `signature shape` | any input | `/^0x[0-9a-f]{130}$/i` |
| 3 | `network field encodes chainId` | chainId=2366 | `network === 'eip155:2366'` |
| 4 | `value 0n produces valid envelope` | value=`0n` | `authorization.value === '0'`, signature still valid |
| 5 | `validBefore is BigInt → string in envelope` | validBefore=`1234567890n` | `authorization.validBefore === '1234567890'` |
| 6 | `nonce uniqueness over 100 sequential calls` (defense V4.1) | call sign 100 times with `randomBytes(32)` | `new Set(nonces).size === 100` |
| 7 | `getOperatorAddress reads PK on-demand` | set PK1, call → A1; set PK2, call → A2 | A1 ≠ A2 (no caching) |
| 8 | `throws if PK missing at sign-time` (post-startup deletion) | set PK then `delete process.env.OPERATOR_PRIVATE_KEY` then call sign | throws `'OPERATOR_PRIVATE_KEY missing at sign-time'` |

> **Golden vector — cómo capturarlo**: la PRIMERA corrida del test 1 imprime el envelope. Copiá ese string al test como `EXPECTED_GOLDEN = '...'`. A partir de ahí, cualquier deriva en domain/types/serialización lo rompe (CD-5 BLOQUEANTE en AR).

> **Importante para Dev**: en el test, NO uses `Date.now()` ni `randomBytes` reales. TODO viene fixed por argumento. Si el test es flaky → la lógica está leyendo entropy adentro de `signX402Envelope` (mal, debe ser pure dado los inputs).

Comando: `cd mcp-servers/wasiai-x402 && node --test tests/sign.test.mjs`. **Pasa 8/8 → W1.4 done.**

### W1 done definition

- [ ] `npm test` (que corre `node --test tests/`) pasa **24/24** (sin tools.test):
  - `tests/sign.test.mjs`: 8/8
  - `tests/config.test.mjs`: 7/7
  - `tests/url-validator.test.mjs`: 9/9
- [ ] `src/log.mjs`, `src/url-validator.mjs`, `src/config.mjs`, `src/sign.mjs` existen con shape de exports correcto.
- [ ] PK NO aparece en ningún log de los tests (corré `npm test 2>&1 | grep -c '1111111'` → debe ser `0`).

---

## 6. Wave 2 — `index.mjs` + `tools.test.mjs` (depende de W1)

> **Anti-Hallucination Checklist § 2 antes de empezar.**

### W2.1 — `src/index.mjs`

**Imports**:
```js
#!/usr/bin/env node
import { config as dotenvConfig } from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomBytes } from 'node:crypto';
import { loadConfig, ConfigError } from './config.mjs';
import { signX402Envelope } from './sign.mjs';
import { validateGatewayUrl, SSRFViolationError } from './url-validator.mjs';
import * as log from './log.mjs';
```

> **Verificá en W0.4** que `Server` y `StdioServerTransport` existen como exports; si la API es ligeramente distinta (e.g. `import { McpServer }`), ajustá ANTES de codear el handler.

### MCP server bootstrap pattern

```js
async function main() {
  // Load .env in dev (no-op in Claude Console managed env).
  dotenvConfig();
  if (!process.env.WASIAI_GATEWAY_URL && process.env.NODE_ENV !== 'production') {
    log.warnOnce('dotenv-missing', 'mcp.dotenv', { hint: '.env missing or empty in dev' });
  }

  // Config fail-fast (AC-6, AC-8).
  let cfg;
  try {
    cfg = await loadConfig();
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SSRFViolationError) {
      // Banner to stderr + exit non-zero.
      process.stderr.write(`[wasiai-x402] CONFIG ERROR: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  log.info('mcp.startup', {
    operator: cfg.operatorAddress,
    gateway: cfg.gatewayUrl.toString(),
    chainId: cfg.chainId,
  });

  const server = new Server(
    { name: 'wasiai-x402', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // Register tools — see handlers below.
  registerDiscoverAgents(server, cfg);
  registerGetPaymentQuote(server, cfg);
  registerPayX402(server, cfg);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('mcp.connected', { transport: 'stdio' });
}

main().catch(e => {
  process.stderr.write(`[wasiai-x402] FATAL: ${e.message}\n`);
  process.exit(1);
});
```

> **API exact del MCP SDK**: en W0.4 verificaste `Server` y `StdioServerTransport`. La forma de registrar tools depende de la versión:
> - SDK 1.0.x: `server.setRequestHandler(ListToolsRequestSchema, ...)` y `server.setRequestHandler(CallToolRequestSchema, ...)` (schemas vienen de `@modelcontextprotocol/sdk/types.js`).
> - Si la API es `server.tool('name', schema, handler)` directa (alguna versión), usala.
> - Si encontrás divergencia en F3 vs lo descrito acá → ajustá al patrón real del SDK instalado y dejá comentario `// SDK API resolved at W0.4 verification`.

### Sanitizer top-level inputs (AC-10, V5.4 alcance explícito)

```js
const FORBIDDEN_INPUT_KEYS = ['OPERATOR_PRIVATE_KEY', 'signature', 'authorization'];

function sanitizeInput(toolName, input) {
  if (!input || typeof input !== 'object') return input;
  const clean = {};
  let hadForbidden = false;
  for (const [k, v] of Object.entries(input)) {
    if (FORBIDDEN_INPUT_KEYS.includes(k)) {
      hadForbidden = true;
      continue;
    }
    clean[k] = v;
  }
  if (hadForbidden) {
    log.warnOnce(`forbidden-input-${toolName}`, 'mcp.input.forbidden-keys-stripped', { tool: toolName });
  }
  // NOTE: deep nested keys are NOT inspected (V5.4 explicit scope: top-level only).
  // Anidado intencionalmente fuera de alcance — sólo top-level es sensible.
  return clean;
}
```

### Cap guard pattern (AC-11, V6.2 priority)

```js
function resolveMaxAmountGuard(perCall, envDefault) {
  // Priority: per-call > env > undefined (no guard).
  if (perCall !== undefined && perCall !== null) {
    try {
      const b = BigInt(perCall);
      if (b < 0n) throw new Error('negative');
      return b;
    } catch {
      throw new Error(`invalid maxAmountWei in input: ${perCall}`);
    }
  }
  return envDefault;  // bigint | undefined
}
```

### Handler `discover_agents` (AC-1)

```js
function registerDiscoverAgents(server, cfg) {
  // Tool schema: { query?: string, maxPrice?: number, capabilities?: string[] }
  // Handler:
  async function handler(rawInput) {
    const input = sanitizeInput('discover_agents', rawInput ?? {});
    const url = new URL('/api/v1/capabilities', cfg.gatewayUrl);
    if (input.query) url.searchParams.set('query', input.query);
    if (input.maxPrice !== undefined) url.searchParams.set('maxPrice', String(input.maxPrice));
    if (Array.isArray(input.capabilities) && input.capabilities.length) {
      url.searchParams.set('capabilities', input.capabilities.join(','));
    }
    log.info('tool.discover_agents.request', {
      tool: 'discover_agents', stage: 'fetch', gateway: cfg.gatewayUrl.toString(),
      operator: cfg.operatorAddress, ok: true,
    });
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(cfg.payTimeoutMs) });
    const body = await res.json().catch(() => ({}));
    log.info('tool.discover_agents.response', {
      tool: 'discover_agents', stage: 'done', gateway: cfg.gatewayUrl.toString(),
      operator: cfg.operatorAddress, ok: res.status === 200, status: res.status,
    });
    // AC-1: return body unchanged.
    return body;
  }
  // Wire to MCP SDK (concrete API resolved in W0.4).
}
```

### Handler `get_payment_quote` (AC-2)

```js
async function getPaymentQuoteHandler(rawInput, cfg) {
  const input = sanitizeInput('get_payment_quote', rawInput ?? {});
  const { endpoint, method = 'POST', payload } = input;
  if (!endpoint || typeof endpoint !== 'string') {
    return { ok: false, stage: 'input', error: 'endpoint required' };
  }
  if (!['compose', 'orchestrate'].some(m => endpoint.includes(`/api/v1/${m}`))) {
    // Soft check: spec says method ∈ {compose, orchestrate}. Allow other paths but warn.
    log.warn('tool.get_payment_quote.unexpected-endpoint', { endpoint });
  }
  const url = new URL(endpoint, cfg.gatewayUrl).toString();
  const headers = { 'Content-Type': 'application/json' };  // NO payment-signature here (AC-2)
  const res = await fetch(url, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(cfg.payTimeoutMs),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (res.status !== 402) {
    return { ok: false, stage: 'probe', status: res.status, body };
  }
  const accepts = body.accepts?.[0];
  if (!accepts) {
    return { ok: false, stage: 'probe', error: 'invalid 402: missing accepts[0]', body };
  }
  return {
    ok: true,
    stage: 'quote',
    quote: accepts,            // {payTo, maxAmountRequired, network, ...}
    raw: body,
  };
}
```

### Handler `pay_x402` (AC-3, AC-4, AC-5, AC-11)

```js
async function payX402Handler(rawInput, cfg) {
  const startedAt = Date.now();
  const input = sanitizeInput('pay_x402', rawInput ?? {});
  const { endpoint, method = 'POST', payload, maxAmountWei } = input;
  const url = new URL(endpoint, cfg.gatewayUrl).toString();

  // [1] Probe (no signature)
  let probeRes;
  try {
    probeRes = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(cfg.payTimeoutMs),
    });
  } catch (e) {
    return { ok: false, stage: 'probe', error: `gateway request failed: ${e.message}` };
  }
  const probeText = await probeRes.text();
  let probeBody;
  try { probeBody = JSON.parse(probeText); } catch { probeBody = { raw: probeText }; }

  if (probeRes.status === 200) {
    // Free endpoint
    return { ok: true, stage: 'free', status: 200, result: probeBody, latencyMs: Date.now() - startedAt };
  }
  if (probeRes.status !== 402) {
    return { ok: false, stage: 'probe', status: probeRes.status, body: probeBody };
  }
  const accepts = probeBody.accepts?.[0];
  if (!accepts || !accepts.payTo || !accepts.maxAmountRequired) {
    return { ok: false, stage: 'probe', error: 'invalid 402: missing accepts[0]', body: probeBody };
  }

  // [2] Cap guard (AC-11) BEFORE signing
  let guard;
  try {
    guard = resolveMaxAmountGuard(maxAmountWei, cfg.maxAmountWeiDefault);
  } catch (e) {
    return { ok: false, stage: 'sign', error: e.message };
  }
  const requested = BigInt(accepts.maxAmountRequired);
  if (guard !== undefined && requested > guard) {
    return {
      ok: false,
      stage: 'sign',
      error: 'amount exceeds maxAmountWei guard',
      requested: requested.toString(),
      max: guard.toString(),
    };
  }

  // [3] Sign (AC-3, AC-5)
  let envelope;
  try {
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
    const nonce = '0x' + randomBytes(32).toString('hex');
    envelope = await signX402Envelope({
      to: accepts.payTo,
      value: requested,
      validBefore,
      nonce,
      chainId: cfg.chainId,
      contract: cfg.contract,
      domainName: cfg.domainName,
      domainVersion: cfg.domainVersion,
    });
  } catch (e) {
    // AC-5: never expose PK in error.
    return { ok: false, stage: 'sign', error: `signing failed: ${e.message}` };
  }

  log.info('tool.pay_x402.signed', {
    tool: 'pay_x402', stage: 'sign-ok', gateway: cfg.gatewayUrl.toString(),
    operator: cfg.operatorAddress, ok: true,
    signature: envelope.signature,  // logger truncates to 10 chars
  });

  // [4] Retry with payment-signature
  let settleRes;
  try {
    settleRes = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'payment-signature': envelope.envelopeBase64,
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(cfg.payTimeoutMs),
    });
  } catch (e) {
    return { ok: false, stage: 'settle', error: `gateway settle failed: ${e.message}` };
  }
  const settleText = await settleRes.text();
  let settleBody;
  try { settleBody = JSON.parse(settleText); } catch { settleBody = { raw: settleText }; }

  if (settleRes.status !== 200) {
    return { ok: false, stage: 'settle', status: settleRes.status, body: settleBody };
  }

  return {
    ok: true,
    stage: 'settled',
    status: 200,
    result: settleBody,
    kiteTxHash: settleBody.kiteTxHash,
    latencyMs: Date.now() - startedAt,
  };
}
```

> **CRÍTICO V8.1**: la respuesta retornada al MCP client **NUNCA** debe incluir `signature`. Sí incluye `kiteTxHash`, `result`, `latencyMs`, `status`. Auditar.

### W2.2 — `tests/tools.test.mjs` (12 tests + concurrent + redact)

**Mocks setup**:
- Override `globalThis.fetch` con un fake que devuelve respuestas controladas según call-count + URL.
- Mock `viem` `privateKeyToAccount` con un account fijo cuyo `signTypedData` retorna un hash determinístico (o usa la PK de test fija).
- Spy sobre `process.stderr.write` capturando todas las líneas para assertions de logs.

| # | AC | Test name | Setup | Assertion |
|---|----|-----------|-------|-----------|
| 1 | AC-1 | `discover_agents builds GET capabilities with query/maxPrice/capabilities` | `globalThis.fetch = (u) => { capturedUrl = u; return new Response(JSON.stringify({agents:[]}), {status:200}) }` | `capturedUrl` contiene `?query=AVAX+price&maxPrice=10&capabilities=defi%2Cprice` (URL-encoded) |
| 2 | AC-1 | `discover_agents returns body unchanged` | mock body `{agents:[{id:'X'}], extra:'Y'}` | response is exactly `{agents:[{id:'X'}], extra:'Y'}` |
| 3 | AC-2 | `get_payment_quote captures 402 and parses accepts[0]` | mock 402 with `{accepts:[{payTo:'0x...', maxAmountRequired:'1000'}]}` | response `{ok:true, quote:{payTo:'0x...', maxAmountRequired:'1000'}}` |
| 4 | AC-2 | `get_payment_quote NO payment-signature header` | spy fetch headers | NO key `payment-signature` |
| 5 | AC-3 | `pay_x402 full flow: probe→402→sign→retry→200` | double mock (call 1 = 402, call 2 = 200 with `kiteTxHash:'0xabc'`) | call 2 has `payment-signature` header == envelope.envelopeBase64 from sign module; response `{ok:true, kiteTxHash:'0xabc'}` |
| 6 | AC-4 | `pay_x402: probe 500 → {ok:false, stage:'probe', status:500}` | mock 500 | shape match, NO `txHash`, NO `signature` in response |
| 7 | AC-4 | `pay_x402: retry 400 → {ok:false, stage:'settle', status:400}` | double mock 402→400 | shape match |
| 8 | AC-5 | `pay_x402: sign throw → {ok:false, stage:'sign', error sin PK}` | mock signTypedData to throw `'crypto failed'`; PK is a fixed test value `0xDEAD...DEAD` | response.error does NOT contain `'DEAD'` substring |
| 9 | AC-9 | `PK NEVER appears in stderr across all error paths` | run 6 paths (success, probe 500, retry 400, sign throw, guard exceeded, invalid 402); spy stderr buffer; PK = `0x'+'DE'.repeat(32)` distinguishable | `assert(!stderrBuffer.includes('DE'.repeat(32)))` for full PK substring |
| 10 | AC-10 | `pay_x402 ignores OPERATOR_PRIVATE_KEY in input + warn-once` | input includes `{...payload, OPERATOR_PRIVATE_KEY:'0xCAFE'.repeat(8)}` | (a) flow uses env PK (envelope.from = derived from env, not from input). (b) stderr emits 1 line with `event:'mcp.input.forbidden-keys-stripped'`. (c) input PK NEVER appears in any stderr line. |
| 11 | AC-11 | `pay_x402 aborts pre-sign when maxAmountRequired exceeds env guard` | `MCP_MAX_AMOUNT_WEI_DEFAULT='1000'`, mock 402 with `maxAmountRequired:'9999999999999999999'` | response `{ok:false, stage:'sign', error:'amount exceeds maxAmountWei guard'}`; signTypedData mock NOT called; second fetch NOT called |
| 12 | AC-16 | `logs are JSON-line-per-event with canonical keys` | run a happy `pay_x402` flow; capture all stderr lines | each line is JSON-parseable; success line has `{ts, level, event, tool:'pay_x402', stage, gateway, operator, ok}`; `operator` is the address (matches `/^0x[0-9a-f]{40}$/i`), NEVER 64-char PK |
| Bonus V7.1 | — | `10 concurrent pay_x402 calls — distinct nonces, no log corruption` | `Promise.all(Array(10).fill().map(call))` | 10 distinct envelope.authorization.nonce; each stderr line independently JSON-parseable |
| Bonus V6.2 | AC-11 | `priority: per-call maxAmountWei > env > undefined` | env=1000, per-call=100000000000, gateway=2000 → per-call wins → ok | sign called |
| Bonus | AC-10 | `pay_x402 ignores signature/authorization in input` | input has both | warn-once emits 1, neither field shows in logs |

Comando: `cd mcp-servers/wasiai-x402 && node --test tests/tools.test.mjs`. **Pasa 12/12 (más bonus) → W2 done.**

### W2 done definition

- [ ] `npm test` total = **36/36** (8 + 7 + 9 + 12 = 36 minimo, plus bonus tests).
- [ ] `node src/index.mjs --self-check` (mode dev, env válida) arranca y NO crashea (puede colgar esperando stdio — eso es OK; mata con Ctrl+C).
- [ ] grep en stderr de los tests: PK NUNCA aparece (`grep -c '<PK fija>' stderr.log` = 0).
- [ ] Response de `pay_x402` exitoso NO incluye campo `signature` (verificación V8.1).

---

## 7. Wave 3 — README + smoke local manual

### W3.1 — `README.md`

3 secciones canónicas obligatorias (AC-13). Plantilla:

```markdown
# wasiai-x402 — MCP server for WasiAI x402 payments

A standalone MCP (Model Context Protocol) server that exposes 3 tools for Claude Console
managed agents to discover WasiAI agents, request quotes, and execute x402 payments
against `app.wasiai.io` (Kite testnet PYUSD inbound + downstream USDC outbound).

**Status**: alpha. Mainnet exposure: `pay_x402` signs real EIP-3009 authorizations
that may be settled on-chain by the gateway facilitator.

---

## Setup local

Prerequisites: Node.js >= 20.10.0, npm.

```bash
git clone https://github.com/ferrosasfp/wasiai-a2a.git
cd wasiai-a2a/mcp-servers/wasiai-x402
npm install
cp .env.example .env
# Edit .env — set OPERATOR_PRIVATE_KEY (testnet wallet for local dev).
npm test         # 36/36 tests should pass
npm start        # MCP server starts on stdio (waits for client)
```

To verify the server is alive without an MCP client:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node src/index.mjs
```

You should see a JSON-RPC response listing 3 tools.

---

## Deploy to Claude Console managed env

1. Open Claude Console → MCP Servers → New custom env.
2. Name: `wasiai-orchestrator-env` (or any).
3. Bundle layout — upload these files:
   ```
   wasiai-x402/
   ├── package.json
   ├── package-lock.json
   ├── src/
   │   ├── index.mjs
   │   ├── config.mjs
   │   ├── log.mjs
   │   ├── url-validator.mjs
   │   └── sign.mjs
   ```
4. Entry command: `node src/index.mjs`.
5. Env vars (set via Claude Console env panel — never commit):
   - `OPERATOR_PRIVATE_KEY` — REQUIRED. Mainnet-funded wallet for production demos.
   - `WASIAI_GATEWAY_URL` — default `https://app.wasiai.io`.
   - `MCP_MAX_AMOUNT_WEI_DEFAULT` — REQUIRED in production. Set to a sane cap
     (e.g. `5000000000000000000` = 5 PYUSD).
   - `MCP_PAY_TIMEOUT_MS` — default `30000`.
   - Other vars: see `.env.example`.
6. Test from a Claude Console agent: invoke `discover_agents({query:"AVAX"})` and
   verify the response.
7. **Before mainnet**: invoke `pay_x402` against testnet first. Then with a small
   `MCP_MAX_AMOUNT_WEI_DEFAULT` cap, verify the explorer shows the tx.

---

## Security warnings

- **Operator private key custody**: `OPERATOR_PRIVATE_KEY` controls real funds.
  - Treat it like a production credential. Rotate on any suspected leak.
  - Never paste it in a chat transcript or commit it. The server **never** logs
    the PK (verified by `tests/tools.test.mjs` with 0 matches assertions).
  - Blast radius if leaked: drain of operator wallet (~$5 USDC mainnet at the
    time of writing) **plus** potential abuse of the protocol fee key (see WKH-44).
- **Mainnet exposure**: each successful `pay_x402` call generates a real on-chain
  transaction. There is no "sandbox" mode at the gateway level — testnet vs mainnet
  is decided by `KITE_CHAIN_ID` and the contract address.
- **Cap guard**: ALWAYS set `MCP_MAX_AMOUNT_WEI_DEFAULT` in production. Without it,
  a malicious gateway response with a huge `maxAmountRequired` would be signed
  blindly. The per-call `maxAmountWei` input parameter overrides the env default.
- **SSRF defense**: `WASIAI_GATEWAY_URL` is validated at startup (private-IP rejection).
  In `NODE_ENV=development` the rules are relaxed to allow `localhost`/`127.0.0.1`.
- **Prompt injection resistance**: input fields named `OPERATOR_PRIVATE_KEY`,
  `signature`, or `authorization` (top-level) are stripped silently and trigger
  a `warn-once` log. Nested fields are NOT inspected (out of scope).
- **Rotation**: to rotate, deploy with the new PK, drain the old wallet, never
  reuse the old PK across environments.

---

## License & reporting

Internal — see repository root LICENSE.

Security issues: report privately to the maintainers (do NOT open a public issue).
```

> Verificación textual: `grep -c '## Setup local' README.md`, `grep -c '## Deploy to Claude Console managed env' README.md`, `grep -c '## Security warnings' README.md`. Cada uno debe ser **≥ 1**.

> [TBD-2 resuelto]: usá ASCII tree, no foto. Claude Console no acepta imágenes en MCP descriptors.

### W3.2 — Smoke local manual (NO mainnet, NO firma real)

**Comandos exactos**:

```bash
cd mcp-servers/wasiai-x402

# 1) Server starts and lists tools
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node src/index.mjs 2>/tmp/wasiai-x402-stderr.log

# 2) Inspect stderr — should have JSON lines, no PK leak
cat /tmp/wasiai-x402-stderr.log
grep -c "OPERATOR_PRIVATE_KEY" /tmp/wasiai-x402-stderr.log   # → 0
grep -c "your_PK_substring_here" /tmp/wasiai-x402-stderr.log # → 0

# 3) Optional: discover_agents against real gateway (no signing, public endpoint)
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"discover_agents","arguments":{"query":"AVAX"}}}' | node src/index.mjs
```

**Qué verificar visualmente**:
- (a) El server arranca sin errores en stderr.
- (b) `tools/list` retorna 3 tools: `discover_agents`, `get_payment_quote`, `pay_x402`.
- (c) Cada línea de stderr es JSON parseable (`cat /tmp/wasiai-x402-stderr.log | while read l; do echo $l | python3 -m json.tool >/dev/null || echo "BAD: $l"; done`).
- (d) `discover_agents` retorna agents reales del gateway (público, no requiere firma).
- (e) **NO ejecutar `pay_x402` en este smoke**. Eso es gate humano post-merge.

### W3 done definition

- [ ] `mcp-servers/wasiai-x402/README.md` existe con las 3 secciones canónicas (verificable con grep).
- [ ] Smoke local W3.2 corrió OK: 3 tools listados, stderr sin PK, `discover_agents` retorna body.
- [ ] `git status` muestra ONLY archivos bajo `mcp-servers/wasiai-x402/` (verificación de Scope IN — si aparece algo bajo `src/` del repo principal → STOP, revertir).
- [ ] Commit ready (Dev NO hace push automático — espera gate de F4 / DONE).

---

## 8. Test Plan ejecutable (TODO list — 36 tests)

> Dev SHALL pasar 36/36 antes de cerrar W3. Cada test:

### `tests/sign.test.mjs` (8) — W1.4

- [ ] T01: `GOLDEN VECTOR — fixed PK/nonce/validBefore → deterministic envelope base64` (PIN expected after first run; CD-5 BLOQUEANTE)
- [ ] T02: `signature shape /^0x[0-9a-f]{130}$/i`
- [ ] T03: `network field encodes chainId — 'eip155:<chainId>'`
- [ ] T04: `value 0n produces valid envelope (authorization.value === '0')`
- [ ] T05: `validBefore BigInt → string in envelope`
- [ ] T06: `nonce uniqueness over 100 sequential calls (Set size === 100)`
- [ ] T07: `getOperatorAddress reads PK on-demand (no caching)`
- [ ] T08: `throws if PK deleted post-startup at sign-time`

### `tests/config.test.mjs` (7) — W1.3

- [ ] T09: `throws when OPERATOR_PRIVATE_KEY undefined; message exact + no echo`
- [ ] T10: `throws when PK is 63 chars`
- [ ] T11: `throws when PK is 65 chars`
- [ ] T12: `throws when PK has whitespace prefix (no auto-trim)`
- [ ] T13: `valid PK returns config; NO 'privateKey' nor 'OPERATOR_PRIVATE_KEY' field in returned object`
- [ ] T14: `gateway URL fallback to https://app.wasiai.io + warn-once on stderr`
- [ ] T15: `gateway URL http://10.0.0.1 throws SSRF in production (NODE_ENV=production)`

### `tests/url-validator.test.mjs` (9) — W1.2

- [ ] T16: `parse fails on garbage url`
- [ ] T17: `rejects ftp scheme`
- [ ] T18: `rejects http:// in production`
- [ ] T19: `rejects literal localhost in prod`
- [ ] T20: `rejects localhost. (trailing dot, RFC 1035)`
- [ ] T21: `rejects foo.local`
- [ ] T22: `rejects 169.254.169.254 / 10.0.0.1 / 192.168.1.1 / 172.16.0.1 / 127.0.0.1 / 0.0.0.0` (subtests)
- [ ] T23: `rejects ::1 / fc00::1 / fe80::1 / ::ffff:10.0.0.1` (subtests)
- [ ] T24: `MCP_GATEWAY_ALLOWLIST=internal.example.com permits private DNS`

### `tests/tools.test.mjs` (12) — W2.2

- [ ] T25 (AC-1): `discover_agents builds GET capabilities with query/maxPrice/capabilities`
- [ ] T26 (AC-1): `discover_agents returns body unchanged`
- [ ] T27 (AC-2): `get_payment_quote captures 402 and parses accepts[0]`
- [ ] T28 (AC-2): `get_payment_quote does NOT include payment-signature header`
- [ ] T29 (AC-3): `pay_x402 full flow probe→402→sign→retry→200`
- [ ] T30 (AC-4): `pay_x402: probe 500 → {ok:false, stage:'probe'}; no tx hash`
- [ ] T31 (AC-4): `pay_x402: retry 400 → {ok:false, stage:'settle'}; no tx hash`
- [ ] T32 (AC-5): `pay_x402: sign throw → {ok:false, stage:'sign', error sin PK}`
- [ ] T33 (AC-9): `PK NEVER appears in stderr across all error paths`
- [ ] T34 (AC-10): `pay_x402 ignores OPERATOR_PRIVATE_KEY/signature/authorization in input + warn-once`
- [ ] T35 (AC-11): `pay_x402 aborts pre-sign when maxAmountRequired exceeds env guard`
- [ ] T36 (AC-16): `logs JSON-line-per-event with canonical keys; operator is 0x40-char address`

**Comando full**: `cd mcp-servers/wasiai-x402 && npm test`. Esperado: `36 passed, 0 failed`.

---

## 9. Adversary Directives — copia literal SDD §15 (BLOQUEANTES en F5/AR)

> Dev NO ejecuta AR. Pero el código que escribe debe pasar TODOS estos vectores cuando AR los corra. Si Dev intuye que un vector va a fallar → **abrir [BLOCKER] proactivamente**, no esperar AR.

### V1 — PK leakage en logs (BLOQUEANTE)

- **V1.1**: probe a `pay_x402` con PK fija `0xDEAD...DEAD`. Run los 10 paths de error (probe ok, probe 500, probe network err, sign throw, settle 400, settle 500, timeout, guard exceeded, invalid 402, missing accepts). Capture todo stderr + stdout + console.*. Assert ZERO matches a la substring `DEAD...DEAD`.
- **V1.2**: invocar tool con `payload.OPERATOR_PRIVATE_KEY = '0xCAFE...CAFE'` y assert que NI env-PK NI input-PK aparecen en logs.
- **V1.3**: `Error.stack` desde `signTypedData` mock-throw — assert stack NO contiene PK. (Sanitizá el `e.message` antes de loggearlo.)

### V2 — Envelope drift (BLOQUEANTE)

- **V2.1**: tomar el smoke script vigente, reemplazar PK por una de test, fijar `Date.now()` y `randomBytes` (mock determinístico), correr el smoke contra mock facilitator que captura el `payment-signature`. Correr `pay_x402` con los mismos inputs + mismo mock de tiempo/random. Comparar envelope base64 byte-a-byte. Si difiere en 1 byte → BLOQUEANTE.
- **V2.2**: mutar 1 campo del envelope (ej. `network: 'eip155:2369'`) y verificar que el test golden lo detecta.

### V3 — SSRF (BLOQUEANTE)

- **V3.1**: `WASIAI_GATEWAY_URL=http://169.254.169.254/...` → server NO arranca, exit ≠ 0.
- **V3.2-3.8**: vectores RFC1918 + IPv6 (ver SDD §15 V3 para lista completa).
- **V3.9**: allowlist bypass funcional (bonus test).
- **V3.10**: DNS rebinding — host externo → A `127.0.0.1` → reject.

### V4 — Replay attack

- **V4.1**: 100 sign calls → 100 nonces distintos.
- **V4.2**: `validBefore` en past — defensa client-side opcional, no bloqueante en F2.

### V5 — Prompt injection (BLOQUEANTE)

- **V5.1**: `payload.OPERATOR_PRIVATE_KEY` en input → ignored, env-PK usado.
- **V5.2**: `payload.signature` ignored.
- **V5.3**: `payload.authorization` ignored.
- **V5.4**: payload anidado `{deeply:{nested:{OPERATOR_PRIVATE_KEY:'...'}}}` — sanitizer top-level only por diseño (DOCUMENTAR en README sección Security).

### V6 — Cap bypass (BLOQUEANTE)

- **V6.1**: env guard 1000 wei + gateway pide 1 PYUSD → NO firma, NO retry, response `{ok:false, stage:'sign'}`.
- **V6.2**: priority per-call > env > undefined (4 combinaciones cubiertas).

### V7 — Race conditions

- **V7.1**: 10 calls concurrentes → nonces distintos, no log corruption.
- **V7.2**: 1 timeout + 4 ok concurrentes — el timeout falla aislado.

### V8 — Output integrity

- **V8.1**: response NEVER incluye `signature` plain (verificar shape `{ok, status, result, kiteTxHash?, latencyMs}`).
- **V8.2**: `discover_agents` body sin transformación.

### V9 — Supply chain (informativo, no bloqueante)

- **V9.1**: audit `package.json` — solo `viem`, `@modelcontextprotocol/sdk`, `dotenv`. Sin `postinstall`/`preinstall`/`prepare`/`prepack` scripts.

---

## 10. Wave Done Definition (gate por wave)

| Wave | Done definition |
|------|-----------------|
| **W0** | `npm install` OK + `package.json` + `.gitignore` + `.env.example` con plantillas literales. SDK `Server` y `StdioServerTransport` confirmados (W0.4). `package-lock.json` generado. Files commiteables (NO commit todavía). |
| **W1** | 24/24 tests verde (`tests/sign.test.mjs` 8/8 + `tests/config.test.mjs` 7/7 + `tests/url-validator.test.mjs` 9/9). PK NUNCA en stderr. Golden vector pinned. |
| **W2** | 36/36 tests verde (suma W1 + `tests/tools.test.mjs` 12/12). `node src/index.mjs` arranca sin crashear. Response de `pay_x402` éxito NO incluye `signature` (V8.1). |
| **W3** | `README.md` con 3 secciones canónicas (grep verifica). Smoke local W3.2 OK (3 tools listados, stderr clean). `git status` ONLY bajo `mcp-servers/wasiai-x402/`. Diff limpio. Commit ready. |

---

## 11. Escalation conditions (STOP + abrir [BLOCKER] al orquestador)

| Condición | Por qué bloquea | Qué entregar al orquestador |
|-----------|-----------------|----------------------------|
| **SDK version mismatch** (≥2.x con API breaking, o paquete `@modelcontextprotocol/sdk` no instala) | CD-3 pin'a `^1.0.0`. Cualquier deriva fuerza reabrir SDD. | (a) `npm ls @modelcontextprotocol/sdk` output. (b) keys exportadas reales (output del `node -e ...`). (c) link al SDK changelog si aplica. |
| **Imposibilidad de generar golden vector determinístico** (test T01 inestable cross-run) | CD-5 + CD-10. Si firma diverge → AR BLOQUEANTE garantizado. | (a) outputs base64 de 3 corridas con mismos inputs. (b) versión exacta de `viem` instalada. (c) hipótesis sobre la fuente de divergencia (entropy interna? side effect del SDK?). |
| **Conflicto de archivos pre-existentes** en `mcp-servers/wasiai-x402/` (alguien commiteó algo entre F2 y F3) | Scope IN asume greenfield bajo `src/` y `tests/`. | (a) `git ls-files mcp-servers/wasiai-x402/`. (b) decisión humana: ¿overwrite o merge? |
| **Tests fail después de 3 iteraciones** sobre el mismo test | Iterar a ciegas oculta bugs reales. | (a) test name + assertion message. (b) hipótesis de causa root (no "lo intenté arreglar 3 veces"). (c) qué intentaste y qué descartaste. |
| **`process.env.OPERATOR_PRIVATE_KEY` aparece en stderr** durante un test (V1) | AC-9 BLOQUEANTE. | Path exacto del log + línea del código que loguea + spy capture. |
| **Algo bajo `src/` del repo principal apareció en `git status`** | Scope IN violado. | `git status` output + plan para revertir. |

NO continuar la implementación sin resolución del [BLOCKER]. NO improvisar workarounds.

---

## 12. Resumen para Dev (1-pager mental)

```
1. Leer §0, §1, §2 antes de tipear.
2. W0: scaffold (3 archivos config + npm install + verify SDK).
3. W1: 4 módulos puros + 24 tests. PK NUNCA en log.
4. W2: index.mjs + 12 tests con fetch/viem mocks. Sanitizer top-level. Cap guard. Logger stderr.
5. W3: README 3 secciones + smoke local sin firma.
6. 36/36 verde + diff limpio + commit ready.
7. Si algo no cuadra → §11 escalar, NO improvisar.
```

---

*Story File generado por NexusAgil Architect F2.5 — 2026-04-29*
*Heredado de: SDD #069 (sdd.md), work-item.md (16 ACs, 16 CDs)*
*Ready for: F3 (Dev — `nexus-dev` agent)*
