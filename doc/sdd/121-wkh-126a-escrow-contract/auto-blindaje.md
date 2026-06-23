# Auto-Blindaje — WKH-126a (Escrow Contract, Foundry)

Registro de errores cometidos y corregidos durante F3. Protege futuras HUs del mismo error.

### [2026-06-22 W0] Flag inexistente `--no-commit` en `forge init`/`forge install`
- **Error**: el Story File (§4) indicaba `forge init contracts --no-git --no-commit` y `forge install ... --no-commit`. En Foundry 1.5.1 el flag `--no-commit` NO existe; la corrida abortó con `Usage: forge init --no-git --commit <PATH>`.
- **Causa raíz**: drift de CLI entre la versión asumida por el Story File y la instalada (1.5.1). En 1.5.x el commit es opt-in vía `--commit`; no hay `--no-commit` (no commitear es el default).
- **Fix**: usar solo `--no-git` (sin `--commit`). El scaffold y los `forge install` quedan sin commit por defecto, que es justo lo que pide el Story File (el orquestador commitea al final).
- **Aplicar en**: cualquier futura HU que scaffoldee Foundry. Verificar flags reales con `forge init --help` / `forge install --help` antes de copiar comandos del Story File. NO asumir flags por versión.

### [2026-06-22 W4] Warning solc `_authorizeUpgrade can be restricted to view`
- **Error**: el build emitía 1 warning de compilador (2018) — `_authorizeUpgrade(address) internal override onlyOwner` solo lee estado y podía ser `view`. La DoD exige código propio sin warnings.
- **Causa raíz**: la implementación de `_authorizeUpgrade` (timelock + renounce checks) solo lee `_upgradeRenounced` y `_upgradeProposedAt`; no muta. El override de la virtual non-view de OZ UUPS no obliga a non-view.
- **Fix**: agregar `view` al override → `internal view override onlyOwner`. Solidity permite que un override de una función `internal virtual` (sin mutabilidad declarada) sea más restrictivo (`view`). Build pasó a 0 warnings, 22 tests siguen verdes, coverage 100%.
- **Aplicar en**: cualquier UUPS donde `_authorizeUpgrade` no mute estado → declararlo `view` desde el inicio para evitar el warning 2018. Si en el futuro consume una aprobación de un solo uso (muta), quitar `view`.
