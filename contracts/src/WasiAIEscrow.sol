// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IWasiAIEscrow} from "./interfaces/IWasiAIEscrow.sol";

/// @title WasiAIEscrow — non-custodial prepaid USDC escrow per Agent Key (WKH-126a).
/// @notice The operator NEVER moves `balances[keyId]` without an EIP-712 `DebitAuthorization`
///         signed by `depositor[keyId]` (CD-2). UUPS upgradeable + timelock + renounce.
/// @dev Settlement is restricted to a single configured `_operator` (F-A1/F-A2): only that
///      address may call `debit`/`debitBatch`. This closes the mempool front-running / MEV
///      vector — a third party replaying a valid signature can no longer steal the transfer
///      (the funds always go to `msg.sender`, which is now constrained to the operator).
/// @dev EXTERNAL RISK ACCEPTED (Audit C MNR-1): USDC is a Circle-controlled token that can be
///      paused or blocklist this contract's address. If that happens, deposit/debit/withdraw
///      all revert and funds are frozen at the token level. This is inherent to custodying USDC
///      and cannot be mitigated on-chain; it is a known, accepted external risk.
contract WasiAIEscrow is
    Initializable,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    EIP712Upgradeable,
    IWasiAIEscrow
{
    using SafeERC20 for IERC20;

    // ── EIP-712 typehash (CD-1) — byte-a-byte with eip712.ts ────────────────
    // == 0x5feea67fe2f683c18d6addd1eaab3f2152293b5512c90fdd3f702e973a2328f5
    bytes32 public constant DEBIT_AUTHORIZATION_TYPEHASH =
        keccak256("DebitAuthorization(bytes32 keyId,uint256 amount,uint256 deadline,uint256 nonce)");

    // ── Constants (audit fix-pack) ───────────────────────────────────────────
    uint256 public constant MIN_TIMELOCK = 2 days; // B-MED-1: floor for upgrade timelock
    uint256 public constant MAX_BATCH = 256; // C-MED-1: cap on debitBatch size
    uint256 public constant UPGRADE_GRACE = 7 days; // B-BAJO-1: upgrade execution window after eta
    uint256 public constant MAX_DEADLINE_TTL = 1 hours; // F-A4: max future window for a signed deadline

    // ── Storage (UUPS-safe; CD-9 — order stable, __gap last) ────────────────
    IERC20 internal _usdc; // single token (DT-6, CD-5) — set in initialize
    uint256 internal _upgradeTimelock; // UPGRADE_TIMELOCK seconds (AC-12)
    bool internal _upgradeRenounced; // true => upgrade disabled permanently (AC-12)

    mapping(bytes32 => uint256) internal _balances; // keyId => USDC balance (6 dec)
    mapping(bytes32 => address) internal _depositor; // keyId => immutable owner (DT-10/CD-8)
    mapping(bytes32 => uint256) internal _lockedAmount; // keyId => committed (DT-11) — stays 0 (optimistic)
    mapping(bytes32 => mapping(uint256 => bool)) internal _usedNonces; // keyId => nonce => used (CD-3)
    mapping(bytes32 => uint256) internal _upgradeProposedAt; // keccak(newImpl) => proposal ts (DT-12)
    address internal _operator; // F-A1/F-A2: the only address allowed to settle debits

    // ── 191f: arbiter role + consent (consume 2 slots of __gap; CD-1) ─────────
    address internal _arbiter;                            // NEW — was __gap[0]
    mapping(bytes32 => bool) internal _arbitrationConsent; // NEW — was __gap[1]

    uint256[41] private __gap; // was 43; -2 for _arbiter + _arbitrationConsent (191f, CD-1)

    // ── Auxiliary event (auditability) ──────────────────────────────────────
    event Debited(bytes32 indexed keyId, address indexed operator, uint256 amount, uint256 nonce);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param usdc          the single USDC token (DT-6, CD-5).
    /// @param operator_      the only address allowed to settle debits (F-A1/F-A2).
    /// @param owner_         the proxy owner (multisig, NOT the deployer EOA) — AC-12 / MNR-1.
    /// @param timelockDelay  upgrade timelock in seconds; MUST be >= MIN_TIMELOCK (B-MED-1).
    function initialize(address usdc, address operator_, address owner_, uint256 timelockDelay) external initializer {
        if (usdc == address(0) || operator_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (timelockDelay < MIN_TIMELOCK) revert InvalidTimelock(); // B-MED-1
        __UUPSUpgradeable_init();
        __Ownable_init(owner_); // OZ v5: owner = multisig (NOT the deployer EOA) — AC-12
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        __EIP712_init("WasiAIEscrow", "1"); // CD-1: name/version EXACT
        _usdc = IERC20(usdc);
        _upgradeTimelock = timelockDelay;
        _operator = operator_; // F-A1/F-A2
        emit OperatorUpdated(address(0), operator_);
    }

    /// @notice The address currently allowed to settle debits (F-A1/F-A2).
    function operator() external view returns (address) {
        return _operator;
    }

    /// @notice Rotate the operator allowed to settle debits. Only owner (MNR-2 governance event).
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        address old = _operator;
        _operator = newOperator;
        emit OperatorUpdated(old, newOperator);
    }

    // ── 191f: arbiter role (rotable by owner) ────────────────────────────────
    /// @dev Every arbiter action requires msg.sender == _arbiter (CD-2). Until the owner
    ///      calls setArbiter() post-upgrade (191h), _arbiter == address(0) and onlyArbiter
    ///      reverts on every call, leaving the 3 arbiter functions inert.
    modifier onlyArbiter() {
        if (msg.sender != _arbiter) revert NotArbiter();
        _;
    }

    /// @notice The address currently allowed to act as the dispute arbiter (191f).
    function arbiter() external view returns (address) {
        return _arbiter;
    }

    /// @notice Rotate the dispute arbiter. Only owner. AC-8.
    function setArbiter(address newArbiter) external onlyOwner {
        if (newArbiter == address(0)) revert ZeroAddress();
        address old = _arbiter;
        _arbiter = newArbiter;
        emit ArbiterUpdated(old, newArbiter);
    }

    // ── 191f: arbitration consent (monotonic / irrevocable opt-in) ───────────
    /// @notice Whether the depositor of `keyId` has opted in to arbitration (191f). AC-1.
    function arbitrationConsent(bytes32 keyId) external view returns (bool) {
        return _arbitrationConsent[keyId];
    }

    /// @notice Depositor opts in to arbitration for `keyId`. Monotonic: cannot be revoked. AC-1/AC-13.
    function setArbitrationConsent(bytes32 keyId, bool consent) external {
        if (msg.sender != _depositor[keyId]) revert Unauthorized(); // keyId sin depósito ⇒ _depositor==0 ⇒ revert
        if (!consent) revert ConsentIrrevocable(); // nunca puede pasar a false
        if (_arbitrationConsent[keyId]) return; // idempotente true→true (no-op, sin evento)
        _arbitrationConsent[keyId] = true;
        emit ArbitrationConsentSet(keyId, msg.sender);
    }

    // ── Deposit (CEI + nonReentrant + SafeERC20 + DT-10) ────────────────────
    function deposit(bytes32 keyId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        // depositor lock (DT-10/CD-8)
        if (_depositor[keyId] == address(0)) {
            _depositor[keyId] = msg.sender;
        } else if (msg.sender != _depositor[keyId]) {
            revert DepositorMismatch();
        }
        // Effects
        _balances[keyId] += amount;
        // Interactions
        _usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, keyId, amount);
    }

    function escrowBalance(bytes32 keyId) external view returns (uint256) {
        return _balances[keyId];
    }

    // ── Debit (operator settles against agent signature) ────────────────────
    function _verifyAndConsume(bytes32 keyId, uint256 amount, uint256 deadline, uint256 nonce, bytes calldata signature)
        internal
    {
        // 1. deadline lower bound (not expired)
        if (block.timestamp > deadline) revert DeadlineExpired();
        // 1b. deadline upper bound (F-A4): bound the live-signature window
        if (deadline > block.timestamp + MAX_DEADLINE_TTL) revert DeadlineTooFar();
        // 2. nonce not used (CD-3)
        if (_usedNonces[keyId][nonce]) revert NonceAlreadyUsed();
        // 3. recover EIP-712 (CD-1) — order EXACT: keyId, amount, deadline, nonce
        bytes32 structHash = keccak256(abi.encode(DEBIT_AUTHORIZATION_TYPEHASH, keyId, amount, deadline, nonce));
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != _depositor[keyId]) revert InvalidSignature(); // AC-4 / CD-2
        // 4. balance — cache _balances[keyId] (OP-2: avoid the redundant warm SLOAD)
        uint256 bal = _balances[keyId];
        if (amount > bal) revert InsufficientBalance();
        // Effects (CEI)
        _usedNonces[keyId][nonce] = true; // irrevocable (CD-3)
        _balances[keyId] = bal - amount; // debit BEFORE transfer
    }

    /// @notice Settle a single signed debit. Only the configured operator may call (F-A1/F-A2).
    /// @dev `amount` is the DELTA to debit for THIS authorization (one delta per nonce), NOT a
    ///      running net total. The app (126b) signs an incremental delta per nonce; presenting an
    ///      accumulated-net amount would over-debit. The contract enforces no on-chain net guard:
    ///      the delta convention lives in eip712.ts and is asserted by the 126a↔126b integration.
    function debit(bytes32 keyId, uint256 amount, uint256 deadline, uint256 nonce, bytes calldata signature)
        external
        nonReentrant
    {
        if (msg.sender != _operator) revert NotOperator(); // F-A1/F-A2
        _verifyAndConsume(keyId, amount, deadline, nonce, signature);
        _usdc.safeTransfer(msg.sender, amount); // to operator (DT-2)
        emit Debited(keyId, msg.sender, amount, nonce);
    }

    /// @notice Settle a batch of signed debits atomically. Only the operator may call (F-A1/F-A2).
    /// @dev Each `amounts[i]` is the DELTA to debit for that authorization (one delta per nonce),
    ///      NOT a running net total — same delta convention as `debit`. The batch is capped at
    ///      MAX_BATCH (C-MED-1) so an oversized batch reverts early and cheaply instead of failing
    ///      late with an out-of-gas. Reverts atomically if ANY element is invalid (no partial state).
    function debitBatch(
        bytes32[] calldata keyIds,
        uint256[] calldata amounts,
        uint256 deadline,
        uint256[] calldata nonces,
        bytes[] calldata signatures
    ) external nonReentrant {
        if (msg.sender != _operator) revert NotOperator(); // F-A1/F-A2
        uint256 len = keyIds.length; // OP-1: cache length
        if (len == 0 || len > MAX_BATCH) revert InvalidBatchSize(); // C-MED-1 (early, cheap)
        if (len != amounts.length || len != nonces.length || len != signatures.length) revert LengthMismatch();
        uint256 total = 0;
        for (uint256 i = 0; i < len;) {
            _verifyAndConsume(keyIds[i], amounts[i], deadline, nonces[i], signatures[i]);
            total += amounts[i];
            emit Debited(keyIds[i], msg.sender, amounts[i], nonces[i]);
            unchecked {
                ++i; // OP-1: i bounded by len (<= MAX_BATCH), overflow impossible
            }
        }
        // single aggregated transfer AFTER all effects (CEI)
        _usdc.safeTransfer(msg.sender, total);
    }

    // ── Withdraw (CEI + nonReentrant) ───────────────────────────────────────
    function withdraw(bytes32 keyId, uint256 amount) external nonReentrant {
        if (msg.sender != _depositor[keyId]) revert Unauthorized(); // AC-8
        uint256 available = _balances[keyId] - _lockedAmount[keyId]; // DT-11: lockedAmount == 0
        if (amount > available) revert InsufficientBalance(); // AC-7
        _balances[keyId] -= amount; // Effects
        _usdc.safeTransfer(msg.sender, amount); // Interactions
    }

    // ── 191f: dispute lock (arbiter freezes consented funds) ─────────────────
    /// @notice Amount of `keyId` currently locked for a dispute (191f). AC-10/AC-12.
    function lockedAmount(bytes32 keyId) external view returns (uint256) {
        return _lockedAmount[keyId];
    }

    /// @notice Arbiter freezes `amount` of a consented key for a dispute. Incremental. AC-10.
    /// @dev Requires msg.sender==_arbiter (CD-2) AND consent (CD-2). Keeps lock <= balance (CD-5/CD-8).
    function lockForDispute(bytes32 keyId, uint256 amount) external onlyArbiter {
        if (!_arbitrationConsent[keyId]) revert ArbitrationNotConsented();
        if (amount == 0) revert ZeroAmount();
        uint256 newLocked = _lockedAmount[keyId] + amount;
        if (newLocked > _balances[keyId]) revert InsufficientBalance();
        _lockedAmount[keyId] = newLocked; // incremental (top-up de la misma disputa)
        emit DisputeLocked(keyId, msg.sender, amount, newLocked);
    }

    /// @notice Arbiter releases the lock without paying (buyer wins). AC-12.
    function releaseDispute(bytes32 keyId) external onlyArbiter {
        uint256 locked = _lockedAmount[keyId];
        if (locked == 0) revert ZeroAmount();
        _lockedAmount[keyId] = 0;
        emit DisputeReleased(keyId, msg.sender, locked);
    }

    // ── 191f: resolveDispute (arbiter pays the seller from locked funds) ─────
    /// @notice Arbiter pays `sellerAmount` USDC to `seller` out of the locked funds of a
    ///         consented key, releasing the residual back to the buyer. AC-3/CD-2/CD-3/CD-4/CD-8/CD-9.
    /// @dev CEI strict: nonce + balance + lock mutated BEFORE the transfer. Pays the SELLER
    ///      (param), NOT msg.sender. nonReentrant + SafeERC20.
    function resolveDispute(bytes32 keyId, address seller, uint256 sellerAmount, uint256 nonce)
        external
        onlyArbiter
        nonReentrant
    {
        // Checks
        if (!_arbitrationConsent[keyId]) revert ArbitrationNotConsented(); // CD-2
        if (seller == address(0)) revert ZeroAddress();
        if (sellerAmount == 0) revert ZeroAmount();
        if (_usedNonces[keyId][nonce]) revert NonceAlreadyUsed(); // CD-4
        uint256 locked = _lockedAmount[keyId];
        if (sellerAmount > locked) revert ExceedsLockedAmount(); // CD-8
        uint256 bal = _balances[keyId];
        if (sellerAmount > bal) revert InsufficientBalance(); // CD-8
        // Effects (todo ANTES del transfer — CD-3)
        _usedNonces[keyId][nonce] = true;
        _balances[keyId] = bal - sellerAmount;
        _lockedAmount[keyId] = 0; // libera el residual al buyer
        // Interactions
        _usdc.safeTransfer(seller, sellerAmount); // paga al SELLER (no a msg.sender) — CD-9
        emit DisputeResolved(keyId, msg.sender, seller, sellerAmount, nonce);
    }

    // ── UUPS + owner multisig + timelock + renounce (AC-12) ─────────────────
    function proposeUpgrade(address newImpl) external onlyOwner {
        if (_upgradeRenounced) revert UpgradeRenounced();
        if (newImpl == address(0)) revert ZeroAddress(); // B-MED-3
        if (newImpl.code.length == 0) revert NotAContract(); // B-MED-3
        _upgradeProposedAt[keccak256(abi.encode(newImpl))] = block.timestamp;
        emit UpgradeProposed(newImpl, block.timestamp + _upgradeTimelock); // B-MED-3 / MNR-2
    }

    /// @notice Cancel a pending upgrade proposal (B-BAJO-1). Only owner.
    function cancelUpgrade(address impl) external onlyOwner {
        delete _upgradeProposedAt[keccak256(abi.encode(impl))];
        emit UpgradeCancelled(impl);
    }

    function renounceUpgrade() external onlyOwner {
        _upgradeRenounced = true;
        emit UpgradeRenouncedEvent(); // MNR-2
    }

    /// @notice Disabled — the ONLY way to renounce control is `renounceUpgrade` (B-MED-2).
    /// @dev Prevents `Ownable.renounceOwnership` from bricking governance with a divergent
    ///      terminal state (owner=0 but `_upgradeRenounced` still false).
    function renounceOwnership() public view override onlyOwner {
        revert UseRenounceUpgrade();
    }

    /// @dev Consumes the proposal: enforces the [eta, eta+GRACE] window (B-BAJO-1) and clears
    ///      the slot so a used proposal can never be replayed and never lingers forever.
    function _authorizeUpgrade(address newImpl) internal override onlyOwner {
        if (_upgradeRenounced) revert UpgradeRenounced();
        bytes32 slot = keccak256(abi.encode(newImpl));
        uint256 proposedAt = _upgradeProposedAt[slot];
        uint256 eta = proposedAt + _upgradeTimelock;
        if (proposedAt == 0 || block.timestamp < eta || block.timestamp > eta + UPGRADE_GRACE) {
            revert TimelockNotElapsed(); // B-BAJO-1: also rejects expired (past eta+GRACE) proposals
        }
        delete _upgradeProposedAt[slot]; // B-BAJO-1: consume, no replay / no lingering proposal
    }
}
