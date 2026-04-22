# SDD #052: Migrate x402 payment token from KXUSD → PYUSD (WKH-52)

> SPEC_APPROVED: no
> Fecha: 2026-04-20
> Tipo: config / migration
> SDD_MODE: full
> Branch: feat/052-wkh-52-pyusd-migration (base: main @ b6e503d)
> Artefactos: doc/sdd/052-wkh-52-pyusd-migration/
> Pipeline: QUALITY (AR + CR + F4 obligatorios)

---

## 1. Resumen

Invertir la migración WKH-KXUSD (ver `doc/sdd/WKH-KXUSD/report.md`): el adaptador x402 (`KiteOzonePaymentAdapter`) vuelve a tener PYUSD (`0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`) como **default de código**, tanto en address como en symbol (`PYUSD`) y EIP-712 domain name (`PYUSD`). El mecanismo de env-override (`X402_PAYMENT_TOKEN`, `X402_TOKEN_SYMBOL`, `X402_EIP712_DOMAIN_NAME`, `X402_EIP712_DOMAIN_VERSION`) introducido por WKH-KXUSD se conserva intacto. La lógica EIP-712 sign/verify/settle NO se modifica — únicamente cambian 3 constantes de fallback, 10 tests existentes, 1 comentario de `fee-charge.ts` y los 3 archivos de documentación/config (`.env`, `.env.example`, `doc/INTEGRATION.md`).

Resultado esperado: cualquier deploy sin env vars arranca con PYUSD (token canónico oficial Kite). Railway mantiene KXUSD mientras el humano decida el cutover post-merge (AC-8).

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 052 |
| **Tipo** | config / migration |
| **SDD_MODE** | full |
| **Objetivo** | Default del adapter pasa a PYUSD; env-override intacto; 0 regresiones en la suite (379/379); documentación alineada. |
| **Reglas de negocio** | Backward-compat garantizada vía `X402_PAYMENT_TOKEN`; NO cutover forzado en Railway; interfaz pública de `PaymentAdapter` inmutable. |
| **Scope IN** | `src/adapters/kite-ozone/payment.ts`, `src/adapters/__tests__/payment.contract.test.ts`, `src/services/fee-charge.ts` (1 comentario), `.env`, `.env.example`, `doc/INTEGRATION.md`. |
| **Scope OUT** | `gasless.ts` (ya es PYUSD), `chain.ts`, lógica EIP-712/settle/verify, Railway env vars (humano post-merge), E2E tests. |
| **Missing Inputs** | Ninguno — DT-B resuelto en §4.3. |

### Acceptance Criteria (EARS) — heredados del work-item

1. **AC-1**: WHEN `X402_PAYMENT_TOKEN` is not set in env, the system SHALL use `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` as default payment token AND SHALL emit a `console.warn` containing the text `"defaulting to PYUSD"`.
2. **AC-2**: WHEN `X402_TOKEN_SYMBOL` is not set in env, the system SHALL return `"PYUSD"` as the default token symbol for `supportedTokens[0].symbol`.
3. **AC-3**: WHEN a client sends `POST /orchestrate` to a service without `X402_PAYMENT_TOKEN` set, the system SHALL respond with HTTP 402 where `accepts[0].asset` equals `"0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9"`.
4. **AC-4**: WHEN the test suite runs, the system SHALL pass all tests in `src/adapters/__tests__/payment.contract.test.ts` with assertions updated to expect `PYUSD` symbol and PYUSD address as defaults.
5. **AC-5**: WHEN `X402_PAYMENT_TOKEN` env var is set to any valid `0x...` address different from the PYUSD default, the system SHALL use that address as the active payment token (backward-compat env override preserved).
6. **AC-6**: WHEN a developer reads `doc/INTEGRATION.md`, the system SHALL present PYUSD as the canonical token (L196 asset description, L213 402-response snippet, L235 settle narrative), with no remaining references to KXUSD.
7. **AC-7**: WHEN the full test suite runs (`vitest run`), the system SHALL pass all 379 baseline tests with no regression.
8. **AC-8**: IF `X402_PAYMENT_TOKEN` is set to the old KXUSD address in Railway env after merge to main, THEN the system SHALL continue operating with KXUSD (env override preserved as defined in AC-5).

## 3. Context Map (Codebase Grounding)

### Archivos leídos y verificados

