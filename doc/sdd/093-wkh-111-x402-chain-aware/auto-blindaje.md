# Auto-Blindaje — #093 [WKH-111] x402 chain-aware

Registro de errores cometidos durante la implementación F3 y sus fixes.
Sirve para blindar futuras HUs del mismo error.

---

### [2026-05-27 13:10] Wave 1 — Ripple effect del refactor sync→async + nueva superficie del registry mock

- **Error**: tras W1, 9 tests legacy rompieron (1039 baseline → 9 fail / 1039 pass).
  Tres archivos afectados:
  - `src/middleware/x402.passport-shape.test.ts` (4 tests) — 500 en vez de 200/402
  - `src/routes/registries.test.ts` (3 tests) — 500 en vez de 401/402/403
  - `src/__tests__/e2e/e2e.test.ts` (2 tests) — 500 en vez de 402
- **Causa raíz**: `requirePayment` ahora resuelve un `chainKey` por request llamando
  `getDefaultChainKey()` + `getAdaptersBundle()` + `getInitializedChainKeys()` del
  registry. Esos tres archivos mockean `../adapters/registry.js` con un `vi.mock`
  que **predata esta HU** y solo exporta `getPaymentAdapter` (+ algunos otros). Las
  nuevas funciones devolvían `undefined` desde el mock incompleto → mi guard de
  `getDefaultChainKey()` (null) disparaba `REGISTRY_NOT_INITIALIZED` 500, o el guard
  `if (!bundle)` disparaba 400. Era exactamente el "ripple effect en async refactor"
  anticipado en el Story File (lección WKH-67/072 W4).
- **Fix**: extender cada `vi.mock('.../adapters/registry.js')` para exportar
  `getDefaultChainKey: () => 'kite-ozone-testnet'`,
  `getAdaptersBundle: () => ({ chainConfig: { chainId: 2368 } })` y
  `getInitializedChainKeys: () => ['kite-ozone-testnet']`. Eso reproduce el path
  default (sin header → Kite) byte-idéntico, así los tests legacy vuelven a 402/200.
  NO se tocó código de producción para esto (CD-1 intacto). NO se tocaron archivos del
  Out of Scope (`a2a-key.ts`, `registry.ts`, adapters, smoke).
- **Aplicar en**: cualquier futura HU que agregue una nueva función al registry
  consumida por un middleware compartido (`x402.ts`, `a2a-key.ts`). Antes de mergear,
  `grep -rn "vi.mock('.*adapters/registry" src/` y verificar que TODOS los mocks
  exporten la nueva función — un mock incompleto devuelve `undefined` silencioso y
  rompe el guard de fail-loud. Resultado final: 1048 tests verdes (1039 + 9 nuevos).

---

### [2026-05-27 13:08] Wave 0 — `tsc --noEmit` pelado reporta TS6059 (rootDir) preexistente

- **Error**: `tsc --noEmit` (tsconfig por defecto) reporta TS6059 sobre
  `test/fixtures/passport-shape.ts` ("not under rootDir './src'").
- **Causa raíz**: NO es un error introducido por esta HU. El tsconfig por defecto
  incluye `src/**/*` con `rootDir: ./src`, pero los tests (`x402.passport-shape.test.ts`,
  preexistente en `main`) importan fixtures desde `test/fixtures/`, fuera de rootDir.
  Es una condición de baseline del repo, no una regresión.
- **Fix**: el typecheck autoritativo de producción es `tsc -p tsconfig.build.json`
  (lo que usa `npm run build`), que excluye `src/**/*.test.ts` y `__tests__`. Ese
  pasa LIMPIO antes y después de la HU. Mi nuevo test `x402.chain-aware.test.ts`
  importa el mismo fixture de la misma forma que el exemplar → misma categoría de
  warning preexistente, cero errores nuevos. Vitest (esbuild) resuelve el import sin
  problema en runtime; los 1048 tests pasan.
- **Aplicar en**: usar `tsc -p tsconfig.build.json --noEmit` como verificación de
  typecheck de producción en este repo. El `tsc --noEmit` pelado mezcla tests +
  rootDir y produce ruido TS6059 preexistente que no es accionable a nivel HU.
