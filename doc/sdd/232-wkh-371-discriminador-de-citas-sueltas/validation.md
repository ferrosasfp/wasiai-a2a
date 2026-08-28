# Validation Report — WKH-371 · Discriminador de citas sueltas (F4)

> Materializado por el orquestador desde el reporte inline de `nexus-qa`.

Rama `feat/232-wkh-371-discriminador-de-citas-sueltas` · HEAD `cc2915a` · base `19405ba` · 2026-08-28
Ángulo de F4: **ejecutar lo que el AR y el CR leyeron.** No se re-hizo el re-AR.

## Veredicto: APROBADO CON OBSERVACIONES

`AC-1` **PASS por el camino B**, con el número del clasificador entregado escrito al lado y un
defecto de SPEC registrado. 10 ACs PASS. 3 observaciones, ninguna bloqueante.

---

## 1. El veredicto de AC-1, que es lo que el equipo dejó abierto a propósito

**`AC-1` PASS, por el camino B (el `D5_CENSUS`).** Fundamento, en orden de peso:

**(a) El instrumento no se eligió después: se fijó en `SPEC_APPROVED`.** `sdd.md:503-507` dice
textual: *«FP: se cazan en el censo COMPLETO de la clase más riesgosa, no por muestreo … W2.4 obliga
a abrir los 94 y etiquetarlos a mano»*, y agrega su propia cláusula de escape: *«Si de los 94 salen
menos de 3 FP, se declara el número real y se buscan los que falten en el estrato P3»*. El censo se
ejecutó **entero** (36 de 36 sitios, censo y no muestra) y entregó 17. La cláusula de escape del SDD
nunca se dispara. Re-derivado independiente de la suite:

```
n=36  {"RUIDO":4,"AUTO":19,"OTRO":13}  equivocados=17 (47%)  conRealTarget=13
```

**(b) El test del arreglo trucho, corrido sobre los DOS caminos.**

- El arreglo trucho del camino A es inventar los 2 FP que faltan. **No es hipotético: se intentó y lo
  mataron.** Los ex-`FP-2`/`FP-3` no reproducen, el AR y el CR los cazaron por separado, y el
  fix-pack los retiró. El camino A tiene además un segundo arreglo trucho, peor: **dejar `D5`
  encendida y cosechar sus 5 destinos inventados como FP citables.** Eso satisface el documento
  entregando un clasificador **peor** (5 destinos inventados en vez de silencio). Un AC cuya
  satisfacción exige entregar un artefacto peor se está leyendo mal.
- El arreglo trucho del camino B es real y hay que cerrarlo con evidencia, no con argumento:
  *«escribí una regla mala, censá sus errores, borrá la regla, citá los errores»*. Está cerrado por
  tres cosas verificadas: el censo lo **mandó el SDD antes de implementar** (`W2.4`), el umbral se
  escribió **antes de medir** (`CD-19`, 21 %), y `G-C17c` (`test/cited-lines-guard.test.ts:2328`)
  **re-deriva la tasa en cada corrida y además asserta que los 36 sitios siguen saliendo
  `INDECIDIBLE`**. Medido:

```
clasificador ENTREGADO sobre los 36 sitios de D5:
  llegan a D5 = 36/36 · salen INDECIDIBLE = 36/36 · salen CITA = 0
```

Los 17 no son una nota histórica: son la **justificación viva y mecánicamente candada** de por qué
`D5` está apagada. Re-encenderla pone el gate rojo y los nombra.

**(c) La lectura contraria es incoherente como criterio de aceptación.** Si sólo cuentan los errores
que el clasificador **entregado** todavía puede emitir, entonces **toda mejora del clasificador
destruye la evidencia que la justificó**, y un clasificador perfecto no puede satisfacer `AC-1`
jamás. El propósito de `AC-1` está escrito en el propio work-item (`work-item.md:197`: *«El 100 % es
la señal de que la medición no vale»*): prohibir un entregable que se vea limpio. Este entregable es
lo contrario de limpio.

