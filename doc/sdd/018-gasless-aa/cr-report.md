# Code Review Report — WKH-29 Gasless EIP-3009

| Campo | Valor |
|-------|-------|
| HU | WKH-29 |
| Branch | `feat/018-gasless-aa` |
| Fase | CR (post-AR v2) |
| Reviewer | Adversary+QA |
| Fecha | 2026-04-06 |
| Base AR | ar-report.md — veredicto OK |

Archivos revisados:
- `src/lib/gasless-signer.ts` (310 L)
- `src/lib/gasless-signer.test.ts` (285 L)
- `src/routes/gasless.ts` (25 L)
- `src/index.ts` (85 L)
- `src/types/index.ts` (L405-441)
- `.env.example` (L38-44)
- Exemplar: `src/lib/x402-signer.ts`

---

## Check 1 — Adherencia al Exemplar (`x402-signer.ts`)

### CR-1.1 — Lazy singleton replicado fielmente
- **Severidad**: OK
- **Evidencia**: `gasless-signer.ts:52-73` — `let _walletClient: ReturnType<typeof createWalletClient> | null = null` + `getWalletClient()` con guard de `OPERATOR_PRIVATE_KEY`. Estructura línea a línea idéntica al exemplar `x402-signer.ts:39-57`. Drift: en gasless-signer el singleton es privado (correcto), en x402-signer también. Ninguna divergencia injustificada.
- **Sugerencia**: N/A — patrón replicado correctamente.

### CR-1.2 — `_resetGaslessSigner()` extiende el patrón con `_tokenCache`
- **Severidad**: NIT
- **Evidencia**: `gasless-signer.ts:306-309` — el reset limpia tanto `_walletClient` como `_tokenCache`, mientras el exemplar `x402-signer.ts:125-127` solo limpia `_walletClient`. La extensión es correcta y necesaria por la cache del token. Sin embargo el nombre difiere del exemplar (`_resetGaslessSigner` vs `_resetWalletClient`). La convención del exemplar sugería `_resetWalletClient` pero dado que gasless resetea más de un singleton, el nombre es más descriptivo.
- **Sugerencia**: ninguna. La diferencia es justificada por el estado extra del módulo.

### CR-1.3 — `signTypedData` con `client.account!` (non-null assertion)
- **Severidad**: NIT
- **Evidencia**: `gasless-signer.ts:183` `const account = client.account!`. Mismo patrón que `x402-signer.ts:79`. El AR v2 lo registró como MENOR (H-16) — drift consistente con el exemplar, no introducido por esta feature.
- **Sugerencia**: deuda técnica pre-existente. No se requiere cambio en este CR.

### CR-1.4 — Separación de constantes vs exemplar
- **Severidad**: OK
- **Evidencia**: `gasless-signer.ts:22-48` — bloque de constantes al inicio del archivo (`GASLESS_BASE_URL`, `GASLESS_SUBMIT_URL`, `GASLESS_TOKENS_URL`, `VALIDITY_WINDOW_SECONDS`, `FALLBACK_TOKEN`, `EIP3009_TYPES`). El exemplar no tiene este bloque (usa constantes inline). La decisión de centralizar constantes es mejora sobre el exemplar, no drift negativo.
- **Sugerencia**: N/A.

### CR-1.5 — `parseSignature` en lugar de `hexToSignature` — drift intencional post-AR
- **Severidad**: OK
- **Evidencia**: `gasless-signer.ts:10` `import { createWalletClient, http, parseSignature } from 'viem'`. El SDD §2 especificaba `hexToSignature`; el AR v2 (H-5) cerró el BLOQUEANTE con la migración a `parseSignature`. Drift del SDD intencional y trazado.
- **Sugerencia**: el JSDoc del archivo (L5) todavía menciona `hexToSignature` ("descompone v/r/s con hexToSignature"). Menor inconsistencia documental — no afecta runtime.

  **CR-1.5-NIT**:
  - **Severidad**: NIT
  - **Evidencia**: `gasless-signer.ts:5` — JSDoc del módulo menciona `hexToSignature`; `gasless-signer.ts:168` comentario inline también dice `hexToSignature`. Runtime usa `parseSignature` (correcto).
  - **Sugerencia**: actualizar ambos comentarios a `parseSignature` para evitar confusión futura en revisiones.

