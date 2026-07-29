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

---

## Fix-pack del AR (2026-07-28/29) — los 3 bloqueantes + 2 menores

### [2026-07-28 18:10] Fix-pack — El código quedó adelante del esquema, y el gate era PROSA

- **Error**: HU-202 convirtió el retorno de `recordDebitSettleStatus` de un log en un
  **gate duro de dinero** (sin lease, no sale el hop 2) sin ningún chequeo ejecutable de
  que la base tuviera las migraciones. Contra una base al nivel de `20260713000001` el RPC
  tira `INVALID_SETTLE_STATUS` ⟹ el hop 1 mueve los fondos del buyer, el hop 2 no sale, y
  el intent termina `failed_ambiguous` SIN reembolso: comprador debitado, vendedor sin
  cobrar. No es un borde, es el 100% del tráfico de escrow.
- **Causa raíz**: el "gate de orden de release" existía sólo como comentario en el header
  del `.sql` y en un `.md`. Nada lo ejecutaba. Un gate que nadie corre no es un gate.
- **Fix**: `src/adapters/escrow/schema-preflight.ts` — verifica contra la base REAL que la
  columna existe y que el RPC acepta `resolving_settle`, ejercitando el RPC con un intent
  id aleatorio y leyendo QUÉ excepción tira (`INVALID_SETTLE_STATUS` = fail /
  `INTENT_NOT_FOUND` = pass, prueba positiva sin escribir nada). Enforce perezoso en
  `settleEscrowAware` ANTES del hop 1 + warm-up fire-and-forget en `index.ts`.
- **Aplicar en**: **toda vez que un valor de retorno pase de "telemetría" a "condición de
  dinero", su precondición de esquema deja de ser documentación y pasa a ser código.** Si
  el fix depende de una migración, el chequeo de esa migración es parte del fix.

### [2026-07-28 18:40] Fix-pack — Un booleano que colapsa causas opuestas

- **Error**: `recordDebitSettleStatus` devolvía `false` para tres hechos distintos: guard
  rechazó (otro tiene el lease ⟹ abortar es correcto), escritura nunca ocurrió (no sabemos
  nada ⟹ otra alarma), y error del RPC. La información para separarlos **ya se calculaba**
  y se usaba SÓLO para redactar el log; después se tiraba.
- **Fix**: resultado discriminado `'applied' | 'rejected_by_guard' | 'write_failed'`. Las
  dos causas siguen fallando cerrado (un pago demorado es recuperable, uno duplicado no),
  pero con alarmas distintas porque el remedio es distinto.
- **Aplicar en**: **si el código ya distingue dos casos para escribir un mensaje, el tipo
  de retorno tiene que distinguirlos también.** Un `boolean` en un camino de dinero casi
  siempre está escondiendo una unión.

### [2026-07-28 19:20] Fix-pack — Un candado sin puerta de salida es plata parada

- **Error**: la fila leaseada no tenía vencimiento, renovación, liberación por caída ni
  NINGUNA operación soportada que la destrabara. Un deploy en medio del hop 2 la dejaba
  intocable para siempre. Peor: `dashboard.ts` le decía al operador "resolvé con esa
  evidencia" y **ese endpoint no existía** — el único remedio era un `UPDATE` a mano.
- **Fix**: dos verbos con calidades de evidencia OPUESTAS y por eso separados:
  `/hop2-evidence` (hash **verificado on-chain** antes de cerrar) y `/release-lease`
  (atestación humana auditada del negativo). **Ningún camino por tiempo**: liberar por edad
  reabre el caso F. Sin migración nueva: reusa `record_reconciliation_resolution` y
  `record_debit_settle_status`.
- **Aplicar en**: **cuando un fix agrega un estado que bloquea una acción automática, el
  mismo PR tiene que agregar la operación que lo destraba.** Y si un mensaje le indica una
  acción al operador, esa acción tiene que existir — verificarlo es parte del review.

### [2026-07-28 21:15] Fix-pack — Un doble que descarta sus argumentos hace vacuo el test

- **Error**: dos mutaciones de `readLeasedRow` (`.eq('debit_settle_status', …)` y
  `.is('debit_resolution_tx_hash', null)`) **SOBREVIVIERON**. El doble de `supabase.from`
  ignoraba los argumentos de `.eq()`/`.is()` y devolvía la fila igual, así que el servicio
  podía apuntar a `settled` y ningún test lo veía.
- **Fix**: el doble captura `.eq()`/`.is()` (como ya hacía con `.in()` desde HU-198) + una
  aserción sobre el filtro real. Las dos mutaciones pasaron a CAZADAS.
- **Aplicar en**: es la **tercera** vez que este archivo paga lo mismo (`.in()` en HU-198,
  `debit_resolution_tx_hash` en AR#2, ahora `.eq()`/`.is()`). **Antes de afirmar algo sobre
  un filtro, verificar que el doble no lo esté tirando a la basura.** Un test verde sobre
  un doble sordo no prueba nada.

### [2026-07-28 22:00] Fix-pack — Una tabla de verdad re-implementada en JS no puede fallar

- **Error**: `test/hu202-hop2-lease.migration.test.ts` re-implementaba en JavaScript los
  dos guards del `.sql` y después afirmaba sobre la re-implementación. Verdadero por
  construcción: **demostrado empíricamente** — con una mutación stealth que abre el guard
  del claim dejando intacta la substring de la aserción de presencia, la versión decorativa
  quedó **VERDE**.
- **Fix**: el predicado se EXTRAE del `.sql` (`extractGuardClause`) y se EVALÚA
  (`evalSqlPredicate`, subconjunto SQL booleano). La misma mutación stealth ahora es ROJA.
  Más T20-T22: el evaluador se prueba a sí mismo, tira ante un identificador no modelado, y
  T22 demuestra inline que mutar el clause cambia la tabla de verdad.
- **Aplicar en**: **una aserción que re-escribe la lógica que dice verificar es decoración.**
  La prueba de que un test no es vacuo es una mutación que lo ponga rojo — si no se
  encuentra ninguna, el test no está candando nada.
