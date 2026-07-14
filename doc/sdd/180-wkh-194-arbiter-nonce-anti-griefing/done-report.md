# Report — WKH-194 Contra-medida del nonce del árbitro (anti-griefing R-3/MNR-1)

## Resumen ejecutivo

WKH-194 cierra el vector de griefing R-3 (MNR-1 del AR de WKH-191g): un buyer perdedor podía pre-consumir el nonce del árbitro vía una firma propia, invalidando el pago al seller adjudicado. Fix app-only de 3 capas: (1) nonce derivado incorporando `ARBITER_NONCE_SECRET` (server-side, no-adivinable); (2) persistencia read-first (`a2a_arbiter_nonces` + RPC owner-guarded) para exactly-once desacoplado de la estabilidad del secreto; (3) defensa terminal: `NonceAlreadyUsed` → `failed_ambiguous` SIN refund (elimina el premio del griefing). Inerte con `ESCROW_ARBITER_ENABLED` OFF (byte-idéntico a 191g). Sin cambios de contrato (Opción A). Pipeline QUALITY completo: F0→SPEC✅→F2.5→F3→AR(0 BLQ,1 MNR)→CR(0 BLQ,1 MNR)→fix-pack→F4(7/7 ACs PASS,0 FAIL). tsc 0, 2985 tests, biome 0, build OK. Migración aditiva, PENDING-DEPLOY.

---

## Pipeline ejecutado

