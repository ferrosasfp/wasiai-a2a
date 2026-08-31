# Auto-Blindaje · WKH-372 · ola W1

Cada entrada es un error que **cometí yo** durante la implementación, con su causa raíz y dónde más
puede volver a pasar. No es teoría: todos se descubrieron corriendo algo.

---

### [2026-08-31 13:55] W1.0 — El fixture del camino por enlace nunca reprodujo el caso, y el mutante SOBREVIVIÓ

- **Error**: sembré la elección de billetera con
  `localStorage.setItem(CLAVE_ELECCION, JSON.stringify({ billetera: "phantom" }))`. Con esa siembra,
  `T-372-W1-3` y `T-372-W1-4` daban verde **con el gate de disponibilidad sano y con el gate
  invertido**: `6 passed (6)` en las dos corridas. Dos `it` que decían medir el gate no medían nada.
- **Causa raíz**: `guardarEleccion` (`conexion.ts:170`) escribe el valor **crudo** (`"phantom"`), y
  `leerEleccion` (`:149`) valida contra el conjunto cerrado `"phantom" | "solflare"`. Un JSON sale
  `null` de esa validación ⇒ `caminoPorEnlace()` contestaba `null` **por el disco**, no por la
  disponibilidad. Escribí la forma del dato **de memoria** en vez de leer al escritor real.
- **Fix**: `localStorage.setItem(CLAVE_ELECCION, "phantom")`, con el motivo y la medición escritos en
  el docblock de `sembrarElCaminoPorEnlace`. Con el fixture corregido, M1 mata los tres `it`.
- **Aplicar en**: **toda** siembra de `localStorage` / almacén persistido. La regla: la forma del dato
  se lee del **escritor de producción**, nunca se infiere del nombre de la clave. Y el único modo de
  saber que la siembra funcionó es **correr el mutante**: un fixture que no reproduce el defecto es
  indistinguible de un guard que funciona.

---

### [2026-08-31 13:56] W1.0 — Leí un rojo como «la premisa es falsa» cuando era mi entorno

- **Error**: `T-372-W1-4` salió rojo con `Unable to find a viable program address nonce`. Ese `it` es
  uno de los 5 puntos de la premisa de W1.0, y un rojo ahí **detiene la ola**. Estuve a un paso de
  reportarlo como hallazgo.
- **Causa raíz**: bajo `jsdom` en este repo, `Buffer.from(x) instanceof Uint8Array` es **false**
  (jsdom instala su propio `Uint8Array` en el realm global y el `Buffer` de Node viene de otro). ⇒
  `createProgramAddressSync` rechaza con «Uint8Array expected», `isOnCurve` contesta `true` para
  **todo**, `findProgramAddressSync` agota los 255 bumps y tira. O sea: `authorizePrincipal` es
  **inalcanzable desde jsdom**, y eso no dice nada del gate de disponibilidad.
- **Fix**: sonda de tres líneas (creada, corrida y borrada) que midió el mismo `findProgramAddressSync`
  bajo `jsdom` (rojo) y bajo `node` (verde), y después midió cuál de los dos predicados fallaba. Se
  alinea el realm con `vi.stubGlobal("Uint8Array", …)` **sólo en el `it` que lo necesita**, con la
  medición escrita al lado. Es reparación del **entorno**, no del sujeto: con la línea puesta, el
  mutante del gate sigue matando el `it`.
- **Aplicar en**: cualquier `it` de `jsdom` que toque `@solana/web3.js`, `@noble/*`, `tweetnacl` o
  cualquier librería que valide con `instanceof Uint8Array`. Este repo ya tenía la lección escrita
  para `tweetnacl` (`flow-reanudacion.test.tsx:1330`) y no la generalicé. **Antes de leer un rojo como
  un hallazgo del sujeto, medí si el rojo lo produce el entorno**: la sonda cuesta dos minutos y la
  conclusión falsa cuesta una ola.

---

### [2026-08-31 13:58] W1.0 — Un `sed` que matcheaba DOS sitios: el mutante no se aplicó y la suite dio verde

- **Error**: intenté aplicar el mutante M2 (sacar `this.firmaPorEnlace &&` del bloque del nonce) con
  un reemplazo por texto. El patrón aparece en **dos** líneas de `solana-wallet.ts` (`:769` y `:897`).
