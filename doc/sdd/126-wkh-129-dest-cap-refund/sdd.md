# SDD — [WKH-129] Reembolso completo del dest-cap — `refund_with_dest_policy`

> **Fase**: F2 (Architect). **Modo**: QUALITY (path de dinero). **Sizing**: S.
> **Branch**: `fix/126-wkh-129-dest-cap-refund`.
> **Input**: `doc/sdd/126-wkh-129-dest-cap-refund/work-item.md` (HU_APPROVED).
> **0 [NEEDS CLARIFICATION]**.

---

## 1. Context Map — archivos leídos (verificados con Read, archivo:línea)

| Archivo | Líneas | Por qué lo leí | Patrón extraído |
|---------|--------|----------------|-----------------|
| `supabase/migrations/20260623000000_wkh127_refund_a2a_key_spend.sql` | 1-66 | Es la RPC hermana que mi nueva RPC espeja (budget credit + daily_spent GREATEST clamp + ownership guard + hardening) | Estructura PL/pgSQL exacta: `SELECT * INTO v_row ... FOR UPDATE` → `IF NOT FOUND` → ownership guard `IS DISTINCT FROM` → no-op `<= 0` → `jsonb_set` budget → `GREATEST(daily_spent - amount, 0)`. Hardening: `ALTER FUNCTION ... SET search_path`, `REVOKE ... FROM PUBLIC, anon, authenticated`, `GRANT ... TO service_role`. `SECURITY DEFINER`. |
| `supabase/migrations/20260623000000_wkh127_refund_a2a_key_spend_down.sql` | 1-5 | Patrón del down script aditivo | `DROP FUNCTION IF EXISTS refund_a2a_key_spend(uuid, integer, numeric, text);` — firma explícita, comentario de reversibilidad. |
| `supabase/migrations/20260606000000_a2a_key_spend_policies.sql` | 36-43, 55-131 | Tabla `a2a_key_dest_spend_ledger` (columnas exactas) + `debit_with_dest_policy` (cómo inserta `INSERT INTO a2a_key_dest_spend_ledger (key_id, owner_ref, destination, amount_usd) VALUES (...)` L127-128, cómo computa el SUM rolling/total L99-110) | Ledger es append-only, columnas `(key_id, owner_ref, destination, amount_usd, debited_at DEFAULT now())`. El SUM es `COALESCE(SUM(amount_usd), 0)` SIN filtro de signo → una fila negativa resta del acumulado. Índice hot-path `(key_id, destination, debited_at)`. |
| `src/services/budget.ts` | 300-408 | `credit()` actual (335-366) — firma, mapeo de error sin PG crudo, `console.error` + `REFUND_FAILED` | Firma `credit(keyId, chainId, amountUsd, ownerRef)`; RPC `supabase.rpc('refund_a2a_key_spend', {...})`; mapeo `OWNERSHIP_MISMATCH` / `KEY_NOT_FOUND` / fallback `REFUND_FAILED`. |
| `src/services/compose.ts` | 70-378 | Loop per-step: `const agent` (L76, en scope dentro del catch), debit con destination (L168-175), catch + refund WKH-128 (L319-369) | El debit per-step SIEMPRE pasa `normalizeDestination(\`${agent.registry}/${agent.slug}\`)` (L174). El catch (L339-360) llama `budgetService.credit(...)` SIN destination. `agent` es `const` (L76) → disponible en el catch de la MISMA iteración. Guard del refund: `stepDebitedUsd > 0 && scopingKeyRow && chainId !== undefined && !delegationContext && !keySessionContext`. |
| `src/services/spend-policy.ts` | 50 | `normalizeDestination` (export) | `export function normalizeDestination(raw: string): string` — trim + lowercase. Mismo normalizador que la policy. Importado en compose.ts:37. |
| `src/services/compose.test.ts` | 1183-1264 | Tests WKH-128 existentes (T-COMPOSE-REFUND-1/2/3) que mockean `budgetService.credit` | T-REFUND-1 asevera `mockCredit('k1', 2368, 0.05, 'owner-test')`. **Cambiará** a `creditWithDest` (el debit per-step siempre tiene destination → ver §6 no-regresión). T-REFUND-2 (step-0 no refund), T-REFUND-3 (delegación no refund) quedan iguales. |
| `src/__tests__/e2e/refund-atomicity.real.test.ts` | 1-45 | Patrón del test opt-in `.real.test.ts` contra Postgres real | `describe.skipIf(!ENABLED)`, gate `INTEGRATION_TEST_DB_URL` + `INTEGRATION_TEST_SERVICE_KEY`, `TEST_PREFIX = \`...-${Date.now()}\``, `chainId = 84532`. |
| `doc/sdd/125-wkh-127-orchestrate-billing/auto-blindaje.md` | full | Auto-blindaje hermano (path de dinero) | Errores recurrentes → CD-9/CD-10/CD-11 (ver §8). |
| `doc/sdd/114-wkh-125-constraints/auto-blindaje.md` | full | Auto-blindaje del dest-cap original | BLQ-MED-1: `CREATE OR REPLACE +1 param crea overload`; BLQ-ALTO-1: destino debe ser canónico byte-a-byte → CD-12/CD-13. |

