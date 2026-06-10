# SDD #109: [WKH-117] Kite Agent Passport como payer dual (Agent Key O Passport) + e2e dual-auth

> SPEC_APPROVED: no
> Fecha: 2026-06-10
> Tipo: feature (evolutivo sobre superficie crítica AUTH + PAGO)
> SDD_MODE: full (QUALITY)
> Branch: feat/WKH-117-kite-passport-dual-auth
> Artefactos: doc/sdd/109-kite-passport-dual-auth/
> Work item: doc/sdd/109-kite-passport-dual-auth/work-item.md

---

## 1. Resumen

El gateway hoy lee el header propio `payment-signature` en `requirePayment`
(`src/middleware/x402.ts:177`). El estándar canónico x402 — el que usa el backend de
Kite Agent Passport cuando re-emite una request paga tras un challenge 402 — usa el
header `X-PAYMENT`. Esta HU agrega un **alias de lectura**: `X-PAYMENT` se acepta como
fuente del payload de pago, con **precedencia sobre `payment-signature`** (DT-2), y de
ahí en adelante el flujo `decodeXPayment → verify → settle` es **byte-idéntico** al
actual. Es ~10 LOC de normalización de header, no un rewrite.

El cambio es **puramente aditivo y zero-regression**:

- Path Agent Key (`x-a2a-key` / `Bearer wasi_a2a_*`) en `a2a-key.ts` **no se toca**.
  El priority order (`x-a2a-key` > Bearer > x402 fallback) queda intacto (CD-1).
- `paymentOrigin` (telemetría WKH-69) ya se setea en `requirePayment` antes de leer el
  header de pago (`x402.ts:132-136`), así que el alias hereda la telemetría sin trabajo
  extra (AC-6).
- `payment_origin` **ya se persiste** en `a2a_events` (`event-tracking.ts:74-79`): AC-7
  está cubierto por código existente — **cero scope nuevo** (ver §7 / DT-7).

Waves: **W1** (alias + tests AC-10) es la pieza visible para el demo del jurado Kite y
es autocontenida. **W2** (script e2e dual-auth) valida el wire shape real de Passport.
**W3** (endpoint `POST /auth/bind-passport`, env-gated) es **OPCIONAL/OMITIBLE** sin
afectar el demo.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 109 (WKH-117) |
| **Tipo** | feature / evolutivo sobre AUTH+PAGO |
| **SDD_MODE** | full (QUALITY — toca cadena de auth + path de pago) |
| **Objetivo** | Aceptar `X-PAYMENT` como alias canónico de `payment-signature` (con precedencia), preservar paymentOrigin para el alias, binding opcional Key↔Passport env-gated, y un e2e dual-auth. Cero regresión Agent Key. |
| **Reglas de negocio** | Golden Path: sin hardcodes (chain/URL/key), solo viem, TS strict, testnet only, ownership guard en toda query a `a2a_agent_keys`. |
| **Scope IN** | `src/middleware/x402.ts` (alias header, núcleo), tests AC-10 (`src/middleware/x402.dual-header.test.ts`), `src/middleware/a2a-key.test.ts` (caso coexistencia AC-2), `scripts/smoke-e2e-dual-auth.mjs`, [W3 opcional] `src/routes/auth.ts` + `src/services/identity.ts` + `.env.example`. |
| **Scope OUT** | Kite mainnet (2366), facilitator externo, lifecycle de sesiones Passport, RLS Postgres, cambio de paymentOrigin a signal de auth, DB migration (columna ya existe). |
| **Missing Inputs** | Resueltos en §3.0 (header real) y §7 (AC-7). Validación definitiva del wire shape de Passport = W2 smoke. |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1** (Ubiquitous): el system SHALL seguir autenticando y debitando callers
  con `x-a2a-key` o `Bearer wasi_a2a_*` con comportamiento inalterado (priority order,
  budget debit, `request.a2aKeyRow`), independientemente del alias `X-PAYMENT`.
- **AC-2** (Unwanted): IF una request trae un Agent Key válido AND un header `X-PAYMENT`
  o `payment-signature` simultáneamente, THEN el system SHALL honrar el path Agent Key
  y NO intentar verify/settle del header de pago.
- **AC-3** (Event-driven): WHEN una request a una ruta guardada por `requirePayment` trae
  `X-PAYMENT` (case-insensitive) pero NO `payment-signature`, THEN tratar `X-PAYMENT`
  como payload, decodificar vía `decodeXPayment`, y seguir el flujo verify/settle igual
  que `payment-signature`.
- **AC-4** (Event-driven): WHEN ambos `X-PAYMENT` y `payment-signature` están presentes,
  THEN usar `X-PAYMENT` como header autoritativo (canónico gana sobre legacy).