- **Causa raíz**: usé un patrón sin verificar su unicidad. Si el script hubiera reemplazado los dos,
  habría medido otro mutante; si no reemplazaba ninguno, la suite verde se habría leído como
  «el mutante sobrevivió».
- **Fix**: el aplicador aborta con `exit 2` cuando el patrón no aparece **exactamente una vez**, y
  **verifica en disco** que la edición quedó antes de correr nada. El mutante se aplicó por número de
  línea y se confirmó con `sed -n '769p'` y `sed -n '897p'` **antes** de la corrida.
- **Aplicar en**: todo barrido de mutación. **Un mutante que no matcheó más una suite verde son
  indistinguibles de un control que funciona.** La verificación en disco va SIEMPRE antes de correr, y
  el restore se cierra con `md5sum` en las dos puntas.

---

### [2026-08-31 14:07] W1.0 — Escribí cuatro citas ancladas sin derivar ninguna, y las cuatro apuntaban mal

- **Error**: `citas-ancladas.test.ts` reportó 4 citas rotas mías: `espiarNavegacion` decía `:1296` (es
  `:1294`), `inyectarWallet` decía `:77` (es `:72`), `IR_A_POP_KYC` decía `:1322` (es `:1330`), y
  `leerEleccion` decía `` `:149` `` **sin ruta**, así que el ancla caía en la línea 149 de mi propio
  archivo.
- **Causa raíz**: escribí las cuatro **de memoria mientras redactaba el docblock**, en vez de
  derivarlas con `grep -n` después de la última edición. Es exactamente CD-W1-3, y es el error
  recurrente en 3 de 3 auto-blindajes previos.
- **Fix**: las cuatro re-derivadas con `/usr/bin/grep -n` y corregidas. La cita sin ruta es un modo de
  falla propio y peor que las otras tres: **una cita a `` `:NN` `` sin ruta apunta al archivo que la
  escribe**, así que puede dar verde por accidente si esa línea contiene el símbolo.
- **Aplicar en**: cada cita nueva. Y la vuelta de tuerca que faltaba: el candado sólo mira las citas
  **ancladas**; una cita suelta rota no la mira nadie.

---

### [2026-08-31 14:07] W1.0 — Una cita anclada mía habría obligado a editar un archivo PROHIBIDO

- **Error**: escribí `` (`caminoPorEnlace`, `../infrastructure/solana-wallet.ts:2240`) ``. Esa sola
  cita corrió **cinco** marcadores `[[CENSO …]]` de `solana-wallet.ts` (`entrantes` 127→128,
  `destinos` 68→69, `entrantes-desde-893` 76→77, `entrantes-desde-906` 76→77,
  `entrantes-desde-1233` 60→61) y puso rojo el candado anti-drift.
- **Causa raíz**: no vi que **una cita ANCLADA es una escritura sobre el archivo destino**, aunque el
  archivo destino no se toque. Actualizar esos marcadores exige editar `solana-wallet.ts`, que CD-W1-2
  prohíbe en esta ola con cero líneas.
- **Fix**: la cita va **sin ancla** (`` `caminoPorEnlace` (`solana-wallet.ts:2240`) ``, sin la coma
  entre backticks que la convierte en anclada), con el motivo escrito al lado para que nadie la
  "arregle" anclándola.
- **Aplicar en**: cualquier HU con un archivo en Scope OUT que lleve marcadores de censo. **Antes de
  anclar una cita, preguntá si el destino tiene `[[CENSO … entrantes]]`**: si lo tiene, anclarla es
  editarlo.

---

### [2026-08-31 14:04] W1.0 — El mutante que la especificación nombraba NO puede aislar a su `it`

- **Error**: el story file asigna a `T-372-W1-11` el mutante «renombrar `nonce-duradero.ts` en un
  worktree». Lo corrí: el archivo entero colapsa en `0 test` con
  `Failed to resolve import "./solana/nonce-duradero" from "src/infrastructure/solana-wallet.ts"`.
  **No hay ningún `×` nombrado.**
- **Causa raíz**: mi `it` vive en un archivo cuyo grafo de imports **incluye los módulos que el `it`
  vigila**. Borrar uno rompe la carga antes de que corra ninguna aserción. Un rojo así es
  indistinguible de un error de sintaxis (CD-W1-5) y **no cuenta como KILLED**.
