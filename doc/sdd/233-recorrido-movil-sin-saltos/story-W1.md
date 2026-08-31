# Story File · [WKH-372] · **OLA W1** — El navegador de la billetera como camino principal

> **Este documento es autocontenido. El Dev NO lee el SDD.** Todo lo que hace falta para
> implementar W1 está acá: archivos exactos, líneas exactas, tests con su nombre, el mutante que
> mata cada test, el falso KILLED a evitar, el gate, y la definición de terminado.
>
> **Repo donde vive el trabajo:** `/home/ferdev/.openclaw/workspace/chaski-v3` — **sólo el cliente**.
> **Repo ancla de los artefactos:** `wasiai-a2a` (`doc/sdd/233-recorrido-movil-sin-saltos/`).
> ⛔ **De `wasiai-a2a` no se toca una sola línea de `src/`.**
>
> **Rama:** `feat/wkh-372-w1-navegador-de-la-billetera`
> *(verificada como inexistente hoy: `/usr/bin/git branch -a` lista 143 refs en `chaski-v3` y
> **ninguna** contiene `372` ni `navegador`).*
>
> **Fecha:** 2026-08-31 · **Modo:** QUALITY · **Gate `SPEC_APPROVED`: OTORGADO**
> **Base:** `chaski-v3@cc02b61`, `main`, árbol limpio (`git status --porcelain` vacío, verificado hoy).

---

## 0 · Antes de escribir una línea: las citas se re-derivan

⚠️ Todas las citas `archivo:línea` de este documento se derivaron **hoy**, sobre `cc02b61`, con
`sed -n 'Np'`. Si algo mergeó sobre `chaski-v3` entre este documento y tu primer commit,
**re-derivá las citas de §4 antes de editar** (CD-W1-3).

Verificado hoy, y son los números de los que cuelga toda la ola:

| Hecho | Cómo se verifica | Valor de hoy |
|---|---|---|
| `wc -l src/presentation/flow.tsx` | `wc -l` | **4453** |
| Marcador de censo de `flow.tsx` (`:44`) | `sed -n '44p' \| grep -o '\[\[CENSO[^]]*\]\]'` | `[[CENSO src/presentation/flow.tsx entrantes=155]]` y `[[CENSO src/presentation/flow.tsx destinos=92]]` |
| Marcador de censo de `solana-wallet.ts` (`:893`) | ídem | `[[CENSO src/infrastructure/solana-wallet.ts entrantes-desde-893=76]]` |
| Conteo de archivos de test en los dos README | `README.md:436`, `README.es.md:462` | **165** en los dos |
| Gate del repo | `package.json:20` | `qa` = `lint && typecheck && typecheck:scripts && test` |

⛔ **Cuando termines la ola, los tres marcadores `[[CENSO …]]` y el conteo de los README se
re-derivan corriendo, nunca contando a mano** (CD-W1-7, CD-W1-8).

---

## 1 · Qué se construye y por qué (contexto compacto)

Hoy, en el navegador común de un celular, mandar una remesa cuesta **6 saltos a la app de la
billetera** y atravesar la pantalla de entrada **7 veces**: cada firma es una navegación fuera del
sitio, y la vuelta remonta el árbol de React.

Existe un deeplink `browse` que abre la app **DENTRO** de Phantom, donde el provider está
**inyectado**. Y acá está el hallazgo que define el tamaño de esta ola:

> 🔴 **El recorrido dentro del navegador de la billetera YA CUMPLE casi todo lo que W1 promete, y lo
> cumple sin escribir una línea de producción. Lo que falta no es el recorrido: es la puerta de
> entrada a ese recorrido, la honestidad sobre lo que se pierde al cruzarla, y el instrumento que lo
> demuestre corriendo.**

Las tres citas que lo encadenan, **verificadas hoy**:

1. `src/infrastructure/solana-wallet.ts:2240`, primera sentencia:
   `if (solanaWalletBridge.getWalletAvailability() !== "none") return null;`
   ⇒ `caminoPorEnlace()` devuelve `null` en cuanto la disponibilidad **no** es `"none"`.
2. Dentro del navegador de Phantom la disponibilidad es `"injected"`, y eso está medido con la
   librería real y el **mismo user agent de celular** que el caso `"none"`:
   `src/presentation/wallet-availability.test.tsx:146` (`T-CABLE-2`) vs `:128` (`T-CABLE-1`).
3. Los **dos** bloques del camino por enlace de `authorizePrincipal` están gateados por
   `if (this.firmaPorEnlace && this.caminoPorEnlace() !== null)` — `solana-wallet.ts:769` (crea la
   cuenta de nonce y aplica el umbral del enlace en `:806`) y `solana-wallet.ts:897`.

⇒ **Dentro del navegador de la billetera, la cuenta de nonce ya es inalcanzable, el umbral que aplica
ya es el inyectado, y `prepare()` ya corre una sola vez.** W1 no tiene que provocar eso.

**Qué construye W1, entonces, y nada más que esto:**
- La **oferta** de saltar al navegador de la billetera, en la pantalla de entrada, como un enlace que
  la persona toca.
- La **honestidad** sobre el borde: el navegador de Phantom es otra partición de almacenamiento, y el
  código **no afirma** si el borrador sobrevive: **lo pregunta cuando aterriza**.
- El **instrumento**: 13 tests que se rompen a propósito, empezando por 5 que prueban la premisa
  sobre el árbol de hoy, con cero líneas de producción.

---

## 2 · Los criterios de aceptación de W1 — la lista cerrada

- **AC-1-1**: WHEN una persona abre Chaski en el navegador común de un celular y **tiene** la
  billetera instalada, the system SHALL ofrecerle abrir la app dentro del navegador de la billetera,
  y ese salto SHALL ocurrir **dentro de un gesto de la persona** (nunca desde un efecto de montaje).
- **AC-1-2a** *(ver §2.1)*: WHILE la app corre dentro del navegador de la billetera, the system SHALL
  completar el envío con **0 saltos a la app de la billetera** y **0 remontajes del árbol causados
  por una firma**.
- **AC-1-2b** *(ver §2.1)*: WHERE la persona ya tiene su identidad verificada, the system SHALL
  atravesar la pantalla de entrada **exactamente 1 vez**. IF la persona verifica su identidad en este
  envío, THEN la travesía adicional la causa el redirect del verificador (`flow.tsx:460`), que está
  **fuera del alcance de esta HU**, y el AC se cierra igual midiendo **0 viajes a la billetera**.
- **AC-1-3**: WHILE la app corre dentro del navegador de la billetera, the system SHALL **no crear
  ninguna cuenta de nonce duradero** y SHALL exigir el umbral del camino inyectado
  (`SENDER_MIN_LAMPORTS_FOR_DEPOSIT`), no el del camino por enlace. ⛔ the system SHALL **NO** cambiar
  el **valor** de ninguna de las dos constantes: elige cuál aplica, no cuánto vale (CD-12).
- **AC-1-4**: IF la persona **no tiene** la billetera instalada, THEN the system SHALL ofrecerle
  **instalarla y crear su billetera**, y ese ofrecimiento SHALL terminar en el mismo recorrido
  principal, no en una pantalla sin salida. ⛔ SHALL **NO** ofrecer una billetera custodial ni
  embebida (CD-2).
- **AC-1-4b**: WHILE la persona vuelve de instalar la billetera, the system SHALL conservar el estado
  del envío que ya había cargado, o SHALL decirle explícitamente que tiene que empezar de nuevo.
  ⛔ **PROHIBIDO** el tercer desenlace: volver a una pantalla que perdió los datos **sin decirlo**.
- **AC-1-5**: WHERE el camino por enlace profundo sigue habilitado, the system SHALL conservarlo
  funcional y SHALL conservar el código del durable nonce sin borrar. IF un diff de W1 elimina
  archivos de `src/infrastructure/solana/deeplink/**` o `src/infrastructure/solana/nonce-duradero.ts`,
  THEN es **BLOQUEANTE** en AR.
- **AC-1-6**: WHEN se cierra W1, the system SHALL publicar el conteo de invocaciones de `prepare()`
  por envío en el camino principal, y ese conteo SHALL ser **1**, con **0** órdenes de payout
  huérfanas.

### 2.1 · 🔴 `AC-1-2` se PARTE EN DOS — la decisión del gate, con su razón escrita

**Esto ya está decidido. No se re-decide, no se afloja, y va copiado tal cual en el reporte de la
ola.**

El `AC-1-2` original pedía *«0 saltos entre apps, 0 remontajes del árbol, y exactamente 1 travesía de
la pantalla de entrada»*. **En el recorrido de primera vez ese criterio es inalcanzable**, y la razón
es medible: el paso de identidad hace `window.location.href = res.url` hacia el verificador —
`flow.tsx:460`, verificado hoy —, y el propio repo lo llama textual *«una RECARGA»* en
`flow.tsx:235`: *«La vuelta de Didit es una RECARGA (`window.location.href = res.url`, misma pestaña
…)»*.

