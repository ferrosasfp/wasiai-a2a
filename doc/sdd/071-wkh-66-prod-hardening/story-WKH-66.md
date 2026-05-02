# Story File — WKH-66 — Production hardening pack para wasiai-x402 MCP

> **Fase F2.5 (Architect)** — contrato self-contained para `nexus-dev` (F3).
> **Status**: `READY_FOR_F3`.
> **Branch**: `feat/071-wkh-66-prod-hardening` desde `main@7b9fc7d`.
> **Inputs aprobados** (no abrir, todo el contrato está acá):
> - `doc/sdd/071-wkh-66-prod-hardening/work-item.md` (HU_APPROVED, 23 ACs)
> - `doc/sdd/071-wkh-66-prod-hardening/sdd.md` (SPEC_APPROVED, 11 DTs, 22 CDs, 5 waves + W0)

---

## 1. Contexto mínimo

**Qué se construye**: endurecer el MCP server `wasiai-x402` (live en `https://wasiai-x402-mcp.vercel.app/api/mcp`) para operación sostenida sin intervención humana en mainnet (Avalanche C-Chain USDC). Después de WKH-65 el endpoint funciona pero la auditoría detectó 6 caveats: cold-start ~30s, race condition de overspend en concurrencia contra operator wallet finito, monitoreo de balance ausente, bearer/session rotation sin runbook, modos de falla sin probar, stress concurrente sin verificar.

**Por qué**: el lema "no construimos software para hackathon sino para producción" exige que el MCP soporte demos concurrentes en mainnet sin drainear el operator wallet, sin caer por cold-start, y con alertas operacionales. Esta HU cementa esos invariantes con balance-gate fail-secure, rate-limit, alert webhook, runbook de rotación, y 57 tests nuevos.

**Qué NO se hace**: NO se modifica el core (`src/{sign,url-validator,handlers,config,log,auth,index}.mjs`). NO se publica a npm. NO se sube el plan Vercel a Pro. NO se ejecuta `vercel deploy` ni `setup-cronjob.mjs` contra cron-job.org real (eso lo hace el orquestador post-merge). NO se modifica `wasiai-v2` ni `app.wasiai.io`.

**Stack confirmado**: Node 22.x serverless, viem `^2.48.4` (ya presente), `@upstash/redis@^1.34.0` (NEW dep), test runner `node --test 'tests/*.test.mjs'`, logs JSON-line vía `src/log.mjs`. NO TypeScript. NO vitest. NO jest.

---

## 2. Anti-Hallucination Checklist (OBLIGATORIO antes de cada wave)

Antes de tocar archivos, leer y confirmar mentalmente:

- [ ] ¿Estoy modificando archivos en **Scope IN** (sólo bajo `mcp-servers/wasiai-x402/`)? Lista exhaustiva en §3.
- [ ] ¿NO estoy tocando el **core** del MCP? PROHIBIDO modificar:
  - `mcp-servers/wasiai-x402/src/sign.mjs`
  - `mcp-servers/wasiai-x402/src/auth.mjs`
  - `mcp-servers/wasiai-x402/src/url-validator.mjs`
  - `mcp-servers/wasiai-x402/src/handlers.mjs`
  - `mcp-servers/wasiai-x402/src/config.mjs`
  - `mcp-servers/wasiai-x402/src/log.mjs`
  - `mcp-servers/wasiai-x402/src/index.mjs`
- [ ] ¿Tests con `node --test` (NO jest, NO vitest, NO mocha)?
- [ ] ¿Logs estructurados via `src/log.mjs` (NO `console.*` directo)? Excepción: `scripts/*.mjs` donde stdout es contrato CLI.
- [ ] ¿Bearer / Private Key / CRON_SECRET / KV_REST_API_TOKEN NUNCA aparecen en logs ni response bodies?
- [ ] ¿Cron-job.org token NUNCA committed (`.env` ignored)?
- [ ] ¿`@upstash/redis` mock-able para tests sin red (via `setKvClientForTesting(mock)`)?
- [ ] ¿NO `event:` dentro del payload de `log.{info,warn,error}` (CD-17, patrón recurrente WKH-64+WKH-65)?
- [ ] ¿TODO `fetch()` nuevo lleva `redirect: 'error'` (CD-18)?
- [ ] ¿Tests concurrentes usan mocks header/body-aware, NO secuenciales (CD-19)?

---

## 3. Scope IN — archivos a tocar (exhaustivo)

Todo bajo `mcp-servers/wasiai-x402/`. **26 entradas** (la diferencia respecto al work-item §Scope IN es que cada test suite es archivo separado y agregamos `tests/_mocks/` × 3 — sin agregar superficie nueva):

### Wave 0 (serial gate — 6 entradas)

| # | Path relativo a `mcp-servers/wasiai-x402/` | Acción |
|---|---|---|
| 1 | `package.json` | MODIFICAR — agregar dep + scripts |
| 2 | `.env.example` | MODIFICAR — nuevas env vars |
| 3 | `tests/_mocks/kv-mock.mjs` | NUEVO |
| 4 | `tests/_mocks/rpc-mock.mjs` | NUEVO |
| 5 | `tests/_mocks/cronjob-org-mock.mjs` | NUEVO |
| 6 | `src/kv-client.mjs` | NUEVO |

### Wave 1 (cold-start cron warmup — 4 entradas)

| # | Path | Acción |
|---|---|---|
| 7 | `src/cron-auth.mjs` | NUEVO |
| 8 | `tests/cron-auth.test.mjs` | NUEVO |
| 9 | `api/cron/warmup.mjs` | NUEVO |
| 10 | `tests/cron-warmup.test.mjs` | NUEVO |

### Wave 2 (balance gate + rate limit — 6 entradas)

| # | Path | Acción |
|---|---|---|
| 11 | `src/balance-guard.mjs` | NUEVO |
| 12 | `src/rate-limit.mjs` | NUEVO |
| 13 | `tests/balance-guard.test.mjs` | NUEVO |
| 14 | `tests/rate-limit.test.mjs` | NUEVO |
| 15 | `api/mcp.mjs` | MODIFICAR (insert-only DT-J, ver §6) |
| 16 | `tests/http.test.mjs` | EXTENDER (3 tests nuevos T-HTTP-13/14/15) |

### Wave 3 (balance monitoring + alerts — 4 entradas)

| # | Path | Acción |
|---|---|---|
| 17 | `src/alerts.mjs` | NUEVO |
| 18 | `tests/alerts.test.mjs` | NUEVO |
| 19 | `api/cron/balance-check.mjs` | NUEVO |
| 20 | `tests/cron-balance-check.test.mjs` | NUEVO |

### Wave 4 (bearer rotation + setup-cronjob — 7 entradas)

| # | Path | Acción |
|---|---|---|
| 21 | `scripts/rotate-bearer.mjs` | NUEVO |
| 22 | `tests/rotate-bearer.test.mjs` | NUEVO |
| 23 | `scripts/refresh-session.mjs` | NUEVO |
| 24 | `tests/refresh-session.test.mjs` | NUEVO |
| 25 | `scripts/setup-cronjob.mjs` | NUEVO |
| 26 | `tests/setup-cronjob.test.mjs` | NUEVO |
| 27 | `README.md` | MODIFICAR — sección "Operations runbook" |

### Wave 5 (chaos + stress — 2 entradas)

| # | Path | Acción |
|---|---|---|
| 28 | `tests/chaos.test.mjs` | NUEVO |
| 29 | `tests/concurrent-stress.test.mjs` | NUEVO |

### Scope OUT (PROHIBIDO tocar)

- `mcp-servers/wasiai-x402/src/{sign,auth,url-validator,handlers,config,log,index}.mjs` — CD-1.
- `mcp-servers/wasiai-x402/vercel.json` — DT-C, cron externo, no se agrega `crons`.
- `wasiai-a2a/src/**` (repo principal) — fuera de scope.
- `wasiai-v2/**`, `app.wasiai.io/**` — fuera de scope.

---

## 4. Wave 0 — Serial Gate (BLOQUEANTE)

Sin esto NO se puede empezar W1+. **No hay paralelismo dentro de W0**, pero W0.1..W0.6 pueden completarse en orden.

### W0.1 — Instalar dep `@upstash/redis@^1.34.0`

```bash
cd mcp-servers/wasiai-x402
npm install --save @upstash/redis@^1.34.0
```

