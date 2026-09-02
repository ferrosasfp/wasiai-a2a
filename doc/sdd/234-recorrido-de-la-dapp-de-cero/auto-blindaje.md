# Auto-Blindaje · WKH-374 · ola W0

### [2026-09-01 16:40] Wave 0 — Un `import` nuevo arriba del archivo A rompe 5 citas ancladas
- **Error**: iba a agregar `import { urlConectar } from "…/protocol"` al bloque de imports del archivo
  extendido (`src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx`).
- **Causa raíz**: `CD-W0-11` del Story File dice «los `it` nuevos van AL FINAL», y lo leí como si el
  riesgo fuera sólo dónde va el `it`. Los **imports** también corren líneas, y
  `sesion-borra-la-segunda-firma.test.tsx` cita ANCLADO cinco símbolos de la mitad de arriba de ese
  archivo (`:113`, `:129`, `:149`, `:156`, `:168` de aquél → `:115`, `:149`, `:226`, `:294`, `:262`
  de éste). Un solo `import` arriba las rompe a las cinco.
- **Fix**: cero imports nuevos. Lo que hacía falta entra por `await import(...)` DENTRO del `it`, que
  es el recurso que ese mismo archivo ya usa en `:151` para `./solana/solana-providers`. Verificado
  con `git diff -U0`: **un solo hunk, `@@ -768,0 +769,231 @@`** ⇒ ninguna línea existente se movió.
- **Aplicar en**: todo archivo que sea DESTINO de citas ancladas. Antes de extenderlo, correr
  `/usr/bin/grep -rn "<basename>" src/ app/ scripts/ contracts/` y mirar si alguien lo cita por
  número. «Agregar al final» ⛔ no incluye los imports.

### [2026-09-01 16:43] Wave 0 — Un `fetch` stub demasiado ancho reventó la pantalla y parecía un bug del sujeto
- **Error**: stubeé `fetch` para que devolviera SIEMPRE el JSON del desafío de posesión. El recorrido
  murió con `TypeError: Cannot read properties of undefined (reading 'map')` en `flow.tsx:2859`.
- **Causa raíz**: la pantalla de revisión también hace `fetch("/api/a2a/plan")`. Con el stub ancho,
  el catálogo de agentes recibió un cuerpo sin `steps` y el componente reventó. Es un rojo del ARNÉS
  que se lee como un rojo del sujeto (lección **J**, medida otra vez).
- **Fix**: el stub contesta **sólo** `/api/a2a/payout/challenge` y devuelve 500 para el resto, que es
  el camino que la pantalla ya sabe degradar («No pudimos consultar el catálogo ahora»). Está escrito
  en el docblock del `it` con el mensaje de error exacto, para que nadie lo vuelva a ensanchar.
- **Aplicar en**: todo `vi.stubGlobal("fetch", …)` en un test que monte `<RemittanceFlow/>`.

### [2026-09-01 16:49] Wave 0 — Un `findBy*` DENTRO de `act()` se traba y muestra la pantalla anterior
- **Error**: `await act(async () => { fireEvent.click(await screen.findByRole(...)) })`. El `it` murió
  por timeout mostrando el paso `send`, y lo leí como «la pantalla no ofrece el salto».
- **Causa raíz**: el sondeo de `findBy*` y el `act` se traban; el árbol nunca re-renderiza. El rojo
  no dice nada del sujeto.
- **Fix**: el `findBy*` va AFUERA del `act`; adentro va sólo el `fireEvent`. Queda escrito con su
  motivo al lado del código.
- **Aplicar en**: todo `act(async () => …)` de este repo que adentro espere un elemento.

### [2026-09-01 16:55] Wave 0 — Mi propio control negativo estaba mal escrito, y él mismo lo cazó
- **Error**: el control negativo del barrido de W0-3 usaba líneas sintéticas con `r.push("/x")`
  cuando el patrón vigilado es `router.push`. El barrido no las cazó.
- **Causa raíz**: escribí el fixture por lo que SIGNIFICA («un push de router») y no por el literal
  que el instrumento busca.
- **Fix**: el fixture usa el literal exacto. Y el hallazgo se queda: **el control negativo es lo único
  que separó «el árbol está limpio» de «el barrido no ve nada»** — sin él, el `[]` de las tres
  aserciones positivas habría sido ceguera y yo lo habría publicado como ausencia.
- **Aplicar en**: todo guard que afirme un `[]`. El fixture positivo se escribe con el literal, y se
  exige que el guard lo cace, ANTES de creerle al vacío.

### [2026-09-01 17:05] Wave 0 — Cité una línea por lo que HACE, no por un símbolo que contiene
- **Error**: escribí `(`walk`, `../composition/citas-ancladas.test.ts:64`)`. La línea 64 es la
  condición de exclusión, pero **no dice `walk`**: dice `SELF`. El gate lo puso rojo:
  `«la línea dice "} else if (SCAN_EXTS.has(path.extname(entry)) && path.resolve(full) !=…"»`.
- **Causa raíz**: elegí el ancla por el concepto que quería nombrar (la función que recorre) en vez de
  por un identificador que esté EN la línea citada. Es la lección **V** en su forma más barata.
- **Fix**: el ancla pasó a `SELF`, que sí está en `:64`. **Lo cazó `npm run qa`, no yo**: es la
  evidencia de que correr el gate ENTERO, y no sólo `vitest` sobre los archivos nuevos, es lo que
  encuentra esta clase de defecto.
- **Aplicar en**: toda cita anclada nueva. El ancla se elige con `sed -n 'Np'` sobre el destino, ⛔
  nunca de memoria ni por el concepto.

### [2026-09-01 17:10] Wave 0 — M-6 murió por la CALIBRACIÓN y no por la aserción que el Story File nombra
- **Error potencial**: reportar «M-6 KILLED» sin decir cuál aserción lo mató habría dejado sin medir
  si la aserción 3 —la que sostiene el hallazgo de la ola: *una cita SUELTA no mueve nada*— es
  falsable o decorativa.
- **Causa raíz**: puse la calibración (aserción 4 del Story File) ANTES de los fixtures, porque
  calibrar antes de usar es la disciplina de toda esta ola. Vitest corta en el primer rojo ⇒ M-6 muere
  en la calibración (`expected 514 to be 165`) y nunca llega a la 3.
