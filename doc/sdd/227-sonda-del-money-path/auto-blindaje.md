# Auto-Blindaje — WKH-364 · Sonda periódica del camino del dinero

Errores cometidos DURANTE la implementación, con su causa raíz y su fix. No es un
resumen de la HU: es lo que protege a las próximas del mismo tropiezo.

---

### [2026-08-25 13:50] Wave 1 — El guardián del YAML se denunció a sí mismo por su propia prosa

- **Error**: T-8 afirma que el workflow no crea el issue con `--label` (porque
  `gh issue create --label` falla si la etiqueta no existe en el repo, y eso convertiría
  el aviso en un segundo fallo silencioso). La aserción corría sobre el texto ENTERO del
  YAML, y el YAML **explica en un comentario** por qué no usa `--label`. El regex matcheó
  el comentario y el test salió rojo sobre un archivo correcto.
- **Causa raíz**: el escaneo miraba PROSA además de CÓDIGO. Es exactamente el falso
  positivo que `test/scripts-imported-by-tests-are-tracked.test.ts:141-148` ya documenta
  para su propio caso ("este mismo archivo documenta el formato que busca"). Estaba
  escrito en el repo y no lo apliqué al escribir un guardián nuevo.
- **Fix**: un helper `sinComentarios()` que borra las líneas ÍNTEGRAMENTE comentario del
  YAML antes de la aserción. Se filtran sólo las líneas que arrancan con `#`, nunca a
  mitad de línea: cortar en el primer `#` partiría un `${{ ... }}` o una URL y podría
  hacer DESAPARECER un cableado real. Ante la duda, se escanea de más.
- **Aplicar en**: TODA aserción nueva que busque un literal prohibido dentro de un
  archivo que también lo explica. El modo de falla no es un falso verde sino un falso
  rojo, que es peor a mediano plazo: un guardián que se cae solo se termina desactivando.

---

### [2026-08-25 13:5x] Wave 1 — Decisión menor que el Story File no fija: los techos de espera

No es un error, es una decisión tomada y **documentada** en vez de ocultada. El Story
File §8 fija la regla de REINTENTO pero no el timeout del `fetch`. Elegido:

| Llamada | Techo | Por qué |
|---|---|---|
| `GET /discover` | 15 s | es una lectura de catálogo; además se reintenta ante timeout (idempotente y gratis) |
| `POST /compose` | 120 s | invoca a un agente remoto y liquida; un techo corto convertiría una corrida lenta en una "caída", que es el falso rojo que esta HU existe para NO producir. ⛔ Nunca se reintenta ante timeout: pudo haberse ejecutado del otro lado |
| espera del reintento | 2 s | fijado por §8 |

Viven como constantes con nombre arriba del archivo, no como literales en el sitio de uso.

---

### [2026-08-25 19:55] Wave 2 — `.gitignore:46 *.log` se comía la evidencia de AC-4 en silencio

- **Error**: los logs de §12 (`doc/sdd/227-sonda-del-money-path/evidence/*.log`) están en
  el Scope IN del Story File, se escribieron en disco, y `git status --short` **no los
  mostró**: ni como `A`, ni como `??`. Un `git add -A` los dejaba afuera sin decir nada.
- **Causa raíz**: `.gitignore:46` es `*.log`, una regla global del repo pensada para logs
  de herramientas. La evidencia de AC-4 es un `.log` por convención de nombre, así que
  cae en la misma red. El Story File nombra el path pero **no podía saber** que la
  extensión estaba vetada. Medido: `git check-ignore -v <archivo>` → `.gitignore:46:*.log`.
- **Fix**: `git add -f doc/sdd/227-sonda-del-money-path/evidence/*.log`. ⛔ NO se tocó
  `.gitignore`: no está en el Scope IN, y una regla de negación global es un cambio de
  política del repo que no le corresponde decidir a esta HU. Una vez trackeado, el archivo
  sigue trackeado sin `-f`.
- **Aplicar en**: **toda evidencia archivada con extensión `.log` en este repo**, de
  cualquier HU. El modo de falla es el peor de los tres: no hay rojo, no hay `??`, y el
  Done Definition ("D-1 ejecutado y su log archivado") se marca en verde sobre un archivo
  que **desaparece con el worktree**. Hermano del patrón recurrente #1 (untracked ⇒
  invisible a los guardianes ⇒ gate verde falso), pero peor: acá `git status` tampoco avisa.
  ⚠️ Verificación que sí lo caza: `git ls-files <dir>` — no `git status`.

