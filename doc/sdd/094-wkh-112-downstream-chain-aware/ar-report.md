# AR Report — WKH-112 [BASE-07] outbound downstream payment chain-aware

> Adversary: nexus-adversary | Fase: AR (Adversarial Review)
> Branch: feat/094-wkh-112-downstream-chain-aware (commit bf58251)
> Diff vs main: 3 archivos (downstream-payment.ts, .test.ts, .mainnet.test.ts borrado)
> Fecha: 2026-05-27
> Baseline verificado: tsc -p tsconfig.build.json --noEmit EXIT 0 | npm test 1046 passed (71 files)

---

## Resumen ejecutivo

El refactor a thin-orchestrator está MUY bien ejecutado: cero hardcodes de chain residuales,
firma 100% delegada al adapter, NEVER-throws preservado con triple try/catch, coherencia de
chain (un solo `chainKey` resuelto y reusado), decimales chain-aware con guard dimensional
Kite-18 testeado. Scope limpio (solo los 3 archivos declarados; compose/adapters intactos).

**Pero hay UN BLOQUEANTE no declarado**: el `adapter.sign()` se invoca SIN `timeoutSeconds`
(el Story File W2.3 y el SDD §4.3 explícitamente prescribían pasarlo). Esto cambia la ventana
`validBefore` de la autorización EIP-3009 en el path Avalanche de **300s (legacy
VALID_BEFORE_SECONDS) a 60s (default del adapter)** — un diff observable funcional en el path
Avalanche que CD-1 marca como BLOQUEANTE y que NO está dentro de la única desviación declarada
(blockNumber).

**Veredicto sobre blockNumber/CD-1: ACEPTABLE** (justificación en §Adjudicación). El blockNumber
NO es el bloqueante; el timeout sí lo es.

---

## Tabla de hallazgos

| ID | Severidad | Categoría | Descripción | Evidencia | Mitigación |
|----|-----------|-----------|-------------|-----------|------------|
| BLQ-MED-1 | BLOQUEANTE-MEDIO | Integration / Data Integrity (CD-1) | `adapter.sign({ to, value })` se llama SIN `timeoutSeconds`. El path Avalanche legacy firmaba con `validBefore = now + 300s` (`VALID_BEFORE_SECONDS=300`). El adapter avalanche, sin `timeoutSeconds`, usa `AVALANCHE_MAX_TIMEOUT_SECONDS = 60`. La ventana de validez de la autorización EIP-3009 se reduce 300s→60s en el path Avalanche. Es un diff observable funcional en una autorización de pago firmada. CD-1: "cualquier diff observable funcional en el path Avalanche es BLOQUEANTE", y el SDD declaró que la ÚNICA desviación aceptada era `blockNumber`. | `src/lib/downstream-payment.ts:272-275` (sign sin timeoutSeconds) vs `main:src/lib/downstream-payment.ts:65` (`VALID_BEFORE_SECONDS=300`), `:558` (validBefore usa 300); adapter default `src/adapters/avalanche/payment.ts:381` (`?? AVALANCHE_MAX_TIMEOUT_SECONDS`), `:40` (=60). Story File `story-file.md:163,436` prescribía `timeoutSeconds`. | Pasar `timeoutSeconds: 300` (o una constante derivada que reproduzca el window legacy) a `adapter.sign(...)` para preservar la ventana del path Avalanche. No es hardcode de chain (es un parámetro de negocio de validez), CD-3 lo tolera. Re-correr regresión. |
| MNR-1 | MENOR | Test Coverage | Los mock adapters del test no modelan `validBefore`/`timeoutSeconds`, por lo que la regresión BLQ-MED-1 pasó invisible (los 26 tests verdes no la detectan). Falta un test que afirme que `adapter.sign` recibe el `timeoutSeconds` esperado (o que el window Avalanche se preserva). | `src/lib/downstream-payment.test.ts:438-440,448-450` (asserts solo `to`/`value`, nunca `timeoutSeconds`) | Agregar assert `expect(mockFujiSign).toHaveBeenCalledWith(expect.objectContaining({ timeoutSeconds: 300 }))` tras el fix de BLQ-MED-1. |
| MNR-2 | MENOR | Type Safety / Dead code | `DownstreamSkipCode` conserva `'NETWORK_ERROR'` y `'CONFIG_MISSING'` que ya no se emiten tras el refactor (ningún code-path los usa). El Story File (`:100`) declaró que conservarlos NO es bloqueante. Deuda cosmética. | `src/lib/downstream-payment.ts:66-67` | Opcional: remover de la union los skip-codes sin uso, o documentar como deuda. NO bloquea. |

---

## Adjudicación EXPLÍCITA — blockNumber vs CD-1 (vector 1)

