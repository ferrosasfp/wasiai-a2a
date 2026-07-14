# Adversarial Review (AR) — WKH-194 · Contra-medida del nonce del árbitro (anti-griefing R-3/MNR-1)

- **Fecha**: 2026-07-13
- **Rama/artefactos**: `doc/sdd/180-wkh-194-arbiter-nonce-anti-griefing/{sdd.md,story-HU-194.md}`
- **Diff revisado**: `src/adapters/escrow/{arbiter-executor.ts,abi.ts}`, `src/services/arbiter.ts`,
  `src/types/database.types.ts`, `.env.example`, `supabase/migrations/20260713000003_wkh194_arbiter_nonces{,_down}.sql`
- **Verificación mecánica**: `npx tsc --noEmit` → EXIT 0. `npx vitest run` → **2984 pass / 0 fail**.

## Veredicto global: **APROBADO con MENORs**

Los 3 vectores críticos (no-adivinable / exactly-once / defensa no-refund) están cerrados y probados con
tests genuinos (no mocks que mienten). Cero BLOQUEANTEs. 1 MENOR de hardening (entropía del secreto) + 1
nota de scope. El gate PASA.

---

## 1. Security — **OK** (con 1 MENOR)
- **No-adivinable (crítico) — OK**: `deriveArbiterNonce` (arbiter-executor.ts:75-95) incorpora `secret` como
  4º arg `'string'` al `encodePacked`/`keccak256`. Sin el secreto server-side, el buyer (que sólo conoce
  `keyIdHash`+`intentId`) NO puede reproducir el digest. Probado: arbiter-executor.test.ts:541-550 (secreto
  distinto → nonce distinto). Bit-255 preservado: la máscara `ARBITER_NONCE_FLAG | (digest & LOW_MASK)` es
  intacta → rango `[2^255,2^256)` byte-compat con el contrato (test :534-538). **Secreto NUNCA logueado**:
  `getArbiterNonceSecret` (arbiter-executor.ts:107-127) sólo emite `{present}`/`{present,weak}` booleanos;
  auditado por test explícito arbiter-executor.test.ts:573-599 (JSON.stringify del meta NO contiene el valor).
  El detail de errores del service loguea `intentId`/`error.message`, nunca el secreto ni el candidate.
- **Ownership — OK**: doble capa. Read-first filtra `.eq('owner_ref', ownerRef)` (arbiter.ts:104-108) y el RPC
  owner-checkea contra `a2a_payment_intents` (`SELECT owner_ref … FOR UPDATE` + `IS DISTINCT FROM`,
  migración :45-54). Un caller no puede leer/generar el nonce de otro intent (miss → RPC → RAISE
  OWNERSHIP_MISMATCH → error → null → fallback).
- **MNR-1 (Security, arbiter-executor.ts:98-127)**: el guard de fortaleza es **length-only (≥32 chars)**, no de
  entropía. El `nonce` se vuelve **público** al enviarse como arg on-chain de `resolveDispute`; un atacante que
  observe una resolución pasada obtiene `(keyIdHash, intentId, nonce)` y puede brute-forcear **offline** un
  secreto de baja entropía pero ≥32 chars (ej. `'a'.repeat(32)` pasa como "fuerte"). Crackeado el secreto,
  puede pre-derivar nonces de intents FUTUROS y reanudar el griefing R-3.
  - *Repro conceptual*: `ARBITER_NONCE_SECRET='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'` → `getArbiterNonceSecret()`
    devuelve el string (no `weak`) → si un tercero observa un nonce on-chain, itera candidatos de baja entropía
    hasta matchear `deriveArbiterNonce(keyIdHash,intentId,cand)`.
  - *Mitigación ya presente*: `.env.example:+321` obliga `openssl rand -hex 32` (256 bits) → inatacable si se
    respeta. Requiere que el operador ignore activamente la guía. Testnet-only + flag OFF.
  - *Sugerencia (no bloqueante)*: documentar en el getter que la fortaleza depende de la entropía (no del
    largo) y que la clave DEBE venir de un CSPRNG; opcionalmente subir el mínimo o loguear `weak` también para
    patrones de baja entropía triviales.

