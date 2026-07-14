# SDD #194: Contra-medida del nonce del árbitro (cierra griefing MNR-1/R-3)

> SPEC_APPROVED: no
> Fecha: 2026-07-13
> Tipo: feature/security/billing
> SDD_MODE: full
> Branch: fix/194-arbiter-nonce-anti-griefing
> Artefactos: doc/sdd/180-wkh-194-arbiter-nonce-anti-griefing/
> Work Item: doc/sdd/180-wkh-194-arbiter-nonce-anti-griefing/work-item.md

---

## 1. Resumen

`deriveArbiterNonce` (`src/adapters/escrow/arbiter-executor.ts:72-83`) deriva el `nonce` de
`resolveDispute` de forma **determinista y pública**: `(1<<255) | (keccak256(dom, keyIdHash,
intentId) & LOW_MASK)`. Como `keyId`+`intentId` son conocidos por el buyer desde que abre el intent,
y el `nonce` de `debit()` es **elegido libremente por el cliente** (`debit-capture.ts:39-44,176-188`)
sobre el MISMO mapping `_usedNonces[keyId][nonce]` que `resolveDispute`
(`WasiAIEscrow.sol:55,170,276,282`), un buyer puede **pre-consumir** el nonce del árbitro vía una
`DebitAuthorization` propia ANTES de que exista disputa. Cuando el árbitro on-chain se active
(post-191h + consent WKH-193) e intente pagar al seller, `resolveDispute` revierte `NonceAlreadyUsed`
→ `not_moved` → rama `unequivocal` (`arbiter.ts:767-795`) → **refund COMPLETO al buyer, el seller
ganador cobra CERO** (denegación de valor).

