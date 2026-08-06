# Mutation log — WKH-SEC-04 · los 12 filtros del camino del dinero y las disputas

> F3 · `nexus-dev` · 2026-08-06 · AC-5 del Story File
> Worktree `/home/ferdev/.openclaw/workspace/wt-sec04`, rama
> `feat/221-wkh-sec-04-owner-ref-dinero-y-disputas`, base `b7fa4e7`.
>
> **Todo lo que está acá salió de una salida capturada** (CD-20). Las corridas de
> esta tabla son las del script de mutación de la sesión, que por sitio: pega la
> línea → afirma que contiene `.eq('owner_ref', ownerRef)` y que no es comentario
> → muta **por reemplazo** → `git diff --stat` → **control de parseo con esbuild**
> → **suite completa** → descuenta el guardián → `git checkout --` → confirma el
> árbol limpio.

---

## 0. Lo primero, porque sin esto la tabla se lee al revés

**El guardián de WKH-SEC-03 mata los 13 mutantes por su cuenta, y eso NO cuenta.**

Quitar cualquiera de estos filtros pone en rojo `G-08` y `G-09` de
`test/ownership-filter-guard.test.ts` — G-09 porque
`expect(UNFILTERED.length).toBe(OWNERSHIP_FILTER_EXCEPTIONS.length)` pasa de
`41 === 41` a `42 !== 41`. Eso pasa **hoy, con o sin los tests de esta HU**.

Por eso el veredicto de cada fila sale **sólo de los rojos que NO son el
guardián** (CD-16). En las 13 corridas el guardián aportó exactamente **2 tests
rojos**, siempre los mismos dos, y están contados aparte en la columna que
corresponde.

---

## 1. Línea base — re-medida en este worktree (CD-8 / CD-22)

En `b7fa4e7`, antes de tocar nada:

```
$ node ./node_modules/vitest/vitest.mjs run
 Test Files  268 passed | 6 skipped (274)
      Tests  5330 passed | 19 skipped (5349)
   Duration  9.91s
```

Coincide con la del Story File §2.3. **No se copió: se corrió.**

Después de extender `owner-scoped-fake.ts` (W0, aditivo con default inerte), la
línea base quedó **idéntica** — que es el control de CD-24:

```
 Test Files  268 passed | 6 skipped (274)
      Tests  5330 passed | 19 skipped (5349)
```

Al cierre de la HU:

```
 Test Files  273 passed | 6 skipped (279)
      Tests  5358 passed | 19 skipped (5377)
```

**+5 archivos de test, +28 tests, 0 failed.** Los 5 son
`arbiter/evidence.ownership.test.ts` (5 tests), `arbiter.ownership.test.ts` (7),
`reconciliation.ownership.test.ts` (2), `debit-capture.ownership.test.ts` (5) y
`fee-split.ownership.test.ts` (9). `owner-scoped-fake.ts` se modificó pero no es
un archivo de test, así que no suma a `Test Files`.

---

## 2. Los dos controles del instrumento, corridos ANTES de escribir un test

### 2.1 · Control NEGATIVO — la suite PUEDE ponerse roja en estos archivos

Sin esto, «SURVIVED» es indistinguible de «la suite no corrió». Se borró
`src/adapters/escrow/debit-capture.ts:120` (el 13.º sitio, que ya moría):

```
$ ./node_modules/.bin/esbuild src/adapters/escrow/debit-capture.ts > /dev/null
PARSE OK
$ node ./node_modules/vitest/vitest.mjs run
 FAIL  test/ownership-filter-guard.test.ts > … > ★ G-08: …
 FAIL  test/ownership-filter-guard.test.ts > … > G-09: …
 FAIL  src/adapters/escrow/debit-capture.test.ts > T-7 reader query owner-guarded + most-recent (AC-7/191b) > WHERE valid ORDER BY captured_at DESC LIMIT 1 + eq(owner_ref); amount OK → devuelve la fila
 Test Files  2 failed | 266 passed | 6 skipped (274)
      Tests  3 failed | 5327 passed | 19 skipped (5349)
```

Hay un rojo de comportamiento. **El instrumento mide.**

