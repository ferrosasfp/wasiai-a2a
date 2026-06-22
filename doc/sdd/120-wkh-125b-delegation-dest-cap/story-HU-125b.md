# Story File — HU WKH-125b — Aplicar el cap de gasto por destino en delegaciones EIP-712

> **Contrato autocontenido para el Dev.** No necesitás releer el SDD ni el work-item.
> Todo lo que tenés que tocar, los exemplars a espejar (archivo:línea real verificado) y los
> tests están acá. Modo: QUALITY. Branch: `fix/120-wkh-125b-delegation-dest-cap`.
> SPEC_APPROVED dado.

---

## 0. Contexto compacto (qué se construye y por qué)

WKH-125 agregó el **cap de gasto por destino** (`a2a_key_spend_policies` + `a2a_key_dest_spend_ledger`
+ RPC `debit_with_dest_policy`) y lo aplicó a **master key** y **session key**. La ruta de **delegación
EIP-712** quedó fuera de scope → **bypass real en prod**: un débito vía `delegationContext` entra al RPC
`debit_delegation_and_parent`, que internamente hace `PERFORM increment_a2a_key_spend(...)` **sin pasar
nunca por `debit_with_dest_policy`** → el cap por destino jamás se evalúa.

Esta HU cierra el gap de forma **simétrica al fix de session key** (WKH-125 W3.4): el RPC
`debit_delegation_and_parent` recibe `p_destination TEXT DEFAULT NULL` y, cuando hay destino, dispatcha a
`debit_with_dest_policy` (atomicidad total reusada). El cierre se aplica en **AMBOS call-sites** del RPC:
`src/services/budget.ts` (rama delegación) y `src/middleware/a2a-key.ts` (step-0 de compose bajo delegación,
el `TODO(WKH-125b)`).

**Exemplar maestro (todo el fix está espejado de acá):**
- SQL: `supabase/migrations/20260606000000_a2a_key_spend_policies.sql:141-232` (`debit_session_and_parent`)
- TS service: `src/services/key-session.ts:440-479` (`debitSessionAndParent`)
- TS middleware: `src/middleware/a2a-key.ts:582-618` (branch session — forwarding condicional + 402)

---

## 1. Scope IN — archivos exactos a tocar (exhaustivo)

| # | Archivo | Wave | Acción |
|---|---------|------|--------|
| 1 | `supabase/migrations/20260608000000_wkh125b_delegation_dest_cap.sql` | W0 | **CREAR** |
| 2 | `supabase/migrations/20260608000000_wkh125b_delegation_dest_cap_down.sql` | W0 | **CREAR** |
| 3 | `src/services/delegation.ts` | W1 | MODIFICAR (firma + `p_destination` + import + mapeo) |
| 4 | `src/services/budget.ts` | W1 | MODIFICAR (rama delegación: 6º arg + mapeo `DestCapExceededError`) |
| 5 | `src/middleware/a2a-key.ts` | W1 | MODIFICAR (step-0 delegación: forwarding condicional + 402 + quitar TODO) |
| 6 | `src/services/delegation.test.ts` | W2 | MODIFICAR (fix aridad T10 + tests nuevos AC-1/AC-2/AC-3/AC-5) |
| 7 | `src/services/budget.test.ts` | W2 | MODIFICAR (fix aridad delegation-path + test AC-1) |
| 8 | `src/middleware/a2a-key.test.ts` | W2 | MODIFICAR (tests AC-1 step-0 402 + AC-2 5-arg intacto) |
| 9 | `src/__tests__/e2e/delegation-atomicity.real.test.ts` | W2 | MODIFICAR (caso atomicidad dest-cap, gateado por DB) — **EXISTE** (verificado) |

**Fuera de scope (PROHIBIDO tocar):** `increment_a2a_key_spend`, `debit_with_dest_policy`,
`a2a_key_spend_policies`, `a2a_key_dest_spend_ledger`, la `DelegationPolicy` del EIP-712, rutas master/session,
cualquier archivo no listado arriba.

---

## 2. Anti-Hallucination Checklist (verificado con Read/Grep en F2.5)

