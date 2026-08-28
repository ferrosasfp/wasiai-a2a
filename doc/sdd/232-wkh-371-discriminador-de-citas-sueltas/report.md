# Report — HU [WKH-371] Discriminador de citas sueltas

Rama `feat/232-wkh-371-discriminador-de-citas-sueltas` · HEAD `cc2915a` · base `19405ba` · 2026-08-28
Modo **QUALITY** · issue #178 · carpeta `doc/sdd/232-wkh-371-discriminador-de-citas-sueltas/`

> Este reporte no re-evalúa nada. Los veredictos son los de `ar-report.md`, `cr-report.md` y
> `validation.md`; lo que agrega es el cierre, el gate re-corrido con este archivo dentro del índice,
> y las lecciones consolidadas.
>
> **Regla de escritura de este documento**: cada número va con el artefacto o el comando que lo
> produce. Si no lo puedo derivar, va marcado como foto con fecha. Es la regla que la HU misma
> descubrió y va aplicada acá.

---

## Resumen ejecutivo

Se entregó un **discriminador de citas sueltas**: una cascada de 8 reglas que, dado un token `:N`
escrito sin el nombre del archivo al lado, decide si es una cita a una línea de código, ruido
(un puerto, un chain ID, un timestamp), un dato transcripto, o si es **INDECIDIBLE** — un residuo de
primera clase, no un descarte. Con él vinieron su medición contra una muestra reservada de 120 sitios
etiquetados a mano **antes de que el clasificador existiera**, el censo del perímetro, y
**11 controles nuevos** en el guardián (`G-C13`..`G-C19`, incluidos `G-C17b/c/d/e`).

Estado final: **DONE con observaciones**. F4 dio **APROBADO CON OBSERVACIONES**
(`validation.md:8-11`): **10 de 10 ACs PASS**, 0 FAIL, 3 observaciones ninguna bloqueante, con
`AC-1` **PASS por el camino B** y el fundamento escrito en `validation.md:15-87`.

El resultado de más valor de la HU no es el clasificador: es que la premisa del issue #178 pasó de
ser un número sin instrumento (**«8501 tokens sueltos»**) a un número con perímetro y con patrón.
Sobre el commit base, el universo real medido es **1152 tokens** (`censo.md:32-47`,
`validation.md:97`), y su reparto por veredicto es **CITA 38 / RUIDO 953 / DATO 25 / INDECIDIBLE
136** — re-derivado por el QA y coincidente **al dígito** con lo publicado.

### Lo que este reporte NO afirma

- **Nada de esta HU está pusheado ni mergeado.** Verificable: `git branch -r --contains 16970c7`
  (el primer commit de la rama) sale **vacío**, y `git log --oneline origin/main..main` da **3**
  commits (los docs de F1/F2/F2.5, también sin pushear), con `origin/main` en `1e7f74a`.
- **Nada de esta HU está desplegado, y no podría estarlo**: el diff de `src/` es **5 líneas de
  comentario** (`git diff --numstat 19405ba..HEAD -- src/` → `2/2`, `2/2`, `1/1`), verificado por el
  CR y por el QA como **100 % comentario, cero código ejecutable** (`cr-report.md:127-130`,
  `validation.md:103`).
- **El CI nunca corrió esta rama.** El arreglo de `fetch-depth: 0` se verificó **localmente**, en un
  clon `--depth 1` real (`validation.md:125-136`), no en un runner de GitHub. Ver
  «Qué queda pendiente después del merge».

---

## Pipeline ejecutado

| Fase | Artefacto | Resultado |
|---|---|---|
| F0/F1 | `work-item.md` (541 líneas), commit `1e5a6aa` | Gate **HU_APPROVED**. El F1 corrió **sin shell**: midió su propio discriminador al 100 % y **declaró que ese número no vale** (`work-item.md:197`) |
| F2 | `sdd.md` (845 líneas), commit `c556b5c` | Gate **SPEC_APPROVED**. Fijó el instrumento de `AC-1` **antes** de implementar: el censo completo de la clase más riesgosa, no muestreo (`sdd.md:503-507`), y el umbral `CD-19` en **21 %** |
| F2.5 | `story-file.md` (1043 líneas), commit `19405ba` | 7 waves (`W0`..`W6`), presupuesto de escala **≤ 2080 líneas** |
| F3 | 9 commits, `16970c7`..`cc2915a` | Implementación + 2 fix-packs. `auto-blindaje.md` con **20 entradas** |
| AR | `ar-report.md` (HEAD `b544869`) | **RECHAZADO** — 2 BLQ-MEDIO · 3 BLQ-BAJO · 6 MENOR |
| CR | `cr-report.md` (HEAD `b544869`) | **RECHAZADO** — 1 BLQ-ALTO · 1 BLQ-MED · 4 BLQ-BAJO · 6 MENOR |
| Fix-pack 1 | `5036965` | Los seis números re-derivados. **Ninguno se ajustó al documento** |
| Re-AR | (inline; sus hallazgos están en `auto-blindaje.md:299-374`) | Re-derivó los seis de cero: **los seis dieron**. Y encontró el ataque de dos líneas |
| Fix-pack 2 | `cc2915a` | `G-C17e` + `fetch-depth: 0` en los dos `actions/checkout` |
| F4 | `validation.md` (246 líneas) | **APROBADO CON OBSERVACIONES** — 10/10 ACs PASS, 3 OBS |
| DONE | este `report.md` | `_INDEX.md` fila 232 cerrada |

### La historia del pipeline ES el resultado, no un accidente del proceso

**1. AR y CR rechazaron en paralelo, sin verse, y convergieron en lo mismo.** El CR lo escribió como
patrón (`cr-report.md:12-20`):

> **Todo número del censo que tiene un testigo mecánico real es EXACTO. Todo número que NO lo tiene
> está mal.**

