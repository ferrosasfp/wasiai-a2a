# F4 — Validación (QA) — WKH-170 `remit-kyc-validator` (endpoint HTTP, etapa 1)

**Veredicto**: **APROBADO PARA DONE** (código) — 3 ACs quedan **PENDING-DEPLOY** (gated `!` humano, CD-7, no bloquean el gate F4).
**Fecha**: 2026-07-10
**Repo de código**: `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/`

---

## 1. Runtime checks (ejecutados en `wasiai-remittance-agents`, no re-uso de CR — no había `cr-report.md` en disco)

| Gate | Comando | Resultado |
|------|---------|-----------|
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | ✅ 0 errores |
| Tests | `npm run test` (`vitest run`) | ✅ **47/47 PASS**, 8 test files (incl. `route.test.ts` con **8 tests** — 7 originales + test 2b MENOR-2 del fix-pack) |
| Build | `npm run build` (`next build`) | ✅ Compiló; ruta nueva listada: `ƒ /api/agents/remit-kyc-validator/invoke` |

Conteo real de `route.test.ts` (`src/app/api/agents/remit-kyc-validator/invoke/route.test.ts`): 8 tests, incluyendo el test agregado post-AR (línea 70-79, `"campo extra NO-schema con PII → 200 y el body NO filtra la PII inyectada"`) que cierra MENOR-2 del AR.

## 2. AC-by-AC (evidencia archivo:línea)

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (discover muestra `remit-kyc-validator` activo, sin reemplazar `agentshop-kyc-validator`) | **PENDING-DEPLOY** | Query directa a `a2a_agents` (Supabase prod, SELECT read-only) filtrando `slug in (remit-kyc-validator, agentshop-kyc-validator, remit-corridor-fx)` → **0 filas** para `remit-kyc-validator` (aún no registrado, W4 pendiente). `remit-corridor-fx` sí existe (fila real, confirma que el mecanismo `POST /agents` funciona para este patrón). Falta: W4 (`POST /agents` con a2a-key + `payoutWallet`, gated `!`). |
| AC-2 (fila NUEVA en `a2a_agents`, slug exacto, sin tocar `agentshop-*`) | **PENDING-DEPLOY** | Misma query — no hay fila `remit-kyc-validator` todavía. No hay riesgo de "modificar" `agentshop-*` porque no se tocó ninguna tabla/servicio de ese repo (ver CD-1 abajo). Falta W4. |
| AC-3 (200 con EXACTAMENTE 7 campos, NUNCA `legalId`/`travelRuleData` en 200/400/502) | **PASS** | `route.ts:9-30` — 200 envuelve `runKycValidator()` en `{result}` (`route.ts:21-22`); `kyc-validator.ts:89-97` devuelve exactamente 7 campos, sin `legalId`/`travelRuleData`. Tests verdes: `route.test.ts:43-58` (7 campos exactos), `:61-66` (NO-PII 200, `.not.toContain("12345678")`/`"travelRuleData"`), `:70-79` (NO-PII con campo extra inyectado, MENOR-2), `:98-105` (NO-PII 400), `:118-129` (NO-PII 502, no filtra `err.message`/stack). |
| AC-4 (Didit OFF → 100% `FallbackKycProvider`) | **PASS** | `providers/kyc.ts:103-113` `getKycProvider()`: sin `DIDIT_API_KEY` → `FallbackKycProvider`. Confirmado que no hay `.env`/`.env.local`/`.env.production` en el repo con `DIDIT_API_KEY` seteada (verificado, ninguno existe). `route.ts` no referencia envs de Didit (grep confirmado, solo aparecen en `kyc.ts:9,100,104,106`). Test `route.test.ts:82-86` → `provenance === "local-fallback"`. |
| AC-5 (prod + fallback → `payoutAllowed:false` sin excepción) | **PASS** | `kyc-validator.ts:56-69` `isPayoutAllowed()`: `isProd` gate ignora `ALLOW_FALLBACK_KYC` en prod. Test `route.test.ts:88-95` — `NODE_ENV=production` + `ALLOW_FALLBACK_KYC=true` → `payoutAllowed === false`. |
| AC-6 (200 `{result}` legible por `data.result ?? data`) | **PASS** | `route.ts:22` `NextResponse.json({ result }, { status: 200 })`. Test `route.test.ts:43-58` usa `data.result ?? data` explícitamente. |
| AC-7 (400 estructurado sin ecoar `legalId`, nunca 500 crudo) | **PASS** | `route.ts:10-18` `safeParse` + `parsed.error.flatten()` (sin `parsed.data`/body crudo). Test `route.test.ts:98-105` (falta `senderCountry` con `legalId` real → 400, `.not.toContain("12345678")`); `route.test.ts:108-115` (body no-JSON → 400, no 500). |
| AC-8 (fee-split creator leg a `payoutWallet` vía `a2a_fee_splits`) | **PENDING-DEPLOY** | No verificable — depende de W4 (registro con `payoutWallet`) + una invocación real vía `/compose`. Mecanismo genérico ya verificado en producción por WKH-171 (mismo código de `fee-split.ts`/`agent-split-context.ts`, sin cambios en esta HU — CD-2 respetado, `orchestrate.ts`/`compose.ts` no tocados). |

## 3. PII — eje crítico (CD-6)

