# SDD — [WKH-173] `requireA2AKey()` auth-only middleware — publish/patch/delete/list realmente GRATIS

> Fase F2 (QUALITY). Input: `work-item.md` (F0/F1 aprobado, `HU_APPROVED`).
> Decisión ratificada por el humano: solución de fondo (middleware auth-only
> nuevo), SIN atajos. Scope = SOLO Fix 1 (`agents.ts`). `registries.ts` y el
> default-chain de ops pagas quedan FUERA (Fix 2 = tickets aparte).

---

## 0. TL;DR de la decisión arquitectónica

- **`requireA2AKey()` es una función NUEVA** (auth-only) con 3 branches internos
  (master / delegación / key-session) que **reusan al 100% las primitivas de
  seguridad ya compartidas** (`extractRawKey`, `identityService.lookupByHash`,
  `delegationService.lookup/getParentKey`, `keySessionService.lookup/getParentKey`,
  `verifySignedAuth`, `extractSignedHeaders`, `isIdentityVerified`) y **NO**
  ejecutan chain-resolution, spend-limits, débito ni x402.
- **Anti-drift dirigido (no duplicación ciega):** la única lógica de seguridad
  NO-trivial que hoy vive inline en los resolvers pagos es la construcción del
  `effectiveRow` (scoping de delegación/sesión → controla authz downstream). Esa
  pieza **se extrae a 2 builders puros compartidos** (`buildDelegationEffectiveRow`,
  `buildSessionEffectiveRow`) que usan TANTO el path pago COMO el auth-only →
  una sola fuente de verdad, imposible de driftear. **CD-1 del work-item habilita
  explícitamente este refactor puro** ("exponer las piezas reusables que
  `requireA2AKey()` necesita … refactor puro sin cambio de comportamiento,
  cubierto 100% por AC-6").
- **DT-2 RATIFICADO:** auth-only NO chequea `daily_limit_usd` /
  `max_spend_per_call_usd` / per-tx → una acción de $0 no puede bloquearse por
  guards de gasto (esos guards SON el bug que produce el $1 placeholder).
- **DT-4 RATIFICADO:** `GET /agents` entra en el fix junto con POST/PATCH/DELETE.
- **Backward-compat DURA (CD-5):** el débito de `resolveMasterAuth` /
  `resolveDelegationAuth` / `resolveKeySessionAuth` queda con comportamiento
  byte-idéntico; el único cambio en esos resolvers es sustituir un literal
  `effectiveRow` por una llamada al builder puro (refactor mecánico cubierto por
  la suite de delegación/sesión existente). `requirePaymentOrA2AKey` sigue siendo
  el preHandler de `/compose`, `/orchestrate*`, `/gasless/transfer`, `/registries`.

---

## 1. Context Map (archivos leídos + patrón extraído)

| Archivo | Líneas leídas | Qué extraje / por qué |
|---|---|---|
| `src/middleware/a2a-key.ts` | 1-1051 (full) | Estructura de los 3 resolvers pagos. **Confirmado:** auth y débito YA son separables — `request.a2aKeyRow = keyRow` (master §8, L978), `= effectiveRow` (deleg §8 L515, sess §6 L756) se setea DESPUÉS y con independencia del débito, que ya es condicional a `!skipMiddlewareDebit` (L379, L632, L885). El `effectiveRow` de deleg (L503-513) y sess (L740-754) es el único bloque de scoping NO-trivial → candidato a builder puro. Dispatcher `requirePaymentOrA2AKey` L1013-1050 = patrón exacto a clonar (extractRawKey → prefijo `wasi_a2a_session_` → `wasi_a2a_sess_` → master). |
| `src/routes/agents.ts` | 1-479 (full) | Las 4 rutas (`POST /` L99-107, `PATCH /:slug` L271-282, `DELETE /:slug` L405-413, `GET /` L450-458) montan `...requirePaymentOrA2AKey({description})` como único preHandler. Cada handler ya tiene el guard interno `a2aKeyRequired` (L51-58) que devuelve `403 A2A_KEY_REQUIRED` si `!request.a2aKeyRow` (L144, L318, L418, L462). El único campo del keyRow que consume la ruta es `keyRow.owner_ref` (L247, L386, L424, L466). Docstring L16-21 con la promesa "GRATIS" a verificar en código. |
| `src/middleware/x402.ts` (via imports) | — | `requirePayment` es un flujo de pago real completo (verify+settle on-chain). `requireA2AKey()` NUNCA lo importa ni invoca → cierra AC-3 (hallazgo x402-anónimo). |
| `src/routes/agents.publish.test.ts` | 1-508 (full) | Patrón de route-test: mockea `../middleware/a2a-key.js` exponiendo `requirePaymentOrA2AKey` (L77-84) e inyecta `a2aKeyRow` a mano vía `currentOwner`. `currentOwner=null` simula ausencia de key → la ruta cae al guard interno (T-PUB-12, L273-285 → 403 A2A_KEY_REQUIRED). **Punto de actualización: el mock export.** |
| `src/routes/agents.ownership.test.ts` | 1-216 (full) | Mismo mock (L68-75). Ejercita el ownership guard real (service real + supabase in-memory). Depende de `a2aKeyRow.owner_ref`. Punto de actualización: mismo mock export. |
| `src/middleware/a2a-key.test.ts` | 1-120, 274-420 + índice de `describe` | Patrón de middleware-test: mocks de `identityService` (L22-32), `budgetService` (L34-40), `delegationService` (L42-51), `keySessionService` (L53-61), `verifySignedAuth` (L64-67), `receiptService` (L70-72), registry multi-chain (L74+). Monta una ruta `/test` con el preHandler real e `inject`ea con `x-a2a-key`. Aserciones clave: `mockDebit`/`mockGetPaymentAdapter` con `toHaveBeenCalledTimes`/`not.toHaveBeenCalled`. Nuevo describe se agrega reusando estos mocks. |

**Grounding de dispatch (verificado en runtime):**
`'wasi_a2a_session_x'.startsWith('wasi_a2a_sess_') === false` → los prefijos
`wasi_a2a_session_` (delegación) y `wasi_a2a_sess_` (key-session) son mutuamente
exclusivos; el orden delegación→sesión→master del dispatcher pago se replica
1:1 sin ambigüedad.

---

## 2. Decisiones técnicas (DT-N)

### DT-A — Función nueva independiente + reuso de primitivas (NO flag, NO refactor invasivo del path pago)
**Elegido.** `requireA2AKey()` es una función exportada nueva. Reusa las
primitivas de seguridad ya compartidas (servicios + `verifySignedAuth` +
`extractSignedHeaders` + `extractRawKey` + `isIdentityVerified`). NO reescribe
ni rewirea el control-flow de los 3 resolvers pagos (excepto el swap del builder
puro, ver DT-B).

**Alternativas descartadas:**
- *Flag `free:true` sobre `requirePaymentOrA2AKey`* → dejaría corriendo
  chain-resolution + budget-header + x402-fallback innecesarios, y NO resuelve
  AC-3 (x402-anónimo pagaría y sería rechazado igual). Rechazado por el humano
  como atajo (DT-1 del work-item).
- *Refactor total extrayendo `resolveKeyRowOnly()` que reemplace la validación
  inline de los 3 resolvers pagos y sea llamado por ambos paths* → obligaría a
  reescribir el control-flow del money-path (violación de facto de CD-5 y del
  Scope OUT que declara los 3 resolvers "intactos"), con riesgo alto sobre el
  camino que mueve dinero. La ganancia anti-drift real (evitar que dos copias de
  la validación diverjan) se logra SIN ese riesgo extrayendo SOLO la pieza
  drift-peligrosa (el `effectiveRow`, DT-B); los guards de estado
  (`is_active`/`revoked`/`expired`) son comparaciones booleanas triviales sobre
  columnas tipadas — su duplicación inline en el path auth-only NO es un vector
  de drift de seguridad (un cambio de semántica rompería `tsc`/tests de ambos
  lados). **Reuso donde el reuso importa (crypto/lookup/firma/scoping ya
  compartidos o extraídos), duplicación mínima solo en guards inertes.**

### DT-B — Extraer `buildDelegationEffectiveRow` / `buildSessionEffectiveRow` como builders puros compartidos (anti-drift dirigido)
**Elegido.** El `effectiveRow` de delegación (a2a-key.ts:503-513) y sesión
(:740-754) es la única lógica NO-trivial y **security-relevant** (determina el
scoping de authz que `composeService.compose` aplica downstream vía checkScoping;
además, semánticas DISTINTAS entre deleg `length>0?…:null` y sess
`===null?parent:session`). Duplicarla en el path auth-only sería el clásico
drift peligroso. Se extraen 2 funciones puras:

```
buildDelegationEffectiveRow(parentKey: A2AAgentKeyRow, delegation: DelegationRow): A2AAgentKeyRow
buildSessionEffectiveRow(parentKey: A2AAgentKeyRow, session: KeySessionRow): A2AAgentKeyRow
```

Devuelven EXACTAMENTE el mismo objeto que hoy (sin `erc8004_verified`, que sigue
seteándose en el call-site con `isIdentityVerified(parentKey)` para minimizar el
diff). **Ambos paths (pago + auth-only) las usan** → una sola fuente de verdad.
El path pago se toca en UN solo punto por resolver (el literal → la llamada),
refactor mecánico y behavior-preserving, **cubierto 100% por la suite de
delegación/sesión existente (AC-6)**. Master NO tiene scoping (usa `keyRow`
tal cual) → no necesita builder; su reuso de seguridad es vía
`identityService.lookupByHash` + `verifySignedAuth` (ya compartidos).

**CD-1 del work-item habilita este refactor puro explícitamente.** Sin la
extracción, la extracción no tendría sentido (habría 2 copias del builder). Por
eso el path pago SÍ se rewirea a los builders — esa es la garantía anti-drift.

### DT-C (resuelve Missing Input #1 / DT-2 del work-item) — auth-only NO aplica spend-limits
**RATIFICADO: se saltean `daily_limit_usd`, `max_spend_per_call_usd` y el per-tx
limit de delegación.** Justificación: estos guards existen únicamente para acotar
gasto real; una operación auth-only de costo $0 no tiene gasto que acotar.
Enforcearlos reproduciría el bug que la HU corrige (bloquear una acción gratuita
por un límite de gasto agotado). **Cambio de comportamiento intencional y
documentado:** una key con `daily_limit_usd` agotado —que hoy NO puede publicar
por efecto colateral del placeholder $1— pasa a poder publicar/actualizar/borrar/
listar. Los controles de **validez** (`is_active`, `revoked_at`, `expires_at`)
y de **identidad/integridad** (`require_signature`) SÍ se mantienen (CD-3/DT-D).

### DT-D (DT-3 del work-item) — `require_signature` se mantiene enforced
`require_signature: true` (EIP-712 master / HMAC sesión) es control de
identidad/integridad, NO de billing → auth-only lo enforcea idéntico a hoy
(AC-7). Sin firma cuando se exige → `401 SIGNATURE_REQUIRED`; firma inválida →
`sendSignedAuthError` (401, o 403 `FUNDING_WALLET_NOT_BOUND`).

### DT-E (resuelve Missing Input #2 / DT-4 del work-item) — incluir `GET /agents`
**RATIFICADO: `GET /agents` entra en el fix.** Mismo archivo/feature
("self-serve single-agent publishing", docstring agrupa las 4 rutas), listar los
propios agentes es una lectura sin gasto y no hay claim de que cueste. El humano
no lo vetó en `HU_APPROVED`.

### DT-F — Dispatcher auth-only sin costo, sin x402, sin chain
`requireA2AKey()` NO recibe `PaymentMiddlewareOptions` ni computa
`estimatedCostUsd`. Firma: `export function requireA2AKey(): preHandlerAsyncHookHandler[]`
(array de 1 handler, para preservar la ergonomía `[...requireA2AKey()]` del
call-site). Sin credencial → `403 A2A_KEY_REQUIRED` DIRECTO desde el middleware
(AC-3, CD-2), sin construir jamás los x402 handlers.

### DT-G — Auth-only NO setea `delegationContext` / `keySessionContext` ni `x-a2a-remaining-budget`
Esos campos son **vehículos de débito** (per-step billing en compose) y el header
es el saldo post-débito. Sin débito y sin chain resuelta no aplican, y las rutas
de `agents.ts` no los leen (solo `owner_ref`). AC-4 exige el `effectiveRow`/scoping
en `request.a2aKeyRow` (que SÍ se setea, idéntico al path pago vía DT-B), no los
contextos de débito. Se setean `request.delegationRow` / `request.keySessionRow`
(identidad, sin costo) para paridad de trazabilidad. Documentado.

---

## 3. Constraint Directives (CD-N)

Heredados del work-item (CD-1…CD-5) + específicos del SDD:

- **CD-1 (hereda):** los bloques de **débito** de `resolveMasterAuth` /
  `resolveDelegationAuth` / `resolveKeySessionAuth` quedan con comportamiento
  byte-idéntico. El ÚNICO cambio permitido en esos resolvers es sustituir el
  literal `effectiveRow` por la llamada al builder puro (DT-B) — refactor puro,
  sin cambio de comportamiento, cubierto por la suite de deleg/sesión (AC-6).
- **CD-2 (hereda):** PROHIBIDO que `requireA2AKey()` importe o invoque
  `requirePayment`/x402 en cualquier branch (ni como fallback). Ausencia de
  credencial = `403 A2A_KEY_REQUIRED` directo (AC-3).
- **CD-3 (hereda):** OBLIGATORIO mantener `is_active`, `revoked_at`/`expires_at`
  y `require_signature` enforced exactamente igual que hoy — cero relajación de
  seguridad (AC-2, AC-7). Solo se quita el paso de débito y sus guards de gasto.
- **CD-4 (hereda):** OBLIGATORIO correr la suite COMPLETA (no solo tests nuevos)
  antes de cerrar: `npx tsc --noEmit` (o `npm run build`), `npm run lint`,
  `npm run test` (vitest) en 0 (AC-6).
- **CD-5 (hereda):** OBLIGATORIO mantener backward-compat del path master
  documentado como CD-5 histórico — `resolveMasterAuth` NO cambia su débito ni su
  flujo; `requirePaymentOrA2AKey` sigue siendo el preHandler de `/compose`,
  `/orchestrate*`, `/gasless/transfer`, `/registries`.
- **CD-6 (SDD):** el orden de dispatch de `requireA2AKey()` DEBE replicar 1:1 el
  de `requirePaymentOrA2AKey` (`extractRawKey` → prefijo `wasi_a2a_session_`
  [delegación] → `wasi_a2a_sess_` [key-session] → master). No reordenar.
- **CD-7 (SDD):** los códigos de error de cada branch auth-only DEBEN ser
  idénticos a los que emiten hoy los pasos de AUTH de los resolvers pagos
  (usando los MISMOS helpers `send403` / `send403delegation` / `send403session` /
  `sendSignedAuthError`). Ver la tabla §5.
- **CD-8 (SDD — Auto-Blindaje recurrente):** Biome falló el gate por formato en
  ≥4 HUs DONE recientes (WKH-159, WKH-144, WKH-125b, WKH-143 — objetos inline
  multi-línea, orden de imports, `it.each`). OBLIGATORIO correr
  `./node_modules/.bin/biome check --write <archivos tocados>` ANTES del gate
  (no confiar en el orden/formato manual). Usar el binario directo de
  `node_modules/.bin` — el proxy `rtk` rompe `npx`/`npm biome`
  ("could not determine executable"). Referencia: WKH-159/144/125b/143
  auto-blindaje.
- **CD-9 (SDD — Auto-Blindaje recurrente):** si `npm run lint` global reporta
  errores, separar los propios de los PRE-EXISTENTES con
  `git diff origin/main -- <file>` antes de asumir culpa; NO tocar deuda
  pre-existente fuera de scope. Referencia: WKH-125b auto-blindaje.

---

## 4. Waves de implementación

### W0 — Refactor puro: builders `effectiveRow` compartidos (SERIAL, gate duro)
**Archivo:** `src/middleware/a2a-key.ts`.
1. Agregar 2 funciones puras exportables a nivel módulo (junto a los helpers,
   antes de los resolvers):
   - `buildDelegationEffectiveRow(parentKey, delegation): A2AAgentKeyRow` →
     replica EXACTA de a2a-key.ts:503-513 (sin la línea `erc8004_verified`).
   - `buildSessionEffectiveRow(parentKey, session): A2AAgentKeyRow` →
     replica EXACTA de a2a-key.ts:740-754 (sin `erc8004_verified`).
2. Rewirear `resolveDelegationAuth` (L503-513) → `const effectiveRow = buildDelegationEffectiveRow(parentKey, delegation);` y conservar L514-515 (`erc8004_verified` + `request.a2aKeyRow`).
3. Rewirear `resolveKeySessionAuth` (L740-754) → `const effectiveRow = buildSessionEffectiveRow(parentKey, session);` y conservar L755-756.
4. **GATE DURO:** correr la suite de delegación + sesión existente
   (`a2a-key.test.ts` describes `delegation branch (WKH-101)`, `key-session
   branch (WKH-121)`, `WKH-125*` dest-cap) → deben pasar SIN cambios. Si algo
   cambia de comportamiento, el refactor NO es puro → parar.

> W0 es serial y bloqueante: nada de W1 arranca hasta el gate verde. Es el punto
> de contacto con el money-path; se aísla y verifica primero.

### W1 — `requireA2AKey()` auth-only + swap de preHandlers (paraleliza tras W0)
**Archivos:** `src/middleware/a2a-key.ts`, `src/routes/agents.ts`.
1. En `a2a-key.ts`, agregar 3 resolvers auth-only privados + el dispatcher
   exportado (ver §5 para el contrato exacto de cada branch):
   - `authenticateMasterKey(request, reply, rawKey)`
   - `authenticateDelegation(request, reply, rawKey)`
   - `authenticateKeySession(request, reply, rawKey)`
   - `export function requireA2AKey(): preHandlerAsyncHookHandler[]`
   Reusan `buildDelegationEffectiveRow`/`buildSessionEffectiveRow` (W0),
   `extractRawKey`, `extractSignedHeaders`, `verifySignedAuth`,
   `isIdentityVerified`, `send403*`/`sendSignedAuthError` y los servicios.
   NO importan nada nuevo de x402; NO llaman `resolveTargetChain`,
   `budgetService.debit`, `debitDelegationAndParent`, `debitSessionAndParent`,
   ni chequean `daily_limit`/`max_spend_per_call`/per-tx.
2. En `agents.ts`: cambiar el import a `requireA2AKey` (drop
   `requirePaymentOrA2AKey`) y swap del preHandler en las 4 rutas
   (`...requireA2AKey()` — sin el arg `{description}`). Mantener el guard interno
   `a2aKeyRequired` (defensa en profundidad).
3. Actualizar docstring `agents.ts:16-21`: "Auth: `requireA2AKey` (auth-only —
   sin fee/débito/x402) + guard `A2A_KEY_REQUIRED`. Publicar/actualizar/borrar/
   listar es GRATIS: el middleware autentica la a2a-key y nunca invoca pago."