- **Fix**: se midió en dos pasos declarados, neutralizando primero la calibración y después la
  aserción 2, hasta llegar a la 3: **cae con su mensaje propio** (`una cita SUELTA movió el conteo`,
  `expected 515 to be 165`). Los tres neutralizadores se revirtieron y el archivo volvió a verde.
- **Aplicar en**: todo `it` con más de una aserción y un solo mutante. **Un KILLED nombra UNA
  aserción; las otras siguen sin medir hasta que se las alcanza.**

---

## Fix-pack del AR · ola W0 · 2026-09-01

### [2026-09-01 18:10] Wave 0 / fix-pack — Escribí los patrones del candado por el CONCEPTO, no por la propiedad que la premisa necesita
- **Error**: el barrido de `L-5` vigilaba `useRouter`, `router.push`, `router.replace` y
  `next/navigation`, y publicaba que *«en este repo no hay router de cliente ⇒ toda salida es una
  navegación de documento»*. **Era ciego a `next/link`**, y hay un `<Link href="/">` VIVO en
  `app/kyc-simulado/page.tsx:114`, **una línea debajo** del import que el `it` pinnea como *«la única
  ocurrencia permitida»*. Un componente nuevo con un `<Link>` dejaba el `it` en `✓ (1 test)`.
- **Causa raíz**: elegí los literales por el concepto que tenía en la cabeza (**«router de cliente»**)
  y no por la **propiedad que la premisa necesita** (**«toda navegación que NO recarga el
  documento»**). `next/link` no es un router y cumple igual: preserva el registro de módulos, que es
  exactamente lo que `L-5` afirma que se descarta. **El candado no protegía del error que existe para
  prevenir**, y ese error —usar `<Link>` para cambiar de pantalla— es el gesto más natural de W1.
- **Fix**: `next/link` y `<Link` entraron a `PATRONES`, con su control negativo sintético, dos
  aserciones de ocurrencia permitida y **la razón escrita** de por qué el `<Link>` del simulador de
  KYC no cuenta. Verificado con **tres** mutantes: la sonda del AR (`× T-374-W0-3`, *«el conjunto de
  imports de `next/link` del árbol cambió»*), un `<Link>` **sin** el import de `next/link`, y el
  borrado del gate `notFound()` de la página que lo aloja.
- **Aplicar en**: **todo guard que afirme una AUSENCIA**. Antes de escribir la lista de literales,
  escribí primero **la propiedad** en una línea y preguntá *¿qué otra construcción del framework la
  cumple?* Un guard cuya lista sale del concepto y no de la propiedad es un guard con agujeros que
  además **publica** que no los tiene.

### [2026-09-01 18:14] Wave 0 / fix-pack — Un guard que se apoyaba en la PROSA del archivo que vigila
- **Error**: al cerrar el hallazgo de arriba escribí la aserción de la bandera como
  `lineas.some((l) => l.includes("notFound()"))`. `app/kyc-simulado/page.tsx` **nombra `notFound()` en
  su prosa** en `:31`, `:58`, `:64` y `:65` ⇒ con el corte de `:72` **borrado**, el guard seguía verde
  leyendo los comentarios.
- **Causa raíz**: busqué el símbolo y no **el hecho**. Un archivo que documenta su propio gate contiene
  el nombre del gate muchas veces más de las que lo ejecuta.
- **Fix**: el predicado exige `mockDiditSurfaceEnabled()` **y** `notFound()` **en la misma línea** que
  no empiece con `//`. Verificado con el mutante `if (false) notFound();` ⇒ `× T-374-W0-3`,
  `expected false to be true`.
  ⛔ **Y ESTE «FIX» SE VOLVIÓ A ROMPER SOLO EN LA FRASE**, `BLQ-MED-1` del CR: acá arriba decía *«y que
  la línea no sea un comentario»*, y `!startsWith("//")` es **«no es un comentario de LÍNEA»**. Un
  `/** … */` que mencione el corte lo pasa. Ver la entrada del 2026-09-01 19:05.
- **Aplicar en**: todo guard que lea un archivo con `readFileSync` y busque un símbolo. **Lo cacé
  antes de correr el mutante sólo porque fui a mirar dónde aparecía el literal**; si hubiera corrido
  el mutante confiando en la aserción, el falso verde se habría publicado como control.

### [2026-09-01 18:18] Wave 0 / fix-pack — Publiqué «12» filtrando UN campo de un censo que tiene tres
- **Error**: el `it` de `W0-4` afirmaba que una cita anclada nueva mueve **12** marcadores. Son **13**:
  filtraba a `porCampo("entrantes")` y **nunca evaluaba `destinosDe`**, así que se comía el marcador
  `destinos` (`96 → 97`). El 12 estaba en el nombre del `it`, en el commit y en dos CDs.
- **Causa raíz**: el instrumento tenía las dos funciones (`entrantesA` y `destinosDe`), las usé a las
  dos en la CALIBRACIÓN, y después medí el costo con **una sola**. **12 es el mejor caso** —citar una
  línea que ya estaba citada—, y lo publiqué como si fuera el caso normal.
- **Fix**: la aserción cuenta marcadores desajustados **de los dos campos** y da **13**, re-derivado
  con una sonda propia (`entrantes 165 → 166` + `destinos 96 → 97`). Falsable en dos pasos: con la
  cita apuntando a `flow.tsx:163` (línea ya citada) cae la aserción de `destinos` (`expected 96 to be
  97`), y neutralizándola se alcanza la de los 13 (`expected 12 to be 13`).
- **Aplicar en**: todo número que salga de filtrar un conjunto. **Antes de publicarlo, preguntá qué
  quedó afuera del filtro y si el caso que estás midiendo es el mejor, el peor o el típico.**

### [2026-09-01 18:22] Wave 0 / fix-pack — Una aserción NEGATIVA que se satisface con una lista VACÍA
- **Error**: la mitad (a) de `T-374-W0-1` afirmaba `expect(pop.respuestas).not.toEqual(["no-corresponde"])`
  detrás de un `.catch(e => e as Error)`. Bajándole el saldo a 0, `execute` falla **antes** de llegar a
  `pedir()`, el `.catch` se traga el error, `pop.respuestas` queda `[]`, y `[] !== ["no-corresponde"]`
  **pasa**. Era la aserción que certifica que `N=2` y `M=1` salieron del camino por enlace.
