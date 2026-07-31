# Auto-Blindaje — HU-306 (WKH-306)

Errores cometidos durante la implementación, con su causa raíz y dónde más pueden
aparecer. No es una bitácora de lo que salió bien: es lo que hay que no repetir.

---

### [2026-07-29] Wave 1 — Portear el choke point sin preguntarse si el cuerpo TERMINA

- **Error**: la envoltura de `compose()` sólo miraba el `ComposeResult` devuelto
  (`if (!result.success) …`). El cuerpo del pipeline corre trabajo real **fuera** de su
  try por-step (`resolveAgent`, `getStepGasOverheadUsd`, `budgetService.debit`) y
  `getStepGasOverheadUsd` **falla-cerrado y TIRA** en mainnet sin configurar
  (`lib/gas-overhead.ts`). Con el throw propagándose, `recordStrandedRunIfAny` nunca
  corría: plata afuera, cero eventos, cero filas, cero aporte a la alerta. La HU fallaba
  entera en un escenario que el propio repo construyó a propósito.

- **Causa raíz**: se razonó el choke point sobre los **siete `return`** que el Story File
  enumeraba, y se dio por cerrado el conjunto de salidas. Un `return` es una salida
  declarada; una excepción es una salida que **no está escrita en ningún lado**. Contar
  los returns de una función no dice cómo termina la función.

- **Fix**: la envoltura declara `results` y se lo **presta** al pipeline (misma
  referencia), y envuelve el `await` entero en `try/catch`. El error **se re-lanza tal
  cual** — convertirlo en `{success:false}` cambiaría el contrato con los dos callers, y
  `orchestrate.ts` decide el reembolso del step 0 con ese contrato. Mutante M15 (borrar
  el registro del catch) muere en `T-STRAND-EMIT-05`.

- **Aplicar en**: cualquier envoltura que observe el RESULTADO de una función. Antes de
  declararla completa, preguntarse **qué pasa si esa función no devuelve**, y mirar qué
  corre fuera de sus propios `try`. Envolver el `await` entero es estructuralmente más
  fuerte que parchear cada salida: no hay lugar del que olvidarse.

---

### [2026-07-29] Wave 1 — Un escenario que el arnés de test volvía IMPOSIBLE

- **Error**: ninguna prueba podía cazar lo de arriba, y no por falta de ganas: bajo test
  `isProductionEnv()` es `false`, así que `getStepGasOverheadUsd` devuelve 0 y **nunca
  tira**. `compose.stranded.test.ts` no mockeaba `../lib/gas-overhead.js`, así que el
  camino del throw era **inalcanzable desde la suite**.

- **Causa raíz**: se asumió que "la suite no cubre X" siempre significa "falta un test".
  Existe un caso peor: **el arnés vuelve X irrepresentable**. Ahí no hay test que
  escribir hasta que se toque el arnés, y por eso el hueco no aparece ni en cobertura.

- **Fix**: mock de `gas-overhead` con default 0 (comportamiento de siempre) y sólo el
  test del throw lo cambia. El mock lleva escrito POR QUÉ existe, para que nadie lo
  saque por "innecesario".

- **Aplicar en**: ante un guard de dinero sin cobertura, verificar si el escenario es
  **representable** en el arnés antes de concluir que falta un test. Todo módulo que
  cambie de comportamiento según `isProductionEnv()` / `NODE_ENV` es candidato: bajo test
  se ve siempre la rama benigna.

---

### [2026-07-29] Fix-pack AR/CR — Un `catch` defensivo que ningún test ejercitaba (MR-4b)

- **Error**: `recordStrandedRunIfAny` quedó blindada con un `try/catch` para no poder
  lanzar, pero **hacerla re-lanzar no rompía ningún test**. El test que parecía cubrirlo
  (`T-STRAND-TRACK-THROWS`) usa `mockRejectedValue`, o sea una **promesa rechazada**, que
  se la come el `.catch()` interno: el `try` externo nunca se ejercitaba.