**Esa recarga ya existía y no es de esta ola**: es la redirección al proveedor de KYC, **no un viaje a
la billetera**. W1 mide **viajes a la billetera**, así que contarla en contra mezcla dos cosas
distintas.

| AC | Qué mide | Listón |
|---|---|---|
| **AC-1-2a** (recurrente) | Cumple al pie de la letra: **0 remontajes** y **1 travesía**. El atajo de identidad saltea `review` y `verify` (`flow.tsx:356-360`, el bloque `rememberedKyc.approved && rememberedKyc.realVerified`, verificado hoy) | **Estricto. No se afloja.** |
| **AC-1-2b** (primera vez) | **Declara explícitamente la recarga que hereda**, la nombra con su cita (`flow.tsx:460`, `flow.tsx:235`), y mide igual **0 viajes a la billetera** | Estricto sobre lo que W1 sí controla |

⛔ **Esto NO afloja la medición.** El recorrido recurrente mantiene el listón estricto. El de primera
vez **declara lo que hereda en vez de fingir que no existe**. Cerrar `AC-1-2` mirando sólo el
recorrido recurrente sería un falso verde; cerrarlo con el de primera vez sería declarar FAIL una ola
que hizo bien su trabajo.

---

## 3 · Scope — la lista exhaustiva de archivos

### 3.1 · Scope IN (todo bajo `/home/ferdev/.openclaw/workspace/chaski-v3`)

| # | Archivo | Acción | Δ líneas esperado | Wave |
|---|---|---|---|---|
| **A** | `src/presentation/salida-al-navegador-de-la-billetera.ts` | **CREAR** | +130 ± 40 | W1.1 |
| **B** | `src/presentation/salida-al-navegador-de-la-billetera.test.ts` | **CREAR** | +130 ± 40 | W1.1 |
| **C** | `src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx` | **CREAR** | +320 ± 100 | W1.0 |
| **D** | `src/presentation/flow.tsx` | **MODIFICAR, Δ0 OBLIGATORIO** | **0** | W1.2 |
| **E** | `src/presentation/wallet-availability.test.tsx` | **MODIFICAR** (apéndice de `it`s al final) | +90 ± 30 | W1.2 |
| **F** | `src/presentation/bitacora-de-vuelta.ts` | **MODIFICAR** | +0 en `:96` (en línea) / +8 al final | W1.3 |
| **G** | `src/presentation/diagnostico-de-vuelta.tsx` | **MODIFICAR, Δ0** | **0** | W1.3 |
| **H** | `README.md` | **MODIFICAR** (`:436`, una línea reescrita) | 0 | W1.4 |
| **I** | `README.es.md` | **MODIFICAR** (`:462`, ídem, **por separado**) | 0 | W1.4 |

### 3.2 · Scope OUT — tocarlos es **BLOQUEANTE en AR**

- ⛔ `src/infrastructure/solana-wallet.ts` — **CD-W1-2, cero líneas, ni un comentario.**
- ⛔ `src/application/solana-escrow-rent.ts` — CD-12, ningún valor de umbral se toca.
- ⛔ `src/infrastructure/solana/deeplink/**` (los 7 módulos).
- ⛔ `src/infrastructure/solana/nonce-duradero.ts`.
- ⛔ `src/infrastructure/solana/preparacion-por-enlace.ts`.
- ⛔ `src/presentation/flow-vm.ts` — es de la HU `071` de `chaski-v3`.
- ⛔ `src/presentation/splash-puerta.ts` — CD-W1-12, no se le agrega un sexto motivo.
- ⛔ Cualquier archivo de `app/api/**` — W1 no cambia ningún contrato de servidor. **Diff esperado en
  `app/`: 0 archivos.**
- ⛔ Cualquier archivo de `wasiai-facilitator` (en particular `src/methods/solana-sponsor/cr1.ts`, que
  es de la HU `071`).
- ⛔ Cualquier archivo de `src/` de `wasiai-a2a`.

---

## 4 · Anti-Hallucination Checklist — específica de esta HU

Marcá cada una **antes** de escribir código. Todas están verificadas hoy sobre `cc02b61`.

- [ ] `src/presentation/wallet-availability.ts:26-28` existe y exporta
      `phantomBrowseUrl(href: string, origin: string): string`, que devuelve
      `` `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(origin)}` ``.
      ⛔ **Se reusa, no se reescribe.**
- [ ] `src/presentation/wallet-availability.ts:36` exporta `useWalletAvailability()`.
      ⛔ **Es el ÚNICO detector. No se escribe otro y no se mira el user agent** (CD-W1-11).
- [ ] `src/presentation/wallet-availability.ts:98` (`mwaEnabled`) y `:156` (`deeplinkEnabled`) son el
      patrón de **opt-in estricto** (comparación con el literal exacto, no `has()`).
- [ ] `src/presentation/flow.tsx:1349` es
      `function NoWalletHere({ direccionConectada, vueltaSinResolver }: { … })` (134 caracteres).
- [ ] `src/presentation/flow.tsx:1351` tiene el guard
      `if (availability !== "none" || direccionConectada !== null || vueltaSinResolver) return null;`
- [ ] `src/presentation/flow.tsx:1354-1355` derivan `href` y `origin` de `window.location`.
- [ ] `src/presentation/flow.tsx:1379` es **exactamente** `href={phantomBrowseUrl(href, origin)}`
      (46 caracteres, línea propia), dentro del `<a>` que abre en `:1378` y cierra en `:1384`.
- [ ] `src/presentation/flow.tsx:1386` es la nota al pie: *«Si estás en una computadora, instalá la
      extensión de Phantom o Solflare y recargá la página.»* (106 caracteres).
- [ ] `src/presentation/flow.tsx:963` contiene, dentro de una línea de 2824 caracteres,
      `<NoWalletHere direccionConectada={address} vueltaSinResolver={vueltaSinResolver} />`.
- [ ] `src/presentation/flow.tsx:757` es la línea de avisos pre-cuerpo (6758 caracteres) y ya lleva
      **tres** avisos conviviendo: `saltoPendiente`, `avisoKyc`, `estadoNonce`.
- [ ] `src/presentation/flow.tsx:77` es la línea de imports que ya trae
      `phantomBrowseUrl, useWalletAvailability, useConnectedWalletAddress, mwaEnabled, useMwaOffered, deeplinkEnabled`
      desde `"./wallet-availability"`, y **termina en un `//`**.
- [ ] `src/infrastructure/solana/deeplink/conexion.ts:362` exporta
      `hrefSinRastroDeVuelta(hrefActual: string): string`. ⚠️ **NO borra `kyc`.**
- [ ] `src/presentation/splash-puerta.ts:45` exporta `PARAM_KYC = "kyc"`.
- [ ] `src/presentation/bitacora-de-vuelta.ts:96` es
      `export type HitoDeVuelta = "pantalla" | "connect" | "continuacion" | "error";`
      y su docblock de `:95` dice textual: *«Los cuatro, cerrados. Un quinto obliga a decidir qué
      pregunta contesta y a darle renglón.»*
- [ ] `src/presentation/diagnostico-de-vuelta.tsx` tiene `PARAM_DIAG = "diag"` (`:151`),
      `diagnosticoPedido` (`:164`), `presenciaEnElDisco` (`:328`) y los `renglonDe*` en `:396`,
      `:411`, `:425`.
- [ ] `src/composition/citas-ancladas.test.ts:331` tiene el regex
      `const CENSO = /\[\[CENSO ([\w./-]+) (lineas|entrantes|destinos)(?:-desde-(\d+))?=(\d+)\]\]/g;`
      ⛔ **Ese es el guard de Δ0. NO escribas otro.**
- [ ] `src/composition/readme-test-count.test.ts:38` define
      `TEST_DIRS = ["src", "app", "contracts", "scripts"]` y mide los dos README **por separado**.
- [ ] `src/application/use-cases/confirm-and-send.ts:428` es
      `if (senderSol.status === "known" && senderSol.lamports < SENDER_MIN_LAMPORTS_FOR_DEPOSIT) {`
- [ ] `src/application/solana-escrow-rent.ts:187` (`SENDER_MIN_LAMPORTS_FOR_DEPOSIT`), `:332`
      (`NONCE_ACCOUNT_RENT_LAMPORTS = 1_447_680`) y `:352` (`SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT`,
      **derivada, no literal**). ⛔ **Se importan. No se toca ningún valor.**
- [ ] `src/infrastructure/persistence.ts:15` exporta `KEY = "chaski.remittances.v1"`.
- [ ] La rama `feat/wkh-372-w1-navegador-de-la-billetera` **no existe**.

---

## 5 · Constraint Directives — copiadas textuales, todas vigentes

### 5.1 · Las duras de esta ola