### 2.2 · Reproducción de un SURVIVED — el punto de partida real

Se borró `src/services/arbiter/evidence.ts:57`:

```
$ ./node_modules/.bin/esbuild src/services/arbiter/evidence.ts > /dev/null
PARSE OK
$ node ./node_modules/vitest/vitest.mjs run
 FAIL  test/ownership-filter-guard.test.ts > … > ★ G-08: …
 FAIL  test/ownership-filter-guard.test.ts > … > G-09: …
 Test Files  1 failed | 267 passed | 6 skipped (274)
      Tests  2 failed | 5328 passed | 19 skipped (5349)
```

Cero rojos de comportamiento. **Eso es SURVIVED**, y era el estado de los 12.

---

## 3. La tabla — los 12 sitios, DESPUÉS de esta HU

Corrida por sitio sobre la **suite completa**. Los dos rojos del guardián
(`★ G-08` y `G-09`) aparecieron en las 13 corridas y están descontados.

| # | Sitio | Texto exacto de la línea | Parse | Rojos de COMPORTAMIENTO (test completo) | Rojos del guardián | Conteo crudo | Veredicto |
|---|---|---|---|---|---|---|---|
| 1 | `src/services/fee-split.ts:365` | `.eq('owner_ref', ownerRef)` | ok | `FS-01 [fee-split.ts:365]: un leg charged de B NO da por cobrado el leg de A, ni le presta su tx_hash`; `FS-BS (backstop estructural)` | 2 | `Test Files 2 failed \| 271 passed \| 6 skipped (279)` · `Tests 4 failed \| 5354 passed \| 19 skipped (5377)` | **KILLED** |
| 2 | `src/services/fee-split.ts:538` | `.eq('owner_ref', ownerRef)) as { error: SupabaseError \| null };` | ok | `FS-02 [fee-split.ts:538]: si el leg pasa a ser de B entre el INSERT y el UPDATE, NO queda charged con el tx de A`; `FS-BS (backstop estructural)` | 2 | `Test Files 2 failed \| 271 passed \| 6 skipped (279)` · `Tests 4 failed \| 5354 passed \| 19 skipped (5377)` | **KILLED** |
| 3 | `src/services/fee-split.ts:618` | `.eq('owner_ref', ownerRef);` | ok | `FS-03 [fee-split.ts:618]: si el leg pasa a ser de B antes de markLegFailed, NO queda failed con el error de A` | 2 | `Test Files 2 failed \| 271 passed \| 6 skipped (279)` · `Tests 3 failed \| 5355 passed \| 19 skipped (5377)` | **KILLED** |
| 4 | `src/services/fee-split.ts:697` | `.eq('owner_ref', ownerRef)) as { error: SupabaseError \| null };` | ok | `FS-04 [fee-split.ts:697]: si el leg pasa a ser de B entre el pre-chequeo en JS y el UPDATE, NO queda reversed` | 2 | `Test Files 2 failed \| 271 passed \| 6 skipped (279)` · `Tests 3 failed \| 5355 passed \| 19 skipped (5377)` | **KILLED** |
| 5 | `src/services/arbiter.ts:110` | `.eq('owner_ref', ownerRef)` | ok | `AR-05 [arbiter.ts:110]: A settlea el intent de B → NO reusa el nonce persistido de B, y la fila de B SIGUE ahí` | 2 | `Test Files 2 failed \| 271 passed \| 6 skipped (279)` · `Tests 3 failed \| 5355 passed \| 19 skipped (5377)` | **KILLED** |
| 6 | `src/services/arbiter.ts:1070` | `.eq('owner_ref', ownerRef)` | ok | `AR-01 [arbiter.ts:1070]: A revierte la disputa de B → la fila de B sigue en disputed`; `AR-BS (backstop estructural)` | 2 | `Test Files 2 failed \| 271 passed \| 6 skipped (279)` · `Tests 4 failed \| 5354 passed \| 19 skipped (5377)` | **KILLED** |
| 7 | `src/services/arbiter.ts:1100` | `.eq('owner_ref', ownerRef)` | ok | `AR-03 [arbiter.ts:1100]: A congela la disputa de B → la fila de B sigue en disputed`; `AR-BS (backstop estructural)` | 2 | `Test Files 2 failed \| 271 passed \| 6 skipped (279)` · `Tests 4 failed \| 5354 passed \| 19 skipped (5377)` | **KILLED** |
| 8 | `src/services/arbiter/evidence.ts:57` | `.eq('owner_ref', ownerRef)` | ok | `EV-01 [evidence.ts:57]: A lee la evidencia del intent de B → INTENT_NOT_FOUND, y el intent de B SIGUE en la tabla`; `EV-BS (backstop estructural)` | 2 | `Test Files 2 failed \| 271 passed \| 6 skipped (279)` · `Tests 4 failed \| 5354 passed \| 19 skipped (5377)` | **KILLED** |
| 9 | `src/services/arbiter/evidence.ts:76` | `.eq('owner_ref', ownerRef);` | ok | `EV-03 [evidence.ts:76]: un voucher de B colgado del intent de A NO entra en el conteo ni en el total`; `EV-BS (backstop estructural)` | 2 | `Test Files 2 failed \| 271 passed \| 6 skipped (279)` · `Tests 4 failed \| 5354 passed \| 19 skipped (5377)` | **KILLED** |
| 10 | `src/services/arbiter/evidence.ts:96` | `.eq('owner_ref', ownerRef);` | ok | `EV-04 [evidence.ts:96]: un recibo de B colgado de la sesión de A NO suma al total settleado`; `EV-BS (backstop estructural)` | 2 | `Test Files 2 failed \| 271 passed \| 6 skipped (279)` · `Tests 4 failed \| 5354 passed \| 19 skipped (5377)` | **KILLED** |
| 11 | `src/services/reconciliation.ts:1448` | `.eq('owner_ref', ownerRef)` | ok | `RC-01 [reconciliation.ts:1448]: A lee el budget de la key de B → null, y la key de B EXISTE` | 2 | `Test Files 2 failed \| 271 passed \| 6 skipped (279)` · `Tests 3 failed \| 5355 passed \| 19 skipped (5377)` | **KILLED** |
| 12 | `src/adapters/escrow/debit-capture.ts:212` | `.eq('owner_ref', ownerRef)` | ok | `DC-01 [debit-capture.ts:212]: A firma contra el intent de B → SIGNER_MISMATCH, y el intent de B EXISTE con esa wallet`; `DC-BS (backstop estructural)` | 2 | `Test Files 2 failed \| 271 passed \| 6 skipped (279)` · `Tests 4 failed \| 5354 passed \| 19 skipped (5377)` | **KILLED** |

