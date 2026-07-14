# Work Item — [WKH-196] Pérdida de precisión uint256 al leer columnas NUMERIC(78,0) vía supabase-js

## Resumen
El escrow-settle non-custodial (epic WKH-191) y el árbitro (WKH-194) persisten
`nonce`/`amount` uint256 en columnas Postgres `NUMERIC(78,0)`, pero PostgREST/
supabase-js los serializa como **número JSON sin comillas**, y `JSON.parse`
redondea cualquier valor > 2^53 al múltiplo del ULP de float64 más cercano. En
producción esto corrompe el `debit_nonce` leído de vuelta, la firma EIP-712 no
matchea (`escrow.debit` revierte `0x8baa579f`) y el sistema cae siempre al
fallback operator-custodial — **el epic WKH-191 está 100% neutralizado en prod**
pese a estar "code-complete". Fix: castear `::text` en los 3 `.select()` que
leen columnas `NUMERIC(78,0)` (PostgREST devuelve string exacto con el cast),
para que el runtime cumpla el contrato que las interfaces TypeScript ya
declaran (`string`, nunca `number`).

## Sizing
- SDD_MODE: mini (root-cause ya diagnosticado empíricamente, fix mecánico
  acotado a 3 selects + 1 comentario; sin cambio de contrato ni de schema).
  Metodología del proyecto: **QUALITY** (money-path + on-chain settlement,
  por instrucción explícita del orquestador — CLAUDE.md exige QUALITY siempre
  en este repo, sin excepción por FAST).
- Estimación: S (diff chico, pero money-path crítico → requiere test de
  round-trip exacto + AR/CR/QA con evidencia archivo:línea, no solo el diff).
- Branch sugerido: `fix/181-wkh-196-uint256-numeric-precision-read`

## Acceptance Criteria (EARS)

- AC-1: WHEN `readValidDebitSignature` (`src/adapters/escrow/debit-capture.ts`)
  lee una fila cuyo `debit_nonce` persistido es un uint256 no-redondo > 2^53
  (p.ej. `4312989337224638380`), the system SHALL devolver `row.debit_nonce`
  como el string decimal EXACTO persistido (bit-a-bit idéntico), sin
  redondeo, tal que `BigInt(row.debit_nonce)` en `payment-intent.ts:541`
  reconstruye el mismo `bigint` con el que se firmó la `DebitAuthorization`.
- AC-2: WHEN `readValidDebitSignature` lee `debit_amount_atomic` no-redondo >
  2^53, the system SHALL devolver el string decimal exacto, sin redondeo (el
  mismo invariante que AC-1, aplicado al segundo campo NUMERIC(78,0) de la
  misma tabla).
- AC-3: WHEN `getOrCreateArbiterNonce` (`src/services/arbiter.ts`) hace el
  read-first (cache hit, `existing.nonce`) sobre un `nonce` no-redondo > 2^53,
  the system SHALL devolver el valor EXACTO persistido — no solo en el path
  de cache-miss (RPC `get_or_create_arbiter_nonce`, que ya castea el output
  a `NUMERIC`/string vía RPC), sino también en el `SELECT` directo de la
  tabla `a2a_arbiter_nonces`.
- AC-4: WHEN `reconciliationService` (`src/services/reconciliation.ts`) lee
  `debit_nonce`/`debit_amount_atomic` en `resolveIntent`, `listPending` o
  `driftCheck` para un valor no-redondo > 2^53, the system SHALL devolver el
  valor exacto persistido, tal que el re-verify on-chain (`reverifyDebitedByTxHash`)
  y el hop 2 (`settlePaymentIntentOnChain`) operan sobre el nonce/monto real
  firmado, no uno redondeado.
- AC-5: WHILE el valor NUMERIC(78,0) es < 2^53 (Number.MAX_SAFE_INTEGER), the
  system SHALL producir exactamente el mismo comportamiento observable (mismo
  string, mismo `BigInt`) que antes del fix — CERO cambio de comportamiento
  para el caso ya-seguro (byte-idéntico, CD-1).
