# F4 QA Report — WKH-194 · Contra-medida del nonce del árbitro (anti-griefing MNR-1/R-3)

> Fase: F4 (QA — validación de ACs con evidencia)
> Fecha: 2026-07-13
> Revisor: nexus-qa
> Input: work-item.md + sdd.md + story-HU-194.md + ar-report.md (APROBADO, 1 MNR) + cr-report.md (APROBADO, 1 MNR) + working tree (fix-pack sin commitear aún)

**Veredicto global: APROBADO PARA DONE**

---

## 1. Runtime / Gates (ejecutados por mí, no re-uso ciego del CR)

| Gate | Resultado | Nota |
|------|-----------|------|
| `npx tsc --noEmit` | ✅ EXIT 0 | — |
| `npx vitest run` | ✅ **2985 pass / 0 fail** | +1 vs los 2984 de AR/CR — el fix-pack (guard de entropía) agregó test(s) nuevo(s) (`arbiter-executor.test.ts:576-593`). Suma consistente con el diff. |
| `npm run build` | ✅ EXIT 0 | `tsc -p tsconfig.build.json` limpio + copia de estáticos OK |
| `./node_modules/.bin/biome check src/` | ✅ EXIT 0 | 323 files, sin fixes pendientes |

No re-ejecuté nada que CR ya hubiera confirmado sin motivo — los corrí igual porque el fix-pack post-CR (2 MENORes cerrados) modificó código después del último `vitest run` documentado en cr-report.md (2984→2985), así que la confirmación de CR quedaba desactualizada por 1 test; re-correr era obligatorio, no redundante.

## 2. DB / Migración — estado real

- Migración `supabase/migrations/20260713000003_wkh194_arbiter_nonces{,_down}.sql` existe en disco, **untracked** (no commiteada) y **NO aplicada** al remoto (`bdwvrwzvsldephfibmuu`). Confirmado por:
  - El propio task brief la marca explícitamente **PENDING-DEPLOY**.
  - Intenté una query de solo-lectura (`SELECT ... FROM a2a_arbiter_nonces LIMIT 1` vía PostgREST) para confirmar la NO-existencia de la tabla en remoto; el clasificador de permisos de auto-mode la bloqueó (acción de lectura contra una DB compartida dev/prod-adjacent sin autorización explícita del usuario para ese target). No insistí ni busqué un rodeo — es la conducta correcta ante ese guardrail.
  - Evidencia de archivo (suficiente dado el estado declarado): `git status` muestra la migración como `??` (untracked) — nunca pasó por un commit ni por un paso de deploy documentado en este pipeline. Consistente con "PENDING-DEPLOY".
- **Revisión estática de la migración (lectura, no ejecución)**:
  - Aditiva 100%: `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` + `CREATE OR REPLACE FUNCTION` — sin `DROP`/`ALTER TABLE ... existente`/`TRUNCATE` (`20260713000003_wkh194_arbiter_nonces.sql:15-70`).
  - RPC `get_or_create_arbiter_nonce` es `SECURITY DEFINER` con `SET search_path = public, pg_temp` (`:72-73`, sin schema-hijacking), `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role` (`:74-77`, no expuesta a PostgREST anónimo).
  - Owner-guard DB-level: `SELECT owner_ref FROM a2a_payment_intents WHERE id = p_intent_id FOR UPDATE` + `RAISE EXCEPTION OWNERSHIP_MISMATCH` si no matchea (`:44-54`).
  - First-writer-wins atómico: `INSERT ... ON CONFLICT (intent_id) DO NOTHING` + re-`SELECT` del ganador (`:57-64`), `intent_id UUID PRIMARY KEY`.
  - Down reversible y acotado: `DROP FUNCTION IF EXISTS` + `DROP TABLE IF EXISTS`, sin tocar `a2a_payment_intents`/`a2a_arbitrations` (`20260713000003_wkh194_arbiter_nonces_down.sql:8-9`).
- **Env var**: `ARBITER_NONCE_SECRET` documentada en `.env.example:317-327` (guía `openssl rand -hex 32`, fail-closed explicado). No está seteada en `.env` local (`grep -c ARBITER_NONCE_SECRET .env` → no match), consistente con testnet/dev inerte. No hay forma programática de listar env vars del deployment target (Railway) desde este entorno — **NO VERIFICABLE** ese lado; no bloquea porque la HU es testnet-only y el árbitro sigue inerte (`ESCROW_ARBITER_ENABLED` no está en `true` en prod, heredado de 191g).

## 3. Acceptance Criteria — evidencia archivo:línea

