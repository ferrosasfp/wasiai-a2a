# Story File — HU WKH-196 · Pérdida de precisión uint256 al leer NUMERIC(78,0) vía supabase-js

> Contrato autocontenido para el Dev (F3). Fuente única de verdad de esta HU.
> Si algo no está acá, NO se hace. Deriva de `sdd.md` (SPEC_APPROVED) + `work-item.md`.
> Mode: **QUALITY** (money-path + on-chain settlement; evidencia archivo:línea obligatoria en CR/QA).
> Branch: `fix/181-wkh-196-uint256-numeric-precision-read`. Estimación: S (diff chico, path crítico).

---

## 1. Contexto compacto (qué es el bug y por qué el fix es `::text`)

El escrow-settle non-custodial (epic WKH-191) y el árbitro (WKH-194) persisten
`nonce`/`amount` uint256 en columnas Postgres **`NUMERIC(78,0)`**. Pero PostgREST
serializa `NUMERIC` como **número JSON sin comillas**, y el `JSON.parse` interno de
supabase-js **redondea cualquier valor > 2^53** al múltiplo del ULP de float64 más
cercano. En prod esto corrompe el `debit_nonce` leído de vuelta → la firma EIP-712 no
matchea → `escrow.debit` revierte `0x8baa579f` → el sistema cae SIEMPRE al fallback
operator-custodial. **El epic WKH-191 está 100% neutralizado en prod** pese a estar
"code-complete".

**Verificación empírica (node):**
- `(4312989337224638380).toString()` → `"4312989337224638500"` (corrupto)
- `BigInt(4312989337224638380)` → `4312989337224638464n` (corrupto)
- `3000000000000000000` (3e18, redondo) → exacto (por eso el bug es invisible para montos redondos)

**El fix**: castear `columna::text` en la expresión del `.select()`. PostgREST con el
cast devuelve el valor como **string decimal exacto** entre comillas
(`{"debit_nonce":"4312989337224638380"}`), de modo que el runtime cumple el contrato
que las interfaces TypeScript **ya declaran** (`string`, nunca `number`). Cero cambio de
schema, cero cambio de contrato de tipos. 5 selects, ediciones puntuales.

---

## 2. Scope IN — archivos exactos a tocar

| # | Archivo | Qué se hace | Wave |
|---|---|---|---|
| 1 | `src/adapters/escrow/debit-capture.ts` | `::text` en 2 cols del select de `readValidDebitSignature` + corregir comentario `ValidDebitRow` | W1 |
| 2 | `src/services/arbiter.ts` | `.select('nonce')` → `.select('nonce::text')` en el read-first de `getOrCreateArbiterNonce` | W1 |
| 3 | `src/services/reconciliation.ts` | `::text` en `listPending`, `resolveIntent` (2 cols c/u) + `driftCheck` (SOLO 1 col) | W1 |
| 4 | `src/adapters/escrow/debit-capture.test.ts` | T-NEW-1..3 | W2 |
| 5 | `src/services/arbiter.test.ts` | T-NEW-4..5 | W2 |
| 6 | `src/services/reconciliation.test.ts` | T-NEW-6..9 | W2 |

**NO se toca NADA fuera de estas 6 rutas.** Sin migración (CD-3). Sin cambio de interfaces (DT-3).
El bookkeeping de `_INDEX.md` lo hace `nexus-docs` en DONE, no vos.

---

## 3. Anti-Hallucination Checklist (verificá con Read ANTES de escribir)

Todas estas anclas fueron confirmadas por el Architect. **Re-leé cada select con Read antes de editarlo** —
los números de línea pueden haber corrido.

- [ ] `debit-capture.ts:112-122` — el select actual de `readValidDebitSignature` es una llamada
      multilínea; el arg del `.select(...)` es el string literal `'debit_signature, debit_amount_atomic, debit_deadline, debit_nonce, debit_key_id_hash, debit_hop1_tx_hash, debit_settle_status'`.
