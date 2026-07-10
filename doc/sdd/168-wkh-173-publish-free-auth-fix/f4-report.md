# F4 Validation Report — WKH-173 (`requireA2AKey()` auth-only)

**Veredicto**: APROBADO PARA DONE (código). Deploy Railway (W3) queda `!` pendiente humano post-merge (Scope OUT explícito de F1-F4).

**Fecha**: 2026-07-10

## Runtime checks (re-ejecutados por QA, no solo leídos)

- `tsc --noEmit` → 0 errores (repo completo).
- `biome check` scoped a los 6 archivos tocados (`a2a-key.ts`, `a2a-key.test.ts`, `agents.ts`, `agents.publish.test.ts`, `agents.ownership.test.ts`, `agents.publish.authonly.test.ts`) → `Checked 6 files in 32ms. No fixes applied.` (0 findings). `biome check .` a nivel repo falla por un error de config PRE-EXISTENTE en `packages/agent-sdk/biome.json` (nested root config) — confirmado reproducible en `main` limpio (`git stash` → mismo error) → no relacionado a esta HU, no bloqueante.
- `vitest run` (suite completa) → **157 archivos passed | 4 skipped (161)**, **2828 tests passed | 10 skipped (2838)**, 0 fallos.
- `vitest run` scoped al path pago + esta HU (`a2a-key.test.ts`, `agents.publish.test.ts`, `agents.ownership.test.ts`, `agents.publish.authonly.test.ts`, `registries*.test.ts`) → **7 archivos / 146 tests, 0 fallos**.

## AC-by-AC (evidencia archivo:línea)

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (auth sin débito, master/deleg/sesión) | PASS | `src/middleware/a2a-key.test.ts:2604-2618` (T-RA-01 master, `mockDebit not.toHaveBeenCalled`, sin header `x-a2a-remaining-budget`), `:2621-2636` (T-RA-02 delegación, `mockDebitDelegation`+`mockDebit` not called), `:2639-2654` (T-RA-03 sesión, `mockSessionDebit`+`mockDebit` not called). Rutas swapeadas: `src/routes/agents.ts` (POST/PATCH/DELETE/GET usan `preHandler: [...requireA2AKey()]` — confirmado en `git diff`). |
| AC-2 (mismos error codes de auth) | PASS | `a2a-key.test.ts:2657-2785` (T-RA-04a-i): `KEY_NOT_FOUND`, `KEY_INACTIVE` (master + parent-de-delegación + parent-de-sesión), `INVALID_SESSION_TOKEN`, `DELEGATION_REVOKED`, `DELEGATION_EXPIRED`, `SESSION_TOKEN_INVALID`, `SESSION_EXPIRED`. `SIGNATURE_REQUIRED` en `:2844-2860` (T-RA-07a). |
| AC-3 (sin credencial → 403 A2A_KEY_REQUIRED, x402 NUNCA invocado) | PASS | Unit: `a2a-key.test.ts:2788-2813` (T-RA-05a/05b, `mockGetPaymentAdapter not.toHaveBeenCalled` incluso con `x-payment` presente). Integración de RUTA REAL (middleware no mockeado): `src/routes/agents.publish.authonly.test.ts:97-109` (T-RT-01) — `POST /agents` con `x-payment` válido pero sin a2a-key → `403 A2A_KEY_REQUIRED`, `getPaymentAdapter` jamás invocado. Fuente: `src/middleware/a2a-key.ts:1241-1261` (`requireA2AKey`) no importa ni llama `requirePayment`/x402 en ningún branch (confirmado por lectura directa del código — CD-2). |
| AC-4 (`request.a2aKeyRow` con scoping idéntico) | PASS | `a2a-key.test.ts:2816-2841` (T-RA-06, delegación con `allowed_agent_slugs` propagado), `:2922-2958` (T-RA-BLD, `buildDelegationEffectiveRow`/`buildSessionEffectiveRow` — mismos builders que usan ahora `resolveDelegationAuth`/`resolveKeySessionAuth`, confirmado via `git diff src/middleware/a2a-key.ts` líneas ~500-600 y ~737-820, refactor puro que reemplaza el objeto inline por la llamada al helper). Ownership check intacto: `src/routes/agents.ownership.test.ts` (5/5 passed, mock actualizado a `requireA2AKey` línea 66-72) — `OwnershipMismatchError` sigue operando sobre el mismo shape de `a2aKeyRow`. |
| AC-5 (compose/orchestrate/gasless/registries sin cambios de débito) | PASS | `git diff --name-only` → solo `a2a-key.ts`, `a2a-key.test.ts`, `agents.ts`, `agents.ownership.test.ts`, `agents.publish.test.ts`, `agents.publish.authonly.test.ts` (nuevo), `_INDEX.md`. Cero touches a `compose.ts`/`orchestrate.ts`/`gasless.ts`/`registries.ts`. Los bloques de débito de `resolveMasterAuth`/`resolveDelegationAuth`/`resolveKeySessionAuth` no se tocaron (solo se extrajo el armado de `effectiveRow` a un builder compartido, permitido explícitamente por CD-1 "refactor puro... cubierto 100% por AC-6"). Suites WKH-101/121/123/125/127 (`a2a-key.test.ts:1306-2569`) 100% verdes en la corrida completa. |
| AC-6 (suite completa 0 fallos) | PASS | `vitest run` (repo completo, ejecutado por QA): **2828 passed / 10 skipped, 0 failed** (157/161 archivos). |
| AC-7 (firma sigue exigida en auth-only) | PASS | `a2a-key.test.ts:2844-2860` (T-RA-07a, master sin firma → 401 SIGNATURE_REQUIRED), `:2862-2879` (T-RA-07b, firma válida → 200), `:2881-2898` (T-RA-07c, sesión sin firma → 401 SIGNATURE_REQUIRED). |
| AC-8 (spend-limits ignorados, DT-2) | PASS | `a2a-key.test.ts:2901-2919` (T-RA-08): key con `daily_limit_usd`/`daily_spent_usd` agotado y `max_spend_per_call_usd` bajo → `200`, `mockDebit not.toHaveBeenCalled`. |

