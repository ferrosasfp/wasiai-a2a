# Report — HU WKH-313 · El primer trabajo de un agente que no es nuestro (carril de estreno)

**Fecha de cierre**: 2026-07-30
**Worktree**: `/home/ferdev/.openclaw/workspace/wt-313`
**Rama**: `feat/211-wkh-313-primer-trabajo`
**HEAD**: `86216ce`
**Estado**: código DONE + REVIEWED — **NO MERGEADO** (orden de merge coordinado por el orquestador, ver sección dedicada abajo)

---

## Resumen ejecutivo

Hoy un agente recién publicado tiene score de reputación 0, y si quien consulta pide cualquier piso mayor a 0 queda excluido — nunca lo eligen, nunca acumula historial, el círculo se cierra. Eso importa especialmente ahora porque **todo agente nuevo de la incubadora nace sin historial**. Esta HU agrega un **carril de estreno** (*trial standing*) opt-in del que consulta: un agente sin historial (`newcomer`, cero liquidadas y cero fallos) puede ser admitido bajo el piso durante sus primeros `N=3` trabajos, con cupo `M=2` por publicador, techo `T=10` y anulación permanente al primer fallo de `F=2` callers distintos — sin fabricarle nunca el score (sigue ordenando último, AC-7/CD-6). Es puro opt-in del consumidor: sin `allowTrial`, el comportamiento de hoy queda byte por byte igual (AC-1, CD-9: cero queries nuevas). AR APROBADO (0 bloqueantes, tras 3 fix-packs), CR APROBADO (tras 1 fix-pack), F4 APROBADO (10/10 ACs con evidencia archivo:línea, en el reintento). El consumo del lado de Chaski (W0.3) queda **explícitamente fuera** de esta entrega — está bloqueado por una decisión del founder pendiente y vive en otro repo.

---

## Orden de merge (LEER ANTES DE MERGEAR CUALQUIER COSA)

Hay **cuatro HUs en vuelo** sobre `wasiai-a2a` que se rozan en `src/types/index.ts`. Esto es lo medido para WKH-313 específicamente:

1. **WKH-313 debe mergearse ANTES que WKH-316.** Razón medida: al momento de este cierre, `wt-316` **no tiene ninguna línea escrita** en `src/types/index.ts`. Mergear 313 primero deja a 316 re-anclando sobre un archivo ya estable, en vez de al revés.

2. **El diff de esta HU toca `src/types/index.ts` con 5 hunks aditivos (+156/-1)**, en regiones distintas del archivo:
   - `Agent` (agrega `trial?: AgentTrialAdmission`)
   - tras `AgentReputation` (agrega la interfaz nueva `AgentStandingCounters`)
   - `DiscoveryQuery` (agrega `allowTrial?: boolean | undefined`)
   - `DiscoveryResult.excluded`
   - `ComposeStepConstraints` (agrega `allow_trial?: boolean`)

3. **El punto peligroso es el único `-1`.** `excluded?: { scope: number }` **no es una inserción, es un reemplazo** por un objeto de 4 campos: `{ scope: number; reputation: number; trialAvailable: number; standingUnavailable: boolean }`. Quien mergee un segundo cambio sobre este mismo campo tiene que resolver el conflicto **a mano** y confirmar que sobreviven los cuatro campos. **El compilador caza que falten `reputation`/`trialAvailable`/`standingUnavailable` en el sitio de construcción (TS2739, como pasó en W0.1 — ver Auto-Blindaje), pero NO cazaría que alguien resuelva el conflicto dejando el tipo viejo `{ scope: number }` Y el sitio de construcción viejo a la vez: los dos versionados juntos vuelven a compilar limpio, y los tres campos nuevos desaparecen en silencio.** Verificar a ojo, no solo con `tsc`.

4. **Después de resolver cualquier conflicto en `types/index.ts`: `npx tsc --noEmit` COMPLETO**, no `npm run build` (`tsconfig.build.json` excluye los tests — precedente WKH-196).

5. **Roce con WKH-318** (no con 316): `types/index.ts:384-390`, `discovery.ts:498-507`, y un **conflicto textual casi seguro en el JSDoc de `routes/discover.ts`** — es sólo documentación, sin lógica en juego, así que el conflicto se resuelve conservando ambos bloques de comentario.

---

## Pipeline ejecutado