- AC-6: IF un `.select()` en cualquiera de los 3 archivos de Scope IN lee una
  columna `NUMERIC(78,0)` (`debit_amount_atomic`, `debit_nonce`, `nonce`)
  SIN el sufijo `::text` en la expresión seleccionada, THEN the system SHALL
  fallar en Code Review — es el defecto exacto que esta HU corrige; su
  recurrencia en el mismo choke-point es un regression bloqueante.
- AC-7: WHEN se ejecuta el E2E on-chain del escrow-settle two-hop post-fix
  con una firma `DebitAuthorization` válida cuyo nonce es no-redondo > 2^53,
  the system SHALL confirmar el hop 1 (`escrow.debit` no revierte —
  `0x8baa579f` desaparece) y mover fondos del escrow al operador (evidencia:
  tx hash confirmado, verificable en el explorer de la chain default).

## Scope IN
- `src/adapters/escrow/debit-capture.ts` — `readValidDebitSignature` (línea
  ~112-122): agregar `::text` a `debit_amount_atomic` y `debit_nonce` en el
  string del `.select(...)`. Corregir el comentario de `ValidDebitRow`
  (línea 76-78) que afirma "NUMERIC → string" sin castear (falso en runtime
  sin el fix).
- `src/services/arbiter.ts` — `getOrCreateArbiterNonce` (línea ~106-121):
  `.select('nonce')` → `.select('nonce::text')`.
- `src/services/reconciliation.ts` — los 3 `.select()` que traen
  `debit_nonce`/`debit_amount_atomic`: `listPending` (línea ~182-189),
  `resolveIntent` (línea ~220-227), `driftCheck` (línea ~404-411). Cast
  `::text` en las 2 columnas NUMERIC(78,0) en cada uno.
- Tests nuevos/actualizados que prueben round-trip exacto de un nonce > 2^53
  no-redondo (p.ej. `4312989337224638380`) a través de cada uno de los 3
  puntos de lectura (mock del row string devuelto por supabase-js).

## Scope OUT
- El path de CAPTURA (`debit-capture.ts:187-189`, `capture.nonce`/`capture.amount`
  del body del request) — viene del BODY del cliente (ya string, validado por
  firma), no es una lectura de DB. No es el bug; se deja intacto.
- El contrato Solidity `WasiAIEscrow` — el bug es 100% off-chain, en la capa
  de lectura de la app.
- Los flags `ESCROW_SETTLE_ENABLED` / `ESCROW_DEBIT_CAPTURE_ENABLED` y sus
  defaults — sin cambios.
- `deriveArbiterNonce` / `arbiter-executor.ts` — la derivación pura del nonce
  es correcta; el bug es específicamente el read-first de la tabla.
- `debit_deadline` (columna `BIGINT`, epoch seconds, siempre < 2^53) — NO se
  castea salvo que el Architect (F2) justifique por consistencia explícita;
  no es NUMERIC(78,0) y no es uint256.
- Migraciones de schema — el fix es aditivo en la capa de lectura (PostgREST
  cast), NO se cambia el tipo de columna `NUMERIC(78,0)` en la DB.
- `a2a_arbitrations.at_stake_usd` / `a2a_payment_intents.authorized_usd` y
  demás columnas `NUMERIC` que representan USD (no uint256 atómico) — fuera
  de este inventario, ya operan en rango seguro (montos USD, no wei/atomic).

## Decisiones técnicas (DT-N)
- DT-1: el fix vive EXCLUSIVAMENTE en la expresión del `.select()`
  (`columna::text`), reusando la sintaxis PostgREST ya verificada
  empíricamente contra bdwv. No se introduce una capa de parsing custom ni
  un wrapper genérico — 3 sitios puntuales, 3 fixes puntuales.
