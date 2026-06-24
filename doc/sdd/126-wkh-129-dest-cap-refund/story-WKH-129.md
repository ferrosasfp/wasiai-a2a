# Story File — [WKH-129] Reembolso completo del dest-cap — `refund_with_dest_policy`

> **Fase**: F3 (Dev). **Modo**: QUALITY (path de dinero). **Sizing**: S.
> **Branch**: `fix/126-wkh-129-dest-cap-refund`.
> **Contrato autocontenido**: este Story File es la ÚNICA fuente de verdad para el Dev.
> NO releas el SDD. Todo lo que necesitás (snippets, paths, líneas, criterios) está acá.
> **SPEC_APPROVED**: SI.

---

## 0. Contexto compacto (qué se construye y por qué)

Cuando un step de `/compose` falla **tras haber sido debitado** vía `debit_with_dest_policy`
(porque el step tenía `destination`), el reembolso actual (`refund_a2a_key_spend`, vía
`budgetService.credit`) restaura `budget` + `daily_spent` PERO **no revierte la fila del
ledger** `a2a_key_dest_spend_ledger`. Resultado: el headroom del **cap por destino** del
vendor queda consumido aunque el dinero ya se devolvió (over-restricción del cap).

El fix: una RPC NUEVA `refund_with_dest_policy` que revierte **los tres** contadores
(`budget` + `daily_spent` + ledger por destino) en una sola transacción atómica, expuesta
vía `budgetService.creditWithDest(...)` y enganchada en el refund per-step de `compose.ts`.

No hay cambio monetario (en el estado actual no se pierde dinero — el budget/daily ya se
revierte). Esta HU solo elimina la over-restricción del cap por destino.

---

## 1. Scope IN (lista exhaustiva de archivos a tocar)

| # | Archivo | Cambio | Wave |
|---|---------|--------|------|
| 1 | `supabase/migrations/20260624000000_wkh129_refund_with_dest_policy.sql` | NUEVO — `CREATE OR REPLACE FUNCTION refund_with_dest_policy(...)` (up) | W0 |
| 2 | `supabase/migrations/20260624000000_wkh129_refund_with_dest_policy_down.sql` | NUEVO — `DROP FUNCTION IF EXISTS ...` (down) | W0 |
| 3 | `src/services/budget.ts` | NUEVA función `creditWithDest` (insertar tras línea 366, dentro del objeto `budgetService`) | W1 |
| 4 | `src/services/compose.ts` | Reemplazar el bloque del catch L346-359 por el branch `creditWithDest` / `credit` | W2 |
| 5 | `src/services/budget.test.ts` | NUEVO `describe('creditWithDest')` (T-CWD-1/2/3) + T-NOREG-CREDIT | W3 |
| 6 | `src/services/compose.test.ts` | Mock `creditWithDest` + actualizar T-COMPOSE-REFUND-1 + nuevo T-COMPOSE-REFUND-DEST-2 | W3 |
| 7 | `src/__tests__/e2e/refund-with-dest-cap.real.test.ts` | NUEVO — test opt-in Postgres real (T-RWD-REAL-1/2/3) | W4 |

**NO TOCAR** (Scope OUT, CD-6): `debit_with_dest_policy`, `refund_a2a_key_spend` (SQL), la
función `credit` (4-arg) de `budget.ts`, `orchestrate.ts`, el ledger schema, ninguna RPC
previa.

---

## 2. Anti-Hallucination Checklist (verificá ANTES y DESPUÉS de cada wave)

- [ ] **Firma EXACTA** de la nueva función:
      `creditWithDest(keyId: string, chainId: number, amountUsd: number, ownerRef: string, destination: string): Promise<{ success: boolean; error?: string }>`.
      `ownerRef` y `destination` son **`string`, NO `string | undefined`** (CD-8).
