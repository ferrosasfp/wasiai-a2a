# Reporte de la ola **W0** · WKH-374 · `chaski-v3`

> **Qué es esta ola**: la puerta de la HU. **Ocho mediciones y cero líneas de producción.** Su único
> producto son números, y de esos números cuelga un rediseño entero. Por eso el lente de todo lo que
> sigue no es *«¿el código es seguro?»* sino **«¿estas mediciones pueden fallar, y miden lo que dicen?»**
>
> **Estado**: cerrados los **dos** fix-packs. El del AR (`adversarial-review-w0.md`, **RECHAZADO**: 1
> `BLQ-ALTO`, 2 `BLQ-MED`, 2 `BLQ-BAJO`, 5 `MNR`) y el del CR (`code-review-w0.md`, **RECHAZADO**: 2
> `BLQ-MED`, 6 `MNR`). Este documento existe porque **no existía**, y esa ausencia era el
> `BLQ-BAJO-2`: el commit de la ola **afirmaba** que la declaración de `W0-6` estaba escrita, sobre un
> artefacto que no estaba en ningún lado. Es el modo de falla que este proyecto ya registró cinco veces.
>
> 🔴 **Y LOS DOS BLOQUEANTES DEL CR LOS ESCRIBIÓ EL FIX-PACK ANTERIOR**, los dos como frases falsas
> sobre mediciones propias: un guard que publicaba una cobertura que no tenía, y una superlativa
> («42,8 % es el máximo del repo») que un barrido refuta. Ninguno rompía código. Los dos rompían
> exactamente lo que esta ola vino a producir. Están cerrados en **§9.1**, y lo que se aprendió está
> en `auto-blindaje.md`.
>
> **Base**: `chaski-v3@c1bd8d3` (antes de la ola) → `ec3fb33` (la ola) → `c823aeb` (fix-pack del AR) →
> fix-pack del CR (este commit).

---

## §0 · Lo que este reporte **NO** afirma, dicho antes de que alguien lea sus números de más

1. **Ninguna medición corrió en un teléfono.** Todo es `jsdom`. El propio archivo A lo declara en
   `src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx:31-32`.
2. **Ningún número vale para Solflare.** Ver §2.3: no es una precaución, es una medición.
3. **Ningún número dice nada del árbol nuevo**, que todavía no existe. Son **la línea de base** contra
   la que W1 y W3 van a comparar, ⛔ no una promesa sobre nada.
4. **`W0-1`/`W0-2` miden UN TRAMO**, el de ida, y el recorrido no cierra ahí. *«No se pudo medir el
   total»* ⛔ **no es** *«el total vale eso»*.

---

## §1 · Las ocho mediciones

| # | Qué mide | Bloqueante | Resultado | Veredicto |
|---|---|:---:|---|---|
| **W0-0** | El instrumento `viajesALaBilletera` sabe contestar **que SÍ** | 🔴 SÍ | El host de `urlConectar({billetera:"phantom"})` **coincide** con `HOST_DE_LA_BILLETERA`, y el filtro separa por VALOR el href de la billetera del de Solflare, del del verificador y de una cadena que no parsea | ✅ **VERDE.** Calibrado de verdad |
| **W0-1** | Travesías de la pantalla de entrada en el camino por enlace | 🔴 SÍ | **N = 2** en el **tramo de ida** | ✅ **VERDE**, con el alcance de §2 |
| **W0-2** | Viajes a la billetera en ese mismo recorrido | 🔴 SÍ | **M = 1** en el **tramo de ida** | ✅ **VERDE**, con el alcance de §2 |
| **W0-3** | **`L-5`**: el salto por enlace remonta el árbol de React | 🔴 SÍ | (a) el contenedor memoiza y `createContainer()` da objetos distintos; (b) **no hay router de cliente en `src`, `app`, `scripts` ni `contracts`** (las cuatro raíces, alineadas en el fix-pack del CR), y la única navegación blanda del árbol está fuera del recorrido y apagada por bandera; (c) el control positivo distingue | ✅ **VERDE.** `L-5` es **verdadera** ⇒ el §2 del work-item (el vale, `DT-3`, el borrador del lado del servidor) se sostiene |
| **W0-4** | El costo del camino contrario: qué cuesta una cita anclada nueva hacia `flow.tsx` | 🔴 SÍ | **Una cita ANCLADA nueva mueve 13 marcadores en 6 archivos**; una cita **SUELTA** no mueve ninguno | ✅ **VERDE** con el número **corregido** (era 12: ver §5 · `BLQ-MED-1`) |
| **W0-5** | Que el instrumento de AC-13 **discrimina** — ⛔ **no mide AC-13** | 🟡 No | **M-7 KILLED**: tres `it` rojos, y el `×` que cuenta es el de `T-065-21`. ⚠️ **`T-UI-3` NO cayó**, contra lo que el documento anticipaba | ✅ El instrumento discrimina |
| **W0-6** | **`L-4`**: si el `localStorage` cruza al navegador de la billetera | ⬜ No | **NO MEDIDA.** No es medible en `jsdom` | 📌 **Declarada** con dueño, instrumento, precondición y fecha: §8 |
| **W0-7** | Línea de base del flake preexistente | ⬜ No | **0/20 rojas** en 20 corridas serializadas propias del fix-pack | 🟡 **Es una FOTO, no un diagnóstico**: §2.2 |

---

## §2 · Los tres números de la métrica, con su etiqueta y su alcance

### 2.1 · Los números

| Número | Etiqueta | Valor | De dónde salió |
|---|:---:|---|---|
| **N · travesías de la pantalla de entrada** | 🟡 **derivado** (`jsdom`) | **2** | `T-374-W0-1`, aserción 5. Salida cruda pegada en el docblock del `it`. Las 2 son la carga inicial y la vuelta del salto al `connect` |
| **M · salidas a la billetera** | 🟡 **derivado** (`jsdom`) | **1** | `T-374-W0-1`, aserción 6. Es el `connect` del protocolo por enlace, comparado contra `urlConectar` por `pathname`, ⛔ no contra el universal link `browse`, que comparte el host |
| **k · flake heredado** | 🟡 **foto**, ⛔ no diagnóstico | **0/20** | `vuelta-por-enlace-carrera.test.tsx`, 20 corridas **serializadas**, `chaski-v3@ec3fb33` + fix-pack. ⛔ **Sin cuarentena, sin `skip`, sin tocar un `it` de ese archivo** |

