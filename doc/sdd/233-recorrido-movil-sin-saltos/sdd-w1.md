# SDD · [WKH-372] · **OLA W1** — El navegador de la billetera como camino principal

> **Alcance de este documento: W1 y nada más** (DT-8 del work-item: un SDD por ola).
> ⛔ Acá **no** se diseña W3, ni W4, ni W0. La `W2` no existe y **no se renumera** (DT-9).
> **Repo donde vive el trabajo:** `chaski-v3`, y **sólo el cliente**.
> **Repo ancla de los artefactos:** `wasiai-a2a` (`doc/sdd/233-recorrido-movil-sin-saltos/`).
> **De `wasiai-a2a` no se toca una sola línea de `src/`.**

**Fecha:** 2026-08-31 · **Modo:** QUALITY / SDD_MODE full · **Estado:** listo para `SPEC_APPROVED`
con **1 desviación declarada** que necesita el ok del humano (§11, `D-W1-1`).

---

## 0 · CÓMO LEER LAS CITAS DE ESTE DOCUMENTO

Este F2 corrió **con shell** (`sed`, `/usr/bin/grep`, `curl`, `/usr/bin/git`), sobre el árbol de
`chaski-v3` en `main`, punta `cc02b61`, limpio (`git status --porcelain` vacío).

| Marca | Qué significa |
|---|---|
| `[MEDIDO-F2]` | Abrí el archivo y leí esa línea **en esta sesión**, sobre `cc02b61`. |
| `[MEDIDO-RED]` | Salió de una petición HTTP que **corrí acá**, con su hora. |
| `[HEREDADO]` | Sale del work-item, del mapa de terreno o del estado del arte. **No lo re-medí.** |
| `[NO VERIFICADO]` | Nadie lo midió. Va como riesgo, nunca como premisa. |

⚠️ **Este SDD sí se re-ancla.** A diferencia del work-item (CD-9, registro histórico), esto es un
**plan de trabajo**: alguien va a abrir estos archivos por número para editarlos. Si algo mergea
antes que W1 sobre `chaski-v3`, **las citas de §4 se re-derivan antes de escribir código**.

---

## 1 · Resumen

Hoy, en el navegador común de un celular, mandar una remesa cuesta **6 saltos a la app de la
billetera** y atravesar la pantalla de entrada **7 veces**, porque cada firma es una navegación
fuera del sitio y la vuelta **remonta el árbol de React** `[HEREDADO: mapa §3, §6]`.

W1 hace que el camino principal en celular sea el **navegador interno de la billetera**, donde el
provider está **inyectado**. Y el hallazgo que define el tamaño de esta ola es éste:

> 🔴 **El recorrido dentro del navegador de la billetera YA CUMPLE casi todo lo que W1 promete, y lo
> cumple sin escribir una línea de producción.** Lo que falta no es el recorrido: es **la puerta de
> entrada a ese recorrido, la honestidad sobre lo que se pierde al cruzarla, y el instrumento que lo
> demuestre corriendo.**

Medido, en tres citas que se encadenan:

1. `caminoPorEnlace()` devuelve `null` en cuanto la disponibilidad **no** es `"none"` —
   `src/infrastructure/solana-wallet.ts:2240` `[MEDIDO-F2]`, primera sentencia de la línea:
   `if (solanaWalletBridge.getWalletAvailability() !== "none") return null;`
2. Dentro del navegador de Phantom la disponibilidad es `"injected"`, y **eso está medido con la
   librería real y el mismo user agent de celular que el caso `"none"`**: `T-CABLE-2`,
   `src/presentation/wallet-availability.test.tsx:146-152` `[MEDIDO-F2]`.
3. Los **dos** bloques del camino por enlace de `authorizePrincipal` están gateados por
   `if (this.firmaPorEnlace && this.caminoPorEnlace() !== null)` — `solana-wallet.ts:769` (el que
   crea la cuenta de nonce y aplica el umbral del enlace en `:806`) y `solana-wallet.ts:897` (el que
   saca la firma por enlace) `[MEDIDO-F2]`.

⇒ **Dentro del navegador de la billetera, la cuenta de nonce ya es inalcanzable, el umbral que
aplica ya es el inyectado, y `prepare()` ya corre una sola vez.** W1 no tiene que provocar eso: tiene
que **ofrecer la entrada, decir la verdad sobre el borde, y demostrarlo con tests que se rompan a
propósito**.

### 1.1 · 🔴 La corrección más cara de este F2, y hay que decirla primero

**El work-item §0.2 afirma que «W1 edita `chaski-v3/src/infrastructure/solana-wallet.ts` alrededor de
`:897`» y de ahí deriva que las 76 citas ancladas por debajo de `solana-wallet.ts:893` se
re-derivan, obligando a la HU `071` a re-anclar sus ítems 3.4 y 3.12.**

**Medido: W1 no necesita editar ese archivo, y este SDD lo prohíbe** (CD-W1-2).

- El efecto que W1 quiere sobre esa rama es **que no se ejecute**, y ya no se ejecuta cuando la
  disponibilidad es `"injected"` (cita 1 de arriba, `solana-wallet.ts:2240`).
- El marcador del censo, textual, en `solana-wallet.ts:893` `[MEDIDO-F2]`:
  `[[CENSO src/infrastructure/solana-wallet.ts entrantes-desde-893=76]]`.
- Ese marcador **no es prosa**: lo verifica `src/composition/citas-ancladas.test.ts` en cada
  `npm test` (`CENSO`, `:331`; `it` de desajustes, `:402-403`) `[MEDIDO-F2]`.

⇒ **Consecuencia de despliegue, declarada como pide el encargo, pero con el signo corregido:**

| Afirmación | Veredicto de este F2 |
|---|---|
| W1 rota las 76 citas ancladas por debajo de `solana-wallet.ts:893` | ❌ **No, si CD-W1-2 se respeta.** W1 toca **0 líneas** de ese archivo |
| La HU `071` tiene que re-derivar sus ítems 3.4 y 3.12 **por culpa de W1** | ❌ **No por W1.** Sigue teniendo que hacerlo por cualquier otra cosa que mergee antes, pero **no por esta ola** |
| Si alguien igual edita `solana-wallet.ts` en W1 | 🔴 **BLOQUEANTE en AR.** Rota 76 citas + el marcador de censo se pone rojo solo. Ese rojo **es la señal, no el ruido** |

⚠️ **Y el riesgo simétrico, que sí queda vivo:** `flow.tsx` recibe
`[[CENSO src/presentation/flow.tsx entrantes=155]]` citas ancladas a
`[[CENSO src/presentation/flow.tsx destinos=92]]` líneas destino, **todas por debajo de `:44`**
(`flow.tsx:44`, `[MEDIDO-F2]`), y mide `[[CENSO src/presentation/flow.tsx lineas=4453]]` líneas
(verificado: `wc -l` da `4453`, `[MEDIDO-F2]`). **W1 sí toca `flow.tsx`, y por eso Δ0 es CD-W1-1.**

---

## 2 · Context Map (Codebase Grounding)

### 2.1 · Archivos que leí, y qué saqué de cada uno

