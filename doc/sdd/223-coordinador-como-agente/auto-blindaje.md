# Auto-Blindaje — WKH-360 / `223-coordinador-como-agente` (F3)

> Cada error MÍO de esta sesión, con causa raíz y dónde más puede volver. No es un
> changelog: es el archivo que protege a la próxima HU del mismo error.
>
> Base: `3823580`. Rama: `feat/223-wkh-360-coordinador-agente`.

---

### [2026-08-17 15:26] Wave 0 — El techo `>=` hizo que mi test midiera el paso 6 en vez del paso 4

- **Error**: `T-U-DEPTH-2` afirmaba cubrir "el rango completo del regex" con
  `read(undefined, '999', ['gw.example.com'], 999)` y esperaba `ok: true`. Dio
  `ok: false`.
- **Causa raíz**: pasé el MISMO número como valor y como techo. El corte del paso 6
  es `depth >= depthMax`, así que `999 >= 999` rechaza. El `it` decía estar midiendo
  el PARSEO (paso 4) y en realidad estaba midiendo el TECHO (paso 6). Si lo hubiera
  "arreglado" cambiando el `expect` a `false`, habría quedado un test verde que
  dice cubrir el parseo de 3 dígitos y no lo cubre — un testigo apagado.
- **Fix**: `depthMax = 1000`, con el motivo escrito en el propio test (dos líneas de
  comentario explicando por qué no puede ser 999).
- **Aplicar en**: todo test de un guard con comparación NO estricta. Si el valor de
  entrada y el umbral son el mismo número, el test no puede distinguir qué cláusula
  lo rechazó. Vale para `MUT-10` (`>` vs `>=`): si el input de `T-DEPTH-1` fuese
  `depth == depthMax + 1` en vez de `== depthMax`, `MUT-10` **sobreviviría** y el
  mutante quedaría mintiendo.

---

### [2026-08-17 15:26] Wave 0 — Confundí el camino de la ENV con el del HEADER en la lectura de la profundidad

- **Error**: `T-U-MAX-3` metió `' 2'` en la lista de valores que
  `isContractingDepthMaxMisconfigured()` tiene que marcar `true`. Dio `false`.
- **Causa raíz**: apliqué CD-14 ("ni `parseInt` ni `Number`") a los DOS caminos como
  si fueran uno. No lo son, y la diferencia es **quién controla el valor**:
  - la **profundidad del HEADER** la controla un **tercero**, y ahí `' 2'` leído
    como `2` es el ataque (`parseInt(' 2',10) === 2`, medido). Se RECHAZA;
  - el **techo de la ENV** lo escribe el **operador** en un panel de Railway, y ahí
    `' 2'` es un espacio de más. Se trimea y se lee 2; cualquier cosa que no sean
    dígitos cae igual al default del código.
- **Fix**: saqué `' 2'` de esa lista y escribí un `it` NUEVO (`T-U-MAX-7`) que
  asserta la **asimetría** con el mismo string en los dos caminos, más el párrafo
  "ASIMETRÍA DELIBERADA … NO se unifican" en el docblock de
  `resolveContractingDepthMax`. Sin ese texto, el próximo que lea CD-14 "unifica
  por consistencia" y rompe uno de los dos.
- **Aplicar en**: cualquier regla de parseo estricto. Antes de aplicarla, preguntar
  **quién escribe ese valor**. Una regla anti-adversario aplicada a config de
  operador genera fricción sin cerrar nada; la inversa (leniencia de operador
  aplicada a input de tercero) es el agujero.

---

### [2026-08-17 15:29] Wave 0 — Agregué 2 env vars y dejé en falso un número publicado en los DOS README

- **Error**: la suite completa pasó de verde a `2 failed`:
  `test/readme-numbers.test.ts` → `expected 181 to be 183`, en `README.md` y en
  `README.es.md`.
- **Causa raíz**: `.env.example` tiene un número publicado en prosa
  (*"documents **181 variables**"*) y hay un guardián que lo **re-deriva** en cada
  `npm test` con `grep -cE '^[A-Z][A-Z0-9_]*=' .env.example`. Agregar
  `A2A_SELF_HOSTS` y `A2A_CONTRACTING_DEPTH_MAX` movió la cuenta a 183. No lo
  previne porque leí el Scope IN (`.env.example`) sin preguntarme **quién más
  afirma algo sobre ese archivo**.
