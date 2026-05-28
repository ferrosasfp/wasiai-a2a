# Report — HU [WKH-112] [BASE-07] outbound downstream payment chain-aware

## Resumen ejecutivo

Se completó el cableado chain-aware del path outbound del gateway. El único archivo de producción modificado fue `src/lib/downstream-payment.ts`: el módulo legacy que reimplementaba inline sign+verify+settle solo para Avalanche fue reemplazado por un thin orchestrator que resuelve el `ChainKey` del agente destino desde `agent.payment.chain` y delega la firma EIP-3009 + verify + settle al adapter correspondiente (`getPaymentAdapter(chainKey)`). El guard duro `if (agent.payment.chain !== 'avalanche') return null` fue eliminado; ahora Base Sepolia y Kite Ozone Testnet pueden recibir pagos outbound. El epic BASE port queda end-to-end completo: el gateway ahora cobra (inbound, WKH-111) y paga (outbound, WKH-112) en 3 chains. Suite final: 1047/1047 tests verdes; build exit 0. El AR atrapó una regresión EIP-3009 window 300s→60s (BLQ-MED-1), resuelta en fix-pack iter.1 (ccdcd74). Veredicto del pipeline: APROBADO PARA DONE. Pending post-merge: validación E2E live outbound (tx onchain Base/Kite via `/compose`).

---

## Pipeline ejecutado

