# SDD — [WKH-342] `/supported` deriva las rutas dedicadas reales + el gateway sondea la ruta, no el string

Fecha del SDD: **2026-08-09**. Commits medidos: `wasiai-a2a@568cf40`, `wasiai-facilitator@b896228`
(árboles de trabajo; en a2a sólo hay `doc/` sin trackear). Todo número o estado de abajo lleva
su fecha/commit en la misma línea. `MEDIDO` = lo leí/ejecuté hoy. `DERIVADO` = inferido, con el
razonamiento a la vista.

---

## 1 · Context Map

| Archivo leído | Por qué | Qué extraje |
|---|---|---|
| `wasiai-facilitator/src/core/supported.ts:1-193` | AC-1 | La respuesta se arma SÓLO de `chainRegistry.listAdapters()` (`:136`). Y el patrón "exactamente uno de dos campos" + el porqué de una razón de ausencia (`:44-92`), que es el molde del tri-estado. |
| `wasiai-facilitator/src/routes/supported.ts:1-68` | AC-7/CD-4 | Sin `schema` en las opciones de ruta (`:32-41`) ⟹ no hay serializador que pode campos nuevos (MEDIDO). Build explícito campo por campo (`:62-65`, CD-2 de esa HU). Sin auth (`:4`). |
| `wasiai-facilitator/src/app.ts:410-426` | DT-1 | Las TRES rutas dedicadas se registran bajo gate propio: `isSponsorEnabled()` (`:411`), `isReleaseEnabled()` (`:416`), `isSolanaPayoutEnabled()` (`:422`). `supportedRoute` se registra DESPUÉS (`:425`). |
| `wasiai-facilitator/src/infra/solana-payout-operator.ts:157` | DT-1 | Ahí vive `isSolanaPayoutEnabled()`, en `infra/` — y `core/supported.ts` tiene PROHIBIDO importar `../infra/*` (su docblock `:23`). Por eso la señal se inyecta, no se importa. |
| `wasiai-facilitator/src/routes/solana-payout.ts:14-25,259-262` | AC-3 | Ruta = `POST /solana/payout` (`:260`). Orden de gates: `1 auth 2 Zod … 9 CLAIM` (`:19-25`) ⟹ auth es lo PRIMERO y la ruta ausente ni llega a auth. |
| `wasiai-facilitator/src/chains/solana-adapter.ts:138` | Decisión 3 | `supportedMethods: [SPL_TOKEN_TRANSFER_FINALIZED]` — el riel TESTIGO. Ningún método menciona payout. |
| `wasiai-a2a/src/adapters/solana/facilitator-settle.ts:1-301` | AC-2/3/4/6 | El guard actual (`:162-174`) y su propio "lo que NO prueba" (`:149-156`). El techo de 30 s (`:40`). La rama sin URL que lanza `'not-sent'` sin hacer fetch (`:203-209`). Los 4 pasos de clasificación (`:230-288`). |
| `wasiai-a2a/src/adapters/solana/schema-preflight.ts:1-285` | Decisión 1 | EL EXEMPLAR. Veredicto memoizado tri-estado + single-flight (`:240-275`), TTL sólo del negativo (`:69-70,228-239`), enforcement PEREZOSO en el money-path y warm-up de arranque fire-and-forget (`:33-50,277-285`), y las tres razones con su acción (`:72-91`). |
| `wasiai-a2a/src/index.ts:83,327,338,345` | Decisión 1(a) | El único I/O de red del arranque es POST-`listen()` y fire-and-forget, con el motivo escrito (`:329-345`). |
| `wasiai-a2a/railway.json:6-10` vs `wasiai-facilitator/railway.json:6-12` | Decisión 1(b) | a2a: `restartPolicyType: ON_FAILURE` SIN `restartPolicyMaxRetries`; el facilitator SÍ lo tiene (`3`). Y a2a tiene `healthcheckPath:"/"` + `healthcheckTimeout:60`. |
| `wasiai-a2a/src/adapters/solana/payment.ts:409-470,895-1075` | CD-3/AC-6 | El reclamo atómico es la puerta única al broadcast (`:419-445`); la bandera se lee UNA vez y DESPUÉS del reclamo (`:448-455`); `settleViaFacilitator` corre con el intent YA reclamado (`:1011-1020`). |
| `wasiai-a2a/scripts/smoke-downstream-x402.mjs:60-90,225-375`, `scripts/hackathon-e2e.mjs:133-147` | AC-7 | Los ÚNICOS consumidores medidos de `/supported`. Leen `chains`, `chain.methods` con `.includes`, y `breakerState`/`breakerStateAbsentReason`. Cero igualdad profunda, cero enumeración de claves. |
| `wasiai-facilitator/node_modules/fastify/types/instance.d.ts:207-211` (fastify 5.8.5) | DT-2 | `hasRoute({method,url}): boolean` existe. |
| `vitest.config.ts` de los dos repos | Plan de tests | facilitator: `include: ['src/**/*.test.ts']` únicamente. a2a: `src/**/*.test.ts` + `test/**/*.test.ts` + `.test.mjs`. |

---

## 2 · Tres hallazgos que CORRIGEN el work-item (antes de decidir nada)