| Archivo | Por qué | Patrón / Hallazgo concreto |
|---------|---------|---------------------------|
| `src/adapters/kite-ozone/payment.ts:32-36` | Constantes default a modificar | `DEFAULT_PAYMENT_TOKEN = '0x1b7425...'`, `DEFAULT_EIP712_DOMAIN_NAME = 'Kite X402 USD'`, `DEFAULT_TOKEN_SYMBOL = 'KXUSD'`. |
| `src/adapters/kite-ozone/payment.ts:43-64` | `getPaymentToken()` — warn-once logic | Mensaje de warn line 48: `"X402_PAYMENT_TOKEN not set — defaulting to KXUSD (...)"` (cambia a PYUSD) y line 57 (invalid format branch). Flag `_warnedDefaultToken` se resetea en `_resetWalletClient()` (L279). |
| `src/adapters/kite-ozone/payment.ts:66-79` | `getEip712Domain()` y `getTokenSymbol()` | Lectores lazy, leen env var y caen en default si falta. Confirmado: no hay re-lectura cacheada ni cambios de firma. |
| `src/adapters/__tests__/payment.contract.test.ts:31,43,61-106,156-164` | Los 10 tests a actualizar | `const KXUSD_DEFAULT = '0x1b7425...'` (L31) → renombrar. `expect('KXUSD')` en L63, L105, L162. `expect(KXUSD_DEFAULT)` en L64, L77, L91, L163. Warn message `'X402_PAYMENT_TOKEN not set'` (L80) se mantiene **textualmente** (solo cambia la marca en el mensaje → verificar con `"defaulting to PYUSD"`). |
| `src/adapters/kite-ozone/gasless.ts:21-29` | **Confirma DT-B**: PYUSD ya tiene EIP-712 domain name `'PYUSD'` | `FALLBACK_TOKEN.eip712Name = 'PYUSD'`, `eip712Version = '1'`. Alineación directa: el nuevo default de `payment.ts` debe ser `'PYUSD'` para coincidir con lo que `gasless.ts` ya usa. |
| `src/services/fee-charge.ts:115-124` | Comentario menciona KXUSD | L120: `"Rationale: USDC tiene 6 decimals lógicos; 1e12 escala a 18 decimals para el token KXUSD."`. Cambiar texto "token KXUSD" → "token PYUSD". El código `feeUsdcToWei` NO cambia (la aritmética sigue idéntica). |
| `.env:10-14` | Env real (Railway-mirror local) | Líneas 10-14 declaran `X402_PAYMENT_TOKEN=0x1b7425...`, `X402_EIP712_DOMAIN_NAME=Kite X402 USD`, `X402_TOKEN_SYMBOL=KXUSD` y header `# ---------- x402 Token (KXUSD on Kite testnet) ----------`. Actualizar header + 3 valores. **NO tocar** líneas 1-9, 16-35. |
| `.env.example:62-74` | Template público | Líneas 62-74 contienen la sección `# ─── x402 Token Configuration (KXUSD) ─────────────────────`, comentario default KXUSD en L64, default value en L65, domain name en L68, symbol en L74. Actualizar header, 3 valores y el comentario descriptivo de L63. |
| `doc/INTEGRATION.md:196,213,235` | Puntos de KXUSD en docs | L196 `"Asset: KXUSD (EIP-3009 compliant), contract 0x1b7425..."`; L213 `"asset": "0x1b7425..."`; L235 `"settles the KXUSD transfer on-chain"`. Reemplazar con PYUSD + `0x8E04D099...`. |
| `doc/sdd/WKH-KXUSD/report.md` | Migración previa (inversa) | Patrón exacto que aplicamos al revés: misma forma de test updates, misma estructura de commit, mismo archivo `.env.example`. Confirma que el AR anterior encontró BLQ "warn on every call" — hoy ya resuelto con `_warnedDefaultToken`; NO debe regresarse. |
| `doc/sdd/044-wkh-44-protocol-fee/auto-blindaje.md` | Auto-blindaje reciente — lección sobre mocks | No aplica directamente (no hay Supabase chain en esta HU), pero refuerza regla general: leer el impl antes de escribir/tocar stubs. |
| `doc/sdd/043-wkh-sec-01/auto-blindaje.md` | Auto-blindaje reciente — lección sobre tsc generics | No aplica (no estamos tocando Fastify routes). |

