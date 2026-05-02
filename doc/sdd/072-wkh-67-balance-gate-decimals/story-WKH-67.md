# Story File — WKH-67 — Balance-gate decimals mismatch (PYUSD inbound vs USDC outbound)

> **Branch**: `fix/072-wkh-67-balance-gate-decimals` (desde `main@b095b80`)
> **Status**: READY_FOR_F3
> **Pipeline**: NexusAgil QUALITY — modo AUTO
> **Predecesor con regression**: WKH-66 (`071-wkh-66-prod-hardening`, DONE 2026-04-29).
> **Subpaquete**: `mcp-servers/wasiai-x402/` (todo el trabajo es ahí, salvo `doc/`).
> **Approach**: A — balance-gate INSIDE `payX402Handler` post-probe / pre-cap-guard. Approach B (renombrar args + uno nuevo) DESCARTADO.

> **Contrato de este archivo**: el Dev (`nexus-dev`) ejecuta F3 leyendo SOLO este archivo. NO debe abrir `work-item.md` ni `sdd.md`. Si algo no está acá, NO se hace.

---

## 1. Contexto mínimo (1-2 párrafos)

WKH-66 shippeo a mainnet un balance-gate de operator wallet en `api/mcp.mjs::runWithBalanceGate` (líneas 106-194), pero **reusó el argumento `args.maxAmountWei`** (introducido en WKH-64 como sign guard sobre INBOUND PYUSD wei, Kite testnet, **18 decimales**) como input de `requestedWei` del balance-gate (OUTBOUND USDC wei, Avalanche mainnet, **6 decimales**). El mismo nombre con dos dimensiones (10^18 vs 10^6) es matemáticamente irresoluble: NO existe valor que satisfaga ambos checks. Resultado en mainnet: **100% de los `pay_x402` rebotan en `stage:'balance-gate'`**. Deploy WKH-66 funcionalmente broken, rolled back a `wasiai-x402-ah0gufv0p` (era WKH-65), cron-job.org disabled.

El fix (Approach A): **mover el balance-gate INSIDE `payX402Handler`** entre el probe parsing y el cap guard PYUSD, derivar el OUTBOUND USDC wei desde `payload.maxBudget` (USDC number declarado por caller) usando `usdcToWei(...)`, y mantener el cap guard PYUSD intacto sobre `args.maxAmountWei` (sin cambios). Cada guard opera en su propia dimensión sin acoplamiento. El wrapper externo `runWithBalanceGate` se elimina. Lo que NO hace: tocar el sign flow, el SSRF guard, el settle, el redirect:'error', la atomicidad del claim KV, el threshold $0.50 USDC, el RPC URL, el USDC contract address, ni el schema MCP `pay_x402` (no breaking change — `payload.maxBudget` ya existía implícito en `additionalProperties:true`).

---

## 2. Anti-Hallucination Checklist (verificar ANTES de codear)

> Si algún ítem es FALSE, parar y reportar [BLOCKER] al orquestador.

- [ ] **CD-1 lift contenido**: SOLO `src/handlers.mjs` y `src/balance-guard.mjs` se modifican en el core. PROHIBIDO tocar `src/sign.mjs`, `src/url-validator.mjs`, `src/auth.mjs`, `src/log.mjs`, `src/config.mjs`, `src/index.mjs`, `src/kv-client.mjs`, `src/rate-limit.mjs`, `src/cron-auth.mjs`, `src/alerts.mjs`, `src/avax-client.mjs`. `api/cron/*.mjs` NO se tocan. `vercel.json`, `package.json`, `.env.example` NO se tocan.
- [ ] **Tests baseline 173+**: `npm test` antes del fix retorna ≥173 tests passing (W0.2). Tras el fix, ≥184 (con 11-14 tests nuevos).
- [ ] **INBOUND PYUSD 18d ≠ OUTBOUND USDC 6d explícito**: `args.maxAmountWei` SOLO se usa en cap guard PYUSD (línea ~362 actual). `payload.maxBudget` SOLO se usa en balance-gate (nuevo bloque post-probe). PROHIBIDO cross-uso. AR/CR grep ambos identificadores.
- [ ] **`releaseClaim` exactly-once via finally interno**: try envuelve cap guard + sign + settle + return final. Finally invoca `releaseClaim` siempre, en cualquier path (success, sign error, settle error, redirect-refused, exception, cap-guard-reject).
- [ ] **No regresión de 5 BLQs WKH-64** (W-BLQ-1..5): isPathOnly + resolveEndpoint + redirect:'error' en 4 fetch + sign sanitization + signature 4-char trunc. Tests T-X1..T-X5, T-Y1, T-Z1, T-MNR-iter2-1 NO se tocan.
- [ ] **No regresión BLQ-iter3-1 WKH-65** (`redirect:'error'`): las 4 ocurrencias en `src/handlers.mjs` (líneas 305, 444 + las 2 de discoverAgents/getPaymentQuote) DEBEN seguir intactas. Tests T-X11..T-X14 NO se tocan.
- [ ] **No regresión BLQ-ALTO-1 WKH-66** (snapshot freshness 30s): `src/balance-guard.mjs:148-184` NO se modifica. Solo se promueve `_usdcToWei` a export público. T-BG-09/10/T-CS-02 NO se tocan.
- [ ] **No `event:` en log payload**: CD-17 heredado. Logger toma event name del primer arg de `log.{info,warn,error}`. Nuevos logs NO incluyen `event:` dentro del payload.
- [ ] **No `console.*`**: usar `src/log.mjs`. CD-8 inviolable.
- [ ] **No secrets logueados**: PK, MCP_BEARER_TOKEN, CRON_SECRET, KV_REST_API_TOKEN, MCP_ALERT_WEBHOOK_URL — NO van a logs nuevos.
- [ ] **No invención de APIs**: `_usdcToWei` ya existe en `src/balance-guard.mjs:70-76` exportado vía `_testHelpers` (línea 264). Promover, NO duplicar. `getKvClient()`, `getAvaxClient(rpcUrl)`, `checkBalanceWithClaim`, `releaseClaim` ya existen — reusar.
- [ ] **No mainnet en tests**: CD-7. Todo mock (KV mock + RPC mock + fetch fake).
- [ ] **No TS / no vitest**: `.mjs` puro + `node:test`. CD heredado del subpaquete.

---

