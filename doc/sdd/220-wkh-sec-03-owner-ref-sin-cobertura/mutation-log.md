# Log de mutación — WKH-SEC-03 (AC-5)

> Protocolo: §10 del Story File (`story-HU-WKH-SEC-03.md:1105-1170`).
> Worktree: `/home/ferdev/.openclaw/workspace/wt-sec03` · Rama: `feat/220-wkh-sec-03-owner-ref-sin-cobertura`
> **Commit sobre el que se corrió toda la campaña: `a5bc8a9`** (base de la HU: `ef384b7`).
> Fecha: 2026-08-06.

Cada fila lleva **la salida real** de la corrida, no la esperada. Lo que no se pudo comprobar
dice literalmente "no se pudo verificar".

---

## 0. Baseline, re-medida en este worktree antes de la primera mutación (CD-8)

Comando —**no** `npx vitest run`, que en este shell colapsa la salida a una línea y se lleva
`Test Files`, `skipped` y la duración (H-10):

```
node ./node_modules/vitest/vitest.mjs run
```

Salida cruda sobre `a5bc8a9`, árbol limpio:

```
 Test Files  268 passed | 6 skipped (274)
      Tests  5327 passed | 19 skipped (5346)
   Duration  9.86s
```

La baseline del Story File (`5294 passed`, §H-3) es la de `ef384b7`, **antes** de los 7 archivos
de test de esta HU. El delta `5327 − 5294 = 33` son los tests nuevos. Toda mutación de abajo se
compara contra **5327**, no contra 5294.

## 0.1 Instrumento y disciplina de cada corrida

Cada fila se produjo con esta secuencia exacta, una mutación por vez:

```
sed -n '<N>p' <archivo>          # se pega el texto en el log ANTES de borrar  (CD-9)
sed -i '<N>d' <archivo>
git diff --stat                  # debe decir: 1 file changed, 1 deletion(-)   (Trampa A)
node ./node_modules/vitest/vitest.mjs run
git checkout -- <archivo>
git status --porcelain           # tiene que quedar sólo el untracked doc/audit/
```

**Las 16 mutaciones dieron `1 file changed, 1 deletion(-)` en su `git diff --stat`.** Ninguna se
descartó por mutante mal construido, y ninguna de las 11 líneas de producción era un comentario:
las 11 arrancan con `.eq('owner_ref'`, verificadas una por una con `sed -n` antes de borrarlas.

## 0.2 El asesino colateral que aparece en las 11 filas de producción: G-08 y G-09

Hay un efecto que **no** estaba previsto en §10 y que conviene declarar antes de leer la tabla:
cada vez que se borra una línea `.eq('owner_ref', …)` de un archivo de producción, el guardián de
`test/ownership-filter-guard.test.ts` se pone rojo por dos controles:

- **G-08** — la cadena mutada queda sin filtro y sin excepción, así que el guardián la reporta.
  Es el guardián haciendo exactamente su trabajo.
- **G-09** — borrar una línea corre hacia arriba todas las líneas siguientes del archivo, así que
  las excepciones que apuntan a líneas posteriores de **ese mismo archivo** dejan de coincidir con
  su sitio. Es un artefacto del método de mutación (borrado de línea), no una propiedad del sitio.

Por eso la columna "asesino" nombra **el test específico del sitio**; G-08/G-09 van aparte como
colateral. **Un mutante cuyo único asesino fuera G-08/G-09 contaría como SURVIVED** para lo que
esta HU mide, porque significaría que el test de propiedad del sitio no se enteró. No pasó en
ninguna de las 11.

---

## 1. Las 11 mutaciones de producción

