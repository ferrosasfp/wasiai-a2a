# Auto-Blindaje — 187 / fix-pack AR-profundo P0 money-path (FIX 1-4)

### [2026-07-26 02:52] Wave 1 — el colapso "namespace completo" rompió una expectativa pinneada Y habría cambiado la API pública
- **Error**: primera implementación de FIX 1(a) colapsó TODO el namespace avalanche a `'avalanche'` (`getChainNamespace(chainKey) === 'avalanche' ? 'avalanche' : chainRaw`). El test `payment-spec-reader.test.ts:38` ("chain EVM reconocida (avalanche-fuji) pass-through") pasó a fallar: `'avalanche-fuji'` → `'avalanche'`.
- **Causa raíz**: tomar la regla más simple sin evaluar QUIÉN lee el valor de salida. `Agent.payment.chain` no es interno: se expone en las respuestas de `/discover` (lo consumen wasiai-v2 / Chaski / los remit-*). Cambiar `'avalanche-fuji'` → `'avalanche'` era un cambio de API observable, fuera del objetivo del fix (el bypass de dinero real).
- **Fix**: regla mínima y namespace-aware sobre el `ChainKey` normalizado (`collapsesToLegacyAvalanche`): colapsan (1) TODO alias que resuelve a `avalanche-mainnet` (cierra el bypass de `43114`) y (2) el literal legacy `'avalanche-testnet'` (byte-identidad). El resto de los alias testnet quedan pass-through — todos normalizan al MISMO `ChainKey`, así que no existe divergencia de destino posible. Cero expectativas existentes modificadas.
- **Aplicar en**: antes de "normalizar mejor" un campo, grepear si ese campo sale por HTTP. Un fix de seguridad no necesita cambiar strings que ya tienen destino único.

### [2026-07-26 02:54] Wave 2 — test del gate mainnet escrito contra una chain sin bundle en el mock
- **Error**: `T-FIX1B-2` incluía `kite-mainnet` / `2366` en el loop y falló: el log real fue `CHAIN_NOT_SUPPORTED`, no `MAINNET_NOT_ALLOWED`.
- **Causa raíz**: el mock del registry (`downstream-payment.test.ts`) sólo inicializa bundles para las chains que declaro en `CHAIN_IDS`; agregué `avalanche-mainnet`/`base-mainnet` pero no kite. El guard preexistente de bundle corre ANTES del gate nuevo, así que la chain nunca llegaba a evaluarse.
- **Fix**: el loop ejercita las mainnets que SÍ tienen bundle (el caso peligroso real: chain soportada + inicializada). Comentario en el test explicando que una mainnet no inicializada ya corta antes.
- **Aplicar en**: cuando se agrega un guard nuevo en una cadena de guards, el test tiene que dejar pasar TODOS los guards anteriores; si no, se está testeando el guard viejo y el nuevo queda sin cobertura (falso verde).

### [2026-07-26 02:50] Wave 0 — riesgo evitado: duplicar el clasificador de mainnet
- **Error potencial (no cometido)**: escribir `chainKey.endsWith('-mainnet')` inline en `downstream-payment.ts` porque `isMainnetChainKey` vivía en `settle-verifier.ts`, que arrastra viem + `deposit-verifier` + los 4 chain-factories (import pesado en un módulo del hot-path, y riesgo de romper el mock de `viem` del test).
- **Causa raíz**: el clasificador estaba en el módulo equivocado. Es una función PURA sobre el `ChainKey` (invariante WKH-144 documentado en `types.ts`), no algo del verificador on-chain.
- **Fix**: el cuerpo se movió a `chain-resolver.ts` (módulo puro, sólo importa tipos) y `settle-verifier.ts` lo re-exporta sin cambios → un solo clasificador, cero imports nuevos pesados, y el test de invariante WKH-150 (que lo importa desde `settle-verifier`) sigue verde. Un test nuevo cross-checkea que ambas rutas de import son la MISMA función.
- **Aplicar en**: si un helper puro hace falta en dos capas, moverlo a la capa pura y re-exportar. Nunca copiar la regla — un clasificador de mainnet duplicado que divergen es un incidente de dinero real.