- [ ] **RPC name**: `refund_with_dest_policy` (NUEVO nombre — no existe hoy en `supabase/migrations/`; solo existen `refund_a2a_key_spend` y `debit_with_dest_policy`).
- [ ] **RPC params EXACTOS** (snake_case): `{ p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination }`. Cinco params. Mismo orden que la firma SQL.
- [ ] **Fila compensatoria**: `amount_usd = -p_amount_usd` (NEGATIVO). **NUNCA** positivo ni `+p_amount_usd` (CD-4). Si `p_amount_usd <= 0` o `NULL` → no-op, **sin INSERT** (CD-5).
- [ ] **Destination canónico**: `normalizeDestination(\`${agent.registry}/${agent.slug}\`)` — EXACTAMENTE la misma expresión que usó el débito en `compose.ts:174`. `agent` es `const` (L76) y está en scope dentro del catch de la MISMA iteración. PROHIBIDO derivarlo del body del caller u otra fuente (CD-12/CD-13).
- [ ] **Migración aditiva** (CD-3): el up es SOLO `CREATE OR REPLACE FUNCTION` de la función NUEVA. **PROHIBIDO** cualquier `DROP` en el up. No hay overload (nombre nuevo) → no se necesita DROP previo (CD-11).
- [ ] **Firma up == firma down** byte-a-byte: `(uuid, integer, numeric, text, text)` en ambos scripts (CD-11). Si cambiás un tipo de param, actualizá AMBOS.
- [ ] **`credit` (4-arg) NO se toca** (CD-6): orchestrate step-0 (`orchestrate.ts:497-502`) lo usa con 3-4 args sin destination. Debe seguir invocando `refund_a2a_key_spend`.
- [ ] **`prefijo de migración** `20260624000000` confirmado como siguiente disponible (último en el dir = `20260623000000`).
- [ ] **Atomicidad** (CD-1): `FOR UPDATE` sobre `a2a_agent_keys`; los 3 efectos (budget, daily, ledger) en la MISMA tx PL/pgSQL.
- [ ] **Ownership guard DB-layer** (CD-2): `p_owner_ref IS DISTINCT FROM v_row.owner_ref` bajo lock → `RAISE EXCEPTION 'OWNERSHIP_MISMATCH'`.
- [ ] **Mapeo de error en TS** (CD-7): no propagar el msg crudo de PG. `OWNERSHIP_MISMATCH` / `KEY_NOT_FOUND` literales; fallback `REFUND_FAILED` + `console.error('[budget] refund-with-dest failed', ...)`.

---

## 3. Constraint Directives — qué chequear en cada wave

| CD | Regla | Wave donde aplica |
|----|-------|-------------------|
| **CD-1** | Atomicidad: budget+daily+ledger en 1 tx con `FOR UPDATE` en `a2a_agent_keys`. Fallo de cualquier parte → ROLLBACK total. | W0 |
| **CD-2** | Ownership guard DB-layer bajo lock → `RAISE EXCEPTION 'OWNERSHIP_MISMATCH'`. | W0 |
| **CD-3** | Migración aditiva: up solo `CREATE OR REPLACE`. PROHIBIDO `DROP` en el up. Down = `DROP FUNCTION IF EXISTS ... (uuid,integer,numeric,text,text)`. | W0 |
| **CD-4** | PROHIBIDO crear dinero: fila compensatoria estrictamente `-p_amount_usd`. Nunca positivo. | W0 |
| **CD-5** | PROHIBIDO doble-reversa: `p_amount_usd <= 0` o `NULL` → no-op `RETURN`, sin INSERT en ledger. | W0 |
| **CD-6** | PROHIBIDO tocar `debit_with_dest_policy`, `refund_a2a_key_spend`, ni `credit` (4-arg). | W0/W1/W2 |
| **CD-7** | Best-effort en compose: fallo de `creditWithDest` NO cambia el error visible al caller. Solo log `[compose.refund-failed]` con `keyId, chainId, amountUsd, destination, step`. | W2 |
| **CD-8** | `creditWithDest` recibe `ownerRef: string` y `destination: string` (NO optional). | W1 |
| **CD-9** | PROHIBIDO dejar tests pre-existentes con conteos de `credit` sin actualizar cuando el wire cambia la función llamada. `T-COMPOSE-REFUND-1` PASA de `mockCredit` a `mockCreditWithDest`. Grep `mockCredit\b` / `toHaveBeenCalledWith` antes de cerrar W3. | W3 |
| **CD-10** | Testear el INVARIANTE de no-pérdida con el monto real: `refund.amount === debit.amount` (T-COMPOSE-REFUND-DEST-2). En el test real, el SUM del cap vuelve EXACTAMENTE al valor previo al débito. | W3/W4 |
| **CD-11** | Nombre `refund_with_dest_policy` es NUEVO → NO necesita DROP previo. Firma up `(uuid,integer,numeric,text,text)` == firma down EXACTAMENTE. | W0 |
| **CD-12** | `destination` del refund derivado de la MISMA fuente canónica que el débito (`agent.registry`/`agent.slug` del agente RESUELTO por discovery, L76) pasado por el MISMO `normalizeDestination`. PROHIBIDO body crudo del caller. | W2 |
| **CD-13** | Fila compensatoria usa `key_id`, `owner_ref` Y `destination` IDÉNTICOS al débito. Si cualquiera difiere, el SUM no descuenta la reversa. | W0/W2 |

---

## 4. WAVE 0 (serial — contratos SQL) — Migración `refund_with_dest_policy`

### Archivos
- `supabase/migrations/20260624000000_wkh129_refund_with_dest_policy.sql` (up)
- `supabase/migrations/20260624000000_wkh129_refund_with_dest_policy_down.sql` (down)

### Pasos
1. Crear el archivo `_up` con el SQL exacto de abajo (espeja `refund_a2a_key_spend`
   `20260623000000` + el INSERT del ledger de `debit_with_dest_policy` `20260606000000:127-128`).
2. Crear el archivo `_down` con el `DROP` por firma exacta.
3. **Verificar CD-3/CD-11**: el up NO contiene ningún `DROP`. La firma `(uuid, integer, numeric, text, text)` aparece idéntica en `ALTER`, `REVOKE`, `GRANT` (up) y en el `DROP` (down).
4. **Verificar CD-4**: el VALUES del INSERT usa `-p_amount_usd` (negativo).

### SQL UP — copiar literal

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

### SQL DOWN — copiar literal

```sql
-- WKH-129 down: la RPC es 100% aditiva (función NUEVA, no reemplaza ninguna previa),
-- por lo que el rollback es un simple DROP por firma exacta. Reversibilidad total
-- (sin overloads huérfanos — ref auto-blindaje WKH-125 BLQ-MED-1).
DROP FUNCTION IF EXISTS refund_with_dest_policy(uuid, integer, numeric, text, text);
```

### Done de W0
- Ambos archivos creados con el SQL exacto.
- Cubierta por **T-RWD-REAL-1/2/3** (W4, opt-in Postgres real). En el entorno mock no se
  ejecuta SQL; el "done" de W0 es estructural: up sin DROP, INSERT `-p_amount_usd`, firma
  consistente up/down. Verificación final en W4 contra Postgres real (si está habilitado).

---

## 5. WAVE 1 (serial) — `budgetService.creditWithDest` (`src/services/budget.ts`)

### Archivo
- `src/services/budget.ts` — insertar la función NUEVA **inmediatamente después** de `credit`
  (que termina en la línea 366, cierre `},`), dentro del objeto `budgetService`. **NO modificar
  `credit`** (CD-6).

### Patrón a seguir
Espejo EXACTO de `credit` (`budget.ts:335-366`) + el 5º arg `destination` + RPC distinta
(`refund_with_dest_policy` en vez de `refund_a2a_key_spend`) + `destination` en el `console.error`.

### Código — copiar (ajustá indentación al objeto)

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
},
```

