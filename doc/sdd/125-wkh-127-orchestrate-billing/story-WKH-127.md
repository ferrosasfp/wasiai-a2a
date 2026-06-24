# Story File — WKH-127: Orchestrate Billing (precio real + reembolso en fallo)

> Fuente: `doc/sdd/125-wkh-127-orchestrate-billing/sdd.md` (SPEC_APPROVED).
> Este documento es AUTOCONTENIDO. El Dev (F3) lo sigue wave por wave SIN volver
> a leer el SDD completo. Todas las líneas citadas fueron verificadas contra el
> código real (snapshot 2026-06-23).
> Branch: `fix/125-wkh-127-orchestrate-billing`. Framework de tests: **vitest**.

---

## 0. Contexto compacto (qué se construye y por qué)

`/orchestrate` hoy debita **$1 flat** (placeholder del middleware) y **nunca
reembolsa** si el pipeline falla. Incidente real (2026-06-24): usuario con
`budget[43113]=1` corrió una orquestación que falló por config del gateway y
quedó con `budget=0`, `daily_spent=1`, sin valor recibido.

Esta HU resuelve dos cosas acopladas:
- **(A) Precio real**: orchestrate debita `sum(agent.priceUsdc)` del plan, no $1.
- **(B) Credit-back atómico**: si el pipeline falla (total/parcial), restituye lo
  debitado, preservando CD-2 (sin revenue leak en éxito).

**Decisión arquitectónica central (DT-1, ya resuelta en el SDD): Opción B** — el
débito step-0 se **mueve al service** `orchestrateService.orchestrate` (post-plan),
no se duplica el LLM call. El middleware deja de debitar en orchestrate cuando
ve el flag `request.skipMiddlewareDebit`. Todo (débito + cálculo + refund) vive
en un único scope con `debitedUsd` como única fuente de verdad.

**Limitación conocida (CD-9, §4.6 SDD)**: el débito post-plan y el refund aplican
**solo al path master key**. Bajo delegación/session el flag se IGNORA y el débito
step-0 sigue en el middleware (no se reembolsa). Esto evita double-charge.

---

## 1. Scope IN (lista exhaustiva de archivos a tocar)

| # | Archivo | Acción |
|---|---------|--------|
| 1 | `supabase/migrations/20260623000000_wkh127_refund_a2a_key_spend.sql` | **Crear** (RPC up) |
| 2 | `supabase/migrations/20260623000000_wkh127_refund_a2a_key_spend_down.sql` | **Crear** (RPC down) |
| 3 | `src/types/index.ts` | Modificar (`refundError?` en `OrchestrateResult`) |
| 4 | `src/middleware/a2a-key.ts` | Modificar (`declare module` + skip del débito master) |
| 5 | `src/services/budget.ts` | Modificar (agregar `credit()`) |
| 6 | `src/routes/orchestrate.ts` | Modificar (preHandler skip + headers desde el result) |
| 7 | `src/services/orchestrate.ts` | Modificar (pre-check + plannedCost + débito post-plan + refund) |
| 8 | `src/services/orchestrate.test.ts` | Modificar (tests AC-1..AC-11, T-AC-DOUBLE) |
| 9 | `src/middleware/a2a-key.test.ts` | Modificar (T-MW-SKIP-on/off/deleg) |
| 10 | `src/__tests__/e2e/<refund>.real.test.ts` | **Crear** (opt-in DB, T-RPC-refund-atomic) |

**Scope OUT (NO tocar)**: `src/routes/compose.ts`, `src/services/compose.ts`
(guard `i>0`), `runX402Fallback`, `chargeProtocolFee` internals, débitos per-step
(steps 1..N), `increment_a2a_key_spend` (no se reusa con signo negativo).

---

## 2. Anti-Hallucination Checklist (leer ANTES de codear)

NO inventar. Usar EXACTAMENTE estas firmas/valores verificados contra el código:

1. **`budgetService.debit` firma real** (`budget.ts:72-79`):
   `debit(keyId: string, chainId: number, amountUsd: number, delegationContext?, keySessionContext?, destination?)`. Para orchestrate master se usa la forma **3-arg**: `debit(keyId, chainId, amountUsd)` → retorna `{ success: boolean; error?: string }`. NO pasar destino.
2. **`budgetService.getBalance` firma real** (`budget.ts:39-43`):
   `getBalance(keyId: string, chainId: number, ownerId: string): Promise<string>` → devuelve **string** (ej. `"0"`, `"0.5"`). Castear con `Number(...)` para comparar.