- [ ] `debit-capture.ts:125` — el row se castea `const row = data as unknown as ValidDebitRow | null;` (patrón fallback DT-5).
- [ ] `debit-capture.ts:80-88` — interfaz `ValidDebitRow` YA declara `debit_amount_atomic: string` y `debit_nonce: string`. **NO se toca la interfaz** (DT-3). El comentario a corregir está en `:75-78`.
- [ ] `arbiter.ts:106-111` — read-first: `.select('nonce')` seguido de `.eq(...).eq(...).maybeSingle()`. El valor se consume en `:121` con `BigInt(String(existing.nonce))`. **El path RPC (`:132-146`, `persisted_nonce`) YA llega string → NO se toca** (Scope OUT).
- [ ] `reconciliation.ts:182-189` — `listPending`, select string `'intent_id, key_id, debit_nonce, debit_amount_atomic, debit_hop1_tx_hash, ' + 'debit_settle_status, owner_ref'`.
- [ ] `reconciliation.ts:220-230` — `resolveIntent`, select string `'intent_id, key_id, debit_key_id_hash, debit_nonce, debit_amount_atomic, ' + 'debit_hop1_tx_hash, debit_settle_status, owner_ref, ' + 'a2a_payment_intents!inner(pay_to, chain_id, owner_ref)'`. **El embed `!inner(...)` queda intacto.**
- [ ] `reconciliation.ts:404-411` — `driftCheck`, select string `'key_id, debit_key_id_hash, debit_amount_atomic, owner_ref, ' + 'a2a_payment_intents!inner(chain_id)'`. **Trae `debit_amount_atomic` pero NO `debit_nonce`** (CD-6).
- [ ] Interfaces `PendingSelectRow` / `SigWithIntentRow` / `DriftSigRow` en `reconciliation.ts` YA declaran `string` para estas columnas. **NO se tocan** (DT-3).

---

## 4. W1 — los 5 selects + 1 comentario (SERIAL, sin dependencias entre sí)

**Regla de oro para los 5 selects — CD-7 (PROHIBIDO alias):** el cast en PostgREST es
exactamente `columna::text` **preservando la key** en el JSON de respuesta. NUNCA uses
`alias:columna::text` (p.ej. `nonce:nonce::text`) — el prefijo `alias:` renombra la key y
rompería el mapeo `row.<col>`. El cast NO renombra por sí solo (DT-4).

### 1.1 — `src/adapters/escrow/debit-capture.ts` (select de `readValidDebitSignature`)

**ANTES** (re-leé con Read; el arg del `.select(...)`):
```
'debit_signature, debit_amount_atomic, debit_deadline, debit_nonce, debit_key_id_hash, debit_hop1_tx_hash, debit_settle_status'
```
**DESPUÉS** (castear SOLO `debit_amount_atomic` y `debit_nonce`; `debit_deadline` intacto — es BIGINT epoch, Scope OUT, CD-6):
```
'debit_signature, debit_amount_atomic::text, debit_deadline, debit_nonce::text, debit_key_id_hash, debit_hop1_tx_hash, debit_settle_status'
```

### 1.2 — `src/adapters/escrow/debit-capture.ts:75-78` (comentario `ValidDebitRow`, DT-2)

**ANTES:**
```
 * Vista tipada a mano del subset leído por `readValidDebitSignature` (CD-S2:
 * select tipado a mano → cast). `debit_amount_atomic`/`debit_nonce` son NUMERIC
 * uint256 → `string` (BigInt, nunca Number). `debit_deadline` es BIGINT → number.
```
**DESPUÉS** (aclarar que el `string` runtime depende del cast `::text`, no es automático por el tipo de columna — WKH-196):
```
 * Vista tipada a mano del subset leído por `readValidDebitSignature` (CD-S2:
 * select tipado a mano → cast). `debit_amount_atomic`/`debit_nonce` son NUMERIC(78,0)
 * uint256: el `string` en runtime DEPENDE del cast `::text` en el `.select()` — sin él
 * PostgREST serializa NUMERIC como número JSON y JSON.parse redondea > 2^53 (WKH-196).
 * `debit_deadline` es BIGINT epoch (< 2^53) → number, NO se castea.
```
> El texto exacto del comentario es flexible; lo obligatorio es que refleje la dependencia del `::text` y que `debit_deadline` no se castea.

### 1.3 — `src/services/arbiter.ts:108` (read-first de `getOrCreateArbiterNonce`)

**ANTES:** `.select('nonce')`
**DESPUÉS:** `.select('nonce::text')`

Si `tsc` protesta (ver DT-5, §7): narrow-castear el resultado
`const existing = data as { nonce: string | null } | null;` — este read-first NO usa hoy el
patrón `as unknown as`, así que el fallback de compilación es este narrow-cast puntual.
**NO toques** el path RPC ni `BigInt(String(existing.nonce))` en `:121`.

### 1.4 — `src/services/reconciliation.ts` `listPending` (~L184-187)

**ANTES:**
```
'intent_id, key_id, debit_nonce, debit_amount_atomic, debit_hop1_tx_hash, ' +
  'debit_settle_status, owner_ref'
```
**DESPUÉS:**
```
'intent_id, key_id, debit_nonce::text, debit_amount_atomic::text, debit_hop1_tx_hash, ' +
  'debit_settle_status, owner_ref'
```