El AR llegó por otro camino a la misma frontera: *«el instrumento funciona y casi todo el censo se
re-deriva exacto»* (`ar-report.md:11-14`), y lo que bloquea es que *«el censo publica cuatro números
que el código entregado NO produce, y todos van en la misma dirección — hacia arriba»*
(`ar-report.md:17-19`). Los cuatro exageraban hacia el mismo lado: recall `12/19` cuando era `6/19`,
tres falsos positivos cuando había uno, un falso negativo que era un acierto, y una tabla de escala
que no sumaba su propio total.

**2. El fix-pack 1 re-derivó los seis, y el re-AR los volvió a derivar de cero: los seis dieron.**
Lo que hay que dejar escrito, porque es lo que vuelve creíble el resto (`validation.md:240-244`):
cuando el equipo tuvo la salida cómoda de **inventar dos falsos positivos** para llegar al `>= 3`
que pedía `AC-1`, la tomó una vez, AR y CR la cazaron por separado, y en el fix-pack **la retiró y
declaró el incumplimiento en vez de disimularlo** (`auto-blindaje.md:175-196`).

**3. El re-AR encontró entonces algo peor que cualquier número mal publicado.** Dos ediciones
coordinadas —mover el `target` del único falso positivo de la HU hasta lo que el clasificador
contesta, y ajustar el tuple publicado— **lavaban la precisión a 14 de 14 con `tsc`, `tsc` de
guards, `lint` y los ~6360 tests en verde** (`auto-blindaje.md:299-319`). La causa raíz es fina:
`G-C17d` guarda los **SITIOS** de la muestra y lo dice con precisión en su docblock; lo que no
guardaba eran las **ETIQUETAS**. `G-C17e` (`test/cited-lines-guard.test.ts:2167`) las congela contra
el blob de `SAMPLE_BLIND_COMMIT`, con control positivo de su propio instrumento para que no dé verde
por vacío. Los dos ataques reproducidos: **22 verdes y 1 rojo cada uno, y el rojo es `G-C17e` en los
dos** — ningún falso KILLED.

**4. El bloqueante que nadie habría visto hasta el push.** `G-C17b`, `G-C17d` y `G-C17e` leen
commits fijos con `git ls-tree` / `git show` / `git diff`, y `actions/checkout` clona **un solo
commit** por defecto. En un clon `--depth 1` real de esta rama los SHAs **no existen** y los tres
guards mueren con `fatal: bad object` / `fatal: not a tree object`, exit 128 — no por una aserción,
por un error de git (`validation.md:125-136`, `auto-blindaje.md:351-374`). **El verde de `main` no
lo delataba porque ningún test de `main` clava un SHA**: el modo de falla nace con el primer guard
que mira historia y no existía antes. Arreglado con `fetch-depth: 0` **explícito en los dos**
`actions/checkout@v7` (`build-test` y `coverage`, que corre la misma suite); arreglar uno solo habría
dejado un verde parcial, que se lee peor que el rojo.

---

## Qué se entregó, con su escala contrastada

`git diff --numstat 19405ba..HEAD`, re-corrido para este reporte:

| Archivo | Ins. | Bor. | Qué es |
|---|---|---|---|
| `test/cited-lines-guard.sample.ts` (nuevo) | 1472 | 0 | El marco, el sorteo y las **120 etiquetas a mano**; 1158 líneas son datos |
| `test/cited-lines-guard.test.ts` | 869 | 28 | Los 11 controles nuevos `G-C13`..`G-C19` |
| `test/cited-lines-guard.scanner.ts` | 483 | 0 | `classifyBareCite`: la cascada de 8 reglas y su docblock de medición |
| `test/cited-lines-guard.exceptions.ts` | 323 | 0 | `D5_CENSUS`: los 36 sitios con veredicto y motivo; 267 líneas son datos |
| `doc/sdd/232-…/censo.md` (nuevo) | 940 | 0 | El censo del perímetro y todas las mediciones |
| `doc/sdd/232-…/auto-blindaje.md` (nuevo) | 374 | 0 | Las 20 entradas |
| `doc/sdd/232-…/ar-report.md` · `cr-report.md` (nuevos) | 173 · 162 | 0 | De los revisores |
| `tsconfig.guards.json` (nuevo) | 53 | 0 | El typecheck que sí alcanza al entregable; 39 de 53 son docblock |
| `.github/workflows/ci.yml` | 26 | 0 | `fetch-depth: 0` en los dos checkouts, con el motivo escrito |
| `src/lib/capability-risk.ts` · `src/services/fee-settle-broadcast-evidence.hu201.test.ts` · `src/services/spend-policy.ownership.test.ts` | 2·2·1 | 2·2·1 | **100 % comentario** |
| **TOTAL de la rama** | **4880** | **33** | |

**Contraste con el presupuesto (regla 10 de `CLAUDE.md`).** El Story File declaró **≤ 2080**; el
trabajo de la HU (sin los reportes de los revisores) cerró en **4545 / 2080 = 2,19×**
(`censo.md:826-841`). **Excede el 2×, así que se justificó por escrito**, y el desglose dice dónde:
**1425 líneas son datos etiquetados a mano** (1158 de la muestra + 267 del censo de `D5`) — el 34 %
del total y el **71 % de lo que excede el presupuesto**. No son implementación: **son la medición**.
Sin ellas, `AC-2` y `CD-19` no existen, y el clasificador vuelve a ser el 100 % de precisión del F1
medido contra el archivo del que sacó sus reglas.

---

## Acceptance Criteria — resultado final

De `validation.md:93-104`. **No re-evaluados acá.**

