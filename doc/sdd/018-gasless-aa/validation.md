# Validation Report — WKH-29 Gasless EIP-3009 (F4)

| Campo | Valor |
|-------|-------|
| HU | WKH-29 |
| Branch | `feat/018-gasless-aa` |
| Fase | F4 — QA Validation |
| Reviewer | QA |
| Fecha | 2026-04-06 |
| Base | ar-report.md (OK — veredicto v2) + cr-report.md (MENOR) |

---

## 1. AC Validation

### Tabla resumen

| AC | Enunciado (EARS — resumen) | Status | Evidencia Código | Evidencia Test |
|----|---------------------------|--------|-----------------|---------------|
| AC-1 | Sign EIP-3009 + POST → txHash | **PASS** | `gasless-signer.ts:231-258` | `gasless-signer.test.ts:191-217` |
| AC-2 | `signTypedData()` + `parseSignature()` → v/r/s | **PASS** | `gasless-signer.ts:187-207` | `gasless-signer.test.ts:127-186` |
| AC-3 | `validAfter = blockTs - 1`, `validBefore = validAfter + 25s` | **PASS** | `gasless-signer.ts:179-180` | `gasless-signer.test.ts:102-113` |
| AC-4 | Discovery `/supported_tokens` + cache + fallback + min validation | **PASS** | `gasless-signer.ts:143-162`, `gasless-signer.ts:88-92`, `gasless-signer.ts:175` | `gasless-signer.test.ts:60-125` |
| AC-5 | `GASLESS_ENABLED=true` → rutas registradas; default OFF | **PARTIAL** | `src/index.ts:59-62` | Sin test automático (deuda trazada CR-4.6) |
| AC-6 | Relayer error → log sanitizado, no crash | **PASS** | `gasless-signer.ts:94-99`, `gasless-signer.ts:242-248`, `gasless.ts:13-21` | `gasless-signer.test.ts:219-263` |
| AC-7 | `GET /gasless/status` → `{enabled, network, supportedToken, operatorAddress}` (no PK) | **PASS** | `gasless.ts:8-23`, `gasless-signer.ts:264-299` | `gasless-signer.test.ts:267-284` |

---

### Detalle por AC

#### AC-1: Gasless stablecoin transfer via EIP-3009 relayer
**WHEN** the system needs to transfer stablecoins gasless on Kite testnet, **THE SYSTEM SHALL** sign an EIP-3009 `TransferWithAuthorization` message and submit it to `https://gasless.gokite.ai/testnet`, receiving a `txHash` in response.

**Status**: PASS

**Evidencia código**: `src/lib/gasless-signer.ts:231-258` — `submitGaslessTransfer()` hace POST a `GASLESS_SUBMIT_URL` (L25: `https://gasless.gokite.ai/testnet`), valida respuesta 2xx, verifica `txHash.startsWith('0x')` y retorna `GaslessTransferResponse`.
```
gasless-signer.ts:25  const GASLESS_SUBMIT_URL = `${GASLESS_BASE_URL}/testnet`  // CD-8
gasless-signer.ts:236 res = await fetch(GASLESS_SUBMIT_URL, { method: 'POST', ...
gasless-signer.ts:252 const json = (await res.json()) as { txHash?: string }
gasless-signer.ts:257 return { txHash: json.txHash as `0x${string}` }
```

**Evidencia test**: `src/lib/gasless-signer.test.ts:191-217` — `'should return txHash from submitGaslessTransfer on 200'`: mockea fetch respondiendo `{ txHash: '0xdeadbeef' }`, verifica `r.txHash === '0xdeadbeef'`.

---

#### AC-2: EIP-712 signature compatible con viem
**WHEN** the gasless signer generates the `TransferWithAuthorization` signature, **THE SYSTEM SHALL** use viem's `signTypedData()` with the EIP-712 domain from `/supported_tokens` and decompose the signature into `v`, `r`, `s` via `parseSignature()` (post-AR v2: `hexToSignature` → `parseSignature`, drift intencional trazado).

**Status**: PASS

