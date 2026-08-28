# F4 · Validación QA — WKH-370 · El vigilante del catálogo

Rama `feat/231-wkh-370-catalogo-vs-agentes-vivos` · HEAD `f86be49` · base `091db28` (ancestro de `main`, verificado con `git merge-base --is-ancestor`)
Fecha: 2026-08-27 · Rol: `nexus-qa` · Modo del reporte: **DENSO** (hay un desvío de contrato declarado y un pendiente para DONE)

## Veredicto: ✅ **APROBADO PARA DONE** — 10/10 ACs PASS · 0 FAIL · 1 desvío de contrato declarado (no bloqueante) · 1 pendiente obligatorio para DONE

⛔ Nada de este reporte se apoya en una cita sola. **Toda afirmación de comportamiento se ejecutó**, y
la salida literal está abajo. Lo que no se pudo ejecutar sin desplegar está marcado **post-deploy**,
no PASS.

---

## 0 · Qué corrí, y qué NO re-corrí

**Corrido por mí en esta F4:**

1. El **gate completo del repo**, en orden, sobre árbol limpio (§2).
2. El **chequeo contra PRODUCCIÓN**, las dos mitades (§3).
3. **Seis escenarios end-to-end por `main()`** con la red doblada, uno por AC de comportamiento (§4).
4. **Un barrido exhaustivo propio de 8.748 combinaciones** de la escalera, con control positivo del
   instrumento (§5).
5. **Tres mutantes propios**, uno por clase, restaurados con `cp` y verificados byte a byte (§6).

**NO re-corrí** (y digo por qué): los 7 mutantes de `T-S6`, los 378 casos del guard de las filas 8/9
y los 5 cierres del fix-pack — el **AR-2 los verificó ejecutando** (`ar-report-2.md`), y repetirlos
es overlap sin valor. Lo que sí re-hice es **lo que el AR-2 no midió**: los invariantes de AC-3,
AC-4 y AC-7 sobre el espacio entero de contadores, con mi propia semántica de referencia.

---

## 1 · ACs — tabla con evidencia EJECUTADA