- [x] `DestCapExceededError` existe → `src/services/security/errors.ts:317`.
- [x] **YA importado** en `budget.ts:25` y `a2a-key.ts:37`. **NO importado** en `delegation.ts` (L30-43) → **hay que agregarlo**.
- [x] Firma actual del RPC: `debit_delegation_and_parent(uuid, text, uuid, integer, numeric)` — 5 params (`20260601000000_a2a_delegations.sql:41-46`, hardening L106-111).
- [x] `debitDelegationAndParent` (service) hoy tiene 5 params (`delegation.ts:377-383`), rpc con 5 keys (`delegation.ts:384-390`), mapeo por prefijo (L392-432), fallback que nunca propaga msg crudo (`throw new Error('DELEGATION_DEBIT_FAILED')`, L432).
- [x] `budget.ts` rama delegación: `debitDelegationAndParent(...)` con 5 args (`budget.ts:161-167`), catch en L190-229. `DestCapExceededError` NO está mapeado en esa rama (sí en la session, L116-117).
- [x] `a2a-key.ts` step-0 delegación: llamada de 5 args con `TODO(WKH-125b)` (`a2a-key.ts:376-385`), catch L386-452 termina en `throw debitErr` (L452). Branch session paralelo: forwarding condicional (L592-609) + 402 (L614-618).
- [x] `destination?: string` ya es el 6º param de `budget.debit()` (`budget.ts:78`), ya en scope en la rama delegación.
- [x] Migración más reciente: `20260607000000_wkh_sec02_rls.sql` → `20260608000000` es timestamp posterior ✅.
- [x] Test e2e existe: `src/__tests__/e2e/delegation-atomicity.real.test.ts` (verificado con `ls`).
- [x] Tests que rompen por aridad: `delegation.test.ts:301-307` (T10, 5 keys) y `budget.test.ts:266-272` (5 args).

> **REGLA:** si vas a referenciar algo no listado acá, primero `Read`/`Grep`. NO inventes paths ni firmas.

---

## 3. WAVES (orden serial estricto: W0 → W1 → W2)

> **W0 es la fuente de verdad** (contrato SQL). W1 depende de la firma del RPC de W0.
> W2 (tests) depende del comportamiento de W1. **No empieces W1 sin W0 escrito. No empieces W2 sin W1.**
> Dentro de cada wave los archivos pueden tocarse en cualquier orden.

---

### W0 — Migración SQL (serial, contrato — fuente de verdad)

**CDs activos en W0:** CD-1 (atomicidad), CD-2 (DROP antes de CREATE), CD-3 (back-compat null byte-idéntico),
CD-4 (no tocar `increment_a2a_key_spend` ni `debit_with_dest_policy`), CD-6 (hardening block).

#### Archivo 1 — `supabase/migrations/20260608000000_wkh125b_delegation_dest_cap.sql` (CREAR)

**Espejo:** `20260606000000_a2a_key_spend_policies.sql:141-232`.
**Cuerpo base a copiar literal:** `20260601000000_a2a_delegations.sql:41-102` (TODO el cuerpo del RPC actual,
salvo el paso 5).

Estructura literal a escribir (NO envolver en `BEGIN;/COMMIT;` — el exemplar maestro no lo hace; el runner
envuelve cada archivo en su propia tx):

