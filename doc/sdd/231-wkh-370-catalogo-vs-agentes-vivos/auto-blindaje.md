# Auto-Blindaje — WKH-370 · El vigilante del catálogo

> Fase F3 · Rol `nexus-dev` · Rama `feat/231-wkh-370-catalogo-vs-agentes-vivos`

---

## W0.1 — Línea base del gate, medida en el árbol de arranque

⚠️ **El Story File dice que el árbol es `a58ab2b`; el HEAD real de `main` al arrancar F3 es
`091db28`.** No es una discrepancia que invalide nada, y se midió antes de creerlo:

```
/usr/bin/git diff --stat a58ab2b HEAD
 doc/sdd/231-wkh-370-catalogo-vs-agentes-vivos/story-file.md | 782 +++++++++
 1 file changed, 782 insertions(+)
```

El único delta es **el propio Story File commiteándose encima**, exactamente el mismo fenómeno que
el Story File documenta como **I-1** para el SDD (`a9087e4` → `a58ab2b`). Cero archivos de código
distintos ⇒ **todas las citas del Story File siguen valiendo**. Es la segunda vez consecutiva que
el commit de un artefacto de fase invalida la referencia de árbol de ese mismo artefacto.

**Aplicar en**: todo Story File/SDD debe decir *"árbol de código medido"*, no *"HEAD"*. El HEAD
cambia por el acto mismo de guardar el documento.

Gate completo, en orden, árbol limpio en `091db28`:

```
/usr/bin/git status --short        → (vacío)
npx tsc -p tsconfig.json --noEmit  → "TypeScript compilation completed"           exit 0
npm run lint                       → "Checked 519 files in 228ms. No fixes applied."  exit 0
npm test                           → Test Files  312 passed | 6 skipped (318)
                                     Tests      6310 passed | 19 skipped (6329)   exit 0
```

**Coincide con §0 del Story File en los cuatro números.** Se sigue.

---

## [2026-08-27] W1.A — La escalera del contrato mal atribuye dos casos reales

- **Error**: implementé la escalera de §5 con su orden literal y **dos tests míos salieron rojos
  por el motivo equivocado**: `T-J1` (`manifest.slug` distinto → debía dar `UNRESOLVED(6)`) y el
  manifiesto caído (debía dar `INALCANZABLE(2)`) daban los dos **`CONFIG(3)`**.
  Rojo literal: `AssertionError: expected 3 to be 6`.
- **Causa raíz**: la fila **7** (`comparados === 0 → CONFIG`) se evalúa **antes** que la 8
  (`inalcanzables`) y la 9 (`unresolved`). Cuando **ningún** elegible resuelve —o ninguno
  contesta— `comparados` queda en cero y la fila 7 gana. Y `CONFIG` dice textualmente, en la
  tabla del propio contrato, que **acusa al INSTRUMENTO** y *no implica a producción*: o sea que
  "los cinco manifiestos están caídos" se reportaría como "yo no estoy en condiciones de
  preguntar". Es una **mala atribución**, que es justo lo que las siete clases existen para
  evitar. La tabla de §5 lo dice al revés en su propia fila: `INALCANZABLE` = *"un remoto no
  contestó: `/discover`, `/agents` o **el manifiesto de un elegible**"*.
  Con más de un elegible el conflicto no aparece (basta que uno compare), por eso el contrato
  pudo escribirse sin verlo.
- **Fix**: **no** se reordenaron las filas —el orden se deja intacto para que el CR pueda
  auditarlo contra §5 renglón por renglón— sino que se le agregó a la fila 7 la condición que le
  faltaba: `comparados === 0 && inalcanzables === 0 && unresolved === 0`. Es equivalente a
  evaluar 8 y 9 primero, y **preserva entero lo que AC-4 garantiza**: un chequeo que no ejecutó
  nada JAMÁS sale verde (las tres filas involucradas son no-verdes). El razonamiento está escrito
  en el código, en el sitio.
- **Aplicar en**: toda escalera con una fila de "no medí nada". Esa fila tiene que ser la
  **última explicación**, no la primera: si otra fila explica *por qué* no se midió nada, la que
  atribuye mejor gana. Una fila de anti-vacuidad puesta arriba **le roba la causa** a las de abajo.