- **Causa raíz**: se confundió "el fallo de `track`" con **un solo modo de fallo**. Una
  promesa rechazada y un throw sincrónico entran por puertas distintas y sólo la segunda
  llega al blindaje. Un `.catch()` de promesa da la sensación de cubrir las dos.

- **Fix**: `T-STRAND-TRACK-THROWS-SYNC` — el pipeline se va por excepción
  (`GAS_ORIGINAL`), el `track` del step 0 **resuelve** y sólo el del residuo lanza
  **sincrónicamente**. Sin blindaje, el error de telemetría reemplaza el del caller. El
  mutante que re-lanza (M21) compila y muere ahí.

- **Aplicar en**: todo `.catch()` sobre una promesa que además está dentro de un
  `try/catch`. Son DOS caminos y hacen falta DOS tests. Y en general: un `catch`
  defensivo sin un test que lo ejercite es una intención, no un control.

---

### [2026-07-29] Fix-pack CR — El efecto de dinero después del mensaje de error (MENOR-5)

- **Error**: en `T-CEILING-01`, el `expect(result.error).toContain(...)` iba **antes** de
  las dos aserciones que el propio test declaraba como "EL efecto" (que no se debitó y
  que no se invocó). Bajo el mutante del techo el valor observado era un
  `Cannot read properties…`, así que el test moría en el mensaje y **las dos líneas de
  dinero nunca se ejecutaban**.

- **Causa raíz**: el orden de las aserciones se escribió siguiendo el orden en que uno
  LEE el resultado (status, error, steps, efectos), no el orden de lo que el test
  AFIRMA. En un test de dinero eso invierte la prioridad.

- **Fix**: las aserciones de dinero van primero. M9 ahora muere en
  `mockDebit … been called 1 times`, no en el texto del error.

- **Aplicar en**: todo test cuyo nombre prometa un efecto sobre plata. La aserción del
  efecto va **antes** que cualquier assert de mensaje, código o forma. Un test de dinero
  tiene que morir en la línea del dinero.

---

### [2026-07-29] Fix-pack AR — Un número derivado que ningún test ata (MENOR-2 / MENOR-1)

- **Error**: dos versiones del mismo problema. (a) `MAX_STRANDABLE_STEPS = MAX_COMPOSE_STEPS - 1`
  se podía reemplazar por el literal `4` sin romper nada — el test comparaba contra
  `MAX_COMPOSE_STEPS - 1`, que vale 4, así que no distinguía derivación de literal.
  (b) El reporte afirmaba que el máximo de steps varables era 4 cuando el guard de
  `MAX_COMPOSE_STEPS` **sólo se aplica en `routes/compose.ts`**: `/orchestrate` acota por
  `maxAgents` (hasta 20) y llama a `compose()` directo, así que ahí son 19. El reporte de
  exposición subestimaba casi cinco veces, justo en el camino insignia.

- **Causa raíz**: (a) un test de igualdad no puede fijar una DERIVACIÓN mientras los dos
  lados valgan lo mismo; hay que **mover la variable independiente**. (b) se leyó la
  constante como si fuera un límite global, sin verificar **dónde se aplica**. Un límite
  vale donde está el `if`, no donde está el `export`.

- **Fix**: (a) `T-COTA-01b` remockea `compose-limits` con `MAX_COMPOSE_STEPS: 9` y exige
  que la cota pase a 8. (b) `T-COTA-03` lee `src/routes/orchestrate.ts` y exige que todos
  los `maxAgents.maximum` coincidan con la constante; el reporte imprime los dos caminos
  y usa el peor caso.

- **Aplicar en**: cualquier constante "derivada" (test que mueva el origen) y cualquier
  límite citado en un doc o reporte (verificar sus **sitios de aplicación** con grep antes
  de afirmarlo).

---

### [2026-07-29] Observación heredada, NO se arregla acá — el push del step puede saltearse

