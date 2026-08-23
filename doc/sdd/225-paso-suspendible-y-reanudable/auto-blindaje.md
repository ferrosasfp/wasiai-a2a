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

---

### [2026-08-23 17:06] Wave 2 — Insertar en `reconciliation.ts` corrió SEIS excepciones del guardián de dueño

- **Error**: agregué `listSuspendedRuns` y sus tipos a
  `src/services/reconciliation.ts` y `npm test` se puso rojo en `G-08` con
  **6 cadenas "sin filtro y sin motivo escrito"** — las mismas seis de siempre,
  que sí tenían motivo: sus entradas en
  `test/ownership-filter-guard.exceptions.ts` apuntaban a los números viejos.
- **Causa raíz**: esa lista está escrita a mano y su `line` es la del `.from(`.
  Yo agregué líneas en CINCO puntos distintos del archivo, así que el
  desplazamiento **no es uniforme**: +59 para los sitios anteriores al método
  nuevo, +134 para los posteriores. Un "sumale N a todo" habría re-apuntado la
  mitad a la línea equivocada, y el guardián habría quedado verde apuntando a
  otra cadena.
- **Fix**: derivé los números nuevos del propio archivo
  (`grep -n "\.from('a2a_"`) y VERIFIQUÉ uno por uno que la función contenedora
  siguiera siendo la que la excepción nombra (`listPending`, `listAmbiguous`,
  `resolveIntent` ×2, `driftCheck`, el lease del hop 2). Además corrí los cuatro
  `:NNN-NNN` que las propias razones citan hacia docblocks de
  `reconciliation.ts`, y abrí las cuatro para confirmar que el texto sigue
  diciendo lo que la razón afirma.
- **Aplicar en**: cualquier HU que inserte en un archivo con excepciones
  escritas a mano. **Derivar, no sumar**, y cruzar por SÍMBOLO contenedor, no
  por aritmética. Y acordarse de que las razones también citan líneas: el
  guardián no las mira, así que envejecen en silencio.

---

### [2026-08-23 17:14] Wave 2 — Registrar una ruta nueva tumbó TRES suites enteras al arrancar

- **Error**: `POST /compose/resume` usa `requireA2AKey` del middleware de auth.
  Tres suites que ya existían moquean ese módulo con una factory **parcial**
  (sin `importOriginal`) que sólo exporta `extractRawKey` y
  `requirePaymentOrA2AKey`. El resultado no fue un test rojo: fue
  `Failed Suites 3` — el plugin no registra, así que se cayeron los **46 tests**
  de esos archivos, y el resumen los contó como `skipped`.
- **Causa raíz**: un doble parcial de un módulo es un contrato implícito con la
  lista EXACTA de símbolos que el consumidor importa hoy. Agregar un símbolo al
  consumidor rompe el doble desde afuera, en tiempo de registro, no de aserción.
  Y el modo de falla es engañoso: `Tests 6000 passed | 46 skipped` se lee como
  verde si uno mira sólo la línea de tests.
- **Fix**: agregar a las tres factories el `requireA2AKey` que faltaba, con el
  MISMO pass-through que ya tenían para `requirePaymentOrA2AKey`. No se aflojó
  ninguna aserción ni se tocó ningún test: se completó el doble.
  ⚠️ Son tres archivos **fuera del Scope IN del Story File**, y va al reporte
  como ampliación declarada, no aplicada en silencio.
- **Aplicar en**: toda HU que le agregue un `import` a un archivo que ya tiene
  dobles parciales. **Antes de importar un símbolo nuevo en un route/service muy
  moqueado**: `grep -rn "vi.mock('.*<modulo>'" src/` y mirar cuáles usan
  `importOriginal` y cuáles no. Y al leer la salida de `npm test`, mirar
  **`Test Files`**, no sólo `Tests`: una suite que no arranca no falla, desaparece.

---

### [2026-08-23 17:20] Cierre — lo que NO se rompió pero conviene que quede escrito

Tres decisiones que se tomaron por MEDICIÓN y no por preferencia, y que un
lector futuro podría "corregir" hacia atrás:

1. **El `exp` del token NO corta el camino a la base.** Un token vencido igual
   llega a `claim_suspended_run`. Cortar antes ahorraría una consulta y
   perdería el ÚNICO momento en que la fila puede pasar a `expired` y dejar
   constancia del pago varado. Testigo: `T-RES-4b`.
2. **`requireA2AKey` y no `requirePaymentOrA2AKey` en el resume.** Medido en
   `src/lib/step0-debit.ts`: sin `composeEstimatedCostUsd` inyectado, el monto
   cae a `PLACEHOLDER_FEE_USD`. La cadena "igual que /compose menos el
   preHandler de precio" le habría cobrado **un dólar a cada reanudación**.
