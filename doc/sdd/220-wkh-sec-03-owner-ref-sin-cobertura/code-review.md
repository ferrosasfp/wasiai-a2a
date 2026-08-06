# Code Review — WKH-SEC-03

**HEAD** `16847c3` · **base** `ef384b7` · **VEREDICTO: RECHAZADO** (2 BLOQUEANTE-BAJO, 6 MENORes)

> Persistido por el orquestador desde el reporte del revisor, que por configuracion no puede emitir
> archivos. Todo probe fue restaurado: `git status --porcelain` = `?? doc/audit/` (preexistente) en
> cada verificacion, y `git diff --stat HEAD` vacio.

Estado medido al abrir: `5329 passed | 19 skipped (5348)`, `tsc --noEmit` limpio, `biome check src/`
limpio, guardian 12/12.

**Nada de seguridad explotable.** Los dos bloqueantes son prosa medible-falsa — que es exactamente el
entregable central de esta HU.

---

## 1. Coherencia del diseno: OK, sigue siendo el aprobado

Las dos desviaciones del SDD estan **declaradas con la medicion que las causo**, no aplicadas en
silencio:

| SDD aprobado | Entregado | Donde se declara |
|---|---|---|
| el falso en `__fixtures__/` | en `__tests__/` | `story:227-241` — `tsconfig.build.json:3-8` excluye `__tests__` y **no** `__fixtures__`, asi que el falso habria entrado a `dist/` |
| hook `onUpdateStart` | `onDeleteStart` | `owner-scoped-fake.ts:54-55` — el unico entrelazado del corte es sobre un DELETE (`agent.ts:715`) |

G-11 y G-12 **no son parches pegados**: entraron al bloque «CONTROL DE ARMADO» junto a G-01/G-02, con
15 lineas de comentario (`test:226-241`) explicando por que los pisos no alcanzaban.

**CD-1/AC-7 verificado a mano**: `git diff --name-only ef384b7 16847c3 -- src/` da 9 archivos, ninguno
de produccion, y los 2 preexistentes tocados son solo comentarios.

## 2. El `CLAUDE.md` reescrito: SI es aplicable por alguien que solo lea eso

Da el criterio (`:215-216`), de donde se deriva (`:218-220`, apuntando a `deriveTables()`), que archivo
hace la verificacion y cual tiene los motivos (`:224-229`), el limite que faltaba —presencia vs. valor—
(`:231-236`), y desarma con evidencia los dos casos que la lista vieja mezclaba (`:240-245`).

Las dos citas que sostienen la correccion, verificadas: `database.types.ts:2567` es `owner_ref: string`
de `registries`; `:2303` es `owner_ref: string | null` de `kite_schema_transforms`. **Las dos correctas.**

Le queda el defecto de MNR-5.

## 3. Los ACs

| AC | Veredicto | Evidencia |
|---|---|---|
| AC-1 | PASS | Repro ejecutado: cadena sin filtro en `spend-policy.ts` → `2 failed \| 10 passed (12)`, G-08 nombrando `archivo:linea · tabla · verbo` |
| AC-2 | PASS en el corte | 6 archivos nuevos, un test por sitio |
| AC-3 | PASS | `agent.ownership.test.ts:124-142` con `onDeleteStart` cambiando el dueno entre el pre-chequeo y el DELETE, mas su control anti-vacuidad |
| AC-4 | PASS | Dos duenos en cada fixture; el falso **aplica** los filtros (`:131-135`) y `unknownColumn` convierte una columna mal escrita en `42703` en vez de «no matcheo» |
| AC-5 | **PASS parcial, declarado** | 11 de 23 sitios con evidencia por linea. Ver BLQ-BAJO-1 |
| AC-6 | PASS | 55 entradas clasificadas; el input-rojo del AC figura en `censo:201` |
| AC-7 | PASS | Cero produccion tocada |

