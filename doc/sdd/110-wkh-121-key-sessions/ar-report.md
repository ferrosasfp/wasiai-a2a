# Adversarial Review — WKH-121 (Session Keys server-side, sin EIP-712)

> Reviewer: nexus-adversary
> Fecha: 2026-06-19
> Branch: feat/110-wkh-121-key-sessions (working tree, sin commit)
> Input: story-file.md + working tree (`git status`); auto-blindaje.md NO existe.
> Build state: `tsc --noEmit` OK · suites nuevas 89 PASS / 0 FAIL.

## Veredicto: RECHAZADO (1 BLOQUEANTE-ALTO activo)

El branch del middleware (step 0) está sólido. El bug es de **integración**: el
débito per-step de compose/orchestrate (steps 1..N) NO enruta al RPC de sesión,
por lo que el `max_budget_usd` de la sesión NO se aplica en composiciones
multi-step. Esto derrota el objetivo declarado de la HU ("acotar el blast radius").

---

## BLQ-ALTO-1 — Session budget NO se aplica en steps 1..N de compose/orchestrate (AC-8/AC-9 rotos en multi-step)

- **Categoría:** Data Integrity / Integration (3 y 5)
- **Archivos:**
  - `src/services/compose.ts:159-164` — `budgetService.debit(scopingKeyRow.id, chainId, debitAmount, request.delegationContext)` pasa SOLO el 4º arg (`delegationContext`); el 5º (`keySessionContext`) queda `undefined`.
  - `src/services/orchestrate.ts:405-421` — propaga `delegationContext: request.delegationContext` a `composeService.compose`, pero NUNCA `keySessionContext`.
  - `src/types/index.ts:237-272` — `interface ComposeRequest` declara `delegationContext?: DelegationDebitContext` pero NO tiene campo `keySessionContext`.
  - `src/services/budget.ts:79-122` — la ruta key-session de `debit` SOLO se activa si `keySessionContext` está presente; como nunca llega, cae a la **ruta master** (L182-193 → `increment_a2a_key_spend` directo sobre el parent).
- **Descripción:** El middleware (`a2a-key.ts:511-523`) debita el **step 0** atómicamente vía `keySessionService.debitSessionAndParent` (correcto). Pero los steps 1..N de un `/compose` o `/orchestrate` se debitan en `compose.ts:159` con `keySessionContext = undefined` → toman el camino master → debitan el budget del **parent** vía `increment_a2a_key_spend`, **sin tocar `a2a_key_sessions.spent_usd` ni chequear `max_budget_usd` de la sesión**. El RPC `debit_session_and_parent` jamás se invoca para esos steps.
- **Reproducción:**
  1. Master key con budget `{"2368":"100.00"}`.
  2. `POST /auth/key-session` con `{ ttl_seconds: 3600, max_budget_usd: "0.50" }` → token `wasi_a2a_sess_X`.
  3. `POST /compose` (o `/orchestrate`) con N steps (p.ej. 5) usando `Bearer wasi_a2a_sess_X`.
  4. Step 0: débito atómico de sesión ($1 placeholder) → `session.spent_usd = 1.00` ya excede `max_budget_usd=0.50`… pero los steps 1..4 NO consultan la sesión: debitan $1 c/u del parent vía `increment_a2a_key_spend`.
  - **Esperado:** la sesión corta en step 0/1 al exceder `max_budget_usd=0.50` (AC-9 → 403 `SESSION_BUDGET_EXHAUSTED`).
  - **Real:** la sesión gasta $5 del parent (steps 0..4) aunque su cap es $0.50. El cap de sesión solo aplica al step 0.
