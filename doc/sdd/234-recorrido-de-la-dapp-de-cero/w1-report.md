# WKH-374 · OLA W1 — Reporte de implementación (F3)

> Escrito por `nexus-dev` el 2026-09-01, **antes** del commit de cierre de la ola (`CD-W1-19`).
> Repo del trabajo: `chaski-v3`, rama `feat/234-w1-cinco-pantallas`, desde `main@25c3f73`.
> ⛔ **De `wasiai-a2a` no se tocó una sola línea de `src/`.**

---

## 1 · 🔴 La puerta de la ola: `T-374-W1-0`

**VERDE, y nunca estuvo roja.** Corrió por primera vez el mismo día que se escribió y pasó.

`src/presentation/recorrido/salto.test.ts:46` —
`it("T-374-W1-0: el universo de marcas de vuelta se DERIVA de producción, y ninguna queda sin aterrizaje")`

Sus cuatro patas, en orden:

1. **Calibración** — la tupla de marcas importada de producción tiene al menos seis entradas, todas
   cadenas no vacías y todas distintas, y las dos marcas compuestas no colapsan con ninguna de ellas.
2. **Toda marca aterriza en un paso de la tabla** de `pasos.ts`.
3. **Ninguna aterriza en la pantalla de entrada**, comparado por valor contra el `id` del paso.
4. **Control negativo** — una marca sintética recibe el **tercer valor** `"sin-aterrizaje"`, y ese
   tercer valor no se cuela como si fuera un paso.

⚠️ **Una limitación de la calibración, declarada.** `CD-W1-7` prohíbe escribir los literales de las
marcas en el árbol nuevo **y en sus tests**. Eso hace imposible transcribir «los seis de hoy» sin
violar la misma regla que el archivo mide. Lo que la calibración sí exige es el piso de seis, la
unicidad y la no-vacuidad: con eso, un import roto (`[]`) o colapsado se pone rojo, que es el modo de
falla por el que la calibración existe.

🔴 **CORRECCIÓN DEL FIX-PACK (AR/`MNR-1`) — acá se declaraba el agujero EQUIVOCADO.** Este párrafo
decía que la calibración *«no cierra el caso de que producción RENOMBRE las seis manteniendo el
conteo»*. **Ese caso es inofensivo**: las claves de la tabla de aterrizaje de `salto.ts` salen de la
MISMA tupla, así que un renombre mueve las dos puntas a la vez y no rompe nada. El agujero real era
otro y no estaba escrito: **una PERMUTACIÓN** de la tupla re-apunta la tabla (indexada por posición)
y las cuatro aserciones seguían verdes, porque **las cuatro son invariantes bajo permutación**.

**Se cerró para tres de las seis marcas**, con las constantes que producción exporta con nombre
propio (`MARCA_CREAR_NONCE`, `MARCA_POP_PAYOUT`, `MARCA_POP_KYC`) y ⛔ sin escribir un solo literal:
`T-374-W1-0` afirma ahora la **ligadura marca → paso**, que es justo lo que una permutación rompe.
Medido con `MW-19` (permutar `crear-nonce` con `pop-payout`, línea-neutro): rojo en `T-374-W1-0`,
*«la vuelta de la creación del nonce durable dejó de aterrizar en el paso de firmar… expected
'seguimiento' to be 'firmar'»*.

⛔ **Lo que SIGUE abierto, con su tamaño exacto**: una permutación confinada a las tres marcas del
viaje del depósito, que ⛔ **no** tienen constante exportada (son literales dentro de `esPaso`, que
no se exporta). De esas tres, dos aterrizan en el mismo paso ⇒ intercambiarlas es un no-op
observable; lo que queda realmente abierto es la permutación que mueve la marca del connect contra
una de las otras dos. Cerrarlo exige o transcribir un literal (lo que `CD-W1-7` prohíbe) o exportar
tres constantes desde el motor del enlace, que es un archivo fuera del alcance de esta ola.

---

## 2 · Los 13 `it` de la ola original, con sus mutantes

⚠️ **«13» es la FOTO de la ola original y ⛔ no el total de hoy.** El fix-pack del AR sumó cinco
(§10) y el del CR sumó siete (§11) ⇒ **25** `it` en los cuatro archivos de test del árbol nuevo
(`pasos` 4 · `salto` 5 · `inercia` 3 · `recorrido` 13). El número que no envejece es el del gate:
**3520** en toda la suite. Lo de acá abajo es el conjunto original, tal como se midió.

Los 13 existen con sus nombres exactos y están verdes. Cada mutante se aplicó **uno por uno y por
separado**, verificado en disco antes de correr y restaurado contra `/usr/bin/git diff --numstat`.

| Mutante | Qué se cambió | `×` que lo mató | Aserción, por su mensaje |
|---|---|---|---|
| `MW-0` | Séptimo elemento en la tupla de marcas de producción | `T-374-W1-0` | *hay marcas de vuelta SIN aterrizaje en la tabla de `salto.ts`…* — `expected [ 'marca-septima-del-mutante' ] to deeply equal []` |
| `MW-1` | Sexta fila en `TABLA` con la etiqueta vacía | `T-374-W1-1` | *hay un paso sin etiqueta…* — `expected [ 'mutante' ] to deeply equal []` |
| `MW-2` | `etiquetasDe` devuelve la tabla entera | `T-374-W1-2` | *caso «recurrente»: el indicador de progreso recibiría 5 etiquetas para 4 pasos* |
| `MW-3` | El camino de error devuelve la pantalla de entrada | `T-374-W1-3` | *una vuelta aterriza en la pantalla de entrada. AC-7 lo prohíbe con la palabra NUNCA* |
| `MW-4` | El literal del parámetro del enlace escrito a mano en `salto.ts` | `T-374-W1-4` | *un literal de marca de vuelta quedó ESCRITO en el árbol nuevo…* — señaló `salto.ts:135` con el literal |
| `MW-5` | Campo de monto agregado a la pantalla de entrada | `T-374-W1-5` | el `not.toBeInTheDocument()` del bucle de los tres campos |
| `MW-6` | «Volver» limpia el borrador | `T-374-W1-6` | *«Volver» borró el monto cargado (AC-3)* — `expected '' to be '25'` |
| `MW-7` | El anfitrión escribe el snapshot en `localStorage` tras confirmar | `T-374-W1-7` | *la sesión quedó escrita en `localStorage`: sobreviviría a la recarga y sería una credencial al portador at-rest* |
| `MW-8` | Un em dash en el copy de la pantalla de entrada | `T-374-W1-8` | *la pantalla «entrar» mete un em dash en copy visible* |
| `MW-9` | Se borra el bloque de anuncio **y se deja el botón** | `T-374-W1-9` | *no hay bloque de anuncio antes del salto (AC-5)* |
| `MW-10a` | Ternario invertido en `app/page.tsx` | `T-374-W1-10` | *`app/page.tsx` ya no monta el ternario de la bandera…* (aserción **4**) |
| `MW-10b` | Ternario invertido en la página **y** en la copia que el `it` ejecuta | `T-374-W1-10` | *con la bandera apagada la página NO monta el árbol de hoy…* (aserción **2**) |
| `MW-11` | `?.toLowerCase() === "true"` en la bandera | `T-374-W1-11` | *el valor "TRUE" NO puede prender la bandera* |
| `MW-12a` | `window.localStorage.getItem` en `pantallas.tsx` | `T-374-W1-12` | *una pantalla del recorrido nuevo toca disco o la barra de direcciones…* (pata a) |
| `MW-12b` | `className="text-sm"` en `pantallas.tsx` | `T-374-W1-12` | *quedó un tamaño de texto de fábrica en el recorrido nuevo…* (pata b) |

### 2.1 · Los falsos KILLED, medidos uno por uno

- **`MW-0`** — el Story File declara que `T-067-16` de `sesion.test.ts` **también** se pone rojo con
  este mutante. **Medido, y NO ocurre**: con el séptimo elemento puesto, `sesion.test.ts` da
  `87 passed (87)`. El único `×` de esa corrida fuera de mi archivo fue `T-374-W1-3`, que lee la
  misma tupla. ⇒ el `×` de `T-374-W1-0` es inequívoco, y el aviso del Story File describe un
  co-rojo que hoy no existe.
- **`MW-2`** — con el mutante puesto, `T-374-W1-1` queda **verde** y sólo cae el caso *recurrente*
  de `T-374-W1-2`. Confirma que correr sólo el caso de primera vez lo dejaría sobrevivir.
- **`MW-3`** — `T-374-W1-0` queda **verde**; sólo cae `T-374-W1-3`. Confirma que el camino feliz solo
  no alcanza.
- **`MW-7`** — las tres aserciones previas (desenlace alcanzado, forma `payloadB64.firma`, control
  positivo) pasaron, y el rojo salió de la **primera de las cuatro** de disco. El `it` no dio verde
  por vacío.
- **`MW-8`** — `honest-copy.test.tsx` quedó **verde** (`33 passed` en esa corrida). Confirma que el
  guard de em dashes del árbol viejo **no cubre** el árbol nuevo.
- **`MW-9`** — el mutante **deja el botón puesto** a propósito. Un `it` que buscara el botón habría
  quedado verde; el que cayó fue el que busca el **texto**.
- **`MW-12b`** — `ola-2-pantallas.test.tsx` quedó **verde** (`25 passed`). Confirma que su lista de
  dos archivos escrita a mano no mira el árbol nuevo.