- **Fix**: (1) se declara el hallazgo en el propio docblock del `it` en vez de presentar el rojo como
  un kill; (2) se agrega un **control negativo** que exige que los dos predicados (`existsSync` y el
  listado de la carpeta) sepan contestar que **NO** — sin eso, la mitad (a) del `it` era decorativa;
  (3) se corre un mutante que **sí** aísla la otra mitad (apagar el selector de enlace en `flow.tsx`),
  y ése mata sólo a este `it`.
- **Aplicar en**: todo guard de existencia de archivos. Si el guard vive en un archivo que importa lo
  que vigila, su mutante natural lo mata **por colapso** y nunca por aserción. La pregunta previa es:
  *¿qué otro control podría estar matando a este mutante?* — acá la respuesta era «el resolvedor de
  módulos», que no es un control.

---

### [2026-08-31 14:20] W1.2 — El import que sólo `lint` ve, y el copy que un guard viejo frenó

- **Error**: dos, en la misma edición. (1) `phantomBrowseUrl` quedó **sin llamador** en `flow.tsx` al
  envolverlo el módulo nuevo: `tsc --noEmit` y `vitest` pasaron los dos en verde, y el único que lo
  cazó fue `biome lint`, que es el **primer** paso del gate. (2) escribí *«¿No tenés Phantom?»* en la
  nota al pie de `NoWalletHere` y `T-UI-2` se puso rojo.
- **Causa raíz**: (1) haber corrido `tsc` y los tests del archivo y haber leído eso como «verde». (2)
  no haber leído los guards del archivo que estaba editando: `T-UI-2` prohíbe que esa pantalla afirme
  nada sobre lo que hay instalado en el dispositivo, porque alguien con Phantom en el celular mirando
  esto en Chrome leería una mentira.
- **Fix**: (1) el símbolo se sacó del import, en la misma línea física (Δ0). (2) el enlace quedó como
  oferta pura: *«Instalar Phantom y crear mi billetera»*.
- **Aplicar en**: **correr las partes de un gate no es correr el gate**, y `lint` va primero
  justamente porque es el eslabón al que nadie llega. Y antes de escribir copy en una pantalla,
  leer qué guards la vigilan: acá el guard tenía razón y yo no.

---

### [2026-08-31 14:22] W1.2 — Un test VERDE que estaba congelando el defecto que la ola vino a arreglar

- **Error**: `T-LINK-1` se puso rojo al arreglar la limpieza del href. Mi primera lectura fue «rompí
  un test».
- **Causa raíz**: el `it` afirmaba, con un literal escrito a mano, que el `?kyc=return` **viaja** al
  navegador de Phantom. Y viajaba: `NoWalletHere` tomaba `window.location.href` crudo. O sea que el
  test **no estaba mal escrito: medía bien un comportamiento equivocado**, y por eso su verde no
  protegía nada. Del otro lado ese parámetro arranca a retomar un trámite que en ese almacenamiento
  no existe.
- **Fix**: el `it` pasó a medir **tres** propiedades (el encodeado sigue entero, el rastro del origen
  no viaja, y la marca `wb=1` sí viaja), con la explicación de por qué su expectativa anterior era la
  del defecto.
- **Aplicar en**: cuando una métrica **empeora al arreglar un bug**, la pregunta no es «¿qué rompí?»
  sino **«¿qué otro defecto estaba compensando este verde?»**. Un test que pinnea el comportamiento
  actual congela lo que haya, bug incluido.

---

### [2026-08-31 14:35] W1.3 — Escribí un renglón de diagnóstico que nadie miraba

- **Error**: agregué el quinto hito y su renglón en el bloque de `?diag=1`. Corrí el mutante «borrar
  el renglón» y **la suite entera quedó en verde**: `36 passed` en `diagnostico-de-vuelta.test.tsx` y
  `39 passed` en el archivo de pantalla.
- **Causa raíz**: di por hecho que el renglón estaba cubierto porque el HITO sí lo estaba. Son dos
  cosas distintas: el hito tenía asertos, el renglón que lo publica no tenía ninguno.