- **AC-5** (Unwanted): IF ni `X-PAYMENT` ni `payment-signature` están presentes, THEN
  responder HTTP 402 con el challenge estándar (`{error, accepts, x402Version}`),
  idéntico al comportamiento actual.
- **AC-6** (Event-driven): WHEN llega `x-passport-session: true` AND el pago se procesa
  por el path `X-PAYMENT` o `payment-signature`, THEN setear `request.paymentOrigin = 'passport'`.
- **AC-7** (Ubiquitous): el system SHALL incluir `paymentOrigin` en el record de
  telemetría `a2a_events` de cada request settled (`'passport'` | `'eoa'`).
- **AC-8** (Optional — WHERE `PASSPORT_BINDING_ENABLED=true`): exponer
  `POST /auth/bind-passport` que acepta `{ keyId, passportAddress }` y persiste el binding
  en `a2a_agent_keys.kite_passport` (`{ address, bound_at }`), gated por ownership.
- **AC-9** (Ubiquitous): el binding `kite_passport` SHALL ser read-only desde el consumer
  (informational en `GET /auth/keys/:id` y `request.a2aKeyRow.kite_passport`). NO altera
  auth priority ni debit.
- **AC-10** (Ubiquitous): vitest unit tests del alias en `x402.dual-header.test.ts`
  cubriendo (a) `X-PAYMENT` solo, (b) `payment-signature` solo (regresión), (c) ambos →
  `X-PAYMENT` gana, (d) ninguno → 402, (e) `x-passport-session:true` + `X-PAYMENT` →
  `paymentOrigin='passport'`. Adapter mockeado en `vi.mock('../adapters/registry.js')`.
- **AC-11** (Ubiquitous): `scripts/smoke-e2e-dual-auth.mjs` que valida Path A (Agent Key →
  200) y Path B (Passport/x402 → 200 o 402 si no hay sesión). Exit codes 0/1/2/3.

---

## 3. Codebase Grounding

### 3.0 Confirmación del header `X-PAYMENT` (supuesto crítico del work-item)

El work-item ASUME que Kite Passport envía `X-PAYMENT`. Resultado de la verificación:

**a) Fastify normaliza los nombres de header a minúsculas.** Node.js `http` (y por ende
Fastify) lowercasea TODOS los nombres de header entrantes. `x402.ts:177` ya lo asume:
lee `request.headers['payment-signature']` (minúsculas), no `'Payment-Signature'`. Por lo
tanto el alias debe leer **`request.headers['x-payment']`** (minúsculas). El requisito
"case-insensitive" del AC-3 se cumple **automáticamente** por la normalización de Fastify —
NO hace falta lowercasing manual ni iterar headers. (Verificado: el patrón existente de
`x-passport-session` en `x402.ts:132` y `x-payment-chain` en `x402.ts:144` también leen
en minúsculas.)

**b) `X-PAYMENT` es el header canónico del estándar x402.** Confirmado por
`/home/ferdev/.claude/skills/x402-execute/SKILL.md` y `request-session/SKILL.md`: el
backend de Passport hace preflight (recibe el 402 challenge del merchant) y re-emite la
request con el pago negociado de forma transparente (`agent:session execute`). Los skills
documentan que el flujo es x402 estándar HTTP-native; el header canónico de transporte de
pago en x402 es `X-PAYMENT` (base64 del JSON `{authorization, signature}`). El shape del
payload ya está validado contra el gateway en WKH-69 (ver `x402.passport-shape.test.ts` y
el fixture `buildPassportPaymentHeader`).

**Decisión:** se implementa el alias `x-payment` (lowercase) → mismo flujo que
`payment-signature`. El **wire shape real end-to-end** (que el backend de Passport
efectivamente mande `X-PAYMENT` y no otra variante) se confirma de forma definitiva en el
smoke **W2** (`smoke-e2e-dual-auth.mjs`, Path B). Si W2 revela un nombre distinto, el alias
es un one-liner de ajuste (la constante `X_PAYMENT_HEADER`, §4.2) y se documenta como
desviación en F4 — NO bloquea W1, que es defendible por el estándar x402 canónico.
**Esto NO es un `[NEEDS CLARIFICATION]` bloqueante** porque el alias por el estándar es
correcto-por-defecto y la validación está agendada (W2).

### 3.1 Archivos leídos (file:line) y patrones extraídos

