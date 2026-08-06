# Story File — #221 · WKH-SEC-04: los 12 filtros por dueño del camino del dinero y las disputas

> F2.5 · NexusAgil QUALITY · 2026-08-06 · autor: `nexus-architect`
> Contrato autocontenido para el Dev. **Si algo no está acá, no está en el corte.**
>
> - **Rama**: `feat/221-wkh-sec-04-owner-ref-dinero-y-disputas`
> - **Worktree**: `/home/ferdev/.openclaw/workspace/wt-sec04`
> - **Base**: `b7fa4e7` (WKH-SEC-03 ya mergeada). **Todo `archivo:línea` de este documento está
>   anclado a ese commit.**
> - **SDD**: `doc/sdd/221-wkh-sec-04-owner-ref-dinero-y-disputas/sdd.md`
> - **Esta HU es SÓLO tests.** Cero líneas de producción.

---

## 1. Goal

WKH-SEC-03 dejó el instrumento completo y probó **11** de los 23 filtros `.eq('owner_ref', …)`
sin cobertura. Los **12** restantes —el camino del dinero y de las disputas— quedaron declarados
**«fuera del corte, sin mutar»** (`doc/sdd/220-wkh-sec-03-owner-ref-sin-cobertura/mutation-log.md:216`).
Esta HU escribe sus tests de propiedad.

**Los 12 ya los muté yo en F2, de cero, en este worktree. Los 12 sobreviven al comportamiento.**
La tabla con la salida está en §2.1. Tu trabajo es darlos vuelta.

---

## 2. Los hechos que gobiernan esta HU

### 2.1 · H-1 · Los 12 sitios existen, son consultas, y ninguno tiene test de comportamiento

Medido en `b7fa4e7`, mutando uno por uno y corriendo la suite completa después de cada uno:

| # | Sitio | Texto de la línea | Rojos **fuera** del guardián | Veredicto |
|---|---|---|---|---|
| 1 | `src/services/fee-split.ts:365` | `.eq('owner_ref', ownerRef)` | ninguno | **SURVIVED** |
| 2 | `src/services/fee-split.ts:538` | `.eq('owner_ref', ownerRef)) as { error: SupabaseError \| null };` | ninguno | **SURVIVED** |
| 3 | `src/services/fee-split.ts:618` | `.eq('owner_ref', ownerRef);` | ninguno | **SURVIVED** |
| 4 | `src/services/fee-split.ts:697` | `.eq('owner_ref', ownerRef)) as { error: SupabaseError \| null };` | ninguno | **SURVIVED** |
| 5 | `src/services/arbiter.ts:110` | `.eq('owner_ref', ownerRef)` | ninguno | **SURVIVED** |
| 6 | `src/services/arbiter.ts:1070` | `.eq('owner_ref', ownerRef)` | ninguno | **SURVIVED** |
| 7 | `src/services/arbiter.ts:1100` | `.eq('owner_ref', ownerRef)` | ninguno | **SURVIVED** |
| 8 | `src/services/arbiter/evidence.ts:57` | `.eq('owner_ref', ownerRef)` | ninguno | **SURVIVED** |
| 9 | `src/services/arbiter/evidence.ts:76` | `.eq('owner_ref', ownerRef);` | ninguno | **SURVIVED** |
| 10 | `src/services/arbiter/evidence.ts:96` | `.eq('owner_ref', ownerRef);` | ninguno | **SURVIVED** |
| 11 | `src/services/reconciliation.ts:1448` | `.eq('owner_ref', ownerRef)` | ninguno | **SURVIVED** |
| 12 | `src/adapters/escrow/debit-capture.ts:212` | `.eq('owner_ref', ownerRef)` | ninguno | **SURVIVED** |

**11 (SEC-03) + 12 = 23.** ✓ Los rótulos «11/12» se invirtieron dos veces en artefactos previos;
esta tabla sale del código, no de un rótulo.

### 2.2 · H-2 · ⚠️ EL HECHO MÁS IMPORTANTE: el guardián mata los 12 mutantes, y eso NO cuenta

Con WKH-SEC-03 mergeada, **quitar cualquiera de los 12 filtros pone en rojo `G-08` y `G-09`** de
`test/ownership-filter-guard.test.ts`. Salida cruda, **idéntica en los doce**:

```
 FAIL  test/ownership-filter-guard.test.ts > … > ★ G-08: ninguna cadena `select`/`update`/`delete` queda sin filtro y sin excepción
 FAIL  test/ownership-filter-guard.test.ts > … > G-09: ninguna excepción sobrevive a su sitio
 Test Files  1 failed | 267 passed | 6 skipped (274)
      Tests  2 failed | 5328 passed | 19 skipped (5349)
```

Eso es **el estado de partida, HOY, sin que exista un solo test tuyo**. `Test Files 1 failed` no es
una muerte: es la línea base del mutante.

**La regla de esta HU (CD-16)**: un mutante cuenta como `KILLED` **sólo si hay un rojo fuera de
`test/ownership-filter-guard.test.ts`**. Cero rojos de comportamiento ⟹ `SURVIVED`, aunque la suite
diga `1 failed`.

Por qué fallan los dos:
- `G-08` (`test/ownership-filter-guard.test.ts:579-596`) compara las cadenas sin filtro contra la
  lista de excepciones: tu mutación crea una cadena sin filtro y sin excepción.
- `G-09` (`:598-616`) además exige `expect(UNFILTERED.length).toBe(OWNERSHIP_FILTER_EXCEPTIONS.length)`
  (`:615`): pasa de `41 === 41` a `42 !== 41`.
- Y hay un **tercer** motivo si borrás una línea en `arbiter.ts`, `reconciliation.ts` o
  `fee-split.ts`: **11 de las 41 excepciones viven en esos archivos** (`arbiter.ts` 594/1178/1237/1270,
  `reconciliation.ts` 564/614/655/886/1129/1349, `fee-split.ts` 645) y el borrado les corre el
  número. Por eso el protocolo de §10 **prefiere el reemplazo al borrado**.

**Consecuencia para lo que escribas**: la frase «se puede borrar y la suite queda verde» es
**FALSA** para estos 12. Está PROHIBIDA en cualquier archivo que se mergee (CD-18). Es literalmente
el hallazgo BLQ-BAJO-3 del AR de SEC-03 (`adversarial-review.md:77`), donde esa misma frase quedó
textual en dos archivos después de dejar de ser cierta.

### 2.3 · H-3 · La línea base es `5330 passed | 19 skipped (5349)` en `b7fa4e7`

```
$ node ./node_modules/vitest/vitest.mjs run
 Test Files  268 passed | 6 skipped (274)
      Tests  5330 passed | 19 skipped (5349)
   Duration  10.14s
```

**No** es la de SEC-03 (`5294 | 19 (5313)` en `ef384b7`) ni la de A1. Si la tuya no da esto, **pará**:
toda la evidencia se compara contra este número (CD-8).