- 🔴 **CD-W1-1 · Δ0 DE LÍNEAS EN `src/presentation/flow.tsx`.** El archivo mide **4453** líneas y ese
  número **es un marcador verificado** (`[[CENSO src/presentation/flow.tsx lineas=4453]]`, `:44`).
  **Lo nuevo entra en líneas físicas ya existentes.** IF el diff cambia el conteo de líneas de ese
  archivo, THEN es **BLOQUEANTE** en AR. **Se verifica con `wc -l`, no leyendo el diff.**
  ⛔ **Ya hay un guard que lo vigila: `src/composition/citas-ancladas.test.ts` con el marcador
  `[[CENSO … lineas=4453]]`. NO agregues un guard nuevo para lo mismo** — serían dos números que se
  corrigen por separado.
- 🔴 **CD-W1-2 · `src/infrastructure/solana-wallet.ts` NO se edita en W1.** Cero líneas, aunque el
  cambio sea un comentario. Es lo que evita re-derivar las **76 citas ancladas** bajo `:893`
  (marcador `[[CENSO src/infrastructure/solana-wallet.ts entrantes-desde-893=76]]`) y lo que impide
  que esta ola se pise con la HU `071` de `chaski-v3`. IF el diff de W1 lo toca, THEN **BLOQUEANTE**
  en AR.
- ⛔ **CD-5 · El código del durable nonce NO se borra.** Desaparece por **inalcanzabilidad**, no por
  deleción. `src/infrastructure/solana/nonce-duradero.ts` y `deeplink/**` quedan enteros.
- ⛔ **CD-12 · Ningún documento, copy, comentario ni reporte de esta ola puede decir *«el remitente no
  necesita SOL»*.** Tampoco se toca el **valor** de ningún umbral de SOL.
- ⛔ **CD-W1-11 · La detección NO usa user agent.** Usá el detector de disponibilidad que ya existe:
  `useWalletAvailability()` (`wallet-availability.ts:36`). El motivo está escrito en el repo
  (`wallet-availability.ts:84-90`): *«mirar el user agent por nuestra cuenta sería una segunda opinión
  que puede contradecir a la primera»*. El par `T-CABLE-1`/`T-CABLE-2` existe justamente para impedir
  «arreglarlo mirando el user agent».
- ⛔ **El enlace al navegador de la billetera es algo que la persona toca, nunca una redirección
  programática.** Ni `useEffect`, ni `setTimeout`, ni `requestAnimationFrame`, ni `router.push`, ni
  asignar `window.location.href`. Dos fundamentos independientes: (1) la doc de Phantom de hoy dice
  textual *«These deeplinks must either be handled by an app or clicked on by an end user»*; (2) el
  founder lo midió en su teléfono con la foto `t=12830 ms`, escrito en `flow.tsx:286`: la navegación
  programática fuera de un gesto **la descartan los navegadores móviles sin error y sin rastro**, y
  ese comentario dice textual que **no se arregla con un `setTimeout` ni con un
  `requestAnimationFrame`**.
- ⛔ **CD-W1-12 · No se toca `motivoParaNoMostrar` ni se le agrega un sexto motivo.** El parámetro
  nuevo (`wb`) es invisible para esa puerta **y tiene que seguir siéndolo**: esa puerta mira sólo
  `kyc` y `dl`.
- ⛔ **CD-1 · No se toca la arquitectura A2A.** Diff esperado en `app/`: **0 archivos**.
- ⛔ **CD-2 · Ninguna custodia de la clave.** El único enlace de instalación va a la app no custodial.
- ⛔ **CD-3 · No se apaga ni se borra el recorrido por enlace.** `deeplinkEnabled()` y el selector de
  enlace (`flow.tsx:963`) quedan **exactamente como están**. W1 **agrega** una entrada, no reemplaza
  ninguna.
- ⛔ **CD-8 · Ningún número se publica sin su camino y su instrumento.** Los números de éxito los
  produce W1.0 **corriendo**, no copiándolos de este documento.
- ⛔ **CD-11 · Las cuatro cosas que `solana-wallet.ts:894` declara sin verificar NO se convierten en
  afirmación del código.** W1 no las cierra ni las nombra como resueltas.
- ⛔ **CD-13 · No se re-deriva el diseño de la HU `071`.** Se la cita por ruta.

### 5.2 · Las 8 del Auto-Blindaje — errores recurrentes de las últimas HUs, transcritas

Estas salen de leer los `auto-blindaje.md` de las HUs `075`, `073` y `069` de `chaski-v3`. **No son
teoría: son el error que ya pasó, con la frase textual de quien lo cometió.**

- **CD-W1-3 · ⛔ PROHIBIDO ESCRIBIR UNA CITA `archivo:línea` QUE NO SE HAYA DERIVADO EN ESA MISMA
  SESIÓN.** Recurrente en **3 de 3** auto-blindajes (075: *«escribí DOS citas ancladas que nunca
  derivé»*, *«tres citas ancladas nuevas derivadas de memoria, y las tres apuntaban mal»*; 073:
  *«rompí con MI PROPIA edición la cita que YO acababa de escribir»*; 069: *«escribí un número de
  línea antes de medirlo, dos veces»*, *«`rtk cat -n` me dio números FALSOS»*).
  **OBLIGATORIO**: cada cita nueva se deriva con `sed -n 'Np'` **después** de la última edición del
  archivo destino, y se **re-deriva al final de la ola**.
- **CD-W1-4 · ⛔ NINGÚN GUARD PUEDE LEERSE A SÍ MISMO.** IF un `it` busca un literal en la misma línea
  donde ese literal aparece, THEN **nunca puede fallar** y es **BLOQUEANTE**. Recurrente en 075
  (*«mi propio `assert` de limpieza matcheaba el texto que yo acababa de escribir»*, *«una afirmación
  en MAYÚSCULAS que ningún test podía poner en rojo»*) y 073 (*«21 citas correctas y sin un solo
  candado que las mirara»*). **El antídoto que el repo ya tiene**: `T-H1-3`
  (`T-H1-3`, por nombre; al `b402ab7` en `wallet-availability.test.tsx:975`), que **lee** el alto de un `<Button>` renderizado en vez de
  re-escribirlo.
- **CD-W1-5 · ⛔ UN `exit=1` SIN UN `×` NOMBRADO NO ES UN KILLED.** Todo test que afirme un
  comportamiento se rompe a propósito y se cita el rojo con **archivo, nombre del `it`, y por qué
  murió**. IF el mutante muere por un error de sintaxis, por un guard vecino, o por un fixture que ya
  daba verde sin el arreglo, THEN es **falso KILLED y no cuenta**. Recurrente en 075 (*«el mutante
  murió de un ERROR DE SINTAXIS»*, *«UN FALSO KILLED MÍO»*, *«el fixture no reproducía el defecto y
  daba verde con y sin el arreglo»*) y 073 (*«un mutante MAL CONSTRUIDO sobrevive y absuelve a un
  guard que sí funciona»*, *«un control positivo que NO renderizaba nada»*).
- **CD-W1-6 · ⛔ PROHIBIDO CITAR EL GATE SIN CORRERLO ENTERO Y EN ORDEN.** `lint` va **primero** y es
  el eslabón que nadie alcanza: 075 (*«el gate falló en LINT»*) y 069 (*«corrimos las PARTES del gate,
  nunca el GATE»*, *«un error de lint NO se ve en la salida de `npm run lint`»*). Ver §8.
- **CD-W1-7 · ⛔ AGREGAR UN ARCHIVO `*.test.ts(x)` ROMPE `readme-test-count.test.ts`, Y ESO ES
  CORRECTO.** Los **dos** README declaran el conteo (`README.md:436`, `README.es.md:462`, hoy **165**)
  y el candado los mide **por separado**, a propósito, porque *«el modo de falla de una traducción
  parcial no es decir algo falso: es OMITIR»* (`readme-test-count.test.ts:24-26`).
  **OBLIGATORIO**: el número nuevo se **deriva corriendo el candado**, nunca contando a mano.
- **CD-W1-8 · ⛔ LOS MARCADORES `[[CENSO …]]` SE RE-DERIVAN AL FINAL DE LA OLA, NO AL PRINCIPIO.**
  Recurrente en 075 (*«el marcador envejeció DOS veces en la misma sesión, y la segunda la causó mi
  propio test»*) y 073 (*«se re-derivan UNA VEZ POR COMMIT que agrega citas»*). Si W1 agrega citas
  ancladas a `flow.tsx`, el marcador `entrantes=155` cambia y hay que actualizarlo **después** del
  último commit de código.
- **CD-W1-9 · ⛔ EL FLAKE PREEXISTENTE NO SE PONE EN CUARENTENA, NI SE CUENTA COMO REGRESIÓN, NI SE
  DECLARA CON UN DENOMINADOR CHICO.** `src/presentation/vuelta-por-enlace-carrera.test.tsx`,
  `PUERTA 1` (`:259`) y `PUERTA 2` (`:279`), **7-13 %**, **no es de esta HU**. **OBLIGATORIO**: si
  aparece en rojo, se corre **el mismo archivo N veces sobre `cc02b61` sin el diff** y se reporta la
  frecuencia de las dos ramas. Recurrente en 075 (*«casi reporto que EMPEORÉ un flake, con un
  denominador de 10»*) y 069 (*«lo dejo escrito en vez de re-correr hasta el verde»*).