- **F0**: Codebase grounding ejecutado 2026-05-27 — 15 hallazgos verificados con archivo:línea (H1..H15). Gap confirmado: guard `if (agent.payment.chain !== 'avalanche') return null` en `:457-467`. Primitivo chain-aware ya existente: `getPaymentAdapter(chainKey)` + `normalizeChainSlug` + adapters probados onchain en las 3 chains (H15).
- **F1**: `work-item.md` generado 2026-05-27 — 6 ACs EARS, 7 Constraint Directives, 5 Decisiones Técnicas (DT-1..DT-5), sizing M/QUALITY justificado (path de dinero real outbound, riesgo regresión CD-1).
- **Gate**: HU_APPROVED.
- **F2**: `sdd.md` generado 2026-05-27 — DT-1 (opción C thin orchestrator, blockNumber opcional), DT-2 (firma export estable, compose intacto), DT-3 (balance check chain-aware conservado), DT-4 (fail-loud logger.warn + skip-code CHAIN_NOT_SUPPORTED), DT-5 (Kite modo canonical x402). 11 Constraint Directives (CD-1..CD-11). Waves: W1 (resolve+fail-loud), W2 (delegación sign/verify/settle + borrado legacy), W3 (regresión + smoke).
- **Gate**: SPEC_APPROVED.
- **F2.5**: `story-file.md` generado — plan de 3 waves, ~27 tests definidos, mapeo de tests legacy a nueva estrategia de mock-registry.
- **F3**: Implementación en 2 waves (W1+W2 consolidadas en commit `bf58251`). `src/lib/downstream-payment.ts` refactorizado: −402 líneas netas del módulo legacy; `src/lib/downstream-payment.test.ts` reescrito con mock-registry completo (27 tests); `src/lib/downstream-payment.mainnet.test.ts` eliminado (mainnet Scope OUT, DT-1). `src/services/compose.ts` NO modificado (DT-2).
- **AR**: `ar-report.md` — BLOQUEADO, 1 BLQ-MED-1 (window EIP-3009 300s→60s por omisión de `timeoutSeconds`), 2 MENOR (MNR-1 test window, MNR-2 skip-codes muertos). Baseline AR: tsc exit 0, 1046/1046 tests.
- **Fix-pack iter.1** (commit `ccdcd74`): BLQ-MED-1 resuelto con `DOWNSTREAM_AUTH_WINDOW_SECONDS = 300` + `timeoutSeconds` pasado a `adapter.sign`. MNR-1 resuelto con T-AuthWindow. MNR-2 resuelto (skip-codes `NETWORK_ERROR`/`CONFIG_MISSING` removidos de la union). Re-AR: APROBADO (0 BLQ).
- **CR**: `cr-report.md` — APROBADO. 14 OK, 1 MENOR no bloqueante (CR-MNR-1, skip-codes ya resueltos en fix-pack). tsc exit 0, 1046/1046 tests. Gates: CD-1..CD-11 verificados con archivo:línea.
- **F4**: `qa-report.md` — APROBADO PARA DONE. 6/6 ACs verificados (4 PASS pleno, 2 PASS unit + PENDING-RUNTIME live tx post-merge). tsc exit 0, 1047/1047 tests (fix-pack +1 T-AuthWindow). BLQ-MED-1 confirmado cerrado. Drift: cero scope creep en src/.

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 — settle outbound Base Sepolia | **PASS unit + PENDING-RUNTIME live tx** | T-AC1 `downstream-payment.test.ts:426` PASS: `result={txHash:'0xBASE', settledAmount:'500000'}`, `mockGetPaymentAdapter('base-sepolia')`. Live tx: pendiente post-merge (Wave 3, corre el operador). |
| AC-2 — CERO regresión Avalanche | **PASS** | T-AC2a `:443` + T-AC2b `:453` PASS. T-AuthWindow `:576` afirma `timeoutSeconds:300`. npm test 1047/1047 verde. `chainKey` resuelto una sola vez en `:151`. |
| AC-3 — settle outbound Kite Ozone | **PASS unit + PENDING-RUNTIME live tx** | T-AC3 `:470` PASS: `result={txHash:'0xKITE', settledAmount:'500000000000000000'}`, guard dimensional 18-dec afirmado en `:489-490`. Live tx: pendiente post-merge (Wave 3). |
| AC-4 — chain no soportada → fail-loud CHAIN_NOT_SUPPORTED | **PASS** | T-AC4a `:493` (slug desconocido `'solana'`) + T-AC4b `:509` (bundle undefined, lista de chains inicializadas). `mockFujiSign` NO llamado. |
| AC-5 — coherencia de chain en todo el flujo | **PASS** | T-AC5 `:533` PASS: `mockGetPaymentAdapter` siempre con `'base-sepolia'`; `mockBaseVerify`/`mockBaseSettle` con `{network:'eip155:84532'}`. `chainKey` resuelto once en `:151`. |
| AC-6 — sin hardcodes de chain (address/network/decimales del adapter) | **PASS** | T-AC6 `:556` PASS. Grep `DEFAULT_FUJI_USDC\|FUJI_NETWORK\|DEFAULT_AVALANCHE\|WASIAI_DOWNSTREAM_NETWORK\|signTypedData\|avalancheFuji` → 0 matches en `downstream-payment.ts`. |

---

## Hallazgos finales

**BLOQUEANTEs**:
- BLQ-MED-1 (AR): `adapter.sign()` llamado sin `timeoutSeconds` — la ventana EIP-3009 del path Avalanche regresó de 300s a 60s (default del adapter). Resuelto en fix-pack iter.1 (`DOWNSTREAM_AUTH_WINDOW_SECONDS = 300` + T-AuthWindow). Cerrado: verificado en QA.

**MENORs**:
- MNR-1 (AR): falta de test que afirmara `timeoutSeconds`. Resuelto en fix-pack iter.1 (T-AuthWindow).
- MNR-2 (AR) / CR-MNR-1 (CR): skip-codes `NETWORK_ERROR`/`CONFIG_MISSING` huérfanos en la union `DownstreamSkipCode`. Resueltos en fix-pack iter.1 (removidos). Cerrado: verificado en QA.

**Deuda técnica aceptada**:
- TD-WKH-112-01: `DownstreamResult.blockNumber` no se puebla porque `SettleResult` del adapter no lo expone (`adapters/types.ts:16-20`). Campo opcional y backward-compatible (`compose.ts:195-199` usa spread condicional). A resolver extendiendo `SettleResult` del adapter en HU futura.