### 1.5 — `src/services/reconciliation.ts` `resolveIntent` (~L222-225)

**ANTES:**
```
'intent_id, key_id, debit_key_id_hash, debit_nonce, debit_amount_atomic, ' +
  'debit_hop1_tx_hash, debit_settle_status, owner_ref, ' +
  'a2a_payment_intents!inner(pay_to, chain_id, owner_ref)'
```
**DESPUÉS** (embed `!inner(...)` intacto):
```
'intent_id, key_id, debit_key_id_hash, debit_nonce::text, debit_amount_atomic::text, ' +
  'debit_hop1_tx_hash, debit_settle_status, owner_ref, ' +
  'a2a_payment_intents!inner(pay_to, chain_id, owner_ref)'
```

### 1.6 — `src/services/reconciliation.ts` `driftCheck` (~L406-409) — **SOLO 1 columna (CD-6)**

**ANTES:**
```
'key_id, debit_key_id_hash, debit_amount_atomic, owner_ref, ' +
  'a2a_payment_intents!inner(chain_id)'
```
**DESPUÉS** (este select **NO trae `debit_nonce`** → castear SOLO `debit_amount_atomic`; NO agregar `debit_nonce::text`):
```
'key_id, debit_key_id_hash, debit_amount_atomic::text, owner_ref, ' +
  'a2a_payment_intents!inner(chain_id)'
```

**W1 done cuando:** los 5 selects castean exactamente las columnas indicadas, el comentario
está corregido, y `npm run build` (tsc) compila limpio (aplicando el fallback DT-5 solo si
tsc protesta).

---

## 5. W2 — los 9 tests (depende de W1)

Extender los 3 `.test.ts` existentes. **NO crear harness nuevo.** Reutilizar los helpers YA
hoisteados de cada archivo (ver §6 CD-8). Cada test tiene guarda real de regresión (CD-9,
NO tautologías): o asserta el string literal del `.select()` (cast-presence), o ejercita el
round-trip `string → BigInt`/output exacto sobre el valor del incidente.

**Valores canónicos:**
- Incidente (uint256 no-redondo > 2^53, round-trip): `4312989337224638380`
- Safe byte-idéntico (< 2^53 / representable exacto): `3000000000000000000` y `7`

### debit-capture.test.ts — helpers a reutilizar: `validRow(overrides)`, `stubReaderRow(row)` (builder-double con `select: vi.fn(...)`, **capturable**)

- **T-NEW-1 · cast-presence reader** (AC-1/AC-2/AC-6):
  `stubReaderRow(validRow())`, invocar `readValidDebitSignature(...)`, capturar el arg del select
  vía `builder.select.mock.calls[0][0]` (es `vi.fn`). Assert: contiene `'debit_nonce::text'` **y**
  `'debit_amount_atomic::text'`, y **NO** contiene `'debit_deadline::text'`. Falla si el Dev quita el cast.

- **T-NEW-2 · round-trip nonce reader** (AC-1):
  `validRow({ debit_nonce: '4312989337224638380', debit_amount_atomic: '1500000' })`.
  (El amount `'1500000'` matchea `parseUnits('1.5', 6)` para que la fila pase la re-validación y retorne;
  ajustá `finalAmountUsd`/mock de adapter según lo que ya hace el test T existente que devuelve una fila.)
  Assert: `r.debit_nonce === '4312989337224638380'` **y** `BigInt(r.debit_nonce) === 4312989337224638380n`.

- **T-NEW-3 · safe byte-idéntico reader** (AC-5/CD-1):
  `validRow({ debit_nonce: '7' })` → `r.debit_nonce === '7'` (idéntico al comportamiento previo). El
  `validRow` default ya usa `debit_nonce: '7'`; asegurá/extendé una assertion explícita de byte-identidad.

### arbiter.test.ts — helpers a reutilizar: `nonceStore` (double read-first de `a2a_arbiter_nonces`), `resolveNonceArg(idx)`, `nonceRpcCalls()`

- **T-NEW-4 · cast-presence nonce read-first** (AC-3/AC-6):
  Assert que el string pasado a `.select(...)` sobre `a2a_arbiter_nonces` === `'nonce::text'`.
  **Ojo (detalle de implementación):** el double `fromImpl` (`~L334-374`) tiene `select(cols) { ... }`
  como método plano que HOY **descarta** el arg. Para capturarlo, agregá dentro del propio double una
  variable de captura (p.ej. `b._selectCols = cols`) o un array de captura declarado **dentro del closure
  del `describe`/helper existente** — NO introduzcas un `const`/spy top-level nuevo consumido por la
  factory `vi.mock` (CD-8). Alternativa mínima: convertir `select` del double a `vi.fn` capturable
  manteniéndolo dentro del closure ya hoisteado. Assert final: el cols capturado === `'nonce::text'`.