| ID | Sitio | Texto exacto borrado | Veredicto | Asesino (test del sitio) | Colateral | Conteo crudo |
|---|---|---|---|---|---|---|
| M-01 | `src/services/receipt.ts:293` | `.eq('owner_ref', ownerRef)` | **KILLED** | `R-01 [receipt.ts:293]: A pide por id el recibo de B → null, y el id EXISTE en la tabla` | G-08, G-09 | `2 failed \| 266 passed \| 6 skipped (274)` · `3 failed \| 5324 passed \| 19 skipped (5346)` |
| M-02 | `src/services/agent.ts:549` | `.eq('owner_ref', ownerRef)` | **KILLED** | `AG-01 [agent.ts:549]: listMine(A) devuelve exactamente los agentes de A, nunca el de B` | G-08, G-09 | `2 failed \| 266 passed \| 6 skipped (274)` · `3 failed \| 5324 passed \| 19 skipped (5346)` |
| M-03 | `src/services/agent.ts:715` | `.eq('owner_ref', ownerRef)` | **KILLED** (escenario de entrelazado; la carrera no es alcanzable en producción hoy) | `AG-02 [agent.ts:715]: si la fila pasa a ser de B entre el pre-chequeo y el DELETE, el DELETE no la toca` | G-08, G-09 | `2 failed \| 266 passed \| 6 skipped (274)` · `3 failed \| 5324 passed \| 19 skipped (5346)` |
| M-04 | `src/services/llm/transform.ts:234` | `.eq('owner_ref', ownerId)` | **KILLED** (ver nota N-1: se lleva puesto el archivo entero, 6/6) | `TR-01 [transform.ts:234]` **y** `TR-01b [transform.ts:234]` | G-08, G-09 + `TR-00`, `TR-02`, `TR-02b`, `TR-03` | `2 failed \| 266 passed \| 6 skipped (274)` · `8 failed \| 5319 passed \| 19 skipped (5346)` |
| M-05 | `src/services/llm/transform.ts:278` | `.eq('owner_ref', ownerId);` | **KILLED** | `TR-02 [transform.ts:278]: la cadena del hit_count se arma acotada al dueño del caller` | G-08, G-09 | `2 failed \| 266 passed \| 6 skipped (274)` · `3 failed \| 5324 passed \| 19 skipped (5346)` |
| M-06 | `src/routes/payments.ts:384` | `.eq('owner_ref', callerKey.owner_ref)` | **KILLED** | `PD-01 [payments.ts:384]: A pide la disputa de B → 404 y el cuerpo NO trae los montos` | G-08, G-09 | `2 failed \| 266 passed \| 6 skipped (274)` · `3 failed \| 5324 passed \| 19 skipped (5346)` |
| M-07 | `src/services/spend-policy.ts:163` | `.eq('owner_ref', ownerId)` | **KILLED** (escenario de integridad ante fila inconsistente, no alcanzable desde ruta autenticada — ver H-5) | `SP-01 [spend-policy.ts:163]: list(K, dueño(K)) no devuelve la fila con key_id=K y owner_ref=B` + `SP-01b (anti-vacuidad)` | G-08, G-09 + **`spend-policy.test.ts` `AC-7: filters by key_id and owner_ref`** (preexistente — ver N-2) | `3 failed \| 265 passed \| 6 skipped (274)` · `5 failed \| 5322 passed \| 19 skipped (5346)` |
| M-08 | `src/services/spend-policy.ts:190` | `.eq('owner_ref', ownerId)` | **KILLED** (ídem M-07: integridad ante fila inconsistente, no aislamiento) | `SP-02 [spend-policy.ts:190]: delete(K, dueño(K), dest) no borra la fila de B y lanza OwnershipMismatchError` | G-08, G-09 + **`spend-policy.test.ts` `AC-7: deletes filtered by key_id + owner_ref + destination`** (preexistente) | `3 failed \| 265 passed \| 6 skipped (274)` · `4 failed \| 5323 passed \| 19 skipped (5346)` |
| M-09 | `src/services/spend-policy.ts:219` | `.eq('owner_ref', ownerId)` | **KILLED** (ídem M-07: integridad ante fila inconsistente, no aislamiento) | `SP-03 [spend-policy.ts:219]: hasAnyPolicy(K, dueño(K)) es false si la única fila con key_id=K es de B` | G-08, G-09 + **`spend-policy.test.ts` `AC-7: filters by key_id + owner_ref; true when rows exist`** (preexistente) | `3 failed \| 265 passed \| 6 skipped (274)` · `4 failed \| 5323 passed \| 19 skipped (5346)` |
| M-10 | `src/services/inbound-task.ts:316` | `.eq('owner_ref', ownerRef)` | **KILLED** (la función no tiene llamador de producción — el único ejercitador es el test) | `IT-01 [inbound-task.ts:316]: get(A, idDeB) → undefined, con el id PRESENTE en la tabla` | G-08, G-09 | `2 failed \| 266 passed \| 6 skipped (274)` · `3 failed \| 5324 passed \| 19 skipped (5346)` |
| M-11 | `src/services/inbound-task.ts:338` | `.eq('owner_ref', ownerRef)` | **KILLED** (idempotencia, no aislamiento — el ownerRef es server-side) | `IT-02 [inbound-task.ts:338]: dos dueños con el MISMO (source, external_ref) no dedupean entre sí` + `IT-02b` | G-08, G-09 | `2 failed \| 266 passed \| 6 skipped (274)` · `4 failed \| 5323 passed \| 19 skipped (5346)` |

