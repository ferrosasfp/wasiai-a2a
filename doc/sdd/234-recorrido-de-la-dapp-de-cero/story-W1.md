# Story File · [WKH-374] · **OLA W1** — Las cinco pantallas del recorrido nuevo, detrás de la bandera apagada

> **Este documento es autocontenido. El Dev NO lee el SDD.** Todo lo que hace falta para implementar
> W1 está acá: archivos exactos, citas exactas, tests con su nombre, el mutante que mata cada test,
> el falso KILLED a evitar, el gate, el presupuesto y la definición de terminado.
>
> **Repo donde vive el trabajo:** `/home/ferdev/.openclaw/workspace/chaski-v3` — **sólo ahí**.
> **Repo ancla de los artefactos:** `wasiai-a2a` (`doc/sdd/234-recorrido-de-la-dapp-de-cero/`).
> ⛔ **De `wasiai-a2a` no se toca una sola línea de `src/`** (AC-15).
>
> **Rama:** `feat/234-w1-cinco-pantallas`
> *(verificada LIBRE hoy con `/usr/bin/git rev-parse --verify` ⇒ `fatal: Needed a single revision`.
> La rama de W0 fue `feat/234-recorrido-de-la-dapp-de-cero` y sí existe: ⛔ no la reuses.)*
>
> **Fecha:** 2026-09-01 · **Modo:** QUALITY · **Gate `SPEC_APPROVED`: OTORGADO**
> **Base:** `chaski-v3@25c3f73aad8f01c25fc26ed644f688b7db98783b`, `main` = `origin/main`, árbol limpio.

---

## §0 · Antes de escribir una línea: los números de hoy, y las citas se re-derivan

Todas las citas `archivo:línea` de este documento se derivaron **hoy**, sobre `25c3f73`, con
`/usr/bin/grep -n` y `sed -n 'Np'`. Si algo mergeó sobre `chaski-v3` entre este documento y tu primer
commit, **re-derivá las citas de §6 antes de editar**.

**Los seis números de los que cuelga toda la ola, verificados hoy:**

| Hecho | Cómo se verifica | Valor de hoy |
|---|---|---|
| `wc -l src/presentation/flow.tsx` | `wc -l` | **4453** |
| Marcador de censo de líneas de `flow.tsx` | `/usr/bin/grep -n "lineas=4453" app/page.tsx` | `[[CENSO src/presentation/flow.tsx lineas=4453]]` en `app/page.tsx:23` |
| Conteo de archivos de test en los DOS README | `README.md:436` y `README.es.md:462` | **174** en los dos |
| Archivos de test reales en el árbol | `/usr/bin/find src app scripts contracts -name "*.test.ts*" -o -name "*.spec.ts*" \| wc -l` | **174** ✅ coincide |
| Gate del repo | `package.json:20` | `qa` = `lint && typecheck && typecheck:scripts && test` |
| Nombre de bandera libre | `/usr/bin/grep -rn "CHASKI_RECORRIDO" src app scripts contracts` | **cero hits** ⇒ `NEXT_PUBLIC_CHASKI_RECORRIDO_V2` está libre |

⛔ **Al cerrar la ola, el conteo de los README se re-deriva CORRIENDO el candado, nunca contando a
mano** (`CD-W1-11`). W1 agrega **4** archivos de test ⇒ el número pasa a **178** en los dos.

### 0.1 · Herramientas — reglas duras de esta ola

- ⛔ **NO uses `cat`.** Leé con `sed -n 'N,Mp'`, `head -n N`, `/usr/bin/grep -n`.
- ⛔ **NO uses `grep` a secas** (respeta el `.gitignore` y te va a dar cero donde hay hits). Usá
  `/usr/bin/grep -rn`.
- ⛔ **NO filtres con `grep -v "\.test\."`**: los archivos que más importan acá son de test.
- ⛔ **Usá `/usr/bin/git`, no `git`.** Bajo el proxy, `git diff` **trunca cortando hunks** y `git log`
  **borra los merges**.
- ⛔ **Backticks dentro de `"..."` en bash SE EJECUTAN.** Para mensajes de commit usá comillas simples
  o `-F archivo`.
- `flow.tsx` tiene líneas de miles de caracteres: leelo con `sed -n 'Np' | cut -c1-200`.

---

## §1 · Qué se construye y por qué (contexto compacto)

Hoy el recorrido de un envío vive entero en `src/presentation/flow.tsx` — **4453 líneas**, con
`STEP_INDEX` (`flow.tsx:90-99`) declarando **8 pasos + 3 destinos** y `STEP_LABELS` (`flow.tsx:89`)
mostrando **4 etiquetas**. El paso `connect` es el **tercero**: se pide monto, beneficiario y CCI
**antes** de tener una dirección conectada.

**W1 construye las cinco pantallas del recorrido nuevo, en un árbol propio, con la bandera APAGADA.**
Nada de lo que W1 escribe se ejecuta en producción. El encendido y toda medición en teléfono son
**W3**; el borrador durable del lado del servidor y el vale de vuelta son **W2**.

Tres cosas que definen el tamaño de esta ola, y las tres están medidas:

1. 🔴 **El recorrido nuevo NO usa router de cliente.** Cambia de pantalla **por estado**, en un solo
   punto de montaje (`app/page.tsx`), igual que el viejo. La razón no es de estilo:
   `urlDeVueltaDeKyc` (`src/presentation/splash-puerta.ts:54`) devuelve
   `` `${origin}/?${PARAM_KYC}=${VALOR_VUELTA_KYC}` `` — **la barra está escrita en la función**, o
   sea que **la vuelta del verificador está clavada a la raíz `/`, en producción**. Con rutas del App
   Router esa vuelta aterrizaría en la **pantalla de entrada**, que es exactamente lo que **AC-7
   prohíbe con la palabra NUNCA**. ⇒ ⛔ **cero `useRouter`, cero `next/link`, cero rutas nuevas bajo
   `app/`, y el candado de `L-5` queda BYTE-IDÉNTICO.**
2. 🔴 **El envío se guarda por el puerto que YA existe**, `RemittanceRepository` / `LocalRepo`
   (`src/infrastructure/persistence.ts:92`), bajo la clave que ya existe,
   `KEY = "chaski.remittances.v1"` (`persistence.ts:15`). ⛔ **Sin clave nueva. Sin módulo
   `borrador.ts`.** Ver §3.2, que es el hallazgo más fuerte de esta ola.
3. 🔴 **`app/page.tsx` tiene 36 líneas y es el archivo más vigilado del repo por línea escrita.**
   Tiene **cinco minas medidas**, y ninguna está en el work-item. Están en §5, y las cinco son
   load-bearing.

---

## §2 · Las cinco pantallas — qué ve la persona, y qué la hace avanzar

El plegado sale de `STEP_INDEX` en `flow.tsx:90-99`, verificado hoy.

| # | `id` | Nombre en pantalla | Qué ve la persona | Qué la hace avanzar | Sale de |
|---|---|---|---|---|---|
| **1** | `entrar` | **Entrar** | La marca, una frase de qué hace Chaski, y **un** botón: «Conectar mi billetera». Debajo, en letra chica: la afirmación no custodial y la salida a instalar Phantom. ⚠️ **Si el camino que le toca a este navegador sale a la billetera, la pantalla lo dice ANTES de que toque el botón** | Tocar «Conectar mi billetera» ⇒ conecta, o **anuncia el salto y sale** | `bienvenida` + `connect` |
| **2** | `envio` | **Cuánto y para quién** | Monto en USDC, quién recibe (nombre + CCI) **y la cotización en vivo en la misma pantalla**: cuánto llega en PEN, la comisión y quién la cobra. **Se guarda solo** (§3.2) | Un botón: «Seguir». ⛔ Esta pantalla **NO salta** a ningún lado | `send` + `review` |
| **3** | `identidad` | **Tu identidad** | **Sólo la primera vez.** Qué se verifica, con quién, y que se sale a otra pantalla **y se vuelve acá mismo** | Un botón que sale al verificador. Vuelve con `?kyc=return` y **aterriza acá mismo** | `verify` |
| **4** | `firmar` | **Firmar y enviar** | **Qué se firma, exactamente, y cuánto sale**: monto + comisión + alquiler del escrow, y a dónde va la plata. Anuncia el salto **antes** de darlo | Un botón que sale a la billetera. Vuelve con `?dl=<paso>` | `confirm` |
| **5** | `seguimiento` | **Seguimiento** | Dónde va el envío, y el recibo cuando cierra | Estado terminal del recorrido | `track` + `done` |

**Cuatro decisiones que van con el mapeo, y cada una tiene su candado en §9:**

1. **`AC-1` sale del ORDEN, no de una pantalla nueva.** `connect` era el paso **3**; acá es el **1**,
   y eso es lo que da la dirección con la que el envío puede guardarse.
2. **`AC-4` se cumple en los dos casos, no en uno.** La pantalla 3 es condicional ⇒ un envío
   recurrente muestra **4** pantallas y uno de primera vez **5**. ⇒ el stepper (`Stepper({ steps,
   current })`, `src/presentation/ui.tsx:370`) ⛔ **no** recibe la tabla: recibe el **itinerario
   calculado para esta persona**, y el invariante es `etiquetas.length === itinerario.length`
   **siempre**. La tabla enumerable de `AC-2` sigue teniendo 5 y sigue siendo el único sitio donde el
   conjunto está escrito.
3. **`AC-3` es una salida por pantalla, no un botón global.** De la 2 en adelante, cada pantalla
   ofrece «Volver» que retrocede **un** paso y ⛔ **no borra** monto, beneficiario ni CCI.
4. ⛔ **La pantalla 4 NO escribe ningún número de firmas como literal.** El anuncio enumera **las
   firmas que el camino elegido va a pedir**, derivadas en runtime, y la pantalla renderiza el largo
   de esa lista.

---

## §3 · 🔴 El invariante que ordena todo, y cómo se guarda el envío

### 3.1 · EL INVARIANTE, con estas palabras

> 🔴 **Todo salto a la billetera o al verificador se anuncia ANTES, se muestra MIENTRAS PASA, y al
> volver SE ATERRIZA DONDE SE ESTABA, UN PASO MÁS ADELANTE.**
> ⛔ **NUNCA en la pantalla de entrada.** Ni en el camino feliz (`AC-7`) ni en el de error (`AC-8`):
> el error cambia el **motivo en pantalla**, ⛔ nunca el paso.

