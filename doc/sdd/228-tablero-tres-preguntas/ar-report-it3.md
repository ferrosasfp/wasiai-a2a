# AR — WKH-365 · iteración 3 (re-AR del fix-pack 2)

**HU**: 228 · el tablero de las tres preguntas
**Worktree**: `/home/ferdev/.openclaw/workspace/a2a-tablero` · rama `feat/228-tablero-tres-preguntas`
**Commit auditado**: `bcba4f5` (árbol limpio, verificado antes y después de cada mutante)
**Alcance**: SÓLO el fix-pack 2 (`42fcd31..bcba4f5`). Las iteraciones 1 y 2 barrieron el resto.
**Fecha**: 2026-08-25

---

## Veredicto

🔴 **RECHAZADO** — 1 `BLQ-BAJO`, 2 `MNR`.

El corazón del arreglo **funciona y está probado**: los dos techos son visibles en la salida
construida, `agentes_omitidos` es exacto, la rama vacía ya no puede afirmar «no hubo», y los 9
mutantes que apliqué (los 3 que el Dev declara + 6 propios, incluidos los 3 que el encargo pidió)
**murieron los 9**. B-1 y B-2 están **cerrados**.

Lo que bloquea es **B-3 incompleto y una afirmación nueva falsa sobre cómo se verificó**: las 11
citas se re-anclaron con un desplazamiento de **+166**, cuando el mapa derivado del propio comando
que el `auto-blindaje` declara haber corrido da **+167** para 10 de las 11. Ocho quedan legibles por
casualidad (caen en la línea de la ruta, que es un ancla defendible para una frase que dice «Ruta»);
**dos afirman algo que en esa línea no está**, y el `auto-blindaje` afirma que *«cada destino
[fue] verificado contra su símbolo contenedor»*, que es exactamente la verificación que habría
cazado esto.

> ⚠️ **Es un arreglo de 4 números**, no un rediseño. Lo marco bloqueante y no menor por el mismo
> criterio con el que la iteración 2 marcó `BLQ-BAJO-2`, y porque es la tercera ronda en la que una
> frase de reemplazo nace falsa — esta vez la frase es sobre el instrumento, que es la clase que
> *apaga* la revisión siguiente. Queda a criterio del humano tomarlo como hot-patch en vez de un
> cuarto fix-pack completo.

---

## 0 · Los gates, completos, en orden, una vez

⛔ `npm run qa` **no existe** en este repo (`package.json` no lo declara). El gate es la secuencia de
`.github/workflows/ci.yml`.

| # | Comando | Resultado |
|---|---|---|
| 1 | `npx tsc -p tsconfig.json --noEmit` | ✅ exit 0 — `TypeScript compilation completed` |
| 2 | `npm run lint` (`biome check src/`) | ✅ exit 0 — `Checked 516 files ... No fixes applied` |
| 3 | `npm test` (`vitest run`) | ✅ exit 0 — `Test Files 310 passed \| 6 skipped (316)` · `Tests 6256 passed \| 19 skipped (6275)` |

Los tres números de los README (**316 / 516 / 192**) los re-deriva `test/readme-numbers.test.ts` en
cada `npm test` (archivos de test desde el `include` de `vitest.config.ts` contra el índice de git;
lintados desde `files.includes` de `biome.json`; variables corriendo el comando que el README
publica). El gate verde los cubre, y `lint` imprimió 516 y `vitest` 316 de forma independiente.
**No hay que creerle a este renglón: lo verifica la suite.**

---

## 1 · 🎯 ¿Los techos son REALMENTE visibles? — **OK**

**No leí: construí la salida.** Arnés fuera del repo
(`scratchpad/wkh365-it3/screen.mjs`), que extrae el `<script>` inline del HTML del repo y lo corre
con el mismo `new Function(document, window, fetch)` del harness de tests, sin tocar un archivo.

