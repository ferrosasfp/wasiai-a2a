# Auto-Blindaje — HU 192 (`/gasless/transfer` refund on failure)

### [2026-07-26 14:10] Wave 1 — casi metí un refund que pagaba dos veces

- **Error**: mi primer diseño era el obvio: reembolsar en **todo** el `catch` del
  `transfer()`. Antes de escribirlo leí los adapters y encontré que
  `avalanche/gasless.ts` y `base/gasless.ts` tiran DESPUÉS de haber
  broadcasteado la tx (`receipt timeout (tx 0x…)`, `receipt failed`), y que el
  submit de Kite es un `POST` al relayer con `AbortSignal.timeout(15000)` que
  también puede cortarse con la tx ya enviada. Un refund ahí le devuelve el
  budget al caller **y** le deja el transfer confirmado: drena el wallet del
  operador. Habría sido peor que el bug original.
- **Causa raíz**: asumir que "el handler devolvió error" ⟹ "no pasó nada". En un
  money-path con I/O externo, el error puede ser del **read del resultado**, no de
  la acción. El error tipado no transportaba ninguna señal de si el valor se
  movió, así que desde la ruta era indecidible.
- **Fix**: `GaslessValueDisposition` (`'not-moved' | 'unknown'`) como parámetro
  **obligatorio** de `GaslessTransferError`; cada throw site de los 3 adapters
  reales lo declara; la ruta reembolsa sólo `'not-moved'` y para `'unknown'` deja
  un log loud (`gasless.refund-skipped.settlement-unknown`). Default para errores
  no clasificados = `'unknown'` (fail-safe: no reembolsar antes que inflar).
  Mutación M4 ("reembolsar siempre") queda roja.
- **Aplicar en**: cualquier refund que se agregue al `catch` de una acción con
  efecto externo (settle x402, escrow debit, payout, deposit). Antes de
  reembolsar hay que poder responder "¿el valor pudo haber salido?" con un dato
  del propio error, no con una suposición. Los candidatos inmediatos son las HUs
  de follow-up de `/registries` y `/tasks`: ahí el efecto es una escritura en DB
  (más fácil), pero la rama x402 sí paga on-chain y NO es reembolsable con
  `budgetService.credit`.

### [2026-07-26 14:28] Wave 2 — el refund existía y los tests lo tragaban en silencio

- **Error**: agregué el credit-back a la ruta y `src/routes/gasless.test.ts`
  siguió **verde 17/17**, incluido `T-AC3-ROUTE` (el 503 que ahora debe
  reembolsar). Parecía confirmación; era ceguera: el mock de `budgetService` de
  ese archivo sólo declaraba `getBalance`/`debit`/`registerDeposit`, así que
  `budgetService.credit` era `undefined`, el llamado tiraba `TypeError`, y mi
  propio `try/catch` best-effort (que existe para no romper el response) se lo
  comía. De paso, el `refundOutbox` real (no mockeado) intentaba un insert a
  supabase.
- **Causa raíz**: el patrón best-effort de los refunds (correcto en prod) hace
  que un refund **roto** sea indistinguible de un refund **ausente** si el test
  sólo mira el status code. Y un mock parcial de un service es exactamente el
  agujero por donde entra.
- **Fix**: (a) agregar `credit`/`creditDelegation`/`creditSession` y el mock de
  `refund-outbox` a `gasless.test.ts`, y hacer que `T-AC3-ROUTE` asierta el
  `credit` con `owner_ref`; (b) el archivo nuevo `gasless.refund.test.ts` no mira
  status: monta un **ledger stateful** y asierta el balance antes/después; (c)
  cobertura por línea de cada línea nueva (todas ≥1 hit) + 9 mutaciones, todas
  rojas.
- **Aplicar en**: todo test de money-path. Regla: si el código bajo prueba es
  best-effort, el test TIENE que asertar el efecto (balance/ledger/args), nunca el
  status; y hay que mirar cobertura de la línea nueva, porque "la suite quedó
  verde" es el resultado esperado tanto si el fix funciona como si nunca corre.
  Es la misma lección que la memoria `gotcha-refund-inalcanzable-route-handler`
  (HU 188: 0 hits sobre 3197 tests), por otra vía: allá el código era
  inalcanzable, acá era alcanzable pero fallaba en silencio.

### [2026-07-26 14:26] Wave 2 — tipo mal escrito al inferir el retorno del adapter

- **Error**: escribí
  `let status: Awaited<ReturnType<typeof getGaslessAdapter>['status']>>;` (un `>`
  de más y, además, faltaba el `ReturnType` interno) para tipar la variable que
  saqué del try.
- **Causa raíz**: inferir un tipo con gimnasia de `typeof` cuando el proyecto ya
  exporta el tipo nominal.
- **Fix**: `GaslessAdapterStatus` desde `../adapters/types.js` (el mismo tipo que
  implementan los adapters). `tsc --noEmit` lo cazó en el acto.
- **Aplicar en**: cuando hace falta declarar una variable para sacar un `await`
  de un `try`, buscar primero el tipo exportado del contrato; la gimnasia de
  `ReturnType`/`Awaited` sólo si no existe.

### [2026-07-26 14:05] Wave 0 — el seam de la HU anterior resolvía OTRO problema

- **Error**: el instinto era "ya existe `onDebitOrphaned`, pasalo y listo".
- **Causa raíz**: reusar un mecanismo por su nombre ("refund del débito") sin
  releer **por qué** existe. `refundIfDebitOrphaned` corre sólo con
  `reply.sent === true` al final del branch de débito, condición que sólo produce
  un 504 disparado desde fuera del lifecycle.
- **Fix**: verificar que `/gasless/transfer` no monta `createTimeoutHandler`
  (`grep -rn createTimeoutHandler src/`: compose, orchestrate ×3, inbound,
  agent-links — gasless no aparece) y que la instancia de Fastify no configura
  `requestTimeout`/`connectionTimeout` (`src/index.ts:59-70`) ⟹ el hook tendría
  cero hits. El refund va en el handler, que sí corre, y se probó por cobertura.
  Queda un comentario en la ruta: si se le agrega un timeout, hay que pasar el
  hook.
- **Aplicar en**: antes de reusar un seam de una HU previa, leer su docblock de
  "POR QUÉ ACÁ" y confirmar que la precondición se cumple en la ruta nueva. Un
  seam mal reusado no falla: no corre nunca, y deja una falsa protección
  documentada.
