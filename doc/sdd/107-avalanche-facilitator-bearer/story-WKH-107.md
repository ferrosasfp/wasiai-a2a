# Story File — [WKH-107] [AVAX-BEARER] — a2a manda `Authorization: Bearer` al facilitator en verify/settle Avalanche

> **Contrato autocontenido para el Dev (F3).** Si algo no está acá, no se hace.
> Seguí las waves en orden. No infieras nada: cada paso tiene archivo + ancla + qué escribir.
>
> **Fuente de verdad**: `doc/sdd/107-avalanche-facilitator-bearer/sdd.md` (SDD_MODE: mini).
> 🪞 **ESPEJO EXACTO de WKH-106 (BASE-02)**, ya mergeado, sobre el Avalanche adapter,
> con **3 deltas Avalanche** explícitos (ver §⚠️ DELTAS).

---

## 0. Encabezado

| Campo | Valor |
|---|---|
| HU | WKH-107 (AVAX-BEARER) |
| Tipo | ENABLEMENT / WIRING (NO build) — cambio quirúrgico de auth en 1 archivo de producción |
| Gates aprobados | **HU_APPROVED** ✅ + **SPEC_APPROVED** ✅ |
| Metodología | QUALITY — toca payment path (verify/settle) → AR + CR obligatorios |
| Branch sugerido | `feat/107-avalanche-facilitator-bearer` |
| Repos afectados | SOLO `wasiai-a2a`. `wasiai-facilitator` **NO se toca**. |

### Qué se construye y por qué (contexto compacto)

El Avalanche adapter de a2a (`src/adapters/avalanche/payment.ts`) POSTea a `/verify` y
`/settle` del facilitator mandando **solo** `Content-Type: application/json`. El
facilitator deployado (el MISMO que ya settlea Base y Avalanche — `eip155:43113` Fuji +
`eip155:43114` C-Chain, ambos breaker CLOSED) **exige** `Authorization: Bearer <key>`
(`requireFacilitatorKey`, timing-safe, obligatorio fuera de `NODE_ENV=test`). Hoy un
verify/settle real desde el adapter Avalanche da **HTTP 401**.

Esta HU: agrega el header bearer (key leída desde env con degradación segura) + documenta
la nueva env var en `.env.example`. NO mueve fondos, NO agrega chains, NO toca firmas de
interfaces. Resuelve el **TD-1 de WKH-106** ("Avalanche tiene el mismo gap").

### Archivos en SCOPE (exactos — no tocar nada fuera de esta lista)

| Archivo | Qué se toca |
|---|---|
| `src/adapters/avalanche/payment.ts` | helper nuevo `getFacilitatorApiKey()` + headers condicionales de 2 fetch (`verifyX402` + `settleX402`) |
| `.env.example` | documentar `AVALANCHE_FACILITATOR_API_KEY` (sección Avalanche facilitator) |
| `src/adapters/__tests__/avalanche.test.ts` | bloque nuevo de 8 tests (NO crear archivo nuevo) |

**Cualquier otro archivo está FUERA de scope.** En particular: `src/adapters/types.ts`,
`src/adapters/base/payment.ts`, `buildX402CanonicalBody`, el repo `wasiai-facilitator`.

---

## ⚠️ DELTAS vs WKH-106 (lo único que difiere del flujo de la HU gemela)

> **LEER ANTES DE EMPEZAR.** El resto es espejo 1:1 de WKH-106. Estos 3 puntos son la
> diferencia. Equivocarse acá es un bug.

1. **DELTA-1 [tipo de red]**: el tipo de red es `AvalancheNetwork = 'fuji' | 'mainnet'`
   (importado de `./chain.js`, l.16) — **NO** `'testnet' | 'mainnet'`. Los tests usan
   `network: 'eip155:43113'` (Fuji) y construyen el adapter con `{ network: 'fuji' }`.
2. **DELTA-2 [helper sin `network`]**: `getFacilitatorApiKey()` **NO toma `network`** —
   la misma key sirve para ambas redes, igual que `getFacilitatorUrl()` (l.143-149) tampoco
   toma `network`. El facilitator rutea por chain vía `accepted.network` del body; la auth
   es global al facilitator (DT-5).
