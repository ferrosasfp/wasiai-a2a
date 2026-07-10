# Done Report — HU [WKH-173] publish/patch/delete/list agentes GRATIS vía auth-only

**Status**: DONE (código) · PENDING-DEPLOY (Railway `!` humano)  
**Date Completed**: 2026-07-10  
**Branch**: `fix/168-wkh-173-publish-free-auth`  
**Deploy Runbook**: Ver §7 (W3 Railway)

---

## Resumen ejecutivo

Se implementó una función middleware nueva `requireA2AKey()` (auth-only) que desacopla autenticación de pago. Las 4 rutas `POST/PATCH/DELETE/GET /agents` ahora autentica la a2a-key y NUNCA debita el presupuesto — cerrando dos bugs: (1) placeholder $1 real debitado para operaciones documentadas "gratis", (2) caller x402-anónimo pagando on-chain pero siendo rechazado con 403 igual. El rigor de AR+CR+fix-pack+re-AR detectó un bug crítico en la 1ª versión del helper de firma (thenable → await unwrap → débito con firma inválida en money-path), **demostrando que el proceso de quality tuvo ROI real**. Todos 8 ACs PASS, suite 2828 tests verde, listos para merge + deploy Railway.

---

## Pipeline ejecutado

| Fase | Entrada | Gate | Veredicto | Documentación |
|------|---------|------|-----------|---|
| **F0** | Codebase + `project-context.md` | — | ✓ Grounded | work-item.md (linajes verificados) |
| **F1** | Work-item (F0/F1 aprobado) | `HU_APPROVED` | ✓ Approved | work-item.md (ACs EARS, DTs ratificados) |
| **F2** | SDD architecture + decisiones | `SPEC_APPROVED` | ✓ Approved | sdd.md (waves W0/W1/W2/W3, anti-drift DT-B, CD-1–CD-9) |
| **F2.5** | Story-file para Dev | — | ✓ Ready | story-file.md (contrato F3 AL PIE DE LA LETRA) |
| **F3** | Implementación W0+W1+W2 | — | ✓ Complete | `src/middleware/a2a-key.ts` (builders + requireA2AKey + 3 branches), `src/routes/agents.ts` (4 rutas swappeadas), tests nuevos |
| **AR** | Código post-F3 | APROBADO | ✓ 0 BLQ, 0 MENOR | ar-report.md (refactor puro verificado, x402 never touched, débito 0) |
| **CR** | Revisión calidad | APPROVED | ✓ 0 BLQ, **3 MENOR** | cr-report.md (MNR-1 firma duplicada, MNR-2 msg 503 engañoso, MNR-3 assert bajo comentario) |
| **Fix-pack** | Resolución MNRs | — | ✓ Complete | `verifyOptInSignature` helper + message fix + comments |
| **re-AR** | Fix-pack | APROBADO | ✓ 0 BLQ, 0 MENOR | ar-report-fixpack.md (**hallazgo crítico**: 1ª versión helper devolvía FastifyReply thenable → await unwrap → débito con firma inválida; fixed → Promise<boolean>) |
| **F4** | Suite completa + ACs | APROBADO PARA DONE | ✓ 8/8 ACs PASS | f4-report.md (tsc 0, biome 0, vitest 2828 passed) |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia (archivo:línea) |
|----|--------|---|
| **AC-1** | ✓ PASS | Auth sin débito (master/deleg/sesión) → `a2a-key.test.ts:2604–2618` (T-RA-01 master `mockDebit not.toHaveBeenCalled`), `:2621–2636` (T-RA-02 deleg), `:2639–2654` (T-RA-03 sesión). Rutas swappeadas: `agents.ts:102, 277, 408, 453` |
| **AC-2** | ✓ PASS | Mismos error codes auth (KEY_NOT_FOUND, KEY_INACTIVE, INVALID_SESSION_TOKEN, DELEGATION_REVOKED, DELEGATION_EXPIRED, SESSION_TOKEN_INVALID, SESSION_EXPIRED, SIGNATURE_REQUIRED) → `a2a-key.test.ts:2657–2785` (T-RA-04 matriz), `:2844–2860` (T-RA-07 firma) |
| **AC-3** | ✓ PASS | Sin credencial → 403 A2A_KEY_REQUIRED, x402 NUNCA invocado (incluso con X-PAYMENT presente) → `a2a-key.test.ts:2788–2813` (unit) + `agents.publish.authonly.test.ts:97–109` (integration ruta real, T-RT-01); `a2a-key.ts:1241–1261` verify (sin import requirePayment) |
| **AC-4** | ✓ PASS | `request.a2aKeyRow` con scoping (allowed_agent_slugs, allowed_registries, allowed_categories) idéntico → `a2a-key.test.ts:2816–2841` (T-RA-06 deleg scoping), `:2922–2958` (T-RA-BLD builders verifican scoping); `agents.ownership.test.ts` (5/5 passed, ownership guard intacto) |
| **AC-5** | ✓ PASS | `/compose`, `/orchestrate*`, `/gasless`, `/registries` SIN cambios de débito → `git diff --name-only` (solo 6 archivos: a2a-key.ts, agents.ts, tests); suites WKH-101/121/123/125/127 (débito) 100% verde; CD-1 verified |
| **AC-6** | ✓ PASS | Suite completa 0 fallos → `vitest run` (157 archivos, 2828 tests, 0 failed). Regresión post-refactor: suite deleg/sesión sin tocar = refactor puro. |
| **AC-7** | ✓ PASS | Firma enforced igual (EIP-712 master, HMAC sesión) → `a2a-key.test.ts:2844–2898` (T-RA-07a/07b/07c), sin firma → 401, firma inválida → 401/403, firma válida → 200 |
| **AC-8** | ✓ PASS | Spend-limits ignorados (DT-2 ratificado) → `a2a-key.test.ts:2901–2919` (T-RA-08, key con daily/per-call limit agotado → 200, no débito) — cambio de comportamiento intencional, documentado |

