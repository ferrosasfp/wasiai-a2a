# Code Review — WKH-316 · el escritor del bloque `payment`

> `nexus-adversary` · modo **CR** · 2026-08-19
> Rama `feat/214-wkh-316-payment-block` · HEAD `90cbbb6` · base `main` = `8242b16` · nada pusheado.
> Historia: F3 (6 commits) → AR-1 RECHAZADO → fix-pack #1 `e57af46` → re-AR RECHAZADO → fix-pack #2
> `3e61725` → reportes commiteados (`d546e29`, `90cbbb6`).

# VEREDICTO: **APROBADO**

Sin hedging: **el código quedó mantenible, no correcto-y-frágil.** Cero BLOQUEANTEs. 3 MENORes, todos de
prosa/inventario, ninguno en un camino de ejecución. Detalle y deuda abierta al final.

⛔ **No modifiqué código.** `git status --short` al cierre devuelve **una sola línea**, la del untracked
ajeno. HEAD sigue en `90cbbb6`.

---

# 0. Puertas declaradas — las verifiqué yo, una por una

| Puerta | Declarado | Medido por mí | ¿? |
|---|---|---|---|
| `vitest run` | 295 test files · 5750 passed · 19 skipped · 0 failed · exit 0 | `numTotalTests 5769` = **5750 passed + 19 pending**, `numFailedTests 0`, `numFailedTestSuites 0`, `success true`, **exit 0**; ficheros distintos en `testResults` = **295** | ✅ **exacto** |
| `tsc --noEmit` | exit 0 | `TSC_EXIT=0` | ✅ |
| `biome check src/` | `Checked 489 files`, exit 0 | `Checked 489 files in 158ms. No fixes applied.` · `BIOME_EXIT=0` medido **sin pipe** | ✅ |
| `src/routes/agents.ts` | md5 `fdb1fd726b17aa17d4296705738f7e62` | idéntico | ✅ |
| `doc/sdd/212-…/story-file.md` (untracked ajeno) | md5 `7904ef74a1c46d7880e0ca5d38e3eed4` | idéntico, **al abrir y al cerrar** | ✅ |

**Cero rojos**, así que no hubo que discriminar regresión de flake ajeno. El `split 289 passed | 6 skipped`
que el dev declaró no haber medido (punto 7.4) **sigue sin medirse**: el reporter JSON colapsa los 295 en
`numPassedTestSuites 1316` (cuenta bloques, no ficheros). Los totales que importan sí cierran.

**Item 7.2 del dev — cerrado por mí**: *"no re-corrí la suite completa después del último ajuste de prosa"*.
La corrí completa sobre `90cbbb6`: **exit 0**. Ese hueco ya no existe.

---

# 1. La pregunta central del CR: ¿mantenible, o correcto y frágil?

**Mantenible.** El juicio no es de estilo, es medido, y va en tres partes.

## 1.1 La distinción del fix-pack #2 SE SOSTIENE — y es más fuerte de lo que declara

Recontá las 28. **Mi conteo reconcilia exacto con el suyo**, y puedo nombrar las omisiones.

Barrido con los **tres** patrones (largo con directorio, largo sin directorio, corto entre backticks), sobre
los ficheros `src/`+`test/` del Scope IN:

| Fichero | Anclas |
|---|---|
| `src/lib/operator-address.ts` | 6 |
| `src/routes/agents.ownership.test.ts` | 5 |
| `src/routes/agents.publish.test.ts` | 6 |
| `src/routes/agents.ts` | 2 |
| `src/services/agent.payment.test.ts` | 1 |
| `src/services/agent.ts` | 1 |
| `src/types/index.ts` | 9 |
| `test/payment-guards-live-in-one-place.test.ts` | 2 |
| **subtotal** | **32** |
| (los 4 restantes: `operator-address.test.ts`, `payment-spec-writer.ts`, `payment-spec-writer.test.ts` = **0 anclas**) | — |

32 − 28 = **4**, y las 4 son identificables: `agents.ownership.test.ts:13` (`` `:72` ``, `` `:76-77` ``) y
`:25` (`` `:211` ``) = 3, más `types/index.ts:661` → `20260401000000_kite_registries.sql:44-66` = 1. **El 28
es correcto para el universo que el párrafo define.**

**Verifiqué las 19 una por una, abriendo el destino. Las 19 son ciertas**, y varias son del tipo más difícil
de acertar (la línea ES la firma):

- `operator-address.ts` (6/6): `solana/chain.ts:84` = `export function getSolanaOperatorKeypair(): Keypair {`
  (la firma) · `:95` = `log.info({ operator: operatorPubkey }, …)` · `:137-149` = el `if (depositPathOn && …)`
  que termina en `throw new Error(...)`, o sea la aserción WKH-315 **que lanza** · `:81-82` = *"NUNCA loguea
  el secret"* · `deposit-verifier.ts:167-175` = el patrón `OPERATOR_PRIVATE_KEY` → `privateKeyToAccount` →
  `return null`, idéntico al que el docblock dice copiar · `registry.ts:1-16` = los imports de top-level, y
  **son** sólo `lib/logger`, `chain-resolver` y tipos, que es exactamente lo que la prosa afirma.
- `agents.publish.test.ts` (6/6): `routes/agents.ts:220/237/252/459/475` = las cinco líneas
  `{ field: 'priceUsdc' | 'payoutWallet' | 'referrerRef' | 'enabled' | 'capabilities' }`, **las 5 clavadas** ·
  `forward-key.test.ts:204-232` = el pino-a-array.
- `agents.ownership.test.ts` (2/2): `agent.ts:808` = `if (existing.owner_ref !== ownerRef) {` ·
  `agent.ts:822` = `.eq('owner_ref', ownerRef)` del DELETE.
- `payment-guards-live-in-one-place.test.ts` (2/2): `routes/agents.ts:66` = el mensaje de auth que menciona
  `x402` · `:124` = el comentario con `getInitializedChainKeys()`. Las dos son las menciones **legítimas** que
  el test declara tener que ignorar.
