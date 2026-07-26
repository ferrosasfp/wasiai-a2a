# Auto-Blindaje — WKH-191x (Dashboard Live Trace)

Errores REALES de la sesión F3 y cómo se corrigieron. El objetivo es que la próxima HU
no los repita.

### [2026-07-26 13:05] Wave 0 — La fuente de datos del enunciado no coincidía con el código

- **Error**: el plan inicial agrupaba TODO por `orchestration_id`, siguiendo la premisa
  "los recibos de un `/compose` correlacionan con `metadata.requestId`". Con esa premisa la
  pantalla habría salido vacía o con grupos falsos.
- **Causa raíz**: los 4 emisores de `budget_debit` pasan `orchestrationId: null`
  (`src/services/budget.ts:73`/`:174`/`:258`, `src/middleware/a2a-key.ts:1268`); sólo los
  `protocol_fee` llevan el id. Y `/orchestrate*` genera su `orchestrationId` con
  `crypto.randomUUID()` (`src/routes/orchestrate.ts:90`/`:197`/`:347`), que NO es
  `request.id`, así que ahí la correlación no existe.
- **Fix**: unión de tres fuentes con clave explícita y un campo `correlation`
  (`full` / `call-only` / `money-only`) que le dice a la pantalla qué está viendo. Nada de
  emparejar por ventana temporal: `a2a_events` no tiene columna de owner, así que el
  recibo del tenant A podría atribuirse a la llamada del tenant B (fuga cross-tenant en
  una pantalla de auditoría).
- **Aplicar en**: cualquier HU que asuma un JOIN entre telemetría y recibos. Verificar en
  el emisor (grep del `receiptType`) qué campos se escriben REALMENTE antes de diseñar el
  agrupado. Un dato "verificado en la DB" puede ser cierto para una tabla y falso para la
  fila de al lado.

### [2026-07-26 13:10] Wave 0 — El conteo pedido no era calculable con el schema actual

- **Error**: se dio por hecho que los skip-codes del leg downstream estaban persistidos.
- **Causa raíz**: `toPublicSkipCode` se usa en UN solo lugar
  (`src/services/compose.ts:722`) y alimenta la respuesta HTTP y los logs. Ninguna tabla
  guarda el motivo.
- **Fix**: persistencia ADITIVA en `a2a_events.metadata` (jsonb, sin migración), con el
  mismo patrón spread-condicional de `payment_origin`. El valor se toma de
  `StepResult.downstreamSettle`, cuyo tipo es `` `skipped:${PublicDownstreamSkipCode}` ``:
  por tipos NO puede entrar un código interno. La UI distingue "sin datos" de "cero skips"
  (`skipSignalPresent`).
- **Aplicar en**: antes de prometer una métrica, buscar la columna que la guarda. Si no
  existe, la opción barata suele ser un jsonb ya existente, nunca una migración a último
  momento ni un dato inventado.

### [2026-07-26 13:15] Wave 0 — Link de explorer roto en Solana

- **Error**: el primer diseño armaba la URL como `explorerUrl + '/tx/' + hash`.
- **Causa raíz**: el explorer de Solana se configura con query string
  (`https://explorer.solana.com?cluster=devnet`, `src/adapters/solana/index.ts:36`), así
  que la concatenación produce `…?cluster=devnet/tx/<sig>`, que no resuelve.
- **Fix**: `buildExplorerTxUrl` usa `new URL` y escribe el `pathname`, preservando el
  query. Cubierto por test explícito.
- **Aplicar en**: toda construcción de URL a partir de config. Parsear, no concatenar.

### [2026-07-26 13:20] Wave 1 — `fee_usdc` no es el fee total

- **Error**: la primera versión de la UI iba a mostrar `fee_usdc` como "el fee".
- **Causa raíz**: `fee_usdc` es SÓLO la pata plataforma del split; el total es
  `fee_total_usdc` (WKH-167), que es NULL en filas viejas.
- **Fix**: el payload expone los dos por separado (`totalUsd` / `platformUsd`) y la
  pantalla avisa cuando la fila es vieja y el número que muestra no es el total.
- **Aplicar en**: cualquier lectura de `a2a_protocol_fees`.

### [2026-07-26 13:26] Wave 1 — Factory de `vi.mock` referenciando una const del módulo

- **Error**: `vi.mock('../adapters/registry.js', () => ({ … BUNDLES … }))` con `BUNDLES`
  declarado como `const` normal arriba: la factory corre durante la fase de imports, o sea
  ANTES de inicializar la const (TDZ).