**11 de 11 KILLED. Ninguna sobrevivió, y en las 11 el asesino incluye el test de propiedad del
sitio, no sólo el guardián.**

### N-1 · M-04 mata 6 de 6 tests del archivo, y por qué eso no lo invalida

La cadena de `getFromL2` (`src/services/llm/transform.ts:228-235`) termina en **`.single()`**. El
fixture compartido siembra la fila de A **y** la de B con la misma clave de caché
`(source, target, schema_hash)`. Sin el filtro por dueño, esa clave matchea **dos** filas y
`.single()` deja de resolver a una fila, así que el camino L2 se cae entero: se cae también
`TR-00`, que es el control de armado.

Lo que sí distingue el mutante del "se rompió todo" es **`TR-01b`**, que siembra **una sola** fila
y es de **B**: ahí `.single()` resuelve perfecto, A recibe la función de B y la ejecuta. Ese es el
escenario con consecuencia real, y muere solo.

La mutación es de una línea, el `git diff --stat` dio `1 file changed, 1 deletion(-)`, y los 8
tests rojos están todos dentro del archivo del sitio más los dos del guardián: no hay un tercer
archivo que se haya roto por otra razón.

### N-2 · Hallazgo: los tres sitios de `spend-policy` NO estaban sin medir. Ya tenían un espía.

El Story File presenta los 11 como sitios donde "borrás la línea y la suite entera queda
idéntica". **Para `spend-policy.ts:163`, `:190` y `:219` eso no es cierto, y lo midió esta
campaña**: cada uno de los tres mutantes puso rojo, además del test nuevo, un test **preexistente**
de `src/services/spend-policy.test.ts`:

| Mutante | Test preexistente que también murió | Su aserción |
|---|---|---|
| M-07 | `spend-policy.test.ts:292` · `AC-7: filters by key_id and owner_ref` | `expect(chain.eq).toHaveBeenCalledWith('owner_ref', 'user-1')` |
| M-08 | `spend-policy.test.ts:311` · `AC-7: deletes filtered by key_id + owner_ref + destination` | ídem, sobre el DELETE |
| M-09 | `spend-policy.test.ts:344` · `AC-7: filters by key_id + owner_ref; true when rows exist` | ídem, sobre `hasAnyPolicy` |

Los tres son **espías de llamada** sobre un mock que no aplica los filtros (el anti-patrón que
esta HU nombra): verifican que la cadena **se escribió** con esa columna y ese valor, no que la
consulta **aisló**. Es una garantía más débil que la de los tests nuevos —un espía no distingue
entre "filtró" y "escribió el filtro y la base lo ignoró"— pero **no es cero**, y decir que estos
tres sitios "no los mide nadie" era afirmar de más.

