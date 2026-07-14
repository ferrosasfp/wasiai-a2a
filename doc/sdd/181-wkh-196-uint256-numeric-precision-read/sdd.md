# SDD — [WKH-196] Pérdida de precisión uint256 al leer columnas NUMERIC(78,0) vía supabase-js

- **SDD_MODE**: mini (root-cause diagnosticado empíricamente; fix mecánico acotado).
- **Metodología**: QUALITY (money-path + on-chain settlement).
- **Input**: `work-item.md` (gate HU_APPROVED pasado).
- **Estado**: LISTO PARA SPEC_APPROVED (ver Readiness Check §9).

---

## 1. Context Map (archivos leídos + patrón extraído)

| Archivo | Líneas clave | Por qué | Qué extraje |
|---|---|---|---|
| `src/adapters/escrow/debit-capture.ts` | 75-143 | Sitio #1 del fix (`readValidDebitSignature`) + `ValidDebitRow` (comentario DT-2) | Select single-line (L114-116) trae `debit_amount_atomic` + `debit_nonce` (ambos NUMERIC 78,0) + `debit_deadline` (BIGINT). El row se castea `as unknown as ValidDebitRow` (L125). El nonce se pasa tal-cual (no re-validado); el amount pasa por `BigInt(row.debit_amount_atomic)` (L132). |
| `src/services/arbiter.ts` | 100-165 | Sitio #2 (`getOrCreateArbiterNonce`, read-first) | `.select('nonce')` (L108) → `.maybeSingle()` → `existing?.nonce` (L121) → `BigInt(String(existing.nonce))`. El `String()` es defensivo pero un `number` ya-redondeado da el string equivocado. El path RPC (L145) ya devuelve `persisted_nonce` como string → OUT. |
| `src/services/reconciliation.ts` | 105-165, 177-489 | Sitio #3 (3 selects) + interfaces | `listPending` (L184-187): trae `debit_nonce` + `debit_amount_atomic`. `resolveIntent` (L222-225): trae `debit_nonce` + `debit_amount_atomic` + embed `a2a_payment_intents!inner(...)`. `driftCheck` (L406-409): trae SOLO `debit_amount_atomic` (NO `debit_nonce`). Todas usan `BigInt(...)`/`formatUnits(BigInt(...))` sobre esos campos. Interfaces `PendingSelectRow`/`SigWithIntentRow`/`DriftSigRow` ya declaran `string`. |
| `supabase/migrations/20260713000000_wkh191a_debit_signatures.sql` | 24-26 | Tipo real de columna | `debit_amount_atomic NUMERIC(78,0)`, `debit_nonce NUMERIC(78,0)`, `debit_deadline BIGINT`. |
| `supabase/migrations/20260713000003_wkh194_arbiter_nonces.sql` | 19 | Tipo real | `nonce NUMERIC(78,0)`. |
| `src/types/database.types.ts` | 17-41, 784-807 | Contrato de tipos | Las 3 columnas ya tipadas `string` (con comentario "NUMERIC(78,0) uint256 → string"). **No requiere cambio** (el runtime pasa a cumplir el tipo ya declarado). |
| `src/adapters/escrow/debit-capture.test.ts` | 385-545 | **Exemplar de test** (sitio #1) | `stubReaderRow(row)` con builder-double (`select`/`eq`/`order`/`limit`/`maybeSingle` como `vi.fn`). `validRow(overrides)` factory. Assert sobre `r.debit_nonce`. El `select` es `vi.fn` → **capturable** para assert de string. |
| `src/services/reconciliation.test.ts` | 85-497 | **Exemplar de test** (sitio #3) | `sigRow(overrides)` factory + `wireFrom({sigResult})` (double con `then` thenable). Asserts sobre `p_nonce`/`sumDebitedAtomic`/output. Patrón anti-tautología documentado en cabecera. |
| `src/services/arbiter.test.ts` | 355-398, 1610-1675 | **Exemplar de test** (sitio #2) | Read-first del nonce: `maybeSingle()` para `a2a_arbiter_nonces` devuelve `nonceStore`. T4 (L1656): read-first exactly-once, assert `resolveNonceArg(0) === EXPECTED_NONCE` + `nonceRpcCalls() === 0`. |

**Verificación empírica del bug (node):** `(4312989337224638380).toString()` → `"4312989337224638500"`; `BigInt(4312989337224638380)` → `4312989337224638464n` (corrupto). `3000000000000000000` (3e18, redondo) → exacto. Confirma AC-1/AC-5 y CD-1.

---

## 2. Resolución del `[NEEDS CLARIFICATION]` — barrido money-path (punto 2)

**Objetivo**: hallar CUALQUIER columna `BIGINT`/`NUMERIC` que (a) se lea vía `supabase-js .select()`, (b) pueda exceder 2^53, y (c) alimente `BigInt`/on-chain.

**Método**: `grep -rniE "NUMERIC|BIGINT" supabase/migrations` filtrando params/vars de RPC (`p_*`, `v_*`) y USD; `grep .select(` sobre las 3 columnas en `src/`.

**Resultado — INVENTARIO CERRADO en 3 columnas. NO apareció ninguna nueva.**

| Columna | Tabla | Tipo | Veredicto |
|---|---|---|---|
| `debit_amount_atomic` | `a2a_payment_intent_debit_signatures` | `NUMERIC(78,0)` | **IN** (uint256 atómico) |
| `debit_nonce` | `a2a_payment_intent_debit_signatures` | `NUMERIC(78,0)` | **IN** (uint256 nonce) |
| `nonce` | `a2a_arbiter_nonces` | `NUMERIC(78,0)` | **IN** (uint256 nonce) |
| `debit_deadline` | `a2a_payment_intent_debit_signatures` | `BIGINT` | **OUT** — epoch seconds, << 2^53 (año ~292e9). No es uint256. Confirmado Scope OUT. |
| `total_spent` | `a2a_delegations` | `NUMERIC(20,8)` | **OUT** — USD acumulado (rango seguro, no wei/atomic, no alimenta on-chain crudo). |
| `at_stake_usd` / `authorized_usd` / `consumed_usd` / `settle_usd` | `a2a_arbitrations` / `a2a_payment_intents` | `NUMERIC` USD | **OUT** — montos USD en rango seguro (Scope OUT del work-item). |

**Notas del barrido:**
- Todas las demás apariciones de `NUMERIC` en migraciones son **parámetros de función RPC** (`p_nonce NUMERIC`, `p_amount_atomic NUMERIC`) o **variables locales PL/pgSQL** (`v_total`, `v_max`), NO columnas leídas vía `.select()`. Los RPCs que devuelven nonce/amount ya castean su output (p.ej. `get_or_create_arbiter_nonce.persisted_nonce` llega string; `arbiter.ts:145`). **Los outputs de RPC quedan OUT** — el bug es exclusivo del `.select()` directo de tabla.
- `driftCheck` (`reconciliation.ts:406-409`) trae SOLO `debit_amount_atomic` (NO `debit_nonce`) → se castea **una sola** columna ahí (CD-6: no castear columnas ausentes del select).

**Conclusión**: el inventario del Analyst (3 columnas) es correcto y exhaustivo. Sin hallazgos nuevos. `debit_deadline` permanece OUT (BIGINT epoch, sin riesgo).

---

## 3. Root cause (una línea)

PostgREST serializa `NUMERIC(78,0)` como **número JSON sin comillas**; `JSON.parse` en supabase-js redondea > 2^53 → `debit_nonce`/`debit_amount_atomic`/`nonce` se corrompen al leerlos. El cast `columna::text` en el `.select()` fuerza a PostgREST a devolver **string exacto** (verificado contra bdwv: `{"debit_nonce":4312989337224638380}` sin cast vs `{"debit_nonce":"4312989337224638380"}` con `::text`).

---

## 4. Decisiones técnicas (DT-N)

Heredadas del work-item (DT-1, DT-2, DT-3) + específicas:

- **DT-1 (heredada)**: el fix vive EXCLUSIVAMENTE en la expresión del `.select()` (`columna::text`). Sin capa de parsing custom, sin wrapper genérico. 5 selects, 5 ediciones puntuales (2 columnas × varios selects).
- **DT-2 (heredada)**: corregir el comentario `ValidDebitRow` (`debit-capture.ts:75-78`) para reflejar que el `string` en runtime **depende del cast `::text`**, no es automático por el tipo de columna.
- **DT-3 (heredada)**: NO tocar el tipo de retorno de las interfaces TS (`ValidDebitRow`, `PendingSelectRow`, `SigWithIntentRow`, `DriftSigRow`) — ya declaran `string`. Cero breaking change de tipos.
- **DT-4 (nueva) — PostgREST NO renombra con `::text`**: la sintaxis `debit_nonce::text` castea PRESERVANDO la key `debit_nonce` en el JSON de respuesta (el rename requeriría el prefijo `alias:col`, que NO se usa). Por tanto el mapeo `row.debit_nonce` → interfaz **NO cambia**. PROHIBIDO agregar alias (`nonce:nonce::text`) — rompería el mapeo. Aplica a las 3 columnas en los 5 selects.
- **DT-5 (nueva) — tsc y el type-parser del select**: `database.types.ts` ya tipa las 3 columnas como `string`, así que el resultado post-cast sigue tipando `string`. Si el parser de tipos de `@supabase/postgrest-js` no reconoce el sufijo `::text` y degrada el campo a `unknown`/error de `tsc`, aplicar el patrón YA existente en los selects hermanos: `const row = data as unknown as <Interface>` (así lo hacen `debit-capture.ts:125`, `reconciliation.ts:238`/`194`/`416`). `arbiter.ts` read-first NO usa ese cast hoy (usa `existing?.nonce` inferido); si `tsc` protesta, narrow-castear `const existing = data as { nonce: string | null } | null`. **Verificación obligatoria: `npm run build`/`tsc` limpio antes de F3-done.** No es un cambio de contrato, es defensa de compilación.

---

## 5. Constraint Directives (CD-N)

Heredadas del work-item (CD-1..CD-5) + específicas del SDD:

- **CD-1 (heredada)**: PROHIBIDO cualquier cambio de comportamiento para valores NUMERIC(78,0) < 2^53 (o representables exactos en float64, p.ej. `3000000000000000000`). OBLIGATORIO test que verifique byte-identidad del caso ya-seguro.
- **CD-2 (heredada)**: OBLIGATORIO test que pruebe que `4312989337224638380` (uint256 no-redondo > 2^53) sobrevive el round-trip DB→app→`BigInt` EXACTO en los 3 puntos de lectura.
- **CD-3 (heredada)**: PROHIBIDO modificar schema/tipo de columna. Sin migración. 100% capa de lectura.
- **CD-4 (heredada)**: PROHIBIDO tocar el path de captura (body del request, `debit-capture.ts:176-189`).
- **CD-5 (heredada)**: OBLIGATORIO validar que el select de `readValidDebitSignature` sigue siendo el único literal repetido de sus campos (sin drift entre selects hermanos).
- **CD-6 (nueva)**: PROHIBIDO castear columnas ausentes del select. `driftCheck` NO trae `debit_nonce` → castear SOLO `debit_amount_atomic` ahí. `debit_deadline` (BIGINT) NUNCA se castea (Scope OUT).
- **CD-7 (nueva)**: PROHIBIDO alias en el cast (DT-4). Exactamente `debit_nonce::text` / `debit_amount_atomic::text` / `nonce::text`, preservando la key.
- **CD-8 (nueva) — anti-recurrencia de `vi.hoisted` (ref: WKH-191c auto-blindaje#1, WKH-194 auto-blindaje#1)**: TODO símbolo (spy, clase de error, doble) referenciado dentro de una factory `vi.mock(...)` DEBE declararse vía `vi.hoisted(() => ...)` o dentro de la propia factory. Este repo tuvo ≥2 fallos de suite (TDZ / "error when mocking a module") por esta causa. Los nuevos tests reutilizan los mocks YA hoisteados de los archivos exemplar — PROHIBIDO introducir un `const`/`class` top-level nuevo consumido por una factory sin `vi.hoisted`.
- **CD-9 (nueva) — anti-tautología**: los tests NO deben ser `expect(true).toBe(true)`. El round-trip debe ejercitar `BigInt(...)`/output real sobre el valor del incidente y comparar contra el `bigint`/string esperado exacto. Seguir la nota anti-tautología de `reconciliation.test.ts` (cabecera).

---

## 6. Waves de implementación

Fix trivial y de bajo riesgo → **2 waves** (producción serial; tests paralelizables por archivo). No hay W0 de contratos (interfaces/tipos ya existen, sin migración).

### W1 — Fixes de lectura (5 selects + 1 comentario) · SERIAL, sin dependencias entre sí
1. **`src/adapters/escrow/debit-capture.ts`**
   - L114-116: `debit_amount_atomic` → `debit_amount_atomic::text`; `debit_nonce` → `debit_nonce::text`. (Dejar `debit_deadline` sin tocar — CD-6.)
   - L75-78: corregir el comentario `ValidDebitRow` (DT-2): aclarar que el `string` runtime depende del cast `::text`, no del tipo de columna.
2. **`src/services/arbiter.ts`**
   - L108: `.select('nonce')` → `.select('nonce::text')`. (Si `tsc` protesta, DT-5.)
3. **`src/services/reconciliation.ts`**
   - `listPending` L184-187: `debit_nonce::text`, `debit_amount_atomic::text`.
   - `resolveIntent` L222-225: `debit_nonce::text`, `debit_amount_atomic::text` (embed `a2a_payment_intents!inner(...)` intacto).
   - `driftCheck` L406-409: `debit_amount_atomic::text` SOLO (CD-6, no hay `debit_nonce` acá).

### W2 — Tests (paralelizable; 1 archivo de test por sitio, ya existen) · depende de W1
Extender los 3 `.test.ts` existentes (§7). No crear harness nuevo.

---

## 7. Plan de tests (≥1 por AC; patrón = exemplars verificados)

Cada test es de **dos capas** por sitio:
- **(a) Cast-presence** (guarda el fix / AC-6): capturar el string pasado a `.select(...)` y assert que contiene `<col>::text`. Regresión directa si Dev quita el cast.
- **(b) Round-trip exacto** (guarda la precisión / CD-2): row string del incidente → `BigInt`/output exacto.
- **(c) Byte-idéntico safe** (CD-1/AC-5): valor redondo/`<2^53` inalterado.

| Test | Archivo | AC | Qué asserta |
|---|---|---|---|
| T-NEW-1 cast-presence reader | `debit-capture.test.ts` | AC-1/AC-2/AC-6 | El arg de `builder.select` (es `vi.fn`, capturable) contiene `debit_nonce::text` **y** `debit_amount_atomic::text`, y NO `debit_deadline::text`. |
| T-NEW-2 round-trip nonce reader | `debit-capture.test.ts` | AC-1 | `stubReaderRow(validRow({ debit_nonce: '4312989337224638380', debit_amount_atomic: '1500000' }))` (amount matcheando `parseUnits(1.5,6)` para que la fila retorne) → `r.debit_nonce === '4312989337224638380'` **y** `BigInt(r.debit_nonce) === 4312989337224638380n`. |
| T-NEW-3 safe byte-idéntico reader | `debit-capture.test.ts` | AC-5/CD-1 | `validRow({ debit_nonce: '7' })` → `r.debit_nonce === '7'` (idéntico al comportamiento previo; el test T-7 existente ya lo cubría con `'7'`, extender/asegurar). |
| T-NEW-4 cast-presence nonce read-first | `arbiter.test.ts` | AC-3/AC-6 | El string pasado a `.select(...)` sobre `a2a_arbiter_nonces` === `'nonce::text'`. (Capturar el arg del `select` del double L354-374.) |
| T-NEW-5 round-trip nonce read-first | `arbiter.test.ts` | AC-3 | Variante de T4 (L1656): `nonceStore = { nonce: '4312989337224638380' }` (read-first HIT) → `resolveNonceArg(0) === 4312989337224638380n` **y** `nonceRpcCalls() === 0` (NO recomputa). |
| T-NEW-6 cast-presence + round-trip resolveIntent | `reconciliation.test.ts` | AC-4/AC-6 | `sigRow({ debit_nonce: '4312989337224638380' })` → (a) select string contiene `debit_nonce::text`+`debit_amount_atomic::text`; (b) `claim_reconciliation` recibe `p_nonce === '4312989337224638380'` (exacto) y `reverifyDebitedByTxHash` recibe `nonce: 4312989337224638380n`. |
| T-NEW-7 round-trip nonce listPending | `reconciliation.test.ts` | AC-4 | `listPending` con row `debit_nonce: '4312989337224638380'` → item `nonce === '4312989337224638380'` (string exacto en el output `PendingRow`). |
| T-NEW-8 round-trip amount driftCheck | `reconciliation.test.ts` | AC-2/AC-4 | `driftCheck` con 1 row `debit_amount_atomic: '4312989337224638380'` → `sumDebitedAtomic === '4312989337224638380'` (exacto; guarda el 2º campo NUMERIC). Assert que el select de driftCheck contiene `debit_amount_atomic::text` y NO `debit_nonce::text` (CD-6). |
| T-NEW-9 safe amount byte-idéntico | `reconciliation.test.ts` | AC-5/CD-1 | `driftCheck` con `debit_amount_atomic: '3000000000000000000'` (redondo, representable) → `sumDebitedAtomic === '3000000000000000000'` (idéntico con/sin fix; documenta el invariante seguro). |

**Nota AC-7 (E2E on-chain two-hop)**: es un criterio de **activación/deploy** (requiere firma `DebitAuthorization` real + flag `ESCROW_SETTLE_ENABLED` ON + chain default). NO se ejercita en unit-tests (fuera del alcance de F3; se verifica en el deploy/activación del epic WKH-191, ver Análisis de paralelismo del work-item). Documentado como fuera-de-unit, no bloqueante para el merge del fix.

**Por qué los unit-tests SÍ tienen valor** (dado que el mock provee el row ya-string): la capa (a) *cast-presence* asserta el string literal del `.select()` → **falla si Dev quita `::text`** (regresión AC-6 real, no simulable de otro modo en unit). La capa (b) *round-trip* fija el contrato string→BigInt exacto que el runtime debe cumplir. Juntas cierran CD-2 sin depender de una DB Postgres real.

---

## 8. Exemplars verificados (paths confirmados)

- `src/adapters/escrow/debit-capture.test.ts:385-545` — `stubReaderRow` / `validRow` / builder-double con `select` como `vi.fn` (capturable). ✔ existe.
- `src/services/reconciliation.test.ts:85-497` — `sigRow` / `wireFrom` / asserts sobre `p_nonce`, `sumDebitedAtomic`, output. ✔ existe.
- `src/services/arbiter.test.ts:355-398, 1610-1675` — double de `a2a_arbiter_nonces` (`nonceStore`) + T4 read-first (`resolveNonceArg`, `nonceRpcCalls`). ✔ existe.
- Mocks hoisteados (`vi.hoisted`) ya presentes en los 3 archivos — reutilizar (CD-8).

---

## 9. Readiness Check

- [x] Work-item leído completo (Scope IN/OUT, ACs, CDs, DTs, Missing Inputs).
- [x] Stack confirmado (TypeScript strict, supabase-js, viem, vitest) — sin drift.
- [x] Tipo real de las 3 columnas verificado contra migraciones (`NUMERIC(78,0)`).
- [x] Los 5 selects re-verificados con Read (line-numbers confirmados: debit-capture L114-116; arbiter L108; reconciliation L184-187/L222-225/L406-409).
- [x] Verificado qué columnas trae CADA select (driftCheck NO trae `debit_nonce` → CD-6).
- [x] `[NEEDS CLARIFICATION]` resuelto: barrido money-path completo → **inventario CERRADO en 3 columnas, sin hallazgos nuevos** (§2). `debit_deadline` BIGINT confirmado OUT.
- [x] Detalle PostgREST `::text` sin rename confirmado (DT-4) → interfaces intactas.
- [x] Comportamiento del type-parser de supabase-js contemplado (DT-5) con fallback al patrón `as unknown as` ya usado.
- [x] Bug + fix verificados empíricamente (float rounding via node; string exacto via bdwv en work-item).
- [x] Exemplars de test verificados (existen, líneas citadas).
- [x] Auto-blindaje histórico revisado (191c, 194) → CD-8 (`vi.hoisted`) heredado como anti-recurrencia.
- [x] Plan de tests: ≥1 test por AC (AC-1..AC-5 cubiertos en unit; AC-6 vía cast-presence; AC-7 documentado como activación/deploy).
- [x] Sin `[NEEDS CLARIFICATION]` pendientes.

**Veredicto: LISTO para SPEC_APPROVED.** No hay TBDs. Fix acotado, root-cause cerrado, inventario cerrado, tests con guarda real de regresión.
