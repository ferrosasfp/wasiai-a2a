# Auto-Blindaje — 190 (P1 guards sin protección)

### [2026-07-26 10:27] Wave 1 — Line-coverage confundida con protección
- **Error**: casi escribo el test del `delete` del self-heal dando por bueno que
  "no estaba cubierto", cuando `payment.ts` estaba al 98.63% y T-HEAL-1/T-HEAL-2
  SÍ ejecutaban esa línea.
- **Causa raíz**: cobertura de línea mide EJECUCIÓN, no protección. En los dos
  tests existentes el re-broadcast posterior tiene éxito y
  `rememberIntentSignature` hace `.set()`, que sobreescribe la entrada igual: la
  assertion pasa con y sin el `delete`.
- **Fix**: se mutó primero (borrar la línea → `3364 passed`, verde), y sólo después
  se diseñó el test buscando el ÚNICO camino donde el guard es observable
  (re-broadcast que FALLA, así nadie llama a `rememberIntentSignature`).
- **Aplicar en**: cualquier hallazgo del tipo "X está sin test". Mutar ANTES de
  escribir; el % de cobertura no es evidencia de nada.

### [2026-07-26 10:30] Wave 1 — Punteros archivo:línea del AR stale
- **Error**: el encargo ubicaba el `delete` del self-heal en `payment.ts:341` y
  `:360-361`. No está ahí.
- **Causa raíz**: los punteros venían de un AR anterior y el archivo se movió. Como
  agravante, `:360-364` SÍ aparece en el reporte de coverage como no-cubierto
  (`getMaxTimeoutSeconds`/`getMerchantName`), lo que hacía verosímil el puntero
  equivocado.
- **Fix**: se localizó el guard por CONTENIDO (`grep` del `_intentSignatures.delete`)
  y se reportó la línea real (`:448`).
- **Aplicar en**: nunca escribir un test contra un archivo:línea heredado sin
  releer el archivo. Si el guard no está donde dice, reportarlo.

### [2026-07-26 10:38] Wave 2 — Mutación matada por error de sintaxis, no por un test
- **Error**: la mutación M4b (borrar el early-return non-EVM) se reportó KILLED,
  pero el output era `Tests no tests` + `FAIL <archivo>`: había roto el parseo
  (`const configChainId // MUTANT` dejó la declaración sin inicializador).
- **Causa raíz**: un mutante que no compila hace fallar la suite por una razón que
  no tiene nada que ver con el guard. Es un FALSO KILLED: no demuestra que el test
  bite.
- **Fix**: se rehízo la mutación preservando sintaxis válida
  (`(bundle.payment as unknown as { chainId: number }).chainId`) y ahí sí murió por
  la assertion correcta (`expected "vi.fn()" to not be called at all`).
- **Aplicar en**: toda mutación. Si el resultado es "el archivo entero falló" o
  "no tests", el mutante es inválido — revisar que compile antes de contarlo.

### [2026-07-26 10:42] Wave 2 — `vi.importActual` no desmockea las dependencias
- **Error**: (hallazgo del código, y trampa en la que caí al diseñar el reemplazo)
  asumir que `vi.importActual('./payment.js')` alcanza para tener un módulo "real".
- **Causa raíz**: `importActual` desmockea el módulo PEDIDO; sus imports siguen
  resolviendo por el registro de mocks del archivo. Un `vi.mock` a nivel módulo de
  `./chain.js` / `@solana/spl-token` / `@solana/web3.js` contamina cualquier
  `importActual` del mismo archivo.
- **Fix**: el e2e real vive en un archivo SEPARADO sin ningún `vi.mock`
  (`devnet-e2e.manual.test.ts`). La parte offline usa mocks a propósito, pero sólo
  de los 3 bordes de red, y lo documenta.
- **Aplicar en**: cualquier test "de integración" que conviva con `vi.mock` de nivel
  módulo en el mismo archivo. Regla: un e2e no puede compartir archivo con mocks
  de sus dependencias.

### [2026-07-26 10:43] Wave 2 — Un test gateado por env puede pasar en vacío
- **Error**: el patrón `payTo: process.env.SOLANA_E2E_PAYTO as string` del e2e viejo
  (un `undefined` casteado a string) sólo no explotaba porque el mock lo absorbía.
- **Causa raíz**: no había preflight. El test asumía que si el flag estaba prendido,
  el entorno estaba completo.
- **Fix**: el nuevo e2e manual arranca asertando las envs obligatorias con mensaje
  accionable, y verifica el DELTA DE BALANCE en vez de `success: true`.
- **Aplicar en**: todo test gateado por env. Preflight explícito + asertar el efecto
  observable (plata movida), no que la promesa resolvió.

### [2026-07-26 10:48] Wave 3 — Un fallo intermitente casi se archiva como "no reproducible"
- **Error**: la primera vez que vi el fallo (durante la mutación M2a) lo anoté como
  "transitorio, vitest leyó el archivo a mitad de escritura" y seguí. Reapareció en
  el gate final.
- **Causa raíz**: 10 corridas de confirmación no alcanzan para un flake del ~5%; con
  esa tasa, la probabilidad de no verlo en 10 corridas es ~60%. "No lo reproduje en
  N intentos" con N chico es indistinguible de "no existe" sólo si N es grande.
- **Fix**: loop de 40 corridas midiendo tasa, y comparación contra el archivo
  PRISTINO de `HEAD` (`git show HEAD:archivo > archivo`, con backup previo) para
  aislar si el flake era mío o pre-existente. Resultado: pre-existente (2/40 sin mis
  tests), y mis tests 0/40.
- **Aplicar en**: cualquier fallo que no se repite. Nunca cerrarlo por "no
  reproducible" sin medir tasa con N grande, y siempre separar "mío" de
  "pre-existente" corriendo el árbol sin el cambio.

### [2026-07-26 10:44] Wave 3 — Biome no formatea lo que no le pasás
- **Error**: `biome check src/` falló con 1 error de formato en el archivo nuevo,
  después de que tsc y la suite ya estaban en verde.
- **Causa raíz**: escribí el archivo a mano con un wrapping que biome normaliza de
  otra forma; no corrí el formatter sobre los archivos nuevos antes del gate.
- **Fix**: `biome check --write` sobre los 7 archivos tocados, y re-check global.
- **Aplicar en**: correr `biome check --write` sobre los archivos nuevos/modificados
  ANTES de declarar los gates, no después.