Lo que sí sigue siendo cierto de estos tres, y es lo que aportan SP-01/02/03: la propiedad se
prueba **sobre una tabla que aplica los filtros**, y con la declaración explícita de que el
escenario es integridad ante una fila inconsistente, no un IDOR alcanzable desde la ruta (H-5).

**No se cambió ningún test preexistente por este hallazgo.** Queda anotado acá.

---

## 2. Las 5 mutaciones del guardián

Un guardián sin mutación es el hallazgo que esta HU existe para cerrar, así que se le aplicó el
mismo trato. Acá la mutación no siempre puede ser "borrar una línea" (M-G1 planta, M-G2 borra una
entrada de 11 líneas, M-G4 sustituye), así que **cada fila lleva su `git diff` completo mostrado
antes de correr**, que es la versión fuerte del antídoto de la Trampa A: no hace falta confiar en
el conteo de líneas si se ve el diff entero.

| ID | Mutación | Diffstat real | Veredicto | Asesino | Conteo crudo |
|---|---|---|---|---|---|
| M-G1 | plantar una cadena sintética sin filtro **en el árbol real**: se agrega al final de `src/services/receipt.ts` la línea `export const __synthUnfiltered = () => supabase.from('a2a_receipts').select('*').eq('id', 'x');` | `1 file changed, 1 insertion(+)` | **KILLED** | **G-08** (+ G-09) | `1 failed \| 267 passed \| 6 skipped (274)` · `2 failed \| 5325 passed \| 19 skipped (5346)` |
| M-G2 | borrar **UNA** entrada de `test/ownership-filter-guard.exceptions.ts` (la de `src/adapters/escrow/schema-preflight.ts:142`, `probe-de-esquema`) | `1 file changed, 11 deletions(-)` | **KILLED** | **G-08** (+ G-09) | `1 failed \| 267 passed \| 6 skipped (274)` · `2 failed \| 5325 passed \| 19 skipped (5346)` |
| M-G3 | `deriveOwnerTables` devuelve `∅`: se borra `withOwner.add(table);` (`scanner.ts:269`) | `1 file changed, 1 deletion(-)` | **KILLED** | **G-01** (+ G-02, G-09). **G-08 quedó VERDE** — ver N-3 | `1 failed \| 267 passed \| 6 skipped (274)` · `3 failed \| 5324 passed \| 19 skipped (5346)` |
| M-G4 | el guardián busca `ownerRef` en vez de `owner_ref`: `scanner.ts:76`, `const OWNER_COLUMN = 'ownerRef'` | `1 file changed, 1 insertion(+), 1 deletion(-)` | **KILLED** | **G-07** (+ G-03, G-08, G-09) | `1 failed \| 267 passed \| 6 skipped (274)` · `4 failed \| 5323 passed \| 19 skipped (5346)` |
| M-G5 | se quita la resolución de constantes: se borra `if (/^[A-Za-z_$][\w$]*$/.test(rawArg)) return consts.get(rawArg) ?? null;` (`scanner.ts:453`) | `1 file changed, 1 deletion(-)` | **KILLED** | **G-05** (+ G-02, G-09) | `1 failed \| 267 passed \| 6 skipped (274)` · `3 failed \| 5324 passed \| 19 skipped (5346)` |

> Nota (fix-pack del CR): la línea que M-G3 borró, `withOwner.add(table);`, vive dentro de
> `deriveTables`. El envoltorio `deriveOwnerTables` que la fila nombra estaba importado en el test
> y nunca invocado, así que se borró (MNR-2); el mutante y su veredicto no cambian.

### N-3 · M-G3 confirmó el modo de falla silencioso, y confirmó que el control de armado lo tapa

Es la fila que más importa de las cinco, y la salida real coincide con lo que §10 predecía:

- **G-01 se puso rojo** — el control de armado nota que el conjunto de tablas quedó vacío.
- **`★ G-08` NO aparece en la lista de tests rojos: quedó VERDE.** Con `∅` tablas el escáner no
  encuentra ninguna cadena, `UNFILTERED` queda vacío, y el test estrella pasa **afirmando que no
  hay ninguna cadena sin filtro**. Ese es exactamente el modo de falla que dejó 23 filtros sin
  medir: un instrumento que se degrada a "no encuentro nada" y reporta verde.

