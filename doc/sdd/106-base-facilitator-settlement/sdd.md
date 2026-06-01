# SDD — [WKH-106] [BASE-02] — a2a manda `Authorization: Bearer` al facilitator en verify/settle Base

> **SDD_MODE: mini** — cambio quirúrgico de wiring de auth en 1 archivo de
> producción (`src/adapters/base/payment.ts`) + `.env.example` + tests.
> **NO es un build.** El facilitator ya está completo, auditado y settleando
> Base Sepolia real. Este SDD wirea el header bearer que falta del lado cliente.
>
> Gate previo: **HU_APPROVED** ✅ (clinical review, modo AUTO).

---

## 1. Context Map — archivos leídos y patrones extraídos

| Archivo (verificado con Read/Glob, 2026-05-31) | Por qué se leyó | Qué se extrajo |
|---|---|---|
| `src/adapters/base/payment.ts` | SUT principal — el gap real | Caveat stale l.27-34; `getFacilitatorUrl()` l.163-170 (patrón fallback `??`); `verifyX402` fetch l.262-267 (solo `Content-Type`); `settleX402` fetch l.302-307 (idem). Confirmado: el header es transport-level, el body lo arma `buildX402CanonicalBody` l.227-248 (NO se toca). |
| `src/adapters/__tests__/base.test.ts` | Cómo testear el cambio | `mockFetch = vi.fn(); vi.stubGlobal('fetch', mockFetch)` (l.32-33). Patrón de assert de headers: `const [url, init] = mockFetch.mock.calls[0]` (l.280); ya asserta `init.method` y `init.body`. `beforeEach` usa `delete process.env.X` para desetear (l.48-51, l.122-124). `afterEach` borra las 3 vars de facilitator URL (l.130-135). NO hay todavía assert sobre `init.headers`. |
| `src/adapters/types.ts` | Confirmar que las interfaces NO cambian | `SettleRequest` l.11-15, `VerifyResult` l.26-29, `X402Proof` l.21-25, `PaymentAdapter.verify/settle` l.82-83 — **ninguna lleva la key**. CD-6 confirmado: el header es transport-level, no del request shape. |
| `src/adapters/avalanche/payment.ts` | Missing input #2 — ¿mismo gap? | **SÍ tiene el mismo gap.** `verifyX402` l.238-243 y `settleX402` l.278-283 mandan solo `headers: { 'Content-Type': 'application/json' }`. `getFacilitatorUrl()` l.144-148 con fallback `AVALANCHE_FACILITATOR_URL ?? WASIAI_FACILITATOR_URL ?? default`. → **TD-1** (fuera de scope, ver §7). |
| `.env.example` (l.524-559) | Dónde documentar la var | Sección Base ya documenta `BASE_FACILITATOR_URL` (l.527-532), `CDP_FACILITATOR_URL` (l.534-555), `CDP_API_KEY` (l.557-559, ya advierte "NO ponerlo en logs"). La nueva var va junto a `BASE_FACILITATOR_URL`. |
| `doc/sdd/_INDEX.md` | Auto-blindaje histórico | Últimas DONE: WKH-104/103/102/101 — patrones de error de test recurrentes (ver §8 / CD-8..CD-10). |
| Auto-blindajes WKH-104/103/102/101 | Prevenir repetición de bugs | 3 patrones recurrentes incorporados a CDs (mockFetch global, `delete` vs `= undefined`, biome `--write`). |

### Convención de naming del facilitator (resolución del missing input)

Grep `FACILITATOR_API_KEY` en `src/` → **no existe ninguna var de key de
facilitator del lado cliente hoy.** El facilitator server-side usa
`FACILITATOR_API_KEY` (per work-item grounding, `wasiai-facilitator/src/middleware/auth.ts:21-45`).
No hay convención previa que contradiga la propuesta del work-item. → DT-1 confirma.

---

## 2. Decisiones técnicas (DT-N)

Heredadas del work-item (DT-1..DT-5) + confirmaciones de F2.

- **DT-1 [CONFIRMADO — nombre canónico de la env var]**: la key se resuelve
  desde env con la cadena **`BASE_FACILITATOR_API_KEY` → `FACILITATOR_API_KEY`**,
  tomando la primera definida (`process.env.BASE_FACILITATOR_API_KEY ?? process.env.FACILITATOR_API_KEY`).
  - **Justificación**: (a) **espeja exactamente** el patrón ya establecido de
    `getFacilitatorUrl()` (l.163-170) — un override por-Base + un fallback shared.
    (b) `FACILITATOR_API_KEY` es **el mismo nombre que usa el facilitator
    server-side** (auth.ts:21-45), de modo que un operador puede setear una sola
    var compartida y que cliente y server hablen la misma key. (c) `BASE_`
    prefijo respeta el naming de todas las vars Base existentes
    (`BASE_FACILITATOR_URL`, `BASE_SEPOLIA_USDC_ADDRESS`, etc.). No se usa
    `CDP_API_KEY` (l.559) porque ése es un placeholder reservado para Paymaster/OnchainKit,
    semánticamente distinto del bearer del facilitator.