### W2 — Tests (paraleliza tras W1)
**Archivos:** `src/middleware/a2a-key.test.ts` (nuevo describe),
`src/routes/agents.publish.test.ts` + `src/routes/agents.ownership.test.ts`
(actualizar el mock export). Ver §6.

### W3 — Deploy Railway (OPERATIVO, gate humano `!`, Scope OUT de F1-F4)
No es código. Post-merge a `main`, el humano ejecuta/aprueba el deploy a Railway
(no hay auto-deploy documentado). **Secuenciar ANTES de** ejecutar W4 de WKH-171
(registro de `remit-corridor-fx`), que hoy pagaría el $1 placeholder. Documentar
en el done-report.

---

## 5. Contrato exacto de `requireA2AKey()` (para F2.5/F3)

### Dispatcher (clona el orden de `requirePaymentOrA2AKey`, CD-6)
```
const rawKey = extractRawKey(request);
if (!rawKey) return reply.status(403).send({
  error: 'a2a-key required',
  error_code: 'A2A_KEY_REQUIRED',
  message: 'Publishing requires an authenticated a2a-key. The x402 anonymous path cannot publish (no tenant identity).',
});                                                   // AC-3 / CD-2 — sin x402
if (rawKey.startsWith('wasi_a2a_session_')) return authenticateDelegation(request, reply, rawKey);
if (rawKey.startsWith('wasi_a2a_sess_'))    return authenticateKeySession(request, reply, rawKey);
return authenticateMasterKey(request, reply, rawKey);
```