Sin G-01, M-G3 sería un mutante **SURVIVED** con el guardián entero en verde. Con G-01, muere.

### N-4 · M-G1 y M-G2 tienen la misma firma de muerte, y no son el mismo mutante

Las dos ponen rojos `G-08` y `G-09` con el mismo conteo (`2 failed | 5325 passed`). §10 avisa que
dos firmas idénticas pueden significar un mutante mal construido, así que se comparó **el hallazgo
que reporta el rojo**, no sólo el nombre del test:

```
M-G1 →  Hallazgos:
          src/services/receipt.ts:304 · a2a_receipts · select
M-G2 →  Hallazgos:
          src/adapters/escrow/schema-preflight.ts:142 · a2a_payment_intent_debit_signatures · select
```

Son sitios distintos, y cada uno es el que la mutación tocó. La coincidencia de firma es una
propiedad del contrato de G-08 —"cadena sin filtro **y** sin excepción"— que tiene dos formas de
violarse: agregando una cadena o sacando una excepción. Las dos formas se probaron y las dos
mueren.

Por qué G-09 acompaña en las dos: su última aserción es
`expect(UNFILTERED.length).toBe(OWNERSHIP_FILTER_EXCEPTIONS.length)` (`ownership-filter-guard.test.ts:329`).
M-G1 la rompe por izquierda (42 ≠ 41) y M-G2 por derecha (41 ≠ 40).

---

## 3. Resultado

**16 mutantes, 16 KILLED, 0 SURVIVED.**

- Las **11 de producción**: en las 11 murió el test de propiedad del sitio, no sólo el guardián.
- Las **5 del guardián**: el guardián reporta (M-G1), su lista de excepciones es portante (M-G2),
  su degradación silenciosa la caza el control de armado (M-G3), la comparación de la columna es
  estricta (M-G4) y resuelve constantes de módulo (M-G5).

Estado del árbol al cerrar la campaña, re-medido:

```
 Test Files  268 passed | 6 skipped (274)
      Tests  5327 passed | 19 skipped (5346)
   Duration  9.91s
```

Idéntico a la baseline de §0. `git diff --stat HEAD -- src` **vacío**: las 12 mutaciones que
tocaron archivos bajo `src/` (M-01..M-11 y M-G1) se revirtieron con `git checkout --` y se
verificó el árbol después de cada una (CD-1, AC-7).

### Lo que esta campaña NO midió, y no hay que leerle de más

- **Que los 11 filtros funcionen contra Postgres.** El falso de `owner-scoped-fake.ts` aplica los
  `.eq()` que el servicio pide; que PostgREST haga lo mismo con el `SERVICE_KEY` es una suposición
  del método, no algo que esta campaña haya observado. **No se pudo verificar** acá.
- **Que el valor del filtro sea el correcto.** Todos estos mutantes borran el filtro entero. Un
  mutante que cambiara `ownerRef` por otro owner es otra clase de mutación y **no se corrió**.
- **Los 12 sitios de WKH-SEC-04.** Fuera del corte, sin mutar.
- **Que la mutación de un `insert`/`upsert` muera.** Están fuera del alcance del guardián por
  diseño (§8.W0.1 regla 4) y no se mutaron.

---

## 4. Fix-pack del Adversarial Review (AR `6c9ad1a` → RECHAZADO)

Dos mutantes nuevos, los dos del AR, los dos aplicados **de verdad** sobre el árbol y con la
salida real pegada. El árbol se restauró después de cada uno (`git status --porcelain` sin
archivos de producción modificados).

### M-G6 · El ataque que M-G3 no cubría: degradar el conjunto de tablas PARCIALMENTE

M-G3 vació el conjunto entero y lo cazaron G-01, G-02, G-08 y G-09. El AR atacó por el modo de
falla más probable de un parser que casi funciona: que se coma **algunas**.