⚠️ **No uses `npx vitest run`**: colapsa la salida y perdés `skipped` y `Test Files`. Usá
`node ./node_modules/vitest/vitest.mjs run`. Si el worktree no tiene `node_modules`:
`ln -s /home/ferdev/.openclaw/workspace/wasiai-a2a/node_modules node_modules`.

### 2.4 · H-4 · Sólo TRES de los 12 necesitan entrelazado, y NO son los que dice SEC-03

El AC-3 del work-item de SEC-03 (`work-item.md:172-178`) pone `arbiter.ts:1070` y `:1100` entre los
que «sólo mueren con un test de entrelazado». **Medido: no.** Los dos son métodos del objeto
exportado `arbiterService` (`src/services/arbiter.ts:576`, `:1064`, `:1090`) y reciben
`(intentId, ownerRef)` como argumentos **independientes**: los matás llamándolos directo con el
`intentId` de B y el `ownerRef` de A, sobre una base perfectamente consistente. Sin hooks.

Los que **sí** necesitan entrelazado son los tres UPDATE de `fee-split.ts`: `:538`, `:618` y `:697`.
Motivo medido: la fila objetivo ya está determinada por `(orchestration_id, recipient_role)`, que es
el **UNIQUE de la tabla** (`supabase/migrations/20260705000000_wkh136_fee_splits.sql:40`, y no
incluye `owner_ref`). En una sola pasada, con o sin el filtro, el UPDATE toca la misma fila.

### 2.5 · H-5 · Al falso compartido le faltan dos cosas, y las dos las agregás vos

`src/services/__tests__/owner-scoped-fake.ts` (349 líneas) cubre **todos** los métodos que las 12
cadenas usan — verificado cadena por cadena, incluida la única con `order` + `limit`
(`debit-capture.ts:114-124`). Le faltan:

**(a) `onUpdateStart`.** El falso tiene `onDeleteStart` (`:267-274`) y su propio docblock declara la
ausencia del gemelo: *«Tampoco tiene `onUpdateStart` (E-1 sí lo tiene): el único entrelazado de este
corte es sobre un DELETE»* (`:54-55`). Lo necesitás para los tres sitios de H-4. Copiá la forma
exacta de `delete()` (`:267-274`): fijar el verbo, `touch()`, disparar el hook, devolver el builder
— **antes** de que se apliquen los filtros, que es lo que hace la carrera observable.

**(b) Un modelo de UNIQUE.** El `insert` del falso empuja la fila sin mirar nada (`:292-296`,
`:335-339`). El sitio 1 (`fee-split.ts:365`) necesita que un INSERT sobre un
`(orchestration_id, recipient_role)` ya ocupado devuelva `{ code: '23505' }`, porque el camino real
con el filtro puesto es `SELECT → null → INSERT → 23505 → 'in-progress'` (`fee-split.ts:404-407`).
Propuesta: `unique?: string[][]` opcional en `TableSpec` (`:97-105`).
**Si decidís no agregarlo**, tenés que (i) mockear `getPaymentAdapter` y (ii) **escribir en el header
del test** que el fixture ejercita un camino que la base real corta con un 23505. Las dos salidas
valen; **no decir cuál elegiste, no**.

⚠️ **`owner-scoped-fake.ts` lo usan los 6 archivos de propiedad de SEC-03.** Toda modificación es
**aditiva y con default inerte** (`onUpdateStart = null`, `unique = undefined`). El control es la
línea base exacta después de tocarlo (CD-24).

### 2.6 · H-6 · Dentro de este corte hay un test que se titula como lo que no mide

`src/services/arbiter/evidence.test.ts`:
- `:4-5` (docblock): *«Cubre la lógica determinística de readEvidence con **un doble de supabase
  fiel a la semántica de las 3 queries owner-guarded** (intent / vouchers / receipts)»*.
- `:44-45` (comentario): *«Doble encadenable **fiel**»*.
- `:49`: `eq: () => b`. **No aplica ningún filtro.** La respuesta la decide el nombre de la tabla en
  `wireTables` (`:62-67`).
- `:186`: el test se titula *«intent inexistente / **de otro owner** (PGRST116) → ArbiterError
  INTENT_NOT_FOUND»* y lo que hace es devolver un `{ code: 'PGRST116' }` enlatado (`:188`). El
  fixture tiene **un solo dueño**: `OWNER` es la única constante de dueño del archivo (`:36`).

Eso explica por qué los tres sitios de `evidence.ts` sobreviven teniendo archivo de test propio.
**No lo toques** (§9). Cubrí los tres desde un archivo nuevo.

### 2.7 · H-7 · Hay un 13.º sitio en el mismo archivo, «cubierto» sólo por un espía

`src/adapters/escrow/debit-capture.ts:120` **no** está entre los 23 porque **muere**: mutándolo,
`src/adapters/escrow/debit-capture.test.ts` se pone rojo. Pero lo que lo mata es
`expect(calls.eq).toContainEqual(['owner_ref', OWNER])` (`debit-capture.test.ts:533`), un **espía de
argumento** — y los dos dobles del archivo son `eq: () => builder` (`:79`, `:463`), o sea que no
aplican el filtro. DT-1 de SEC-03 dice por qué un espía no alcanza: pasa aunque el nombre de columna
esté mal escrito, y ese error deja al dueño sin ver **sus propias** filas.

**Qué hacer**: cubrilo en el mismo archivo nuevo del sitio 12 (es una línea más sobre un fixture que
ya vas a montar) y anotá en el log que **no forma parte de los 12** ni de la aritmética `11+12=23`.
**No amplía el corte.** Y **no toques** `debit-capture.test.ts`.

### 2.8 · H-8 · Este es el control negativo del instrumento

Ese mismo sitio 13.º es lo que prueba que la suite **puede** producir un rojo de comportamiento en
estos archivos. Sin este paso, «SURVIVED» es indistinguible de «la suite no corrió»:

```
$ # borrar src/adapters/escrow/debit-capture.ts:120
 FAIL  src/adapters/escrow/debit-capture.test.ts > T-7 reader query owner-guarded + most-recent (AC-7/191b) > WHERE valid ORDER BY captured_at DESC LIMIT 1 + eq(owner_ref); amount OK → devuelve la fila
 Test Files  2 failed | 266 passed | 6 skipped (274)
      Tests  3 failed | 5327 passed | 19 skipped (5349)
```

---

## 3. ⚠️ Las CUATRO trampas de medición. Leelas antes de mutar nada.

Las tres primeras ya ocurrieron en este repo. La cuarta salió el mismo día en otra HU.

### Trampa A — Falso KILLED por un mutante que rompe la sintaxis

**El antídoto de SEC-03 no alcanza acá.** Borrar la línea entera de `fee-split.ts:538`:

```
$ git diff --stat -- src/services/fee-split.ts
 src/services/fee-split.ts | 1 -
 1 file changed, 1 deletion(-)          ← el antídoto de SEC-03 dice "válido"

$ node ./node_modules/vitest/vitest.mjs run src/services/fee-split.test.ts
 FAIL  src/services/fee-split.test.ts [ src/services/fee-split.test.ts ]
 Error: Transform failed with 1 error:
 [PARSE_ERROR] Expected `,` or `)` but found `if`   src/services/fee-split.ts:539:5
```