- **DT-2 [degradación segura]**: si `getFacilitatorApiKey()` devuelve
  `undefined` (ninguna var definida o string vacía), se **omite** la clave
  `Authorization` del objeto `headers`. PROHIBIDO mandar `Bearer undefined` o
  `Bearer ` (vacío). Razón: los tests existentes y `NODE_ENV=test` no setean
  key; el facilitator hace bypass de auth en test.

- **DT-3 [transport-level]**: el header NO entra al envelope x402.
  `buildX402CanonicalBody` (l.227-248) **no cambia**.

- **DT-4 [sin cambio de firmas]**: `verify(proof)` / `settle(req)` y las
  interfaces de `types.ts` **no cambian**. La key se lee del proceso (env),
  como `getFacilitatorUrl()`. Es config de despliegue, no dato de request.

- **DT-5 [caveat reescrito, no solo borrado]**: el bloque l.27-34 se reescribe
  para registrar que (a) el facilitator settlea Base Sepolia real, (b) exige
  bearer auth, (c) BASE-02 cerró el gap. Se quita la referencia a "DT-11" y a
  "CDP no soporta Base RPC". Wording en §6.

- **DT-6 [NUEVO — helper espejo]**: se agrega un helper
  `getFacilitatorApiKey(): string | undefined` colocado **inmediatamente
  después de `getFacilitatorUrl()`** (l.170), espejando su estructura. Devuelve
  `undefined` cuando ninguna var está definida o cuando el valor es string vacía
  (`?.trim() || undefined`). Razón: una sola fuente de verdad para la resolución
  de la key, reutilizada por `verifyX402` y `settleX402` (DRY, evita duplicar la
  cadena de fallback en 2 sitios).

- **DT-7 [NUEVO — construcción del objeto headers]**: cada fetch construye el
  objeto headers con spread condicional para que la clave `Authorization` ni
  siquiera exista cuando no hay key:
  ```ts
  const apiKey = getFacilitatorApiKey();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  ```
  Razón: tipado explícito `Record<string, string>` (sin `any`, CD-7), y la
  ausencia de la clave es verificable en test con `expect(headers.Authorization).toBeUndefined()`.

---

## 3. Constraint Directives (CD-N)

### Heredados del work-item (INVIOLABLES)

- **CD-1**: PROHIBIDO hardcodear la API key. SOLO desde env. `.env.example` sin valor real.
- **CD-2**: PROHIBIDO loguear/serializar/incluir la key en errores, envelopes o cualquier salida observable.
- **CD-3**: PROHIBIDO Base mainnet (8453) en esta HU. Strictly testnet (84532).
- **CD-4**: el header solo se agrega si hay key (degradación segura). Sin key → header omitido, fetch completa, tests existentes intactos. PROHIBIDO `Bearer undefined`/vacío.
- **CD-5**: PROHIBIDO tocar el repo `wasiai-facilitator`.
- **CD-6**: PROHIBIDO cambiar `buildX402CanonicalBody` ni las interfaces de `types.ts`.
- **CD-7**: TypeScript strict — sin `any` explícito, sin `as unknown` en código nuevo.

### Nuevos del SDD

- **CD-8 [Anti-test-pollution — mockFetch global]**: los tests nuevos usan el
  `mockFetch` global con `vi.stubGlobal`. PROHIBIDO depender de la cola de
  `mockResolvedValueOnce` heredada de otro test — usar `mockFetch.mockReset()` +
  `mockResolvedValueOnce` propio al inicio de cada test nuevo, o un valor
  persistente. Referencia: WKH-104 auto-blindaje#2 ("`vi.clearAllMocks()` NO
  limpia la cola de `mockResolvedValueOnce`").

- **CD-9 [Ausencia de env var]**: para testear el path SIN key (AC-4), usar
  `delete process.env.BASE_FACILITATOR_API_KEY` y `delete process.env.FACILITATOR_API_KEY`
  en el `beforeEach`/`afterEach`. PROHIBIDO `process.env.X = undefined` (coacciona
  a la string `"undefined"`, truthy → la key se trataría como definida).
  Referencia: WKH-104 auto-blindaje#1.