⚠️ **`N` y `M` no son dos observaciones independientes: son una.** La aserción 3 del mismo `it` fija
`espia.asignado ≡ viajes`, así que `N = 1 + M` **por construcción** mientras esa aserción esté verde.
Se publican las dos porque son las dos etiquetas que W1 y W3 van a comparar, pero quien las lea no
puede tomarlas como dos mediciones distintas. Está escrito al lado del código en
`recorrido-en-el-navegador-de-la-billetera.test.tsx:1012-1019` (hallazgo `MNR-2` del AR).

### 2.2 · El **«7» heredado sigue NO VERIFICABLE**, y **«2 travesías» no es comparable con él**

Ésta es la frase que faltaba fuera de un docblock, y va acá:

> **El «7 travesías de la pantalla de entrada» heredado (`L-3` del work-item) sigue siendo NO
> VERIFICABLE: no se derivó ejecutando, ni antes de esta ola ni en ella.** El instrumento existía pero
> sólo se había corrido en el cuadrante `injected`. **Y las «2 travesías» que W0 midió NO son
> comparables con ese 7**: el 2 es **el tramo de IDA** del camino por enlace en `jsdom`, y el 7 no
> tiene tramo declarado, ni cuadrante declarado, ni corrida que lo respalde. ⛔ **Que 2 sea menor que
> 7 no dice que el recorrido se haya simplificado**: dice que se midieron dos cosas distintas, y una
> de las dos no se midió nunca.

⛔ Por eso este reporte **no publica `6`, `5` ni `7` como métrica de nada**, y el `it` tampoco los
escribe: los tres son cifras heredadas sin instrumento.

⚠️ **Sobre el `0/20`**: el flake heredado se describía como del **7-13 %**. Tres series independientes
y serializadas (el Dev en la ola, el AR en su revisión, y este fix-pack) acumulan **0/60**. Bajo
`p = 0,10` eso ocurre el **0,18 %** de las veces; bajo `p = 0,07`, el **1,28 %**. Es un indicio fuerte
de que el número heredado **no describe el árbol de hoy**, y ⛔ **no es una medición del mecanismo**:
repetir no prueba. **El número heredado merece su propia HU** (hallazgo `MNR-4` del AR, ver §10).

### 2.3 · Todo número de W0-1 y W0-2 vale para **Phantom y sólo para Phantom**

No es una salvedad de estilo: es lo que la **aserción 3** de `T-374-W0-0` afirma y pone rojo.
`viajesALaBilletera` filtra por `hostname === HOST_DE_LA_BILLETERA`, y ese host sale de
`phantomBrowseUrl`. En el mismo `it`, el href que produce `urlConectar({billetera:"solflare"})` entra
al filtro **como distractor** y **se descarta** — la aserción compara el arreglo **entero, por valor**,
así que un filtro que devolviera todo no pasaría. ⇒ **el instrumento no cubre Solflare, y el día que
alguien unifique los hosts esa frase se pone roja sola** en vez de envejecer en silencio.

---

## §3 · `W0-5` **NO** midió `AC-13`. La frase, textual

> **«AC-13 NO se midió en W0: la bandera `NEXT_PUBLIC_CHASKI_RECORRIDO_V2` no existe, porque W0
> escribe cero líneas de producción. Lo que W0-5 midió es que el instrumento que W1 va a reusar
> **discrimina**, con su mutante M-7 nombrado. AC-13 se mide en W1.»**

El motivo, en una línea: **no se puede medir la inercia de una bandera que no existe.** Decir que se
midió sería una afirmación sin sujeto.

---

## §4 · Los mutantes, y **cuál aserción** produjo cada rojo

> ⛔ Regla que se aplicó en todos: **un `1 failed` sin un `×` nombrado NO es un KILLED.** Cada mutante
> se verificó **en disco antes** de correr y se restauró **contra `/usr/bin/git diff --numstat`**,
> ⛔ nunca con un `.orig` cacheado.

### 4.1 · Los ocho de la ola (`M-0` … `M-7`)

Seis de los ocho fueron **re-aplicados por el revisor** en un worktree propio; la evidencia durable de
esos seis es la tabla A del `adversarial-review-w0.md`. Resumen:

| Mutante | Qué toca | Resultado | Nota |
|---|---|---|---|
| **M-0** | `deeplink/protocol.ts:55` | **KILLED** · `× T-374-W0-0`, aserción 1 | ⚠️ M-0 también rompe `T-DL-1/4/5` en `protocol.test.ts`: ése **no** es este KILLED |
| **M-1** | quitar el `vi.stubEnv` de `sembrarElCaminoPorEnlace` | **KILLED** · `× T-374-W0-1`, aserción 2 | ⚠️ **NO mata por el conteo.** Re-corrido en este fix-pack: §4.2 |
| **M-2** | una asignación de `location.href` de más en la rama del enlace | corrido en la ola | ⛔ la línea elegida no puede llevar marcador `[[CENSO …]]` |
| **M-3** | borrar la memoización de `container.ts:266` | **KILLED** · `× T-374-W0-3`, pata (a) | ⚠️ El falso-KILLED que el story file anticipaba **no ocurrió** |
| **M-4** | `router.push` en la **lista sintética** del control negativo | corrido en la ola | ⛔ no se escribe ningún archivo real en `src/` |
| **M-5** | `peek` devuelve siempre `null` en `sesion-store.ts:122` | **KILLED** · `× T-374-W0-3`, pata (c) | ⚠️ `sesion-store.test.ts` también se pone rojo |
| **M-6** | quitarle la coma al regex anclado local | **KILLED en dos pasos.** La aserción 3 cae **con su mensaje propio**: *«una cita SUELTA movió el conteo»* | 🔴 El hallazgo de la ola es **falsable**, no decorativo |
| **M-7** | `flow.tsx:963`, borrar el gate `mostrarSelectorDeEnlace ?` | **KILLED** · `× T-065-21` | **Tres** `it` rojos. ⚠️ **`T-UI-3` NO cayó**, contra lo que el documento anticipaba |

