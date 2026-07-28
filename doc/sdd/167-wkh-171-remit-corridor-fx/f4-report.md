# F4 Validation Report — WKH-171 `remit-corridor-fx` endpoint HTTP (etapa 1)

> QA (F4). Repo validado: `wasiai-remittance-agents` (sin `.git` propio — sin VCS, ver §Drift).
> `wasiai-a2a` validado read-only (git status + grep). Cero deploy/registro/mutación ejecutados (CD-6).

**Veredicto global: APROBADO PARA DONE (alcance F3/código)**, con 3 ACs en **PENDING-DEPLOY**
(AC-1, AC-2, AC-5) que requieren los pasos `!` humano ya documentados en Story File §4 (W3 deploy →
W4 registro → W5 smoke). Esto es el comportamiento **esperado** por diseño (CD-6, Story File §7 Done
Definition excluye W3-W5 de F3) — no es un FAIL, es trabajo pendiente fuera del pipeline automatizado.

---

## 1. Runtime/Integration checks (ejecutados por QA)

Repo: `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/`. Nota: el CR corrió gates sobre el
estado **pre-fix-pack** (38 tests, `next@14.2.5`). El fix-pack (bump a `14.2.35` + test #6 del 502 +
`.gitignore`) es posterior al `cr-report.md` → QA re-ejecuta los gates sobre el estado actual (no es
overlap, es la excepción documentada: "si CR no cubrió algún estado del código").

| Gate | Comando | Resultado |
|------|---------|-----------|
| Typecheck | `npx tsc --noEmit` | **EXIT 0** — "TypeScript compilation completed" |
| Tests | `npx vitest run` | **PASS (39) FAIL (0)** — incluye el 6º test nuevo (`route.test.ts:86-98`, cierra MENOR-1 del CR: cobertura de la rama 502, confirma que no filtra `stack`/mensaje interno) |
| Build | `npx next build` | **EXIT 0** — "1 routes (1 static, 0 dynamic) · Errors: 0 · Warnings: 0" |

**Env parity (CD-4):** `TRANSFI_API_KEY` / `TRANSFI_ADAPTER_READY` **no existen** en el entorno local
(`echo $VAR` vacío, sin `.env*` en el repo) → `getFxQuoteProvider()` (`src/providers/fx.ts:114-124`)
toma la rama `FallbackFxProvider`. Confirmado también por env vars documentadas para el deploy futuro
en Story File §W3 (prohibidas explícitamente).

**DB state (AC-2):** se evaluó correr `SELECT` read-only contra `a2a_agents` (Supabase `<supabase-dev-ref>`,
la DB configurada en `.env`/`project-context.md` de `wasiai-a2a`) para confirmar ausencia de la fila
`remit-corridor-fx` antes del registro. La acción fue **denegada por el clasificador de permisos**
("Production Reads... el usuario marcó AC-2 como deploy check humano, no query") — consistente con
CD-6. Se documenta como **NO EJECUTADO** (no NO VERIFICABLE: la razón es una restricción de permiso
explícita, coherente con el diseño de la HU). AC-2 queda PENDING-DEPLOY sin evidencia de DB.

**Migration/schema:** N/A — DT-2 declara CERO migración nueva (confirmado, `a2a_agents` ya soporta
`payout_wallet`/`metadata` desde WKH-143b, sin cambios de schema en esta HU).

---

## 2. ACs — tabla con evidencia

