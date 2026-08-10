# Implementation log — WKH-342 · F3

Todo lo de acá es **MEDIDO** el **2026-08-09** salvo donde dice `DERIVADO`.
Los números y las citas se escribieron **después** de la última edición de código.

| Repo | Rama | Base | Commits de esta HU |
|---|---|---|---|
| **A** `wasiai-facilitator` | `fix/219-wkh-342-supported-derive-registered-routes` | `b896228` | `990cc56` (F3) + `435bb38` (AR) + `464380c` (CR) |
| **B** `wasiai-a2a` | `fix/219-wkh-342-payout-route-probe-guard` | `568cf40` | `f461219` (F3) + `af55495` (AR) + `6b72396` (CR) |

---

## 0 · Estado de partida declarado

`git status --porcelain` antes de empezar (MEDIDO):

- **A**: vacío. Árbol limpio, `HEAD = b896228b00eca595b73f59f6c7121523bdf4f6e3`.
- **B**: **10 entradas preexistentes** — `M doc/sdd/_INDEX.md` + 9 `??`
  (`contracts/.gas-snapshot`, `doc/jury-qa*.md` ×3, `doc/roadmap/`,
  `doc/sdd/118-…`, `doc/sdd/212-…`, `doc/sdd/214-…`, `doc/sdd/219-…`).
  **No se tocaron ni se commitearon.** `HEAD = 568cf40d0ae744f2754505b72bcbd7d37a40155e`.

## 1 · Orden A→B: respetado

W0→W2 (repo A) se completaron y quedaron verdes **antes** de escribir la primera línea de
W3. Verificado en el orden real de la sesión: el commit de A (`990cc56`) se hizo con
`92 files / 1361 tests` + `typecheck` + `typecheck:tests` + `lint` + `format:check` todos
en exit 0, y sólo después se abrió `facilitator-settle.ts` de B.

Motivo, que es el del Story File §2 y no cosmético: con B primero el sondeo devuelve
`route_unaskable/field_absent` contra un facilitator sin el campo ⟹ se comporta igual que
hoy ⟹ **el guard queda inerte** y un F4 medido en esa ventana daría verde sobre un guard
que no guarda nada.

---

## 2 · Los tres desenlaces, con el input que dispara cada uno

Unión discriminada en `src/adapters/solana/facilitator-settle.ts:287-294` (B, re-derivado tras la ronda AR). Cero
`boolean` en el retorno; el tipo mismo es un guard (ver §5, mutante M-B5).

| Desenlace | Input EXACTO que lo dispara | Qué hace | Test |
|---|---|---|---|
| `route_registered` | `GET /supported` → 200 + `{ dedicatedRoutes: ['POST /solana/payout'] }` | sigue, hace el POST | T-B2, T-B2b |
| `route_absent` | 200 + `{ dedicatedRoutes: [] }` (o con otras rutas y no la nuestra) | **rechaza ANTES del POST**, `'not-sent'` | T-B3, T-B3b, T-B3c |
| `route_unaskable` / `transport_error` | el `fetch` del sondeo **RECHAZA** (`socket hang up` + `cause.code ETIMEDOUT`) | **deja pasar**: hace el POST | T-B4, T-B4b |
| `route_unaskable` / `probe_http_error` | **404 sobre `/supported`** (o 500) | deja pasar | T-B6 |
| `route_unaskable` / `body_unreadable` | 200 con `'<html>…'`, o un **array** como cuerpo | deja pasar | T-B6b, T-B6c |
| `route_unaskable` / `field_absent` | 200 sano **sin** `dedicatedRoutes` (facilitator anterior a la mitad A); también `null`, `'POST /solana/payout'`, `42`, `{}` | deja pasar | T-B5, T-B5b |

**La asimetría está SOSTENIDA EN EL CÓDIGO, no sólo en el doc**: el `if` del gate
(`facilitator-settle.ts:617`) compara contra `'route_absent'` y nada más, así que los
cuatro `route_unaskable` no tienen rama de corte que tomar. Y hay un test que lo recorre
como conjunto: **T-B6d** arma los cuatro motivos uno por uno y exige que en los cuatro el
POST salga. Muere con el mutante que colapsa cualquiera de ellos.

Discriminante: `Array.isArray(routes)` (`:372`), nunca truthiness. Y desde la ronda AR, `route_absent` exige ADEMÁS que todos los elementos sean strings (`:396`) y compara normalizado (`:414`). `[]` es una RESPUESTA;
la ausencia del campo es un NO SÉ.

---

## 3 · Repo A — archivos y qué se hizo

