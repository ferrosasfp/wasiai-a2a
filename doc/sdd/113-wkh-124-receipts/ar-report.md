# Adversarial Review (AR) — WKH-124 KEY-RECEIPTS

> Branch: `feat/113-wkh-124-receipts` · Base: `origin/main` (WKH-121/122/123 merged)
> Reviewer: nexus-adversary · Fecha: 2026-06-19
> Story File: `doc/sdd/113-wkh-124-receipts/story-file.md`
> Auto-blindaje: corrección `request.a2aKeyRow` → `request.scopingKeyRow` (validada abajo).

## Veredicto: **APROBADO con MENORs**

`npx tsc --noEmit` → 0 errores. `npm test` → **1511 passed | 3 skipped** (esperado).
Biome lint sobre los 6 archivos tocados → limpio. **0 BLOQUEANTEs.** 2 MENORs (test gap + nota de diseño de cadena, ya prevista en el SDD).

Superficie real WKH-124 vs `origin/main` (sin scope drift):
- **Nuevos:** `src/types/receipt.ts`, `src/services/receipt.ts` (+test), `src/routes/receipts.ts` (+test), `supabase/migrations/20260605000000_a2a_receipts.sql` (+`_down.sql`).
- **Modificados:** `src/index.ts`, `src/middleware/a2a-key.ts`, `src/services/budget.ts` (+test), `src/services/orchestrate.ts` (+test), `.env.example`.
- `fee-charge.ts` / `compose.ts` / schema `a2a_events`·`a2a_protocol_fees` **intactos** (CD-6 OK).

---

## Resultado por categoría

| # | Categoría | Resultado |
|---|-----------|-----------|
| 1 | Security | **OK** |
| 2 | Error Handling | **OK** |
| 3 | Data Integrity | **OK** (MNR-2: nota de cadena, prevista en SDD) |
| 4 | Performance | **OK** |
| 5 | Integration / No-regresión | **OK** |
| 6 | Type Safety | **OK** |
| 7 | Test Coverage | **MENOR** (MNR-1) |
| 8 | Scope Drift | **OK** |
| 9 | Destructive Migrations | **N/A** (tabla + RPC nuevos, aditivo, reversible) |
| 10 | RPC SECURITY DEFINER | **OK** |
| 11 | Cache Invalidation | **N/A** (no se introduce capa de cache) |

---

## 1. Security — OK

- **CD-1 best-effort, los 4 call-sites verificados:** emisión siempre como `receiptService.emit({...}).catch(warn)` SIN `await` bloqueante. `emit` es `async` → nunca throw síncrono; siempre devuelve promesa, el `.catch` absorbe cualquier rechazo. Ni RPC-error, ni HMAC-null, ni UPDATE-error, ni secret-missing, ni `scopingKeyRow` null pueden propagarse al `return` del pago/débito.
  - key-session: `src/services/budget.ts:91-109` (dentro del `try`, pero fire-and-forget → no entra al `catch`).
  - delegation: `src/services/budget.ts:163-181`.
  - master: `src/middleware/a2a-key.ts:819-839`.
  - protocol_fee: `src/services/orchestrate.ts:460-478`, con guard `feeResult.status==='charged' && request.scopingKeyRow?.owner_ref`.
- **CD-3 / IDOR (AC-7/AC-8):** `list`/`getById`/`verify` con `.eq('owner_ref', ownerRef)` y `ownerRef: string` estricto (`receipt.ts:256, 274`; firmas `:250, 267, 195`). El `ownerRef` viene de `callerKey.owner_ref` (key autenticada), no de un param: `routes/receipts.ts:60, 81, 109`. Cross-owner → `getById` 0 rows (`PGRST116`) → null → 404 disclosure-safe (`routes/receipts.ts:83, 111`). `verify` re-chequea ownership vía `getById` interno (`receipt.ts:196`). Defensa en profundidad correcta.
- **CD-4 secret:** `RECEIPT_SIGNING_SECRET` leído solo a `const` local (`receipt.ts:78`), pasado a `createHmac` (`:80`); jamás logueado (en logs aparece solo el NOMBRE de la var, nunca el valor), jamás enviado al RPC (`emit` pasa 10 params, ninguno es el secret — `:122-136`), jamás en respuestas (`verify` devuelve solo `computed_hash`/`stored_hash`). `.env.example:425-432` lo documenta sin valor.
- **RPC sin SQL dinámico:** `insert_receipt` es plpgsql parametrizado, sin `EXECUTE format(...)` → cero superficie de SQL injection.

## 2. Error Handling — OK