```sql
-- ============================================================
-- Migration: 20260608000000_wkh125b_delegation_dest_cap
-- WKH-125b: aplicar el cap por destino (a2a_key_spend_policies) a la ruta de
-- delegación EIP-712. Espejo del fix de WKH-125 W3.4 para debit_session_and_parent
-- (20260606000000_a2a_key_spend_policies.sql:141-232).
--
-- El paso 5 (PERFORM increment_a2a_key_spend) pasa a ser un dispatch condicional:
-- con destino → PERFORM debit_with_dest_policy (cap atómico, reusado, NO se toca);
-- sin destino → increment_a2a_key_spend (back-compat byte-idéntico, CD-3).
--
-- BLQ-MED-1 (REPETIDO de WKH-125): CREATE OR REPLACE con +1 param crea una
-- SOBRECARGA, no reemplaza. DROP de la firma vieja de 5 params ANTES del CREATE
-- de 6 params → una sola función. (114/auto-blindaje#75-95)
-- ============================================================

-- CD-2: DROP de la firma vieja de 5 params ANTES del CREATE OR REPLACE de 6.
DROP FUNCTION IF EXISTS debit_delegation_and_parent(uuid, text, uuid, integer, numeric);

CREATE OR REPLACE FUNCTION debit_delegation_and_parent(
  p_delegation_id UUID,
  p_owner_ref     TEXT,
  p_key_id        UUID,
  p_chain_id      INT,
  p_amount_usd    NUMERIC,
  p_destination   TEXT DEFAULT NULL          -- NUEVO (WKH-125b): "<registry>/<slug>" o NULL
) RETURNS NUMERIC AS $$
DECLARE
  v_owner     TEXT;
  v_key_id    UUID;
  v_revoked   TIMESTAMPTZ;
  v_expires   TIMESTAMPTZ;
  v_total     NUMERIC;
  v_max_total NUMERIC;
  v_new_total NUMERIC;
BEGIN
  -- 1. Lock de la delegación (FOR UPDATE — serializa débitos concurrentes).
  SELECT owner_ref, key_id, revoked_at, expires_at, total_spent,
         (policy->>'max_total_amount')::NUMERIC
    INTO v_owner, v_key_id, v_revoked, v_expires, v_total, v_max_total
    FROM a2a_delegations
    WHERE id = p_delegation_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELEGATION_NOT_FOUND: %', p_delegation_id;
  END IF;

  -- 2. Ownership Guard a nivel DB.
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not owned by caller', p_delegation_id;
  END IF;
  IF v_key_id IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not bound to key %', p_delegation_id, p_key_id;
  END IF;

  -- 3. Revocación / expiry re-chequeados bajo lock (TOCTOU-safe).
  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'DELEGATION_REVOKED: %', p_delegation_id;
  END IF;
  IF NOW() >= v_expires THEN
    RAISE EXCEPTION 'DELEGATION_EXPIRED: %', p_delegation_id;
  END IF;

  -- 4. Check del total acumulado ANTES del debit del parent.
  v_new_total := v_total + p_amount_usd;
  IF v_max_total IS NOT NULL AND v_new_total > v_max_total THEN
    RAISE EXCEPTION 'DELEGATION_TOTAL_LIMIT_EXCEEDED: % + % > %', v_total, p_amount_usd, v_max_total;
  END IF;

  -- 5. Debit del parent. WKH-125b: si hay destino → dispatch al RPC dest-aware
  --    (la delegación aplica/consume el cap por destino de la PARENT key). Si no →
  --    increment_a2a_key_spend directo (back-compat byte-idéntico, CD-3).
  --    debit_with_dest_policy RAISE DEST_CAP_EXCEEDED → ROLLBACK total (CD-1).
  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);
  END IF;

  -- 6. Recién acá incrementamos total_spent (orden 4→5→6 defensivo).
  UPDATE a2a_delegations SET total_spent = v_new_total WHERE id = p_delegation_id;

  RETURN v_new_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- CD-6: Hardening de la firma NUEVA de 6 params.
ALTER FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  TO service_role;
```

**Diff exacto vs el RPC actual (`20260601000000:41-102`):**
1. firma: `+ p_destination TEXT DEFAULT NULL` (6º param).
2. paso 5: la línea única `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);` (L95)
   se reemplaza por el bloque `IF p_destination ... THEN PERFORM debit_with_dest_policy(...) ELSE PERFORM increment_a2a_key_spend(...) END IF;`.
3. **Todo lo demás (lock, ownership, expiry, check total, UPDATE total_spent, RETURN) queda IDÉNTICO.**
4. hardening: firma `(uuid, text, uuid, integer, numeric, text)` en lugar de `(uuid, text, uuid, integer, numeric)`.

> **CD-3:** verificá que la rama `ELSE` es **byte-idéntica** al `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd)` original. Cero cambios de orden/semántica cuando `p_destination` es NULL o `''`.
> **CD-4:** `debit_with_dest_policy` y `increment_a2a_key_spend` solo se **invocan** vía PERFORM. PROHIBIDO alterar su firma o cuerpo.

#### Archivo 2 — `supabase/migrations/20260608000000_wkh125b_delegation_dest_cap_down.sql` (CREAR)

**Espejo:** `20260606000000_a2a_key_spend_policies_down.sql:5-60`.

