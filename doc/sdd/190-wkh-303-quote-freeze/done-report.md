# Done Report — WKH-303 Congelar el precio de la cotización (quote freeze)

**Status**: DONE
**Fecha**: 2026-07-29
**Rama**: `feat/303-quote-freeze`
**HEAD**: `e89349e`
**Tests**: 4100 passed · 19 skipped · 0 failed

---

## Qué garantiza esta HU

**El precio que una persona acepta es el que paga, aunque el mercado se mueva en el medio.**

Entre `POST /orchestrate/plan` (cotiza) y `POST /orchestrate/execute` (ejecuta y debita) hay una
ventana en la que el precio de un agente puede cambiar. Antes de esta HU, `/execute` re-resolvía el
precio **en vivo** y solo rechazaba si superaba el techo `maxQuotedCostUsdc`; si el precio se movía
pero quedaba por debajo del techo, **se cobraba el precio nuevo en silencio** — un monto que el
caller nunca aprobó.

Ahora `/plan` emite una **cotización firmada** (HMAC-SHA256, sin storage: ni tabla ni Redis) que
congela, por cada step, el **precio y la identidad del agente**, válida **10 minutos**
(`QUOTE_TTL_SECONDS = 600`, `src/services/orchestrate-quote.ts:41`). Si el cliente la reenvía en
`/execute`, se debita el precio congelado y se ejecuta el agente congelado. Beneficia sobre todo al
camino **agent-key prepago** (el que usa Chaski); x402 ya estaba protegido porque el pagador firma el
monto exacto que abona.

---

## Los tres límites de la garantía

Los tres son **decisiones**, no olvidos. Van escritos sin adornos porque cada uno cambia lo que un
integrador puede prometerle a su usuario.

### 1. La garantía se pierde si el cliente no reenvía la cotización

Omitir el campo `quote` en `/execute` es el **camino de compatibilidad hacia atrás** (AC-6 / CD-2:
ningún cliente de hoy se rompe) y devuelve al comportamiento previo: precio vivo re-resuelto contra
el techo `maxQuotedCostUsdc`, con `409 QUOTE_STALE` si lo supera. Es correcto por diseño.

Pero tiene una consecuencia que conviene decir en voz alta: **un SDK que se olvide de reenviar el
campo degrada, sin ninguna señal, a "te cobro el precio nuevo que no aprobaste"** — que es
exactamente el bug que esta HU vino a matar. El cliente no se entera, y el operador tampoco.

Por eso el fix-pack agregó un rastro: **`[orchestrate.quote.absent]`**
(`src/routes/orchestrate.ts:527`). Se emite cuando llega un `/execute` sin `quote` **y el caller era
bindeable** — es decir, cuando el cliente **podía** haber tenido garantía de precio y no la usó. Un
caller x402 nunca pudo tener quote, así que para él no se emite nada (no hay nada degradado que
reportar).

**Para qué sirve**: hoy se puede **medir** cuántas ejecuciones corren sin garantía. Es un número que
antes no existía. Si ese contador es alto, hay un SDK que actualizar, no un bug del gateway.

### 2. Con una cotización válida, `maxQuotedCostUsdc` queda inerte

**El congelado *es* el techo.** Con un quote válido, el chequeo de tope no corre: se cobra el precio
firmado, ni más ni menos. Está documentado dentro del propio ejemplo de la guía de integración
(`doc/INTEGRATION.md:333-342`, con el campo comentado en el ejemplo de request como
`"maxQuotedCostUsdc": 0.1211,  // ⚠️ IGNORED when the quote is valid`).

Importa para quien usaba ese campo como **segunda red de seguridad**: en una ejecución con
cotización, la garantía **la reemplaza**. No es que el techo se ignore por descuido — es que un techo
y un precio congelado son dos mecanismos para lo mismo, y el congelado es el más fuerte. El techo
sigue aplicando, sin cambios, cuando no se manda quote.

### 3. Una cotización se puede redimir más de una vez

Dentro de sus 10 minutos, **la misma cotización se puede redimir varias veces, y cada redención
ejecuta y cobra**. No hay tracking de "ya usada" porque eso exigiría storage durable, que fue
descartado explícitamente (AC-7 / CD-1). Es un compromiso aceptado y a la vista, no un descuido.

La frase que resume el riesgo real, ya en la guía (`doc/INTEGRATION.md:387-400`):

> **A quote is *not* an idempotency key.**

**El modo de falla concreto**: un request que sufre un timeout o una conexión cortada, y un cliente
que reintenta `POST /orchestrate/execute` con **la misma** cotización, produce una **segunda
ejecución real y un segundo cobro**. El gateway no tiene forma de distinguir ese reintento de una
segunda intención legítima.

Lo que **no** es: no es doble facturación de una misma ejecución (cada redención corre un pipeline
real y se cobra lo suyo), y no es una forma de esquivar límites (cada redención pasa igual por
presupuesto, límites diarios y topes por destino). Lo que se repite es la *garantía de precio*,
honrada dos veces.

---

## La exposición comercial, escrita para que sea decisión y no sorpresa

El AR pidió que esto quede por escrito, y con razón.