**Evidencia código**: `src/lib/gasless-signer.ts:10` importa `parseSignature` de `viem`; `gasless-signer.ts:187-207`:
```
gasless-signer.ts:10  import { createWalletClient, http, parseSignature } from 'viem'
gasless-signer.ts:187 const signature = await client.signTypedData({ account, domain: buildDomain(token), types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization', message: { ... } })
gasless-signer.ts:205 const parsed = parseSignature(signature)
gasless-signer.ts:206 const v = parsed.v !== undefined ? Number(parsed.v) : Number(parsed.yParity) + 27
```
`buildDomain()` en `gasless-signer.ts:75-82` usa `token.eip712Name`, `token.eip712Version`, `kiteTestnet.id` (2368), `token.address` — valores provenientes de `/supported_tokens`.

**Evidencia test**: `src/lib/gasless-signer.test.ts:127-186` — `'should decompose signature into valid v/r/s recoverable by signer'`:
- L138: `expect(Number.isFinite(r.v)).toBe(true)` — no NaN
- L139: `expect([27, 28]).toContain(r.v)` — v ∈ {27, 28}
- L142-143: regex `0x[0-9a-f]{64}` para r y s
- L157-186: `recoverTypedDataAddress` con el typed data exacto → address recuperada coincide con `privateKeyToAccount(TEST_PK).address` — verificación criptográfica end-to-end

---

#### AC-3: Temporal constraints respetadas
**WHEN** constructing the gasless transfer request, **THE SYSTEM SHALL** set `validAfter = latestBlockTimestamp - 1s` y `validBefore = validAfter + 25s`.

**Status**: PASS

**Evidencia código**: `src/lib/gasless-signer.ts:177-180`:
```
gasless-signer.ts:27  const VALIDITY_WINDOW_SECONDS = 25n  // CD-6
gasless-signer.ts:177 const block = await requireKiteClient().getBlock({ blockTag: 'latest' })
gasless-signer.ts:178 const blockTs = block.timestamp
gasless-signer.ts:179 const validAfter = blockTs - 1n
gasless-signer.ts:180 const validBefore = validAfter + VALIDITY_WINDOW_SECONDS
```

**Evidencia test**: `src/lib/gasless-signer.test.ts:102-113` — `'should set validAfter = blockTs - 1 and validBefore = validAfter + 25'`:
- L104: `mockGetBlock.mockResolvedValue({ timestamp: 1700000000n })`
- L111: `expect(r.validAfter).toBe('1699999999')` — 1700000000 - 1 = 1699999999 ✓
- L112: `expect(r.validBefore).toBe('1700000024')` — 1699999999 + 25 = 1700000024 ✓

---

#### AC-4: Token discovery via /supported_tokens
**WHEN** the gasless module needs to determine the supported token, **THE SYSTEM SHALL** query `/supported_tokens`, cache el resultado, y si unreachable hacer fallback a PYUSD hardcoded. **THE SYSTEM SHALL** validar `value >= minimum_transfer_amount`.

**Status**: PASS

**Evidencia código**:
```
gasless-signer.ts:143-162  getSupportedToken(): cache con _tokenCache (L144), fetch con timeout L147-148, fallback a FALLBACK_TOKEN en any catch (L158-161) o non-2xx (L151)
gasless-signer.ts:29-37    FALLBACK_TOKEN = { symbol:'PYUSD', address:'0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9', decimals:18, eip712Name:'PYUSD', eip712Version:'1', minimumTransferAmount:'10000000000000000' }
gasless-signer.ts:88-92    assertMinimumValue(value, token): throw si value < BigInt(token.minimumTransferAmount)
gasless-signer.ts:175      assertMinimumValue(opts.value, token)  // CD-9 — antes de firmar
```

**Evidencia test**:
- `gasless-signer.test.ts:60-70` — `'should cache getSupportedToken result on second call'`: `fetchMock` llamado exactamente 1 vez, `a === b` (misma referencia)
- `gasless-signer.test.ts:72-81` — fallback cuando fetch rechaza (network down)
- `gasless-signer.test.ts:83-98` — fallback cuando fetch retorna non-2xx (503)
- `gasless-signer.test.ts:115-125` — `'should reject when value < minimumTransferAmount'`: `value: 1n` → rejects con `/minimum_transfer_amount/`