- **Causa raíz**: escribí la aserción por lo que quería **descartar** en vez de por lo que quería
  **observar**. Y peor: **el observable real del árbol sano era otro** — `pedir()` no contesta
  `no-corresponde`, **TIRA**: `["TIRÓ: deeplink_viaje_vencido"]`. El docblock, el mensaje del assert y
  el story file describían un observable **que no ocurre**, y el que sí ocurre no estaba nombrado.
- **Fix**: primero se exige **que haya observable** (`.not.toEqual([])`), después se compara **por
  valor**, y el valor se **midió** con una sonda (`SONDA-W0-1a`), no se copió del AR. Falsable: con
  saldo 0 cae la primera (`expected [] to not deeply equal []`), y sin el `stubEnv` cae la segunda
  (`expected [ 'no-corresponde' ] to deeply equal [ 'TIRÓ: deeplink_viaje_vencido' ]`).
- **Aplicar en**: **toda aserción `.not.*` sobre una colección.** Un `[]` la satisface siempre. Va
  precedida por una que exija contenido, o se reescribe por valor. En este mismo `it` la aserción 4 ya
  existía justo para cerrar ese agujero sobre otra variable, y **no la apliqué acá**.

### [2026-09-01 18:25] Wave 0 / fix-pack — Falsifiqué tres números en el docblock de la función que la ola vino a calibrar
- **Error**: el docblock de `viajesALaBilletera` decía *«los 6 `it` del archivo»* (son **8**), *«los 3
  llamadores»* (son **5**) y *«hoy no llega ninguno»* al `catch` — falso **desde el propio commit de
  la ola**, porque `T-374-W0-0` le pasa `"no-soy-una-url"` a propósito.
- **Causa raíz**: los tres números eran verdaderos **antes** de mi propia edición, y no los re-derivé
  después. Es la lección de las citas que rompés vos al arreglar otra cosa, aplicada a números en vez
  de a `archivo:línea`.
- **Fix**: re-derivados con `/usr/bin/grep -n` y con una corrida del mutante (`catch` → `throw` ⇒
  **1 failed | 7 passed (8)**, único rojo `× T-374-W0-0` con `TypeError: Invalid URL`). Y el mismo
  defecto en `MNR-3`: *«el filtro se ejercitaba en TRES sitios»* ahora va anclado a `@c1bd8d3` y dice
  que **hoy son cinco**.
- **Aplicar en**: toda frase de docblock que contenga **un conteo del propio archivo**. Se re-deriva
  **después de la última edición**, junto con las citas `:NN`, y **se ancla al commit**: un conteo sin
  commit no se re-deriva y envejece en silencio en la misma pasada que lo escribe.

### [2026-09-01 18:28] Wave 0 / fix-pack — El motivo escrito de una exclusión que NO es load-bearing
- **Error**: `el-arbol-propio-cuesta-cero-citas.test.ts` justificaba su exclusión `SELF` diciendo que
  *«sin excluirse, se contaría a sí mismo»*. **Medido quitándola: el `it` sigue en `1 passed`.**
- **Causa raíz**: copié el motivo del archivo hermano (`el-salto-remonta-el-arbol.test.tsx`), donde la
  exclusión **sí** es load-bearing porque ese archivo escribe los patrones vigilados en su prosa. Acá
  las citas de mentira se arman **por concatenación**, así que ninguna línea contiene el patrón entero.
- **Fix**: la decisión se queda (es el cinturón sobre el tirante), el motivo se corrigió y se dice
  **cuál** es la defensa que de verdad sostiene el verde. La prosa del archivo hermano **no se tocó**.
- **Aplicar en**: toda defensa copiada entre archivos. **Antes de escribir su motivo, quitala y corré**:
  si el verde no se mueve, no es la defensa que estás describiendo.

### [2026-09-01 18:32] Wave 0 / fix-pack — El reporte de la ola no existía, y el commit afirmaba que sí
- **Error**: `w0-report.md` **no se escribió**, y el commit de la ola afirma que la declaración de
  `W0-6` está hecha. `D10`, `D17`, `D18`, `T42` y `T43` no se podían verificar en ningún lado.
- **Causa raíz**: el reporte era la última tarea de una lista larga y la di por hecha al cerrar el
  gate. **Es el modo de falla que este proyecto ya registró cinco veces**: afirmar sobre un artefacto
  que no existe.
- **Fix**: `doc/sdd/234-recorrido-de-la-dapp-de-cero/w0-report.md`, con los tres números y su etiqueta,
  el alcance Phantom-y-sólo-Phantom, `C-1..C-5`, `OBS-1`, `OBS-5`, el contraste de presupuesto por
  columna con su justificación escrita, y la declaración de `W0-6` con dueño, instrumento,
  precondición y fecha.
- **Aplicar en**: **materializar el reporte es pre-requisito del commit de la ola, no de su cierre.**
  Si el mensaje del commit nombra un documento, ese documento existe **antes** del commit.

### [2026-09-01 18:35] Wave 0 / fix-pack — Los dos menores que NO son de este fix-pack, anotados para que no se pierdan
- **`MNR-4` · el flake heredado de 7-13 % es hoy un número sin testigo.** Acumulado **0/60** entre tres
  series serializadas independientes (el Dev, el AR, este fix-pack). Bajo `p = 0,10` eso ocurre el
  **0,18 %** de las veces. ⛔ **No es defecto de W0 y no se arregla acá**: repetir no prueba, y el
  número heredado merece **su propia HU**, con la medición de su mecanismo.
- **`MNR-5` · la fila 234 de `doc/sdd/_INDEX.md`** sigue diciendo *«6 mediciones»* (son **8**) y
  publica **«2 salidas»**, que `CD-W0-14` declara **no publicable**. **Es trabajo del cierre**, no del
  fix-pack. Queda anotado acá para que el cierre no lo herede en silencio.

---

## Fix-pack del **CR** (2026-09-01) — los dos bloqueantes los había escrito el fix-pack del AR

