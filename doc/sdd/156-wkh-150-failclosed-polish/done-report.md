# Report — HU [WKH-150] [WKH-144b] Polish del fail-closed mainnet

**Status**: DONE
**Fecha cierre**: 2026-07-06
**Veredicto**: APROBADO

## Resumen ejecutivo

WKH-150 es un follow-up chico (no-bloqueante) de WKH-144 que cierra 2 refinamientos dejados por AR/CR:

1. **Corrección de mensajes engañosos en log** (`fee-split.ts:461-466`, `compose.ts:972-976`): el log "trusting facilitator" se emitía también cuando la respuesta era rechazada (`ok:false`, fail-closed mainnet), contradiciendo la lógica de bloqueo que seguía líneas después. Se corrigió SOLO el texto del log (ternario: `ok ? 'trusting' : 'REJECTING (fail-closed mainnet)'`), cero cambio de decisión de negocio.

2. **Guard preventivo del invariante mainnet** (`types.ts:124-133`, `settle-verifier.test.ts:527-534`): se documentó vía JSDoc el invariante de seguridad del cual depende `isMainnetChainKey()` (todo slug mainnet DEBE terminar en `-mainnet`) y se agregó un test no-tautológico que cruza los 7 `ChainKey` contra el booleano `.testnet` de los objetos viem `Chain` (fuente independiente), cazando regresos silenciosos si una chain mainnet futura viola la convención.

**Resultado**: Testnet byte-idéntico. Mainnet ahora reporta RECHAZO en los logs (verdadero). Guard compile-time + runtime previene WKH-144 abierto en silencio.

**Archivos**: `fee-split.ts` (5 líneas), `compose.ts` (5 líneas), `types.ts` (10 líneas JSDoc), `settle-verifier.test.ts` (8 tests nuevos). Total: +78 líneas, cero lógica de negocio tocada.

---

## Pipeline ejecutado

| Fase | Status | Gates | Notas |
|------|--------|-------|-------|
| **F0** | DONE | — | Codebase grounding (WKH-144 ya DONE 2026-07-04, merge `52fff09`). Log call-sites identificados (2 lugares). Fuente independiente para test encontrada (viem Chain objects). |
| **F1** | DONE | `HU_APPROVED` | Work item + ACs EARS completado 2026-07-04. 2 ACs con 7 sub-criterios verificables. DT-3: shape textual exacto de logs decidido en F2 (Architect). |
| **F2** | DONE | `SPEC_APPROVED` | SDD delegado a Architect (arquitectura del test, wording exacto del log). No generado como `.md` separado — es un change-request de WKH-144 (scope muy chico). |
| **F2.5** | DONE | — | Story File no requerido (patch-style, +78 líneas). Scope explicado en el work-item SDD implícito. |
| **F3** | DONE | — | Implementación en 1 wave: 4 archivos, 78 líneas netas (2 correcciones de log, 1 JSDoc, 8 tests nuevos). Dev (WKH-144 flow): fee-split.ts y compose.ts modificados vía ternarios. settle-verifier.ts exportó `isMainnetChainKey` (necesario para test). Test nuevo en settle-verifier.test.ts con `Record<ChainKey, Chain>` exhaustivo. |
| **AR** | PASSED | — | Adversarial Review: 0 findings. CD-1 verificado (integridad de decisión), CD-5 verificado (tests preexistentes intactos). |
| **CR** | PASSED | — | Code Review: 1 NIT cosmético (no bloqueante). `!chain.testnet` vs `chain.testnet !== true` en el test — puramente estético, no afecta comportamiento. Diferido a backlog/ignore. |
| **F4** | PASSED | — | Validation (QA): APROBADO PARA DONE. Todos los ACs PASS con evidencia archivo:línea. tsc 0, biome 0, vitest 2766 tests (39/39 settle-verifier.test.ts: 31 preexistentes WKH-144 + 8 nuevos). Drift único: export de `isMainnetChainKey` (necesario, aceptable). |

---

## Acceptance Criteria — resultado final

