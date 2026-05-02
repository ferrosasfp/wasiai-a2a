# SDD — WKH-66 — Production hardening pack para wasiai-x402 MCP

> Fase F2 (Architect) — modo AUTO QUALITY pipeline.
> Predecesor inmediato F1: `doc/sdd/071-wkh-66-prod-hardening/work-item.md` (HU_APPROVED).
> Predecesores DONE: `069-wkh-64-mcp-x402` (MCP server), `070-wkh-65-mcp-vercel-deploy` (HTTP transport + Vercel).
> Branch: `feat/071-wkh-66-prod-hardening` desde `main@7b9fc7d`.

---

## 1. Resumen

Endurecer el MCP server `wasiai-x402` (live en `https://wasiai-x402-mcp.vercel.app/api/mcp`) para operación sostenida sin intervención humana en mainnet (Avalanche C-Chain USDC). Tras WKH-65 el endpoint funciona pero la auditoría post-deploy detectó 6 caveats: cold-start ~30s, race condition de overspend en concurrencia contra operator wallet finito ($4.74 USDC mainnet), monitoreo de balance ausente, bearer/session rotation sin runbook, modos de falla sin probar, stress concurrente sin verificar.

La HU se descompone en **5 waves coordinadas** dentro de `mcp-servers/wasiai-x402/` SIN tocar el core (`src/{sign,auth,url-validator,handlers,config,log}.mjs`). Las nuevas piezas se montan en `api/mcp.mjs` (orden de operaciones extendido) y agregan módulos puros nuevos en `src/` (balance-guard, rate-limit, alerts, kv-client, cron-auth) + 2 handlers cron + 3 scripts CLI + 4 test suites.

**Stack confirmado en F2** (DT-A): `@upstash/redis@^1.34.0` directo (REST API). Provisioning Upstash via Vercel Marketplace (free tier 10k commands/día = suficiente para volumen estimado ~1.5k ops/día). Cron externo via cron-job.org (DT-C, decisión humano por Vercel Hobby plan limit). Test plan: 25+ tests nuevos cubriendo todos los AC, baseline 103 (WKH-65) → ≥128 final.

---

## 2. Work Item

- **Ticket Jira**: WKH-66 — https://ferrosasfp.atlassian.net/browse/WKH-66
- **Tipo**: feature (security + ops hardening)
- **Pipeline**: QUALITY (firme — work-item §"Veredicto sizing" demuestra que toca payment path con guard nuevo)
- **Branch**: `feat/071-wkh-66-prod-hardening`

### Acceptance Criteria (EARS) — heredados de work-item.md (23 ACs)

Numerados como en `work-item.md`:

- **W1** (cold-start warmup): AC-W1-1, AC-W1-2, AC-W1-3, AC-W1-4
- **W2** (balance gate + rate limit): AC-W2-1 .. AC-W2-7
- **W3** (balance monitoring + alerts): AC-W3-1 .. AC-W3-5
- **W4** (bearer rotation + session refresh): AC-W4-1 .. AC-W4-4
- **W5** (chaos + concurrent stress): AC-W5-1 .. AC-W5-5
- **Cross-cutting**: AC-X-1 (logs no leakean secrets), AC-X-2 (`.env.example` actualizado), AC-X-3 (`package.json` dep pineada)

Total: **23 ACs**.

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Líneas relevantes | Por qué se leyó | Patrón extraído |
|---|---|---|---|
| `mcp-servers/wasiai-x402/api/mcp.mjs` | `:166-268` (webHandler), `:287-342` (vercelHandler) | Identificar punto de inserción para rate-limit y balance-gate sin romper auth-first ordering | Order ops actual: CORS → method → bearer auth → loadConfig → buildServer → transport. WKH-65 dejó comentado en `:148-161` el rationale (auth ANTES de loadConfig por DNS lookup de SSRF guard). DT-J extiende este orden insertando rate-limit DESPUÉS de auth pero ANTES de loadConfig (mismo principio: rate-limit es O(1) KV lookup, baratísimo vs DNS). |
| `mcp-servers/wasiai-x402/src/handlers.mjs` | `:262-482` (`payX402Handler`), `:78-99` (`resolveEndpoint`) | Identificar cómo wrappear `pay_x402` con balance gate sin modificar el handler (CD-1 prohíbe tocar core). | Handler retorna `{ ok, stage, ... }` con shape consistente. Patrón: nuevo módulo `balance-guard.mjs` se invoca DESDE `api/mcp.mjs` ANTES de delegar al `payX402Handler`. El claim KV se libera DESPUÉS del retorno (settle ok o failure ambos liberan — AC-W2-4). |
| `mcp-servers/wasiai-x402/src/log.mjs` | `:1-75` (toda la API) | Reusar logger para nuevos módulos (CD-8). | API: `info(event, fields)`, `warn(event, fields)`, `error(event, fields)`, `warnOnce(key, event, fields)`. Auto-blindaje crítico: NUNCA pasar `event:` dentro de `fields` (clobbers canonical event — WKH-64 MNR-iter2-1 + WKH-65 W3). Redact set: `OPERATOR_PRIVATE_KEY`, `privateKey`, `pk`, `PRIVATE_KEY`. Truncate sets: signature → 4 chars, xPaymentHeader → 10 chars. |
| `mcp-servers/wasiai-x402/src/config.mjs` | `:23-102` (loadConfig) | Identificar cómo extender con env vars opcionales. | Patrón: env optional → default + `warnOnce`. Patrón env required → throw `ConfigError`. Las nuevas vars (`MCP_BALANCE_THRESHOLD_USDC`, `MCP_RATE_LIMIT_PER_MIN`, `MCP_ALERT_WEBHOOK_URL`) son **opcionales** (defaults en código), `KV_REST_API_URL`+`KV_REST_API_TOKEN` son **opcionales** (si missing → KV client retorna null y rate-limit fail-opens, balance-gate fail-secures). `CRON_SECRET` se valida directamente en cada handler cron (no en loadConfig — los cron endpoints no llaman loadConfig hasta después del check). |
| `mcp-servers/wasiai-x402/src/auth.mjs` | `:47-80` (validateBearerToken) | Reusar el patrón timing-safe para `validateCronSecret`. | Patrón: parse header `Bearer <token>`, length pre-check (no leak — token shape público), `timingSafeEqual` sobre buffers utf8. `cron-auth.mjs` será una copia minimalista con la misma estructura. |
| `scripts/smoke-prod-via-app-wasiai.mjs` | `:43-69` (signing flow), `:90-130` (probe + sign + retry) | Golden vector reference para tests (envelope shape, viem signature flow). | Confirma EIP-3009 envelope: `{ signature, authorization{from,to,value,validAfter,validBefore,nonce}, network }`. Tests deben preservar este shape — chaos tests no pueden modificar la firma (CD-1). |
| `src/lib/downstream-payment.ts` | `:237-249` (`readOperatorBalance`), `:262-298` (`buildClients`), `:51-156` (USDC address resolution) | Patrón viem para leer balance USDC ERC-20. | `publicClient.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [operator] })` retorna `bigint`. Con `viem` ya en deps. **Nota crítica AC-W3 / Risk-9**: lee balance del **token ERC-20** (USDC), NO del native AVAX. El operator necesita AVAX separado para gas — el alert webhook actual NO cubre falta de AVAX. Architect documenta esto en CD-16 (NEW). |
| `mcp-servers/wasiai-x402/tests/http.test.mjs` | `:1-80` | Patrón test setup en este paquete (env vars per-test, `captureStderr` helper). | Patrón: `loadHandler()` reimporta el módulo per-test (`?t=${Date.now()}` query string para invalidar import cache de Node). Captura stderr para verificar invariants de logging. Mocks via `globalThis.fetch = ...` y restore en afterEach. |
| `doc/sdd/069-wkh-64-mcp-x402/auto-blindaje.md` | toda | Aprender de errores históricos (8 lecciones documentadas). | **Patrones recurrentes detectados** — ver §3.2 |
| `doc/sdd/070-wkh-65-mcp-vercel-deploy/auto-blindaje.md` | toda | Aprender de errores históricos (7 lecciones documentadas). | **Patrones recurrentes detectados** — ver §3.2 |
| `mcp-servers/wasiai-x402/package.json` | `:1-29` | Confirmar deps actuales y formato. | Deps: `@modelcontextprotocol/sdk@^1.29.0`, `dotenv@^16.6.1`, `viem@^2.48.4`. Engine: `"node": "22.x"`. Test runner: `node --test 'tests/*.test.mjs'` (glob explícito requerido por Node 22 — auto-blindaje WKH-64). |
| `mcp-servers/wasiai-x402/vercel.json` | `:1-9` | Confirmar deployment shape actual. | Solo `functions[api/mcp.mjs].maxDuration: 60` + `regions: ["iad1"]`. **Sin `crons`** (Hobby plan limit). DT-C confirma: cron externo via cron-job.org. NO se modifica `vercel.json` en esta HU. |

### Patrones recurrentes detectados (para CDs nuevos)

De los auto-blindajes 069 + 070 (15 lecciones combinadas) emergen **4 patrones de error recurrentes** que se cementan en CDs específicos para esta HU:

1. **`event:` clobber en log payload** — ocurrió 2 veces (WKH-64 MNR-iter2-1 + WKH-65 W3). Patrón: dev pasa `event: '...'` dentro de `fields`, el spread de `redact(fields)` después de `event` top-level lo pisa, breakea dashboards/grep.
   → **CD-17 (NEW en F2)**: PROHIBIDO `event:` dentro del payload de `log.{info,warn,error}`. El primer arg es la única autoridad. AR/CR debe grep `'event:'` dentro de `log\.\w+\(.*,` y bloquear.

