# HU-198 — Techo de espera de los hops `pieverse` + estado `unknown` del settle

> ⚠️ **ESTE WORK-ITEM ES RETROACTIVO.** Se escribió DESPUÉS de la implementación y del
> primer AR, porque la HU arrancó sin F1/F2 (no hubo `work-item.md` ni SDD). El AR#1
> tuvo que verificar *las afirmaciones del dev contra el código* en vez de *el código
> contra ACs aprobados* — lo dejó dicho y es una violación de proceso reconocida.
> Los ACs de abajo describen lo que se construyó, con la evidencia archivo:línea, para
> que el AR siguiente tenga contra qué medir. **No son ACs pre-aprobados.**

## Contexto

Los dos hops HTTP al facilitator del modo `pieverse` de `kite-ozone`
(`POST /verify` y `POST /settle`) eran los únicos caminos de settlement del repo sin
cota de wall-clock, y son el **camino vivo**: `pieverse` es el default de
`KITE_FACILITATOR_MODE` (`src/adapters/kite-ozone/payment.ts`, `getFacilitatorMode`).
HU-195 los había excluido explícitamente (`src/lib/outbound-timeout.ts`) dejando
escrita la pregunta que esta HU tenía que contestar: *¿qué hace el gateway con un
settle de resultado desconocido?*

**El hecho mecánico que gobierna todo el diseño**: abortar el request HTTP al
facilitator **no cancela el broadcast**. El gateway no pasa de "pagó" a "no pagó";
pasa de "sé el resultado" a **"no sé el resultado"**.

### Corrección al encuadre inicial (verificada)

El pedido original decía que los hops esperaban "indefinidamente". No es exacto: el
peer **mudo** ya estaba acotado a 300 s por los defaults de undici
(`bodyTimeout`/`headersTimeout` = `300e3`, `node_modules/undici/lib/dispatcher/client.js`,
citado en `src/lib/outbound-timeout.ts`). Lo verdaderamente ilimitado es el peer que
**trickle-feedea**. Consecuencia: el techo **no crea** estados huérfanos nuevos (hoy el
hang termina en el mismo `throw` y en el mismo estado, 10× más tarde) — sólo los hace
llegar antes.

## Scope

**IN**
- Cota de wall-clock para los dos hops `pieverse`, configurable por env.
- Representación **tipada** del estado `unknown` del valor + su consumo en los
  call-sites que hoy colapsan el veredicto.
- Que un hop 2 de resultado desconocido no lo re-envíe el reconciliador a ciegas.
- Guard estructural para leer disposiciones de valor a través de límites de módulo.

**OUT** (levantado como HUs propias)
- `success:false` no prueba nada (BLQ-ALTO-1 del AR): toca 5 adapters. Entrada (G) de
  `TD-198-01`.
- Caso (F): `hop1_confirmed` se escribe antes del hop 2, así que la fila es
  auto-reclamable durante todo el hop 2 **con el proceso vivo**. Entrada (F) de
  `TD-198-01`.
- Nonce determinístico del hop 2 / lease pre-hop2: ver la recomendación en
  `TD-198-01` (`src/services/reconciliation.ts`, bloque del `if (!skipResend)`).

## Acceptance Criteria (EARS, retroactivos)

### Techo

- **AC-1** — *When* el hop `POST /verify` de `pieverse` no responde, *the gateway shall*
  abortar la espera al cumplirse el techo y propagar un `Error` común (verify no
  broadcastea, así que abortarlo no puede dejar valor en el aire).
  Evidencia: `src/adapters/kite-ozone/payment.ts` (`signal` en el fetch de `/verify`);
  tests `T-198-VERIFY`, `T-198-VERIFY-plain`.
- **AC-2** — *When* el hop `POST /settle` de `pieverse` no responde, *the gateway shall*
  abortar la espera y propagar `FacilitatorSettleError` con
  `valueDisposition: 'unknown'` — **nunca** `{ success: false }` ni un `Error` pelado
  indistinguible de un rechazo del facilitator.
  Evidencia: `src/adapters/kite-ozone/payment.ts` (catch del `/settle`); test
  `T-198-SETTLE-UNKNOWN`.