## [2026-08-27] W1.B — I-2: `AgentRow` NO se amplió, y el motivo no es de estilo

- **Qué pedía el Story File** (D-2, paso 1): agregar `payout_wallet: string | null` a `AgentRow`,
  una línea, y corregir el comentario de `getSplitContextRow` que quedaría falso (CD-23).
- **Por qué no se hizo así**: la decisión de WKH-143 (*"NO ampliar esta interfaz"*) trae su motivo
  escrito entre paréntesis en el SDD de aquella HU: ***alimenta mappers públicos***. `AgentRow` es
  el tipo del parámetro de **`mapRowToAgent`**, el mapper del catálogo **ANÓNIMO**. Ampliarlo haría
  que la columna exista, **para el compilador**, dentro del mapper público, y la única barrera que
  quedaría sería *que a nadie se le ocurra escribirla en el objeto de retorno* — o sea, un test.
  **Corregir el comentario de un guard no es lo mismo que justificar por qué el guard ya no aplica.**
- **Qué se hizo**: un tipo NUEVO, `OwnedAgentRow = AgentRow & { payout_wallet: string | null }`,
  que tipa **sólo** el parámetro de `mapRowToRecord` (el shape del DUEÑO). `AgentRow` queda
  **intacto** ⇒ `mapRowToAgent` sigue recibiendo una fila donde la columna **no existe**, así que
  un futuro `row.payout_wallet` ahí adentro **no compila**. La decisión anterior se respeta con su
  motivo, en vez de derogarse.
- **Por qué NO se usó `getSplitContextRow`** (la salida que el orquestador señaló, y que
  efectivamente ya selecciona `owner_ref, payout_wallet, referrer_ref`): ese lector va **por slug**
  y `mapRowToRecord` es un mapper **SÍNCRONO** al que `listMine` le pasa **N filas de una sola
  query**. Cablearlo ahí convierte `GET /agents` en **una query por agente** —el patrón anti-N+1
  que `listPublisherAnchors` existe para no repetir, y el mismo cargo que esta HU le hace a
  `GET /discover/<slug>`— y además vuelve asíncrono a un mapper puro y a sus tres llamadores.
  **Se paga más y se protege menos**: la columna seguiría siendo legible desde el mapper público
  vía una llamada, y encima con costo.
- **CD-23 igual se cumplió**: el párrafo de `getSplitContextRow` decía que esas columnas *"JAMÁS
  entran a `AgentRow` ni a un shape público (`mapRowToAgent`/`mapRowToRecord`)"*. La primera mitad
  **sigue siendo cierta** y se conserva; la segunda se corrigió, porque `mapRowToRecord` ahora
  **lee** la columna. Lo que no cambió —y es lo que la regla protege— es que **el VALOR no sale**.
- **Aplicar en**: cuando una HU pide ampliar un tipo que un guard anterior protege, preguntar
  **cuál era el MOTIVO del guard** y no sólo qué prohibía. Acá el motivo era *"alimenta mappers
  públicos"*, y existía una forma de darle el dato al mapper que **no** es público sin tocar el
  que sí lo es.

## [2026-08-27] W1.B — Un campo OBLIGATORIO rompe fixtures fuera del Scope IN

- **Error**: con `hasPayoutWallet: boolean` (requerido, como pide W1.B2), `tsc` dio **4 errores
  TS2345** en `src/routes/agents.publish.test.ts`, un archivo que **no está en el Scope IN**.
- **Causa raíz**: el Story File analizó I-2 hasta *"`AgentRow` no tipa la columna ⇒ no compila"* y
  **no siguió** hasta la otra punta: qué rompe un campo **requerido** nuevo en
  `PublishedAgentRecord`. Lo rompe un único fixture compartido, `RECORD_RESPONSE`, usado en 4
  sitios. ⚠️ **Esto NO es consecuencia de la decisión de arriba**: pasa idéntico con el camino
  prescrito por el Story File, porque el que rompe es W1.B1 (el campo requerido), no W1.B0.