### 4.2 · Los del **fix-pack**, corridos en esta tarea

| Mutante | Qué se aplicó | `×` nombrado y **mensaje literal** del rojo |
|---|---|---|
| **M-8** | Archivo nuevo `src/presentation/sonda-m8.tsx` con `import Link from "next/link"` y un enlace a `/enviar` — **la sonda exacta del AR** | `× el-salto-remonta-el-arbol.test.tsx > W0-3 … > T-374-W0-3` · *«el conjunto de imports de `next/link` del árbol cambió: entró una navegación BLANDA, que NO recarga el documento, preserva el registro de módulos y vuelve a poner en duda `L-5`: expected [ …(2) ] to deeply equal [ Array(1) ]»* |
| **M-8b** | La misma sonda pero importando `Link` de **otro** módulo (`./cn`), o sea **sólo** el JSX `<Link>` | `× … T-374-W0-3` · *«apareció un enlace de `next/link` fuera de la página apagada del simulador de KYC: es una navegación blanda del App Router y el recorrido no puede tener ninguna: expected [ …(2) ] to deeply equal [ 'app/kyc-simulado/page.tsx' ]»* |
| **M-8c** | `app/kyc-simulado/page.tsx:72`: `if (!mockDiditSurfaceEnabled()) notFound();` → `if (false) notFound();` (**producción, restaurada en la misma tarea**, verificado con `git diff --numstat`) | `× … T-374-W0-3` · *«la página que aloja el único enlace blando del árbol dejó de cortar con `notFound()` cuando la bandera del simulador está apagada …: expected false to be true»* |
| **M-6b** | En archivo B, la cita anclada de sonda apunta a `flow.tsx:163` (una línea **ya citada**) en vez de `:100` | `× costo-de-una-cita-anclada.test.ts > … > T-374-W0-4` (en aquella corrida el archivo se llamaba `el-arbol-propio-cuesta-cero-citas.test.ts`: `MNR-3` del CR) · *«una cita ANCLADA nueva hacia una línea que nadie citaba no movió los `destinos` …: expected 96 to be 97»* |
| **M-6b + neutralizador** | Lo anterior **más** aflojar la aserción de `destinos`, para **alcanzar** la aserción de los 13 | `× … T-374-W0-4` · *«una cita anclada nueva dejó marcadores en su sitio: el costo declarado es menor que el real: **expected 12 to be 13**»* ⇒ el hallazgo del AR reproducido al número |
| **M-9** | `viajesALaBilletera`: el `catch { return false }` → `catch (e) { throw e }` | **1 failed \| 7 passed (8)**, único rojo `× T-374-W0-0` con `TypeError: Invalid URL: no-soy-una-url`. ⚠️ Es un rojo del `URL`, **no** de una aserción, y así está escrito en el docblock |
| **M-10** | En la mitad (a) de `T-374-W0-1`, saldo `1_000_000_000` → `0` (**la reproducción A del AR**) | `× … T-374-W0-1` · *«`pedir()` no dejó ni una anotación: `execute` falló ANTES de llegar al gate del camino por enlace, y este `it` estaría dando verde por VACÍO …: expected [] to not deeply equal []»* ⇒ **con la aserción vieja esta misma configuración daba VERDE** |
| **M-1** (re-corrido) | quitar el `vi.stubEnv` con la aserción **nueva** ya puesta | `× … T-374-W0-1` · *«`pedir()` contestó otra cosa que la del árbol sano …: expected [ 'no-corresponde' ] to deeply equal [ 'TIRÓ: deeplink\_viaje\_vencido' ]»* ⇒ sigue matando **por el gate y no por el conteo** |

### 4.3 · Un control **medido como vacío** y corregido: la exclusión `SELF` del archivo B

El archivo B decía que sin la exclusión por ruta *«se contaría a sí mismo»*. **Medido quitándola: el
`it` sigue en `1 passed`.** Lo que de verdad impide la auto-lectura es que las citas de mentira se
arman **por concatenación**, así que ninguna línea del archivo contiene el patrón anclado entero. **La
decisión de excluirse se queda** (es el cinturón sobre el tirante), **el motivo escrito se corrigió.**
⚠️ En `el-salto-remonta-el-arbol.test.tsx` la exclusión análoga **sí** es load-bearing —ese archivo
escribe los seis delatores en su prosa y en su control negativo— y ahí la prosa era correcta.
⚠️ **El archivo B se llama hoy `src/composition/costo-de-una-cita-anclada.test.ts`**: hasta el `MNR-3`
del CR se llamaba `el-arbol-propio-cuesta-cero-citas.test.ts`, que era **el nombre de la medición
abandonada**. Ver §9.1.

### 4.4 · Los del **fix-pack del CR**, corridos en esta tarea

⛔ Numerados **M-11** en adelante para no pisar los `M-9`/`M-10` de §4.2, que son otros.

| Mutante | Qué se aplicó | `×` nombrado y **mensaje literal** del rojo |
|---|---|---|
| **M-11** | `app/kyc-simulado/page.tsx:72`: partir `if (!mockDiditSurfaceEnabled()) notFound();` en **dos líneas**, sin cambiar el comportamiento. **Producción, restaurada en la misma tarea** y verificada con `/usr/bin/git diff --numstat` vacío | **Suite ENTERA: `1 failed \| 3494 passed (3495)`.** Único rojo `× el-salto-remonta-el-arbol.test.tsx > W0-3 … > T-374-W0-3` en `:244` · *«la línea que conjuga `mockDiditSurfaceEnabled()` y `notFound()` desapareció de `app/kyc-simulado/page.tsx` … expected false to be true»* |
| **M-12** | En `PATRONES`, devolverle a `useRouter` la forma de **substring crudo** (`/useRouter/`) | `× … T-374-W0-3` en `:272` · *«… o volvió a cazar PROSA, que es el falso rojo que le espera a cada docblock que W1 escriba: expected [ Array(7) ] to deeply equal [ Array(6) ]»* ⇒ la 7ª entrada es la línea de prosa del fixture |