| Archivo | Líneas clave | Qué extraje |
|---------|--------------|-------------|
| `src/middleware/x402.ts` | 87-110 `decodeXPayment`; 130-136 paymentOrigin; 144-146 `x-payment-chain`; **177-197** lectura `payment-signature` + decode | **Punto de inserción exacto del alias**: línea 177 (`const xPaymentHeader = request.headers['payment-signature']`). `decodeXPayment(header: string): X402PaymentRequest` decodifica base64→JSON→valida `authorization` (object) + `signature` (string). El flujo verify (198-220) / settle (233-265) ya consume el resultado de decode sin importar de qué header vino. paymentOrigin se setea en 136, ANTES de la línea 177 → ya cubre AC-6 para el alias sin cambios. |
| `src/middleware/a2a-key.ts` | 183-213 `requirePaymentOrA2AKey` (priority order + `runX402Fallback`) | Priority: `x-a2a-key` (195) > `Bearer wasi_a2a_*` (200-206) > x402 fallback (`runX402Fallback`, 211). Si hay `rawKey` válido NUNCA cae al x402 path → AC-1/AC-2 ya garantizados por la estructura actual: **el alias vive dentro de `requirePayment`, que solo se ejecuta en la rama fallback**. No requiere cambio en `a2a-key.ts`. |
| `src/middleware/x402.passport-shape.test.ts` | 19-51 (mock registry), 72-114 (inject pattern) | **Patrón de test a clonar para AC-10**: `vi.mock('../adapters/registry.js')` con `getPaymentAdapter/getDefaultChainKey/getAdaptersBundle/getInitializedChainKeys`. Fastify in-memory + `app.inject`. Fixtures `buildPassportPaymentHeader()` / `buildEoaPaymentHeader()` desde `../__tests__/fixtures/passport-shape.js` devuelven `{ headers, paymentRequest }` con la clave `payment-signature`. |
| `src/middleware/event-tracking.ts` | 74-79 | **AC-7 ya cubierto**: `...(request.paymentOrigin ? { payment_origin: request.paymentOrigin } : {})` se spreadea en `metadata` del `eventService.track`. Sin cambios. |
| `src/types/a2a-key.ts` | 52 `kite_passport: Record<string, unknown> | null`; 123-127 bindings en `AgentMeResponse` | La columna ya existe en `A2AAgentKeyRow` y se expone en `GET /me`. Solo falta documentar el sub-schema `{ address, bound_at }` vía JSDoc (DT-6). |
| `src/services/identity.ts` | 109-124 `deactivate` (ownership UPDATE); **136-164 `bindFundingWallet`** | **Patrón exacto de servicio ownership-guarded para `bindPassport` (W3)**: `.update({...}).eq('id', keyId).eq('owner_ref', ownerId).select('id')` → si `data.length===0` → `logOwnershipMismatch(...) + throw OwnershipMismatchError()`. Firma `(keyId: string, ownerId: string, value: string)` — `ownerId` NUNCA opcional. |
| `src/routes/auth.ts` | 318-389 `POST /funding-wallet` | **Patrón exacto de ruta para `POST /auth/bind-passport` (W3)**: `resolveCallerKey(req)` → check `is_active` 403 → validar input (NUNCA `key_id`/`owner_ref` del body) → llamar service ownership-guarded → mapear `OwnershipMismatchError` → 403 `OWNERSHIP_MISMATCH`. `callerKey.id` y `callerKey.owner_ref` salen del caller autenticado. |
| `scripts/smoke-passport-autonomous.mjs` | 50-177 (kpass runner + mock hook), 200-318 (flujo) | **Patrón base para `smoke-e2e-dual-auth.mjs` (W2)**: `kpassRun(bin, args)` con `SMOKE_KPASS_MOCK_FILE` test hook, exit codes 0/1/2/3, stdout=JSON / stderr=progress, `hashId` para no loggear secretos. El path Passport (kpass) se reusa tal cual; se agrega el path Agent Key como caso paralelo. |

---

## 4. Diseño técnico por AC

### 4.1 AC-1 / AC-2 — Zero regression Agent Key (sin cambio de código)

`requirePaymentOrA2AKey` (`a2a-key.ts:188-213`) resuelve `rawKey` (x-a2a-key > Bearer) y
SOLO delega a `runX402Fallback(x402Handlers, …)` cuando `!rawKey`. Como el alias `X-PAYMENT`
vive **dentro** de `requirePayment` (que solo corre en la rama fallback), un caller con
Agent Key válido **nunca** alcanza el código del alias → AC-1 y AC-2 quedan garantizados
por la arquitectura existente, **sin tocar `a2a-key.ts`** (DT-1, CD-1).

> El cambio en `a2a-key.ts` es **CERO líneas de producción**. Solo se agrega un test de
> coexistencia (§6, AC-2) que prueba que `x-a2a-key` + `X-PAYMENT` simultáneos → path Key,
> sin llamar verify/settle.

### 4.2 AC-3 / AC-4 / AC-5 — Alias `X-PAYMENT` → `payment-signature` (núcleo, ~10 LOC)

**Punto de inserción:** `x402.ts:177`, reemplazar la lectura directa del header por una
normalización con precedencia. Diseño (snippet ilustrativo, F3 lo implementa):

