# Story File — [WKH-106] [BASE-02] — a2a manda `Authorization: Bearer` al facilitator en verify/settle Base

> **Contrato autocontenido para el Dev (F3).** Si algo no está acá, no se hace.
> Seguí las waves en orden. No infieras nada: cada paso tiene archivo + ancla + qué escribir.
>
> **Fuente de verdad**: `doc/sdd/106-base-facilitator-settlement/sdd.md` (SDD_MODE: mini).

---

## 0. Encabezado

| Campo | Valor |
|---|---|
| HU | WKH-106 (BASE-02) |
| Tipo | ENABLEMENT / WIRING (NO build) — cambio quirúrgico de auth en 1 archivo de producción |
| Gates aprobados | **HU_APPROVED** ✅ + **SPEC_APPROVED** ✅ (clinical review, modo AUTO) |
| Metodología | QUALITY — toca payment path (verify/settle) → AR + CR obligatorios |
| Branch sugerido | `feat/106-base-facilitator-settlement` |
| Repos afectados | SOLO `wasiai-a2a`. `wasiai-facilitator` **NO se toca**. |

### Qué se construye y por qué (contexto compacto)

El Base adapter de a2a (`src/adapters/base/payment.ts`) POSTea a `/verify` y `/settle`
del facilitator mandando **solo** `Content-Type: application/json`. El facilitator
deployado **exige** `Authorization: Bearer <key>` (`requireFacilitatorKey`, timing-safe,
obligatorio fuera de `NODE_ENV=test`). Hoy un verify/settle real da **HTTP 401**.

Esta HU: agrega el header bearer (key leída desde env con degradación segura), reescribe
el caveat BASE-01 stale, y documenta la nueva env var. NO mueve fondos, NO agrega chains,
NO toca firmas de interfaces.

### Archivos en SCOPE (exactos — no tocar nada fuera de esta lista)

| Archivo | Qué se toca |
|---|---|
| `src/adapters/base/payment.ts` | helper nuevo + headers de 2 fetch + caveat reescrito |
| `.env.example` | documentar `BASE_FACILITATOR_API_KEY` (sección Base) |
| `src/adapters/__tests__/base.test.ts` | bloque nuevo de 8 tests (NO crear archivo nuevo) |

**Cualquier otro archivo está FUERA de scope.** En particular: `src/adapters/types.ts`,
`src/adapters/avalanche/payment.ts`, `buildX402CanonicalBody`, el repo `wasiai-facilitator`.

---

## 1. Constraint Directives — INVIOLABLES (CD-1..CD-11)

Si vas a violar uno → STOP. Cualquier violación es BLOQUEANTE en AR/CR.

### Heredados del work-item

- **CD-1**: PROHIBIDO hardcodear la API key. SOLO desde env. `.env.example` sin valor real.
- **CD-2**: PROHIBIDO loguear/serializar/incluir la key en errores, envelopes o cualquier salida observable.
- **CD-3**: PROHIBIDO Base mainnet (8453) en esta HU. Strictly testnet (84532).
- **CD-4**: el header solo se agrega si hay key (degradación segura). Sin key → header omitido, fetch completa, tests existentes intactos. **PROHIBIDO `Bearer undefined` o `Bearer ` (vacío)**.
- **CD-5**: PROHIBIDO tocar el repo `wasiai-facilitator`.
- **CD-6**: PROHIBIDO cambiar `buildX402CanonicalBody` ni las interfaces de `types.ts`.
- **CD-7**: TypeScript strict — sin `any` explícito, sin `as unknown` en código nuevo.

### Nuevos del SDD