| Archivo | Por qué lo abrí | Qué patrón / hecho extraje |
|---|---|---|
| `chaski-v3/src/presentation/wallet-availability.ts` (158 líneas) | El encargo dice que el repo **ya renderiza** un `phantomBrowseUrl` | `phantomBrowseUrl(href, origin)` vive en `:26-28` y devuelve `` `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(origin)}` ``. Su docblock (`:13-25`) declara que el esquema **no está inventado**: es el mismo que dispara `@solana/wallet-adapter-phantom` en `Loadable`. Acá viven también `useWalletAvailability()` (`:36`), `mwaEnabled()` (`:98`), `useMwaOffered()` (`:114`) y `deeplinkEnabled()` (`:156`) |
| `chaski-v3/src/presentation/flow.tsx` (4453 líneas) | Es donde vive la máquina de pantallas y el único consumidor de `phantomBrowseUrl` | `:44` es el marcador de censo y el que justifica Δ0 · `:77` la línea de imports · `:147` los derivados de disponibilidad · `:757` el bloque de avisos pre-cuerpo · `:963` el paso `connect` · `:1349-1390` `NoWalletHere` · `:1379` el `<a href={phantomBrowseUrl(href, origin)}>` |
| `chaski-v3/src/infrastructure/solana-wallet.ts` (2498 líneas) | Confirmar dónde muere el camino por enlace | `caminoPorEnlace()` en `:2239-2254`, con el corte por disponibilidad en `:2240` · los dos bloques gateados en `:769` y `:897` · el umbral del enlace aplicado en `:806` · `pedir()` devuelve `{estado:"no-corresponde"}` en `:2383` cuando `caminoPorEnlace() === null` |
| `chaski-v3/src/infrastructure/solana-wallet-bridge.ts` | Saber qué contesta el detector y qué **no** puede contestar | `SolanaWalletAvailability = "unknown" \| "injected" \| "none"` (`:27`), con el docblock (`:12-26`) que dice textual que `"none"` **no** significa «la persona no tiene wallet instalada»: en el celular Phantom está instalada y no se inyecta salvo dentro de su propio navegador |
| `chaski-v3/src/application/use-cases/confirm-and-send.ts` | Contar `prepare()` por envío (AC-1-6) | El guard de saldo del camino común compara contra `SENDER_MIN_LAMPORTS_FOR_DEPOSIT` (`:428`) · el bloque `:436-462` declara los tres `prepare()` del camino por enlace y por qué **no** se puede saltear al reanudar (DT-4(b)) · `pop.pedir()` se llama en `:463` y sus tres desenlaces se resuelven en esa misma línea |
| `chaski-v3/src/application/solana-escrow-rent.ts` | Los dos umbrales, **sin tocarlos** (CD-12) | `SENDER_MIN_LAMPORTS_FOR_DEPOSIT` en `:187` · `SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT` en `:352-356`, que **no es un literal**: se deriva sumando `NONCE_ACCOUNT_RENT_LAMPORTS` (`:332`) + 5.000 + 75.000 |
| `chaski-v3/src/presentation/splash-puerta.ts` | ¿Un parámetro nuevo en la URL rompe el splash? | `motivoParaNoMostrar` (`:84-108`) mira **sólo** `PARAM_KYC === "return"` y `params.has(MARCA)`. Un parámetro nuevo **no** cambia su veredicto. Y falla cerrado por diseño (`:78-83`) |
| `chaski-v3/src/infrastructure/solana/deeplink/conexion.ts` | Cómo limpia el repo una URL de rastros | `hrefSinRastroDeVuelta` (`:362-373`): borra `PARAMS_DE_RESPUESTA` y `MARCA`, y devuelve `origin+pathname+hash` si no queda ningún parámetro. ⚠️ **NO borra `kyc`** |
| `chaski-v3/src/infrastructure/persistence.ts` | Dónde vive el borrador del envío | `export const KEY = "chaski.remittances.v1"` (`:15`), exportada a propósito para que el bloque de diagnóstico pueda cruzarla |
| `chaski-v3/src/presentation/bitacora-de-vuelta.ts` | El patrón de instrumento del repo | `anotarHito` (`:101`), `HitoDeVuelta` (`:96`) con la regla textual «Los cuatro, cerrados. Un quinto obliga a decidir qué pregunta contesta y a darle renglón». No es telemetría: no hay `fetch`, ni `localStorage`, ni `console` (`:16-17`) |
| `chaski-v3/src/presentation/diagnostico-de-vuelta.tsx` | El consumidor de esos hitos | `PARAM_DIAG = "diag"` (`:151`), `diagnosticoPedido(href)` (`:164`), `presenciaEnElDisco(leer, ahoraMs)` (`:328`), y los `renglonDe*` (`:396`, `:411`, `:425`) |
| `chaski-v3/src/composition/citas-ancladas.test.ts` | Qué candado hace cumplir Δ0 | El regex `CENSO` (`:331`) y los `it` de `:398-434`. Un marcador desajustado **se pone rojo solo**. Ya lleva los censos de `flow.tsx` y `solana-wallet.ts` |
| `chaski-v3/src/composition/readme-test-count.test.ts` | El candado que rompe **agregar un archivo de test** | Cuenta bajo `src`, `app`, `contracts`, `scripts` (`:38`) y exige que **los dos** README declaren ese número por separado (`:22-26`). Hoy declaran **165** (`README.md:436`, `README.es.md:462`) `[MEDIDO-F2]` |
| `chaski-v3/src/presentation/wallet-availability.test.tsx` (67 KB) | El exemplar de test de esta ola | `T-CABLE-1..4` (`:128-163`), `T-UI-1..4` (`:182-254`), `T-LINK-1/2` (`:257`, `:320`), `T-065-21` (`:1018`) que compara el `innerHTML` del paso entero, `T-H1-3` (`:956`) que **lee** el alto de un `<Button>` en vez de escribirlo |
| `chaski-v3/src/presentation/vuelta-por-enlace-carrera.test.tsx` | El flake preexistente | `PUERTA 1` (`:259`) y `PUERTA 2` (`:279`), con el análisis del AR en `:297-306` `[MEDIDO-F2]` |
| `chaski-v3/package.json` | El gate real de **este** repo | `qa` = `lint && typecheck && typecheck:scripts && test` (`:20`); `build` = `next build --webpack` (`:10`); `lint` = `biome lint src app scripts` (`:12`) `[MEDIDO-F2]` |
| `chaski-v3/doc/sdd/{075,073,069}/auto-blindaje.md` | Auto-Blindaje histórico (§3.3) | 8 patrones recurrentes, convertidos en CD |

### 2.2 · Exemplars verificados (todos existen, todos abiertos)

| Exemplar | Ruta (verificada) | Qué se copia de él |
|---|---|---|
| El enlace `browse` renderizado como `<a href>` | `src/presentation/flow.tsx:1378-1384` | La forma exacta del control: `<a href={...} rel="noreferrer" className={...}>`. **⛔ Nunca un `<button onClick>` que asigne `location.href`** |
| El constructor de la URL | `src/presentation/wallet-availability.ts:26-28` | Se **reusa**, no se reescribe |
| El guard de «no afirmes nada todavía» | `src/presentation/flow.tsx:1351` | `availability !== "none" \|\| direccionConectada !== null \|\| vueltaSinResolver ⇒ return null` |
| Un aviso condicional metido en una línea física existente | `src/presentation/flow.tsx:757` | Tres avisos (`saltoPendiente`, `avisoKyc`, `estadoNonce`) conviven en **una** línea física, con el razonamiento del pliegue a 375x667 escrito ahí mismo |
| Una prop nueva sin línea nueva | `src/presentation/flow.tsx:963` | `<NoWalletHere direccionConectada={address} vueltaSinResolver={vueltaSinResolver} />` con el comentario «LA PROP VA EN ESTA MISMA LÍNEA (Δ0)» |
| Un módulo puro con almacén y suscripción | `src/presentation/bitacora-de-vuelta.ts` | Variable de módulo + `Set` de oyentes + `olvidar*()` test-only. Sin `fetch`, sin `localStorage`, sin `console` |
| Un test que compara el árbol entero para probar «byte-idéntico» | `T-065-21`, por nombre; al `b402ab7` en `src/presentation/wallet-availability.test.tsx:1037` (`T-065-21`) | Comparación de `innerHTML` del paso, no de un texto suelto |
| Un test que **lee** el valor en vez de re-escribirlo | `T-H1-3`, por nombre; al `b402ab7` en `src/presentation/wallet-availability.test.tsx:975` | El antídoto contra el guard que se lee a sí mismo |
| El cableado real del árbol de providers | `src/presentation/wallet-availability.test.tsx:128-163` (`T-CABLE-*`) | Monta la librería de verdad y **lee** la disponibilidad; nadie la setea a mano |

### 2.3 · Lo que verifiqué contra la fuente externa, corriendo

| Qué | Resultado | Cómo |
|---|---|---|
| Forma del deeplink `browse` de la versión vigente | `https://phantom.app/ul/browse/<url>?ref=<ref>`, **los dos parámetros requeridos y URL-encoded** ⇒ **byte-idéntico a `phantomBrowseUrl` (`wallet-availability.ts:27`)**. ✅ El repo no inventó nada | `GET https://docs.phantom.com/phantom-deeplinks/other-methods/browse` ⇒ 200, 2026-08-31 19:22 UTC `[MEDIDO-RED]` |
| ¿Se puede ofrecer **antes** de conectar? | **Sí**, textual en esa doc: *«The browse deeplink can be used before a Connect event takes place, as it does not require a session param.»* | ídem `[MEDIDO-RED]` |
| ¿Puede dispararse solo? | **No.** Textual: *«These deeplinks must either be handled by an app or clicked on by an end user.»* ⇒ **la doc de Phantom respalda AC-1-1 por sí sola**, además del precedente medido en el teléfono del founder (`flow.tsx:286`) | ídem `[MEDIDO-RED]` |
| La URL de instalación | `https://phantom.com/download` ⇒ **HTTP 200**. `https://phantom.app/download` ⇒ **301** a la anterior | `curl -sSI`, 2026-08-31 19:22 UTC `[MEDIDO-RED]` |
| Qué hace el enlace `browse` si Phantom **no** está instalada | **`[NO VERIFICADO]`**. La doc no lo dice. Por eso el diseño **no se apoya en el fallback del universal link**: pone un segundo enlace explícito (§4, DT-W1-5) |

### 2.4 · Lo que ya existe hoy y no hay que volver a construir

- **El detector de disponibilidad**: `useWalletAvailability()` (`wallet-availability.ts:36`). ⛔ **No
  se escribe uno nuevo, no se mira el user agent.** El repo tiene la razón escrita en el docblock de
  `mwaEnabled` (`wallet-availability.ts:84-90`): *«mirar el user agent por nuestra cuenta sería una
  segunda opinión que puede contradecir a la primera»*.
