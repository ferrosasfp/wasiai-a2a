# Validation Report · WKH-374 · ola W1 (las cinco pantallas) · `chaski-v3@0d3e3ce`

## VEREDICTO

> **SÍ se puede desplegar con la bandera APAGADA.** El gate corre entero y en orden **dos veces**
> (exit 0 / exit 0), el árbol nuevo **no entra al HTML que se sirve** (medido sobre el artefacto), y
> los 4 archivos fuera del directorio nuevo suman **5 líneas** y ninguna está en un camino vivo.
>
> ⛔ **NO se puede PRENDER la bandera todavía.** Tres hallazgos míos, ninguno visto por AR ni CR:
> **AC-8 no se cumple** en el caso que el propio AC nombra (*firma rechazada*), el anuncio del salto
> **promete una vuelta que el sistema no hace**, y la afirmación de que los predicados de copy van
> **«por el sentido»** es **falsa, medida**: la misma mentira escrita con otras palabras vuelve con la
> suite en `13 passed`.

Fecha: 2026-09-01 · QA F4 · árbol restaurado y verificado por `sha256sum` contra `git show HEAD:`.

---

## 1 · 🔴 MI RECORRIDO DE LAS CINCO PANTALLAS — medido por mí, no copiado

Montado con una sonda propia (`zzqasonda.test.tsx`, borrada; el árbol quedó en `git status` vacío).
Todo lo de abajo es **salida literal de una corrida**, no lectura de código.

**La respuesta a la pregunta del CR, con mi propia medición:**

> **Llega hasta el final. De los cuatro tropiezos, tres están cerrados y uno está ACOTADO, no cerrado.
> De las dos mentiras, las dos se fueron — y quedó una TERCERA que nadie miró, más un camino de
> error que deja a la persona en la pantalla equivocada.**

### 1.1 · Entrar
| Pregunta | Medido |
|---|---|
| ¿Hay estado visible entre el toque y el enlace? | **SÍ.** El botón pasa a `"Conectando con tu billetera..."` y `disabled=true` |
| ¿Se puede tocar dos veces? | **NO.** 3 toques en el mismo lote ⇒ `connectWallet` llamado **1 vez** |
| El salto | `<a href>` con el destino literal que el caso de uso contestó |

✅ `CR/BLQ-MED-4` cerrado, y cerrado en la mitad que decide (el `ref`), no sólo en la que se ve.

### 1.2 · Cuánto y para quién
| Entrada | Medido |
|---|---|
| Escribo `3` | `previewQuote` pedido **0 veces** · `role="alert"` ⇒ *«El mínimo para enviar es $5. Por debajo de eso no cotizamos el envío.»* · el pozo *«Escribí el monto»* **ya no aparece** · «Seguir» gris |
| Escribo `2` y después `25` | **una sola** cotización, y es la de `25`. ⛔ Ninguna del monto a medio escribir |
| El banner de error | aparece cuando la cotización falla y **se limpia** cuando llega la buena (`false` medido) |

✅ `CR/BLQ-MED-2` cerrado. El callejón de la única pantalla donde se escribe algo se fue.

### 1.3 · Tu identidad
| Pregunta | Medido |
|---|---|
| ¿La frase dice algo que el código cumple? | **SÍ.** `/una vez sola/i` ⇒ `false`, `/vuelven a pedir/i` ⇒ `false`. Hoy dice *«Verificamos quién sos antes de mandar la plata.»* |
| ¿Doble toque? | 3 toques ⇒ `startKyc` llamado **1 vez**, etiqueta `"Pidiendo la verificación..."` |
| ¿La frase persigue a otra pantalla? | **NO.** Toco el enlace ⇒ en vuelo `true`; «Volver» ⇒ *Cuánto y para quién*; vuelvo a *Tu identidad* ⇒ en vuelo `false` |

### 1.4 · Firmar y enviar
| Pregunta | Medido |
|---|---|
| ¿El anuncio de firmas es correcto? | **SÍ para el camino con extensión**: `1` firma, texto *«Te va a pedir 1 firma:»* (singular), y enumera exactamente esa firma. Por enlace: `4`, y las cuatro enumeradas |
| ¿Doble toque? | 3 toques ⇒ `confirmAndSend` llamado **1 vez** |