| Escenario | filas en la tabla | aviso que ve el operador | ¿dice «no hubo»? |
|---|---|---|---|
| S1 · 50 mostrados, 10 omitidos | 50 | «Hay 10 agente(s) más con actividad en la ventana que esta tabla no muestra.» | no |
| S2 · 6 mostrados, lectura truncada | 6 | «La lectura se cortó en su tope de eventos: puede haber quedado actividad de la ventana sin mirar.» | no |
| S3 · **los dos techos** | 50 | las dos frases, concatenadas | no |
| S5 · lista vacía + truncada | 0 | «Ningún agente entró en esta tabla y la lectura tocó su tope, así que acá no hay ninguna afirmación sobre si hubo actividad o no.» + el aviso | **no** |
| S6 · hoy en prod (6 agentes, ningún techo) | 6 | (ninguno) | no |

**El operador NO ve una tabla que parece completa**: el aviso sale en `class="aviso"` (amarillo
`--warn`, `font-weight: 600`), **arriba de la tabla**, entre el rótulo del universo y el `<thead>`
(`dashboard-tres-preguntas.html:282`). El caso compuesto S3 es el que podía mentir y no miente: el
número exacto y la ignorancia sobre el corte se dicen por separado y en ese orden.

### `agentes_omitidos` — ¿es un conteo EXACTO? **Sí.**

`vistos.size - agentes.length` (`src/services/tablero.ts:217`). Los tres casos donde el encargo
pedía construir la mentira:

- **duplicados** → `vistos` es un `Set` y el `continue` de `:175` los colapsa antes de contar. Dos
  eventos del mismo agente son un slug (ya fijado por `T-REP-1`, `tablero.test.ts:385`).
- **un slug que aparece en `vistos` y no debería** → `agentes ⊆ slugs ⊆ vistos` por construcción
  (`agentes` sólo se llena iterando `slugs`, `:190`), así que la resta es exactamente
  `|vistos \ publicados|` y **no puede ser negativa**. El único poblador espurio posible sería un
  `agent_id` no-NULL basura (p. ej. `''`), que se contaría como omitido: sobre-reporta, nunca
  sub-reporta.
- **el barrido cortado a mitad** → **ya no hay corte**: el `break` se fue (`:177-179`) y el bucle
  consume siempre todas las filas leídas. El único corte que queda es el `limit` de SQL, y ése lo
  declara el otro campo.

**Lo que el campo NO afirma** (y está bien que no lo afirme): exactitud sobre la ventana entera. Es
exacto **sobre lo leído**; si la lectura se truncó, el segundo campo se lo dice al operador.

### `lectura_truncada` — ¿se enciende cuando debe **y sólo** cuando debe? **Sí, con el borde
correctamente tratado.**

`filas.length >= EVENTOS_LIMITE` (`:169`). En el borde exacto de 1.000 filas se enciende aunque la
lectura haya visto todo — es un **sobre-aviso deliberado**, y la pantalla no lo convierte en una
afirmación falsa: dice *«**puede** haber quedado actividad de la ventana sin mirar»*
(`html:246`), no «quedó». Ésa es la frase que el Dev se cazó solo, y la revisé: es correcta en el
borde. El mutante `>=` → `>` **muere** (§2), así que el borde tiene testigo.

### ⚠️ ¿El arreglo introdujo una afirmación NUEVA falsa? **Sí — y no es la que el Dev se cazó.** Ver
`BLQ-BAJO-1` (§3) y `MNR-1`.

Lo que **sí** verifiqué y resultó verdadero, para que no se re-audite:

- `tablero.ts:56-59` — *«`middleware/event-tracking.ts` mete una fila por cada request a los
  prefijos que rastrea … y esa fila va con `agent_id` en NULL»*: **cierto**. El hook llama
  `eventService.track({...})` sin `agentId` (`event-tracking.ts:133-167`) y
  `event.ts:71` hace `agent_id: input.agentId ?? null`.
- `tablero.ts:55-57` — *«hay un test que le prohíbe al tablero nombrar operaciones que gastan»*:
  **existe** (`tablero.test.ts:390-405`, lista `composeService` / `orchestrate` / `compose(` /
  `debit`).