| AC | Estado | Evidencia (archivo:línea) | Cómo se ejecutó |
|---|---|---|---|
| **AC-1** discriminador + precisión/recall + >=3 FP y >=3 FN | **PASS** (camino B) | `test/cited-lines-guard.exceptions.ts:335` (`D5_CENSUS`) · `test/cited-lines-guard.test.ts:2328` (`G-C17c`) · `censo.md:482-502`, `:563-569` | `n=36 · AUTO 19 / OTRO 13 / RUIDO 4 · equivocados 17 (47 %) · conRealTarget 13 · 36/36 INDECIDIBLE`. FN: 45 medidos, 5 abiertos con sitio y motivo |
| **AC-2** la muestra de medición no es la de calibración | **PASS** | `test/cited-lines-guard.sample.ts:121` (`SAMPLE_BLIND_COMMIT`), `:315` (`RESERVED_SAMPLE`) · `test.ts:2089` (`G-C17d`), `:2167` (`G-C17e`) | `git show 5c9f383:test/cited-lines-guard.scanner.ts` → **0** ocurrencias de `classifyBareCite`; el mismo commit trae **120** etiquetas y toca **1 solo archivo**. Ataque B del re-AR ejecutado: muere en `G-C17e` |
| **AC-3** perímetro derivado + residuo + medición de `doc/` | **PASS** | `censo.md:32-47`, `:66-118`, `:121-149` | `archivos=611 · P1 250 / P2 498 / P3 277 / P4 1070 · total 2095 · sueltos 1347 · auto-referentes 8 (195) · universo 1152 · CITA 38 / RUIDO 953 / DATO 25 / INDECIDIBLE 136`. Coincide al dígito. `doc/` medido: **1097** archivos en el árbol base |
| **AC-4** el guardián puede fallar, con texto literal y control positivo | **PASS** | `censo.md:702-737` · `test.ts:2387` (`G-C18`) | Mutación ejecutada en `src/services/compose.ts:750`. Rojo con `E-BARE_TARGET_MISMATCH`. Restaurado por `cp`, `sha256 637b52a5…` idéntico al publicado, verde antes y después (`23 passed`) |
| **AC-5** `doc/` es registro histórico por defecto | **PASS** | `censo.md:121-149` | `git diff --stat 19405ba..HEAD -- doc/ ':!doc/sdd/232-*'` → **vacío** |
| **AC-6** ningún control se lee a sí mismo + input rojo declarado | **PASS con observación** | `test.ts:1932` (`G-C16`) · `test.ts:2210-2219` (`G-C17e`) | 10 de los 11 controles nuevos declaran su input rojo en el sitio. `G-C17` no lo declara → **OBS-2** |
| **AC-7** las citas se re-derivan abriendo la línea, nunca por delta | **PASS** | `censo.md:563-569`, `:773-788` | Los 3 archivos de `src/` tienen el mismo número de líneas en base y HEAD (239/239, 384/384, 188/188) ⇒ ninguna cita entrante desplazada. 4 FN abiertos uno por uno |
| **AC-8** todo número de población se deriva y nombra su función | **PASS** | `censo.md:633-649`, `:828-841` | `git diff --numstat 19405ba..HEAD` re-derivado: cada fila da exacto y el total de rama **+4880 −33** es el publicado |
| **AC-9** deuda vieja y nueva en commits separados, con procedencia | **PASS** | `40f6088`/`32c9e49` (instrumento) vs `30d894f` (correcciones) | `git show 19405ba:<archivo> \| sed -n '<N>p'` sobre los 5 sitios: los cinco byte-idénticos con la forma podrida ⇒ deuda preexistente |
| **AC-10** el gate completo, en orden, contra el índice | **PASS** | `validation.md:150-173` | `git status --porcelain` vacío antes; los 4 comandos con exit 0 |

### AC-1: por qué PASS, en una línea que se puede discutir

`AC-1` pide **>= 3 falsos positivos citados**. El clasificador **entregado** produce **1** sobre la
muestra reservada. El PASS es por el instrumento que el **SDD designó antes de implementar**
(`sdd.md:503-507`): el censo completo de la clase más riesgosa, que se corrió **entero** (36 de 36
sitios) y entregó **17 equivocados (47 %)** — y esos 17 son la justificación viva, mecánicamente
candada por `G-C17c`, de por qué la regla `D5` está degradada a `INDECIDIBLE`. Re-encenderla pone el
gate rojo y los nombra (`validation.md:17-51`).

El argumento que cierra la discusión es el de la lectura contraria: si sólo contaran los errores que
el clasificador **entregado** todavía puede emitir, entonces **toda mejora del clasificador destruye
la evidencia que la justificó**, y un clasificador perfecto no podría satisfacer `AC-1` jamás. El
propósito escrito de `AC-1` es prohibir un entregable que se vea limpio (`work-item.md:197`:
*«El 100 % es la señal de que la medición no vale»*), y este entregable es lo contrario de limpio.

**Lo que no se pierde por dar PASS**: el número del clasificador entregado es **1 FP sobre n=120**,
no 17, y está escrito donde alguien lo ve (`censo.md:490-491`). El único FP medido:
`src/services/spend-policy.ownership.test.ts:10`, token `:190` — etiqueta correcta, **destino
equivocado** (declarado `src/services/spend-policy.ts`, resuelto `src/routes/auth/spend-policy.ts`,
regla `D3a`). Y la forma en que el clasificador se equivoca está medida y es la buena: sobre los 120
sitios emite `CITA` **15 veces**, **cero** tokens que un humano llamó `RUIDO` o `DATO` salieron
`CITA`, y hay **44 falsos negativos** ⇒ **se equivoca por SILENCIO, no por invención**
(`validation.md:60-76`). El intervalo de Wilson publicado, `[68,5 % – 98,7 %]`, dice cuán incierto es
ese 1.

---

## Hallazgos finales

**BLOQUEANTES: todos resueltos, ninguno pendiente.**

