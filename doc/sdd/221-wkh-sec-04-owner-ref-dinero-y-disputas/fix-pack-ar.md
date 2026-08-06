# Fix-pack del Adversarial Review — WKH-SEC-04

> Worktree `/home/ferdev/.openclaw/workspace/wt-sec04`, base `b7fa4e7`, HEAD antes del
> fix-pack `99e3ed0`. Input: `adversarial-review.md` (veredicto **RECHAZADO**: 3
> BLOQUEANTE-BAJO + 3 MENORes).
>
> **Los 6 hallazgos son de la misma clase: prosa que afirma de más.** Ninguno pedía
> tocar producción y no se tocó ninguna línea de producción. **Cero tests nuevos**:
> los 28 de la HU siguen siendo 28 y la suite sigue dando el mismo número exacto.
>
> **Regla que se aplicó a cada frase reescrita (CD-10)**: si la frase no se puede
> refutar con un comando concreto, no se escribe. Donde hay una afirmación, al lado
> está el comando que la mata si deja de ser cierta.

---

## BLQ-BAJO-1 — «se persiste una firma consumible» era falso

- **Sitio**: `src/adapters/escrow/debit-capture.ownership.test.ts:12-35` (antes `:15-17`).
- **Decía**: «…y **se persiste** una autorización de débito `valid` contra un intent
  ajeno. Es una firma consumible por el path de escrow.»
- **Lo verificado en este fix-pack**, releyendo las fuentes que el AR cita:
  - `supabase/migrations/20260713000000_wkh191a_debit_signatures.sql:83-85` →
    `IF v_owner IS DISTINCT FROM p_owner_ref THEN RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller'`.
  - `src/adapters/escrow/debit-capture.ts:288` → `if (error) throw error;`. O sea que la
    persistencia **no ocurre**: el RPC levanta y el error se relanza.
  - `src/adapters/escrow/debit-capture.ts:205-206`, el comentario de producción **dos
    líneas arriba del filtro que el test mide**, ya decía «El RPC re-verifica ownership
    en la persistencia».
- **Cómo quedó**: se afirma sólo lo medido — sin el filtro de `:212` cambia el
  **veredicto en memoria** de `SIGNER_MISMATCH` (`:236-242`) a `valid` (`:247`), que es
  exactamente lo que lee `DC-01` en `p_status`/`p_reason`. Se agregó un bloque `⚠️ HASTA
  AHÍ LLEGA` (`:20-32`) que dice que la persistencia la sigue bloqueando el RPC, y que lo
  que aporta el filtro es **defensa en profundidad sobre el veredicto**: sin él, lo único
  que separa un `valid` ajeno de la base es el `RAISE` del RPC.
- **Y se declaró el límite del propio archivo** (`:34-37`): `DC-01..DC-04` **stubean** el
  RPC (`mockRpc.mockResolvedValue(...)`, `debit-capture.ownership.test.ts:173-176`), así
  que cualquier frase sobre lo que la base persiste es **infalsificable acá adentro** —
  se refuta leyendo la migración, no corriendo el archivo. Eso es lo que dejó pasar la
  frase vieja.

## BLQ-BAJO-2 — «un espía pasa con la columna mal escrita» era falso (3 sitios)

- **Sitios corregidos, los tres**:
  1. `src/adapters/escrow/debit-capture.ownership.test.ts:43-53`
  2. `doc/sdd/221-…/mutation-log.md:139-153`
  3. `doc/sdd/221-…/_INDEX-row.md:21` (dentro de la fila del índice)
- **Repro ejecutado acá, no copiado del AR**:

  ```
  # mutar src/adapters/escrow/debit-capture.ts:120 → .eq('ownerRef', ownerRef)
  git diff --stat  →  1 file changed, 1 insertion(+), 1 deletion(-)
  npx esbuild src/adapters/escrow/debit-capture.ts  →  PARSE OK
  node ./node_modules/vitest/vitest.mjs run src/adapters/escrow/debit-capture.test.ts
   ❯ src/adapters/escrow/debit-capture.test.ts:539:22
   Test Files  1 failed (1)
        Tests  1 failed | 19 passed (20)
  ```

  El espía **sí** caza la columna mal escrita: `expect(calls.eq).toContainEqual(['owner_ref', OWNER])`
  compara el **par exacto**.