- `types/index.ts:2671-2677` y `html:235-238` — el razonamiento del borde de 1.000 («con exactamente
  tantas filas que el techo la lectura sí vio todo») es una justificación del hedge, no una
  afirmación sobre el estado real. **Correcto.**
- `dashboard.ts:378` — *«60 s de vida para una tarjeta leída con ÉXITO»*: **cierto**, hay
  `TABLERO_TTL_SIN_DATO_MS = 15_000` y `tableroTtl()` discrimina (`:399-403`).
- El desbordamiento **no** produce hoy pantalla verde vacía: confirmado en código y en el test, que
  el Dev rotula explícitamente como *construido*, no *medido* (`tablero.test.ts:487-494`).

---

## 2 · Los mutantes — **9 aplicados, 9 muertos**

**Arnés** (⛔ nunca `git checkout --`): copia propia en
`scratchpad/wkh365-it3/{tablero.ts.orig,html.orig}`, mutación por reemplazo de aguja única (aborta
si la aguja no aparece exactamente 1 vez), restauración por `cp -p` y **`md5sum -c` verificado
después de cada uno**. Baseline de las 3 suites del tablero: **77 passed (77)**.

| Mutante | Qué cambia | Resultado | Testigo que lo mata |
|---|---|---|---|
| `M-B1a` | se borra `.not('agent_id','is',null)` | ☠️ **KILLED** | `B-1: la telemetría sin agente NO se come el techo` |
| `M-B1b` | vuelve el `break` en el barrido | ☠️ **KILLED** | `B-1: los agentes que no entran … se CUENTAN` |
| `M-B1e` | el caso vacío afirma **siempre** «se preguntó y no hubo» (`if (aviso !== '')` → `if (false)`) | ☠️ **KILLED** | `lista vacía CON un techo tocado NO dice «se preguntó y no hubo»` |
| `M-NEW-1` | `agentes_omitidos: 0` hardcodeado | ☠️ **KILLED** | `… se CUENTAN` (`expected 0 to be 10`) |
| `M-NEW-2` | `.not` sobre **otra columna** (`agent_name`) ⇒ filtro vacuo | ☠️ **KILLED** | el assert de cadena `expect(call?.nots).toEqual([['agent_id','is',null]])` |
| `M-NEW-3` | `lectura_truncada = true` siempre | ☠️ **KILLED** (2 tests) | `… se CUENTAN` + `control POSITIVO: sin ningún techo tocado…` |
| `M-NEW-4` | denominador equivocado: `slugs.length - agentes.length` | ☠️ **KILLED** | `… se CUENTAN` |
| `M-NEW-5` | el borde: `>=` → `>` | ☠️ **KILLED** | `B-1: la lectura cortada en el techo lo DICE` |
| `M-NEW-6` | (= `M-NEW-2`, columna invertida) | — | — |

**Nota honesta sobre la inversión literal del `.not`**: la inversión real en PostgREST
(`.is('agent_id', null)`) es inconstruible en este arnés porque el falso de Supabase no implementa
`.is` — moriría por `TypeError`, que es un kill débil. El testigo **fuerte** de la inversión es el
assert de cadena (`tablero.test.ts:509-510`), que clava columna + operador + valor exactos: cualquier
inversión expresable en la cadena queda cazada. `M-NEW-2` lo demuestra.

**Mención al arnés del falso**: el doble de Supabase ahora aplica **los filtros antes que el techo**,
como PostgREST (`tablero.test.ts:78-101`). Sin ese orden, el escenario que rompió la tarjeta 2 sería
inconstruible y `M-B1a` sobreviviría. Es la pieza que hace que estos mutantes signifiquen algo.

---

## 3 · Las 11 citas y la línea-neutralidad

### Línea-neutralidad: **VERIFICADA ✅**

- `/usr/bin/git diff --numstat bcba4f5~1 bcba4f5 -- test/ownership-filter-guard.exceptions.ts` →
  **`12 12`**.