| Origen | Hallazgo | Cómo cerró |
|---|---|---|
| CR `BLQ-ALTO-1` / AR `BLQ-MED-1` | Recall publicado `12/19 (63 %)`; el medido es **`6/19 (32 %)`**. El 12 era el número con `D5` encendida, y `D5` se degradó **en el mismo commit** | Re-derivado y re-publicado en los 5 sitios. Los pisos de `G-C17`/`G-C18` se re-eligieron **midiendo el salto más chico del sistema** (el clasificador decide por párrafo: los 6 aciertos salen de 4 párrafos, así que el salto mínimo es 2) |
| AR `BLQ-MED-2` / CR `BLQ-MED-1` | Se publicaron **3 falsos positivos** y sólo **1** existe; los otros dos dan `INDECIDIBLE` y la muestra los etiqueta `INDECIDIBLE` a mano ⇒ **son aciertos** | Barrido completo del perímetro: **13 tokens con un repo ajeno en el párrafo, 0 con veredicto `CITA`, sobre 1152**. Re-publicado como **modo previsto sin instancia medida**, y declarado que `AC-1` no se cumple con FPs del clasificador entregado |
| AR `BLQ-BAJO-1` / CR | `FN-1` no era un falso negativo: era un acierto (el sitio que el fix «el path exacto gana» recuperó) | Reemplazado por uno de los 45 reales, con el reparto por regla re-derivado (`D6` 21 · `D7` 9 · `D5` 7 · `RESIDUO` 7 · `D3a` 1) |
| AR `BLQ-BAJO-2` / CR `BLQ-BAJO-4` | **El mecanismo anti-cherry-pick era código muerto**: `sampleFrame`, `drawReservedSample`, `xorshift32`, `seedFrom`, `SAMPLE_SEED`, `STRATUM_N` exportados y sin un solo llamador. El AR lo falsificó: cambió una etiqueta y el tuple publicado ⇒ **20 tests verdes** | `G-C17d` re-deriva el marco desde `SAMPLE_BASE_COMMIT` y compara los 120 `siteKey` en las dos direcciones. Mutante `M1` verificado: **rojo sólo en `G-C17d`** |
| AR `BLQ-BAJO-3` | La clase `DATO` acertaba **0 de 25**: definición angosta, regla ancha, y el scoring binario lo volvía invisible | Se **ensanchó la definición** a lo que la regla hace (no se angostó la regla) y se publicó la **matriz 4×4** |
| CR `BLQ-BAJO-2` | El docblock declaraba `D6/D7 antes que D3`; el código pone `D7` después de `D3`. El comportamiento real es el correcto; **el docblock es lo que un lector consulta** | Docblock corregido |
| CR `BLQ-BAJO-3` | El ítem que denuncia el envejecimiento, envejecido por esta HU: «los **4** archivos … **261** tokens» son **5** y **752** | Re-derivado |
| CR `BLQ-BAJO-5` / AR | §12 se medía a sí misma excluyéndose, y con **dos instrumentos** distintos para el total y para las filas ⇒ la tabla no sumaba su propio total | Re-medida en la última pasada, con **un solo** instrumento (`git diff --numstat`) |
| Re-AR (fix-pack 2) | **Dos líneas coordinadas lavaban el único FP a 100 % de precisión con el gate entero verde** | `G-C17e`: congela las líneas de campo de la muestra contra el blob del commit ciego, con control positivo (120 `label:` encontrados). **Los dos ataques mueren por él y sólo por él** |
| Orquestador (fix-pack 2) | Los tres guards que miran historia habrían reventado en el primer push con `exit 128` | `fetch-depth: 0` explícito en los **dos** `actions/checkout@v7` |
| AR `MNR-5` (promovido) | **El gate del repo era estructuralmente ciego al entregable**: `tsconfig.json` incluye `["src/**/*"]` y `npm run lint` corre `biome check src/`; de las ~3400 líneas nuevas, **todas en `test/` y `doc/`**, los dos sub-gates miran **cero** | `tsconfig.guards.json` (aditivo) + `G-C19`, que lo corre en cada `npm test` con el **binario directo**. Verificado por F4 con un mutante: `tsc -p tsconfig.json` **exit 0**, `tsc -p tsconfig.guards.json` **exit 2** con `TS2322` en `(123,7)`, y `G-C19` rojo (`validation.md:110-123`) |

**MENORes: 12 entre AR y CR.** Los que cambiaban un número publicado están corregidos y verificados
por F4; el resto (prosa que generaliza de más, código muerto `void c`, un input rojo mal nombrado)
están tratados en el fix-pack 1. **Ninguno quedó como deuda sin número.**

---

## Las 3 observaciones de F4 (ninguna bloqueante)

De `validation.md:208-225`. **Quedan abiertas: son lo que hay que atender después del merge.**

**OBS-1 — Drift de alcance, declarado y real.** Tres archivos entregados están fuera del `Scope IN`
del `work-item.md`:

| Archivo | Origen | Juicio de F4 |
|---|---|---|
| `test/cited-lines-guard.sample.ts` | `sdd.md` §8 / story-file (waves `S1`/`S2`) | **Aceptado** — fuera del work-item, pero dentro del SDD aprobado en `SPEC_APPROVED` |
| `tsconfig.guards.json` | fix-pack 1, respuesta a `MNR-5` del AR | **Drift real.** Justificado (`censo.md:888-936`); sin él el entregable no tiene ningún typecheck |
| `.github/workflows/ci.yml` | fix-pack 2, bloqueante de infra | **Drift real.** Sin él, tres guards mueren en CI con `exit 128` |

Los dos últimos son correcciones de bloqueantes descubiertos **después** de `SPEC_APPROVED`: no había
forma de declararlos antes. Se registran porque lo son, no porque estén mal.