- **CD-W1-10 · ⛔ UNA FRASE CORREGIDA SIGUE PUDIENDO SER FALSA.** Recurrente en 073 (*«la frase
  corregida seguía siendo falsa, con menos filo»*) y 075 (*«los docblocks que mi propio arreglo volvió
  falsos»*, *«una conclusión de SEGURIDAD falsa debajo de una decisión correcta»*).
  **OBLIGATORIO**: cada frase nueva de copy o de docblock se acompaña del **input concreto que la
  pondría en rojo**. Si no existe ese input, la frase se recorta hasta que exista.

### 5.3 · Reglas de estilo del copy visible

- Español rioplatense.
- **Sin em dashes.**
- **No decir que algo falló cuando no falló** (`flow.tsx:757` lo persigue por escrito).
- No prometer lo que no está medido.
- ⛔ No usar *«el remitente no necesita SOL»* (CD-12).

---

## 6 · Las waves, en orden de dependencia

> El orden **es** load-bearing. **W1.0 puede detener la ola entera.**

---

### 🔴 W1.0 · La premisa, falsable, sobre el árbol de hoy · **SERIAL · BLOQUEANTE · 0 LÍNEAS DE PRODUCCIÓN**

**Archivo: C** (`src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx`) — **crear**.

Se escribe y se corre **sin tocar una sola línea de producción**. Prueba, con
`availability = "injected"` empujado por el **árbol real** (patrón `T-CABLE-2`,
`wallet-availability.test.tsx:146`, que monta la librería de verdad y **lee** la disponibilidad;
⛔ nadie la setea a mano), que **hoy**:

1. `caminoPorEnlace()` es `null` ⇒ `pedir()` contesta `no-corresponde`.
2. `authorizePrincipal` **no** construye ninguna instrucción de creación de cuenta de nonce.
3. El guard de saldo que corre es el del camino común (`confirm-and-send.ts:428`), o sea el umbral
   **inyectado**. **Se prueba por VALOR, no por nombre**: un saldo exactamente igual a
   `SENDER_MIN_LAMPORTS_FOR_DEPOSIT` **pasa** (con el umbral del enlace no pasaría).
4. `prepare()` se invoca **exactamente 1 vez** en un envío que cierra.
5. **No se asigna `window.location.href` a ningún host de billetera** durante todo el recorrido.

> ⛔ **SI ALGUNO DE ESOS 5 SALE ROJO, LA OLA SE DETIENE Y SE REPORTA.** Significa que **la premisa del
> diseño es falsa**: toda W1 se apoya en que ese recorrido ya funciona hoy. No se «arregla» el test,
> no se ajusta el fixture hasta el verde, no se sigue a W1.1. Se para, se escribe qué salió rojo con
> su salida textual, y se escala al humano.

**Tests que entran acá:** `T-372-W1-3`, `T-372-W1-4`, `T-372-W1-5`, `T-372-W1-11`, `T-372-W1-12`,
`T-372-W1-13` (§7).
**AC que cierra:** AC-1-2a, AC-1-2b, AC-1-3, AC-1-5, AC-1-6 *(la parte medible sobre el árbol)*.
**Sale con:** el archivo C creado, el gate completo verde (§8), y los mutantes de esos 6 tests
nombrados con su `×` (CD-W1-5).

**Tareas:**
- [ ] **T1** — Crear la rama `feat/wkh-372-w1-navegador-de-la-billetera` desde `main@cc02b61`.
- [ ] **T2** — Re-derivar con `sed -n 'Np'` las citas de §4 que vayas a usar (CD-W1-3).
- [ ] **T3** — Crear el archivo **C** con el arnés de `"injected"` copiado del patrón `T-CABLE-2`
      (`wallet-availability.test.tsx:146-152`). ⛔ La disponibilidad **se lee del árbol**, no se
      mockea a mano.
- [ ] **T4** — Escribir `T-372-W1-3` (0 viajes a la billetera, estado terminal asertado).
- [ ] **T5** — Escribir `T-372-W1-4` (sin ix de creación de cuenta de nonce).
- [ ] **T6** — Escribir `T-372-W1-5` (umbral inyectado **por valor**, importando las dos constantes).
- [ ] **T7** — Escribir `T-372-W1-11` (el camino de respaldo sigue entero: **lee el árbol**).
- [ ] **T8** — Escribir `T-372-W1-12` (`toHaveBeenCalledTimes(1)`).
- [ ] **T9** — Escribir `T-372-W1-13` (las travesías: caso recurrente estricto + caso primera vez con
      la recarga heredada declarada).
- [ ] **T10** — Correr el gate completo (§8). **Si alguno de los 5 puntos de la premisa sale rojo:
      PARAR y reportar.**
- [ ] **T11** — Matar los 6 mutantes de §7, uno por uno y **por separado**, citando archivo · nombre
      del `it` · por qué murió.

---

### W1.1 · El módulo puro · **SERIAL** (depende de W1.0 sólo por el semáforo)

**Archivos: A** (`salida-al-navegador-de-la-billetera.ts`) **y B** (su test).
Sin React, sin UI, **sin tocar `flow.tsx`**.

**Por qué es un archivo nuevo y no un apéndice a `wallet-availability.ts`:** un archivo nuevo **rota
cero citas ancladas de cualquier archivo**. Y `wallet-availability.ts` se define a sí mismo como *«no
importa `@solana/wallet-adapter-*`, lee el singleton React-free»* (`:3-5`); meterle
`deeplink/conexion.ts` y `splash-puerta.ts` lo acoplaría.

**Contrato exacto del archivo A** (esto es lo que hay que escribir, ni más ni menos):

```ts
export const URL_INSTALAR_PHANTOM: string
   // "https://phantom.com/download" — medido HTTP 200 el 2026-08-31.
   // phantom.app/download devuelve 301 hacia esta.

export const PARAM_SALIDA: string      // "wb"
export const VALOR_SALIDA: string      // "1"

export function urlDeSalidaAlNavegadorDeLaBilletera(p: {
  href: string;      // window.location.href del navegador de ORIGEN
  origin: string;    // window.location.origin
  hayBorrador: boolean;
}): string
   // 1. limpia el href: hrefSinRastroDeVuelta(href) y ADEMAS borra PARAM_KYC.
   // 2. si hayBorrador, agrega PARAM_SALIDA=VALOR_SALIDA.
   // 3. devuelve phantomBrowseUrl(limpio, origin).
   // href impareseable ⇒ devuelve phantomBrowseUrl(href, origin), igual que hoy.
   //   ⛔ No se inventa una URL.

export function vinoDeUnaSalidaConBorrador(href: string): boolean
   // true SOLO si el href trae PARAM_SALIDA con VALOR_SALIDA exacto.
   // Un href impareseable ⇒ false.
```

**Las tres decisiones del contrato, con su razón (van al docblock del archivo):**
1. **`hayBorrador` es un parámetro, no una lectura del disco adentro del módulo.** El módulo se
   mantiene puro y testeable sin `localStorage`; quien sabe si hay borrador es la pantalla.
2. **`vinoDeUnaSalidaConBorrador` compara el valor exacto, no `has()`.** Opt-in estricto, mismo patrón
   y por la misma razón que `mwaEnabled` (`wallet-availability.ts:98`) y `deeplinkEnabled` (`:156`).
3. **`PARAM_SALIDA` NO se agrega a `motivoParaNoMostrar`** (CD-W1-12). Esa puerta mira sólo `kyc` y
   `dl` ⇒ el splash se muestra normal en el primer aterrizaje dentro de la billetera, que es lo
   correcto: es una primera visita en ese navegador.

**Qué borra la limpieza, y por qué las tres cosas:** lo que borra `hrefSinRastroDeVuelta`
(`conexion.ts:362`: los `PARAMS_DE_RESPUESTA` y la marca `dl`) **más** `PARAM_KYC`
(`splash-puerta.ts:45`), que esa función **no** borra. Los tres son rastros del navegador de
**origen** y no significan nada en el de destino.

> ⚠️ **Por qué se borra `kyc`, y es un defecto latente que hoy ya está en producción:** hoy
> `NoWalletHere` toma `window.location.href` **crudo** (`flow.tsx:1354`). Si la persona está en
> `/?kyc=return` (el aterrizaje del verificador, `urlDeVueltaDeKyc`, `splash-puerta.ts:54`), ese
> parámetro **viaja tal cual** al navegador de Phantom, donde la puerta del splash lo lee como
> vuelta de KYC y arranca un resume de un KYC que en **ese** almacenamiento no existe.
> Se arregla acá porque W1 reescribe exactamente esa expresión y dejarlo sería empeorar el camino que
> la ola promueve.

**Tests que entran acá:** `T-372-W1-8`, `T-372-W1-9`, `T-372-W1-10` (§7).
**AC que cierra:** AC-1-4b *(la mitad de la salida)*.
**Sale con:** `npm run qa` verde + los 3 mutantes nombrados.