---

## Check 2 — Naming y Convenciones del Proyecto

### CR-2.1 — Nombres de funciones públicas siguen la convención del proyecto
- **Severidad**: OK
- **Evidencia**: `gasless-signer.ts:143,170,231,264,306` — `getSupportedToken`, `signTransferWithAuthorization`, `submitGaslessTransfer`, `getGaslessStatus`, `_resetGaslessSigner`. Convención camelCase, verbos descriptivos, prefijo `_` para internal. Alineado con `x402-signer.ts:75,125` (`signX402Authorization`, `_resetWalletClient`).

### CR-2.2 — Variables de entorno siguen convención del repo
- **Severidad**: OK
- **Evidencia**: `.env.example:43-44` — `GASLESS_ENABLED`, `OPERATOR_PRIVATE_KEY`. `OPERATOR_PRIVATE_KEY` ya existía en `.env.example` (citado por `x402-signer.ts:44`). `GASLESS_ENABLED` sigue el estilo SCREAMING_SNAKE_CASE del resto del repo. Sin prefijo `VITE_` u otros prefijos extraños.

### CR-2.3 — Tipos en `src/types/index.ts` con banner de sección
- **Severidad**: OK
- **Evidencia**: `src/types/index.ts:405-441` — banner `// ============================================================ // GASLESS TYPES (WKH-29 — EIP-3009) // ============================================================`. Idéntico al estilo de la sección `x402 PROTOCOL TYPES` del mismo archivo. Convención respetada.

### CR-2.4 — Interfaz `RawTokenEntry` definida en `gasless-signer.ts` (no en `types/index.ts`)
- **Severidad**: NIT
- **Evidencia**: `gasless-signer.ts:101-108` — `interface RawTokenEntry` es tipo de representación interna del payload crudo del relayer. Al ser solo usada por `parseTestnetToken()`, su ubicación dentro del módulo es correcta (no es un tipo público exportado). El SDD no la lista en los tipos públicos.
- **Sugerencia**: N/A — ubicación correcta para un tipo de parsing privado.

### CR-2.5 — Nombre del archivo de routes
- **Severidad**: OK
- **Evidencia**: `src/routes/gasless.ts` — sigue la convención de todos los archivos en `src/routes/` (snake-case, un token, sin sufijo `Routes`). Los demás: `registries.ts`, `discover.ts`, `compose.ts`, `dashboard.ts`. Consistente.

---

## Check 3 — TypeScript Strict

### CR-3.1 — Sin `any` explícito
- **Severidad**: OK
- **Evidencia**: búsqueda de `any` en `gasless-signer.ts` — 0 instancias. Los tipos `unknown` se usan donde corresponde: `gasless-signer.ts:94` (`err: unknown`), `gasless-signer.ts:111` (`raw: unknown`), `gasless-signer.ts:154` (`(await res.json()) as unknown`).

### CR-3.2 — Cast `as unknown` → cast final (`as { txHash?: string }`)
- **Severidad**: NIT
- **Evidencia**: `gasless-signer.ts:252` `const json = (await res.json()) as { txHash?: string }`. El cast es directo (sin `as unknown` intermedio). Aceptable porque el campo se valida en L253 antes de usarlo.
- **Sugerencia**: N/A.

### CR-3.3 — `pk as \`0x${string}\`` sin validación de formato
- **Severidad**: MENOR
- **Evidencia**: `gasless-signer.ts:65` `privateKeyToAccount(pk as \`0x${string}\`)`. Si la PK del env var no empieza con `0x` o tiene longitud incorrecta, viem lanzará un error pero el mensaje puede incluir la clave parcialmente. Mismo patrón que `x402-signer.ts:49` (deuda pre-existente, no introducida por WKH-29).
- **Sugerencia**: agregar `if (!pk.startsWith('0x') || pk.length !== 66) throw new Error('OPERATOR_PRIVATE_KEY must be a 32-byte hex string prefixed with 0x')` — valida formato sin loggear el valor. Deuda técnica para WKH-33 o hotfix posterior.

