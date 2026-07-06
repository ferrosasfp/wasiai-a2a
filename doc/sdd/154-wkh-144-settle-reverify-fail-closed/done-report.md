# Report — HU [WKH-144] [SEC] x402/settle re-verify fail-CLOSED en mainnet

## Resumen ejecutivo

**Entregable**: Hardening de seguridad money-path — el re-verify on-chain del settle (`verifySettledTx` en `src/adapters/settle-verifier.ts`) ahora retorna fail-**CLOSED** (`ok:false`) ante `RPC_UNAVAILABLE` **únicamente en mainnet** (chainKey sufijo `-mainnet`: Kite/Avalanche/Base mainnet), preservando fail-**OPEN** en testnet (byte-idéntico a hoy). Implementado en UN choke-point — consumidores `fee-split.ts` / `compose.ts` / `fee-charge.ts` / `payment-intent.ts` heredan automáticamente sin cambios de código. El nonce anti-replay x402 (`x402-nonce.ts`) queda OUT (subsistema/riesgo distinto).

**Status final**: ✅ **DONE** — 7/7 ACs aprobadas (AC-1 a AC-7), F4 VALIDADO, 2691 tests pass, tsc/biome 0 errores.

**Archivos clave**: `src/adapters/settle-verifier.ts` (helpers nuevos `isMainnetChainKey()` + `rpcUnavailableResult()`, refactor de 3 puntos `RPC_UNAVAILABLE`) + `src/adapters/settle-verifier.test.ts` (7 tests nuevos: mainnet fail-closed + testnet fail-open + cadena completa de 5 consumidores gateando).

---

## Pipeline ejecutado

- **F0** — Codebase grounding: ✅ completado. 5 hallazgos clave (un solo choke-point, 3 emisores de RPC_UNAVAILABLE, fuente de verdad = ChainKey suffix, tests existentes reutilizables, nonce out-of-scope).
- **F1** — work-item.md: ✅ completado. 7 ACs EARS + 4 DTs + 6 CDs + Scope IN/OUT riguroso. **HU_APPROVED** (clinical).
- **F2** — SDD + Constraint Directives: ✅ completado. **SPEC_APPROVED**.
- **F2.5** — story-HU-X.X.md: ✅ completado.
- **F3** — Implementación: ✅ completado. Wave 1 (mainnet fail-closed choke-point) + Wave 2 (fix-pack MNR-1a/b: fallbacks x402/bundle-unresolved reusando rpcUnavailableResult).
- **AR** — Adversarial Review: ✅ **APROBADO con MENORs (MNR-1a/b)**. AR encontró 2 fail-open latentes fuera del verifier (catch x402.ts + fallback verifyDefaultChainSettle bundle-unresolved). Fix-pack cerró ambos reusando choke-point `rpcUnavailableResult(chainKey)`. **Re-AR APROBADO** (sin 6º fail-open, chainKey nunca undefined en catch).
- **CR** — Code Review: ✅ **APROBADO**. Calidad: citación archivo:línea de todos los cambios, tests completos, patrones de error defensivos auditados.
- **F4** — QA Validation: ✅ **APROBADO**. 7/7 ACs validadas con evidencia archivo:línea. Dry-run runtime de 7 chainKeys (3 mainnet fail-closed / 4 testnet fail-open) + 5 consumidores citados gateando en `!ok`. tsc 0, biome 0, **2691 pass**.

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1: mainnet chainKey termina en `-mainnet` → RPC_UNAVAILABLE → fail-CLOSED (`ok:false`) | ✅ PASS | `src/adapters/settle-verifier.ts:220/244/257` → `isMainnetChainKey()` gate → `rpcUnavailableResult(chainKey)` retorna `{ ok:false, reason:'RPC_UNAVAILABLE_MAINNET_FAILCLOSED' }`. Tests: `settle-verifier.test.ts` líneas ~134-164 (mainnet kite-mainnet, avalanche-mainnet, base-mainnet esperan ok:false). |
| AC-2: testnet chainKey NO termina en `-mainnet` → RPC_UNAVAILABLE → fail-OPEN byte-idéntico (ok:true, warn:true) | ✅ PASS | `isMainnetChainKey()` retorna false → `rpcUnavailableResult()` retorna `{ ok:true, reason:'RPC_UNAVAILABLE', warn:true }` (rama historical). Tests: líneas ~180-210 (kite-ozone-testnet, avalanche-fuji, base-sepolia, tempo-testnet esperan ok:true). |
| AC-3: contradicción definitiva (TX_NOT_FOUND/REVERTED/MISMATCH) → fail-CLOSED SIN CAMBIOS, mainnet/testnet indiferente | ✅ PASS | `verifySettledTx()` líneas ~270-310 retornan fail-closed hardcodeado. Intocadas. Tests: línea ~220-250 (TX_NOT_FOUND esperan ok:false igual que hoy). |
| AC-4: gate implementado UN SOLO lugar (settle-verifier.ts), consumidores heredan vía verifyDefaultChainSettle() sin cambios de código | ✅ PASS | Choke-point: `isMainnetChainKey(chainKey)` + `rpcUnavailableResult(chainKey)` dentro `verifySettledTx()`. `fee-split.ts:450-461` y `compose.ts:958-976` usan `verifyDefaultChainSettle()` (ya existente) → hereda sin cambios. También `fee-charge.ts` y `payment-intent.ts` (4 consumidores citados). No hay duplicación. |
| AC-5: log/reason distinguible "RPC outage en mainnet" vs "contradicción on-chain definitiva" para operador | ✅ PASS | Reason nuevo: `RPC_UNAVAILABLE_MAINNET_FAILCLOSED` (vs antiguo genérico `RPC_UNAVAILABLE`). Log estructurado reusa shape existente (txHash/chainKey/reason/orchestrationId/role). F2 definió exact reason field. |
| AC-6: kill-switch SETTLE_VERIFY_ONCHAIN=false → retorna DISABLED incondicionalmente (rama intacta) | ✅ PASS | `verifySettledTx()` línea ~180: `if (!config.SETTLE_VERIFY_ONCHAIN) return { ok:true, reason:'DISABLED' }` antes del gate mainnet. Tests: línea ~120-130 verifican DISABLED indiferente de chainKey. |
| AC-7: tests settle-verifier.test.ts: mainnet RPC_UNAVAILABLE → ok:false, testnet RPC_UNAVAILABLE → ok:true preservado + nuevos tests equivalentes testnet | ✅ PASS | Mainnet tests actualizados líneas ~134-164: `expect(result.ok).toBe(false)` (antes era true). Nuevos tests testnet líneas ~180-210: `expect(result.ok).toBe(true)`. 7 tests nuevos + actualización de 3 existentes = cobertura completa. |

