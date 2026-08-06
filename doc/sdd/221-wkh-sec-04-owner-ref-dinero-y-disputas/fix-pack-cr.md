# Fix-pack del Code Review — WKH-SEC-04

> Worktree `/home/ferdev/.openclaw/workspace/wt-sec04`, base `b7fa4e7`, HEAD antes de este
> fix-pack `853ed66` (el fix-pack del AR). Input: `code-review.md` (veredicto **RECHAZADO**:
> 1 `BLOQUEANTE-BAJO` + 3 MENORes).
>
> **Los 4 hallazgos son el mismo defecto, y es auto-infligido**: el fix-pack del AR reescribió
> el header de `debit-capture.ownership.test.ts`, le agregó 18 líneas, empujó el stub
> `mockRpc.mockResolvedValue` de `:173` a `:199`, y dejó la cita apuntando a `:173-176`.
> Se midió contra un archivo que después creció.
>
> **Ninguno de los 4 toca código ejecutable.** Todo cambio en `src/` es una línea de
> comentario (`*` o `//`), verificado abajo. La suite no se movió ni un test.

## Por qué un archivo nuevo y no un apéndice de `fix-pack-ar.md`

Las dos cosas, y por razones distintas:

- **Las correcciones van in-place, en `fix-pack-ar.md`**, porque es ahí donde vive la
  falsedad. Dejar la cita mala y poner la buena en otro documento duplica el puntero y
  garantiza que alguien lea el viejo.
- **La narrativa va acá**, porque `fix-pack-ar.md` documenta la ronda del AR con sus
  «antes → después». Meterle una segunda tanda de «antes → después» hace ambiguo a qué
  ronda pertenece cada número, que es exactamente la clase de confusión que produjo este CR.

---

## `BLQ-BAJO-1` — la cita que el propio fix-pack invalidó al escribirla

- **Sitio**: `src/adapters/escrow/debit-capture.ownership.test.ts:33`.
- **Decía**: `` (`mockRpc.mockResolvedValue(...)`, `:173-176`) ``.
- **Por qué era falso, en las dos lecturas posibles del `:NNN` desnudo**:
  - Como **producción** (la lectura por defecto en ese header: `:205-206`, `:236-242`,
    `:247` son todos de `debit-capture.ts`), `debit-capture.ts:173-176` es la derivación
    del `keyId` con `keccak256`. No es un stub.
  - Como **este archivo**, `:173-176` es un literal del fixture `signatureRow()` con campos
    `debit_nonce`, `debit_key_id_hash`, `debit_hop1_tx_hash`, `debit_settle_status`. **Se
    parece a un stub de firmas** — y ese parecido es lo peligroso: una revisión rápida abre
    la línea, ve algo plausible y da la cita por buena.
- **Cómo quedó**: `` (`mockRpc.mockResolvedValue(...)` de ESTE archivo, `:199-202`) ``. Se
  desambigua el archivo con nombre explícito, que es lo que el header ya hacía cuando
  refería a producción (`debit-capture.ts:275-287` en `:18`, `debit-capture.ts:288` en `:24`).
- **La edición se hizo LÍNEA-NEUTRA a propósito**: el bloque `Y ESTE ARCHIVO NO PUEDE MEDIR
  ESA GUARDA` medía 4 líneas (`:32-35`) y sigue midiendo 4 líneas. Así el stub se queda en
  `:199-202` y las 3 citas de `doc/` que apuntan al bloque no se mueven. **El primer intento
  no fue línea-neutro** (agregaba una quinta línea) y el stub se corrió a `:200` — o sea que
  el fix reprodujo el bug que venía a arreglar. Se detectó re-corriendo el `grep` **después**
  de editar, y se rehízo.
- **La conclusión de la frase no se tocó.** Lo falso era el puntero, no el contenido.

## `MNR-1` — el desfase +2, propagado a `doc/`

Los cuatro rangos se verificaron con `sed -n`, **no** se confió en los números del encargo.