- El archivo mide **537 líneas antes y después** (`42fcd31` vs `bcba4f5`).
- Las citas que apuntan **hacia adentro** siguen valiendo: `exceptions.ts:274` y `:284`, citadas por
  `doc/sdd/220-…/adversarial-review.md:60` como *«los sitios `arbiter.ts:1237` y `arbiter.ts:1270`»*,
  siguen cayendo dentro de esas dos entradas exactas. La razón de la línea-neutralidad se cumple.

### `BLQ-BAJO-1` · El re-anclaje quedó **−1** en 10 de las 11, y 2 de esas 10 afirman algo falso

**Categoría**: Integration / evidencia falsa en un documento de seguridad + afirmación de instrumento
**Archivos**: `test/ownership-filter-guard.exceptions.ts:275, 285-286` ·
`doc/sdd/228-tablero-tres-preguntas/auto-blindaje.md` (bloque *Fix-pack 2 — B-3*)

**Reproducción** (el mapa derivado con el comando que el propio `auto-blindaje` declara haber usado):

```
/usr/bin/git diff -U100000 f391325 bcba4f5 -- src/routes/dashboard.ts   # se camina el diff
                                                                        # ' '→ambos, '-'→viejo, '+'→nuevo
```

| ancla en `f391325` | **derivado** | escrito en el fix-pack | contenido REAL de la línea escrita |
|---|---|---|---|
| `477` (gate de `/holds`) | **644** | `643` | `'/api/arbitrations/holds',` |
| `515-516` (registro de la ruta) | **682-683** | `681-682` | `*/` + `fastify.post<…>(` |
| `517` (**gate** `requireAdminTokenStrict`) | **684** | **`683`** | `'/api/arbitrations/:intentId/resolve',` ← **no es el gate** |
| `424` (gate de `/api/stats`) | **591** | `590` | `'/api/stats',` |
| `680` (gate de `/hop2-evidence`) | **847** | `846` | `'/api/reconciliation/:intentId/hop2-evidence',` |
| `742` (**preHandler** de `/release-lease`) | **909** | **`908`** | `config: { rateLimit: false },` ← **ni ruta ni gate** |
| `598` (gate de `/api/reconciliation`) | **765** | `764` | `'/api/reconciliation',` |
| `630` (gate de `/…/resolve`) | **797** | `796` | `'/api/reconciliation/:intentId/resolve',` |
| `390` (gate de `/api/trace`) | **440** | `439` | `'/api/trace',` |
| `300-309` (docblock del gate del trace) | **307-316** | `307-316` | ✅ **la única correcta** |

**Ocho de las diez son inocuas**: caen en la línea de la **ruta**, y la frase que las contiene dice
«Ruta …», así que el ancla es defendible aunque no sea la derivada. **Dos no lo son**, y las dos
dicen algo que en esa línea no está:

1. `exceptions.ts:275` — *«gate `requireAdminTokenStrict` **en :683**»*. La línea 683 es la **ruta**;
   el gate está en **684**. Verificado con `sed -n '682,685p' src/routes/dashboard.ts`.
2. `exceptions.ts:285-286` — *«Rutas `dashboard.ts:846` **y :908**»*. La 908 es
   `config: { rateLimit: false },`, **dentro** del objeto de opciones de `/release-lease`: la ruta
   está en **906** y el `preHandler` en **909**. En la misma frase, `846` **sí** es una línea de
   ruta ⇒ las dos anclas de una misma oración usan convenciones distintas, lo que prueba que es un
   deslizamiento aritmético y no un cambio de criterio.
3. `exceptions.ts:285` — el rango *«`dashboard.ts:681-683`, requireAdminTokenStrict»* se presenta
   como «misma ruta y **mismo gate**», y **excluye** la línea del gate (684).

**La afirmación de instrumento, que es la parte que preocupa más**: el `auto-blindaje` declara