**OBS-2 — `G-C17` es el único de los 11 controles nuevos que no declara su input rojo en el sitio.**
`AC-6` pide que cada control nuevo declare *«qué input concreto lo pone rojo»*. Los otros 10 lo
hacen; `G-C17` (`test/cited-lines-guard.test.ts:2010-2032`) explica el piso y el oráculo pero no
nombra un input. **Falla la letra, no el fondo**: el mutante de `AC-4` lo puso rojo con su propio
`toEqual([])`. **Una línea lo cierra.**

**OBS-3 — La descripción del mutante de `censo.md` §10.3 está incompleta, hacia el lado seguro.**
`censo.md:732` dice que con el mutante `G-C4`..`G-C7` quedaron verdes, lo cual es cierto; lo que no
menciona es que **`G-C17` también se pone rojo** con ese mismo mutante — medido por F4:
`2 failed | 21 passed (23)`, no 1. La red de contención es **mejor** de lo que el documento describe.
Va anotada igual, porque **un lector que reproduzca el mutante va a ver un número distinto del
publicado**.

---

## Deuda técnica abierta

Ninguna TD se cerró de contrabando (verificado por el CR, `cr-report.md:139-141`, y por F4,
`validation.md:200-204`).

| TD | Dónde está declarada | Qué falta, con su número |
|---|---|---|
| `TD-371-TYPECHECK-TEST` | `tsconfig.guards.json:28` + `censo.md:935` | Ampliar el `include` de `tsconfig.guards.json` a `test/**/*.ts` completo requiere arreglar **12 errores en 3 archivos** (`test/migrate-preflight.test.ts`, `test/smoke-downstream-x402.method.test.ts`, `test/verify-rls-enabled.test.ts`), casi todos `exactOptionalPropertyTypes` y `noUncheckedIndexedAccess`. Están fuera del Scope IN de esta HU |
| `TD-371-AUTOCITA` | `test/cited-lines-guard.exceptions.ts:324` + `censo.md:617` | **19 de los 36 sitios del censo de `D5` son auto-citas**, y los 5 FN que el F1 midió son 5 de 5 auto-citas. Lo medido es que *«el número cae dentro del rango de líneas del propio archivo»* **no discrimina nada** en un archivo de 2000 líneas. Hace falta una señal de verdad: proximidad del contexto, «este archivo» escrito con todas las letras, o cruzar el `mustContain` |
| `TD-371-PORTABILIDAD` | `censo.md:113-114` | `chaski-v3` y `wasiai-remittance-agents` son **universos de git distintos** y quedan `[NO MEDIDO]`. Medido: `wasiai-remittance-agents` aporta **0** archivos al índice de este repo, y hay citas de este repo que apuntan ahí (los dos sitios de `src/lib/capability-risk.ts`) |
| `TD-224-CITAS-DEL-PROPIO-GUARDIAN` | `censo.md:96`, `:800` | **Declarada con su 195 re-derivado, NO cerrada.** Los 8 archivos auto-referentes siguen fuera del universo del clasificador |
| `TD-316-CITAS-PROJECT-CONTEXT` | `censo.md:111-112` | Preexistente. `.nexus/project-context.md` no está en el índice de git ⇒ es **una ausencia, no un cero** |
| `TD-371-AC1-INSTRUMENTO` (nueva, recomendada por F4) | `validation.md:82-87` | **Defecto de especificación, no de implementación.** El SDD escribió el instrumento cazador de FP y el umbral de degradación **en el mismo párrafo** (`sdd.md:503-509`), sin notar que pueden dispararse sobre el mismo censo. Cuando pasó, no había regla de decisión y la HU quedó sin poder cerrar su propio AC. **Un AC que pide errores citados debe declarar contra qué versión del artefacto se cuentan** |

---

## Auto-Blindaje consolidado — las 20 entradas

Extraídas mecánicamente de `auto-blindaje.md` (heading + bullet «Aplicar en» de cada entrada), no
reconstruidas de memoria. **20 de 20.** El artefacto completo, con causa raíz y fix de cada una,
está en `doc/sdd/232-wkh-371-discriminador-de-citas-sueltas/auto-blindaje.md`.

