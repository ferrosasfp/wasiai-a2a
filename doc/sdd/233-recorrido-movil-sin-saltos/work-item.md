# Work Item — [WKH-372] El recorrido móvil sin saltos: rediseño de la capa de firmas de Chaski

> **Repo ancla de los artefactos SDD:** `wasiai-a2a` (`doc/sdd/233-recorrido-movil-sin-saltos/`).
> **Repo donde vive el trabajo:** casi todo en `chaski-v3`; una pata en `wasiai-facilitator`.
> **De `wasiai-a2a` no se toca nada** más que esta carpeta y la fila del `_INDEX.md` (§7.3).

---

## 🔄 REVISIÓN 2 — 2026-08-31 · desolapamiento con la HU `071` de `chaski-v3`

**El problema que esta revisión corrige, dicho sin suavizarlo: la ola W2 de este work-item era otra
HU, ya escrita, con SDD de 159 KB y dos rondas de AR encima.** La revisión 1 la re-derivó desde cero
porque **no encontró la carpeta `doc/` de `chaski-v3`**, que está **gitignoreada** (`.gitignore:36`,
`[HEREDADO: chaski-v3/doc/sdd/071-…/sdd.md:1268-1270]`) y por lo tanto **invisible para `grep`**.
Es exactamente el footgun que este ecosistema ya tiene documentado: *`grep` respeta el `.gitignore` y
da CERO falso*.

| # | Qué cambió | Dónde |
|---|---|---|
| **R2-1** | **W2 RETIRADA.** Era la HU `071` de `chaski-v3` re-derivada. Se reemplaza por una referencia | §4/W2, §3, §5, §8, §9.2, §10 |
| **R2-2** | **W4 reescrita.** `M-3` estaba mal planteada: la capacidad **no falta**, el facilitator **ya verifica la firma server-side**. W4 es una **decisión de riesgo**, no un bloqueo técnico | §4/W0 M-3, §4/W4 |
| **R2-3** | **`MI-2` cerrado** por decisión del founder: quien no tiene billetera **instala y crea la suya** | §4/W1 AC-1-4, §10 |
| **R2-4** | **Objetivo de éxito corregido.** «SOL exigido: 0» **no lo entrega esta HU** | §3 |
| **R2-5** | **`M-2` retirado**: existía sólo para gatear W2 | §4/W0 |
| **R2-6** | **Orden de ejecución consolidado** entre las dos HUs, con qué gatea a qué | **§0** |
| **R2-7** | Corregida la cita de `M-3`: apuntaba a un **docblock**, no al código que hace el trabajo | §4/W0 |

**Numeración: se deja el HUECO en `W2` y NO se renumera.** Motivo, y es comprobable: renumerar
`W3→W2` y `W4→W3` rompería **todas** las referencias externas a `W3`/`W4` que ya están publicadas
— la fila 233 de `doc/sdd/_INDEX.md` las nombra por número, y este documento las cruza 14 veces entre
`§3`, `§5`, `§9`, `§10` y `§11`. Dejar el hueco **rompe cero citas** y además deja el registro de por
qué se fue. Renumerar habría sido más prolijo y más caro.

---

## ⚠️ CÓMO LEER LAS CITAS DE ESTE DOCUMENTO

Este F1 corrió **SIN SHELL**: sólo `Read`, `Write` y `Glob`. No se ejecutó ni un `grep`, ni la
app, ni una suite, ni un teléfono. **La revisión 2 corrió con la misma limitación.** Por eso cada
afirmación lleva una de estas marcas:

| Marca | Qué significa |
|---|---|
| `[MEDIDO-F1]` | Abrí el archivo y leí esa línea en la sesión del F1 (2026-08-30), sobre el árbol de ese día. |
| `[MEDIDO-R2]` | Abrí el archivo y leí esa línea en la **revisión 2** (2026-08-31). |
| `[HEREDADO]` | Sale de uno de los informes de entrada o del expediente de la HU `071`. **No lo re-medí.** |
| `[NO MEDIDO]` | Nadie lo midió, ni yo ni los informes. Va como riesgo o como Missing Input. |

⛔ **Este work-item se declara REGISTRO HISTÓRICO** (CD-9): numera el árbol de F1 y **no se
re-ancla**. Re-anclarlo volvería falsas las frases que describen el defecto que la HU cierra.
Precedente escrito en este mismo índice: fila 226 y fila 232.

---

## 0 · ORDEN DE EJECUCIÓN CONSOLIDADO — qué gatea a qué

Las dos HUs son de repos distintos y de expedientes distintos. Este es el orden acordado, con la
razón de cada posición.

| # | Qué | Repos | Qué lo gatea | Qué desbloquea |
|---|---|---|---|---|
| **1** | **W1 de esta HU** — el navegador de la billetera | `chaski-v3` (sólo cliente) | **Nada.** Es aditiva y no cambia ningún contrato de servidor (§9.1) | El valor de todo el resto: sin W1 el recorrido sigue teniendo 6 saltos |
| **2** | **HU `071` de `chaski-v3`** — el remitente no necesita SOL | **los TRES**: `chaski-v3` + `solana-programs` + `wasiai-facilitator` | `HU_APPROVED` + revisión 3 del SDD + **MI-2 de esa HU** (acceso a dos billeteras) + la upgrade authority | La métrica «SOL exigido: 0» del camino inyectado. **Ninguna ola de ESTA HU la necesita** |
| **3** | **W3 de esta HU** — sesión del lado del servidor | `chaski-v3` | Nada de la `071`. Puede escribirse en paralelo; se **mergea** después para no cruzar diffs en `chaski-v3` | Borra la segunda firma de identidad |
| **4** | **W4 de esta HU** — la firma de patrocinio | `wasiai-facilitator` + `chaski-v3` | **Una decisión de riesgo escrita y firmada por alguien con nombre** (§4/W4). No una medición | La tercera firma, si la decisión es que sí |

⚠️ **`W0` no está en la lista porque no es un paso: es la medición que gatea a `AC-3-4`.** Corre en
paralelo con todo lo demás (§11).

### 0.1 · ¿La ola 1 le cambia algo a la HU `071`? — **verificado: NO, y tampoco le saca trabajo**

La lectura que había que confirmar o refutar era: *«la ola 1 no cambia la `071`, y además le saca
trabajo, porque la cuenta de nonce sólo existe en el camino por enlace»*.

**Confirmado lo primero. Refutado lo segundo, y la diferencia importa.**

- ✅ **No le cambia nada.** Revisadas las 21 ACs, los 17 DT, las 32 CD y los 5 bloques de waves del
  `sdd.md` de la `071`: **ninguno cambia de contenido ni de veredicto** por que el camino principal
  pase a ser el navegador de la billetera. La `071` ya trata los dos caminos por separado y ya
  declara el residuo del enlace (`DT-12`, `sdd.md:1035-1049`, `[MEDIDO-R2]`).
- ❌ **No le saca trabajo.** `AC-15` de la `071` (*«mantener el umbral del camino por ENLACE en su
  valor derivado y no declararlo cero»*, `sdd.md:617-619`, `[MEDIDO-R2]`) y su ítem de wave **3.8**
  (`flow-vm.ts:1432`, el copy de ese camino, `sdd.md:1252`, `[MEDIDO-R2]`) **siguen enteros**,
  porque **CD-3 de esta HU deja el camino por enlace encendido**. Un camino encendido necesita su
  umbral y su copy.
- ✅ **Lo que sí le cambia es la EXPOSICIÓN.** Después de W1, el residuo de **1.527.680 lamports**
  que la `071` declara y explícitamente **no promete** llevar a cero (`DT-12`; el sumando es
  `NONCE_ACCOUNT_RENT_LAMPORTS = 1_447_680`, `chaski-v3/src/application/solana-escrow-rent.ts:332`,
  `[MEDIDO-R2]`) afecta **sólo al camino de respaldo**. Eso no es código: es cuánta gente lo ve.

### 0.2 · 🔴 Lo que el orden SÍ obliga a coordinar, y es una cita rota esperando

W1 edita `chaski-v3/src/infrastructure/solana-wallet.ts` alrededor de `:897` (la rama por enlace,
que **no se borra**, CD-5). Ese mismo bloque declara, en el propio archivo, que recibe
**76 citas ancladas por debajo**: `solana-wallet.ts:893` `[MEDIDO-R2]`, marcador
`[[CENSO src/infrastructure/solana-wallet.ts entrantes-desde-893=76]]`.

La `071` cita ese archivo **por número y por debajo de ese punto**: ítem **3.4**
(`solana-wallet.ts:1400-1420`, `sdd.md:1248`) e ítem **3.12** (`:1640-1660`, `sdd.md:1256`),
`[MEDIDO-R2]` los dos.

⇒ **Si W1 mergea primero (y ese es el orden), la revisión 3 del SDD de la `071` re-deriva esas
citas.** Y la asimetría es deliberada, no un descuido: **esta HU no re-ancla** las suyas (CD-9, es
registro histórico); **la `071` sí tiene que hacerlo**, porque sus citas son un **plan de trabajo**
que alguien va a abrir para editar, no un registro de lo que se encontró.

---

## Resumen

Mandar una remesa desde el navegador de un celular cuesta hoy **6 saltos a la app de la billetera,
5 firmas, y atravesar la pantalla de entrada 7 veces** `[HEREDADO: mapa §3]`. Cada firma cuesta
**dos toques**, porque la vuelta del salto remonta el árbol de React y aterriza en la bienvenida
con un aviso y un enlace que hay que tocar a mano `[HEREDADO: mapa §6]`.

Esta HU rediseña **la capa de interacción con la billetera y el recorrido de pantallas**, en tres
olas (W1, W3, W4) con una ola cero de mediciones. El objetivo del recorrido principal es
**0 saltos entre apps, 1 travesía de la pantalla de entrada y 2 firmas**.