Verificar:
```bash
npm ls @upstash/redis
# Esperado: wasiai-x402-mcp-server@0.1.0 -> @upstash/redis@1.34.x
```

**PROHIBIDO** versión `*` o `latest` (CD-22). Pin caret minor.

### W0.2 — `package.json` (MODIFICAR)

Plantilla literal — heredar de WKH-65 + nueva dep + nuevos scripts:

```json
{
  "name": "wasiai-x402-mcp-server",
  "version": "0.1.0",
  "description": "WasiAI x402 MCP server (stdio + HTTP transport) for Avalanche C-Chain mainnet payments",
  "private": true,
  "type": "module",
  "main": "src/index.mjs",
  "engines": {
    "node": "22.x"
  },
  "scripts": {
    "test": "node --test 'tests/*.test.mjs'",
    "test:chaos": "node --test 'tests/chaos.test.mjs'",
    "test:stress": "node --test 'tests/concurrent-stress.test.mjs'",
    "test:balance-guard": "node --test 'tests/balance-guard.test.mjs'",
    "test:rate-limit": "node --test 'tests/rate-limit.test.mjs'",
    "rotate:bearer": "node scripts/rotate-bearer.mjs",
    "refresh:session": "node scripts/refresh-session.mjs",
    "setup:cronjob": "node scripts/setup-cronjob.mjs",
    "start": "node src/index.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@upstash/redis": "^1.34.0",
    "dotenv": "^16.6.1",
    "viem": "^2.48.4"
  }
}
```

> Si la versión actual de `package.json` difiere en otros scripts (`start` u otros campos), preservar — sólo agregar lo que falta. NO eliminar campos heredados.

### W0.3 — `.env.example` (MODIFICAR — append-only nuevas vars)

Plantilla literal con todas las vars NUEVAS de WKH-66 (mantener TODO lo heredado de WKH-64+WKH-65):

```bash
# === WKH-66 Production Hardening ===

# Cron auth shared secret — usado por cron-job.org Authorization: Bearer header
# OBLIGATORIO en producción. Generar con: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CRON_SECRET=

# Balance gate threshold (USDC mainnet). Si balance < threshold → reject pay_x402 fail-secure.
# Default 0.50 USDC.
MCP_BALANCE_THRESHOLD_USDC=0.50

# Rate limit per bearer hash, per minute. Default 5.
MCP_RATE_LIMIT_PER_MIN=5

# TTL fixed-window rate limit (segundos). Default 60.
MCP_RATE_LIMIT_WINDOW_SEC=60

# TTL del balance snapshot KV usado por balance-guard (segundos). Default 30.
MCP_BALANCE_SNAPSHOT_TTL_SEC=30

# TTL del balance claim KV (segundos). PROHIBIDO > 60s (CD-13). Default 30.
MCP_BALANCE_CLAIM_TTL_SEC=30

# URL del webhook que recibe alertas critical. Generic POST JSON.
# Compatible Slack incoming webhook, Discord webhook, Datadog event.
# Si vacío → log-only (warnOnce).
MCP_ALERT_WEBHOOK_URL=

# RPC endpoint Avalanche C-Chain mainnet. Default: https://api.avax.network/ext/bc/C/rpc
AVALANCHE_RPC_URL=https://api.avax.network/ext/bc/C/rpc

# USDC contract address Avalanche C-Chain mainnet. Default: canonical Circle USDC.
AVALANCHE_USDC_ADDRESS=0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E

# Chain ID for balance reads. Default 43114 (Avalanche C-Chain mainnet).
MCP_OPERATOR_CHAIN_ID=43114

# Upstash Redis (Vercel KV) — provisioning vía Vercel Marketplace.
# Vercel inyecta automáticamente. kv-client.mjs lee con fallback al alias UPSTASH_REDIS_*.
KV_REST_API_URL=
KV_REST_API_TOKEN=
# UPSTASH_REDIS_REST_URL=    # alternative env var name post-2024 integrations
# UPSTASH_REDIS_REST_TOKEN=  # idem

# cron-job.org API token — DEV LOCAL ONLY. NUNCA commitear. NO se setea en Vercel
# (cron-job.org llama a Vercel, no al revés). Se usa SOLO desde scripts/setup-cronjob.mjs.
CRONJOB_ORG_API_TOKEN=

# URL del deploy (para setup-cronjob.mjs). Ejemplo: https://wasiai-x402-mcp.vercel.app
MCP_DEPLOY_URL=
```

### W0.4 — `tests/_mocks/kv-mock.mjs` (NUEVO)

Map-backed in-memory mock con API compat `@upstash/redis`. Soporte para chaos flags. Subset implementado: `get/set/incr/incrby/decrby/expire/ttl/del`. PROHIBIDO Lua EVAL (alineado con DT-I).

Interface esperada:
```js
export function createKvMock({ failNext = 0, slowMs = 0, staleData = null } = {}) {
  // returns { get, set, incr, incrby, decrby, expire, ttl, del, _store, _setFailNext, _setSlowMs }
}
```

Patrón de implementación: setTimeout para slowMs, decremento atómico de failNext (cada call falla mientras failNext>0).

### W0.5 — `tests/_mocks/rpc-mock.mjs` (NUEVO)

Mock viem-compat de `publicClient.readContract` para `balanceOf`. Retorna **`bigint`** (no number — alineado con viem real, CD-19/V10.1.b).

```js
export function createRpcMock({ balance = 1000000n, failNext = 0, slowMs = 0, rateLimit429 = false } = {}) {
  // returns { readContract: async (...) => bigint }
}
```

### W0.6 — `tests/_mocks/cronjob-org-mock.mjs` (NUEVO)

Mock del fetch a `https://api.cron-job.org/jobs`. Soporta GET (list), PUT (create), PATCH (update). Body-aware (matcheo por title — alineado con CD-19).

```js
export function createCronjobOrgMock({ existingJobs = [], failNext = 0, slowMs = 0 } = {}) {
  // returns fetch-shaped mock: (url, opts) => Response
}
```

### W0.7 — `src/kv-client.mjs` (NUEVO)

Lazy singleton wrapper sobre `@upstash/redis`. **OBLIGATORIO null-safe** (si env vars no están → retorna `null`, NO throw). Test override via `setKvClientForTesting`.

Patrón exacto (heredar del SDD §4.3):

```js
import { Redis } from '@upstash/redis';
import { warnOnce } from './log.mjs';

let _client = null;
let _testOverride = null;

export function getKvClient() {
  if (_testOverride !== null) return _testOverride;
  if (_client) return _client;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    warnOnce('kv-not-configured', 'kv.client.not-configured', {});
    return null;
  }
  _client = new Redis({ url, token });
  return _client;
}

export function setKvClientForTesting(client) { _testOverride = client; }
export function resetKvClient() { _client = null; _testOverride = null; }
```

> Verificar que `warnOnce` es un export real de `src/log.mjs` (lo es — Context Map SDD §3 confirma). Si no se exportara, leer `src/log.mjs:1-75` para validar.

### W0.8 — Gate humano: provisioning Upstash via Vercel Marketplace

**Esto NO lo hace el Dev**. Es responsabilidad humana / orquestador.

**Si `KV_REST_API_URL` / `KV_REST_API_TOKEN` NO están provisionadas en Vercel project**:
- Dev DEBE proceder usando **mocks 100%** para todos los tests (CD-7).
- Dev **NO debe** intentar provisionar Upstash desde el script.
- Documentar en commit message: "Tests pass via kv-mock; KV provisioning post-merge orquestador".

**Si están provisionadas**: igual los tests usan mocks (CD-7). El provisioning real importa sólo para el deploy post-merge.

### W0 — Done Definition

- [ ] `npm install` corre sin errores en `mcp-servers/wasiai-x402/`.
- [ ] `npm test` baseline 103 tests passing (sin regresión vs WKH-65).
- [ ] `package.json` declara `@upstash/redis@^1.34.0` (caret minor pinned).
- [ ] `.env.example` documenta TODAS las nuevas env vars.
- [ ] 3 mocks creados en `tests/_mocks/`.
- [ ] `src/kv-client.mjs` retorna `null` (no throw) si env vars missing.

---

## 5. Wave 1 — Cold-start cron warmup

Depende de W0.7 (`getKvClient`). NO depende de W2-W5 — paralelizable con W4.

### W1.1 — `src/cron-auth.mjs` (NUEVO)

