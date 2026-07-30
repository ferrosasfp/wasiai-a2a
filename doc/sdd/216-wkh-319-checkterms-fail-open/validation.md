# Validation Report — WKH-319 (corte mínimo W0+W1) — COMPACT

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-30
**HEAD**: `bbcd3d8` en `feat/216-wkh-319-checkterms-fail-open`

## Runtime checks (evidencia real, corridos en este F4)

- `./node_modules/.bin/tsc --noEmit -p tsconfig.json` → exit 0, sin output (verificado `node_modules` poblado, no falso-verde tipo WKH-196/319 auto-blindaje).
- `./node_modules/.bin/biome check src/` → `Checked 420 files in 133ms. No fixes applied.`
- `./node_modules/.bin/vitest run` → `Test Files 226 passed | 6 skipped (232)` · `Tests 4333 passed | 19 skipped (4352)`.
- `./node_modules/.bin/vitest run src/adapters/solana` → `Test Files 8 passed | 1 skipped (9)` · `Tests 194 passed | 1 skipped (195)`.
- `git status` → `nothing to commit, working tree clean`.
- Los cuatro números coinciden EXACTAMENTE con los que el Dev reportó en los commits `fc66aa5` y `bbcd3d8` — no re-uso de la cifra del Dev, corridos de cero en este F4.
- `devnet-e2e.manual.test.ts` no se corrió (confirmado por nombre `.manual.`, fuera del run de vitest por convención del repo).

## El repro central (T-319-1)

`src/adapters/solana/intent-dedup.test.ts:1176-1188` — tx donde `payTo` **gasta** 100 USDC (aparece solo en `postTokenBalances` con 4900 USDC, sin `pre`) contra `checkTerms` real (vía `termsOutcome`, que ejercita `adapter.settle → settleAlreadyConfirmed → probeSettlementPresence → checkTerms`, sin mockear la función bajo prueba). Verde: `indeterminate` / `terms_list_absent`. Confirmado en la corrida de arriba (194/1 Solana).

## Los tres textos del último fix-pack

| Texto exigido | Estado | Evidencia |
|---|---|---|
| `T-319-7c` recorre `['', 123, null, {}, [], true]`, `''` explicado aparte | ✅ presente | `intent-dedup.test.ts:1675-1692` (loop) + comentario líneas 1668-1673 explicando `''` como el único que `typeof === 'string'` acepta |
| §4.6 dice *"toda entrada anónima está contada"*, no *"reconocida"* | ✅ presente | `sdd.md:730-737` ("QUÉ GARANTIZA ESTE FIX, Y QUÉ NO — re-AR MNR-2") |
| Premisa del tier corregida, marcada sin borrar la original | ✅ presente | `sdd.md:690-704` — texto tachado (`~~...~~`) seguido de **"PREMISA CORREGIDA EN EL RE-AR (MNR-3)"** |

## ACs (30 · 10 `[SC]`) — corte mínimo W0+W1

3 ACs (AC-8, AC-16, AC-30) están explícitamente fuera de este corte por diseño (DT-11/`sdd.md`§6, marcados `(W2)` / dependientes del tier de dirección que W1 no trae). Verificado en código: no existe `expectedAta`/`addressAt`/`getAssociatedTokenAddressSync` fuera de la derivación pre-existente del operador, y `verify()` sigue sin `indeterminate:true` (comentario explícito en `payment.ts:1577-1579`). No son FAIL: son alcance no comprometido en este merge, declarado desde el work-item.