### Done de W1
- `creditWithDest` agregada tras `credit` (366), `credit` intacta.
- `npm run build` (tsc) compila sin errores.
- Cubierta por **T-CWD-1/2/3** (W3) y **T-NOREG-CREDIT** (W3).

---

## 6. WAVE 2 (serial) — Wire del refund per-step (`src/services/compose.ts`)

### Archivo
- `src/services/compose.ts` — reemplazar el bloque dentro del `catch` que hoy ocupa las
  **líneas 346-359** (la llamada a `budgetService.credit(...)` + su `if (!creditRes.success)`).
  El `if (...)` guard de las líneas 339-345 **se conserva igual** (no se toca).

### Bloque ACTUAL a reemplazar (compose.ts:346-359)

```ts
          const creditRes = await budgetService.credit(
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
              step: i,
            });
          }
```

### Bloque NUEVO — copiar literal (reemplaza lo de arriba; el `if` guard L339-345 queda igual)

```ts
          // WKH-129: el débito per-step SIEMPRE pasó destination (L174) → revertir el
          // dest-cap además del budget/daily. Mismo normalizador/origen canónico que el
          // débito (agent.registry/agent.slug, agente RESUELTO por discovery — CD-12/CD-13).
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
```

### Notas de implementación
- `normalizeDestination` ya está importado en `compose.ts:37` — NO re-importar.
- `agent` es `const` (L76) y está en scope dentro de este catch (verificado). NO lo redeclares.
- El branch `credit` (sin dest) es **defensivo** (AC-6): solo se alcanzaría si
  `normalizeDestination` devolviera `''` (string vacío → falsy), no alcanzable en el path real
  (un agente resuelto por discovery siempre tiene `registry` y `slug`). Se conserva por robustez.