Patrón a copiar **VERIFICADO**: `mcp-servers/wasiai-x402/src/auth.mjs:47-80` (`validateBearerToken`). Usa `node:crypto.timingSafeEqual` sobre buffers utf8.

Interface:
```js
export class CronAuthError extends Error {
  constructor(message, status = 401) { super(message); this.status = status; this.name = 'CronAuthError'; }
}

export function validateCronSecret(authHeader, expectedSecret) {
  // 1. Si !expectedSecret → throw CronAuthError 500 'CRON_SECRET not configured'
  //    (CD-4: NUNCA "auth disabled")
  // 2. Parse "Bearer <secret>" — si no matchea → throw CronAuthError 401 'unauthorized'
  // 3. Length pre-check (NO leak — mismas longitudes pad a igual)
  // 4. timingSafeEqual sobre Buffer.from(expectedSecret, 'utf8') vs Buffer.from(received, 'utf8')
  // 5. Si false → throw CronAuthError 401 'unauthorized'
  // 6. Si true → return true
}
```

CDs aplicables: CD-4 (timing-safe + 500 si missing), CD-10 (no log secret), CD-17 (no `event:` en payload).

### W1.2 — `tests/cron-auth.test.mjs` (NUEVO)

5 tests:

| Test ID | Nombre | Mock setup | Assertion key |
|---|---|---|---|
| T-CA-01 | `validateCronSecret happy path` | expected='abc', header='Bearer abc' | returns true |
| T-CA-02 | `validateCronSecret missing CRON_SECRET → 500` | expected='', header='Bearer x' | throw CronAuthError status=500 |
| T-CA-03 | `validateCronSecret malformed header → 401` | expected='abc', header='Token abc' | throw CronAuthError status=401 |
| T-CA-04 | `validateCronSecret wrong secret → 401` | expected='abc', header='Bearer xyz' | throw CronAuthError status=401 |
| T-CA-05 | `validateCronSecret uses timingSafeEqual` | spy `crypto.timingSafeEqual` | spy called once |

### W1.3 — `api/cron/warmup.mjs` (NUEVO)

Handler Vercel **Express-style** `(req, res) => void` (DT-K). NO usar webHandler / Web Standards intermediate.

Spec:
1. Extract `req.headers.authorization`. Validate via `validateCronSecret(...)`. Si throw → `res.status(err.status).json({ error: 'unauthorized' })`. Catch genérico → `res.status(500).json({ error: 'internal' })`.
2. Pre-load (dynamic `await import(...)` para que el módulo quede en memoria del worker):
   - `await import('../../src/handlers.mjs');`
   - `await import('../../src/sign.mjs');`
   - `viem.privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY).address` (account derivation only — NO network).
3. **PROHIBIDO** ejecutar firma real, fetch al gateway, ni RPC. Sólo derivar address (in-memory).
4. Response 200 `{ ok: true, warmedAt: new Date().toISOString() }`.
5. Logs: `info('cron.warmup.ok', { warmedAt })` — NO loggear PK, NO loggear el address (es público pero por defensa-en-profundidad).

CDs aplicables: CD-4 (auth), CD-10 (no log secrets), CD-17 (no `event:` en payload), DT-K (Express-style).

### W1.4 — `tests/cron-warmup.test.mjs` (NUEVO)

4 tests:

| Test ID | Nombre | Mock setup | Assertion key |
|---|---|---|---|
| T-WM-01 | `warmup happy path 200 + body shape + latency` | env CRON_SECRET='abc', header 'Bearer abc' | `res.status===200`, body `{ok:true, warmedAt:<ISO>}`, elapsed < 2000ms (assert sólo en segundo call, primer call cold) |
| T-WM-02 | `warmup sin auth → 401 + no side effects` | header missing | `res.status===401`, NO `import(handlers.mjs)` invocado (spy) |
| T-WM-03 | `warmup auth wrong → 401 timing-safe` | header 'Bearer xyz' | `res.status===401`, error 'unauthorized' |
| T-WM-04 | `warmup pre-load critical modules` | spy `import()`, env CRON_SECRET set | imports include 'handlers.mjs' AND 'sign.mjs', NO `globalThis.fetch` invocado |

### W1 — Done Definition

- [ ] `src/cron-auth.mjs` exporta `validateCronSecret` + `CronAuthError`.
- [ ] `api/cron/warmup.mjs` responde 200 con auth ok / 401 sin auth.
- [ ] 4 tests warmup + 5 tests cron-auth passing.
- [ ] Logs no contienen `OPERATOR_PRIVATE_KEY` ni `CRON_SECRET` (verificado en T-WM-04).

---

## 6. Wave 2 — Balance gate + rate limit (CRÍTICO)

**Camino crítico**. W3 depende de W2.1 (balance read). W2.5 (integración api/mcp.mjs) es el único punto de modificación en `api/mcp.mjs` — **insert-only**, NO modificar lógica heredada.

### W2.1 — `src/balance-guard.mjs` (NUEVO)

Exports:
- `checkBalanceWithClaim({ operator, chainId, requestedWei, threshold, kvClient, publicClient })` → `{ ok, claimId, balanceUsdc, claimedTotalWei } | { ok:false, stage:'balance-gate', error }`
- `releaseClaim({ claimKey, requestedWei, kvClient })` → `void` (best-effort, no throw)
- `getOperatorBalance(rpcUrl, operatorAddress, usdcAddress)` → `bigint` (helper, usado por cron balance-check también)
- `isCircuitOpen(balanceUsdc, threshold)` → `boolean` (helper para cron — true si balance < threshold)

Implementación referencia: SDD §4.3 `balance-guard.mjs` (pseudocódigo). Reglas:

1. **Fail-secure** (CD-2): si `kvClient===null` → `{ ok:false, stage:'balance-gate', error:'balance check unavailable' }`. Si RPC throw → idem.
2. **Read balance**: 1) intenta KV snapshot (`balance-snapshot:eip155:<chainId>:<operator.toLowerCase()>` TTL 30s); 2) si miss/stale (>30s) → `publicClient.readContract({address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [operator]})`; 3) cache result en KV con TTL 30s.
3. **Atomic claim**: `INCRBY` + `EXPIRE 30` + CAS-revert. Key shape: `balance-claim:eip155:<chainId>:<operator.toLowerCase()>`. Si `newClaimed > balanceWei - thresholdWei` → `DECRBY requestedWei` (revert) → reject.
4. **claimId**: `crypto.randomUUID()` para release lookup.
5. PROHIBIDO Lua EVAL (DT-I).
6. PROHIBIDO TTL > 60s (CD-13).

Patrón viem para balance read **VERIFICADO** (`src/lib/downstream-payment.ts:237-249`):
```js
const balanceWei = await publicClient.readContract({
  address: usdcAddress,
  abi: erc20Abi,        // import { erc20Abi } from 'viem'
  functionName: 'balanceOf',
  args: [operator],
});
// balanceWei es bigint
```

`createPublicClient` patrón:
```js
import { createPublicClient, http, erc20Abi } from 'viem';
import { avalanche } from 'viem/chains';
const publicClient = createPublicClient({
  chain: avalanche,
  transport: http(process.env.AVALANCHE_RPC_URL),
});
```

### W2.2 — `src/rate-limit.mjs` (NUEVO)

Exports:
- `checkRateLimit({ bearerHash16, kvClient, perMin, windowSec })` → `{ ok:true } | { ok:false, retryAfter:number }`
- `hashBearer(bearerToken)` → `string` (sha256 hex truncado a 16 chars — CD-14)

Implementación referencia: SDD §4.3 `rate-limit.mjs`. Reglas:

1. **Fail-open** (CD-2 inverso): si `kvClient===null` → `{ ok:true }`. Si KV throw → log warn + `{ ok:true }`.
2. **Fixed-window-with-jitter**: `INCR <key>`, si `count===1` → `EXPIRE <key> <windowSec>`. Si `count > perMin` → `TTL <key>` para retryAfter, return `{ ok:false, retryAfter }`.
3. **Hash bearer**: `crypto.createHash('sha256').update(bearer, 'utf8').digest('hex').slice(0, 16)` — CD-14.
4. **Key shape**: `rl:<bearerHash16>`.

PROHIBIDO usar el bearer plano como key KV (CD-3). PROHIBIDO usar IP (CD-3).

### W2.3 — `tests/balance-guard.test.mjs` (NUEVO)

8 tests T-BG-01..T-BG-08 (cubren AC-W5-3 a..h):

