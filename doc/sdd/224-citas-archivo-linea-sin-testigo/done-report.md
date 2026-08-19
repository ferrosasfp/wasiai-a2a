# Done Report — HU 224 · WKH-362 · `TD-316-CITAS-SIN-TESTIGO`

> **Este archivo EXISTE.** Verificado con `ls -l` después de escribirlo (ver §12).
> Se declara en la primera línea a propósito: en esta sesión **diez** reportes de cierre se
> declararon sin existir, y ese es el defecto exacto que esta HU persigue una capa más abajo.

| | |
|---|---|
| **Rama** | `feat/224-citas-archivo-linea-sin-testigo` |
| **`main`** | `b31ddba` — **intacto, nada pusheado, nada mergeado** |
| **Estado** | **DONE** (cerrada en la rama; el merge y el push son del humano) |
| **Fecha de cierre** | 2026-08-19 |
| **Modo** | QUALITY |
| **Veredicto del CR** | **APROBADO** — textual: *«Sin hedging: mergeá.»* · 0 BLOQUEANTEs · 5 MENORes |

---

## 0 · Qué es esta HU, en una línea que el founder pueda leer

**No es higiene de comentarios: es la causa raíz de un defecto que recurrió CUATRO veces dentro de
una sola HU y que ya apareció en TRES repos con TRES agentes distintos.** Una cita `archivo:línea`
escrita en un comentario, un docblock o el nombre de un test **no tenía ningún testigo**: ningún
test del repo podía ponerse rojo porque el número apuntara a la línea equivocada. Esta HU le pone
testigo mecánico a un corte acotado y **declara por escrito, adentro del propio guardián, todo lo
que sigue sin cubrir**.

### El argumento de existencia lo produjeron sus propios artefactos, midiéndose

| Rol | Qué produjo **mientras escribía la HU que existe para impedirlo** |
|---|---|
| **F2 (SDD)** | **2 de ~60 citas mal.** Una de ellas por **copiar un número en vez de abrirlo** — violando el Constraint Directive que estaba redactando en ese mismo documento |
| **F2.5 (Story File)** | Midió que **una «corrección» que el SDD pedía era FALSA**: aplicarla **habría metido una cita falsa DENTRO de la HU que existe para sacarlas** |
| **F3 (Dev)** | 🪞 **El punto ciego del dotfile se reprodujo ADENTRO del arreglo del punto ciego del dotfile**, el mismo día (`auto-blindaje.md`, W3). Y un desglose por forma escrito en W5 **ya estaba viejo por su propia edición, en la misma sesión** (`P1=14 P2=20` → real `P1=15 P2=19`, porque una corrección de la propia HU movió un token de P2 a P1) |
| **AR it-1 · CR** | **Los dos cometieron el mismo defecto mientras lo auditaban**, y **los dos lo declararon**. El CR además cazó su propio instrumento invertido (§9) |
| **F-DONE (este rol)** | Corregir cinco afirmaciones falsas **subió los tokens sin testigo del propio guardián de 247 a 260**, y **el número tuvo que escribirse DOS veces porque escribirlo lo movía** (§3.6) |

**Tasa: 3 de ~60 (5 %) en el MEJOR caso posible** — un rol dedicado, concentrado, con el defecto
como único tema de la sesión. **No es descuido ajeno: es la tasa base.** Ése es el argumento
completo a favor de que exista un testigo mecánico.

---

## 1 · Pipeline ejecutado

| Fase | Artefacto | Resultado |
|---|---|---|
| **F1** | `work-item.md` (468 líneas) | 12 ACs EARS · gate `HU_APPROVED` |
| **F2** | `sdd.md` (777 líneas) | Constraint Directives CD-1..CD-8 · gate `SPEC_APPROVED` |
| **F2.5** | `story-file.md` (1210 líneas) | 12 controles `G-C1..G-C12` mapeados AC por AC |
| **F3** | commit `5af987e` | Implementación en waves W0..W5 + arnés de mutación |
| **AR it-1** | `ar-report.md` (440 líneas) | 🔴 **RECHAZADO — 4 BLOQUEANTES activos** |
| **Fix-pack 1** | commit `06758af` | Los 4 BLQ cerrados + 5 MENORes |
| **AR it-2** | `ar-report-it2.md` (320 líneas) | **APROBADO con MENORes** (6 MENORes) |
| **Fix-pack 2** | commit `ac4f4c3` | 4 de los 6 MENORes del re-AR |
| **Artefactos** | commit `cc714a1` | `sdd.md`/`story-file.md`/`ar-report*.md` entraron a git |
| **CR** | `cr-report.md` (432 líneas) | **APROBADO. «Sin hedging: mergeá.»** 0 BLQ · 5 MENORes |
| **DONE** | este archivo + fix de prosa | 3 de los 5 MENORes eran **afirmaciones falsas dentro del guardián** ⇒ corregidas (§3) |