> *«los 11 números re-anclados **derivando** el mapa `vieja→nueva` de `/usr/bin/git diff -U1000000
> f391325`, y **cada destino verificado contra su símbolo contenedor** … no contra un parecido de
> texto»*

Correr esa derivación da **+167** para las 10 anclas de rutas; se escribió **+166**. Y verificar
contra el símbolo contenedor habría cazado los dos casos de arriba en el acto. **La causa raíz está
en el renglón de al lado**: el mismo documento dice *«`dashboard.ts` pasó de 791 a **957** líneas»* —
son **958** (`wc -l` y `awk 'END{print NR}'` coinciden; el archivo base da 791 con los dos
instrumentos). El 957 es de dónde salió el 166.

**Impacto**: bajo pero real, y **sin ningún guardián** — el propio `auto-blindaje` lo declara
(*«estas 11 citas siguen sin tener guardián … el silencio sobre estos 11 números es real»*), lo cual
confirmé: `test/cited-lines-guard` sólo cubre `CORTE_A_PATHS` y este archivo no está en la lista. Un
auditor de ownership que abra `:683` buscando el control compensatorio cae en la ruta y lo ve una
línea más abajo; **el daño material de la iteración 2 (caer en el cache del tablero, un handler
ajeno) está cerrado**. Lo que queda es una afirmación falsa en el registro que justifica por qué se
lee cross-tenant, más una afirmación falsa sobre cómo se verificó — y ésa es la que apaga la
revisión siguiente.

**Sugerencia** (no lo arreglo yo): corregir `683` → `684`, el rango `681-683` → `682-684`, y `908` →
`906` (si el ancla que se quiere es la ruta) o `909` (si es el gate); decidir **una** convención y
aplicarla a las 8 restantes; y corregir `957` → `958` más la frase sobre el símbolo contenedor, que
hoy afirma una verificación que no se hizo. La edición sigue siendo línea-neutra: los números
mantienen la cantidad de dígitos.

---

## 4 · Daño colateral y presupuesto — **OK**

**Daño colateral**: `--numstat 42fcd31 bcba4f5` toca **9 archivos** y ninguno más que los del
fix-pack (`dashboard.ts`, `tablero.ts` + su test, el HTML + su test, `types/index.ts`,
`exceptions.ts`, `auto-blindaje.md`, `ar-report-it2.md`). Fuera de `exceptions.ts` (línea-neutro,
§3) el único preexistente que se desplaza es `dashboard.ts` (**+7**, todo en el docblock del TTL,
`:377-392`) — por encima de las 11 citas de rutas, así que ya está contabilizado en el mapa de §3, y
por debajo del docblock del trace, cuya cita `307-316` sigue exacta.

**Los tres números de los README** siguen coincidiendo con lo derivado: `316` (vitest los imprimió),
`516` (Biome los imprimió), `192` (`test/readme-numbers.test.ts` corre el comando que el README
publica). Los tres los re-deriva la suite, que está verde.

**Presupuesto**: contrastado, **coincide al dígito**.

| Medición | Declarado | Medido por mí |
|---|---|---|
| `--numstat f391325 bcba4f5 -- src/ .env.example README*.md` | +3.630 / −6 | **+3.630 / −6** ✅ |
| fix-pack 2 solo (`42fcd31 bcba4f5`, mismos paths) | +332 / −17 | **+332 / −17** ✅ |
| reparto tests / producción | 216 / 116 | **216** (119+97) / **116** (23+48+36+9) ✅ |
| múltiplo sobre el techo de 2x (3.150) | 2,30x · 480 líneas | **2,3047x · 480** ✅ |