---

#### AC-5: Feature flag
**WHEN** `GASLESS_ENABLED=true`, **THE SYSTEM SHALL** register `/gasless/*` routes. Default OFF.

**Status**: PARTIAL

**Evidencia código**: `src/index.ts:59-62`:
```
src/index.ts:59  if (process.env.GASLESS_ENABLED === 'true') {
src/index.ts:60    await fastify.register(gaslessRoutes, { prefix: '/gasless' })
src/index.ts:61    fastify.log.info('Gasless EIP-3009 module enabled (testnet PYUSD)')
src/index.ts:62  }
```
Import incondicional en `src/index.ts:20` — pero sin side effects top-level en `gasless-signer.ts` (singletons en null), verificado en AR v2 H-14.

**Justificación PARTIAL**: No hay test automático que verifique el registro condicional de rutas (hallazgo CR-4.6, MENOR aceptado). El registro condicional es verificable manualmente: con `GASLESS_ENABLED=false` la ruta `GET /gasless/status` devuelve 404; con `GASLESS_ENABLED=true` devuelve 200. La implementación del guard es correcta y directa. PARTIAL aceptable: feature flag de ~4 LOC, verificable por inspección, deuda trazada para WKH-33 o siguiente iteración.

---

#### AC-6: Error handling robusto
**WHEN** the gasless relayer returns error or is unreachable, **THE SYSTEM SHALL** log sanitized error (CD-1) and return to caller. **THE SYSTEM SHALL NOT** crash.

**Status**: PASS

**Evidencia código**:
```
gasless-signer.ts:94-99   sanitizeError(err): recorta a 120 chars, nunca expone stack completo
gasless-signer.ts:242-248 try/catch en fetch del POST — lanza con mensaje sanitizado
gasless-signer.ts:246-249 check res.ok — lanza con status code y statusText (no body)
gasless.ts:13-21          catch en route handler: log errorClass (no message), responde 'gasless status failed' (string constante)
```

**Evidencia test**: `src/lib/gasless-signer.test.ts:219-263` — `'should throw sanitized error on 5xx without leaking body'`:
- L231-244: verifica que lanza con `/500/`
- L246-262: verifica que `err.message` no contiene `'SECRET_BODY'` (texto del response body mockeado)

---

#### AC-7: Status endpoint
**WHEN** `GET /gasless/status` is called, **THE SYSTEM SHALL** return `{enabled, network, supportedToken, operatorAddress}` (NEVER private key).

**Status**: PASS

**Evidencia código**:
```
gasless.ts:8-23          GET /status → getGaslessStatus() → reply.send(status)
gasless-signer.ts:264    async function getGaslessStatus(): Promise<GaslessStatus>
gasless-signer.ts:265    enabled = process.env.GASLESS_ENABLED === 'true'
gasless-signer.ts:267-275 short-circuit si !enabled: {enabled:false, network:'kite-testnet', supportedToken:null, operatorAddress:null}
gasless-signer.ts:277-285 operatorAddress = privateKeyToAccount(pk).address (solo el address público)
gasless-signer.ts:294-299 retorna {enabled, network:'kite-testnet', supportedToken, operatorAddress}
src/types/index.ts:436-441 GaslessStatus: operatorAddress es `0x${string} | null`, sin campo para PK
```

**Evidencia test**: `src/lib/gasless-signer.test.ts:267-284` — `'should return operatorAddress in getGaslessStatus but never the private key'`:
- L270: setea `GASLESS_ENABLED='true'`
- L276: `expect(s.enabled).toBe(true)`
- L277-279: `operatorAddress` truthy, empieza con `0x`, longitud 42
- L281-283: `JSON.stringify(s)` no contiene `TEST_PK` ni `'privateKey'`

---

## 2. Drift Detection vs Story File

### Archivos en scope del story file

