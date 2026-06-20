# Code Review (CR) — WKH-125 KEY-CONSTRAINTS — Sección Adversary (Calidad)

> Reviewer: nexus-adversary (modo CR — calidad, corre EN PARALELO con AR).
> Fecha: 2026-06-19
> Branch: feat/114-wkh-125-constraints (working tree, sin commitear)
> Input: story-file.md, auto-blindaje.md, working-tree diff (16 archivos).
> Alcance CR: 6 checks de calidad. Seguridad/atomicidad = dominio AR; lo que
> toqué de eso lo reporto igual (ver Nota de solapamiento).

---

## Veredicto: **APROBADO**

0 BLOQUEANTES. 0 MENORES con impacto. La implementación sigue el Story File
con fidelidad alta: tipos, migración, RPC, service, endpoints y aridad de tests
están alineados con los exemplars y las Constraint Directives. `tsc --noEmit`
= 0 errores (TS strict, sin `any`, sin `as unknown`). Suite verde: 147 tests
(WKH-125) + 93 tests (middleware/gasless back-compat) = 240 pass.

---

## Check 1 — Naming consistency → **OK**

- `spend-policy.ts`, `SpendPolicy`/`SpendPolicyInput`/`SpendPolicyRow`/
  `SpendPolicyWindowType`, `DestCapExceededError` (code `'DEST_CAP_EXCEEDED'`),
  `debit_with_dest_policy`, `normalizeDestination`, `InvalidSpendPolicyInputError`
  — todos consistentes con el estilo del repo (espejo de `KeySession*`,
  `SessionBudgetExhaustedError`, `debit_session_and_parent`).
- `normalizeDestination` es claro y su contrato (`trim().toLowerCase()`, `""` →
  throw) está documentado en el JSDoc (spend-policy.ts:44-49). Se exporta y se
  reusa en compose.ts y routes/compose.ts (mismo normalizador → policy y ledger
  coinciden byte a byte, CD-objetivo).

## Check 2 — Complejidad → **OK**

- RPC `debit_with_dest_policy` (migration L55-131): 7 pasos numerados y
  comentados, ciclomática baja (2 ramas `IF v_has_policy`, 1 `IF rolling/total`).
  Legible; espeja `debit_session_and_parent`.
- `debit()` rama dest-aware (budget.ts:232-290): ~58 L pero plana — un `if
  (destination)` con SELECT owner + RPC + cadena de mapeo de prefijos. No
  anidamiento profundo. La rama master back-compat (L292-303) queda intacta y
  separada visualmente. Aceptable.
- `spend-policy.ts`: funciones cortas (`set`/`list`/`delete`/`hasAnyPolicy`
  <30 L c/u), `validateWindow` extraída. Simple.
- `parseSpendPolicyInput` (auth.ts:353-399): validación de shape lineal, sin
  ramas ocultas. OK.

## Check 3 — DRY → **OK**

- El RPC REUSA `increment_a2a_key_spend` vía `PERFORM` (migration L123) — NO
  reimplementa daily/budget (CD-2). Verificado en el test estructural
  (spend-policy.test.ts:398-400).
- `normalizeDestination` es la ÚNICA fuente de normalización, reusada en
  spend-policy.ts, compose.ts:166 y routes/compose.ts (helper
  `deriveComposeDestination`). Cero duplicación del trim+lowercase.
- Mapeo de prefijos: aparece en budget.ts (rama dest-aware) y key-session.ts,
  cada uno con su shape de retorno (service→code vs throw error-class). NO es
  duplicación reprochable: es el patrón establecido del repo (exemplar
  `key-session.ts:454-491`, WKH-121) — `msg.includes('PREFIX')` inline es la
  convención vigente, no un helper. Mantenerlo consistente es lo correcto;
  extraer un helper sería un refactor no solicitado (Out of Scope).

## Check 4 — SOLID → **OK**

- `spend-policy.ts` desacoplado: SRP estricto (CRUD de políticas). NO chequea
  cap ni debita — eso vive en el RPC (CD-1). Documentado en el header del archivo.
- `budget.ts` NO se volvió god-object: la rama dest-aware es aditiva, delega
  toda la lógica atómica al RPC. La firma sumó 1 param posicional opcional al
  final (CD-4 respetado: WKH-121..124 sin tocar sus firmas).

## Check 5 — Tests → **OK** (los 7 ACs cubiertos con asserts significativos)

- **AC-1/AC-7** (auth.spend-policies.test.ts + spend-policy.test.ts): PUT
  persiste con `owner_ref`/`key_id` desde callerKey (no del input),
  `onConflict='key_id,destination'`, `.eq('key_id').eq('owner_ref')`; 0 rows →
  `OwnershipMismatchError`; sub-session token → 403. Asserts concretos.
- **AC-2** (budget.test.ts:525-542): prefijo `DEST_CAP_EXCEEDED` → code
  `DEST_CAP_EXCEEDED`; budget intacto (rollback en RPC).
- **AC-3** (spend-policy.test.ts:392-396): assert estructural sobre el SQL del
  filtro temporal `debited_at >= now() - (v_pol_wsecs * interval '1 second')`.
  Es un assert sobre el string del SQL (no PG real) — consistente con la nota
  vinculante del Story File L665-668 (mocks Supabase, no 2 conexiones PG).
- **AC-4 concurrencia** (budget.test.ts:625-651 + spend-policy.test.ts:370-390):
  el test de budget simula 2 débitos `Promise.all` con cap=1 (1 OK + 1
  rechazado), verifica que exactamente 1 pasa Y que AMBAS dispatchan al RPC
  atómico (no check app-layer). El test estructural valida el orden de locks
  `lock key < lock policy < SUM < check cap < debit < insert ledger` en el SQL.
  **No es una simulación PG real de la race** — pero el Story File (L659, L665-668)
  declara EXPLÍCITAMENTE que la concurrencia se valida vía dispatch + assert
  estructural (los services mockean Supabase). Decisión documentada → NO finding.
  La race real serializa en `FOR UPDATE` (verificado en AR territory).