| Archivo | Qué |
|---|---|
| `src/core/supported.ts` | tupla `DEDICATED_ROUTE_IDS` (`:149-153`) + tipo derivado `DedicatedRouteId` (`:155`), campo `dedicatedRoutes` en `SupportedResponse` (`:181`), parámetro **requerido** en `getSupportedResponse()` (`:213-214`), copia y no alias (`:276`) |
| `src/routes/supported.ts` | `Record` exhaustivo de las **tres** rutas opt-in (`:58-67`) + resolución con `app.hasRoute` **dentro del handler** (`:106`, dentro del `async (request, reply)` de `:82`) + campo en el build explícito (`:128`) |
| `src/__tests__/unit/routes.supported.test.ts` | T-A1 (`:860`), T-A2 (`:888`), T-A2b (`:908`), T-A3 (`:954`), T-A4 (`:1026`), T-A4b (`:1052`) |
| `src/__tests__/unit/chains/solana-adapter.test.ts:462` | 2º llamador, adaptado con `[]` |

**Dos tests preexistentes cambiaron de expectativa, y era inevitable**: `T-R1` afirmaba
`Object.keys(body).sort() === ['chains','methods']` y `T-R9` `toEqual({chains:[],methods:[]})`.
Las dos son igualdades EXACTAS de forma y el campo nuevo es parte de la forma. No se
aflojaron: `T-R1` sigue siendo igualdad exacta con tres claves (una 4ª la pone en rojo) y
`T-R9` sigue siendo igualdad profunda, ahora con `dedicatedRoutes: []`.

**Deriva declarada en el primer commit y CERRADA en la ronda AR** (AR BLQ-BAJO-2, commit
`435bb38` de A): `doc/openapi.yaml` no documentaba el campo y `T-O6` comparaba el spec
consigo mismo, así que la divergencia no la cazaba nada — y encima documentar el campo ponía
`T-O6` en rojo. Ahora `T-O6` deriva las claves esperadas de `getSupportedResponse()`.
Detalle y mutante en §6bis.

## 4 · Repo B — archivos y qué se hizo

| Archivo | Qué |
|---|---|
| `src/adapters/solana/facilitator-settle.ts` | `UnaskableReason` (`:245-269`), `PayoutRouteVerdict` (`:287-294`), `_resetPayoutRoutePreflight` (`:301`), `isPayoutViaFacilitatorOn` (`:318`), `probePayoutRoute` (`:329-425`, con el `every` de tipo de elemento en `:396` y la comparación normalizada en `:414`), `logRouteVerdict` (`:443-476`, el `switch` exhaustivo de MNR-2), `ensurePayoutRouteReady` (`:496-541`, con el `commit()` único de CR MNR-3b en `:520-526`), `warmPayoutRoutePreflight` (`:564-566`), constantes (`PAYOUT_ROUTE_ID :197`, timeout `:209`, TTL positivo `:226`, TTL negativo `:235`), paso 0 del gate (`:603-633`) |
| `src/index.ts:357` | **UNA** línea, después de `await fastify.listen(` (`:328`), sin `await`, sin `if` en el call-site |
| `src/adapters/solana/facilitator-settle.test.ts` | +29 tests (T-B1…T-B6, T-B8, T-B10…T-B13 y sus sufijos) + `_resetPayoutRoutePreflight()` en el `beforeEach` + la bandera en `ENV_KEYS` |
| `src/adapters/solana/facilitator-settle.wiring.test.ts` (**nuevo**) | T-B7, T-B7b, T-B7c, T-B7d |
| `src/adapters/solana/payment.flag.test.ts` | ⚠️ dos rondas: la aserción de T-B9 (§7) y, tras el AR, el arreglo del acoplamiento por orden (`_resetPayoutRoutePreflight()` en el `beforeEach`, `mockImplementation` ×6, `postCalls()` por verbo) — ver §6bis |

`assertFacilitatorPayoutConfigured` (`:172-184`) **no se tocó**: mismo cuerpo, mismo
mensaje. Sólo se le agregó un párrafo al docblock (`:161-166`) que dice que lo de arriba
sigue siendo cierto palabra por palabra.

### Los dos tests que el Story File salvó de ubicación — verificados

- **T-B7 en `src/`**: `vitest.config.ts:5` incluye `src/**` y `test/**`, pero
  `tsconfig.json:19` incluye **sólo `src/**/*`** ⟹ en `test/` no lo typechequearía nadie.
  MEDIDO: `tsc --noEmit` exit 0 con el archivo en `src/`.
- **T-A4b y `typecheck:tests`**: `A/tsconfig.json:20` excluye los `.test.ts` del typecheck
  principal. Corrido explícitamente. Y **verificado que evalúa la aserción**: con el
  mutante "parámetro opcional" en `src/core/supported.ts:214`,
  `npm run typecheck:tests` sale con **exit 2** y
  `src/__tests__/unit/routes.supported.test.ts(1069,7): error TS2578: Unused '@ts-expect-error' directive.`
  (re-medido contra el árbol final, después del `prettier --write`; la directiva vive en
  `:1069`). Revertido con `sha256sum -c` OK y `git status --porcelain` vacío en A.

