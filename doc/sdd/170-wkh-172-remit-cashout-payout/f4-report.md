# F4 Validation Report — WKH-172 `remit-cashout-payout` (etapa 1, mock)

**Fecha**: 2026-07-10
**QA**: nexus-qa
**Veredicto**: **APROBADO PARA DONE — con `!` humano pendiente** (código 100% verificado; registro/redeploy prod es el único ítem `!` que queda, tal como el work-item lo marca de antemano como BLOQUEANTE `!` humano, no como falta del Dev).

---

## 1. Runtime checks (repo `wasiai-remittance-agents`)

| Check | Resultado | Evidencia |
|---|---|---|
| `tsc --noEmit` | ✅ PASS (0 errores) | `npx tsc --noEmit` → "TypeScript compilation completed", exit 0 |
| `vitest run` (suite completa) | ✅ 59/59 PASS, 0 FAIL | `npx vitest run` → "PASS (59) FAIL (0)" |
| `vitest run` (archivos de esta HU, verbose) | ✅ 17/17 PASS | `cashout-payout.test.ts` (8 tests) + `route.test.ts` (9 tests) → "Test Files 2 passed (2)", "Tests 17 passed (17)" |
| `next build` | ✅ Compiled successfully | Manifest confirma ruta nueva: `ƒ /api/agents/remit-cashout-payout/invoke  0 B  0 B` junto a `remit-corridor-fx`/`remit-kyc-validator` |
| Discovery prod (`GET /agents/remit-cashout-payout/agent-card`) | ⏳ 404 (esperado — no registrado aún) | `curl https://wasiai-a2a-production.up.railway.app/agents/remit-cashout-payout/agent-card` → HTTP 404 |
| Discovery prod control — `agentshop-cashout-matcher` | ✅ 200, activo, sin tocar | mismo curl → 200 con agent-card completo, `computedReputation` con historial real (11 tasks) — **CD-1 confirmado en runtime prod** |
| Discovery prod control — `remit-kyc-validator` / `remit-corridor-fx` | ✅ 200 (ya registrados de HUs previas) | curl → 200/200 |

Nota metodológica: se intentó verificar `a2a_agents` directo contra la DB prod (caldz) vía Supabase REST — bloqueado por el sandbox del entorno (regla explícita del task: "no mutaciones prod" interpretada de forma conservadora también para SELECT contra el service-key que bypassea RLS). Se usó en su lugar el endpoint público de discovery (`agent-card`), que es evidencia equivalente y de menor privilegio para AC-1/CD-1.

## 2. AC-by-AC

