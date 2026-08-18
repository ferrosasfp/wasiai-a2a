# Report — HU [WKH-360] / 223 · El coordinador es un agente

> Producto de `nexus-docs` (cierre del pipeline), 2026-08-17.
> **HEAD reportado** `a7c2ce9` · **rama** `feat/223-wkh-360-coordinador-agente` · **base** `3823580`.
> ⛔ Este documento **no modificó una línea de código** ni ninguno de los artefactos previos: son
> inmutables. Lo único que se escribió acá es este archivo y la fila `223` de `doc/sdd/_INDEX.md`.
>
> **Disciplina de números.** Ningún número de este reporte se copió de otro artefacto: los de la
> tabla de §5 se **re-derivaron en esta sesión**, con el comando y el commit en la misma línea. Lo
> que no medí dice de quién lo tomo. Lo que sigue abierto está en §7 **sin suavizar**.

---

## 1 · Resumen ejecutivo

El coordinador publica su carta con **precio, esquema de pago y endpoint por skill**, y **puede ser
contratado como un agente más sin poder contratarse a sí mismo**: eso es lo que vuelve verdad
completa la frase del deck (*"cualquier plataforma puede contratar el pipeline completo como un solo
agente, con una sola solicitud"*). El guard anti-bucle **corta antes del débito en tres sitios
distintos** —cada uno antes de un débito distinto— y hay un cuarto, declarado en el código como
**NO guard de dinero** (CD-17). **F4 aprobó con 12/12 ACs con evidencia `archivo:línea`.**

Archivos clave: `src/lib/contracting-chain.ts` (módulo leaf de identidad y cadena),
`src/middleware/contracting-guard.ts` (Capa 2 inbound), `src/routes/compose.ts` +
`src/services/compose.ts` + `src/services/orchestrate.ts` (los cuatro sitios de Capa 1 y el fee en
cascada), `src/services/agent-card.ts` (la carta), `src/lib/contracting-chain.test.ts:1140`
(`T-HINT-CALLSITES`, el candado que enumera call-sites).

**Status: DONE, con residuales declarados (§7) y dos pasos obligatorios de deploy (§8).**

---

## 2 · Pipeline ejecutado

| Fase | Qué pasó | Artefacto |
|---|---|---|
| **F0/F1** | `nexus-analyst`. Tres huecos medidos: la carta no dice cómo contratarla, **no existe guard anti-bucle** (el único control de destino mira rangos de IP), el fee en cascada es invisible. Gate **HU_APPROVED** (clínico) el 2026-08-17 | `work-item.md` (12 AC EARS · 8 DT · 10 CD) |
| **F2** | `nexus-architect`. Gate **SPEC_APPROVED** (clínico) el 2026-08-17 | `sdd.md` |
| **F2.5** | Story File. **13 divergencias medidas SDD↔árbol**, y las tres primeras eran bloqueantes de compilación o de veredicto: el SDD decía "TRES sitios" y son **CUATRO** (se contradecía a sí mismo); **tres mocks tipados rompían `tsc`** al extender `resolveAgentDestination`; `/health` estaba **duplicado** (prod + e2e) y el campo nuevo tenía que ir en los dos. Ningún AC ni CD se ablandó | `story-file.md` |
| **F3** | `nexus-dev`, **6 waves** (W0..W5), un commit por wave. Batería propia de **18 mutantes, 18 muertos**, con dos calibraciones previas (`CAL-MUERE` / `CAL-VIVE`) para probar que el instrumento distingue | `implementation-log.md`, `auto-blindaje.md` |
| **AR** | 🔴 **RECHAZADO** — 3 `BLQ-MED` + 3 `BLQ-BAJO` + 6 `MNR` | `ar-report.md` |
| **CR** | 🔴 **RECHAZADO** — 1 `BLQ-MED` + 3 `BLQ-BAJO` + 6 `MNR`. **Los dos coincidieron solos en el bloqueante principal**: el CR no leyó el reporte del AR y llegó al mismo hallazgo (el guard quedaba INERTE sin config en 3 de los 4 sitios) con una reproducción ejecutable propia | `cr-report.md` |
| **fix-pack 1** | 6 grupos, un commit por grupo (`84051dd`, `8157f32`, `f7661e1`, `72ae303`, `8b1d07a`, `d9a8cbb`) | — |
| **re-AR (it2)** | 🔴 **RECHAZADO** — 2 `BLQ-MED` + 2 `BLQ-BAJO` + 6 `MNR`. Los 6 cierres declarados estaban cerrados (verificados por mutación; uno dio **más** cobertura que la declarada), y lo que bloqueó fue **lo que el fix-pack dejó fuera de su propia lista de residuales** | `ar-report-it2.md` |
| **fix-pack 2** | 7 commits (`6d043f8` → `a7c2ce9`) | — |
| **F4** | 🟢 **APROBADO** — 12/12 ACs con evidencia, sin scope drift, sin wave drift, sin `.sql`, sin queries nuevas. 4 mutantes re-corridos por QA, **4 de 4 con el resultado esperado** | `f4-report.md` |
| **DONE** | Este reporte + fila `223` de `_INDEX.md` | `report.md` |

Los dos gates humanos ocurrieron; el tramo F2.5 → F3 → AR → CR → F4 → DONE corrió sin gates, como
manda el proceso.

---

## 3 · Las cuatro cosas del entregable que no se pueden perder

### 3.1 · El corazón no es que el guard exista: es que **corte ANTES del débito**

Y son **tres sitios distintos, cada uno antes de un débito distinto**, por eso ninguno reemplaza a
otro. El F4 lo verificó **por posición en la lista de manejadores y por número de línea contra el
consumidor de plata**, no leyendo comentarios:

| Sitio | Guard | El débito que corta | ¿Antes? |
|---|---|---|---|
| **1** · `src/routes/compose.ts` | `:767` (dentro de `resolveComposePriceHandler`, preHandler `:930`) | el middleware `requirePaymentOrA2AKey`, preHandler `:931` | ✅ **posición 930 < 931** |
| **2** · `src/services/orchestrate.ts` | `:1198` | `budgetService.debit` en `:1295` | ✅ |
| **3** · `src/services/compose.ts` | `:443` | `budgetService.debit` en `:627`; `signAndSettleDownstream` en `:1785` | ✅ |
| **4** · `src/services/compose.ts` (`invokeAgent`) | `:1703` | **corre DESPUÉS del débito del step** | ⛔ **NO es guard de dinero** |

El Sitio 4 está declarado como tal en el propio código (`compose.ts:1681`,
`⛔ ESTE NO ES EL GUARD DE DINERO (CD-17)`), en el `describe` de su test y en el mensaje del commit
`879faa7`. **CD-17 prohíbe presentarlo como guard de dinero en cualquier superficie**, y el F4 barrió
`src/`, `doc/`, `.env.example` y los 19 mensajes de commit: **cero textos lo presentan así; los que
lo nombran, lo niegan.** Su nivel de log (`log.error`, el logger **del módulo**, que un caller no
puede tragarse) tiene testigo: mutarlo a `log.warn` mata `T-L1-7` **y sólo a él**.

Y el orden no se sostiene por prosa: los tres mutantes de movimiento (`MUT-01/02/03`) mueren por
**conteo de débitos**, no por status. Bajo `MUT-02` **el endpoint sigue devolviendo 400** ⇒ un test
de status habría sobrevivido. Lo midió el CR con un mutante propio (`MUT-02b`) escrito para adjudicar
exactamente esa sub-afirmación.

### 3.2 · El test que vale más que el arreglo: `T-HINT-CALLSITES`

El fix-pack final **no entregó sólo el hint que faltaba**. Entregó
`src/lib/contracting-chain.test.ts:1140`: escanea `src/` (sin tests ni `.d.ts`), quita comentarios,
y para cada `orchestrateService.orchestrate(` / `.executeApprovedPlan(` / `this.executeApprovedPlan(`
/ `composeService.compose(` verifica que los argumentos incluyan `selfHostHint`. Tres excepciones
**escritas una por una** (`:1063-1075`), controles anti-vacuidad, y **no se puede pudrir hacia el
otro lado** (una excepción que sobra también lo rompe, `:1173`).

**Por qué nació**: una frase declaraba cubierto el residual —"los que quedan sin hint son alias
propios, callers no-HTTP y el `canonicalId`"— **y esa enumeración estaba incompleta en cinco
superficies a la vez**. Había un **tercer caller, que entra por HTTP, es público**
(`POST /agents/links/:token/redeem`, comentado en el propio código como *"público, auth por posesión
del token"*) **y gasta plata de un tercero**: el plan usa `billingKeyRow: ownerKey`, así que el bucle
**lo paga quien emitió el link** mientras el caller es anónimo. Reproducía byte por byte el escenario
que otro test congelaba como cerrado.

Los dos mutantes de F4 sobre el candado **MATAN**: borrar el spread en `services/agent-link.ts:396`
(con `tsc` = 0 post-mutante, o sea que el veredicto vale) y crear un archivo de producción nuevo con
un `composeService.compose(` sin hint. **Una frase no evita la séptima recurrencia; un test que
enumera, sí.**

### 3.3 · El instrumento de verificación podía mentir

`canonicalizeHost` corría el chequeo de vacío **antes** del strip del punto final, así que el paso 7
fabricaba el vacío que el paso 6 existía para rechazar: `'.'`, `'。'` (punto ideográfico U+3002) y
`'%2e'` devolvían **cadena vacía**. Con `A2A_SELF_HOSTS=.` el estado quedaba `configured`, **sin
warn**, y `GET /health` publicaba `{"selfHostCount":1,"depthMax":2,"source":"env"}` —
**byte-idéntico al de un deploy correcto**— con el guard **inerte**.

El operador seguía el procedimiento que el propio `.env.example` designa como verificación
post-deploy, veía la señal de éxito, y el guard no existía. **El instrumento que NC-1 nombra como
único era el que mentía.** Segundo efecto: el guard de CD-18 compara `=== null`, no falsy, así que
con `canonicalId === ''` **emitíamos** una cadena que este mismo repo rechaza con
`CONTRACTING_CHAIN_MALFORMED`. Corregido en el fix-pack 2 (el vacío se chequea **después** del
strip ⇒ esas entradas caen en `invalid` y el arranque tira). Testigos: `T-U-HOST-8`, `T-ENV-5`.

### 3.4 · Encender el guard destapó cinco tests de facturación que nunca habían ejecutado ese bloque

Al propagar el `Host` entrante como `hint`, la suite pasó de `5598 passed | exit 0` a **5 rojos**, y
los cinco eran ajenos a esta HU: `services/orchestrate.quote-billing.test.ts`, los tests de que se
cobra el precio **congelado**, todos con 500 en vez de 200. La causa era un `vi.mock` **sin
`importOriginal`** que dejaba `resolveAgentDestination` en `undefined`; mientras el guard no corría
en ese harness, nadie lo notaba.

**Se arreglaron cargando el módulo real (`importOriginal`), no bajando el guard.** El rojo era la
evidencia de que el fix funcionaba: ese bloque nunca se había ejecutado en el camino de
`/orchestrate/execute` de ese harness. Un "arreglo" que devolviera el guard a su estado inerte habría
puesto la suite en verde y el agujero de vuelta.

---

## 4 · Acceptance Criteria — resultado final

**12 de 12 PASS** (veredicto del `f4-report.md`, evidencia `archivo:línea` medida en `a7c2ce9`).

| AC | Qué exige | Status | Evidencia (resumen; el detalle completo está en `f4-report.md §1`) |
|---|---|---|---|
| **AC-1** | La carta declara precio (o cómo obtenerlo), esquema de auth/pago y endpoint por skill; sigue gratis y sin rate-limit | ✅ PASS | `src/services/agent-card.ts:290-330` (`endpoint:{method,path}` + `pricing.model:'protocol-fee-on-executed-cost'` + `quoteEndpoint:'/orchestrate/plan'`); `authentication.schemes: ctx.schemes` (antes `[]`); `src/routes/well-known.ts:11` sigue con `config: { rateLimit: false }`; `T-CARD-1`, `T-CARD-2` |
| **AC-2** | Una sola función (`buildSelfAgentCard`); `/capabilities` sigue derivando de ella | ✅ PASS | `src/routes/capabilities.ts:33` = mismo call que `src/routes/well-known.ts:14`; el contexto nuevo sale de **un** helper (`agent-card.ts:224-238`); `T-CARD-4`; `T-CARD-3` **deriva** los prefijos de `src/index.ts` y asserta que la derivación no vino vacía |
| **AC-3** | Dato no resoluble ⇒ **omitir** el campo, nunca `0`/`null`/placeholder | ✅ PASS | `agent-card.ts:230` — `x402` **desaparece** del array, no sale `x402:false`; sin `priceUsdc` por skill, con el motivo en el docblock `:262-272`; `T-CARD-5` |
| **AC-4** | Bucle DIRECTO: rechazo antes del débito y antes del settle, con `errorCode` propio, sin emitir el fetch | ✅ PASS | Los cuatro sitios de §3.1; testigos **de orden, no de status**: `T-L1-1`, `T-L1-2`, `T-L1-2b`, `T-L1-3`, `T-L1-7` |
| **AC-5** | Traza entrante que ya nos contiene ⇒ mismo `errorCode`, antes de cobrar | ✅ PASS | `contractingGuardHandler` es el **primer** preHandler de las 4 cadenas (`routes/compose.ts:909` antes de `:931`; `routes/orchestrate.ts:145`, `:325`, `:555`); `T-L2-1`, `T-L2-3`, `T-CHAIN-5` (header repetido para esconder nuestro eslabón), `T-L2-1-ORDEN` («400 y CERO llamadas a debit») |
| **AC-6** | Profundidad ≥ techo ⇒ rechazo antes de cobrar; techo ausente/ilegible ⇒ default del código, jamás "sin techo" | ✅ PASS | Medido en runtime por QA: sin env ⇒ `2`; `'0'`,`'00'`,`' 0 '`,`'65'`,`'-1'`,`'abc'`,`'1O'` ⇒ **`2` en los siete** (nunca `0`, nunca `Infinity`); `'007'` ⇒ `7`. `T-DEPTH-1..6`, `T-DEPTH-1-ORDEN` |
| **AC-7** | El invoke outbound emite la cadena y la profundidad incrementada | ✅ PASS | `src/services/compose.ts:1567-1589` — los dos headers **antes** del spread de credenciales (CD-4), y sin `canonicalId` **no se emite ninguno** (CD-18) + warn; `T-PROP-1/1b/2/3/3b/4/5` |
| **AC-8** | El caso legítimo intacto: mismo status, body, cobro y cantidad de settles | ✅ PASS | `T-L1+1/2/3` («los DOS hosts REALES de prod pasan — el guard rechaza 0 de 25»), `T-L1+5` («5 steps ajenos → 200, 4 débitos, 5 emisiones»), `T-L2+1/2` («SIN ninguno de los dos headers → PASA — el 100% del tráfico de hoy»), `T-FEE-7`; y las 286 suites preexistentes siguen verdes |
| **AC-9** | Capa 1 **sin** cooperación; la cooperación es necesaria **sólo** para el transitivo, y queda escrito en el código y en la respuesta de error | ✅ PASS | `T-L1-6` («SIN ningún header, el destino propio se rechaza igual»); la limitación sale de **una sola constante** (`contracting-chain.ts:187-192`) consumida por el body del error, por la Agent Card y por el test ⇒ emisor y test no pueden divergir; `T-FLAG-1`: **ninguna env nueva gatea el corte** (CD-1) |
| **AC-10** | El 200 de `/compose` declara el fee de protocolo de este gateway, de forma aditiva | ✅ PASS | `routes/compose.ts:1270-1277`; `T-FEE-8` (monto sí, **hash del fee nunca**), `T-FEE-2wkh`, `T-FEE-3wkh` (`failed` ⇒ `'unknown'`, no `'not_charged'`) |
| **AC-11** | El fee de un sub-coordinador va por separado; si no lo declara ⇒ **no declarado**, jamás `0` | ✅ PASS | `contracting-chain.ts:1092-1124` `rollUpCascadedFee`; `T-U-FEE-3/5/7`, `T-U-ROLL-3..7` (redondeo a 0, no finita y negativa ⇒ se **omiten**), `T-FEE-4`, `T-FEE-5` |
| **AC-12** | Estrictamente aditivo | ✅ PASS | `routes/compose.ts:1270-1277` — ninguna clave previa se quita ni cambia de valor; `POST /orchestrate/plan` **no ganó** campo de cascada (Scope OUT respetado). ⚠️ Tensión ya juzgada: el 200 gana **2 claves incondicionales**, así que ningún response es byte-idéntico; AC-12 pide **aditivo**, no byte-idéntico |

---

## 5 · Gates re-derivados en esta sesión (no heredados)

Los volví a correr porque el reporte de cierre es el último documento antes de que esto entre a
`main`, **que es producción (Railway)**.

| Gate | Comando | Medido | Dónde |
|---|---|---|---|
| Suite completa | `node ./node_modules/vitest/vitest.mjs run` | `Test Files 286 passed \| 6 skipped (292)` · `Tests 5624 passed \| 19 skipped (5643)` · **exit 0** | en **`a7c2ce9`** (worktree `wt-360`) |
| Suite baseline | idem | `Test Files 280 passed \| 6 skipped (286)` · `Tests 5441 passed \| 19 skipped (5460)` · **exit 0** | en **`3823580`** (worktree detached `/tmp/cr360base`) |
| **Δ neto** | resta de las dos filas de arriba | **+183 tests · +6 archivos de test** | derivado de `a7c2ce9` − `3823580` |
| Typecheck | `./node_modules/.bin/tsc --noEmit` | **exit 0** | en `a7c2ce9` |
| Lint | `npm run lint` (⛔ **no** `npx biome check`, que da falso rojo) | **exit 0** · `Checked 485 files` | en `a7c2ce9` |
| Ownership guard | `vitest run test/ownership-filter-guard.test.ts` | **13 passed (13)** | en `a7c2ce9` |
| Migraciones / RPC | `git diff --name-only 3823580..a7c2ce9` ⇒ `.sql` = 0, `migrations` = 0; cero `supabase.from(` / `.rpc(` nuevos | **N/A medido** (DT-7 respetado; el régimen de `deriveTables()` no se activa) | en `a7c2ce9` |
| Commits de la HU | `/usr/bin/git rev-list --count 3823580..a7c2ce9` | **19** | en `a7c2ce9` |
| Archivos tocados | `/usr/bin/git diff --name-only 3823580..a7c2ce9 \| /usr/bin/wc -l` | **37** | en `a7c2ce9` |

> ⚠️ **Instrumento que mintió en esta sesión, y por eso queda escrito.** El mismo comando de la
> última fila corrido **sin** `/usr/bin/` (o sea con `git` y `wc` interceptados por `rtk`) devolvió
> **40** mientras imprimía **37** rutas: el conteo y el listado del mismo comando no coincidían. Es
> la lección `rtk-proxy-corrupts-redirected-output` del expediente del repo. **Todo conteo de este
> reporte se derivó con `/usr/bin/git` y `/usr/bin/wc`.**

---

## 6 · Hallazgos — de dónde vino cada uno y dónde terminó

**BLOQUEANTEs: 9 distintos, 9 resueltos, 0 pendientes.**

| # | Bloqueante | Origen | Cómo cerró |
|---|---|---|---|
| 1 | El guard quedaba **INERTE por default** en 3 de los 4 sitios, y la prosa decía lo contrario en 4 superficies operativas | **AR/BLQ-MED-1 y CR/BLQ-MED-1, encontrados por separado y coincidentes** | el `Host` entrante viaja como `selfHostHint` a los 4 sitios + las frases calificadas (`f7661e1`); testigos `T-L1-2c`, `T-L1-3c`, `T-L1+10`, `T-ROUTE-HINT`, y **cada call-site con testigo propio** (calibrado por el re-AR) |
| 2 | `readCoordinatorFee` **tiraba `TypeError`** sobre un 200 con body escalar, **después del débito** ⇒ el caller quedaba cobrado por un step que ahora fallaba | AR/BLQ-MED-2 | `unknown` + guard de tipo (`84051dd`); `T-U-FEE-5` (el `TypeError` literal) y `T-FEE-7`, que mide el enunciado exacto de AC-8: **cobrado y fallado**, con `debit` en 1 |
| 3 | `A2A_CONTRACTING_DEPTH_MAX=0` **apagaba el money-path**, era legible y no avisaba | AR/BLQ-MED-3 (⚠️ el CR lo había **ratificado**; prevaleció el AR por decisión del orquestador) | rango `[1,64]`, `0` cae al default **y avisa** (`8157f32`); `T-U-MAX-6` |
| 4 | El **tercer caller HTTP público** sin hint, que gasta plata del emisor del link | AR-it2/BLQ-MED-1 | cableado + **`T-HINT-CALLSITES`** (§3.2), `6d043f8` |
| 5 | Sin envs el caller **no agranda el conjunto: lo DEFINE, y puede vaciarlo** ⇒ la monotonía era cierta como enunciado y **vacía como garantía** | AR-it2/BLQ-MED-2 | frases calificadas con *"SOLO CONTRA UN CALLER HONESTO"* en el warn de arranque, el residual medido y escrito, y `T-L1-2e` (el gemelo **sin** la env) junto a `T-L1-2d` (`9bca3d6`) |
| 6 | `canonicalizeHost` devolvía `''` y `/health` lo reportaba como identidad **configurada** | AR-it2/BLQ-BAJO-1 | §3.3 (`9d10260`) |
| 7 | El "avisa" del techo **no tenía ningún testigo** (borrar el bloque entero dejaba la suite en verde) | AR-it2/BLQ-BAJO-2 | `T-ENV-2` con su mutante calibrado (`c1989a1`) |
| 8 | El campo `contractingGuard` de `/health` **no lo verificaba ningún test**, en ninguno de los dos handlers — y NC-1 lo designa como **el único instrumento** post-deploy | CR/BLQ-BAJO-2 | `T-HEALTH-CONTRACTING` + `T-HEALTH-BOTH` (`8b1d07a`); el re-AR midió **3 rojos donde el fix declaraba 2**, o sea más cobertura que la declarada |
| 9 | El rollup **fabricaba un `0`** con status `complete` y podía publicar `null` (CD-5) | AR/BLQ-BAJO-1 | `72ae303`; `T-U-ROLL-5`, `T-U-ROLL-6` |
| — | Dos bloqueantes documentales: el mapa de citas mal en 3 de 5 filas (**+11 sistemático**) y `sdd.md` / `story-file.md` **fuera de git** | AR/BLQ-BAJO-2 y AR/BLQ-BAJO-3 + CR/MNR-6 | el mapa se cambió por **anclas textuales** (un número de línea en un `.md` envejece con cada edición) y los dos documentos los commiteó el orquestador (verificado con `git ls-tree`) |

**MENORes**: 18 levantados entre AR (6), CR (6) y AR-it2 (6); **12 cerrados en el fix-pack 2**
(`6a6461e` cierra seis de una), y quedan los **3 MENORes de documentación del F4** (§9), ninguno
bloqueante y ninguno con efecto sobre el comportamiento.

⚠️ **Un menor no puede aparecer como "cerrado con testigo": MNR-6** (dos factories amputadas de
`agent-price.js`). El arreglo es **profiláctico y está declarado como tal**: hoy ninguna ruta de esos
dos archivos alcanza esa export, así que **su mutante sobrevive por construcción** — el dev lo midió
(`65 passed, 0 fail` al quitarlo) en vez de suponerlo, y el F4 lo re-midió y obtuvo **lo mismo byte
por byte**. Contabilizado como **arreglo preventivo SIN testigo**.

---

## 7 · Lo que queda ABIERTO — sin suavizar

⛔ **Ninguna de estas líneas puede leerse como cerrada, ni acá ni en ningún otro texto de la HU.**

1. **El bucle transitivo contra quien borre los headers sigue abierto por construcción.** La Capa 2
   es **best-effort**, y eso está declarado en el código (`contracting-chain.ts:149-153`), en el
   **body del error** y en la **Agent Card** (`agent-card.ts:325`), todo desde **una sola constante**
   (`CONTRACTING_LAYER2_BEST_EFFORT_NOTE`). ⛔ **PROHIBIDO escribir que está cerrado**; la frase
   prohibida (*"bucle transitivo cerrado" a secas*) está enumerada como tal en el doc de decisiones.
   Lo que queda en pie contra ese caso es la Capa 1 (que **no consulta ningún header del caller**) y
   el techo de profundidad.
2. **La IP literal (R-3 / TD-360-2) no la cierra la comparación por nombre.** Medido:
   `isSelfDestination('https://69.46.46.64/x', ['gw.example.com'])` ⇒ `false`. Está escrito en el
   código (`:154-158`, `:312-313`: *"Que un operador PUEDA declarar un literal no significa que el
   bypass esté cerrado"*), en `.env.example` y en un test (`T-U-HOST-6`).
3. **NO hay drenaje en curso hoy — y tampoco lo contrario.** Lo medido es que **el guard no existía**
   y que la ruta al bucle estaba abierta. **Lo que frena hoy el caso directo es accidental** (el
   bearer sólo se reenvía a registries `system`), **no un guard**. ⛔ Prohibido afirmar en cualquiera
   de las dos direcciones: ni "hay drenaje", ni "no puede pasar".
4. **El conjunto de identidad vacío a pedido del caller sigue abierto.** Sin las dos envs, `hosts` es
   literalmente `[canonicalizeHost(hint)]`, así que un `Host` ilegible (`'a b'`, `'http://x'`,
   `'::1'`, `''`) lo deja en **cero** y el guard queda **inerte a pedido**. **Lo cierra setear
   `A2A_SELF_HOSTS`, que es paso obligatorio del deploy, no un commit.** El warn de arranque ya lo
   dice textualmente: *"Lo que SIGUE cubierto, y **SOLO CONTRA UN CALLER HONESTO**: el bucle
   ACCIDENTAL directo por HTTP…"*. ⛔ La conclusión **no es revertir el hint**: sin él ese mismo
   deploy queda inerte **siempre**, no sólo bajo ataque.
5. 🔴 **R-4 es la topología de HOY, no un riesgo teórico.** **22 de los 25 agentes descubribles en
   prod viven en `wasiai-v2`**, que **nos llama** y **no reenvía** los headers nuevos ⇒ **la Capa 2
   nace con cobertura efectiva ~0 en el camino real**. No es un adversario: es cómo está armado el
   ecosistema hoy, y **nada de esto se arregla desde este repo**. ⛔ Prohibido escribir que la Capa 2
   "cubre" el ecosistema, y prohibido llamar a R-4 "riesgo teórico". **HU de seguimiento en el OTRO
   repo** (`wasiai-v2`), con criterio de aceptación medible ya escrito — ver §10.
6. **NC-1 y NC-2 se resuelven POST-DEPLOY, no antes.** No se pudo verificar si `BASE_URL` y
   `TRUST_PROXY` están seteadas en el Railway de prod, y **es indecidible desde afuera** (la `url` de
   la carta es idéntica bajo las dos lecturas). El instrumento es
   **`GET /health` → `contractingGuard.selfHostCount` / `source`**, que ahora **tiene testigo**
   (`T-HEALTH-CONTRACTING`, `T-HEALTH-BOTH`) y **ya no miente** (§3.3). NC-2 subió de categoría en el
   camino: con `trustProxy` activo el `hint` entra además por `X-Forwarded-Host`, así que esa env es
   parte de la **superficie de ataque** del guard y no sólo del rate-limit.
7. **MNR-6 es profiláctico y está declarado como tal** (su mutante sobrevive por construcción). ⛔ **No
   puede aparecer como "cerrado con testigo"** en ningún resumen. Ver §6.
8. **Dos citas rotas del carril Solana: ajenas y pre-existentes.**
   `src/adapters/solana/facilitator-settle.wiring.test.ts:14` y `:93-94` citan `src/index.ts:246-248`
   y `:338`/`:345`. El F4 lo midió en **tres shas** y **ya no matcheaban en el baseline `3823580`**,
   antes de que esta HU tocara nada. **No se cuentan contra WKH-360.** Esta HU **ensanchó** el desfase
   (a ~74 y ~103 líneas) sin haberlo creado, y queda **reportado** para el carril Solana.

Residuales adicionales que el expediente ya declara y este cierre no toca: **TD-360-1** (allow-list de
auto-contratación legítima: hoy no existe ningún caso — 0 de 25 agentes de prod apuntan al gateway —
y si entra, entra **vacía por default = denegar**), **NC-6** (la prosa de
`self-published-auth.ts:82`, fuera de scope y **confirmada no arreglada**, que es lo correcto) y
**WKH-SEC-02 / TD-SEC-01** (RLS a nivel Postgres, explícitamente fuera de scope).

---

## 8 · Smoke manual post-merge (lo escribió el F4; **no se ejecutó**)

Seis pasos, para el operador. **El paso 5 es el que importa.**

1. Setear `A2A_SELF_HOSTS=<host de Railway>,<dominio propio>` (hostnames **pelados**: sin esquema,
   sin puerto, sin path, sin repetir). ⚠️ Un valor ilegible **no bootea** — es a propósito.
2. Desplegar y leer el log de arranque: tiene que decir `guard anti-bucle con identidad configurada`.
   Si dice `SIN identidad configurada`, la env no llegó.
3. `curl -s https://<gw>/health | jq .contractingGuard` ⇒
   `{"selfHostCount": >0, "depthMax": 2, "source": "env"}`. Con `"source":"request-only"` el guard
   depende sólo del `Host` de cada petición (ver §7.4).
4. `curl -s https://<gw>/.well-known/agent.json | jq '.authentication.schemes, .skills[].endpoint'`
   ⇒ `schemes` **no vacío**, y un `endpoint` por skill.
5. 🔴 **El paso que decide.** Prueba del bucle directo, con una key de saldo mínimo:
   `POST /compose` con un step cuyo destino sea el propio gateway ⇒ **400** con
   `error_code: "CONTRACTING_LOOP_DETECTED"`, **y el saldo de la key NO baja** (leer
   `x-a2a-remaining-budget` **antes y después**).
   **Si el saldo bajó, el corte quedó del lado equivocado del débito y hay que REVERTIR.** El 400 por
   sí solo no prueba nada: bajo el mutante `MUT-02` el endpoint **también** devuelve 400 y el débito
   ocurre igual. Lo único que distingue las dos situaciones es **el saldo**.
6. Invariante: un `/compose` normal de 2 steps ajenos ⇒ **200**, mismo cobro que antes, más las claves
   nuevas `feeRatePercent` y `protocolFeeStatus`.

---

## 9 · MENORes abiertos al cierre (los 3 del F4, todos de documentación)

- **MNR-QA-1** · `.env.example` es la **única** de las 4 superficies operativas que **no enumera el
  vaciado** entre los residuales del `Host` (lista tres cosas y son cuatro). Las otras tres (el warn
  de `assertSelfHostsEnv`, el log de arranque de `index.ts:239`, el docblock de `resolveSelfHosts`)
  **sí** lo dicen ⇒ un operador que arranca el servicio lo ve; el que sólo lee el `.env.example`, no.
  Arreglo: una línea.
- **MNR-QA-2** · La tabla de criterio de salida de `implementation-log.md` **se detiene en el
  fix-pack 1** (`5613`) y el HEAD es `5624`, con 7 commits más. Los números **existen y son
  correctos** en los mensajes de esos commits; lo que falta es la fila. Es exactamente la clase "los
  números que envejecen dentro de la propia HU" que este repo ya midió.
- **MNR-QA-3** · Las dos citas rotas ajenas del carril Solana (§7.8).

Ninguno cambia comportamiento ni toca el money-path. Pueden entrar como TD o en un commit posterior.

---

## 10 · Decisiones diferidas a backlog

| Ticket | Qué es | Dónde va |
|---|---|---|
| **HU de seguimiento en `wasiai-v2`** (sin número todavía) | *"`wasiai-v2` reenvía la traza de contratación A2A"*: propagar tal cual `x-a2a-contracting-chain` y `x-a2a-contracting-depth`, y —si actúa como coordinador— agregar su propio eslabón con la semántica de `buildOutboundContractingHeaders` (la profundidad emitida es la recibida **+1**). **Criterio de aceptación medible ya escrito**: una petición a `wasiai-v2` con esos dos headers tiene que llegar al gateway con la cadena que incluye el eslabón de `wasiai-v2` y la profundidad incrementada — verificable con el warn `contracting-guard.rejected` o con un 400 `CONTRACTING_LOOP_DETECTED` en un ciclo armado a propósito. **El contrato ya está publicado**: la Agent Card declara `contracting.chainHeader`, `contracting.depthHeader`, `contracting.depthMax` y `contracting.bestEffortNote` | ⛔ **repo `wasiai-v2`, NO acá.** Sin ella, §7.5 no se mueve |
| **WKH-361** (candidato) | El **bucle de DISCOVERY**: registrar como `registry` el propio `/discover`. Vector real y contiguo (`POST /registries` valida forma y SSRF y nada más), pero **no mueve plata** y tiene circuit-breaker por registry. Comparte el módulo leaf de esta HU ⇒ va **después**, nunca en paralelo | este repo |
| **TD-360-1** | Allow-list de auto-contratación legítima, **si algún día aparece un caso**. Hoy no existe ninguno. Entra vacía por default = denegar | este repo |
| **TD-360-2 / R-3** | Cerrar el bypass por **IP literal**. Pediría resolver DNS de nuestros propios hosts por step: caro, inestable (las IPs de Railway rotan) y solapado con el módulo SSRF | este repo |
| **NC-6** | La prosa de `src/lib/self-published-auth.ts:82` (*"sin punto final"*, que la medición desmiente). Fuera de scope, **confirmada no arreglada** por el CR, que es lo correcto | este repo |
| **DT-2** | El **publicador** en catálogos externos. Esta HU entrega la carta lista y el procedimiento escrito; no hay productor outbound en `src/` y **cuáles catálogos aceptan hoy una publicación abierta no se pudo verificar desde el repo** ⇒ construirlo ahora sería inventar un requirement | este repo |
| **W0 `23a27dd`** | El commit declara `exit 0 / 5497 passed` sobre un árbol con **4 rojos**. ⛔ **La historia no se reescribió**, a propósito. Riesgo que queda vivo y por eso se escribe: un `bisect`, un revert o un merge parcial que se pare en `23a27dd` da CI **rojo** con un commit cuyo mensaje dice estar verde. Corregido y no ocultado en `implementation-log.md:39-67` | — |

---

## 11 · Archivos modificados — 37, agrupados por dominio

`git diff --name-only 3823580..a7c2ce9` (derivado con `/usr/bin/git` en `a7c2ce9`; ver la nota de
instrumento de §5).

**Módulo nuevo (leaf) y su guard inbound — 4**
```
src/lib/contracting-chain.ts             src/lib/contracting-chain.test.ts
src/middleware/contracting-guard.ts      src/middleware/contracting-guard.test.ts
```

**Money-path · los cuatro sitios de Capa 1 y el fee en cascada — 4 de producción**
```
src/routes/compose.ts        src/services/compose.ts
src/routes/orchestrate.ts    src/services/orchestrate.ts
```

**El tercer caller HTTP (remediación de AR-it2/BLQ-MED-1) — 2 de producción**
```
src/services/agent-link.ts   src/routes/agent-links.ts
```

**La carta y la identidad publicada — 2 de producción**
```
src/services/agent-card.ts   src/index.ts
```

**Tipos y destino resuelto — 2 de producción**
```
src/types/index.ts           src/services/agent-price.ts
```

**Tests nuevos y tocados — 17**
```
src/routes/compose.contracting-loop.test.ts        src/services/compose.contracting-loop.test.ts
src/services/orchestrate.contracting-loop.test.ts  src/routes/well-known.test.ts
src/routes/compose.fee.test.ts                     src/routes/orchestrate.test.ts
src/routes/agent-card.test.ts                      src/services/agent-card.test.ts
src/routes/agent-links.test.ts                     src/services/agent-link.test.ts
src/services/agent-price.test.ts                   src/services/orchestrate.quote-billing.test.ts
src/routes/compose.test.ts                         src/routes/compose.no-debit-on-abort.test.ts
src/__tests__/e2e/compose-flow.test.ts             src/__tests__/e2e/e2e.test.ts
src/__tests__/e2e/setup.ts
```
De estos, `compose.test.ts`, `compose.no-debit-on-abort.test.ts` y `compose-flow.test.ts` son los
**tres mocks tipados que rompían `tsc`** y que encontró F2.5; `agent-price.test.ts` es el **cuarto**,
el que rompía en **runtime** por `toEqual` exacto y que el Story File no listaba.

**Configuración y documentación — 6**
```
.env.example   README.md   README.es.md
doc/decisions/2026-08-17-coordinador-como-agente-publicacion.md
doc/sdd/223-coordinador-como-agente/implementation-log.md
doc/sdd/223-coordinador-como-agente/auto-blindaje.md
```
Los dos README entran por **CD-21**: `test/readme-numbers.test.ts` **re-deriva** esos conteos y las 2
envs nuevas los volvieron falsos. Los tres números se **derivaron**, no se incrementaron.

**Cero archivos** de `chaski-v3`, `wasiai-facilitator` o cualquier `wt-*`. **Cero `.sql`**, cero
migraciones, cero `supabase.from(` / `.rpc(` nuevos. `doc/sdd/_INDEX.md` **no lo tocó F3** (lo toca
este cierre, y nada más).

---

## 12 · Auto-Blindaje consolidado — las 20 entradas, sin perder ninguna

> Consolidación de `doc/sdd/223-coordinador-como-agente/auto-blindaje.md` (20 entradas, derivadas con
> `/usr/bin/grep -c "^### \["` en `a7c2ce9`). **El texto completo de cada una, con su medición, vive
> en ese archivo**: esto es el índice navegable, no un reemplazo.
> ⚠️ Nota de fecha: las 4 últimas entradas están fechadas **2026-08-18** por el reloj del dev,
> mientras que sus commits están fechados **2026-08-17 19:0x-19:40** (derivado en `a7c2ce9`).

| # | Fase | El error | La causa raíz | Dónde vuelve |
|---|---|---|---|---|
| 1 | W0 | `T-U-DEPTH-2` decía medir el **parseo** y medía el **techo** | pasé el mismo número como valor y como umbral, y el corte es `>=` | todo test de un guard con comparación **no estricta**: si input y umbral son el mismo número, el test no distingue qué cláusula rechazó |
| 2 | W0 | Metí `' 2'` entre los valores que la ENV debe rechazar | apliqué CD-14 a los **dos** caminos como si fueran uno. **La diferencia es quién escribe el valor**: el header lo controla un tercero, la env la escribe el operador | toda regla de parseo estricto: preguntar **quién escribe ese valor** antes de aplicarla. Fijado con `T-U-MAX-7` para que nadie las "unifique por consistencia" |
| 3 | W0 | Agregué 2 env vars y dejé en falso un número publicado en los **dos** README | `.env.example` tiene un conteo publicado en prosa y un guardián que lo **re-deriva** en cada `npm test` | **el guardián funcionó y por eso costó 3 minutos**: tocar un archivo con un conteo publicado obliga a buscar al **productor** de ese conteo antes de editar |
| 4 | W0 | Mi aritmética de desplazamiento ubicó mal una cita (+65 donde era +94) | los deltas son **acumulados por posición** y reusé el del tramo anterior; era cierto cuando lo medí y **dejó de serlo por mi propia edición posterior** | verificar por **CONTENIDO**, no por aritmética, y re-correr **después de la ÚLTIMA edición** de la wave |
| 5 | W1 | El verde de W0 se volvió rojo **al commitear** | el guardián deriva de `git ls-files`, o sea del **índice**, no del working tree | **`git add -A` primero, medir después**. Cuando un guardián deriva de `git`, la pregunta no es "¿corrí la suite?" sino "¿la corrí contra el estado que voy a entregar?" |
| 6 | W1 | El Story File listaba 3 mocks que rompen `tsc`; **el cuarto rompe en RUNTIME** | `toEqual` exacto sobre el retorno rompe en runtime con `tsc` en verde | al ensanchar un retorno, `tsc` **no** cubre factories de `vi.mock`, ni `toEqual`/`toStrictEqual`/`toMatchObject`, ni snapshots. El fixture quedó **más fuerte**: si alguien deja de devolver `invokeUrl`, tres tests se ponen rojos antes de que el guard quede ciego |
| 7 | W1 | Quise loguear a `error` en un tipo que **no tiene** `error` | copié el idiom de `warn` sin verificar la **superficie del tipo**. La tentación era degradar el nivel, que **habría violado CD-17** | cuando el NIVEL de un log es parte del requisito, la respuesta es **cambiar de logger, nunca de nivel** |
| 8 | W1 | Un mutante que **no compila** reporta `exit=1` y `0 rojos`: **las dos lecturas son falsas** | extraje el bloque con 2 de sus 3 llaves; y el harness igual imprimía un veredicto | **todo mutante lleva un `tsc` como precondición del veredicto**. El harness ahora **aborta con exit 5** si `tsc` no da 0 |
| 9 | W1 | **DESVIACIÓN declarada** del Story File: el canal de corte del Sitio 2 | el patrón prescrito forzaba narrowing en **6 call-sites de 5 archivos, 3 fuera del Scope IN** | **el ORDEN no cambia** (`MUT-03` lo confirma) y **AR y CR la RATIFICARON** por separado. Se presentó como desviación, no como lo que el contrato pedía |
| 10 | W2 | Escribí "un header repetido llega como `string[]`" y **la medición lo desmintió** | copié la semántica de un patrón vecino. **Node JOINEA** los duplicados con `', '` | una afirmación sobre la **plataforma** se mide con la plataforma. Y el hallazgo **cambió el estado de una decisión**: el `trim()` por elemento pasó de comodidad a tener un input que lo justifica |
| 11 | W2 | Mi primer `T-PROP-3` **no mataba** a `MUT-15` | confundí **aditividad** ("los headers de siempre siguen") con **orden** ("los nuevos no pisan una credencial") | todo test de orden entre dos escrituras al mismo diccionario: **¿qué input hace que las dos órdenes den resultados distintos?** Se reescribió sobre una **colisión de nombres real** |
| 12 | W3 | Mi control "mecánico" **se comparaba consigo mismo** | el test tenía su **propia copia** de la lista que vigilaba ⇒ el escenario que existía para cazar no lo habría cazado | todo test "A coincide con B": **leer B de su fuente**, y assertar que la lectura **no vino vacía** |
| 13 | W4 | Un mutante que **mata por el motivo equivocado** (178 rojos en vez de 2) | el mutante tiraba `TypeError` y volteaba medio pipeline: no medía la semántica | un mutante tiene que ser **mínimo y del mismo tipo**. **Leer los NOMBRES de los testigos** y verificar que son los que debía matar |
| 14 | W4 | Dos veces `ReferenceError: app is not defined` al **appendear** un `describe` | `app` se declara dentro del `describe` existente, y appendear al final es lo más cómodo | mirar **de quién es** el fixture antes de appendear. Y no inventar valores esperados de un fixture ajeno: **leerlos** |
| 15 | FP1·G1 | **Encender un guard inerte prendió un mock AMPUTADO, y el rojo cayó en FACTURACIÓN** (5 tests, 500 en vez de 200) | `vi.mock` con factory literal **sin `importOriginal`** deja el resto del módulo en `undefined`; el camino muerto lo tapaba | (1) cuando un fix **enciende** código, esperar rojos en suites ajenas: **son cobertura nueva, no daño**; (2) preguntarse cuánto código deja sin ejecutar un gate del tipo "no puedo decidir, me salteo"; (3) **`importOriginal` siempre** que el módulo exporte más de una cosa. **Se arregló cargando el módulo real, no bajando el guard** |
| 16 | FP1·G2 | Mi testigo **moría por la razón barata** y yo iba a declarar la cara | puse el escalar en el step 0 ⇒ el pipeline se caía **antes** del primer débito, así que medía "se rompe", no "quedó cobrado" | **leer el TEXTO de la muerte de cada testigo, no sólo el conteo**. "Mata" no es "mata por lo que yo digo que mide" |
| 17 | FP2·B1 | `git checkout <archivo>` para restaurar un mutante **me borró tres ediciones sin commitear** | confundí "deshacer mi último cambio" con "volver al estado commiteado" | la restauración de un mutante es la **sustitución inversa**, nunca `git checkout`, y el control es **md5 antes / md5 después**. En un fix-pack ese es **el caso normal** |
| 18 | FP2·B2 | El mutante **no tocaba lo que el test asserta**, y "no mató" no significaba nada | la sustitución dejaba intacta la palabra asertada | cuando un mutante **no** mata, la primera hipótesis no es "el test es débil": es **"mi mutante no tocó lo que el test lee"**. Control de una línea: imprimir el texto resultante y buscar en él la cadena que la aserción espera |
| 19 | FP2·B5 | Estuve por reportar **MNR-6 como "cerrado"** sin testigo | el impulso de asumir que "arreglado" y "verificado" son lo mismo | todo arreglo **preventivo**: un cambio que no puede fallar hoy **no puede tener testigo hoy**, y decirlo es más barato que inventarle uno. La medición correcta es **"¿qué se rompe si lo saco?"** |
| 20 | FP2·cierre | Barrido de citas: **1 rota por mí, 2 que ya estaban rotas** y 3 que eran artefacto de mi propio chequeo | la prosa empuja líneas hacia abajo, y **el archivo que queda mal no aparece en el diff** | (1) todo fix-pack con mucha prosa termina con este barrido, comparando el **TEXTO** y no la aritmética; (2) verificar contra el **BASELINE** antes de atribuirse una cita rota; (3) al arreglar un número, dejarle el **ancla textual** al lado |

---

## 13 · Lecciones para las próximas HUs

1. **Una frase que enumera no evita la recurrencia; un test que enumera, sí.** El residual estaba
   escrito en **cinco superficies** y las cinco enumeraban mal. Lo que cerró el caso fue
   `T-HINT-CALLSITES`, que **deriva** los call-sites de producción y se cae cuando aparece uno nuevo,
   con tres excepciones escritas una por una y control anti-vacuidad en las dos direcciones. Es la
   misma forma que `test/ownership-filter-guard.test.ts` y `test/sdd-index-matches-folders.test.ts`:
   **derivar el universo, escribir a mano sólo las excusas.**
2. **El instrumento de verificación es parte del entregable y se audita como el código.** En esta HU
   mintieron: `/health` (reportaba `configured` para una identidad vacía, con salida **byte-idéntica**
   a la de un deploy correcto), un mutante que no compilaba (`exit=1` + `0 rojos`, indistinguible de
   KILL **y** de SOBREVIVIENTE), un mutante que no tocaba lo asertado, y —en este mismo cierre— un
   `wc -l` bajo `rtk` que devolvió **40** mientras imprimía **37** rutas. Regla: **antes de creerle a
   una medición, calibrar el instrumento en las dos direcciones.**
3. **Un guard "que existe" no vale: vale que corte del lado correcto del débito, y el test tiene que
   medir el DINERO, no el status.** Bajo `MUT-02` el 400 sale igual; lo único que mata es el **conteo
   de débitos**. Todo test de un guard de money-path pone las aserciones de plata **primero**, y quien
   lo escribe **lee el texto de la muerte** para confirmar que muere por lo que dice medir.
4. **Cuando un fix ENCIENDE código que antes se salteaba, los rojos ajenos son cobertura nueva.**
   Cinco tests de facturación se rompieron porque ese bloque nunca se había ejecutado en ese harness.
   El atajo (devolver el guard a inerte) habría puesto la suite en verde **con el agujero de vuelta**.
   La pregunta frente a cualquier gate del tipo "no puedo decidir, me salteo" es **cuánto código deja
   sin ejecutar en los tests**.
5. **Una capacidad que cruza servicios no existe hasta que los dos la reconocen.** La Capa 2 está
   completa, testeada y lista de este lado, y su cobertura efectiva en el camino real es **~0** porque
   la mayoría de los agentes entra por un repo que no reenvía los headers. Eso se escribe en el
   cierre, con HU de seguimiento **en el otro repo** y criterio de aceptación medible; no se maquilla
   como "implementado".

---

## 14 · Conteos finales (última acción del cierre, todos derivados)

| Qué | Cómo se derivó | Valor |
|---|---|---|
| Commits de la HU | `/usr/bin/git rev-list --count 3823580..a7c2ce9` | **19** |
| Archivos tocados | `/usr/bin/git diff --name-only 3823580..a7c2ce9 \| /usr/bin/wc -l` | **37** |
| Waves de F3 | `git log --reverse 3823580..a7c2ce9`, un commit por wave (`23a27dd`…`71fdaf7`) | **6** (W0..W5) |
| Fix-packs | commits `84051dd`…`d9a8cbb` (6) + `6d043f8`…`a7c2ce9` (7) | **2**, 13 commits |
| ACs | `f4-report.md §1` | **12/12 PASS** |
| Tests netos | `5624` (`a7c2ce9`) − `5441` (`3823580`), las dos suites corridas en esta sesión | **+183** |
| Archivos de test netos | `292` (`a7c2ce9`) − `286` (`3823580`) | **+6** |
| Mutantes | 18 (F3) + 8 (fix-pack 1) declarados y muertos, más los del fix-pack 2 | **26 declarados / 26 muertos**; **4 re-corridos por QA, 4 de 4 con el resultado esperado** |
| Bloqueantes | AR (6) + CR (4) + AR-it2 (4), consolidados en §6 | **9 distintos · 9 resueltos · 0 pendientes** |
| MENORes | AR (6) + CR (6) + AR-it2 (6) + F4 (3) | **21 levantados · 3 abiertos** (los tres del F4, de documentación) |
| Entradas de Auto-Blindaje | `/usr/bin/grep -c "^### \[" auto-blindaje.md` en `a7c2ce9` | **20** |
| Residuales abiertos declarados | §7 | **8** |

---

**Veredicto de cierre: 🟢 DONE.** El `validation.md` de esta HU es `f4-report.md`, y su veredicto es
**APROBADO** con 12/12 ACs y evidencia `archivo:línea`. Faltan **dos acciones humanas**: mergear
`feat/223-wkh-360-coordinador-agente` (⛔ `main` es producción y este agente **no mergea ni pushea**)
y correr el smoke de §8 — **empezando por setear `A2A_SELF_HOSTS`, y terminando en el paso 5, que es
el que decide si hay que revertir**.