| # | Archivo | Accion Story File | Estado en impl |
|---|---------|-------------------|----------------|
| 1 | `src/types/index.ts` | MODIFICAR — agregar 4 interfaces gasless | CUMPLIDO — `types/index.ts:405-441` con las 4 interfaces (`GaslessSupportedToken`, `GaslessTransferRequest`, `GaslessTransferResponse`, `GaslessStatus`) bajo banner `GASLESS TYPES (WKH-29)` |
| 2 | `.env.example` | MODIFICAR — bloque `# Gasless EIP-3009 (WKH-29)` | CUMPLIDO — `.env.example:39-44`, bloque con comentario correcto, `GASLESS_ENABLED=false`, `OPERATOR_PRIVATE_KEY=0xYour...` |
| 3 | `src/lib/gasless-signer.ts` | CREAR — lazy singleton, token discovery, sign, submit, status, reset | CUMPLIDO — 310 LOC, todas las funciones presentes |
| 4 | `src/lib/gasless-signer.test.ts` | CREAR — 9 casos vitest | CUMPLIDO — 285 LOC, 9 tests, todos PASS |
| 5 | `src/routes/gasless.ts` | CREAR — Fastify plugin `GET /status` | CUMPLIDO — 25 LOC, plugin correcto |
| 6 | `src/index.ts` | MODIFICAR — import + registro condicional `GASLESS_ENABLED==='true'` | CUMPLIDO — `src/index.ts:20` import, `src/index.ts:59-62` condicional |

### Archivos tocados fuera de scope

Verificación via `git status`:
- `CLAUDE.md` — archivo de configuración del proyecto, modificado. Revisado: cambio pre-existente no relacionado con WKH-29 (rama arranca desde el mismo commit que main). Sin impacto en funcionalidad gasless.
- `supabase/.temp/` — directorio temporal de Supabase, no relacionado con WKH-29.

**Conclusión**: 0 archivos funcionales fuera de scope del story file.

### Funciones/exports vs contrato story file

| Función | Contrato story file | Implementación | Match |
|---------|--------------------|--------------:|-------|
| `getSupportedToken()` | Scope IN, story file F2 | `gasless-signer.ts:143` | ✓ |
| `signTransferWithAuthorization(to, value)` | Scope IN | `gasless-signer.ts:170` — `opts: { to, value }` | ✓ (shape equivalente) |
| `submitGaslessTransfer(payload)` | Scope IN | `gasless-signer.ts:231` | ✓ |
| `getGaslessStatus()` | Scope IN | `gasless-signer.ts:264` | ✓ |
| `_resetGaslessSigner()` | Implícito por patrón x402-signer | `gasless-signer.ts:306` | ✓ (extensión justificada: resetea también `_tokenCache`) |

### Drift notable (intencional, trazado)

- **`hexToSignature` → `parseSignature`**: Story file §Exemplar dice `signTypedData + hexToSignature`; implementación usa `parseSignature`. Drift cerrado por AR v2 (H-5). Cambio en import `gasless-signer.ts:10`. JSDoc residual en `gasless-signer.ts:5,168` menciona `hexToSignature` (NIT cosmético, no impacta runtime — registrado CR-1.5-NIT).
- **POST payload shape (camelCase)**: story-file asunción A-2 no verificada con smoke test real por falta de fondeo. Documentado con TODO en `gasless-signer.ts:227-229`. Aceptado por Adversary AR v2 como MENOR-cerrado vía documentación explícita.
- **`signTransferWithAuthorization` firma**: story file menciona `(to, value)` como parámetros separados; implementación usa `opts: { to, value }`. Equivalente funcionalmente, más extensible. Drift positivo, no un problema.

### Dependencias no autorizadas

- `grep -rn "ethers" src/` → **0 matches**. CD-7 cumplido.
- Dependencias en `gasless-signer.ts:10-14`: `viem` (existente), `viem/accounts` (existente), `node:crypto` (built-in), `kite-chain.js` (existente), `kite-client.js` (existente). Todas autorizadas.

---

## 3. Constraint Directives

