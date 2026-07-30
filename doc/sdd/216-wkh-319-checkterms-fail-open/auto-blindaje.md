# Auto-Blindaje — WKH-319

Errores cometidos DURANTE la implementación y cómo se corrigieron. No es un
resumen de la HU: es lo que protege a la próxima del mismo tropiezo.

---

### [2026-07-30 12:05] Wave 1 — Escribí un comentario que JUSTIFICABA un fail-open, y el AC me daba la razón

- **Error**: dejé viva **la sexta forma del mismo bug que la HU existe para
  cerrar**. Una entrada de balance sin `owner` no entra a ninguno de los dos
  mapas, así que además de no sumar es **invisible para el guard de simetría**; y
  yo permitía `match` con entradas sin clasificar de **cualquier lado**, apoyado
  en un comentario que decía *"medir de menos no puede volver verdadero un `>=`
  que era falso"*. Esa frase es cierta para `post` y **falsa para `pre`**: ahí no
  medir achica `preSum` y por lo tanto **agranda** el delta. Repro: `payTo` baja
  de 100 USDC a 3 y el sistema devolvía `match` ⇒ `landed_ok` ⇒ `success:true`.
- **Causa raíz**: razoné la asimetría **una sola vez y la apliqué a los dos
  lados**. Peor: escribí el razonamiento como comentario afirmativo, y un
  comentario seguro de sí mismo es lo que hace que el próximo lector no vuelva a
  revisar la cuenta. Y `owner` es **opcional en el esquema**, así que el input
  que lo dispara no es exótico: es un campo que el RPC puede omitir.
- **Fix**: contador partido por lado (`unclassifiablePre` / `unclassifiablePost`).
  `match` exige `pre` limpio; `mismatch` exige los dos, porque una entrada
  anónima en `pre` podría esconder un delta **negativo** y saltearse ese guard.
  T-319-7c lo clava **con su control**: la misma forma con `owner` declarado ya
  se cazaba.
- **Aplicar en**: **cuando un guard trata dos lados de una resta, la propiedad
  hay que demostrarla DOS VECES, una por lado.** `pre` y `post`, débito y
  crédito, entrada y salida: el signo invierte la conclusión y la intuición no
  avisa. Y si un dato no se puede clasificar, preguntarse **de qué lado cae** —
  no alcanza con contar cuántos hay.

---

### [2026-07-30 12:05] Wave 1 — El AC decía lo mismo que mi comentario, y eso NO es verificación

- **Error**: mi implementación **cumplía AC-7 al pie de la letra**. El AC
  (`work-item.md`) y el SDD (§4.6) afirmaban exactamente la misma frase
  equivocada. Si me hubiera limitado a "ajustarme al AC" —que es literalmente lo
  que este rol tiene prohibido desviar— **el fail-open se quedaba**.
- **Causa raíz**: los tres artefactos (SDD, AC, código) decían lo mismo porque
  **el segundo y el tercero se derivaron del primero**. Tres copias de un
  razonamiento no son tres verificaciones: son **una sola, contada tres veces**.
  Es la versión documental del guard que se compara consigo mismo.
- **Fix**: se corrigieron **el AC y el SDD además del código**, cada uno con el
  input concreto que los rompe, y marcados como enmienda de F3 con su autor. Un
  AC que describía el bug no se puede dejar en pie: el F4 lo validaría como PASS.
- **Aplicar en**: **un AC no es evidencia de que el diseño sea correcto — es
  evidencia de qué se decidió.** Ante un hallazgo que el AC bendice, la salida
  NO es cumplir el AC: es escalar y corregir el AC. Y la prueba de una propiedad
  de dinero tiene que ser **ejecutada contra un input**, nunca "está escrito en
  tres lugares".

---

### [2026-07-30 13:05] Wave 1 — Muté las ramas del guard, no el predicado que las sostiene

- **Error**: mi campaña de mutación tenía 21 mutantes muertos y aun así **dejó vivo
  el que importaba**. Lo encontró el re-AR: sacarle `&& b.owner.length > 0` a
  `declaredOwner` **compila** y **sobrevivía la suite entera de 4333 tests**. Con
  esa línea mutada, un `owner: ''` deja de dar `null`, devuelve `''`, no iguala a
  `payTo` y la entrada **se descarta en silencio** — ni contada como no
  clasificable, ni vista por el guard de simetría. **La sexta forma del fail-open,
  reabierta borrando cuatro tokens.**
- **Causa raíz**: muté las **ramas del veredicto** (las que escribí pensando en el
  ataque: `match`, `mismatch`, delta negativo, completitud) y no muté los
  **predicados auxiliares** de los que esas ramas dependen. `declaredOwner` parecía
  un helper de lectura, no un guard de dinero — pero es quien decide **por qué
  puerta** entra cada entrada, y por lo tanto quién habilita todo lo demás.