- **El constructor de la URL**: `phantomBrowseUrl`.
- **El enlace en la pantalla `connect`**: `NoWalletHere` (`flow.tsx:1349`), montado en `flow.tsx:963`.
- **El candado de Δ0**: `citas-ancladas.test.ts`, con los marcadores de censo.
- **El instrumento de campo**: el bloque `?diag=1` (`diagnostico-de-vuelta.tsx`).

---

## 3 · Decisiones técnicas (DT-W1-N)

### DT-W1-1 · La entrada al camino nuevo es **un enlace que la persona toca**, nunca una redirección

**Qué se decide:** el salto al navegador de la billetera es un `<a href>` renderizado, dentro de un
gesto. ⛔ Ni `useEffect`, ni `setTimeout`, ni `requestAnimationFrame`, ni `router.push`.

**Fundamento, y son dos independientes:**
1. La doc de Phantom de hoy: *«These deeplinks must either be handled by an app or clicked on by an
   end user»* `[MEDIDO-RED]`.
2. La medición del founder en su propio teléfono, con la foto `t=12830 ms`, escrita en
   `flow.tsx:286` `[MEDIDO-F2]`: la navegación programática fuera de un gesto **la descartan los
   navegadores móviles sin error y sin rastro**, y ese mismo comentario dice textual que **no se
   arregla con un `setTimeout` ni con un `requestAnimationFrame`**.

**Consecuencia:** el «camino por defecto» del encargo se implementa como **jerarquía visual y copy**,
no como redirección automática. Es la única forma que el navegador honra.

### DT-W1-2 · El camino nuevo se ofrece **en la pantalla de entrada**, antes de que exista un borrador

**Qué se decide:** el ofrecimiento principal vive en el paso `bienvenida`. El de la pantalla
`connect` (`NoWalletHere`) **se conserva** y pasa a ser el secundario.

**Por qué ahí y no en `connect`, que es donde está hoy:** porque el borde de `AC-1-4b` **deja de
existir**. En `bienvenida` la persona todavía no cargó monto ni datos del beneficiario
(`flow.tsx:316` recién crea la remesa al salir de `send`), así que un salto desde ahí **no puede
perder nada**. Ofrecerlo en `connect` es ofrecerlo justo después del único punto del recorrido donde
hay algo que perder.

**Y la doc lo habilita explícitamente**: `browse` no necesita sesión y **se puede usar antes del
`connect`** `[MEDIDO-RED]`.

⚠️ **El costo, dicho:** en `bienvenida` la disponibilidad todavía puede valer `"unknown"`. Medido en
el teléfono del founder y escrito en `flow.tsx:1351`: *«la disponibilidad se decide a los 1852 ms»*.
El splash cubre 1200 de esos ms (`MS_EN_PANTALLA = 1200`, `splash.tsx:60`, `[MEDIDO-F2]`). ⇒ **el
bloque aparece con un salto de layout de ~650 ms**. Se acepta: la alternativa es afirmar antes de
saber, que es exactamente lo que `T-CABLE-4` prohíbe.

### DT-W1-3 · Quien ya está adentro del navegador de la billetera **no ve nada nuevo**, y se detecta con el detector que ya existe

**Qué se decide:** el bloque nuevo devuelve `null` cuando la disponibilidad **no** es `"none"`. Mismo
predicado, palabra por palabra, que `NoWalletHere` (`flow.tsx:1351`).

**Por qué esto no es adivinar:** `"injected"` es lo que la librería reporta cuando algún adapter
llegó a `Installed`, y eso es exactamente lo que pasa dentro del navegador de Phantom —**medido con
el mismo user agent de celular que el caso contrario**, `T-CABLE-2` vs `T-CABLE-1`
(`wallet-availability.test.tsx:128-152`) `[MEDIDO-F2]`.

**Por qué `"unknown"` tampoco ofrece nada:** `"unknown"` es «todavía no lo medimos», no «no hay»
(`solana-wallet-bridge.ts:22`). Afirmar con `"unknown"` es el defecto que `T-CABLE-4` congela.

⚠️ **Lo que este predicado NO distingue, y hay que decirlo:** un escritorio sin extensión también da
`"none"`. ⇒ el bloque **se le muestra también a quien está en una computadora**. Es exactamente lo
que `NoWalletHere` ya hace hoy en producción, y su copy resuelve el caso con la nota al pie de
`flow.tsx:1386`. W1 conserva esa nota. **⛔ No se mira el user agent para separarlos** (§2.4).

### DT-W1-4 · El borde de `AC-1-4b` se resuelve **midiendo en runtime**, nunca suponiendo

**El problema real, y hay que nombrarlo con precisión:** el navegador de Phantom es **otra partición
de almacenamiento**. No es «volver al mismo origen»: es *el mismo origen en otro navegador*.

🔴 **Y ésta es una pregunta NUEVA, distinta de las cuatro que `solana-wallet.ts:894` declara sin
verificar.** Aquéllas son sobre el salto por **enlace**, que sale y **vuelve al mismo navegador**.
Ésta es sobre el salto por **`browse`**, que **no vuelve**: aterriza en otro. Confundirlas sería
heredar una respuesta que no aplica. **Ninguna de las dos está medida** (CD-11 sigue en pie para las
cuatro originales; W1 no las toca ni las cierra).

**Qué decide W1:** el código **no afirma** si el borrador sobrevive. **Lo pregunta cuando aterriza.**

1. Al **salir**, si existe un borrador, la URL destino lleva una marca nuestra (`?wb=1`).
2. Al **aterrizar**, si la marca está y el almacén de **este** navegador no tiene borrador, la
   pantalla lo dice, en ese momento, sin adjetivos.
3. Si la marca está y el borrador **sí** está, no se dice nada: no hubo nada que contar.
4. Sin marca, no se dice nada: un visitante nuevo dentro de Phantom no puede leer un aviso sobre
   datos que nunca cargó.

⇒ **Son TRES desenlaces observables, no dos**, que es la regla que este repo ya tiene escrita en
`MotivoParaNoMostrar` (`splash-puerta.ts:68-73`) y en `SolanaWalletAvailability`.
⇒ **El aviso ES el instrumento de campo**: si aparece, el almacenamiento no cruzó; si no aparece y el
borrador está, cruzó. El founder no necesita `?diag=1` para leer el resultado.
⇒ Y cumple `AC-1-4b` por su **segunda rama** («decirle explícitamente que tiene que empezar de
nuevo») **sin prometer la primera**, que sería afirmar algo no medido.

### DT-W1-5 · Quien no tiene la billetera: **dos enlaces**, y el de instalar no se deja al azar

**Decisión del founder D-3, ya tomada:** *«si el usuario no tiene Phantom se le pide instalar y crear
su wallet»*. ⛔ No se re-decide.

**Cómo se implementa:** el bloque ofrece **dos** salidas, una debajo de la otra:
- **«Abrir Chaski en Phantom»** → el universal link `browse`.
- **«No tengo Phantom»** → `https://phantom.com/download` (**HTTP 200 medido hoy**; `phantom.app/download` redirige acá con 301) `[MEDIDO-RED]`.

**Por qué DOS y no uno solo:** circula que un universal link cae solo en la página de descarga cuando
la app no está instalada. Eso es **`[NO VERIFICADO]`** para `browse`: la doc de Phantom no lo dice
`[MEDIDO-RED]`. Apoyar el recorrido de instalación en un comportamiento no medido es exactamente el
modo de falla que este proyecto ya tiene documentado. Con dos enlaces, **el recorrido de D-3 no
depende de esa incógnita**.

**Y la vuelta de instalar:** quien instala Phantom y vuelve al navegador donde estaba **vuelve al
mismo almacenamiento** (no navegó a otro navegador, sólo a la tienda), así que su borrador está
intacto y el bloque sigue ahí para tocarlo. Si esa vuelta lo perdiera igual, la salvaguarda de
DT-W1-4 lo dice. ⛔ **No se ofrece ninguna billetera embebida ni custodial** (CD-2 heredada).

### DT-W1-6 · **Ningún flag nuevo**

**Qué se decide:** W1 no agrega una `NEXT_PUBLIC_*`.

**Fundamento:**
1. El enlace `browse` **ya está en producción sin bandera** (`flow.tsx:1379`). Gatear la versión
   nueva y no la vieja deja dos caminos al mismo sitio con distinta perilla.
2. El repo tiene **medido** el costo de una bandera de build mal replegada: la elección persistida no
   expiraba y un build con la bandera prendida y después ausente dejaba el dispositivo *«con este
   gate devolviendo `"phantom"` sin puerta de vuelta»* — `solana-wallet.ts:2236`, AR/BLQ-MED-1
   `[MEDIDO-F2]`.
3. Las `NEXT_PUBLIC_` las inlinea el **build**: cambiar el valor y redesplegar el mismo artefacto no
   cambia nada (`wallet-availability.ts:95-96`) `[MEDIDO-F2]`.

**Repliegue:** W1 es cliente-only y aditiva ⇒ **el repliegue es un revert**. Se declara así en el
plan de despliegue (§8), no como una perilla que no existe.

### DT-W1-7 · La URL que se le entrega a la billetera **se construye**, no se copia de la barra

