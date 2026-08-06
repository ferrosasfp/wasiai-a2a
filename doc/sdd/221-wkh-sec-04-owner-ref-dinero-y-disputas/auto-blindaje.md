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
