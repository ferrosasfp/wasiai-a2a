# SDD — [WKH-125b] Aplicar el cap de gasto por destino en delegaciones EIP-712

> Modo: QUALITY · SDD_MODE: full · Estimación: M · Branch: `fix/120-wkh-125b-delegation-dest-cap`
> Input: `doc/sdd/120-wkh-125b-delegation-dest-cap/work-item.md` (HU_APPROVED)
> Exemplar maestro: el fix de WKH-125 W3.4 para `debit_session_and_parent`
> (`supabase/migrations/20260606000000_a2a_key_spend_policies.sql:141-232`).

---

## 1. Context Map (archivos leídos — grounding F2 verificado)

| Archivo | Líneas leídas | Por qué / qué patrón extraje |
|---------|---------------|------------------------------|
| `src/services/budget.ts` | 95-130, 153-258 | Rama `if (delegationContext)` (L154): invoca `debitDelegationAndParent` con **5 args, sin destino** (L161-167) y `return { success: true }` (L189) **antes** del bloque dest-aware (L238). `DestCapExceededError` ya importado (L25) y mapeado en la rama session (L116). El bloque session ya mapea `DEST_CAP_EXCEEDED → { success:false, error:'DEST_CAP_EXCEEDED' }` (L117) — **patrón a espejar exacto**. |
| `src/services/delegation.ts` | 17-43, 360-437 | `debitDelegationAndParent` (L377-436): firma de 5 params, `supabase.rpc('debit_delegation_and_parent', {p_delegation_id, p_owner_ref, p_key_id, p_chain_id, p_amount_usd})` (L384-390), mapeo de errores por prefijo de `error.message` (L392-432), fallback que NUNCA propaga msg crudo (L432). Imports de error-classes desde `./security/errors.js` (L30-43) — **`DestCapExceededError` NO está importado allí todavía**. |
| `src/services/key-session.ts` | 14, 435-479 | **PATRÓN A ESPEJAR (TS)**: `debitSessionAndParent` (L440-455) acepta `destination?: string` (L446) y lo pasa como `p_destination: destination ?? null` (L454). Mapea `DEST_CAP_EXCEEDED → DestCapExceededError` (L461-463) **antes** de los prefijos propios. |
| `src/services/budget.ts` (session branch) | 113-149 | El catch de la rama session mapea `DestCapExceededError → 'DEST_CAP_EXCEEDED'` (L116-117). La rama delegación (L190-229) NO lo mapea hoy → hay que **insertar el branch nuevo**. |
| `supabase/migrations/20260606000000_a2a_key_spend_policies.sql` | 1-233 | **EXEMPLAR MAESTRO (SQL)**. L141-232: `DROP FUNCTION IF EXISTS debit_session_and_parent(uuid,text,uuid,integer,numeric)` (L157) → `CREATE OR REPLACE` con `p_destination TEXT DEFAULT NULL` (L165) → dispatch condicional `IF p_destination IS NOT NULL AND p_destination <> '' THEN PERFORM debit_with_dest_policy(...) ELSE PERFORM increment_a2a_key_spend(...)` (L213-217) → hardening `ALTER/REVOKE/GRANT` con firma de 6 params (L227-232). `debit_with_dest_policy` (L55-139): RPC reusado vía PERFORM, **NO se toca**. |
| `supabase/migrations/20260606000000_a2a_key_spend_policies_down.sql` | 1-66 | Patrón de down: `DROP FUNCTION` de la firma nueva → `CREATE OR REPLACE` restaurando la firma vieja → hardening de la vieja. **Mi down lo espeja para `debit_delegation_and_parent`.** |
| `supabase/migrations/20260601000000_a2a_delegations.sql` | 1-114 | Definición **actual** de `debit_delegation_and_parent` (L41-102): firma de 5 params `(UUID, TEXT, UUID, INT, NUMERIC)`, `PERFORM increment_a2a_key_spend` en el paso 5 (L95), hardening con firma `(uuid, text, uuid, integer, numeric)` (L106-111). Está dentro de un `BEGIN; ... COMMIT;` (L6, L113) — mi migración nueva NO necesita BEGIN/COMMIT (cada `supabase migration` corre en su propia tx; el exemplar de spend_policies no usa BEGIN/COMMIT). |
| `supabase/migrations/20260601000000_a2a_delegations_down.sql` | 1-12 | Confirma firma vieja a dropear: `debit_delegation_and_parent(uuid, text, uuid, integer, numeric)`. |
| `src/middleware/a2a-key.ts` | 300-477, 575-644 | **SEGUNDO CALL-SITE (hallazgo crítico, ver §8)**: L379-385 invoca `debitDelegationAndParent` con **5 args** en el **step-0 de un compose bajo delegación**, con un `TODO(WKH-125b)` explícito (L376-378) que dice que NO propaga `composeDestination`. El branch session paralelo (L592-609) **sí** propaga `request.composeDestination` condicionalmente y mapea `DestCapExceededError → HTTP 402` (L614-618). |
| `src/services/delegation.test.ts` | 283-419, 536-537 | Tests existentes de `debitDelegationAndParent`. **T10 (L301-307) asserta `toHaveBeenCalledWith` con exactamente 5 params** → agregar `p_destination` lo rompe salvo que se actualice (ver §6). Mapeo de errores 1:1 con el service. |
| `src/services/budget.test.ts` | 26, 70, 228-300 | Mock de `debitDelegationAndParent`. **T (L264-273) asserta `toHaveBeenCalledWith('del-1','user-1','key-1',2368,0.3)` — 5 args** → se rompe si budget.ts pasa un 6º arg incondicionalmente (ver §6). |
| `src/services/key-session.test.ts` | 380-434 | **PATRÓN A ESPEJAR (test)**: T (L382-390) asserta `p_destination: null` en back-compat; T (L404-417) asserta `p_destination: 'kite/translator'` forwarded; T (L420-434) asserta `DEST_CAP_EXCEEDED → DestCapExceededError`. **Mis tests de delegación son el espejo exacto.** |
| `doc/sdd/114-wkh-125-constraints/auto-blindaje.md` | 1-96 | Lecciones BLQ-MED-1 (CREATE OR REPLACE +1 param = overload → DROP first) y BLQ-ALTO-1 (destino debe ser canónico byte-idéntico). |
| `doc/sdd/116-wkh-sec-02-rls/auto-blindaje.md` | 1-8 | Lección: tests estructurales de SQL deben contar sentencias completas, no substrings (incluyen comentarios). |