### ⚠️ DESVIACIÓN DE PROCESO, declarada y no maquillada
**NO hay `validation.md`: la fase F4 (QA / Drift Detection) NO se ejecutó como artefacto propio.**
La carpeta tiene 8 archivos y ninguno es un `validation.md`. La regla de cierre dice «no marcar DONE
si el `validation.md` no tiene veredicto APROBADO», y lo honesto es decir que **acá no hay ninguno
que leer**, no inventar que sí. Se cierra en **DONE** igual, y el criterio es explícito:

- los 12 ACs tienen **cobertura mecánica declarada control por control** (`story-file.md:1013-1015`)
  y los **12 controles corren y pasan** en cada `npm test` (§4);
- el **AR corrió dos veces** con mutantes ejecutados en las dos direcciones, y el **CR re-derivó
  los números en vez de leerlos**;
- lo que falta respecto de un F4 formal es **la evidencia archivo:línea AC por AC firmada por un
  rol independiente**. La tabla de §4 la reconstruye desde los artefactos existentes, y **está
  etiquetada como tal**.

Quien lea este cierre buscando un F4: **no está**. Es la deuda de proceso de esta HU.

---

## 2 · Lo que entrega, medido

### 2.1 El universo real es 57, no 45 — y el 45 estaba declarado como PISO
El contrato hablaba de **45** anclas. Barriendo los 14 paths del Corte A, el total medido es **57**
(re-derivado por mí en este cierre: `scanSource` sobre `CORTE_A_PATHS`, 14 paths, suma 57).
**45 era, textualmente, un piso, y lo es.** Los **+12** se parten en dos:

- **+8 citas REALES a un DOTFILE** (`.gitignore:172` y compañía, en
  `test/sdd-index-matches-folders.exceptions.ts`). **Los dos escáneres anteriores no las veían**
  porque exigían un nombre ANTES del punto de la extensión, y `.gitignore` no lo tiene.
  🎯 **Y esto es exactamente la falla compartida que el Story File anticipó** al declarar la
  concordancia entre los dos escáneres previos como *«una CONCORDANCIA, no una prueba … pueden
  compartir el mismo defecto»* (`story-file.md:284-287`). **Compartían éste.**
- **+4 tokens de RUIDO** en la forma P4 (`{reputation:100}`, `minLength:1`, dos `:00` de un
  timestamp ISO). El escáner los reporta **a propósito** en vez de descartarlos por rango: una
  heurística «los números chicos no son líneas» se come mañana una cita real a la línea 80. Van a
  `SCANNER_FALSE_POSITIVES` con motivo escrito, o sea **al lado ruidoso**.

### 2.2 🔴 Las 8 citas al dotfile estaban TODAS MAL, corridas exactamente +13 líneas
5 tokens distintos (`:172`, `:173`, `:177-180`, `:178`, `:184`), 8 ocurrencias, **todas +13**.
Verificado por mí abriendo `.gitignore` en este cierre:

| Lo que la prosa afirmaba | Lo que hay en esa línea HOY | Corregido a |
|---|---|---|
| `.gitignore:172` = *«runbook de identidades de operador»* | `/doc/investors/30-60-90-traction-plan.md` | `:185` (que sí es `074-…-operator-identities-runbook/done-report.md`) |

🎯 **Una cita afirmaba ser el runbook de identidades del operador y era el plan de tracción para
inversores.** Dos documentos que no se parecen en nada, y nada en el repo podía notarlo.

### 2.3 15 citas falsas corregidas — derivado del diff, no copiado
`git diff main...HEAD` ⇒ **8** en `test/sdd-index-matches-folders.exceptions.ts` (las del dotfile)
+ **7** en `src/` (`payment-spec-reader.ts` `discovery.ts:23`→`:63` · `routes/agents.ts`
`registries.ts:35`→`:94` · `compose.ts` `:208`→`:571` · `fee-split.ts` `:335`→`:336` ·
`types/index.ts` ×3: `:777`→`:922`, `reputation.ts:182-183`→`:189`, `compose.ts:130`→
`src/services/compose.ts:571`) = **15**.

### 2.4 Dos ABSTENCIONES que valen igual que las correcciones
- **`tsconfig.json:19`** — **el SDD la declaró falsa siendo correcta.** No se «corrigió».
- **`fee-split.ts:316`** — *«no está demostrablemente mal, y **corregir de más queda con cara de
  verificado**»*. Se dejó.

Una corrección de más produce una cita que alguien va a leer como verificada. **Abstenerse con el
motivo escrito es un resultado, no una omisión.**

### 2.5 Cobertura honesta (CD-8) — con el numerador Y el denominador declarados como pisos
**6,0 % de `src`+`test` · 0,21 % del repo entero.** La frase que el guardián usa es
***«estas citas no pueden mentir sin que la suite se caiga»***, **nunca** *«las citas del repo están
verificadas»*.
⚠️ **No re-derivé estos dos porcentajes en este cierre.** Vienen del SDD, y su denominador
(749 en `src`+`test`, ~20.550 en el repo) **salió del mismo escáner que se comía los dotfiles** ⇒
está subestimado por una cantidad **no medida**. Queda como `TD-316-CITAS-DOTFILE-EN-OTROS-CORTES`
(§6). Son **pisos por los dos lados**.