**Y se resuelve como FUNCIÓN PURA DE LA MARCA que trae la URL de vuelta.** ⛔ No de un estado
recordado, ⛔ no del disco, ⛔ no de la sesión. No es una preferencia: es lo único que puede
funcionar. W0 midió y dejó cerrado que **el salto remonta el árbol de React** (`L-5` verdadera). Un
árbol remontado **no recuerda en qué paso estaba**. Lo único que cruza es la URL.

**El universo de marcas — las tres se IMPORTAN de producción, ⛔ ningún literal se escribe:**

| Marca | Dónde vive el símbolo (verificado hoy) |
|---|---|
| `?dl=<paso>` con `<paso>` ∈ `MARCAS_DE_VUELTA` (**seis**: `conectar`, `firmar-tx`, `firmar-patrocinio`, `crear-nonce`, `pop-payout`, `pop-kyc`) | `MARCA` en `src/infrastructure/solana/deeplink/sesion.ts:480`; `MARCAS_DE_VUELTA` **y** `enlaceDeVuelta` los dos en `sesion.ts:495` (Δ0 declarado en esa misma línea) |
| `?kyc=return` | `PARAM_KYC` en `src/presentation/splash-puerta.ts:45`; `VALOR_VUELTA_KYC` en `splash-puerta.ts:47` |
| `?wb=1` | `PARAM_SALIDA` en `src/presentation/salida-al-navegador-de-la-billetera.ts:50`; `VALOR_SALIDA` en `salida-al-navegador-de-la-billetera.ts:60` |

El molde de «leer una marca sin escribir su literal» ya está en el repo: `motivoParaNoMostrar`
(`src/presentation/splash-puerta.ts:84`) compara `params.get(PARAM_KYC)` y hace `params.has(MARCA)`
**sin escribir ninguno de los dos strings**.

**La tabla de aterrizaje** (`aterrizajeDe(marca) → paso`, en `src/presentation/recorrido/salto.ts`):

| Marca de vuelta | Aterriza en | Por qué |
|---|---|---|
| `conectar` | **2 · `envio`** | Volvió de conectar ⇒ hay dirección ⇒ el paso siguiente |
| `crear-nonce` | **4 · `firmar`** | Es un salto **dentro** de la preparación de la firma |
| `firmar-tx` · `firmar-patrocinio` | **5 · `seguimiento`** | La firma se dio ⇒ el envío ya está en curso |
| `pop-payout` · `pop-kyc` | **5 · `seguimiento`** | La prueba de posesión sirve para leer el estado, no para mover fondos |
| `kyc=return` | **3 · `identidad`** | 🔴 **Aterriza en `identidad`, no al principio.** Es el pedido textual del founder |
| `wb=1` | **el paso que la marca de salida ya lleva** | El módulo de salida ya transporta su contexto (`hrefSinLaMarcaDeSalida` en `salida-al-navegador-de-la-billetera.ts:144`, `vinoDeUnaSalidaConBorrador` en `:179`) |
| *(marca desconocida)* | **`"sin-aterrizaje"`** — el **tercer valor** | ⛔ **No** un paso por defecto, ⛔ no un booleano |

⛔ **La tabla no puede quedar incompleta en silencio.** El conjunto de marcas se **recorre desde
`MARCAS_DE_VUELTA`** (que es un **valor**, no un tipo — su docblock en `sesion.ts` explica por qué),
así que una séptima marca sin aterrizaje pone rojo `T-374-W1-0`.

**Las tres pantallas del salto:**

| Momento | Qué hay en pantalla | AC |
|---|---|---|
| **Antes** | Un bloque que dice **qué** se va a firmar y **por qué**, con el botón que sale. ⛔ Nunca un salto sin aviso previo | `AC-5` |
| **Mientras** | Un estado con **texto**: «Estamos en tu billetera. Volvés acá mismo.» ⛔ Ni pantalla vacía ni `spinner` mudo | `AC-6` |
| **Si vuelve mal** | **El mismo paso** donde estaba, con el motivo legible que `humanError` (`src/presentation/flow-vm.ts:572`) y `copyDeEnlace` (`flow-vm.ts:1503`) ya saben producir. ⛔ Nunca `entrar`, ⛔ nunca un estado que obligue a recargar a mano | `AC-8` |

⚠️ **`AC-6` tiene un límite que se declara y no se disimula**: mientras la persona está en la
billetera, **nuestra pantalla no está a la vista**. Lo que `AC-6` garantiza es **lo que encuentra al
volver la vista atrás**, no que alguien lo esté mirando. ⛔ No escribas prosa que afirme otra cosa.

### 3.2 · Cómo se guarda el envío — **sin abrir una sola superficie nueva**

> **W1 no inventa ningún almacén.** El envío se guarda por el puerto que ya existe,
> `RemittanceRepository`, cuya única implementación de navegador es `LocalRepo`
> (`src/infrastructure/persistence.ts:92`), bajo `KEY = "chaski.remittances.v1"` (`persistence.ts:15`).
> ⛔ **Cero claves nuevas de `localStorage`. Cero PII nueva at-rest. Cero módulo `borrador.ts`.**

**Y transcribí el porqué, que es el hallazgo más fuerte de esta ola:**

🔴 **En el recorrido nuevo la pantalla donde se tipea NO salta.** Los saltos salen de la **1**
(conectar) y de la **4** (firmar). La pantalla **2** —la única donde se escribe monto, beneficiario y
CCI— **no salta a ningún lado**. ⇒ **no existe ningún momento en que un envío a medio escribir tenga
que sobrevivir a un salto.** Eso es consecuencia directa de *«conectar es lo primero»*: **el orden
nuevo ELIMINA el problema en vez de resolverlo.**

🔴 **Y el CCI ya está at-rest en este navegador hoy**, medido: `LocalRepo` serializa el snapshot
entero con `JSON.stringify` (`persistence.ts:114`), el snapshot incluye `beneficiary`
(`src/domain/remittance.ts:253`), y el campo `destination` de `Beneficiary`
(`src/domain/remittance.ts:48-54`) **es el CCI de 20 dígitos** — el propio tipo lo dice. ⇒ una clave
nueva **no protegería nada** y **sí** abriría un segundo sitio de escritura de la misma PII, que es la
deuda que este ecosistema ya pagó dos veces.

⇒ *«Se guarda solo»* significa, exactamente: **en cuanto el envío de la pantalla 2 está completo y
válido, se crea/actualiza por `container.createRemittance` y queda atado a la dirección conectada.**
Antes de eso no se escribe nada, y no hace falta.

### 3.3 · La costura que W1 deja para W2

⛔ **Ninguna pantalla nueva toca `window.localStorage`, `sessionStorage`, `document.cookie` ni la
URL. Todo pasa por `container.<casoDeUso>`.** Es la costura que deja a W2 cambiar **dónde** vive el
borrador sin tocar una pantalla, y **es falsable con un barrido estático** (`T-374-W1-12`, pata (a)).

Los casos de uso disponibles en `Container` (`src/composition/container.ts:50`, obtenido con
`getContainer()` en `container.ts:265`): `previewQuote`, `createRemittance`, `connectWallet`,
`startKyc`, `resumeKyc`, `lockQuote`, `confirmAndSend`, `trackRemittance`, `listHistory`,
`abandonPendingKyc`, `forgetKyc`.

### 3.4 · Lo que W1 ⛔ **NO** afirma sobre el guardado

- ⛔ **No** afirma que el envío sobreviva al salto al **navegador de la billetera**: eso es `L-4`, y
  W0 lo dejó **NO MEDIDO** con dueño, instrumento, precondición (*Testnet Mode*) y fecha (W3).
  *«No se pudo medir»* ⛔ no es *«cruza»* ni *«no cruza»*.
- ⛔ **No** afirma nada sobre el vale, el identificador opaco ni el borrador durable: es **W2**.

---

## §4 · Scope

### 4.1 · Scope IN — la lista exhaustiva (todo bajo `/home/ferdev/.openclaw/workspace/chaski-v3`)

| | Archivo | N/M | Qué contiene |
|---|---|---|---|
| **P1** | `src/presentation/recorrido/pasos.ts` | **NUEVO** | La tabla única y enumerable de los 5 pasos (`AC-2`), sus etiquetas, el itinerario condicional y las transiciones. ⛔ Cero JSX, cero DOM |
| **P2** | `src/presentation/recorrido/bandera.ts` | **NUEVO** | `recorridoV2Enabled()` — opt-in estricto, sólo el literal `"true"`, sobre `NEXT_PUBLIC_CHASKI_RECORRIDO_V2`, **con el gotcha del build escrito adentro** |
| **P3** | `src/presentation/recorrido/salto.ts` | **NUEVO** | Anuncio, estado en vuelo y **aterrizaje** (§3.1). Función pura sobre la URL. ⛔ Cero DOM |
| **P4** | `src/presentation/recorrido/pantallas.tsx` | **NUEVO** | Las **cinco** pantallas, como cinco componentes exportados |
| **P5** | `src/presentation/recorrido/recorrido.tsx` | **NUEVO** | El anfitrión `<Recorrido/>`: máquina de estado, stepper, salida no destructiva, cableado del `Container` |
| **P6** | `app/page.tsx` | **MODIFICADO** | El ternario de la bandera. ⚠️ **Cinco minas: §5** |
| **T1** | `src/presentation/recorrido/pasos.test.ts` | **NUEVO** | `T-374-W1-1`, `T-374-W1-2` |
| **T2** | `src/presentation/recorrido/salto.test.ts` | **NUEVO** | 🔴 `T-374-W1-0` (la premisa), `T-374-W1-3`, `T-374-W1-4` |
| **T3** | `src/presentation/recorrido/recorrido.test.tsx` | **NUEVO** | `T-374-W1-5` … `T-374-W1-9` |
| **T4** | `src/presentation/recorrido/inercia.test.tsx` | **NUEVO** | `T-374-W1-10`, `T-374-W1-11`, `T-374-W1-12` |
| **R1** | `README.md` | MODIFICADO | `**174 test files**` → `**178 test files**` (`:436`) |
| **R2** | `README.es.md` | MODIFICADO | `**174 archivos de test**` → `**178 archivos de test**` (`:462`) |

**Total: 12 archivos** (6 de producción, 4 de test, 2 README). Techo: 14.

Más, **en `wasiai-a2a`, y sólo esto**: `doc/sdd/234-recorrido-de-la-dapp-de-cero/w1-report.md`.

### 4.2 · Scope OUT — tocarlos es **BLOQUEANTE en AR**

