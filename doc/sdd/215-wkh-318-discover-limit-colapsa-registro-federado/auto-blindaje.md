# Auto-Blindaje — WKH-318

Errores propios cometidos (o trampas encontradas) durante F3. Insumo de la
próxima HU.

---

### [2026-07-30 17:05] Wave 0 — El worktree no tenía `node_modules`

- **Error**: corrí `npx tsc --noEmit` como primera verificación del checklist
  anti-alucinación y leí 53 errores `TS2307 Cannot find module 'vitest' / 'viem'`.
  Por un momento eso se parece a "la baseline ya está rota, hay que avisar"
  (que es justo lo que el story file manda hacer en ese caso).
- **Causa raíz**: `wt-318` es un `git worktree` recién creado. Los worktrees NO
  comparten `node_modules` con el repo principal, y nadie había corrido `npm ci`
  ahí. `npx tsc` igual resolvía un `tsc` (de fuera del worktree), así que el
  comando "funcionaba" y devolvía exit 0 — el fallo se presentaba como errores
  de tipo, no como "falta instalar".
- **Fix**: `npm ci` dentro del worktree. Después, `npx tsc --noEmit` limpio, que
  es la baseline que el story file afirmaba.
- **Aplicar en**: cualquier HU que arranque en un worktree nuevo (`wt-313`,
  `wt-315`, `wt-319` tienen el mismo riesgo). **Antes** de leer una baseline
  como evidencia de nada, verificar que `node_modules/` existe. Un `TS2307`
  masivo sobre paquetes de terceros casi nunca es "la rama está rota": es que no
  hay dependencias instaladas. Distinguir *no pude compilar* de *compila mal* es
  el mismo triplete que esta HU implementa para las fuentes de discovery.

---

### [2026-07-30 17:16] Wave 0 — El criterio de terminado de W0 es inalcanzable como está escrito

- **Error**: el story file pide, como criterio de terminado de **W0**,
  `npx tsc --noEmit` con CERO errores. No es alcanzable sin invadir W1.
- **Causa raíz**: W0 hace `sources` y `catalogStatus` **requeridos** en
  `DiscoveryResult` (W0.2a). Eso rompe a TODO constructor del tipo — y dos de
  esos constructores no son fixtures, son **producción**: el early-return de
  `discovery.ts:221` (que W1.4 arregla) y el `return` del pipeline en
  `discovery.ts:486` (que W1.3 arregla). W0.3 sólo presupuestó los fixtures de
  test, no estos dos sitios.
- **Fix**: NO tapar el agujero con un valor plausible. El early-return se
  implementó en W0 con su forma FINAL de W1.4 (`sources: []`,
  `catalogStatus: 'complete'`), que es correcta y no depende de nada de W1. El
  `return` del pipeline se dejó **rojo a propósito**: rellenarlo con
  `sources: [], catalogStatus: 'complete'` habría metido en un commit un
  "el catálogo siempre está completo" — exactamente la mentira que esta HU
  existe para matar, aunque durara un solo commit. W0 se commiteó con **1 error
  de `tsc` declarado en el mensaje del commit**, y W1.3 lo cerró.
- **Aplicar en**: cualquier HU que vuelva **requerido** un campo de un tipo
  compartido. El costo no es sólo "los fixtures": hay que enumerar también los
  constructores de producción, y decidir wave por wave cuáles tienen un valor
  VERDADERO disponible en esa wave. Cuando no lo hay, un `tsc` rojo declarado es
  más barato que un valor inventado que compila.

---

### [2026-07-30 17:14] Wave 0 — El parcheador mecánico no distingue test de producción

- **Error**: el script que insertó `sources: []` / `catalogStatus: 'complete'`
  en los literales de `DiscoveryResult` se manejó por las posiciones que reporta
  `tsc`, y `tsc` también reporta los dos sitios de `src/services/discovery.ts`.
  El script parcheó producción con el mismo valor plano que los fixtures.
- **Causa raíz**: la lista de sitios a parchear se derivó del *síntoma* (el
  error de compilación) y no del *criterio* (es un fixture de test). Los dos
  conjuntos casi coinciden, y ese "casi" es donde entra un dato inventado en
  producción.
- **Fix**: revisar el `git diff` del parche ANTES de dar la wave por cerrada; se
  revirtió la inserción en el `return` del pipeline y se reescribió el
  early-return a mano con su docstring. El script quedó como está pero su salida
  se lee, no se confía.
- **Aplicar en**: todo refactor mecánico masivo. Un parche generado se revisa
  por diff, y con más cuidado en `src/` que en `*.test.ts`. Si el parcheador no
  puede distinguir producción de test, el que lee el diff sí tiene que poder.

---

### [2026-07-30] Wave 0 — El número de fixtures estimado no era el medido

- **Nota** (no es un error propio, es calibración para el próximo): el story
  file estimaba **~61 sitios en 17 archivos**, con `src/__tests__/e2e/setup.ts:67`
  marcado como "crítico". Lo **medido** con `tsc` fue **51 sitios en 12
  archivos**, y `setup.ts` **no aparece** (su literal no se type-checkea contra
  `DiscoveryResult`). El mayor concentrador sí se confirmó:
  `src/services/orchestrate.test.ts` con **31**.
- **Aplicar en**: las estimaciones por escaneo de texto sobre-cuentan. Medir con
  el compilador antes de presupuestar el trabajo, y reportar el número medido —
  no repetir el estimado como si se hubiera verificado.