**Y el mismo criterio aplicado a los 33 tests nuevos** (MEDIDO, no derivado): los 29 de
`facilitator-settle.test.ts` y los 4 de `facilitator-settle.wiring.test.ts` viven en
`src/`, así que los corre `vitest.config.ts:5` (confirmado: aparecen por nombre en la
salida `--reporter=verbose`) y los typechequea `tsc --noEmit` (confirmado: el error
TS7006 en `facilitator-settle.test.ts:297` lo tiró `tsc`, no vitest). Los 6 de A viven en
`src/__tests__/unit/`, los corre `vitest run` y los typechequea `typecheck:tests`.

---

## 5 · Mutación: cada test nuevo con su rojo medido

Todos los mutantes se aplicaron con `Edit`, se midió el rojo, y se revirtieron
verificando con `sha256sum -c` que el archivo volvió **byte-idéntico**. **Nunca** se usó
`git checkout --` (revertiría a HEAD y borraría el trabajo sin commitear).

### Repo A

| Mutante (1 línea) | Rojo MEDIDO | Sobrevive |
|---|---|---|
| M-A1: `app.hasRoute(…)` → derivar de `getSupportedResponse([]).methods` | **T-A1, T-A2b** (`2 failed \| 26 passed`) | T-A2, T-A3, T-A4 |
| M-A2: `app.hasRoute(…)` → `DEDICATED_ROUTES.includes(route)` (lista hardcodeada) | **T-A2**, T-A1, T-R9 (`3 failed \| 25 passed`) | T-A2b, T-A3, T-A4 |
| M-A3: `methods` = unión ∪ `dedicatedRoutes` | **T-A3, y sólo T-A3** (`1 failed \| 27 passed`) | todo el resto |
| M-A4: parámetro `= []` (opcional) | **`typecheck:tests` exit 2 (TS2578)** + **T-A4b** en runtime | los demás |

⚠️ M-A3 **sobrevivió en el primer intento** (`28 passed`). Está documentado en
`auto-blindaje.md`: el fixture no tenía ninguna ruta registrada, así que no había nada
que filtrar. T-A3 se reescribió y se re-midió.

### Repo B — baseline de las dos suites: `48 passed (48)`

| Mutante (1 línea) | Rojo MEDIDO | Sobrevive |
|---|---|---|
| M-B1: cuerpo de `warmPayoutRoutePreflight` → no-op | **T-B1, T-B1b** | el resto |
| M-B3: el `if` del gate → `if (false && …)` | **T-B3, T-B10b, T-B10c** | T-B4/5/6 |
| **M-B4-α**: el `catch` del sondeo devuelve `route_absent` | **T-B4, T-B4b, T-B6d** | **T-B6, T-B6b, T-B6c** |
| **M-B6-β**: `status !== 200` devuelve `route_absent` | **T-B6, T-B6d, T-B10b** | **T-B4, T-B4b** |
| M-B5: `field_absent` devuelve `route_absent` | **T-B5, T-B5b, T-B6d, T-B11d** + **`tsc` TS2353** | los demás |
| M-B8: `=== 'true'` → `Boolean(...)` | **T-B8** | el resto |
| M-B10: agregar `'PAYOUT_ROUTE_ABSENT'` a `PAYOUT_NO_SPEND_CODES` | **T-B10** | el resto |
| M-B11-ttl: TTL positivo → `Number.POSITIVE_INFINITY` | **T-B11b** | el resto |
| M-B11-sf: quitar el `if (_routeInFlight !== null)` | **T-B11** | el resto |
| M-B7a: `await warmPayoutRoutePreflight();` | **T-B7, T-B7b** | el resto |
| M-B7b: la llamada movida ANTES de `listen` | **T-B7** | el resto |
| M-B7c: la llamada borrada de `index.ts` | **T-B7, T-B7b** | el resto |

### 🔴 T-B4 y T-B6 mueren con mutantes DISTINTOS — MEDIDO, y cada uno sobrevive al del otro

- **M-B4-α** (el `catch` → `route_absent`): T-B4 y T-B4b **rojos**; T-B6, T-B6b, T-B6c
  **verdes**.
- **M-B6-β** (`status !== 200` → `route_absent`): T-B6 **rojo**; T-B4 y T-B4b **verdes**.

O sea: T-B4 prueba el `catch` del `fetch` (un doble que **rechaza**) y T-B6 prueba la rama
de status (**un 404, que es una RESPUESTA**). Ninguno de los dos cubre al otro. T-B6d cae
con los dos porque recorre los cuatro motivos a propósito.

---

## 6 · Los cuatro controles no opcionales

**CD-2 · Cero líneas nuevas que fabriquen una disposición de pago.** MEDIDO por conteo
derivado contra `HEAD`:

```
lineas de CODIGO con 'not-sent' | 'unknown'  →  HEAD: 5   ·  ahora: 6   ·  delta: +1
```