- **Cómo quedó**: la formulación correcta, la que el propio archivo ya usaba bien en los
  `*-BS` — **un espía prueba que la llamada se hizo, no qué filas volvieron**: pasa igual
  con el filtro correcto acompañado de una consulta ensanchada, porque nadie mira el
  resultado. En `mutation-log.md` y en `_INDEX-row.md` la corrección está **declarada
  como corrección** y con el comando que la sostiene, para que no se lea como si nunca
  hubiera dicho otra cosa.

## BLQ-BAJO-3 — «el `updateErr` sólo se loguea» describía una rama que no corre

- **Sitios**: `src/services/fee-split.ownership.test.ts:287-310` (antes `:287-290`) y la
  misma frase propagada en `doc/sdd/221-…/_INDEX-row.md:21`, que también se corrigió.
- **Sonda propia** (copia temporal del archivo de test, `src/services/zz-probe.test.ts`,
  corrida y **borrada**; `git status --porcelain` verificado vacío después):

  ```
  {"err":0,"warn":0,"info":0,"row":"pending","reported":"charged","errCalls":[]}
  ```

  O sea: en el escenario de FS-02 el UPDATE matchea **cero filas**, PostgREST **no**
  devuelve error, `updateErr` es `null`, `fee-split.ts:540-547` **nunca corre** y no se
  emite **ninguna** línea de log — ni `error`, ni `warn`, ni `info`.
- **Cómo quedó**: los dos casos separados y numerados.
  - (i) `updateErr != null` → reportado `charged` **y logueado** (`fee-split.ts:540-547`).
    Deuda **declarada e intencional**, con el comentario de producción de `:541-542` como
    respaldo.
  - (ii) cero filas matcheadas (**este** escenario) → reportado `charged` y **mudo**:
    divergencia silenciosa entre lo reportado y lo persistido (`pending`).
  - La frase queda refutable desde adentro del archivo: agregar
    `expect(logSpy.error).toHaveBeenCalled()` en FS-02 tiene que dar rojo.

## MNR-1 — la descripción del grep no coincidía con su salida

- **Sitio**: `src/services/fee-split.ownership.test.ts:260-272`.
- **Grep re-corrido HOY** (no se copió el número del AR, que dice «5 archivos» y tampoco
  coincide):

  ```
  $ command grep -rn "reverseFeeSplits" src/ --include=*.ts | wc -l
  20
  $ ... | cut -d: -f1 | sort | uniq -c
        1 src/services/fee-charge.ts
        6 src/services/fee-split.ownership.test.ts
        7 src/services/fee-split.test.ts
        6 src/services/fee-split.ts
  ```

  **20 hits en 4 archivos** (re-contado **después** de escribir el párrafo nuevo, porque
  el párrafo contiene la palabra buscada y se cuenta a sí mismo).
- **Cómo quedó**: la salida descrita como es, con la fecha, y con la parte que **no**
  depende de los conteos: el único hit fuera de `fee-split.*` es `fee-charge.ts:677` y
  está **dentro de un comentario**. La **conclusión** (`reverseFeeSplits` no tiene
  llamador de producción) no cambia: era correcta.

## MNR-2 — `process.env.X = undefined` deja el string `"undefined"`

- **Sitio**: `src/services/arbiter.ownership.test.ts:337-348` (el `afterEach`).
- **Medido acá**: `node -e 'process.env.X = undefined; console.log(typeof process.env.X, process.env.X.length)'`
  → `string 9`.