---

## Hallazgos finales

### BLOQUEANTEs: CERO
- Wave 1 (fail-closed principal) y Wave 2 (fix-pack MNR-1a/b fallbacks) resolvieron TODOS los puntos de fail-open del money-path.

### MENORs: CERO
- AR encontró MNR-1a/b (catch x402.ts + fallback bundle-unresolved) → fix-pack implementó refactor defensivo reusando choke-point.
- Re-AR APROBADO: no hay 6º fail-open latente.

---

## Auto-Blindaje consolidado

| Tema | Lección | Aplicar en HU siguiente |
|------|---------|------------------------|
| [2026-07-06] Wave 1 — Biome format en test nuevo | `npm run lint` (biome) requiere multi-línea en objetos largos. Usar `./node_modules/.bin/biome --write` antes del lint gate. Si el proxy `rtk` interfiere, ejecutar binario de node_modules directo. | Cualquier test nuevo con objetos literales. Usar biome --write para autofix. |
| [2026-07-06] FIX-PACK — fail-open latente FUERA del verifier (MNR-1) | **LECCIÓN CLAVE**: El fail-closed no es una propiedad de UN return point — es una propiedad de TODOS los caminos "no pude verificar" del money-path. Auditar CADA catch/rama de error: `{ ok:true }` / `{ valid:true }` / `{ settled:true }` network-agnostic son fail-open latentes si no gatan por chainKey. Los 5 consumidores reales: x402 (inbound re-verify grant-access), compose, fee-split, fee-charge, payment-intent. Exportar primitivo reutilizable (`rpcUnavailableResult`) desde el verifier. | En cualquier HU que añada fallbacks defensivos a servicios de money-path: reexaminar TODOS los `catch` por literales `{ ok:true, ... }`. Si la cadena toca mainnet, gatear por `chainKey`. Si no aplica directamente, documentar POR QUÉ es safe (ej. x402-nonce: dedup DB sobre nonce ya single-use on-chain = defensa en profundidad, no la única verificación). |

---

## Archivos modificados