3. **`credit()` firma NUEVA exacta** (a crear): `credit(keyId: string, chainId: number, amountUsd: number, ownerRef: string): Promise<{ success: boolean; error?: string }>`. `ownerRef` es **`string`, NO `string | undefined`** (CD-10).
4. **RPC params exactos** (espejo de `increment`): `supabase.rpc('refund_a2a_key_spend', { p_key_id, p_chain_id, p_amount_usd, p_owner_ref })`. NO inventar nombres de params.
5. **El gate del service** para débito/refund es: `scopingKeyRow` presente **Y** `!delegationContext && !keySessionContext` (CD-9/CD-15). x402 → `scopingKeyRow` undefined → se salta TODO (AC-9).
6. **CD-11 (no double-charge)**: el débito step-0 vive EXCLUSIVAMENTE en el service (master con skip) **o** EXCLUSIVAMENTE en el middleware (deleg/session/compose). Nunca ambos.
7. **CD-2 (no refund en éxito)**: refund SOLO si `!pipeline.success`. `success===true` con `totalCostUsdc>0` NUNCA recibe refund.
8. **`pipeline.success` y `pipeline.totalCostUsdc`** existen en `ComposeResult` (`types/index.ts:288,291`). Son los discriminantes de AC-5/AC-6.
9. **`orchestrationId`** se genera en `orchestrate.ts:61` (`crypto.randomUUID()`) y se pasa al service como 2º arg. Es único por request → no se requiere guard de idempotencia en DB.
10. **`scopingKeyRow.id`** y **`scopingKeyRow.owner_ref`** son los campos del `A2AAgentKeyRow` del caller (= `request.a2aKeyRow` augmentado por el middleware). NO inventar otros nombres.
11. **`chainId`** llega al service como `request.chainId` (= `request.resolvedChainId` del middleware, propagado en `orchestrate.ts:89`). Puede ser `number | undefined`.
12. **NO** propagar `reply` al service. Los headers los setea el **route handler** leyendo flags del result (ver Wave 3, decisión [TBD-F2.5] resuelta).
13. **NO** usar `CREATE OR REPLACE` que cambie aridad de una función existente (CD-12, ref WKH-125 BLQ-MED-1). La RPC nueva es 100% aditiva.
14. Spread condicional para `refundError`: seguir el patrón de `feeChargeError` (`orchestrate.ts:513`): `...(refundError !== undefined && { refundError })`.

---

## 3. Decisión del [TBD-F2.5] — mecánica de headers (FIJADA AQUÍ)

El SDD §4.3/§9 dejó dos opciones acotadas. **Se elige la Opción A: el route handler
setea los headers leyendo flags del result. NO se propaga `reply` al service**
(menor acoplamiento service↔reply, consistente con CD-7 y el patrón compose).

### 3.1 `x-debit-fallback: registry-miss` (AC-4)

- El **service** NO toca `reply`. Cuando `plannedCostUsd === 0` y se aplica el
  fallback $1, el service emite el `warn` y **expone un flag en el result**:
  - Campo nuevo en `OrchestrateResult` (interno, no spread condicional porque es
    boolean de control): **`debitFallback?: boolean`** — `true` cuando el service
    aplicó el fallback $1 por costo cero.
- El **route handler** (`orchestrate.ts`, tras `orchestrate(...)`, antes del
  `reply.status(...).send(...)` de L102) hace:
  ```ts
  if (result.debitFallback) {
    reply.header('x-debit-fallback', 'registry-miss');
  }
  ```
- `debitFallback` se incluye en el body via spread condicional (igual que
  `feeChargeError`): `...(debitFallback !== undefined && { debitFallback })`.
  No expone nada sensible (es un boolean).

### 3.2 `x-a2a-remaining-budget` (saldo post-débito real)

Bajo `skipMiddlewareDebit`, el middleware **salta** el seteo post-débito de este
header (`a2a-key.ts:921-928`, que con skip leería un balance no-debitado → sería
incorrecto). Por eso el **route handler** lo setea tras `orchestrate(...)` con el
saldo real post-débito.

- El **service** expone el saldo post-débito en el result: campo nuevo
  **`remainingBudgetUsd?: string`** en `OrchestrateResult`.
  - Se calcula en el service **después** del débito post-plan exitoso, con
    `await budgetService.getBalance(scopingKeyRow.id, chainId, scopingKeyRow.owner_ref)`
    (mismo helper que el middleware usa en L923-927). Devuelve `string`.
  - Si hubo refund (fallo total/parcial), se recalcula **después** del `credit()`
    para reflejar el saldo final real.
  - Si el caller es x402 (`scopingKeyRow` undefined) o deleg/session → el service
    NO setea `remainingBudgetUsd` (queda undefined; el middleware ya seteó el
    header en esos paths como hoy).
- El **route handler**:
  ```ts
  if (result.remainingBudgetUsd !== undefined) {
    reply.header('x-a2a-remaining-budget', result.remainingBudgetUsd);
  }
  ```
- `remainingBudgetUsd` se incluye en el body via spread condicional opcional.

> Nota: estos 3 campos (`debitFallback`, `remainingBudgetUsd`, `refundError`) son
> los únicos campos nuevos en `OrchestrateResult`. Los tres se agregan en W0
> (tipos) y se setean en W4 (service) / leen en W3 (route).

