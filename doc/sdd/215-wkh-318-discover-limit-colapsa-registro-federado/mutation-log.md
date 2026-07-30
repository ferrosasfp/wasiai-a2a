# Mutation log — WKH-318 (corte A)

Evidencia de la disciplina de mutación del story file §9 / CD-12. Existe porque
un KILLED que sólo vive en el transcript de una sesión **no se puede citar en
F4**: acá quedan las tres cosas que el story file exige por mutante — que la
mutación **aterrizó** (hash), que **compiló** (`tsc` completo y limpio, un
mutante que no compila no cuenta), y **qué test lo mató, por nombre**.

## Cómo se corrió

Driver: `scratchpad/run_mutants.py`, un mutante por vez, secuencial. Por cada uno:

1. respaldo por `shutil.copyfile` (nunca `git checkout --`: esta HU crea archivos
   untracked y ese comando ya borró trabajo sin commitear en este repo);
2. reemplazo de texto con `assert count == 1` — si el texto original no aparece
   exactamente una vez, el mutante se reporta `ERROR` y no se corre;
3. **prueba de que aterrizó**: `md5` del archivo distinto del respaldo;
4. `npx tsc --noEmit` **completo**;
5. corrida del archivo de test nominado con reporter JSON, y extracción de los
   nombres de los tests en rojo;
6. restauración por copia + `assert md5 == original` (si falla, el script aborta).

Árbol limpio antes y después (`git status --porcelain` vacío en ambos extremos).

## Sobre qué árbol

**Post fix-pack del AR** (commits `61a913f` + `ac90288`). Los hashes de la corrida
anterior (pre-fix-pack) quedaron obsoletos cuando BLQ-1 y BLQ-2 cambiaron
`discovery.ts`, así que **los 11 originales se re-corrieron enteros** en vez de
copiarse. Se agregaron 5 mutantes nuevos (M26–M30) para los guards que introdujo
el fix-pack, que si no quedaban sin cubrir por esta disciplina.

## Resultado: 16/16 KILLED

| # | Archivo | Mutación | md5 mutado | `tsc` | Tests que lo matan |
|---|---|---|---|---|---|
| **M1** | `services/discovery.ts` | `registries` vuelve a la lista de CONFIGURADOS (el código de hoy) | `683baaec` | limpio | `T-SRC-01`, `T-SRC-02`, `T-SRC-03`, `T-SRC-07`, `T-SRC-04/ssrf_blocked` |
| **M2** | `services/discovery.ts` | en el `catch` del fanout, `rows: 0` en vez de `rows: null` | `56bff69f` | limpio | `T-SRC-01`, `T-SRC-04/circuit_open`, `T-SRC-04/timeout` |
| **M2b** | `services/discovery.ts` | filtro `>= 0` (off-by-one: incluye fuentes que no aportaron) | `3afcfe6d` | limpio | `T-SRC-01`, `T-SRC-02`, `T-SRC-03`, `T-SRC-05`, `T-SRC-07`, `T-SRC-09`, `T-SRC-04/ssrf_blocked` |
| **M3** | `services/discovery.ts` | quitar el `.catch` del fanout (propagar la excepción) | `9089a95a` | limpio | `T-SRC-01`, `T-SRC-03`, `T-SRC-07`, `T-SRC-04` (×4 casos) |
| **M4** | `services/discovery.ts` | payload no-array como éxito vacío en vez de `bad_payload` | `be545a94` | limpio | `T-SRC-04/bad_payload` |
| **M5** | `routes/capabilities.ts` | quitar `registries` del payload de `/capabilities` | `4a6d9553` | limpio | `T-SRC-06` |
| **M6** | `services/discovery.ts` | ignorar el cursor (borrar el bloque de `nextCursorPath` entero) | `360c0c9f` | limpio | `T-TRUNC-01`, `T-TRUNC-02`, `T-TRUNC-02b`, `T-TRUNC-06`, `T-TRUNC-07`, `T-TRUNC-08` |
| **M7** | `services/discovery.ts` | tratar la PRESENCIA de la clave como declaración de completitud | `687bd26c` | limpio | `T-TRUNC-02` |
| **M8** | `services/discovery.ts` | `>` en vez de `>=` en la heurística `page_full` | `81152ec1` | limpio | `T-TRUNC-03` |
| **M9** | `services/discovery.ts` | marcar `truncated` siempre que se haya enviado un límite | `a4b6d608` | limpio | `T-TRUNC-04` |
| **M10** | `services/discovery.ts` | sacar el cálculo de `sentLimit` del gate (mandar `limitParam` siempre) | `cca45d59` | limpio | `T-TRUNC-02`, `T-TRUNC-05` |
| **M26** | `services/discovery.ts` | **BLQ-1**: volver a declarar `ok` sin evidencia | `77506648` | limpio | `T-SRC-08`, `T-SRC-08b` |
| **M27** | `services/discovery.ts` | **BLQ-2**: re-poner el gate `localAgents.length > 0` | `2bc53e90` | limpio | `T-SRC-01`, `T-SRC-02`, `T-SRC-05`, `T-SRC-09`, `T-SRC-10` |
| **M28** | `services/discovery.ts` | **BLQ-2**: el SELECT local caído se declara `ok`/`rows: 0` | `f3151077` | limpio | `T-SRC-09`, `T-SRC-12` |
| **M29** | `lib/discovery-sources.ts` | **BLQ-1**: sacar el escalón `unverified` del roll-up | `3758cdb5` | limpio | `T-LIB-02` |
| **M30** | `services/discovery.ts` | **MNR-G**: volver a leer `0`/`false` como cursor | `45893db6` | limpio | `T-TRUNC-02`, `T-TRUNC-02b` |

