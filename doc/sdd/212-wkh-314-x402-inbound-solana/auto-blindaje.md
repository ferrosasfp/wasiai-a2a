# Auto-Blindaje — WKH-314 (F3, 2026-08-19)

Errores cometidos y corregidos durante la implementación. Cada entrada existe para que
la próxima HU no los repita.

---

### [2026-08-19] W0 — La rama del Story File estaba tomada por un worktree fantasma

- **Error**: `git checkout -b feat/212-wkh-314-x402-inbound-solana` falló con *"is
  already used by worktree at `/home/ferdev/.openclaw/workspace/wt-314`"*, y ese
  worktree apunta a `6b391d6` — 267 commits atrás.
- **Causa raíz**: una sesión anterior creó el worktree y nunca lo limpió. La rama existía
  con **cero commits propios** (`git log main..rama` → 0 líneas), así que "la rama
  existe" no significaba "hay trabajo ahí". Es exactamente lo que la fila 212 del
  `_INDEX.md` ya advertía como *"pista falsa"*.
- **Fix**: se midió que el tip de la rama es ancestro de `main` y que los dos únicos
  archivos no rastreados del worktree eran **byte-idénticos** (md5) a los commiteados en
  `main`. Con eso probado, se trabajó en una rama nueva desde `main`.
- **Aplicar en**: antes de asumir que una rama tiene trabajo, `git log main..rama | wc -l`.
  Y antes de borrar cualquier cosa de un worktree ajeno, md5 contra la copia de `main`.

### [2026-08-19] W0 — Iba a mover una línea citada por `CLAUDE.md`

- **Error**: el diseño inicial hacía `supabase.from('a2a_solana_inbound_proofs')`, lo que
  obligaba a agregar la tabla al bloque `Tables` de `src/types/database.types.ts`.
  Alfabéticamente iba antes de `registries` ⇒ **desplazaba la línea 2567**, que
  `test/cited-lines-guard.citations.ts` declara como cita de `CLAUDE.md`.
- **Causa raíz**: no medí las citas declaradas sobre los archivos que pensaba tocar antes
  de elegir el diseño. La medición (un script sobre `citations.ts`) tardó un minuto y
  cambió una decisión de arquitectura.
- **Fix**: el peek pasó a ser una **función `SECURITY DEFINER`** en vez de un `.from()`.
  Eso (a) deja `database.types.ts` tocado sólo en el bloque `Functions`, que vive después
  de la 2567; (b) es **más** coherente con §7.1 del Story File, que dice que la tabla se
  toca *"exclusivamente desde las funciones `SECURITY DEFINER`"* — o sea que el `.from()`
  la contradecía.
- **Aplicar en**: cualquier HU que agregue una tabla. Medí `citations.ts` **antes** de
  decidir dónde insertar, no después de romper la suite.

### [2026-08-19] W1 — Dejé un bloque sintáctico sin sentido en el archivo del challenge

- **Error**: `verifySolanaChallengeReference` salió con un `return { ok: false, state:
  'not_configured', … }.state === 'not_configured' ? … : …` — un ternario sobre una
  propiedad de un objeto literal, con un campo `ok` que ni siquiera está en el tipo.
- **Causa raíz**: reescribí el early-return a mitad de camino y pegué las dos versiones.
- **Fix**: se reemplazó por el `return` simple. Lo cazó la relectura del archivo recién
  escrito, **no** el compilador — habría compilado igual.
- **Aplicar en**: releer el archivo entero después de escribirlo. `tsc` verde no
  significa "el código dice lo que quisiste decir".

### [2026-08-19] W1 — Un test de `src/` no puede importar de `test/`