- **AC-3** — *Where* el error prueba que el request nunca salió (`ECONNREFUSED`,
  `ENOTFOUND`, `EAI_AGAIN`, `ERR_INVALID_URL`), *the gateway shall* clasificar
  `'not-sent'`; en **cualquier otro** caso, incluida la ignorancia, `'unknown'`.
  Evidencia: `classifySettleTransportError` en `src/adapters/errors.ts`; tests
  `T-CLS-*`, `T-198-SETTLE-NOT-SENT`.
- **AC-4** — *The gateway shall* leer el techo de `KITE_FACILITATOR_TIMEOUT_MS` (ms,
  default 30 000 = la norma del repo), y un valor ausente / no numérico / ≤ 0 **no**
  debe apagar el techo.
  Evidencia: `resolvePieverseFacilitatorTimeoutMs`; tests `T-198-ENV`,
  `T-198-ENV-honra-el-valor`; `.env.example`.
- **AC-5** — *The change shall* no modificar el modo `x402` de kite ni
  `base`/`avalanche`/`tempo` (los 4 ya acotados a 30 s).
  Evidencia: `git diff` sobre esos paths = vacío; en `kite-ozone/payment.ts` las únicas
  16 líneas no-comentario son adiciones + 1 cambio de clase de error.

### Estado `unknown` distinguible

- **AC-6** — *When* un settle downstream falla con `valueDisposition: 'unknown'`, *the
  gateway shall* reportar `SETTLE_UNKNOWN` (código propio, ≠ `SETTLE_FAILED`) y **no**
  devolver recibo de pago.
  Evidencia: `src/lib/downstream-payment.ts` (catch del settle),
  `src/lib/downstream-skip-code.ts`; tests `T-198-SettleUnknown`, `T-198-SettleNotSent`.
- **AC-7** — *When* el settle **inbound** queda `unknown`, *the gateway shall* (a)
  denegar el acceso (402, sin confirmación no se sirve), (b) responder un mensaje que
  **no** afirme que el pago falló y que avise de no reintentar con el mismo header (el
  nonce ya está quemado), y (c) dejar una fila durable (`a2a_events`) con el nonce para
  poder reconciliarlo.
  Evidencia: `src/middleware/x402.ts` (catch del settle); tests
  `T-198-AR-INBOUND-MSG`, `T-198-AR-INBOUND-EVENT` y sus contra-ejemplos.
- **AC-8** — *The gateway shall* leer la disposición del valor por **forma** y no sólo
  por `instanceof`, porque la identidad de clase es por-registro-de-módulos y un
  `instanceof` roto cae del lado peligroso.
  Evidencia: `readSettleValueDisposition` / `readGaslessValueDisposition` en
  `src/adapters/errors.ts`; tests `T-READ-cross-registry`, `T-GAS-cross-registry`,
  `T-198-Gasless-CrossRegistry`.
- **AC-9** — *Where* el consumidor del gasless no puede clasificar el error, *the
  gateway shall* conservar el fail-safe de HU-192 (`'unknown'` ⟹ no reembolsar).
  Evidencia: `classifyGaslessFailure`; el test preexistente `T-192-6` se pone rojo si se
  invierte.

### Reconciliación del hop 2 desconocido

- **AC-10** — *When* el hop 2 del settle escrow falla de forma **ambigua** (o sin
  veredicto explícito de "inequívoco"), *the gateway shall* persistir `resolving_settle`,
  que `claim_reconciliation` **no** reclama sin tx previa ni por settle ni por refund.
  Evidencia: `settleEscrowAware` en `src/services/payment-intent.ts` (el
  `!== 'unequivocal'`); tests `T-198-Escrow-Ambiguous`, `T-198-Escrow-Unequivocal`.
- **AC-11** — *When* el hop 2 falla de forma **inequívoca**, *the gateway shall*
  conservar `reconciliation_pending` (el re-envío es correcto y es la razón de existir
  del lado settle del reconciliador).
  Evidencia: `T-198-Escrow-Unequivocal` + el preexistente `T-4`.
- **AC-12** — *The gateway shall* mantener `resolving_settle` visible y resoluble:
  presente en `PENDING_STATUSES`, y `listPending()` / `resolveIntent()` deben filtrar
  por el **mismo** set.
  Evidencia: `src/services/reconciliation.ts`; tests `T-198-Pending-List`,
  `T-198-Pending-Resolve`, `T-198-Pending-Shared`.
  ⚠️ Esta invariante sostiene el diseño entero (sin ella el estado es un limbo
  invisible, peor que el bug) y en el AR#1 su mutación **sobrevivió**: no tenía candado.