🔴 **Por qué M-11 es el mutante correcto y `E1`/`E2` no lo son.** Los dos escapes que el CR midió
(§9.1) **cambian el comportamiento**, y por eso los mata `T-GATE-3'`: usados como mutantes de esta
aserción serían **falsos KILLED**, porque el `it` de `W0-3` ni siquiera se pone rojo con ellos. M-11
deja el comportamiento **idéntico** —`T-GATE-3'` y su control positivo quedan verdes— y mueve **sólo**
la forma del texto. El `1 failed` de una suite de 3495 con el `×` en el `it` correcto es la prueba de
que la aserción no es decorativa **y** de que su alcance declarado es exacto: **vigila forma**.

### 4.5 · Tres controles **medidos como no load-bearing**, y declarados en vez de prometidos

| Qué se probó | Cómo | Resultado |
|---|---|---|
| **`E1`** · invertir el corte ⇒ `if (mockDiditSurfaceEnabled()) notFound();` | mutante por número de línea, verificado en disco | `el-salto-remonta-el-arbol.test.tsx` **VERDE**. Los rojos son `T-GATE-3'` y su control positivo |
| **`E2`** · reemplazar el corte por un `/** … */` que lo mencione | ídem | `el-salto-remonta-el-arbol.test.tsx` **VERDE** (`PASS (28) FAIL (2)` sobre los tres archivos corridos). Los rojos son `T-GATE-3'` (`kyc-simulado-gate.test.ts:125`) y `G-1` (`kyc-provider-residue.static.test.ts:253`) |
| La cláusula `!l.trimStart().startsWith("//")` | reemplazada por `true` | El `it` **sigue verde** ⇒ **hoy no vigila nada**: ninguna línea de comentario de esa página conjuga además `mockDiditSurfaceEnabled()`. Se queda de cinturón y ⛔ está escrito al lado que no es load-bearing |

---

## §5 · Las cinco correcciones **C-1 … C-5**

| | Qué decía el SDD / el work-item | Qué es en realidad | Qué se hizo |
|---|---|---|---|
| **C-1** | *«3 archivos tocados»* | **Son 5**: W0 agrega 2 archivos `*.test.*` bajo `src/`, y `readme-test-count.test.ts` compara ese conteo contra **los DOS README** por separado. Conteo real: `172` → **`174`** | Los dos README entraron al Scope IN y el número se derivó **corriendo el candado**, ⛔ nunca contando a mano |
| **C-2** | *«`caminoPorEnlace()` no es `null`»* | **`caminoPorEnlace` es `private`** (`src/infrastructure/solana-wallet.ts:2239`): **no se puede llamar desde un test** | El observable pasó a ser `pop.respuestas` del `PopDelAdaptadorReal`, que anota qué contestó `pedir()`. ⚠️ Y esa aserción tenía a su vez un agujero, cerrado en este fix-pack: `BLQ-MED-2` de §9 |
| **C-3** | *«el desenlace se alcanzó»* en el camino por enlace | **Un envío por enlace NO cierra en una sola pasada, y no es un defecto: es lo que el camino ES.** El propio repo lo tenía escrito | El desenlace se partió en **tramos**, cada uno con su propio desenlace afirmable. ⛔ No se aflojó la aserción: se dice **de cuál tramo** es el número |
| **C-4** | `T-065-21` compara el `innerHTML` con `toBe(apagada)` | 🔴 **Ese `toBe(apagada)` NO EXISTE.** Verificado con `/usr/bin/grep -n "apagada" src/presentation/wallet-availability.test.tsx`: aparece en `:666`, `:1010`, `:1035`, `:1044`, `:1047`, `:1048`, `:1063`, `:1066`, `:1179`, `:1182`, y **la única aserción con `apagada` es `.not.toBe(apagada)` en `:1066`**. El comentario de `:1063` cita *«el `toBe(apagada)` de arriba»*, **que no está en el archivo** | Queda **declarado acá**, porque **W1 tiene que saberlo antes de copiar el molde**. Lo que ese `it` realmente afirma: (a) `apagada` es truthy (`:1048`), (b) el selector **no** está en el DOM con la bandera apagada (`:1049`), (c) `prendida !== apagada` (`:1066`). La *«byte-identidad»* de su nombre es **un nombre, no una aserción** |
| **C-5** | *«Prosa dentro de los tests ≤ 55 %»*, comparado contra módulos de la casa al 71-78 % | 🔴 **Ésos eran módulos de PRODUCCIÓN**, y eso sigue en pie. 🔴 **Pero la corrección tenía a su vez una superlativa FALSA**, y es el `BLQ-MED-2` del CR: decía que **42,8 % era «el máximo del repo»**, sacado de **cuatro archivos elegidos a mano**. Barrido el árbol entero con el mismo contador, el máximo es **65,0 %** y hay **26 de 174** archivos de test por encima de 42,8 %. Ver **§7.2**, que publica el contador y la aritmética | El techo formal **≤55 %** no se movió. Lo que se cae es el argumento de que *«no puede binderar»*: **hay archivos de la casa por encima del 55 %**, el mayor al 65,0 %. **El «número operativo 42,8 %» queda RETIRADO** —era una foto de cuatro archivos, no una vara— y lo reemplaza una vara derivada del barrido: **§7.2** |

---

## §6 · Las observaciones, **declaradas y no arregladas** (son producción · `CD-W0-1`)

- **`OBS-1`** · `src/presentation/bitacora-de-vuelta.ts:176` dice que `flow.tsx` lleva marcadores
  `[[CENSO … entrantes]]` **«en ocho archivos»**. **Son seis**, medido: `confirm-and-send.ts`,
  `diagnostico-de-vuelta.tsx`, `flow-vm.test.ts`, `flow-vm.ts`, `flow.tsx` y `app/page.tsx`. Es
  exactamente el conjunto que `T-374-W0-4` deriva y afirma (`[6, 12, 8, 1]`). ⛔ **No se arregla en
  W0**: esa línea es producción y W0 escribe cero.
- **`OBS-5`** · `it("T-372-W3-8: …")` en `src/presentation/sesion-borra-la-segunda-firma.test.tsx:539`
  **no renderiza ningún árbol**: no hay un solo `render(` ni un `screen.` en su cuerpo, ejercita los
  casos de uso directamente. ⇒ **`DT-5` no tiene candado sobre el árbol renderizado**, y quien lo dé
  por cubierto se va a apoyar en un verde que mide otra cosa.