| Archivo / cosa | Por qué está prohibido |
|---|---|
| ⛔ `src/presentation/flow.tsx` | **Δ0 = 0 líneas, 0 caracteres.** El recorrido viejo queda **intacto y funcionando**. `wc -l` ⇒ **4453**, y el marcador `[[CENSO … lineas=4453]]` de `app/page.tsx:23` es el candado |
| ⛔ `src/presentation/el-salto-remonta-el-arbol.test.tsx` | Es el candado de `L-5`. **No se toca para acomodar la prosa.** Ver mina 5 (§5.5) |
| ⛔ `src/presentation/ola-2-pantallas.test.tsx` | Su lista de dos archivos escrita a mano es de **otra HU**. W1 cubre su propio árbol, no arregla el ajeno |
| ⛔ `src/presentation/splash-puerta.ts` | `urlDeVueltaDeKyc` es producción **compartida con el camino viejo**. Moverlo sería mover la vuelta del árbol viejo |
| ⛔ `src/presentation/bitacora-de-vuelta.ts` | Su `:176` dice *«en ocho archivos»* y hoy son **seis**. Es un menor **conocido y con dueño**, ⛔ no de esta ola: sumaría un archivo al Scope IN |
| ⛔ Cualquier ruta nueva bajo `app/` | El recorrido cambia de pantalla **por estado**. §1, punto 1 |
| ⛔ `wasiai-a2a/src/` | **Cero líneas** (AC-15, `CD-3`) |
| ⛔ `wasiai-a2a/doc/sdd/_INDEX.md` por encima de la línea 144 | `CD-10` |
| ⛔ Encender la bandera, y toda medición en teléfono | Es **W3**, y `CD-8` lo prohíbe en el mismo cambio que la introduce |
| ⛔ El borrador server-side, el vale y el identificador opaco | Es **W2** (`AC-10`, `AC-11`, `AC-12`) |
| ⛔ Retirar el camino viejo | **HU propia**, no una tarea al pie |

---

## §5 · 🔴 LAS CINCO MINAS DE `app/page.tsx`

`app/page.tsx` tiene **36 líneas** y es el archivo más vigilado del repo por línea escrita. Las cinco
están medidas hoy, y **ninguna está en el work-item**. Leelas enteras antes de tocar el archivo.

### 5.1 · Mina 1 — la palabra `pasoInicial` no puede aparecer NI EN UN DOCBLOCK

`src/presentation/barra-destinos.test.tsx:303` tiene
`it("🔴 el único `<RemittanceFlow>` de producción NO pasa `pasoInicial`")`, y lo que hace es leer el
**fuente entero** de `app/page.tsx` con `readFileSync` y exigir:

```
expect(pagina, "el `<RemittanceFlow>` de producción vive acá: si se mudó, este candado dejó de mirar").toContain("<RemittanceFlow");
expect(pagina).not.toContain("pasoInicial");
```

🔴 **Es `not.toContain` sobre el fuente entero, comentarios incluidos.** ⇒ **la palabra `pasoInicial`
no puede aparecer en `app/page.tsx`, ni en código ni en prosa.**
⇒ **La costura de test del árbol nuevo se llama `pasoDeArranque`.** ⛔ Y `<Recorrido/>` no puede
tener una prop con el nombre viejo si se la pasa desde ahí.
*(El molde de «costura de test declarada como tal» es el docblock de `pasoInicial` en
`src/presentation/flow.tsx:133-144` — se copia el molde, **con el nombre cambiado**.)*

### 5.2 · Mina 2 — `T-DIAG-CABLEADO` fija la forma del import y del montaje

`src/presentation/diagnostico-de-vuelta.test.tsx:435` tiene
`it("T-DIAG-CABLEADO: `app/page.tsx` importa y monta el bloque, fuera de todo comentario")`. Saca los
comentarios con tres `replace` y después exige, textual:

- `` toContain(`import { ${nombre} } from "@/presentation/diagnostico-de-vuelta"`) ``
- `` new RegExp(`<${nombre}\\s*/>`).test(sinComentarios) ``

⇒ **`CD-W1-4`**: el ternario de la bandera envuelve **SÓLO** los dos componentes:
`<RemittanceFlow/>` ↔ `<Recorrido/>`. **`<Splash/>` y `<DiagnosticoDeVuelta/>` quedan FUERA del
ternario, montados incondicionalmente, como hoy.** Meterlos adentro los dejaría comentados o cambiaría
la forma del import ⇒ rojo.

### 5.3 · Mina 3 — TRES citas sueltas a `app/page.tsx:20-21` que el gate NO caza

`/usr/bin/grep -rn "app/page\.tsx:[0-9]"` sobre las cuatro raíces ⇒ **tres sitios**, verificados hoy:

- `src/presentation/bienvenida.tsx:206`
- `src/presentation/grecas.tsx:9`
- `src/presentation/bienvenida-composicion.test.tsx:862` (en el **nombre** de un `it`)

Las tres citan `app/page.tsx:20-21`, que hoy son `<>` (`:20`) y `<Splash />` (`:21`).

🔴 **Son citas SUELTAS: `src/composition/citas-ancladas.test.ts` NO las mira.** El regex `ANCLADA`
(`citas-ancladas.test.ts:73`) pide el par `` `símbolo`, `ruta:NN` ``; estas no lo tienen.

⇒ 🔴 **Agregar el import de `<Recorrido/>` arriba de `app/page.tsx` corre esas tres líneas y las deja
ROTAS Y VERDES.** Es exactamente el modo de falla *«las citas que rompés vos al arreglar otra cosa»*.
⇒ **`CD-W1-9`**: después de la **última** edición de `app/page.tsx`, las tres se **re-derivan** con
`/usr/bin/grep -n` y se corrigen, o se declara por escrito por qué no. ⛔ **El gate no las va a
cazar. Nadie más las va a mirar.**

### 5.4 · Mina 4 — los dos README pasan de 174 a 178

`src/composition/readme-test-count.test.ts:87` define `READMES` con **un marcador por idioma**:

```
{ file: "README.md",    marker: /\*\*(\d+) test files\*\*/,       label: "ingles" }
{ file: "README.es.md", marker: /\*\*(\d+) archivos de test\*\*/, label: "espanol" }
```

Medido hoy: el barrido da **174**, `README.md:436` dice `**174 test files**` y `README.es.md:462`
dice `**174 archivos de test**`. W1 agrega **4** archivos de test ⇒ **178** en los dos.

⇒ **`CD-W1-11`**: el número se deriva **corriendo el candado** (`npm test` y leyendo el mensaje de
fallo, que trae el real), ⛔ **nunca contando a mano**. W0 descubrió esta mina **después** de fijar su
presupuesto de archivos.

### 5.5 · Mina 5 — ⚠️ UNA LÍNEA DE **PROSA** PUEDE PONER ROJO EL CANDADO DE `L-5`

Los `PATRONES` de `src/presentation/el-salto-remonta-el-arbol.test.tsx:71-78` son **call-shaped** y
barren **`src`, `app`, `scripts`, `contracts`** enteros, **comentarios incluidos**:

```
{ nombre: "useRouter",       pattern: /\buseRouter\s*\(/ }
{ nombre: "router.push",     pattern: /\brouter\s*\.\s*push\s*\(/ }
{ nombre: "router.replace",  pattern: /\brouter\s*\.\s*replace\s*\(/ }
```

**Lo corrí hoy contra siete líneas de docblock candidatas de W1**, y este es el resultado medido:

| Línea de prosa | Resultado |
|---|---|
| `* ⛔ Este árbol no usa router.push(...) para cambiar de pantalla.` | 🔴 **ROJO** (`router.push`) |
| `* ⛔ Este árbol no llama a useRouter() nunca.` | 🔴 **ROJO** (`useRouter`) |
| `* ⛔ Prohibido router.replace(ruta) en el recorrido.` | 🔴 **ROJO** (`router.replace`) |
| `* ⛔ Nada de router.push ni router.replace acá.` | 🟢 verde |
| `* ⛔ No se importa nada de next/navigation salvo notFound.` | 🟢 verde |
| `* el recorrido no usa <Link> para cambiar de pantalla` | 🟢 verde |
| `// el recorrido no usa <Link> para cambiar de pantalla` | 🟢 verde |

⇒ **`CD-W1-2`**: en `src/` y `app/`, ⛔ **prohibido escribir en prosa los literales `router.push(`,
`router.replace(` o `useRouter(` CON paréntesis.** Se escriben **sin paréntesis**.

🔴 **El fix-pack del CR de W0 cerró sólo el caso SIN paréntesis** (aquel `MNR-2` era sobre substrings
crudos: *«acá NUNCA se usa useRouter»* sin paréntesis ya no pone rojo; **con** paréntesis sí).
⛔ **NO SE TOCA EL GUARD PARA ACOMODAR LA PROSA.** Ese es el camino por el que un falso rojo
recurrente termina debilitando un candado, y este repo ya lo tiene escrito. **Se escribe la prosa de
otra forma.**

⚠️ Y ojo con **este mismo documento**: si copiás una línea de la tabla de arriba a un docblock de
`chaski-v3`, la copiás con el paréntesis. Este archivo vive en `wasiai-a2a/doc/`, fuera del barrido.

---

## §6 · Anti-Hallucination Checklist — específica de esta HU

Marcá cada una **antes** de escribir código. Todas verificadas hoy sobre `25c3f73`.

**El árbol y la rama**
- [ ] `chaski-v3` está en `main` = `origin/main` = `25c3f73`, y `/usr/bin/git status --short` sale vacío.
- [ ] La rama `feat/234-w1-cinco-pantallas` **no existe** (`/usr/bin/git rev-parse --verify` ⇒ fatal).
- [ ] `wc -l src/presentation/flow.tsx` ⇒ **4453**.
- [ ] `/usr/bin/grep -rn "CHASKI_RECORRIDO" src app scripts contracts` ⇒ **cero hits**.

**Las minas de `app/page.tsx`**
- [ ] `app/page.tsx` tiene **36 líneas**; `<Splash />` en `:21`, `<DiagnosticoDeVuelta />` en `:32`,
      `<RemittanceFlow />` en `:33`; los dos marcadores `[[CENSO src/presentation/flow.tsx …]]` en
      `:23` y `:24`.
- [ ] `src/presentation/barra-destinos.test.tsx:303` exige `not.toContain("pasoInicial")` sobre el
      fuente entero de `app/page.tsx`.