### CR-3.4 — Tipos públicos coherentes con `src/types/index.ts`
- **Severidad**: OK
- **Evidencia**: `gasless-signer.ts:15-20` — importa `GaslessSupportedToken`, `GaslessTransferRequest`, `GaslessTransferResponse`, `GaslessStatus` desde `'../types/index.js'`. Las signaturas de funciones públicas usan estos tipos directamente. `GaslessTransferRequest.nonce` es `\`0x${string}\`` (L426 tipos), coherente con `generateNonce()` (L85 impl). `GaslessTransferRequest.r` y `.s` son `\`0x${string}\`` (L428-429 tipos), coherente con `parsed.r`/`parsed.s` de viem que retorna ese tipo.

### CR-3.5 — `VALIDITY_WINDOW_SECONDS = 25n` como `bigint` literal
- **Severidad**: OK
- **Evidencia**: `gasless-signer.ts:27` `const VALIDITY_WINDOW_SECONDS = 25n`. Type inference correcta: `bigint`. Evita conversión en L180 `validBefore = validAfter + VALIDITY_WINDOW_SECONDS` (ambos `bigint`). Sin operaciones mixtas tipo `bigint + number`.

---

## Check 4 — Tests: Calidad

### CR-4.1 — Nombres descriptivos
- **Severidad**: OK
- **Evidencia**: `gasless-signer.test.ts:60,72,83,102,115,127,191,219,267` — todos siguen el patrón `'should <comportamiento> <condición>'`. Ejemplos: `'should cache getSupportedToken result on second call'` (L60), `'should set validAfter = blockTs - 1 and validBefore = validAfter + 25'` (L102), `'should decompose signature into valid v/r/s recoverable by signer'` (L127). Descriptivos y verificables.

### CR-4.2 — Setup/teardown limpio
- **Severidad**: OK
- **Evidencia**: `gasless-signer.test.ts:52-56` — `beforeEach` ejecuta `_resetGaslessSigner()`, `vi.restoreAllMocks()`, `mockGetBlock.mockReset()`. Estado completamente limpiado entre tests. No hay state leakage entre casos. `process.env.GASLESS_ENABLED` se restaura dentro del test que lo modifica (L274).

### CR-4.3 — Tests independientes
- **Severidad**: OK
- **Evidencia**: cada `it()` stublea `fetch` con `vi.stubGlobal` y llama `_resetGaslessSigner()` via `beforeEach`. No hay dependencia de orden de ejecución. El test L267 restaura `GASLESS_ENABLED` al valor previo antes de retornar (L274 `process.env.GASLESS_ENABLED = prev`).

### CR-4.4 — Asserts específicos
- **Severidad**: OK — con una observación NIT
- **Evidencia (OK)**: `gasless-signer.test.ts:137-143` — `expect(Number.isFinite(r.v)).toBe(true)`, `expect([27,28]).toContain(r.v)`, regexes sobre `r` y `s`. Test L147-186 realiza recuperación criptográfica real. Muy por encima del estándar de "test de humo".
- **Evidencia (NIT)**: `gasless-signer.test.ts:216` — `expect(r.txHash).toBe('0xdeadbeef')`. La fixture `'0xdeadbeef'` no es una dirección hex de 32 bytes (es solo 4 bytes), podría confundir a lectores futuros. La validación en `gasless-signer.ts:253` requiere `startsWith('0x')` pero no longitud. El test pasa con un txHash inválido en longitud.

  **CR-4.4-NIT**:
  - **Severidad**: NIT
  - **Evidencia**: `gasless-signer.test.ts:197` `json: async () => ({ txHash: '0xdeadbeef' })` — fixture de txHash de 4 bytes en lugar de 32.
  - **Sugerencia**: usar `0x${'ab'.repeat(32)}` (66 chars) como fixture, consistente con el formato real de un txHash Ethereum.

### CR-4.5 — Cobertura de cada AC