## 3. Scope IN — archivos exactos a tocar

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `mcp-servers/wasiai-x402/src/balance-guard.mjs` | MODIFICAR (mínimo) — promover `_usdcToWei` a export público (rename `_usdcToWei` → `usdcToWei` + `export`). Mantener export `_testHelpers` como antes (re-export del nuevo nombre). Sin tocar `checkBalanceWithClaim`, `releaseClaim`, snapshot logic. | W1 |
| 2 | `mcp-servers/wasiai-x402/src/handlers.mjs` | MODIFICAR — (a) imports nuevos al tope; (b) insertar bloque `[1.5] Balance-gate` entre línea ~343 y ~359 dentro de `payX402Handler`; (c) wrappear cap guard + sign + settle + return en `try { ... } finally { await releaseClaim(...) }`; (d) update `TOOL_DESCRIPTORS.pay_x402` description + inputSchema. | W2 |
| 3 | `mcp-servers/wasiai-x402/api/mcp.mjs` | MODIFICAR — (a) eliminar función completa `runWithBalanceGate` (líneas 106-194); (b) eliminar imports `checkBalanceWithClaim, releaseClaim, getAvaxClient` (líneas 54-58) si no se usan en otro lado; (c) simplificar case `'pay_x402'` (línea 222-227) a llamada directa `payX402Handler(args, cfg)`. | W3 |
| 4 | `mcp-servers/wasiai-x402/tests/handlers-balance-gate.test.mjs` | CREAR — 11-14 tests nuevos T-FIX-01..T-FIX-14. | W4.1, W4.2 |
| 5 | `mcp-servers/wasiai-x402/tests/balance-guard.test.mjs` | MODIFICAR (mínimo) — eliminar tests T-BG-11/T-BG-11b (líneas 286-321) **o** re-targetar imports si se mueven a `handlers-balance-gate.test.mjs`. Eliminar `import { runWithBalanceGate }` (línea 20). T-BG-01..T-BG-10 NO se tocan. | W4.3 |
| 6 | `mcp-servers/wasiai-x402/tests/http.test.mjs` | MODIFICAR (mínimo) — T-HTTP-14 (líneas 660-718): cambiar JSON-RPC body a `arguments: { endpoint, payload: { maxBudget: 0.1 } }` (en lugar de `arguments: { endpoint, maxAmountWei: '100000' }`). T-HTTP-13 y T-HTTP-15 NO se tocan. | W4.4 |
| 7 | `mcp-servers/wasiai-x402/README.md` | MODIFICAR — sección "Tools / pay_x402": documentar `payload.maxBudget` (USDC number) como source-of-truth OUTBOUND y `args.maxAmountWei` (PYUSD wei BigInt-string) como cap defensivo INBOUND opcional. Ejemplos con/sin `maxAmountWei`. | W5.1 |
| 8 | `doc/sdd/072-wkh-67-balance-gate-decimals/smoke-prep.md` | CREAR (NUEVO) — documento corto que describe (a) cómo invocar el smoke real $0.061 USDC mainnet post-merge, (b) endpoint, body JSON-RPC esperado, env vars necesarias, balance pre/post a documentar, (c) que el run lo ejecuta el orquestador en W6/F4 — NO en F3, NO en CI. | W5.2 |

### Scope OUT (NO TOCAR)

- `src/sign.mjs`, `src/url-validator.mjs`, `src/auth.mjs`, `src/log.mjs`, `src/config.mjs`, `src/index.mjs`, `src/kv-client.mjs`, `src/rate-limit.mjs`, `src/cron-auth.mjs`, `src/alerts.mjs`, `src/avax-client.mjs`.
- `api/cron/warmup.mjs`, `api/cron/balance-check.mjs`.
- `vercel.json`, `package.json` (sin bump version), `.env.example`.
- `tests/concurrent-stress.test.mjs` (T-CS-01/T-CS-02 testean `checkBalanceWithClaim` direct; pasan idénticos).
- `tests/balance-guard.test.mjs` líneas 1-285 (T-BG-01..T-BG-10).
- `tests/tools.test.mjs` (T29 sigue cubriendo cap guard).
- `tests/http.test.mjs` T-HTTP-13/T-HTTP-15 (rate-limit + discover_agents bypass).
- Schema MCP `pay_x402` shape (no breaking — solo agregar `payload.maxBudget` como property documentada).
- Threshold $0.50 USDC, RPC URL, USDC contract address.

---

## 4. Wave 0 — Branch setup + baseline

> Serial gate. NO continuar a W1 hasta que esto verde.

```bash
# Verificar que estás en el subpaquete
cd mcp-servers/wasiai-x402

# Confirmar HEAD == main@b095b80 (o un descendiente)
git log -1 --format='%H %s'
git status

# Crear branch desde main
git checkout main
git pull --ff-only
git checkout -b fix/072-wkh-67-balance-gate-decimals

# Baseline: 173+ tests passing CON el bug presente
# (los tests actuales NO ejercitan AC-1 happy path con payload.maxBudget sin maxAmountWei)
npm install --no-audit --no-fund
npm test 2>&1 | tail -10
```

**Done Definition W0**:
- Branch `fix/072-wkh-67-balance-gate-decimals` existe y está checked-out.
- `npm test` reporta ≥173 tests pass, 0 fail (el bug no rompe la suite — solo rompe el smoke real mainnet).
- `git status` clean (sin archivos sin trackear).

**Escalation W0**: Si baseline tests fail >2 retries, STOP, reportar [BLOCKER baseline]. NO avanzar.

---

## 5. Wave 1 — Export público `usdcToWei` en `balance-guard.mjs`

> Depende de W0.

### W1.1 — Promover helper

**Archivo**: `mcp-servers/wasiai-x402/src/balance-guard.mjs`

**Cambio quirúrgico**:

1. Línea 70-76: renombrar `function _usdcToWei(usdcNumber)` → `export function usdcToWei(usdcNumber)`.
2. Línea 217 (busqueda interna): si hay alguna llamada a `_usdcToWei(threshold)`, cambiar a `usdcToWei(threshold)`.
3. Línea 264: `_testHelpers` debe seguir exponiendo el mismo símbolo. Re-export:
   ```js
   export const _testHelpers = { _weiToUsdc, _usdcToWei: usdcToWei };
   ```
   Esto preserva los tests existentes que importan `_testHelpers._usdcToWei`.

**NO tocar**: `_weiToUsdc`, `getOperatorBalance`, `isCircuitOpen`, `checkBalanceWithClaim`, `releaseClaim`, snapshot logic (líneas 148-184), claim atomic INCRBY (líneas ~190-240).

**Validación adversarial intencional**: el helper actual usa `Number(usdcNumber).toFixed(USDC_DECIMALS)` (línea 72). Esto **NO coerciona objetos via `valueOf`** porque `Number({valueOf:()=>0.5})` → 0.5 pero `toFixed` requiere number primitive — y `Number(...)` ya lo coerced. **Por eso CD-22 exige validar `typeof maxBudget === 'number' && Number.isFinite(maxBudget) && maxBudget > 0 && maxBudget < 1_000_000` ANTES de llamar `usdcToWei` en `handlers.mjs`** — el helper es robusto pero el handler es la barrera principal.