---

## Auto-Blindaje consolidado

### [2026-05-27] FIX-PACK iter.1 — `adapter.sign` sin `timeoutSeconds` regresó la ventana EIP-3009 (AR BLQ-MED-1)

- **Error**: en el refactor a thin-orchestrator se llamó `adapter.sign({ to, value })` sin `timeoutSeconds`. El default del adapter es 60s; el legacy usaba `VALID_BEFORE_SECONDS = 300`. Esto cambió el contenido observable de la autorización firmada en el path Avalanche, violando CD-1.
- **Causa raíz**: el Story File (`:163`, `:436`) prescribía `adapter.sign({ to, value, timeoutSeconds })` explícito, y `VALID_BEFORE_SECONDS` figuraba entre las constantes legacy a "trasladar" vía ese param. Se omitió al inlinear el call y no había test que afirmara el window — el drift pasó desapercibido en F3.
- **Fix**: constante nombrada `DOWNSTREAM_AUTH_WINDOW_SECONDS = 300` (comentario citando CD-1/BLQ-MED-1) pasada como `timeoutSeconds` al `adapter.sign(...)`. Test `T-AuthWindow`: `expect(mockFujiSign.mock.calls[0][0]).toMatchObject({ timeoutSeconds: 300 })`.
- **Lección para futuras HUs**: cuando un orchestrator delega firma EIP-3009 a un adapter, los parámetros de ventana/timeout NO son opcionales aunque el tipo los marque `?`. Si el Story File prescribe un campo explícito al delegar, debe quedar afirmado por un test — no asumir defaults del adapter.

### [2026-05-27] FIX-PACK iter.1 — limpieza skip-codes muertos (MNR-2 / CR-MNR-1)

- **Error**: la union `DownstreamSkipCode` conservaba `'NETWORK_ERROR'` y `'CONFIG_MISSING'` sin uso tras el refactor (drift cosmético tipo↔runtime).
- **Causa raíz**: arrastre de la versión legacy del módulo; ningún code-path los emitía post-refactor.
- **Fix**: removidos ambos de la union tras verificar con grep que no aparecen en ningún `return`/log de `src/`.
- **Lección para futuras HUs**: al refactorizar un módulo, recortar las unions de error/skip-codes a los efectivamente emitidos para evitar drift type↔runtime. Un `grep` de cada valor de la union es parte del checklist de cierre de F3.

### [Heredada de WKH-111/093] Mock-registry completo en tests de módulos que usan `getPaymentAdapter`

- Al reescribir tests de módulos que consumen el adapter registry (`getPaymentAdapter`, `getAdaptersBundle`, `getInitializedChainKeys`), el mock del registry debe exportar las 3 funciones. Si se mockea solo `getPaymentAdapter` y se omiten las otras, los tests del fail-loud (AC-4b) o de la lista de chains inicializadas pueden pasar con comportamiento incorrecto. Verificar con `downstream-payment.test.ts:97-105` como referencia canónica.

---

## Archivos modificados

**Producción:**
- `src/lib/downstream-payment.ts` — refactor mayor: thin orchestrator sobre `getPaymentAdapter(chainKey)`. Guard `if (agent.payment.chain !== 'avalanche') return null` eliminado. sign+verify+settle delegados al adapter. `buildClients`/`signTypedData`/`postFacilitator`/`getUsdcAddress`/`TRANSFER_WITH_AUTHORIZATION_TYPES`/constantes chain/wire-types legacy eliminados (−402 líneas netas). `DOWNSTREAM_AUTH_WINDOW_SECONDS = 300` agregado (fix-pack).

**Tests:**
- `src/lib/downstream-payment.test.ts` — reescrito con mock-registry completo (27 tests: 17 skip-codes legacy + 10 chain-aware nuevos incluyendo T-AC1..T-AC6, T-AuthWindow, T-Balance-NoRpc).
- `src/lib/downstream-payment.mainnet.test.ts` — ELIMINADO (mainnet Scope OUT, DT-1; concepto `WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet` desaparece con el refactor).