| AC | Texto (resumen EARS) | Status | Evidencia **ejecutada** |
|---|---|---|---|
| **AC-1** | Comparar el schema del catálogo contra el manifiesto vivo y reportar cada divergencia con slug, campo y **las dos huellas** | ✅ **PASS** | **Corrida real contra prod**: `comparados=5` sobre los 5 self-published (§3). **Escenario A ejecutado** (§4): `HALLAZGO: remit-corridor-fx-solana tipo=deriva campo=inputSchema catalogo=f55d5f37eef2 manifiesto=a8902398d897` → `exit 4`. Tests: `test/check-catalog-vs-live.test.mjs` T-D1, T-D2, T-D3 PASS (§7). **Mutante MA** (comparar el `payment` de la raíz) mata T-D2 y T-Z2 (§6) |
| **AC-2** | Completitud como comprobación **separada e independiente** de la deriva, con etiquetas y códigos distintos | ✅ **PASS** *(ver nota D-1)* | **Escenario B ejecutado** (§4): la **misma fila** sale `INCOMPLETA(5)` por completitud y `CONFORME(0)` por deriva, en dos corridas de `main()` que no se consultan entre sí. Dos jobs sin `needs:` en el YAML real (T-Y1 PASS). Códigos distintos: `4` vs `5`, observados por mí (§4). `src/services/agent.completeness.test.ts` T-B1/T-B2 PASS |
| **AC-3** 🎯 **LA TESIS** | Fila con `payout_wallet` nulo o `metadata` vacío ⇒ **INCOMPLETA aunque su deriva dé cero**, y SHALL NOT reportarla como conforme | ✅ **PASS** | **Escenario B ejecutado** (§4): `INCOMPLETA … incompletas=1` **en la misma línea que dice `derivas=0`** → `exit 5`. **Escenario B2 ejecutado**: `metadata` vacío → `faltantes=[metadata.inputSchema]` → `exit 5`. **Barrido propio de 8.748 combinaciones: 0 violaciones** del invariante `incompletas>0 ⇒ nunca CONFORME` (§5). **Mutante MB** (fila 10 desactivada) → `expected +0 to be 5` en T-C1/T-C2/T-C3 (§6) |
| **AC-4** | Si termina sin comparar **ningún** par ⇒ clase **CONFIG**, y **SHALL NOT** salir conforme | ⚠️ ✅ **PASS con desvío literal declarado** | **Invariante fuerte, medido por mí sobre las 8.748 combinaciones: `comparados===0 ⇒ CONFORME` sucede 0 veces** (§5), con control positivo que prueba que el barrido puede dar rojo. T-V1 (`CONFIG(3)`, mensaje *"sin haber comparado"*) y T-V2 (control positivo `comparados>0`) PASS. **Mutante MC** (fila 7 desactivada) → `expected 2 to be 3` (§6). ⚠️ **La segunda cláusula se cumple siempre; la primera no es literal**: ver §8 |
| **AC-5** | Excluir a todo agente no `self-published` **con el motivo escrito**, nunca en silencio | ✅ **PASS** | **Corrida real contra prod** (§3): línea `EXCLUIDOS:` con los **24** federados, uno por uno, cada uno con `registry=WasiAI no publica manifiesto propio`. `catalogo=29 elegibles=5 excluidos=24`, **derivado, no hardcodeado**. T-U1/T-U2 PASS |
| **AC-6** | Derivar la ruta del manifiesto del `invokeUrl`, verificar que el manifiesto **se autodeclara** con el slug del catálogo; si no coincide ⇒ **UNRESOLVED** y NO comparar schemas | ✅ **PASS** | **Escenario E ejecutado** (§4): manifiesto que se declara `otro-agente` → `HALLAZGO … motivo=el manifiesto se declara con otro slug` → `exit 6`, y `comparados=0 derivas=0` ⇒ **no comparó ni un campo pese a que el `inputSchema` DIFERÍA**. **Escenario D ejecutado**: `invokeUrl` sin `/invoke` → `motivo=el invokeUrl no termina en /invoke`, **no adivina otra URL**. En prod, los 5 resolvieron (`comparados=5`) con 2 de 5 teniendo `pathSlug ≠ slug`. T-J1/T-J2 PASS |
| **AC-7** | Si **cero** elegibles publican schema ⇒ **CONFIG**, **nunca** deriva del catálogo | ✅ **PASS** | **Escenario C ejecutado** (§4): 5 elegibles publicando `inputSchema` en la **raíz** y nada en `metadata` → `CONFIG: ningún elegible publica su inputSchema bajo metadata — un cero uniforme acusa al instrumento…` → `exit 3`, **no** "5 derivas". **Barrido propio: 0 casos de `conSchema=0 ⇒ DERIVA`** (§5). Y el corte pasa **antes de salir a la red** (`scripts/check-catalog-vs-live.mjs:491`), verificado porque el escenario C no registró ninguna llamada al manifiesto. T-Z1 PASS |
| **AC-8** | Un código de salida **distinto por clase**, de modo que el código solo ya atribuya | ✅ **PASS** | **Observé por mi mano los 6 códigos que la escalera puede emitir**: `0` (prod, §3), `2` (manifiesto ENOTFOUND y `/discover 503`, §4), `3` (sin credencial en prod §3; typo de `CHECK_MODE`; 401 §4), `4` (§4), `5` (§4), `6` (§4). `1` está **reservado** para excepción no manejada y la escalera nunca lo emite (`:399` default = INALCANZABLE, no CONFORME; T-E3 PASS). T-E1 (7 códigos distintos, ningún mensaje usa la palabra de otra clase) PASS |
| **AC-9** | Al fallar la corrida programada, abrir/comentar un issue **con título propio**; al volver a pasar, cerrarlo | ✅ **PASS (estructural)** · runtime **post-deploy** | Leído el YAML real: 2 jobs (`deriva:71`, `completitud:178`), **sin `needs:`**, `cron: '23 6 * * *'`, abrir con `if: failure() && github.event_name == 'schedule'` (`:115`, `:218`) y cerrar con `if: success() && …` (`:161`, `:258`), **títulos propios y distintos** (`:118`/`:164` y `:221`/`:261`). T-Y1…T-Y6 PASS. ⚠️ **La corrida programada en sí NO se puede ejecutar antes del merge** (el workflow no está en la rama por defecto): eso queda como **post-deploy**, en el smoke de §10 |
| **AC-10** | Demostrar, **para cada una de las dos clases**, que el chequeo se pone rojo **por el motivo correcto** al romperlo a propósito, con **control positivo** | ✅ **PASS** | **Tres mutantes propios, ejecutados en esta F4** (§6), uno por clase + uno de anti-vacuidad, cada rojo leído **por su motivo** (`expected 4 to be +0` = deriva fabricada · `expected +0 to be 5` = la fila rota declarada sana · `expected 2 to be 3` = la anti-vacuidad pierde su clase). **Control positivo**: T-V2 exige `comparados>0` sobre la línea EMITIDA en el caso feliz, y tras restaurar las suites vuelven a **40 passed (40)**. Árbol **byte-idéntico** por `sha256sum`, `git status --porcelain` **vacío** |

**10 de 10 PASS. 0 FAIL. 0 NO VERIFICABLE.**

---

## 2 · El gate del repo — corrido por mí, completo y en orden

⛔ `npm run qa` **no existe en este repo**. El gate es la secuencia de `.github/workflows/ci.yml`.