Contadores verificados con instrumento propio (probe temporal, borrado en el mismo comando):
**62 tablas, 21 con dueno, 205 archivos, 101 cadenas, 0 no resolubles, 87 en alcance, 41 sin filtro =
41 excepciones, 24 tablas nombradas (18 con dueno)**. Coincide con todo lo que declaran los artefactos.

## 4. El hallazgo del `SIGINT`: la explicacion es correcta, reproducida en sus TRES patas

`kill -INT` al PID a 1 s, sobre un bucle de 8 iteraciones con `spawnSync` adentro:

| Escenario | Medido |
|---|---|
| sin handler (el original) | `exit=130`, corta en `iter 2` — mata en el acto y deja el archivo mutado |
| `process.on('SIGINT')` + bucle 100% sincronico | **`exit=0`, las 8 iteraciones completas. El handler NUNCA corrio.** |
| lo mismo + `await setImmediate` por iteracion | `exit=130`, `HANDLER-CORRIO` tras `iter 3` |

La afirmacion «el handler solo empeoraba el original» es **exacta**, y el mecanismo que da es el
correcto. **Costo del arreglo: nulo** — 46 `setImmediate` = **232 µs totales** contra los 26,08 s de
`--all` (0,0009 %).

---

## BLOQUEANTE-BAJO-1 · El docblock cuenta como medido un metodo aplicado a 11 de 23 sitios

`test/ownership-filter-guard.test.ts:10-16` dice *«El censo abrio con 23 de esos filtros como
candidatos […] **mutados uno por uno**, 20 lo eran y 3 no»*.

**Repro**: `mutation-log.md:212` dice, en «Lo que esta campana NO midio»: *«Los 12 sitios de
WKH-SEC-04. Fuera del corte, **sin mutar**»*. Y `mutation-log.md:70` titula «Las **11** mutaciones de
produccion». De los 23 se mutaron **11**; de esos, 3 tenian espia y 8 no. Para los otros 12 la unica
evidencia es el barrido de A1 — **cuya linea base este mismo SDD declara equivocada y corrige**
(`sdd.md:494-497`, CD-8). Ademas, de los «20» hay **uno** con su salida pegada; los otros 19 se afirman.

**Impacto**: es el archivo que esta HU deja como doctrina, y es la **TERCERA version de esa misma
frase**. El AR ya rechazo la anterior (su BLQ-BAJO-3, «23 que ningun test miraba»). La correccion
arreglo el numero y dejo una afirmacion nueva sobre el metodo.

**Sugerencia**: separar lo medido de lo heredado. «De los 23 se mutaron uno por uno los **11** de este
corte — 8 sin ningun test que los mirara y 3 con espia preexistente; para los **12** de SEC-04 la
evidencia sigue siendo el barrido de A1, que no se re-corrio aca».

## BLOQUEANTE-BAJO-2 · «Las tres rutas» — la tercera no existe

`src/services/spend-policy.ownership.test.ts:6-13` enuncia **tres** rutas y **cita dos**.

**Repro**: `command grep -rn "hasAnyPolicy" src --include=*.ts | command grep -v "\.test\.ts"` devuelve
**solo la definicion** (`spend-policy.ts:214`). El tercer sitio es `hasAnyPolicy`, que **no tiene
llamador de produccion ni ruta**. Su propio docblock lo admite (`spend-policy.ts:209-212`: *«NO se usa
en el hot-path […] Se expone para tests/diagnostico»*).

**Impacto**: un lector concluye que ese test protege una ruta. Y **el mismo PR aplica el estandar
correcto para el caso identico**: `inbound-task.ownership.test.ts:7-16` declara *«NO TIENE LLAMADOR DE
PRODUCCION […] La unica superficie que ejercita este filtro es este test»*. Es inconsistencia interna,
no falta de criterio.

---

## MENORes

**MNR-1 · El agujero compartido de G-11/G-12 es MAS ANCHO que lo declarado, y el respaldo que se nombra
no dispara.** Reproducido en tres pasos:

1. En `database.types.ts:664`, `a2a_key_spend_policies: {` → `"a2a_key_spend_policies": {`. **La
   indentacion no se toca** — es la forma que `supabase gen types` emite para cualquier nombre que no
   sea identificador JS. → **`12 passed (12)`**.
2. Con eso puesto, una cadena real sin filtro sobre esa tabla → **`12 passed (12)`**. El IDOR es
   invisible.
3. **Control**: la misma cadena con los tipos intactos → `2 failed | 10 passed`.

Lo declarado enmarca el riesgo como un cambio de **formato** (global). Medido: la suposicion compartida
incluye tambien el **juego de caracteres del identificador**, y eso ciega **una tabla por vez**, donde el
piso de G-01 **no dispara**: `ALL_TABLES >= 50` sobre 62 reales, `OWNER_TABLES >= 15` sobre 21
(holgura de 12 y 6).

**Cierre barato, no implementado**: exigir que toda cabecera a 6 espacios dentro de `Tables:` que no sea
`};` haya parseado. Medido hoy: 125 lineas a 6 espacios, 62 cabeceras, 63 `};`.

**MNR-2** · `deriveOwnerTables` (`scanner.ts:235-237`) esta importado en `test:106` y **nunca se
invoca**. No lo caza nadie: `package.json:11` es `biome check src/` y el tsconfig incluye solo `src/**/*`.

**MNR-3** · `_INDEX-row.md:24` **reinvierte los rotulos 11/12** que el SDD habia corregido. SEC-03 cubre
**11** y SEC-04 son **12**, que es lo que dicen `sdd.md:401-403` y el docblock del guardian. Dos
artefactos del mismo PR se contradicen y el que queda en el indice es el equivocado.

**MNR-4** · El guardian lee el **indice de git** (`test:114-116`). Repro: archivo nuevo sin `git add`
con una cadena sin filtro → **12/12 verde**; tras `git add -N` → 2 rojos. No es gap de CI, si de dev
local, y **no esta en la lista «QUE NO CUBRE»**.

**MNR-5** · `CLAUDE.md:218-219` dice *«El numero no se escribe a mano en ningun lado»* y **lo escribe a
mano cuatro veces**: el 21 en `:187`, `:211`, `:216`, y el 41 en `:227`. Nada los fija: G-01 son pisos,
G-09 es `>= 35`, y G-11/G-12 son invariantes **relativos**. Repro: agregue una 22a tabla con `owner_ref`
→ **12/12 verde** y `CLAUDE.md` queda viejo en silencio. **Es la misma podredumbre que esa seccion vino
a reemplazar, con menos filas.**

**MNR-6** · `eq-sweep.mjs:56-58` afirma que un Ctrl-C *«repone el archivo mutado»* gracias al handler.
Por construccion no puede: el unico punto donde el handler puede correr es el `await` de `:257`, que
esta al **principio** del cuerpo, despues del `restaurar()`. Ahi `mutado === null` y `restaurar()`
retorna sin hacer nada. Quien repone es **donde esta el `await`**, no el handler. El docblock de
`:234-249` lo dice bien y se contradicen entre si.

---

## Cierre del fix-pack del AR: OK

BLQ-MED-1, BLQ-BAJO-1/2/3 y MNR-1..5 verificados cerrados uno por uno. El puntero auto-confirmante
corregido en `exceptions.ts:275,285-286`; la heuristica de `regexCanStart` en `scanner.ts:29-31`; G-10
cruza `table`/`verb` en `:526-544`. Los **42 RPC en 13 archivos** los conte y da exacto.

## No se pudo verificar

Que los filtros funcionen contra Postgres real (el falso es un doble). Que los 12 sitios de SEC-04 sigan
sin cobertura (no se mutaron). Que los 42 `supabase.rpc(...)` esten libres de IDOR.

**Orden del fix-pack**: BLQ-BAJO-1 → BLQ-BAJO-2 → MNR-1 (tiene cierre barato) → MNR-3, MNR-5 → MNR-2,
MNR-4, MNR-6.