### Exemplars

| Para modificar | Seguir patrón de | Razón |
|---------------|------------------|-------|
| `src/adapters/kite-ozone/payment.ts` (3 constantes + 2 warns) | Mismo archivo, estructura heredada de WKH-KXUSD | Solo cambian **valores literales** — la arquitectura (lazy readers, warn-once flag, regex validation) se conserva. |
| `src/adapters/__tests__/payment.contract.test.ts` (rename + asserts) | Commit de WKH-KXUSD (migración inversa) | Patrón verificado: constante renombrada (`KXUSD_DEFAULT` → `PYUSD_DEFAULT`), asserts actualizados en 1:1, estructura de describe/it intacta. |
| `.env` + `.env.example` | Sección L62-74 actual de `.env.example` | Mismo layout de comentarios con separadores `─`. Cambian valores, no el formato. |
| `doc/INTEGRATION.md` L193-235 | La sección 4 misma (texto actual) | Cambio puramente textual en 3 puntos. |

### Estado de BD relevante

| Tabla | Afectada | Nota |
|-------|----------|------|
| `a2a_protocol_fees` | **NO** | `fee-charge.ts` cambia solo 1 comentario; no se tocan columnas, triggers, ni queries. |
| Ninguna otra | N/A | Esta HU es puramente config + test + docs. |

### Componentes reutilizables

- `getPaymentToken()`, `getEip712Domain()`, `getTokenSymbol()` (payment.ts): ya existen y son la pieza central. **Reutilizar** — no agregar helpers nuevos.
- `_resetWalletClient()` (payment.ts:277-280): ya resetea `_warnedDefaultToken`. **Reutilizar** — los tests lo llaman en `beforeEach`.
- `FALLBACK_TOKEN` (gasless.ts:21-29): **NO tocar** (CD-3 del work-item), pero es la fuente de verdad para confirmar DT-B.

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `src/adapters/kite-ozone/payment.ts` | Modificar | L32-36: cambiar los 3 `DEFAULT_*` a PYUSD values. L48, L57: texto de `console.warn` de "KXUSD" → "PYUSD" (manteniendo el "defaulting to" prefix). | Mismo archivo, commit de WKH-KXUSD invertido. |
| `src/adapters/__tests__/payment.contract.test.ts` | Modificar | L31: renombrar `KXUSD_DEFAULT` → `PYUSD_DEFAULT` y cambiar el valor literal. Actualizar los 10 asserts que comparan address/symbol. **Añadir 1 test nuevo** (§4.6) explícito para AC-5. | Mismo archivo. |
| `src/services/fee-charge.ts` | Modificar | L120: comment `"token KXUSD"` → `"token PYUSD"`. 1-line comment, sin cambio de lógica. | Mismo archivo (solo comentario). |
| `.env` | Modificar | L10: header `# ---------- x402 Token (KXUSD on Kite testnet) ----------` → `# ---------- x402 Token (PYUSD on Kite testnet) ----------`. L11: value → `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`. L12: `X402_EIP712_DOMAIN_NAME=PYUSD`. L14: `X402_TOKEN_SYMBOL=PYUSD`. | `gasless.ts:21-29` confirma coherencia. |
| `.env.example` | Modificar | L62: `# ─── x402 Token Configuration (KXUSD) ───` → `(PYUSD)`. L63-64: comentario descriptivo `KXUSD 0x1b7425...` → `PYUSD 0x8E04D099...`. L65: default value. L68: `X402_EIP712_DOMAIN_NAME=PYUSD`. L74: `X402_TOKEN_SYMBOL=PYUSD`. | `.env` arriba. |
| `doc/INTEGRATION.md` | Modificar | L196 (`**Asset:** KXUSD ... 0x1b7425...`), L213 (`"asset": "0x1b7425..."`), L235 (`"settles the KXUSD transfer"`). Reemplazar por PYUSD + `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`. | Sección 4 misma. |

**Total**: 6 archivos modificados, 0 creados. 0 archivos borrados.

### 4.2 Modelo de datos

N/A — esta HU no toca tablas, migrations ni triggers.

### 4.3 Decisiones técnicas

- **DT-A**: Default de código cambia a PYUSD (`0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`). El env override via `X402_PAYMENT_TOKEN` sigue vigente y es la palanca de cutover controlado en Railway (AC-5, AC-8). **Heredado del work-item.**