---

## Hallazgos finales

### BLOQUEANTEs: 0
Ninguno. Pipeline limpio.

### MENORs: 3 (todos resueltos en fix-pack)
1. **MNR-1** (CR): Bloque de firma duplicado en master+sesión → **Resuelto** (fix-pack): extraído a `verifyOptInSignature` helper (L170–232), Promise<boolean> para evitar thenable-unwrap. **Hallazgo crítico**: 1ª versión retornaba `Promise<FastifyReply|null>` → FastifyReply es thenable → `await` desenvolvía a `undefined` → early-return fallaba → débito con firma inválida en money-path (7 tests rojos). Root cause (Fastify 5 thenable semantics) reproducida y documentada en auto-blindaje.md. Fix: devolver flag `boolean` no-thenable → dinero-path AC-3/4/5/6/9 ahora pasan.
2. **MNR-2** (CR): Sesión catch mensaje `"Budget service…"` inadecuado para auth-only → **Resuelto** (fix-pack): cambio a `"Key-session service…"` (L328).
3. **MNR-3** (CR): Assert `is_active` casi-tautológico (ya validado arriba) → **Resuelto** (fix-pack): comentario JSDoc aclarando pre-validación en builders.

**re-AR post-fix-pack: 0 BLQ, 0 MENOR** — certificado en `ar-report-fixpack.md`.

---

## Auto-Blindaje consolidado

### [2026-07-10 09:40] Wave 2 — Edit falló por tail truncado
- **Problema**: primer `Edit` para anexar describe T-RA al final de `a2a-key.test.ts` falló (String to replace not found). Copié el tail desde un `tail -15` filtrado por rtk (sin comentarios intercalados).
- **Causa raíz**: preview truncado/filtrado como fuente de `old_string` en Edit.
- **Lección**: Anclar SIEMPRE contra `Read` directo del rango exacto, nunca contra `tail`/`grep` que pasan por rtk y colapsan líneas. Aplicable a cualquier Edit por append/anchor.