### Branch master — `authenticateMasterKey`
| Paso | Acción | Error (código idéntico a hoy) |
|---|---|---|
| 1 | `hash = sha256(rawKey)` | — |
| 2 | `keyRow = identityService.lookupByHash(hash)` | null → `send403 KEY_NOT_FOUND` |
| 3 | `!keyRow.is_active` | → `send403 KEY_INACTIVE` |
| — | **SKIP** daily_limit / per_call_limit (DT-C) | — |
| 4 | if `require_signature`: `extractSignedHeaders`; falta firma → `401 SIGNATURE_REQUIRED`; `verifySignedAuth({kind:'eip712', fundingWallet: keyRow.funding_wallet})`; `!ok` → `sendSignedAuthError` | 401 / 403 FUNDING_WALLET_NOT_BOUND |
| — | **SKIP** chain-resolution + débito (DT-C/DT-G) | — |
| 5 | `keyRow.erc8004_verified = isIdentityVerified(keyRow)`; `request.a2aKeyRow = keyRow` | — |
| catch | log sin token → `503 SERVICE_ERROR` | — |

### Branch delegación — `authenticateDelegation` (rawKey `wasi_a2a_session_*`)
| Paso | Acción | Error |
|---|---|---|
| 1 | `hash`; `delegation = delegationService.lookupByTokenHash(hash)` | null → `401 INVALID_SESSION_TOKEN` |
| 2 | `delegation.revoked_at !== null` | → `send403delegation DELEGATION_REVOKED` |
| 3 | expirada (`Date.now() >= expires_at`) | → `send403delegation DELEGATION_EXPIRED` |
| 4 | `parentKey = delegationService.getParentKey(delegation.key_id)`; `!parentKey?.is_active` | → `send403delegation KEY_INACTIVE` |
| — | **SKIP** chain-resolution, allowed_chains, per-tx, débito (DT-C/DT-G) | — |
| 5 | `effectiveRow = buildDelegationEffectiveRow(parentKey, delegation)` (W0); `effectiveRow.erc8004_verified = isIdentityVerified(parentKey)`; `request.a2aKeyRow = effectiveRow`; `request.delegationRow = delegation` | — |
| catch | → `503 SERVICE_ERROR` (Delegation service…) | — |

