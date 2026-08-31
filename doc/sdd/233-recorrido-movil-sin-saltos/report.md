# Report — HU 233 · [WKH-372] El recorrido móvil sin saltos · **OLA W1**

> **Estado: DONE (ola W1) — mergeada a `main` local de `chaski-v3` en `f295a6f`, PENDIENTE DE PUSH
> (14 commits). La HU 233 sigue ABIERTA:** W0, W3 y W4 no empezaron, y la `071` de `chaski-v3`
> tampoco. **W1 no cierra la HU.**
>
> **Fecha de cierre:** 2026-08-31 · **Modo:** QUALITY · **Repo del trabajo:** `chaski-v3`
> **Repo ancla de los artefactos:** `wasiai-a2a` (`doc/sdd/233-recorrido-movil-sin-saltos/`),
> **cero líneas de `src/`** tocadas acá.
>
> Este reporte se compiló **leyendo los artefactos**, no de memoria. Cada número tiene su fuente
> nombrada, y lo que nadie midió se dice con esas palabras.

---

## 1 · Resumen ejecutivo

W1 le construye a Chaski **una puerta**: en el navegador común de un celular, la app ahora **ofrece**
abrirse dentro del navegador interno de Phantom, donde el proveedor de billetera está inyectado y el
envío se completa sin salir de la app. La ola entrega la puerta, la honestidad sobre lo que se pierde
al cruzarla, y **el instrumento que lo demuestra corriendo**. El recorrido de adentro ya funcionaba:
lo que faltaba era la entrada y la prueba.

- **Producción de toda la ola: 279 líneas añadidas.** Las 1988 del diff son, en su gran mayoría,
  tests que matan mutantes.
- **Gate completo del repo, corrido por F4 contra el índice, en orden**: `npm run qa` **exit 0**
  (biome 301 archivos · `tsc --noEmit` · `typecheck:scripts` · **167 archivos / 3427 tests**) y
  `npm run build` **exit 0**. Con **control positivo** de que el gate contiene a esta HU.
- **Cuatro fix-packs.** AR RECHAZADO, re-AR RECHAZADO, CR RECHAZADO, verificación de cierre
  RECHAZADA, y F4 APROBADO con un fix-pack más encima.
- ⛔ **Nadie corrió esto en un teléfono.**

**Archivos clave del entregable** (todos en `/home/ferdev/.openclaw/workspace/chaski-v3`):
`src/presentation/salida-al-navegador-de-la-billetera.ts` (el módulo puro nuevo),
`src/presentation/flow.tsx` (5 inserciones, **Δ0 en líneas**),
`src/presentation/bitacora-de-vuelta.ts` (el 5º hito, con sus **cuatro** desenlaces).

---

## 2 · Qué cambió para la persona que usa la app

Sin jerga, y sólo lo que la persona ve:

1. **En la bienvenida, desde un celular, aparece una pregunta y dos enlaces.** La pregunta es
   *"¿Estás en un celular con Phantom?"* — es una pregunta y no una afirmación **porque la app no
   puede saber qué hay instalado en el teléfono**. Los dos enlaces son *"Abrir Chaski en Phantom"* y
   *"Instalarla y crear mi billetera"*.
2. **Nada se abre solo.** Los dos son enlaces que **la persona toca**. La app nunca navega sola al
   montarse: eso está medido comparando la barra de direcciones antes y después de que la pantalla
   se dibuje.
3. **Si toca el primero y entra por ahí, el envío se completa sin salir de la app.** Dentro del
   navegador de la billetera la firma ocurre en la misma pantalla: **cero viajes a la app de
   Phantom** y **cero veces que la pantalla se recarga y vuelve a empezar**.
4. **Si no tiene billetera, hay una salida, no un callejón.** El segundo enlace lleva a instalarla y
   crear una propia (nunca a una billetera custodial), y termina en el **mismo** recorrido.
5. **Si al cruzar se pierden los datos que había cargado, la app se lo dice.** Al llegar aparece
   *"Acá no están los datos que cargaste antes"*. Y si **no puede leer el almacenamiento**, no
   inventa: no afirma ni que están ni que no están.
6. **No se le prometió nada que no se haya medido.** El copy no dice que algo falló, no dice
   "empezá de nuevo", y no afirma que el navegador de Phantom conserve o pierda los datos: eso
   todavía **no se sabe**, y por eso el aviso está: para **medirlo en el campo**.
7. **Lo que ya existía sigue existiendo.** Quien prefiera el camino por enlace profundo lo tiene
   intacto: no se borró una línea de ese código.

---

## 3 · Pipeline ejecutado — el recorrido real, con sus cuatro fix-packs

| Fase | Qué pasó |
|---|---|
| **F0/F1** | `work-item.md` (revisión 2: la ola W2 se retiró **porque era otra HU ya escrita**, la `071` de `chaski-v3`, invisible a `grep` por estar su `doc/` gitignoreado). |
| ⛔ **Gate** | **`HU_APPROVED`** — humano, textual. |
| **F2** | `sdd-w1.md`. El hallazgo que definió la escala: *dentro del navegador de la billetera el recorrido **ya cumple casi todo**, sin escribir producción*. |
| ⛔ **Gate** | **`SPEC_APPROVED`** — revisión clínica del orquestador. |
| **F2.5** | `story-W1.md`. Acá se decidió partir `AC-1-2` en `AC-1-2a` (recurrente, listón estricto) y `AC-1-2b` (primera vez, que **declara** la recarga heredada del verificador de identidad en vez de fingir que no existe). |
| **F3** | 5 waves, en orden: `W1.0` (la premisa falsable, **0 líneas de producción**, entró primera) → `W1.1` (módulo puro) → `W1.2` (las inserciones Δ0) → `W1.3` (el hito y su renglón, entra entero o no entra) → `W1.4` (cierre y re-derivación de citas). Merge `550bf33`. |
| **AR** | **RECHAZADO** — 1 `BLQ-BAJO` + 4 `MNR`. 9 mutantes aplicados y restaurados. |
| **fix-pack 1** | `582f4b5` → merge `e9d6892`. |
| **re-AR (it 2)** | **RECHAZADO** — los 5 hallazgos de la it 1 cerraron, y aparecieron **2 nuevos**, encontrados con mutantes propios del revisor. |
| **fix-pack 2** | `4f920e1` → merge `2ad4698`. |
| **CR** | **RECHAZADO** — 1 `BLQ-MEDIO`, 3 `BLQ-BAJO`, 4 `MNR`. Lente distinto: calidad, reuso, y **que el código diga la verdad**. |
| **fix-pack 3** | `b0692c0` → merge `b402ab7`. El más grande: 451 añadidas / 32 borradas en 5 archivos. |
| **CR / verificación de cierre** | **RECHAZADO** — 1 bloqueante, y **era una cita del orquestador**, no del Dev (`story-W1.md:517` apuntaba a un comentario, no al `it`). *El orquestador corrigió 7 citas.* |
| **F4 (QA)** | ✅ **APROBADO PARA DONE** — **8 ACs PASS / 0 FAIL / 1 NO VERIFICABLE**. Gate completo corrido, 2 mutantes propios, 3 hallazgos MENORES de drift. |
| **fix-pack 4** | `974fbaa` → merge `f295a6f`. 2 frases falsas **dentro de comentarios del código shippeado**, MENOR. |
| **DONE** | Este reporte + la fila 233 del `_INDEX.md`. |