| AC | Texto (resumen) | Status | Evidencia |
|----|------------------|--------|-----------|
| AC-1 | `POST /discover` / agent-card devuelve `remit-corridor-fx` activo, sin reemplazar `agentshop-corridor-discoverer` | **PENDING-DEPLOY** | Mecanismo ya existe sin cambios: `wasiai-a2a/src/services/discovery.ts:243` (`publishedAgentService.listAsAgents()`), verificado por lectura, cero diff (CD-2). Falta W4 (registro real) para observarlo en runtime. |
| AC-2 | Fila NUEVA en `a2a_agents` con slug exacto `remit-corridor-fx`, sin tocar filas `agentshop-*` | **PENDING-DEPLOY** | Slug derivation confirmado byte-idéntico: `corridor-fx.ts:10` `SLUG="remit-corridor-fx"` vs `agent.ts:337` `input.name.toLowerCase().replace(/\s+/g,'-')` con `name:"remit-corridor-fx"` (Story File §W4) ⇒ slug idéntico. Query DB read-only denegada por permisos (CD-6) — no ejecutada. |
| AC-3 | `rate` deriva del mid real (`open.er-api.com`) + spread declarado, nunca hardcode | **PASS** | `src/providers/fx.ts:52-53` `effRate = mid * (1 - FALLBACK_SPREAD_BPS/10000)`, `mid` de `getUsdToPenMid()` (`fx.ts:80`, fetch real a `open.er-api.com`). Test: `route.test.ts:50-56` "rate deriva del mid real + spread declarado" → verde (mid mockeado 3.8 → rate en `(3.6, 3.8)`). |
| AC-4 | Con `TRANSFI_*` sin configurar, sirve SIEMPRE vía `FallbackFxProvider` | **PASS** | `fx.ts:114-124` `getFxQuoteProvider()`: sin `TRANSFI_API_KEY` → `FallbackFxProvider`. Env local confirmado vacío. Test: `route.test.ts:59-63` "TransFi OFF → provenance local-fallback" → verde. |
| AC-5 | Pipeline con `steps[0]=remit-corridor-fx` liquida leg `creator` (1%) a `payoutWallet`, auditable en `a2a_fee_splits` | **PENDING-DEPLOY** | Mecanismo verificado sin cambios (CD-2): `wasiai-a2a/src/services/agent-split-context.ts:48-52` lee `payout_wallet` vía `getSplitContextRow` para agentes `SELF_PUBLISHED_REGISTRY_ID`. Requiere W4 (registro con `payoutWallet`) + W5 (invocación real vía `/compose`) para ver la fila `charged`+`tx_hash` en `a2a_fee_splits`. |
| AC-6 | `POST` con body válido → `200` con `{result}` legible por `data.result ?? data`, matchea `CorridorFxOutput` | **PASS** | `route.ts:19` `NextResponse.json({ result }, { status: 200 })`. Test: `route.test.ts:37-47` valida `slug`, `localCurrency`, `rate` finito, `netDeliveredLocal>0`, `quoteId` — verde. |
| AC-7 | Body inválido (Zod) → `400` estructurado; nunca `500` sin manejar | **PASS** | `route.ts:9-15` (`safeParse` → 400 `invalid_input`+`details`); `route.ts:17-27` (`catch` → 502 `quote_unavailable`, nunca 500 crudo). Tests: `route.test.ts:66-72` (amountUsd negativo → 400), `:75-82` (body no-JSON → 400), `:86-98` (`runCorridorFx` lanza → 502, sin filtrar `stack`/mensaje interno) — los 3 verdes. |
| AC-8 | x402 anónimo sin `payTo` → comportamiento `[NEEDS CLARIFICATION]` resuelto por ratificación | **PASS (resuelto por diseño, no deferred)** | `sdd.md:70-73` documenta la ratificación: Opción A (a2a-key), x402-anónimo-directo queda fuera de etapa 1, Opción B (`payTo`) descartada. Confirmado en código, sin diff: `wasiai-a2a/src/services/compose.ts:811-813` lanza `No payTo address for agent ${agent.slug}...` cuando no hay `metadata.payTo`/`payment.contract` y no hay `a2aKey` — comportamiento exactamente el documentado. |

**Resumen:** 5/8 PASS con evidencia archivo:línea + test verde. 3/8 PENDING-DEPLOY (esperado, gated `!` humano, CD-6). 0/8 FAIL.

---

## 3. Drift Detection

- **Scope drift (wasiai-remittance-agents):** archivos presentes en el repo = exactamente los 10 de
  la tabla Scope IN del Story File (`package.json`, `tsconfig.json`, `next.config.mjs`, `.gitignore`,
  `vitest.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/api/agents/remit-corridor-fx/invoke/route.ts`,
  `route.test.ts`, `README.md`). Sin archivos extra. `src/agents/corridor-fx.ts` y `src/providers/fx.ts`
  con mtime **anterior** al resto de los archivos de esta HU (1783554417/1783555722 vs 1783653136+) →
  confirma que NO fueron tocados, consistente con "PROHIBIDO tocar" del Story File.
- **Wave order:** el repo no tiene `.git` propio (sin historial de commits) → no se puede verificar
  orden W0→W1→W2 por commits. Verificado por contenido: scaffolding (W0) + endpoint/tests (W1) +
  README (W2) presentes y coherentes entre sí (no hay evidencia de violación, pero el check es débil
  por falta de VCS — **flag para el humano**: este repo debería tener `git init` antes del deploy).
- **Spec drift (spot-check):** `route.ts` es byte-idéntico al contenido exacto especificado en Story
  File §W1.1 (confirmado por lectura línea a línea). `route.test.ts` cubre los 5 tests originales +
  el 6º del fix-pack (502), consistente con §6 del Story File + MENOR-1 del CR.
- **Deps drift:** `package.json` deps = `next@14.2.35` (bump post-CR, MENOR-2 resuelto), `react`,
  `react-dom`, `zod` — sin `@supabase/*`/`viem`/SDK de pago (CD-2 del checklist anti-hallucination).
- **wasiai-a2a:** `git status --short` → solo `M doc/sdd/_INDEX.md` (fila F1 de esta HU) + `?? doc/sdd/167-wkh-171-remit-corridor-fx/` (docs SDD). `git status --porcelain src/` → limpio. **Cero drift.**

**Conclusión drift: ninguno detectado.**

---