```sql
-- WKH-125b down-migration. Restaura debit_delegation_and_parent a su firma de
-- 5 params (pre-WKH-125b, PERFORM increment_a2a_key_spend en el paso 5).

-- 1. Drop de la versión 6-params.
DROP FUNCTION IF EXISTS debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text);

-- 2. Restaurar el RPC original de 5 params (copia literal de 20260601000000:41-102).
CREATE OR REPLACE FUNCTION debit_delegation_and_parent(
  p_delegation_id UUID,
  p_owner_ref     TEXT,
  p_key_id        UUID,
  p_chain_id      INT,
  p_amount_usd    NUMERIC
) RETURNS NUMERIC AS $$
DECLARE
  v_owner     TEXT;
  v_key_id    UUID;
  v_revoked   TIMESTAMPTZ;
  v_expires   TIMESTAMPTZ;
  v_total     NUMERIC;
  v_max_total NUMERIC;
  v_new_total NUMERIC;
BEGIN
  SELECT owner_ref, key_id, revoked_at, expires_at, total_spent,
         (policy->>'max_total_amount')::NUMERIC
    INTO v_owner, v_key_id, v_revoked, v_expires, v_total, v_max_total
    FROM a2a_delegations
    WHERE id = p_delegation_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELEGATION_NOT_FOUND: %', p_delegation_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not owned by caller', p_delegation_id;
  END IF;
  IF v_key_id IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not bound to key %', p_delegation_id, p_key_id;
  END IF;
  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'DELEGATION_REVOKED: %', p_delegation_id;
  END IF;
  IF NOW() >= v_expires THEN
    RAISE EXCEPTION 'DELEGATION_EXPIRED: %', p_delegation_id;
  END IF;
  v_new_total := v_total + p_amount_usd;
  IF v_max_total IS NOT NULL AND v_new_total > v_max_total THEN
    RAISE EXCEPTION 'DELEGATION_TOTAL_LIMIT_EXCEEDED: % + % > %', v_total, p_amount_usd, v_max_total;
  END IF;
  PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);
  UPDATE a2a_delegations SET total_spent = v_new_total WHERE id = p_delegation_id;
  RETURN v_new_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Hardening de la firma vieja de 5 params (copia literal de 20260601000000:106-111).
ALTER FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric)
  TO service_role;
```

> El down **NO** dropea `debit_with_dest_policy` ni las tablas (eso es del down de WKH-125). Solo revierte
> el RPC de delegación a su firma de 5 params.

**Done de W0:** ambos archivos creados; el up tiene DROP-5 → CREATE-6 → hardening-6; el down tiene DROP-6 →
CREATE-5 → hardening-5; el cuerpo del up es idéntico al actual salvo firma + paso 5; rama `ELSE` byte-idéntica.

---

### W1 — Capa TypeScript (serial respecto a W0)

**CDs activos en W1:** CD-5 (no leak msg PG → mapear a error classes/codes), CD-7 (destino canónico:
usar `request.composeDestination` / 6º param de `debit()`, nunca input crudo del caller).

#### Archivo 3 — `src/services/delegation.ts`

**Cambio A — import** (lista L30-43, hoy `DestCapExceededError` NO está):
```ts
import {
  AgentKeyBudgetExhaustedError,
  AgentKeyInactiveError,
  AgentKeyNotFoundError,
  DailyLimitExceededError,
  DelegationExpiredError,
  DelegationNonceReplayError,
  DelegationNotFoundError,
  DelegationRevokedError,
  DelegationSignerMismatchError,
  DelegationTotalLimitExceededError,
  DestCapExceededError,        // ← AGREGAR (orden alfabético, espejo de key-session.ts)
  logOwnershipMismatch,
  OwnershipMismatchError,
} from './security/errors.js';
```

**Cambio B — firma + `p_destination`** (`debitDelegationAndParent`, L377-390). **Espejo:** `key-session.ts:446` y `:454`.
```ts
  async debitDelegationAndParent(
    delegationId: string,
    ownerRef: string,
    keyId: string,
    chainId: number,
    amountUsd: number,
    destination?: string,        // ← AGREGAR (último, opcional — espejo key-session.ts:446)
  ): Promise<string> {
    const { data, error } = await supabase.rpc('debit_delegation_and_parent', {
      p_delegation_id: delegationId,
      p_owner_ref: ownerRef,
      p_key_id: keyId,
      p_chain_id: chainId,
      p_amount_usd: amountUsd,
      p_destination: destination ?? null,   // ← AGREGAR (espejo key-session.ts:454)
    });
```