```ts
// Constante exportada junto a X_PASSPORT_SESSION_HEADER (x402.ts:29).
// Fastify lowercasea los nombres de header entrantes; por eso 'x-payment'
// (no 'X-PAYMENT') es el lookup correcto y AC-3 "case-insensitive" se cumple solo.
export const X_PAYMENT_HEADER = 'x-payment';
export const PAYMENT_SIGNATURE_HEADER = 'payment-signature';

// --- en requirePayment, reemplazando la línea 177 ---
// DT-2 / AC-4: canónico x402 (X-PAYMENT) gana sobre el legacy (payment-signature).
const canonical = request.headers[X_PAYMENT_HEADER];      // x-payment
const legacy = request.headers[PAYMENT_SIGNATURE_HEADER]; // payment-signature
const xPaymentHeader =
  typeof canonical === 'string' && canonical.length > 0
    ? canonical
    : legacy;
// resto IDÉNTICO: if (!xPaymentHeader || typeof xPaymentHeader !== 'string') → 402
//                 paymentPayload = decodeXPayment(xPaymentHeader) → verify → settle
```

- **AC-3**: `X-PAYMENT` presente, `payment-signature` ausente → `canonical` se usa → decode
  + verify/settle igual que hoy.
- **AC-4**: ambos presentes → `canonical` (X-PAYMENT) gana (DT-2). El valor de
  `payment-signature` se ignora.
- **AC-5**: ninguno → `xPaymentHeader` es `undefined` → el guard existente (`x402.ts:178`)
  responde 402 con `buildX402Response` — comportamiento byte-idéntico al actual.

> **Notas de robustez (heredan auto-blindaje, ver §9 CD):**
> - El guard de tipo `typeof … === 'string'` se preserva: si un caller manda `X-PAYMENT`
>   dos veces, Fastify entrega `string[]` → `canonical` no es `string` → cae a `legacy`.
>   Esto es defensivo y consistente con el guard de la línea 178.
> - Se chequea `.length > 0` para que un `X-PAYMENT: ''` vacío NO gane sobre un
>   `payment-signature` válido (evita el caso borde "empty string wins").
> - El `decodeXPayment` y todos los mensajes de error (`Invalid payment-signature
>   format: …`) NO cambian — el mensaje de error legacy se mantiene por backward-compat
>   (un caller x402 estándar igual entiende el 402 `{error, accepts, x402Version}`).

### 4.3 AC-6 — paymentOrigin para el path alias (sin cambio adicional)

`request.paymentOrigin` se setea en `x402.ts:136` (a partir de `x-passport-session`),
**antes** de la lectura del header de pago. Como el alias no mueve esa línea, AC-6 se
cumple para el path `X-PAYMENT` exactamente igual que para `payment-signature`. El test
AC-10(e) (§6) lo verifica explícitamente.

### 4.4 AC-7 — paymentOrigin en a2a_events (YA cubierto — ver §7)

Sin cambio de código. `event-tracking.ts:74-79` ya persiste `payment_origin` en la
metadata del evento. El test existente `event-tracking.test.ts:232-294` ya cubre
passport/eoa/undefined.

### 4.5 AC-8 / AC-9 — Binding opcional Key↔Passport (W3, OPCIONAL, env-gated)

**Servicio** (`identity.ts`, nuevo método `bindPassport`, clonando `bindFundingWallet`):

```ts
// Ownership Guard (CD-3): UPDATE filtrado por id AND owner_ref.
async bindPassport(
  keyId: string,
  ownerId: string,
  passportAddress: string,
): Promise<{ address: string; bound_at: string }> {
  const normalized = passportAddress.toLowerCase();
  const boundAt = new Date().toISOString();
  const { data, error } = await supabase
    .from('a2a_agent_keys')
    .update({ kite_passport: { address: normalized, bound_at: boundAt } })
    .eq('id', keyId)
    .eq('owner_ref', ownerId)   // ← CD-3 imprescindible
    .select('id');
  if (error) throw new Error(`Failed to bind passport: ${error.message}`);
  if (!data || data.length === 0) {
    logOwnershipMismatch('bindPassport', keyId, ownerId);
    throw new OwnershipMismatchError();
  }
  return { address: normalized, bound_at: boundAt };
}
```

**Ruta** (`auth.ts`, `POST /auth/bind-passport`, env-gated por `PASSPORT_BINDING_ENABLED`):

- Registrar la ruta **solo si** `process.env.PASSPORT_BINDING_ENABLED === 'true'` (gate al
  momento de montar la ruta dentro del plugin de `auth.ts`), o registrar siempre y
  responder 404/403 si el flag está off. **DT-8 (nuevo): gate al montar** — si está off, la
  ruta no existe (404 natural), evitando exponer superficie. F3 elige el patrón que respete
  el estilo de `auth.ts`; preferible gate-at-mount.
