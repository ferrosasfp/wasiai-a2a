# Auto-Blindaje — WKH-114 (F3 Dev)

Registro de errores cometidos y corregidos durante la implementación, para
blindar futuras HUs del mismo error.

### [2026-07-06 10:30] Wave 0 — `noUncheckedIndexedAccess` en acceso a `DEFAULT_AC[i]`
- **Error**: `tsc --noEmit` falló con `TS2322: Type 'string | undefined' is not
  assignable to type 'string'` en `verification.ts` (helpers `presenceLabel` /
  `errorLabel` que usaban `?? DEFAULT_AC[0]` / `?? DEFAULT_AC[1]`).
- **Causa raíz**: el `tsconfig` del proyecto tiene `noUncheckedIndexedAccess`
  activo, así que indexar un `string[]` (`DEFAULT_AC[0]`) devuelve
  `string | undefined`, no `string`. El `??` no lo salvaba porque el fallback
  también era posiblemente-undefined.
- **Fix**: extraje constantes con nombre (`const AC_PRESENCE = '...'`,
  `const AC_NO_ERROR = '...'`) y armé `DEFAULT_AC = [AC_PRESENCE, AC_NO_ERROR]`.
  Los fallbacks referencian las constantes (tipo `string` garantizado), no el
  índice del array.
- **Aplicar en**: cualquier módulo nuevo que lea `ARRAY[literal]` y use el valor
  como `string` (no-undefined). Preferir constantes nombradas o guardas `?? 'lit'`
  con literal string cuando `noUncheckedIndexedAccess` está activo.

### [2026-07-06 10:30] Wave 0 — biome `useOptionalChain` en guard `x !== null && x.m()`
- **Error**: `biome check` emitió warning `lint/complexity/useOptionalChain`
  sobre `serialized !== null && serialized.toLowerCase().includes(...)`.
- **Causa raíz**: biome prefiere optional-chaining sobre el patrón
  `guard && guard.method()`. El guard defensivo `!== null` disparó la regla.
- **Fix**: reescrito como `Boolean(serialized?.toLowerCase().includes(needle))`
  — preserva el tipo `boolean` del resultado y satisface la regla.
- **Aplicar en**: cualquier expresión `nullable !== null && nullable.foo()` que
  produzca un boolean; usar `Boolean(nullable?.foo())` para conservar el tipo y
  evitar el warning.

### [2026-07-06 14:30] Fix-Pack (post-AR) — never-throw NO cubría la normalización del INPUT (drain del money-path)
- **Error**: en `verification.ts` el guard `criteria && criteria.length > 0
  ? [...criteria] : [...DEFAULT_AC]` estaba FUERA del `try`. Un `criteria`
  truthy pero NO iterable (`{length:1}` — JSON válido, provisto por el caller,
  NO validado en `/compose` ni en `/orchestrate/execute`) hacía `[...criteria]`
  lanzar `TypeError: not iterable`. El motor "never-throw" en realidad SÍ
  throwea → el throw sube por `finishSuccessfulStep` (compose.ts:615) → al catch
  del money-path (compose.ts:300) → `refundStepDebit()` (compose.ts:404)
  reembolsa un step YA settleado → drain del gateway.
- **Causa raíz**: el `try/catch` protegía la EVALUACIÓN y la serialización del
  OUTPUT, pero NO la normalización del INPUT (que corría antes del try). El
  spread de un no-array es un throw síncrono que ningún catch posterior atrapa.
  Confiar en el tipo estático `string[]` es un error: el runtime recibe lo que
  el caller mande (validate ≠ parse, CD-6).
- **Fix**: `Array.isArray(criteria) && criteria.length > 0 ? [...criteria]
  : [...DEFAULT_AC]`. `Array.isArray` garantiza que el spread SOLO corre sobre
  un array real; cualquier input no-array/malformado cae a `DEFAULT_AC` sin
  spreadear algo no-iterable. Tests: 4 vectores en `verification.test.ts`
  (`{length:1}`, `5`, `'foo'`, `{length:1,"0":"x"}`) + 1 test de drain en
  `compose.test.ts` (step DEBITADO i>=1 con criteria malformado → success sin
  refund).
- **Aplicar en**: TODO módulo "never-throw" — el catch DEBE envolver la
  normalización de TODOS los inputs no-validados, no sólo el output. Antes de
  cualquier `[...x]` / `for..of` / `.map` sobre un valor que viene del caller:
  `Array.isArray(x)` primero (o mover dentro del `try`). Regla mental: un throw
  del verificador SALTA al catch del money-path = refund indebido = drain.

### [2026-07-06 14:30] Fix-Pack (post-AR) — `failedCriteria` debía ser subconjunto REAL de `criteria`
- **Error**: al disparar una regla global (non-empty / error-field) con AC
  custom que no tenían wording de presencia/error, `presenceLabel`/`errorLabel`
  devolvían el baseline sintético (`AC_PRESENCE`/`AC_NO_ERROR`) ausente de
  `criteria`, violando el invariante documentado en `types/index.ts`
  (`StepAcceptance.failedCriteria` = "subconjunto de `criteria`").
- **Causa raíz**: el label representativo cae al sintético cuando ningún
  criterio del caller matchea el regex de presencia/error, pero `criteria`
  retornado seguía siendo la lista custom sin ese label.
- **Fix**: en ambas ramas globales, retornar
  `effective.includes(label) ? effective : [...effective, label]` — el baseline
  se agrega a la lista sólo cuando falta, garantizando `failedCriteria ⊆
  criteria` de verdad. Test que asserta el subconjunto.
- **Aplicar en**: cualquier veredicto/reporte que cite "criterios fallidos"
  como subconjunto de una lista — si la etiqueta reportada puede ser sintética
  (no proviene 1:1 de la lista de entrada), incluíla en la lista retornada o
  documentá explícitamente el "o baseline implícito" en el tipo.