- **Fix**: `T-372-W1-7b`, que monta el bloque real (en producción cuelga de `app/page.tsx`, no del
  flujo) y lee el veredicto. Con él puesto, el mutante lo mata con una aserción nombrada.
- **Aplicar en**: **un artefacto sin control no es un instrumento.** Antes de dar por cubierta una
  pieza nueva, correr el mutante que la borra. Y el corolario que apareció solo: `T-DIAG-CAPTURA` —
  que pinnea el texto EXACTO del bloque — sí se puso rojo, y por eso el renglón no pudo entrar en
  silencio. Ese es el guard que ya existía haciendo su trabajo.

---

### [2026-08-31 14:40] W1.3 — 🔴 MI PROPIO RESTAURADOR DE MUTANTES REVIRTIÓ UNA OLA ENTERA, EN SILENCIO

- **Error**: después de correr el mutante M16, `npm run qa` dio rojo en dos `it` que minutos antes
  pasaban. Perdí una vuelta entera buscando contaminación entre archivos y carreras de `useEffect`.
  La causa era otra: **el `restore` de mi propio arnés había borrado las tres ediciones de W1.3 sobre
  `flow.tsx`**.
- **Causa raíz**: el arnés guardaba el original con `if not orig.exists(): copy(...)`. Ese `.orig` se
  había capturado en el mutante **M10**, o sea **antes** de las ediciones de W1.3. Cada `apply`
  posterior lo reusó, y el `restore` de M16 dejó el archivo en el estado de M10. El `md5` coincidía
  perfecto contra el `.orig` **equivocado**, así que la verificación que yo había puesto para
  protegerme **confirmó el revert en vez de cazarlo**.
- **Fix**: el `.orig` se **refresca en cada `apply`** y el `restore` lo **borra**, para que no pueda
  sobrevivir a la edición siguiente. Las tres ediciones se re-aplicaron y se re-corrieron los
  mutantes.
- **Aplicar en**: cualquier arnés de mutación. **Un `md5` que compara contra el snapshot equivocado no
  es una verificación: es una confirmación de que el revert salió limpio.** El control correcto es
  contra el árbol de git (`git diff --numstat`), que es la única referencia que no fabrico yo.
  Síntoma para reconocerlo rápido: *«pasaba hace diez minutos y ahora no, sin que yo tocara eso»* ⇒
  antes de investigar el test, mirar si el archivo de producción sigue teniendo lo que uno escribió.

---

### [2026-08-31 14:55] W1.4 — Rompí con mi propia edición tres citas que yo mismo había derivado bien

- **Error**: `T-H1-3` (`:956`), `T-065-20` (`:1002`) y `T-065-21` (`:1018`) estaban **correctas
  cuando las escribí** y apuntaban mal al cerrar la ola.
- **Causa raíz**: mi reescritura de `T-LINK-1` en ese mismo archivo agregó líneas **más arriba** y
  corrió todo lo de abajo. Las tres citas eran **sueltas**, no ancladas, así que
  `citas-ancladas.test.ts` no las mira: su perímetro es opt-in.
- **Fix**: re-derivadas con `grep -n` **después de la última edición**, y verificadas leyendo la línea
  destino.
- **Aplicar en**: derivar una cita bien **no alcanza**: hay que re-derivarla al final, y sobre todo
  cuando uno editó el archivo destino en el medio. El verde del candado de citas **no significa que
  las citas del repo estén bien**: significa que las que alguien decidió anclar están bien.

---

### [2026-08-31 15:35] Fix-pack AR/W1 — La puerta PRINCIPAL de la ola no tenía guard sobre su `href`

- **Error**: `T-372-W1-1` (`wallet-availability.test.tsx`) assertaba **sólo el `hostname`** del enlace
  de la oferta (`flow.tsx:757`). El AR lo midió: revirtiendo esa expresión al enlace crudo previo a W1
  —o sea reintroduciendo el defecto que la ola dice cerrar, el `?kyc=return` viajando al navegador de
  la billetera— la suite entera quedaba en **`exit 0`, 3420 passed**.
- **Causa raíz**: el arreglo estaba vigilado en el enlace **secundario** (`NoWalletHere`, `:1379`, por
  `T-LINK-1`), y al escribir la **segunda instancia de la misma expresión** en `:757` di por cubierta
  la propiedad porque "ya la mide un test". Un test del vecino no es un test de la pieza nueva.