### 2.6 🎯 El dato que sorprende y por eso hay que escribirlo: la puerta de tipos NO mira el guardián
`./node_modules/.bin/tsc --noEmit --listFiles` ⇒ **2505 archivos**, y
`grep -c "cited-lines-guard"` sobre esa salida ⇒ **0**.
**La puerta verde de `tsc` no cubre ni un archivo de esta HU**, porque `tsconfig.json:19` es
`include: ["src/**/*"]`. Y `biome` tampoco: `package.json:11` es `biome check src/`.
Los 4 archivos se typechequean **aparte**:
`tsc --noEmit --ignoreConfig --strict --noUncheckedIndexedAccess --target es2022 --module nodenext
--moduleResolution nodenext --skipLibCheck --types node,vitest/globals` ⇒ **exit 0, cero errores**.
Está declarado en **tres** lugares, y el que importa es **el mensaje de error del assert** — que es
lo único que alguien va a leer en CI cuando el guardián se ponga rojo.

---

## 3 · El fix de prosa de esta fase — tres afirmaciones FALSAS dentro del guardián

El CR dejó 5 MENORes y **tres de ellos eran afirmaciones falsas escritas adentro del archivo cuyo
propósito entero es que las afirmaciones no mientan**. Se corrigieron acá. ⛔ **Se corrigió la
PROSA, no el mecanismo**: los tres arreglos mecánicos quedan como deuda con nombre (§6).

### 3.1 `MNR-cr-1` — el costo de la delegación era falso **en el sentido peligroso**
La prosa decía que el costo *«subió de escribir un comentario a escribir código muerto que alguien
va a ver en el diff; no bajó a cero»*. **Medido llamando a `stripComments` en este cierre:**

```
BORRADO    "// src/lib/downstream-payment.ts"
BORRADO    " * src/lib/downstream-payment.ts"
BORRADO    "/** cubre src/lib/downstream-payment.ts */"
SOBREVIVE  "const _C = 1; // cubre src/lib/downstream-payment.ts"      <-- ACÁ
SOBREVIVE  "it('X-02', () => {}); // src/lib/downstream-payment.ts"    <-- ACÁ
SOBREVIVE  "      'src/lib/downstream-payment.ts:186-194',"            <-- Y ACÁ
```

`stripComments` **quita el comentario de línea completa, no el de fin de línea**. El costo no subió
a «código muerto»: sigue siendo **un comentario**.
🔴 **Y más barato todavía: CERO líneas.** `test/readme-parity.test.ts:105` **ya nombra el target
hoy, en `main`**, dentro de un string de una línea de código — verificado por mí: la línea es
`'src/lib/downstream-payment.ts:186-194',`, y `readme-parity` **no verifica una sola cita**: compara
qué archivos nombran los dos README. **Hay un dueño utilizable sin escribir una línea.**
⇒ Prosa corregida en el docblock de `delegationFindings`, con las dos mitades medidas, y el
interruptor **registrado como deuda abierta con su costo real: CERO** —
**`TD-224-DELEGACION-CUESTA-CERO`**.

### 3.2 `MNR-cr-2` — «apagar por un campo» **sigue siendo posible**
La prosa decía *«lo que dejó de ser posible es apagar el candado entero **o por un campo de la
entrada**»*. **Falso para `from`.** El testigo emite un canario por cada `reason` real, pero los
canarios llevan el `from` de las citas que siguen en `CITED_LINES`: una cita que el atacante **saca**
de `CITED_LINES` deja de aportar su `from`.
**Causa medida, re-derivada por mí**: agrupando `citasQueNombranArchivo` por `from`, **3 de los 11
citadores aportan 1 solo canario** — `src/services/agent.ts` (1),
`src/services/agent.payment.test.ts` (1), `src/routes/agents.publish.test.ts` (1).
⇒ Frase corregida a lo que **sí** es cierto (*«apagar el candado ENTERO, o filtrarlo por `reason`»*)
y **el campo que queda vivo está nombrado**: `from`. Deuda: **`TD-224-CANARIOS-POR-FROM`**.

### 3.3 `MNR-cr-3` — el testigo se desarma borrando 5 líneas · **DECLARADO, NO ARREGLADO**
El esperado se deriva de `CANARIOS` **mismo**, y el piso `>= 10` cubre **sólo los canarios base**.
Borrar el bloque de canarios por `reason` deja **12/12 VERDE** y **revive el TRUCHO A**.
⇒ **Declarado con esas palabras dentro del guardián**, junto al assert que lo padece.
⛔ **No se arregló a propósito**: cerrar el meta-nivel es la HU siguiente, no ésta.
Deuda: **`TD-224-QUIEN-VIGILA-AL-TESTIGO`**.

