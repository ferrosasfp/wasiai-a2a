# Final Report — WKH-126a: Contrato Solidity del Escrow No-Custodial (Foundry)

> **Status**: ✅ DONE · **Fecha**: 2026-06-22 · **Branch**: `feat/121-wkh-126a-escrow-contract` · **Modo**: QUALITY AUTO
> Veredicto F4: APROBADO PARA DONE (12/12 ACs PASS). **Contrato NO deployado — ver §8.**

## 1. Resumen ejecutivo

`WasiAIEscrow.sol` es el contrato Solidity real que materializa la interfaz que WKH-126b (DONE) consume. Escrow no-custodial prepago de USDC: el **agente deposita** (`deposit`), el **operador liquida en lote** (`debitBatch`) contra una firma EIP-712 del agente (`DebitAuthorization` = neto por ventana), y el **agente retira** su saldo libre cuando quiere (`withdraw`). Invariante central: **el operador NUNCA mueve fondos sin firma del agente** (CD-2, verificada con invariant fuzzing). Stack: Foundry puro + OpenZeppelin v5.1.0 (UUPS upgradeable). Red: Base Sepolia testnet.

Con 126a el círculo del escrow cierra: contrato + integración TS (126b) convergen byte-a-byte vía el typehash `0x5feea67fe2f683c18d6addd1eaab3f2152293b5512c90fdd3f702e973a2328f5`.

## 2. Pipeline (QUALITY AUTO, 2026-06-22)

HU_APPROVED + SPEC_APPROVED self-aprobados → F2.5 → F3 (6 waves, scaffold Foundry → contrato → tests → deploy) → AR (APROBADO, 0 BLQ, 4 MNR) + CR (APROBADO, 0 BLQ, 5 MNR) → F4 (APROBADO PARA DONE, 12/12 ACs PASS).

## 3. AC results (12/12 PASS — ver validation.md)

deposit acredita+emite (AC-1) · debit con firma válida (AC-2) · debitBatch atómico (AC-3) · InvalidSignature (AC-4) · DeadlineExpired (AC-5) · NonceAlreadyUsed (AC-6) · withdraw del libre por depositor (AC-7) · Unauthorized (AC-8) · operador no retira sin firma / CD-2 (AC-9) · escrowBalance view (AC-10) · solo USDC (AC-11) · UUPS timelock+owner+renounce (AC-12). Cada uno con evidencia archivo:línea en `WasiAIEscrow.sol` + test en `WasiAIEscrow.t.sol`.

## 4. Decisiones clave

- **DT-1..9**: settlement en lote, debit disparado por el operador, firma del NETO por ventana, agente paga gas del depósito, solo USDC, UUPS upgradeable + renounce, Base Sepolia, convergencia ABI/typehash byte-a-byte con 126b.
- **DT-10 (NC-1)**: `depositor[keyId]` INMUTABLE desde el primer deposit (previene takeover de keyId).
- **DT-11 (NC-2)**: modelo **OPTIMISTA** del lock — `withdraw` chequea balance; `lockedAmount` reservado en storage en 0. Griefing residual documentado: un agente puede front-runear el `debitBatch` con un withdraw → el débito revierte (impago, NO robo; los fondos del agente nunca corren riesgo, CD-2 intacto). **Decisión mainnet pendiente**: aceptar griefing vs activar lock explícito on-chain.
- **DT-14**: `nonce` expuesto en `debit`/`debitBatch` (ABI 4→5 args en `src/adapters/escrow/abi.ts`); `eip712.ts` intacto; typehash sin cambios.

## 5. Archivos

**Subproyecto Foundry `contracts/`**: `src/WasiAIEscrow.sol`, `src/interfaces/IWasiAIEscrow.sol`, `test/WasiAIEscrow.t.sol` (20 unit), `test/WasiAIEscrow.invariant.t.sol` (2 invariant), `test/mocks/MockUSDC.sol`, `script/Deploy.s.sol`, `foundry.toml`, `remappings.txt`, submodules OZ v5.1.0 + forge-std.
**TS (cierre DT-14)**: `src/adapters/escrow/abi.ts` (debit 4→5 args). **Config**: `.env.example` (+5 vars Base Sepolia).

## 6. Gates

`forge build` 0 err · `forge test` 22/22 (20 unit + 2 invariant, 12.800 fuzz calls) · `forge coverage` 100% (60/60 líneas, 15/15 branches, 11/11 funcs) · `forge fmt` limpio · `cast keccak` typehash byte-a-byte · `tsc` 0 · `vitest` escrow 34/34.

## 7. Hallazgos

**0 BLOQUEANTEs.** El contrato defiende firma (ECDSA.recover OZ, anti-malleability), replay (nonce per-keyId), reentrancy (CEI + ReentrancyGuard), atomicidad de batch, depositor inmutable, insolvencia, y upgrade (owner multisig + timelock + renounce). El AR escribió 8 tests adversariales propios — todos neutralizados.

**9 MENORs (no bloquean)**: ghost counter en el invariant CD-2 (observabilidad), `forge-std` en .gitmodules (reproducibilidad), NatSpec en 6 funciones, `unchecked{++i}` (gas), `proposeUpgrade` zero-check, fee-on-transfer teórico (USDC no lo es). Candidatos a fix-pack pre-mainnet.

## 8. Deploy (el contrato NO está deployado)

Para activar el escrow e2e:
1. `forge script contracts/script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast` (deploy impl + ERC1967Proxy + initialize). Requiere `.env` con las 5 vars.
2. Verificar on-chain: owner = multisig, typehash = `0x5feea6...`.
3. `A2A_ESCROW_CONTRACT_BASE=<proxy>` en prod + `ESCROW_MODE_ENABLED=true`.
4. Smoke e2e desde 126b (deposit → debitBatch → withdraw on-chain).

## 9. Prerequisitos mainnet (escalado al humano)

- **Auditoría externa del contrato** — obligatorio antes de mainnet (money-custody).
- **Decisión DT-11** — aceptar griefing del modelo optimista o activar el lock explícito on-chain (`lockedAmount` ya reservado en storage para activarse sin romper layout).
- **Replicación a Kite/Avalanche** — HU futura (baseline Base Sepolia).
- **Congelar upgrade** (`renounceUpgrade`) antes de mainnet serio.

## 10. Lección

Un contrato de custodia se valida con: typehash byte-a-byte vs el consumidor TS (gate cross-surface separado, `cast keccak` + test recover), invariant fuzzing del "no se puede drenar sin firma" (no solo unit tests), CEI + ReentrancyGuard estricto, y `_disableInitializers()` en el constructor del implementation. El modelo optimista de withdraw es aceptable para testnet (griefing = impago, no robo) pero la decisión de lock explícito debe tomarse antes de mainnet.
