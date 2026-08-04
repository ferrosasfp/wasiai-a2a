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
- **Fix que escribí acá el 2026-08-04 14:05, y que los hechos DESMINTIERON el
  mismo día** (reescrito el 2026-08-05 con lo que pasó, sin suavizarlo):

  ```
  grep -rnE "(\"|')?query(\"|')?\s*:" scripts/ src/ packages/   # el universo
  grep -rn "/discover" scripts/ src/ packages/                  # el destino
  ```
  Lo declaré "el grep que encuentra los 8". El AR-2 encontró **10**, y los dos
  que faltaban prueban que este procedimiento falla por **dos causas distintas**:

  1. **El alcance dejaba afuera un directorio entero.** `mcp-servers/wasiai-x402/`
     es un cliente HTTP **publicado** de este mismo repo, y no está en `scripts/`
     ni en `src/` ni en `packages/`. `handlers.mjs:141` mandaba `?query=` a
     `/api/v1/capabilities` de v2, que lo reenvía verbatim a `/discover`. Este
     grep no podía verlo: no por ruido, por construcción.
  2. **El otro estaba DENTRO del alcance y se escapó igual.**
     `scripts/smoke-test.sh:229` (`-d '{"query": "test"}'`) matchea el primer
     regex, y `scripts/` está en el scope. O sea: **el grep correcto se corrió y
     el paso de cruce a mano se abandonó** — que es exactamente el modo de falla
     que esta misma entrada diagnostica dos párrafos más arriba. La lección quedó
     escrita y no se aplicó en la sesión que la escribió.

  **Ampliar el grep arregla la causa 1 y NO toca la causa 2.** Un procedimiento
  que depende de que una persona cruce ~70 hits a mano ya falló cuatro veces
  seguidas (4 → 6 → 8 → 10); la quinta también iba a fallar.
- **Fix real (segundo fix-pack)**: `src/__tests__/discover-callsites.test.ts`.
  Enumera los archivos con `git ls-files --cached --others` (un directorio nuevo
  entra solo: la causa 1 no puede repetirse), extrae las claves que viajan hacia
  `/discover` en las 4 formas que el repo usa y las cruza contra
  `ALLOWED_DISCOVER_PARAMS` — la constante real, no una copia. Corre en
  `npm test`, o sea en CI: la causa 2 tampoco puede repetirse, porque ya no hay
  paso humano que abandonar. Probado plantando un onceavo call-site en un
  directorio nuevo (`tools/brandnew/`): rojo, con archivo:línea y clave. Y
  mutado: revertir el `#9` o el `#10` pone `T-CS-2` en rojo, o sea que este test
  **habría cazado los dos que cuatro rondas de grep no vieron**.
- **Aplicar en**: todo rename de un nombre que viaja por el cable (query param,
  campo de body, header, clave de env, columna). Las dos reglas, en orden:
  1. **Cuando el radio es un NOMBRE y no una FIRMA, el compilador no ayuda y una
     lista heredada no cuenta como medición.**
  2. **Un procedimiento manual escrito en un `.md` no es un mecanismo.** Si el
     paso que evita el bug es "acordate de correr esto y cruzarlo a mano", el bug
     vuelve. Enunciar la regla no alcanza: hace falta algo que se ponga rojo
     solo. El costo de escribir ese test fue una tarde; el de no escribirlo,
     cuatro rondas de AR.

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

### [2026-08-05 02:15] Fix-pack 2 — mi propio comentario apagó el chequeo que acababa de escribir
- **Error**: el barrido de call-sites exime las ventanas que "esperan el
  rechazo", detectándolas por la presencia del texto `UNKNOWN_DISCOVER_PARAM`
  cerca. Arriba del `searchParams.set('q', …)` de `handlers.mjs` yo había escrito
  un comentario que explica el fix y **menciona `UNKNOWN_DISCOVER_PARAM`**. El
  barrido dejó de mirar ese call-site: el único de `mcp-servers/` desapareció del
  inventario y `T-CS-0` se puso rojo por la razón correcta (no encontraba hits en
  ese directorio).
- **Causa raíz**: una excepción basada en TEXTO se apaga escribiendo el texto.
  Y el texto que la apaga es justamente el que uno escribe al documentar el fix,
  o sea que la exención se activa donde más molesta.
- **Fix**: restringir la exención a archivos `*.test.*`. En código normal un
  comentario ya no puede apagar el chequeo. Verificado: con la restricción, el
  hit de `handlers.mjs` vuelve y `T-CS-0`/`T-CS-1` pasan.
- **Aplicar en**: toda regla de lint/scan con escape hatch textual. Preguntarse
  **"¿quién más puede escribir este texto sin querer apagarme?"**. Si la
  respuesta incluye "un comentario que explica el fix", la exención necesita otra
  condición (tipo de archivo, marcador explícito, contexto sintáctico).

### [2026-08-05 02:20] Fix-pack 2 — el barrido pasó en verde sobre un POST que no sabía leer
- **Error**: `T-CS-3` (los POST cuyo body el extractor no entiende) usaba una
  ventana de proximidad en caracteres para decidir "¿este POST tiene un body
  legible?". Planté a propósito un call-site con el body armado por una función
  (`JSON.stringify(body)` con `body = buildBody(t)`) y **pasó en verde**: el body
  literal de la llamada de ARRIBA, 5 líneas antes, caía dentro de su ventana y lo
  "cubría".
- **Causa raíz**: proximidad no es pertenencia. Dos llamadas seguidas comparten
  ventana, así que la evidencia de una vale como evidencia de la otra — y el modo
  de falla va en la dirección insegura (verde).
- **Fix**: cada body se le asigna a UNA sola llamada, la más cercana
  (`ownerOf`), y una llamada sólo cuenta como "legible" si hay un body cuyo dueño
  es ella. Con eso el call-site plantado se pone rojo.
- **Aplicar en**: cualquier análisis por ventanas (lint, scanners, correlación de
  logs, matching de eventos). **Si dos cosas del mismo tipo pueden caer en la
  misma ventana, hay que asignarle dueño a la evidencia.** Y el corolario de
  método: este bug sólo apareció porque probé el mecanismo AL REVÉS, plantando un
  caso que debía ponerlo rojo. Un mecanismo nuevo que sólo se verificó en verde
  no está verificado.

### [2026-08-05 02:28] Fix-pack 2 — usé una API de ES2024 en un repo con target ES2022
- **Error**: escribí `expect(msg.isWellFormed()).toBe(true)` en `T-U9c`. Vitest
  pasó (Node 22 la tiene) y `npx tsc --noEmit` falló: `Property 'isWellFormed'
  does not exist on type 'string'` — `tsconfig.json` fija `target: ES2022`.
- **Causa raíz**: el runtime de los tests es más nuevo que el `lib` del
  compilador, así que una API moderna pasa la corrida y muere en el typecheck.
  El test verde da la sensación de terminado.
- **Fix**: afirmar la propiedad directo con un regex de suplente suelto, en vez
  de subir el `target` del repo entero por un aserto de un test (eso sería
  scope de otra HU).
- **Aplicar en**: `npx tsc --noEmit` va SIEMPRE, aunque la suite esté verde.
  `npm run build` tampoco alcanza (`tsconfig.build.json` excluye los tests): es
  literalmente la lección de WKH-196 en este mismo repo.

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
