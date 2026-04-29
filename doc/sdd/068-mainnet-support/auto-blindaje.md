# Auto-Blindaje — 068 Mainnet Support (Kite + Avalanche C-Chain)

Errores detectados durante la implementación del soporte mainnet
env-gated para Kite (chainId 2366) y Avalanche C-Chain (chainId 43114).

---

## [2026-04-28 23:30] W1 — Lint warning useOptionalChain en buildClients

- **Error**: biome reportó `lint/complexity/useOptionalChain` en
  `if (!pk || !pk.startsWith('0x')) return null;`.
- **Causa raíz**: TypeScript / biome prefiere `pk?.startsWith('0x')` que
  es semánticamente equivalente y más conciso cuando `pk` puede ser undefined.
- **Fix**: reemplazar por `if (!pk?.startsWith('0x')) return null;`. Cambio
  trivial, mismo comportamiento.
- **Aplicar en**: cualquier guard pattern `!x || !x.method(...)` donde `x`
  es opcional — usar optional chain.

## [2026-04-28 23:32] W1 — Backward-compat alias innecesarios en kite payment.ts

- **Error**: el primer pass dejó `KITE_NETWORK = KITE_TESTNET_NETWORK` y
  `DEFAULT_PAYMENT_TOKEN = DEFAULT_PAYMENT_TOKEN_TESTNET` como aliases
  "por compatibilidad con tests existentes", pero los tests no los importan
  directamente — sólo invocan métodos del adapter (`getNetwork()`,
  `getToken()`, etc.).
- **Causa raíz**: anti-pattern defensivo. Los aliases agregan ruido, hacen
  que dos nombres signifiquen lo mismo y postergan el cleanup.
- **Fix**: eliminar los aliases, reemplazar usos por las constantes
  canónicas o por las funciones `getKiteNetworkTag()` /
  `getDefaultPaymentToken()`. Verificación: `grep -n KITE_NETWORK src/`
  retorna sólo el comentario de doc + nombre de env-var.
- **Aplicar en**: refactors futuros — preferir reemplazo directo en lugar
  de aliasing cuando los consumidores son internos al módulo.

## [2026-04-28 23:33] W1 — chainId getter dinámico requerido en KiteOzonePaymentAdapter

- **Error**: el cambio de `readonly chainId = 2368` a un getter `get
  chainId()` rompería tests que comparan `adapter.chainId === 2368`. Al
  evaluar el primer test mainnet, descubrí que el field readonly no se
  re-evalua cuando cambia `KITE_NETWORK`.
- **Causa raíz**: `readonly chainId = 2368` se asigna UNA vez en el
  constructor — un cambio del env-var no se refleja. Esto es lo que
  buscamos para tests, pero rompe el caso mainnet activado vía env.
- **Fix**: convertir a getter `get chainId(): number { return getKiteChain().id; }`.
  Los tests existentes (chainId === 2368 con env por default) siguen
  pasando porque `getKiteChain()` retorna `kiteTestnet` cuando
  `KITE_NETWORK` está ausente o no es `mainnet`.
- **Aplicar en**: cualquier propiedad de adapter/service que dependa de
  un env-var dinámico — preferir getter sobre field readonly.

## [2026-04-28 23:34] W1 — biome auto-fix lint/format de tests

- **Error**: biome `--write` reordenó imports en
  `downstream-payment.mainnet.test.ts` (de `vitest, viem` a `viem, vitest`,
  alfabético) y reformateó `payment.mainnet.test.ts` (saltos de línea).
- **Causa raíz**: las reglas `assist/source/organizeImports` y `format`
  son correctas — los archivos nuevos no respetaban el style de la repo.
- **Fix**: dejar que biome auto-aplique los fixes (es un cleanup
  estilístico, no funcional). Verificar que tests siguen pasando post-fix.
- **Aplicar en**: SIEMPRE correr `npx biome check --write src/<files>`
  después de crear archivos nuevos, antes del commit.
