# Story File — WKH-117: Kite Agent Passport como payer dual (alias `X-PAYMENT`) + e2e dual-auth

> **Contrato autocontenido para el Dev (F3).** Esta es tu ÚNICA fuente de verdad.
> Implementá wave por wave en orden. NO re-leas el SDD completo; todo lo que
> necesitás está acá. Si algo no está en este archivo, NO lo hagas.
>
> - SDD origen: `doc/sdd/109-kite-passport-dual-auth/sdd.md` (SPEC_APPROVED)
> - Work item: `doc/sdd/109-kite-passport-dual-auth/work-item.md`
> - Branch: `feat/WKH-117-kite-passport-dual-auth`

---

## 1. Contexto mínimo (qué construís y por qué)

El gateway wasiai-a2a hoy lee SOLO el header propio `payment-signature` en
`requirePayment` (`src/middleware/x402.ts:177`). El estándar canónico x402 —
el que usa el backend de **Kite Agent Passport** cuando re-emite una request
paga tras un challenge 402 — usa el header **`X-PAYMENT`**.

**El cambio núcleo (W1, ~10 LOC):** agregar `X-PAYMENT` como **alias de lectura**
de `payment-signature`, con estas reglas exactas:

1. **Precedencia X-PAYMENT** (DT-2 / AC-4): si llegan ambos, gana `X-PAYMENT`.
2. **Guard `.length > 0`** (DT-10): un `X-PAYMENT: ''` vacío NO debe ganar sobre
   un `payment-signature` válido (caso borde T-DH-6).
3. **Guard de tipo `typeof === 'string'`** preservado: si `X-PAYMENT` viene
   duplicado, Fastify entrega `string[]` → cae a `payment-signature`.
4. **Lowercase**: el lookup es `request.headers['x-payment']` (minúsculas).
   Fastify lowercasea TODOS los nombres de header entrantes, así que el
   requisito "case-insensitive" del AC-3 se cumple solo. NO hagas lowercasing
   manual ni iteres headers (DT-9).

De ahí en adelante el flujo `decodeXPayment → verify → settle` es **byte-idéntico**
al actual. NO toques `decodeXPayment`, ni los mensajes de error, ni `verify`/`settle`.

**Zero-regression (CD-1):** el path Agent Key (`x-a2a-key` / `Bearer wasi_a2a_*`)
en `a2a-key.ts` **no se toca — 0 LOC de producción**. El alias vive dentro de
`requirePayment`, que solo corre en la rama fallback de `requirePaymentOrA2AKey`;
por eso un caller con Agent Key válido nunca alcanza el código del alias.

---

## 2. Scope IN (lista exhaustiva de archivos a tocar)

| Wave | Archivo | Acción |
|------|---------|--------|
| **W1** | `src/middleware/x402.ts` | Alias `X-PAYMENT` (~10 LOC), reemplazar lectura en línea 177. Declarar 2 constantes exportadas cerca de `X_PASSPORT_SESSION_HEADER` (línea 29). |
| **W1** | `src/middleware/x402.dual-header.test.ts` | **NUEVO** — tests AC-10 (T-DH-1..7). |
| **W1** | `src/middleware/a2a-key.test.ts` | **+1 caso** T-AK-COEX (AC-2). NO tocar prod. |
| **W2** | `scripts/smoke-e2e-dual-auth.mjs` | **NUEVO** — e2e dual-path (AC-11). |
| **W3 (OPCIONAL)** | `src/services/identity.ts` | **+método** `bindPassport` (clon de `bindFundingWallet`). |
| **W3 (OPCIONAL)** | `src/routes/auth.ts` | **+ruta** `POST /auth/bind-passport`, env-gated. |
| **W3 (OPCIONAL)** | `src/types/a2a-key.ts` | JSDoc del sub-schema `{ address, bound_at }` sobre `kite_passport`. |
| **W3 (OPCIONAL)** | `.env.example` | `+PASSPORT_BINDING_ENABLED=false`. |

> **NO** está en scope: `a2a-key.ts` (prod), `event-tracking.ts`, `decodeXPayment`,
> el facilitator, ninguna DB migration, `tsconfig*.json`.

---

## 3. Anti-Hallucination Checklist (específico de esta HU)

### APIs / símbolos que EXISTEN y podés usar (verificados con Read)