3. **DELTA-3 [SIN caveat stale — NO tocar el header del archivo]**: a diferencia de WKH-106
   (que reescribió un caveat BASE-01 stale en su W1.4), el header/comentario del Avalanche
   adapter (**l.18-29**) **ya describe correctamente** el canonical x402 mode y NO contiene
   ninguna afirmación stale. **PROHIBIDO tocar el header del archivo (l.18-29).** No hay
   "W1.4 caveat" en esta HU. El equivalente de AC-7 acá es documentar la env var en
   `.env.example` (W1.4 doc, ver abajo). (DT-8.)

---

## 1. Constraint Directives — INVIOLABLES (CD-1..CD-12)

Si vas a violar uno → STOP. Cualquier violación es BLOQUEANTE en AR/CR.

### Heredados del work-item

- **CD-1**: PROHIBIDO hardcodear la API key. SOLO desde env. `.env.example` sin valor real.
- **CD-2**: PROHIBIDO loguear/serializar/incluir la key en errores, envelopes o cualquier salida observable.
- **CD-3**: PROHIBIDO Avalanche mainnet (43114) en esta HU. Strictly testnet (Fuji 43113).
- **CD-4**: el header solo se agrega si hay key no-vacía (degradación segura). Sin key → header omitido, fetch completa, tests existentes intactos. **PROHIBIDO `Bearer undefined` o `Bearer ` (vacío)**.
- **CD-5**: PROHIBIDO tocar el repo `wasiai-facilitator`.
- **CD-6**: PROHIBIDO tocar el Base adapter (`src/adapters/base/payment.ts`) — ya resuelto en WKH-106. Es referencia de patrón, **NO scope de edición**.
- **CD-7**: PROHIBIDO cambiar el envelope x402 (`buildX402CanonicalBody`), las interfaces de `types.ts`, ni las firmas públicas del adapter.
- **CD-8**: TypeScript strict — sin `any` explícito, sin `as unknown` en código nuevo.

### Nuevos del SDD (auto-blindaje histórico — anti-copia-ciega de tests)

- **CD-9 [anti-test-pollution — mockFetch queue]**: los tests nuevos usan el `mockFetch` global (`vi.stubGlobal`, l.31-32). Cada test nuevo DEBE setear su propio `mockFetch.mockResolvedValueOnce(...)` (patrón ya usado en todo `avalanche.test.ts`). **`vi.clearAllMocks()` del `beforeEach` NO limpia la cola de `mockResolvedValueOnce`** — si un test deja un once-value sin consumir, contamina al siguiente. Ref: WKH-104 auto-blindaje#2.
- **CD-10 [ausencia de env var — `delete` no `= undefined`]**: para el path SIN key usar `delete process.env.AVALANCHE_FACILITATOR_API_KEY` y `delete process.env.FACILITATOR_API_KEY`. **PROHIBIDO `process.env.X = undefined`** (coacciona a la string `"undefined"`, truthy → la key se trataría como definida y el header se mandaría). Ref: WKH-104 auto-blindaje#1.
- **CD-11 [biome `--write` antes de lint]**: correr `./node_modules/.bin/biome check --write` sobre los archivos tocados **ANTES** de `npm run lint` (que es `biome check`, solo verifica). Aplica organizeImports + format. Ref: WKH-102 auto-blindaje#2.
- **CD-12 [no key real en assert]**: los asserts del header presente comparan `Bearer <key>` con un **literal de prueba** conocido (`'test-facilitator-key'`, `'shared-key'`). PROHIBIDO cualquier key real. (CD-1/CD-2 también aplican a los tests.)

---

## 2. Anti-Hallucination Checklist (releer ANTES de escribir una línea)

El Dev DEBE abrir y releer con Read estos exemplars verificados (paths reales, confirmados en F2 — SDD §5):