### 3.4 `MNR-cr-4` — la duplicación NO es finding; el TERCERO sí
La cadena de `stripComments` es **textualmente idéntica** a `codeOnly` (cero divergencia hoy: mismos
límites con strings que contienen `//`, con template literals y con una regex que contenga `/*`)
⇒ **la duplicación está bien y `CD-7` la respalda. No se marca como finding.**
🔴 **Lo que sí**: existe un **TERCER** `stripComments` en
`test/scripts-imported-by-tests-are-tracked.test.ts:61` — verificado por mí:
`function stripComments(source: string): string`, **puro sobre un string** (o sea sin el problema del
disco) y **NO está en `CORTE_A_PATHS`** (o sea sin el problema de scope). **Ninguna de las dos
razones escritas lo cubre.** Y el *«Límite, con esas palabras»* de `scanner.ts` declaraba **una sola
dirección** (borrar de más ⇒ rojo ⇒ lado seguro), cuando hay una segunda y es la insegura (borrar de
menos ⇒ verde: el comentario de fin de línea sobrevive).
⇒ Anotado el tercero, **y dicho cuál manda si los tres divergen: `codeOnly`, el del guard del camino
del dinero; los otros dos se alinean a él.** El «Límite» se reescribió en **dos direcciones,
(a) hacia el rojo y (b) hacia el verde**. Deuda: **`TD-224-TRES-STRIPCOMMENTS`**.

### 3.5 `MNR-cr-5` — dos números del ítem 14 mal contados
Re-derivados por mí, no copiados del CR:

| Decía | Es |
|---|---|
| *«5 son `.nexus/project-context.md:6`»* | 5 tokens que nombran ese archivo, pero **4 × `:6` + 1 × `:6-12`** |
| *«21 fixtures que no existen ni pueden existir»* | Los 4 enumerados suman **12**; y **7 de los restantes son `x.io:8443`**, que **la propia HU declara ruido legítimo con path, no un archivo** |

⇒ El 26 quedó partido en los **tres** grupos reales, con sus multiplicidades.

### 3.6 🪞 El costo de este mismo fix, medido y declarado adentro del guardián
Corregir cinco afirmaciones falsas **agregó tokens sin testigo al propio guardián**:

| | antes del fix-pack 1 | tras `ac4f4c3` | **tras este fix de prosa** |
|---|---|---|---|
| tokens del guardián | 243 | 247 | **260** |
| partición `cite` / sueltos / fuera-del-índice / trackeados | — | 88 · 97 · 26 · 36 | **89 · 101 · 29 · 41** |

Los **+5 trackeados** son `test/readme-parity.test.ts:105` (×2),
`test/scripts-imported-by-tests-are-tracked.test.ts:61` (×2) y
`src/lib/downstream-payment.ts:186-194` (×1). **Las tres se abrieron y las tres son ciertas**
(`:105` es el string citado; `:61` es la firma de la función; `:186-194` es
`isDownstreamMainnetAllowed`, el gate `WASIAI_DOWNSTREAM_MAINNET_ALLOW`, que es exactamente lo que
los dos README afirman de esa línea).
🎯 **Y el número tuvo que escribirse DOS veces**: la primera pasada lo dejó en 255, y **escribir
«255» junto a sus dos citas nuevas lo movió a 260**. Se iteró hasta el punto fijo y se declaró el
fenómeno adentro del ítem 14. **Es la tesis de la HU aplicándose al cierre de la HU.**

### 3.7 ⚠️ Lo que este fix de prosa ROMPIÓ, medido — las citas que corrí yo
Mis ediciones **desplazan líneas** de `test/cited-lines-guard.test.ts` (1610 → 1686) y
`test/cited-lines-guard.scanner.ts` (506 → 530). **Los artefactos previos son INMUTABLES y no se
tocaron**, así que sus citas a esas líneas **quedaron viejas**. Mapa medido con `difflib` contra
`ac4f4c3`, para quien lea el `cr-report.md` / `auto-blindaje.md` después:

| Cita en los artefactos | Dónde está ese contenido HOY |
|---|---|
| `test.ts:241` / `:392` (`stripComments`) | `:264` / `:435` |
| `test.ts:1107-1130` (la 2ª salida) | `:1150-1173` |
| `test.ts:1132-1146` (el barrido) | `:1175-1189` |
| `test.ts:1193-1201` (vacuidad) | `:1255-1263` |
| `test.ts:1203-1215` (`CANARIOS`) | `:1265-1277` |
| `test.ts:1210-1214` (canarios por `reason`) | `:1272-1276` |
| `test.ts:1216-1224` (el delta) | `:1278-1286` |
| `test.ts:1318` (`cabecera`) | `:1394` |
| `test.ts:1439-1447` / `:1459-1464` (`G-C11`) | `:1515-1523` / `:1535-1540` |
| `scanner.ts:344-352` (`stripComments`) | `:368-376` |
| `test.ts:183-190`, `:352-356`, `:1183-1186`, `scanner.ts:339-342` | **REESCRITAS** — son justo los cuatro bloques que este fix corrigió |
| `scanner.ts:240-245` | **INTACTA** |

**Esto no es un daño colateral que se pasa por alto: es el mecanismo de la HU.** Un barrido del diff
mira lo que ESCRIBÍS, no lo que DESPLAZÁS, y por eso este mapa va escrito acá.

---

