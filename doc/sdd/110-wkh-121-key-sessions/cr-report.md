# Code Review (CR) — WKH-121 Session Keys server-side (sin EIP-712)

> Agente: nexus-adversary (modo CR — calidad de código)
> Fecha: 2026-06-19
> Branch: feat/110-wkh-121-key-sessions (cambios en working tree, sin commitear)
> Story: doc/sdd/110-wkh-121-key-sessions/story-file.md
> Nota: corre EN PARALELO con AR. Hallazgos de seguridad/integridad puros se delegan al AR.

## Estado de build/tests (contexto, no es un check de CR)
- `tsc --noEmit`: PASS (TS strict, sin `any`/`as unknown`/`@ts-ignore` introducidos).
- `eslint` sobre archivos tocados: PASS (exit 0).
- Suite nueva (key-session.test.ts + auth.keySession.test.ts + a2a-key.test.ts): 89 pass / 0 fail.
- Suite completa: 1419 pass / 0 fail (sin regresiones).

---

## Check 1 — Naming consistency — OK

`keySessionService` espeja `delegationService` (objeto literal exportado, mismos métodos
`create`/`lookupByTokenHash`/`getParentKey`/`list` + `debitSessionAndParent` ≈ `debitDelegationAndParent`).
Error classes consistentes con el patrón del proyecto (`readonly code = '...' as const` + `name`):
`SessionTokenInvalidError`, `SessionExpiredError`, `SessionBudgetExhaustedError`, `SessionNotAllowedError`
(errors.ts:286-319), más las locales del service `ScopeExceedsParentError`/`InvalidKeySessionInputError`
(key-session.ts:45-60). Constante `KEY_SESSION_TOKEN_PREFIX` espeja `SESSION_TOKEN_PREFIX` (key-session.ts:40).
Tipos `KeySessionRow`/`CreateKeySessionInput`/`KeySessionResponse`/`KeySessionListItem`/`KeySessionStatus`/
`KeySessionDebitContext` espejan los `Delegation*` (a2a-key.ts:257-339). Helper `send403session`
espeja `send403delegation`. Naming alineado.

## Check 2 — Complejidad — OK

- `keySessionService.create` (~95 líneas con JSDoc; ~70 de cuerpo): pasos 1-8 numerados y lineales,
  ciclomática moderada (validaciones secuenciales con early-throw). Aceptable y legible.
- `debitSessionAndParent` (key-session.ts:326-382): cadena de `if (msg.includes(...))` — alta cantidad de
  ramas pero plana y exhaustiva; espeja 1:1 el patrón canónico de `delegationService`. No es deuda.
- Branch nuevo de middleware (a2a-key.ts:463-630, ~167 líneas): largo pero es el espejo estructural exacto
  del branch WKH-101 (L259-461), con los mismos 6-7 pasos numerados. El catch de mapeo de errores agrega
  longitud lineal, no complejidad ciclomática real. Consistente con el exemplar; no se justifica refactor
  (CD-1 prohíbe tocar el branch WKH-101 y "mejorar" adyacente).

## Check 3 — DRY — OK (con nota)

- Reusos correctos: `increment_a2a_key_spend` (RPC, vía `PERFORM`), `resolveTargetChain`,
  `resolveCallerKey`, `rawKeyFromRequest`, `logOwnershipMismatch` (forma objeto), error classes
  reusadas (`AgentKey*`, `DailyLimitExceededError`, `OwnershipMismatchError`). `budgetService.getBalance`
  reusado para el header `x-a2a-remaining-budget`.
- Duplicación consciente y razonable: el branch de middleware y la rama key-session de `budget.debit`
  duplican la *estructura* del branch/rama WKH-101. Está explícitamente mandatado por CD-1 (NO tocar
  WKH-101, INSERTAR un branch nuevo, NO factorizar lo existente). Factorizar un helper común entre ambos
  branches habría obligado a modificar el camino WKH-101 en prod → riesgo de back-compat. La duplicación
  acá es la decisión de menor riesgo y está documentada. No es finding.