- [ ] `src/presentation/diagnostico-de-vuelta.test.tsx:435` exige la línea de import literal y
      `<DiagnosticoDeVuelta />` fuera de comentario.
- [ ] Las tres citas sueltas a `app/page.tsx:20-21` están en `bienvenida.tsx:206`, `grecas.tsx:9` y
      `bienvenida-composicion.test.tsx:862`.
- [ ] `README.md:436` y `README.es.md:462` dicen **174**, y el barrido real también.

**Los símbolos que se importan de producción (⛔ ninguno se reescribe)**
- [ ] `src/infrastructure/solana/deeplink/sesion.ts:480` exporta `MARCA = "dl"`.
- [ ] `src/infrastructure/solana/deeplink/sesion.ts:495` exporta `MARCAS_DE_VUELTA` (los **seis**
      valores) **y** `enlaceDeVuelta` en la **misma línea física**. ⚠️ Δ0 declarado ahí: esa línea
      recibe 5 citas ancladas. ⛔ No la partas.
- [ ] `src/presentation/splash-puerta.ts:45` exporta `PARAM_KYC = "kyc"`, `:47` `VALOR_VUELTA_KYC =
      "return"`, `:54` `urlDeVueltaDeKyc(origin)`, `:84` `motivoParaNoMostrar`.
- [ ] En `src/presentation/salida-al-navegador-de-la-billetera.ts`: `PARAM_SALIDA = "wb"` en `:50`;
      `VALOR_SALIDA = "1"` en `:60`; `hrefSinLaMarcaDeSalida` en `:144`;
      `vinoDeUnaSalidaConBorrador` en `:179`.
- [ ] `src/infrastructure/persistence.ts:15` exporta `KEY = "chaski.remittances.v1"`; `:92`
      `class LocalRepo`; `:114` el `setItem` del blob entero; `:117` `save()`.
- [ ] `src/domain/remittance.ts:48-54` es `interface Beneficiary { name; country; method; destination }`
      y el docblock de `:52` dice que `destination` **es el CCI de 20 dígitos**.
- [ ] `src/composition/container.ts:50` es `export interface Container`; `:96` `createContainer()`;
      `:265` `getContainer()`.

**El sistema de diseño y el copy que se reusa**
- [ ] `src/presentation/ui.tsx` exporta `ChaskiMark` `:44`, `Button` `:78`, `Card` `:101`,
      `Field` `:112`, `TextInput` `:142`, `Row` `:157`, `Pill` `:200`, `Muted` `:243`, `Aviso` `:295`,
      `Money` `:346`, **`Stepper({ steps, current })` `:370`**. ⛔ Se usan; ⛔ no se escribe un
      sistema de diseño nuevo.
- [ ] `src/presentation/flow-vm.ts` exporta `statusDisplay` `:133`, `escrowRentExplainer` `:426`,
      `humanError` `:572`, `copyDeEnlace` `:1503`. ✅ **`flow-vm.ts` NO es destino de ningún censo**
      ⇒ importarlo y citarlo anclado es libre.

**Los moldes de test**
- [ ] `src/presentation/wallet-availability.ts:98` (`mwaEnabled`) y `:156` (`deeplinkEnabled`) son
      opt-in estricto contra el literal `"true"`; el gotcha `NEXT_PUBLIC_` del build está en `:95-96`
      y `:152-154`. ⇒ es el molde entero de `bandera.ts`.
- [ ] `src/presentation/wallet-availability.test.tsx:1021` es
      `it("T-065-20: sólo el literal `true` prende; ausente, vacía, `1`, `TRUE` y `true ` NO")`.
- [ ] `src/presentation/wallet-availability.test.tsx:1037` es
      `it("T-065-21: con la bandera APAGADA el paso `connect` es byte-idéntico al de hoy")`, con el
      `toBeTruthy()` de `CD-18` en `:1048` y la mitad falsadora `.not.toBe(apagada)` en `:1066`.
      ⚠️ **En ese `it` NO existe ningún `toBe(apagada)`** — verificado hoy. ⛔ No lo busques ni lo
      cites: la pieza que se copia es la **falsadora**.
- [ ] `src/presentation/sesion-borra-la-segunda-firma.test.tsx:539` es
      `it("T-372-W3-8: tras una recarga (almacén nuevo), la PRIMERA firma se vuelve a pedir y la sesión no está en ningún disco")`,
      y sus cuatro aserciones de disco están en `:556-565`. ⚠️ **Leé §9.3 antes de copiarlas.**
- [ ] En `src/composition/citas-ancladas.test.ts`: `SCAN_DIRS` en `:51`; `SELF` en `:56`
      (**ruta exacta**); el regex `ANCLADA` en `:73`.
- [ ] `src/composition/no-evm-surface.test.ts:35` es `walk(dir, out)` y `:56` es `FORBIDDEN` — el
      molde de barrido del árbol con `readFileSync`.
- [ ] `src/presentation/ola-2-pantallas.test.tsx:89` es `clasesDe`, y el predicado del vocabulario de
      diseño vive en `:130` como `/^text-(xs|sm|base|lg|xl|[2-9]xl)$/`. ⚠️ **`T-O2-2` recorre una
      lista de DOS archivos escrita a mano** (`flow.tsx`, `ui.tsx`) ⇒ **el árbol nuevo queda fuera de
      su barrido**. Ver §9.4.
- [ ] En `src/presentation/el-salto-remonta-el-arbol.test.tsx`: `DIRS` (las cuatro raíces) en `:36`;
      `SELF` en `:45`; los seis `PATRONES` en `:71-78`; y en `:159` está
      `it("T-374-W0-3: el almacén de sesión es POR DOCUMENTO, la salida al enlace es una navegación de documento, y el instrumento sabe decir que sí")`.
- [ ] `src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx:707` es
      `it("T-372-W1-13: recurrente ⇒ 1 travesía y 0 viajes a la billetera; primera vez ⇒ la recarga es del verificador")`.
      ⚠️ **Ese `it` monta `<RemittanceFlow/>` a mano: no dice nada de `app/page.tsx`.**
- [ ] `src/presentation/bitacora-de-vuelta.ts:174-178` es el molde de **cita SIN ancla con su motivo
      al lado**. Se copia para citar a los seis destinos de censo.

**Los seis destinos de censo `entrantes` — ⛔ ninguna cita ANCLADA nueva hacia ellos**
- [ ] `src/presentation/flow.tsx`
- [ ] `src/infrastructure/solana-wallet.ts`
- [ ] `src/infrastructure/solana/preparacion-por-enlace.ts`
- [ ] `src/infrastructure/solana/deeplink/sesion.ts`
- [ ] `src/infrastructure/solana/deeplink/firma-por-enlace.ts`
- [ ] `src/application/use-cases/confirm-and-send.ts`

---

## §7 · Constraint Directives — copiadas textuales, todas vigentes

### 7.1 · Las duras de esta ola

- 🔴 **`CD-W1-1` · `flow.tsx` Δ0 = 0.** ⛔ **`src/presentation/flow.tsx` no se toca: 0 líneas, 0
  caracteres.** El recorrido **viejo queda intacto y funcionando**. Se verifica con `wc -l` ⇒
  **4453**, contra el marcador `[[CENSO src/presentation/flow.tsx lineas=4453]]` de `app/page.tsx:23`,
  ⛔ **no leyendo el diff**.
- 🔴 **`CD-W1-2` · La prosa no puede escribir el guard.** ⛔ Prohibido escribir en prosa de `src/` o
  `app/` los literales `router.push(`, `router.replace(` o `useRouter(` **con paréntesis**: ponen rojo
  `T-374-W0-3`. Se escriben sin paréntesis. ⛔ **Y no se toca el guard para acomodar la prosa.**
- 🔴 **`CD-W1-3` · Ninguna cita ANCLADA nueva** hacia los **seis** destinos de censo de §6. Van
  **sueltas y con su motivo al lado** (molde: `src/presentation/bitacora-de-vuelta.ts:174-178`).
- **`CD-W1-4`** · El ternario de la bandera envuelve **sólo** `<RemittanceFlow/>` ↔ `<Recorrido/>`.
  `<Splash/>` y `<DiagnosticoDeVuelta/>` quedan **fuera**, montados como hoy.
- **`CD-W1-5`** · ⛔ La palabra `pasoInicial` **no aparece en `app/page.tsx`**, ni en código ni en
  prosa. La costura del árbol nuevo se llama **`pasoDeArranque`**.
- **`CD-W1-6`** · ⛔ **Ninguna pantalla escribe un número LITERAL de firmas o de salidas.** El anuncio
  deriva la lista en runtime y renderiza su largo. ⛔ Y el reporte **no publica** ese número.
- **`CD-W1-7`** · ⛔ **Ningún literal de marca de vuelta** (`"dl"`, `"kyc"`, `"return"`, `"wb"`,
  `"1"`, los seis nombres de paso) **se escribe en el árbol nuevo ni en sus tests.** Todos se importan
  de producción.
- 🔴 **`CD-W1-15`** · ⛔ **Ninguna pantalla nueva toca `window.localStorage`, `sessionStorage`,
  `document.cookie` ni la URL.** Todo por `container.<casoDeUso>`. Es la costura de W2 y tiene candado
  (`T-374-W1-12`).
- **`CD-W1-16`** · ⛔ El árbol nuevo **no define lógica de dominio ni de caso de uso propia**. Lo que
  importa de `../application/` y `../domain/` está contenido en lo que ya importa `flow.tsx`.
- **`CD-W1-13`** · ⛔ **El gate es `npm run qa` → `npm run build`, entero, en orden, contra el ÍNDICE
  de git.** ⛔ **Prohibido `npx biome` y `npx tsc` sueltos.** Correr `vitest` solo **no es correr el
  gate**.
- **`CD-W1-14`** · ⛔ **La bandera se despliega APAGADA**, y el gotcha del build va escrito en
  `bandera.ts`: las `NEXT_PUBLIC_` las inlinea el **build**, así que cambiar la env en Vercel y
  redesplegar el mismo artefacto **no hace nada**.
- **`CD-W1-18`** · ⛔ **Cero líneas en `wasiai-a2a/src/`**, y ⛔ nada por encima de la línea 144 de
  `wasiai-a2a/doc/sdd/_INDEX.md`.
- **`CD-W1-19`** · ⛔ **El `w1-report.md` se materializa ANTES del commit de la ola.** Si el mensaje
  del commit nombra un documento, ese documento existe antes del commit. Este proyecto ya registró ese
  modo de falla **cinco veces**.