- **Fix**: 181 → 183 en los dos README, con la cuenta **derivada**
  (`/usr/bin/grep -cE '^[A-Z][A-Z0-9_]*=' .env.example` → `183`), no incrementada a
  mano. Son 2 archivos que el Scope IN de §14 no lista: entran por **CD-21**
  ("reescribir, en el mismo commit, las prosas que esta HU vuelve falsas"), y la
  edición es de UN número por archivo, línea-neutra.
- **Aplicar en**: **este guardián funcionó y por eso el error costó 3 minutos.** La
  lección no es "acordate del README": es que tocar un archivo con un conteo
  publicado obliga a buscar al productor de ese conteo ANTES de editar
  (`/usr/bin/grep -rln "\.env\.example" test/`). Los candidatos vivos en este repo
  son `ENV_VARS`, `TEST_FILES` y `LINTED_FILES` de `test/readme-numbers.test.ts`:
  **agregar un archivo `.test.ts` o un archivo lintables tiene el mismo efecto** —
  y esta HU agrega al menos tres archivos nuevos, así que va a volver a morder en
  W2 y en W3.

---

### [2026-08-17 15:32] Wave 0 — Mi propia aritmética de desplazamiento (CD-11) ubicó mal una cita

- **Error**: al derivar el mapa de citas desplazadas de `src/types/index.ts` le
  asigné a `AgentCard` un delta de **+65** (⇒ `:1744`). El real es **+94**
  (⇒ `:1773`).
- **Causa raíz**: los deltas son **acumulados por posición**, y yo reusé el delta
  del tramo anterior. La inserción de `AgentSkill` (`@@ -1676,0 +1742,29 @@`, +29
  líneas) está **ARRIBA** de `AgentCard` (old `:1679`), así que le suma. El número
  +65 lo había verificado con un `grep` corrido **antes** de esa inserción, o sea
  que era cierto cuando lo medí y dejó de serlo por mi propia edición posterior —
  exactamente la clase "las citas que rompés vos al arreglar otra cosa".
- **Fix**: verificar **por CONTENIDO** y no por aritmética. El control que lo cazó
  compara `HOY[n]` contra `BASE[n − delta]` línea por línea; los dos "DRIFT" que
  reportó eran mi tabla, no el archivo. Mapa corregido y re-verificado:
  `374→374`, `989→989`, `1027→1027`, `1091→1128-1133` (1 línea pasó a 6),
  `1144→1186`, `1398→1463`, `1673→1738`, `1679→**1773**`, fin `2107→2220`.
- **Aplicar en**: W1/W2/W4, que tocan `src/services/compose.ts` (1571),
  `src/routes/compose.ts` (1132) y `src/services/orchestrate.ts` (1540) en
  **varios puntos de inserción por archivo**. Con más de una inserción, el delta de
  una cita **no** es el delta de la última hunk: hay que sumar todas las hunks que
  estén por encima. Y una verificación hecha entre dos ediciones de la misma wave
  **caduca**: se re-corre después de la ÚLTIMA edición.

---

### [2026-08-17 15:44] Wave 1 — El guardián de conteos lee el ÍNDICE DE GIT, así que la suite verde de W0 se volvió roja al commitear

- **Error**: W0 cerró con `suite_exit=0` y ese número fue al commit message. Al
  arrancar W1, la MISMA suite sin ningún cambio mío daba **4 rojos** en
  `test/readme-numbers.test.ts`: `expected 286 to be 287` (archivos de test) y
  `expected 477 to be 479` (archivos que linta Biome).
- **Causa raíz**: ese guardián deriva sus conteos de **`git ls-files`**
  (`test/readme-numbers.test.ts:82-92`), o sea del **índice**, no del working tree.
  Cuando corrí la suite en W0 los dos archivos nuevos del leaf estaban **sin
  trackear**, así que no los contaba y los números viejos de los README seguían
  siendo ciertos. El `git add` del commit los hizo tracked y ahí los números se
  volvieron falsos. **Mi verde de W0 era cierto en el momento en que lo medí y
  falso un segundo después, por mi propio commit.**