---

## 2. Aprendizaje de Auto-Blindaje histórico (3 últimas DONE)

Últimas 3 HUs DONE (por `_INDEX.md`): **#117 WKH-126b** (escrow), **#116 WKH-SEC-02** (RLS), **#114 WKH-125** (constraints).

Patrones recurrentes detectados y trasladados a Constraint Directives:

- **CR-1 (repetido ≥2 veces — directamente aplicable a esta HU)**: `CREATE OR REPLACE FUNCTION` con un parámetro extra crea una **sobrecarga**, no reemplaza. Lección original en WKH-101→WKH-125 (BLQ-MED-1, `114/auto-blindaje#75-95`). Esta HU repite EXACTAMENTE el escenario (agregar `p_destination` a `debit_delegation_and_parent`). → cubierto por **CD-2 (heredado y reforzado)**.
- **CR-2 (WKH-125 BLQ-ALTO-1)**: la clave de débito/cap (`destination`) debe normalizarse a la forma canónica del recurso ANTES de keyear; dos fuentes distintas para el mismo destino → el SELECT de la policy falla el match → bypass del cap. → cubierto por **CD-7 (nuevo)**.
- **CR-3 (WKH-SEC-02)**: los tests estructurales de migraciones SQL deben contar **sentencias DDL completas**, no substrings, porque los comentarios de cabecera mencionan la misma operación. → cubierto por **CD-8 (nuevo)**, aplica si se agrega un test estructural de la migración.

---

## 3. Decisiones técnicas (DT-N)

Se heredan los 6 DT del work-item (DT-1..DT-4 explícitos + los implícitos). Reexpresados y verificados:

- **DT-1 (ESPEJO DEL FIX DE SESSION KEY) — confirmado**. El mecanismo es simétrico a `debit_session_and_parent` (WKH-125 W3.4). El RPC `debit_delegation_and_parent` recibe `p_destination TEXT DEFAULT NULL`; el paso "PERFORM increment_a2a_key_spend" (L95 del exemplar de delegaciones) se reemplaza por un dispatch condicional idéntico a las L213-217 del exemplar de session: `IF p_destination IS NOT NULL AND p_destination <> '' THEN PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination); ELSE PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd); END IF;`. Atomicidad total reusando `debit_with_dest_policy` (que ya hace lock+SUM+check+PERFORM+INSERT en una tx).

- **DT-2 (DROP PREVIO AL CREATE OR REPLACE) — confirmado**. Firma vieja a dropear: `debit_delegation_and_parent(uuid, text, uuid, integer, numeric)` (verificada en `20260601000000_a2a_delegations.sql:106-111` y en su `_down.sql:7`). El `DROP FUNCTION IF EXISTS` va ANTES del `CREATE OR REPLACE` de 6 params. Sin esto se crea overload y el caller de 5 args da `is not unique` (BLQ-MED-1, REPETIDO).

- **DT-3 (FIRMA TS) — corregido respecto del work-item**. El work-item afirma "blast radius de 1 call-site (`budget.ts:161`)". **El grounding F2 encontró un SEGUNDO call-site**: `src/middleware/a2a-key.ts:379` (step-0 de compose bajo delegación). Ambos son rutas de dinero reales y **ambos deben pasar el destino** para cerrar el bypass por completo (ver §8). La firma de `debitDelegationAndParent` agrega `destination?: string` al final (espejo de `debitSessionAndParent`, L446). El parámetro es **opcional** → los call-sites de tests y cualquier llamada de 5 args siguen compilando.

- **DT-4 (OWNER_REF YA DISPONIBLE) — confirmado**. `delegationContext.ownerRef` existe (`budget.ts:163`) y en el middleware `parentKey.owner_ref` (`a2a-key.ts:381`). `debit_with_dest_policy` requiere `p_owner_ref`; el RPC `debit_delegation_and_parent` ya lo recibe (`p_owner_ref`) y lo pasa al dispatch. NO se necesita SELECT adicional.

- **DT-5 (DESTINO YA ES EL 6º PARAM DE `budget.debit()`) — confirmado**. `destination` llega como 6º param de `budgetService.debit()` desde WKH-125. La rama delegación de `budget.ts` sólo lo reenvía a `debitDelegationAndParent`. En el middleware, el destino es `request.composeDestination` (mismo origen canónico que usa el branch session, derivado por `routes/compose.ts:resolveComposePriceHandler` vía `resolveAgentDestination` — fix BLQ-ALTO-1 de WKH-125).

- **DT-6 (FORWARDING CONDICIONAL vs DEFAULT NULL) — decisión de consistencia**. En el **service** (`debitDelegationAndParent`) se pasa `p_destination: destination ?? null` SIEMPRE (espejo de `key-session.ts:454`). En el **middleware** se usa el patrón condicional `if (request.composeDestination) { ...6 args } else { ...5 args }` (espejo exacto de `a2a-key.ts:592-609`) para mantener byte-idénticas las llamadas existentes de 5 args y minimizar el diff de tests. En **budget.ts** se pasa `destination` directo como 6º arg (es `string | undefined`; el service hace el `?? null`).

---

## 4. Constraint Directives (CD-N)

Heredados del work-item (CD-1..CD-6) + nuevos del Auto-Blindaje (CD-7, CD-8):

- **CD-1 (ATOMICIDAD OBLIGATORIA)**: PROHIBIDO chequear el cap en app-layer y debitar en RPC separado. Check cap + INSERT ledger + debit parent budget + UPDATE `total_spent` de la delegación DEBEN ocurrir en la **misma tx PostgreSQL** dentro de `debit_delegation_and_parent` actualizado, vía dispatch a `debit_with_dest_policy`. (AC-4)