---

## 4. Constraint Directives — operativos por wave

| CD | Qué chequear | Wave(s) |
|----|--------------|---------|
| CD-1 | NO tocar guard `i>0` de `compose.ts` | — (verificar no se toca) |
| CD-2 | refund SOLO si `!pipeline.success`; éxito con `totalCostUsdc>0` jamás reembolsa | W4 |
| CD-3 | RPC refund usa `FOR UPDATE` (estilo `increment`) | W0 |
| CD-4 | RPC refund valida `p_owner_ref`; `credit()` recibe `ownerRef` | W0, W1 |
| CD-5 | NO tocar `runX402Fallback` | W2 (no tocarlo) |
| CD-6 | `refundError` es boolean; NO propagar msg crudo de PG | W1, W4 |
| CD-7 | NO modificar compose (route/service); service NO recibe `reply` | W3, W4 |
| CD-8 | `markSkipMiddlewareDebitHandler` corre ANTES de `requirePaymentOrA2AKey` | W3 |
| CD-9 | flag suprime débito SOLO en path master; deleg/session lo IGNORAN; service gatea por `!delegationContext && !keySessionContext` | W2, W4 |
| CD-10 | `credit()` recibe `ownerRef: string` (NO `\| undefined`) | W1 |
| CD-11 | débito step-0 EXCLUSIVO: service (master+skip) XOR middleware (deleg/session/compose) | W2, W4 |
| CD-12 | RPC 100% ADITIVA (CREATE de función nueva, sin DROP de previas); down = `DROP IF EXISTS` | W0 |
| CD-13 | hardening RPC: `SET search_path` + `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role` | W0 |
| CD-14 | refund nunca crea dinero: `daily_spent_usd` con `GREATEST(..., 0)`; refundUsd ≤ debitedUsd | W0, W4 |
| CD-15 | pre-check + débito post-plan se saltan si `scopingKeyRow` undefined (x402 AC-9) | W4 |

---

## 5. Waves

### W0 — Serial gate: tipos + migración SQL (up+down)

**Depende de**: nada. Es el contrato. **Bloquea** W1-W4.

#### W0.1 — `src/types/index.ts`

Agregar 3 campos a `OrchestrateResult` (`types/index.ts:418-430`), después de
`feeChargeTxHash` (L429), siguiendo el estilo de `feeChargeError`:

```ts
  /** WKH-127 (AC-8): true si el credit-back falló; flag para reconciliación manual. */
  refundError?: boolean;
  /** WKH-127 (AC-4): true si se aplicó el fallback $1 por plannedCost===0; el route setea x-debit-fallback. */
  debitFallback?: boolean;
  /** WKH-127: saldo post-débito (y post-refund) real; el route lo escribe en x-a2a-remaining-budget. */
  remainingBudgetUsd?: string;
```

`OrchestrateRequest` (`types/index.ts:387-416`) ya tiene `scopingKeyRow`,
`delegationContext`, `keySessionContext`, `chainId` → **NO se modifica**.

`skipMiddlewareDebit` se declara en `a2a-key.ts` (W0.2), no aquí (es request
augmentation, no result).

#### W0.2 — `src/middleware/a2a-key.ts` (solo el `declare module`)

En el bloque `declare module 'fastify'` (`a2a-key.ts:57-68`), agregar tras
`keySessionContext` (L67):

```ts
    skipMiddlewareDebit?: boolean; // WKH-127: orchestrate debita post-plan en el service
```

> Solo el tipo en W0. El skip del débito real se hace en W2.

#### W0.3 — Migración UP: `20260623000000_wkh127_refund_a2a_key_spend.sql`

**Exemplar**: `increment_a2a_key_spend` en `20260609000000_wkh_sec02b_owner_ref_rpc.sql:20-101`.
**CD-3/CD-4/CD-12/CD-13/CD-14**. Copiar literal (el SDD §4.2 ya lo da):

