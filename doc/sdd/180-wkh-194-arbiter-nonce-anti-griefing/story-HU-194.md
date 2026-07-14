# Story File — HU 194 · Contra-medida del nonce del árbitro (cierra griefing MNR-1/R-3)

> Contrato autocontenido para el Dev (F3). El Dev SOLO lee este archivo.
> Si algo no está acá, no se hace. Todos los paths/líneas fueron verificados con Read/Grep por el Architect.
>
> - SDD fuente: `doc/sdd/180-wkh-194-arbiter-nonce-anti-griefing/sdd.md` (SPEC_APPROVED)
> - Work Item: `doc/sdd/180-wkh-194-arbiter-nonce-anti-griefing/work-item.md`
> - Epic: WKH-191 · Wave 1 · follow-up de seguridad de 191g (fila 178 `_INDEX.md`)
> - Branch: `fix/194-arbiter-nonce-anti-griefing`
> - Tipo: feature/security/billing · SDD_MODE: full
> - **Testnet-only (CD-6).** El árbitro sigue **INERTE** en prod (sin `setArbiter()` + sin consent capturado).

---

## 1. Contexto compacto (qué se construye y por qué)

`deriveArbiterNonce` (`src/adapters/escrow/arbiter-executor.ts:72-83`) deriva HOY el `nonce` de
`resolveDispute` de forma **determinista y pública**: `(1<<255) | (keccak256('WasiAIEscrow.arbiter-dispute.v1',
keyIdHash, intentId) & LOW_MASK)`. Como el buyer conoce `keyId`+`intentId` desde que abre el intent, y
`debit()` acepta un `nonce` **elegido libremente por el cliente** sobre el MISMO mapping
`_usedNonces[keyId][nonce]` que `resolveDispute` (`WasiAIEscrow.sol:170,276`), un buyer puede
**pre-consumir** el nonce del árbitro con una `DebitAuthorization` propia ANTES de que exista disputa.
Cuando el árbitro on-chain se active, `resolveDispute` revierte `NonceAlreadyUsed` → `not_moved` → rama
`unequivocal` (`arbiter.ts:766-796`) → **refund COMPLETO al buyer, el seller ganador cobra CERO**
(denegación de valor).

Esta HU cierra el vector con **3 capas aditivas** (Opción A app-only, cero Solidity):

1. **Secreto server-side**: `deriveArbiterNonce` incorpora `ARBITER_NONCE_SECRET` al digest → el nonce
   deja de ser re-derivable por el buyer.
2. **Persistencia exactly-once**: el nonce se persiste por `intentId` en la tabla nueva
   `a2a_arbiter_nonces` con get-or-create atómico (read-first → miss → compute+RPC) → retry/recovery
   leen el persistido, NUNCA recomputan (exactly-once REAL, independiente de la estabilidad del secreto).
3. **Defensa en profundidad**: si aun así `resolveDispute` cae `NonceAlreadyUsed`, NO se auto-refunda al
   buyer → se rutea a `failed_ambiguous` (no-refund, `RECONCILE: NONCE_COLLISION`, revisión humana) —
   eliminando el premio del griefing.

Todo **INERTE con `ESCROW_ARBITER_ENABLED` OFF** (default): el fast-path de la línea 111 retorna byte-idéntico.

---

## 2. Scope IN (lista exhaustiva de archivos a tocar)

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `supabase/migrations/20260713000003_wkh194_arbiter_nonces.sql` | **Crear** | W0 |
| 2 | `supabase/migrations/20260713000003_wkh194_arbiter_nonces_down.sql` | **Crear** | W0 |
| 3 | `src/adapters/escrow/abi.ts` | Modificar (additive: +1 entrada `error`) | W1 |
| 4 | `src/adapters/escrow/arbiter-executor.ts` | Modificar (`deriveArbiterNonce` 3er arg + `getArbiterNonceSecret` + `ARBITER_NONCE_COLLISION_REASON` + diagnóstico) | W1 (puras) + W2 (diagnóstico) |
| 5 | `src/services/arbiter.ts` | Modificar (`getOrCreateArbiterNonce` + wire :130 + defensa AC-7 :766) | W2 |
| 6 | `.env.example` | Modificar (documentar `ARBITER_NONCE_SECRET`) | W1 |
| 7 | `src/adapters/escrow/arbiter-executor.test.ts` | Modificar (casos secreto + diagnóstico + fix llamadas 2-arg) | W3 |
| 8 | `src/services/arbiter.test.ts` | Modificar (exactly-once/fallback/defensa + fix `EXPECTED_NONCE`) | W3 |

**PROHIBIDO tocar cualquier otro archivo.** En particular: NADA en `contracts/**` (CD-4), ni
`rules.ts`/`llm-classifier.ts`/`evidence.ts`, ni `debit-executor.ts`/`debit-capture.ts`, ni
`payment-intent.ts`, ni `a2a_arbitrations`/su migración/su timing de escritura (DT-2), ni `usdToAtomic`/
`parseUnits`/el settle path. **Sin dependencias nuevas.**

