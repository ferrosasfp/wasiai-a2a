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

### [2026-07-26 13:30] Waves 0-2 — El formatter de biome cortó tres veces

- **Error**: `biome check src/` falló tres veces por formato (líneas largas de más de 80
  columnas que el formatter parte solo).
- **Fix**: correr `./node_modules/.bin/biome check --write <archivos>` en cada archivo nuevo
  ANTES del gate, no al final.
- **Aplicar en**: siempre, es gratis.