- **CD-10 [Biome]**: correr `./node_modules/.bin/biome check --write` sobre los
  archivos tocados ANTES de `npm run lint`. Referencia: WKH-102 auto-blindaje#2.

- **CD-11 [no key en assert]**: los asserts de test que verifican la PRESENCIA
  del header pueden comparar el valor `Bearer <key>` con una key de prueba
  conocida, pero PROHIBIDO incluir cualquier key real. Usar literal de test
  (ej. `'test-facilitator-key'`).

---

## 4. Waves de implementación

### W0 — Audit (serial, sin escribir producción)
- Confirmar que las líneas del gap no se movieron desde la captura del work-item
  (`verifyX402` headers, `settleX402` headers, caveat header, `getFacilitatorUrl`).
- Confirmar que `getFacilitatorApiKey` no existe ya (evitar colisión de nombre).
- Output: nota de 3-5 líneas en el Story File / commit de W0 (no toca `src/`).
- **Salida esperada**: las 4 zonas intactas → proceder a W1.

### W1 — Implementación (serial, 1 archivo de producción + doc)
Orden estricto (cada paso depende del anterior para tipos/helper):
1. **Helper** `getFacilitatorApiKey()` tras `getFacilitatorUrl()` (l.170) — DT-1, DT-6.
2. **`verifyX402`** (l.262-267): construir headers condicionales — DT-7, AC-1.
3. **`settleX402`** (l.302-307): idem — DT-7, AC-2.
4. **Caveat** (l.27-34): reescribir — DT-5, AC-7. Quitar referencia a DT-11.
5. **`.env.example`**: documentar `BASE_FACILITATOR_API_KEY` + nota de fallback + "NUNCA en logs" — AC-6 (doc).

### W2 — Tests (serial respecto a W1; ≥1 test por AC)
- Agregar a `src/adapters/__tests__/base.test.ts` (NO crear archivo nuevo;
  reusar el `mockFetch` + `BasePaymentAdapter` ya importados).
- `beforeEach`/`afterEach` del nuevo bloque: `delete` de ambas env vars (CD-9).
- Ver test plan §7.

> No hay paralelismo: 1 archivo de producción + tests del mismo archivo → todo serial.

---

## 5. Exemplars verificados (paths reales)

| Patrón a seguir | Exemplar (path:línea verificado) |
|---|---|
| Resolución env con fallback `??` | `src/adapters/base/payment.ts:163-170` (`getFacilitatorUrl`) |
| fetch a `/verify` con headers + timeout | `src/adapters/base/payment.ts:262-267` |
| fetch a `/settle` con headers + timeout | `src/adapters/base/payment.ts:302-307` |
| Construcción de header `Authorization: Bearer ` condicional en un fetch | `src/services/compose.ts:44` (`headers.Authorization = \`Bearer ${registry.auth.value}\``) — mismo patrón, ya en el codebase |
| Assert de header bearer presente en test | `src/services/compose.test.ts:163` (`expect(callHeaders.Authorization).toBe('Bearer test-token')`) |
| Assert de header bearer AUSENTE en test | `src/services/compose.test.ts:278` (`expect(callHeaders.Authorization).toBeUndefined()`) |
| mockFetch + assert de `init` | `src/adapters/__tests__/base.test.ts:280-289` |
| `delete process.env.X` para desetear | `src/adapters/__tests__/base.test.ts:48-51, 130-135` |

Todos los paths confirmados con Read en esta sesión. El patrón de
`headers.Authorization = \`Bearer ${...}\`` + assert presente/ausente ya existe
en `compose.ts`/`compose.test.ts` — se replica exactamente, no se inventa nada.

---

## 6. Wording del caveat reescrito (DT-5 / AC-7)

Reemplaza el bloque actual l.27-34. Propuesta (el Dev la transcribe; ajustable
en F2.5 sin cambiar el sentido):

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

Se elimina: la afirmación "el facilitator … NO soporta Base RPC en esta fase",
la referencia "(DT-11)", y "una respuesta 4xx del facilitator es esperada".

---

## 7. Plan de tests (≥1 test por AC)

Archivo: `src/adapters/__tests__/base.test.ts` (bloque nuevo, ej.
`describe('Base payment adapter — facilitator bearer auth (BASE-02)')`).
`beforeEach`: `delete process.env.BASE_FACILITATOR_API_KEY; delete process.env.FACILITATOR_API_KEY;` + `mockFetch.mockReset()` (CD-8/CD-9).