- Handler: `resolveCallerKey(req)` → 403 si `!is_active` → validar
  `passportAddress` con `ADDRESS_RE` (ya importado en `auth.ts`, ver `/funding-wallet`).
  `keyId` se toma de `callerKey.id` (NUNCA del body — defense-in-depth CD-3) **o** se valida
  que `body.keyId === callerKey.id` → 403 `OWNERSHIP_MISMATCH` (igual a `/deposit`,
  `auth.ts:422-425`).
- Llamar `identityService.bindPassport(callerKey.id, callerKey.owner_ref, passportAddress)`
  → mapear `OwnershipMismatchError` → 403 `OWNERSHIP_MISMATCH`. 200 `{ kite_passport: {...} }`.

**AC-9 read-only:** `kite_passport` ya se expone en `GET /me` (`AgentMeResponse.bindings`,
`a2a-key.ts`/`auth.ts:530`) y en `request.a2aKeyRow.kite_passport`. No hay nada que cambiar
para la lectura; el binding NO entra en ningún branch de auth/debit (es metadata inerte).

> **W3 es OMITIBLE.** Si el tiempo del hackathon no alcanza, se entrega W1+W2 y el demo
> (alias visible) está completo. W3 no bloquea nada.

---

## 5. Waves de implementación

| Wave | Tipo | Archivos | Contenido | Bloquea |
|------|------|----------|-----------|---------|
| **W0** | serial (setup) | — | No hay tipos/contratos nuevos compartidos. `X_PAYMENT_HEADER`/`PAYMENT_SIGNATURE_HEADER` son constantes locales de `x402.ts`. **W0 es no-op** salvo confirmar baseline verde (`npm test`, `npm run build`). | W1 |
| **W1** | núcleo (serial) | `src/middleware/x402.ts` (+alias, ~10 LOC), `src/middleware/x402.dual-header.test.ts` (nuevo, AC-10 a–e), `src/middleware/a2a-key.test.ts` (+1 caso AC-2) | Alias `X-PAYMENT`→`payment-signature` con precedencia. Tests del critical path. **Autocontenida — pieza visible del demo.** | W2 (lógico), no técnico |
| **W2** | e2e (paralelizable tras W1) | `scripts/smoke-e2e-dual-auth.mjs` (nuevo) | Path A (Agent Key→200) + Path B (Passport/x402 via kpass→200/402). Valida wire shape real de `X-PAYMENT`. Exit codes 0/1/2/3. | — |
| **W3** | OPCIONAL / env-gated | `src/routes/auth.ts` (+`POST /auth/bind-passport`), `src/services/identity.ts` (+`bindPassport`), `src/types/a2a-key.ts` (JSDoc sub-schema), `.env.example` (+`PASSPORT_BINDING_ENABLED=false`) | Binding Key↔Passport ownership-guarded. **OMITIBLE sin afectar el demo.** | — |

**Orden obligatorio:** W0 → W1 → (W2 ∥ W3). W2 y W3 son independientes entre sí. Si se
omite W3, el SDD se considera cumplido con W1+W2 (W3 marcada opcional en el work-item §"Waves").

---

## 6. Test plan (≥1 test por AC)

### 6.1 `src/middleware/x402.dual-header.test.ts` (nuevo) — AC-10 (a–e)

Clonar el harness de `x402.passport-shape.test.ts` (mock registry COMPLETO §3.1 + Fastify
inject + fixtures `buildPassportPaymentHeader`/`buildEoaPaymentHeader`). El fixture devuelve
la clave `payment-signature`; para los casos `X-PAYMENT` se renombra la clave del header en
el test (`{ 'x-payment': headers['payment-signature'] }`).

| Test ID | AC | Caso | Aserción |
|---------|-----|------|----------|
| T-DH-1 (a) | AC-3 | `X-PAYMENT` solo (sin `payment-signature`) | 200; `mockVerify` y `mockSettle` llamados 1×; `payment-response` header con txHash |
| T-DH-2 (b) | AC-3/regresión | `payment-signature` solo | 200; verify/settle 1× (idéntico a hoy) |
| T-DH-3 (c) | AC-4 | ambos headers, con `X-PAYMENT` válido y `payment-signature` distinto/inválido | 200; el `authorization.from` que recibe `mockVerify` proviene del valor de `X-PAYMENT` (no del legacy) |
| T-DH-4 (d) | AC-5 | ninguno de los dos | 402; body `{error, accepts:[…], x402Version:2}` |
| T-DH-5 (e) | AC-6 | `x-passport-session:true` + `X-PAYMENT` | 200; `req.paymentOrigin === 'passport'` (capturado en el handler) |
| T-DH-6 (borde) | AC-4 | `X-PAYMENT: ''` (vacío) + `payment-signature` válido | 200; gana `payment-signature` (no el string vacío) — protege el `.length > 0` |
| T-DH-7 (borde) | AC-3 | `X-PAYMENT` con base64 inválido | 402; mensaje `Invalid payment-signature format: …` (mensaje legacy preservado) |