⛔ **Lo que esta HU NO entrega, y decirlo es parte del entregable (CD-12)**: **el remitente sigue
necesitando SOL**. Llevar ese número a cero es la **HU `071` de `chaski-v3`**
(`doc/sdd/071-facilitator-adelanta-el-alquiler/`), que es otra HU, de otro repo, con su propio
expediente. Lo único que esta HU baja por sí sola es el **recargo de la cuenta de nonce**, y lo baja
por inalcanzabilidad, sin escribir una línea para eliminarlo (§3).

### El hallazgo que define el alcance

> **Ni el Coordinador (`wasiai-a2a`) ni ninguno de los 3 agentes pide jamás una firma de
> billetera. Los tres reciben strings.** `[HEREDADO: mapa §0, 7 citas]`

De los 6 saltos: **1 lo impone Solana** (la firma del depósito), **1 el protocolo de la
billetera** (el `connect`), y **4 los escribimos nosotros** — 2 en Chaski (`pop-kyc`,
`pop-payout`), 1 en Chaski por decisión de arquitectura (`crear-nonce`, WKH-357), y 1 en
`wasiai-facilitator` (`firmar-patrocinio`), que también es nuestro.

⇒ **La capa de firmas es rediseñable sin tocar el contrato con el Coordinador ni con los agentes.**

---

## Sizing

- **SDD_MODE: full** — modo **QUALITY**, y las razones son propias, no deferencia a `CLAUDE.md`:
  1. **Es el camino del dinero.** Todo lo que se toca está entre la persona y su depósito de USDC.
     Una ola a medias no degrada la UX: **impide depositar** (§9).
  2. **El repo lo revisa David**, mentor de la incubadora Solana LATAM Labs. Código de producción,
     no hack.
  3. **El recorrido que se rediseña nunca se completó de punta a punta**, según el propio repo:
     *«NADIE de este equipo lo corrió entero en un teléfono»* — `flow.tsx:4201` y
     `solana-wallet.ts:893-896` `[MEDIDO-F1: leí `solana-wallet.ts:893-896`, el texto está y dice
     exactamente eso]`. O sea que **no hay línea de base ejecutada** contra la cual comparar.
  4. **El precedente de proceso más caro del proyecto es de ORDEN**, no de código: 8 días caídos
     por encender la auth de un agente antes de sembrar el secreto en los llamadores. Dos de las
     tres olas vivas tienen exactamente esa forma (§9).
- **Estimación: M-L** *(baja de `L` en la revisión 2: se fue una ola entera, y era la de los tres
  repos)*. ⚠️ **Recomendación explícita del F1, que se mantiene: NO ejecutar las olas bajo un solo
  SDD.** Este work-item es el **paraguas**; cada ola es un corte shippeable con su propio `sdd.md` +
  `story-file.md` + AR/CR/F4. El orden entre olas es **load-bearing** (§0) y el orden DENTRO de cada
  ola también (§9). Ver DT-8.
- **Branch sugerido:** `feat/233-wkh-372-recorrido-movil-sin-saltos` (paraguas) y una rama por ola
  en `chaski-v3`. ⚠️ **Los nombres de rama son una PROPUESTA SIN VERIFICAR** — no corrí `git`.
- **Gates por repo, distintos** (⛔ el nombre del gate no se hereda):
  | Repo | Gate |
  |---|---|
  | `chaski-v3` | `npm run qa` → `npm run build` |
  | `wasiai-facilitator` | `npm run qa` `[HEREDADO]` — **verificar sus `scripts` antes de citarlo** (MI-5) |
  | `wasiai-a2a` | `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test` (⛔ `npm run qa` **NO existe acá**) |

---

## 1 · Las decisiones del founder, ya tomadas

**De la conversación de apertura:**

- **Camino D: el rediseño completo.** No es una optimización puntual.
- **El recorrido por enlace profundo queda como RESPALDO, encendido.** Deja de ser el camino que
  perseguimos. ⛔ **No se apaga y no se borra.** → CD-3.
- **No más prueba y error.** Ninguna ola arranca sobre una suposición. → W0 y CD-4.

**Del 2026-08-31, textuales, y las cuatro cierran cosas que estaban abiertas:**

| # | Frase | Qué cierra |
|---|---|---|
| **D-1** | *«en el modelo que ya estaba, usuario nunca tiene SOL. El facilitator adelanta el alquiler, queda grabado on-chain quién lo puso, y vuelve a quien lo puso. Hay además un camino de recuperación que no depende de que la persona apriete ningún botón; este modelo me parece que está bien»* | **Confirma el modelo de la HU `071`.** ⛔ No se redecide acá. **Es el motivo por el que W2 se retira** |
| **D-2** | *«no interesa los remitentes que tienen sol atrapado pq es todo devnet y soy yo el que está probando, entonces si no tienen que recuperar»* | Retira la **rama legado** de la `071`. No toca nada de esta HU |
| **D-3** | *«si el usuario no tiene Phantom se le pide instalar y crear su wallet»* | 🎯 **Cierra `MI-2`** y con él **`AC-1-4`** |
| **D-4** | *«no podemos o debemos patrocinar SOL gratuitamente, pq el negocio se vería impactado»* | El cobro en USDC dentro de la comisión es **requisito** de la `071`, no opcional. Refuerza que W2 no puede vivir acá: **su parte cara es de producto y de precio**, no de UX |

---

## 2 · Línea de base — y por qué NO se copia de los informes

| Métrica | Camino inyectado | Camino por enlace (1ª vez) | Fuente |
|---|---|---|---|
| Saltos a la billetera | 0 | **6** | `[HEREDADO: mapa §3]` |
| Firmas | **3 o 4 — el informe se contradice** (§2.1 lista 4 filas, su propio total dice «3 firmas + 1 connect», y §3 repite 3 omitiendo `pop-payout`) | **5** + 1 connect | `[HEREDADO, con conflicto interno]` |
| Travesías de la pantalla de entrada | 1 | **7** (4 de las 6 vueltas aterrizan ahí) | `[HEREDADO: mapa §3, §6]` |
| SOL exigido por el guard | **0,0088746** (`SENDER_MIN_LAMPORTS_FOR_DEPOSIT`) | **0,0104022** (`SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT`) | `[MEDIDO-F1]` — `chaski-v3/src/application/solana-escrow-rent.ts:187-191` y `:352-356`; el sumando del nonce es `NONCE_ACCOUNT_RENT_LAMPORTS = 1_447_680` en `:332` `[re-leído, MEDIDO-R2]` |
| Firmas exigidas por el Coordinador o los 3 agentes | **0** | **0** | `[HEREDADO: mapa §0]` |

🔴 **HALLAZGO DEL F1, y es el que obliga a AC-0-4**: el informe de terreno **se contradice sobre
el número de firmas del camino inyectado**. §2.1 tabula cuatro (`pop-kyc`, `pop-payout`, depósito,
patrocinio, las cuatro con su `archivo:línea`) y a renglón seguido totaliza tres; §3 repite el tres
omitiendo `pop-payout`. No lo resolví: resolverlo exige ejecutar, y este F1 no ejecutó.

