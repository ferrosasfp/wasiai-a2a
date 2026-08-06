# Auto-Blindaje — WKH-SEC-04 (F3)

Los errores que cometí yo durante la implementación, con su causa y dónde más
pueden reaparecer. No es la lista de hallazgos sobre el código: es la lista de
veces que me equivoqué.

---

### [2026-08-06 10:44] Wave 4 — Cité un documento que todavía no estaba en el índice de git

- **Error**: reescribí el punto 8 del header de `test/ownership-filter-guard.test.ts`
  apuntando a `doc/sdd/221-…/mutation-log.md`. El archivo existía **en disco**, pero
  la carpeta entera estaba sin `git add`. La suite completa se puso en rojo:
  ```
   FAIL  test/docs-referenced-by-code-exist.test.ts > … > ★ toda referencia con forma de ruta resuelve
   AssertionError: Estos documentos los cita el código y NO están en el repo.
     doc/sdd/221-…/mutation-log.md  ← test/ownership-filter-guard.test.ts
  ```
- **Causa raíz**: asumí que «el archivo existe» y «el archivo está en el repo» son lo
  mismo. No lo son: `git status --porcelain` mostraba `?? doc/sdd/221-…/` desde el
  primer minuto de la sesión y lo leí como ruido del worktree. Un `checkout` limpio
  no habría traído ese archivo, y el puntero del comentario habría quedado roto en
  `main` sin que nadie lo notara.
- **Fix**: `git add doc/sdd/221-wkh-sec-04-owner-ref-dinero-y-disputas/`. Suite de
  vuelta en `5358 passed | 19 skipped (5377)`, `0 failed`.
- **Aplicar en**: cualquier comentario de código que cite un `doc/…`. El mismo
  guardián (`test/docs-referenced-by-code-exist.test.ts`) lo caza, pero **sólo si
  corrés la suite completa después de escribir el comentario** — correr nada más el
  archivo que tocaste no lo detecta. Vale también para el `_INDEX-row.md`, que por
  convención va staged.
- **Nota**: este error lo cazó un test que ya existía. Es el mismo mecanismo que esta
  HU entera está construyendo para los filtros por dueño, funcionando sobre mí.

---

### [2026-08-06 10:40] Wave 4 — Mis propias ediciones corrieron las líneas que yo citaba

- **Error**: agregué 6 líneas al header de `src/services/arbiter/evidence.test.ts` y
  otras 6 al de `src/adapters/escrow/debit-capture.test.ts`. Todas las citas a esos
  dos archivos —incluidas las de los headers de mis archivos nuevos, escritos
  ANTES— quedaron corridas +6: `evidence.test.ts:49` (el `eq: () => b`) pasó a ser
  `:55`, `:36` (el único `OWNER`) a `:42`, `:186` (el test «de otro owner») a `:192`;
  y en `debit-capture.test.ts`, `:79`/`:463` (los `eq: () => builder`) pasaron a
  `:85`/`:469` y el espía de `:533` a `:539`.
- **Causa raíz**: escribí las citas leyendo el árbol base y después edité los mismos
  archivos. Nada las revalida: una cita a `archivo:línea` es correcta en el momento
  en que se escribe y falsa en cuanto alguien inserta una línea más arriba.
- **Fix**: re-verifiqué las 6 con `command grep -n` sobre el estado FINAL y corregí
  las 4 ubicaciones donde aparecían (los dos headers ajenos y los dos míos). Y en la
  primera pasada del fix me quedó una sin corregir (`:49` en el propio comentario que
  acababa de escribir), o sea que el error se repitió dentro de su propia corrección:
  hizo falta un segundo `grep -n` para cerrarlo.
- **Aplicar en**: toda HU que edite un archivo que ella misma cita. Es reincidente en
  este repo (`doc/sdd/220-…/auto-blindaje.md:25-36`: una nota de 4 líneas corrió una
  cita de `:212` a `:216`). La regla que funciona no es «tener cuidado»: es
  **re-verificar al cierre, con `grep -n`, toda cita a un archivo que la HU toca**, y
  hacerlo DESPUÉS de la última edición, no durante.

---

### [2026-08-06 10:34] Wave 3 — Escribí un aserto sobre el fixture que yo había supuesto, no leído

- **Error**: FS-02 y FS-03 afirmaban `expect(row?.tx_hash).toBeNull()` y
  `expect(row?.error_message).toBeNull()`. Fallaron con
  `expected undefined to be null`.
