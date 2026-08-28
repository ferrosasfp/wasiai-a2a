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
las mira**. Arreglarlas violaría CD-9 (`discovery.ts` y el camino del dinero están en Scope OUT):

- `src/services/discovery.ts` cita un rango de `services/agent.ts` para el SELECT sin `limit` de
  `listAsAgents`.
- `src/services/orchestrate.ts` cita una línea de `services/agent.ts` para el SELECT de
  `getBySlugAsAgent`.
- `src/services/agent.ownership.test.ts` cita `agent.ts` **cinco veces**: dos para `listMine`, dos
  para el chequeo de dueño del `delete` y una para su `return`.

⚠️ **PROVENANCE — corregida en la iteración 1 (CR-it1/MNR-3).** Acá decía que "la inserción de W1.B
corrió estas dos", y es **FALSO**: **las tres ya estaban podridas en `091db28`**, antes de que esta
HU tocara nada. Reproducido abriendo el árbol base con `git show 091db28:src/services/agent.ts`:
`listAsAgents` vivía en la línea 505 y la cita dice `429-440`; `getBySlugAsAgent` en la 578 y la
cita dice `526`; `listMine` en la 598 y la cita dice `549`; el `delete` en la 798 y las citas dicen
`715`/`721`. Esta HU las **desplazó más**, no las rompió. La conclusión no cambia —se dejan como
están, y lo que se agrega es que estén escritas— pero **atribuirle a este trabajo un daño que ya
existía es exactamente la clase de afirmación que este archivo existe para no repetir**, y además
apaga la búsqueda de la causa real.

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
  `row.payout_wallet !== null && row.payout_wallet.trim() !== ''`. Los tres llamadores entran a
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

---

# FIX-PACK · iteración 1 (AR + CR RECHAZADO) — 2026-08-27

## [2026-08-27 20:4x] BLQ-1 — Tres mutantes vivos: la mitad de completitud sólo se probaba SALTEÁNDOSE la función que produce el dato

- **Error**: `evaluarCompletitud` tenía sus dos ramas `sin-dato` **sin un solo test que las
  ejercitara por el camino real**. Los fixtures de T-C3/T-C4 traían **siempre**
  `hasPayoutWallet: true`, y los únicos tests que tocaban `sinDato` se lo inyectaban **directo a
  `classify`**. Resultado medido: tres mutantes con la suite **35/35 verde**, y uno de ellos
  produciendo `exit 0 CONFORME … comparados=1 sindato=0` sobre algo que nunca se midió.
- **Causa raíz**: probar la escalera con `obs` sintético es barato y da sensación de cobertura
  por fila, pero **corta el cable entre el productor del dato y el clasificador**. La invariante
  que el docblock declara como razón de ser de la HU —*"un dato AUSENTE no es un dato bueno"*—
  vivía entera en ese cable. Y la asimetría lo delata: en la mitad de **deriva** el mismo mutante
  muere (T-J1/T-J2 corren por `main()`), así que fue olvido, no diseño.
- **Fix**: `T-C6`, un único test **por `main()`** con los dos fixtures que faltaban (registro
  ausente y registro sin el booleano) que afirma **tres** cosas: `exit === CONFIG`, `sindato=1`
  y **`comparados=0`**. Las tres hacen falta: el exit mata M8 y M9; **sólo `comparados=0` mata a
  M14**, que deja el exit correcto y vacía de significado al contador que la fila anti-vacuidad y
  su control positivo leen como "el chequeo ejecutó".
- **Aplicar en**: cuando una función pura produce un estado y otra lo clasifica, **un test que le
  pasa el estado a mano no prueba la primera**. Al menos uno tiene que entrar por el punto de
  entrada real. Y el contador que un control positivo lee es parte del contrato: se afirma su
  valor exacto, no `> 0`.

## [2026-08-27] BLQ-2 / MNR-2 — Cuarta pasada de citas, y esta vez las de PROSA que ningún guardián mira

- **Error**: `test/ownership-filter-guard.exceptions.ts` decía que el dueño se compara en `:697`
  (update) y `:872` (delete). Reales: **`:711`** y **`:886`**. `:697` es la **firma** de `update`;
  `:872` es una apertura de docblock. Mismo error, viejo, en el comentario de
  `test/cited-lines-guard.citations.ts`.