- **DT-B (RESUELTO)**: `DEFAULT_EIP712_DOMAIN_NAME` pasa de `'Kite X402 USD'` a `'PYUSD'`. **Evidencia**: `src/adapters/kite-ozone/gasless.ts:26` ya usa `eip712Name: 'PYUSD'` en `FALLBACK_TOKEN`. Alinear `payment.ts` con `gasless.ts` evita divergencia entre los dos adapters del mismo chain y simplifica el domain verification del facilitator (Pieverse). **Sin ambigüedad, no hay `[NEEDS CLARIFICATION]`.**

- **DT-C**: La interfaz pública de `PaymentAdapter` NO se modifica. Sin cambios de firma en `quote()`, `sign()`, `settle()`, `verify()`, `supportedTokens`, `getToken()`. Solo cambian valores de constantes internas. **Heredado del work-item.**

- **DT-D (nueva, menor)**: Los warns de L48 y L57 mantienen el prefijo `"X402_PAYMENT_TOKEN not set"` / `"X402_PAYMENT_TOKEN has invalid format"` (para no romper los test asserts que filtran por ese substring, L80/L92 del test file) pero cambian la marca final a `"— defaulting to PYUSD (0x8E04...)"`. AC-1 exige explícitamente el string `"defaulting to PYUSD"`.

- **DT-E (nueva, menor)**: Rama `feat/052-wkh-52-pyusd-migration` se crea desde `main @ b6e503d`. **Sin conflicto con `feat/037-x402-v2`**: PR #14 ya mergeado (commit `c2c4c5b`) el 2026-04-11; la branch ya no existe. El `_INDEX.md` marca "in progress" para 037 pero es metadata stale (resuelto por orquestador).

### 4.4 Flujo principal (Happy Path)

1. Dev modifica las 3 constantes `DEFAULT_*` en `payment.ts` + actualiza 2 mensajes de warn.
2. Dev renombra `KXUSD_DEFAULT` → `PYUSD_DEFAULT` en el test file y actualiza asserts (10 lugares).
3. Dev agrega 1 test nuevo que cubre AC-5 explícitamente (KXUSD como env override).
4. Dev actualiza comment en `fee-charge.ts:120`.
5. Dev actualiza `.env`, `.env.example`, `doc/INTEGRATION.md` (puramente textual).
6. Dev ejecuta `npm run lint` (biome), `npx tsc --noEmit`, `npm test` (vitest run).
7. Suite 379/379 pasa; los 10 tests migrados pasan; el test nuevo AC-5 pasa.
8. Commit único (o commits lógicos por file group).
9. AR revisa attack surface (signature mismatch con facilitator → aclarar que no aplica porque gasless.ts ya usaba PYUSD). CR revisa evidencia archivo:línea. F4 QA valida los 8 ACs.
10. Merge a main. **Post-merge**: humano decide cuándo actualizar Railway env (fuera de scope).

### 4.5 Flujo de error

| Condición | Comportamiento esperado |
|-----------|-------------------------|
| `X402_PAYMENT_TOKEN` ausente | `getPaymentToken()` retorna PYUSD default; warn-once con mensaje `"defaulting to PYUSD"` (AC-1). |
| `X402_PAYMENT_TOKEN` inválido (regex fail) | `getPaymentToken()` retorna PYUSD default; warn-once con mensaje `"invalid format ... defaulting to PYUSD"`. |
| `X402_PAYMENT_TOKEN` = KXUSD legacy (Railway post-merge) | Override se respeta → adapter devuelve address KXUSD (AC-5, AC-8). Test nuevo cubre explícitamente. |
| Suite de tests falla después de refactor | BLOQUEANTE — Dev debe detenerse y corregir. CD-5 exige 379/379. |
| `biome check` o `tsc --noEmit` fallan | BLOQUEANTE — no commit. |
| Divergencia entre `payment.ts` domain y `gasless.ts` domain | Imposible si DT-B se aplica literalmente. AR debe validar. |

### 4.6 Tests — actualizaciones y adición

#### Tests existentes a modificar (10)

Referencias por línea en `src/adapters/__tests__/payment.contract.test.ts` (estado actual HEAD):