---

# Fix-pack post-AR/CR — 2026-08-25

Los dos revisores RECHAZARON. Lo que sigue son los errores propios que salieron de ahí,
con la medición de cada arreglo. **Todo mutante citado se aplicó, se corrió y se revirtió
por `cp` con `assert md5` — nunca con `git checkout --`, que borra lo que se está midiendo.**

### [2026-08-25 20:05] Fix-pack — El DEFAULT de una escalera de monitoreo era PASS

- **Error**: la escalera enumeraba las condiciones de fallo y terminaba en
  `return verdict('PASS', 0, …)`. `/discover` con 429, 403, 401, 400, 451, 302 o 204 no
  matcheaba ninguna fila, y `main` cortaba antes del `POST` ⇒ **exit 0 con UNA sola llamada
  HTTP**, imprimiendo *"el camino del dinero cotiza"* sin haber cotizado nada. Peor: un
  exit 0 en la corrida por reloj dispara `gh issue close`, así que la sonda **cerraba sola
  el issue de una caída abierta**.
- **Causa raíz**: enumerar los fallos y dejar el verde de default. Escribí la escalera
  siguiendo la tabla de §5 fila por fila, y §5 no numera esa fila — pero *"la spec no lo
  dice"* no es una defensa cuando lo que queda en el hueco es la única clase que jamás
  debe alcanzarse por omisión.
- **Fix**: dos capas. (a) fila 2-bis explícita: `/discover` que no sea 200 ⇒ DOWN
  atribuido; (b) la fila 11 **exige** `2xx de /compose` + `assertQuoteShape().ok === true`,
  y el default pasa a ser DOWN(2). PASS quedó **inalcanzable por omisión**.
- **Medido**: el mutante que devuelve PASS incondicional ⇒ 2 rojos. El que borra la fila
  2-bis ⇒ **SOBREVIVIÓ la primera medición**: la capa (b) lo tapaba, porque el exit era el
  mismo. Sólo murió al exigir en el test que el mensaje **atribuya** (`toContain('/discover')`).
  ⚠️ **Defensa en profundidad vuelve equivalentes a los mutantes de la capa de arriba**: si
  el test mira sólo el exit code, la redundancia se pudre en silencio. Hay que fijar la
  ATRIBUCIÓN, que es lo que la capa de arriba aporta y la de abajo no.
- **Aplicar en**: **toda escalera de clasificación de este repo, y toda función que
  devuelva un veredicto**. La pregunta: *¿cuál es la clase que se alcanza cuando NINGUNA
  condición matchea, y es la que puedo pagar más barato si me equivoco?*

### [2026-08-25 20:10] Fix-pack — Un mismo error tiene DOS productores y DOS grafías

- **Error**: la fila 4 leía `body.error_code` (snake). `/compose` tiene **dos** productores
  de 403: el middleware (`src/middleware/a2a-key.ts:121`, snake) y la **ruta**
  (`src/routes/compose.ts:1113`, que responde el resultado del pipeline con `errorCode`
  camel). Un `SCOPE_DENIED` —cuyas cuatro causas son propiedades de la KEY del caller—
  caía a DOWN con el mensaje *"no hay campo estructurado que atribuya la causa"*, **que es
  falso: el campo existía, con otro nombre**. Y es el caso que produce una key con scope
  propio, o sea la que el Story File §16 le pide crear al founder.
- **Causa raíz**: leí el union del middleware, vi el comentario *"SCOPE_DENIED removed from
  this union"* y lo tomé como *"`/compose` no emite SCOPE_DENIED"*. Se removió de **ese**
  emisor; el otro lo emite igual. Conflacioné dos productores del mismo código.
- **Agravante propio**: escribí un test (`:154-159`) que **candaba la misclasificación** y
  la justificaba en un comentario. Un test puede fijar un error con la misma fuerza con la
  que fija un acierto. Se reescribió con su razón corregida, conservando el punto válido
  que hacía (no cualquier 403 es config).