3. **La bandera NO gatea `POST /compose/resume`.** Apagarla tiene que dejar de
   CREAR runs suspendidos, no dejar varados a los que ya gastaron plata del
   caller.

---

# Fix-pack del AR — 2026-08-23

### [2026-08-23 18:05] Fix-pack — Un `RAISE` en PL/pgSQL ROLLBACKEA lo que escribí dos líneas antes

- **Error**: `claim_suspended_run` hacía
  `UPDATE … SET status='expired'` y, dos líneas después,
  `RAISE EXCEPTION 'RUN_EXPIRED'`. Escribí el docblock afirmando que "la
  transición y el raise JUNTOS son lo que hace que se emita EXACTAMENTE UN
  residuo". Es al revés: el `RAISE` sin bloque `EXCEPTION` aborta la transacción
  entera —y PostgREST corre cada `rpc()` en la suya—, así que ese UPDATE se
  descartaba SIEMPRE. `expired` era un estado inalcanzable y cada reintento con
  el mismo token vencido emitía OTRO `compose_stranded_payment`: un caller
  autenticado podía encender `strandedExposureBreached` en `/health` a voluntad.
- **Causa raíz**: dos, y la segunda es la grave.
  1. Asumí la semántica transaccional de PL/pgSQL en vez de ejecutarla. El
     exemplar del que dije copiar (`wkh137_agent_links.sql:91-93`) hace lo
     CONTRARIO y lo dice en un comentario —`-- open + expirado → LINK_EXPIRED
     (no consume)`, sin UPDATE— y yo leí esa línea como una diferencia de
     producto, no como la propiedad que es.
  2. **Escribí los dos testigos DESPUÉS de la implementación y a su imagen.**
     `T-MIG-5` comparaba posiciones de literales en un string (`marcaExpired >
     expiredGuard`): mide el orden del TEXTO, y ninguna mutación de semántica
     puede ponerlo rojo. Y el doble `montarRpc` hacía `fila.status='expired'` y
     DESPUÉS devolvía el error, o sea que modelaba mi intención en vez del
     motor — con lo cual `T-RUN-9` ("dos intentos siguen siendo uno") pasaba en
     verde sobre el bug. Los dos testigos confirmaban la implementación, no la
     propiedad.
- **Fix**: la transición salió del RPC. La aplica `suspendedRunService.expire`
  con un `UPDATE … WHERE token_hash=… AND owner_ref=… AND status='suspended'`
  **condicional**, y el residuo se emite sólo si afectó una fila: "exactamente
  uno" pasó de ser una promesa a ser el número de filas que devuelve el motor.
  Verificado ejecutando contra un Postgres 16 real: 5 sesiones concurrentes
  sobre la misma fila dan `1 0 0 0 0`. `T-MIG-5` se reescribió como invariante
  ESTRUCTURAL ("ninguna rama que levante puede escribir", parseando los bloques
  `IF … END IF;`) y el doble ahora aplica cada RPC sobre un borrador que
  DESCARTA si la función levanta.
- **Aplicar en**: cualquier función `plpgsql` de este repo que mezcle escritura
  y `RAISE`. Y, más general: **antes de escribir el testigo de una propiedad de
  un motor, escribir la MUTACIÓN que tendría que ponerlo rojo y correrla.** Un
  doble que modela lo que quiero que pase no es un testigo, es un espejo. Acá el
  costo de no hacerlo fue que el gate estuvo VERDE con un BLOQUEANTE de
  seguridad adentro durante toda la HU.

---

### [2026-08-23 18:20] Fix-pack — Cambié un middleware por otro y me llevé el DÉBITO sin notarlo

- **Error**: en `POST /compose/resume` puse `requireA2AKey` en lugar de
  `requirePaymentOrA2AKey`, y lo documenté como "un bug de plata evitado"
  (cierto: la cadena ingenua cobraba `PLACEHOLDER_FEE_USD` = $1 por cada
  reanudación). Lo que no vi es el otro lado del par: `executePipeline` saltea
  el débito de su índice 0 (`i > 0`, CD-7) **porque da por sentado que el
  middleware de pago lo cobró**. Sin ese middleware, el primer step del tramo
  restante se ejecutaba, `signAndSettleDownstream` le pagaba al agente desde el
  wallet del operador, `totalCost` lo sumaba y el fee de protocolo se cobraba
  sobre esa base — y `budgetService.debit` no se llamaba nunca. Un step gratis
  por reanudación, repetible.