---

## 3 · Los rojos deliberados, y los que no lo fueron

Además de los 15 rojos de mutación, hubo **tres** rojos no planeados durante la ola. Los tres se
corrigieron y ninguno es una excepción concedida.

1. **`T-374-W1-12` salió rojo la primera vez, y el culpable eran mis propios docblocks.** Los
   delatores estaban escritos como substrings crudos (`/\blocalStorage\b/`), así que cazaron las
   líneas de prosa de `pantallas.tsx:4` y `recorrido.tsx:14` que nombran los delatores **para
   prohibirlos**. Se reescribieron como *call-shaped* / *asignación-shaped*, que es la misma
   «TRAMPA 3» que este repo ya tiene documentada. ⛔ No se tocó ninguna prosa para acomodar el guard:
   se arregló el guard, que era el que estaba mal.
2. **Dos citas ancladas quedaron PARTIDAS por el salto de línea de un docblock** — el modo de falla
   exacto de `CD-W1-10`, *rotas y verdes por ausencia*. Se detectaron **enumerando las citas del
   propio diff con el regex del candado y contándolas** contra las escritas: daban **15** y tenían
   que dar **17**. Las dos partidas eran `salto.ts` (hacia `splash-puerta.ts:84`) e
   `inercia.test.tsx` (hacia `no-evm-surface.test.ts:35`). Reparadas, el conteo da **17**.
3. **Una cita anclada del Story File estaba corrida en 2 líneas.** §6 y §9.4 dicen que `clasesDe`
   vive en `ola-2-pantallas.test.tsx:89`; **medido, está en `:91`** (`:89` es la primera línea de su
   docblock). El candado de citas ancladas lo cazó. Se corrigió **en el código**, no en el documento,
   y queda anotado acá. La otra cita de ese bloque, el predicado del vocabulario en `:130`, **sí es
   correcta**.

---

## 4 · Las cinco minas de `app/page.tsx`

| Mina | Qué se hizo | Verificación |
|---|---|---|
| 1 · la palabra prohibida | La costura del árbol nuevo se llama **`pasoDeArranque`** | `/usr/bin/grep -c "pasoInicial" app/page.tsx` ⇒ **0** |
| 2 · `T-DIAG-CABLEADO` | El ternario envuelve **sólo** los dos componentes del recorrido; el splash y el bloque de diagnóstico quedan **fuera** y montados como hoy | ese `it` está verde en el gate completo |
| 3 · las tres citas sueltas | Re-derivadas de `:20-21` a **`:21-22`** | ver §4.1 |
| 4 · los dos README | **174 → 178**, derivado **corriendo** el candado | ver §4.2 |
| 5 · la prosa que pone rojo el guard | Ninguna línea de prosa nueva escribe los literales de router con paréntesis | el guard de `L-5` está verde en el gate completo |

### 4.1 · Las tres citas sueltas, re-derivadas

El import nuevo entró como **una sola línea física** (edición línea-neutra, la técnica que este repo
ya usa), así que el corrimiento es de exactamente **+1**: `<>` pasó de `:20` a `:21` y `<Splash />`
de `:21` a `:22`.

| Archivo | Antes | Ahora |
|---|---|---|
| `src/presentation/bienvenida.tsx:206` | `app/page.tsx:20-21` | `app/page.tsx:21-22` |
| `src/presentation/grecas.tsx:9` | `app/page.tsx:20-21` | `app/page.tsx:21-22` |
| `src/presentation/bienvenida-composicion.test.tsx:862` (nombre del `it`) | `app/page.tsx:20-21` | `app/page.tsx:21-22` |

⚠️ **Un matiz que conviene dejar escrito y que no se corrigió**: las tres dicen que la página monta
`<Splash />` y `<RemittanceFlow />` **como hermanos**. Con la bandera **apagada** —que es como se
despliega— eso sigue siendo exactamente cierto. Con la bandera prendida, el hermano de `<Splash />`
pasa a ser `<Recorrido />`. La afirmación que esas tres citas sostienen (dos subárboles conviven en
un documento ⇒ los `id` de SVG colisionan) **no cambia** en ninguno de los dos casos, así que la
prosa se dejó como estaba. Si la ola que enciende la bandera quiere precisarla, es una línea.

### 4.2 · El conteo de los README

⛔ **No se contó a mano.** Se corrió el candado y se leyó el número del mensaje de fallo:
`AssertionError: expected 174 to be 178`. Los dos README dicen ahora **178**
(`README.md:436`, `README.es.md:462`) y el candado da `5 passed`.

---

## 5 · Δ de `flow.tsx` y estado de los repos

- `wc -l src/presentation/flow.tsx` ⇒ **4453** (igual que en `main`).
- `/usr/bin/git diff --numstat main -- src/presentation/flow.tsx` ⇒ **vacío**. **0 líneas, 0 caracteres.**
- El marcador `[[CENSO src/presentation/flow.tsx lineas=4453]]` sigue en `app/page.tsx` (ahora en
  `:24`, corrido por el import nuevo; el marcador se busca por contenido, no por número).
- `/usr/bin/git status` en `wasiai-a2a`: **cero cambios en `src/`**. Lo único que aparece son dos
  documentos sin trackear de esta misma HU en `doc/sdd/`.
- **Ninguna cita anclada nueva hacia los seis destinos de censo.** Las 17 citas ancladas propias
  apuntan a `splash-puerta.ts`, `flow-vm.ts`, `wallet-availability.ts`, `citas-ancladas.test.ts`,
  `no-evm-surface.test.ts` y `ola-2-pantallas.test.tsx`, ninguno de los cuales lleva marcador de
  censo. La única referencia al módulo de sesión va **suelta y con su motivo al lado**.
- **`NEXT_PUBLIC_CHASKI_RECORRIDO_V2` no está prendida en ningún lado**, y el gotcha del build está
  escrito dentro de `bandera.ts`.

---

## 6 · Presupuesto real, por columna

⚠️ **ESTA SECCIÓN SE RE-DERIVÓ ENTERA EN EL FIX-PACK DEL CR (`BLQ-MED-5`), Y SUS NÚMEROS ANTERIORES
ERAN LOS DE `e745d7a`.** El fix-pack del AR movió cuatro de las cinco columnas y §10 ⛔ **nunca las
volvió a medir**, así que una sección titulada *«Presupuesto real»* publicaba los valores de un árbol
que ya no existía. Lo de abajo se mide sobre **el árbol del fix-pack del CR** y se acompaña de las
dos fotos anteriores, para que se vea el movimiento y no sólo el punto final.

### 6.0 · El clasificador, publicado y calibrado

⛔ Un presupuesto que no dice cómo se contó no reproduce, y ése fue medio hallazgo del CR. La regla,
literal, en `scratchpad/w374/clasificador.mjs`:

> Se recorre el archivo por línea. **Las líneas en blanco no cuentan para ninguna columna.** Una línea
> que **arranca** con `//`, `/*`, `{/*` o `*`, o que cae dentro de un bloque `/* … */` abierto, es
> **PROSA**. Todas las demás son **CÓDIGO**, incluidas las que llevan un comentario pegado al final.

**Calibración en las DOS puntas, y sin ella este número no vale nada:**

| Árbol | Ejecutable | Prosa | Ratio | ¿Reproduce? |
|---|---:|---:|---:|---|
| `e745d7a` (la tabla original de §6) | **634** | **338** | **34,8 %** | ✅ exacto, y las 5 filas por archivo también |
| `5afe979` (la tabla del CR) | **770** | **556** | 41,9 % | ✅ exacto, `bandera.ts` **94,3 %** incluido |

⇒ el instrumento reproduce la medición del Dev **y** la del CR sin tocarle un parámetro. Recién con
eso se le puede creer el número de abajo.

### 6.1 · El presupuesto de HOY

| Columna | Techo §11 | `e745d7a` | `5afe979` | **Fix-pack del CR** | Estado |
|---|---:|---:|---:|---:|---|
| Producción ejecutable | ≤ 550 | 634 | 770 | **852** | 🔶 **1,55x — se justifica en 6.3** |
| **Producción prosa** | **≤ 400** | 338 ✅ | 556 | **659** | 🔴 **TECHO ROTO (1,65x) — declarado, ver 6.3** |
| Ratio de prosa del bloque | ≤ 42 % | 34,8 % | 41,9 % | **43,6 %** | 🔴 **roto por 1,6 puntos — declarado** |
| Tests, líneas no en blanco | ≤ 2.200 | 967 | — | **1.956** | ✅ (89 % del techo) |
| Archivos tocados | ≤ 14 | 15 | 16 | **16** | 🔶 **+2 — declarado en 6.3** |
| Líneas en `wasiai-a2a/src/` | 0 | 0 | 0 | **0** | ✅ |
| Δ en `flow.tsx` | 0 | 0 | 0 | **0** | ✅ `wc -l` ⇒ **4453** · `--numstat` vs `25c3f73` ⇒ **vacío** |

**Por archivo de producción, hoy:**

| Archivo | Código | Prosa | Prosa % | vs `5afe979` |
|---|---:|---:|---:|---|
| `pasos.ts` | 47 | 60 | 56,1 % | +5 / +12 (el arreglo de `siguiente` y `etiquetaDe`) |
| `bandera.ts` | 3 | 50 | **94,3 %** | sin cambios — ⛔ este fix-pack no lo tocó |
| `salto.ts` | 132 | 211 | 61,5 % | sin cambios — ⛔ este fix-pack no lo tocó |
| `pantallas.tsx` | 372 | 174 | 31,9 % | +38 / +37 |
| `recorrido.tsx` | 298 | 164 | 35,5 % | +39 / +54 |