| Documento | Decía | Dice | Verificado contra |
|---|---|---|---|
| `auto-blindaje.md:115` | `:34-37` | `:32-35` | bloque `Y ESTE ARCHIVO NO PUEDE MEDIR…` |
| `fix-pack-ar.md:36` | `:34-37` | `:32-35` | ídem |
| `fix-pack-ar.md:263` (era `:232`) | `:34-37` | `:32-35` | ídem |
| `fix-pack-ar.md:33` | `:20-32` | `:20-30` | bloque `⚠️ HASTA AHÍ LLEGA` (`:31` es la línea `*` vacía) |

**Un quinto que el CR no listó y era el mismo defecto**: `fix-pack-ar.md:37` citaba
`debit-capture.ownership.test.ts:173-176` —con nombre de archivo, o sea inequívocamente
mal— para el stub. Corregido a `:199-202`.

**Y tres más que introduje yo en este fix-pack.** La corrección de `MNR-2` agrega 3 líneas
a `fee-split.ownership.test.ts` a la altura de `:265`, así que todo lo que estaba debajo se
corrió +3, incluidas 3 citas de `fix-pack-ar.md`. Se persiguieron con
`grep -rn "ownership\.test\.ts:[0-9]"` sobre todo el repo:

| `fix-pack-ar.md` | Decía | Dice | Verificado |
|---|---|---|---|
| `:71` | `:287-310` | `:290-313` | `:290` = `const row = findLeg(fake);`, `:313` = `});` |
| `:94` | `:260-272` | `:260-274` | `:260` = `// Y sobre \`reverseFeeSplits\`…`, `:274` = fin del bloque (`:275` blanco) |
| `:127` | `:371-381` | `:374-384` | `:374` = `// ⚠️ Comportamiento REAL…`, `:384` = `expect(out).toMatchObject(…)` |

Los `(antes `:287-290`)` y `(antes `:353-357`)` **NO se tocaron**: refieren al estado del
archivo previo al fix-pack del AR, no al actual.

## `MNR-2` — la glosa describía mal 2 de sus 6 hits

- **Sitio**: `src/services/fee-split.ownership.test.ts:265-272`.
- **Decía**: «`fee-split.ts` (6: la definición y sus logs)» y «Los **dos** conteos de test
  se mueven cada vez que se edita un comentario».
- **Medido, hit por hit** (`command grep -n "reverseFeeSplits" src/services/fee-split.ts`):

  ```
  640:export async function reverseFeeSplits(                                    ← definición
  666:      'reverseFeeSplits select error',                                     ← log
  680:      'reverseFeeSplits ownership mismatch — no legs owned by caller',     ← log
  702:        'reverseFeeSplits update error',                                   ← log
   18: *   - `reverseFeeSplits()`: ledger-only (SG-7). …                         ← COMENTARIO
  628:// ─── reverseFeeSplits (Exemplar 5 — ledger-only, …) ────                  ← COMENTARIO
  ```

  O sea **4 de código y 2 de prosa**, no «la definición y sus logs».
- **Corolario, que es la parte que importa**: si 2 de los 6 hits de `fee-split.ts` son
  comentarios, entonces **tres** conteos se mueven al editar un comentario, no dos. El
  enunciado viejo se presentaba como más estable de lo que es.
- **Lo que NO se tocó**: la conclusión (`reverseFeeSplits` no tiene llamador de producción).
  Sigue siendo correcta y sigue sin colgar de ningún conteo: lo que la sostiene es que el
  único hit fuera de `fee-split.*` (`fee-charge.ts:677`) está dentro de un comentario.
- **Control del auto-conteo**: el párrafo contiene la palabra que cuenta, así que se
  re-corrió el grep **después** de editarlo. Sigue dando **20 hits en 4 archivos** con la
  distribución idéntica (`1 / 6 / 7 / 6`). La edición no movió su propio número porque no
  cambió la cantidad de ocurrencias de `reverseFeeSplits` en el bloque.

## `MNR-3` — una salida atribuida a un comando que no la produce

- **Sitio**: `fix-pack-ar.md:158-161` presentaba
  `$ npx biome check src/ → Checked 472 files … exit 0`, y **cuatro líneas más abajo** el
  mismo documento decía que ese comando acá falla. Los dos no pueden ser ciertos a la vez.