- **Causa raíz**: la fila la crea el INSERT de `chargeLeg` (`fee-split.ts:393-401`),
  que **no manda** esas dos columnas. En la base real el DEFAULT las deja `NULL`; en
  la tabla en memoria del falso quedan **ausentes**. Yo estaba afirmando sobre el
  esquema que imaginé, no sobre el estado que el código produce.
- **Fix**: `expect(row?.tx_hash ?? null).toBeNull()`, con el comentario que explica
  por qué el `?? null` está ahí. El aserto que importa —que la fila no tiene el
  `tx_hash` de A— se mantiene, y ahora dice lo que mide.
- **Aplicar en**: cualquier aserto sobre una columna que el INSERT no escribe. El
  modo de falla es ruidoso acá (el test explota), pero la versión silenciosa del
  mismo error es peor: si hubiera escrito `expect(row?.tx_hash).toBeFalsy()`, habría
  pasado por la razón equivocada y con el filtro borrado también.

---

### [2026-08-06 10:26] Wave 1 — Verifiqué el lint con un comando que fallaba por otra cosa

- **Error**: `npx biome check src/` devolvió `Lint: 2 errors` mezclado con
  `npm error could not determine executable to run`. Leí los «2 errors» como el
  resultado del lint.
- **Causa raíz**: dos salidas superpuestas. `npx` no resolvía el binario, así que el
  conteo que estaba leyendo no era de esa corrida.
- **Fix**: usar el binario directo, `./node_modules/.bin/biome check src/` y
  `./node_modules/.bin/tsc --noEmit`, que dan un exit code confiable. Los errores de
  orden de imports que sí existían se corrigieron aparte.
- **Aplicar en**: todo control de calidad de una wave. Es la misma clase de la
  Trampa C del Story File (el runner colapsando su salida) y de la Trampa D (un
  proceso que sale con `0` sin haber hecho nada): **si el comando puede fallar por un
  motivo distinto del que estás midiendo, su salida no es evidencia**. Vale igual
  para `npx vitest run`, que se usó siempre como `node ./node_modules/vitest/vitest.mjs run`.

---

### [2026-08-06 11:15] Fix-pack AR — Escribí tres afirmaciones que mi propio archivo no podía refutar

- **Error**: en los headers y comentarios de los `*.ownership.test.ts` afirmé tres cosas
  que un comando concreto desmiente: que sin el filtro «**se persiste** una firma
  consumible» (`debit-capture.ownership.test.ts`), que «un espía pasa igual con el nombre
  de la columna **mal escrito**» (mismo archivo, y propagado a `mutation-log.md` y
  `_INDEX-row.md`), y que «el `updateErr` **sólo se loguea**»
  (`fee-split.ownership.test.ts`). Las tres las cazó el AR, cada una con un comando.
- **Causa raíz**: las tres frases describen algo que ocurre **fuera del alcance del
  archivo donde las escribí** — lo que persiste el RPC (que el propio test **stubea**),
  lo que hace otro archivo de test, y una rama de log que en ese escenario **no corre**.
  Al no ser observables desde ahí, ninguna corrida las podía poner en rojo: eran
  infalsificables **dentro de su propio archivo**, y por eso sobrevivieron a la suite
  verde y a mi relectura. El pecado no fue equivocarme de mecánica: fue escribir una
  consecuencia que no medí, al lado de una que sí medí, con el mismo tono.
- **Fix**: reescribir a lo medido y **pegar al lado el comando que refuta**. Y cuando la
  frase habla de algo que el archivo no puede observar, **decirlo con todas las letras**
  (ver `debit-capture.ownership.test.ts:32-35`: «este archivo NO puede medir esa guarda,
  DC-01..DC-04 stubean el RPC»). Antes de afirmar el efecto **posterior** de un filtro
  —persistencia, log, contador—, correr la sonda: 3 de 3 veces el efecto real fue
  distinto del que había supuesto, y en el caso del log era **peor** (mudo, no logueado).
- **Aplicar en**: todo docblock, comentario y fila de `_INDEX` que describa una
  consecuencia. Prueba de bolsillo antes de escribir una frase: **¿qué corrida la pone en
  rojo si deja de ser cierta?** Si la respuesta es «ninguna, porque acá está mockeado»,
  la frase no va, o va declarada como no medible. Vale doble para la prosa que se
  **propaga**: la de `BLQ-BAJO-2` viajó del test al `mutation-log.md` y de ahí al
  `_INDEX-row.md`, y hubo que corregir los tres.

---

### [2026-08-06 11:30] Fix-pack CR — El fix-pack anterior invalidó su propia cita al escribirla

