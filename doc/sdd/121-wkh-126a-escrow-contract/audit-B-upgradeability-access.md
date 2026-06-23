# Audit B — Upgradeability, Initialization & Access Control — WasiAIEscrow.sol

> nexus-adversary · 2026-06-22 · verificación on-chain (proxy 0x2D88..., impl 0x6456...) · PoCs verdes y borrados
> _Persistido por el orquestador (el agente no puede escribir .md)._

Conteo: **BLQ-ALTO 1 · BLQ-MED 3 · BLQ-BAJO 2 · MNR 2 · 8 categorías OK/N-A**

## Vector clásico UUPS (impl init) — SAFE
`_disableInitializers()` corre en el constructor (`:50-52`). Verificado on-chain: impl Initializable slot = `type(uint64).max`; `initialize()` directo en la impl revierte `InvalidInitialization (0xf92ee8a9)`; `upgradeToAndCall()` directo revierte `UUPSUnauthorizedCallContext (0xe07c8dba)`. Re-init del proxy bloqueado. **Cerrado.**

## BLQ-ALTO-1 — owner deployado es EOA (no multisig) + timelock 60s (no 2 días)
- **On-chain:** proxy `owner()` = `0xf432baF1...e447Ba`, `cast code` = `0x` → **EOA**, contradice el comentario `:57` ("owner = multisig NOT the deployer EOA"). Slot `_upgradeTimelock` = `0x3c` = **60 segundos** (los tests asumen 2 días).
- **Ataque:** una sola private key EOA controla la upgradeabilidad de un contrato de custodia. Quien tenga la key puede `proposeUpgrade(maliciousImpl)` y **60s después** `upgradeToAndCall` a una impl que drena todo el USDC. El "timelock" da 1 minuto de reacción = sin protección real. Key phished/leaked → pérdida total tras 60s.
- **Nota:** es config de deploy (testnet usó EOA+60s a propósito). Para mainnet es release-blocker: owner = multisig real (Gnosis Safe), timelock ≥ 2 días. El CÓDIGO no fuerza un mínimo (ver BLQ-MED-1).

## BLQ-MED-1 — `initialize` acepta `timelockDelay = 0`; sin mínimo
- `:54-63` solo valida usdc/multisig != 0. PoC: con timelock=0, propose+upgrade en el MISMO bloque. **Fix:** `if (timelockDelay < MIN_TIMELOCK) revert InvalidTimelock();` (MIN_TIMELOCK constante, ej. 2 días).

## BLQ-MED-2 — `renounceUpgrade` no previene `Ownable.renounceOwnership` → bricks governance
- `:147-149` setea `_upgradeRenounced=true`, pero el público `renounceOwnership()` (Ownable2Step) no está override. PoC: tras `renounceOwnership()`, owner=0 → propose/upgrade/renounceUpgrade revierten `onlyOwner` para siempre, y `_upgradeRenounced` queda false. Dos estados terminales divergentes. **Fix:** override `renounceOwnership()` → revert (forzar el renounce solo vía `renounceUpgrade`), o unificar. Emitir evento.

## BLQ-MED-3 — `proposeUpgrade` sin validación (zero/no-code) ni evento
- `:142-145`. PoC: `proposeUpgrade(address(0))` y `proposeUpgrade(0xDEAD)` (sin code) tienen éxito. La validación recién ocurre en `upgradeToAndCall`. **Fix:** `if (newImpl==0) revert ZeroAddress(); if (newImpl.code.length==0) revert NotAContract();` + emitir `UpgradeProposed`.

## BLQ-BAJO-1 — las propuestas de upgrade nunca expiran; sin cancel
- `:153-156` solo chequea `>= proposedAt + timelock`, sin cota superior. PoC: propuesta ejecutada 365 días después sigue válida. `_upgradeProposedAt` no se limpia tras upgrade. **Fix:** ventana de validez (`<= proposedAt + timelock + GRACE`), limpiar el slot tras upgrade, y `cancelUpgrade(address)` onlyOwner.

## BLQ-BAJO-2 — sin pause/freeze (mayormente by-design no-custodial)
- No hay Pausable. Para un escrow no-custodial la ausencia de censura del owner sobre retiros es CORRECTO (feature). Pero no hay forma de frenar DEPÓSITOS si se descubre un bug crítico → los fondos siguen entrando a un contrato vulnerable hasta que el upgrade (lento) aterrice. **Fix opcional:** `pauseDeposits()` onlyOwner que bloquee SOLO `deposit` (nunca withdraw/debit). Documentar que la ausencia de pause de retiro es garantía no-custodial intencional.

## MNR-1 — el parámetro `multisig` + comentario es engañoso vs uso real (deploy usó EOA).
## MNR-2 — los cambios de governance (propose/renounce) no emiten eventos → monitoreo del timelock degradado.

## Categorías OK (sin finding)
Storage layout / collision (forge inspect: slots 0-7 + `__gap[44]`; OZ v5 namespaced storage no colisiona) · re-init proxy bloqueado · `_authorizeUpgrade` onlyOwner+timelock sólido (las debilidades son las validaciones faltantes de arriba) · selector clash N-A (UUPS) · ReentrancyGuard en las 4 funciones con CEI correcto · EIP-712 domain ligado al proxy.

## Veredicto: RECHAZADO (BLOQUEANTEs activos). Orden de fix: BLQ-ALTO-1 → BLQ-MED-1/2/3 → BLQ-BAJO-1/2 → MNR.