- **No se re-etiquetó a ojo: se volvió a medir**, porque no hay forma de reconstruir cuál
  invocación produjo aquel transcript de `139ms`. Medición propia, **a pelo**, 2026-08-06:

  ```
  $ ./node_modules/.bin/biome check src/
  Checked 472 files in 141ms. No fixes applied.
  exit=0

  $ npx biome check src/
  Lint: 2 errors, 0 warnings
  ═══════════════════════════════════════
  npm error could not determine executable to run
  exit=1
  ```

- **Cómo quedó**: el bloque lleva `./node_modules/.bin/tsc` y `./node_modules/.bin/biome`,
  que son los binarios que produjeron esas dos líneas, más el transcript de arriba pegado
  al lado como refutación, más la nota de cómo medirlo.
- ⚠️ **Y quedó escrito cómo medirlo mal**, porque medirlo mal da el resultado
  tranquilizador: `npx biome check src/ 2>&1 | tail -8; echo "exit=$?"` imprime
  `Checked 472 files …` y `exit=0`. **Las dos cosas falsas**: el `$?` es el de `tail`, y la
  salida sale corrupta por el wrapper del shell. Esa medición mal hecha **se hizo en este
  fix-pack** y por un rato dio por bueno el `npx`; está en `auto-blindaje.md` como entrada
  propia.
- El control del CR se re-verificó: `npx tsc --noEmit` **sí** funciona (`exit=0`). El
  problema es específico de biome.

---

## Control mecánico — cada cita tocada, verificada con `sed -n` DESPUÉS de editar

Recorrido **al final**, no durante. `T` = `src/adapters/escrow/debit-capture.ownership.test.ts`,
`P` = `src/adapters/escrow/debit-capture.ts`, `F` = `src/services/fee-split.ownership.test.ts`,
`S` = `src/services/fee-split.ts`, `A` = `fix-pack-ar.md`, `B` = `auto-blindaje.md`.

| # | Cita, y dónde vive | Apunta a | `sed -n` devuelve |
|---|---|---|---|
| 1 | `T:33` → `` `:199-202` `` | **`T` mismo** (desambiguado en el texto) | `mockRpc.mockResolvedValue({` / `data: [{ persisted_status: 'invalid', … }],` / `error: null,` / `} as never);` |
| 2 | control: el mismo rango en `P:199-202` | `P` (producción) | `status: 'invalid',` / `reason: 'MALFORMED_INPUT',` / `});` / `return;` — **otra cosa**, por eso hacía falta nombrar el archivo |
| 3 | `B:115` → `` T:32-35 `` | `T` | `Y ESTE ARCHIVO NO PUEDE MEDIR ESA GUARDA…` … `o se confirma leyendo la migración, no corriendo este archivo.` |
| 4 | `A:36` → `` `:32-35` `` | `T` | ídem #3 |
| 5 | `A:263` → `` T:32-35 `` | `T` | ídem #3 |
| 6 | `A:33` → `` `:20-30` `` | `T` | `:20` = `⚠️ HASTA AHÍ LLEGA: NO se persiste…`; `:30` = `firma consumible» sería afirmar de más (BLQ-BAJO-1 del AR).`; `:31` = ` *` vacío |
| 7 | `A:37` → `` T:199-202 `` | `T` | ídem #1 |
| 8 | `A:71` → `` F:290-313 `` | `F` | `:290` = `const row = findLeg(fake);`; `:313` = `  });` |
| 9 | `A:94` → `` F:260-274 `` | `F` | `:260` = `// Y sobre \`reverseFeeSplits\` (sitio 4)…`; `:274` = `// en \`fee-charge.ts\`», y omitía los dos archivos de test: MNR-1 del AR.)` |
| 10 | `A:127` → `` F:374-384 `` | `F` | `:374` = `// ⚠️ Comportamiento REAL que conviene tener escrito…`; `:384` = `expect(out).toMatchObject({ status: 'reversed', reversedCount: 1 });` |
| 11 | `F:265` → `` `:640` `` | `S` | `export async function reverseFeeSplits(` |
| 12 | `F:266` → `` `:666` `` | `S` | `'reverseFeeSplits select error',` |
| 13 | `F:266` → `` `:680` `` | `S` | `'reverseFeeSplits ownership mismatch — no legs owned by caller',` |
| 14 | `F:266` → `` `:702` `` | `S` | `'reverseFeeSplits update error',` |
| 15 | `F:267` → `` `:18` `` | `S` | ` *   - \`reverseFeeSplits()\`: ledger-only (SG-7). Itera TODOS los legs \`charged\`` — **comentario**, como afirma la glosa |
| 16 | `F:267` → `` `:628` `` | `S` | `// ─── reverseFeeSplits (Exemplar 5 — ledger-only, itera TODOS los charged) ────` — **comentario** |
| 17 | `F:269` → `` fee-charge.ts:677 `` | `src/services/fee-charge.ts` | ` * \`reverseFeeSplits\` saltea todo row que no sea \`charged\`, \`fee-split.ts:652\`),` — el prefijo ` * ` confirma que está dentro de un comentario |