- **Error**: al reescribir el header de `debit-capture.ownership.test.ts` para cerrar
  `BLQ-BAJO-1` del AR, le agregué 18 líneas. Eso empujó el stub `mockRpc.mockResolvedValue`
  de `:173` a `:199` — y la cita que escribí en ese mismo commit quedó diciendo `:173-176`.
  El CR lo marcó BLOQUEANTE. Los **4** hallazgos del CR son el mismo defecto: cité números
  medidos contra un estado del archivo anterior a mi propia edición.
- **Causa raíz**: medí **mientras** editaba, no **después**. Y hay un agravante que
  convierte el error en trampa: `sed -n '173,176p'` sobre ese test devuelve un literal con
  campos `debit_nonce`, `debit_key_id_hash`, `debit_hop1_tx_hash`, `debit_settle_status`.
  **Se parece a un stub de firmas.** Un revisor que abre la línea ve algo plausible y
  estampa OK. Es `evidencia-que-se-autoconfirma` aplicada al puntero que sostenía la única
  frase escrita para cerrar el bloqueante. Segundo factor: en ese header los `:NNN`
  desnudos refieren a `debit-capture.ts`, así que un `:NNN` suelto **se lee como producción
  por defecto** — y `debit-capture.ts:173-176` también existe y también es plausible
  (`keccak256(stringToBytes(keyId))`). Las dos lecturas fallan, ninguna avisa.
- **Fix**: (a) la cita pasa a `:199-202` **con el archivo desambiguado** («de ESTE
  archivo»), verificado con `sed -n '199,202p'` **después** de cerrar la edición; (b) la
  edición se hizo **línea-neutra a propósito** —el bloque sigue midiendo 4 líneas, `:32-35`—
  para que las 3 citas de `doc/` que apuntan a él no se movieran; (c) el desfase +3 que sí
  introduje en `fee-split.ownership.test.ts` se persiguió hasta sus 3 citas en
  `fix-pack-ar.md` (`:71`, `:94`, `:127`) y se corrigió cada una contra `sed -n`.
- **Aplicar en**: cualquier tarea que edite un archivo **y** lo cite. Dos reglas mecánicas,
  y la segunda es la que faltaba:
  1. **Verificar las citas al final, nunca durante.** Recorrer cada `` `:NNN` `` del diff con
     `sed -n 'NNNp' <archivo>` y pegar la salida. Si una cita apunta a un archivo distinto
     del que la contiene, decirlo explícitamente.
  2. **Preferir la edición línea-neutra** cuando el bloque editado es destino de citas
     externas. Si no se puede, **buscar quién lo cita antes de dar por cerrado**
     (`grep -rn "<archivo>:[0-9]"`), porque el desfase viaja: acá viajó a 3 documentos.
  3. Corolario del agravante: cuando el `:NNN` es del **propio** archivo pero el header
     usa `:NNN` desnudo para otro, **nombrar el archivo**. Un rango que resuelve a algo
     «parecido a lo esperado» es peor que uno que resuelve a nada.

---

### [2026-08-06 11:34] Fix-pack CR — Medí `npx biome` con un pipe y me dio el resultado tranquilizador

- **Error**: para verificar `MNR-3` corrí `npx biome check src/ 2>&1 | tail -8; echo
  "exit=$?"`. Devolvió `Checked 472 files in 138ms. No fixes applied.` y `exit=0`, o sea
  **lo contrario** de lo que decía el CR. Estuve a punto de escribir que el hallazgo del CR
  no se reproducía.
- **Causa raíz**: dos fallas sumadas en un solo comando. (1) `$?` después de un pipe es el
  del **último** proceso — medí el exit code de `tail`, no el de `npx`. (2) La salida
  redirigida a través del wrapper de este shell sale corrupta con exit 0 (lección
  `rtk-proxy-corrupts-redirected-output`). Las dos empujan en la **misma** dirección: verde.
- **Fix**: re-medir **a pelo**, sin pipe y sin redirección. Ahí sí:
  `npx biome check src/` → `Lint: 2 errors, 0 warnings` + `npm error could not determine
  executable to run`, `exit=1`; `./node_modules/.bin/biome check src/` →
  `Checked 472 files in 141ms. No fixes applied.`, `exit=0`. El CR tenía razón.
- **Aplicar en**: toda verificación cuyo veredicto sea el **exit code**. Nunca `cmd | tail;
  echo $?`. Si hace falta filtrar, capturar el exit **antes** (`cmd; rc=$?`) o usar
  `PIPESTATUS[0]`. Y desconfiar por default del verde que llega por un pipe: acá el error
  de medición y el bug del wrapper apuntaban los dos al falso negativo.