- **Cómo quedó**: `delete process.env.ESCROW_ARBITER_ENABLED` (`:345`) y
  `delete process.env.ARBITER_NONCE_SECRET` (`:347`), que es el idioma del repo
  (`arbiter.test.ts:461`, `:463`, `:1398`, `:1730`, `:1747`), más el comentario con el
  `node -e` que refuta la versión anterior.

## MNR-3 — el hallazgo (b) se quedaba en el contador

- **Sitio**: `src/services/fee-split.ownership.test.ts:371-381` (antes `:353-357`), y la
  misma frase en `doc/sdd/221-…/_INDEX-row.md:21`, corregida también.
- **Medido con la misma sonda temporal** sobre FS-04:

  ```
  out  = {"status":"reversed","reversedCount":1,
          "legs":[{"role":"creator", ... ,"status":"reversed","txHash":"0xAAA-tx-de-A"}]}
  fila = {... "status":"charged", "tx_hash":"0xAAA-tx-de-A"}
  ```

  El payload **entero** afirma la reversa (`fee-split.ts:708-717`,
  `legs.push({ ... status: 'reversed' })`), no sólo `reversedCount += 1` (`:707`),
  mientras la fila persistida sigue `charged`.
- **Cómo quedó**: «ni el contador **ni el payload** son evidencia de que algo se haya
  reversado», con las dos citas `archivo:línea`.

---

## Verificación — salidas reales

```
$ node ./node_modules/vitest/vitest.mjs run
 Test Files  273 passed | 6 skipped (279)
      Tests  5358 passed | 19 skipped (5377)
   Duration  10.10s
```

**Idéntico** a la línea declarada en `mutation-log.md:56-58` y a la que el AR verificó
(§8). Se usó `node ./node_modules/vitest/vitest.mjs run` y **no** `npx vitest run`, que
colapsa la salida y pierde los `skipped`.

```
$ npx tsc --noEmit          →  exit 0
$ npx biome check src/      →  Checked 472 files in 139ms. No fixes applied.   exit 0
```

⚠️ `npx biome check src/` **a través del wrapper de este shell** volvió a dar la salida
mezclada que ya está documentada en `auto-blindaje.md` (`Lint: 2 errors` + `npm error
could not determine executable to run`). La corrida limpia es la de arriba (`rtk proxy npx
biome check src/`), y da lo mismo que `./node_modules/.bin/biome check src/`:
`Checked 472 files ... exit=0`. **El «2 errors» no es del lint**: es el wrapper fallando
por otra cosa.

### Re-verificación de mutantes (4 de los 13, con el método del AR)

Reemplazo de `.eq('owner_ref', ownerRef)` por vacío, `assert patrón in línea` + control de
que no es comentario, `git diff --stat`, parseo con **`esbuild <file>` a secas** (con
`--loader=ts` da exit 1 y fabrica un `PARSE_ERROR` falso), y `vitest run` **sólo del
archivo del sitio** — el guardián estructural nunca entró en la corrida.

| Sitio | `git diff --stat` | Parseo | Rojos del archivo del sitio | AR (§0) |
|---|---|---|---|---|
| `fee-split.ts:538` | `1 insertion(+), 1 deletion(-)` | `PARSE OK` | `Tests 2 failed \| 7 passed (9)` | `2 failed \| 7 passed` ✅ |
| `fee-split.ts:697` | `1 insertion(+), 1 deletion(-)` | `PARSE OK` | `Tests 1 failed \| 8 passed (9)` | `1 failed \| 8 passed` ✅ |
| `debit-capture.ts:212` | `1 insertion(+), 1 deletion(-)` | `PARSE OK` | `Tests 2 failed \| 3 passed (5)` | `2 failed \| 3 passed` ✅ |
| `arbiter.ts:1070` | `1 insertion(+), 1 deletion(-)` | `PARSE OK` | `Tests 2 failed \| 5 passed (7)` | `2 failed \| 5 passed` ✅ |