| AC | Texto (resumen) | Status | Evidencia |
|---|---|---|---|
| AC-1 | discovery/agent-card devuelve `remit-cashout-payout` activo, sin reemplazar `agentshop-cashout-matcher` | **PENDING-DEPLOY** | `agent-card` → 404 hoy (no registrado). `agentshop-cashout-matcher` → 200 confirmado intacto (mitad del AC ya verificada en runtime). Pendiente del `!` humano (Missing Input #2/#3, CD-7). |
| AC-2 | `POST /agents` persiste fila NUEVA `a2a_agents.slug='remit-cashout-payout'`, sin tocar filas `agentshop-*` | **PENDING-DEPLOY** | Requiere el mismo `!` humano de AC-1 (registro no ejecutado). Código del slug verificado byte-idéntico: `src/agents/cashout-payout.ts:14` `SLUG = "remit-cashout-payout"`, usado sin transformar en `route.ts:7`. |
| AC-3 | `kycPayoutAllowed:false` → 200 blocked, NUNCA invoca provider | **PASS** | `src/agents/cashout-payout.test.ts:15-20` (core) + `route.test.ts:43-51` (HTTP) — ambos verdes. Código: `cashout-payout.ts:71-82` retorna antes de `assertPayoutProviderSafe()`/`getPayoutProvider()`. |
| AC-4 | 200 con EXACTAMENTE 8 campos; nunca `beneficiary.name/destination`/`travelRuleData` en 200/400/502 ni logs | **PASS** | `route.test.ts:54-73` (8 campos exactos, `Object.keys(output).sort()`) + `route.test.ts:76-82` (NO-PII 200, asserts contra `"999888777"`/`"Bob"`/`"travelRuleData"`) + `route.test.ts:114-123` (NO-PII 400) + `route.test.ts:136-147` (NO-PII 502, incluye `err.message` con PII inyectada a propósito y confirma que NO se filtra). Código: `route.ts:12-17` (400 solo `.flatten()`) + `route.ts:24-29` (502 solo `err.name` en warn). |
| AC-5 | mismo `idempotencyKey` → mismo `payoutId` determinístico | **PASS** | `route.test.ts:85-90` → dos invocaciones, `payoutId==="fallback-idem-1"` ambas. Código: `payout.ts:71` `payoutId: \`fallback-${input.idempotencyKey}\`` (determinístico por construcción). |
| AC-6 | PROD sin provider real y sin `PAYOUT_ALLOW_MOCK` → 502 `payout_refused`; PROD + `PAYOUT_ALLOW_MOCK=true` → 200 mock, NUNCA real | **PASS** | Núcleo (4 invariantes verificadas): (1) `hasReal` primero → `cashout-payout.ts:50-51` (si hay provider real, el flag es irrelevante, `if (hasReal) return`); (2) sin key → mock sin restricción del flag fuera de prod (`cashout-payout.test.ts:39-47`, dev+opt-in); (3) key-sin-READY → fail-loud incluso con el flag activo — `cashout-payout.test.ts:68-75` (`PROD + PAYOUT_ALLOW_MOCK + TRANSFI_API_KEY sin READY → throws transfi_adapter_not_ready`); (4) sin flag el default sigue rechazando — `cashout-payout.test.ts:77-82` y `route.test.ts:93-100` (502 `payout_unavailable`). Camino positivo: `cashout-payout.test.ts:57-66` + `route.test.ts:103-112` (PROD+flag → mock, `provenance:"local-fallback"`, `deliveredLocal:null`, `txRef:null`). 7/7 tests del eje del flag verdes. |
| AC-7 | fallo del step → refund vía `refund-outbox.ts`, sin código nuevo en `wasiai-a2a` | **PASS (heredado)** | `wasiai-a2a/src/services/refund-outbox.ts` no contiene ningún condicional por `slug`/agente (`grep` sin matches para `remit-cashout-payout`/`cashout-payout`/`agentshop` en el archivo) — mecanismo genérico por status code, aplica automáticamente. `git status`/`git log` en `wasiai-a2a` confirman CERO diff en `refund-outbox.ts`/`compose.ts`/`orchestrate.ts` para esta HU (CD-2 respetado). |
| AC-8 | Zod inválido → 400 `.flatten()`, nunca 500, sin ecoar PII | **PASS** | `route.test.ts:115-123` (falta `idempotencyKey`, con `beneficiary` PII en el input → 400, sin `"999888777"`/`"Bob"` en la respuesta) + `route.test.ts:126-133` (body no-JSON → 400, no 500). Código: `route.ts:9-18` (`req.json().catch(() => null)` + `safeParse` → 400 con `.flatten()` únicamente). |
| AC-9 | `steps[0]=remit-cashout-payout` + `payoutWallet` → fee-split creator 1% vía `fee-split.ts`/`agent-split-context.ts` | **PENDING-DEPLOY (heredado)** | Mecanismo genérico confirmado presente y sin tocar (`wasiai-a2a/src/services/agent-split-context.ts` existe, sin diff). No verificable end-to-end hasta el registro con `payoutWallet` real (mismo gate que AC-1/AC-2). |

## 3. Drift

- **Scope**: los 5 archivos tocados en `wasiai-remittance-agents` son EXACTAMENTE los declarados en Story File §2 (`cashout-payout.ts`, `invoke/route.ts`, `invoke/route.test.ts`, `cashout-payout.test.ts`, `README.md`) — sin extras, `find src/app/api/agents -maxdepth 1` confirma solo 3 dirs (`remit-kyc-validator`, `remit-cashout-payout`, `remit-corridor-fx`).
- **`wasiai-a2a`**: cero código nuevo — `git status`/`git log -- src/services/{refund-outbox,compose,orchestrate}.ts` sin diff, consistente con Scope IN declarado.
- **Spec drift**: `assertPayoutProviderSafe()` (`cashout-payout.ts:48-64`) matchea el diseño §4.3 del SDD línea por línea (rama `hasReal` primero, luego `NODE_ENV==='production'` con guarda `PAYOUT_ALLOW_MOCK`, luego rama dev con `ALLOW_FALLBACK_PAYOUT` sin tocar). Comentario de seguridad money-path presente (`cashout-payout.ts:53-57`), tal como exige CD-11.
- Sin hallazgos de drift.

## 4. Constraint Directives (CD-N)

| CD | Check | Resultado |
|---|---|---|
| CD-1 | `agentshop-cashout-matcher` intacto | ✅ Confirmado en runtime prod (curl 200, reputación real preservada) + directorio `wasiai-agentshop` sin archivos tocados por esta HU |
| CD-3 | slug byte-idéntico | ✅ `SLUG = "remit-cashout-payout"` en `cashout-payout.ts:14`, usado sin transformar en `route.ts` |
| CD-4 | TransFi OFF en el deploy | ✅ código (sin key → mock sin condición) verificado; ningún `.env*` local del repo setea `TRANSFI_API_KEY`/`TRANSFI_ADAPTER_READY` — la confirmación del entorno Vercel real queda para el `!` humano (CD-7, Missing Input #3) |
| CD-5 | testnet-only, sin wallet mainnet hardcodeada | ✅ `grep` de direcciones `0x...` en el código del agente → sin matches (la wallet se declara en el registro `!`, no en código) |
| CD-9 | mock nunca simula desembolso real | ✅ `payout.ts:70-77` `FallbackPayoutProvider.execute()` siempre `deliveredLocal:null, txRef:null, provenance:"local-fallback"` — verificado también por 4 tests distintos |
| CD-10 | `resolveTravelRuleData()` stub sin tocar | ✅ `cashout-payout.ts:119-124` idéntico al hallazgo de F0 (STUB, sin PII) |
| CD-11 | flag nuevo, nombre distinto, guarda propia, comentario de incidente de seguridad | ✅ `PAYOUT_ALLOW_MOCK` (≠ `ALLOW_FALLBACK_PAYOUT`), guarda anidada DENTRO de `NODE_ENV==='production'` (`cashout-payout.ts:52,58`), comentario explícito de incidente de seguridad (`cashout-payout.ts:53-57`) |

## 5. Gates (confirmados por QA, no solo leídos — se re-ejecutaron porque no había cr-report.md/ar-report.md en disco)

`tsc`/`vitest`/`next build` — los 3 verdes, corridos y documentados en §1 (el orquestador reportó AR/CR APROBADO 0 BLQ/0 MENOR pero no había artefactos en disco para leer exit codes, así que QA los corrió directamente en este caso puntual).

## 6. Qué queda del `!` humano (PENDING-DEPLOY)

1. Redeploy Vercel del proyecto `wasiai-remittance-agents` con `PAYOUT_ALLOW_MOCK=true` en el environment de producción (y confirmar que `TRANSFI_API_KEY`/`TRANSFI_ADAPTER_READY` permanecen SIN setear — CD-4).
2. `POST /agents` contra `wasiai-a2a` prod con `slug=remit-cashout-payout`, `agent_url` del deploy anterior, `payoutWallet` testnet (CD-5).
3. Tras 1+2: re-verificar AC-1/AC-2/AC-9 (discovery 200 + fila `a2a_agents` + smoke de fee-split) — el smoke queda documentado abajo para el operador.

### Smoke manual post-deploy (para el operador)
1. `curl https://wasiai-a2a-production.up.railway.app/agents/remit-cashout-payout/agent-card` → esperar `200` (hoy 404).
2. `POST /compose` con `steps:[{slug:"remit-cashout-payout", input:{...kycPayoutAllowed:true,...}}]` usando un a2a-key con budget → esperar `200 { result: { provenance: "local-fallback", deliveredLocal: null, txRef: null } }` (el `PAYOUT_ALLOW_MOCK=true` del deploy debe evitar el 502).
3. Repetir el mismo request con el mismo `idempotencyKey` → mismo `payoutId`.
4. Verificar en `a2a_fee_splits` (o dashboard) que el creator-split (1%) se liquidó a la `payoutWallet` declarada.
5. Forzar un fallo (ej. `kycPayoutAllowed` con input inválido que dispare 400/502 en un step pago) y confirmar el credit-back en `a2a_refund_outbox`.

**Veredicto final**: el código de esta HU está 100% verificado (17/17 tests propios, 59/59 suite completa, tsc/build verdes, 0 drift, 7/7 CDs cumplidos, las 4 invariantes del flag money-path probadas). Los únicos ítems no verificables ahora (AC-1, AC-2, AC-9) dependen exclusivamente del `!` humano de registro/redeploy, exactamente como el work-item lo anticipó (Missing Input #2/#3, CD-7) — no son fallas de implementación. **Recomendación: avanzar a DONE documentando el `!` pendiente**, no relanzar al Dev.