**Cambio C — mapeo de error** (bloque `if (error)`, justo después de `const msg = error.message;` en L393,
**ANTES** del primer prefijo propio `DELEGATION_TOTAL_LIMIT_EXCEEDED`). **Espejo:** `key-session.ts:461-463`.
```ts
    if (error) {
      const msg = error.message;
      // WKH-125b: la delegación hereda el cap por destino de la parent key; el RPC
      // debit_delegation_and_parent dispatcha a debit_with_dest_policy. Mapear ANTES
      // de los prefijos propios (CD-5: NUNCA propagar el msg crudo de PG).
      if (msg.includes('DEST_CAP_EXCEEDED')) {
        throw new DestCapExceededError();
      }
      if (msg.includes('DELEGATION_TOTAL_LIMIT_EXCEEDED')) {
        // ... (resto del bloque actual SIN cambios)
```

#### Archivo 4 — `src/services/budget.ts` (rama delegación, L154-230)

**Cambio A — pasar `destination` como 6º arg** (L161-167). `destination` ya está en scope (6º param de `debit()`, L78).
```ts
        await delegationService.debitDelegationAndParent(
          delegationContext.delegationId,
          delegationContext.ownerRef,
          delegationContext.keyId,
          chainId,
          amountUsd,
          destination,           // ← AGREGAR (string | undefined; el service hace ?? null)
        );
```

**Cambio B — mapear `DestCapExceededError`** en el catch (L190-229), como **primer** branch (espejo de la
rama session, `budget.ts:116-117`):
```ts
      } catch (err) {
        // WKH-125b: cap por destino excedido bajo delegación → code estable.
        if (err instanceof DestCapExceededError) {
          return { success: false, error: 'DEST_CAP_EXCEEDED' };
        }
        if (err instanceof DelegationTotalLimitExceededError) {
        // ... (resto del catch SIN cambios)
```
> `DestCapExceededError` ya está importado en `budget.ts:25` — no agregar import.

#### Archivo 5 — `src/middleware/a2a-key.ts` (step-0 delegación, L375-385 + catch L386-452)

**Cambio A — forwarding condicional + quitar TODO** (L376-385). **Espejo EXACTO:** branch session `a2a-key.ts:582-609`.
Reemplazar el comentario `TODO(WKH-125b)` (L376-378) y la llamada de 5 args (L379-385) por:
```ts
          // WKH-125b: la delegación hereda el cap por destino de la parent key. El
          // step-0 de un compose bajo delegación DEBE propagar `composeDestination`
          // (canonicalizado por routes/compose.ts:resolveComposePriceHandler) al RPC
          // debit_delegation_and_parent → debit_with_dest_policy. Sin esto el RPC
          // recibía p_destination=NULL y el cap por destino se evadía (bypass).
          // CONDICIONAL (espeja el branch session, CD-7): sólo con composeDestination
          // pasamos el 6º arg; si no, la llamada de 5 args queda INTACTA (back-compat).
          if (request.composeDestination) {
            await delegationService.debitDelegationAndParent(
              delegation.id,
              parentKey.owner_ref,
              parentKey.id,
              chainId,
              estimatedCostUsd,
              request.composeDestination,
            );
          } else {
            await delegationService.debitDelegationAndParent(
              delegation.id,
              parentKey.owner_ref,
              parentKey.id,
              chainId,
              estimatedCostUsd,
            );
          }
```

**Cambio B — mapear `DestCapExceededError` → HTTP 402** en el catch (L386-452), como **primer** branch
(espejo EXACTO de session `a2a-key.ts:614-618`):
```ts
        } catch (debitErr) {
          // WKH-125b: cap por destino excedido bajo delegación → HTTP 402 (no 403),
          // espejando el branch session. El budget NO se decrementó (rollback de la tx).
          if (debitErr instanceof DestCapExceededError) {
            return reply.status(402).send({
              error: `chain ${chainId} destination cap exceeded`,
              error_code: 'DEST_CAP_EXCEEDED',
            });
          }
          if (debitErr instanceof DelegationTotalLimitExceededError) {
          // ... (resto del catch SIN cambios, termina en throw debitErr)
```
> `DestCapExceededError` ya importado en `a2a-key.ts:37` — no agregar import.
> **CD-7:** usar `request.composeDestination` (ya canonicalizado). PROHIBIDO derivar el destino de input crudo del caller.