- **Fix**: la fila 4 lee las dos grafías y `SCOPE_DENIED` entra por un Set propio con su
  cita. **Medido**: el mutante que vuelve a una sola grafía ⇒ 1 rojo.
- **Aplicar en**: **todo consumidor de un error de otro servicio**. Antes de cablear un
  código, buscar TODOS los `.send(`/`return` que producen ese status en esa ruta, no sólo
  el primero. Dos capas del mismo servicio pueden usar convenciones de nombre distintas.

### [2026-08-25 20:15] Fix-pack — El self-test podía FABRICAR el hallazgo que dice medir

- **Error**: `delete input[campo]` es un **no-op silencioso** si el campo no está. Con un
  typo, o con un campo que la derivación ya omite, el cuerpo salía entero y conforme, el
  gateway lo aceptaba **con razón**, y la sonda lo reportaba como
  `exit 5: el gateway aceptó un cuerpo que viola el schema publicado` — pagando 0,0303 USDC
  por una acusación inventada.
- **Causa raíz**: había reconocido la clase ("el self-test no puede afirmar lo que no
  midió") y cubierto **un** miembro (nunca se envió nada), no el otro (se envió, pero
  entero). Cerrar el caso obvio de una clase se siente como cerrar la clase.
- **Fix**: `obs.selfTestFieldPresent = campo in input`; si no está, se corta **antes** del
  pipeline y sale CONFIG(3). **Medido**: dos mutantes (uno en `classify`, otro en `main`)
  ⇒ 2 rojos y 1 rojo.
- **Aplicar en**: **todo `delete`, `replace` o `filter` cuyo efecto sea la premisa de una
  conclusión**. Si la operación puede ser no-op, la conclusión hay que condicionarla a que
  la operación haya hecho algo.

### [2026-08-25 20:18] Fix-pack — La prosa del YAML describía un mecanismo inexistente

- **Error**: el comentario del workflow afirmaba que el issue *"pega la línea de clase que
  emitió la sonda"*, y el cuerpo era 100 % estático: el step no tenía `id:` ni capturaba
  stdout. §9 declara que **ése** es el mecanismo que cierra el riesgo *"avisa de más y
  alguien la apaga"*. Sin él, cada alerta obliga a abrir Actions para saber si producción
  está implicada — el costo que la HU existe para eliminar.
- **Fix**: `id: sonda` + `tee` al log + la línea de clase a `$GITHUB_OUTPUT` con el exit
  preservado a mano (`${PIPESTATUS[0]}`, `set +e`), y el issue la pega desde `env:`, nunca
  interpolada dentro del `run:`. Se pega **la línea**, no el log (eso sería salida cruda,
  CD-8). **Verificado ejecutando** los tres bloques `run:` con `npm` y `gh` doblados: exit
  3 preservado, `clase` capturada, y el caso "la sonda nunca corrió" produce el texto que
  lo dice. **Medido**: el mutante que borra la captura ⇒ 1 rojo.
- **Aplicar en**: **toda frase de un comentario que describa lo que el archivo HACE**. Si
  es falsable, tiene que tener un test que la falsee; si no, apaga la revisión de quien la
  lee — es peor que no decir nada.

### [2026-08-25 20:20] Fix-pack — `pull_request` NO es "sin secrets": eso vale sólo para forks

- **Error**: dos frases falsas (el comentario del YAML y el mensaje `SKIP:` del script)
  decían que un `pull_request` no recibe el secret. GitHub se lo niega a los PRs **desde un
  fork**; a un PR de una rama del propio repo se lo entrega entero — **empezando por la
  rama de esta HU**. O sea que la sonda hace el POST real y **gasta en cada push**, con
  `continue-on-error` haciendo que nadie lo note.
- **Impacto medido en el presupuesto**: §16 dimensiona `DAILY_LIMIT > 1,46` desde
  48 × 0,0303 = 1,4544 ⇒ margen **0,0056 USD = cero corridas de PR**. Un push agota el día
  y la sonda se apaga sola.
- **Fix**: `paths:` en el trigger, acotado a los 3 archivos de la sonda; las dos frases
  corregidas; y el número nuevo escrito en el YAML. **Medido**: el mutante que borra
  `paths:` ⇒ 1 rojo.