- **T-NEW-5 · round-trip nonce read-first** (AC-3):
  Variante del T4 existente (`~L1656`): `nonceStore = { nonce: '4312989337224638380' }` (read-first HIT).
  Assert: `resolveNonceArg(0) === 4312989337224638380n` **y** `nonceRpcCalls() === 0` (el HIT no recomputa
  vía RPC). Cierra AC-3: el valor exacto sobrevive el SELECT directo de la tabla, no solo el RPC.

### reconciliation.test.ts — helpers a reutilizar: `sigRow(overrides)`, `wireFrom({ sigResult })`, `wireRpc({...})`; assert sobre `p_nonce`, `sumDebitedAtomic`, output `PendingRow`

- **T-NEW-6 · cast-presence + round-trip resolveIntent** (AC-4/AC-6):
  `wireFrom({ sigResult: { data: sigRow({ debit_nonce: '4312989337224638380' }), error: null } })`,
  invocar `resolveIntent(...)`.
  (a) **cast-presence**: capturar el arg de `select` del double (mismo caveat CD-8 que T-NEW-4 —
      `wireFrom` define `select: () => b` que descarta el arg; capturalo dentro del closure de `wireFrom`,
      sin símbolo top-level nuevo). Assert: contiene `'debit_nonce::text'` **y** `'debit_amount_atomic::text'`.
  (b) **round-trip**: assert que `claim_reconciliation` (vía `wireRpc`) recibe `p_nonce === '4312989337224638380'`
      exacto, y que `reverifyDebitedByTxHash` (mock `mockReverify`) recibe el nonce reconstruido
      `4312989337224638380n`.

- **T-NEW-7 · round-trip nonce listPending** (AC-4):
  `listPending` con row `debit_nonce: '4312989337224638380'` (vía `wireFrom`/mock del select) → el item del
  output `PendingRow` tiene `nonce === '4312989337224638380'` (string exacto; `listPending` mapea
  `r.debit_nonce → nonce` sin BigInt).

- **T-NEW-8 · round-trip amount + cast-presence driftCheck** (AC-2/AC-4/CD-6):
  `driftCheck` con 1 row `debit_amount_atomic: '4312989337224638380'` → el output agrupado tiene
  `sumDebitedAtomic === '4312989337224638380'` (exacto; guarda el 2º campo NUMERIC vía la suma `bigint`).
  Además assert que el select de `driftCheck` contiene `'debit_amount_atomic::text'` y **NO**
  `'debit_nonce::text'` (CD-6, driftCheck no trae nonce).

- **T-NEW-9 · safe amount byte-idéntico driftCheck** (AC-5/CD-1):
  `driftCheck` con `debit_amount_atomic: '3000000000000000000'` (redondo, representable) →
  `sumDebitedAtomic === '3000000000000000000'` (idéntico con/sin fix; documenta el invariante seguro).

> **Nota AC-7 (E2E on-chain two-hop)**: es criterio de **activación/deploy** (requiere firma
> `DebitAuthorization` real + `ESCROW_SETTLE_ENABLED` ON + chain default). NO se ejercita en unit-tests
> (fuera del alcance de F3). No es bloqueante para el merge del fix.

---

## 6. Guardas / Constraint Directives que el Dev DEBE respetar

- **CD-1 — byte-idéntico < 2^53**: PROHIBIDO cualquier cambio de comportamiento para valores
  representables exactos en float64 (p.ej. `3000000000000000000`, `7`). OBLIGATORIO test de byte-identidad
  (T-NEW-3, T-NEW-9).
- **CD-3 — sin migración**: PROHIBIDO tocar schema/tipo de columna. `NUMERIC(78,0)` queda igual. 100% capa
  de lectura. NO se crea ni edita ningún `.sql`.
- **CD-4 — no tocar captura**: PROHIBIDO tocar el path de captura (body del request, `debit-capture.ts`
  `captureDebitSignature`, `capture.nonce`/`capture.amount`) — ya opera sobre strings del cliente.
- **CD-6 — no castear columnas ausentes**: `driftCheck` castea SOLO `debit_amount_atomic` (NO trae
  `debit_nonce`). `debit_deadline` (BIGINT) NUNCA se castea. NO agregues `::text` a una columna que el
  select no lista.