- **CD-8 [anti-test-pollution]**: tests nuevos usan el `mockFetch` global. PROHIBIDO depender de la cola de `mockResolvedValueOnce` heredada de otro test → `mockFetch.mockReset()` + `mockResolvedValueOnce` propio al inicio del bloque. (`vi.clearAllMocks()` NO limpia la cola — WKH-104 auto-blindaje#2.)
- **CD-9 [ausencia de env var]**: para el path SIN key usar `delete process.env.BASE_FACILITATOR_API_KEY` y `delete process.env.FACILITATOR_API_KEY`. PROHIBIDO `process.env.X = undefined` (coacciona a string `"undefined"`, truthy → la key se trataría como definida — WKH-104 auto-blindaje#1).
- **CD-10 [biome]**: correr `./node_modules/.bin/biome check --write` sobre los archivos tocados ANTES de `npm run lint` (WKH-102 auto-blindaje#2).
- **CD-11 [no key real en assert]**: los asserts del header presente usan un literal de prueba (`'test-facilitator-key'`, `'shared-key'`). PROHIBIDO cualquier key real.

---

## 2. Anti-Hallucination Checklist (releer ANTES de escribir una línea)

El Dev DEBE abrir y releer con Read estos exemplars verificados (paths reales, confirmados en F2):

- [ ] `src/adapters/base/payment.ts:163-170` — `getFacilitatorUrl()` (patrón fallback `??` a espejar para el helper de key).
- [ ] `src/adapters/base/payment.ts:262-267` — fetch `/verify` actual (solo `Content-Type`).
- [ ] `src/adapters/base/payment.ts:302-307` — fetch `/settle` actual (solo `Content-Type`).
- [ ] `src/adapters/base/payment.ts:27-34` — caveat BASE-01 stale a reescribir.
- [ ] `src/services/compose.ts:44` — patrón ya existente `headers.Authorization = \`Bearer ${...}\``.
- [ ] `src/services/compose.test.ts:163` — assert header bearer **presente** (`expect(callHeaders.Authorization).toBe('Bearer test-token')`).
- [ ] `src/services/compose.test.ts:278` — assert header bearer **ausente** (`expect(callHeaders.Authorization).toBeUndefined()`).
- [ ] `src/adapters/__tests__/base.test.ts:32-33` — `mockFetch` global (`vi.fn()` + `vi.stubGlobal('fetch', mockFetch)`).
- [ ] `src/adapters/__tests__/base.test.ts:280-289` — patrón assert sobre `init` de `mockFetch.mock.calls[0]`.
- [ ] `src/adapters/__tests__/base.test.ts:48-51, 130-135` — `delete process.env.X` para desetear.

> ⚠️ Los números de línea son de la captura de F2. **Las líneas pueden haberse corrido.**
> Localizá por ancla de código (nombre de función / string del header), no por número de línea fijo.
> El paso W0 re-audita las anclas antes de escribir.

### PROHIBIDO (resumen operativo)

- ❌ Tocar el repo `wasiai-facilitator` (CD-5).
- ❌ Cambiar firmas de `verify(proof)` / `settle(req)` o interfaces de `types.ts` (CD-4 SDD / CD-6).
- ❌ Cambiar `buildX402CanonicalBody` / formato del envelope x402 (CD-6).
- ❌ Tocar `src/adapters/avalanche/payment.ts` (es TD-1, fuera de scope).
- ❌ Base mainnet 8453 (CD-3).
- ❌ Hardcodear o loguear la key (CD-1, CD-2).
- ❌ Mandar `Bearer undefined` / `Bearer ` (CD-4).
- ❌ `any` / `as unknown` en código nuevo (CD-7).

---

## 3. Waves

### W0 — Audit (serial, NO escribe producción)

Objetivo: confirmar que las anclas del gap no se movieron y que no hay colisión de nombre.

| Paso | Acción | Criterio |
|---|---|---|
| W0.1 | `Grep "getFacilitatorApiKey" src/adapters/base/payment.ts` | **0 hits** → no hay colisión de nombre del helper |
| W0.2 | `Grep "function getFacilitatorUrl" src/adapters/base/payment.ts` | 1 hit → confirmar que termina con la cadena `?? WASIAI_FACILITATOR_DEFAULT_URL` |
| W0.3 | `Grep "'Content-Type': 'application/json'" src/adapters/base/payment.ts` | **2 hits** (verify + settle), ambos sin `Authorization` |
| W0.4 | `Grep "NO soporta Base RPC" src/adapters/base/payment.ts` | 1 hit en el caveat (l.~27-34) → confirma que el stale sigue ahí |

**Done de W0**: las 4 zonas intactas + helper no existe → proceder a W1. (No toca `src/`.)
Si alguna ancla cambió de forma significativa → STOP, escalar al orquestador.

---

### W1 — Implementación (serial, 1 archivo de producción + doc)

Orden estricto. Cada paso depende del anterior para tipos/helper.

#### W1.1 — Helper `getFacilitatorApiKey()` (DT-1, DT-6 / AC-3, AC-6)

Insertar **inmediatamente después** de `getFacilitatorUrl()` (cierra en l.~170),
espejando su estructura. Escribir exactamente:

```ts
function getFacilitatorApiKey(): string | undefined {
  return (
    process.env.BASE_FACILITATOR_API_KEY?.trim() ||
    process.env.FACILITATOR_API_KEY?.trim() ||
    undefined
  );
}
```

Notas:
- `?.trim() ||` colapsa string vacía / whitespace → `undefined` (degradación segura, CD-4 / DT-6).
- Tipo de retorno explícito `string | undefined` (CD-7, sin `any`).
- Precedencia: `BASE_FACILITATOR_API_KEY` gana sobre `FACILITATOR_API_KEY` (AC-3).

**Done**: helper presente, compila, retorna `undefined` cuando ambas vars ausentes/vacías.

#### W1.2 — `verifyX402`: headers condicionales (DT-7 / AC-1, AC-4)

En el fetch a `/verify` (l.~262-267), reemplazar la línea
`headers: { 'Content-Type': 'application/json' },` por construcción previa del objeto:

Antes del `try`/del `fetch`, construir:

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
- Tipado explícito `Record<string, string>` (CD-7). Cuando no hay key, la clave `Authorization` **ni existe** (verificable con `.toBeUndefined()`).
- `body` y `signal` NO cambian. `buildX402CanonicalBody` NO se toca (CD-6).

**Done**: con key → header presente; sin key → clave ausente; fetch sin throw.

#### W1.3 — `settleX402`: headers condicionales (DT-7 / AC-2, AC-4)

Idéntico patrón en el fetch a `/settle` (l.~302-307). Mismo bloque `const apiKey / headers / if (apiKey)` antes del fetch, y `headers,` shorthand en el fetch.

**Done**: igual que W1.2 sobre el call de `/settle`.

#### W1.4 — Caveat reescrito (DT-5 / AC-7)

Reemplazar el bloque l.~27-34 (las líneas del comentario que arrancan en `IMPORTANTE — BASE-01 caveat (DT-11):` hasta la línea `(Sepolia="USDC", Mainnet="USD Coin"). Ver w0-audit.md.` inclusive) por:

```
 * BASE-02 (WKH-106): el facilitator deployado settlea Base Sepolia real
 * (EIP-3009 transferWithAuthorization vía viem) y EXIGE autenticación
 * `Authorization: Bearer <key>` en /verify y /settle (requireFacilitatorKey,
 * timing-safe, obligatorio fuera de NODE_ENV=test). Este adapter manda ese
 * header cuando hay una API key configurada por env (BASE_FACILITATOR_API_KEY
 * → FACILITATOR_API_KEY); sin key, omite el header (degradación segura para
 * tests / entornos sin auth). Los tests mockean `fetch`. Smoke real: BASE-04.
 *
 * EIP-712 domain `name` difiere por network (Sepolia="USDC", Mainnet="USD Coin").
```

Verificar que el source resultante **ya NO contiene**: `NO soporta Base RPC`, `DT-11`,
ni `4xx … esperada`.

**Done**: caveat reescrito, sin referencias stale.

#### W1.5 — `.env.example`: documentar `BASE_FACILITATOR_API_KEY` (AC-6 doc)

En la sección Base (junto a `BASE_FACILITATOR_URL`, l.~527), agregar la var **sin valor real**:

```
# Bearer auth para el facilitator de Base (WKH-106 / BASE-02).
# El facilitator exige Authorization: Bearer <key> en /verify y /settle.
# Fallback: BASE_FACILITATOR_API_KEY -> FACILITATOR_API_KEY (la primera definida gana).
# Sin esta var, el adapter omite el header (OK en tests / NODE_ENV=test).
# NUNCA commitear el valor real. NUNCA en logs.
BASE_FACILITATOR_API_KEY=
```

**Done**: var documentada, sin valor real, con nota de fallback + "NUNCA en logs".

**Done de W1**: 1 archivo de producción + `.env.example` modificados; `npx tsc --noEmit` (o build) sin errores de tipo.

---

### W2 — Tests (serial respecto a W1; ≥1 test por AC)

Agregar a `src/adapters/__tests__/base.test.ts` un bloque nuevo
`describe('Base payment adapter — facilitator bearer auth (BASE-02)', ...)`.
**NO crear archivo nuevo.** Reusar `mockFetch` + `BasePaymentAdapter` ya importados.

`beforeEach` del bloque (CD-8, CD-9):

```ts
beforeEach(() => {
  mockFetch.mockReset();
  delete process.env.BASE_FACILITATOR_API_KEY;
  delete process.env.FACILITATOR_API_KEY;
});
afterEach(() => {
  delete process.env.BASE_FACILITATOR_API_KEY;
  delete process.env.FACILITATOR_API_KEY;
});
```

Patrón de assert (espejo de `compose.test.ts:163/278` y `base.test.ts:280`):
extraer `const [url, init] = mockFetch.mock.calls[0]` y assertar sobre `init.headers`.

Los 8 tests (ver §4 mapa AC→test). Cada test que necesita key la setea con literal de prueba (CD-11).

**Done de W2**:
- Los 8 tests nuevos verdes.
- Los tests existentes de URL fallback (l.~372-448) y verify/settle (l.~260-370) **siguen verdes sin tocarlos** (no-regresión de AC-4: sin key → header omitido).

---

## 4. Mapa AC → Test (los 8 tests que F3 debe dejar verdes)

| Test | Cubre | Setup | Assert clave |
|---|---|---|---|
| **T-AC1** verify con `BASE_FACILITATOR_API_KEY` → bearer | AC-1, AC-3, AC-6 | `process.env.BASE_FACILITATOR_API_KEY = 'test-facilitator-key'` | `init.headers.Authorization === 'Bearer test-facilitator-key'` **y** `init.headers['Content-Type'] === 'application/json'` |
| **T-AC2** settle con `BASE_FACILITATOR_API_KEY` → bearer | AC-2, AC-3, AC-6 | idem | idem sobre el call de `/settle` |
| **T-AC3a** fallback: solo `FACILITATOR_API_KEY` | AC-3 | `process.env.FACILITATOR_API_KEY = 'shared-key'` | `init.headers.Authorization === 'Bearer shared-key'` |
| **T-AC3b** precedencia: ambas seteadas → gana `BASE_*` | AC-3 | ambas seteadas (`'base-key'` + `'shared-key'`) | `Authorization === 'Bearer base-key'` (no la shared) |
| **T-AC4** sin key → header ausente, fetch completa (verify y settle) | AC-4 | ninguna var (delete en beforeEach) | `expect(init.headers.Authorization).toBeUndefined()`; `verify()`/`settle()` resuelven sin throw |
| **T-AC4-empty** key = string vacía → header omitido | AC-4, DT-6 | `process.env.BASE_FACILITATOR_API_KEY = ''` | `Authorization` ausente (no `Bearer `) |
| **T-AC5** la key NO aparece en body ni en error | AC-5, CD-2 | key seteada + mock 500 con `result.error` | `JSON.parse(init.body)` no contiene la key; en path de error el `result.error` no la incluye |
| **T-AC7** source ya no tiene caveat stale | AC-7 | leer el source del adapter | `expect(src).not.toContain('NO soporta Base RPC')` **y** `not.toContain('DT-11')` |

> Para T-AC7: leer el source con `readFileSync` del path del adapter (assert documental sobre string, OK para este caso).

---

## 5. Patrones a seguir (referencia exemplars verificados §5 SDD)

- **Resolución env con fallback `??`** → espejar `getFacilitatorUrl()` (`src/adapters/base/payment.ts:163-170`).
- **Header `Authorization: Bearer` condicional** → ya existe en `src/services/compose.ts:44`.
- **Assert header presente** → `src/services/compose.test.ts:163`.
- **Assert header ausente** → `src/services/compose.test.ts:278`.
- **mockFetch + assert `init`** → `src/adapters/__tests__/base.test.ts:280-289`.
- **`delete process.env.X`** → `src/adapters/__tests__/base.test.ts:48-51, 130-135`.

No inventar APIs nuevas. Todo el patrón ya existe en el codebase.

---

## 6. Done Definition (la HU está lista para AR cuando)

- [ ] W0 audit confirmó las 4 anclas + helper inexistente.
- [ ] `getFacilitatorApiKey()` agregado tras `getFacilitatorUrl()` (W1.1).
- [ ] `verifyX402` y `settleX402` construyen headers condicionales (W1.2, W1.3).
- [ ] Caveat BASE-01 reescrito, sin `NO soporta Base RPC` / `DT-11` (W1.4).
- [ ] `.env.example` documenta `BASE_FACILITATOR_API_KEY` sin valor real (W1.5).
- [ ] 8 tests nuevos verdes (T-AC1..T-AC7).
- [ ] Tests existentes verdes (no-regresión).
- [ ] Sin `any`/`as unknown` en código nuevo (CD-7). Sin hardcode/log de la key (CD-1/CD-2). Sin mainnet 8453 (CD-3). Sin `Bearer undefined` (CD-4). `wasiai-facilitator`, `types.ts`, `buildX402CanonicalBody`, `avalanche/payment.ts` intactos.

---

## 7. Comando de verificación final

Orden obligatorio (CD-10: biome `--write` ANTES del lint):

```bash
# 1. Formato + autofix (CD-10) sobre los archivos tocados
./node_modules/.bin/biome check --write \
  src/adapters/base/payment.ts \
  src/adapters/__tests__/base.test.ts

# 2. Lint del proyecto
npm run lint

# 3. Tipos (sin emitir)
npx tsc --noEmit

# 4. Tests del archivo (los 8 nuevos + no-regresión)
npm test -- src/adapters/__tests__/base.test.ts
```

Verde en los 4 pasos → listo para AR.