---

## 2. Decisiones técnicas (DT-N) — FIJADAS

### DT-1 — Fila compensatoria NEGATIVA (append-only) [FIJADA: Opción A]

La RPC inserta una fila en `a2a_key_dest_spend_ledger` con `amount_usd = -p_amount_usd`,
misma `key_id` / `owner_ref` / `destination` que el débito original, `debited_at = now()`
(default de la tabla).

**Justificación vs alternativas** (verificada contra el código real):
- **A) INSERT negativa (ELEGIDA)**: el cap usa `COALESCE(SUM(amount_usd), 0)`
  (`20260606000000:100,106`) **sin filtro de signo** → una fila `-X` resta exactamente
  `X` del acumulado, devolviendo el headroom. No requiere `ledger_id` (no disponible en
  el catch de compose). No toca el esquema ni el índice `(key_id, destination, debited_at)`.
  Mantiene audit trail completo (débito + reversa visibles).
- **B) DELETE de la fila del débito**: requeriría el `ledger_id` del INSERT original
  (el catch de compose NO lo tiene — solo tiene `key_id/chain/amount/owner/destination`).
  Rompe append-only. Descartada.
- **C) UPDATE `amount_usd = 0`**: rompe append-only, oscurece el audit trail, mismo
  problema de necesitar el `ledger_id`. Descartada.

Decisión consistente con DT-1 del work-item y CD-4 (prohibido crear dinero: el valor
es estrictamente `-p_amount_usd`).

### DT-2 — Nueva función `creditWithDest` [FIJADA: Opción A, firma exacta]

Se agrega una función NUEVA `budgetService.creditWithDest`, NO se extiende `credit` con
un parámetro opcional. **Firma exacta**:

```ts
async creditWithDest(
  keyId: string,
  chainId: number,
  amountUsd: number,
  ownerRef: string,        // CD-8: obligatorio, NO opcional (Ownership Guard)
  destination: string,     // "<registry>/<slug>" YA normalizado por el caller
): Promise<{ success: boolean; error?: string }>
```

**Justificación**:
- Zero riesgo de regresión en los callers de `credit` existentes (orchestrate step-0
  `orchestrate.ts:497-502` usa `credit` 4-arg sin destination; debe seguir igual — CD-6).
- Explícita: el call-site de compose elige `creditWithDest` (con dest) vs `credit`
  (sin dest) por branch, sin ambigüedad de "undefined check".
- `destination` es `string` (NO `string | undefined`): el branch de selección vive en
  compose (§5), no dentro de la función. Si compose decide llamar `creditWithDest`, ya
  tiene un destination válido.

`creditWithDest` llama `supabase.rpc('refund_with_dest_policy', { p_key_id, p_chain_id,
p_amount_usd, p_owner_ref, p_destination })` y mapea errores con el MISMO patrón que
`credit` (sin propagar el msg crudo de PG): `OWNERSHIP_MISMATCH`, `KEY_NOT_FOUND`,
fallback `console.error('[budget] refund-with-dest failed', ...)` + `REFUND_FAILED`.

### DT-3 — Invariante de la ventana rolling [DOCUMENTADA]

La fila compensatoria se inserta con `debited_at = now()` (momento del refund). Para
ventanas `rolling`, el cap filtra `debited_at >= now() - window_secs`
(`20260606000000:104`).