- **Impacto:** Un token de sesión filtrado con cap chico puede drenar el budget del parent emitiendo composiciones multi-step. Es exactamente el blast radius que la HU dice acotar (story Goal L14-16). Rompe AC-8 ("sin que un request concurrente pueda exceder el `max_budget_usd` de la sesión") y AC-9 para todo flujo compose/orchestrate de ≥2 steps.
- **Causa raíz:** El Story File NO incluyó `compose.ts`, `orchestrate.ts` ni `ComposeRequest` en "Files to Modify/Create", a pesar de que WKH-101 SÍ los cableó para `delegationContext`. El comentario en `src/types/a2a-key.ts:325` ("lo propaga budget.debit para enrutar al RPC atómico") describe una cadena que nunca se completó: nadie puebla el arg `keySessionContext` fuera del middleware step 0.
- **Sugerencia (NO implementar acá):** Espejar el cableado de delegación: (a) agregar `keySessionContext?: KeySessionDebitContext` a `ComposeRequest`/`OrchestrateRequest`; (b) en `compose.ts:159` pasar `request.keySessionContext` como 5º arg; (c) en `orchestrate.ts` propagar `request.keySessionContext` a `compose`; (d) en las rutas compose/orchestrate inyectar `keySessionContext` desde `request.keySessionContext` (como se hace con `delegationContext`). Dado que toca archivos fuera del Scope IN, **escalá a Architect** para ampliar el Story File antes del fix-pack.

---

## Categorías

### 1. Security (IDOR / token / PG leak) — **OK**
- **Ownership guard (AC-11):** `list` filtra `.eq('owner_ref', ownerRef)` (key-session.ts:277, test L433). `debitSessionAndParent` exige `ownerId: string` (no opcional) y el RPC re-valida `OWNERSHIP_MISMATCH` bajo lock (migration L56-61). `lookupByTokenHash` SIN owner gate es la excepción legítima documentada (caller se autentica con el token; test L460 verifica que NO se llama `.eq('owner_ref')`).
- **`getParentKey` sin owner gate (key-session.ts:252-265):** NO es IDOR — `keyId` sale del row de la sesión (que el caller autenticó con su token), nunca del body. Defensa en profundidad: el RPC vuelve a cruzar `v_key_id IS DISTINCT FROM p_key_id` bajo lock (migration L59-61). Aceptable.
- **Token plano (CD-3):** solo SHA-256 se persiste (key-session.ts:183, 194); token plano solo en la 201 (L215). Test L131-132 verifica que el INSERT no contiene el token. No se loguea (logs usan `session.id`, no el token: a2a-key.ts:512-514).
- **PG leak:** fallback `Error('SESSION_DEBIT_FAILED')` sin msg crudo (key-session.ts:378, test L353-366). Branch middleware 503 envía `'SERVICE_ERROR'` genérico (a2a-key.ts:625-628). `create` (L210) y `list` (L281) sí interpolan `error.message` de PG, pero esos Errors son atrapados por el handler de ruta que devuelve `KEY_SESSION_CREATE_FAILED` 500 sin propagar el mensaje (auth.ts:1140-1148); `list` no tiene catch en ruta → un fallo de PG en list propagaría el mensaje al error handler global de Fastify. Riesgo bajo (mismo patrón que delegation.list existente, decisión heredada) → no finding nuevo.
- **Sub-delegación (AC-12):** gate por prefijo ANTES de `resolveCallerKey` (auth.ts:1113-1116) → 403 `SESSION_NOT_ALLOWED`. Test T-SUBDELEG presente.
- **RPC SECURITY DEFINER hardening (CD-7):** `SET search_path = public, pg_temp` + `REVOKE FROM PUBLIC, anon, authenticated` + `GRANT TO service_role` (migration L90-96). Correcto.

### 2. Error Handling — **OK**
Mapeo RAISE→clase→HTTP completo y verificado:
- RPC propio: `SESSION_BUDGET_EXHAUSTED`→403, `SESSION_REVOKED`/`SESSION_NOT_FOUND`→`SessionTokenInvalidError`, `SESSION_EXPIRED`→403, `OWNERSHIP_MISMATCH`→403 (key-session.ts:344-376).
- Cadena `increment_a2a_key_spend`: `INSUFFICIENT_BUDGET`/`DAILY_LIMIT`/`KEY_INACTIVE`/`KEY_NOT_FOUND` todos mapeados (key-session.ts:357-368) y re-mapeados a 403 en el branch middleware (a2a-key.ts:546-573). Tests cubren cada prefijo (key-session.test.ts L298-341).
- Fallback inesperado → `SESSION_DEBIT_FAILED`/503 sin leak (test L353).