**Done de W1:** `npx tsc --noEmit` → 0 errores. Los 3 archivos modificados; `delegation.ts` importa y mapea
`DestCapExceededError`; `budget.ts` pasa 6º arg + mapea; `a2a-key.ts` forwarding condicional + 402 + sin TODO.

---

### W2 — Tests (paralelizable internamente; depende de W1)

**CD activo:** CD-8 (si agregás test estructural de la migración, contá **sentencias DDL completas**, no
substrings — los comentarios mencionan las mismas ops. Referencia: 116/auto-blindaje#3-7. **Nota:** esta HU
prioriza tests de comportamiento; CD-8 solo aplica si decidís agregar un structural test, que NO es requerido).

#### 2.a — Fix de aridad (anti-regresión) — OBLIGATORIO, NO relajar aserciones de comportamiento

**`src/services/delegation.test.ts:301-307`** (T10 success). Hoy asserta 5 keys; tras W1 el service agrega
`p_destination: null`. Fix (espejo de `key-session.test.ts:382-390`):
```ts
    expect(mockRpc).toHaveBeenCalledWith('debit_delegation_and_parent', {
      p_delegation_id: 'del-1',
      p_owner_ref: 'user-1',
      p_key_id: 'key-1',
      p_chain_id: 2368,
      p_amount_usd: 0.3,
      p_destination: null,     // ← AGREGAR (back-compat por DEFAULT NULL)
    });
```

**`src/services/budget.test.ts:266-272`** (delegation path debit). Hoy asserta `toHaveBeenCalledWith('del-1','user-1','key-1',2368,0.3)`
— 5 args. Tras W1, `budget.ts` pasa `destination` como 6º arg. En este test `DELEGATION_CTX` no tiene destino
y `budget.debit('key-1', 2368, 0.3, {...})` se llama **sin 6º param** → `destination` es `undefined`. Fix:
```ts
      expect(mockDebitDelegation).toHaveBeenCalledWith(
        'del-1',
        'user-1',
        'key-1',
        2368,
        0.3,
        undefined,           // ← AGREGAR (6º arg = destination undefined, no hay destino en el test)
      );
```
> Verificá la firma con la que el test llama `budget.debit` antes de fijar el 6º valor. Si el caller del test
> pasara un destino, ajustá el valor esperado en consecuencia. NO toques las otras aserciones del test.

#### 2.b — Tests nuevos por AC (espejo de `key-session.test.ts:404-434`)

**`src/services/delegation.test.ts`** (dentro de `describe('debitDelegationAndParent')`):
- **AC-3 (destino forwardeado)** — espejo `key-session.test.ts:404-417`:
  ```ts
  it('WKH-125b destination is forwarded as p_destination to the RPC (AC-3)', async () => {
    mockRpc.mockResolvedValue({ data: '0.30', error: null } as never);
    await delegationService.debitDelegationAndParent('del-1','user-1','key-1',2368,0.3,'kite/translator');
    expect(mockRpc).toHaveBeenCalledWith(
      'debit_delegation_and_parent',
      expect.objectContaining({ p_destination: 'kite/translator' }),
    );
  });
  ```
- **AC-1 (cap excedido → DestCapExceededError)** — espejo `key-session.test.ts:420-434`:
  ```ts
  it('WKH-125b DEST_CAP_EXCEEDED → DestCapExceededError (inherited cap) (AC-1)', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'DEST_CAP_EXCEEDED: dest x accum 1 + 1 > cap 1' },
    } as never);
    await expect(
      delegationService.debitDelegationAndParent('d','o','k',1,1,'kite/translator'),
    ).rejects.toBeInstanceOf(DestCapExceededError);
  });
  ```