### [2026-09-01 19:05] Wave 0 / fix-pack del CR — Arreglé un guard que leía prosa… y publiqué que el arreglo cubría más de lo que cubre
- **Error**: el docblock y el mensaje del assert publicaban, tres veces, que el predicado *«exige los
  dos símbolos en la misma línea **y que no sea un comentario**»* y que *«si alguien le saca el corte,
  esto cae»*. El predicado es `!l.trimStart().startsWith("//")`, o sea **«no es un comentario de
  LÍNEA»**. Dos escapes de una línea lo dejan **verde**, los dos re-medidos por mí:
  **E1** invertir el `if` (`if (mockDiditSurfaceEnabled()) notFound();`) ⇒ la página renderiza el
  simulador **exactamente cuando la bandera está apagada, o sea en producción**, y este guard no se
  inmuta; **E2** reemplazar el corte por un `/** … */` que lo mencione ⇒ ídem, y el repo escribe
  `/** … */` en todos lados.
- **Causa raíz**: **escribí la frase describiendo la INTENCIÓN del predicado, no el predicado.** Es la
  misma clase de agujero que la entrada de las 18:14 decía haber cerrado, en el mismo `expect`, dos
  horas después. Y hay un agravante estructural: **era la única de las tres aserciones nuevas sin
  mutante declarado** (`CD-W0-6`), y fue justo la que se escapó. **La aserción sin mutante no es la
  que menos importa: es la que nadie miró.**
- **Fix**: se eligió la **opción (b)** del CR — **la frase deja de prometer**. El docblock dice literal
  qué exige (una línea, no comentario de línea, con los dos símbolos), declara `E1` y `E2` con su
  resultado medido, y **cita a `T-GATE-3'` (`app/kyc-simulado/kyc-simulado-gate.test.ts`) como el
  candado real del corte**, que lo mide **llamando a la página**. El mensaje del assert dejó de decir
  *«dejó de cortar»* y dice lo que la aserción sabe: que **la línea desapareció**.
  Mutante declarado y corrido, **M-11**: partir el `if` en dos líneas ⇒ **suite entera
  `1 failed | 3494 passed (3495)`**, único rojo `× T-374-W0-3` en `el-salto-remonta-el-arbol.test.tsx`,
  con `T-GATE-3'` **verde** porque el comportamiento no cambió.
- **Aplicar en**: **toda frase que describa lo que un predicado exige.** Antes de escribirla, escribí
  el mutante que la volvería falsa y corrélo. Y si el mutante que se te ocurre **también rompe el
  comportamiento**, no es el mutante de tu aserción: te lo va a matar otro control y vas a leer un
  falso KILLED. El mutante correcto **deja intacto todo lo que los otros controles miran**.
  🔴 **Y la regla que sale de haber reincidido**: cuando un guard mira TEXTO para inferir
  COMPORTAMIENTO, la frase correcta no es «esto verifica que corta», es **«esto verifica que la línea
  existe; quien verifica que corta es aquél»**. Si no existe un «aquél», el guard no cubre la
  propiedad y hay que decirlo, no adornarlo.

### [2026-09-01 19:12] Wave 0 / fix-pack del CR — Publiqué una superlativa sacada de cuatro archivos elegidos a mano
- **Error**: *«42,8 % es el máximo del repo»*, en `story-W0.md` y replicado en **tres** sitios de
  `w0-report.md`, incluida la justificación del exceso de escala. **Los cuatro números individuales
  reproducen al decimal; el cuantificador no.** Barrido el árbol entero con el mismo contador: el
  máximo es **65,0 %** (`src/composition/prepared-claims-guard.static.test.ts`, 147 prosa / 79 código)
  y hay **26 de 174** archivos de test por encima de 42,8 %.
- **Causa raíz**: **corregí una comparación mala (contra módulos de producción) con otra comparación
  mala (contra cuatro archivos que yo elegí).** Los cuatro los elegí porque los tenía a mano de otras
  tareas de la ola, y de ahí a escribir «el máximo del repo» hay un salto que **no costaba nada
  verificar**: el barrido son treinta segundos y ya lo había escrito dos veces en esta misma ola.
  Peor: la superlativa iba **en el documento de cierre de la ola cuyo producto es que los números
  re-deriven**, y **W1 la iba a heredar como vara**.
- **Fix**: `w0-report.md` **§7.2** publica el **contador como función** y el barrido de los 174
  archivos; se re-escribieron **C-5**, la fila del presupuesto y **§7.1**; el *«número operativo
  42,8 %»* queda **RETIRADO** y lo reemplaza el techo formal **≤55 %, que sí bindea** (el archivo C de
  la ola quedó a **0,5 puntos**). Las dos fuentes heredadas (`story-W0.md` C-5 y §9.2) quedaron
  marcadas como corregidas, ⛔ no borradas.
- **Aplicar en**: **toda palabra que cuantifique sobre un conjunto** —«el máximo», «el único», «no hay
  ninguno», «en ocho archivos»—. La pregunta antes de escribirla: *¿corrí el barrido sobre el conjunto
  ENTERO, o miré una muestra que ya tenía abierta?* Si es lo segundo, la frase que corresponde nombra
  la muestra: «de los cuatro que miré, el más alto es 42,8 %».
  ⚠️ **Y si el número va a ser una vara para la ola siguiente, tiene que salir de una función que
  cualquiera pueda correr, no de una tabla escrita a mano.** Una tabla a mano no se puede refutar sin
  rehacer el trabajo, y por eso sobrevive.

### [2026-09-01 19:20] Wave 0 / fix-pack del CR — El guard matcheaba PROSA, y W1 iba a escribir justo esa prosa
- **Error** (`MNR-2` del CR): los seis `PATRONES` del barrido de `L-5` eran **substrings crudos**.
  Medido: una sola línea de comentario en cualquier archivo del árbol que dijera *«acá NUNCA se usa
  useRouter»* ponía el `it` rojo con *«apareció un hook de router de cliente»*.
- **Causa raíz**: escribí la lista desde el concepto («los literales que delatan un router») y no
  desde la **forma** que tiene un router en el código. Y el molde correcto ya existía en el repo desde
  WKH-320: `src/composition/no-evm-surface.test.ts` documenta esto como su **«TRAMPA 3»**, con
  patrones import-shaped, y **ninguno de los dos archivos nuevos lo citaba**.
- **Fix**: los seis pasaron a `{ nombre, pattern, por }` con expresiones import-shaped, call-shaped y
  JSX-shaped, citando el molde. El control negativo sintético ganó **dos líneas de prosa que NO pueden
  aparecer** en la salida. Mutante **M-12**: devolverle a `useRouter` la forma cruda ⇒
  `expected [ Array(7) ] to deeply equal [ Array(6) ]`.
  ⚠️ Efecto secundario **medido, no supuesto**: la forma vuelve inmunes a sí mismas a las seis líneas
  de la tabla, ⛔ pero **no al archivo**, porque el control negativo escribe los seis con todas las
  letras a propósito ⇒ `SELF` **sigue siendo load-bearing acá**, y así está escrito.