### W1.2 — Tests sanity

```bash
npm run test:balance-guard 2>&1 | tail -20
npm run test:stress 2>&1 | tail -10
```

**Done Definition W1**:
- `usdcToWei` exportado público.
- `_testHelpers._usdcToWei` sigue funcionando (tests legacy NO rompen).
- T-BG-01..T-BG-10 + T-CS-01/T-CS-02 pasan idénticos.
- 0 cambios en `checkBalanceWithClaim`, `releaseClaim`, snapshot freshness logic.

**Escalation W1**: Si más de 1 test de balance-guard rompe, STOP, reportar [BLOCKER export drift].

---

## 6. Wave 2 — Insertar balance-gate INSIDE `payX402Handler`

> Depende de W1. **Esta es la wave crítica del fix.**

### W2.1 — Imports al tope de `src/handlers.mjs`

Agregar (preservando los imports existentes):

```js
import { checkBalanceWithClaim, releaseClaim, usdcToWei } from './balance-guard.mjs';
import { getKvClient } from './kv-client.mjs';
import { getAvaxClient } from './avax-client.mjs';
```

### W2.2 — Insertar bloque `[1.5] Balance-gate` en `payX402Handler`

**Insertion point exacto**: entre línea ~343 (`if (!accepts || !accepts.payTo || !accepts.maxAmountRequired)`) y línea ~359 (`// [2] Cap guard (AC-11) BEFORE signing`).

Pseudocódigo del bloque (Dev traduce a JS válido):

```text
// [1.5] Balance-gate (WKH-67) — runs AFTER probe parsing, BEFORE cap guard.
// CD-20: maxBudget (OUTBOUND USDC 6d) is the source-of-truth for the
// balance gate. NEVER use args.maxAmountWei here — that's the PYUSD 18d
// inbound cap guard handled at [2].

// CD-22: validate payload.maxBudget BEFORE conversion.
const maxBudget = payload?.maxBudget;
if (typeof maxBudget !== 'number'
    || !Number.isFinite(maxBudget)
    || maxBudget <= 0
    || maxBudget >= 1_000_000) {
  return {
    ok: false,
    stage: 'balance-gate',
    error: 'invalid or missing payload.maxBudget',
  };
}

// Derive operator + chainId + usdcAddress + rpcUrl + threshold from cfg+env.
// Same shape as the WKH-66 wrapper that this block replaces.
const operator = cfg.operatorAddress;
if (!operator) {
  log.error('mcp.balance.operator-derive-failed', {
    stage: 'balance-gate', error: 'cfg.operatorAddress missing',
  });
  return { ok: false, stage: 'balance-gate', error: 'operator derivation failed' };
}

const chainId = parseInt(process.env.MCP_OPERATOR_CHAIN_ID ?? '43114', 10);
const usdcAddress = process.env.AVALANCHE_USDC_ADDRESS
  ?? '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
const rpcUrl = process.env.AVALANCHE_RPC_URL
  ?? 'https://api.avax.network/ext/bc/C/rpc';

const thresholdRaw = process.env.MCP_BALANCE_THRESHOLD_USDC ?? '0.50';
const threshold = parseFloat(thresholdRaw);
if (!Number.isFinite(threshold) || threshold < 0) {
  log.error('mcp.balance-gate.invalid-threshold', {
    thresholdRaw, stage: 'config', ok: false,
  });
  return { ok: false, stage: 'balance-gate', error: 'invalid threshold config' };
}

const requestedWei = usdcToWei(maxBudget);  // BigInt USDC 6d wei
const kv = getKvClient();
const publicClient = getAvaxClient(rpcUrl);

const gate = await checkBalanceWithClaim({
  operator,
  chainId,
  requestedWei,
  threshold,
  kvClient: kv,
  publicClient,
  usdcAddress,
});
if (!gate.ok) return gate;
```

**Naming**: usar `requestedWei` (NO `requestedUsdcWei`, NO `outboundUsdcWei`) para que el `releaseClaim` lo refiera con el mismo nombre — consistencia interna.

### W2.3 — try/finally wrapping cap guard + sign + settle

**Patrón obligatorio**: tras `if (!gate.ok) return gate;`, abrir `try { ... } finally { await releaseClaim({ claimKey: gate.claimKey, requestedWei, kvClient: kv }); }`. El `try` envuelve **TODO desde la línea ~359 hasta el último `return` happy path (~482)**.

**Cuidado especial**:
- Cada `return` dentro del try (cap-guard reject ~373, sign error ~410, redirect-refused settle ~452, settle error ~458, settle non-200 ~470, success ~474) DEBE pasar por el `finally` automáticamente — eso es semántica nativa de JS try/finally. NO hace falta refactor de los return paths.
- El `finally` **NO debe loguear secrets**. `releaseClaim` ya es best-effort y solo loguea `error: e?.message ?? 'unknown'` (CD-8 cumplido).
- NO usar `try/catch` que swallow exceptions — solo `try/finally`. Si la function actualmente captura sus errors via `try { ... } catch (e) { return {ok:false} }` localmente (sign block, settle block), MANTENER esos catches anidados — el outer `try { ... } finally { releaseClaim }` envuelve el conjunto.
- Estructura final esperada del bloque:

```text
const gate = await checkBalanceWithClaim({...});
if (!gate.ok) return gate;

try {
  // [2] Cap guard (UNCHANGED) — usa args.maxAmountWei como antes.
  // ...
  // [3] Sign (UNCHANGED) — try/catch interno preservado.
  // ...
  // [4] Settle (UNCHANGED) — try/catch interno preservado.
  // ...
  return { ok: true, stage: 'settled', ... };  // último return happy path
} finally {
  await releaseClaim({
    claimKey: gate.claimKey,
    requestedWei,
    kvClient: kv,
  });
}
```

### W2.4 — Update `TOOL_DESCRIPTORS.pay_x402` (`src/handlers.mjs:514-530`)

Cambios exactos:

1. **`description`** (línea 515) reemplazar por:
   ```
   'Execute a full x402 payment flow: probe → balance-gate (USDC outbound) → sign EIP-3009 → retry. Required: payload.maxBudget (USDC number, OUTBOUND budget cap). Optional: maxAmountWei (PYUSD wei BigInt-string, defensive cap on INBOUND challenge).'
   ```