- **Error**: puse los fixtures compartidos en `test/helpers/solana-inbound-fixtures.ts`
  (lo que pide el Scope IN §3.2 #21) y `tsc` cortó con **TS6059**: *"File … is not under
  rootDir `/src`"*.
- **Causa raíz**: `tsconfig.json` tiene `rootDir: ./src` e `include: ["src/**/*"]`. O sea
  que `test/**` **no está tipado por `tsc` en absoluto**, y un import desde `src/` lo
  arrastra al programa rompiendo el `rootDir`. Medido además: **no existe hoy ni un solo
  import `src/ → test/`** en el repo, o sea que no había precedente que copiar.
- **Fix**: los fixtures viven en `src/adapters/solana/__tests__/inbound-fixtures.ts`.
  `tsconfig.build.json` ya excluye `src/**/__tests__/**`, así que no van al bundle, y el
  glob de vitest (`*.test.ts`) no los toma como suite.
- **Aplicar en**: helper compartido por tests de `src/` ⇒ va en `src/**/__tests__/`.
  Helper para tests de `test/` ⇒ va en `test/helpers/`. **No se cruzan.**

### [2026-08-19] W1 — Adiviné el `resource` en un test y el test verde no lo era

- **Error**: `T-CACHE-01` armaba la fila cacheada con `resource:
  'http://localhost:80/charged'` escrito a mano. Dio 402 en vez de 200.
- **Causa raíz**: el `resource` es parte de los **términos** que el store compara, y
  adivinarlo hacía que los términos no coincidieran. Lo peligroso no es que fallara:
  es que si el handler hubiera ignorado el `resource` al comparar, este test habría dado
  **verde con el fixture equivocado** y no habría probado nada.
- **Fix**: el test toma el `resource` del propio 402 (`accepts[0].resource`).
- **Aplicar en**: todo fixture que reproduzca un valor que el sistema deriva. **Tomalo
  del sistema, no lo escribas.**

### [2026-08-19] W2 — Un guard estructural cazó una palabra mía

- **Error**: `T-NEUTRALITY-02` (`compose.stranded.test.ts`) se puso rojo: escanea todo
  `src/` buscando `prepaid|prepay|topup|deferredsettlement` contra una lista CONGELADA de
  archivos, y mi mensaje de error del preflight decía *"once as a **prepaid** deposit"*.
- **Causa raíz**: usé el token en inglés sin saber que hay un candado que lo vigila.
- **Fix**: se reescribió la frase (*"as a balance deposit"*) en vez de agregar mi archivo
  a la lista congelada. Mi uso no era el concepto que el guard vigila, pero **ensanchar
  el candado para que pase mi caso lo debilita para el próximo**, que sí podría serlo.
- **Aplicar en**: cuando un guard estructural te frena, la pregunta es *"¿mi texto puede
  cambiar?"* antes que *"¿la lista puede crecer?"*.

### [2026-08-19] W2 — El candado del README se alimenta del ÍNDICE de git

- **Error**: `test/readme-numbers.test.ts` rojo con `expected 296 to be 301` y
  `489 to be 498`. Los dos README declaran cuántos archivos de test y cuántos lintea
  Biome.
- **Causa raíz**: los números se **derivan de `git ls-files`**, o sea del índice. Un
  archivo nuevo no cuenta hasta que se hace `git add`, así que el número cambia en un
  momento distinto de cuando se crea el archivo — y una puerta puede pasar en verde y la
  siguiente explotar por el mismo diff.
- **Fix**: `git add` de todo lo nuevo **por ruta explícita** (nunca `-A`) y después
  actualizar los 4 marcadores de los dos README.
- **Aplicar en**: toda HU que agregue o mueva archivos. Stagear **antes** de correr la
  puerta, o el número que medís no es el que la suite va a ver.

### [2026-08-19] W2 — Los dobles sin tipo rompen `tsc` aunque los tests pasen

- **Error**: la suite del middleware daba 29/29 verde y `tsc` daba 10 errores en ese
  mismo archivo (`TS2347`, `TS2493`, `TS2353`).
- **Causa raíz**: `vi.fn(async () => ({ state: 'none' }))` infiere el tipo **del primer
  literal**, así que `mockResolvedValue({state:'observed', terms:{…}})` no compila; y un
  `vi.fn()` sin parámetros declarados hace que `mock.calls[0]` sea una tupla vacía para
  el compilador — justo el acceso que necesita CD-9 para afirmar sobre los argumentos.
- **Fix**: tipo `Loose = Record<string, unknown>` para el retorno, y **el parámetro
  declarado** en los dobles cuyos argumentos se assertean.
- **Aplicar en**: vitest verde **no** implica `tsc` verde. Las tres puertas, siempre, y
  por separado.