Esta HU cierra el vector con **Opción A (app-only, DT-1)**: (1) incorpora un secreto server-side
`ARBITER_NONCE_SECRET` al digest → el nonce deja de ser re-derivable por el buyer; (2) **persiste el
nonce por `intentId`** en una tabla nueva `a2a_arbiter_nonces` con get-or-create atómico → exactly-once
REAL independiente de la estabilidad del secreto (retry/recovery leen el persistido, nunca recomputan);
(3) **defensa en profundidad**: si aun así `resolveDispute` cae `NonceAlreadyUsed`, NO se auto-refunda
al buyer → se rutea a manual reconcile/HOLD (no-refund, revisión humana) — eliminando el premio del
griefing. Cero cambios de Solidity. El bit-255 disjunto de 191g se preserva como higiene adicional.
Todo inerte con `ESCROW_ARBITER_ENABLED` OFF (default).

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 194 (WKH-194) |
| **Tipo** | feature/security/billing |
| **SDD_MODE** | full |
| **Objetivo** | Hacer el nonce de `resolveDispute` no-pre-consumible por el buyer (secreto server-side) + exactly-once vía persistencia + defensa en profundidad no-refund ante colisión de nonce. |
| **Reglas de negocio** | Exactly-once inmutable por `intentId`; secreto nunca expuesto; fallback fail-closed byte-idéntico si falta el secreto; testnet-only; sin tocar `contracts/`. |
| **Scope IN** | `arbiter-executor.ts` (`deriveArbiterNonce` con secreto + `getArbiterNonceSecret` + diagnóstico `NONCE_ALREADY_USED` en `executeResolveDispute`), `arbiter.ts` (`getOrCreateArbiterNonce` + wire + rama defensa-en-profundidad), migración nueva `a2a_arbiter_nonces` + RPC, env var, tests. |
| **Scope OUT** | `contracts/` (Opción B), deploy/upgrade (191h), captura de consent (WKH-193), rotación operativa del secreto, mainnet, `a2a_arbitrations` timing. |
| **Missing Inputs** | Resueltos en §10 (persistencia = tabla dedicada; atomicidad = read-first + RPC UPSERT; entropía secreto ≥32 bytes). Rotación = `[TBD no bloqueante]` documentado. |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1**: WHEN se necesita el nonce para un `intentId` SIN nonce persistido, THE system SHALL derivarlo incorporando `ARBITER_NONCE_SECRET` (nunca en logs/telemetría/recibos) junto a `keyIdHash`+`intentId`, y SHALL persistirlo ANTES de invocar `resolveDispute`.
- **AC-2**: WHEN se necesita el nonce para un `intentId` que YA tiene nonce persistido (retry/recovery/reintento), THE system SHALL reusar EXACTAMENTE ese valor y SHALL NOT recomputar `deriveArbiterNonce`.
- **AC-3**: IF `ARBITER_NONCE_SECRET` ausente/vacío/insuficiente WHILE `ESCROW_ARBITER_ENABLED=true`, THEN THE system SHALL caer al path operator-custodial (`settlePaymentIntentOnChain`) sin invocar `onlyArbiter`, y SHALL NOT usar una fórmula de nonce basada solo en datos públicos como fallback.
- **AC-4** (ubiquitous): THE system SHALL mantener el bit 255 SIEMPRE seteado en el nonce derivado (namespace disjunto de `debit()`), ADEMÁS del secreto (el secreto se agrega al digest, no reemplaza la estructura).
- **AC-5** (unwanted): IF un actor sin `ARBITER_NONCE_SECRET` intenta pre-consumir el nonce del árbitro con un nonce elegido, THEN la probabilidad de coincidencia SHALL ser criptográficamente insignificante (~255 bits sin el secreto).
- **AC-6** (no-break): THE system SHALL preservar byte-idéntico las otras patas del gate de 191g (`ESCROW_ARBITER_ENABLED` OFF, sin escrow, o `arbitrationConsent===false`) — aditivo solo sobre cálculo/persistencia del nonce.
- **AC-7** (defensa en profundidad, incluido por decisión F2): IF `resolveDispute` revierte por colisión de nonce (`NonceAlreadyUsed`) y el settle del árbitro cae `unequivocal` por esa causa, THEN THE system SHALL NOT auto-refundar el deposit completo al buyer, y SHALL rutear a manual reconcile/HOLD (no-refund, revisión humana).

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón/hallazgo extraído |
|---------|---------|--------------------------|
| `src/adapters/escrow/arbiter-executor.ts:60-83` | función a modificar | `deriveArbiterNonce(keyIdHash, intentId): bigint` pura; `ARBITER_NONCE_FLAG=1n<<255n`, `ARBITER_NONCE_LOW_MASK=(1n<<255n)-1n`; digest `keccak256(encodePacked(['string','bytes32','string'], ['WasiAIEscrow.arbiter-dispute.v1', keyIdHash, intentId]))`. |
| `src/adapters/escrow/arbiter-executor.ts:252-343` | `executeResolveDispute` — diagnóstico de causa | `receipt.status !== 'success'` → `{ kind:'not_moved', reason:'REVERTED', txHash }` genérico — HOY NO distingue `NonceAlreadyUsed` de otros reverts. Nunca lanza. `ESCROW_ABI` ya importado. |
| `src/services/arbiter.ts:99-165` | único call-site (`settleArbitrationOnChain`, línea 130) | Cascada de gates en cascada; nonce calculado FRESCO en cada invocación; `SettleOutcome` con `failureKind:'unequivocal'|'ambiguous'` + `error:o.reason`. Fallback en cada gate + `catch` → `settlePaymentIntentOnChain(base)`. |
| `src/services/arbiter.ts:662-824` | `executeArbitration` — ramas settle/refund | Rama `unequivocal` (767-795) refunda deposit COMPLETO (`finalize 'failed_unequivocal'`); rama `ambiguous` (798-823) NO refunda (`finalize 'failed_ambiguous'`, residual 0, prefijo `RECONCILE:`, warn "reconciliación manual"). |
| `contracts/src/WasiAIEscrow.sol:55,170,180,262-288` | mapping compartido + revert | `_usedNonces[keyId][nonce]` compartido literal entre `debit()`/`debitBatch()` y `resolveDispute()`; `if (_usedNonces[keyId][nonce]) revert NonceAlreadyUsed();` (:276), CEI estricto, paga al `seller` (param). SOLO lectura — NO se toca (CD-4). |
| `src/services/reconciliation.ts:1-70,376-394` | modelo `reconciliation_pending` (191c) | Estado terminal `reconciliation_pending`/`failed_ambiguous` = bucket de revisión manual no-refund; idempotencia vía state-machine DB, NO vía nonce. `ReconciliationError` disclosure-safe. Motor separado (opera sobre debit-signatures, NO sobre intents del árbitro). |
| `supabase/migrations/20260713000000_wkh191a_debit_signatures.sql` | exemplar tabla + RPC | Tabla sibling + `owner_ref` (Ownership Guard), índice único parcial anti-replay del nonce, RPC `SECURITY DEFINER` owner-guarded (`SELECT owner_ref … FOR UPDATE` + check), `ALTER FUNCTION … SET search_path`, `REVOKE … FROM PUBLIC,anon,authenticated` + `GRANT … TO service_role`, RLS deny-by-default. |
| `supabase/migrations/20260713000001_wkh191b_debit_hop1.sql` (+ `_down`) | exemplar RPC get-or-persist idempotente | `record_debit_hop1`: `COALESCE`/first-writer-wins idempotente; `RETURNS TABLE(...)`; down dropea funciones + índices + columnas aditivas. |
| `src/adapters/escrow/arbiter-executor.test.ts:486-514` | exemplar de tests de `deriveArbiterNonce` | `describe('deriveArbiterNonce …')`: bit-255, determinismo, disjunción, rango. Extender con casos de secreto. |
| `.env.example:313-319` | bloque árbitro | Documentación fail-closed de `ARBITER_ENABLED`/`ARBITER_AUTO_CAP_USD`. `ESCROW_ARBITER_ENABLED`/`ARBITER_PRIVATE_KEY` NO están hoy en `.env.example` — agregar `ARBITER_NONCE_SECRET` en el mismo bloque. |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|----------------------|------------------|-------|
| `supabase/migrations/20260713000003_wkh194_arbiter_nonces.sql` | `20260713000000_wkh191a_debit_signatures.sql` | tabla sibling owner-guarded + RPC SECURITY DEFINER + RLS + grants. |
| RPC `get_or_create_arbiter_nonce` | `record_debit_hop1` (`20260713000001_wkh191b_debit_hop1.sql`) | owner-guard `SELECT … FOR UPDATE` + first-writer-wins idempotente + `RETURNS TABLE`. |
| `_down.sql` | `20260713000001_wkh191b_debit_hop1_down.sql` | DROP FUNCTION + DROP TABLE (aditivo, sin destruir datos de otras HUs). |
| `getOrCreateArbiterNonce` en `arbiter.ts` | `record_debit_hop1` wire (patrón `supabase.rpc` + `mapArbPgError`) | mismo estilo de service RPC-caller owner-guarded del propio `arbiter.ts`. |
| Tests `deriveArbiterNonce` con secreto | `arbiter-executor.test.ts:486-514` | extender el `describe` existente. |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `a2a_payment_intents` | Sí | `id`, `owner_ref` (para el owner-guard del RPC). |
| `a2a_arbitrations` | Sí | NO se toca (DT-2: se escribe DESPUÉS del desenlace; el nonce se necesita ANTES). |
| `a2a_arbiter_nonces` | **No — se crea** | `intent_id PK`, `owner_ref`, `key_id_hash`, `nonce NUMERIC(78,0)`, `created_at`. |