| AC | Texto (resumen) | Status | Evidencia |
|----|------------------|--------|-----------|
| AC-1 | Nonce sin persistir: derivar incorporando `ARBITER_NONCE_SECRET`, persistir ANTES de `resolveDispute` | ✅ PASS | `src/adapters/escrow/arbiter-executor.ts:76-93` (`deriveArbiterNonce(keyIdHash,intentId,secret)`, secret como 4º arg del `encodePacked`/`keccak256`). Persistencia antes del uso: `src/services/arbiter.ts:127-154` (deriva candidate → RPC `get_or_create_arbiter_nonce` persiste → devuelve el ganador) invocado en `arbiter.ts:208` ANTES de `executeResolveDispute` (`:212-219`). Test: `arbiter.test.ts:1656-1666` (T4, 1ª pasada: miss → 1 RPC call, nonce = `EXPECTED_NONCE`). |
| AC-2 | Nonce ya persistido: reusar EXACTO, SHALL NOT recomputar | ✅ PASS | Read-first `src/services/arbiter.ts:106-121` (`.select('nonce').eq('intent_id',...).eq('owner_ref',...).maybeSingle()`, hit → `return BigInt(...)` sin llegar a `deriveArbiterNonce`). Test genuino con contraste fuerte: `arbiter.test.ts:1656-1675` (T4) — **rota el secreto** (`process.env.ARBITER_NONCE_SECRET = 'y'.repeat(64)`, línea 1669) entre la 1ª y 2ª pasada y asserta `nonce2 === nonce1` (`:1673`) y `nonceRpcCalls()` NO incrementa (`:1674`) — prueba que el retry NO depende de la estabilidad del secreto (exactamente lo que pide CD-1/AC-2). |
| AC-3 | `ARBITER_NONCE_SECRET` ausente/vacío con flag ON → fallback operator-custodial, SHALL NOT usar fórmula pública | ✅ PASS | `getArbiterNonceSecret()` (`arbiter-executor.ts:116-145`): `undefined`/`''`/whitespace → `null` (`:118-124`); el caller `getOrCreateArbiterNonce` (`arbiter.ts:124-125`) retorna `null` en ese caso → `settleArbitrationOnChain:209` cae a `settlePaymentIntentOnChain(base)`. No existe ningún camino que use `deriveArbiterNonce(kh,id)` sin secreto (firma de 3 args obligatorios, `tsc` lo fuerza). Test: `arbiter.test.ts:1678-1693` (T5) — secreto ausente → `executeResolveDispute` NO invocado (`:1690`), `mockSettle` (operator-custodial) SÍ invocado (`:1691`), `nonceRpcCalls()===0` (`:1692`, ni siquiera persiste). Unit: `arbiter-executor.test.ts:558-574`. |
| AC-3b (fix-pack MNR-1 AR) | El guard de fortaleza debe ser de entropía, no solo largo | ✅ PASS | `arbiter-executor.ts:95-105` (constante `ARBITER_NONCE_SECRET_MIN_UNIQUE=16`) + `:133-143` (`new Set(secret).size < 16 → null`, comentario explica el umbral). Tests con contraste: `arbiter-executor.test.ts:576-593` — `'a'.repeat(32)` (1 único) → `null`; `'12'.repeat(16)` (2 únicos) → `null`; 15 únicos rellenados a 48 chars → `null`; hex-random `openssl`-like (16 únicos) → **aceptado** (`:591-592`). Heurística defendible y probada en ambos sentidos (falso-positivo y falso-negativo). |
| AC-4 | Bit 255 SIEMPRE seteado (namespace hygiene, secreto se agrega no reemplaza) | ✅ PASS | `arbiter-executor.ts:92` (`ARBITER_NONCE_FLAG \| (BigInt(digest) & ARBITER_NONCE_LOW_MASK)`), estructura idéntica a la fórmula pre-194 salvo el 4º campo del digest. Test: `arbiter-executor.test.ts:512-516` (bit 255 con secreto) y `:532-538` (rango `[2^255,2^256)` disjunto de nonces de debit). |
| AC-5 | No-adivinable sin el secreto (equivalente a ~255 bits uniformes) | ✅ PASS | `arbiter-executor.ts:81-91` — el secreto entra como componente adicional del preimage de `keccak256`; sin él, un tercero con `keyIdHash`+`intentId` públicos no puede reproducir el digest. Test T2 (`arbiter-executor.test.ts:541-550`): mismos inputs públicos, secretos `'a'*64` vs `'b'*64` → nonces distintos (`:548`) y ambos distintos del nonce con `TEST_SECRET` (`:549`) — demuestra la no-re-derivabilidad sin conocer el secreto exacto. La cota criptográfica de "255 bits" es una propiedad de `keccak256` (no re-probable por un test unitario) — aceptado por diseño (AR ya lo evaluó como OK, con el único caveat de entropía del secreto cerrado por AC-3b). |
| AC-6 | Byte-idéntico en las otras 3 patas del gate (flag OFF / sin escrow / consent false) | ✅ PASS | `git diff HEAD -- src/services/arbiter.ts` confirma que el ÚNICO cambio dentro de `settleArbitrationOnChain` es el reemplazo de la línea `const nonce = deriveArbiterNonce(...)` por `getOrCreateArbiterNonce(...)` (`arbiter.ts:208-209`); los pasos 0/1/2 del gate (flag OFF `:187`, sin chainKey/escrow `:191-193`, consent false `:197-199`) quedan sin tocar una sola línea. Test flag-OFF: `arbiter.test.ts:1696-1713` (T6) — `executeResolveDispute` NO invocado, `nonceRpcCalls()===0`, y **`from('a2a_arbiter_nonces')` NUNCA se consulta** (`:1708-1712`) — inercia total, no solo "no persiste", sino "ni lee". |
| AC-7 (agregada en SDD, extensión de AR MNR-1) | `NonceAlreadyUsed` → `failed_ambiguous` RECONCILE, SIN refund; contraste otra causa → refund | ✅ PASS | Diagnóstico post-mortem `arbiter-executor.ts:376-408` (simulateContract con viem real → `revert.data?.errorName === 'NonceAlreadyUsed'` → `{kind:'not_moved', reason: ARBITER_NONCE_COLLISION_REASON}`). Intercepción en `arbiter.ts:848-878`: `settle.failureKind==='unequivocal' && settle.error===ARBITER_NONCE_COLLISION_REASON` → `recordSettleOutcome(...,'failed_ambiguous',...)` + `finalizePaymentIntent(...,'failed_ambiguous',...)` + `return this.outcome(meta, arbUsd, 0, ...)` (residual 0, línea 877, comentario explícito "NO refund"). Test: `arbiter.test.ts:1717-1736` (T8) — `db.refunds` **vacío** (`toEqual([])`, `:1731`), `settle_outcome==='failed_ambiguous'` (`:1730`), `error_message` contiene `'RECONCILE: NONCE_COLLISION'` (`:1733-1735`). Contraste real: `arbiter.test.ts:1738-1753` (T8-contraste) — `reason:'REVERTED'` (no colisión) → `failed_unequivocal` + `db.refunds===[10]` (refund completo, `:1751`) — confirma que la intercepción es específica de la colisión, no un cambio general del terminal `unequivocal`. |
| Ownership Guard (regla del proyecto, no numerada como AC pero exigida por CLAUDE.md) | `.eq('owner_ref',...)` en toda query/RPC sobre datos por-owner | ✅ PASS | App-layer: `arbiter.ts:110` (`.eq('owner_ref', ownerRef)` en el read-first). DB-layer (defensa en profundidad, doble capa): migración `:44-54` (`SELECT owner_ref ... FOR UPDATE` + `RAISE EXCEPTION OWNERSHIP_MISMATCH` si `v_owner IS DISTINCT FROM p_owner_ref`). RPC `GRANT` restringido a `service_role` (migración `:74-77`) — no expuesto a PostgREST anónimo. |
| Secreto nunca logueado (CD-2) | — | ✅ PASS | `getArbiterNonceSecret` (`arbiter-executor.ts:116-145`) solo emite `{present:false}` (`:120`) o `{present:true, weak:true}` (`:128`, `:139`) — nunca el valor, largo real, ni conteo de únicos (comentario explícito `:112-114` sobre por qué no filtrar ni el conteo). El RPC solo transmite `p_nonce` (hash derivado, one-way) — nunca el secreto (`arbiter.ts:136`). Test: `arbiter-executor.test.ts:595-626` — itera TODOS los `mockLogWarn.mock.calls`, asserta que las keys del meta ∈ `{present,weak}` y que ni `JSON.stringify(meta)` ni el mensaje contienen ninguno de los 3 valores de secreto usados en el test (`:611-624`). |