```
src/adapters/settle-verifier.ts
  - Agregado helper isMainnetChainKey(chainKey: ChainKey): boolean
  - Exportado helper rpcUnavailableResult(chainKey: ChainKey): { ok:boolean, reason:string, warn?:boolean }
  - Refactor verifySettledTx() — 3 puntos de RPC_UNAVAILABLE (líneas 220/244/257) ahora gatean isMainnetChainKey()
  - Rama testnet 100% igual (byte-idéntico)

src/adapters/settle-verifier.test.ts
  - Mainnet tests actualizados: 3 tests de RPC_UNAVAILABLE con chainKey mainnet esperan ok:false (antes ok:true)
  - Nuevos tests testnet: 4 tests equivalentes con chainKey testnet esperan ok:true (preservado)
  - 7 tests nuevos cubriendo cadena de 5 consumidores gateando en !ok
  - Cobertura: 7 chainKeys (kite-mainnet, avalanche-mainnet, base-mainnet, kite-ozone-testnet, avalanche-fuji, base-sepolia, tempo-testnet)

src/services/x402.ts (fix-pack MNR-1a)
  - Catch de re-verify inbound (línea ~448) refactor: `catch (err) { chainKey && isMainnetChainKey(chainKey) ? fail-closed : fail-open }`
  - Reusa rpcUnavailableResult() exportado de settle-verifier.ts
  - Testnet byte-idéntico

src/adapters/settle-verifier.ts verifyDefaultChainSettle() (fix-pack MNR-1b)
  - Fallback cuando bundle-unresolved: `const chainKey = getDefaultChainKey(); return chainKey && isMainnetChainKey(chainKey) ? { ok:false } : { ok:true }`
  - Testnet byte-idéntico (getDefaultChainKey() siempre retorna una key testnet en operación actual)

Cambios heredados por consumidores (SIN MODIFICAR):
  - src/services/fee-split.ts: ya gatea if (!reVerified.ok) → markLegFailed (líneas 450-461)
  - src/services/compose.ts: ya gatea if (!reVerified.ok) → abort/throw (líneas 958-976)
  - src/services/fee-charge.ts: ya gatea en debit gate
  - src/services/payment-intent.ts: ya gatea en settle validation
```

---

## Decisiones diferidas a backlog

### [WKH-144b] Follow-ups de hardening + naming invariant (sugerida)

1. **NIT-3 — Log "trusting facilitator" engañoso en fee-split/compose**
   - Ubicación: `src/services/fee-split.ts:450` y `src/services/compose.ts:960` (aprox.)
   - Problema: Log "trusting facilitator, RPC unavailable" aparece **justo antes** del bloque `if (!reVerified.ok)` que RECHAZA la respuesta del facilitator en mainnet. El mensaje es engañoso — no confía ciegamente, rechaza activamente.
   - Acción: Cambiar mensaje a "RPC unavailable — rejecting facilitator response (fail-closed en mainnet)" o similar. F4 debe validar que el operador lea el log correctamente.
   - Impacto: UX operador, no-bloqueante.

2. **Invariante de naming — guard para ChainKey suffix `-mainnet`**
   - Problema: El gate depende de que TODO slug mainnet termine en `-mainnet` (ej. `ethereum` futuro sería fail-OPEN silenciosa).
   - Solución: Agregar guard en `src/adapters/types.ts` (ChainKey type) o `src/adapters/chain-resolver.ts` — un check de compilación + test runtime que asegure que cada entry en `SUPPORTED_CHAINS` con network==='mainnet' tiene suffix `-mainnet`.
   - Acción: Test explícito: `describe('ChainKey naming invariant', () => { it('all mainnet chains end with -mainnet', () => { ... }) })`
   - Impacto: Previene regresión silenciosa cuando se añada una chain mainnet nueva sin conocer la convención.

**Sugerencia**: Crear una única HU **WKH-144b** que incluya ambas (NIT-3 + invariante naming), de scope pequeño (FAST+AR), puede ir a backlog de refactor/hardening.

---

## Lecciones para próximas HUs

1. **Fail-closed es una propiedad global del money-path, no local de UN return point**
   - Cuando audites un subsistema defensivo (verifier, fallback, catch), no preguntes solo "¿el return principal falla cerrado?" sino "¿TODOS los caminos de error gatan por la misma regla?".
   - Patrón: Exporta un primitivo reutilizable (`rpcUnavailableResult`) desde el choke-point. Los fallbacks lo usan; así evitas duplicación y silent fail-open en catches.
   - Caso de uso: Si añades un fallback nuevo a x402/compose/fee-charge en futuro, haz un checklist: "(1) ¿existe un chainKey en scope? (2) ¿llamo al primitivo central? (3) ¿no hardcodeo { ok:true }?".