```
=== git status --porcelain (PRE-gate) ===
(vacío)
=== 1) npx tsc -p tsconfig.json --noEmit ===
TypeScript compilation completed          TSC_EXIT=0
=== 2) npm run lint ===
> biome check src/
Checked 520 files in 224ms. No fixes applied.   LINT_EXIT=0
=== 3) npm test ===
 Test Files  314 passed | 6 skipped (320)
      Tests  6350 passed | 19 skipped (6369)
                                           TEST_EXIT=0
```

| Número | Base `091db28` | Esperado | **Medido por mí** | |
|---|---|---|---|---|
| Biome | 519 | 520 | **520** | ✅ |
| Archivos de test | 312/318 | 314/320 | **314 passed / 6 skipped (320)** | ✅ |
| Casos | 6310/6329 | 6350/6369 | **6350 passed / 19 skipped (6369)** | ✅ |

⚠️ **El `git status --porcelain` estaba VACÍO ANTES del gate**, y eso importa:
`test/readme-numbers.test.ts:83` enumera con `git ls-files`, o sea **contra el índice**. Con archivos
untracked ese guardián da **verde en falso**. Los cuatro números están escritos y verificados:
`README.md:378` (**320**), `README.md:383` (**520**), `README.es.md:412` (**320**), `README.es.md:417` (**520**).

---

## 3 · La corrida REAL contra producción — sólo lectura, coste 0 USDC

`BASE_URL = https://wasiai-a2a-production.up.railway.app` · único verbo `GET` (T-S1) · sin `/compose`.

### 3.1 · Mitad de DERIVA — `npm run check:catalog:deriva`

**Línea emitida, entera:**

```
CONFORME: se comparó al menos un par y todo lo elegible está al día — no dice nada de los excluidos | modo=deriva catalogo=29 elegibles=5 comparados=5 derivas=0 incompletas=0 unresolved=0 inalcanzables=0 sindato=0 excluidos=24 outputSchemaPresente=3/5 durationMs=4207
```

`exit = 0`. **Coincide exactamente con lo esperado**: `catalogo=29 elegibles=5 comparados=5 derivas=0
incompletas=0 excluidos=24 outputSchemaPresente=3/5`.

Precedida por la línea `EXCLUIDOS:` con los **24 federados uno por uno**, cada uno con su motivo
(`agentshop-cashout-matcher=registry=WasiAI no publica manifiesto propio; …; metrics-collector-qa=…`).
**Ninguna exclusión en silencio** (AC-5 · CD-10).

⚠️ Lectura correcta de este verde, y está escrita en el propio mensaje: dice que **los 5 elegibles**
están al día. **No dice nada de los 24 excluidos.** Y `outputSchemaPresente=3/5` es la deuda
`TD-370-OUTPUTSCHEMA-SIN-FUENTE` **hecha visible**, no tapada: 3 filas del catálogo traen un
`outputSchema` que **ningún** manifiesto respalda.

### 3.2 · Mitad de COMPLETITUD **sin la credencial**

```
CONFIG: falta la credencial A2A_CATALOG_OWNER_KEY — la completitud NO se verificó, y un sin dato jamás sale por exit 0 | modo=completitud catalogo=29 elegibles=5 comparados=0 derivas=0 incompletas=0 unresolved=0 inalcanzables=0 sindato=0 excluidos=24 outputSchemaPresente=3/5 durationMs=517
```

`exit = 3`. ✅ **`CONFIG(3)` nombrando la env** — **no** un verde y **no** un `INALCANZABLE(2)`.
Corrido con `env -u A2A_CATALOG_OWNER_KEY` para garantizar la ausencia. Es exactamente lo que
`CD-15` exige y lo que el punto 8 de la Done Definition anticipa: **`MI-8` sigue abierto y no
bloquea el merge**.

---

## 4 · Seis escenarios end-to-end por `main()` — ejecutados en esta F4

Red doblada (`globalThis.fetch`), **el script real, sin modificar**. Salida literal:

```
══ A · AC-1 · el catálogo dice un schema y el manifiesto vivo dice otro
HALLAZGO: remit-corridor-fx-solana tipo=deriva campo=inputSchema catalogo=f55d5f37eef2 manifiesto=a8902398d897
DERIVA: 1 elegible(s) con al menos un campo distinto … | comparados=1 derivas=1 …          exit = 4

══ B · AC-3 (LA TESIS) · fila SIN payout_wallet y con deriva CERO
HALLAZGO: remit-corridor-fx-solana tipo=incompleta faltantes=[payoutWallet]
INCOMPLETA: 1 fila(s) mal nacida(s) … | modo=completitud comparados=1 derivas=0 incompletas=1 …  exit = 5
   …la MISMA fila, MISMO fixture, por la mitad de deriva:
CONFORME: … | modo=deriva comparados=1 derivas=0 incompletas=0 …                                exit = 0

══ B2 · AC-3 · metadata VACÍO (nada que comparar)
HALLAZGO: remit-corridor-fx-solana tipo=incompleta faltantes=[metadata.inputSchema]
INCOMPLETA: … incompletas=1 …                                                                   exit = 5

══ C · AC-7 · CERO UNIFORME: los 5 publican inputSchema en la RAÍZ y nada en metadata
CONFIG: ningún elegible publica su inputSchema bajo metadata — un cero uniforme acusa al
        instrumento que lo buscó donde no vive | catalogo=5 elegibles=5 comparados=0 …          exit = 3

══ D · AC-4/AC-6 · el invokeUrl no termina en /invoke ⇒ la URL NO se adivina
HALLAZGO: remit-corridor-fx-solana tipo=unresolved motivo=el invokeUrl no termina en /invoke
UNRESOLVED: … comparados=0 unresolved=1 …                                                       exit = 6

══ E · AC-6 · el manifiesto se autodeclara con OTRO slug (y su inputSchema DIFERÍA)
HALLAZGO: remit-corridor-fx-solana tipo=unresolved motivo=el manifiesto se declara con otro slug
UNRESOLVED: … comparados=0 derivas=0 …                                                          exit = 6
```