- `emit` no re-lanza: guards tempranos con `console.warn`+`return` (`receipt.ts:111-118`), `try/catch` envolviendo RPC+UPDATE (`:120-187`), rama de `error` del RPC (`:138-141`), rama "no row returned" (`:145-148`), rama hash-null (`:167-171`), rama UPDATE-error (`:179-181`), `catch` final (`:182-187`).
- `verify` NUNCA throw (CD-A): `hashesEqual` valida hex con regex ANTES de `Buffer.from` y longitud ANTES de `timingSafeEqual` (`:88-94`); ramas UNSIGNED / SIGNING_SECRET_UNAVAILABLE / tamper retornan objeto tipado, sin excepción.
- `list`/`getById` propagan error real de DB (no `PGRST116`) como `throw` controlado — apropiado para endpoints REST (500), no son path de pago.

## 3. Data Integrity — OK (ver MNR-2)

- **Append-only (CD-2):** `receipt.ts` solo hace `supabase.rpc('insert_receipt')` (INSERT), `.select()` (list/getById/verify) y **un único** `.update({receipt_hash}).eq('id',id).eq('receipt_hash','')` (`:174-178`). Cero `.delete()`. El `.eq('receipt_hash','')` impide re-escribir un hash ya seteado (idempotente: si ya fue firmado, 0 filas afectadas). Verificado por test `receipt.test.ts:301-343`.
- **Concurrencia INSERT:** `pg_advisory_xact_lock(hashtext(p_owner_ref))` (`migration:52`) serializa lectura-de-prev + INSERT por owner dentro de la tx del RPC; lock `xact` → se libera al COMMIT. No hay bifurcación del **orden de inserción** de la cadena por owner.
- amount determinismo: emit firma sobre `input.amountUsd`, verify sobre `row.amount_usd` (NUMERIC string); ambos `Number(v).toFixed(8)` (`receipt.ts:57`) → enmascara artefactos float y coincide con `NUMERIC(20,8)`. `created_at` ambos `new Date(v).toISOString()` (`:60`) → truncado a ms idéntico en los dos lados. Round-trip determinista (test `:171-182`).

## 4. Performance — OK

- Emisión fire-and-forget: no añade latencia al path de pago (no `await` en call-sites).
- `list` con índice `idx_a2a_receipts_owner_created (owner_ref, created_at DESC)` (`migration:24-25`) → cubre filtro+orden. `getById` por PK + owner. Sin N+1.

## 5. Integration / No-regresión — OK

- **CD-7 aridad de `debit` INTACTA:** firma sigue `debit(keyId, chainId, amountUsd, delegationContext?, keySessionContext?)` (`budget.ts:71-77`). Los tests nuevos usan la firma existente; `grep "debit).toHaveBeenCalledWith"` → ninguna assertion de aridad rota.
- `fee-charge.ts`, `chargeProtocolFee`, los `*DebitContext` sin diff (CD-6). Schema `a2a_events`/`a2a_protocol_fees` sin tocar.
- Suite completa 1511 verde → WKH-101/121/122/123 sin romper.
- **Auto-blindaje validado:** `request.scopingKeyRow?` ES `A2AAgentKeyRow` con `id:string` + `owner_ref:string` (`types/index.ts:396`; `types/a2a-key.ts:35-36`), propagado desde el middleware. El uso en `orchestrate.ts:462-463` es correcto y equivalente a la intención del Story File (L50-51); `request.a2aKeyRow` no existe en `OrchestrateRequest` (la corrección es necesaria y bien aplicada). Guard `request.scopingKeyRow?.owner_ref` cumple CD-D (sin owner → no emite).

## 6. Type Safety — OK

- Sin `any`/`as unknown` en código de producción (`receipt.ts`, `receipts.ts`, `receipt.ts` tipos). `amount_usd:string`, nullables `T|null`, `VerifyReceiptResult` union discriminada (`types/receipt.ts`). `tsc --noEmit` → 0.

## 7. Test Coverage — MENOR (MNR-1)

8/8 ACs tienen al menos un test. Gap: el call-site de emisión **master** (`a2a-key.ts`) y **key-session** (`budget.ts`) no tienen test de call-site propio; solo el path **delegation** lo tiene (`budget.test.ts:258-291`). El comportamiento subyacente está cubierto por `receipt.test.ts` (emit unit) + el path delegation análogo, así que ningún AC queda sin prueba — pero la tabla "Test Expectations" del Story File pedía explícitamente test de call-site master/key-session. Ver **MNR-1**.

## 8. Scope Drift — OK

Superficie idéntica a "Files to Modify/Create". `BACKLOG.md`/`HACKATHON-FINAL.md`/`_INDEX.md` son docs no-código. Sin refactors adyacentes.

## 9. Destructive Migrations — N/A

