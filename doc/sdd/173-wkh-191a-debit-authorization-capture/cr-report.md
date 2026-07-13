# CR Report (Adversary — Code Review de calidad) — WKH-191a

> HU: Captura + validación + persistencia de firma EIP-712 `DebitAuthorization` INERTE (Wave 0 del epic WKH-191, non-custodial).
> Reviewer: nexus-adversary (CR / dominio calidad-patrones).
> Fecha: 2026-07-13 · Branch de trabajo: `feat/191a-debit-authorization-capture`.
> Gates ejecutados: `tsc --noEmit` VERDE · `vitest run` **2868 pass / 0 fail** · `biome check` VERDE sobre los 5 archivos de código + tests tocados.

Archivos revisados (git diff):
- `src/adapters/escrow/eip712.ts` (+`recoverDebitAuthorization`)
- `src/adapters/escrow/debit-capture.ts` (nuevo)
- `src/services/payment-intent.ts` (wiring close/settle)
- `src/routes/payments.ts` (write-boundary + gate de flag)
- `src/types/database.types.ts` (Row/Insert/Update + RPC)
- `supabase/migrations/20260713000000_wkh191a_debit_signatures{,_down}.sql`
- Tests: `debit-capture.test.ts` (nuevo), `eip712.test.ts`, `payments.test.ts`, `payment-intent.test.ts` (17 `it()` nuevos)

---

## 1. Fidelidad al SDD / Story File

**OK.** La estructura, nombres de constantes, orden de prioridad de `reason`, columnas de tabla y firma del RPC coinciden byte-a-byte con §6/§7 del Story File. Los 11 archivos del Scope IN son exactamente los tocados; sin scope-drift.

Las 2 desviaciones reportadas por el Dev son **correctas y justificadas**:

- **(a) `p_amount_atomic`/`p_nonce` tipados `string` en `database.types.ts:2743,2745` (no `number`)** — El bloque literal del Story File §6.3 los mostraba como `number`, PERO la nota VERIFY-AT-IMPL del propio Story File (§7.1, línea 405) exige `bigint.toString()` para `NUMERIC(78,0)` "no `Number`, se pierde precisión > 2^53". La resolución elegida (tipar `string` + `persist()` pasa `.toString()` en `debit-capture.ts:194,196`) es la única internamente consistente. Es un fix, no un drift. **Correcta.**
- **(b) T-3b en `debit-capture.test.ts`** — Coincide con la tabla del Story File §9 (T-3b fila "AC-3 escrow no config | `debit-capture.test.ts`"). No hay desviación real; está en el archivo prescrito.

`p_deadline` se mantiene `number` (BIGINT epoch-seconds cabe en 2^53) — consistente entre migración (`BIGINT`), tipo (`number`, `database.types.ts:2744`) y `persist()` (`Number(fields.deadline)`, `debit-capture.ts:195`).

## 2. Calidad de los 17 tests

**OK, con 2 observaciones MENORES (no bloqueantes).**

