# SDD · [WKH-374] · **OLA W1** — Las cinco pantallas del recorrido nuevo, detrás de la bandera apagada

> **Repo ancla del artefacto**: `wasiai-a2a` (`doc/sdd/234-recorrido-de-la-dapp-de-cero/`).
> **Repo del trabajo**: `chaski-v3` — **todo**. En `wasiai-a2a/src/` esta ola escribe **cero líneas** (CD-3, AC-15).
> **Árbol de referencia**: `chaski-v3` `main` = `origin/main` = **`25c3f73aad8f01c25fc26ed644f688b7db98783b`**, árbol limpio. Todo lo que sigue se midió sobre él.
> **Modo**: QUALITY. Alcance de este SDD: **W1 y sólo W1** (DT-8). ⛔ W2 (borrador durable + vale) y W3 (encendido + teléfono) tienen su propio SDD.
> **Estado previo**: **W0 DONE**, aprobada por F4, desplegada. Sus ocho mediciones y sus cuatro decisiones (`DT-1`, `DT-4`, `DT-5`, `DT-6`) son entrada de este documento, no se re-discuten.

---

## §0 · Cómo se leen las citas de este documento

Este F2 corrió **con shell**. Herramientas usadas: `/usr/bin/grep`, `/usr/bin/git`, `/usr/bin/find`,
`sed -n`, `wc -l`, `node -e`. ⛔ Ningún `cat`, ningún `npx` suelto.

| Etiqueta | Qué significa |
|---|---|
| `[MEDIDO]` | Lo corrí o lo abrí en el árbol de hoy, en esta sesión, sobre `25c3f73`. |
| `[HEREDADO]` | Lo afirma otro documento de esta carpeta. **No lo re-verifiqué**, y digo de dónde sale. |
| `[NO MEDIDO]` | Nadie lo midió. Incógnita declarada. |

**Cuatro reglas de cita que este documento se aplica a sí mismo**, heredadas de `CD-W0-8` y de las
lecciones del `auto-blindaje.md` de esta misma HU:

1. ⛔ **Ninguna cita de acá está en formato ANCLADO** (el par `` `símbolo`, `ruta:NN` `` que
   `src/composition/citas-ancladas.test.ts:73` recolecta). El formato de este documento es
   `` `símbolo` en `ruta:NN` `` — un par partido a propósito, para que ni siquiera un copiado
   accidental hacia `chaski-v3` corra un marcador de censo.
2. **Toda cita a un test lleva el NOMBRE del `it`, no sólo el número.** Nada vigila las citas entre
   repos: **7 se rompieron en WKH-372 por esta causa** `[HEREDADO]` de `auto-blindaje.md` de la 233.
3. **Todo número de línea salió de un `/usr/bin/grep -n` del símbolo**, nunca del rango con el que
   leí el archivo.
4. **Todo número de este documento se re-derivó en esta sesión**, incluidos los que W0 ya había
   publicado. Lo que W0 midió sobre `c1bd8d3` lo volví a medir sobre `25c3f73`: coincide, y lo digo
   en §13.1 en vez de heredarlo.

---

## §1 · Qué construye W1, qué resuelve este SDD, y qué deja explícitamente afuera

**W1 construye las cinco pantallas del recorrido nuevo, en un árbol propio, con la bandera APAGADA.**
Nada de lo que W1 escribe se ejecuta en producción hasta W3.

| | Qué | Veredicto de este SDD |
|---|---|---|
| **La tensión del router** | El candado de `L-5` pone rojo todo `next/link` en `src/`+`app/`, y moverse entre pantallas con navegación blanda sería lo natural | 🟢 **Opción (a): el recorrido nuevo NO usa router de cliente.** Cambia de pantalla por estado. El candado queda **byte-idéntico** y `L-5` **no se re-deriva**. Cuatro mediciones lo deciden: §3 |
| **`DT-7`** | El plegado exacto de 8 pantallas a 5 | 🟢 **Resuelto**: §4, con qué ve la persona en cada una |
| **Cómo se guarda el envío** | El work-item lo mete en W2 (borrador durable); W1 necesita algo hoy | 🟢 **Resuelto sin abrir superficie nueva**: se usa el puerto que ya existe, `RemittanceRepository`. ⛔ Cero claves nuevas de `localStorage`, cero PII nueva at-rest: §5 |
| **Anuncio, salto y vuelta** | AC-5 · AC-6 · AC-7 · AC-8 | 🟢 **Resuelto**: el paso de aterrizaje es una **función pura de la marca de vuelta**, no de un estado recordado. §6 |
| **`CD-W0-7`** | La obligación que W0 dejó: un `it` que monte el árbol NUEVO y le aplique las 4 aserciones de disco | 🟢 **Diseñado, y con el agujero de vacuidad ya medido y cerrado**: §10.3 |
| **`MI-10`** | ¿Se sostiene el techo de prosa de producción contra el 53,0 % de la casa? | 🟡 **Se sostiene, con UNA excepción declarada de antemano y con su número**: §13.2 y §15 |

**Deja afuera, a propósito y con dueño:**

- ⛔ **El borrador del lado del servidor y el vale de vuelta** (`DT-3`, AC-10, AC-11, AC-12) → **W2**.
  W1 deja **la costura**, no la implementación: §5.3.
- ⛔ **El encendido de la bandera y toda medición en teléfono** → **W3**. `CD-8` del work-item lo
  prohíbe explícitamente en el mismo cambio que la introduce.
- ⛔ **El retiro del camino viejo** (`RET-2`/`RET-3` de W0) → **HU propia**, no una tarea al pie de W3.
- ⛔ **AC-14 sobre el árbol NUEVO** → **W3**. Lo que W1 sí entrega es el argumento de dos patas que
  hace que el cuadrante de Phantom **no pueda** haber empeorado con la bandera apagada: §10.5.

---

## §2 · Context Map (Codebase Grounding)

Archivos abiertos en esta sesión, con lo que extraje de cada uno. **Todo `@25c3f73`.**

| # | Archivo (`chaski-v3` salvo aviso) | Por qué lo leí | Qué extraje |
|---|---|---|---|
| **W-1** | `src/presentation/el-salto-remonta-el-arbol.test.tsx` | 🔴 **El sujeto de la tensión** | 296 líneas. `PATRONES` en `:71` — **seis**, import-shaped / call-shaped / JSX-shaped. `SELF` en `:45`. `DIRS` = las **cuatro** raíces en `:36`. Las tres aserciones de ocurrencia permitida (`import-next-navigation`, `import-next-link`, `elemento-Link`) y el control negativo sintético |
| **W-2** | `src/presentation/splash-puerta.ts` | 🔴 **La medición que decide la tensión** | `urlDeVueltaDeKyc` en `:54`: devuelve `` `${origin}/?${PARAM_KYC}=${VALOR_VUELTA_KYC}` `` — **la vuelta del verificador está clavada a la RAÍZ `/`, en producción**. `MotivoParaNoMostrar` en `:68-73`, cinco motivos. `motivoParaNoMostrar` en `:84`, falla cerrado |
| **W-3** | `src/infrastructure/solana/deeplink/sesion.ts` | La otra vuelta | `MARCA = "dl"` en `:480`. `MARCAS_DE_VUELTA` y `enlaceDeVuelta` **los dos en `:495`** (Δ0), con `MARCAS_DE_VUELTA` = seis valores. `enlaceDeVuelta(origen, paso)` arma la vuelta **sobre el href ACTUAL** |
| **W-4** | `app/page.tsx` | El punto de montaje y el interruptor | **36 líneas.** `<Splash/>` en `:21`, `<DiagnosticoDeVuelta/>` en `:32`, `<RemittanceFlow/>` en `:33`. Dos marcadores `[[CENSO src/presentation/flow.tsx …]]` en `:23` y `:24`. ⛔ **Cero citas ANCLADAS propias** (medido con el regex del candado ⇒ 0 hits) |
| **W-5** | `src/presentation/barra-destinos.test.tsx` | 🔴 **Mina medida sobre `app/page.tsx`** | `it("🔴 el único `<RemittanceFlow>` de producción NO pasa `pasoInicial`")` en `:303`: exige `toContain("<RemittanceFlow")` **y** `not.toContain("pasoInicial")` **sobre el fuente entero**, comentarios incluidos |
| **W-6** | `src/presentation/diagnostico-de-vuelta.test.tsx` | 🔴 **Segunda mina sobre `app/page.tsx`** | `it("T-DIAG-CABLEADO: `app/page.tsx` importa y monta el bloque, fuera de todo comentario")` en `:435`: exige la línea de import literal **y** `<DiagnosticoDeVuelta />` fuera de comentario, con calibración propia |
| **W-7** | `src/presentation/ola-2-pantallas.test.tsx` | El candado del sistema de diseño | 502 líneas. Barre `src`+`app` no-test para el vocabulario retirado (`T-O2-1`), **pero `T-O2-2` mira una lista de DOS archivos escritos a mano** (`src/presentation/flow.tsx`, `src/presentation/ui.tsx`), en `:130` ⇒ **el árbol nuevo queda afuera**. `clasesDe` en `:89` |
| **W-8** | `src/presentation/honest-copy.test.tsx` | El candado de copy honesto | 1049 líneas. `it("ninguna pantalla del recorrido mete un em dash")` en `:476` monta el árbol **viejo**. Los dos barridos de prosa (`SCAN_DIRS` en `:637`) sí barren `src`+`app` enteros |
| **W-9** | `src/presentation/ui.tsx` | El sistema de diseño a reusar | `Button` `:78`, `Card` `:101`, `Field` `:112`, `TextInput` `:142`, `Row` `:157`, `Pill` `:200`, `Muted` `:243`, `Aviso` `:295`, `Money` `:346`, **`Stepper({ steps, current })` `:370`** — el stepper ya deriva los tramos de `steps.length` |
| **W-10** | `src/presentation/wallet-availability.ts` | El patrón de bandera (`DT-2`) y los hooks de billetera | `mwaEnabled` `:98` y `deeplinkEnabled` `:156` — opt-in estricto, sólo el literal `"true"`; el gotcha `NEXT_PUBLIC_` del build en `:95-96` y `:152-154`. `useWalletAvailability` `:36`, `useConnectedWalletAddress` `:62` |
| **W-11** | `src/presentation/wallet-availability.test.tsx` | El molde de AC-13 | `it("T-065-20: sólo el literal `true` prende; ausente, vacía, `1`, `TRUE` y `true ` NO")` en `:1021`; `it("T-065-21: con la bandera APAGADA el paso `connect` es byte-idéntico al de hoy")` en `:1037`, con la mitad falsadora `.not.toBe(apagada)` en `:1066` y el `toBeTruthy()` de CD-18 en `:1048`. ⚠️ **`C-5` de W0 confirmado: en ese `it` NO existe ningún `toBe(apagada)`** — verificado de nuevo acá |
| **W-12** | `src/presentation/sesion-borra-la-segunda-firma.test.tsx` | `CD-W0-7` | `it("T-372-W3-8: tras una recarga (almacén nuevo), la PRIMERA firma se vuelve a pedir y la sesión no está en ningún disco")` en `:539`; las **cuatro aserciones de disco** en `:556-565`: `localStorage`, `sessionStorage`, `document.cookie`, `window.location.href`, las cuatro con `.not.toContain(token)` |
| **W-13** | `src/composition/container.ts` | Los casos de uso a reusar | `Container` en `:50` — 14 campos requeridos + 5 opcionales; `createContainer()` `:96`; `getContainer()` `:265`. `previewQuote`, `createRemittance`, `connectWallet`, `startKyc`, `resumeKyc`, `lockQuote`, `confirmAndSend`, `trackRemittance` |
| **W-14** | `src/presentation/flow.tsx` | El sujeto que ⛔ **no se toca** | **4453 líneas** (`wc -l`). `Step` `:88`; `STEP_LABELS` `:89` — **4 etiquetas**; `STEP_INDEX` `:90-99` — **8 pasos + 3 destinos**; `pasoInicial` como costura de test en `:144`; `urlDeVueltaDeKyc(window.location.origin)` en `:446` |
| **W-15** | `src/infrastructure/persistence.ts` | Dónde vive el envío hoy | `KEY = "chaski.remittances.v1"` en `:15`; `LocalRepo` en `:92`; el `setItem` del blob entero en `:114`; `save()` en `:117`. **El snapshot incluye `beneficiary`**, o sea nombre **y CCI**, ya at-rest en este navegador |
| **W-16** | `src/domain/remittance.ts` | La forma del envío | `Beneficiary` en `:48-54`: `name`, `country`, `method`, `destination` (el CCI). `beneficiary` en el snapshot en `:253`; `Remittance.create` en `:279` |
| **W-17** | `src/composition/readme-test-count.test.ts` | 🔴 **La mina que W0 descubrió tarde (`C-1`)** | `READMES` en `:87` — **dos**, con un marcador por idioma; `TEST_FILE` en `:54`. **Medido hoy: 174 archivos**, y los dos README lo declaran (`README.md:436`, `README.es.md:462`) |
| **W-18** | `src/composition/citas-ancladas.test.ts` | El candado del Δ0 | El regex `ANCLADA` en `:73`; `SELF` en `:56`; `SCAN_DIRS` en `:51`. **Los seis destinos de censo del repo, derivados con `grep -rno`**: §8.2 |
| **W-19** | `src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx` | El instrumento de W0 y el control de AC-14 | **1030 líneas.** `it("T-372-W1-13: recurrente ⇒ 1 travesía y 0 viajes a la billetera; primera vez ⇒ la recarga es del verificador")` en `:707`; `it("T-374-W0-0: …")` en `:806`; `it("T-374-W0-1: en el camino POR ENLACE, el TRAMO DE IDA atraviesa la pantalla de entrada 2 veces y sale a la billetera 1 vez")` en `:880` |
| **W-20** | `src/presentation/flow-vm.ts` | Copy y estados ya escritos, reusables | 1751 líneas, **72,4 % de prosa**. `escrowRentExplainer` `:426`, `humanError` `:572`, `statusDisplay` `:133`, `copyDeEnlace` `:1503`. ⚠️ **Lleva marcadores de censo SOBRE `flow.tsx`, pero él mismo NO es destino de censo** ⇒ importarlo y citarlo es libre |
| **W-21** | `package.json` | El gate | `:20` — `qa` = `lint && typecheck && typecheck:scripts && test`; `lint` (`:12`) = `biome lint src app scripts`; `build` (`:10`) = `next build --webpack` |
| **W-22** | `w0-report.md`, `adversarial-review-w0.md`, `code-review-w0.md`, `auto-blindaje.md` (esta carpeta) | **Auto-Blindaje histórico, obligatorio** | 444 + 130 + 134 + 332 líneas. Las lecciones heredadas están en `CD-W1-8` … `CD-W1-14` (§12), cada una con el error que previene |
| **W-23** | `sdd-w0.md`, `work-item.md` (esta carpeta) | El contrato | `DT-1`=opción B, `DT-4`, `DT-5`, `DT-6` cerrados; `CD-1`…`CD-14` y `CD-W0-1`…`CD-W0-14` vigentes |