2. **`inputSchema.properties.payload`** (línea 521) reemplazar por:
   ```js
   payload: {
     type: 'object',
     description: 'Request body sent to the paid endpoint. Must include maxBudget when the endpoint requires payment.',
     properties: {
       maxBudget: {
         type: 'number',
         description: 'OUTBOUND budget cap in USDC (e.g. 0.5). Required when endpoint requires payment. Used by balance-gate to reserve a claim against operator wallet (Avalanche C-Chain mainnet, USDC 6 decimals).',
       },
     },
     additionalProperties: true,
   },
   ```
   `additionalProperties: true` se preserva — el caller sigue pasando cualquier body además de `maxBudget`.

3. **`inputSchema.properties.maxAmountWei`** (línea 522-525) reemplazar `description` por:
   ```
   'Defensive cap on INBOUND challenge in wei (e.g. PYUSD 18 decimals on Kite testnet). Optional. Independent of payload.maxBudget — guards against anomalous 402 challenges. Priority: per-call > MCP_MAX_AMOUNT_WEI_DEFAULT > undefined.'
   ```

NO tocar `required: ['endpoint']` ni `additionalProperties: false` del nivel root.

### W2.5 — Sanity check intermedio

```bash
node -e "import('./src/handlers.mjs').then(m => console.log(typeof m.payX402Handler, typeof m.TOOL_DESCRIPTORS))"
```

(Espera output `function object` — verifica que el módulo carga.)

**Done Definition W2**:
- `payX402Handler` tiene bloque `[1.5] Balance-gate` post-probe / pre-cap-guard.
- `try/finally` envuelve cap guard + sign + settle + return.
- `TOOL_DESCRIPTORS.pay_x402` actualizado.
- Imports nuevos al tope. NO duplicados.
- `npm test` puede romper temporalmente acá (T-HTTP-14 todavía pasa con runWithBalanceGate hasta W3).

**Escalation W2**: Si no podés implementar `releaseClaim exactly-once` en algún path, STOP, reportar [BLOCKER finally scope]. Si tenés que tocar `src/sign.mjs`/`src/log.mjs`/etc., STOP, reportar [BLOCKER CD-1 scope creep].

---

## 7. Wave 3 — Eliminar wrapper externo `runWithBalanceGate`

> Depende de W2.

### W3.1 — Eliminar función + imports en `api/mcp.mjs`

**Archivo**: `mcp-servers/wasiai-x402/api/mcp.mjs`

1. **Eliminar** función completa `export async function runWithBalanceGate(args, cfg, runHandler) { ... }` líneas 106-194. Eliminar también el comentario `// ── WKH-66 W2.5: balance gate wrapper for pay_x402 (DT-J §11) ─────────────` y todo su bloque docstring.

2. **Imports a eliminar** (líneas 54-58):
   - `checkBalanceWithClaim, releaseClaim` (de `'./../src/balance-guard.mjs'` o ruta similar — verificar import actual).
   - `getAvaxClient` (de `'./../src/avax-client.mjs'`).

   Antes de eliminar, hacer `grep` para confirmar que esos símbolos NO se usan en otra parte de `api/mcp.mjs`. Si alguno se usa en otro lado (e.g. `getKvClient` se usa para rate-limit), MANTENER ese.

3. **`getKvClient`** (línea ~52) — verificar si rate-limit u otra parte sigue usándolo. Si sí, **mantener el import**. Si no, eliminar.

### W3.2 — Simplificar case `'pay_x402'`

**Archivo**: `mcp-servers/wasiai-x402/api/mcp.mjs`, líneas 222-227.

Reemplazar:

```js
case 'pay_x402': {
  // WKH-66 W2.5 — Balance gate + atomic claim wrapper (DT-J §11).
  // Insert-only: payX402Handler itself stays untouched (CD-1).
  const gateResult = await runWithBalanceGate(args, cfg, () => payX402Handler(args, cfg));
  return asToolResult(gateResult);
}
```

Por:

```js
case 'pay_x402': {
  // WKH-67 — balance-gate now lives INSIDE payX402Handler (post-probe,
  // pre-cap-guard). Both stdio and HTTP transports share the same gating
  // path. See doc/sdd/072-wkh-67-balance-gate-decimals/sdd.md §7.2.
  const r = await payX402Handler(args, cfg);
  return asToolResult(r);
}
```

Esto alinea con el path stdio en `src/index.mjs:101-104`.

### W3.3 — Sanity

```bash
node -e "import('./api/mcp.mjs').then(m => console.log(Object.keys(m)))"
```

(Confirma que el módulo carga sin `runWithBalanceGate` exportado.)

**Done Definition W3**:
- `runWithBalanceGate` ya NO existe en `api/mcp.mjs`.
- `case 'pay_x402'` llama directo a `payX402Handler(args, cfg)`.
- Imports limpios (solo lo que se usa).
- T-HTTP-14 va a romper hasta W4.4 — esperado.

**Escalation W3**: Si tras eliminar `runWithBalanceGate`, OTROS tests rompen además de T-HTTP-14 y T-BG-11/T-BG-11b, STOP, reportar [BLOCKER ripple effect] + lista de tests rotos.

---

## 8. Wave 4 — Tests nuevos + adaptación

> Depende de W3.

### W4.1 — `tests/handlers-balance-gate.test.mjs` (NUEVO) — 11 tests core

**Archivo nuevo**: `mcp-servers/wasiai-x402/tests/handlers-balance-gate.test.mjs`.

**Exemplar a seguir**: `tests/tools.test.mjs:175-210` (T29 patrón `makeFetchFake` → override `globalThis.fetch` → llamar `payX402Handler`). Para mock RPC eth_call de balance: `tests/http.test.mjs:673-684` (intercept fetch para `avax.network`).

**Setup común** (helper local del archivo):
- Importar `payX402Handler` desde `../src/handlers.mjs`.
- Importar `setKvClientForTesting` desde `../src/kv-client.mjs` (verificar nombre exacto en `src/kv-client.mjs`).
- Importar `createKvMock` desde `_mocks/kv-mock.mjs`.
- Importar `_testHelpers` desde `../src/balance-guard.mjs` para verificar `_usdcToWei` consistency (opcional).
- Helper `fakeConfig()` similar al de `tools.test.mjs`.
- Helper `makeFetchFake([{status, body}, ...])` que también intercepta el RPC eth_call de balance (responde con balance USDC mockeado en hex).
- En cada test: `setKvClientForTesting(createKvMock())` → `process.env.MCP_BALANCE_THRESHOLD_USDC = '0.50'` → `process.env.MCP_OPERATOR_CHAIN_ID = '43114'` → llamar handler → assert.