`20260605000000_a2a_receipts.sql`: `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` + `CREATE OR REPLACE FUNCTION`. Cero `DROP`/`ALTER ... TYPE`/`ADD COLUMN NOT NULL` sobre tablas con data/`UPDATE` masivo/`TRUNCATE`. Aditiva. `_down.sql` (`DROP FUNCTION` con firma exacta + `DROP TABLE IF EXISTS`) coincide con la up → reversible. Orden de timestamp correcto (posterior a `20260604000000`).

## 10. RPC SECURITY DEFINER — OK

`insert_receipt` es `SECURITY DEFINER` (necesario: el `service_role` ya bypassea RLS, pero DEFINER + GRANT acotado es el patrón de hardening del repo). Hardening completo (CD-C, `migration:81-86`):
- `SET search_path = public, pg_temp` → sin schema hijacking.
- `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE TO service_role` → solo el backend lo invoca.
- Sin SQL dinámico (parametrizado) → sin RCE/injection. Ownership la garantiza la capa app (el service pasa el `owner_ref` del caller autenticado).

## 11. Cache Invalidation — N/A

WKH-124 no introduce React Query / SWR / Redis / memoization / revalidatePath / CDN headers nuevos.

---

## Findings

### MNR-1 (Test Coverage) — falta test de call-site master + key-session
- **Archivo:** `src/middleware/a2a-key.test.ts` (sin mock de `receipt.js`), `src/services/budget.test.ts:255-291` (solo delegation).
- **Descripción:** En `a2a-key.test.ts` `receipt.js` no se mockea y `RECEIPT_SIGNING_SECRET` no está en el env de test (`vitest.config.ts` solo setea SUPABASE_*). El `emit` master corta en el guard `if (!process.env.RECEIPT_SIGNING_SECRET) return` ANTES de tocar supabase → por eso los 68 tests pasan, pero el wiring del call-site master (lineaje `keyRow.owner_ref/id`, `receipt_type:'budget_debit'`) nunca se ejercita. Idéntico para key-session en `budget.test.ts` (solo delegation tiene assertion `toHaveBeenCalledWith`).
- **Reproducción:** `grep -n "receiptService\|WKH-124" src/middleware/a2a-key.test.ts` → vacío. `grep -n "keySession.*emit" src/services/budget.test.ts` → vacío.
- **Impacto:** Bajo. El `emit` está probado unitariamente y el path delegation análogo valida el shape; pero una regresión que rompa SOLO el lineaje master/key-session (p.ej. pasar `keyRow.id` mal) no la atrapa ningún test. No rompe AC (AC-2 cubierto por delegation + emit unit).
- **Sugerencia (NO la implemento):** añadir en `budget.test.ts` un test del path key-session espejando el de delegation (assert `toHaveBeenCalledWith({sessionId, agentKeyId, receiptType:'budget_debit'})`), y/o en `a2a-key.test.ts` mockear `receipt.js` + assert del shape master. No bloquea DONE.

### MNR-2 (Data Integrity, nota de diseño — prevista en SDD) — `prev_receipt_hash` puede capturar `''` bajo emisiones concurrentes del mismo owner
- **Archivo:** `supabase/migrations/20260605000000_a2a_receipts.sql:54-59` + `src/services/receipt.ts:173-178`.
- **Descripción:** El lock advisory serializa el INSERT, pero la firma (UPDATE-once) ocurre FUERA del lock, en Node, tras liberarse la tx del RPC. Si el RPC del recibo N+1 corre antes de que Node complete el UPDATE-once del recibo N, el `SELECT ... receipt_hash ... LIMIT 1` lee el `''` de N (aún sin firmar) → N+1 guarda `prev_receipt_hash=''` en lugar del hash real de N. El eslabón de cadena queda apuntando a vacío.
- **Reproducción:** dos `emit` concurrentes del mismo `owner_ref` con el segundo RPC ganando la carrera contra el primer UPDATE → fila N+1 con `prev_receipt_hash=''`.
- **Impacto:** Bajo / no rompe AC. `verify` individual (AC-4/AC-5) sigue correcto (firma sobre los campos del propio row, incluido su `prev_receipt_hash` tal cual quedó). La integridad de **cadena** (no es un AC de esta HU; el anclaje Merkle/chain-verify se difiere a WKH-124b) es la única afectada.
- **Nota de calibración:** el SQL fue prescrito textualmente en el Story File (DT-5 + "copiar tal cual") y la ventana INSERT→UPDATE es una decisión documentada del SDD. El Dev implementó exactamente el contrato → **NO es un defecto del Dev**. Se registra como observación de diseño a considerar en WKH-124b (firmar dentro del lock, o encadenar por `created_at`/`id` en vez del hash placeholder). **No bloquea.**

---

## Orden de fix-pack
No hay BLOQUEANTEs → no requiere fix-pack. MNR-1 y MNR-2 son opcionales (backlog / WKH-124b). El gate **PASA**.