**Invariante de operación**: el refund per-step de compose ocurre en el `catch` del
MISMO request HTTP, **segundos** después del débito (`debit_with_dest_policy` corrió en
L168-175, el `invokeAgent` falla en L205, el catch refunda en L346). Por lo tanto, tanto
la fila del débito original (`debited_at = T0`) como la fila compensatoria
(`debited_at = T0 + δ`, `δ` ≈ segundos) caen **dentro de la misma ventana** para
cualquier `window_secs` razonable (el CHECK de la tabla exige `window_secs > 0`; los
caps reales usan ≥ 60s). El SUM neto vuelve al valor previo al débito fallido.

**Borde teórico (no alcanzable en el path real, documentado)**: si una política tuviera
`window_secs` menor que `δ` (sub-segundo) y el débito original ya hubiera salido de la
ventana cuando se inserta la reversa, el SUM neto quedaría **por debajo** del previo
(headroom extra, nunca de más). Esto NO crea dinero (CD-4 se cumple: el budget/daily se
revierten igual), solo relaja el cap marginalmente en un escenario que el path de compose
no produce. NO se mitiga en esta HU (fuera de scope, append-only es la estrategia fijada).

### DT-4 — Hardening de la RPC [FIJADA, espejo de las hermanas]

Idéntico a `refund_a2a_key_spend` (`20260623000000:59-65`) y `debit_with_dest_policy`
(`20260606000000:133-139`):
- `SECURITY DEFINER` en la función.
- `ALTER FUNCTION ... SET search_path = public, pg_temp`.
- `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`.
- `GRANT EXECUTE ... TO service_role`.

Firma para los `ALTER/REVOKE/GRANT`: `(uuid, integer, numeric, text, text)`.

---

## 3. Exemplar SQL UP — `refund_with_dest_policy` (verificado contra las 2 RPC hermanas)

> Archivo destino (W0): `supabase/migrations/20260624000000_wkh129_refund_with_dest_policy.sql`.
> Prefijo `20260624000000` = siguiente disponible tras `20260623000000` (último en el dir,
> verificado con `ls supabase/migrations/`). **CD-3: migración aditiva — solo
> `CREATE OR REPLACE FUNCTION` de una función NUEVA, sin DROP de ninguna previa.**

```sql
-- ============================================================
-- Migration: 20260624000000_wkh129_refund_with_dest_policy
-- WKH-129 (AC-1/AC-2/AC-3/AC-4/AC-5): refund completo del dest-cap. Espeja
-- refund_a2a_key_spend (20260623000000): FOR UPDATE + Ownership Guard, acredita
-- budget + revierte daily_spent (clamp a 0), Y ADEMÁS inserta una fila
-- compensatoria NEGATIVA en a2a_key_dest_spend_ledger (DT-1, append-only) para
-- devolver el headroom del cap por destino consumido por el débito fallido.
-- Aditiva: función NUEVA (sin DROP de previas — CD-3). El down dropea por firma.
-- ============================================================

CREATE OR REPLACE FUNCTION refund_with_dest_policy(
  p_key_id      UUID,
  p_chain_id    INT,
  p_amount_usd  NUMERIC,
  p_owner_ref   TEXT,
  p_destination TEXT
) RETURNS void AS $$
DECLARE
  v_row          a2a_agent_keys%ROWTYPE;
  v_chain_key    TEXT;
  v_current_bal  NUMERIC;
  v_new_bal      NUMERIC;
  v_new_daily    NUMERIC;
BEGIN
  -- CD-1: lock atómico de la key (mismo estilo que refund_a2a_key_spend).
  --       Serializa contra débitos/refunds concurrentes sobre la misma key.
  SELECT * INTO v_row
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  -- CD-2: Ownership Guard DB-level (defensa en profundidad; service usa SERVICE_ROLE
  --       que bypassea RLS). BAJO LOCK (TOCTOU-safe).
  IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;

  -- CD-5/AC-5: un refund nunca es negativo ni cero. No-op defensivo si <= 0 o NULL.
  --       (espeja refund_a2a_key_spend L38-40). NO inserta fila en el ledger.
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RETURN;
  END IF;

  -- AC-2(a): credit budget de la chain (inverso del débito de debit_with_dest_policy).
  v_chain_key   := p_chain_id::TEXT;
  v_current_bal := COALESCE((v_row.budget ->> v_chain_key)::NUMERIC, 0);
  v_new_bal     := v_current_bal + p_amount_usd;

  -- AC-2(b): revertir el incremento del daily_spent, clamp a 0 (no crear "deuda").
  v_new_daily := GREATEST(v_row.daily_spent_usd - p_amount_usd, 0);

  UPDATE a2a_agent_keys
  SET
    budget          = jsonb_set(budget, ARRAY[v_chain_key], to_jsonb(v_new_bal::TEXT)),
    daily_spent_usd = v_new_daily,
    last_used_at    = NOW()
  WHERE id = p_key_id;

  -- AC-1/AC-2(c)/CD-4: fila compensatoria NEGATIVA en el ledger del dest-cap.
  --       Mismo (key_id, owner_ref, destination) que el débito original; amount
  --       estrictamente -p_amount_usd (PROHIBIDO positivo). debited_at = now()
  --       (default) → cae dentro de la ventana rolling del débito (DT-3 / AC-4).
  --       El SUM del cap (COALESCE(SUM(amount_usd),0), sin filtro de signo)
  --       descuenta este -X → headroom restaurado. TODO en la misma tx (CD-1).
  INSERT INTO a2a_key_dest_spend_ledger (key_id, owner_ref, destination, amount_usd)
  VALUES (p_key_id, p_owner_ref, p_destination, -p_amount_usd);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- DT-4: Hardening (consistente con refund_a2a_key_spend / debit_with_dest_policy).
ALTER FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text)
  TO service_role;
```