**Qué se decide:** en vez de `phantomBrowseUrl(window.location.href, origin)`, W1 pasa por una
función pura que primero **limpia** el `href`.

**Por qué, y es un defecto latente que ya está en producción:** hoy `NoWalletHere` toma
`window.location.href` crudo (`flow.tsx:1354`). Si la persona está en `/?kyc=return` —el aterrizaje
del verificador (`urlDeVueltaDeKyc`, `splash-puerta.ts:54`)— ese parámetro **viaja tal cual** al
navegador de Phantom, donde `motivoParaNoMostrar` lo lee como `"vuelta-de-kyc-en-la-url"`
(`splash-puerta.ts:94`) y arranca un resume de un KYC que en **ese** almacenamiento no existe.

**⚠️ Es un hallazgo de este F2, no un requisito del work-item.** Se arregla acá porque W1 reescribe
exactamente esa expresión y dejarlo sería empeorar el camino que la ola promueve. Se declara en el
scope y en el presupuesto de diff (§9), no se cuela.

**Qué borra la limpieza:** lo que borra `hrefSinRastroDeVuelta` (`conexion.ts:362`: los
`PARAMS_DE_RESPUESTA` y el `MARCA`/`dl`) **más** `PARAM_KYC` (`splash-puerta.ts:45`), que esa función
**no** borra `[MEDIDO-F2]`. Los tres son rastros del navegador de **origen** y no significan nada en
el de destino.

### DT-W1-8 · El módulo nuevo es un **archivo nuevo**, y ésa es la forma más barata de Δ0

**Qué se decide:** la función pura vive en `src/presentation/salida-al-navegador-de-la-billetera.ts`,
archivo nuevo. No se agrega a `wallet-availability.ts`.

**Fundamento:** un archivo nuevo **rota cero citas ancladas de cualquier archivo**. Agregarlo a
`wallet-availability.ts` obligaría a apendear al final (viable, `:158` es la última línea y nada la
cita) pero acoplaría un módulo que se define a sí mismo como *«no importa `@solana/wallet-adapter-*`,
lee el singleton React-free»* (`wallet-availability.ts:3-5`) con `deeplink/conexion.ts` y
`splash-puerta.ts`. El archivo nuevo importa `phantomBrowseUrl` y listo.

### DT-W1-9 · El instrumento de éxito **se ejecuta**, y la primera ola es una **premisa falsable**

**Qué se decide:** antes de escribir una línea de producción, W1.0 escribe los tests que prueban, en
el árbol de **hoy**, que dentro del navegador de la billetera el recorrido ya cumple lo que W1
promete. **Si alguno sale rojo, W1 se detiene y se reporta.**

**Por qué:** el work-item declara que *«el recorrido que se rediseña nunca se completó de punta a
punta»* y que no hay línea de base ejecutada. Empezar por la UI sería construir la puerta antes de
saber si la habitación existe. Además `AC-0-4` (la línea de base ejecutada) es de **W0** y corre en
paralelo (§11 del work-item): W1 no la espera, pero **tampoco la copia** (CD-8).

⛔ **Este SDD no publica ningún número de saltos, firmas o SOL como resultado.** Los que aparecen
llevan `[HEREDADO]` y su camino al lado, que es lo que CD-8 exige.

---

## 4 · Diseño técnico

### 4.1 · Archivos a crear / modificar — la lista exhaustiva

| # | Archivo | Acción | Δ líneas | Anclas exactas |
|---|---|---|---|---|
| A | `chaski-v3/src/presentation/salida-al-navegador-de-la-billetera.ts` | **CREAR** | +130 ± 40 | — (archivo nuevo, rota 0 citas) |
| B | `chaski-v3/src/presentation/salida-al-navegador-de-la-billetera.test.ts` | **CREAR** | +130 ± 40 | — |
| C | `chaski-v3/src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx` | **CREAR** | +320 ± 100 | — |
| D | `chaski-v3/src/presentation/flow.tsx` | **MODIFICAR, Δ0 OBLIGATORIO** | **0** | `:77` (import) · `:757` (bloque nuevo + aviso de aterrizaje) · `:963` (prop) · `:1379` (href) · `:1386` (copy + enlace de instalar) |
| E | `chaski-v3/src/presentation/wallet-availability.test.tsx` | **MODIFICAR** (agregar `it`) | +90 ± 30 | apéndice al final; **no** se reordena nada |
| F | `chaski-v3/src/presentation/bitacora-de-vuelta.ts` | **MODIFICAR** | +0 en el tipo (`:96`, en línea) / +8 al **final** del archivo | `:96` (el union) |
| G | `chaski-v3/src/presentation/diagnostico-de-vuelta.tsx` | **MODIFICAR, Δ0** | **0** | el renglón nuevo entra en una línea física existente del bloque |
| H | `chaski-v3/README.md` | **MODIFICAR** | 0 (una línea reescrita) | `:436` — el conteo pasa de **165** al que devuelva el candado |
| I | `chaski-v3/README.es.md` | **MODIFICAR** | 0 | `:462` — ídem, **por separado** (el candado los mide por separado a propósito) |
| J | `wasiai-a2a/doc/sdd/233-recorrido-movil-sin-saltos/**` | los artefactos | — | ⛔ **0 líneas de `src/` en `wasiai-a2a`** |

⛔ **Archivos explícitamente FUERA de W1** (tocarlos es BLOQUEANTE en AR):
`src/infrastructure/solana-wallet.ts` (CD-W1-2) · `src/application/solana-escrow-rent.ts` (CD-12) ·
`src/infrastructure/solana/deeplink/**` · `src/infrastructure/solana/nonce-duradero.ts` ·
`src/infrastructure/solana/preparacion-por-enlace.ts` (CD-3/CD-5) ·
`src/methods/solana-sponsor/cr1.ts` de `wasiai-facilitator` (es de la HU `071`) ·
cualquier archivo de `app/api/**` (W1 no cambia ningún contrato de servidor).

### 4.2 · El módulo nuevo — contrato

`src/presentation/salida-al-navegador-de-la-billetera.ts`, puro, sin React, sin `fetch`, sin
`console`:

```
export const URL_INSTALAR_PHANTOM: string
   // "https://phantom.com/download" — MEDIDO 200 el 2026-08-31; phantom.app/download da 301 acá.

export const PARAM_SALIDA: string      // "wb"
export const VALOR_SALIDA: string      // "1"

export function urlDeSalidaAlNavegadorDeLaBilletera(p: {
  href: string;      // window.location.href del navegador de ORIGEN
  origin: string;    // window.location.origin
  hayBorrador: boolean;
}): string
   // 1. limpia el href: hrefSinRastroDeVuelta(href) y además borra PARAM_KYC.
   // 2. si hayBorrador, agrega PARAM_SALIDA=VALOR_SALIDA.
   // 3. devuelve phantomBrowseUrl(limpio, origin).
   // ⛔ href impareseable ⇒ devuelve phantomBrowseUrl(href, origin), igual que hoy. No se inventa una URL.

export function vinoDeUnaSalidaConBorrador(href: string): boolean
   // true SOLO si el href trae PARAM_SALIDA con VALOR_SALIDA exacto. Un href impareseable ⇒ false.
```

⚠️ **Tres decisiones del contrato, con su razón:**
- **`hayBorrador` es un parámetro, no una lectura del disco adentro del módulo.** El módulo se
  mantiene puro y testeable sin `localStorage`; quien sabe si hay borrador es la pantalla.
- **`vinoDeUnaSalidaConBorrador` compara el valor exacto**, no `has()`. Opt-in estricto, mismo patrón
  y por la misma razón que `mwaEnabled` (`wallet-availability.ts:98`) y `deeplinkEnabled` (`:156`).
- **`PARAM_SALIDA` no se agrega a `motivoParaNoMostrar`.** Verificado: esa puerta mira sólo `kyc` y
  `dl` (`splash-puerta.ts:94-96`) ⇒ el splash se muestra normal en el primer aterrizaje dentro de la
  billetera, que es lo correcto: es una primera visita en ese navegador. **⛔ No se toca esa puerta.**

### 4.3 · Los cinco puntos de inserción en `flow.tsx` — Δ0, uno por uno

> ⛔ **Todos van DENTRO de una línea física que ya existe.** El invariante que lo justifica está
> escrito en `flow.tsx:44`: *«TODO lo que está más abajo se corre con una línea nueva acá»*.
> El candado que lo caza es `citas-ancladas.test.ts` + el marcador `[[CENSO … lineas=4453]]`.

**I-1 · `flow.tsx:77` (imports).** Se agregan los símbolos del módulo nuevo **al final de la cadena
de `import ...;` y ANTES del `//`** que cierra la línea. ⚠️ El propio comentario de `:77` explica por
qué es esa línea y no `:74`, y advierte que pegarlo **después** del `//` lo deja comentado sin que
`tsc` lo cace.

**I-2 · `flow.tsx:757` (el bloque de avisos pre-cuerpo).** Entran **dos** nodos nuevos en esa misma
línea, junto a los tres que ya viven ahí:

- **La oferta**, condicionada por:
  `step === "bienvenida" && disponibilidadWallet === "none" && saltoPendiente === null && !vueltaSinResolver && avisoKyc === null && estadoNonce === null`.
  Cada condición tiene su motivo y **ninguna es decorativa**:
  | Condición | Por qué |
  |---|---|
  | `step === "bienvenida"` | En `send` hay datos a medio cargar; ofrecer ahí el salto es ofrecer perderlos. En los otros destinos (`history`, `recuperar`) la persona no está enviando |
  | `disponibilidadWallet === "none"` | DT-W1-3. Con `"injected"` o `"unknown"` no se ofrece nada |
  | `saltoPendiente === null` | Si hay un salto pendiente, ese enlace es **lo único** que la persona puede hacer (`flow.tsx:757`, textual). Dos enlaces compitiendo ahí es el defecto que HU-075 cerró |
  | `!vueltaSinResolver` | Mismo motivo que la tercera condición de `NoWalletHere` (`:1351`): mientras no se sabe, no se afirma |
  | `avisoKyc === null` | Ese aviso lleva un envío a medias con su snapshot; saltar lo pierde |
  | `estadoNonce === null` | La tarjeta del nonce es del camino de respaldo y tiene sus propias salidas |
- **El aviso de aterrizaje** de DT-W1-4, condicionado por
  `vinoDeUnaSalidaConBorrador(hrefActual) && rem === null && !hayBorradorEnElDisco`.

**I-3 · `flow.tsx:963` (el paso `connect`).** Se agrega la prop `hayBorrador={rem !== null}` a
`<NoWalletHere .../>`, **en esa misma línea**. Precedente literal en el comentario de esa línea.

**I-4 · `flow.tsx:1379` (el `href`).** `phantomBrowseUrl(href, origin)` pasa a ser
`urlDeSalidaAlNavegadorDeLaBilletera({ href, origin, hayBorrador })`. Es un reemplazo de expresión en
una línea que ya existe. ⚠️ `href` y `origin` siguen saliendo de `:1354-1355`, sin cambio.

**I-5 · `flow.tsx:1386` (la nota al pie de `NoWalletHere`).** Se reescribe el texto de esa línea para
que diga las dos cosas nuevas: el enlace a instalar (DT-W1-5) y la advertencia honesta sobre los
datos (DT-W1-4). ⚠️ **La nota de la computadora no se borra**: sigue siendo el único texto correcto
para el escritorio sin extensión.

### 4.4 · Microcopy — español rioplatense, sin em dashes, sin decir que algo falló

⛔ Reglas heredadas: no decir *«el remitente no necesita SOL»* (CD-12) · no decir que algo falló
cuando no falló (`flow.tsx:757`) · no prometer lo que no está medido.

**La oferta en `bienvenida`:**

> **¿Estás en un celular con Phantom?**
> Abrí Chaski adentro de Phantom y no vas a tener que saltar a otra app en cada firma.
> `[ Abrir Chaski en Phantom ]`
> No tengo Phantom · Instalarla y crear mi billetera
> Si estás en una computadora, instalá la extensión de Phantom o Solflare y recargá la página.

⚠️ **Por qué el título es una pregunta y no una afirmación:** el detector no puede decir si la persona
está en un celular (§2.4, DT-W1-3). Preguntar es lo único honesto. Es la misma disciplina que
`NoWalletHere` ya aplica con *«Esto no dice si tenés una wallet instalada»* (`flow.tsx:1368-1369`).
⚠️ **Por qué «no vas a tener que saltar a otra app en cada firma» y no «cero saltos»:** lo primero es
verificable (dentro del navegador de la billetera `caminoPorEnlace()` es `null` y `pedir()` contesta
`no-corresponde`); lo segundo omite el redirect del verificador de identidad (§11, `D-W1-1`).

**El aviso de aterrizaje (DT-W1-4):**

> **Acá no están los datos que cargaste antes**
> Cargá el monto y los datos de tu familiar otra vez. Es una sola pantalla.

⚠️ **No explica la causa.** «El navegador de Phantom guarda todo aparte» sería una afirmación causal
que nadie midió. Lo que sí está medido en ese instante es que el borrador no está acá, y eso es lo
único que la frase dice. ⚠️ **No dice «empezá de nuevo»** ni **«se perdió»**: es el pecado que
`flow.tsx:757` persigue por escrito.

**La advertencia de salida en `connect` (`:1386`):**

> Si al llegar no ves lo que cargaste, cargalo otra vez.

⚠️ **Es condicional a propósito**, y es la única forma honesta: nadie midió todavía si el borrador
cruza. La frase es **verdadera en los dos mundos** y no promete ninguno.

### 4.5 · El renglón de diagnóstico (W1.3)

`HitoDeVuelta` (`bitacora-de-vuelta.ts:96`) suma un quinto valor: `"salida-al-navegador"`, con los
tres desenlaces de DT-W1-4 como valores posibles (`con-marca-y-borrador` / `con-marca-sin-borrador` /
`sin-marca`).

⚠️ **La regla del propio archivo, textual:** *«Los cuatro, cerrados. Un quinto obliga a decidir qué
pregunta contesta y a darle renglón»* `[MEDIDO-F2]`. ⇒ **el renglón en
`diagnostico-de-vuelta.tsx` no es opcional: es el precio de agregar el hito.** Si W1.3 se recorta,
se recorta **entero**, hito incluido.

⛔ Lo que **no** entra ahí: ninguna dirección, ninguna clave, ninguna URL. Los tres valores son
etiquetas que escribe este repo, igual que los cuatro que ya están.

---

## 5 · Constraint Directives (CD-W1-N)

### 5.1 · Heredadas del work-item — vigentes sin cambio

| CD | Qué prohíbe | Cómo aplica a W1 |
|---|---|---|
| **CD-1** | Tocar la arquitectura A2A | W1 no toca `app/api/**` ni el cuerpo de ninguna llamada a `/compose`. **Diff de W1 en `app/` esperado: 0 archivos** |
| **CD-2** | Cualquier custodia de la clave | ⛔ D-3 **no** habilita una billetera embebida. El único enlace de instalación va a la app no custodial |
| **CD-3** | Apagar o borrar el recorrido por enlace | El selector de enlace (`flow.tsx:963`) y `deeplinkEnabled()` quedan **exactamente como están**. W1 **agrega** una entrada, no reemplaza ninguna |
| **CD-5** | Borrar el código del durable nonce | W1 toca **0 líneas** de `nonce-duradero.ts` y de `solana-wallet.ts` |
| **CD-8** | Publicar un número sin su camino y su instrumento | Todo número de este SDD lleva `[HEREDADO]` o su cita. Los de éxito los produce W1.0 corriendo |
| **CD-11** | Convertir en afirmación del código cualquiera de las cuatro cosas sin verificar de `solana-wallet.ts:894` | W1 **no las cierra ni las nombra como resueltas**. DT-W1-4 aclara que su pregunta es **otra** |
| **CD-12** | Tocar el **valor** de un umbral de SOL, o decir *«el remitente no necesita SOL»* | W1 toca 0 líneas de `solana-escrow-rent.ts`. **Ningún copy, ningún comentario y ningún reporte de esta ola contiene esa frase** |
| **CD-13** | Re-derivar el diseño de la HU `071` | No se abre `cr1.ts`, no se re-deriva nada de la `071`. Se la cita por ruta |

### 5.2 · Nuevas de esta ola

- **CD-W1-1** ⛔ **Δ0 DE LÍNEAS EN `src/presentation/flow.tsx`.** El archivo mide 4453 líneas y ese
  número **es un marcador verificado** (`[[CENSO src/presentation/flow.tsx lineas=4453]]`, `:44`).
  IF el diff cambia el conteo de líneas de ese archivo, THEN es **BLOQUEANTE** en AR.
  **Se verifica con `wc -l`, no leyendo el diff** (lección literal del auto-blindaje de la HU 069:
  *«Rompí Δ0 al corregir prosa, y lo cacé con `wc -l`, no leyendo»*).
- **CD-W1-2** ⛔ **PROHIBIDO EDITAR `src/infrastructure/solana-wallet.ts` EN W1.** Cero líneas.
  Ese archivo declara `[[CENSO … entrantes-desde-893=76]]` y la HU `071` lo cita por número y por
  debajo. IF el diff de W1 lo toca, THEN es **BLOQUEANTE** en AR, aunque el cambio sea un comentario.
- **CD-W1-3** ⛔ **PROHIBIDO ESCRIBIR UNA CITA `archivo:línea` QUE NO SE HAYA DERIVADO EN ESA MISMA
  SESIÓN.** Recurrente en **3 de 3** auto-blindajes leídos (075: *«escribí DOS citas ancladas que
  nunca derivé»*, *«tres citas ancladas nuevas derivadas de memoria, y las tres apuntaban mal»*;
  073: *«rompí con MI PROPIA edición la cita que YO acababa de escribir»*; 069: *«escribí un número
  de línea antes de medirlo, dos veces»*, *«`rtk cat -n` me dio números FALSOS»*).
  **OBLIGATORIO**: cada cita nueva se deriva con `sed -n 'Np'` **después** de la última edición del
  archivo destino, y se re-deriva **al final de la ola**.