Sobre la suite completa eso daba **`Test Files 22 failed | 246 passed`**. Veintidós archivos rojos
que leídos rápido son un KILLED espectacular y completamente falso: la mutación no quitó ningún
filtro, rompió el archivo. Causa: la línea lleva **cola de sintaxis** (`)) as { … };`) y borrarla se
come el paréntesis de cierre. Pasa en `:538` y `:697`.

**Antídoto (CD-17)**, después de mutar y **antes** de correr la suite:

```bash
./node_modules/.bin/esbuild <archivo> > /dev/null   # exit != 0 ⟹ mutante inválido, se descarta
```

Verificado en las dos direcciones: con el archivo sano imprime nada y sale `0`; con `:538` borrada
tira el `PARSE_ERROR` de arriba.

### Trampa B — Falso SURVIVED por elegir la línea con `grep | head -1`

`grep -n "eq('owner_ref'" archivo | head -1` puede devolverte un **comentario** — pasó en SEC-03 con
`task.ts:21`. La mutación no toca ninguna consulta y su «SURVIVED» es correcto y no dice nada del
código. **Antídoto**: seleccionar por número de línea y **pegar el texto antes de borrar**.

### Trampa C — El runner colapsando su salida

`npx vitest run` devuelve una sola línea y se pierden `skipped` y `Test Files`. **Antídoto**:
`node ./node_modules/vitest/vitest.mjs run`.

### Trampa D — `perl` con `\Q…\E` interpola `${…}` igual

Un patrón de mutación con plantilla no matchea, el archivo queda **intacto**, el proceso sale con
`0`, y la suite verde se lee como «el mutante sobrevive». **Antídoto (CD-23)**: mutar con `python3`
y `assert <patrón> in <línea>`. Todas las mutaciones del SDD se hicieron así.

### Y la trampa nueva de esta HU: Trampa E — el guardián mata todo (H-2)

Ver §2.2. `Test Files 1 failed` con `G-08`+`G-09` es el **punto de partida**, no el resultado.

---

## 4. Environment Gate (W-1) — antes de escribir una línea

```bash
cd /home/ferdev/.openclaw/workspace/wt-sec04

# 1. Estás en el commit correcto y en tu rama
git rev-parse HEAD                      # → b7fa4e79...
git rev-parse --abbrev-ref HEAD         # → feat/221-wkh-sec-04-owner-ref-dinero-y-disputas
git status --short                      # → vacío

# 2. node_modules (si falta)
[ -e node_modules ] || ln -s /home/ferdev/.openclaw/workspace/wasiai-a2a/node_modules node_modules

# 3. LA LÍNEA BASE. Con el binario directo (Trampa C), no con `npx vitest run`.
node ./node_modules/vitest/vitest.mjs run
#   → Test Files  268 passed | 6 skipped (274)
#   →      Tests  5330 passed | 19 skipped (5349)
#   Si NO da esto: PARÁ.

# 4. Los 12 sitios existen y son consultas (antídoto de la Trampa B)
python3 - <<'PY'
sitios = [('src/services/fee-split.ts',365),('src/services/fee-split.ts',538),
          ('src/services/fee-split.ts',618),('src/services/fee-split.ts',697),
          ('src/services/arbiter.ts',110),('src/services/arbiter.ts',1070),
          ('src/services/arbiter.ts',1100),('src/services/arbiter/evidence.ts',57),
          ('src/services/arbiter/evidence.ts',76),('src/services/arbiter/evidence.ts',96),
          ('src/services/reconciliation.ts',1448),
          ('src/adapters/escrow/debit-capture.ts',212)]
for p,n in sitios:
    t = open(p).readlines()[n-1]
    assert ".eq('owner_ref'" in t, (p,n,t)
    assert not t.lstrip().startswith(('*','//')), (p,n,'ES UN COMENTARIO')
    print(f'{p}:{n}  {t.rstrip()}')
PY
#   Las 12 tienen que salir. Ninguna es comentario.

# 5. Los exemplars existen
ls -l src/services/__tests__/owner-scoped-fake.ts \
      src/services/task.ownership.test.ts \
      src/services/agent.ownership.test.ts \
      src/services/receipt.ownership.test.ts \
      test/ownership-filter-guard.test.ts

# 6. CONTROL NEGATIVO del instrumento: la suite PUEDE ponerse roja en estos archivos
python3 - <<'PY'
p,n = 'src/adapters/escrow/debit-capture.ts',120
ls_ = open(p).readlines(); print(ls_[n-1]); assert ".eq('owner_ref'" in ls_[n-1]
del ls_[n-1]; open(p,'w').writelines(ls_)
PY
./node_modules/.bin/esbuild src/adapters/escrow/debit-capture.ts > /dev/null && echo "parse ok"
node ./node_modules/vitest/vitest.mjs run
#   → debe salir rojo `src/adapters/escrow/debit-capture.test.ts` (T-7), ADEMÁS de G-08/G-09
git checkout -- src/adapters/escrow/debit-capture.ts && git status --short

# 7. REPRODUCIR el hallazgo: uno de los 12 sobrevive al comportamiento
python3 - <<'PY'
p,n = 'src/services/arbiter/evidence.ts',57
ls_ = open(p).readlines(); print(ls_[n-1]); assert ".eq('owner_ref'" in ls_[n-1]
del ls_[n-1]; open(p,'w').writelines(ls_)
PY
./node_modules/.bin/esbuild src/services/arbiter/evidence.ts > /dev/null && echo "parse ok"
node ./node_modules/vitest/vitest.mjs run
#   → los ÚNICOS rojos deben ser G-08 y G-09. Cero rojos de comportamiento. Eso es SURVIVED.
git checkout -- src/services/arbiter/evidence.ts && git status --short
```

**Si el paso 6 no da rojo, el instrumento no mide y todo lo demás es ruido. Si el paso 7 da un rojo
de comportamiento, el árbol no es el que yo medí: pará y avisá.**

---

## 5. Archivos — crear y modificar

| # | Archivo | Acción | Wave |
|---|---|---|---|
| 1 | `src/services/__tests__/owner-scoped-fake.ts` | **modificar, aditivo**: `onUpdateStart` + `unique` (H-5) | W0 |
| 2 | `src/services/arbiter/evidence.ownership.test.ts` | **crear** — sitios 8, 9, 10 | W1/W2 |
| 3 | `src/services/arbiter.ownership.test.ts` | **crear** — sitios 5, 6, 7 | W1/W2 |
| 4 | `src/services/reconciliation.ownership.test.ts` | **crear** — sitio 11 | W1 |
| 5 | `src/adapters/escrow/debit-capture.ownership.test.ts` | **crear** — sitio 12 (+ el 13.º de H-7) | W1 |
| 6 | `src/services/fee-split.ownership.test.ts` | **crear** — sitios 1, 2, 3, 4 | W2/W3 |
| 7 | `test/ownership-filter-guard.test.ts` | **modificar sólo el header**, punto 8 (`:84-88`) — AC-7 | W4 |
| 8 | `src/services/arbiter/evidence.test.ts` | **modificar sólo el header**: 1 línea de comentario cruzado | W4 |
| 9 | `src/adapters/escrow/debit-capture.test.ts` | **modificar sólo el header**: 1 línea de comentario cruzado | W4 |
| 10 | `doc/sdd/221-…/mutation-log.md` | **crear** — AC-5 | W4 |
| 11 | `doc/sdd/221-…/_INDEX-row.md` | **crear** — la fila, staged | W4 |

