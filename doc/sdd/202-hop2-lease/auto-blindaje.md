# Auto-Blindaje — HU-202 (lease del hop 2)

### [2026-07-28 10:45] Wave 1 — El doble de `recordDebitSettleStatus` devolvía `undefined` donde la función real devuelve `boolean`

- **Error**: al agregar el fail-closed del lease (`if (!leaseHeld) → no mandar el hop 2`),
  8 tests se pusieron rojos de golpe. El doble estaba declarado como
  `vi.fn(async (_args: unknown) => undefined)`, o sea que TODO el suite corría con "el
  lease NUNCA se persiste".
- **Causa raíz**: **deriva del test-double respecto del contrato real**. La función real
  devuelve `Promise<boolean>` desde HU-198 (AR BLQ-MEDIO-2, el `applied` que el caller
  consume), pero el doble se había escrito cuando devolvía `void` y nadie lo actualizó.
  Mientras el retorno no gobernaba nada, la deriva era invisible; en el momento en que
  empezó a gobernar dinero, el suite entero pasó a ejercitar la rama equivocada.
- **Fix**: el doble se tipa con el contrato real —
  `vi.fn(async (_args: unknown): Promise<boolean> => true)` — así `tsc` rechaza un
  `mockResolvedValue` que no sea booleano. Y los 3 `mockResolvedValue(undefined)` pasaron
  a `true`. El tipo explícito es lo que convierte la deriva futura en un error de
  compilación en vez de en un test que ejercita otra cosa.
- **Aplicar en**: cualquier doble de una función del money-path cuyo **valor de retorno**
  decida si se mueve plata (`recordDebitHop1`, `finalize_payment_intent`, los RPC que
  devuelven `applied`). Regla: **el doble se anota con el tipo de retorno REAL, nunca se
  deja inferir de un `=> undefined` de conveniencia.** Un doble que devuelve menos de lo
  que la función real devuelve no es un doble, es otra función.

### [2026-07-28 10:48] Wave 2 — Dos candados de HU-198/201 medían el MECANISMO, no el efecto

- **Error**: `T-198-Escrow-Unequivocal` y `T-201-F` afirmaban
  `not.toHaveBeenCalledWith({status:'resolving_settle'})`. Con el lease, ese estado se
  escribe SIEMPRE antes del hop 2 (es el candado), así que los dos se pusieron rojos sin
  que la propiedad de dinero que candaban se hubiera roto.
- **Causa raíz**: la aserción estaba escrita sobre **qué se escribió alguna vez** en vez de
  **con qué estado queda la fila**, que es lo único que después decide si el reconciliador
  re-envía. Mientras hubo una sola escritura las dos formas coincidían; con dos escrituras
  (tomar + liberar) dejaron de coincidir.
- **Fix**: se reescribieron sobre `mock.calls.at(-1)` (el ÚLTIMO estado persistido) más el
  orden lease-antes-del-`sign`. La propiedad candada es la misma —"el seller cobra solo"—
  pero ahora es independiente de cuántas escrituras haga la implementación.
  ⚠️ Es una modificación de un candado ajeno: queda declarada acá y en el reporte.
- **Aplicar en**: todo test sobre una máquina de estados de dinero. `toHaveBeenCalledWith`
  sobre un estado intermedio se rompe (o, peor, pasa por casualidad) en cuanto la
  implementación agrega un paso. **Afirmar el estado FINAL, y el orden si el orden importa.**

### [2026-07-28 10:51] Wave 2 — El helper `code()` dejaba un espacio al frente y `flat()` colapsa el indentado

- **Error**: dos aserciones del test SQL-estructural fallaron por formato, no por conducta:
  `code(sql).startsWith('BEGIN;')` (el filtro de comentarios deja un `\n` inicial que
  `flat` vuelve un espacio) y `toContain('p_status    TEXT')` (`flat` colapsa los espacios
  del alineado a uno).
- **Causa raíz**: se reusó el helper de HU-198 sin internalizar que **normaliza**: cualquier
  aserción copiada literalmente del `.sql` con su indentado original no matchea.
- **Fix**: `.trim()` en las aserciones de posición y espaciado simple en los literales.
- **Aplicar en**: el próximo test `*.migration.test.ts`. Regla: **el literal esperado se
  escribe ya normalizado** (un espacio entre tokens), nunca copiado del `.sql` con formato.

### [2026-07-28 10:40] Wave 2 — Un test que restaura estado global en su ÚLTIMA línea cae en cascada si falla antes

- **Error**: al romperse `T-6` (WKH-192), fallaron además `T-201-B` y `T-201-D`, que están
  en otro `describe` y no tienen nada que ver con el lease.
- **Causa raíz**: `T-6` deja `mockIsEscrowSettleEnabled.mockReturnValue(false)` **en la
  última línea del cuerpo del test**, no en un `afterEach`. Cuando una aserción anterior
  tira, esa línea nunca corre y el flag de escrow queda ON para todos los tests
  siguientes, que pasan a ejercitar un camino de dinero distinto del que declaran.
- **Fix**: no se tocó `T-6` (fuera del Scope IN); el describe NUEVO de HU-202 restaura el
  flag en un `afterEach`, que corre aunque el test falle. Queda anotado como fragilidad
  latente del archivo.
- **Aplicar en**: cualquier test que mute un flag global del money-path. **La restauración
  va en `afterEach`, nunca en la última línea del cuerpo**: si no, un fallo real se
  disfraza de tres fallos en tests inocentes y el diagnóstico apunta al lugar equivocado.

### [2026-07-28 11:05] Wave 2 — Verificación de que ninguna mutación quedó en disco

- **Error**: (preventivo, no ocurrido en esta sesión) una migración nueva es un archivo
  **untracked**, así que `git checkout --` no la revierte y un `git diff` vacío parece
  "revertido" mientras la mutación sigue en disco.
- **Fix**: el harness de mutación (a) restaura desde una **copia** guardada antes de
  empezar, no desde git, y (b) compara `sha256sum` antes/mutado/restaurado en cada
  iteración, más un `diff` final del listado completo de hashes.
- **Aplicar en**: toda campaña de mutación que toque archivos untracked (migraciones,
  scripts nuevos). **La evidencia de reversión es el `sha256sum`, no el `git status`.**