### 3.1 · El dato que vale del pipeline

**F4 encontró tres cosas que ni el AR ni el CR vieron**, y **ninguna** es de comportamiento:

- `QA-MNR-1`: los documentos —y **un `describe` dentro del código**— seguían diciendo *"TRES
  desenlaces"* cuando el fix-pack 3 ya había hecho **cuatro**.
- `QA-MNR-2`: `story-W1.md:500` conservaba la 4ª condición escrita con la **expresión vieja**
  (`!aterrizaje.hayBorrador`), justo la que el fix-pack 3 reemplazó por la que **exige haber
  preguntado**.
- `QA-MNR-3`: el docblock del **contador de la métrica principal de la ola** decía lo contrario de
  lo que hace su código (*"un href impareseable se conserva"* sobre un `catch` que lo descarta).

Y después, **el fix-pack 4 encontró un sitio más que el propio F4 no había visto**, y estaba en
**producción**: `salida-al-navegador-de-la-billetera.ts:166` enumeraba los desenlaces **en prosa, sin
usar ninguna de las cuatro etiquetas**, así que el `grep` natural (buscar la etiqueta nueva) no lo
encontraba. Lo encontró buscar **el numeral que dejó de valer**.

⇒ Cuatro revisiones sucesivas, cada una con un lente distinto, y cada una encontró lo que la
anterior no podía ver desde su lente. **Ninguna de las 8 fue redundante.**

---

## 4 · Acceptance Criteria — resultado final

Fuente: `validation.md` §3, cada AC con **cita y ejecución**.

| AC | Status | Evidencia |
|---|---|---|
| **AC-1-1** · ofrecer el salto **dentro de un gesto**, nunca desde un efecto | ✅ **PASS** | `flow.tsx:757`. `T-372-W1-1` (`wallet-availability.test.tsx:1258`) ✓: mide 7 propiedades, entre ellas que **`window.location.href` es idéntico antes y después del montaje** (nada navegó solo) y que el hostname **se deriva** de `phantomBrowseUrl(…)` en vez de escribirse. Control negativo `T-372-W1-2(control)` ✓ |
| **AC-1-2a** · recurrente: 0 remontajes, 1 travesía, 0 saltos | ✅ **PASS** (listón estricto, sin aflojar) | `T-372-W1-13`(a) ✓: `1 + espiaA.asignado.length === 1` y `viajesALaBilletera(…) === []`, asertado **después** de comprobar que el recorrido llegó a `Confirmar y enviar` (mata el falso verde por vacío) |
| **AC-1-2b** · primera vez: declara la recarga heredada y mide 0 viajes a la billetera | ✅ **PASS** | `T-372-W1-13`(b) ✓: las asignaciones son **2**, y el hostname de la única navegación es `verificacion.example` ⇒ la travesía extra es **del verificador de identidad**, de ninguna manera de una billetera |
| **AC-1-3** · ninguna cuenta de nonce + umbral inyectado, **sin cambiar ningún valor** | ✅ **PASS** | `T-372-W1-4` + `T-372-W1-5` ✓ (los dos bordes del umbral, con las constantes **importadas**). Y el valor: `git diff --numstat cc02b61 b402ab7 -- src/application/solana-escrow-rent.ts` ⇒ **0 archivos** |
| **AC-1-4** · ofrecer instalar y crear la billetera, sin callejón, sin custodia | ✅ **PASS** | `T-372-W1-6` ✓ y `T-372-W1-6b` ✓ (las **dos** pantallas). El `href` **es** `URL_INSTALAR_PHANTOM` importada; `not.toMatch(/custodi/i)`; y la URL contesta **200** hoy (`curl`) |
| **AC-1-4b** · conservar el estado **o decirlo**; ⛔ nunca el tercer desenlace mudo | ✅ **PASS** (sobre lo que W1 controla) | 6 `it` verdes: `T-372-W1-7`, `-7b`, `-7c`, `-7d`, `-7e`, `-7f`. El AC cierra porque **el código no afirma que el almacenamiento cruce: lo pregunta**. Ver §6 |
| **AC-1-5** · el camino por enlace queda funcional y el nonce sin borrar | ✅ **PASS** | `T-372-W1-11` ✓, que **lee el árbol** y no el diff. Corroborado: `git diff --diff-filter=D` ⇒ **vacío**, ningún archivo borrado |
| **AC-1-6** · `prepare()` = 1 por envío, 0 órdenes huérfanas | ✅ **PASS** | `T-372-W1-12` ✓: `prepare.calls.length === 1` sobre un envío que **cerró** en `payout_submitted`. ⚠️ Las huérfanas son **derivación** (`huérfanas = calls − 1`), no medición aparte, y el propio `it` lo escribe |
| **AC-0-4 / MI-1** · el conteo de firmas del camino inyectado | 🟡 **NO VERIFICABLE** | Ver §5 |

**8 PASS · 0 FAIL · 1 NO VERIFICABLE.**