**Tareas:**
- [ ] **T12** — Crear el archivo **A** con el contrato de arriba y su docblock (las 3 decisiones + la
      razón del borrado de `kyc`).
- [ ] **T13** — Crear el archivo **B** con `T-372-W1-8`, `T-372-W1-9`, `T-372-W1-10`.
- [ ] **T14** — Correr el gate completo (§8).
- [ ] **T15** — Matar los 3 mutantes de §7 correspondientes, con su `×` nombrado.

---

### W1.2 · Las inserciones Δ0 en `flow.tsx` y sus tests de pantalla · **depende de W1.1**

**Archivos: D** (`flow.tsx`, **Δ0 estricto**) **y E** (`wallet-availability.test.tsx`, apéndice).

> ⛔ **TODAS las inserciones van DENTRO de una línea física que ya existe.** El invariante está
> escrito en el propio `flow.tsx:44`: *«TODO lo que está más abajo se corre con una línea nueva
> acá»*. Al terminar, `wc -l src/presentation/flow.tsx` tiene que seguir dando **4453**.

#### I-1 · `flow.tsx:77` — los imports

Se agregan los símbolos del módulo nuevo **al final de la cadena de `import …;` y ANTES del `//`**
que cierra la línea.
⚠️ El propio comentario de `:77` explica por qué es esa línea y no `:74`, y advierte que pegarlo
**después** del `//` lo deja **comentado sin que `tsc` lo cace**.

#### I-2 · `flow.tsx:757` — el bloque de avisos pre-cuerpo

Entran **dos** nodos nuevos en esa misma línea, junto a los tres que ya viven ahí
(`saltoPendiente`, `avisoKyc`, `estadoNonce`).

**(a) La oferta**, condicionada por:

```
step === "bienvenida"
  && disponibilidadWallet === "none"
  && saltoPendiente === null
  && !vueltaSinResolver
  && avisoKyc === null
  && estadoNonce === null
```

**Ninguna condición es decorativa. Cada una tiene su motivo:**

| Condición | Por qué |
|---|---|
| `step === "bienvenida"` | En `send` hay datos a medio cargar; ofrecer ahí el salto es ofrecer perderlos. En `history` y `recuperar` la persona no está enviando |
| `disponibilidadWallet === "none"` | Con `"injected"` la persona **ya está adentro** y no ve nada nuevo. Con `"unknown"` todavía no se sabe, y afirmar antes de saber es lo que `T-CABLE-4` prohíbe |
| `saltoPendiente === null` | Si hay un salto pendiente, ese enlace es **lo único** que la persona puede hacer. Dos enlaces compitiendo ahí es el defecto que la HU 075 cerró |
| `!vueltaSinResolver` | Mismo motivo que la tercera condición de `NoWalletHere` (`:1351`): mientras no se sabe, no se afirma |
| `avisoKyc === null` | Ese aviso lleva un envío a medias con su snapshot; saltar lo pierde |
| `estadoNonce === null` | La tarjeta del nonce es del camino de respaldo y tiene sus propias salidas |

**(b) El aviso de aterrizaje**, condicionado por:
`step === "bienvenida" && aterrizaje.vinoConMarca && rem === null && aterrizaje.borradorEnElDisco === "sin-borrador"`.

> ⚠️ **Segunda corrección del orquestador (F4/`QA-MNR-2`), 2026-08-31.** Acá decía
> `!aterrizaje.hayBorrador`, que es la forma **anterior** al fix-pack 3. La cuarta condición
> cambió de forma al cerrar `CR/BLQ-BAJO-1`: `hayBorrador` era booleano y colapsaba
> *"no pude leer el disco"* en *"no hay borrador"*, o sea que le decía a la persona que sus
> datos no estaban **cuando sí estaban**. Hoy son tres valores
> (`"con-borrador" | "sin-borrador" | "disco-ilegible"`) y el aviso **exige haber preguntado**.
> Esa diferencia ES el cierre del hallazgo, no una variante de redacción.

> 🔴 **ENMENDADO el 2026-08-31 por el ORQUESTADOR, en el gate del AR (iteración 1, `MNR-4`).**
> Acá decía **tres** condiciones y hoy son **cuatro**. Lo que se agregó es `step === "bienvenida"`.
>
> **El motivo, medido por el AR**: sin ese gate, con `?wb=1` y disco vacío el aviso *"Acá no están los
> datos que cargaste antes"* seguía pintado en `send`, en `history` y en `recuperar`, donde `rem` sigue
> siendo `null` y la frase no aplica. La **oferta** vecina ya llevaba `step === "bienvenida"` con su
> motivo escrito ⇒ esto es **consistencia con el vecino, no diseño nuevo**.
>
> La otra mitad de la enmienda (`MNR-3`): el aviso **consume** `aterrizaje.vinoConMarca`, la foto que
> `flow.tsx:146` ya captura, en vez de **recalcular** `vinoDeUnaSalidaConBorrador(hrefActual)` en cada
> render. Dos lecturas de la misma marca que se corrigen por separado son el defecto que el docblock
> de `:146` ya declaraba para el disco.
>
> ⛔ **Esta enmienda es normativa para F4**: el AC se valida contra las CUATRO condiciones. El guard es
> `T-372-W1-7c` (buscalo por nombre; al `b402ab7` esta en `wallet-availability.test.tsx:1660`), y
> muere con el mutante que le quita el gate.
>
> ⚠️ **Corrección del 2026-08-31 (CR/MNR-3), hecha por el orquestador**: acá decía `:1476`, que es un
> **comentario adentro de `T-372-W1-7`**, no el `it` del guard. Re-derivado con `sed -n '1573p'`:
> `it("T-372-W1-7c: el aviso de aterrizaje vive en la bienvenida y no se cuela en «recuperar»"`.
> La cita se escribió antes del renombre de `MNR-A` y no se re-derivó después de la última edición.
> Es la misma clase de defecto que el Dev ya había encontrado en una cita del AR.

> **Por qué el aviso se mide en runtime en vez de afirmarse:** el navegador de Phantom es **otra
> partición de almacenamiento**. No es «volver al mismo origen»: es *el mismo origen en otro
> navegador*. Y esta pregunta es **NUEVA**, distinta de las cuatro que `solana-wallet.ts:894` declara
> sin verificar (aquéllas son sobre el salto por **enlace**, que sale y **vuelve al mismo
> navegador**; ésta es sobre `browse`, que **no vuelve: aterriza en otro**). Confundirlas sería
> heredar una respuesta que no aplica.
>
> ⇒ El código **no afirma** si el borrador sobrevive: **lo pregunta cuando aterriza**, y hay **TRES
> desenlaces observables, no dos**:
> 1. marca + **sin** borrador ⇒ el aviso aparece.
> 2. marca + **con** borrador ⇒ **no** aparece (no hubo nada que contar).
> 3. **sin** marca ⇒ **no** aparece (un visitante nuevo dentro de Phantom no puede leer un aviso
>    sobre datos que nunca cargó).
>
> **El aviso ES el instrumento de campo**: si aparece, el almacenamiento no cruzó; si no aparece y el
> borrador está, cruzó. El founder no necesita `?diag=1` para leer el resultado.

#### I-3 · `flow.tsx:963` — el paso `connect`

Se agrega la prop `hayBorrador={rem !== null}` a
`<NoWalletHere direccionConectada={address} vueltaSinResolver={vueltaSinResolver} />`,
**en esa misma línea** (hoy 2824 caracteres). El precedente literal está en el comentario de esa
misma línea.

#### I-3b · `flow.tsx:1349` — la firma de `NoWalletHere` ⚠️ **no te lo saltees**

La prop nueva obliga a extender la firma, que hoy es
`function NoWalletHere({ direccionConectada, vueltaSinResolver }: { direccionConectada: string | null; vueltaSinResolver: boolean })`.
Pasa a llevar también `hayBorrador: boolean`, **en esa misma línea física** (Δ0).
*Este punto es mecánicamente obligatorio y es fácil de olvidar leyendo sólo la lista de cinco
inserciones: sin él, `tsc` se pone rojo en el paso 2 del gate.*

#### I-4 · `flow.tsx:1379` — el `href`

`href={phantomBrowseUrl(href, origin)}` pasa a
`href={urlDeSalidaAlNavegadorDeLaBilletera({ href, origin, hayBorrador })}`.
Es un reemplazo de expresión en una línea que ya existe (hoy 46 caracteres).
⚠️ `href` y `origin` siguen saliendo de `:1354-1355`, **sin cambio**.

#### I-5 · `flow.tsx:1386` — la nota al pie de `NoWalletHere`

Se reescribe el texto de esa línea para que diga **las dos cosas nuevas**: el enlace a instalar y la
advertencia honesta sobre los datos.
⚠️ **La nota de la computadora NO se borra**: sigue siendo el único texto correcto para el escritorio
sin extensión. *(El predicado `availability === "none"` no distingue un celular sin Phantom de una
computadora sin extensión, y ⛔ no se mira el user agent para separarlos: CD-W1-11.)*

