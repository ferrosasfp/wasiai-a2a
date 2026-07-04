# Auto-Blindaje — HU-090 / WKH-090 (rail Tempo/MPP)

### [2026-07-04] Wave 0 — Extender ChainKey rompe consumidores exhaustivos fuera de Scope IN
- **Error**: `npx tsc --noEmit` falló con 4 errores tras extender la unión
  `ChainKey` con `'tempo-testnet'` (W0.1). Los archivos afectados NO estaban en
  el Scope IN del Story File:
  - `src/lib/downstream-payment.ts` L46 (TS2741): `RPC_ENV_BY_CHAIN:
    Record<ChainKey, string>` es un mapa exhaustivo → faltaba la key nueva.
  - `src/adapters/deposit-verifier.ts` L67/L145/L166 (TS2366): tres `switch`
    exhaustivos sobre `ChainKey` que retornan un tipo sin `undefined`
    (`resolveChainFamilyEnvSuffix`, `resolveRpcFallbackEnv`, `resolveChainObject`).
- **Causa raíz**: el Story File / SDD afirmaba que la extensión de `ChainKey`
  era "SOLO type, cero efecto runtime". Es cierto en runtime, pero a nivel de
  compilación una unión cerrada tiene consumidores exhaustivos (`Record<ChainKey,
  T>` y `switch` sin `default`/return final) que dejan de compilar al agregar
  un miembro. El Architect no listó estos consumidores en el Scope IN.
- **Fix**: agregar el caso `'tempo-testnet'` a cada consumidor exhaustivo con
  valores consistentes y env-driven (nombres de env que usa el propio adapter:
  `TEMPO_TESTNET_RPC_URL` / `TEMPO_TESTNET_RPC_URL_FALLBACK`; family suffix
  `'TEMPO'`; chain object `getTempoChain('testnet')`). **Runtime byte-idéntico
  con flag OFF**: con `TEMPO_ADAPTER_ENABLED != 'true'` el rail nunca inicializa
  un bundle, así que las rutas de depósito devuelven `CHAIN_NOT_SUPPORTED` en el
  double-guard ANTES de llegar a estos resolvers → los casos nuevos son dead code
  apagado. Ninguna lógica de settle/negocio cambia.
- **Aplicar en**: cualquier futura extensión de `ChainKey` (p.ej. HU-090b si
  agregara mainnet, prohibido por CD-2) debe buscar TODOS los `Record<ChainKey,
  ...>` y `switch(chainKey)` con `grep` antes de asumir "solo type". El Scope IN
  del Story File debe incluir `src/lib/downstream-payment.ts` y
  `src/adapters/deposit-verifier.ts` como consumidores forzados.