### Exemplar SQL DOWN

> Archivo destino (W0): `supabase/migrations/20260624000000_wkh129_refund_with_dest_policy_down.sql`.

```sql
-- WKH-129 down: la RPC es 100% aditiva (función NUEVA, no reemplaza ninguna previa),
-- por lo que el rollback es un simple DROP por firma exacta. Reversibilidad total
-- (sin overloads huérfanos — ref auto-blindaje WKH-125 BLQ-MED-1).
DROP FUNCTION IF EXISTS refund_with_dest_policy(uuid, integer, numeric, text, text);
```

**Nota CD-3 / BLQ-MED-1 (auto-blindaje WKH-125)**: `refund_with_dest_policy` es un nombre
NUEVO (no existe ninguna función con ese nombre hoy — verificado: el dir solo tiene
`refund_a2a_key_spend` y `debit_with_dest_policy`). Por lo tanto NO hay overload posible
y NO se necesita `DROP` previo en el up. La firma del up coincide exactamente con la del
down `(uuid, integer, numeric, text, text)`.

---

## 4. Diseño — `budgetService.creditWithDest` (src/services/budget.ts)

Se agrega INMEDIATAMENTE después de `credit` (tras la línea 366). Espejo de `credit` +
el 5º arg `destination` + RPC distinta. Pseudocódigo del contrato (el Dev lo implementa
en F3 — esto es exemplar, NO se aplica):

```ts
/**
 * WKH-129 (AC-1/AC-2): credit-back atómico CON reversión del dest-cap. Espejo de
 * credit() pero llama refund_with_dest_policy, que ADEMÁS de revertir budget +
 * daily_spent inserta la fila compensatoria negativa en a2a_key_dest_spend_ledger
 * (devuelve el headroom del cap por destino). Para el refund per-step de /compose
 * cuando el débito original pasó por debit_with_dest_policy (tenía destination).
 * CD-8: ownerRef explícito (string, NO undefined). destination YA normalizado por
 * el caller (normalizeDestination(`${registry}/${slug}`)).
 */
async creditWithDest(
  keyId: string,
  chainId: number,
  amountUsd: number,
  ownerRef: string,
  destination: string,
): Promise<{ success: boolean; error?: string }> {
  const { error } = await supabase.rpc('refund_with_dest_policy', {
    p_key_id: keyId,
    p_chain_id: chainId,
    p_amount_usd: amountUsd,
    p_owner_ref: ownerRef,       // CD-2/CD-8: ownership guard DB-level
    p_destination: destination,  // misma forma normalizada que el débito
  });

  if (error) {
    // CD-7 (budget): no propagar msg crudo de PG al cliente.
    if (error.message.includes('OWNERSHIP_MISMATCH')) {
      return { success: false, error: 'OWNERSHIP_MISMATCH' };
    }
    if (error.message.includes('KEY_NOT_FOUND')) {
      return { success: false, error: 'KEY_NOT_FOUND' };
    }
    console.error('[budget] refund-with-dest failed', {
      keyId,
      chainId,
      amountUsd,
      destination,
      err: error.message,
    });
    return { success: false, error: 'REFUND_FAILED' };
  }

  return { success: true };
}
```

