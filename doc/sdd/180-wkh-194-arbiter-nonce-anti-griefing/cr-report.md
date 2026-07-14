# CR Report — WKH-194 · Contra-medida del nonce del árbitro (anti-griefing MNR-1/R-3)

> Fase: Code Review (Adversary — sección calidad/patrones)
> Fecha: 2026-07-13
> Revisor: nexus-adversary
> Input: story-HU-194.md + sdd.md + `git diff` (arbiter-executor.ts, abi.ts, arbiter.ts, database.types.ts, migración + tests)
> Gates de verificación: `tsc --noEmit` ✅ · `biome check src/` ✅ (323 files) · `vitest run` ✅ **2984 pass / 0 fail**

---

## Resumen ejecutivo

Implementación de **alta calidad y fidelidad total** al SDD/Story File. Las 3 capas
(secreto server-side + persistencia exactly-once + defensa no-refund AC-7) están donde el SDD
las especificó, con byte-identidad del happy-path y de las ramas no tocadas de 191g. Migración
segura (SECURITY DEFINER + search_path fijado + REVOKE/GRANT + owner-guard FOR UPDATE + ON CONFLICT
DO NOTHING + down reversible), espejo exacto de los exemplars 191a/191b. Tests no-tautológicos,
1 por AC, con contrastes reales. tsc/biome/vitest verdes.

**Veredicto: APROBADO** (1 MNR opcional, no bloquea DONE).

---

## Checks de calidad

### 1. Fidelidad SDD / Story File — OK

- `deriveArbiterNonce(keyIdHash, intentId, secret)` con 3er arg `secret` incorporado al `encodePacked`
  como 4º `'string'`, bit-255 intacto (`ARBITER_NONCE_FLAG | (...)`) — `arbiter-executor.ts:76-93`. Fiel a §7-A.
- `getArbiterNonceSecret(): string | null` nunca-throw, fail-closed, `< 32 chars → null`, loguea SOLO
  `{present}`/`{present, weak}` — `arbiter-executor.ts:103-121`. Fiel a §7-B/CD-2.
- `getOrCreateArbiterNonce` read-first owner-guarded (`.eq('intent_id').eq('owner_ref')` antes del compute) —
  `arbiter.ts:100-156`. No usa `mapArbPgError` (correcto: degrada a `null`, no propaga). Fiel a §7-E.
- Wire en `settleArbitrationOnChain:199-200`: reemplaza la derivación fresca por `getOrCreateArbiterNonce`
  + `if (nonce === null) return settlePaymentIntentOnChain(base)`. Ubicado tras `decimals` y antes de
  `executeResolveDispute`. Fiel a §7-F.
- Diagnóstico post-mortem `NonceAlreadyUsed` SOLO dentro de la rama `receipt.status !== 'success'`
  (`arbiter-executor.ts:347-385`); happy-path (`:419 confirmed`), timeout (`:344`), write-fail (`:331`),
  event-mismatch (`:416`) byte-idénticos. Fiel a §7-G/CD-5.
- Defensa AC-7 (`arbiter.ts:836-869`) insertada JUSTO ANTES del `if (settle.failureKind === 'unequivocal')`
  de `:872`; espeja estructuralmente la rama `ambiguous` (`:903-928`) → `failed_ambiguous`, residual 0,
  `db.refunds` intacto. Fiel a §7-H.
- ABI: `{ type:'error', name:'NonceAlreadyUsed', inputs:[] }` additive al final de `ESCROW_ABI`
  (`abi.ts:147-152`), sin reordenar. Fiel a §7-D.
- **Desviación `database.types.ts` (fuera del Scope IN del Story File):** CORRECTA. Es el contrato de
  datos generado del W0 (Row/Insert/Update de `a2a_arbiter_nonces` + Args/Returns del RPC). Precedente
  confirmado: 191a/191b/191c también tocaron `database.types.ts` en sus commits (`git log`). Sin él, tsc
  strict falla en `supabase.from('a2a_arbiter_nonces')` y `supabase.rpc('get_or_create_arbiter_nonce')`.
  `nonce`/`p_nonce`/`persisted_nonce` tipados como `string` (uint256, evita pérdida > 2^53). No es scope drift.