## 2. Error Handling — **OK**
`getOrCreateArbiterNonce` es nunca-throw money-safe: read-first sin `.single()` (usa `.maybeSingle()`), RPC
envuelto en try/catch, cualquier `error`/no-row/throw → `log.error` + `return null` → fallback
operator-custodial (arbiter.ts:110-160). El diagnóstico post-mortem (arbiter-executor.ts:352-383) está en
try/catch: cualquier fallo del `simulateContract` (RPC down, otro revert) cae a `'REVERTED'` (conservador,
comportamiento de hoy); nunca lanza. Probado: arbiter-executor.test.ts:653-660 (RPC down → REVERTED sin throw).

## 3. Data Integrity — **OK** (foco crítico exactly-once)
- **Read-first exactly-once — OK**: una vez persistido, retry/recovery devuelven el nonce persistido SIN
  recomputar (arbiter.ts:104-108). Probado end-to-end: arbiter.test.ts:1654-1673 — la 2ª pasada **rota el
  secreto** (`'y'.repeat(64)`) y aun así devuelve el MISMO nonce y NO re-llama al RPC. Exactly-once
  **desacoplado del secreto** (CD-1 cumplido).
- **Atomicidad first-writer — OK**: RPC `INSERT … ON CONFLICT (intent_id) DO NOTHING` + re-SELECT del ganador
  (migración :57-64). Dos generaciones concurrentes → el mismo nonce ganador (el 2º no-op lee el del 1º), aun
  con candidates distintos por rotación de secreto. Probado: arbiter.test.ts:1755-1772 (usa SIEMPRE el
  `persisted_nonce` del RPC, no el candidate local). `FOR UPDATE` sobre el intent serializa el owner-check.
- La columna `nonce NUMERIC(78,0)` = uint256 sin pérdida; viaja como string en ambos sentidos
  (`candidate.toString()` / `BigInt(String(...))`), tipado como `string` en database.types.ts (evita >2^53).

## 4. Performance — **OK**
+1 SELECT (read-first) y +1 RPC por resolución de disputa en el path escrow-ON. Es un flujo de baja frecuencia
(arbitraje), no un hot-path. `idx_arbiter_nonces_owner` presente. Con flag OFF (default) cero queries nuevas
(fast-path arbiter.ts:178 antes de todo). Sin N+1, sin loops nuevos.

## 5. Integration — **OK**
Cambio de firma `deriveArbiterNonce(kh, id) → (kh, id, secret)` contenido: único caller productivo es
`getOrCreateArbiterNonce`; los call-sites de tests fueron actualizados (tsc verde confirma que no quedan
llamadas 2-arg). El happy-path del executor (`confirmed`), write-fail, timeout y `ambiguous` genuino quedan
byte-idénticos (el diagnóstico vive SOLO dentro de la rama `receipt.status !== 'success'` de
`executeResolveDispute`; `executeLockForDispute:252-254` intacto). El mapeo `not_moved → {error:o.reason,
failureKind:'unequivocal'}` (arbiter.ts:214-221) propaga `'NONCE_ALREADY_USED'` sin envolver → la comparación
AC-7 `settle.error === ARBITER_NONCE_COLLISION_REASON` matchea exacto.

## 6. Type Safety — **OK**
`tsc --noEmit` limpio. Sin `any` inyectado; los casts son acotados y justificados
(`data as { persisted_nonce: string }[] | null`, `revert.data?.errorName`). `nonce` como `string` en los tipos
(no `number`) evita NaN/pérdida de precisión. `getArbiterNonceSecret(): string | null` y
`getOrCreateArbiterNonce(...): Promise<bigint | null>` con null explícito manejado en el caller.