| # | Línea actual | Asserción actual | Nueva asserción | AC |
|---|--------------|------------------|-----------------|----|
| T1 | L31 | `const KXUSD_DEFAULT = '0x1b7425...';` | `const PYUSD_DEFAULT = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';` | AC-1, AC-4 |
| T2 | L43 | `process.env.X402_PAYMENT_TOKEN = KXUSD_DEFAULT;` | `process.env.X402_PAYMENT_TOKEN = PYUSD_DEFAULT;` | AC-4 |
| T3 | L61 (describe label) | `'has supportedTokens with KXUSD by default'` | `'has supportedTokens with PYUSD by default'` | AC-2, AC-4 |
| T4 | L63 | `expect(adapter.supportedTokens[0].symbol).toBe('KXUSD');` | `.toBe('PYUSD')` | AC-2 |
| T5 | L64 | `expect(...address).toBe(KXUSD_DEFAULT);` | `.toBe(PYUSD_DEFAULT)` | AC-1 |
| T6 | L74 (describe label) | `'defaults to KXUSD when X402_PAYMENT_TOKEN is not set...'` | `'defaults to PYUSD when X402_PAYMENT_TOKEN is not set...'` | AC-1 |
| T7 | L77 | `expect(adapter.getToken()).toBe(KXUSD_DEFAULT);` | `.toBe(PYUSD_DEFAULT)` | AC-1 |
| T8 | L88-91 (`falls back to default when ... invalid format`) | `expect(adapter.getToken()).toBe(KXUSD_DEFAULT);` | `.toBe(PYUSD_DEFAULT)` | AC-1 |
| T9 | L103-106 (`defaults token symbol to KXUSD`) | describe + `expect(...symbol).toBe('KXUSD');` | label → `'defaults token symbol to PYUSD'` + `.toBe('PYUSD')` | AC-2 |
| T10 | L156-164 (`quote() returns QuoteResult with KXUSD token`) | label + `expect(result.token.symbol).toBe('KXUSD');` + `expect(result.token.address).toBe(KXUSD_DEFAULT);` | label → `'...with PYUSD token'` + `.toBe('PYUSD')` + `.toBe(PYUSD_DEFAULT)` | AC-2, AC-4 |

> **NO hay un 11º test a modificar**: aunque el docstring del repo dice "10 tests" y la lista tiene 10 cambios, T1-T2 son mutaciones de setup (const + beforeEach), T3-T10 son mutaciones de asserts. Total changes: 10. Suma no varía — el archivo pasa de 14 tests a 15 tests (por T11 nuevo).

#### Test nuevo (T11) — AC-5 explícito: env override con KXUSD legacy

```ts
// NUEVO test, insertar después del bloque "reads token address from X402_PAYMENT_TOKEN env var" (~L72)
it('respects X402_PAYMENT_TOKEN override with legacy KXUSD address (AC-5, AC-8)', () => {
  const KXUSD_LEGACY = '0x1b7425d288ea676FCBc65c29711fccF0B6D5c293';
  process.env.X402_PAYMENT_TOKEN = KXUSD_LEGACY;
  expect(adapter.getToken()).toBe(KXUSD_LEGACY);
  expect(adapter.supportedTokens[0].address).toBe(KXUSD_LEGACY);
});
```

**Por qué explícito**: AC-8 exige que Railway pueda seguir con KXUSD post-merge. T11 blinda contra una regresión futura que rompiera el env override. Es el test más importante de esta HU desde la óptica de backward-compat.

> **Nota**: NO se requiere un test separado para el symbol `KXUSD` via `X402_TOKEN_SYMBOL` — el test existente L98-101 (`reads token symbol from X402_TOKEN_SYMBOL env var`) ya cubre ese mecanismo (con `'CUSTOM'`). Es lo mismo arquitectónicamente.

#### Plan de cobertura AC × Test