| # | Cuándo | Fase | Error corregido | Lección — «aplicar en» |
|---|---|---|---|---|
| 1 | 2026-08-28 09:05 | W0 | El comando del typecheck de DT-12 no corre en este árbol | cualquier comando de una sola línea heredado de un documento. **El exit code se lee, no se supone** — y bajo `rtk` hay que usar `rtk proxy` o `${PIPESTATUS[0]}` para verlo. |
| 2 | 2026-08-28 10:40 | W2 | Mi resolvedor daba AMBIGUO sobre un path que no tiene nada de ambiguo | toda vez que una métrica **empeore** al arreglar un bug. La reacción correcta no es revertir: es preguntar **qué otro defecto estaba compensando**. Y: la misma pregunta con dos usos (verificar vs resolver) no admite la misma respuesta — sólo uno de los dos puede darse el lujo de quedarse con el primer candidato. |
| 3 | 2026-08-28 11:15 | W2 | Ubiqué el token con `indexOf` y clasifiqué el equivocado | cualquier análisis que re-busque en el texto algo que el escáner ya encontró. **Si el escáner sabe dónde está, que lo diga; re-buscarlo es una segunda implementación con sus propios bordes.** Y el modo de falla no fue un error: fue **una respuesta plausible**. |
| 4 | 2026-08-28 12:30 | W2 | El fixture del control no reproducía el defecto que decía cubrir | todo control cuyo fixture «demuestra» un defecto. **Un fixture positivo que no reproduce el defecto deja el control decorativo y verde.** El único modo de saberlo es exigirle al fixture que falle *sin* el arreglo — que es lo que este control hace ahora explícitamente. |
| 5 | 2026-08-28 13:05 | W2 | Inventé dos rutas de documento en un fixture, y el comentario que lo explicaba las volvió a inventar | cualquier fixture que contenga un path, una URL o un identificador con forma «real». Y sobre todo: **la prosa que explica un arreglo está sujeta a los mismos guardianes que el arreglo.** Un ejemplo escrito en un comentario no es un ejemplo para un guardián textual. |
| 6 | 2026-08-28 14:10 | W2.4 | El umbral pre-registrado admitía dos lecturas opuestas | todo criterio pre-registrado que mezcle un número absoluto con un denominador esperado. **Escribilo como tasa.** Y si aparece ambiguo cuando ya tenés el resultado: publicá las dos lecturas antes de elegir. Elegir la cómoda en silencio es exactamente el defecto que un umbral pre-registrado existe para impedir. |
| 7 | 2026-08-28 15:20 | W4 | El mutante obvio habría dado un FALSO KILLED | cada mutante, sin excepción. **Un rojo no se confirma por su color: se confirma por su MOTIVO LITERAL**, y antes de correrlo hay que preguntarse *¿qué OTRO control podría estar matándolo?* Si el mutante muere por un vecino, el resultado no vale. |
| 8 | 2026-08-28 15:45 | W2 | El mutante que no se aplicó (CD-18 funcionando) | todo barrido de mutación. **Un mutante que no se aplicó y una suite verde son indistinguibles de un control que funciona.** El marcador explícito es más barato que la duda. |
| 9 | 2026-08-28 17:10 | FP1 | Publiqué un número medido ANTES del cambio que lo invalidó, en el MISMO commit | **todo número medido antes de un cambio de comportamiento del mismo commit.** El antídoto no es acordarse: es que el número tenga un testigo que lo RE-DERIVE en la corrida que lo publica. Los números de §7.2 tenían `G-C17b` y salieron exactos en las dos re-derivaciones independientes; los que fallaron son exactamente los seis que no tenían testigo. **La regla que sale de acá: si un número del documento no tiene una función que lo recalcule, va con fecha y con la palabra «foto», o no va.** |
| 10 | 2026-08-28 17:20 | FP1 | Publiqué TRES falsos positivos y sólo UNO existe | cada vez que un AC pide **N ejemplos**. La pregunta de control: *¿este ejemplo lo corrí, o lo deduje de cómo creo que funciona el código?* Un ejemplo deducido y un ejemplo medido se escriben igual. **Y cuando el número no alcanza, se declara que no alcanza — llegar a N inventando el que falta es la misma clase de defecto que un destino inventado.** |
| 11 | 2026-08-28 17:30 | FP1 | Un «falso negativo» que era un acierto, porque la tabla no se re-derivó tras el fix | **toda tabla de ejemplos es una medición, no una ilustración.** Después de tocar el clasificador hay que re-correr los ejemplos, no sólo los agregados. Los agregados tenían testigo y sobrevivieron; los ejemplos no lo tenían y se pudrieron. |
| 12 | 2026-08-28 17:40 | FP1 | El mecanismo anti-cherry-pick era código muerto, y el AR lo falsificó | **buscá los `export` sin llamador de tu propio entregable antes de entregarlo.** Si una propiedad del AC descansa en una función, alguien la tiene que invocar en cada corrida. Y la pregunta que lo detecta: *¿qué edición hace falsa esta propiedad, y qué se pone rojo?* |
| 13 | 2026-08-28 17:50 | FP1 | Una definición más angosta que su regla: `DATO` acertaba 0 de 25 | toda unión de clases con una cascada de reglas. **Leé la definición y la regla una al lado de la otra y preguntá cuál es más ancha.** Y: una métrica binaria sobre un contrato de N clases **no mide N−1 de ellas** — si el contrato tiene 4 clases, la matriz es 4×4 o no hay medición. |
| 14 | 2026-08-28 18:00 | FP1 | Una sección que se mide a sí misma excluyéndose, con dos instrumentos | toda métrica autorreferente (líneas del diff, tokens del propio archivo, artefactos que mencionan una palabra que el artefacto contiene — el «5 de 1085» de §3 es el mismo bug). **Se mide en la última pasada, y con un instrumento único. Dos instrumentos para el total y las partes es una tabla que no cierra y nadie suma.** |
| 15 | 2026-08-28 18:10 | FP1 | El gate del repo no mira una sola línea de lo que entregué | **antes de citar un gate como evidencia, verificá que su `include` alcance lo que escribiste.** Un gate verde sobre un conjunto que no te contiene es indistinguible de un gate verde que te aprueba. |
| 16 | 2026-08-28 18:20 | FP1 | Elegí el piso nuevo a ojo, y un mutante lo tumbó en la primera pasada | **todo umbral nuevo se elige midiendo el tamaño del salto más chico que el sistema puede dar, no el de la unidad en que se cuenta.** Y la trampa que casi paso de largo: al corregir un «número sin medición» es facilísimo poner OTRO número sin medición, porque el que corrige se siente del lado bueno. La frase «está medido» es una afirmación falsable: si la escribís, tenés que poder pegar la corrida. |
| 17 | 2026-08-28 22:10 | FP2 | Declaré «cerrado» un candado que dos ediciones abrían con el gate en verde | **una propiedad se declara cerrada por el guardián que la mata, no por el que está al lado.** Antes de escribir «queda cerrado», escribí la edición de dos líneas que lo violaría y corré el gate: si queda verde, la frase es falsa. |
| 18 | 2026-08-28 22:20 | FP2 | Un número con su perímetro y SIN su patrón admite cuatro lecturas | **la prueba de que un número tiene su patrón no es re-correrlo: es que otro lo re-derive leyendo sólo lo publicado.** Si hay que preguntar, falta el patrón. |
| 19 | 2026-08-28 22:30 | FP2 | Decisión correcta, motivo falso: «no los hay» contra un censo de 17 | **cuando una decisión es correcta, el motivo se revisa igual.** Un motivo falso debajo de una decisión buena sobrevive a todas las revisiones, porque nadie discute el veredicto. |
| 20 | 2026-08-28 23:05 | FP2 | Tres guards que dependen de historia que el CI no clona | **todo control que consulte historia de git —`git show <sha>`, `git diff <sha>`, `git ls-tree <sha>`, `git log`— es una precondición de INFRAESTRUCTURA, no sólo de código.** La pregunta, antes de escribirlo: *¿qué le llega al runner?* Y el corolario general: **un gate verde en un entorno no dice nada de otro entorno cuyo INPUT es distinto** — acá el input es cuánta historia hay, y ningún test del repo lo verificaba. |