> `allowed_chains` es una restricción chain-scoped de gasto; sin chain resuelta
> ni débito no aplica (una publish de $0 no usa ninguna chain). SKIP consciente,
> alineado con DT-C.

### Branch key-session — `authenticateKeySession` (rawKey `wasi_a2a_sess_*`)
| Paso | Acción | Error |
|---|---|---|
| 1 | `hash`; `session = keySessionService.lookupByTokenHash(hash)` | null → `401 SESSION_TOKEN_INVALID` |
| 2 | `session.revoked_at !== null` | → `send403session SESSION_TOKEN_INVALID` |
| 3 | expirada | → `send403session SESSION_EXPIRED` |
| 4 | `parentKey = keySessionService.getParentKey(session.key_id)`; `!parentKey?.is_active` | → `send403session KEY_INACTIVE` |
| 5 | if `session.require_signature`: `extractSignedHeaders`; falta → `401 SIGNATURE_REQUIRED`; `verifySignedAuth({kind:'hmac', signingSecretHash: session.signing_secret_hash})`; `!ok` → `sendSignedAuthError` | 401 / 403 |
| — | **SKIP** chain-resolution + débito (DT-C/DT-G) | — |
| 6 | `effectiveRow = buildSessionEffectiveRow(parentKey, session)` (W0); `erc8004_verified`; `request.a2aKeyRow = effectiveRow`; `request.keySessionRow = session` | — |
| catch | → `503 SERVICE_ERROR` (Key-session…) | — |