| Test ID | AC | Descripción | Mock setup | Assertion clave |
|---------|----|-------------|------------|-----------------|
| **T-FIX-01** | AC-1 | Happy path: `payload.maxBudget=0.5` sin `maxAmountWei`, balance OK ($1 USDC) → settled | RPC mock balance=`0x0F4240` (1_000_000n = 1 USDC); fetch fake [402 con accepts.maxAmountRequired='1000000000000000000', 200 settle] | `result.ok === true && result.stage === 'settled'`; `kv.incrby` invocado con `500_000n`; `kv.decrby` invocado con `500_000n` (release) |
| **T-FIX-02** | AC-2 | Balance-gate compara con USDC balance real (no PYUSD): balance 0.4 USDC, threshold 0.5 → `below threshold` | RPC mock balance=`0x061A80` (400_000n = 0.4 USDC); `payload.maxBudget=0.05` | `result.ok === false && result.stage === 'balance-gate'`; spy `checkBalanceWithClaim` recibe `requestedWei === 50_000n` (NO `50_000_000_000_000_000n`) |
| **T-FIX-03** | AC-3 | Sign-guard regression: `maxBudget=0.5` + `maxAmountWei='100000000000000000'` (10^17) + accepts.maxAmountRequired='1000000000000000000' (10^18) → reject `stage:'sign'` | RPC balance OK; fetch fake [402, ...] | `result.ok === false && result.stage === 'sign' && /amount exceeds maxAmountWei guard/.test(result.error)` |
| **T-FIX-04** | AC-5 | Ordering: probe → balance-gate → cap guard → sign → settle | Spy de fetch + KV INCRBY order | call-log: fetch[probe] before kv.incrby before kv.set (sign log) before fetch[settle] |
| **T-FIX-05** | AC-6 | Release on success: `kv.decrby` invocado UNA VEZ con `requestedWei`=`100_000n` | `payload.maxBudget=0.1`, balance OK, settle 200 | `kvMock.decrby.callCount === 1`; arg = (key, 100_000) |
| **T-FIX-06** | AC-6 | Release on settle error 400 | `payload.maxBudget=0.1`, balance OK, settle 400 | `kvMock.decrby.callCount === 1` |
| **T-FIX-07** | AC-6 | Release on sign error: mock que `signX402Envelope` throw | usar mock viem si posible, o forzar `cfg` sin operator PK | `result.stage === 'sign'`; `kvMock.decrby.callCount === 1` |
| **T-FIX-08** | AC-7 | Invalid maxBudget post-probe: `payload.maxBudget=undefined/null/NaN` → reject `stage:'balance-gate'` después del probe 402 | fetch fake [402 con accepts válido] | `result.stage === 'balance-gate'`; `/invalid or missing payload.maxBudget/.test(result.error)`; sign NO invocado |
| **T-FIX-09** | AC-7 | KV null fail-secure: `setKvClientForTesting(null)` → balance-gate rechaza | fetch fake [402] | `result.stage === 'balance-gate' && /balance check unavailable/.test(result.error)` |
| **T-FIX-10** | AC-7 | Invalid threshold env: `MCP_BALANCE_THRESHOLD_USDC='abc'` → reject | fetch fake [402] | `result.stage === 'balance-gate' && /invalid threshold/i.test(result.error)` |
| **T-FIX-11** | AC-1 (free) | Free endpoint: probe 200 → `stage:'free'` SIN tocar balance-gate | fetch fake [200 body cualquiera] | `result.ok === true && result.stage === 'free'`; `kvMock.incrby.callCount === 0` |

### W4.2 — Tests adversariales T-FIX-12..14

| Test ID | Vector | Descripción | Assertion |
|---------|--------|-------------|-----------|
| **T-FIX-12** | V9 | `payload.maxBudget` adversarial: subtests parametrizados con `[Infinity, -Infinity, NaN, 1e308, -1, 0, '0.5', null, undefined, {}, [], [0.5], Symbol(), {valueOf:()=>0.5}, {__proto__:{maxBudget:0.5}}]` → cada uno reject `balance-gate` | Para cada input: `result.stage === 'balance-gate'`; sign NO invocado; `kvMock.incrby.callCount === 0` |
| **T-FIX-13** | V1 (drain prevention) | Caller declara `payload.maxBudget=999` con balance $4.756 USDC → reject (CAS-revert o below-threshold) | RPC mock balance=`0x489640` (4_756_000n); `payload.maxBudget=999` | `result.ok === false && result.stage === 'balance-gate'`; sign NO invocado |
| **T-FIX-14** | V7 (documentado, NO regression) | `payload.maxBudget=0.5` USDC + `accepts.maxAmountRequired='1000000000000000000'` PYUSD wei sin `maxAmountWei` ni `cfg.maxAmountWeiDefault` → balance-gate aprueba, cap guard bypass, sign procede | balance OK; settle 200 | `result.ok === true && result.stage === 'settled'`. Documenta el contrato: maxBudget cubre OUTBOUND, caller acepta INBOUND |

### W4.3 — `tests/balance-guard.test.mjs` — limpieza T-BG-11/T-BG-11b

**Archivo**: `mcp-servers/wasiai-x402/tests/balance-guard.test.mjs`

1. Eliminar línea 20 (o donde esté) `import { runWithBalanceGate } from '../api/mcp.mjs';`.
2. Eliminar tests T-BG-11 y T-BG-11b (líneas 286-321 aproximadas — verificar nombres exactos `MCP_BALANCE_THRESHOLD_USDC` invalid → ...).
3. **NO tocar** T-BG-01..T-BG-10.
4. La cobertura de `MCP_BALANCE_THRESHOLD_USDC inválido` se mantiene vía **T-FIX-10** en el archivo nuevo.

### W4.4 — `tests/http.test.mjs` T-HTTP-14 update

**Archivo**: `mcp-servers/wasiai-x402/tests/http.test.mjs`, líneas 660-718.

Cambiar el body JSON-RPC del request bajo test:

ANTES (algo como):
```js
arguments: { endpoint: '/api/v1/orchestrate', maxAmountWei: '100000' }
```

DESPUÉS:
```js
arguments: { endpoint: '/api/v1/orchestrate', payload: { maxBudget: 0.1 } }
```

Y agregar `process.env.MCP_BALANCE_THRESHOLD_USDC = '0.5'` al setup si no estaba (para que threshold > balance mockeado simule el reject).

**NO tocar**: T-HTTP-13 (rate-limit), T-HTTP-15 (discover_agents bypass), ni el resto de tests del archivo.

### W4.5 — `tests/concurrent-stress.test.mjs` — verificar pass

**No modificar**. Solo correr:

```bash
npm run test:stress 2>&1 | tail -20
```

T-CS-01/T-CS-02 testean `checkBalanceWithClaim` directo (no `runWithBalanceGate` ni handler) → deben pasar idénticos. Si rompen, STOP, reportar [BLOCKER stress regression].

### W4.6 — Full suite

```bash
npm test 2>&1 | tail -30
```