#### El copy — textual, ya redactado

**La oferta en `bienvenida`:**

> **¿Estás en un celular con Phantom?**
> Abrí Chaski adentro de Phantom y no vas a tener que saltar a otra app en cada firma.
> `[ Abrir Chaski en Phantom ]`
> No tengo Phantom · Instalarla y crear mi billetera
> Si estás en una computadora, instalá la extensión de Phantom o Solflare y recargá la página.

- **Por qué el título es una pregunta y no una afirmación:** el detector no puede decir si la persona
  está en un celular. Preguntar es lo único honesto. Misma disciplina que `NoWalletHere` ya aplica con
  *«Esto no dice si tenés una wallet instalada»* (`flow.tsx:1368-1369`).
- **Por qué «no vas a tener que saltar a otra app en cada firma» y no «cero saltos»:** lo primero es
  verificable (dentro del navegador de la billetera `caminoPorEnlace()` es `null` y `pedir()` contesta
  `no-corresponde`); lo segundo omitiría el redirect del verificador de identidad (§2.1).
- **Por qué DOS enlaces y no uno:** circula que un universal link cae solo en la página de descarga
  cuando la app no está instalada. **Eso no está verificado para `browse`: la doc de Phantom no lo
  dice.** Con dos enlaces, el recorrido de instalación **no depende de esa incógnita**.

**El aviso de aterrizaje:**

> **Acá no están los datos que cargaste antes**
> Cargá el monto y los datos de tu familiar otra vez. Es una sola pantalla.

- **No explica la causa.** *«El navegador de Phantom guarda todo aparte»* sería una afirmación causal
  que nadie midió. Lo que sí está medido en ese instante es que el borrador no está acá, y eso es lo
  único que la frase dice.
- **No dice «empezá de nuevo» ni «se perdió»**: es el pecado que `flow.tsx:757` persigue por escrito.

**La advertencia de salida en `connect` (`:1386`):**

> Si al llegar no ves lo que cargaste, cargalo otra vez.

- **Es condicional a propósito**, y es la única forma honesta: nadie midió todavía si el borrador
  cruza. **La frase es verdadera en los dos mundos y no promete ninguno** (CD-W1-10).

**Tests que entran acá:** `T-372-W1-1`, `T-372-W1-2`, `T-372-W1-6`, `T-372-W1-7` (§7), como
**apéndice al final** de `wallet-availability.test.tsx`. ⛔ **No se reordena nada de ese archivo.**
**AC que cierra:** AC-1-1, AC-1-4, AC-1-4b.
**Sale con:** `wc -l src/presentation/flow.tsx` = **4453** (el mismo número de antes), `npm run qa`
verde, y los 4 mutantes nombrados.

**Tareas:**
- [ ] **T16** — I-1: los imports en `:77`, antes del `//`.
- [ ] **T17** — I-2(a): la oferta en `:757`, con las 6 condiciones.
- [ ] **T18** — I-2(b): el aviso de aterrizaje en `:757`, con los 3 desenlaces.
- [ ] **T19** — I-3: la prop en `:963`.
- [ ] **T20** — I-3b: la firma de `NoWalletHere` en `:1349`.
- [ ] **T21** — I-4: el `href` en `:1379`.
- [ ] **T22** — I-5: la nota al pie en `:1386`, **sin borrar** la parte de la computadora.
- [ ] **T23** — `wc -l src/presentation/flow.tsx` ⇒ **tiene que dar 4453**. Si da otro número,
      **arreglalo antes de seguir**. ⛔ Se verifica con `wc -l`, no leyendo el diff.
- [ ] **T24** — Apendear `T-372-W1-1`, `T-372-W1-2`, `T-372-W1-6`, `T-372-W1-7` al **final** del
      archivo E.
- [ ] **T25** — Correr el gate completo (§8).
- [ ] **T26** — Matar los 4 mutantes, con su `×` nombrado y **por separado**.

---

### W1.3 · El renglón de diagnóstico · **paralelizable con W1.2** · entra entero o no entra

**Archivos: F** (`bitacora-de-vuelta.ts`) **y G** (`diagnostico-de-vuelta.tsx`, **Δ0**).

`HitoDeVuelta` (`bitacora-de-vuelta.ts:96`) suma un **quinto** valor: `"salida-al-navegador"`, con los
tres desenlaces de I-2(b) como valores posibles:
`con-marca-y-borrador` / `con-marca-sin-borrador` / `sin-marca`.

> ⚠️ **La regla del propio archivo, textual (`:95`):** *«Los cuatro, cerrados. Un quinto obliga a
> decidir qué pregunta contesta y a darle renglón.»*
> ⇒ **El renglón en `diagnostico-de-vuelta.tsx` no es opcional: es el precio de agregar el hito.**
> ⛔ **Recortar W1.3 entera es válido. Recortarla a medias (el hito sin su renglón) NO lo es.**

⛔ Lo que **no** entra ahí: ninguna dirección, ninguna clave, ninguna URL. Los tres valores son
etiquetas que escribe este repo, igual que los cuatro que ya están. Y el módulo se mantiene como
está: **sin `fetch`, sin `localStorage`, sin `console`**.

El renglón nuevo en `diagnostico-de-vuelta.tsx` entra en una **línea física existente** del bloque
(Δ0), siguiendo el patrón de `renglonDeLaRemesa` (`:396`), `renglonDelPop` (`:411`) y
`renglonDelPaso` (`:425`).

**AC que cierra:** ninguno por sí solo. Es el instrumento de campo de AC-1-4b.

**Tareas:**
- [ ] **T27** — Agregar `"salida-al-navegador"` al union de `HitoDeVuelta` (`:96`, **en esa misma
      línea**) y la función/constante nueva **al final** del archivo F.
- [ ] **T28** — Agregar el renglón correspondiente en el archivo G, **en una línea física existente**
      (Δ0).
- [ ] **T29** — `wc -l src/presentation/diagnostico-de-vuelta.tsx` ⇒ tiene que seguir dando **593**.
- [ ] **T30** — Correr el gate completo (§8).

---

### W1.4 · Cierre

**Archivos: H** (`README.md:436`) **e I** (`README.es.md:462`).

**Tareas:**
- [ ] **T31** — Correr `npx vitest run src/composition/readme-test-count.test.ts` **usando el binario
      local** (⛔ ver §8: nada de `npx` que baje paquetes; usá
      `./node_modules/.bin/vitest run src/composition/readme-test-count.test.ts`) y **leer del rojo**
      el número nuevo de archivos de test. ⛔ **No lo cuentes a mano** (CD-W1-7).
      *(Referencia: hoy son **165**; W1 agrega 2 archivos de test nuevos (B y C), así que el número
      esperado es 167 — pero **el que vale es el que devuelve el candado corriendo**, no éste.)*
- [ ] **T32** — Actualizar `README.md:436` con ese número.
- [ ] **T33** — Actualizar `README.es.md:462` con ese número, **por separado**. El candado los mide
      por separado a propósito.
- [ ] **T34** — Re-derivar los marcadores `[[CENSO …]]` **después del último commit de código**
      (CD-W1-8): `[[CENSO src/presentation/flow.tsx entrantes=155]]` y `destinos=92` en `flow.tsx:44`
      cambian si W1 agregó citas ancladas a `flow.tsx`.
      ⛔ `[[CENSO … lineas=4453]]` **no debe cambiar**: si cambió, se rompió Δ0.
      ⛔ El marcador de `solana-wallet.ts:893` **no se toca**: ese archivo no se editó (CD-W1-2).
- [ ] **T35** — Re-derivar **todas** las citas `archivo:línea` nuevas que hayas escrito en código,
      comentarios o docblocks, con `sed -n 'Np'`, **después de la última edición** (CD-W1-3).
- [ ] **T36** — `git add -A` y correr **el gate completo, entero y en orden** (§8), incluido
      `npm run build`.
- [ ] **T37** — Verificar el Scope OUT con el diff:
      `/usr/bin/git diff --stat main...HEAD` ⇒ **0 archivos** de `solana-wallet.ts`,
      `solana-escrow-rent.ts`, `deeplink/**`, `nonce-duradero.ts`, `preparacion-por-enlace.ts`,
      `flow-vm.ts`, `splash-puerta.ts`, `app/**`.
- [ ] **T38** — Verificar el presupuesto de diff (§9).

---

## 7 · Plan de tests — un test por AC, con su mutante y su falso KILLED

> ⛔ **Regla transversal (CD-W1-5):** cada `it` de esta tabla **se rompe a propósito** y el rojo se
> cita con **archivo · nombre del `it` · por qué murió**. Un `exit=1` sin un `×` nombrado no es un
> KILLED.
> ⛔ **Regla transversal (CD-W1-4):** ninguno puede leerse a sí mismo.