## Check 4 — SOLID (lente pragmática) — OK

- SRP: `key-session.ts` concentra solo lógica de sesión; validación de shape vive en el route
  (`parseCreateKeySessionInput`, auth.ts:277-325), validación semántica en el service. Separación limpia.
- OCP/DIP: `budget.debit` extiende vía parámetro opcional `keySessionContext?` sin romper la firma master
  (budget.ts:70-122); el branch nuevo se inyecta sin tocar master ni WKH-101. Consistente con el patrón
  delegación previo.
- ISP: tipos acotados (`KeySessionDebitContext` lleva solo `sessionId/ownerRef/keyId`, sin per-tx que no
  aplica a sesiones — nota correcta en budget.ts:78).

## Check 5 — Tests — OK

Cobertura por AC verificada (lente de calidad, no veredicto F4):
- AC-1: auth.keySession.test.ts:143 (201 + token plano solo en respuesta) + key-session.test.ts:115
  (persiste solo hash, `JSON.stringify(insertedRow).not.toContain(token)` — assert significativo).
- AC-2: SCOPE_EXCEEDS_PARENT por registries (key-session.test.ts:193) + por budget (test:184) + route 400 (test:177).
- AC-3: ttl <=0, > max, no-entero, env NaN fail-safe (key-session.test.ts:138-173 + auth.test.ts:192-235).
- AC-4/5/6/7: middleware branch (a2a-key.test.ts:1479-1570).
- AC-8: race en mock (key-session.test.ts:369) + e2e real gateado FOR UPDATE (key-session-atomicity.real.test.ts:91)
  — assert `spent_usd === M (no 2M)` es el assert correcto para no-double-spend.
- AC-9: SESSION_BUDGET_EXHAUSTED service + middleware (test:258 + a2a-key.test.ts:1573).
- AC-10: scope efectivo `[a]` y herencia `null+[a,b]→[a,b]` (a2a-key.test.ts:1588-1625).
- AC-11: `list` filtra owner_ref + `not.toHaveBeenCalledWith('owner_ref', ...)` en lookupByTokenHash (test:433/460).
- AC-12: 403 SESSION_NOT_ALLOWED + `mockCreate/mockLookupByHash not.toHaveBeenCalled` (auth.test.ts:252).
- AC-13: status active/expired/revoked derivado (key-session.test.ts:391 + auth.test.ts:281).
- AC-14/15: back-compat master + coexistencia bidireccional sess↔session (a2a-key.test.ts:1627-1678).
- CD-AB-1: mapeo completo de prefijos incl. parent RPC + fallback sin leak PG (`not.toContain('postgres'/'0xdeadbeef')`, test:353).
Asserts significativos (no triviales), nombres descriptivos con tag de AC, mocks resetados (`vi.clearAllMocks`),
`delete process.env.SESSION_MAX_TTL_SECONDS` usado (CD-AB-5). Tests sólidos.

## Check 6 — Documentación inline — OK

JSDoc presente donde la lógica no es obvia: RPC mapping (key-session.ts:321-325), scope intersection
(isSubsetOfParent/effectiveScope docstrings + branch middleware:584-587), orden de detección de prefijo
(comentario middleware:464-466 con el ejemplo `'wasi_a2a_session_x'.startsWith('wasi_a2a_sess_') === false`),
`lookupByTokenHash`/`getParentKey` documentan explícitamente por qué NO llevan owner gate (no-IDOR),
`parentAvailableBalance` documenta que es early-fail guard, no la defensa final. Nivel de comentarios alto.

---

## Hallazgos de calidad