| Símbolo | Dónde | Firma / shape verificada |
|---------|-------|--------------------------|
| `decodeXPayment(header: string): X402PaymentRequest` | `x402.ts:87-110` | base64→JSON→valida `authorization` (object) + `signature` (string). NO la cambies. |
| `requirePayment(opts)` | `x402.ts:112-271` | preHandler. Lee header en línea 177. Setea `paymentOrigin` en línea 136 (antes de leer pago). |
| `buildX402Response(opts, resource, chainKey[, errorMsg])` | `x402.ts` (usado 178-265) | Devuelve `{ error, accepts, x402Version: 2 }`. NO cambies sus strings. |
| `X_PASSPORT_SESSION_HEADER = 'x-passport-session'` | `x402.ts:29` | Constante exportada. Tus 2 constantes nuevas van al lado. |
| `request.paymentOrigin` | declarado `x402.ts:31-42` | `'passport' \| 'eoa'`, telemetry-only. Ya seteado en 136. |
| `getPaymentAdapter / getDefaultChainKey / getAdaptersBundle / getInitializedChainKeys` | import `x402.ts:12-17` desde `../adapters/registry.js` | Las 4 funciones del registry. Todo mock que ejercite `requirePayment` debe exportarlas (CD-7). |
| `buildPassportPaymentHeader(opts?)` / `buildEoaPaymentHeader(opts?)` | `src/__tests__/fixtures/passport-shape.ts` | Devuelven `{ headers, paymentRequest }`. `headers` trae la clave **`payment-signature`** (base64) — para casos `X-PAYMENT` renombrá la clave en el test. |
| `eventService.track(...)` con `payment_origin` | `event-tracking.ts:74-79` | YA persiste `payment_origin`. **AC-7 cubierto, NO lo toques.** |
| `bindFundingWallet(keyId, ownerId, wallet)` | `identity.ts:136-164` | Patrón a clonar para `bindPassport` (W3). |
| `POST /funding-wallet` | `auth.ts:318-389` | Patrón a clonar para `POST /auth/bind-passport` (W3). |
| `resolveCallerKey(req)`, `ADDRESS_RE`, `OwnershipMismatchError` | `auth.ts` (importados, ver `/funding-wallet`) | Disponibles en `auth.ts` para W3. |
| Defense-in-depth `body.keyId === callerKey.id` → 403 `OWNERSHIP_MISMATCH` | `auth.ts:422-425` (`/deposit`) | Patrón para W3. |
| `kpassRun` + `SMOKE_KPASS_MOCK_FILE` + exit 0/1/2/3 | `scripts/smoke-passport-autonomous.mjs:50-318` | Base para W2. |

### NO inventar / NO hacer (límites duros)

- ❌ NO crear endpoints nuevos fuera de W3 (`POST /auth/bind-passport`).
- ❌ NO tocar la lógica/priority order de `a2a-key.ts` (prod = 0 LOC).
- ❌ NO modificar `decodeXPayment` ni los strings de error del 402 (CD-10).
- ❌ NO modificar `event-tracking.ts` (AC-7 ya cubierto).
- ❌ NO crear DB migration (la columna `kite_passport` ya existe).
- ❌ NO modificar el facilitator ni la capa settle.
- ❌ NO modificar `tsconfig.json` / `tsconfig.build.json` (CD-8).
- ❌ NO usar ethers.js (CD-5: solo viem v2).
- ❌ NO hardcodear chain 2366 / addresses de mainnet (CD-2).
- ❌ NO leer `request.body` para resolver el header de pago.

---

## 4. Constraint Directives — CHECKLIST BLOQUEANTE

Antes de cerrar cada wave, verificá. Cualquier violación = el Dev debe corregir
antes de avanzar; AR las bloquea.

- [ ] **CD-1 — ZERO REGRESSION Agent Key.** `git diff src/middleware/a2a-key.ts`
      (prod) debe ser **vacío**. Solo `a2a-key.test.ts` cambia (+1 test). `npm test`
      verde (~2199+ baseline).
- [ ] **CD-2 — TESTNET ONLY.** Sin chain 2366 ni addresses de mainnet hardcodeadas.
      Network desde `KITE_NETWORK` / `KITE_CHAIN_ID`.