---

## 5 · 🟡 `AC-0-4` quedó NO VERIFICABLE — y por qué, sin inventar el número

**No se pudo derivar ejecutando, y este reporte no repite ninguno de los dos números que se
contradicen** en los informes de terreno. La contradicción está declarada desde el F1
(`work-item.md:200`): el informe **tabula un conjunto de firmas con sus citas y totaliza otro
número**, y `work-item.md:212` deja escrito que **las dos lecturas de `confirm-and-send.ts:463` son
compatibles con el código** (el comentario de esa línea habla del **mecanismo**, no de si el gateway
HTTP pide la firma igual).

Las tres razones por las que W1 no lo cierra:

1. **La suite de W1.0 no cuenta firmas.** Cuenta viajes a la billetera (0), invocaciones de
   `prepare()` (1), instrucciones de nonce (0) y el umbral (por valor). **Ninguno de esos es un
   contador de firmas.**
2. Lo más cerca que llega un instrumento corrido es `T-372-W1-3`, que mide que el puerto de PoP por
   enlace contesta `["no-corresponde"]` y que no se pide ningún desafío por red. ⚠️ **Eso no lo
   resuelve**: `"no-corresponde"` significa *"el mecanismo por enlace no aplica"*, no *"no se pide la
   firma"*.
3. **`AC-0-4` es un AC de W0, que no es esta ola.** W1 no lo gatea y no lo cierra.

⇒ **Escalado a W0**, que exige el teléfono del founder con **Testnet Mode** activo. ⛔ No se marca
PASS y no se inventa el número.

---

## 6 · 🔴 LO QUE NADIE VERIFICÓ — dicho sin suavizar

Estas tres cosas **siguen abiertas al cerrar W1**. Lo que sí se verificó es que **el código y el copy
NO LAS AFIRMAN**.

### 6.1 · **Nadie corrió esto en un teléfono.**
Los 21 `it` de la ola corren en **jsdom** con la librería real. Prueban **el árbol, no el
dispositivo**. Cero evidencia de ejecución en hardware. Y hay una vuelta de tuerca medida: bajo jsdom
existen caminos de Solana **estructuralmente inalcanzables** (`Buffer.from(x) instanceof Uint8Array`
es `false`), o sea que **el entorno de medición no es el runtime real**, y el arnés lo declara y lo
repara con una sonda escrita al lado.

### 6.2 · **Si el `localStorage` cruza al navegador de la billetera SIGUE SIN CONTESTARSE.**
El diseño **no lo supone**: marca al salir (`?wb=1`, opt-in estricto) y **pregunta** al aterrizar. Hoy
hay **cuatro** desenlaces observables: `con-marca-y-borrador` · `con-marca-sin-borrador` ·
`con-marca-disco-ilegible` · `sin-marca`. El copy visible **no explica la causa**: dice *"Acá no
están los datos que cargaste antes"* —lo único medido en ese instante— y **no** dice *"se perdió"* ni
*"el navegador de Phantom guarda todo aparte"*, que serían afirmaciones causales que nadie midió.
**El aviso es el instrumento de campo, y todavía no se leyó en un teléfono.**

### 6.3 · **Que el enlace `browse` abra Phantom, y qué hace si no está instalada, TAMPOCO SE MIDIÓ.**
La documentación de Phantom no lo dice y este repo no lo midió: está declarado como incógnita en
`salida-al-navegador-de-la-billetera.ts:35-38` **en vez de resolverse de palabra**. Por eso hay un
**segundo enlace explícito** de instalación, con guard propio en las **dos** pantallas: el diseño
**no se apoya en esa incógnita**.

⇒ **La única forma de cerrar las tres es el smoke manual de `validation.md` §9**, que necesita el
teléfono del founder con Phantom y **Testnet Mode** activo. Va al humano.

---

## 7 · La métrica de éxito, **derivada ejecutando** por F4

⛔ **CD-12.** Este reporte **no dice** que el remitente deje de necesitar SOL, y no puede decirlo:
**W1 elimina la cuenta de nonce y nada más.** El resto del SOL lo baja la HU `071` de `chaski-v3`
(`doc/sdd/071-facilitator-adelanta-el-alquiler/`), que es otra HU, de otro repo, con su propio
expediente.

| Métrica | Camino por enlace (**ANTES**) | Navegador de la billetera (**DESPUÉS**) | Cómo se derivó |
|---|---|---|---|
| **Saltos / viajes a la billetera** (recurrente) | 6 `[HEREDADO]` | **0** ✅ **MEDIDO** | `T-372-W1-13`(a) + `T-372-W1-3`: `viajesALaBilletera(…) === []`, host derivado de `phantomBrowseUrl` |
| **Saltos / viajes a la billetera** (primera vez) | 6 `[HEREDADO]` | **0** ✅ **MEDIDO** | `T-372-W1-13`(b): la única asignación tiene hostname `verificacion.example` |
| **Travesías de la pantalla de entrada** (recurrente) | 7 `[HEREDADO]` | **1** ✅ **MEDIDO** | `T-372-W1-13`(a): `1 + asignaciones === 1` |
| **Travesías de la pantalla de entrada** (primera vez) | 7 `[HEREDADO]` | **2** ✅ **MEDIDO**, y la 2ª **la hereda del verificador de identidad** | `T-372-W1-13`(b), hostname pineado |
| **Remontajes del árbol** | 6 `[HEREDADO]` | **0** ✅ **MEDIDO** (0 navegaciones ⇒ 0 recargas ⇒ 0 remontajes) | `T-372-W1-13`(a) |
| **Cuenta de nonce duradero** | 1 (alquiler **1.447.680 lamports**) | **0, por INALCANZABILIDAD** ✅ **MEDIDO** | `T-372-W1-4`. **Ninguna línea se borró para lograrlo** |
| **SOL exigido por el guard** | `SENDER_MIN_LAMPORTS_FOR_DEEPLINK_DEPOSIT` = **10.402.240** | `SENDER_MIN_LAMPORTS_FOR_DEPOSIT` = **8.874.560** ✅ **MEDIDO POR VALOR** | `T-372-W1-5` (los dos bordes) + sonda `tsx` que importa `solana-escrow-rent.ts` |
| **Invocaciones de `prepare()` por envío** | 3 `[HEREDADO]` | **1** ✅ **MEDIDO** | `T-372-W1-12`: `toBe(1)` sobre un envío que cerró |
| **Órdenes de payout huérfanas** | 2 `[HEREDADO]` | **0** ⚠️ **DERIVADO** de `prepare()=1`, no medido aparte | ídem |
| **Firmas del camino inyectado** | — | 🟡 **NO VERIFICABLE** (§5) | — |