La única línea nueva es `facilitator-settle.ts:624`, y es `'not-sent'` — un valor que YA
existía, con la MISMA construcción `FacilitatorSettleError(msg, 'not-sent')` de la rama
sin URL (`:592`, la de `:203-209` del original). **Cero valores de disposición nuevos.**
`grep -c "success"` en el archivo = **0**. `SettleResult` aparece **1** vez, y es dentro de
un comentario. Re-medido después de la ronda AR: sigue en **6 vs 5**. La disposición
`'unknown'` de HU-201 (`:666`, `:691`, `:701`) y
`PAYOUT_NO_SPEND_CODES` (10 códigos, `:86-97`) quedaron intactas — T-B10 compara el
conjunto contra la lista escrita a mano, no contra sí mismo.

**CD-3 · Ninguna env tocada ni propuesta.** `git diff --name-only` no incluye ningún
`.env*` en ninguno de los dos repos (MEDIDO). No se introdujo ningún nombre de variable
nuevo: los TTL (300 s / 60 s) y el timeout (5 s) son **constantes de módulo**
(`:186`, `:226`, `:206`). Los tests SETEAN variables existentes en `process.env` (lo exige
T-B8, que enumera 6 valores de la bandera) y las restauran en el `afterEach`.

**Camino EVM byte-idéntico.** `git diff --name-only` en B: **ningún archivo** bajo
`avalanche/`, `base/`, `kite-ozone/`, `tempo/`, `inbound/`, `escrow/` (MEDIDO, la búsqueda
devolvió `NINGUNO`). La suite completa de B pasa (§8). Cero llamadas de red nuevas en EVM:
el sondeo vive dentro de `adapters/solana/facilitator-settle.ts` y su única puerta es
`SOLANA_SETTLE_VIA_FACILITATOR === 'true'`.

**Los 8 puntos de la no-touch (§7 del Story File)**, uno por uno:

1. EVM byte-idéntico → 0 archivos EVM en el diff (arriba).
2. Cero fabricación de disposición → +1 línea, valor preexistente (arriba).
3. Ninguna env → 0 `.env*` en el diff, 0 nombres nuevos (arriba).
4. El arranque no puede fallar por el sondeo → `warmPayoutRoutePreflight` es
   `void … .catch(() => {})` (`:565`), el manejador de rechazo de `ensurePayoutRouteReady`
   (`:531-537`, que pasa por el MISMO `commit()`) no puede rechazar la promise, y no hay `process.exit` en el archivo.
   T-B1b lo mide con un `fetch` que rechaza. ⚠️ Y por eso el `default` del `switch` de
   MNR-2 **no lanza** (`:460-474`: `log.error` en `:469` y `return` en `:473`, sin `throw`; y el CR lo confirmó con mejor razón que la mía: `:624` hace `await ensurePayoutRouteReady()` **sin try/catch**, así que un `throw` saldría como error no-`FacilitatorSettleError` ⟹ disposición sin clasificar): corre dentro del `.then` que el gate `await`ea.
5. `Array.isArray`, nunca truthiness → `:372`; T-B5b lo mide con `null`, un string que
   CONTIENE el id, `42` y `{}`. Y `route_absent` exige además todos-strings (`:396`,
   T-B12/T-B12b).
6. `getSupportedResponse()` sin perder pureza → `A/src/core/supported.ts` no ganó **ni un
   import** (los dos de `:33-34` son los de antes, re-verificado tras la ronda CR: la tupla
   `as const` es un valor local, no un import); cero I/O, cero logger. T-A4 mide
   "mismo argumento ⟹ misma respuesta" y que el argumento no quede aliasado.
7. La señal NO se lee en el cuerpo del plugin → `app.hasRoute` está dentro del handler
   (`A/src/routes/supported.ts:106`, dentro del `async (request, reply) =>` de `:82`).
   T-A2b lo mide de punta a punta y convierte en MEDIDO lo que era DERIVADO.
8. `assertFacilitatorPayoutConfigured` intacta → cuerpo y mensaje sin cambios
   (`B/…/facilitator-settle.ts:172-184`).

---

## 6bis · Ronda AR — los 3 bloqueantes y los 3 menores

### 🔴 BLQ-BAJO-1 · el CUARTO desenlace, y caía del lado que CORTA EL PAGO

`routes.includes(...)` no validaba el TIPO de los elementos. **MEDIDO antes del fix**, con
`{"dedicatedRoutes":[{"id":"POST /solana/payout"}]}`: veredicto **`route_absent`**, `detail`
con `as [[object Object]]`, leg muerto en `'not-sent'`, `urls = ["…/supported"]` — **cero
POST, con la ruta servida del otro lado**. Ídem `['post /solana/payout']` (casing):
`route_absent`, cero POST.

**La forma del defecto, que es lo que hay que llevarse**: la disciplina *"forma que no
entiendo ⟹ `unaskable`"* estaba aplicada al **cuerpo** y al **campo**, y se detenía **un
nivel antes**: en los **elementos**. El nivel que faltaba era justo el que decide.