### 7.2 · Las del Auto-Blindaje — errores recurrentes, transcritos

- 🔴 **`CD-W1-8` · Ninguna frase de W1 puede afirmar más de lo que su código verifica.** Antes de
  escribir *«esto verifica que X»*, escribí el mutante que la volvería falsa **y corrélo**. Si el
  mutante también rompe el comportamiento, **no es el mutante de esa aserción**. ⛔ Y toda palabra que
  cuantifique —«el máximo», «el único», «no hay ninguno», «en N archivos»— sale de **un barrido sobre
  el conjunto entero**, ⛔ nunca de una muestra que ya tenías abierta.
  *(Es el patrón recurrente de las DOS últimas HUs: 2 bloqueantes del CR de W0 + 3 menores + 7 citas
  cruzadas rotas en la 233.)*
- 🔴 **`CD-W1-9` · Después de la última edición, re-derivá las citas y los conteos que tu propia
  edición corrió.** En particular las **tres citas sueltas a `app/page.tsx:20-21`** (§5.3), que ⛔ **el
  gate no caza**.
- 🔴 **`CD-W1-10` · Toda cita anclada nueva entra ENTERA en una línea física.** El candado
  **recolecta línea por línea**: un ancla partida por el salto de línea de un docblock **no se
  cuenta**, y queda **rota y verde POR AUSENCIA**. En W0 pasó: de 5 citas escritas, **3 quedaron
  partidas**. Método de detección, ya probado: después de la última edición, enumerá las citas del
  propio diff con el mismo regex del candado y **contá**. Si el número no coincide con lo que
  escribiste, las que faltan están partidas. ⛔ Un `grep` del símbolo NO sirve: el símbolo está, lo que
  falta es que el par entre entero en un renglón.
- 🔴 **`CD-W1-12` · Ningún guard puede leerse a sí mismo.** Exclusión por **ruta EXACTA** (molde:
  `SELF` en `src/composition/citas-ancladas.test.ts:56`), ⛔ **nunca por glob ni por el sufijo
  `.test.`** Y todo guard que afirme un `[]` lleva **control negativo con el literal EXACTO** que
  tiene que cazar. **W0 tuvo DOS guards que se leían a sí mismos**, y su propio control negativo
  estaba escrito por lo que **significa** («un push de router») en vez de por el **literal** que el
  instrumento busca, así que no cazaba nada. **El control negativo es lo único que separa «el árbol
  está limpio» de «el barrido no ve nada».**
- **`CD-W1-20` · Un `import` nuevo arriba de un archivo corre TODAS las citas de abajo.** Si tenés que
  extender un archivo que es destino de citas ancladas, lo que hace falta entra por
  `await import(...)` **dentro** del `it`. «Agregar al final» ⛔ **no incluye los imports**.
- **`CD-W1-21` · Un `1 failed` sin un `×` nombrado NO es un KILLED.** Cada mutante se verifica **en
  disco antes** de correr y se restaura contra `/usr/bin/git diff --numstat`, ⛔ nunca con un `.orig`
  cacheado. Y se reporta **cuál aserción** produjo el rojo.
- **`CD-W1-22` · Un `findBy*` dentro de `act()` se traba**, y un stub de `fetch` demasiado ancho
  revienta la pantalla y parece un bug del sujeto. Los dos pasaron en W0.

### 7.3 · Reglas de copy visible y de honestidad

- ⛔ **Sin em dashes en copy visible.** Español rioplatense, llano.
- ⛔ **Ninguna pantalla ofrece, menciona ni integra una billetera custodial o embebida**, y toda
  pantalla que hable de fondos **preserva la afirmación no custodial** (`AC-16`).
- 🔴 ⛔ **No prometas que «Crear la cuenta» desaparece**, ni digas ni insinúes que *«el remitente no
  necesita SOL»*. Eso lo entrega la HU **`071` de `chaski-v3`**, que **espera el `HU_APPROVED` del
  founder** y hoy **no lo tiene**.
- 🔴 ⛔ **PROHIBIDO publicar `6`, `5` o `7`** como métrica del recorrido: el `7` es **NO VERIFICABLE**
  y **no comparable** con el `2` medido por W0 sobre el tramo de ida del árbol **viejo**.
- 🔴 ⛔ **El número de salidas del recorrido nuevo NO se publica** mientras W4 de WKH-372 no tenga
  decisión del founder: **es 2 o 3** según esa decisión.
- ⛔ **No digas que algo falló cuando no falló.** *«No se pudo medir»* ⛔ no es *«no pasa»*.
- ⛔ **El recorrido dentro del navegador de Phantom no puede empeorar** — y eso se cierra con un
  **control que lo mida** (§9.5), ⛔ **nunca con una promesa en prosa**.

---

## §8 · Las waves, en orden de dependencia

> El orden **es** load-bearing. **W1.0 puede detener la ola entera.**

---

### 🔴 W1.0 · La premisa falsable + los contratos · **SERIAL · PRIMERA · BLOQUEANTE · 0 PANTALLAS**

**Archivos:** `pasos.ts`, `salto.ts`, `bandera.ts`, `pasos.test.ts`, `salto.test.ts` — **todos nuevos**.

🔴 **`T-374-W1-0` ES LA PUERTA DE LA OLA.** Afirma que **el universo de marcas de vuelta se DERIVA de
producción** y que **ninguna marca queda sin aterrizaje**.

> ⛔ **SI `T-374-W1-0` SALE ROJA, W1 SE DETIENE Y SE REPORTA.** Significa que el conjunto de marcas de
> vuelta **no es enumerable desde producción**, y entonces la tabla de aterrizaje de §3.1 sería una
> lista escrita a mano que envejece sola — que es exactamente la clase de artefacto que le costó **dos
> rechazos** a W0. No se «arregla» el test, no se ajusta el fixture hasta el verde, no se sigue a
> W1.1. Se para, se escribe **qué salió rojo con su salida textual**, y se escala al humano.

**Tareas:**
- [ ] **T1** — `/usr/bin/git checkout -b feat/234-w1-cinco-pantallas` desde `main@25c3f73`.
      Verificá antes que `main` = `origin/main` = `25c3f73` y que el árbol está limpio.
- [ ] **T2** — Re-derivar con `/usr/bin/grep -n` las citas de §6 que vayas a usar. Si alguna se movió,
      **actualizala en tu código, no en este documento**, y anotalo en el reporte.
- [ ] **T3** — Crear `src/presentation/recorrido/pasos.ts`: la **tabla única y enumerable** de los 5
      pasos con sus `id` y etiquetas, la función de itinerario condicional (4 pasos si el KYC ya está
      / 5 si es primera vez) y las transiciones. ⛔ Cero JSX, cero DOM, cero `localStorage`.
      ⛔ **El número 5 NO se escribe como literal en ningún lado**: sale de `tabla.length`.
- [ ] **T4** — Crear `src/presentation/recorrido/salto.ts`: `anuncioDe(...)`, el estado en vuelo, y
      `aterrizajeDe(marca)` con su **tercer valor** `"sin-aterrizaje"`. ⛔ **Los literales de marca se
      IMPORTAN** de `deeplink/sesion`, `splash-puerta` y `salida-al-navegador-de-la-billetera`
      (`CD-W1-7`). ⛔ Cero DOM.
- [ ] **T5** — Crear `src/presentation/recorrido/bandera.ts`: `recorridoV2Enabled()`, copiando el
      molde de `mwaEnabled` (`wallet-availability.ts:98`) — **opt-in estricto contra el literal
      `"true"`**, sobre `NEXT_PUBLIC_CHASKI_RECORRIDO_V2`. ⚠️ **El gotcha del build va escrito acá
      adentro, verbatim del molde de `:95-96`.** Este archivo va a quedar cerca de **65 % de prosa** y
      ⛔ **eso está aprobado de antemano** (§11): no lo bajes, porque bajarlo es borrar el gotcha.
- [ ] **T6** — Crear `salto.test.ts` con 🔴 **`T-374-W1-0`** (§9.2), `T-374-W1-3` y `T-374-W1-4`.
- [ ] **T7** — Crear `pasos.test.ts` con `T-374-W1-1` y `T-374-W1-2`.
- [ ] **T8** — Correr el gate completo (§10). **Si `T-374-W1-0` sale roja: PARAR y reportar.**
- [ ] **T9** — Matar los mutantes `MW-0`, `MW-1`, `MW-2` de §9, uno por uno y **por separado**,
      citando archivo · nombre del `it` · **cuál aserción** murió.

---

### W1.1 · Las cinco pantallas · **SERIAL respecto de W1.0**

**Archivo:** `src/presentation/recorrido/pantallas.tsx` — nuevo.

Los cinco componentes exportados, uno por pantalla de §2.

**Tareas:**
- [ ] **T10** — Escribir las cinco pantallas usando **el sistema de diseño de la casa**
      (`src/presentation/ui.tsx`: `Card`, `Field`, `TextInput`, `Button`, `Row`, `Aviso`, `Money`,
      `Muted`). ⛔ **No escribas un sistema de diseño nuevo.** ⛔ **No uses el vocabulario retirado**
      `text-xs|sm|base|lg|xl|2xl…` (lo mide `T-374-W1-12`, pata (b)).
- [ ] **T11** — El copy se reusa de `src/presentation/flow-vm.ts` donde ya existe
      (`escrowRentExplainer` `:426` para el alquiler del escrow, `statusDisplay` `:133` para el
      seguimiento, `humanError` `:572` y `copyDeEnlace` `:1503` para los motivos de error).
      ✅ `flow-vm.ts` **no es destino de censo** ⇒ citarlo anclado es libre.
- [ ] **T12** — La pantalla **1** dice **antes** si el camino de este navegador sale a la billetera
      (`AC-5`). La pantalla **4** anuncia qué se firma y cuánto sale, **derivando la lista de firmas
      en runtime** (`CD-W1-6`). ⛔ Ningún número literal de firmas.
- [ ] **T13** — Verificar a mano: ⛔ ninguna pantalla toca `localStorage`, `sessionStorage`,
      `document.cookie` ni asigna `window.location` (`CD-W1-15`). Todo por props / `container`.
- [ ] **T14** — Correr el gate completo.

---

### W1.2 · El anfitrión y el interruptor · **las dos mitades son PARALELIZABLES**

**Archivos:** `recorrido.tsx` (nuevo), `app/page.tsx` (**modificado**), `recorrido.test.tsx` (nuevo),
`inercia.test.tsx` (nuevo).