- **CD-2 (DROP ANTES DE CREATE OR REPLACE) — REFORZADO por Auto-Blindaje**: OBLIGATORIO `DROP FUNCTION IF EXISTS debit_delegation_and_parent(uuid, text, uuid, integer, numeric)` ANTES del `CREATE OR REPLACE` de 6 params. Sin esto se crea sobrecarga y el caller de 5 args queda roto/ambiguo. Lección BLQ-MED-1 de WKH-125, **referencia: 114/auto-blindaje#75-95 — REPETIDO**.

- **CD-3 (BACK-COMPAT TOTAL)**: PROHIBIDO alterar el comportamiento cuando `p_destination IS NULL` (o `''`). La delegación sin destino DEBE comportarse **byte-idéntico** a hoy: check `total_spent` + check parent budget + `PERFORM increment_a2a_key_spend`, sin ledger, sin cap. (AC-2)

- **CD-4 (NO TOCAR `increment_a2a_key_spend` NI `debit_with_dest_policy`)**: PROHIBIDO modificar firma o cuerpo de `increment_a2a_key_spend` y de `debit_with_dest_policy`. Sólo se **invocan** vía PERFORM.

- **CD-5 (NO PROPAGAR MSG CRUDO PG)**: el prefijo `DEST_CAP_EXCEEDED` en `error.message` DEBE mapearse a `DestCapExceededError` en `delegation.ts` (antes de los prefijos propios, igual que `key-session.ts:461`); `budget.ts` y el middleware lo mapean a `error_code: 'DEST_CAP_EXCEEDED'`. El `error.message` crudo NUNCA llega al cliente. (AC-5)

- **CD-6 (HARDENING BLOCK)**: la migración DEBE incluir `ALTER FUNCTION ... SET search_path = public, pg_temp` + `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role` con la **firma nueva de 6 params** `(uuid, text, uuid, integer, numeric, text)`. Idéntico al hardening de `debit_session_and_parent` (exemplar L227-232).

- **CD-7 (DESTINO CANÓNICO — del Auto-Blindaje BLQ-ALTO-1)**: PROHIBIDO derivar el `destination` que se pasa al RPC desde input crudo del caller. En el middleware DEBE usarse `request.composeDestination` (ya canonicalizado por `resolveAgentDestination`/`normalizeDestination` en WKH-125). En budget.ts se reusa el 6º param de `debit()` (mismo origen). Esto garantiza que el destino keyea byte-idéntico contra `a2a_key_spend_policies.destination`. **Referencia: 114/auto-blindaje#38-73**.

- **CD-8 (TEST SQL POR SENTENCIA — del Auto-Blindaje WKH-SEC-02)**: SI se agrega un test estructural sobre la migración, contar **sentencias DDL completas** (regex de la forma `DROP FUNCTION ... ;` / `CREATE OR REPLACE FUNCTION ...`), NO substrings, porque los comentarios de cabecera mencionan las mismas operaciones. **Referencia: 116/auto-blindaje#3-7**. (Nota: el plan de tests de esta HU prioriza tests de comportamiento sobre estructurales; este CD aplica sólo si el Dev agrega un structural test.)

---

## 5. Waves de implementación

> W0 serial (contrato SQL — fuente de verdad). W1 serial respecto a W0 (TS depende de la firma del RPC). W2 paralelizable (tests). Dentro de cada wave los archivos pueden tocarse en cualquier orden salvo nota.

### W0 — Migración SQL (serial, contrato) — **fuente de verdad**

**Archivo nuevo**: `supabase/migrations/20260608000000_wkh125b_delegation_dest_cap.sql`
(timestamp posterior a `20260607000000_wkh_sec02_rls.sql`, el más reciente).

Contenido (espejo exacto del exemplar `20260606000000_...:141-232`, adaptado a delegación):