- **Fix**: una línea en ese fixture (`hasPayoutWallet: false`) con su motivo escrito.
  Se midió primero que **ninguna cita del Corte A tenga a ese archivo como `target`** (sólo
  aparece como `from`), así que la inserción **no corre ningún número declarado**.
  **Se declara como desvío del Scope IN**, no se esconde.
- **Aplicar en**: agregar un campo **requerido** a un tipo exportado es un cambio de blast radius,
  no una línea. Antes de presupuestarlo, `grep` del tipo y `tsc`; el Scope IN tiene que incluir a
  los constructores del tipo, no sólo a su definición.

## [2026-08-27] W3.3 — CD-13 estaba incompleto: el número vive en la PROSA, no en el registro

- **Error**: siguiendo W3.3 al pie de la letra —*"corregir los 3 números de `citations.ts`"*— el
  guardián queda **VERDE con la prosa PODRIDA**.
- **Causa raíz**: la clave del registro es **`{from, cite-token}`** (lo dice el docblock del
  guardián). El `cite` es el **texto literal que hay que encontrar en el archivo citador**. Si sólo
  se mueve `line:`, el guardián busca el token viejo, **lo encuentra** (la prosa no cambió), abre
  la línea nueva, la valida y **pasa** — dejando escrito en el repo un `agent.ts:399` que ahora
  apunta a otra cosa. Los tres tokens viven fuera de `citations.ts`:
  `src/types/index.ts` (uno) y `src/routes/agents.ownership.test.ts` (dos), **ninguno en Scope IN**.
- **Fix**: se corrigieron **las dos mitades** de cada cita — el token en la prosa **y** el par
  `cite`/`line` del registro — con los tres destinos **abiertos uno por uno** (`399→463`,
  `808→872`, `822→886`), verificando además el método contenedor: el `if` y el `.eq` de `delete`
  se distinguen de los gemelos de `update` por el `op: 'agentPublishDelete'` de al lado.
  **Se declara como desvío del Scope IN.**
- **Aplicar en**: "arreglar una cita" son **dos** ediciones, no una. Y un guardián verde después
  de mover código **no** prueba que las citas digan la verdad: prueba que el registro concuerda
  consigo mismo.

## [2026-08-27] W1.B5 — CD-18 se cumplió: lint fue el eslabón que sorprendió

- **Error**: `tsc` verde y las dos suites verdes; `npm run lint` **exit 1**, con tres bloques de
  formato (una línea larga en el test, un `while` de una línea, y el propio
  `hasPayoutWallet: ...` que Biome parte en dos).
- **Fix**: `./node_modules/.bin/biome format --write` sobre **los tres archivos tocados**, nunca
  sobre `src/` entero (`npm run format` reformatearía archivos ajenos a la HU).
  ⚠️ El formateo **volvió a correr las líneas** de `agent.ts`, así que W3.3 se hizo **después**.
- **Aplicar en**: el orden es `tsc → lint → test`, y **el formateo mueve líneas**. Cualquier
  arreglo de citas por desplazamiento va **después** de que el formateador dijo la última palabra.

## [2026-08-27] W3.1 — AC-10: las tres mutaciones, con su rojo LITERAL y su motivo

Árbol medido: rama `feat/231-wkh-370-catalogo-vs-agentes-vivos` sobre `main` @ `091db28`.
Backup y restauración con `cp` desde `…/scratchpad/wkh370-mutantes/` (subdirectorio propio),
verificando la vuelta con **`/usr/bin/diff`**. ⛔ En ningún momento `git checkout --`.

### Mutante 1 — la mitad de DERIVA: comparar el `payment` de la RAÍZ (CD-12)

`['payment', meta.payment, …]` → `['payment', fila?.payment, …]`

```
× T-D2: los CINCO campos comparables producen deriva cada uno POR SEPARADO
  AssertionError: expected [ 'inputSchema', 'payment' ] to deeply equal [ 'inputSchema' ]
× T-Z2 (CD-12): se compara metadata.payment y NUNCA el payment DERIVADO de la raíz
  AssertionError: expected 4 to be +0
 Tests  5 failed | 27 passed (32)
```

