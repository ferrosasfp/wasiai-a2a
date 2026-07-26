# Auto-Blindaje — 189 fix-pack P1

Errores cometidos durante la implementación, su causa raíz y dónde más pueden
volver a pasar. NO es opcional: es lo que protege las HUs siguientes.

---

### [2026-07-26] Wave 2 — Un export nuevo del service rompió 12 tests que lo mockean completo

- **Error**: puse `parseMinReputation` / `InvalidMinReputationError` como exports
  de `src/services/discovery.ts` y los importé desde `src/routes/discover.ts`.
  `tsc --noEmit` pasó en 0, los tests nuevos pasaron, y la suite completa se cayó
  con **12 fallos** en `src/routes/discover.test.ts` (9) y
  `src/__tests__/e2e/e2e.test.ts` (3).
- **Causa raíz**: esos tests hacen
  `vi.mock('../services/discovery.js', () => ({ discoveryService: {...} }))` —
  factory **sin `importOriginal`**. El mock REEMPLAZA el módulo entero, así que
  todo export que no esté en la factory queda `undefined` en el módulo bajo test.
  La ruta llamaba a `parseMinReputation(...)` → `TypeError` en cada request.
  `tsc` no lo ve: los mocks son runtime.
- **Fix**: moví la validación a un módulo **leaf** nuevo,
  `src/lib/discovery-query.ts`, y la ruta la importa de ahí. Los tests que
  mockean el service siguieron funcionando **sin tocarlos**, y el validador ganó
  su propio test unitario (`src/lib/discovery-query.test.ts`). Mismo patrón que
  `payment-spec-reader.ts` (WKH-241).
- **Aplicar en**: **cualquier** HU que agregue un export a un módulo de
  `src/services/` y lo consuma desde `src/routes/`. Antes de hacerlo:
  `grep -rn "vi.mock('.*services/<modulo>.js'" src/` y ver si alguna factory NO
  usa `importOriginal`. Si hay alguna → el export va en un módulo leaf de
  `src/lib/`, no en el service. Regla derivada: **helpers puros (validación,
  parsing, mapeo) van en `src/lib/`; los services quedan para I/O**.
- **Lección de proceso**: `tsc --noEmit` + los tests del archivo nuevo NO son
  suficientes. La suite COMPLETA es el único gate que caza esto.

---

### [2026-07-26] Wave 4 — El MISMO error, otra vez, y 7× más caro

- **Error**: puse `createSkipCapturingLogger` / `toPublicSkipCode` /
  `DownstreamSkipCode` en `src/lib/downstream-payment.ts` y los importé desde
  `src/services/compose.ts`. **84 tests** rotos en `compose.test.ts` (y las mismas
  factories están en `compose.ssrf.test.ts`, `compose.chain-flow.test.ts`,
  `orchestrate.billing.test.ts`, `money-path.resilience.test.ts` y
  `e2e/compose-flow.test.ts` → 6 suites expuestas).
- **Causa raíz**: idéntica a la entrada de la Wave 2. Reincidí a pesar de haberla
  escrito 40 minutos antes.
- **Fix**: módulo leaf `src/lib/downstream-skip-code.ts` con la taxonomía + los
  helpers; `downstream-payment.ts` re-exporta `DownstreamSkipCode` por back-compat
  (mismo patrón que el re-export de `DownstreamLogger` que ya existía) e importa
  `noteSkip` del leaf. Se agregó un comentario ⚠️ en la factory de
  `compose.test.ts:100` para que el próximo lo vea ANTES de tropezar.
- **Aplicar en**: es la MISMA regla, así que el problema no era la regla sino el
  chequeo. **Chequeo mecánico obligatorio** antes de agregar un export a un módulo
  consumido por `src/routes/` o `src/services/`:

  ```
  grep -rn "vi.mock('.*<modulo>.js'" src/ | grep -v importOriginal
  ```

  Si devuelve algo → el export va en un leaf de `src/lib/`. Los dos módulos que
  ya sabemos que están minados: `src/services/discovery.js` y
  `src/lib/downstream-payment.js`.