| AC | Status | Evidencia (archivo:línea + test) |
|----|--------|-----------------------------------|
| AC-1 | ✅ PASS | `payment.ts:1367-1372` (guard explícito, sin `?? []`) · T-319-1 (`intent-dedup.test.ts:1176`), T-319-1b (`:1190`) |
| AC-2 | ✅ PASS | mismo guard único sobre las dos listas · T-319-1b caso "las dos ausentes" (`:1204`, `:1213`) |
| AC-3 | ✅ PASS | `payment.ts:1476-1481` (`terms_pre_row_missing`) · T-319-2 (`:1217`), T-319-3 (`:1236`), T-319-4 (`:1269`) |
| AC-4 `[SC]` | ✅ PASS | `payment.ts:1489-1494` (regla espejo `post`, `terms_post_row_missing`) · T-319-10 (`:1305`) |
| AC-5 `[SC]` | ✅ PASS | `payment.ts:1476` (`preBalances[i]===0` acredita) · T-319-9 (`:1287`), T-319-10 (`:1305`) |
| AC-6 | ✅ PASS | `payment.ts:1423-1428` (owner ausente → `unclassifiablePre/Post`, nunca descartado en silencio) · `declaredOwner` `payment.ts:254-256` · T-319-7b (`:1611`), T-319-7c (`:1642`) |
| AC-7 `[SC]` **enmendado** | ✅ PASS | Enmienda declarada en `work-item.md:111-138` (autor `nexus-dev`, F3, a pedido AR) + `sdd.md §4.6`. Código: `payment.ts:1515-1538` (match exige `unclassifiablePre===0`; negativa exige los dos lados) · T-319-7b/7c/7d (`:1611,1642,1708`) |
| AC-8 `[SC]` (W2) | ⏸️ DEFERIDO | No implementado por diseño (DT-11, `sdd.md:679-712`). No existe tier de dirección en `payment.ts` (verificado: sin `expectedAta`/`addressAt`). Sin T-319-19/T-319-20 en el repo (verificado, no existen) |
| AC-9 | ✅ PASS | `payment.ts:230-233` (`ATOMIC_RE` + `atomicOf`) · T-319-6 (`:1384`) |
| AC-10 | ✅ PASS | `payment.ts:202-217` (`isBalanceEntry`) · T-319-5 (`:1348`), T-319-5b (`:1413`) |
| AC-11 | ✅ PASS | `payment.ts:1500-1510` (`terms_negative_delta`, antes del `< required`) · T-319-7 (`:1516`) |
| AC-12 | ✅ PASS | orden de guards en `payment.ts:1500` (delta<0) antes de `:1515` (`< required`) |
| AC-13 `[SC]` | ✅ PASS | `payment.ts:1393-1445` (agregación por `accountIndex`, sin `.find()`) · T-319-8 (`:1531`), T-319-8b (`:1551`) |
| AC-14 | ✅ PASS | T-319-5 (`:1348-1381`, asserts `out.detail).not.toMatch(/terms_threw/)`), T-319-6 — ninguna forma admitida por el esquema hace que `checkTerms` lance |
| AC-15 | ✅ PASS | `payment.ts:842-847` (`try` externo cinturón-y-tirantes) · T-319-11 (`:1499`), T-319-11b (`:1803`, MNR-C) |
| AC-16 `[SC]` | ⏸️ DEFERIDO | Depende del tier de dirección (AC-8), no implementado en este corte. Sin T-319-20 en el repo (verificado) |
| AC-17 `[SC]` | ✅ PASS | `payment.ts:1539-1542` (`mismatch` alcanzable) · T-319-12 (`:1593`) + T-IDM-18b (`:879-910`, **verde sin tocar su aserción** — confirmado por `git diff` de `intent-dedup.test.ts`: cero líneas `expect(` removidas en todo el archivo) |
| AC-18 `[SC]` | ✅ PASS | camino feliz sin cambio de conducta · suite Solana verde 194/1 (arriba), T-319-8 (`:1531`), T-319-9 (`:1287`) |
| AC-19 `[SC]` | ✅ PASS | `payment.ts:1452-1495` (lectura de `preBalances`/`postBalances` sólo dentro del branch de asimetría) · confirmado `grep -c "preBalances\|postBalances" payment.test.ts` = 0 (las 6 fixtures no las necesitan) |
| AC-20 `[SC]` | ✅ PASS | `git diff main...HEAD -- payment.test.ts` sólo agrega `accountIndex` a fixtures existentes; `grep -E "^[+-].*expect\("` sobre ese diff = 0 líneas — cero aserciones tocadas |
| AC-21 | ✅ PASS | `types.ts:257-269` (`SolanaTermsVerdict`, discriminante `verdict`, sin `ok`) · `tsc --noEmit` completo verde (arriba) |
| AC-22 | ✅ PASS | `payment.ts:848-861` (`switch` exhaustivo sobre `terms.verdict`, sin `default`) |
| AC-23 | ✅ PASS | `git diff main...HEAD -- src/adapters/types.ts`: el bloque `SettlementPresence` (línea ~170 original) sólo recibe un comentario `⛔` agregado ARRIBA de la unión; los 5 estados/variantes de la unión en sí no cambian de forma. `SolanaTermsVerdict` es bloque aditivo nuevo al final |
| AC-24 | ✅ PASS | `payment.ts:500,522-539` (`settleAlreadyConfirmed`, `SETTLE_PRESENCE_UNKNOWN` transitorio, no `SETTLE_CONFIRMED_BUT_UNVERIFIABLE`) · T-319-13 (`:1733`) |
| AC-25 | ✅ PASS | `payment.ts:593,624-638` (`settleAlreadySigned`, `SETTLE_IN_FLIGHT_UNRESOLVED`, 0 `sendRawTransaction`, fila no marcada `confirmed`) · T-319-14 (`:1753`) |
| AC-26 | ✅ PASS | `payment.ts:1190,1224-1248` (`recoverConfirmedSettle`, `FacilitatorSettleError(...,'unknown')` → `valueDisposition:'unknown'`/`SETTLE_UNKNOWN` vía WKH-308) · T-319-15 (`:1861`) |
| AC-27 | ✅ PASS | `payment.ts:962,1009-1020` (`settleViaFacilitator`, fila queda `signed` sin `recordConfirmedIntent` si no es `landed_ok`) · T-319-16 (`payment.flag.test.ts:392`) |
| AC-28 **actualizado F3** | ✅ PASS | inventario verificado por lectura directa de `payment.ts`: `terms_list_absent`(1370), `terms_entry_shape`(1380), `terms_amount_unreadable`(1434), `terms_pre_row_missing`(1479), `terms_post_row_missing`(1492), `terms_negative_delta`(1508), `terms_unclassifiable_entry`(1513), `terms_threw`(846), `terms_meta_absent`(1346), `terms_required_unreadable`(1355), `terms_duplicate_index`(1440), `probe_threw` (sin prefijo `terms_`, deliberado). 4 desviaciones declaradas en `work-item.md:187-201` |
| AC-29 | ✅ PASS | `payment.ts:653-675` (lista blanca `{absent, landed_failed}` + `SETTLE_PRESENCE_UNHANDLED`, "ADELANTADA AL CORTE" per `sdd.md:752`) · T-319-18 (`:1828`) |
| AC-30 (W2) | ⏸️ DEFERIDO | No implementado, confirmado por comentario explícito `payment.ts:1577-1579` ("W2 le agrega `indeterminate` a la rama no medida... el corte mínimo sólo lo adapta al discriminante nuevo"). Sin T-319-17 en el repo (verificado) |