**(d) Y el faltante es una propiedad MEDIDA, no un hueco de la medición.** Sobre los 120 sitios
reservados el clasificador entregado emite `CITA` **15 veces y se equivoca 1**. La matriz 4×4,
re-derivada:

```
humano\maquina   CITA  RUIDO  DATO  INDECIDIBLE
CITA               15      0     0           44
RUIDO               0     53     4            2
DATO                0      0     0            0
INDECIDIBLE         0      0     0            2
FP: src/services/spend-policy.ownership.test.ts:10 `:190`
    decl=src/services/spend-policy.ts  res=src/routes/auth/spend-policy.ts  rule=D3a
```

Cero tokens que un humano llamó `RUIDO` o `DATO` salieron `CITA`. **El clasificador se equivoca por
SILENCIO (44 FN), no por invención.** Pedirle 2 FP más le pide o una muestra mucho mayor (legítimo y
caro; el IC de Wilson `[68,5 % – 98,7 %]` ya publica cuán incierto es ese 1) o un clasificador peor.

### Lo que NO se pierde por dar PASS

1. **El número del clasificador entregado es 1 FP sobre n=120, no 17**, y el artefacto lo dice donde
   alguien lo ve (`censo.md:490-491`). Queda escrito acá también.
2. **Defecto de SPEC para la retro** — `sdd.md:503-509` escribió el instrumento cazador de FP y el
   umbral de degradación **en el mismo párrafo**, sin notar que pueden dispararse sobre el mismo
   censo. Cuando pasó, el SDD no tenía regla de decisión y la HU quedó sin poder cerrar su propio AC.
   **Es un defecto de la especificación, no de la implementación.** Recomendación:
   `TD-371-AC1-INSTRUMENTO` — un AC que pide errores citados debe declarar contra qué versión del
   artefacto se cuentan.

---

## 2. ACs, uno por uno, EJECUTADOS