---

### [2026-07-26] Wave 3 — `toFixed(decimals)` no es una normalización decimal segura

- **Error**: no es un error mío de esta sesión, es el que se está arreglando,
  pero se documenta porque el patrón está copiado en 5 adapters y va a volver.
- **Causa raíz**: `Number.prototype.toFixed(n)` con `n` grande **no** emite el
  decimal que el double representa: emite su **expansión binaria**. Con `n = 18`
  (tokens de 18 decimales) eso mete el error de representación completo en el
  monto atómico: `(0.03).toFixed(18)` = `'0.029999999999999999'`. El comentario
  original decía «parseUnits scales the USD figure to atomic units **exactly**»,
  y era falso para 18 decimales.
- **Por qué el `toFixed` estaba ahí y NO se puede borrar sin reemplazo**:
  `parseUnits` **lanza** con notación científica
  (`parseUnits('1e-7', 6)` → `Number "1e-7" is not a valid decimal number`), y
  `String(1e-7)` es `'1e-7'`. El `toFixed` evitaba ese throw. Cualquier fix tiene
  que seguir garantizando salida decimal plana.
- **Fix**: helper compartido `src/lib/atomic-amount.ts` que expande la notación
  científica a decimal plano a partir de la representación decimal MÁS CORTA
  (`String(n)`), y recién ahí llama a `parseUnits`.
- **Aplicar en**: todo lugar que convierta un `number` de USD a unidades
  atómicas. `grep -rn "toFixed(" src/` antes de agregar un rail nuevo. Regla:
  **nunca `toFixed(d)` con `d > 6` sobre un double para derivar un monto
  on-chain**.

---

### [2026-07-26] Wave 4 — Exponer un enum interno en la respuesta HTTP es una decisión de seguridad, no de tipado

- **Error**: el impulso obvio era serializar el `DownstreamSkipCode` crudo en
  `steps[].downstreamSettle`. Auditados uno por uno, **6 de los 16 códigos filtran
  estado interno** al caller: `INSUFFICIENT_BALANCE` revela que la hot wallet del
  operador está seca en ese rail; `CHAIN_ENVIRONMENT_DRIFT` es por definición un
  bug de config nuestro (si el gateway apunta a testnet mientras publica
  mainnet); `MAINNET_NOT_ALLOWED` permite enumerar la allow-list de
  `WASIAI_DOWNSTREAM_MAINNET_ALLOW`; `SIGNING_FAILED` revela que
  `OPERATOR_PRIVATE_KEY` falta o es inválida.
- **Causa raíz**: los skip-codes se diseñaron para **logs de operador**
  (audiencia interna). Reusar ese vocabulario como contrato público hereda la
  audiencia equivocada.
- **Fix**: mapeo explícito `Record<DownstreamSkipCode, PublicDownstreamSkipCode>`
  **exhaustivo por tipo** en `src/lib/downstream-skip-code.ts` (AR MENOR-6: este
  puntero decía `downstream-payment.ts`, de donde el mapeo se movió para no romper
  las 6 suites que mockean el módulo del money-path completo). Los códigos de
  config del gateway → `NOT_CONFIGURED`; los de wallet/claves del operador →
  `UNAVAILABLE`; sólo se expone verbatim lo que describe la declaración del
  propio agente (dato que el caller ya ve en `/discover`) o un resultado terminal
  de pago.
- **Aplicar en**: cualquier enum interno que se quiera surfacear en una
  respuesta. El guard que hay que copiar es el `Record<...>` exhaustivo: agregar
  un código nuevo sin decidir su visibilidad **no compila**. Sin eso, la fuga
  llega por olvido en la HU siguiente, no en esta.

---

### [2026-07-26] Wave 5 — Un cap duro sobre un Map de idempotencia de dinero puede pagar dos veces