### 3. Data Integrity (atomicidad / TOCTOU / scope ⊆ padre) — **BLOQUEANTE** (ver BLQ-ALTO-1)
- **Step 0 / RPC:** orden correcto `FOR UPDATE` → ownership re-check → revoked/expiry bajo lock → budget check → `PERFORM increment_a2a_key_spend` → UPDATE (migration L44-86). TOCTOU-safe en step 0. Sin ventana de carrera en el step 0.
- **Scope ⊆ padre (CD-4/AC-2):** `isSubsetOfParent` (key-session.ts:82-89) correcto: session `undefined`→hereda, parent `null`→sin restricción, ambos lista→subset. `effectiveScope` persiste `null` cuando la sesión no declara (L95-97). Regla DT-4 de scope efectivo en middleware (a2a-key.ts:588-602) correcta y testeada (T-SCOPE-EFF, incluye caso `null`+`[a,b]`→`[a,b]`).
- **El defecto está en steps 1..N (BLQ-ALTO-1):** la garantía de cap de sesión NO se extiende al débito per-step de compose/orchestrate.

### 4. Performance — **OK**
Lookup hot-path O(1) por `UNIQUE(session_token_hash)` (migration L5); sin índice redundante (CD respetado). Índices `(key_id, owner_ref)` y `(owner_ref)` para list. Sin N+1.

### 5. Integration (coexistencia WKH-101 / middleware order / firma budget) — **BLOQUEANTE** (ver BLQ-ALTO-1)
- **Back-compat (AC-14/AC-15):** branch WKH-101 (`a2a-key.ts:263-461`) y path master (L632-757) intactos; branch sess insertado entre ambos (L463-630). Orden de detección `wasi_a2a_session_` → `wasi_a2a_sess_` → master. Prefijos mutuamente exclusivos verificado (tests T-COEXIST L243-255). Firma `budget.debit` extendida con 5º arg opcional sin romper master (L70-76); ruta master intacta (L182-193).
- **El gap de integración con compose/orchestrate es el BLQ-ALTO-1.**

### 6. Type Safety — **OK**
`tsc --noEmit` verde. Sin `any`/`@ts-ignore` en código WKH-121. El único `as unknown` (a2a-key.ts:152) es pre-existente en `runX402Fallback` (no WKH-121). Tipos en `src/types/a2a-key.ts`.

### 7. Test Coverage — **MENOR** (ver MNR-1)
Los 15 ACs tienen ≥1 test con asserts significativos (no triviales): middleware (AC-4/5/6/7/10/14/15), service (AC-2/8/9/11/13 + CD-AB-1), rutas (AC-1/2/3/12/13). El test de carrera (key-session.test.ts:369) usa mocks que simulan el resultado del RPC, no concurrencia real — la atomicidad real queda en el e2e gated. Aceptable por diseño. **PERO** ningún test cubre el flujo multi-step compose/orchestrate con session token (el hueco del BLQ-ALTO-1 quedó invisible porque los tests del service prueban el RPC aislado, no la cadena compose→budget.debit→RPC bajo sesión).

### 8. Scope Drift — **OK**
Todos los archivos modificados están en la tabla "Files to Modify/Create" del Story File. `compose.ts`/`orchestrate.ts`/`types/index.ts` NO fueron tocados (confirmado, working tree limpio para esos paths) — lo cual es **correcto respecto al Story File** pero es la causa raíz del BLQ-ALTO-1: la spec omitió el cableado per-step de sesión que WKH-101 sí tenía.

---

## Findings menores