**Nada más.** `git diff --name-only b7fa4e7` al cierre no puede tener ningún archivo bajo `src/` que
no matchee `*.test.ts` o `src/services/__tests__/`.

---

## 6. Los 12 sitios, uno por uno, con la receta del fixture

La pregunta que decide cada test es **de dónde sale el identificador**. Está verificada sitio por
sitio leyendo el llamador.

### Grupo A — argumentos cruzados sobre una base CONSISTENTE (7 sitios)

La función es exportada y recibe `(<identificador>, ownerRef)` como argumentos **independientes**.
El fixture es una base perfectamente consistente: cada fila con su dueño real. Lo que se cruza es el
**par de argumentos**. Un fixture de dos dueños los mata sin ningún hook.

#### A-1 · `src/services/arbiter/evidence.ts:57` — `readEvidence` (el más literal de los 12)

- **Función**: `readEvidence(intentId, ownerRef)`, exportada, `evidence.ts:48`.
- **Sin el filtro**: devuelve `authorized_usd`, `consumed_usd`, `chain_id`, `pay_to` y `seller_ref`
  del intent **de B** en vez de tirar `INTENT_NOT_FOUND` (`:59-62`, mapeo de `PGRST116`).
- **Fixture**: `a2a_payment_intents` con dos filas — `i-A` de `owner-A` e `i-B` de `owner-B`.
- **Test EV-01**: `readEvidence('i-B', 'owner-A')` → `rejects` `ArbiterError` con
  `code: 'INTENT_NOT_FOUND'`, **y la fila `i-B` sigue presente en la tabla** (si no, el test pasa
  por la tabla vacía).
- **Test EV-02 (anti-vacuidad, CD-6)**: `readEvidence('i-A', 'owner-A')` devuelve los valores de A.

#### A-2 · `src/services/arbiter.ts:1070` — `revertDisputeToOpen`

- **Función**: `arbiterService.revertDisputeToOpen(intentId, ownerRef)`, `arbiter.ts:1064`, sobre el
  objeto exportado de `:576`.
- **Cadena**: `.eq('id', intentId).eq('owner_ref', ownerRef).eq('status', 'disputed')` (`:1069-1071`).
- **Sin el filtro**: el intent `disputed` de B pasa a `open`.
- **Test AR-01**: `revertDisputeToOpen('i-B', 'owner-A')` → la fila `i-B` sigue en `disputed`.
- **Test AR-02 (anti-vacuidad)**: `revertDisputeToOpen('i-A', 'owner-A')` → `i-A` pasa a `open`.
- ⚠️ La función **traga** los errores (`:1072-1083`): no lanza. La aserción es sobre **el estado de
  la tabla**, no sobre un throw.

#### A-3 · `src/services/arbiter.ts:1100` — `holdArbitration`

- **Función**: `arbiterService.holdArbitration(intentId, ownerRef, meta)`, `:1090`.
- **Sin el filtro**: el intent `disputed` de B pasa a `arb_hold` (terminal), **y además** se emite un
  recibo (`:1106-1117`) y se persiste una fila de arbitraje (`:1118`) con el `ownerRef` de A.
- **Mockear**: `receiptService.emit` y lo que use `upsertArbitrationRow`.
- **Test AR-03**: `holdArbitration('i-B', 'owner-A', meta)` → `i-B` sigue en `disputed`.
- **Test AR-04 (anti-vacuidad)**: con `i-A` → pasa a `arb_hold`.

#### A-4 · `src/services/reconciliation.ts:1448` — `readBudgetUsd`

- **Función**: `reconciliationService.readBudgetUsd(keyId, ownerRef, chainId)`, `:1439`.
- **Sin el filtro**: devuelve el `budget` de la key de B en vez de `null`.
- **Fixture**: `a2a_agent_keys` con `k-A`/`owner-A` y `k-B`/`owner-B`, cada una con su `budget`.
- **Test RC-01**: `readBudgetUsd('k-B', 'owner-A', 8453)` → `null`, **con `k-B` presente**.
- **Test RC-02 (anti-vacuidad)**: `readBudgetUsd('k-A', 'owner-A', 8453)` → el budget de A.
- **Cabecera de `vi.mock` a copiar**: `src/services/reconciliation.test.ts:17-83` (es el módulo con
  más dependencias del corte).

#### A-5 · `src/adapters/escrow/debit-capture.ts:212` — `captureDebitSignature`

- **Función**: `captureDebitSignature({ intentId, ownerRef, keyId, chainId, finalAmountUsd, capture })`,
  `:152`.
- **Sin el filtro**: lee el `buyer_wallet` del intent **de B** (`:208-216`). Si la firma recupera esa
  wallet, el veredicto pasa de `SIGNER_MISMATCH` (`:236-242`) a **`valid`** (`:247`), y se persiste
  una firma de débito `valid` contra el intent de otro dueño.
- **Observable**: los argumentos del RPC `capture_debit_signature`, `p_status` y `p_reason`
  (`:275-287`). Es la decisión del código, no del doble.
- **Test DC-01**: intent `i-B` con `buyer_wallet: W`; firma que recupera `W`;
  `captureDebitSignature({ intentId: 'i-B', ownerRef: 'owner-A', … })` → `p_status: 'invalid'`,
  `p_reason: 'SIGNER_MISMATCH'`.
- **Test DC-02 (anti-vacuidad)**: el mismo caso con `i-A` (de `owner-A`, `buyer_wallet: W`) →
  `p_status: 'valid'`.
- **Mockear**: `recoverDebitAuthorization`, `getAdaptersBundle`, `resolveEscrowContract`,
  `getDefaultChainKey`. Cabecera a copiar: `src/adapters/escrow/debit-capture.test.ts:21-40`.
- **Extra declarado (H-7, sitio 13.º, FUERA de los 12)** — **DC-03**:
  `readValidDebitSignature({ intentId: 'i-B', ownerRef: 'owner-A', … })` → `null`, con la firma de B
  presente. Anotalo en el log como extra, no en la aritmética.

#### A-6 · `src/services/arbiter.ts:110` — el nonce del árbitro (**el más caro**)

- **Función**: `getOrCreateArbiterNonce` es **privada** (`:100`). Se llega por
  `settleArbitrationOnChain({ intentId, ownerRef, payTo, finalAmountUsd, chainId, keyId })`
  (exportada, `:175`), que la llama en `:208`.