- **F0/F1**: `work-item.md` — diagnóstico verificado archivo:línea, tres correcciones al encuadre original del encargo (el gateway no pone piso por defecto hoy; `verified` también es un filtro opt-in, no una asimetría de forma; la asimetría real es de *alcanzabilidad de la salida*). Decisión del founder: oportunidad provisoria por cantidad de trabajos (variante de la Opción C), no por calendario.
- **F2**: `sdd.md` — Trial Standing con 4 estados (`scored`/`newcomer`/`penalized`/`unknown`), 10 ACs (7 heredados del work-item + 3 nuevos: AC-8 default-off, AC-9 fail-closed, AC-10 cupo/techo), 15 Constraint Directives.
- **F2.5**: `story-HU-313.md` — 33 tareas de scope IN, W0.3 (`chaski-v3`) marcada explícitamente **NO EJECUTAR** en esta entrega.
- **F3**: implementación en varias waves (15 commits), sobre 26 archivos de código fuente (+ 5 doc de la HU + `.env.example` + `doc/INTEGRATION.md`).
- **AR**: **APROBADO**, 0 bloqueantes — tras 4 fix-packs que cerraron 1 BLQ-ALTO (garantía de orden falsa para agentes federados) y 3 BLQ-MED/BAJO (desempate no permanente, anulación no perpetua, fail-closed que explica su motivo). Verificación por barrido de 480 combinaciones sobre la ventana de mérito (0 desviaciones) + 29/29 mutantes muertos por su test nombrado.
- **CR**: **APROBADO** — tras 1 fix-pack que cerró BLQ-MED-1 (el carril admitía a quien ya pasaba por mérito en la ventana `1..N-1`, violando CD-6) y 2 MENORes (`verified` colapsando el test insignia del orden; el bucket `'__anon__'` contado como caller).
- **F4**: **APROBADO** en el reintento — 10/10 ACs con evidencia `archivo:línea` y test nombrado; `tsc --noEmit` limpio; `biome` limpio sobre 424 archivos; suite **4452 passed / 19 skipped**; `chaski-v3` en cero bytes tocados, W0.3 no ejecutada; los 4 defaults de env coinciden entre código y `.env.example`; cero drift en el diff.

---

## Acceptance Criteria — resultado final

| AC | Enunciado (resumen) | Status | Evidencia |
|----|------|--------|-----------|
| AC-1 | El gateway nunca aplica un piso que nadie pidió; sin `minReputation` nadie se excluye, con o sin `allowTrial` | PASS | `src/services/discovery.ts:422-428`; test `T-01` (`discovery.minreputation.test.ts`) |
| AC-2 | Toda relajación del piso es visible en la respuesta (badge `trial`), nunca silenciosa; sin score fabricado | PASS | `src/services/discovery.ts` (bloque del badge, tras `trialAdmitted`); `src/types/index.ts` `AgentTrialAdmission`; test `T-02` (`discovery.trial.test.ts`) |
| AC-3 | El vacío por piso deja de ser mudo: `excluded` cuenta `reputation` (descartados) y `trialAvailable` (admisibles) | PASS | `src/types/index.ts` `DiscoveryResult.excluded`; `src/services/discovery.ts:501`; test `T-03` (`discover.minreputation.test.ts` + `discovery.trial.test.ts`) |
| AC-4 | Frontera exacta del carril: `tasksSettled = N-1` admite, `tasksSettled = N` no (pasa a depender del score real) | PASS | `src/lib/trial-standing.ts`; test `T-04` (`discovery.trial.test.ts`) |
| AC-5 | `failedCallerCount >= F` anula el carril de forma permanente, no decrementable | PASS | `src/lib/trial-standing.ts`, `src/services/reputation.ts` (`failedCallerCount`); test `T-05` (`discovery.trial.test.ts`) |
| AC-6 | Ningún leg de desembolso a persona física habilita `allow_trial` sin control compensatorio elegido por escrito | DIFERIDO (fuera de esta entrega) | CD-13; W0.3 (`chaski-v3`) explícitamente **NO EJECUTADA** — control compensatorio pendiente de decisión del founder |
| AC-7 | El score nunca se fabrica; el admitido conserva su puntaje real y ordena último | PASS | `src/services/discovery.ts` (neutralización de `verified`/`reputation` del admitido, fix-pack AR BLQ-ALTO-1); test `T-06` (orden dorado, `discovery.trial.test.ts`) |
| AC-8 | Default = no admitir; sin `allowTrial` el resultado es idéntico byte a byte al de hoy | PASS | `src/types/index.ts` `DiscoveryQuery.allowTrial` (opt-in); test `T-09` (`discovery.trial.test.ts`) |
| AC-9 | Fail-closed: si la lectura de standing está degradada, nadie es admitido, y el motivo se explica (`standingUnavailable`, no `false` silencioso) | PASS | `src/services/reputation.ts` `computeStandingBatch`; `src/services/discovery.ts` (`attachReputations`); test `T-10` (`discovery.trial.test.ts` + `reputation.test.ts`) |
| AC-10 | Cupo `M` por publicador (ancla `owner_ref`/`registry_id`) y techo `T`; empate resuelto por `created_at` o sorteo por request, nunca por `slug` | PASS | `src/lib/trial-standing.ts`; test `T-11`/`T-12` (`discovery.trial.test.ts`) |

AC-6 es el único que no cierra en esta entrega **por diseño**: la HU partió deliberadamente el mecanismo (gateway, esta entrega) de la admisión (consumidor, `chaski-v3`/W0.3), y W0.3 está bloqueada por una decisión del founder sobre el control compensatorio (SDD §3.4) que todavía no llegó. No es un hallazgo de QA, es el punto de corte de scope acordado en F2.