**27/27 ACs en alcance (W0+W1): PASS. 3/3 ACs W2 (AC-8, AC-16, AC-30): correctamente NO implementados, declarados como deferidos desde el work-item mismo (DT-11) — no cuentan como FAIL.**

## Drift

- Archivos tocados (`git diff --name-only main...HEAD`): `payment.ts`, `types.ts`, `payment.test.ts`, `intent-dedup.test.ts`, `payment.flag.test.ts`, + 3 docs de la HU.
- `payment.flag.test.ts` NO está en el Scope IN del `work-item.md`, pero SÍ está declarado en `sdd.md:180` como fila `7b`, agregado en F3 (MNR-G), con su razón ("único archivo con el harness del facilitator... hogar natural de T-319-16"). Por la regla del propio work-item ("si esto contradice al SDD, gana el SDD"), **no es drift**.
- Orden de commits respeta W0 → W1 → fix-pack AR/CR (`4dc410e` → `27f256f` → `3a0cec8`/`fc66aa5`/`bbcd3d8`), sin adelantos de W2/W3 salvo AC-29 (adelantado y declarado explícitamente en el SDD como excepción, no como desvío).
- `_INDEX.md` del repo raíz no tocado (correcto, diferido a W3.2, CD-16 respetado).
- **Drift: none no declarado.**

## Gates

- Corridos directamente en este F4 (no reutilizados del Dev), con números idénticos a los que el commit `bbcd3d8` reporta — ver "Runtime checks" arriba.
- tsc / biome / vitest completo / vitest solana / git status: ✅ los cinco.

## AR/CR follow-up

- BLQ-1 (AR): fix `3a0cec8`, re-verificado (mutante M25, `T-319-7c`) — vivo en `bbcd3d8`.
- BLQ-2 (AR): fix `3a0cec8` (`FacilitatorSettleError(...,'unknown')` en `settleAlreadySigned`).
- MNR-A..G (CR): fix `fc66aa5`, evidencia por sub-ítem en el mensaje del commit (leído, no re-ejecutado — ya cubierto por AR/CR según instrucción de esta corrida).
- MNR-1/2/3 (re-AR): `bbcd3d8` — mutante M25 muerto, §4.6 corregido, premisa del tier corregida sin borrar el original.
- No quedan hallazgos abiertos sin resolver en el alcance de esta corrida (W0+W1).

**Listo para DONE.**