- **Fix**: `T-319-7c` recorre `['', 123, null, {}, [], true]` como `owner`, con el
  caso `''` explicado aparte por ser el único que `typeof === 'string'` acepta.
  Mutante **M25** agregado al inventario, verificado muerto **contra su test
  nombrado y contra la suite completa** (que es donde antes sobrevivía).
- **Aplicar en**: **un guard de dinero no está verificado hasta que se mutan sus
  PREDICADOS, no sólo sus ramas.** El inventario de mutantes se arma recorriendo
  las líneas de las que el guard *depende*, no las que el guard *escribe*. Un
  helper de una línea que devuelve `string | null` en un camino de dinero es un
  guard, aunque no lo parezca.

---

### [2026-07-30 13:05] Wave 1 — Escribí una premisa que me convenía y no la verifiqué

- **Error**: para justificar no adelantar el tier de dirección argumenté que
  `probeSettlementPresence` lee siempre transacciones **frescas**, así que la clase
  de input que omite `owner` (historia vieja servida desde almacenamiento de largo
  plazo) casi no aparecería. **Es falso para `settleAlreadyConfirmed`**, que corre
  en cada re-entrega del mismo `intentId` sobre una fila ya `confirmed` — o sea
  horas o días después, justo la ventana que yo decía que no ocurría.
- **Causa raíz**: verifiqué el argumento contra **dos** de los tres consumidores y
  generalicé. Y no es casual **cuál** de los cuatro argumentos salió mal: fue el
  único que afirmaba algo sobre el mundo (frecuencia esperada) en vez de sobre el
  código, y el que más convenía a la conclusión que ya había elegido.
- **Fix**: premisa marcada como corregida **sin borrarla** (para que se vea qué se
  creyó y por qué), y el gatillo de W2.1 pasa a ser una **señal de producción
  medible** —la aparición de `terms_unclassifiable_entry` en el log— en vez de mi
  estimación.
- **Aplicar en**: cuando una decisión se apoya en "esto casi no va a pasar",
  **enumerar los call-sites uno por uno** en vez de generalizar del que se tiene
  más fresco. Y si la afirmación es sobre frecuencia en producción, no cerrarla con
  una estimación: dejar una **métrica** que la falsifique sola.

---

### [2026-07-30 12:20] Wave 1 — Cerré el colapso un piso abajo y lo dejé vivo un piso arriba

- **Error**: hice que la indeterminación de términos viajara correctamente hasta
  el adapter… y ahí la tiré por la borda. `SETTLE_PRESENCE_UNKNOWN` y
  `SETTLE_IN_FLIGHT_UNRESOLVED` salían como `Error` pelado, así que
  `readSettleValueDisposition` devolvía `undefined` y `settleSolanaLeg` publicaba
  **`SETTLE_FAILED`** — que dispara **reembolso y/o re-envío del hop**. El
  adapter decía *"no pude comprobarlo"* y el leg le afirmaba al caller *"no se
  pagó"*: el bug sistémico del proyecto, dentro de la HU que existe para cerrarlo.
- **Causa raíz**: verifiqué el tercer valor **hasta el borde de mi archivo**. El
  mapeo a `SETTLE_FAILED` era pre-existente, así que no lo miré — pero mi HU
  **ensanchó enormemente el embudo** hacia esas dos ramas. Heredar una línea no
  es lo mismo que no ser responsable de ella cuando le multiplicás el tráfico.
- **Fix**: `FacilitatorSettleError(..., 'unknown')`, el patrón que
  `recoverConfirmedSettle` ya usaba bien 400 líneas abajo. El test importa el
  **clasificador real** (`readSettleValueDisposition`) y lo corre contra el
  **error real** del adapter — los tests de `downstream-payment` mockean el
  adapter Solana entero, que es exactamente por qué este seam no tenía cobertura.
- **Aplicar en**: **un valor nuevo se persigue hasta el consumidor que toma la
  decisión de dinero, no hasta el borde del archivo.** Y cuando dos suites se
  mockean mutuamente (el adapter mockea el leg, el leg mockea el adapter), el
  seam entre ambas **no lo prueba nadie**: hay que importar la función real de un
  lado y correrla contra el objeto real del otro.

---

### [2026-07-30 11:20] Wave 0 — Un `tsc --noEmit` VERDE sobre un worktree sin `node_modules`

- **Error**: corrí `npx tsc --noEmit` en `wt-319` y leí `TSC_EXIT=0` como
  "typecheck limpio". La salida real estaba llena de `TS2307 Cannot find module
  'vitest' / 'viem' / 'viem/chains'`: el worktree se había creado **sin instalar
  dependencias**, así que TypeScript no resolvía NADA. Un typecheck que no
  resuelve los módulos no verifica los tipos: verifica la sintaxis.
- **Causa raíz**: dos fallas encadenadas. (1) `git worktree add` no trae
  `node_modules`, y nada en el flujo lo recuerda. (2) El `$?` que leí era el
  **exit del último comando del pipe** (`tail`), no el de `tsc` — el pipe se
  come el código de salida real.