### 7.1 · El Δ, con su composición

**Δ = 1.527.680 lamports = 0,0152768 SOL**, y **re-deriva ejecutando**:

```
1.527.680  =  1.447.680 (alquiler de la cuenta de nonce)  +  5.000  +  75.000
10.402.240 (enlace)  −  8.874.560 (inyectado)  =  1.527.680
```

⇒ **Eso, y sólo eso, es lo que W1 elimina**, y lo elimina **por inalcanzabilidad**: la rama que crea
la cuenta de nonce está gateada por `if (this.firmaPorEnlace && this.caminoPorEnlace() !== null)`
(`solana-wallet.ts:897`), y dentro del navegador de la billetera la disponibilidad es `"injected"`,
así que `caminoPorEnlace()` devuelve `null`. **No se escribió una línea para borrarla**, y
`solana-escrow-rent.ts` tiene **0 líneas** en el diff.

Los **8.874.560 lamports** restantes **siguen siendo necesarios**, y bajarlos es trabajo de la `071`.

---

## 8 · Hallazgos finales

### 8.1 · BLOQUEANTEs — **todos resueltos, cada uno con testigo corriendo**

| # | Origen | Qué era | Cómo cerró |
|---|---|---|---|
| `AR/BLQ-BAJO-1` | AR it1 | La **puerta principal** (`flow.tsx:757`) no tenía guard sobre su `href`: revertirla al enlace crudo pre-W1 —reintroduciendo el defecto que la ola dice cerrar— dejaba la suite en **exit 0** | `T-372-W1-1` desarma el universal link y asserta que `kyc` no viaja y `monto` sí. **MUT-I muere** con un `×` nombrado |
| `AR-it2/BLQ-MED-1` | re-AR | Un **denominador publicado que no re-derivaba** (`795`), dentro del hallazgo cuya lección declarada es *"el porcentaje se deriva delante de quien lo lee"* | Re-medido contra el árbol: el correcto es **782**. El `74,6 %` sí re-deriva |
| `AR-it2/BLQ-BAJO-2` | re-AR | El fix-pack anterior cerró **una de las dos** propiedades de la misma expresión: se podía apagar en silencio el desenlace `con-marca-sin-borrador` entero y la suite quedaba verde | `T-372-W1-1b` + la **mitad negativa** en `T-372-W1-1`. **MUT-L y MUT-M mueren**, cada uno con un solo `×` |
| `CR/BLQ-MEDIO-1` | CR | **El instrumento de campo se daba vuelta con una recarga**: nadie limpiaba `wb` de la barra, así que un pull-to-refresh en el teléfono publicaba *"el almacenamiento cruzó"* sobre datos re-tipeados a mano | La marca **se consume** con `replaceState` desde el efecto (no desde el inicializador del `useState`). `T-372-W1-7e` ✓, **MUT-CR-BM muere** |
| `CR/BLQ-BAJO-1` | CR | *"No pude leer el disco"* colapsado en *"no hay borrador"*: se le decía a la persona que sus datos no están **cuando sí están** | **Cuarto valor** `disco-ilegible` en una unión cerrada, con el nombre que **ya existía** en el repo. `T-372-W1-7f` ✓, **MUT-CR-BB1 y su espejo mueren** |
| `CR/BLQ-BAJO-2` | CR | **I-5 era la única línea de producción de la ola sin ningún testigo**: revertirla borraba la advertencia y el segundo enlace, y el gate quedaba entero verde ⇒ era **decoración** | `T-372-W1-6b` sobre la **otra** pantalla. **MUT-CR-2 y sus dos mitades mueren** |
| `CR/BLQ-BAJO-3` | CR | Una **enumeración de alcanzabilidad publicada como exhaustiva** y falsa en tres sub-afirmaciones (faltaba una quinta entrada; *"la ÚNICA"* era falso dos veces) | Re-derivada con `grep -n 'setStep('` ⇒ 24 sitios, leídos uno por uno, dos descartados con su motivo. **F4 la re-derivó por su cuenta y coincide exacto** |
| `CR-cierre/BLQ` | verificación de cierre | 1 bloqueante que **era una cita del orquestador**, no del Dev: `story-W1.md:517` apuntaba a un comentario dentro de otro `it` | El orquestador **corrigió 7 citas**. F4 re-derivó las 6 críticas: **las 6 resuelven** |

### 8.2 · MENORes — **resueltos o aceptados como deuda documental**

- **Resueltos en fix-packs**: `AR/MNR-1` (*"su único guard"* desmentido por un mutante),
  `AR/MNR-2` (la justificación de escala explicaba 37 de 662 líneas de exceso), `AR/MNR-3` (dos
  lecturas de la misma marca), `AR/MNR-4` (el aviso sin gate de pantalla ⇒ **cambió el contrato
  I-2(b) a cuatro condiciones**, autoría del orquestador), `AR-it2/MNR-A` (un `it` en plural que
  medía una sola pantalla), `AR-it2/MNR-B` y `CR/MNR-4` (el desborde de **archivos**, no sólo de
  líneas), `CR/MNR-1` (decisión correcta, motivo falso, sin medición), `CR/MNR-3` (cita rota),
  `QA-MNR-1` y `QA-MNR-3` (fix-pack 4).
- **Aceptados como deuda** (ver §11): `QA-MNR-2`, el índice incompleto de
  `wallet-availability.test.tsx:1214`, y el desvío de `D6` (11 archivos contra ≤9).

---

## 9 · El desvío de escala — declarado, con el número y no con el adjetivo

**Medición final contra el índice** (`git diff --numstat cc02b61 f295a6f`, después de `git add -A`):