Dentro de la ventana de 10 minutos, **si el precio vivo sube, el operador absorbe la diferencia en
cada redención** — no una sola vez. Con N redenciones de la misma cotización, la diferencia se
absorbe N veces.

**No es una máquina de sacar plata**: quien llama paga el precio congelado *cada vez* y gasta su
propio presupuesto en cada ejecución; no obtiene ejecuciones gratis, obtiene ejecuciones al precio
viejo. El efecto acotado es que, por hasta 10 minutos, se pueden correr N pipelines al precio
anterior en vez de al nuevo, **y solo cuando el precio subió**.

Y ya existe la señal que lo mide: **`[orchestrate.quote.price-delta]`**
(`src/routes/orchestrate.ts:604`), que se emite en cada redención en la que el precio vivo difiere
del congelado, con `frozenUsd`, `liveUsd` y `deltaUsd`. Es decir: la exposición es **observable en
producción**, no una incógnita. Si alguna vez justifica revisar la ventana de 10 minutos o exigir
single-use, el dato para tomar esa decisión va a estar.

---

## El mutante equivalente (M18), y por qué se acepta como tal

De los 22 mutantes + 1 de control de la campaña, **M18 sobrevive**. No es un agujero: es un
**mutante equivalente**, y se verificó como tal **por separado por el AR y por el CR**.

**Qué es M18**: en `src/routes/orchestrate.ts`, relajar el guard de emisión `> 0` → `>= 0`, de modo
que `/plan` intente emitir una cotización aunque algún `costPerStep[i]` sea 0.

**Por qué no cambia nada observable**: el guard de la ruta (`src/routes/orchestrate.ts:345-347`) es
una **primera línea redundante**. Aunque se relaje y `canQuote` pase a `true`, la llamada a
`signQuote(...)` que viene inmediatamente después devuelve **`null`**, porque el módulo del quote
rechaza por su cuenta cualquier precio no congelable: `isFreezablePrice` es
`Number.isFinite(value) && value > 0` (`src/services/orchestrate-quote.ts:210`) y `signQuote` corta
con `null` en el primer step que no lo cumpla (`:241`). Con `signedQuote === null` no se emite
cotización — **exactamente el mismo resultado que sin la mutación**.

**Cómo se comprobó** (AR y CR por separado, no por lectura): se probaron `0`, `-0`, `0.0`, ceros
derivados de aritmética y el `"0"` como string. En **todos** los casos `signQuote` devolvió `null`.
El caso del string queda cubierto porque el módulo normaliza con `Number(...)` antes de evaluar
(`:250`, `:313`), y `Number("0") > 0` es falso.

**Dónde sí está candada la propiedad**: en **M9**, que muta ese mismo `> 0` → `>= 0` pero **en el
punto donde se decide** (`orchestrate-quote.ts:210`). M9 **muere**, con `T-Q-U6` y `T-Q-B7`. O sea:
"nunca se congela ni se debita un precio de $0" está probado; lo que no tiene test propio es la
redundancia de la ruta, que por definición no puede tener uno.

Se deja escrito así a propósito: **un "mutante sobreviviente" sin explicación en un reporte se lee
como un agujero**, y este no lo es.

---

## Un dato de método: el mutante de control

El Story File (§11.1) exige correr **primero** un mutante de control sobre un guard preexistente y
crítico —borrar `i > 0` del guard anti-double-charge del step-0 en `src/services/compose.ts`— para
**calibrar el instrumento** antes de creerle a los otros 22. Si el control no pone nada en rojo, el
banco de pruebas no discrimina y la campaña entera no vale.

El control se corrió y **puso tests en rojo**. El número, con su alcance explícito:

| Alcance de la medición | Tests en rojo |
|---|---|
| Los **dos archivos que nombra el §11.1** (`src/services/orchestrate.billing.test.ts` y `src/services/compose.test.ts`) | **45** |
| La **suite completa** | **60** |

Los dos números son correctos y no se contradicen: el §11.1 nombra dos archivos como asesinos
esperados, y esos dos aportan 45; los 15 restantes son otras suites que también tocan ese guard y que
el §11.1 no enumeraba. **Se escribe con el alcance a propósito**: si alguien mide la suite entera y
ve 60 contra un reporte que dijera "45" a secas, va a creer que hay una discrepancia o una
regresión. No la hay — son dos alcances distintos de la misma medición.

---

## Acceptance Criteria — resultado final

7/7 PASS, con evidencia archivo:línea (F4 APROBADO).

