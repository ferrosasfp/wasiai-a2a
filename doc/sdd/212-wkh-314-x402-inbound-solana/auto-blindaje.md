# Auto-Blindaje — WKH-314 (F3, 2026-08-19)

Errores cometidos y corregidos durante la implementación. Cada entrada existe para que
la próxima HU no los repita.

---

### [2026-08-19] W0 — La rama del Story File estaba tomada por un worktree fantasma

- **Error**: `git checkout -b feat/212-wkh-314-x402-inbound-solana` falló con *"is
  already used by worktree at `/home/ferdev/.openclaw/workspace/wt-314`"*, y ese
  worktree apunta a `6b391d6` — 267 commits atrás.
- **Causa raíz**: una sesión anterior creó el worktree y nunca lo limpió. La rama existía
  con **cero commits propios** (`git log main..rama` → 0 líneas), así que "la rama
  existe" no significaba "hay trabajo ahí". Es exactamente lo que la fila 212 del
  `_INDEX.md` ya advertía como *"pista falsa"*.
- **Fix**: se midió que el tip de la rama es ancestro de `main` y que los dos únicos
  archivos no rastreados del worktree eran **byte-idénticos** (md5) a los commiteados en
  `main`. Con eso probado, se trabajó en una rama nueva desde `main`.
- **Aplicar en**: antes de asumir que una rama tiene trabajo, `git log main..rama | wc -l`.
  Y antes de borrar cualquier cosa de un worktree ajeno, md5 contra la copia de `main`.

### [2026-08-19] W0 — Iba a mover una línea citada por `CLAUDE.md`

- **Error**: el diseño inicial hacía `supabase.from('a2a_solana_inbound_proofs')`, lo que
  obligaba a agregar la tabla al bloque `Tables` de `src/types/database.types.ts`.
  Alfabéticamente iba antes de `registries` ⇒ **desplazaba la línea 2567**, que
  `test/cited-lines-guard.citations.ts` declara como cita de `CLAUDE.md`.
- **Causa raíz**: no medí las citas declaradas sobre los archivos que pensaba tocar antes
  de elegir el diseño. La medición (un script sobre `citations.ts`) tardó un minuto y
  cambió una decisión de arquitectura.
- **Fix**: el peek pasó a ser una **función `SECURITY DEFINER`** en vez de un `.from()`.
  Eso (a) deja `database.types.ts` tocado sólo en el bloque `Functions`, que vive después
  de la 2567; (b) es **más** coherente con §7.1 del Story File, que dice que la tabla se
  toca *"exclusivamente desde las funciones `SECURITY DEFINER`"* — o sea que el `.from()`
  la contradecía.
- **Aplicar en**: cualquier HU que agregue una tabla. Medí `citations.ts` **antes** de
  decidir dónde insertar, no después de romper la suite.

### [2026-08-19] W1 — Dejé un bloque sintáctico sin sentido en el archivo del challenge

- **Error**: `verifySolanaChallengeReference` salió con un `return { ok: false, state:
  'not_configured', … }.state === 'not_configured' ? … : …` — un ternario sobre una
  propiedad de un objeto literal, con un campo `ok` que ni siquiera está en el tipo.
- **Causa raíz**: reescribí el early-return a mitad de camino y pegué las dos versiones.
- **Fix**: se reemplazó por el `return` simple. Lo cazó la relectura del archivo recién
  escrito, **no** el compilador — habría compilado igual.
- **Aplicar en**: releer el archivo entero después de escribirlo. `tsc` verde no
  significa "el código dice lo que quisiste decir".

### [2026-08-19] W1 — Un test de `src/` no puede importar de `test/`