- **CD-7**: el log estructurado ahora incluye `destination`. El error visible al caller NO cambia.

### Done de W2
- El catch llama `creditWithDest` (5-arg con destination canónico) en el path master.
- `npm run build` compila.
- Cubierta por **T-COMPOSE-REFUND-1** (actualizado) + **T-COMPOSE-REFUND-DEST-2** (nuevo) (W3).

---

## 7. WAVE 3 (paralelizable con W4) — Tests unitarios (mock)

> **W3 y W4 son archivos disjuntos → paralelizables.** Ambas dependen de W0-W2.

### 7.1 — `src/services/compose.test.ts` — SETUP DEL MOCK NUEVO (CRÍTICO, hacer PRIMERO)

El mock de `budget.js` hoy (líneas 17-24) NO tiene `creditWithDest`. Sin esto, todos los
tests del catch fallan con "creditWithDest is not a function".

**(a)** Agregar `creditWithDest: vi.fn()` al mock factory (junto a `credit` en L20):

```ts
vi.mock('./budget.js', () => ({
  budgetService: {
    debit: vi.fn(),
    credit: vi.fn(),
    creditWithDest: vi.fn(),   // WKH-129
    getBalance: vi.fn(),
    registerDeposit: vi.fn(),
  },
}));
```

**(b)** Agregar la ref tipada junto a `mockCredit` (hoy L60-61):

```ts
const mockCredit = vi.mocked(budgetService.credit);
const mockCreditWithDest = vi.mocked(budgetService.creditWithDest);  // WKH-129
```

**(c)** Agregar el default en el `beforeEach` (hoy L139-153, junto a `mockCredit` en L152):

```ts
  // WKH-128: default credit (refund) success.
  mockCredit.mockResolvedValue({ success: true });
  // WKH-129: default credit-with-dest (refund) success.
  mockCreditWithDest.mockResolvedValue({ success: true });
```

### 7.2 — ACTUALIZAR T-COMPOSE-REFUND-1 (compose.test.ts:1185-1210) — CD-9 CRÍTICO

Hoy (L1207-1209) asevera `mockCredit` con 4 args. Tras el wire de W2, el step `corridor`
(que tiene `destination`) llama `creditWithDest` (5-arg), NO `credit`. Reemplazar las
aserciones finales (L1206-1209) por:

```ts
    // WKH-129: se debitó el step 1 (0.05) vía debit_with_dest_policy (tenía destination)
    // → se reembolsa vía creditWithDest con el MISMO destination canónico, MISMO monto.
    expect(mockDebit).toHaveBeenCalledTimes(1);
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
    expect(mockCreditWithDest).toHaveBeenCalledWith(
      'k1',
      2368,
      0.05,
      'owner-test',
      'test-registry/corridor', // normalizeDestination(`${registry}/${slug}`) del agente del step
    );
    // el path 4-arg (credit) NO se usa cuando hay destination.
    expect(mockCredit).not.toHaveBeenCalled();
```

> **Destination canónico**: el agente `corridor` se crea con `makeAgent({ slug: 'corridor', ... })`,
> y `makeAgent` default `registry: 'test-registry'` (compose.test.ts:71). `normalizeDestination`
> hace trim+lowercase → `test-registry/corridor`. Verificado contra los tests de débito existentes
> (compose.test.ts:1125, 1317 ya aseveran `'test-registry/corridor'`).

### 7.3 — NUEVO T-COMPOSE-REFUND-DEST-2 (insertar tras T-COMPOSE-REFUND-1) — CD-10

Invariante de no-pérdida: el monto refundado == el monto debitado, para el mismo step.

```ts
  // WKH-129 (CD-10): invariante de no-pérdida — el refund per-step revierte EXACTAMENTE
  // el monto debitado (ni más ni menos) y con el destination del débito.
  it('T-COMPOSE-REFUND-DEST-2 refund amount equals debit amount for the same step', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk(); // step 0 OK
    mockFetchError(502); // step 1 falla la invocación

    const keyRow = makeKeyRow({ id: 'k1', owner_ref: 'owner-test' });

    const result = await composeService.compose({
      steps: [
        { agent: 'kyc', input: {} },
        { agent: 'corridor', input: {} },
      ],
      scopingKeyRow: keyRow,
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    // el monto debitado del step que falló == el monto refundado (3er arg de ambas calls).
    const debitAmount = mockDebit.mock.calls[0][2];
    const refundAmount = mockCreditWithDest.mock.calls[0][2];
    expect(refundAmount).toBe(debitAmount);
    expect(refundAmount).toBe(0.05);
    // y mismo destination en débito (6º arg de debit) y refund (5º arg de creditWithDest).
    expect(mockDebit.mock.calls[0][5]).toBe('test-registry/corridor');
    expect(mockCreditWithDest.mock.calls[0][4]).toBe('test-registry/corridor');
  });
```

### 7.4 — NO-REGRESIÓN (NO tocar el comportamiento, solo verificar que siguen pasando)

- **T-COMPOSE-REFUND-2** (compose.test.ts:1214-1231): step-0 falla → ni `mockDebit` ni refund.
  Agregar a las aserciones existentes (L1229-1230): `expect(mockCreditWithDest).not.toHaveBeenCalled();`
- **T-COMPOSE-REFUND-3** (compose.test.ts:1237-1264): bajo delegación → ningún refund.
  Agregar (junto a L1263): `expect(mockCreditWithDest).not.toHaveBeenCalled();`

### 7.5 — `src/services/budget.test.ts` — NUEVO `describe('creditWithDest')`

Espejá el `describe` existente de `credit` en ese archivo (mismo harness de mock de `supabase.rpc`).

- **T-CWD-1** (AC-1/AC-2): `creditWithDest('k1', 84532, 0.05, 'owner', 'wasiai/corridor')` →
  `supabase.rpc` llamado con `'refund_with_dest_policy'` y
  `{ p_key_id:'k1', p_chain_id:84532, p_amount_usd:0.05, p_owner_ref:'owner', p_destination:'wasiai/corridor' }`;
  RPC sin error → retorna `{ success: true }`.