| Test | Cubre | Assert clave |
|---|---|---|
| **T-AC1**: verify con `BASE_FACILITATOR_API_KEY` seteada manda bearer | AC-1, AC-3, AC-6 | `init.headers.Authorization === 'Bearer test-facilitator-key'` y `init.headers['Content-Type'] === 'application/json'` |
| **T-AC2**: settle con `BASE_FACILITATOR_API_KEY` seteada manda bearer | AC-2, AC-3, AC-6 | idem sobre el call de `/settle` |
| **T-AC3a**: fallback — solo `FACILITATOR_API_KEY` seteada → bearer usa esa key | AC-3 | `init.headers.Authorization === 'Bearer shared-key'` |
| **T-AC3b**: precedencia — ambas seteadas → gana `BASE_FACILITATOR_API_KEY` | AC-3 | bearer === la de `BASE_*`, no la shared |
| **T-AC4**: sin ninguna key → header `Authorization` ausente y fetch completa sin throw (verify y settle) | AC-4 | `expect(init.headers.Authorization).toBeUndefined()`; `verify()`/`settle()` resuelven OK con mock |
| **T-AC4-empty**: key = string vacía → header omitido (no `Bearer `) | AC-4, DT-6 | `Authorization` ausente con `BASE_FACILITATOR_API_KEY=''` |
| **T-AC5**: la key NO aparece en el body serializado ni en mensajes de error | AC-5, CD-2 | `JSON.parse(init.body)` no contiene la key; en path de error (500) el `result.error` no incluye la key |
| **T-AC7**: el source del adapter ya no contiene el caveat stale | AC-7 | leer el source y `expect(src).not.toContain('NO soporta Base RPC')` y `not.toContain('DT-11')` (assert sobre source string, OK para este caso documental) |

> Nota: los tests de URL fallback existentes (l.372-448) y verify/settle
> existentes (l.260-370) deben **seguir pasando sin cambios** — validación de
> no-regresión de AC-4 (sin key seteada en esos tests, el header se omite).

---

## 8. Tech Debt detectado (FUERA de scope — NO se arregla acá)

- **TD-1 [Avalanche tiene el MISMO gap de bearer]**: `src/adapters/avalanche/payment.ts`
  manda solo `'Content-Type': 'application/json'` en `verifyX402` (l.238-243) y
  `settleX402` (l.278-283), sin `Authorization: Bearer`. Su `getFacilitatorUrl()`
  (l.144-148) usa fallback `AVALANCHE_FACILITATOR_URL ?? WASIAI_FACILITATOR_URL`.
  Si el facilitator de Avalanche exige bearer, un settle real daría 401 igual que
  Base. **Recomendación**: abrir HU aparte (ej. `AVAX-BEARER`) espejando este SDD
  con var `AVALANCHE_FACILITATOR_API_KEY → FACILITATOR_API_KEY`. **Scope OUT por
  work-item §Scope OUT / Missing Inputs #2.** NO se toca en WKH-106.

- **TD-2 [Kite no aplica]**: `kite-ozone/payment.ts` usa modo Pieverse / firma
  on-chain distinta; no comparte el patrón fetch-a-facilitator. No es el mismo gap.

---

## 9. Readiness Check

| Ítem | Estado |
|---|---|
| Work-item leído completo (7 AC, 7 CD, 5 DT, grounding) | ✅ |
| Stack confirmado (Fastify/TS strict/viem/vitest) vs `project-context.md` | ✅ sin drift |
| SUT verificado con Read (líneas del gap confirmadas) | ✅ |
| Exemplars verificados con Read/Grep (paths reales) | ✅ |
| Missing input #1 (nombre env var) resuelto | ✅ DT-1: `BASE_FACILITATOR_API_KEY → FACILITATOR_API_KEY` |
| Missing input #2 (¿Avalanche mismo gap?) resuelto | ✅ SÍ — documentado como TD-1, fuera de scope |
| Missing input #3 (valor real key en prod) | ⏳ ops/Railway — NO bloquea merge ni unit tests (mockean fetch) |
| Interfaces `types.ts` NO cambian | ✅ confirmado (CD-6) |
| ≥1 test por AC planificado | ✅ 8 tests cubren AC-1..AC-7 |
| CDs del work-item heredados | ✅ CD-1..CD-7 + nuevos CD-8..CD-11 |
| Auto-blindaje histórico aplicado | ✅ WKH-104 (#1,#2), WKH-102 (#2) → CD-8/9/10 |
| Sin `[NEEDS CLARIFICATION]` bloqueante | ✅ (el único pendiente es ops, no bloquea código) |
| Base mainnet excluido | ✅ CD-3 |

**Veredicto: LISTO PARA SPEC_APPROVED.** No hay TBDs bloqueantes. El cambio es
quirúrgico, todos los exemplars y líneas están verificados, y el único pendiente
(valor real de la key) es ops y no afecta el merge del código ni los unit tests.