- **Qué es**: entre el settle downstream y el `results.push` del step hay una llamada
  **sincrónica**, `recordSolanaLegIfAny(downstream)` (`src/services/compose.ts:600`, y su
  gemela del retry-ok en `:937`). Si esa lanzara sincrónicamente, el step **ya pagó** pero
  no llega a `finishSuccessfulStep` ⟹ no entra en `results` ⟹ el run se registra igual,
  pero **con un step de menos**.

- **Por qué NO se arregla en esta HU**: es **preexistente** (WKH-234), afecta sólo al rail
  Solana, y el modo de falla es el benigno para esta superficie: **subestima por uno**, no
  pierde el run. Tocarlo sería meter mano en el orden de una operación de dinero para
  mejorar un conteo de telemetría.

- **Aplicar en**: si algún día el residuo reportado no cuadra con la cadena por
  exactamente un step en un run Solana, mirar acá primero. Y como regla: toda llamada
  sincrónica entre "el dinero se movió" y "el movimiento se anotó" es una ventana donde el
  registro puede quedar corto.

---

### [2026-07-29] Herramienta — el proxy del shell miente sobre `git log` y sobre `diff`

- **Error**: la primera lectura del árbol devolvió un HEAD equivocado (`53adf4b` en vez de
  `013d04e`) porque el hook del shell filtra la salida de `git`. Y el coordinador reportó
  el mismo problema con `diff`: afirma "idénticos" sobre archivos que difieren.

- **Fix**: todo comando de lectura de estado (git log/status/show/diff) se corre con
  `rtk proxy`, que sale crudo. Para comparar contenidos, **`git diff`** (o una comparación
  hecha en Python leyendo los dos archivos), nunca `diff` a secas.

- **Aplicar en**: cualquier verificación cuyo veredicto sea "esto es idéntico a aquello".
  Si la herramienta que lo afirma está detrás de un filtro, el veredicto no vale.

---

### [2026-07-31 16:45] Fix-pack `/health` — el `if` que narrowaba era el que llevaba la política

- **Error**: al reemplazar `if (raw === undefined || raw.trim() === '')` y
  `if (thresholdUsd === null)` por `if (state === 'unset')` / `if (state === 'unreadable')`
  en `describeStrandedThresholdStartup`, `tsc --noEmit` se puso rojo dos veces seguidas:
  `value: raw` pasó a ser `string | undefined` y `value: thresholdUsd` pasó a ser
  `number | null`. Los tests seguían verdes: sólo el typecheck lo vio.

- **Causa raíz**: los dos `if` viejos hacían DOS trabajos a la vez — decidir la rama y
  estrechar el tipo. Al extraer la decisión a `getStrandedThresholdState()` (que es lo
  correcto: una sola clasificación), el compilador perdió la prueba de que abajo había un
  string y un número, porque esa prueba vivía en la forma del `if`, no en el dato.

- **Fix**: cada rama conserva su condición de narrowing como segundo disyunto
  (`state === 'unset' || raw === undefined`), con un comentario que dice explícitamente
  que NO es una segunda regla sino la misma, escrita para el compilador. No se usó `!`,
  ni `as`, ni `?? ''`: un fallback fabricado hubiera hecho que un caso imposible
  imprimiera un valor inventado en el log.

- **Aplicar en**: cualquier refactor que mueva una decisión de un `if` a una función.
  Correr `npx tsc --noEmit` COMPLETO en ese paso, no sólo los tests — el repo define
  verde como lint + tsc + tests, y este error sólo aparecía en el segundo.

---

### [2026-07-31 16:41] Fix-pack `/health` — `npx biome` no corre; el formateo se hace por script

- **Error**: `npx biome format --write <archivos>` falla con
  `npm error could not determine executable to run`, así que el lint quedó rojo por
  formato después de editar los tests.

- **Fix**: usar los scripts del repo: `npm run format` (biome format --write src/) y
  `npm run lint`. Se verificó que `format` sólo tocó los archivos de este cambio
  (`git status` sin archivos ajenos).

- **Aplicar en**: cualquier corrección de formato en este repo. `npx <tool>` no es
  equivalente al script de package.json acá.

---

*Auto-Blindaje de F3 (Dev) — NexusAgil*