| AC | Tests que lo cubren |
|----|---------------------|
| AC-1 (default PYUSD + warn) | T5, T7, T8 + test existente "warns once" (L74-86, label y assert de warn message) |
| AC-2 (default symbol PYUSD) | T4, T9, T10 |
| AC-3 (402 response asset = PYUSD) | Implícitamente cubierto por T5/T10 (supportedTokens refleja default); el endpoint /orchestrate usa `adapter.getToken()` — ya testado indirectamente. **No se agrega test nuevo** (scope OUT: integration test contra route). |
| AC-4 (los 10 tests pasan) | T1-T10 |
| AC-5 (env override preservado) | **T11 (nuevo)** + test existente L67-72 (`reads token address from X402_PAYMENT_TOKEN env var`) |
| AC-6 (INTEGRATION.md) | Verificación manual por QA en F4. No testeable unit. |
| AC-7 (379/379) | `vitest run` al final de la Wave |
| AC-8 (Railway env KXUSD post-merge) | **T11 (nuevo)** (es el mismo mecanismo que AC-5, testeado con la address KXUSD literal) |

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir

- **Stack inmutable**: TypeScript strict, vitest, biome, viem v2. Nada de ethers, nada de `any` explícito.
- **Patrón de env-readers**: mantener `getPaymentToken()`, `getEip712Domain()`, `getTokenSymbol()` intactos en estructura (solo cambian los string literals). NO refactorizar.
- **Warn-once**: el flag `_warnedDefaultToken` se mantiene. NO quitar. NO convertir en warn-every-call.
- **Regex validation**: `ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/` se mantiene. NO quitar.
- **Texto exacto en warn**: incluir substring `"defaulting to PYUSD"` (AC-1 literal).
- **Baseline de tests**: correr `vitest run` y confirmar 379/379 antes del commit.

### PROHIBIDO

- **CD-1** (heredado): PROHIBIDO `any` explícito. TypeScript strict en todos los archivos tocados.
- **CD-2** (heredado): PROHIBIDO romper backward-compat del env override — AC-5 y AC-8 son no negociables.
- **CD-3** (heredado): PROHIBIDO tocar `src/adapters/kite-ozone/gasless.ts`, `chain.ts`, o cualquier archivo de settle/verify/sign logic.
- **CD-4** (heredado): OBLIGATORIO que `payment.contract.test.ts` cubra (a) default PYUSD sin env, (b) env override con address custom, (c) warn message contiene `"PYUSD"`.
- **CD-5** (heredado): OBLIGATORIO baseline 379/379 sin regresión.
- **CD-6 (nueva)**: PROHIBIDO renombrar `KXUSD_DEFAULT` en un archivo y olvidar las referencias en otros bloques del mismo test file — leer el archivo completo y hacer sweep. **Referencia: lección transversal — consistency sweep en file-wide renames.**
- **CD-7 (nueva)**: PROHIBIDO cambiar el mensaje del warn perdiendo el prefijo `"X402_PAYMENT_TOKEN not set"` o `"X402_PAYMENT_TOKEN has invalid format"` — los tests existentes filtran por ese substring (L80, L92). Rompe si se pierde.
- **CD-8 (nueva)**: PROHIBIDO agregar hardcodes nuevos de PYUSD fuera de los 3 `DEFAULT_*` constants. El address literal `0x8E04D099...` aparece SOLO en: `payment.ts` (default), `gasless.ts` (ya existente, no tocar), `.env`, `.env.example`, `doc/INTEGRATION.md`, tests. No debe aparecer en services, routes, middleware, ni helpers.
- **CD-9 (nueva)**: PROHIBIDO expandir scope — NO actualizar `README.md`, NO tocar `scripts/demo-x402.ts`, NO tocar `doc/sdd/037-*/` ni `doc/sdd/WKH-KXUSD/*`. Si surge la necesidad, es una HU nueva.
- **CD-10 (nueva, auto-blindaje histórico)**: PROHIBIDO saltar el typecheck. Lección WKH-SEC-01 (`doc/sdd/043-wkh-sec-01/auto-blindaje.md`): errores TS2345 silenciosos hasta tsc. **Correr `npx tsc --noEmit` explícitamente**, no confiar sólo en vitest.

## 6. Scope

**IN (exhaustivo — 6 archivos):**
1. `src/adapters/kite-ozone/payment.ts` — 3 constantes + 2 warns
2. `src/adapters/__tests__/payment.contract.test.ts` — 10 modificaciones + 1 test nuevo
3. `src/services/fee-charge.ts` — 1 comentario (L120)
4. `.env` — 3 valores + header
5. `.env.example` — 3 valores + header + comentario descriptivo
6. `doc/INTEGRATION.md` — 3 líneas (L196, L213, L235)