- **AC-5 (no leak msg crudo PG)** — espejo `delegation.test.ts:377-379`:
  ```ts
  it('WKH-125b DEST_CAP_EXCEEDED carries NO raw PG detail (AC-5)', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'DEST_CAP_EXCEEDED: dest x accum 1 + 1 > cap 1' },
    } as never);
    let thrown: unknown;
    try { await delegationService.debitDelegationAndParent('d','o','k',1,1,'kite/translator'); }
    catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(DestCapExceededError);
    expect((thrown as Error).message).not.toContain('accum');
    expect((thrown as Error).message).not.toContain('cap 1');
  });
  ```
  > Importá `DestCapExceededError` en el test si no está (verificá los imports del archivo).

**`src/services/budget.test.ts`** (dentro del `describe` de la rama delegación):
- **AC-1 (budget NO se decrementa → success:false)**:
  ```ts
  it('WKH-125b delegation DEST_CAP_EXCEEDED → { success:false, error:DEST_CAP_EXCEEDED } (AC-1)', async () => {
    mockDebitDelegation.mockRejectedValue(new DestCapExceededError());
    const result = await budgetService.debit('key-1', 2368, 0.3, {
      ...DELEGATION_CTX, maxAmountPerTx: '0.50',
    });
    expect(result).toEqual({ success: false, error: 'DEST_CAP_EXCEEDED' });
    expect(mockReceiptEmit).not.toHaveBeenCalled();
  });
  ```
  > Importá `DestCapExceededError` en el test si falta.

**`src/middleware/a2a-key.test.ts`** (espejo del branch session de dest-cap, buscar los tests análogos del
step-0 de session):
- **AC-1 (step-0 delegación → HTTP 402)**: forzar `DestCapExceededError` del débito de delegación step-0
  con `request.composeDestination` seteado → respuesta `402` con `error_code: 'DEST_CAP_EXCEEDED'`.
- **AC-2 (sin composeDestination → llamada de 5 args intacta)**: step-0 de delegación SIN `request.composeDestination`
  → `debitDelegationAndParent` invocado con **5 args** (no 6). Espejo del branch session.
  > Leé los tests existentes del step-0 de session en `a2a-key.test.ts` como exemplar de forma (setup del
  > request, mocks de `delegationService`, assertion del status). NO inventes el harness.

#### 2.c — e2e atomicidad (AC-4) — `src/__tests__/e2e/delegation-atomicity.real.test.ts` (EXISTE)

Gateado por `INTEGRATION_TEST_DB_URL`. **Leé el archivo completo primero** (es el exemplar de forma del e2e real).
Agregá/adaptá un caso: débito de delegación con destino que **excede el cap** → la tx hace **ROLLBACK**
(parent budget sin cambios, `total_spent` de la delegación sin cambios, ledger sin INSERT nuevo). Espejo del
caso de no-double-spend ya presente. Si el harness no soporta el setup de policy+ledger fácilmente, dejá el caso
con el mismo patrón de skip condicional que los demás tests del archivo.

**Done de W2:** suite verde (`npx vitest run`); fixes de aridad aplicados; ≥1 test nuevo por AC.

---

## 4. Constraint Directives (las 8) — referencia rápida por wave