**Nota de fidelidad AC-2:** cada código y su helper (`send403` / `send403delegation`
/ `send403session` / `sendSignedAuthError`) es el MISMO que hoy en los pasos de
auth de los resolvers pagos — solo se removieron los pasos de chain/limits/débito.

---

## 6. Plan de tests (≥1 por AC)

### Nuevos — `src/middleware/a2a-key.test.ts` (nuevo `describe('requireA2AKey — auth-only (WKH-173)')`, reusa los mocks existentes; monta una ruta `/test-free` con `preHandler: requireA2AKey()`)

| Test | AC | Qué verifica |
|---|---|---|
| T-RA-01 | AC-1 | master key válida → 200, `request.a2aKeyRow.id` seteado, **`mockDebit` NUNCA llamado** (budget del key NO baja), sin header `x-a2a-remaining-budget`. |
| T-RA-02 | AC-1 | delegación válida (`wasi_a2a_session_`) → 200, `a2aKeyRow.owner_ref === parent.owner_ref`, **`debitDelegationAndParent` NUNCA llamado**. |
| T-RA-03 | AC-1 | key-session válida (`wasi_a2a_sess_`) → 200, **`debitSessionAndParent` NUNCA llamado**. |
| T-RA-04 | AC-2 | matriz de credenciales inválidas → códigos idénticos a hoy: master `KEY_NOT_FOUND`, `KEY_INACTIVE`; delegación `INVALID_SESSION_TOKEN`(lookup null), `DELEGATION_REVOKED`, `DELEGATION_EXPIRED`, `KEY_INACTIVE`; sesión `SESSION_TOKEN_INVALID`, `SESSION_EXPIRED`, `KEY_INACTIVE`. |
| T-RA-05 | AC-3 | (a) sin `x-a2a-key` ni Bearer → `403 A2A_KEY_REQUIRED` y **`mockGetPaymentAdapter` (x402) NUNCA llamado**; (b) con `X-PAYMENT` presente pero SIN a2a-key → igual `403 A2A_KEY_REQUIRED`, x402 nunca invocado (cierra el hallazgo de pago-real perdido). |
| T-RA-06 | AC-4 | delegación con `policy.allowed_agent_slugs` → `a2aKeyRow.allowed_agent_slugs` = scoping esperado y `owner_ref` = parent (ownership guard sigue operable). Sesión con intersección de scope → idem. Valida que el `effectiveRow` del builder compartido (W0/DT-B) es el correcto. |
| T-RA-07 | AC-7 | master `require_signature:true` sin firma → `401 SIGNATURE_REQUIRED`; con firma y `verifySignedAuth` ok → 200. Sesión `require_signature:true` (HMAC) → idem. |
| T-RA-08 | AC-8 / DT-C | master con `daily_spent_usd >= daily_limit_usd` (y/o `max_spend_per_call_usd` bajo) → **200 igual** (auth-only no chequea spend-limits), `mockDebit` no llamado. Confirma el cambio de comportamiento intencional. |