---

## §7 · El contraste de presupuesto, **por columna**

Medido sobre `/usr/bin/git add -A && /usr/bin/git diff --cached c1bd8d3 --numstat`, o sea **la ola
entera con sus DOS fix-packs**, ⛔ nunca sumando deltas a un total anterior.

| Columna | Techo (§9 del story file) | **Medido** | % | Veredicto |
|---|---:|---:|---:|---|
| 🔴 **Producción ejecutable** | **0** ⛔ estricto | **0** | — | ✅ |
| 🔴 **Producción · comentario / prosa** | **0** ⛔ estricto | **0** | — | ✅ |
| **Test · total (código + prosa + blancos)** | ≤ 520 | **790** | **151,9 %** | ⚠️ **excedido**, justificado abajo |
| · archivo **A** `recorrido-…test.tsx` | ≤ 190 | **263** | 138,4 % | ⚠️ |
| · archivo **B** `costo-de-una-cita-anclada.test.ts` | ≤ 160 | **231** | 144,4 % | ⚠️ |
| · archivo **C** `el-salto-remonta-…test.tsx` | ≤ 170 | **296** | 174,1 % | ⚠️ |
| **Test · prosa (ratio del bloque)** | ≤ 55 % **formal**. ⛔ El *«42,8 % operativo»* queda **RETIRADO**: era falso (§7.2) | **49,5 %** (373 prosa / 380 código, 37 blancos afuera) | 5,5 pts **bajo** el techo formal | ⚠️ justificado abajo |
| **Test · prosa · el peor archivo completo** | ≤ 55 % formal | **C, 54,5 %** (156 / 130) | **0,5 pts** de margen | ⚠️ el techo formal SÍ bindea, y por poco |
| **README** | 2 líneas (1 por archivo) | **2** | — | ✅ |
| **Archivos tocados** | 5 | **5** | — | ✅ (el archivo B **se renombró**, no se agregó otro: `MNR-3`) |
| 🔴 **Archivos de producción tocados (diff final)** | **0** ⛔ | **0** | — | ✅ |

**Δ0 verificado con `wc -l`, ⛔ no leyendo el diff**: `src/presentation/flow.tsx` = **4453** líneas,
igual que el marcador `[[CENSO … lineas=4453]]`. `src/infrastructure/solana-wallet.ts` = 2498, sin
tocar. **Cero citas ancladas nuevas hacia cualquier archivo con marcadores `[[CENSO … entrantes]]`**:
las dos citas ancladas que el fix-pack agrega apuntan a `src/infrastructure/mock-surface.ts:51` y al
propio archivo A `:294`, y **ninguno de los dos lleva marcador de censo**. `citas-ancladas.test.ts`
verde (**9 passed**).

### 7.1 · La justificación escrita del exceso, **columna por columna**

> La pregunta que decide un exceso: *¿qué parte de esto seguiría existiendo si lo escribiera alguien
> que ya conoce este repo?*

**En cuál columna está**: **entera en la columna «Test»**. Producción es **0 y 0**, sin excepción, y
ésa es la columna donde vivieron los tres bloqueantes de la ola anterior.

**Las 790 líneas contra el techo de 520 (151,9 %).** El techo se fijó para la ola **antes** del AR y
del CR, y **ninguna de las dos revisiones lo bajó: las dos pidieron más control**. De las 200 líneas
que agregan los dos fix-packs, **ninguna es un `it` nuevo**: son dos patrones más en un barrido, tres
aserciones que cierran un guard ciego, una que cierra un verde por vacío, una que faltaba sobre
`destinos`, seis patrones que dejan de matchear prosa, **dos mutantes declarados y corridos** y **la
prosa que dice qué se midió y con qué**. ⛔ **Se rechaza la salida barata de recortar la prosa de los
mutantes y de los controles negativos**: es lo que evita los falsos KILLED que ya mordieron tres veces
acá, y los dos bloqueantes del CR son la prueba de lo contrario —lo que falló no fue prosa de más,
fueron **tres frases que afirmaban más de lo medido**—.
🔴 **Y sí se recortó lo que el CR nombró como sobreprecio real**: las 12 líneas que explicaban que la
exclusión `SELF` del archivo B **no** es load-bearing pasaron a **7**, sin perder el hecho medido.
**No se cruza el umbral de 2x** (>800 líneas de test) que el story file fijó como línea de recorte,
⚠️ **por 10 líneas.** El que abra W1 tiene que saber que ese margen es eso y no más.

**El 49,5 % de prosa del bloque, contra el techo formal de 55 %.** ⛔ La referencia *«42,8 %
operativo»* **ya no se usa: era falsa** (`BLQ-MED-2`, §7.2). Contra el techo que sí existe, el bloque
está **5,5 puntos por debajo**. Por archivo completo: **A 33,9 %** (332/648), **B 43,0 %** (92/122),
**C 54,5 %** (156/130) — y ese **54,5 % es el número incómodo de la ola**: deja **0,5 puntos** de
margen contra el techo formal, así que el techo **sí bindea**, al revés de lo que decía la corrección
anterior. C es el archivo del barrido de `L-5`, el que tiene el hallazgo más caro de la ola, el único
que tiene que explicar **por qué una ocurrencia viva en el árbol no cuenta**, y el que se llevó los
dos bloqueantes de las dos revisiones. ⚠️ **W1 no puede tratar el 55 % como inalcanzable.**
⚠️ **Y el techo de prosa de PRODUCCIÓN no se movió ni un punto**: acá se cumple por construcción,
porque no hay denominador.

### 7.2 · 🔴 La vara de prosa, **derivada con un barrido** y no elegida a mano (`BLQ-MED-2`)

**Qué se afirmaba y por qué era falso.** `story-W0.md:62` y `:974-978`, y de ahí `w0-report.md` en
tres sitios, publicaban que **42,8 %** era *«el máximo del repo»* y que por eso *«un techo del 55 %
está 12 puntos por encima del test más prosaico que existe»*. Los **cuatro números individuales
reproducen al decimal**; lo que no reproduce es **el cuantificador**: salían de **cuatro archivos
elegidos a mano**, no de un barrido. **El máximo real es 65,0 %.**