**¿Hay algo recortable? Mi lectura: no, y el exceso está justificado — con un matiz que el
`auto-blindaje` no dice.** De las 116 líneas de producción del fix-pack, **32 son código** y **82
son comentario/docblock** (`grep '^+[^+]'` separando líneas que abren con `*`, `//`, `/*`, `<!--`,
`⚠`, `⛔`: tablero 12/35, types 2/21, html 18/17, dashboard 0/9). O sea: el arreglo de dos
bloqueantes de *data integrity* costó **32 líneas de lógica**; el resto es la prosa que los dos AR
pidieron **por escrito** y los 216 testigos que matan 9 mutantes. Recortar ahí es recortar
exactamente lo que hace verificable el arreglo. La lección del `auto-blindaje` (*«un presupuesto que
no reserva nada para el post-AR falla siempre en la misma dirección»*) es correcta y va al próximo
SDD, no a este fix-pack.

---

## 5 · Las 11 categorías

| # | Categoría | Veredicto (alcance = fix-pack 2) |
|---|---|---|
| 1 | **Security** | **OK**. Sin superficie nueva. `.not()` con argumentos constantes (sin interpolación). Los dos campos nuevos son `number`/`boolean` y el render los pasa por `esc()` (`html:243`). El gate del endpoint no se tocó. |
| 2 | **Error Handling** | **OK**. Los caminos de error no cambiaron: `error` → `sin_dato/historial_ilegible`, `degraded` → `sin_dato` **antes** de construir la tarjeta (`tablero.ts:184-187`), así que los dos campos nuevos nunca viajan en una tarjeta que no se pudo leer. |
| 3 | **Data Integrity** | **OK**. `agentes_omitidos` exacto sobre lo leído (demostrado en §1, invariante `agentes ⊆ slugs ⊆ vistos`); 5 mutantes sobre el conteo y el corte, los 5 muertos. |
| 4 | **Performance** | **OK**, mejora neta. El `.not` reduce lo leído (481 filas contra el techo de 1.000). Sacar el `break` hace que el bucle recorra siempre ≤1.000 filas en vez de cortar en 50 slugs: son operaciones de `Set` sobre un array ya materializado, despreciable frente a la query. |
| 5 | **Integration** | **OK**. `TableroReputacionOk` gana dos campos **obligatorios**; el único productor es `leerReputacion` y los únicos consumidores son el HTML y los tests (`tsc` verde). El endpoint no tiene response-schema de Fastify, así que nada poda las claves nuevas al serializar (verificado en `dashboard.ts:565-580`). Sin consumidor externo: la ruta nace en esta HU. |
| 6 | **Type Safety** | **OK**. Sin `any`, sin casts nuevos. Los campos son `number`/`boolean` no opcionales, y el render se defiende con `typeof` (ver `MNR-2`). |
| 7 | **Test Coverage** | **OK con MENOR**. 9/9 mutantes muertos, con control POSITIVO en las dos capas (service y render) que impide que los avisos aparezcan cuando no corresponde. Falta el caso del payload **sin** los campos (`MNR-2`). |
| 8 | **Scope Drift** | **OK**. Los 9 archivos del fix-pack son exactamente los que los 3 bloqueantes exigían, más los dos reportes. Ningún refactor no pedido. |
| 9 | **Destructive Migrations** | **N/A**. El fix-pack no toca `migrations/` ni ejecuta DDL; el tablero es sólo lectura. |
| 10 | **RPC / SECURITY DEFINER** | **N/A**. No se crea ni se llama ninguna función Postgres; el service usa el query builder de PostgREST. |
| 11 | **Cache Invalidation** | **N/A para hallazgos nuevos**. El fix-pack sólo edita el **docblock** del TTL (+9/−2), sin cambiar `TABLERO_TTL_OK_MS`, `tableroTtl()`, las tres entradas por tarjeta ni el single-flight. La lógica ya la barrieron it1/it2. Ver `MNR-1` por la razón escrita en ese docblock. |

---

## 6 · MENORes

### `MNR-1` · El docblock del TTL atribuye la volatilidad de la tarjeta 2 justo a las filas que el fix acaba de excluir

**Archivo**: `src/routes/dashboard.ts:380-383`

> *«El hook de `event-tracking` inserta en `a2a_events` una fila por cada request a los prefijos que
> rastrea, **así que la fuente de la tarjeta 2 puede cambiar dos veces en el mismo segundo**»*