- **Error**: puse los fixtures compartidos en `test/helpers/solana-inbound-fixtures.ts`
  (lo que pide el Scope IN §3.2 #21) y `tsc` cortó con **TS6059**: *"File … is not under
  rootDir `/src`"*.
- **Causa raíz**: `tsconfig.json` tiene `rootDir: ./src` e `include: ["src/**/*"]`. O sea
  que `test/**` **no está tipado por `tsc` en absoluto**, y un import desde `src/` lo
  arrastra al programa rompiendo el `rootDir`. Medido además: **no existe hoy ni un solo
  import `src/ → test/`** en el repo, o sea que no había precedente que copiar.
- **Fix**: los fixtures viven en `src/adapters/solana/__tests__/inbound-fixtures.ts`.
  `tsconfig.build.json` ya excluye `src/**/__tests__/**`, así que no van al bundle, y el
  glob de vitest (`*.test.ts`) no los toma como suite.
- **Aplicar en**: helper compartido por tests de `src/` ⇒ va en `src/**/__tests__/`.
  Helper para tests de `test/` ⇒ va en `test/helpers/`. **No se cruzan.**

### [2026-08-19] W1 — Adiviné el `resource` en un test y el test verde no lo era

- **Error**: `T-CACHE-01` armaba la fila cacheada con `resource:
  'http://localhost:80/charged'` escrito a mano. Dio 402 en vez de 200.
- **Causa raíz**: el `resource` es parte de los **términos** que el store compara, y
  adivinarlo hacía que los términos no coincidieran. Lo peligroso no es que fallara:
  es que si el handler hubiera ignorado el `resource` al comparar, este test habría dado
  **verde con el fixture equivocado** y no habría probado nada.
- **Fix**: el test toma el `resource` del propio 402 (`accepts[0].resource`).
- **Aplicar en**: todo fixture que reproduzca un valor que el sistema deriva. **Tomalo
  del sistema, no lo escribas.**

### [2026-08-19] W2 — Un guard estructural cazó una palabra mía

- **Error**: `T-NEUTRALITY-02` (`compose.stranded.test.ts`) se puso rojo: escanea todo
  `src/` buscando `prepaid|prepay|topup|deferredsettlement` contra una lista CONGELADA de
  archivos, y mi mensaje de error del preflight decía *"once as a **prepaid** deposit"*.
- **Causa raíz**: usé el token en inglés sin saber que hay un candado que lo vigila.
- **Fix**: se reescribió la frase (*"as a balance deposit"*) en vez de agregar mi archivo
  a la lista congelada. Mi uso no era el concepto que el guard vigila, pero **ensanchar
  el candado para que pase mi caso lo debilita para el próximo**, que sí podría serlo.
- **Aplicar en**: cuando un guard estructural te frena, la pregunta es *"¿mi texto puede
  cambiar?"* antes que *"¿la lista puede crecer?"*.

### [2026-08-19] W2 — El candado del README se alimenta del ÍNDICE de git

- **Error**: `test/readme-numbers.test.ts` rojo con `expected 296 to be 301` y
  `489 to be 498`. Los dos README declaran cuántos archivos de test y cuántos lintea
  Biome.
- **Causa raíz**: los números se **derivan de `git ls-files`**, o sea del índice. Un
  archivo nuevo no cuenta hasta que se hace `git add`, así que el número cambia en un
  momento distinto de cuando se crea el archivo — y una puerta puede pasar en verde y la
  siguiente explotar por el mismo diff.
- **Fix**: `git add` de todo lo nuevo **por ruta explícita** (nunca `-A`) y después
  actualizar los 4 marcadores de los dos README.
- **Aplicar en**: toda HU que agregue o mueva archivos. Stagear **antes** de correr la
  puerta, o el número que medís no es el que la suite va a ver.

### [2026-08-19] W2 — Los dobles sin tipo rompen `tsc` aunque los tests pasen

- **Error**: la suite del middleware daba 29/29 verde y `tsc` daba 10 errores en ese
  mismo archivo (`TS2347`, `TS2493`, `TS2353`).
- **Causa raíz**: `vi.fn(async () => ({ state: 'none' }))` infiere el tipo **del primer
  literal**, así que `mockResolvedValue({state:'observed', terms:{…}})` no compila; y un
  `vi.fn()` sin parámetros declarados hace que `mock.calls[0]` sea una tupla vacía para
  el compilador — justo el acceso que necesita CD-9 para afirmar sobre los argumentos.
- **Fix**: tipo `Loose = Record<string, unknown>` para el retorno, y **el parámetro
  declarado** en los dobles cuyos argumentos se assertean.
- **Aplicar en**: vitest verde **no** implica `tsc` verde. Las tres puertas, siempre, y
  por separado.

---

## Fix-pack del AR (2026-08-19)

### [2026-08-19] CORREGIDA — la causa que escribí acá era FALSA: el hook no elide, corrompe el PIPE

> ⚠️ Esta entrada decía *"el hook reescribe `cat`/`sed` y el resultado colapsa líneas"* y
> *"el comando sale 0: la pérdida es silenciosa"*, **como cosa medida**. El CR de WKH-314
> (MNR-7) intentó reproducirlo y no pudo; yo tampoco, re-midiendo. La conclusión operativa
> no cambia; **la causa sí**, y dejarla mal escrita hacía que el próximo agente descartara
> como artefacto conocido un desacuerdo que sería un hallazgo real.

- **Error**: leí un archivo con el visor bajo el hook, conté menos líneas de las que tiene
  y estuve por declarar mal una cita del AR sobre `chain.ts`.
- **Causa raíz — MEDIDA HOY, y NO es la que estaba escrita**: el contenido del archivo
  llega **intacto**. Control, sobre `chain.ts` (329 líneas): `/usr/bin/wc -l` = 329,
  `cat -n` bajo el hook redirigido **a un archivo** = 329 líneas, y `diff` contra
  `/usr/bin/cat -n` = IDENTICOS. Lo que **sí** se reproduce es lo que ya estaba en la
  memoria del proyecto como `rtk-proxy-corrupts-redirected-output`: **la salida
  encadenada por PIPE se corrompe**. Medido en la misma sesión:
  `cat -n chain.ts | tail -1` bajo el hook devuelve **vacío con exit 0**, mientras
  `/usr/bin/cat -n chain.ts | /usr/bin/tail -1` devuelve `329\t}`. (Y no es que el pipe
  entregue nada: `cat -n chain.ts | wc -l` sí da 329. Se pierde según qué consumidor
  haya del otro lado, lo cual es peor: la corrupción es **selectiva**.)
- **Fix**: `/usr/bin/cat`, `/usr/bin/sed`, `/usr/bin/git` con ruta absoluta, y **escribir
  a archivo en vez de encadenar por pipe**. El control que lo detecta: `/usr/bin/wc -l`
  contra el último número que imprime el visor **leído del archivo, no del pipe**.
- **Aplicar en**: TODA verificación de un `archivo:línea`, y —más importante— a toda
  afirmación sobre el instrumento. **Un artefacto de herramienta se documenta con el
  comando exacto que lo reproduce**, o el que venga después va a explicar con él un bug
  de verdad. Regla operativa: si escribís "la herramienta X hace Y", pegá el control que
  distingue Y de no-Y.

### [2026-08-19] FIX — El test que documentaba el bug con su razón escrita

- **Error**: `T-CHAL-02b` afirmaba `expect(issued(NOW).reference).toBe(issued(NOW).reference)`
  con un comentario de siete líneas explicando por qué la colisión era *"inofensiva
  porque el uso único vive en la FIRMA"*. Era el agujero BLQ-ALTO-2, verde y declarado.
- **Causa raíz**: la razón se escribió sin ejecutar el escenario del atacante. El uso
  único **sí** vive en la firma, y esa parte era cierta; lo que no se probó nunca es que
  el store pudiera distinguir a los dos callers — no puede: los cinco términos que
  compara salen byte-idénticos.
- **Fix**: entropía por emisión dentro del MAC, y el test invertido con la precondición
  MEDIDA (`issuedAt`, monto, `payTo`, `mint` y `resource` iguales) antes de la aserción.
- **Aplicar en**: cualquier test cuyo nombre empiece con "DECLARADO" o "inofensivo". Un
  comentario que explica por qué algo no importa es un lugar donde **nadie corrió el
  escenario**. La regla operativa: si la razón dice "X protege esto", escribí el test
  que ataca **con X puesto**.

### [2026-08-19] FIX — Un mutante que ningún mutante podía cazar (MNR-3)

- **Error**: el F3 reportó 20/20 mutantes muertos y los dos BLQ-ALTO pasaron igual.
- **Causa raíz**: los 29 `it()` derivaban el sobre del challenge del **mismo request**.
  Ningún mutante puede introducir un test que no existe, así que un barrido de mutación
  sobre esa suite mide la robustez de lo que ya se ejercita y **no dice nada** sobre lo
  que no.
- **Fix**: los dos tests se escribieron ANTES del arreglo y se midió que iban rojos
  (T-PRICE-01: `expected 200 to be 402`; T-STEAL-01: dos referencias idénticas literales;
  T-STEAL-02: `expected 200 to be 402` con la firma de la víctima).
- **Aplicar en**: antes de reportar un score de mutación, listar qué INPUTS no aparecen
  en ningún fixture de la suite. Acá eran dos: un sobre de otro precio y dos callers. El
  score no los podía nombrar.

### [2026-08-19] FIX — El fixture positivo también se rompe al agregar un campo al MAC

- **Error**: agregar `nonce` al material del HMAC dejó `tsc` con 8 errores en
  `solana-x402-challenge.test.ts`, todos en el helper `envelopeOf`.
- **Causa raíz**: el helper construye el sobre a mano, campo por campo. Es lo correcto
  (un sobre derivado del tipo no probaría nada), pero significa que **todo campo nuevo
  del MAC obliga a tocar el helper**, y si el campo fuera opcional el compilador no
  avisaría: los tests seguirían verdes probando un sobre viejo.
- **Fix**: el campo entra al tipo `presented` como **obligatorio** (`nonce: unknown`, no
  `nonce?: unknown`), así el compilador enumera todos los sitios.
- **Aplicar en**: cualquier ampliación de un material firmado. Campo nuevo ⇒ obligatorio
  en el tipo de verificación, aunque después el guard lo rechace por forma.

---

## Fix-pack del CR (2026-08-19)

### [2026-08-19] FIX — Reporté como MEDIDO un comportamiento de Fastify que no medí (MNR-1)

- **Error**: el reporte del fix-pack del AR declaró como desviación 2 que *"con `return;`
  en vez de `return reply;` el route handler habría corrido el trabajo pago"*. El CR lo
  midió contra Fastify 5.9.0 (el del repo) y es **falso**: con `reply.sent === true` los
  dos valores de retorno dan `status=504 handlerRan=false`. Lo que corta la cadena es el
  `.send()` previo, no el valor devuelto.
- **Causa raíz**: escribí la razón por la que el código está bien **razonando sobre la
  API**, no ejecutándola. El código quedó igual y el comentario de `x402.ts` dice lo
  correcto (habla del CONSUMO irreversible, no del lifecycle); lo que estaba mal era mi
  justificación.
- **Fix**: no se toca el código. Queda esta entrada, que es donde el reporte vive en
  disco.
- **Aplicar en**: toda afirmación sobre el comportamiento de una librería. Si no corriste
  el snippet, se escribe *"no lo medí"*, no la conclusión. Un reporte con una razón falsa
  y un veredicto correcto es peor que uno sin razón: parece verificado.

### [2026-08-19] FIX — Al veto le pedía menos que al grant (BLQ-BAJO-1)

- **Error**: `probeInboundLanding` devolvía `landed_failed` **en cuanto `status.err` era
  truthy**, y recién después miraba `confirmationStatus`. Como el fix del AR había puesto
  `landed_failed` en tier 0, un veto a nivel `processed` le ganaba a un `finalized_ok` del
  otro proveedor ⇒ `X402_SOLANA_TX_FAILED`, que no es reintentable, sobre una
  transferencia que sí se finalizó.
- **Causa raíz**: el arreglo anterior subió la PRIORIDAD del estado sin revisar sus
  PRECONDICIONES. El docblock que lo justificaba decía *"una aserción positiva sobre una
  transacción inmutable"* — cierto para `finalized`, falso para `processed`/`confirmed`,
  que es la definición misma de esos commitments. La razón escrita tapaba el agujero.
- **Fix**: el veto exige el mismo estándar que el grant (`conf === INBOUND_FINALITY`); sin
  finalidad el `err` es `unknown`, reintentable y sin consumo. Gemelos: `T-FAIL-01`
  (positivo, sigue siendo pegajoso contra `finalized_ok`), `T-FAIL-02` (5 commitments sin
  finalidad ⇒ `unknown`) y `T-FAIL-03` (el escenario de dos proveedores, en los dos
  órdenes).
- **Aplicar en**: cada vez que subas un estado de precedencia en una tabla de decisión,
  releé qué hace falta para EMITIRLO. Un rank alto convierte cualquier laxitud de la
  precondición en una decisión de dinero.

### [2026-08-19] FIX — Rompí CINCO citas mías al insertar 113 líneas encima (BLQ-BAJO-2)

- **Error**: `:1226`, `:1272`, `x402.ts:1217` y `x402.ts:1030-1033` quedaron apuntando a
  `.status(400)`, a un `const` y a un comentario suelto. Y re-barriendo aparecieron tres
  más que el CR no listó: `decodeXPayment (x402.ts:359-382)`, `x402.ts:476-478` y
  `registry.ts:426` (×3), correctas contra `main` y corridas por las inserciones de esta
  misma HU.
- **Causa raíz**: verifiqué las citas **cuando las escribí** y no **después de la última
  edición**, que es literalmente lo que pide CD-A1. Cada wave posterior insertó código
  encima del destino.
- **Fix**: se citan **símbolos y marcadores** (`requirePayment`, `DT-3 / CD-7`,
  `Guard FST_ERR_REP_ALREADY_SENT`, `decodeXPayment`, `getPaymentAdapter`,
  `NO toca el path prepago`), que sobreviven a la próxima inserción. Y un barrido
  automático de las citas de las líneas AGREGADAS por el diff, resolviendo cada destino y
  mostrando qué hay hoy en esa línea.
- **Aplicar en**: preferir el símbolo al número **siempre** que exista uno estable. Y el
  barrido no puede correr sobre `git diff main...HEAD` si tenés cambios sin commitear: eso
  mide el commit, no tu árbol.

### [2026-08-19] FIX — El denominador que justificaba un techo no existía (BLQ-BAJO-3)

- **Error**: el docblock de `INBOUND_RPC_TIMEOUT_MS` decía que 32 s quedan *"por debajo de
  los 60 s de `/compose`"*. `/compose` son **180 s** (`TIMEOUT_COMPOSE_MS`) y ninguna ruta
  del repo usa 60 s: el número venía del encabezado histórico de `middleware/timeout.ts`.
  Y *"el peor caso"* tampoco era 32 s: antes corre el preflight con tres sondas sin techo.
- **Causa raíz**: copié un número de un encabezado viejo en vez de leer la ruta. Una
  constante escrita a mano en un comentario no tiene quién la contradiga.
- **Fix**: la frase se acota a *"las dos llamadas RPC de este archivo"*, el denominador se
  corrige, y `T-RPCTO-04` **deriva** los tres números de los archivos donde viven
  (`inbound-presence.ts`, `routes/compose.ts`, `routes/orchestrate.ts`) y afirma la
  desigualdad. Calibrado: bajando el techo de `/compose` a 20 s el test se pone rojo.
- **Aplicar en**: toda comparación contra un límite ajeno. Si el límite vive en otro
  archivo, el test lo lee de ahí; si no, la afirmación envejece en silencio y nadie se
  entera.

### [2026-08-19] FIX F4 — El README decía "configuración" y la API contestaba "el código no puede" (§6.2 + §6.3)

- **Error**: dos hallazgos que son **uno solo**. (1) Un ítem del Scope IN
  (`work-item.md:284-285`: *"reescritura DELIBERADA de
  `src/middleware/x402.non-evm-inbound.test.ts` … reescribir, no borrar"*) se declaró y
  **no se hizo**: la HU agregó `x402.solana-inbound.test.ts` en vez de invertir aquél
  (`git diff main...HEAD --stat` sobre ese archivo = vacío). (2) Por eso mismo, el
  mensaje que el integrador recibe de verdad —`inboundPaymentUnsupportedMessage`— quedó
  afirmando **sin condicional** *"It is an OUTBOUND settlement rail … the inbound leg
  needs an EVM signed authorization (EIP-3009), which this chain's payment adapter does
  not implement"*: una propiedad **del código**, que es exactamente lo que `README.md:97`
  dice que **no** es. Vivo en producción (HTTP 400 medido por el F4; control positivo
  `base-sepolia` ⇒ 402) y en un repo público.
- **Causa raíz**: la frase estaba **clavada por un test verde**
  (`T-204-03`, `expect(body.error).toMatch(/OUTBOUND settlement rail/)`) en el archivo
  que el Scope IN mandaba reescribir. No reescribirlo no dejó un hueco de cobertura:
  dejó un **candado sosteniendo la afirmación vieja**, así que nadie iba a verlo rojo.
  El docblock de `x402.solana-inbound.test.ts:9-10` argumentaba lo contrario ("la regla
  de la casa es no reescribir la suite que uno vuelve obsoleta") — una regla razonable
  que acá tapó un ítem explícito del Scope IN.
- **Fix**: el mensaje se reescribió chain-agnóstico (lo comen **todas** las non-EVM, no
  sólo Solana: el `false` sale de `acceptsInboundPayment`, `src/adapters/registry.ts:523`),
  con el condicional DENTRO de la afirmación (*"on this deployment right now"*, *"That is
  a CONFIGURATION state, not a limit of the code"*) y las **tres** salidas nombradas
  (otra chain / key prepaga / **pedirle al operador que encienda el rail**).
  `x402.non-evm-inbound.test.ts` se **reescribió, no se borró**: mismas exigencias, otra
  afirmación. `T-204-03` fija el texto nuevo **y** prohíbe las tres frases viejas
  (`OUTBOUND settlement rail`, `EIP-3009`, `does not implement`); `T-204-09` es nuevo y
  enciende las cuatro envs en el MISMO proceso para probar que el 400 es config.
  Calibrado: revertido SOLO el texto del mensaje ⇒ `T-204-03` **rojo**
  (`expected … to match /on this deployment right now/`), los otros 8 verdes;
  `acceptsInboundPayment` mutado a `return false` ⇒ `T-204-09` **rojo**, los otros 8
  verdes. Restauración por **sha256** contra un registro previo, nunca `git checkout --`.
- **Aplicar en**: cuando una HU cambia lo que un ERROR de la API significa, el texto del
  error es **artefacto de la HU**, no documentación. Y antes de declarar "esa suite queda
  intacta porque sigue verde": preguntá **qué afirma**, no si pasa. Un test verde que
  sostiene una frase que dejó de ser cierta es peor que un hueco — el hueco no defiende
  a nadie.

### [2026-08-19] TD — El costo del `unknown` y su mensaje EVM-específico (F4 §3.c, NO se implementó)

- **Qué queda abierto** (dos cosas, mismo productor):
  1. **Amplificación 0 → N por fallo genuino.** `unknown` dispara `emitUnknown`
     (`src/middleware/x402.ts:995`) → `emitInboundSettleUnknownEvent`
     (`src/middleware/x402.ts:404`), que por invocación hace un `request.log.error`
     **alertable** (`src/middleware/x402.ts:425`) **y** una fila durable en `a2a_events`
     con `status:'failed'` (`src/middleware/x402.ts:448-465`), **sin dedup ni
     rate-limit**. Contraste medido en el MISMO archivo: `warnDefaultChainApplied` sí
     tiene ventana + cap (`src/middleware/x402.ts:142` y `:159`, aplicados en `:207`).
     Aritmética del F4: un
     cliente que obedece el `Retry-After: 15` ⇒ **4 logs ERROR + 4 filas failed en 60 s**
     por un pago que no va a prosperar (antes del fix-pack 2: 1 log `info`, 0 eventos).
  2. **El texto es EVM-específico y falso para el productor nuevo.**
     `src/middleware/x402.ts:437` dice *"the facilitator hop was cut without an answer,
     so the payment may have executed on-chain … the caller may have been charged"*. En
     el inbound Solana **no hay facilitator** (firma el pagador; el gateway sólo lee la
     cadena) y `txHash` es `null` siempre (`src/middleware/x402.ts:877`); en el caso
     `err`-sin-finalidad el caller **no** fue cobrado por nosotros. Compartir el canal
     fue correcto (DT-14); no se ajustó el texto para el segundo productor.
- **Por qué no entra acá**: fuera del encargo del fix-pack F4 (que es §6.2 + §6.3).
  Ninguna de las dos es bloqueante y el rail nace apagado, así que hoy **no hay
  productor en producción**.
- **Cuándo hay que hacerlo**: **ANTES de encender el rail** (`SOLANA_X402_INBOUND_ENABLED
  = true`), que es el momento en que el primer `unknown` real puede aparecer. Alcance
  propuesto por el F4: parametrizar el mensaje por productor (EVM/facilitator vs Solana/
  testigo) y evaluar dedup por `(caip2, signature)`.

### [2026-08-19] FIX F4 (2da vuelta) — Arreglé el mensaje y el README seguía diciendo la frase vieja

- **Error**: el fix-pack corrigió `inboundPaymentUnsupportedMessage` y **dejó intacta la misma
  frase falsa en `README.md:35` y `README.es.md:35`**: *"Inbound charging over x402 is still EVM,
  because that leg needs an EIP-3009 style signed authorization that the Solana adapter does not
  implement"*. Es el **primer bloque** del documento, el repo es **público**, y el mismo README se
  contradecía a sí mismo en `:214` / `:248` (*"implemented (WKH-314), off in the deployment that is
  up"*). Misma clase en `doc/INTEGRATION.md:7`.
- **Causa raíz**: el F4 §6.1 declaró *"los 6 README condicionados — ✅ ciertos en los dos estados"*.
  Cierto **de los 6 bloques que la HU editó**; el barrido nunca salió de ellos. Un documento no se
  verifica revisando el diff: la frase vieja no está en el diff **porque nadie la tocó**. El mismo
  patrón que ya tiene entrada propia acá arriba (las citas que se rompen por lo que **no** editás),
  aplicado a prosa en vez de a números de línea.
- **Fix**: las tres afirmaciones pasan a ser de **configuración** con el condicional DENTRO
  (*"exists in the code since WKH-314 and is off in the deployment that is up right now"*), y
  mandan a leer `chains[].acceptsInboundPayment` en vez de creerle al párrafo.
  `README.md:97` / `README.es.md:105` pasan de *"the two ways out"* a **tres**. `:214` / `:248`
  **no se tocan** (son los que el F4 midió contra el gateway vivo) y ahora `:35` coincide con
  ellos en vez de contradecirlos. Ediciones línea-neutras (444 / 478 / 1398).
- **Aplicar en**: cuando una HU cambia lo que algo SIGNIFICA, el barrido de docs se hace por
  **frase**, no por diff — grepear la afirmación vieja en todo el repo, incluidos los archivos que
  la HU no abrió. Y cuando un doc dice A arriba y no-A abajo, el que suele estar podrido es el de
  **arriba**: se escribió antes y nadie vuelve a leer el intro.
