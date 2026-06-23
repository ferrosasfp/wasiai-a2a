// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IWasiAIEscrow — ABI surface of the non-custodial USDC escrow (WKH-126a).
/// @notice Converges byte-a-byte with the TS view in `src/adapters/escrow/abi.ts` (WKH-126b).
interface IWasiAIEscrow {
    // ── Events ──────────────────────────────────────────────────────────────
    /// @dev Order and `indexed` flags EXACT per ESCROW_ABI (abi.ts).
    event Deposited(address indexed depositor, bytes32 indexed keyId, uint256 amount);

    // ── Governance / operator events (MNR-2, B-MED-3, B-BAJO-1) ───────────────
    /// @dev Emitted when the operator that may settle debits is rotated (F-A1/F-A2).
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);
    /// @dev Emitted when an upgrade is proposed (B-MED-3). `eta` = earliest valid timestamp.
    event UpgradeProposed(address indexed impl, uint256 eta);
    /// @dev Emitted when a pending upgrade proposal is cancelled (B-BAJO-1).
    event UpgradeCancelled(address indexed impl);
    /// @dev Emitted when upgradeability is permanently renounced (MNR-2).
    event UpgradeRenouncedEvent();

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
    // ── Audit fix-pack errors ────────────────────────────────────────────────
    error NotOperator(); // F-A1/F-A2: caller is not the configured operator
    error InvalidTimelock(); // B-MED-1: timelockDelay < MIN_TIMELOCK
    error UseRenounceUpgrade(); // B-MED-2: Ownable.renounceOwnership disabled
    error NotAContract(); // B-MED-3: proposed impl has no code
    error InvalidBatchSize(); // C-MED-1: batch empty or > MAX_BATCH
    error DeadlineTooFar(); // F-A4: deadline beyond MAX_DEADLINE_TTL window

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

    /// @dev Rotate the operator allowed to settle debits (onlyOwner). F-A1/F-A2.
    function setOperator(address newOperator) external;

    /// @dev Cancel a pending upgrade proposal (onlyOwner). B-BAJO-1.
    function cancelUpgrade(address impl) external;
}