### MNR-1 — Falta test del débito de sesión en compose/orchestrate multi-step
- **Categoría:** Test Coverage (7)
- **Evidencia:** No hay test que ejercite `composeService.compose` o `orchestrateService` con `keySessionContext` y verifique que el step 1..N debita la sesión. El hueco del BLQ-ALTO-1 pasó desapercibido por esta ausencia.
- **Impacto:** regresiones futuras del cap de sesión en multi-step no se detectarían.
- **Sugerencia:** al cerrar BLQ-ALTO-1, agregar un test de compose multi-step bajo session token que verifique que `debitSessionAndParent` se invoca por step (espejo del test de delegación per-step si existe).

### MNR-2 — Per-call limit del parent (`max_spend_per_call_usd`) no aplica bajo sesión
- **Categoría:** Data Integrity (3)
- **Evidencia:** el path master chequea `max_spend_per_call_usd` (a2a-key.ts:670-678); el branch sess NO. El branch WKH-101 tampoco lo hace (paridad). No es un AC de WKH-121.
- **Impacto:** una sesión puede exceder el per-call limit del parent en un solo step. Bajo (cap duro de budget sigue vía RPC). Backlog.

---

## Orden de fix-pack (prioridad)
1. **BLQ-ALTO-1** — cablear `keySessionContext` en compose/orchestrate (requiere ampliar Scope IN → escalar a Architect).
2. MNR-1 — test multi-step (junto con el fix de BLQ-ALTO-1).
3. MNR-2 — backlog (no bloquea).

## Gate: **RECHAZADO** — 1 BLOQUEANTE activo. El orquestador debe re-lanzar al Dev (previa ampliación del Story File por Architect para incluir compose.ts/orchestrate.ts/ComposeRequest).

---

# RE-AR (fix-pack verification) — Wave 5-FIX

> Reviewer: nexus-adversary
> Fecha: 2026-06-19
> Branch: feat/110-wkh-121-key-sessions (working tree, sin commit — todo el WKH-121 está uncommitted; el diff se midió con `git diff main -- <archivos>`)
> Build state: `tsc --noEmit` OK (exit 0) · suite completa **1422 pass / 3 skip** (89 files pass / 2 skip) — coincide con lo esperado.

## Veredicto RE-AR: **APROBADO**

BLQ-ALTO-1 **CERRADO**. El cableado de `keySessionContext` está completo end-to-end, sin eslabones rotos. No hay regresión de WKH-101. El test T-SESS-MULTISTEP reproduce y cubre el bug genuinamente. Sin scope drift. Las categorías que estaban OK siguen OK. No se abrieron findings nuevos.

---

## BLQ-ALTO-1 — **CERRADO** (verificado end-to-end)

Cadena completa de `keySessionContext`, eslabón por eslabón:

| # | Eslabón | Evidencia | Estado |
|---|---------|-----------|--------|
| 1 | Middleware setea `request.keySessionContext` | `a2a-key.ts:606-610` (`{ sessionId, ownerRef, keyId }`); `declare module` en `:61` | OK |
| 2 | `request.keySessionContext` declarado en types | `a2a-key.ts:60-61` (`keySessionRow?`, `keySessionContext?`) | OK |
| 3 | `routes/compose.ts` lo propaga al service | `routes/compose.ts:161` (`keySessionContext: request.keySessionContext`) | OK |
| 4 | `routes/orchestrate.ts` lo propaga al service | `routes/orchestrate.ts:81` (`keySessionContext: request.keySessionContext`) | OK |
| 5 | `ComposeRequest` tiene el campo | `types/index.ts:282` (`keySessionContext?: KeySessionDebitContext`) + import `:5-9` | OK |
| 6 | `OrchestrateRequest` tiene el campo | `types/index.ts:401` (`keySessionContext?: KeySessionDebitContext`) | OK |
| 7 | `orchestrate.ts` lo propaga a `composeService.compose(...)` | `orchestrate.ts:411` (`keySessionContext: request.keySessionContext`) | OK |
| 8 | `compose.ts` lo pasa a `budgetService.debit(...)` per-step | `compose.ts:164` — **6º arg posicional** (`request.keySessionContext`), dentro del guard `i > 0` (`compose.ts:131`) → TODOS los steps 1..N | OK |
| 9 | `budget.ts` rutea al RPC `debit_session_and_parent` cuando está presente | `budget.ts:75` (param), `:79` (`if (keySessionContext)` ANTES de `delegationContext` en `:125` y del master en `:182`) → `keySessionService.debitSessionAndParent` `:81-87` | OK |