- **Error**: la implementación intuitiva de «cap + TTL» es un LRU con desalojo
  duro. Sobre `_intentSignatures` eso es un bug de dinero: ese Map es lo único
  que hace idempotente el settle de un leg Solana
  (`src/adapters/solana/payment.ts:197-218`). Si la entrada desaparece mientras
  el intent sigue vivo, un retry re-broadcastea la transferencia → **doble pago**.
- **Causa raíz**: un cap duro **tiene** que desalojar algo cuando se llena, así
  que tarde o temprano desaloja una entrada viva. La presión de memoria y la
  corrección de dinero apuntan en direcciones opuestas.
- **Fix**: cap **soft** con **ventana protegida**. Se barre lo expirado; si aún se
  supera el cap se desaloja lo más viejo, pero **nunca** una entrada más joven que
  la ventana protegida. Si todas están protegidas, no se desaloja nada y se emite
  un `warn` (el Map excede el cap a propósito). Ante la duda: **conservar**. El
  override de TTL además tiene **piso** = esa misma ventana.
  ⚠️ **Corregido por AR MENOR-1**: la ventana era `TIMEOUT_COMPOSE_MS × 2` (6 min)
  y se justificaba con una garantía falsa (el 504 NO cancela el pipeline). Hoy es
  `max(5 steps × 300 s de undici, TIMEOUT_COMPOSE_MS × 2)` = 25 min. Ver la
  entrada «Documentar una garantía que el código no da» más abajo.
- **Aplicar en**: todo cache/dedup in-process que participe del money-path. La
  pregunta de diseño es «¿qué pasa si esta entrada desaparece ANTES de tiempo?».
  Si la respuesta es "se paga dos veces", el cap va soft. Si es "se recomputa",
  puede ir duro.

---

### [2026-07-26] Transversal — verificar el hallazgo antes de arreglarlo (se cumplió, y valió)

- **Qué pasó**: los 5 hallazgos se reprodujeron antes de tocar código. **Dos
  tenían el mapa mal**:
  - H1 afirmaba que «`total` no coincide con lo que se devuelve» como parte del
    bug. Falso: `total !== agents.length` es el contrato correcto de paginación.
    De haberlo "arreglado" según el reporte (`total = agents.length`) se habría
    **destruido** la capacidad de paginar del cliente. El bug real era la
    magnitud (2 en vez de 7), no la semántica.
  - H3 apuntaba a `src/middleware/x402.ts` / `augmentX402ChallengeAmount` y a
    «una conversión que pasa por `Number`». La causa está en los 5
    `src/adapters/*/payment.ts` (`quote()`), no hay ningún `Number(...)`
    involucrado, y el drift no es de 1 wei: va de **−107 a +89** y **cambia de
    signo**. Buscar el `Number` reportado habría sido buscar algo que no existe.
- **Aplicar en**: siempre. Un hallazgo es una **hipótesis con evidencia parcial**,
  no un diagnóstico. El paso 0 es un test que falla reproduciendo el síntoma
  medido; si no se puede escribir, el hallazgo no está entendido todavía.

---

### [2026-07-26] Wave 3 — `quote()` de Solana estaba en 0% de cobertura

- **Error**: apliqué el fix del monto atómico a los 5 adapters, la suite pasó, y
  `--coverage.include='src/adapters/**/payment.ts'` mostró que el call site de
  `usdToAtomicUnits` en `solana/payment.ts` tenía **0 hits**. El fix estaba en
  código que la suite nunca ejecuta: indistinguible de un fix que nunca corre.
- **Causa raíz**: `payment.test.ts` de Solana cubría `settle`/`verify`/el seam de
  idempotencia, pero nadie había testeado `quote()` — y `quote()` es justamente
  el productor del monto del challenge 402.
- **Fix**: 3 tests de `quote()` en `src/adapters/solana/payment.test.ts`,
  incluyendo un mint de **9 decimales** (donde el artefacto de `toFixed` SÍ
  aparece, a diferencia de los 6 del default). Los otros 4 adapters ya tenían
  13/16/16/3 hits.