**El interruptor, exactamente — la forma, no el código final:**

```tsx
{recorridoV2Enabled() ? <Recorrido /> : <RemittanceFlow />}
```

⚠️ **Con `CD-W1-4`, `CD-W1-5` y `CD-W1-9` a la vista. Releé §5 entero antes de tocar `app/page.tsx`.**

**Tareas:**
- [ ] **T15** — Crear `src/presentation/recorrido/recorrido.tsx`: la máquina de estado sobre
      `pasos.ts`, el `Stepper` recibiendo **el itinerario** (no la tabla), la salida no destructiva
      («Volver» retrocede un paso y ⛔ no borra), el cableado de `getContainer()`
      (`src/composition/container.ts:265`) y la lectura de la marca de vuelta por `aterrizajeDe`.
      ⚠️ La costura de test se llama **`pasoDeArranque`** (`CD-W1-5`), y se declara como costura de
      test copiando el molde del docblock de `flow.tsx:133-144` **con el nombre cambiado**.
- [ ] **T16** — Modificar `app/page.tsx`: **un** import nuevo arriba y **el ternario alrededor de los
      dos componentes, y sólo de esos dos**. `<Splash/>` y `<DiagnosticoDeVuelta/>` quedan **fuera**.
      ⛔ La palabra `pasoInicial` **no puede aparecer**, ni en un docblock.
- [ ] **T17** — 🔴 **Re-derivar las TRES citas sueltas a `app/page.tsx:20-21`** (§5.3) y corregirlas:
      con el import nuevo pasan a `:21-22`. ⛔ **El gate no las caza.** Si decidís no corregir alguna,
      escribí por qué.
- [ ] **T18** — Crear `recorrido.test.tsx` con `T-374-W1-5` … `T-374-W1-9`.
- [ ] **T19** — Crear `inercia.test.tsx` con `T-374-W1-10`, `T-374-W1-11`, `T-374-W1-12`.
- [ ] **T20** — Correr el gate completo.
- [ ] **T21** — Matar `MW-6`, `MW-7`, `MW-9`, `MW-10`, `MW-12a`, `MW-12b` — uno por uno y por
      separado, citando archivo · nombre del `it` · **cuál aserción**.

---

### W1.3 · El cierre de la ola · **SERIAL, último**

**Tareas:**
- [ ] **T22** — Actualizar `README.md:436` y `README.es.md:462` de **174** a **178**, ⛔ **derivando el
      número corriendo el candado** (`npm test`; el mensaje de fallo trae el real), ⛔ nunca contando a
      mano.
- [ ] **T23** — 🔴 **Re-derivar TODO lo que tu propia edición corrió** (`CD-W1-9`): las tres citas
      sueltas, los conteos de docblock, y **enumerar las citas ancladas de tu propio diff con el regex
      del candado y contarlas** contra las que escribiste (`CD-W1-10`).
- [ ] **T24** — Verificar `wc -l src/presentation/flow.tsx` ⇒ **4453** y
      `/usr/bin/git diff --numstat main -- src/presentation/flow.tsx` ⇒ **vacío**.
- [ ] **T25** — Verificar `/usr/bin/git status` de `wasiai-a2a`: ⛔ **cero cambios en `src/`**.
- [ ] **T26** — 🔴 **Escribir `wasiai-a2a/doc/sdd/234-recorrido-de-la-dapp-de-cero/w1-report.md`
      ANTES del commit de la ola** (`CD-W1-19`).
- [ ] **T27** — Gate completo, una última vez, **con `/usr/bin/git add -A` primero**.
- [ ] **T28** — Commit. ⛔ Backticks dentro de `"..."` **se ejecutan**: usá comillas simples o `-F`.

---

## §9 · Plan de tests — cada `it` con su mutante NOMBRADO y su falso KILLED

> ⛔ **`CD-W1-21`:** cada `it` se rompe a propósito y el rojo se cita con **archivo · nombre del `it` ·
> cuál aserción murió**. Un `1 failed` sin un `×` nombrado **no es un KILLED**.
> ⛔ **`CD-W1-12`:** ninguno puede leerse a sí mismo.

### 9.1 · La tabla completa

| `it` | Archivo | Qué mide | AC / CD |
|---|---|---|---|
| `T-374-W1-0` | `salto.test.ts` | 🔴 **La premisa**: el universo de marcas es enumerable desde producción y **toda** marca tiene aterrizaje | `AC-7` |
| `T-374-W1-1` | `pasos.test.ts` | La tabla tiene **5** y el número **se deriva**, no se escribe | `AC-2` |
| `T-374-W1-2` | `pasos.test.ts` | `etiquetas.length === itinerario.length` en **los dos** casos (4 y 5) | `AC-4` |
| `T-374-W1-3` | `salto.test.ts` | ⛔ **Ninguna marca aterriza en `entrar`**, ni en el camino de error | `AC-7`, `AC-8` |
| `T-374-W1-4` | `salto.test.ts` | Los literales de las marcas **no están escritos** en el árbol nuevo | `CD-W1-7` |
| `T-374-W1-5` | `recorrido.test.tsx` | **Conectar es lo primero**: la pantalla 1 no pide monto, beneficiario ni CCI | `AC-1` |
| `T-374-W1-6` | `recorrido.test.tsx` | La salida no destructiva **no borra** lo cargado | `AC-3` |
| `T-374-W1-7` | `recorrido.test.tsx` | 🔴 El árbol NUEVO montado no deja la sesión en ningún disco, **con control positivo** | `CD-W0-7` |
| `T-374-W1-8` | `recorrido.test.tsx` | Copy: no custodial preservado, sin em dash, sin la promesa de la `071` | `AC-16` |
| `T-374-W1-9` | `recorrido.test.tsx` | El anuncio existe **antes** del salto y no escribe ningún número literal de firmas | `AC-5`, `AC-6`, `CD-W1-6` |
| `T-374-W1-10` | `inercia.test.tsx` | 🔴 **`AC-13`**: bandera apagada ⇒ **byte-idéntico** al árbol de hoy | `AC-13` |
| `T-374-W1-11` | `inercia.test.tsx` | Sólo el literal `"true"` prende la bandera | `AC-13` |
| `T-374-W1-12` | `inercia.test.tsx` | ⛔ Ninguna pantalla nueva toca disco ni URL, **y** el vocabulario de diseño es el de la casa | `CD-W1-15` |

### 9.2 · 🔴 `T-374-W1-0` — la premisa, en detalle

`it("T-374-W1-0: el universo de marcas de vuelta se DERIVA de producción, y ninguna queda sin aterrizaje")`

Afirma, **en este orden**:

1. **Calibración**: `MARCAS_DE_VUELTA` importada de `deeplink/sesion` tiene **length ≥ 6** y contiene
   los seis de hoy. ⛔ Sin esto, un import roto daría `[]` y **todo lo de abajo pasaría por vacío**.
2. Para **cada** elemento de esa tupla **más** la marca del verificador **más** la de salida al
   navegador de la billetera, `aterrizajeDe(...)` devuelve un paso **que está en la tabla de
   `pasos.ts`**.
3. Ese paso **no es `entrar`** — la aserción de `AC-7`, comparada **por valor** contra el `id`.
4. **Control negativo**: se le pasa una marca sintética que no existe
   (`"marca-que-nadie-escribio"`) y se exige que conteste el **tercer valor** —`"sin-aterrizaje"`— y
   ⛔ **no** un paso por defecto. ⚠️ **Un booleano acá perdería el tercer valor**, que es la lección
   más cara de esta HU.

**Mutante `MW-0`**: agregar un **séptimo** elemento a `MARCAS_DE_VUELTA` en
`src/infrastructure/solana/deeplink/sesion.ts:495` (línea-neutro: la tupla está en esa misma línea)
⇒ **cae la aserción 2**.
⛔ **Falso KILLED a evitar, y está medido en el repo**: `it("T-067-16: …")` en
`src/infrastructure/solana/deeplink/sesion.test.ts` **también** se pone rojo con ese mutante, y el
docblock de `sesion.ts:495` declara además que **`tsc` no puede cazarlo por construcción**. ⇒ el `×`
que cuenta es el de **`T-374-W1-0`, aserción 2**, citado por su mensaje.

### 9.3 · 🔴 `T-374-W1-7` — `CD-W0-7`, y el agujero de vacuidad YA MEDIDO

`it("T-374-W1-7: con el árbol NUEVO montado y una sesión viva, el token no está en ningún disco ni en la URL")`

🔴 **Medido con `node -e`, hoy, dos veces (por el SDD y de nuevo por mí)**: las cuatro aserciones de
disco de `T-372-W3-8` (`sesion-borra-la-segunda-firma.test.tsx:556-565`) son **todas
`.not.toContain(token)`**, y **sobre un almacén VACÍO pasan las cuatro**:

```
localStorage vacio   -> PASA (por vacio)     JSON.stringify({}) === "{}"
sessionStorage vacio -> PASA (por vacio)
cookie vacia         -> PASA (por vacio)
href sin token       -> PASA (por vacio)
token vacio: "cualquiercosa".includes("") === true
```

⇒ 🔴 **COPIARLAS TAL CUAL SOBRE EL ÁRBOL NUEVO DARÍA UN VERDE POR VACÍO.** Es exactamente el
`BLQ-MED-2` del AR de W0 (*«una aserción NEGATIVA que se satisface con una lista VACÍA»*).

⇒ **El `it` de W1 lleva TRES ASERCIONES ANTES de las cuatro**, y sin ellas el `it` no entra:

1. **El desenlace alcanzado**: el árbol nuevo se montó y **llegó al paso donde la sesión se acuña**.
   Afirmar el desenlace **antes** de contar.
2. **`token` es una cadena NO VACÍA y con forma `payloadB64.firma`** — dos partes separadas por
   punto, las dos no vacías.
3. **Control positivo**: el instrumento **sabe decir que sí**. Se siembra el token en `localStorage`
   a mano y se verifica que **la misma expresión lo encuentra**. Sin esto, las cuatro de abajo son
   indistinguibles de un instrumento roto.

**Mutante `MW-7`**: en el árbol nuevo, escribir el token con
`window.localStorage.setItem("x", token)` ⇒ cae la **primera** de las cuatro.
⛔ **Falso KILLED a evitar**: si aplicás `MW-7` **sin** las tres aserciones previas y el árbol no llega
a acuñar sesión, **el `it` da verde igual** — que es el defecto que este diseño existe para prevenir.
⇒ reportá **cuál** aserción produjo el rojo.

