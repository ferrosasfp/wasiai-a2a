# Auto-Blindaje — WKH-322 (F3)

Errores cometidos durante la implementación y cómo se corrigieron. Se documentan
para que la próxima HU no los repita.

### [2026-08-04 00:47] Wave 1 — usé una clase en el `catch` sin importarla
- **Error**: agregué `err instanceof UnknownDiscoverParamError` a la cadena de
  `catch` de `parseFiltersOr400` y no sumé la clase al `import` de
  `../lib/discovery-query.js`.
- **Causa raíz**: escribí el bloque `catch` y el bloque `try` en la misma edición
  y actualicé el import pensando sólo en las funciones nuevas
  (`assertKnownDiscoverParams`, `resolveMinReputation`), no en las 3 clases de
  error nuevas.
- **Fix**: sumar `UnknownDiscoverParamError` al import. `tsc --noEmit` lo habría
  cazado igual, pero lo vi antes de correrlo.
- **Aplicar en**: cualquier wiring que agregue clases de error a una cadena
  `instanceof`. El patrón de este repo es "una clase por causa", así que un
  `catch` nuevo casi siempre implica varios imports, no uno.

### [2026-08-04 00:48] Wave 0 — escribí un test que medía la constante contra sí misma
- **Error**: `T-U7` iteraba `ALLOWED_DISCOVER_PARAMS` para afirmar que "todas las
  claves aceptadas no lanzan". Agregar `pepito` a la constante habría hecho pasar
  el test afirmando que `pepito` es un parámetro público.
- **Causa raíz**: es la trampa que el propio Story File describe en §7.3 (CD-10),
  y la escribí igual: iterar la constante es la forma cómoda de cubrir 10 casos.
  El sesgo va en la dirección insegura cuando el test es POSITIVO.
- **Fix**: `T-U7` pasó a nombres escritos a mano, y la enumeración exhaustiva de
  los 10 parámetros quedó sólo en `T-R30`, también a mano, tomada de
  `doc/INTEGRATION.md` y de las firmas `Querystring`/`Body` de la ruta. Los tests
  NEGATIVOS (`T-R27`) sí leen la constante: ahí el sesgo va en la dirección segura.
- **Aplicar en**: todo test sobre una allowlist/denylist exportada. La regla
  mecánica: **si el test es positivo, los nombres se escriben a mano; si es
  negativo, puede leer la constante.**

### [2026-08-04 00:52] Wave 2 — mutante que no probaba lo que decía
- **Error**: el mutante "invertir el orden forma/valor" (§7.1, DT-8) lo
  implementé BORRANDO la llamada a `assertKnownDiscoverParams`. Murió — pero
  murió con los mismos 8 tests que el mutante "guard ausente", porque era el
  mismo mutante escrito dos veces.
- **Causa raíz**: borrar es más fácil que reordenar, y el resultado (`rojo`) se
  parece lo suficiente al esperado como para darlo por bueno. Un mutante que
  muere por el motivo equivocado no verifica nada: sólo confirma un test que ya
  estaba verificado por otro mutante.
- **Fix**: reescribirlo como un reorden real (parsear los valores, y recién
  después chequear las claves). Así muere exactamente `T-R31`/`T-R31b` y nadie
  más, que es la prueba de que ESE test es el que pina el orden.
- **Aplicar en**: toda disciplina de mutación. Si dos mutantes distintos matan
  exactamente el mismo conjunto de tests, hay que sospechar que son el mismo
  mutante. La firma de muerte debería ser distinta si el mutante es distinto.

### [2026-08-04 00:50] Wave 1 — corrí el lint al final y estaba rojo por formato
- **Error**: `npm run lint` (biome) falló en los 3 archivos que toqué, sólo por
  formato (line wrapping de una llamada larga y de un `it.each`).
- **Causa raíz**: escribí el código a mano sin pasar el formateador, y dejé el
  lint para el final del wave.
- **Fix**: `npx biome format --write` sobre los 3 archivos tocados (no sobre
  `src/` entero, para no mezclar reformateos ajenos en el diff de la HU).
- **Aplicar en**: correr `npm run lint` ANTES del commit de cada wave, no al
  final de la HU. `main` ya estuvo rojo por saltear esto (commit `34e1f2b`).

### [2026-08-04 00:53] Wave 1 — inserté un párrafo en el medio de una lista de JSDoc
- **Error**: metí el párrafo de `UNKNOWN_DISCOVER_PARAM` entre el bullet de
  `min_reputation` y el de `limit`, partiendo en dos la lista de parámetros del
  JSDoc del handler.
- **Causa raíz**: anclé la edición al bullet que acababa de agregar en vez de al
  final de la lista.
- **Fix**: moverlo después del último bullet (`allowTrial`) y antes de la sección
  "Respuesta".
- **Aplicar en**: ediciones dentro de bloques de documentación largos. Conviene
  anclar al final de la sección, no a la línea recién escrita.