### 1.5 · Seguimiento
| Pregunta | Medido |
|---|---|
| ¿«Volver» lleva a donde dice? | Dice sólo *«Volver»* y **retrocede un paso: a «Firmar y enviar»**. Literal ⇒ correcto |
| ⚠️ Lo que encontré al seguir | En esa pantalla hay un **«Abrir mi billetera» vivo** que **vuelve a invocar `confirmAndSend`** (medido: `envios` 1 → **2**) sobre una remesa ya entregada. Ver `H-4` |

### 1.6 · 🔴 EL QUE MÁS DUELE — si el salto no ocurre

**Medido, tocando el `<a href>` con la navegación cortada (o sea: la billetera no abre):**

```
[QA] P4 tras tocar, en-vuelo = true
[QA] P4 1,2 s despues SIGUE en-vuelo (el salto no ocurrio) = true
[QA] P3 tras visibilitychange(visible), sigue en-vuelo = false
```

> **La pantalla se queda diciendo *«Estamos en tu billetera. Volvés acá mismo.»* y ⛔ NO se apaga sola.**
> No hay techo de tiempo. Se apaga con `visibilitychange`, con `pageshow` o cambiando de paso — los
> tres exigen que **algo pase**. Si el toque no produce nada y la pestaña nunca se esconde, la frase
> queda ahí.

⚠️ **Esto NO es un hallazgo nuevo: es el residual que el Dev declaró** (`recorrido.tsx:244-245`,
`w1-report.md:364-368`) y lo declaró **bien**, con estas palabras: *«Eso ⛔ no se cierra escuchando
eventos y ⛔ no se afirma cerrado»*. Lo que sí cambió respecto del CR es que **ya no persigue a las
otras pantallas** (medido arriba). ⇒ **ACOTADO Y DECLARADO, no cerrado.** Y es precisamente el modo de
falla que este ecosistema ya tiene documentado (Phantom vuelve sin nada y sin error) ⇒ **es
bloqueante para encender la bandera, no para desplegarla apagada.**

---

## 2 · Los ACs, con cita **y** ejecución

| AC | Estado | Cita | **Ejecución** (lo que corrí yo) |
|---|---|---|---|
| **AC-1** conectar es lo primero | ✅ PASS | `pasos.ts:35-41`, `pantallas.tsx:213-254` | Monté la pantalla 1: único control = `"Conectar mi billetera"`; los 3 campos ⇒ ausentes; presentes en la 2 |
| **AC-2** exactamente 5, derivadas | ✅ PASS | `pasos.ts:35-41` | `TABLA.length = 5`, ids `entrar/envio/identidad/firmar/seguimiento`. El número ⛔ no está escrito en ningún lado |
| **AC-3** salida no destructiva | ✅ PASS | `recorrido.tsx:279-280`, `pasos.ts:111-118` | Cargué los 3 campos, «Volver» ⇒ *Entrar*, adelante ⇒ `monto=25`, `nombre=Maria Quispe`, `cci=00219300445566778899`. «Volver» existe en 4 de 5 (⛔ no en `entrar`, que es la primera) |
| **AC-4** etiquetas == pantallas | ✅ PASS | `pasos.ts:55-67`, `recorrido.tsx:420` | `false` ⇒ 5 pasos / 5 etiquetas, stepper *«Paso 1 de 5»*. `true` ⇒ 4 / 4, *«Paso 1 de 4»* |
| **AC-5** anuncio antes de salir | ✅ PASS | `pantallas.tsx:140-184`, `salto.ts:348-356` | El bloque se pinta **antes** de que exista destino; el control arranca `<button>` y sólo pasa a `<a href>` cuando el caso de uso contesta. ⚠️ una de sus 4 frases es falsa ⇒ `H-3` |
| **AC-6** estado en vuelo con texto | 🟡 **PASS con residual declarado** | `pantallas.tsx:193-199`, `recorrido.tsx:236-258` | Aparece **sólo tras el toque** (antes: ausente, medido). Es texto, ⛔ no un indicador mudo. **Residual medido: no se apaga solo** (§1.6) |
| **AC-7** vuelve al paso siguiente, ⛔ NUNCA la entrada | ✅ PASS | `salto.ts:77-112`, `:270-282` | Monté el anfitrión con **las 6 marcas del universo** + la del verificador + una desconocida: `envio · seguimiento · seguimiento · firmar · seguimiento · seguimiento · identidad · envio`. **Ninguna = «Entrar»** |
| **AC-8** vuelta mala ⇒ **mismo paso** + motivo, ⛔ nunca la entrada | 🔴 **FAIL PARCIAL** | `salto.ts:155-183`, `:270-282` | **La mitad del NUNCA: PASS** (ninguna aterriza en la entrada, con códigos reales). **La mitad del «mismo paso»: FAIL** ⇒ ver `H-1` |
| **AC-13** bandera apagada ⇒ byte-idéntico | ✅ PASS | `bandera.ts:52-54`, `app/page.tsx:41` | Gate verde; **mutante M7** (invertir la bandera) ⇒ `T-374-W1-10` y `-11` **ROJO**. Bandera **ausente** de `.env.local` y `.env.example`. Build: `/` es `○` (estática) ⇒ el gotcha es cierto. `grep .next/server` ⇒ `page.js`; `grep .next/static` ⇒ **nada** (las dos rutas del docblock reproducen) |
| **AC-15** cero líneas en `wasiai-a2a/src/` | ✅ PASS | — | `git log -- src/` desde el inicio de la HU ⇒ **vacío**. `flow.tsx`: `--numstat` vs `25c3f73` ⇒ **vacío**, `wc -l` ⇒ **4453** |
| **AC-16** sólo billeteras no custodiales | ✅ PASS | `pantallas.tsx:33` | Monté las 5: la frase está en 4 (la de identidad ⛔ no habla de fondos). `/custodi\|embebid/i` sobre el resto del texto ⇒ **false** en las 5 |
| AC-9 / 9b / 10 / 11 / 12 / 14 / 17 | ⚪ **NO APLICA A W1** | `story-W1.md:925-927` | Declarados W2/W3 en `w1-report.md:323-345`. **Verifiqué que ni el código ni los documentos afirmen lo contrario** ⇒ no lo afirman |