Y los códigos que faltaban para cerrar AC-8, también ejecutados:

```
── el manifiesto del único elegible NO contesta
INALCANZABLE: 1 elegible(s) no contestaron — esto NO dice que el catálogo esté mal … exit = 2
── /discover 503
INALCANZABLE: no se pudo leer el listado … (/discover 503) …                          exit = 2
── fila 4b: la credencial es RECHAZADA (401)
CONFIG: el listado propio rechazó la credencial A2A_CATALOG_OWNER_KEY (401) — hay que rotarla … exit = 3
   CD-5 · ¿la credencial aparece en la salida?  NO ✅   (se le pasó una clave marcada y no sale)
── CHECK_MODE con un typo ('derivaa')
CONFIG: CHECK_MODE ausente o no reconocido … y no hay default que corra "algo"         exit = 3
```

🎯 **El escenario E es la prueba de que AC-6 no es decorativo**: el manifiesto traía un `inputSchema`
**distinto** y el chequeo salió `UNRESOLVED(6)` con `derivas=0` — **se negó a comparar** en vez de
publicar una deriva contra el agente equivocado.

🎯 **El escenario B es la HU entera en dos líneas**: el mismo fixture, dos veredictos opuestos.
Sin la mitad de completitud, esa fila salía `exit 0` y nadie miraba.

---

## 5 · Barrido exhaustivo propio de la escalera — 8.748 combinaciones

Importé `classify` del script real y recorrí `{modo} × {credencial} × {6 contadores en 0,1,2}`
comprobando **invariantes escritos por mí desde el texto de los ACs**, no desde el fuente:

```
combinaciones evaluadas: 8748
AC-4 violaciones (comparados=0 y CONFORME):        0
AC-3 violaciones (incompletas>0 y CONFORME):       0
AC-7 violaciones (cero uniforme y DERIVA):         0
con comparados=0, clases emitidas: {"CONFIG":1404,"INALCANZABLE":126,"UNRESOLVED":42,"INCOMPLETA":1008,"DERIVA":336}
CONTROL POSITIVO (classify falso que rompe AC-4): violaciones detectadas = 2 (debe ser 2)
```

⚠️ **El control positivo no es decorativo**: un barrido que sólo verifica una AUSENCIA pasa igual
cuando no ejecutó nada. Sustituí `classify` por uno deliberadamente roto y el barrido **lo detectó**.
⇒ los tres ceros de arriba son **silencio real, no un instrumento apagado**.

---

## 6 · AC-10 · tres mutantes propios, rojo confirmado POR SU MOTIVO

Backup con `cp` a subdirectorio propio del scratchpad (CD-20). ⛔ En ningún momento `git checkout --`.

| # | Mutación | Rojo literal | **El motivo, que es lo que hay que leer** |
|---|---|---|---|
| **MA** (clase **DERIVA**) | `:210` · `meta.payment` → `fila?.payment` | `T-Z2 … expected 4 to be +0` · `T-D2 … expected [ 'inputSchema', 'payment' ] to deeply equal [ 'inputSchema' ]` · **5 failed / 35 passed** | `DERIVA(4)` donde correspondía `CONFORME(0)`: **deriva FABRICADA**. El `payment` de la raíz de `/discover` es DERIVADO y trae `network`+`resolvedChain` que el manifiesto no tiene ⇒ contra producción serían **5 de 5 agentes acusados todos los días** sin que nada esté mal |
| **MB** (clase **INCOMPLETA** · LA TESIS) | `:383` · fila 10 desactivada | `T-C1`, `T-C2`, `T-C3` → `expected +0 to be 5` · `T-E6` → `expected 'CONFORME' to be 'INCOMPLETA'` · **4 failed / 36 passed** | `CONFORME(0)` donde correspondía `INCOMPLETA(5)`: **la fila rota declarada sana**. Es el bug de origen de `remit-kyc-session` / `remit-kyc-decision`, reproducido a pedido |
| **MC** (anti-vacuidad) | `:354` · fila 7 desactivada | `T-V1 … expected 2 to be 3` · **1 failed / 39 passed** | La anti-vacuidad **pierde su clase**: un chequeo que no comparó nada deja de decir *"yo no estoy en condiciones de afirmar nada"*. Sigue sin salir verde, pero deja de atribuirse el problema a sí mismo |