| | Presupuesto (`story-W1.md:770`) | Real | Ratio |
|---|---:|---:|---:|
| Líneas añadidas | **≤ 900** | **1988** | **2,21x** |
| Líneas borradas | ~11 | 19 | |
| Archivos tocados | **≤ 10** | **11** | 1,1x |

🔴 **Cruzó los dos disparadores del check 7**: el **2x del presupuesto declarado** (2,21x) y el
**umbral absoluto de 1.800 líneas añadidas** (1988). El tercer umbral, **20 archivos, no se cruzó**.
Y **el desborde de archivos es de uno**: `src/test-support/salida-al-navegador.ts` (+22), que existe
porque el desarmado del universal link lo necesitan **dos** suites, e importar un `*.test.ts` desde
otro archivo de tests registraría sus `it` en la suite que importa.

**Justificado por escrito, y re-derivado por dos revisores** (el CR midió 1,74x en `2ad4698`; **los
fix-packs posteriores lo cruzaron y el auto-blindaje lo registró**; F4 lo re-derivó al cierre y
coincide exacto). ⇒ **No es un exceso silencioso.**

**A la pregunta que decide** (*¿qué parte de esto seguiría existiendo si lo escribiera alguien que ya
conoce este repo?*):

- **La producción entera de la ola son 279 líneas añadidas**: `salida-al-navegador-de-la-billetera.ts`
  185 + `bitacora-de-vuelta.ts` 84 + `flow.tsx` **9 reescritas con Δ0** + `diagnostico-de-vuelta.tsx`
  1. Más 22 de `src/test-support/`, que no es producción ni test.
- **73,5 % del total (1462 de 1988) son dos archivos de tests.** El más grande —
  `recorrido-en-el-navegador-de-la-billetera.test.tsx`, **768 líneas** — es **W1.0: la premisa
  falsable corrida antes de una línea de producción**, y es exactamente **la razón** por la que la
  producción son 9 líneas reescritas en `flow.tsx` en vez de un recorrido nuevo.
- **Ninguno es relleno**: contra los tests de la ola murieron mutantes con `×` nombrado en cada caso
  (7 re-aplicados por el AR + MUT-I, MUT-J, MUT-K, MUT-L, MUT-M, MUT-CR-1, MUT-CR-2/2b/2c,
  MUT-CR-BM, MUT-CR-BB1/BB1c, más MUT-QA-1 y MUT-QA-2 de F4).
- **Lo que sí se recortó antes de justificar**: 9 líneas de docblock en `bitacora-de-vuelta.ts` y 4
  en `wallet-availability.test.tsx`, todas duplicación de algo ya escrito al lado.

⇒ **El presupuesto de ~690 se pasó en tests, no en código.**

---

## 10 · Auto-Blindaje consolidado — las lecciones transferibles

Las **27 entradas** de `auto-blindaje.md` (F3 + los 4 fix-packs) están íntegras en ese archivo, con su
crónica, su medición y su commit. Acá van **ordenadas por lección transferible a otros proyectos**, no
por orden cronológico. Cada lección nombra las entradas de las que sale.

### A · Un fixture que no reproduce el defecto es indistinguible de un guard que funciona
*(W1.0 ×3, W1.3)*
- La forma del dato de un `localStorage` **se lee del escritor de producción**, nunca se infiere del
  nombre de la clave. Un JSON donde el escritor pone un string crudo hace que **dos `it` den verde
  con el gate sano y con el gate invertido**.
- **Todo mutante se verifica en disco antes de correr nada**, y se aborta si el patrón no aparece
  **exactamente una vez**: un mutante que no matcheó, más una suite verde, son indistinguibles de un
  control que funciona.
- Un **arnés de mutación** que cachea el `.orig` con `if not exists` puede **revertir una ola entera
  en silencio**, y el `md5` contra el snapshot equivocado **confirma el revert en vez de cazarlo**.
  El control correcto es contra el árbol de git. Síntoma: *"pasaba hace diez minutos y ahora no, sin
  que yo tocara eso"*.
- **Un artefacto sin control no es un instrumento.** Antes de dar por cubierta una pieza nueva, correr
  el mutante que la borra.

### B · La cobertura se cierra por **expresión**, no por mutante ni por vecino
*(fix-pack 1, fix-pack 2, fix-pack 3)*
- Cuando una ola escribe una **segunda instancia** de una expresión ya vigilada, la pregunta no es
  *¿esta propiedad está medida en algún lado?* sino **¿qué mutante sobre ESTA línea pone algo rojo?**
- Un `it` que mata **el mutante que el reporte nombró** no cubre la línea: **cubre ese mutante**. La
  pregunta que falta es *¿cuántas decisiones distintas toma esta expresión?*, y se exige un `×`
  nombrado **por cada una, con su mitad negativa**.
- Cuando la misma propiedad se escribe **en dos pantallas**, el guard de una **no cubre a la otra**.
  La persona ve una sola.

### C · Toda afirmación escrita es falsable, y envejece con el commit siguiente
*(fix-packs 1, 2, 3, 4)*
- **Exclusividad** (*"el único"*, *"nadie más"*): se verifica **volviendo a correr el mutante después
  de la última edición**, no leyendo.
- **Plurales**: el título de un `it` se lee como un assert. **Plural sólo si el fixture recorre el
  plural**, y lo que queda sin medir se dice en el docblock aunque el motivo sea bueno.
- **Enumeraciones con número adelante** (*"las cuatro entradas"*): se re-derivan **con una
  herramienta** antes de publicarse. ⛔ Y la salida del `grep` **no se vuelca**: se lee sitio por
  sitio, porque el ruido (prosa, uniones de tipos) sólo se descarta leyendo.
- **El motivo de un guard** se escribe recorriendo **sus llamadores reales**. Si el escenario que
  describe es inalcanzable desde todos ellos, el guard puede seguir siendo correcto y el motivo hay
  que reescribirlo — y ahí se descubre si además le falta testigo.
- ***"Hoy es inerte"* es una afirmación sobre EJECUCIÓN**, y leer los tres llamadores no la prueba:
  prueba que **parece** inerte. Ponerle un `throw` a la rama sospechada y ver la suite seguir verde
  **sí** la prueba, y cuesta una corrida.

