# Code Review · WKH-372 · ola W1 · `chaski-v3@2ad4698`

## VEREDICTO: **RECHAZADO** — 1 `BLQ-MEDIO`, 3 `BLQ-BAJO`, 4 `MNR`

Lente distinto al del AR (que ya cerró en 2 iteraciones): calidad, reuso, simplificación, y que el
código diga la verdad. ⚠️ Materializado por el ORQUESTADOR: el agente no puede escribir `.md`.

## Gate
`git add -A` → `npm run qa` **exit 0** (biome 301 archivos · **167 passed / 3422 tests**) → `npm run build` **exit 0**.
Sin flake en `vuelta-por-enlace-carrera.test.tsx` en 4 corridas completas.

## A · Los dos cierres del AR — CONFIRMADOS

| Mutante | Resultado | ¿Falso KILLED? |
|---|---|---|
| **MUT-L** `hayBorrador: rem !== null` → `false` | `× T-372-W1-1b` *"expected null to be '1'"* (`wallet-availability.test.tsx:1385`) | **No** — 1 solo `×` de 42; `T-LINK-1` verde |
| **MUT-M** ídem → `true` | `× T-372-W1-1` *"expected '1' to be null"* (`:1311`) | **No** — mismo criterio |

## HALLAZGOS

### 🟠 `BLQ-MEDIO-1` · El instrumento de campo se da vuelta con una recarga

`flow.tsx:146`, `:757`; `bitacora-de-vuelta.ts:170-175`.

`:757` declara la regla de lectura del entregable: *"si aparece, el almacenamiento no cruzó; si no
aparece y el borrador está, cruzó"*. **Es falsa ante una recarga de pestaña**, porque **nadie limpia
`wb` de la URL**: `hrefSinRastroDeVuelta` borra `PARAMS_DE_RESPUESTA` + `MARCA` y nada más. El
once-guard es por **carga de página**, no por aterrizaje.

**Reproducción (corrida, verde ⇒ el defecto existe)**:
1. `?wb=1`, disco `[]` ⇒ aviso presente, hito `con-marca-sin-borrador` *(el disco NO cruzó)*.
2. La persona re-tipea: `createRemittance` persiste (`create-remittance.ts:20`).
3. Recarga con `wb=1` todavía en la barra.
4. **Obtenido**: aviso ausente **y** hito `con-marca-y-borrador`.

**Impacto**: los dos instrumentos publican *"el almacenamiento cruzó"* sobre un borrador que la
persona re-cargó a mano. La medición de campo es la razón de ser de W1; un pull-to-refresh en el
teléfono la invierte en silencio.
**Sugerencia**: limpiar `wb` con `replaceState` después de leerlo (como el repo ya hace con `dl`), o
reescribir las dos frases para decir qué contestan y qué no.

### 🔴 `BLQ-BAJO-1` · "No pude leer el disco" colapsado en "no hay borrador"

`flow.tsx:146` — `catch { hayBorrador = false; }`. El mismo repo declara la disciplina contraria
(`bitacora-de-vuelta.ts:160-163`: *"colapsarlo sería convertir «no pude preguntar» en «no pasó»"*) y
ya tiene el tercer valor de primera clase (`MotivoParaNoMostrar = "disco-ilegible"`, `splash-puerta.ts:90`;
`"ILEGIBLE (no se pudo preguntar)"`, `diagnostico-de-vuelta.tsx:544/580`).

**Reproducción (corrida)**: `?wb=1`, el borrador **SÍ está**, y `getItem` tira `DOMException`.
**Obtenido**: aviso *"Acá no están los datos que cargaste antes"* **presente** y hito `con-marca-sin-borrador`.
**Impacto**: se le dice a la persona que sus datos no están **cuando sí están**.

### 🔴 `BLQ-BAJO-2` · I-5 es la única línea de producción de la ola sin ningún testigo

`flow.tsx:1386`. **MUT-CR-2** (corrido): revertir la línea a su texto pre-W1, o sea borrar las dos
cosas que I-5 pide (la advertencia *"Si al llegar no ves lo que cargaste, cargalo otra vez."* y el
segundo enlace `URL_INSTALAR_PHANTOM`) ⇒ **167 passed / 3422 passed**, gate entero verde.
El enlace gemelo de la oferta (`:757`) **sí** está medido; el de `NoWalletHere` no.
**Impacto**: por el criterio que la propia ola escribió, I-5 es hoy **decoración**. Y lo que se pierde
en silencio es justo el enlace que existe para no depender de la incógnita no verificada del fallback
de `browse`.

### 🔴 `BLQ-BAJO-3` · La enumeración de alcanzabilidad publicada es falsa en tres sub-afirmaciones

`wallet-availability.test.tsx:1326-1330`. El texto dice *"las **cuatro** entradas a `bienvenida`"* y
*"esa card es la **ÚNICA** que vuelve a un destino sin tocar la remesa"*.

