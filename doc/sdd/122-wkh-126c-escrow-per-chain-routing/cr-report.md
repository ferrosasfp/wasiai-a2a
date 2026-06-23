# CR Report — WKH-126c (Routing de escrow POR-CADENA)

> nexus-adversary · CR · 2026-06-22 · Branch `fix/122-wkh-126c-escrow-per-chain-routing` (working tree)
> **Veredicto: APROBADO** — 0 BLOQUEANTE, 1 MENOR. Gates: tsc 0 · biome 0 · auth.escrow 19/19.
> _Persistido por el orquestador (restricción de escritura del agente)._

## Checklist
1. **Helper `escrowEnabledForChain`** (`auth.ts:141-143`) — OK. Colindante a `escrowModeEnabled()`, tipado `(chainKey: ChainKey): boolean`, sync sin I/O, reusa funciones existentes: `escrowModeEnabled() && resolveEscrowContract(chainKey) !== null`. Import correcto (`resolveEscrowContract` al named import, `ChainKey` como type). CD-2 por short-circuit.
2. **Selector** (`auth.ts:682`) — OK. Cambio de 1 línea, `chainKey` es la var correcta (resuelta paso 3, en scope paso 5). `verifyEscrowDeposit` ya recibía chainKey → contrato downstream sin cambios.
3. **TS strict** — OK, sin `any`, tsc 0.
4. **Cobertura** — OK. AC-1 (contrato+flag on→escrow, asserta verifyEscrowDeposit 1x + verifyDeposit NO), AC-2 (sin contrato+flag on→treasury, `error_code` undefined = no-503), AC-3/CD-2 (flag off+contrato→treasury). Asserts no-vagos (`.not.toHaveBeenCalled()`). CD-4: 16 tests de 126b sin modificar (verificado por diff; única línea `-` = import viejo reemplazado por multilínea equivalente).
5. **Consistencia** — OK. Default del mock en `beforeEach` (`mockResolveEscrowContract → ESCROW_CONTRACT_ADDR`) preserva los casos 126b; los 126c sobrescriben con null. Patrón consistente.
6. **Gates** — confirmados ejecutando: tsc 0, biome 0 (2 files), auth.escrow 19/19.

## MNR-1 (opcional, no bloquea) — Test Coverage
`auth.escrow.test.ts:544-569` (AC-2): el test mockea verifyEscrowDeposit y nunca ejercita la rama real que produciría el 503. La regresión queda cubierta por `expect(mockVerifyEscrowDeposit).not.toHaveBeenCalled()` (`:568`), pero falta un caso que confirme que un verifier escrow devolviendo `ESCROW_CONTRACT_NOT_CONFIGURED` NO se alcanza con `resolveEscrowContract → null`. Robustez de suite, sin impacto runtime. Backlog.

## Scope / DTs
Cambio acotado a `auth.ts` (helper + 1 línea) + `auth.escrow.test.ts` (3 casos). Sin scope drift. DT-1/2/3/4 respetados (DT-4 vía mock, approach aceptado).

## Veredicto: APROBADO. Avanzar a F4. MNR-1 backlog.