- **Fix**: `T-372-W1-1` ahora **desarma** el universal link (`hrefQueLaBilleteraVaAAbrir`, mudado a
  `src/test-support/salida-al-navegador.ts` para que exista **una sola** copia del decodificado) y,
  con la URL de origen sembrada como `?monto=400&kyc=return`, asserta que `kyc` **no** viaja y que
  `monto` **sí**. La segunda fila es la que lo hace falsable: sin ella, un `href` que vaciara la URL
  entera pasaría igual.
- **Aplicar en**: cada vez que una ola escriba una **segunda instancia** de una expresión ya
  vigilada. La pregunta no es *¿esta propiedad está medida en algún lado?* sino **¿qué mutante sobre
  ESTA línea pone algo rojo?** Y se contesta aplicándolo, no leyéndolo: acá el `hostname` daba una
  sensación de cobertura y no cubría nada de lo que la ola cambió.

---

### [2026-08-31 15:35] Fix-pack AR/W1 — «Este `it` es su único guard»: medido ANTES de actualizar al vecino

- **Error**: el docblock de `T-372-W1-7b` afirmaba que era el **único** guard del renglón del bloque
  de diagnóstico. Falso: MUT-D (borrar el renglón de `diagnostico-de-vuelta.tsx:589`) mata **dos**,
  `T-372-W1-7b` y `T-DIAG-CAPTURA`.
- **Causa raíz**: la medición que sostenía la frase se tomó **antes** de actualizar el valor esperado
  de `T-DIAG-CAPTURA` (cuando el bloque tenía catorce renglones y borrar el decimoquinto no tocaba
  nada). Después de actualizarlo, la frase quedó falsa y **nadie la re-midió**: es exactamente la
  clase que CD-W1-10 persigue, la frase corregida que sigue siendo falsa.
- **Fix**: frase reescrita a *«éste es su guard DEDICADO; `T-DIAG-CAPTURA` lo cubre de rebote por
  pinneo del texto»*, **re-corriendo MUT-D antes de escribirla**: `2 failed | 75 passed`, con el `×`
  de los dos. Y se dejó escrito qué aporta cada uno (aquél anota los hitos a mano y espera
  `no corrió`; éste monta `RemittanceFlow` y es el único que mide que el renglón diga lo que el
  aterrizaje midió).
- **Aplicar en**: toda afirmación de EXCLUSIVIDAD («el único», «nadie más», «sólo éste»). Envejece
  con el commit siguiente y su verificación no es leer: es volver a correr el mutante **después** de
  la última edición del árbol.

---

### [2026-08-31 15:35] Fix-pack AR/W1 — Dos lecturas de la misma marca, y un aviso sin gate de pantalla

- **Error**: (a) `flow.tsx:146` capturaba `aterrizaje.vinoConMarca` una vez y `:757` **recalculaba**
  el mismo predicado en cada render, contra el principio que el docblock de `:146` declara para el
  disco. (b) el aviso de aterrizaje no tenía gate de `step`, así que con `?wb=1` y disco vacío seguía
  pintado en `send`, `history` y `recuperar`.
- **Causa raíz**: (a) el estado `aterrizaje` nació para el disco y la marca se le sumó después, sin
  volver a mirar quién más leía la URL. (b) implementé el contrato I-2(b) del story file **al pie de
  la letra** (tres condiciones) sin notar que el vecino de la misma línea llevaba seis, y que la
  primera de ellas valía igual acá.
- **Fix**: `:757` consume `aterrizaje.vinoConMarca` y suma `step === "bienvenida"`. ⚠️ **Esto cambia
  el contrato I-2(b) del story file**: son CUATRO condiciones, no tres. Autoría del cambio:
  **orquestador, en el gate del AR** (AR/MNR-4). Guard nuevo `T-372-W1-7c` con su mutante.
- **Aplicar en**: cuando una foto de estado se toma una vez, buscar **todos** sus consumidores antes
  de cerrar (`grep` del predicado, no del nombre de la variable). Y cuando un bloque nuevo se pega al
  lado de uno viejo en la misma línea, **leer las condiciones del vecino**: una lista de condiciones
  que no coincide con la de al lado es un hallazgo o una decisión, nunca un accidente.