### [2026-07-10 09:55] Fix-pack MNR-1 — FastifyReply thenable rompe early-return
- **Problema**: helper `verifyOptInSignature` en 1ª versión retornaba `Promise<FastifyReply|null>` (`return reply.status(401).send(...)`). Caller hacía `const sigError = await verifyOptInSignature(...); if (sigError) return sigError;`. Resultado: 7 tests del path pago (WKH-123 AC-3/4/5/6/9 master+sesión) rojos — status 401/403 enviado OK pero débito se ejecutaba igual (dinero real con firma inválida).
- **Causa raíz**: `FastifyReply` es **thenable** (tiene `.then()`, soporte para `await reply`). Cuando `async fn()` devuelve el reply y caller hace `await fn()`, runtime **desenvuelve** el thenable → resuelve a `undefined`. Así `sigError` quedaba falsy, `if (sigError) return` NO cortaba, flujo caía al débito.
- **Fix**: helper devuelve `Promise<boolean>` (`true` = error enviado, cortá; `false` = OK, continúa). `reply.send()` sin retorno. Boolean no es thenable → inmune al desenvuelvo.
- **Verificación**: repro mínima Fastify 5, suite 2828 verde, dinero-path AC-3/4/5/6/9 ahora pasan, débito bloqueado on invalid signature.
- **Lección general**: NUNCA `return`ear `FastifyReply` desde helper `async` que un caller vaya a `await`ear para decidir early-return. Devolver `boolean` o `void` + chequear `reply.sent`. Regla para futuros helpers de auth/guard extraídos.

### [2026-07-10 10:20] CD-8 Biome — usar binario directo de node_modules/.bin
- **Contexto**: `npm biome` no funciona en el proxy rtk ("could not determine executable"). Biome falló en 4 HUs recientes (WKH-159/144/125b/143).
- **Fix**: `./node_modules/.bin/biome check --write <archivos>` — binario directo. Ejecutado pre-gate.
- **Aplicable en**: cualquier HU que toque múltiples archivos. Usar `rtk` solo para `git`/`npm install`, no para herramientas del tree local.

### [2026-07-10 10:25] CD-9 Lint global — separar propios vs pre-existentes
- **Contexto**: `npm run lint` global puede reportar errores pre-existentes (fuera de scope). No asumir culpa.
- **Fix**: `git diff origin/main -- <file>` para diferenciar los propios. NO tocar deuda pre-existente.
- **Aplicable en**: cualquier HU. Si lint falla, investigar antes de arreglarlo.

### [Decisión de arquitectura DT-B] Anti-drift dirigido: builders puros compartidos
- El refactor puro de W0 (extraer `buildDelegationEffectiveRow`/`buildSessionEffectiveRow`) como **una sola fuente de verdad** para ambos paths (pago + auth-only) resultó crítico. El builder es la única lógica de seguridad no-trivial y security-relevant (determina scoping de authz downstream). Duplicarla habría sido el vector de drift clásico. **Lección**: para patrones que se repiten en 2+ paths, extraer a función pura compartida SIEMPRE, incluso si el refactor puro en el path existente parece menor — la ganancia anti-drift lo justifica.

### [Decisión de ingeniería] Return-type matters en helpers async de auth
- El bug thenable de MNR-1 es **específico a la firma de `verifyOptInSignature` como `Promise<FastifyReply|null>`**. Un `Promise<boolean>` habría sido inmune desde el principio. **Lección**: en helpers que manipulan `reply` y son `await`eados por el caller para decidir un early-return, elegir el tipo de retorno considerando que el caller hará `if (result) return result;`. Thenable-able types (FastifyReply, Promises que se desenvuelven) rompen early-return. Boolean, void, o custom objects no thenable-able son seguros.

---

## Archivos modificados

Fuente: `git diff --name-only fix/168-wkh-173-publish-free-auth origin/main`

| Archivo | Cambios | Líneas |
|---------|---------|--------|
| `src/middleware/a2a-key.ts` | W0: builders `buildDelegationEffectiveRow` + `buildSessionEffectiveRow` (L105–147); rewirear resolveDelegation/resolveSesión al builder; W1: `requireA2AKey` + 3 resolvers auth-only (L1241–1361); W2: fixture updates | +300 (neto ~250 después de refactor puro) |
| `src/routes/agents.ts` | W1: import swap + 4 preHandler swaps (POST/PATCH/DELETE/GET) + docstring `:16–21` | +15 |
| `src/middleware/a2a-key.test.ts` | W0 gate: run existing suites (confirmación refactor puro); W2: describe `requireA2AKey — auth-only (WKH-173)` con 8 tests T-RA-01 a T-RA-08, helpers builders (T-RA-BLD) | +320 |
| `src/routes/agents.publish.test.ts` | W2: actualizar mock de `requirePaymentOrA2AKey` → `requireA2AKey` | +5 |
| `src/routes/agents.ownership.test.ts` | W2: idem mock | +5 |
| `src/routes/agents.publish.authonly.test.ts` | **NUEVO** | +120 (integration tests, T-RT-01) |