### Componentes reutilizables encontrados

- `mapArbPgError` (`arbiter.ts:266`) — mapeo error-crudo→`ArbiterError` disclosure-safe. Reutilizar en `getOrCreateArbiterNonce`.
- Rama `ambiguous` (`arbiter.ts:798-823`) — handling no-refund + `RECONCILE:` + warn. Reutilizar su SEMÁNTICA (no su etiqueta literal) para la defensa en profundidad AC-7.
- `ESCROW_ABI` (ya importado en `arbiter-executor.ts:41`) — decodificar la custom error `NonceAlreadyUsed`.

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué hace | Exemplar |
|---------|--------|----------|----------|
| `supabase/migrations/20260713000003_wkh194_arbiter_nonces.sql` | Crear | Tabla `a2a_arbiter_nonces` + RPC `get_or_create_arbiter_nonce` + RLS + grants. | `20260713000000_wkh191a_debit_signatures.sql` |
| `supabase/migrations/20260713000003_wkh194_arbiter_nonces_down.sql` | Crear | DROP FUNCTION + DROP TABLE (aditivo). | `20260713000001_wkh191b_debit_hop1_down.sql` |
| `src/adapters/escrow/arbiter-executor.ts` | Modificar | `deriveArbiterNonce(keyIdHash, intentId, secret)` (3er arg, pura); `getArbiterNonceSecret(): string \| null` (env, nunca-throw, entropía mínima); diagnóstico post-mortem `NONCE_ALREADY_USED` en `executeResolveDispute`; export `ARBITER_NONCE_COLLISION_REASON`. | patrón `resolveMinConfirmations`/env-getters del proyecto |
| `src/services/arbiter.ts` | Modificar | `getOrCreateArbiterNonce(intentId, ownerRef, keyIdHash): Promise<bigint\|null>` (read-first + RPC); wire en `settleArbitrationOnChain` (reemplaza línea 130); rama defensa-en-profundidad en `executeArbitration` (767). | `record_debit_hop1` wire |
| `src/adapters/escrow/arbiter-executor.test.ts` | Modificar | Tests de `deriveArbiterNonce`/`getArbiterNonceSecret`/diagnóstico. | `arbiter-executor.test.ts:486-514` |
| `src/services/arbiter.test.ts` | Modificar | Tests de `getOrCreateArbiterNonce` (persistencia/exactly-once/fallback) + defensa-en-profundidad. | tests existentes de `settleArbitrationOnChain` |
| `.env.example` | Modificar | Documentar `ARBITER_NONCE_SECRET` (fail-closed) en el bloque árbitro. | `.env.example:313-319` |