- **CD-W1-4** ⛔ **NINGÚN GUARD PUEDE LEERSE A SÍ MISMO.** IF un `it` busca un literal en la misma
  línea donde ese literal aparece, THEN **nunca puede fallar** y es **BLOQUEANTE**. Recurrente en 075
  (*«mi propio `assert` de limpieza matcheaba el texto que yo acababa de escribir»*,
  *«una afirmación en MAYÚSCULAS que ningún test podía poner en rojo»*) y 073 (*«21 citas correctas y
  sin un solo candado que las mirara»*). **El antídoto que el repo ya tiene**: `T-H1-3`
  (`T-H1-3`, por nombre; al `b402ab7` en `wallet-availability.test.tsx:975`) **lee** el valor de un componente renderizado en vez de
  re-escribirlo.
- **CD-W1-5** ⛔ **UN `exit=1` SIN UN `×` NOMBRADO NO ES UN KILLED.** Todo test que afirme un
  comportamiento se rompe a propósito y se cita el rojo con **archivo, nombre del `it`, y por qué
  murió**. IF el mutante muere por un error de sintaxis, por un guard vecino, o por un fixture que ya
  daba verde sin el arreglo, THEN es **falso KILLED** y no cuenta. Recurrente en 075 (*«el mutante
  murió de un ERROR DE SINTAXIS»*, *«UN FALSO KILLED MÍO»*, *«el fixture no reproducía el defecto y
  daba verde con y sin el arreglo»*) y 073 (*«un mutante MAL CONSTRUIDO sobrevive y absuelve a un
  guard que sí funciona»*, *«un control positivo que NO renderizaba nada»*).
- **CD-W1-6** ⛔ **PROHIBIDO CITAR EL GATE SIN CORRERLO ENTERO Y EN ORDEN.** El gate de `chaski-v3`
  es `npm run qa` (`lint` → `typecheck` → `typecheck:scripts` → `test`, `package.json:20`) y después
  `npm run build`. **`lint` va PRIMERO y es el eslabón que nadie alcanza**: 075 (*«el gate falló en
  LINT»*) y 069 (*«corrimos las PARTES del gate, nunca el GATE»*, *«un error de lint NO se ve en la
  salida de `npm run lint`»*). ⛔ **Se corre después de `git add -A`**: el gate se mide contra el
  índice. ⛔ **Ni `npx biome` ni `npx tsc` sueltos**: `npx` intenta bajar paquetes inexistentes y
  devuelve un error que se lee como fallo del gate.
- **CD-W1-7** ⛔ **AGREGAR UN ARCHIVO `*.test.ts(x)` ROMPE `readme-test-count.test.ts`, Y ESO ES
  CORRECTO.** Los **dos** README declaran el conteo (`README.md:436`, `README.es.md:462`, hoy
  **165**) y el candado los mide **por separado**. **OBLIGATORIO**: el número nuevo se **deriva
  corriendo el candado**, nunca contando a mano.
- **CD-W1-8** ⛔ **LOS MARCADORES `[[CENSO …]]` SE RE-DERIVAN AL FINAL DE LA OLA, NO AL PRINCIPIO.**
  Recurrente en 075 (*«el marcador envejeció DOS veces en la misma sesión, y la segunda la causó mi
  propio test»*) y 073 (*«se re-derivan UNA VEZ POR COMMIT que agrega citas»*). Si W1 agrega citas
  ancladas a `flow.tsx`, el marcador `entrantes=155` cambia y hay que actualizarlo **después** del
  último commit de código.
- **CD-W1-9** ⛔ **EL FLAKE PREEXISTENTE NO SE PONE EN CUARENTENA, NI SE CUENTA COMO REGRESIÓN, NI SE
  DECLARA CON UN DENOMINADOR CHICO.** `src/presentation/vuelta-por-enlace-carrera.test.tsx`,
  `PUERTA 1` (`:259`) y `PUERTA 2` (`:279`), 7-13 %, **no es de esta HU**. **OBLIGATORIO**: si aparece
  en rojo, se corre **el mismo archivo N veces sobre `cc02b61` sin el diff** y se reporta la
  frecuencia de las dos ramas. Recurrente en 075 (*«casi reporto que EMPEORÉ un flake, con un
  denominador de 10»*) y 069 (*«lo dejo escrito en vez de re-correr hasta el verde»*).
- **CD-W1-10** ⛔ **UNA FRASE CORREGIDA SIGUE PUDIENDO SER FALSA.** Recurrente en 073 (*«la frase
  corregida seguía siendo falsa, con menos filo»*) y 075 (*«los docblocks que mi propio arreglo volvió
  falsos»*, *«una conclusión de SEGURIDAD falsa debajo de una decisión correcta»*).
  **OBLIGATORIO**: cada frase nueva de copy o de docblock se acompaña del **input concreto que la
  pondría en rojo**. Si no existe ese input, la frase se recorta hasta que exista.
- **CD-W1-11** ⛔ **PROHIBIDO MIRAR EL USER AGENT PARA DECIDIR SI SE OFRECE EL CAMINO NUEVO.** El
  detector es `useWalletAvailability()`. Motivo escrito en el repo
  (`wallet-availability.ts:84-90`), y el par `T-CABLE-1`/`T-CABLE-2` existe justamente para impedir
  «arreglarlo mirando el user agent».
- **CD-W1-12** ⛔ **PROHIBIDO TOCAR `motivoParaNoMostrar` NI AGREGARLE UN SEXTO MOTIVO.** El parámetro
  nuevo es invisible para esa puerta **y tiene que seguir siéndolo**.

---

## 6 · Waves de implementación

> El orden **es** load-bearing. W1.0 puede detener la ola entera.

### W1.0 · La premisa, falsable, sobre el árbol de hoy · **SERIAL, BLOQUEANTE** · 0 líneas de producción

Se escribe `src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx` y se corre **sin
tocar una sola línea de producción**. Prueba, con `availability = "injected"` empujado por el árbol
real (patrón `T-CABLE-2`), que hoy:

1. `caminoPorEnlace()` es `null` ⇒ `pedir()` contesta `no-corresponde`.
2. `authorizePrincipal` **no** construye ninguna instrucción de creación de cuenta de nonce.
3. El guard de saldo que corre es el del camino común (`confirm-and-send.ts:428`), o sea el umbral
   **inyectado**. **Se prueba por VALOR, no por nombre**: un saldo exactamente igual a
   `SENDER_MIN_LAMPORTS_FOR_DEPOSIT` **pasa** (con el umbral del enlace no pasaría).
4. `prepare()` se invoca **exactamente 1 vez** en un envío que cierra.
5. No se asigna `window.location.href` a ningún host de billetera durante todo el recorrido.

⛔ **Si cualquiera de los cinco sale rojo, W1 se detiene y se reporta al humano.** La ola entera se
apoya en que ese recorrido ya funciona.

**Sale con:** el archivo C, el gate completo, y los 5 mutantes de §7 nombrados con su `×`.

### W1.1 · El módulo puro · **SERIAL** (depende de W1.0 sólo por el semáforo)

Archivos **A** y **B**. Sin React, sin UI, sin tocar `flow.tsx`.
**Sale con:** `npm run qa` verde + los mutantes de `T-372-W1-8..10`.

### W1.2 · Las cinco inserciones Δ0 y sus tests de pantalla · depende de W1.1

Archivos **D** (Δ0 estricto) y **E**.
**Sale con:** `wc -l src/presentation/flow.tsx` = **4453** (el mismo número de antes), `npm run qa`,
y los mutantes de `T-372-W1-1..7`.

### W1.3 · El renglón de diagnóstico · **paralelizable con W1.2**, entra entero o no entra

Archivos **F** y **G**. ⛔ Recortarlo es válido; recortarlo **a medias** (el hito sin su renglón) no
lo es (`bitacora-de-vuelta.ts:96`).

### W1.4 · Cierre

Archivos **H** e **I** (conteo derivado corriendo el candado) · re-derivación de los marcadores
`[[CENSO …]]` (CD-W1-8) · re-derivación de **todas** las citas nuevas (CD-W1-3) · el gate completo
`git add -A && npm run qa && npm run build`.

---

## 7 · Plan de tests — un test por AC, cada uno con su mutante

> ⛔ Regla transversal (CD-W1-5): cada `it` de esta tabla se rompe a propósito y el rojo se cita con
> **archivo · nombre del `it` · por qué murió**. Y (CD-W1-4) ninguno puede leerse a sí mismo.