- **Aplicar en**: **todo fix del money-path se cierra con
  `--coverage.include=<archivo>` y se verifica hit-por-línea**, no con "la suite
  pasa". Un `expect` que nunca corre y un fix que nunca corre son el mismo
  artefacto desde afuera.

---

### [2026-07-26] Wave 4 — Un decorador de logs es tan bueno como el log que decora

- **Error**: el diseño para capturar el skip-code era decorar el
  `DownstreamLogger` y leer el `{ code }` que los 25 caminos de `return null` ya
  loguean. Al auditar los 25 sitios apareció que **`FLAG_OFF` se loguea una vez
  por proceso** (dedup WKH-235a, `_warnedFlagOff`): del 2º request en adelante el
  decorador no habría visto NADA y la señal nueva habría estado ausente en
  producción con el flag apagado — o sea justo en el caso más común.
- **Causa raíz**: asumir que "todos los sitios loguean el código" implica "el log
  ocurre en cada invocación". Un dedup warn-once rompe ese puente y no se ve
  leyendo el `return null`: hay que mirar el `if` que envuelve el log.
- **Fix**: `noteSkip(logger, 'FLAG_OFF')` explícito en ese branch (1 línea, el
  comportamiento del log no cambia) + un test que verifica la señal
  **específicamente en el 2º leg**, cuando el log ya no se emite.
- **Aplicar en**: cualquier mecanismo que derive estado observando logs. Antes de
  confiar en un log como canal de datos:
  `grep -n "_warned\|once per process\|dedup" <modulo>`. Si hay dedup, ese log NO
  es un canal confiable.

---

### [2026-07-26 12:40] AR it2 — Un fix de paginación cambió la MEMBRESÍA de un pool que otro módulo usa para decidir dinero

- **Error**: el fix de H1 (over-fetch upstream) se razonó como "la página de
  `/discover` sale completa". Nadie preguntó **quién más consume `discover()` con
  un `limit`**. `compose.resolveAgent` usaba `discover({ limit: 50 })` para
  hidratar el `payment.chain` real del agente (WKH-113). Al pasar el ranking de
  ≤50 a ≤200 candidatos con los **mismos 50 slots**, la composición del top-50
  cambió: un agente non-EVM que antes entraba podía quedar afuera, perder la
  hidratación y terminar con su leg downstream salteado o apuntado al rail
  equivocado — **sin cobrarse, en silencio**.
- **Causa raíz**: dos conceptos distintos compartían un número. El `limit` de
  `/discover` es un **page size de un ranking**; el de `compose` es el **tamaño de
  un conjunto de búsqueda por slug**. Un ranking top-N es una elección
  *semánticamente incorrecta* para una búsqueda exacta, y como funcionaba por
  accidente (el catálogo entraba en 50), nadie lo miró. El fix no introdujo el
  acoplamiento: lo **activó**.
- **Fix**: `resolveComposeAgentPoolLimit() = resolveUpstreamFetchLimit(50)` en un
  leaf compartido, que hace el page size **igual** al fetch upstream (la función
  es idempotente), así el `slice` no puede descartar un candidato traído. Un solo
  productor del pool en `compose.ts` para que el cache y el fallback no divergan.
  Test que mete 150 candidatos y assertea la hidratación por el path real de
  `/compose`, + mutación (volver a 50 mata 4 de 7 tests).
- **Aplicar en**: antes de cambiar el tamaño, el orden o el filtrado de CUALQUIER
  set compartido, `grep -rn "<funcion>(" src/` y clasificar cada consumidor por
  **para qué usa el set**: ranking (top-N es correcto) vs búsqueda/lookup (top-N
  es un bug latente). Y si el consumidor es del money-path, el test va por el
  path completo, no por el helper. Corolario: un fix de "paginación" puede ser un
  cambio de money-path por transitividad.

---

### [2026-07-26 12:55] AR it2 — Documentar una garantía que el código no da es peor que no documentar nada

