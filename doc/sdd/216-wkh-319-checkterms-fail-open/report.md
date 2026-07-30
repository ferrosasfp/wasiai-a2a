# Report — HU WKH-319 · Cerrar el fail-open de `checkTerms` en el camino de salida Solana

**Corte mínimo shippable: W0 + W1** (W2/W3 quedan explícitamente diferidos, ver más abajo).

| Campo | Valor |
|---|---|
| HU | **WKH-319** |
| Carpeta | `doc/sdd/216-wkh-319-checkterms-fail-open/` |
| Worktree | `~/.openclaw/workspace/wt-319` |
| Branch | `feat/216-wkh-319-checkterms-fail-open` |
| HEAD al cerrar | `d9bd2ef` |
| Veredictos | AR **APROBADO** · CR **APROBADO** · F4 **APROBADO** |
| Merge | **NO ejecutado desde acá** — lo decide el founder (cuatro HUs en vuelo, orden importa) |

---

## Qué resuelve, en llano

Cuando el servidor de Solana no devolvía la lista de saldos previos de una transacción
(`preTokenBalances`), el código dejaba de medir *cuánto se movió* y pasaba a medir *cuánto
tiene la cuenta*. Con eso, la firma de una transacción **ajena, donde el agente fue el que
pagó**, se certificaba como *"tu pago llegó bien"*.

El repro que lo retrata: una transacción donde el agente **gasta 100 dólares y no recibe
nada** salía como pago exitoso. Hoy es el test **T-319-1**
(`src/adapters/solana/intent-dedup.test.ts:1176-1188`): una tx donde `payTo` aparece **sólo en
`postTokenBalances`** (gastó, sin `pre`) contra `checkTerms` real —sin mockear la función bajo
prueba, vía `adapter.settle → settleAlreadyConfirmed → probeSettlementPresence →
checkTerms`— ahora da `indeterminate` / `terms_list_absent`, nunca `landed_ok`.

**Consecuencias que se cerraron:**

- Un pago firmado que no aterrizaba se marcaba `confirmed`, el agente **nunca cobraba**, y el
  reintento quedaba **clausurado** (`settleAlreadySigned`, el consumidor más grave de los
  cuatro).
- En el único punto donde el gateway audita a un tercero (`settleViaFacilitator`), ésta era la
  **única** verificación de que la plata se movió — único cruce del límite de confianza.
- Un delta negativo (dato incoherente para una tx que el propio gateway construye) salía como
  `mismatch` ⇒ condena permanente con salida manual (`SETTLE_CONFIRMED_BUT_UNVERIFIABLE`), en
  vez de indeterminación.

---

## Pipeline ejecutado

- **F0/F1 — retroactivo.** La HU arrancó sin `work-item.md`: el encargo llegó con el hallazgo
  **ya trazado por ejecución** (tres probes reproducibles, `probe.ts`/`probe2.ts`/`probe3.ts`,
  fuera de `wt-319`) y el SDD lo adoptó como work item (`sdd.md` §2). El `work-item.md`
  (`06e5d91`, 2026-07-30) se escribió **después**, en paralelo con F3, para corregir el desvío
  de proceso — sin él, F4 no tenía criterios EARS que validar. El SDD verificó puntualmente los
  6 hechos de los que cuelga el diseño (V-1..V-6, `sdd.md` §0) y confirmó los seis.