**El contador, publicado para que el número re-derive** (⛔ no una tabla a mano: una función). `prosa`
= línea cuyo contenido trimeado empieza con `//`, `/*` o `*`; `codigo` = línea no vacía que no es
prosa; **las líneas en blanco no entran en ningún lado**; `ratio = prosa / (prosa + codigo)`. Se
aplica a todo archivo que matchee `/\.(test|spec)\.(c|m)?[jt]sx?$/` bajo `src`, `app`, `scripts` y
`contracts`, saltando `node_modules`, `.next`, `doc` y `migrations`.

```js
export function ratio(texto) {
  let prosa = 0, codigo = 0;
  for (const linea of texto.split("\n")) {
    const t = linea.trim();
    if (t === "") continue;
    if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) prosa += 1;
    else codigo += 1;
  }
  return prosa / (prosa + codigo);
}
```

**Calibración del contador antes de usarlo**: reproduce **los cuatro números heredados al decimal** —
`recorrido-…test.tsx` 33,9 % (332/648), `sesion-borra-la-segunda-firma.test.tsx` 27,9 % (169/436),
`citas-ancladas.test.ts` 42,1 % (173/238), `vuelta-por-enlace-carrera.test.tsx` 42,8 % (137/183). Es
el mismo instrumento; **lo que cambia es que ahora se lo corre sobre los 174 archivos y no sobre 4**.

**El barrido, sobre `chaski-v3` con este fix-pack aplicado — 174 archivos de test:**

| Archivo | prosa / código | ratio |
|---|---:|---:|
| `src/composition/prepared-claims-guard.static.test.ts` | 147 / 79 | **65,0 %** ← **el máximo real** |
| `src/composition/principal-tx-single-writer.static.test.ts` | 310 / 170 | 64,6 % |
| `src/presentation/titulos.test.tsx` | 58 / 40 | 59,2 % |
| `app/viewport.test.ts` | 37 / 27 | 57,8 % |
| `app/kyc-simulado/kyc-simulado-gate.test.ts` | 107 / 79 | 57,5 % |
| `src/presentation/recuperar-composicion.test.tsx` | 346 / 257 | 57,4 % |
| `src/presentation/bienvenida-composicion.test.tsx` | 580 / 451 | 56,3 % |
| — *techo formal ≤55 %* — | | |
| `src/presentation/el-salto-remonta-el-arbol.test.tsx` **(archivo C)** | 156 / 130 | **54,5 %** |
| `src/composition/costo-de-una-cita-anclada.test.ts` **(archivo B)** | 92 / 122 | 43,0 % |
| `src/presentation/vuelta-por-enlace-carrera.test.tsx` | 137 / 183 | 42,8 % ← *el «máximo» que se publicaba* |

⛔ **Los archivos de la casa que están por encima del techo formal del 55 % son los que van desde el
máximo hasta la fila marcada**, y están nombrados uno por uno a propósito: un conteo suelto no se
puede auditar, y acá se afirma **qué archivos** son, no cuántos.

**Aritmética de las consecuencias, con la cuenta a la vista:**
- **Por encima de 42,8 %**: **26 de 174** archivos. Sacando los **dos** que esta ola escribió (C al
  54,5 % y B al 43,0 %), quedan **24 de 172** archivos preexistentes ⇒ 42,8 % **no era ni cerca** el
  máximo: es aproximadamente el **percentil 86** de la distribución.
- **Distribución de los 172 preexistentes**: mediana **26,8 %**, p75 **37,1 %**, p90 **48,0 %**,
  máximo **65,0 %**.
- ⇒ **El argumento de que el 55 % «no puede binderar» se cae.** Ya está excedido por siete archivos
  de la casa, y el archivo C de esta ola quedó a **0,5 puntos** de tocarlo.

**Qué queda como vara para W1**, sin superlativas: el **techo formal ≤55 %** (que bindea de verdad), y
la distribución de arriba para saber dónde se está parado. ⛔ **No hay «número operativo»**: el
anterior era una foto de cuatro archivos y por eso se pudo publicar como máximo sin que nada lo
contradijera. ⚠️ **Y esto no se cablea como test.** Un guard que pusiera rojo un archivo por su ratio
de prosa haría rojo cada docblock nuevo, que es justo lo que estas dos revisiones vinieron a premiar;
lo que se deja es **el contador de acá arriba, ejecutable en treinta segundos**, que es lo que le
faltó a la afirmación que estamos corrigiendo.

---

## §8 · `W0-6` · **`L-4`** — la declaración, con dueño, instrumento, precondición y fecha

`W0-6` **NO se midió**, y eso no es una omisión: **no es medible en `jsdom`**. Que el `localStorage`
cruce del navegador del sistema al navegador embebido de la billetera es una propiedad **del
teléfono**, y ningún `it` de este repo corre en uno.

⛔ ***«No se pudo medir» NO es «no cruza».*** La respuesta tiene **tres** valores, y hoy estamos en el
tercero. Ninguna línea de este reporte, del story file ni de los tests afirma nada sobre si el disco
cruza.

| | |
|---|---|
| **Qué se mide** | Si `window.localStorage` del navegador del sistema es visible desde el navegador embebido de la billetera, para el mismo origen (`L-4`) |
| **Dueño** | **El founder.** ⛔ No es delegable: requiere su teléfono físico con la billetera instalada |
| **Instrumento** | El bloque de diagnóstico de la app con `?diag=1`, más la **marca de vuelta** que el recorrido ya escribe en la barra al salir. Se aterriza en el navegador embebido y se lee si el hito publica `con-marca-y-borrador` o `con-marca-sin-borrador` |
| **Precondición** | 🔴 **Testnet Mode encendido en Phantom.** Sin él, Phantom vuelve **sin nada y sin error**, y la medición saldría negativa por una causa que no es la que se está midiendo |
| **Cuándo** | **Ola W3** de esta HU |
| **Qué pasa si sale que NO cruza** | Es el caso que el diseño ya asume: `DT-3` y el borrador del lado del servidor existen justamente para eso. **Si sale que SÍ cruza**, hay que volver a mirar si el vale sigue haciendo falta |