---

## Hallazgos finales

- **BLOQUEANTEs**: 0 pendientes. AR encontró 1 BLQ-ALTO + 3 BLQ-MED/BAJO, todos resueltos en fix-packs y re-verificados por mutación. CR encontró 1 BLQ-MED adicional (introducido por el propio fix-pack de AR), también resuelto.
- **MENORes**: 0 pendientes como deuda abierta de código. Los MENORes de AR/CR quedaron cerrados por escrito o consolidados como residuales aceptados a propósito (ver `residuales.md` de la HU): MNR-3 (el cupo acota cuántos entran, no quiénes, en el caso federado con ancla compartida), MNR-8 (el conjunto de admitidos se indexa por slug pelado, colisión posible entre registries con homónimos), MNR-4 (recordatorio de contrato sobre `a2a_events.metadata`).

---

## Auto-Blindaje consolidado

Fuente: `auto-blindaje.md` de esta HU. Se preserva **cada entrada**, sin resumir ni omitir.

### [2026-07-30] Fix-pack AR - BLQ-ALTO-1 — La garantía se probó contra un fixture que no podía romperla
- **Error**: la garantía central de la HU («el admitido conserva su score real, así que ordena ÚLTIMO») era **falsa para todo agente federado**. `repValue` es `computedReputation?.score ?? reputation` y el admitido no tiene el primero, así que caía al `reputation` del **card que publica el propio agente**; `verified`, primera clave del sort, sale del mismo lugar. Un desconocido declarando `{reputation:100, verified:true}` ordenaba **primero**, y `/compose` toma `agents[0]`: camino del dinero.
- **Causa raíz**: el test del orden dorado pasaba **sólo** porque el fixture `raw()` fijaba `reputation: 0`. Cambiando ese único campo se caía. Es el patrón "mide aire" por tercera vez en esta HU: el escenario le daba al sujeto un valor que ya garantizaba el resultado esperado, sin ejercitar el mecanismo.
- **Fix**: el fixture pasa a mentir por defecto (`reputation: 100`, `verified: true`) y el pipeline **neutraliza los dos campos auto-reportados del admitido** (`discovery.ts`, bloque del badge): `verified = false` y `reputation = computedReputation?.score ?? 0`. El comparador y `repValue` quedan byte-idénticos: se corrigió **lo que se les da de comer**, no el criterio. Mutante `M-CARD` (quitar las dos líneas) mata 5 tests, entre ellos `T-06-CARD`.
- **Aplicar en**: cualquier invariante de ORDEN. El fixture tiene que estar sesgado **en contra** de la propiedad que se afirma; si el dato de entrada ya implica la salida, el test no prueba el mecanismo. Y regla general del ranking: todo campo que entra al comparador y viene de un card federado es **auto-reportado** hasta que se demuestre lo contrario.

### [2026-07-30] Fix-pack AR - BLQ-MED-3 — Un desempate "determinista" que era una exclusión permanente
- **Error**: el cupo `M` desempataba por `slug` ascendente cuando no había `created_at`, y NINGÚN agente federado trae `created_at`. Resultado: un registry con 20 agentes nuevos de 10 publicadores repartía 2 cupos, siempre a los dos slugs lexicográficamente menores, en todas las requests. Bastaba llamarse `aaa-payout-1`. El carril quedaba bloqueado justo para el caso que motiva la HU.
- **Causa raíz**: leí "determinista" como "una función total y estable" y elegí el primer criterio que cumplía eso. Determinista y **permanente** no son lo mismo: un desempate fijo sobre un atributo que el candidato ELIGE (su nombre) es un ranking encubierto y además grindeable. El JSDoc encima decía "los M más antiguos por `created_at`", que para federados no era lo que hacía.
- **Fix**: dentro del ancla, `created_at` cuando lo hay y **SORTEO por request** cuando no (misma fuente inyectable que el desempate del ranking, HU-208). El `slug` queda sólo como cierre de orden total para el empate exacto de dos sorteos. Mutante `M-MED3` (volver al `slug`): 5 rojos.
- **Aplicar en**: todo desempate que reparta un recurso escaso. Preguntarse no sólo "¿es determinista?" sino "¿quién queda afuera PARA SIEMPRE, y puede el candidato elegir el valor con el que se lo ordena?".