- [ ] `src/adapters/avalanche/payment.ts:143-149` — `getFacilitatorUrl()` (patrón fallback module-level **sin `network`** a espejar para el helper de key).
- [ ] `src/adapters/avalanche/payment.ts:238-243` — fetch `/verify` actual (solo `Content-Type`).
- [ ] `src/adapters/avalanche/payment.ts:278-283` — fetch `/settle` actual (solo `Content-Type`).
- [ ] `src/adapters/avalanche/payment.ts:18-29` — header/comentario del archivo. **NO tocar (DELTA-3 / DT-8).**
- [ ] `src/adapters/base/payment.ts:173-179` — `getFacilitatorApiKey()` de Base (la solución exacta a espejar — referencia, NO scope).
- [ ] `src/adapters/base/payment.ts:269-281` — header `Authorization: Bearer` condicional en fetch `/verify` (Base, referencia).
- [ ] `src/adapters/base/payment.ts:314-326` — header `Authorization: Bearer` condicional en fetch `/settle` (Base, referencia).
- [ ] `src/adapters/__tests__/avalanche.test.ts:31-32` — `mockFetch` global (`vi.fn()` + `vi.stubGlobal('fetch', mockFetch)`).
- [ ] `src/adapters/__tests__/avalanche.test.ts:196-224` — patrón assert sobre `init` de `mockFetch.mock.calls[0]` (`const [url, init] = mockFetch.mock.calls[0]`).
- [ ] `src/adapters/__tests__/avalanche.test.ts:93-109` — `beforeEach`/`afterEach` del bloque "contract" (`vi.clearAllMocks()`, `delete process.env.X`, `OPERATOR_PRIVATE_KEY` fixture, `adapter = new AvalanchePaymentAdapter({ network: 'fuji' })`).
- [ ] `.env.example:176-186` — sección Avalanche facilitator (donde va la nueva var, tras `AVALANCHE_FACILITATOR_URL=`).
- [ ] `.env.example:534-539` — bloque `BASE_FACILITATOR_API_KEY` (formato de doc a espejar).

> ⚠️ Los números de línea son de la captura de F2 (verificados en vivo 2026-06-01, **sin drift**).
> Aun así, **localizá por ancla de código** (nombre de función / string del header), no por número de línea fijo.
> El paso W0 re-audita las anclas antes de escribir.

### PROHIBIDO (resumen operativo)

- ❌ Tocar el repo `wasiai-facilitator` (CD-5).
- ❌ Tocar el Base adapter `src/adapters/base/payment.ts` (CD-6 — es referencia, NO scope).
- ❌ Cambiar firmas de `verify(proof)` / `settle(req)` o interfaces de `types.ts` (CD-7).
- ❌ Cambiar `buildX402CanonicalBody` (l.203-224) / formato del envelope x402 (CD-7).
- ❌ **Tocar el header del archivo `payment.ts:18-29`** (DELTA-3 / DT-8 — Avalanche NO tiene caveat stale).
- ❌ Avalanche mainnet 43114 (CD-3).
- ❌ Hacer que el helper tome `network` (DELTA-2 / DT-5 — la key es global).
- ❌ Hardcodear o loguear la key (CD-1, CD-2).
- ❌ Mandar `Bearer undefined` / `Bearer ` (CD-4).
- ❌ `any` / `as unknown` en código nuevo (CD-8).

---

## 3. Waves

### W0 — Audit (serial, NO escribe producción)

Objetivo: confirmar que las anclas del gap no se movieron y que no hay colisión de nombre.

| Paso | Acción | Criterio |
|---|---|---|
| W0.1 | `Grep "getFacilitatorApiKey" src/adapters/avalanche/payment.ts` | **0 hits** → no hay colisión de nombre del helper |
| W0.2 | `Grep "function getFacilitatorUrl" src/adapters/avalanche/payment.ts` | 1 hit → confirmar que la cadena termina en `?? WASIAI_FACILITATOR_DEFAULT_URL` y **NO toma `network`** |
| W0.3 | `Grep "'Content-Type': 'application/json'" src/adapters/avalanche/payment.ts` | **2 hits** (verify l.~240 + settle l.~280), ambos sin `Authorization` |
| W0.4 | Leer header `src/adapters/avalanche/payment.ts:18-29` | confirma que **NO** contiene caveat stale → **nada que reescribir** (DELTA-3 / DT-8). Si por error hay algo stale, escalar — NO inventar reescritura. |

**Done de W0**: las 2 zonas de gap intactas (verify + settle) + helper inexistente + header sin caveat stale → proceder a W1. (No toca `src/`.)
Si alguna ancla cambió de forma significativa → STOP, escalar al orquestador.

---

### W1 — Implementación (serial, 1 archivo de producción + doc)