| CD | Constraint | Status | Evidencia archivo:línea |
|----|-----------|--------|------------------------|
| CD-1 | NUNCA logear `OPERATOR_PRIVATE_KEY`, signatures, ni payloads sensibles. Solo txHash. | **CUMPLIDO** | `gasless-signer.ts:94-99` sanitizeError limita a 120 chars sin campos sensibles; `gasless.ts:16-20` log solo errorClass, respuesta genérica; `grep "console\." gasless-signer.ts gasless.ts` → 0 matches |
| CD-2 | Gasless signer en `gasless-signer.ts` — NO mezclar con `x402-signer.ts` | **CUMPLIDO** | Archivos completamente separados; `x402-signer.ts` intacto (no modificado según git status) |
| CD-3 | TypeScript strict, sin `any` | **CUMPLIDO** | `grep "\bany\b" gasless-signer.ts gasless.ts types/index.ts` → 0 matches; `npx tsc --noEmit` → exit 0 |
| CD-4 | Feature flag `GASLESS_ENABLED` default `false`, opt-in | **CUMPLIDO** | `.env.example:43`: `GASLESS_ENABLED=false`; `src/index.ts:59`: `process.env.GASLESS_ENABLED === 'true'` (opt-in) |
| CD-5 | Gasless y x402 paths independientes. No modificar x402 middleware | **CUMPLIDO** | `src/middleware/x402.ts` y `src/lib/x402-signer.ts` NO aparecen en `git status` (no modificados) |
| CD-6 | `validBefore = validAfter + 25s` (dentro de límite 30s del relayer) | **CUMPLIDO** | `gasless-signer.ts:27`: `const VALIDITY_WINDOW_SECONDS = 25n  // CD-6`; `gasless-signer.ts:180`: `const validBefore = validAfter + VALIDITY_WINDOW_SECONDS` |
| CD-7 | No agregar `ethers.js` como dependencia | **CUMPLIDO** | `grep -rn "ethers" src/` → 0 matches (exit 1 = no output) |
| CD-8 | Endpoint hardcoded a testnet (`https://gasless.gokite.ai/testnet`) | **CUMPLIDO** | `gasless-signer.ts:25`: `const GASLESS_SUBMIT_URL = \`${GASLESS_BASE_URL}/testnet\`  // CD-8` |
| CD-9 | Validar `value >= minimum_transfer_amount` antes de firmar | **CUMPLIDO** | `gasless-signer.ts:88-92`: `assertMinimumValue(value, token): throw si value < BigInt(token.minimumTransferAmount)`; llamado en `gasless-signer.ts:175` antes de `getWalletClient()` / firma |

---

## 4. Quality Gates

### Gate 1: TypeScript — `npx tsc --noEmit`

```
$ npx tsc --noEmit
(sin output)
EXIT: 0
```

**Resultado**: PASS — sin errores de tipo.

---

### Gate 2: Test suite — `npx vitest run`

```
 RUN  v1.6.1 /home/ferdev/.openclaw/workspace/wasiai-a2a

 ✓ src/services/agent-card.test.ts  (17 tests) 7ms
 ✓ src/services/llm/transform.test.ts  (5 tests) 5ms
 ✓ src/services/compose.test.ts  (9 tests) 8ms
 ✓ src/services/task.test.ts  (21 tests) 13ms
 ✓ src/services/orchestrate.test.ts  (10 tests) 18ms
 ✓ src/services/kite-client.test.ts  (8 tests) 51ms
 ✓ src/routes/agent-card.test.ts  (4 tests) 18ms
 ✓ src/services/mock-registry.test.ts  (9 tests) 20ms
 ✓ src/routes/tasks.test.ts  (20 tests) 29ms
 ✓ src/lib/gasless-signer.test.ts  (9 tests) 32ms

 Test Files  10 passed (10)
      Tests  112 passed (112)
   Start at  00:48:48
   Duration  825ms
EXIT: 0
```

**Resultado**: PASS — 112/112. Sin regresiones. Suite gasless: 9/9.

---

### Gate 3: Sin ethers — `grep -rn "ethers" src/`

```
$ grep -rn "ethers" src/
(sin output)
EXIT: 1 (= no matches)
```