**Done Definition W4**:
- `tests/handlers-balance-gate.test.mjs` existe con T-FIX-01..T-FIX-14 (11-14 tests).
- `tests/balance-guard.test.mjs` sin import roto.
- `tests/http.test.mjs` T-HTTP-14 adapatado.
- `npm test` → ≥184 tests pass, 0 fail, 0 skip injustificado.

**Escalation W4**: Si tras adaptar tests siguen rojos > 5 tests baseline, STOP, reportar [BLOCKER refactor breaks baseline] + lista.

---

## 9. Wave 5 — README + smoke prep doc

> Depende de W4. Paralelizable.

### W5.1 — `README.md` (subpaquete)

**Archivo**: `mcp-servers/wasiai-x402/README.md`

Sección "Tools / pay_x402" — documentar:

- `payload.maxBudget` (number, USDC, OBLIGATORIO si endpoint requiere pago) = source-of-truth para el balance-gate OUTBOUND. Avalanche C-Chain mainnet, 6 decimales.
- `args.maxAmountWei` (string BigInt-parseable o number, PYUSD wei, OPCIONAL) = cap defensivo del sign guard INBOUND contra challenges 402 anómalos. Kite testnet, 18 decimales.
- **Ejemplo 1** — caller solo declara budget OUTBOUND (caso típico):
  ```json
  {
    "endpoint": "/api/v1/orchestrate",
    "payload": { "maxBudget": 0.5, "task": "..." }
  }
  ```
- **Ejemplo 2** — caller también pasa cap defensivo INBOUND:
  ```json
  {
    "endpoint": "/api/v1/orchestrate",
    "payload": { "maxBudget": 0.5, "task": "..." },
    "maxAmountWei": "1000000000000000000"
  }
  ```
- Nota explícita: NO confundir las dos dimensiones. `maxBudget` siempre USDC. `maxAmountWei` siempre PYUSD wei.

### W5.2 — `doc/sdd/072-wkh-67-balance-gate-decimals/smoke-prep.md` (NUEVO)

**Archivo nuevo**. Contenido:

```markdown
# Smoke prep — WKH-67 mainnet $0.061 USDC (W6 / F4 / orquestador)

> Este doc lo lee el orquestador POST-MERGE. F3 NO ejecuta el smoke real.
> CD-24: one-shot, ≤ $0.10 USDC, autorización humana explícita por re-run.

## Pre-requisitos

- Branch mergeado a main, deploy Vercel `wasiai-x402-mcp.vercel.app/api/mcp` activo (NO el rolled-back `wasiai-x402-ah0gufv0p`).
- Cron-job.org jobs DISABLED hasta que smoke pase (AC-13 los re-habilita después).
- Operator wallet con balance > $0.55 USDC mainnet (threshold 0.5 + smoke 0.05 + buffer).
- Bearer token `MCP_BEARER_TOKEN` válido (rotated WKH-66 si aplica).

## Body JSON-RPC del smoke

POST `https://wasiai-x402-mcp.vercel.app/api/mcp` con headers:
- `Authorization: Bearer <MCP_BEARER_TOKEN>`
- `Content-Type: application/json`

Body:
{
  "jsonrpc": "2.0",
  "id": "smoke-wkh-67",
  "method": "tools/call",
  "params": {
    "name": "pay_x402",
    "arguments": {
      "endpoint": "/api/v1/orchestrate",
      "payload": { "maxBudget": 0.05, "task": "smoke-test-wkh-67" }
    }
  }
}

## Resultado esperado