---

### [2026-08-31 15:35] Fix-pack AR/W1 — La declaración de escala explicaba 37 de 662 líneas de exceso

- **Error**: la justificación del volumen de W1 nombraba `bitacora-de-vuelta.ts` (+29) y
  `diagnostico-de-vuelta.test.tsx` (+8), o sea **37 de las 662 líneas de exceso** que el AR midió. Los
  dos overruns grandes no estaban nombrados.
- **Causa raíz**: se justificó lo que era **fácil de explicar** (dos ítems chicos con una razón
  redonda cada uno) en vez de lo que **movía el número**.
- **Fix — los dos archivos que hay que nombrar en el cierre, con las cifras RE-DERIVADAS después del
  fix-pack** (`git diff --numstat --cached cc02b61`, no copiadas del AR):

  ⚠️ Las dos últimas columnas son la foto **al `e9d6892`**, no "hoy": decían "hoy" y eso envejece con
  el commit siguiente, que es exactamente lo que pasó (ver la entrada del fix-pack 2, más abajo, con
  las cifras re-derivadas al commit nuevo).

  | Archivo | Presupuesto | Añadidas al 550bf33 (AR) | Añadidas al e9d6892 | Exceso al e9d6892 |
  |---|---:|---:|---:|---:|
  | `src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx` | ≤420 | 768 | **768** | **+348** |
  | `src/presentation/wallet-availability.test.tsx` | ≤120 | 229 | **330** | **+210** |
  | `src/presentation/bitacora-de-vuelta.ts` | +8 | 37 | 37 | +29 |
  | `src/presentation/diagnostico-de-vuelta.test.tsx` | (no presupuestado) | 8 | 8 | +8 |
  | `src/test-support/salida-al-navegador.ts` | (no presupuestado) | — (no existía) | 22 | +22 |

  🔴 **LA QUINTA FILA FALTABA, y es el archivo que el fix-pack ANTERIOR creó** (AR-it2/`MNR-B`): la
  tabla se armó nombrando los overruns y se olvidó del archivo nuevo. Con él, el diff toca **11
  archivos** contra un presupuesto de **≤10** (`story-W1.md:764`). **El 11.º es
  `src/test-support/salida-al-navegador.ts`**, y está declarado: existe porque el desarmado del
  universal link lo necesitan DOS suites y importar un `*.test.ts` desde otro archivo de tests
  registraría sus `it` en la suite que importa. Ninguno de los umbrales de escalado del check 7 se
  cruza (1.800 líneas / 20 archivos), así que el exceso de archivos es **de forma** y queda dicho acá.

  ⚠️ **Y UNA CORRECCIÓN A LA CONSIGNA, porque el número no se pudo reproducir.** El gate del AR pidió
  nombrar *«los dos archivos que causan el 96 % del exceso»*. **Ese 96 % no se deriva** de la tabla del
  AR: sus cuatro excesos suman 494 y el total declarado es 662, así que los dos grandes son
  **348 + 109 = 457 de 662 ⇒ 69 %** al 550bf33, y **348 + 210 = 558 de 782 ⇒ 71 %** al `e9d6892`.
  🔴 **ACÁ DECÍA `558 de 795 ⇒ 70 %` Y ESE 795 NO RE-DERIVA** (AR-it2/`BLQ-MED-1`). El denominador se
  había calculado como `662 + 133`, sumando las líneas **añadidas** por el fix-pack a un exceso ya
  calculado, sin descontar que 13 de esas 133 **reemplazaron** líneas que el AR ya contaba
  (`salida-…test.ts` va 157→154). El correcto, re-derivado con `git diff --numstat cc02b61 e9d6892`
  delante de quien lee: **total añadidas 1472** menos el presupuesto de la tabla de `story-W1.md:762`
  (**~690**) ⇒ **exceso 782**; y `348 + 210 = 558`, o sea **558 ÷ 782 = 0,7136 ⇒ 71 %**.
  Lo que **sí** se deriva del árbol, y es la frase que conviene llevar al cierre:
  **los dos archivos aportan 1098 de las 1472 líneas que la ola agregó en total, o sea el 74,6 %.**
  Escribir "96 %" habría sido repetir el defecto que este mismo hallazgo persigue una capa más arriba.