---

## 3 · Hallazgos

### 🔴 `H-1` · `AC-8` no se cumple para *firma rechazada*, que es el caso que el AC nombra

`salto.ts:77-86` · `:155-183`. La tabla de aterrizaje es **una sola** y sirve a los dos caminos: la
rama feliz y la de error **devuelven el mismo paso**. Ese paso es, por `AC-7`, **el siguiente**.

**Reproducción (montando el anfitrión con códigos de rechazo REALES de Phantom):**

```
?dl=firmar-tx&errorCode=User%20rejected%20the%20request.  -> pantalla: Seguimiento
?dl=firmar-tx&errorCode=4001                              -> pantalla: Seguimiento
   motivo: "No pudimos terminar ese paso / Algo salió mal. Intentá de nuevo. /
            Todavía no hay ningún envío en curso."
```

**Qué dice el AC, literal:** *«IF la vuelta … (marca ausente, marca sin consumidor, **firma
rechazada**) THEN aterrizar en **el mismo paso donde estaba** con un motivo legible»*. El paso donde
estaba era **Firmar y enviar**. Aterriza en **Seguimiento** — un paso **más adelante**, en una pantalla
que le dice *«Todavía no hay ningún envío en curso»* y desde la que **no puede reintentar la firma**.

⚠️ **Y es satisfacible**: la marca `firmar-tx` dice sin ambigüedad de qué paso salió. De hecho el
diseño lo cumple **por accidente** para `crear-nonce` (medido: rechazo ⇒ *Firmar y enviar*) y lo
incumple para las otras cinco.

⚠️ **El docblock de `salto.ts:158-160` presenta esto como el cumplimiento**: *«LAS DOS RAMAS … devuelven
el MISMO paso, y ésa es la mitad de `AC-8` que importa»*. Eso es una **re-lectura del AC**, no su
cumplimiento: el AC pide dos cosas y la prosa se queda con una. Ni AR ni CR lo miraron.

### 🔴 `H-2` · «Los predicados van por el SENTIDO y no por la frase exacta» es **FALSO**, medido

`recorrido.test.tsx:110` y `w1-report.md:557` afirman, con estas palabras: *«⛔ Los predicados son por
el SENTIDO y no por la frase exacta: prohibir el literal viejo dejaría pasar la misma promesa escrita
con otras palabras, que es como vuelven estas cosas.»*