**El motivo es el correcto, y es lo que hay que leer**: `expected 4 to be +0` es
`DERIVA(4)` donde correspondía `CONFORME(0)` — la **deriva FABRICADA**. El de T-D2 muestra el
mecanismo: el campo `payment` pasa a diferir **en todos los casos**, porque el bloque de la raíz
trae `network` y `resolvedChain` que el manifiesto no tiene. Contra producción eso serían
**5 de 5 agentes acusados, todos los días**, sin que nada esté mal.

### Mutante 2 — la mitad de COMPLETITUD: `!!row.payout_wallet`

```
× T-B1: false con null Y con una cadena de espacios; true con un valor
  AssertionError: expected true to be false
 Tests  1 failed | 2 passed (3)
```

**Motivo**: la fila `con-espacios` (`payout_wallet: '   '`) sale `hasPayoutWallet: true`. Una
billetera que es sólo espacios **no es una billetera**, y con `!!` la fila mal nacida se declara
completa — el chequeo entero queda mirando para otro lado exactamente en el caso que existe para
cazar.

### Mutante 3 — LA TESIS (AC-3): la fila de incompletas movida DEBAJO de la fila buena

```
× T-C1 (AC-2): las dos mitades son INDEPENDIENTES — el mismo agente, dos veredictos
× T-C2 (LA TESIS): payout ausente y deriva CERO → INCOMPLETA(5), ⛔ jamás CONFORME(0)
× T-C3: metadata vacío (sin inputSchema) → INCOMPLETA aunque no haya nada que comparar
  AssertionError: expected +0 to be 5   (las tres)
 Tests  3 failed | 29 passed (32)
```

**Motivo**: `expected +0 to be 5` es **`CONFORME(0)` donde correspondía `INCOMPLETA(5)`**. Es la
HU entera en un número: la fila sin billetera coincide con su manifiesto en los cinco campos, así
que si la escalera pregunta primero *"¿hay deriva?"* y contesta *"no"*, **declara sana a la fila
rota**. Ése es el bug de origen, reproducido a pedido.

### Control positivo de los tres

Ninguno de los tres rojos prueba nada si el chequeo no ejecutó. **T-V2** lo cierra: en el caso
feliz lee la línea EMITIDA y exige `comparados > 0`, más `llamadas` de longitud 2 con el `GET` al
manifiesto. Tras restaurar, las dos suites vuelven a **35 passed (35)**.

## [2026-08-27] TD-370-CITAS-FUERA-DEL-CORTE — declaradas, NO tocadas

`CORTE_A_PATHS` son 14 paths; fuera de ellos las citas se pudren en silencio y **ningún guardián
las mira**. La inserción de W1.B corrió estas dos, y arreglarlas violaría CD-9 (`discovery.ts` y
el camino del dinero están en Scope OUT):

- `src/services/discovery.ts` cita un rango de `services/agent.ts` que esta HU desplazó.
- `src/services/orchestrate.ts` cita una línea de `services/agent.ts` que esta HU desplazó.

Y una **ya podrida antes de esta HU**, que se declara para que el CR no la impute a este trabajo:
`src/services/agent.ownership.test.ts` cita una línea de `agent.ts` como `listMine`, y `listMine`
ya vivía en otra línea antes de tocar nada.

⚠️ Las tres se dejan **como están, a propósito**. Lo que se agrega es que estén escritas.

## [2026-08-27] Las otras dos TD, y dónde viven

- **`TD-370-OUTPUTSCHEMA-SIN-FUENTE`** — en el docblock de `scripts/check-catalog-vs-live.mjs`.
  Re-medido hoy contra los 5 manifiestos vivos: las keys de primer nivel son las mismas **ocho**
  en los cinco y `outputSchema` **no está en ninguno**, mientras **3** filas del catálogo sí lo
  traen. Por eso no entra a la escalera: sólo se cuenta.
- **`TD-370-KEY-SOLO-LECTURA`** — en el docblock de `.github/workflows/check-catalog-vs-live.yml`,
  con las cinco mitigaciones enumeradas. `A2A_CATALOG_OWNER_KEY` se documenta **ahí** y no en
  `.env.example` (CD-24): tocarlo obligaría a mover dos números más de README.