- ⚠️ **PEDIDO AL FOUNDER, por escrito**: el piso de `DAILY_LIMIT` de §16 **sube de 1,46 a
  2,00 USD/día**. Con 2,00 quedan ~18 corridas de PR/día de margen sobre las 48 del reloj.
- ⚠️ **Y el presupuesto mensual SÍ cambia** (AR-it2/MNR-4). Acá decía *«≥ 44 USDC / 30 días
  no cambia: lo que cambia es el techo diario»*, y eso se contradecía con el renglón de
  arriba en el mismo párrafo. Los dos números, derivados:
  - **44 USDC cubre SÓLO el reloj**: 48 corridas/día × 0,0303 × 30 = **43,63**.
  - **El techo real es 60 USDC/mes**: si el `DAILY_LIMIT` de 2,00 se consumiera entero
    todos los días, 30 × 2,00 = **60,00**. Las 18 corridas de PR/día que el techo nuevo
    habilita cuestan 18 × 0,0303 = 0,55/día = **16,4 USDC/mes** por encima del reloj.
  - Fondear con 44 y usar las corridas de PR ⇒ la key se queda sin saldo antes de fin de
    mes ⇒ `INSUFFICIENT_BUDGET` ⇒ 403 ⇒ fila 4 ⇒ **CONFIG/exit 3 cada 30 minutos**. La
    sonda lo reporta bien (no dice "producción caída"), pero es ruido rojo permanente.

### [2026-08-25 20:22] Fix-pack — Un mutante que IMPRIME la credencial pasaba la suite

- **Error**: el docblock afirma *"nunca imprime la credencial, ni entera ni truncada: el
  repo es PÚBLICO"* y **ningún test podía refutarlo**. El AR agregó
  `key=${process.env.A2A_PROBE_KEY}` a la línea de clase: **33 passed (33)**.
- **Fix** (T-13): la env se lee en **un** solo lugar (`readCredential`), `cred.key` se usa
  en **un** solo lugar (el header del único POST), y lo que imprime la línea de clase no
  puede nombrar ninguno de los dos. **Medido**: el mutante del AR, reaplicado ⇒ **1 rojo**.
- ⚠️ **HASTA DÓNDE LLEGA ESTO, corregido por AR-it2/MNR-2.** Acá se leía que *"la credencial
  no puede llegar a stdout"*, y eso **afirma más de lo probado**. Lo probado es que no puede
  llegar **DIRECTAMENTE**: T-13 es un testigo **estructural** que cuenta apariciones de los
  dos literales `A2A_PROBE_KEY` y `cred.key` en el texto del script. Una fuga **lavada por
  un alias** —`globalThis.__k = key` en `readCredential` y `${globalThis.__k}` en `emit`—
  no nombra ninguno de los dos y **pasa en verde**: el AR lo midió, `47 passed (47)`.
  La afirmación correcta es: *"la credencial no puede llegar a stdout por ninguna de las dos
  vías nombradas"*. Cerrar la clase entera pide un test de **comportamiento** (correr `main()`
  con una key sentinel y afirmar que no aparece en stdout+stderr), que es la HU aparte de
  MNR-2 — ver la tabla de MENORes declarados.
- **Aplicar en**: **todo `⛔ nunca …` de un docblock**. La regla del repo ya lo dice
  (CD-9); el modo de falla es que la frase se escribe con la conducta correcta y **el
  candado no existe**, así que la próxima edición que agregue "un dato más para debuggear"
  no encuentra nada que la frene.

### [2026-08-25 20:24] Fix-pack — Tres guardianes escaneaban PROSA junto con código

- **Error**: T-9, T-10 y T-11 corrían sobre el texto entero de sus archivos. Es **el mismo
  falso rojo que la primera entrada de este documento ya había resuelto para T-8**, y cuyo
  *"Aplicar en"* dice textual: *"TODA aserción nueva que busque un literal prohibido dentro
  de un archivo que también lo explica"*. Escribí la lección y no la apliqué a los tres
  guardianes que escribí a continuación.
- **Consecuencia concreta que lo prueba**: el script **no podía documentar su decisión
  central** —por qué se omite el campo de país— sin poner T-11 en rojo, y por eso el
  docblock de `deriveInput` no la explicaba.
- **Fix**: `sinComentariosJs()` (hermano de `sinComentarios()`), los tres guardianes sobre
  `SCRIPT_CODE`, **y recién entonces** la explicación escrita en el docblock.