**Corrí la calibración y después la falsifiqué. Cuatro mutantes, de a uno, restaurando con
`git checkout HEAD --` y confirmando `git status --porcelain` vacío:**

| Mutante | Copy inyectado en `pantallas.tsx` | Resultado |
|---|---|---|
| `M1` | *«Se guarda solo mientras lo completás.»* (**literal viejo**) | **ROJO** — `T-374-W1-8` y `T-374-W1-18` ✅ |
| `M2a` | *«Una vez sola. Después de esto, tus próximos envíos no la vuelven a pedir.»* (**literal viejo**) | **ROJO** — 2 failed / 11 passed ✅ |
| **`M1b`** | *«Lo que vas escribiendo queda en este navegador mientras completás.»* | 🔴 **`13 passed` — SOBREVIVE** |
| **`M2b`** | *«Es una sola vez: en tus próximos envíos ya no hace falta repetirla.»* | 🔴 **`13 passed` — SOBREVIVE** |

Las dos mentiras, **con su significado intacto y otras palabras**, vuelven a la pantalla con el gate
en verde. Los predicados no son «por el sentido»: son una disyunción de **tres redacciones cercanas**
(`/se guarda\s+sol[oa]|guardado autom|se va guardando/i` y
`/una vez sola|no (?:te )?la vuelven a pedir|no (?:te )?la volvemos a pedir/i`).

🔴 **Y `T-374-W1-24` no puede detectarlo por construcción**: le pasa **los literales que estaban
renderizados en `5afe979`** — o sea confirma exactamente la forma que ya funcionaba. **Es el mismo
defecto que el CR cerró en los cebos del barrido** (*«el control negativo confirmaba la única forma que
ya funcionaba»*), reaparecido un escalón más arriba, en los predicados de copy.

⇒ Lo que hay que corregir es **la afirmación** (barata) o **el predicado** (caro). Lo que ⛔ no se puede
dejar es una frase que apaga la próxima revisión: quien la lea va a creer que el copy está cubierto.

### 🟠 `H-3` · Una TERCERA frase que le dice a la persona algo que el sistema no hace

`salto.ts:353` — `volves: "Cuando termines, volvés a esta misma pantalla y seguimos donde estabas."`
Se renderiza en **la pantalla de entrada y en la de firmar**, y es lo último que la persona lee antes
de salir a la billetera.

**Medido, marca por marca:**

```
la pantalla que LEE el anuncio = Firmar y enviar
a donde VUELVE tras firmar-tx  = Seguimiento          <- NO es "esta misma pantalla"
conectar          -> envio      (el anuncio lo lee en "Entrar")  <- NO
firmar-tx         -> seguimiento                                  <- NO
firmar-patrocinio -> seguimiento                                  <- NO
pop-payout        -> seguimiento                                  <- NO
pop-kyc           -> seguimiento                                  <- NO
crear-nonce       -> firmar                                       <- sí (1 de 6)
```

Es **la misma clase** que las dos mentiras que este fix-pack cerró: una frase que la persona lee y que
el código no cumple. Y ⛔ **no la caza nada**: `revisarCopy` no tiene predicado para esto. Además
**contradice a `AC-7`**, que pide explícitamente el paso **siguiente**: la frase y el AC no pueden ser
ciertos a la vez.

### 🟡 `H-4` · Desde el recibo se vuelve al camino del dinero y el control está VIVO

`recorrido.tsx:477` + `pasos.ts:111-118`. «Volver» en *Seguimiento* ⇒ *Firmar y enviar*, con un
**«Abrir mi billetera» habilitado** que vuelve a llamar `confirmAndSend`. **Medido: `envios` 1 → 2.**

⚠️ **Sin riesgo de doble gasto, y lo verifiqué del lado del dominio**: `confirm-and-send.ts:330` hace
`if (r.status !== "confirmed") r.confirm(...)`, y `remittance.ts:176` declara `settled: []` ⇒ tira
`invalid_transition:settled->confirmed`. ⇒ el efecto real es un **callejón con un motivo genérico
(«Algo salió mal. Intentá de nuevo.») sobre el recibo de un envío que salió bien**.