**Tests, por archivo:** `pasos.test.ts` 183 · `salto.test.ts` 404 · `inercia.test.tsx` 437 ·
`recorrido.test.tsx` 932 ⇒ **1.956**.

### 6.2 · Las dos columnas rotas, dichas con todas las letras

⛔ **La prosa se pasó del techo y el ratio también, y ⛔ no se disimula.** El techo de `§11` es 400 y
hoy hay **659**. El CR midió 556 y lo llamó *«techo roto, sin declarar»*: tenía razón, y este fix-pack
lo empeoró antes de mejorarlo. La secuencia completa, para que se pueda auditar:

1. El fix-pack del CR agregó ~145 líneas de prosa (el porqué de cada arreglo, más las mediciones que
   la metodología exige que queden escritas) ⇒ el pico fue **701**.
2. Se hizo **una pasada de recorte sobre la prosa NUEVA**, ⛔ no sobre las mediciones: se juntaron
   párrafos, se sacaron las repeticiones entre el docblock del prop y el de la pantalla, y se
   comprimieron los cuatro bloques del fix-pack en `recorrido.tsx`. **701 → 659, o sea −42.**
3. ⛔ **No se recortó `salto.ts` ni `bandera.ts`**, que son los dos archivos con el ratio más alto y
   suman **261 de las 659**. Motivo, y es una decisión que el CR puede rechazar: este fix-pack ⛔ no
   los tocó, y lo que ocupa esas líneas es evidencia MEDIDA —la corrección de la propia evidencia del
   gotcha de la bandera, con las dos rutas de `grep` sobre el artefacto de build, y el porqué del
   tercer valor del aterrizaje—. Borrarla para ganar una columna sería cambiar el número a costa de
   lo único que hace auditable la decisión.

### 6.3 · Las cuatro desviaciones, cada una en su columna

1. **Ejecutable: 852 contra 550 (1,55x).** El delta contra `5afe979` es **+82**, y se puede leer línea
   por línea: la guarda de reentrada y su `ref` (+13), los dos efectos del apagador del estado en
   vuelo (+21), el mensaje del mínimo con su `role="alert"` (+9), los props `enCurso` /
   `etiquetaEnCurso` / `porDebajoDelMinimo` atravesando cinco pantallas (+29, y son firmas y pasajes
   de props, uno por línea, que es el estilo del repo), y la rama nueva de `siguiente` (+5). ⛔ No hay
   ni un `useEffect` ni una rama que no salga de un hallazgo del CR. Aplicando la pregunta que decide
   —*¿qué parte seguiría existiendo si lo escribiera alguien que ya conoce este repo?*—: **todo menos
   los pasajes de props**, que son convención local y no decisión.
2. **Prosa: 659 contra 400 (1,65x).** 🔴 **Techo roto y DECLARADO.** Está desarrollado en 6.2. Bajo el
   umbral de 2x del `§11.10`, así que la regla admite justificación escrita; la justificación es 6.2 y
   ⛔ no una frase de cobertura.
3. **Ratio: 43,6 % contra 42 %.** 🔴 **Roto por 1,6 puntos, y es consecuencia aritmética de 2**: la
   prosa creció más rápido que el código. Se declara aparte porque es una columna aparte del `§11` y
   el CR pidió las cuatro.
4. **Archivos: 16 contra 14.** Los 12 del Scope IN, más los **tres** que `T-17` y `CD-W1-9` mandan
   tocar para re-derivar las citas sueltas (`bienvenida.tsx`, `grecas.tsx`,
   `bienvenida-composicion.test.tsx`, `1 1` cada uno), más `protocol.ts` del fix-pack del AR (línea
   neutro, `2 2`). ⛔ Ninguno de los cuatro estaba en la tabla de Scope IN ni en el techo. El CR marcó
   *«16, sin declarar»*: acá quedan declarados los 16 y los 4 de más, con su motivo.

### 6.4 · Las «21 citas ancladas», re-derivadas con el patrón publicado (`MNR-4`)

⛔ **El «21» del §10.3 no reproduce, y el CR lo marcó bien: no venía con el patrón.** Acá va el
patrón, que ⛔ no se inventa: es el **mismo** con el que el candado del repo define el formato, en
(`ANCLADA`, `src/composition/citas-ancladas.test.ts:74`):

```
/`([A-Za-z_$][\w$.]*)`,\s*`([\w./-]*?):(\d+)(?:-\d+)?`/g
```

Aplicado a **los 16 archivos del diff `25c3f73..HEAD`**, que es el conjunto que el §10.3 decía estar
contando:

| Conteo | Valor en `0d3e3ce` | Valor tras el fix-pack de F4 |
|---|---:|---:|
| Citas ancladas, contando sobre el ARCHIVO entero | **39** | **42** |
| Citas ancladas, sumando el conteo LÍNEA por LÍNEA | **39** | **42** |
| Citas ancladas, **normalizando primero el salto de línea del docblock** | **41** | **42** |
| ⇒ **partidas** (una cita a caballo de dos líneas) | 🔴 **2** | **0** |

🔴 **ACÁ SE DECLARABAN «0 PARTIDAS» Y ERAN DOS, Y EL DEFECTO ESTABA EN EL MÉTODO, ⛔ NO EN EL
CONTEO.** Las dos columnas de arriba —«archivo entero» y «línea por línea»— ⛔ **no pueden**
distinguir una cita partida: entre el símbolo y el destino queda `\n * `, y `\s*` ⛔ no matchea ese
` * `. O sea que una cita partida es invisible para las DOS, dan el mismo número, y ese empate se leyó
como «ninguna partida». **Una cita partida no es una que se cuenta dos veces: es una que ⛔ no cuenta
nadie**, y por lo tanto una que el candado del repo ⛔ no valida.

**El método que sí las ve** —y es el que hay que usar de acá en adelante— normaliza el salto de línea
del docblock (`\n\s*(?:\*|//)?[ \t]*` ⇒ un espacio) ANTES de aplicar el patrón, y compara ese conteo
contra el de línea por línea. La diferencia son las partidas.

**Las dos que había en `0d3e3ce`, corregidas las dos:**

| Archivo | Cita | Estado |
|---|---|---|
| `src/presentation/recorrido/salto.ts` | `(`PARAM_ERROR`, `…/protocol.ts:44`)` | La que F4 reportó (`H-5`). Unida en una línea. |
| `src/presentation/bienvenida-composicion.test.tsx` | `(`resolveSolanaRpcUrlPublic`, `../infrastructure/chain.ts:190`)` | 🔴 **F4 declaró 1 partida y eran 2**: ésta no la vio ninguno de los tres. Unida **línea-neutro** (dos líneas antes, dos después), porque este archivo **recibe** citas ancladas por número (`:289` y `:854`) y merger las dos las corría. Destino verificado: `chain.ts:190` **es** `export function resolveSolanaRpcUrlPublic`. |

⚠️ **Y por qué da 39 y no 21**: el conjunto de 39 incluye los dos README (2 cada uno) y los tres
archivos de `T-17` (`bienvenida.tsx` 6, `bienvenida-composicion.test.tsx` 6, `grecas.tsx` 2), que
tienen citas **preexistentes** que el diff no agregó. Sobre los **cinco archivos de producción del
árbol nuevo más sus cuatro de test** el conteo es **21**, que es de donde salía el número viejo. ⇒ el
«21» no estaba mal, **estaba sin definir su conjunto**, que es la misma falla.

**Citas ancladas NUEVAS de este fix-pack: 0.** Medido sobre `git diff 5afe979..HEAD` filtrando las
líneas `+` con el patrón de arriba: **lista vacía**. La única cita al árbol viejo que este fix-pack
necesitaba —el molde del `guard`— se escribió **SIN ancla y sin número de línea**, a propósito.
**Marcadores `[[CENSO …]]` en el diff del fix-pack: 0.**

---

## 7 · El gate del repo, completo y en orden

```
cd /home/ferdev/.openclaw/workspace/chaski-v3
/usr/bin/git add -A
npm run qa      # = lint → typecheck → typecheck:scripts → test
npm run build   # = next build --webpack
```

⛔ Sin `npx biome` ni `npx tsc` sueltos. Los resultados de la corrida final están en §9.

⚠️ **El flake preexistente de `vuelta-por-enlace-carrera.test.tsx` no apareció** en ninguna de las
corridas completas de esta ola. No se puso en cuarentena ni se lo tocó.

---

## 8 · Lo que W1 ⛔ **NO** entrega ni mide

1. ⛔ **La bandera queda APAGADA.** Nada de esto corre en producción. El encendido es de otra ola.
2. ⛔ **Nada corre en un teléfono.** Todo es `jsdom`.
3. ⛔ **`AC-14` sobre el árbol NUEVO es de W3**, con esas palabras. Con la bandera apagada el árbol
   nuevo **no se ejecuta**, así que no hay ningún número suyo que publicar.
4. ⛔ **Nada sobre el vale, el identificador opaco ni el borrador durable.** W1 deja **la costura**
   —ninguna pantalla sabe dónde vive el borrador, y hay un barrido que lo mide— **no** la
   implementación.