| AC | Sub-AC | Status | Evidencia |
|----|--------|--------|-----------|
| AC-1 | 1a (fee-split.ts log) | PASS | `fee-split.ts:461-466`: `log.warn(..., reVerified.ok ? 'split leg settle re-verify unavailable, trusting facilitator' : 'split leg settle re-verify unavailable — REJECTING facilitator response (fail-closed mainnet)')` — ternario condicional en `ok`, zero lógica de negocio tocada (`markLegFailed` en línea 468 intacto). |
| AC-1 | 1b (compose.ts log) | PASS | `compose.ts:972-976`: misma forma ternaria, string "REJECTING facilitator confirmation (fail-closed mainnet)" cuando `ok:false`. Lógica `throw` en línea 979 intacta. |
| AC-1 | 1c (testnet preservado) | PASS | Testnet branch (`reVerified.ok === true`) preserva byte-idéntico el texto original: `'split leg settle re-verify unavailable, trusting facilitator'` (fee-split.ts:464) y `` `...trusting facilitator confirmation` `` (compose.ts:974). Diff confirma: ninguna línea de ese branch fue tocada. |
| AC-2 | 2a (JSDoc invariante) | PASS | `types.ts:124-133` — docblock "⚠️ SECURITY INVARIANT (WKH-150 / WKH-144)" explica: (a) todo slug mainnet termina en `-mainnet`, (b) violación abre WKH-144 a fail-open con plata real, (c) `isMainnetChainKey()` depende de eso. Referencia a archivos: `settle-verifier.ts:196-199` (`isMainnetChainKey`), `compose.ts` y `fee-split.ts` (lógica fail-closed). |
| AC-2 | 2b (test no-tautológico) | PASS | `settle-verifier.test.ts:527-534` — `it.each` que recorre 7 `ChainKey` y valida: `isMainnetChainKey(key) === !chainObject.testnet`. Objetos viem importados de fuentes independientes: `avalanche`/`avalancheFuji` de `viem/chains`, `base`/`baseSepolia` de `viem/chains`, `kiteMainnet`/`kiteTestnet` de `src/adapters/kite-ozone/chain.ts`, `tempoTestnet` de Tempo. Resultado: 8 tests nuevos verdes (7 it.each + 1 cross-check `mainnetByGate === mainnetByViem`). |
| AC-2 | 2c (exhaustividad compile-time) | PASS | Mecanismo `Record<ChainKey, Chain>` — si un `ChainKey` nuevo se agrega al union sin mapeo en el test, `tsc` falla con `TS2741 Property '"<newKey>"' is missing`. Verificado independientemente: omitir un miembro produce error compile-time, no skip silencioso. AC-2c cubierto. |

---

## Hallazgos finales

| Categoría | Resultado |
|-----------|-----------|
| **BLOQUEANTEs** | 0. AR/CR pasados sin bloqueos. Ningún defecto de seguridad ni regresión de lógica de negocio. |
| **MENOREs** | 1 NIT cosmético en CR (`!chain.testnet` vs `chain.testnet !== true`). Código correcto; es preferencia de estilo. Diferido a backlog (no bloquea DONE). |
| **Deuda técnica** | DT-6 de WKH-144 (nonce anti-replay `x402-nonce.ts`) permanece OUT scope, sin cambios — no relevante para WKH-150. |

---

## Auto-Blindaje consolidado

### [2026-07-06 18:45] Wave 0 — `SUPPORTED_CHAINS` no está exportado

**Error**: AC-2b pide iterar `SUPPORTED_CHAINS` (registry.ts:28) para exhaustividad, pero está NO exportado y es un subconjunto (6 slugs; `tempo-testnet` se agrega dinámicamente).

**Causa raíz**: Importar `SUPPORTED_CHAINS` obligaría tocar `registry.ts` = PROHIBIDO por scope OUT. Conflicto entre requisito de test y restricción de scope.