- **Aplicar en**: lo mismo que decía antes. La lección no falló por estar mal escrita:
  falló porque **no la releí al escribir el guardián siguiente, en la misma sesión**.

### [2026-08-25 21:00] Fix-pack 2 — Apliqué mi propia lección a UNA fila de trece

- **Error**: en el fix-pack anterior descubrí que *"la defensa en profundidad vuelve
  equivalentes a los mutantes de la capa de arriba: si el test mira sólo el exit code, la
  redundancia se pudre en silencio; hay que fijar la ATRIBUCIÓN"*. Lo escribí, y lo apliqué
  **a la única fila donde lo descubrí** (2-bis, más la 0 que ya venía de T-7). El AR-it2
  barrió las demás con 9 mutantes que **conservan `klass` y `exit` y sólo degradan el
  mensaje**: **7 de 9 sobrevivían**. El más caro, E9:
  ```
  - 'DOWN: candidata a caída real — no hay campo estructurado que atribuya la causa'
  + 'DOWN: producción está caída'
  ```
  ⇒ **`47 passed (47)`**. El número correcto por la razón equivocada — y en una sonda **la
  razón ES el producto**: el mensaje es lo que se pega en el issue de GitHub (§9 del Story
  File). Es el defecto de origen de esta HU, un nivel más arriba.
- **Causa raíz**: la tabla T-5 asertaba `klass`, `exit` y `message.startsWith(klass + ':')`.
  Las tres las satisface cualquier mensaje degradado que conserve el prefijo de clase. Y el
  patrón de la lección es idéntico al de la entrada de las 20:24: **escribí el "Aplicar en"
  y no lo apliqué al resto de la misma tabla, en la misma sesión.** Dos veces seguidas.
- **Fix**: una cuarta columna en la tabla T-5 que ya existía — el **fragmento de atribución**
  de cada fila, tomado del prefijo que `story-file.md:205-217` (§5) fija fila por fila, más
  el dato interpolado que atribuye la causa (el status, el código, el campo, el slug), con
  `expect(v.message).toContain(atribucion)`. 20 filas, 20 fragmentos.
- **Y un candado sobre el candado**: una columna de `toContain` se degrada a nada con sólo
  vaciar el fragmento (`toContain('')` es cierto para cualquier string, y `toContain('DOWN')`
  ya lo garantiza el `startsWith`). Por eso el testigo nuevo también exige que cada fragmento
  tenga ≥ 20 caracteres, **no** contenga el nombre de la clase, y **no aparezca en el mensaje
  de ninguna otra fila** — si apareciera, no atribuiría nada.
- **Medido, mutante por mutante** (arnés: copia previa a directorio propio, restauración por
  `cp`, `md5` verificado después de cada uno; ⛔ nunca `git checkout --`; md5 final idéntico
  al inicial). Baseline nuevo: **48 passed (48)**.

  | Mutante | Fila | Antes | Ahora | Suite bajo el mutante |
  |---|---|---|---|---|
  | E8 | 0 | KILLED | **KILLED** | `2 failed \| 46 passed (48)` |
  | E2 | 1 | 🔴 SURVIVED | **KILLED** | `2 failed \| 46 passed (48)` |
  | E7 | 2 | 🔴 SURVIVED | **KILLED** | `2 failed \| 46 passed (48)` |
  | E1 | 2-bis | KILLED | **KILLED** | `3 failed \| 45 passed (48)` |
  | E3 | 3 | 🔴 SURVIVED | **KILLED** | `1 failed \| 47 passed (48)` |
  | E4 | 4 | 🔴 SURVIVED | **KILLED** | `1 failed \| 47 passed (48)` |
  | E9 | 9 | 🔴 SURVIVED | **KILLED** | `2 failed \| 46 passed (48)` |
  | E6 | 10 | 🔴 SURVIVED | **KILLED** | `1 failed \| 47 passed (48)` |
  | E5 | 12 | 🔴 SURVIVED | **KILLED** | `1 failed \| 47 passed (48)` |

  **9 de 9 mueren, incluidos los 7 que sobrevivían.** Y dos meta-mutantes sobre el testigo
  nuevo, para que no sea decorativo: vaciar el fragmento de la fila 9 a `''` ⇒ **1 rojo** (lo
  caza el candado de vacuidad); borrar el `toContain` del bucle y reaplicar E9 ⇒
  **`48 passed (48)`**, o sea que **esa línea es exactamente la que mata**, y no otra cosa
  que ya estuviera ahí.