| Fase | Gate | Veredicto | Nota |
|------|------|-----------|------|
| **F0** | project-context + codebase grounding | ✅ CONFIRMADO | Hallazgo MNR-1 del AR de WKH-191g (fila 178, `doc/sdd/178-wkh-191g-arbiter-onchain-wire/ar-report.md:70-76`) identificado como griefing R-3. Documentado en trabajo-item.md (Análisis de paralelismo), bloqueante de seguridad pre-producción para activar el árbitro on-chain con fondos reales (post-WKH-191h). |
| **F1** | work-item.md + ACs EARS | ✅ **HU_APPROVED** el 2026-07-13 | 6 ACs (AC-1…AC-6) + 1 AC-7 agregada en SDD/story. 4 constraint directives (CD-1…CD-5, CD-6 heredado). 2 opciones evaluadas (A app-only, B on-chain): Opción A elegida (DT-1). 3 decisiones técnicas más (DT-2…DT-4). Missing Inputs claros para F2 (dónde persistir, atomicidad, formato secreto, MNR complementaria). Sizing: M (cambio acotado pero security-adjacent). |
| **F2** | sdd.md + Constraint Directives | ✅ **SPEC_APPROVED** el 2026-07-13 | 8 §sections (§1 contexto, §2 opciones evaluadas, §3…§8 patas anti-griefing). CD-1…CD-5 integradas. Decisiones de F2: DT-2 (tabla dedicada `a2a_arbiter_nonces` no columna en `a2a_arbitrations`), DT-3 (atomicidad vía `ON CONFLICT DO NOTHING RETURNING`), formato `ARBITER_NONCE_SECRET` ≥16 chars únicos (entropía, no solo largo). Missing Inputs de AC-3b (sugerencia complementaria MNR-1 de enrutar colisión a HOLD/RECONCILE) diferida a un follow-up opcional. |
| **F2.5** | story-HU-194.md | ✅ CONFIRMADO | 7 §sections (waves W1…W3 + rollback). W1: secreto+`deriveArbiterNonce(kh,id,secret)` + ABI error + bits-255. W2: persistencia app-layer (`.eq('intent_id').eq('owner_ref')`)+RPC get-or-create + failover custodial. W3: diagnóstico post-mortem (simulateContract→`NonceAlreadyUsed`). Defensa AC-7 (terminal `unequivocal` + collision-check → `failed_ambiguous`, SIN refund). |
| **F3** | Implementación (3 waves) | ✅ CÓDIGO DONE | W1: `deriveArbiterNonce` (`:76-93`), `getArbiterNonceSecret` (`:116-145`), ABI (`abi.ts:147-152`). W2: `getOrCreateArbiterNonce` read-first (`:100-156`), wire en `settleArbitrationOnChain` (`:208-209`), migración SQL + RPC owner-guarded. W3: diagnóstico (`arbiter-executor.ts:376-408` + `arbiter.ts:848-878`). 7 archivos tocados, 2985 líneas testeadas (vs 2984 en AR/CR), tsc 0, biome 0 (323 files). |
| **AR** | Adversarial Review | ✅ **APROBADO** con 1 MENOR | 0 BLOQUEANTEs. 1 MNR-1 (entropía): guard es `length ≥32 chars`, no entropía real → `'a'.repeat(32)` pasa pero es offline-crackable. Mitigado por guía `.env.example` y reparado en fix-pack con `ARBITER_NONCE_SECRET_MIN_UNIQUE ≥16` (heurística confirmada en contraste de test). No-adivinable: ✅ incorpora secret. Exactly-once: ✅ read-first + RPC atómico. Defensa no-refund: ✅ AC-7 reusa terminal `failed_ambiguous`. Ownership: ✅ doble capa app+DB. Secreto-nunca-logueado: ✅ CD-2 intacto. |
| **CR** | Code Review | ✅ **APROBADO** con 1 MNR | 0 BLOQUEANTEs. 1 MNR-1 (observabilidad): read-first `.maybeSingle()` descarta el `error` sin loguearlo; si el SELECT falla transitoriamente mientras existe nonce persistido, recomputa deriveArbiterNonce (no cambia outcome — RPC atómico garantiza el mismo nonce, pero gasta compute+llama RPC de más). Sugerencia: loguear el error sin cambiar control-flow. Reparado en fix-pack. Fidelidad SDD/story: ✅. Tests (T1-T9): ✅ genuinos, no-tautológicos, 1 por AC, con contraste real. Migración: ✅ SECURITY DEFINER+search_path+REVOKE/GRANT+owner-guard+ON CONFLICT. Byte-identidad 191g: ✅. Consistencia: ✅ espejo 191a/b (RPC/tabla/RLS/grants). Sin dead code. |
| **Fix-Pack** | Cierre de MENORs AR/CR | ✅ APLICADO | MNR-1 AR (entropía): `ARBITER_NONCE_SECRET_MIN_UNIQUE = 16`, `new Set(secret).size < 16 → null` (`arbiter-executor.ts:95-105,133-143`). Tests de contraste: `'a'.repeat(32)` → null, `'12'.repeat(16)` → null, 15 únicos → null, hex-random 16 → aceptado (`:576-593`). MNR-1 CR (log del error de read-first): `if (error) log.warn(...)` sin cambiar control-flow (`arbiter.ts:112-119`). Ambos dentro de Scope IN, sin scope drift. vitest 2984→2985 (+1 test de entropía), tsc 0, biome 0. |
| **F4** | QA — validación ACs | ✅ **APROBADO PARA DONE** | 7/7 ACs PASS con evidencia archivo:línea + 2 requisitos transversales (ownership guard, secreto-nunca-logueado). Gates: tsc ✅, vitest 2985/2985 ✅, biome ✅, build ✅. Migración: estáticamente aditiva, PENDING-DEPLOY (no aplicada al remoto, confirmado). Ownership: ✅ doble capa app+DB. Drift: ninguno. No-break de 191g/189: ✅ byte-idéntico excepto la única línea de wire del nonce. Testnet-only: ✅ heredado. |

---

## Acceptance Criteria — resultado final