- **T-CWD-2** (AC-3): RPC error `{ message: '...OWNERSHIP_MISMATCH...' }` →
  `{ success: false, error: 'OWNERSHIP_MISMATCH' }` (no el msg crudo).
- **T-CWD-3** (AC-2): RPC error genérico → `{ success: false, error: 'REFUND_FAILED' }` +
  `console.error` con `destination`. Caso extra `KEY_NOT_FOUND` → `error: 'KEY_NOT_FOUND'`.
- **T-NOREG-CREDIT** (AC-7) en el `describe('credit')` existente: `credit` 4-arg sigue
  invocando `supabase.rpc('refund_a2a_key_spend', ...)` (NO `refund_with_dest_policy`).
  Back-compat orchestrate intacto.

### Done de W3
- `grep -rn "mockCredit\b\|toHaveBeenCalledWith" src/services/compose.test.ts` → no quedan
  aserciones de `mockCredit` para el step con destination (CD-9).
- `npx vitest run src/services/compose.test.ts src/services/budget.test.ts` → verde.

---

## 8. WAVE 4 (paralelizable con W3) — Test opt-in Postgres real

### Archivo
- `src/__tests__/e2e/refund-with-dest-cap.real.test.ts` (NUEVO)

### Patrón a seguir
Espejá `src/__tests__/e2e/refund-atomicity.real.test.ts` (verificado L1-45):
- Gate `const ENABLED = !!DB_URL && !!SERVICE_KEY;` con `INTEGRATION_TEST_DB_URL` +
  `INTEGRATION_TEST_SERVICE_KEY`. `describe.skipIf(!ENABLED)`. `console.warn` cuando skippea.
- `const TEST_PREFIX = \`wkh129-refund-dest-${Date.now()}\``; `chainId = 84532`.
- `createClient(DB_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })`.
- Seed: key con budget en la chain + una política de destino activa
  (`a2a_key_dest_spend_policies`) `rolling` o `total`, y un débito previo vía
  `debit_with_dest_policy` para tener una fila en `a2a_key_dest_spend_ledger`.

### Tests
- **T-RWD-REAL-1** (AC-1/AC-4): con política `rolling`/`total`:
  (1) `debit_with_dest_policy` → `SUM(amount_usd)` del cap para `(key, dest)` = X;
  (2) `refund_with_dest_policy` mismo `(key, chain, amount, owner, dest)` →
  **SUM del cap vuelve a 0** (la fila `-X` lo descuenta — CD-10);
  (3) budget acreditado de vuelta, `daily_spent_usd` revertido con clamp 0.
- **T-RWD-REAL-2** (AC-3): `refund_with_dest_policy` con `p_owner_ref` ajeno →
  lanza `OWNERSHIP_MISMATCH`; ledger y key SIN modificar (ROLLBACK total).
- **T-RWD-REAL-3** (AC-5): `p_amount_usd <= 0` (y `NULL`) → no-op: NO inserta fila en el
  ledger, NO toca budget/daily.

### Done de W4
- El archivo se skippea limpio sin las env vars (no rompe CI default).
- Con `INTEGRATION_TEST_DB_URL` + `..._SERVICE_KEY` + la migración W0 aplicada, los 3 tests
  pasan contra Postgres real.

---

## 9. Test plan operativo (orden de ejecución, 11 tests)

> Stack: **vitest** (mocks default). Test real: **opt-in** `.real.test.ts`.
> Ejecutar W3 primero (rápido, mock). W4 es opt-in (solo con env vars).