1. Comentario de cabecera explicando el fix, el dispatch y la referencia a BLQ-MED-1.
2. `DROP FUNCTION IF EXISTS debit_delegation_and_parent(uuid, text, uuid, integer, numeric);` **(CD-2)**.
3. `CREATE OR REPLACE FUNCTION debit_delegation_and_parent(p_delegation_id UUID, p_owner_ref TEXT, p_key_id UUID, p_chain_id INT, p_amount_usd NUMERIC, p_destination TEXT DEFAULT NULL) RETURNS NUMERIC` — cuerpo **idéntico** al actual (`20260601000000:41-102`: lock delegación → ownership guard → revoked/expiry → check `total_spent`), salvo el paso 5:
   - **Reemplazar** `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);` (L95)
   - **Por** el dispatch condicional (espejo de exemplar L213-217):
     ```
     IF p_destination IS NOT NULL AND p_destination <> '' THEN
       PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
     ELSE
       PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);
     END IF;
     ```
   - El paso 6 (`UPDATE a2a_delegations SET total_spent = v_new_total ...`) queda igual. El orden 4(total_spent check) → 5(dispatch) → 6(update) preserva el rollback total ante `DEST_CAP_EXCEEDED`/`INSUFFICIENT_BUDGET` (AC-1/AC-4). **`LANGUAGE plpgsql SECURITY DEFINER`**.
4. Hardening de la firma nueva de 6 params **(CD-6)**:
   ```
   ALTER FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text) SET search_path = public, pg_temp;
   REVOKE EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text) FROM PUBLIC, anon, authenticated;
   GRANT EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text) TO service_role;
   ```

**Archivo nuevo**: `supabase/migrations/20260608000000_wkh125b_delegation_dest_cap_down.sql`
(espejo de `20260606000000_..._down.sql:1-61`):
1. `DROP FUNCTION IF EXISTS debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text);`
2. `CREATE OR REPLACE FUNCTION debit_delegation_and_parent(...5 params...)` restaurando el cuerpo original (copiar literal de `20260601000000:41-102`, con `PERFORM increment_a2a_key_spend` en el paso 5).
3. Hardening de la firma vieja de 5 params (copiar literal de `20260601000000:106-111`).

> Nota: el exemplar de spend_policies NO envuelve en `BEGIN;/COMMIT;` (el de delegaciones sí). Seguir el estilo del **exemplar maestro** (sin BEGIN/COMMIT) por consistencia con la migración que se está espejando. El runner de migraciones envuelve cada archivo en su propia tx.

### W1 — Capa TypeScript (serial respecto a W0)

**Archivo `src/services/delegation.ts`**:
- Importar `DestCapExceededError` desde `./security/errors.js` (agregar a la lista L30-43; **hoy NO está importado en delegation.ts** — verificado).
- `debitDelegationAndParent`: agregar `destination?: string` al final de la firma (espejo de `key-session.ts:446`).
- En el body del `rpc(...)`: agregar `p_destination: destination ?? null` al objeto de params (espejo de `key-session.ts:454`).
- En el bloque de mapeo de errores: agregar **al inicio** (antes de los prefijos propios, igual que `key-session.ts:461-463`):
  ```
  if (msg.includes('DEST_CAP_EXCEEDED')) { throw new DestCapExceededError(); }
  ```

**Archivo `src/services/budget.ts`** (rama delegación, L154-230):
- En la llamada `delegationService.debitDelegationAndParent(...)` (L161-167): agregar `destination` como 6º arg. `destination` ya está en scope (6º param de `debit()`, DT-5).
- En el catch (L190-229): agregar **antes** del primer branch existente (junto al patrón de la rama session L116-117):
  ```
  if (err instanceof DestCapExceededError) { return { success: false, error: 'DEST_CAP_EXCEEDED' }; }
  ```
  (`DestCapExceededError` ya está importado en budget.ts, L25 — verificado.)

**Archivo `src/middleware/a2a-key.ts`** (step-0 delegación, L375-385 — SEGUNDO CALL-SITE, §8):
- Reemplazar la llamada incondicional de 5 args por el patrón **condicional** espejo del branch session (L592-609):
  ```
  if (request.composeDestination) {
    await delegationService.debitDelegationAndParent(delegation.id, parentKey.owner_ref, parentKey.id, chainId, estimatedCostUsd, request.composeDestination);
  } else {
    await delegationService.debitDelegationAndParent(delegation.id, parentKey.owner_ref, parentKey.id, chainId, estimatedCostUsd);
  }
  ```