**Veredicto: ACEPTABLE (NO bloqueante).**

Razonamiento:
1. `SettleResult` del adapter NO expone `blockNumber` (verificado `src/adapters/types.ts:16-20`:
   solo `{txHash, success, error?}`). El impl omite el campo limpiamente (`downstream-payment.ts:343-346`).
2. El campo es **metadata opcional de telemetría**, no funcional para el pago. La prueba onchain
   canónica (`txHash`) se preserva intacta — `result.txHash` sigue poblado en los 3 paths.
3. `StepResult.downstreamBlockNumber` ya es opcional y `compose.ts:195-199` lo mapea con spread
   condicional (`...(downstream && {...})`) — si `downstream.blockNumber` es `undefined`, el campo
   simplemente no aparece en el JSON. **Backward-compatible a nivel de tipo y de wire.**
4. No es dato simulado (no se inyecta un `0` falso — opción B rechazada correctamente en el SDD).
5. Está declarado explícitamente y rastreado como TD-WKH-112-01.

Por tanto el drop de `blockNumber` es un **downgrade de telemetría acotado y declarado**, NO un
diff funcional del pago. NO viola CD-1 de forma inaceptable. La recomendación del Architect
(opción C, sin tocar `adapters/types.ts`) se respeta.

> CONTRASTE: lo que SÍ viola CD-1 de forma inaceptable es el cambio de window 300s→60s (BLQ-MED-1),
> precisamente porque NO fue declarado y SÍ es un cambio en el contenido de una autorización de
> pago firmada en el path Avalanche.

---

## Cobertura de vectores de ataque

| Vector | Resultado | Evidencia |
|--------|-----------|-----------|
| 1. blockNumber vs CD-1 | **ACEPTABLE** (ver Adjudicación) | `types.ts:16-20`, `downstream-payment.ts:343-346`, `compose.ts:195-199` |
| 2. Cross-chain confusion | **OK** | `chainKey` resuelto UNA vez (`:144`), reusado en adapter (`:189`), balance (`:208`), sign/verify/settle. `network` viene de `signed.paymentRequest.network` (`:288`), nunca de literal. T-AC5 (`:533-549`) afirma coherencia. |
| 3. Decimales (CD-8) | **OK** | `decimals = adapter.supportedTokens[0].decimals` (`:193`), `parseUnits(String(priceUsdc), decimals)` (`:196`). NO queda `USDC_DECIMALS=6` (grep vacío). T-AC3 (`:470-491`) afirma Kite firma `'500000000000000000'` y `.not.toBe('500000')`. |
| 4. Firma delegada (CD-9) | **OK** | grep `signTypedData`/`createWalletClient`/`TRANSFER_WITH_AUTHORIZATION_TYPES` en el módulo → EXIT 1 (cero matches). Firma 100% en `adapter.sign` (`:272`). Domain inline residual = 0. |
| 5. Fail-loud (CD-4) | **OK** | `:146-157` skip `CHAIN_NOT_SUPPORTED` + `logger.warn` (NO `.error`, que no existe) + `getInitializedChainKeys()`. NO fallback a Avalanche. T-AC4a/b lo verifican. |
| 6. NEVER-throws (CD-7) | **OK** | try/catch individual en sign (`:271-282`), verify (`:297-305`), settle (`:320-328`) + outer defensivo (`:268-355`). Todos retornan `null` + skip-code. |
| 7. Cero regresión Avalanche (CD-1) | **BLOQUEANTE (BLQ-MED-1)** | window 300s→60s. Resto del path (facilitator del adapter Fuji, eip155:43113 vía `getNetworkTag`, skip-codes, balance check con `FUJI_RPC_URL`) íntegro. `.mainnet.test.ts` borrado (mainnet Scope OUT, aprobado). |
| 8. Scope creep (CD-11) | **OK** | `git diff --name-only` = solo los 3 archivos declarados. `compose.ts`/`compose.test.ts`/`src/adapters/*` sin diff. |
| 9. Ownership guard | **N/A** | grep `a2a_agent_keys`/`supabase`/`owner_ref` en el módulo → cero matches. El downstream settle no toca BD (declarado en SDD §3). |

---

## Veredicto final

**BLOQUEADO** — 1 BLOQUEANTE activo.

Conteo: 1 BLOQUEANTE-MEDIO (BLQ-MED-1) · 0 ALTO · 0 BAJO · 2 MENOR (MNR-1, MNR-2).

Orden de ataque del fix-pack:
1. **BLQ-MED-1** (timeoutSeconds → preservar window 300s del path Avalanche). Único bloqueante del gate.
2. MNR-1 (test que guarde el window — recomendado junto al fix de BLQ-MED-1).
3. MNR-2 (limpieza de skip-codes muertos — opcional / backlog).