- **Por qué el filtro importa**: `intent_id` es **PK** de `a2a_arbiter_nonces`
  (`supabase/migrations/20260713000003_wkh194_arbiter_nonces.sql:6`; `database.types.ts:44-49`,
  `isOneToOne: true`). Sin el filtro, el read-first devuelve el nonce **de B** (`:121`) y A lo reusa
  en el `resolveDispute` on-chain en vez de derivar el suyo. Es reuso de nonce en el camino de escrow.
- **Montaje requerido** (los gates en cascada de `:186-209`): `ESCROW_ARBITER_ENABLED='true'`,
  `getDefaultChainKey()`, `resolveEscrowContract()`, `readArbitrationConsent() → true`,
  `supportedTokens[0].decimals`, y el secreto del nonce.
- **Exemplar del montaje completo, ya escrito**: `src/services/arbiter.test.ts:1664-1740`
  (`describe('WKH-194 exactly-once + no-adivinable + defensa')`). Copiá el montaje; **no** el doble
  de supabase (`:340-430` aplica `id` y `status` pero **nunca** `owner_ref`).
- **Test AR-05**: con un nonce persistido para `i-B` de `owner-B`,
  `settleArbitrationOnChain({ intentId: 'i-B', ownerRef: 'owner-A', … })` **no** reusa ese nonce.
- **Si este sitio te bloquea**: está solo en W2 y no bloquea a nadie. Escalá antes de bajar la vara a
  un espía.

#### A-7 · `src/services/fee-split.ts:365` — el SELECT de idempotencia del leg

- **Función**: `settleFeeSplits({ orchestrationId, recipients, skipped })` (`:287`) → `chargeLeg`
  (`:344`) → SELECT `:360-366`.
- **De dónde sale `ownerRef`**: de `resolveRecipients` (`:215`, `:224`, `:238`), **server-side**, no
  del caller. Escribilo en el header: acá el dueño no lo elige nadie de afuera.
- **Por qué el estado es alcanzable**: el UNIQUE es `(orchestration_id, recipient_role)` **sin
  `owner_ref`** (`…wkh136_fee_splits.sql:40`). Una fila `(orch, 'creator')` de otro dueño existe si
  el creador resuelto cambió entre dos settlements de la misma orquestación.
- **Sin el filtro**: el SELECT devuelve esa fila; si está `charged`, `chargeLeg` vuelve
  `already-charged` **con el `tx_hash` ajeno** (`:379-383`): el fee se da por cobrado y **no se paga**.
- **Test FS-01**: fila `(orch1, 'creator', owner_ref: 'owner-B', status: 'charged', tx_hash: '0xBBB')`;
  `settleFeeSplits({ orchestrationId: 'orch1', recipients: [{ role: 'creator', ownerRef: 'owner-A', … }] })`
  → el leg **no** vuelve `already-charged` y **no** trae `0xBBB`.
- **Decisión que tenés que tomar y declarar** (H-5b): con `unique` en el falso, el resultado esperado
  con el filtro puesto es `in-progress`; sin `unique`, hay que mockear el adapter y decir en el
  header que el camino no es el real.

### Grupo B — fila inconsistente (2 sitios). **NO son aislamiento entre inquilinos.**

El filtro no es redundante con ningún otro, pero el estado que lo revela requiere una fila cuyo
`owner_ref` **no coincide** con el del recurso al que apunta su clave foránea. Ninguna restricción de
base lo impide (no hay CHECK ni FK compuesta que ligue los dos `owner_ref`), pero la aplicación no lo
produce.

**AC-3 te obliga a declararlo por escrito**, en el header del archivo y en la fila del log, con la
forma de `src/services/task.ownership.test.ts:277-283`. Presentar esto como aislamiento entre
inquilinos es exactamente la prosa que afirma de más que estas dos HUs existen para sacar del repo.

| Sitio | Cadena | Test | Consecuencia sin el filtro |
|---|---|---|---|
| `evidence.ts:76` | `.eq('intent_id', intentId).eq('owner_ref', ownerRef)` sobre `a2a_payment_vouchers` | **EV-03**: con un voucher `(intent_id: 'i-A', owner_ref: 'owner-B')`, `voucherCount` y `vouchersTotalUsd` cuentan sólo los de A | entra en `:85-89`, que son entradas de `classify` → **cambia el veredicto de la disputa** |
| `evidence.ts:96` | `.eq('session_id', intentId).eq('owner_ref', ownerRef)` sobre `a2a_receipts` | **EV-04**: con un recibo `(session_id: 'i-A', owner_ref: 'owner-B', receipt_type: 'budget_debit')`, `receiptSettleTotalUsd` no lo suma | entra en `:116-119`, otra entrada del veredicto |

### Grupo C — entrelazado obligatorio (3 sitios)

Los tres son UPDATE de `fee-split.ts` cuya fila objetivo ya está determinada por el UNIQUE
`(orchestration_id, recipient_role)`. **En una sola pasada, con o sin el filtro, la escritura toca la
misma fila.** Sólo se separan si la fila cambia de dueño entre la lectura previa y la escritura.

Receta: `fake.onUpdateStart = (table) => { … }` (lo agregás vos, H-5a), cambiando el `owner_ref` de la
fila a `owner-B`. Exemplar de la forma: `src/services/task.ownership.test.ts:285-317`.

| Sitio | Qué hay antes | Test | Aserción |
|---|---|---|---|
| `fee-split.ts:538` (UPDATE `charged` + `tx_hash`) | SELECT de idempotencia (`:360-366`) + INSERT (`:393`) | **FS-02** | la fila (ya de B) **no** queda `charged` con el `tx_hash` de A |
| `fee-split.ts:618` (`markLegFailed`) | lo mismo, por la rama de fallo (forzá el `settle` a fallar) | **FS-03** | la fila de B no queda `failed` con el `error_message` de A |
| `fee-split.ts:697` (`reverseFeeSplits`) | **pre-chequeo en JavaScript**: `:676-683` filtra `rows` por dueño en memoria y devuelve `ownership_mismatch` si no queda ninguna | **FS-04** | el leg de B **no** pasa a `reversed` |

**Declaración obligatoria en el header de estos tres**: la carrera **no es alcanzable hoy en
producción**, y el test igual vale como defensa en profundidad. Además, `reverseFeeSplits` **no tiene
ningún llamador de producción** — su docblock lo dice (`fee-split.ts:636`: «v1: NO se cablea a
orchestrate/compose») y se verificó con
`command grep -rn "reverseFeeSplits" src/ --include=*.ts` (sólo el propio `fee-split.ts` y una
mención en un comentario de `fee-charge.ts:677`).

### El límite honesto de los 7 del Grupo A

**Ninguno de los 12 es un IDOR alcanzable desde una ruta autenticada hoy.** Escribilo:

- Los cuatro de `arbiter`/`evidence`: el camino de producción es `POST /session/:id/dispute`
  (`src/routes/payments.ts:339`, que llama `openDispute(req.params.id, callerKey.owner_ref)`), y
  `openDispute` compara el dueño **en JavaScript** antes de seguir (`arbiter.ts:606-608`), así que un
  `intentId` ajeno se rechaza con `OWNERSHIP_MISMATCH` antes de llegar a estas consultas.
- `readBudgetUsd`: **un solo llamador de producción**, `driftCheck` (`reconciliation.ts:1402`), que le
  pasa el `ownerRef` sacado de la propia fila (`:1382`), detrás del gate de admin.
- `fee-split.ts:365`: el `ownerRef` no viene del caller (`resolveRecipients`, `:215/:224/:238`).

La propiedad que **sí** probás es la de la función: dado un par `(id, ownerRef)` que no se
corresponde, no entrega ni muta. **Decir que previene un IDOR sería afirmar de más.**

---

## 7. Exemplars — verificados, existen, los abrí

| Path | Qué copiar |
|---|---|
| `src/services/__tests__/owner-scoped-fake.ts:152-348` | `createOwnerScopedFake(spec)` — el falso completo |
| `src/services/__tests__/owner-scoped-fake.ts:130-135` | `applyFilters`: «Aplica EXACTAMENTE los filtros pedidos. Ni uno más». **Es lo único que no se parametriza** (`:22-29`) |
| `src/services/__tests__/owner-scoped-fake.ts:267-274` | `delete()` + `onDeleteStart` — **la forma exacta a replicar en `update()`** (`:247-252`) |
| `src/services/__tests__/owner-scoped-fake.ts:97-105` | `TableSpec` — dónde va `unique` |
| `src/services/__tests__/owner-scoped-fake.ts:137-150` | `unknownColumn` → `42703`: un nombre de columna mal escrito da un rojo ruidoso, no un «no matcheó nada» |
| `src/services/task.ownership.test.ts:285-317` | la receta del entrelazado |
| `src/services/task.ownership.test.ts:277-283` | **cómo se escribe** «esta carrera no es alcanzable hoy, y el test igual vale» |
| `src/services/task.ownership.test.ts:261-264` | el control de las dos direcciones |
| `src/services/task.ownership.test.ts:333-358` | el backstop estructural en UN test por archivo |
| `src/services/receipt.ownership.test.ts` (4,3 K) | el `*.ownership.test.ts` **más chico** de SEC-03: la forma mínima |
| `src/services/agent.ownership.test.ts` (5,9 K) | el que usa `onDeleteStart` |
| `src/services/llm/transform.ownership.test.ts` (10,8 K) | el que cubre **dos** sitios en un archivo |
| `src/services/reconciliation.test.ts:17-83` | la cabecera de `vi.mock` de `reconciliation.ts` |
| `src/adapters/escrow/debit-capture.test.ts:21-40` | la cabecera de `vi.mock` de `debit-capture.ts` |
| `src/services/arbiter.test.ts:1664-1740` | el montaje que llega al nonce (**el montaje sí, el doble no**) |

**Anti-patrones — NO los copies** (verificados con `command grep -n`):
`src/services/fee-split.test.ts:68` y `:83` (`chain.eq = () => chain`),
`src/services/arbiter/evidence.test.ts:49` (`eq: () => b`),
`src/adapters/escrow/debit-capture.test.ts:79` y `:463` (`eq: () => builder`),
`src/services/arbiter.test.ts:340-430` (aplica `id` y `status`, **nunca** `owner_ref`).
Los cuatro primeros tiran columna y valor.

---

## 8. Waves

### W0 — serial · el instrumento (aditivo). **Bloquea todo.**

1. Environment Gate completo (§4).
2. `src/services/__tests__/owner-scoped-fake.ts`, **aditivo** (H-5):
   - `onUpdateStart: ((table: string) => void) | null` en `OwnerScopedFake`, inicializado en `null`,
     disparado dentro de `update()` (`:247-252`) con la forma de `delete()` (`:267-274`).
   - `unique?: string[][]` en `TableSpec` (`:97-105`): si el `insert`/`upsert` choca contra una
     combinación ya presente, devolver `{ data: null, error: { code: '23505', message: … } }`.
   - Actualizar el docblock: hoy `:41-55` dice que no tiene `onUpdateStart` y por qué.
3. **Salida verificable**: `node ./node_modules/vitest/vitest.mjs run` da **exactamente**
   `Test Files 268 passed | 6 skipped (274)` · `Tests 5330 passed | 19 skipped (5349)`.
   Si cambia un número, el falso dejó de ser inerte: volvé atrás (CD-24).
4. `npx tsc --noEmit` y `npx biome check src/` antes de commitear (CD-12).

### W1 — Grupo A barato (5 sitios). Los cuatro archivos son paralelizables entre sí.

| Archivo | Tests |
|---|---|
| `src/services/arbiter/evidence.ownership.test.ts` | EV-01, EV-02 |
| `src/services/arbiter.ownership.test.ts` | AR-01..AR-04 |
| `src/services/reconciliation.ownership.test.ts` | RC-01, RC-02 |
| `src/adapters/escrow/debit-capture.ownership.test.ts` | DC-01, DC-02, DC-03 |

Cada archivo lleva **un** backstop estructural (BS-*, patrón `task.ownership.test.ts:333-358`).

### W2 — Grupo A caro + Grupo B

| Archivo | Tests | Declaración obligatoria en el header |
|---|---|---|
| `src/services/arbiter.ownership.test.ts` | AR-05 (`arbiter.ts:110`) | el montaje de gates que hace falta, y que el camino de producción pasa antes por el chequeo en JS de `openDispute` |
| `src/services/arbiter/evidence.ownership.test.ts` | EV-03, EV-04 | **Grupo B**: el estado requiere una fila cuyo `owner_ref` no coincide con el del intent al que apunta |
| `src/services/fee-split.ownership.test.ts` | FS-01 | qué elegiste: `unique` en el falso, o mockear el adapter |

### W3 — Grupo C, el entrelazado

`src/services/fee-split.ownership.test.ts`: FS-02, FS-03, FS-04. Header con la declaración de §6
(carrera no alcanzable + `reverseFeeSplits` sin llamador).

### W4 — evidencia y doctrina

1. `doc/sdd/221-…/mutation-log.md` (AC-5): una fila por sitio, con el protocolo de §10.
2. `test/ownership-filter-guard.test.ts`, **sólo el punto 8 del header** (`:84-88`). Hoy dice:
   *«Entre el merge de WKH-SEC-03 y el de WKH-SEC-04 este guardián está verde con 12 sitios que no
   tienen test de propiedad … Para esos 12, lo que se sabe es que el filtro está escrito. Que funcione
   no lo midió nadie todavía.»* Reescribilo con lo medido. **PROHIBIDO** reemplazarlo por otra
   afirmación de más: lo que queda sin cubrir sigue siendo el **valor** del filtro (punto 1, `:55-58`)
   y los **42 `supabase.rpc()`** (punto 9, `:89-105`).