### 2. Calidad de los tests (T1–T9 + fixes) — OK

- **T2 no-re-derivabilidad** (`arbiter-executor.test.ts:541-550`): prueba que dos secretos distintos con
  los MISMOS inputs públicos → nonces distintos (`withA !== withB`, `withA !== same1`). Demuestra que sin
  el secreto el nonce no se reproduce. No tautológico.
- **T3 CD-2** (`:573-599`): itera `mockLogWarn.mock.calls` y asserta que las keys del meta ∈ `{present, weak}`
  y que ni el meta serializado ni el mensaje contienen el secreto. Verificación real de no-fuga.
- **T4 exactly-once via persistencia** (`arbiter.test.ts:1654-1673`): tras la 1ª pasada **rota el secreto**
  (`'y'.repeat(64)`) y asserta (a) mismo nonce en la 2ª pasada y (b) `nonceRpcCalls()` NO incrementa →
  prueba que NO recomputa (read-first hit). Spy real vía conteo de llamadas al RPC. Fuerte.
- **T7 diagnóstico** (`:602-661`): construye un `ContractFunctionRevertedError` real con el selector de
  4 bytes `NonceAlreadyUsed()` envuelto en `BaseError{cause}`; cubre (a) colisión→`NONCE_ALREADY_USED`,
  (b) otro revert→`REVERTED`, (c) RPC-down→`REVERTED` sin lanzar. Usa clases viem reales, no mocks que mienten.
- **T8 colisión→HOLD** (`:1715-1734`): `db.refunds` **vacío** (`toEqual([])`) + `settle_outcome` `failed_ambiguous`
  + `status` `failed` + mensaje `RECONCILE: NONCE_COLLISION`. **T8-contraste** (`:1736-1751`): `REVERTED`
  (no colisión) → `failed_unequivocal` + `db.refunds === [10]` (refund completo) + `status` `refunded`.
  El contraste es lo que hace el test genuino (prueba que la intercepción es específica de la colisión).
- **T5/T6** verifican fallback custodial (executeResolveDispute NO invocado) e inercia con flag OFF
  (`from('a2a_arbiter_nonces')` NO consultado, RPC 0 calls). **T9** prueba que se usa el `persisted_nonce`
  del RPC (ganador atómico) y NO el candidate local (`nonceUsed !== EXPECTED_NONCE`).
- **Fixes de llamadas 2-arg**: `arbiter-executor.test.ts:84` (`NONCE`), `:513-546` (T1/T2), y
  `arbiter.test.ts:1374` (`EXPECTED_NONCE`) migrados al 3er arg con `TEST_SECRET = 'x'.repeat(64)`. tsc verde.

### 3. Migración / RPC — OK

`20260713000003_wkh194_arbiter_nonces.sql`:
- `SECURITY DEFINER` **con** `ALTER FUNCTION ... SET search_path = public, pg_temp` (`:72-73`) → sin schema
  hijacking. `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role` (`:74-77`) → no
  expuesta a PostgREST/anon.
- Owner-guard DB-level: `SELECT owner_ref ... FOR UPDATE` + `INTENT_NOT_FOUND` / `OWNERSHIP_MISMATCH`
  (`:44-54`) — espejo de `record_debit_hop1`. Doble capa con el `.eq('owner_ref')` app-layer.
- First-writer-wins atómico: `INSERT ... ON CONFLICT (intent_id) DO NOTHING` + re-SELECT del ganador
  (`:57-64`). `intent_id` PK → un único nonce inmutable por intent.
- `BEGIN/COMMIT` wrap (`:12,79`). RLS deny-by-default (`:26`). Numeración `000003` sin colisión.
- Down reversible: `DROP FUNCTION` + `DROP TABLE` aditivo, no toca `a2a_payment_intents`/`a2a_arbitrations`.
- **Nota (no finding):** la tabla habilita RLS sin CREATE POLICY (deny-all); el acceso real es vía
  `service_role`/BYPASSRLS + owner-guard app+RPC — idéntico al patrón documentado de WKH-53/191a. Consistente.