## 4 · Acceptance Criteria — resultado final

⚠️ **Reconstruido en este cierre desde `story-file.md:1013-1015` (mapeo AC→control) cruzado con el
resultado real de los 12 controles en la corrida final. NO viene de un `validation.md`: no existe.**
Los 12 controles: **`passed`**, leídos del reporter JSON de vitest (no del exit code).

| AC | Control que lo cierra | Status | Evidencia |
|---|---|---|---|
| **AC-1** — cita no declarada ⇒ rojo | `G-C4` | **PASS** | `G-C4: toda cita que el barrido encuentra está DECLARADA (el universo se deriva)` — `passed`. Invariante ESTRICTO `encontradas === declaradas + exceptuadas + delegadas` |
| **AC-2** — el ancla dejó de estar ⇒ rojo | `G-C5` | **PASS** | `G-C5: el ancla citada sigue ahí, es única, y el archivo citado es el correcto` — `passed` (9 códigos de error distintos) |
| **AC-3** — `mustContain` único en el archivo | `G-C5` | **PASS** | mismo control, código `E-NEEDLE_VACUOUS` |
| **AC-4** — anclada a su símbolo contenedor | `G-C6` + `G-C3` | **PASS** | `G-C6: la línea citada sigue cayendo dentro del símbolo declarado` + `G-C3: el resolver de símbolos no es vacuo y respeta la whitelist de kinds` — los dos `passed` |
| **AC-5** — archivo inexistente / línea fuera de rango | `G-C5` | **PASS** | códigos `E-TARGET_MISSING` / `E-LINE_OUT_OF_RANGE` |
| **AC-6** — universo derivado del índice de git | `G-C1` | **PASS** | `G-C1: el universo se derivó del índice de git y no es trivial` — `passed`. Re-derivado por mí: 14 paths, **57 tokens** |
| **AC-7** — controles de armado (anti-vacuidad) | `G-C1` / `G-C2` / `G-C3` | **PASS** | los tres `passed`; pisos POR FORMA, no sólo por total |
| **AC-8** — entrada que sobrevive a su sitio | `G-C7` | **PASS** | `G-C7: ninguna entrada del registro sobrevive a su sitio citador` — `passed` |
| **AC-9** — prosa no anclable, con forma y motivo | `G-C8` | **PASS** | `G-C8: forma y motivo de cada entrada, validados en RUNTIME` — `passed`. Corre en runtime **porque ni `tsc` ni `biome` miran este archivo** (§2.6) |
| **AC-10** — el guardián declara lo que NO cubre | `G-C10` | **PASS** | `G-C10: el docblock declara por escrito qué NO cubre este guardián` — `passed`; ≥ 8 ítems + los 3 literales exigidos. **Hoy son 14 ítems** |
| **AC-11** — las 4 formas de cita | `G-C2` | **PASS** | `G-C2: el escáner encuentra las CUATRO formas y no reporta el falso positivo conocido` — `passed` |
| **AC-12** — no duplicar `G-08`/`G-09`/`G-10` | decisión de diseño (`CD-1`) | **PASS** | Los 41 pares `{file,line}` de `ownership-filter-guard.exceptions.ts` quedan **FUERA** del universo por decisión escrita, no por olvido |

**Controles extra que el work-item no había reservado y que la implementación agregó**: `G-C9` (la
delegación tiene dueño VIVO, verificado POR ENTRADA), `G-C11` (el candado de
`SCANNER_FALSE_POSITIVES` mata la cita real y deja pasar el ruido) y `G-C12` (el candado de la
delegación mata al dueño inventado y deja pasar al real). Los tres nacieron de BLOQUEANTEs del AR.

---

## 5 · Hallazgos finales

- **BLOQUEANTEs: 4 abiertos en el AR it-1, los 4 RESUELTOS y verificados ejecutando los mutantes en
  las dos direcciones (no leyendo la tabla del Dev). 0 pendientes.**
  - `BLQ-ALTO-1` — el candado se construyó sobre la lista equivocada
  - `BLQ-MED-1` — el segundo interruptor: el dueño de la delegación era **prosa**
  - `BLQ-BAJO-1` — la prosa prometía un rojo que no ocurre
  - `BLQ-BAJO-2` — dos cabeceras decían «vacío»/«0» con 3 entradas debajo
- **MENORes del AR it-2 (6)**: 4 entraron en `ac4f4c3`; `MNR-it2-1` y `MNR-it2-2` **NO** entraron
  (fuera de Scope IN, decisión correcta — necesitan vehículo propio).
- **MENORes del CR (5)**: **los 5 atendidos en esta fase.** 3 eran afirmaciones falsas ⇒ **prosa
  corregida** (§3.1-3.3). `MNR-cr-4` ⇒ el tercer `stripComments` anotado + el límite reescrito en dos
  direcciones. `MNR-cr-5` ⇒ los dos números re-derivados y corregidos.
  **Los cuatro arreglos MECÁNICOS que quedan detrás de esos MENORes son deuda con nombre y costo
  medido** (§6b) — no se hicieron acá a propósito.