- **AC-13** — *When* el claim rechaza una fila `resolving_settle` sin tx, *the API shall*
  responder `awaiting_manual_settle_evidence` (no `already_resolved`, que afirmaría que
  una fila con plata posiblemente duplicada está resuelta) + la acción requerida.
  Evidencia: `resolveIntent` y `POST /dashboard/api/reconciliation/:id/resolve`; tests
  del par (con y sin tx previa).
- **AC-14** — *When* el hop 1 de una fila `resolving_settle` re-verifica
  `not_confirmed`, *the gateway shall* poder reembolsar el budget del buyer (el débito
  off-chain tiene que revertirse: los fondos nunca salieron del escrow). El lado settle
  sigue sin poder reclamar.
  Evidencia: migración `20260728010000` (rama `p_side='refund'` en
  `claim_reconciliation`); tests `T9`/`T10` del SQL-estructural.
- **AC-15** — *When* la escritura del ciclo de vida no se aplica (guard de transición
  que rechaza, 0 filas), *the gateway shall* detectarlo y gritarlo — no puede quedar
  indistinguible de un write exitoso.
  Evidencia: `record_debit_settle_status` → `RETURNS TABLE(applied boolean)` +
  `recordDebitSettleStatus`; tests `T-198-AR: applied=false/true/RPC viejo`.
- **AC-16** — *The drift report shall* contar `resolving_settle` (débito vigente y no
  reembolsado) y declarar **todas** sus exclusiones, sin afirmaciones falsas de
  completitud.
  Evidencia: `DRIFT_ACCOUNTED_STATUSES`; test `T-198-Drift`.

### Migraciones

- **AC-17** — *Each migration shall* traer su `_down`, su gate de **orden de release**
  con la consecuencia del orden inverso, y pasar `migrate-preflight.mjs`.
  Evidencia: headers de `20260728000000` y `20260728010000`; tests `T5`, `T6`, `T13`,
  `T14` del SQL-estructural.
- **AC-18** — *The migrations shall* aplicarse **sólo a bdwv** (desarrollo), con el ref
  hardcodeado (no derivado de `SUPABASE_URL`) y verificación de post-estado **leyendo de
  la base**. A **caldz** (producción, dinero real) no se toca.
  Evidencia: `scripts/apply-hu198-migration.mjs` (4 chequeos: sondeo de comportamiento +
  `pg_get_function_result` + `pg_get_functiondef`).

## Constraint Directives

- **CD-1** — No inventar un valor de techo nuevo: la norma del repo (30 s, en los 4
  caminos ya acotados) es el default, y el mismo para los dos hops (los 4 usan una sola
  constante para ambos).
- **CD-2** — El default de toda clasificación de valor cae al lado **money-safe**:
  `unknown` sobre `not-sent`, `resolving_settle` sobre `reconciliation_pending`,
  `no reembolsar` sobre `reembolsar`. Sólo un veredicto **explícito** habilita la acción
  irreversible.
- **CD-3** — Prohibido colapsar "no sé si se pagó" en el mismo camino que "no se pagó".
- **CD-4** — Cero cambios colaterales en los otros 4 caminos de settlement.
- **CD-5** — Toda migración: sólo bdwv, con `_down`, preflight y post-estado leído de la
  base. Nunca derivar el ref de `SUPABASE_URL`; verificar el claim `ref` del JWT y no el
  nombre de la variable (en `.env.local` **`SUPABASE_SERVICE_KEY` es caldz**).
- **CD-6** — Ningún estado nuevo si el existente ya tiene la semántica buscada
  (`resolving_settle` ya estaba en el CHECK y en el índice desde 191c).

## Deuda registrada

`TD-198-01` — anotada **en el código**, en el `if (!skipResend)` de
`src/services/reconciliation.ts`: entradas (B), (C), (F) y (G) del re-envío sin
evidencia, las dos candidatas de fondo con sus agujeros, y la recomendación actual
(lease pre-hop2, porque el nonce determinístico depende del BLQ-ALTO y no cubre
`pieverse`).