- **La sustancia, que sigue en pie**: los dos grandes son **exceso de TESTS**, no de producción (la
  producción de la ola es Δ0 en `flow.tsx`, +1 renglón en el diagnóstico y un módulo puro nuevo de 141
  líneas). Contra los tests de la ola murieron mutantes con `×` nombrado en cada caso: los **7** que el
  AR re-aplicó, más **MUT-I** y **MUT-J** de este fix-pack. Y el total añadido —**1472**— queda bajo el
  disparador de 1.800. Exceso defendible en contenido, mal declarado en la forma.
- **Aplicar en**: la declaración de escala se **ordena por exceso descendente** y se justifica de
  arriba hacia abajo. Y **el porcentaje se deriva delante de quien lo lee**: una justificación que
  arranca por el ítem más chico está eligiendo el que tiene mejor excusa, y un porcentaje heredado sin
  re-derivar es el mismo defecto con otro autor.

---

### [2026-08-31 16:05] Fix-pack 2 (re-AR it2) — Cerré UNA de las dos propiedades de la misma expresión

- **Error**: el `href` de la oferta (`flow.tsx:757`) es UNA expresión con **dos** propiedades —qué
  parámetros lleva y si lleva la marca `?wb=1`— y el fix-pack anterior cerró la primera y dio la
  expresión por cubierta. **MUT-L** del revisor (`hayBorrador: rem !== null` → `hayBorrador: false`)
  daba `EXIT=0` con `167 passed / 3421 passed`: se podía apagar en silencio el desenlace
  `con-marca-sin-borrador` entero, que es el que la ola construyó para avisarle a la persona que sus
  datos no cruzaron.
- **Causa raíz**: escribí el guard contra **el mutante que el AR nombró** (MUT-I, el enlace crudo) en
  vez de contra **la expresión**. Un `it` que mata el mutante del reporte no cubre la línea: cubre ese
  mutante. La pregunta que faltó fue *«¿cuántas cosas distintas decide esta expresión?»*, y eran dos.
- **Fix**: `T-372-W1-1b` (`wallet-availability.test.tsx:1341`) monta la oferta **con una remesa
  cargada** y asserta que el enlace lleva `PARAM_SALIDA`/`VALOR_SALIDA` (importados, no escritos), y
  `T-372-W1-1` suma la **mitad negativa** (sin borrador, la marca NO viaja). Los dos mutantes, contra
  la **suite completa**, cada uno con **un solo `×`**:
  · **MUT-L** (`hayBorrador: false`) ⇒ `1 failed | 3421 passed`, `× T-372-W1-1b` —
  *«el enlace de la oferta cruza SIN la marca de salida habiendo una remesa cargada… expected null to
  be '1'»*. `T-LINK-1`, que mide la MISMA prop en el otro enlace, queda **verde** ⇒ no es falso KILLED.
  · **MUT-M** (`hayBorrador: true`) ⇒ `1 failed | 3421 passed`, `× T-372-W1-1` —
  *«la marca de salida viaja sin que haya nada cargado… expected '1' to be null»*.
  Sin la mitad negativa, `true` clavado pasaba los dos `it` y la prop volvía a no decir nada.
- **Y lo que el fixture midió de paso, que el AR declaró NO haber medido**: `step === "bienvenida"`
  con `rem !== null` **es alcanzable**, y por un solo camino de producción — la card del fin del
  resume (`flow.tsx:794` ⇒ `:4391`) es la única entrada a un destino que no toca `rem`; las otras tres
  (`:587`, `:807`, `:1186`) no pueden traerla. El fixture recorre ese camino entero en vez de
  inyectar estado, así que la alcanzabilidad **se ejecuta, no se lee**.
- **Aplicar en**: cuando un hallazgo nombra un mutante, cerrar la **expresión**, no el mutante:
  contar cuántas decisiones toma y exigir un `×` nombrado por cada una, con su mitad negativa. Un
  guard que mata sólo el mutante del reporte deja las otras mitades libres, y el siguiente revisor
  las encuentra con un mutante propio en cinco minutos.

---

### [2026-08-31 16:05] Fix-pack 2 (re-AR it2) — Un denominador publicado que no re-derivaba, dentro del hallazgo que persigue eso mismo