### 4.2 Modelo de datos

Tabla nueva (aditiva 100%, no toca ninguna tabla/RPC existente):

```
CREATE TABLE IF NOT EXISTS a2a_arbiter_nonces (
  intent_id   UUID PRIMARY KEY REFERENCES a2a_payment_intents(id) ON DELETE CASCADE,
  owner_ref   TEXT NOT NULL,           -- Ownership Guard (WKH-53)
  key_id_hash TEXT NOT NULL,           -- keccak256(stringToBytes(key_id)) — auditoría
  nonce       NUMERIC(78,0) NOT NULL,  -- uint256 disjunto (bit-255) — persistido, inmutable
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_arbiter_nonces_owner ON a2a_arbiter_nonces (owner_ref);
ALTER TABLE a2a_arbiter_nonces ENABLE ROW LEVEL SECURITY;
```

- **`intent_id` como PK** → una única fila (un único nonce inmutable) por intent + target natural de `ON CONFLICT` (DT-3).
- `NUMERIC(78,0)` = uint256 (mismo tipo que `debit_nonce` de 191a). En TS el `bigint` viaja como string (`.toString()`) y vuelve como string → `BigInt(...)`.
- RLS deny-by-default; el cliente `SUPABASE_SERVICE_KEY` bypassa por BYPASSRLS; el guard real es app-layer + el owner-check del RPC.

RPC `get_or_create_arbiter_nonce(p_intent_id uuid, p_owner_ref text, p_key_id_hash text, p_nonce numeric) RETURNS TABLE(persisted_nonce numeric)` — `SECURITY DEFINER`, atómico first-writer-wins:

1. `SELECT owner_ref FROM a2a_payment_intents WHERE id=p_intent_id FOR UPDATE;` → `INTENT_NOT_FOUND` / `OWNERSHIP_MISMATCH` (espejo `record_debit_hop1`).
2. `INSERT INTO a2a_arbiter_nonces (...) VALUES (...) ON CONFLICT (intent_id) DO NOTHING;` (el primer writer gana; un segundo writer no-op).
3. `SELECT nonce INTO v_nonce FROM a2a_arbiter_nonces WHERE intent_id=p_intent_id;` (devuelve el valor GANADOR, recién insertado o pre-existente).
4. `persisted_nonce := v_nonce; RETURN NEXT;`

`ALTER FUNCTION … SET search_path = public, pg_temp;` + `REVOKE … FROM PUBLIC,anon,authenticated;` + `GRANT … TO service_role;`.

### 4.3 Componentes / Servicios

**(a) `deriveArbiterNonce` — nonce no-re-derivable (AC-4/AC-5/CD-2):**

Firma nueva `deriveArbiterNonce(keyIdHash: string, intentId: string, secret: string): bigint`. El
secreto se INCORPORA al digest existente (DT-4, no lo reemplaza):

```
digest = keccak256(encodePacked(
  ['string', 'bytes32', 'string', 'string'],
  ['WasiAIEscrow.arbiter-dispute.v1', keyIdHash, intentId, secret]))
return ARBITER_NONCE_FLAG | (BigInt(digest) & ARBITER_NONCE_LOW_MASK)   // bit-255 intacto (AC-4)
```

- **Pura dado el secreto** (testeable: mismo secreto+inputs → mismo nonce; secreto distinto → distinto).
- Byte-compatible con el contrato: sigue siendo un `uint256` en `[2^255, 2^256)`.
- El secreto se pasa como PARÁMETRO (no lee env adentro) → pureza + testabilidad; el reading vive en `getArbiterNonceSecret`.

**(b) `getArbiterNonceSecret(): string | null` (AC-3/CD-2/CD-3):**

- Lee `process.env.ARBITER_NONCE_SECRET`. `undefined`/`''`/solo-whitespace → `null`.
- **Entropía mínima**: exige `>= 32` caracteres (recomendado ≥64 hex = 32 bytes, generado con `openssl rand -hex 32`). Por debajo del mínimo → `null` + `log.warn` **sin exponer el valor** (solo un flag booleano `present:false`/`weak:true`, JAMÁS el secreto).
- Nunca lanza. `null` = señal de fallback (AC-3). PROHIBIDO fallback a fórmula pública (CD-3).

**(c) `getOrCreateArbiterNonce(intentId, ownerRef, keyIdHash): Promise<bigint | null>` en `arbiter.ts` (AC-1/AC-2/CD-1):**