5. ⛔ **`L-4` sigue NO MEDIDO**: si el envío sobrevive al salto al navegador de la billetera lo
   contesta otra ola, con *Testnet Mode* como precondición. *«No se pudo medir»* ⛔ no es *«no cruza»*.
6. ⛔ **El retiro del camino viejo** es una HU propia. El recorrido viejo queda **intacto y
   funcionando**.
7. ⛔ **El candado de `L-5` sigue siendo más ancho que `L-5`**: prohíbe **toda** navegación blanda de
   `src`+`app`, cuando la premisa sólo necesita que el salto a la billetera sea de documento. W1 no
   lo tocó y lo declara, para que nadie lea su verde como «`L-5` se midió para la app entera».
8. ⛔ **El recorrido nuevo no da historial de navegador**: el botón «atrás» del teléfono sale de la
   app. Hoy es igual con el árbol viejo ⇒ no empeora nada, pero tampoco lo mejora, y ningún AC lo
   pide.
9. ⛔ **`bitacora-de-vuelta.ts:176` sigue diciendo «en ocho archivos» y son seis.** Menor conocido,
   con dueño, ⛔ no de esta ola.
10. ⛔ **`T-O2-2` sigue recorriendo una lista de dos archivos escrita a mano.** W1 cubre su propio
    árbol con su propio barrido; arreglar esa lista es HU aparte.
11. 🔴 ⛔ **EL ITINERARIO CORTO NO SE CABLEA, Y POR ESO EL PASO DE LA IDENTIDAD APARECE SIEMPRE**
    (CR/`BLQ-MED-1`). `identidadYaVerificada` ⛔ **no tiene ningún productor** fuera de los tests: el
    punto de montaje arma `<Recorrido />` sin props ⇒ vale `false` ⇒ **el paso 3 lo ve todo el mundo,
    siempre, incluida la persona que ya se verificó ayer**. El copy de esa pantalla ya ⛔ no promete
    lo contrario (decía *«Una vez sola»*), y hay un predicado en el barrido de copy que pone rojo el
    día que alguien lo vuelva a escribir.
    **Por qué no se cableó acá, medido y no razonado**: el veredicto vive en `LocalKycStore`, que lee
    el disco del navegador; `app/page.tsx` ⛔ **no lleva `"use client"`**, así que ahí no se puede
    leer; y leerlo desde el anfitrión lo pondría a tocar el disco, que es exactamente lo que
    `T-374-W1-12` prohíbe en este árbol. Cablearlo necesita una costura propia ⇒ **es de otra ola**.
    ⚠️ Lo que SÍ se arregló ahora, para que no quede una mina esperando: `siguiente` para un paso
    fuera del itinerario ya ⛔ **no** devuelve la pantalla de entrada (`BLQ-BAJO-3`).
12. ⛔ **`touch-targets.test.tsx` ⛔ NO barre el árbol nuevo** (CR/`MNR-3`). Monta `RemittanceFlow`,
    `EscrowRentRecovery` y `LostEscrowRecovery` **a mano**, así que ninguna de las cinco pantallas
    nuevas entra a su medición de superficies táctiles. Es el tercer candado del repo en la misma
    situación —los otros dos (`T-O2-2` y el de em dashes) ya estaban declarados en los puntos 10 y en
    §2— y por simetría éste también. W1 cubre el vocabulario de diseño de su árbol con la pata (b) de
    `T-374-W1-12`; ⛔ **el tamaño de los blancos táctiles del árbol nuevo no lo mide nadie**.
13. ⛔ **El estado en vuelo tiene apagador, pero hay un caso que ⛔ NO cierra** (CR/`BLQ-MED-3`). Se
    apaga al cambiar de paso, al volver a la pestaña (`visibilitychange`) y al volver por la caché de
    ida y vuelta (`pageshow`). ⚠️ **Si el toque no produce absolutamente nada** —la billetera no abre
    y la pestaña nunca se esconde— ninguno de los dos eventos llega, y el único apagador que queda es
    cambiar de paso. Eso ⛔ no se cierra escuchando eventos y ⛔ no se afirma cerrado.

**Y dos cosas más que este reporte NO publica, a propósito:** ningún número de salidas ni de
travesías del recorrido nuevo —esa cuenta depende de una decisión del founder que hoy no está
tomada— y ninguna promesa sobre el paso de crear la cuenta, que lo entrega otra HU que todavía
espera su aprobación. Hay un `it` que lo mide sobre el copy renderizado, no una promesa en prosa.

### 8.1 · El control de que el recorrido dentro del navegador de la billetera no empeoró

Son **dos** patas y ninguna sola alcanza:

- `T-372-W1-13` (`recorrido-en-el-navegador-de-la-billetera.test.tsx:707`) sigue **verde** ⇒ el árbol
  viejo, montado directo, conserva sus números. ⛔ Pero ese `it` monta el árbol a mano: no dice nada
  de `app/page.tsx`.
- `T-374-W1-10` dice que `app/page.tsx` con la bandera apagada **es** ese mismo árbol, comparado por
  `innerHTML`, con la mitad falsadora que lo vuelve refutable.

⇒ juntos cierran «no empeoró» **para la bandera apagada**, que es como se despliega. ⛔ Sobre el árbol
nuevo en un teléfono, nada: eso es W3.

---

## 9 · Corrida final del gate

Corrida con el índice de git ya actualizado, entera y en orden:

- `/usr/bin/git add -A` → OK
- `npm run qa` → **exit 0**
  - `lint`: `Found 140 warnings.` — **0 errores**; los 140 son la deuda preexistente que `biome.jsonc`
    ya declara en su cabecera (`noNonNullAssertion` y compañía), y ninguno está en el árbol nuevo.
  - `typecheck` y `typecheck:scripts`: sin salida, sin errores.
  - `test`: **Test Files 178 passed (178) · Tests 3508 passed (3508)**
- `npm run build` → **exit 0** (`Compiled with warnings`: los `Critical dependency` de `viem`/`ox`
  vía `@walletconnect`, preexistentes y ajenos a esta ola)

---

---

## 10 · Fix-pack del AR (`RECHAZADO` → 2 `BLQ-ALTO`, 4 `BLQ-MED`, 2 `BLQ-BAJO`, 3 `MNR`)

Rama `fix/374-w1-fix-pack-ar`, sobre `e745d7a`. Los once hallazgos, uno por uno.

| # | Hallazgo | Dónde quedó | `it` que lo cierra |
|---|---|---|---|
| `BLQ-ALTO-1` | El tercer valor colapsaba en la entrada | `salto.ts` — `aterrizajeDelAnfitrion` + `PASO_DE_LA_MARCA_DESCONOCIDA` + `MOTIVO_SIN_ATERRIZAJE`; `recorrido.tsx` lo consume | `T-374-W1-14` (puro) y `T-374-W1-15` (anfitrión MONTADO) |
| `BLQ-ALTO-2` | Ningún salto se ejecutaba | `pantallas.tsx` — `Salir`; `recorrido.tsx` — `verificar` llama a `startKyc`, `firmar` maneja `hay-que-salir` | `T-374-W1-9`, `T-374-W1-16` |
| `BLQ-MED-1` | `?dl=toString` dejaba la app en blanco | `salto.ts` — `Object.hasOwn` + validación con `esPasoDelRecorrido` | `T-374-W1-13` |
| `BLQ-MED-2` | El barrido de disco se esquivaba con una línea | `inercia.test.tsx` — `normalizar()` + la 8ª fila (corchetes) + el límite reescrito | `T-374-W1-12` |
| `BLQ-MED-3` | Cotización por tecla, sin mínimo, error pegado | `recorrido.tsx` — debounce, `MIN_SEND_USD`, `setMotivo(null)` | `T-374-W1-17` |
| `BLQ-MED-4` | `codigoDeError` sin productor | `salto.ts` — `codigoDeErrorDeLaUrl` desde `PARAM_ERROR`; el parámetro se eliminó | `T-374-W1-3` |
| `BLQ-BAJO-1` | «3 firmas» y «1 firma» en la misma sesión | `volvioPorEnlace` + un solo `porEnlace` de estado; la prueba de posesión entró a la lista | `T-374-W1-8` (fixture (b)) |
| `BLQ-BAJO-2` | Callejón silencioso y el punto colgando | `MOTIVO_SIN_ENVIO`; la frase del destino no se escribe sin dígitos | `T-374-W1-8` (fixture (c)) |
| `MNR-1` | La limitación declarada era la equivocada | §1 de este reporte, reescrito; `T-374-W1-0` cierra 3 de las 6 marcas | `T-374-W1-0` |
| `MNR-2` | El gotcha citaba un mecanismo que no aplica | `bandera.ts`, con la medición sobre el artefacto | (docblock, medido) |
| `MNR-3` | Los cinco pasos escritos a mano | `TABLA.map(f => f.id)` | `T-374-W1-8` |

### 10.1 · `BLQ-ALTO-2` — cuál opción se eligió y por qué

Se eligió **(a) cablear los saltos**, y ⛔ **no** por un puerto nuevo del `Container`: los tres saltos
son **`<a href>` que la persona toca**, así que **no hay ninguna navegación programática** que
necesite un puerto. Las dos razones, y la primera es del propio repo:

1. **Es el patrón medido de este repo.** El árbol viejo navegaba con `window.location.href` desde un
   efecto de montaje; los navegadores móviles lo descartan **sin error**, y el diagnóstico en el
   teléfono del founder mostró a la persona parada en la bienvenida a los 12,8 s. El arreglo de
   `HU-075/gesto` fue exactamente éste: el salto pasa a ser un `<a href>`.