**Docs:**
- `doc/sdd/094-wkh-112-downstream-chain-aware/auto-blindaje.md` — lecciones del fix-pack.

**No modificados (confirmado):**
- `src/services/compose.ts` — DT-2: firma export estable, el consumidor único no necesita cambios.
- `src/adapters/*` — CD-11: adapters/registry/chain-resolver intactos.
- `src/middleware/x402.ts` — inbound path (WKH-111, Scope OUT).

---

## Decisiones diferidas a backlog

- **TD-WKH-112-01**: extender `SettleResult` del adapter (`src/adapters/types.ts`) para exponer `blockNumber` optionalmente, permitiendo que `StepResult.downstreamBlockNumber` vuelva a poblarse. Es metadata de telemetría, no bloquea el pago. HU futura sobre la superficie de adapters.

---

## Pending post-merge (Wave 3)

La validación E2E outbound live (AC-1 Base y AC-3 Kite) requiere:

1. Branch mergeada a main y deployada en Railway con `WASIAI_A2A_CHAINS` incluyendo `base-sepolia` y `kite-ozone-testnet`.
2. Un sub-agente registrado con `payment.chain:'base-sepolia'` y uno con `'kite-ozone-testnet'`.
3. Llamar `/compose` con esos agentes. Capturar `downstreamTxHash` en la respuesta.
4. Verificar tx hash en Basescan (sepolia.basescan.org) para Base, y en el explorador Kite para Kite Ozone.
5. Operator wallet ya funded en las 3 chains (confirmado en `doc/sdd/_validation/2026-05-27-multichain-deep-validation.md` Capa E/F, H15). Facilitator multi-chain ya responde `/supported = 4 networks`.

Esta validación corresponde a Wave 3 (W3.1) del Story File — la corre el humano/operador post-merge. NO es un FAIL de esta HU.

---

## Commits

| Hash | Descripción |
|------|-------------|
| `bf58251` | feat(WKH-112): outbound downstream payment chain-aware via adapter |
| `ccdcd74` | fix(WKH-112): pass timeoutSeconds:300 to adapter.sign — restore legacy EIP-3009 window (AR BLQ-MED-1) |

---

## Lecciones para próximas HUs

1. **Los defaults del adapter no reemplazan las constantes de negocio.** Al delegar firma EIP-3009 a un adapter, cualquier parámetro que controle comportamiento observable (ventana de validez, decimales, network tag) debe pasarse explícitamente y afirmarse en un test. El tipo puede marcarlo `?` para comodidad del caller — eso no lo hace opcional en un contexto de paridad de comportamiento (CD-1).

2. **Los mocks de unit tests no modelan todas las dimensiones del comportamiento.** BLQ-MED-1 pasó invisible en F3 porque los mocks de `adapter.sign` no capturaban ni afirmaban `timeoutSeconds`. El AR lo detectó comparando la constante legacy con el default del adapter. Regla: para cada param que tenga un default silencioso en la implementación real, el test debe capturar y afirmar el valor concreto recibido por el mock.

3. **Recortar las unions de error/skip al terminar el refactor.** Cuando se refactoriza un módulo y cambia el conjunto de paths de error activos, las unions de skip-codes/error-codes deben recortarse a los efectivamente emitidos. Dejar valores huérfanos crea drift type↔runtime que complica futuros ARs y CRs.

4. **El thin orchestrator sobre adapter existente es la opción correcta para paths de dinero.** DT-1 (reusar `getPaymentAdapter` en vez de reimplementar inline por cada chain) eliminó ~400 líneas de código legacy, eliminó toda la dependencia de hardcodes de chain, y reutilizó un primitivo ya probado onchain en las 3 chains. Para cualquier futura HU que extienda el settle (mainnet, nuevas chains), la superficie de cambio queda acotada al adapter correspondiente — no al orchestrator.