- **Causa raíz**: `vi.mock` se hoistea por encima de los imports; sus factories no ven el
  scope del módulo todavía inicializado.
- **Fix**: `const BUNDLES = vi.hoisted(() => ({ … }))`.
- **Aplicar en**: todo test nuevo que mockee con fixtures compartidos. Patrón ya usado en
  `reconciliation.test.ts`.

### [2026-07-26 13:34] Wave 2 — `esc()` no escapaba comillas y se usa dentro de atributos

- **Error**: la función de escape de la pantalla usaba sólo el truco del text node, que
  escapa `&`, `<` y `>`, pero su salida también se interpola en atributos
  (`href="…"`, `class="…"`).
- **Causa raíz**: se copió el `esc()` de `dashboard.html` sin revisar el contexto de uso.
  Los datos vienen de la DB (identificador del caller, nombres de red, hashes).
- **Fix**: `esc()` escapa además `"` y `'`. El smoke de render incluye un caller con
  `<script>` para verificar el escape.
- **Aplicar en**: cualquier UI que arme HTML por concatenación. Escapar pensando en el
  peor contexto donde se va a interpolar, no en el primero.

### [2026-07-26 13:33] Wave 2 — El tripwire de AC-8 es literal, y una prosa lo rompió

- **Error**: el test "la pantalla no puede disparar un pipeline" falló porque un COMENTARIO
  del HTML mencionaba la ruta `/compose`.
- **Causa raíz**: el test asserta que el literal no aparece en el archivo (a propósito: es
  la única forma de que un `fetch` nuevo lo despierte).
- **Fix**: se reescribió el comentario sin el literal y se dejó el test estricto. Mismo
  caso con `owner_ref` en otro comentario y el tripwire de AC-3.
- **Aplicar en**: cuando un test prohíbe un literal en un archivo, la prosa de ese archivo
  también está sujeta a la regla. Vale la pena decirlo en el propio comentario.

### [2026-07-26 14:00] Fix-pack AR — Instrumenté UN camino de salida y llamé "instrumentado" al handler

- **Error**: `noteDownstreamSkips` quedó SOLO en el `return` del 200 de `/compose`
  (`compose.ts:810`). La rama de fallo (`!result.success`, que retorna en `:721`) nunca
  pasaba por ahí, así que su fila de `a2a_events` no ganaba `downstreamSkips`, `metaSkips`
  devolvía `null` y `skipCounts` descartaba el evento con `continue`.
- **Impacto real (no teórico)**: un pipeline donde el step 1 no le pudo pagar al agente y
  el step 2 falla le manda el `skipped:*` al caller EN EL BODY del 400, y al mismo tiempo
  la pantalla del operador podía mostrar `0` con el texto "es el estado bueno". La API
  decía una cosa y la pantalla otra.
- **Causa raíz**: leí el handler por su camino feliz. `/orchestrate` sí estaba completo
  (200 y 403) porque ahí las dos salidas están juntas; en `/compose` están separadas por
  ~90 líneas de fee/recibos y la de fallo se sale antes.
- **Fix**: `noteDownstreamSkips(request, result.steps)` también antes del return de la rama
  de fallo (`compose.ts:728`), cubriendo 400 y 403 con el mismo statement. Verificado por
  MUTACIÓN (borrar la línea → 3 tests rojos).
- **Aplicar en**: cuando se agrega telemetría a un handler, enumerar TODOS sus `return`
  (`grep -c 'return reply'`) antes de declararlo cubierto. Un test por camino de salida, no
  por handler.

### [2026-07-26 14:05] Fix-pack AR — Un tope de query presentado como "la ventana"

- **Error**: `skipCounts` leía los 500 eventos más recientes (`SKIP_SCAN_LIMIT`) y la UI
  rotulaba el resultado `Pagos salteados (últimas 24 h)`. Con más de 500 llamadas en la
  ventana, el número no es el de la ventana y nada lo indicaba.
- **Causa raíz**: el techo se puso por costo de query (correcto) y se documentó en un
  comentario del service (insuficiente): el consumidor de ese número es una PANTALLA, y el
  rótulo de la pantalla afirmaba una cobertura que el service no daba.
- **Fix**: el service devuelve `scanned`/`truncated` (`rows.length >= SKIP_SCAN_LIMIT`),
  `health` lo expone como `skipScanLimit`/`skipScanTruncated`, y la pantalla cambia el
  rótulo a "últimas 500 llamadas, no toda la ventana", agrega "CONTEO INCOMPLETO" y
  DEJA DE DECIR "es el estado bueno" en ese caso.