Read-first (para NO recomputar `deriveArbiterNonce` cuando ya existe persistido — CD-1):

1. `SELECT nonce FROM a2a_arbiter_nonces WHERE intent_id=? AND owner_ref=?` (owner-guarded, WKH-53). Si hay fila → `return BigInt(nonce)` **sin computar** (AC-2, CD-1).
2. Miss → `const secret = getArbiterNonceSecret();` — `null` → `return null` (AC-3).
3. `const candidate = deriveArbiterNonce(keyIdHash, intentId, secret);`
4. `supabase.rpc('get_or_create_arbiter_nonce', { p_intent_id, p_owner_ref, p_key_id_hash: keyIdHash, p_nonce: candidate.toString() })`. Error/no-row → `mapArbPgError`/`log`+`return null` (money-safe → fallback).
5. `return BigInt(persisted_nonce)` (el GANADOR atómico; si dos writers concurrentes, ON CONFLICT DO NOTHING garantiza un único valor).

Exactly-once REAL: aunque el secreto cambie entre invocaciones, el step 1 devuelve el persistido y el candidate (step 3) nunca se ejecuta en el retry. En el rarísimo caso de dos primeros-writers concurrentes con secreto estable, ambos candidates son idénticos (determinismo); con secreto rotado mid-flight, el primer INSERT gana y el RPC RETURNs el ganador a ambos.

**(d) Wire en `settleArbitrationOnChain` (`arbiter.ts:125-131`):**

Reemplazar `const nonce = deriveArbiterNonce(keyIdHash, intentId);` por:

```
const nonce = await getOrCreateArbiterNonce(intentId, ownerRef, keyIdHash);
if (nonce === null) return settlePaymentIntentOnChain(base);   // AC-3: secreto ausente/débil o persist falló → fallback fail-closed
```

Se ubica DESPUÉS del check de `decimals` (línea 128) y ANTES de `executeResolveDispute`. El resto de la cascada y el `catch` final quedan byte-idénticos (AC-6/CD-5).

**(e) Diagnóstico `NONCE_ALREADY_USED` en `executeResolveDispute` (defensa en profundidad, AC-7):**

Enfoque **post-mortem** (happy-path byte-idéntico, CD-5): SOLO cuando `receipt.status !== 'success'`
(rama de revert ya existente, línea 306-308), best-effort `publicClient.simulateContract({...mismos
args})` para decodificar la custom error contra `ESCROW_ABI`:

- Si el error decodificado es `errorName === 'NonceAlreadyUsed'` → `return { kind:'not_moved', reason: ARBITER_NONCE_COLLISION_REASON, txHash }`.
- Cualquier otra causa / RPC no disponible / no decodificable → `return { kind:'not_moved', reason:'REVERTED', txHash }` (comportamiento de hoy, conservador).
- Nunca lanza. El simulate se ejecuta a estado "latest" donde el nonce YA está consumido → reproduce fielmente `NonceAlreadyUsed`. El happy path (`confirmed`) y las demás ramas (`ambiguous`/timeout/write-fail) quedan intactos.

Export `export const ARBITER_NONCE_COLLISION_REASON = 'NONCE_ALREADY_USED';` para que `arbiter.ts`
compare sin magic-string.

> **Alternativa descartada**: pre-flight `simulateContract` antes de `writeContract`. Extrae la causa
> más limpio y ahorra una tx condenada, PERO altera el happy path del executor (money-path DONE/AR-aprobado)
> → viola la preferencia byte-idéntica de CD-5. El post-mortem no toca la ruta de éxito.

**(f) Defensa en profundidad en `executeArbitration` (`arbiter.ts:767`, AC-7):**

Antes de la rama `unequivocal` de auto-refund, interceptar la colisión de nonce:

```
if (settle.failureKind === 'unequivocal' && settle.error === ARBITER_NONCE_COLLISION_REASON) {
  // Nonce pre-consumido (griefing): el settle NO movió, pero auto-refundar premiaría el ataque.
  // → no-refund + manual reconcile (misma SEMÁNTICA que la rama ambiguous, NO su etiqueta literal).
  recordSettleOutcome(..., 'failed_ambiguous', null, null, 'RECONCILE: NONCE_COLLISION (posible pre-consumo/griefing) — revisión manual')
  finalize(..., 'failed_ambiguous', 'RECONCILE: NONCE_COLLISION …')   // residual null → NO refunda budget
  emitAndRecord(...)
  return outcome(meta, arbUsd, 0, 'executed', null)                    // residual 0
}
```