- Actualizar el comentario `TODO(WKH-125b)` (L376-378) → comentario que documente que ahora SÍ propaga el cap (espejo del comentario session L582-591).
- En el catch del débito (L386-452): agregar **antes** del primer branch (espejo de session L614-618):
  ```
  if (debitErr instanceof DestCapExceededError) {
    return reply.status(402).send({ error: `chain ${chainId} destination cap exceeded`, error_code: 'DEST_CAP_EXCEEDED' });
  }
  ```
  (`DestCapExceededError` ya importado en a2a-key.ts, L37 — verificado.)

### W2 — Tests (paralelizable)

Ver §7. Archivos: `src/services/delegation.test.ts`, `src/services/budget.test.ts`, `src/middleware/a2a-key.test.ts`.

---

## 6. Tests existentes que rompen (y por qué) — Anti-regresión

| Test | Archivo:línea | Rompe porque | Acción |
|------|---------------|--------------|--------|
| T10 success `debitDelegationAndParent` | `delegation.test.ts:301-307` | Asserta `toHaveBeenCalledWith('debit_delegation_and_parent', {…5 keys…})`. Tras W1, el service agrega `p_destination: null`. | Agregar `p_destination: null` al objeto esperado (espejo de `key-session.test.ts:382-390`). |
| Delegation path debit | `budget.test.ts:264-273` | Asserta `toHaveBeenCalledWith('del-1','user-1','key-1',2368,0.3)` — 5 args. Tras W1, budget.ts pasa `destination` como 6º arg. En este test no hay destino en `DELEGATION_CTX` → el 6º arg será `undefined`. | Espejar el assert del branch session: o bien `toHaveBeenCalledWith(..., undefined)` o relajar a `expect.objectContaining`/posicional con 6º `undefined`. Verificar cómo está la firma de `budget.debit` en el test (si llama sin destino, el 6º arg es `undefined`). |

> El Dev debe correr `npx vitest run src/services/delegation.test.ts src/services/budget.test.ts src/middleware/a2a-key.test.ts` y ajustar SOLO estas aserciones de aridad. NO relajar aserciones de comportamiento.

---

## 7. Plan de tests (≥1 por AC — mapeo AC→test)

Espejo directo de `key-session.test.ts:404-434` y `budget.test.ts` (rama session).

| AC | Test (descripción) | Archivo | Tipo |
|----|--------------------|---------|------|
| **AC-1** (cap excedido vía delegación → DEST_CAP_EXCEEDED) | `mockRpc` devuelve `error.message = 'DEST_CAP_EXCEEDED: dest x accum 1 + 1 > cap 1'` → `debitDelegationAndParent('d','o','k',1,1,'kite/translator')` rejects `DestCapExceededError`. | `delegation.test.ts` | mock RPC |
| **AC-1** (budget NO se decrementa — semántica) | En budget.ts: `mockDebitDelegation.mockRejectedValue(new DestCapExceededError())` → `budget.debit(...,destination)` devuelve `{ success:false, error:'DEST_CAP_EXCEEDED' }` y NO emite receipt. | `budget.test.ts` | mock service |
| **AC-1** (middleware step-0 → HTTP 402) | En a2a-key.test.ts: forzar `DestCapExceededError` del débito de delegación step-0 con `request.composeDestination` seteado → respuesta `402` + `error_code:'DEST_CAP_EXCEEDED'`. | `a2a-key.test.ts` | integration mock |
| **AC-2** (back-compat sin política → 5-arg/p_destination null) | `debitDelegationAndParent('del-1','user-1','key-1',2368,0.3)` (sin destino) → `toHaveBeenCalledWith('debit_delegation_and_parent', {…, p_destination: null})`. Espejo de `key-session.test.ts:382-390`. | `delegation.test.ts` | mock RPC |
| **AC-2** (middleware sin composeDestination → 5-arg intacto) | Step-0 de delegación SIN `request.composeDestination` → `debitDelegationAndParent` llamado con 5 args (no 6). Espejo del branch session. | `a2a-key.test.ts` | integration mock |
| **AC-3** (ventana rolling) | El cómputo de la ventana vive en `debit_with_dest_policy` (NO se toca) y ya está cubierto por los tests de WKH-125. A nivel delegación se verifica que el destino se **forwardea** (`p_destination: 'kite/translator'`) → `debitDelegationAndParent(...,'kite/translator')` → `toHaveBeenCalledWith(..., expect.objectContaining({ p_destination: 'kite/translator' }))`. Espejo de `key-session.test.ts:404-417`. El comportamiento rolling end-to-end se cubre en el e2e de atomicidad (abajo). | `delegation.test.ts` | mock RPC |
| **AC-4** (atomicidad) | La atomicidad real (no-double-spend bajo concurrencia + rollback) se cubre en el e2e gateado por DB: `src/__tests__/e2e/delegation-atomicity.real.test.ts`. **Verificar con `Read` si ya existe** (aparece en el listado de tests). Si existe, agregar/adaptar un caso: débito de delegación con destino que excede el cap → la tx hace ROLLBACK (parent budget y `total_spent` sin cambios, ledger sin INSERT). Los mocks de `delegation.test.ts` cubren el mapeo, NO la atomicidad (ya documentado en `delegation.test.ts:285-290`). | `delegation-atomicity.real.test.ts` | e2e (INTEGRATION_TEST_DB_URL) |
| **AC-5** (no propagar msg crudo PG) | `DEST_CAP_EXCEEDED` con detalle PG (`'DEST_CAP_EXCEEDED: dest x accum 1 + 1 > cap 1'`) → `DestCapExceededError` cuyo `.message` NO contiene `'accum'`/`'cap'`. Espejo del assert de `delegation.test.ts:377-379` (AR-MNR-1). | `delegation.test.ts` | mock RPC |