Orden estricto. Cada paso depende del anterior para el helper.

#### W1.1 — Helper `getFacilitatorApiKey()` (DT-1, DT-6 / AC-3, AC-6)

**Ancla**: insertar **inmediatamente después** del cierre de `getFacilitatorUrl()`
(que cierra en l.~149, justo antes de `function getWalletClient(...)`), espejando su
posición y estructura. Escribir **exactamente**:

```ts
function getFacilitatorApiKey(): string | undefined {
  return (
    process.env.AVALANCHE_FACILITATOR_API_KEY?.trim() ||
    process.env.FACILITATOR_API_KEY?.trim() ||
    undefined
  );
}
```

Notas:
- `?.trim() ||` colapsa string vacía / whitespace → `undefined` (degradación segura, CD-4 / DT-2).
- Tipo de retorno explícito `string | undefined` (CD-8, sin `any`).
- Precedencia: `AVALANCHE_FACILITATOR_API_KEY` gana sobre `FACILITATOR_API_KEY` (AC-3).
- **DELTA-2**: NO recibe `network` (igual que `getFacilitatorUrl`).

**Done**: helper presente, compila, retorna `undefined` cuando ambas vars ausentes/vacías.

#### W1.2 — `verifyX402`: headers condicionales (DT-7 / AC-1, AC-4)

**Ancla**: el fetch a `/verify` (l.~238-243) que hoy tiene
`headers: { 'Content-Type': 'application/json' },`.

Antes del `try`/del `fetch` (después de `const body = buildX402CanonicalBody(...)`), construir:

```ts
const apiKey = getFacilitatorApiKey();
const headers: Record<string, string> = { 'Content-Type': 'application/json' };
if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
```

Y en el fetch, usar `headers,` (shorthand) en vez del objeto literal:

```ts
response = await fetch(`${facilitatorUrl}/verify`, {
  method: 'POST',
  headers,
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
});
```

Notas:
- Tipado explícito `Record<string, string>` (CD-8). Cuando no hay key, la clave `Authorization` **ni existe** (verificable con `.toBeUndefined()`).
- `body` y `signal` NO cambian. `buildX402CanonicalBody` NO se toca (CD-7).

**Done**: con key → header presente; sin key → clave ausente; fetch sin throw.

#### W1.3 — `settleX402`: headers condicionales (DT-7 / AC-2, AC-4)

**Ancla**: el fetch a `/settle` (l.~278-283), mismo string `headers: { 'Content-Type': 'application/json' },`.

Idéntico patrón a W1.2: mismo bloque `const apiKey / headers / if (apiKey)` antes del fetch
(después de `const body = buildX402CanonicalBody(...)`), y `headers,` shorthand en el fetch a `/settle`.

**Done**: igual que W1.2 sobre el call de `/settle`.

#### W1.4 — `.env.example`: documentar `AVALANCHE_FACILITATOR_API_KEY` (AC-7)

> 🪞 Equivalente del W1.5 de WKH-106. **Reemplaza** al "W1.4 caveat" de WKH-106
> (que acá NO existe — DELTA-3).

**Ancla**: sección "Avalanche facilitator override (optional)" (l.176-186),
**inmediatamente después** de la línea `AVALANCHE_FACILITATOR_URL=` (l.186).
Agregar la var **sin valor real** (espejo del bloque Base `.env.example:534-539`):

```
# Bearer auth para el facilitator de Avalanche (WKH-107 / AVAX-BEARER).
# El facilitator exige Authorization: Bearer <key> en /verify y /settle.
# Fallback: AVALANCHE_FACILITATOR_API_KEY -> FACILITATOR_API_KEY (la primera definida gana).
# Sin esta var, el adapter omite el header (OK en tests / NODE_ENV=test).
# NUNCA commitear el valor real. NUNCA en logs.
AVALANCHE_FACILITATOR_API_KEY=
```

**Done**: var documentada, sin valor real, con nota de fallback + "NUNCA en logs".

> **RECORDATORIO DELTA-3**: NO se toca el header del archivo `payment.ts:18-29`.
> No hay caveat stale en Avalanche (DT-8). Si te encontrás editando ese header → STOP, es error.