### 6.2 `src/middleware/a2a-key.test.ts` (+1 caso) — AC-2 coexistencia

Agregar un test al describe existente (mocks ya presentes: identityService/budgetService/
delegationService/registry):

| Test ID | AC | Caso | Aserción |
|---------|-----|------|----------|
| T-AK-COEX | AC-2 | `x-a2a-key: <valid>` + `X-PAYMENT: <payload>` simultáneos | Path Agent Key honrado: `budgetService.debit` llamado, `request.a2aKeyRow` seteado, y el adapter `verify`/`settle` (x402) **NO** llamado (0×). Priority order intacto. |

> Verificar que el mock de `a2a-key.test.ts` exporte las funciones del registry que usa
> `requirePayment` (`getDefaultChainKey`, `getAdaptersBundle`, `getInitializedChainKeys`) —
> ver CD-7 (auto-blindaje #093). Si el test de coexistencia no llega al x402 fallback (lo
> esperado), el mock no necesita extenderse; pero si alguna aserción negativa fuerza el
> path, debe estar completo.

### 6.3 `scripts/smoke-e2e-dual-auth.mjs` (W2) — AC-11

- **Test unitario del script** (opcional pero recomendado, patrón
  `smoke-passport-autonomous`): usar `SMOKE_KPASS_MOCK_FILE` + un fetch stub para Path A.
- **Path A (Agent Key):** `fetch(targetUrl, { headers: { 'x-a2a-key': SMOKE_A2A_KEY } })`
  contra un endpoint guardado → espera 200. Si no hay `SMOKE_A2A_KEY` env → exit 1.
- **Path B (Passport):** reusar `kpassRun(['agent:session','execute','--url',target,…])`. Si
  no hay sesión activa → exit 1 (human gate). Con sesión → espera `status:success` (200) o,
  contra un endpoint sin pago previo, un 402 challenge bien formado.
- Exit codes: 0 = ambos paths PASS; 1 = human gate (no session / no key); 2 = assertion
  failure; 3 = runtime error. stdout=JSON, stderr=progress, sin secretos en logs
  (`hashId`).

### 6.4 Regresión global

`npm test` debe quedar **verde** (baseline ~2199+ tests, CD-1). `npm run build`
(`tsconfig.build.json` excluye `*.test.ts`) verde. `npm run lint` (biome) en los archivos
in-scope verde.

---

## 7. AC-7 — Acotación de `paymentOrigin` en `a2a_events` (decisión cerrada)

**Estado: YA IMPLEMENTADO — sin scope nuevo.** `src/middleware/event-tracking.ts:74-79`
ya spreadea `payment_origin: request.paymentOrigin` dentro de `metadata` del
`eventService.track`, de forma condicional (si `undefined`, la key se omite — forward-compat).
El test `event-tracking.test.ts:232-294` ya cubre los tres casos (passport / eoa / undefined).

Como el alias `X-PAYMENT` **no mueve** la línea `x402.ts:136` que setea `paymentOrigin`, la
telemetría se dispara para el path alias automáticamente. **AC-7 se considera satisfecho
por código existente; F3 NO agrega ni modifica nada para AC-7** (solo verifica en F4 que el
test existente pasa). Esto evita crecer scope hacia el event tracking (DT-7).

---

## 8. Decisiones técnicas

### Heredadas del work-item (vigentes)

- **DT-1**: Alias en `x402.ts`, no en `a2a-key.ts`. ✅ Confirmado por §4.1/§4.2: el alias
  vive en `requirePayment`, que solo corre en la rama fallback de `a2a-key.ts`.
- **DT-2**: `X-PAYMENT` gana sobre `payment-signature` cuando ambos presentes. ✅ §4.2.
- **DT-3**: Detección Passport via `x-passport-session: true` (no se infiere del contenido
  de `X-PAYMENT`). ✅ Sin cambio — `x402.ts:132-136`.
- **DT-4**: Binding = endpoint REST nuevo `POST /auth/bind-passport`, env-gated. ✅ §4.5/W3.
- **DT-5**: `smoke-e2e-dual-auth.mjs` reutiliza patrón de `smoke-passport-autonomous.mjs`.
  ✅ Confirmado que el script existe (`scripts/smoke-passport-autonomous.mjs`).
- **DT-6**: No DB migration — columna `kite_passport` ya existe (`a2a-key.ts:52`). ✅ Solo
  JSDoc del sub-schema `{ address, bound_at }`.