3. Comentario cruzado de una línea en el header de `src/services/arbiter/evidence.test.ts` y de
   `src/adapters/escrow/debit-capture.test.ts`, diciendo qué verifica cada archivo.
4. `doc/sdd/221-…/_INDEX-row.md` (la fila va staged, convención de las HUs 212/214/217/220).

---

## 9. Los tests preexistentes que afirman de más: **NO se tocan**

| Archivo | Qué le pasa | Qué hacés |
|---|---|---|
| `src/services/arbiter/evidence.test.ts` | docblock `:4-5` y comentario `:44-45` lo llaman «fiel … owner-guarded»; `:49` es `eq: () => b`; `:186` se titula «de otro owner» sobre un fixture de un solo dueño (`:36`) | archivo nuevo + 1 línea de comentario cruzado. **Corregir su prosa va como TD del reporte de cierre** |
| `src/adapters/escrow/debit-capture.test.ts` | dobles `eq: () => builder` (`:79`, `:463`); el único control de dueño es el espía de `:533` | ídem |
| `src/services/fee-split.test.ts` | `chain.eq = () => chain` (`:68`, `:83`); la respuesta la decide `mockState.selectQ.shift()` | archivo nuevo. No lo toques |
| `src/services/arbiter.test.ts` | el `fromImpl` (`:340-430`) aplica `id` (`:385`) y `status` (`:420`) pero **nunca** `owner_ref`, bajo un comentario que dice «from() fiel» (`:341`) | archivo nuevo. Copiá su **montaje** de `:1664-1740`, no su doble |

**Motivo (DT-1)**: sus dobles exponen contratos (`calls.eq`, `mockState.selectQ`, `db.fromImpl`) de
los que dependen decenas de tests. Reemplazarlos rompe tests ajenos, y esta HU no está para eso.
Precedente idéntico: DT-6 de WKH-SEC-03 (`doc/sdd/220-…/sdd.md:426-432`) con
`src/routes/agents.ownership.test.ts`.

---

## 10. Protocolo de mutación — por sitio (AC-5)

**Por entrada, en este orden. No saltees ninguno.**

1. Árbol limpio (`git status --short` vacío) y línea base confirmada:
   `node ./node_modules/vitest/vitest.mjs run` → `5330 passed | 19 skipped (5349)`.
2. **Pegar la línea antes de tocarla** (Trampa B, CD-9), con `python3` (Trampa D, CD-23):
   ```python
   t = open(path).readlines()[N-1]
   print(t)
   assert ".eq('owner_ref'" in t
   assert not t.lstrip().startswith(('*', '//'))
   ```
3. Mutar **por reemplazo** (preferido) o por borrado.
   **Reemplazo OBLIGATORIO** si la línea lleva cola de sintaxis (`fee-split.ts:538` y `:697`:
   `.eq('owner_ref', ownerRef))` → `)`) o si hay excepciones registradas más abajo en el mismo
   archivo (`arbiter.ts`, `reconciliation.ts`, `fee-split.ts` — §2.2).
4. `git diff --stat -- <archivo>` → una sola línea tocada.
5. **Control de parseo (Trampa A, CD-17)**:
   `./node_modules/.bin/esbuild <archivo> > /dev/null`. Exit ≠ 0 ⟹ **mutante inválido**: se descarta y
   se rehace. Sin este paso, `:538` y `:697` dan un KILLED falso de 22 archivos.
6. Suite completa. Registrar el conteo crudo **y la lista completa de archivos rojos**.
7. **Descontar el guardián (Trampa E, CD-16)**: `G-08` y `G-09` van a fallar siempre. El veredicto sale
   de los rojos que **no** son `test/ownership-filter-guard.test.ts`. Cero rojos fuera del guardián ⟹
   **SURVIVED**.
8. `git checkout -- <archivo>` · `git status --short` vacío.
9. Fila del log con: `archivo:línea` · el texto exacto · la mutación aplicada · `parse ok` · los rojos
   de comportamiento **con el nombre completo del test** · los rojos del guardián, aparte · el conteo
   crudo.

**Estado esperado al cierre**: los 12 pasan de `SURVIVED` (§2.1) a `KILLED por <test>`.

**Dos firmas de muerte idénticas = un mutante mal construido** (`doc/sdd/217-…/auto-blindaje.md:155-165`).
Acá es más probable que de costumbre: `G-08` + `G-09` + `Test Files 1 failed` es la firma común de los
doce. **La comparación se hace sobre los rojos de comportamiento**, que son lo único que distingue un
sitio de otro.

**`scripts/eq-sweep.mjs`**: existe y lo dejó SEC-03. **No lo leí y no lo corrí.** Si lo usás, confirmá
**antes** que hace el descuento del guardián (paso 7) y el control de parseo (paso 5). Si no los hace,
sus veredictos sobre estos 12 son inválidos.

---

## 11. Constraint Directives

### PROHIBIDO

- **CD-1** — Modificar cualquier línea de producción bajo `src/` que no sea un archivo de test. Si un
  test no se puede poner en rojo sin tocar producción: **pará y escalá**.
- **CD-15** — Ampliar el corte. Los 12 y nada más. Lo que aparezca «de paso» (como el 13.º sitio de
  H-7) se anota como hallazgo y no cambia la aritmética.
- **CD-16** — Escribir `KILLED` para un mutante cuyo único rojo sea `test/ownership-filter-guard.test.ts`.
  Eso es `SURVIVED`, y es el estado de hoy.
- **CD-18** — Escribir en cualquier archivo que se mergee la frase «se puede borrar y la suite queda
  verde» para estos 12 sitios. Es **falsa** desde SEC-03. La frase correcta: «quitándolo, el único rojo
  es el del guardián: ningún test de comportamiento se entera».
- **CD-19** — Evidencia auto-confirmante: toda cita `archivo:línea` apunta al **sujeto** de la
  afirmación. Reincidente: el AR de SEC-03 (`adversarial-review.md:58`) encontró una excepción que
  citaba el `preHandler` de la ruta de reconciliación como gate de la ruta de arbitraje; quien lo
  verificaba encontraba `requireAdminTokenStrict` ahí, veía lo que esperaba, y estampaba OK sin haber
  mirado nunca la ruta real.
- **CD-20** — Escribir un `archivo:línea` en el log que no haya salido de una salida capturada. Si no
  está en una salida pegada, decís de qué corrida salió o no lo escribís. Reincidente:
  `doc/sdd/220-…/auto-blindaje.md:9-23`.
- **CD-22** — Apoyar un control en un número copiado de otro artefacto sin re-medirlo. Incluye los
  números de este documento. Reincidente: `doc/sdd/220-…/auto-blindaje.md:38-48`.
- **CD-23** — Mutar con `perl`/`sed` sobre un patrón con plantilla: `perl` con `\Q…\E` interpola
  `${…}` igual, el archivo queda intacto, el proceso sale con `0`, y la suite verde se lee como «el
  mutante sobrevive».