**Control positivo e integridad del árbol**, verificados los tres:
`sha256 2010900b278ba8c548de1adcee56fb021e7269f42aad53ef3e17175c6459a534` idéntico antes y después de
cada mutación · suites de vuelta en **40 passed (40)** · `git status --porcelain` **vacío**.

---

## 7 · Los 33 tests del Story File — presentes y verdes, más 7 del fix-pack

`npx vitest run test/check-catalog-vs-live.test.mjs src/services/agent.completeness.test.ts --reporter=verbose`
→ **Test Files 2 passed (2) · Tests 40 passed (40)**, exit 0.

Los **33 IDs** de §8 del Story File existen: T-D1..T-D3, T-C1..T-C5, T-V1, T-V2, T-U1, T-U2, T-J1,
T-J2, T-Z1, T-Z2, T-E1..T-E4, T-Y1..T-Y6, T-S1..T-S5, T-B1, T-B2.
Más **7 nacidos del AR/CR**: T-C6 (BLQ-1), T-E4b, T-E4c, T-E5 (BLQ-3), T-E6 (BLQ-4), T-E7 (MNR-1),
T-S6 (BLQ-5).

**Test drift: ninguno.** Cada AC tiene al menos un test que lo nombra en su título.

---

## 8 · ⚠️ Drift detection

### 8.1 · Scope drift — 4 archivos fuera del Scope IN, **los 4 declarados**

`git diff --name-status 091db28..f86be49` da 17 archivos. Los **10 del Scope IN** están todos.
Los **4 extra de código** son **arrastre de citas por desplazamiento de líneas**, no scope creep:

| Archivo | Δ | Por qué | ¿Declarado? |
|---|---|---|---|
| `src/routes/agents.publish.test.ts` | +6 | `hasPayoutWallet` es **requerido** ⇒ rompe el fixture compartido `RECORD_RESPONSE` (4 × TS2345) | ✅ `auto-blindaje.md` W1.B, *"se declara como desvío del Scope IN"* |
| `test/ownership-filter-guard.exceptions.ts` | +18/-18 | El guardián registra **5 sitios de `agent.ts` por número de línea**; las inserciones los corrieron | ✅ `auto-blindaje.md` W4.2, *"Desvío del Scope IN, declarado"* |
| `src/routes/agents.ownership.test.ts` | +4/-4 | Dos citas de prosa (`:808`→`:890`, `:822`→`:904`) desplazadas | ✅ misma entrada |
| `src/types/index.ts` | +1/-1 | Una cita de prosa (`agent.ts:399`→`:481`) desplazada | ✅ misma entrada |

Y `test/cited-lines-guard.citations.ts` fue **17 líneas** contra un presupuesto de ≤6: también
declarado (W3.3, *"el número vive en la PROSA, no en el registro"*).
**Ni `src/services/discovery.ts`, ni el camino del dinero, ni el pin del KYC, ni `.env.example`, ni
`src/routes/agents.ts` fueron tocados** (CD-9, CD-24). `doc/sdd/_INDEX.md` tampoco.

**Escala**: techo declarado fuera de `doc/` = 1.140 líneas; el diff fuera de `doc/` da **~1.780**
(el grueso: la suite de 831 líneas contra un presupuesto de 480, por los 7 tests del fix-pack).
Está **por debajo del 2x** que la regla 10 de `CLAUDE.md` obliga a justificar por escrito.

### 8.2 · Spec drift — el desvío del contrato del W0, evaluado

El Dev se apartó de la escalera literal de §5 del Story File en **tres** puntos. Los evalué uno por
uno, y **ninguno es drift silencioso**: los tres están escritos en el código, en el sitio, y en
`auto-blindaje.md`.

| # | Desvío | Veredicto QA |
|---|---|---|
| **(a)** fila 7 gana `&& inalcanzables===0 && unresolved===0` | ⚠️ **Corrección justificada, con desvío literal de AC-4** — ver abajo | |
| **(b)** filas 8 y 9 ganan `&& !acusaAlCatalogo` | ✅ **Corrección justificada, sin desvío de ningún AC.** Sin ella, un manifiesto flaky conviviendo con 4 derivas reales emitía `exit 2` diciendo *"esto NO dice que el catálogo esté mal"* **en la misma línea que decía `derivas=4`**: el mensaje desmentido por su propio contador, y quien confía en el exit code —que es lo que **AC-8** le pide— se perdía las cuatro. El AR-2 lo midió en **378 combinaciones con 0 divergencias** contra una semántica de referencia escrita a mano; no lo repetí | |
| **(c)** fila `4b` nueva: credencial **rechazada** (401/403) → `CONFIG(3)` | ✅ **Adición justificada, sin desvío de ningún AC.** Ejecutada por mí (§4): una key **revocada** y una key **ausente** son el mismo hecho —*no estoy en condiciones de preguntar*— y reportar la revocada como `INALCANZABLE(2)` mandaría al humano a mirar el deploy en vez de **rotar el secreto**. Verifiqué además que **no filtra la credencial**: le pasé una clave marcada y no aparece en la salida (CD-5) | |