`credit` (4-arg, `refund_a2a_key_spend`) queda **intacto** (CD-6) — lo siguen usando
orchestrate step-0 (`orchestrate.ts:497-502` no pasa destination) y el path "sin
destination" de compose (§5).

---

## 5. Diseño — Wire en compose.ts (refund per-step)

El catch actual (L346-360) llama `budgetService.credit(...)`. Se reemplaza por un branch:
si hay destination para el step → `creditWithDest`; si no → `credit` (back-compat).

**El destination del step es el MISMO que usó el débito** (L174):
`normalizeDestination(\`${agent.registry}/${agent.slug}\`)`. `agent` es `const` (L76) y
está en scope dentro del catch de la misma iteración (verificado §1). CD-12/CD-13: misma
fuente canónica que el débito → match byte-a-byte del cap.

```ts
// (dentro del catch, reemplaza el bloque L346-359)
if (
  stepDebitedUsd > 0 &&
  scopingKeyRow &&
  chainId !== undefined &&
  !request.delegationContext &&
  !request.keySessionContext
) {
  // WKH-129: el débito per-step SIEMPRE pasó destination (L174) → revertir el
  // dest-cap además del budget/daily. Mismo normalizador/origen canónico que el
  // débito (agent.registry/agent.slug, agente RESUELTO por discovery — CD-13).
  const destination = normalizeDestination(`${agent.registry}/${agent.slug}`);
  const creditRes = destination
    ? await budgetService.creditWithDest(
        scopingKeyRow.id,
        chainId,
        stepDebitedUsd,
        scopingKeyRow.owner_ref,
        destination,
      )
    : await budgetService.credit(
        scopingKeyRow.id,
        chainId,
        stepDebitedUsd,
        scopingKeyRow.owner_ref,
      );
  if (!creditRes.success) {
    console.error('[compose.refund-failed]', {
      keyId: scopingKeyRow.id,
      chainId,
      amountUsd: stepDebitedUsd,
      destination,
      step: i,
    });
  }
}
```

### Análisis del fallback "sin destination" (AC-6) — ¿alcanzable?

**Confirmación pedida**: en el path master de compose el débito per-step **SIEMPRE** pasa
destination (compose.ts:174 — no es condicional). `normalizeDestination` recibe
`\`${agent.registry}/${agent.slug}\`` con `agent` ya resuelto por discovery (L76), que
siempre tiene `registry` y `slug` (son campos del `Agent`). Por lo tanto:

- En la práctica, **el branch `creditWithDest` es el que se ejecuta siempre** que se entra
  al refund (porque si `stepDebitedUsd > 0`, el débito corrió con destination).
- El branch `credit` (sin dest) es **defensivo**: solo se alcanzaría si `normalizeDestination`
  devolviera `''` (string vacío → falsy). Eso requeriría `registry` y `slug` ambos vacíos
  tras trim, lo que discovery no produce para un agente resuelto. **No alcanzable en el
  path real, pero se conserva por robustez** (si una refactor futura tornara el destination
  opcional, el código degrada al `credit` 4-arg en vez de crashear con un destination
  inválido). Documentado como AC-6 cumplido por construcción defensiva.

**Implicación para tests (CRÍTICO — ver §6)**: el test WKH-128 `T-COMPOSE-REFUND-1`
(compose.test.ts:1185-1210) hoy asevera `mockCredit` con 4 args. Tras este wire,
`creditWithDest` (5 args con destination) será el llamado, NO `credit`. **Ese test
DEBE actualizarse** (no es una regresión de producción, es un test desactualizado por el
cambio de comportamiento correcto — exactamente el patrón del auto-blindaje WKH-127 Wave 5).

---

## 6. Plan de tests (≥1 por AC, 7 ACs)

> Stack de test: **vitest** (mocks por defecto, mismo harness que `compose.test.ts` /
> `budget.test.ts`). Test de Postgres real: **opt-in** `.real.test.ts` (espeja
> `refund-atomicity.real.test.ts`, gate `INTEGRATION_TEST_DB_URL` + `..._SERVICE_KEY`).

