# Auto-Blindaje — WKH-126a (Escrow Contract, Foundry)

Registro de errores cometidos y corregidos durante F3. Protege futuras HUs del mismo error.

### [2026-06-22 W0] Flag inexistente `--no-commit` en `forge init`/`forge install`
- **Error**: el Story File (§4) indicaba `forge init contracts --no-git --no-commit` y `forge install ... --no-commit`. En Foundry 1.5.1 el flag `--no-commit` NO existe; la corrida abortó con `Usage: forge init --no-git --commit <PATH>`.
- **Causa raíz**: drift de CLI entre la versión asumida por el Story File y la instalada (1.5.1). En 1.5.x el commit es opt-in vía `--commit`; no hay `--no-commit` (no commitear es el default).
- **Fix**: usar solo `--no-git` (sin `--commit`). El scaffold y los `forge install` quedan sin commit por defecto, que es justo lo que pide el Story File (el orquestador commitea al final).
- **Aplicar en**: cualquier futura HU que scaffoldee Foundry. Verificar flags reales con `forge init --help` / `forge install --help` antes de copiar comandos del Story File. NO asumir flags por versión.

### [2026-06-22 FIX-PACK] Test address con dígito no-hex `0x0PER` rompe el build
- **Error**: en un test nuevo escribí `address newOp = address(0x0PER);` → `forge build` falló con `Error (8936): Identifier-start is not allowed at end of a number`.
- **Causa raíz**: usar una "address-as-word" mnemónica (`0PER`) que contiene letras fuera del rango hex (`P`, `R`). Solidity parsea `0x...` como literal hex y rechaza dígitos inválidos.
- **Fix**: usar un literal hex válido (`0x09E7`). Para placeholders mnemónicos en tests, mapear cada letra a hex válido (0-9, a-f) o usar `makeAddr("operator")`.
- **Aplicar en**: cualquier test que invente addresses literales. Solo `[0-9a-fA-F]` tras `0x`. `0xCAFE`, `0xBEEF`, `0xB07` válidos; `0xOPER`, `0xGAS` no.

### [2026-06-22 FIX-PACK] `_authorizeUpgrade` ya NO puede ser `view` (consume la propuesta)
- **Error**: el W4 anterior había hecho `_authorizeUpgrade` `view` para callar el warning 2018. En el fix-pack B-BAJO-1 necesité limpiar `_upgradeProposedAt[slot]` tras un upgrade exitoso (consumir la propuesta, evitar replay/lingering).
- **Causa raíz**: `view` impide mutar storage; el patrón de timelock correcto consume la propuesta en `_authorizeUpgrade` (se llama justo antes del upgrade real desde `upgradeToAndCall`).
- **Fix**: quitar `view` de `_authorizeUpgrade` y agregar `delete _upgradeProposedAt[slot];`. Esto reintroduce mutación intencional, así que el warning 2018 ya no aplica (la función ahora muta). Build 0 warnings de mutabilidad.
- **Aplicar en**: si una HU futura agrega lógica de "consumir/limpiar" en un hook que antes se marcó `view`, revertir el `view`. La regla del auto-blindaje W4 ("declarar `view` si no muta") sigue válida; aquí la función SÍ pasó a mutar.

### [2026-06-22 FIX-PACK] Nueva storage var en contrato UUPS → ajustar `__gap` (CD-9)
- **Error**: agregar `address internal _operator;` sin ajustar `__gap` habría corrido el layout / dejado `__gap` con tamaño incorrecto.
- **Causa raíz**: en UUPS con `__gap` reservado, cada storage var nueva debe restarse del gap para mantener el slot total estable (CD-9: order stable, __gap last).
- **Fix**: `_operator` añadido al FINAL del bloque de storage (después de `_upgradeProposedAt`, antes de `__gap`) y `__gap[44]` → `__gap[43]`. `forge inspect` layout estable; tests de upgrade verdes.
- **Aplicar en**: TODA storage var nueva en un contrato upgradeable con `__gap`: agregar al final del bloque existente (nunca en el medio → rompe slots de impls viejas) y decrementar `__gap` en 1 por slot consumido.

### [2026-06-22 FIX-PACK] Warning solc 8760: param `operator` ensombrece el getter `operator()`
- **Error**: nombrar el parámetro de `initialize` como `operator` y a la vez agregar un getter `function operator()` → `Warning (8760): This declaration has the same name as another declaration`. La DoD exige 0 warnings.
- **Causa raíz**: el parámetro de función y la función pública comparten el identificador `operator` en el mismo scope del contrato.
- **Fix**: renombrar el parámetro a `operator_` (mismo patrón que `owner_`). Sin cambios de semántica. `Compiler run successful!` sin warnings.
- **Aplicar en**: al agregar un getter `foo()` y un parámetro `foo` en cualquier función del mismo contrato, sufijar el parámetro con `_`. Convención: params que coliden con storage/getters → `nombre_`.

### [2026-06-22 W4] Warning solc `_authorizeUpgrade can be restricted to view`
- **Error**: el build emitía 1 warning de compilador (2018) — `_authorizeUpgrade(address) internal override onlyOwner` solo lee estado y podía ser `view`. La DoD exige código propio sin warnings.
- **Causa raíz**: la implementación de `_authorizeUpgrade` (timelock + renounce checks) solo lee `_upgradeRenounced` y `_upgradeProposedAt`; no muta. El override de la virtual non-view de OZ UUPS no obliga a non-view.
- **Fix**: agregar `view` al override → `internal view override onlyOwner`. Solidity permite que un override de una función `internal virtual` (sin mutabilidad declarada) sea más restrictivo (`view`). Build pasó a 0 warnings, 22 tests siguen verdes, coverage 100%.
- **Aplicar en**: cualquier UUPS donde `_authorizeUpgrade` no mute estado → declararlo `view` desde el inicio para evitar el warning 2018. Si en el futuro consume una aprobación de un solo uso (muta), quitar `view`.