2. **El barrido `T-374-W1-12` prohíbe `window.location =` en todo el árbol nuevo**, anfitrión
   incluido. Un `<a href>` no lo toca, así que no hace falta ni relajar el guard ni abrir un puerto en
   `container.ts`, que es un archivo con marcadores de censo de citas ancladas.

Y en las dos opciones era obligatorio: **`verificar` llama a `startKyc`**. Hoy lo hace, con sus tres
desenlaces, y ⛔ **no avanza** ni con `redirect` ni con un veredicto que no pasó.

### 10.2 · Los mutantes del fix-pack

Aplicados **uno por uno**, verificados **en disco** por su marcador antes de correr, y restaurados con
`/usr/bin/git checkout --` + `git diff --numstat` vacío. ⛔ Ningún `.orig` cacheado.

| Mutante | Qué se cambió | `×` | Mensaje del assert |
|---|---|---|---|
| `MW-13` | Volver al cast infundado en `aterrizajeDe` | `T-374-W1-13` | *«toString» viene de `Object.prototype` y se está colando como aterrizaje… expected [Function toString] to be 'sin-aterrizaje'* |
| `MW-14` | `sin-aterrizaje` ⇒ `{ paso: pasoDeArranque, motivo: null }` | `T-374-W1-14` | *una marca sin consumidor manda a la persona al paso de arranque… expected 'entrar' not to be 'entrar'* |
| `MW-15` | El colapso `? :` de vuelta en el anfitrión | `T-374-W1-15` | *`?dl=marca-que-nadie-escribio` aterriza en la PANTALLA DE ENTRADA… expected \<button…\> to be null* |
| `MW-16` | `verificar` = `setEnVuelo(true); avanzar()` | `T-374-W1-16` | *«Verificar mi identidad» no llama al caso de uso… expected +0 to be 1* |
| `MW-16b` | Avanzar con un veredicto que NO pasó | `T-374-W1-16` | *el recorrido avanzó con una verificación que NO pasó… expected \<h1…\> to be null* |
| `MW-17a` | El pedido de cotización NO se difiere | `T-374-W1-17` | *se pidió una cotización POR TECLA… expected [ 9, 95 ] to deeply equal [ 95 ]* |
| `MW-17b` | El corte del mínimo pasa a `monto > 0` | `T-374-W1-17` | *se pidió una cotización por debajo del mínimo… expected [ 4 ] to deeply equal []* |
| `MW-17c` | Sin `setMotivo(null)` en el camino feliz | `T-374-W1-17` | *el banner de error quedó pegado JUNTO a la cotización correcta… expected \<p…\> to be null* |
| `MW-18` | `if (r.estado === "listo")` sin `else` | `T-374-W1-9` | *Unable to find role="link" and name "Abrir mi billetera"* |
| `MW-19` | Permutar `crear-nonce` ↔ `pop-payout` en la tupla | `T-374-W1-0` | *la vuelta de la creación del nonce durable dejó de aterrizar en el paso de firmar… expected 'seguimiento' to be 'firmar'* |
| `MW-20` | `codigoDeErrorDeLaUrl` devuelve `null` siempre | `T-374-W1-3` | *la URL de la rama de error no lleva ningún código… expected null to be '4001'* |
| `MW-20b` | El LECTOR intacto, pero sin llamador | `T-374-W1-3` | *el camino de error tiene que traer un motivo legible… expected null to be truthy* |
| `MW-12c` | El escape del AR: alias PARTIDO en `pantallas.tsx` | `T-374-W1-12` | *una pantalla del recorrido nuevo toca disco… expected [ Array(1) ] to deeply equal []* |
| `MW-12d` | Índice por corchetes en `pantallas.tsx` | `T-374-W1-12` | ídem, con 2 hallazgos |

⚠️ **Dos mutantes sobrevivieron primero, y ninguno era un guard vacío.** Los dos están en el
Auto-Blindaje con su medición: `MW-12c` en su primera forma llevaba el marcador **adentro** del patrón
que el guard busca (⇒ no reproducía el defecto), y `MW-17a` como `setTimeout(…, 0)` es **equivalente**
bajo temporizadores falsos. El segundo destapó una **limitación real, ahora escrita en el `it`**: lo
que se clava es que el pedido esté **diferido fuera del render**, ⛔ no que la demora sean 300 ms.

⚠️ **Un falso KILLED declarado**: `MW-19` también pone rojo a `T-374-W1-14` (su control positivo usa
la misma marca). El `×` que cuenta para `MNR-1` es el de `T-374-W1-0`, citado arriba por su mensaje.

### 10.3 · Constraints, verificadas

- **`flow.tsx` Δ0**: `wc -l` ⇒ **4453** · `/usr/bin/git diff --numstat main -- src/presentation/flow.tsx`
  ⇒ **vacío**.
- **Bandera apagada**: ningún `.env` la define; `T-374-W1-11` sigue verde.
- **Citas ancladas**: **21** en los archivos del diff. ⚠️ ACÁ SE CONCLUÍA «conteo por archivo =
  conteo por línea ⇒ ninguna partida», y esa inferencia ⛔ **no se sostiene**: las dos formas de
  contar son ciegas a una cita partida, así que su empate ⛔ no dice nada. Con el método de §6.4
  había **2 partidas**, corregidas en el fix-pack de F4. Las **tres nuevas** apuntan a
  `protocol.ts:335`, `flow-vm.ts:1503` y
  `connect-wallet.ts:73` — ⛔ **ninguna** a los seis destinos censados. Ni un marcador `[[CENSO …]]`
  aparece en el diff.
- **Ninguna pantalla toca disco ni la URL**: `T-374-W1-12`, ahora con el barrido normalizado.
- **Sin `6`/`5`/`7` publicados**, ningún número de salidas, ninguna promesa sobre «Crear la cuenta» ni
  sobre no necesitar SOL, y sin em dashes: `T-374-W1-8`, que además cubre los **tres textos nuevos**
  que los cinco montajes por default ⛔ no alcanzan.
- **`protocol.ts` se editó LÍNEA-NEUTRO** (`--numstat` ⇒ `2 2`): `PARAM_ERROR` entró en una línea que
  ya existía y `PARAMS_DE_RESPUESTA` lo consume, así que el nombre vive en un solo sitio.

### 10.4 · El gate, corrido TRES veces

⚠️ El AR corrió el gate **una vez** y lo dijo: un verde no distingue *verde* de *tuve suerte*. Acá se
corrió entero, con `/usr/bin/git add -A` antes de cada corrida:

| Corrida | `npm run qa` | `npm run build` |
|---|---|---|
| 1 | `0 errores` / `140 warnings` · **178 archivos / 3513 tests** | exit **0** |
| 2 | exit **0** · mismos números | exit **0** |
| 3 | exit **0** · mismos números | exit **0** |

Los **140 warnings** son la deuda preexistente que `biome.jsonc` declara; ⛔ ninguno está en el árbol
nuevo. **3508 → 3513** son los cinco `it` del fix-pack (`W1-13`…`W1-17`); **178 archivos**, sin
cambios ⇒ los dos README siguen diciendo la verdad.

---

## 11 · Fix-pack del CR (`RECHAZADO` → 1 `BLQ-ALTO`, 5 `BLQ-MED`, 3 `BLQ-BAJO`, 5 `MNR`)

Rama `fix/374-w1-fix-pack-cr`, sobre `5afe979`. Los catorce hallazgos, uno por uno.

🔴 **El criterio que ordenó este fix-pack**: el CR contestó que la persona llega hasta el final pero
con cuatro tropiezos, **y que dos le mienten**. Las dos mentiras se cerraron primero.

| # | Hallazgo | Dónde quedó | `it` que lo cierra |
|---|---|---|---|
| `BLQ-ALTO-1` | El barrido era ciego a la variante sintáctica | `inercia.test.tsx` — quinta fila sin prefijo obligatorio ni `=` obligatorio, **7 cebos** y **4 controles de lectura**; el límite reescrito | `T-374-W1-12` |
| `BLQ-MED-1` | La pantalla 3 prometía «una vez sola» | `pantallas.tsx` — bajada nueva + el porqué de no cablear; §8 punto 11 | `T-374-W1-8`, `T-374-W1-24` |
| `BLQ-MED-2` | El corte del mínimo no se le decía a nadie | `recorrido.tsx` — `porDebajoDelMinimo`; `pantallas.tsx` — el `role="alert"` derivado de `MIN_SEND_USD` | `T-374-W1-18` |
| `BLQ-MED-3` | El estado en vuelo no tenía apagador | `recorrido.tsx` — efecto por `[paso]` + `visibilitychange`/`pageshow` | `T-374-W1-22` |
| `BLQ-MED-4` | Nada frenaba el segundo toque ni mostraba el primero | `recorrido.tsx` — `conGuarda` con `enCursoRef`; `pantallas.tsx` — `disabled` + 4 etiquetas en curso | `T-374-W1-23` |
| `BLQ-MED-5` | El presupuesto publicado no reproducía | §6 entera, re-derivada con el clasificador **calibrado en las dos puntas** | (§6.0) |
| `BLQ-BAJO-1` | «Se guarda solo mientras lo completás» | `pantallas.tsx` — bajada nueva | `T-374-W1-8`, `T-374-W1-24` |
| `BLQ-BAJO-2` | «Volvé un paso» apuntaba a donde no hay nada | `recorrido.tsx` — `MOTIVO_SIN_ENVIO` nombra el paso, **derivado de la tabla** | `T-374-W1-8` (fixture (c)) |
| `BLQ-BAJO-3` | `siguiente` fuera del itinerario devolvía la entrada | `pasos.ts` — sigue el orden de la TABLA; el último recurso es el ÚLTIMO paso | `T-374-W1-20` |
| `MNR-1` | Los 300 ms duplicados sin testigo | `recorrido.tsx` — la constante se exporta; el `it` lee el número **del fuente del árbol viejo** | `T-374-W1-19` |
| `MNR-2` | Dos `useCallback` idénticos con motivo inventado | `recorrido.tsx` — un solo `salirDeLaApp` | (los tres `it` que tocan un salto) |
| `MNR-3` | `touch-targets.test.tsx` no barre el árbol nuevo | §8, punto 12 | (declarado) |
| `MNR-4` | «21 citas» no reproducía sin el patrón | §6.4, con el patrón del candado del repo y el conjunto definido | (§6.4) |
| `MNR-5` | «Estado terminal» con un botón que vuelve | `pantallas.tsx` — docblock de `PantallaSeguimiento` | (docblock) |

