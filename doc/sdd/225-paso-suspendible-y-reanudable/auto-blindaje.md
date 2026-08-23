# Auto-Blindaje — WKH-225 · Corte A

Cada error cometido durante F3, su causa raíz y dónde más puede volver a pasar.
No es una bitácora de progreso: sólo entra lo que se ROMPIÓ.

---

### [2026-08-23 16:40] Wave 0 — El bloque nuevo de `database.types.ts` rompió una cita de `CLAUDE.md`

- **Error**: agregué `a2a_suspended_runs` justo después de `a2a_agent_links`
  (simetría con el exemplar). `npm test` se puso rojo en `G-C5` y `G-C6` de
  `test/cited-lines-guard.test.ts`: `CLAUDE.md` cita
  `src/types/database.types.ts:2567` —el `owner_ref` de `registries`— y mis 95
  líneas la corrieron a `:2662`.
- **Causa raíz**: el Story File enumera las 5 anclas que viven en
  `src/types/index.ts`, `src/services/compose.ts` y `src/routes/compose.ts`, y yo
  leí esa lista como "las citas que puedo romper". Pero el universo del guardián
  son **14 archivos**, y `database.types.ts` es el *target* de una cita que sale
  de `CLAUDE.md`. **El archivo que edito no tiene que estar en `CORTE_A_PATHS`
  para que yo rompa una cita: alcanza con que alguien de esa lista lo apunte.**
- **Fix**: NO actualicé el número. Moví el bloque al FINAL de `Tables`, que es
  línea-neutro para todo lo de arriba, y dejé escrito en el propio archivo por
  qué está ahí y no donde la simetría lo pondría. Cero diff en `CLAUDE.md` —que
  además está fuera del Scope IN— y cero diff en `citations.ts`.
- **Aplicar en**: antes de insertar en CUALQUIER archivo, correr
  `/usr/bin/grep -n "<ruta>" test/cited-lines-guard.citations.ts` para ver si es
  *target* de alguien, no sólo si es *fuente*. Y cuando la elección exista,
  **insertar por debajo del ancla más baja** en vez de re-apuntar la cita:
  re-apuntar es correcto pero mete diff en archivos ajenos a la HU.

---

### [2026-08-23 16:45] Wave 0 — Una línea de PROSA le inventó una columna de dueño a otra tabla

- **Error**: al mover el bloque de tipos al final de `Tables`, dejé arriba un
  docblock que explicaba por qué, y esa explicación nombraba `owner_ref`.
  `npm test` se puso rojo en `G-11` de `test/ownership-filter-guard.test.ts`:
  `soloOraculo: ['webhooks']`. `webhooks` no tiene columna de dueño y nunca la
  tuvo.
- **Causa raíz**: los DOS lectores del archivo de tipos no leen igual. El
  escáner (`deriveTables`) exige `^ {10}owner_ref\??\s*:` — una línea de
  declaración real. El oráculo (`tableBlocks`) corta el archivo por cabeceras y
  después hace `/\bowner_ref\b/` sobre el CUERPO ENTERO del bloque. Todo lo que
  quede entre el `};` de una tabla y la cabecera de la siguiente se le atribuye
  a la **anterior**. Mi comentario cayó ahí.
- **Fix**: reescribí el comentario sin nombrar la columna ("la columna de dueño
  de `registries`"), y dejé escrito EN EL PROPIO COMENTARIO por qué no la
  nombra, para que el próximo no lo "arregle" agregándola.
- **Aplicar en**: cualquier comentario que se escriba dentro de
  `src/types/database.types.ts`, y en general en cualquier archivo que un
  guardián lea por bloques con un regex de cuerpo. **Un guardián que compara
  dos lectores con criterios distintos puede ponerse rojo por prosa**, no sólo
  por código. Antes de escribir un comentario ahí: preguntarse a qué bloque lo
  va a atribuir el lector más laxo.
