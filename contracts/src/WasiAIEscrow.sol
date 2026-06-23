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

    // ── Storage (UUPS-safe; CD-9 — order stable, __gap last) ────────────────
    IERC20 internal _usdc; // single token (DT-6, CD-5) — set in initialize
    uint256 internal _upgradeTimelock; // UPGRADE_TIMELOCK seconds (AC-12)
    bool internal _upgradeRenounced; // true => upgrade disabled permanently (AC-12)

    mapping(bytes32 => uint256) internal _balances; // keyId => USDC balance (6 dec)
    mapping(bytes32 => address) internal _depositor; // keyId => immutable owner (DT-10/CD-8)
    mapping(bytes32 => uint256) internal _lockedAmount; // keyId => committed (DT-11) — stays 0 (optimistic)
    mapping(bytes32 => mapping(uint256 => bool)) internal _usedNonces; // keyId => nonce => used (CD-3)
    mapping(bytes32 => uint256) internal _upgradeProposedAt; // keccak(newImpl) => proposal ts (DT-12)

    uint256[44] private __gap; // OZ upgradeability reserve

    // ── Auxiliary event (auditability) ──────────────────────────────────────
    event Debited(bytes32 indexed keyId, address indexed operator, uint256 amount, uint256 nonce);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address usdc, address multisig, uint256 timelockDelay) external initializer {
        if (usdc == address(0) || multisig == address(0)) revert ZeroAddress();
        __UUPSUpgradeable_init();
        __Ownable_init(multisig); // OZ v5: owner = multisig (NOT the deployer EOA) — AC-12
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        __EIP712_init("WasiAIEscrow", "1"); // CD-1: name/version EXACT
        _usdc = IERC20(usdc);
        _upgradeTimelock = timelockDelay;
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
        // 1. deadline
        if (block.timestamp > deadline) revert DeadlineExpired();
        // 2. nonce not used (CD-3)
        if (_usedNonces[keyId][nonce]) revert NonceAlreadyUsed();
        // 3. recover EIP-712 (CD-1) — order EXACT: keyId, amount, deadline, nonce
        bytes32 structHash = keccak256(abi.encode(DEBIT_AUTHORIZATION_TYPEHASH, keyId, amount, deadline, nonce));
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != _depositor[keyId]) revert InvalidSignature(); // AC-4 / CD-2
        // 4. balance
        if (amount > _balances[keyId]) revert InsufficientBalance();
        // Effects (CEI)
        _usedNonces[keyId][nonce] = true; // irrevocable (CD-3)
        _balances[keyId] -= amount; // debit BEFORE transfer
    }

    function debit(bytes32 keyId, uint256 amount, uint256 deadline, uint256 nonce, bytes calldata signature)
        external
        nonReentrant
    {
        _verifyAndConsume(keyId, amount, deadline, nonce, signature);
        _usdc.safeTransfer(msg.sender, amount); // to operator (DT-2)
        emit Debited(keyId, msg.sender, amount, nonce);
    }

    function debitBatch(
        bytes32[] calldata keyIds,
        uint256[] calldata amounts,
        uint256 deadline,
        uint256[] calldata nonces,
        bytes[] calldata signatures
    ) external nonReentrant {
        if (keyIds.length != amounts.length || keyIds.length != nonces.length || keyIds.length != signatures.length) revert LengthMismatch();
        uint256 total = 0;
        for (uint256 i = 0; i < keyIds.length; i++) {
            _verifyAndConsume(keyIds[i], amounts[i], deadline, nonces[i], signatures[i]);
            total += amounts[i];
            emit Debited(keyIds[i], msg.sender, amounts[i], nonces[i]);
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

    // ── UUPS + owner multisig + timelock + renounce (AC-12) ─────────────────
    function proposeUpgrade(address newImpl) external onlyOwner {
        if (_upgradeRenounced) revert UpgradeRenounced();
        _upgradeProposedAt[keccak256(abi.encode(newImpl))] = block.timestamp;
    }

    function renounceUpgrade() external onlyOwner {
        _upgradeRenounced = true;
    }

    function _authorizeUpgrade(address newImpl) internal view override onlyOwner {
        if (_upgradeRenounced) revert UpgradeRenounced();
        uint256 proposedAt = _upgradeProposedAt[keccak256(abi.encode(newImpl))];
        if (proposedAt == 0 || block.timestamp < proposedAt + _upgradeTimelock) {
            revert TimelockNotElapsed();
        }
    }
}