### D · 🔴 Cuando un fix-pack agrega un valor a una unión cerrada, el barrido **no es por la etiqueta nueva**
*(fix-pack 4 — candidata fuerte a regla general)*
Los sitios viejos **no contienen la etiqueta nueva, por definición**. Un `grep` por
`con-marca-disco-ilegible` —lo natural al agregar el 4º valor— **no encuentra** el párrafo que los
enumera en prosa. Lo que los encuentra es buscar **el numeral que deja de valer** (`TRES`/`tres`/`3`)
y **el nombre del tipo**. Y el barrido va sobre `src/` **entero**: dos de los tres sitios stale de
esta ola estaban en archivos que el fix-pack anterior **ya había editado**.

### E · 🔴 Las citas cruzadas entre repos **no las vigila nada** — candidato a HU propia
*(W1.0 ×2, W1.4, fix-pack 3, CR/MNR-3, y 7 citas rotas por esta causa)*
- `citas-ancladas.test.ts` **sólo mira dentro de `chaski-v3`**, y los documentos de esta HU viven en
  `wasiai-a2a`. **Se rompieron 7 citas por esta causa** y las cazó un humano leyendo, no un candado.
- El perímetro del candado es **opt-in**: sólo mira las citas **ancladas**. Una cita suelta rota
  **no la mira nadie**, y agregar o sacar renglones de un docblock **mueve todo lo de abajo**. La
  segunda ocurrencia de esta ola pasó **recortando** prosa, o sea haciendo lo contrario de lo que
  la había roto la primera vez.
- ⚠️ **Una cita ANCLADA es una escritura sobre el archivo destino**, aunque el archivo no se toque:
  en este repo una cita anclada nueva hacia `flow.tsx` movió **doce marcadores de censo en ocho
  archivos**, dos de ellos fuera del Scope IN de la ola.
- ⚠️ Una cita a `` `:NN` `` **sin ruta apunta al archivo que la escribe**, así que puede dar verde
  por accidente.

### F · 🔴 Una cita a un test se escribe **por el nombre del `it`** — con su límite medido
*(nota del orquestador en `story-W1.md:868` + `validation.md` §3.2)*
El nombre sobrevive a los fix-packs; **el número de línea no** (los cuatro fix-packs movieron casi
todos los números de `wallet-availability.test.tsx`). El número, si va, va **anclado a un commit**.
⚠️ **Y su límite, medido por QA: el nombre del `it` no es único.** `T-CABLE-1` y `T-CABLE-2` existen
**también** en `src/composition/container.test.ts`, midiendo otra cosa. ⇒ **la cita va siempre con su
archivo, o no resuelve.**

### G · Un número que se publica **se re-mide contra el árbol**, nunca se obtiene sumando deltas
*(fix-packs 1, 2, 3)*
- Sumarle un delta a un número anterior **cuenta dos veces las líneas reemplazadas**, y el error es
  invisible porque el resultado *parece* razonable. Pasó **dentro del hallazgo cuya lección declarada
  era "el porcentaje se deriva delante de quien lo lee"**: una lección declarada **no se aplica sola
  a la línea de abajo**.
- Toda cifra publicada lleva **a qué commit pertenece**: *"hoy"* envejece con el commit siguiente.
- La **declaración de escala se ordena por exceso descendente** y se justifica de arriba hacia abajo:
  una justificación que arranca por el ítem más chico está eligiendo **el que tiene mejor excusa**.
- **El presupuesto de escala se contrasta en CADA fix-pack**, no sólo al cerrar: un fix-pack de 451
  líneas movió la ola de 1,74x a 2,21x, y **el cruce del umbral es invisible si cada fix-pack se
  mide sólo contra sí mismo**. Y se contrastan **las dos** magnitudes (líneas **y** archivos), aunque
  se desborde una sola.

### H · Un `catch` que asigna `false`/`0`/`[]` convierte *"no pude preguntar"* en *"la respuesta es no"*
*(fix-pack 3)*
El tipo era un `boolean`, y **un booleano no tiene dónde poner el tercer valor**: el colapso no fue
una decisión, fue lo único que el tipo permitía, y **no se ve leyendo**. La pregunta previa es *¿el
tipo tiene lugar para el tercer valor?* Y el arreglo usó **el nombre que ya existía en el repo**
(`disco-ilegible`), con un `Record` sobre la unión cerrada para que un quinto valor **no compile** en
vez de caer en un `else` silencioso.

### I · Una marca de URL que significa *"esto acaba de pasar"* **se consume al leerla**
*(fix-pack 3)*
Si sobrevive en la barra, deja de decir *"pasó"* y pasa a decir *"alguna vez pasó"*, y **una recarga
convierte al instrumento en su propio contraejemplo**. Se consume desde un **efecto**, nunca desde el
inicializador de un `useState` (bajo `StrictMode` corre dos veces y la segunda lee una URL que la
primera ya limpió). ⚠️ Y cuando un mutante muere, **mirar cuál aserción produjo el rojo**: morir por
una fila intermedia deja la propiedad del hallazgo sin testigo (acá hizo falta `expect.soft`).

### J · Antes de leer un rojo como hallazgo del sujeto, medí si lo produce **el entorno**
*(W1.0)*
Bajo `jsdom`, `Buffer.from(x) instanceof Uint8Array` es **false**, y eso vuelve
`findProgramAddressSync` inalcanzable. Un rojo así **no dice nada del código bajo prueba** y estuvo a
un paso de reportarse como *"la premisa de la ola es falsa"*. **La sonda cuesta dos minutos; la
conclusión falsa cuesta una ola.** Aplica a `@solana/web3.js`, `@noble/*`, `tweetnacl` y todo lo que
valide con `instanceof Uint8Array`.

### K · Correr las **partes** de un gate no es correr el gate
*(W1.2)*
Un `import` sin usar pasó `tsc --noEmit` **y** `vitest`, y lo cazó **`biome lint`, que es el primer
eslabón**. Y antes de escribir copy en una pantalla, **leer qué guards la vigilan**: acá un guard
viejo (`T-UI-2`) frenó una frase que afirmaba lo que hay instalado en el dispositivo. **El guard
tenía razón.**