- **Error**: el work-item y `.env.example` afirmaban que «un run no puede
  sobrevivir a su propio timeout» y de ahí derivaban el piso del knob
  `SOLANA_INTENT_DEDUP_TTL_MS` (`TIMEOUT_COMPOSE_MS × 2` = 6 min), presentado como
  el guard anti-doble-pago. `src/middleware/timeout.ts:12-20` sólo **manda** el
  504: no hay `AbortController`, no hay `signal`, no se cancela nada. Y
  `lib/ssrf-dispatcher.ts` no fija `headersTimeout`/`bodyTimeout`, así que el hop
  del invoke sólo tiene el default de undici (300 s), que además es de
  **inactividad**. La ejecución puede pasarse largo del timeout: el margen real
  del default era ~1.2×, no 10×.
- **Causa raíz**: se tomó el nombre de una env (`TIMEOUT_COMPOSE_MS`) como
  evidencia de lo que hace. Un timeout de **respuesta** no es un timeout de
  **ejecución**, y la diferencia sólo se ve leyendo el handler.
- **Fix**: la cota pasa a derivarse de números verificables
  (`MAX_COMPOSE_STEPS = 5` de `routes/compose.ts:128` × 300 s de undici = 25 min),
  el piso sube a eso, el TTL default a 50 min, y el texto **dice explícitamente
  que es una estimación y no una garantía** (no cuenta los hops del settle ni el
  body trickle-feedeado, que no tiene techo). Se descartó cancelar el pipeline:
  abortar en medio de un settle produce el estado indeterminado del que este Map
  protege. Fijado por `T-TTL-11`.
- **Aplicar en**: toda frase de la forma «X no puede pasar de Y» en un doc de
  operación. Antes de escribirla, encontrar **la línea que lo hace cumplir**. Si
  no existe, la frase se cambia por la cota real con su margen de error. Un
  default incómodo y honesto le sirve al operador; uno cómodo y falso lo hace
  tomar la decisión equivocada con confianza.

---

### [2026-07-26 13:05] AR it2 — El anti-patrón que documenté para `FLAG_OFF` lo repetí dos entradas más abajo

- **Error**: en la misma sesión en que documenté que un warn-once-per-proceso no
  es un canal confiable (entrada de Wave 4, `FLAG_OFF`), escribí
  `_warnedSoftCapBreached` como warn-once-per-**proceso** — sólo se re-armaba en
  `_resetSolanaClients` (TEST-ONLY) — y en el work-item lo describí como «una vez
  por ventana», que era lo que yo creía haber implementado. Consecuencia: breach a
  la hora 1, recuperación, breach a la hora 20 → **silencio**.
- **Causa raíz**: escribir el warn y su documentación en el mismo movimiento, sin
  volver a mirar dónde se resetea el flag. La lección de la entrada anterior era
  sobre logs de OTRO módulo; no la apliqué a mi propio código nuevo.
- **Fix**: re-armar el flag en los dos puntos donde el tamaño vuelve a bajar del
  cap (early-return por cap y post-desalojo). Tests `T-CAP-6` (recuperación por
  cap) y `T-CAP-7` (recuperación por desalojo), los dos asserteando **2** warns en
  dos episodios.
- **Aplicar en**: un `let _warned* = false` a nivel de módulo es una deuda hasta
  que se demuestre lo contrario. Checklist: (1) ¿dónde se re-arma? (2) ¿hay un
  test con DOS episodios? (3) ¿el texto del log y el doc dicen la misma cosa que
  el código? Y la meta-lección: releer las entradas de auto-blindaje de la sesión
  EN CURSO antes de escribir código nuevo, no sólo las de sesiones pasadas.

---

### [2026-07-26 13:15] AR it2 — "Idéntico al camino viejo" sin decir en qué rango es una afirmación sin dominio

