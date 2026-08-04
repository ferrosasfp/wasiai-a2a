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

### [2026-08-04 14:05] Fix-pack — el Story File decía 4, el AR dijo 6, y eran 8
- **Error**: el radio de `query` → `q` se contó **tres veces mal**. F2.5 enumeró 4
  call-sites, el Dev de F3 corrigió esos 4 y no re-grepeó, el AR encontró 2 más, y
  el re-grep de este fix-pack encontró **otros 2** que el AR tampoco tenía
  (`smoke-e2e-cross-chain.mjs:127`, `smoke-e2e-final.mjs:147`).
- **Causa raíz — el mecanismo, no el reproche**: son dos fallas encadenadas, y
  ninguna es "no grepeó".
  1. **Una lista en el Story File se lee como resultado, no como muestra.** El
     Story File traía una tabla cerrada, numerada, con archivo:línea y
     consecuencia. Una tabla así **parece** la salida de un grep exhaustivo, así
     que el paso "verificarla" no se siente como un paso: se siente como releer.
     CD-11 pedía grepear los call-sites *de la firma que se cambia*
     (`parseFiltersOr400`) y eso el Dev SÍ lo hizo — pero el radio real no estaba
     en la firma, estaba **en el cable**: la clave que viaja por HTTP.
  2. **El grep correcto devuelve mayoría de ruido, y un grep ruidoso se abandona.**
     `grep -rn "query:" scripts/ src/ packages/` devuelve ~70 hits, y los primeros
     doce son `JSON.stringify({ query: sql })` contra
     `api.supabase.com/.../database/query`, que no tienen nada que ver. Cuando las
     primeras pantallas son ruido, la conclusión intuitiva es "este grep no sirve"
     y se vuelve a la lista de arriba. El AR cayó en la variante elegante del mismo
     error: grepeó **por nombre de archivo conocido** (los smokes que ya conocía),
     que es un grep limpio — y por eso perdió los dos que no estaban en su cabeza.
- **Fix**: el grep que encuentra los 8 es **por la CLAVE del protocolo**, no por la
  firma ni por el archivo, y con un segundo paso mecánico obligatorio:

  ```
  grep -rnE "(\"|')?query(\"|')?\s*:" scripts/ src/ packages/   # el universo
  grep -rn "/discover" scripts/ src/ packages/                  # el destino
  ```
  y el cruce a mano: para cada hit del primero, **¿a dónde va este `fetch` /
  `http.post`?** Los 12 de Supabase se descartan con una línea de evidencia cada
  uno. El resultado va **escrito en el reporte, con los descartados incluidos** —
  un descarte sin nombre es indistinguible de un hit que no se vio.
- **Aplicar en**: todo rename de un nombre que viaja por el cable (query param,
  campo de body, header, clave de env, columna). La regla mecánica: **cuando el
  radio es un NOMBRE y no una FIRMA, el compilador no ayuda y una lista heredada
  no cuenta como medición.** Y el corolario que cuesta más: **un grep cuyos
  primeros resultados son ruido es el grep correcto la mayoría de las veces** —
  el ruido es la señal de que estás buscando por el eje bueno (el dato) y no por
  el eje cómodo (el símbolo).

### [2026-08-04 14:20] Fix-pack — arreglar la clave no alcanzaba: el smoke era MUDO
- **Error**: `smoke-e2e-comprehensive.mjs` mandaba `{ query: '' }` y no tenía
  **ningún** assert sobre el status. Con el guard nuevo habría recibido 400,
  `discover.agents` habría quedado `undefined`, el `?? []` de la línea siguiente lo
  habría tapado y el script habría impreso
  `✓ HTTP 400 — undefined agents available, 0/5 target slugs found` **con exit 0**.
- **Causa raíz**: el `?? []` estaba puesto como defensa contra "el catálogo vino
  vacío", que es un caso legítimo. El mismo operador absorbe "la request falló", que
  no lo es. Un default que cubre dos causas distintas **borra la que importa**.