### [2026-07-30] Fix-pack AR - BLQ-MED-2 — "El primer fallo anula" era una condena perpetua
- **Error**: `classifyStanding` anulaba el carril con `failedCount >= 1`. Medido: la anulación es **permanente** (`tasksSettled < N` para siempre, porque sin admisión nunca hay liquidadas) y **no hace falta malicia** — un timeout de red, o el agente caído treinta segundos, reinstalaba el deadlock que la HU existe para romper. La versión con atacante costaba una llamada.
- **Causa raíz**: escribí el corte sobre el contador que ya existía en vez de sobre el HECHO que quería medir ("este agente entrega mal"). Un contador crudo de fallos no distingue un reintento del mismo caller de la queja de dos partes independientes, y confundir esas dos cosas es lo que convierte un accidente en una condena.
- **Fix**: `failedCallerCount` (callers DISTINTOS, mismo bucketing `'__anon__'` que el cap anti-sybil) + `F` por env, default 2. Vive al lado de `cappedSettled`, sobre los mismos rows y la misma query, **sin tocar la fórmula congelada**: `failedCount` sigue alimentando `success_rate` byte por byte. Mutantes: `M-MED2` (volver al crudo) 5 rojos, `M-MED2b` (colapsar los buckets) 1 rojo.
- **Decisión escrita**: la anulación **no expira**. El carril no es el único camino a tener historial (un anulado sigue siendo contratable por quien no pide piso), así que cierra un atajo y no la puerta; y una ventana temporal premiaría esperar, del otro lado de un `depositAddress`.
- **Aplicar en**: todo corte binario derivado de un contador. Antes de escribirlo, preguntar quién puede incrementarlo, cuánto le cuesta, y si la condición se puede revertir alguna vez.

### [2026-07-30] Fix-pack AR - BLQ-BAJO-4 — El décimo "no pude preguntar", adentro del diagnóstico
- **Error**: con `attachReputations` degradado, ningún agente tiene score, lo que dispara el fail-safe del piso y los excluye a todos, y el 422 decía «No agent meets the requested min_reputation». La verdad era «no pude leer el historial». Es la HU cuyo AC existe para que el vacío deje de mentir, mintiendo con más confianza.
- **Causa raíz**: el tercer valor (`AgentStandingBatch.degraded`) ya estaba en la mano — se lo usa dos líneas más arriba para NO admitir a nadie — y se moría en la función. Propagué el dato hasta donde tomaba una decisión (fail-closed) y no hasta donde se EXPLICA la decisión.
- **Fix**: `excluded.standingUnavailable` en el contrato de `/discover` (nombre distinto de `degraded` a propósito: T-16 canda que el interno no salga) y motivo propio `reputation_unavailable` en el resolver, ANTES del motivo por piso y DESPUÉS del alcance. Mutantes: hardcodear `false` mata el test de discovery; anular la rama del resolver mata el suyo.
- **Aplicar en**: cuando un dato habilita un fail-closed, seguirlo hasta el mensaje. Un sistema que se protege bien y explica mal manda a arreglar lo que no está roto.

### [2026-07-30] Fix-pack AR - MENORES — Un allowlist copiado en el test que lo vigila
- **Error**: T-CAPRES-06 candaba la decisión "no existe una restricción de `chain`" contra un arreglo LITERAL escrito en el propio test. O sea que alguien podía agregar `chain` al validador de verdad y el test seguía verde: medía su copia. Tercera aparición del mismo patrón en esta HU.
- **Causa raíz**: el allowlist real era un `const` local dentro de la función de validación, así que el test no tenía cómo leerlo y "resolví" duplicándolo.
- **Fix**: `ALLOWED_STEP_CONSTRAINTS` exportado desde `lib/compose-step-shape.ts`, usado por el validador Y por el test. Mutante (agregar `'chain'`): rojo.
- **Aplicar en**: un test que afirma sobre una lista tiene que IMPORTAR la lista. Si no se puede importar, el arreglo es exportarla, no copiarla.

### [2026-07-30] Fix-pack AR - Campaña — Mi propio arreglo dejó ciego a un mutante viejo
- **Error potencial evitado**: al forzar `verified = false` en el admitido (BLQ-ALTO-1), el test que mataba **M6** (darle score sintético igual al piso) dejó de matarlo. Su escenario era «probado caro vs estreno barato»: como el probado seguía llegando `verified: true` desde su card, ganaba por la PRIMERA clave del sort y el empate en reputación que M6 provoca ya nunca se evaluaba. La suite quedaba verde con el mutante vivo.
- **Causa raíz**: un fix que agrega una clave de decisión ARRIBA de la que un test mide lo vuelve vacuo sin ponerlo rojo. La campaña de mutación no se re-corrió "por prolijidad": es lo único que lo detecta.
- **Fix**: el probado del escenario pasa a `verified: false`, así los dos empatan en identidad y lo único que puede decidir es el score. M6 vuelve a morir (verificado).
- **Aplicar en**: después de tocar CUALQUIER entrada del comparador, re-correr los mutantes de los tests de ORDEN, no sólo los del cambio. Un fix puede matar la capacidad de un test de detectar otro bug.