#### El desvío literal de AC-4, dicho sin suavizarlo

AC-4 tiene **dos** cláusulas: *(i) SHALL salir con clase **CONFIG*** y *(ii) SHALL NOT salir con
clase conforme*.

- **(ii) se cumple SIEMPRE.** Medido por mí sobre 8.748 combinaciones: **0 violaciones** (§5).
- **(i) NO es literal.** Escenarios D y E, ejecutados arriba: `comparados=0` y la clase emitida es
  **UNRESOLVED(6)**; con el manifiesto caído es **INALCANZABLE(2)**. En el barrido, con
  `comparados=0` las clases alcanzables por el camino real son `CONFIG` (1404) más `INALCANZABLE`
  (126) y `UNRESOLVED` (42).

**Por qué lo apruebo igual, y no como un "es menor":**

1. Lo que AC-4 existe para garantizar es **que un chequeo que no ejecutó nada jamás salga verde**.
   Eso se cumple sin excepción y está **medido**, no supuesto.
2. La cláusula (i) **choca de frente con AC-8**. `CONFIG` afirma textualmente, en la tabla del
   propio contrato, que *acusa al INSTRUMENTO* y *NO implica a producción*. Con la escalera literal,
   *"los cinco manifiestos están caídos"* se reportaba como *"yo no estoy en condiciones de
   preguntar"*: una **mala atribución**, que es justo lo que las siete clases existen para evitar.
3. El contrato no pudo verlo porque **el conflicto sólo aparece con un único elegible** (con más de
   uno basta que uno compare). No es un capricho del Dev: es un caso que la spec no cubrió.
4. Está **escrito en el sitio** (`scripts/check-catalog-vs-live.mjs:342-353`) y en `auto-blindaje.md`
   W1.A, con la lección generalizada.

📌 **Acción para DONE (no bloqueante)**: el texto de AC-4 en el `work-item.md` y en la fila del
índice quedó **más fuerte que la implementación**. Corresponde amendarlo a algo falsable como:
*"⇒ clase **CONFIG**, salvo que otra clase **no conforme** atribuya mejor la causa; y **jamás** clase
conforme"*. Dejar el texto viejo es prosa que afirma de más en la HU que existe para sacar eso.

### 8.3 · Wave drift

Los commits respetan el orden: `20b3102` (W0→W3, la implementación) → `42a7219` (AR+CR) →
`7fdd4fc` (fix-pack 1) → `f797298` (AR-2) → `f86be49` (fix-pack 2, MNR2-1). **Sin drift.**

### 8.4 · El caso `AgentRow` — evaluado, y NO es drift

El Story File **D-2 paso 1** prescribía *"agregar a `AgentRow` una sola línea: `payout_wallet`"*.
**El Dev no lo hizo**, y creó `type OwnedAgentRow = AgentRow & { payout_wallet: string | null }`
(`src/services/agent.ts:102`), que tipa **sólo** el parámetro de `mapRowToRecord`.

**Verificado abriendo el árbol**: `src/services/agent.ts:54-65` sigue listando las 10 columnas
**sin** `payout_wallet` ⇒ `mapRowToAgent` —el mapper del catálogo **ANÓNIMO**— sigue recibiendo una
fila donde la columna **no existe para el compilador**. ✅ **La decisión anterior (WKH-143,
*"NO ampliar esta interfaz porque alimenta mappers públicos"*) se respeta con su motivo en vez de
derogarse.** Es **mejor** que lo prescrito, no un atajo. T-B2 es el control negativo y pasa.

### 8.5 · AC-2 menciona `metadata.outputSchema` y la implementación no lo exige

**Confirmado, no re-litigado.** Está autorizado por **D-1** del Story File con medición
(`0/5` manifiestos lo publican; las keys de primer nivel son las mismas ocho en los cinco), el AR-2
ya lo revisó y lo descartó como drift, y la implementación **lo cuenta y lo reporta**
(`outputSchemaPresente=3/5` en la corrida real de §3) en vez de tapar la deuda.
Exigirlo haría **nacer el chequeo en rojo por un criterio sin fuente de verdad**, que es el control
que la gente aprende a ignorar. `TD-370-OUTPUTSCHEMA-SIN-FUENTE` está declarada en el docblock del
script (`:47-56`), no en un backlog aparte. **Sin objeción.**

