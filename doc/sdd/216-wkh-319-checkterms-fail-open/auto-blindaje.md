# Auto-Blindaje — WKH-319

Errores cometidos DURANTE la implementación y cómo se corrigieron. No es un
resumen de la HU: es lo que protege a la próxima del mismo tropiezo.

---

### [2026-07-30 11:20] Wave 0 — Un `tsc --noEmit` VERDE sobre un worktree sin `node_modules`

- **Error**: corrí `npx tsc --noEmit` en `wt-319` y leí `TSC_EXIT=0` como
  "typecheck limpio". La salida real estaba llena de `TS2307 Cannot find module
  'vitest' / 'viem' / 'viem/chains'`: el worktree se había creado **sin instalar
  dependencias**, así que TypeScript no resolvía NADA. Un typecheck que no
  resuelve los módulos no verifica los tipos: verifica la sintaxis.
- **Causa raíz**: dos fallas encadenadas. (1) `git worktree add` no trae
  `node_modules`, y nada en el flujo lo recuerda. (2) El `$?` que leí era el
  **exit del último comando del pipe** (`tail`), no el de `tsc` — el pipe se
  come el código de salida real.
- **Fix**: `npm ci` en el worktree, y después `npx tsc --noEmit` **sin pipe**,
  leyendo el `$?` inmediato. Recién ahí el verde significa algo.
- **Aplicar en**: cualquier worktree nuevo (`wt-*`). **Antes de creerle a un
  typecheck o a una suite, verificar que `node_modules` existe.** Y nunca leer
  `$?` después de un pipe: el código de salida que importa queda tapado. Es la
  misma familia que el falso KILLED de 209 §M12 (un archivo que no colectó y
  reportó `no tests` con exit 0): **la herramienta contestó algo que no habla
  del código.**

---

### [2026-07-30 11:26] Wave 0 — `biome_exit=1` sobre un comando que nunca corrió

- **Error**: leí `biome_exit=1` como "el lint encontra errores" y estuve a punto
  de salir a buscar violaciones que no existían. El comando había fallado con
  `npm error Missing script: "@biomejs/biome"`: el hook de `rtk` reescribe
  `npx` a `npm`, y `npm @biomejs/biome` no es nada.
- **Causa raíz**: un exit code distinto de 0 tiene (al menos) dos causas —
  *"la herramienta corrió y encontró algo"* y *"la herramienta nunca corrió"*—
  y el número las colapsa. Exactamente el bug que esta HU arregla, aplicado a mi
  propia verificación.
- **Fix**: invocar el binario por path (`./node_modules/.bin/biome`) vía
  `rtk proxy`, y **leer la última línea de la salida** (`Checked N files`) antes
  que el exit code. Si no dice cuántos archivos revisó, no revisó nada.
- **Aplicar en**: toda verificación de esta corrida (tsc, biome, vitest). Un
  comando de verificación tiene que reportar **cuánto midió**, no sólo si salió
  bien. Un `Tests 0 passed` con exit 0 es una suite ausente, no una suite verde.

---

### [2026-07-30 11:35] Wave 1 — La batería nueva pasó ENTERA en la primera corrida

- **Error**: los 20+ tests de T-319 pasaron al primer intento contra el código
  ya arreglado. Estuve a punto de tomar ese verde como evidencia. **No lo es**:
  un test que nunca vio rojo no prueba que mida algo — puede estar afirmando una
  tautología, o no estar llegando al código que cree ejercitar.
- **Causa raíz**: escribí los tests DESPUÉS del fix (para el guard de dinero el
  orden correcto era al revés), así que ninguno tuvo su fase roja.
- **Fix**: campaña de mutación **antes de commitear**, con respaldo físico del
  fuente + `sha256sum` antes y después (`prohibido git checkout --` sobre
  trabajo sin commitear). 14/14 mutantes muertos, cada uno con el test nombrado
  que lo mató, y el hash del fuente volvió idéntico
  (`1789beac98dfdf…`). El script de mutación además **falla ruidoso** si el
  ancla del patch no es única y **rechaza el KILLED** si se colectaron 0 tests.
- **Aplicar en**: todo fix de dinero. **Un test que pasa a la primera contra el
  código arreglado no es evidencia hasta que un mutante lo pone en rojo.** Y la
  cobertura se mide sobre las LÍNEAS DE LOS GUARDS, no sobre el total del
  archivo: acá eso destapó 4 líneas nuevas que ningún test tocaba
  (`mint` no-string, `uiTokenAmount` no-objeto, `accountIndex` duplicado,
  requerido ilegible) — guards escritos que nadie ejercía. Un gate que nadie
  corre no es un gate (CD-7).

---

### [2026-07-30 11:12] Wave 1 — 10 tests en rojo por fixtures, y la tentación de aflojar el guard

- **Error**: ninguno, pero vale documentar el punto de decisión. Al terminar el
  cuerpo nuevo de `checkTerms`, 10 tests preexistentes se pusieron en rojo
  porque sus fixtures no traían `accountIndex`. El camino corto era relajar
  `isBalanceEntry` para que `accountIndex` fuera opcional.
- **Causa raíz**: las 6 fixtures modelaban una forma que **el RPC nunca manda**
  (`accountIndex` es obligatorio en el esquema del SDK) y usaban `amount:'0'` en
  `pre`, que es **la única forma donde el bug es indistinguible del
  comportamiento correcto**. Por eso la suite no podía ver el fail-open: pasaba
  por casualidad.
- **Fix**: se arreglaron **las fixtures**, no el guard (CD-10). Diff de
  `payment.test.ts`: sólo realismo, **cero aserciones aflojadas**. `T-IDM-18b`
  quedó verde **sin tocar su aserción**, que es la prueba de que no hubo
  sobre-corrección.
- **Aplicar en**: cuando un guard nuevo pone en rojo un test viejo, la primera
  hipótesis es que **el test estaba mal**, no el guard. Si al final de la HU un
  canario necesita cambiar su aserción, el arreglo se pasó.