| Test ID | Nombre | Mock setup | Assertion key |
|---|---|---|---|
| T-BG-01 | `balance > threshold + amount → permite` | kv-mock empty, rpc-mock balance=1_000_000n (1 USDC), threshold=0.5, amount=100_000n (0.1) | `result.ok===true`, claimId is uuid |
| T-BG-02 | `balance < threshold → reject pre-firma` | rpc-mock balance=400_000n (0.4), threshold=0.5 | `result.ok===false, stage='balance-gate', error='operator balance below threshold'` |
| T-BG-03 | `RPC fail → fail-secure reject` | rpc-mock failNext=1 | `result.ok===false, error='balance check unavailable'` |
| T-BG-04 | `claim atomic ok` | kv-mock + balance ok | INCRBY value matches requestedWei, EXPIRE called with 30 |
| T-BG-05 | `claim release on settle ok` | call check + release | DECRBY called with requestedWei |
| T-BG-06 | `claim release on settle fail (try/finally)` | mock that throws after claim | DECRBY still called |
| T-BG-07 | `claim release on sign fail` | sign mock throws | DECRBY still called |
| T-BG-08 | `claim TTL expiry libera huérfanos` | kv-mock with manual TTL advance | claim key absent after TTL window |

### W2.4 — `tests/rate-limit.test.mjs` (NUEVO)

6 tests T-RL-01..T-RL-06 (cubren AC-W5-4 a..f):

| Test ID | Nombre | Mock setup | Assertion key |
|---|---|---|---|
| T-RL-01 | `primer request OK` | kv-mock empty, perMin=5 | `result.ok===true`, INCR returns 1 |
| T-RL-02 | `request 6 dentro de ventana → 429` | call 5x, then 6th | `result.ok===false, retryAfter > 0` |
| T-RL-03 | `bearer hash es sha256 trunc16 (no plano)` | spy KV INCR key arg | key matches `/^rl:[0-9a-f]{16}$/`, NOT contains plain bearer |
| T-RL-04 | `KV down → fail-open` | kv-mock failNext=1 | `result.ok===true` |
| T-RL-05 | `bearers diferentes no se afectan` | call bearer A 5x then bearer B 1x | both ok (key isolation) |
| T-RL-06 | `request post-ventana → OK` | TTL advance > windowSec, then call | `result.ok===true` |

### W2.5 — `api/mcp.mjs` (MODIFICAR — INSERT-ONLY)

**ESTO ES EL ÚNICO MOMENTO QUE SE TOCA `api/mcp.mjs`**. Modificación insert-only — NO eliminar ni reordenar lógica heredada de WKH-65.

**Orden de operaciones DEFINITIVO** (DT-J §11 SDD):
```
1. CORS preflight (HEREDADO)
2. Method gate !POST → 405 (HEREDADO)
3. Bearer auth (HEREDADO — timingSafeEqual)
4. **NUEVO** Rate limit (checkRateLimit) → 429 si exceed
5. loadConfig (HEREDADO)
6. buildServer + transport (HEREDADO)
7. Dispatch tools/call (HEREDADO + WRAP en pay_x402):
   - case 'discover_agents'   → handler directo (sin balance gate)
   - case 'get_payment_quote' → handler directo (sin balance gate)
   - case 'pay_x402':
       a. **NUEVO** await checkBalanceWithClaim(...)
          if !ok → return { ok:false, stage:'balance-gate', error }
       b. try { result = await payX402Handler(args, cfg) }
          finally { await releaseClaim(...) }
       c. return result
```

**Insertion points concretos**:
- Punto A: en `webHandler` (`api/mcp.mjs:166-268`), DESPUÉS del bearer auth y ANTES del `loadConfig`. Insertar bloque `try { await checkRateLimit(...) } catch { ... }` con response 429.
- Punto B: en el switch de `tools/call` (cerca de donde despacha a `payX402Handler`). Wrap el case `pay_x402` con balance-gate + try/finally.

**PROHIBIDO**:
- NO modificar `src/handlers.mjs` (CD-1). El wrap va en `api/mcp.mjs`.
- NO mover `loadConfig` antes del rate limit.
- NO eliminar bearer auth ni CORS.
- NO cambiar el shape de respuesta JSON-RPC para los casos NO-pay_x402.

**Imports a agregar al top de `api/mcp.mjs`**:
```js
import { getKvClient } from '../src/kv-client.mjs';
import { checkRateLimit, hashBearer } from '../src/rate-limit.mjs';
import { checkBalanceWithClaim, releaseClaim } from '../src/balance-guard.mjs';
import { createPublicClient, http } from 'viem';
import { avalanche } from 'viem/chains';
```

### W2.6 — `tests/http.test.mjs` (EXTENDER — 3 tests nuevos)

Agregar al final de `tests/http.test.mjs` (NO modificar tests heredados WKH-65 — preservar T-HTTP-01..T-HTTP-12):

| Test ID | Nombre | Mock setup | Assertion key |
|---|---|---|---|
| T-HTTP-13 | `rate limit fires after 5 req/min` | kv-mock + bearer 'b1' | request 6 → status 429, body `error:'rate limit exceeded', retryAfter:>0` |
| T-HTTP-14 | `balance gate rejects pay_x402 sub-threshold` | rpc-mock balance=400_000n, threshold=0.5 | response body `ok:false, stage:'balance-gate'` |
| T-HTTP-15 | `discover_agents NO pasa por balance gate` | rpc-mock balance=0n | discover_agents responde normal (no se invoca checkBalanceWithClaim) |

### W2 — Done Definition

- [ ] `src/balance-guard.mjs` exports `checkBalanceWithClaim`, `releaseClaim`, `getOperatorBalance`, `isCircuitOpen`.
- [ ] `src/rate-limit.mjs` exports `checkRateLimit`, `hashBearer`.
- [ ] 8 tests balance-guard + 6 tests rate-limit + 3 tests http extension passing (= **17 tests nuevos en W2** + 14 = 17, total post-W2 = 103 + 17 = 120).
- [ ] `api/mcp.mjs` modificado **insert-only** según DT-J.
- [ ] T-HTTP-01..T-HTTP-12 (baseline WKH-65) **siguen passing** sin modificación.
- [ ] Stress test T-CS-01 puede correr (queda para W5 pero no debería bloquear).

---

## 7. Wave 3 — Balance monitoring + alerts webhook

Depende de W2.1 (`getOperatorBalance` reutilizable).

### W3.1 — `src/alerts.mjs` (NUEVO)

Exports:
- `sendAlert({ severity, body, webhookUrl, timeoutMs=5000 })` → `{ sent:boolean, reason?:string }` (NO throw).
- `sanitizeAlertBody(body)` → object filtrado al whitelist CD-12.

Reglas:

1. Si `!webhookUrl` → `warnOnce('alert-webhook-not-configured', 'mcp.alert.no-webhook-configured', {})` + return `{ sent:false, reason:'webhook not configured' }`.
2. **`AbortSignal.timeout(5000)`** (CD-5).
3. **`redirect: 'error'`** (CD-18).
4. **NO retries** (CD-5).
5. **Body whitelist** (CD-12): solo `severity, chain, operator, balanceUsdc, threshold, checkedAt, blockNumber?`. PROHIBIDO PK, bearer, raw hex sin redactar, error.message, kiteTxHash, signature.
6. Log error: `warn('mcp.alert.webhook-failed', { stage:'alert', status?:status })` — NO log webhookUrl completo (puede contener token en query — CD-10).

Reference shape: SDD §4.3 `alerts.mjs`.

### W3.2 — `tests/alerts.test.mjs` (NUEVO)

4 tests:

| Test ID | Nombre | Mock setup | Assertion key |
|---|---|---|---|
| T-AL-01 | `sendAlert timeout 5s` | mock fetch slow >5000ms | `result.sent===false`, fetch aborted via AbortSignal |
| T-AL-02 | `sendAlert body whitelist enforced` | body includes `pk, bearer, error.message` | POST body lacks pk/bearer/error, only contains whitelisted keys |
| T-AL-03 | `sendAlert no-PK no-bearer` | spy stderr + body capture | stderr/body NUNCA contienen `OPERATOR_PRIVATE_KEY` ni `MCP_BEARER_TOKEN` ni 0x{64hex} patterns |
| T-AL-04 | `sendAlert webhookUrl missing → warnOnce + no fetch` | webhookUrl='' | global fetch NOT called, log line `mcp.alert.no-webhook-configured` once |