```sql
-- ============================================================
-- Migration: 20260623000000_wkh127_refund_a2a_key_spend
-- WKH-127 (AC-5/AC-6/AC-7, CD-3/CD-4): credit-back atómico para reembolsar el
-- débito step-0 de /orchestrate cuando el pipeline falla. Espejo INVERSO de
-- increment_a2a_key_spend (20260609000000): FOR UPDATE + Ownership Guard, pero
-- acredita budget y revierte daily_spent (clamp a 0). Aditiva: el down dropea.
-- ============================================================

CREATE OR REPLACE FUNCTION refund_a2a_key_spend(
  p_key_id     UUID,
  p_chain_id   INT,
  p_amount_usd NUMERIC,
  p_owner_ref  TEXT
) RETURNS void AS $$
DECLARE
  v_row          a2a_agent_keys%ROWTYPE;
  v_chain_key    TEXT;
  v_current_bal  NUMERIC;
  v_new_bal      NUMERIC;
  v_new_daily    NUMERIC;
BEGIN
  -- CD-3: lock atómico (mismo estilo que increment_a2a_key_spend).
  SELECT * INTO v_row
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  -- CD-4: Ownership Guard DB-level (defensa en profundidad; service usa SERVICE_ROLE).
  IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;

  -- Un refund nunca es negativo ni cero. Defensivo: no-op si <= 0.
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RETURN;
  END IF;

  -- Credit budget for the chain (inverso del débito de increment).
  v_chain_key   := p_chain_id::TEXT;
  v_current_bal := COALESCE((v_row.budget ->> v_chain_key)::NUMERIC, 0);
  v_new_bal     := v_current_bal + p_amount_usd;

  -- AC-7 / CD-14: revertir el incremento del daily_spent, clamp a 0 (no crear "deuda").
  v_new_daily := GREATEST(v_row.daily_spent_usd - p_amount_usd, 0);

  UPDATE a2a_agent_keys
  SET
    budget          = jsonb_set(budget, ARRAY[v_chain_key], to_jsonb(v_new_bal::TEXT)),
    daily_spent_usd = v_new_daily,
    last_used_at    = NOW()
  WHERE id = p_key_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- CD-13: Hardening (consistente con los RPCs hermanos, 20260609000000:95-101).
ALTER FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  TO service_role;
```

#### W0.4 — Migración DOWN: `20260623000000_wkh127_refund_a2a_key_spend_down.sql`

**CD-12** (down trivial, ref auto-blindaje WKH-125 BLQ-MED-1):

```sql
-- WKH-127 down: la RPC es 100% aditiva (no reemplaza ninguna función previa),
-- por lo que el rollback es un simple DROP. Reversibilidad total (sin overloads
-- huérfanos, ref auto-blindaje WKH-125 BLQ-MED-1).
DROP FUNCTION IF EXISTS refund_a2a_key_spend(uuid, integer, numeric, text);
```

**Done W0**: tipos compilan (`tsc`/build OK); migración up+down son SQL válido
(no se ejecuta acá — se valida sintaxis y se cubre en T-RPC-refund-atomic en W5).

---

### W1 — `budgetService.credit()` en `src/services/budget.ts`

**Depende de**: W0. **Exemplar**: ruta master de `debit()` (`budget.ts:300-325`).

Agregar un método `credit` al objeto `budgetService` (export L35), después de
`debit` (cierra en L326). **A diferencia de `debit`, NO hace SELECT cold-path**:
recibe `ownerRef` explícito (CD-10, evita un SELECT extra).

```ts
  /**
   * WKH-127 (AC-5/AC-6): credit-back atómico — refund del débito step-0 de
   * /orchestrate cuando el pipeline falla. Espejo INVERSO de la ruta master de
   * debit(): llama la RPC refund_a2a_key_spend (FOR UPDATE + ownership guard).
   * CD-10: ownerRef explícito (string, NO undefined) — el caller orchestrate ya
   * lo tiene en scopingKeyRow.owner_ref → evita el SELECT cold-path de debit().
   */
  async credit(
    keyId: string,
    chainId: number,
    amountUsd: number,
    ownerRef: string,
  ): Promise<{ success: boolean; error?: string }> {
    const { error } = await supabase.rpc('refund_a2a_key_spend', {
      p_key_id: keyId,
      p_chain_id: chainId,
      p_amount_usd: amountUsd,
      p_owner_ref: ownerRef, // CD-4: ownership guard DB-level
    });

    if (error) {
      // CD-6: no propagar msg crudo de PG al cliente.
      if (error.message.includes('OWNERSHIP_MISMATCH')) {
        return { success: false, error: 'OWNERSHIP_MISMATCH' };
      }
      if (error.message.includes('KEY_NOT_FOUND')) {
        return { success: false, error: 'KEY_NOT_FOUND' };
      }
      console.error('[budget] refund failed', {
        keyId,
        chainId,
        amountUsd,
        err: error.message,
      });
      return { success: false, error: 'REFUND_FAILED' };
    }

    return { success: true };
  },
```

**Done W1**: `credit()` existe con la firma exacta; tipa OK. Cubierto por T-AC8 y
T-RPC-refund-atomic (W5).

---

### W2 — Middleware skip del débito master en `src/middleware/a2a-key.ts`

**Depende de**: W0. **Exemplar**: el bloque de débito existente (`a2a-key.ts:847-893`).

Envolver **solo el bloque de débito step-0 del path master** (`a2a-key.ts:852-893`,
desde `const debitResult = ...` hasta el `send403` por insufficient budget) en un
`if (!request.skipMiddlewareDebit) { ... }`.

**Qué se salta** cuando `skipMiddlewareDebit === true`:
- El débito (`debitResult = await budgetService.debit(...)`, L852-861).
- El branch `if (!debitResult.success)` (L862-893) incl. el `send403` insufficient.
- El seteo del header `x-a2a-remaining-budget` (L921-928) — ahora lo hará el route
  handler (W3) con el saldo post-débito del service. **Envolver L921-928 también
  en `if (!request.skipMiddlewareDebit)`** (o el guard equivalente) para no leer
  un balance no-debitado.