- **CD-7 — no alias**: exactamente `col::text` preservando la key. PROHIBIDO `alias:col::text`.
- **CD-8 — anti-recurrencia `vi.hoisted`** (ref: WKH-191c auto-blindaje#1, WKH-194 auto-blindaje#1): TODO
  símbolo (spy, clase de error, doble, array de captura) referenciado dentro de una factory `vi.mock(...)`
  DEBE declararse vía `vi.hoisted(() => ...)` o dentro de la propia factory/closure. Este repo tuvo ≥2
  fallos de suite (TDZ / "error when mocking a module") por esta causa. **Los nuevos tests reutilizan los
  mocks YA hoisteados.** PROHIBIDO introducir un `const`/`class` top-level nuevo consumido por una factory
  sin `vi.hoisted`. Para las capturas de cast-presence (T-NEW-4/T-NEW-6), capturá el arg de `select`
  **dentro del closure del double existente**, no con un símbolo global nuevo.
- **CD-9 — anti-tautología**: los tests NO son `expect(true).toBe(true)`. El round-trip ejercita
  `BigInt(...)`/output real sobre el valor del incidente y compara contra el `bigint`/string exacto
  esperado.
- **CD-5 (heredada)**: el `.select()` de `readValidDebitSignature` sigue siendo el único literal repetido de
  sus campos — no introducir un segundo lugar con los mismos nombres de columna sin cast.

---

## 7. DT-5 — Fallback de compilación (tsc / `npm run build`)

`database.types.ts` ya tipa las 3 columnas como `string`, así que el resultado post-cast debería seguir
tipando `string`. **Si `tsc`/`npm run build` protesta** porque el type-parser de `@supabase/postgrest-js`
no reconoce el sufijo `::text` y degrada el campo a `unknown`/error:

- En `debit-capture.ts`, `reconciliation.ts` (`listPending`/`resolveIntent`/`driftCheck`): el patrón
  `const row = data as unknown as <Interface>` **YA EXISTE** en esos sitios
  (`debit-capture.ts:125`, `reconciliation.ts:194`/`238`/`416`) → no hace falta agregar nada nuevo; ese
  cast absorbe el tipo. Confirmá que sigue presente tras tu edit.
- En `arbiter.ts` read-first (que hoy NO usa ese patrón): narrow-castear
  `const existing = data as { nonce: string | null } | null;`.

Esto NO es un cambio de contrato: es defensa de compilación. **Verificación obligatoria: `npm run build`
(tsc) limpio antes de declarar F3 done.**

---

## 8. Patrones / Exemplars verificados (paths confirmados)

- `src/adapters/escrow/debit-capture.test.ts:386-425` — `validRow(overrides)` factory (default `debit_nonce: '7'`) + `stubReaderRow(row)` builder-double con `select: vi.fn(() => builder)` (**capturable** vía `.mock.calls`). Mocks top-level ya hoisteados (`logSpy`, `mockGetDefaultChainKey`, `mockGetAdaptersBundle`, `mockResolveEscrowContract`).
- `src/services/arbiter.test.ts:~209/234/334-374/1625-1675` — `nonceStore` (read-first double de `a2a_arbiter_nonces`), `nonceRpcCalls()`, `resolveNonceArg(idx)`, T4 read-first exactly-once. Mocks ya hoisteados.
- `src/services/reconciliation.test.ts:86-150/461` — `sigRow(overrides)`, `wireFrom({sigResult})` (double thenable), `wireRpc({claim,record})`, asserts sobre `p_nonce`/`sumDebitedAtomic`/output. Cabecera con nota anti-tautología. Mocks ya hoisteados.

---

## 9. Definition of Done (implementación)

- [ ] Los 5 selects castean exactamente las columnas indicadas (§4), sin alias (CD-7), `driftCheck` con SOLO 1 columna (CD-6), `debit_deadline` intacto.
- [ ] Comentario `ValidDebitRow` corregido (DT-2).
- [ ] `npm run build` (tsc) **limpio** — aplicando el fallback DT-5 solo si tsc protesta.
- [ ] `npm test` **verde**: los 3 archivos de test tocados + suite completa **sin regresión**.
- [ ] Los **9 tests nuevos** (T-NEW-1..9) pasan, cada uno con guarda real (cast-presence o round-trip exacto), sin tautologías (CD-9), sin símbolos top-level nuevos en factories `vi.mock` sin `vi.hoisted` (CD-8).
- [ ] Sin cambios fuera de las 6 rutas del Scope IN. Sin `.sql` nuevo (CD-3). Sin tocar captura (CD-4).