**OUT (explícito):**
- `src/adapters/kite-ozone/gasless.ts` (CD-3)
- `src/adapters/kite-ozone/chain.ts` (sin referencias a token)
- Lógica de sign/verify/settle (CD-3)
- E2E tests (`feat/029-e2e-tests`, bloqueado por WKH-45)
- Railway env vars (gate humano post-merge)
- `scripts/demo-x402.ts` (demo, no es producción — scope OUT aunque mencione KXUSD)
- `README.md` (no menciona KXUSD en forma canónica según grep rápido — fuera de scope de esta HU)
- SDDs históricos: `doc/sdd/037-*/`, `doc/sdd/WKH-KXUSD/*`
- Cualquier cambio en interfaz pública de `PaymentAdapter` (DT-C)

## 7. Riesgos

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|--------|-------|---------|------------|
| R1 | Facilitator Pieverse rechaza signatures con domain name `"PYUSD"` vs `"Kite X402 USD"` | B | A | **Mitigado por DT-B evidence**: `gasless.ts:26` ya usa `"PYUSD"` contra la misma chain 2368, y funciona (WKH-29 DONE). Además, Railway mantendrá `X402_EIP712_DOMAIN_NAME=Kite X402 USD` vía env override hasta que humano cutover. |
| R2 | Tests fallan por cambios de string match en warn | M | B | CD-7 mantiene prefijos exactos; test existente L80 usa `stringContaining('X402_PAYMENT_TOKEN not set')` — inmutable. |
| R3 | Regresión en los 379 tests por side-effect oculto | B | A | CD-5 + Wave check con `vitest run` obligatorio antes de commit. |
| R4 | Sweep incompleto del rename `KXUSD_DEFAULT` → `PYUSD_DEFAULT` | M | M | CD-6 exige lectura completa del archivo. Dev corre `grep -n KXUSD src/` después del refactor → debe retornar 0 matches en src (solo en tests del nuevo T11 y comentarios intencionales). |
| R5 | Alguna ruta o service cachea el token en start-up y no se refresca con env change | B | M | Lectores son lazy (verificado en §3 — leen `process.env` en cada call). No hay cache. Además T11 nuevo cubre explícitamente el scenario. |
| R6 | Conflicto con `feat/037-x402-v2` | Muy B | M | **Resuelto**: PR #14 mergeado (commit c2c4c5b, 2026-04-11). La branch ya no existe. `_INDEX.md` tiene metadata stale pero no hay conflicto real. |
| R7 | Railway deploy post-merge arranca con PYUSD si humano olvida setear `X402_PAYMENT_TOKEN` | M | A | **Escalada al humano**: el gate post-merge lo maneja fuera de esta HU. Work-item AC-8 garantiza que override = KXUSD sigue funcionando si está seteado. F4 QA incluye reminder en el report. |

## 8. Dependencias

- **Pre**: ninguna. La HU es standalone.
- **Post**: humano decide cutover Railway (`X402_PAYMENT_TOKEN` → PYUSD en env de prod) como paso manual. No bloquea merge.
- **Paralelismo**: no bloquea otras HUs activas. Cambios aislados al archivo `payment.ts` (solo 5 líneas de texto) → riesgo de merge conflict con otras HUs es despreciable.

## 9. Missing Inputs

Ninguno. DT-B resuelto (EIP-712 domain name `"PYUSD"` confirmado en `gasless.ts:26`). DT-E resuelto (branch base = `main @ b6e503d`, sin conflicto con 037).

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| _(ninguno)_ | — | Todos los puntos fueron cerrados por el orquestador (pre-F2) y por verificación de exemplars en §3. | — |

---

## Waves de Implementación

### Wave 0 (Serial Gate — pre-work)

- [ ] W0.1: Checkout `main`, pull, verificar commit `b6e503d` (o el HEAD actual). `npm install` si hace falta.
- [ ] W0.2: Crear branch `feat/052-wkh-52-pyusd-migration`.
- [ ] W0.3: Correr `vitest run` baseline → confirmar 379/379 antes de tocar nada. Si baseline falla, **STOP** y escalar.

### Wave 1 (Single wave — todos los cambios son atómicos y pequeños)

Ejecutable en paralelo conceptualmente, pero es 1 wave porque el tamaño no justifica particionado.