### Regresión W0 (AC-5 / AC-6) — `src/middleware/a2a-key.test.ts`
- Las suites `delegation branch (WKH-101)`, `key-session branch (WKH-121)`,
  `WKH-125*` dest-cap y `WKH-127 skipMiddlewareDebit` deben pasar **sin
  modificar** tras el swap a los builders puros (prueba de refactor puro).
- Opcional (recomendado): T-RA-BLD — test de igualdad directa de
  `buildDelegationEffectiveRow`/`buildSessionEffectiveRow` contra el objeto
  esperado, para anclar el contrato del builder.

### Rutas — `src/routes/agents.publish.test.ts` + `src/routes/agents.ownership.test.ts`
- **Actualizar el `vi.mock('../middleware/a2a-key.js', …)`** para exponer
  `requireA2AKey: () => [ async (request) => { if (currentOwner===null) return; request.a2aKeyRow = { id:'fake-key-id', owner_ref: currentOwner }; } ]`
  (hoy exponen `requirePaymentOrA2AKey`). Sin otro cambio: T-PUB-01…19,
  T-143B-*, T-PUB-08/09 y los ownership tests siguen verdes con el nuevo nombre
  (la ruta lee `a2aKeyRow.owner_ref`; T-PUB-12 con `currentOwner=null` sigue
  cayendo al guard interno → `403 A2A_KEY_REQUIRED`).