**Coinciden los 4, fila por fila.** Se eligieron los sitios de los tres archivos que este
fix-pack tocó (`fee-split`, `debit-capture`, `arbiter`), para descartar que reescribir un
comentario haya movido la medición. Árbol restaurado después de cada uno
(`git status --porcelain -- <archivo>` vacío).

### AC-6 — cero producción, invariante intacto

```
$ git diff --name-only b7fa4e7 -- src
src/adapters/escrow/debit-capture.ownership.test.ts
src/adapters/escrow/debit-capture.test.ts
src/services/__tests__/owner-scoped-fake.ts
src/services/arbiter.ownership.test.ts
src/services/arbiter/evidence.ownership.test.ts
src/services/arbiter/evidence.test.ts
src/services/fee-split.ownership.test.ts
src/services/reconciliation.ownership.test.ts
```

**8 archivos, los mismos 8 que verificó el AR (§7)**: siete `*.test.ts` más el falso
compartido `src/services/__tests__/owner-scoped-fake.ts`. Ninguno de los cambios de este
fix-pack agregó un archivo a esa lista ni tocó una línea fuera de un comentario, salvo el
`delete process.env` de MNR-2, que es código de `afterEach` en un archivo de test.

---

## Lo que NO se hizo, y por qué

- **No se tocó producción.** Ninguno de los 6 hallazgos lo pedía; los tres BLOQUEANTEs son
  prosa. Las dos deudas de comportamiento que la prosa ahora describe bien
  (`chargeLeg` reportando `charged` con cero filas matcheadas, y `reverseFeeSplits`
  afirmando la reversa entera) siguen siendo **deuda declarada**, tal como el AR §3 las
  clasificó: «deuda declarada, NO tarea propia».
- **No se tocaron `arbiter/evidence.test.ts` ni `debit-capture.test.ts`.** El AR (§6)
  confirmó que la decisión de no tocarlos es la correcta y el Story File lo prohíbe
  explícitamente (`story-HU-WKH-SEC-04.md:696`, `Out of Scope`).
- **No se tocó `test/ownership-filter-guard.test.ts`.** Ni el escáner ni las 41
  excepciones; su único cambio sigue siendo el del bloque de comentario del header, ya
  revisado en el AR §7.
- **No se agregaron tests.** Los 28 de la HU siguen siendo 28 y la suite da el mismo
  número exacto que antes del fix-pack.

## Lo que NO pude verificar

1. **Que el RPC `capture_debit_signature` efectivamente rechace en una base viva.** Lo
   verifiqué **leyendo** la migración (`…wkh191a_debit_signatures.sql:83-85`) y el
   relanzamiento en `debit-capture.ts:288`. No hay en este repo ningún test que ejecute
   ese RPC contra Postgres: los tests lo stubean. Esa limitación está ahora **escrita
   dentro del archivo que hacía la afirmación** (`debit-capture.ownership.test.ts:34-37`),
   que es justamente lo que faltaba.
2. **Que el caso (ii) de BLQ-BAJO-3 se comporte igual contra PostgREST real.** La sonda
   corrió contra `owner-scoped-fake.ts`, no contra Supabase. Lo que sí es verificable sin
   base es la mecánica del código: `fee-split.ts:538-547` sólo loguea si `updateErr` no es
   `null`, y el UPDATE de PostgREST sin `.select()` no reporta filas afectadas.
3. **Los 9 mutantes restantes de los 13.** Re-verifiqué 4 (los de los archivos que toqué).
   Los otros 9 quedan con la evidencia del AR §0 y del `mutation-log.md`, que coinciden
   entre sí fila por fila. Como los cambios de este fix-pack son comentarios (más un
   `delete process.env` en un `afterEach`), la suite completa dando el mismo
   `5358 passed | 19 skipped` es el control de que nada se movió.
4. **Que el conteo del grep de MNR-1 se mantenga.** Es una foto del 2026-08-06 y se mueve
   con cualquier edición de esos comentarios; por eso el párrafo dice qué parte **no**
   depende del número.