- **Causa raíz**: los valores previos (`:633`/`:808`) eran **correctos** en `091db28`. El
  desplazamiento real de esa región fue **+78** y a estos dos se les aplicó **+64**, el delta de
  la **primera** pasada. O sea: **la re-derivación de la tercera vuelta llegó a `citations.ts` y
  no a `exceptions.ts`.** Sumar un delta es adivinar; abrir la línea es medir.
- **Fix**: re-derivadas **abriendo cada línea** y confirmando el método contenedor por el
  `op:` de al lado (`agentPublishUpdate` en `:711`, `agentPublishDelete` en `:886`). Verificado
  además que la tercera cita del mismo motivo (`:525`, pre-check de colisión de slug) **sí** es
  correcta. En `citations.ts` se agrega la advertencia de que esos dos números son prosa.
- **🔴 MEDIDO, y es el hallazgo**: con las dos citas apuntando a `:99999`/`:99998` —líneas que no
  existen en un archivo de 950— **`npm test` completo sale VERDE: `314 passed | 6 skipped (320)`,
  `6349 passed`**. No hay ningún rojo que confirmar porque **no hay guardián**. El silencio se
  midió en vez de suponerse. ⇒ **TD-370-EXCEPTIONS-SIN-GUARDIAN**, abajo.
- **Aplicar en**: una cita de línea **nunca** se actualiza sumándole el delta de otra pasada. Y
  cuando una corrección no tiene rojo posible, lo que se reporta no es "verificado": es **la
  medición de que nadie lo mira**.

## [2026-08-27] BLQ-3 — Una credencial revocada se reportaba como caída de producción

- **Error**: `/agents` con `401`/`403` caía en el `status !== 200` genérico ⇒ `INALCANZABLE(2)`
  con el texto *"esto NO dice que el catálogo esté mal"*. El propio docblock define `CONFIG` como
  *"yo no estoy en condiciones de preguntar"*, y el caso hermano —credencial **ausente**— ya salía
  `CONFIG(3)` nombrándola.
- **Causa raíz**: **ausente y revocada son el mismo hecho por dos códigos distintos**, y el
  segundo entró por el camino del error de transporte porque *llegó como un status HTTP*. La
  forma del error se comió su significado.
- **Fix**: partición explícita antes del genérico ⇒ `obs.credencialRechazada`, y una fila **4b**
  en la escalera (hermana de la 4: misma clase, misma variable nombrada, y **numerada `4b` a
  propósito para no correr los números del contrato del W0**). Leyenda del issue y docblock del
  workflow ampliados. Test `T-E5`, con el contraste de que un `503` del **mismo** listado sigue
  siendo `INALCANZABLE`.
- **Aplicar en**: antes de mandar un status al cajón de "el otro no contestó", preguntar **quién
  falló**. Un `4xx` de autenticación acusa a mi credencial; un `5xx` acusa al otro lado.

## [2026-08-27] BLQ-4 — El mensaje afirmaba que el catálogo estaba bien en la misma línea que decía `derivas=4`

- **Error**: `1 manifiesto caído + 4 derivas REALES` salía `exit=2` con *"esto NO dice que el
  catálogo esté mal"*. Quien confía en el exit code —que es lo que AC-8 le pide— se perdía las
  cuatro, y un solo manifiesto flaky enmascaraba la señal todos los días.
- **Causa raíz**: el principio correcto estaba **escrito** en el docblock de la fila 10 —*"si
  coexisten manda la que cuesta dinero"*— y aplicado entre 10 y 11, pero **no** a las filas 8 y 9,
  que van antes y no acusan a nadie. Que la colisión 10 vs 12 esté bien resuelta prueba que fue
  olvido y no diseño.
- **Fix elegido, y por qué**: de las dos salidas legítimas —mover 8/9 debajo de 10/11, o cambiar
  su mensaje— se tomó una **tercera que las domina**: el mismo `guard` que la fila 7 ya usa
  (`&& !acusaAlCatalogo`). Corrige el **exit code**, que es lo que el mensaje solo no arregla, y
  **deja las filas en el lugar que el contrato del W0 les da**, así que la escalera se sigue
  pudiendo auditar renglón por renglón contra el Story File. Mover las filas habría sido drift del
  contrato; cambiar sólo el mensaje habría dejado el exit mintiendo. Test `T-E6`, con las cuatro
  combinaciones puras: cuando **no** coexisten, 8 y 9 siguen ganando (T-E4b sigue verde).
- **Aplicar en**: cuando un docblock enuncia un principio de precedencia, **buscar todas las
  parejas donde aplica**, no sólo la que motivó escribirlo. Un principio aplicado en un solo lugar
  es una excepción disfrazada de regla.