| AC | Test(s) que lo cubren | Líneas |
|----|----------------------|--------|
| AC-1 | `'should return txHash from submitGaslessTransfer on 200'` | L191-217 |
| AC-2 | `'should decompose signature into valid v/r/s recoverable by signer'` | L127-187 |
| AC-3 | `'should set validAfter = blockTs - 1 and validBefore = validAfter + 25'` | L102-113 |
| AC-4 | `'should cache getSupportedToken result on second call'`, fallback tests | L60-98; L115-125 (minimum) |
| AC-5 | **No cubierto por tests automáticos** (ver CR-4.6) | — |
| AC-6 | `'should throw sanitized error on 5xx without leaking body'` | L219-263 |
| AC-7 | `'should return operatorAddress in getGaslessStatus but never the private key'` | L267-284 |

### CR-4.6 — AC-5 sin test automático
- **Severidad**: MENOR
- **Evidencia**: no existe ningún `it()` que verifique que con `GASLESS_ENABLED=true` la ruta `GET /gasless/status` se registra en Fastify y responde. El AR v2 lo registró como H-23 (MENOR) sin cerrarlo.
- **Sugerencia**: agregar test con `fastify.inject({ method: 'GET', url: '/gasless/status' })` en un `gasless.routes.test.ts` mínimo, o al menos con `GASLESS_ENABLED=false` verificar que la ruta no existe (404). Deuda técnica aceptable para una feature S, pero visible.