- [ ] W1.1: Modificar `src/adapters/kite-ozone/payment.ts` L32-36 (3 constantes) + L48 + L57 (2 warns).
- [ ] W1.2: Modificar `src/adapters/__tests__/payment.contract.test.ts`:
  - Rename `KXUSD_DEFAULT` → `PYUSD_DEFAULT` + update valor (L31).
  - Update `process.env.X402_PAYMENT_TOKEN` en `beforeEach` (L43).
  - Update los 8 asserts de symbol/address (L63, L64, L77, L91, L105, L162, L163 + labels L61, L74, L103, L156).
  - **Agregar T11** (nuevo test AC-5/AC-8) después del bloque existente de env override.
- [ ] W1.3: Modificar `src/services/fee-charge.ts` L120 (1 línea de comentario).
- [ ] W1.4: Modificar `.env` L10-14 (header + 3 valores).
- [ ] W1.5: Modificar `.env.example` L62-74 (header + comentario + 3 valores).
- [ ] W1.6: Modificar `doc/INTEGRATION.md` L196, L213, L235 (3 reemplazos textuales).
- [ ] W1.7: Validación local (serial):
  - `npm run lint` (biome) → 0 errors
  - `npx tsc --noEmit` → 0 errors (CD-10)
  - `npm test` o `vitest run` → 379/379 pass + T11 nuevo = 380 total

> Si W1.7 falla → diagnose → fix → re-run. NO commit hasta 380/380.

### Wave 2 (optional — commit + push)

- [ ] W2.1: `git add <6 archivos>` (nunca `-A`; leer .env para confirmar que no hay secrets accidentales).
- [ ] W2.2: Commit único con mensaje descriptivo referenciando WKH-52 y DT-B resolution.
- [ ] W2.3: `git push -u origin feat/052-wkh-52-pyusd-migration`.

### Verificación Incremental

| Wave | Check al completar |
|------|-------------------|
| W0 | `git status` clean + `vitest run` 379/379 |
| W1 | `biome check` + `tsc --noEmit` + `vitest run` 380/380 |
| W2 | `git log --oneline -n 3` muestra el commit; branch empujada |

---

## Estimación

- Archivos nuevos: 0
- Archivos modificados: 6
- Tests nuevos: 1 (T11)
- Tests modificados: 10 (asserts + const rename)
- Líneas estimadas de diff: ~45 (menos de 10 por archivo promedio)
- Tiempo estimado Dev F3: 20-30 min (incluye validación local)

---

## Implementation Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene al menos 1 archivo asociado en tabla 4.1
    AC-1 → payment.ts + test. AC-2 → payment.ts + test. AC-3 → payment.ts (indirecto). AC-4 → test file. AC-5 → test file (T11). AC-6 → INTEGRATION.md. AC-7 → validación Wave 1.7. AC-8 → test file (T11).
[x] Cada archivo en tabla 4.1 tiene exemplar verificado con Glob/Read
    Todos los paths fueron leídos en §3 — líneas confirmadas.
[x] No hay [NEEDS CLARIFICATION] pendientes
    DT-B resuelto con evidencia gasless.ts:26.
[x] Constraint Directives incluyen al menos 3 PROHIBIDO
    CD-1 a CD-10, de los cuales 8 son PROHIBIDO.
[x] Context Map tiene al menos 2 archivos leídos
    12 archivos leídos con línea precisa.
[x] Scope IN y OUT son explícitos y no ambiguos
    §6.
[x] Si hay BD: tablas verificadas
    N/A — no hay cambios de BD.
[x] Flujo principal (Happy Path) está completo
    §4.4 — 10 pasos.
[x] Flujo de error está definido (al menos 1 caso)
    §4.5 — 6 filas.
[x] Plan de tests cubre cada AC (excepto AC-6 manual)
    §4.6 tabla "Plan de cobertura AC × Test".
[x] Test nuevo (T11) especificado con código de referencia y rationale
    §4.6.
[x] Auto-blindaje histórico revisado y aplicado
    043, 044 leídos. Lección de 043 → CD-10 (tsc explícito). Lección de 044 → no aplica directamente. Sin patrones de error recurrentes detectados (solo 2 HUs con auto-blindaje existente).
[x] Riesgos listados con mitigación
    §7 — 7 riesgos.
```

**Todos los checks PASS. SDD listo para SPEC_APPROVED.**

---

*SDD generado por NexusAgil — FULL · WKH-52 · 2026-04-20*