### 4. Legibilidad / seguridad — OK

- Secreto **nunca** logueado: solo `{present:false}` / `{present:true, weak:true}` (`arbiter-executor.ts:106-117`).
  El RPC-error log (`arbiter.ts:130-133`) emite `detail: error.message` — el único dato sensible que viaja al
  RPC es `p_nonce` (hash derivado one-way, NO el secreto). CD-2 intacto.
- Post-mortem `simulateContract` best-effort correctamente envuelto en try/catch, con `.walk()` para
  desanidar el `ContractFunctionRevertedError`; nunca lanza (cae a `'REVERTED'`).
- Manejo de bigint: `candidate.toString()` hacia el RPC, `BigInt(String(persisted))` de vuelta; sin
  pérdida de precisión. Nombres claros, comentarios con referencia a AC/CD. Sin dead code (la rama AC-7
  es alcanzable: `not_moved`→`failureKind:'unequivocal'`+`error:o.reason` en `arbiter.ts:214-221`).

### 5. Consistencia — OK

- Migración/RPC espeja 191a (tabla+RLS+grants) y 191b (`record_debit_hop1` get-or-persist idempotente).
- `getOrCreateArbiterNonce` sigue el estilo RPC-caller owner-guarded del propio `arbiter.ts` (patrón debit).
- La defensa AC-7 reusa el terminal `failed_ambiguous` de 191b/c (no-refund) con causa desambiguada
  (`RECONCILE: NONCE_COLLISION ...`) — SEMÁNTICA reusada, etiqueta literal propia. Consistente con §4.3(f).

### 6. Manejo de errores — OK

- `getArbiterNonceSecret` nunca-throw → `null` = señal de fallback.
- Read-first, RPC-error, RPC-sin-fila y throw del RPC → todos degradan a `null` → fallback operator-custodial
  (fail-closed, money-safe). Nunca on-chain sin nonce persistido.
- `catch {}` final de `settleArbitrationOnChain:231-234` byte-idéntico (CD-7).

---

## Hallazgos

### MNR-1 — read-first descarta el error del SELECT (robustez/observabilidad) · `arbiter.ts:106-112`

**Categoría:** Error Handling (calidad).
**Descripción:** `getOrCreateArbiterNonce` destructura `const { data: existing } = await supabase.from(...).maybeSingle()`
ignorando el campo `error`. Si el SELECT read-first falla transitoriamente (DB blip) **mientras ya existe un
nonce persistido**, `existing` es `null` → el flujo recomputa `deriveArbiterNonce` y llama al RPC.
**Impacto:** ninguno sobre corrección — el RPC (`ON CONFLICT DO NOTHING` + re-SELECT) devuelve el nonce
GANADOR ya persistido, así que el nonce EFECTIVO usado sigue siendo el mismo (exactly-once preservado por
la capa RPC, que es la garantía real). El único costo es un compute desperdiciado + una llamada RPC extra en
un caso muy raro, y la pérdida de un log ante error de lectura. NO viola el outcome de CD-1 (el retry produce
el nonce idéntico).
**Sugerencia (opcional, backlog):** loguear el `error` del read-first (`if (error) log.warn(...)`) para
observabilidad, sin cambiar el control-flow (seguir cayendo al RPC, que es idempotente). No bloquea DONE.

---

## Categorías sin hallazgos

- **Fidelidad, tests, migración, legibilidad, consistencia, seguridad del secreto, byte-identidad de 191g,
  scope** — OK (evidencia arriba).
- **Scope drift:** solo `database.types.ts` fuera del Scope IN literal, justificado como contrato de datos W0
  (precedente 191a/b/c). `contracts/**` intacto (CD-4). `a2a_arbitrations`/timing intactos (DT-2).

---

## Veredicto global

**APROBADO** — sin BLOQUEANTEs. 1 MNR opcional (`MNR-1`, no bloquea DONE; candidato a backlog de
observabilidad). tsc ✅ · biome ✅ · vitest **2984/2984** ✅. Listo para F4 (QA).