Citas de los archivos editados que **no** se tocaron y siguen resolviendo: `A:19`
(`T:12-35` → `:12` = `Lo que ese filtro acota es la lectura del \`buyer_wallet\`…`, `:35` =
fin del bloque) y `A:45` (`T:43-53`). Las demás de `A` y `B` apuntan a producción o a
migraciones, que este fix-pack no tocó.

---

## Verificación — salidas reales

```
$ node ./node_modules/vitest/vitest.mjs run
 Test Files  273 passed | 6 skipped (279)
      Tests  5358 passed | 19 skipped (5377)
   Duration  10.18s
```

**Idéntico** a la baseline y a lo que verificó el CR (§4). Ni un test se movió, que es el
control de que no se tocó nada ejecutable.

```
$ ./node_modules/.bin/tsc --noEmit      →  exit 0
$ ./node_modules/.bin/biome check src/  →  Checked 472 files in 153ms. No fixes applied.   exit 0
```

### AC-6 — cero producción, los mismos 8 archivos

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
                                            → 8, los mismos que el AR y el CR verificaron
```

**Y cero líneas ejecutables en este fix-pack.** `git diff 853ed66 -- src` toca 2 archivos
(`debit-capture.ownership.test.ts`, `fee-split.ownership.test.ts`) y **todas** sus líneas
`+`/`-` empiezan con `*` o `//`:

```
$ git diff 853ed66 -- src | grep -E '^[+-]' | grep -v '^[+-][+-]' | grep -cvE '^[+-] *(\*|//)'
0
```

`arbiter/evidence.test.ts` y `debit-capture.test.ts` **no se tocaron**, como manda el encargo
y el Story File (`story-HU-WKH-SEC-04.md:667-668`, §11 Constraint Directives → PROHIBIDO).

### Un quinto puntero falso, encontrado en el barrido y NO reportado por el CR

`fix-pack-ar.md:246` citaba `story-HU-WKH-SEC-04.md:696` + «Out of Scope» para la
prohibición de tocar `evidence.test.ts` / `debit-capture.test.ts`. Medido:

```
$ sed -n '696p' doc/sdd/221-…/story-HU-WKH-SEC-04.md
- **Arreglar cualquier filtro.** Los 12 están. Esta HU no arregla: mide.
```

Es otro bullet, y no menciona ninguno de los dos archivos. La prohibición real está en
`:667-668`, y **no** está en §12 Out of Scope sino en §11 Constraint Directives → PROHIBIDO:
«**Tocar** `evidence.test.ts` / `debit-capture.test.ts` / `fee-split.test.ts` /
`arbiter.test.ts` más allá de una línea de comentario en el header (§9)». Corregido, con la
corrección declarada en el propio `fix-pack-ar.md`.

**Por qué se corrigió aunque no estaba en el encargo**: es exactamente la misma clase que el
`BLOQUEANTE` (un `archivo:línea` que resuelve a algo plausible pero que no es su sujeto),
apareció mientras se hacía el barrido mecánico que el CR pidió, y no toca código ejecutable.
Dejarlo habría sido saber de una cita falsa y firmar el fix-pack igual.

---

## Lo que NO pude verificar