### Regresión global (AC-5 / AC-6)
- `/compose`, `/orchestrate*`, `/gasless/transfer`, `/registries` y sus tests de
  **débito** intactos (siguen usando `requirePaymentOrA2AKey`, sin cambios). La
  suite completa (`npm run test`) en 0 fallos.

---

## 7. Exemplars verificados (paths confirmados)

| Exemplar | Path (verificado) | Uso |
|---|---|---|
| Dispatcher pago a clonar | `src/middleware/a2a-key.ts:1013-1050` (`requirePaymentOrA2AKey`) | orden de dispatch para `requireA2AKey` (CD-6) |
| `effectiveRow` delegación a extraer | `src/middleware/a2a-key.ts:503-513` | builder `buildDelegationEffectiveRow` (W0) |
| `effectiveRow` sesión a extraer | `src/middleware/a2a-key.ts:740-754` | builder `buildSessionEffectiveRow` (W0) |
| Firma master EIP-712 | `src/middleware/a2a-key.ts:848-866` | branch master paso 4 |
| Firma sesión HMAC | `src/middleware/a2a-key.ts:594-615` | branch sesión paso 5 |
| Helpers de error | `src/middleware/a2a-key.ts:92-157` (`send403`, `send403delegation`, `send403session`, `sendSignedAuthError`) | reuso en los 3 branches (CD-7) |
| Patrón middleware-test | `src/middleware/a2a-key.test.ts:274-420` (mount `/test` + inject + mocks) | nuevo describe `requireA2AKey` |
| Mock de auth en route-tests | `src/routes/agents.publish.test.ts:77-84`; `src/routes/agents.ownership.test.ts:68-75` | actualizar export a `requireA2AKey` |
| Rutas a swappear | `src/routes/agents.ts:99-107, 271-282, 405-413, 450-458` | swap de preHandler (W1) |

