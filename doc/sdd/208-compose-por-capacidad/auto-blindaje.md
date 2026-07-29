# Auto-Blindaje — HU-208

### [2026-07-29] Wave 2 — El refund del step-0 divergía del débito real

- **Error**: `refundComposeStep0` (`routes/compose.ts`) leía
  `request.composeEstimatedCostUsd` directo para decidir cuánto acreditar, y
  bailaba si el campo era `undefined`. Pero el middleware debita con
  `resolveStep0DebitUsd`, que ante ese mismo `undefined` cae a
  `PLACEHOLDER_FEE_USD` ($1). Resultado: en todo camino donde el preHandler de
  precio no alcanza a inyectar el campo, el caller quedaba **cobrado $1 y sin
  reembolso**.
- **Causa raíz**: dos expresiones separadas para "cuánto se debitó el step-0".
  `lib/step0-debit.ts` se creó en HU-193 exactamente para impedir esto, y su
  docstring lo dice ("con dos expresiones separadas... reembolsaría de más"), pero
  sólo `lib/step0-refund.ts` lo adoptó; `refundComposeStep0` siguió calculándolo
  por su cuenta. La divergencia se manifestó en la dirección OPUESTA a la que el
  docstring anticipaba: reembolsar **de menos**, no de más.
- **Fix**: `refundComposeStep0` usa `resolveStep0DebitUsd(request)` — la misma
  función del middleware (invariante #4 de `lib/step0-refund.ts`). Con el campo
  inyectado (el 99.99% de los requests) el valor es idéntico al anterior.
- **Cómo apareció**: escribiendo el test del guard "nada se ejecuta sin resolver"
  (`T-CAPROUTE-11`), que afirma que el balance vuelve a su valor inicial y no sólo
  que la respuesta es 400. Un test que sólo mirara el status code no lo habría
  encontrado.
- **Aplicar en**: cualquier ruta que debite vía el middleware y reembolse por su
  cuenta. Hoy queda `routes/gasless.ts:refundGaslessDebit`, que tiene aritmética
  propia (todo-o-nada del transfer) — **revisar si su monto también puede divergir
  del débito real**. No se tocó en esta HU.

### [2026-07-29] Wave 3 — Test de reparto aleatorio que no repartía

- **Error**: el primer `T-DISCFILT-08` fijaba la fuente aleatoria a una secuencia
  alternada `flip++ % 2` esperando que el ganador alternara entre corridas. Fallaba
  siempre a favor del mismo agente.
- **Causa raíz**: la secuencia tiene período 2 pero **cada corrida consume 2
  valores** (uno por agente), así que cada corrida recibía siempre el mismo par en
  el mismo orden. El test verificaba una propiedad que su propio setup hacía
  imposible.
- **Fix**: PRNG sembrado (LCG con semilla fija) en vez de una secuencia armada a
  mano: da una distribución genuina y sigue siendo reproducible, así que prueba
  reparto de verdad sin volverse flake.
- **Aplicar en**: cualquier test que inyecte una secuencia determinista donde el
  código bajo prueba consume N valores por iteración. Si el período de la
  secuencia divide a N, el test mide una constante.

### [2026-07-29] Wave 3 — Mutación M5 sobrevivió: el gate de back-compat no estaba cubierto

- **Error**: quitar el gate `steps.some(capability)` del preHandler de resolución
  no rompía ningún test. La afirmación de back-compat ("un llamador de hoy no paga
  ni una query extra") no estaba respaldada.
- **Causa raíz**: el test sólo afirmaba que `discover` no se llamaba. Sin el gate,
  `discover` **sigue** sin llamarse para steps nombrados — pero sí se ejecuta
  `resolveCallerScope`, que es una query a la DB por request.
- **Fix**: `T-CAPROUTE-09` ahora afirma `lookupByHash` llamado **exactamente una
  vez** (la del middleware de pago). Con la mutación pasa a dos y el test cae.
- **Aplicar en**: toda afirmación del tipo "no agrega costo". Hay que asertar el
  costo (llamadas a I/O), no sólo el efecto observable.
