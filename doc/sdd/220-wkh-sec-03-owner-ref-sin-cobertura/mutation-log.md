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