- DT-2: el comentario engañoso en `debit-capture.ts:76-78` ("NUMERIC uint256
  → `string`") se corrige para reflejar que el `string` en runtime depende
  del cast `::text` en el select, no es automático por el tipo de columna.
  Evita que un futuro select nuevo repita el bug sin el cast.
- DT-3: el fix NO toca el tipo de retorno de las interfaces TS
  (`ValidDebitRow`, `SigWithIntentRow`, `PendingSelectRow`, `DriftSigRow`) —
  ya declaran `string` para estas columnas; el runtime pasa a cumplir el
  contrato ya tipado, cero breaking change de tipos.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO cualquier cambio de comportamiento para valores NUMERIC(78,0)
  < 2^53 — el fix debe ser byte-idéntico en ese rango (mismo string producido
  por PostgREST con o sin `::text` cuando el valor es representable exacto
  en float64... la diferencia SOLO aparece > 2^53). OBLIGATORIO verificar con
  test que el caso ya-seguro (p.ej. el monto redondo `3000000000000000000`
  del incidente real) no cambia de valor.
- CD-2: OBLIGATORIO un test que pruebe un uint256 no-redondo > 2^53
  (recomendado el valor real del incidente, `4312989337224638380`) sobrevive
  el round-trip DB→app→`BigInt` EXACTO en los 3 puntos de lectura del Scope IN.
- CD-3: PROHIBIDO modificar el schema/tipo de columna (`NUMERIC(78,0)`
  permanece igual) — el fix es 100% capa de lectura, aditivo, sin migración.
- CD-4: PROHIBIDO tocar el path de captura (body del request) — ya opera
  sobre strings del cliente, fuera de la causa raíz.
- CD-5: OBLIGATORIO validar (por lectura de código, no ejecución) que el
  `.select()` de `readValidDebitSignature` sigue siendo el ÚNICO string
  literal repetido de campos (no se introduce un segundo lugar con el mismo
  nombre de columnas sin cast) — evitar drift entre selects hermanos.

## Missing Inputs
- [NEEDS CLARIFICATION] `debit_deadline` es `BIGINT` (no `NUMERIC(78,0)`) y
  hoy representa epoch seconds, siempre << 2^53 — el Analyst lo deja fuera
  del cast por default (Scope OUT), pero si el Architect en F2 detecta algún
  otro campo `BIGINT`/`NUMERIC` no inventariado que también pueda exceder
  2^53 en la ruta money-path, debe señalarlo antes de F3 (no bloqueante para
  arrancar F2 — el inventario de 3 columnas está confirmado contra las 3
  migraciones fuente).
- [resuelto en F2] Estrategia exacta de test (mock de supabase-js response
  vs. test de integración contra bdwv real con un valor sintético > 2^53) —
  el Architect decide en el SDD según lo que YA usan los tests existentes de
  estos 3 archivos (patrón a seguir, no inventar uno nuevo).

## Análisis de paralelismo
- Esta HU es un **blocker de facto** para que el epic WKH-191 (Wave 0 y Wave 1,
  filas 172-178 del `_INDEX.md`) funcione en producción una vez deployado —
  hoy el código está "DONE (código) · PENDING-DEPLOY/ACTIVATION-PENDING" pero
  aunque se deployara y activara el flag, `escrow.debit` revertiría siempre
  por este bug. Debe resolverse ANTES de (o en el mismo deploy que) activar
  `ESCROW_SETTLE_ENABLED`/`ARBITER_ENABLED` en producción.
- NO bloquea ningún trabajo activo `in progress` del `_INDEX.md` (filas
  159/160/161/162/163, todas sobre `orchestrate.ts`/`discovery.ts`, módulo
  disjunto). Puede ir en paralelo con esas HUs sin conflicto de archivos.
- No depende de ninguna HU en curso; es standalone y de scope acotado (3
  archivos, sin tocar schema).