**Qué NO se salta** (CRÍTICO — el service los necesita):
- Lookup de la key, `is_active`, signature gate, daily-limit/per-call.
- `resolveTargetChain` → `request.resolvedChainId = chainId` (L826-829).
- El augment `request.a2aKeyRow = keyRow` (L919) y `erc8004_verified` (L918).
- El receipt `budget_debit` (L897-915) **SÍ se salta** junto con el débito (no hubo
  débito en el middleware) — está dentro/después del bloque de débito; va dentro
  del `if (!skipMiddlewareDebit)`.

**CD-9 — el flag aplica SOLO al path master**: este bloque (L824-928) ya es el path
master (los branches session L297 y delegación están ANTES y hacen `return` propio).
NO tocar los branches delegación/session — ahí el flag se ignora naturalmente
porque retornan antes de llegar a L831. Verificar que el `if (!skipMiddlewareDebit)`
NO se agregue en ningún branch deleg/session.

Estructura resultante (pseudo):
```ts
      // 7. Optimistic debit — WKH-127: saltado en orchestrate (débito post-plan en service).
      if (!request.skipMiddlewareDebit) {
        request.log.info({ ...}, 'a2a-key.debit');
        const debitResult = request.composeDestination ? ... : await budgetService.debit(keyRow.id, chainId, estimatedCostUsd);
        if (!debitResult.success) { /* DEST_CAP_EXCEEDED / INSUFFICIENT_BUDGET ... */ }
        receiptService.emit({ ... }).catch(...);
      }

      // 8. Augment request (AC-4) — SIEMPRE (el service lo necesita).
      keyRow.erc8004_verified = isIdentityVerified(keyRow);
      request.a2aKeyRow = keyRow;

      // 9. Remaining budget header — WKH-127: solo si el middleware debitó.
      if (!request.skipMiddlewareDebit) {
        const postDebitBalance = await budgetService.getBalance(keyRow.id, chainId, keyRow.owner_ref);
        reply.header('x-a2a-remaining-budget', postDebitBalance);
      }
```

**Done W2**: T-MW-SKIP-on (skip → no debita, augmenta a2aKeyRow+resolvedChainId),
T-MW-SKIP-off (sin flag → debita $1), T-MW-SKIP-deleg-ignored (W5).

---

### W3 — Route `src/routes/orchestrate.ts`

**Depende de**: W2. **Exemplar**: `resolveComposePriceHandler` como patrón de
preHandler (`compose.ts:62`, registrado en `compose.ts:160` ANTES del middleware).

#### W3.1 — preHandler `markSkipMiddlewareDebitHandler` (CD-8)

Definir, ANTES del `orchestrateRoutes` plugin (o como función módulo, estilo
`resolveComposePriceHandler`):

```ts
async function markSkipMiddlewareDebitHandler(
  request: FastifyRequest,
): Promise<void> {
  // WKH-127: orchestrate debita el costo real post-plan en el service (Opción B).
  // El middleware NO debe debitar el placeholder $1. El flag se respeta SOLO en el
  // path master del middleware (deleg/session lo ignoran — CD-9).
  request.skipMiddlewareDebit = true;
}
```

Registrar en el array `preHandler` (`orchestrate.ts:46-58`) **ANTES** de
`...requirePaymentOrA2AKey({...})` (que está en L54). Insertar justo antes de la
línea `...requirePaymentOrA2AKey(`:

```ts
      preHandler: [
        ...requireForwardKey(),
        createBackpressureHandler(),
        createTimeoutHandler(parseInt(process.env.TIMEOUT_ORCHESTRATE_MS ?? '120000', 10)),
        // WKH-127 (CD-8): marca skip ANTES del middleware de débito.
        markSkipMiddlewareDebitHandler,
        ...requirePaymentOrA2AKey({ description: '...' }),
      ],
```

> Importar `FastifyRequest` del type import de fastify (L10 ya importa de `'fastify'`).

#### W3.2 — Headers desde el result + spread (decisión §3 de este Story File)

En el handler, tras `const result = await orchestrateService.orchestrate(...)`
(L71-92) y el guard `if (reply.sent) return;` (L95), ANTES del
`return reply.status(status).send({ kiteTxHash, ...result });` (L102):

```ts
        // WKH-127 (AC-4): el service decidió el fallback $1 → seteamos el header acá
        // (el service no recibe reply, CD-7).
        if (result.debitFallback) {
          reply.header('x-debit-fallback', 'registry-miss');
        }
        // WKH-127: saldo post-débito (y post-refund) real — el middleware lo saltó
        // bajo skipMiddlewareDebit, así que lo escribe el route con el valor del service.
        if (result.remainingBudgetUsd !== undefined) {
          reply.header('x-a2a-remaining-budget', result.remainingBudgetUsd);
        }
```