## 7. Test Coverage — **OK**
9 tests (T1-T9) genuinos, ≥1 por AC, sin mocks que mienten:
- T7 (arbiter-executor.test.ts:602-661) decodifica con **viem real** (`ContractFunctionRevertedError` + selector
  `keccak256('NonceAlreadyUsed()')` contra `ESCROW_ABI`) → valida end-to-end la nueva entrada `error` del ABI
  (si faltara, `errorName` sería undefined y el test fallaría). Cubre colisión / otro-revert / RPC-down.
- T8 (arbiter.test.ts:1715-1734) prueba no-refund real: `db.refunds` **vacío** + `settle_outcome='failed_ambiguous'`
  + `error_message` contiene `RECONCILE: NONCE_COLLISION`. T8-contraste (:1736-1751) confirma que `REVERTED`
  no-colisión SIGUE refundando completo (`db.refunds=[10]`, `failed_unequivocal`) → byte-idéntico a hoy.
- T4 exactly-once con rotación de secreto; T5 fallback secreto-ausente; T6 flag-OFF inerte (ni RPC ni
  `from('a2a_arbiter_nonces')`); T9 first-writer atómico. CD-2 auditado por assert de logs.

## 8. Scope Drift — **OK** (con nota)
Archivos tocados = Scope IN (migraciones, abi.ts [Nota #3 del story], arbiter-executor.ts, arbiter.ts,
.env.example, ambos test) + `_INDEX.md` (docs). `contracts/**` intacto (CD-4). `a2a_arbitrations`/su timing
intactos.
- **Nota (no finding)**: `src/types/database.types.ts` fue modificado pero NO está en la tabla Scope IN
  enumerada. Es un cambio **necesario, additive y mecánico** (tipos generados de la tabla+RPC nuevos; sin él
  tsc no compila el `.from('a2a_arbiter_nonces')`/`.rpc('get_or_create_arbiter_nonce')`). Análogo al caso de
  abi.ts. Sin lógica, sin riesgo. Se documenta para trazabilidad; no bloquea.

## 9. Destructive Migrations — **OK**
`20260713000003_wkh194_arbiter_nonces.sql` es 100% aditiva: `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT
EXISTS` + `CREATE OR REPLACE FUNCTION`. Sin DROP/ALTER/UPDATE/TRUNCATE sobre tablas con data. Envuelta en
`BEGIN/COMMIT`. Down reversible (`DROP FUNCTION` + `DROP TABLE`, ambos `IF EXISTS`). FK `ON DELETE CASCADE` sólo
afecta a filas de la tabla nueva.

## 10. RPC con SECURITY DEFINER — **OK**
`get_or_create_arbiter_nonce` (migración :34-70): `SECURITY DEFINER` **con** `SET search_path = public, pg_temp`
(:72-73) → sin schema-hijacking. Owner-check interno real (`FOR UPDATE` + `IS DISTINCT FROM`, :45-54) → no
escala privilegios. Sin SQL dinámico (`EXECUTE format`) → sin RCE. GRANT restringido: `REVOKE … FROM PUBLIC,
anon, authenticated` + `GRANT … TO service_role` (:74-77) → no expuesto a PostgREST anónimo. Es `SECURITY
DEFINER` porque necesita bypassar RLS para el owner-guard cruzado; justificado.

## 11. Cache Invalidation Logic — **N/A**
No introduce ninguna capa de cache (React Query/SWR/Redis/revalidate/memoization). El "read-first" es una
lectura de fuente de verdad persistida (Postgres), no un cache con TTL/invalidación. N/A.

---

## Findings ordenados
| ID | Sev | Cat | Archivo:línea | Resumen |
|----|-----|-----|---------------|---------|
| MNR-1 | MENOR | Security | arbiter-executor.ts:98-127 | Guard del secreto es length-only, no entropía; secreto ≥32 chars de baja entropía es offline-crackable desde un nonce on-chain público → griefing reanudable. Mitigado por guía `openssl rand -hex 32` en .env.example. |

**Sin BLOQUEANTEs. Gate: PASA.** MENOR queda a decisión (documentar guía de entropía ahora o backlog; no bloquea DONE).
