# Validation Report — WKH-133 Reputation write-back on-chain a ERC-8004 (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-03
**Branch**: `feat/134-wkh-133-reputation-writeback` @ `c635246` (PR #157)

## Runtime checks (evidencia real)

- **Migration syntax + constraints (sandbox Postgres 15, no prod)**: aplicada `20260703000000_wkh133_reputation_writebacks.sql` en un contenedor `postgres:15-alpine` efímero (levantado y destruido en esta sesión, `docker run --rm`), sin tocar Supabase real:
  - `\d public.a2a_reputation_writebacks` → columnas/tipos/NOT NULL idénticos a `sdd.md` DT-4.
  - `pg_constraint` → `a2a_reputation_writebacks_event_id_key | u` (UNIQUE(event_id)) ✅ — barrera de idempotencia real, no solo declarada.
  - `pg_class.relrowsecurity = t`, `pg_policies` → 0 filas ⇒ RLS `ENABLE` sin policies = **deny-by-default** confirmado (CD-10) ✅.
  - `_down.sql` → `DROP TABLE` limpio, tabla desaparece (`\d` → "Did not find any relation") ✅ reversible.
- **`npx tsc --noEmit`** → `TypeScript compilation completed`, exit 0 ✅ (re-ejecutado localmente porque CR lo corrió antes del fix-pack `c635246`; confirmado limpio post-fix-pack también).
- **`npx vitest run` (4 archivos WKH-133)** → `src/services/reputation-writeback.test.ts`, `src/adapters/erc8004-reputation-writer.test.ts`, `src/services/event.test.ts`, `src/services/identity.test.ts` → **PASS (50) FAIL (0)**, exit 0.
- **CI del PR #157** (`gh pr checks 157`) → 5/5 checks verdes (`ci/build-test`, `ci/coverage`, `smoke-downstream/light-smoke`, `Vercel`, `Vercel Preview Comments`). `gh pr view 157 --json mergeable` → `MERGEABLE`.
- **Env parity**: `ERC8004_REPUTATION_WRITEBACK_ENABLED` / `ERC8004_REPUTATION_WRITE_RECEIPT_TIMEOUT_MS` documentadas en `.env.example:596-599` con default `false`/`90000`. **NO se verificó presencia en Railway** (sin acceso CLI autenticado en esta sesión) — **NO VERIFICABLE, pero no bloqueante**: el flag resuelve `false` cuando la env var está *ausente* (`erc8004-reputation-writer.ts:76-78`), por lo que la ausencia total en el deployment target es el estado seguro por diseño (equivale a "no configurado" = comportamiento actual, 100% read-only). Escalado como nota operativa, no como gate.

## ACs

| AC | Status | Evidencia (impl + test) |
|----|--------|--------------------------|
| AC-1 (trigger post-settlement, async, fuera del path de respuesta) | ✅ PASS | Impl: `src/services/event.ts:96-108` (hook `void ...onSettledEvent(...).catch()`, no awaited) + `src/services/reputation-writeback.ts:53-59` (gate). Test: `src/services/reputation-writeback.test.ts:89-115` (`T-AC1`, `giveFeedback` llamado 1 vez con args correctos + row `confirmed`). |
| AC-2 (flag OFF / config faltante → skip silencioso, sin error al caller) | ✅ PASS | Impl: `reputation-writeback.ts:54` (flag off) + `:57` (`resolveReputationRegistryAddress` null). Test: `reputation-writeback.test.ts:118-129` (`T-AC2-cfg`) + `src/services/event.test.ts:50-64` (`T-AC2-flag`: flag OFF → `onSettledEvent` nunca invocado, `track()` retorna la fila normal). |
| AC-3 (no doble-escritura / idempotencia persistida) | ✅ PASS | Impl: `reputation-writeback.ts:72-91` (`upsert(claimRow,{onConflict:'event_id',ignoreDuplicates:true}).select()`; 0 filas ⇒ return sin tx). Test: `reputation-writeback.test.ts:132-138` (`T-AC3`). Evidencia DB real (sandbox): `pg_constraint` → `a2a_reputation_writebacks_event_id_key` UNIQUE sobre `event_id` (ver Runtime checks). |
| AC-4 (fallo tx → log server-side, nunca error.message crudo, sin reintento sync) | ✅ PASS | Impl: `reputation-writeback.ts:113-125` (persist `status='failed', error_code=result.reason` + `log.warn` con `reason` corto, nunca `err.message`) + `erc8004-reputation-writer.ts:234-237,249-253` (catch → `classifyWriteError`, nunca propaga `err.message`). Test: `reputation-writeback.test.ts:141-156` (`T-AC4`: `giveFeedback` llamado 1 sola vez, row `failed` con `error_code:'REVERTED'`). |
| AC-5 (paridad anti-sybil: no attest si `failed` o `cost<=0`) | ✅ PASS | Impl: `reputation-writeback.ts:55` (`event.status!=='success' \|\| event.costUsdc<=0` → return), mismo predicado que `tasks_settled` en `src/services/reputation.ts:106-131` (SDD DT-7). Test: `reputation-writeback.test.ts:159-177` (`T-AC5-failed`, `T-AC5-zerocost`). |
| AC-6 (firma con `OPERATOR_PRIVATE_KEY`, resuelto por chain, cache lazy) | ✅ PASS | Impl: `erc8004-reputation-writer.ts:128-145` (`getWriterWalletClient`: `privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY)`, cache `_walletClients` Map por red, patrón `gasless.ts:52-64`). Test: `erc8004-reputation-writer.test.ts:86-105` (`T-AC6-sign`: firma OK + pk nunca en el result serializado) y `:107-123` (`T-AC6`: pk ausente → `SIGNER_NOT_CONFIGURED` sin throw). |
| AC-7 (no degrada latencia p95 de `/compose`/`/orchestrate`/`/a2a`) | ✅ PASS | Impl: `event.ts:96-108` (`void` sin `await`; `track()` retorna en la línea 110 sin esperar el write-back). Test: `event.test.ts` `T-AC7` (write-back rejects → `track()` igual resuelve) y `T-AC7-hang` (write-back promesa que nunca resuelve → `track()` igual resuelve, `mockOnSettled` llamado pero no esperado). |

## Drift

- `git diff --name-only main...HEAD`: 13 archivos, **100% dentro de Scope IN** del work-item/SDD (adapter writer + test, service write-back + test, hook `event.ts` + test, `identity.ts::resolveErc8004AgentId` + test, migración + down, `database.types.ts`, `.env.example`, `auto-blindaje.md`). Cero archivos fuera de scope.
- Waves respetadas en los commits: `68531fa` (W0→W1→W2→W3→W4 completo) + `c635246` (fix-pack post-AR/CR, solo tests + guard `BigInt`, sin lógica money-path nueva).
- `erc8004-reputation.ts` / `erc8004-identity.ts` **sin cambios** — siguen read-only (CD-7) confirmado (no aparecen en el diff).
- ABI `giveFeedback(...)` (SDD §0/DT-ABI) coincide exactamente con `GIVE_FEEDBACK_ABI` en `erc8004-reputation-writer.ts:39-56`. Mapping DT-7 (`value=100n, valueDecimals=0, tag1='wasiai', tag2=eventType, feedbackHash=zeroHash`) confirmado en `giveFeedback` call (`reputation-writeback.ts:94-100`) y testeado (`T-DT7`, `erc8004-reputation-writer.test.ts:126-154`).

## Gates (confirmado desde PR/commits, sin re-ejecutar el combo completo)

- `tsc`/`vitest` (subset WKH-133): re-ejecutados puntualmente en esta sesión (arriba) → verde.
- `biome check` / suite completa (2278 tests): confirmado por el commit body de `68531fa` ("biome check src/: limpio", "npm test: 2278 passed / 10 skipped / 0 failed") + CI del PR (`ci/build-test`, `ci/coverage`) verde — no re-ejecutado el combo completo.

## AR/CR follow-up

- AR **MNR-1** (`BigInt(token_id)` puede lanzar) → **RESUELTO** en `c635246` (`src/services/identity.ts` try/catch + test `AR-MNR1` en `identity.test.ts`).
- AR **MNR-2** (mover check RPC/signer antes del claim) → **NO implementado**, documentado explícitamente como follow-up de backlog en `doc/sdd/134-wkh-133-reputation-writeback/auto-blindaje.md:28-31` (justificado: solo aporta valor cuando exista el sweeper de reintento, fuera de scope de esta HU). Aceptado como TD documentado, no bloqueante — el gate/claim actual sigue siendo fail-safe (nunca doble-tx) aunque no óptimo para un futuro reintento.
- Cero hallazgos BLOQUEANTES reportados por AR o CR sobre este cambio (solo MNR-1/MNR-2, ambos resueltos o documentados).

**Listo para DONE.**