---

## 9 · 🔴 `MNR2-4` — las citas podridas de `_INDEX-row.md`, verificadas ABRIENDO cada línea

⚠️ **Y hay un agravante que el AR-2 no midió: la fila NO está pendiente de pegar. YA ESTÁ PEGADA.**
`doc/sdd/_INDEX.md:223` la contiene, y ese commit **ya está en `main`** (verificado con
`git show main:doc/sdd/_INDEX.md`). O sea: **las 5 citas falsas no "se publicarían" — están
publicadas en el índice del proyecto desde el F1.** DONE tiene que **editar la fila existente**, no
pegarla de nuevo.

Abrí **las 12 citas** de la fila, una por una, contra el árbol de `f86be49`:

### Las 5 PODRIDAS — con el número correcto ya derivado

| # | Cita en la fila | Qué afirma | Qué hay HOY en esa línea | **Corregir a** |
|---|---|---|---|---|
| 1 | `agent.ts:713` | *escribe `payout_wallet` sólo si viene* | `throw new OwnershipMismatchError();` | **`agent.ts:795`** (`updateRow.payout_wallet = updates.payoutWallet;`, guarda en `:794`) |
| 2 | `agent.ts:735-736` | *mergea `metadata.inputSchema` sólo si viene* | `}` + línea en blanco | **`agent.ts:817-818`** |
| 3 | `agent.ts:165` | *`mapRowToAgent` emite `metadata` entero* | `return {};` | **`agent.ts:222`** (el `metadata,` dentro de `mapRowToAgent`, que arranca en `:195`) |
| 4 | `agent.ts:190` | *`mapRowToRecord` iza `inputSchema` a la raíz* | una línea de docblock sobre `payment` | **`agent.ts:260`** (`if (inputSchema !== undefined) record.inputSchema = inputSchema;`) |
| 5 | `agent.ts:174-198` | *`payout_wallet` **no está** en `mapRowToRecord`* | `readMetadataObject` + el arranque de otro bloque | **`agent.ts:231-268`** ⚠️ **y la FRASE también hay que corregirla** — ver abajo |

### 🔴 La #5 no es sólo un número: es una afirmación que esta HU volvió FALSA

La fila dice que `payout_wallet` *"no está en `mapRowToRecord` (`:174-198`)"*. Tras WKH-370,
`mapRowToRecord` (`:231-268`) recibe un `OwnedAgentRow` y **LEE** `payout_wallet` (`:256-257`) para
derivar `hasPayoutWallet`. Lo que sigue siendo cierto —y es lo que la regla protege— es que **el
VALOR no sale**. Renumerar sin tocar la frase deja una **cita que apunta bien y afirma mal**, que es
peor que una rota: una rota se ve, ésta no.

**Redacción sugerida para DONE**: *"…no estaba en el `AgentRow` interno (`agent.ts:54-65`) ni en
`mapRowToRecord`; **tras WKH-370 `mapRowToRecord` (`:231-268`) lee la columna para derivar un
booleano, y el VALOR sigue sin salir a ningún shape**…"*.

### Las 7 VÁLIDAS — abiertas y confirmadas, no tocar

| Cita | Lo que hay en la línea | |
|---|---|---|
| `src/services/agent-split-context.ts:50-52` | el ternario `row?.payoutWallet ? {…} : null` | ✅ |
| `agent-split-context.ts:13-14` | *"CD-5: … SOLO vía `getSplitContextRow`…"* | ✅ |
| `agent.ts:54-65` | la interfaz `AgentRow`, 10 campos, **sin `payout_wallet`** — la afirmación sigue siendo verdadera | ✅ |
| `probe-money-path.yml:100` | `A2A_PROBE_KEY: ${{ secrets.A2A_PROBE_KEY }}` | ✅ |
| `probe-money-path.yml:116` y `:165` | el **mismo** `TITULO:` en las dos (abrir/cerrar por título exacto) | ✅ |
| `ci.yml:4-6` | *"Runs WITHOUT secrets or a live database"* | ✅ |
| `smoke-downstream.yml:52-94` | `:52` *"Abrir issue si la corrida por reloj falla"* … `:94` el `fi` que cierra el paso de cierre | ✅ |

### Y un segundo pendiente del mismo archivo

`_INDEX-row.md` dice en su propia instrucción 3: *"Borrar este archivo cuando la fila esté puesta"*.
La fila **está puesta**. El archivo **sigue en el repo** y es un artefacto que no es parte de la HU.
⚠️ Antes de borrarlo, comprobar que `test/sdd-index-matches-folders.test.ts` sigue verde
(deriva carpetas de `git ls-files doc/sdd`, y borrar un archivo cambia el índice).

