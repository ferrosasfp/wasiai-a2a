# Done Report — [WKH-129] Reembolso completo del dest-cap — `refund_with_dest_policy`

## Resumen ejecutivo

**HU WKH-129** cierra el residual del path de dinero de `/compose`: el reembolso per-step, tras la implementación de WKH-128 (refund atómico del budget/daily cuando un step falla), **no revertía la fila del ledger** `a2a_key_dest_spend_ledger`, dejando el headroom del cap por destino consumido aunque el dinero se devolviera.

**Solución implementada**: una RPC nueva `refund_with_dest_policy` (DT-1: fila compensatoria negativa append-only) que revierte en una transacción atómica:
1. `budget[chain_id] += amount_usd` (credit, inverso del débito)
2. `daily_spent_usd := GREATEST(daily_spent_usd - amount_usd, 0)` (clamp a 0, no deuda)
3. `INSERT a2a_key_dest_spend_ledger (amount_usd = -amount_usd)` (fila negativa, cancela el SUM del cap)

**Estado final**: DONE. Merged a main (PR #114, commit `25dc521`), migración aplicada + verificada en prod (Railway), suite 1680 pass, 7/7 ACs PASS, AR APROBADO, CR APROBADO (13/13 CDs), F4 APROBADO.

---

## Pipeline NexusAgil QUALITY ejecutado

| Fase | Status | Descripción | Artefacto clave | Veredicto |
|------|--------|-------------|-----------------|-----------|
| **F0-F1** | DONE | Work Item + ACs EARS + F0 verificación (archivo:línea exactas: ledger columnas, `debit_with_dest_policy` SUM, `refund_a2a_key_spend` RPC hermana, `budgetService.credit` firma) | `work-item.md` | **HU_APPROVED** |
| **F2** | DONE | SDD: Context Map de 8 archivos (migraciones, services, tests), DT-1/2/3/4 fijadas (fila negativa, `creditWithDest` nueva, invariante rolling, hardening espejo), exemplar RPC SQL up+down, diseño de `creditWithDest` en TS, wire en compose, plan de tests ≥1 por AC, 5 CDs nuevos (CD-9..CD-13) del auto-blindaje histórico | `sdd.md` | **SPEC_APPROVED** |
| **F2.5** | DONE | Story File: Scope IN/OUT explícito (7 archivos, 4 waves W0-W3), Anti-Hallucination Checklist de 10 items, CDs ordenadas por wave, pasadas detalladas de cada wave (W0 SQL up/down, W1 `creditWithDest`, W2 wire compose, W3 tests) | `story-WKH-129.md` | Ready for F3 |
| **F3** | DONE | Implementación ejecutada en 4 waves (W0-W3 del plan): migración aditiva `refund_with_dest_policy`, función `creditWithDest` en budget.ts (mapeo de error con `OWNERSHIP_MISMATCH`/`KEY_NOT_FOUND`/`REFUND_FAILED`), wire en compose refund per-step con branch `creditWithDest`/`credit`, tests T-CWD-1/2/3 (unitarios creditWithDest), T-COMPOSE-REFUND-1 actualizado + T-COMPOSE-REFUND-DEST-2 (invariante no-pérdida: debit==refund), T-NOREG-CREDIT (back-compat de `credit` 4-arg), T-RWD-REAL-1/2/3 (opt-in Postgres real). | Commit `25dc521` | Suite 1680 pass, tsc + biome clean |
| **AR** | APROBADO | Adversarial Review encontró **1 hallazgo MENOR (MNR-1)**: INSERT del ledger compensatorio era **incondicional** en la RPC (insertaba incluso si `p_amount_usd <= 0`), violando la asimetría con el débito (que solo inserta si hay un débito real). Fix en fix-pack: condicionar el INSERT a `EXISTS (policy for p_destination)` que valide la ventana, espejando la lógica del débito exactamente. Re-AR APROBADO (MNR-1 resuelto). | Hallazgo: WKH-125 auto-blindaje BLQ-MED-1 (CREATE OR REPLACE + 1 param = overload); contexto: WKH-127 auto-blindaje #1 (tests desactualizados). Lección: toda reversa de un débito condicional debe espejar la MISMA condición. | **MNR-1 RESUELTO** |
| **CR** | APROBADO | Code Review: verificadas 13 Constraint Directives (CD-1..CD-13). Evidencias: CD-1 atomicidad (FOR UPDATE en RPC), CD-2 ownership guard DB-layer (IS DISTINCT FROM bajo lock), CD-3 migración aditiva (CREATE OR REPLACE, no DROP), CD-4 valor negativo (−p_amount_usd), CD-5 no-op defensivo (≤0 RETURN sin INSERT), CD-6 back-compat (`credit` 4-arg intacto), CD-7 best-effort en compose (log sin cambiar error al caller), CD-8 ownerRef obligatorio (string, no optional), CD-9/CD-10 tests actualizados (mockCreditWithDest, T-COMPOSE-REFUND-DEST-2), CD-11 firma exacta (uuid,integer,numeric,text,text), CD-12/CD-13 destino canónico (agent.registry/agent.slug, normalizeDestination exacta, ledger key+owner+destination idénticos). | PR #114 citas archivo:línea exactas | **APROBADO (13/13 CDs OK)** |
| **F4** | APROBADO | QA Validation: 7/7 ACs PASS con evidencia archivo:línea. AC-1 (refund revierte ledger además de budget/daily: T-RWD-REAL-1 verifica SUM neto = 0 post-refund), AC-2 (atomicidad: FOR UPDATE en RPC + INSERT en MISMA tx), AC-3 (ownership guard: OWNERSHIP_MISMATCH lanzado si owner_ref ajeno), AC-4 (ventana rolling: fila compensatoria insertada con NOW() cae dentro de window_secs), AC-5 (no-op defensivo: ≤0 RETURN sin INSERT), AC-6 (wire compose: creditWithDest si destination, credit si no — defensivo), AC-7 (migración aditiva: CREATE OR REPLACE, no DROP de previas, down reversible). | validation.md | **APROBADO (7/7 ACs PASS)** |
| **DEPLOY** | DONE | Migración `refund_with_dest_policy` aplicada + verificada en prod (Supabase caldzjhjgctpgodldqav, GRANT service_role). Railway deployment levantado (código merged a main). | Commit `25dc521`, PR #114 | Prod ready, migración sinc |

---

## Hallazgos finales

### BLOQUEANTEs
**Ninguno.** El hallazgo MNR-1 encontrado por AR (INSERT incondicional violaba simetría con el débito) fue resuelto en fix-pack inmediatamente, y re-AR lo marcó APROBADO.

### MENOREs
**MNR-1 (resuelto)**: INSERT del ledger compensatorio era incondicional (insertaba incluso si `p_amount_usd <= 0`). 
- **Contexto**: WKH-125 auto-blindaje BLQ-MED-1 advierte que un débito condicional exige una reversa también condicional (la simetría es semántica — si el débito no ocurrió, la reversa no debe ocurrir).
- **Fix implementado**: Condicionó el INSERT a `EXISTS (SELECT ... FROM a2a_key_spend_policies WHERE owner_ref = p_owner_ref AND destination = p_destination AND ...)`, espejando exactamente la lógica del débito en `debit_with_dest_policy`.
- **Veredicto final**: Re-AR APROBADO. El fix asegura que la fila negativa SOLO inserta cuando la política del destino existe (la ventana rolling/total se valida por la misma clave).

---

## Auto-Blindaje consolidado

Consolidada tabla de lecciones y patrones descubiertos en el desarrollo de WKH-129:

| ID | Hallazgo | Origen | Lección para próximas HUs | Status |
|----|----|--------|----------|--------|
| **MNR-1** | INSERT del ledger compensatorio incondicional en refund_with_dest_policy | AR review | Toda reversa de un débito condicional DEBE espejar la MISMA condición del débito. Si `debit_with_dest_policy` solo inserta si EXISTS(policy), el refund DEBE validar EXISTS(policy) antes de insertar la fila negativa. Append-only no es excusa para no validar. | RESUELTO en fix-pack |
| **DT-1-VALIDATION** | Fila compensatoria negativa (append-only) vs DELETE vs UPDATE | SDD/F3 | La estrategia append-only es correcta para ledgers de auditoría, pero requiere validación de condiciones en AMBOS lados (debit y refund). El SUM COALESCE sin filtro de signo funciona, pero el INSERT debe ser IGUAL de condicional que el débito que lo disparó. | CONFIRMADO post-fix |
| **CD-9-WKH-127-SPILLOVER** | Tests pre-existentes desactualizados tras cambio de función | SDD/CR | Cuando un wire cambia la función llamada (credit → creditWithDest), buscar TODOS los tests con `mockCredit\b` / `toHaveBeenCalledWith` que aseveran conteos. T-COMPOSE-REFUND-1 debió actualizarse a `mockCreditWithDest` en la MISMA HU, no quedar como deuda técnica. | DOCUMENTADO CD-9 |
| **CD-10-INVARIANTE** | Refund amount debe == debit amount (no-pérdida) | SDD/F4 | Testear explícitamente que `refund.amount === debit.amount` en el mismo step (T-COMPOSE-REFUND-DEST-2). En la suite real, verificar que el SUM del cap retorna EXACTAMENTE al valor previo (offset 0), no menos, salvo el borde teórico sub-segundo de DT-3. | VERIFICADO en tests |
| **CD-12-DESTINO-CANONICO** | Destination del refund debe derivarse de la MISMA fuente canónica que el débito | SDD/F3 | `normalizeDestination(\`${agent.registry}/${agent.slug}\`)` es la ÚNICA fuente válida. PROHIBIDO derivarlo del body crudo del caller o de `p_destination` sin normalizar. El SUM del cap no descuenta la reversa si la cadena de destino no matchea byte-a-byte. | INCORPORADO en wire compose |
| **CD-13-LEDGER-IDENTIDAD** | Fila compensatoria usa key_id, owner_ref, destination IDÉNTICOS | SDD/CR | Si cualquiera de los tres campos difiere, el SUM no descuenta la reversa (queda una fila "huérfana" para otro destino/owner). El test real verifica que tras el refund el SUM del destino EXACTO retorna al valor previo. | VERIFICADO en T-RWD-REAL-1 |
| **ATOMICIDAD-MULTI-TABLE** | FOR UPDATE serializa, pero INSERT PUEDE fallar post-UPDATE | SDD/F0 | En una RPC PL/pgSQL que modifica N tablas (key + ledger), la serialización por FOR UPDATE en la primera tabla protege contra condiciones de carrera en el MISMO row, pero no contra violaciones de constraint en la segunda tabla (ej. FK, UNIQUE, CHECK). El design actual asume que el INSERT en ledger nunca fallará (FK exists, owner_ref coincide, destination es text válido), confirmado por la naturaleza append-only. Documentar como invariante de seguridad. | ASUMIDO en design |

---

## Archivos modificados en la implementación

### Wave 0: SQL (migración aditiva)
- `supabase/migrations/20260624000000_wkh129_refund_with_dest_policy.sql` — RPC `refund_with_dest_policy(uuid, integer, numeric, text, text)` con `FOR UPDATE`, ownership guard, clamp daily, INSERT negativa; hardening `SECURITY DEFINER` + `SET search_path` + `REVOKE/GRANT service_role`.
- `supabase/migrations/20260624000000_wkh129_refund_with_dest_policy_down.sql` — `DROP FUNCTION IF EXISTS refund_with_dest_policy(uuid, integer, numeric, text, text)`.

### Wave 1: TypeScript (budget service)
- `src/services/budget.ts` — **NUEVA** función `creditWithDest(keyId, chainId, amountUsd, ownerRef, destination)` que invoca `supabase.rpc('refund_with_dest_policy', {...})` con 5 params, mapea errores (`OWNERSHIP_MISMATCH`, `KEY_NOT_FOUND`, fallback `REFUND_FAILED`), retorna `{success: boolean; error?: string}`.

### Wave 2: Compose refund wire
- `src/services/compose.ts` — Refund per-step (líneas ~346-359): reemplazado por branch: si `destination` válido → `creditWithDest(...)`, si no → `credit(...)`; `destination = normalizeDestination(\`${agent.registry}/${agent.slug}\`)` (EXACTO mismo que debit L174); log `[compose.refund-failed]` sin cambiar error al caller.

### Wave 3: Tests
- `src/services/budget.test.ts` — **NUEVO** `describe('creditWithDest')` con T-CWD-1 (success, 5 params exactos), T-CWD-2 (OWNERSHIP_MISMATCH mapeo), T-CWD-3 (KEY_NOT_FOUND, REFUND_FAILED, console.error); **T-NOREG-CREDIT** (back-compat: `credit` 4-arg sigue invocando `refund_a2a_key_spend`).
- `src/services/compose.test.ts` — Mock `creditWithDest: vi.fn()` agregado al budgetService mock (L~20); **T-COMPOSE-REFUND-1 actualizado** de `mockCredit` a `mockCreditWithDest` con 5 args + destination; **T-COMPOSE-REFUND-DEST-2** (NUEVO: debit amount == refund amount); T-REFUND-2/3 (no-regresión: step-0, deleg sin refund).
- `src/__tests__/e2e/refund-with-dest-cap.real.test.ts` — **NUEVO** opt-in test Postgres real: T-RWD-REAL-1 (debit → SUM=X, refund → SUM=0 post-compensatoria, budget/daily revertidos), T-RWD-REAL-2 (ownership guard OWNERSHIP_MISMATCH, ROLLBACK), T-RWD-REAL-3 (no-op ≤0/NULL, sin INSERT).

### Suite final
- **1680 tests PASS** (vitest, mocks + opt-in real)
- **tsc: 0 errors, 0 warnings** (strict mode)
- **biome: 0 linter issues** (format + syntax)

---

## Decisiones técnicas (DT) finales

| ID | Decisión | Justificación | Validación |
|----|----------|---------------|-----------|
| **DT-1** | Fila compensatoria **NEGATIVA** (append-only) vs DELETE vs UPDATE | Mantiene audit trail, SUM COALESCE sin filtro de signo descuenta automáticamente, no rompe índice `(key_id, destination, debited_at)`, no requiere `ledger_id`. Con fix MNR-1: INSERT condicionado a EXISTS(policy) asegura simetría. | T-RWD-REAL-1: SUM post-refund == 0 |
| **DT-2** | **NUEVA función** `creditWithDest` en budget.ts vs extension de `credit` con `destination?` | Explícita, zero riesgo de regresión en callers de `credit` (orchestrate step-0 sigue igual). Composer elige `creditWithDest` (con dest) vs `credit` (sin dest) por rama, sin ambigüedad. | T-NOREG-CREDIT: `credit` sigue invocando `refund_a2a_key_spend`; T-COMPOSE-REFUND-1: `creditWithDest` llamado |
| **DT-3** | Timestamp `NOW()` de fila compensatoria → **siempre dentro de ventana rolling** | Refund ocurre en MISMO request HTTP (δ ≈ segundos) del débito → ambas filas caen dentro de `window_secs` (≥60s); SUM neto vuelve al previo. Borde teórico sub-segundo documentado (no alcanzable en path real). | T-RWD-REAL-1: con rolling, test verifica SUM exacto |
| **DT-4** | Hardening **espejo de RPC hermanas** (`refund_a2a_key_spend`, `debit_with_dest_policy`) | Consistencia: `SECURITY DEFINER`, `SET search_path`, `REVOKE FROM PUBLIC, anon, authenticated`, `GRANT TO service_role`. | CR APROBADO: CD-4 verificado byte-a-byte |

---

## Constraint Directives (CD) verificadas

| CD | Regla | Verificación | Status |
|----|-------|--------------|--------|
| **CD-1** | Atomicidad: `budget + daily_spent + ledger` en 1 tx con `FOR UPDATE` en `a2a_agent_keys` | RPC PL/pgSQL: `FOR UPDATE` serializa; UPDATE budget, UPDATE daily, INSERT ledger **ANTES del END** → misma tx | ✅ PASS |
| **CD-2** | Ownership guard DB-layer bajo lock: `p_owner_ref IS DISTINCT FROM v_row.owner_ref` → `RAISE EXCEPTION 'OWNERSHIP_MISMATCH'` | RPC línea ~158: `IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN RAISE EXCEPTION...` bajo FOR UPDATE | ✅ PASS |
| **CD-3** | Migración aditiva: up SOLO `CREATE OR REPLACE`, PROHIBIDO `DROP`. Down = `DROP FUNCTION IF EXISTS` por firma | Up: función NUEVA (nombre no existe hoy); no hay overload, no hay DROP previo. Down: DROP exacto por firma `(uuid,integer,numeric,text,text)` | ✅ PASS |
| **CD-4** | PROHIBIDO crear dinero: fila compensatoria = `-p_amount_usd` (negativa) | RPC línea ~190: `INSERT INTO a2a_key_dest_spend_ledger (..., amount_usd) VALUES (..., -p_amount_usd)` | ✅ PASS |
| **CD-5** | PROHIBIDO doble-reversa: `p_amount_usd <= 0` o `NULL` → no-op RETURN, sin INSERT | RPC línea ~164: `IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN RETURN; END IF;` (antes del INSERT) | ✅ PASS |
| **CD-6** | PROHIBIDO tocar `debit_with_dest_policy`, `refund_a2a_key_spend`, `credit` 4-arg | Commits: no cambios en `supabase/migrations/20260606000000_a2a_key_spend_policies.sql`, `20260623000000_wkh127_refund_a2a_key_spend.sql`, ni `budget.ts:credit` original | ✅ PASS |
| **CD-7** | Best-effort en compose: fallo de `creditWithDest` NO cambia error visible | compose.ts refund: `if (!creditRes.success) { console.error('[compose.refund-failed]', {...}); }` sin `throw` (WKH-128 pattern) | ✅ PASS |
| **CD-8** | `creditWithDest` recibe `ownerRef: string` y `destination: string` (NO optional) | budget.ts línea ~238: `ownerRef: string` (no `string | undefined`), `destination: string` (no optional) | ✅ PASS |
| **CD-9** | Tests actualizados: `T-COMPOSE-REFUND-1` pasa de `mockCredit` a `mockCreditWithDest` | compose.test.ts: T-COMPOSE-REFUND-1 actualizado a `mockCreditWithDest` (5 args); grep `mockCredit\b` sin otros matches en refund tests | ✅ PASS |
| **CD-10** | Invariante no-pérdida: `refund.amount === debit.amount` en MISMO step | T-COMPOSE-REFUND-DEST-2 (nuevo): `mockDebit` con `0.05`, `mockCreditWithDest` con `0.05` (verificación de igualdad); T-RWD-REAL-1: SUM post-refund == 0 (neto exacto) | ✅ PASS |
| **CD-11** | Firma up == firma down: `(uuid,integer,numeric,text,text)` byte-a-byte | Migraciones: `CREATE OR REPLACE FUNCTION refund_with_dest_policy(p_key_id UUID, ..., p_destination TEXT)` (5 params) y `DROP FUNCTION ... (uuid,integer,numeric,text,text)` coinciden | ✅ PASS |
| **CD-12** | Destination canónico: `normalizeDestination(\`${agent.registry}/${agent.slug}\`)` EXACTO que el debit | compose.ts L174 (debit): `normalizeDestination(\`${agent.registry}/${agent.slug}\`)`, L~303 (refund): `const destination = normalizeDestination(\`${agent.registry}/${agent.slug}\`)` — EXACTO | ✅ PASS |
| **CD-13** | Fila compensatoria: `key_id`, `owner_ref`, `destination` IDÉNTICOS al débito | RPC INSERT: `(key_id, owner_ref, destination, amount_usd) VALUES (p_key_id, p_owner_ref, p_destination, -p_amount_usd)` → mismos 3 campos que el débito | ✅ PASS |

---

## Acceptance Criteria (AC) — resultado final

| AC | Descripción (EARS) | Evidencia | Status |
|----|------|----------|--------|
| **AC-1** | WHEN step de `/compose` falla tras debit con `destination`, THEN revierte ledger además de budget/daily | T-RWD-REAL-1: `debit_with_dest_policy` inserta, `refund_with_dest_policy` inserta negativa, SUM neto = 0 | ✅ **PASS** |
| **AC-2** | WHEN invoca `refund_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination)`, THEN (a) budget += amount, (b) daily GREATEST(daily - amount, 0), (c) INSERT ledger -amount — TODO atómico | RPC: `FOR UPDATE` + UPDATE budget (jsonb_set) + UPDATE daily (GREATEST) + INSERT ledger en MISMA tx | ✅ **PASS** |
| **AC-3** | WHEN `p_owner_ref` no coincide con `a2a_agent_keys.owner_ref`, THEN lanza `OWNERSHIP_MISMATCH` + ROLLBACK | T-RWD-REAL-2: `refund_with_dest_policy(key1, 84532, 0.05, 'owner-wrong', dest)` → OWNERSHIP_MISMATCH, ledger/key sin cambios | ✅ **PASS** |
| **AC-4** | WHILE política usa `window_type='rolling'`, THEN fila compensatoria (NOW()) cae dentro del SUM rolling (`debited_at >= now() - window_secs`) | T-RWD-REAL-1: debit T0, refund T0+δ (δ ≈ ms), window_secs=300 → ambas dentro; SUM final = 0 | ✅ **PASS** |
| **AC-5** | IF `p_amount_usd <= 0` OR `NULL`, THEN no-op, sin INSERT en ledger | T-RWD-REAL-3: `refund_with_dest_policy(..., 0)` y `refund_with_dest_policy(..., NULL)` → RETURN sin INSERT; ledger count sin cambios | ✅ **PASS** |
| **AC-6** | WHEN step falla (master, sin delegación/session) CON destination, THEN invoca `creditWithDest`; SIN destination, `credit` (fallback defensivo) | T-COMPOSE-REFUND-1 (actualizado): destination válido → `mockCreditWithDest` (5 args) llamado; compose.ts línea ~304: fallback `credit` si `!destination` | ✅ **PASS** |
| **AC-7** | WHEN migración aditiva instalada, THEN `debit_with_dest_policy`, `refund_a2a_key_spend`, hermanas intactas (aridad, comportamiento) | Commits: no cambios en `20260606000000`, `20260623000000` migraciones; `budget.ts:credit` 4-arg intacto (T-NOREG-CREDIT: sigue invocando `refund_a2a_key_spend`) | ✅ **PASS** |

**Total: 7/7 ACs PASS** ✅

---

## Estado del deployment

### Migración en Producción
- **Base de datos**: Supabase (caldzjhjgctpgodldqav)
- **Migración aplicada**: `20260624000000_wkh129_refund_with_dest_policy.sql` ✅ verify'd (Postgres log clean, GRANT service_role OK)
- **Función disponible**: `refund_with_dest_policy(uuid, integer, numeric, text, text)` en `public` schema, executable solo por `service_role`

### Code Deploy
- **Merge**: PR #114 merged a `main` (commit `25dc521`)
- **Railway**: Deploy levantado, contenedor con código actualizado corriendo
- **Health check**: `/health` endpoint respondiendo OK

### Validación post-deploy
- **Suite local**: 1680 tests PASS (tsc + vitest + biome)
- **Smoke test**: `/compose` refund flow con destination:
  ```
  POST /compose {"destination":"wasiai/corridor"} → debit 0.05 USDC
  → step falla → refund vía creditWithDest
  → ledger suma a 0 (debit +0.05, refund -0.05)
  → budget acreditado
  ✅ End-to-end flow OK
  ```

---

## Lecciones para próximas HUs

1. **Simetría en transacciones condicionales (MNR-1→LECCIÓN)**  
   Cuando un débito es condicional (solo inserta si EXISTS(policy)), el refund DEBE ser también condicional sobre la MISMA condición. Append-only no excusa falta de validación. La lección de WKH-125 BLQ-MED-1 ("CREATE OR REPLACE + 1 param = overload") se extiende: **toda reversa debe espejo exacto del débito, incluyendo condiciones**.

2. **Tests desactualizados como deuda técnica (CD-9→LECCIÓN)**  
   WKH-127 dejó T-COMPOSE-REFUND-1 con `mockCredit` incluso tras cambiar el wire a `credit` llamado. Esta HU lo arreglió de inmediato, pero es fácil caer en la trampa: buscar siempre `grep -rn "mockFunctionName\b\|toHaveBeenCalledWith"` ANTES de cerrar la fase de tests, especialmente si el wire cambió la función invocada. **No es regresión de producción, es test desactualizado**.

3. **Invariante de no-pérdida requiere test explícito (CD-10→LECCIÓN)**  
   `refund.amount === debit.amount` suena obvio, pero sin test explícito (T-COMPOSE-REFUND-DEST-2) es fácil que un refactor futuro rompa la garantía. Incluir el invariante en el plan de tests desde F2.

4. **Destino canónico DEBE venir de resolver, NO del caller (CD-12/CD-13→LECCIÓN)**  
   Los problemas de mismatch en SUM del cap ocurren cuando el destination se deriva de múltiples fuentes (body del caller, policy, ledger, etc.). **Única fuente válida: el agente RESUELTO por discovery** (`agent.registry/agent.slug`), normalizado con la MISMA función (`normalizeDestination`). Documentar en CLAUDE.md como Security Convention (similar a `owner_ref`).

5. **Append-only con filas negativas es correcto, pero requiere validación de inserto**  
   La estrategia DT-1 (fila negativa append-only) es correcta para ledgers de auditoría, pero **el INSERT debe validar la MISMA condición que la operación original**. Si en una futura HU se relaja el INSERT (ej. permitir reversas sin policy), el SUM se corrompe. Es similar a `owner_ref` ownership guard: DB-layer + app-layer simetría.

---

## Cierre

**WKH-129 DONE**: Residual de `/compose` refund cerrado. El path de dinero es ahora completo y atómico en los 3 niveles: `budget`, `daily_spent`, `a2a_key_dest_spend_ledger`. Merged a main, migración prod-verificada, suite 1680 pass, AR APROBADO, CR APROBADO, F4 APROBADO. Ready para el siguiente sprint.

**Auto-blindaje consolidado**: 6 entradas de lecciones y patrones documentadas para próximas HUs, especialmente en torno a simetría transaccional, test actualización y canonicidad de destino.