**7/7 ACs + 2 requisitos transversales (ownership, secreto-nunca-logueado) = PASS con evidencia archivo:línea. Cero FAIL. Cero NO VERIFICABLE en el código** (el único NO VERIFICABLE es el estado de env vars en el deployment target Railway — irrelevante hoy porque el árbitro sigue inerte en prod).

## 4. Drift Detection

- **Scope**: `git diff --name-only HEAD` = `{.env.example, doc/sdd/_INDEX.md, src/adapters/escrow/abi.ts, src/adapters/escrow/arbiter-executor.{ts,test.ts}, src/services/arbiter.{ts,test.ts}, src/types/database.types.ts}` + untracked `supabase/migrations/20260713000003_wkh194_arbiter_nonces{,_down}.sql`. Coincide 1:1 con el Scope IN del work-item + la nota justificada de AR/CR sobre `database.types.ts` (contrato de datos generado del RPC/tabla nueva del propio W0 de esta HU, no un archivo ajeno — mismo patrón que 191a/b/c). Sin drift.
- **`contracts/**` intacto** — confirmado (`git diff --name-only` no lo incluye), cumple CD-4. El `settle`/`payment-intent.ts` operator-custodial no aparece en el diff — cumple CD-5/AC-6.
- **Wave order**: revisando `story-HU-194.md` (§7-A hasta §7-H, W1→W2), el diff observado sigue el mismo orden lógico (secreto+deriveArbiterNonce → ABI error → persistencia/wire → diagnóstico → defensa AC-7). No hay evidencia de violación de wave (todo en un único diff sin commits intermedios que reordenen, consistente con el modo de trabajo).
- **Fix-pack post-CR**: 2 MENORes cerrados, ambos verificados en el código actual — (a) guard de entropía `ARBITER_NONCE_SECRET_MIN_UNIQUE` (AR MNR-1, `arbiter-executor.ts:95-105,133-143` + tests `:576-593`), (b) log del error de read-first (CR MNR-1, `arbiter.ts:112-119`). Ninguno introduce drift — ambos dentro de los mismos archivos ya en Scope IN.
- **Test drift**: los tests T1-T9 descritos en AR/CR existen en el código real con los mismos nombres/líneas aproximadas citadas (verificado línea por línea arriba en la tabla de ACs). Sin tests fantasma ni tests modificados para forzar un pase (no se tocó ningún test PRE-existente de 191g fuera de las 3 llamadas de 2-args→3-args migradas, confirmado por AR/CR y no contradicho por mi lectura del diff).