### 11.1 · `BLQ-MED-1` — cuál opción se eligió, y por qué la otra era imposible

Se eligió **(b): el copy deja de prometerlo, y queda declarado.** ⛔ **No fue una preferencia: (a) es
inalcanzable desde este árbol**, y se midió antes de decidir.

1. El veredicto vive en `LocalKycStore`, que lee `localStorage` (`ls()` en `src/infrastructure/kyc-store.ts`).
2. El punto de montaje, `app/page.tsx`, **⛔ no lleva la directiva de cliente** (`grep -c "use client"`
   ⇒ **0**) ⇒ es un componente de servidor y ahí `localStorage` no existe.
3. Leerlo desde el anfitrión lo pondría a tocar el disco ⇒ pone **rojo** a `T-374-W1-12`, que es el
   candado central de esta ola.

⇒ cablearlo necesita una costura nueva (un lector de cliente que empuje el veredicto hacia adentro),
y eso es una ola con su propio SDD. La bajada de la pantalla pasó de *«Una vez sola. Después de esto,
tus próximos envíos no la vuelven a pedir.»* a *«Verificamos quién sos antes de mandar la plata.»*,
que es cierto para el 100 % de las personas.

⚠️ **Y la mina de `BLQ-BAJO-3` quedó desarmada igual**, que es lo que el CR pidió por escrito: aunque
hoy el prop no tiene productor, `siguiente` ya ⛔ **no** puede devolver la pantalla de entrada. El día
que se cablee, la trampa no está.

### 11.2 · Las dos mentiras, cerradas con evidencia

| Frase | Por qué era falsa | Qué dice hoy | Qué la caza si vuelve |
|---|---|---|---|
| *«Se guarda solo mientras lo completás.»* | `createRemittance` (el único `repo.save` del camino) corre **recién al tocar «Seguir»**; el borrador vive en estado de React y ninguna pantalla toca el disco (lo mide `T-374-W1-12`). Repro: los tres campos + recargar ⇒ todo vacío, en la pantalla de entrada. | *«Todavía no se guarda nada: si recargás la página, esto se vuelve a empezar.»* | `MW-29` ⇒ `T-374-W1-8` **ROJO** |
| *«Una vez sola. Después de esto, tus próximos envíos no la vuelven a pedir.»* | `identidadYaVerificada` tiene **cero productores**; el montaje real no pasa props ⇒ `false` ⇒ el paso aparece siempre. | *«Verificamos quién sos antes de mandar la plata.»* | `MW-30` ⇒ `T-374-W1-8` **ROJO** |

🔴 **ACÁ DECÍA QUE LOS DOS PREDICADOS ESTÁN ESCRITOS «POR EL SENTIDO Y NO POR LA FRASE EXACTA», Y ES
FALSO — F4 lo midió (`H-2`) y el fix-pack de F4 lo corrigió.** Son una disyunción de **tres
redacciones cercanas** cada uno: cazan literales parecidos, ⛔ no un significado. F4 falsificó la
frase con dos paráfrasis que dicen la MISMA mentira con otras palabras y pasan con la suite en
`13 passed`; el fix-pack corrió **otras tres inventadas para la ocasión** y las cinco pasaron los dos
`not.toMatch`. Y `T-374-W1-24` ⛔ no puede detectarlo por construcción: le pasa los **literales que
estaban renderizados en `5afe979`**, o sea confirma la única forma que ya funcionaba.

**Lo que hay hoy, y es lo único que se afirma:**

| Control | Qué garantiza | Qué ⛔ NO garantiza |
|---|---|---|
| Los dos `not.toMatch` de `revisarCopy` | Que ⛔ no vuelva la redacción **vieja** ni sus vecinas inmediatas | Nada sobre una redacción distinta |
| `T-374-W1-24` | Que esos dos predicados **pueden fallar** (calibrados contra los literales de `5afe979`), más un control positivo con copy sano | Que cubran el sentido |
| `T-374-W1-26` (nuevo) | El copy visible de las cinco pantallas **pineado palabra por palabra**: cualquier redacción nueva, fiel o mentirosa, es un diff que una persona aprueba a propósito | El copy que sólo aparece tras una interacción, y el bloque reusado del alquiler de red, que se **enmascara** |

⛔ **Y el arreglo ⛔ NO fue ensanchar los predicados**: cerrar las dos paráfrasis conocidas es el mismo
control que confirma la forma que ya funcionaba, un escalón más arriba, y una tercera redacción
volvería a pasar. Un guard de **texto** no puede cazar un **sentido**; lo que sí puede es **congelar
el texto**.

### 11.3 · Los mutantes, uno por uno

Aplicados **de a uno**, con el marcador verificado **en disco ANTES de correr la suite** (si no está,
el corredor **aborta** y ⛔ no reporta), restaurados con `/usr/bin/git checkout --` y confirmados con
`git status --porcelain` ⇒ **0 archivos sucios** después de cada tanda. ⛔ Ningún `.orig` cacheado.

**Los SEIS de `BLQ-ALTO-1`** — el hallazgo era que el patrón exigía prefijo y `=`, así que se muta una
línea de `Salir` con **cada forma**, por separado:

| Mutante | Forma escrita en `pantallas.tsx` | `×` | Mensaje del assert |
|---|---|---|---|
| `MW-28a` | `location.href = …` | `T-374-W1-12` | *una pantalla del recorrido nuevo toca disco o la barra de direcciones… expected [ Array(1) ] to deeply equal []* |
| `MW-28b` | `document.location.href = …` | `T-374-W1-12` | ídem |
| `MW-28c` | `window.location.assign(…)` | `T-374-W1-12` | ídem |
| `MW-28d` | `location.assign(…)` | `T-374-W1-12` | ídem |
| `MW-28e` | `location.replace(…)` | `T-374-W1-12` | ídem |
| `MW-28f` | `window.location = …` (al objeto entero) | `T-374-W1-12` | ídem |

⚠️ **Antes del arreglo, `MW-28a` y `MW-28c` juntos daban `3 passed` y el gate en exit 0** — reproducido
por mí, no heredado del CR.

**Los demás:**

| Mutante | Qué se cambió | `×` | Mensaje del assert |
|---|---|---|---|
| `MW-22` | `siguiente` fuera del itinerario ⇒ `itin[0]` | `T-374-W1-20` | *aterriza en la PANTALLA DE ENTRADA, que es lo único que el invariante prohíbe con la palabra NUNCA… expected 'entrar' not to be 'entrar'* |
| `MW-23` | `etiquetaDe` devuelve su argumento | `T-374-W1-21` | *«entrar» no devuelve su etiqueta de la tabla… expected 'entrar' to be 'Entrar'* |
| `MW-24` | `porDebajoDelMinimo = false` | `T-374-W1-18` | *Unable to find an accessible element with the role "alert"* |
| `MW-25` | Borrar el efecto `setEnVuelo(false)` por `[paso]` | `T-374-W1-22` | *volver al paso del verificador lo encuentra diciendo «estamos en el verificador» con el navegador quieto…* |
| `MW-25b` | Borrar los dos `addEventListener` del apagador | `T-374-W1-22` | *volver a la pestaña no apagó «estamos en el verificador»: la frase se queda para siempre…* |
| `MW-26` | Borrar `if (enCursoRef.current) return;` | `T-374-W1-23` | *el segundo toque del mismo lote volvió a llamar al caso de uso… expected 2 to be 1* |
| `MW-26b` | Sacarle `disabled` + etiqueta al botón de `PantallaEntrar` | `T-374-W1-23` | *Unable to find… role "button" and name "Conectando con tu billetera..."* |
| `MW-26c` | Ídem, al botón compartido de `Salir` | `T-374-W1-23` | *Unable to find… role "button" and name "Pidiendo la verificación..."* |
| `MW-27` | `MS_DE_ESPERA_DE_LA_COTIZACION = 0` | `T-374-W1-19` | *la espera de la cotización dejó de ser la del árbol viejo… expected +0 to be 300* |
| `MW-29` | Restaurar «Se guarda solo mientras lo completás.» | `T-374-W1-8` | *la pantalla «envio» sugiere que lo cargado se guarda solo* |
| `MW-30` | Restaurar «Una vez sola…» | `T-374-W1-8` | *la pantalla «identidad» promete que la identidad se pide una sola vez* |