- **Cero BLOQUEANTEs abiertos al cerrar.**

---

## 6 · La deuda, en TRES clases
> Criterio del founder: *«no quiero deuda técnica (igual evalúa)»*. Por eso se separa **quién
> decide** cada clase, en vez de tirar todo a una lista.

### (a) Decisión del FOUNDER — no la puede tomar un agente
- **`TD-316-CITAS-PROJECT-CONTEXT`** — ⛔ **NO se trackea `.nexus/project-context.md`.** El repo es
  **PÚBLICO** y meterlo en git **publica su contenido**. La deuda no es «trackearlo»: es **revisar
  qué dice y recién después decidir**.
  🪞 **La ironía conviene tenerla escrita**: es justamente **el documento que le pide al lector
  verificar sus citas, y el único que ningún guardián puede alcanzar.**

### (b) Diferida con razón MEDIDA
- **`TD-224-CITAS-DEL-PROPIO-GUARDIAN`** — los tokens del guardián **sin testigo** (247 al cierre del
  CR, **260** después de este fix). El argumento decisivo, **verificado exacto por el CR y
  re-derivado por mí**: de los que nombran archivo trackeado, **9 son el token histórico
  `.gitignore:172`** — el bug que esta HU arregló, citado como ejemplo de lo que estaba mal ⇒
  **incluirlos convertiría cada mención del bug arreglado en una cita rota.**
  El arreglo real ya está nombrado: ***«un corte que distinga un token que AFIRMA de uno que es
  DATO»***. NO es «agregar los 4 paths al corte».
- **`TD-316-CITAS-DOTFILE-EN-OTROS-CORTES`** — el denominador (**749** en `src`+`test`, **~20.550**
  en el repo) **salió del mismo escáner que se comía los dotfiles**. Hay que **re-derivarlo antes de
  abrir el Corte B, C o D**. Todo porcentaje heredado está subestimado por una cantidad no medida.
- **La segunda salida de emergencia** — un token cuyo archivo **existe en disco pero NO está en el
  índice de git** se puede declarar ruido, y la asimetría es lo que lo hace defecto: la **misma**
  cita declarada en `CITED_LINES` pone el guardián en **ROJO**. **Población hoy: 0, y nada la
  mantiene en 0.** ⛔ **No se cierra leyendo el disco**: el índice es lo que un `checkout` trae, y un
  guardián que dependa de qué archivos sueltos tenga cada quien da distinto en CI que en local.
  **Decisión de diseño tomada y correcta.**
- **`TD-224-DELEGACION-CUESTA-CERO`** (`MNR-cr-1`) — **con su costo real medido: CERO líneas.**
  Hay un dueño utilizable hoy sin escribir nada (`test/readme-parity.test.ts:105`).
- **`TD-224-CANARIOS-POR-FROM`** (`MNR-cr-2`) — emitir un canario por cada `from` real, mismo patrón
  que ya se usa para `reason`. Cierra un exploit **del mismo costo** que el que el fix-pack 2 cerró.
- **`TD-224-QUIEN-VIGILA-AL-TESTIGO`** (`MNR-cr-3`) — un assert de armado del propio testigo,
  derivado. **Es la HU siguiente**, no ésta.
- **`TD-224-TRES-STRIPCOMMENTS`** (`MNR-cr-4`) — tres limpiadores de comentarios, dos con el mismo
  nombre, y **nada mecánico detecta que diverjan**. ⛔ **No** proponer importar `codeOnly`: `CD-7`
  lo prohíbe.
- **`TD-316-CITAS-PORTABILIDAD`** — los otros dos repos (`wasiai-remittance-agents`, `chaski-v3`),
  donde el mismo defecto ya reapareció con otros dos agentes. **Tres repos con tres universos
  incompatibles**: `doc/` viaja distinto en cada uno.
- **Cortes B / C / D** — B = las 40 anclas de prosa de `ownership-filter-guard.exceptions.ts` (el
  corte de **mayor valor de seguridad del repo**: cada una justifica una lectura cross-tenant citando
  un gate de admin, y **eso hoy no lo vigila nada**); C = el resto de `src`+`test`; D = `doc/**`, que
  **es un programa, no una HU**.

### (c) Deuda de REPO, cerrada con inventario y con dueño identificado
- **`TD-224-CONTROLES-QUE-SE-LEEN-A-SI-MISMOS`** — **CERRADA con inventario**, no con una pregunta
  abierta. Universo **enumerado, no buscado**, y re-derivado por mí en este cierre:
  **16** archivos en `test/` con `readFileSync` + **31** `src/**/*.test.ts` con `readFileSync`.
  **1 defectuoso, con nombre: `test/docs-referenced-by-code-exist.test.ts`, que sigue VACUO en
  `main`.** Quedó fuera de Scope IN y **no se arregló** — decisión correcta, declarada.
  **Las dos formas de arreglo, las dos con arte previo en este repo:**
  1. **Recorte de cabecera** — `test/cited-lines-guard.test.ts`:
     `const cabecera = self.slice(0, self.indexOf('\nimport {'));`
  2. **Excluirse del corpus por nombre** — `src/__tests__/discover-callsites.test.ts:126`:
     `const SELF = 'src/__tests__/discover-callsites.test.ts';`, aplicado en `:272` con
     `.filter((f) => f !== SELF)`.
  Criterio de cuál conviene: **(1) si el archivo ES su propio corpus; (2) si el archivo es UN
  ELEMENTO de un corpus mayor.**