**Cero cambios a**: `compose.ts`, `orchestrate.ts`, `gasless.ts`, `registries.ts`, `x402.ts`, `resolveTargetChain`, `resolveEstimatedCostUsd`, ningún archivo de DB/schema. CD-1 / CD-5 satisfied.

---

## Decisiones diferidas a backlog

### Fix 2: UX default-chain en ops pagas (`/compose`, `/orchestrate`)
**Ticket sugerido**: (crear en backlog) — "Default chain UX: compose/orchestrate defaultea silenciosamente a Kite (2368), error `INSUFFICIENT_BUDGET chain 2368` no es accionable para caller que fondeó otra chain, sin default-chain configurable por key."  
**Impacto**: Solo ops PAGAS (fuera de scope WKH-173). Recomendación: crear ticket separado post-merge.

### Cumplimiento pre-existente: `allowed_agent_slugs` de delegación NO enforced en publish/patch/delete
**Hallazgo de AR**: las 4 rutas de `agents.ts` NO validan que el agente siendo publicado/patcheado/borrado esté en `delegation.policy.allowed_agent_slugs` (si la delegación tiene la política). Este control **pre-existe en el path pago** (`compose.ts` lo enforza vía `checkScoping`). Mismo código, mismo gap.  
**Status**: pre-existente, idéntico al path pago, fuera de scope WKH-173. Recomendación: auditoría de política de delegación + enforcement como ticket nuevo (no bloqueante para WKH-173).

---

## W3 — Deploy Railway (paso operativo humano `!`)

### Contexto
El código está en el working tree sin commit. Railway (`wasiai-a2a-production.up.railway.app`) es el destino de deploy. El SDD especifica W3 como "OPERATIVO, gate humano `!`" — el pipeline F1-F4 está DONE, pero el deploy requiere acción humana.

### Runbook pre-merge
1. **Branch**: `fix/168-wkh-173-publish-free-auth` (creada, cambios en working tree).
2. **Verificación local** (ya hecha por QA): `./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/biome check`, `./node_modules/.bin/vitest run` → 0/0/2828.
3. **Commit + Push**: una vez el humano da el `!` de aprobación, crear commit con mensaje:
   ```
   feat(WKH-173): requireA2AKey() auth-only middleware — publish/patch/delete/list agents realmente GRATIS

   Desacopla autenticación de pago. Las 4 rutas POST/PATCH/DELETE/GET /agents
   ahora autentica vía requireA2AKey() SIN débito, SIN chain-resolution,
   SIN spend-limits, SIN x402. Cierra 2 bugs: (1) placeholder $1 debitado
   para ops "gratis", (2) x402-anónimo pagando on-chain → rechazado 403.

   Hallazgo crítico (fix-pack): helper de firma retornaba FastifyReply thenable
   → await unwrap → débito con firma inválida. Fixed: Promise<boolean> no-thenable.

   Arc: builders compartidos (buildDelegationEffectiveRow/buildSessionEffectiveRow)
   para anti-drift. CD-1 (refactor puro verificado). AC 1-8 PASS. Suite 2828 verde.
   ```
   Push to `main` (o merge PR si existe).

### Runbook post-merge → deploy
1. **Railway auto-trigger** (si está configurado): merge a `main` debería triggerar Railway deploy automáticamente. Verificar en `railway.json` o `.github/workflows/` si existe trigger de deploy.
   - **Si NO hay auto-deploy**: usar CLI Railway (`npm install -g @railway/cli`, `railway up` desde el repo root, seleccionar ambiente `production` o similar).
   - **Config esperada**: Railway sabe leer `package.json` (scripts `build`, `start`) y env vars de `.env.production`.

2. **Post-deploy verification** (CRÍTICO — cierra el hallazgo AC-3 de esta HU):
   - Subir un a2a-key prepago sin budget restante (daily_limit_usd agotado).
   - POST `/agents` con esa key + agent payload.
   - **Esperado**: 200 OK (agent publicado, sin débito).
   - **Si antes del deploy**: 403 `PLACEHOLDER_FEE_USD` error o similar (dinero agotado, aunque la op sea "gratis").
   - **Si después del deploy**: 200 OK (WKH-173 working).