| Test | AC | Archivo | Qué afirma | **Mutante que lo tiene que matar** | **Falso KILLED a evitar** |
|---|---|---|---|---|---|
| `T-372-W1-1` | AC-1-1 | **E** | En `bienvenida` con `"none"` aparece un **`<a>`** cuyo `href` empieza con el prefijo del universal link, y **no se asigna `window.location.href` en el montaje** | Cambiar el `<a href>` por un `<button onClick>` ⇒ `getByRole("link")` no encuentra nada | Un mutante que rompa el render entero mata cualquier `it`. Se exige que el **control negativo** (`"injected"` ⇒ sin enlace) siga verde |
| `T-372-W1-2` | AC-1-1 | **E** | **Control negativo:** con `"injected"` el paso `bienvenida` es **byte-idéntico** al de hoy (`innerHTML`) | Quitar la condición `disponibilidadWallet === "none"` | Comparar sólo un texto en vez del `innerHTML` deja pasar cambios de estructura. Patrón obligatorio: `T-065-21` (por nombre; al `b402ab7` en `wallet-availability.test.tsx:1037`) |
| `T-372-W1-3` | AC-1-2a | **C** | `pedir()` nunca devuelve `hay-que-salir` y no se asigna `location.href` a un host de billetera en todo el recorrido | Forzar `caminoPorEnlace()` a devolver `"phantom"` con `"injected"` | Si el fixture no llega al final del recorrido, el `it` da verde **por no haber ejercitado nada**. Se exige assertar el **estado terminal** |
| `T-372-W1-4` | AC-1-3 | **C** | Con `"injected"` **no** se construye la ix de creación de la cuenta de nonce | Invertir `!== "none"` a `=== "none"` en `caminoPorEnlace` (`solana-wallet.ts:2240`) | Un mutante en `firmaPorEnlace` mata el mismo `it` **sin probar el gate de disponibilidad**. Los dos mutantes se corren **por separado** |
| `T-372-W1-5` | AC-1-3 | **C** | El umbral que aplica es el **inyectado, por VALOR**: un saldo `= SENDER_MIN_LAMPORTS_FOR_DEPOSIT` pasa; uno de `−1` corta | Cambiar el guard de `confirm-and-send.ts:428` al otro símbolo | ⛔ El `it` **importa las dos constantes** y compara; **no re-escribe ningún literal** (CD-W1-4) |
| `T-372-W1-6` | AC-1-4 | **E** | El bloque ofrece un segundo enlace cuyo `href` **es** `URL_INSTALAR_PHANTOM` (importada), y `new URL(URL_INSTALAR_PHANTOM).hostname` es el de la billetera | Borrar el segundo enlace | ⛔ **Prohibido** `toContain("https://phantom.com/download")` escrito en el `it`: sería el guard leyéndose a sí mismo |
| `T-372-W1-7` | AC-1-4b | **E** | **Los tres desenlaces del aterrizaje**: (a) marca + sin borrador ⇒ el aviso aparece; (b) marca + borrador ⇒ **no** aparece; (c) sin marca ⇒ **no** aparece | Invertir la condición ⇒ **(c) se pone rojo**, que es el control que impide el aviso falso al visitante nuevo | **Sin el caso (c)**, un mutante que ponga la condición en `true` **sobrevive** |
| `T-372-W1-8` | AC-1-4b | **B** | `urlDeSalidaAlNavegadorDeLaBilletera` **borra** `dl`, los params de respuesta **y** `kyc`, y agrega la marca **sólo** con `hayBorrador` | Quitar el borrado de `kyc` | El `it` construye el href de entrada y **parsea** el de salida; **no compara strings completos escritos a mano** |
| `T-372-W1-9` | AC-1-4b | **B** | `vinoDeUnaSalidaConBorrador` es **opt-in estricto**: `"1"` prende; ausente, vacío, `"true"`, `"1 "` y un href impareseable **no** | Cambiar la comparación por `params.has(...)` | Patrón obligatorio: `T-065-20` (por nombre; al `b402ab7` en `wallet-availability.test.tsx:1021`), que ya hace exactamente esto para una env |
| `T-372-W1-10` | AC-1-4b | **B** | La URL final es **byte-idéntica** a la que produce `phantomBrowseUrl` sobre el href limpio | Reescribir el prefijo a mano en el módulo nuevo | El `it` **importa** `phantomBrowseUrl` y compara contra su salida; **no escribe el prefijo** |
| `T-372-W1-11` | AC-1-5 | **C** | El camino de respaldo sigue entero: existen los 7 módulos de `deeplink/**` y `nonce-duradero.ts`, y el selector de enlace sigue apareciendo con la bandera prendida y `"none"` | Renombrar `nonce-duradero.ts` en un worktree | Un `it` que sólo mire el diff **no es un guard**: éste **lee el árbol** |
| `T-372-W1-12` | AC-1-6 | **C** | El doble de `prepare` se invoca **exactamente 1 vez** en un envío que cierra, con `"injected"` | Hacer que `pedir()` devuelva `hay-que-salir` ⇒ 3 invocaciones | `toHaveBeenCalled()` **no sirve**: tiene que ser `toHaveBeenCalledTimes(1)` |
| `T-372-W1-13` | AC-1-2b | **C** | **Las travesías de la pantalla de entrada, en los dos recorridos**: (a) **recurrente** (KYC aprobado sembrado) ⇒ el atajo saltea `review` y `verify` ⇒ **exactamente 1 travesía** y **0 viajes a la billetera**; (b) **primera vez** ⇒ la única asignación de `window.location.href` es la del **verificador** (`flow.tsx:460`), y sigue siendo **0 viajes a la billetera** | Borrar el atajo de KYC aprobado del bloque de `flow.tsx:356-360` (`rememberedKyc.approved && rememberedKyc.realVerified`) ⇒ el caso (a) vuelve a pasar por `review`/`verify` ⇒ **2 travesías** ⇒ rojo | **Dos, y los dos son fáciles de cometer:** (1) si el fixture del caso (a) **no siembra el KYC aprobado**, nunca ejercita el atajo y **da verde por vacío**; (2) el caso (b) tiene que assertar que ese `location.href` apunta al **host del verificador y NO al de una billetera**, si no pasa por no contar nada |
| — | CD-W1-1 | *(ya existe)* | Δ0 de `flow.tsx` | — | ⛔ **NO se escribe un guard nuevo.** Ya lo hace `src/composition/citas-ancladas.test.ts:331` con `[[CENSO … lineas=4453]]`. Duplicarlo son dos números que se corrigen por separado |

⚠️ **Y una cosa que estos tests NO prueban, dicha antes de que alguien lea su verde de más:**
**ninguno corre en un teléfono.** Prueban el **árbol**, con la librería real y `jsdom`. Que el
almacenamiento cruce o no cruce el salto lo contesta **el aviso de aterrizaje en el teléfono del
founder**, y hasta entonces sigue sin verificar.

---