| Test ID | AC | Archivo | Qué cubre |
|---------|-----|---------|-----------|
| **T-CWD-1** | AC-2, AC-1 | `src/services/budget.test.ts` (nuevo `describe('creditWithDest')`) | `creditWithDest('k1', 84532, 0.05, 'owner', 'wasiai/corridor')` invoca `supabase.rpc('refund_with_dest_policy', {p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination})` con esos 5 params exactos; éxito → `{success:true}`. |
| **T-CWD-2** | AC-3 | `src/services/budget.test.ts` | RPC devuelve error `OWNERSHIP_MISMATCH` → `creditWithDest` retorna `{success:false, error:'OWNERSHIP_MISMATCH'}` (NO el msg crudo de PG). |
| **T-CWD-3** | AC-2 | `src/services/budget.test.ts` | RPC error genérico → `{success:false, error:'REFUND_FAILED'}` + `console.error` con `destination`. `KEY_NOT_FOUND` → `error:'KEY_NOT_FOUND'`. |
| **T-COMPOSE-REFUND-1** (ACTUALIZAR) | AC-1, AC-6 | `src/services/compose.test.ts:1185` | **Reescribir**: step falla tras débito (master, sin deleg/session) → llama `mockCreditWithDest` (no `mockCredit`) con `('k1', 2368, 0.05, 'owner-test', 'wasiai/corridor')` (destination canónico = `registry/slug` del agente del step). `mockCredit` (4-arg) NO llamado. |
| **T-COMPOSE-REFUND-DEST-2** (nuevo) | AC-2 | `src/services/compose.test.ts` | El monto compensatorio == el debitado: `mockDebit` se llamó con `debitAmount=0.05` y `mockCreditWithDest` con el mismo `0.05` (4º→3er arg). Invariante de no-pérdida: refund.amount === debit.amount. |
| **T-COMPOSE-REFUND-2** (no-regresión) | AC-5/AC-6 | `src/services/compose.test.ts:1214` | step-0 falla → ni `mockDebit` ni `mockCreditWithDest` ni `mockCredit` se llaman (sin cambios de comportamiento). |
| **T-COMPOSE-REFUND-3** (no-regresión) | scope OUT | `src/services/compose.test.ts:1237` | bajo delegación → ni `creditWithDest` ni `credit` se llaman (refund per-step excluye deleg/session — guard intacto). |
| **T-RWD-REAL-1** (opt-in) | AC-1, AC-4 | `src/__tests__/e2e/refund-with-dest-cap.real.test.ts` (nuevo) | Postgres real: con política `rolling`/`total` activa: (1) `debit_with_dest_policy` → SUM del cap = X; (2) `refund_with_dest_policy` mismo (key,dest,amount) → **SUM del cap vuelve a 0** (la fila negativa lo descuenta); (3) budget acreditado, daily_spent revertido (clamp 0). |
| **T-RWD-REAL-2** (opt-in) | AC-3 | `src/__tests__/e2e/refund-with-dest-cap.real.test.ts` | Postgres real: `refund_with_dest_policy` con `p_owner_ref` ajeno → lanza `OWNERSHIP_MISMATCH`; ledger y key SIN modificar (ROLLBACK total). |
| **T-RWD-REAL-3** (opt-in) | AC-5 | `src/__tests__/e2e/refund-with-dest-cap.real.test.ts` | Postgres real: `p_amount_usd <= 0` (y `NULL`) → no-op: NO inserta fila en el ledger, NO toca budget/daily. |
| **T-NOREG-CREDIT** | AC-7 | `src/services/budget.test.ts` (describe `credit` existente) | `credit` 4-arg sigue invocando `refund_a2a_key_spend` (NO `refund_with_dest_policy`) — back-compat orchestrate intacto. |
| **T-NOREG-DEBIT** | AC-7 | `src/services/spend-policy.test.ts` (si aplica) o real | `debit_with_dest_policy` y su aridad `(uuid,integer,numeric,text,text)` intactos; la migración no dropea ni reemplaza ninguna RPC previa. |

**Nota AC-4 (ventana rolling)**: cubierto por `T-RWD-REAL-1` (con `window_type='rolling'`
y `window_secs` ≥ 60 el SUM neto vuelve a 0). El borde sub-segundo de DT-3 NO se testea
(no alcanzable en el path real, documentado como out-of-scope).