Arreglo, y las dos mitades van **en la dirección segura** (las dos hacen `route_absent`
MÁS difícil de alcanzar, nunca más fácil — o sea que sólo pueden dejar pasar de más, cuyo
peor caso es el comportamiento de hoy):
1. `routes.every(r => typeof r === 'string')` como **precondición de `route_absent`**; si no
   se cumple ⟹ `body_unreadable`.
2. comparación **normalizada** (trim + espacios colapsados + mayúsculas): una diferencia de
   capitalización no es evidencia de que la ruta no exista.

Tests nuevos y su rojo, MEDIDO:

| Mutante (1 línea) | Rojo |
|---|---|
| quitar el `every` de tipo de elemento | **T-B12, T-B12b** |
| comparar sin normalizar (`route === PAYOUT_ROUTE_ID`) | **T-B13** |
| `routes.some(() => true)` (todo matchea) | **T-B13b, T-B3c** ← el control de que `route_absent` no dejó de existir |

Único camino a `route_absent` ahora: 200 + objeto + array + **todos strings** + ninguno
igual (normalizado) al id.

### 🔴 BLQ-BAJO-2 · el contrato publicado rechazaba la respuesta real — ver commit `435bb38` de A

Reproducido con `ajv` contra `doc/openapi.yaml`: `should NOT have additional properties:
dedicatedRoutes`, en todo 200. **T-O6 ahora deriva del tipo** (llama a
`getSupportedResponse()` y usa las claves que emite), en las dos direcciones, y lo mismo
para `ChainSupportedItem` con un adaptador testigo.

⚠️ **Acá escribí "No quedó residuo" y era FALSO — lo corrige CR MNR-1, ver §6ter.** La
derivación cubría el eje de las **claves** y se detenía un nivel más abajo: el `items` del
array seguía escrito a mano. Dos mutantes lo dejaban verde. Es exactamente la trampa que la
regla del reporte describe: si podés nombrar el mutante de una línea, la frase no puede
decir "cerrado".

Validación post-fix del cuerpo real y de tres contraejemplos:

```
{chains,methods,dedicatedRoutes:['POST /solana/payout']} -> true
{chains,methods,dedicatedRoutes:[]}                      -> true
{chains,methods}                    -> false  (required 'dedicatedRoutes')
{…,dedicatedRoutes:['POST /nope']}  -> false  (enum)
```

Mutante que restaura el defecto: sacar `dedicatedRoutes` de `required` ⟹ **T-O6 rojo**
(medido). Con el test viejo ese mismo cambio daba **verde**.

### MNR-1 · la frase de exposición pública, corregida

Decía "no agrega información" y afirmaba de más. La correcta y falsable: **no agrega ningún
bit que un atacante que YA conoce el path no pueda obtener solo** (un POST vacío distingue
401 de 404 sin credencial, porque `auth` va primero). **Lo que sí cambia**: los tres paths
de tesorería nunca estuvieron en `doc/openapi.yaml`, así que el delta real es **costo de
descubrimiento** (de adivinar a leer) y **fingerprinting por instancia**. Chico, porque los
nombres son de baja entropía — pero **no cero**. Corregido en `sdd.md` DT-3 y en el
`[NEEDS CLARIFICATION-2]`.

### MNR-2 · el `if` aceptaba un estado nuevo en silencio

MEDIDO: agregar un cuarto miembro al union dejaba `tsc --noEmit` en **exit 0**, y ese estado
no matcheaba ni la rama `error` ni la `warn` ⟹ **telemetría cero**. Ahora es un `switch`
exhaustivo con `const exhaustive: never` en un helper `logRouteVerdict`. Re-medido con el
mutante: `error TS2322: Type '{ readonly state: "route_mutant_fourth_state"; }' is not
assignable to type 'never'` (**exit 2**).

⚠️ Y una decisión propia sobre el arreglo del AR: el `default` **no lanza**. Este logger
corre dentro del `.then` del veredicto, así que un `throw` rechazaría la promise que el gate
perezoso `await`ea — un error sin clasificar en un camino de dinero es peor que un estado
sin tratar. Loguea `error` y sigue: el lado permisivo, el mismo que elige la asimetría.

### MNR-3 · mi declaración de residuo de T-B7 era más ancha que la verdad

MEDIDO: `if (Number('0')) warmPayoutRoutePreflight();` (inline) ⟹ **T-B7 y T-B7b ROJOS** (la
regex exige que la llamada arranque la línea). Sólo el bloque **multilínea**
`if (…) {\n  warm…();\n}` pasa los 4 — **ése es el residuo real, y es el único**. Y el radio
de un descableado es acotado: se pierde la **alarma de arranque**, no el gate (el gate del
leg sondea igual la primera vez que se usa). Corregido en el docblock de
`facilitator-settle.wiring.test.ts`.

---