## 8 · El gate del repo — completo y en orden

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
/usr/bin/git add -A          #  ⚠️ IMPRESCINDIBLE: el gate se mide contra el ÍNDICE de git
npm run qa                   #  = lint → typecheck → typecheck:scripts → test  (package.json:20)
npm run build                #  = next build --webpack                        (package.json:10)
```

⚠️ **Se mide contra el índice de git: `git add -A` ANTES.** Correrlo antes del `git add` es correrlo
sobre un árbol donde el entregable **no existe**, y da verde.

⛔ **PROHIBIDO `npx biome` y `npx tsc` sueltos.** `npx` intenta bajar paquetes inexistentes y devuelve
un error que **se lee como fallo del gate**. Medido hoy:
`npm error npx canceled due to missing packages: ["lint@1.2.2"]`.
⇒ Usá los binarios de `node_modules` (`./node_modules/.bin/vitest`, `./node_modules/.bin/biome`,
`./node_modules/.bin/tsc`) o los scripts de `package.json`.

⛔ **Correr las partes de un gate no es correr el gate.** `lint` va **primero** y es el eslabón que
nadie alcanza: en este ecosistema un `import` sin usar sobrevivió 5 revisiones porque todos corrían
`vitest` y `tsc` y nadie llegaba a lint.

⚠️ **Flake preexistente, 7-13 %:** `src/presentation/vuelta-por-enlace-carrera.test.tsx`, `PUERTA 1`
(`:259`) y `PUERTA 2` (`:279`). **No es de esta HU. NO se pone en cuarentena.** Si sale rojo **ahí y
sólo ahí**, se re-corre **ese archivo** y se dice **explícitamente en el reporte**, con la frecuencia
medida y un denominador que no sea chico (CD-W1-9).

---

## 9 · Escala esperada del diff — el presupuesto que el CR contrasta

| Archivo | Añadidas | Borradas | Δ neto |
|---|---:|---:|---:|
| `salida-al-navegador-de-la-billetera.ts` (nuevo) | 130 ± 40 | 0 | +130 |
| `salida-al-navegador-de-la-billetera.test.ts` (nuevo) | 130 ± 40 | 0 | +130 |
| `recorrido-en-el-navegador-de-la-billetera.test.tsx` (nuevo) | 320 ± 100 | 0 | +320 |
| `wallet-availability.test.tsx` | 90 ± 30 | 0 | +90 |
| `flow.tsx` | 6 | 6 | **0** (6 líneas físicas reescritas, ≈ +3.500 caracteres) |
| `bitacora-de-vuelta.ts` | 9 | 1 | +8 |
| `diagnostico-de-vuelta.tsx` | 2 | 2 | **0** |
| `README.md` + `README.es.md` | 2 | 2 | 0 |
| **TOTAL** | **~690** | **~11** | **~+680** |

**Presupuesto declarado: ≤ 900 líneas añadidas y ≤ 10 archivos.**
**Umbral del check 7 del CR: si el diff supera 1.800 líneas añadidas o 20 archivos, se justifica por
escrito o se recorta.**

**La pregunta que decide un exceso:** *¿qué parte de esto seguiría existiendo si lo escribiera alguien
que ya conoce el deeplink `browse` de Phantom?* Respuesta: el módulo puro (~40 líneas de código real)
y las seis inserciones. Todo lo demás son tests y el razonamiento que este repo exige en sus
docblocks.

⚠️ **Un exceso en `flow.tsx` en LÍNEAS es imposible por CD-W1-1; un exceso en CARACTERES ahí sí es
posible y es lo que hay que mirar.**

⚠️ **Ratio esperada test/producción ≈ 3,5:1.** Es alta a propósito: el 70 % de esta ola es demostrar
que un recorrido que nadie corrió entero hace lo que decimos. **Si el CR mide una ratio más baja, la
sospecha correcta es que faltan tests, no que sobra código.**

---

## 10 · Riesgos que te tienen que preocupar mientras codeás

| # | Riesgo | Qué lo mitiga |
|---|---|---|
| R-1 | Editás `solana-wallet.ts` «de paso» | CD-W1-2 + el marcador de censo, que **se pone rojo solo**. Ese rojo **es la señal, no el ruido** |
| R-2 | Una línea de más en `flow.tsx` | 155 citas ancladas corridas, **la mayoría en silencio**. CD-W1-1 + `wc -l` + `citas-ancladas.test.ts` |
| R-3 | El salto se dispara desde un efecto | El navegador lo descarta **sin error y sin rastro**; la persona se queda mirando la pantalla. `T-372-W1-1` + el precedente medido de `flow.tsx:286` |
| R-4 | La persona salta desde `connect` y pierde los datos **sin aviso** | Abandona, y el equipo lo lee como «no le interesó». El aviso condicional de I-5 al salir + la medición de I-2(b) al aterrizar |
| R-5 | El `?kyc=return` viaja al otro navegador | Un resume de un KYC que en ese almacenamiento no existe. La limpieza del módulo A + `T-372-W1-8` |
| R-6 | El aviso de aterrizaje se le muestra a un visitante nuevo | La app le habla de datos que nunca cargó. El **caso (c)** de `T-372-W1-7` |
| R-7 | El flake de `vuelta-por-enlace-carrera.test.tsx` se lee como regresión de W1 | Se investiga el archivo equivocado, o peor, se pone en cuarentena. CD-W1-9 |
| R-8 | Salto de layout de ~650 ms en la entrada | **Conocido y aceptado**: la disponibilidad se decide a los 1852 ms (`flow.tsx:1351`) y el splash cubre 1200 (`splash.tsx:60`). ⛔ **No se «arregla» afirmando antes de saber** |

---

## 11 · Lo que W1 NO entrega, y decirlo es parte del entregable

- ⛔ **El remitente sigue necesitando SOL.** Llevar ese número a cero es la **HU `071` de
  `chaski-v3`** (`doc/sdd/071-facilitator-adelanta-el-alquiler/`), que es otra HU, de otro repo, con
  su propio expediente. **Ningún copy, comentario o reporte de esta ola puede decir *«el remitente no
  necesita SOL»*** (CD-12).
- Lo único que W1 baja por sí sola es el recargo de la cuenta de nonce, y **lo baja por
  inalcanzabilidad, sin escribir una línea para eliminarlo**.
- ⛔ W1 **no** cierra las cuatro cosas que `solana-wallet.ts:894` declara sin verificar (CD-11).
- ⛔ W1 **no** contesta si el `localStorage` cruza al navegador de la billetera: **lo mide en el
  campo** con el aviso de aterrizaje.
- ⛔ W1 **no** contesta qué hace el universal link `browse` si Phantom no está instalada: **por eso
  hay un segundo enlace explícito** y el diseño no se apoya en esa incógnita.
- ⛔ W1 es **cliente-only y aditiva**: no cambia ningún contrato de servidor ⇒ **no tiene orden entre
  repos**, y **el repliegue es un revert**. No hay flag nuevo y no se agrega ninguna `NEXT_PUBLIC_*`.

---

## 12 · Done Definition — W1 está terminada cuando

- [ ] **D1** — Las **38 tareas** de §6 están marcadas.
- [ ] **D2** — Los **5 puntos de la premisa de W1.0 salieron verdes** sobre el árbol de hoy, **antes**
      de escribir una línea de producción. *(Si alguno salió rojo: la ola está DETENIDA y reportada,
      no terminada.)*
- [ ] **D3** — Los **13 tests** de §7 existen, corren, y **cada uno tiene su mutante muerto con un `×`
      nombrado** (archivo · nombre del `it` · por qué murió). Ningún falso KILLED.
- [ ] **D4** — `wc -l src/presentation/flow.tsx` da **4453**. Verificado con `wc -l`, no leyendo el
      diff.
- [ ] **D5** — `/usr/bin/git diff --stat main...HEAD` muestra **0 líneas** de
      `src/infrastructure/solana-wallet.ts`.
- [ ] **D6** — El diff toca **como máximo los 9 archivos** de §3.1 y **ninguno** de §3.2.
- [ ] **D7** — El gate completo corrió **entero y en orden** después de `git add -A`:
      `npm run qa` (lint → typecheck → typecheck:scripts → test) y después `npm run build`, los dos
      verdes, con la salida citada.
- [ ] **D8** — Los dos README declaran el conteo nuevo, **derivado corriendo el candado**, y cada uno
      por separado.
- [ ] **D9** — Los marcadores `[[CENSO …]]` de `flow.tsx:44` re-derivados **después del último commit
      de código**, y `lineas=4453` **sin cambiar**.
- [ ] **D10** — **Todas** las citas `archivo:línea` nuevas re-derivadas con `sed -n 'Np'` después de
      la última edición.
- [ ] **D11** — Ninguna frase nueva de copy o docblock sin su **input concreto que la pondría en
      rojo** (CD-W1-10).
- [ ] **D12** — Ningún guard que se lea a sí mismo (CD-W1-4).
- [ ] **D13** — Si `vuelta-por-enlace-carrera.test.tsx` salió rojo, está **declarado en el reporte con
      su frecuencia medida** y **no** está en cuarentena.
- [ ] **D14** — El diff está dentro del presupuesto de §9, o el exceso está **justificado por
      escrito**.
- [ ] **D15** — La palabra *«el remitente no necesita SOL»* **no aparece** en ningún archivo del diff.

---

*Story File · F2.5 · ola **W1** de WKH-372 · 2026-08-31 · NexusAgil Architect ·
sobre `chaski-v3@cc02b61`, con `SPEC_APPROVED` otorgado y `D-W1-1` resuelta (§2.1)*

---

## ⚠️ Nota del orquestador · 2026-08-31 · por qué las citas a los tests van POR NOMBRE

`CR/verificación de cierre · BLQ-BAJO-1` encontró que la cita del guard `T-372-W1-7c` en `:517`
**se rompió por segunda vez**. La primera la arreglé en el fix-pack 2 (`:1476` → `:1573`, con la
re-derivación escrita); el fix-pack 3 insertó un hunk en `@@ -1323,15 +1323,36 @@` y **corrió todo
lo que estaba debajo**, así que `:1573` pasó a apuntar al argumento de un mensaje de assert.

**La causa raíz, y no la caza nada**: `citas-ancladas.test.ts` vigila las citas **dentro de
`chaski-v3`**. Estos documentos viven en `wasiai-a2a`, así que **ninguna herramienta mira las citas
cruzadas entre los dos repos**. Es el mismo patrón que `OBS-1` encontró en otras cuatro citas de
estos mismos artefactos (`T-H1-3` y `T-065-21`, corridas +19 por los commits originales de W1).

**La regla que queda**: en estos documentos, un test se cita **por el nombre de su `it`**, con el
número de línea como dato secundario y anclado a un commit. El nombre sobrevive a los fix-packs; el
número no. Las seis citas de este documento y del SDD quedaron reescritas así el 2026-08-31,
re-derivadas con `grep -n 'it("<nombre>'` sobre `chaski-v3@b402ab7`.

⇒ **Candidato a HU propia**: un guard de citas cross-repo. No entra en W1.