### W3.3 — `api/cron/balance-check.mjs` (NUEVO)

Express-style handler `(req, res) => void` (DT-K).

Spec (SDD §4.4 Path 3):
1. `validateCronSecret(req.headers.authorization, process.env.CRON_SECRET)`. Catch → 401/500.
2. Read balance: `await getOperatorBalance(AVALANCHE_RPC_URL, operatorAddress, usdcAddress)` (helper de balance-guard.mjs).
3. Persist KV snapshot `balance-snapshot:eip155:43114:<operator>` TTL **1800s** (30 min — esto es el snapshot del cron, distinto del snapshot de `balance-guard.mjs` TTL 30s; misma key — la cron escribe TTL 30 min, `balance-guard.mjs` lee si está fresh < 30s).
   - Body: `{ balanceWei: balanceWei.toString(), balanceUsdc, checkedAt, blockNumber }`.
4. Si `balanceUsdc < threshold` AND `MCP_ALERT_WEBHOOK_URL` set:
   - `await sendAlert({ severity:'critical', body:{chain:'avalanche-c-chain-mainnet', operator, balanceUsdc, threshold, checkedAt, blockNumber}, webhookUrl: process.env.MCP_ALERT_WEBHOOK_URL })`
   - **PROHIBIDO** que un webhook fail rompa el cron — `sendAlert` retorna `{sent:false, reason}`, NO throw.
5. Response 200 `{ balanceWei, balanceUsdc, checkedAt, blockNumber }` **siempre** (incluso si webhook falla — AC-W3-4).

CDs aplicables: CD-4 (auth), CD-5 (timeout webhook 5s), CD-10 (no log secrets), CD-12 (body whitelist), CD-16 (USDC ERC-20 NOT native AVAX), CD-17 (no `event:` en payload), CD-18 (`redirect:'error'` en sendAlert), CD-21 (response al cron y body al webhook son canales separados).

### W3.4 — `tests/cron-balance-check.test.mjs` (NUEVO)

5 tests T-BC-01..T-BC-05:

| Test ID | Nombre | Mock setup | Assertion key |
|---|---|---|---|
| T-BC-01 | `balance-check happy path` | env CRON_SECRET set, rpc-mock balance=5_000_000n, kv-mock | res.status=200, body shape ok, KV snapshot persisted with TTL 1800 |
| T-BC-02 | `balance < threshold + webhook configured → POST` | rpc-mock balance=400_000n, MCP_ALERT_WEBHOOK_URL=http://mock | webhook POST called, body whitelist (no pk/bearer) |
| T-BC-03 | `webhook timeout → log only + cron 200` | webhook mock slowMs=6000 | res.status=200, log `mcp.alert.webhook-failed`, cron does NOT throw |
| T-BC-04 | `webhook URL not set → warnOnce + 200` | MCP_ALERT_WEBHOOK_URL='' | res.status=200, log `mcp.alert.no-webhook-configured` once |
| T-BC-05 | `auth missing/wrong → 401` | header missing | res.status=401, NO RPC call (spy) |

### W3 — Done Definition

- [ ] `src/alerts.mjs` exports `sendAlert`, `sanitizeAlertBody`.
- [ ] `api/cron/balance-check.mjs` handler GET con auth + RPC + snapshot KV + alert.
- [ ] 4 tests alerts + 5 tests cron-balance-check passing (= **9 tests nuevos en W3**).
- [ ] T-AL-03 verifica empíricamente que webhook body NO contiene PK/bearer/secrets.

---

## 8. Wave 4 — Bearer rotation + session refresh + setup-cronjob

Paralelizable con W1+W2+W3 (no depende de balance-guard ni rate-limit).

### W4.1 — `scripts/rotate-bearer.mjs` (NUEVO)

CLI script (Node ESM). Reglas:

1. `crypto.randomBytes(32).toString('hex')` → 64 char hex.
2. Si `!process.stdout.isTTY` → exit 1 con stderr message "Refusing to print bearer to non-TTY (would risk redirect to git-tracked file). Re-run from interactive terminal." — AC-W4-2.
3. Imprime el bearer a stdout **EXACTAMENTE UNA VEZ**.
4. Imprime a stderr instrucciones literales para `vercel env add MCP_BEARER_TOKEN production` + `vercel env rm MCP_BEARER_TOKEN production` del valor anterior.
5. **PROHIBIDO** escribir a disco, a `.env`, ni commitear (CD-6).

Logs: `console.log(bearer)` para stdout; `console.error(...)` para stderr (CD-8 excepción para scripts/*.mjs).

### W4.2 — `tests/rotate-bearer.test.mjs` (NUEVO)

2 tests:

| Test ID | Nombre | Mock setup | Assertion key |
|---|---|---|---|
| T-RB-01 | `rotate generates 32 bytes hex once + no disk write` | spawn child process with mock TTY, capture stdout, spy fs.writeFile | stdout matches `/^[0-9a-f]{64}\n$/`, fs.writeFile NOT called |
| T-RB-02 | `rotate non-TTY → exit !=0` | spawn with stdout pipe (isTTY=false) | exit code === 1, stderr contains "Refusing" |

### W4.3 — `scripts/refresh-session.mjs` (NUEVO)

CLI smoke. Lee `MCP_BEARER_TOKEN` y `MCP_DEPLOY_URL` de env (NO commiteable). POST `<MCP_DEPLOY_URL>/api/mcp` con body JSON-RPC `{jsonrpc:'2.0', id:1, method:'tools/list', params:{}}`. Headers `Authorization: Bearer ${bearer}`.

Reglas:
1. Verifica response status 200.
2. Verifica `result.tools.length === 3`.
3. Si fail → exit 1 con stderr error.
4. Si ok → stdout `{ ok:true, toolCount:3 }` + exit 0.
5. `fetch()` con `redirect: 'error'` (CD-18).

### W4.4 — `tests/refresh-session.test.mjs` (NUEVO)

1 test T-RS-01:

| Test ID | Nombre | Mock setup | Assertion key |
|---|---|---|---|
| T-RS-01 | `refresh session tools/list → 3 → exit 0` | mock fetch returns 200 + result.tools.length=3 | spawn child exits 0, stdout JSON `{ok:true, toolCount:3}` |

(Opcional T-RS-02 fail case si tiempo permite — pero no es bloqueante.)

### W4.5 — `scripts/setup-cronjob.mjs` (NUEVO)

CLI provisioning **idempotente** (CD-20) contra cron-job.org API.

Spec:
1. Read env: `CRONJOB_ORG_API_TOKEN`, `MCP_DEPLOY_URL`, `CRON_SECRET`. Si alguna falta → exit 1 con stderr error claro.
2. Define los 2 jobs:
   ```js
   const jobs = [
     { title: 'wasiai-x402-warmup',
       url: `${MCP_DEPLOY_URL}/api/cron/warmup`,
       schedule: { minutes: '*/4', hours: '*', mdays: '*', months: '*', wdays: '*' },
       requestMethod: 1 /* GET */,
       extendedData: { headers: { Authorization: `Bearer ${CRON_SECRET}` } } },
     { title: 'wasiai-x402-balance-check',
       url: `${MCP_DEPLOY_URL}/api/cron/balance-check`,
       schedule: { minutes: '*/15', hours: '*', mdays: '*', months: '*', wdays: '*' },
       requestMethod: 1, /* GET */
       extendedData: { headers: { Authorization: `Bearer ${CRON_SECRET}` } } },
   ];
   ```
3. **Lookup-by-title**: GET `https://api.cron-job.org/jobs` (header `Authorization: Bearer ${CRONJOB_ORG_API_TOKEN}`). Filter `body.jobs.find(j => j.title === target.title)`.
4. Si match → PATCH `/jobs/<id>` con merge.
5. Si no match → PUT `/jobs` con body `{job: {...}}`. Capture `jobId` from response.
6. Imprime a stdout cada `jobId` + `nextExecution` (un line por job). PROHIBIDO loggear el `CRONJOB_ORG_API_TOKEN` ni `CRON_SECRET` (CD-10, CD-15, V6).
7. `fetch()` con `redirect: 'error'` (CD-18).

**PROHIBIDO** crear duplicados (CD-20).

### W4.6 — `tests/setup-cronjob.test.mjs` (NUEVO)

4 tests T-SC-01..T-SC-04 usando `cronjob-org-mock.mjs`:

| Test ID | Nombre | Mock setup | Assertion key |
|---|---|---|---|
| T-SC-01 | `create both jobs (no existing)` | cronjob-org-mock empty | 2x PUT /jobs, stdout 2 jobIds |
| T-SC-02 | `update existing (idempotent by title)` | cronjob-org-mock prefilled with title='wasiai-x402-warmup' | 1x PATCH (warmup), 1x PUT (balance-check), stdout 2 jobIds, NO duplicates |
| T-SC-03 | `idempotent re-run no duplicates` | run twice in sequence | end state has exactly 2 jobs (filter by title) |
| T-SC-04 | `slow API doesn't crash` | cronjob-org-mock slowMs=2000 | exit 0, both jobs ok |

### W4.7 — `README.md` (MODIFICAR — sección Operations runbook)

Agregar sección **"Operations runbook"** (heading H2) con sub-secciones (a..h) según AC-W4-4:

```markdown
## Operations runbook

### (a) Rotar el bearer token

\`\`\`bash
cd mcp-servers/wasiai-x402
node scripts/rotate-bearer.mjs
# Stdout: <new bearer hex 64 chars>
# Stderr: instrucciones vercel env add/rm
\`\`\`

Después de rotar:
1. `vercel env rm MCP_BEARER_TOKEN production` (valor anterior)
2. `vercel env add MCP_BEARER_TOKEN production` (paste nuevo)
3. `vercel deploy --prod` (rollout)

### (b) Refrescar sesión MCP

\`\`\`bash
node scripts/refresh-session.mjs
# Verifica que /api/mcp tools/list responde 200 con 3 tools.
\`\`\`

### (c) Alert webhook disparó — qué hacer

El alert significa balance USDC < $0.50 USDC en mainnet operator wallet.

1. Verificar balance: `node scripts/refresh-session.mjs` (smoke check).
2. Rellenar wallet: enviar USDC a operator address from exchange/faucet.
3. **NOTA CRÍTICA (CD-16)**: el alert mide SOLO USDC ERC-20. El operator también necesita AVAX para gas (no monitoreado en esta HU). Verificar manualmente con explorador.

### (d) Deshabilitar cron temporariamente

\`\`\`bash
# En cron-job.org dashboard → seleccionar job → Disable
# O via API:
curl -X PATCH https://api.cron-job.org/jobs/<jobId> \\
  -H "Authorization: Bearer $CRONJOB_ORG_API_TOKEN" \\
  -d '{"job": {"enabled": false}}'
\`\`\`

### (e) Bearer TTL

- Recomendado: rotar cada **90 días**.
- Última rotación: <FECHA — actualizar manualmente cada vez>.

### (f) Provisionar los 2 cron jobs

\`\`\`bash
export CRONJOB_ORG_API_TOKEN="<token from cron-job.org account>"
export MCP_DEPLOY_URL="https://wasiai-x402-mcp.vercel.app"
export CRON_SECRET="<the secret used in Vercel env>"
node scripts/setup-cronjob.mjs
# Imprime 2 jobIds + nextExecution
\`\`\`

### (g) Verificar status de los jobs

- Dashboard: https://cron-job.org → Jobs.
- API: `curl -H "Authorization: Bearer $CRONJOB_ORG_API_TOKEN" https://api.cron-job.org/jobs`.

### (h) Desactivar temporariamente via API

\`\`\`bash
curl -X PATCH https://api.cron-job.org/jobs/<jobId> \\
  -H "Authorization: Bearer $CRONJOB_ORG_API_TOKEN" \\
  -d '{"job": {"enabled": false}}'
\`\`\`
```

### W4 — Done Definition

- [ ] 3 scripts creados en `scripts/`.
- [ ] 7 tests passing (2 rotate + 1 refresh + 4 setup-cronjob).
- [ ] `README.md` Operations runbook con sub-secciones (a..h).
- [ ] Tests verifican que `CRONJOB_ORG_API_TOKEN` y `CRON_SECRET` NO aparecen en stdout/stderr de los scripts.

---

## 9. Wave 5 — Chaos + concurrent stress

**BLOQUEADA hasta W1+W2+W3+W4 done**. Tests cubren todos los flows nuevos.

### W5.1 — `tests/chaos.test.mjs` (NUEVO — 18 escenarios + audit)

18 tests T-CH-01..T-CH-18 + T-CH-19 (audit cross-cutting). Cada uno usa kv-mock, rpc-mock, mock fetch — **PROHIBIDO red mainnet, PROHIBIDO operator wallet real, PROHIBIDO Upstash real** (CD-7).

| Test ID | Escenario | Mock setup | Assertion key |
|---|---|---|---|
| T-CH-01 | facilitator down (5xx) | mock fetch facilitator → 503 | pay_x402 returns ok:false stage:'facilitate' (handler heredado) |
| T-CH-02 | facilitator slow (>30s) | mock fetch slowMs=30000 | timeout enforced (heredado handler) |
| T-CH-03 | gateway 502 | mock gateway → 502 | stage:'settle' fail, claim released |
| T-CH-04 | gateway redirect 302 | mock gateway → 302 to evil.com | redirect:'error' enforced (BLQ-iter3-1 sigue activo), stage error |
| T-CH-05 | Kite RPC timeout | mock Kite RPC slowMs=10000 | gracefully fails, no PK leak |
| T-CH-06 | Avalanche RPC 429 | rpc-mock rateLimit429=true | balance-guard fail-secure |
| T-CH-07 | downstream agent crash | mock downstream → ECONNREFUSED | claim released |
| T-CH-08 | KV down (balance-check) | kv-mock failNext=Infinity | balance-gate fail-secure |
| T-CH-09 | KV down (rate-limit) | kv-mock failNext=Infinity for rl: keys | rate-limit fail-open |
| T-CH-10 | KV slow | kv-mock slowMs=3000 | balance-gate latency observed but ok |
| T-CH-11 | KV stale data | kv-mock with TTL just-expired | re-fetches RPC, updates snapshot |
| T-CH-12 | partial network partition (DNS ok, conn refused) | mock fetch ECONNREFUSED | fail-secure |
| T-CH-13 | envelope replay (same nonce) | mock facilitator returns nonce reuse | handler returns ok:false (heredado) |
| T-CH-14 | insufficient balance | rpc-mock balance < threshold | balance-gate reject |
| T-CH-15 | balance read failure | rpc-mock failNext=1 | fail-secure |
| T-CH-16 | claim contention concurrent | 5 Promise.all balance-guard | INCRBY atomic, only some pass |
| T-CH-17 | claim release on failure | mock handler throws | DECRBY still called |
| T-CH-18 | claim TTL expiry | manual TTL advance | claim absent after 30s |
| T-CH-19 | alert webhook timeout | sendAlert mock slowMs=6000 | aborted via AbortSignal, log warn |
| T-CH-20 | (audit) PK / bearer / CRON_SECRET / KV token NOT in any stderr line | spy stderr across all 19 tests | AC-X-1 — never appears |

> Total: **20 tests en chaos.test.mjs** (18 escenarios + alert timeout + audit). El work-item dice "≥18" → cumplido con margen.

### W5.2 — `tests/concurrent-stress.test.mjs` (NUEVO — 1 test)

1 test T-CS-01 (cubre AC-W2-3 + AC-W5-2):

| Test ID | Nombre | Mock setup | Assertion key |
|---|---|---|---|
| T-CS-01 | `10 concurrent pay_x402 balance $0.51 threshold $0.50 amount $0.10 → exactly N pass` | rpc-mock balance=510_000n, kv-mock fresh, threshold=0.5 USDC, amount=0.1 USDC. Mock body-aware (CD-19) — route por contenido del request, NO por índice secuencial. | `Promise.all(10 calls)` results: counted (`ok===true`) + (`ok===false, stage='balance-gate', error='concurrent claim exceeded'`). Total ok ≤ floor((0.51-0.50)/0.10) = 0... pero como threshold es soft (claim < balance - threshold), lo correcto es `claimed_total <= balance - threshold` = `claimed <= 10_000n` → **0 calls pass** (no hay margen). Si quisiéramos 1 pass: balance=$0.61 + threshold=$0.50 + amount=$0.10 → 1 pass. **Architect escoge balance=$0.61 para que exactamente 1 pase** y el test sea expressivo. |