## [2026-08-27] W4.2 — Correr las PARTES del gate no fue correr el gate: 28 rojos que ninguna suite mía vio

- **Error**: las dos suites nuevas verdes, `tsc` verde, `lint` verde… y `npm test` completo:
  **`Test Files 7 failed | 307 passed`, `Tests 28 failed`**. Ninguno de esos 28 estaba en un
  archivo que yo hubiera escrito.
- **Causa raíz 1 — el bug REAL, y era mío**: `TypeError: Cannot read properties of undefined
  (reading 'trim')`, 23 veces. Yo había escrito
  `row.payout_wallet !== null && row.payout_wallet.trim() !== ''`. Los cuatro llamadores entran a
  `mapRowToRecord` por un **cast** (`as unknown as OwnedAgentRow`), así que en tiempo de ejecución
  llega lo que la query trajo: los dobles de Supabase de media docena de suites devuelven filas
  **sin la columna**, o sea `undefined`, que **no es `null`** — pasa el filtro y revienta en el
  `trim`. En producción es la misma clase: cualquier lector que no seleccione la columna convierte
  una lectura en un **500**.
  ⚠️ Y lo peor no fue el bug: fue que **mi propio docblock afirmaba lo contrario**. Decía que
  exigir la columna en el TIPO *"impide que un lector angosto futuro alimente este mapper"*. El
  cast derrota al tipo, así que era **prosa que afirma de más**, escrita por mí, en la HU que
  existe para sacar exactamente eso.
- **Fix**: `typeof row.payout_wallet === 'string' && row.payout_wallet.trim() !== ''` —total, cubre
  `null` y `undefined`— y **el docblock corregido** para decir lo que el tipo compra de verdad
  (que un llamador nuevo tenga que declarar en voz alta lo que le pasa) y lo que NO (no evita que
  llegue una fila sin la columna). Un mapper que no revienta y devuelve `false` deja el ruido del
  lado del chequeo, que es donde tiene que doler.
- **Causa raíz 2 — otra víctima del desplazamiento**: `test/ownership-filter-guard.test.ts`
  G-08/G-09 en rojo. Ese guardián registra **CINCO sitios de `src/services/agent.ts` POR NÚMERO DE
  LÍNEA** en `test/ownership-filter-guard.exceptions.ts`, y mis inserciones los corrieron todos.
  El Story File anticipó el guardián de citas y **no** éste: es la **tercera** familia de
  referencias por línea que esta HU desplaza, después de `citations.ts` y de la prosa.
- **Fix**: se re-derivaron los cinco (`getRow`, `getSplitContextRow`, `listAsAgents`,
  `listPublisherAnchors`, `getBySlugAsAgent`) **abriendo cada cadena**, y además se corrigieron
  las **cinco citas de prosa dentro de esos mismos motivos**, que también habían quedado
  apuntando a otra cosa. **Desvío del Scope IN, declarado.**
- **Aplicar en**: antes de presupuestar una inserción en un archivo grande de `src/`, buscar
  **TODOS** los registros que lo referencian por línea, no sólo el guardián que uno ya conoce.
  El barrido que sirve es `grep` del path del archivo en `test/`, no la memoria de la HU anterior.

## [2026-08-27] W3.3 (segunda pasada) — arreglé las citas ANTES de mi última edición

- **Error**: `cited-lines-guard` verde a media tarde, y **rojo en el gate final**: `G-C5` con 3
  citas y `G-C6` con 1. Las había arreglado, y después volví a editar `agent.ts` (el fix del
  `typeof` y el docblock), corriendo las líneas **otra vez**.
- **Fix**: re-derivadas por tercera vez (`477`, `886`, `900`), abriendo cada línea y confirmando el
  método contenedor por el `op: 'agentPublishDelete'` de al lado, y **recién ahí** el gate.
  ⚠️ Un detalle que costó un intento: renombrar `872→886` cuando ya existía una entrada `886`
  **colisiona**; hay que renombrar **de mayor a menor**.
- **Aplicar en**: el arreglo de citas por desplazamiento es **lo último que se toca**, después del
  formateador y después del último fix. Hacerlo antes es garantizar hacerlo dos veces — y la
  segunda es la que se olvida.