## 6ter · Ronda CR — el residuo que mi "no quedó residuo" tapaba

### CR MNR-1 · `T-O6` derivaba las CLAVES y no bajaba al `items` — CERRADO derivando el `enum` del union

**Los dos inputs del CR, reproducidos por mí antes de tocar nada** (`routes.openapi.test.ts`
en **14 passed**, `tsc` en **0**, y `ajv` rechazando el cuerpo real):

| Input | Test | `tsc` | ajv sobre el 200 real |
|---|---|---|---|
| `doc/openapi.yaml` `items.type: string` → `integer` | 14 passed | 0 | rechaza |
| cuarto `DedicatedRouteId` en `core/supported.ts` + fila en `routes/supported.ts` | 14 passed | 0 | `should be equal to one of the allowed values` |

**Arreglo — el `enum` SE DERIVA, no se repite.** Se invirtió la relación tipo↔valor:

- `core/supported.ts` — `DEDICATED_ROUTE_IDS` es ahora una **tupla `as const`** en runtime, y
  `DedicatedRouteId = (typeof DEDICATED_ROUTE_IDS)[number]` justo debajo. Antes el
  union sólo existía en compilación, así que el yaml **no tenía de dónde derivar** la lista.
- `routes/supported.ts` — la tabla de sondeos pasó de array a
  `Readonly<Record<DedicatedRouteId, …>>`, que es **exhaustivo**: un id nuevo sin fila no
  compila.
- `routes.openapi.test.ts` — `T-O6` compara `items.enum` contra `DEDICATED_ROUTE_IDS` y
  deriva `items.type` del `typeof` real de esos valores, no de un literal escrito en el test.

**Re-medido con los mutantes, ahora rojos** (y el tercero es propio):

| Mutante (1 línea) | Resultado MEDIDO |
|---|---|
| (a) `items.type: string` → `integer` | **T-O6 rojo**: `expected 'integer' to be 'string'` |
| (b) cuarto id en la tupla | **`tsc` exit 2** — `TS2741: Property '"POST /solana/mutant"' is missing … in type 'Readonly<Record<…>>'` (`routes/supported.ts:58`) — y con la fila agregada, **T-O6 rojo** |
| (c) borrar un id del `enum` del yaml | **T-O6 rojo** |

**Qué NO puedo decir**: que "el openapi ya no puede divergir del código". El mutante de una
línea que restaura la divergencia es **volver a escribir el union a mano**
(`export type DedicatedRouteId = 'POST /solana/payout' | …`) en lugar de derivarlo de la
tupla: ahí la tupla y el tipo se separan y el `enum` del yaml vuelve a no tener fuente. Lo
correcto y falsable es: *el `enum` y el `items.type` del yaml se derivan hoy de
`DEDICATED_ROUTE_IDS`, y los tres mutantes de arriba están medidos en rojo.*

### CR MNR-2 · NO es de esta HU — `/health` viola su contrato, y es deuda preexistente

El CR encontró el gemelo exacto vivo en producción (`src/routes/health.ts:52-60` sirve 6
campos contra un `HealthResponse` de 4 con `additionalProperties: false`, y `T-O11` es el
mismo guard auto-comparado, verde). **No lo toqué**: ya está abierto como tarea aparte, y
frenar esta HU por deuda preexistente sería el error opuesto al de BLQ-MED-1 — allá la
premisa medida era "lo rompimos nosotros", acá es "ya estaba", y esta vez está **medido por
el CR**, no asumido por mí.

### CR MNR-3 · las dos frases viejas

- **(a)** `implementation-log.md` §9.2 decía que "un `if (false)` alrededor … pasaría el
  test". Corregido con mi propia medición: la forma **inline** pone **T-B7 y T-B7b rojos**;
  el residuo real es **sólo el bloque multilínea**.
- **(b)** `facilitator-settle.ts` — la rama `onRejected` cacheaba un veredicto **sin pasar
  por `logRouteVerdict`**, la única excepción viva a la frase que motiva el `switch`
  exhaustivo. **Cerrada, no declarada**: las dos ramas del `.then` van por un único
  `commit()` (`:520-526`) que memoiza y loguea en el mismo lugar, así que no pueden divergir.

---

## 7 · 🔴 HALLAZGO PARA EL AR — T-B9 era imposible tal como está escrito (el AR lo CONFIRMÓ)

El Story File §6 pone `payment.flag.test.ts` en la lista de suites que deben pasar **sin
editarlas**, y agrega: *"Si necesitás editar una de esas suites, pará: es señal de
violación de la no-touch, va al AR"*. **Lo hubo que editar, y no es evitable.**

**Lo medido**: `src/adapters/solana/payment.flag.test.ts:311` (en HEAD) afirmaba
`expect(fetchSpy).toHaveBeenCalledTimes(1)` sobre el camino con la bandera **ON**. El
sondeo agrega un `GET {url}/supported` **delante** del POST, así que ese `1` pasa a ser
`2`. **No es un artefacto del doble: es una aserción semántica deliberada.** Y ninguna
implementación que satisfaga T-B3 (que exige que el gate perezoso sondee dentro del leg)
puede dejar ese `1` en pie.