**Mock setup nuevo en compose.test.ts**: agregar `creditWithDest: vi.fn()` al mock de
`budgetService` (junto a `credit` en L20) + `const mockCreditWithDest =
vi.mocked(budgetService.creditWithDest)` + default `mockCreditWithDest.mockResolvedValue({
success: true })` en el `beforeEach` (espejo de L152).

---

## 7. Waves de implementación (para F2.5)

| Wave | Tipo | Contenido | Archivos |
|------|------|-----------|----------|
| **W0** | serial (contratos) | Migración SQL up + down de `refund_with_dest_policy` (exemplar §3). NO hay tipos TS nuevos (la RPC retorna void; `supabase.rpc` es genérico no-tipado en este repo). | `supabase/migrations/20260624000000_wkh129_refund_with_dest_policy.sql`, `..._down.sql` |
| **W1** | serial | `budgetService.creditWithDest` (§4). Depende del nombre de RPC de W0. | `src/services/budget.ts` |
| **W2** | serial | Wire del refund per-step en compose (§5): branch `creditWithDest`/`credit`. Depende de W1. | `src/services/compose.ts` |
| **W3** | paralelizable | Tests unitarios mock: T-CWD-1/2/3 (budget), actualizar T-COMPOSE-REFUND-1 + nuevo T-COMPOSE-REFUND-DEST-2 + mock `creditWithDest` (compose), no-regresión T-NOREG-CREDIT. | `src/services/budget.test.ts`, `src/services/compose.test.ts` |
| **W4** | paralelizable | Test opt-in real T-RWD-REAL-1/2/3. | `src/__tests__/e2e/refund-with-dest-cap.real.test.ts` |

W3 y W4 son paralelizables entre sí (archivos disjuntos), ambos dependen de W0-W2.

---

## 8. Constraint Directives (CD-N) — heredados + nuevos

> CD-1 a CD-8 heredados del work-item (sin cambios). CD-9 a CD-13 nuevos del SDD,
> derivados del Auto-Blindaje histórico.

**CD-1 — OBLIGATORIO atomicidad**: reversión `budget + daily_spent + ledger` en una sola
tx PL/pgSQL con `FOR UPDATE` en `a2a_agent_keys`. Fallo de cualquier parte → ROLLBACK total.

**CD-2 — OBLIGATORIO ownership guard DB-layer**: validar `p_owner_ref` contra
`a2a_agent_keys.owner_ref` BAJO LOCK. Violación → `RAISE EXCEPTION 'OWNERSHIP_MISMATCH'`.

**CD-3 — OBLIGATORIO migración aditiva**: up solo `CREATE OR REPLACE FUNCTION` de la
función NUEVA. PROHIBIDO `DROP` de funciones existentes en el up. Down = `DROP FUNCTION
IF EXISTS refund_with_dest_policy(uuid, integer, numeric, text, text)`.

**CD-4 — PROHIBIDO crear dinero**: la fila compensatoria es estrictamente
`amount_usd = -p_amount_usd`. PROHIBIDO un valor positivo o `+p_amount_usd`.

**CD-5 — PROHIBIDO doble-reversa**: `p_amount_usd <= 0` o `NULL` → no-op inmediato
(`RETURN`, sin INSERT en ledger). El caller solo invoca si `stepDebitedUsd > 0`.

**CD-6 — PROHIBIDO tocar `debit_with_dest_policy` ni `refund_a2a_key_spend`**: aridad y
comportamiento intactos. `credit` 4-arg en budget.ts queda intacto.

**CD-7 — OBLIGATORIO best-effort en compose**: un fallo de `creditWithDest` NO cambia el
error visible al caller (mismo patrón WKH-128). Solo log `[compose.refund-failed]` con
`keyId, chainId, amountUsd, destination, step`.

**CD-8 — Ownership Guard (CLAUDE.md)**: `creditWithDest` recibe `ownerRef: string` (NO
optional) y `destination: string` (NO optional). El caller los tiene en
`scopingKeyRow.owner_ref` y `normalizeDestination(...)`.

