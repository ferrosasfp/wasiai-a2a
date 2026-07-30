# Auto-Blindaje — WKH-315 (depósito prepago Solana)

Errores cometidos durante F3 y cómo se previenen la próxima vez. Se escribe **cuando
el error ocurre**, no al final.

---

### [2026-07-30 W0] El story file afirmó que la suite CD-1 no habría que tocarla, y sí hubo que tocarla (por tipos, no por conducta)

- **Error**: asumí, siguiendo §1.7 y `[SDD GAP #2]`, que narrowear
  `VerifyDepositArgs.chainKey` a `EvmChainKey` no rompería
  `src/adapters/deposit-verifier.test.ts` — una de las cuatro suites que CD-1/AC-10
  exige **verdes sin modificarse**. Rompió: 14 errores de compilación.
- **Causa raíz**: la verificación del story file fue sobre el **VALOR** ("ningún test
  pasa `chainKey: 'solana-devnet'` a `verifyDeposit`" — cierto) y no sobre el **TIPO**
  de la expresión. Los 14 call-sites escriben
  `chainKey: 'kite-ozone-testnet' as ChainKey`: un cast de **ensanchamiento** que le
  borra al compilador la información de que el literal ya es EVM. Un `as` no es
  neutral: cambia lo que el compilador sabe, y por lo tanto cambia qué narrowing
  aguas arriba es posible.
- **Fix**: se quitaron los 14 `as ChainKey` (y el import de `ChainKey`, que quedó sin
  uso). Cero aserciones, cero fixtures, cero mocks, cero conducta. Se descartaron las
  dos alternativas porque `[SDD GAP #2]` las prohíbe explícitamente: el cast en
  `deposit-verifier.ts:304` (aserción sin chequeo) y un guard dentro de
  `verifyDeposit` (cambia un cuerpo que CD-1 congela).
- **Aplicar en**: cualquier HU que narrowee el tipo de un parámetro público.
  **Grepear `as <TipoAncho>` en los tests ANTES de estimar el impacto**, no sólo los
  valores literales. Un `as` en un test es una dependencia de tipos invisible para un
  grep por valor.

---

### [2026-07-30 W0] Una propiedad requerida nueva en `A2AAgentKeyRow` rompe 33 archivos de test, dos de ellos intocables

- **Error**: declaré `funding_wallet_solana: string | null` (requerida) en
  `src/types/a2a-key.ts`. `tsc` cayó en 33 archivos que construyen la fila a mano,
  entre ellos `src/routes/auth.test.ts` — suite CD-1, prohibido editarla.
- **Causa raíz**: en un repo con `exactOptionalPropertyTypes`, agregar un campo
  REQUERIDO a una interfaz que ~33 fixtures construyen literalmente es un cambio
  transversal, no aditivo. El costo no está en el tipo: está en la cantidad de
  fixtures que lo materializan.
- **Fix**: `funding_wallet_solana?: string | null`, con la razón escrita en el
  docstring del campo. El story file (W0.5) ya autorizaba exactamente esto
  ("si algún fixture existente rompe `tsc`, pasalo a `?: string | null` y
  **declaralo**"). Riesgo acotado y del lado seguro: el único lector en producción es
  el gate de `POST /auth/deposit`, que fail-closea sobre cualquier valor falsy
  (`undefined` incluido) con 403 `FUNDING_WALLET_NOT_BOUND`.
- **Aplicar en**: toda columna nueva que aparezca en un row-type compartido. Contar
  los fixtures ANTES de elegir requerido vs opcional: `grep -rl "key_hash:" src/`
  aproxima el costo en un comando.

---

### [2026-07-30 W1.3] Un test que grepea una prohibición se satisface con la prosa que la documenta

- **Error**: el test "el módulo es LEAF" de `ed25519.test.ts` afirmaba
  `expect(src).not.toMatch(/tweetnacl|bs58/)` sobre el fuente CRUDO. Se puso rojo en su
  primera corrida — y no por una violación: la cabecera del módulo **explica** por qué
  no se usan esas dos librerías.
- **Causa raíz**: el test se ponía rojo justamente por cumplir bien la prohibición. Es
  el reverso exacto de la vacuidad clásica (un match contra el texto completo que se
  satisface con un comentario): acá el comentario producía el FALSO POSITIVO en vez del
  falso verde, pero la causa es la misma — afirmar sobre texto sin separar código de
  prosa.
- **Fix**: grepear el texto SIN COMENTARIOS, con el mismo criterio que el helper
  `code()` de los tests de migración.
- **Aplicar en**: TODA aserción sobre el texto de un fuente. Si el archivo documenta la
  regla que el test vigila —y los buenos la documentan— hay que despojar comentarios en
  las dos direcciones. Ya se aplicó en `deposit-account.test.ts` (T-315-13),
  `deposit-verifier.test.ts` (CD-14) e `identity.solana-funding.test.ts` (M7).

---

### [2026-07-30 W2] Un guard de seguridad por subcadena prohibía la carga útil de la respuesta

- **Error**: `T-315-12c` afirmaba `not.toContain('1'.repeat(32))` para cazar el fixture
  de `OPERATOR_PRIVATE_KEY` (`0x` + `'11'` × 32). Rojo, y **no por una fuga**.
- **Causa raíz**: el mint fixture `So111…112` tiene una tirada de **40 unos
  consecutivos**, así que contiene el needle. Y `token.mint` es precisamente el dato que
  el depositante NECESITA. El guard prohibía la carga útil. Raíz profunda: **un secreto
  formado por un carácter repetido es indistinguible de una dirección base58 legítima**,
  así que un guard por subcadena sobre él no puede separar la fuga del dato bueno.
- **Fix**: NO borrar la aserción (eso sí habría debilitado el control). Se le dio al
  fixture un valor DISTINTIVO (`a3f19c7d` × 8), se afirma sobre el valor COMPLETO y
  sobre la **address derivada** con `privateKeyToAccount` —el valor exacto que el
  landmine publicaría, que antes no se verificaba—, y se agregó andamiaje anti-vacuidad
  (`networks.length === 1`) porque una respuesta vacía pasaba los cinco guards. Probado
  con una fuga inyectada: el guard muere con nombre.
- **Aplicar en**: todo fixture de secreto en un test de no-filtración. **Que sea
  distintivo es parte del contrato del test**, no un detalle estético. Y cuando un guard
  de seguridad se pone rojo, medir primero si lo que matchea es legítimo antes de tocar
  ninguna de las dos partes.

---

### [2026-07-30 W3.3] Un mutante sobrevivió: el test probaba el validador, no la ausencia del fallback

- **Error**: **M18 SOBREVIVIO** en la primera corrida de la campaña. La mutación
  (`A2A_DEPOSIT_OWNER_SOLANA ?? A2A_DEPOSIT_TREASURY_SOLANA`) dejó la suite entera verde.
- **Causa raíz**: el test ponía en la env de treasury una **address EVM**, que
  `isValidSolanaAddress` rechaza igual. O sea que el `null` venía de la validación
  siguiente, **no de la ausencia del fallback**. El test afirmaba sobre el validador y
  yo lo leía como si afirmara sobre el fallback. Es la vacuidad más difícil de ver: el
  test no es decorativo, prueba algo real — simplemente no prueba lo que su nombre dice.
- **Fix**: se agregó el caso que de verdad duele — la env de treasury con una **pubkey
  base58 VALIDA**, que es exactamente la confusión que el landmine invita (la env se
  llama `..._SOLANA`). Con ese caso, M18 pasa a **KILLED**.
- **Aplicar en**: cuando un test afirma "X no se usa", el fixture de X tiene que ser un
  valor que **sí funcionaría** si se usara. Si el fixture es rechazable por otro motivo,
  el test pasa por la razón equivocada. Regla operativa: **la mutación es la única forma
  de descubrir esto** — sin la campaña, este test habría entrado al AR como verde.

---

### [2026-07-30 W3.3] El mutante M1 del story file no compila, y eso es un hallazgo, no un obstáculo

- **Error**: M1 tal como lo especifica el story file (`DEPOSIT_COMMITMENT` pasa de
  `'finalized'` a `getSolanaCommitment()`) **no compila**, así que por la regla 3 no
  contaba como mutante.
- **Causa raíz** (y es buena noticia): `getParsedTransaction` tipa su `commitment` como
  `Finality` = `'confirmed' | 'finalized'`, que **excluye `'processed'`**. El retorno de
  `getSolanaCommitment()` incluye los tres, así que el SDK rechaza la sustitución. **El
  tipo del SDK es una segunda línea de defensa independiente**, que el diseño no había
  contado.
- **Fix**: se corrió la variante compilable y equivalente en intención —bajar el literal
  a `'confirmed'`—, que es el debilitamiento real que M1 quiere probar. **KILLED** por
  `T-315-03b`. Ambos resultados se reportan.
- **Aplicar en**: un mutante que no compila no se descarta en silencio ni se cuenta como
  muerto: se investiga POR QUE no compila (puede ser una defensa que nadie documentó) y
  se re-formula a la variante compilable más cercana.

---

### [2026-07-30 W3.2] El story file manda editar un documento que no existe en el repo

- **Error**: W3.2 lista `doc/MULTI-CHAIN.md` como archivo a modificar, y
  `chain-resolver.ts` lo cita como referencia de `TD-SOLANA-CAIP2-DENYLIST`. **No existe
  en este repositorio.**
- **Causa raíz**: la limpieza del 2026-07-28 sacó documentación interna a un repo
  privado. `test/docs-referenced-by-code-exist.test.ts` lo registra explícitamente como
  un nombre pelado que ya no resuelve, y por eso su chequeo sólo mira referencias con
  forma de ruta — así que el puntero roto **no pone roja ninguna suite**.
- **Fix**: NO se creó el archivo (crear un doc de raíz que el diseño suponía existente
  es inventar scope, y el contenido se movió a propósito). El runbook y la deuda
  declarada fueron a `doc/INTEGRATION.md` §6, que sí existe y es lo que el depositante
  lee, dejando anotado que el puntero del comentario sigue roto.
- **Aplicar en**: antes de "modificar" un archivo que un Story File lista, **verificar
  que exista**. Si no existe, es un hallazgo para el orquestador, no una invitación a
  crearlo.

> ⚠️ **ESTA ENTRADA ERA FALSA Y SE CORRIGE ABAJO** (fix-pack AR/CR · MNR M1). El
> documento **SI existe**: es `doc/architecture/MULTI-CHAIN.md`, 26 KB, versionado.
> Ver la entrada del fix-pack más abajo.

---

### [2026-07-30 FIX-PACK · BLQ-MED-1] Un guard de dinero que fallaba ABIERTO, y un comentario que afirmaba lo contrario

- **Error**: `atomicOf` (`deposit-verifier.ts`) **ignoraba en silencio** toda entrada
  cuyo `uiTokenAmount.amount` no parseara a `BigInt`. Del lado `post` eso sub-mide y es
  inofensivo; del lado **`pre`** hacía `preOurs = 0n` y por lo tanto
  `delta = postOurs` — **el saldo ENTERO de la ATA de tesorería acreditado como
  depósito**. Con 1000 USDC en tesorería y un depósito de 1, acreditaba 1001.
- **Causa raíz**: el `catch` se escribió pensando en UNA de las dos listas. El
  comentario lo decía explícitamente ("si eso hace que el delta no sea > 0, nadie
  acredita") y **es falso del lado `pre`**, donde ignorar una entrada AUMENTA el delta.
  Es la familia de "un guard que afirma más de lo que su evidencia sostiene": el
  comentario documentaba una garantía que el código no daba, y por eso nadie la
  cuestionó. Ninguno de los 33 casos del archivo tenía un `amount` ilegible.
- **Fix**: `atomicOf` devuelve `bigint | null` y `sumAtomic` devuelve `null` si
  CUALQUIER entrada relevante es ilegible ⇒ `DEPOSIT_VERIFICATION_UNKNOWN` (503, la
  prueba NO se consume). Igual en el bloque de atribución del depositante. Comentario
  reescrito con lo que el código hace de verdad.
- **HALLAZGO EXTRA, y es la mitad del bug**: `try { BigInt(x) }` **no alcanza**.
  `BigInt('')` y `BigInt('   ')` dan `0n`, y `BigInt('0x10')` da `16n`: para tres de las
  formas ilegibles más probables el `catch` **ni se ejecuta**, y un `''` del lado `pre`
  producía el mismo crédito del saldo de tesorería por otra puerta. Se exige
  `/^\d+$/` antes de convertir (el RPC manda siempre un entero decimal).
- **Mutación**: con el `continue` restaurado mueren `BLQ-MED-1 … lado PRE` y
  `BLQ-MED-1 … lado POST`; quitando el regex muere el caso `''` del lado PRE.
  **Y el test del lado PRE sobrevivía al primer mutante** hasta que se le agregó
  `expect(res.detail).toContain('deposit ATA')`: el UNKNOWN lo terminaba dando OTRO
  guard (el de atribución), que mira las mismas entradas. Un test de "veredicto
  correcto" sin identificar **qué guard habló** es vacuo en cuanto hay dos guards que
  pueden decir lo mismo.
- **Aplicar en**: (a) todo `catch`/`continue` dentro de una suma de dinero — preguntar
  qué pasa si la entrada saltada está del lado del MINUENDO; (b) nunca usar `BigInt(s)`
  como validador de formato: **valida menos de lo que parece**; (c) cuando dos guards
  pueden emitir el mismo veredicto, el test tiene que pinchar cuál de los dos.

---

### [2026-07-30 FIX-PACK · MNR-2] Un campo ausente leído como "fue a otro lado"

- **Error**: `isOurAta` exigía `b.owner === expectedOwner` **además** del mint y la
  dirección de la ATA. `owner` es OPCIONAL en el tipo de `@solana/web3.js`, así que un
  RPC que lo omite hacía que la ATA de depósito no matcheara y el veredicto saliera
  `RECIPIENT_MISMATCH`: una afirmación de que la plata fue a otro lado, hecha sobre un
  dato que faltaba, y determinista (el depositante legítimo quedaba bloqueado para
  siempre). El comentario de al lado declaraba ese caso "imposible".
- **Causa raíz**: el tercer término no agregaba seguridad —la ATA es una PDA derivada de
  (mint, owner), así que mint + DIRECCION ya identifican la cuenta— pero sí agregaba una
  forma de fallar sobre un campo opcional.
- **Fix**: el `owner` ausente no descalifica; el `owner` presente y distinto sigue
  descalificando. Y en el bloque de atribución, una cuenta que BAJA saldo sin `owner`
  declarado da `DEPOSIT_VERIFICATION_UNKNOWN` en vez de `DEPOSITOR_AMBIGUOUS`: "no pude
  preguntar" no es "hay más de un candidato".
- **Aplicar en**: antes de sumar un término a un match, preguntarse **qué información
  agrega que los otros no den ya**. Un término redundante sobre un campo OPCIONAL no es
  defensa en profundidad: es una fuente de falsos negativos con voz de veredicto.

---

### [2026-07-30 FIX-PACK · M1] Concluí "el archivo no existe" de una ruta mal tipeada, y lo escribí como lección

- **Error**: la entrada `[W3.2]` de más arriba afirma que `MULTI-CHAIN.md` **no existe en
  este repositorio**. **Es falso.** Existe: `doc/architecture/MULTI-CHAIN.md`, 26 KB,
  versionado en `main` desde hace meses. Lo que no existe es `doc/MULTI-CHAIN.md`, que es
  la ruta —**sin la carpeta `architecture/`**— que el story file escribió en `:301` y
  `:567` y que yo verifiqué al pie de la letra.
- **Causa raíz**: verifiqué **la ruta que me dieron**, no **el documento**. Un `ls` de la
  ruta exacta contesta la pregunta equivocada cuando la ruta puede estar mal tipeada, y
  un `.md` de arquitectura vive casi siempre en una subcarpeta. Y encontré una
  explicación **coherente y falsa** para el hueco (la limpieza del 2026-07-28 sí sacó
  documentación interna), lo cual apagó la duda en vez de encenderla: cuando la primera
  hipótesis explica bien el síntoma, deja de buscarse una segunda.
- **Fix**: el registro de la deuda `TD-SOLANA-CAIP2-DENYLIST` y las tres envs nuevas
  fueron a `doc/architecture/MULTI-CHAIN.md` §10.1 —el registro de deudas de verdad—,
  `INTEGRATION.md` §6.7 quedó con lo que le sirve al depositante y un puntero, y el
  comentario de `chain-resolver.ts` ahora cita la ruta COMPLETA, que además queda
  vigilada por `test/docs-referenced-by-code-exist.test.ts` (sólo verifica referencias
  con forma de ruta: el nombre pelado que había antes era invisible para el guardián).
- **Aplicar en**: cuando un artefacto "no existe", buscarlo **por nombre en todo el
  repo** antes de escribirlo como hecho (`git ls-files | grep -i <nombre>` cuesta un
  segundo). Es la misma familia que el falso rojo del mint: **verificar qué SIGNIFICA el
  dato antes que su VALOR**, y desconfiar del hallazgo que además trae su propia
  explicación cómoda. Y una lección escrita en un auto-blindaje se propaga: un hecho
  falso acá vale más caro que uno en un comentario.

---

### [2026-07-30 FIX-PACK · BLQ-MED-2] Copié el idioma de la migración exemplar, pero no la línea que cerraba la ventana

- **Error**: la migración dropea `register_a2a_key_deposit` de 6 params —**que está en
  uso**— y crea la de 7, **sin emitir `NOTIFY pgrst, 'reload schema';`**. Con el caché de
  esquema viejo, `budgetService.registerDeposit` no resuelve y `POST /auth/deposit` del
  camino **EVM** contesta 500: la migración rompía el camino que su propia cabecera
  promete byte-idéntico, y su propia afirmación de "migración antes del código ⇒ sin
  ventana".
- **Causa raíz**: copié de `20260730000000_wkh307...` el idioma del DROP+CREATE y el
  hardening por firma, pero no el `NOTIFY` — que ahí está documentado a tres líneas del
  final, para funciones **NUEVAS**. Acá el riesgo es MAYOR (se borra una viva) y aun así
  se me pasó, porque revisé el bloque que copié y no el archivo entero del exemplar.
- **Fix**: una línea en cada archivo, con la razón escrita, más tres tests estructurales
  (existe en los dos, y va DESPUES del swap). Se pone igual aunque Supabase suele traer
  un event-trigger que recarga solo: **no se pudo determinar** para la base destino, y
  "no lo pude comprobar" no es "está cubierto".
- **Aplicar en**: cuando se copia un idioma de un exemplar, leer el archivo **completo**,
  no el bloque análogo. Y en toda migración que toque una función que ya tiene callers.

---

### [2026-07-30 FIX-PACK · BLQ-BAJO-1] Un guard que cobra antes de tener algo que cuidar

- **Error**: la aserción de coherencia cuenta-de-depósito ↔ operador lanzaba dentro de
  `getSolanaOperatorKeypair()` **sin condicionar a que el camino de depósito estuviera
  encendido**. Siguiendo el orden de activación que el propio `.env.example` declara
  —migración, owner, y el flag AL FINAL— y olvidando `..._IS_DEDICATED`, **todo settle
  Solana de SALIDA se caía** con el depósito apagado, o sea sin que existiera un solo
  depósito que proteger.
- **Causa raíz**: puse el guard donde estaba el dato (el keypair ya cargado) y razoné el
  trade-off "romper la salida es mejor que perder plata" — que es cierto **cuando hay
  plata en juego**. No modelé la ventana en la que el depósito todavía no existe, que es
  justamente la que el runbook recomienda transitar. Un guard cuya precondición no está
  en su condición se dispara fuera de su propio dominio.
- **Fix**: el flag entra en la condición. Tres tests, incluido el andamiaje de que con el
  flag en `'true'` el mismo caso SIGUE lanzando — sin eso, "condicionar" y "apagar" son
  indistinguibles y los dos primeros tests pasarían sin probar nada.
- **Aplicar en**: todo guard nuevo, preguntarse **en qué estados del sistema se dispara**
  y si en alguno todavía no existe el bien que protege. Y probar SIEMPRE el lado positivo
  del control junto con el negativo.

---

### [2026-07-30 FIX-PACK · campaña] Re-corrida de mutación: 21/21 KILLED

Se re-corrieron los mutantes de la campaña original que tocan código modificado (M1, M2,
M3, M4, M8, M9, M10, M11, M12, M13, M14, M16, M19) más **8 mutantes nuevos** del
fix-pack: el `continue` de BLQ-MED-1, el `BigInt` sin validar formato, el `NOTIFY`
ausente en `up` y en `_down`, el flag fuera de la condición de BLQ-BAJO-1, el `owner`
ausente descalificando de nuevo, el `_down` sin archivar los binds y los backups sin RLS.
**21/21 KILLED, cada uno con el nombre del test que muere.** Los archivos se restauraron
verificando `sha256` en cada iteración.

*(Actualizado en la iteración 5: **38 mutantes, 38 KILLED**, más un **fuzz sistemático
propio** que quedó en el repo como red permanente (`deposit-verifier.fuzz.test.ts`):
103 mutaciones de una fila y 5.253 combinaciones cruzadas de `pre`/`post` sobre un
depósito legítimo, **cero inflaciones**. El criterio de aceptación dejó de ser prosa:
es un test que corre en cada CI.)*

---

### [2026-07-30 FIX-PACK it2 · BLQ-MED-3] Arreglé la indeterminación del VALOR y dejé abierta la de la PRESENCIA

- **Error**: cerré BLQ-MED-1 (un `amount` ilegible) y di el guard por cerrado. El re-AR
  reprodujo **el mismo daño exacto** —1001 USDC acreditados por un depósito de 1— por
  tres puertas que mi fix no tocaba: `preTokenBalances` **ausente** (`?? []` la lee como
  vacía ⇒ `preOurs = 0`), `postTokenBalances` ausente (⇒ delta NEGATIVO, que salía como
  `RECIPIENT_MISMATCH`), y —la peor— **una lista presente a la que le falta la FILA de
  nuestra ATA**, donde ningún campo es ilegible y ninguna lista falta.
- **Causa raíz**: pensé el problema como "los valores pueden venir mal" y no como "los
  datos pueden venir INCOMPLETOS". Un `?? []` es una **suposición disfrazada de
  default**: convierte "no me lo mandaron" en "era cero", que es una medición que nadie
  hizo. Y la fila faltante ni siquiera es expresable como validación de campo: no hay
  nada que validar donde no hay nada.
- **Fix**: tres guards de naturalezas distintas, porque uno solo no cubre a los otros.
  (1) las dos listas tienen que ser arrays de verdad, si no ⇒ UNKNOWN; (2) `delta < 0n`
  ⇒ UNKNOWN (una cuenta que recibe no puede perder saldo: si el número es imposible, lo
  que aprendimos es que los datos están mal, no que la plata fue a otro lado); (3) un
  **invariante de conservación**: lo acreditado no puede superar la baja total de las
  cuentas de origen del mismo mint, con `totalSourceDrop` sacado del loop de atribución
  —que lee entradas DISTINTAS de las que producen el delta—, así que el invariante no se
  recalcula a sí mismo.
- **Y por qué no alcanzaba la defensa de respaldo**: el único chequeo que habría atrapado
  esto es `AMOUNT_MISMATCH`, y `body.amount` es **opcional** en la ruta. Una protección
  que depende de que el propio caller la pida no es una protección.
- **Aplicar en**: (a) todo `?? []` / `?? 0` sobre un dato EXTERNO en un camino de dinero
  es sospechoso por definición — preguntar siempre "¿qué afirmo si esto no vino?";
  (b) validar campos no cubre datos incompletos: hace falta al menos **una aserción que
  cruce dos mediciones independientes** de la misma operación; (c) cerrar un bug por su
  ejemplo (el `amount` ilegible) y no por su CLASE (la indeterminación) deja hermanos
  vivos. El re-AR encontró tres.

---

### [2026-07-30 FIX-PACK it2 · el needle que envejeció] Un test específico se volvió vacuo sin que nadie lo tocara

- **Error**: el test del lado PRE de BLQ-MED-1 **volvió a sobrevivir** al mutante del
  regex en la iteración 2, después de haber quedado KILLED en la iteración 1. Nadie tocó
  el test.
- **Causa raíz**: su needle era `expect(res.detail).toContain('deposit ATA')`, elegido
  precisamente para identificar QUE guard habló. El invariante de conservación —nuevo—
  también dice "deposit ATA" en su detalle, así que el needle pasó a matchear dos
  guards y el test volvió a afirmar "alguien dijo UNKNOWN" en vez de "lo dijo ESTE".
  **Un identificador por subcadena no es estable frente a código nuevo**: su unicidad
  depende de todo lo que todavía no se escribió.
- **Fix**: dos needles en conjunción (`'deposit ATA'` **y**
  `'unreadable uiTokenAmount.amount'`), que es lo único que hoy sólo puede decir ese
  guard, con la razón escrita al lado para que el próximo que agregue un mensaje sepa
  qué está sosteniendo.
- **Aplicar en**: **re-correr los mutantes viejos después de agregar guards nuevos**, no
  sólo los mutantes del cambio. Es la única forma de descubrir que un test dejó de
  probar lo que probaba, porque su código no cambió y el diff no lo muestra. Acá lo
  cazó la campaña completa; una campaña "sólo de lo nuevo" lo habría dejado pasar.

---

### [2026-07-30 FIX-PACK it2 · MENOR-1] La cabecera prometía "NUNCA lanza" y había dos accesos sin proteger

- **Error**: `parsed.transaction.message.accountKeys` era el único acceso encadenado sin
  protección del archivo. Con `transaction` o `message` ausentes tiraba `TypeError`
  (probado), y como la ruta no envuelve la llamada, salía **500 en vez de 503** y sin el
  evento durable que AC-6 exige.
- **Causa raíz**: el módulo se defiende de `owner`, `confirmationStatus`, `pre/post` y
  `accountKeys[i]` ausentes — o sea que la defensa no fue una política, fue una lista de
  campos que se me ocurrieron. Y la cabecera declaraba la promesa completa igual.
- **Fix**: se cerró (no se bajó la promesa): sin `accountKeys` no hay match de dirección
  ⇒ UNKNOWN. Test con las cuatro formas rotas.
- **Aplicar en**: cuando una cabecera promete una propiedad TOTAL ("nunca lanza",
  "siempre devuelve"), esa propiedad necesita un test que la ejerza sobre la forma
  DEGENERADA del input, no sobre la típica. Si no, la promesa es aspiracional.

---

### [2026-07-30 FIX-PACK it3 · BLQ-BAJO-1] Escribí el guard contra el `??` usando un `??`

- **Error**: el invariante de conservación que agregué en it2 comparaba
  `delta <= totalSourceDrop`, y `totalSourceDrop` salía de `postByIndex.get(idx) ?? 0n`:
  **una fila ausente en `post` se leía como "esa cuenta se drenó entera" e INFLABA EL
  TECHO**. O sea que el único insumo del guard usaba exactamente el patrón que el resto
  del fix-pack declara prohibido, tres pantallas más arriba, con mi propia firma.
  Reproducido por el re-AR: con `pre` sin la fila de nuestra ATA **y** `post` sin la fila
  de la cuenta que "pagó", `{ok:true, amountUsd:"1001"}`. **Una truncación de listas
  produce las dos ausencias de una sola vez**, así que no hacía falta un atacante.
- **Causa raíz**: apliqué la regla nueva ("una ausencia no es un cero medido") a los
  datos que estaba auditando y no al código que escribí para auditarlos. La forma del
  error es *el guard se exime de la regla que impone*. Y había una pista que ignoré:
  el techo era **de un solo lado**, así que una ausencia podía compensar a la otra —
  ninguna medición que se pueda inflar desde afuera sirve como límite.
- **Fix**: se reemplazó el techo por una **igualdad de los dos lados**: sobre las
  entradas del mint, `subió total == bajó total`. Una fila que falta en `pre` produce una
  subida sin bajada; una que falta en `post`, una bajada sin subida. **Ninguna ausencia
  puede pagar por la otra.** El `?? 0n` que queda es ahora la definición SIMETRICA de
  los dos únicos casos reales de ausencia (cuenta creada = valía 0 antes; cuenta cerrada
  = vale 0 después), y el `?? 0n` del loop de atribución cambió de rol: ya no alimenta
  ningún techo —la conservación ya corrió— y su modo de falla pasó a ser fail-CLOSED
  (un candidato de más ⇒ `DEPOSITOR_AMBIGUOUS`).
- **Y se corrigió una afirmación mía que el re-AR falsificó**: el comentario decía que el
  invariante "caza formas de corrupción que no se pueden enumerar". No: caza **una**
  propiedad, enunciable y falsable. Un guard no puede prometer más de lo que su fórmula
  sostiene — que es, literalmente, la tesis de esta HU aplicada a mí.
- **Supuesto ahora DECLARADO**: el mint es SPL clásico, sin transfer-fee ni mint/burn en
  el camino del depositante. Con Token-2022 y fee, `bajó > subió` en una tx legítima y
  este guard la rechazaría (fail-closed, visible, revisitable) — pero se escribe ahora,
  no se descubre después.
- **Aplicar en**: (a) después de escribir un guard, **releerlo con la regla que el guard
  impone** — el código de auditoría no está exento de la política que audita; (b) todo
  límite (techo/piso) tiene que calcularse sobre datos que el escenario adverso no pueda
  inflar; si puede, no es un límite: es una sugerencia; (c) preferir **igualdades de dos
  lados** a desigualdades de uno cuando el dato puede faltar de los dos.

---

### [2026-07-30 FIX-PACK it3 · MNR-3] Contar mutantes muertos OCULTA que un test perdió su poder

- **Error**: el test del lado POST de BLQ-MED-1 se desafiló solo, igual que el de PRE en
  it2 — pero esta vez **la campaña siguió reportando 100% KILLED**. El mutante que ese
  test vigila (restaurar el `continue`) también lo mata el test del lado PRE, así que la
  muerte estaba "cubierta" y el desafilado quedó invisible.
- **Causa raíz**: al agregar el guard de `delta < 0n`, el mutante sobre ese fixture pasó
  a producir un delta negativo y a morir en **el guard nuevo**, cuyo veredicto —UNKNOWN,
  no `RECIPIENT_MISMATCH`— satisface las tres aserciones del test. Y la métrica de la
  campaña es *por mutante*, no *por test*: **atribuye la muerte a la suite, no al test
  que la nombra**, así que un test puede volverse vacuo sin mover un solo número.
- **Fix**: la misma conjunción de dos needles que en it2, ahora también en el test del
  lado POST, con la explicación al lado.
- **Aplicar en**: cuando dos tests vigilan el MISMO mutante, la campaña deja de ser
  evidencia sobre cada uno. Para un guard de dinero, **el test tiene que identificar por
  cuál CAMINO murió** (needle sobre el detalle), no sólo el veredicto — es lo único que
  distingue "este test sigue probando lo suyo" de "otro test lo está tapando". Y el
  corolario incómodo: **un 100% de mutación no es prueba de que ningún test se desafiló**.

---

### [2026-07-30 FIX-PACK it3 · el hueco que encontró la campaña, no la revisión]

- **Error**: `balancesByIndex` —el loop del invariante nuevo— se saltaba con `continue`
  las entradas del mint con `amount` ilegible. Los tests de BLQ-MED-1 no lo cubrían
  porque ponen el dato ilegible en NUESTRA ATA, donde el guard del delta responde
  primero: el loop de conservación nunca se ejercitaba con un dato roto.
- **Causa raíz**: escribí el guard nuevo y **no le apliqué la lección de BLQ-MED-1** (un
  dato ilegible en una entrada relevante es indeterminación, no cero). Con `continue`,
  los totales cuadraban **por omisión**: una suma a la que le falta un sumando da
  "balanceada" con la misma facilidad con la que da cualquier otra cosa.
- **Fix**: `return null` ⇒ UNKNOWN, y el test que faltaba: el `amount` ilegible en una
  cuenta **de terceros** del mismo mint, que es la única forma de llegar a ese loop con
  un dato roto.
- **Aplicar en**: al agregar un loop que recorre los MISMOS datos que otro ya validado,
  no asumir que la validación de aquél lo cubre: **cubre su subconjunto**. Y cuando la
  campaña marca un sobreviviente en código recién escrito, casi siempre es una lección
  vieja que no se aplicó al código nuevo.

---

### [2026-07-30 FIX-PACK it4 · LA LECCION QUE VALE MAS QUE LAS OTRAS JUNTAS] Tres iteraciones arreglando síntomas de un defecto de ESTRUCTURA

- **El síntoma, cuatro veces idéntico**: `{"ok":true,"amountUsd":"1001"}` para un depósito
  de 1 USDC. Cada iteración cerró el caso que le mostraron y la siguiente revisión
  encontró otro camino al **mismo resultado literal**. Tres guards nuevos, tres veces
  verde, tres veces incompleto.
- **La causa raíz, que no era ninguno de los cuatro casos**: `delta` se **calculaba** por
  un camino (suma POR ENTRADA de las filas que matcheaban nuestra ATA) y se **auditaba**
  por otro (agregación POR INDICE, "gana la última", sobre todas las filas del mint), y
  **los dos números nunca se comparaban entre sí**. Dos agregaciones paralelas con reglas
  distintas no se restringen: cada una puede estar bien y el par, mal. Por eso cada fix
  entraba *al lado* del cálculo en vez de cerrar *sobre* él.
- **La señal que estuvo ahí todo el tiempo y no leí**: los repros no se parecían entre sí
  (dato ilegible, lista ausente, fila ausente, dos filas ausentes) pero el RESULTADO era
  siempre el mismo string. **Cuando distintas causas producen la misma salida exacta, la
  causa común no está en ninguna de ellas: está en la estructura que las convierte a
  todas en ese número.** Un patrón de repetición en los síntomas es evidencia sobre el
  DISEÑO, no una lista de casos por tapar.
- **El fix (estructural, no un cuarto guard)**: una sola **tabla canónica** por lista
  (índice → monto del mint), construida con reglas fail-closed —índice duplicado
  RECHAZA, monto ilegible RECHAZA—, y **todo** derivado de ella: el delta que se acredita
  y la ecuación que lo audita, `delta === baja neta de las demás cuentas`, cuyo lado
  izquierdo **es** el crédito y cuyo lado derecho sale de filas disjuntas de la misma
  tabla. Más una regla de presencia: **nuestra ATA aparece en las dos listas o en
  ninguna**, porque el saldo previo de la cuenta que recibe el dinero es el único dato
  que no admite default.
- **Por qué esto sí cumple el criterio y los otros tres no**: con `delta` fijado por filas
  que TIENEN que estar presentes, cualquier incoherencia restante sólo puede mover el
  lado derecho de la ecuación, y moverlo produce desigualdad ⇒ `UNKNOWN`. **Toda
  incoherencia es fail-CLOSED por construcción**: puede negar un crédito, nunca inflarlo.
  Es una propiedad de la forma del código, no la unión de los casos que se me ocurrieron.
- **Y el detalle que retrata todo**: con "gana la última", **invertir el orden de dos
  renglones cambiaba el veredicto** de `ok:true` a `UNKNOWN`. Un resultado que depende de
  la POSICION de una fila no es una medición. Ahora hay un test que corre los dos órdenes
  y exige respuestas byte-idénticas.
- **Aplicar en**: (a) si una revisión encuentra el MISMO resultado por un camino nuevo
  después de un fix, **parar de parchear y mirar la estructura** — el tercer repro ya era
  suficiente evidencia y yo seguí agregando guards; (b) un valor de dinero debe tener
  **una sola derivación**, y lo que lo audita tiene que consumir ESE valor, no
  recalcularlo por otra vía; (c) ante datos con forma de tabla, **canonizar primero y
  decidir después**: validar mientras se recorre reparte la misma decisión en N lugares
  que pueden divergir; (d) frente a un dato contradictorio (dos filas para la misma
  cuenta), **rechazar es más barato y más honesto que desempatar** — un desempate es una
  decisión arbitraria escondida en el código.

---

### [2026-07-30 FIX-PACK it4 · BLQ-BAJO-2] Enuncié una regla y la apliqué a un solo caso

- **Error**: en it3 escribí que *"un veredicto de indeterminación precede a cualquier
  veredicto medido derivado de los mismos datos posiblemente incompletos"* y la apliqué
  **sólo a `DEPOSITOR_AMBIGUOUS`**, dejando `RECIPIENT_MISMATCH` —que sale de las mismas
  listas— corriendo antes. Con las filas de nuestra ATA truncadas, contestaba con un 400
  definitivo que la plata fue a otra cuenta, **con un `detail` idéntico** al del destino
  genuinamente equivocado y **sin el evento durable** (la ruta sólo lo emite para
  `UNKNOWN`). Alguien cuya plata sí llegó recibía una negativa definitiva y sin rastro.
- **Causa raíz**: enuncié la regla mientras arreglaba UN caso, así que la escribí como
  general y la implementé como local. Una regla que se formula en el momento de aplicarla
  tiende a nacer con el alcance del ejemplo que la motivó.
- **Fix**: la ecuación corre antes de los dos veredictos medidos. Los casos se separan
  solos: destino equivocado real ⇒ las listas cuadran ⇒ el 400 es una medición; filas
  truncadas ⇒ la ecuación falla ⇒ 503 con evento durable. Y hay un test que exige que los
  dos `detail` sean DISTINTOS, porque ser indistinguibles era la mitad del daño.
- **Aplicar en**: cuando escribas una regla general en un comentario, **buscá en el
  mismo archivo todos los sitios que caen bajo ella antes de cerrar** — `grep` de los
  otros `return` del mismo tipo cuesta un minuto. Si no, la regla queda como documentación
  de una excepción.

---

### [2026-07-30 FIX-PACK it5 · LA CAUSA RAIZ DE LAS CINCO ITERACIONES] El sobre-anuncio apaga las revisiones

- **Error**: en cada iteración escribí una **propiedad universal** que la fórmula no
  sostenía. La de it4 —*"cualquier fila ausente de otra cuenta sólo puede mover el lado
  DERECHO, y moverlo produce desigualdad"*— es falsa en un paso: mover el lado derecho
  también puede **RESTAURAR** la igualdad contra un izquierdo ya inflado. El revisor lo
  falsificó con tres contraejemplos ejecutados (CE1, CE2, X1).
- **Causa raíz, y es la que explica las cinco vueltas**: una afirmación universal en un
  comentario **no es documentación, es una instrucción de dejar de buscar**. Yo la
  escribía, el revisor la leía, y los dos dejábamos de mirar en esa dirección. El daño no
  fue el bug: fue que la frase **protegió al bug de ser encontrado**. Por eso cada
  iteración cerró un caso y no la familia.
- **Fix**: toda afirmación del archivo se reescribió a su forma falsable, con el criterio
  explícito: **si no puedo nombrar el input concreto que la rompería, la frase dice de
  más**. La garantía quedó: *ninguna incoherencia de PRESENCIA, DUPLICACION,
  ILEGIBILIDAD o IDENTIDAD de filas puede inflar el crédito* — cuatro clases, cada una
  con guard y test con nombre. Y se escribió el **límite** que antes se omitía: un
  dataset internamente COHERENTE pero falso es indistinguible de un depósito legítimo
  por cualquier chequeo local, así que la versión universal de la frase **nunca podrá ser
  verdadera** contra un RPC que miente; lo que acota ese riesgo es la confianza en el
  endpoint, y eso no vive en este archivo.
- **Aplicar en**: (a) un comentario que dice "cualquier / ninguno / siempre" sobre un
  guard de dinero necesita, al lado, **el input que lo rompería si fuera falso**; si no
  se puede escribir, la frase se baja a lo demostrable; (b) escribir el LIMITE junto a la
  garantía no es debilidad — es lo que mantiene a la revisión buscando donde todavía hay
  algo; (c) la prosa de un money-path se revisa con el mismo rigor que su código, porque
  **una frase de más cuesta iteraciones enteras**.

---

### [2026-07-30 FIX-PACK it5 · BLQ-ALTO-1] Indexé por la etiqueta y no por la identidad

- **Error**: la tabla canónica se indexaba por `accountIndex`, pero lo que identifica una
  cuenta es su **dirección**. Mi propia premisa para rechazar el índice repetido —"un
  mensaje no puede listar la misma cuenta dos veces"— se viola igual en su forma de
  dirección, y ahí no rechazaba. Peor: `isOurAta` consultaba el `owner` para decidir si
  una fila era nuestra, así que **mentir el `owner` de una de dos filas con la misma
  dirección** mandaba una a la cubeta "nuestra" y la otra a "las demás", donde financiaba
  el crédito (X1 ⇒ 1001 USDC por un depósito de 1).
- **Causa raíz**: elegí como clave el campo con el que venían escritas las filas en vez
  del que define la cosa. Y dejé que un campo **controlado por el emisor del dato**
  decidiera en qué cubeta cae una fila, que es entregarle el árbitro al que puede mentir.
- **Fix**: la tabla se indexa por dirección (las dos formas del duplicado caen en la misma
  regla, y sin consultar el `owner`), y un `owner` declarado que contradice la derivación
  de la ATA pasa de "no es la nuestra" a **contradicción del dataset ⇒ UNKNOWN**.
- **Aplicar en**: la clave de una tabla canónica tiene que ser **la identidad del objeto**,
  no la etiqueta con la que llegó. Y ningún campo que el emisor controle puede decidir la
  CLASIFICACION de un dato en un guard de dinero: sólo puede confirmarla o contradecirla.

---

### [2026-07-30 FIX-PACK it5 · BLQ-ALTO-2] Tercera vez: enuncié una regla y la apliqué a un solo caso

- **Error**: en it4 escribí la regla de presencia bilateral —una cuenta aparece en las dos
  listas o en ninguna— y la apliqué **sólo a NUESTRA fila**. Para las demás quedó un
  `?? 0n` que dejaba a una fila de un solo lado aportar valor sin límite: con eso, una
  fila que sólo existe en `pre` financiaba un `delta` inflado y **la igualdad cerraba**
  (CE1).
- **Causa raíz, y es un patrón mío ya documentado dos veces**: enuncio la regla mientras
  arreglo un caso, así que nace con el alcance del ejemplo. Es la tercera aparición
  (MNR-4 en it3, BLQ-BAJO-2 en it4, ésta). **Que se repita tres veces significa que no
  alcanza con "acordarse": necesita un paso mecánico.**
- **Fix**: presencia bilateral para TODA fila del mint, con el costo medido y declarado
  (transfer+close del depositante y creación de una ATA de terceros del mismo mint pasan
  a 503; crear/cerrar cuentas de OTROS mints no se ve afectado). Y desapareció el último
  `?? 0n` del camino de dinero.
- **PASO MECANICO QUE ADOPTO** (por la reincidencia): al cerrar una iteración, por cada
  regla nueva escrita en un comentario, **grepear el archivo por el patrón que la regla
  gobierna** (`?? 0n`, `.get(`, cada `return` del mismo tipo) y dejar anotado en el commit
  cuántos sitios se revisaron. Una regla sin ese conteo se considera aplicada a un caso.
- **Aplicar en**: cualquier regla enunciada como general — el alcance se verifica con un
  grep, no con la intención de quien la escribió.