### L · Cuando una métrica **empeora al arreglar un bug**, la pregunta no es *"¿qué rompí?"*
*(W1.2)*
Es **"¿qué otro defecto estaba compensando este verde?"**. `T-LINK-1` se puso rojo al arreglar la
limpieza del `href`: el `it` **no estaba mal escrito, medía bien un comportamiento equivocado**, y
por eso su verde **no protegía nada**. Un test que pinnea el comportamiento actual **congela lo que
haya, bug incluido**.

### M · Un guard de existencia de archivos que vive en un archivo que importa lo que vigila
*(W1.0)*
Su mutante natural lo mata **por colapso del resolvedor de módulos**, no por aserción, y eso **no
cuenta como KILLED**. La pregunta previa: *¿qué otro control podría estar matando a este mutante?* —
acá la respuesta era *"el resolvedor de módulos"*, que **no es un control**.

---

## 11 · 🔴 Deudas abiertas — la lista para el founder

| # | Deuda | Dónde | Prioridad |
|---|---|---|---|
| **1** | **El conteo de firmas del camino inyectado sin derivar** (`AC-0-4`/`MI-1`). Los informes de terreno se contradicen y **nadie lo ejecutó**. Escalado a **W0**, que exige el teléfono del founder con **Testnet Mode** activo | `work-item.md:200`, `:212` · `validation.md` §4.1 | **Alta** — gatea W0 |
| **2** | **El smoke manual en teléfono real, sin correr.** Es lo único que puede contestar las tres cosas de §6 (¿cruza el `localStorage`? ¿abre `browse`? ¿qué hace sin Phantom instalada?). 8 pasos escritos y listos | `validation.md` §9 | **Alta** — es el entregable de campo de W1 |
| **3** | 🔴 **No hay guard de citas cross-repo.** `citas-ancladas.test.ts` **sólo mira dentro de `chaski-v3`** y los documentos viven en `wasiai-a2a`. **7 citas se rompieron por esta causa** en esta ola y las cazó un humano | `chaski-v3/src/composition/citas-ancladas.test.ts` | **Candidato a HU propia** |
| **4** | **Índice incompleto**: `wallet-availability.test.tsx:1214` dice *"El aviso de aterrizaje, TRES casos → `T-372-W1-7`"*, y es **verdadero** (por eso el fix-pack 4 **no** lo tocó: corregir el numeral ahí habría metido una frase falsa para tapar una que no lo era). Lo que falta es que el índice **no nombra** `-7d`, `-7e` ni `-7f` | ídem | Baja (TD, documental) |
| **5** | `QA-MNR-2`: `story-W1.md:500` conserva la 4ª condición con la **expresión vieja** (`!aterrizaje.hayBorrador`). El código shippeado y la enmienda normativa dicen `borradorEnElDisco === "sin-borrador"` | `story-W1.md:500` | Baja (artefacto inmutable; queda declarado acá) |
| **6** | **`D6` incumplido**: 11 archivos contra los ≤9 de `story-W1.md` §3.1. **Ninguno está en Scope OUT** (eso sí sería bloqueante). Los dos extra son un helper de test compartido y el test del archivo G | `validation.md` §6.1 | Baja (forma) |
| **7** | 🔴 **W1 NO CIERRA LA HU 233.** Quedan: la **`071` de `chaski-v3`** (el SOL que sigue haciendo falta), **W3** (la sesión server-side, para que las dos firmas de identidad dejen de probar lo mismo) y **W4** (la decisión de riesgo de la firma de patrocinio, que **no es un bloqueo técnico** y necesita **un dueño**: `MI-9`, abierto) | `work-item.md` §0 | **Alta** |
| **8** | `TD-372-ATA-DEL-SENDER` — la creación idempotente de la ATA del sender **no la absorbe la `071`**, que la declara **precondición** de su `AC-13` | `work-item.md` | Media (se escribió para que no se fuera en silencio al borrar W2) |

**Orden consolidado de lo que sigue** (`work-item.md` §0): **(1)** W1 ✅ hecha → **(2)** la HU `071`
de `chaski-v3` (tres repos + upgrade del programa) → **(3)** W3 → **(4)** W4.

⚠️ **Coordinación medida**: W1 editó `flow.tsx`, no `solana-wallet.ts` (Δ0 verificado ahí), así que
**la ola 1 no le cambia nada a la `071`** — ni un AC, ni un DT, ni una CD — **y tampoco le saca
trabajo**.

---

## 12 · Archivos modificados

`git diff --numstat cc02b61 f295a6f` ⇒ **1988 añadidas / 19 borradas / 11 archivos**, todos en
`/home/ferdev/.openclaw/workspace/chaski-v3`.

### Producción (279 añadidas / 12 borradas)

| Archivo | +/− | Qué es |
|---|---:|---|
| `src/presentation/salida-al-navegador-de-la-billetera.ts` | **+185 / −0** | **Nuevo.** El módulo puro: arma el universal link envolviendo `phantomBrowseUrl`, limpia el rastro de vuelta componiendo `hrefSinRastroDeVuelta`, consume la marca de salida, y declara la incógnita del fallback de `browse` en vez de resolverla de palabra |
| `src/presentation/bitacora-de-vuelta.ts` | **+84 / −1** | El 5º hito y sus **cuatro** desenlaces, con el tipo `BorradorEnElDisco` como unión cerrada |
| `src/presentation/flow.tsx` | **+9 / −9** | Las 5 inserciones. **Δ0 en líneas físicas** (`wc -l` = 4453, sin cambio) por CD-W1-1 |
| `src/presentation/diagnostico-de-vuelta.tsx` | **+1 / −1** | El renglón `salida navegador:` del bloque `?diag=1`. **Δ0** (593 líneas) |

### Tests (1462 en dos archivos, 215 en un tercero)