⚠️ **DOS FALSOS KILLED DECLARADOS**, porque los dos mutantes ponen rojo a más de un `it`:
`MW-29` también cae en `T-374-W1-18` y `MW-30` también en `T-374-W1-16`, **los dos por el mismo
predicado nuevo** (`revisarCopy` corre en los dos). El `×` que cuenta es el de `T-374-W1-8`, que es
el barrido de copy de las cinco pantallas, citado arriba por su mensaje.

### 11.4 · 🔴 TRES MUTANTES SOBREVIVIERON PRIMERO, Y NINGUNO ERA UN FALSO POSITIVO

Esto es lo que más vale de esta tanda, así que va con nombre y medición:

1. **`MW-26` sobrevivió (`13 passed`).** La primera versión de `T-374-W1-23` tocaba el botón **una vez
   por `act`**, así que React alcanzaba a pintar el `disabled` entre un toque y el siguiente y el
   segundo ⛔ nunca llegaba al manejador. ⇒ **el `it` estaba midiendo el `disabled` con el nombre de
   la guarda de reentrada.** Arreglo: los dos primeros toques van **en el mismo `act`**, que es la
   carrera real (dos toques antes de que la pantalla se entere del primero). Con eso, `MW-26` muere
   con *expected 2 to be 1*.
2. **`MW-26b` sobrevivió (`13 passed`).** El mutante estaba **bien aplicado en disco** pero sobre el
   botón de `Salir`, **un componente que ese `it` no renderizaba**: la pantalla de entrada usa su
   propio `<Button>`. ⇒ un mutante que no toca ningún camino ejecutado es un **KILLED que no existe**,
   y leerlo como «el control funciona» habría dejado sin defensa al botón que dispara `startKyc` y
   `confirmAndSend`. Arreglo: **dos** mutantes (`MW-26b` al botón propio, `MW-26c` al compartido) y
   una pata (D) nueva en el `it` que ejercita `Salir` con el caso de uso en vuelo.
3. **La aserción (A) de `T-374-W1-22` era un CONTROL VACÍO, y lo destapé sondeando el apagador.**
   Estaba escrita como «tocar el enlace → «Volver» → el texto no está», mirando **la pantalla del
   envío**, que ⛔ **no renderiza el bloque en vuelo en ningún caso**. ⇒ el texto desaparecía de ahí
   con apagador y sin él. **Medido**: con el efecto atado a `[]` en vez de a `[paso]`, esa versión
   daba **`13 passed`**. Arreglo: se vuelve **al mismo paso** («Volver» y después «Seguir»), que es la
   reproducción literal del CR, y ahí sí `MW-25` muere.

### 11.5 · Constraints, verificadas

- **`flow.tsx` Δ0**: `wc -l` ⇒ **4453** · `/usr/bin/git diff --numstat 25c3f73..HEAD -- src/presentation/flow.tsx` ⇒ **vacío**.
- **Bandera apagada**: ningún `.env` la define; `T-374-W1-11` verde.
- **Citas ancladas**: **0 nuevas** en `5afe979..HEAD` (medido con el patrón de §6.4 sobre las líneas
  `+` del diff ⇒ lista vacía), **0 marcadores `[[CENSO …]]`** en
  el diff, y ⚠️ **«0 partidas» era falso**: eran **2**, medidas por F4 (una) y por su fix-pack (la
  otra), y las dos están corregidas — el método que las ve está en §6.4. La única cita al árbol viejo
  que hacía falta —el molde del `guard`— quedó **sin ancla y sin número de línea**, a propósito.
- **Ninguna pantalla toca disco ni la URL**: `T-374-W1-12`, ahora con el barrido de seis formas de
  salida y sus cuatro controles de lectura (una lectura de `href` ⛔ NO puede ponerse roja: el
  anfitrión la necesita en el montaje).
- **Sin `6`/`5`/`7` publicados**, ningún número de salidas, ninguna promesa sobre «Crear la cuenta»
  ni sobre no necesitar SOL, y sin em dashes: `T-374-W1-8`, ahora con **dos predicados más**.
- **Español rioplatense** en todo el copy nuevo, y **cada frase nueva verificada contra el código
  antes de escribirla** — que es la razón por la que este fix-pack existe.
- ⛔ **No se dice que algo falló cuando no falló**: las cuatro etiquetas en curso nombran el trabajo
  que de verdad está corriendo, y el mensaje del mínimo describe un corte, ⛔ no un error.

### 11.6 · Un lint nuevo, encontrado y cerrado

`biome` pasó de **140** a **141** warnings con el efecto del apagador: `useExhaustiveDependencies`
marcaba `[paso]` como dependencia de más, porque el cuerpo ⛔ no lee `paso`. **No se sacó la
dependencia**: `paso` es el DISPARADOR, y sacarlo deja el efecto corriendo una sola vez en el montaje
(que es exactamente el mutante `MW-25`). Se suprimió con su motivo escrito.
⚠️ **Y hay un gotcha medido**: la supresión **partida en varias líneas ⛔ NO suprime nada** — `biome`
la reporta como *«Suppression comment has no effect»* y la regla queda encendida igual. Va en **una
sola línea, pegada al `useEffect`**. Hoy: **140 warnings**, el baseline de siempre.

### 11.7 · El gate, corrido DOS veces, entero y en orden

Con `/usr/bin/git add -A` antes de cada corrida, porque el gate se mide contra el índice:

| Corrida | `npm run qa` | `npm run build` |
|---|---|---|
| 1 | exit **0** · `0 errores` / **140 warnings** · **178 archivos / 3520 tests** | exit **0** |
| 2 | exit **0** · mismos números | exit **0** |

**3513 → 3520** son los **siete** `it` nuevos (`W1-18`…`W1-24`); **178 archivos**, sin cambios ⇒ los
dos README siguen diciendo la verdad. Los **140 warnings** son la deuda preexistente que
`biome.jsonc` declara; ⛔ ninguno está en el árbol nuevo.
⚠️ El flake preexistente de `vuelta-por-enlace-carrera.test.tsx` ⛔ **no apareció** en ninguna de las
dos corridas. No se lo tocó ni se lo puso en cuarentena.

---

## 12 · FIX-PACK DEL F4 (2026-09-02) — los tres hallazgos que bloqueaban PRENDER la bandera

F4 dio *«SÍ se puede desplegar con la bandera apagada. NO se puede prenderla todavía»*. Este fix-pack
cierra los tres que faltaban, y ⛔ nada más. ⛔ El residual de `AC-6` (§1.6 de F4) queda como estaba,
declarado y acotado, y ⛔ no se recortó una sola línea de prosa.

### 12.1 · `H-1` · `AC-8` mandaba a la persona UN PASO MÁS ADELANTE

**El defecto**: una sola tabla de aterrizaje servía a los dos caminos, así que la rama de error
devolvía el paso SIGUIENTE. Medido por F4 con el código de rechazo real de Phantom:
`?dl=firmar-tx&errorCode=4001` ⇒ *Seguimiento*, con *«Todavía no hay ningún envío en curso»* y sin
forma de reintentar la firma. Y el docblock lo presentaba **como el cumplimiento**.

**El arreglo**: `ORIGEN_POR_ENLACE` + `origenDe`, en `src/presentation/recorrido/salto.ts`. Sin
código de error, el aterrizaje (`AC-7`); con código, **el paso del que se salió** (`AC-8`).

| Marca | De dónde SALE, y el sitio de producción que lo emite | Con rechazo, la persona ve |
|---|---|---|
| el connect | `connectWallet.execute()` ⇒ pantalla de entrada | *Cuánto y para quién* (el desvío del NUNCA) |
| firma de la transacción | `confirmAndSend.execute()` ⇒ pantalla de firmar | *Firmar y enviar* |
| firma del patrocinio | ídem | *Firmar y enviar* |
| creación del nonce | ídem (salto DENTRO de preparar la firma) | *Firmar y enviar* |
| PoP del pago | `confirmAndSend.execute()`, antes del `prepare` | *Firmar y enviar* |
| PoP de la identidad | 🔴 `connectWallet.execute()`, ⛔ **no** la pantalla de identidad | *Cuánto y para quién* |
| el verificador | pantalla de identidad (la única que lo ofrece) | *Tu identidad* |
| la salida al navegador | pantalla de entrada (la única que la ofrece) | *Cuánto y para quién* |

⚠️ **El choque entre las dos mitades de `AC-8`, resuelto y ⛔ no disimulado**: para las marcas que
salen de la pantalla de entrada, *«el mismo paso donde estaba»* **es** el paso que el mismo AC
prohíbe con la palabra NUNCA. **Gana la prohibición**: `aterrizajeDelAnfitrion` las desvía por
`aterrizaEnLaEntrada` —que así deja de ser un fallo-cerrado hipotético y pasa a tener camino de
producción— **y conserva el motivo**. Desde ahí la pantalla de entrada queda a un «Volver».

**Sus dos tests, con sus dos mutantes, los dos corridos:**