| Test | AC | Archivo | Qué afirma | **Mutante que lo tiene que matar** | Falso KILLED a evitar |
|---|---|---|---|---|---|
| `T-372-W1-1` | AC-1-1 | E | En `bienvenida` con `"none"` aparece un **`<a>`** cuyo `href` empieza con el prefijo del universal link, y **no se asigna `window.location.href` en el montaje** | Cambiar el `<a href>` por un `<button onClick>` ⇒ `getByRole("link")` no encuentra nada | Un mutante que rompa el render entero mata cualquier `it`. Se exige que el **control negativo** (`"injected"` ⇒ sin enlace) siga verde |
| `T-372-W1-2` | AC-1-1 | E | **Control negativo:** con `"injected"` el paso `bienvenida` es **byte-idéntico** al de hoy (`innerHTML`) | Quitar la condición `disponibilidadWallet === "none"` | Comparar sólo un texto en vez del `innerHTML` deja pasar cambios de estructura. Patrón obligatorio: `T-065-21` (`:1018`) |
| `T-372-W1-3` | AC-1-2a | C | `pedir()` nunca devuelve `hay-que-salir` y no se asigna `location.href` a un host de billetera en todo el recorrido | Forzar `caminoPorEnlace()` a devolver `"phantom"` con `"injected"` | Si el fixture no llega al final del recorrido, el `it` da verde por no haber ejercitado nada. Se exige assertar el estado terminal |
| `T-372-W1-4` | AC-1-3 | C | Con `"injected"` **no** se construye la ix de creación de la cuenta de nonce | Invertir `!== "none"` a `=== "none"` en `caminoPorEnlace` (`solana-wallet.ts:2240`) | Un mutante en `firmaPorEnlace` mata el mismo `it` sin probar el gate de disponibilidad. Los dos mutantes se corren **por separado** |
| `T-372-W1-5` | AC-1-3 | C | El umbral que aplica es el **inyectado, por VALOR**: un saldo `= SENDER_MIN_LAMPORTS_FOR_DEPOSIT` pasa; uno de `−1` corta | Cambiar el guard de `confirm-and-send.ts:428` al otro símbolo | ⛔ El `it` **importa las dos constantes** y compara; no re-escribe ningún literal (CD-W1-4) |
| `T-372-W1-6` | AC-1-4 | E | El bloque ofrece un segundo enlace cuyo `href` **es** `URL_INSTALAR_PHANTOM` (importada), y `new URL(URL_INSTALAR_PHANTOM).hostname` es el de la billetera | Borrar el segundo enlace | ⛔ Prohibido `toContain("https://phantom.com/download")` escrito en el `it`: sería el guard leyéndose a sí mismo |
| `T-372-W1-7` | AC-1-4b | E | **Los tres desenlaces del aterrizaje**: (a) marca + sin borrador ⇒ el aviso aparece; (b) marca + borrador ⇒ **no** aparece; (c) sin marca ⇒ **no** aparece | Invertir la condición ⇒ (c) se pone rojo, que es el control que impide el aviso falso al visitante nuevo | Sin el caso (c), un mutante que ponga la condición en `true` sobrevive |
| `T-372-W1-8` | AC-1-4b | B | `urlDeSalidaAlNavegadorDeLaBilletera` **borra** `dl`, los params de respuesta **y** `kyc`, y agrega la marca **sólo** con `hayBorrador` | Quitar el borrado de `kyc` | El `it` construye el href de entrada y **parsea** el de salida; no compara strings completos escritos a mano |
| `T-372-W1-9` | AC-1-4b | B | `vinoDeUnaSalidaConBorrador` es **opt-in estricto**: `"1"` prende; ausente, vacío, `"true"`, `"1 "` y un href impareseable **no** | Cambiar la comparación por `params.has(...)` | Patrón obligatorio: `T-065-20` (`:1002`), que ya hace exactamente esto para una env |
| `T-372-W1-10` | AC-1-4b | B | La URL final es **byte-idéntica** a la que produce `phantomBrowseUrl` sobre el href limpio | Reescribir el prefijo a mano en el módulo nuevo | El `it` **importa** `phantomBrowseUrl` y compara contra su salida; no escribe el prefijo |
| `T-372-W1-11` | AC-1-5 | C | El camino de respaldo sigue entero: existen los 7 módulos de `deeplink/**` y `nonce-duradero.ts`, y el selector de enlace sigue apareciendo con la bandera prendida y `"none"` | Renombrar `nonce-duradero.ts` en un worktree | Un `it` que sólo mire el diff no es un guard: éste **lee el árbol** |
| `T-372-W1-12` | AC-1-6 | C | El doble de `prepare` se invoca **exactamente 1 vez** en un envío que cierra, con `"injected"` | Hacer que `pedir()` devuelva `hay-que-salir` ⇒ 3 invocaciones | `toHaveBeenCalled()` no sirve: tiene que ser `toHaveBeenCalledTimes(1)` |
| — | CD-W1-1 | *(ya existe)* | Δ0 de `flow.tsx` | — | ⛔ **No se escribe un guard nuevo.** Ya lo hace `citas-ancladas.test.ts` con `[[CENSO … lineas=4453]]`. Duplicarlo es dos números que se corrigen por separado |

⚠️ **Y una cosa que estos tests NO prueban, dicha antes de que alguien lea su verde de más:**
ninguno corre en un teléfono. Prueban el **árbol**, con la librería real y `jsdom`. Que el
almacenamiento cruce o no cruce el salto lo contesta **el aviso de DT-W1-4 en el teléfono del
founder**, y hasta entonces sigue `[NO VERIFICADO]`.

---

## 8 · Riesgos y orden de despliegue

**W1 es cliente-only y aditiva: no cambia ningún contrato de servidor ⇒ no tiene orden entre repos**
(§9.1 del work-item). Es la única de las tres olas vivas que no lo tiene. **Repliegue = revert**
(DT-W1-6).

| # | Riesgo | Consecuencia | Mitigación en este SDD |
|---|---|---|---|
| R-1 | Alguien edita `solana-wallet.ts` «de paso» | 76 citas ancladas rotas + la HU `071` re-derivando por nada | CD-W1-2 + el marcador de censo que se pone rojo solo |
| R-2 | Una línea de más en `flow.tsx` | 155 citas ancladas corridas, la mayoría en silencio | CD-W1-1 + `wc -l` + `citas-ancladas.test.ts` |
| R-3 | El salto se dispara desde un efecto | El navegador lo descarta **sin error y sin rastro**; la persona se queda mirando la pantalla | DT-W1-1 + `T-372-W1-1`, con el precedente medido de `flow.tsx:286` |
| R-4 | La persona salta desde `connect` y pierde los datos **sin aviso** | Abandona, y el equipo lo lee como «no le interesó» | DT-W1-4: aviso condicional al salir + medición al aterrizar. ⚠️ **No se cierra por lectura de código** |
| R-5 | El `?kyc=return` viaja al otro navegador | Un resume de un KYC que en ese almacenamiento no existe | DT-W1-7 + `T-372-W1-8` |
| R-6 | El aviso de aterrizaje se le muestra a un visitante nuevo | La app le habla de datos que nunca cargó | El caso (c) de `T-372-W1-7` |
| R-7 | El flake de `vuelta-por-enlace-carrera.test.tsx` se lee como regresión de W1 | Se investiga el archivo equivocado, o peor, se pone en cuarentena | CD-W1-9 |
| R-8 | Otra HU mergea sobre `chaski-v3` antes que W1 | Las citas de §4 apuntan mal | §0: **este SDD se re-ancla** antes de escribir código. Hoy `main` está en `cc02b61` y limpio `[MEDIDO-F2]` |
| R-9 | El bloque aparece con salto de layout en la entrada | Molesto, no roto | Declarado en DT-W1-2 con su número (~650 ms). No se «arregla» afirmando antes de saber |

**Roce con la HU `071` de `chaski-v3`:** comparten archivos, no decisiones (§0.1 del work-item). Con
CD-W1-2, **W1 y la `071` dejan de compartir `solana-wallet.ts`**. Sigue habiendo roce en `flow.tsx` y
`flow-vm.ts` ⇒ **se serializa sobre `chaski-v3`**, W1 primero, como manda §0 del work-item.
⛔ W1 **no** toca `flow-vm.ts`.

---

## 9 · Escala esperada del diff — el presupuesto que el CR contrasta

| Archivo | Añadidas | Borradas | Δ neto |
|---|---:|---:|---:|
| `salida-al-navegador-de-la-billetera.ts` (nuevo) | 130 ± 40 | 0 | +130 |
| `salida-al-navegador-de-la-billetera.test.ts` (nuevo) | 130 ± 40 | 0 | +130 |
| `recorrido-en-el-navegador-de-la-billetera.test.tsx` (nuevo) | 320 ± 100 | 0 | +320 |
| `wallet-availability.test.tsx` | 90 ± 30 | 0 | +90 |
| `flow.tsx` | 5 | 5 | **0** (5 líneas físicas reescritas, ≈ +3.500 caracteres) |
| `bitacora-de-vuelta.ts` | 9 | 1 | +8 |
| `diagnostico-de-vuelta.tsx` | 2 | 2 | **0** |
| `README.md` + `README.es.md` | 2 | 2 | 0 |
| **TOTAL** | **~690** | **~10** | **~+680** |

**Presupuesto declarado: ≤ 900 líneas añadidas y ≤ 10 archivos.**
Umbral del check 7 del CR: **si el diff supera 1.800 líneas añadidas o 20 archivos, se justifica por
escrito o se recorta.**