1. **Que `code-review.md` siga resolviendo sus propias citas.** El CR cita
   `fee-split.ownership.test.ts:294-309`, `:307-308`, `:355-359`, `:371-380`, `:263-267`,
   `:265` y `:267-269`; las posteriores a `:265` se corrieron +3 por la corrección de
   `MNR-2`. **No se editaron a propósito**: `code-review.md` es el artefacto del revisor y
   documenta el estado en `853ed66`. Corregirle los números lo convertiría en un documento
   que ya no describe lo que revisó. Queda dicho acá para que el próximo lector lo sepa.
2. **Que el `Lint: 2 errors` de `npx biome` sea siempre reproducible.** Lo reproduje 2 veces
   a pelo en esta sesión (`exit=1` las dos), y 1 vez a través de un pipe con el resultado
   **contrario** (`exit=0`). Es un defecto del wrapper del shell, no del lint; no medí de
   qué depende exactamente. Lo accionable ya está escrito: usar el binario directo, y no
   leer un exit code a través de un pipe.
3. **Los mutantes.** No se re-corrió ninguno: este fix-pack no toca una línea ejecutable, y
   la suite dando el mismo `5358 passed | 19 skipped` es el control de eso. La evidencia de
   mutación sigue siendo la del AR (§0), la del `mutation-log.md` y los 4 independientes que
   corrió el CR (§5).
4. **Que el RPC `capture_debit_signature` rechace contra una base viva.** Sin cambios
   respecto del fix-pack anterior: se verifica leyendo la migración. Es justamente la
   limitación que declara el bloque `T:32-35`, y cuyo puntero era el `BLOQUEANTE` de este CR.

---

## Addendum — el mismo defecto se me repitió DOS veces mientras lo arreglaba

Queda escrito porque es el dato más útil de este fix-pack: la regla «verificar al final»
no es pedantería, es lo único que lo cazó.

1. **Primer intento del `BLQ-BAJO-1`**: la reescritura del bloque agregaba una quinta línea,
   lo que empujó el stub de `:199` a `:200` — o sea que el fix habría dejado la cita
   `:199-202` falsa, exactamente el bug que venía a arreglar. Se detectó re-corriendo
   `grep -n "mockRpc.mockResolvedValue"` **después** de la edición, y se rehízo línea-neutra.
2. **Escribiendo la tabla de este documento**: anoté la fila `A:239 → T:32-35` medida en el
   barrido intermedio, y **después** amplié la sección `MNR-3` de `fix-pack-ar.md`, lo que
   corrió esa línea a `:263`. La fila de mi propia tabla de verificación quedó apuntando mal
   durante un rato. Lo cazó el barrido final.

**Las dos veces la causa fue la misma**: medir un número de línea en un archivo que todavía
iba a crecer. Y las dos veces el síntoma fue invisible sin volver a correr `sed -n`, porque
el rango equivocado seguía devolviendo texto plausible.

### Filas del barrido que no entraron en la tabla de arriba

| # | Cita, y dónde vive | Apunta a | `sed -n` devuelve |
|---|---|---|---|
| 18 | `A:19` → `` T:12-35 `` | `T` | `:12` = `Lo que ese filtro acota es la lectura del \`buyer_wallet\` que ANCLA al firmante`; `:35` = `o se confirma leyendo la migración, no corriendo este archivo.` |
| 19 | `A:45` → `` T:43-53 `` | `T` | `:43` = `registran el filtro y no lo aplican. Un espía prueba QUE LA LLAMADA SE HIZO,`; `:53` = `DC-03/DC-04 lo cubren por comportamiento…` |
| 20 | `A:246` → `` story-HU-WKH-SEC-04.md:667-668 `` | Story File | `- **Tocar** \`evidence.test.ts\` / \`debit-capture.test.ts\` / … más` / `allá de una línea de comentario en el header (§9).` |

**Convención que quedó**: en `debit-capture.ownership.test.ts` un `` `:NNN` `` desnudo
refiere a `debit-capture.ts` (producción). Cuando refiere al propio archivo de test, se
nombra («de ESTE archivo»). Está declarado en el mismo header, en `:33`.