## Regresión money-path (bug thenable del fix-pack, MNR-1)

El fix-pack extrajo `verifyOptInSignature` (helper compartido para el chequeo de firma en los 4 call-sites) y en su 1ª versión rompía el early-return del path PAGO porque `FastifyReply` es thenable y `await` lo desenvolvía a `undefined` (documentado en `doc/sdd/168-wkh-173-publish-free-auth-fix/auto-blindaje.md:9-13`). Confirmado que el fix (helper retorna `Promise<boolean>`, `src/middleware/a2a-key.ts:170-232`) sostiene el corte real:

- `a2a-key.test.ts:2201-2220` (AC-3 WKH-123, master sin firma → 401, `mockVerifySignedAuth`+`mockDebit` NUNCA llamados)
- `a2a-key.test.ts:2222-2242` (AC-3 WKH-123, sesión sin firma → 401, `mockSessionDebit` no llamado)
- `a2a-key.test.ts:2245-2292` (AC-4 WKH-123, firma inválida master+sesión → 401 SIGNATURE_INVALID, `mockDebit`/`mockSessionDebit` no llamados)
- `a2a-key.test.ts:2295-2339` (AC-5/AC-6 WKH-123, nonce replay + timestamp expirado → 401, sin débito)
- `a2a-key.test.ts:2404-2423` (AC-9 WKH-123, `funding_wallet` null → 403, sin débito)
- Contraparte positiva: `a2a-key.test.ts:2118-2168` (AC-1 WKH-123, firma válida master → 200 Y `mockDebit` SÍ llamado con `(TEST_KEY_ID, 2368, 1.0, undefined, undefined, undefined, 'user-1')`) — confirma que el helper no bloquea el débito legítimo, solo lo bloquea cuando corresponde.

Los 146 tests de la suite scoped (incluye estos) pasaron 0/0 en la corrida de QA.

## Drift

Ninguno. Scope IN del work-item/story-file matchea exactamente los archivos tocados (`git diff --name-only`). Waves W0 (builders refactor puro) → W1 (`requireA2AKey` + swap) → W2 (tests) respetadas según `auto-blindaje.md` y la estructura del diff. Docstring `agents.ts:16-21` actualizado a texto verificable ("Publicar/actualizar/borrar/listar es GRATIS... NUNCA invoca pago").

## CDs verificadas

- **CD-1** (resolvers pagos byte-idénticos salvo builders extraídos): PASS — `resolveMasterAuth`/`resolveDelegationAuth`/`resolveKeySessionAuth` conservan sus bloques de débito sin tocar; único cambio es el armado de `effectiveRow` vía `buildDelegationEffectiveRow`/`buildSessionEffectiveRow` (refactor puro, cubierto por AC-6/suite completa verde).
- **CD-2** (requireA2AKey nunca invoca x402): PASS — verificado por lectura directa de `a2a-key.ts:1241-1261` (sin import/llamada a `requirePayment`) + test de integración de ruta real (T-RT-01).
- **CD-3** (is_active/revoked/expires/require_signature enforced igual): PASS — cubierto por T-RA-04*/T-RA-07*.
- **CD-4** (suite completa `tsc`/`biome`/`vitest` en 0): PASS — re-ejecutados por QA (ver Runtime checks).
- **CD-5** (path master byte-idéntico, `resolveMasterAuth` no se toca in-place): PASS — el único cambio dentro de `resolveMasterAuth` es el swap del bloque inline de firma por `verifyOptInSignature(...)` (mismo comportamiento, ver auto-blindaje.md); no se tocó chain-resolution/débito/budget-header.
- **Scope**: sin migraciones SQL, sin touches a `compose.ts`/`orchestrate.ts`/`gasless.ts`/`registries.ts`.

## Gate Confirmation

No existe `cr-report.md`/`ar-report.md` en disco en este directorio (`doc/sdd/168-wkh-173-publish-free-auth-fix/` solo tiene `work-item.md`, `sdd.md`, `story-file.md`, `auto-blindaje.md`). El contexto del orquestador reporta AR (original + re-AR) con 0 BLQ y CR APPROVED (3 MENORes resueltas en fix-pack, incluyendo el bug thenable MNR-1) — no verificable directamente desde un artefacto CR/AR escrito, pero **QA re-ejecutó los 3 gates de forma independiente** (tsc/biome/vitest) con resultado 0/0/0 fallos, lo cual cubre el mismo terreno que confirmaría un CR report. El log `auto-blindaje.md` (líneas 9-13) documenta el hallazgo y fix del bug thenable de forma consistente con lo reportado.

## Pendiente por diseño

- **W3 — Deploy Railway (wasiai-a2a)**: código listo, tests verdes, sin deploy automático documentado para esta rama. Requiere merge a `main` + deploy manual/pipeline Railway. Marcado `!` humano — Scope OUT explícito de F1-F4 (work-item.md, Scope OUT).
- Cambios están en el working tree, sin commit todavía (branch sugerido `fix/168-wkh-173-publish-free-auth`, no creado aún) — a resolver en el paso DONE/commit.

**Listo para DONE (código). Deploy Railway queda como paso operativo post-merge.**
