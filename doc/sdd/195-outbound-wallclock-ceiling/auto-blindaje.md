# Auto-Blindaje — HU-195 (techo de wall-clock por hop outbound)

Errores cometidos y corregidos DURANTE la implementación. No es un changelog: es
la lista de trampas que la próxima HU no tiene que volver a pisar.

---

### [2026-07-28 22:20] Fix-pack AR — "alinear el timeout con el que ya declaraba la race" convirtió un fail-closed en fail-open

- **Error**: en `src/lib/gas-overhead.ts` se puso
  `AbortSignal.timeout(LIVE_CALC_TIMEOUT_MS)` en el hop de CoinGecko con el
  comentario *"cero cambio en el valor devuelto"*. Falso: con CoinGecko colgado el
  valor pasó de `undefined` (⟹ `GasOverheadUnavailableError` en producción,
  fail-closed G-02) a `0.06` **cacheado 60 s**. Medido: pre-fix `result=0
  elapsedMs=2004`; con el fix `result=0.06 elapsedMs=2003`.
- **Causa raíz**: el `catch` de `getNativeTokenUsd` cae al
  `<SYM>_USD_FALLBACK`, y ese camino era **INALCANZABLE** mientras el fetch
  quedaba pendiente para siempre. Abortar el fetch DENTRO del presupuesto de la
  `Promise.race` lo volvió alcanzable: el timer del `AbortSignal` se registra
  ANTES que el `setTimeout` de la race (mismo ms ⟹ gana por orden de inserción),
  así que el fetch rechaza, el fallback resuelve y la race **resuelve** en vez de
  rechazar. "Poner un timeout" tocó semántica de dinero sin que nadie lo decidiera.
- **Fix**: presupuesto del hop **estrictamente mayor** que el de la race
  (`PRICE_HOP_TIMEOUT_MS = LIVE_CALC_TIMEOUT_MS + 500`). A los 2 s la race
  rechaza (semántica vieja intacta) y a los 2.5 s muere el socket (el beneficio
  nuevo). OJO: acotar el hop POR DEBAJO de la race (1.8 s vs 2 s) NO sirve — el
  fetch rechazaría antes y el fallback resolvería igual.
- **Aplicar en**: CUALQUIER `Promise.race([trabajo, timeout])` donde el trabajo
  tenga un `catch` con fallback. Acortar el presupuesto del trabajo por debajo
  del de la race cambia QUÉ RAMA gana. Antes de agregar un `AbortSignal` a un
  fetch que vive dentro de una race, medir el valor devuelto con el peer colgado,
  ANTES y DESPUÉS.

---

### [2026-07-28 22:24] Fix-pack AR — un test que sólo mira que el guard EXISTA deja pasar el mutante que restaura el bug

- **Error**: `T-195-GAS-1` asertaba `init.signal instanceof AbortSignal` y
  `aborted === false`, nada más. El AR mutó
  `AbortSignal.timeout(LIVE_CALC_TIMEOUT_MS)` → `AbortSignal.timeout(300_000)`
  —o sea, reintrodujo EXACTAMENTE el bug que el commit dice arreglar— y la suite
  del archivo dio **29 passed, 0 rojos**.
- **Causa raíz**: `AbortSignal.timeout` no expone sus ms, así que el test se
  escribió sobre lo único inspeccionable (el tipo del objeto) en vez de sobre el
  EFECTO. Un guard cuyo VALOR no está cubierto es un guard sin candado.
- **Fix**: testear el efecto — fetch que cuelga hasta que lo aborten, y medir (a)
  el valor devuelto y (b) cuándo muere el socket, con cota. `T-195-GAS-2` mata las
  dos puntas (techo ≤ race ⟹ valor 0.06; techo 300 s o sin signal ⟹ no aborta),
  `T-195-GAS-3` fija el throw en producción y `T-195-GAS-4` la invariante entre
  las dos constantes. Las 4 mutaciones verificadas ROJAS.
- **Aplicar en**: todo timeout/ceiling nuevo. `vi.useFakeTimers` NO controla los
  timers de `AbortSignal.timeout` (viven en los timers internos de Node), así que
  el test paga reloj real: preferir constantes chicas o presupuestos inyectables.

---

### [2026-07-28 22:26] Fix-pack AR — el techo declarado no incluía la fase de DNS

- **Error**: `.env.example` y `lib/outbound-timeout.ts` decían "techo de
  wall-clock de UN request outbound". Medido con `node:dns` a 1 500 ms y
  `OUTBOUND_HOP_TIMEOUT_MS=200`: `elapsedMs=1505`, **7.5× el techo declarado**.
- **Causa raíz**: `assertUrlAllowed` corría dentro del loop de hops pero **fuera**
  del `signal`, y `url-validator.ts:296` hace `dns.lookup` sin timeout. El fix
  original acotó el `fetch`, que es lo que se ve, y no el pre-flight, que es lo
  que corre antes.
- **Fix**: `assertUrlAllowedWithinBudget` corre el pre-flight en carrera contra el
  MISMO `wallClockSignal` (`ssrf-dispatcher.ts`), con `removeEventListener` en el
  `finally` para no acumular listeners por hop. Tests `T-195-DNS-1/2/3`.