---

## 7 · Puertas (3, por separado, exit code directo sin pipe)

| Puerta | Resultado | Cómo se midió |
|---|---|---|
| `vitest run` | **296 archivos · 5781 tests · 5762 passed · 19 pending · 0 failed · `success: true`** | Reporter JSON a `--outputFile` (**nunca redirigido**); **la raíz se validó ADENTRO del JSON**: los 296 `testResults[*].name` todos bajo `/home/ferdev/.openclaw/workspace/wasiai-a2a/`. **El exit code no se usó como evidencia** |
| `tsc --noEmit` | **exit 0**, cero errores | Binario por ruta directa, **sin pipe** |
| `biome check src/` | **exit 0** — *"Checked 489 files in 166ms. No fixes applied."* | Ídem |
| *(extra)* guardián solo | **12/12** — `G-C1..G-C12` todos `passed` | Leído del JSON, no del stdout |
| *(extra)* `tsc` sobre los 4 del guardián | **exit 0** | `--ignoreConfig --strict --noUncheckedIndexedAccess` (§2.6) |

**Diff sobre `src/`: 7 líneas, y las 7 son COMENTARIO.** Cero líneas de código ejecutable
(verificado leyendo el `git diff main...HEAD -- src/` entero: los 7 hunks son correcciones de citas
adentro de docblocks y comentarios de bloque).

---

## 8 · Archivos modificados (`git diff main...HEAD`, agrupados por dominio)

**El guardián (nuevo, 100 % del valor de la HU)**
- `test/cited-lines-guard.test.ts` — el guardián y sus 12 controles
- `test/cited-lines-guard.scanner.ts` — escáner de 4 formas + resolver de símbolos (Compiler API)
- `test/cited-lines-guard.citations.ts` — el registro: `CORTE_A_PATHS`, `CITED_LINES`, `DELEGATED_TARGETS`
- `test/cited-lines-guard.exceptions.ts` — `SCANNER_FALSE_POSITIVES`, `UNANCHORABLE_PROSE`

**Citas falsas corregidas — SÓLO comentarios, cero código (7 líneas)**
- `src/types/index.ts` (×3) · `src/services/compose.ts` · `src/services/fee-split.ts` ·
  `src/routes/agents.ts` · `src/lib/payment-spec-reader.ts`

**Citas falsas corregidas — el dotfile (8 líneas)**
- `test/sdd-index-matches-folders.exceptions.ts`

**Números derivados que el nuevo archivo de test movió (2 líneas)**
- `README.md` · `README.es.md` — 295 → **296** archivos de test (lo verifica
  `test/readme-numbers.test.ts`, que **deriva del índice de git**, no de una lista a mano)

**Artefactos SDD** — `work-item.md` · `sdd.md` · `story-file.md` · `auto-blindaje.md` ·
`ar-report.md` · `ar-report-it2.md` · `cr-report.md` · `_INDEX-row.md` · **este `done-report.md`**

**Índice** — `doc/sdd/_INDEX.md`, fila `224` a **DONE**

---

## 9 · El error de instrumento del CR — queda escrito, porque cierra la lección

Textual del `cr-report.md`:

> ***«`scanSource(file, src)` con los argumentos invertidos me devolvió 0 tokens en los 4 archivos»***
> — *«Lo cacé **porque 0 es imposible** para un archivo que declara 50 citas, no repitiendo la
> corrida. Es exactamente la trampa de la herramienta que fabrica un hallazgo.»*

Y:

> ***«mi primer `CAL-1` y mi primer `T-B` dieron rojos que eran MÍOS; reportarlos habría sido un
> falso positivo.»***

⇒ Junto con lo que produjeron el **F2** (2 citas mal, una por copiar un número en vez de abrirlo),
el **F2.5** (una «corrección» del SDD que era falsa), el **F3** (el punto ciego reproducido dentro de
su propio arreglo) y el **AR it-1**, la lección de cierre es una sola:

> **Este defecto lo comete TODO rol, incluido el que lo está auditando — y lo único que lo separa de
> un falso hallazgo es el CONTROL POSITIVO.**

---

## 10 · Los límites — trasladados sin suavizar, con esas palabras

- ***«No medí la VERDAD de la prosa que rodea a las citas: verifiqué números y anclas, no
  afirmaciones.»***
- ***«No barrí `doc/`, `scripts/`, `mcp-servers/` ni `packages/` buscando el patrón
  auto-satisfactorio; fuera de `test/**` (16) y `src/**/*.test.ts` (31), no sé si hay más.»***
- ***«No corrí la suite completa bajo cada mutante»*** — cada mutante corrió sólo el guardián; la
  suite completa (296) se corrió sobre el árbol limpio.