> El Dev debe leer `src/__tests__/e2e/delegation-atomicity.real.test.ts` y `src/services/key-session.test.ts` (T's de dest-cap) como exemplars de forma antes de escribir.

---

## 8. Hallazgo de grounding — SEGUNDO call-site (discrepancia con DT-3 del work-item)

El work-item (DT-3) afirma que `debitDelegationAndParent` tiene **un solo** call-site (`budget.ts:161`). El grounding F2 encontró un **segundo**: `src/middleware/a2a-key.ts:379`, en el **step-0 de un compose bajo delegación**, con un `TODO(WKH-125b)` explícito (L376-378) que dice literalmente que NO propaga `composeDestination` "porque WKH-125 dejó delegaciones fuera de scope".

**Implicación de seguridad**: este call-site ES una ruta de dinero real. El step-0 de un compose con una **session key de delegación** debita el primer agente del pipeline. Si no propaga el destino, el cap por destino se evade en el step-0 — **el mismo bypass que esta HU cierra en el branch service**. Cerrar sólo `budget.ts` dejaría el step-0 de delegación todavía vulnerable.

**Decisión (NO es scope-creep, es completar el AC)**: AC-1 dice "WHEN se realiza un débito vía `delegationContext`". El step-0 del middleware ES un débito de delegación (crea el `delegationContext` justo después, L472-477). Por lo tanto, cerrar el bypass requiere tocar **ambos** call-sites. El fix del middleware es el espejo EXACTO del branch session ya existente (L592-618), riesgo bajo, y elimina el `TODO(WKH-125b)` que apunta a esta misma HU.

`src/middleware/a2a-key.ts` se **agrega al Scope IN** (no estaba en el work-item). Esta es la única ampliación de scope, justificada por evidencia archivo:línea. El resto del SDD respeta el Scope IN/OUT del work-item al pie de la letra.

> Si el humano prefiere acotar esta HU sólo al branch service y diferir el middleware a una HU separada, marcar y escalar. **Recomendación del Architect: incluirlo** — es el mismo bug, el mismo patrón, y dejarlo abierto reintroduce el bypass por la ruta compose+delegación.

---

## 9. Exemplars verificados (paths confirmados con Read)

| Exemplar | Path:línea | Verificado |
|----------|-----------|------------|
| Fix SQL de session key (DROP + CREATE OR REPLACE + dispatch + hardening) | `supabase/migrations/20260606000000_a2a_key_spend_policies.sql:141-232` | ✅ leído |
| Down SQL de session key | `supabase/migrations/20260606000000_a2a_key_spend_policies_down.sql:1-61` | ✅ leído |
| RPC actual de delegación (a modificar) | `supabase/migrations/20260601000000_a2a_delegations.sql:41-111` | ✅ leído |
| `debit_with_dest_policy` (reusado, NO se toca) | `supabase/migrations/20260606000000_a2a_key_spend_policies.sql:55-139` | ✅ leído |
| Service TS espejo (`debitSessionAndParent` con `destination?`) | `src/services/key-session.ts:440-479` | ✅ leído |
| budget.ts rama session (mapeo `DEST_CAP_EXCEEDED`) | `src/services/budget.ts:113-117` | ✅ leído |
| Middleware branch session (forwarding condicional + 402) | `src/middleware/a2a-key.ts:582-618` | ✅ leído |
| Tests espejo (dest-cap session) | `src/services/key-session.test.ts:380-434` | ✅ leído |
| `DestCapExceededError` | `src/services/security/errors.ts:317` | ✅ confirmado por grep |

---

## 10. Nota para el siguiente HU del batch (WKH-SEC-02b)

WKH-SEC-02b tocará el mismo RPC. **Firma final que deja esta HU**:

```sql
debit_delegation_and_parent(
  p_delegation_id UUID,
  p_owner_ref     TEXT,
  p_key_id        UUID,
  p_chain_id      INT,
  p_amount_usd    NUMERIC,
  p_destination   TEXT DEFAULT NULL   -- ← NUEVO en WKH-125b
) RETURNS NUMERIC
```

Hardening firmado: `(uuid, text, uuid, integer, numeric, text)`.

El dispatch interno hace `PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination)` cuando hay destino. `p_owner_ref` **ya se propaga** al PERFORM. Si SEC-02b necesita reforzar ownership a nivel del RPC de delegación (p.ej. pasar `p_owner_ref` a `increment_a2a_key_spend` o agregar un check extra), debe:
1. Crear una migración con timestamp **posterior** a `20260608000000`.
2. Hacer `DROP FUNCTION IF EXISTS debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text);` (la firma de **6 params** que deja esta HU) antes de su `CREATE OR REPLACE` — **NO** la de 5 params (esa ya no existe tras esta HU).
3. Preservar el `p_destination TEXT DEFAULT NULL` y el dispatch a `debit_with_dest_policy` (no regresionar el cap).

---

## 11. Readiness Check

- [x] Work-item leído completo (6 DT, 6 CD, 5 AC, Scope IN/OUT).
- [x] `project-context.md` leído — stack Fastify + Supabase + TS strict confirmado; sin drift.
- [x] Exemplar maestro SQL verificado con Read (`20260606000000_a2a_key_spend_policies.sql:141-232`).
- [x] RPC actual de delegación verificado (firma de 5 params confirmada en 2 archivos).
- [x] Service espejo TS verificado (`key-session.ts:440-455`, `461-463`).
- [x] `DestCapExceededError` localizado (`security/errors.ts:317`); confirmado import en budget.ts (L25) y a2a-key.ts (L37); confirmado **ausente** en delegation.ts (hay que agregarlo).
- [x] Tests que rompen identificados con archivo:línea (delegation.test.ts:301, budget.test.ts:264).
- [x] Segundo call-site identificado y justificado (a2a-key.ts:379) — discrepancia con DT-3 surfaced.
- [x] Auto-Blindaje histórico revisado (3 DONE) → CD-2 reforzado, CD-7/CD-8 nuevos.
- [x] Plan de tests cubre los 5 AC con archivo destino y exemplar de forma.
- [x] Down migration especificada y reversible.
- [x] Nota para SEC-02b documentada con firma final.
- [x] **0 [NEEDS CLARIFICATION]**. Única decisión que requiere confirmación humana opcional: incluir o no el segundo call-site (a2a-key.ts) en esta HU — recomendación del Architect: incluirlo (mismo bug). Si se excluye, el SDD se acota a Scope IN original sin otros cambios.

**SDD listo para SPEC_APPROVED.**