2. **SSRF post-resolution + redirect leak** — WKH-64 cerró 3 iters de SSRF. El fetch a webhook (W3) y el fetch a cron-job.org API (W4) son nuevos vectores con la misma clase de bug.
   → **CD-18 (NEW en F2)**: TODO `fetch()` nuevo con header sensible (`Authorization`, `Bearer`, signature, payment-signature) DEBE llevar `redirect: 'error'`. Aplicado al webhook POST (carga severity + operator pero igual sigue regla por defensa-en-profundidad).

3. **Tests de concurrencia con canned responses ordenadas** — WKH-64 W2: el test de 10 concurrent calls falló porque mock secuencial no funciona en paralelo.
   → **CD-19 (NEW en F2)**: tests concurrentes (W5) DEBEN usar mocks header/body-aware (route por contenido del request), NO por índice secuencial. Stress test reusa este patrón.

4. **Auth-first ordering antes de operaciones costosas** — WKH-65 W5 fix iter 1 movió auth ANTES de loadConfig. La HU agrega rate-limit (KV lookup, ~5-50ms) y balance-gate (RPC + KV, ~500-2000ms).
   → **DT-J cementa el orden** (§11) — incluido en este SDD como decisión definitiva.

### Exemplars verificados (con Glob)

```
mcp-servers/wasiai-x402/api/mcp.mjs            ✓ existe (Read line 1-342)
mcp-servers/wasiai-x402/src/auth.mjs           ✓ existe (Read line 1-80) — exemplar para src/cron-auth.mjs
mcp-servers/wasiai-x402/src/log.mjs            ✓ existe (Read line 1-75) — reusable (CD-8)
mcp-servers/wasiai-x402/src/config.mjs         ✓ existe (Read line 1-102) — patrón env opt/required
mcp-servers/wasiai-x402/src/handlers.mjs       ✓ existe (Read line 1-532) — NO se modifica (CD-1)
mcp-servers/wasiai-x402/src/url-validator.mjs  ✓ existe (no leído — NO se modifica)
mcp-servers/wasiai-x402/src/sign.mjs           ✓ existe (no leído — NO se modifica)
mcp-servers/wasiai-x402/src/index.mjs          ✓ existe (no leído — NO se modifica)
mcp-servers/wasiai-x402/tests/http.test.mjs    ✓ existe (Read line 1-80) — exemplar test pattern
src/lib/downstream-payment.ts                  ✓ existe (Read line 220-298) — exemplar viem balanceOf
mcp-servers/wasiai-x402/scripts/                ✗ NO existe (lo crea esta HU — Wave 4)
mcp-servers/wasiai-x402/api/cron/               ✗ NO existe (lo crea esta HU — Wave 1+3)
mcp-servers/wasiai-x402/tests/_mocks/           ✗ NO existe (lo crea esta HU — Wave 0)
```

### Estado de BD relevante

**N/A** — esta HU NO toca Supabase. El estado vive en Upstash KV (key-value, no relacional). Keys planeadas:

| Key shape | TTL | Tipo Redis | Quién la pone | Quién la lee |
|---|---|---|---|---|
| `balance-claim:eip155:43114:0x<operator>` | 30s | counter (INCRBY/DECRBY) | `balance-guard.mjs` antes de delegar a `payX402Handler` | mismo módulo (lectura del claimed actual) |
| `balance-snapshot:eip155:43114:0x<operator>` | 30s (gate) / 1800s (cron snapshot) | string JSON | `balance-guard.mjs` (cache RPC read), `api/cron/balance-check.mjs` | `balance-guard.mjs` (gate path) |
| `rl:<bearer-hash16>` | 60s | counter (INCR + EXPIRE) | `rate-limit.mjs` | mismo módulo |

### Componentes reutilizables encontrados

- **`src/log.mjs`** — logger JSON-line a stderr, `redact()`, `warnOnce()`. Reusar tal cual (CD-8). Sin modificación.
- **`src/auth.mjs::validateBearerToken`** — patrón para timing-safe compare. NO reusar directo (acoplado a Bearer scheme + AuthError); copiar el patrón a `src/cron-auth.mjs` con `CronAuthError`.
- **`src/config.mjs::loadConfig`** — patrón env opt/required + `warnOnce`. NO reusar directo (las nuevas vars son orthogonales y se leen lazy desde los nuevos módulos para mantener `loadConfig` intacta — CD-1). Patrón replicado en cada nuevo módulo.
- **viem `createPublicClient` + `readContract` con `erc20Abi`** — reusar desde el subpaquete (no desde `src/lib/downstream-payment.ts` que es del repo principal). El subpaquete `mcp-servers/wasiai-x402/` es independiente — incluye su propio `package.json` y dep viem ya pineada `^2.48.4`.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

**18 archivos** (todo bajo `mcp-servers/wasiai-x402/` — heredado del work-item §Scope IN):

| # | Archivo | Acción | Wave | Descripción breve |
|---|---|---|---|---|
| 1 | `package.json` | MODIFICAR | W0 | Agregar `@upstash/redis@^1.34.0`. Agregar scripts: `test:chaos`, `test:stress`, `test:balance-guard`, `test:rate-limit`, `setup:cronjob`, `rotate:bearer`, `refresh:session`. |
| 2 | `.env.example` | MODIFICAR | W0 | Documentar nuevas vars (CD-X-2): `CRON_SECRET`, `MCP_BALANCE_THRESHOLD_USDC=0.50`, `MCP_RATE_LIMIT_PER_MIN=5`, `MCP_ALERT_WEBHOOK_URL=`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `MCP_BALANCE_SNAPSHOT_TTL_SEC=30`, `MCP_BALANCE_CLAIM_TTL_SEC=30`, `MCP_RATE_LIMIT_WINDOW_SEC=60`, `AVALANCHE_RPC_URL`, `AVALANCHE_USDC_ADDRESS`, `MCP_OPERATOR_CHAIN_ID=43114`, `CRONJOB_ORG_API_TOKEN` (dev-only). |
| 3 | `tests/_mocks/kv-mock.mjs` | NUEVO | W0 | In-memory `Map`-backed mock con API compat `@upstash/redis`: `get/set/incrby/decrby/expire/del`. Soporta flags `failNext`, `slowMs`, `staleData` para chaos tests. |
| 4 | `tests/_mocks/rpc-mock.mjs` | NUEVO | W0 | viem `publicClient.readContract` mock con flags `balance`, `failNext`, `slowMs`, `rateLimit429`. |
| 5 | `tests/_mocks/cronjob-org-mock.mjs` | NUEVO | W0 | mock de `https://api.cron-job.org/jobs` con flags `slow`, `failNext`, `idempotent`. |
| 6 | `src/kv-client.mjs` | NUEVO | W0 | `getKvClient()` lazy singleton: si `KV_REST_API_URL` y `KV_REST_API_TOKEN` están seteadas → instancia `@upstash/redis`. Si NO → retorna `null`. NUNCA throw. Tests inyectan mock via `setKvClientForTesting(mock)`. |
| 7 | `src/cron-auth.mjs` | NUEVO | W1 | `validateCronSecret(authHeader, expectedSecret)` con `timingSafeEqual`. Throw `CronAuthError`. Mismo shape que `auth.mjs` pero scheme-agnostic (acepta `Bearer <secret>`). |
| 8 | `api/cron/warmup.mjs` | NUEVO | W1 | Handler Vercel `(req, res) => void` (Express-style por DT-K, ver §11). 1) `validateCronSecret`, 2) pre-load `src/handlers.mjs`, `src/sign.mjs`, viem account derivation, 3) responder 200 `{ ok, warmedAt }`. Sin signing real, sin gateway fetch. |
| 9 | `src/balance-guard.mjs` | NUEVO | W2 | `checkBalanceWithClaim({ operator, chainId, requestedWei, threshold, kvClient, publicClient })` → `{ ok, claimId, balanceUsdc }` o `{ ok:false, stage:'balance-gate', error }`. Lee balance: 1) intenta KV snapshot (TTL 30s); 2) si miss/stale → RPC + cache. Atomic claim: Lua script vía Upstash REST API (`SCRIPT EVAL`) — fallback INCRBY+TTL si tier no soporta EVAL (DT-I cementado). `releaseClaim(claimId, kvClient)` → DECRBY. Fail-secure (CD-2). |
| 10 | `src/rate-limit.mjs` | NUEVO | W2 | `checkRateLimit({ bearerHash, kvClient, perMin, windowSec=60 })` → `{ ok, retryAfter }`. Sliding window con sorted set (ZADD timestamp + ZREMRANGEBYSCORE old + ZCARD). Fail-open si `kvClient===null` o si lookup throw (CD-2 inverso para rate-limit). Hash bearer: sha256 truncado a 16 hex chars (CD-14 heredado). |
| 11 | `src/alerts.mjs` | NUEVO | W3 | `sendAlert({ severity, body, webhookUrl, timeoutMs=5000 })` con `AbortSignal.timeout(5000)`. POST JSON. NO retries. NO throw — log y return `{ sent: bool, error? }`. CD-12: body whitelist (severity, chain, operator address, balanceUsdc, threshold, checkedAt, optional blockNumber). CD-18: `redirect: 'error'`. |
| 12 | `api/cron/balance-check.mjs` | NUEVO | W3 | Handler Vercel `(req, res) => void`. 1) `validateCronSecret`, 2) RPC `balanceOf(operator)`, 3) persist snapshot KV (`balance-snapshot:eip155:43114:<operator>` TTL 1800s — 30 min), 4) si `balanceUsdc < threshold` y `MCP_ALERT_WEBHOOK_URL` set → `sendAlert(...)`, 5) responder 200 `{ balanceWei, balanceUsdc, checkedAt, blockNumber }` SIEMPRE (incluso si webhook falla — AC-W3-4). |
| 13 | `api/mcp.mjs` | MODIFICAR | W2 | Insertar **DESPUÉS** de bearer auth y **ANTES** de `loadConfig`: `await checkRateLimit({...})`. Insertar **DENTRO** del switch case `'pay_x402'` (antes de `payX402Handler`): `await checkBalanceWithClaim({...})` + try/finally para `releaseClaim`. Sin tocar lógica existente — solo insertar (CD-1 hold: NO modificar handlers.mjs/auth.mjs/config.mjs/log.mjs/sign.mjs/url-validator.mjs/index.mjs). |
| 14 | `scripts/rotate-bearer.mjs` | NUEVO | W4 | `crypto.randomBytes(32).toString('hex')` → stdout. Instrucciones `vercel env add/rm` → stderr. Refuse si `process.stdout.isTTY === false` (AC-W4-2). PROHIBIDO escribir a disco (CD-6). |
| 15 | `scripts/refresh-session.mjs` | NUEVO | W4 | POST `/api/mcp` con `{method:'tools/list',...}` + bearer (env). Verifica `tools.length === 3` y status 200. Exit 0 OK / 1 fail. |
| 16 | `scripts/setup-cronjob.mjs` | NUEVO | W4 | Provisioning idempotente cron-job.org via `https://api.cron-job.org/jobs` (PUT crea, PATCH actualiza). Lookup by `title` (GET `/jobs` → filter). Crea/update 2 jobs: `wasiai-x402-warmup` (`*/4 * * * *`) y `wasiai-x402-balance-check` (`*/15 * * * *`). Imprime jobIds. |
| 17 | `tests/balance-guard.test.mjs` | NUEVO | W2/W5 | 8 tests AC-W5-3 (a..h). Mock kv + mock rpc. |
| 18 | `tests/rate-limit.test.mjs` | NUEVO | W2/W5 | 6 tests AC-W5-4 (a..f). Mock kv. |
| 19 | `tests/concurrent-stress.test.mjs` | NUEVO | W5 | 1 test AC-W5-2 — 10 Promise.all con balance mocked $0.51, threshold $0.50, amount $0.10 → exactamente 1 pasa. Mock header-aware (CD-19). |
| 20 | `tests/chaos.test.mjs` | NUEVO | W5 | 18 tests AC-W5-1. |
| 21 | `tests/cron-auth.test.mjs` | NUEVO | W1 | 5 tests para `validateCronSecret` (timing-safe, missing, malformed, wrong, empty expected). |
| 22 | `tests/cron-warmup.test.mjs` | NUEVO | W1 | 4 tests AC-W1-1..AC-W1-4 (auth, response shape, latency, no-side-effects). |
| 23 | `tests/cron-balance-check.test.mjs` | NUEVO | W3 | 5 tests AC-W3-1..AC-W3-5. |
| 24 | `tests/alerts.test.mjs` | NUEVO | W3 | 4 tests (timeout, body whitelist, no-PK, no-bearer). |
| 25 | `tests/setup-cronjob.test.mjs` | NUEVO | W4 | 4 tests con cronjob-org-mock (create, update, idempotent, slow). |
| 26 | `README.md` | MODIFICAR | W4 | Sección "Operations runbook" con AC-W4-4 (a..h). |