> **Nota #3 (abi.ts) — no está en el Scope IN del SDD pero es OBLIGATORIO**: el diagnóstico AC-7 usa
> `simulateContract` + decode de la custom error contra `ESCROW_ABI`. El `ESCROW_ABI` actual
> (`src/adapters/escrow/abi.ts:19-149`) **NO tiene NINGUNA entrada `error`** → viem no puede decodificar
> `errorName === 'NonceAlreadyUsed'`. Hay que AGREGAR una entrada `error` (§7-D). Es `src/` (app-layer),
> **NO** `contracts/` → CD-4 intacto. Es byte-a-byte con el ABI compilado (`contracts/out/IWasiAIEscrow.sol/IWasiAIEscrow.json`:
> `{ type:'error', name:'NonceAlreadyUsed', inputs:[] }`, verificado).

---

## 3. Anti-Hallucination Checklist (específico de esta HU)

Ya verificado por el Architect con Read/Grep. NO re-inventar; confirmá antes de escribir:

- [x] `deriveArbiterNonce(keyIdHash: string, intentId: string): bigint` HOY en
      `arbiter-executor.ts:72-83`. Digest actual:
      `keccak256(encodePacked(['string','bytes32','string'], ['WasiAIEscrow.arbiter-dispute.v1', keyIdHash, intentId]))`.
      Retorno: `ARBITER_NONCE_FLAG | (BigInt(digest) & ARBITER_NONCE_LOW_MASK)`.
- [x] `ARBITER_NONCE_FLAG = 1n << 255n` (`:63`), `ARBITER_NONCE_LOW_MASK = (1n << 255n) - 1n` (`:64`). NO tocar.
- [x] `encodePacked` y `keccak256` ya importados desde `viem` en `arbiter-executor.ts` (usados en `:76-80`).
- [x] `executeResolveDispute` en `arbiter-executor.ts:252-343`. La rama de revert es
      `if (receipt.status !== 'success') return { kind: 'not_moved', reason: 'REVERTED', txHash };` (`:306-308`).
      El happy-path (`:342 return { kind:'confirmed', ... }`), timeout (`:302-304 ambiguous`), write-fail
      (`:284-291 not_moved WRITE_FAILED`) y match-de-evento (`:338-339 ambiguous`) NO se tocan (byte-idénticos).
- [x] `ArbiterOnChainOutcome` (unión `confirmed`/`not_moved`/`ambiguous`) en `arbiter-executor.ts:87-90`.
      El `reason` de `not_moved` es un `string` libre → el nuevo `ARBITER_NONCE_COLLISION_REASON` encaja.
- [x] `getArbiterPublicClient(chainKey)` existe y devuelve `ArbiterPublicClient | null` (usado en `:264`).
      `publicClient.simulateContract` es el método viem para reproducir el revert. Nunca lanza si se envuelve en try/catch.
- [x] `ESCROW_ABI` es `as const` en `abi.ts:19-149`; SIN entradas `error` (verificado). Se AGREGA
      `{ type:'error', name:'NonceAlreadyUsed', inputs:[] }` sin reordenar/renombrar lo existente.
- [x] `arbiter.ts` importa `deriveArbiterNonce` de `../adapters/escrow/arbiter-executor.js` en `:24`.
      Agregar al MISMO import `getArbiterNonceSecret` y `ARBITER_NONCE_COLLISION_REASON` (CD-AB-1: verificar
      que existan como `export` antes de tsc).
- [x] `settleArbitrationOnChain` en `arbiter.ts:99-165`. La derivación FRESCA está en `:130`
      `const nonce = deriveArbiterNonce(keyIdHash, intentId);`. Está DESPUÉS del check `decimals` (`:126-128`)
      y ANTES de `executeResolveDispute` (`:133`). `ownerRef` disponible en `:107` (destructurado de params).
      `keyIdHash` en `:120`. El `catch` final (`:161-164`) devuelve `settlePaymentIntentOnChain(base)`.
- [x] `isEscrowArbiterEnabled()` (`arbiter.ts:87-89`, `=== 'true'` exacto). El fast-path OFF está en
      `settleArbitrationOnChain:111` → retorna sin computar/persistir nonce (AC-6).
- [x] Env-getters del proyecto (patrón a copiar para `getArbiterNonceSecret`): `getArbiterAutoCapUsd`
      (`arbiter.ts:62-75`) — lee `process.env.X`, `.trim()`, `log.warn` sin exponer el valor, nunca-throw.
- [x] `mapArbPgError(error, ctx)` en `arbiter.ts:266` — mapea error crudo de RPC a `ArbiterError` (`OWNERSHIP_MISMATCH`/
      `INTENT_NOT_FOUND`). Reusar en `getOrCreateArbiterNonce`.
- [x] `executeArbitration` en `arbiter.ts:662-824`. La rama `unequivocal` (auto-refund COMPLETO) es
      `if (settle.failureKind === 'unequivocal') { ... }` en `:767-796` — llama `recordSettleOutcome(...,'failed_unequivocal',...)`
      (`:769`), `finalizePaymentIntent(...,'failed_unequivocal',...)` (`:777`), `if (!ok) throw ArbiterError('INTERNAL')`
      (`:786`), `emitAndRecord` (`:787`), y `return this.outcome(meta, arbUsd, depositMicro/1_000_000, 'executed', null)`
      (`:789-795` → refund = deposit COMPLETO). La intercepción AC-7 va JUSTO ANTES de este `if`.