- [ ] **CD-3 — OWNERSHIP GUARD (W3).** `bindPassport` filtra
      `.eq('id', keyId).eq('owner_ref', ownerId)` ANTES del `.select()`. Firma con
      `ownerId: string` (NUNCA `string | undefined`). Sin `.eq('owner_ref', …)` = IDOR BLOQUEANTE.
- [ ] **CD-4 — `paymentOrigin` es TELEMETRÍA ONLY.** PROHIBIDO usar su valor como
      decisor de auth, bypass de budget, o input a autorización.
- [ ] **CD-5 — solo viem v2.** Prohibido ethers.js.
- [ ] **CD-6 — sin secrets en código.** Keys / URLs / addresses desde env. En el
      smoke: `SMOKE_A2A_KEY` y target URL desde env, sin defaults secretos.
- [ ] **CD-7 — MOCK COMPLETO de `adapters/registry.js`** en todo test que ejercite
      `requirePayment`. Debe exportar `getPaymentAdapter`, `getDefaultChainKey`,
      `getAdaptersBundle`, `getInitializedChainKeys`. Un mock incompleto devuelve
      `undefined` silencioso → `REGISTRY_NOT_INITIALIZED` 500/400 en vez de 402/200.
      *Antes de mergear W1:* `grep -rn "vi.mock('.*adapters/registry" src/` y validá.
      *(WKH-111 auto-blindaje#093, WKH-69#084.)*
- [ ] **CD-8 — Fixture cross-rootDir: NO romper el build.** El nuevo
      `x402.dual-header.test.ts` debe importar el fixture con el **mismo specifier** que
      `x402.passport-shape.test.ts:50` usa: `'../__tests__/fixtures/passport-shape.js'`
      (nota: el archivo fuente es `.ts`, se importa como `.js` — convención ESM/TS).
      PROHIBIDO tocar `tsconfig*` para "arreglar" el TS6059 (es baseline conocido;
      `tsconfig.build.json` excluye `*.test.ts`). *(WKH-69#084 / WKH-111#093.)*
- [ ] **CD-9 — lint scoped, NO `npm run format`.** Usá `npx biome check --write <file>`
      SOLO sobre los archivos in-scope. PROHIBIDO `biome format --write src/` /
      `npm run format` (reformatea archivos fuera de scope). Si hay drift fuera de
      scope, `git checkout --` esos archivos. *(WKH-AUDIT-A2A auto-blindaje#097.)*
- [ ] **CD-10 — Preservar mensajes de error legacy del 402.** Los strings
      `Invalid payment-signature format: …`, `Payment verification failed: …`,
      `Payment settlement failed: …` NO cambian.

---

## 5. Waves ejecutables (en orden)

### W0 — Baseline verde (no-op de código)

NO hay tipos/contratos nuevos compartidos. Las 2 constantes son locales de `x402.ts`.

**Tarea:** confirmar baseline antes de tocar nada.
```bash
npm test          # debe quedar verde (~2199+ tests) — anotá el número exacto
npm run build     # verde
```
**DoD W0:** baseline registrado y verde. Avanzá a W1.

---

### W1 — Alias `X-PAYMENT` + tests (NÚCLEO, serial) — pieza visible del demo

#### W1.a — `src/middleware/x402.ts` (alias, ~10 LOC)

**Paso 1 — constantes** (al lado de `X_PASSPORT_SESSION_HEADER`, línea 29):
```ts
// Canonical x402 payment header (Kite Agent Passport). Fastify lowercasea los
// nombres de header entrantes → 'x-payment' (no 'X-PAYMENT') es el lookup
// correcto; AC-3 "case-insensitive" se cumple por la plataforma (DT-9).
export const X_PAYMENT_HEADER = 'x-payment';
export const PAYMENT_SIGNATURE_HEADER = 'payment-signature';
```

**Paso 2 — reemplazar la línea 177** (`const xPaymentHeader = request.headers['payment-signature'];`)
por la normalización con precedencia (snippet de referencia SDD §4.2):
```ts
// DT-2 / AC-4: canónico x402 (X-PAYMENT) gana sobre legacy (payment-signature).
// DT-10: .length > 0 evita que un X-PAYMENT vacío gane sobre un payment-signature válido.
// El typeof === 'string' filtra el caso header duplicado (Fastify → string[]).
const canonical = request.headers[X_PAYMENT_HEADER];
const legacy = request.headers[PAYMENT_SIGNATURE_HEADER];
const xPaymentHeader =
  typeof canonical === 'string' && canonical.length > 0 ? canonical : legacy;
```

El **resto IDÉNTICO**: el guard de la línea 178
(`if (!xPaymentHeader || typeof xPaymentHeader !== 'string') → 402`),
`decodeXPayment(xPaymentHeader)`, verify, settle, y todos los strings de error
quedan **sin cambios** (CD-10).

> No movés la línea 136 (`request.paymentOrigin = …`): por eso AC-6 sigue cubierto
> para el path alias automáticamente.

#### W1.b — `src/middleware/x402.dual-header.test.ts` (NUEVO, AC-10)

**Clonar el harness de `x402.passport-shape.test.ts:19-114`** (verificado):
- Mock registry **COMPLETO** (CD-7) — copiá el bloque `vi.mock('../adapters/registry.js')`
  con las 4 funciones (`getPaymentAdapter`, `getDefaultChainKey`,
  `getAdaptersBundle`, `getInitializedChainKeys`) tal cual `passport-shape.test.ts:36-45`.
- `mockVerify` / `mockSettle` (líneas 20-23).
- Import del fixture con el **mismo specifier**: `'../__tests__/fixtures/passport-shape.js'` (CD-8).
- `beforeEach` setea `process.env.KITE_WALLET_ADDRESS` (líneas 56-62) — sin esto, 503.
- Fastify in-memory + `app.inject` (líneas 86-114).

**Renombrado de header para casos `X-PAYMENT`:** el fixture devuelve
`headers['payment-signature']`. Para los casos X-PAYMENT:
```ts
const { headers } = buildPassportPaymentHeader();
const xPaymentHeaders = { 'x-payment': headers['payment-signature'] };
// para "solo X-PAYMENT" no incluyas la clave 'payment-signature'.
```

**Tests requeridos (copiá la tabla §6.1 del SDD):**

| Test ID | AC | Caso | Aserción |
|---------|-----|------|----------|
| **T-DH-1** (a) | AC-3 | `X-PAYMENT` solo (sin `payment-signature`) | `200`; `mockVerify` y `mockSettle` llamados **1×**; header `payment-response` con txHash. |
| **T-DH-2** (b) | AC-3 / regresión | `payment-signature` solo | `200`; verify/settle **1×** (idéntico a hoy). |
| **T-DH-3** (c) | AC-4 | ambos headers, `X-PAYMENT` válido y `payment-signature` distinto | `200`; el `authorization.from` que recibe `mockVerify` proviene del valor de **`X-PAYMENT`** (no del legacy). Usá fixtures con `from` distinto para distinguir. |
| **T-DH-4** (d) | AC-5 | ninguno de los dos | `402`; body `{ error, accepts: [...], x402Version: 2 }`. |
| **T-DH-5** (e) | AC-6 | `x-passport-session: true` + `X-PAYMENT` | `200`; `req.paymentOrigin === 'passport'` (capturado en el handler, patrón líneas 87-95). |
| **T-DH-6** (borde) | AC-4 | `X-PAYMENT: ''` (vacío) + `payment-signature` válido | `200`; gana `payment-signature` (protege el `.length > 0`). |
| **T-DH-7** (borde) | AC-3 | `X-PAYMENT` con base64 inválido | `402`; mensaje `Invalid payment-signature format: …` (string legacy preservado, CD-10). |

#### W1.c — `src/middleware/a2a-key.test.ts` (+1 caso, AC-2)

**NO toques producción.** Agregá un test al describe existente. El mock de registry
en este archivo **ya exporta las 4 funciones** (`a2a-key.test.ts:164-171` —
`getAdaptersBundle`, `getInitializedChainKeys`, `getDefaultChainKey`, `getPaymentAdapter`).

| Test ID | AC | Caso | Aserción |
|---------|-----|------|----------|
| **T-AK-COEX** | AC-2 | `x-a2a-key: <valid>` + `X-PAYMENT: <payload>` simultáneos | Path Agent Key honrado: `budgetService.debit` llamado, `request.a2aKeyRow` seteado, y `verify`/`settle` del adapter (x402) **NO** llamados (**0×**). Priority order intacto. |

**DoD W1:**
- [ ] `git diff src/middleware/a2a-key.ts` (prod) **vacío** (CD-1).
- [ ] `grep -rn "vi.mock('.*adapters/registry" src/` → todos los mocks afectados completos (CD-7).
- [ ] Strings de error 402 sin cambios (CD-10).
- [ ] `npm test` verde (≥ baseline W0). `npm run build` verde.
- [ ] `npx biome check --write src/middleware/x402.ts src/middleware/x402.dual-header.test.ts src/middleware/a2a-key.test.ts` verde, scoped (CD-9).
- [ ] AC-3, AC-4, AC-5, AC-6, AC-2 cubiertos por T-DH-1..7 + T-AK-COEX.

---

### W2 — `scripts/smoke-e2e-dual-auth.mjs` (NUEVO, AC-11)

**Base:** clonar el patrón de `scripts/smoke-passport-autonomous.mjs:50-318`
(`kpassRun(bin, args)` con `SMOKE_KPASS_MOCK_FILE` test hook, exit codes 0/1/2/3,
stdout=JSON, stderr=progress, `hashId` para no loggear secretos).

- **Path A (Agent Key):**
  `fetch(targetUrl, { headers: { 'x-a2a-key': SMOKE_A2A_KEY } })` contra un endpoint
  guardado → espera `200`. Si no hay `SMOKE_A2A_KEY` env → **exit 1** (human gate).
- **Path B (Passport):** reusar `kpassRun(['agent:session','execute','--url',target,…])`.
  Sin sesión activa → **exit 1** (human gate). Con sesión → espera `status:success`
  (`200`) o un `402` challenge bien formado contra un endpoint sin pago previo.
  Este path **valida el wire shape real de `X-PAYMENT`** end-to-end.
- **Exit codes:** `0` ambos PASS · `1` human gate (sin session / sin key) ·
  `2` assertion failure · `3` runtime error.
- **CD-6:** `SMOKE_A2A_KEY` y target URL desde env, sin defaults secretos. `hashId`
  para no loggear el key.
- (Opcional recomendado) test unitario del script con `SMOKE_KPASS_MOCK_FILE` + fetch stub para Path A.

**DoD W2:**
- [ ] Script ejecutable, exit codes 0/1/2/3 correctos.
- [ ] Sin secrets hardcodeados (CD-6); `hashId` en logs.
- [ ] `npm test` sigue verde. `npx biome check --write scripts/smoke-e2e-dual-auth.mjs` verde.
- [ ] AC-11 cubierto.

> **Nota W2/W3:** son independientes entre sí; podés hacerlas en cualquier orden tras W1.
> Si el wire shape revelara un nombre de header distinto a `X-PAYMENT`, es un one-liner
> en la constante `X_PAYMENT_HEADER` — documentar en F4, NO expandir scope acá.

---

### W3 — `POST /auth/bind-passport` (OPCIONAL / env-gated / OMITIBLE)

> **W3 es OMITIBLE.** Si el tiempo no alcanza, W1+W2 completan el demo (el alias es
> la pieza visible). W3 no bloquea nada. Implementala solo si W1+W2 están verdes y hay tiempo.

#### W3.a — `src/services/identity.ts` (+`bindPassport`)

Clonar **exacto** `bindFundingWallet` (`identity.ts:136-164`). Snippet de referencia (SDD §4.5):
```ts
async bindPassport(
  keyId: string,
  ownerId: string,           // CD-3: NUNCA string | undefined
  passportAddress: string,
): Promise<{ address: string; bound_at: string }> {
  const normalized = passportAddress.toLowerCase();
  const boundAt = new Date().toISOString();
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .update({ kite_passport: { address: normalized, bound_at: boundAt } })
    .eq('id', keyId)
    .eq('owner_ref', ownerId)   // ← CD-3 imprescindible (ownership guard)
    .select('id');
  if (error) throw new Error(`Failed to bind passport: ${error.message}`);
  if (!data || data.length === 0) {
    logOwnershipMismatch('bindPassport', keyId, ownerId);
    throw new OwnershipMismatchError();
  }
  return { address: normalized, bound_at: boundAt };
}
```

#### W3.b — `src/routes/auth.ts` (+`POST /auth/bind-passport`, gate-at-mount)

Clonar `POST /funding-wallet` (`auth.ts:318-389`). **DT-8: gate-at-mount** —
registrar la ruta **solo si** `process.env.PASSPORT_BINDING_ENABLED === 'true'`
(si está off → 404 natural, sin exponer superficie). F3 puede elegir gate-in-handler
si encaja mejor con el estilo de `auth.ts`, pero gate-at-mount es preferible.

Handler:
1. `resolveCallerKey(req)` → `403` si `!is_active`.
2. Validar `passportAddress` con `ADDRESS_RE` (ya importado) → `400 INVALID_INPUT`.
3. Defense-in-depth (CD-3, patrón `auth.ts:422-425`): si el body trae `keyId`,
   exigir `body.keyId === callerKey.id` → si no, `403 OWNERSHIP_MISMATCH`.
   El `keyId` autoritativo es `callerKey.id` (NUNCA del body).
4. `identityService.bindPassport(callerKey.id, callerKey.owner_ref, passportAddress)`.
5. Mapear `OwnershipMismatchError` → `403 OWNERSHIP_MISMATCH`. Éxito → `200 { kite_passport: {...} }`.

#### W3.c — `src/types/a2a-key.ts` (JSDoc)

Documentar vía JSDoc el sub-schema `{ address, bound_at }` sobre el campo
`kite_passport` (línea 52). **Sin cambio de tipo** (`Record<string, unknown> | null` se mantiene).

#### W3.d — `.env.example`

Agregar `PASSPORT_BINDING_ENABLED=false`.

> **AC-9 (read-only):** `kite_passport` ya se expone en `GET /me` y en
> `request.a2aKeyRow.kite_passport`. NO entra en ningún branch de auth/debit. Nada que codear para la lectura.

**DoD W3:**
- [ ] `bindPassport` filtra `.eq('id', …).eq('owner_ref', …)` antes del `.select()` (CD-3).
- [ ] Firma con `ownerId: string` (no opcional).
- [ ] Ruta gate-at-mount con `PASSPORT_BINDING_ENABLED`.
- [ ] `npm test` verde (idealmente +tests de ownership 403). `npm run build` verde.
- [ ] `npx biome check --write` scoped a los 4 archivos W3 (CD-9).
- [ ] AC-8, AC-9 cubiertos.

---

## 6. Definition of Done — global

- [ ] **W0**: baseline verde registrado.
- [ ] **W1**: alias implementado; T-DH-1..7 + T-AK-COEX verdes; `a2a-key.ts` prod diff vacío.
- [ ] **W2**: smoke dual-auth con exit codes 0/1/2/3.
- [ ] **W3 (opcional)**: si se hace, ownership-guarded + env-gated.
- [ ] `npm test` verde (≥ ~2199 baseline). `npm run build` verde.
- [ ] Lint scoped verde (CD-9) — sin archivos fuera de Scope IN en el diff.
- [ ] **Todos los CD-1..10 chequeados** (§4).
- [ ] ACs cubiertos: AC-1/AC-2 (estructura + T-AK-COEX), AC-3/4/5 (T-DH-1..7),
      AC-6 (T-DH-5 + 136 sin mover), AC-7 (código existente, sin cambio),
      AC-8/9 (W3 si se hace), AC-10 (dual-header.test), AC-11 (smoke W2).

---

## 7. Mapa AC → Test / Evidencia (para F4)

| AC | Cubierto por | Archivo |
|----|--------------|---------|
| AC-1 | Estructura `requirePaymentOrA2AKey` (0 LOC) + suite existente verde | `a2a-key.ts` (sin cambio) |
| AC-2 | T-AK-COEX | `a2a-key.test.ts` |
| AC-3 | T-DH-1, T-DH-2, T-DH-7 | `x402.dual-header.test.ts` |
| AC-4 | T-DH-3, T-DH-6 | `x402.dual-header.test.ts` |
| AC-5 | T-DH-4 | `x402.dual-header.test.ts` |
| AC-6 | T-DH-5 (+ `x402.ts:136` sin mover) | `x402.dual-header.test.ts` |
| AC-7 | `event-tracking.ts:74-79` + `event-tracking.test.ts:232-294` (existentes) | sin cambio |
| AC-8 | W3 ruta + test ownership (si se hace) | `auth.ts` / `identity.ts` |
| AC-9 | `GET /me` existente + JSDoc | `a2a-key.ts` (read-only) |
| AC-10 | T-DH-1..7 | `x402.dual-header.test.ts` |
| AC-11 | smoke + exit codes | `smoke-e2e-dual-auth.mjs` |