Confirmado con evidencia de test que **ningún camino HTTP** (200/400/502) filtra `legalId` ni `travelRuleData`:
- 200 normal: `route.test.ts:61-66`.
- 200 con campo extra PII no-schema (defensa en profundidad, cierra MENOR-2 del AR): `route.test.ts:70-79` — Zod strippea `extraPii` antes de llegar al core; el 200 no contiene ni el valor ni la clave.
- 400 (input inválido con `legalId` real presente): `route.test.ts:98-105`.
- 502 (provider lanza con mensaje que incluye un DNI de prueba): `route.test.ts:118-129` — body fijo `{error:"verification_unavailable"}`, no filtra `err.message`/stack.

**MENOR-1 del AR** (`verificationId` = hash débil reversible del DNI, `providers/kyc.ts:73,90-95`) queda correctamente **fuera de esta HU** — es código pre-existente (CD-1 prohíbe tocar `providers/kyc.ts`), ruteado a WKH-177. No es un FAIL de WKH-170.

## 4. Drift

- Scope IN respetado al 100%: solo 3 archivos con mtime dentro de la ventana de la HU (2026-07-10):
  `route.ts` (11:09), `route.test.ts` (11:18, incluye el fix-pack MENOR-2), `README.md` (11:10).
- `kyc-validator.ts` (07-08 18:08), `providers/kyc.ts` (07-08 17:54), `providers/types.ts` (07-08 17:33),
  `remit-corridor-fx/invoke/route.ts` (07-09 21:13) — todos **intactos**, mtime anterior a la HU.
- `wasiai-agentshop/src/app/api/agents/agentshop-kyc-validator/**` — mtime 2026-05-13 (muy anterior), no tocado.
- Contenido de `route.ts`/`route.test.ts`/`README.md` en disco coincide byte-a-byte con lo especificado en
  `story-file.md` §W1.1/§W1.2/§W2.1 (comparado línea por línea), salvo el test 2b agregado post-AR (mejora,
  no drift negativo).
- **Drift: none** (0 hallazgos de scope/spec creep).

## 5. Constraint Directives (CD-N)

| CD | Status | Evidencia |
|----|--------|-----------|
| CD-1 (core/providers/demo intactos) | ✅ | mtimes §4. `wasiai-agentshop` no tocado (repo separado, mtime 05-13). |
| CD-2 (no tocar `orchestrate.ts`/`compose.ts` de `wasiai-a2a`) | ✅ | Cero archivos modificados en `wasiai-a2a` para esta HU (repo separado, código nuevo 100% en `wasiai-remittance-agents`). |
| CD-3 (slug byte-idéntico) | ✅ | `SLUG = "remit-kyc-validator"` (`kyc-validator.ts:13`) = carpeta `src/app/api/agents/remit-kyc-validator/invoke/` = `name` en el payload W4 (`story-file.md:367`). |
| CD-4 (Didit OFF) | ✅ (código) / PENDING-DEPLOY (env Vercel) | Sin `.env*` con `DIDIT_API_KEY` en el repo; `getKycProvider()` fail-safe (`kyc.ts:103-113`). La confirmación de que el deploy Vercel real NO tiene esas envs seteadas es parte de W3 (`!` humano, no verificable desde acá). |
| CD-5 (testnet-only) | PENDING-DEPLOY | `payoutWallet` aún no declarado (no hay fila registrada) — se verifica en W4. |
| CD-6 (NO-PII en 200/400/502) | ✅ | Ver §3. |
| CD-7 (mutaciones de infra por humano) | ✅ | Ningún redeploy/registro/mutación de prod fue ejecutado por este QA ni por el Dev — confirmado por ausencia de fila en `a2a_agents` para `remit-kyc-validator`. |
| CD-8 (contrato `{result}` / 400 / 502 idéntico a `remit-corridor-fx`) | ✅ | `route.ts` fork byte-a-byte de `remit-corridor-fx/invoke/route.ts`, solo cambia core+código de error 502. |

## 6. Gate confirmation

No existe `cr-report.md` en disco para este directorio (`doc/sdd/169-wkh-170-remit-kyc-validator/`). Se
ejecutaron los 3 gates directamente (típecheck/vitest/build, §1) para tener evidencia real — todos verdes.
AR (`ar-report.md`): **APROBADO con MENORs** (0 BLQ), MENOR-2 confirmado cerrado en el fix-pack (test 2b
presente y verde); MENOR-1 correctamente fuera de scope.

## 7. Qué queda del `!` humano (no ejecutado por QA — CD-7)

1. **W3**: Redeploy Vercel del proyecto existente `wasiai-remittance-agents` (agregar la ruta nueva al deploy),
   confirmando que `DIDIT_API_KEY`/`DIDIT_ADAPTER_READY` permanecen sin setear.
2. **W4**: `POST /agents` contra prod (Railway) con a2a-key + `payoutWallet` testnet — cierra AC-1/AC-2/CD-5.
3. **W5**: Smoke post-deploy (curl del README §"Correr local"/W3) + verificación e2e vía `/compose` con
   `steps[0]=remit-kyc-validator` para cerrar AC-8 (fila `charged`+`tx_hash` en `a2a_fee_splits`).

Ninguno de estos 3 es responsabilidad de esta fase F4 (documentados como PENDING-DEPLOY, no FAIL).

---

**Listo para DONE** (código). El reporte final debe documentar explícitamente los 3 items PENDING-DEPLOY (AC-1/AC-2/AC-8) como trabajo `!` humano remanente, no como deuda del pipeline.

*F4 generado por NexusAgil — nexus-qa. WKH-170.*