**La mutación**, en `deriveTables` (`ownership-filter-guard.scanner.ts`), condicionando el
`withOwner.add(table)` para excluir `a2a_arbiter_nonces`, `a2a_inbound_tasks`,
`a2a_key_spend_policies` y `a2a_payment_vouchers` — cuatro tablas elegidas porque **todas sus
cadenas están filtradas hoy**, así que el conteo de `UNFILTERED` no se mueve.

**ANTES del fix (guardián en `6c9ad1a`, 10 controles):**

```
Paso 1 · sólo el mutante            → Tests  10 passed (10)
Paso 2 · mutante + una cadena real sin filtro agregada a `spend-policy.ts`
                                    → Tests  10 passed (10)
Paso 3 · CONTROL, escáner sano + esa misma cadena
   × ★ G-08 ... src/services/spend-policy.ts:232 · a2a_key_spend_policies · select
   × G-09   ... expected 42 to be 41
                                    → Tests  2 failed | 8 passed (10)
```

O sea: **SURVIVED**, y con el guardián ciego se podía después agregar una cadena sin filtro sobre
una tabla de política de gasto sin que nada se pusiera rojo.

**Causa medida**: los pisos de G-01 (`>= 50` / `>= 15`, reales 62 / 21) y de G-02 (`>= 90` /
`>= 60`, reales 101 / 87) tienen holgura de sobra. Un piso protege contra el conjunto **vacío**,
no contra el **sesgado**.

**El fix — dos invariantes de consistencia, ningún número nuevo:**

- **G-11**: un SEGUNDO lector de `src/types/database.types.ts`, escrito con otro algoritmo
  (parte el archivo en bloques por tabla y pregunta por `\bowner_ref\b` en el bloque entero, en
  vez de exigirlo dentro de `Row:` a 10 espacios), y los dos conjuntos tienen que coincidir. Vive
  en el archivo del test y no en el escáner, a propósito.
- **G-12**: toda tabla que el árbol NOMBRA en un `supabase.from(...)` y que declara `owner_ref`
  tiene que estar dentro del universo con el que el guardián barre. Es la consecuencia de
  seguridad, y no envejece: una migración que agregue una tabla mueve los dos lados juntos.

**DESPUÉS del fix, el mismo mutante (paso 1 solo, sin necesidad de la cadena):**

```
 × G-11: los DOS lectores del archivo de tipos dan el mismo conjunto de tablas con dueño
   soloOraculo: ["a2a_arbiter_nonces","a2a_inbound_tasks","a2a_key_spend_policies","a2a_payment_vouchers"]
 × G-12: toda tabla con dueño que el árbol NOMBRA está dentro del universo del guardián
   ["a2a_arbiter_nonces","a2a_inbound_tasks","a2a_key_spend_policies","a2a_payment_vouchers"]
      Tests  2 failed | 10 passed (12)
```

**KILLED**, y muere en el **paso 1**: nombra las cuatro tablas exactas, antes de que exista
ninguna consulta vulnerable.

⚠️ **Lo que este cruce NO caza, y hay que decirlo**: los dos lectores comparten UNA suposición —
que dentro de `Tables:` cada tabla abre con su nombre a 6 espacios. Un cambio de formato del
archivo generado rompe a los dos a la vez y G-11 sigue en verde. Para ese caso el control es el
piso de G-01, que es un número y sí envejece. **No se probó** un mutante de esa clase.

### M-G7 · La excepción que miente sobre qué sitio describe (MNR-2)

**La mutación**: en la entrada de `receipt.ts:192`, poner `table: 'registries', verb: 'delete'`
sobre lo que en realidad es un `update` a `a2a_receipts`.

**ANTES**: `Tests  10 passed (10)`. La clave del match era sólo `archivo:línea`; `table` y `verb`
no los comparaba nadie, y el `reason` se lee a la luz de esos dos campos.

**DESPUÉS** (G-10 ampliado):