El `...result` de L102 ya propaga `refundError`/`debitFallback`/`remainingBudgetUsd`
al body (los tres son campos opcionales del result, vía spread condicional en el
service). No hay que cambiar el `send`.

**Done W3**: el preHandler corre antes del middleware; los headers se setean desde
el result. Cubierto por T-AC4 (header fallback) en W5.

---

### W4 — Service `src/services/orchestrate.ts` (corazón de la HU)

**Depende de**: W1, W2, W3. **Exemplar**: fee best-effort post-compose
(`orchestrate.ts:435-482`); spread condicional `feeChargeError` (`orchestrate.ts:513`).

Importar `budgetService` (`import { budgetService } from './budget.js';`).

#### W4.1 — Helper de gate (master-only) — al inicio del método o como const local

El débito/refund aplican SOLO si: caller master con Agent Key y SIN deleg/session
(CD-9/CD-11/CD-15):

```ts
    const billOnService =
      !!request.scopingKeyRow &&
      !request.delegationContext &&
      !request.keySessionContext;
```

`request.scopingKeyRow` es el `A2AAgentKeyRow` (id, owner_ref). `request.chainId`
es el chainId resuelto (puede ser undefined si algo raro; gatear también por
`request.chainId !== undefined` antes de debitar).

#### W4.2 — Pre-check de balance (early-fail) — ANTES de discovery

Ubicación: tras el cálculo de `feeUsdc` (L246-251), ANTES del
`discoveryService.discover(...)` (L257). **Exemplar**: `getBalance` master
(`budget.ts:39-61`).

```ts
    // WKH-127 (DT-1.1): early-fail sin gastar discovery/LLM si el caller master
    // no tiene fondos. Solo path master (billOnService); x402/deleg/session se saltan.
    if (billOnService && request.chainId !== undefined) {
      const bal = await budgetService.getBalance(
        request.scopingKeyRow!.id,
        request.chainId,
        request.scopingKeyRow!.owner_ref,
      );
      if (Number(bal) <= 0) {
        // Return graceful equivalente a insufficient-budget, sin discovery/LLM.
        return { /* OrchestrateResult con pipeline.success:false? — ver nota */ };
      }
    }
```

> **Nota de diseño para el Dev**: el SDD §4.0/§4.5 pide "return graceful
> equivalente al de insufficient budget SIN llamar discovery/LLM". Reutilizá la
> forma de los returns graceful existentes (`noBudgetResult` L364-377 /
> `emptyResult` L265-278) como plantilla del shape, ajustando `reasoning` a algo
> como `"Insufficient budget for orchestration"`. NO debitar, NO `credit()`. Setear
> `remainingBudgetUsd: bal` para que el route escriba el header. NO inventar campos
> nuevos fuera de los 3 de W0.

#### W4.3 — Calcular `plannedCostUsd` + fallback $1 (AC-1/AC-3/AC-4)

El plan se arma en dos caminos. **LLM path** (L328-353): ya existe `totalCost`
(L330-339), pero es local al bloque `else`. **Greedy path** (`greedyPlan` L189-219):
el cost = `selected.reduce((s,a)=>s+a.priceUsdc,0)`.

Refactor mínimo: declarar `let plannedCostUsd = 0;` en el scope del método (junto
a `let steps`, L298) y asignarlo en **cada** rama que produce steps:
- LLM budgetedAgents path: `plannedCostUsd = totalCost;` (tras el for de L332-339).
- Greedy paths (L324-327, L356-359): exponer la suma. `greedyPlan` ya la calcula
  en `reasoning`; **agregar al return de `greedyPlan`** el campo `cost: number`
  (`selected.reduce(...)`) y asignarlo: `plannedCostUsd = fallback.cost;`.

Tras el guard `if (steps.length === 0)` (L362) — que ya hace return con débito 0
(AC-2) — y antes del débito (W4.4):

```ts
    // AC-4: plannedCost 0 (todos priceUsdc===0) → fallback $1 + warn + flag header.
    let debitFallback = false;
    if (billOnService && plannedCostUsd === 0) {
      console.warn('[orchestrate.price.fallback]', { orchestrationId, reason: 'registry-miss' });
      plannedCostUsd = 1.0;
      debitFallback = true;
    }
```

> El header lo setea el route (W3) leyendo `result.debitFallback`. El service NO
> toca reply.

#### W4.4 — Débito post-plan (AC-1/AC-3, CD-11)

Tras el guard `steps.length===0` y el fallback, ANTES de `composeService.compose`
(L406). Usar la forma **3-arg** de `debit` (master, sin destino):

