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

## 2 · Los 13 `it`, con sus mutantes

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

Método: se clasifica línea a línea; las líneas en blanco quedan fuera de las dos columnas.

| Columna | Techo §11 | Real | Estado |
|---|---:|---:|---|
| Producción ejecutable | ≤ 550 | **634** | 🔶 **1,15x — se justifica abajo** |
| Producción prosa | ≤ 400 | **338** | ✅ |
| Ratio de prosa del bloque | ≤ 42 % | **34,8 %** | ✅ |
| Tests, líneas no en blanco | ≤ 2.200 | **967** | ✅ (44 % del techo) |
| Archivos tocados | ≤ 14 | **15** | 🔶 **+1 — se justifica abajo** |
| Líneas en `wasiai-a2a/src/` | 0 | **0** | ✅ |
| Δ en `flow.tsx` | 0 | **0** | ✅ |

**Por archivo de producción:**

| Archivo | Código | Prosa | Prosa % |
|---|---:|---:|---:|
| `pasos.ts` | 42 | 48 | 53,3 % |
| `bandera.ts` | 3 | 30 | 90,9 % |
| `salto.ts` | 96 | 118 | 55,1 % |
| `pantallas.tsx` | 287 | 100 | 25,8 % |
| `recorrido.tsx` | 206 | 42 | 16,9 % |

### 6.1 · Las tres desviaciones, dichas en cuál columna están

1. **Producción ejecutable: 634 contra 550 (1,15x).** El exceso está entero en las dos piezas de
   JSX: `pantallas.tsx` (287 contra 260 propuestos) y `recorrido.tsx` (206 contra 120). La causa es
   mecánica y verificable leyendo el archivo: el estilo del repo pone **un prop por línea**, así que
   una pantalla con seis props declarados y seis pasados ocupa doce líneas que en otra convención
   serían dos. Aplicando la pregunta que decide —*¿qué parte de esto seguiría existiendo si lo
   escribiera alguien que ya conoce este repo?*—: **todo**, porque lo que ocupa el espacio son las
   firmas de props y el JSX de cinco pantallas, no lógica. No hay un solo `useEffect` ni una sola
   rama que no corresponda a un AC. **No se recortó**, y se declara.
2. **Archivos tocados: 15 contra 14.** Los 12 del Scope IN, **más los tres que `T-17` y `CD-W1-9`
   mandan tocar**: `bienvenida.tsx`, `grecas.tsx` y `bienvenida-composicion.test.tsx`, una línea cada
   uno, sólo para re-derivar las citas sueltas. Esos tres estaban en las tareas y **no** en la tabla
   de Scope IN ni en el techo de archivos. El diff en los tres es `1 1` (una línea cambiada).
3. **Prosa por archivo por encima del 50 % en tres archivos.** `bandera.ts` estaba **declarado como
   excepción de antemano** (§11, «~65 %»); el número real es **90,9 %**, y la razón es aritmética:
   la función tiene **3 líneas de código**, así que cualquier docblock la desborda. En términos
   absolutos son **30 líneas de prosa**, y su exemplar (`wallet-availability.ts`) está declarado en
   77 % como archivo. Se recortó lo redundante y ⛔ **no se tocó el gotcha de despliegue**, que es lo
   único que separa «prendí la bandera» de «prendí la bandera y no pasó nada».
   `pasos.ts` (53,3 %) y `salto.ts` (55,1 %) quedan apenas por encima del 50 % **después** de una
   pasada de recorte que sacó las repeticiones. Bajarlos más significaba borrar el porqué del tercer
   valor y el porqué de la tabla indexada por posición, que son las dos decisiones que esta ola tiene
   que poder defender. **Queda declarado para que el CR lo juzgue, no escondido.**

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
- **Citas ancladas**: **21** en los archivos del diff, **conteo por archivo = conteo por línea ⇒
  ninguna partida**. Las **tres nuevas** apuntan a `protocol.ts:335`, `flow-vm.ts:1503` y
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

*Reporte de la ola W1 · WKH-374 · `nexus-dev` · 2026-09-01 · rama `feat/234-w1-cinco-pantallas`,
fix-pack del AR en `fix/374-w1-fix-pack-ar`.*
