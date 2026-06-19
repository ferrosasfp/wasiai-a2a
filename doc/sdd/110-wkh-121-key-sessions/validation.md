# Validation Report — WKH-121 Session Keys server-side

**Fecha**: 2026-06-19
**Branch**: feat/110-wkh-121-key-sessions
**Veredicto**: APROBADO PARA DONE

> Nota de cierre: este archivo persiste el contenido del veredicto F4 producido por nexus-qa (el agente entregó el reporte pero no lo guardó en disco; el orquestador lo persiste sin alterar el veredicto ni la evidencia).

---

## Runtime Checks

**DB / Migration (verificación de archivo, no de prod):**
- Tabla `a2a_key_sessions.sql` existe en `supabase/migrations/20260603000000_a2a_key_sessions.sql`. Timestamp `20260603000000` es posterior a `20260602000000_reputation_index.sql` (la última anterior). Correcto.
- Down migration `supabase/migrations/20260603000000_a2a_key_sessions_down.sql` existe con `BEGIN; DROP FUNCTION IF EXISTS ...; DROP TABLE IF EXISTS ...; COMMIT;`. Correcto.
- Hardening CD-7 verificado en el SQL: `ALTER FUNCTION public.debit_session_and_parent(...) SET search_path = public, pg_temp` (línea 91-92) + `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` (líneas 93-94) + `GRANT EXECUTE ... TO service_role` (líneas 95-96). Completo.
- RPC `debit_session_and_parent`: `FOR UPDATE` (línea 49), ownership re-check bajo lock (líneas 56-61), TOCTOU re-check revocado/expirado (líneas 64-68), budget check (líneas 72-74), `PERFORM increment_a2a_key_spend` (línea 81), UPDATE `spent_usd` (línea 84). Orden correcto DT-3.
- Migration no aplicada a prod (NO ejecutable en este ambiente sin `SUPABASE_SERVICE_KEY`): **NO VERIFICABLE en DB remota** — solo verificación de fuente SQL. Aceptable dado que el proyecto usa Railway/Supabase y la aplicación es testnet.

**Env Parity:**
- `.env.example` línea 158: `SESSION_MAX_TTL_SECONDS=86400` presente junto al bloque `DELEGATION_*`. Cumple CD-5.
- Deployment target (Railway): NO VERIFICABLE programáticamente — requiere verificación manual del operador. Bajo riesgo: fail-safe `NaN/<=0 → 86400` (`key-session.ts:66-68`).

---

## AC Verification

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (creación 201 + token once) | PASS | `src/routes/auth.keySession.test.ts:143` (T-CREATE-1) → 201 + body `session_token` + `scope`; `src/services/key-session.test.ts:115` → INSERT no contiene token plano. Impl: `key-session.ts:215` devuelve token plano solo en retorno; `:183` persiste solo hash SHA-256. |
| AC-2 (scope ⊆ padre) | PASS | `src/services/key-session.test.ts:184` (budget) + `:193` (registries ⊄ padre) + `:202` (⊆ válido). `src/routes/auth.keySession.test.ts:177` (400 SCOPE_EXCEEDS_PARENT). Impl: `key-session.ts:82-88` (`isSubsetOfParent`) + `:151-163` + `:166-172`. Null-en-sesión hereda padre: `:220-233` + `a2a-key.ts:591-601`. |
| AC-3 (TTL obligatorio) | PASS | `src/services/key-session.test.ts:138` (ttl<=0), `:149` (ttl>max), `:158` (NaN env → fail-safe). `src/routes/auth.keySession.test.ts:192,207,222`. Impl: `key-session.ts:133-141` + `maxTtlSeconds()` `:65-68`. |
| AC-4 (validación middleware) | PASS | `src/middleware/a2a-key.test.ts:1479` (T-MW-LOOKUP). Impl: `a2a-key.ts:467-630` (6 pasos). |
| AC-5 (token inválido → 401) | PASS | `src/middleware/a2a-key.test.ts:1511` → 401 `SESSION_TOKEN_INVALID`. Impl: `a2a-key.ts:472-476`. |
| AC-6 (sesión expirada → 403) | PASS | `src/middleware/a2a-key.test.ts:1525` → 403 `SESSION_EXPIRED` + debit no llamado. Impl: `a2a-key.ts:487-492`. |
| AC-7 (parent inactiva → 403) | PASS | `src/middleware/a2a-key.test.ts:1559` → 403 `KEY_INACTIVE`. Impl: `a2a-key.ts:496-502`. |
| AC-8 (débito atómico sesión + parent) | PASS | Step 0: `a2a-key.test.ts:1500` + `key-session.test.ts:369`. Steps 1..N (BLQ-ALTO-1 fix): `compose.test.ts:1531` (T-SESS-MULTISTEP(a)) → `mockDebit.toHaveBeenNthCalledWith` con `keySessionContext`. Impl: `compose.ts:159-165` pasa `keySessionContext`; `budget.ts:79` enruta al RPC. |
| AC-9 (budget agotado → 403) | PASS | `key-session.test.ts:258` → `SessionBudgetExhaustedError`. `a2a-key.test.ts:1573`. Multi-step: `compose.test.ts:1578` (T-SESS-MULTISTEP(b)) corta mid-pipeline, step 3 no ejecutado. |
| AC-10 (scope efectivo) | PASS | `a2a-key.test.ts:1588` (sesión `[a]`+padre `[a,b]`→`[a]`) + `:1608` (sesión null+padre `[a,b]`→`[a,b]`). Impl: `a2a-key.ts:588-601`. |
| AC-11 (ownership guard) | PASS | `key-session.test.ts:433` (`eq('owner_ref','user-1')` en `list`) + `:459` (excepción `lookupByTokenHash`) + `:343` (OWNERSHIP_MISMATCH). Firma: `key-session.ts:327-328` (`ownerId: string`). RPC re-valida: `migration:56-61`. |
| AC-12 (no sub-delegación → 403) | PASS | `auth.keySession.test.ts:252` → 403 `SESSION_NOT_ALLOWED` + create no llamado. Impl: `auth.ts:1114-1119` (gate ANTES de resolveCallerKey; MNR-3: `SessionNotAllowedError` en `:1118`). |
| AC-13 (listado status derivado) | PASS | `key-session.test.ts:391` (active/expired/revoked + spent). `auth.keySession.test.ts:281` (200 array plano). Impl: `key-session.ts:271-319`. |
| AC-14 (back-compat bearer master) | PASS | `a2a-key.test.ts:1628` (T-BACKCOMPAT): master → 200 + session lookup/debit no llamados. Impl: path master `a2a-key.ts:632-757` no tocado. |
| AC-15 (coexistencia WKH-101) | PASS | `a2a-key.test.ts:1646` (`wasi_a2a_sess_`→keySessionService) + `:1665` (`wasi_a2a_session_`→delegationService). Orden de detección + prefijos mutuamente exclusivos. |

