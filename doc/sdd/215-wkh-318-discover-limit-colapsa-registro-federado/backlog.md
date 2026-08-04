# Backlog abierto — WKH-318

Hallazgos que el AR y el CR marcaron **explícitamente como "no lo toques ahora"**.
Quedan escritos acá para que no se pierdan al cerrar el corte A. **Ninguno se
implementó en esta HU.**

## Cómo leer esta lista

Tres de estos (**B-5, B-1, B-6**) no son mejoras: son **precondiciones del corte
B**. Los tres son caminos por los que `catalogStatus` termina en **`complete` sin
evidencia positiva**, y el corte B les monta encima un **rechazo con dinero**
(`requireCompleteCatalog: true` ⇒ 503 + reembolso). Mientras el corte A sólo
*declara*, un `complete` falso es un dato equivocado; con el corte B pasa a ser
plata que se mueve —o que no se mueve— por una afirmación sin respaldo.

| # | Qué afirma `complete` sin poder probarlo | Estado |
|---|---|---|
| **B-5** | la fuente local nunca puede reportar truncamiento | **precondición corte B** |
| **B-1** | un `?registry=` que no matchea nada devuelve catálogo "completo" vacío | **precondición corte B** |
| **B-6** | la evidencia la auto-declara la fuente que se está midiendo | **precondición corte B** |
| B-2 | `nextCursorPath` es input semi-confiable (fuerza `truncated`, lado seguro) | nota de seguridad |
| B-3 | clamp silencioso del upstream | lo cierra W3 |
| B-4 | migración de `nextCursorPath` sin aplicar | precondición de deploy |

---

## B-5 — La fuente local nunca puede reportar truncamiento

*(AR, hallazgo posterior al fix-pack — **precondición del corte B**)*

`src/services/discovery.ts:233-241`. La fila de `self-published` se construye con
`state: 'ok'` **incondicionalmente**, justificada por un **argumento de
construcción en un comentario** (`listAsAgents()` es un SELECT sin `limit` ni
cursor) en vez de por **evidencia en la respuesta**.

**Repro ejecutado por el AR**: `listAsAgents()` con **5000 filas** y
`discover({limit: 5})` ⇒ `{"catalogStatus":"complete","rows":5000}`. Con el
registro **federado**, 5000 filas sin límite ni cursor dan `unverified`; con la
**local** dan `ok`. **Dos reglas distintas para el mismo hecho** — y la HU existe
justamente para que "trajo todo" signifique una sola cosa.

Es la **tercera vez** en esta HU que la regla nueva no llega a todos lados: se
aplicó al fanout federado (W1), no llegó a la fuente local (BLQ-2), y ahora
tampoco llega a la *completitud* de esa fuente local. El patrón está anotado en
`auto-blindaje.md`.

**Lo que el revisor NO pudo determinar, y hay que resolver antes de decidir**: si
el PostgREST del deployment aplica **`db-max-rows`**, ese SELECT devuelve el tope
y manda un **`Content-Range` que nadie lee**, con lo cual el `ok` pasa a ser falso
**en silencio**. Grep sobre todo el árbol de `max_rows|max-rows|Content-Range|.range(`:
**cero hits**. O sea: hoy no hay ni lectura del header ni pineo del valor.

Tres salidas, en orden de preferencia del que escribe:
1. **darle evidencia obtenible**: leer `Content-Range` (o pedir `count`) y derivar
   `truncated`/`ok` como cualquier otra fuente;
2. **pinear y citar** `db-max-rows` en la config del deployment, y referenciar esa
   línea desde el comentario que hoy argumenta por construcción;
3. si no se hace ninguna de las dos, el estado honesto es **`unverified`**.

⚠️ **Toca tests**: mutar ese `ok` a `unverified` pone **7 tests en rojo**. Por eso
va al corte B y no se coló acá.

---

## B-1 — `?registry=` que no matchea devuelve `complete` sobre un catálogo vacío

*(AR MNR-6, ampliado — **precondición del corte B**)*

El planteo original era "un registry que no existe". **El vector real es peor y no
requiere inventar nada**: el filtro `?registry=` matchea contra el **`id`**, y la
respuesta publica **`name`**. Un caller que reusa `registries[0]` de **la propia
respuesta de la API** —lo más natural del mundo— cae en el agujero.

**Ejecutado**: devuelve `{"total":0,"catalogStatus":"complete"}` con **HTTP 200**.

Formalmente es coherente con "sin fuentes no hay nada que haya fallado"
(`T-SRC-13` fija esa regla), pero el caller pidió una fuente concreta, no la
obtuvo, y se lleva un "catálogo completo". Con el corte B, un caller estricto
**pasaría el guard** con cero agentes.

Salida sugerida: distinguir *no había a quién preguntarle* de *pediste algo que no
existe* — 400/404 en la ruta, antes que un estado de catálogo. Y de paso, decidir
si `?registry=` debe aceptar el `name` que la propia respuesta publica.