El CR lo marcó (`MNR-5`) y la respuesta fue prosa (`pantallas.tsx:519-521`: *«lo que el botón deshace
es la pantalla, no el envío»*). Eso es cierto **para el dinero** y falso para lo que la pantalla
anterior ofrece. Menor, pero es copy que miente por omisión en el camino del dinero.

### 🔵 `H-5` (INFO) · Una cita anclada está partida en dos líneas

`salto.ts:194-195` — la cita de `PARAM_ERROR` cruza el salto de línea. Un lector estricto de línea la
cuenta como suelta. **Resuelve bien** (verifiqué: `protocol.ts:44` **contiene** `PARAM_ERROR`). El
reporte dice *«0 partidas»*; medido, es **1**.

---

## 4 · Lo que verifiqué y **está bien** (ejecutando, no leyendo)

### 4.1 · El barrido de navegación — **las dos mitades**

**Mitad A** — inyecté en `pantallas.tsx` las **cinco formas de salida** que el CR midió escapándose,
**más** el alias **partido en dos líneas** que el AR usó:

```
pantallas.tsx:99  → salida de la app por location     (location.href = u)
pantallas.tsx:100 → salida de la app por location     (location.assign(u))
pantallas.tsx:101 → salida de la app por location     (document.location.href = u)
pantallas.tsx:102 → salida de la app por location     (window.location = u)
pantallas.tsx:103 → salida de la app por location     (location.replace(u))
pantallas.tsx:104 → alias de un almacén               (el partido en dos líneas)
Tests  1 failed | 2 passed (3)
```

**Las seis cazadas, con el número de línea correcto.** `CR/BLQ-ALTO-1` cerrado.

**Mitad B** — reemplacé la quinta fila por **el patrón más ancho posible** (`/location/`):

```
→ el barrido caza una LECTURA de la barra: "const h = window.location.href;"
  — el anfitrión no podría leer el href del montaje: expected true to be false
Tests  1 failed | 2 passed (3)
```

**Los cuatro controles de lectura son reales y ponen rojo al patrón trucho.** Sin ellos, un patrón que
cace la palabra `location` pasaba los seis cebos **y rompía el anfitrión**. Las dos mitades hacen falta
y las dos funcionan. ✅

### 4.2 · El presupuesto — **reproduce exacto, celda por celda**

Implementé el clasificador publicado en `w1-report.md:196-198` y lo corrí yo:

| | Código | Prosa | % |
|---|---:|---:|---:|
| `pasos.ts` | 47 | 60 | 56,1 % |
| `bandera.ts` | 3 | 50 | 94,3 % |
| `salto.ts` | 132 | 211 | 61,5 % |
| `pantallas.tsx` | 372 | 174 | 31,9 % |
| `recorrido.tsx` | 298 | 164 | 35,5 % |
| **TOTAL** | **852** | **659** | **43,6 %** |
| Tests, no en blanco | | | **1.956** |

**Las siete filas del Dev, idénticas.** Un presupuesto publicado que reproduce en manos de un tercero
es lo contrario de un exceso silencioso.

**🔴 MI JUICIO SOBRE LA DECISIÓN DE NO RECORTAR (lo que se me pidió juzgar): ACEPTABLE, pero el
argumento bueno NO es el que el Dev escribió.**

- El motivo publicado —*«este fix-pack ⛔ no los tocó»*— es **malo como principio**: aplicado siempre,
  el presupuesto sólo puede crecer y ningún archivo se recorta nunca.
- El motivo que **sí** la sostiene es el **contenido**, y lo verifiqué: de las 261 líneas, las 50 de
  `bandera.ts` contienen una **retractación de su propia evidencia** —el motivo falso de las
  `NEXT_PUBLIC_`— y el motivo verdadero (`/` es `○`). **Re-medí las dos rutas de `grep` sobre mi
  propio artefacto de build y las dos dan lo que el docblock dice.** Borrar eso para ganar una columna
  sería tirar lo único que hace auditable el encendido.
- 1,65x **< 2x** ⇒ `§11.10` admite justificación escrita, y la de `6.2` es específica y falsable, ⛔ no
  una frase de cobertura.