Esas filas van con `agent_id` en NULL, y desde este mismo commit la query de la tarjeta 2 las
**excluye** (`.not('agent_id','is',null)`). Insertar 1.000 filas de telemetría no cambia ni una celda
de esa tarjeta. La conclusión (el 60 es una tolerancia elegida, no una afirmación sobre la
volatilidad) **es correcta**, y el universo sí cambia rápido — pero por **otro** mecanismo: los
eventos con `agent_id` que escribe `compose.ts` (`:1028`, `:1215`, `:1655`). Es MENOR y no
bloqueante porque no le miente al operador y la decisión que justifica no cambia; pero es literalmente
el patrón que B-2 vino a arreglar, en la misma línea, por tercera vez.

**Sugerencia**: nombrar el productor que sí mueve el universo (`compose.ts`), o borrar el «así que» y
dejar el número sin razón — que es la lección que el propio `auto-blindaje` escribió en B-2
(*«cuando saques una frase falsa, la opción por defecto es borrar o acotar, no reemplazar»*).

### `MNR-2` · Si los campos de techo faltan en el payload, el render **asume que no hay techo** — el único default optimista de la pantalla

**Archivo**: `src/static/dashboard-tres-preguntas.html:241, 245`

```js
var omitidos = typeof card.agentes_omitidos === 'number' ? card.agentes_omitidos : 0;
if (card.lectura_truncada === true) { … }
```

**Reproducción** (construida, S4 y S7 del arnés): con
`reputacion = { status:'ok', agentes:[…50…], ventana:'últimos 30 días' }` — **sin** los dos campos —
la tarjeta pinta **50 filas, verde, sin ningún aviso**: exactamente la tabla que parece completa que
este fix existe para impedir.

Contrasta con las dos reglas que la misma pantalla se escribió: *«El DEFAULT es GRIS, nunca verde»*
(`:153-154`) y el motivo por el que los campos se declararon **obligatorios** en el contrato
(`types/index.ts:2660-2663`: *«un campo que se puede omitir se omite, y la lista vuelve a parecer
completa sin que nadie lo haya afirmado»*). El render reintroduce ese escenario con un default.

**Por qué MENOR y no bloqueante**: hoy es **inalcanzable desde este repo** — el service siempre
setea los dos campos, `tsc` lo exige, y el endpoint no tiene response-schema que pode claves
(verificado). El camino residual es sesgo de versión durante un deploy rodante (página nueva contra
instancia vieja). No hay test que fije este caso.

**Sugerencia**: tratar la ausencia como techo desconocido (aviso gris del tipo «esta respuesta no
dice si la lectura tocó un techo») en vez de como cero, con su testigo — es el mismo criterio que
`estadoDe` ya aplica al `status` desconocido.

---

## 7 · Orden del fix-pack, si el humano decide iterar

1. **`BLQ-BAJO-1`** — 4 números (`683`→`684`, `681-683`→`682-684`, `908`→`906`/`909`, `957`→`958`) +
   la frase sobre el símbolo contenedor. Decidir la convención de ancla y aplicarla a las 8
   restantes. Edición línea-neutra (misma cantidad de dígitos).
2. `MNR-1` y `MNR-2` — opcionales, no bloquean DONE.

**Lo que NO hay que volver a tocar**: la query, el conteo, los dos campos, la rama vacía del render y
los testigos. Están verificados con salida construida y 9 mutantes muertos.

---

## Anexo · Reproducibilidad

- Arnés de mutación y del render: `scratchpad/wkh365-it3/` (fuera del repo, directorio único de esta
  sesión). Restauración por `cp -p` + `md5sum -c` verde después de **cada** mutante; árbol
  `git status --porcelain` **vacío** al cerrar.
- Todo `git` con `/usr/bin/git` (ruta absoluta). Ninguna fuente leída con `cat`.
- Ningún archivo del repo fue modificado por este AR salvo este reporte.