### Nuevas (este SDD)

- **DT-7 (nuevo)**: AC-7 se satisface con `event-tracking.ts:74-79` existente. **No se
  agrega código para AC-7** — evita crecer scope hacia event tracking. (§7)
- **DT-8 (nuevo)**: El endpoint `POST /auth/bind-passport` (W3) se **gate-at-mount**: si
  `PASSPORT_BINDING_ENABLED !== 'true'`, la ruta no se registra (404 natural), sin exponer
  superficie. F3 puede elegir gate-in-handler si encaja mejor con el estilo de `auth.ts`,
  pero gate-at-mount es preferible.
- **DT-9 (nuevo)**: Lookup del header del alias es `request.headers['x-payment']`
  (minúsculas) por la normalización de Fastify. NO se hace lowercasing manual ni iteración
  de headers — el AC-3 "case-insensitive" se cumple por la plataforma. (§3.0a)
- **DT-10 (nuevo)**: Guard `.length > 0` en el valor `X-PAYMENT` para que un header vacío
  NO gane precedencia sobre un `payment-signature` válido (caso borde T-DH-6). (§4.2)

---

## 9. Constraint Directives

### Heredadas del work-item (reafirmadas)

- **CD-1 — ZERO REGRESSION path Agent Key.** PROHIBIDO alterar la lógica/priority order de
  `requirePaymentOrA2AKey` (`a2a-key.ts`). El cambio de producción en `a2a-key.ts` es CERO
  líneas. Los ~2199+ tests deben quedar verdes. AR bloquea cualquier toque al priority order
  sin AC explícito.
- **CD-2 — TESTNET ONLY.** PROHIBIDO hardcodear chain ID 2366 (mainnet Kite) o addresses de
  mainnet. Network desde `KITE_NETWORK`/`KITE_CHAIN_ID`.
- **CD-3 — OWNERSHIP GUARD en toda query a `a2a_agent_keys`.** `bindPassport` (W3) DEBE
  filtrar `.eq('id', keyId).eq('owner_ref', ownerId)` antes del `.select()`. Firma con
  `ownerId: string` (NO `string | undefined`). Sin `.eq('owner_ref', …)` = BLOQUEANTE (IDOR,
  criterio WKH-53). `ownerId` = `callerKey.owner_ref`.
- **CD-4 — `paymentOrigin` es TELEMETRÍA ONLY.** PROHIBIDO usar su valor como decisor de
  auth, bypass de budget, o input a cualquier decisión de autorización. Único consumidor
  legítimo: `requirePassport()` (opt-in env-gated) y event-tracking.
- **CD-5 — PROHIBIDO ethers.js.** Solo viem v2.
- **CD-6 — Sin secrets en código.** Keys, URLs de facilitator, addresses desde env vars.
  Incluye el smoke (`SMOKE_A2A_KEY`, target URL como env, sin defaults secretos).

### Nuevas (este SDD — derivadas de auto-blindaje histórico)

- **CD-7 — Mock COMPLETO de `adapters/registry.js` en todo test que ejercite
  `requirePayment`.** Antes de mergear W1, `grep -rn "vi.mock('.*adapters/registry" src/` y
  verificar que TODOS los mocks afectados exporten `getPaymentAdapter`, `getDefaultChainKey`,
  `getAdaptersBundle`, `getInitializedChainKeys`. Un mock incompleto devuelve `undefined`
  silencioso y dispara `REGISTRY_NOT_INITIALIZED` 500 / 400 en vez del 402/200 esperado.
  *Referencia: WKH-111 auto-blindaje#093 (2026-05-27) — 9 tests legacy rotos por esto; WKH-69
  auto-blindaje#084 (mismo archivo `x402.passport-shape.test.ts`).*
- **CD-8 — Fixture cross-rootDir: NO romper el build.** El nuevo
  `x402.dual-header.test.ts` (en `src/`) que importe el fixture de `../__tests__/fixtures/`
  o `test/fixtures/` puede disparar TS6059 (`tsc --noEmit` pelado) — es baseline conocido,
  NO regresión (`tsconfig.build.json` excluye `*.test.ts`). PROHIBIDO modificar
  `tsconfig.json` para "arreglarlo" (fuera de scope). Reusar el mismo import que
  `x402.passport-shape.test.ts` ya usa. *Referencia: WKH-69 auto-blindaje#084 / WKH-111#093.*
- **CD-9 — `npm run format` ≠ `npm run lint`; format opera sobre TODO `src/`.** Si se corre
  `biome format --write src/` en un repo con drift baseline, reformatea archivos fuera de
  Scope IN. PROHIBIDO commitear archivos fuera de Scope IN: usar `biome check --write <file>`
  scoped al archivo in-scope, o `git checkout --` de los archivos drift fuera de scope.
  *Referencia: WKH-AUDIT-A2A auto-blindaje#097 (2026-05-29) — 34 archivos reformateados de más.*