## [2026-08-27] BLQ-5 — Repetí, para `owner_ref`, el defecto que estaba corrigiendo para `payout_wallet`

- **Error**: el párrafo de CD-23 decía *"la primera mitad sigue siendo cierta: `AgentRow` no las
  tipa"*, con antecedente **las tres** columnas (`owner_ref, payout_wallet, referrer_ref`).
  `AgentRow` **sí** tipa `owner_ref`, y lo tipaba igual en `091db28`.
- **Causa raíz**: el párrafo que se estaba corrigiendo hablaba de tres columnas como un bloque, y
  la corrección **heredó el sujeto plural sin re-verificarlo columna por columna**. Lo que protege
  a `owner_ref` no es el tipo: es que `mapRowToAgent` **no la emite** — **barrera de VALOR**, y el
  párrafo la vendía como de tipo. Cuatro renglones más abajo `referrer_ref` sí estaba
  singularizado bien, lo que muestra que el defecto es del sujeto colectivo, no del conocimiento.
- **Fix**: sujeto acotado a las dos columnas para las que la afirmación es cierta, y la barrera de
  `owner_ref` nombrada por lo que es. **Y el test que faltaba**: `T-S6` **deriva del fuente** que
  `AgentRow` declara `owner_ref` y no declara las otras dos, y exige que el párrafo diga eso.
  `T-S5` verificaba **que la edición ocurrió**, nunca que la frase superviviente fuera verdadera —
  la misma clase de guardián que mira la columna y no el valor.
- **Aplicar en**: cuando se corrige una afirmación sobre **N** cosas, se re-verifica **una por
  una**. Y un test de prosa que sólo busca `toContain` de la frase nueva no prueba nada sobre la
  frase vieja que quedó al lado: hay que anclar el test al **hecho derivado del fuente**.

## [2026-08-27] MNR — los cuatro que se arreglaron, y el que se difiere

- **MNR-CR-1** — `agent.ts` decía *"los **cuatro** llamadores"* nueve renglones después de decir
  *"sus **tres**"*, y el mismo número falso estaba en este archivo. Son **tres**. `T-S6` ahora los
  **cuenta sobre el fuente** y exige el número en palabras, acotado al docblock del tipo (el
  archivo habla de "los dos llamadores" de otra función, y esa frase es cierta y es de otra HU).
  ⚠️ *"las cuatro lecturas y las dos escrituras"* **es cierta y no se tocó**.
- **MNR-CR-2** — ver BLQ-2: mismo mecanismo, en el archivo donde esa lección está escrita.
- **MNR-CR-3** — **provenance corregida**, no la conclusión: la TD decía que *"la inserción de
  W1.B corrió estas dos"* y **las tres ya estaban podridas en `091db28`** (reproducido con
  `git show 091db28:src/services/agent.ts`: `listAsAgents` en 505 vs cita `429-440`,
  `getBySlugAsAgent` en 578 vs `526`, `listMine` en 598 vs `549`, `delete` en 798 vs `715`/`721`).
  Y `agent.ownership.test.ts` tiene **5** tokens podridos, no 1. Imputarle a este trabajo un daño
  preexistente apaga la búsqueda de la causa real.
- **MNR-4 (AR-2 = CR-4)** — los dos npm scripts tenían **cuerpo idéntico** y no fijaban
  `CHECK_MODE` ⇒ a mano daban `CONFIG(3)`. Peor: **`T-S4` clavaba el cuerpo duplicado**, así que
  su verde no validaba los scripts, **los congelaba**. Arreglados los dos **y el test con ellos**,
  que ahora además cruza el modo contra `MODOS`.
- **MNR-AR-1** — un `/discover` que contesta `200` con HTML o con `agents` que no es array
  **rompió su contrato**, no se cayó. Misma clase (el listado quedó sin leer igual), pero el
  detalle ahora lo distingue: `/discover 200 con un cuerpo del que no sale la lista de agentes`.
  Test `T-E7`.
- **MNR-CR-5** — `GET /agents` no está en la tabla de `doc/INTEGRATION.md`. Hueco
  **pre-existente y fuera de Scope IN** ⇒ **backlog, no fix-pack**. No se tocó.

## [2026-08-27] TD-370-EXCEPTIONS-SIN-GUARDIAN — declarada, medida, NO cerrada