| # | Test ID | AC | Archivo | Caso |
|---|---------|----|---------|------|
| 1 | **T-CWD-1** | AC-1/AC-2 | `budget.test.ts` | `creditWithDest('k1',84532,0.05,'owner','wasiai/corridor')` → `rpc('refund_with_dest_policy', {5 params})`, éxito → `{success:true}`. |
| 2 | **T-CWD-2** | AC-3 | `budget.test.ts` | RPC `OWNERSHIP_MISMATCH` → `{success:false, error:'OWNERSHIP_MISMATCH'}`. |
| 3 | **T-CWD-3** | AC-2 | `budget.test.ts` | RPC genérico → `{success:false, error:'REFUND_FAILED'}` + `console.error` con `destination`; `KEY_NOT_FOUND` → `error:'KEY_NOT_FOUND'`. |
| 4 | **T-NOREG-CREDIT** | AC-7 | `budget.test.ts` | `credit` 4-arg sigue llamando `refund_a2a_key_spend` (NO `refund_with_dest_policy`). |
| 5 | **T-COMPOSE-REFUND-1** ⚠️ ACTUALIZAR | AC-1/AC-6 | `compose.test.ts:1185` | **CRÍTICO (CD-9)**: migrar de `mockCredit` (4-arg) a `mockCreditWithDest` (5-arg, dest `test-registry/corridor`). `mockCredit` NOT called. |
| 6 | **T-COMPOSE-REFUND-DEST-2** (nuevo) | AC-2 | `compose.test.ts` | CD-10: `refundAmount === debitAmount === 0.05`; mismo destination en débito y refund. |
| 7 | **T-COMPOSE-REFUND-2** (no-reg) | AC-5/AC-6 | `compose.test.ts:1214` | step-0 falla → ni debit ni `creditWithDest` ni `credit`. |
| 8 | **T-COMPOSE-REFUND-3** (no-reg) | scope OUT | `compose.test.ts:1237` | bajo delegación → ni `creditWithDest` ni `credit`. |
| 9 | **T-RWD-REAL-1** (opt-in) | AC-1/AC-4 | `refund-with-dest-cap.real.test.ts` | Postgres real: débito → SUM=X; refund → SUM=0; budget+daily revertidos. |
| 10 | **T-RWD-REAL-2** (opt-in) | AC-3 | `refund-with-dest-cap.real.test.ts` | owner ajeno → `OWNERSHIP_MISMATCH`, ROLLBACK total. |
| 11 | **T-RWD-REAL-3** (opt-in) | AC-5 | `refund-with-dest-cap.real.test.ts` | `<=0` / `NULL` → no-op, sin INSERT, sin tocar budget/daily. |

**El punto más crítico**: el #5 (T-COMPOSE-REFUND-1). Es un test WKH-128 pre-existente que
**rompe** tras el wire de W2 si no se migra (asevera `mockCredit`, pero ahora se llama
`mockCreditWithDest`). NO es regresión de producción — es el patrón exacto del auto-blindaje
WKH-127 Wave 5 (CD-9). Sin el setup del mock nuevo (§7.1), el test ni siquiera llega a la
aserción (falla con "creditWithDest is not a function").

---

## 10. Done Definition (de la HU)

- [ ] W0: migración up+down creada; up sin DROP; INSERT `-p_amount_usd`; firma up==down `(uuid,integer,numeric,text,text)`.
- [ ] W1: `creditWithDest` agregada tras `credit`; `credit` intacta; `npm run build` verde.
- [ ] W2: catch de compose usa branch `creditWithDest`/`credit`; `destination` canónico; log con `destination`.
- [ ] W3: mock `creditWithDest` agregado (factory + ref + beforeEach); T-COMPOSE-REFUND-1 migrado; T-COMPOSE-REFUND-DEST-2 nuevo; T-CWD-1/2/3 + T-NOREG-CREDIT en budget.test.ts; `grep mockCredit\b` limpio (CD-9).
- [ ] W4: `refund-with-dest-cap.real.test.ts` creado; skippea limpio sin env vars.
- [ ] `npx vitest run` (suite completa mock) verde — sin regresiones.
- [ ] `npm run build` (tsc strict, sin `any`) verde.
- [ ] Los 13 CD verificados (§3). En especial CD-4 (negativo), CD-6 (no tocar previas), CD-9 (test migrado), CD-12/CD-13 (destination canónico).