### [2026-07-30] W0.1 — El tipo creció y el sitio de construcción quedó atrás
- **Error**: agregué `reputation` y `trialAvailable` a `DiscoveryResult.excluded` en `types/index.ts` y **no** actualicé el único sitio que construye ese objeto (`discovery.ts`, `excluded: { scope: excludedByScope }`). El árbol quedó sin compilar: `TS2739`.
- **Causa raíz**: cambié un tipo y seguí escribiendo el resto de la wave sin correr `tsc`. **Y la trampa de este repo**: la suite pasaba igual, 4306 verdes, idéntica a `main`. Vitest **no typechequea**, así que "verde" no dice nada sobre si compila. Hay precedente documentado (WKH-196, el `::text` de los NUMERIC(78,0)).
- **Fix**: completar el sitio de construcción con los dos contadores reales, no con ceros de relleno.
- **Aplicar en**: cualquier cambio a un tipo de RESPUESTA. Después de tocar `types/index.ts`, `npx tsc --noEmit` **completo** antes de seguir — `npm run build` no alcanza, `tsconfig.build.json` excluye los tests. Y el corolario de proceso: commitear al cerrar cada ola. Esta HU se cayó dos veces por errores 529 de la plataforma y la primera vez no había nada commiteado.

### [2026-07-30] W0.2 — Siete suites que mockeaban la función que dejó de llamarse
- **Error**: al mover `attachReputations` de `computeReputationBatch` a `computeStandingBatch`, 9 tests se pusieron rojos en 2 archivos. Los otros 5 archivos que mockean `./reputation.js` **siguieron en verde**, pero por un motivo peor: su doble no tenía `computeStandingBatch`, así que la llamada tiraba `TypeError`, el `catch` la traducía a `degraded: true` y esos tests pasaban ejercitando el camino DEGRADADO sin saberlo.
- **Causa raíz**: cambiar el consumidor de un service mockeado en muchos lugares deja dos poblaciones: la que falla ruidosamente y la que **falla en silencio hacia el camino de error**. La segunda es la peligrosa: verde que no prueba lo que dice probar.
- **Fix**: los 7 dobles ganan `computeStandingBatch`. En los 3 que inyectan valores (`discovery.test.ts`, `discovery.minreputation.test.ts`, `discovery.capability-filters.test.ts`) el doble se **deriva** del mismo mock que ya usaban, así que ningún escenario cambió — incluido T-8 (`:218-228`), que es la no-regresión del fail-safe y quedó intacto.
- **Aplicar en**: cada vez que un service pase a llamar a un método NUEVO de otro service. `grep -rl "<viejoMétodo>" src/**/*.test.ts` y revisar **todos** los dobles, no sólo los que se pusieron rojos. Un mock incompleto que cae en el `catch` es indistinguible de un test que pasa.

### [2026-07-30] W0.2 — El escenario decía 50 y el que decidía era el techo
- **Error**: dos tests del carril pedían `minReputation: 50` con el techo `T = 10`. El de T-02 quedó **rojo** (nunca hubo admisión, así que no había badge que comparar) y el de T-05 quedaba **verde por el motivo equivocado**: pasaba por el techo, no por la anulación al primer fallo que decía estar probando.
- **Causa raíz**: armé el escenario eligiendo un piso "bien alto" sin cruzarlo con el otro límite de la política. Con dos cortes en el mismo predicado (`min <= T` y `failedCount === 0`), un valor que dispara el primero **enmascara** al segundo y el test mide aire.
- **Fix**: piso 8 en los dos, que está sobre el score real del agente (2) y bajo el techo. Ahora el rojo del primero prueba el badge y el verde del segundo prueba la anulación.
- **Aplicar en**: todo test de un predicado con **varios** términos. El escenario tiene que dejar pasar todos los términos menos el que se está probando; si no, no se sabe cuál lo decidió.

### [2026-07-30] Campaña — El lector del ancla no tenía cobertura de su propio guard
- **Error**: `listPublisherAnchors` estaba "probado" por T-11 y T-21… que lo tienen **mockeado** (ahí se prueba al consumidor). Sus 9 sentencias estaban en **0%**, incluido su único guard real: error de query, `{ degraded: true }`, no un Map vacío. La suite entera pasaba.
- **Causa raíz**: confundir "el AC está cubierto" con "las líneas del guard se ejecutan". Cuando el guard vive del lado mockeado de la frontera, ningún test del consumidor lo toca.
- **Fix**: `agent.trial-anchors.test.ts` contra el service REAL con supabase mockeado. Se validó con el mutante **M21** (`degraded: true` a Map vacío): mata **sólo** este archivo nuevo, o sea que sin él la mutación sobrevivía.
- **Aplicar en**: la regla money-path (ii) se verifica con el reporte de cobertura por LÍNEA del guard, no con la suite en verde. Medí antes de declarar.