- **No tautológicos / prueban lo que dicen:** T-1 firma real con `SIGNER_PK`, `buyer_wallet=signer.address`, `finalAmountUsd=1.5`→server `1_500_000` y asserta `valid` + los 4 campos derivados. T-2 firma sobre `1_000_000` (recover matchea buyer → descarta SIGNER) y verifica `AMOUNT_MISMATCH`. T-2b firma con `OTHER_PK` → `SIGNER_MISMATCH`. Genuinos.
- **T-10 (convergencia typed-data, `eip712.test.ts:153-193`):** firma con `buildDebitDomain`+`DEBIT_AUTHORIZATION_TYPES` y recupera contra `signer.address` independiente + caso firma malformada→`null`. Es lo máximo verificable en unit sin cadena; la convergencia byte-a-byte con `WasiAIEscrow.sol:38-39` es por inspección documentada (correcto para HU inerte). No tautológico (compara contra address independiente).
- **T-7 (`debit-capture.test.ts:337-359`) SÍ ejercita el wrapper REAL `captureDebitSignatureBestEffort`** con un RPC que devuelve `error` → el `captureDebitSignature` real lanza (`persist` `if (error) throw`) → el wrapper real lo atrapa y `resolves.toBeUndefined()`. Este es el test que blinda el no-throw real (CD-2). Correcto.
- **MNR-1 — T-8 mockea el wrapper, no lo ejercita:** `payment-intent.test.ts:44-53` reemplaza `captureDebitSignatureBestEffort` por un stub con su PROPIO try/catch. Verifica que `closeSession`/`settleUpto` invocan la captura (`mockInnerCapture` 1×) y retornan `SettleOutcome` normal, pero el no-throw REAL del wrapper NO se ejercita en el contexto del settle (queda cubierto por T-7 en aislamiento). La composición T-7+T-8 cubre la garantía; señalo el matiz de "mock que no ejercita el real" como deuda de test, no como gap de cobertura. **MENOR.**
- **MNR-2 — T-3 no asserta el spy del RPC:** el Story File §9 pedía "`capture_debit_signature` NUNCA se llama (spy)". Como `payments.test.ts` mockea el service completo, el RPC es inalcanzable; el test asserta el gate real relevante en la capa route (`closeSession`/`settleUpto` llamados con `debitCapture=undefined`). Cobertura equivalente pero más débil que el texto del SDD. **MENOR.**

Ambos MENOR son deuda de precisión de test, no rompen ningún AC.

## 3. Migración `capture_debit_signature`

**OK.** Seguridad y calidad correctas:
- `SECURITY DEFINER` + `SET search_path = public, pg_temp` fijado vía `ALTER FUNCTION` dentro del `BEGIN/COMMIT` (`.sql:135-136`). Sin hijacking de schema.
- `REVOKE … FROM PUBLIC, anon, authenticated` + `GRANT … TO service_role` (`.sql:137-140`) — lista de 11 tipos coincide EXACTA con la firma de la función. No expuesto a PostgREST/anon.
- Owner-guard DB-level: `SELECT … FOR UPDATE` + `IF NOT FOUND RAISE INTENT_NOT_FOUND` + `IS DISTINCT FROM p_owner_ref RAISE OWNERSHIP_MISMATCH` (`.sql:76-85`). El `FOR UPDATE` serializa capturas concurrentes sobre el MISMO intent.
- Anti-replay race-safe de doble baranda: pre-check `SELECT 1 … status='valid'` + backstop `EXCEPTION WHEN unique_violation` sobre el índice parcial `uq_debit_sig_valid_nonce (key_id, debit_nonce) WHERE status='valid'` (`.sql:42-44,87-125`). El re-insert del handler usa `status='invalid'` → no re-colisiona con el índice parcial. Cubre la carrera cross-intent con mismo `key_id` (que el `FOR UPDATE` por-intent no serializa). Correcto y fiel a `_usedNonces` (nonce quemado sólo en `valid`, espejo de `WasiAIEscrow.sol:139`).
- RLS deny-by-default (`ENABLE ROW LEVEL SECURITY`, service_role bypassa por BYPASSRLS). Patrón wkh135.
- **`_down` reversible:** `DROP FUNCTION IF EXISTS …(firma exacta 11 tipos)` + `DROP TABLE IF EXISTS …` en `BEGIN/COMMIT`. Additive puro → down limpio. Índice parcial y RLS caen con el `DROP TABLE`. Correcto.
- Timestamp `20260713000000` único y posterior a `20260712000000_wkh189` (verificado en `supabase/migrations/`).

## 4. Legibilidad / mantenibilidad

**OK.** Nombres claros (`serverAmountAtomic`, `clientAmount`, `keyIdHash`). Prioridad de reasons implementada como cadena `if/else if` legible y ordenada EXPIRED→TOO_FAR→SIGNER→AMOUNT (`debit-capture.ts:144-163`), consistente con SDD §5.3. `MAX_DEADLINE_TTL_SECONDS = 3600n` es constante nombrada con anchor al `.sol:45`. `persist()` extraída como helper privado, sin duplicación entre el path MALFORMED y el path normal. Sin dead code accionable: los status `not_provided`/`not_applicable` del CHECK están documentados como forward-compat de 191b (`.sql:30`, SDD §4.1). bigint→string en montos/nonce, `Number()` sólo en deadline. Único magic number menor (`sig.length < 4` en `extractDebitCapture`) es un piso de sanidad para "0x"+hex, aceptable.