1. **Falta una quinta**: `irADestino` (`flow.tsx:426-430`) hace `setStep(destino)` en `:429`, cableada
   a la pestaña "Enviar". **No toca `rem`.**
2. **"la ÚNICA" es falso ×2**: `openHistory` (`:412-417`) e `irADestino("recuperar")` tampoco tocan `rem`.
3. **El sub-motivo de `:807` es falso**: hay **dos** entradas a `send` — `resetTo` (`:3526-3533`, que sí
   limpia) y `Bienvenida onEmpezar` (`:1195`, **sin tocar `rem`**).

**Reproducción**: `/usr/bin/grep -n 'setStep("bienvenida")\|setStep(destino)\|setStep("send")' src/presentation/flow.tsx`
⇒ `:429 :587 :794 :807 :1186 :1195 :3533`.
**Impacto**: la conclusión no cambia (alcanzable, y por más caminos), pero es el **único registro
escrito** del análisis que cerró `AR-it2/BLQ-BAJO-2`, y F4 lo va a leer como exhaustivo.

### 🟡 `MNR-1` · El once-guard no lo mide nada, y su motivo escrito no aplica a su único llamador
`bitacora-de-vuelta.ts:177`. **MUT-CR-1**: borrar el `if (hitos.has(...)) return;` ⇒ gate verde.
Y el motivo del docblock es inalcanzable desde `flow.tsx:146`: `aterrizaje` es un valor **congelado**,
así que re-anotar escribiría el mismo valor. **Decisión correcta, motivo falso.**

### 🟡 `MNR-2` · `hayBorrador` nombra dos cantidades distintas dentro de la misma ola
`flow.tsx:757`/`:963` pasan `rem !== null` (**memoria**); `bitacora-de-vuelta.ts:176` recibe filas en
**disco**. La marca se escribe con una y se contrasta con la otra. Hoy coinciden porque
`createRemittance` persiste antes de devolver, pero nada lo ata: es la raíz de por qué `BLQ-MEDIO-1`
y `BLQ-BAJO-1` cuestan de ver leyendo.

### 🟡 `MNR-3` · Cita que no resuelve en el contrato normativo para F4
`story-W1.md:517` decía `wallet-availability.test.tsx:1476`, que es un **comentario dentro de
`T-372-W1-7`**; `T-372-W1-7c` está en **`:1573`**. Escrita por el orquestador y no re-derivada tras el
renombre de `MNR-A`.
✅ **CORREGIDA por el orquestador el 2026-08-31**, con la re-derivación escrita.
Las otras **19** citas nuevas muestreadas re-derivan exactas.

### 🟡 `MNR-4` · La justificación de escala no menciona el desborde de archivos
`auto-blindaje.md:381-383` contrasta 1569 contra `≤900` (1,74x, bajo el 2x) pero nunca dice que
**11 archivos > el `≤10`** declarado en `story-W1.md:764`.

## LO REVISADO SIN HALLAZGO

**Reuso — OK.** Nada se reimplementó: el detector de disponibilidad es el de siempre, el armado del
universal link **envuelve** `phantomBrowseUrl`, la limpieza **compone** `hrefSinRastroDeVuelta`, y
`PARAM_KYC` se **importa**. La única duplicación literal son 2 líneas de normalización, declarada en
su comentario. `src/test-support/salida-al-navegador.ts` tiene los dos consumidores que promete y
**desarma** el prefijo en vez de re-escribirlo.

**Escala — justificada** (con la reserva de `MNR-4`). Re-derivado: **1569 añadidas / 11 archivos**,
coincide exacto con la tabla. `flow.tsx` 4453 ✓, `numstat 9/9` ⇒ Δ0 real ✓.
A la pregunta que decide: las **768 líneas** de `recorrido-en-el-navegador-de-la-billetera.test.tsx`
(49 % de la ola) son W1.0, la premisa falsable corrida **antes** de una línea de producción, y son la
razón por la que producción son **6 líneas reescritas** en vez de un recorrido nuevo. Eso lo
escribiría igual alguien que ya conoce el repo. Sin refactor oportunista, sin un archivo fuera de Scope IN.

**Naming — OK** salvo `MNR-2`. **Contrato — CUMPLE**: la enmienda de `story-W1.md:501` está
implementada (cuatro condiciones, consume la foto, vigilada por `T-372-W1-7c`).

**Docblocks — un solo hallazgo.** El número con testigo re-deriva: `curl` hoy da
`phantom.com/download → 200` y `phantom.app/download → 301`.

## ORDEN DEL FIX-PACK
1. `BLQ-MEDIO-1` (bloquea la utilidad de W2) → 2. `BLQ-BAJO-1` (misma familia) →
3. `BLQ-BAJO-2` → 4. `BLQ-BAJO-3` → 5. los `MNR`.

*CR · WKH-372 ola W1 · 2026-08-31 · `chaski-v3@2ad4698` · árbol restaurado y verificado por md5
contra `git show HEAD:`.*