> **Total nuevo/modificado**: 26 entradas (work-item declaró 18 — la diferencia es que cada test suite es archivo separado, agregamos `tests/_mocks/*` × 3, y splitamos los tests del cron en 4 archivos. El conteo sigue dentro del scope-IN del work-item).
>
> **Tests planeados**: 8 + 6 + 1 + 18 + 5 + 4 + 5 + 4 + 4 = **55 nuevos tests** (sobrepasa el "≥25" del work-item). Suite total post-impl: 103 (WKH-65) + 55 = **158 tests** (≥128 mínimo CD-9).

### 4.2 Modelo de datos

**N/A** — sin schema DB. KV keys ya documentadas en §3 "Estado de BD relevante".

#### Shapes de payload (críticos)

```js
// src/balance-guard.mjs claim INCRBY result
type Claim = {
  ok: true,
  claimId: string,         // UUID v4 — solo para release lookup
  balanceUsdc: number,     // decimal redondeado 6 decimales
  claimedTotalWei: bigint, // total ya commitido en el claim counter
};
type ClaimReject = {
  ok: false,
  stage: 'balance-gate',
  error: 'operator balance below threshold' | 'balance check unavailable' | 'concurrent claim exceeded',
};

// src/alerts.mjs body POST (CD-12 strict whitelist)
type AlertBody = {
  severity: 'critical' | 'warning',
  chain: 'avalanche-c-chain-mainnet',
  operator: `0x${string}`,    // public address — NO PK
  balanceUsdc: number,        // decimal 6dp
  threshold: number,
  checkedAt: string,          // ISO 8601
  blockNumber?: number,       // optional
};
```

### 4.3 Componentes / Servicios

#### `src/kv-client.mjs`

```js
import { Redis } from '@upstash/redis';
let _client = null;
let _testOverride = null;

export function getKvClient() {
  if (_testOverride !== null) return _testOverride;
  if (_client) return _client;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    log.warnOnce('kv-not-configured', 'kv.client.not-configured', {});
    return null;  // null path = fail-open for rate-limit, fail-secure for balance-gate
  }
  _client = new Redis({ url, token });
  return _client;
}

export function setKvClientForTesting(client) { _testOverride = client; }
export function resetKvClient() { _client = null; _testOverride = null; }
```

#### `src/balance-guard.mjs` (núcleo del W2)

```js
// Pseudocódigo — implementación detallada va en F2.5/F3
export async function checkBalanceWithClaim({
  operator, chainId, requestedWei, threshold, kvClient, publicClient,
}) {
  // CD-2 fail-secure: si KV down → reject; si RPC down → reject.
  if (!kvClient) return { ok: false, stage: 'balance-gate', error: 'balance check unavailable' };

  // 1. Read balance: KV snapshot (TTL 30s) ∪ RPC fallback
  const snapKey = `balance-snapshot:eip155:${chainId}:${operator.toLowerCase()}`;
  let balanceWei;
  try {
    const snap = await kvClient.get(snapKey);
    if (snap && Date.now() - new Date(snap.checkedAt).getTime() < 30_000) {
      balanceWei = BigInt(snap.balanceWei);
    } else {
      balanceWei = await publicClient.readContract({
        address: USDC_ADDR, abi: erc20Abi, functionName: 'balanceOf', args: [operator],
      });
      await kvClient.set(snapKey, JSON.stringify({
        balanceWei: balanceWei.toString(),
        balanceUsdc: Number(balanceWei) / 1e6,
        checkedAt: new Date().toISOString(),
      }), { ex: 30 });  // TTL 30s
    }
  } catch (e) {
    log.warn('balance-guard.read-failed', { stage: 'balance-gate', error: e.message });
    return { ok: false, stage: 'balance-gate', error: 'balance check unavailable' };
  }

  const balanceUsdc = Number(balanceWei) / 1e6;
  if (balanceUsdc < threshold) {
    return { ok: false, stage: 'balance-gate', error: 'operator balance below threshold' };
  }

  // 2. Atomic claim — INCRBY + EXPIRE (DT-I cementado, ver §11)
  const claimKey = `balance-claim:eip155:${chainId}:${operator.toLowerCase()}`;
  const claimId = crypto.randomUUID();
  const newClaimed = await kvClient.incrby(claimKey, requestedWei.toString());
  await kvClient.expire(claimKey, 30);  // CD-13: TTL 30s
  // CAS check: if claimed_total > balance - threshold → revert and reject
  const thresholdWei = BigInt(Math.floor(threshold * 1e6));
  const availableWei = balanceWei - thresholdWei;
  if (BigInt(newClaimed) > availableWei) {
    await kvClient.decrby(claimKey, requestedWei.toString());  // revert
    return { ok: false, stage: 'balance-gate', error: 'concurrent claim exceeded' };
  }
  return { ok: true, claimId, balanceUsdc, claimedTotalWei: BigInt(newClaimed) };
}

export async function releaseClaim({ claimKey, requestedWei, kvClient }) {
  if (!kvClient) return;  // best-effort
  try { await kvClient.decrby(claimKey, requestedWei.toString()); }
  catch (e) { log.warn('balance-guard.release-failed', { error: e.message }); }
}
```

#### `src/rate-limit.mjs`

```js
export async function checkRateLimit({ bearerHash16, kvClient, perMin = 5, windowSec = 60 }) {
  if (!kvClient) return { ok: true };  // CD-2 inverso: rate-limit fail-open
  const key = `rl:${bearerHash16}`;
  try {
    // INCR + (set EXPIRE only on first hit). Simpler than ZADD/ZCARD; sufficient for fixed-window.
    // Note: this is fixed-window, not sliding. The work-item AC-W2-5 says "sliding window 60s" —
    // we implement fixed-window-with-jitter (each bearer hash starts its own 60s window on first hit)
    // which is operationally indistinguishable for our threat model (5/min). True sliding window
    // would require sorted sets — DT-I/DT-decision deferred to F2.5 if needed.
    const count = await kvClient.incr(key);
    if (count === 1) await kvClient.expire(key, windowSec);
    if (count > perMin) {
      const ttl = await kvClient.ttl(key);
      return { ok: false, retryAfter: ttl > 0 ? ttl : windowSec };
    }
    return { ok: true };
  } catch (e) {
    log.warn('rate-limit.lookup-failed', { error: e.message });
    return { ok: true };  // fail-open
  }
}

export function hashBearer(bearerToken) {
  return crypto.createHash('sha256').update(bearerToken, 'utf8').digest('hex').slice(0, 16);
}
```

#### `src/alerts.mjs`