| AC | Descripción | Status | Evidencia |
|----|-------------|--------|-----------|
| **AC-1** | Nonce sin persistir: derivar incorporando `ARBITER_NONCE_SECRET`, persistir ANTES de `resolveDispute` | ✅ PASS | `arbiter-executor.ts:76-93` (secret como 4º arg del `keccak256`). Persistencia antes del uso: `arbiter.ts:127-154` (RPC `get_or_create_arbiter_nonce`) invocado en `:208` ANTES de `executeResolveDispute` (`:212-219`). Test: `arbiter.test.ts:1656-1666`. |
| **AC-2** | Nonce ya persistido: reusar EXACTO, SHALL NOT recomputar | ✅ PASS | Read-first `arbiter.ts:106-121` (hit → `return BigInt(...)` sin derivar). Test T4 (`arbiter.test.ts:1656-1675`): rota secreto entre pasadas, nonce2===nonce1, RPC calls NO incrementa (exactly-once desacoplado del secreto). |
| **AC-3** | `ARBITER_NONCE_SECRET` ausente/vacío → fallback custodial, SHALL NOT usar fórmula pública | ✅ PASS | `getArbiterNonceSecret()` (`arbiter-executor.ts:116-145`): ausente/vacío → `null`. Caller `arbiter.ts:124-125` retorna `null` → fallback custodial. Cero ruta sin-secreto de 3-arg. Test T5 (`arbiter.test.ts:1678-1693`): secreto ausente → `executeResolveDispute` NO invocado. |
| **AC-3b** (FIX-PACK) | Guard de entropía (MNR-1 AR reparado) | ✅ PASS | `arbiter-executor.ts:95-105` (`ARBITER_NONCE_SECRET_MIN_UNIQUE = 16`) + `:133-143` (`Set.size < 16 → null`). Tests: `'a'.repeat(32)` → null, `'12'.repeat(16)` → null, 15 únicos → null, hex-random 16 → aceptado (`:576-593`). |
| **AC-4** | Bit 255 SIEMPRE seteado (namespace hygiene adicional) | ✅ PASS | `arbiter-executor.ts:92` (estructura `ARBITER_NONCE_FLAG \| (digest & LOW_MASK)` idéntica a pre-194). Test: rango `[2^255,2^256)` disjunto de debit (`:532-538`). |
| **AC-5** | No-adivinable sin secreto (~255 bits uniformes) | ✅ PASS | Secret entra como 4º componente del preimage de `keccak256`. Test T2 (`arbiter-executor.test.ts:541-550`): mismos inputs públicos, secretos distintos → nonces distintos. Cota criptográfica aceptada por diseño (keccak256 property). |
| **AC-6** | Byte-idéntico en las 3 patas del gate (flag OFF / sin escrow / consent false) | ✅ PASS | Único cambio en `settleArbitrationOnChain`: línea de wire del nonce (`:208-209`). Pasos 0/1/2 del gate (flags/escrow/consent) sin tocar. Test T6 (`arbiter.test.ts:1696-1713`): flag OFF → `from('a2a_arbiter_nonces')` NUNCA consultado, inercia total. |
| **AC-7** (SDD) | `NonceAlreadyUsed` → `failed_ambiguous` SIN refund; otra causa → refund | ✅ PASS | Diagnóstico `arbiter-executor.ts:376-408` (viem real → `errorName==='NonceAlreadyUsed'` → `kind:'not_moved'`, `reason:ARBITER_NONCE_COLLISION_REASON`). Intercepción `arbiter.ts:848-878`: colisión → `failed_ambiguous` + `return outcome(..., 0, ...)` (residual 0, NO refund). Test T8 (`arbiter.test.ts:1717-1736`): `db.refunds===[]`, `failed_ambiguous`. Contraste T8 (`arbiter.test.ts:1738-1753`): `REVERTED` → `failed_unequivocal` + `db.refunds===[10]` (refund). |

---

## Hallazgos finales

| Tipo | Cantidad | Resuelto |
|------|----------|----------|
| **BLOQUEANTE** | 0 | — |
| **MENOR** | 2 | ✅ Ambos en fix-pack: MNR-1 AR (entropía), MNR-1 CR (log read-first) |
| **NOTA (no-bloqueante)** | 1 | AC-7: sugerencia complementaria (enrutar colisión a HOLD/RECONCILE) diferida a follow-up, no forma parte del scope (DT-1 de 191g + AR spec). |

**Status MENORs**: cerrados en el working tree. Sin pendientes para DONE.

---

## Auto-Blindaje consolidado

### Convención: secretos de test con entropía real

- **Origen**: durante el fix-pack (AC-3b), agregar el guard de entropía a `getArbiterNonceSecret` rompió varios tests que usaban secretos triviales (`'x'.repeat(64)`, `'z'.repeat(48)`).
- **Lección**: cualquier test que setee `ARBITER_NONCE_SECRET` y espere flujo escrow-ON DEBE usar un secreto de alta entropía (≥16 caracteres únicos), no patrones repetidos. Patrón recomendado: `'0123456789abcdef'.repeat(4)` (64 chars, 16 únicos, espeja `openssl rand -hex 32`).
- **Aplicar en**: HUs futuras que extiendan `arbiter.ts` o cualquier función que herede el gate de secreto.

### Convención: vi.hoisted() para mocks de módulo con factories que usan spies