- **Aplicar en**: **toda tabla parametrizada de un clasificador.** El exit code y la clase son
  la mitad barata de verificar; la que se pudre sin ruido es el motivo. Y la lección de
  proceso, que es la que falló dos veces: **cuando escribas un "Aplicar en", el primer lugar
  donde aplicarlo son las otras filas del archivo que estás tocando, antes de cerrar la
  sesión.**

---

## ⛔ Precondición de MERGE — no se resuelve con código (AR/BLQ-MED-3)

`gh secret list --repo ferrosasfp/wasiai-a2a` → **vacío** — medición del **AR**, 2026-08-25.

⚠️ **El Dev NO pudo re-medirlo al cerrar el fix-pack**: `api.github.com` estaba inalcanzable
desde este entorno (`gh` falla y `curl` da `000`; la sonda contra Railway sí anduvo en la
misma sesión, así que no es "sin red"). O sea que este renglón dice **"la última medición
conocida dice que no está"**, no "verifiqué que no está" — son cosas distintas y la segunda
no ocurrió. Quien mergee: **re-corré el comando**, no te apoyes en esta línea.

Si esta rama se mergea **sin** el secret, el `cron` produce **48 corridas rojas por día**
(fila 0 ⇒ CONFIG ⇒ exit 3 ⇒ job rojo ⇒ el step de aviso corre). El dedup evita el issue
duplicado pero **no el comentario**: **1 issue + 47 comentarios por día ≈ 1.410
notificaciones por mes**, todas sobre lo mismo. Un control que notifica 47 veces al día lo
primero que gana es que lo silencien — el riesgo #2 del propio SDD, materializado el día 1.

**Decidido por el founder: la key se crea ANTES del merge.** Por eso el `cron` **no** se
tocó, no se apagó y no se acotó. Queda escrito acá para que el merge no ocurra sin eso:

- [ ] `A2A_PROBE_KEY` existe como **repo secret** (no environment secret)
- [ ] presupuesto **≥ 60 USDC / 30 días** — 44 cubre sólo el reloj (48 × 0,0303 × 30 =
      43,63); el techo diario de 2,00 habilita 18 corridas de PR/día, y 30 × 2,00 = 60
- [ ] `DAILY_LIMIT` ≥ **2,00 USD/día** (⚠️ el 1,46 de §16 quedó corto: ver la entrada del
      `pull_request` de arriba)
- [ ] ⚠️ si la key se crea con `allowed_agent_slugs` o con tope por llamada, el 403
      `SCOPE_DENIED` que produzca ahora sale **CONFIG/exit 3** y no "producción caída"

---

## Hallazgos MENORes declarados y NO tocados, con su razón

Los cinco son de los revisores, quedan abiertos a propósito y con dueño:

| ID | Qué | Por qué no entra |
|---|---|---|
| **CR/MNR-4** | `.replace('( ', '(')` en la fila 10 parchea un artefacto de formato del mensaje en vez de construirlo con las partes presentes | Es cosmético y no cambia ninguna clasificación ni ningún exit code. Tocarlo obliga a reescribir el armado del mensaje de la fila 10, que **sí** está cubierto por T-5, para ganar legibilidad y nada más. Deuda de estilo, declarada |
| **AR/MNR-3** | `schemaSha256` cubre sólo el `inputSchema`: en un DRIFT del `outputSchema` la huella **no cambia**, y §6 promete que existe para contestar *"¿cambió el schema hoy?"* | Es un cambio de CONTRATO del log (§5 fija el formato de la línea final) y la respuesta correcta —dos huellas, o una sobre el card entero— la decide el Architect, no el fix-pack. ⚠️ Mientras tanto la huella contesta "no cambió" en el caso del `outputSchema`, que es una afirmación de más: **el mensaje de ese DRIFT sí dice cuál campo dejó de estar declarado**, así que la atribución no se pierde, sólo la huella no ayuda |
| **AR/MNR-5** | Un `200` con cuerpo ilegible (HTML de un proxy) se clasifica DRIFT *"el catálogo ya no publica el inputSchema"* — una afirmación que no se midió | La dirección es segura (no es PASS ni DOWN) y el arreglo pide distinguir "no es JSON" de "es JSON sin el campo", o sea tocar `request()`, que hoy devuelve `null` a propósito para no filtrar cuerpos crudos (CD-8). Queda declarado: **el mensaje afirma de más en ese caso** |
| **AR-it2/MNR-2** | T-13 es estructural: cuenta los literales `A2A_PROBE_KEY` y `cred.key` en el texto del script. Una fuga **lavada por un alias** (`globalThis.__k = key` en `readCredential`, impreso en `emit`) no nombra ninguno de los dos ⇒ **`47 passed (47)`** | El propio AR lo dice: **ningún test estructural sobre texto puede cazarlo**, porque el alias puede llamarse cualquier cosa. El que lo cierra es un test de **comportamiento** —correr `main()` con `A2A_PROBE_KEY` sentinel y `fetch` doblado, capturar stdout+stderr y afirmar que el sentinel no aparece—, que es una pieza nueva con su propio arnés de dobles, no una columna en una tabla. **Es una HU chica aparte, no un parche acá.** Mientras tanto la afirmación del docblock quedó acotada a lo probado (ver la entrada del 20:22): *"por ninguna de las dos vías nombradas"* |
| **AR-it2/MNR-3** | `obs.selfTestFieldPresent = obs.selfTestField in input` mutado a `Boolean(input[obs.selfTestField])` ⇒ **`47 passed (47)`**: el testigo no distingue presencia de truthiness | **Inocuo hoy**: el único campo requerido del schema publicado es `amountUsd` y deriva a `25`, que es truthy, así que las dos variantes coinciden en todo input alcanzable. Se volvería visible sólo si el catálogo publicara un `minimum: 0` (el derivado sería `0` y el CONFIG diría "el campo no estaba" sobre un campo que sí estaba). **El código de HEAD es el correcto**; falta el testigo, que pide un fixture de schema nuevo. Declarado, con dueño |

---

## Escala del diff después del fix-pack (check 7, por escrito)

Medido con el mismo criterio del CR (línea de código = ni blanco ni línea íntegramente
comentario), y **derivado**, no copiado:

| Archivo | Código antes | Código ahora | Presupuesto §15 |
|---|---|---|---|
| `scripts/probe-money-path.mjs` | 241 | **262** | 260 |
| `test/probe-money-path.test.mjs` | 211 | **365** | 220 |
| `.github/workflows/probe-money-path.yml` | 72 | **100** | 95 |
| `package.json` + 2 README | 3 | 3 | 3 |
| **Total** | 527 | **730** | 578 (techo 1156) |

**1,26x del presupuesto, bajo el techo.** El fix-pack 2 suma **+17 líneas, todas en el
archivo de tests**: la columna de atribución de T-5 (20 fragmentos, uno por fila) y el
candado que impide que esa columna se vacíe. Cero líneas de `src/`, de `scripts/` y del
YAML — el código de HEAD ya era el correcto; lo que faltaba era el testigo.

**1,23x era la medida antes del fix-pack 2, y decía:** El excedente es **+186 líneas y +137 son del
archivo de tests**: 14 casos nuevos, y **cada uno existe porque un mutante lo pidió**. La
pregunta que decide (*¿qué parte de esto seguiría existiendo si lo escribiera alguien que
ya conoce esta librería?*) no aplica acá: nada de lo agregado es ceremonia de vitest ni de
GitHub Actions. Son, uno por uno: los 7 estados de `/discover` que salían verdes, las dos
grafías del 403, el campo de self-test ausente, la credencial que no puede imprimirse
**directamente** (el alias sigue abierto: MNR-2), el
POST que no se reintenta, el `PROBE_AMOUNT_USD` no numérico, la captura de la línea de
clase, el `paths:` del trigger y las dos consultas de `gh` que no pueden fallar en
silencio. Del lado del script (+21) y del YAML (+28) el crecimiento es el cableado de esos
mismos arreglos.

⛔ Lo que **no** se hizo, y §15 lo pide en ese orden: no se recortó ningún caso de T-5 ni
ningún testigo. Si hubiera que recortar, primero salen los docblocks del `.mjs`.