- HTTP 200, body con `result.content[0].text` parseado a `{ ok: true, stage: 'settled', kiteTxHash: '0x...', latencyMs: <int> }`.
- Tx hash visible en Avalanche explorer (https://snowtrace.io/tx/0x...).
- Balance pre/post snapshot: documentar en done-report.md (delta ≤ $0.061 USDC).

## Post-smoke

1. Re-enable cron-job.org via `node scripts/setup-cronjob.mjs` (AC-13).
2. Escribir done-report.md con tx hash + balance pre/post + deploy URL + PR URL (AC-15).
3. Escribir auto-blindaje.md con lección decimals separation (AC-14, CD-25).

## NO HACER en F3

- NO ejecutar este smoke en F3.
- NO incluir el smoke en CI.
- NO re-correr sin autorización humana explícita (cada run cuesta plata real).
```

**Done Definition W5**:
- README documenta `maxBudget` vs `maxAmountWei` con 2 ejemplos.
- `smoke-prep.md` existe con body JSON-RPC + resultado esperado + plan post-smoke.
- NO se ejecuta smoke real.

---

## 10. Test plan ejecutable consolidado

| Test ID | AC | Archivo | Wave | Mock principal | Assertion |
|---------|----|---------|------|----------------|-----------|
| T-FIX-01 | AC-1 | `tests/handlers-balance-gate.test.mjs` | W4.1 | RPC balance 1 USDC + fetch [402, 200] | settled |
| T-FIX-02 | AC-2 | idem | W4.1 | RPC balance 0.4 USDC | requestedWei = 50_000n; below threshold |
| T-FIX-03 | AC-3 | idem | W4.1 | RPC OK; maxAmountWei < accepts | sign reject |
| T-FIX-04 | AC-5 | idem | W4.1 | spy fetch + kv | call order: probe < incrby < settle |
| T-FIX-05 | AC-6 | idem | W4.1 | settle 200 | decrby 1 vez |
| T-FIX-06 | AC-6 | idem | W4.1 | settle 400 | decrby 1 vez |
| T-FIX-07 | AC-6 | idem | W4.1 | sign throw | decrby 1 vez |
| T-FIX-08 | AC-7 | idem | W4.1 | maxBudget invalid | balance-gate reject |
| T-FIX-09 | AC-7 | idem | W4.1 | kv = null | balance check unavailable |
| T-FIX-10 | AC-7 | idem | W4.1 | THRESHOLD='abc' | invalid threshold |
| T-FIX-11 | AC-1 | idem | W4.1 | probe 200 | stage:'free'; no incrby |
| T-FIX-12 | V9 | idem | W4.2 | adversarial inputs | reject all |
| T-FIX-13 | V1 | idem | W4.2 | maxBudget=999 vs balance 4.756 | reject |
| T-FIX-14 | V7 | idem | W4.2 | misalignment doc | settled (documenta contrato) |
| T-CS-01 | AC-8 | `tests/concurrent-stress.test.mjs` | W4.5 | NO TOCAR | (existing) atomicity |
| T-CS-02 | AC-8 | idem | W4.5 | NO TOCAR | (existing) stale snapshot |
| T-BG-01..10 | AC-8 | `tests/balance-guard.test.mjs` | W4.5 | NO TOCAR | (existing) |
| T-HTTP-14 | AC-2 (HTTP) | `tests/http.test.mjs` | W4.4 | adaptar body JSON-RPC | balance-gate via HTTP |
| T-HTTP-13/15 | AC-10 | idem | W4.5 | NO TOCAR | rate-limit + bypass |
| T-X1..T-X5, T-Y1, T-Z1, T-X11..T-X14, T-MNR-iter2-1 | AC-8 | `tests/tools.test.mjs`, `tests/url-validator.test.mjs`, `tests/sign.test.mjs` | W4.5 | NO TOCAR | (existing) BLQs WKH-64/65 |

---

## 11. Adversary Directives (copia literal §13 SDD)

> AR debe atacar cada vector. **BLOQUEANTES**: V1, V2, V5, V6, V7, V8.

| # | Vector | Cómo atacar | Test que debería atrapar |
|---|--------|-------------|--------------------------|
| **V1** (BLOQ) | Drain primitive re-introduction | Caller declara `payload.maxBudget=999` con balance $4.756 USDC. ¿El balance-gate rechaza? Verify: `maxClaimableWei = balanceWei - thresholdWei = 4_256_000n`. `requestedWei = 999_000_000n` → `claimedTotalWei > maxClaimableWei` (post-INCRBY) → rechaza con CAS-revert. | T-FIX-13 |
| **V2** (BLOQ) | PYUSD vs USDC decimals confusion | ¿`requestedWei` que llega a `checkBalanceWithClaim` es 6d (USDC) y NO 18d (PYUSD)? Spy el call y verify magnitud. | T-FIX-02 |
| V3 | Race probe-vs-balance | Probe consume tiempo. Entre probe y balance-gate, ¿la balance puede cambiar? Sí, pero `checkBalanceWithClaim` lee balance en el momento de la llamada (snapshot fresh ≤30s o RPC). El claim atómico KV serializa concurrent calls. | T-CS-01 + T-CS-02 + T-FIX-04 |
| V4 | Concurrent claim contention sigue OK | ¿Mover el balance-gate del wrapper al handler rompe la atomicidad? NO — `checkBalanceWithClaim` es el mismo módulo, mismo INCRBY. T-CS-01 NO requiere cambio. | T-CS-01 |
| **V5** (BLOQ) | Regression WKH-64 (5 BLQs) | ¿isPathOnly + resolveEndpoint + redirect:'error' + sign sanitization + signature truncation siguen intactos? AR debe grep `redirect: 'error'` (4 ocurrencias en `src/handlers.mjs`), `'signing failed (see stderr logs)'`, `TRUNCATE_KEYS_SHORT`. | T-X1..T-X5, T-Y1, T-Z1 (NO se tocan) |
| **V6** (BLOQ) | Regression WKH-65 (BLQ-iter3-1) | `redirect:'error'` en las 4 fetch — verificar que el insertion del balance-gate NO modifica esas líneas. | T-X11..T-X14 (NO se tocan) |
| **V7** (BLOQ) | Regression WKH-66 (BLQ-ALTO-1) | snapshot freshness 30s — `src/balance-guard.mjs` NO se modifica fuera del export `usdcToWei`. AR debe diff `src/balance-guard.mjs` línea por línea. | T-BG-09, T-BG-10, T-CS-02 (NO se tocan) |
| **V8** (BLOQ) | CD-1 lift mal contenido | AR diff PR completo: SOLO se tocan `src/handlers.mjs`, `src/balance-guard.mjs`, `api/mcp.mjs`, tests (`handlers-balance-gate.test.mjs` NEW + `balance-guard.test.mjs` minor + `http.test.mjs` minor), README, `doc/sdd/072-.../smoke-prep.md`. CUALQUIER cambio en `src/sign.mjs`, `src/url-validator.mjs`, `src/auth.mjs`, `src/log.mjs`, `src/config.mjs`, `src/index.mjs`, `src/kv-client.mjs`, `src/rate-limit.mjs`, `src/cron-auth.mjs`, `src/alerts.mjs`, `src/avax-client.mjs`, `api/cron/*`, `vercel.json`, `package.json` es BLOQUEANTE. | AR diff manual |
| V9 | maxBudget adversarial inputs | NaN, Infinity, -Infinity, -1, 0, 1e308, '0.5' (string), null, undefined, {}, [], [0.5], Symbol(), `{valueOf:()=>0.5}`, prototype pollution `__proto__:{maxBudget:0.5}`. CD-22 dice `typeof === 'number' && Number.isFinite(x) && x > 0 && x < 1_000_000`. **`Number.isFinite` NO coerce — solo acepta number primitive — `typeof === 'number'` es belt-and-suspenders.** | T-FIX-12 |
| V10 | Orphan claim | ¿Cada return path post-balance-gate-OK pasa por finally? AR enumera: cap guard reject, sign exception, settle exception, redirect-refused, settle 4xx/5xx, settle 200 (success). Total: 6 paths. Cada uno DEBE pasar por finally. | T-FIX-05/06/07 + AR diff |

---

## 12. Constraint Directives críticos para el Dev (subset operativo)

- **CD-1 (UPDATED)**: PROHIBIDO modificar archivos del Scope OUT (§3). PERMITIDO `src/handlers.mjs`, `src/balance-guard.mjs`, `api/mcp.mjs` SOLO en el scope estricto descrito.
- **CD-2**: balance-gate fail-secure. Cualquier fallo de balance read / KV / claim / maxBudget invalid → reject `stage:'balance-gate'`. PROHIBIDO firmar en condición de incertidumbre.
- **CD-7**: tests con mocks 100%. PROHIBIDO mainnet en tests.
- **CD-8**: logs JSON via `src/log.mjs`. PROHIBIDO `console.*`.
- **CD-9 (UPDATED)**: ≥184 tests passing post-implementación. PROHIBIDO commit con tests rojos.
- **CD-10**: PROHIBIDO loggear secrets (PK, bearer, CRON_SECRET, KV token, webhook URL).
- **CD-13**: claim KV TTL ≤ 60s. NO tocar.
- **CD-17**: PROHIBIDO `event:` dentro del payload de `log.{info,warn,error}`. AR/CR grep.
- **CD-18**: `fetch()` con headers sensibles → `redirect:'error'`. NO modificar.
- **CD-20 (NEW)**: PROHIBIDO usar el mismo arg como input de DOS guards en cadenas/decimales distintos. `args.maxAmountWei` SOLO en cap guard PYUSD. `payload.maxBudget` SOLO en balance-gate. AR/CR grep ambos. Cross-uso = BLOQUEANTE.
- **CD-21 (NEW)**: balance-gate DESPUÉS del probe Y ANTES del cap guard. Otra ubicación = BLOQUEANTE.
- **CD-22 (NEW)**: validación `typeof maxBudget === 'number' && Number.isFinite(maxBudget) && maxBudget > 0 && maxBudget < 1_000_000`.
- **CD-23 (NEW)**: `releaseClaim` exactly-once via `try/finally` interno. Double-release o no-release = BLOQUEANTE.

---

## 13. Done Definition por wave

| Wave | Criterio de done |
|------|------------------|
| **W0** | Branch `fix/072-wkh-67-balance-gate-decimals` checked-out desde `main@b095b80` (o descendiente). `npm test` baseline ≥173 pass / 0 fail. `git status` clean. |
| **W1** | `usdcToWei` exportado público en `src/balance-guard.mjs`. `_testHelpers._usdcToWei` retro-compat. `npm run test:balance-guard` y `npm run test:stress` pasan idénticos. |
| **W2** | `payX402Handler` con bloque `[1.5] Balance-gate` post-probe / pre-cap-guard. `try/finally` envolviendo cap+sign+settle+return final. `TOOL_DESCRIPTORS.pay_x402` actualizado. Imports limpios. |
| **W3** | `runWithBalanceGate` ELIMINADO de `api/mcp.mjs`. `case 'pay_x402'` simplificado a `payX402Handler(args, cfg)`. Imports muertos eliminados. |
| **W4** | `tests/handlers-balance-gate.test.mjs` creado con T-FIX-01..T-FIX-14 (11-14 tests). T-BG-11/T-BG-11b eliminados de `tests/balance-guard.test.mjs`. T-HTTP-14 actualizado. `npm test` reporta ≥184 pass, 0 fail. |
| **W5** | `README.md` documenta `maxBudget` vs `maxAmountWei` con 2 ejemplos. `doc/sdd/072-.../smoke-prep.md` creado. |

---

## 14. Forbidden actions (PROHIBIDO en F3)

- ❌ NO modificar `src/sign.mjs`, `src/url-validator.mjs`, `src/auth.mjs`, `src/config.mjs`, `src/log.mjs`, `src/index.mjs`, `src/kv-client.mjs`, `src/rate-limit.mjs`, `src/cron-auth.mjs`, `src/alerts.mjs`, `src/avax-client.mjs`. CD-1 sigue inviolable salvo `handlers.mjs` + `balance-guard.mjs` + `api/mcp.mjs`.
- ❌ NO modificar `api/cron/warmup.mjs`, `api/cron/balance-check.mjs`.
- ❌ NO modificar `vercel.json`, `package.json`, `.env.example`.
- ❌ NO publicar a npm.
- ❌ NO ejecutar tests reales sobre mainnet (CD-7). Todo mock.
- ❌ NO commitear secrets (PK, bearer, CRON_SECRET, KV token, webhook URL). Verificar `.gitignore` antes de commit.
- ❌ NO usar `console.log/.error/.warn` directo. Solo `src/log.mjs`.
- ❌ NO migrar a TypeScript. NO migrar a vitest. `.mjs` + `node:test` siempre.
- ❌ NO ejecutar `vercel deploy` (post-merge orquestador).
- ❌ NO crear PR (eso es DONE — orquestador post-F4).
- ❌ NO ejecutar smoke real $0.061 USDC mainnet (es W6/F4 humano-gated).
- ❌ NO modificar el shape de `inputSchema.properties.payload` más allá de agregar `maxBudget` documentado (preservar `additionalProperties:true`).
- ❌ NO cambiar nombres de eventos de log existentes (`tool.pay_x402.*`, `mcp.balance.*`).

---

## 15. Escalation conditions (cuándo parar y reportar)

| Condición | Acción |
|-----------|--------|
| W0 baseline tests fail >2 retries | STOP, reportar `[BLOCKER baseline]` con tail del output. |
| Refactor de W2/W3 rompe >5 tests baseline distintos a T-HTTP-14/T-BG-11/T-BG-11b | STOP, reportar `[BLOCKER ripple effect]` + lista exacta de tests rotos. |
| `releaseClaim` no se puede llamar exactly-once en algún path enumerado en V10 | STOP, reportar `[BLOCKER finally scope]` + describir el path problemático. |
| Necesidad detectada de tocar archivo Scope OUT | STOP, reportar `[BLOCKER CD-1 scope creep]` + archivo + razón. |
| `usdcToWei` promotion rompe T-BG-01..T-BG-10 | STOP, reportar `[BLOCKER export drift]`. |
| Mock RPC para eth_call balance no es trivial de armar | STOP, reportar `[NEEDS HELP rpc mock]` con el snippet intentado. |

---

## 16. Pista final para el Dev — orden de ejecución sugerido

1. **W0**: branch + baseline. Si verde → adelante.
2. **W1**: `usdcToWei` export. Test sanity. Si verde → adelante.
3. **W2**: `handlers.mjs` insertion + try/finally + descriptors. NO correr tests todavía (T-HTTP-14 va a fallar hasta W4).
4. **W3**: limpiar `api/mcp.mjs`. Sanity de carga. Saltar a W4 directo.
5. **W4**: tests nuevos + adaptar T-HTTP-14 + eliminar T-BG-11. `npm test` → ≥184. Si verde → adelante.
6. **W5**: README + smoke-prep.md. Sin tests.
7. Reportar al orquestador con resumen de waves + tests count + diff size.

---

## 17. Referencias canónicas para Dev

- **Insertion point exemplar**: `api/mcp.mjs:106-194` (función completa `runWithBalanceGate`) — toda esa mecánica se mueve INSIDE `payX402Handler`.
- **Test exemplar happy path**: `tests/tools.test.mjs:175-210` (T29 `makeFetchFake` pattern).
- **Test exemplar balance-gate via HTTP**: `tests/http.test.mjs:660-718` (T-HTTP-14).
- **RPC mock pattern**: `tests/_mocks/rpc-mock.mjs` — verificar API.
- **KV mock pattern**: `tests/_mocks/kv-mock.mjs` — verificar API + setKvClientForTesting helper.
- **stdio path simplicado** (cómo debe quedar `case 'pay_x402'` en api/mcp.mjs): `src/index.mjs:101-104`.
- **Cap guard PYUSD intacto**: `src/handlers.mjs:359-380` — NO se modifica semánticamente.
- **redirect:'error' líneas a NO TOCAR**: `src/handlers.mjs:305, 444` (probe + settle de payX402) + las 2 de discoverAgents/getPaymentQuote.
- **SDD completo**: `doc/sdd/072-wkh-67-balance-gate-decimals/sdd.md` (lectura opcional para contexto extra; este Story File es self-contained).

---

*Story File generado por NexusAgil — Architect F2.5 — 2026-04-29*
*Status: READY_FOR_F3 — `nexus-dev` puede arrancar al recibir este artefacto.*
