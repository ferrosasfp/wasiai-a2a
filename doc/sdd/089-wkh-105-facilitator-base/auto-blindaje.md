# Auto-Blindaje — WKH-105 (BASE-02)

Errores y descubrimientos durante F3 (implementación Dev), pipeline FAST+AR.

---

### [2026-05-19 12:25] Wave 1 — Hipótesis DT-5 del work-item incorrecta para Base Sepolia

- **Error**: El work-item DT-5 asumió EIP-712 domain `name="USD Coin"` para AMBAS chains Base (sepolia + mainnet). Si hubiera codeado contra esa hipótesis sin verificar, `recoverTypedDataAddress` habría fallado silenciosamente en Sepolia (devolviendo addr distinta a `from` → `INVALID_SIGNATURE` siempre).
- **Causa raíz**: Circle deployó el contrato testnet de USDC en Base Sepolia con el `name()` view function devolviendo el literal `"USDC"` (símbolo), NO `"USD Coin"` (nombre comercial). El contrato mainnet sí usa `"USD Coin"`. Es un detalle no documentado en docs.circle.com.
- **Fix**: Verifiqué con `cast call <addr> "name()(string)" --rpc-url https://sepolia.base.org` antes de codear. Resultado:
  - Base Sepolia USDC (`0x036C…F7e`): `name="USDC"`, `version="2"`
  - Base Mainnet USDC (`0x8335…913`): `name="USD Coin"`, `version="2"`

  El adapter encodea las dos variantes separadas (constants `USDC_BASE_SEPOLIA` y `USDC_BASE_MAINNET`) y la fixture de test `makeBaseSepoliaVerifyParams` también usa el domain correcto (`name='USDC'`). El boot-time `initDomainCheck` (WFAC-53) detectaría drift en boot real si esto regresionara.

- **Aplicar en**: Cualquier nueva chain adapter debe verificar EIP-712 `name()` Y `version()` ON-CHAIN (`cast call`) antes de hardcodear el domain. Documentar el resultado en el header del archivo del adapter para QA/futuros lectores. NO confiar en docs de SDK o hipótesis.

---

### [2026-05-19 12:27] Wave 2 — Registro en `index.ts`, NO en `registry.ts`

- **Error**: El work-item original (línea 49) decía modificar `src/chains/registry.ts` para agregar branches Base. Casi caigo en esa indicación literal.
- **Causa raíz**: El work-item original asumía un design pattern de "registry con branches" (factory). La corrección post-F1 del orquestador ya advertía sobre esto pero no era explícita sobre `index.ts`. El patrón real es: `registry.ts` es un singleton `Map`-based + métodos generic `.register()`; el registro REAL de adapters por chain se hace en `src/chains/index.ts` (módulo side-effect).
- **Fix**: Modifiqué `src/chains/index.ts` agregando `import { baseSepoliaAdapter, baseMainnetAdapter } from './base.js'` + dos líneas `if (adapter !== null) chainRegistry.register(adapter)`. `registry.ts` queda intacto.
- **Aplicar en**: Cualquier nueva chain — siempre `src/chains/index.ts` para la línea de registro. NUNCA tocar `registry.ts` por agregar una chain (solo si cambia el contrato del registry mismo).

---

### [2026-05-19 12:28] Wave 1 — Native currency de Base es ETH, NO un token L2 custom

- **Error potencial (no cometido)**: Casi copio `nativeCurrency: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 }` del exemplar avalanche.ts. Base es un Ethereum L2 — su native gas token es ETH.
- **Fix**: Inline en `BaseAdapter.constructor`: `nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }`. Test `uses ETH as native currency (Base is an Ethereum L2)` valida.
- **Aplicar en**: Cuando se agrega una L2 OP-stack-based (Optimism, Zora, Mode), su gas token es ETH, no un token L2 propio. Verificar con `viem/chains` def: `chain.nativeCurrency` siempre es la fuente de verdad.

---

### [2026-05-19 12:32] Wave 3 — Patrón de test: `make…VerifyParams` debe usar el domain DE LA CHAIN, no del exemplar

- **Error potencial (no cometido)**: La fixture `makeValidVerifyParams` de `chain-adapter.test.ts` usa el domain PYUSD/Kite (`name='PYUSD' v1 chainId=2368`). Si la copiaba literal cambiando solo nombres, habría usado el domain Kite contra el adapter Base → `INVALID_SIGNATURE` siempre.
- **Fix**: Creé fixture dedicada `makeBaseSepoliaVerifyParams` con domain Base Sepolia correcto (`name='USDC' v2 chainId=84532`). El test happy-path `verify returns ok with recovered client (AC-1 happy path)` valida que la firma se recupera correctamente.
- **Aplicar en**: Cuando un test reusa una fixture cross-chain, verificar siempre que el `domain.chainId` + `verifyingContract` + `name` + `version` coincidan con el adapter bajo test. Es trivial confundir esto en un copy-paste y el síntoma (siempre `INVALID_SIGNATURE`) parece un bug del adapter, no del test.