`test/ownership-filter-guard.exceptions.ts` es el archivo que justifica **por qué una query NO
lleva filtro de ownership** — el artefacto que la sección *Security Conventions* de `CLAUDE.md`
manda auditar. Sus motivos citan líneas de `src/services/*.ts` **en prosa**, y **ningún guardián
las verifica**: no está en `CORTE_A_PATHS`, y el guardián de citas sólo declara entradas cuyo
`from` esté en ese corte.

**Medido, no supuesto** (arriba, BLQ-2): con dos citas apuntando a líneas inexistentes, la suite
completa sale verde. Un revisor que siga una de esas citas cae en un comentario, no encuentra el
chequeo, y **no puede validar la excepción**.

**Por qué no se cierra en este fix-pack**: meter el archivo en `CORTE_A_PATHS` obliga a declarar
**todas** sus citas de una vez y mueve los invariantes de conteo del guardián — es una HU propia,
no un renglón de un fix-pack de 5 bloqueantes. Queda escrita acá, con su medición, para que la
próxima no la descubra de nuevo.

## [2026-08-27] FIX-PACK · CUARTA pasada de citas — las rompió MI PROPIO arreglo de prosa

- **Error**: gate final del fix-pack en rojo con **3 tests / 7 sitios**: `G-C5` (3 citas movidas),
  `G-08` (4 cadenas "sin motivo escrito") y `G-09` (4 excepciones "que sobreviven a su sitio").
  Ninguno de los 7 es código que yo haya escrito: **los desplazó el párrafo de CD-23**, que pasó de
  6 a 9 renglones, y la reflow de "los tres llamadores", que sumó uno más.
- **Causa raíz**: exactamente la lección que este archivo ya tenía escrita —*"el arreglo de citas
  por desplazamiento es lo último que se toca"*— y que **no apliqué a un arreglo de PROSA**, porque
  no se siente una inserción: es un párrafo. Un comentario de 9 líneas donde había 6 mueve tanto
  como un `if`. **Los barridos miran lo que escribiste, no lo que desplazaste.**
- **Fix**: re-derivados los **once** anclas **abriendo cada línea** y confirmando el símbolo
  contenedor por el `async <método>(` de arriba y el `op:` de al lado — nunca sumando el `+4`, que
  es el error del BLQ-2 de este mismo fix-pack:
  - `exceptions.ts`: chains `450→454` (getSplitContextRow), `585→589` (listAsAgents),
    `625→629` (listPublisherAnchors), `658→662` (getBySlugAsAgent); `417` (getRow) **no se movió**.
  - prosa dentro de esas mismas razones: `:711→:715`, `:886→:890`, `:525→:529`,
    `:428-443→:428-447`, `:581→:585`.
  - `citations.ts` + los tokens en los fuentes citadores: `src/types/index.ts` `:477→:481` y
    `src/routes/agents.ownership.test.ts` `:886→:890` y `:900→:904`. **Renombrados de mayor a
    menor**, por la colisión que ya costó un intento en W3.3.
  ⚠️ **Desvío del Scope IN declarado**: se editaron `src/types/index.ts` y
  `src/routes/agents.ownership.test.ts`, que sólo contienen el número de la cita. Es la misma clase
  de desvío forzado que W4.2. ⛔ Y **CD-9 se respetó**: las 3 citas que deben quedar podridas viven
  en `discovery.ts`, `orchestrate.ts` y `src/services/agent.ownership.test.ts` —el del **service**,
  no el de la **ruta**— y **ninguna de las tres se tocó**.
- **Aplicar en**: un fix-pack que edita prosa en un archivo grande de `src/` **termina** con el
  barrido de citas, igual que uno que edita código. Y el rojo de `G-08` dice *"cadena sin motivo
  escrito"*, que **suena a un agujero de seguridad nuevo** y es un número de línea viejo: leer el
  código antes de creerle al mensaje.

### El gate del fix-pack, corrido completo y en orden, con el árbol staged

```
git add -A
npx tsc -p tsconfig.json --noEmit   → exit 0
npm run lint                        → Checked 520 files. No fixes applied.   exit 0
npm test                            → Test Files 314 passed | 6 skipped (320)
                                       Tests    6350 passed | 19 skipped (6369)   exit 0
```
Entrada del fix-pack: `520 · 314/320 · 6345/6364`. **+5 casos, CERO archivos nuevos** (T-C6, T-E5,
T-E6, T-E7 en la suite del chequeo; T-S6 en la del servicio) ⇒ los conteos de archivo de los README
**no se tocan**, y el guardián que los verifica corrió en verde dentro de ese `npm test`.