- **Fix**: (a) los números derivados, no incrementados a mano
  (`290` y `482`, sacados de `git ls-files` filtrado por los globs de
  `vitest.config.ts` y `biome.json`); (b) **el cambio de protocolo, que es lo que
  vale**: `git add -A` PRIMERO y **después** correr la suite, para que la medición
  sea la del estado que se va a commitear.
- **Aplicar en**: W2 y W3 **agregan más archivos** (`contracting-guard.ts` +
  su test, `well-known.test.ts`), así que esto vuelve a morder en las dos.
  Generalización: **una wave que agrega o borra un archivo trackeado tiene que
  stagear antes de medir.** Y más general todavía: cuando un guardián deriva de
  `git ls-files`, `git diff` o `git log`, la pregunta no es "¿corrí la suite?" sino
  "¿la corrí contra el estado que voy a entregar?".

---

### [2026-08-17 15:45] Wave 1 — El Story File listaba 3 mocks que rompen `tsc`; el cuarto rompe en RUNTIME y no estaba

- **Error**: extendí `resolveAgentDestination` con `invokeUrl`, arreglé los 3 mocks
  tipados que §3.6 del Story File lista, `tsc` dio 0 — y la suite dio **3 rojos**
  en `src/services/agent-price.test.ts` (`T-DEST-1`, `T-DEST-2`, `T-DEST-3`).
- **Causa raíz**: esos tres hacen `expect(dest).toEqual({ registry, slug })`, que es
  una comparación **EXACTA**. Un campo nuevo en el retorno la rompe **en runtime**,
  no en compilación, así que `tsc --noEmit` verde no dice nada sobre ellos. §3.6
  enumeró los sitios que rompen `tsc` (3) y el factory de `vi.mock` que rompe el
  runtime (1), pero no la clase "aserción de forma exacta sobre el valor de retorno".
- **Fix**: los tres `toEqual` ahora incluyen `invokeUrl`, con el comentario de por
  qué: así el campo del que DEPENDE el guard queda con testigo — si alguien deja de
  devolverlo, esos tres se ponen rojos antes de que el guard quede ciego en silencio.
  O sea que el fixture quedó MÁS fuerte, no sólo reparado.
- **Aplicar en**: al ensanchar el retorno de cualquier función, `tsc` cubre los
  mocks TIPADOS y no cubre (a) los factories de `vi.mock`, (b) los `toEqual` /
  `toStrictEqual` / `toMatchObject` exactos, (c) los snapshots. La sonda que los
  encuentra a los tres es `/usr/bin/grep -rn "<nombre>" src/ --include=*.test.ts`,
  y **hay que correrla además de `tsc`**.

---

### [2026-08-17 15:47] Wave 1 — Quise loguear a `error` en un tipo que no tiene `error`

- **Error**: `tsc` falló con
  `src/services/compose.ts(1570,32): error TS2339: Property 'error' does not exist on type 'DownstreamLogger'`.
  Había escrito `logger?.error?.bind(logger) ?? log.error.bind(log)`, copiando el
  idiom de `warn` que ese archivo ya usa.
- **Causa raíz**: `DownstreamLogger` (`src/types/index.ts`) declara **sólo `warn` e
  `info`**. Copié la forma del idiom sin verificar la SUPERFICIE del tipo. La
  tentación inmediata era la peor salida: degradar el log a `warn` para que entrara
  en el shape — que habría violado CD-17, donde el NIVEL es parte del contrato
  (que esa rama dispare significa que un guard pre-débito no corrió).
- **Fix**: usar el logger **del módulo** (`log.error`), que es un Pino real. No se
  ensanchó `DownstreamLogger`: es un tipo compartido y agregarle `error` obligaría a
  crecer a todos sus implementadores por una necesidad de un solo call-site. Efecto
  lateral bueno y ahora escrito en el código: **un caller no puede tragarse este
  log**, porque no pasa por el logger que él inyecta.
- **Aplicar en**: cuando el NIVEL de un log es parte de un requisito, verificar que
  el logger disponible en ese scope lo soporte **antes** de elegir el sitio. Si no
  lo soporta, la respuesta es cambiar de logger, nunca de nivel.