- ⚠️ **Lo que sí es recortable y no se recortó**: el argumento *«el salto remonta el árbol»* está
  escrito **cuatro veces** (encabezados de `salto.ts`, `recorrido.tsx`, `pantallas.tsx` y el docblock
  de `pasos.ts`). Eso es repetición, no evidencia. **Deuda técnica declarable, no bloqueante.**

### 4.3 · Otros candados que verifiqué ejecutando

| Candado | Mutante | Resultado |
|---|---|---|
| `AC-13` (bandera) | `M7`: invertir el predicado de `recorridoV2Enabled` | `T-374-W1-10` y `-11` **ROJO** ✅ |
| Copy (literales viejos) | `M1`, `M2a` | **ROJO** ✅ |
| Barrido de navegación | `M4` (6 formas) | **ROJO**, 6 hallazgos con línea ✅ |
| Barrido, otra mitad | `M5` (patrón más ancho) | **ROJO** por los controles de lectura ✅ |
| **El gate me contiene** | `M6`: un `import` sin usar en `recorrido.tsx` | `npm run qa` **exit 1**, y **falla en `lint`, que es el PRIMER eslabón** (`Found 1 error` sobre un árbol que limpio da 0) ✅ |

---

## 5 · Drift

| Chequeo | Resultado |
|---|---|
| **Scope** | 16 archivos. Los 12 del Scope IN + 4 declarados en `6.3`. Medido `--numstat`: `protocol.ts` `2 2`, `bienvenida.tsx` `1 1`, `grecas.tsx` `1 1`, `bienvenida-composicion.test.tsx` `1 1`. **Coincide con lo declarado** ✅ |
| **Scope OUT** | ⛔ Ninguno tocado. `flow.tsx` Δ0 (`--numstat` vacío, `wc -l` = 4453) · `el-salto-remonta-el-arbol.test.tsx`, `ola-2-pantallas.test.tsx`, `splash-puerta.ts`, `bitacora-de-vuelta.ts` sin cambios · **ninguna ruta nueva bajo `app/`** (sólo `app/page.tsx`, que es P6) ✅ |
| **Waves** | `W1.0` (`65bed53`) → `W1.1+W1.2` (`7066871`) → `W1.3` (`c104c4b`) → fix-pack AR → fix-pack CR. Orden respetado ✅ |
| **Citas ancladas** | **21** con saltos normalizados, **0 rotas** (verifiqué cada una con el símbolo en la línea citada). El «21» del Dev **reproduce**. ⚠️ **1 partida** (`H-5`), no 0 |
| **Citas sueltas** | `flow.tsx:286` — **verificada a mano**: esa línea SÍ trae el razonamiento de `HU-075/gesto` con `t=12830 ms`. ⚠️ *(Mi primera lectura la dio por rota; era mi propio `cut -c1-200` truncando una línea de ~4 KB. Lo digo porque es exactamente la clase de falso hallazgo que este repo tiene documentada.)* |
| **README** | `178 test files` / `178 archivos de test` ⇒ mi gate midió **178 test files**. Coincide ✅ |
| **Spec drift** | Spot-check de `siguiente`, `aterrizajeDelAnfitrion` y `firmasDelCamino` contra el SDD: coinciden. ⚠️ `AC-8` es drift de **especificación**, no de código (`H-1`) |

---

## 6 · Gate — corrido por mí, entero y en orden, **dos veces**

`.github/workflows/ci.yml` de `chaski-v3` ⇒ `npm run qa` = `lint && typecheck && typecheck:scripts && test`.

| Corrida | Comando | Exit | Salida |
|---|---|---:|---|
| 1 | `git add -A` → `npm run qa` | **0** | `Test Files 178 passed (178)` · `Tests 3520 passed (3520)` |
| 1 | `npm run build` | **0** | `✓ Compiled successfully in 6.0s` · `┌ ○ /` |
| 2 | `git add -A` → `npm run qa` | **0** | `Test Files 178 passed (178)` · `Tests 3520 passed (3520)` |
| 2 | `npm run build` | **0** | `✓ Compiled successfully in 6.0s` · `┌ ○ /` |

- **El exit code se leyó, no se supuso**: control positivo `M6` ⇒ el mismo comando da **exit 1** y falla
  en `lint`. ⇒ el gate **contiene** los archivos de esta HU y **lint es el primer eslabón**.