- **CD-10 — Preservar mensajes de error legacy del 402.** El alias NO debe cambiar los
  strings de error de `buildX402Response` (`Invalid payment-signature format: …`,
  `Payment verification failed: …`). Un caller x402 estándar consume el body
  `{error, accepts, x402Version}`, no el string — pero cambiar el string rompería tests y
  contratos de backward-compat sin AC que lo autorice.

---

## 10. Exemplars verificados (paths confirmados con Read)

| Exemplar | Path (verificado) | Uso |
|----------|-------------------|-----|
| Lectura header de pago + decode | `src/middleware/x402.ts:177-197` | Punto de inserción del alias (W1) |
| `decodeXPayment` shape | `src/middleware/x402.ts:87-110` | Contrato de decode (no cambia) |
| paymentOrigin set | `src/middleware/x402.ts:130-136` | AC-6 ya cubierto |
| Test harness x402 (mock registry + inject) | `src/middleware/x402.passport-shape.test.ts:19-114` | Clonar para `x402.dual-header.test.ts` (W1) |
| Fixtures de pago | `src/__tests__/fixtures/passport-shape.js` (`buildPassportPaymentHeader`/`buildEoaPaymentHeader`) | Headers de test (W1) — import idéntico al de passport-shape.test |
| payment_origin en a2a_events | `src/middleware/event-tracking.ts:74-79` | AC-7 cubierto (sin cambio) |
| Servicio ownership-guarded | `src/services/identity.ts:136-164` (`bindFundingWallet`) | Patrón para `bindPassport` (W3) |
| Ruta ownership-guarded | `src/routes/auth.ts:318-389` (`POST /funding-wallet`) | Patrón para `POST /auth/bind-passport` (W3) |
| Defense-in-depth ownership pre-check | `src/routes/auth.ts:422-425` (`/deposit`) | `body.keyId === callerKey.id` (W3) |
| Smoke runner + mock hook | `scripts/smoke-passport-autonomous.mjs:50-318` | Base de `smoke-e2e-dual-auth.mjs` (W2) |
| Test middleware a2a-key | `src/middleware/a2a-key.test.ts` (describe + mocks) | +1 caso coexistencia (W1, AC-2) |

> Nota: el fixture se importa en `x402.passport-shape.test.ts:50` como
> `'../__tests__/fixtures/passport-shape.js'`. F3 debe usar **el mismo specifier** para
> evitar el cross-rootDir gotcha (CD-8).

---

## 11. Readiness Check

| # | Ítem | Estado |
|---|------|--------|
| 1 | Header real del alias confirmado (`x-payment` lowercase, canónico x402) | ✅ §3.0 — validación end-to-end agendada en W2 (no bloqueante) |
| 2 | Punto de inserción exacto del alias identificado | ✅ `x402.ts:177` |
| 3 | `decodeXPayment` shape y flujo verify/settle entendidos (no cambian) | ✅ §3.1 |
| 4 | Priority order Agent Key NO se toca (CD-1) | ✅ §4.1 — 0 LOC en `a2a-key.ts` prod |
| 5 | AC-6 (paymentOrigin alias) sin trabajo extra | ✅ §4.3 |
| 6 | AC-7 (a2a_events) acotado — ya implementado, sin scope nuevo | ✅ §7 / DT-7 |
| 7 | Patrón de test AC-10 con mock registry COMPLETO | ✅ §6.1 + CD-7 |
| 8 | Caso coexistencia AC-2 especificado | ✅ §6.2 |
| 9 | Patrón ownership-guarded para `bindPassport` (W3) | ✅ §4.5 + exemplar `bindFundingWallet` |
| 10 | W3 marcada OPCIONAL/OMITIBLE | ✅ §5 |
| 11 | Smoke e2e: patrón base confirmado existente | ✅ `smoke-passport-autonomous.mjs` |
| 12 | Constraint Directives heredados + nuevos (auto-blindaje) | ✅ §9 (CD-1..10) |
| 13 | Exemplars con paths reales verificados (Read) | ✅ §10 |
| 14 | `[NEEDS CLARIFICATION]` pendientes | **Ninguno** — el único supuesto abierto (wire shape Passport) está agendado para W2 y es defendible por el estándar x402, no bloquea W1 |

**Veredicto: SDD listo para SPEC_APPROVED.** No hay TBDs bloqueantes. La única incógnita
(que el backend de Passport mande exactamente `X-PAYMENT`) está cubierta por el estándar
canónico x402 y su validación definitiva está agendada en W2; si difiere, el ajuste es la
constante `X_PAYMENT_HEADER` (one-liner) y se documenta en F4.