Hash del árbol sano al que se restauró después de cada mutante:
`services/discovery.ts` y `routes/capabilities.ts` verificados por `md5` contra su
respaldo en los 16 casos.

## Correcciones a la tabla del story file

Tres, todas verificadas corriendo el mutante y mirando **qué test se puso rojo**,
no infiriéndolo del diseño:

1. **M2b NO lo mata `T-SRC-05`.** El story file lo nomina ahí. `T-SRC-05` es el
   camino feliz con una fuente `ok`/`rows: 3`, y con `>` o con `>=` da el mismo
   `['test-registry']`. Los que lo matan de verdad son `T-SRC-02` (una fuente `ok`
   con `rows: 0` pasaría a figurar) y `T-SRC-01`/`T-SRC-07` (una `failed` con
   `rows: null`, porque `null ?? 0` es `0`).
   *(Nota: en la corrida post-fix-pack `T-SRC-05` sí aparece entre los rojos de
   M2b, pero por otro motivo — ahora asserta la fila local `rows: 0`, que el
   mutante también rompe. La nominación original seguía siendo incorrecta.)*
2. **M5 se mata desde `capabilities.inbound-chains.test.ts`**, no desde
   `discovery.sources.test.ts` como dice el story file. `T-SRC-06` vive ahí
   porque necesita levantar la ruta.
3. **M6 hay que reformularlo para que compile.** La primera formulación
   (`if (false && schema.nextCursorPath)`) dejaba `tsc` **ROTO**, así que por §9
   **no contaba como KILLED** aunque los tests fallaran. Se reformuló borrando el
   bloque entero, que sí compila. Es exactamente el caso que la regla "un mutante
   que no compila no cuenta" existe para atrapar.

## Lo que esta tabla NO prueba

- No es cobertura: un mutante muerto dice que **ese** cambio se detecta, no que
  la línea esté bien. La cobertura de línea de los guards nuevos se midió aparte
  (leaf `discovery-sources.ts` 100%, `routes/capabilities.ts` 100%).
- No cubre W3/W4: **M11–M25 del story file no se corrieron** porque su código no
  existe todavía (clamp y money-path estricto son corte B).