---

### [2026-08-17 16:02] Wave 1 — Un mutante que NO COMPILA reporta `exit=1` y `0 rojos`, y las dos lecturas son falsas

- **Error**: la primera corrida de `MUT-03` (mover el guard del Sitio 2 debajo del
  débito) dio `tsc exit=2`, **11 suites en rojo por error de import** y el resumen
  `Tests 5333 passed | 19 skipped` — sin línea `Tests N failed`. Mi harness lo
  imprimió como **`(MEDIDO: exit=1, 0 rojos)`**.
- **Causa raíz doble**:
  1. **El mutante**: extraje el bloque del guard con **2 de sus 3 llaves de
     cierre**. La estructura es `if (selfHosts.length > 0) { for (…) { if (dest && …)
     { … return } } }`, o sea TRES cierres después del `return`, y yo corté en el
     segundo. Al borrarlo quedó una llave huérfana.
  2. **El instrumento**: `exit=1` con `0 rojos` es **indistinguible de un KILL si
     mirás sólo el exit code, e indistinguible de un SOBREVIVIENTE si mirás sólo los
     rojos**. Las dos lecturas son falsas: el mutante no midió NADA porque el código
     nunca corrió.
- **Fix**: (a) re-extraer con las tres llaves, verificado imprimiendo **la línea
  que sigue al bloque**; (b) **el harness ahora ABORTA con exit 5 y el cartel
  `⛔ MUTANTE INVALIDO: no compila. NINGUN veredicto vale.`** si `tsc` no da 0, así
  que este modo de falla no puede volver a pasar por un veredicto. Re-corrido:
  `MUT-03` MATA (exit=1, 2 rojos, en `879faa7`).
- **Aplicar en**: los 4 mutantes de MOVIMIENTO que quedan (`MUT-12`, `MUT-15`, y
  cualquier reubicación). **Todo mutante lleva un `tsc` como precondición del
  veredicto, no como comentario.** Y para extraer un bloque: contar los cierres
  mirando la ANIDACIÓN, no la indentación, e imprimir el borde para verificarlo.

---

### [2026-08-17 15:40] Wave 1 — DESVIACIÓN del Story File: el canal de corte del Sitio 2

- **Qué dice el contrato**: §4.2 prescribe que `executeApprovedPlan` corte "por el
  canal que ese método ya usa para los cortes pre-débito — el mismo patrón del
  `__quoteStale`", o sea un miembro nuevo en la unión de retorno.
- **Qué hice**: devolver un `OrchestrateResult` normal con
  `pipeline.errorCode = CONTRACTING_LOOP_DETECTED`, y que las dos rutas de ejecución
  lo mapeen a **400** más un `error_code` top-level de familia 1.
- **Por qué, MEDIDO**: un miembro nuevo en la unión de `executeApprovedPlan` fuerza
  narrowing en **3 call-sites de producción** (`services/orchestrate.ts:447`,
  `services/agent-link.ts:362`, `routes/orchestrate.ts:749`); y como el corte SÍ es
  alcanzable por el camino atómico (a diferencia del cap gate, que no lo es),
  `orchestrate()` también tendría que ensanchar su retorno, sumando **3 call-sites
  más** (`services/inbound-task.ts:512`, `routes/orchestrate.ts:170`,
  `mcp/tools/orchestrate.ts:24`). Total **6 call-sites en 5 archivos, y 3 de esos
  archivos NO están en el Scope IN de §14**. El canal elegido toca **1 archivo, que
  sí está en el Scope IN**, y reusa el mecanismo que el repo YA tiene para "el
  pipeline no corrió y acá está el motivo" (el mapeo
  `pipeline.errorCode === 'SCOPE_DENIED' → 403` que las dos rutas ya hacían).
- **Qué NO cambia**: el ORDEN. El `return` está en el mismo punto de inserción
  (después del cap gate, antes del price-fallback y antes de los dos consumidores de
  plata), y `T-L1-3` mide CERO llamadas a `debit`. `MUT-03` lo confirma.