### CR-4.7 — PK determinista documentada correctamente
- **Severidad**: OK
- **Evidencia**: `gasless-signer.test.ts:8-11` — comentario `// PK determinista — debe estar en env ANTES del primer import del modulo bajo test` + `TEST_PK = '0x59c6...'` (Anvil/Hardhat account #0, conocida públicamente). La PK pública de test está justificada y documentada; no es una secret leak.

---

## Check 5 — Documentación Inline

### CR-5.1 — JSDoc en funciones públicas
- **Severidad**: OK
- **Evidencia**:
  - `gasless-signer.ts:138-142` — JSDoc de `getSupportedToken()` cubre cache, fallback, restricción de logging.
  - `gasless-signer.ts:164-168` — JSDoc de `signTransferWithAuthorization()` documenta el pipeline y ACs cubiertos.
  - `gasless-signer.ts:223-229` — JSDoc de `submitGaslessTransfer()` con TODO trazado para A-2 (pendiente de smoke test).
  - `gasless-signer.ts:261-262` — JSDoc de `getGaslessStatus()` documenta comportamiento no-throw y restricción de private key.
  - `gasless-signer.ts:303-305` — `@internal` en `_resetGaslessSigner()`.

### CR-5.2 — Comentarios donde no es obvio
- **Severidad**: OK
- **Evidencia**: 
  - `gasless-signer.ts:202-204` — comentario explaining la razón del fallback `yParity → v`. Técnicamente necesario y correcto.
  - `gasless-signer.ts:267` — `// H-3: short-circuit con flag OFF`. Referencia directa al hallazgo del AR, trazabilidad correcta.
  - `gasless-signer.ts:27` — `// CD-6` referencia a constraint directive. Buena práctica.
  - `gasless-signer.ts:25,36` — `// CD-8`, `// 0.01 PYUSD (18 dec)`. Comentarios concisos y útiles.

### CR-5.3 — Sobre-comentado en `routes/gasless.ts`
- **Severidad**: NIT
- **Evidencia**: `gasless.ts:14-15` — `// H-1: NUNCA re-emitir err.message (puede contener env vars o secretos). // Log interno con clase del error; respuesta genérica al cliente.` El comentario es útil para trazabilidad de la decisión del AR, pero podría ser más conciso. No es excesivo dado el contexto de seguridad.
- **Sugerencia**: aceptable tal cual; si se prefiere limpiar: `// CD-1: log clase, no mensaje (puede filtrar secrets)`.

### CR-5.4 — Comentario residual `hexToSignature` en JSDoc
- **Severidad**: NIT (ya identificado en CR-1.5-NIT)
- **Evidencia**: `gasless-signer.ts:5` y `gasless-signer.ts:168`.
- **Sugerencia**: actualizar a `parseSignature`.

---

## Check 6 — Mapping AC → Código

| AC | Implementación | Test | Veredicto |
|----|---------------|------|-----------|
| **AC-1** Sign EIP-3009 + POST → `txHash` | `gasless-signer.ts:231-258` `submitGaslessTransfer()` | `gasless-signer.test.ts:191-217` | PASS |
| **AC-2** `signTypedData()` + `parseSignature()` v/r/s | `gasless-signer.ts:187-219` (signTypedData L187, parseSignature L205) | `gasless-signer.test.ts:127-187` (recovery criptográfica L157-186) | PASS |
| **AC-3** `validAfter = blockTs - 1`, `validBefore = validAfter + 25` | `gasless-signer.ts:179-180` | `gasless-signer.test.ts:102-113` (valores exactos L111-112) | PASS |
| **AC-4** Query `/supported_tokens` + cache + fallback + `value >= min` | `gasless-signer.ts:143-162` (`getSupportedToken`) + `gasless-signer.ts:88-91` (`assertMinimumValue`) + `gasless-signer.ts:175` (CD-9) | `gasless-signer.test.ts:60-125` (3 tests cache/fallback) + L115-125 (minimum) | PASS |
| **AC-5** `GASLESS_ENABLED` feature flag + registro condicional | `src/index.ts:59-62` (registro condicional) | **Sin test automático** (ver CR-4.6) | PASS-PARCIAL |
| **AC-6** Errores logueados sin secretos, no crash | `gasless-signer.ts:94-99` (`sanitizeError`) + `gasless-signer.ts:242-248` (try/catch submit) + `gasless.ts:13-21` (catch genérico) | `gasless-signer.test.ts:219-263` (no leaking SECRET_BODY) | PASS |
| **AC-7** `GET /gasless/status` → `{enabled, network, supportedToken, operatorAddress}` | `gasless.ts:8-23` (route) + `gasless-signer.ts:264-299` (`getGaslessStatus`) | `gasless-signer.test.ts:267-284` (enabled+operatorAddress, no PK) | PASS |

Nota AC-2: el SDD especificaba `hexToSignature()` — la implementación usa `parseSignature()` (post-AR v2 fix). Funcionalidad equivalente; drift trazado.

---

## Hallazgos Consolidados

| ID | Descripción | Severidad | Archivo:Línea |
|----|-------------|-----------|---------------|
| CR-1.5-NIT | JSDoc del módulo menciona `hexToSignature` (stale post-migración) | NIT | `gasless-signer.ts:5,168` |
| CR-3.3 | `pk as \`0x${string}\`` sin validación de formato previo | MENOR | `gasless-signer.ts:65` |
| CR-4.4-NIT | Fixture txHash `'0xdeadbeef'` no es 32 bytes (confuso) | NIT | `gasless-signer.test.ts:197` |
| CR-4.6 | AC-5 sin test automático (registro condicional de rutas) | MENOR | `src/index.ts:59-62` |
| CR-5.3-NIT | Comentario en `gasless.ts` verboso (trazabilidad OK, cosmético) | NIT | `gasless.ts:14-15` |

Todos los checks de seguridad (CD-1, secrets, leaks) fueron cubiertos por AR v2 y no se re-hacen aquí.

---

## Veredicto Final

**MENOR** — puede pasar a F4.

Justificación:
- 0 hallazgos BLOQUEANTES de calidad de código.
- 2 hallazgos MENOR: CR-3.3 (cast sin validación de formato — deuda pre-existente alineada con exemplar) y CR-4.6 (AC-5 sin test automático — riesgo bajo, feature flag verificable manualmente).
- 3 hallazgos NIT: documentación residual, fixture de test y comentario verboso.
- Todos los ACs (1-4, 6-7) tienen implementación + test con evidencia archivo:línea. AC-5 verificable vía registro condicional en `src/index.ts:59-62`.
- El test de recovery criptográfica (`gasless-signer.test.ts:147-186`) es evidencia de calidad excepcional: `recoverTypedDataAddress` valida la firma end-to-end contra la PK del signer.
- Adherencia al exemplar es alta y los drifts son justificados (mejoras o correcciones post-AR).

---

*Generado: 2026-04-06 | Adversary+QA CR | post-AR-v2*
