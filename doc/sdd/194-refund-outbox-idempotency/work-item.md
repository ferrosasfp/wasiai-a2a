# HU-194 — El refund-outbox podía acreditar dos veces

Branch: `fix/refund-outbox-idempotency` · base `main@050840d`

## 1. El problema

`src/services/refund-outbox.ts:10-17` declaraba el invariante *"SOLO se encola
cuando NADA se aplicó"*. Ese invariante es **demostrable** para el camino
`success:false` (el check de filas afectadas de A2, `src/services/budget.ts:478`
pre-HU-194) pero **NO** para el camino de **excepción**.

La secuencia que rompía:

1. `supabase.rpc('refund_a2a_key_spend')` **commitea** (la plata ya volvió).
2. Se pierde la respuesta: socket reset, timeout post-commit, pod matado.
3. `budgetService.credit` rechaza → el call-site entra al `catch`.
4. El `catch` encola en `a2a_refund_outbox`.
5. `processRefundOutbox` reintenta el credit → **segundo crédito**.

El caller recibía el monto dos veces y su budget quedaba inflado. Es la misma
ambigüedad que HU-192 resolvió para el transfer gasless ("el error puede ser del
read, no de la acción"), que para el refund seguía abierta.

## 2. Por qué una clave sólo en el outbox NO alcanza

Si la dedup viviera únicamente en `a2a_refund_outbox` (columna `idem_key` +
índice único), el agujero seguiría abierto: el crédito **original** — el que
commiteó y cuya respuesta se perdió — **no dejó ningún rastro** con esa clave. El
reintento del sweep sería la PRIMERA fila con esa clave y se aplicaría igual.

El rastro tiene que quedar en la **misma transacción que mueve el dinero**, del
lado de Postgres. De ahí las tres piezas del fix:

| Pieza | Dónde | Qué hace |
|---|---|---|
| `a2a_refund_applications` | migración | ledger de refunds APLICADOS, `idem_key` como PRIMARY KEY |
| `refund_idem_claim(...)` | migración | `TRUE` = reclamada acá (aplicar), `FALSE` = ya aplicada (no-op). Serializa por el PK, no por un guard en TS |
| `p_idem_key` en las 4 RPC de refund | migración | consultan el claim ANTES de mover dinero; ya aplicada ⟹ `RETURN 1` |

`RETURN 1` para "ya aplicada" mantiene el contrato `reverted = data >= 1` que
leen los services: significa "la plata está de vuelta", que es exactamente lo que
el retry adaptativo de `/compose` necesita saber para decidir si re-debita, y lo
que el sweep necesita para marcar `done`.

## 3. El diseño de la clave

`src/lib/refund-idem.ts` → `v1:<keyId>:<chainId>:<operationId>:<slot>`

- **`keyId` + `chainId`**: a qué budget vuelve la plata. Ninguna clave puede
  cruzar tenants ni chains, ni por accidente ni a mano.
- **`operationId`**: UUID **server-side** de la operación que dejó el débito.
- **`slot`**: el refund lógico DENTRO de esa operación.

Identifica el refund **LÓGICO**, no el intento:

- todos los intentos del mismo refund (el credit del call-site + los N reintentos
  del sweep) comparten clave ⟹ se aplica UNA vez;
- dos refunds legítimos DISTINTOS de la misma operación tienen claves distintas
  ⟹ no se colapsan y no se pierde ningún crédito real.

### 3.1. El caso que NO puede colapsar (y por qué el `slot` existe)

En `/compose`, un mismo step puede necesitar **dos créditos reales**:

- `services/compose.ts` PASO 1: refund del PRIMER débito del step.
- `services/compose.ts` PASO 6b: refund del débito del **retry adaptativo** del
  MISMO step, cuando el retry también falla.

Mismo `keyId`, misma chain, mismo monto, mismo destino, misma ejecución, y el
mismo `reason` (`compose.refund-failed`). Si la clave no los distinguiera, el
segundo crédito (dinero REAL del caller) se descartaría como duplicado y el
caller se quedaría con un débito sin devolver. Por eso el slot lleva la fase:
`compose-step:3:d1` vs `compose-step:3:d2`.

### 3.2. El `reason` NO entra en la clave

Un mismo refund lógico se encola con `reason` distinto según CÓMO falló
(`:refund-failed` vs `:refund-threw`). Si el reason entrara en la clave, esos dos
caminos darían claves distintas y el sweep podría acreditar dos veces.

### 3.3. Por qué NO `request.id` ni `orchestrationId`

Ambos son (o pueden ser) **caller-controlled**:

- `request.id` sale del header `request-id` cuando el caller lo manda
  (`Fastify({ genReqId })` sólo cubre el caso en que NO viene).
- `POST /orchestrate/execute` recibe `orchestrationId` **en el body**
  (`src/routes/orchestrate.ts`, `OrchestrateExecuteBody`).

Un caller que repitiera el mismo id en dos requests haría que su SEGUNDO refund
(legítimo, de otro débito) se descartara como duplicado. Por eso el `operationId`
siempre es un UUID generado server-side por operación:
`requestRefundIdemBase(request)` (memoizado en el request) para las rutas,
`composeRunId` para el pipeline de compose, y un `refundRunId` propio por
ejecución en orchestrate.

## 4. Los 8 call-sites

Los 6 del reporte más 2 que comparten exactamente el mismo patrón y estaban
afuera de la lista (`src/lib/step0-refund.ts`, el helper de HU-193 que usan
`/tasks` y `/registries`):

| # | Call-site | Slot |
|---|---|---|
| 1 | `src/routes/gasless.ts` (refund-failed) | `gasless` |
| 2 | `src/routes/gasless.ts` (refund-threw) | `gasless` (la MISMA) |
| 3 | `src/routes/compose.ts` (refund-failed) | `compose-step0` |
| 4 | `src/routes/compose.ts` (refund-threw) | `compose-step0` (la MISMA) |
| 5 | `src/services/compose.ts` (refund per-step) | `compose-step:<i>:d1` / `:d2` |
| 6 | `src/services/orchestrate.ts` (refund step-0) | `orchestrate-step0` |
| 7 | `src/lib/step0-refund.ts` (refund-failed) | `step0` |
| 8 | `src/lib/step0-refund.ts` (refund-threw) | `step0` (la MISMA) |

Los pares failed/threw comparten clave a propósito (§3.2). El compilador es el
que garantiza que ningún call-site se olvide: `idem` es un parámetro
**REQUERIDO** de las 4 variantes de `credit*` y `idemKey` es requerido en
`RefundOutboxEntry`. Y es un **objeto**, no un `string`, para que un `destination`
suelto no pueda caer en la posición de la clave por error.

## 5. Compatibilidad y residuo

- La columna `a2a_refund_outbox.idem_key` es NUEVA y NULLABLE. Las filas ya
  encoladas quedan con NULL y el sweep las procesa **exactamente como antes**
  (`p_idem_key => NULL` ⟹ cero dedup). No se les puede deducir una clave: nadie
  registró el crédito original. **Residuo documentado, no inventado.**
- Las llamadas SQL de 4 args que ya existían
  (`supabase/migrations/20260704100000_wkh139_arbiter.sql:337,349,353`) siguen
  resolviendo por el `DEFAULT NULL` → sin dedup, igual que hoy.
- `p_idem_key` no cambia NUNCA el monto ni el destino de un refund legítimo. El
  objetivo es que se aplique **una vez**, no que se aplique distinto.

## 6. Amount mismatch: fail-closed y visible

Si llega la misma clave con OTRO monto es reuso indebido de clave (un bug), no un
reintento. La RPC levanta `REFUND_IDEM_AMOUNT_MISMATCH` y **no aplica nada**; los
services lo mapean a un code estable (sin msg crudo de PG). El entry del outbox
muere en `dead` con `last_error` para revisión manual, en vez de acreditar un
monto ambiguo. La comparación tiene tolerancia de 1e-9 USD para absorber el ida y
vuelta float↔NUMERIC (un falso mismatch BLOQUEARÍA un crédito legítimo).

## 7. Orden de locks (anti-deadlock)

`a2a_delegations`/`a2a_key_sessions` → `a2a_agent_keys` →
`a2a_refund_applications` → `a2a_key_dest_spend_ledger`, en TODOS los caminos.

Los wrappers dual-ledger toman el `FOR UPDATE` de la key ANTES de reclamar la
clave (el refund del parent lo tomaría igual un momento después). Sin esa
normalización, el camino master (key → marcador) y el wrapper (marcador → key)
podrían cruzarse y deadlockear.

El claim vive en la función **más externa** de cada camino: si sólo dedupeáramos
el parent, un reintento no re-acreditaría el budget pero SÍ volvería a decrementar
`total_spent` / `spent_usd` (el skew M1 al revés).

## 8. La migración (NO aplicada)

`supabase/migrations/20260727000000_hu194_refund_idempotency.sql` (+ `_down.sql`).

**Escrita y NO aplicada a ninguna base, ni a desarrollo.** El founder aprueba
antes. Detalle de qué hace y con qué comando se aplicaría: en el reporte de la HU
y en el header del propio archivo.

No destructiva: sin `DROP TABLE`, sin borrar filas. Los `DROP FUNCTION` son de
FIRMA (esquema) y son necesarios porque PostgREST no puede elegir entre dos
overloads; es el patrón que ya usó
`supabase/migrations/20260625000000_wkh_audit_a2_refund_rows_affected.sql:28,95`
para agregar el `RETURNS INT`. Los cuerpos se recrean idénticos salvo el bloque
de claim, y el `_down.sql` restaura las firmas anteriores verbatim.

El índice único del outbox es **PARCIAL** (`WHERE idem_key IS NOT NULL`): no puede
fallar por datos preexistentes (todos NULL) ni por duplicados históricos. Por eso
no se usa `CREATE UNIQUE INDEX CONCURRENTLY` (no corre dentro del bloque
transaccional de una migración y dejaría un índice INVALID si falla a mitad); la
variante concurrente queda documentada en el header por si la tabla crece.

## 9. Tests

| Test | Qué prueba |
|---|---|
| `T-194-C1` (central) | el credit commitea, la respuesta se pierde, el sweep reintenta → **UN** solo crédito |
| `T-194-C2` | el sweep reintentando TRES veces (con re-claim forzado) → un crédito |
| `T-194-C3` | dos refunds legítimos distintos de la misma operación → LOS DOS se aplican |
| `T-194-C4` | dos procesos concurrentes con la misma clave → un crédito |
| `T-194-C5` | misma clave, otro monto → `REFUND_IDEM_AMOUNT_MISMATCH`, sin acreditar |
| `T-194-C6` | el mismo refund lógico encolado dos veces → UNA fila |
| `T-194-D1/D2` | compose: d1 ≠ d2, y dos ejecuciones ≠ |
| `T-194-O1/O2` | orchestrate: clave del outbox = clave del credit; mismo `orchestrationId` ≠ claves |
| `T-194-G1`, `T-SR-12/13/14` | la clave que se ENCOLA es la MISMA que la del credit que falló |
| `T-194-OB-1..4` | el sweep pasa la clave; filas legacy (NULL) siguen procesándose; 23505 = no-op |
| `T-IDEM-01..07` | el contrato de la clave |
| `T-194-R1..R6` | la semántica SQL contra Postgres REAL (env-gated, skippeados sin `INTEGRATION_TEST_DB_URL`) |

Los unitarios de concurrencia corren contra un store en memoria que **modela**
`a2a_refund_applications` (claim dentro de la misma sección crítica que el
crédito) y el commit-then-lost-response. La semántica SQL de verdad la ejercita
`src/__tests__/e2e/refund-idempotency.real.test.ts`.

## 10. Observaciones fuera de scope (no tocadas)

1. **`gasless.ts` y `step0-refund.ts` encolan también bajo delegación/sesión**,
   pero el outbox sólo reintenta el ledger master (`credit`/`creditWithDest`) →
   `total_spent`/`spent_usd` no se decrementarían (el skew M1). `orchestrate.ts`
   sí lo gatea (`if (!request.delegationContext && !request.keySessionContext)`).
   Es preexistente y NO es doble-crédito; con HU-194 el reintento pasa a ser un
   no-op cuando el parent ya aplicó, así que la situación mejora. Merece HU propia.
2. **Filas que quedan en `processing` para siempre**: si `markDone` falla, la fila
   no vuelve a `pending` y el claim sólo toma `pending`. Preexistente. Con la
   clave, re-drivearla ya no puede duplicar.
3. **Flake preexistente**: `src/adapters/solana/intent-dedup.test.ts` →
   `T-CAP-4` compara el borde EXACTO de una ventana de ms con `<=` y falla ~1 de
   cada 5 corridas de la suite completa (nunca corriendo el archivo solo). No
   comparte módulo con esta HU.