**Step 0 vs steps 1..N:** no queda eslabón roto.
- **Step 0:** lo debita el middleware atómicamente (`a2a-key.ts:517` `debitSessionAndParent` con `composeEstimatedCostUsd`). Intacto, no tocado por el fix.
- **Steps 1..N:** ahora pasan por `compose.ts:159-165` → `budget.debit(..., request.keySessionContext)` → ruta sesión del RPC. El guard `i > 0` (`compose.ts:131`) evita double-debit del step 0 (sigue presente).

**Repro original (sesión cap $0.50 + compose 5 steps) AHORA corta:** el step que excede el cap recibe `keySessionContext` definido → `debit_session_and_parent` hace el budget check bajo lock (`max_budget_usd`) → `SESSION_BUDGET_EXHAUSTED` → `budget.debit` devuelve `{ success:false, error:'SESSION_BUDGET_EXHAUSTED' }` (`budget.ts:90-91`) → `compose` corta el pipeline (`compose.ts:166-178`) sin debitar steps restantes. Antes del fix, esos steps caían a `increment_a2a_key_spend` directo (ruta master) e ignoraban el cap. **Cerrado.** Cubierto por T-SESS-MULTISTEP (b) (`compose.test.ts:1578-1631`).

---

## Verificación focalizada

### 2. No-regresión WKH-101 (`delegationContext`) — **OK**
- `delegationContext` sigue presente en los 5 archivos de la cadena (compose.ts, orchestrate.ts, routes/compose.ts, routes/orchestrate.ts, types/index.ts) — solo se **agregó** `keySessionContext` al lado, no se reemplazó nada.
- En `budget.debit`, `keySessionContext` se chequea ANTES (`:79`) que `delegationContext` (`:125`); son mutuamente exclusivos en runtime → la precedencia no rompe la ruta de delegación cuando `keySessionContext` es `undefined`.
- Test de delegación per-step pre-existente actualizado correctamente al nuevo arg: `compose.test.ts:1219-1234` asserta `delegationContext` 4º arg + `undefined` 5º. Verde.
- `orchestrate.billing.test.ts` (master path) actualizado con trailing `undefined` (auto-blindaje 10:47) — verde.
- Test anti-regresión dedicado T-SESS-MULTISTEP (c): `compose.test.ts:1636-1674` (delegationContext intacto, keySessionContext undefined).

### 3. Test T-SESS-MULTISTEP — **real, NO trivial** (cierra MNR-1)
`compose.test.ts:1516-1675`. Tres casos:
- **(a)** `:1531-1574` — asserta `mockDebit` invocado por cada step `i>0` con `keySessionContext` definido como 5º arg posicional (NO `undefined`). Antes del fix llegaba `undefined` → este assert FALLARÍA. Reproduce el bug.
- **(b)** `:1578-1631` — cap agotado mid-pipeline (step 2 devuelve `SESSION_BUDGET_EXHAUSTED`): asserta solo 2 débitos (no 3), solo 2 fetches (step 2 NO se invoca), `result.steps.length === 2`. Verifica el corte sin debitar steps restantes — exactamente la garantía de blast-radius.
- **(c)** `:1636-1674` — anti-regresión WKH-101.

No es un test trivial: si el 6º arg volviera a `undefined`, (a) y (b) fallarían.