```
 × G-10: toda excepción tiene categoría de la unión cerrada y motivo no vacío
   "src/services/receipt.ts:192 · la entrada dice registries/delete · la cadena es a2a_receipts/update"
      Tests  1 failed | 11 passed (12)
```

**KILLED.**

### M-G8 · El handler de señal que NO alcanzaba (MNR-3)

El AR pidió `try/finally` + `SIGINT` en `scripts/eq-sweep.mjs`, que muta producción in-place. Se
agregaron, **y no funcionaron**. Medido: `kill -INT` al proceso **no imprimió nada y no paró
nada** — el barrido siguió hasta `# KILLED 46`, y un `git status` a mitad de camino mostraba
`M src/services/identity.ts`.

**La causa**: registrar un listener de señal le saca a la señal su acción por defecto (matar el
proceso) y la convierte en un callback que espera al event loop. El barrido era un `for` 100%
sincrónico con `spawnSync` adentro: nunca le devolvía el control, así que el callback quedaba
encolado para siempre. **El handler solo empeoraba el original**: antes Ctrl-C mataba en el acto
dejando el archivo mutado; después Ctrl-C no hacía nada.

**El fix**: un `await new Promise(r => setImmediate(r))` al principio de cada iteración, con el
árbol ya restaurado.

**Verificación, ejecutando**:

```
# SIGINT — abortando el barrido.
proceso: MUERTO
git status --porcelain (worktree): CERO archivos de producción modificados
```

### Lo que este fix-pack NO midió — actualizado por el fix-pack del CR

> El punto «que G-11/G-12 cacen una degradación del formato del archivo de tipos» decía
> **«no se corrió ese mutante»**. Se corrió en el fix-pack del CR: es **M-G9**, §5. La forma
> resultó más angosta y más barata que "cambio de formato" — alcanza con quotear **una** clave —
> y ahora la caza **G-13**.

### Los números del F1 que este fix-pack corrigió midiéndolos

| Decía | Lo medido | Cómo |
|---|---|---|
| «23 filtros que ningún test mira» | **de los 23, acá se midieron 11**: 8 sin ningún test que los mirara y 3 con espía preexistente. De los otros 12 (SEC-04) esta campaña no midió nada | borrando `spend-policy.ts:163`, `spend-policy.test.ts` da `1 failed \| 17 passed (18)` con `× AC-7: filters by key_id and owner_ref`, así que esos tres NO estaban sin mirar (§N-2). El «20» = 23 − 3 mezcla los 11 medidos con los 12 heredados del barrido de A1 y **no se debe citar como medido** |
| «~87 líneas» para el barrido completo | **46** | `--all` muta 46. El 87 es `.eq('owner_ref'` en cualquier posición de `src/` **incluyendo tests** — un número que el guion nunca usó |
| «~22 min» el barrido completo | **≈ 8-9 min**, extrapolado | 26,08 s medidos para `--all` con el guardián solo (46/46 KILLED, ~0,57 s c/u) + 10,47 s medidos de suite completa. **No se corrió** `--all` contra la suite entera |
| «18 tablas con `owner_ref`» | **21** de 62 | `deriveTables` + el segundo lector de G-11, que coinciden |

### Lo que este fix-pack NO midió

- **Que G-11/G-12 cacen una degradación del formato del archivo de tipos.** No se corrió ese
  mutante acá. **Se corrió en el fix-pack del CR: §5, M-G9.**
- **Que los `supabase.rpc(...)` estén libres de IDOR.** Son 42 call-sites en 13 archivos y quedan
  enteros fuera del guardián. Se leyó el caso de `a2a_solana_settle_intents` y no se encontró un
  IDOR vivo; los otros 42 **no se auditaron acá**. Queda declarado en el punto 9 del docblock.
- **Un barrido `--all` contra la suite completa.** Sólo se corrió contra el guardián.

---

## 5. Fix-pack del Code Review (CR `16847c3` → RECHAZADO)

### M-G9 · La cabecera QUOTEADA: el agujero compartido de G-11/G-12, medido