```ts
    let debitedUsd = 0;
    if (billOnService && request.chainId !== undefined) {
      const debitRes = await budgetService.debit(
        request.scopingKeyRow!.id,
        request.chainId,
        plannedCostUsd,
      );
      if (!debitRes.success) {
        // Insufficient/owner mismatch → return graceful SIN ejecutar compose (§4.5).
        return { /* graceful insufficient, mismo shape que pre-check */ };
      }
      debitedUsd = plannedCostUsd; // ÚNICA fuente de verdad para el refund.
    }
```

> `debitedUsd` es la **única fuente de verdad** del refund (AC-5/AC-6/AC-7).

#### W4.5 — Refund post-compose (AC-5/AC-6/AC-7/AC-8, CD-2/CD-14)

Tras `composeService.compose(...)` (L406-425) y el bloque del fee (L435-482).
**Pseudocódigo del SDD §4.4 — copiar la lógica**:

```ts
    // WKH-127 (DT-3): credit-back post-compose. Solo master Agent Key (CD-9/CD-15:
    // x402 y deleg/session no entran). CD-2: solo si el pipeline NO tuvo éxito.
    let refundError: boolean | undefined;
    let refundUsd = 0;
    if (billOnService && request.chainId !== undefined && !pipeline.success) {
      if (pipeline.totalCostUsdc === 0) {
        refundUsd = debitedUsd;                                  // AC-5 fallo total
      } else {
        refundUsd = Math.max(0, debitedUsd - pipeline.totalCostUsdc); // AC-6 parcial
      }
    }
    if (refundUsd > 0) {
      const creditRes = await budgetService.credit(
        request.scopingKeyRow!.id,
        request.chainId!,
        refundUsd,
        request.scopingKeyRow!.owner_ref,
      );
      if (!creditRes.success) {
        // AC-8: log estructurado + flag, sin msg crudo de PG (CD-6).
        console.error('[orchestrate.refund-failed]', {
          keyId: request.scopingKeyRow!.id,
          chainId: request.chainId,
          amountUsd: refundUsd,
          orchestrationId,
        });
        refundError = true;
      }
    }
```

> **CD-11/anti-doble-refund (§4.4)**: `credit()` se llama **a lo sumo una vez** por
> invocación (`refundUsd` se computa una sola vez; `orchestrationId` único). NO
> agregar reintentos ni guard de idempotencia en DB.

#### W4.6 — `remainingBudgetUsd` post-débito/post-refund

Antes del `return {...}` final (L505-515), si `billOnService`, releer el saldo real:

```ts
    let remainingBudgetUsd: string | undefined;
    if (billOnService && request.chainId !== undefined) {
      remainingBudgetUsd = await budgetService.getBalance(
        request.scopingKeyRow!.id,
        request.chainId,
        request.scopingKeyRow!.owner_ref,
      ).catch(() => undefined);
    }
```

> Se relee DESPUÉS del refund → refleja el saldo final (post-débito o
> post-refund). El route lo escribe en `x-a2a-remaining-budget` (W3).

#### W4.7 — Result final: spread condicional de los 3 campos

Modificar el `return {...}` final (L505-515), agregando tras
`...(feeChargeTxHash !== undefined && { feeChargeTxHash }),` (L514):

```ts
      ...(refundError !== undefined && { refundError }),
      ...(debitFallback && { debitFallback }),
      ...(remainingBudgetUsd !== undefined && { remainingBudgetUsd }),
```

> Aplicar el mismo spread también a los returns graceful (pre-check W4.2, débito
> fallido W4.4) donde corresponda `remainingBudgetUsd` para que el header se setee.

**Done W4**: el flujo completo (pre-check → plannedCost → débito → compose →
refund → remaining) corre; gates CD-9/CD-15 respetados. Cubierto por T-AC1..AC11 +
T-AC-DOUBLE (W5).

---

### W5 — Tests

**Depende de**: W1-W4. Framework: vitest. **Patrón de mocks** (de
`orchestrate.test.ts:11-63`): ya se mockean `discovery`, `compose`, `event`,
`receipt`, `fee-charge`. **AGREGAR un mock de `./budget.js`** con spies sobre
`debit`, `credit`, `getBalance`:

```ts
vi.mock('./budget.js', () => ({
  budgetService: {
    debit: vi.fn().mockResolvedValue({ success: true }),
    credit: vi.fn().mockResolvedValue({ success: true }),
    getBalance: vi.fn().mockResolvedValue('100'),
  },
}));
// import { budgetService } from './budget.js'; // tras los mocks, para los spies
```

Tests a escribir, en orden de implementación:

| # | Test (id) | AC/CD | Archivo | Caso exacto |
|---|-----------|-------|---------|-------------|
| 1 | T-AC1-real-price | AC-1 | `orchestrate.test.ts` | plan 2 agentes ($0.30+$0.20) → `budgetService.debit` llamado con `(_, _, 0.5)`, NO 1 |
| 2 | T-AC2-zero-steps | AC-2 | `orchestrate.test.ts` | `steps.length===0` (todos > budget) → `debit` **0 calls** |
| 3 | T-AC3-uses-real-cost | AC-3 | `orchestrate.test.ts` | monto debitado == `sum(plan priceUsdc)`, no placeholder |
| 4 | T-AC4-zero-cost-fallback | AC-4 | `orchestrate.test.ts` | plan todos `priceUsdc===0` → `debit` con `1.0`; result.`debitFallback===true`; warn emitido |
| 5 | T-AC5-total-fail-refund | AC-5 | `orchestrate.test.ts` | compose mock `{success:false, totalCostUsdc:0}` → `credit` llamado con `debitedUsd` (regresión del incidente) |
| 6 | T-AC6-partial-fail-refund | AC-6 | `orchestrate.test.ts` | (a) `{success:false, totalCostUsdc:0.20}`, debited 0.50 → `credit` con `0.30`; (b) `totalCostUsdc>=debited` → `credit` **0 calls** |
| 7 | T-AC7-budget-restored | AC-7 | `*.real.test.ts` (o service) | tras refund total, balance == previo y daily_spent revertido (clamp 0) |
| 8 | T-AC8-refund-error-flag | AC-8 | `orchestrate.test.ts` | `credit` mock `{success:false}` → `console.error('[orchestrate.refund-failed]', {keyId,chainId,amountUsd,orchestrationId})` + `result.refundError===true`, sin msg PG |
| 9 | T-AC9-x402-no-refund | AC-9 | `orchestrate.test.ts` | request SIN `scopingKeyRow` → `debit` y `credit` **0 calls** |
| 10 | T-AC11-success-no-refund | AC-11 | `orchestrate.test.ts` | compose `{success:true, totalCostUsdc:0.5}` → `credit` **0 calls** (CD-2); fee aplicado |
| 11 | T-AC-DOUBLE-refund | CD-11/§4.4 | `orchestrate.test.ts` | un solo `orchestrate()` en fallo total → `credit` llamado **exactamente 1 vez** |
| 12 | T-MW-SKIP-on | CD-9 | `a2a-key.test.ts` | master + `request.skipMiddlewareDebit=true` → `budgetService.debit` middleware **0 calls**; `a2aKeyRow`+`resolvedChainId` SÍ augmentados |
| 13 | T-MW-SKIP-off | CD-9 reg | `a2a-key.test.ts` | master sin flag (compose/legacy) → debita `1.0` (o composeEstimatedCostUsd) como hoy |
| 14 | T-MW-SKIP-deleg-ignored | CD-9/§4.6 | `a2a-key.test.ts` | branch deleg/session IGNORA el flag → débito step-0 ocurre en el middleware |
| 15 | T-AC10-compose-intact | AC-10 reg | `compose.test.ts` | `resolveComposePriceHandler` + débito step-0 compose intactos (no modificar lógica) |
| 16 | T-RPC-refund-atomic | CD-3/4/14 | `src/__tests__/e2e/<refund>.real.test.ts` | RPC acredita budget, clampa daily_spent a 0, rechaza `OWNERSHIP_MISMATCH` con owner_ref incorrecto. Opt-in (skip sin credenciales), patrón `delegation-atomicity.real.test.ts` |

**Done W5 / Done global**:
- `npm test` (vitest) verde, ≥1 test por AC.
- `biome check` sobre los archivos tocados sin errores (ref auto-blindaje WKH-125b:
  escribir aserciones `Number(...)` ya multilínea para que el formatter no rompa).
- Build TypeScript strict sin `any` explícito.

---

## 6. Done Definition (global)

- [ ] W0: 3 campos en `OrchestrateResult` + `skipMiddlewareDebit` en `declare module`; migración up+down creadas (CD-12/CD-13/CD-14).
- [ ] W1: `budgetService.credit(keyId, chainId, amountUsd, ownerRef)` con `ownerRef: string` (CD-10) + mapeo de error sin PG crudo (CD-6).
- [ ] W2: débito master envuelto en `if (!skipMiddlewareDebit)`; augment de `a2aKeyRow`+`resolvedChainId` SIEMPRE; deleg/session intactos (CD-9/CD-11).
- [ ] W3: `markSkipMiddlewareDebitHandler` ANTES del middleware (CD-8); headers seteados desde el result; service NO recibe `reply` (CD-7).
- [ ] W4: pre-check → plannedCost → débito post-plan → refund AC-5/AC-6 → remaining; gate `billOnService` (CD-9/CD-15); CD-2 (no refund en éxito); anti-doble-refund (§4.4).
- [ ] W5: 16 tests, todos verdes; `biome check` OK; build strict OK.
- [ ] Verificado: NO se tocó `compose.ts` (route/service), `runX402Fallback`, ni el guard `i>0` (CD-1/CD-5/CD-7).

---

*Story File generado por NexusAgil — F2.5 — WKH-127. Decisión [TBD-F2.5] resuelta
en §3 (route-handler setea headers leyendo flags del result).*