| AC | Estado | Evidencia `archivo:línea` | Comando que lo ejecuta / salida |
|---|---|---|---|
| **AC-1** discriminador + precisión/recall + ≥3 FP y ≥3 FN | **PASS** (camino B) | `test/cited-lines-guard.exceptions.ts:335` (`D5_CENSUS`) · `test/cited-lines-guard.test.ts:2328` (`G-C17c`) · `censo.md:482-502`, `:563-569` | script con `tsx`: `n=36 · AUTO 19 / OTRO 13 / RUIDO 4 · equivocados 17 (47 %) · conRealTarget 13 · 36/36 INDECIDIBLE`. FN: 45 medidos, 5 abiertos con sitio y motivo |
| **AC-2** la muestra de medición no es la de calibración | **PASS** | `test/cited-lines-guard.sample.ts:121` (`SAMPLE_BLIND_COMMIT`), `:315` (`RESERVED_SAMPLE`) · `test.ts:2089` (`G-C17d`), `:2167` (`G-C17e`) | `git show 5c9f383:test/cited-lines-guard.scanner.ts` → **0** ocurrencias de `classifyBareCite`; `sample.ts` del mismo commit → **120** etiquetas; el commit ciego toca **1 solo archivo**. **Ataque B del re-AR ejecutado** (mover el `target` del único FP a lo que contesta el clasificador): `× G-C17e … Cambió una línea de SITIO o de ETIQUETA` |
| **AC-3** perímetro con su número derivado + residuo + medición de `doc/` | **PASS** | `censo.md:32-47`, `:66-118`, `:121-149` | script: `archivos=611 · P1 250 / P2 498 / P3 277 / P4 1070 · total 2095 · sueltos 1347 · auto-referentes 8 (195) · universo 1152 · CITA 38 / RUIDO 953 / DATO 25 / INDECIDIBLE 136`. Coincide **al dígito**. `git ls-tree -r --name-only 19405ba -- doc \| wc -l` → **1097**; el `grep -rlE` de §3 devuelve **exactamente los 6** archivos publicados |
| **AC-4** el guardián puede fallar, con el texto literal y control positivo | **PASS** | `censo.md:702-737` (§10.3) · `test.ts:2387` (`G-C18`) | **Mutación ejecutada** en `src/services/compose.ts:750` (`middleware` → `chain-resolver.ts`, comentario, mismas 2066 líneas). Verde antes `23 passed (23)`. Rojo: `E-BARE_TARGET_MISMATCH src/services/compose.ts:751 :634 / target declarado a mano : src/services/compose.ts / destino del contexto : src/adapters/chain-resolver.ts`. Restaurado por `cp`, `sha256 637b52a5…` idéntico al publicado en `censo.md:736`, `/usr/bin/diff` sin diferencias, verde después `23 passed (23)` |
| **AC-5** `doc/` es registro histórico por defecto | **PASS** | `censo.md:121-149` | `git diff --stat 19405ba..HEAD -- doc/ ':!doc/sdd/232-*'` → **vacío** |
| **AC-6** ningún control se lee a sí mismo + cada uno declara su input rojo | **PASS con observación** | `test.ts:1932` (`G-C16`, fixture **en memoria**) · `test.ts:2210-2219` (`G-C17e` con control positivo de su propio instrumento) | 10 de los 11 controles nuevos declaran su input rojo en el sitio. **`G-C17` (`test.ts:2010`) no lo declara** — ver OBS-2. Empíricamente sí es falsable: el mutante de AC-4 lo puso rojo |
| **AC-7** las citas se re-derivan abriendo la línea, nunca por delta | **PASS** | `censo.md:563-569`, `:773-788` | Los 3 archivos de `src/` tienen **el mismo número de líneas** en base y HEAD (239/239, 384/384, 188/188) ⇒ ninguna cita entrante desplazada. Abiertos `FN-1` (`facilitator-settle.ts:416`), `FN-3` (`fee-split.ownership.test.ts:196`), `FN-4` (`:1056`), `FN-5` (`fee-charge.ts:518`): los cuatro contienen el token citado. El citador de `FN-3` mide **395 por `wc -l` y 396 por `split('\n')`**, exactamente como publica `censo.md:567` |
| **AC-8** todo número de población se deriva y se nombra su función | **PASS** | `censo.md:633-649` (§9) · `:828-841` (§12) | `git diff --numstat 19405ba..HEAD` re-derivado: **cada fila de §12 da exacto** (`sample.ts` +1472, `test.ts` +869/−28, `scanner.ts` +483, `exceptions.ts` +323, `censo.md` +940, `auto-blindaje.md` +374, `tsconfig.guards.json` +53, `ci.yml` +26, `src/` +5/−5) y el **TOTAL de rama +4880 −33** es el publicado |
| **AC-9** deuda vieja y nueva en commits separados, con procedencia del árbol base | **PASS** | commits `40f6088`/`32c9e49` (instrumento) vs `30d894f` (correcciones, sólo `src/` + censo) | `git show 19405ba:<archivo> \| sed -n '<N>p'` sobre los 5 sitios: los cinco salen **byte-idénticos con la forma podrida** ⇒ deuda preexistente, como declara `censo.md:757`. `git diff -U0 19405ba..HEAD -- src/` leído entero: **100 % comentario**, cero código ejecutable (CD-8) |
| **AC-10** el gate completo, en orden, contra el índice | **PASS** | ver §4 | `git status --porcelain` vacío **antes** de correr. Los 4 comandos, exit codes en §4 |

---

## 3. Los checks de runtime que sólo F4 podía hacer

**3.1 · `tsconfig.guards.json` no es un config decorativo — MEDIDO.** Inyectado
`const __qa_probe: BareLabel = 'NO_EXISTE';` en `test/cited-lines-guard.scanner.ts:123`:

```
tsc -p tsconfig.json        --noEmit  →  exit 0     <- CIEGO al entregable
tsc -p tsconfig.guards.json --noEmit  →  exit 2
    test/cited-lines-guard.scanner.ts(123,7): error TS2322:
    Type '"NO_EXISTE"' is not assignable to type 'BareLabel'.
npm test                              →  × G-C19 · 1 failed | 22 passed (23)
```