- ⚠️ **El flake de `vuelta-por-enlace-carrera.test.tsx` NO apareció** en ninguna de las dos corridas
  completas. Coincide con lo que dice el reporte.
- ⚠️ `biome` reporta **140 warnings + 1 info** preexistentes en el repo (exit 0). ⛔ Ninguno del árbol
  nuevo. No es de esta ola; queda dicho.
- **Árbol dejado como lo encontré**: `git status --porcelain` vacío, y `sha256sum` de los tres archivos
  mutados idéntico a `git show HEAD:`. `HEAD` = `0d3e3ce`, sin pushear.

---

## 7 · Lo que NADIE verificó — sin suavizar

1. ⛔ **Nada corrió en un teléfono.** Todo lo mío es `jsdom`, igual que el Dev, el AR y el CR.
   **Verifiqué que ni el código ni los documentos afirmen lo contrario** ⇒ `recorrido.test.tsx:5-7`,
   `bandera.ts:49-50` y `w1-report.md:326` lo dicen con todas las letras. ✅ Nadie sobreafirma.
2. ⛔ **La bandera está APAGADA** ⇒ el árbol nuevo **no se ejecuta en producción**. Medido, no
   supuesto: ausente de `.env.local` y `.env.example`; `/` sale `○` (prerenderizada estática) en el
   build; el HTML servido (`.next/server/app/index.html`, 8.160 bytes) **no contiene ninguno de los
   cinco títulos nuevos**.
3. ⛔ **El total del recorrido y las firmas del camino por enlace siguen SIN MEDIR.** `firmasDelCamino`
   arma la lista **a mano** y ⛔ no la deriva de producción — el propio `salto.ts:300-302` lo declara.
   ⇒ **el «4» del anuncio por enlace y el «1» del camino con extensión no los verifica nada**, y yo
   tampoco los pude verificar contra producción. **NO VERIFICABLE.** Ningún documento afirma lo
   contrario ✅.
4. ⛔ **`AC-6` no cierra el caso del salto que no produce nada** (§1.6). Declarado, no cerrado.
5. ⛔ **El tamaño de los blancos táctiles del árbol nuevo no lo mide nadie** (`touch-targets.test.tsx`
   monta el árbol viejo a mano). Declarado en `w1-report.md:358-363`.
6. ⛔ **`AC-14` sobre el árbol nuevo** no se mide y es de W3, con esas palabras.

### Smoke manual, para cuando se prenda la bandera (⛔ no lo corrí yo)

1. `NEXT_PUBLIC_CHASKI_RECORRIDO_V2=true` **y REBUILD** (redesplegar el mismo artefacto no cambia nada:
   `/` es estática).
2. Teléfono real, Phantom, **Testnet Mode ENCENDIDO** (precondición conocida del ecosistema).
3. Entrar → tocar «Abrir mi billetera» → **contar las firmas que Phantom pide de verdad** y compararlas
   con el «4» del anuncio.
4. **Rechazar** la firma de la transacción y anotar en qué pantalla vuelve (esperado por `AC-8`:
   *Firmar y enviar*; medido hoy: **Seguimiento** ⇒ `H-1`).
5. Tocar el enlace **con Phantom desinstalado** y confirmar si la pantalla queda para siempre en
   *«Estamos en tu billetera»* (§1.6).

---

## 8 · Qué hay que arreglar, en orden

| # | Hallazgo | Bloquea desplegar apagada | Bloquea PRENDER |
|---|---|---|---|
| 1 | `H-1` · `AC-8` manda al paso siguiente en el camino de error | ⛔ no | 🔴 **SÍ** |
| 2 | `H-3` · el anuncio promete una vuelta que no ocurre | ⛔ no | 🔴 **SÍ** |
| 3 | `H-2` · la afirmación «por el SENTIDO» es falsa | ⛔ no | 🟠 corregir la **frase** ya |
| 4 | `AC-6` residual · la frase que no se apaga sola | ⛔ no | 🔴 **SÍ** |
| 5 | `H-4` · el recibo devuelve a un control de dinero vivo | ⛔ no | 🟡 menor |
| 6 | `H-5` · una cita anclada partida | ⛔ no | ⛔ no |

---

*QA · F4 · WKH-374 ola W1 · 2026-09-01 · `chaski-v3@0d3e3ce` · árbol restaurado y verificado*