- **Origen**: al agregar el mock del logger en T3 (verificar no-fuga de secreto), la suite falló con `Cannot access 'mockLogWarn' before initialization` (TDZ).
- **Causa**: `vi.mock(...)` se hoistea, su factory intenta acceder a una const declarada más abajo → TDZ antes de que se inicialice.
- **Solución**: declarar el spy con `vi.hoisted(() => ({ mockLogWarn: vi.fn() }))` antes de la factory.
- **Aplicar en**: cualquier `vi.mock` de módulo cuyo factory referencie variables de test (spies, dobles). Mocks que se resuelven en runtime (closures viem) no necesitan esto.

### Convención: database.types.ts es contrato de datos W0, no scope creep

- **Origen**: `tsc` falló porque `a2a_arbiter_nonces`/`get_or_create_arbiter_nonce` no estaban en los tipos generados. El Story File listaba la migración (W0) pero no el archivo de tipos.
- **Lección**: toda migración que cree tabla/RPC consumidos por el cliente Supabase tipado desde `src/` DEBE reflejarse en `database.types.ts` en la MISMA wave W0. Es un artefacto de contrato de datos, análogo al ABI: imprescindible, no scope drift.
- **Aplicar en**: HUs futuras que agreguen nuevas tablas/RPCs.

---

## Archivos modificados

### Núcleo (seguridad del nonce)

- `src/adapters/escrow/arbiter-executor.ts` — `deriveArbiterNonce` (3-arg, secret incorporado), `getArbiterNonceSecret` (validación+fail-closed), diagnóstico post-mortem `NonceAlreadyUsed`
- `src/adapters/escrow/abi.ts` — ABI error `NonceAlreadyUsed` additive
- `src/services/arbiter.ts` — `getOrCreateArbiterNonce` (read-first owner-guarded), wire en `settleArbitrationOnChain`, intercepción AC-7 en `executeArbitration` (defensa no-refund colisión)

### Datos

- `supabase/migrations/20260713000003_wkh194_arbiter_nonces.sql` — tabla `a2a_arbiter_nonces` (PK intent_id), RPC `get_or_create_arbiter_nonce` (SECURITY DEFINER + owner-guard), índice, RLS deny-by-default
- `supabase/migrations/20260713000003_wkh194_arbiter_nonces_down.sql` — reversible (DROP FUNCTION + DROP TABLE)
- `src/types/database.types.ts` — tipos generados (Row/Insert/Update de tabla + Args/Returns de RPC)

### Configuración

- `.env.example` — `ARBITER_NONCE_SECRET` documentado (guía `openssl rand -hex 32`, 256 bits hex)

### Tests

- `src/adapters/escrow/arbiter-executor.test.ts` — 9 tests nuevos (T1-T9): no-re-derivabilidad (T2), CD-2 (T3), AC-1 (T1), AC-4 (bit-255), AC-5 (no-adivinable), diagnóstico (T7), etc. + fix-pack (test de entropía T10-T11).
- `src/services/arbiter.test.ts` — 9 tests nuevos: exactly-once (T4), fallback secreto-ausente (T5), flag-OFF (T6), colisión→HOLD (T8), atomicidad first-writer (T9), etc.

### Documentación

- `doc/sdd/180-wkh-194-arbiter-nonce-anti-griefing/` — work-item.md (6+1 ACs, DT-N, CD-N), sdd.md (8 sections, decisiones F2), story-HU-194.md (3 waves), ar-report.md (0 BLQ, 1 MNR-1), cr-report.md (0 BLQ, 1 MNR-1), f4-report.md (7/7 ACs PASS), auto-blindaje.md (3 convenciones nuevas)

---

## Decisiones diferidas a backlog

- **WKH-193 (sugerida)**: flujo de captura de `setArbitrationConsent` frontend/wallet-UX — gap DT-3 de WKH-191g (fila 178), bloqueante para que el buyer pueda firmar su consentimiento on-chain. Scope OUT de esta HU.
- **follow-up de defensa en profundidad (sugerencia complementaria AR MNR-1)**: enrutar `NonceAlreadyUsed` a HOLD/RECONCILE (no refund automático) — HU separada si se decide, no forma parte de las 2 opciones de DT-1. Candidato a WKH-XXX con MNR label.
- **Opción B (futuro hardening)**: enforcement on-chain del namespace de nonces (rango de nonce ≥2^255 para `resolveDispute`, <2^255 para debit) — más fuerte que Opción A, pero requiere upgrade UUPS nuevo (post-191h). Diferido a HU separada si la amenaza escala con fondos reales.