**Fix aplicado**: Usar `Record<ChainKey, Chain>` en el test. La fuente canónica es el union `ChainKey` (F0 #2 del work-item WKH-150), del cual `SUPPORTED_CHAINS` es un subconjunto. `Record<ChainKey, X>` da exhaustividad **en compile-time** (más fuerte que runtime check), sin tocar `registry.ts`. Cubre los 7 slugs (incluye `tempo-testnet`).

**Aplicación futura**: Cualquier test futuro que deba "recorrer todas las chains" debe preferir `Record<ChainKey, X>` (exhaustividad de tipos) sobre importar `SUPPORTED_CHAINS` (no exportado + incompleto por feature-flag).

---

### [2026-07-06 18:45] Wave 0 — biome fuerza estilo propio de `it.each`

**Error**: `biome check` marcó formato incorrecto en `it.each(cases)('...', fn)`.

**Causa raíz**: Convención de line-break de biome para llamadas encadenadas (no es estándar).

**Fix aplicado**: `biome check --write` (autofix); sin cambio semántico. Nota: `npx biome` se rompe bajo hook RTK ("could not determine executable") — hay que usar binario directo `./node_modules/.bin/biome`.

**Aplicación futura**: Correr `./node_modules/.bin/biome check --write <archivo>` antes del gate en cualquier test nuevo con `it.each`. No usar `npx biome` directamente en sesiones con RTK activo.

---

## Archivos modificados (summary)

```
src/services/fee-split.ts        +3 líneas (ternario en log warn)
src/services/compose.ts          +3 líneas (ternario en log warn)
src/adapters/types.ts            +10 líneas (JSDoc sobre invariante -mainnet)
src/adapters/settle-verifier.ts  +1 línea (export isMainnetChainKey — necesario para test)
src/adapters/settle-verifier.test.ts  +61 líneas (8 tests nuevos, Record<ChainKey, Chain>)
```

**Total**: +78 líneas, 0 lógica de negocio tocada, 0 cambio de comportamiento testnet.

---

## Decisiones diferidas a backlog

Ninguna. Las únicas decisiones técnicas (DT-1, DT-2, DT-3) fueron resueltas en F2 (Architect). El NIT cosmético (CR) queda ignorado.

---

## Lecciones para próximas HUs

1. **Invariantes de seguridad negativas son frágiles sin guard automático.** WKH-144 dejó un naming convention (`-mainnet`) SIN verificación de exhaustividad. WKH-150 cierra el gap con `Record<ChainKey, X>` (compile-time, no runtime). Patrón: toda convención de seguridad crítica debe tener un test que compare contra una fuente INDEPENDIENTE (viem, contrato on-chain, etc.), no circular.

2. **Logs en el path de decisión pueden ser más dañinos que silencio.** El log "trusting facilitator" en mainnet fail-closed fue PEOR que no registrar nada — operadores podrían confiar en que el facilitator fue verificado cuando en realidad fue rechazado. En futuro: mantener los logs alineados con la decisión que sigue (ej. "REJECTING" antes de `throw`/`markLegFailed`, "trusting" solo si `ok:true`).

3. **`Record<ChainKey, X>` > importar constantes non-exported.** Para garantizar exhaustividad de tipos en un union literal fijo, mapear explícitamente el tipo (`Record`) es más robusto que iterar una const que puede cambiar sin actualizar el tipo. El compilador lo fuerza.

4. **biome.check --write requiere binario directo bajo RTK.** Hook RTK intercepta `npx` → "could not determine executable". Workaround: `./node_modules/.bin/biome check --write <archivo>`. Documentar en onboarding si RTK se vuelve parte del workflow estándar.

---

## Gates finales

- **tsc --noEmit**: 0 errores
- **npm run lint** (biome): 0 warnings
- **npx vitest run**: 2766 tests passed (vs baseline esperado). settle-verifier.test.ts: 39/39 pass (31 preexistentes WKH-144 + 8 nuevos WKH-150).
- **Drift**: Solo export de `isMainnetChainKey` en settle-verifier.ts (necesario, aceptable).

---

## Validación de completitud

- [x] AC-1a: fee-split.ts log condicionado a `ok`
- [x] AC-1b: compose.ts log condicionado a `ok`
- [x] AC-1c: testnet 100% preservado
- [x] AC-2a: JSDoc invariante en `ChainKey`
- [x] AC-2b: test no-tautológico contra Chain.testnet
- [x] AC-2c: exhaustividad compile-time (`Record<ChainKey>`)
- [x] CD-1: lógica de negocio intacta
- [x] CD-2: testnet byte-idéntico
- [x] CD-3: test no-circular (viem vs naming)
- [x] CD-4: test cubre todos los 7 `ChainKey`
- [x] CD-5: tests preexistentes no rotos (39/39 pass)
- [x] CD-6: logs no logguean secrets

**LISTO PARA DONE.**