| AC | Qué exige | Evidencia |
|----|-----------|-----------|
| **AC-1** | `/plan` en `ready` emite quote firmado que congela identidad + precio por step, 10 min | `routes/orchestrate.ts:349-360` (emisión), `:370` (`[orchestrate.quote.issued]`); TTL en `orchestrate-quote.ts:41` (`= 600`) y `:260` (`exp = iat + QUOTE_TTL_SECONDS`) |
| **AC-2** | Con quote válido se debita el precio Y la identidad congelados, nunca los vivos | `routes/orchestrate.ts:594` (`const frozenPrice = Number(frozen.p)`) y `:607` (`prices.push(frozenPrice)`) — el `livePrice` se resuelve solo para comparar, nunca para cobrar; steps 1..N vía `frozenStepPricesUsd` en `services/compose.ts` |
| **AC-3** | Quote expirado o firma que no verifica ⇒ error distinguible, 0 débito | `orchestrate-quote.ts:391` (`QUOTE_EXPIRED`), `:352-385` (`QUOTE_INVALID`); rechazo en `routes/orchestrate.ts:505` |
| **AC-4** | Quote de otra credencial ⇒ rechazo distinguible del de expiración | `orchestrate-quote.ts:400-402` (`QUOTE_CALLER_MISMATCH`); G3a en `routes/orchestrate.ts:533-535` (un caller no bindeable no redime ningún quote) |
| **AC-5** | Agente congelado inexistente/desactivado ⇒ rechazo explícito, sin cobrar ni congelado ni vivo | `routes/orchestrate.ts:590-592` (`livePrice === null` ⇒ `QUOTE_AGENT_UNAVAILABLE`, 409) |
| **AC-6** | Sin quote ⇒ comportamiento actual byte-a-byte (precio vivo contra el techo) | Camino de back-compat en `routes/orchestrate.ts:514-530`, con el rastro `[orchestrate.quote.absent]` en `:527` |
| **AC-7** | Sin storage durable nuevo: token autocontenido, verificable solo con un secreto del servidor | `services/orchestrate-quote.ts` completo — sin import de Supabase/Redis (M13 lo canda) |

---

## Pipeline y gates

| Fase | Resultado |
|------|-----------|
| **F3** | 4100 tests (4094 al cierre de F3, +6 en el fix-pack) |
| **AR** | **APROBADO con MENORes** — 0 bloqueantes. Verificó por separado la equivalencia de M18 y pidió que la exposición comercial quedara escrita |
| **CR** | **APROBADO CON MENORES** — 0 bloqueantes. Verificó la equivalencia de M18 de forma independiente |
| **fix-pack** | 5 commits (`3e93ddd`, `ad71476`, `220f727`, `503dd36`, `e89349e`) |
| **F4 QA** | **APROBADO** — 7/7 criterios con evidencia archivo:línea |

**Conteo corrido en este cierre, no leído del reporte**: `4100 passed · 0 failed`.

### Los 5 commits del fix-pack

| Commit | Qué cerró |
|---|---|
| `3e93ddd` | No emitir una cotización que su propia verificación va a rechazar |
| `ad71476` | Anclar el techo de tamaño del token y la redimibilidad de lo emitido |
| `220f727` | El rastro `[orchestrate.quote.absent]` (límite 1) |
| `503dd36` | Documentar que el techo queda inerte y que reintentar cobra (límites 2 y 3) |
| `e89349e` | Aislar los contextos simulados por reset explícito y no por orden de declaración |

### Archivos (10)

`src/services/orchestrate-quote.ts` (nuevo, el módulo de firma/verificación) ·
`src/routes/orchestrate.ts` (emisión + redención) · `src/services/compose.ts` (freeze de steps 1..N) ·
`src/services/orchestrate.ts` · `src/types/index.ts` · `.env.example` · `doc/INTEGRATION.md` ·
más 3 archivos de tests (`orchestrate-quote.test.ts`, `orchestrate.quote-billing.test.ts`,
`orchestrate.test.ts`). Total: **2571 inserciones, 13 eliminaciones**.

---

## Nota de registro — colisión de numeración en `doc/sdd/` (NO resolver ahora)

Al consolidar los índices aparecieron dos problemas de numeración. **No se tocan en esta HU**:
renumerar directorios con cinco árboles de trabajo activos es pedir un choque de merges. Queda
anotado para que alguien lo ordene cuando el árbol esté quieto.

**1. Cuatro directorios comparten el número `190`:**

- `190-p1-guards-sin-proteccion`
- `190-wkh-303-quote-freeze` ← esta HU
- `190-wkh-305-compose-field-mapping`
- `190-wkh-306-prepago-agentes-propios`

La fila que agrega esta HU al `_INDEX.md` usa `190` y apunta al directorio por su nombre completo,
así que el link es inequívoco aunque el número esté repetido.

**2. Veintiún directorios no tienen fila en el índice.** Verificado en este cierre cruzando los
prefijos numéricos de los directorios contra los números de fila: **18 números** sin fila
(`023 024 068 089 187 188 190 191 192 193 194 195 198 201 202 203 208 209`), de los cuales `190`
aporta 4 directorios ⇒ 17 + 4 = **21 directorios**. Con la fila que agrega esta HU, el número `190`
pasa a estar representado y quedan **20 directorios** sin fila.

---

## Sincronización pendiente a `wasiai-ecosystem-docs`

Este repo tiene su `doc/` versionado, así que el reporte se escribe acá como siempre. Pero la
documentación interna se está migrando a un repositorio privado (**`wasiai-ecosystem-docs`**), de
modo que **este reporte necesita sincronizarse ahí**. No se copió desde esta HU: la sincronización es
un paso aparte, para no duplicar la fuente de verdad mientras la migración está en curso.