## 4. Constraint Directives (CD) — verificadas

| CD | Descripción | Status | Evidencia |
|----|-------------|--------|-----------|
| CD-1 | `wasiai-agentshop` intacto | ✅ | Repo git propio; `git status --short` solo muestra `.gitignore`/`tsconfig.tsbuildinfo` locales sin commitear (preexistentes, no relacionados). `git log -1 -- .../agentshop-corridor-discoverer` → `2026-05-13` (anterior a esta HU, iniciada ~2026-07-08). |
| CD-2 | Cero código nuevo en `wasiai-a2a` | ✅ | `git status --porcelain src/` limpio. Único cambio: `doc/sdd/_INDEX.md` (fila F1, doc no código) + carpeta SDD untracked. |
| CD-3 | Slug byte-idéntico `remit-corridor-fx` | ✅ | `corridor-fx.ts:10` `SLUG = "remit-corridor-fx"` == Story File §W4 payload `name`. |
| CD-4 | TransFi OFF (no activar adapter) | ✅ | `TRANSFI_API_KEY`/`TRANSFI_ADAPTER_READY` ausentes del entorno/repo; `fx.ts:114-124` gatea correctamente. |
| CD-5 | Testnet-only, sin mainnet | ✅ | `grep -rniE "mainnet\|chain.?id.*(2366\|43114\|8453)"` sobre `src/app`, `README.md`, `next.config.mjs`, `package.json` → 0 matches. El repo no hace ninguna llamada on-chain (agente de cotización pura). |
| CD-6 | Mutaciones de infra/prod solo por `!` humano | ✅ | QA no ejecutó deploy, `POST /agents`, ni escribió en DB. El intento de `SELECT` read-only fue bloqueado por el clasificador de permisos, reforzando el gate. |
| CD-7 | Contrato `POST /invoke → 200 {result}` | ✅ | `route.ts:19`, confirmado por `route.test.ts:37-47` + README §"Endpoint HTTP + deploy". |

---

## 5. Gate Confirmation (leído + re-ejecutado con justificación)

CR (`cr-report.md`) confirmó verde sobre el estado **pre-fix-pack**: `tsc --noEmit` EXIT 0, `vitest run`
38/38. El fix-pack posterior (bump Next, test 502, gitignore) no fue visto por CR → QA re-ejecutó los
3 gates sobre el estado actual (ver §1): **todos verdes** (tsc 0, vitest 39/39, build 0 errores/0 warnings).
No es overlap — es la excepción documentada para código que CR no cubrió.

---

## 6. Pendiente para el humano (`!`) — runbook (Story File §4, sin cambios)

1. **W3 — Deploy Vercel** (proyecto nuevo, separado de `wasiai-agentshop`). Env vars: `FALLBACK_FX_SPREAD_BPS=250`,
   `FALLBACK_FX_FLAT_FEE_USD=0.5`, `STATIC_USD_PEN=3.75` (opcional). **NO** setear `TRANSFI_API_KEY`/`TRANSFI_ADAPTER_READY`.
   Smoke: `curl -X POST https://<deploy>.vercel.app/api/agents/remit-corridor-fx/invoke -d '{"amountUsd":100}'` → `200 {result:{...provenance:"local-fallback"...}}`.
2. **W4 — `POST /agents`** contra prod Railway (a2a-key autenticado) con el payload exacto de Story File §W4
   (`name:"remit-corridor-fx"`, `priceUsdc:0.03`, `payoutWallet:0x<wallet-testnet-creator>`, `agentUrl` del deploy W3).
3. **W5 — Verificación E2E** (re-cerrar AC-1/AC-2/AC-5 en un F4 de seguimiento o smoke manual):
   - `GET /agents/remit-corridor-fx/agent-card` o `POST /discover` → `status:active`, sin afectar `agentshop-*`.
   - `POST /compose` con a2a-key, `steps[0]=remit-corridor-fx` → `provenance:"local-fallback"` en el resultado.
   - Query `a2a_fee_splits` → fila `charged`+`tx_hash`, leg `creator` = `payoutWallet` declarado.

---

## 7. Veredicto

**APROBADO PARA DONE** en el alcance de F3 (código). Runtime gates 100% verdes (tsc/vitest/build),
5/8 ACs con evidencia PASS, 0 FAIL, drift ninguno, 7/7 CDs cumplidas, CR MENORes (1,2,3) todos resueltos
en el fix-pack. Los 3 ACs restantes (AC-1/2/5) quedan **PENDING-DEPLOY** por diseño explícito de la HU
(CD-6) — requieren `!` humano para W3→W4→W5 antes de poder cerrarse con evidencia runtime real.
Recomendación: avanzar a DONE documentando el pendiente W3-W5 en el reporte final (`nexus-docs`), y
abrir un follow-up (o reabrir este F4) post-deploy para cerrar AC-1/AC-2/AC-5 con evidencia de DB/discover/fee-split.