| Mutante | Aplicado | Muere en | Mensaje |
|---|---|---|---|
| `MW-3` · la PoP del pago vuelve a apuntar al aterrizaje | `salto.ts:156` | `T-374-W1-3` | *«la prueba de posesión del pago dejó de tener su origen en la pantalla de firmar…: expected 'seguimiento' to be 'firmar'»* |
| `MW-3b` · `origenDe` = `aterrizajeDe` (la TABLA ÚNICA) | `salto.ts:172` | `T-374-W1-3` | *«ninguna marca vuelve a un paso ANTERIOR al del camino feliz: las dos tablas colapsaron…: expected 0 to be greater than or equal to 1»* |
| `MW-15` · idem `MW-3`, medido de punta a punta | `salto.ts:156` | `T-374-W1-25` | *«una firma rechazada deja a la persona en otra pantalla que la que salió…: expected 'Seguimiento' to be 'Firmar y enviar'»* — y `14 passed`, o sea ⛔ ningún vecino lo mató |

⛔ **Por qué `T-374-W1-3` necesitaba DOS redes**: comparar el error contra el feliz es verdadero para
la tabla única Y para las dos tablas, así que ⛔ no separa el arreglo del defecto — era un candado
**sobre** el defecto. Hoy hay (a) ligaduras marca → origen contra los nombres que producción exporta
y (b) un conteo POSITIVO de marcas que retroceden, que con la tabla única da **0**.

### 12.2 · `H-2` · «los predicados van por el SENTIDO» era falso — **se cambió el MECANISMO, opción (b)**

**La opción elegida: (b), pinear el copy aprobado.** El motivo, en una línea: **un guard de texto ⛔
no puede cazar un sentido**, y (a) es el mismo control que confirma la forma que ya funcionaba, un
escalón más arriba — cerrás las dos paráfrasis conocidas y la sexta redacción vuelve a pasar. El pin
es **infalsificable por paráfrasis**: no entiende el copy, lo **congela**.

**Las cinco paráfrasis, corridas de a una, con el marcador verificado en disco antes de cada suite:**

| # | Copy inyectado | ¿Lo caza `revisarCopy`? | ¿Lo caza el pin? |
|---|---|---|---|
| F4/`M1b` | *«Lo que vas escribiendo queda en este navegador mientras completás.»* | ⛔ NO | ✅ `T-374-W1-26` |
| F4/`M2b` | *«Es una sola vez: en tus próximos envíos ya no hace falta repetirla.»* | ⛔ NO | ✅ `T-374-W1-26` |
| **mía P3** | *«Tus datos quedan acá guardados hasta que vuelvas.»* | ⛔ NO | ✅ `T-374-W1-26` |
| **mía P4** | *«Con una verificación te alcanza para todos tus envíos.»* | ⛔ NO | ✅ `T-374-W1-26` |
| **mía P5** | *«Cuando termines, te dejamos de nuevo en esta pantalla.»* (la mentira de `H-3`) | ⛔ NO | ✅ `T-374-W1-26` |

Las cinco dieron `1 failed | 14 passed`, y el `1 failed` es **siempre `T-374-W1-26`, por su nombre**:
o sea que ⛔ ninguna la mató un vecino, y que las cinco **sobreviven** a los dos `not.toMatch`. ⇒ tres
redacciones **nuevas, inventadas para este fix-pack**, confirman que (a) no era viable.

**Y la frase que declaraba la cobertura ahora dice la verdad** (`recorrido.test.tsx`, docblock de
`revisarCopy`; `T-374-W1-24` renombrado a *«los dos LITERALES»*; §11.2 de este reporte): los dos
predicados cazan **literales cercanos**, y de ahí ⛔ no se concluye nada sobre otra redacción.

⚠️ **Lo que el pin ⛔ NO cubre, dicho en su propio docblock**: el copy que aparece sólo tras una
interacción o una vuelta con marca; el bloque del alquiler de red, que se **enmascara** a propósito
(no es copy de esta ola y su cifra sale de una constante de la cadena ⇒ pinearlo pondría el guard en
rojo por algo que ⛔ no es copy, y el arreglo natural sería actualizar el pin sin leerlo); y el
itinerario corto, que hoy ⛔ no tiene productor.

### 12.3 · `H-3` · la tercera frase que le mentía a la persona

`volves` decía *«Cuando termines, volvés a esta misma pantalla y seguimos donde estabas.»*. **Cinco de
las seis marcas aterrizan en otra pantalla**, y la frase **contradecía a `AC-7`**.

**Dice hoy**: *«Cuando termines, el recorrido sigue. Si rechazás alguna firma, te avisamos y podés
volver a intentar.»*

**Las dos afirmaciones, verificadas ANTES de escribirla, para las SEIS marcas y los DOS caminos:**

1. *«el recorrido sigue»* ⇒ el camino feliz ⛔ nunca deja a la persona en un paso ANTERIOR al que
   salió. Lo mide `T-374-W1-3` (`adelantadas` vacío + los índices) y la mitad (a) de `T-374-W1-25`.
   ⛔ **No dice «el siguiente»** (falso para el nonce, que vuelve a su propia pantalla) ni **«esta
   misma pantalla»** (falso para las otras cinco).
2. *«si rechazás alguna firma, te avisamos y podés volver a intentar»* ⇒ toda vuelta con código trae
   MOTIVO (`T-374-W1-3`, aserción por marca) y aterriza en un paso **con un control vivo**
   (`T-374-W1-25`, `toBeEnabled` sobre el botón del anuncio).

⛔ **Lo que la frase NO dice, a propósito**: ⛔ no nombra ninguna pantalla; ⛔ no promete que lo
cargado sobreviva (un salto REMONTA EL ÁRBOL y el borrador de esa pestaña se pierde — es el caso que
`MOTIVO_SIN_ENVIO` existe para explicar); ⛔ no promete un motivo específico (la billetera puede
mandar un código que este repo no traduce y ahí `humanError` contesta su texto genérico).

### 12.4 · Las citas partidas — **eran DOS, no una**

F4 encontró **1** donde el fix-pack anterior declaró **0**. Midiendo con el método correcto (§6.4)
eran **2**. Las dos corregidas; la de `bienvenida-composicion.test.tsx` **línea-neutro**, porque ese
archivo recibe citas ancladas por número. Conteo hoy sobre los 16 archivos: **por línea 42 =
normalizado 42 ⇒ 0 partidas**. **Una cita anclada NUEVA** en todo el fix-pack —
`(`anterior`, `./pasos.ts:111`)`— y ⛔ **ninguna** a los seis destinos censados.

### 12.5 · El presupuesto — la CORRECCIÓN DEL ARGUMENTO, sin recortar nada

F4 aceptó la decisión y **rechazó el argumento**, con razón: *«este fix-pack no los tocó»* es una
regla de procedencia que, aplicada siempre, hace que el presupuesto **sólo pueda crecer**. El motivo
bueno es el **contenido**: esas líneas contienen **evidencia medida** —incluida una retractación de
su propia evidencia en `bandera.ts`, que F4 re-midió sobre su propio artefacto de build—. ⛔ Este
fix-pack ⛔ no recortó nada, por pedido explícito. ⚠️ Queda en pie la deuda que F4 marcó: *«el salto
remonta el árbol»* escrito **cuatro veces** es repetición, ⛔ no evidencia. **Declarada, ⛔ no
bloqueante.**

### 12.6 · El gate, corrido DOS veces, entero y en orden

Con `/usr/bin/git add -A` antes de cada corrida.

| Corrida | `npm run qa` | `npm run build` |
|---|---|---|
| 1 | exit **0** · `0 errores` / **140 warnings** · **178 archivos / 3522 tests** | exit **0** |
| 2 | exit **0** · mismos números | exit **0** |

**3520 → 3522** son los DOS `it` nuevos (`T-374-W1-25` y `T-374-W1-26`). **178 archivos**, sin
cambios ⇒ los dos README siguen diciendo la verdad.

🔴 **EL FLAKE DEL GATE COMPLETO ES PREEXISTENTE, Y ESTÁ MEDIDO — ⛔ no supuesto.** Una corrida previa
de `npm run qa` sobre este árbol dio **exit 1** con `T-373-1b` (`solana-wallet.test.ts`, causa
`deeplink_reloj_inconsistente`), un archivo que este fix-pack ⛔ **no toca** y que en aislamiento da
`85 passed`. Para no atribuirlo ni descartarlo por corazonada, monté un **worktree del árbol LIMPIO
de `0d3e3ce`** y corrí el gate entero **10 veces**:

| Árbol | Corridas | Rojos | Cuáles |
|---|---:|---:|---|
| `0d3e3ce` **limpio** | 10 | **2** | `T-372-W3-10b` (`sesion-borra-la-segunda-firma.test.tsx`) en una; la otra no quedó identificada por nombre |
| este fix-pack | 3 | 1 | `T-373-1b` (`solana-wallet.test.ts`) |

⇒ **el árbol limpio también se pone rojo, y en un `it` DISTINTO y en otro archivo.** ⇒ ⛔ no es un
`it` flakeando: es una condición intermitente del gate completo en paralelo, presente **antes** de
este fix-pack. ⚠️ Y esto es **más ancho** que el flake de `vuelta-por-enlace-carrera.test.tsx` que
`sesion.ts` documenta: son otros dos archivos. ⛔ **No se puso nada en cuarentena** y ⛔ no se afirma
la causa: lo establecido es que **el árbol limpio flakea**, ⛔ no por qué.

---

*Reporte de la ola W1 · WKH-374 · `nexus-dev` · 2026-09-01/02 · rama `feat/234-w1-cinco-pantallas`,
fix-pack del AR en `fix/374-w1-fix-pack-ar`, fix-pack del CR en `fix/374-w1-fix-pack-cr`.*