**La pregunta que decide un exceso:** *¿qué parte de esto seguiría existiendo si lo escribiera
alguien que ya conoce el deeplink `browse` de Phantom?* Respuesta de este SDD: el módulo puro
(~40 líneas de código real) y las cinco inserciones. **Todo lo demás son tests y el razonamiento que
este repo exige en sus docblocks.** Un exceso en `flow.tsx` en **líneas** es imposible por CD-W1-1;
un exceso en **caracteres** ahí sí es posible y **es lo que hay que mirar**.

⚠️ **Ratio esperada test/producción ≈ 3,5:1.** Es alta a propósito: el 70 % de esta ola es demostrar
que un recorrido que nadie corrió entero hace lo que decimos. Si el CR mide una ratio **más baja**,
la sospecha correcta es que faltan tests, no que sobra código.

---

## 10 · Missing Inputs de W1

| # | Qué falta | Estado | ¿Bloquea? |
|---|---|---|---|
| **MI-W1-1** | ¿El `localStorage` cruza del navegador común al de la billetera? | `[NO VERIFICADO]`. **Es pregunta nueva**, distinta de las cuatro de `solana-wallet.ts:894` (DT-W1-4) | **No bloquea W1.** El diseño contesta los dos casos y **mide** cuál ocurrió |
| **MI-W1-2** | ¿Qué hace el universal link `browse` si Phantom no está instalada? | `[NO VERIFICADO]`, la doc no lo dice `[MEDIDO-RED]` | **No bloquea.** DT-W1-5 no se apoya en eso: pone un segundo enlace |
| **MI-W1-3** | `MI-8` del work-item: restricciones de las guidelines de Apple para dApps en navegadores in-app | `[NO MEDIDO]`. Única fuente: un blog viejo de Trust Wallet, marcado sin verificar en el propio informe | **No bloquea W1** (no cambia el diseño). Se mide en W0, mismo teléfono |
| **MI-W1-4** | `MI-1`: si el camino inyectado tiene 3 o 4 firmas | **Pista fuerte hallada acá, y NO se cierra**: `pedir()` contesta `no-corresponde` (`solana-wallet.ts:2383`) y entonces el gateway pide la firma él mismo (`http-solana-prepare-gateway.ts:245`) `[MEDIDO-F2]` ⇒ **el PoP de payout sí ocurre en el camino inyectado**. ⛔ Cerrarlo exige ejecutar, y es `AC-0-4` de **W0** | **No bloquea W1**. Se pasa a W0 como pista con su cita |
| **MI-W1-5** | Nombre de rama | **RESUELTO acá**: `feat/wkh-372-w1-navegador-de-la-billetera`. Verificado con `/usr/bin/git branch -a` sobre las 136 ramas de `chaski-v3`: **no existe ninguna con `372` ni con `navegador`** `[MEDIDO-F2]` | No |
| **MI-W1-6** | El gate de `wasiai-facilitator` (`MI-5`) | **No aplica a W1**: esta ola no toca ese repo | No |

---

## 11 · Desviación declarada — necesita el ok del humano en `SPEC_APPROVED`

### 🔴 `D-W1-1` · `AC-1-2` no se puede cumplir **literalmente** en el recorrido de primera vez

**Lo que `AC-1-2` pide:** *«WHILE la app corre dentro del navegador de la billetera, the system SHALL
completar el envío entero con 0 saltos entre apps y 0 remontajes del árbol, y SHALL atravesar la
pantalla de entrada exactamente 1 vez.»*

**Lo que medí, y por qué la primera vez no puede dar eso:** el paso de identidad hace
`window.location.href = res.url` hacia el verificador — `flow.tsx:460` `[MEDIDO-F2]` —, y el propio
repo lo declara textual en `flow.tsx:235`: *«La vuelta de Didit es una RECARGA
(`window.location.href = res.url`, misma pestaña…)»* `[MEDIDO-F2]`. ⇒ dentro del navegador de la
billetera **eso sigue siendo un remonte del árbol**, y la vuelta aterriza en `bienvenida` con el
resume-loop llevándola a `confirm`, o sea **una segunda travesía**.

**Lo que sí se cumple, sin asteriscos:**
- **0 saltos a la app de la billetera** y **0 remontajes causados por una firma**: eso es lo que esta
  HU rediseña, y ahí el número es exacto.
- **El envío recurrente cumple `AC-1-2` al pie de la letra**: con KYC aprobado el atajo saltea
  `review` y `verify` (`flow.tsx:356-379`, `[HEREDADO: mapa §1]`) ⇒ no hay redirect, no hay remonte,
  y la pantalla de entrada se atraviesa una vez.

**Propuesta, para que el humano la acepte o la rechace** (⛔ no la aplico solo: el humano decide el
QUÉ):

> **`AC-1-2` se parte en dos y ninguna de las dos afloja el objetivo:**
> **`AC-1-2a`** — WHILE la app corre dentro del navegador de la billetera, the system SHALL completar
> el envío con **0 saltos a la app de la billetera** y **0 remontajes del árbol causados por una
> firma**.
> **`AC-1-2b`** — WHERE la persona ya tiene su identidad verificada, the system SHALL atravesar la
> pantalla de entrada **exactamente 1 vez**. IF la persona verifica su identidad en este envío, THEN
> la travesía adicional la causa el redirect del verificador (`flow.tsx:460`), que está **fuera del
> alcance de esta HU** (cambiar de proveedor de KYC es Scope OUT del work-item) y ya tiene su
> aterrizaje propio en la HU `074`.

⚠️ **Por qué no lo resuelvo yo y por qué no lo escondo:** cerrar `AC-1-2` con un test que sólo mire el
recorrido recurrente sería **el falso verde exacto** que este proyecto ya tiene documentado, y
cerrarlo con el recorrido de primera vez sería declarar FAIL una ola que hizo bien su trabajo.

---

## 12 · Readiness Check

| # | Criterio | Estado |
|---|---|---|
| 1 | Todos los exemplars verificados con lectura real (no `Glob` a ciegas) | ✅ 9 exemplars, todos abiertos con `sed`, todos con línea |
| 2 | Ningún path, símbolo o función inventado | ✅ Cada símbolo de §4 sale de una línea leída en esta sesión |
| 3 | El símbolo externo se verificó contra la versión vigente | ✅ La forma del deeplink `browse` se midió contra la doc viva hoy `[MEDIDO-RED]`, y coincide byte a byte con `wallet-availability.ts:27` |
| 4 | Los CD del work-item heredados | ✅ 8 vigentes (§5.1) + 12 nuevas (§5.2), 10 de ellas derivadas del Auto-Blindaje de las 3 últimas HUs |
| 5 | Un test por AC, con su mutante nombrado | ✅ 12 tests, 12 mutantes, y el falso KILLED a evitar en cada fila |
| 6 | Ningún guard que se lea a sí mismo | ✅ CD-W1-4 + las tres filas de §7 que lo declaran explícitamente (`T-372-W1-5/6/10`) |
| 7 | El gate del repo está nombrado **leyendo su `package.json`** | ✅ `npm run qa` = `lint && typecheck && typecheck:scripts && test` (`package.json:20`) + `npm run build` (`:10`) `[MEDIDO-F2]` |
| 8 | Escala del diff declarada, con el umbral del CR | ✅ §9: ≤ 900 añadidas / ≤ 10 archivos; umbral 2x = 1.800 |
| 9 | Waves con archivos exactos y orden justificado | ✅ §6, con W1.0 como premisa falsable que puede detener la ola |
| 10 | Riesgo de despliegue parcial | ✅ §8. W1 es cliente-only y aditiva; repliegue = revert |
| 11 | El flake preexistente declarado y **no** puesto en cuarentena | ✅ CD-W1-9, con el archivo y los dos `it` por nombre |
| 12 | Δ0 de `flow.tsx` con su instrumento | ✅ CD-W1-1, medido: `wc -l` da 4453, igual que el marcador de censo |
| 13 | Los 76 entrantes de `solana-wallet.ts:893` | ✅ **Protegidos por CD-W1-2: W1 toca 0 líneas de ese archivo.** §1.1 corrige la premisa del work-item |
| 14 | Missing Inputs declarados, y ninguno bloquea W1 | ✅ §10. Los 4 abiertos son de W0 o no cambian el diseño |
| 15 | `[NEEDS CLARIFICATION]` sin resolver | ⚠️ **UNO, declarado y escalado**: `D-W1-1` (§11). No bloquea escribir el Story File; **sí** necesita el ok del humano en el gate |

**Veredicto:** ✅ **Listo para `SPEC_APPROVED`**, con la desviación `D-W1-1` sobre la mesa. Si el
humano la rechaza, cambia **un AC y sus dos tests** (`T-372-W1-3` y el conteo de travesías); no
cambia ni un archivo del diseño.

---

*SDD · F2 · ola **W1** de WKH-372 · 2026-08-31 · NexusAgil Architect · con shell, sobre `chaski-v3@cc02b61`*