**Lo que hice**, y es el mínimo: cambié esa única aserción por una **estrictamente más
específica** — exactamente UN `POST` contra `/solana/payout` — que conserva lo que el test
protegía ("exactamente un camino por request": un segundo POST sería un doble pago, un GET
de discovery no mueve valor) y agrega el detalle de a qué URL. Más `mockImplementation` en
lugar de `mockResolvedValue` por el bug del `Response` de un solo uso.
Diff total en ese archivo: **19 líneas, +17/−2, en un solo test**.

### ✅ AR BLQ-MED-1 · el acoplamiento por orden — ARREGLADO, y mi premisa era la equivocada

**Lo que argumenté acá antes**: que era deuda heredada de una suite no-touch y que la
decisión no era mía. **El AR midió la premisa y era falsa**: la base `568cf40` era
**order-independent** y el acoplamiento lo introdujo **este commit**. No es deuda heredada,
es una regresión nuestra. Con esa premisa corregida no hay decisión que delegar: se arregla
acá.

**Y el conteo que escribí estaba mal**: dije "11 tests con la bandera ON, los 10 restantes
verdes por orden". Los afectados eran **6, no 10** (corrección del AR). Los otros pasan
aislados porque sus dobles **rechazan** o **no son JSON**, así que el sondeo nunca les
consume un cuerpo reusable: un `status !== 200` retorna **antes** de leer el body
(`facilitator-settle.ts`, rama `probe_http_error`), así que el `Response` llega intacto al
POST.

Los 6, MEDIDOS uno por uno con `-t`, antes y después:

| Test (`-t`) | antes del fix | después |
|---|---|---|
| `el POST lleva el contrato` | 1 failed | **1 passed** |
| `alreadySettled:true` | 1 failed | **1 passed** |
| `la cota de expiración se FABRICA` | 1 failed | **1 passed** |
| `un 2xx NO alcanza` | 1 failed | **1 passed** |
| `T-319-16` | 1 failed | **1 passed** |
| `una re-firma legítima` | 1 failed | **1 passed** |

**Arreglo aplicado** (el que indicó el AR): `_resetPayoutRoutePreflight()` en el
`beforeEach` del archivo, `mockImplementation` en los 6 sitios, y los `mock.calls[0]`
re-indexados — no por índice sino **por verbo**, con un helper `postCalls()`, que además es
robusto ante otro request que se agregue delante.

**Verificación más fuerte que la pedida** (MEDIDO): los **18** tests del archivo, corridos
**cada uno solo**, dan `1 passed`. Comando, con el escapado que hace falta:

```
while IFS= read -r t; do
  esc=$(printf '%s' "$t" | sed -e 's/[][(){}.*+?^$|\\]/\\&/g')
  ./node_modules/.bin/vitest run src/adapters/solana/payment.flag.test.ts -t "$esc"
done < <nombres de los 18 `it(`>
→ 18/18 "1 passed"
```

⚠️ **No puedo decir "el acoplamiento por orden está eliminado"**, y el control de la regla
lo prueba: el mutante de UNA línea que lo restaura es **borrar
`_resetPayoutRoutePreflight()` del `beforeEach`** (`payment.flag.test.ts`). Lo correcto es:
*los 18 tests de este archivo pasan aislados, y el único punto que lo sostiene es esa
línea.* Lo que sí está cerrado por construcción es la CLASE en el otro archivo, donde el
reset ya estaba desde el primer commit.

---

## 8 · Baseline de cierre, re-medido por mí, por repo y con su commit al lado

### A · `wasiai-facilitator`, commit `464380c`

| Comando | Resultado MEDIDO | Base `b896228` | Delta |
|---|---|---|---|
| `npm test` | **92 test files passed (92) · 1361 tests passed (1361)** | 92 / 1355 | files =, **tests +6** |
| `npm run typecheck` | exit **0** | 0 | = |
| `npm run typecheck:tests` | exit **0** | 0 | = |
| `npm run lint` (`eslint src/ --max-warnings 0`) | exit **0** | 0 | = |
| `npm run format:check` | exit **0** | — | limpio |

Los +6: `T-A1`, `T-A2`, `T-A2b`, `T-A3`, `T-A4`, `T-A4b`. Cero skipped en los dos lados. Ni
la ronda AR ni la del CR agregaron tests en A: las dos **reescribieron T-O6** (primero para
que derivara las claves del tipo, después para que bajara al `items`). Mismo conteo, más
poder — y eso está medido con sus tres mutantes, no afirmado.

### B · `wasiai-a2a`, commit `6b72396`

| Comando | Resultado MEDIDO | Base `568cf40` | Delta |
|---|---|---|---|
| `npm test` | **274 passed \| 6 skipped (280 files) · 5391 passed \| 19 skipped (5410 tests)** | 273 \| 6 (279) · 5358 \| 19 (5377) | **files +1**, **tests +33**, **skipped = (6 y 19, sin crecer)** |
| `npx tsc --noEmit` | exit **0** | 0 | = |
| `npm run lint` (`biome check src/`) | exit **0** | 0 | = |

Los +33, derivados mecánicamente: `facilitator-settle.test.ts` pasó de **19** a **48** `it(`
de primer nivel (+29) y `facilitator-settle.wiring.test.ts` aporta **4**. 29+4 = 33, que es
exactamente `5391 − 5358`. Los 4 de la ronda AR son `T-B12`, `T-B12b`, `T-B13`, `T-B13b`.
IDs presentes, derivados del fuente: T-B1, T-B1b, T-B2, T-B2b, T-B3, T-B3b, T-B3c, T-B4,
T-B4b, T-B5, T-B5b, T-B6, T-B6b, T-B6c, T-B6d, T-B7, T-B7b, T-B7c, T-B7d, T-B8, T-B8b,
T-B8c, T-B10, T-B10b, T-B10c, T-B11, T-B11b, T-B11c, T-B11d, T-B12, T-B12b, T-B13, T-B13b.

`git status --porcelain` al cerrar: sólo mis 5 archivos (4 `M` + 1 `??`) **más las 10
entradas preexistentes** declaradas en §0. Ningún test previo pasó a fallar ni a skipped.

---

## 9 · Qué NO pude medir

1. **Que la mitad A esté desplegada.** Todo lo de B se midió contra **dobles**. Con el
   facilitator de producción sin `dedicatedRoutes`, el sondeo real da hoy
   `route_unaskable/field_absent` ⟹ comportamiento idéntico al de antes ⟹ **el guard está
   inerte hasta que A despliegue**. No hay verde posible sobre `route_absent` en vivo antes
   de eso.
2. **Que el warm-up se EJECUTE en el arranque real.** T-B7 lee el texto de `src/index.ts`
   (no se puede importar: tiene `await initAdapters()` de nivel de módulo).
   ⚠️ **CORREGIDO (CR MNR-3a) — acá decía "un `if (false)` alrededor … pasaría el test", y mi
   propia medición lo refuta**: la guarda **inline** `if (Number('0')) warmPayoutRoutePreflight();`
   pone **T-B7 y T-B7b ROJOS** (la regex exige que la llamada arranque la línea). El residuo
   real es **sólo el bloque multilínea** —`if (…) {\n  warmPayoutRoutePreflight();\n}`, que
   deja los 4 en verde— y un `process.exit()` antes. Y el radio de un descableado es
   acotado: se pierde la **alarma de arranque**, no el gate (el gate del leg sondea igual la
   primera vez que se usa). El docblock del archivo ya lo decía así; este renglón se había
   quedado atrás.
3. **El comportamiento con la bandera encendida en producción.** `SOLANA_SETTLE_VIA_FACILITATOR`
   sigue apagada y **no la toqué ni la propuse**: prenderla es decisión del founder,
   posterior a esta HU. Sin eso, el sondeo no hace un solo `fetch` en prod.
4. **Que `hasRoute` siga atravesando la encapsulación en otra versión de fastify.** Se midió
   contra la instalada (T-A2b, MEDIDO). El argumento de por qué
   (`node_modules/fastify/lib/route.js:175-182`, un `router` por servidor) es lectura de
   una dependencia y puede cambiar en un upgrade.
5. **Cobertura del sondeo por mutación EXHAUSTIVA.** Se aplicaron **12 mutantes de una
   línea** elegidos a mano, los que el Story File nombra más tres propios (array como
   cuerpo, single-flight, wiring movido). No corrí un mutador automático sobre el archivo.
6. **~~La deriva del OpenAPI de A~~** — CERRADA en la ronda AR (BLQ-BAJO-2, commit `435bb38`
   de A). Lo que sigue sin medir es si algún consumidor genera clientes desde ese spec: si
   alguno lo hace, el campo nuevo aparece en su modelo, y eso es aditivo.
7. **Si el `route_absent` en vivo corta un leg real.** Todo el desenlace que CORTA se midió
   sólo con dobles. La primera vez que corra contra un facilitator real que conteste 200 sin
   la ruta es en despliegue.
8. **La base `568cf40` corriendo la suite.** Que era order-independent lo midió el AR; yo
   verifiqué el lado "después" (18/18 aislados) y el mecanismo (`git show 568cf40:` no tiene
   sondeo, así que no había cache que compartir), no re-corrí la suite en un worktree de la
   base.
9. **Que el `default` del `switch` de MNR-2 sea inalcanzable en runtime.** Es inalcanzable
   *mientras el `never` compile*; no hay test que lo ejercite, porque para ejercitarlo habría
   que romper el tipo.