- **Aplicar en**: **todo guard que barra el árbol buscando literales.** Preguntá *¿esto matchea código
  o matchea que alguien HABLE del código?* En un repo que documenta su propia disciplina en docblocks,
  la segunda es una fábrica de falsos rojos — y un falso rojo recurrente termina en que alguien
  debilita el guard.

### [2026-09-01 19:24] Wave 0 / fix-pack del CR — El nombre del archivo publicaba la medición que el archivo abandonó
- **Error** (`MNR-3` del CR): `el-arbol-propio-cuesta-cero-citas.test.ts` nombraba **la medición
  tautológica** que su propio docblock declara descartada. **El nombre es lo que se grepea dentro de
  seis meses**, y era lo único del archivo que seguía afirmando algo falso.
- **Causa raíz**: el nombre salió del work-item y **la medición cambió después**; renombrar no estaba
  en ninguna lista, así que no pasó.
- **Fix**: renombrado a `costo-de-una-cita-anclada.test.ts`. **Impacto medido ANTES de decidir**:
  1 sitio en el repo, 8 en los documentos de la HU (1 de ellos en el AR, que ⛔ no se reescribe) y
  ninguno en los mensajes de commit ni en el CR. **El nombre viejo quedó escrito en el docblock** para
  que un grep por él siga aterrizando en el archivo, que es lo que anula el costo del renombre.
- **Aplicar en**: cuando una medición cambia de contenido, **el nombre del archivo entra a la lista de
  cosas que cambian con ella**. Y antes de renombrar, contá las citas: si el costo es alto, la
  alternativa honesta es dejarlo escrito, ⛔ no dejarlo sin decidir.

### [2026-09-01 19:30] Wave 0 / fix-pack del CR — Dos guards hermanos que divergían en silencio, y un tercero que ninguno citaba
- **Error** (`MNR-1` del CR): `leerElArbol`, `type Fuente`, `SKIP` y `EXTS` estaban duplicados **byte a
  byte** entre los dos archivos nuevos **sin una línea que lo explicara**, y **ya divergían**: uno
  barría cuatro raíces y el otro dos, sin motivo escrito. Y `src/composition/no-evm-surface.test.ts`
  **es exactamente ese guard por tercera vez**, con sus tres trampas documentadas desde WKH-320.
- **Causa raíz**: copié el helper del archivo hermano y **recorté las raíces sin anotar por qué**. Un
  recorte sin motivo escrito es indistinguible de un descuido, y el que lo lea mañana no puede saber
  si ampliarlo rompe algo.
- **Fix**: se escribió **por qué NO se extrae** —`CD-W0-1` (un helper fuera de un `.test.` es
  producción) y, sobre todo, que un punto de falla único **cegaría tres guards juntos** el día que
  alguien le agregue un `SKIP`—, **se cita el tercero** en los dos archivos, y **se alinearon las
  raíces**. ⚠️ Medido antes de alinearlas: **cero ocurrencias** de los seis delatores en `scripts` y
  `contracts` ⇒ ninguna aserción se movió.
- **Aplicar en**: **duplicar está permitido; duplicar sin decirlo, no.** Y antes de escribir el helper
  número dos, buscá el número uno: en este repo ya estaba, con las trampas resueltas y explicadas.

### [2026-09-01 19:34] Wave 0 / fix-pack del CR — Los tres menores que NO son de este fix-pack, con su medición
- **`MNR-4` del CR · «47 ocurrencias preexistentes» es un número sin patrón publicado.** Con dos
  lecturas igual de plausibles da **46** o **47**. El número no está mal: **le falta el patrón que lo
  re-deriva**, y sin él nadie puede saber cuál de las dos lecturas se usó. Es la misma familia que el
  `BLQ-MED-2` de acá arriba, un escalón más abajo.
- **`MNR-5` del CR · dos mensajes de aserción que afirman de más**, medidos por el CR.
- **`MNR-6` del CR · el nombre de un `it` promete un observable que el `it` no observa**: la pata (b)
  asserta **ausencia**, y el docblock lo dice bien. Es el nombre, no la medición.
- ⛔ **No se tocaron acá porque no estaban en el fix-pack asignado**, y ⛔ quedan con domicilio en
  `w0-report.md` §10 para que el cierre no los herede en silencio. **Los tres son prosa que afirma más
  de lo que el código verifica**, que es exactamente lo que le costó dos rechazos a esta ola.

### [2026-09-01 19:48] Wave 0 / fix-pack del CR — Escribí tres citas ancladas que NINGÚN candado iba a verificar
- **Error**: tres de las cinco citas ancladas que agrega este fix-pack quedaron **partidas por un salto
  de línea** dentro de un docblock —`(`FORBIDDEN`,\n `…no-evm-surface.test.ts:56`)` y las dos de
  `leerElArbol`—. El candado de citas **recolecta línea por línea**, así que un ancla partida **no se
  cuenta**: los anclas `:56`, `:77` y `:114` quedaban **rotos y verdes POR AUSENCIA**.
- **Causa raíz**: la envoltura del párrafo. Escribí la cita donde caía el renglón, y **el mismo agujero
  que el archivo B documenta en su propio docblock** (*«47 ocurrencias preexistentes en el árbol»*) me
  mordió a mí, en la misma tarea en la que lo estaba explicando. **Saber que un agujero existe no
  alcanza para no caerse adentro: hay que mirar el artefacto que el candado consume.**
- **Fix**: las cinco quedaron **enteras en una línea**. Detectado enumerando las citas del propio diff
  —`/usr/bin/git diff --cached c823aeb -- src | grep -o "(\`sym\`, \`ruta:NN\`)"`— y comparando el
  resultado con las que había escrito: aparecían dos, y yo había escrito cinco.
- **Aplicar en**: **toda cita anclada nueva.** Después de la última edición, enumerá las citas del
  diff con el mismo regex que usa el candado y **contá**. Si el conteo no coincide con lo que
  escribiste, las que faltan están partidas. ⛔ Un `grep` del símbolo NO sirve: el símbolo está, lo que
  falta es que el par entre entero en un renglón.