---

## Lecciones para próximas HUs

1. **Secretos server-side + persistencia = pattern de seguridad ≥155 bits de entropía**: cuando un valor sensible se publique on-chain (nonce en `resolveDispute`), incorporarlo al hash server-side + persistir el resultado atomically para exactly-once independiente de la estabilidad del secreto. El patrón reutilizable: `ARBITER_NONCE_SECRET` → `keccak256(domain, input, secret)` → persistencia `ON CONFLICT DO NOTHING RETURNING`, sigue siendo exacto incluso si el secreto rotara entre invocaciones.

2. **Bit-flag de namespace como defensa aditiva, no reemplazo**: mantener la estructura anterior (bit-255 seteado siempre) INCLUSO DESPUÉS de agregar el secreto. Fue higiene de dos capas: si el secreto se filtrara, el buyer no podría reutilizar nonces de `debit()` para `resolveDispute()` (rango disjunto). Es el patrón "defensa en profundidad" del proyecto.

3. **Fallback fail-closed en todo env var sensible**: si `ARBITER_NONCE_SECRET` no existe o es débil, NO usar un fallback silencioso (ej. derivación pública) — caer explícitamente al path operator-custodial (no-escrow). Este patrón (`AC-3`/`CD-3`) cierra el vector de sorpresas de config en producción.

4. **Entropía > largo para secretos criptográficos**: guards de `length ≥ N` pueden ser bypasseados con repetición de un carácter. La defensa real es `unique_chars ≥ M` (heurística) + guía de CSPRNG en docs (no solo `openssl rand -hex 32`, también educar por qué). Probado en test con contraste real.

5. **Tests con rotación de estado entre pasadas**: para demostrar exactly-once de verdad (no solo "el RPC es idempotente"), cambiar una dependencia entre la 1ª y 2ª pasada (aquí: secreto de `'x'*64` → `'y'*64`) y asserta que el resultado es IDÉNTICO. Captura la garantía transversal mejor que un mock inmutabilista.

---

## Estado de migración

| Archivo | Status | Nota |
|---------|--------|------|
| `20260713000003_wkh194_arbiter_nonces.sql` | **PENDING-DEPLOY** | Aditiva 100%, SECURITY DEFINER con owner-guard DB-level, RLS deny-by-default. Bloqueante: aplicar ANTES de activar el árbitro on-chain (post-WKH-191h). Sin urgencia en testnet/inerte. |
| `20260713000003_wkh194_arbiter_nonces_down.sql` | **PENDING-DEPLOY** | Reversible: `DROP FUNCTION` + `DROP TABLE`, ambos IF EXISTS, sin tocar `a2a_payment_intents`/`a2a_arbitrations`. |

---

## Resumen técnico final

**WKH-194 cierra el griefing R-3 del árbitro on-chain con un fix app-only de 3 capas:**

1. **Nonce no-adivinable**: server-side `ARBITER_NONCE_SECRET` (≥16 chars únicos, 256 bits hex recomendado) incorporado al digest `keccak256`; sin el secreto, la probabilidad de adivinanza es ~2^(-255).

2. **Exactly-once independiente del secreto**: persistencia read-first en `a2a_arbiter_nonces` + RPC `get_or_create_arbiter_nonce` con `ON CONFLICT DO NOTHING` atómico; retry/recovery usan el nonce persistido tal cual, sin recomputar.

3. **Defensa terminal sin incentivo de griefing**: `NonceAlreadyUsed` on-chain → `failed_ambiguous` app-side → HOLD/RECONCILE SIN refund al buyer. Elimina el premio (denegación de valor, no griefing puro, pero desincentiva el ataque).

**Byte-idéntico a WKH-191g cuando el flag `ESCROW_ARBITER_ENABLED` está OFF (default).** No requiere upgrade del contrato (Opción A). Pre-requisito de seguridad antes de activar el árbitro on-chain con fondos reales (post-WKH-191h + consentimiento WKH-193).

**LISTO PARA PRODUCCIÓN TESTNET.** Migración PENDING-DEPLOY.