## 5. Consistencia con el repo

**OK.** `recoverDebitAuthorization` reusa `DEBIT_AUTHORIZATION_TYPES`/`buildDebitDomain`/`recoverTypedDataAddress` de `eip712.ts` — NO duplica el typed-data (CD-5). El gate de flag clona el patrón `isArbiterEnabled()` (`process.env.X === 'true'`, choke-point único `isDebitCaptureEnabled()`). La migración calca el patrón wkh135 (tabla + RPC SECURITY DEFINER + REVOKE/GRANT + RLS + down con firma exacta). El write-boundary del route reusa el `(req.body ?? {}) as Record<string,unknown>` existente (`payments.ts:449` upto) y el gate primario replica CD-1. `database.types.ts` sigue el shape de tablas/funciones vecinas (Row/Insert/Update/Relationships + entrada en `Functions`).

## 6. Manejo de errores / tipos / edge cases

**OK.**
- uint256 como `string` extremo-a-extremo (`NUMERIC(78,0)` ↔ `string` en types ↔ `.toString()` en persist). Sin pérdida > 2^53.
- Parseo defensivo `BigInt()` en try/catch: campo faltante, decimal, o no-numérico → `MALFORMED_INPUT` sin lanzar (`debit-capture.ts:95-117`). `BigInt(1.5)`/`BigInt('1.5')` lanzan → capturados. Negativos no lanzan pero caen inertes en `AMOUNT_MISMATCH`.
- Lectura de `buyer_wallet` owner-guarded (`.eq('id').eq('owner_ref')`, `debit-capture.ts:122-127`) — sin IDOR; `buyerWallet=null` → `SIGNER_MISMATCH` (sin ancla). Doble defensa con el owner-guard del RPC.
- Escrow no configurado (`resolveEscrowContract=null`) y registro no init (`getDefaultChainKey=null`) → return temprano sin persistir (AC-3 byte-idéntico). Ambos con test.
- Decimales por chain vía `bundle.payment.supportedTokens[0].decimals` (NUNCA literal 18 / NUNCA `usdToWei`) — T-9 fija 6d Base Sepolia → `1_500000n`. `finalMicro/1e6` round-trip seguro con `Number.toString()` shortest para micro-montos.
- No-throw del path best-effort garantizado por T-7 (real) + wrapper `try/catch` total.
- Cero `escrow.debit()`/`writeContract` en el path de captura (T-4 spy sobre `settle`/`sign` del adapter). Firma INERTE (AC-4/CD-3/CD-7).

---

## Resumen de findings

| ID | Severidad | Categoría | Archivo:línea | Estado |
|----|-----------|-----------|---------------|--------|
| MNR-1 | MENOR | Test Coverage | `src/services/payment-intent.test.ts:44-53` | T-8 mockea el wrapper en vez de ejercitar el real (cubierto por T-7 en aislamiento) |
| MNR-2 | MENOR | Test Coverage | `src/routes/payments.test.ts:279-345` | T-3 no asserta el spy del RPC (inalcanzable por mock del service); asserta el gate route equivalente |

Sin BLOQUEANTES (ni ALTO, ni MEDIO, ni BAJO).

## Veredicto global

**APROBADO con MENORs.**

`tsc` verde, suite completa **2868 pass / 0 fail**, `biome` verde. Implementación fiel al SDD/Story File, migración segura y reversible, firma verdaderamente inerte, doble gate del flag, owner-guard en tabla+RPC+lectura, anti-replay race-safe. Los 2 MENOR son deuda de precisión de test (no rompen ACs, no bloquean el gate) — quedan a criterio del orquestador para entrar ahora o backlog. El gate binario **PASA**.