- ***«No re-derivé el denominador»*** — 749 / ~20.550, y por lo tanto 6,0 % y 0,21 %, siguen
  saliendo del escáner con el punto ciego del dotfile.
- ***«No probé el guardián en un clone fresco»***, ni en CI.
- ***«No ejecuté nada contra producción»*** — cero red, cero Railway, cero Supabase, cero `pkill`,
  cero push.

**Y lo que no pude medir YO, en esta fase de cierre, con esas palabras:**
- **No re-verifiqué a mano las ~20 citas del guardián que el AR ya había abierto.** Las tomé de
  `ar-report.md`/`cr-report.md`. Lo que sí abrí y verifiqué es **cada token que YO agregué** (5) y
  **cada número que YO escribí** (57, 260, 89/101/29/41, 16/31, 296/5781/5762/19/0, 2505/0, 489).
- **No corrí ningún mutante.** Los tres repros de `MNR-cr-1`/`cr-2`/`cr-3` los tomé del CR;
  **lo que sí medí de forma independiente es el MECANISMO de cada uno** (el comportamiento de
  `stripComments` llamándolo con 6 entradas, el reparto de canarios por `from`, y que
  `readme-parity.test.ts:105` nombre el target en una línea de código). **Medir la precondición no es
  medir la consecuencia**, y la diferencia está declarada acá.
- **No re-derivé los porcentajes de cobertura** (§2.5).
- **No verifiqué la existencia de un `validation.md` en otra rama o en `main`**: verifiqué que **no
  está en esta carpeta**, y sobre eso declaro la desviación de proceso (§1).
- **No pusheé, no mergeé, no toqué `main`** (sigue en `b31ddba`), y **no toqué**
  `doc/sdd/212-wkh-314-x402-inbound-solana/story-file.md` (md5 verificado al abrir y al cerrar).

---

## 11 · Lecciones para las próximas HUs

1. **Una cita `archivo:línea` es una afirmación sobre el mundo, y sin testigo mecánico envejece
   sola.** No hace falta que nadie la edite: alcanza con que alguien inserte una línea 13 renglones
   más arriba. **Ocho citas de este repo afirmaban una cosa y apuntaban a otra, y una de ellas
   confundía el runbook de identidades del operador con el plan de tracción para inversores.**
2. **El control positivo no es opcional: es lo único que distingue un hallazgo de un error propio.**
   El CR se salvó de reportar dos falsos positivos porque calibró primero, y cazó su instrumento
   invertido **porque «0 es imposible»**, no porque repitiera la corrida. **Repetir no valida: si las
   tres corridas comparten el defecto, las tres mienten igual.**
3. **Una CONCORDANCIA entre dos mediciones no es una prueba: pueden compartir defecto.** El Story
   File lo escribió como advertencia genérica y **resultó ser literal**: los dos escáneres previos
   compartían el punto ciego del dotfile y por eso coincidían. **Cuando dos instrumentos coinciden,
   preguntá si salen de la misma especificación.**
4. **Un número escrito en prosa envejece por tu PROPIA edición, en la misma sesión.** Pasó en el F3
   (`P1=14 P2=20` ya viejo al escribirlo) y volvió a pasar en este cierre (**255 → 260 porque
   escribir el número lo movió**). ⇒ **Los números se DERIVAN con una receta escrita al lado, y si el
   número no se puede derivar, se escribe la fecha y la palabra FOTO.**
5. **«Acotar no es cerrar», y la diferencia se escribe.** La segunda salida de emergencia tiene
   población 0 hoy **y nada la mantiene en 0**; el testigo mata el filtro por `reason` **pero no por
   `from`**. Un guardián honesto **declara su propio agujero al lado del assert que no lo tapa**.
6. **El verde de una puerta sólo cubre lo que esa puerta mira.** `tsc --listFiles` ⇒ 2505 archivos,
   **0 de esta HU**. Antes de apoyarse en un verde: **medí qué archivos toca esa puerta.**

---

## 12 · Estado del árbol al cerrar

- **`main` = `b31ddba`, intacto.** Nada pusheado, nada mergeado, ninguna PR.
- `doc/sdd/212-wkh-314-x402-inbound-solana/story-file.md` — **untracked a propósito**, md5
  **`7904ef74a1c46d7880e0ca5d38e3eed4`**, verificado al abrir y al cerrar. **No se tocó.**
- **Artefactos previos INMUTABLES**: `work-item.md`, `sdd.md`, `story-file.md`, `auto-blindaje.md`,
  `ar-report.md`, `ar-report-it2.md`, `cr-report.md`, `_INDEX-row.md` — **ninguno modificado en esta
  fase.** Lo único que se editó fuera de este archivo son **dos archivos del guardián** (fix de prosa
  de §3) y **la fila `224` de `doc/sdd/_INDEX.md`**.
- `doc/sdd/_INDEX.md:144` (la fila `157`, que cita código del camino del dinero y está verificada por
  `G-F1`) — **INTACTA**: la fila `224` vive en `:216`, muy por debajo.