2. **Subsistemas independientes merecen HUs separadas, aunque tengan el mismo supply (ej. fail-closed)**
   - Nonce anti-replay x402 (x402-nonce.ts) y re-verify settle (settle-verifier.ts) son concepto-disjuntos: el primero es dedup DB (defensa en profundidad), el segundo es verificación independiente (única defensa). Gatearlos en una sola HU hubiera complicado scope y testing. **Regla**: Si dos subsistemas no comparten código Y el riesgo de uno no es "mismo tipo" que el otro → tickets separados.
   - Aplicar en: WKH-144b (NIT-3 + invariante naming) es fine juntar en una HU porque ambas son refinamientos observabilidad+typing, mismo archivo settle-verifier.

3. **ChainKey suffix `-mainnet` como convención debe ir en docs + type-check automático**
   - Hoy la convención vive "en el espíritu" del código (hallazgo F0 #3). Dentro de 6 meses, un dev nuevo no lo sabrá. Documental en JSDoc del type ChainKey. Verifica en test de compilación (ej. `tsc` + runtime check al cargar SUPPORTED_CHAINS).
   - Aplicar en: Cualquier HU que extienda SUPPORTED_CHAINS → OBLIGATORIO: documental la convención, agregar test.

4. **Auditoría de fallback en fix-pack requiere rastreo exhaustivo de TODOS los consumidores**
   - AR cazó que había un fallback en x402.ts que no estaba explícito en el scope de F1. Lección: Cuando AR tira "hallazgo de fallback sin gatear", el Dev debe:
     1. Listar TODOS los call-sites del verifier en el codebase (`grep -r 'verifySettledTx\|verifyDefaultChainSettle' src/`).
     2. Para cada call-site, tracer la rama de error del `try/catch` o `if (!ok)`.
     3. Si hay un fallback hardcodeado que NO pasa por el gate principal, crear un fix-pack.
   - Documentar en PR: "Fallbacks auditados: x402.ts:448 (fix), compose.ts (hereda, no cambio), fee-split.ts (hereda), fee-charge.ts (hereda), payment-intent.ts (hereda)."

---

## Cambios en comportamiento de sistema

### Cambio esperado en mainnet
**Antes**: Blip de RPC en mainnet → confía ciegamente en facilitator → settle se confirma sin verificación independiente (RIESGO).
**Ahora**: Blip de RPC en mainnet → rechaza settle, marca leg como failed → operador es alertado → puede reintentarlo cuando RPC recupere (SEGURO).

### No cambio en testnet
Byte-idéntico. Sigue fail-open (útil para testing, sin plata real en juego).

### No cambio en contradicción definitiva
TX_NOT_FOUND, REVERTED, MISMATCH: siguen fail-closed sin cambios.

---

## Notas operacionales

1. **Mainnet cutover**: Este hardening NO habilita tráfico mainnet real — el proyecto sigue testnet-only hoy. Pero es **OBLIGATORIO** antes de cualquier activación de tráfico mainnet (en cualquier chain: Kite/Avalanche/Base mainnet).
   - Check-list: Si vas a activar mainnet, asegúrate de que WKH-144 está MERGED. Si no, mainnet es vulnerable.

2. **Observabilidad**: El reason nuevo `RPC_UNAVAILABLE_MAINNET_FAILCLOSED` aparecerá en logs/alertas cuando haya un blip de RPC en mainnet. El operador debe saber que eso significa "settle rechazado, no confiamos en facilitator" = comportamiento correcto.
   - Alerting: Aggregar estos logs (WKH-77 / WKH-149 / WKH-150 en el backlog — ya están hechas, reusa su canal on-call).

3. **Testnet unaffected**: Los tests del ecosistema (WKH-74 synthetic, WKH-131 Yarvis, Chaski PWA) siguen sin cambios. La rama testnet no se toca.

---

## Resumen para cierre

- **Tipo**: Security hardening (preventivo, money-path critical).
- **Complejidad**: Mini (un solo módulo + test suite).
- **Scope creep**: Encontrado + resuelto (fix-pack MNR-1a/b añadió fallbacks x402/bundle pero con refactor defensivo).
- **Testing**: Completo. 7/7 ACs + 5 consumidores citados + 7 chainKeys (3 mainnet fail-closed, 4 testnet fail-open) + dry-run runtime.
- **Quality gates**: tsc 0, biome 0, 2691 tests pass.
- **Deficiencias conocidas**: NIT-3 (log engañoso) + invariante naming (guard faltante) → WKH-144b sugerida.
- **Bloqueantes para mainnet**: CERO. Está ready.

---

**Próximo paso**: Actualizar `doc/sdd/_INDEX.md` fila 154 → status **DONE**, mergepar PR, deployar (testnet ahora, mainnet cuando se habilite).