- `routes/agents.ts` (1/1): `discovery-query.ts:219-229` = la deuda TD-322-4 de línea de log sin cota. La
  analogía que el comentario hace es **exacta**, no decorativa.
- `types/index.ts` (2/2): `payment-spec-reader.ts:212-213` = `resolvedChain: chainKey,` /
  `network: isMainnetChainKey(...)`, **los dos derivados que el tipo nombra** · `` `:203-225` `` = el docblock
  de `AgentPaymentSpec.contract`, `:203` = `/**` y `:225` = `*/`, o sea el bloque completo y nada más.

De las **9 pre-existentes**, confirmo **6 falsas / 3 exactas** (verifiqué las 4 escaladas en §2 abajo;
`types/index.ts:385 → agent.ts:399` está declarada en W4; la de `MNR-1` la arregló el fix-pack #2 a
`downstream-payment.ts:247` = `async function settleSolanaLeg(`, la firma, con el skip que la prosa afirma
en `:257-262`). Y las 3 exactas son exactas: `agent.ts:161 → discovery.ts:449` = literalmente
`allAgents = allAgents.filter((a) => a.status === 'active');`, el texto que la cita entrecomilla ·
`types/index.ts:207 → downstream-payment.ts:772` = `const payToCheck = validatePayTo(agent.payment.contract);` ·
`:246 → :711-735`.

⇒ **La conclusión del fix-pack #2 se sostiene, y lo digo explícitamente porque cambia el juicio sobre la HU**:
*el defecto de esta HU fue desplazar sin re-verificar, no escribir mal.* **Todo lo que esta HU escribió de
cero es cierto.** La HU no fue descuidada: heredó un problema del repo y lo midió hasta el fondo. Las 4
rondas no fueron 4 descuidos, fueron 2 puntos ciegos estructurales del barrido (cita corta / cita sin
directorio), y eso está diagnosticado con el mecanismo, no con una promesa.

**De hecho es 20/20, no 19/19** — ver `MNR-2`. Y sumando las 5 de `exceptions.ts` (`MNR-1`), esta HU
escribió o re-apuntó **25 anclas y las 25 son ciertas**. Verificadas por mí, no citadas del reporte.

## 1.2 ¿Es sostenible documentar invariantes de seguridad con punteros que nada verifica?

**No, y el entregable lo dice con esas palabras.** `auto-blindaje.md:689-693`:

> *"Eso **acota la tasa, no cierra el camino**: no hay ningún control que se ponga rojo, así que la garantía
> dura exactamente lo que dure la disciplina del que revisa, y una cita rota se descubre **cuando manda a
> alguien a la función equivocada**, no cuando se escribe."*

Eso es un acotamiento honesto, no un cierre disfrazado. Y `TD-316-CITAS-SIN-TESTIGO` **es ejecutable**, que
era la pregunta:

- **El diseño está nombrado y ya existe en el repo**: `CITED_INDEX_LINES` /
  `CitedIndexLine = { from, line, mustContain }` en `test/sdd-index-matches-folders.exceptions.ts:160-192`,
  con el control de universo **G-F2** (`test/sdd-index-matches-folders.test.ts:420`) y el control
  anti-vacuidad (`mustContain` a mano, *"una afirmación sobre el mundo, no una lectura del mundo"*).