---

## §9 · Lo que el AR encontró, y qué hizo este fix-pack

| Hallazgo | Qué estaba roto | Qué se hizo | Criterio de cierre |
|---|---|---|---|
| 🔴 **`BLQ-ALTO-1`** | El candado de `L-5` era **ciego a `next/link`**, y había —y hay— una navegación **blanda VIVA** en `app/kyc-simulado/page.tsx:114`, **una línea debajo** del import que el `it` pinnea como *«la única ocurrencia permitida»*. Una sonda con un `<Link>` nuevo dejaba el `it` en `✓ (1 test)` | `next/link` y `<Link` entraron a `PATRONES` (`el-salto-remonta-el-arbol.test.tsx:71`), con **dos aserciones de ocurrencia permitida** (`:204`, `:209`), **su control negativo sintético** (`:260-261`) y **la razón escrita** de por qué el `<Link>` del simulador de KYC no cuenta (`:192-202`). ⚠️ La conclusión **`L-5 = verdadera` no se tocó**: lo roto era la cobertura | ✅ **La sonda del AR pone el `it` ROJO** con `×` nombrado: §4.2, M-8 |
| 🟠 **`BLQ-MED-1`** | El número publicado era **12** y son **13**: el `it` filtraba a `porCampo("entrantes")` y **nunca evaluaba `destinosDe`** | El nombre del `it` (`:141`), la aserción (`:195`) y **una aserción nueva sobre `destinos`** (`:187`). **El 13 se re-derivó acá**, con una sonda propia: `entrantes 165 → 166` (12 marcadores) **+** `destinos 96 → 97` (1 marcador) = **13**, en **6** archivos | ✅ M-6b y su segundo paso: `expected 12 to be 13` |
| 🟠 **`BLQ-MED-2`** | La mitad (a) de `T-374-W0-1` daba **verde por VACÍO**: con `pop.respuestas === []`, `[] !== ["no-corresponde"]` pasaba. Y **el observable real del árbol sano era otro** | Ahora se exige **que haya observable** y se compara **por valor** (`:933-957`). **El valor real, medido acá con la sonda `SONDA-W0-1a` y no copiado: `["TIRÓ: deeplink_viaje_vencido"]`** — `pedir()` no contesta: **TIRA**, y `PopDelAdaptadorReal` anota el throw y lo deja subir | ✅ M-10 pone rojo lo que antes era verde |
| 🟡 **`BLQ-BAJO-1`** | Tres números falsos en el docblock de la función que la ola vino a calibrar | Re-derivados: **8** `it` (no 6), **5** llamadores `:395 :737 :763 :833 :984` (no 3), y **al `catch` HOY SÍ le llega algo** desde `T-374-W0-0`. `recorrido-…test.tsx:207` | ✅ M-9: **1 failed \| 7 passed (8)** |
| 🟡 **`BLQ-BAJO-2`** | El reporte de W0 **no existía**, y el commit afirmaba que la declaración de `W0-6` estaba escrita | **Este documento** | ✅ `D10`, `D17`, `D18`, `T42` y `T43` ya tienen dónde verificarse |
| **`MNR-1`** | La razón escrita de la exclusión `SELF` del archivo B era **falsa** | Corregida y **medida** (§4.3). ⚠️ En el archivo C la exclusión **sí** es load-bearing y su prosa **no se tocó** | ✅ |
| **`MNR-2`** | En el tramo de ida `N` y `M` son **el mismo número** | Dicho, con el porqué y con qué lo haría divergir (`:1012-1019`) | ✅ |
| **`MNR-3`** | *«el filtro se ejercitaba en TRES sitios»* no re-derivaba, y estaba anclado a *«al escribir esto»* sin commit | Anclado a **`chaski-v3@c1bd8d3`** y verificado con `/usr/bin/git show c1bd8d3:… \| grep -n` ⇒ **3 sitios en aquel commit**, y **5 hoy**, con los dos nuevos nombrados (`:787-794`) | ✅ |

### 9.1 · Lo que el **CR** encontró, y qué hizo este segundo fix-pack

| Hallazgo | Qué estaba roto | Qué se hizo | Criterio de cierre |
|---|---|---|---|
| 🟠 **`BLQ-MED-1`** | El predicado del corte publicaba, tres veces, que *«exige los dos símbolos en la misma línea Y QUE NO SEA UN COMENTARIO»* y que *«si alguien le saca el corte, esto cae»*. El predicado real usa `!l.trimStart().startsWith("//")`: eso es *«no es un comentario de LÍNEA»*. Dos escapes de una línea (`E1`, `E2`) lo dejan **verde** | 🔴 **Se eligió la opción (b) del CR: la frase deja de prometer.** El docblock ahora dice **literal** qué exige la aserción, declara los dos escapes **re-medidos acá** (§4.5), y **cita a `T-GATE-3'` como el candado real del corte**, que lo mide llamando a la página. El mensaje del assert dejó de afirmar *«dejó de cortar»* y afirma lo que la aserción sabe: que la línea **desapareció**. Y se declaró el mutante que le faltaba (`CD-W0-6`) | ✅ **M-11**, §4.4: suite entera `1 failed \| 3494 passed`, único rojo el `it` correcto, con `T-GATE-3'` **verde** |
| 🟠 **`BLQ-MED-2`** | *«42,8 % es el máximo del repo»* es **falso**: salía de cuatro archivos elegidos a mano. El máximo real es **65,0 %**, y con él se caía el argumento del §9.2 del story file y **la vara que W1 iba a heredar** | **§7.2**: el máximo se derivó con un **barrido publicado con su contador**, se re-escribieron **C-5**, la fila del presupuesto y **§7.1**, y el *«número operativo 42,8 %»* quedó **retirado**. La vara pasa a ser el techo formal ≤55 %, que **sí bindea** | ✅ El número re-deriva corriendo el contador de §7.2 |
| **`MNR-1`** | `leerElArbol`, `type Fuente`, `SKIP` y `EXTS` duplicados byte a byte entre los dos archivos nuevos, **sin una línea que lo explique**, y divergiendo (4 raíces contra 2). Y `no-evm-surface.test.ts` es el mismo guard por tercera vez, sin que ninguno lo cite | **Se escribió por qué NO se extrae** (`CD-W0-1`: un helper fuera de un `.test.` es producción; y un punto de falla único cegaría tres guards juntos), **se cita el tercero** en los dos archivos, y **se alinearon las raíces**. ⚠️ Medido antes de alinearlas: **cero ocurrencias** de los seis delatores en `scripts` y `contracts` ⇒ ninguna aserción se movió | ✅ Los dos archivos verdes con 4 raíces |
| **`MNR-2`** | `PATRONES` eran substrings crudos ⇒ **el guard matcheaba PROSA**. Medido: una nota que dijera *«acá NUNCA se usa useRouter»* ponía la suite roja, **y W1 va a escribir justamente esos docblocks** | Los seis pasaron a ser **import-shaped / call-shaped / JSX-shaped**, con el molde de `no-evm-surface.test.ts:56` citado, y el control negativo sintético ganó **dos líneas de prosa que NO pueden aparecer** en la salida | ✅ **M-12**, §4.4 |
| **`MNR-3`** | El nombre del archivo B nombraba la **medición abandonada**, y el nombre es lo que se grepea | **Renombrado a `costo-de-una-cita-anclada.test.ts`.** Impacto medido antes: **1 sitio en el repo**, **8 en los documentos** (1 de ellos en el AR, que ⛔ no se reescribe) y **ninguno** en los mensajes de commit ni en el CR. El nombre viejo quedó escrito en el docblock **para que un grep por él siga aterrizando ahí** | ✅ `npm run qa` verde con el nombre nuevo |