**Resultado**: PASS — 0 matches. CD-7 cumplido.

---

### Gate 4: Sin `any` explícito

```
$ grep -n "\bany\b" src/lib/gasless-signer.ts src/routes/gasless.ts src/types/index.ts
(sin output)
EXIT: 1 (= no matches)
```

**Resultado**: PASS — 0 matches de `any` en los archivos target. CD-3 cumplido.

Verificación adicional: los `unknown` en `gasless-signer.ts:94` (`err: unknown`) y `gasless-signer.ts:111` (`raw: unknown`) son uso correcto de TypeScript strict (no `any`). Confirmado por CR-3.1.

---

### Gate 5: Sin `console.` en archivos gasless

```
$ grep -n "console\." src/lib/gasless-signer.ts src/routes/gasless.ts
(sin output)
EXIT: 1 (= no matches)
```

**Resultado**: PASS — 0 matches. Todos los logs usan `fastify.log.*`. El `console.log` en `src/index.ts:67` es el banner de boot preexistente, no introducido por WKH-29 (confirmado en AR v2).

---

### Gate 6: Verificación de branch

```
$ git rev-parse --abbrev-ref HEAD
feat/018-gasless-aa
```

**Resultado**: PASS — en branch correcto.

---

## 5. Deuda Técnica Residual (no bloqueante)

Los siguientes hallazgos del AR v2 y CR fueron aceptados como MENOR/NIT no-bloqueantes. Se documentan aquí para trazabilidad:

| ID | Descripción | Archivo:Línea | Prioridad |
|----|-------------|---------------|-----------|
| CR-1.5-NIT | JSDoc del módulo menciona `hexToSignature` (stale, post-migración a `parseSignature`) | `gasless-signer.ts:5`, `gasless-signer.ts:168` | Baja |
| CR-3.3 | `pk as \`0x${string}\`` sin validación de formato previo (deuda pre-existente del exemplar) | `gasless-signer.ts:65` | Media (WKH-33) |
| CR-4.4-NIT | Fixture txHash `'0xdeadbeef'` no es 32 bytes (cosmético) | `gasless-signer.test.ts:197` | Baja |
| CR-4.6 | AC-5 sin test automático para registro condicional de rutas | `src/index.ts:59-62` | Media (WKH-33) |
| H-24 (A-2) | POST payload camelCase pendiente de verificación con smoke test real (fondeo de wallet) | `gasless-signer.ts:227-229` (TODO) | Alta (pre-producción) |
| H-8 | `validBefore` efectivo ~24s puede ser insuficiente si RPC retorna bloque cacheado/rezagado | `gasless-signer.ts:179-180` | Media (monitorear post-deploy) |

---

## 6. Veredicto Final

### **PASS**

**Justificación**:

1. **ACs**: 6/7 PASS, 1 PARTIAL (AC-5). El PARTIAL está justificado: el registro condicional de rutas tiene implementación correcta en `src/index.ts:59-62`, la ausencia de test automático es deuda trazada y aceptada por CR (hallazgo MENOR).

2. **Drift**: 0 archivos funcionales fuera de scope. Todos los drifts son intencionales y trazados: `parseSignature` (post-AR v2 fix), `opts: {to, value}` (mejora de firma), TODO en camelCase (verificación pendiente de fondeo).

3. **Constraint Directives**: 9/9 CUMPLIDOS con evidencia archivo:línea.

4. **Quality Gates**: todos verdes.
   - `npx tsc --noEmit` → exit 0 (sin errores)
   - `npx vitest run` → 112/112 PASS, sin regresiones
   - `grep "ethers" src/` → 0 matches
   - `grep "\bany\b"` en archivos target → 0 matches
   - `grep "console\."` en archivos gasless → 0 matches

5. **Seguridad**: CD-1 verificado — 0 `console.` en gasless files, error handler en ruta usa mensaje genérico (no `err.message`), serialización de status no contiene PK (verificado por test L281-283).

**Listo para DONE y push a `main`.**

---

*Generado: 2026-04-06 | QA F4 | post-CR*