- **Error**: `atomic-amount.ts` afirmaba categóricamente que para 6 decimales el
  resultado es idéntico al camino viejo. La evidencia era un barrido de 200.000
  floats en `[0, 100)`. El AR midió dos contraejemplos FUERA de ese rango: `5e-7`
  (viejo 0 / nuevo 1) y `>= 1e21` (viejo **lanzaba** / nuevo devuelve un número).
  El segundo estaba fijado por un test (`T-SCI-2`) que nunca lo contrastaba
  contra el path viejo, así que el cambio **fail-closed → éxito** no quedaba
  declarado en ningún lado.
- **Causa raíz**: el salto de "0 diferencias en la muestra" a "idéntico". Una
  muestra prueba el rango de la muestra.
- **Fix**: docstring y test acotados a `[0, 100)` + `T-6-4`, que fija los dos
  contraejemplos contrastando explícitamente viejo vs nuevo.
- **Aplicar en**: todo invariante probado por muestreo se escribe con su dominio
  («para X en [a, b)») y con lo que pasa en los bordes. Y todo test que fija el
  comportamiento NUEVO de un cambio de conversión debe fijar también el VIEJO en
  el mismo assert, o el cambio de comportamiento queda tácito.

---

### [2026-07-26 13:25] AR it2 — Un doc nuevo que promete más de lo que el código valida es un bug que yo agregué

- **Error**: `doc/INTEGRATION.md` (agregado en este fix-pack) prometía «when you
  pass a `limit`, you get exactly `min(limit, total)` agents». Medido: `limit=0`
  devolvía los 10 de 10 y `limit=-3` devolvía 7 de 10 (`slice(0,-3)`). El
  comportamiento es **preexistente e idéntico en `main`** — el que no existía
  antes es el doc que lo contradice. Y en el mismo fix-pack sí había agregado
  validación estricta para `minReputation`: dos perillas del mismo endpoint con dos
  estándares.
- **Causa raíz**: escribir el contrato desde la intención del código en el happy
  path, sin probar los valores degenerados de cada parámetro que el contrato
  menciona.
- **Fix**: `parseLimit` (entero `>= 1`, o 400 `INVALID_LIMIT`) en el mismo leaf
  que el validador de `minReputation`, + 12 tests. Sin techo a propósito: el
  over-fetch es monótono y un techo reintroduciría el bug de H1.
- **Aplicar en**: cuando se escribe (o se cita) un contrato de API, cada
  parámetro nombrado se prueba con `0`, negativo, no entero y no numérico antes de
  publicar la frase. Si el código no lo cumple, se valida o se cambia la frase —
  nunca se deja la promesa suelta.

---

### [2026-07-26 13:35] AR it2 — Producto, no código: la escala nueva de `minReputation` cambia el contrato para clientes existentes

*(Anotado a pedido del AR. NO se arregla acá: es una decisión del founder.)*

- **Qué**: dos consecuencias de producto del filtro nuevo de `minReputation`, que
  ningún release note menciona:
  1. Con `REPUTATION_SCALE_FACTOR=50` y el cap anti-sybil K=5, un agente necesita
     **50 tasks capeadas de ≥10 callers distintos** para llegar a 100. Un caller
     que pida `minReputation=50` hoy ve un marketplace **casi vacío**. No es un
     bug del filtro (funciona como se diseñó): es que la escala y el catálogo real
     todavía no se conocen.
  2. Un cliente que venía usando la escala 0-1 **mal documentada** (el JSDoc decía
     0-1) y pasaba `?minReputation=0.8` recibía **todo** (el parámetro era un
     no-op) y ahora recibe **sólo agentes con ≥1 task liquidada**. Es un cambio de
     contrato defendible — el filtro por fin filtra — pero es un cambio.
- **Decisión pendiente del founder**: (a) comunicar el cambio de `minReputation`
  (release note / changelog del SDK), y (b) decidir si `REPUTATION_SCALE_FACTOR`
  sigue en 50 o se calibra contra el volumen real de tasks liquidadas, porque de
  ese número depende que el filtro sea usable o cosmético.
- **Aplicar en**: cuando un parámetro pasa de no-op a operativo, el cambio es de
  **contrato**, no de implementación, aunque el tipo no cambie. Merece release
  note incluso si el bug era obvio.