- **AC-5 back-compat** (budget.test.ts:476-492): sin destino →
  `increment_a2a_key_spend` directo Y assert `not.toHaveBeenCalledWith
  ('debit_with_dest_policy', ...)`. Inverso también (dest-aware no llama
  increment). Asserts fuertes en ambos sentidos.
- **AC-6 herencia** (budget.test.ts:597-617,654-667 + key-session.test.ts:401-439):
  con session ctx + destino, `debitSessionAndParent` recibe el destino como 6º
  arg; sin destino → `p_destination: null`. `DEST_CAP_EXCEEDED` mapea a
  `DestCapExceededError`.
- **CD-6** (spend-policy.test.ts:181-260): total+secs→invalid (sin upsert),
  rolling+0→invalid, rolling+null→invalid, max_usd inválido→invalid.
- Nombres descriptivos (prefijo AC-N/CD-N). Asserts no vagos.

## Check 6 — Documentación inline → **OK**

- Orden de locks documentado en el RPC (migration L70-71, L85, L97, L112,
  L119-122).
- Ventana rolling vs total comentada (migration L97-110).
- Dispatch AC-6 documentado en `debit_session_and_parent` (migration L198-202)
  y en key-session.ts:445-449.
- Llamada condicional del middleware documentada (a2a-key.ts:787-792, explica
  por qué 3-arg vs 6-arg y la back-compat de las aserciones de 3-arg).
- Header de spend-policy.ts explica atomicidad (CD-1) y ownership (CD-3).

---

## Evaluación de la ampliación de `ComposeResult.errorCode` (auto-blindaje) → **OK / aditiva limpia**

El Dev amplió `errorCode?: 'SCOPE_DENIED'` → `'SCOPE_DENIED' | 'DEST_CAP_EXCEEDED'`
en types/index.ts:295 (fuera del Scope IN listado en "Files to Modify").

- **No es un parche**: es la única forma de cumplir un requisito LITERAL del
  Story File (#8b + Test Expectation L657: 402 mid-pipeline). El branch del
  route `errorCode === 'DEST_CAP_EXCEEDED'` → 402 no puede matchear sin (a)
  ampliar el union y (b) setear el errorCode en el call-site de compose.ts.
- Cambio puramente **aditivo** a un tipo (un literal más al union), `errorCode`
  sigue opcional, y compose.ts lo setea condicionalmente
  (`...(debitResult.error === 'DEST_CAP_EXCEEDED' ? {...} : {})`) sin alterar el
  resto del shape ni el guard `i>0`.
- Bien documentado en auto-blindaje.md con la regla de generalización para
  futuras HUs. Scope drift JUSTIFICADO y mínimo, no gratuito.

## Evaluación de las 15 aserciones de aridad actualizadas → **OK / correctas, no debilitadas**

- compose.test.ts: 12 aserciones (mix `toHaveBeenCalledWith` /
  `toHaveBeenNthCalledWith`) recibieron el 6º arg con el destino REAL normalizado
  (`'test-registry/corridor'`, `'test-registry/cashout'`, etc.) — NO
  `expect.anything()`, NO `undefined` donde corresponde un valor. Enumeración
  completa de los 6 args.
- orchestrate.billing.test.ts: 4 aserciones con `'wasiai/a2'`, `'wasiai/a3'`,
  incluida la `not.toHaveBeenCalledWith` (anti-double-charge) con el 6º arg
  coherente.
- Las aserciones de 3-arg (middleware a2a-key.test.ts + gasless.test.ts) NO se
  tocaron — verificado: 93 tests verdes. La llamada step-0 del middleware es
  condicional (3-arg sin `composeDestination`, 6-arg con él), preservando
  back-compat (CD-8b).
- Vitest 4 (trailing args importan): respetado — las llamadas no-compose siguen
  siendo de 3 args literales.

---

## Nota de solapamiento con AR (no findings, solo señalo)

Lo siguiente cae en dominio AR; lo dejo anotado por si AR no lo cubre (corremos
en paralelo): RPC `SECURITY DEFINER` con `SET search_path = public, pg_temp` +
`REVOKE FROM PUBLIC, anon, authenticated` + `GRANT TO service_role` presente en
ambas firmas (migration L133-139, L216-222). Ownership guard DB-layer
(`v_key_owner IS DISTINCT FROM p_owner_ref`). Atomicidad check+debit+ledger en
1 tx con `FOR UPDATE` key+policy. Down-migration reversible (restaura 5-param,
dropea RPC nuevo + 2 tablas). Trigger `set_updated_at` reusa
`trigger_set_updated_at()` existente (verificado en tasks migration) — no
inventó función nueva. Sin hallazgos de calidad acá.

---

## Resumen

| Check | Resultado |
|-------|-----------|
| 1. Naming consistency | OK |
| 2. Complejidad | OK |
| 3. DRY | OK |
| 4. SOLID | OK |
| 5. Tests (7 ACs + concurrencia + back-compat + rolling) | OK |
| 6. Documentación inline | OK |
| Ampliación `ComposeResult.errorCode` | OK (aditiva limpia, justificada) |
| 15 aserciones de aridad | OK (correctas, no debilitadas) |

**Veredicto CR: APROBADO** — 0 BLOQUEANTES, 0 MENORES. tsc 0 errores, 240 tests verdes.