| CD | Regla | Wave |
|----|-------|------|
| **CD-1** | Atomicidad: check cap + INSERT ledger + debit parent + UPDATE total_spent en la **misma tx PG**, vía dispatch a `debit_with_dest_policy`. PROHIBIDO check app-layer + RPC separado. | W0 |
| **CD-2** | `DROP FUNCTION IF EXISTS debit_delegation_and_parent(uuid,text,uuid,integer,numeric)` **ANTES** del CREATE de 6 params. Sin esto → sobrecarga → `is not unique` (BLQ-MED-1, 114/auto-blindaje#75-95, REPETIDO). | W0 |
| **CD-3** | Back-compat **byte-idéntico** cuando `p_destination IS NULL` o `''`: rama `ELSE` = `PERFORM increment_a2a_key_spend(...)` original, sin ledger, sin cap. | W0 |
| **CD-4** | PROHIBIDO modificar firma/cuerpo de `increment_a2a_key_spend` y `debit_with_dest_policy`. Solo `PERFORM`. | W0 |
| **CD-5** | El prefijo `DEST_CAP_EXCEEDED` → `DestCapExceededError` en `delegation.ts` (antes de los prefijos propios). `budget.ts`/middleware → `error_code:'DEST_CAP_EXCEEDED'`. El `error.message` crudo de PG NUNCA llega al cliente. | W1 |
| **CD-6** | Hardening con firma de 6 params: `ALTER ... SET search_path=public,pg_temp` + `REVOKE ... FROM PUBLIC,anon,authenticated` + `GRANT ... TO service_role`. | W0 |
| **CD-7** | Destino **canónico**: en el middleware usar `request.composeDestination` (ya canonicalizado por `resolveAgentDestination`/`normalizeDestination`); en `budget.ts` el 6º param de `debit()`. PROHIBIDO input crudo del caller (114/auto-blindaje#38-73). | W1 |
| **CD-8** | Si agregás test **estructural** de la migración, contá **sentencias DDL completas**, no substrings (116/auto-blindaje#3-7). Aplica solo si lo agregás (no requerido). | W2 |

---

## 5. Test Plan — mapeo AC → archivo → caso

| AC | Caso | Archivo | Tipo |
|----|------|---------|------|
| **AC-1** | `DEST_CAP_EXCEEDED` (RPC) → `DestCapExceededError` con destino | `delegation.test.ts` | mock RPC |
| **AC-1** | `DestCapExceededError` → `{ success:false, error:'DEST_CAP_EXCEEDED' }`, NO emite receipt | `budget.test.ts` | mock service |
| **AC-1** | step-0 delegación con `composeDestination` → HTTP 402 + `error_code:'DEST_CAP_EXCEEDED'` | `a2a-key.test.ts` | integration mock |
| **AC-2** | sin destino → `p_destination: null` (back-compat) | `delegation.test.ts` (fix T10 + nuevo) | mock RPC |
| **AC-2** | step-0 sin `composeDestination` → llamada de 5 args intacta | `a2a-key.test.ts` | integration mock |
| **AC-3** | destino forwardeado → `expect.objectContaining({ p_destination:'kite/translator' })` (ventana rolling vive en `debit_with_dest_policy`, ya cubierta en WKH-125 + e2e) | `delegation.test.ts` | mock RPC |
| **AC-4** | débito con destino que excede cap → ROLLBACK (parent budget + total_spent sin cambio, ledger sin INSERT) | `delegation-atomicity.real.test.ts` | e2e (DB) |
| **AC-5** | `DestCapExceededError.message` NO contiene `'accum'`/`'cap'` (sin leak PG) | `delegation.test.ts` | mock RPC |

---

## 6. Definition of Done

- [ ] **W0**: ambos archivos de migración creados; up = DROP-5 → CREATE-6 (cuerpo idéntico salvo paso 5) → hardening-6; down = DROP-6 → CREATE-5 → hardening-5; rama `ELSE` byte-idéntica (CD-3).
- [ ] **W1**: `delegation.ts` (import + firma `destination?` + `p_destination: destination ?? null` + mapeo `DEST_CAP_EXCEEDED`), `budget.ts` (6º arg + mapeo), `a2a-key.ts` (forwarding condicional + 402 + TODO eliminado).
- [ ] **`npx tsc --noEmit` → 0 errores** (TS strict, sin `any`).
- [ ] **Lint → 0 errores** (`npm run lint` o el comando del proyecto).
- [ ] **Suite verde**: `npx vitest run` (mínimo `delegation.test.ts`, `budget.test.ts`, `a2a-key.test.ts`).
- [ ] Fixes de aridad aplicados (`delegation.test.ts:301-307`, `budget.test.ts:266-272`) sin relajar aserciones de comportamiento.
- [ ] **≥1 test nuevo por AC** (AC-1, AC-2, AC-3, AC-5 con mocks; AC-4 en el e2e gateado por DB).
- [ ] Ningún archivo fuera del Scope IN (§1) fue tocado; `increment_a2a_key_spend` y `debit_with_dest_policy` intactos.

---

## 7. Orden serial de waves (resumen)

```
W0 (SQL: up + down)  →  W1 (delegation.ts → budget.ts → a2a-key.ts)  →  W2 (tests: aridad → nuevos → e2e)
   fuente de verdad        depende de la firma del RPC                    depende del comportamiento de W1
```

No saltear waves. No empezar W1 sin W0 escrito. No empezar W2 sin `tsc` verde en W1.