Reproduce **al carácter** lo publicado en `censo.md:911-919`, incluida la posición `(123,7)`.
Restaurado, `sha256 6a1f62b7…` idéntico. §13 no exagera: `tsc` y `lint` del repo son estructuralmente
ciegos a las ~3400 líneas de esta HU, y `G-C19` es lo único que las mira.

**3.2 · El bloqueante de infraestructura (`fetch-depth`) — verificado empíricamente, los dos lados.**

```
clon --depth 1 (1 commit):
  git diff -U0 5c9f383… -- test/cited-lines-guard.sample.ts
      fatal: bad object 5c9f383ff4c62317c429a35cd78ed8165dd25829        <- G-C17e
  git show 19405ba…:src/services/compose.ts
      fatal: path '…' exists on disk, but not in '19405baf…'            <- G-C17b / G-C17c

clon completo (1234 commits):
  G-C17e: OK    G-C17b/c: OK
```

El error literal es el que el comentario de `ci.yml:29` cita. Y **los dos checkouts de `ci.yml` están
arreglados** (`:43` en `build-test`, `:119` en `coverage`), que era el modo de falla que el propio
comentario advierte. Barridos los otros 3 workflows del repo: **ninguno corre `npm test`**, así que
ninguno necesita el fix.

**3.3 · `G-C17e` mata el ataque que dejaba el gate entero en verde.** Ejecutado, no leído. Ver AC-2.

**3.4 · Materializar este `validation.md` no mueve ningún gate.** Creado, `git add -A`, corridas las
dos suites sensibles al índice (`readme-numbers`, `cited-lines-guard`): `36 passed (36)`.

---

## 4. El gate del repo, completo y en orden, sobre el índice

`git status --porcelain` **vacío** antes y después. Binario directo de TypeScript (`npx tsc` bajo el
hook de este entorno tapa el exit code, confirmado). `npm run qa` no existe en este repo.

| # | Comando | Exit |
|---|---|---|
| 1 | `node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` | **0** |
| 2 | `node ./node_modules/typescript/bin/tsc -p tsconfig.guards.json --noEmit` | **0** |
| 3 | `npm run lint` — `Checked 520 files in 224ms. No fixes applied.` | **0** |
| 4 | `npm test` | **0** |

**Renglón completo de tests, leído entero:**

```
Test Files  314 passed | 6 skipped (320)
     Tests  6361 passed | 19 skipped (6380)
```

Cero `failed` en todo el log. Contra la línea base de AC-10 (`314/320 archivos · 6350/6369 casos`):
**archivos iguales** (el `sample.ts` no matchea el `include` de vitest, como afirmaba el CR) y **+11
casos**, que son exactamente los 11 controles nuevos (`G-C13`…`G-C16`, `G-C17`, `G-C17b/c/d/e`,
`G-C18`, `G-C19`). Re-corrido el gate completo **después** de las tres mutaciones y sus
restauraciones: idéntico.

---

## 5. Drift

**Waves y commits: en orden, sin violaciones.** `16970c7` (marco y sorteo, sin etiquetas) → `5c9f383`
(las 120 etiquetas, **antes** de que exista el clasificador) → `40f6088` (discriminador + censo) →
`32c9e49` (`G-C18`) → `30d894f` (correcciones de `src/`, **commit aparte**, CD-2/AC-9) → docs →
fix-packs. La frontera que `AC-2` necesita está en el orden mismo.

**Un drift de alcance, declarado pero real (OBS-1):** tres archivos entregados están fuera del
`Scope IN` del `work-item.md`:

| Archivo | Origen | Juicio |
|---|---|---|
| `test/cited-lines-guard.sample.ts` | `sdd.md` §8 / story-file (waves `S1`/`S2`) | **Aceptado.** Fuera del work-item, pero dentro del SDD aprobado en `SPEC_APPROVED` |
| `tsconfig.guards.json` | fix-pack 1, respuesta a `MNR-5` del AR | **Drift real.** No está en el work-item ni en el SDD. Justificado y documentado (`censo.md:888-936`), y sin él el entregable no tiene ningún typecheck |
| `.github/workflows/ci.yml` | fix-pack 2, bloqueante de infra | **Drift real.** Ídem. Sin él, tres guards mueren en CI con `exit 128` |