### [2026-09-01 21:10] Wave 1 — Mi propio guard cazó los docblocks que escriben lo que el guard prohíbe
- **Error**: `T-374-W1-12` salió ROJO en su primera corrida completa, con seis hallazgos, y los seis
  eran **líneas de prosa mías**: `pantallas.tsx:4` y `recorrido.tsx:14` dicen «⛔ ninguno toca
  `localStorage`, `sessionStorage`, `document.cookie`» — o sea, nombran los delatores **para
  prohibirlos**, y el barrido los contó como usos.
- **Causa raíz**: escribí los patrones como **substrings crudos** (`/\blocalStorage\b/`). Este repo ya
  tiene el hallazgo escrito con nombre propio —la «TRAMPA 3» de `FORBIDDEN` en
  `no-evm-surface.test.ts:56`, y el `MNR-2` del CR de W0 sobre el guard de `L-5`— y aun así lo repetí
  en el mismo archivo donde estaba copiando esos moldes.
- **Fix**: los patrones pasaron a ser **call-shaped / asignación-shaped**
  (`/\blocalStorage\s*\.\s*\w+\s*[([=]/`, `/\bdocument\s*\.\s*cookie\s*=[^=]/`, …), más una fila nueva
  que caza el **alias** (`/=\s*(?:window\s*\.\s*)?(?:local|session)Storage\b/`), y cada una con su
  cebo literal en el control negativo. ⛔ **No se tocó ni una línea de prosa para acomodar el guard**:
  el que estaba mal era el guard.
- **Aplicar en**: **todo guard textual nuevo.** Antes de correrlo, preguntate *¿mi propio docblock lo
  pone rojo?* Si un guard prohíbe un nombre, ese nombre va a aparecer en la prosa que explica la
  prohibición. El patrón tiene que matchear **código**, no menciones. Y el corolario incómodo: la
  primera corrida roja de un guard nuevo es más probable que sea culpa del guard que del árbol.

### [2026-09-01 21:25] Wave 1 — Dos citas ancladas partidas, otra vez, con la lección ya escrita arriba
- **Error**: de las **17** citas ancladas que escribí, **2 quedaron partidas** por el salto de línea de
  un docblock (`salto.ts` hacia `splash-puerta.ts:84`, `inercia.test.tsx` hacia
  `no-evm-surface.test.ts:35`) ⇒ **rotas y verdes POR AUSENCIA**. Pasó con la entrada de W0 sobre
  exactamente esto tres pantallas más arriba en este mismo archivo.
- **Causa raíz**: la envoltura del párrafo, igual que en W0. Leer la lección **no** la aplica; lo que
  la aplica es **correr el control**.
- **Fix**: el control de W0 corrido tal cual —enumerar las citas del propio diff con el regex del
  candado y contar—: daba **15** contra **17** escritas. Las dos se reacomodaron para que el par
  `` `símbolo`, `ruta:NN` `` entre entero en un renglón.
- **Aplicar en**: ídem W0, y con un agregado: **el control se corre aunque estés seguro.** El costo es
  un script de diez líneas y el modo de falla es invisible desde el verde. Ponelo en la lista de
  cierre de la ola, no en la memoria.

### [2026-09-01 21:30] Wave 1 — El Story File tenía una cita corrida, y el candado la cazó antes que yo
- **Error**: copié `(`clasesDe`, `../ola-2-pantallas.test.tsx:89`)` del Story File. El símbolo está en
  **`:91`**; `:89` es la primera línea de su docblock. Salió rojo el candado de citas ancladas.
- **Causa raíz**: tomé una cita del documento **sin re-derivarla**, aunque §0 del propio Story File
  dice que las citas se re-derivan. Re-derivé las que iba a *importar* y no las que iba a *citar*.
- **Fix**: `/usr/bin/grep -n "function clasesDe"` ⇒ `:91`. Corregido **en el código**, no en el
  documento, y anotado en el reporte.
- **Aplicar en**: **toda cita que copies de un documento a un docblock.** Un `archivo:línea` que viene
  de un documento es una afirmación de otro; verificala como verificás un símbolo externo. La regla
  práctica: si vas a escribir un número de línea, el `grep` que lo produce va antes.

---

## Fix-pack del AR de la ola W1 — 2026-09-01

### [2026-09-01 22:05] Fix-pack W1 — El mutante llevaba el marcador ADENTRO del defecto y por eso no reprodujo nada
- **Error**: `MW-12c` tenía que reproducir el escape que el AR midió (el **alias partido en dos
  líneas**) contra el barrido de disco ya arreglado. Lo escribí como
  `const almacenDelMutante = // MUTANTE-MW12C` + salto de línea + `window.localStorage;`.
  Resultado: **`3 passed`, mutante SOBREVIVIENTE**. Casi lo reporto como «el barrido sigue abierto».
- **Causa raíz**: el marcador que mi arnés exige para verificar *«el mutante se aplicó»* lo puse
  **entre el `=` y el nombre del almacén**, o sea **adentro del patrón que el delator busca**
  (`/=\s*(?:window\s*\.\s*)?(?:local|session)Storage\b/`). Un `// …` no es `\s`, así que el mutante
  dejó de ser el defecto: era otro texto que ningún barrido tiene por qué cazar. El mutante estaba en
  disco —el marcador se verificó— y aun así **no reproducía el defecto**.
- **Fix**: el marcador se movió a **una línea propia arriba**, dejando intacta la forma que el guard
  vigila. `MW-12c'` ⇒ rojo en `T-374-W1-12`, *«una pantalla del recorrido nuevo toca disco o la barra
  de direcciones… expected [ Array(1) ] to deeply equal []»*. Y se agregó `MW-12d` para la forma nueva
  (índice por corchetes), también rojo.
- **Aplicar en**: **todo mutante contra un guard TEXTUAL.** «El mutante está en disco» y «el mutante
  reproduce el defecto» son dos cosas distintas, y la verificación de la primera puede **destruir** la
  segunda. La pregunta antes de correr: *¿mi marcador cae adentro de lo que el patrón mira?* Si sí, va
  afuera. Y el corolario que casi me cuesta un reporte falso: **un mutante sobreviviente es primero
  sospechoso de estar mal escrito, y recién después evidencia de un guard vacío.**