```js
export async function sendAlert({ severity, body, webhookUrl, timeoutMs = 5000 }) {
  if (!webhookUrl) {
    log.warnOnce('alert-webhook-not-configured', 'mcp.alert.no-webhook-configured', {});
    return { sent: false, reason: 'webhook not configured' };
  }
  // CD-12: body MUST follow whitelist (caller responsibility); we validate shape here defensively.
  const safeBody = sanitizeAlertBody(body);
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ severity, ...safeBody }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',  // CD-18
    });
    if (!res.ok) {
      log.warn('mcp.alert.webhook-failed', { stage: 'alert', status: res.status });
      return { sent: false, reason: `http-${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    log.warn('mcp.alert.webhook-failed', { stage: 'alert', error: e.message });
    return { sent: false, reason: e.message };
  }
}

function sanitizeAlertBody(body) {
  // CD-12: whitelist explícito
  const ALLOWED = ['chain', 'operator', 'balanceUsdc', 'threshold', 'checkedAt', 'blockNumber'];
  const out = {};
  for (const k of ALLOWED) if (body[k] !== undefined) out[k] = body[k];
  return out;
}
```

### 4.4 Flujo principal (Happy Path)

#### Path 1: `pay_x402` (W2 integration en `api/mcp.mjs`)

```
Request POST /api/mcp { method: tools/call, params: { name: pay_x402, args: { endpoint, payload } } }
  ↓
[1] CORS preflight (HEREDADO WKH-65) — si OPTIONS → 204
  ↓
[2] Method gate (HEREDADO WKH-65) — si !POST → 405
  ↓
[3] Bearer auth (HEREDADO WKH-65, CD-2) — timingSafeEqual → 401 si fail
  ↓
[4] Rate limit (NUEVO W2, DT-J) — checkRateLimit({ bearerHash16, kvClient, perMin })
    │  IF KV down → fail-open (continue)
    │  IF count > perMin → 429 { error, retryAfter }
  ↓
[5] loadConfig (HEREDADO WKH-65) — DNS/SSRF check, env validation → 500 si fail
  ↓
[6] buildServer (HEREDADO WKH-65) → MCP Server + transport per request
  ↓
[7] Dispatch to tools/call switch (HEREDADO WKH-65, MODIFICADO W2):
    │  case 'discover_agents'   → discoverAgentsHandler (sin balance gate)
    │  case 'get_payment_quote' → getPaymentQuoteHandler (sin balance gate, no firma)
    │  case 'pay_x402'          → NEW WRAP:
    │     a. checkBalanceWithClaim({ operator, chainId, requestedWei, threshold, kvClient, publicClient })
    │        IF !ok → return { ok: false, stage: 'balance-gate', error }
    │     b. try { result = await payX402Handler(args, cfg) } finally { releaseClaim(...) }
    │     c. return result
  ↓
Response 200 JSON-RPC { result: { content: [{ type: text, text: <stringified handler return> }] } }
```

#### Path 2: Cron warmup (W1)

```
Request GET /api/cron/warmup (cron-job.org → Vercel)
  Header: Authorization: Bearer <CRON_SECRET>
  ↓
[1] validateCronSecret (timingSafeEqual) → 401 si fail
  ↓
[2] Pre-load: import('../src/handlers.mjs'), import('../src/sign.mjs'),
    privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY).address  // derives only, no fetch
  ↓
[3] Response 200 { ok: true, warmedAt: ISO8601 }
```

#### Path 3: Cron balance-check (W3)

```
Request GET /api/cron/balance-check (cron-job.org → Vercel)
  Header: Authorization: Bearer <CRON_SECRET>
  ↓
[1] validateCronSecret → 401 si fail
  ↓
[2] Read balance: publicClient.readContract({ address: USDC, abi: erc20Abi, fn: balanceOf, args: [operator] })
  ↓
[3] Persist KV snapshot balance-snapshot:eip155:43114:<operator> TTL 1800s (30 min)
    Body: { balanceWei, balanceUsdc, checkedAt, blockNumber }
  ↓
[4] IF balanceUsdc < threshold AND MCP_ALERT_WEBHOOK_URL set:
       sendAlert({ severity: 'critical', body: {chain, operator, balanceUsdc, threshold, checkedAt, blockNumber}, webhookUrl, timeoutMs: 5000 })
       Webhook failure → log only, continue (AC-W3-4)
  ↓