Los dos últimos son correcciones de bloqueantes descubiertos **después** de `SPEC_APPROVED`, así que
no había forma de declararlos antes. Se registran como drift porque lo son, no porque estén mal.

**Spec drift: ninguno en la implementación.** Las 8 reglas de la cascada tienen población medida y
coinciden con `sdd.md`. `Scope OUT` respetado: `doc/` no se re-ancló, los 8 auto-referentes siguen
fuera, `CORTE_A_PATHS` sigue en 14, `CITED_LINES` sin entradas nuevas.

**Deuda: los cuatro `TD-` siguen con su número y su motivo.** `TD-371-TYPECHECK-TEST`
(`tsconfig.guards.json:28` + `censo.md:935`, con los 12 errores en 3 archivos medidos),
`TD-371-AUTOCITA` (`exceptions.ts:324` + `censo.md:617`), `TD-371-PORTABILIDAD` (`censo.md:113-114`),
`TD-224-CITAS-DEL-PROPIO-GUARDIAN` (declarada con su 195 re-derivado, **no cerrada**). Ninguna TD
cerrada de contrabando.

---

## 6. Observaciones (ninguna bloqueante)

**OBS-1 — Drift de alcance.** `tsconfig.guards.json` y `.github/workflows/ci.yml` están fuera del
`Scope IN` declarado. Justificados por escrito; se registran para la retro.

**OBS-2 — `G-C17` es el único de los 11 controles nuevos que no declara su input rojo en el sitio.**
`AC-6` pide *«cada control nuevo SHALL declarar, en el sitio, qué input concreto lo pone rojo»*. Los
otros 10 lo hacen. `G-C17` (`test.ts:2010-2032`) explica el piso y el oráculo pero no nombra un
input. **Falla la letra, no el fondo**: el mutante de AC-4 lo puso rojo con su propio `toEqual([])`.
Una línea lo cierra.

**OBS-3 — La descripción del mutante de §10.3 está incompleta, y hacia el lado seguro.**
`censo.md:732` dice que con el mutante *«`G-C4`, `G-C5`, `G-C6` y `G-C7` quedaron VERDES»*, lo cual es
cierto. Lo que no menciona es que **`G-C17` también se pone rojo** con ese mismo mutante: medido,
`2 failed | 21 passed (23)`, no 1. Es correcto que lo haga — el mutante convierte `compose.ts:751` de
`D5` a `D3b` con destino inventado, y ése es justamente el `toEqual([])` de `G-C17`. La red de
contención es **mejor** de lo que el documento describe; la incompletitud igual va anotada, porque un
lector que reproduzca el mutante va a ver un número distinto del publicado.

---

## 7. Lo que este F4 confirma del hallazgo de AR y CR

El patrón que ordenó toda la HU se sostiene medido por tercera vez y de forma independiente:

> **Todo número con testigo mecánico que lo RE-DERIVA en la corrida salió exacto. Todo número sin ese
> testigo estaba mal.**

Re-derivados de cero, sin usar la suite, los números de `§1`, `§2`, `§6`, `§7.1`, `§7.2` (incluida la
matriz 4×4), `§8` y `§12`. **Cero divergencias.** Los seis que fallaban ya están corregidos y los que
quedan sin testigo van marcados como foto con fecha, que es lo correcto.

Y el mérito que hay que dejar escrito porque es lo que hace confiable el resto: **cuando el equipo
tuvo la salida cómoda de inventar dos falsos positivos para llegar a tres, la tomó una vez, el AR y
el CR la cazaron, y en el fix-pack la retiró y declaró el incumplimiento en vez de disimularlo.** Ese
registro es la razón por la que el camino B se puede aceptar sin sospechar que se eligió por
conveniencia.

**Listo para DONE.**