**Auto-Blindaje leído (paso obligatorio de F2).** `doc/sdd/_INDEX.md` de `wasiai-a2a` da como últimas
HUs cerradas la **233** (WKH-372) y la **234/W0** (esta misma). Leí los dos `auto-blindaje.md`.
**Patrón recurrente encontrado, presente en las DOS**, y por eso entra a los CD de esta ola:

> 🔴 **Prosa que afirma más de lo que el código verifica.** En la 233 rompió 7 citas cruzadas; en la
> 234/W0 produjo **los dos bloqueantes del CR** (un guard que publicaba una cobertura que no tenía, y
> una superlativa —«42,8 % es el máximo del repo»— que un barrido refutó), **más los tres menores que
> el fix-pack no tomó**, los tres de la misma familia. ⇒ `CD-W1-8`.

Segundo patrón recurrente, también en las dos: **números y citas que el autor rompe con su propia
edición y no re-deriva** (la 233 lo llama «14 patas»; la 234/W0 lo repitió con tres conteos de
docblock y con **tres anclas partidas por un salto de línea**). ⇒ `CD-W1-9` y `CD-W1-10`.

---

## §3 · 🔴 LA TENSIÓN DEL ROUTER, RESUELTA — **opción (a)**, y la decide una medición de producción

### 3.1 · La tensión, enunciada sin adornos

`src/presentation/el-salto-remonta-el-arbol.test.tsx` `@25c3f73` pone **rojo cualquier `next/link` o
`<Link` en `src/` + `app/`**, con dos ocurrencias permitidas y las dos en la misma página apagada
(`app/kyc-simulado/page.tsx`) `[MEDIDO]`. Moverse entre las pantallas nuevas con navegación blanda es
el gesto más natural de W1 — el propio archivo lo dice en `:52-53`.

**Y la premisa que ese guard protege es más chica que lo que el guard prohíbe.** `L-5` afirma que **el
salto a la billetera** remonta el árbol; el guard afirma que **toda navegación de la app** lo hace.
Son dos cosas distintas, y el guard hoy no las distingue. Eso es cierto y no se disimula.

### 3.2 · El veredicto

> **El recorrido nuevo cambia de pantalla por ESTADO, en un solo punto de montaje (`app/page.tsx`),
> igual que el viejo. ⛔ Cero `useRouter`, cero `router.push`, cero `next/link`, cero rutas nuevas
> bajo `app/`. El candado de `L-5` queda BYTE-IDÉNTICO y `L-5` NO se re-deriva.**

### 3.3 · Las cuatro mediciones que lo deciden, y ninguna es de estilo

**(a) 🔴 LA QUE CIERRA LA DISCUSIÓN: la vuelta del verificador está clavada a la raíz `/`, en producción.**

`urlDeVueltaDeKyc` en `src/presentation/splash-puerta.ts:54` `@25c3f73` `[MEDIDO]` devuelve, textual,
`` `${origin}/?${PARAM_KYC}=${VALOR_VUELTA_KYC}` `` — o sea `https://…/?kyc=return`. **La barra está
escrita en la función.** Su único llamador de producción es `flow.tsx:446` `[MEDIDO]`, y su docblock
declara por qué existe: *«vivía como literal dentro de `flow.tsx`, y la puerta de acá abajo necesitaba
leer el MISMO parámetro»*.

⇒ Con la opción (b) —el recorrido repartido en rutas del App Router— **la vuelta del verificador
aterrizaría en `/`, que es la pantalla de ENTRADA**. Eso es exactamente lo que `AC-7` prohíbe con la
palabra «NUNCA» y lo que `CD-5` repite. Para evitarlo habría que cambiar `urlDeVueltaDeKyc`, que es
**producción compartida con el camino viejo**: el árbol nuevo estaría moviendo la vuelta del árbol
viejo. Es el modo de falla `M-2` del work-item, servido en bandeja.

**(b) La otra vuelta se arma sobre el href ACTUAL, así que las dos vueltas aterrizarían en sitios distintos.**

`enlaceDeVuelta(origen, paso)` en `src/infrastructure/solana/deeplink/sesion.ts:495` `@25c3f73`
`[MEDIDO]` construye el `redirect_link` **a partir del href donde la persona estaba** — sus tres
llamadores le pasan `p.hrefActual` (`deeplink/conexion.ts:229` y `:630`, `deeplink/pop-por-enlace.ts:271`)
`[MEDIDO]`. ⇒ un salto hecho desde `/firmar` volvería a `/firmar`, y el del verificador a `/`.
**Dos vueltas, dos aterrizajes, un solo consumidor.** La asimetría no existe hoy y sólo la crea (b).

**(c) El consumidor de la vuelta vive en UN solo sitio, y la app tiene DOS páginas en total.**

`/usr/bin/find app -name "page.tsx"` ⇒ **`app/page.tsx` y `app/kyc-simulado/page.tsx`**, nada más
`[MEDIDO]`. `app/page.tsx` monta `<Splash/>`, `<DiagnosticoDeVuelta/>` y `<RemittanceFlow/>` `[MEDIDO]`.
⇒ Con rutas, **cada ruta nueva tendría que volver a montar los tres**, o la vuelta cae donde nada la
consume. El propio repo ya tiene escrito qué pasa con una marca que ninguna rama reclama: cae en el
fallthrough y dispara `DEEPLINK_MARCA_SIN_CONSUMIDOR` (docblock de `sesion.ts:495` `[MEDIDO]`).

**(d) Con rutas, `AC-13` deja de ser medible, y `AC-3` gana un modo de falla que hoy no existe.**

`AC-13` exige que con la bandera apagada el comportamiento sea **byte-idéntico** al de hoy. Con un
solo punto de montaje eso es un ternario y se mide comparando el `innerHTML` del mismo nodo (molde de
`it("T-065-21: …")` en `wallet-availability.test.tsx:1037` `[MEDIDO]`). **Con rutas hay que contestar
qué hace `/enviar` con la bandera apagada** —¿404? ¿redirige? ¿monta el viejo?— y ninguna de las tres
tiene contraparte en el árbol de hoy contra la cual comparar. Un AC que no tiene contra qué compararse
no es un AC.

### 3.4 · Lo que la opción (a) NO compra, dicho antes de que alguien lea su verde de más

- ⛔ **No vuelve verdadera la frase «en esta app no hay navegación blanda».** Hay exactamente una, viva,
  en `app/kyc-simulado/page.tsx`, y el propio `it` de W0 la pinnea `[MEDIDO]`.
- ⛔ **No arregla que el guard sea más ancho que `L-5`.** Sigue siéndolo. La opción (a) hace que **eso
  no cueste nada**, no que deje de ser cierto. ⇒ `OBS-W1-1`.
- ⛔ **No da historial del navegador.** Con estado, el botón «atrás» del teléfono sale de la app en vez
  de retroceder un paso. **Hoy es igual** (el árbol viejo también cambia de paso por estado), así que
  esto **no empeora nada**; pero tampoco lo mejora, y ⛔ ningún AC lo pide. ⇒ `OBS-W1-2`, con dueño.

### 3.5 · La salida (b), y por qué se descarta **con su costo escrito**