- **El barrido correcto está escrito**: `command grep -n ':[0-9]\+' <archivo>` (todos los tokens) y clasificar
  a mano — con los **dos** puntos ciegos del patrón específico explicados (`auto-blindaje.md`, entrada del
  fix-pack #2, sección *"Causa raíz"*).
- **El conjunto de arranque está medido** (28, con su límite declarado).
- **Los 3 disparadores son observables** por alguien que no leyó la HU.
- **Y la regla operativa que corta la clase está escrita**: *"Una cita que vive en el nombre de un test es de
  máxima prioridad: se imprime en CI, la lee alguien que ya está debuggeando, y si miente lo manda a leer otra
  función."*

Alguien puede sentarse a ejecutar esa deuda sin volver a medir nada desde cero. Eso es lo que pedí y está.
Lo que **no** está completo es el conjunto de arranque → `MNR-1`.

## 1.3 El fix-pack #2 re-derivó bien incluso sus propias citas

Prueba de que la disciplina no fue teatro: al mover el medio de `auto-blindaje.md`, declaró que sus propias
anclas se corrían a `:223-234`, `:241`, `:250` y `:321`. **Las 4 son correctas en HEAD**: `:223` = la línea
*"Esta tabla se corrigió DOS veces…"*, `:234` = cierre del párrafo del universo, `:241` = la fila de
`agent.ownership.test.ts:6`, `:250` = la de `self-published-auth.ts:29`, `:321` = la celda del `:330`. Y
decidió **no** editar `ar-report-it2.md` porque es una medición congelada — criterio correcto.

También verifiqué las 3 pre-existentes desplazadas fuera de Scope IN que declaró, y **las 3 declaraciones son
exactas**: `self-published-auth.ts:29` → `routes/agents.ts:338` = `keyRow.owner_ref,` ✅ ·
`orchestrate.ts:1160` → `agent.ts:579` = `const { data, error } = await supabase` dentro de
`getBySlugAsAgent` (firma `:578`) ✅ · `discovery.ts:255` → `agent.ts:506-510` = el SELECT de `listAsAgents`
**sin `limit` ni cursor**, que es justo lo que la prosa afirma ✅ (número falso, afirmación cierta; CD-6
prohíbe tocarlo).

---

# 2. Las 4 citas pre-existentes escaladas y no arregladas — **verificadas, y dictamen**

Las abrí las 4. **Las 4 mediciones del dev son correctas**, incluida la peor.

| Cita | Qué afirma | Qué hay ahí en HEAD | Ancla real | ¿Dev acertó? |
|---|---|---|---|---|
| `src/routes/agents.ts:47` | *"helper privado de `registries.ts:35`"* | `src/routes/registries.ts:35` = `requireA2AKeyPresence,` — **un specifier de import** | `async function mapOwnershipError(` en `src/routes/registries.ts:94` | ✅ (y *"privado"* es cierto: `:94` no lleva `export`) |
| `src/types/index.ts:207` | *"`:777` lo firma como `to`"* | `downstream-payment.ts:777` = `contract: agent.payment.contract,` **dentro del `logger.warn` de la rama de RECHAZO** (`:776-781`) | `downstream-payment.ts:922` = `to: payToCheck.addr,` | ✅ — y el error es **semántico**, no sólo numérico: `:777` es el log del fallo, no la firma |
| `src/types/index.ts:510` | *"`'__anon__'` se EXCLUYE (`reputation.ts:182-183`)"* | `:182-183` = prosa (`"del atacante en 2 identidades reales…"` + línea vacía) | `src/services/reputation.ts:189` = `if (bucket !== ANON_CALLER_BUCKET) acc.failedCallers.add(bucket);` | ✅ |
| `src/types/index.ts:1450` | *"el guard `i>0` de `compose.ts:130`"* | `src/routes/compose.ts:130` = `type ComposeValidationError = ComposeStepShapeError;` · **`grep 'i > 0' src/routes/compose.ts` = 0** | `src/services/compose.ts:571` = `if (i > 0 && scopingKeyRow && chainId !== undefined) {` | ✅ — **el archivo citado también está mal**, confirmado |

## 2.1 Cerré el hueco que el dev declaró NO haber medido (su punto 7.5)

El dev declaró: *"no busqué si el mismo texto aparece en otro lado del archivo destino"* — y el brief lo marca
como el mecanismo de auto-confirmación de las 4 rondas. **Lo medí**: los 4 anclas de reemplazo son
**unívocos** en su archivo destino.

- `to: payToCheck.addr` en `downstream-payment.ts` → **1** coincidencia (`:922`).
- `acc.failedCallers.add` en `reputation.ts` → **1** coincidencia (`:189`).
- `^async function mapOwnershipError` en `registries.ts` → **1** declaración (`:94`).
- `if (i > 0` en `services/compose.ts` → **1** coincidencia (`:571`). Las otras 4 apariciones de `i > 0`
  (`:309`, `:547`, `:602`, `:688`) son **prosa de comentario**, no la sentencia.

⇒ **Cero riesgo de auto-confirmación en los 4 reemplazos.** El diagnóstico del dev es sólido.

## 2.2 Dictamen: **van a la deuda. Coincido con tu criterio, y agrego una razón que lo refuerza.**

Tu criterio era: *arreglarlas a mano hoy, sin testigo, es fabricar más prosa no verificable — y el guard de la
deuda va a obligar a enumerarlas igual.* **Lo sostengo, y no tengo nada mejor.** Tres razones, la tercera es
mía:

1. **Ninguna toca ejecución.** Las 4 son comentarios. Cero ACs, cero money-path, cero respuesta HTTP.
2. **El guard de `TD-316-CITAS-SIN-TESTIGO` las fuerza a enumerarse**, con `mustContain` escrito a mano — que
   es precisamente el testigo que hoy no existe. Arreglarlas antes es hacer el trabajo dos veces y sin red.
3. **La razón nueva: arreglarlas HOY re-dispara el mecanismo que produjo las 4 rondas.** 3 de las 4 viven en
   `src/types/index.ts`, que es el archivo con **más anclas salientes del Scope IN (9)** y además es destino
   de anclas ajenas. Una corrección "de una línea" ahí es una edición en el medio de un archivo citado: es
   exactamente la lección `[Fix-pack AR — BLQ-BAJO-1]` (*"si tu diff inserta líneas en el medio, ese archivo
   tiene más de un delta"*). Y dos de las cuatro necesitan un arreglo **semántico**, no aritmético
   (`:207` apunta a un log de rechazo creyendo que es la firma; `:1450` tiene el **archivo** mal): eso es un
   juicio que quiere el testigo puesto, no un `sed`.

**Condición que sí exijo, y está cumplida**: que las 4 queden escritas con su ancla real en un lugar que la
deuda pueda levantar. Están en **`auto-blindaje.md:609-612`**, en tabla, con el ancla corregido. La deuda es
ejecutable para ellas. ✅

---

# 3. Calidad del código que esta HU SÍ escribió

## 3.1 `buildMetadata(source, payment?)` — la firma es clara y el docblock explica el POR QUÉ

`src/services/agent.ts:200-210` (docblock) → `:211-217` (firma). No dice sólo qué hace:

> *"Si fuera una key más de `source`, la llamada `buildMetadata(input)` tomaría `input.payment` — que es el
> objeto CRUDO del caller— y lo persistiría con sus keys de más. Como parámetro separado, el único valor que
> se le puede pasar es el que produjo `validatePaymentBlock`: **la regla deja de depender de que nadie se
> equivoque en el call-site**."*

Esa última cláusula es la que le sirve al próximo: convierte una convención en una propiedad del tipo.
Verificado que el call-site cumple: `:452` = `const metadata = buildMetadata(input, paymentBlock);`, y `paymentBlock` sólo
puede venir de `result.block` (`:436`). ✅ **OK.**

## 3.2 El log de auditoría — el arreglo es legible y está blindado contra el "simplificador"

Es lo contrario de un `const prev` suelto. `src/services/agent.ts:684-693`:

- La captura está en **`:691`**, el merge en **`:734`** → **antes**, verificado por número de línea, no por
  intención.
- El comentario nombra el **mecanismo**: `readMetadataObject` devuelve la misma referencia. Confirmado en
  `:104-110` → `return raw as Record<string, unknown>;`, **no** una copia. El hazard es real.
- La inmunidad es estructural, no accidental: `readStoredPaymentBlock`
  (`payment-spec-writer.ts:324-330`) construye un **object literal nuevo** con las 4 keys, así que la
  mutación posterior de `existing.metadata` no lo alcanza.
- Y nombra un **testigo falsable**: *"Medido: sin esta línea, `T-316-14` (reemplazo) sale con
  `prev.contract === next.contract`."* El que quiera "simplificar" tiene el test que se pone rojo escrito al
  lado. ✅ **OK.**

## 3.3 Los dos guards de logueo — **no son idénticos a sus 5 hermanos, y la desviación es correcta y está bien documentada**

Medido. Los 5 hermanos loguean **una** key: `{ field: 'priceUsdc' }` (`:219-222`), `payoutWallet`
(`:236-239`), `referrerRef` (`:251-254`), `enabled` (`:458-461`), `capabilities` (`:474-477`). Los dos nuevos
loguean **dos**: `{ field, code }` (`:282-288` en el POST, `:498-504` en el PATCH).

**No es la inconsistencia por la que vuelve el defecto, y no lo marco como finding.** Razón mecánica: cada
hermano tiene **un solo** modo de fallo, así que `field` determina el motivo. El guard nuevo tiene **8 códigos
sobre 3 fields** (`PaymentBlockRejectionCode`, `payment-spec-writer.ts:63-71`), así que `field` **no**
identifica cuál de los 7 chequeos disparó — sin `code`, el log no es diagnóstico. Y la propiedad que importa
se preserva **idéntica**: `code` es un literal de una unión cerrada, así que la línea sigue acotada por
literales y **no crece con el input del atacante**, que es exactamente lo que `AR/MNR-1` pedía.

Los dos guards nuevos **sí son idénticos entre sí** (misma forma, mismo orden de keys, mismo `paymentRejectionBody`),
y la asimetría POST/PATCH está documentada donde hay que documentarla (`:485-492`: en el PATCH `payment: null`
es borrado y no se valida).

Detalle que **suma** a favor: la prosa no miente sobre la diferencia. `agents.publish.test.ts:789-793` dice
textual *"Los 5 guards hermanos … **loguean sólo el `field`**; estos dos se desalinearon y el AR lo cazó"*.
La descripción es exacta.

## 3.4 `error_code` en el body del 422 — es la convención del repo, no una invención

Los 5 hermanos mandan `{ error, field, reason }`; el nuevo manda `{ error, error_code, field, reason }`
(`:114-129`). Verifiqué que `error_code` **es** convención establecida:
`src/routes/inbound.ts:75/85/94/99/107`, `src/routes/agent-card.ts:27`, más `payments`, `dashboard`,
`discovery`, `compose`, `budget`, `delegation`, `orchestrate`, `reputation-writeback`, `security/errors`.
⇒ los outliers son los 5 hermanos, no el guard nuevo. Alinearse con el repo por encima del vecino de archivo
es la decisión correcta. ✅ **OK.**

## 3.5 `T-316-29` — los nombres dicen lo que miden, y el par se auto-declara

- `agents.publish.test.ts:905`: `'T-316-29 · AR/MNR-2: \`payment: null\` es 422 en el ALTA (contrato nuevo, declarado)'`
- `agents.publish.test.ts:918`: `'T-316-29 (el otro lado del par): el MISMO \`null\` en el PATCH es BORRADO, no 422'`

El segundo nombre dice **que es un par** y **cuál es la asimetría**. El que rompa uno encuentra el otro. La
convención se sostiene en toda la serie: los nombres traen el AC/CD y la propiedad (`T-316-16 · AC-8 · R-7:
borrar la ÚNICA key de metadata escribe null, no \`{}\``; `T-316-17 · AC-9 · CD-1: byte-identidad de
/discover contra un literal escrito a mano`). ✅ **OK.**

## 3.6 El cambio de contrato 201 → 422 — **sí está donde lo lee quien publica un agente**

Esto era la pregunta más importante del punto 4 y la respuesta es sí, en tres capas:

1. **`doc/INTEGRATION.md:263-271`** — la sección *"Deleting the block"*, en el doc público de integración:
   *"On `POST` there is nothing to delete, so `"payment": null` is rejected with `INVALID_PAYMENT_BLOCK`
   rather than being silently read as 'no payment block'. To publish without one, leave the key out."*
   Dice el código de error y dice qué hacer en su lugar.
2. **Los DOS README linkean a ese ancla exacto** desde la fila `/agents` de la tabla de endpoints
   (`README.md:287`, `README.es.md:314` → `doc/INTEGRATION.md#declaring-where-your-agent-gets-paid-payment`),
   y el heading que genera ese slug existe (`doc/INTEGRATION.md:219`).
3. Las **8 rejections** están tabuladas con `error_code` + `field` + cuándo (`:285-295`), con
   *"all of them are checked before anything is written, so a rejected request never touches your agent row"* (`:282-283`)
   y *"Error bodies never echo the value you sent"* (`:296`) — las dos ciertas contra `paymentRejectionBody`.

No quedó sólo en el auto-blindaje. Y el footgun de `contract` tiene su propio `####` (`:248-261`)
— *"Putting a token address there sends your earnings to the token contract"* — que es la advertencia correcta
en el lugar correcto. **Esta es la mejor parte del entregable.**

Bonus verificado: los números de los README se actualizaron y **son los míos** — 292→**295** test files y
485→**489** biome files, idénticos a lo que medí en §0, y guardados por `test/readme-numbers.test.ts`. Y la
pubkey cero del doc (`:292`) es de **32 chars**, byte-igual a `'1'.repeat(32)` de
`payment-spec-writer.ts:61`. ✅

---

# 4. `TD-316-METADATA-LWW` — acotamiento, no cierre. Las 3 sub-preguntas, verificadas.

Entrada en `auto-blindaje.md:450-492`.

## (a) El interleaving de 4 pasos: **correcto y reproducible leyendo el código**

Reconstruido de `src/services/agent.ts` sin apoyarme en la prosa:

1. `:624` `const existing = await this.getRow(slug);` — lee la fila, `metadata` incluido.
2. `:734` `const meta = readMetadataObject(existing.metadata);` — y `:104-110` devuelve **la misma
   referencia**, no una copia.
3. `:735-751` asignan sobre `meta` los 4 campos presentes.
4. `:752-754` `updateRow.metadata = Object.keys(meta).length > 0 ? (meta as unknown as Json) : null;` —
   escribe el **objeto completo**.
5. `:757-763` el UPDATE: `.eq('slug', slug).eq('owner_ref', ownerRef)` — **sin** columna de versión, **sin**
   `updated_at` esperado, **sin** `WHERE metadata = <lo leído>`.

⇒ read-modify-write sobre el objeto entero, sin control de concurrencia. Dos PATCH del mismo dueño sobre el
mismo slug se pisan **a nivel de objeto**. Los 4 pasos del entregable son exactos, y las 3 citas de la entrada
(`:624`, `:734-754`, `:757-763`) apuntan bien. La observación fina también es cierta: **el log no delata
nada**, porque el PATCH que pisa tiene `updates.payment === undefined` y `:781` (`if (updates.payment !== undefined) {`) no entra.

## (b) Está escrito como **acotamiento**, con esas palabras

`auto-blindaje.md:485-489`:

> *"hoy la ventana requiere concurrencia del **mismo dueño** sobre el **mismo slug**, que es poco frecuente.
> Eso **acota la probabilidad, no cierra el camino**: no hay ningún guard que impida el interleaving, y no hay
> ninguna señal —ni en la respuesta HTTP ni en el log— de que ocurrió. Un `payment` que desaparece hoy se
> descubre cuando alguien cobra donde no debe, no cuando pasa."*

Eso es exactamente la distinción pedida. Y el diferimiento está bien fundado: la variante con columna de
versión **necesita DDL** y la HU es cero-DDL (CD-14/AC-9), y el arreglo cambia el contrato de escritura de
**los 4 campos**, no sólo de `payment`. Es otra HU, correctamente.

Además declara la subida de severidad sin escudarse en la herencia: *"La ventana no la abrí yo; lo que puse
adentro, sí"* — y la regla operativa *"heredar un patrón no es heredar su severidad — la severidad la fija el
dato que metés"*. Correcto.

## (c) Los 3 disparadores son observables por alguien que no leyó la HU

1. *"cualquier cliente que emita PATCH concurrentes sobre el mismo slug — un panel que guarde campo por campo
   con auto-save ya lo hace, sin proponérselo"* — observable sin contexto. ✅
2. *"que el bloque `payment` empiece a gatear un cobro real (hoy `readPaymentSpec` tiene dos consumidores y
   ninguno está en el camino de `requirePayment`)"* — **falsable, y la verifiqué**: `readPaymentSpec` tiene
   exactamente **2 call sites**, `src/services/discovery.ts:1380` y `src/services/agent.ts:169`
   (`mapRowToAgent`), los dos productores de shape de lectura, ninguno en `requirePayment`. ✅
3. *"que se agregue un quinto campo al `metadata`"* — observable. ✅

⇒ **La deuda está bien escrita.** Es el mejor artefacto de deuda de este entregable.

---

# 5. Consistencia con las convenciones del repo (`CLAUDE.md`)

| Convención | Medido | ¿? |
|---|---|---|
| **Sin `any` explícito / TS strict** | Barrido de las líneas `+` del diff en `src/` con `: any\|as any\|<any>\|!\.\|@ts-ignore\|@ts-expect-error`: **1 sola coincidencia**, y es `meta as unknown as Json` (`agent.ts:754`) — el **mismo cast que ya existía** en la línea que reemplaza. Cero `any`, cero non-null assertion, cero supresión de TS | ✅ |
| **Ownership guard (`owner_ref`)** | El diff **no introduce ninguna cadena `supabase.from(...)`** — barrido de líneas `+` por `\.from\('`: **cero**. No hay sitio nuevo que pudiera faltarle el filtro | ✅ |
| — el UPDATE que la HU tocó | `agent.ts:757-763` conserva `.eq('slug', slug).eq('owner_ref', ownerRef)` | ✅ |
| — `test/ownership-filter-guard.test.ts` | Verde en la suite completa; los **5 campos `line:`** que la HU re-apuntó (`347`, `372`, `507`, `547`, `580`) los verifiqué a mano y los 5 caen en un `.from('a2a_agents')` | ✅ |
| — y las **5 citas de prosa** de las excepciones | `:359-364` (docblock de `getSplitContextRow`), `:503` (*"NO filtra por owner…"*), `:633` (`if (existing.owner_ref !== ownerRef) {` de `update`), `:808` (idem de `delete`), `:447` (`const clash = await this.getRow(slug);`) — **las 5 correctas** | ✅ |
| **Sin hardcodes / sin secrets** | `EVM_ZERO_ADDRESS` y `SOLANA_ZERO_PUBKEY` son constantes matemáticas, no config. `OPERATOR_PRIVATE_KEY` y el keypair Solana salen de env/módulo, nunca literales. `operator-address.ts:81-84` documenta explícitamente que el mensaje de error puede nombrar envs y pubkeys pero **nunca** el secret | ✅ |
| **Sin datos simulados en producción** | Los mocks viven sólo en `*.test.ts` | ✅ |
| **Estilo del código de alrededor** | Docblocks en español con `⚠️`/`🔴` para invariantes, comentarios de paso numerados, `T-NNN` en nombres de test, mensajes de cliente en inglés y prosa interna en español — **matchea** el patrón de `routes/agents.ts` y `services/agent.ts` preexistentes. La densidad de comentarios es alta pero es la del repo, no una desviación | ✅ |
| **Cero KYC / cero DDL / cero migración** | Confirmado en el diff (`--stat`: ni un `.sql`) | ✅ |

**Nada que reportar en esta sección.** No la inflo: es un dato, no un fracaso.

---

# 6. Lo que el dev declaró NO haber medido — juzgado uno por uno

| # | Lo declarado | Mi juicio |
|---|---|---|
| 1 | *"no pude medir la prosa con un test"* (= `MNR-2`/`TD-316-CITAS-SIN-TESTIGO`) | **Importa, y es la deuda correcta.** Pero mitigado: re-verifiqué **las 25 anclas** que esta HU escribió o re-apuntó y **las 25 son ciertas**. El riesgo declarado ("si erró uno, nada lo va a cazar") **no se materializó**. Queda como deuda, no como defecto |
| 2 | *"no re-corrí la suite completa"* | **Cerrado por mí**: la corrí completa sobre `90cbbb6`, exit 0, 5750/19/0. Ya no es un hueco |
| 3 | *"no re-corrí ningún mutante"* | **No importa.** Verifiqué que su diff en `src/` para el fix-pack #2 es **1 insertion / 1 deletion en un comentario** (`agent.payment.test.ts:303`). Un mutante no puede cambiar de veredicto por un comentario |
| 4 | *"el split 289 \| 6 no lo medí"* | **No importa.** Confirmé la causa: el reporter JSON no expone ficheros passed/skipped por separado (`numPassedTestSuites 1316` cuenta bloques). Los totales que gatean —5750/19/0/exit 0— sí están medidos, dos veces |
| 5 | *"no verifiqué 3 citas pre-existentes más allá de la línea citada"* | **Era el que más importaba — y lo cerré yo** (§2.1). Los 4 anclas de reemplazo son **unívocos** en su destino: 1 coincidencia cada uno. El mecanismo de auto-confirmación **no está operando** acá |
| 6 | *"no corrí nada contra prod ni contra ninguna base"* | **Correcto que no lo hiciera.** Repo público, Railway, cobra x402. Cero DDL y cero cambio de forma persistida hacen que no haga falta |

---

# 7. Hallazgos

Cero BLOQUEANTEs. Tres MENORes. Ninguno bloquea el gate.

## `MNR-1` · Documentación / Mantenibilidad — el universo de arranque de la deuda omite el 12º fichero del Scope IN

- **Archivo:línea**: `doc/sdd/214-wkh-316-escritor-payment-block/auto-blindaje.md:663-664`.
- **Qué dice**: *"en los **11** archivos de `src/`+`test/` del Scope IN de WKH-316 hay **28 anclas en 24
  líneas**"*, presentado como *"el conjunto por donde arranca, ya medido acá (para que la HU no empiece de
  cero)"*.
- **Medido**: los ficheros `src/`+`test/` que esta HU modificó son **12**, no 11
  (`git diff --numstat 8242b16..HEAD -- src/ test/`). El que falta es
  **`test/ownership-filter-guard.exceptions.ts`** (`9 insertions / 9 deletions`), que tiene **37 líneas con
  anclas / 31 anclas** por el barrido de los tres patrones — **más que cualquier otro fichero del Scope IN**.
  De esas, **5 son anclas de prosa que esta HU re-apuntó** (`:359-364`, `:503`, `:633`, `:808`, `:447`) y que
  **no las verifica ningún mecanismo** — el guardián de ownership sólo mira su propio campo `line:`, como la
  entrada de W4 dice bien en `:220`. Contando ese fichero y las 4 anclas de §1.1, el arranque real es **~63**,
  no 28.
- **Reproducción**: `command grep -cE ':[0-9]+' test/ownership-filter-guard.exceptions.ts` → **37**;
  `/usr/bin/git diff --numstat 8242b16..HEAD -- src/ test/ | wc -l` → **12**.
- **Por qué es MENOR y no BLOQUEANTE**: **nada falso se está ocultando.** Verifiqué las 5 anclas de prosa que
  la HU re-apuntó ahí y **las 5 son correctas**, igual que los 5 campos `line:`. No hay ninguna cita rota
  escondida detrás de la omisión. El daño es sólo que la deuda arranca desde un conjunto subdeclarado ~2,2×.
- **Impacto**: quien ejecute `TD-316-CITAS-SIN-TESTIGO` va a tomar el 28 como piso y **saltearse el fichero
  con la mayor concentración de anclas de prosa del Scope IN**, que además es un fichero de **seguridad** (las
  excepciones del guard de ownership). Y es la misma clase que it-2 `BLQ-BAJO-1`: **buscar en vez de
  enumerar**, un nivel más arriba — ahí faltaban anclas dentro de un fichero, acá falta un fichero dentro del
  conjunto.
- ⚠️ **El límite declarado no cubre este hueco.** `:677-679` declara un límite real —*"el barrido de la forma
  corta busca la cita entre backticks; una escrita en prosa suelta no la devuelve. El 28 es un piso, no un
  total"*— pero ese límite es sobre la **forma** del ancla, no sobre la **omisión de un fichero entero**, ni
  sobre el destino `.sql` (`types/index.ts:661`), ni sobre las auto-referencias
  (`agents.ownership.test.ts:13`/`:25`). Un lector razonable concluye que el 28 cubre los ficheros del Scope
  IN, y no los cubre.
- **Sugerencia**: corregir `11` → `12`, sumar `test/ownership-filter-guard.exceptions.ts` al párrafo con su
  conteo y con la nota de que sus 5 anclas de prosa ya están verificadas (así la deuda no las re-mide), y
  extender la frase del límite para que diga que el conteo **excluye** los ficheros sin anclas nuevas en lugar
  de dar un número de ficheros. **Cero cambios en `src/`.**

## `MNR-2` · Documentación — el "19" es 20; la conclusión no cambia (se refuerza)

- **Archivo:línea**: `auto-blindaje.md:664-673` (*"**19** las escribió o las re-apuntó esta HU, y las 19 son
  ciertas"*), y su desglose *"2 en `src/routes/agents.ownership.test.ts` (`:808`, `:822`)"*.
- **Medido**: esa HU re-apuntó **3** anclas en ese fichero, no 2. La tercera es
  `src/routes/agents.ownership.test.ts:25` → `` `:211` ``, cambiada desde `` `:184` `` por este mismo diff
  (`/usr/bin/git diff 8242b16..HEAD -- src/routes/agents.ownership.test.ts`, hunk `@@ -14,15 +14,15 @@`). **Y
  es correcta**: `:211` = `it('T-143B-06: owner PATCH own slug with payoutWallet → 200, …')`.
- **Reproducción**: `command sed -n '211p' src/routes/agents.ownership.test.ts` → el `it(...)` de `T-143B-06`,
  exactamente lo que `:25` afirma.
- **Nota de consistencia**: `:211` **sí** está en la tabla del inventario de W4 (`auto-blindaje.md`, fila
  `src/routes/agents.ownership.test.ts:25`, marcada `✅ sí (Scope IN)`). O sea: no se perdió, sólo no entró en
  la suma del párrafo. Es aritmética, no medición.
- **Impacto**: nulo sobre el juicio — pasa de **19/19** a **20/20 ciertas**. Lo reporto porque el párrafo se
  presenta como conteo cerrado y la lección del propio fix-pack #2 es *"un inventario se enumera, no se
  busca"*; un conteo que no cuadra con su propia tabla invita a re-medir todo.
- **Sugerencia**: `19` → `20` y `(:808, :822)` → `(:808, :822, :211)`.

## `MNR-3` · Documentación pública — `asset` no se guarda "as you sent it": se trimea

- **Archivo:línea**: `doc/INTEGRATION.md:246` vs `src/lib/payment-spec-writer.ts:292`.
- **Qué dice el doc**: `| \`asset\` | no | A label. Checked against the token the rail settles, **then stored
  as you sent it**. |`
- **Qué hace el código**: `if (asset !== undefined) block.asset = asset.trim();` — se guarda **trimeado**.
- **Reproducción**: `POST /agents` con `"asset": "  USDC  "` → persiste `"USDC"`, no `"  USDC  "`. El doc
  promete byte-identidad y no la hay para whitespace.
- **Impacto**: **nulo funcional** — `asset` es decorativo y ningún camino de dinero lo lee
  (`payment-spec-writer.ts:182-187` lo declara). Es sólo una frase falsable en el doc público. Lo reporto
  porque en la misma tabla, dos filas abajo, el doc **sí** es preciso sobre la caja de `contract` (*"Letter
  case is preserved byte for byte and never normalized"*), y ahí la precisión es load-bearing; la asimetría
  hace pensar que `asset` tampoco se toca.
- **Sugerencia**: *"stored trimmed, with its case preserved"*, o *"stored as you sent it, minus surrounding
  whitespace"*.

---

# 8. Las 6 categorías del CR

| # | Categoría | Veredicto | Evidencia |
|---|---|---|---|
| 1 | **Legibilidad / claridad** | **OK** | `buildMetadata` documenta el *por qué* de la firma (`agent.ts:200-210`); la captura de `prev` nombra mecanismo + testigo (`:684-693`); los 7 pasos del validador están numerados y con el orden declarado normativo y **con su razón mecánica** (`payment-spec-writer.ts:155-162`) |
| 2 | **Consistencia con el repo** | **OK** | `error_code` es convención (§3.4); `assertValid*`-style defense-in-depth en el service espeja a `assertValidPayoutWallet`; `logPaymentBlockChange` sigue el precedente de `logOwnershipMismatch`; naming `T-NNN`, idioma y densidad de comentarios matchean el entorno |
| 3 | **Patrones / arquitectura** | **OK** | Módulo LEAF con **un solo** choke-point de validación, custodiado por un test estructural (`test/payment-guards-live-in-one-place.test.ts`) que además trae **control de vacuidad** (exige los tokens **presentes** en el validador, no sólo ausentes en los consumidores) — que es la trampa que suele hundir a este tipo de guardián. Import dinámico de Solana justificado y con la razón medida (`operator-address.ts:10-15`) |
| 4 | **Deuda técnica** | **OK, con 2 deudas bien escritas** | `TD-316-METADATA-LWW` (§4) y `TD-316-CITAS-SIN-TESTIGO` (§1.2): las dos con qué es, por qué se difiere, 3 disparadores observables, y el acotamiento distinguido del cierre **con esas palabras**. Sólo el conjunto de arranque de la segunda está subdeclarado → `MNR-1` |
| 5 | **Tests: nombres y valor** | **OK** | Nombres con AC/CD y con la propiedad medida (§3.5); el par `T-316-29` se auto-declara; `T-316-18` cubre el negativo de AC-9 (fila sembrada con chain desconocida no se re-valida); `T-316-17` compara `/discover` contra un literal escrito a mano en vez de contra el propio productor |
| 6 | **Documentación** | **OK, con `MNR-3`** | `doc/INTEGRATION.md:219-296` es documentación pública de calidad: 8 rejections tabuladas, el footgun de `contract` con su propio heading, la asimetría POST/PATCH de `null` en los dos lados, y los derivados explicados. Linkeada desde los **dos** README al ancla exacta. Los números de README actualizados y **coincidentes con mi medición** (295 / 489) |

---

# 9. Deuda declarada que queda ABIERTA

| Nombre | Qué es | Por qué se difiere | Dónde está escrita |
|---|---|---|---|
| **`TD-316-METADATA-LWW`** | `update()` reescribe el objeto `metadata` completo sin control de concurrencia (read-modify-write, last-writer-wins **a nivel de objeto**), y esta HU mete la billetera de cobro dentro de esa ventana. Dos PATCH concurrentes del mismo dueño sobre el mismo slug pueden **borrar el bloque `payment` en silencio**, con 200 en las dos respuestas y sin señal en el log | El arreglo correcto (columna de versión, o `jsonb_set` server-side) **necesita DDL** y/o cambia el contrato de escritura de los 4 campos del `metadata`. La HU es cero-DDL por CD-14/AC-9 | `auto-blindaje.md:450-492` |
| **`TD-316-CITAS-SIN-TESTIGO`** | **Ninguna** cita `archivo.ts:N` de este repo tiene testigo posible: `codeOnly` borra los comentarios antes de mirar, y 0 de los 15 tests que leen fuentes verifica un número de línea. 12 citas defectuosas en el blast radius de esta sola HU, 0 cazables | Generalizar `CITED_INDEX_LINES` a citas `*.ts:N` obliga a declarar el `mustContain` de **cada** cita existente a mano, y el guardián arranca **rojo por definición** hasta que estén todas. Toca decenas de ficheros. Es otra HU | `auto-blindaje.md:624-693` · diseño ya en el repo: `test/sdd-index-matches-folders.exceptions.ts:160-192` + control **G-F2** (`test/sdd-index-matches-folders.test.ts:420`) |

Y las **6 citas pre-existentes falsas medidas y NO arregladas**, que entran a `TD-316-CITAS-SIN-TESTIGO` por
dictamen de §2.2 — las 4 escaladas están tabuladas con su ancla real en **`auto-blindaje.md:609-612`**, más
`types/index.ts:385 → agent.ts:399` (declarada en W4) y las 3 fuera de Scope IN
(`discovery.ts:255` — CD-6 lo prohíbe —, `orchestrate.ts:1160`, `self-published-auth.ts:29`).

---

# 10. Instrumentos: los que fallaron y los que usé

**Fallaron / hubo que evitarlos** (declarado, no inferido):

- `git diff` bajo el hook **trunca**. Usé **`/usr/bin/git`** para todo git. Control: mi dump de
  `src/`+`test/` dio **3229 líneas**, coherente con las ~3250 declaradas; ningún barrido negativo se apoyó en
  un diff truncado.
- `grep` bajo el hook devuelve **conteos en vez de rutas**. Usé **`command grep -n`** en todas las mediciones.
- `npx vitest run > archivo` **trunca a 500 chars con exit 0**. Usé `--reporter=json --outputFile=` **fuera
  del repo** (scratchpad) y parseé el JSON con `node -e`. El stdout confirmó
  `[RTK:PASSTHROUGH] vitest parser: All parsing tiers failed`, o sea que el parser del hook **no** tocó los
  números.
- `npx biome` no resuelve el binario → **`./node_modules/.bin/biome`**.
- **Exit codes nunca tras un pipe**: el `BIOME_EXIT=0` lo tomé en una corrida **con redirección a fichero, sin
  pipe**. La primera corrida (con `| tail`) la marqué como no confiable y la repetí.
- `cat` corrompe → usé `Read` y `command sed -n`.
- **Mi primer barrido de anclas fue insuficiente y lo declaro**: mi patrón inicial exigía backtick de cierre y
  perdió anclas (`:1-16`, y las de prosa suelta de `exceptions.ts`). Lo detecté porque
  `payment-spec-writer.ts` dio 0 y no me cerró. Lo reemplacé por `:[0-9]{2,4}` a secas sobre los 12 ficheros
  **y clasifiqué a mano**, que es el método que la propia HU documentó como el único completo. Sin ese cambio
  de patrón no habría encontrado `MNR-1`.

**Límites de lo que pude medir** — con esas palabras:

1. **No pude medir la prosa con un test.** Verifiqué las 25 anclas de esta HU **a mano**, abriendo cada
   destino y cruzando por función contenedora. Si erré uno, **nada lo va a cazar** — es exactamente la deuda
   `TD-316-CITAS-SIN-TESTIGO`, y mi verificación tiene el mismo techo que la del dev.
2. **No corrí mutantes.** El brief me prohíbe re-litigar los 4 del fix-pack y los del AR, y no los re-medí.
   Mi confianza en `M15`, en la captura del `prev` y en la aserción por-ausencia-de-clave es **heredada del
   AR, no medida por mí**.
3. **No medí el split `289 passed | 6 skipped` de ficheros.** El reporter JSON no lo expone (§0/§6.4).
4. **No corrí nada contra prod ni contra ninguna base.** Repo público, Railway, cobra x402. Todo lo de arriba
   es lectura estática + la suite local.
5. **No verifiqué las ~31 anclas pre-existentes de `test/ownership-filter-guard.exceptions.ts`** que apuntan a
   ficheros fuera del Scope IN (`dashboard.ts`, `arbiter.ts`, `delegation.ts`, `identity.ts`, `registry.ts`).
   Sí verifiqué las **5** que esta HU re-apuntó, y `identity.ts:422` que me hizo dudar (pertenece a
   `identity.ts`, no a `agent.ts`: **falsa alarma mía**, no un finding). Las otras no son de esta HU y
   entrarían por `MNR-1`.
6. **No verifiqué la anti-vacuidad de `test/payment-guards-live-in-one-place.test.ts` por mutación.** Leí que
   el control existe y está bien diseñado (exige presencia en el validador, no sólo ausencia en los
   consumidores); **no lo rompí para ver si se pone rojo**.

---

# 11. Cierre

- **Veredicto: APROBADO.** Cero BLOQUEANTEs. `MNR-1`, `MNR-2` y `MNR-3` son de prosa, no bloquean DONE, y
  los tres se cierran editando `.md` — **cero cambios en `src/`**.
- **La respuesta a la pregunta central**: quedó **mantenible**. Las 4 rondas de citas desplazadas no fueron
  descuido: fueron dos puntos ciegos estructurales de barrido, diagnosticados con el mecanismo, con la regla
  operativa que los corta escrita, y con el diseño del guardián que los cierra ya identificado adentro del
  repo. **Todo lo que esta HU escribió de cero es cierto (25/25 anclas verificadas por mí).** Lo que hereda
  está medido, tabulado con su ancla real y ruteado a una deuda ejecutable.
- **Lo mejor del entregable**: `doc/INTEGRATION.md:219-296`. El cambio de contrato 201→422 y el footgun de
  `contract` están donde los lee quien publica un agente, no enterrados en el auto-blindaje.
- **Lo que quedaría abierto si nadie toca los MENORes**: la deuda de citas arrancaría desde un conjunto
  subdeclarado ~2,2×, salteándose el fichero de excepciones del guard de ownership.
- **Checksums al cierre**: `doc/sdd/212-…/story-file.md` = `7904ef74a1c46d7880e0ca5d38e3eed4` (intacto,
  untracked, no lo toqué) · `src/routes/agents.ts` = `fdb1fd726b17aa17d4296705738f7e62` · HEAD = `90cbbb6`.
  `git status --short` = **una sola línea**, la del untracked ajeno.