⛔ **Las 5 correcciones se hacen AL FINAL, después de que nadie vaya a mover nada más**, y
**re-derivando abriendo la línea** — nunca sumándole el delta de una pasada anterior. Esta HU ya
desplazó `agent.ts` **cuatro veces**, y las tres primeras pasadas de citas quedaron viejas por la
edición siguiente (`auto-blindaje.md` W3.3 segunda pasada, y la cuarta del fix-pack).

---

## 10 · Smoke post-deploy — para el operador, DESPUÉS del merge a `main`

Lo único de esta HU que **no se puede ejecutar antes del merge** es la corrida **programada** del
workflow (GitHub no evalúa `schedule:` fuera de la rama por defecto).

```
1. Merge a main. Confirmar que .github/workflows/check-catalog-vs-live.yml está en main.
2. Actions → "check-catalog-vs-live" → Run workflow (workflow_dispatch).
   Esperado: job `deriva` VERDE (exit 0) · job `completitud` con exit 3 (CONFIG) mientras
   A2A_CATALOG_OWNER_KEY no esté cargado — y NINGÚN issue abierto, porque los pasos de
   aviso son `if: … github.event_name == 'schedule'`.
3. Esperar el cron ('23 6 * * *') o forzar un fallo transitorio, y verificar:
   a. se abre UN issue con el título 'check-catalog deriva: el catalogo se separo de los
      agentes vivos' (o el de completitud), y NINGUNO de los otros dos títulos del repo
      (probe-money-path / smoke-downstream) queda tocado;
   b. en la siguiente corrida verde el MISMO issue se CIERRA solo.
4. Cargar el secreto A2A_CATALOG_OWNER_KEY (MI-8) y confirmar que el job `completitud`
   pasa de exit 3 a exit 0 sobre los 5 self-published.
   ⚠️ Si sale 401/403 la clase sigue siendo CONFIG(3) y el mensaje dice "hay que rotarla":
   eso NO es una caída de producción.
```

---

## 11 · Confirmación de gates y hallazgos previos

| Fuente | Estado |
|---|---|
| `cr-report.md` | RECHAZADO en su momento · los 5 BLQ cerrados en `7fdd4fc` |
| `ar-report.md` | RECHAZADO en su momento · idem |
| `ar-report-2.md` | ✅ **APROBADO**, 0 bloqueantes, los 5 cierres verificados **ejecutando** |
| `MNR2-1` (mutante alcanzable: `\|\| schema === null`) | ✅ **CERRADO** en `f86be49` — T-C3 lo mata hoy con el caso `metadata: { inputSchema: null }`, y lo verifiqué corriendo la suite |
| `MNR2-2`, `MNR2-3` | Mutantes equivalentes / defensivos puros. Documentados. **Aceptados como TD** |
| `MNR2-4` | 🔴 **ABIERTO — obligatorio para DONE.** §9 de este reporte |
| `MNR2-5` | Cita cuyo `mustContain` no sostiene la frase. **Pre-existente, fuera de Scope IN.** Aceptado |
| `TD-370-EXCEPTIONS-SIN-GUARDIAN` | Declarada y **medida** por el AR-2 con control positivo. Aceptada |
| `TD-370-OUTPUTSCHEMA-SIN-FUENTE` | Declarada en el docblock del script. **Visible en la corrida real**: `outputSchemaPresente=3/5` |
| `TD-370-KEY-SOLO-LECTURA`, `TD-370-CITAS-FUERA-DEL-CORTE` | Declaradas en `auto-blindaje.md` |
| `MI-8` (el secreto no cargado) | Abierto y **no bloquea**: medido en prod, sale `CONFIG(3)` nombrando la env |

---

## Veredicto final

✅ **APROBADO PARA DONE.**

- **10/10 ACs PASS**, todos con evidencia **ejecutada**, ninguno con sólo una cita.
- **Gate del repo verde**, corrido por mí completo y en orden sobre árbol limpio:
  `tsc 0` · `lint 520` · `314/320` archivos · `6350/6369` casos.
- **Corrida real contra producción**, las dos mitades, coste 0 USDC, coincidiendo exactamente con lo
  esperado.
- **Sin drift silencioso.** Los 4 archivos fuera del Scope IN y los 3 desvíos del contrato del W0
  están **declarados por escrito** y los evalué uno por uno: dos son mejoras de atribución, uno es
  una adición, y **uno deja el texto de AC-4 más fuerte que la implementación** (§8.2).

**Dos cosas que DONE tiene que hacer, y no son opcionales:**

1. 🔴 **Las 5 citas podridas de `_INDEX-row.md`, que YA ESTÁN PUBLICADAS en `doc/sdd/_INDEX.md:223`**
   — con los 5 números correctos derivados en §9, y **la frase de la #5 reescrita**, porque esta HU
   la volvió falsa. Al final, después del último movimiento de líneas. Y borrar `_INDEX-row.md`.
2. 🟡 **Amendar el texto de AC-4** para que describa lo que el chequeo hace de verdad (§8.2).