**Done de W1**: 1 archivo de producción (`payment.ts`) + `.env.example` modificados;
`npx tsc --noEmit` sin errores de tipo. Header del archivo intacto.

---

### W2 — Tests (serial respecto a W1; ≥1 test por AC)

Agregar a `src/adapters/__tests__/avalanche.test.ts` un bloque nuevo
`describe('Avalanche payment adapter — facilitator bearer auth (AVAX-BEARER)', ...)`.
**NO crear archivo nuevo.** Reusar `mockFetch` global (l.31-32) + `AvalanchePaymentAdapter`
+ el fixture `OPERATOR_PRIVATE_KEY` ya importados/usados.

`beforeEach` / `afterEach` del bloque (CD-9, CD-10) — espejo del bloque "contract" (l.93-109)
+ delete de ambas key vars:

```ts
beforeEach(() => {
  _resetWalletClient();
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete process.env.AVALANCHE_FACILITATOR_API_KEY;
  delete process.env.FACILITATOR_API_KEY;
  process.env.OPERATOR_PRIVATE_KEY =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  adapter = new AvalanchePaymentAdapter({ network: 'fuji' });
});
afterEach(() => {
  delete process.env.AVALANCHE_FACILITATOR_API_KEY;
  delete process.env.FACILITATOR_API_KEY;
  delete process.env.OPERATOR_PRIVATE_KEY;
  delete process.env.AVALANCHE_FACILITATOR_URL;
  delete process.env.WASIAI_FACILITATOR_URL;
});
```

Patrón de assert (espejo de `avalanche.test.ts:215-217`): extraer
`const [url, init] = mockFetch.mock.calls[0]` y assertar sobre `(init as { headers: Record<string, string> }).headers`.
Cada test setea su propio `mockFetch.mockResolvedValueOnce(...)` (CD-9). Cada test que
necesita key la setea con literal de prueba (CD-12). El input de `verify`/`settle` usa
`network: 'eip155:43113'` (Fuji, DELTA-1).

Los 8 tests → ver §4 mapa AC→test.

**Done de W2**:
- Los 8 tests nuevos verdes.
- Los tests existentes de verify/settle/URL-fallback (l.~195-352) **siguen verdes sin tocarlos**
  (no-regresión de AC-4: esos tests no setean key → el header se omite, fetch completa igual).

---

## 4. Mapa AC → Test (los 8 tests que F3 debe dejar verdes — SDD §6)

| Test | Cubre | Setup | Assert clave |
|---|---|---|---|
| **T-AC1** verify con `AVALANCHE_FACILITATOR_API_KEY` → bearer en `/verify` | AC-1, AC-3, AC-6 | `process.env.AVALANCHE_FACILITATOR_API_KEY = 'test-facilitator-key'`; `mockResolvedValueOnce({ ok:true, status:200, json:()=>({verified:true}) })` | `url` match `/\/verify$/`; `init.headers.Authorization === 'Bearer test-facilitator-key'` **y** `init.headers['Content-Type'] === 'application/json'` |
| **T-AC2** settle con `AVALANCHE_FACILITATOR_API_KEY` → bearer en `/settle` | AC-2, AC-3, AC-6 | idem (mock `settled:true, transactionHash:'0x...'`) | idem sobre el call de `/settle` (`url` match `/\/settle$/`) |
| **T-AC3a** fallback: solo `FACILITATOR_API_KEY` seteada | AC-3 | `process.env.FACILITATOR_API_KEY = 'shared-key'` | `init.headers.Authorization === 'Bearer shared-key'` |
| **T-AC3b** precedencia: ambas seteadas → gana `AVALANCHE_*` | AC-3 | ambas (`AVALANCHE_FACILITATOR_API_KEY='avax-key'` + `FACILITATOR_API_KEY='shared-key'`) | `Authorization === 'Bearer avax-key'` (no la shared) |
| **T-AC4** sin key → header ausente, fetch completa (verify **y** settle) | AC-4, DT-2 | ninguna var (delete en beforeEach) | `expect(init.headers.Authorization).toBeUndefined()`; `verify()`/`settle()` resuelven sin throw |
| **T-AC4-empty** key = string vacía/whitespace → header omitido | AC-4, DT-2 | `process.env.AVALANCHE_FACILITATOR_API_KEY = '   '` | `Authorization` ausente (**no** `Bearer ` ni `Bearer    `) |
| **T-AC5** la key NO aparece en body ni en `result.error` (path 5xx) | AC-5, CD-2 | key seteada + mock 500 con `result.error` | `JSON.parse(init.body)` no contiene la key; en path error (500) `result.error` no la incluye |
| **T-AC7** `.env.example` documenta `AVALANCHE_FACILITATOR_API_KEY` | AC-7 | `readFileSync` del `.env.example` | `expect(src).toContain('AVALANCHE_FACILITATOR_API_KEY')` **y** `.toContain('FACILITATOR_API_KEY')` **y** `.toMatch(/logs/i)` |