- **Error**: `auto-blindaje.md` publicaba *«348 + 210 = 558 de **795** ⇒ 70 %»*. El 795 salió de
  `662 + 133`: le sumé al exceso ya calculado por el AR las líneas **añadidas** por el fix-pack, sin
  descontar que 13 de ellas **reemplazaron** líneas que el AR ya contaba (`salida-…test.ts` va
  157→154). El correcto es `662 + 120 = 782` ⇒ **71 %**.
- **Causa raíz**: **sumé deltas en vez de re-medir el árbol.** La entrada de al lado dice, textual,
  *«el porcentaje se deriva delante de quien lo lee»* — y el paso intermedio de esa misma entrada se
  escribió aritméticamente, sin volver a correr `git diff --numstat`. Una lección declarada no se
  aplica sola a la línea de abajo.
- **Fix**: re-derivado y re-escrito con la cuenta a la vista: `git diff --numstat cc02b61 e9d6892`
  ⇒ **1472 añadidas**; presupuesto de `story-W1.md:762` **~690** ⇒ exceso **782**; `558 ÷ 782 = 0,7136`
  ⇒ **71 %**. Y las cifras **al commit de ESTE fix-pack**, re-medidas igual, no arrastradas:

  | Medición (`git diff --numstat cc02b61 <commit>`) | Al `e9d6892` | Al `2ad4698` (fix-pack 2) |
  |---|---:|---:|
  | Total añadidas | 1472 | **1569** |
  | Archivos tocados | 11 | **11** |
  | `wallet-availability.test.tsx` añadidas | 330 | **427** |
  | Exceso sobre el presupuesto de la tabla (~690) | 782 | **879** |
  | Los dos archivos grandes, sobre el total añadido | 1098/1472 = 74,6 % | **1195/1569 = 76,2 %** |

  El total sigue **bajo el disparador de 1.800 líneas / 20 archivos** del check 7. Contra el
  presupuesto declarado de `story-W1.md:764` (**≤900**), 1569 es **1,74x**: por debajo del 2x que
  obliga a recortar o justificar por escrito, y aun así queda justificado — este fix-pack son
  **+98 / −1 líneas (97 netas) en un solo archivo de tests**, o sea **un `it` y su razonamiento**, con
  cero producción (`flow.tsx` sigue en Δ0: `numstat 9/9`, `wc -l` 4453).
- **Aplicar en**: un número que se publica se **re-mide contra el árbol**, nunca se obtiene sumándole
  un delta a un número anterior: las líneas reemplazadas se cuentan dos veces y el error es invisible
  porque el resultado *parece* razonable. Y toda cifra que se publique lleva **a qué commit** pertenece
  en su propio encabezado: "hoy" envejece con el commit siguiente.

---

### [2026-08-31 16:05] Fix-pack 2 (re-AR it2) — Un `it` en plural que medía una sola pantalla

- **Error**: `T-372-W1-7c` se llamaba *«no se cuela en los destinos»* (plural) y mide **uno**
  (`recuperar`). El docblock justificaba por qué no `history` —verdadero y verificado— y no decía
  **nada** de `send`, que sí se pinta.
- **Causa raíz**: el título se escribió describiendo **el defecto** (que aparecía en tres pantallas) y
  no **la medición** (una). Un título en plural con un fixture en singular es una afirmación sin
  testigo, y encima invisible: nadie lee el título contra el cuerpo.
- **Fix**: el `it` se llama ahora *«…y no se cuela en «recuperar»»* —nombra la pantalla que mide— y el
  docblock declara explícitamente que **`send` no se mide acá**, con el motivo (no es un `Destino`,
  `barra-destinos.tsx:25`) y sin afirmar nada sobre él. Re-corrido el mutante de su AC (quitar
  `step === "bienvenida" &&` de `flow.tsx:757`) contra la **suite completa** DESPUÉS del renombre:
  `1 failed | 3421 passed`, `× T-372-W1-7c` — *«el aviso del aterrizaje quedó clavado arriba de una
  pantalla de destino…»*. El renombre no lo desacopló.
- **Aplicar en**: el título de un `it` se lee como una afirmación, así que se escribe con el mismo
  criterio que un assert: **plural sólo si el fixture recorre el plural**. Y lo que queda sin medir se
  dice en el docblock, aunque el motivo sea bueno.