- **Causa raíz**: evalué el reemplazo por lo que el middleware **autentica**
  (idéntico: master/sesión/delegación, mismo poblado de `a2aKeyRow`) y no por lo
  que **hace además**. Su propio docblock lo dice textual —"SIN
  chain-resolution, SIN débito, SIN spend-limits, SIN x402"— y yo lo leí como la
  lista de lo que me ahorraba, no como la lista de lo que alguien más tenía que
  cubrir. Y mi propio testigo tenía escrita la premisa que estaba rompiendo:
  `compose.suspend.test.ts` afirma `mockDebit` una sola vez para dos steps con
  el comentario *"el step 0 lo debita el middleware"*.
- **Fix**: el route debita explícitamente el primer step restante antes de
  llamar a `compose()`, espejando el step-0 de `/compose` (mismo par
  precio/destino, mismo gas overhead, mismo precio congelado, mismo
  `refundComposeStep0` en las ramas de fallo y de 504). El guard `i > 0` no se
  tocó: sigue byte-idéntico a `5578998:571`. La opción de re-usar el middleware
  de pago con un preHandler de precio es **estructuralmente imposible acá**, y
  eso quedó escrito: para saber cuál es el primer step restante hay que claimear
  el run, y el claim necesita el `owner_ref` del caller, que lo puebla el propio
  middleware de auth.
- **Aplicar en**: **todo cambio de middleware en una cadena de preHandlers de un
  endpoint que mueva plata.** El criterio no es "¿autentica igual?" sino "¿qué
  MÁS hacía el que saco, y quién lo hace ahora?". Concretamente: `grep` del
  docblock del middleware viejo buscando los verbos que enumera, y por cada uno
  preguntarse quién lo cubre después del cambio.

---

### [2026-08-23 18:30] Fix-pack — El testigo estaba en los DOS extremos del cable y no en el medio

- **Error**: `compose.resume.test.ts` moquea `composeService.compose` ENTERO y
  `compose.suspend.test.ts` nunca ejercita una reanudación con `scopingKeyRow` +
  `chainId`. Los dos archivos estaban llenos de aserciones sobre dinero y
  ninguno podía ver que el tramo reanudado no debitaba: el route no ve el
  pipeline y el pipeline no ve al route.
- **Causa raíz**: dividí los tests por CAPA (route / service) siguiendo la
  estructura de los archivos que ya existían, y la propiedad que había que medir
  —conservación: N steps ejecutados ⇒ N débitos— vive exactamente en la juntura.
  Cada archivo era honesto sobre lo que no cubría; ninguno cubría lo que
  importaba.
- **Fix**: el escenario `P0-3` en `src/__tests__/e2e/compose-flow.test.ts`, que
  ya monta el `composeService` REAL detrás de la ruta real. Afirma conservación
  (2 débitos para 2 steps, montos, destinos canónicos y `owner_ref`), no "se
  llamó al spy". Verificado que se pone ROJO con el código anterior.
- **Aplicar en**: cuando una propiedad de dinero cruza dos capas, el testigo va
  en la juntura, no en las dos puntas. Y la pregunta que lo detecta antes:
  **"¿qué mock tendría que sacar para que este test pudiera fallar?"** Si la
  respuesta es "el del módulo que hace la operación que estoy afirmando", el
  test no la está afirmando.

---

### [2026-08-23 18:40] Fix-pack — Los mismos números de `reconciliation.ts` se corrieron OTRA VEZ

- **Error**: el fix-pack volvió a insertar en `src/services/reconciliation.ts`
  (el gate de la bandera + el campo `queried`) y `npm test` se puso rojo en
  `G-08` y `G-09` con **7** cadenas: las 6 de siempre más la de esta HU. Es
  literalmente el mismo error que ya está documentado más arriba, en la misma
  HU, con la misma causa.
- **Causa raíz**: la entrada anterior dice "derivar, no sumar" y la seguí — pero
  la escribí como una lección sobre CÓMO arreglarlo, no como un PASO PREVIO. La
  forma correcta es al revés: `grep -n "\.from('" <archivo>` **antes** de
  editar, para saber si el archivo tiene excepciones escritas a mano, y volver a
  correrlo después.
- **Fix**: derivados de nuevo del archivo y cruzados uno por uno por SÍMBOLO
  contenedor (`readLeasedRow`, `listPending`, `listAmbiguous`, `resolveIntent`
  ×2, `driftCheck`, `listSuspendedRuns`). Y además re-derivé las CUATRO citas
  `:NNN-NNN` que las propias razones hacen hacia docblocks, que el guardián no
  mira, abriendo cada rango para confirmar que el texto sigue diciendo lo que la
  razón afirma.