- **F2 — `sdd.md`.** `SPEC_APPROVED` (`sdd.md:1120`: *"El SDD está listo para
  `SPEC_APPROVED`."*).
- **F2.5 — sin `story-file.md` separado.** Las waves (W0..W3) quedaron especificadas
  directamente en `sdd.md` §6, dado el carácter retroactivo de F1/F2. No bloqueó nada: F3 siguió
  las waves del SDD punto por punto y F4 verificó contra el `work-item.md` retroactivo.
- **F3 — implementación en 2 waves del corte mínimo** (`4dc410e` W0, `27f256f` W1) más **una
  tarea de W2 adelantada** (AC-29, cola de re-transmisión, ver abajo) **+ fix-pack AR** (`3a0cec8`,
  BLQ-1/BLQ-2) **+ fix-pack CR** (`fc66aa5`, MNR-A..G) **+ re-AR** (`bbcd3d8`, MNR-1/2/3).
- **AR: APROBADO**, tras resolver 2 BLOQUEANTEs:
  - **BLQ-1** — la sexta forma del fail-open: una entrada sin `owner` en `pre` **agrandaba** el
    delta en vez de achicarlo (el comentario original sólo era cierto para `post`). Repro
    ejecutado: `payTo` baja de 100 USDC a 3 y el sistema daba `match` ⇒ `landed_ok`.
  - **BLQ-2** — la indeterminación de términos viajaba correctamente hasta el adapter y ahí se
    perdía: `SETTLE_PRESENCE_UNKNOWN`/`SETTLE_IN_FLIGHT_UNRESOLVED` salían como `Error` pelado,
    `readSettleValueDisposition` devolvía `undefined`, y el leg publicaba `SETTLE_FAILED`
    (dispara reembolso/re-envío). El adapter decía *"no sé"* y el leg le afirmaba al caller
    *"no se pagó"* — el bug sistémico del proyecto, dentro de la HU que existe para cerrarlo.
- **CR: APROBADO**, tras 7 MENORes (MNR-A..G): trampa del sexto estado en la cola de
  re-transmisión cerrada y **adelantada de W2** (MNR-A); discriminador de la ATA in-tx
  corregido a lo que la fórmula sostiene, no a una dicotomía falsa (MNR-B); "NUNCA lanza"
  vuelto estructural con envoltorio y causa propia `probe_threw` (MNR-C); el mensaje de
  indeterminación deja de culpar al RPC cuando la cadena contestó bien (MNR-D); las 4
  desviaciones del inventario de `detail` declaradas por escrito (MNR-E); puntero muerto a
  `deposit-verifier.ts` corregido con path completo y aclaración de que el gemelo Solana vive
  sin mergear en `wt-315` (MNR-F); `payment.flag.test.ts` declarado en el scope del SDD
  (MNR-G).
- **Re-AR: 3 hallazgos MENOR** (`bbcd3d8`), todos de auto-blindaje del propio dev, no del AR
  externo — ver Auto-Blindaje abajo. Mutante **M25** (`declaredOwner` mutado) agregado y muerto,
  §4.6 corregido, premisa del argumento sobre el tier de dirección marcada como corregida sin
  borrar la original.
- **F4: APROBADO PARA DONE** (`validation.md`, HEAD `bbcd3d8`, 2026-07-30). Los cuatro números
  de runtime se corrieron **de cero en este F4**, no reusados del dev, y coinciden exactamente
  con los reportados en los commits.

---

## Acceptance Criteria — resultado final

**27/27 ACs en alcance del corte mínimo (W0+W1): PASS. 3/3 ACs de W2 (AC-8, AC-16, AC-30):
correctamente NO implementados, declarados como deferidos desde el work-item mismo (DT-11) —
no cuentan como FAIL.**

| AC | Status | Evidencia (archivo:línea + test) |
|----|--------|-----------------------------------|
| AC-1 | PASS | `payment.ts:1367-1372` (guard explícito, sin `?? []`) · T-319-1 (`intent-dedup.test.ts:1176`), T-319-1b (`:1190`) |
| AC-2 | PASS | mismo guard único sobre las dos listas · T-319-1b (`:1204`, `:1213`) |
| AC-3 | PASS | `payment.ts:1476-1481` (`terms_pre_row_missing`) · T-319-2 (`:1217`), T-319-3 (`:1236`), T-319-4 (`:1269`) |
| AC-4 `[SC]` | PASS | `payment.ts:1489-1494` (regla espejo `post`, `terms_post_row_missing`) · T-319-10 (`:1305`) |
| AC-5 `[SC]` | PASS | `payment.ts:1476` (`preBalances[i]===0` acredita) · T-319-9 (`:1287`), T-319-10 (`:1305`) |
| AC-6 | PASS | `payment.ts:1423-1428` (owner ausente → no clasificado, nunca descartado en silencio) · `declaredOwner` `payment.ts:254-256` · T-319-7b (`:1611`), T-319-7c (`:1642`) |
| AC-7 `[SC]` **enmendado** | PASS | Enmienda declarada en `work-item.md:111-138` (autor `nexus-dev`, F3, a pedido AR) + `sdd.md §4.6`. Código: `payment.ts:1515-1538` · T-319-7b/7c/7d (`:1611,1642,1708`) |
| AC-8 `[SC]` (W2) | DEFERIDO | No implementado por diseño (DT-11, `sdd.md:679-712`). Sin tier de dirección en `payment.ts` (verificado) |
| AC-9 | PASS | `payment.ts:230-233` (`ATOMIC_RE` + `atomicOf`) · T-319-6 (`:1384`) |
| AC-10 | PASS | `payment.ts:202-217` (`isBalanceEntry`) · T-319-5 (`:1348`), T-319-5b (`:1413`) |
| AC-11 | PASS | `payment.ts:1500-1510` (`terms_negative_delta`, antes del `< required`) · T-319-7 (`:1516`) |
| AC-12 | PASS | orden de guards `payment.ts:1500` antes de `:1515` |
| AC-13 `[SC]` | PASS | `payment.ts:1393-1445` (agregación por `accountIndex`, sin `.find()`) · T-319-8 (`:1531`), T-319-8b (`:1551`) |
| AC-14 | PASS | T-319-5/T-319-6, ninguna forma admitida por el esquema hace que `checkTerms` lance |
| AC-15 | PASS | `payment.ts:842-847` (`try` externo) · T-319-11 (`:1499`), T-319-11b (`:1803`, MNR-C) |
| AC-16 `[SC]` (W2) | DEFERIDO | Depende del tier de dirección (AC-8), no implementado |
| AC-17 `[SC]` | PASS | `payment.ts:1539-1542` (`mismatch` alcanzable) · T-319-12 (`:1593`) + T-IDM-18b verde **sin tocar su aserción** |
| AC-18 `[SC]` | PASS | camino feliz sin cambio de conducta · suite Solana 194/1 · T-319-8, T-319-9 |
| AC-19 `[SC]` | PASS | `payment.ts:1452-1495` (lectura perezosa) · `grep` de `preBalances/postBalances` en `payment.test.ts` = 0 |
| AC-20 `[SC]` | PASS | diff de fixtures sólo agrega `accountIndex`; 0 aserciones tocadas |
| AC-21 | PASS | `types.ts:257-269` (`SolanaTermsVerdict`, discriminante `verdict`, sin `ok`) · `tsc --noEmit` completo verde |
| AC-22 | PASS | `payment.ts:848-861` (`switch` exhaustivo, sin `default`) |
| AC-23 | PASS | `SettlementPresence` sin cambio de forma; `SolanaTermsVerdict` es bloque aditivo nuevo |
| AC-24 | PASS | `payment.ts:500,522-539` (`SETTLE_PRESENCE_UNKNOWN` transitorio) · T-319-13 (`:1733`) |
| AC-25 | PASS | `payment.ts:593,624-638` (`SETTLE_IN_FLIGHT_UNRESOLVED`, 0 `sendRawTransaction`) · T-319-14 (`:1753`) |
| AC-26 | PASS | `payment.ts:1190,1224-1248` (`FacilitatorSettleError(...,'unknown')` → `SETTLE_UNKNOWN`) · T-319-15 (`:1861`) |
| AC-27 | PASS | `payment.ts:962,1009-1020` (fila queda `signed` sin `recordConfirmedIntent`) · T-319-16 (`payment.flag.test.ts:392`) |
| AC-28 **actualizado F3** | PASS | inventario verificado por lectura directa del código; 4 desviaciones declaradas en `work-item.md:187-201` |
| AC-29 | PASS | `payment.ts:653-675` (lista blanca `{absent, landed_failed}` + `SETTLE_PRESENCE_UNHANDLED`, **adelantada de W2**) · T-319-18 (`:1828`) |
| AC-30 (W2) | DEFERIDO | No implementado, comentario explícito `payment.ts:1577-1579` |

**Runtime checks corridos de cero en F4** (no reusados del dev): `tsc --noEmit` exit 0 ·
`biome check src/` → 420 archivos, 0 fixes · `vitest run` → **4333 passed / 19 skipped** ·
`vitest run src/adapters/solana` → **194 passed / 1 skipped** · `git status` limpio.

---

## Hallazgos finales

- **BLOQUEANTEs**: 2 (BLQ-1, BLQ-2), ambos **resueltos** en `3a0cec8`, re-verificados en el re-AR.
- **MENORes**: 7 del CR (MNR-A..G, `fc66aa5`) + 3 del re-AR (MNR-1/2/3, `bbcd3d8`) —
  **todos resueltos**, ninguno diferido como deuda de backlog.
- No quedan hallazgos abiertos sin resolver en el alcance de esta corrida (W0+W1).
- 22/22 mutantes muertos por test nombrado a lo largo de toda la HU (14 de la campaña inicial +
  M13, M24 del fix-pack CR + M25 del re-AR), campaña con protocolo (respaldo físico + hash antes
  de mutar).

---

## Auto-Blindaje consolidado

*(Copia íntegra de `auto-blindaje.md`, 7 entradas, ninguna omitida.)*

### [2026-07-30 12:05] Wave 1 — Escribí un comentario que JUSTIFICABA un fail-open, y el AC me daba la razón

- **Error**: dejé viva **la sexta forma del mismo bug que la HU existe para cerrar**. Una
  entrada de balance sin `owner` no entra a ninguno de los dos mapas, así que además de no
  sumar es **invisible para el guard de simetría**; y yo permitía `match` con entradas sin
  clasificar de **cualquier lado**, apoyado en un comentario que decía *"medir de menos no
  puede volver verdadero un `>=` que era falso"*. Esa frase es cierta para `post` y **falsa
  para `pre`**: ahí no medir achica `preSum` y por lo tanto **agranda** el delta. Repro: `payTo`
  baja de 100 USDC a 3 y el sistema devolvía `match` ⇒ `landed_ok` ⇒ `success:true`.
- **Causa raíz**: razoné la asimetría **una sola vez y la apliqué a los dos lados**. Peor:
  escribí el razonamiento como comentario afirmativo, y un comentario seguro de sí mismo es lo
  que hace que el próximo lector no vuelva a revisar la cuenta. Y `owner` es **opcional en el
  esquema**, así que el input que lo dispara no es exótico: es un campo que el RPC puede omitir.
- **Fix**: contador partido por lado (`unclassifiablePre` / `unclassifiablePost`). `match`
  exige `pre` limpio; `mismatch` exige los dos, porque una entrada anónima en `pre` podría
  esconder un delta **negativo** y saltearse ese guard. T-319-7c lo clava **con su control**:
  la misma forma con `owner` declarado ya se cazaba.
- **Aplicar en**: **cuando un guard trata dos lados de una resta, la propiedad hay que
  demostrarla DOS VECES, una por lado.** `pre` y `post`, débito y crédito, entrada y salida: el
  signo invierte la conclusión y la intuición no avisa. Y si un dato no se puede clasificar,
  preguntarse **de qué lado cae** — no alcanza con contar cuántos hay.

### [2026-07-30 12:05] Wave 1 — El AC decía lo mismo que mi comentario, y eso NO es verificación

- **Error**: mi implementación **cumplía AC-7 al pie de la letra**. El AC (`work-item.md`) y el
  SDD (§4.6) afirmaban exactamente la misma frase equivocada. Si me hubiera limitado a
  "ajustarme al AC" —que es literalmente lo que este rol tiene prohibido desviar— **el
  fail-open se quedaba**.
- **Causa raíz**: los tres artefactos (SDD, AC, código) decían lo mismo porque **el segundo y
  el tercero se derivaron del primero**. Tres copias de un razonamiento no son tres
  verificaciones: son **una sola, contada tres veces**. Es la versión documental del guard que
  se compara consigo mismo.
- **Fix**: se corrigieron **el AC y el SDD además del código**, cada uno con el input concreto
  que los rompe, y marcados como enmienda de F3 con su autor. Un AC que describía el bug no se
  puede dejar en pie: el F4 lo validaría como PASS.
- **Aplicar en**: **un AC no es evidencia de que el diseño sea correcto — es evidencia de qué se
  decidió.** Ante un hallazgo que el AC bendice, la salida NO es cumplir el AC: es escalar y
  corregir el AC. Y la prueba de una propiedad de dinero tiene que ser **ejecutada contra un
  input**, nunca "está escrito en tres lugares".

### [2026-07-30 13:05] Wave 1 — Muté las ramas del guard, no el predicado que las sostiene

- **Error**: mi campaña de mutación tenía 21 mutantes muertos y aun así **dejó vivo el que
  importaba**. Lo encontró el re-AR: sacarle `&& b.owner.length > 0` a `declaredOwner`
  **compila** y **sobrevivía la suite entera de 4333 tests**. Con esa línea mutada, un
  `owner: ''` deja de dar `null`, devuelve `''`, no iguala a `payTo` y la entrada **se descarta
  en silencio** — ni contada como no clasificable, ni vista por el guard de simetría. **La
  sexta forma del fail-open, reabierta borrando cuatro tokens.**
- **Causa raíz**: muté las **ramas del veredicto** (las que escribí pensando en el ataque:
  `match`, `mismatch`, delta negativo, completitud) y no muté los **predicados auxiliares** de
  los que esas ramas dependen. `declaredOwner` parecía un helper de lectura, no un guard de
  dinero — pero es quien decide **por qué puerta** entra cada entrada, y por lo tanto quién
  habilita todo lo demás.
- **Fix**: `T-319-7c` recorre `['', 123, null, {}, [], true]` como `owner`, con el caso `''`
  explicado aparte por ser el único que `typeof === 'string'` acepta. Mutante **M25** agregado
  al inventario, verificado muerto **contra su test nombrado y contra la suite completa**
  (que es donde antes sobrevivía).
- **Aplicar en**: **un guard de dinero no está verificado hasta que se mutan sus PREDICADOS,
  no sólo sus ramas.** El inventario de mutantes se arma recorriendo las líneas de las que el
  guard *depende*, no las que el guard *escribe*. Un helper de una línea que devuelve
  `string | null` en un camino de dinero es un guard, aunque no lo parezca.

### [2026-07-30 13:05] Wave 1 — Escribí una premisa que me convenía y no la verifiqué

- **Error**: para justificar no adelantar el tier de dirección argumenté que
  `probeSettlementPresence` lee siempre transacciones **frescas**, así que la clase de input que
  omite `owner` (historia vieja servida desde almacenamiento de largo plazo) casi no aparecería.
  **Es falso para `settleAlreadyConfirmed`**, que corre en cada re-entrega del mismo `intentId`
  sobre una fila ya `confirmed` — o sea horas o días después, justo la ventana que yo decía que
  no ocurría.
- **Causa raíz**: verifiqué el argumento contra **dos** de los tres consumidores y generalicé. Y
  no es casual **cuál** de los cuatro argumentos salió mal: fue el único que afirmaba algo sobre
  el mundo (frecuencia esperada) en vez de sobre el código, y el que más convenía a la
  conclusión que ya había elegido.
- **Fix**: premisa marcada como corregida **sin borrarla** (para que se vea qué se creyó y por
  qué), y el gatillo de W2.1 pasa a ser una **señal de producción medible** —la aparición de
  `terms_unclassifiable_entry` en el log— en vez de mi estimación.
- **Aplicar en**: cuando una decisión se apoya en "esto casi no va a pasar", **enumerar los
  call-sites uno por uno** en vez de generalizar del que se tiene más fresco. Y si la afirmación
  es sobre frecuencia en producción, no cerrarla con una estimación: dejar una **métrica** que
  la falsifique sola.

### [2026-07-30 12:20] Wave 1 — Cerré el colapso un piso abajo y lo dejé vivo un piso arriba

- **Error**: hice que la indeterminación de términos viajara correctamente hasta el adapter… y
  ahí la tiré por la borda. `SETTLE_PRESENCE_UNKNOWN` y `SETTLE_IN_FLIGHT_UNRESOLVED` salían
  como `Error` pelado, así que `readSettleValueDisposition` devolvía `undefined` y
  `settleSolanaLeg` publicaba **`SETTLE_FAILED`** — que dispara **reembolso y/o re-envío del
  hop**. El adapter decía *"no pude comprobarlo"* y el leg le afirmaba al caller *"no se pagó"*:
  el bug sistémico del proyecto, dentro de la HU que existe para cerrarlo.
- **Causa raíz**: verifiqué el tercer valor **hasta el borde de mi archivo**. El mapeo a
  `SETTLE_FAILED` era pre-existente, así que no lo miré — pero mi HU **ensanchó enormemente el
  embudo** hacia esas dos ramas. Heredar una línea no es lo mismo que no ser responsable de ella
  cuando le multiplicás el tráfico.
- **Fix**: `FacilitatorSettleError(..., 'unknown')`, el patrón que `recoverConfirmedSettle` ya
  usaba bien 400 líneas abajo. El test importa el **clasificador real**
  (`readSettleValueDisposition`) y lo corre contra el **error real** del adapter — los tests de
  `downstream-payment` mockean el adapter Solana entero, que es exactamente por qué este seam no
  tenía cobertura.
- **Aplicar en**: **un valor nuevo se persigue hasta el consumidor que toma la decisión de
  dinero, no hasta el borde del archivo.** Y cuando dos suites se mockean mutuamente (el adapter
  mockea el leg, el leg mockea el adapter), el seam entre ambas **no lo prueba nadie**: hay que
  importar la función real de un lado y correrla contra el objeto real del otro.

### [2026-07-30 11:20] Wave 0 — Un `tsc --noEmit` VERDE sobre un worktree sin `node_modules`

- **Error**: corrí `npx tsc --noEmit` en `wt-319` y leí `TSC_EXIT=0` como "typecheck limpio". La
  salida real estaba llena de `TS2307 Cannot find module 'vitest' / 'viem' / 'viem/chains'`: el
  worktree se había creado **sin instalar dependencias**, así que TypeScript no resolvía NADA.
  Un typecheck que no resuelve los módulos no verifica los tipos: verifica la sintaxis.
- **Causa raíz**: dos fallas encadenadas. (1) `git worktree add` no trae `node_modules`, y nada
  en el flujo lo recuerda. (2) El `$?` que leí era el **exit del último comando del pipe**
  (`tail`), no el de `tsc` — el pipe se come el código de salida real.
- **Fix**: `npm ci` en el worktree, y después `npx tsc --noEmit` **sin pipe**, leyendo el `$?`
  inmediato. Recién ahí el verde significa algo.
- **Aplicar en**: cualquier worktree nuevo (`wt-*`). **Antes de creerle a un typecheck o a una
  suite, verificar que `node_modules` existe.** Y nunca leer `$?` después de un pipe: el código
  de salida que importa queda tapado. Es la misma familia que el falso KILLED de 209 §M12 (un
  archivo que no colectó y reportó `no tests` con exit 0): **la herramienta contestó algo que
  no habla del código.**

### [2026-07-30 11:26] Wave 0 — `biome_exit=1` sobre un comando que nunca corrió

- **Error**: leí `biome_exit=1` como "el lint encontró errores" y estuve a punto de salir a
  buscar violaciones que no existían. El comando había fallado con `npm error Missing script:
  "@biomejs/biome"`: el hook de `rtk` reescribe `npx` a `npm`, y `npm @biomejs/biome` no es
  nada.
- **Causa raíz**: un exit code distinto de 0 tiene (al menos) dos causas — *"la herramienta
  corrió y encontró algo"* y *"la herramienta nunca corrió"*— y el número las colapsa.
  Exactamente el bug que esta HU arregla, aplicado a mi propia verificación.
- **Fix**: invocar el binario por path (`./node_modules/.bin/biome`) vía `rtk proxy`, y **leer
  la última línea de la salida** (`Checked N files`) antes que el exit code. Si no dice cuántos
  archivos revisó, no revisó nada.
- **Aplicar en**: toda verificación de esta corrida (tsc, biome, vitest). Un comando de
  verificación tiene que reportar **cuánto midió**, no sólo si salió bien. Un `Tests 0 passed`
  con exit 0 es una suite ausente, no una suite verde.

### [2026-07-30 11:35] Wave 1 — La batería nueva pasó ENTERA en la primera corrida

- **Error**: los 20+ tests de T-319 pasaron al primer intento contra el código ya arreglado.
  Estuve a punto de tomar ese verde como evidencia. **No lo es**: un test que nunca vio rojo no
  prueba que mida algo — puede estar afirmando una tautología, o no estar llegando al código
  que cree ejercitar.
- **Causa raíz**: escribí los tests DESPUÉS del fix (para el guard de dinero el orden correcto
  era al revés), así que ninguno tuvo su fase roja.
- **Fix**: campaña de mutación **antes de commitear**, con respaldo físico del fuente +
  `sha256sum` antes y después (`prohibido git checkout --` sobre trabajo sin commitear). 14/14
  mutantes muertos, cada uno con el test nombrado que lo mató, y el hash del fuente volvió
  idéntico (`1789beac98dfdf…`). El script de mutación además **falla ruidoso** si el ancla del
  patch no es única y **rechaza el KILLED** si se colectaron 0 tests.
- **Aplicar en**: todo fix de dinero. **Un test que pasa a la primera contra el código arreglado
  no es evidencia hasta que un mutante lo pone en rojo.** Y la cobertura se mide sobre las
  LÍNEAS DE LOS GUARDS, no sobre el total del archivo: acá eso destapó 4 líneas nuevas que
  ningún test tocaba (`mint` no-string, `uiTokenAmount` no-objeto, `accountIndex` duplicado,
  requerido ilegible) — guards escritos que nadie ejercía. Un gate que nadie corre no es un gate
  (CD-7).

### [2026-07-30 11:12] Wave 1 — 10 tests en rojo por fixtures, y la tentación de aflojar el guard

- **Error**: ninguno, pero vale documentar el punto de decisión. Al terminar el cuerpo nuevo de
  `checkTerms`, 10 tests preexistentes se pusieron en rojo porque sus fixtures no traían
  `accountIndex`. El camino corto era relajar `isBalanceEntry` para que `accountIndex` fuera
  opcional.
- **Causa raíz**: las 6 fixtures modelaban una forma que **el RPC nunca manda** (`accountIndex`
  es obligatorio en el esquema del SDK) y usaban `amount:'0'` en `pre`, que es **la única forma
  donde el bug es indistinguible del comportamiento correcto**. Por eso la suite no podía ver el
  fail-open: pasaba por casualidad.
- **Fix**: se arreglaron **las fixtures**, no el guard (CD-10). Diff de `payment.test.ts`: sólo
  realismo, **cero aserciones aflojadas**. `T-IDM-18b` quedó verde **sin tocar su aserción**,
  que es la prueba de que no hubo sobre-corrección.
- **Aplicar en**: cuando un guard nuevo pone en rojo un test viejo, la primera hipótesis es que
  **el test estaba mal**, no el guard. Si al final de la HU un canario necesita cambiar su
  aserción, el arreglo se pasó.

---

## Archivos modificados

`git diff --stat main...HEAD` (9 archivos, +3319/-40):

**Producción**

| Archivo | Cambio |
|---|---|
| `src/adapters/solana/payment.ts` | +474 / -~40 — `checkTerms` reescrito, `isBalanceEntry`/`atomicOf`/`declaredOwner`, mapeos de `probeSettlementPresence`/`verify()`, lista blanca de la cola de `settleAlreadySigned` (AC-29, adelantada) |
| `src/adapters/types.ts` | +62 — bloque aditivo `SolanaTermsVerdict`, `SettlementPresence` intocado |

**Tests**

| Archivo | Cambio |
|---|---|
| `src/adapters/solana/intent-dedup.test.ts` | +845 — batería T-319-1..18 + T-IDM-18b preservado |
| `src/adapters/solana/payment.test.ts` | +56/-40 — 6 fixtures corregidas (realismo, `accountIndex`), cero aserciones aflojadas |
| `src/adapters/solana/payment.flag.test.ts` | +42 — T-319-16 (declarado en `sdd.md:180`, fila 7b, MNR-G) |

**Documentación de la HU**

| Archivo | Cambio |
|---|---|
| `doc/sdd/216-wkh-319-checkterms-fail-open/work-item.md` | +457 (nuevo, retroactivo) |
| `doc/sdd/216-wkh-319-checkterms-fail-open/sdd.md` | +1120 (nuevo) |
| `doc/sdd/216-wkh-319-checkterms-fail-open/validation.md` | +89 (nuevo) |
| `doc/sdd/216-wkh-319-checkterms-fail-open/auto-blindaje.md` | +214 (nuevo) |

`_INDEX.md` del repo principal: **no tocado desde acá** (CD-16, diferido a W3.2 — este report
sólo actualiza el `_INDEX.md` dentro de `wt-319`).

---

## Decisiones diferidas a backlog

**W2 — Endurecimiento (paralelizable, tres tareas independientes de las de W0+W1):**

| Tarea | Qué | AC |
|---|---|---|
| W2.1 | Tier de dirección para el `owner` ausente (`expectedAta` + `addressAt`, envueltos) | AC-8, AC-16 |
| W2.2 | `verify()` ⇒ `indeterminate:true` en las dos negativas no medidas + corregir docstring caduco de `:1144-1156` | AC-30 |
| W2.3 | ~~Lista-blanca en `settleAlreadySigned`~~ **ya hecha, adelantada al corte en F3** (AC-29 ✅) | — |
| W2.4 | `creditedAtomic` en el log del `landed_ok` | — (TD-319-1) |

**El gatillo de W2.1 es una señal de producción medible, no una fecha.** La decisión de F3 fue
**no** adelantar el tier de dirección al corte mínimo: es una **ampliación** (unión), sólo
puede convertir `indeterminate` en `match`/`mismatch` — **no puede cerrar un fail-open, puede
abrirlo**. Mezclarlo con el commit que cierra el agujero le quitaría al revisor la posibilidad
de verificar el cierre por separado. El gatillo real: la aparición de
**`terms_unclassifiable_entry`** en el log de producción —sobre todo en la rama de
`settleAlreadyConfirmed`, que es la que lee historia vieja servida desde almacenamiento de
largo plazo— justifica adelantar W2.1. **Una sola ocurrencia alcanza**; cero ocurrencias
sostenidas la mantienen donde está.

**La incógnita honesta (NC-1 del work-item)**: nadie pudo determinar con qué frecuencia un RPC
real de producción omite `owner` en `preTokenBalances`. Delegado a la señal de arriba.

**El costo aceptado, explícito**: hasta W2.1, un pago real con `owner` ausente en `pre` sale
como `indeterminate`. Es fail-closed (no cuesta plata) pero **determinístico** — no se destraba
solo con reintentos —, y por eso el log ahora lo dice con todas las letras (MNR-D) y apunta al
runbook.

**W3 — Evidencia y cierre restante:**

| Tarea | Estado |
|---|---|
| W3.1 Campaña de mutación | ✅ hecha (22/22 muertos, incluyendo M25 del re-AR) |
| W3.2 Fila en `_INDEX.md` | Este report la agrega **sólo dentro de `wt-319`** — la del repo principal queda para quien mergee |
| W3.3 `auto-blindaje.md` | ✅ hecho |
| W3.4 Nota en `doc/sdd/212-wkh-314-.../` sobre la enmienda que su §7.1 va a necesitar | **Pendiente** — no ejecutable desde `wt-319` (CD-16 prohíbe tocar `wt-314`) |

**Deuda declarada (`work-item.md` §"Deuda declarada"):**

| ID | Qué | Estado |
|---|---|---|
| TD-319-1 | El recibo del leg (`settledAmount`, `nonEvmSettle.amountUsd`) usa el monto **pedido**, no el **medido** | HU aparte. `creditedAtomic` queda disponible y logueado |
| TD-319-2 | Cuatro primitivos (`ATOMIC_RE`, `isEntry`, `declaredOwner`, delta-negativo) quedan **transcritos**, no importados, en `payment.ts` y en el `deposit-verifier.ts` de Solana que trae WKH-315 | Se unifican cuando **WKH-314** promueva `presence.ts` |
| TD-INBOUND-MULTI-ATA | Parkeada por WKH-314 (su R-4/DT-8): el `.find()` que sólo miraba la primera cuenta | **Cerrada por esta HU** (AC-13, agregación por `accountIndex`) |

---

## Orden de merge — visible para quien decida

- **Esto tiene que ir ANTES que WKH-314** (x402 inbound). WKH-314 planea **mover**
  `probeSettlementPresence`/`checkTerms` a `src/adapters/solana/presence.ts`, con criterio de
  aceptación *"la suite del adapter queda verde **sin modificarse**"*. Ese criterio **no puede
  sobrevivir** a esta HU, que cambia 6 fixtures y la firma de la función. Si 319 va primero, 314
  extrae la función ya arreglada, y **`TD-INBOUND-MULTI-ATA` se cierra sin trabajo adicional**.
  WKH-314 va a necesitar una enmienda de una línea en su firma publicada
  (`checkSplTransferTerms(...): {ok:true}|{ok:false;error}` → `SolanaTermsVerdict`) — pendiente
  de dejar nota en `doc/sdd/212-wkh-314-.../` (W3.4, no ejecutable desde acá).
- **Roce con WKH-315**: sólo `src/adapters/types.ts`, donde las dos HUs agregan **bloques
  aditivos disjuntos al final**, y ninguna toca `SettlementPresence`. Conflicto de merge
  esperado: trivial (concatenar). El orden entre 319 y 315 es indistinto.
- **Nota para quien mergee**: cuando WKH-315 aterrice habrá **dos archivos llamados
  `deposit-verifier.ts`** — el existente en `src/adapters/deposit-verifier.ts` (rail EVM) y uno
  nuevo en `src/adapters/solana/deposit-verifier.ts` (rail Solana, transcribe los cuatro
  primitivos de esta HU, TD-319-2). Los comentarios de este código que apuntan a "los primitivos
  transcritos" (MNR-F) usan el **path completo** para no ambigüar cuál de los dos.
- **Sin roce**: WKH-313 (`wt-313`), WKH-316 (`wt-316`), WKH-318 (`wt-318`) — verificado con
  `git log main..HEAD` en cada worktree, ninguno toca `payment.ts` ni `adapters/types.ts`.

---

## Lecciones para próximas HUs

1. **Un tipo de dos valores fuerza el colapso.** `checkTerms` respondía con dos valores una
   pregunta de tres. Las cinco formas de lista, el delta negativo, el `''` que `BigInt`
   convierte en `0n` y el `.find()` eran maneras distintas de caer en el tercer valor que el
   tipo no tenía. Cuando una pregunta a un sistema externo puede fallar en no-preguntar,
   modelarla con un booleano garantiza que alguien la use como si el tercer estado no existiera.
2. **El renombre puede ser un mecanismo de migración, no sólo estilo.** `ok` → `verdict` se hizo
   **para que toda lectura vieja dejara de compilar**, obligando a revisitar cada call-site a
   mano. La trampa que se evitó a propósito: `ok: true | false | 'unknown'` habría sido **peor
   que el bug**, porque `if (terms.ok)` da `true` para `'unknown'` — un fail-open con forma de
   arreglo.
3. **Mutar sólo las ramas de un guard no alcanza — hay que mutar los predicados que las
   alimentan.** 21 mutantes muertos y aun así sobrevivió el que importaba, porque estaba en un
   helper de una línea (`declaredOwner`) que "parecía lectura" pero decidía por qué puerta
   entraba cada dato. El inventario de mutantes se arma recorriendo de qué depende el guard, no
   qué escribe.
4. **Un AC que describe el bug no es evidencia de que el diseño esté bien — el dev tiene que
   poder escalarlo y corregirlo, no sólo cumplirlo.** Cuando SDD, AC y código repiten la misma
   frase, no son tres verificaciones: es una sola, copiada tres veces. Y la mejor línea de
   auto-crítica de esta HU aplica más allá de este ticket: de cuatro argumentos que sostenían
   una decisión, falló el único que afirmaba algo sobre el mundo en vez de sobre el código —
   "no es casual cuál de los cuatro salió mal: era el que más convenía a la conclusión que ya
   había elegido".

---

**HEAD final**: `d9bd2ef` en `feat/216-wkh-319-checkterms-fail-open`. Working tree limpio.
Suite: 4333 passed / 19 skipped (completa) · 194 passed / 1 skipped (Solana). `tsc` exit 0.
`biome` 420 archivos limpio.