| Archivo | +/− | Qué es |
|---|---:|---|
| `src/presentation/recorrido-en-el-navegador-de-la-billetera.test.tsx` | **+768 / −0** | **Nuevo.** W1.0: los 5 puntos de la premisa, corridos **antes** de una línea de producción |
| `src/presentation/wallet-availability.test.tsx` | **+694 / −5** | Los guards de pantalla. Las 5 borradas son la reescritura Δ0, **ninguna aserción se borró ni se debilitó** |
| `src/presentation/salida-al-navegador-de-la-billetera.test.ts` | **+215 / −0** | **Nuevo.** El módulo puro |
| `src/presentation/diagnostico-de-vuelta.test.tsx` | **+8 / −1** | El archivo obligado: `T-DIAG-CAPTURA` se pone rojo solo (verificado con MUT-D) |

### Soporte de test y documentación

| Archivo | +/− | Qué es |
|---|---:|---|
| `src/test-support/salida-al-navegador.ts` | **+22 / −0** | **Nuevo, el 11.º archivo.** Única copia del **desarmado** del universal link, que necesitan dos suites. No entra al bundle |
| `README.md` · `README.es.md` | **+1/−1** cada uno | El conteo 165 → **167** archivos de test, con testigo (`readme-test-count.test.ts`) |

### Cero líneas, verificado archivo por archivo (Scope OUT)

`src/infrastructure/solana-wallet.ts` · `src/application/solana-escrow-rent.ts` ·
`src/infrastructure/solana/deeplink/**` · `src/infrastructure/solana/nonce-duradero.ts` ·
`src/application/preparacion-por-enlace.ts` · `flow-vm.ts` · `splash-puerta.ts` · `app/**`.
**Ningún archivo borrado** (`git diff --diff-filter=D` ⇒ vacío) ⇒ `AC-1-5` y CD-3/CD-5 cumplidas.

### Commits — 14 sin pushear, `main` local en `f295a6f`

```
077d00b test(W1.0)  la premisa, falsable, con cero lineas de produccion
539f8d7 feat(W1.1)  el calculo puro de la salida al navegador de la billetera
305aeb8 feat(W1.2)  la puerta al navegador de la billetera, con D0 en flow.tsx
1f93821 feat(W1.3)  el quinto hito y su renglon, con un llamador y un guard
272023f docs(W1.4)  cierre - las citas re-derivadas DESPUES de la ultima edicion
550bf33 merge       el navegador de la billetera como camino principal
582f4b5 fix         fix-pack 1 (AR)        -> merge e9d6892
4f920e1 fix         fix-pack 2 (re-AR it2) -> merge 2ad4698
b0692c0 fix         fix-pack 3 (CR)        -> merge b402ab7
974fbaa fix         fix-pack 4 (F4/QA)     -> merge f295a6f
```

Ramas usadas: `feat/wkh-372-w1-navegador-de-la-billetera`, `fix/WKH-372-w1-fixpack-ar`,
`fix/WKH-372-w1-fixpack-ar-it2`, `fix/WKH-372-w1-fixpack-cr`, `fix/WKH-372-w1-fixpack-4-qa`.
⚠️ La rama `feat/233-wkh-372-recorrido-movil-sin-saltos` que el `_INDEX.md` proponía **no se usó**.

---

## 13 · Decisiones diferidas

- **La ola W2 se retiró del work-item porque era otra HU ya escrita**: la `071` de `chaski-v3`, con
  `sdd.md` de 159 KB y dos rondas de AR encima. La revisión 1 la re-derivó desde cero porque
  **`chaski-v3/doc/` está gitignoreado y `grep` da CERO falso sobre él**. Se dejó el **hueco en
  `W2`** y **no se renumeró**: renumerar habría roto todas las referencias externas ya publicadas a
  `W3`/`W4`; dejar el hueco rompe cero y deja el registro de por qué se fue.
- **`AC-1-2` partido en dos** (`a` recurrente / `b` primera vez), decisión del gate del F2.5, con la
  razón escrita y **sin aflojar el listón** del recorrido recurrente.
- **El contrato I-2(b) pasó de tres a cuatro condiciones** en el fix-pack 1, autoría del orquestador
  en el gate del AR, con guard propio (`T-372-W1-7c`) y su mutante.
- **`MI-9` abierto**: quién firma la decisión de riesgo de W4. **Bloquea su cierre** y no es técnico.
- **Sin tickets nuevos de backlog creados en esta ola.** Los candidatos están en §11 (el guard de
  citas cross-repo es el más claro).

---

## 14 · Lecciones para próximas HUs

1. **Poner la premisa falsable primero, con cero líneas de producción, es lo que hace barata la ola.**
   768 líneas de test corridas **antes** de tocar producción son la razón por la que la producción
   fueron **9 líneas reescritas con Δ0** en vez de un recorrido nuevo. Es el 49 % del diff y es lo
   que un revisor externo escribiría igual.
2. **Cerrar la expresión, no el mutante del reporte.** Tres bloqueantes de esta ola son **el mismo
   cuadrante** en tres instancias distintas de la misma propiedad duplicada. La pregunta que los
   habría evitado a los tres: *¿cuántas instancias de esta expresión hay, y cuántas tienen un mutante
   propio que murió?*
3. **Toda cifra publicada se re-mide contra el árbol y lleva su commit.** El único bloqueante
   `MEDIO` del re-AR fue **un denominador que no re-derivaba, dentro del hallazgo cuya lección
   declarada era exactamente eso**. Una lección declarada no se aplica sola a la línea de abajo.
4. **Cuando un fix-pack agrega un valor a una unión cerrada, barré por el numeral que deja de valer,
   no por la etiqueta nueva** — y sobre `src/` entero, incluidos los archivos que el fix-pack
   anterior ya editó. Es lo que separó a F4 y al fix-pack 4 de las dos revisiones anteriores.
5. **El gate se corre entero, en orden, contra el índice.** `lint` va primero y es el eslabón al que
   nadie llega: un `import` sin usar pasó `tsc` **y** `vitest`. Y el gate **no se supone que mira tu
   HU**: se comprueba con un control positivo.

---

*Docs · NexusAgil · WKH-372 ola W1 · 2026-08-31 · `chaski-v3@f295a6f` (14 commits sin pushear) ·
compilado leyendo `work-item.md`, `sdd-w1.md`, `story-W1.md`, `adversarial-review.md`,
`code-review.md`, `validation.md` y `auto-blindaje.md`. Ningún resultado se inventó y ningún número
se copió sin nombrar de dónde sale.*
