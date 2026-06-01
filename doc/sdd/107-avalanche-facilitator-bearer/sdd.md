# SDD — [WKH-107] [AVAX-BEARER] — a2a manda `Authorization: Bearer` al facilitator en verify/settle Avalanche

> **SDD_MODE: mini** — cambio quirúrgico de wiring de auth en 1 archivo de
> producción (`src/adapters/avalanche/payment.ts`) + `.env.example` + tests.
> **NO es un build.** 🪞 **ESPEJO EXACTO de WKH-106 (BASE-02)**, ya mergeado, sobre
> el Avalanche adapter. El facilitator deployado es el MISMO que settlea Base y ya
> settlea Avalanche (`eip155:43113` Fuji + `eip155:43114` C-Chain, ambos breaker
> CLOSED) — el único gap real es que el cliente Avalanche no se autentica → hoy un
> `/verify` o `/settle` real daría **HTTP 401**.
>
> Gate previo: **HU_APPROVED** ✅ (clinical review, modo AUTO).

---

## 1. Context Map — archivos leídos y patrones extraídos

| Archivo (verificado con Read/Glob, 2026-06-01) | Por qué se leyó | Qué se extrajo |
|---|---|---|
| `src/adapters/avalanche/payment.ts` | **SUT principal** — el gap real | `getFacilitatorUrl()` l.143-149 (fallback `AVALANCHE_FACILITATOR_URL ?? WASIAI_FACILITATOR_URL ?? default`, **NO toma `network`**); `getFacilitatorApiKey()` **NO existe** aún (sin colisión de nombre); `verifyX402` fetch l.238-243 (solo `headers: { 'Content-Type': 'application/json' }`); `settleX402` fetch l.278-283 (idem); `buildX402CanonicalBody` l.203-224 (NO se toca); tipo `AvalancheNetwork` importado de `./chain.js` l.16 = **`'fuji' \| 'mainnet'`** (NO `'testnet'`). Helpers son funciones libres module-level (no métodos). |
| `src/adapters/base/payment.ts:164-179` | **Solución a espejar** (WKH-106, mergeada — referencia, NO scope) | `getFacilitatorApiKey()` l.173-179: `process.env.BASE_FACILITATOR_API_KEY?.trim() \|\| process.env.FACILITATOR_API_KEY?.trim() \|\| undefined`, colocado **inmediatamente después de `getFacilitatorUrl()`** (l.164-171). En `verifyX402` (l.269-273) y `settleX402` (l.314-318): `const apiKey = getFacilitatorApiKey(); const headers: Record<string, string> = { 'Content-Type': 'application/json' }; if (apiKey) headers.Authorization = ` + "`Bearer ${apiKey}`" + `; ` luego `fetch(url, { method:'POST', headers, body, signal })`. Idéntico shape al avalanche fetch. |
| `src/adapters/__tests__/avalanche.test.ts` | Cómo testear el cambio | `mockFetch = vi.fn(); vi.stubGlobal('fetch', mockFetch)` (l.31-32). Cada test setea su propio `mockFetch.mockResolvedValueOnce({ ok, status, json })` (l.196, 227, 251, 279, 309, 333). `beforeEach` usa `vi.clearAllMocks()` + `delete process.env.X` (l.44-51, 93-102). `afterEach` borra `AVALANCHE_FACILITATOR_URL`/`WASIAI_FACILITATOR_URL`/`OPERATOR_PRIVATE_KEY` (l.104-109). Patrón de assert de `init`: `const [url, init] = mockFetch.mock.calls[0]` (l.215-217) — ya asserta `init.method` y `JSON.parse(init.body)`. **NO hay todavía assert sobre `init.headers`** → patrón nuevo, espejado de `base.test.ts` + `compose.test.ts`. |
| `.env.example` l.176-186 | Dónde documentar la var | Sección "Avalanche facilitator override (optional)" documenta `AVALANCHE_FACILITATOR_URL` (l.186) con resolución 1/2/3. La nueva `AVALANCHE_FACILITATOR_API_KEY` va **inmediatamente después de `AVALANCHE_FACILITATOR_URL=` (tras l.186)**, espejando el bloque de `BASE_FACILITATOR_API_KEY` (`.env.example` l.534-539). |
| `.env.example` l.534-539 | Formato del doc a espejar | Bloque `BASE_FACILITATOR_API_KEY`: 4 líneas de comentario (qué exige el facilitator + cadena de fallback + "Sin esta var omite el header" + "NUNCA commitear / NUNCA en logs") + var sin valor. |
| `doc/sdd/106-base-facilitator-settlement/sdd.md` | Plantilla del SDD (HU mergeada) | DT-1..DT-7, CD-1..CD-11, 8 tests. Diferencias delta: AC-7 de WKH-106 = caveat stale (NO aplica acá); AC-7 de ESTA HU = doc `.env.example`. |
| `doc/sdd/_INDEX.md` | Auto-blindaje histórico | Últimas DONE: WKH-106 (sin auto-blindaje, HU limpia), WKH-104, WKH-103, WKH-102. |
| Auto-blindajes WKH-104 (#1, #2) + WKH-102 (#2) | Prevenir repetición de bugs de test | 3 patrones recurrentes → CD-8/CD-9/CD-10 (mockFetch queue, `delete` vs `= undefined`, biome `--write`). WKH-106 NO tiene auto-blindaje (HU sin errores). |

### Confirmación del nombre de la env var (resolución de Missing Input #1 / DT-1)

`grep "AVALANCHE_FACILITATOR_API_KEY"` en `src/` y `.env.example` → **no existe
hoy** (sin colisión). El facilitator server-side usa `FACILITATOR_API_KEY`. Base
ya estableció el patrón `<CHAIN>_FACILITATOR_API_KEY → FACILITATOR_API_KEY`
(`BASE_FACILITATOR_API_KEY`). El Avalanche adapter ya usa el prefijo
`AVALANCHE_` para su override de URL (`AVALANCHE_FACILITATOR_URL`). →
**DT-1 confirma `AVALANCHE_FACILITATOR_API_KEY → FACILITATOR_API_KEY`.**

---

## 2. Decisiones técnicas (DT-N)

Heredadas del work-item (DT-1..DT-5) + confirmaciones/adiciones de F2 (DT-6, DT-7).

- **DT-1 [CONFIRMADO — nombre canónico de la env var]**: la key se resuelve desde
  env con la cadena **`AVALANCHE_FACILITATOR_API_KEY` → `FACILITATOR_API_KEY`**,
  tomando la primera definida y no-vacía
  (`process.env.AVALANCHE_FACILITATOR_API_KEY?.trim() || process.env.FACILITATOR_API_KEY?.trim() || undefined`).
  - **Justificación**: (a) **espeja exactamente** el patrón ya mergeado de Base
    (`getFacilitatorApiKey()` `base/payment.ts:173-179`). (b) `FACILITATOR_API_KEY`
    es **el mismo nombre que usa el facilitator server-side**, de modo que un
    operador puede setear una sola var compartida y que cliente y server hablen la
    misma key. (c) El prefijo `AVALANCHE_` respeta el naming del propio adapter
    (`AVALANCHE_FACILITATOR_URL`, `AVALANCHE_USDC_ADDRESS`, etc.).

- **DT-2 [degradación segura]**: si `getFacilitatorApiKey()` devuelve `undefined`
  (ninguna var definida o string vacía/whitespace), se **omite** la clave
  `Authorization` del objeto `headers`. PROHIBIDO mandar `Bearer undefined` o
  `Bearer ` (vacío). El `.trim() || undefined` colapsa el whitespace. Razón: los
  tests existentes (`avalanche.test.ts` no setea key) y `NODE_ENV=test` no setean
  key; el facilitator hace bypass de auth en test. Romper esto quebraría la suite.

- **DT-3 [transport-level]**: el header NO entra al envelope x402.
  `buildX402CanonicalBody` (l.203-224) **no cambia**.

- **DT-4 [sin cambio de firmas]**: `verify(proof)` / `settle(req)` (l.353-359) y las
  interfaces de `types.ts` (`SettleRequest`/`VerifyResult`/`X402Proof`) **no
  cambian**. La key se lee del proceso (env), como `getFacilitatorUrl()`. Es config
  de despliegue, no dato de request. (Idéntico a DT-4 de WKH-106.)

- **DT-5 [tipo de red — DIFERENCIA con Base]**: el tipo de red es
  `AvalancheNetwork = 'fuji' | 'mainnet'` (NO `'testnet' | 'mainnet'`). **El helper
  de key NO toma `network`** — la misma key sirve para ambas redes, igual que
  `getFacilitatorUrl()` (l.143-149) tampoco toma `network`. Razón: el facilitator
  rutea por chain internamente vía `accepted.network` del body; la auth es **global
  al facilitator**.

- **DT-6 [NUEVO — helper espejo]**: se agrega un helper
  `getFacilitatorApiKey(): string | undefined` colocado **inmediatamente después de
  `getFacilitatorUrl()`** (tras l.149), espejando su posición y estructura en el
  archivo Avalanche. Devuelve `undefined` cuando ninguna var está definida o el
  valor es string vacía (`?.trim() || undefined`). Razón: una sola fuente de verdad
  para la resolución de la key, reutilizada por `verifyX402` y `settleX402` (DRY).

- **DT-7 [NUEVO — construcción del objeto headers]**: cada fetch construye el objeto
  headers tipado, con `Authorization` agregado condicionalmente para que la clave ni
  siquiera exista cuando no hay key:
  ```ts
  const apiKey = getFacilitatorApiKey();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  ```
  Razón: tipado explícito `Record<string, string>` (sin `any`, CD-8), y la ausencia
  de la clave es verificable en test con `expect(init.headers.Authorization).toBeUndefined()`.

- **DT-8 [SIN caveat stale — DIFERENCIA con Base]**: a diferencia de WKH-106 (que
  reescribió un caveat stale BASE-01 en l.27-34 — su DT-5/AC-7), el header del
  Avalanche adapter (l.18-29) **ya describe correctamente** el canonical x402 mode y
  no contiene ninguna afirmación stale. **NO se toca el header del archivo.** El
  equivalente de AC-7 de ESTA HU es documentar la env var en `.env.example`.

---

## 3. Constraint Directives (CD-N)

### Heredados del work-item (INVIOLABLES)

- **CD-1**: PROHIBIDO hardcodear la API key. SOLO desde env. `.env.example` sin valor real.
- **CD-2**: PROHIBIDO loguear/serializar/incluir la key en errores, envelopes o cualquier salida observable.
- **CD-3**: PROHIBIDO Avalanche mainnet (43114) en esta HU. Strictly testnet (Fuji 43113).
- **CD-4**: el header solo se agrega si hay key no-vacía (degradación segura). Sin key → header omitido, fetch completa, tests existentes intactos. PROHIBIDO `Bearer undefined`/vacío.
- **CD-5**: PROHIBIDO tocar el repo `wasiai-facilitator`.
- **CD-6**: PROHIBIDO tocar el Base adapter (`src/adapters/base/payment.ts`) — ya resuelto en WKH-106. Es referencia de patrón, NO scope de edición.
- **CD-7**: PROHIBIDO cambiar el envelope x402 (`buildX402CanonicalBody`), las interfaces de `types.ts`, ni las firmas públicas del adapter.
- **CD-8**: TypeScript strict — sin `any` explícito, sin `as unknown` en código nuevo.

### Nuevos del SDD (auto-blindaje histórico — anti-copia-ciega de tests)

- **CD-9 [Anti-test-pollution — mockFetch queue]**: los tests nuevos usan el
  `mockFetch` global (`vi.stubGlobal`). Cada test nuevo DEBE setear su propio
  `mockFetch.mockResolvedValueOnce(...)` (patrón ya usado en todo `avalanche.test.ts`)
  y NO depender de una cola heredada. `vi.clearAllMocks()` del `beforeEach` **NO
  limpia la cola de `mockResolvedValueOnce`** — si un test deja un once-value sin
  consumir, contamina al siguiente. Referencia: WKH-104 auto-blindaje#2.

- **CD-10 [Ausencia de env var — `delete` no `= undefined`]**: para testear el path
  SIN key (AC-4), usar `delete process.env.AVALANCHE_FACILITATOR_API_KEY` y
  `delete process.env.FACILITATOR_API_KEY` en `beforeEach`/`afterEach`. PROHIBIDO
  `process.env.X = undefined` (coacciona a la string `"undefined"`, truthy → la key
  se trataría como definida y el header se mandaría). Referencia: WKH-104
  auto-blindaje#1.

- **CD-11 [Biome `--write` antes de lint]**: correr
  `./node_modules/.bin/biome check --write` sobre los archivos tocados ANTES de
  `npm run lint` (que es `biome check`, solo verifica). Aplica organizeImports +
  format. Referencia: WKH-102 auto-blindaje#2.

- **CD-12 [key literal de prueba en asserts]**: los asserts que verifican la
  PRESENCIA del header comparan `Bearer <key>` con una **key literal de prueba**
  conocida (ej. `'test-facilitator-key'`, `'shared-key'`). PROHIBIDO incluir
  cualquier key real. (CD-1/CD-2 también aplican a los tests.)

---

## 4. Waves de implementación

### W0 — Audit (serial, sin escribir producción)
- Confirmar que las líneas del gap no se movieron desde la captura del work-item:
  `getFacilitatorUrl()` l.143-149, `verifyX402` headers l.238-243, `settleX402`
  headers l.278-283, `buildX402CanonicalBody` l.203-224.
- Confirmar que `getFacilitatorApiKey` **NO existe** ya en el archivo (evitar
  colisión de nombre).
- Confirmar que el header del archivo (l.18-29) NO contiene caveat stale (DT-8 → no
  hay nada que reescribir).
- Output: nota de 3-5 líneas en el commit de W0 (no toca `src/`).
- **Salida esperada**: las 3 zonas de gap intactas + helper ausente → proceder a W1.

### W1 — Implementación (serial, 1 archivo de producción + doc)
Orden estricto (cada paso depende del anterior para el helper):
1. **Helper** `getFacilitatorApiKey()` inmediatamente tras `getFacilitatorUrl()`
   (tras l.149) — DT-1, DT-6. Cadena `AVALANCHE_FACILITATOR_API_KEY?.trim() || FACILITATOR_API_KEY?.trim() || undefined`.
2. **`verifyX402`** (l.238-243): construir `headers` condicional antes del `fetch` — DT-7, AC-1.
3. **`settleX402`** (l.278-283): idem — DT-7, AC-2.
4. **`.env.example`**: documentar `AVALANCHE_FACILITATOR_API_KEY` inmediatamente tras
   `AVALANCHE_FACILITATOR_URL=` (l.186), espejando el bloque Base l.534-539 — AC-7.

> **NO** se toca el header del archivo (l.18-29) — DT-8, sin caveat stale (delta vs WKH-106).

### W2 — Tests (serial respecto a W1; ≥1 test por AC)
- Agregar a `src/adapters/__tests__/avalanche.test.ts` un nuevo `describe`
  (ej. `'Avalanche payment adapter — facilitator bearer auth (AVAX-BEARER)'`).
  NO crear archivo nuevo; reusar `mockFetch` global + `AvalanchePaymentAdapter`
  + `OPERATOR_PRIVATE_KEY` fixture ya importados.
- `beforeEach`/`afterEach` del nuevo bloque: `delete` de ambas env vars de key
  (`AVALANCHE_FACILITATOR_API_KEY`, `FACILITATOR_API_KEY`) — CD-10 — + `vi.clearAllMocks()`.
- Cada test setea su propio `mockFetch.mockResolvedValueOnce(...)` — CD-9.
- Ver test plan §6.

> No hay paralelismo: 1 archivo de producción + tests del mismo archivo → todo serial.

---

## 5. Exemplars verificados (paths reales)

| Patrón a seguir | Exemplar (path:línea verificado en esta sesión) |
|---|---|
| Resolución env con fallback (helper module-level, sin `network`) | `src/adapters/avalanche/payment.ts:143-149` (`getFacilitatorUrl`) |
| `getFacilitatorApiKey()` (la solución exacta a espejar) | `src/adapters/base/payment.ts:173-179` |
| Header `Authorization: Bearer` condicional en fetch `/verify` | `src/adapters/base/payment.ts:269-281` |
| Header `Authorization: Bearer` condicional en fetch `/settle` | `src/adapters/base/payment.ts:314-326` |
| fetch a `/verify` (avalanche, donde va el cambio) | `src/adapters/avalanche/payment.ts:238-243` |
| fetch a `/settle` (avalanche, donde va el cambio) | `src/adapters/avalanche/payment.ts:278-283` |
| mockFetch global + assert de `init` (avalanche) | `src/adapters/__tests__/avalanche.test.ts:31-32, 196-224` |
| `delete process.env.X` para desetear (avalanche) | `src/adapters/__tests__/avalanche.test.ts:48-51, 97-109` |
| Doc de env var de key en `.env.example` (formato a espejar) | `.env.example:534-539` (`BASE_FACILITATOR_API_KEY`) |
| Sección Avalanche donde va la nueva var | `.env.example:176-186` (`AVALANCHE_FACILITATOR_URL`) |

Todos los paths confirmados con Read en esta sesión. El patrón `headers.Authorization
= ` + "`Bearer ${apiKey}`" + ` + assert presente/ausente ya existe en Base — se
replica exactamente, no se inventa nada.

---

## 6. Plan de tests (≥1 test por AC — 8 tests, espejo de WKH-106 menos caveat + doc-var)

Archivo: `src/adapters/__tests__/avalanche.test.ts` (bloque nuevo
`describe('Avalanche payment adapter — facilitator bearer auth (AVAX-BEARER)')`).
`beforeEach`: `_resetWalletClient(); vi.clearAllMocks(); vi.spyOn(console,'warn')...;
delete process.env.AVALANCHE_FACILITATOR_API_KEY; delete process.env.FACILITATOR_API_KEY;
process.env.OPERATOR_PRIVATE_KEY = '<fixture>'; adapter = new AvalanchePaymentAdapter({ network: 'fuji' });`
`afterEach`: `delete` de ambas key vars + `OPERATOR_PRIVATE_KEY` + URL vars (CD-10).

| Test | Cubre AC | Assert clave |
|---|---|---|
| **T-AC1**: verify con `AVALANCHE_FACILITATOR_API_KEY` seteada → manda bearer en `/verify` | AC-1, AC-3, AC-6 | `init.headers.Authorization === 'Bearer test-facilitator-key'` Y `init.headers['Content-Type'] === 'application/json'` (url match `/verify$`) |
| **T-AC2**: settle con `AVALANCHE_FACILITATOR_API_KEY` seteada → manda bearer en `/settle` | AC-2, AC-3, AC-6 | idem sobre el call de `/settle` |
| **T-AC3a**: fallback — solo `FACILITATOR_API_KEY` seteada → bearer usa esa key | AC-3 | `init.headers.Authorization === 'Bearer shared-key'` |
| **T-AC3b**: precedencia — ambas seteadas → gana `AVALANCHE_FACILITATOR_API_KEY` | AC-3 | bearer === la de `AVALANCHE_*`, NO la shared |
| **T-AC4**: sin ninguna key → header `Authorization` ausente y fetch completa sin throw (verify Y settle) | AC-4, DT-2 | `expect(init.headers.Authorization).toBeUndefined()`; `verify()`/`settle()` resuelven OK con mock |
| **T-AC4-empty**: `AVALANCHE_FACILITATOR_API_KEY=''` (whitespace) → header omitido (no `Bearer `) | AC-4, DT-2 | `Authorization` ausente con key = `'   '` |
| **T-AC5**: la key NO aparece en el body serializado ni en el `result.error` del path 5xx | AC-5, CD-2 | `JSON.parse(init.body)` no contiene la key; en path error (500) `result.error` no incluye la key |
| **T-AC7**: `.env.example` documenta `AVALANCHE_FACILITATOR_API_KEY` con la cadena de fallback y la nota "NUNCA en logs" | AC-7 | leer `.env.example` y `expect(src).toContain('AVALANCHE_FACILITATOR_API_KEY')` + `toContain('FACILITATOR_API_KEY')` + `toMatch(/logs/i)` (assert documental sobre el archivo) |

**Delta de tests vs WKH-106 (8 tests):** se quita T-AC7 de WKH-106 (caveat stale
removido — no aplica, DT-8) y se reemplaza por **T-AC7 doc** (`.env.example`). El
resto (T-AC1, T-AC2, T-AC3a, T-AC3b, T-AC4, T-AC4-empty, T-AC5) es espejo 1:1.

> Nota: los tests existentes de verify/settle/URL-fallback (`avalanche.test.ts`
> l.195-352) **deben seguir pasando sin cambios** — validación de no-regresión de
> AC-4 (esos tests no setean key → el header se omite, fetch completa igual).

---

## 7. Tech Debt detectado (FUERA de scope — NO se arregla acá)

- **TD-1 [Kite no aplica]**: `kite-ozone/payment.ts` usa modo Pieverse / firma
  on-chain distinta; no comparte el patrón fetch-a-facilitator con bearer. No es el
  mismo gap. (Confirmado ya en WKH-106 §8 TD-2.)
- **TD-2 [smoke E2E real Avalanche]**: el valor real de la key en prod (Railway) +
  un smoke `/verify`+`/settle` real contra el facilitator deployado en Fuji es
  **ops del humano**, no bloquea el merge ni los unit tests (mockean fetch).
  Equivalente al BASE-04 de la línea Base.

---

## 8. Readiness Check

| Ítem | Estado |
|---|---|
| Work-item leído completo (7 AC, 9 CD, 5 DT, grounding) | ✅ |
| Plantilla WKH-106 (sdd) leída + deltas identificados | ✅ (sin caveat, AC-7 = doc-var, tipo `'fuji'`) |
| Stack confirmado (Fastify/TS strict/viem/vitest) — sin drift | ✅ |
| SUT verificado con Read — líneas del gap confirmadas | ✅ l.143-149, 238-243, 278-283, 203-224 |
| `getFacilitatorApiKey` NO existe aún (sin colisión) | ✅ |
| Tipo de red = `'fuji' \| 'mainnet'` (NO `'testnet'`), helper NO toma `network` | ✅ DT-5 |
| Avalanche NO tiene caveat stale (no hay AC de remover caveat) | ✅ DT-8 |
| Exemplars verificados con Read (paths reales) | ✅ §5 |
| Missing input #1 (nombre env var) resuelto | ✅ DT-1: `AVALANCHE_FACILITATOR_API_KEY → FACILITATOR_API_KEY` |
| Missing input #2 (valor real key en prod) | ⏳ ops/Railway — NO bloquea merge ni unit tests (TD-2) |
| Interfaces `types.ts` + `buildX402CanonicalBody` NO cambian | ✅ CD-7 |
| ≥1 test por AC planificado | ✅ 8 tests cubren AC-1..AC-7 |
| CDs del work-item heredados | ✅ CD-1..CD-8 + nuevos CD-9..CD-12 |
| Auto-blindaje histórico aplicado | ✅ WKH-104 (#1,#2), WKH-102 (#2) → CD-9/10/11 |
| Avalanche mainnet excluido | ✅ CD-3 |
| Sin `[NEEDS CLARIFICATION]` bloqueante | ✅ (el único pendiente es ops) |

**Veredicto: LISTO PARA SPEC_APPROVED.** No hay TBDs bloqueantes. El cambio es
quirúrgico (1 helper nuevo + 2 fetch headers + 1 doc var), espejo exacto de WKH-106
con los 3 deltas Avalanche respetados (tipo `'fuji'`, helper sin `network`, sin
caveat stale). Todos los exemplars y líneas verificados; el único pendiente (valor
real de la key) es ops y no afecta el merge ni los unit tests.