**12/12 KILLED por un test que no es el guardián.** En §2.1 del Story File los 12
figuraban como SURVIVED con «ninguno» en la columna de rojos fuera del guardián.

### 3.1 · El 13.º sitio — extra declarado, FUERA de la aritmética

| # | Sitio | Rojos de comportamiento | Conteo crudo | Veredicto |
|---|---|---|---|---|
| 13-extra | `src/adapters/escrow/debit-capture.ts:120` | `WHERE valid ORDER BY captured_at DESC LIMIT 1 + eq(owner_ref); amount OK → devuelve la fila` (el preexistente, de `debit-capture.test.ts`); `DC-03 [debit-capture.ts:120, EXTRA fuera de los 12]: A lee la firma de B → null, y la firma de B EXISTE`; `DC-BS (backstop estructural)` | `Test Files 3 failed \| 270 passed \| 6 skipped (279)` · `Tests 5 failed \| 5353 passed \| 19 skipped (5377)` | **KILLED** |

**No entra en `11 + 12 = 23`.** Ya moría antes de esta HU, pero lo mataba
`expect(calls.eq).toContainEqual(['owner_ref', OWNER])`
(`src/adapters/escrow/debit-capture.test.ts:539`), un **espía de argumento**
sobre dos dobles que son `eq: () => builder` (`:85`, `:469`) — o sea que
registran el filtro y no lo aplican. Un espía prueba **que la llamada se hizo**,
no **qué filas volvieron**: pasa igual con el filtro correcto acompañado de una
consulta ensanchada, porque nadie mira el resultado.