### [2026-07-30] Campaña — Una aserción de "el escenario está armado" que no lo estaba
- **Error**: T-DRED-06 (redacción) sembraba un `owner_ref` falso y afirmaba que no aparecía en el JSON. Al **desarmar el escenario** (sacar la siembra del ancla) el test **siguió verde**: el agente era federado, así que su ancla era el `registry_id` y se admitía igual. El `owner_ref` nunca entraba al camino, y la aserción de no-filtrado pasaba sin haber tenido nada que filtrar.
- **Causa raíz**: el sujeto del test tenía **dos** caminos de admisión y el escenario ejercitaba el que no era. La aserción "está armado" (`trial.granted === true`) no distinguía entre los dos.
- **Fix**: el agente pasa a ser **self-published**, cuyo ancla ES el `owner_ref` de la fila. Desarmado, el test ahora cae en la línea que prueba el armado (`expected [] to have a length of 1`). M16/M16b/M2/M23b se re-corrieron contra la versión reworkeada y siguen muertos.
- **Aplicar en**: la regla del Story File 6.1 se aplica **desarmando de verdad**, no razonando sobre el test. Y cuando el sujeto tiene varios caminos, el escenario tiene que fijar CUÁL se está ejercitando.

### [2026-07-30] Diseño — La firma de DT-4 no podía expresar el caso del medio
- **Error potencial evitado**: implementar `AgentStanding` como la unión literal de DT-4 (`{kind:'scored';reputation} | {kind:'newcomer'} | {kind:'penalized'}`).
- **Causa raíz**: con `N = 3`, un agente con 1-2 liquidadas está a la vez **dentro** del carril y **tiene** reputación real que hay que adjuntar. La unión obliga a elegir una de las dos cosas, así que o se pierde el score (y el agente deja de ordenar por mérito) o se lo saca del carril (y `N` colapsa a 1).
- **Fix**: contadores crudos + clasificación **pura** derivada (`classifyStanding`). Se respeta el espíritu de DT-4/CD-8 (una expresión del predicado, una del score, `degraded` explícito) pero **no la firma literal**. Declarado como desviación para que AR la ratifique o la rechace; si la rechaza, la corrección es de tipos y no de política.
- **Aplicar en**: cuando una unión discriminada de un SDD no puede expresar un estado que el mismo SDD describe en prosa, el bug es de la firma, no del estado. Declararlo antes de codear, no después.

### [2026-07-30] CR BLQ-MED-1 — "Está en el carril" no es "no llega al piso"
- **Error**: `eligible` se armaba sólo con `isTrialEligible(...)`. Pero `newcomer` es `tasksSettled < N`, y eso **no** es "sin score": con `N = 3`, un agente con 1 o 2 liquidadas tiene `computedReputation` REAL y puede superar el piso por sus propios medios. Ese agente entraba a `trialAdmitted` igual, y el paso del badge le ponía `trial.granted = true` y le neutralizaba `verified`/`reputation`. Dos daños: el badge **afirmaba una relajación que no ocurrió** (con `excluded.reputation === 0`, o sea nadie excluido), y como la neutralización toca las **dos primeras claves del sort**, encender el opt-in **cambiaba el ganador entre dos agentes con historial** — con `/compose` tomando `agents[0]`, cambiaba a quién se contrata. Viola CD-6 de frente, y lo introdujo mi propio fix de BLQ-ALTO-1.
- **Causa raíz**: dos conceptos distintos colapsados en uno. El carril debe admitir a quien **el piso excluye**; yo lo até a quien **está dentro de la ventana de contador**. Los dos coinciden en el caso obvio (0 liquidadas) y **divergen justo en la ventana `1..N-1`**, que es la única donde el carril puede tocar a alguien que ya tiene historial.
- **Fix**: una sola expresión de "pasa por mérito" (`passesOnMerit`) compartida por el pre-filtro de elegibles y por el filtro (CD-8), y `eligible` exige `!passesOnMerit(a)`. El carril marca SÓLO a quien entró POR el carril.
- **Por qué mi suite no lo vio, y es la lección**: mi guard de CD-6 usaba probados de **45 y 5** liquidadas — los dos `scored`, o sea **nunca elegibles**. El test cubría el caso donde el bug es imposible. Un guard de no-regresión tiene que vivir en la **frontera** del cambio, no cómodo lejos de ella.
- **Aplicar en**: cualquier predicado que use un contador como proxy de una condición. Preguntarse en qué rango del contador el proxy y la condición **divergen**, y poner el test ahí. Y a todo guard de no-regresión: comprobar que su fixture pueda **efectivamente** entrar al camino nuevo.

### [2026-07-30] CR MNR-1 — El test insignia lo decidía `verified`, no el score
- **Error**: `[scored 90, scored 10, trial] -> el trial ÚLTIMO` **sobrevivía** a un mutante que le fabrica score **100** al admitido. El helper `raw()` había pasado a declarar `verified: true` por defecto (fix-pack anterior) y el admitido sale con `verified: false` forzado: la **primera** clave del sort decidía todo el orden y el score nunca se miraba. El nombre del test prometía medir la reputación.
- **Causa raíz**: cambiar el DEFAULT de un helper de fixtures compartido reescribe en silencio el significado de todos los tests que lo usan. Ninguno se puso rojo.
- **Fix**: los dos probados van con `verified: false` explícito, así el empate en la primera clave obliga a que decida el score. Verificado: el mutante de score 100 ahora **muere** ahí.
- **Aplicar en**: cambiar un default de un fixture compartido obliga a re-verificar por MUTACIÓN los tests que dependen de él — pasar no alcanza, hay que ver que sigan matando lo que decían matar.