- **Aplicar en**: cuando se declara un techo, enumerar las FASES que cubre. Todo
  `await` que esté antes del `fetch` en el mismo camino también gasta wall-clock.
  Y residual honesto: `dns.lookup` no acepta `signal` y ocupa un thread de libuv,
  así que la carrera acota la espera, NO el recurso.

---

### [2026-07-28 22:28] Fix-pack AR — el clamp miraba UN solo 504 de dos posibles

- **Error**: `resolveOutboundHopTimeoutMs` clampeaba sólo contra
  `TIMEOUT_COMPOSE_MS` (180 s). Pero `/orchestrate`, `/inbound` y `/agent-links`
  invocan el MISMO compose con `TIMEOUT_ORCHESTRATE_MS` (120 s), así que
  `OUTBOUND_HOP_TIMEOUT_MS=180000` —un valor que el clamp ACEPTA— daba un techo de
  hop mayor que el 504 de esas 3 rutas.
- **Causa raíz**: se buscó "el timeout del request" y se encontró el del `/compose`
  sin verificar si era el único. La invariante estaba bien pensada y mal cableada.
- **Fix**: `Math.min` de las dos envs, cada una con su default y su fallback de
  basura. Tests `T-195-ENV-7/8/9/10` (los 4 rojos al revertir el `min`).
- **Aplicar en**: cualquier clamp contra "el timeout del request" → `grep` de
  TODAS las rutas que invocan el mismo service. Acá eran 5 call-sites en 3 rutas.

---

### [2026-07-28 22:29] Fix-pack AR — `AbortSignal.timeout` no produce `AbortError`

- **Error**: `mcp/tools/pay-x402.ts` clasificaba solamente
  `err.name === 'AbortError'`, así que el techo del hop (que produce un
  `DOMException` con `name === 'TimeoutError'`) no mapeaba al `-32002`
  estructurado y salía como error crudo.
- **Causa raíz**: el mapeo se escribió para `controller.abort()` y el techo nuevo
  usa `AbortSignal.timeout`, que tiene OTRO nombre de error. Hoy inalcanzable
  (`MCP_PAY_TIMEOUT_MS=30000 < 60000`) y alcanzable en cuanto un operador sube esa
  env: un bug latente que sólo aparece por configuración.
- **Fix**: `TIMEOUT_ERROR_NAMES = new Set(['AbortError', 'TimeoutError'])` + test
  parametrizado con los dos nombres (rojo al sacar `TimeoutError`).
- **Aplicar en**: todo `catch` que clasifique aborts. `controller.abort()` →
  `AbortError`; `AbortSignal.timeout()` → `TimeoutError`; `AbortSignal.any` propaga
  la reason del que ganó, y `controller.abort(x)` acepta CUALQUIER valor (no
  necesariamente un `Error`).

---

### [2026-07-28 22:31] Fix-pack AR — `grep 'fetch('` no es un barrido de egress

- **Error**: la tabla de "sitios outbound" era el output literal de
  `grep -rn "fetch(" src/`, y por eso no incluía `lib/supabase.ts:33` (todo el
  money-path de DB sin cota de wall-clock). Además `createClient<Database>(` **no
  matchea** `grep "createClient("` por el genérico.
- **Causa raíz**: se confundió "todas las llamadas HTTP que escribimos" con "todo
  el egress del proceso". El egress de un SDK (supabase-js, @anthropic-ai/sdk,
  viem, @solana/web3.js) se encuentra por el CONSTRUCTOR del cliente, nunca por la
  llamada.
- **Fix**: barrido de 5 pasos documentado en el work-item §2, con el punto ciego
  declarado, y `supabase.ts:33` en la tabla como excluido con su razón.
- **Aplicar en**: todo inventario de I/O. Declarar el MÉTODO y qué clase de caso
  no puede ver. Un barrido sin método declarado se lee como exhaustivo.

---

### [2026-07-28 22:33] Fix-pack AR — "acotarlo cancelaría plata en vuelo" es mecánicamente falso

- **Error**: se justificó la exclusión del `/settle` de Kite (modo pieverse)
  diciendo que acotarlo "cancelaría plata ya broadcasteada".
- **Causa raíz**: se importó el argumento correcto para el abort a nivel PIPELINE
  y se aplicó a un hop HTTP, donde no vale. Abortar el request al facilitator NO
  cancela un broadcast: deja al gateway CIEGO al resultado (estado `unknown`). Y
  contradecía 4 precedentes del propio repo que ya acotan `/settle` a 30 s.
- **Fix**: justificación real escrita en `lib/outbound-timeout.ts` y en el
  work-item §4 — es una HU de money-path (hay que decidir qué se hace con un
  settle de resultado desconocido), más el dato que faltaba:
  `KITE_FACILITATOR_MODE` default = `pieverse` ⟹ los 2 sitios sin cota son el
  camino VIVO, no código muerto.
- **Aplicar en**: antes de escribir "no se puede acotar X", verificar qué hace
  realmente el abort en esa capa y buscar precedentes en el repo. Si 4 sitios
  equivalentes ya lo hacen, el argumento no es "no se puede".