> **Delta de tests vs WKH-106**: se quita el T-AC7 de WKH-106 (caveat stale — no aplica, DELTA-3/DT-8)
> y se reemplaza por **T-AC7 doc** (`.env.example`). El resto (T-AC1, T-AC2, T-AC3a, T-AC3b, T-AC4,
> T-AC4-empty, T-AC5) es espejo 1:1.
> Para T-AC7: leer el source con `readFileSync` (assert documental sobre string, OK para este caso).

---

## 5. Patrones a seguir (referencia exemplars verificados §5 SDD)

- **Resolución env con fallback (helper module-level, SIN `network`)** → espejar `getFacilitatorUrl()` (`src/adapters/avalanche/payment.ts:143-149`).
- **`getFacilitatorApiKey()` (solución exacta a espejar)** → `src/adapters/base/payment.ts:173-179` (referencia, NO scope — CD-6).
- **Header `Authorization: Bearer` condicional en fetch** → `src/adapters/base/payment.ts:269-281` (verify) y `:314-326` (settle).
- **mockFetch + assert `init`** → `src/adapters/__tests__/avalanche.test.ts:196-224`.
- **`delete process.env.X` + fixture en `beforeEach`/`afterEach`** → `src/adapters/__tests__/avalanche.test.ts:93-109`.
- **Doc de env var de key en `.env.example`** → `.env.example:534-539` (`BASE_FACILITATOR_API_KEY`).

No inventar APIs nuevas. Todo el patrón ya existe en el codebase (Base lo estableció en WKH-106).

---

## 6. Done Definition (la HU está lista para AR cuando)

- [ ] W0 audit confirmó las 2 zonas de gap (verify+settle) + helper inexistente + header sin caveat stale.
- [ ] `getFacilitatorApiKey()` agregado tras `getFacilitatorUrl()`, **sin `network`** (W1.1 / DELTA-2).
- [ ] `verifyX402` y `settleX402` construyen headers condicionales `Record<string, string>` (W1.2, W1.3).
- [ ] `.env.example` documenta `AVALANCHE_FACILITATOR_API_KEY` sin valor real, con fallback + "NUNCA en logs" (W1.4).
- [ ] **Header del archivo `payment.ts:18-29` INTACTO** — no se tocó (DELTA-3 / DT-8).
- [ ] 8 tests nuevos verdes (T-AC1, T-AC2, T-AC3a, T-AC3b, T-AC4, T-AC4-empty, T-AC5, T-AC7).
- [ ] Tests existentes verdes (no-regresión — los de l.~195-352 que no setean key).
- [ ] Sin `any`/`as unknown` en código nuevo (CD-8). Sin hardcode/log de la key (CD-1/CD-2). Sin mainnet 43114 (CD-3). Sin `Bearer undefined`/vacío (CD-4). `wasiai-facilitator`, Base adapter, `types.ts`, `buildX402CanonicalBody` intactos (CD-5/CD-6/CD-7).

---

## 7. Comando de verificación final

Orden obligatorio (CD-11: biome `--write` ANTES del lint):

```bash
# 1. Formato + autofix (CD-11) sobre los archivos tocados
./node_modules/.bin/biome check --write \
  src/adapters/avalanche/payment.ts \
  src/adapters/__tests__/avalanche.test.ts

# 2. Lint del proyecto
npm run lint

# 3. Tests del archivo (los 8 nuevos + no-regresión)
npx vitest run src/adapters/__tests__/avalanche.test.ts

# 4. Tipos (sin emitir)
npx tsc --noEmit
```

Verde en los 4 pasos → listo para AR.
