# Auto-Blindaje — HU WKH-313 (carril de estreno)

### [2026-07-30] Fix-pack AR · BLQ-ALTO-1 — La garantía se probó contra un fixture que no podía romperla

- **Error**: la garantía central de la HU («el admitido conserva su score real, así
  que ordena ÚLTIMO») era **falsa para todo agente federado**. `repValue` es
  `computedReputation?.score ?? reputation` y el admitido no tiene el primero, así
  que caía al `reputation` del **card que publica el propio agente**; `verified`,
  primera clave del sort, sale del mismo lugar. Un desconocido declarando
  `{reputation:100, verified:true}` ordenaba **primero**, y `/compose` toma
  `agents[0]`: camino del dinero.
- **Causa raíz**: el test del orden dorado pasaba **sólo** porque el fixture `raw()`
  fijaba `reputation: 0`. Cambiando ese único campo se caía. Es el patrón "mide
  aire" por tercera vez en esta HU: el escenario le daba al sujeto un valor que ya
  garantizaba el resultado esperado, sin ejercitar el mecanismo.
- **Fix**: el fixture pasa a mentir por defecto (`reputation: 100`, `verified: true`)
  y el pipeline **neutraliza los dos campos auto-reportados del admitido**
  (`discovery.ts`, bloque del badge): `verified = false` y `reputation =
  computedReputation?.score ?? 0`. El comparador y `repValue` quedan byte-idénticos:
  se corrigió **lo que se les da de comer**, no el criterio. Mutante `M-CARD`
  (quitar las dos líneas) mata 5 tests, entre ellos `T-06-CARD`.
- **Aplicar en**: cualquier invariante de ORDEN. El fixture tiene que estar sesgado
  **en contra** de la propiedad que se afirma; si el dato de entrada ya implica la
  salida, el test no prueba el mecanismo. Y regla general del ranking: todo campo que
  entra al comparador y viene de un card federado es **auto-reportado** hasta que se
  demuestre lo contrario.

### [2026-07-30] W0.1 — El tipo creció y el sitio de construcción quedó atrás

- **Error**: agregué `reputation` y `trialAvailable` a `DiscoveryResult.excluded`
  en `types/index.ts` y **no** actualicé el único sitio que construye ese objeto
  (`discovery.ts`, `excluded: { scope: excludedByScope }`). El árbol quedó sin
  compilar: `TS2739`.
- **Causa raíz**: cambié un tipo y seguí escribiendo el resto de la wave sin correr
  `tsc`. **Y la trampa de este repo**: la suite pasaba igual, 4306 verdes, idéntica
  a `main`. Vitest **no typechequea**, así que "verde" no dice nada sobre si
  compila. Hay precedente documentado (WKH-196, el `::text` de los NUMERIC(78,0)).
- **Fix**: completar el sitio de construcción con los dos contadores reales, no con
  ceros de relleno.
- **Aplicar en**: cualquier cambio a un tipo de RESPUESTA. Después de tocar
  `types/index.ts`, `npx tsc --noEmit` **completo** antes de seguir — `npm run
  build` no alcanza, `tsconfig.build.json` excluye los tests. Y el corolario de
  proceso: commitear al cerrar cada ola. Esta HU se cayó dos veces por errores 529
  de la plataforma y la primera vez no había nada commiteado.

### [2026-07-30] W0.2 — Siete suites que mockeaban la función que dejó de llamarse

- **Error**: al mover `attachReputations` de `computeReputationBatch` a
  `computeStandingBatch`, 9 tests se pusieron rojos en 2 archivos. Los otros 5
  archivos que mockean `./reputation.js` **siguieron en verde**, pero por un motivo
  peor: su doble no tenía `computeStandingBatch`, así que la llamada tiraba
  `TypeError`, el `catch` la traducía a `degraded: true` y esos tests pasaban
  ejercitando el camino DEGRADADO sin saberlo.
- **Causa raíz**: cambiar el consumidor de un service mockeado en muchos lugares
  deja dos poblaciones: la que falla ruidosamente y la que **falla en silencio
  hacia el camino de error**. La segunda es la peligrosa: verde que no prueba lo
  que dice probar.
- **Fix**: los 7 dobles ganan `computeStandingBatch`. En los 3 que inyectan valores
  (`discovery.test.ts`, `discovery.minreputation.test.ts`,
  `discovery.capability-filters.test.ts`) el doble se **deriva** del mismo mock que
  ya usaban, así que ningún escenario cambió — incluido T-8 (`:218-228`), que es la
  no-regresión del fail-safe y quedó intacto.
- **Aplicar en**: cada vez que un service pase a llamar a un método NUEVO de otro
  service. `grep -rl "<viejoMétodo>" src/**/*.test.ts` y revisar **todos** los
  dobles, no sólo los que se pusieron rojos. Un mock incompleto que cae en el
  `catch` es indistinguible de un test que pasa.