Si algún día se quisiera (b), esto es lo que costaría, para que la decisión no haya que rehacerla:
re-derivar `L-5` a *«el salto a la billetera remonta el árbol»*, **re-justificar el vale de `DT-3`**
(hoy el vale existe porque la sesión no cruza; con navegación blanda entre pantallas la sesión **sí**
cruzaría entre ellas, y habría que decir de nuevo qué es lo que no cruza), **reescribir tres
aserciones del `it` de W0** que dos revisiones endurecieron —una a costa de un `BLQ-ALTO` y otra de un
`BLQ-MED`—, y mover `urlDeVueltaDeKyc`. ⛔ **Nada de eso está en el pedido del founder**, que fue
*«arrancá con las pantallas»`. La opción (b) queda documentada acá y **no se toma**.

---

## §4 · `DT-7` RESUELTO — el plegado de 8 pantallas a 5, y qué ve la persona en cada una

El work-item aprobó **el número**, no el mapeo (`MI-4`). Éste es el mapeo, y sale de `STEP_INDEX` en
`flow.tsx:90-99` `@25c3f73` `[MEDIDO]`.

| # | `id` | Nombre en pantalla | Qué ve la persona | De qué pasos viejos sale |
|---|---|---|---|---|
| **1** | `entrar` | **Entrar** | La marca, una frase de qué hace Chaski, y **un** botón: «Conectar mi billetera». Debajo, en letra chica: la afirmación no custodial y la salida a instalar Phantom. ⚠️ **Si el camino que le toca a este navegador sale a la billetera, la pantalla lo dice ANTES de que toque el botón** (AC-5) | `bienvenida` + `connect` |
| **2** | `envio` | **Cuánto y para quién** | Monto en USDC, quién recibe (nombre + CCI) **y la cotización en vivo en la misma pantalla**: cuánto llega en PEN, la comisión y quién la cobra. **Se guarda solo** (§5). Un botón: «Seguir» | `send` + `review` |
| **3** | `identidad` | **Tu identidad** | **Sólo la primera vez.** Qué se verifica, con quién, y que se sale a otra pantalla **y se vuelve acá mismo**. Un botón | `verify` |
| **4** | `firmar` | **Firmar y enviar** | **Qué se firma, exactamente, y cuánto sale**: monto + comisión + alquiler del escrow, y a dónde va la plata. Anuncia el salto antes de darlo. Un botón | `confirm` |
| **5** | `seguimiento` | **Seguimiento** | Dónde va el envío, y el recibo cuando cierra | `track` + `done` |

**Cuatro decisiones que van con el mapeo, y cada una tiene su candado en §10:**

1. **`AC-1` sale del ORDEN, no de una pantalla nueva.** `connect` era el paso **3** del recorrido
   viejo (B-5 del work-item) `[HEREDADO]`; acá es el **1**, y eso es lo que da la dirección con la que
   el envío puede guardarse.
2. **`AC-4` se cumple en los dos casos, no en uno.** La pantalla 3 es condicional, así que un envío
   recurrente muestra **4** pantallas y uno de primera vez **5**. ⇒ el stepper **no** recibe la tabla:
   recibe el **itinerario calculado para esta persona**, y el invariante es
   `etiquetas.length === itinerario.length` **siempre**. La tabla enumerable que `AC-2` pide sigue
   teniendo 5 y sigue siendo el único sitio donde el conjunto está escrito.
3. **`AC-3` es una salida por pantalla, no un botón global.** De la 2 en adelante, cada pantalla ofrece
   «Volver» que retrocede **un** paso y ⛔ **no borra** monto, beneficiario ni CCI. Eso cierra el
   defecto que `flow.tsx:807` declara **ABIERTO y sin candado**, textual `[HEREDADO]` de B-7.
4. ⛔ **La pantalla 4 NO escribe ningún número de firmas como literal.** El anuncio enumera **las
   firmas que el camino elegido va a pedir**, derivadas en runtime, y la pantalla renderiza el largo
   de esa lista. **Eso no es publicar la métrica**: `CD-W0-14` prohíbe *publicar* `2` o `3` como
   número de salidas del recorrido mientras W4 de WKH-372 no tenga decisión del founder, y un texto
   que la pantalla deriva en vivo no es una métrica de cierre. ⇒ `CD-W1-6`, con su candado.

---

## §5 · Cómo se guarda el envío en W1 — **sin abrir una sola superficie nueva**

### 5.1 · El veredicto

> **W1 no inventa ningún almacén.** El envío se guarda por el puerto que ya existe,
> `RemittanceRepository`, cuya única implementación de navegador es `LocalRepo` en
> `src/infrastructure/persistence.ts:92` `@25c3f73`, bajo la clave que ya existe,
> `KEY = "chaski.remittances.v1"` en `:15` `[MEDIDO]`.
> ⛔ **Cero claves nuevas de `localStorage`. Cero PII nueva at-rest. Cero proveedor estrenado.**

### 5.2 · Por qué eso no es un atajo, sino la respuesta correcta para W1

**El CCI ya está at-rest en este navegador, hoy.** Medido: `LocalRepo.save` (`persistence.ts:117`)
serializa el snapshot entero con `JSON.stringify` en `:114`, y el snapshot incluye `beneficiary`
(`domain/remittance.ts:253`), cuyo campo `destination` **es el CCI de 20 dígitos** — el propio tipo lo
dice en `domain/remittance.ts:52-53` `[MEDIDO]`. ⇒ una clave nueva para el borrador **no protegería
nada** y **sí** agregaría un segundo sitio de escritura de la misma PII, que es la deuda que este
ecosistema ya pagó dos veces (`pop-proof-store.ts` / `sesion-store.ts`) `[HEREDADO]`.

**Y el caso que haría falta un borrador parcial no se da en el recorrido nuevo.** Los saltos salen de
la pantalla **1** (conectar) y de la **4** (firmar). La pantalla **2** —la única donde se tipea— no
salta. ⇒ **no hay ningún momento en que un envío a medio tipear tenga que sobrevivir a un salto.**
Esa es una consecuencia directa de «conectar es lo primero», y es la primera vez que se dice: el orden
nuevo **elimina** el problema en vez de resolverlo.

⇒ *«Se guarda solo»* significa, exactamente: **en cuanto el envío de la pantalla 2 está completo y
válido, se crea/actualiza por `container.createRemittance` y queda atado a la dirección conectada**.
Antes de eso no se escribe nada, y no hace falta.

### 5.3 · La costura que W1 deja para W2, y el candado que la protege

W2 tiene que poder cambiar **dónde** vive el borrador sin tocar una sola pantalla. ⇒

- ⛔ **Ninguna pantalla nueva toca `window.localStorage`, `sessionStorage`, `document.cookie` ni la
  URL.** Todo pasa por `container.<casoDeUso>`. Es **falsable con un barrido estático** de
  `src/presentation/recorrido/**` (§10.4), y es el mismo mecanismo con el que `RET-1` de W0 impide
  que el árbol nuevo duplique lógica de dominio.
- ⇒ El día que W2 escriba el adaptador server-side detrás de `RemittanceRepository`, **la pantalla no
  se entera**. Eso es lo que `AC-10` pide de W2; W1 sólo garantiza que sea posible.

### 5.4 · Lo que W1 ⛔ **NO** afirma sobre el guardado

- ⛔ **No** afirma que el envío sobreviva al salto al **navegador de la billetera**: eso es `L-4`, y
  `W0-6` lo dejó **NO MEDIDO** con dueño, instrumento, precondición (*Testnet Mode*) y fecha (W3)
  `[HEREDADO]` de `w0-report.md` §8. *«No se pudo medir»* ⛔ no es *«cruza»* ni *«no cruza»*.
- ⛔ **No** afirma nada sobre el vale, el identificador opaco ni el borrador durable: es W2.

---

## §6 · Cómo se anuncia el salto y cómo se vuelve — **AC-5 · AC-6 · AC-7 · AC-8**

### 6.1 · La regla, y de dónde sale su forma

> **El paso donde se aterriza es una FUNCIÓN PURA de la marca que trae la URL de vuelta.**
> ⛔ No de un estado recordado, ⛔ no del disco, ⛔ no de la sesión.

Y no es una preferencia: es lo único que puede funcionar. `W0-3` midió y dejó cerrado que **el salto
remonta el árbol** (`L-5` verdadera) `[HEREDADO]` de `w0-report.md` §1. Un árbol remontado **no
recuerda en qué paso estaba**. Lo único que cruza es la URL.

### 6.2 · El universo de marcas, derivado y no copiado

| Marca | Dónde vive | Qué la escribe |
|---|---|---|
| `?dl=<paso>` con `<paso>` ∈ `MARCAS_DE_VUELTA` (**seis**: `conectar`, `firmar-tx`, `firmar-patrocinio`, `crear-nonce`, `pop-payout`, `pop-kyc`) | `MARCA = "dl"` en `src/infrastructure/solana/deeplink/sesion.ts:480`; la tupla y `enlaceDeVuelta` los dos en `:495` `[MEDIDO]` | El salto por enlace profundo |
| `?kyc=return` | `PARAM_KYC` en `src/presentation/splash-puerta.ts:45` y `VALOR_VUELTA_KYC` en `:47` `[MEDIDO]` | El salto al verificador |
| `?wb=1` | `PARAM_SALIDA` en `src/presentation/salida-al-navegador-de-la-billetera.ts:50` y `VALOR_SALIDA` en `:60` `[MEDIDO]` | La salida al navegador **de** la billetera |

⛔ **Las tres se IMPORTAN de producción. Ningún literal de estos se escribe en el árbol nuevo ni en
sus tests.** El molde ya está en el repo: `motivoParaNoMostrar` en `splash-puerta.ts:84` compara
`params.get(PARAM_KYC)` y hace `params.has(MARCA)` **sin escribir ninguno de los dos strings**
`[MEDIDO]`.

### 6.3 · La tabla de aterrizaje, y el invariante que la vuelve falsable

`aterrizajeDe(marca) → paso`, en `src/presentation/recorrido/salto.ts`:

| Marca de vuelta | Aterriza en | Por qué |
|---|---|---|
| `dl=conectar` | **2 · `envio`** | Volvió de conectar ⇒ hay dirección ⇒ el paso siguiente |
| `dl=crear-nonce` | **4 · `firmar`** | Es un salto **dentro** de la preparación de la firma |
| `dl=firmar-tx` · `dl=firmar-patrocinio` | **5 · `seguimiento`** | La firma se dio ⇒ el envío ya está en curso |
| `dl=pop-payout` · `dl=pop-kyc` | **5 · `seguimiento`** | La prueba de posesión sirve para leer el estado, no para mover fondos |
| `kyc=return` | **3 · `identidad`** | 🔴 **Aterriza en `identidad`, no al principio.** Es el pedido textual del founder |
| `wb=1` | **el paso que la marca de salida ya lleva** | El módulo de salida ya transporta su propio contexto (`hrefSinLaMarcaDeSalida` en `:144`, `vinoDeUnaSalidaConBorrador` en `:179`) |

🔴 **EL INVARIANTE, y es lo único normativo de esta tabla:**

> ⛔ **Ninguna marca aterriza en `entrar`.** Ni en el camino feliz (`AC-7`) **ni en el de error**
> (`AC-8`). El error cambia el **motivo en pantalla**, ⛔ nunca el paso.

Y **la tabla no puede quedar incompleta en silencio**: el conjunto de marcas se **recorre desde
`MARCAS_DE_VUELTA`** (que es un **valor**, no un tipo — el docblock de `sesion.ts:495` explica que se
lo volvió valor justamente para poder recorrerlo en runtime `[MEDIDO]`), así que una séptima marca sin
aterrizaje pone rojo el `it`. **Hoy nada la caza**: el propio repo declara que una marca sin
consumidor cae en el fallthrough de `flow.tsx:4070` `[MEDIDO]` `[HEREDADO]`. ⇒ §10.2.

### 6.4 · Las tres pantallas del salto (AC-5, AC-6, AC-8)

| Momento | Qué hay en pantalla | AC |
|---|---|---|
| **Antes** | Un bloque que dice **qué** se va a firmar y **por qué**, con el botón que sale. ⛔ Nunca un salto sin aviso previo | `AC-5` |
| **Mientras** | Un estado con **texto**: «Estamos en tu billetera. Volvés acá mismo.» ⛔ Ni pantalla vacía ni `spinner` mudo | `AC-6` |
| **Si vuelve mal** | **El mismo paso** donde estaba, con el motivo legible que `humanError` / `copyDeEnlace` (`flow-vm.ts:572` y `:1503`) ya saben producir. ⛔ Nunca `entrar`, ⛔ nunca un estado que obligue a recargar a mano | `AC-8` |

⚠️ **`AC-6` tiene un límite que se declara y no se disimula**: mientras la persona está en la
billetera, **nuestra pantalla no está a la vista**. Lo que `AC-6` garantiza es **lo que encuentra al
volver la vista atrás**, no que alguien lo esté mirando. Decir otra cosa sería afirmar sobre un
artefacto que no se puede observar.

---

## §7 · El árbol de archivos, y el interruptor

### 7.1 · Los archivos de producción. **Seis: cinco nuevos y uno modificado**

| | Archivo (`chaski-v3`) | N/M | Qué contiene |
|---|---|---|---|
| **P1** | `src/presentation/recorrido/pasos.ts` | **NUEVO** | La **tabla única y enumerable** de los 5 pasos (`AC-2`), sus etiquetas, el itinerario condicional y las transiciones. ⛔ Cero JSX, cero DOM |
| **P2** | `src/presentation/recorrido/bandera.ts` | **NUEVO** | `recorridoV2Enabled()` — opt-in estricto, sólo el literal `"true"`, sobre `NEXT_PUBLIC_CHASKI_RECORRIDO_V2`, con el gotcha del build (`DT-2`) |
| **P3** | `src/presentation/recorrido/salto.ts` | **NUEVO** | Anuncio, estado en vuelo y **aterrizaje** (§6). Función pura sobre la URL. ⛔ Cero DOM |
| **P4** | `src/presentation/recorrido/pantallas.tsx` | **NUEVO** | Las **cinco** pantallas, como cinco componentes exportados |
| **P5** | `src/presentation/recorrido/recorrido.tsx` | **NUEVO** | El anfitrión `<Recorrido/>`: máquina de estado, stepper, salida no destructiva, cableado del `Container` |
| **P6** | `app/page.tsx` | **MODIFICADO** | El ternario de la bandera |

### 7.2 · El interruptor, exactamente

```tsx
// app/page.tsx — la forma, no el código final
{recorridoV2Enabled() ? <Recorrido /> : <RemittanceFlow />}
```

⚠️ **Y esa línea tiene tres condiciones medidas que no se pueden violar**: §8.1.

- La bandera es `NEXT_PUBLIC_CHASKI_RECORRIDO_V2`. **Verificado libre**: `grep -rn "CHASKI_RECORRIDO"`
  sobre `src app scripts contracts` ⇒ **cero hits** `[MEDIDO]`. Ninguna de las 15 `NEXT_PUBLIC_` del
  árbol colisiona.
- ⛔ **Se despliega APAGADA.** `CD-8` del work-item prohíbe prenderla en el mismo cambio que la
  introduce, **y el gotcha va escrito en el propio `bandera.ts`**: las `NEXT_PUBLIC_` las inlinea el
  **build**, así que cambiar el valor en Vercel y redesplegar el mismo artefacto **no hace nada**
  (`wallet-availability.ts:95-96` y `:152-154` `[MEDIDO]`).
- ⛔ **`flow.tsx` no se toca. Δ0 = 0.** Se verifica con `wc -l` ⇒ **4453**, contra el marcador
  `[[CENSO … lineas=4453]]`, ⛔ no leyendo el diff.

---

## §8 · 🔴 Las minas medidas de `app/page.tsx` — tres candados y tres citas sueltas

Este archivo tiene 36 líneas y **es el más vigilado del repo por línea escrita**. Todo esto se midió
en esta sesión y **ninguna de las cinco cosas está en el work-item**.

### 8.1 · Los dos candados que ya existen sobre su FUENTE

| # | Candado | Qué exige | Qué lo rompe |
|---|---|---|---|
| **M-A** | `it("🔴 el único `<RemittanceFlow>` de producción NO pasa `pasoInicial`")` en `src/presentation/barra-destinos.test.tsx:303` `[MEDIDO]` | `toContain("<RemittanceFlow")` **y** `not.toContain("pasoInicial")`, **sobre el fuente entero, comentarios incluidos** | 🔴 **Escribir la palabra `pasoInicial` en un docblock de `app/page.tsx`.** Y `<Recorrido/>` ⛔ **no puede** tener una prop con ese nombre si se la pasa desde ahí |
| **M-B** | `it("T-DIAG-CABLEADO: `app/page.tsx` importa y monta el bloque, fuera de todo comentario")` en `src/presentation/diagnostico-de-vuelta.test.tsx:435` `[MEDIDO]` | La línea de import literal de `DiagnosticoDeVuelta` **y** `<DiagnosticoDeVuelta />` fuera de comentario | Meter `<DiagnosticoDeVuelta/>` adentro del ternario de la bandera de forma que quede comentado, o cambiar la forma del import |

⇒ **`CD-W1-4`**: el ternario envuelve **sólo** `<RemittanceFlow/>` ↔ `<Recorrido/>`. `<Splash/>` y
`<DiagnosticoDeVuelta/>` quedan **fuera** del ternario, montados incondicionalmente, como hoy.
⇒ **`CD-W1-5`**: ⛔ la palabra `pasoInicial` **no aparece en `app/page.tsx`**, ni en código ni en
prosa. La costura de test del árbol nuevo se llama **`pasoDeArranque`**.

### 8.2 · El tercer candado: los seis destinos de censo del repo

Derivado hoy con `/usr/bin/grep -rno "\[\[CENSO [^]]*\]\]"` sobre las cuatro raíces `[MEDIDO]`.
**Los archivos que son DESTINO de un censo `entrantes` son seis**:

`src/presentation/flow.tsx` · `src/infrastructure/solana-wallet.ts` ·
`src/infrastructure/solana/preparacion-por-enlace.ts` · `src/infrastructure/solana/deeplink/sesion.ts` ·
`src/infrastructure/solana/deeplink/firma-por-enlace.ts` · `src/application/use-cases/confirm-and-send.ts`

⇒ **`CD-W1-3`**: ⛔ **ninguna cita ANCLADA nueva hacia esos seis**, desde ningún archivo de W1.
Las citas hacia ellos van **sueltas y con su motivo al lado**, patrón de
`src/presentation/bitacora-de-vuelta.ts:175-177` `[MEDIDO]`.
✅ **Y lo que sí es libre**: `src/presentation/flow-vm.ts` **lleva** marcadores sobre `flow.tsx` pero
**no es destino de ningún censo** `[MEDIDO]` ⇒ importarlo y citarlo anclado **no mueve nada**.

### 8.3 · 🔴 Las tres citas SUELTAS a `app/page.tsx:20-21`, que nada vigila

`/usr/bin/grep -rn "app/page\.tsx:[0-9]"` sobre las cuatro raíces ⇒ **tres sitios** `[MEDIDO]`:

- `src/presentation/bienvenida.tsx:206`
- `src/presentation/grecas.tsx:9`
- `src/presentation/bienvenida-composicion.test.tsx:862` (en el **nombre** de un `it`)

Las tres citan `app/page.tsx:20-21`, que hoy son `<>` y `<Splash />` `[MEDIDO]`. **Son citas SUELTAS:
`citas-ancladas.test.ts` no las mira** — `W0-4` lo midió y lo publicó (*una cita suelta no mueve ningún
marcador*) `[HEREDADO]`.

⇒ 🔴 **Agregar el import de `<Recorrido/>` arriba de `app/page.tsx` corre esas tres citas y las deja
ROTAS Y VERDES.** Es exactamente el modo de falla «las citas que rompés vos al arreglar otra cosa».
⇒ **`CD-W1-9`**: después de la última edición de `app/page.tsx`, las tres se **re-derivan** con
`/usr/bin/grep -n` y se corrigen, o se declara por qué no. ⛔ El gate **no** las va a cazar.

### 8.4 · La cuarta mina: los dos README

`src/composition/readme-test-count.test.ts:87` compara el conteo real de archivos de test contra
**los DOS README, por separado y con un marcador por idioma** `[MEDIDO]`. Medido hoy con el mismo
barrido: **174**, y `README.md:436` y `README.es.md:462` dicen 174 `[MEDIDO]`.

⇒ W1 agrega **4** archivos de test ⇒ el número pasa a **178** en los dos README.
⇒ **`CD-W1-11`**: el número se deriva **corriendo el candado**, ⛔ nunca contando a mano. Es el
`C-1` de W0, que descubrió esto **después** de fijar su presupuesto de archivos.

### 8.5 · La quinta, y es la que más va a doler: **la prosa de W1 puede poner rojo el candado de `L-5`**

Los `PATRONES` del guard son **call-shaped**: `/\brouter\s*\.\s*push\s*\(/`, `/\buseRouter\s*\(/`,
`/\brouter\s*\.\s*replace\s*\(/` (`el-salto-remonta-el-arbol.test.tsx:71-78` `[MEDIDO]`).
**Lo corrí contra siete líneas de docblock candidatas de W1** `[MEDIDO]`:

| Línea de prosa | Resultado |
|---|---|
| `* ⛔ Este árbol no usa router.push(...) para cambiar de pantalla.` | 🔴 **ROJO** (`router.push`) |
| `* ⛔ Este árbol no llama a useRouter() nunca.` | 🔴 **ROJO** (`useRouter`) |
| `* ⛔ Prohibido router.replace(ruta) en el recorrido.` | 🔴 **ROJO** (`router.replace`) |
| `* ⛔ Nada de router.push ni router.replace acá.` | 🟢 verde |
| `* ⛔ No se importa nada de next/navigation salvo notFound.` | 🟢 verde |
| `* el recorrido no usa <Link> para cambiar de pantalla` | 🟢 verde |
| `// el recorrido no usa <Link> para cambiar de pantalla` | 🟢 verde |

⇒ **`CD-W1-2`**: en `src/` y `app/`, ⛔ **prohibido escribir en prosa `router.push(`, `router.replace(`
o `useRouter(` con el paréntesis**. Se escriben **sin paréntesis**. Esto es exactamente el `MNR-2` del
CR de W0 —*«W1 va a escribir justamente esos docblocks»*— **y el arreglo de aquel fix-pack lo cerró
sólo para el caso sin paréntesis**. ⛔ **No se toca el guard para acomodar la prosa**: ese es el
camino por el que un falso rojo recurrente termina debilitando un candado, y este repo ya lo tiene
escrito.

---

## §9 · Waves de W1 — archivos exactos por wave

**El orden es serial entre olas y paralelo dentro de W1.2.** ⛔ Ninguna wave arranca sobre una
medición no hecha (`CD-4`).

### W1.0 · **La premisa falsable + los contratos.** Serial, primero, 0 pantallas

| Archivo | N/M | Qué |
|---|---|---|
| `src/presentation/recorrido/pasos.ts` | NUEVO | La tabla de 5, etiquetas, itinerario, transiciones |
| `src/presentation/recorrido/salto.ts` | NUEVO | Anuncio / en vuelo / aterrizaje. Marcas **importadas** de producción |
| `src/presentation/recorrido/bandera.ts` | NUEVO | `recorridoV2Enabled()` |
| `src/presentation/recorrido/pasos.test.ts` | NUEVO | `T-374-W1-1`, `T-374-W1-2` |
| `src/presentation/recorrido/salto.test.ts` | NUEVO | 🔴 **`T-374-W1-0` (la premisa)**, `T-374-W1-3`, `T-374-W1-4` |

🔴 **`T-374-W1-0` es la puerta de la ola y es BLOQUEANTE.** Si sale roja, W1 se detiene: significa que
el conjunto de marcas de vuelta **no es enumerable desde producción**, y entonces la tabla de
aterrizaje de §6.3 sería una lista a mano que envejece sola — que es exactamente la clase de artefacto
que le costó dos rechazos a W0.

### W1.1 · Las cinco pantallas. Serial respecto de W1.0

| Archivo | N/M | Qué |
|---|---|---|
| `src/presentation/recorrido/pantallas.tsx` | NUEVO | Los cinco componentes |

### W1.2 · El anfitrión y el interruptor. **Las dos mitades son paralelizables**

| Archivo | N/M | Qué |
|---|---|---|
| `src/presentation/recorrido/recorrido.tsx` | NUEVO | Máquina de estado, stepper, salida no destructiva |
| `app/page.tsx` | **MODIFICADO** | El ternario. ⚠️ Con `CD-W1-4`, `CD-W1-5` y `CD-W1-9` a la vista |
| `src/presentation/recorrido/recorrido.test.tsx` | NUEVO | `T-374-W1-5` … `T-374-W1-9` |
| `src/presentation/recorrido/inercia.test.tsx` | NUEVO | `T-374-W1-10`, `T-374-W1-11`, `T-374-W1-12` |

### W1.3 · El cierre de la ola. Serial, último

| Archivo | N/M | Qué |
|---|---|---|
| `README.md` · `README.es.md` | MODIFICADOS | El conteo `174 → 178`, **derivado corriendo el candado** |
| `doc/sdd/234-…/w1-report.md` (en `wasiai-a2a`) | NUEVO | ⚠️ **Se materializa ANTES del commit de la ola, no después.** Es la lección del `BLQ-BAJO-2` de W0: *«el modo de falla que este proyecto ya registró cinco veces»* |

**Total: 12 archivos** (6 de producción, 4 de test, 2 README) ≤ 14 del presupuesto.

---

## §10 · Plan de tests — cada `it` con su mutante NOMBRADO y su falso KILLED

⛔ **Regla que se aplica a todos** (`CD-W0-6`, heredada): un `1 failed` sin un `×` nombrado **no es un
KILLED**. Cada mutante se verifica **en disco antes** de correr y se restaura contra
`/usr/bin/git diff --numstat`, ⛔ nunca con un `.orig` cacheado.

### 10.1 · La tabla completa

| `it` | Archivo | Qué mide | AC / CD |
|---|---|---|---|
| `T-374-W1-0` | `salto.test.ts` | 🔴 **La premisa**: el universo de marcas es enumerable desde producción y **toda** marca tiene aterrizaje | `AC-7` |
| `T-374-W1-1` | `pasos.test.ts` | La tabla tiene **5** y el número **se deriva**, no se escribe | `AC-2` |
| `T-374-W1-2` | `pasos.test.ts` | `etiquetas.length === itinerario.length` en **los dos** casos (4 y 5) | `AC-4` |
| `T-374-W1-3` | `salto.test.ts` | ⛔ **Ninguna marca aterriza en `entrar`**, ni en el camino de error | `AC-7`, `AC-8`, `CD-5` |
| `T-374-W1-4` | `salto.test.ts` | Los literales de las marcas **no están escritos** en el árbol nuevo | `CD-W1-7` |
| `T-374-W1-5` | `recorrido.test.tsx` | **Conectar es lo primero**: la pantalla 1 no pide monto, beneficiario ni CCI | `AC-1` |
| `T-374-W1-6` | `recorrido.test.tsx` | La salida no destructiva **no borra** lo cargado | `AC-3` |
| `T-374-W1-7` | `recorrido.test.tsx` | 🔴 **`CD-W0-7`**: el árbol NUEVO montado no deja la sesión en ningún disco, **con control positivo** | `CD-W0-7`, `DT-5` |
| `T-374-W1-8` | `recorrido.test.tsx` | Copy: no custodial preservado, sin em dash, sin la promesa de la `071` | `AC-16`, `CD-2`, `CD-12` |
| `T-374-W1-9` | `recorrido.test.tsx` | El anuncio existe **antes** del salto y no escribe ningún número literal de firmas | `AC-5`, `AC-6`, `CD-W1-6` |
| `T-374-W1-10` | `inercia.test.tsx` | 🔴 **`AC-13`**: bandera apagada ⇒ **byte-idéntico** al árbol de hoy | `AC-13` |
| `T-374-W1-11` | `inercia.test.tsx` | Sólo el literal `"true"` prende la bandera | `DT-2` |
| `T-374-W1-12` | `inercia.test.tsx` | ⛔ Ninguna pantalla nueva toca disco ni URL directamente, **y** el vocabulario de diseño del árbol nuevo es el de la casa | §5.3, `OBS-W1-3` |

### 10.2 · `T-374-W1-0` — la premisa, en detalle

`it("T-374-W1-0: el universo de marcas de vuelta se DERIVA de producción, y ninguna de las siete queda sin aterrizaje")`

Afirma, **en este orden**:

1. **Calibración**: `MARCAS_DE_VUELTA` importada de `deeplink/sesion` tiene **length ≥ 6** y contiene
   los seis de hoy. ⛔ Sin esto, un import roto daría `[]` y todo lo de abajo pasaría por vacío.
2. Para **cada** elemento de esa tupla **más** `kyc=return` **más** `wb=1`, `aterrizajeDe(...)` devuelve
   un paso **que está en la tabla de `pasos.ts`**.
3. Ese paso **no es `entrar`** — la aserción de `AC-7`, comparada **por valor** contra el `id`.
4. **Control negativo**: a `aterrizajeDe` se le pasa una marca sintética que no existe
   (`"marca-que-nadie-escribio"`) y se exige que conteste el **tercer valor** —
   `"sin-aterrizaje"` — y ⛔ **no** un paso por defecto. Un booleano acá perdería el tercer valor,
   que es la lección `H` de esta HU.

**Mutante `MW-0`**: agregar un **séptimo** elemento a `MARCAS_DE_VUELTA` en
`deeplink/sesion.ts:495` (línea-neutro, la tupla está en esa misma línea) ⇒ **cae la aserción 2**.
⛔ **Falso KILLED a evitar, y está medido en el propio repo**: `it("T-067-16: …")` en
`src/infrastructure/solana/deeplink/sesion.test.ts` **también** se pone rojo con ese mutante, y el
docblock de `sesion.ts:495` declara además que **`tsc` no puede cazarlo por construcción** `[MEDIDO]`.
⇒ el `×` que cuenta es el de **`T-374-W1-0`, aserción 2**, citado por su mensaje.

### 10.3 · `T-374-W1-7` — `CD-W0-7`, y el agujero de vacuidad que YA está medido

`it("T-374-W1-7: con el árbol NUEVO montado y una sesión viva, el token no está en ningún disco ni en la URL")`

🔴 **Medido en esta sesión, con `node -e`**: las cuatro aserciones de `T-372-W3-8`
(`sesion-borra-la-segunda-firma.test.tsx:556-565`) son `.not.toContain(token)`, y **sobre un almacén
vacío pasan las cuatro** `[MEDIDO]`:

- `JSON.stringify({})` ⇒ `"{}"` ⇒ `.not.toContain("abc.def")` ⇒ **pasa**
- `document.cookie` vacío ⇒ **pasa**
- y si `token` fuera `""`, `.toContain("")` es **siempre verdadero** ⇒ la aserción invertida sería
  siempre falsa, o sea que un token vacío la rompería en la otra dirección sin que nadie sepa por qué

⇒ **Copiarlas tal cual sobre el árbol nuevo daría un verde por VACÍO**, que es exactamente el
`BLQ-MED-2` del AR de W0 (*«una aserción NEGATIVA que se satisface con una lista VACÍA»*)
`[HEREDADO]`. ⇒ el `it` de W1 lleva **tres aserciones ANTES** de las cuatro:

1. El árbol nuevo se montó y llegó al paso donde la sesión se acuña (`CD-18`: afirmar el desenlace
   **antes** de contar).
2. `token` es una cadena **no vacía** y con la forma `payloadB64.firma` (dos partes).
3. **Control positivo**: el instrumento **sabe decir que sí** — se siembra el token en `localStorage`
   a mano y se verifica que la misma expresión **lo encuentra**. Sin esto, las cuatro de abajo son
   indistinguibles de un instrumento roto.

**Mutante `MW-7`**: en el árbol nuevo, escribir el token con
`window.localStorage.setItem("x", token)` ⇒ cae la **primera** de las cuatro.
⛔ **Falso KILLED a evitar**: si se aplicara el mutante **sin** las tres aserciones previas y el árbol
no llegara a acuñar sesión, el `it` daría verde igual — que es el defecto que este diseño existe para
prevenir. ⇒ el Dev reporta **cuál** aserción produjo el rojo.

### 10.4 · `T-374-W1-12` — dos barridos, y los dos con control negativo

`it("T-374-W1-12: ninguna pantalla del recorrido nuevo toca disco, URL ni un tamaño de texto de fábrica")`

**Pata (a)** — barrido de `src/presentation/recorrido/**` con `readFileSync` buscando
`localStorage`, `sessionStorage`, `document.cookie` y asignaciones de `window.location`.
⛔ **Se lee con `readFileSync`, nunca con `import`**: un guard de existencia que importa lo que vigila
muere por `Failed to resolve import` y eso **no es un KILLED** (lección `M`, ya medida en esta HU).
⛔ **Exclusión por RUTA EXACTA** (patrón `SELF` de `citas-ancladas.test.ts:56`), ⛔ nunca por glob ni
por el sufijo `.test.`: este archivo escribe los delatores en su propia prosa.
**Control negativo**: líneas sintéticas **en memoria** con los literales, y se exige que las cace.

**Pata (b)** — el mismo predicado que `it("T-O2-2: …")` usa (`/^text-(xs|sm|base|lg|xl|[2-9]xl)$/`,
`ola-2-pantallas.test.tsx:130`) aplicado a `src/presentation/recorrido/**`.
🔴 **Por qué hace falta, y es un hallazgo de esta sesión**: `T-O2-2` recorre **una lista de dos
archivos escrita a mano** — `src/presentation/flow.tsx` y `src/presentation/ui.tsx` `[MEDIDO]` — así
que **el árbol nuevo queda fuera de su barrido**. ⛔ El predicado se **re-escribe con su cita al lado**;
⛔ **no se importa `ola-2-pantallas.test.tsx`**: importar un `.test.tsx` corre sus `describe` y los
duplica en el reporte (lección de `W0-4`).

**Mutante `MW-12a`**: un `window.localStorage.getItem` en `pantallas.tsx` ⇒ cae (a).
**Mutante `MW-12b`**: un `className="text-sm"` en `pantallas.tsx` ⇒ cae (b).
⛔ **Falso KILLED a evitar**: `MW-12b` **no** pone rojo a `T-O2-2` (mide otra lista), así que un
`1 failed` acá **es** de este `it` — pero el Dev igual **nombra el `×`**, porque la ausencia de un
segundo rojo es parte de la evidencia.

### 10.5 · `T-374-W1-10` — `AC-13`, y el argumento de DOS patas que cubre `AC-14`

`it("T-374-W1-10: con la bandera APAGADA, la página monta el árbol de HOY y su innerHTML es idéntico")`

El molde es `it("T-065-21: …")` en `wallet-availability.test.tsx:1037`, **con su corrección**:
⚠️ **`C-5` de W0 midió, y yo re-verifiqué acá, que en ese `it` NO existe ningún `toBe(apagada)`**
`[MEDIDO]`. Lo que sí trae y hay que copiar son sus **tres** piezas: el `toBeTruthy()` de `CD-18` en
`:1048`, y la mitad falsadora `.not.toBe(apagada)` en `:1066`.

Las tres aserciones, en orden:
1. Con la bandera **ausente**, se monta el subárbol de `app/page.tsx` y su `innerHTML` es
   **truthy** (`CD-18`).
2. Ese `innerHTML` es **igual** al de `<RemittanceFlow/>` montado solo ⇒ *la bandera apagada monta el
   árbol de hoy*.
3. Con la bandera en `"true"`, el `innerHTML` es **distinto** ⇒ 🔴 **la mitad que vuelve falsable a la
   2**: sin ella, la 2 pasaría porque `<Recorrido/>` nunca se monta, no porque la bandera lo decida.

🔴 **Y de acá sale el argumento de `AC-14`, que necesita las DOS patas y ninguna sola alcanza:**

- `it("T-372-W1-13: …")` en `recorrido-en-el-navegador-de-la-billetera.test.tsx:707` sigue **verde**
  ⇒ el árbol viejo, montado directo, conserva sus números en el cuadrante de Phantom.
  ⛔ **Pero ese `it` monta `<RemittanceFlow/>` a mano: no dice nada de `app/page.tsx`.**
- `T-374-W1-10` dice que `app/page.tsx` con la bandera apagada **es** ese mismo árbol.
- ⇒ **Sólo juntos** cierran `AC-14` para W1. ⛔ **`AC-14` sobre el árbol NUEVO es de W3**, y se dice
  con esas palabras en el reporte.

**Mutante `MW-10`**: invertir el ternario de `app/page.tsx` ⇒ cae la aserción **2**.
⛔ **Falso KILLED a evitar**: `MW-10` **también** pone rojo a un puñado de `it` del árbol viejo que
montan la página. El `×` que cuenta es el de `T-374-W1-10`, aserción 2, citado por su mensaje.

### 10.6 · Los cuatro `it` restantes, en una línea cada uno

| `it` | Mutante nombrado | Falso KILLED a evitar |
|---|---|---|
| `T-374-W1-1` | `MW-1`: agregar un sexto paso a la tabla sin etiqueta ⇒ cae | Que el `5` esté escrito como literal en el `it`: entonces el mutante mata **el literal**, no la derivación. ⇒ **el número sale de `tabla.length`** y el `it` afirma la **forma** (todos los `id` únicos, todos con etiqueta) |
| `T-374-W1-2` | `MW-2`: devolverle al stepper la tabla entera en vez del itinerario ⇒ cae el caso recurrente | Correr **sólo** el caso de primera vez: ahí los dos coinciden y el mutante sobrevive. **Los dos casos van en el mismo `it`** |
| `T-374-W1-6` | `MW-6`: que «Volver» limpie el estado ⇒ cae | Que el `it` verifique **el paso** y no **los campos**: el paso volvería bien igual. **Se afirman los valores de los tres campos por valor** |
| `T-374-W1-9` | `MW-9`: borrar el bloque de anuncio ⇒ cae | Que el `it` busque el botón y no el **texto** del anuncio: el botón sobrevive al mutante |

### 10.7 · Lo que W1 ⛔ **NO** mide, dicho antes de que alguien lea su verde

1. ⛔ **Nada de esto corre en un teléfono.** Todo es `jsdom`. Es W3.
2. ⛔ **Ningún número de travesías ni de salidas del árbol NUEVO.** El árbol nuevo no se ejecuta con
   la bandera apagada. Los `2` y `1` de W0 son del **tramo de ida del árbol VIEJO** y ⛔ **no son
   comparables con el `7` heredado**, que sigue **NO VERIFICABLE** `[HEREDADO]` de `w0-report.md` §2.2.
3. ⛔ **PROHIBIDO publicar `6`, `5` o `7`**, y ⛔ prohibido publicar **el número de salidas del
   recorrido nuevo** mientras W4 de WKH-372 no tenga decisión del founder (`CD-W0-14`).

---

## §11 · Exemplars verificados

⛔ Todos abiertos con `sed`/`grep` en esta sesión, sobre `25c3f73`. **Ninguna ruta de esta tabla es
recordada.**

| # | Exemplar | Ruta verificada | Qué se copia |
|---|---|---|---|
| E-1 | Bandera opt-in estricto + gotcha del build | `mwaEnabled` en `src/presentation/wallet-availability.ts:98`; `deeplinkEnabled` en `:156`; el gotcha en `:95-96` y `:152-154` | `bandera.ts` entero (`DT-2`) |
| E-2 | Byte-identidad con sus **tres** piezas | `it("T-065-20: …")` en `src/presentation/wallet-availability.test.tsx:1021`; `it("T-065-21: …")` en `:1037`; `CD-18` en `:1048`; la mitad falsadora en `:1066` | `T-374-W1-10`, `T-374-W1-11` |
| E-3 | Las cuatro aserciones de disco | `it("T-372-W3-8: …")` en `src/presentation/sesion-borra-la-segunda-firma.test.tsx:539`, aserciones en `:556-565` | `T-374-W1-7`, **con las tres previas de §10.3** |
| E-4 | Leer marcas de la URL **sin escribir su literal** | `motivoParaNoMostrar` en `src/presentation/splash-puerta.ts:84`; `PARAM_KYC` en `:45`; `MARCA` en `src/infrastructure/solana/deeplink/sesion.ts:480` | `salto.ts` y `T-374-W1-4` |
| E-5 | Recorrer un conjunto de marcas en **runtime** | `MARCAS_DE_VUELTA` en `src/infrastructure/solana/deeplink/sesion.ts:495`, con su docblock explicando por qué es un **valor** y no un tipo | `T-374-W1-0` |
| E-6 | Exclusión por **ruta exacta** (anti auto-lectura) | `SELF` en `src/composition/citas-ancladas.test.ts:56` | `T-374-W1-12` |
| E-7 | Barrido del árbol con `readFileSync`, con sus tres trampas escritas | `walk` en `src/composition/no-evm-surface.test.ts:35`; `FORBIDDEN` en `:56` | `T-374-W1-12`, pata (a) |
| E-8 | Predicado del vocabulario de diseño | `it("T-O2-2: …")` en `src/presentation/ola-2-pantallas.test.tsx:130`; `clasesDe` en `:89` | `T-374-W1-12`, pata (b) |
| E-9 | El sistema de diseño | `Button` `:78`, `Card` `:101`, `Field` `:112`, `TextInput` `:142`, `Row` `:157`, `Aviso` `:295`, `Money` `:346`, `Stepper` `:370`, todos en `src/presentation/ui.tsx` | `pantallas.tsx` y `recorrido.tsx` |
| E-10 | Copy y estados ya escritos | `escrowRentExplainer` `:426`, `humanError` `:572`, `statusDisplay` `:133`, `copyDeEnlace` `:1503`, en `src/presentation/flow-vm.ts` | `pantallas.tsx`. ⚠️ **No es destino de censo** ⇒ citarlo anclado es libre |
| E-11 | Cita **sin ancla** con su motivo | `src/presentation/bitacora-de-vuelta.ts:175-177` | Toda cita a los **seis** destinos de censo de §8.2 |
| E-12 | Costura de test declarada como tal | El docblock de `pasoInicial` en `src/presentation/flow.tsx:133-139` | `pasoDeArranque` en `recorrido.tsx`. ⚠️ **Con el nombre CAMBIADO por `CD-W1-5`** |
| E-13 | Los casos de uso a reusar | `Container` en `src/composition/container.ts:50`; `getContainer` en `:265` | `recorrido.tsx`. ⛔ `RET-1` de W0: el árbol nuevo **no define lógica de dominio propia** |

---

## §12 · Constraint Directives — `CD-W1-N`

**Heredadas y vigentes sin cambios**: `CD-1` … `CD-14` del work-item y `CD-W0-1` … `CD-W0-14` del SDD
de W0. Se repiten abajo **sólo** las que W1 puede violar, más las nuevas.

| # | Directiva | De dónde sale |
|---|---|---|
| **`CD-W1-1`** | ⛔ **`flow.tsx` no se toca. Δ0 = 0 líneas, 0 caracteres.** Se verifica con `wc -l` ⇒ **4453**, ⛔ no leyendo el diff. Los 3 marcadores `lineas=4453` son el candado | `CD-11`, `CD-W0-2` |
| **`CD-W1-2`** | 🔴 ⛔ **Prohibido escribir en prosa de `src/` o `app/` los literales `router.push(`, `router.replace(` o `useRouter(` CON paréntesis.** Ponen rojo `T-374-W0-3`. Se escriben sin paréntesis. ⛔ **Y no se toca el guard para acomodar la prosa** | **Medido en esta sesión**, §8.5. `MNR-2` del CR de W0 |
| **`CD-W1-3`** | ⛔ **Ninguna cita ANCLADA nueva hacia los SEIS destinos de censo** de §8.2. Van sueltas, con su motivo al lado (E-11) | `CD-W0-3`, derivado hoy |
| **`CD-W1-4`** | ⛔ El ternario de la bandera envuelve **sólo** `<RemittanceFlow/>` ↔ `<Recorrido/>`. `<Splash/>` y `<DiagnosticoDeVuelta/>` quedan **fuera**, montados como hoy | `T-DIAG-CABLEADO`, medido |
| **`CD-W1-5`** | ⛔ **La palabra `pasoInicial` no aparece en `app/page.tsx`**, ni en código ni en prosa. La costura del árbol nuevo se llama `pasoDeArranque` | `barra-destinos.test.tsx:303`, medido |
| **`CD-W1-6`** | ⛔ **Ninguna pantalla escribe un número LITERAL de firmas o de salidas.** El anuncio deriva la lista en runtime y renderiza su largo. ⛔ Y el reporte **no publica** ese número como métrica | `CD-W0-14`, `AC-9b` |
| **`CD-W1-7`** | ⛔ **Ningún literal de marca de vuelta** (`"dl"`, `"kyc"`, `"return"`, `"wb"`, `"1"`, los seis pasos) **se escribe en el árbol nuevo ni en sus tests.** Todos se importan de producción | E-4, `MNR` de literales duplicados |
| **`CD-W1-8`** | 🔴 ⛔ **Ninguna frase de W1 puede afirmar más de lo que su código verifica.** Antes de escribir *«esto verifica que X»*, se escribe el mutante que la volvería falsa **y se corre**. Si el mutante también rompe el comportamiento, **no es el mutante de esa aserción**. ⛔ Y toda palabra que cuantifique —«el máximo», «el único», «no hay ninguno», «en N archivos»— sale de **un barrido sobre el conjunto entero**, ⛔ nunca de una muestra que ya tenías abierta | **Patrón recurrente en las DOS últimas HUs**: 2 bloqueantes del CR de W0 + 3 menores + 7 citas rotas en la 233 |
| **`CD-W1-9`** | ⛔ **Después de la última edición, se re-derivan las citas y los conteos que la propia edición corrió.** En particular: **las TRES citas sueltas a `app/page.tsx:20-21`** (§8.3), que ⛔ **el gate no caza**. Y todo conteo de docblock se ancla al commit | «las citas que rompés vos al arreglar otra cosa» (233) + los 3 conteos falsos de W0 |
| **`CD-W1-10`** | ⛔ **Toda cita anclada nueva entra ENTERA en una línea física.** Después de la última edición se enumeran las citas del propio diff con el regex del candado y **se cuentan**: si el número no coincide con lo que escribiste, las que faltan están **partidas y por lo tanto rotas y verdes** | Entrada 19:48 del `auto-blindaje.md` de esta HU: **3 de 5 quedaron partidas** |
| **`CD-W1-11`** | ⛔ **Los DOS README se actualizan a `178`, derivando el número corriendo el candado**, ⛔ nunca contando a mano | `C-1` de W0, medido hoy: 174 |
| **`CD-W1-12`** | ⛔ **Ningún guard puede leerse a sí mismo.** Exclusión por **ruta EXACTA**, ⛔ nunca por glob ni por el sufijo `.test.` Y todo guard que afirme un `[]` lleva **control negativo con el literal exacto** que tiene que cazar | `CD-W0-5` + la entrada 16:55 del `auto-blindaje.md` |
| **`CD-W1-13`** | ⛔ **El gate es `npm run qa` → `npm run build`, entero, en orden, contra el ÍNDICE de git** (`/usr/bin/git add -A` primero). ⛔ **Prohibido `npx biome` y `npx tsc` sueltos.** ⛔ Correr `vitest` solo **no es correr el gate** | `CD-W0-9`, verificado en `package.json:20` |
| **`CD-W1-14`** | ⛔ **La bandera se despliega APAGADA**, y el gotcha del build va escrito en `bandera.ts`: cambiar la env en Vercel sin **rebuildear** no hace nada | `CD-8`, B-21 |
| **`CD-W1-15`** | ⛔ **Ninguna pantalla nueva toca `localStorage`, `sessionStorage`, `document.cookie` ni asigna `window.location`.** Todo pasa por `container.<casoDeUso>`. Es la costura de W2 y tiene candado (`T-374-W1-12`) | §5.3, `DT-5` |
| **`CD-W1-16`** | ⛔ **El árbol nuevo no define lógica de dominio ni de caso de uso propia** (`RET-1` de W0). Lo que importa de `../application/` y `../domain/` está contenido en lo que importa `flow.tsx` | `RET-1`, `M-7` del work-item |
| **`CD-W1-17`** | ⛔ **Ninguna pantalla ofrece, menciona ni integra una billetera custodial o embebida**, y toda pantalla que hable de fondos preserva la afirmación no custodial. ⛔ Y ninguna puede decir ni insinuar que *«el remitente no necesita SOL»*: eso lo entrega la HU **`071` de `chaski-v3`**, que **espera el `HU_APPROVED` del founder** | `CD-2`, `CD-12` |
| **`CD-W1-18`** | ⛔ **Cero líneas en `wasiai-a2a/src/`**, y ⛔ nada por encima de la línea 144 de `wasiai-a2a/doc/sdd/_INDEX.md` | `CD-3`, `CD-10`, `AC-15` |
| **`CD-W1-19`** | ⛔ **El `w1-report.md` se materializa ANTES del commit de la ola.** Si el mensaje del commit nombra un documento, ese documento existe antes del commit | `BLQ-BAJO-2` de W0: *«el modo de falla que este proyecto ya registró cinco veces»* |

---

## §13 · Presupuesto de escala — **por columna, con la prosa separada del código**

### 13.1 · La vara, **re-derivada en esta sesión** y no heredada

W0 publicó su vara sobre `c1bd8d3`. La volví a correr sobre `25c3f73` con el mismo contador
(`prosa` = línea trimeada que empieza con `//`, `/*` o `*`; `codigo` = línea no vacía que no es prosa;
blancos afuera) `[MEDIDO]`:

| Magnitud | W0 (`c1bd8d3`) `[HEREDADO]` | **Hoy (`25c3f73`)** `[MEDIDO]` |
|---|---|---|
| Prosa de **producción**, casa (`src`+`app`, sin tests) | 53,0 % | **53,0 %** ✅ reproduce |
| Ídem, sólo `src/presentation/` | 53,4 % | **53,4 %** ✅ reproduce |
| Archivos de **test** | 174 | **174** ✅ reproduce |
| Prosa de **test**, máximo real | 65,0 % (`prepared-claims-guard.static.test.ts`) | **65,0 %**, mismo archivo ✅ reproduce |
| Prosa de test, mediana / p75 / p86 / p90 | 26,8 / 37,1 / 42,8 / 48,0 | **26,9 / 37,5 / 43,0 / 48,3** ✅ reproduce dentro de 0,5 pt |
| Archivos de test **por encima del techo formal de 55 %** | 7, nombrados | **los mismos 7** ✅ reproduce |

⇒ **La vara de W0 sobrevive al cambio de árbol.** Se usa la derivada, ⛔ no una tabla a mano.

### 13.2 · 🔴 `MI-10` resuelto: el techo de prosa de PRODUCCIÓN, y por qué es un apriete real

`CD-14` del work-item pone **≤45 %** a la prosa de producción, y la fila de W1 de su §11 presupuesta
**≤400 de prosa contra ≤550 de código ⇒ ≤42,1 %**. W0 dejó `MI-10` abierto preguntando si eso se
sostiene. **Lo medí archivo por archivo** `[MEDIDO]`:

| Archivo de producción de la casa | prosa / código | ratio |
|---|---:|---:|
| `src/presentation/flow.tsx` | 1769 / 2567 | **40,8 %** ⚠️ **artefacto de medición** |
| `src/presentation/splash.tsx` | 118 / 126 | 48,4 % |
| `src/presentation/ui.tsx` | 187 / 187 | **50,0 %** |
| `src/presentation/diagnostico-de-vuelta.tsx` | 294 / 279 | 51,3 % |
| `src/presentation/bienvenida.tsx` | 162 / 148 | 52,3 % |
| `src/presentation/barra-destinos.tsx` | 88 / 70 | 55,7 % |
| `src/presentation/splash-puerta.ts` | 89 / 44 | 66,9 % |
| `src/presentation/wallet-availability.ts` | 117 / 35 | **77,0 %** |
| `src/presentation/salida-al-navegador-de-la-billetera.ts` | 139 / 40 | 77,7 % |

🔴 **Ninguna pantalla honesta de la casa está por debajo del 45 %.** La única que lo está es
`flow.tsx`, y `W0 §3.2(c)` ya midió que su 40,8 % **es un artefacto**: tiene **185 líneas MIXTAS**
(código y prosa en el mismo renglón) que ningún contador atribuye, y **35 de ellas superan los 1000
caracteres** `[HEREDADO]`.

**Decisión: el techo se SOSTIENE, y con un mecanismo que lo vuelve alcanzable en vez de aspiracional.**

1. **La prosa que explica las decisiones del recorrido va en ESTE SDD y en los docblocks de los
   TESTS** (donde el techo formal es 55 %), ⛔ **no en los archivos de producción**. Ése es el
   mecanismo, y sale del hallazgo del work-item: **los tres bloqueantes del CR de la ola anterior
   vivían en los docblocks de producción**, no en los tests `[HEREDADO]`.
2. **Se mide sobre el BLOQUE de producción de W1** (≤42 %), **y además por archivo con techo ≤50 %**,
   que es el número de `ui.tsx` — el archivo de pantalla más auditable de la casa.
3. ⚠️ **Una excepción, declarada de antemano y con su número**: `bandera.ts` es **una función booleana
   más el gotcha de despliegue que el repo obliga a repetir verbatim**. Su exemplar,
   `wallet-availability.ts`, está en **77,0 %**. `bandera.ts` va a quedar cerca de **65 %** y ⛔ no se
   lo puede bajar sin borrar el gotcha, que es lo único que evita un despliegue que no despliega nada.
   ⇒ **Declarada acá, no descubierta en el CR.** Va a §15 como desviación `D-2`.

### 13.3 · El presupuesto de W1

| Columna | Techo | Reparto propuesto |
|---|---:|---|
| 🔴 **Producción ejecutable** | **≤ 550** | `pasos.ts` 45 · `bandera.ts` 12 · `salto.ts` 90 · `pantallas.tsx` 260 · `recorrido.tsx` 120 · `app/page.tsx` +8 = **535** |
| 🔴 **Producción comentario/prosa** | **≤ 400** (**≤ 42 %** del bloque) | 35 · 30 · 70 · 140 · 80 · +25 = **380** ⇒ ratio **41,5 %** |
| **Producción · por archivo** | **≤ 50 %**, con `bandera.ts` como **única excepción declarada** (§13.2) | |
| **Tests · total** | **≤ 2.200** | `pasos.test.ts` ~230 · `salto.test.ts` ~420 · `recorrido.test.tsx` ~750 · `inercia.test.tsx` ~450 = **~1.850** |
| **Tests · prosa** | **≤ 55 %** formal. ⛔ El *«42,8 % operativo»* está **RETIRADO**: era falso (`BLQ-MED-2` del CR de W0) | |
| **Archivos tocados** | **≤ 14** | **12**: 6 de producción (5 nuevos + `app/page.tsx`), 4 de test, 2 README |
| 🔴 **Líneas en `wasiai-a2a/src/`** | **0** ⛔ estricto | |
| 🔴 **Δ en `flow.tsx`** | **0** ⛔ estricto | |

**Las tres reglas que gobiernan este presupuesto:**

1. **Los ~350 de margen en tests son deliberados, y se dice por qué.** W0 se pasó **151,9 %** y
   *ninguna de las dos revisiones bajó su techo: las dos pidieron MÁS control* `[HEREDADO]`. Ese
   margen es para el fix-pack del AR y el del CR. ⛔ **No es permiso para escribir de más ahora.**
2. **La ratio test:código ejecutable se presupuesta en ~3,5:1 y ⛔ NO se cuenta como exceso.** Un CR
   que reporte *«se pasó»* mirando el total sin partir prosa/código **está midiendo mal** (regla 2 del
   §11 del work-item).
3. **La pregunta que decide, escrita para el CR**: *¿qué parte de esto seguiría existiendo si lo
   escribiera alguien que ya conoce este repo?* Un exceso justificado es información; **un exceso
   silencioso es el hallazgo**. Si el diff pasa **2x** cualquier columna, se justifica por escrito
   **diciendo en cuál columna está**, o se recorta.

---

## §14 · Observaciones medidas que no son de esta ola, y no se van en silencio

| # | Observación | Evidencia | Qué hago |
|---|---|---|---|
| **`OBS-W1-1`** | 🔴 **El candado de `L-5` es más ancho que `L-5`.** Prohíbe toda navegación blanda de `src`+`app`; la premisa sólo necesita que **el salto a la billetera** sea de documento | `el-salto-remonta-el-arbol.test.tsx:130-296` `@25c3f73` `[MEDIDO]` | ⛔ **No se toca en W1** (§3.4). Queda **declarado** para que nadie lea su verde como *«L-5 se midió para la app entera»*. Si algún día hace falta (b), el costo está escrito en §3.5 |
| **`OBS-W1-2`** | El recorrido nuevo **no da historial de navegador**: el botón «atrás» del teléfono sale de la app. **Hoy es igual** con el árbol viejo | Consecuencia directa de §3.2 | **No empeora nada** y ⛔ **ningún AC lo pide**. Se nombra. Dueño: el founder, si alguna vez lo pide |
| **`OBS-W1-3`** | 🔴 **`T-O2-2` recorre una lista de DOS archivos escrita a mano** (`flow.tsx`, `ui.tsx`) ⇒ **el árbol nuevo queda fuera del candado del vocabulario de diseño** | `ola-2-pantallas.test.tsx:130` `@25c3f73` `[MEDIDO]` | W1 **no toca ese archivo** (es de otra HU). Cubre su propio árbol con `T-374-W1-12`, pata (b), re-escribiendo el predicado con su cita al lado. **Que la lista de `T-O2-2` sea a mano es una HU aparte** |
| **`OBS-W1-4`** | `it("ninguna pantalla del recorrido mete un em dash")` en `honest-copy.test.tsx:476` monta **el árbol viejo** ⇒ no cubre el nuevo | `[MEDIDO]` | Cubierto por `T-374-W1-8`. Se nombra para que nadie dé el viejo por suficiente |
| **`OBS-W1-5`** | `src/presentation/bitacora-de-vuelta.ts:176` sigue diciendo que `flow.tsx` lleva marcadores *«en ocho archivos»*. **Son seis**, re-medido hoy | `grep -rl` ⇒ 6 `@25c3f73` `[MEDIDO]`. Es el `OBS-1` de W0, **todavía abierto** | ⛔ No se arregla acá: es producción de otra vecindad y sumaría un archivo al Scope IN. **Candidato al fix-pack**, no a la ola |
| **`OBS-W1-6`** | El flake heredado de `vuelta-por-enlace-carrera.test.tsx` acumula **0/60** contra un `7-13 %` declarado | `w0-report.md` §2.2 `[HEREDADO]` | ⛔ **No se pone en cuarentena** (`CD-W0-12`). Si W1 lo ve rojo, **es su línea de base la que lo distingue de *«lo rompí yo»***. El mecanismo es **HU propia** (`MNR-4` de W0) |
| **`OBS-W1-7`** | Los **tres menores del CR de W0 sin domicilio**: el patrón que re-deriva las «47 anclas partidas», dos mensajes de aserción que afirman de más, y un nombre de `it` que promete un observable que no observa | `w0-report.md` §10 `[HEREDADO]` | Los tres son de la familia de `CD-W1-8`. ⛔ **No son de W1**, y quedan nombrados para que el cierre de la HU no los herede en silencio |

---

## §15 · Desviaciones que necesitan el ok del humano en `SPEC_APPROVED`

| # | Desviación | Motivo, medido |
|---|---|---|
| **`D-1`** | 🔴 **La tensión del router se resuelve por la opción (a)**, no por (b). El candado de `L-5` **no se toca** y `L-5` **no se re-deriva** | §3.3, cuatro mediciones. La que decide: `urlDeVueltaDeKyc` clava la vuelta del verificador a la **raíz `/`**, y con rutas eso aterrizaría en la pantalla de entrada — que es lo que `AC-7` prohíbe con la palabra «NUNCA» |
| **`D-2`** | El techo de prosa de producción **se sostiene** (`MI-10`), pero **con una excepción declarada de antemano**: `bandera.ts`, ~65 %, contra su exemplar al 77,0 % | §13.2. ⛔ No se lo puede bajar sin borrar el gotcha del build, que es lo único que evita un despliegue que no despliega nada |
| **`D-3`** | **El envío se guarda por el puerto que YA existe** (`RemittanceRepository` / `LocalRepo` / `chaski.remittances.v1`), ⛔ sin clave nueva y sin módulo `borrador.ts` | §5.2: **el CCI ya está at-rest en ese blob hoy**, y **el recorrido nuevo elimina el caso del borrador parcial que cruza un salto**, porque la única pantalla donde se tipea no salta |
| **`D-4`** | **W1 no mide `AC-14` sobre el árbol nuevo.** Lo cierra con un argumento de **dos patas** para el árbol viejo, y declara que el nuevo es **W3** | §10.5. Con la bandera apagada el árbol nuevo **no se ejecuta**: medir `AC-14` sobre él sería medir algo que no corre |
| **`D-5`** | **12 archivos y ~1.850 líneas de test contra un techo de 14 y 2.200**, o sea que W1 se presupuesta **por debajo** y declara para qué es el margen | §13.3, regla 1: W0 se pasó 151,9 % y **las dos revisiones pidieron más control, no menos** |

---

## §16 · Readiness Check

| # | Ítem | Estado |
|---|---|---|
| 1 | **La tensión del router resuelta con razón medida**, y con el costo de la alternativa escrito | 🟢 §3 — opción (a); cuatro mediciones; §3.5 tiene el costo de (b) por si alguna vez se toma |
| 2 | `DT-7` resuelto: el plegado 8→5, con qué ve la persona en cada pantalla | 🟢 §4 |
| 3 | Cómo se guarda el envío, sin abrir superficie nueva | 🟢 §5 — puerto existente; el CCI ya está at-rest hoy, medido |
| 4 | Cómo se anuncia y cómo se vuelve del salto, con el invariante ⛔ **nunca en `entrar`** | 🟢 §6 — aterrizaje como **función pura de la marca**; las tres marcas importadas de producción |
| 5 | El árbol de archivos nuevo, con el interruptor | 🟢 §7 — 6 de producción; bandera verificada libre |
| 6 | **Las minas de `app/page.tsx`, medidas antes de tocarlo** | 🟢 §8 — 2 candados sobre su fuente, 6 destinos de censo, **3 citas sueltas que el gate no caza**, 2 README, y la prosa que pone rojo `T-374-W0-3` |
| 7 | Waves con archivos exactos, y una **Wave 0 de premisa falsable** dentro de W1 | 🟢 §9 — `T-374-W1-0` es bloqueante: si sale roja, W1 se detiene |
| 8 | **Cada test con su mutante NOMBRADO** | 🟢 §10 — `MW-0` … `MW-12b`, uno por `it` |
| 9 | **Cada test con su falso KILLED a evitar** | 🟢 §10.2 · §10.3 · §10.4 · §10.5 · §10.6 |
| 10 | **Ningún guard se lee a sí mismo** | 🟢 `CD-W1-12` + exclusión por ruta exacta (E-6) + control negativo con el literal exacto |
| 11 | El agujero de vacuidad de `CD-W0-7` **medido**, no supuesto | 🟢 §10.3 — corrido con `node -e`: las 4 aserciones pasan sobre un almacén vacío ⇒ 3 aserciones previas + control positivo |
| 12 | Citas a tests **por nombre del `it` + archivo**, en **una sola línea física** | 🟢 §0 regla 2 + `CD-W1-10`. Ninguna cita de este documento está en formato anclado (§0 regla 1) |
| 13 | Exemplars **verificados en esta sesión**, ninguno recordado | 🟢 §11 — 13 exemplars, todos con `sed`/`grep` sobre `25c3f73` |
| 14 | **Presupuesto por columna, con prosa separada de código**, y la vara **re-derivada** | 🟢 §13 — los 6 números de W0 reproducen sobre `25c3f73`; `MI-10` resuelto con la medición por archivo |
| 15 | Exceso o defecto de presupuesto **declarado con su columna** | 🟢 §13.3 regla 1 + `D-5` |
| 16 | Constraints heredadas del work-item y de W0, presentes | 🟢 §12 — `CD-1..14`, `CD-W0-1..14` vigentes + `CD-W1-1..19` |
| 17 | **Auto-Blindaje histórico leído**, y los patrones recurrentes convertidos en CD | 🟢 §2 — los `auto-blindaje.md` de la 233 y de la 234/W0. Dos patrones recurrentes ⇒ `CD-W1-8`, `CD-W1-9`, `CD-W1-10` |
| 18 | El gate del repo **nombrado correctamente** | 🟢 `npm run qa` → `npm run build`, verificado en `package.json:20` `@25c3f73`. ⛔ Prohibido `npx` suelto |
| 19 | ⛔ **`flow.tsx` Δ0 = 0** y ⛔ cero líneas en `wasiai-a2a/src/` | 🟢 `CD-W1-1`, `CD-W1-18`. `wc -l` ⇒ 4453 hoy |
| 20 | ⛔ **Nada promete que «Crear la cuenta» desaparece**, ni publica el número de salidas | 🟢 `CD-W1-6`, `CD-W1-17`. `CD-W0-14` y `CD-12` heredadas |
| 21 | El estado de `origin/main` verificado antes de la primera línea | 🟢 `main` = `origin/main` = `25c3f73`, árbol limpio `[MEDIDO]` |
| 22 | `[NEEDS CLARIFICATION]` sin marcar | 🟢 **Ninguno.** Lo que queda abierto son diferimientos con dueño (§14) o decisiones del founder (W4 de WKH-372, HU `071`), **nombrados** |
| 23 | Desviaciones que necesitan el ok humano, listadas | 🟢 §15 — `D-1` … `D-5` |

**Veredicto: LISTO PARA `SPEC_APPROVED`**, con las cinco desviaciones de §15 a la vista del humano.

---

*SDD de la ola **W1** · WKH-374 · escrito por `nexus-architect` el 2026-09-01 · árbol de referencia
`chaski-v3@25c3f73` · ⛔ cero líneas de producción escritas en esta fase.*
