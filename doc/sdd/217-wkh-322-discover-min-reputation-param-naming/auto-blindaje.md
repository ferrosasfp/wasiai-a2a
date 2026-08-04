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

---

## Fix-pack 3 (AR-3) — el candado prometía una cobertura que no tenía

### [2026-08-04 03:20] Fix-pack 3 — LA LECCIÓN DE LA RONDA: un mecanismo se prueba por lo que NO caza
- **Error**: el barrido de call-sites que se construyó en el fix-pack 2 para
  "cerrar la clase" declaraba **un solo límite** ("claves construidas en
  runtime") y tenía **nueve**. AR-3 plantó 15 formas distintas de mandar un
  parámetro a `/discover` y **cinco con clave literal y estática pasaron mudas**:
  `new URLSearchParams({query})`, `new URLSearchParams([['query',…]])`,
  `axios.get(…,{params:{query}})`, `'/discover' + '?query=' + v` y un fixture
  `.json` con `"body": {"query": …}`. Ninguna estaba declarada.
- **Causa raíz**: yo verifiqué el mecanismo contra **el repo real**, o sea contra
  las formas que alguien ya había escrito. Eso mide lo que el extractor caza, no
  lo que deja pasar. Un barrido que pasa en verde sobre un repo que no tiene la
  forma peligrosa **no dice nada sobre esa forma**, y sin embargo se lee igual
  que una verificación.
- **Por qué importa aunque no hubiera bug vivo**: ninguna de las 5 formas existe
  hoy en el repo. El daño no es un call-site roto: es que "QUÉ NO CUBRE" existe
  para decirle al revisor siguiente **qué le queda por buscar a mano**. Diciendo
  que la única grieta es runtime, AR-4 no busca `URLSearchParams` y el onceavo
  call-site entra justo por ahí. Es la clase que esta HU vino a matar,
  reencarnada una capa más afuera — y es la misma familia que
  "prosa que afirma de más apaga las revisiones".
- **Fix**: (a) enseñarle 4 de las formas medidas; (b) declarar las otras con su
  **fixture en `T-CS-4`**, que le entra a `scanFile` directo — si algún día
  alguien le enseña una forma declarada como límite, ESE test se pone rojo y
  obliga a actualizar la lista. El acoplamiento entre la prosa y el
  comportamiento es lo que faltaba; (c) escribir explícito que el barrido **no
  sustituye la búsqueda** frente a una forma nueva.
- **Aplicar en**: todo guard, lint, scanner o invariante nuevo. **Antes de
  declarar su alcance, plantar a propósito una docena de variantes y medir cuáles
  pasan mudas.** La lista de límites se escribe con esa medición, no con lo que
  uno recuerda haber programado. Y todo ítem de esa lista **que sea fixturable**
  tiene que tener su caso que lo congele; el que no lo sea hay que marcarlo como
  tal, porque un ítem sin fixture y sin marca no se distingue de uno que dejé sin
  hacer.
  **Corregido en el fix-pack 4** (AR-4 `MNR-2`): la frase original decía "ningún
  ítem de esa lista vale si no tiene un caso que lo congele" y **la propia lista
  no lo cumplía** — `params.set(KEY, x)` estaba declarado desde el principio y era
  el único ítem declarado sin fixture, pudiendo tenerlo (`SP_RE:160-161` exige una
  comilla pegada al `set(`, o sea que le entra a `scanFile` como cualquier otra
  forma plantada). Ya tiene el suyo, con su control. El que **genuinamente no es
  fixturable** es el helper cross-file (`callDiscover({ query })` con el `set(k,v)`
  en otro archivo): congelarlo exigiría dos archivos y el extractor trabaja de a
  uno, así que ahí la declaración es todo lo que hay y hay que decirlo en vez de
  taparlo con un universal que suena mejor.

### [2026-08-04 03:05] Fix-pack 3 — "¿leí algo?" no es "¿leí todo?"
- **Error**: `T-CS-3` existe textualmente para que "no sé qué manda este
  call-site" salga rojo. Pero `hasBody` era un booleano y `topLevelKeys` salteaba
  el spread en silencio, así que
  `body: JSON.stringify({ ...extraFilters, limit: 5 })` salía **VERDE** con un
  solo hit (`limit`) y el `query` real no aparecía ni como hit ni como rojo.
- **Causa raíz**: un extractor parcial que devuelve una lista no distingue "esta
  es la lista completa" de "esto es lo que pude leer". El consumidor asume lo
  primero. El silencio se cuela por el punto donde el mecanismo sabe **a medias**,
  que es peor que donde no sabe nada, porque ahí sí aplaude.
- **Fix**: `topLevelKeys` devuelve `{ keys, unresolved }` y un literal con algo
  sin resolver adentro **deja de contar como body leído**. `OpaquePost` gana
  `reason: 'no-body' | 'partial-body'`.
- **Aplicar en**: cualquier parser/extractor parcial cuyo resultado alimente una
  decisión de "está cubierto". El tipo de retorno tiene que poder decir "incompleto".
  Un `string[]` ya perdió esa información — es el mismo patrón que
  "un `boolean` ya perdió el tercer valor" del money-path.

### [2026-08-04 03:14] Fix-pack 3 — casi tapo el call-site que me pedían destapar
- **Error**: al empezar a barrer los archivos gitignoreados apareció un falso
  positivo (`smoke-prod-via-app-wasiai.mjs:71`, el payload x402 reportado como
  parámetro de `/discover`). Mi primer arreglo fue "un body sólo cuenta si hay un
  `fetch(`/`http.post(` cerca". Puso el barrido en verde.
- **Causa raíz**: el verde. El arreglo escondía **también**
  `smoke-base-downstream.mjs:116`, que manda su body por un helper propio
  (`api(path, { body })`) y por lo tanto no tiene ninguna construcción de request
  al lado. O sea: el arreglo tapaba justo el call-site que `BLQ-BAJO-3` pedía
  destapar, y la suite no lo habría dicho nunca.
- **Cómo lo detecté**: porque re-corrí **la reproducción del AR** (cambiar
  `{ q: GOAL }` por `{ query: GOAL }` y exigir rojo) DESPUÉS de mi arreglo, no
  sólo antes. El test propio pasaba; el que fallaba era el del adversario.
- **Fix**: descartar ese enfoque y usar otro discriminante — una mención al
  endpoint dentro de un **comentario** ya no abre ventana (sí sigue contando para
  la atribución). Queda escrito en el código por qué el otro camino se descartó,
  para que no se vuelva a intentar.
- **Aplicar en**: cuando un arreglo pone algo en verde, re-correr **la
  reproducción del hallazgo**, no la suite. Un fix que hace desaparecer el
  síntoma tiene dos explicaciones posibles y sólo una es buena.

### [2026-08-04 03:10] Fix-pack 3 — 377 tests verdes que no corría nadie
- **Error**: los tres tests de regresión que yo mismo escribí en el fix-pack 2
  para fijar un BLOQUEANTE (`mcp-servers/wasiai-x402/tests/tools.test.mjs`) no
  los ejecutaba ningún runner. Medido: borrar el fix de `handlers.mjs` dejaba CI
  **verde**. La búsqueda destapó un segundo sub-árbol igual: `packages/agent-sdk`.
- **Causa raíz**: escribí el test en el directorio del código que arreglé y di
  por sentado que "los tests corren". El `include` de `vitest.config.ts` es
  `src/**` + `test/**`; nadie nombraba `mcp-servers` ni `packages`.
- **Fix**: el step de CI para los dos sub-paquetes **y** un guardián
  (`test/test-files-are-run-in-ci.test.ts`) que descubre los runners leyendo los
  workflows y se pone rojo si aparece un `*.test.*` fuera del alcance de todos.
  Las dos cosas: el step arregla los casos de hoy, el guardián cierra la clase —
  y sin el step el guardián nace rojo y se termina exceptuando.
- **Aplicar en**: al escribir un test en un directorio nuevo, **verificar que el
  runner lo colecta** (correr el comando de CI, no el del IDE) antes de darlo por
  protección. Una suite huérfana se lee igual que una suite que pasa.

### [2026-08-04 03:24] Fix-pack 3 — extensión de alcance declarada (`docs/api-reference.md`)
- **Qué**: se corrigió `docs/api-reference.md:99`, que publicaba `minReputation`
  con escala `[0,1]` cuando el código valida `[0,100]`, y se agregaron a esa
  tabla `min_reputation` y `allowTrial`, que faltaban. El archivo es preexistente
  en `main` y estaba **fuera del Scope IN**.
- **Por qué se metió igual**: son 2 líneas; esta misma HU ya corrigió la MISMA
  mentira dos veces en otros dos archivos; y el docstring del guard declara que
  `docs/**` "SÍ se verifica" porque una doc que publique un parámetro inexistente
  es el mismo bug escrito en prosa (sólo que el barrido lo daba por verificado
  mirando las CLAVES, no las escalas). Dejar viva una mentira pública **ya
  conocida** para preservar la pureza del scope es peor negocio que ampliarlo.
- **Aplicar en**: la extensión de alcance se declara, no se camufla. Si un
  hallazgo preexistente es de la misma clase que la HU y cuesta dos líneas,
  arreglarlo y anotarlo acá; si cuesta más, abrir deuda con nombre.

### [2026-08-04 04:00] Fix-pack 4 — cada mecanismo declaró más cobertura de la que tenía
- **Error**: el guardián de CI que escribí en el fix-pack 3
  (`test/test-files-are-run-in-ci.test.ts`) prometía traducir cada step a "los
  globs que **realmente** se expanden" y declaraba UN límite. AR-4 midió tres
  vectores, los tres verdes: agregar un `*.test.ts` al `exclude` de
  `vitest.config.ts` (la suite bajaba de 4987 a 4961 tests, guardián en verde),
  un `if:` que nunca resuelve true, y un `continue-on-error: true`. Los tres
  dejaban 26 o 347 tests sin correr con un guardián diciendo que estaban
  cubiertos.
- **Causa raíz**: verifiqué que el step **existiera**, no que **ejecutara**. Es
  el mismo error que el guardián existe para cazar, una capa más afuera: leí el
  `include` y no el `exclude`, leí el `run:` y no el `if:`.
- **Fix**: el `exclude` se resta del set cubierto y un step con
  `if:`/`continue-on-error:` cae en `untranslatable`. Lo que quedó afuera
  (gating a nivel job, `defaults.run`, filtros de CLI, `test.projects`,
  `describe.skip`) está **declarado** en el docstring, no arreglado: elegí
  declarar antes que construir otro mecanismo.
- **El titular de las cuatro rondas**: cada mecanismo que construí para cerrar
  una clase **declaró más cobertura de la que tenía**, y en las cuatro hizo falta
  un adversario **plantando casos** para descubrirlo. El grep del fix-pack 1, el
  barrido del 2, el "leí el body" del 3, el guardián de CI del 4. En ninguna
  ronda lo encontré leyendo mi propio código; en todas apareció cuando alguien
  puso un input que yo no había pensado. Un mecanismo nuevo no reduce el
  problema: lo muda de capa y le suma una promesa nueva que verificar.
- **Aplicar en**: cuando un arreglo tienta a construir otro mecanismo, elegir la
  opción **declarativa**. Un límite bien declarado cierra; un mecanismo a medias
  abre otra ronda. Y todo mecanismo nuevo se verifica plantando el caso que
  debería matarlo, ANTES de escribir lo que promete cubrir.

### [2026-08-04 04:10] Fix-pack 4 — extensión de alcance declarada (`permissions:` en `ci.yml`)
- **Qué**: además del `--ignore-scripts` que pedía `BLQ-BAJO-2`, agregué
  `permissions: contents: read` a nivel workflow en `.github/workflows/ci.yml`.
  No estaba en el encargo del fix-pack.
- **Por qué**: es el otro agujero que nombra el mismo bloqueante de AR-4 ("el job
  `build-test` no declara bloque `permissions:`") y cuesta dos líneas. Sin él los
  jobs heredan el default del repo, que puede ser read/write en todos los scopes.
- **Verificado antes de meterlo** (un `permissions` de menos rompe el workflow y
  eso sería peor que el bug): `actions/checkout` necesita `contents: read`; el
  `cache: npm` de `setup-node` usa el token del servicio de cache de Actions, no
  los scopes del `GITHUB_TOKEN`; y ningún step publica, comenta PRs, sube
  artifacts ni pide OIDC.