- **Fix**: `npm ci` en el worktree, y después `npx tsc --noEmit` **sin pipe**,
  leyendo el `$?` inmediato. Recién ahí el verde significa algo.
- **Aplicar en**: cualquier worktree nuevo (`wt-*`). **Antes de creerle a un
  typecheck o a una suite, verificar que `node_modules` existe.** Y nunca leer
  `$?` después de un pipe: el código de salida que importa queda tapado. Es la
  misma familia que el falso KILLED de 209 §M12 (un archivo que no colectó y
  reportó `no tests` con exit 0): **la herramienta contestó algo que no habla
  del código.**

---

### [2026-07-30 11:26] Wave 0 — `biome_exit=1` sobre un comando que nunca corrió

- **Error**: leí `biome_exit=1` como "el lint encontra errores" y estuve a punto
  de salir a buscar violaciones que no existían. El comando había fallado con
  `npm error Missing script: "@biomejs/biome"`: el hook de `rtk` reescribe
  `npx` a `npm`, y `npm @biomejs/biome` no es nada.
- **Causa raíz**: un exit code distinto de 0 tiene (al menos) dos causas —
  *"la herramienta corrió y encontró algo"* y *"la herramienta nunca corrió"*—
  y el número las colapsa. Exactamente el bug que esta HU arregla, aplicado a mi
  propia verificación.
- **Fix**: invocar el binario por path (`./node_modules/.bin/biome`) vía
  `rtk proxy`, y **leer la última línea de la salida** (`Checked N files`) antes
  que el exit code. Si no dice cuántos archivos revisó, no revisó nada.
- **Aplicar en**: toda verificación de esta corrida (tsc, biome, vitest). Un
  comando de verificación tiene que reportar **cuánto midió**, no sólo si salió
  bien. Un `Tests 0 passed` con exit 0 es una suite ausente, no una suite verde.

---

### [2026-07-30 11:35] Wave 1 — La batería nueva pasó ENTERA en la primera corrida

- **Error**: los 20+ tests de T-319 pasaron al primer intento contra el código
  ya arreglado. Estuve a punto de tomar ese verde como evidencia. **No lo es**:
  un test que nunca vio rojo no prueba que mida algo — puede estar afirmando una
  tautología, o no estar llegando al código que cree ejercitar.
- **Causa raíz**: escribí los tests DESPUÉS del fix (para el guard de dinero el
  orden correcto era al revés), así que ninguno tuvo su fase roja.
- **Fix**: campaña de mutación **antes de commitear**, con respaldo físico del
  fuente + `sha256sum` antes y después (`prohibido git checkout --` sobre
  trabajo sin commitear). 14/14 mutantes muertos, cada uno con el test nombrado
  que lo mató, y el hash del fuente volvió idéntico
  (`1789beac98dfdf…`). El script de mutación además **falla ruidoso** si el
  ancla del patch no es única y **rechaza el KILLED** si se colectaron 0 tests.
- **Aplicar en**: todo fix de dinero. **Un test que pasa a la primera contra el
  código arreglado no es evidencia hasta que un mutante lo pone en rojo.** Y la
  cobertura se mide sobre las LÍNEAS DE LOS GUARDS, no sobre el total del
  archivo: acá eso destapó 4 líneas nuevas que ningún test tocaba
  (`mint` no-string, `uiTokenAmount` no-objeto, `accountIndex` duplicado,
  requerido ilegible) — guards escritos que nadie ejercía. Un gate que nadie
  corre no es un gate (CD-7).

---

### [2026-07-30 11:12] Wave 1 — 10 tests en rojo por fixtures, y la tentación de aflojar el guard

- **Error**: ninguno, pero vale documentar el punto de decisión. Al terminar el
  cuerpo nuevo de `checkTerms`, 10 tests preexistentes se pusieron en rojo
  porque sus fixtures no traían `accountIndex`. El camino corto era relajar
  `isBalanceEntry` para que `accountIndex` fuera opcional.
- **Causa raíz**: las 6 fixtures modelaban una forma que **el RPC nunca manda**
  (`accountIndex` es obligatorio en el esquema del SDK) y usaban `amount:'0'` en
  `pre`, que es **la única forma donde el bug es indistinguible del
  comportamiento correcto**. Por eso la suite no podía ver el fail-open: pasaba
  por casualidad.
- **Fix**: se arreglaron **las fixtures**, no el guard (CD-10). Diff de
  `payment.test.ts`: sólo realismo, **cero aserciones aflojadas**. `T-IDM-18b`
  quedó verde **sin tocar su aserción**, que es la prueba de que no hubo
  sobre-corrección.
- **Aplicar en**: cuando un guard nuevo pone en rojo un test viejo, la primera
  hipótesis es que **el test estaba mal**, no el guard. Si al final de la HU un
  canario necesita cambiar su aserción, el arreglo se pasó.