---

## Drift Detection

- **Scope drift**: los 19 archivos del Scope IN presentes. Archivo extra `src/services/orchestrate.billing.test.ts` (M): solo agrega trailing `undefined` a aserciones `mockDebit` por el nuevo arg de `budget.debit`. Documentado en auto-blindaje.md. No es drift funcional.
- **Docs fuera de Scope IN** (BACKLOG, HACKATHON-FINAL, _INDEX, agent-key-vs-passport, jury-qa*): documentación pura, sin código.
- **Wave order**: W0 → W1 → W2 → W3 → W4 → W5-FIX. Respeta dependencias.
- **Spec adherence**: DT-1..DT-5 implementados; CD-1..CD-7 y CD-AB-1..5 verificados. Sin desviaciones.
- **Test drift**: `KeySessionErrorCode` eliminado (MNR-4, 0 referencias). No se debilitaron tests existentes.

---

## Quality Gates

- **tsc --noEmit**: PASS (exit 0)
- **npm test**: PASS — 1422 passed / 3 skipped (exit 0; coincide con baseline RE-AR)
- **npm run lint** (biome): PASS (exit 0; `info` en `reputation.ts:116` pre-existente, fuera de scope)

---

## AR/CR Follow-up

| Finding | Estado | Verificación |
|---------|--------|--------------|
| BLQ-ALTO-1 (cap sesión no aplica en steps 1..N) | CERRADO | `compose.ts:164` + `types/index.ts:284` + `routes/compose.ts:164` + `routes/orchestrate.ts:84` + `orchestrate.ts:414`. T-SESS-MULTISTEP (a/b/c) en `compose.test.ts:1516-1675`. |
| MNR-1 AR (test multi-step faltaba) | CERRADO | T-SESS-MULTISTEP implementado. |
| MNR-2 AR (per-call limit bajo sesión) | ABIERTO (backlog) | No es AC de WKH-121. Para WKH-122+. |
| MNR-1 CR (SessionNotAllowedError unused) | CERRADO | `auth.ts:1118` instancia la clase. |
| MNR-2 CR (KeySessionErrorCode unused) | CERRADO | `grep` → 0 resultados; tsc verde. |

---

**Veredicto final: APROBADO PARA DONE.**

Los 15 ACs PASS con evidencia archivo:línea. Quality gates verdes (tsc 0, vitest 1422/3, biome 0). BLQ-ALTO-1 cerrado end-to-end con T-SESS-MULTISTEP que reproduce el bug genuinamente. Sin scope drift funcional. Migration con timestamp correcto, hardening CD-7 completo, down migration presente.