### [2026-07-30] CR MNR-2 — Un bucket que dice "no sé quién" contado como un caller
- **Error**: `failedCallerCount` (los callers distintos que anulan el carril) contaba `'__anon__'` como una identidad más. Como toda llamada x402 **sin agent key** cae ahí, un atacante con **una** identidad conseguía el segundo bucket gratis y anulaba el carril de un rival **para siempre**, sin falsificar nada.
- **Causa raíz**: el mismo defecto de clase de esta HU, en otro disfraz. `'__anon__'` no es "un caller": es "no sé quién" — un número **desconocido** de partes colapsado bajo una etiqueta. Contarlo como exactamente una identidad distinta **afirma algo que el dato no dice**, y lo afirma en la dirección cara.
- **Fix**: el bucket anónimo no suma a `failedCallers`. Elegido **sobre subir `F` a 3**, y por aritmética: con `F = 3` el atacante sigue necesitando 2 identidades (2 + anónimo), o sea el MISMO costo, mientras le sube la vara a la anulación legítima. Sacar el bucket que no identifica a nadie deja el costo del atacante en 2 identidades reales sin encarecer el caso honesto. **Consecuencia declarada**: fallos exclusivamente anónimos ya no anulan el carril; siguen bajando `success_rate` y con él el score real.
- **Aplicar en**: todo contador de "partes distintas". Un bucket catch-all vale **cero** identidades, no una — si no, cualquiera compra la primera gratis.

### [2026-07-30] Fix-pack de texto — Un glob en un JSDoc cerró el comentario
- **Error**: escribiendo un residual en el JSDoc de `DiscoveryResult.excluded` puse la ruta `doc/sdd/211-*/residuales.md`. Esa secuencia de asterisco+barra **cierra el bloque de comentario**, así que el resto del texto pasó a parsearse como código: `types/index.ts` dejó de compilar (`TS1005`, `TS1443`, `TS1160` a mil líneas de distancia) y **41 archivos de test** cayeron con error de importación. Un fix-pack que era **sólo documentación** rompió el árbol entero.
- **Causa raíz**: un patrón de glob (`211-*/`) es indistinguible del terminador de un comentario de bloque. Y el síntoma aparece **lejos** del error: el primer diagnóstico apuntaba a la línea 1636 de un archivo cuya edición fue en la 502.
- **Fix**: la ruta se nombra sin glob (`el residuales.md de la HU`). Verificado con `grep` que no quedó ningún otro terminador de comentario dentro de un comentario en `src/`.
- **Aplicar en**: nunca escribir asterisco seguido de barra dentro de un comentario de bloque — ni rutas con glob, ni expresiones matemáticas. Y el corolario de proceso: **un cambio "sólo de texto" también pasa por `tsc`**. Un comentario es sintaxis.

---

## Lecciones para próximas HUs (las cuatro que trascienden el ticket)

1. **Un fixture es infraestructura compartida.** El helper `raw()` pasó a declarar `verified:true` por defecto, y con eso la primera clave del ordenamiento decidía todo: **el score nunca se miraba**. Un test que decía medir el score medía otra cosa, y su nombre mentía. Cambiar un fixture puede desafilar tests que nadie tocó.

2. **Contar mutantes muertos oculta que un test perdió su poder.** La campaña puede decir 100% mientras un test específico dejó de matar, porque **otro** test mata al mismo mutante y la campaña le atribuye la muerte a la suite. La unidad de medida correcta es *el test que nombra la propiedad*, no la campaña.

3. **Un cambio "sólo de documentación" también pasa por el compilador.** Al escribir el residual se puso una ruta con comodín dentro de un JSDoc; eso cerró el comentario, `types/index.ts` dejó de compilar y cayeron **41 archivos de test**. Un comentario es sintaxis.

4. **`'__anon__'` no es "un caller": es "no sé quién".** Contarlo como una identidad afirma lo que el dato no dice. Es el mismo colapso de tres valores en dos que venimos cazando en el camino del dinero, ahora en la reputación.

---

## Corrección de hecho — la demo insignia NO está bloqueada por esta HU

Documentos previos de la HU (`story-HU-313.md`, sección de Verificación y Done Definition) escribían, sin matiz, que «W0.3 no se entregó, así que la demo insignia sigue sin destrabarse». Esa frase, leída suelta, sobregeneraliza. Lo medido y correcto:

- El **leg de cotización** de la demo (`remittance-fx-quote`) responde **200 con tasa real** hoy. No manda `min_reputation` (`sdd.md:28`) y no depende en nada de esta HU.
- Lo que mantiene **inerte** el flujo de valor de punta a punta son **dos flags apagados a propósito**: `NEXT_PUBLIC_SOLANA_SETTLE_ENABLED` y `NEXT_PUBLIC_EIP3009_ENABLED` (`chaski-v3`). Esos flags no tienen relación con WKH-313.
- Lo que **sí** depende de esta HU (y de W0.3, no entregada) es específicamente el **leg de payout** (`remittance-payout`): con `min_reputation=2` y el único agente que sirve esa capacidad en score-nada, `resolveCapability` devuelve `no_candidates` (`sdd.md:28`, `capability-resolver.ts:130-136`). Ese leg puntual no resuelve hasta que Chaski mande `allow_trial` — pero eso es un leg, no "la demo".