El CR reprodujo que la suposición que los dos lectores comparten no es sólo el **formato** del
archivo (un cambio global), sino el **juego de caracteres del nombre**, y que eso ciega **una
tabla por vez** — justo por debajo de los pisos de G-01 (`>= 50` sobre 62 reales, `>= 15` sobre
21). Se reprodujo acá **ejecutando**, en tres pasos, sobre `16847c3` con los 12 controles:

**La mutación**, en `src/types/database.types.ts:664`, sin tocar la indentación:

```
-      a2a_key_spend_policies: {
+      "a2a_key_spend_policies": {
```

`git diff --stat` → `1 file changed, 1 insertion(+), 1 deletion(-)`.

**ANTES del fix (guardián en `16847c3`, 12 controles):**

```
Paso 1 · sólo el mutante                                   → Tests  12 passed (12)
Paso 2 · mutante + `export const __synthUnfiltered = () =>
          supabase.from('a2a_key_spend_policies').select('*').eq('id','x');`
          agregada al final de `src/services/spend-policy.ts`
                                                            → Tests  12 passed (12)
Paso 3 · CONTROL: los tipos restaurados y esa misma cadena todavía puesta
   × G-09 ... AssertionError: expected 42 to be 41 // Object.is equality
                                                            → Tests  2 failed | 10 passed (12)
```

*(Del paso 3 se pegó la salida de G-09, que es la que quedó capturada en la corrida; el nombre del
otro rojo es `★ G-08`. El **mismo control re-corrido después del fix**, con los 13 controles, sí
tiene su hallazgo completo: `× ★ G-08 → src/services/spend-policy.ts:230 · a2a_key_spend_policies ·
select` y `× G-09 → expected 42 to be 41`, `Tests 2 failed | 11 passed (13)`.)*

O sea: **SURVIVED**, y con el guardián ciego a esa tabla el IDOR era invisible. Y como el
`UNFILTERED` de esa tabla no se mueve, tampoco se movía ningún conteo.

**El fix — G-13, y ataca por el otro lado.** G-11 y G-12 preguntan *"¿qué tablas hay?"*, y una
cabecera con otra sintaxis no es un error para esa pregunta: simplemente no existe. G-13 invierte
la pregunta y clasifica **todas** las líneas a 6 espacios de adentro de `Tables:` en tres cajas
conocidas —cabecera parseada, cierre, comentario— y exige que **la cuarta caja esté vacía**.

Medido sobre el archivo de hoy: **125 líneas a 6 espacios dentro de `Tables:` = 62 cabeceras + 62
cierres `};` + 1 apertura de comentario** (`database.types.ts:1054`, el `COMMENT ON TABLE` de
`a2a_solana_settle_intents`); el cuerpo de ese comentario va a 7 espacios y no entra. *(El CR
declaró «62 cabeceras, 63 `};`»; contadas con el instrumento de G-13 son 62 y 62 más la línea del
comentario, y las tres suman los mismos 125.)*

**DESPUÉS del fix, el mismo mutante, paso 1 solo:**

```
 × G-13: ninguna cabecera de tabla del archivo de tipos quedó SIN PARSEAR
AssertionError: ... : expected [ Array(1) ] to deeply equal []
+ [
+   "database.types.ts:664 → \"a2a_key_spend_policies\": {",
+ ]
      Tests  1 failed | 12 passed (13)
```

**KILLED**, en el paso 1, nombrando el archivo, la línea y el texto exacto — antes de que exista
ninguna consulta vulnerable. Árbol restaurado con `git checkout -- src/types/database.types.ts` y
`git checkout -- src/services/spend-policy.ts`; `git status --porcelain` sin archivos de
producción modificados.

**Lo que G-13 sigue sin cubrir**: un cambio de indentación (si `Tables:` deja de estar a 4
espacios o las tablas a 6, las tres cajas quedan vacías a la vez). Contra eso están sus dos
controles de armado —`cabeceras.length === ORACLE_BLOCKS.size` y `>= 50`— y el piso de G-01.
**Ese mutante no se corrió.**