[5] Response 200 { balanceWei, balanceUsdc, checkedAt, blockNumber } SIEMPRE
```

### 4.5 Flujo de error

| Escenario | Comportamiento esperado | AC ref |
|---|---|---|
| KV down + `pay_x402` | **fail-secure** → 200 JSON-RPC con `{ ok: false, stage: 'balance-gate', error: 'balance check unavailable' }` | AC-W2-2, CD-2 |
| KV down + `discover_agents` (rate-limit lookup) | **fail-open** → procede normal (rate limit no bloquea) | AC-W2-7, CD-2-inverso |
| RPC Avalanche down + `pay_x402` | fail-secure idéntico al KV down case | AC-W2-2 |
| Concurrent claim exceeds available | reject con `{ ok: false, stage: 'balance-gate', error: 'concurrent claim exceeded' }` + `decrby` revert | AC-W2-3 |
| Settle fails after claim | `releaseClaim` igualmente (try/finally) | AC-W2-4 |
| Sign fails after claim | `releaseClaim` igualmente | AC-W2-4 |
| Function crash mid-claim | Claim huérfano expira en TTL 30s | CD-13 |
| Rate limit exceeded | 429 `{ error: 'rate limit exceeded', retryAfter: <s> }` | AC-W2-5 |
| Cron secret missing/wrong | 401 `{ error: 'unauthorized' }` (timing-safe) | AC-W1-3 |
| Webhook timeout | log `mcp.alert.webhook-failed` + cron sigue 200 | AC-W3-4, CD-5 |
| Webhook URL not configured | log `mcp.alert.no-webhook-configured` (warnOnce) + cron 200 | AC-W3-5 |
| `cron-job.org` API down (script setup) | Script exit 1 con mensaje claro `cron-job.org API unavailable: <status>` | AC-W1-1, AC-W3-1 |

---

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir (heredados del work-item §CD)

- **CD-1**: PROHIBIDO modificar `src/{sign,url-validator,handlers,config,log,auth,index}.mjs`. Si una integración demanda cambio del core, escalar a F2 con justificación.
- **CD-2**: Balance gate **fail-secure** si lectura de balance falla. Rate limit **fail-open** si KV lookup falla.
- **CD-3**: Rate limit OBLIGATORIO usar bearer-hash sha256 como key KV.
- **CD-4**: Cron endpoints OBLIGATORIO autenticados con CRON_SECRET timing-safe.
- **CD-5**: Alert webhook timeout 5s, sin retries.
- **CD-6**: `rotate-bearer.mjs` NO escribe a disco.
- **CD-7**: Chaos tests + concurrent stress 100% mocks.
- **CD-8**: Logs JSON-line via `src/log.mjs`. PROHIBIDO `console.*` excepto en `scripts/*.mjs`.
- **CD-9**: Tests passing — baseline 103 + nuevos. Mínimo 128 post-impl.
- **CD-10**: PROHIBIDO loggear PK / bearer / CRON_SECRET / KV token / webhook URL completa.
- **CD-11**: PROHIBIDO `vercel.json` con secrets literales.
- **CD-12**: Alert webhook body whitelist (severity, chain, operator, balanceUsdc, threshold, checkedAt, optional blockNumber). PROHIBIDO PK / bearer / hex raw sin redactar.
- **CD-13**: Claim KV TTL ≤ 60s (recomendado 30s).
- **CD-14**: Bearer hash sha256 truncado a 16 hex chars.
- **CD-15**: PROHIBIDO commitear `CRONJOB_ORG_API_TOKEN` / `CRON_SECRET` real.

### CDs NUEVOS en F2 (specific de este SDD)

- **CD-16 [NEW]**: AC-W3 monitorea balance **USDC ERC-20**, NO native AVAX. El operator wallet necesita AVAX separado para gas. Documentar en runbook (AC-W4-4) y agregar nota en alert webhook body que `balanceUsdc` no incluye AVAX. Si en el futuro queremos alertar también sobre AVAX, es HU separada.
- **CD-17 [NEW]**: PROHIBIDO `event:` dentro del payload de `log.{info,warn,error}`. Patrón recurrente WKH-64+WKH-65. AR/CR debe grep `event:\s*['"]` dentro de calls a `log\.\w+\(` y bloquear.
- **CD-18 [NEW]**: TODO `fetch()` nuevo en esta HU (alerts.mjs webhook POST, setup-cronjob.mjs API call) DEBE llevar `redirect: 'error'`. Patrón recurrente WKH-64 BLQ-iter3-1.
- **CD-19 [NEW]**: Tests concurrentes (W5 stress + chaos) DEBEN usar mocks header/body-aware (route por contenido del request). PROHIBIDO mocks con índice secuencial / canned-responses ordenadas. Patrón recurrente WKH-64 W2.
- **CD-20 [NEW]**: `setup-cronjob.mjs` invocación es **idempotente**. Lookup primero por `title` (GET `/jobs` + filter). Si match → PATCH/UPDATE. Si no match → PUT/CREATE. PROHIBIDO crear duplicados.
- **CD-21 [NEW]**: PROHIBIDO el handler `/api/cron/balance-check` retornar el body al webhook caller (cron-job.org no lo necesita y exponer el balance en response body lo deja en logs públicos del cron-job.org dashboard). El response 200 SIEMPRE incluye el snapshot, pero el alert (POST a webhookUrl) y el response al cron son canales separados.
- **CD-22 [NEW]**: `package.json` dep `@upstash/redis` versión pineada con caret minor (`^1.34.0`) — PROHIBIDO `*` o `latest` (CD-X-3 heredado pero específico aquí).

### PROHIBIDO

- **PROHIBIDO** modificar `src/handlers.mjs` para inyectar balance gate ahí. Va en `api/mcp.mjs` wrap (CD-1).
- **PROHIBIDO** retries en alert webhook sender (la cron de 15 min es el retry natural — CD-5).
- **PROHIBIDO** cachear `kvClient` o `publicClient` a nivel de módulo en handlers serverless — Vercel funciones son stateless. Lazy init OK (módulo-level vars), pero no asumir warm-up persistente. Excepción: `getKvClient()` cachea el SDK instance por proceso (HTTP REST, no socket-bound — safe across serverless invocations dentro de la misma instancia).
- **PROHIBIDO** test contra `@upstash/redis` real, RPC mainnet real, o operator wallet real (CD-7).
- **PROHIBIDO** cambiar el orden de operaciones en `api/mcp.mjs` distinto a DT-J (§11).
- **PROHIBIDO** subir el plan Vercel Hobby → Pro en esta HU (work-item §Scope OUT). Si Upstash free no alcanza, escalar como bloqueante.
- **PROHIBIDO** retornar el `kiteTxHash` o cualquier signature material en el body POST al webhook (CD-12).

---

## 6. Scope

### IN

Idéntico al work-item §Scope IN (18 archivos declarados). En F2 expandimos a 26 entradas concretas (§4.1) sin agregar superficie nueva — las 8 adicionales son splits de tests + el dir `tests/_mocks/`.

### OUT

Idéntico al work-item §Scope OUT. Reforzado:

- NO modificar `src/{sign,url-validator,handlers,config,log,auth,index}.mjs` (CD-1).
- NO publicar a npm.
- NO Edge Runtime para los nuevos endpoints (DT-B heredado).
- NO automatizar rotación de bearer (W4 manual).
- NO agregar SDK Datadog / Prometheus (DT-F generic webhook).
- NO retries en alert sender.
- NO subir maxDuration > 60s.
- NO upgrade a Vercel Pro.

---

## 7. Riesgos

| # | Riesgo | Prob | Impacto | Mitigación en este SDD |
|---|---|---|---|---|
| R1 | Upstash free tier no alcanza el volumen (~1.5k ops/día estimados) | BAJA | MEDIO | Estimación: warmup */4 = 360/día, balance-check */15 = 96/día, rate-limit ~50-200/día durante demos. Total ~700-1k/día. Free tier Upstash REST = 10k commands/día. Margen 10x. Si en producción bursty hits 10k → escalado a paid tier es decisión humano (gate). |
| R2 | RPC Avalanche public endpoint rate-limited | MEDIA | ALTO si pasa en demo | Snapshot KV TTL 30s amortiza. Fallback `AVALANCHE_RPC_URL` configurable a provider con SLA (Alchemy/QuickNode). Documentar en runbook. AC-W5-1 cubre `Avalanche RPC rate-limit (429)` chaos test. |
| R3 | cron-job.org SaaS down | MEDIA | MEDIO | Service externo no controlable. Mitigación: heartbeat tracking en KV (`lastBalanceCheck` timestamp) — si no se actualiza en >30 min, próxima `pay_x402` puede emitir alert log (heredado work-item Risk-cat-11). **Decisión**: NO incluir heartbeat tracking en este SDD — fuera de scope IN. Documentar en `done-report.md` como follow-up para HU futura. |
| R4 | Lua EVAL no soportado en Upstash free tier | MEDIA | BAJO (DT-I tiene fallback) | DT-I cementado: usamos INCRBY+EXPIRE+CAS-revert (no Lua). Atomicidad del INCRBY es garantizada por Redis single-thread; el race window es la decisión "claimed > available" en JS. Mitigación: el revert con DECRBY si CAS check falla acota el window a ~1ms. Concurrent stress test (AC-W5-2) valida empíricamente. Alternativa Lua queda como follow-up si stress test falla. |
| R5 | Vercel Function adapter (`req, res` style) y Web Standards (`Request`) divergen para los cron endpoints | BAJA | MEDIO | Heredamos el patrón de `api/mcp.mjs` (Vercel adapter + webHandler interno). Pero cron endpoints son GET sin body — el adapter es más simple. Decisión DT-K: usar Express-style directo `(req, res)` para los cron handlers (sin webHandler intermedio) — son más simples y no necesitan el Web Standards intermediate. Tests pueden importar el handler default y crear `req, res` mocks. |
| R6 | `@upstash/redis` v1.x supply chain (postinstall scripts, transitive deps) | BAJA | MEDIO | AR §V5 cubre. Pin version. Audit `npm ls @upstash/redis` durante AR. |
| R7 | Falta de AVAX para gas — pago se sign pero falla en chain por out-of-gas en facilitator | BAJA | ALTO | Fuera del balance gate (gate mide USDC). CD-16 documenta. Mitigación: runbook AC-W4-4(c) instruye al operator a mantener AVAX en wallet. **No se agrega gate AVAX en esta HU** — sería duplicar lectura RPC y aumentar superficie. |
| R8 | Concurrent stress test (AC-W5-2) reporta race condition real | MEDIA | ALTO si pasa | Si el INCRBY+CAS-revert no es suficiente bajo carga simulada con mocks, el SDD requiere upgrade a Lua EVAL en F3. AR foco aquí. Tests cubren claim contention. |
| R9 | RPC chainId mismatch (operator firma sobre 43114 pero RPC apunta a Fuji 43113) | BAJA | ALTO | balance-guard.mjs lee env `MCP_OPERATOR_CHAIN_ID` (default 43114) + `AVALANCHE_RPC_URL` y los pasa juntos a `createPublicClient({ chain: avalanche, transport: http(rpc) })`. Si la dupla está mal, lecturas fallan o devuelven balance 0. AC-W5-1 chaos test cubre. |
| R10 | Pre-load module en warmup diverge del set real usado en `pay_x402` | BAJA | BAJO | AR §V8 cubre. AC-W1-4 lista explícitamente: `src/handlers.mjs`, `src/sign.mjs`, viem account derivation. Si en HUs futuras se agregan handlers, hay que actualizar warmup — flag para AR/CR. |

---

## 8. Dependencias

### Internas
- WKH-64 DONE (handlers.mjs base — CD-1 lo blinda).
- WKH-65 DONE (HTTP transport, auth.mjs, vercel.json baseline).

### Externas (nuevas)
- **`@upstash/redis@^1.34.0`** (npm). REST API (HTTP fetch). 100% Edge/Node compatible. Sin deps nativas. Sin postinstall scripts (verificar en F3 vía `npm ls`).
- **Upstash Redis** (SaaS). Provisioning via Vercel Marketplace → `wasiai-x402-mcp` project. Inyecta `KV_REST_API_URL` + `KV_REST_API_TOKEN`. Free tier: 10k commands/día (margen 10x).
- **cron-job.org** (SaaS). Token `CRONJOB_ORG_API_TOKEN` en `/tmp/wkh66-cronjob-token.txt` (humano lo proveyó). API: `https://api.cron-job.org/jobs` (GET list, PUT create, PATCH update by id).
- **Avalanche C-Chain mainnet RPC**. Default Avalanche public RPC `https://api.avax.network/ext/bc/C/rpc`. Recomendado: Alchemy/QuickNode con SLA. Variable `AVALANCHE_RPC_URL`.
- **USDC contract on Avalanche** `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` (canonical Circle USDC). Default en código, override via `AVALANCHE_USDC_ADDRESS`.

### Provisioning steps (para Dev en F3, runbook en F4)

1. **Upstash via Vercel Marketplace** (manual humano):
   - Vercel dashboard → project `wasiai-x402-mcp` → Storage → Add → Upstash KV → Create.
   - Vercel inyecta automáticamente `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN` como env vars.
   - **VERIFICACIÓN F2**: Architect confirma con humano que el plan Vercel Hobby + Upstash free está disponible. Si NO → bloqueante (escalar).
   - Naming: en algunas integraciones Vercel post-2024 las vars se llaman `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`. **Decisión F2**: `kv-client.mjs` lee con fallback — primero `KV_REST_API_URL || UPSTASH_REDIS_REST_URL`, mismo para TOKEN. Documentado en `.env.example`.

2. **cron-job.org** (automatizado vía script W4):
   - Humano crea cuenta en cron-job.org (free tier).
   - Genera API token en `/me` → API.
   - Token se guarda en `.env` local como `CRONJOB_ORG_API_TOKEN` (NO commit).
   - Dev corre `node scripts/setup-cronjob.mjs` con `MCP_DEPLOY_URL=https://wasiai-x402-mcp.vercel.app` y `CRON_SECRET=<value>`.
   - Script crea/updatea idempotentemente los 2 jobs.

---

## 9. Missing Inputs (status)

Los 5 NEEDS CLARIFICATION del work-item se resuelven aquí:

| Item original (work-item §Missing Inputs) | Resolución F2 |
|---|---|
| **DT-A** — confirmar plan Vercel + Upstash free tier alcanza | **RESUELTO**: free tier 10k cmd/día vs estimado 700-1k/día = margen 10x. Architect propone `@upstash/redis@^1.34.0` directo. **Asume** plan Vercel Hobby permite Upstash free Marketplace integration. **Si fallara** → bloqueante, modo manual: humano crea cuenta Upstash directa (no via Vercel Marketplace) y configura `KV_REST_API_URL`+`KV_REST_API_TOKEN` manualmente como Vercel env vars. Dev no se entera de la diferencia (kv-client.mjs lee env vars). |
| **DT-C** — cron `*/4` y `*/15` en Vercel Hobby | **RESUELTO HUMANO** Opción B: cron externo cron-job.org. Token en `/tmp/wkh66-cronjob-token.txt`. Script `setup-cronjob.mjs` automatiza provisioning (W4). |
| **DT-H** — RPC en cada `pay_x402` vs snapshot 15min | **RESUELTO**: lectura RPC con cache KV TTL 30s. Trade-off explicado en §4.3 `balance-guard.mjs`. Cron de 15 min sirve para alert webhook (W3) y como warm cache para gate (W2 reads snapshot first). |
| **DT-I** — atomic claim Lua vs INCRBY+TTL | **RESUELTO**: INCRBY + EXPIRE + CAS-revert (sin Lua). Razón: Upstash free tier puede no soportar EVAL; INCRBY single-threaded de Redis garantiza atomicidad del incremento; el race window de la decisión "claimed > available" en JS se acota con DECRBY-revert. Concurrent stress test (AC-W5-2) valida empíricamente. Si falla en F3 → upgrade a Lua. |
| **DT-J** — orden ops en api/mcp.mjs | **RESUELTO**: ver §11 DT-J. Orden definitivo: CORS → method → bearer auth → **rate-limit (NEW)** → loadConfig → buildServer → dispatch (con **balance-gate-en-pay_x402 NEW** dentro del switch). |
| **Naming env vars Upstash** | **RESUELTO**: `kv-client.mjs` lee con fallback (`KV_REST_API_URL || UPSTASH_REDIS_REST_URL`). |
| **Webhook destino** | **NO RESUELTO definitivamente — NO BLOQUEANTE**. El work-item declara shape genérico. F2 elige: alert sender envía body shape `{ severity, chain, operator, balanceUsdc, threshold, checkedAt, blockNumber? }` que es consumible por: (a) Slack incoming webhook (que ignora keys extra y muestra el JSON crudo en chat), (b) Discord webhook (idem), (c) Datadog event (necesita `text` field — adaptamos en F3 si humano elige Datadog). Decisión final: humano configura `MCP_ALERT_WEBHOOK_URL` post-deploy. Si elige Slack/Discord, funciona out-of-box. Si elige Datadog, F3 agrega un wrapper opcional (no bloqueante para esta HU). |

**0 [NEEDS CLARIFICATION] sin resolver**.

---

## 10. Uncertainty Markers

Ningún `[NEEDS CLARIFICATION]` activo. Los items abiertos se documentan como follow-ups en `done-report.md` futuro:

- Heartbeat tracking en KV (Risk R3 mitigation) — fuera de scope IN.
- Upgrade a Lua EVAL si stress test falla — contingencia de F3.
- Wrapper para Datadog event format si humano elige Datadog como destino webhook — F3 menor.

---

## 11. Decisiones técnicas (DT-N) — definitivas F2

> Heredamos las DTs del work-item. Las NEEDS CLARIFICATION quedan resueltas. DTs nuevas (DT-K, DT-L) emergen de F2.

- **DT-A** [RESUELTO F2]: KV provider = `@upstash/redis@^1.34.0` directo. Provisioning Vercel Marketplace → Upstash. Free tier 10k cmd/día (margen 10x sobre estimado 700-1k/día).
- **DT-B** [HEREDADO WKH-65]: Vercel Node.js Serverless runtime para todos los nuevos endpoints (`/api/cron/warmup`, `/api/cron/balance-check`).
- **DT-C** [RESUELTO HUMANO Opción B]: Cron externo via cron-job.org. NO modificar `vercel.json`.
- **DT-D** [CONFIRMADO]: Threshold = `$0.50 USDC` env `MCP_BALANCE_THRESHOLD_USDC`.
- **DT-E** [CONFIRMADO]: Rate limit = 5 req/min env `MCP_RATE_LIMIT_PER_MIN`. Bearer hash sha256 trunc 16.
- **DT-F** [CONFIRMADO]: Webhook generic POST JSON. Timeout 5s. No retries.
- **DT-G** [RESUELTO F2]: Provisioning automatizado (a). Script `scripts/setup-cronjob.mjs` con cron-job.org API. Idempotente by title (CD-20).
- **DT-H** [RESUELTO F2]: Lectura RPC en cada `pay_x402` con cache KV TTL 30s. Snapshot del cron de 15 min se usa como warm cache (TTL 1800s — para responder más rápido los primeros 30s y dar lugar al cron). El gate prefiere el snapshot fresh (<30s) pero invalida si stale > 30s y refetcha RPC.
- **DT-I** [RESUELTO F2]: Atomic claim = INCRBY + EXPIRE + CAS-revert (DECRBY si check falla). NO Lua EVAL. Razón: simplicidad + free tier compat. Stress test (AC-W5-2) valida.
- **DT-J** [RESUELTO F2 — ORDEN DEFINITIVO de operaciones en `api/mcp.mjs::webHandler`]:
  ```
  1. CORS preflight (OPTIONS → 204)               [O(1) header parse]
  2. Method gate (!POST → 405)                    [O(1)]
  3. Bearer auth (timing-safe → 401)              [O(1) compare]
  4. Rate limit (KV INCR → 429)                   [O(1) KV op, ~5-50ms]
  5. loadConfig (DNS / SSRF check)                [O(n) DNS + parse]
  6. buildServer + transport                      [O(1) MCP SDK setup]
  7. Dispatch tools/call:
     - discover_agents       → handler directo
     - get_payment_quote     → handler directo
     - pay_x402              → checkBalanceWithClaim → handler → releaseClaim (try/finally)
  ```
  **Justificación**: rate-limit DESPUÉS de auth (no consume slots para callers no-autenticados — DoS sobre el rate limiter mismo). Rate-limit ANTES de loadConfig (evita DNS lookup costoso para callers ratelimit-violators). Balance-gate solo en `pay_x402` (no en discover/quote — esos son free / no firman).
- **DT-K** [NUEVO F2]: Cron handlers (`api/cron/warmup.mjs`, `api/cron/balance-check.mjs`) usan **Express-style directo** `(req, res) => void`, sin Web Standards intermediate. Razón: cron handlers son simples GET sin body, sin CORS, sin tools/call dispatch. El adapter `webHandler → vercelHandler` de `api/mcp.mjs` es overkill. Tests importan default y crean mocks `req, res` simples.
- **DT-L** [NUEVO F2]: KV mock interface (en `tests/_mocks/kv-mock.mjs`) implementa subset de `@upstash/redis` API: `get(k), set(k, v, opts), incr(k), incrby(k, n), decrby(k, n), expire(k, sec), ttl(k), del(k)`. Soporta flags `failNext: number` (cuántas próximas ops fallan) y `slowMs: number` (latency simulada con setTimeout). Map-backed in-memory. **PROHIBIDO Lua EVAL en mock** (alineado con DT-I).

---

## 12. Plan de Tests — mínimo 1 test por AC (≥23 ACs cubiertos, 55 tests planeados)

### Mapa AC → test

| AC | Test file | Test ID(s) | Aproach |
|---|---|---|---|
| AC-W1-1 | `tests/setup-cronjob.test.mjs` | T-SC-01..T-SC-04 | Mock cronjob-org-mock con flags create/update; assert idempotencia by title |
| AC-W1-2 | `tests/cron-warmup.test.mjs` | T-WM-01 | Importa handler default, mock `req, res`, assert 200 + body shape + latency p95 |
| AC-W1-3 | `tests/cron-warmup.test.mjs` | T-WM-02, T-WM-03 | Sin auth → 401; auth wrong → 401; timing-safe (assert `validateCronSecret` invocado) |
| AC-W1-4 | `tests/cron-warmup.test.mjs` | T-WM-04 | Spy `import()` calls; assert handlers.mjs + sign.mjs cargados; assert NO fetch real |
| AC-W2-1 | `tests/balance-guard.test.mjs` | T-BG-01 | Balance < threshold → reject pre-firma |
| AC-W2-2 | `tests/balance-guard.test.mjs` | T-BG-02, T-BG-03 | RPC fail → reject; KV fail → reject (fail-secure) |
| AC-W2-3 | `tests/concurrent-stress.test.mjs` | T-CS-01 | 10 Promise.all balance $0.51, threshold $0.50, amount $0.10 → exactamente 1 pasa, 9 reject |
| AC-W2-4 | `tests/balance-guard.test.mjs` | T-BG-04, T-BG-05 | Settle ok → release; settle fail → release |
| AC-W2-5 | `tests/rate-limit.test.mjs` | T-RL-01, T-RL-02 | 5 OK, 6th → 429 con retryAfter |
| AC-W2-6 | `tests/rate-limit.test.mjs` | T-RL-03 | Verify hash sha256 truncado 16 chars (no plain bearer en KV) |
| AC-W2-7 | `tests/rate-limit.test.mjs` | T-RL-04 | KV down → fail-open (procede) |
| AC-W3-1 | `tests/setup-cronjob.test.mjs` | T-SC-02 | Cron balance-check create + idempotent update |
| AC-W3-2 | `tests/cron-balance-check.test.mjs` | T-BC-01 | Auth ok → RPC read → KV snapshot persisted → 200 body shape |
| AC-W3-3 | `tests/cron-balance-check.test.mjs` | T-BC-02 | Balance < threshold + webhook configured → POST con body whitelist |
| AC-W3-4 | `tests/cron-balance-check.test.mjs` | T-BC-03 | Webhook timeout → log only + cron 200 |
| AC-W3-5 | `tests/cron-balance-check.test.mjs` | T-BC-04 | Webhook URL not set → log warnOnce + 200 |
| AC-W4-1 | `tests/rotate-bearer.test.mjs` | T-RB-01 (nuevo, agregar) | Generate random + stdout once + no disk write |
| AC-W4-2 | `tests/rotate-bearer.test.mjs` | T-RB-02 | Detect stdout redirected (`isTTY === false`) → exit !=0 |
| AC-W4-3 | `tests/refresh-session.test.mjs` | T-RS-01 (nuevo) | Mock fetch /api/mcp tools/list → 3 tools → exit 0 |
| AC-W4-4 | manual review | — | README sections (a..h) revisadas en CR |
| AC-W5-1 | `tests/chaos.test.mjs` | T-CH-01..T-CH-18 | 18 escenarios listados en §4.5 |
| AC-W5-2 | `tests/concurrent-stress.test.mjs` | T-CS-01 | (mismo de AC-W2-3) |
| AC-W5-3 | `tests/balance-guard.test.mjs` | T-BG-01..T-BG-08 | 8 sub-tests (a..h) |
| AC-W5-4 | `tests/rate-limit.test.mjs` | T-RL-01..T-RL-06 | 6 sub-tests (a..f) |
| AC-W5-5 | CI run | — | `npm test` debe correr ≥128 tests passing |
| AC-X-1 | `tests/chaos.test.mjs` + others | T-CH-19 | Spy stderr; assert PK / bearer / CRON_SECRET / KV token NUNCA aparecen |
| AC-X-2 | manual review | — | `.env.example` revisado en CR |
| AC-X-3 | manual review | — | `package.json` `@upstash/redis@^1.34.0` revisado en CR |