- **Aplicar en**: todo `.limit()` cuyo resultado se muestre como un agregado. Si la query
  puede tapar filas, el payload tiene que decirlo y la UI tiene que rotularlo. Mismo
  estándar que ya se aplicó con `skipSignalPresent` ("sin datos" ≠ "cero"): que una
  pantalla diga "no sé" es aceptable, que diga "todo bien" sin saberlo no.

### [2026-07-26 14:10] Fix-pack AR — Persistencia sin test: la suite no notaba que se borrara

- **Error**: el spread `...(request.downstreamSkips ? { downstreamSkips … } : {})`
  (`event-tracking.ts:132-134`) no tenía NINGÚN test. El AR lo reemplazó por un comentario
  y los 3452 tests siguieron verdes: los call-sites se ejecutaban, pero nadie asertaba que
  el dato llegara al insert.
- **Causa raíz**: se testeó la FUNCIÓN pura (`parseSkippedMarker`, `isPublicSkipCode`) y el
  CONSUMIDOR (`trace.test.ts` con metadata inventada en el fixture), y quedó sin cubrir el
  único punto donde los dos se conectan: el hook que escribe la fila. Un test con fixture
  del dato ya presente NUNCA prueba que alguien lo escriba.
- **Fix**: 4 casos en `event-tracking.test.ts` (T-SKIP-1..4) que inyectan un request real y
  asertan `metadata.downstreamSkips`, incluyendo la distinción `[]` presente vs clave
  ausente. Verificado por MUTACIÓN: borrando el spread, 3 de los 4 se ponen rojos (el
  cuarto asserta la AUSENCIA de la clave, así que sobrevive por diseño).
- **Aplicar en**: cuando el flujo es "productor → jsonb → consumidor", el test del
  consumidor con fixture NO cubre al productor. Pedir siempre la prueba por mutación de la
  línea que escribe.

### [2026-07-26 14:15] Fix-pack AR — El escape se verificó con un script que no quedó en el repo

- **Error**: la corrección del `esc()` (agregar `&quot;`/`&#39;`) se validó con un smoke
  suelto, fuera del repo. Sin test, si alguien vuelve a copiar el `esc()` de
  `dashboard.html` (que NO escapa comillas) la regresión pasa la suite entera.
- **Causa raíz**: el `esc()` dependía del DOM (`document.createElement`) y en este repo no
  hay jsdom, así que "no se podía testear" y quedó como script manual. La dependencia era
  la que había que sacar, no el test.
- **Fix**: `esc()` pasa a ser string puro (5 reemplazos, `&` primero) y
  `dashboard-trace.render.test.ts` ejecuta el JS REAL de la pantalla (extraído del HTML)
  con un DOM mínimo, pasándole datos hostiles de tenant. Verificado por MUTACIÓN: sacando
  el escape de comillas se ponen rojos 3 tests.
- **Aplicar en**: si una función no se puede testear por su dependencia del entorno,
  evaluar primero sacar la dependencia. Un helper de seguridad sin test no es una
  corrección, es una intención.

### [2026-07-26 14:20] Fix-pack AR — La pantalla prometía un reintento que no ocurría

- **Error**: `markStale` decía "Reintentando cada 10 s" pero el `setInterval` se armaba
  SOLO después de un fetch exitoso. Abrir la pantalla con el gateway caído dejaba el aviso
  y ningún reintento: había que apretar Ver otra vez.
- **Causa raíz**: el arme del polling estaba escrito al final del camino feliz de
  `refresh()`, así que cada `return` temprano se lo saltaba (mismo patrón de error que el
  bloqueante de `/compose`: lógica al final de UN camino de salida).
- **Fix**: `startPolling()` idempotente, llamado desde el camino feliz Y desde `markStale`.
  El 401/503 sigue SIN polling a propósito (no se arreglan solos y su texto no promete
  reintento), y hay un test que fija esa asimetría.
- **Aplicar en**: cuando el texto de una UI promete un comportamiento, ese texto es un AC.
  Testearlo, o no prometerlo.

### [2026-07-26 13:30] Waves 0-2 — El formatter de biome cortó tres veces

- **Error**: `biome check src/` falló tres veces por formato (líneas largas de más de 80
  columnas que el formatter parte solo).
- **Fix**: correr `./node_modules/.bin/biome check --write <archivos>` en cada archivo nuevo
  ANTES del gate, no al final.
- **Aplicar en**: siempre, es gratis.