---

## §10 · Lo que queda **abierto** y no es de esta ola

- **`MNR-4`** — el flake heredado de **7-13 % es hoy un número sin testigo**. Acumulado **0/60** entre
  tres series independientes (§2.2). **No es defecto de W0**: es una HU propia, la de **medir el flake
  heredado** con su mecanismo y no con repeticiones.
- **`MNR-5`** — la fila 234 de `doc/sdd/_INDEX.md` sigue diciendo *«6 mediciones»* (son **8**) y
  publica **«2 salidas»**, que `CD-W0-14` declara **no publicable**. **Es trabajo del cierre**, no del
  fix-pack.

**Y los tres menores del CR que este fix-pack NO tomó**, con su medición para que el que los cierre no
tenga que volver a levantarla (el detalle largo está en `auto-blindaje.md`):

- **`MNR-4` del CR** — *«47 ocurrencias preexistentes»* de anclas partidas es un número **sin patrón
  publicado**: con dos lecturas igual de plausibles da **46** o **47**. El número no está mal; lo que
  falta es **el patrón que lo re-deriva**, y sin él nadie puede decir cuál de las dos lecturas se usó.
- **`MNR-5` del CR** — dos mensajes de aserción que **afirman de más**, medidos por el CR.
- **`MNR-6` del CR** — el nombre de un `it` promete un observable que el `it` no observa: la pata (b)
  asserta **ausencia**, y el docblock lo dice bien. Es el nombre, no la medición.

⚠️ Los tres son de la misma familia que los dos bloqueantes del CR: **prosa que afirma más de lo que
el código verifica.** Cerrarlos es barato y ⛔ dejarlos sin domicilio no.

---

## §11 · El gate, **entero y en orden**

Corrido **después** de `/usr/bin/git add -A`, sobre el índice, ⛔ nunca sobre un árbol donde el
entregable todavía no existe.

| Paso | Comando | Resultado |
|---|---|---|
| 1 | `/usr/bin/git add -A` | **2 entradas**: el **renombre** del archivo B (`R`) y la modificación del archivo C |
| 2 | `npm run qa` (`lint` → `typecheck` → `typecheck:scripts` → `test`) | **exit 0** · **174 archivos de test · 3495 tests, todos verdes** |
| 3 | `npm run build` | **exit 0** · el manifiesto de rutas incluye `ƒ /kyc-simulado`, sin cambios |

⛔ Sin `npx biome` ni `npx tsc` sueltos. **Correr las partes de un gate no es correr el gate**: la
primera corrida de esta ola salió **roja** y la cazó `npm run qa` entero, no el Dev — un ancla elegida
por el concepto en vez de por un símbolo presente en la línea citada.

**Δ0 re-verificado con `/usr/bin/wc -l`, ⛔ no leyendo el diff**: `src/presentation/flow.tsx` = **4453**
(igual al marcador `[[CENSO … lineas=4453]]`), `src/infrastructure/solana-wallet.ts` = **2498**.
**Producción: 0 y 0** en el `--numstat` contra `c1bd8d3`. **Las cinco citas ancladas nuevas de este
fix-pack** apuntan a `no-evm-surface.test.ts:35` (dos veces, una desde cada archivo) y `:56`, a
`costo-de-una-cita-anclada.test.ts:77` y a `el-salto-remonta-el-arbol.test.tsx:114`, y **ninguno de
esos archivos lleva un marcador `[[CENSO … entrantes=]]`** (verificado con `/usr/bin/grep -rln` sobre
las cuatro raíces). `citas-ancladas.test.ts` verde dentro del `npm run qa`.

⚠️ **Y las cinco quedaron en UNA sola línea, a propósito y después de un tropiezo propio.** Tres de
ellas habían quedado **partidas por un salto de línea** dentro del docblock, que es exactamente el
agujero *«roto y verde POR AUSENCIA»* que el archivo B documenta: el candado real **no cuenta** un
ancla partida, así que los tres anclas `:56`, `:77` y `:114` **no los habría verificado nadie** y
habrían envejecido en silencio. Se detectó enumerando las citas del propio diff con
`/usr/bin/git diff --cached c823aeb -- src | grep -o "(\`sym\`, \`ruta:NN\`)"` y comparando con las
que se habían escrito. **Escribir una cita anclada no es que alguien la vigile: la vigila sólo si
entra entera en una línea.**

---

*Reporte de la ola **W0** · WKH-374 · `chaski-v3` · 2026-09-01 · **los dos fix-packs cerrados** (AR y
CR) · ⛔ cero líneas de producción en el diff final.*