> Necesitamos agregar `tests/rotate-bearer.test.mjs` y `tests/refresh-session.test.mjs` — los splits de §4.1 (#21-#25 lista 9 archivos test, agregamos +2 = 11 total). Total tests: 55 + 2 = **57 nuevos**.

### Suite de regresión (golden vectors)

- WKH-64 sign tests (`tests/sign.test.mjs`, 8 tests) — DEBEN seguir pasando sin modificar (CD-1).
- WKH-65 http tests (`tests/http.test.mjs`, 12 tests) — DEBEN seguir pasando. La inserción de rate-limit DESPUÉS de auth NO debería afectar T-HTTP-01..T-HTTP-12 (rate limit fail-open si KV no configured = paso transparente).
- WKH-65 tools tests (`tests/tools.test.mjs`) — sin cambio.
- Total baseline 103, post-impl 158-160.

---

## 13. Waves de Implementación

### Wave 0 — Serial Gate (scaffold + provisioning + mocks)

Bloqueante. Sin esto no se puede implementar nada de W1-W5.

| # | Tarea | Archivo | Output |
|---|---|---|---|
| W0.1 | Agregar dep `@upstash/redis@^1.34.0` + scripts | `package.json` | `npm install` corre ok |
| W0.2 | Documentar nuevas env vars | `.env.example` | Todas las vars de §4.1 |
| W0.3 | KV mock | `tests/_mocks/kv-mock.mjs` | Map-backed, flags failNext/slowMs |
| W0.4 | RPC mock | `tests/_mocks/rpc-mock.mjs` | viem-compat readContract mock |
| W0.5 | cron-job.org API mock | `tests/_mocks/cronjob-org-mock.mjs` | mock del fetch a api.cron-job.org |
| W0.6 | KV client wrapper | `src/kv-client.mjs` | `getKvClient()` + `setKvClientForTesting` + null-safe |
| W0.7 | **Provisioning humano**: Upstash via Vercel Marketplace | (manual) | Vercel project tiene `KV_REST_API_URL`+`KV_REST_API_TOKEN` |

> W0.7 es un **gate humano** dentro del W0. Si no se completa, W1-W5 quedan bloqueados. Architect lo marca aquí para que orquestador pause F3 si Dev reporta `KV_REST_API_URL` not set en deploy.

### Wave 1 — Cold-start cron warmup

| # | Tarea | Archivo | Output |
|---|---|---|---|
| W1.1 | Cron auth helper | `src/cron-auth.mjs` | `validateCronSecret` timing-safe |
| W1.2 | Tests cron auth | `tests/cron-auth.test.mjs` | 5 tests passing |
| W1.3 | Warmup handler | `api/cron/warmup.mjs` | Handler GET con auth + module preload |
| W1.4 | Tests warmup | `tests/cron-warmup.test.mjs` | 4 tests T-WM-01..T-WM-04 |

### Wave 2 — Balance gate + rate limit

| # | Tarea | Archivo | Output |
|---|---|---|---|
| W2.1 | Balance guard module | `src/balance-guard.mjs` | `checkBalanceWithClaim`+`releaseClaim` |
| W2.2 | Rate limit module | `src/rate-limit.mjs` | `checkRateLimit`+`hashBearer` |
| W2.3 | Tests balance-guard | `tests/balance-guard.test.mjs` | 8 tests T-BG-01..T-BG-08 |
| W2.4 | Tests rate-limit | `tests/rate-limit.test.mjs` | 6 tests T-RL-01..T-RL-06 |
| W2.5 | **Integración en `api/mcp.mjs`** | `api/mcp.mjs` (modify) | DT-J orden de ops aplicado. Tests `tests/http.test.mjs` siguen pasando (regresión). |
| W2.6 | Test integración http | `tests/http.test.mjs` (extender) | 3 tests nuevos T-HTTP-13/14/15 (rate-limit en flow, balance-gate en pay_x402) |

### Wave 3 — Balance monitoring + alerts webhook

| # | Tarea | Archivo | Output |
|---|---|---|---|
| W3.1 | Alerts module | `src/alerts.mjs` | `sendAlert` con timeout 5s, body whitelist |
| W3.2 | Tests alerts | `tests/alerts.test.mjs` | 4 tests |
| W3.3 | Cron balance-check handler | `api/cron/balance-check.mjs` | RPC read + KV snapshot + alert si threshold |
| W3.4 | Tests cron balance-check | `tests/cron-balance-check.test.mjs` | 5 tests T-BC-01..T-BC-05 |

### Wave 4 — Bearer rotation + session refresh + setup-cronjob

| # | Tarea | Archivo | Output |
|---|---|---|---|
| W4.1 | Rotate bearer script | `scripts/rotate-bearer.mjs` | CLI script con AC-W4-1+AC-W4-2 |
| W4.2 | Tests rotate-bearer | `tests/rotate-bearer.test.mjs` | 2 tests T-RB-01/02 |
| W4.3 | Refresh session script | `scripts/refresh-session.mjs` | CLI smoke `tools/list` |
| W4.4 | Tests refresh-session | `tests/refresh-session.test.mjs` | 1 test T-RS-01 |
| W4.5 | Setup cronjob script | `scripts/setup-cronjob.mjs` | CLI provisioning idempotente |
| W4.6 | Tests setup-cronjob | `tests/setup-cronjob.test.mjs` | 4 tests T-SC-01..T-SC-04 |
| W4.7 | README runbook | `README.md` (modify) | Sección "Operations runbook" AC-W4-4 (a..h) |

### Wave 5 — Chaos + concurrent stress

| # | Tarea | Archivo | Output |
|---|---|---|---|
| W5.1 | Chaos test suite | `tests/chaos.test.mjs` | 18 tests T-CH-01..T-CH-18 + T-CH-19 (PK/bearer audit) |
| W5.2 | Concurrent stress | `tests/concurrent-stress.test.mjs` | 1 test T-CS-01 (10 calls) |
| W5.3 | CI verification | (manual) | `npm test` ≥158 passing, 0 fail, 0 skip |

---

## 14. Dependencies entre tareas

```
W0 (serial gate)
  ├── W0.1 .. W0.6  (parallel ok)
  └── W0.7 (human provisioning) ← BLOCKING gate hasta DONE
       │
       ├── W1 (paralelo con W2-W4 a partir de W2.1+W2.2 done)
       │     W1.1 → W1.2 → W1.3 → W1.4
       │
       ├── W2 (cumple secuencia W2.1+W2.2 → W2.3+W2.4 → W2.5+W2.6)
       │
       ├── W3 (depende de W2.1: src/balance-guard.mjs lecturas)
       │     W3.1 → W3.2 ; W3.3 → W3.4
       │
       └── W4 (parallelo con W1+W2+W3 — sólo necesita W0)
             W4.1+W4.3+W4.5 paralelos → W4.2+W4.4+W4.6 paralelos → W4.7
       │
       └── W5 (BLOQUEADO hasta W1+W2+W3+W4 done)
             W5.1+W5.2+W5.3
```

**Camino crítico**: W0 → W2.5 (integración api/mcp.mjs) → W5 (chaos+stress validations).

---

## 15. Adversary Directives — sección obligatoria

10 vectores de ataque que AR (F3 post) DEBE atacar explícitamente:

### V1 — Balance gate bypass

- V1.1: KV down al momento del gate → ¿falla en fail-secure (rechaza pago) o accidentalmente fail-open?
- V1.2: Race condition: 10 requests concurrentes contra balance $0.51 + threshold $0.50 + amount $0.10 → ¿pasa exactamente 1 o más de 1 (double-spend window)?
- V1.3: Integer overflow: requestedWei extraordinariamente grande (ej. `2^256-1`) → ¿INCRBY desborda en Redis (max 64-bit signed) o se detecta antes?
- V1.4: Stale KV snapshot: la cron de 15 min escribió balance $5.00 hace 14 min, pero alguien drenó on-chain a $0.30 entre medio. El gate lee snapshot stale (TTL 30 min) y permite pago — ¿el snapshot del cron escribe TTL 30 min mientras el gate solo confía en TTL 30s? Verificar consistencia.
- V1.5: Threshold parsing — ¿`MCP_BALANCE_THRESHOLD_USDC=abc` o `=-0.5` se rechaza vs default? Si pasa → bypass.

### V2 — Rate limit bypass

- V2.1: Multiple bearers válidos del mismo operator → cada bearer tiene su key separada (esperado), pero ¿hay límite global por operator?  Decisión F2: NO global limit (operator es propietario, no atacante). Documentar como assumed-trust.
- V2.2: Bearer rotation timing: rotar bearer DURANTE una request mid-flight → ¿el viejo aún cuenta en su key, el nuevo arranca a cero? Esperado: sí (cada bearer tiene su key sha256-distinta).
- V2.3: KV down → fail-open. Atacante que tira KV externamente (DDoS sobre Upstash) habilita rate-limit bypass. Mitigación: monitoreo Upstash health en runbook.
- V2.4: Hash collision sha256 truncado 16 hex (64 bits): birthday bound ~2^32 bearers (~4 mil millones) — fuera del threat model (operator no maneja billones de bearers). Verificar que sí.

### V3 — Cron endpoint unauth

- V3.1: CRON_SECRET timing attack — ¿`validateCronSecret` usa timingSafeEqual? AR confirma código.
- V3.2: Vercel internal routing bypass — ¿el handler acepta otro mecanismo (query param `?token=...`, IP whitelist)? Esperado: NO (timingSafeEqual on Authorization Bearer only).
- V3.3: Sin CRON_SECRET env → ¿"auth disabled" o 500? Esperado: 500 con log estructurado, NUNCA "auth disabled".
- V3.4: Authorization header con Bearer secret pero schema diferente (ej. `Token <secret>`) → ¿reject? Esperado: sí, regex `^Bearer ` requerido.

### V4 — Webhook leak / SSRF / DoS

- V4.1: PK en body del webhook POST. Confirmar CD-12 whitelist enforced.
- V4.2: Bearer en body. Idem.
- V4.3: Error message exfiltration: si `sendAlert` catchea un error y lo loggea, ¿lo incluye en el body al webhook? Esperado: NO (log only). AR audita.
- V4.4: SSRF: `MCP_ALERT_WEBHOOK_URL=http://169.254.169.254/...` (AWS metadata) — ¿hay guard? Esperado: NO en esta HU (el webhook URL es env-controlled, asume operator-trust). Documentar como assumed-trust en CD-23 (NEW si quieren).
- V4.5: DoS: webhook lento → bloquea cron 5s. Aceptable (CD-5).
- V4.6: redirect leak (CD-18): webhook responde 302 a host atacante → ¿se reenvía body? CD-18 cubre con `redirect: 'error'`.

### V5 — Supply chain `@upstash/redis`

- V5.1: Audit `npm ls @upstash/redis` post-install — ¿qué deps transitive trae?
- V5.2: Postinstall scripts — `npm install --ignore-scripts` debería ser idéntico al normal install (sin scripts maliciosos).
- V5.3: Pin version: `^1.34.0` permite ^minor.patch — aceptable si no hay conocida CVE en ese rango. AR confirma.
- V5.4: Si Upstash deprecate la lib → plan B: `node-redis` o REST directo con fetch. Documentar como deuda en done-report.

### V6 — cron-job.org token leak

- V6.1: `CRONJOB_ORG_API_TOKEN` en logs del script `setup-cronjob.mjs` → ¿stderr/stdout?  AR audita: no debe loggear el token, solo `jobId` y `nextExecution`.
- V6.2: Error response del API cron-job.org puede incluir el token en error body → ¿se sanitiza antes de imprimir? AR audita.
- V6.3: Token commiteado a git por error — `.env.example` placeholder + `.gitignore` cubre `.env`. Verificar.

### V7 — Concurrent claim contention

- V7.1: CAS revert race: 10 calls concurrentes, INCRBY atómico, pero CAS check en JS no es atómico — ¿2 calls pueden leer "below threshold" antes de que ninguno DECRBY-revert? Stress test debe demostrar empíricamente que el window cierra.
- V7.2: Claim TTL 30s: si una function corre 35s (timeout 60s pero balance gate + sign + settle dura 35s en p99), el claim expira mid-flow y otra request puede entrar — ¿es esperado? Aceptable bajo CD-13 (si la función es muy lenta, el claim huérfano es bug operacional, no de seguridad). AR documenta.
- V7.3: `releaseClaim` puede correr DESPUÉS de que el claim ya expiró (TTL 30s, settle tomó 35s) → DECRBY de una key inexistente → no-op (Redis behavior). Esperado: sí.

### V8 — Regression vs WKH-65

- V8.1: BLQ-iter2-1 (SSRF post-resolution) — sigue activo en `api/mcp.mjs`? AR re-attack con `endpoint='/\evil.com/x'`.
- V8.2: BLQ-iter3-1 (redirect:'error') — todos los nuevos fetch llevan `redirect:'error'`? AR audita: alerts.mjs webhook, setup-cronjob.mjs API.
- V8.3: Cron auth ANTES de loadConfig — ¿se respeta? Esperado: sí (AR audita api/cron/* handlers).
- V8.4: T-HTTP-01..T-HTTP-12 baseline → todos siguen pasando.
- V8.5: signature truncate 4 chars — `redact()` sigue intacto.

### V9 — Alert webhook DoS

- V9.1: Webhook lento (29s) bloquea la cron entera, cron timeout = 60s, → cron-job.org reintenta? El segundo intento puede colisionar con el primero (re-send alert). Aceptable: alert duplicado es ruido pero no inseguridad.
- V9.2: Webhook responde 4xx repetido → cron 200 sigue (AC-W3-4), pero ¿`webhook-failed` log ruidoso? warnOnce no aplica (cada 15 min vale loggear). Aceptable.

### V10 — Chaos test self-validation

- V10.1: ¿Los mocks ESCONDEN bugs reales? AR ejecuta los chaos tests y verifica que: (a) `kv-mock.mjs` simula REAL Redis behavior (atomicidad de INCRBY) — no atómico in-memory si dos llamadas síncronas, atomicidad real sí. Confirmar que el mock single-threaded JS ya garantiza atomicidad de cada call individual. (b) `rpc-mock.mjs` retorna BigInt (no number) para `balanceOf` (real viem behavior). (c) Tests con mocks deben fallar si modificás el guard real para "always allow" — sanity check.

---

## 16. Readiness Check

Checklist de "listo para implementar" (F2.5 + F3):

| Item | Estado |
|------|:---:|
| Cada AC tiene ≥1 test plan en §12 | ✅ 23 ACs cubiertos por 57 tests planeados |
| Cada archivo en §4.1 tiene exemplar verificado con Glob | ✅ 11 exemplars verificados existentes (§3 "Exemplars verificados"); 4 nuevos paths declarados (`scripts/`, `api/cron/`, `tests/_mocks/`) |
| 0 [NEEDS CLARIFICATION] sin resolver | ✅ 5 NEEDS CLARIFICATION del work-item resueltos en §9 |
| ≥3 PROHIBIDO en CDs | ✅ CDs heredados (CD-1..CD-15) + nuevos (CD-16..CD-22) — 14+ PROHIBIDO documentados |
| Auto-blindaje histórico revisado (069, 070) | ✅ Leídos. Patrones recurrentes detectados → cementados en CD-17/CD-18/CD-19 |
| Adversary directives cubren ≥7 vectores | ✅ 10 vectores (V1..V10) en §15 |
| Tests ≥1 por AC | ✅ 57 tests para 23 ACs |
| Stack alineado con project-context.md | ✅ viem, Node 22.x, JSON-line logs (CD-8) |
| Waves declaradas con dependencies explícitas | ✅ §13 + §14 |
| DT-A confirmado (Upstash free tier) | ✅ Margen 10x sobre estimado (10k cmd/día disponible vs 700-1k usado) |
| DT-C confirmado (cron-job.org externo) | ✅ Token humano en `/tmp/wkh66-cronjob-token.txt` |
| DT-J orden de operaciones cementado | ✅ §11 |
| DT-I atomic claim definido (INCRBY+CAS-revert, no Lua) | ✅ §11 |
| DT-K cron handlers Express-style directo | ✅ §11 |
| Branch base verificado (`main@7b9fc7d`) | ✅ Branch exists, post-merge WKH-65 |
| Tests baseline 103 (WKH-65) — sin regresión planeada | ✅ §12 explicita preservación |

**Estado final**: ✅ **READY PARA SPEC_APPROVED**.

Bloqueantes pendientes: **0**. Items resueltos en F2: **5/5**. Sin escalation a humano.

---

## 17. Notas para fases siguientes

### Para F2.5 (Story File)
- Inputs concretos del Dev: tabla §4.1 (26 entradas), §13 waves (5 waves), §15 adversary (10 vectores).
- Anti-Hallucination Checklist crítica: CD-1 (NO tocar core), CD-17 (no `event:` en log payload), CD-18 (`redirect:'error'`), CD-19 (mocks header-aware), CD-20 (idempotente by title).
- Patrones a copiar (con paths verificados): `src/auth.mjs::validateBearerToken` → `src/cron-auth.mjs::validateCronSecret`. `src/lib/downstream-payment.ts:237-249` → `src/balance-guard.mjs::readBalance`.

### Para F3 (Dev)
- Wave 0 es serial gate. Sin `KV_REST_API_URL` setado en Vercel project, NO arrancar Wave 1+.
- Tests deben correr sin `KV_REST_API_URL` real (mocks via `setKvClientForTesting`).
- Concurrent stress test (T-CS-01) es señal crítica: si falla, escalar a Lua EVAL (DT-I contingencia).

### Para AR (post F3)
- Foco prioritario: V2 (race condition), V4 (webhook leak), V8 (regression WKH-65).
- Verificar que `redirect: 'error'` está presente en TODOS los fetch nuevos (CD-18).
- Verificar que NO se introdujo `event:` en payloads de log (CD-17 — patrón recurrente).

### Para QA (F4)
- Evidencia archivo:línea por cada AC. Los 23 ACs mapean a tests específicos en §12 con IDs T-WM-*, T-BG-*, T-RL-*, T-CH-*, T-CS-*, T-BC-*, T-RB-*, T-RS-*, T-SC-*.
- Smoke real: NO se exige en esta HU (chaos tests son mocks 100%, CD-7). El smoke contra Vercel deploy queda para post-merge manual.

---

**Fin SDD WKH-66.**
