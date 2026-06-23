// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IWasiAIEscrow — ABI surface of the non-custodial USDC escrow (WKH-126a).
/// @notice Converges byte-a-byte with the TS view in `src/adapters/escrow/abi.ts` (WKH-126b).
interface IWasiAIEscrow {
    // ── Events ──────────────────────────────────────────────────────────────
    /// @dev Order and `indexed` flags EXACT per ESCROW_ABI (abi.ts).
    event Deposited(address indexed depositor, bytes32 indexed keyId, uint256 amount);

    // ── Custom errors ───────────────────────────────────────────────────────
    error ZeroAmount();
    error DepositorMismatch();
    error InvalidSignature();
    error DeadlineExpired();
    error NonceAlreadyUsed();
    error InsufficientBalance();
    error Unauthorized();
    error LengthMismatch();
    error TimelockNotElapsed();
    error UpgradeRenounced();
    error ZeroAddress();

    // ── Functions ───────────────────────────────────────────────────────────
    function deposit(bytes32 keyId, uint256 amount) external;

    function escrowBalance(bytes32 keyId) external view returns (uint256);

    function withdraw(bytes32 keyId, uint256 amount) external;

    /// @dev 5 args — includes explicit `nonce` (DT-14).
    function debit(bytes32 keyId, uint256 amount, uint256 deadline, uint256 nonce, bytes calldata signature) external;

    function debitBatch(
        bytes32[] calldata keyIds,
        uint256[] calldata amounts,
        uint256 deadline,
        uint256[] calldata nonces,
        bytes[] calldata signatures
    ) external;
}