### 9.4 · `T-374-W1-12` — dos barridos, y los dos con control negativo

`it("T-374-W1-12: ninguna pantalla del recorrido nuevo toca disco, URL ni un tamaño de texto de fábrica")`

**Pata (a)** — barrido de `src/presentation/recorrido/**` con `readFileSync` buscando `localStorage`,
`sessionStorage`, `document.cookie` y asignaciones de `window.location`.
- ⛔ **Se lee con `readFileSync`, nunca con `import`**: un guard de existencia que importa lo que
  vigila muere por `Failed to resolve import`, y eso **no es un KILLED**.
- ⛔ **Exclusión por RUTA EXACTA** (molde: `SELF` en `citas-ancladas.test.ts:56`), ⛔ **nunca por glob
  ni por el sufijo `.test.`**: este archivo escribe los delatores en su propia prosa.
- **Control negativo obligatorio**: líneas sintéticas **en memoria** con los **literales exactos**, y
  se exige que las cace. ⚠️ En W0 el control negativo estaba escrito por lo que *significa* y no
  cazaba nada.
- Molde del barrido: `walk` en `src/composition/no-evm-surface.test.ts:35` y `FORBIDDEN` en `:56`.

**Pata (b)** — el mismo predicado del vocabulario de diseño, `/^text-(xs|sm|base|lg|xl|[2-9]xl)$/`
(`ola-2-pantallas.test.tsx:130`), aplicado a `src/presentation/recorrido/**`.
🔴 **Por qué hace falta**: `T-O2-2` recorre **una lista de DOS archivos escrita a mano** —
`src/presentation/flow.tsx` y `src/presentation/ui.tsx` — **así que el árbol nuevo queda fuera de su
barrido**. ⛔ El predicado se **re-escribe con su cita al lado**; ⛔ **no se importa
`ola-2-pantallas.test.tsx`**: importar un `.test.tsx` corre sus `describe` y los duplica en el
reporte. ⛔ **Y no se toca ese archivo**: su lista a mano es una HU aparte.

**Mutante `MW-12a`**: un `window.localStorage.getItem` en `pantallas.tsx` ⇒ cae (a).
**Mutante `MW-12b`**: un `className="text-sm"` en `pantallas.tsx` ⇒ cae (b).
⛔ **Falso KILLED a evitar**: `MW-12b` **no** pone rojo a `T-O2-2` (mide otra lista), así que un
`1 failed` acá **es** de este `it` — pero **nombrá el `×` igual**, porque la ausencia de un segundo
rojo es parte de la evidencia.

### 9.5 · `T-374-W1-10` — `AC-13`, y el control que mide que Phantom no empeoró

`it("T-374-W1-10: con la bandera APAGADA, la página monta el árbol de HOY y su innerHTML es idéntico")`

El molde es `it("T-065-21: …")` en `wallet-availability.test.tsx:1037`, **con su corrección**:
⚠️ **En ese `it` NO existe ningún `toBe(apagada)`** — verificado hoy. Lo que sí trae y hay que copiar
son sus dos piezas: el `toBeTruthy()` de `CD-18` en `:1048`, y la mitad falsadora `.not.toBe(apagada)`
en `:1066`.

Las tres aserciones, **en orden**:
1. Con la bandera **ausente**, se monta el subárbol de `app/page.tsx` y su `innerHTML` es **truthy**.
2. Ese `innerHTML` es **igual** al de `<RemittanceFlow/>` montado solo ⇒ *la bandera apagada monta el
   árbol de hoy*.
3. Con la bandera en `"true"`, el `innerHTML` es **distinto** ⇒ 🔴 **la mitad que vuelve falsable a la
   2**: sin ella, la 2 pasaría porque `<Recorrido/>` nunca se monta, **no porque la bandera lo
   decida**.

🔴 **Y de acá sale el control de que Phantom no empeoró, que necesita las DOS patas y ninguna sola
alcanza:**
- `it("T-372-W1-13: …")` en `recorrido-en-el-navegador-de-la-billetera.test.tsx:707` sigue **verde**
  ⇒ el árbol viejo, montado directo, conserva sus números en el cuadrante de Phantom.
  ⛔ **Pero ese `it` monta `<RemittanceFlow/>` a mano: no dice nada de `app/page.tsx`.**
- `T-374-W1-10` dice que `app/page.tsx` con la bandera apagada **es** ese mismo árbol.
- ⇒ **Sólo juntos** cierran «no empeoró» para W1. ⛔ **`AC-14` sobre el árbol NUEVO es de W3**, y en el
  reporte se dice **con esas palabras**.

**Mutante `MW-10`**: invertir el ternario de `app/page.tsx` ⇒ cae la aserción **2**.
⛔ **Falso KILLED a evitar**: `MW-10` **también** pone rojo a un puñado de `it` del árbol viejo que
montan la página. El `×` que cuenta es el de `T-374-W1-10`, **aserción 2**, citado por su mensaje.

### 9.6 · Los seis `it` restantes, en una línea cada uno

| `it` | Mutante nombrado | Falso KILLED a evitar |
|---|---|---|
| `T-374-W1-1` | **`MW-1`**: agregar un sexto paso a la tabla sin etiqueta ⇒ cae | Que el `5` esté escrito como literal en el `it`: entonces el mutante mata **el literal**, no la derivación. ⇒ **el número sale de `tabla.length`** y el `it` afirma la **forma** (todos los `id` únicos, todos con etiqueta) |
| `T-374-W1-2` | **`MW-2`**: devolverle al stepper la tabla entera en vez del itinerario ⇒ cae el caso recurrente | Correr **sólo** el caso de primera vez: ahí los dos coinciden y el mutante **sobrevive**. **Los dos casos van en el mismo `it`** |
| `T-374-W1-3` | **`MW-3`**: hacer que el camino de error devuelva `entrar` ⇒ cae | Probar sólo el camino feliz: `AC-8` es la mitad que importa. **El `it` recorre las dos ramas** |
| `T-374-W1-4` | **`MW-4`**: escribir el literal `"dl"` a mano en `salto.ts` ⇒ cae | Barrer con `import` en vez de `readFileSync`, y **excluirse por sufijo `.test.`** en vez de por ruta exacta: el guard se leería a sí mismo |
| `T-374-W1-6` | **`MW-6`**: que «Volver» limpie el estado ⇒ cae | Que el `it` verifique **el paso** y no **los campos**: el paso volvería bien igual. **Se afirman los valores de los tres campos, por valor** |
| `T-374-W1-9` | **`MW-9`**: borrar el bloque de anuncio ⇒ cae | Que el `it` busque el **botón** y no el **texto** del anuncio: el botón **sobrevive** al mutante |

Y `T-374-W1-5`, `T-374-W1-8`, `T-374-W1-11`:

| `it` | Mutante nombrado | Falso KILLED a evitar |
|---|---|---|
| `T-374-W1-5` | **`MW-5`**: poner el campo de monto en la pantalla 1 ⇒ cae | Afirmar sólo *«hay un botón de conectar»*: eso sigue siendo cierto con el mutante. **Se afirma la AUSENCIA de los tres campos** en la pantalla 1, y su **presencia** en la 2 (el control positivo que separa «no está» de «no se renderizó nada») |
| `T-374-W1-8` | **`MW-8`**: meter un em dash en el copy de una pantalla ⇒ cae | `it("ninguna pantalla del recorrido mete un em dash")` en `honest-copy.test.tsx:476` monta **el árbol VIEJO** ⇒ **no cubre el nuevo**. ⛔ No lo des por suficiente y ⛔ no lo toques |
| `T-374-W1-11` | **`MW-11`**: cambiar la comparación por `params.has(...)` / `!== undefined` ⇒ cae | Probar sólo `"true"` y ausente. El molde `T-065-20` (`wallet-availability.test.tsx:1021`) prueba **cinco**: ausente, vacía, `"1"`, `"TRUE"` y `"true "` con espacio. **Se copian los cinco** |

### 9.7 · Lo que W1 ⛔ **NO** mide, dicho antes de que alguien lea su verde

1. ⛔ **Nada de esto corre en un teléfono.** Todo es `jsdom`. Es **W3**.
2. ⛔ **Ningún número de travesías ni de salidas del árbol NUEVO.** Con la bandera apagada, **el árbol
   nuevo no se ejecuta**. Los `2` y `1` de W0 son del **tramo de ida del árbol VIEJO**, y ⛔ **no son
   comparables con el `7` heredado**, que sigue **NO VERIFICABLE**.
3. ⛔ **`AC-14` sobre el árbol nuevo NO se mide en W1.** Se declara para **W3**, con esas palabras.
4. ⛔ **Nada sobre el vale, el identificador opaco ni el borrador durable.** Es **W2**.

---

## §10 · El gate del repo — completo y en orden

```bash
cd /home/ferdev/.openclaw/workspace/chaski-v3
/usr/bin/git add -A          #  ⚠️ IMPRESCINDIBLE: el gate se mide contra el ÍNDICE de git
npm run qa                   #  = lint → typecheck → typecheck:scripts → test   (package.json:20)
npm run build                #  = next build --webpack                          (package.json:10)
```

⚠️ **Se mide contra el índice de git: `/usr/bin/git add -A` ANTES.** Correrlo antes del `git add` es
correrlo sobre un árbol donde el entregable **no existe**, y da verde.

⛔ **PROHIBIDO `npx biome` y `npx tsc` sueltos.** `npx` intenta bajar paquetes inexistentes y devuelve
un error que **se lee como fallo del gate**. Usá los scripts de `package.json` o los binarios de
`node_modules/.bin/`.

⛔ **Correr las partes de un gate no es correr el gate.** `lint` va **primero** y es el eslabón que
nadie alcanza: en este ecosistema un `import` sin usar sobrevivió **5 revisiones** porque todos
corrían `vitest` y `tsc` y nadie llegaba a lint.

⚠️ **Flake preexistente:** `src/presentation/vuelta-por-enlace-carrera.test.tsx`. **No es de esta HU.
⛔ NO se pone en cuarentena.** Si sale rojo **ahí y sólo ahí**, se re-corre **ese archivo** y se dice
**explícitamente en el reporte**, con la frecuencia medida y un denominador que no sea chico.
⚠️ W0 acumuló **0/60** contra un `7-13 %` declarado: si lo ves rojo, **esa línea de base es lo que lo
distingue de «lo rompí yo»**.