**Drift: none.**

## 5. Gate Confirmation — AR + CR

- AR (`ar-report.md`): **APROBADO con MENORs** — 0 BLOQUEANTEs, 1 MNR-1 (entropía del secreto) — **cerrado por el fix-pack** (verificado arriba).
- CR (`cr-report.md`): **APROBADO** — 0 BLOQUEANTEs, 1 MNR-1 (log del error de read-first) — **cerrado por el fix-pack** (verificado arriba).
- Ambos reportan `tsc`/`biome`/`vitest` verdes al momento de su revisión (2984 tests); yo re-confirmé post-fix-pack con 2985 (ver §1) — consistente con el delta esperado por los 2 tests de entropía agregados.

## 6. No-break de 191g/WKH-139/189

- `git diff` de `arbiter.ts`/`arbiter-executor.ts` es 100% insertions salvo la única línea reemplazada (`deriveArbiterNonce` 2-arg → `getOrCreateArbiterNonce`) dentro de `settleArbitrationOnChain` — todas las demás funciones (`bestEffortLockForDispute`, `bestEffortReleaseDispute`, `executeLockForDispute`, `executeReleaseDispute`, el resto de `executeArbitration`) quedan sin tocar. `a2a_arbitrations` y su timing de escritura (WKH-139 v2) no aparecen en el diff — DT-2 respetado (tabla nueva dedicada, no se movió el timing existente). `WKH-189` (dashboard/endpoints admin de `a2a_arbitrations`) no está en el diff.

---

## Veredicto final

**APROBADO PARA DONE.** 7/7 ACs (incluyendo AC-7 agregada en SDD) con evidencia archivo:línea + 2 requisitos transversales (ownership guard, secreto-nunca-logueado) verificados. Gates propios: tsc/build/biome/vitest (2985/2985) verdes. Migración leída y verificada estáticamente como aditiva/segura, confirmada NO aplicada aún (PENDING-DEPLOY, consistente con lo esperado — el intento de verificación directa contra el remoto fue bloqueado por el guardrail de auto-mode, correctamente, y no se buscó un rodeo). Cero drift de scope/wave/spec. Los 2 MENORes de AR/CR están cerrados en el working tree. Listo para F5 (docs/DONE) — pendiente que Docs/el humano decida cuándo commitear el fix-pack + aplicar la migración (recordar: sigue testnet-only e inerte, no hay urgencia de deploy inmediato salvo antes de activar el árbitro on-chain con fondos reales, per WKH-191h/193).