### [2026-07-30] W0.2 — El escenario decía 50 y el que decidía era el techo

- **Error**: dos tests del carril pedían `minReputation: 50` con el techo `T = 10`.
  El de T-02 quedó **rojo** (nunca hubo admisión, así que no había badge que
  comparar) y el de T-05 quedaba **verde por el motivo equivocado**: pasaba por el
  techo, no por la anulación al primer fallo que decía estar probando.
- **Causa raíz**: armé el escenario eligiendo un piso "bien alto" sin cruzarlo con
  el otro límite de la política. Con dos cortes en el mismo predicado
  (`min <= T` y `failedCount === 0`), un valor que dispara el primero **enmascara**
  al segundo y el test mide aire.
- **Fix**: piso 8 en los dos, que está sobre el score real del agente (2) y bajo el
  techo. Ahora el rojo del primero prueba el badge y el verde del segundo prueba la
  anulación.
- **Aplicar en**: todo test de un predicado con **varios** términos. El escenario
  tiene que dejar pasar todos los términos menos el que se está probando; si no, no
  se sabe cuál lo decidió.

### [2026-07-30] Campaña — El lector del ancla no tenía cobertura de su propio guard

- **Error**: `listPublisherAnchors` estaba "probado" por T-11 y T-21… que lo tienen
  **mockeado** (ahí se prueba al consumidor). Sus 9 sentencias estaban en **0%**,
  incluido su único guard real: error de query ⟹ `{ degraded: true }`, no un Map
  vacío. La suite entera pasaba.
- **Causa raíz**: confundir "el AC está cubierto" con "las líneas del guard se
  ejecutan". Cuando el guard vive del lado mockeado de la frontera, ningún test del
  consumidor lo toca.
- **Fix**: `agent.trial-anchors.test.ts` contra el service REAL con supabase
  mockeado. Se validó con el mutante **M21** (`degraded: true` → Map vacío): mata
  **sólo** este archivo nuevo, o sea que sin él la mutación sobrevivía.
- **Aplicar en**: la regla money-path (ii) se verifica con el reporte de cobertura
  por LÍNEA del guard, no con la suite en verde. Medí antes de declarar.

### [2026-07-30] Campaña — Una aserción de "el escenario está armado" que no lo estaba

- **Error**: T-DRED-06 (redacción) sembraba un `owner_ref` falso y afirmaba que no
  aparecía en el JSON. Al **desarmar el escenario** (sacar la siembra del ancla) el
  test **siguió verde**: el agente era federado, así que su ancla era el
  `registry_id` y se admitía igual. El `owner_ref` nunca entraba al camino, y la
  aserción de no-filtrado pasaba sin haber tenido nada que filtrar.
- **Causa raíz**: el sujeto del test tenía **dos** caminos de admisión y el
  escenario ejercitaba el que no era. La aserción "está armado"
  (`trial.granted === true`) no distinguía entre los dos.
- **Fix**: el agente pasa a ser **self-published**, cuyo ancla ES el `owner_ref` de
  la fila. Desarmado, el test ahora cae en la línea que prueba el armado
  (`expected [] to have a length of 1`). M16/M16b/M2/M23b se re-corrieron contra la
  versión reworkeada y siguen muertos.
- **Aplicar en**: la regla del Story File §6.1 se aplica **desarmando de verdad**,
  no razonando sobre el test. Y cuando el sujeto tiene varios caminos, el escenario
  tiene que fijar CUÁL se está ejercitando.

### [2026-07-30] Diseño — La firma de DT-4 no podía expresar el caso del medio

- **Error potencial evitado**: implementar `AgentStanding` como la unión literal de
  DT-4 (`{kind:'scored';reputation} | {kind:'newcomer'} | {kind:'penalized'}`).
- **Causa raíz**: con `N = 3`, un agente con 1-2 liquidadas está a la vez **dentro**
  del carril y **tiene** reputación real que hay que adjuntar. La unión obliga a
  elegir una de las dos cosas, así que o se pierde el score (y el agente deja de
  ordenar por mérito) o se lo saca del carril (y `N` colapsa a 1).
- **Fix**: contadores crudos + clasificación **pura** derivada
  (`classifyStanding`). Se respeta el espíritu de DT-4/CD-8 (una expresión del
  predicado, una del score, `degraded` explícito) pero **no la firma literal**.
  Declarado como desviación para que AR la ratifique o la rechace; si la rechaza,
  la corrección es de tipos y no de política.
- **Aplicar en**: cuando una unión discriminada de un SDD no puede expresar un
  estado que el mismo SDD describe en prosa, el bug es de la firma, no del estado.
  Declararlo antes de codear, no después.