### MNR-1 (Naming/Dead code) — `SessionNotAllowedError` declarada pero nunca usada
- Categoría: Naming consistency / dead code.
- Archivo: src/services/security/errors.ts:313-319 (declaración); el AC-12 se resuelve en
  src/routes/auth.ts:1114-1115 con un literal `reply.status(403).send({ error_code: 'SESSION_NOT_ALLOWED' })`.
- Descripción: la clase `SessionNotAllowedError` fue creada por mandato del Story (Files #2) pero el handler
  del sub-delegation gate devuelve el código como literal en vez de instanciarla. Queda como símbolo exportado
  sin consumidor. No rompe nada (el comportamiento HTTP es correcto y testeado en auth.keySession.test.ts:252),
  y el exemplar del gate (auth.ts:903-906 de WKH-101) también usa literal directo — así que es consistente con
  el patrón previo.
- Impacto: ruido menor; un lector puede asumir que la clase se usa en el mapeo de errores y no la encuentra.
- Sugerencia: o bien usar la clase en el handler para uniformidad, o dejar un comentario `// reservada para
  reuso futuro / paridad con errors.ts` en la declaración. No bloquea.

### MNR-2 (Dead code) — type `KeySessionErrorCode` declarado y no referenciado
- Categoría: Naming consistency / dead code.
- Archivo: src/types/a2a-key.ts:334-339.
- Descripción: la union `KeySessionErrorCode` (mandada por Story Files #1) no se referencia en ningún lado;
  el middleware define su propio `KeySessionMiddlewareErrorCode` (a2a-key.ts:112-122, superset que incluye
  `AGENT_KEY_BUDGET_EXHAUSTED`/`DAILY_LIMIT`/`KEY_NOT_FOUND`/`OWNERSHIP_MISMATCH`). Dos tipos de error-code
  paralelos para el mismo dominio, uno sin consumidores.
- Impacto: ruido menor; mínima duda sobre cuál es el tipo canónico.
- Sugerencia: usar `KeySessionErrorCode` como base y que `KeySessionMiddlewareErrorCode` lo extienda, o
  eliminar el primero. No bloquea (ambos son `tsc`-válidos y no afectan runtime).

> Ambos MNR son consecuencia directa de cumplir literalmente la tabla "Files to Modify/Create" del Story
> (que pidió crear esos símbolos) mientras el código real prefirió literales/un tipo local. Son deuda
> cosmética, no defectos funcionales.

---

## Categorías de seguridad/integridad (territorio AR — observado de pasada, NO veredicto)
> Reportado para que el orquestador deduplique con AR. No los conté como findings de CR.
- Ownership Guard: `list` filtra `owner_ref` (key-session.ts:277); `debitSessionAndParent` pasa `ownerId`
  y el RPC re-chequea owner+key bajo lock (migración:55-61); `lookupByTokenHash`/`getParentKey` sin owner
  gate están justificados (auth-by-token / key_id derivado del row). Firma de `debitSessionAndParent` exige
  `ownerId: string` (no opcional). Coherente con CD-2.
- RPC `SECURITY DEFINER` con `SET search_path = public, pg_temp` + REVOKE PUBLIC/anon/authenticated +
  GRANT service_role (migración:88-96). Hardening presente.
- Token: solo hash SHA-256 persistido; plano devuelto una vez (key-session.ts:179-215). No se loga.

---

## Veredicto

**APROBADO con MENORs**

- 0 BLOQUEANTES (ALTO/MEDIO/BAJO).
- 2 MENOR (MNR-1, MNR-2): dead code cosmético derivado de cumplir la tabla de archivos del Story. NO
  bloquean DONE; quedan a criterio del Dev/orquestador si se limpian ahora o van a backlog.

Calidad de código alta: espejo fiel del exemplar WKH-101, naming consistente, tests con asserts
significativos cubriendo los 15 ACs + CD-AB-1, documentación inline sólida, tsc/lint/suite verdes
sin regresiones. La duplicación estructural con WKH-101 es una decisión de menor riesgo explícitamente
mandatada por CD-1, no una violación DRY.