Sin paths inventados: todos confirmados por Read en esta sesión.

---

## 8. Readiness Check

- [x] Work-item leído completo (ACs, DTs, CDs, Scope IN/OUT, Missing Inputs).
- [x] `project-context.md` leído — stack (Fastify + TS strict + vitest + biome),
      sin drift detectado con el código.
- [x] `requireA2AKey()` diseñado sin duplicar la validación de seguridad crítica
      (reuso de primitivas + builders compartidos DT-B) y sin arrastrar
      débito/chain/x402.
- [x] Decisión refactor-vs-función-nueva resuelta y justificada (§2 DT-A/DT-B):
      función nueva + extracción dirigida del `effectiveRow`.
- [x] DT-2 (spend-limits saltados) y DT-4 (`GET /agents` incluido) RATIFICADOS
      (§2 DT-C/DT-E). Missing Inputs #1 y #2 resueltos.
- [x] Backward-compat DURA (CD-1/CD-5): débito de los 3 resolvers pagos
      byte-idéntico; único cambio = swap del builder (refactor puro, gate W0).
- [x] AC-3 (x402-anónimo) cubierto: `requireA2AKey` nunca importa/invoca x402;
      sin credencial → 403 directo (§5, T-RA-05).
- [x] Waves definidas (W0 serial gate → W1 → W2 → W3 humano `!`).
- [x] Test plan ≥1 por AC + regresión W0 + regresión global (§6).
- [x] Exemplars verificados con paths reales (§7).
- [x] CDs específicos del SDD, incl. Auto-Blindaje recurrente de Biome
      (CD-8/CD-9), heredados y agregados.
- [x] Missing Input #3 (`registries.ts`) y #4 (Fix 2 default-chain) fuera de
      scope, como tickets aparte (sin resolver aquí, documentado).

**Sin `[NEEDS CLARIFICATION]` pendientes. SDD listo para `SPEC_APPROVED`.**
