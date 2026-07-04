# Auto-Blindaje — WKH-138 v1 (gasless Avalanche/Base, EIP-3009 operator-relayed)

Registro de errores cometidos durante la implementación F3 y su fix. Protege
futuras HUs del mismo error.

---

### [2026-07-04 01:12] Wave 1b — Public client de Base no asignable al cache module-level
- **Error**: `tsc --noEmit` falló en `base/gasless.ts` con TS2322 al asignar
  `_publicClientMainnet = createPublicClient({ chain: getBaseChain(network) })`.
  El tipo del client concreto (con la `chain` de Base tipada) no es asignable a
  `ReturnType<typeof createPublicClient>` (generic, `account: undefined`).
- **Causa raíz**: Base es una chain OP-stack; su tipo agrega un tx type
  `deposit` que hace incompatible el `getBlock()` del public client concreto con
  el genérico del cache. Avalanche NO tiene ese tx type, por eso su gasless
  adapter compiló sin cast.
- **Fix**: castear la chain a `Chain` genérico SOLO en el `createPublicClient`
  de Base — `const baseChain = getBaseChain(network) as Chain;` — mismo patrón
  que `erc8004-reputation-writer.ts:140,155`. El wallet client de Base NO
  necesita el cast (no expone `getBlock`).
- **Aplicar en**: cualquier `createPublicClient` cacheado en variable
  module-level tipada `ReturnType<typeof createPublicClient>` para una chain
  OP-stack (Base, Optimism). Castear la chain a `Chain`.