### 4. MNR-3 / MNR-4 — **OK**
- **MNR-3:** `SessionNotAllowedError` consumida en `auth.ts:1118` (instanciada, `.code` usado). HTTP final idéntico: `403` + body `{ error_code: 'SESSION_NOT_ALLOWED' }` (`auth.ts:1119`). T-SUBDELEG sin cambio.
- **MNR-4:** `KeySessionErrorCode` eliminado — `grep -rn "KeySessionErrorCode" src/` → **0 referencias**. `tsc` verde confirma que no tenía consumidores. El tipo canónico `KeySessionMiddlewareErrorCode` (`a2a-key.ts:112`) queda como único, con su consumidor `send403session`.

### 5. Scope drift — **OK**
Archivos tocados (`git diff main --name-only`): `.env.example`, `src/middleware/a2a-key.{ts,test.ts}`, `src/routes/auth.ts`, `src/routes/{compose,orchestrate}.ts`, `src/services/{budget,compose,orchestrate}.ts`, `src/services/compose.test.ts`, `src/services/orchestrate.billing.test.ts`, `src/services/security/errors.ts`, `src/types/{a2a-key,index}.ts`. Nuevos: `src/services/key-session.ts`, 3 tests, 2 migraciones. **Todos** dentro de la tabla "Files to Modify/Create" (#1-#19). Los cambios en `BACKLOG.md`/`HACKATHON-FINAL.md`/`doc/` son docs (no código WKH-121), y los `doc/jury-qa*.md` ya estaban untracked antes del branch. Sin drift de código.

### 6. Re-chequeo de lo que ya estaba OK — **OK (no roto por el fix)**
- **Ownership guard:** el fix NO tocó `key-session.ts` ni la migración; el `debitSessionAndParent` sigue exigiendo `ownerRef`/`keyId` y el RPC re-valida `OWNERSHIP_MISMATCH` bajo lock. El `keySessionContext` que viaja lleva `ownerRef = parentKey.owner_ref` y `keyId = parentKey.id` (`a2a-key.ts:608-609`), ambos derivados del row autenticado, no del body. Intacto.
- **Token handling / PG leak:** la ruta sesión de `budget.debit` mapea errores a codes estables y el fallback `SESSION_DEBIT_FAILED` (`budget.ts:120`) NO propaga `err.message` (solo `console.error` server-side, `:115-119`). Intacto.
- **Atomicidad del RPC:** migración no tocada; el RPC `debit_session_and_parent` mantiene `FOR UPDATE` → ownership → revoked/expiry → budget check → `PERFORM increment_a2a_key_spend` → UPDATE. Intacto.
- **Type Safety:** `tsc --noEmit` exit 0; sin `any`/`as unknown`/`@ts-ignore` en el diff del fix.

---

## Estado de findings previos

| Finding | Estado |
|---------|--------|
| **BLQ-ALTO-1** | **CERRADO** — cadena `keySessionContext` completa, cap respetado en steps 1..N, repro cortaría con `SESSION_BUDGET_EXHAUSTED`. |
| MNR-1 | **CERRADO** — T-SESS-MULTISTEP (a/b/c) cubre el flujo multi-step bajo sesión. |
| MNR-3 | **CERRADO** — `SessionNotAllowedError` consumida, HTTP/body idénticos. |
| MNR-4 | **CERRADO** — `KeySessionErrorCode` eliminado sin romper imports (`tsc` verde, 0 referencias). |
| MNR-2 | **ABIERTO (backlog)** — per-call limit del parent bajo sesión; no es AC de WKH-121, no bloquea. |

## Hallazgos nuevos del fix-pack: **ninguno**

(Nota menor no-finding: los comentarios del test dicen "5º arg" para `keySessionContext`; en la firma real de `budget.debit` es el 5º parámetro / 6º contando el receiver — los `toHaveBeenNthCalledWith` posicionales son correctos. Cosmético, sin impacto.)

## Gate RE-AR: **APROBADO**
1 BLOQUEANTE-ALTO cerrado, 3 MENORs cerrados, 0 hallazgos nuevos, 0 regresiones, suite 1422/3, tsc verde. El orquestador puede avanzar a CR/F4.