Se corrigió inline en `story-HU-313.md` (nota agregada `[CORRECCIÓN DOCS 2026-07-30]` en esa sección) para que no se repita la generalización en un reporte futuro.

---

## Archivos modificados

Diff medido contra el merge-base con `main` (`6b391d6`), **33 archivos**, +5981/-55:

**Documentación de la HU** (5)
- `doc/sdd/211-wkh-313-primer-trabajo-agentes-sin-historial/work-item.md`, `sdd.md`, `story-HU-313.md`, `auto-blindaje.md`, `residuales.md`

**Config y contrato público** (2)
- `.env.example` (+45 — 4 envs nuevos: `TRIAL_MAX_SETTLED_TASKS=3`, `TRIAL_MAX_MIN_REPUTATION=10`, `TRIAL_MAX_AGENTS_PER_PUBLISHER=2`, `TRIAL_MAX_FAILED_CALLERS=2`, todos `[DECIDE FOUNDER]`)
- `doc/INTEGRATION.md` (+119 — documenta el carril, el opt-in, el badge y los contadores)

**Tipos** (1)
- `src/types/index.ts` (+156/-1 — `AgentTrialAdmission`, `AgentStandingCounters`, `DiscoveryQuery.allowTrial`, `DiscoveryResult.excluded` extendido, `ComposeStepConstraints.allow_trial`)

**Lógica de dominio** (8)
- `src/lib/trial-standing.ts` (nuevo — `classifyStanding`, `passesOnMerit`, `isTrialEligible`, `selectTrialCandidates`)
- `src/lib/discovery-query.ts` — parser de `allowTrial`
- `src/lib/compose-step-shape.ts` — allowlist `allow_trial`, `ALLOWED_STEP_CONSTRAINTS` exportado
- `src/services/discovery.ts` (+373 — filtro, badge, contadores, neutralización de campos auto-reportados)
- `src/services/reputation.ts` (+163 — `computeStandingBatch`, `failedCallerCount`, fail-closed `degraded`)
- `src/services/agent.ts` — lector de anclas de publicador (`listPublisherAnchors`)
- `src/services/capability-resolver.ts` — mapeo `constraints.allow_trial` a `query.allowTrial`, clave de memo incluye `allow_trial`
- `src/routes/discover.ts` — GET y POST parseando `allowTrial` en simetría

**Tests** (13 archivos, incluye 3 suites nuevas: `trial-standing.test.ts`, `discovery.trial.test.ts` con 1240 líneas, `agent.trial-anchors.test.ts`)

**Sin tocar**: `chaski-v3` (0 bytes, verificado — W0.3 explícitamente no ejecutada).

---

## Decisiones diferidas a backlog

- **W0.3** (`chaski-v3`): opt-in del consumidor Chaski al carril, con el control compensatorio de SDD §3.4. Bloqueado por decisión del founder (work-item §5 / SDD §3.4). No es HU nueva, es la segunda mitad de esta misma HU, en otro repo.
- **Work-item §1.6 / R-2**: salida para el agente que ya trabajó y volvió a score 0 por fallos tempranos (caso distinto de "nunca entró"). `remit-kyc-validator` está hoy a un fallo de caer bajo su propio piso (`sdd.md:33`) — es el caso vivo, no hipotético.
- **R-3** (SDD §6): `verified` como primera clave del sort siendo auto-reportado por el registry e inalcanzable para self-published. Candidato a HU de hardening del ranking.
- **MNR-3 / MNR-8** (residuales): ancla por publicador también del lado federado (hoy el `Agent` federado no trae `owner_ref` ni `created_at`); indexar admitidos por `registry_id::slug` en vez de slug pelado. Ambos son cambios de contrato de discovery, no de este carril.
- **R-6** (residuales): `failedCount` (el que alimenta `success_rate`) no está capeado por caller — mover esa semántica es cambiar la fórmula de reputación de producción, fuera de alcance por decisión explícita del work-item §8.

---

## Verificación final del cierre

- `npx tsc --noEmit` (completo): **limpio**.
- `npx vitest run`: **4452 passed / 19 skipped** (229 archivos, 6 skipped) — igual a lo reportado por F4.
- `chaski-v3`: sin tocar (W0.3 no ejecutada).
- Rama `feat/211-wkh-313-primer-trabajo`, HEAD `86216ce` — **no mergeada**, a la espera del orden coordinado por el orquestador (ver sección "Orden de merge" arriba).

---

*Report — NexusAgil - DONE - WKH-313 - 2026-07-30*