3. **Monitoreo post-deploy**:
   - Verificar `wasiai-a2a.logs` en Railway dashboard: cero errores de tipo `unable to fetch requireA2AKey`.
   - Spot-check: 1-2 llamadas reales a POST `/agents` desde un cliente (Insomnia/curl) para ver en los logs que `requireA2AKey()` se ejecuta sin x402 invocadas.
   - Si la HU WKH-171 (registrar `POST /agents` para remit-corridor-fx) está en queue, coordinar deploy de WKH-173 ANTES de ejecutar W4 de WKH-171 (así el registro no paga el $1 placeholder).

### Expected outcomes (sin hacer acá, solo documentar)
- `POST /agents` con a2a-key + agente → 201 Created, `request.a2aKeyRow` seteado, `require_signature` enforced si aplica, **SIN débito** (presupuesto NO baja).
- `PATCH /agents/:slug` similar.
- `DELETE /agents/:slug` similar.
- `GET /agents` lista sin debit.
- Cambio de comportamiento de AC-8: key con `daily_limit_usd` agotado → ahora PUEDE publicar (antes estaba bloqueada por el placeholder $1).

---

## Lecciones para próximas HUs

### 1. Extracto de helpers auth/guard: el tipo de retorno importa
En esta HU, `verifyOptInSignature` devolvía inicialmente `Promise<FastifyReply|null>`, que es **thenable** → el `await` del caller lo desenvuelve a `undefined` → early-return falla → bug de dinero real. **Fix**: devolver `Promise<boolean>` no-thenable (o `void` + chequear `reply.sent`). Regla para cualquier middleware helper que el caller `await`ee para un early-return: **evitar tipos thenable-able como valor de retorno si el caller va a hacer `if (result) return result;`**. Aplicable a futuras extracciones de helpers en compose/orchestrate/gasless (que tienen patrones de firma similares).

### 2. Anti-drift dirigido siempre que el patrón se repite en 2+ paths
W0 de esta HU extrajo `buildDelegationEffectiveRow`/`buildSessionEffectiveRow` como una sola fuente de verdad, porque aparecían en path pago + auth-only. El builder encapsula la única lógica **security-relevant** y no-trivial (scoping de authz). **Lección**: cuando un pattern se repite, extraer a función pura compartida SIEMPRE, aunque el refactor parezca minor. El costo de duplicación (drift risk) supera al costo de extracción pura.

### 3. Verificar mock exports después de refactor en route-tests
W2: al actualizar `vi.mock()` en `agents.publish.test.ts` de `requirePaymentOrA2AKey` → `requireA2AKey`, el mock export debe cambiar también. Procesar: si una ruta o suite mockea un middleware y ese middleware se refactoriza (función nueva, nombre cambia, firma cambia), actualizar el mock DESPUÉS de los cambios del middleware, no antes. Un mock desincronizado dejará tests en falso negativo (verdes pero no ejercitando el código real). **Aplicable a próximas refactorizations de middleware**.

### 4. Biome: usar binario directo node_modules/.bin/, no npm proxy
Falló 4 HUs recientes (WKH-159/144/125b/143) por confiar en `npm biome`. El proxy rtk no lo reconoce ("could not determine executable"). Usar `./node_modules/.bin/biome check --write <files>` directo, pre-gate. **Lección**: para cualquier herramienta instalada en `node_modules`, usar el binario directo en `.bin`, nunca confiar en `npm <cmd>` o `npx <cmd>` en pipeline automático.

### 5. CD-9 lint pre-check: separar hallazgos propios de pre-existentes
Si `npm run lint` reporta errores no relacionados a tu cambio, usar `git diff origin/main -- <file>` para confirmar que NO tocaste esas líneas. No asumir culpa. NO tocar deuda pre-existente out-of-scope. Esta HU confirmó que `packages/agent-sdk/biome.json` tenía una falla pre-existente → no bloqueante. **Aplicable**: siempre hacer esta separación en cualquier HU que toque múltiples archivos.

---

## Cierre

**Código DONE, tests verde (2828), ACs 8/8 PASS, hallazgos finales 0 BLQ/0 MENOR (3 MENORs resueltos en fix-pack).**

El proceso de quality (AR → CR → fix-pack → re-AR → F4) detectó un **bug crítico de dinero real** (firma inválida = débito se ejecutaba igual) que un fix ingenuo habría shipeado. Eso justifica el costo de rigor.

**Listo para merge + Railway deploy (W3, gate humano `!`).**

Coordinar con WKH-171 (W4 pendiente) para secuenciar deploy de WKH-173 ANTES.