⚠️ **Corregido por el AR (`BLQ-BAJO-2`).** Acá decía que «un espía pasa igual con
el nombre de la columna mal escrito». Es **falso**, y se refuta con un comando:
mutando `debit-capture.ts:120` a `.eq('ownerRef', ownerRef)` (`PARSE OK`,
`1 insertion(+), 1 deletion(-)`) y corriendo **sólo el test preexistente**,
`node ./node_modules/vitest/vitest.mjs run src/adapters/escrow/debit-capture.test.ts`
da `Tests 1 failed | 19 passed (20)`, rojo en `:539` — `toContainEqual` compara
el **par exacto** `['owner_ref', OWNER]`. Reproducido en el fix-pack, no copiado
del AR. La razón por la que el sitio vale igual es la de arriba (espía ≠
comportamiento), no la columna mal escrita.

Ahora tiene además un test de comportamiento. Se ve en la tabla: es el único
sitio con **dos** archivos de test rojos.

---

## 4. Las firmas de muerte son distintas — el control de «mutante mal construido»

Dos mutantes con la **misma** firma suelen ser un mutante mal construido. Acá la
firma común existe y es esperada (`★ G-08` + `G-09` en los 13), por eso la
comparación se hace **sólo sobre los rojos de comportamiento**: cada uno de los
13 nombra un test distinto, y el nombre del test contiene el `archivo:línea` del
sitio que mató. Ningún par comparte firma de comportamiento.

---

## 5. Cómo se mutó, y por qué así

- **Reemplazo, no borrado, en los 13.** Obligatorio en `fee-split.ts:538` y
  `:697`, cuya línea lleva cola de sintaxis (`)) as { error: SupabaseError | null };`):
  borrarla entera se come el paréntesis de cierre, pasa el control de «una sola
  línea tocada» (`1 file changed, 1 deletion(-)`) y tumba 22 archivos de test por
  `PARSE_ERROR`. Eso leído rápido es un KILLED espectacular y falso.
  El reemplazo da `1 insertion(+), 1 deletion(-)` en los 13.
- **Control de parseo con `esbuild` después de mutar y ANTES de correr la suite.**
  Los 13 dieron `PARSE OK`. Un exit ≠ 0 descarta el mutante.
- **`python3` con `assert <patrón> in <línea>`**, nunca `perl`/`sed` con
  plantilla: un `perl` con `\Q…\E` interpola `${…}` igual, el archivo queda
  intacto, el proceso sale con `0`, y la suite verde se lee como «sobrevivió».
- **La línea se pega antes de tocarla** y se afirma que no empieza con `*` ni
  `//`: elegirla con `grep | head -1` puede devolver un comentario.
- **`git checkout --` + `git status --porcelain -- src/` vacío** tras cada
  mutante. Verificado en los 13: el árbol quedó limpio.

---

## 6. Qué NO dice este log

- **Nada sobre el VALOR del filtro.** `.eq('owner_ref', otroOwner)` pasa el
  guardián y pasaría varios de estos tests. Es el punto 1 de lo no cubierto en el
  header de `test/ownership-filter-guard.test.ts`.
- **Nada sobre los 42 `supabase.rpc()`.** Están declarados fuera en el punto 9 de
  ese mismo header. Son otra HU.
- **Nada sobre RLS.** Es WKH-SEC-02 / TD-SEC-01. Y mientras el cliente use
  `SUPABASE_SERVICE_KEY` (BYPASSRLS), RLS no vuelve redundante ninguno de estos.
- **Y no dice que los 12 sean IDOR.** Ninguno lo es hoy: los cuatro de
  `arbiter`/`evidence` están detrás del chequeo de dueño en JavaScript de
  `openDispute` (`src/services/arbiter.ts:606-608`); `readBudgetUsd` tiene un solo
  llamador de producción, `driftCheck`, que le pasa el `ownerRef` de la propia
  fila; y en `fee-split.ts` el `ownerRef` sale de `resolveRecipients`,
  server-side. Lo que se probó es la propiedad de la función: dado un par
  `(id, ownerRef)` que no se corresponde, no entrega y no muta.