- **Aplicar en**: `reconciliation.ts` es un archivo con 7 excepciones escritas a
  mano; **cualquier** inserción lo rompe. Lo mismo pasó con dos citas
  `archivo:línea` hacia el guard `i > 0`: no lo moví, pero las 14 líneas de
  comentario que agregué DOCE líneas más arriba lo corrieron de `:602` a `:616`.
  El auto-blindaje de esta misma HU ya nombra el patrón ("las citas que rompés
  vos al arreglar otra cosa"); acá insertar por debajo del ancla era imposible,
  porque lo que se explica vive antes. Se re-apuntaron las dos, y el registro
  dice POR QUÉ.

---

### [2026-08-23 18:45] Fix-pack — Leí un archivo con `cat -n` y me devolvió el archivo SIN los comentarios

- **Error**: leí `test/wkh225-suspended-runs.migration.test.ts` con `cat -n`
  para copiar el bloque de `T-MIG-5` y reemplazarlo. El reemplazo falló con
  `AssertionError` porque el texto que copié no existe en el archivo: la salida
  que vi tenía el `it(...)` sin sus tres líneas de comentario interno.
- **Causa raíz**: `cat` está interceptado por el proxy de tokens y su salida es
  un RESUMEN, no el archivo. El fallo es silencioso: el contenido se ve
  plausible, numerado y bien formado.
- **Fix**: leer siempre con `sed -n 'A,Bp'` / `awk` (o `/usr/bin/cat`), y —lo
  que efectivamente lo cazó— hacer que el script de edición **falle** si el
  ancla no está (`assert old in s`) en vez de reemplazar con `str.replace` a
  ciegas, que habría escrito el archivo sin tocar nada y dejado el testigo viejo.
- **Aplicar en**: toda lectura de un archivo cuyo contenido se vaya a usar como
  ancla de edición. Y en general: **un `replace` que no encuentra su ancla tiene
  que ROMPER, no ser un no-op** — un no-op silencioso acá habría dejado
  `T-MIG-5` midiendo posiciones de literales y yo habría reportado que lo
  reescribí.

---

### [2026-08-23 20:10] Fix-pack it2 (AR/MNR-9) — Escribí "generaliza" de un parser que probé con UN solo caso

- **Error**: el docblock de `T-MIG-5` afirmaba que el control «generaliza:
  cazaría el mismo error re-introducido en cualquier otra rama». El AR extrajo
  el parser a un script y lo corrió contra 4 variantes del `.sql`: **2 pasaban
  en VERDE con el defecto adentro**. Un `IF` anidado (`IF TRUE THEN … END IF;`)
  escondía el bug entero, y un `UPDATE` + `RAISE` al nivel del cuerpo de la
  función era literalmente invisible.
- **Causa raíz**: verifiqué el parser contra los DOS inputs que tenía a mano —el
  `.sql` con el bug y el `.sql` arreglado— y de ese 2/2 deduje una propiedad
  UNIVERSAL. `/^[ \t]*IF .*?THEN$[\s\S]*?^[ \t]*END IF;$/gm` es no-greedy:
  ante anidamiento el bloque externo termina en el `END IF;` INTERNO. Y
  `bloquesIf` sólo miraba bloques `IF`, nunca el nivel superior. Ninguna de las
  dos limitaciones aparece si sólo probás los dos inputs que motivaron el
  control. Peor: el propio fix-pack introdujo un `IF` anidado en
  `trigger_set_suspended_run_expires_at`, así que la forma ciega ya estaba en el
  archivo cuando escribí "generaliza".
- **Fix**: parser reescrito con balanceo real (`regionesDe` cuenta
  profundidad línea por línea, parte cada bloque en sus ramas `ELSIF`/`ELSE` de
  primer nivel y devuelve TAMBIÉN el nivel superior como región), comentarios
  `--` stripeados antes de parsear, y `FOR UPDATE` excluido del DML (es lock, no
  escritura). Verificado mutando el `.sql` REAL, no razonando: parser viejo vs.
  nuevo, exit code de `vitest -t "T-MIG-5"`.

  | variante del `.sql` | parser viejo | parser nuevo |
  |---|---|---|
  | `aa0fc13` limpio | 0 (verde) ✅ | 0 (verde) ✅ |
  | `87134bf` real (el bug) | 1 (rojo) ✅ | 1 (rojo) ✅ |
  | MUT-0 · el `UPDATE` en un `IF` plano | 1 (rojo) ✅ | 1 (rojo) ✅ |
  | **MUT-1 · el `UPDATE` anidado en `IF TRUE`** | **0 (verde) ❌** | **1 (rojo) ✅** |
  | **MUT-2 · `UPDATE`+`RAISE` en el top-level** | **0 (verde) ❌** | **1 (rojo) ✅** |
  | MUT-3 · `EXECUTE 'UPDATE …'` | 1 (rojo) ✅ | 1 (rojo) ✅ |

  Y el docblock ya no dice "generaliza": DECLARA su alcance y sus cuatro
  límites. Las dos formas ciegas quedaron como fixtures DENTRO del test
  (`MUT_1` / `MUT_2` + `expect(infractoras(...)).toHaveLength(1)`), así que
  simplificar el parser vuelve a poner rojo ese control ANTES de que el `.sql`
  real lo necesite. Sin eso el docblock envejece otra vez en silencio.
- **Aplicar en**: **todo control que sea un PARSER**. Un parser probado con los
  inputs que lo motivaron mide esos inputs, no la propiedad. La regla mínima:
  antes de escribir "generaliza" / "cualquier" / "siempre" en el docblock de un
  guardián, construir al menos una variante que el guardián DEBERÍA cazar y que
  NO se parezca al caso original — y si no la construís, escribir el alcance
  acotado en vez del adverbio. Es la versión "parser" de la lección que este
  repo ya tiene: *un guardián que dice cubrir más de lo que cubre apaga la
  próxima revisión* — quien lo lea va a descartar un hallazgo real creyéndolo
  vigilado.

---

### [2026-08-23 20:35] Fix-pack it2 (AR/MNR-10 + MNR-11) — Dos certezas escritas que el código no respalda

- **Error**: dos comentarios normativos afirmaban cosas falsas o no verificables.
  (1) `ResumeStep0Debit.rejected` se documentaba como *"la base lo RECHAZÓ (nada
  aplicado)"*; (2) el `.sql` justificaba no bajar el guard de `MNR-6` a
  `resuming` diciendo que un claim concurrente marcaría `expired` un run EN
  EJECUCIÓN.