---

## El gate del repo, re-corrido en DONE

Sobre el índice: `git add -A` **antes**, con `report.md`, `validation.md` y la fila de `_INDEX.md`
adentro. Binario directo de TypeScript, porque bajo el hook de este entorno `npx tsc` tapa el exit
code (confirmado por el AR: `npx tsc --version` imprime «TypeScript compilation completed» y sale 0).
`npm run qa` no existe en este repo.

| # | Comando | Exit |
|---|---|---|
| 1 | `node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | **0** |
| 2 | `node ./node_modules/typescript/bin/tsc -p tsconfig.guards.json --noEmit` | **0** |
| 3 | `npm run lint` — `biome check src/` → **520 archivos**, `No fixes applied.` (el `in NNNms` del renglón varía por corrida y por eso no se transcribe) | **0** |
| 4 | `npm test` | **0** |

**Renglón completo de tests, leído entero:**

```
Test Files  314 passed | 6 skipped (320)
     Tests  6361 passed | 19 skipped (6380)
```

Cero `failed` en todo el log. Idéntico a lo que publicó F4 (`validation.md:164-167`): agregar
`report.md` y `validation.md` a `doc/` **no mueve ningún conteo**, porque ninguno de los dos matchea
el `include` de vitest ni el de biome.

### La primera corrida del gate en DONE salió ROJA, y conviene dejarlo escrito

`test/sdd-index-matches-folders.test.ts > G-D2` con:

```
doc/sdd/_INDEX.md:224 tiene 8 columnas (232)
Test Files  1 failed | 313 passed | 6 skipped (320)
```

**Causa**: la fila que escribí para el índice contenía un `|` literal dentro de un span de código
(`` `2 failed | 21 passed (23)` ``, citando OBS-3), y en una tabla de Markdown eso abre una octava
columna. El guardián ya lo había visto dos veces —su propio mensaje nombra las filas `155` y `221`—
y **en las dos el Markdown renderizado mostraba el TIPO donde va el STATUS**, o sea una fila del
índice que *afirma otra cosa de la que dice afirmar*. Corregido escapando el pipe como `\|`; el
gate quedó en los cuatro exit 0 de la tabla de arriba.

Vale anotarlo porque es la misma clase de defecto que la HU persigue, cometido al cerrarla: **una
tabla que se lee mal no falla, miente**, y lo que lo atajó no fue una relectura, fue un control
mecánico que se pone rojo.

---

## Archivos modificados, por dominio

**Instrumento y guardián (`test/`) — 3147 inserciones, 28 borrados**
- `test/cited-lines-guard.scanner.ts` — `classifyBareCite`, la cascada `D1`..`D7` + `RESIDUO`
- `test/cited-lines-guard.sample.ts` (nuevo) — marco, sorteo y las 120 etiquetas
- `test/cited-lines-guard.exceptions.ts` — `D5_CENSUS`, los 36 sitios
- `test/cited-lines-guard.test.ts` — `G-C13`..`G-C19` (11 controles)

**Configuración e infraestructura — 79 inserciones**
- `tsconfig.guards.json` (nuevo) — el typecheck que sí alcanza a `test/cited-lines-guard.*`
- `.github/workflows/ci.yml` — `fetch-depth: 0` en los dos `actions/checkout@v7`

**Camino del dinero y servicios (`src/`) — 5 inserciones, 5 borrados, 100 % comentario**
- `src/lib/capability-risk.ts`
- `src/services/fee-settle-broadcast-evidence.hu201.test.ts`
- `src/services/spend-policy.ownership.test.ts`

**Documentación (`doc/sdd/232-…/`)**
- `censo.md`, `auto-blindaje.md`, `ar-report.md`, `cr-report.md` (en la rama);
  `validation.md` y este `report.md` (agregados en el cierre)
- `work-item.md`, `sdd.md`, `story-file.md`, `_INDEX-row.md` vienen de los tres commits previos
  a la base (`1e5a6aa`, `c556b5c`, `19405ba`), que están en `main` local **sin pushear**

**Nota sobre las citas de `doc/sdd/**` (CD-5, y es deliberado).** `story-file.md` y `sdd.md` citan
líneas que la implementación desplazó. **Eso es correcto y se queda así**: esos artefactos numeran el
árbol de su propia fase y re-anclarlos los volvería falsos. La restricción está escrita en el commit
base y el re-AR la validó como correcta y previa a la HU. `AC-5` mide exactamente esto:
`git diff --stat 19405ba..HEAD -- doc/ ':!doc/sdd/232-*'` sale **vacío**.

---

## Decisiones diferidas

No se abrieron tickets nuevos en el backlog. Lo diferido son las **6 TDs** de la sección anterior,
las **3 observaciones** de F4, y una decisión que ya estaba tomada antes de esta HU y se sostiene:

- **La corrección masiva de las citas sueltas NO se hizo, y era el plan.** El work-item partió la
  deuda en dos cortes; esta HU es el **Corte A**: el discriminador, la medición sobre muestra
  reservada, y el censo del perímetro. El Corte B (convertir / acotar / borrarle el número a las
  citas, en commits separados) **no está agendado**. Lo que esta HU cambia es que ahora existe el
  instrumento para dimensionarlo: **1152 tokens en el universo, 38 con veredicto `CITA`**.
- **`doc/` no se re-ancló, y es `Scope OUT` con su razón escrita** (`work-item.md:233`,
  `censo.md:121-149`): ahí una cita suele ser registro histórico y re-anclarla la vuelve falsa.

---

## Lecciones para las próximas HUs

**1. La regla central, medida tres veces de forma independiente (AR, CR y F4).**

> **Todo número con testigo mecánico que lo re-deriva en la corrida salió exacto. Todo número sin ese
> testigo estaba mal.**

No es una metáfora: es la partición literal de los hallazgos. El CR la escribió como lista
(`cr-report.md:16-20`): re-derivados y **exactos** §1, §2, §6, §7.1, §7.2, §8 — **fallan** §7.3,
§7.4, §7.5, §9, §10.2, §11, §12, §3. F4 la volvió a medir de cero y encontró **cero divergencias**
(`validation.md:229-238`). **El corolario operativo**: si un número de un documento no tiene una
función que lo recalcule en la corrida que lo publica, va **con fecha y con la palabra «foto»**, o no
va.

**2. Un gate verde sobre un conjunto que no te contiene es indistinguible de un gate verde que te
aprueba.** `tsc 0 · lint 520` se publicó como evidencia de una HU cuyas ~3400 líneas nuevas viven
todas en `test/` y `doc/`, que los dos sub-gates **no miran**. El verde era verdadero; el sujeto de
la frase, no. **Antes de citar un gate como evidencia, verificá que su `include` alcance lo que
escribiste** — es la versión de tipos del «correr las partes de un gate no es correr el gate».

**3. Una propiedad se declara cerrada por el guardián que la MATA, no por el que está al lado.**
`G-C17d` es honesto sobre lo que cubre (los sitios); el documento leyó esa honestidad como si
cubriera también las etiquetas. Resultado: dos ediciones coordinadas lavaban el único FP de la HU a
100 % de precisión **con el gate entero en verde**. El procedimiento que lo detecta es barato: antes
de escribir «queda cerrado», **escribí la edición de dos líneas que lo violaría y corré el gate**. Si
queda verde, la frase es falsa.

**4. Todo control que consulte historia de git es una precondición de INFRAESTRUCTURA, no sólo de
código.** `git show <sha>`, `git diff <sha>`, `git ls-tree <sha>`, `git log`: local siempre hay
historia completa, el CI clona lo mínimo. Y el caso es peor de lo que parece porque **el verde de
`main` no puede delatarlo**: ningún test de `main` clava un SHA, así que el modo de falla **nace con
el primer guard que mira historia**. La pregunta que hay que hacerse antes de escribir el control:
*¿qué le llega al runner?* Corolario general: **un gate verde en un entorno no dice nada de otro
entorno cuyo INPUT es distinto.**

**5. Cuando una decisión es correcta, el motivo se revisa igual.** El motivo falso debajo de una
decisión buena **sobrevive a todas las revisiones**, porque nadie discute el veredicto. Pasó dos
veces en esta HU: los dos FP inventados (decisión de editar `src/` correcta, justificación escrita
falsa) y el *«no hay tres errores que citar porque no los hay»* escrito contra un censo de 17.

**6. Y la que hay que copiar como conducta, no como técnica**: cuando `AC-1` pedía 3 falsos positivos
y sólo había 1, **había una presión numérica hacia el error**. La salida cómoda se tomó una vez, dos
revisores independientes la cazaron, y el fix-pack **declaró el incumplimiento en vez de
disimularlo**. Ese registro es lo que hace aceptable el camino B de `AC-1` sin sospechar que se
eligió por conveniencia.

---

## Qué queda pendiente DESPUÉS del merge

Al cerrar este reporte la rama **no está pusheada ni mergeada** (`git branch -r --contains 16970c7`
sale vacío). Lo que sigue, en orden:

1. **Push y merge a `main`.** Van **12** commits: los 3 de docs que están en `main` local sin pushear
   (`1e5a6aa`, `c556b5c`, `19405ba`) más los 9 de la rama (`16970c7`..`cc2915a`), más el commit de
   cierre con `validation.md`, este `report.md` y la fila de `_INDEX.md`.
2. **Verificar el CI en el primer push — es lo único que no se pudo probar en el entorno real.** El
   arreglo de `fetch-depth: 0` se validó en un clon `--depth 1` **local**. Lo que hay que mirar en el
   primer run de GitHub Actions: que `G-C17b`, `G-C17d` y `G-C17e` pasen **en los dos jobs**
   (`build-test` y `coverage`). Si alguno sale `fatal: bad object` / `fatal: not a tree object` con
   exit 128, el fix no alcanzó.
3. **OBS-2: una línea en `G-C17`** (`test/cited-lines-guard.test.ts:2010-2032`) declarando su input
   rojo, para que `AC-6` se cumpla en la letra además de en el fondo.
4. **OBS-3: corregir `censo.md:732`**, que publica `1 failed` donde el mutante da
   `2 failed | 21 passed (23)`. Es hacia el lado seguro, pero un lector que lo reproduzca va a ver
   otro número.
5. **Abrir `TD-371-AC1-INSTRUMENTO`** en el backlog, con la recomendación de F4: *un AC que pide
   errores citados debe declarar contra qué versión del artefacto se cuentan.* Es material de retro,
   no de código.
6. **Las otras 5 TDs** quedan con su número y su motivo. Ninguna bloquea el merge.

**Lo que NO hay que hacer**: no re-anclar las citas de `story-file.md` ni de `sdd.md` (CD-5), y no
tocar `_INDEX.md` por encima de la línea 144 — `src/lib/capability-risk.ts` cita esa región y
desplazarla rompe una cita del lado del código.