**H-1 — `/supported` no "anuncia" hoy la capacidad de payout: es MUDO sobre ella. MEDIDO
(facilitator@b896228).** El único método que declara la entrada Solana es
`spl-token-transfer-finalized` (`chains/solana-adapter.ts:138`), que es el riel de `/verify`+`/settle`
donde el facilitator es TESTIGO, no emisor — está escrito en `core/supported.ts:63-65`. Y `:69-70`
lo dice sin ambigüedad: «Las rutas Solana que SÍ transmiten (payout/sponsor/release) no son
adaptadores, no salen en `/supported`». **Consecuencia directa: "filtrar `methods`" no filtra nada
— no existe el string que habría que sacar.** El defecto real es la SILENCIO: un consumidor no
puede saber por `/supported` si el riel de tesorería está vivo, y el gateway tuvo que adivinarlo
con un POST a 404 mudo. Esto tumba la mitad de la Decisión 3 y también la trampa de orden de
despliegue que se me planteó (ver §5).

**H-2 — Cero consumidores de `/supported` en el runtime de nuestros repos. MEDIDO 2026-08-09.**
`command grep -rn "/supported"` sobre `wasiai-a2a/src` → 0 (el único hit, `kite-ozone/gasless.ts:27`,
es `/supported_tokens` de otro servicio). Sobre todo `wasiai-v2` (ts/tsx/mjs/js, sin `node_modules`)
→ 0 reales. Sobre `wasiai-sdk`, `chaski-v3`, `wasiai-monitor`, `wasiai-cli` → 0. Los únicos dos
consumidores son scripts de a2a: `scripts/smoke-downstream-x402.mjs:337` y
`scripts/hackathon-e2e.mjs:133`. **El docblock `supported.ts:5-6` ("wasiai-v2, wasiai-a2a,
third-party") es aspiracional para v2.** Terceros: NO MEDIBLE ⟹ aditivo obligatorio igual (CD-4).

**H-3 — `scripts/hackathon-e2e.mjs:135` ya lee un campo que no existe** (`supported.body?.kinds`,
cuando la respuesta trae `chains`/`methods`): ese chequeo está muerto hoy y no puede romperse
con nada. MEDIDO.

---

## 3 · Decisiones técnicas

### DT-1 · La señal de mitad A sale del ROUTER VIVO, no de re-evaluar la bandera
`routes/supported.ts` pregunta `app.hasRoute({ method: 'POST', url: '/solana/payout' })` **dentro
del handler**. Cumple DT-1 del work-item mejor que leer `isSolanaPayoutEnabled()` de nuevo: no
puede desincronizarse del `if` de `app.ts:422` porque no es una condición paralela, es el efecto.
Además `core/supported.ts` NO PUEDE importar `infra/*` (su docblock `:20-24`), así que leer el
booleano allí era ilegal de entrada.
⚠️ **DENTRO DEL HANDLER, nunca en el cuerpo del plugin**: `app.register(solanaPayoutRoute)` está
en `app.ts:423` y `app.register(supportedRoute)` en `:425`; el registro de plugins es diferido
hasta `ready()`, así que en el cuerpo del plugin la ruta puede no estar todavía en el router.
En request-time ya está. Esto además preserva la propiedad "live snapshot" (DT-3 de WFAC-22).
`hasRoute` en una instancia hija resolviendo contra el router compartido: **DERIVADO** — lo cierra
el test T-A2 (§7), que lo mide con `app.inject()` sobre la app real.

### DT-2 · Mitad A es ADITIVA: un campo top-level `dedicatedRoutes: readonly string[]`
Por H-1 no hay nada que filtrar. Forma: lista de strings `"POST /solana/payout"` derivada del
router vivo, sobre una tabla explícita de las tres rutas opt-in (`/solana/payout`,
`/solana/sponsor`, `/solana/escrow/release` — paths MEDIDOS en `solana-payout.ts:260`,
`solana-sponsor.ts:217`, `solana-escrow.ts:201`). Se incluyen las tres porque comparten
EXACTAMENTE el mismo mecanismo de invisibilidad (`app.ts:411,416,422`): dejar dos afuera deja la
misma mina armada para el próximo.
**Por qué una lista y no un booleano ni un par de campos**: una lista da el tri-estado gratis y sin
inventar un enum — campo ausente = *no sé* (facilitator viejo), presente y contiene = *existe*,
presente y no contiene = *no existe*. `[]` es una RESPUESTA, no una ausencia. Es el mismo
razonamiento de `breakerStateAbsentReason` (`core/supported.ts:72-76`), donde ya está escrito que
"no viene ninguno de los dos" significa "facilitator anterior al cambio".
**Lo que el campo NO dice**: que un payout vaya a salir bien (fondeo, topes, caps). Dice que el
TRANSPORTE existe. Sin esa frase el campo se lee como un semáforo verde de dinero.
**A quién rompe: a nadie medido.** No se quita ni se renombra nada; `routes/supported.ts` no
declara `schema` (`:32-41`) así que ningún serializador poda; los dos consumidores medidos leen
campos por nombre y jamás enumeran claves (§1). El único archivo que hay que tocar por esto es el
test propio del endpoint, que sí afirma la forma top-level exacta (T-R1,
`src/__tests__/unit/routes.supported.test.ts:15`) — está en Scope IN.

### DT-3 · Publicar qué rutas dedicadas están vivas en un endpoint SIN AUTH: el delta es COSTO DE DESCUBRIMIENTO, no un bit nuevo
⚠️ **CORREGIDO por AR MNR-1 — la frase original de este título decía "no agrega información" y
afirmaba de más.** La afirmación correcta y falsable es más angosta:

> No agrega **ningún bit que un atacante que YA conoce el path** no pueda obtener solo.

Eso sigue siendo cierto y medido: el orden de gates (`solana-payout.ts:19-25`) pone `auth`
PRIMERO, y una ruta no registrada ni llega a auth ⟹ un único POST vacío ya distingue `401`
(existe) de `404` (no existe), sin credencial. No hay bypass y `/supported` no tiene auth
(`routes/supported.ts:4`).

**Lo que SÍ cambia, y la frase vieja lo tapaba:** los tres paths de tesorería **nunca estuvieron
publicados** en `doc/openapi.yaml` (documenta 4 paths: `/verify`, `/settle`, `/supported`,
`/health`). Así que hasta esta HU un atacante tenía que **adivinar los paths**; ahora
`GET /supported` sin credencial le entrega método+path de las tres **y cuáles están habilitadas en
esta instancia**. El delta real es entonces **costo de descubrimiento** (de adivinar a leer) y
**fingerprinting por instancia** (qué capacidades tiene ESTE facilitator), no confidencialidad de
un secreto. Los nombres son de baja entropía y adivinables, así que el delta es chico — pero no es
cero, y decir "no agrega información" apaga justo la revisión que lo habría notado.

### DT-4 · 🔴 TIMING (Decisión 1): **las dos, con consecuencias asimétricas.** Arranque = SEÑAL. Primer uso = GATE.
Es el molde exacto de `schema-preflight.ts`, y no lo elegí por analogía sino porque las
mediciones cierran las dos preguntas que me pidieron:

**(a) ¿El arranque de a2a tolera una llamada de red? Sí, y hay precedente — pero de una FORMA
concreta. MEDIDO (`src/index.ts`, a2a@568cf40).** Hay exactamente dos I/O de red en el arranque:
`warmEscrowSchemaPreflight()` (`:338`) y `warmSolanaSchemaPreflight()` (`:345`). Las dos están
**DESPUÉS** de `await fastify.listen()` (`:327`) y las dos son **fire-and-forget**, con el motivo
escrito en el propio archivo (`:334-337`): «un blip de red contra la DB no debe impedir que el
servicio levante y sirva discover/compose/orchestrate». O sea: introducir I/O de red en el
arranque **no es** una decisión nueva de arquitectura; introducir I/O **BLOQUEANTE** sí lo sería,
y sería el primero. No lo voy a colar.

**(b) ¿Railway reinicia si el arranque falla? Sí, y en a2a SIN techo declarado. MEDIDO.**
`wasiai-a2a/railway.json:10` trae `"restartPolicyType": "ON_FAILURE"` y **no** trae
`restartPolicyMaxRetries` — mientras que `wasiai-facilitator/railway.json:11-12` sí lo trae (`3`).
Cuántos reintentos aplica Railway cuando el campo falta: **NO MEDIBLE desde el repo** (es un
default del proveedor). DERIVADO, y la asimetría es lo que decide: a2a es justamente el repo que
NO declaró techo, así que un arranque que dependa del vecino es un bucle de reinicios cuya cota
no controlamos. Segundo dato en la misma dirección: `healthcheckPath:"/"` con
`healthcheckTimeout:60` (`:8-9`) contra un techo de 30 s por llamada
(`facilitator-settle.ts:40`) ⟹ un sondeo bloqueante se come la mitad del presupuesto del
healthcheck y un despliegue puede no promoverse por un blip del facilitator.

**Conclusión (coincide con la recomendación que me dieron, y la refuerzo con lo de arriba):**
- El **arranque NUNCA falla por el sondeo**. El único fallo de arranque sigue siendo el de HOY:
  bandera en `'true'` + sin URL — configuración imposible sin red, `assertFacilitatorPayoutConfigured`
  (`facilitator-settle.ts:162-174`) queda **intacta**, es piso y no se reemplaza (AC-2).
- El sondeo **se dispara al arrancar** igual, fire-and-forget, para que la alarma suene ahí y no
  en medio de una transferencia. Eso responde AC-2 y mata la objeción "sólo al primer uso no da
  señal en el arranque".
- El **gate real es perezoso**, en el primer uso, y **comparte el MISMO veredicto memoizado**: el
  warm-up no puede divergir del gate (el argumento textual de `schema-preflight.ts:47-50`). Eso
  mata la otra objeción, "sólo al arranque queda stale".
- **TTL**: el veredicto positivo **NO se cachea para siempre** — acá me aparto del exemplar y digo
  por qué: en el preflight de esquema el sujeto es NUESTRA base y revertir una migración viene con
  un restart nuestro (`schema-preflight.ts:233-235`); acá el sujeto es OTRO servicio que
  redespliega solo, que es literalmente el "queda stale" del work-item. Positivo: 300 s.
  Negativo: 60 s (bloquea legs; tiene que recuperarse rápido). Constantes en el módulo, **sin
  env nueva** (CD-1).

### DT-5 · 🔴 LOS TRES DESENLACES (Decisión 2), con nombre propio y acción propia
Unión discriminada en `facilitator-settle.ts`, **nunca un booleano**:

```
PayoutRouteVerdict =
  | { state: 'route_registered' }
  | { state: 'route_absent';   detail: string }
  | { state: 'route_unaskable'; reason: UnaskableReason; detail: string }
```

| Estado | Qué lo produce (evidencia) | Qué hace el sistema |
|---|---|---|
| `route_registered` | `GET /supported` → 200, cuerpo parseable, `dedicatedRoutes` es un array Y **contiene** `"POST /solana/payout"` | Sigue. Silencio. |
| `route_absent` | 200 + cuerpo parseable + `dedicatedRoutes` **es un array** y **no** lo contiene | **Rechaza el leg ANTES del POST**, con la MISMA forma que la rama sin URL de hoy (`facilitator-settle.ts:203-209`): `FacilitatorSettleError(..., 'not-sent')`. Al arrancar: `log.error` ruidoso. |
| `route_unaskable` | todo lo demás | **Sigue igual que hoy**: hace el POST real y deja que la clasificación de 4 pasos (`:230-288`) decida. `log.warn` ruidoso. NUNCA bloquea. |

`UnaskableReason` (cada una con su acción, molde `SolanaSchemaFailure`, `schema-preflight.ts:72-91`):
`transport_error` (DNS/refused/timeout/abort — no hubo intercambio o no volvió) · `probe_http_error`
(status ≠ 200, incluido un 404 de `/supported` mismo: eso es un proxy o un facilitator viejo) ·
`body_unreadable` (no es JSON / no es objeto) · `field_absent` (**200 sano pero `dedicatedRoutes`
no es un array** ⟹ facilitator anterior a la mitad A).

**Por qué "no sé" NO se parece a los otros dos, explícito:**
- No se parece a `route_absent` porque `route_absent` es **evidencia positiva**: el facilitator
  contestó bien y **enumeró** sus rutas dedicadas sin incluir ésta. Un timeout no enumeró nada.
- No se parece a `route_registered` porque no autoriza nada: no cambia el comportamiento de hoy,
  sólo lo deja pasar. Y se reintenta a los 60 s en vez de quedar pegado.
- **Y por qué "no sé" DEJA PASAR en vez de bloquear** (que es la pregunta incómoda): bloquear con
  "no sé" convierte un blip del vecino en un corte de pagos nuestro autoinfligido, con el
  facilitator posiblemente sano. Y el costo de dejar pasar está ACOTADO y no es un doble pago: el
  POST real hereda intacta la clasificación de HU-201, donde un 404 mudo cae en `'unknown'` (o sea:
  ni refund ni re-envío, revisión humana). O sea que el peor caso de `route_unaskable` es
  exactamente el comportamiento de hoy, no uno peor. La asimetría de costos manda en la dirección
  contraria a la del preflight de esquema, y por eso la decisión es la contraria — ahí no medir
  habilitaba un **segundo pago irreversible** (`schema-preflight.ts:148-160`); acá no medir sólo
  posterga una determinación.

### DT-6 · Qué cuenta como "definitivo" (el 2º NEEDS CLARIFICATION del work-item): CERRADO SIN REINTENTOS
El work-item temía declarar "no existe" por un 404, porque un 404 puede venir de un proxy
(`facilitator-settle.ts:150-156`). **Con el sondeo apuntando a `GET /supported` ese miedo
desaparece y no hacen falta N reintentos**: la determinación negativa NO se lee de un status code,
se lee de un **200 sano con la lista enumerada**. Un proxy que devuelve 404 cae en
`probe_http_error` (= no sé), no en `route_absent`. Un facilitator viejo cae en `field_absent`
(= no sé). Sólo el facilitator real, contestando bien, puede decir "no la tengo".
**Esto es lo que hace que las dos mitades de la HU sean una sola HU** y no dos sueltas.

### DT-7 · El sondeo es `GET /supported`, NO un `POST /solana/payout` de prueba
Descartado a propósito el POST-sonda: aunque el orden de gates lo rechazaría en Zod (gate 2) mucho
antes del CLAIM (gate 9) y no gastaría (`solana-payout.ts:19-25`), sería **un POST no autenticado
o autenticado contra una ruta de TESORERÍA en cada arranque**, con ruido en el audit log y con un
riesgo que depende de que ese orden de gates no cambie nunca. El GET es read-only, sin auth, sin
efectos (`routes/supported.ts:4`) y su respuesta es la verdad derivada del router del otro lado.

### DT-8 · Timeout propio y **NO** reuso de `classifySettleTransportError` — desvío explícito de DT-2 del work-item
El work-item pedía reusar el timeout y la clasificación de `payoutViaFacilitator`
(`facilitator-settle.ts:230-239`) "para no inventar una segunda taxonomía de no-pude-preguntar".
**Reuso el criterio, no la función, y el motivo es que clasifican cosas distintas.**
`classifySettleTransportError` (`src/adapters/errors.ts:296-313`, con `NOT_SENT_CAUSE_CODES` en
`:196-201`: `ENOTFOUND`, `EAI_AGAIN`, `ECONNREFUSED`, `ERR_INVALID_URL`) decide la **disposición
del VALOR** entre `'not-sent'` y `'unknown'`. El sondeo **no manda valor**: para él todo fallo de
transporte es lo mismo (`transport_error`) y `'not-sent'` sería trivialmente cierto en los tres
desenlaces, o sea información cero. Aplicarla ahí sería una analogía que confunde askability con
disposición de dinero. Timeout propio: **5 s**, no los 30 s de `:40` — ese techo es "el mismo
wall-clock que el hop del facilitator EVM", pensado para un request que FIRMA Y TRANSMITE; un GET
de discovery que tarda más de 5 s ya es un "no pude preguntar", y el gate perezoso no puede sumar
30 s de latencia a un leg de dinero en un cache miss.

### DT-9 · Dónde se enforcea en a2a: dentro de `payoutViaFacilitator`, **no** en `payment.ts`
El gate perezoso va como paso 0 de `payoutViaFacilitator`, después del chequeo de URL
(`:203-209`) y antes del `fetch` (`:219`). **Por qué no en `settle()` al lado del preflight de
esquema (`payment.ts:422`), que sería más temprano y evitaría gastar el reclamo**: porque eso
exigiría leer `SOLANA_SETTLE_VIA_FACILITATOR` **antes** del reclamo atómico, y ese orden es un
contrato escrito y justificado (`payment.ts:448-455`: una sola lectura por invocación, y después
del reclamo porque «el reclamo es función de la INTENCIÓN, no de quien transmite»). Tocar eso es
reordenar el money-path por una mejora de latencia, con `payment.ts` fuera del Scope IN. **Costo
aceptado y declarado**: con `route_absent` el intent queda reclamado antes del rechazo — igual que
hoy con la rama sin URL, no peor.

### DT-10 · Consecuencia observable del cambio, dicha en voz alta
Hoy, bandera ON + ruta 404 ⟹ el leg muere `'unknown'` (paso 3, código ausente) ⟹ ni refund ni
re-envío, queda para revisión humana. Después de esta HU, ese mismo escenario da `route_absent`
⟹ `'not-sent'` ⟹ **sí** dispara refund al buyer y/o re-envío del hop. Es correcto (el POST no se
hizo) y es mejor (una disposición definida en vez de una incógnita), **pero es un cambio de
comportamiento en un camino de dinero** y no puede quedar tácito: es exactamente el tipo de
mejora que hay que poder ver. Sólo alcanza al riel Solana-vía-facilitator, hoy apagado
(DERIVADO — ver §"Estado de la bandera" del work-item; ningún endpoint expone ese valor).

---

## 4 · Constraint Directives

Heredados del work-item, **vigentes tal cual**: **CD-1** (prohibido prender/apagar/modificar
cualquier env de payout — y esta HU tampoco INTRODUCE una env nueva), **CD-2** (EVM byte-idéntico),
**CD-3** (prohibido fabricar un estado terminal de pago desde el sondeo), **CD-4** (`/supported`
sólo cambia de forma aditiva y con consumidores documentados — §2 H-2 y DT-2).

- **CD-5 — PROHIBIDO colapsar los tres desenlaces en un booleano o en un `boolean | undefined`.**
  El tipo de retorno del sondeo es la unión discriminada de DT-5. Un `Promise<boolean>` en la firma
  es BLOQUEANTE en AR. Referencia: `no-pude-preguntar-no-es-no` — «toda consulta externa tiene TRES
  valores; un `boolean` ya perdió el tercero».
- **CD-6 — PROHIBIDO que el sondeo pueda fallar, retrasar o bloquear el arranque.** Sin `await` en
  el camino de boot, sin `throw` que escape, y el `catch` no puede convertirse en `process.exit`.
  El único fallo de arranque sigue siendo `assertFacilitatorPayoutConfigured`, que no se toca.
- **CD-7 — PROHIBIDO leer la ausencia de `dedicatedRoutes` como "la ruta no está".** El
  discriminante es `Array.isArray(...)`, nunca truthiness ni `.length`. Un `[]` es una respuesta.
- **CD-8 — PROHIBIDO inventar una disposición de valor nueva.** El rechazo por `route_absent` usa
  la MISMA construcción que `facilitator-settle.ts:203-209` (`FacilitatorSettleError`, `'not-sent'`).
  Nada de tocar `PAYOUT_NO_SPEND_CODES` ni agregarle códigos (CD-3, HU-201).
- **CD-9 — PROHIBIDO leer el router en el cuerpo del plugin de `/supported`.** La señal se computa
  dentro del handler (DT-1). Un `hasRoute` en el cuerpo del plugin puede dar `false` por orden de
  registro y publicaría una mentira estable.
- **CD-10 — PROHIBIDO que `getSupportedResponse()` pierda su pureza** (`core/supported.ts:26-28`):
  cero I/O, cero logger, cero import nuevo de `infra/*`/`routes/*`. La señal entra por parámetro.
  Y el parámetro es **requerido**, no opcional: un llamador que se olvide debe ser un error de
  compilación, no una ausencia silenciosa.
- **CD-11 — el campo nuevo se agrega EXPLÍCITAMENTE en el build campo por campo de
  `routes/supported.ts:62-65`.** Ese build existe justamente para que un refactor no filtre campos
  (CD-2 de WFAC-22); un `...response` lo rompe.
- **CD-12 (del auto-blindaje histórico) — cada frase nueva de docblock tiene que ser falsable con
  un input concreto.** Leído `doc/sdd/_INDEX.md` + los `auto-blindaje.md` de las últimas HUs DONE
  (WKH-333/046, WKH-332, WKH-326): el patrón recurrente ≥2 no es un bug de lógica, es **prosa que
  afirma de más y apaga la revisión que la habría cazado** (memoria `prosa-que-afirma-de-mas`), y
  su primo, **un número o estado medido sin la fecha/commit al lado** (seis veces en la HU
  anterior). Ninguna afirmación de este SDD ni de los docblocks nuevos puede quedar sin su
  `MEDIDO@fecha` / `DERIVADO`.

---

## 5 · Waves y **orden entre repos**

**Orden seguro: mitad A (facilitator) PRIMERO, mitad B (gateway) DESPUÉS. Y el argumento no es
de riesgo, porque ningún orden rompe nada — es de que el otro orden deja la HU INERTE.**

La trampa que me plantearon ("si A va primero, `/supported` deja de anunciar el método y el
gateway no se enteraría") **no aplica a este diseño, y la medición es la razón**: por H-1 no hay
método que dejar de anunciar y por DT-2 A **no quita nada**, sólo agrega un campo. Los dos órdenes,
medidos contra los consumidores reales:
- **A primero**: el campo aparece; nadie en producción lo lee (§2 H-2), los dos scripts leen
  campos por nombre y lo ignoran. Efecto observable: **cero**.
- **B primero**: el gateway sondea un facilitator sin el campo ⟹ `field_absent` ⟹
  `route_unaskable` ⟹ POST real ⟹ comportamiento **idéntico al de hoy**. Efecto observable: cero,
  **pero el guard de esta HU queda inerte hasta que A despliegue** — y un F4 que midiera en esa
  ventana registraría un "funciona" falso. Ése es el motivo real del orden.

| Wave | Repo | Archivos exactos | Serial/paralelo |
|---|---|---|---|
| **W0** | facilitator | `src/core/supported.ts` — tipo `DedicatedRouteId`, campo `dedicatedRoutes` en `SupportedResponse`, parámetro **requerido** en `getSupportedResponse()`, docblock del tri-estado (CD-7, CD-10) | SERIAL (contrato) |
| **W1** | facilitator | `src/routes/supported.ts` — tabla de las 3 rutas candidatas + `app.hasRoute` en el handler + campo en el build explícito (CD-9, CD-11). Y `src/__tests__/unit/chains/solana-adapter.test.ts:454-460` (2º llamador de `getSupportedResponse`) al nuevo parámetro | tras W0 |
| **W2** | facilitator | `src/__tests__/unit/routes.supported.test.ts` — T-A1…T-A4 (§7) | ‖ con W3 |
| **W3** | a2a | `src/adapters/solana/facilitator-settle.ts` — `PayoutRouteVerdict`, `probePayoutRoute()`, `ensurePayoutRouteReady()` memoizado single-flight con TTL doble, `warmPayoutRoutePreflight()`, `_resetPayoutRoutePreflight()` (test-only), y el paso 0 de `payoutViaFacilitator` (DT-9). `assertFacilitatorPayoutConfigured` **sin tocar** | tras W1 desplegada |
| **W4** | a2a | `src/index.ts` — UNA línea: `warmPayoutRoutePreflight();` junto a `:338`/`:345`, **después** de `fastify.listen()`. Llamada incondicional: el criterio (`=== 'true'`) vive DENTRO del módulo que ya es dueño de esos nombres de env, no en el call-site (motivo textual en `adapters/registry.ts:135-138`) — **se aparta** del gateo en el call-site de `:338`/`:345`, y ésta es la razón | tras W3 |
| **W5** | a2a | `src/adapters/solana/facilitator-settle.test.ts` (+ el wiring estático de T-B7) — T-B1…T-B7 | tras W4 |

**Extensión de Scope IN declarada** (el work-item listaba sólo `facilitator-settle.ts` + tests para
a2a): `src/index.ts` entra por AC-2 ("SHALL sondear **cuando el gateway arranca**") — sin una línea
en el arranque no hay señal de arranque. Una línea, post-`listen`, fire-and-forget. `payment.ts`
**no** entra (DT-9). `src/adapters/registry.ts` **no** entra.

---

## 6 · Exemplars verificados (`Read`/`Glob` hoy, 2026-08-09)

| Patrón que hay que copiar | Path real y rango | Qué copiar exactamente |
|---|---|---|
| Veredicto tri-estado memoizado + single-flight + TTL sólo del negativo + warm-up separado del gate | `wasiai-a2a/src/adapters/solana/schema-preflight.ts:69-70, 80-95, 122-137, 210-285` | La forma completa. `_cached`/`_cachedAt`/`_inFlight`, el `_reset*` test-only, el `warm*` con `void … .catch(()=>{})`, y el `log.error` con acción para el operador. **Ojo: acá el TTL del positivo NO es infinito — DT-4.** |
| "Exactamente uno / por qué la ausencia no es un estado" | `wasiai-facilitator/src/core/supported.ts:44-92, 173-189` | El docblock que explica que una ausencia muda es indistinguible de un facilitator viejo, y el ternario que garantiza el invariante. |
| Rechazo `'not-sent'` sin salir a la red | `wasiai-a2a/src/adapters/solana/facilitator-settle.ts:203-209` | La construcción textual del throw (CD-8). |
| Test de guard de arranque con envs salvadas/restauradas y bundle real | `wasiai-a2a/src/adapters/solana/facilitator-payout-startup-guard.test.ts:55-89, 91-216` | `ENV_KEYS`, `beforeEach/afterEach`, `_resetRegistry()`, y los grupos G-1…G-5 (incluido G-3: los truthy-pero-no-`'true'`). |
| Doble de `fetch` y helper de respuesta JSON | `wasiai-a2a/src/adapters/solana/facilitator-settle.test.ts:26-67` | `vi.spyOn(globalThis,'fetch')` + `jsonResponse(status, body)`. |
| Test de endpoint del facilitator vía `app.inject()` con registry reseteado y adapters falsos | `wasiai-facilitator/src/__tests__/unit/routes.supported.test.ts:1-60, 205-215` | El header de cobertura AC→test, los mocks de `core/audit.js` e `ioredis`, y `buildApp({...})`. |
| Test que lee CÓDIGO FUENTE como texto para probar un cableado no importable | `wasiai-a2a/test/ownership-filter-guard.scanner.ts` (+ `test/test-files-are-run-in-ci.test.ts`) | La técnica para T-B7: `src/index.ts` no se puede importar desde un test porque tiene `await initAdapters()` de nivel de módulo (dicho en `src/index.ts:246-248`). |

---

## 7 · Plan de tests — ≥1 por AC, cada uno con **el input que lo pone en rojo**

Rutas MEDIDAS de `vitest.config.ts`: en el facilitator sólo corre `src/**/*.test.ts` ⟹ **el
`test/routes/supported.test.ts` que sugería el Scope IN no lo correría nadie**; va en
`src/__tests__/unit/routes.supported.test.ts`. En a2a corren `src/**` y `test/**`.

| ID | AC | Qué afirma | Input que lo pone en ROJO |
|---|---|---|---|
| **T-A1** | AC-1 | App real con el gate de payout SATISFECHO ⟹ `GET /supported` trae `"POST /solana/payout"` en `dedicatedRoutes` | Volver a derivar el campo de `chainRegistry`/`supportedMethods` en vez del router: la ruta está registrada y el campo no la lista ⟹ rojo. |
| **T-A2** | AC-1 | App real con el gate NO satisfecho (ruta no registrada) ⟹ el campo existe, es array, y **no** contiene el payout; y un `POST /solana/payout` en la misma app da 404 | Hardcodear el string en la lista ⟹ rojo. También cae en rojo si `hasRoute` no atraviesa la encapsulación del plugin (cierra el DERIVADO de DT-1). |
| **T-A3** | AC-7/CD-4 | La respuesta conserva `chains` y `methods` con la MISMA forma y valores que antes (incluido el invariante exactamente-uno-de-`breakerState`/`breakerStateAbsentReason`), y `methods` **no** gana ningún string de payout | Filtrar o renombrar cualquier cosa de `methods`/`chains` ⟹ rojo. Es el candado de "aditivo". |
| **T-A4** | AC-1/CD-10 | `getSupportedResponse()` sigue siendo pura: mismo parámetro ⟹ misma respuesta, y llamarla dos veces no hace I/O | Volver el parámetro opcional con default ⟹ rojo (el test lo llama sin argumento y espera error de tipo/compilación en `tsc --noEmit`). |
| **T-B1** | AC-2 | Con bandera ON + URL, el arranque **dispara** el sondeo: `warmPayoutRoutePreflight()` hace exactamente UN `GET {url}/supported` | Borrar la llamada del warm-up ⟹ `fetchSpy` con 0 llamadas ⟹ rojo. |
| **T-B2** | AC-2/AC-3 | `dedicatedRoutes` **contiene** la ruta ⟹ `payoutViaFacilitator` hace el POST y devuelve la firma | Que el gate rechace con el veredicto positivo ⟹ rojo. |
| **T-B3** | **AC-3** | `dedicatedRoutes` presente y **sin** la ruta ⟹ el leg se rechaza **antes** del POST: `readSettleValueDisposition(err) === 'not-sent'` **y** `fetch` fue llamado UNA sola vez (el sondeo) y **nunca** contra `/solana/payout` | Doble que devuelve 200 con `dedicatedRoutes: []`. Si el gate no existe o deja pasar, aparece el segundo `fetch` al POST ⟹ rojo. |
| **T-B4** | **AC-4 (i)** | **"NO PUDE PREGUNTAR" — el doble RECHAZA**: `fetchSpy.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { cause: { code: 'ETIMEDOUT' } }))` en el sondeo ⟹ veredicto `route_unaskable/transport_error`, **el POST SÍ se hace**, y el resultado del leg lo decide la respuesta real (no el sondeo) | Colapsar el fallo del sondeo en `route_absent` ⟹ no hay POST ⟹ rojo. **Prohibido escribir este caso con un doble que devuelva 404** (ése es T-B5). |
| **T-B5** | **AC-4 (ii)** | Sondeo con **200 sano pero SIN `dedicatedRoutes`** (facilitator viejo) ⟹ `route_unaskable/field_absent`, el POST se hace igual | Leer la ausencia como "no está" (violar CD-7) ⟹ el leg se rechaza sin POST ⟹ rojo. Variante en la misma tabla: `dedicatedRoutes: []` **debe** dar `route_absent` (T-B3) — el par `[]` vs ausente es lo que distingue los dos tests. |
| **T-B6** | AC-4 | Sondeo que devuelve **404 sobre `/supported`** y sondeo con **cuerpo no-JSON** ⟹ `probe_http_error` / `body_unreadable`, los dos `route_unaskable` | Mapear el 404 del sondeo a `route_absent` ⟹ rojo. Es el candado explícito de DT-6 contra el proxy intermedio. |
| **T-B7** | AC-2 | **Cableado**: `src/index.ts` contiene la llamada al warm-up, DESPUÉS de `fastify.listen(` (comparación de índices sobre el texto del archivo) y sin `await` delante | Mover la llamada arriba de `listen` o ponerle `await` ⟹ rojo (CD-6). Sin este test el warm-up podría no estar cableado y todo lo demás daría verde — «tests que registran el doble a mano NO prueban el cableado». |
| **T-B8** | **AC-5** | Bandera ausente / `'false'` / `'TRUE'` / `'1'` / `'yes'` / `''` ⟹ `warmPayoutRoutePreflight()` y el gate **no hacen NI UN `fetch`**, y `payoutViaFacilitator` no cambia | `Boolean(process.env.X)` en vez de `=== 'true'` ⟹ los 5 valores salen a la red ⟹ rojo. Mismo grupo que G-3 del exemplar. |
| **T-B9** | AC-5 | Las suites EVM existentes pasan **sin editar su semántica** (`payment.test.ts`, `payment.flag.test.ts`, `intent-dedup.test.ts`, `settle-wiring.test.ts` y las de Kite/Avalanche/Base) | Cualquier cambio en el camino EVM. **No se toca ninguna de estas suites**: si una hay que editarla, es señal de violación de CD-2 y va al AR. |
| **T-B10** | AC-6/CD-3 | `PAYOUT_NO_SPEND_CODES` sigue idéntico (comparación de conjunto), el sondeo **no** agrega códigos, y ningún veredicto del sondeo produce `success:true/false` sintético | Meter un código nuevo o devolver un `SettleResult` desde el gate ⟹ rojo. |
| **T-B11** | DT-4 | Memoización: 3 llamadas concurrentes al gate ⟹ **un** solo `GET /supported` (single-flight); un `route_absent` se re-sondea después de la ventana negativa y un `route_registered` después de la positiva (relojes con `vi.useFakeTimers`) | Cachear el positivo para siempre ⟹ el re-sondeo no ocurre ⟹ rojo (es el "queda stale" del work-item, hecho test). |

Además, obligatorio antes de cerrar: `tsc --noEmit` **completo** en los dos repos (lección
WKH-196), y `npm test` completo en a2a (que corre `test/test-files-are-run-in-ci.test.ts` y
`test/docs-referenced-by-code-exist.test.ts`: si un docblock nuevo cita un path de `doc/`, ese
path tiene que existir).

---

## 8 · Readiness Check

- [x] Los 7 ACs tienen ≥1 test con su input rojo (AC-1→T-A1/A2/A4; AC-2→T-B1/B7; AC-3→T-B3;
      AC-4→T-B4/B5/B6; AC-5→T-B8/B9; AC-6→T-B10; AC-7→T-A3).
- [x] Los tres desenlaces tienen nombre propio, acción propia y **tres tests distintos**, y el de
      "no pude preguntar" usa un doble que **rechaza** (T-B4), no uno que devuelve 404 (T-B6).
- [x] Los 3 `[NEEDS CLARIFICATION]` del work-item quedan CERRADOS: timing → DT-4; "definitivo" →
      DT-6; mecanismo en `/supported` → DT-2.
- [x] Todos los paths de exemplar verificados con `Read` hoy; la ruta de test del facilitator que
      sugería el work-item **corregida** (no la correría vitest).
- [x] CD-1 respetada: ni se toca ni se propone tocar ninguna env, y la HU **no introduce ninguna
      nueva** (los TTLs y el timeout son constantes de módulo).
- [x] Orden de despliegue decidido con su razón, y la trampa planteada refutada con medición (§5).
- [ ] **Abierto y NO bloqueante — `[NEEDS CLARIFICATION-1]`**: el valor real de
      `SOLANA_SETTLE_VIA_FACILITATOR` en producción sigue siendo **DERIVADO**, no medido (ningún
      endpoint lo expone). No bloquea: todo se valida con la bandera simulada en tests (CD-1).
      Si alguien quiere medirlo, es una HU aparte (exponerlo en `/health` o `/capabilities`).
- [ ] **Abierto y NO bloqueante — `[NEEDS CLARIFICATION-2]`**: publicar en un endpoint sin auth
      qué rutas de tesorería están vivas (DT-3). Mi lectura MEDIDA —corregida por AR MNR-1— es que
      no agrega ningún bit que un atacante que ya conoce el path no tenga (un POST vacío ya
      distingue 401 de 404), pero **sí** baja el costo de descubrimiento y habilita fingerprinting
      por instancia, porque los tres paths nunca estuvieron en el openapi. Es una decisión de
      exposición pública y
      **queda marcada para que AR la ataque explícitamente** en vez de pasar tácita. Si AR la
      considera BLOQUEANTE, la variante mínima es publicar sólo `"POST /solana/payout"` y no las
      otras dos, o mover el campo detrás de la auth que `/supported` hoy no tiene (eso último sí
      rompería CD-4 y sería otra HU).