> **Refinement F2.5**: para que el test demuestre serializacion correcta y NO trivial-zero, usar `balance=610_000n (0.61), threshold=0.5, amount=100_000n (0.1)` → exactamente **1** call debe pasar el gate. Las 9 restantes responden `stage:'balance-gate', error:'concurrent claim exceeded'`. NO hay double-spend (ledger del mock muestra exactamente 1 entrada).

Mock infra requerido:
- kv-mock con INCRBY atómico (single-threaded JS garantiza atomicidad de cada call individual — V10.1.a).
- rpc-mock que retorna 610_000n consistentemente.
- handler mock que registra ledger entries.

### W5.3 — Verificación CI manual

`npm test` debe correr toda la suite — baseline 103 + nuevos:

| Wave | Tests nuevos | Acumulado |
|---|---|---|
| Baseline (WKH-65) | 103 | 103 |
| W1 (cron-auth + cron-warmup) | 9 | 112 |
| W2 (balance-guard + rate-limit + http extension) | 17 | 129 |
| W3 (alerts + cron-balance-check) | 9 | 138 |
| W4 (rotate + refresh + setup-cronjob) | 7 | 145 |
| W5 (chaos + concurrent-stress) | 21 | **166** |

**Done Definition W5**: `npm test` ≥ **158 passing** (CD-9 mínimo 128 con margen). 0 fail. 0 skip. Si algún test red, NO commitear.

> Conteo en SDD §12 dice "55 tests" + 2 (rotate/refresh) = 57. La diferencia con 63 acá viene de splits (T-CH-19 audit, T-CH-20 audit, T-CS-01 cuenta como 1 test). Architect deja el rango **57-63 tests nuevos** como aceptable; lo crítico es que cada AC esté cubierto.

---

## 10. Test plan ejecutable — 57 tests nuevos (TODO list para Dev)

| Wave | Test file | IDs | Cantidad | Mock setup canónico |
|---|---|---|---:|---|
| W1 | `tests/cron-auth.test.mjs` | T-CA-01..T-CA-05 | 5 | spy crypto.timingSafeEqual |
| W1 | `tests/cron-warmup.test.mjs` | T-WM-01..T-WM-04 | 4 | spy import(), spy fetch |
| W2 | `tests/balance-guard.test.mjs` | T-BG-01..T-BG-08 | 8 | kv-mock + rpc-mock |
| W2 | `tests/rate-limit.test.mjs` | T-RL-01..T-RL-06 | 6 | kv-mock |
| W2 | `tests/http.test.mjs` (extender) | T-HTTP-13..T-HTTP-15 | 3 | kv-mock + rpc-mock + bearer |
| W3 | `tests/alerts.test.mjs` | T-AL-01..T-AL-04 | 4 | mock fetch slow/fail/whitelist |
| W3 | `tests/cron-balance-check.test.mjs` | T-BC-01..T-BC-05 | 5 | kv-mock + rpc-mock + alert mock |
| W4 | `tests/rotate-bearer.test.mjs` | T-RB-01..T-RB-02 | 2 | spawn child + spy fs.writeFile |
| W4 | `tests/refresh-session.test.mjs` | T-RS-01 | 1 | mock fetch tools/list |
| W4 | `tests/setup-cronjob.test.mjs` | T-SC-01..T-SC-04 | 4 | cronjob-org-mock |
| W5 | `tests/chaos.test.mjs` | T-CH-01..T-CH-20 | 20 | combinaciones de mocks |
| W5 | `tests/concurrent-stress.test.mjs` | T-CS-01 | 1 | kv-mock atomic INCRBY + rpc-mock |
| **TOTAL** | | | **63** | |

> Suite total post-impl: **103 + 63 = 166 tests** (≥128 mínimo CD-9 con margen 30%).

---

## 11. Adversary Directives — para AR (post-F3)

Copia LITERAL de SDD §15. **BLOQUEANTES en AR: V1, V2, V4, V7, V8** (5 vectores).

### V1 — Balance gate bypass (BLOQUEANTE)

- V1.1: KV down al gate → ¿fail-secure (rechaza) o accidentalmente fail-open?
- V1.2: Race 10 concurrentes contra balance $0.61 + threshold $0.50 + amount $0.10 → ¿exactamente 1 pasa? (T-CS-01 valida).
- V1.3: Integer overflow `requestedWei = 2^256-1` → ¿INCRBY desborda 64-bit signed o se detecta antes?
- V1.4: Stale snapshot — cron escribió balance $5.00 hace 14 min, on-chain drenó a $0.30, gate lee snapshot stale (TTL 30 min) — ¿el gate confía solo en TTL 30s? Verificar consistencia.
- V1.5: Threshold parsing — `MCP_BALANCE_THRESHOLD_USDC=abc` o `=-0.5` → ¿reject vs default? Si pasa con default → bypass.

### V2 — Rate limit bypass (BLOQUEANTE)

- V2.1: Multi-bearers válidos del mismo operator → cada bearer hash separada (esperado), NO global limit. Documentar como assumed-trust.
- V2.2: Bearer rotation mid-flight → ¿viejo cuenta en su key, nuevo arranca a 0? Esperado: sí.
- V2.3: KV down → fail-open. Atacante DDoS sobre Upstash habilita bypass. Mitigación: monitoreo en runbook.
- V2.4: Hash collision sha256 trunc 16 (64 bits) — birthday bound ~2^32. Fuera del threat model.

### V3 — Cron endpoint unauth

- V3.1: CRON_SECRET timing attack — ¿timingSafeEqual? AR confirma código.
- V3.2: Vercel internal routing bypass — ¿query param `?token=`? Esperado: NO.
- V3.3: Sin CRON_SECRET env → ¿"auth disabled" o 500? Esperado: 500.
- V3.4: Header `Token <secret>` (no Bearer) → ¿reject? Esperado: sí.

### V4 — Webhook leak / SSRF / DoS (BLOQUEANTE)

- V4.1: PK en body. CD-12 enforced.
- V4.2: Bearer en body. CD-12 enforced.
- V4.3: Error.message exfiltration: ¿`sendAlert` cathea error y lo incluye en body? Esperado: NO (log only).
- V4.4: SSRF: `MCP_ALERT_WEBHOOK_URL=http://169.254.169.254/...` — ¿guard? Asumed-trust.
- V4.5: DoS — webhook lento bloquea cron 5s. Aceptable (CD-5).
- V4.6: redirect leak (CD-18): webhook 302 → ¿reenvía body? CD-18 cubre.

### V5 — Supply chain `@upstash/redis`

- V5.1: `npm ls @upstash/redis` audit deps transitive.
- V5.2: Postinstall scripts — `npm install --ignore-scripts` idéntico.
- V5.3: Pin version `^1.34.0` aceptable si no hay CVE conocida.
- V5.4: Plan B si Upstash deprecate la lib: `node-redis` o REST directo.

### V6 — cron-job.org token leak

- V6.1: Token en logs de `setup-cronjob.mjs` stdout/stderr.
- V6.2: Error response API puede incluir token — sanitize antes de imprimir.
- V6.3: Token commiteado a git por error — `.env.example` placeholder + `.gitignore`.

### V7 — Concurrent claim contention (BLOQUEANTE)

- V7.1: CAS revert race — INCRBY atómico pero CAS check JS no atómico — ¿2 calls leen "below threshold" antes de DECRBY-revert? Stress test demuestra.
- V7.2: Claim TTL 30s + función que corre 35s → claim expira mid-flow. Aceptable bajo CD-13.
- V7.3: `releaseClaim` después de TTL expirado → DECRBY de key inexistente → no-op. Esperado.

### V8 — Regression vs WKH-65 (BLOQUEANTE)

