# Auto-Blindaje — Audit B1a: activar `noUncheckedIndexedAccess` (F3)

### [2026-06-24 20:55] Guard con `continue` habría saltado lógica post-iteración (compose.ts)
- **Error**: al arreglar `steps[i + 1]` en el segundo bloque del loop de `compose.ts`
  (línea ~561), mi primer intento agregó `if (nextStep === undefined) continue;`.
- **Causa raíz**: ese `if (i < steps.length - 1)` NO es el final del cuerpo del `for` —
  después del bloque hay emisión del evento `compose_step` (línea ~624+). Un `continue`
  cuando `nextStep` fuese undefined (caso imposible por el invariante `i < steps.length - 1`)
  habría sido inofensivo en runtime, pero el patrón es peligroso: en un loop con lógica
  post-bloque, `continue` dentro de un guard de tipo puede saltarse trabajo legítimo si el
  invariante alguna vez no se cumpliera, divergiendo del comportamiento original.
- **Fix**: reemplacé el `continue` por non-null assertion justificada
  `const nextStep = steps[i + 1]!;` con comentario `// safe: i < steps.length - 1 garantiza
  i+1 < steps.length`. El acceso es genuinamente imposible de violar y NO altera el flujo.
- **Aplicar en**: cualquier guard `if (x === undefined) continue/return` agregado para
  satisfacer `noUncheckedIndexedAccess` DENTRO de un loop — verificar primero que el `continue`
  cae al final del cuerpo del loop. Si hay lógica después del bloque que el `continue` saltaría,
  usar `!` (con justificación de invariante) en vez de `continue`, o reestructurar para que el
  guard envuelva solo el sub-bloque afectado.

### [2026-06-24 20:50] `Edit replace_all` no toca ocurrencias con distinta indentación
- **Error**: usé `replace_all: true` sobre `parsers.ts` para el patrón
  `match?.[1].startsWith(...)` → `match?.[1]?.startsWith(...)` esperando arreglar las 2
  ocurrencias (líneas 113 y 143). Solo arregló la de línea 113; tsc siguió fallando en 143.
- **Causa raíz**: las dos ocurrencias tenían indentación distinta (6 vs 4 espacios), por lo que
  el `old_string` (que incluía la indentación) solo matcheó una. `replace_all` reemplaza todas
  las coincidencias EXACTAS del string, no todas las "equivalentes lógicas".
- **Fix**: segundo `Edit` específico para la ocurrencia de 4 espacios. Patrón confirmado vía
  re-corrida de tsc.
- **Aplicar en**: al usar `replace_all` para parches repetitivos, no incluir indentación
  ambigua en `old_string`, o verificar con tsc/grep que TODAS las ocurrencias se resolvieron.

### [2026-06-24 20:58] TS2488 (destructuring) se reporta de a una por archivo
- **Error**: tras arreglar accesos `arr[i].prop`, tsc seguía mostrando un solo error TS2488
  ("must have a [Symbol.iterator]") por vez en `avalanche.test.ts` / `base.test.ts`. Parecía
  que cada fix introducía uno nuevo.
- **Causa raíz**: el error de destructuring `const [a, b] = mock.calls[0]` (calls[0] es
  `T[] | undefined`) se emite secuencialmente; tsc no lista todas las ocurrencias del mismo
  archivo en una pasada cuando son del mismo patrón de iterator. Iba arreglando una y aparecía
  la siguiente.
- **Fix**: en vez de iterar de a una, hice un `grep -rn` proactivo de TODOS los
  `const [..] = *.mock.calls[N];` en src y los parché en bloque con `!` (`mock.calls[N]!`).
- **Aplicar en**: con `noUncheckedIndexedAccess`, los errores de destructuring-desde-array
  pueden ocultarse; buscar proactivamente el patrón completo en vez de confiar en el conteo
  incremental de tsc.