- **Estado**: §16.15 del propio Story File deja esta forma abierta ("si AR prefiere
  otra forma, es un cambio chico — pero entonces hay que decidir qué status devuelve
  `/orchestrate/execute`"). **Decidido: 400.** Queda para que AR lo ratifique o lo
  rechace; no lo estoy presentando como lo que el contrato pedía.

---

### [2026-08-17 16:09] Wave 2 — Escribí "un header repetido llega como `string[]`" y la medición lo desmintió

- **Error**: `T-CHAIN-4` afirmaba que un header repetido llega como `string[]` y que
  por lo tanto es AUSENCIA (patrón `pick`). El test dio
  `expected [ 'a.example', 'b.example' ] to deeply equal []`.
- **Causa raíz**: copié la semántica del patrón `pick` de `a2a-key.ts` sin verificar
  **cuándo** produce `string[]` de verdad. Medido con un socket crudo contra un
  `http.createServer`:

      x-a2a-contracting-chain: a.example
      x-a2a-contracting-chain: b.example
      ⇒ req.headers['x-a2a-contracting-chain'] === 'a.example, b.example'   (STRING)

  **Node JOINEA los duplicados con `', '`** para casi todos los headers; el `string[]`
  es de `set-cookie` y un puñado más. O sea que en ESTE header la rama `string[]` es
  **defensiva y no el caso real**.
- **Fix**: reescribí el `it` con lo medido (`T-CHAIN-4`) y agregué `T-CHAIN-5`, que
  monta el vector de ataque (repetir el header para esconder nuestro eslabón) y
  verifica que igual cae por MEMBRESÍA. **Y el hallazgo cambió el estado de una
  decisión**: el `trim()` por elemento del paso 3, que yo había puesto por interop,
  resultó ser lo que hace que un header repetido LEGÍTIMO se lea bien — la forma
  joineada trae un espacio después de la coma. Pasó de ser una comodidad a tener un
  input que lo justifica.
- **Aplicar en**: antes de escribir "el header llega como X", **mandar el header y
  mirar**. El costo fue un `node -e` con un socket crudo. La regla general: una
  afirmación sobre el comportamiento de la PLATAFORMA (no del código propio) se mide
  con la plataforma, no se hereda de un patrón vecino que puede estar cubriendo otro
  caso.

---

### [2026-08-17 16:12] Wave 2 — Mi primer `T-PROP-3` NO mataba a `MUT-15`

- **Error**: escribí `T-PROP-3` (CD-4) assertando que después de agregar la traza
  seguían saliendo el `Content-Type` y el `x-a2a-key`. Eso pasa **exactamente igual**
  con los headers nuevos puestos DEBAJO del spread de credenciales, o sea que el test
  no medía el ORDEN, que es lo único que CD-4 pide.
- **Causa raíz**: confundí "los headers de siempre siguen presentes" (aditividad) con
  "los headers nuevos no pisan una credencial" (orden). Son propiedades distintas y
  sólo la segunda distingue el código correcto del mutante.
- **Fix**: reescribí el test alrededor de una **COLISIÓN DE NOMBRES real**. Un
  registry puede declarar `auth: {type:'header', key, value}` con la clave que quiera,
  incluida `x-a2a-contracting-chain`. Con el orden correcto gana la CREDENCIAL y llega
  intacta; con el orden invertido gana la traza y **la credencial se destruye en
  silencio**. Más `T-PROP-3b` (sin colisión salen las dos cosas), para que el primero
  no pueda pasar por "la traza no se emite nunca".
- **Verificación**: `MUT-15` MATA con **1 solo rojo, y es este `it`**
  (MEDIDO: exit=1, 1 rojos, en `6f252ad`). Anotado EN EL TESTIGO, con el aviso de que
  refixturearle la colisión lo apaga igual que borrarlo (CD-22).
- **Aplicar en**: todo test de ORDEN entre dos escrituras al mismo diccionario. La
  pregunta que lo separa del test de presencia: **¿qué input hace que las dos órdenes
  den resultados DISTINTOS?** Si no existe, el test no mide orden.

---

### [2026-08-17 16:23] Wave 3 — Mi control "mecánico" se comparaba consigo mismo

- **Error**: `T-CARD-3` (el control de que cada `endpoint` publicado por la carta
  EXISTE) comparaba los paths declarados contra una lista
  `const REGISTERED_PREFIXES = ['/discover','/compose','/orchestrate']` **escrita a
  mano en el propio test**.
- **Causa raíz**: eso es una TERCERA expresión del mismo dato (la carta, `index.ts`, y
  ahora el test). El escenario que el test existe para cazar —alguien renombra el
  prefijo en `index.ts`— **no lo habría cazado**, porque la lista del test estaba tan
  desactualizada como la carta. Un guard que recalcula lo que vigila aplaude cualquier
  cosa.
- **Fix**: el test **DERIVA** los prefijos leyendo `src/index.ts` con un regex sobre
  los `register(xRoutes, { prefix: '...' })`, y además asserta que la derivación
  encontró algo (`> 3`), para que un regex que deja de matchear no lo deje verde por
  vacío. **Verificado con una mutación puntual**: renombrar el prefijo `/compose` lo
  pone en rojo con el mensaje accionable, y la derivación encuentra los 18 prefijos
  reales. Restaurado con md5 idéntico.
- **Aplicar en**: cualquier test que verifique "A coincide con B". Si el test tiene su
  propia copia de B, no verifica nada — hay que **leer B de su fuente**. Y si la
  lectura puede devolver vacío, hay que assertar que no lo hizo.

---

### [2026-08-17 16:41] Wave 4 — Un mutante que MATA por el motivo equivocado (178 rojos en vez de 2)

- **Error**: la primera versión de `MUT-12` (leer el sobre del fee DESPUÉS del colapso
  `data.result ?? data`) dio **178 rojos en 14 archivos**. El veredicto "MATA" era
  correcto por casualidad; el número era basura.
- **Causa raíz**: escribí el mutante como
  `readCoordinatorFee((output ?? {}) as Record<string, unknown>)`, y `output` suele ser
  un **primitivo** (`'ok'`). Adentro, `'protocolFeeStatus' in raw` sobre un primitivo
  **TIRA TypeError**, así que el mutante no estaba midiendo "el sobre se lee tarde":
  estaba tirando abajo medio pipeline. Un mutante que rompe por una excepción es
  indistinguible de uno que rompe por la semántica **si sólo mirás el conteo**.
- **Fix**: reescribí el mutante para que lo ÚNICO que cambie sea **dónde** se lee
  (guardando el caso primitivo). Re-corrido: **exit=1, 2 rojos, en `1015f90`**, y los
  dos testigos son `T-FEE-4` y `T-FEE-5`, que son los semánticos. Ahora el número dice
  algo.
- **Aplicar en**: un mutante tiene que ser **mínimo y del mismo tipo** que el código
  que reemplaza. Si su conteo de rojos es desproporcionado respecto de lo que toca, la
  primera hipótesis es que el mutante rompió otra cosa — no que el guard esté
  espectacularmente bien cubierto. Regla operativa: **leer los NOMBRES de los testigos
  y verificar que son los que el mutante debía matar**; si aparecen suites que no
  tienen nada que ver, el mutante está mal escrito.

---

### [2026-08-17 16:37] Wave 4 — Dos veces el mismo error de scope al APPENDEAR un `describe`

- **Error**: agregué bloques `describe` al final de
  `routes/compose.contracting-loop.test.ts` y de `routes/compose.fee.test.ts` que
  usaban `app`, y las dos veces dio `ReferenceError: app is not defined`.
- **Causa raíz**: `app` se declara con `let app` **dentro** del `describe` existente,
  así que un `describe` hermano no lo ve. Appendear al final de un archivo es lo más
  cómodo y por eso lo hice dos veces seguidas sin mirar el scope.
- **Fix**: en el primer caso subí `app` y sus hooks al scope del MÓDULO (los dos
  `describe` miden la misma cadena real de preHandlers, así que compartirlos es lo
  correcto); en el segundo moví el `it` DENTRO del `describe` existente. Y de paso el
  segundo tenía un `totalLatencyMs: 10` inventado donde el fixture real dice `5`.
- **Aplicar en**: antes de appendear un `describe` a un archivo de test, mirar **de
  quién es el `app`/`server`/fixture** que se va a usar. Y no inventar valores
  esperados de un fixture ajeno: leerlos.

---