- [x] La rama `ambiguous` (`:798-823`) es la SEMÁNTICA no-refund a reusar: `recordSettleOutcome(...,'failed_ambiguous',...)`
      (`:804`), `finalizePaymentIntent(...,'failed_ambiguous',...)` (`:812`), `if (!okAmb) throw ArbiterError('INTERNAL')`
      (`:821`), `emitAndRecord` (`:822`), `return this.outcome(meta, arbUsd, 0, 'executed', null)` (`:823` → residual 0, NO refund).
      Copiar su FORMA (NO su etiqueta literal "RECONCILE: ${settle.error}").
- [x] `recordSettleOutcome(intentId, ownerRef, outcome: SettleVerdict, txHash, residual, errorMessage)`
      (`arbiter.ts:281-310`). `finalizePaymentIntent(intentId, ownerRef, txHash, finalAmount, residual, outcome, errorMessage): Promise<boolean>`
      (`arbiter.ts:312-...`). `SettleVerdict = 'settled'|'failed_unequivocal'|'failed_ambiguous'` (`:243`).
- [x] `SettleOutcome` (la forma que devuelve `settleArbitrationOnChain`) tiene `failureKind?: 'unequivocal'|'ambiguous'`
      y `error?: string` (`arbiter.ts:144-160`). El diagnóstico setea `error = ARBITER_NONCE_COLLISION_REASON`
      con `failureKind: 'unequivocal'`.
- [x] Migración: exemplar `20260713000000_wkh191a_debit_signatures.sql` (tabla + RPC SECURITY DEFINER
      owner-guarded + `SET search_path` + REVOKE/GRANT) y `20260713000001_wkh191b_debit_hop1.sql`
      (RPC get-or-persist idempotente `RETURNS TABLE`). Down: `20260713000001_wkh191b_debit_hop1_down.sql`.
      Próximo número libre: `20260713000003` (000000/000001/000002 tomados).
- [x] `NUMERIC(78,0)` = uint256 (mismo tipo que `debit_nonce` de 191a `:26`). En TS: `bigint.toString()`
      hacia el RPC; `BigInt(persisted_nonce_string)` de vuelta.
- [x] Tests que ROMPEN con el 3er arg requerido (hay que arreglarlos, §8):
      `arbiter-executor.test.ts:62,489,494,495,500,501,502,508` (llamadas `deriveArbiterNonce(KEY_ID_HASH, 'intent-…')`
      con 2 args) y `arbiter.test.ts:1356` (`const EXPECTED_NONCE = deriveArbiterNonce(EXPECTED_KEY_HASH, 'i1')`).
- [x] `arbiter.test.ts`: `mockRpc` (`:114`) + `mockFrom` (`:115`); `handlers` (`:222-317`) mapea nombres de RPC;
      `fromImpl` (`:320-...`) mapea tablas. Para el helper nuevo hay que EXTENDER `handlers` con
      `get_or_create_arbiter_nonce` y `fromImpl`/`maybeSingle` con la tabla `a2a_arbiter_nonces`.
      `deriveArbiterNonce` se importa REAL (no mockeado, `:104`).

---

## 4. Constraint Directives (inline — heredados de work-item + SDD)

### OBLIGATORIO
- **CD-EXACT-ONCE (CD-1)**: read-first obligatorio. Una vez que existe un nonce persistido para el `intentId`,
  PROHIBIDO recomputar `deriveArbiterNonce` — el retry/recovery DEBE devolver EXACTAMENTE el persistido.
- **CD-NO-ADIV (CD-2)**: el nonce del árbitro debe ser criptográficamente no-adivinable sin `ARBITER_NONCE_SECRET`.
  PROHIBIDO exponer el secreto en logs/telemetría/recibos/respuestas (loguear SOLO flags booleanos `present`/`weak`).
  PROHIBIDO cualquier fórmula que dependa SOLO de datos públicos (`keyId`/`intentId`).
- **CD-FAIL-CLOSED (CD-3)**: si `ARBITER_NONCE_SECRET` falta/vacío/débil → caer al path operator-custodial
  (`settlePaymentIntentOnChain(base)`), sin invocar `onlyArbiter`. PROHIBIDO fallback silencioso a la fórmula pública antigua.
- **CD-NO-CONTRACTS (CD-4)**: PROHIBIDO tocar `contracts/**` (`WasiAIEscrow.sol`/`IWasiAIEscrow.sol`). `abi.ts` es
  `src/` (app-layer) → permitido agregarle la entrada `error` byte-a-byte con el ABI compilado.
- **CD-BYTE-IDENT (CD-5)**: preservar byte-idéntico el resto del wire de 191g — flag OFF / sin escrow /
  consent false / **happy path del executor** (`confirmed`) / write-fail / timeout / ambiguous genuino. El diagnóstico
  `NonceAlreadyUsed` vive SOLO dentro de la rama de revert ya existente (`receipt.status !== 'success'`).
- **CD-TESTNET (CD-6)**: ninguna llamada on-chain puede alcanzar mainnet.
- **CD-OWNERSHIP (WKH-53)**: el `SELECT` read-first filtra por `owner_ref`; el RPC owner-checkea contra
  `a2a_payment_intents` (`SELECT owner_ref … FOR UPDATE` + check `IS DISTINCT FROM`). Firma con `ownerId: string` (no opcional).