Se persiste como `failed_ambiguous` reutilizando el terminal PROBADO no-refund (el árbitro NO devuelve
el deposit; queda para revisión humana / reconcile). El `RECONCILE: NONCE_COLLISION …` en el mensaje
desambigua la causa REAL para el revisor (a diferencia del ambiguous genuino "el transfer PUDO ocurrir").
El resto de la rama `unequivocal` (para reverts NO-colisión) queda byte-idéntico.

### 4.4 Flujo principal (Happy Path)

1. Árbitro decide `release`/`split` (`arbUsd>0`) → `settleArbitrationOnChain`.
2. Gates (flag/escrow/consent/decimals) OK → `getOrCreateArbiterNonce(intentId, ownerRef, keyIdHash)`.
3. Sin nonce persistido → `getArbiterNonceSecret()` OK → `deriveArbiterNonce(…, secret)` → RPC persiste atómicamente → devuelve el nonce.
4. `executeResolveDispute(..., nonce)` → `DisputeResolved` → `settled` → `finalize 'settled'` → seller cobra. El nonce queda persistido (retry idempotente).

### 4.5 Flujos de error

- **Secreto ausente/débil (AC-3)**: `getArbiterNonceSecret()→null` → `getOrCreateArbiterNonce→null` → `settleArbitrationOnChain` cae a `settlePaymentIntentOnChain` (operator-custodial byte-idéntico). Cero `onlyArbiter`.
- **Persistencia falla**: RPC error/no-row → `getOrCreateArbiterNonce→null` → mismo fallback fail-closed. NUNCA on-chain sin nonce persistido.
- **Retry/recovery (AC-2)**: `getOrCreateArbiterNonce` lee el persistido (step 1) sin recomputar → mismo nonce → contrato garantiza `NonceAlreadyUsed`/idempotencia final.
- **Nonce pre-consumido (griefing, AC-7)**: `executeResolveDispute` diagnostica `NONCE_ALREADY_USED` → `unequivocal` con esa causa → NO refund → `failed_ambiguous`/RECONCILE (revisión manual). El ataque no paga.
- **Flag OFF (AC-6)**: `settleArbitrationOnChain` retorna en la línea 111 sin computar/persistir nonce. Inerte.

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- Migración/RPC: seguir `20260713000000_wkh191a_debit_signatures.sql` + `record_debit_hop1` (owner-guard `FOR UPDATE`, `SECURITY DEFINER`, `SET search_path`, `REVOKE`/`GRANT service_role`, RLS deny-by-default).
- Ownership Guard (WKH-53): el `SELECT` de read-first filtra por `owner_ref`; el RPC owner-checkea contra `a2a_payment_intents`.
- `deriveArbiterNonce` pura dado el secreto (secreto como parámetro, no env-read adentro).
- `SettleOutcome`/ramas de `executeArbitration` conservan su forma; solo se AGREGA la intercepción AC-7.
- Imports: solo símbolos que existen (`grep "export .* <sym>"` antes de tsc — lección auto-blindaje 191g).

### PROHIBIDO
- **CD-1**: recomputar `deriveArbiterNonce` una vez que existe un nonce persistido para el `intentId` (read-first obligatorio); el nonce de cualquier intento (inicial/retry/recovery) DEBE ser idéntico.
- **CD-2**: exponer `ARBITER_NONCE_SECRET` en logs/telemetría/recibos/respuestas; o usar cualquier fórmula de nonce que dependa SOLO de datos públicos (`keyId`/`intentId`).
- **CD-3**: fallback silencioso a la fórmula pública antigua si el secreto falta — DEBE caer al path operator-custodial (fail-closed).
- **CD-4**: tocar `contracts/src/WasiAIEscrow.sol` / `IWasiAIEscrow.sol` (Opción A es app-only).
- **CD-5**: degradar byte-idéntico el resto del wire de 191g (flag OFF / sin escrow / consent false / happy path del executor).
- **CD-6**: alcanzar mainnet (testnet-only, heredado del epic).
- NO tocar `a2a_arbitrations` ni su timing de escritura (DT-2). NO tocar `usdToAtomic`/`parseUnits`/el settle path. NO agregar dependencias nuevas.
- NO alterar el happy path (`confirmed`) de `executeResolveDispute`; el diagnóstico es SOLO en la rama de revert.