**CD-9 [NUEVO — ref WKH-127 auto-blindaje#1]**: PROHIBIDO dejar tests pre-existentes que
aseveran conteos de `credit`/`debit` sin actualizar cuando el wire cambia la función
llamada. `T-COMPOSE-REFUND-1` PASA de `mockCredit` a `mockCreditWithDest` — debe
actualizarse en la MISMA HU. Buscar con `grep -rn "mockCredit\b\|toHaveBeenCalledWith"
src/services/compose.test.ts` antes de cerrar W3.

**CD-10 [NUEVO — ref WKH-127 auto-blindaje#2]**: OBLIGATORIO testear el INVARIANTE de
no-pérdida con el monto real: `refund.amount === debit.amount` para el mismo step
(T-COMPOSE-REFUND-DEST-2). El refund NUNCA debe revertir más ni menos que lo debitado.
En el test real (T-RWD-REAL-1) verificar que el SUM del cap vuelve EXACTAMENTE al valor
previo al débito (no menos, salvo el borde DT-3 documentado).

**CD-11 [NUEVO — ref WKH-125 auto-blindaje BLQ-MED-1]**: el nombre `refund_with_dest_policy`
es NUEVO → NO necesita `DROP` previo (no hay overload). PERO la firma del up
`(uuid,integer,numeric,text,text)` DEBE coincidir EXACTAMENTE con la del down `DROP`. Si
en F3 se cambia algún tipo de parámetro, actualizar AMBOS scripts.

**CD-12 [NUEVO — ref WKH-125 auto-blindaje BLQ-ALTO-1]**: el `destination` del refund DEBE
derivarse de la MISMA fuente canónica que el débito (`agent.registry`/`agent.slug` del
agente RESUELTO por discovery, L76), pasado por el MISMO `normalizeDestination`. PROHIBIDO
derivarlo del body crudo del caller o de otra fuente — debe matchear byte-a-byte la fila
que `debit_with_dest_policy` insertó, o el SUM no se cancela.

**CD-13 [NUEVO — invariante de path]**: la fila compensatoria usa `key_id`, `owner_ref` Y
`destination` IDÉNTICOS al débito. Si cualquiera difiere, el SUM del cap no descuenta la
reversa (queda una fila negativa "huérfana" para otro destino/owner). El test real verifica
que tras el refund el SUM del destino exacto vuelve al valor previo.

---

## 9. Readiness Check (F2)

- [x] Work item leído completo (ACs, Scope IN/OUT, DTs, CDs, F0 archivo:línea).
- [x] `project-context.md` / CLAUDE.md leídos — stack: TypeScript strict, Fastify, Supabase
      (SERVICE_KEY bypassa RLS → ownership guard app+DB layer), vitest. Sin drift detectado.
- [x] Exemplar RPC hermana verificada con Read: `refund_a2a_key_spend`
      (`20260623000000:1-66`) + down (`..._down.sql:1-5`).
- [x] Ledger `a2a_key_dest_spend_ledger` verificado: columnas (`20260606000000:36-43`),
      INSERT (`:127-128`), SUM sin filtro de signo (`:100,106`).
- [x] `budget.ts:credit` verificado (`:335-366`) — firma y mapeo de error exactos.
- [x] `compose.ts` catch + debit verificados (`:168-175`, `:339-360`); `agent` const en
      scope del catch confirmado (`:76`).
- [x] `normalizeDestination` export verificado (`spend-policy.ts:50`, import compose.ts:37).
- [x] Tests WKH-128 existentes verificados (`compose.test.ts:1183-1264`) → identificado el
      test que CAMBIA (T-COMPOSE-REFUND-1) y los que NO.
- [x] Exemplar `.real.test.ts` verificado (`refund-atomicity.real.test.ts:1-45`).
- [x] Auto-Blindaje histórico leído (WKH-127, WKH-125b, WKH-125, WKH-SEC-03/04) → 5 CD
      nuevos derivados (CD-9..CD-13).
- [x] Prefijo de migración verificado: `20260624000000` (siguiente tras el último del dir).
- [x] Test plan ≥1 por AC (AC-1..AC-7 todos cubiertos; tabla §6).
- [x] Waves W0-W4 con archivos exactos y dependencias.
- [x] **0 [NEEDS CLARIFICATION]**. El TBD de "tests reales vs mocks" del work-item está
      resuelto: mocks por defecto + opt-in real (espeja el harness existente).

**Estado: LISTO PARA SPEC_APPROVED.**