### [2026-09-01 22:06] Fix-pack W1 — Un mutante «equivalente» que sobrevive, y la limitación REAL que destapó
- **Error**: `MW-17a` para el debounce lo escribí como `setTimeout(…, 0)`. **`8 passed`, sobrevivió.**
- **Causa raíz**: con **temporizadores falsos** el tiempo sólo avanza cuando el `it` lo avanza, y la
  limpieza del efecto cancela el temporizador anterior en cada tecla ⇒ con **cualquier** demora,
  incluida 0, las dos teclas colapsan en un solo pedido. El mutante era **equivalente** bajo ese
  reloj, no un agujero.
- **Fix**: dos cosas, y la segunda importa más. (1) El mutante correcto es el **defecto real**: que el
  pedido **no se difiera** (el cuerpo corre dentro del propio efecto) ⇒ rojo en `T-374-W1-17`,
  *«se pidió una cotización POR TECLA… expected [ 9, 95 ] to deeply equal [ 95 ]»*, que es la misma
  forma que el AR midió (`[2, 25]`). (2) **La limitación quedó escrita en el `it`**: lo que clava es
  que el pedido esté **diferido fuera del render**, ⛔ **no** que la demora sean 300 ms. Ese número
  vive en `MS_DE_ESPERA_DE_LA_COTIZACION` y **no lo vigila nada**.
- **Aplicar en**: **todo test con `vi.useFakeTimers()`.** Un reloj que sólo avanza a pedido no
  distingue demoras entre sí: distingue *diferido* de *no diferido*. Si el `it` se llama «debounce»,
  tiene que decir cuál de las dos propiedades clava, porque quien lea el nombre va a asumir la otra.

### [2026-09-01 22:08] Fix-pack W1 — `.not.toBeInTheDocument()` DESCARTA el mensaje de la aserción
- **Error**: escribí las aserciones clave de `T-374-W1-15` y `T-374-W1-17` como
  `expect(queryByRole(...), "mensaje que explica el hallazgo").not.toBeInTheDocument()`. Al correr los
  mutantes, el rojo salió como **`expect(element).not.toBeInTheDocument()` / «expected document not to
  contain element, found <button»** y **mi mensaje no aparecía por ningún lado**.
- **Causa raíz**: los matchers de `jest-dom` arman su propio mensaje y **se comen** el segundo
  argumento de `expect`. El `it` seguía siendo correcto; lo que se perdía era **la única línea que
  explica por qué el rojo importa**, que es lo que alguien va a leer en un CI dentro de seis meses.
- **Fix**: las aserciones que tienen que citar su motivo pasaron a `expect(queryBy…, "mensaje")
  .toBeNull()` —matcher de vitest, que sí lo respeta—. Re-corridos `MW-15` y `MW-17c`: el rojo ahora
  sale con el mensaje literal.
- **Aplicar en**: **toda aserción cuyo mensaje sea parte del entregable.** La disciplina del repo pide
  citar el rojo por *archivo · `it` · mensaje del assert*; con un matcher de librería puede no haber
  mensaje que citar. Comprobalo **corriendo el mutante**, no leyendo el código.

### [2026-09-01 22:07] Fix-pack W1 — Un mutante que no compila da «no tests», y eso NO es un KILLED
- **Error**: la primera versión de `MW-17a''` dejó el archivo con un `}` de más ⇒ vitest salió con
  **`Unexpected ","` · `Tests no tests`** y `1 failed` a nivel de archivo.
- **Causa raíz**: sustituí la apertura del `setTimeout` sin tocar su cierre. El arnés verificó el
  marcador —estaba— pero **el marcador no dice nada sobre si el archivo sigue siendo válido**.
- **Fix**: el mutante se rehízo respetando la estructura (sustituir la FUNCIÓN, no el bloque), y el
  criterio de KILLED se endureció: un rojo cuenta **sólo** si viene con un `×` sobre un `it`
  NOMBRADO. `Tests no tests` es una falla de la herramienta, no del control.
- **Aplicar en**: **todo barrido de mutación.** Un `1 failed` a nivel de archivo se parece mucho a un
  KILLED en la salida y no lo es. Filtrá por el `×` y por el nombre del `it`, siempre.

### [2026-09-01 22:04] Fix-pack W1 — Un `export` en un archivo de test sólo lo caza el gate COMPLETO
- **Error**: extraje el normalizador del barrido a una función y la exporté (`export function
  normalizar`). `tsc --noEmit` verde, `vitest` del archivo verde, `vitest` del directorio verde.
  **`npm run qa` rojo**: `lint/suspicious/noExportsInTest` — *«Do not export from a test file»*,
  **1 error** contra un baseline de **0**.
- **Causa raíz**: corrí las **partes** del gate (typecheck + el archivo de test) y no el gate. Es la
  lección que este ecosistema ya tiene escrita con nombre propio —`lint` va primero en `npm run qa` y
  un `import` sin usar sobrevivió cinco revisiones porque nadie llegaba a lint— y la repetí.
- **Fix**: la función dejó de exportarse (nadie la usa fuera del archivo). Y el orden de trabajo
  cambió: `git add -A && npm run qa` **antes** de dar por cerrado cualquier bloque, no al final.
- **Aplicar en**: **siempre.** Correr las partes de un gate no es correr el gate, y el sub-gate que
  más se saltea es el que va primero.

### [2026-09-01 23:01] W1 fix-pack del CR — `git checkout --` borró el trabajo SIN COMMITEAR del archivo mutado
- **Error**: para restaurar un mutante corrí `/usr/bin/git checkout -- src/presentation/recorrido/pantallas.tsx`
  con **el fix-pack todavía sin commitear**. Eso no restauró «el archivo antes del mutante»: lo
  restauró **al último commit**, o sea que se llevó puestas las ~15 ediciones del fix-pack en ese
  archivo. Lo detecté porque el segundo mutante de la tanda no encontró su ancla y `git diff --numstat`
  mostraba `pantallas.tsx` SIN NINGUNA línea, con los otros cinco archivos con cientos.
- **Causa raíz**: `git checkout -- <archivo>` restaura contra **el índice/HEAD**, no contra «lo que
  había hace un minuto». Es la restauración correcta para un mutante **sólo si el árbol limpio es el
  commit**. La disciplina dice «restaurados contra `git diff --numstat`» y eso es justamente lo que
  la delató; lo que faltaba era la PRECONDICIÓN: **el entregable tiene que estar commiteado ANTES de
  empezar a mutar.**