### CD específicos de defensa histórica (auto-blindaje)
- **CD-AB-1** (191g auto-blindaje #1): verificar que CADA símbolo importado exista (`export`) antes de tsc — el bloque de imports de `arbiter.ts` sumará `getArbiterNonceSecret`/`ARBITER_NONCE_COLLISION_REASON`.
- **CD-AB-2** (recurrente ≥3 HUs del epic 191): mocks `vi.fn` reexpuestos vía spread DEBEN tiparse con rest param `vi.fn((..._a: unknown[]): T => …)` — TS2556 con aridad fija.
- **CD-AB-3** (191g auto-blindaje #3): tests que necesiten un veredicto `release` determinístico por rules DEBEN incluir `voucherCount`/`vouchersTotalUsd` en la evidencia (copiar la forma del exemplar AC-3, no asumir `consumed>=deposit`).

## 6. Waves de Implementación

### Wave 0 (Serial Gate — contratos de datos)
- **W0.1**: `20260713000003_wkh194_arbiter_nonces.sql` — tabla `a2a_arbiter_nonces` + RPC `get_or_create_arbiter_nonce` + RLS + grants. Exemplar: `wkh191a`.
- **W0.2**: `20260713000003_wkh194_arbiter_nonces_down.sql`. Exemplar: `wkh191b_down`.

### Wave 1 (Paralelizable — funciones puras/env, dep. W0 para tipos)
- **W1.1**: `arbiter-executor.ts` — `deriveArbiterNonce(…, secret)` (3er arg) + `getArbiterNonceSecret()` + export `ARBITER_NONCE_COLLISION_REASON`.
- **W1.2**: `.env.example` — documentar `ARBITER_NONCE_SECRET` (bloque árbitro, fail-closed).

### Wave 2 (Integración — dep. W0 + W1)
- **W2.1**: `arbiter.ts` — `getOrCreateArbiterNonce` (read-first + RPC) + wire en `settleArbitrationOnChain` (reemplaza línea 130 + fallback null). Dep. W0.1, W1.1.
- **W2.2**: `arbiter-executor.ts` — diagnóstico post-mortem `NONCE_ALREADY_USED` en `executeResolveDispute`. Dep. W1.1.
- **W2.3**: `arbiter.ts` — rama defensa-en-profundidad AC-7 en `executeArbitration:767`. Dep. W2.2.

### Wave 3 (Tests + verificación)
- **W3.1**: `arbiter-executor.test.ts` — casos de secreto + diagnóstico.
- **W3.2**: `arbiter.test.ts` — `getOrCreateArbiterNonce` (exactly-once/fallback) + defensa-en-profundidad.
- **W3.3**: tsc + biome + vitest full.

## 7. Test Plan (≥1 por AC)

| Test | AC/CD que cubre | Archivo | Descripción |
|------|-----------------|---------|-------------|
| T1 bit-255 con secreto | AC-4 | `arbiter-executor.test.ts` | `deriveArbiterNonce(kh, id, secret)` → `(n>>255n)&1n === 1n` y `n >= 2n**255n`. |
| T2 no-re-derivable | AC-5, CD-2 | `arbiter-executor.test.ts` | secreto distinto (mismos inputs) → nonce distinto; mismo secreto+inputs → mismo nonce (pura). |
| T3 secreto ausente/débil | AC-3, CD-3 | `arbiter-executor.test.ts` | `getArbiterNonceSecret()` → `null` con env unset/`''`/`'   '`/`<32 chars`; con ≥32 → string. Nunca loggea el valor. |
| T4 exactly-once persistencia | AC-1, AC-2, CD-1 | `arbiter.test.ts` | 1ª call computa+persiste (mock RPC devuelve el candidate); 2ª call: mock SELECT devuelve persistido → mismo valor, `deriveArbiterNonce` NO invocado (spy) aunque el env-secret cambie. |
| T5 fallback secreto→operator-custodial | AC-3, CD-3, CD-5 | `arbiter.test.ts` | `ESCROW_ARBITER_ENABLED=true`+consent+decimals OK pero secreto ausente → `settleArbitrationOnChain` retorna resultado de `settlePaymentIntentOnChain`; `executeResolveDispute` NO invocado. |
| T6 flag OFF inerte | AC-6, CD-5 | `arbiter.test.ts` | `ESCROW_ARBITER_ENABLED` unset → `settleArbitrationOnChain` = `settlePaymentIntentOnChain`; sin lectura/persistencia de nonce (RPC spy no llamado). |
| T7 diagnóstico colisión | AC-7 | `arbiter-executor.test.ts` | `executeResolveDispute` con receipt reverted + `simulateContract` que arroja `NonceAlreadyUsed` → `reason === ARBITER_NONCE_COLLISION_REASON`; otro revert → `'REVERTED'`; simulate RPC-fail → `'REVERTED'` (nunca lanza). |
| T8 defensa no-refund | AC-7 | `arbiter.test.ts` | `settle` unequivocal con `error===NONCE_ALREADY_USED` → finalize `'failed_ambiguous'` (NO `failed_unequivocal`), residual 0, mensaje `RECONCILE: NONCE_COLLISION…`; NO auto-refund del deposit. Reverts NO-colisión → sigue `failed_unequivocal` (refund completo, byte-idéntico). Evidencia con `voucherCount`/`vouchersTotalUsd` (CD-AB-3). |
| T9 atomicidad first-writer | AC-1, DT-3 | `arbiter.test.ts` | RPC devuelve el ganador ON CONFLICT (segundo writer no diverge); `getOrCreateArbiterNonce` usa siempre el `persisted_nonce`. |

## 8. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Modificar el money-path executor (`executeResolveDispute`) rompe outcomes DONE de 191g | M | A | Diagnóstico SOLO en la rama de revert (post-mortem); happy path byte-idéntico; T7 cubre todos los sub-casos + nunca-lanza. |
| Recompute accidental del nonce (viola CD-1) | M | A | Read-first obligatorio (SELECT antes de compute); T4 con spy sobre `deriveArbiterNonce`. |
| Fuga del secreto → re-derivable | B | A | Secreto solo server-side + entropía ≥32B; defensa en profundidad AC-7 (aun con fuga, no premia el griefing); Opción B (contract-level) documentada como hardening futuro. |
| Etiquetar un revert definitivo como `failed_ambiguous` confunde reconcile | B | M | Mensaje `RECONCILE: NONCE_COLLISION…` desambigua; el motor 191c NO opera sobre intents del árbitro (no hay colisión de surface); solo reusa el terminal no-refund. |
| Persist falla → intent no settlea | B | M | Fallback fail-closed a operator-custodial (money-safe); admin/reconcile disponible. |
| Rotación del secreto rompe intents en curso | B | M | La persistencia blinda: nonces ya persistidos NO cambian con rotación (AC-2); solo intents NUEVOS post-rotación derivan con el secreto nuevo. `[TBD]` runbook (§10). |

## 9. Dependencias

- WKH-191g (DONE, código) — extiende `deriveArbiterNonce`/`settleArbitrationOnChain`/`executeResolveDispute`, no los reemplaza.
- WKH-191a/191b (DONE) — exemplars de tabla/RPC SECURITY DEFINER owner-guarded.
- Pre-requisito de seguridad (no bloqueante de código) de la activación real del árbitro (191h + WKH-193). Puede correr en paralelo a WKH-193.

## 10. Missing Inputs / Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| RESUELTO | 4.2 | Persistencia = **tabla dedicada** `a2a_arbiter_nonces` (DT-2, evita blast-radius de `a2a_arbitrations`). | No |
| RESUELTO | 4.2 | Atomicidad = read-first (TS) + RPC `UPSERT ON CONFLICT DO NOTHING` + re-SELECT (DT-3, first-writer-wins). | No |
| RESUELTO | 4.3(b) | Entropía secreto = `>= 32` chars mínimo (recomendado ≥64 hex / 32 bytes, `openssl rand -hex 32`); `<` mínimo → `null` fail-closed. | No |
| RESUELTO | 4.3(e/f) | Defensa-en-profundidad AC-7 = **incluida** en este SDD (mismo archivo/función; orden del orquestador). | No |
| [TBD no bloqueante] | 9/§8 | Runbook de rotación de `ARBITER_NONCE_SECRET` — por diseño la persistencia blinda nonces existentes (AC-2); procedimiento operativo formal = decisión de infra fuera de Scope IN. | No |

> Sin `[NEEDS CLARIFICATION]` pendientes. Gate desbloqueable.

## 11. Readiness Check

```
[x] Cada AC (AC-1..AC-7) tiene ≥1 archivo asociado en tabla 4.1 y ≥1 test en §7
[x] Cada archivo en 4.1 tiene Exemplar verificado con Read/Glob (paths reales confirmados)
[x] No hay [NEEDS CLARIFICATION] pendientes (Missing Inputs resueltos; 1 [TBD] no bloqueante)
[x] Constraint Directives incluyen ≥3 PROHIBIDO (CD-1..CD-6 + AB-1..AB-3)
[x] Context Map tiene ≥2 archivos leídos (9 leídos con línea)
[x] Scope IN/OUT explícitos y no ambiguos
[x] BD: a2a_payment_intents/a2a_arbitrations verificadas; a2a_arbiter_nonces = nueva (aditiva)
[x] Happy Path completo (§4.4)
[x] Flujo de error definido (§4.5, ≥5 casos)
[x] Anti-alucinación: exemplars 191a/191b/191g confirmados; deriveArbiterNonce firma real verificada; contrato solo-lectura
```

---

*SDD generado por NexusAgil — FULL · WKH-194*