- V8.1: BLQ-iter2-1 (SSRF post-resolution) — sigue activo en `api/mcp.mjs`?
- V8.2: BLQ-iter3-1 (`redirect:'error'`) — todos los nuevos fetch llevan? AR audita alerts.mjs + setup-cronjob.mjs + refresh-session.mjs.
- V8.3: Cron auth ANTES de loadConfig — ¿se respeta? AR audita api/cron/* handlers.
- V8.4: T-HTTP-01..T-HTTP-12 baseline → todos pasan.
- V8.5: signature truncate 4 chars — `redact()` intacto.

### V9 — Alert webhook DoS

- V9.1: Webhook lento 29s bloquea cron 60s — cron-job.org reintenta? Duplicate alert ruido pero no inseguridad.
- V9.2: Webhook 4xx repetido — log ruidoso. Aceptable.

### V10 — Chaos test self-validation

- V10.1: Mocks ESCONDEN bugs reales? AR ejecuta y verifica:
  - (a) `kv-mock.mjs` simula INCRBY atómico — single-threaded JS sí garantiza.
  - (b) `rpc-mock.mjs` retorna `bigint` (no number) para balanceOf.
  - (c) Tests fallan si el guard real se cambia a "always allow" — sanity check.

---

## 12. Done Definition por wave (consolidado)

### W0 done

- [ ] `npm install @upstash/redis@^1.34.0` ok.
- [ ] `npm test` baseline 103 passing.
- [ ] `package.json` scripts agregados.
- [ ] `.env.example` documenta TODAS las nuevas vars.
- [ ] 3 mocks creados en `tests/_mocks/`.
- [ ] `src/kv-client.mjs` null-safe.

### W1 done

- [ ] Warmup endpoint `api/cron/warmup.mjs` con auth + module preload.
- [ ] 9 tests (5 cron-auth + 4 cron-warmup) passing.
- [ ] Tests verifican PK/CRON_SECRET no leak en logs.

### W2 done

- [ ] `src/balance-guard.mjs` + `src/rate-limit.mjs` exports completos.
- [ ] 17 tests passing (8 BG + 6 RL + 3 HTTP extension).
- [ ] `api/mcp.mjs` modificado **insert-only** según DT-J.
- [ ] T-HTTP-01..T-HTTP-12 baseline siguen passing.

### W3 done

- [ ] `src/alerts.mjs` con timeout 5s + body whitelist.
- [ ] `api/cron/balance-check.mjs` con auth + RPC + snapshot + alert.
- [ ] 9 tests passing (4 alerts + 5 cron-balance-check).
- [ ] T-AL-03 valida no-PK / no-bearer empíricamente.

### W4 done

- [ ] 3 scripts (`rotate-bearer`, `refresh-session`, `setup-cronjob`).
- [ ] 7 tests passing (2 RB + 1 RS + 4 SC).
- [ ] `README.md` Operations runbook (a..h) completo.

### W5 done

- [ ] 21 tests chaos + 1 stress passing (= 22 nuevos en W5).
- [ ] Suite total `npm test` ≥ **158 passing**, 0 fail, 0 skip.
- [ ] T-CS-01 demuestra empíricamente NO double-spend bajo concurrencia.
- [ ] T-CH-20 audit verifica AC-X-1 (no leak secrets en stderr).

---

## 13. Forbidden actions (consolidado)

- **PROHIBIDO** modificar `mcp-servers/wasiai-x402/src/{sign,auth,url-validator,handlers,config,log,index}.mjs` (CD-1).
- **PROHIBIDO** modificar `mcp-servers/wasiai-x402/vercel.json` (DT-C, cron externo).
- **PROHIBIDO** importar de `wasiai-a2a/src/` desde el sub-paquete MCP — éste es independiente.
- **PROHIBIDO** publicar a npm.
- **PROHIBIDO** mainnet calls reales en tests (CD-7 — mocks 100%).
- **PROHIBIDO** commitear `.env` real, `CRON_SECRET` real, `CRONJOB_ORG_API_TOKEN` real, `OPERATOR_PRIVATE_KEY` real.
- **PROHIBIDO** `console.log/warn/error` directo en `src/` o `api/` (CD-8 — usar `log.mjs`). Excepción: `scripts/*.mjs`.
- **PROHIBIDO** TypeScript en este sub-paquete (es .mjs ESM puro).
- **PROHIBIDO** vitest, jest, mocha — `node --test` only.
- **PROHIBIDO** `vercel deploy` desde el agente Dev. Eso lo hace el orquestador post-merge.
- **PROHIBIDO** ejecutar `node scripts/setup-cronjob.mjs` contra cron-job.org real desde el agente Dev. Eso lo hace el orquestador post-merge con el token humano (`/tmp/wkh66-cronjob-token.txt`).
- **PROHIBIDO** Lua EVAL en KV (DT-I — usar INCRBY+EXPIRE+CAS-revert).
- **PROHIBIDO** retries en alert webhook sender (CD-5).
- **PROHIBIDO** `vercel.json` `crons` array (DT-C — cron externo).
- **PROHIBIDO** `event:` dentro del payload `log.{info,warn,error}` (CD-17 — patrón recurrente).
- **PROHIBIDO** `fetch()` sin `redirect: 'error'` (CD-18).
- **PROHIBIDO** mocks secuenciales canned-responses para tests concurrentes (CD-19 — usar header/body-aware).
- **PROHIBIDO** crear duplicados en cron-job.org (CD-20 — lookup-by-title idempotente).
- **PROHIBIDO** retornar balance al cron caller body en `balance-check.mjs` (CD-21 — separación canales).
- **PROHIBIDO** `@upstash/redis` versión `*` o `latest` (CD-22).
- **PROHIBIDO** subir el plan Vercel a Pro.
- **PROHIBIDO** alert webhook body con PK / bearer / kiteTxHash / signature / raw hex sin redactar (CD-12).

---

## 14. Escalation conditions (Dev STOP + escala al orquestador)

Dev DEBE detenerse y reportar al orquestador (NO improvisar) si:

1. **`@upstash/redis` SDK version mismatch / breaking change**: si la API real de la lib instalada difiere de la documentada en este Story File (`get/set/incr/incrby/decrby/expire/ttl/del`) → STOP, reportar discrepancia.

2. **W0.7 KV no provisionado**: si `KV_REST_API_URL` no está en Vercel project — proceder con mocks 100% para tests, pero documentar en commit message que el provisioning es post-merge gate del orquestador. NO bloquear la HU por esto.

3. **Tests fallan >3 iteraciones sin avance**: si después de 3 intentos un test sigue rojo y el patrón no es claro — STOP, reportar al orquestador con: archivo:línea + mock setup + assertion que falla + hipótesis.

4. **Conflicto pre-existente en `mcp-servers/wasiai-x402/`**: si un archivo del Scope IN ya tiene cambios uncommitted del usuario o si `git status` reporta modified files no esperados — STOP, NO sobrescribir, reportar.

5. **CD-1 violation requerido por la integración**: si descubre que para implementar correctamente W2 necesita modificar `src/handlers.mjs` o `src/auth.mjs` — STOP, escalar a F2 reabierto. NO modificar core.

6. **T-CS-01 stress test FALLA bajo carga simulada** (race condition real): el INCRBY+CAS-revert no es suficiente — escalar a F2 contingencia DT-I (upgrade a Lua EVAL). Documentar el race window observado.

7. **Adversary V8 regression confirmada**: si extender `tests/http.test.mjs` rompe T-HTTP-01..T-HTTP-12 baseline — STOP, reportar regresión específica antes de seguir.

8. **CRONJOB_ORG_API_TOKEN o CRON_SECRET aparece en stdout/stderr de cualquier script**: STOP, debug leak antes de seguir. CD-15 + V6.

---

## 15. Resumen ejecutivo (para orquestador)

- **HU**: WKH-66 — Production hardening pack para `wasiai-x402` MCP en Avalanche C-Chain mainnet.
- **Branch**: `feat/071-wkh-66-prod-hardening` desde `main@7b9fc7d`.
- **Status**: `READY_FOR_F3`.
- **Archivos a crear**: **22 nuevos** (3 mocks, 5 src, 2 api/cron, 3 scripts, 9 tests).
- **Archivos a modificar**: **5** (`package.json`, `.env.example`, `api/mcp.mjs` insert-only, `tests/http.test.mjs` append-only, `README.md` append-only).
- **Total entradas de scope**: **27 archivos** (todos bajo `mcp-servers/wasiai-x402/`).
- **LOC esperadas**: ~1500-2200 LOC (incluye módulos + tests + scripts + runbook). Tests ~50% del total.
- **Tests count**: **63 nuevos** sobre baseline 103 (WKH-65) → suite total **166 passing** (mínimo CD-9: 128 → margen 30%).
- **Camino crítico**: W0 → W2.5 (`api/mcp.mjs` integration DT-J) → W5 (chaos+stress validations).
- **Bloqueantes humano**: W0.7 (Upstash provisioning) — NO bloquea Dev (mocks 100%); el orquestador maneja post-merge.
- **AR foco prioritario**: V1 (balance race), V2 (rate-limit), V4 (webhook leak), V7 (claim contention), V8 (regression WKH-65).

**Listo para `nexus-dev` arrancar Wave 0.**