⚠️ Lo que sí medí y **agrava** la duda: `confirm-and-send.ts:463` `[MEDIDO-F1]` pide el PoP de
payout **en el camino común a los dos recorridos**, y su comentario dice *«En el camino inyectado
esto contesta `no-corresponde` y no ejecuta ninguna línea nueva (AC-8)»* — pero eso habla del
**mecanismo por enlace**, no de si el gateway HTTP pide la firma igual
(`http-solana-prepare-gateway.ts:245`, `[HEREDADO]`). Las dos lecturas son compatibles con el
código que leí. ⇒ **`[NEEDS CLARIFICATION] MI-1**, no bloqueante para F2, bloqueante para W0.

⇒ **CD-8 / AC-0-4: la línea de base se DERIVA ejecutando el recorrido, no se copia de este
documento ni del informe.** Un número sin instrumento que lo re-derive no es una medición.

⚠️ **La derivación que hay que tener presente y que la revisión 2 re-leyó**:
`SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT` **no es un literal**, es
`SENDER_MIN_LAMPORTS_FOR_DEPOSIT + 1.447.680 + 5.000 + 75.000`
(`solana-escrow-rent.ts:352-356`, `[MEDIDO-R2]`). ⇒ **el camino por enlace se mueve solo cuando la
`071` mueve el término base**, sin que nadie lo edite. Todo test que assertee el literal viejo se va
a poner rojo, y **es señal, no ruido**.

---

## 3 · Objetivo — cómo se mide el éxito, y qué ola lo entrega

El estado final sobre el **recorrido principal** (dentro del navegador de la billetera), declarado
como **objetivo con su ola responsable**, nunca como promesa:

| Métrica | Antes (por enlace, 1ª vez) | Después (objetivo) | Ola que lo entrega |
|---|---|---|---|
| Saltos **entre apps** durante el envío | 6 | **0** (más 1 salto inicial de `browse`, una vez) | W1 |
| Travesías de la pantalla de entrada | 7 | **1** | W1 |
| Remontajes del árbol de React | 6 | **0** | W1 |
| Firmas | 5 (+1 connect) | **2** (identidad + depósito) si W4 cierra que sí; **3** si no | W1 (−1: `crear-nonce`) · W3 (−1: `pop-payout`) · W4 (−1: patrocinio, **decisión de riesgo**) |
| Permisos que ve la persona en el paso de identidad | 2 (`connect` + `pop-kyc`) | **1** si M-1 da SÍ; **2** si da NO | W3 (sólo el AC de fusión) |
| **SOL exigido por el guard** | 0,0104022 | **0,0088746** | **W1, y ahí se termina lo que esta HU puede** |
| Invocaciones pagas del agente de cash-out por envío | **3** | **1** | W1 (aritmética de saltos, §6) |
| Órdenes de payout huérfanas por envío | **2** | **0** | W1 (íd.) |

### 🔴 La corrección de la revisión 2, y es la más importante de todas

**La revisión 1 declaraba «SOL exigido: 0 tras W2». Esta HU no entrega ese número, y la frase «el
remitente no necesita SOL» tiene PROHIBIDO aparecer como resultado suyo (CD-12).**

Lo que esta HU entrega por sí sola, con su aritmética:

| | lamports | de dónde sale |
|---|---:|---|
| Umbral del camino por enlace, hoy | **10.402.240** | `solana-escrow-rent.ts:352-356`, derivado `[MEDIDO-R2]` |
| Umbral del camino inyectado, hoy | **8.874.560** | `:187-191` `[MEDIDO-F1]` |
| **Lo que W1 elimina** | **1.527.680** | 1.447.680 (`NONCE_ACCOUNT_RENT_LAMPORTS`, `:332`) + 5.000 + 75.000 |
| **Lo que queda después de W1** | **8.874.560** | y **no baja más con nada de esta HU** |
| Lo que la HU `071` lleva a **0** | esos 8.874.560 | otra HU, otro repo, tres repos y un upgrade de programa |

**Y el mecanismo por el que W1 elimina esos 1.527.680 merece decirse, porque es lo barato de esta
HU**: la rama que crea la cuenta de nonce está gateada por
`if (this.firmaPorEnlace && this.caminoPorEnlace() !== null)` —
`chaski-v3/src/infrastructure/solana-wallet.ts:897` `[MEDIDO-F1, re-leído MEDIDO-R2]`. ⇒ **en el
camino principal deja de ser alcanzable, y su alquiler deja de pedirse, sin escribir una línea para
eliminarla.** El propio archivo declara que ese alquiler **no vuelve**: *«este alquiler NO se
recupera salvo que alguien emita un `nonceWithdraw`, y esta HU NO lo implementa»*
(`solana-escrow-rent.ts:329-331`, `[MEDIDO-R2]`).

⛔ **Y el corolario del respaldo**: **el código del nonce NO se borra en W1** (CD-3, CD-5).
Desaparece por dejar de ser alcanzable en el camino principal, no por deleción. El camino por enlace
lo sigue necesitando, sigue encendido, y **para quien lo tome el umbral sigue siendo 0,0104022**.

⚠️ **Las dos primeras columnas de la fila «Firmas» arrastran MI-1** (§2). El «antes» del camino
inyectado se re-mide en W0.

---

## 4 · Las olas, en orden de dependencia — el orden es load-bearing

### W0 · Las mediciones que son precondición

⛔ **Ninguna ola arranca sobre una suposición** (CD-4). W0 es una ola de **medición**, no de
implementación: su entregable son respuestas con su evidencia archivada.

| # | Pregunta | Qué gatea | Estado hoy |
|---|---|---|---|
| **M-1** | ¿Phantom acepta **SIWS** (`signIn`) por enlace profundo? | **Sólo el AC de «un permiso»** de W3 (AC-3-4). **NO gatea W3 entera.** | Su catálogo publicado de deeplinks lista `connect`, `disconnect`, `signAndSendTransaction`, `signAllTransactions`, `signTransaction`, `signMessage` y `browse` — **`signIn` no está** `[HEREDADO: estado del arte §1.2, §2.1]`. Requiere el teléfono del founder. |
| **M-2** | ~~¿El relayer cubre el ALQUILER o sólo la comisión?~~ | 🔻 **RETIRADO en la revisión 2.** Existía **sólo** para gatear W2, y W2 se fue. La pregunta la responde la HU `071` **construyéndola**, no preguntándole a un relayer de terceros: su `DT-1` pone al facilitator como `payer` de los `init` y graba on-chain quién puso el alquiler | Su criterio de aprobación **no se pierde**: es el mismo delta de balance que la `071` ya exige como señal del **paso 6** de su runbook (*«un primer depósito desde una billetera con 0 lamports confirma; su refund confirma; ninguno le cobra lamports»*, `071/sdd.md:1651`, `[MEDIDO-R2]`) y como su `AC-13` (`:604-613`) |
| **M-3** | 🔄 **REFORMULADA.** Ya **no** es *«¿puede el facilitator verificar la firma server-side?»* — **puede, y ya lo hace.** Es: **¿aceptamos perder el consentimiento a cambio de una firma menos?** | **W4 entera** | Ver el cuadro de abajo: la parte técnica está **medida y cerrada**; lo que queda es una decisión de riesgo con dueño |

#### 🔴 M-3, medida en la revisión 2 — la pregunta estaba mal planteada

**Lo que la revisión 1 daba por incógnito y está MEDIDO, en el código de hoy de
`wasiai-facilitator`:**

| Hecho | Cita | Marca |
|---|---|---|
| El facilitator **verifica criptográficamente** las firmas que vienen en la tx, sobre ese mensaje | `src/methods/solana-sponsor/sponsor-claims.ts:169` — `if (!tx.verifySignatures(false)) return reject('SIGNATURE_VERIFICATION_FAILED')`, con el `false` documentado en `:166-168` (*«no exigir que estén TODAS: la del feePayer todavía no existe»*) | `[MEDIDO-R2]` |
| El `sender` sale de la **ix `deposit`**, nunca del body, y su firma tiene que estar **presente y no nula** | `sponsor-claims.ts:155-163` (`DEPOSIT_ACCOUNT_INDEX.SENDER`, `SENDER_SIGNATURE_ABSENT`, `SENDER_SIGNATURE_NULL`) | `[MEDIDO-R2]` |
| ⚠️ La cita de la revisión 1 (`sponsor-pop.ts:39-43`) apuntaba a un **docblock que lo declara**, no al código que lo hace | `sponsor-pop.ts:39-43` es la interfaz `SponsorPopFields` con el comentario *«sacado de la ix `deposit` (NUNCA del body)»* | `[MEDIDO-R2]` |

**⇒ La capacidad NO falta. Lo que el mensaje aparte aporta es OTRA COSA, y el propio repo la nombra
con esa palabra** — `src/routes/solana-sponsor.ts:27-31`, textual `[MEDIDO-R2]`:

> *«El input que rompe la propiedad si Guard B se cae: una tx firmada por la víctima `V`, capturada y
> reenviada por `A`. Sin Guard B, `A` consigue que el facilitator pague el gas de una transacción que
> `A` nunca autorizó. Guard A por sí solo NO lo detiene: la tx de `V` es válida y sus firmas
> verifican — **lo que falta ahí es el consentimiento, no la posesión**.»*

**Y qué es y qué no es ese mensaje, medido línea por línea:**

- **Lo que SÍ tiene**: está **atado a esa transacción**, porque una de sus 7 líneas es la firma del
  sender sobre esa tx (`tx: ${f.txSignatureB58}`, `sponsor-pop.ts:64`, `[MEDIDO-R2]`). Un mensaje de
  patrocinio capturado **no sirve para otra tx**.
- **Lo que NO tiene**: `sponsor-pop.ts:63-65` `[MEDIDO-R2]` construye exactamente 7 líneas — dominio,
  `sender`, `network`, `remittance`, `amount`, `mint`, `tx` — y **ninguna es una marca de tiempo ni
  un nonce**. ⇒ **sin `exp` y sin anti-replay propios.** Lo que acota el replay es el ciclo de vida
  de la transacción misma, no el mensaje.
- **Lo que el ataque NO consigue, y está medido en el repo**: el monto vive **adentro** de la tx
  (`deposit.data[88..96]`), o sea adentro de lo que `V` firmó; tocarlo invalida la firma y lo corta
  `A3`, que sigue en pie con Guard B caído. *«Se midió: víctima firma `10000000`, atacante sube a
  `1000000000` ⇒ `verifySignatures(false)` da `false` ⇒ 403 sin que Guard B participe»* —
  `solana-sponsor.ts:33-39`, `[MEDIDO-R2]`. Y el valor va **al escrow del propio sender**, con
  `release` y `refund` por delante (`:55-56`).

**⇒ Qué se pierde exactamente si se borra el mensaje**: un tercero con la tx capturada (y **sin** el
mensaje de patrocinio) consigue que **el facilitator pague el gas** de un depósito que nadie
autorizó. No consigue plata de la víctima, no consigue otro monto, no consigue otro destino.
El daño es **el gas del fee-payer**, que ya está acotado por el rate-limit y el tope diario
(`env.ts:255-265`, `[HEREDADO: 071/work-item.md F0-0]` — ⛔ **no re-medido acá**).

**⇒ W4 es una DECISIÓN DE RIESGO, no un bloqueo técnico.** Y por eso deja de necesitar una medición
para arrancar y pasa a necesitar **un dueño**.

**ACs de W0** — cada uno con su criterio de aprobación **medible**:

- **AC-0-1**: WHEN se ejecuta M-1 contra la app de Phantom instalada en el teléfono del founder,
  the system SHALL producir un artefacto archivado en `evidence/` que registre los TRES desenlaces
  posibles y cuál ocurrió: `SOPORTADO` (la billetera presentó un mensaje SIWS y devolvió
  `signature` + `signedMessage` verificables), `NO SOPORTADO` (la billetera respondió error o
  ignoró el método), o `NO SE PUDO PREGUNTAR` (no hubo teléfono, o la precondición de Testnet Mode
  no estaba activa). ⛔ *No pude preguntar* NO es *no soporta*: colapsarlos es FAIL del AC.
- **AC-0-2**: 🔻 **RETIRADO en la revisión 2** junto con M-2 y W2. Su criterio (el delta de balance
  de SOL antes y después, `0` ⇒ cubre) **no se pierde**: es la señal del paso 6 del runbook de la
  HU `071` y su `AC-13`. ⛔ **PROHIBIDO reescribirlo acá**: dos HUs midiendo lo mismo con dos
  criterios es cómo se descubre tarde que no eran el mismo.
- **AC-0-3** *(reescrito)*: WHEN se cierra M-3, the system SHALL registrar **por escrito y con un
  responsable nombrado** la decisión de riesgo, y esa decisión SHALL declarar: (a) que la
  verificación server-side de la firma **ya existe** (`sponsor-claims.ts:169`), (b) qué queda
  descubierto sin el mensaje de patrocinio — el gas de un depósito no autorizado por la víctima —,
  (c) con qué se acota, y (d) si se acepta o no. ⛔ **PROHIBIDO** cerrar M-3 con una respuesta
  técnica: la pregunta técnica ya está contestada y contestarla otra vez no decide nada.
- **AC-0-4**: WHEN se cierra W0, the system SHALL publicar la **línea de base ejecutada** de las
  cuatro métricas de §3 (saltos, travesías de la pantalla de entrada, firmas, SOL exigido) para
  los DOS caminos, derivada de una corrida real, y SHALL declarar explícitamente si el número de
  firmas del camino inyectado es 3 o 4 (MI-1). ⛔ Copiar el número de §2 de este documento es FAIL.
- **AC-0-5**: IF M-1 queda en `NO SE PUDO PREGUNTAR`, THEN the system SHALL registrar ese estado
  como tal y SHALL bloquear **únicamente** el AC que esa medición gatea (AC-3-4), sin bloquear
  ninguna otra ola.

---

### W1 · El navegador de la billetera como camino principal

Existe un deeplink **`browse`** que abre la app **DENTRO** de Phantom, donde el provider está
inyectado: **cero saltos entre apps, cero remontajes, cada firma es un modal en la misma página**
`[HEREDADO: estado del arte §1.3]`.

⚠️ **El efecto de segundo orden que hay que escribir, porque es plata**: la cuenta de nonce
duradero **sólo existe en el camino por enlace** (`solana-wallet.ts:897`, `[MEDIDO-R2]`) ⇒ **el
camino principal la elimina, y elimina su alquiler de 0,00144768 SOL, sin escribir una línea de
código para eliminarla**. La aritmética completa y su límite están en §3.

⛔ Y el corolario del respaldo: **el código del nonce NO se borra en W1** (CD-3, CD-5). Desaparece
por dejar de ser alcanzable en el camino principal, no por deleción.

**ACs de W1:**

- **AC-1-1**: WHEN una persona abre Chaski en el navegador común de un celular y **tiene** la
  billetera instalada, the system SHALL ofrecerle abrir la app dentro del navegador de la
  billetera, y ese salto SHALL ocurrir **dentro de un gesto de la persona** (nunca desde un efecto
  de montaje). *Motivo medido: la navegación programática fuera de un gesto la descartan los
  navegadores móviles sin error y sin rastro* — `flow.tsx:286` `[HEREDADO: mapa §6]`.
- **AC-1-2**: WHILE la app corre dentro del navegador de la billetera, the system SHALL completar
  el envío entero con **0 saltos entre apps** y **0 remontajes del árbol**, y SHALL atravesar la
  pantalla de entrada **exactamente 1 vez**.
- **AC-1-3**: WHILE la app corre dentro del navegador de la billetera, the system SHALL **no crear
  ninguna cuenta de nonce duradero** y SHALL exigir el umbral del camino inyectado
  (`SENDER_MIN_LAMPORTS_FOR_DEPOSIT`), no el del camino por enlace. ⛔ the system SHALL **NO**
  cambiar el **valor** de ninguna de las dos constantes: elige cuál aplica, no cuánto vale (CD-12).
- **AC-1-4** *(reescrito en la revisión 2 — `MI-2` cerrado por la decisión D-3 del founder)*:
  IF la persona **no tiene** la billetera instalada, THEN the system SHALL ofrecerle **instalarla y
  crear su billetera**, y ese ofrecimiento SHALL terminar en el mismo recorrido principal (el
  navegador de la billetera), no en una pantalla sin salida. ⛔ the system SHALL **NO** ofrecer una
  billetera custodial ni embebida (CD-2).
- **AC-1-4b** *(nuevo, revisión 2 — el borde que D-3 no resuelve solo)*: WHILE la persona vuelve de
  instalar la billetera, the system SHALL conservar el estado del envío que ya había cargado, o
  SHALL decirle explícitamente que tiene que empezar de nuevo. ⛔ **PROHIBIDO** el tercer desenlace:
  volver a una pantalla que perdió los datos **sin decirlo**. ⚠️ Que el `localStorage` sobreviva al
  salto es una de **las cuatro cosas que el repo declara SIN VERIFICAR** (`solana-wallet.ts:894`,
  `[MEDIDO-F1]`, CD-11) ⇒ este AC **no puede cerrarse por lectura de código**.
- **AC-1-5**: WHERE el camino por enlace profundo sigue habilitado, the system SHALL conservarlo
  funcional y SHALL conservar el código del durable nonce sin borrar. IF un diff de W1 elimina
  archivos de `src/infrastructure/solana/deeplink/**` o `src/infrastructure/solana/nonce-duradero.ts`,
  THEN es **BLOQUEANTE** en AR (CD-3, CD-5).
- **AC-1-6**: WHEN se cierra W1, the system SHALL publicar el conteo de invocaciones de
  `prepare()` por envío en el camino principal, y ese conteo SHALL ser **1**, con **0** órdenes de
  payout huérfanas (§6).

---

### W2 · 🔻 RETIRADA — **es la HU `071` de `chaski-v3`**

> **Ruta del expediente completo:**
> **`chaski-v3/doc/sdd/071-facilitator-adelanta-el-alquiler/`**
> — `work-item.md` (F1, 2026-08-19) · `sdd.md` (F2, **revisión 2**, 159 KB, en `AR(spec)`) ·
> `decision-2026-08-31-rama-legado-retirada.md` (la enmienda del founder) · `index-row.md`.
> ⚠️ Esa carpeta está bajo un `doc/` **gitignoreado** (`chaski-v3/.gitignore:36`) ⇒ **`grep` no la
> encuentra**. Es literalmente la razón por la que la revisión 1 de este work-item la re-derivó.

**Qué decía W2**: *«Que la persona no necesite tener SOL para mandar USDC»*, con ATA idempotente +
transferencia en la misma tx y el gas patrocinado.

**Qué es en realidad**: la parte visible de una HU de **tres repos** con **upgrade del programa
Anchor**, que la `071` ya tiene diseñada y atacada por dos rondas de AR. Lo que W2 no veía, y que
hace que no pueda vivir en una ola de UX:

| Lo que W2 no contemplaba | Dónde está resuelto en la `071` | Marca |
|---|---|---|
| El guard anti-drenaje del facilitator **rechaza el 100 %** de las tx que esto produce: Check 5 nombra textualmente al rent-payer como vector de drenaje | `DT-5` / `Check 5′`, `071/sdd.md:744-789` | `[MEDIDO-R2]` |
| El alquiler **vuelve a quien lo puso**, grabado on-chain, o es un desagüe repetible por el camino feliz | `DT-1`, `AC-1`, `AC-2`, `AC-3` (`071/sdd.md:646-662`, `:510-518`) | `[MEDIDO-R2]` |
| **Hay que cobrarlo en USDC** (decisión D-4 del founder), y eso vive en el agente de FX, fuera de los tres repos | `DT-9`, `AC-8`, y el Scope OUT de `071/sdd.md:1442-1443` | `[MEDIDO-R2]` |
| A SOL cero **el remitente no puede pagar su propio refund** ⇒ hay que patrocinarlo también, con un **cuarto validador** que hoy no existe | `DT-7`, `AC-13`, ítems 2.9-2.11 | `[MEDIDO-R2]` |
| Una recuperación **sin el usuario**, con su componente y su productor por reloj medido corriendo | `AC-11` / `AC-11b` / `DT-17` | `[MEDIDO-R2]` |
| Un **medidor de expuesto** con dos particiones, porque el contador diario de comisiones queda ciego al 99,87 % de la salida | `DT-6`, `AC-4`/`4b`/`4c`, `CD-31` | `[MEDIDO-R2]` |

⇒ **Retirar W2 no es diferir trabajo: es dejar de duplicarlo con la mitad del contexto.**

#### 🔴 El único residuo de W2 que la `071` NO absorbe

W2 pedía la instrucción **`CreateIdempotent`** del Associated Token Program para que la cuenta de
tokens del remitente se cree en la misma transacción. **La `071` NO hace eso**, y lo declara: su
`AC-13` exige como **precondición** que *«su ATA de USDC ya existente»*, porque
`Deposit.sender_ata` es `mut` **sin `init` ni `init_if_needed`**, así que una billetera con 0
lamports **y sin ATA** revierte con `AccountNotInitialized` (**3012**) y el diagnóstico manda a
mirar el lugar equivocado — `071/sdd.md:604-613`, `[MEDIDO-R2]`. La `071` argumenta que la
precondición se cumple sola (*«para depositar hay que tener USDC, y tener USDC implica tener la
ATA»*).

⇒ **Se declara como deuda con nombre: `TD-372-ATA-DEL-SENDER`.** No es de esta HU (necesita tocar el
programa) y no es un bloqueante de la `071` (su propio SDD lo evaluó y lo cerró con razón escrita).
⛔ Lo que **no** puede pasar es que se vaya en silencio al borrar W2, que es exactamente lo que
habría pasado sin este párrafo.

⚠️ **Y el dato que la revisión 1 dejó medido a medias, que va con el residuo**: `cr1.ts:32`
importa `ASSOCIATED_TOKEN_PROGRAM_ID` `[MEDIDO-F1]`, y **qué hace con ese símbolo sigue
`[NO MEDIDO]`**. Era `MI-4`; ahora es una pregunta de `TD-372-ATA-DEL-SENDER`, no de esta HU.

---

### W3 · Sesión del lado del servidor

Las **dos firmas de identidad prueban lo mismo**, y existen porque **la app no tiene sesión**: sin
ellas, `POST /api/payout/prepare` sería *«un oráculo de existencia y estado de verificaciones de
identidad ajenas»* — `chaski-v3/app/api/payout/prepare/route.ts:183-190` `[MEDIDO-F1]`, leído
textual, incluida la aclaración de que **cerraba esa ruta y no el sistema** (`:191-193`: el mismo
oráculo sigue abierto en `app/api/payout/validate/route.ts`).

Con sesión, **la segunda firma sobra**. Y el estado del arte lo respalda por otra vía: ningún
regulador exige una firma de mensaje separada, la regla de EEUU que lo hubiera exigido **fue
retirada en agosto de 2024**, y la guía de la EBA dice que una dirección verificada **se
whitelistea sin re-verificar** `[HEREDADO: estado del arte §4.2, §4.3, §4.8]`. De siete rampas
investigadas, **ninguna pide dos firmas** `[HEREDADO: §4.5]`.

🔴 **DISTINCIÓN CRÍTICA — dos ACs separados, no la colapses:**

> El objetivo **«sesión»** NO depende de que Phantom soporte SIWS por enlace. **Aunque no lo
> soporte, la sesión igual borra la segunda firma.** Lo único que M-1 decide es si conectar +
> firmar se funden en **un** permiso o quedan en **dos**.

**ACs de W3:**

- **AC-3-1**: WHEN una persona ya probó la posesión de su dirección en esta sesión, the system
  SHALL **no** pedirle una segunda firma de identidad antes del payout.
- **AC-3-2**: WHILE existe una sesión válida del lado del servidor, the system SHALL autorizar
  `POST /api/payout/prepare` con esa sesión, y SHALL conservar la propiedad que el PoP garantizaba:
  un caller **sin** sesión y **sin** PoP SHALL recibir el **mismo** 403 para un `kycVerificationId`
  real, uno ajeno y uno inventado, **sin ninguna llamada al proveedor de identidad**
  (`route.ts:183-190`, y su test nombrado `T-PR-4`, `[MEDIDO-F1]`).
- **AC-3-3**: WHERE la sesión no existe o expiró, the system SHALL degradar al PoP de payout, y
  SHALL **no** dejar la ruta abierta.
- **AC-3-4**: WHERE M-1 resolvió `SOPORTADO`, the system SHALL fundir el `connect` y la firma de
  identidad en **un solo permiso** presentado a la persona. ⚠️ **Este AC, y sólo este, queda
  gateado por M-1.** IF M-1 resolvió `NO SOPORTADO` o `NO SE PUDO PREGUNTAR`, THEN AC-3-4 SHALL
  declararse **DEFERIDO con razón escrita**, y AC-3-1..3-3 SHALL cerrarse igual.
- **AC-3-5**: WHEN se cierra W3, the system SHALL conservar la **PRIMERA** firma de identidad. Su
  eliminación está fuera de alcance con razón escrita (§5.2).
- **AC-3-6**: WHEN la persona ve el paso de identidad, the system SHALL decirle **qué está
  firmando, que es gratis, que no mueve plata, y que se hace una sola vez para esa dirección**.
  *Las cuatro son verificables y la última es la que baja la ansiedad* `[HEREDADO: §4.9 veredicto,
  punto 3]`.

---

### W4 · La firma de patrocinio — 🔄 **reescrita: es una decisión de riesgo**

La impone `wasiai-facilitator` (nuestro, otro repo) — **no** el Coordinador ni ninguno de los 3
agentes. Hoy **no puede pedirse antes del depósito** porque el mensaje de patrocinio lleva la firma
del depósito **adentro**: *«⛔ El orden `firmar-tx` → `firmar-patrocinio` es fijo (AC-6) y no es
una convención: el mensaje de patrocinio lleva ADENTRO la firma de la transacción, así que pedirlo
antes es imposible»* — `chaski-v3/src/infrastructure/solana/deeplink/firma-por-enlace.ts:884-885`
`[MEDIDO-F1]`, leído textual.

🔴 **Lo que la revisión 2 midió y cambia el planteo entero (el cuadro completo está en §4/W0, M-3):**

1. **El facilitator YA verifica la firma del depósito server-side.** `sponsor-claims.ts:169` corre
   `tx.verifySignatures(false)` y `:155-163` deriva el `sender` de la ix `deposit`, nunca del body
   `[MEDIDO-R2]`. ⇒ **la pregunta «¿puede?» estaba mal planteada: puede, y lo hace en cada pedido.**
2. **Lo que el mensaje aparte aporta es CONSENTIMIENTO, no posesión** — con esa palabra, en
   `src/routes/solana-sponsor.ts:28-31` `[MEDIDO-R2]`.
3. **Ese mensaje no tiene `exp` ni anti-replay propios**: son 7 líneas y ninguna es tiempo ni nonce
   (`sponsor-pop.ts:63-65`, `[MEDIDO-R2]`). Sí está **atado a esa tx** por su última línea.
4. **Lo que se pierde al borrarlo, acotado**: un tercero con la tx capturada le hace **pagar el gas**
   al facilitator por un depósito que la víctima no autorizó. No consigue plata de la víctima, ni
   otro monto, ni otro destino (`solana-sponsor.ts:33-39`, `:55-56`, `[MEDIDO-R2]`), y el gasto está
   acotado por el rate-limit y el tope diario `[HEREDADO, no re-medido acá]`.

⇒ **W4 no espera una medición: espera una decisión.** Y por eso puede cerrarse **hoy**, en
cualquiera de las dos direcciones, sin escribir código.

**ACs de W4** *(reescritos en la revisión 2)*:

- **AC-4-1** *(reescrito)*: WHEN se decide sobre W4, the system SHALL registrar una **decisión de
  riesgo escrita**, con responsable nombrado y fecha, que declare los cuatro hechos medidos de
  arriba y elija entre **conservar** el mensaje de patrocinio o **retirarlo**. ⛔ **PROHIBIDO**
  cerrar W4 con *«el facilitator no puede verificar la firma»*: es falso y está medido
  (`sponsor-claims.ts:169`).
- **AC-4-2** *(reescrito)*: IF la decisión es **retirar** el mensaje, THEN the system SHALL declarar
  por escrito **qué reemplaza al consentimiento**, y esa declaración SHALL nombrar el input concreto
  que queda descubierto (una tx capturada y reenviada por un tercero) y el instrumento que lo acota,
  con su número. ⛔ *«ya lo cubre el rate-limit»* sin el número **no** cumple este AC.
- **AC-4-2b** *(nuevo)*: WHILE el facilitator co-firma como fee payer, the system SHALL conservar la
  **separación de dominio** entre el leg de payout y el de patrocinio, o SHALL declarar por escrito
  qué la reemplaza. *`SPONSOR_POP_DOMAIN = 'WasiAI Sponsor Request v1'` existe justamente para que
  una firma legítima de otro challenge no sirva acá, y su propio comentario nombra el test que lo
  cubre de verdad (`T-B5b`, no `T-B5`, porque `T-B5` seguiría verde aunque la constante se borrara
  entera)* — `sponsor-pop.ts:23-31` `[MEDIDO-R2]`.
- **AC-4-3** *(reescrito)*: IF la decisión es **conservar** el mensaje, THEN W4 SHALL cerrarse **sin
  cambios de código**, el objetivo de §3 SHALL quedar en **3 firmas** y no en 2, y la razón SHALL
  quedar escrita en el reporte. ⛔ Cerrarla así **no es un fracaso de la ola**: es uno de sus dos
  desenlaces válidos.
- **AC-4-4** *(sin cambios)*: WHEN se despliega cualquier cambio de W4, the system SHALL desplegar
  **primero** el facilitator aceptando **las dos** formas (con y sin mensaje de patrocinio) y
  **después** Chaski dejando de mandarlo (§9.4). ⛔ El orden inverso deja **todo depósito sin
  transmitir**.
- **AC-4-5** *(nuevo)*: IF la decisión de AC-4-1 se toma **después** de que la HU `071` haya
  desplegado su `Check 5′`, THEN the system SHALL re-verificar los cuatro hechos medidos contra el
  código de ese momento. *`cr1.ts` es exactamente el archivo que la `071` reescribe
  (`071/sdd.md:1225-1226`, `[MEDIDO-R2]`), y una medición de hoy sobre un archivo que otra HU va a
  reescribir es una foto.*

---

## 5 · Scope IN / OUT, por repo

### 5.1 · Scope IN

| Repo | Qué entra | Olas |
|---|---|---|
| **`chaski-v3`** | El motor de enlace y la elección de camino: `src/infrastructure/solana-wallet.ts` (la rama de `:897`), `src/infrastructure/solana/deeplink/**`, `src/infrastructure/solana/preparacion-por-enlace.ts` | W1 |
| | La máquina de pantallas y el aterrizaje de la vuelta: `src/presentation/flow.tsx` (⚠️ 4453 líneas, líneas físicas larguísimas y **citas ancladas por número** — leer con `sed -n 'Np' \| cut -c1-N`), `src/presentation/barra-destinos.tsx`, `splash*` | W1 |
| | Los umbrales de SOL: `src/application/solana-escrow-rent.ts` — ⚠️ **SÓLO para elegir cuál de las dos constantes aplica al recorrido principal. NO se cambia ningún valor** (CD-12) | W1 |
| | La sesión server-side y los dos guards de identidad: `app/api/payout/prepare/route.ts`, `app/api/kyc/verdict/route.ts`, `app/api/a2a/payout/challenge/route.ts`, `src/application/use-cases/connect-wallet.ts` | W3 |
| | El orquestador del envío: `src/application/use-cases/confirm-and-send.ts` (las 3 invocaciones de `prepare()`, §6) | W1 |
| | El copy del paso de identidad | W3 |
| **`wasiai-facilitator`** | `src/methods/solana-sponsor/sponsor-pop.ts`, `src/methods/solana-sponsor/sponsor-claims.ts`, `src/routes/solana-sponsor.ts` — ⚠️ **sólo si AC-4-1 decide retirar el mensaje**; si decide conservarlo, **0 líneas** | W4 |
| **`wasiai-a2a`** | ⚠️ **Casi nada, y a propósito**: sólo `doc/sdd/233-recorrido-movil-sin-saltos/**` y **una fila** en `doc/sdd/_INDEX.md`. **0 líneas en `src/`.** | todas |

⛔ **`src/methods/solana-sponsor/cr1.ts` SALIÓ del Scope IN en la revisión 2.** Entraba por W2, y
W2 se fue. Ese archivo lo reescribe la HU `071` (`Check 5′`) ⇒ **un diff de esta HU que lo toque es
un choque, no una contribución.**

### 5.2 · Scope OUT — declarado, con la razón

- 🔻 ⛔ **NUEVO Y EL MÁS IMPORTANTE: que el remitente no necesite SOL.** Es la **HU `071` de
  `chaski-v3`** (`doc/sdd/071-facilitator-adelanta-el-alquiler/`), confirmada por el founder (D-1) y
  con su cobro en USDC como requisito (D-4). ⛔ **PROHIBIDO** que cualquier ola de esta HU baje un
  umbral de SOL, patrocine alquiler, o afirme que el remitente no necesita SOL. → CD-12.
- ⛔ **La arquitectura A2A.** Chaski sigue hablándole al Coordinador, que sigue trayendo los 3
  agentes (`remit-corridor-fx`, `remit-kyc-validator`, `remit-cashout-payout`). **No se saca
  ninguno ni se reemplaza por llamadas directas.** → CD-1.
- ⛔ **Billeteras custodiales o embebidas** (Privy, Turnkey, Web3Auth, Dynamic, Phantom Connect).
  El producto es **no custodial por posicionamiento**: la pantalla dice literalmente *«tu plata no
  pasa por Chaski»*. Una clave generada y resguardada por un tercero contratado por nosotros
  contradice esa frase aunque técnicamente funcione. → CD-2. ⚠️ **Y esto acota `AC-1-4`**: la
  decisión D-3 del founder (instalar y crear la billetera) es la respuesta, y no habilita la
  alternativa embebida.
- ⛔ **El durable nonce como patrón**: se descarta. Es de custodios / firma offline / multisig,
  choca con las firmas parciales del fee payer, y es herramienta documentada de los *drainers*
  `[HEREDADO: estado del arte §2.7]`. ⚠️ **Pero el código que ya existe NO se borra en W1**:
  desaparece por no ser alcanzable en el camino principal. Borrarlo es una **ola posterior con
  guard de residuo**, fuera de esta HU. → CD-5.
- ⛔ **Eliminar la PRIMERA firma de identidad.** La investigación lo desmintió: es la opción de
  **MENOR fricción** (la alternativa de industria es una micro-transacción, que cuesta plata y es
  peor — su propio especialista la describe como *«cumbersome, adds friction and offers a poor
  experience»*), y el patrón de derivarla del depósito **no existe en la industria**
  `[HEREDADO: estado del arte §4.9, §7.3]`. **Se queda.**
- ⛔ **Cambiar de proveedor de KYC.**
- ⛔ **MWA (Mobile Wallet Adapter)** como plataforma: no funciona en **ningún** navegador de iOS y
  la limitación es del sistema operativo, no del roadmap `[HEREDADO: §1.1]`.
- ⛔ **Session keys on-chain**: requieren soporte en el programa; una transferencia de USDC va
  contra el SPL Token Program, que no lo tiene `[HEREDADO: §2.5]`.
- ⛔ **Diseñar contra el límite de 4096 bytes**: no está activado en mainnet `[HEREDADO: §2.2]`.
- ⛔ **La creación idempotente de la ATA del sender** ⇒ `TD-372-ATA-DEL-SENDER` (§4/W2). Necesita
  tocar el programa; la `071` la evaluó y la cerró como precondición con razón escrita.
- ⛔ **Arreglar el otro oráculo**: `app/api/payout/validate/route.ts` es público y no pide PoP
  (`prepare/route.ts:191-193`, `[MEDIDO-F1]`). Es un hallazgo real, **no es de esta HU**, y va a
  **TD-372-ORACULO-VALIDATE**.
- ⛔ **Cambiar el `discriminador [4,0,0,0]` del `nonceAdvance`**, que es gemelo de una constante
  del facilitator `[HEREDADO: mapa §7]`. Sacar el nonce del camino principal no lo rompe;
  cambiarlo sí.

---

## 6 · El costo que esta HU corrige de paso

El camino por enlace corre `prepare()` **3 veces por envío**. El propio código lo declara, y lo leí
textual — `chaski-v3/src/application/use-cases/confirm-and-send.ts:437-443` `[MEDIDO-F1]`:

> *«un recorrido por enlace que cierre bien son TRES invocaciones de `execute()`, o sea **tres
> `prepare()`**, o sea tres órdenes de payout reales creadas server-side, tres atestaciones y tres
> filas de ledger. La remesa guarda sólo el ÚLTIMO `payoutId`: las dos anteriores quedan
> huérfanas.»*

Cada `prepare()` es una llamada real a `/compose` del Coordinador ⇒ **3 invocaciones pagas del
agente de cash-out y 2 órdenes de payout huérfanas por envío**.

Y **cada reanudación agranda el conjunto de destinos que el guard del settle acepta** — `:458-462`
`[MEDIDO-F1]`, textual: *«El guard S3.5 del settle acepta CUALQUIERA de las direcciones preparadas
(`registered.includes(...)`), así que cada reanudación agranda el conjunto de destinos que el
servidor acepta, de forma monótona.»*

⚠️ **Esto es aritmética de los saltos, no del contrato A2A.** Con 0 saltos, `prepare()` corre una
vez. Por eso lo cierra **W1** y no una HU de facturación. → AC-1-6.

⛔ Y lo que NO se toca: el mismo bloque explica por qué **no se puede saltear el `prepare` al
reanudar** (`:445-450`, `[MEDIDO-F1]`): sería firmar contra un `beneficiary` leído de
`localStorage`, o sea **perder la atestación server-side**. Es DT-4(b) del repo y **no se ablanda**.

---

## 7 · Decisiones técnicas (DT-N)

- **DT-1 · El camino principal es el navegador de la billetera, no un mejor manejo del salto.**
  Fundamento medido: 4 de las 6 vueltas del camino por enlace aterrizan en la pantalla de entrada,
  y **eso no es un bug**: es el arreglo deliberado de HU-075, porque la navegación automática desde
  un efecto de montaje **la descartan los navegadores móviles sin error y sin rastro**
  `[HEREDADO: mapa §6, citando `flow.tsx:286` con la foto `t=12830 ms` del teléfono del founder]`.
  ⇒ mejorar el aterrizaje no puede bajar de 2 toques por firma. Eliminar el salto sí.
- **DT-2 · El durable nonce se retira por INALCANZABILIDAD, no por deleción.** Se apoya en el gate
  ya existente de `solana-wallet.ts:897` `[MEDIDO-R2]`. Beneficio: la HU no puede romper el camino
  de respaldo, porque no toca su código.
- **DT-3 · La sesión se agrega como camino ADITIVO al PoP, no como reemplazo en el mismo
  despliegue.** El servidor acepta las dos formas; el cliente deja de firmar después; el PoP se
  retira al final o nunca. Fundamento: §9.3.
- **DT-4 · 🔄 TRANSFERIDA A LA HU `071` (revisión 2).** Decía *«el umbral de SOL baja DESPUÉS de que
  el patrocinio esté medido cubriendo, nunca antes»*. Sigue siendo cierta y **ya vive allá**, con
  más detalle del que tenía acá: su `CD-8` (prohibido afirmar el cero mientras el refund patrocinado
  no esté vivo **en producción**), su `CD-11` (prohibido volver **condicional** el umbral: dos
  lecturas que discrepan ⇒ tx revertida en cadena) y el paso 6 de su runbook
  (`071/sdd.md:1304-1311`, `:1651`, `[MEDIDO-R2]`). **Lo que queda acá es la mitad prohibitiva**:
  esta HU no baja ningún umbral (CD-12).
- **DT-5 · La primera firma de identidad se queda y lo que se trabaja es el COPY.** Fundamento:
  §5.2 y `[HEREDADO: estado del arte §4.9]`.
- **DT-6 · `signAndSendTransaction` sigue sin implementarse.** No es una omisión heredada, es una
  decisión escrita: *«⛔ NO se implementa `signAndSendTransaction`, y la omisión es la decisión: el
  depósito de Chaski es PATROCINADO. El facilitator es el `feePayer`… Que la billetera lo mandara
  sola rompería ese diseño»* — `chaski-v3/src/infrastructure/solana/deeplink/protocol.ts:34-38`
  `[MEDIDO-F1]`, textual. ⚠️ **Y hay un comentario del repo que dice lo contrario y hay que
  ignorarlo**: `preparacion-por-enlace.ts:396` afirma que *«la billetera no transmite (su protocolo
  no implementa `signAndSendTransaction`)»* `[HEREDADO: mapa §8.1]`. Las dos billeteras **sí**
  ofrecen el método; la omisión es nuestra. Quien lea el segundo descarta una salida creyendo que
  no existe.
- **DT-7 · La línea de base se ejecuta, no se cita.** Fundamento: §2, MI-1, y el precedente de la
  fila 232 de este índice (*«todo número con testigo mecánico que lo RE-DERIVA salió exacto; todo
  número sin ese testigo estaba mal»*).
- **DT-8 · Un SDD por ola, no uno para las tres.** Este work-item es el paraguas. Fundamento: el
  orden entre olas es load-bearing y el de despliegue dentro de cada ola también; un SDD único
  produce un diff que nadie puede desplegar por partes, que es exactamente el riesgo de §9.
- **DT-9 · 🆕 El hueco de `W2` no se renumera.** Renumerar rompe todas las referencias externas ya
  publicadas a `W3`/`W4` (la fila 233 del `_INDEX.md` las nombra por número); dejar el hueco rompe
  cero y deja el registro de por qué se fue. **Se eligió el que rompe menos, no el más prolijo.**
- **DT-10 · 🆕 Las dos HUs se serializan sobre `chaski-v3`, aunque no compartan una sola decisión.**
  No es acoplamiento de diseño (§0.1): es que **tocan los mismos archivos**. `solana-wallet.ts`
  (esta HU en `:897`, la `071` en `:651-658`, `:747-751`, `:1400-1420`, `:1640-1660`), `flow.tsx`
  y `flow-vm.ts`. Con el orden de §0, la `071` re-deriva sus citas después de W1 (§0.2).

---

## 8 · Constraint Directives (CD-N)

- **CD-1** ⛔ **PROHIBIDO tocar la arquitectura A2A.** Chaski le sigue hablando al Coordinador y el
  Coordinador sigue trayendo los 3 agentes. Ningún leg pasa a llamada directa. **El contenido que
  Chaski le entrega a cada agente SHALL seguir siendo el mismo string que hoy le entrega.** IF un
  diff cambia el cuerpo de una llamada a `/compose`, THEN es **BLOQUEANTE**.
- **CD-2** ⛔ **PROHIBIDA cualquier custodia de la clave de la persona.** Ni billeteras embebidas,
  ni MPC, ni TEE de terceros, ni claves efímeras que la app pueda usar sin la persona. **OBLIGATORIO
  que la frase «tu plata no pasa por Chaski» siga siendo literalmente cierta después de esta HU.**
- **CD-3** ⛔ **PROHIBIDO apagar o borrar el recorrido por enlace profundo.** Queda **encendido**
  como respaldo. IF un diff lo apaga por bandera, borra sus archivos, o lo deja sin camino de
  entrada, THEN es **BLOQUEANTE** en AR.
- **CD-4** ⛔ **PROHIBIDO que una ola arranque sobre una medición no hecha.** M-1 gatea AC-3-4.
  **OBLIGATORIO que cada medición tenga TRES desenlaces** —sí / no / no se pudo preguntar— y
  **PROHIBIDO colapsar «no pude preguntar» en «no»**. ⚠️ **Revisión 2**: `M-2` se retiró y `M-3`
  dejó de ser una medición para ser una **decisión** ⇒ esta CD hoy aplica **sólo a M-1**, y decirlo
  evita que alguien la cite para frenar W4.
- **CD-5** ⛔ **PROHIBIDO borrar el código del durable nonce en esta HU.** Su retiro es por
  inalcanzabilidad (DT-2). El borrado es una ola posterior **con guard de residuo**.
- **CD-6** 🔄 **RETIRADA en la revisión 2 — se fue con W2.** Decía *«prohibido bajar el umbral de
  SOL del cliente antes de que M-2 responda CUBRE»*. Su contenido vive en la HU `071` (`CD-8`,
  `CD-11`, y el orden del paso 6 de su runbook). **Acá la reemplaza CD-12**, que es más fuerte:
  esta HU no baja ningún umbral, ni con medición ni sin ella.
- **CD-7** ⛔ **PROHIBIDO que el cliente deje de mandar una prueba antes de que el servidor acepte
  su reemplazo.** Aplica a W3 (PoP → sesión) y a W4 (mensaje de patrocinio → verificación
  server-side). **OBLIGATORIO desplegar el receptor primero, aceptando las DOS formas.** Este CD es
  la lección del corte de 8 días de agosto, escrita como regla.
- **CD-8** ⛔ **PROHIBIDO publicar un número de saltos, firmas o SOL sin decir de qué camino habla
  y cómo se derivó.** Un número sin su camino y sin su instrumento no es una medición. Aplica
  también a los números de §2 y §3 de **este** documento.
- **CD-9** ⛔ **Este work-item es registro histórico y NO se re-ancla.** Sus citas numeran el árbol
  de F1 (y las marcadas `[MEDIDO-R2]`, el del 2026-08-31).
- **CD-10** ⛔ **PROHIBIDO tocar `doc/sdd/_INDEX.md` por encima de la línea 144.**
  `src/lib/capability-risk.ts:82` y `src/lib/capability-risk.test.ts:56` citan `_INDEX.md:144`, y
  esa cita es de código del camino del dinero: mover cualquier línea por encima la rompe en
  silencio `[MEDIDO-F1: `doc/sdd/_INDEX.md:254-262`]`. **La fila nueva va al FINAL de la tabla**, y
  su actualización se hace **en su propia línea**, sin insertar ni borrar líneas por encima.
- **CD-11** ⛔ **PROHIBIDO convertir en afirmación del código cualquiera de las cuatro cosas que
  `solana-wallet.ts:894` declara sin verificar** (que la billetera vuelva al mismo origen · que el
  `localStorage` sobreviva al salto · que la tx devuelta sea byte-idéntica · que el blockhash
  aguante el viaje) **sin el reporte del founder pegado al lado**. Es CD-10 de la HU anterior,
  todavía vigente `[MEDIDO-F1]`. ⚠️ La segunda es **precondición de `AC-1-4b`**.
- **CD-12** 🆕 ⛔ **PROHIBIDO que esta HU toque el VALOR de cualquier constante de umbral de SOL**
  (`SENDER_MIN_LAMPORTS_FOR_DEPOSIT`, `SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT`, sus sumandos o su
  derivación), patrocine alquiler, o construya una transacción con instrucciones nuevas de creación
  de cuentas. **Eso es la HU `071`.** W1 elige **cuál** de las dos constantes aplica al recorrido
  principal; no cambia **cuánto** vale ninguna. Y ⛔ **PROHIBIDO** que cualquier documento, copy o
  reporte de esta HU diga *«el remitente no necesita SOL»*: después de W1 sigue necesitando
  **0,0088746 SOL**.
- **CD-13** 🆕 ⛔ **PROHIBIDO re-derivar el diseño de la HU `071` desde este repo.** Si algo de ella
  hace falta, se **cita** su expediente (`chaski-v3/doc/sdd/071-facilitator-adelanta-el-alquiler/`).
  ⚠️ **Y para encontrarlo hay que saber esto**: ese `doc/` está **gitignoreado**
  (`chaski-v3/.gitignore:36`) ⇒ **`grep` da CERO sobre él y el cero es falso**. Usar rutas
  explícitas o `--no-ignore`. **Es la causa raíz medida del solapamiento que la revisión 2
  deshizo.**

---

## 9 · Análisis de riesgo del camino del dinero — qué pasa si una ola se despliega a medias

> **El precedente**: el corte de 8 días de agosto fue un error de **ORDEN**, no de código — se
> encendió la auth de un agente **antes** de sembrar el secreto en los llamadores. Dos de las tres
> olas vivas tienen exactamente esa forma. Por eso cada una lleva su orden escrito.

### 9.1 · W1 a medias

| Escenario | Consecuencia | Mitigación |
|---|---|---|
| El `browse` se enciende y el camino por enlace se apaga «porque ya no hace falta» | Quien **no** tiene la billetera instalada queda **sin ningún camino** para depositar | CD-3 + AC-1-5: el respaldo queda encendido y su borrado es BLOQUEANTE |
| Alguien borra el código del nonce creyendo que W1 lo eliminó | **Todo depósito por el camino de respaldo se rompe** | CD-5 + AC-1-5 |
| El `browse` se dispara desde un efecto de montaje en vez de un gesto | El navegador móvil lo descarta **sin error y sin rastro**: la persona se queda mirando la pantalla | AC-1-1, con el precedente medido de `flow.tsx:286` |
| La persona vuelve de instalar la billetera y perdió los datos del envío, **sin aviso** | Abandona, y el equipo lo lee como «no le interesó» | AC-1-4b, y ⚠️ **no se puede cerrar por lectura**: depende de que el `localStorage` sobreviva al salto, que es una de las cuatro sin verificar (CD-11) |
| **Sentido del despliegue** | W1 es **cliente-only** y **aditiva**: no cambia ningún contrato de servidor ⇒ **no tiene orden entre repos**. Es la única de las tres que no lo tiene. | — |

### 9.2 · 🔻 RETIRADA — era el análisis de W2

El peor cuadrante que describía (bajar el umbral del cliente **antes** de que el patrocinio cubra ⇒
**tx revertida en cadena con el escrow a medio crear**) **sigue siendo real y sigue siendo el peor**,
pero es de la HU `071`, que ya lo tiene escrito con más precisión: su `R-3`, su `DT-11` con **las
cuatro combinaciones (CR-1 × programa × cliente) evaluadas y la peor nombrada**
(`071/sdd.md:1020-1025`, `[MEDIDO-R2]`), y su bandera `RENT_PAYER_IS_FACILITATOR` naciendo en
`false`. ⛔ **No se duplica acá.** Lo único que esta HU aporta al tema es **no meterse** (CD-12).

### 9.3 · W3 a medias

| Orden | Qué pasa |
|---|---|
| ⛔ **MAL**: el cliente deja de mandar `popChallenge`/`popSignature` → después el servidor acepta sesión | **403 `payout_pop_unverified` para todos**: ningún envío llega a `prepare`. Corte total del producto. |
| ✅ **BIEN** | (1) el servidor acepta **PoP o sesión** → (2) el cliente empieza a usar sesión → (3) el PoP se retira, o no se retira nunca (DT-3) |
| Riesgo silencioso | Aflojar el guard sin sesión equivalente **reabre el oráculo de verificaciones ajenas** que `route.ts:183-190` `[MEDIDO-F1]` cerró, gastando cupo del proveedor por intento. Lo cubre AC-3-2 exigiendo el **mismo 403 y cero llamadas al proveedor** para los tres casos. |

### 9.4 · W4 a medias

| Orden | Qué pasa |
|---|---|
| ⛔ **MAL**: Chaski deja de pedir la firma de patrocinio → después el facilitator deja de exigirla | El facilitator responde 403 y **ningún depósito se transmite**. Y la plata ya se movió del lado de la persona: es el peor cuadrante. |
| ✅ **BIEN** | (1) facilitator acepta las **dos** formas → (2) Chaski deja de pedir el mensaje → (3) el facilitator deja de aceptar la vieja | AC-4-4 |
| Riesgo de seguridad, **ahora cuantificado** | Sin el mensaje, una tx capturada le hace **pagar el gas** al facilitator por un depósito no autorizado. No es *«un atacante puede patrocinarse lo que quiera»*: el monto y el destino viven adentro de lo que la víctima firmó (`solana-sponsor.ts:33-39`, `[MEDIDO-R2]`). **Es una decisión de riesgo con techo, y AC-4-2 exige que ese techo se escriba con su número.** |
| ⚠️ Riesgo de **cita** | `cr1.ts` y su entorno los reescribe la HU `071` ⇒ una medición de hoy sobre ese código es una foto. AC-4-5. |

### 9.5 · Riesgos transversales

- **Un HTTP que falla NO prueba que no se pagó.** Vale para el leg del facilitator igual que para
  el del gateway. Ninguna ola puede reportar `fallido` sobre una disposición desconocida.
  ⚠️ El propio `solana-sponsor.ts:41-47` `[MEDIDO-R2]` lo tiene escrito como **tres desenlaces**
  (`salió` / `no salió` / `NO SÉ`) y aclara que el tercero se decide por `CosignResult.sent` y **no**
  por el código del primitivo.
- **La ventana de 10 minutos del permiso PoP** contra los 20 del viaje: hoy un recorrido de 6
  saltos con 2 toques cada uno compite contra esos 10 minutos, y **cuánto tarda el recorrido real
  es `[NO MEDIDO]`** `[HEREDADO: mapa §6]`. W1 lo vuelve irrelevante para el camino principal; para
  el de respaldo **sigue abierto y no lo cierra esta HU**.
- **La cadena envejece sola.** Los números de alquiler de `solana-escrow-rent.ts` son mediciones
  con fecha, y el propio archivo lo declara: *«si volvés a medirlo y da otro número, el que tiene
  razón es el RPC y no este comentario»* (`:325-326`, `[MEDIDO-R2]`).
- **Precondición operativa del founder, heredada y NO opcional**: el **Testnet Mode** de Phantom es
  precondición del enlace profundo; sin él la billetera vuelve **sin nada y sin error**. Cualquier
  medición de W0 hecha sin esa precondición mide otra cosa.
- 🆕 **El riesgo de proceso que esta revisión materializó**: **una carpeta `doc/` gitignoreada hace
  invisible una HU entera para `grep`**. Costó una ola re-derivada con la mitad del contexto. → CD-13.

---

## 10 · Missing Inputs

| # | Qué falta | Estado |
|---|---|---|
| **MI-1** | **Cuántas firmas tiene el camino inyectado: 3 o 4.** El informe de terreno se contradice (§2). No se puede resolver leyendo: exige ejecutar. | `[resuelto en W0 / AC-0-4]` — no bloquea F2 |
| **MI-2** | ~~Qué ve quien NO tiene la billetera instalada~~ | ✅ **CERRADO 2026-08-31 por decisión del founder (D-3)**: *«si el usuario no tiene Phantom se le pide instalar y crear su wallet»*. ⇒ `AC-1-4` reescrito, y `AC-1-4b` **nuevo** para el borde que la frase no cubre (qué pasa con el envío a medio cargar cuando vuelve). ⛔ **PROHIBIDO** leer D-3 como habilitación de una billetera embebida: CD-2 sigue en pie |
| **MI-3** | **Las respuestas de W0.** 🔄 **Eran 3, ahora es 1**: sólo **M-1**, y exige el teléfono del founder con Testnet Mode activo. `M-2` se retiró con W2; `M-3` dejó de ser una medición | `[bloqueante por AC]` — M-1 → **sólo AC-3-4** |
| **MI-4** | ~~Qué hace `cr1.ts` con `ASSOCIATED_TOKEN_PROGRAM_ID`~~ | 🔄 **MOVIDO fuera de esta HU** con W2. Sigue `[NO MEDIDO]` y pasa a ser pregunta de `TD-372-ATA-DEL-SENDER`. ⚠️ Y ese archivo lo reescribe la `071` ⇒ medirlo hoy es medir una foto |
| **MI-5** | **El gate real de `wasiai-facilitator`.** Cité `npm run qa` de memoria heredada. ⛔ **Antes de citarlo, leer sus `scripts` en `package.json`**: el nombre del gate **no se hereda entre repos** — en `wasiai-a2a` no existe. ⚠️ Sólo hace falta **si W4 decide retirar el mensaje**; si lo conserva, esta HU no toca ese repo | `[resuelto en F2 de W4]` |
| **MI-6** | **Los nombres de rama son propuestas sin verificar.** No corrí `git`. | `[resuelto en F2]` |
| **MI-7** | **Cuánto tarda el recorrido real** y si el PoP de 10 min alcanza para el camino de respaldo. | `[NO MEDIDO]` — declarado como riesgo residual (§9.5), **fuera de alcance** |
| **MI-8** | **Si el `browse` de Phantom tiene hoy restricciones de las guidelines de Apple** para dApps de terceros en navegadores in-app. La única fuente hallada es un blog viejo de Trust Wallet, marcado `NO VERIFICADO` en el propio informe. | `[NO MEDIDO]` — se verifica en W0 junto con M-1, mismo teléfono |
| **MI-9** | 🆕 **Quién firma la decisión de riesgo de W4** (AC-4-1). No es una medición y no la puede tomar un agente: es aceptar o no un vector de gasto sobre la billetera caliente. | `[NEEDS CLARIFICATION]` — **bloquea el cierre de W4**, no su F2 |

---

## 11 · Análisis de paralelismo

- **W0 no bloquea la escritura de los SDD de W1** (W1 no depende de M-1). ⇒ **W0 y el F2 de W1
  pueden correr en paralelo.**
- **W1 bloquea a las demás en VALOR, no en código**: sin W1 el recorrido sigue teniendo 6 saltos y
  el resto son mejoras de un camino que igual se pierde. Y **W1 es la única que baja el SOL exigido
  sin depender de nada** (por eliminación del nonce, DT-2) — y **sólo hasta 0,0088746** (§3).
- **W3 y W4 son independientes entre sí** — tocan archivos disjuntos (guards de identidad vs. el
  mensaje de patrocinio) y repos distintos.
- **W4 depende de una decisión (MI-9) y de nadie más.** Puede resolverse antes que W3, o cerrarse
  sin trabajo (AC-4-3).
- 🆕 **Roce REAL y medido con la HU `071` de `chaski-v3`**: **no comparten ninguna decisión** (§0.1)
  pero **comparten archivos** (§0.2, DT-10). ⇒ **serializar sobre `chaski-v3`** en el orden de §0, y
  la `071` re-deriva sus citas de `solana-wallet.ts` después de W1.
  ⛔ Y **`cr1.ts` es de la `071`, no de esta HU** (§5.1).
- **Roce con otras HUs en vuelo**: `[NO MEDIDO]`. No corrí `git branch` ni miré worktrees. F2 debe
  medirlo antes de elegir base, con atención a `flow.tsx` (155 citas entrantes `[HEREDADO]`) y a
  `solana-wallet.ts` (**76 citas ancladas por debajo de `:893`**, `[MEDIDO-R2]`).
- **Bloquea a**: nada identificado. **Es bloqueada por**: nada de código; sólo por M-1 (un AC) y por
  MI-9 (el cierre de W4).

---

## 12 · Definition of Ready — estado

| Criterio | Estado |
|---|---|
| Problema y motivo escritos | ✅ |
| Alcance IN/OUT por repo | ✅ — con el OUT más importante **nuevo**: que el remitente no necesite SOL es la HU `071` |
| ACs en EARS, ≥3 por ola | ✅ (W0: 4 vivos + 1 retirado · W1: 7 · W3: 6 · W4: 6 = **23 vivos**) |
| ACs de W0 con criterio de aprobación medible | ✅ — y `AC-0-3` cambió de *medición* a *decisión escrita con dueño* |
| AC explícito de cómo se mide el éxito | ✅ (§3 + AC-0-4 + AC-1-2/1-3/1-6) |
| **El objetivo NO promete lo que la HU no entrega** | ✅ **corregido en la revisión 2**: «SOL exigido 0» salió; queda 0,0088746 tras W1 (CD-12) |
| Decisiones técnicas | ✅ (10, una transferida a la `071`) |
| Constraint Directives | ✅ (13, una retirada; incluidas las 4 obligatorias: CD-1 A2A intacta · CD-2 no custodial · CD-3 respaldo encendido · CD-4 ninguna ola sobre una medición no hecha) |
| Riesgo del camino del dinero por despliegue parcial | ✅ (§9, con el orden correcto de cada ola) |
| Missing Inputs declarados | ✅ (9; **MI-2 cerrado**, MI-4 movido fuera, **MI-9 nuevo y abierto**) |
| Sizing decidido | ✅ QUALITY / **M-L**, con recomendación de partir en 3+1 SDDs (DT-8) |
| **Sin solapamiento con otra HU** | ✅ **verificado en la revisión 2 contra el expediente de la `071`** (work-item + sdd rev. 2), con el orden consolidado en §0 |

---

*Work item · F1 **revisión 2** · 2026-08-31 · NexusAgil Analyst · sin shell (`Read`/`Write`/`Glob`)*