- **CD-25** — Un fixture con un solo `owner_ref`. Y un test cuyo único aserto sea `toBeNull()` /
  `rejects` sin su gemelo positivo. El caso vivo: `arbiter/evidence.test.ts:186`.
- **CD-7** — Afirmar que un guard «impide» algo. Cada afirmación va con el input concreto que la pone
  en rojo, y al lado el input que se le escapa.
- **Tocar** `evidence.test.ts` / `debit-capture.test.ts` / `fee-split.test.ts` / `arbiter.test.ts` más
  allá de una línea de comentario en el header (§9).

### OBLIGATORIO

- **CD-2** — Todo fixture con **dos `owner_ref` distintos**, y el falso **no filtra por dueño de
  oficio** (`owner-scoped-fake.ts:22-29`).
- **CD-3** — Evidencia por sitio y **por línea**.
- **CD-6** — Control anti-vacuidad por archivo, en las dos direcciones: A obtiene **lo suyo** y **no**
  obtiene lo de B.
- **CD-8** — Re-medir la línea base en el worktree **antes** de la primera mutación, y citarla con su
  commit.
- **CD-9** — Pegar la línea antes de mutarla y confirmar que es una consulta. **PROHIBIDO**
  `grep … | head -1`.
- **CD-12** — Orden `editar → tsc → test → lint → commit`, **por wave**.
- **CD-17** — Control de parseo (`esbuild`) después de mutar y **antes** de correr la suite.
- **CD-21** — Re-verificar **al cierre** toda cita a un archivo que esta HU edita. Aplica al header del
  guardián y al propio `mutation-log.md`. Reincidente: `doc/sdd/220-…/auto-blindaje.md:25-36` (una
  nota de 4 líneas corrió una cita de `:212` a `:216`).
- **CD-24** — Toda modificación a `owner-scoped-fake.ts` es **aditiva y con default inerte**, y la
  línea base tiene que quedar exacta después de tocarlo.
- **AC-3** — Declarar por escrito, en el header y en el log, cuando la propiedad sólo se sostiene
  sobre un estado que la base consistente no produce (Grupo B) o sobre una carrera no alcanzable hoy
  (Grupo C).

---

## 12. Out of Scope — no toques nada de esto

- **Arreglar cualquier filtro.** Los 12 están. Esta HU no arregla: mide.
- **Los 11 sitios de WKH-SEC-03** — ya tienen test.
- **El guardián**, su escáner y las **41 excepciones**: no se tocan, salvo el punto 8 del header
  (AC-7). Si medís que una excepción es incorrecta, **es un hallazgo y va reportado, no corregido de
  callado**.
- **Los 42 `supabase.rpc()`** — declarados fuera en el punto 9 del header del guardián (`:89-105`).
  Son otra HU.
- **Los otros `.eq` que no son `owner_ref`** (idempotencia, compare-and-set, ligadura de fila).
- **RLS real en Postgres** — es WKH-SEC-02 / TD-SEC-01 (`CLAUDE.md:256-264`). Y el argumento que **no**
  hay que hacer: RLS no vuelve redundantes estos filtros mientras el cliente use
  `SUPABASE_SERVICE_KEY`, que es BYPASSRLS.
- **Otros repos** (`chaski-v3`, `wasiai-facilitator`, `solana-programs`, `wasiai-remittance-agents`),
  **`m5-keys/`**, **desplegar**, la base **`caldz`**.
- **`CLAUDE.md`** — SEC-03 ya lo actualizó.

---

## 13. Anti-Hallucination Checklist

Antes de dar por cerrada la HU, cada línea tiene que poder responderse con un `archivo:línea` o una
salida pegada.

- [ ] La línea base la **corriste vos** en el worktree y da `5330 passed | 19 skipped (5349)`.
- [ ] Corriste el **control negativo** (§4 paso 6) y viste un rojo de comportamiento.
- [ ] Reprodujiste al menos un `SURVIVED` de los 12 (§4 paso 7) **antes** de escribir un test.
- [ ] Los 12 sitios los verificaste con el script de §4 paso 4: los 12 existen, ninguno es comentario.
- [ ] Cada `archivo:línea` que escribiste lo abriste. Ninguno lo dedujiste (CD-20).
- [ ] Ninguna cita apunta al vecino del sujeto (CD-19). Re-verificaste las citas a archivos que esta HU
      edita, **al cierre** (CD-21).
- [ ] Ningún archivo mergeado dice «se puede borrar y la suite queda verde» sobre estos 12 (CD-18).
- [ ] Ningún archivo mergeado dice que alguno de estos 12 «impide» un IDOR (CD-7). Los 12 están detrás
      de un chequeo previo o de un `ownerRef` server-side; §6 «El límite honesto».
- [ ] Cada test nuevo tiene su gemelo positivo (CD-6/CD-25).
- [ ] Cada fixture tiene **dos** `owner_ref` (CD-2).
- [ ] Ningún test nuevo afirma sobre el doble: los asertos son sobre el **valor devuelto** o sobre el
      **estado de la tabla** del falso, o sobre los **argumentos que el código le pasa al RPC**.
- [ ] Los 4 tests del Grupo B y C tienen su declaración escrita en el header (AC-3).
- [ ] El log de mutación separa los rojos de comportamiento de `G-08`/`G-09` (CD-16), y cada fila nombra
      el test completo.
- [ ] `git diff --name-only b7fa4e7 -- src` no tiene ningún archivo que no sea `*.test.ts` o
      `src/services/__tests__/` (AC-6).
- [ ] `npx tsc --noEmit` limpio y `npx biome check src/` limpio, **por wave** (CD-12).
- [ ] La suite final da la línea base **más** los tests nuevos, y `0 failed`.
- [ ] El punto 8 del header del guardián (`:84-88`) está reescrito (AC-7) y **no** afirma más de lo
      medido: el **valor** del filtro y los **42 RPC** siguen sin cubrir.

---

## 14. Escalation Rule

**Pará y escalá, no improvises**, si:

1. Un test no se puede poner en rojo sin tocar una línea de producción (CD-1 / AC-6).
2. Encontrás un **IDOR vivo** — un sitio donde el caller elige el identificador y **no** hay chequeo
   de dueño en ningún lado. No se arregla acá: sale como hallazgo con su propia HU.
3. Medís que una de las **41 excepciones** del guardián es incorrecta. Es un hallazgo, va reportado,
   **no corregido de callado**.
4. La línea base no da `5330 passed | 19 skipped (5349)`, o el control negativo de §4 paso 6 no
   produce un rojo.
5. Uno de los 12 **ya está muerto** por un test de comportamiento preexistente (contradiría §2.1).
6. `arbiter.ts:110` (A-6) te lleva más de lo razonable por la pila de gates de escrow. Está solo en W2
   y no bloquea nada. **Escalá antes de bajar la vara a un espía de llamada.**
7. Extender `owner-scoped-fake.ts` mueve la línea base (CD-24): algún archivo de SEC-03 dependía de la
   ausencia de lo que agregaste.