---

## B-6 — La evidencia de completitud la auto-declara la fuente que se está midiendo

*(AR, hallazgo posterior al fix-pack — **precondición del corte B**)*

`src/services/discovery.ts:827-841`. Las dos evidencias de completitud salen de la
respuesta del registro: el cursor vacío lo manda **él**, y la página que no se
llena la controla **él**. Un registro creado por cualquier caller pago puede
devolver **la página llena con `next_cursor: null`** y así **blindarse contra la
heurística `page_full`** ⇒ su fuente queda `ok` ⇒ `catalogStatus: 'complete'`.
**Ejecutado con 200 filas.**

La ironía la nombró el revisor y va textual, porque es un argumento que este mismo
archivo ya tenía escrito, en `discovery.ts:510-518`:

> *"un filtro de calidad cuyo valor lo controla la parte que se está filtrando no
> filtra nada"*

Es exactamente lo que pasa con `nextCursorPath`. Con el corte B, ese `complete`
auto-declarado es lo que habilita a cobrar.

Salida a evaluar: que la evidencia de completitud no dependa **sólo** de un campo
que la fuente controla (contrastar con el `total`/`count` que el propio registro
publica, o degradar a `unverified` cuando la única evidencia es auto-declarada y
la página está llena).

---

## B-2 — `nextCursorPath` es input semi-confiable

*(CR, nota de seguridad — **corregida** con el hallazgo del AR)*

`nextCursorPath` sale de una fila de `registries` que **cualquier caller
autenticado puede crear** (`POST /registries` entra con `enabled ?? true`,
`routes/registries.ts:253`) y se pasa a `getNestedValue`.

**Corrección al planteo original**: `getNestedValue`
(`services/discovery.ts:993-1000`) exige **`typeof current === 'object'` por
tramo**, así que un path de **dos** segmentos vía función (`"constructor.name"`)
**no llega** — el segundo tramo cae en `undefined`. Un path de **un** segmento
(`"constructor"`) sí resuelve a algo truthy y **fuerza `truncated`**, que es el
lado **seguro** (sobre-declara incompletitud).

O sea: **el techo de este truco es el mismo que el de un registro hostil común, y
un registro hostil no necesita el truco.** No es la vía interesante — la que
importa para el dinero es **B-6**, que apunta al lado inseguro (`complete`).

Mitigaciones, si igual se quiere endurecer: `Object.hasOwn` por tramo (o un lector
distinto para paths de configuración), validar `nextCursorPath` en el write-path
de `POST/PATCH /registries`, o que sólo un registro administrado pueda declararlo.

---

## B-3 — Tercera forma de truncamiento: el clamp silencioso del upstream

*(AR MNR-E, consecuencia medida — **lo cierra W3**)*

Si un registro **clampea en silencio** (le pedimos 200 y devuelve 100 sin cursor),
la página no se llena, así que la heurística `page_full` no dispara y —al haber
enviado un límite— se lee como evidencia de completitud: `state: 'ok'`.

**W3 lo cierra** por construcción: con `maxLimit` declarado se envía
`min(over-fetch, maxLimit)`, la página se llena, y `page_full` marca `truncated`.
Documentado en el docstring de `RegistrySchema.discovery.maxLimit`.

> **Corrección (corte B, 2026-08-04)**: ese "lo cierra" afirma de más. B-3 queda
> cerrado **sólo para los registros que declaran `maxLimit`**, no para todos. El
> input que lo demuestra: un registro **sin** `maxLimit` que recibe `limit=200`,
> devuelve 100 filas y no manda cursor ⇒ `100 < 200` ⇒ `completenessProven = true`
> ⇒ `state: 'ok'`, idéntico a antes del corte B. El clamp implementado es
> estrictamente aditivo y no le impone techo a quien no lo declaró.
> Ver `doc/sdd/218-wkh-318-corte-b-maxlimit-clamp/` y **TD-318B-1**.

---

## B-4 — Precondición de deploy, no comentario en un SQL

*(consecuencia de BLQ-1)*

Con el fix de BLQ-1 el código ya **no miente** sin la migración: reporta
`unverified` en vez de `complete`. Pero eso significa que, **hasta que
`20260730010000_wkh318_registry_next_cursor_path.sql` se aplique a bdwv**, el
camino sin `limit` reporta `catalogStatus: 'unverified'`, y un caller del corte B
con `requireCompleteCatalog: true` sería **rechazado**.

Precondición del **corte B**, no del corte A: el corte A es desplegable tal cual
(sólo cambia lo que declara). La migración la aplica el orquestador, sólo a
**bdwv**, y F4 debería evidenciarla antes de habilitar el modo estricto.

---

## D-1 — Decisión tomada: `sources[].failure` se publica

*(AR, punto 3 — no es backlog: es una decisión escrita, ver abajo)*

Ver `decisiones.md` en esta misma carpeta.