- **CD-AB-1** (191g auto-blindaje #1): verificar que CADA símbolo importado exista como `export` antes de tsc
  (`getArbiterNonceSecret`/`ARBITER_NONCE_COLLISION_REASON` en el import de `arbiter.ts`).
- **CD-AB-2** (recurrente ≥3 HUs epic 191): mocks `vi.fn` reexpuestos vía spread se tipan con rest param
  `vi.fn((..._a: unknown[]): T => …)` (evita TS2556 con aridad fija).
- **CD-AB-3** (191g auto-blindaje #3): tests con veredicto `release` determinístico por rules DEBEN incluir
  `voucherCount`/`vouchersTotalUsd` en la evidencia (usar `makeEvidence({ consumedUsd, voucherCount, vouchersTotalUsd })`).

### PROHIBIDO (resumen accionable)
- Recomputar el nonce si ya está persistido · exponer el secreto · fallback a fórmula pública · tocar `contracts/**` ·
  auto-refundar en colisión de nonce · alterar el happy path del executor · tocar `a2a_arbitrations`/su timing ·
  agregar dependencias · cambiar la forma de `SettleOutcome`/las otras ramas de `executeArbitration`.

---

## 5. Waves (archivos exactos por wave)

### Wave 0 — Serial Gate (contratos de datos)
- **W0.1** `supabase/migrations/20260713000003_wkh194_arbiter_nonces.sql` — tabla + RPC + RLS + grants (SQL completo §6).
- **W0.2** `supabase/migrations/20260713000003_wkh194_arbiter_nonces_down.sql` — DROP reversible (§6).

### Wave 1 — Paralelizable (puras/env/abi, sin deps entre sí)
- **W1.1** `arbiter-executor.ts` — `deriveArbiterNonce(keyIdHash, intentId, secret)` (3er arg, §7-A) +
  `getArbiterNonceSecret(): string | null` (§7-B) + `export const ARBITER_NONCE_COLLISION_REASON = 'NONCE_ALREADY_USED'` (§7-C).
- **W1.2** `abi.ts` — agregar `{ type:'error', name:'NonceAlreadyUsed', inputs:[] }` a `ESCROW_ABI` (§7-D).
- **W1.3** `.env.example` — documentar `ARBITER_NONCE_SECRET` (fail-closed, ≥32 chars, `openssl rand -hex 32`), en el bloque árbitro.

### Wave 2 — Integración (dep. W0 + W1)
- **W2.1** `arbiter.ts` — `getOrCreateArbiterNonce(intentId, ownerRef, keyIdHash): Promise<bigint | null>` (read-first + RPC, §7-E)
  + wire en `settleArbitrationOnChain` reemplazando `:130` + fallback null (§7-F). Dep. W0.1, W1.1.
- **W2.2** `arbiter-executor.ts` — diagnóstico post-mortem `NonceAlreadyUsed` en la rama de revert de
  `executeResolveDispute:306-308` (§7-G). Dep. W1.1, W1.2.
- **W2.3** `arbiter.ts` — rama defensa-en-profundidad AC-7 en `executeArbitration`, JUSTO ANTES del `if (settle.failureKind === 'unequivocal')` de `:767` (§7-H). Dep. W2.2.

### Wave 3 — Tests + verificación
- **W3.1** `arbiter-executor.test.ts` — T1/T2/T3/T7 + fix llamadas 2-arg (§8).
- **W3.2** `arbiter.test.ts` — T4/T5/T6/T8/T9 + fix `EXPECTED_NONCE` (§8).
- **W3.3** `npx tsc --noEmit` + `npx biome check` + `npx vitest run` (verde total).

---

## 6. Wave 0 — SQL COMPLETO (copiar tal cual, luego adaptar comentarios)

### W0.1 — `supabase/migrations/20260713000003_wkh194_arbiter_nonces.sql`

```sql
-- ============================================================
-- Migration: 20260713000003_wkh194_arbiter_nonces
-- WKH-194: persistencia exactly-once del nonce del árbitro (anti-griefing MNR-1/R-3).
-- INERTE — no mueve fondos, cero on-chain. Aditiva 100%. NO toca a2a_payment_intents,
-- a2a_arbitrations, ni ningún RPC existente. Crea:
--   - Tabla a2a_arbiter_nonces (un nonce inmutable por intent, intent_id PK).
--   - RPC get_or_create_arbiter_nonce (SECURITY DEFINER, owner-guarded, first-writer-wins).
--   - RLS deny-by-default (service_role bypassa por BYPASSRLS).
-- Patrón: 20260713000000_wkh191a_debit_signatures.sql + record_debit_hop1 (191b).
-- ============================================================

BEGIN;

-- ── Tabla a2a_arbiter_nonces (un nonce inmutable por intent) ──
CREATE TABLE IF NOT EXISTS a2a_arbiter_nonces (
  intent_id   UUID PRIMARY KEY REFERENCES a2a_payment_intents(id) ON DELETE CASCADE,
  owner_ref   TEXT NOT NULL,            -- Ownership Guard (WKH-53)
  key_id_hash TEXT NOT NULL,            -- keccak256(stringToBytes(key_id)) — auditoría
  nonce       NUMERIC(78,0) NOT NULL,   -- uint256 disjunto (bit-255) — persistido, inmutable
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_arbiter_nonces_owner ON a2a_arbiter_nonces (owner_ref);

-- RLS deny-by-default (patrón wkh191a: service_role bypassa por BYPASSRLS).
ALTER TABLE a2a_arbiter_nonces ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RPC: get_or_create_arbiter_nonce (SECURITY DEFINER, owner-guarded, atómico)
-- First-writer-wins: el PRIMER writer persiste su candidate; cualquier writer
-- posterior lee el nonce YA persistido (ON CONFLICT DO NOTHING + re-SELECT).
-- NUNCA mueve dinero. Devuelve el nonce EFECTIVAMENTE persistido (ganador).
-- ============================================================
CREATE OR REPLACE FUNCTION get_or_create_arbiter_nonce(
  p_intent_id   UUID,
  p_owner_ref   TEXT,
  p_key_id_hash TEXT,
  p_nonce       NUMERIC
) RETURNS TABLE(persisted_nonce NUMERIC) AS $$
DECLARE
  v_owner TEXT;
  v_nonce NUMERIC;
BEGIN
  -- Ownership Guard DB-level (WKH-53): el intent debe existir y pertenecer al caller.
  SELECT owner_ref INTO v_owner
    FROM a2a_payment_intents
    WHERE id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;

  -- First-writer-wins: el primer INSERT gana; un writer posterior es no-op.
  INSERT INTO a2a_arbiter_nonces (intent_id, owner_ref, key_id_hash, nonce)
    VALUES (p_intent_id, p_owner_ref, p_key_id_hash, p_nonce)
    ON CONFLICT (intent_id) DO NOTHING;

  -- Re-SELECT: devuelve el valor GANADOR (recién insertado o pre-existente).
  SELECT nonce INTO v_nonce
    FROM a2a_arbiter_nonces
    WHERE intent_id = p_intent_id;

  persisted_nonce := v_nonce;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.get_or_create_arbiter_nonce(uuid, text, text, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.get_or_create_arbiter_nonce(uuid, text, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_create_arbiter_nonce(uuid, text, text, numeric)
  TO service_role;

COMMIT;
```

### W0.2 — `supabase/migrations/20260713000003_wkh194_arbiter_nonces_down.sql`

```sql
-- ============================================================
-- Down: 20260713000003_wkh194_arbiter_nonces
-- Revierte SOLO lo de 194. Aditivo: dropea el RPC + la tabla nueva.
-- No toca a2a_payment_intents ni a2a_arbitrations ni datos de otras HUs.
-- ============================================================

BEGIN;
DROP FUNCTION IF EXISTS get_or_create_arbiter_nonce(uuid, text, text, numeric);
DROP TABLE IF EXISTS a2a_arbiter_nonces;
COMMIT;
```

**Tipos TS del RPC** (para el service): argumentos `{ p_intent_id: string, p_owner_ref: string, p_key_id_hash: string, p_nonce: string }`
(el nonce viaja como **string** vía `candidate.toString()`); respuesta `data: [{ persisted_nonce: string }]` → `BigInt(data[0].persisted_nonce)`.

---

## 7. Patrones a seguir (shapes exactos por archivo)

### 7-A · `deriveArbiterNonce` con 3er arg `secret` (W1.1 — AC-4/AC-5/CD-2)

Firma nueva `deriveArbiterNonce(keyIdHash: string, intentId: string, secret: string): bigint`. El secreto se
INCORPORA al digest (NO lo reemplaza) agregando un 4º tipo `'string'` al `encodePacked`:

```ts
export function deriveArbiterNonce(
  keyIdHash: string,
  intentId: string,
  secret: string,
): bigint {
  const digest = keccak256(
    encodePacked(
      ['string', 'bytes32', 'string', 'string'],
      ['WasiAIEscrow.arbiter-dispute.v1', keyIdHash as `0x${string}`, intentId, secret],
    ),
  );
  return ARBITER_NONCE_FLAG | (BigInt(digest) & ARBITER_NONCE_LOW_MASK); // bit-255 intacto (AC-4)
}
```

- Pura dado el secreto (mismo secreto+inputs → mismo nonce; secreto distinto → distinto).
- `ARBITER_NONCE_FLAG`/`ARBITER_NONCE_LOW_MASK` intactos → sigue en `[2^255, 2^256)` (byte-compatible con el contrato).

### 7-B · `getArbiterNonceSecret(): string | null` (W1.1 — AC-3/CD-2/CD-3)

Patrón env-getter nunca-throw (espejo de `getArbiterAutoCapUsd`), en `arbiter-executor.ts`:

```ts
const ARBITER_NONCE_SECRET_MIN_LEN = 32;

/**
 * Lee ARBITER_NONCE_SECRET. undefined/''/whitespace o < 32 chars → null (fail-closed, AC-3).
 * Nunca lanza. NUNCA loguea el valor (CD-2): solo flags booleanos present/weak.
 */
export function getArbiterNonceSecret(): string | null {
  const raw = process.env.ARBITER_NONCE_SECRET;
  if (raw === undefined || raw.trim() === '') {
    log.warn({ present: false }, 'ARBITER_NONCE_SECRET ausente; arbiter cae a operator-custodial');
    return null;
  }
  const secret = raw.trim();
  if (secret.length < ARBITER_NONCE_SECRET_MIN_LEN) {
    log.warn({ present: true, weak: true }, 'ARBITER_NONCE_SECRET débil (<32 chars); fallback fail-closed');
    return null;
  }
  return secret;
}
```

> **CD-2 crítico**: en NINGÚN `log.*` puede aparecer `raw`/`secret`/`.length` real como valor loggeable que revele
> el secreto. Solo booleanos.

### 7-C · Export de la razón de colisión (W1.1 — AC-7)

```ts
/** Razón canónica de colisión de nonce (comparación sin magic-string en arbiter.ts). */
export const ARBITER_NONCE_COLLISION_REASON = 'NONCE_ALREADY_USED';
```

### 7-D · Entrada `error` en `ESCROW_ABI` (W1.2 — habilita el decode de AC-7)

Agregar al array `ESCROW_ABI` de `abi.ts` (byte-a-byte con el ABI compilado; no reordenar lo existente):

```ts
  // ── 194: custom error decodable por simulateContract (anti-griefing) ──
  {
    type: 'error',
    name: 'NonceAlreadyUsed',
    inputs: [],
  },
```

### 7-E · `getOrCreateArbiterNonce` en `arbiter.ts` (W2.1 — AC-1/AC-2/CD-1/CD-OWNERSHIP)

Read-first owner-guarded → miss → compute+RPC. Nunca-throw money-safe (error → `null` → fallback):

```ts
/**
 * Nonce del árbitro exactly-once (WKH-194). Read-first (CD-1): si ya hay un nonce
 * persistido para el intentId → lo devuelve SIN recomputar deriveArbiterNonce (AC-2).
 * Miss → secreto (AC-3, null si ausente/débil) → deriva → RPC first-writer-wins → ganador.
 * Devuelve null ante secreto ausente/débil o fallo de persistencia → el caller cae a
 * operator-custodial (fail-closed, money-safe). Ownership Guard (WKH-53).
 */
async function getOrCreateArbiterNonce(
  intentId: string,
  ownerRef: string,
  keyIdHash: string,
): Promise<bigint | null> {
  // 1. Read-first owner-guarded (CD-1/CD-OWNERSHIP): si existe, NO recomputar.
  const { data: existing } = await supabase
    .from('a2a_arbiter_nonces')
    .select('nonce')
    .eq('intent_id', intentId)
    .eq('owner_ref', ownerRef)
    .maybeSingle();
  if (existing?.nonce != null) return BigInt(String(existing.nonce));

  // 2. Miss → secreto (AC-3). null → fallback (NO fórmula pública, CD-3).
  const secret = getArbiterNonceSecret();
  if (secret === null) return null;

  // 3. Deriva el candidate (pura dado el secreto).
  const candidate = deriveArbiterNonce(keyIdHash, intentId, secret);

  // 4. RPC first-writer-wins (DT-3). Error/no-row → null (money-safe → fallback).
  try {
    const { data, error } = await supabase.rpc('get_or_create_arbiter_nonce', {
      p_intent_id: intentId,
      p_owner_ref: ownerRef,
      p_key_id_hash: keyIdHash,
      p_nonce: candidate.toString(),
    });
    if (error) {
      log.error({ intentId, detail: error.message }, 'get_or_create_arbiter_nonce failed → fallback');
      return null;
    }
    const persisted = (data as { persisted_nonce: string }[] | null)?.[0]?.persisted_nonce;
    if (persisted == null) {
      log.error({ intentId }, 'get_or_create_arbiter_nonce devolvió sin fila → fallback');
      return null;
    }
    return BigInt(String(persisted)); // el GANADOR atómico
  } catch (err) {
    log.error({ intentId, detail: err instanceof Error ? err.message : String(err) }, 'arbiter nonce persist threw → fallback');
    return null;
  }
}
```

> **Ownership Guard**: el `.eq('owner_ref', ownerRef)` del read-first + el owner-check del RPC = doble capa (app + DB).
> NO uses `mapArbPgError` acá (lanzaría): en este seam el error DEBE degradar a `null`/fallback, no propagar.

### 7-F · Wire en `settleArbitrationOnChain` (W2.1 — reemplaza `:130`)

Reemplazar la línea 130 `const nonce = deriveArbiterNonce(keyIdHash, intentId);` por:

```ts
    const nonce = await getOrCreateArbiterNonce(intentId, ownerRef, keyIdHash);
    if (nonce === null) return settlePaymentIntentOnChain(base); // AC-3: secreto ausente/débil o persist falló → fallback
```

Se ubica DESPUÉS del check `decimals == null` (`:128`) y ANTES de `executeResolveDispute` (`:133`). El resto de la
cascada (`:133-160`) y el `catch` (`:161-164`) quedan byte-idénticos. `ownerRef` ya está destructurado en `:107`.

### 7-G · Diagnóstico post-mortem en `executeResolveDispute` (W2.2 — AC-7/CD-5)

SOLO dentro de la rama de revert existente (`:306-308`). El happy path queda intacto:

```ts
  if (receipt.status !== 'success') {
    // WKH-194: best-effort — ¿el revert fue por colisión de nonce (pre-consumo/griefing)?
    // El simulate corre a estado 'latest' donde el nonce YA está consumido → reproduce NonceAlreadyUsed.
    // Cualquier fallo del simulate / otra causa → 'REVERTED' (conservador, comportamiento de hoy). Nunca lanza.
    try {
      await publicClient.simulateContract({
        address: escrowContract,
        abi: ESCROW_ABI,
        functionName: 'resolveDispute',
        args: [keyIdHash as `0x${string}`, seller as `0x${string}`, sellerAmount, nonce],
        account: wallet.account ?? undefined,
      });
    } catch (simErr) {
      if (
        simErr instanceof BaseError &&
        simErr.walk((e) => e instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError
      ) {
        const revert = simErr.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError;
        if (revert.data?.errorName === 'NonceAlreadyUsed') {
          return { kind: 'not_moved', reason: ARBITER_NONCE_COLLISION_REASON, txHash };
        }
      }
    }
    return { kind: 'not_moved', reason: 'REVERTED', txHash };
  }
```

- Importar de `viem`: `BaseError`, `ContractFunctionRevertedError` (verificá que existan como export antes de tsc — CD-AB-1).
- `ARBITER_NONCE_COLLISION_REASON` es local al mismo archivo (definido en §7-C).
- Si el simulate no lanza (raro: nonce liberado entre la tx y el simulate) → cae a `'REVERTED'`. Nunca `confirmed`.

### 7-H · Defensa en profundidad en `executeArbitration` (W2.3 — AC-7)

Insertar JUSTO ANTES del `if (settle.failureKind === 'unequivocal')` de `:767`:

```ts
    // WKH-194: colisión de nonce (pre-consumo/griefing) → NO auto-refundar (premiaría el ataque).
    // Misma SEMÁNTICA no-refund que la rama ambiguous (terminal probado), con causa desambiguada para el reconcile.
    if (
      settle.failureKind === 'unequivocal' &&
      settle.error === ARBITER_NONCE_COLLISION_REASON
    ) {
      const collisionErr = 'RECONCILE: NONCE_COLLISION (posible pre-consumo/griefing) — revisión manual';
      log.warn({ intentId, detail: settle.error }, 'arbitration nonce collision: deposit NO reembolsado, reconcile manual');
      await recordSettleOutcome(intentId, ownerRef, 'failed_ambiguous', null, null, collisionErr);
      const okCol = await finalizePaymentIntent(intentId, ownerRef, null, arbUsd, null, 'failed_ambiguous', collisionErr);
      if (!okCol) throw new ArbiterError('INTERNAL');
      await this.emitAndRecord(intentId, ownerRef, meta, arbUsd, null, row);
      return this.outcome(meta, arbUsd, 0, 'executed', null); // residual 0 → NO refund
    }
```

- `ARBITER_NONCE_COLLISION_REASON` viene del import de `arbiter-executor.js` (agregarlo al import de `:24`).
- `residual = null` en finalize + `outcome(..., 0, ...)` → el buyer NO recupera el deposit (queda para revisión humana).
- El resto de la rama `unequivocal` (para reverts NO-colisión) queda byte-idéntico → sigue refundando completo.

---

## 8. Tests requeridos (9, ≥1 por AC — archivo/setup exactos)

> Antes de agregar casos, **arreglar las llamadas 2-arg que rompen** (3er arg ahora requerido):
> `arbiter-executor.test.ts:62,489,494,495,500,501,502,508` y `arbiter.test.ts:1356`. Definí un
> `const TEST_SECRET = 'x'.repeat(64);` en cada archivo y pasalo como 3er arg.

### En `arbiter-executor.test.ts` (extender el `describe('deriveArbiterNonce …')` de `:487`)

- **T1 · bit-255 con secreto (AC-4)**: `const n = deriveArbiterNonce(KEY_ID_HASH, 'intent-1', TEST_SECRET);`
  → `expect((n >> 255n) & 1n).toBe(1n)` y `expect(n >= 2n ** 255n).toBe(true)`.
- **T2 · no-re-derivable / pura (AC-5/CD-2)**: mismo secreto+inputs → mismo nonce
  (`deriveArbiterNonce(kh,id,s) === deriveArbiterNonce(kh,id,s)`); secreto DISTINTO (mismos inputs) → nonce distinto
  (`deriveArbiterNonce(kh,id,'a'.repeat(64)) !== deriveArbiterNonce(kh,id,'b'.repeat(64))`).
- **T3 · secreto ausente/débil (AC-3/CD-3)**: `getArbiterNonceSecret()` con `ARBITER_NONCE_SECRET` unset/`''`/`'   '`/`'short'` (<32)
  → `null`; con ≥32 chars → devuelve el string. Verificar (spy sobre `logSpy.warn`) que NUNCA se loguea el valor
  (el arg de `warn` solo contiene `present`/`weak` booleanos). Restaurar `process.env` en `afterEach`.
- **T7 · diagnóstico colisión (AC-7)**: montar `executeResolveDispute` con receipt `status:'reverted'` y mock de
  `publicClient.simulateContract` que arroja: (a) un error que `walk` resuelve a `ContractFunctionRevertedError`
  con `data.errorName === 'NonceAlreadyUsed'` → `reason === ARBITER_NONCE_COLLISION_REASON`; (b) otro revert
  (errorName distinto) → `'REVERTED'`; (c) simulate que rechaza con error genérico (RPC down) → `'REVERTED'`.
  Nunca lanza. Seguir el patrón de mock de `publicClient` ya usado en la suite (`getArbiterPublicClient`).

### En `arbiter.test.ts` (extender handlers/fromImpl + nuevos `describe`)

> **Setup**: extender `handlers` (`:222`) con `get_or_create_arbiter_nonce: (args) => ({ data: [{ persisted_nonce: String(args.p_nonce) }], error: null })`
> y `fromImpl`/`maybeSingle` (`:355`) para la tabla `a2a_arbiter_nonces` (por defecto miss → `{ data: null }`).
> Para los tests con flag ON: `process.env.ESCROW_ARBITER_ENABLED='true'` + `mockReadConsent.mockResolvedValue(true)`
> + `mockResolveEscrow.mockReturnValue(ESCROW_ADDR)` + `process.env.ARBITER_NONCE_SECRET='x'.repeat(64)`.
> Restaurar env en `afterEach`. Evidencia con `makeEvidence({ consumedUsd, voucherCount, vouchersTotalUsd })` (CD-AB-3).

- **T4 · exactly-once persistencia (AC-1/AC-2/CD-1)**: 1ª call → miss (fromImpl `a2a_arbiter_nonces` null) → computa+persiste
  (RPC devuelve el candidate). 2ª call → fromImpl `a2a_arbiter_nonces` devuelve el persistido → **spy sobre `deriveArbiterNonce`
  NO se invoca** aunque se cambie `process.env.ARBITER_NONCE_SECRET` entre calls; mismo nonce. (Spiar `deriveArbiterNonce`:
  como se importa REAL en `:104`, usar `vi.spyOn` sobre el módulo, o assertar que el RPC `get_or_create_arbiter_nonce`
  NO se llamó en la 2ª pasada.)
- **T5 · fallback secreto→operator-custodial (AC-3/CD-3/CD-5)**: flag ON + consent true + decimals OK pero
  `ARBITER_NONCE_SECRET` unset → `settleArbitrationOnChain` devuelve el resultado de `settlePaymentIntentOnChain`
  (custodial); `mockExecResolve` (executeResolveDispute) **NO invocado**.
- **T6 · flag OFF inerte (AC-6/CD-5)**: `ESCROW_ARBITER_ENABLED` unset → path custodial byte-idéntico;
  el RPC `get_or_create_arbiter_nonce` **NO llamado** y el `from('a2a_arbiter_nonces')` **NO consultado**.
- **T8 · defensa no-refund (AC-7)**: `mockExecResolve.mockResolvedValue({ kind:'not_moved', reason:'NONCE_ALREADY_USED' })`
  → `settleArbitrationOnChain` da `failureKind:'unequivocal'`, `error:'NONCE_ALREADY_USED'` → `executeArbitration`
  finaliza `'failed_ambiguous'` (NO `failed_unequivocal`), `db.refunds` **vacío** (`expect(db.refunds).toEqual([])`),
  `db.row.settle_outcome === 'failed_ambiguous'`, `error_message` contiene `RECONCILE: NONCE_COLLISION`. Contraste:
  un `not_moved` con `reason:'REVERTED'` (NO colisión) → sigue `failed_unequivocal` con `db.refunds` = deposit completo
  (byte-idéntico al comportamiento de hoy).
- **T9 · atomicidad first-writer (AC-1/DT-3)**: el handler `get_or_create_arbiter_nonce` devuelve el `persisted_nonce`
  (aunque `p_nonce` difiera de un valor pre-existente simulado) → `getOrCreateArbiterNonce` usa SIEMPRE el
  `persisted_nonce` del RPC, no el candidate local.

**Verificación W3.3**: `npx tsc --noEmit` + `npx biome check src/` + `npx vitest run` — todo verde.

---

## 9. Done Definition

- [ ] W0: migración `20260713000003_wkh194_arbiter_nonces.sql` + `_down.sql` creadas (tabla + RPC SECURITY DEFINER
      owner-guarded + RLS + REVOKE/GRANT + `search_path` fijado); down reversible (DROP FUNCTION + DROP TABLE).
- [ ] W1: `deriveArbiterNonce(keyIdHash, intentId, secret)` (3er arg, pura, bit-255 intacto) + `getArbiterNonceSecret()`
      (nunca-throw, ≥32 chars, ausente/débil → null, NUNCA loguea el valor) + `ARBITER_NONCE_COLLISION_REASON` exportado +
      entrada `error NonceAlreadyUsed` en `ESCROW_ABI` + `.env.example` documentado.
- [ ] W2: `getOrCreateArbiterNonce` (read-first owner-guarded → miss → compute+RPC, null-fallback) + wire en
      `settleArbitrationOnChain:130` (con fallback null → operator-custodial) + diagnóstico post-mortem `NonceAlreadyUsed`
      en `executeResolveDispute` (happy-path byte-idéntico) + defensa AC-7 en `executeArbitration:767` (no auto-refund,
      `failed_ambiguous`/RECONCILE).
- [ ] W3: los 9 tests (T1–T9) verdes + fix de las llamadas 2-arg + `tsc --noEmit` + `biome check` + `vitest run` verde total.
- [ ] Ningún archivo fuera del Scope IN modificado. `contracts/**` intacto. `a2a_arbitrations` y su timing intactos.
- [ ] CD-2 auditado: el secreto NO aparece en ningún log/telemetría/recibo/respuesta.
- [ ] Comportamiento con flag OFF / sin escrow / consent false / happy path del executor: byte-idéntico a 191g.

---

*Story File generado por NexusAgil — FULL · WKH-194. El Dev implementa wave por wave (W0→W1→W2→W3). No saltear el read-first.*