---

## §11 · Presupuesto de escala — **por columna**, con la prosa separada del código

| Columna | Techo | Reparto propuesto |
|---|---:|---|
| 🔴 **Producción ejecutable** | **≤ 550** | `pasos.ts` 45 · `bandera.ts` 12 · `salto.ts` 90 · `pantallas.tsx` 260 · `recorrido.tsx` 120 · `app/page.tsx` +8 = **535** |
| 🔴 **Producción comentario/prosa** | **≤ 400** (**≤ 42 %** del bloque) | 35 · 30 · 70 · 140 · 80 · +25 = **380** ⇒ ratio **41,5 %** |
| **Producción · por archivo** | **≤ 50 %** de prosa | ⚠️ **con `bandera.ts` como ÚNICA excepción declarada: ~65 %** |
| **Tests · total** | **≤ 2.200** | `pasos.test.ts` ~230 · `salto.test.ts` ~420 · `recorrido.test.tsx` ~750 · `inercia.test.tsx` ~450 = **~1.850** |
| **Tests · prosa** | **≤ 55 %** formal | ⛔ El *«42,8 % operativo»* está **RETIRADO**: era falso |
| **Archivos tocados** | **≤ 14** | **12**: 6 de producción, 4 de test, 2 README |
| 🔴 **Líneas en `wasiai-a2a/src/`** | **0** ⛔ estricto | |
| 🔴 **Δ en `src/presentation/flow.tsx`** | **0** ⛔ estricto | |

**⚠️ La excepción de `bandera.ts`, declarada de antemano y con su número.** Es una función booleana
más **el gotcha de despliegue que el repo obliga a repetir verbatim**. Su exemplar,
`wallet-availability.ts`, está en **77,0 % de prosa** (medido). `bandera.ts` va a quedar cerca de
**65 %**, y ⛔ **no se lo puede bajar sin borrar el gotcha**, que es lo único que evita un despliegue
que no despliega nada. **Está aprobado. ⛔ No lo bajes, y ⛔ el CR no lo cuenta como exceso.**

**Las tres reglas que gobiernan este presupuesto:**

1. **Los ~350 de margen en tests son deliberados, y se dice para qué son: los fix-packs del AR y del
   CR.** W0 se pasó **151,9 %** y **ninguna de las dos revisiones bajó su techo: las dos pidieron MÁS
   control**. ⛔ **No es permiso para escribir de más ahora.**
2. **La ratio test:código ejecutable se presupuesta en ~3,5:1 y ⛔ NO se cuenta como exceso.** Un CR
   que reporte *«se pasó»* mirando el total sin partir prosa/código **está midiendo mal**.
3. **La pregunta que decide un exceso**: *¿qué parte de esto seguiría existiendo si lo escribiera
   alguien que ya conoce este repo?* Un exceso justificado es información; **un exceso silencioso es
   el hallazgo**. Si el diff pasa **2x** cualquier columna, se justifica por escrito **diciendo en
   cuál columna está**, o se recorta.

---

## §12 · Riesgos que te tienen que preocupar mientras codeás

| # | Riesgo | Qué lo mitiga |
|---|---|---|
| 1 | 🔴 Tocás `app/page.tsx` y rompés las tres citas sueltas **en verde** | §5.3 + **T17** + **T23**. ⛔ El gate no las caza |
| 2 | 🔴 Escribís un docblock con `router.push(` y el gate se pone rojo por **prosa** | §5.5. ⛔ Se reescribe la prosa; ⛔ **no se toca el guard** |
| 3 | Escribís `pasoInicial` en un comentario de `app/page.tsx` | §5.1. La costura se llama **`pasoDeArranque`** |
| 4 | Copiás las cuatro aserciones de disco tal cual y **te da verde por vacío** | §9.3. **Tres aserciones antes**, incluido el control positivo |
| 5 | Un guard nuevo se lee a sí mismo | `CD-W1-12`. **Ruta exacta**, nunca glob ni sufijo `.test.` **W0 tuvo DOS** |
| 6 | Escribís una cita anclada **partida por el salto de línea** ⇒ rota y verde | `CD-W1-10` + **T23**. En W0: **3 de 5** quedaron partidas |
| 7 | Un `import` nuevo arriba de un archivo corre todas las citas de abajo | `CD-W1-20`. Usá `await import(...)` dentro del `it` |
| 8 | El `Stepper` recibe la tabla en vez del itinerario ⇒ 5 etiquetas para 4 pasos | `T-374-W1-2`, **con los dos casos en el mismo `it`** |
| 9 | Un `findBy*` dentro de `act()` se traba y muestra la pantalla anterior | `CD-W1-22`. Pasó en W0 |
| 10 | Un stub de `fetch` demasiado ancho revienta la pantalla y **parece un bug del sujeto** | `CD-W1-22`. Pasó en W0 |
| 11 | Publicás un número que no se puede publicar (`6`, `5`, `7`, o las salidas del recorrido nuevo) | §7.3. **Es 2 o 3 según una decisión del founder que hoy no está tomada** |
| 12 | El commit nombra un `w1-report.md` que no existe | `CD-W1-19` + **T26**. **Cinco veces** ya pasó en este proyecto |

---

## §13 · Lo que W1 NO entrega, y decirlo es parte del entregable

1. ⛔ **La bandera queda APAGADA.** Nada de esto corre en producción. El encendido es **W3**.
2. ⛔ **Nada corre en un teléfono.** Todo es `jsdom`. **W3**.
3. ⛔ **`AC-14` sobre el árbol nuevo no se mide** — con la bandera apagada el árbol nuevo **no se
   ejecuta**. **W3**.
4. ⛔ **El borrador server-side, el vale y el identificador opaco** (`AC-10`, `AC-11`, `AC-12`): **W2**.
   W1 deja **la costura** (`CD-W1-15`), no la implementación.
5. ⛔ **`L-4` sigue NO MEDIDO**: si el envío sobrevive al salto al navegador de la billetera lo
   contesta **W3**, con *Testnet Mode* como precondición. *«No se pudo medir»* ⛔ no es *«no cruza»*.
6. ⛔ **El retiro del camino viejo**: **HU propia**.
7. ⛔ **El candado de `L-5` sigue siendo más ancho que `L-5`** — prohíbe **toda** navegación blanda de
   `src`+`app`, cuando la premisa sólo necesita que **el salto a la billetera** sea de documento.
   **W1 no lo toca** y lo declara, para que nadie lea su verde como *«L-5 se midió para la app
   entera»*.
8. ⛔ **El recorrido nuevo no da historial de navegador**: el botón «atrás» del teléfono sale de la
   app. **Hoy es igual** con el árbol viejo ⇒ **no empeora nada**, pero tampoco lo mejora, y ⛔ ningún
   AC lo pide.
9. ⛔ **`src/presentation/bitacora-de-vuelta.ts:176` sigue diciendo «en ocho archivos» y son seis.**
   Menor conocido, con dueño, **candidato al fix-pack**, ⛔ no de esta ola.
10. ⛔ **`T-O2-2` sigue recorriendo una lista de dos archivos escrita a mano.** W1 cubre su propio
    árbol; arreglar esa lista es **HU aparte**.

---

## §14 · Done Definition — W1 está terminada cuando

- [ ] La rama `feat/234-w1-cinco-pantallas` existe, sale de `main@25c3f73`, y tiene los **12 archivos**
      de §4.1 y ni uno más.
- [ ] 🔴 **`T-374-W1-0` está VERDE.** Si estuvo roja en algún momento, el reporte dice **cuándo, con
      qué salida textual, y qué se hizo**.
- [ ] Los **13 `it`** de §9.1 existen, con sus nombres exactos, y el gate completo está verde.
- [ ] **Los 13 mutantes** (`MW-0` … `MW-12b`) fueron aplicados **uno por uno y por separado**, y cada
      uno tiene su `×` citado con **archivo · nombre del `it` · cuál aserción murió**. ⛔ Un
      `1 failed` sin `×` nombrado no cuenta.
- [ ] 🔴 `wc -l src/presentation/flow.tsx` ⇒ **4453**, y
      `/usr/bin/git diff --numstat main -- src/presentation/flow.tsx` sale **vacío**.
- [ ] 🔴 `/usr/bin/git status` en `wasiai-a2a` muestra **cero cambios en `src/`**.
- [ ] 🔴 Las **tres citas sueltas** a `app/page.tsx:20-21` fueron **re-derivadas** y corregidas (o se
      escribió por qué no).
- [ ] 🔴 Las citas ancladas del propio diff fueron **enumeradas con el regex del candado y contadas**
      contra las que escribiste. Ninguna quedó partida.
- [ ] Los **dos** README dicen **178**, derivado **corriendo** el candado.
- [ ] ⛔ La palabra `pasoInicial` **no aparece** en `app/page.tsx`
      (`/usr/bin/grep -c "pasoInicial" app/page.tsx` ⇒ **0**).
- [ ] ⛔ **`NEXT_PUBLIC_CHASKI_RECORRIDO_V2` no está prendida en ningún lado**, y `bandera.ts` lleva el
      gotcha del build escrito adentro.
- [ ] ⛔ Ninguna pantalla nueva toca `localStorage`, `sessionStorage`, `document.cookie` ni la URL, y
      **`T-374-W1-12` lo mide, con su control negativo**.
- [ ] ⛔ Ningún guard nuevo se lee a sí mismo, y **todo guard que afirme un `[]` tiene control negativo
      con el literal exacto**.
- [ ] El gate completo (`/usr/bin/git add -A` → `npm run qa` → `npm run build`) corrió **entero y en
      orden**, y el reporte lo transcribe. ⛔ Sin `npx` sueltos.
- [ ] 🔴 `doc/sdd/234-recorrido-de-la-dapp-de-cero/w1-report.md` **existe ANTES del commit**, y
      declara: qué se midió, qué **no** se midió (los 10 puntos de §13), el presupuesto real por
      columna contra §11, y ⛔ **ningún número prohibido** por §7.3.
- [ ] El reporte dice, **con estas palabras**, que **`AC-14` sobre el árbol nuevo es de W3**.

---

*Story File de la ola **W1** · WKH-374 · escrito por `nexus-architect` el 2026-09-01 · árbol de
referencia `chaski-v3@25c3f73` · las cinco desviaciones `D-1`…`D-5` del SDD están **aprobadas** y
transcritas acá · ⛔ cero líneas de producción escritas en esta fase.*
