# HU-194 — El refund-outbox podía acreditar dos veces

Branch: `fix/refund-outbox-idempotency` · base `main@050840d`

## 0. ⚠️ ORDEN DE RELEASE (GATE)

**La migración `20260727000000_hu194_refund_idempotency.sql` se aplica ANTES de
deployar el código.** El orden inverso (código primero) **rompe los 8 call-sites
de refund**: PostgREST responde `PGRST202` al credit (no existe ninguna función de
refund con `p_idem_key`) y `PGRST204` al enqueue del outbox (no existe la columna
`idem_key`) ⟹ el refund **no se aplica NI queda encolado** y el caller queda
cobrado sin rastro recuperable.

El orden correcto no tiene ventana: `p_idem_key TEXT DEFAULT NULL` + `idem_key`
nullable dejan al código **viejo** funcionando idéntico mientras se deploya el
nuevo. No hay shim en código a propósito: un shim que "detecte PGRST202 y
reintente sin la clave" reabriría exactamente el agujero de doble crédito que esta
HU cierra.

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

- `orchestrationId` **es caller-controlled**: `POST /orchestrate/execute` lo recibe
  en el **body** (`src/routes/orchestrate.ts:33,299-301`,
  `OrchestrateExecuteBody`) y no hay ninguna validación de unicidad.
- `request.id` **hoy NO es caller-controlled** (corrección del AR MNR-2): Fastify
  ignora el header entrante porque `requestIdHeader` tiene default `false`
  (`node_modules/fastify/lib/config-validator.js:60-61`) y `src/index.ts:59-70`
  pasa `genReqId` sin setearlo, así que `request.id` es siempre un
  `crypto.randomUUID()` server-side (`src/middleware/request-id.ts:10`). Igual no
  se usa como base de la clave: alcanza con setear `requestIdHeader: true` (una
  línea, en otro archivo, por otro motivo) para volverlo caller-controlled y
  convertir un cambio de logging en pérdida silenciosa de dinero. Un UUID propio
  no depende de la config del framework.

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

## 6. Mismatch de clave ya aplicada: fail-closed y visible

Si llega la misma clave con OTRO monto es reuso indebido de clave (un bug), no un
reintento. La RPC levanta `REFUND_IDEM_AMOUNT_MISMATCH` y **no aplica nada**; los
services lo mapean a un code estable (sin msg crudo de PG). El entry del outbox
muere en `dead` con `last_error` para revisión manual, en vez de acreditar un
monto ambiguo. La comparación tiene tolerancia de 1e-9 USD para absorber el ida y
vuelta float↔NUMERIC (un falso mismatch BLOQUEARÍA un crédito legítimo).

**AR MNR-4**: el camino "ya aplicada" también verifica la **identidad**, no sólo el
monto — la fila ganadora tiene que ser del mismo `key_id`, `chain_id` y
`owner_ref`. Si no, levanta `REFUND_IDEM_IDENTITY_MISMATCH` (code hermano, estable,
mapeado en las 4 variantes de `credit*`: `src/services/budget.ts`). Hoy es
**inalcanzable** porque la clave embebe `keyId` y `chainId`; existe para que un
futuro cambio en la composición de la clave (`src/lib/refund-idem.ts`) falle
RUIDOSO en vez de dedupear entre tenants en silencio. Tests `T-194-B4..B7`.

**AR MNR-5 — retención de `a2a_refund_applications`**: la tabla crece sin techo y
**no hay pruning, a propósito**. Purgar una fila **re-abre la ventana de doble
crédito** para cualquier entry del outbox que todavía referencie esa clave (el
claim volvería a insertar y a acreditar). El volumen es bajo (sólo caminos de
excepción del money-path). Criterio escrito en el header de la migración por si
algún día hace falta: purgar SÓLO filas sin entry vivo (`pending`/`processing`) en
`a2a_refund_outbox`, y nunca por debajo de `MAX_REFUND_ATTEMPTS` × intervalo del
sweep. Es documentación, no un job.

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

Verdicto del preflight del repo (`node scripts/migrate-preflight.mjs <file>`, sin
`SHADOW_DATABASE_URL` → sólo análisis estático, cero conexión a ninguna base):

- UP: `[PASS] Pre-flight OK — safe to apply` (10 findings MEDIUM, todos
  GRANT/REVOKE del hardening que ya usan los RPC hermanos).
- DOWN: `[BLOCKED]` por los 3 HIGH esperables de un rollback (`DROP INDEX`,
  `DROP COLUMN`, `DROP TABLE`). Es el archivo de reversión; su header explica que
  antes conviene volcar `a2a_refund_applications` a CSV.

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
| `T-194-B1..B3` | el mapeo del `REFUND_IDEM_AMOUNT_MISMATCH` a code estable en las 3 variantes dest/dual-ledger |
| `T-194-B4..B7` | AR MNR-4: el mapeo del `REFUND_IDEM_IDENTITY_MISMATCH` en las 4 variantes de `credit*` |
| `T-194-CR-1/2` | AR MNR-1: el `catch` del credit-back del step-0 de `/compose` — el enqueue lleva la MISMA clave que el credit que TIRÓ, y un enqueue que también tira no rompe el 400 |
| `T-194-R1..R6` | la semántica SQL contra Postgres REAL de `refund_a2a_key_spend` (env-gated, skippeados sin `INTEGRATION_TEST_DB_URL`) |
| `T-194-R7/R8` | AR MNR-3: `refund_with_dest_policy` (el dest-cap se revierte UNA vez) y `refund_delegation_and_parent` (`total_spent` decrementado UNA vez). Env-gated igual que R1..R6 — evidencia **ejecutable**, no ejecutada: la migración todavía no está aplicada a ninguna base |

Los unitarios de concurrencia corren contra un store en memoria que **modela**
`a2a_refund_applications` (claim dentro de la misma sección crítica que el
crédito) y el commit-then-lost-response. La semántica SQL de verdad la ejercita
`src/__tests__/e2e/refund-idempotency.real.test.ts`.

### 9.1. Cobertura — qué se midió (AR MNR-1)

Medido con `npx vitest run --coverage.include='src/routes/compose.ts'`:

- **Antes del fix-pack**: el bloque `catch` de `refundComposeStep0`
  (`src/routes/compose.ts:424-451`, el par `refund-threw` del step-0 de `/compose`)
  tenía **0 hits** en toda la suite — incluido el `idemKey: idem.idemKey` de la
  línea 441. Gap preexistente (el bloque venía de HIGH-2), pero la afirmación de
  cobertura de la HU no lo declaraba.
- **Después**: `426 → 2`, el `enqueueRefund` del catch (statement de la línea 431,
  que contiene el `idemKey` de la 441) `0 → 2`, y el `.catch` del enqueue
  (línea 444) `0 → 1`. Tests `T-194-CR-1/2`.
- `T-194-CR-1` verificado por mutación: cambiando `idemKey: idem.idemKey` por otra
  clave en `compose.ts:441`, el test se pone **rojo** (`expected ':threw' to be
  'v1:k1:2368:…:compose-step0'`). La mutación se revirtió.
- Lo que **sigue** sin ejecutarse: `T-194-R1..R8` (env-gated, requieren la
  migración aplicada) y `refund_session_and_parent`, cubierta por analogía
  estructural con `refund_delegation_and_parent` (mismo bloque, otra tabla), no por
  ejecución.

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