- **Fix**: `if (res.status !== 200) → exit 1` antes de tocar el body, en los tres
  `smoke-e2e-*.mjs`. Verificado con un stub local que imita el guard: con la clave
  vieja y sin assert, `exit=0`; con assert, `exit=1`; con la clave nueva, `exit=0` y
  agentes reales.
- **Aplicar en**: todo smoke/script que lea un campo de una respuesta HTTP.
  Regla mecánica: **el status se chequea ANTES de leer el body, y el `?? []` va
  después del chequeo, nunca en su lugar.** Y al arreglar un caller roto, preguntar
  siempre *"¿cómo se habría enterado este script?"* — si la respuesta es "no se
  entera", arreglar la clave sin agregar el assert deja el mismo agujero abierto
  para el próximo rename.

### [2026-08-04 14:40] Fix-pack — dos mutantes distintos con la misma firma de muerte
- **Error**: escribí `T-U9` con la cota Y la anotación de truncado en el mismo `it`.
  Los mutantes "no truncar" y "truncar en silencio" mataban **exactamente el mismo
  conjunto** de tests, así que el set no los distinguía.
- **Causa raíz**: agrupar asertos por tema (*"todo lo del truncado"*) en vez de por
  **propiedad verificada**. Es cómodo de leer y destruye poder discriminante: un
  `it` con N asertos independientes se comporta como un solo test contra N mutantes.
- **Fix**: partirlo en `T-U9` (la cota) y `T-U9b` (que lo anuncie). Firmas ahora
  distintas: sin truncado mata `{T-U9, T-U9b, T-R35, T-R35b}`; truncado mudo mata
  `{T-U9b, T-R35, T-R35b}`.
- **Aplicar en**: es la misma lección de la entrada de las 00:52 de esta HU, vista
  desde el otro lado. Ahí el problema era **un mutante escrito dos veces**; acá es
  **un test que hace dos trabajos**. El síntoma es idéntico (dos mutantes, una
  firma) y el diagnóstico correcto depende de cuál de los dos lados se duplicó:
  si los mutantes son genuinamente distintos, el que hay que partir es el TEST.

### [2026-08-04 14:50] Fix-pack — MENORes evaluados y NO aplicados, con su razón
No todo lo señalado entra. Queda escrito para que nadie lo lea después como olvido:
- **AR BLQ-ALTO-1** (`category` / `cursor` de `wasiai-v2` chocan con el guard) —
  **FUERA a propósito**. Es una decisión de contrato entre dos repos, escalada al
  founder. Agregarlos a `ALLOWED_DISCOVER_PARAMS` "porque es una línea" sería
  decidir el contrato desde el fix-pack. Además `wasiai-v2` es otro repo y hay un
  solo escritor por repo.
- **AR MNR-2 / MNR-3** (`GET /discover/:slug` permisivo; `?verified=1` ignorado en
  silencio) — deudas **TD-322-1** y **TD-322-2**, con dueño. Verificadas: TD-322-1
  está en el CÓDIGO dos veces (`discover.ts:151`, `discovery-query.ts:272`) además
  del SDD; TD-322-2 y TD-322-3 están en `sdd.md:575-576`, que **ahora está
  trackeado** (antes era el único lugar donde existían y no estaba en git).
- **CR MNR-3, la mitad "candado de tipos"** — se aplicó la alternativa mínima que el
  propio CR declara aceptable (la línea en el docstring). El `satisfies` que ate
  `ALLOWED_DISCOVER_PARAMS` con `keyof Querystring` agrega un binding sin uso en
  runtime y obliga a decidir la dirección de la restricción: es scope de HU, no de
  fix-pack.
- **CR MNR-4, la mitad "`mutation-log.md`"** — los 17 mutantes de F3 sólo existen en
  el transcript de aquella sesión, que no tengo. Escribir el log de memoria sería
  fabricar evidencia de mutaciones que yo no corrí. Los **6** mutantes de ESTE
  fix-pack sí están, con su firma de muerte, en los mensajes de commit y acá arriba.

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