- **Causa raíz**: la misma en las dos, y no es descuido — es **prosa escrita
  desde la intención en vez de desde el shape**. En (1) el shape de
  `budgetService.debit` es `{success:false, error}` y sale por un canal que
  mezcla rechazo con no-sé (`catch` en las rutas de sesión/delegación, `error`
  de `supabase.rpc` —que incluye transporte— en las dos master): un timeout
  POSTERIOR al commit produce el mismo valor que un saldo insuficiente. Escribí
  la intención del caso ("esto es el rechazo por saldo") como si fuera una
  garantía del tipo. En (2) la razón era CIERTA cuando se escribió y **el fix de
  BLQ-ALTO-1 —mío, tres horas antes— la volvió falsa**: sacar la transición del
  RPC y ponerla en un `UPDATE … WHERE status='suspended'` hace que sobre un run
  en `resuming` afecte 0 filas. Arreglé el código y no barrí las razones que ese
  arreglo invalidaba.
- **Fix**: (1) el comentario baja a lo que el shape permite —"la base no
  confirmó el débito; la disposición puede ser DESCONOCIDA"— y deja escrito por
  qué `failed` sigue siendo correcto (lado seguro contra el doble cobro +
  paridad con `/compose`). Corregida también la MISMA frase repetida en el
  call-site, que el AR no citó y decía "⇒ nada se aplicó" dos líneas antes de
  decir "cuya disposición no podemos probar". Discriminar saldo de transporte
  queda declarado como **`TD-225-02`**, NO implementado: pide un tercer estado
  en `budgetService.debit` y toca el camino del dinero de `/compose`.
  (2) el párrafo se reescribe con el motivo verdadero —un guard laxo no marcaría
  nada, no emitiría residuo, y degradaría el 409 a un 410 engañoso— y suma el
  dato de que un run atascado en `resuming` **sí es visible** en
  `listSuspendedRuns`, que no filtra por status. La DECISIÓN (barrido con
  antigüedad mínima, NC-3 / TD-225-01) no cambia.
- **Aplicar en**: (1) todo tipo del camino del dinero cuyo comentario afirme una
  DISPOSICIÓN (`nada aplicado`, `ya cobrado`, `no se tocó`): sólo es válido si
  el productor del valor puede distinguir "no pasó" de "no pude preguntar". Si
  el fallo sale de un `catch` o del `error` de un cliente HTTP, **no puede**.
  (2) cuando un fix cambia DÓNDE ocurre una escritura, hay que barrer las
  justificaciones que se apoyaban en la ubicación vieja — no sólo los sitios que
  tocaste. Acá el `git diff` del fix-pack ni siquiera rozaba el párrafo falso:
  el fix lo volvió falso a distancia.