- **Fix**: re-apliqué las 15 ediciones desde un script idempotente con `assert s.count(old)==1` por
  cada una (así una re-aplicación parcial aborta en vez de dejar el archivo a medias), verifiqué
  `tsc --noEmit` y `25 passed`, y **commiteé el fix-pack antes de correr un solo mutante más**.
- **Aplicar en**: cualquier barrido de mutación. La regla operativa queda: `git add -A` + commit ⇒
  recién ahí mutar ⇒ `git checkout --` ⇒ `git diff --numstat` vacío. ⚠️ Y el `git diff --numstat`
  después de restaurar hay que leerlo **sobre el árbol entero**, no sobre el archivo mutado: mirando
  sólo el archivo mutado, «0 líneas» es exactamente lo que devuelve el caso en el que se borró todo.

### [2026-09-01 23:08] W1 fix-pack del CR — el `it` medía el `disabled` con el nombre de la guarda
- **Error**: `T-374-W1-23` decía cerrar la guarda de reentrada de `BLQ-MED-4`. El mutante que la
  borra (`MW-26`) **SOBREVIVIÓ**: `13 passed`, con el marcador verificado en disco.
- **Causa raíz**: el `it` daba **un toque por `act()`**. Con eventos discretos, React alcanza a
  pintar el `disabled` entre un toque y el siguiente, así que el segundo ⛔ nunca llegaba al
  manejador. ⇒ el verde venía del `disabled`, no de la guarda. Los dos controles existen y los dos
  funcionan, pero **el `it` no podía distinguirlos**, así que uno de los dos estaba sin defensa.
- **Fix**: los dos primeros toques van **dentro del mismo `act()`**, que es la carrera real del
  teléfono (dos toques antes de que la pantalla se entere del primero). Con eso `MW-26` muere con
  *«expected 2 to be 1»*, y `MW-26b` (sin `disabled`) muere por la etiqueta que falta. Cada mitad con
  su propio mutante.
- **Aplicar en**: todo control que tenga **dos defensas superpuestas** (una que se ve y una que
  decide). La pregunta que lo destapa es la del protocolo: *¿qué OTRO control podría estar matando a
  este mutante?* Si la respuesta es «el de al lado», el rojo no dice nada del control nuevo.

### [2026-09-01 23:09] W1 fix-pack del CR — un mutante aplicado a un componente que el `it` no renderiza
- **Error**: `MW-26b` mutaba el botón del componente compartido `Salir` y **sobrevivió** con el
  marcador presente en disco. Leerlo como KILLED-que-no-fue habría dado por defendido el botón que
  dispara `startKyc` (cuota de proveedor) y `confirmAndSend` (el depósito).
- **Causa raíz**: `PantallaEntrar` usa su **propio** `<Button>`, no el de `Salir`; y `Salir` sólo
  aparece en su forma de botón cuando todavía no hay destino. El `it` nunca renderizaba esa rama ⇒ el
  mutante estaba **bien escrito, bien aplicado, y sobre código muerto para ese test**.
- **Fix**: se partió en dos mutantes (`MW-26b` al botón propio, `MW-26c` al compartido) y se agregó
  la pata (D) al `it`, que monta el paso de la identidad con un `startKyc` que ⛔ no resuelve y
  afirma la etiqueta en curso y el `disabled` **del componente compartido**.
- **Aplicar en**: antes de dar un mutante por vivo, verificar que **el camino que muta se ejecuta** en
  el `it` que se le apunta. Un componente compartido defendido «porque su hermano lo está» no está
  defendido: son dos sitios de render distintos.

### [2026-09-01 23:07] W1 fix-pack del CR — mi aserción del apagador era un control VACÍO
- **Error**: la aserción (A) de `T-374-W1-22` afirmaba que el estado «estamos en la otra app» se
  apaga al cambiar de paso. Miraba **la pantalla del envío**, que ⛔ **no renderiza ese bloque en
  ningún caso** ⇒ el texto desaparecía de ahí con apagador y sin él.
- **Causa raíz**: elegí el paso de destino por conveniencia («Volver» es un clic) y ⛔ no verifiqué
  que ese destino pudiera **mostrar** lo que la aserción niega. Una aserción de AUSENCIA sobre una
  pantalla que nunca puede mostrar esa presencia es verde para siempre.
- **Fix**: lo destapé **sondeando el arreglo**, no leyéndolo: atar el efecto a `[]` en vez de a
  `[paso]` daba **`13 passed`**. Se reescribió para volver **al mismo paso** («Volver» y después
  «Seguir»), que es la reproducción literal del CR, y ahí el mutante muere.
- **Aplicar en**: toda aserción `not.toContain` / `queryBy…).toBeNull()`. La pregunta antes de
  escribirla: *¿este sitio PUEDE mostrar lo que estoy negando?* Si no puede, la aserción no mide nada.

### [2026-09-01 23:11] W1 fix-pack del CR — dos guards del repo se pusieron rojos por MI PROSA
- **Error**: dos veces escribí en un comentario el literal que otro candado del repo vigila.
  (1) `` `return` `` entre acentos graves en `pasos.test.ts` ⇒ `T-374-W1-4` rojo, porque `return` es
  el valor de `VALOR_VUELTA_KYC` y ese barrido es literal-shaped con los tres tipos de comilla.
  (2) el nombre del método de navegación blanda en `inercia.test.tsx` ⇒ `T-374-W0-3` rojo.
- **Causa raíz**: los barridos de este repo son *literal-shaped* justamente para **no** cazar prosa,
  pero «entre comillas» y «entre acentos graves» es la forma en que la prosa técnica de este repo
  cita cosas. ⇒ el patrón que evita el falso positivo del comentario en prosa **sí** caza el
  comentario que usa comillas de código.
- **Fix**: reescribir las dos frases sin el literal, y **dejar dicho en el comentario por qué**, para
  que el que venga no lo «arregle» de vuelta.
- **Aplicar en**: antes de escribir prosa nueva en un árbol vigilado por barridos estáticos, correr
  la suite del directorio. Los dos rojos aparecieron **en el gate completo**, no en el archivo que
  estaba editando: el segundo vivía en `src/presentation/`, tres directorios más arriba.
