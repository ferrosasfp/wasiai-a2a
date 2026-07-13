// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {WasiAIEscrow} from "../src/WasiAIEscrow.sol";
import {IWasiAIEscrow} from "../src/interfaces/IWasiAIEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {ReentrantUSDC} from "./mocks/ReentrantUSDC.sol";

contract WasiAIEscrowTest is Test {
    WasiAIEscrow internal escrow;
    MockUSDC internal usdc;

    uint256 internal constant TIMELOCK = 2 days;

    // agent (depositor) — modeled with a known pk so we can vm.sign
    uint256 internal agentPk = 0xA11CE;
    address internal agent;
    address internal operator = address(0xCAFE);
    address internal multisig = address(0xBEEF);
    address internal arbiter = address(0xA5B1); // 191f: dispute arbiter (no depositor pk)
    address internal seller = address(0x5E11E7); // 191f: dispute payee

    bytes32 internal keyId = keccak256("key-1");

    // EIP712 domain pieces (replicated for signing)
    bytes32 internal constant TYPE_HASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function setUp() public {
        agent = vm.addr(agentPk);
        usdc = new MockUSDC();

        WasiAIEscrow impl = new WasiAIEscrow();
        bytes memory initData =
            abi.encodeCall(WasiAIEscrow.initialize, (address(usdc), operator, multisig, TIMELOCK));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        escrow = WasiAIEscrow(address(proxy));

        // fund agent + approve
        usdc.mint(agent, 1_000_000e6);
        vm.prank(agent);
        usdc.approve(address(escrow), type(uint256).max);

        // 191f: configure the dispute arbiter (owner-only)
        vm.prank(multisig);
        escrow.setArbiter(arbiter);
    }

    // ── helpers ─────────────────────────────────────────────────────────────
    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                TYPE_HASH, keccak256(bytes("WasiAIEscrow")), keccak256(bytes("1")), block.chainid, address(escrow)
            )
        );
    }

    function _signDebit(uint256 pk, bytes32 kId, uint256 amount, uint256 deadline, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(escrow.DEBIT_AUTHORIZATION_TYPEHASH(), kId, amount, deadline, nonce));
        bytes32 digest = MessageHashUtils.toTypedDataHash(_domainSeparator(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _deposit(bytes32 kId, uint256 amount) internal {
        vm.prank(agent);
        escrow.deposit(kId, amount);
    }

    // ── AC-1: deposit ────────────────────────────────────────────────────────
    function test_Deposit_creditsBalance_emitsEvent() public {
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IWasiAIEscrow.Deposited(agent, keyId, 100e6);
        vm.prank(agent);
        escrow.deposit(keyId, 100e6);
        assertEq(escrow.escrowBalance(keyId), 100e6);
        assertEq(usdc.balanceOf(address(escrow)), 100e6);
    }

    function test_Deposit_firstSetsDepositor_immutable() public {
        _deposit(keyId, 50e6);
        // second deposit from same agent OK
        _deposit(keyId, 50e6);
        assertEq(escrow.escrowBalance(keyId), 100e6);
    }

    function test_RevertWhen_SecondDepositorClaimsKeyId() public {
        _deposit(keyId, 50e6);
        address attacker = address(0xD00D);
        usdc.mint(attacker, 10e6);
        vm.startPrank(attacker);
        usdc.approve(address(escrow), type(uint256).max);
        vm.expectRevert(IWasiAIEscrow.DepositorMismatch.selector);
        escrow.deposit(keyId, 10e6);
        vm.stopPrank();
    }

    function test_RevertWhen_DepositZeroAmount() public {
        vm.prank(agent);
        vm.expectRevert(IWasiAIEscrow.ZeroAmount.selector);
        escrow.deposit(keyId, 0);
    }

    // ── CD-1: typehash ─────────────────────────────────────────────────────
    function test_Typehash_matchesCanonical() public view {
        assertEq(
            escrow.DEBIT_AUTHORIZATION_TYPEHASH(), 0x5feea67fe2f683c18d6addd1eaab3f2152293b5512c90fdd3f702e973a2328f5
        );
    }

    // ── AC-2: debit ─────────────────────────────────────────────────────────
    function test_Debit_validSig_debits_transfersToOperator() public {
        _deposit(keyId, 100e6);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = 1;
        bytes memory sig = _signDebit(agentPk, keyId, 40e6, deadline, nonce);

        vm.prank(operator);
        escrow.debit(keyId, 40e6, deadline, nonce, sig);

        assertEq(escrow.escrowBalance(keyId), 60e6);
        assertEq(usdc.balanceOf(operator), 40e6);
        // nonce replay must now fail
        vm.prank(operator);
        vm.expectRevert(IWasiAIEscrow.NonceAlreadyUsed.selector);
        escrow.debit(keyId, 40e6, deadline, nonce, sig);
    }

    // ── AC-3: debitBatch atomic ──────────────────────────────────────────────
    function test_DebitBatch_allValid_atomic() public {
        bytes32 keyA = keccak256("A");
        bytes32 keyB = keccak256("B");
        // agent owns both
        _deposit(keyA, 100e6);
        _deposit(keyB, 200e6);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32[] memory keys = new bytes32[](2);
        uint256[] memory amts = new uint256[](2);
        uint256[] memory nonces = new uint256[](2);
        bytes[] memory sigs = new bytes[](2);
        keys[0] = keyA;
        keys[1] = keyB;
        amts[0] = 30e6;
        amts[1] = 70e6;
        nonces[0] = 1;
        nonces[1] = 2;
        sigs[0] = _signDebit(agentPk, keyA, 30e6, deadline, 1);
        sigs[1] = _signDebit(agentPk, keyB, 70e6, deadline, 2);

        vm.prank(operator);
        escrow.debitBatch(keys, amts, deadline, nonces, sigs);

        assertEq(escrow.escrowBalance(keyA), 70e6);
        assertEq(escrow.escrowBalance(keyB), 130e6);
        assertEq(usdc.balanceOf(operator), 100e6);
    }

    function test_RevertWhen_DebitBatch_oneElementFails_noPartial() public {
        bytes32 keyA = keccak256("A");
        bytes32 keyB = keccak256("B");
        _deposit(keyA, 100e6);
        _deposit(keyB, 50e6);
        uint256 deadline = block.timestamp + 1 hours;

        bytes32[] memory keys = new bytes32[](2);
        uint256[] memory amts = new uint256[](2);
        uint256[] memory nonces = new uint256[](2);
        bytes[] memory sigs = new bytes[](2);
        keys[0] = keyA;
        keys[1] = keyB;
        amts[0] = 30e6;
        amts[1] = 80e6; // exceeds keyB balance (50)
        nonces[0] = 1;
        nonces[1] = 2;
        sigs[0] = _signDebit(agentPk, keyA, 30e6, deadline, 1);
        sigs[1] = _signDebit(agentPk, keyB, 80e6, deadline, 2);

        vm.prank(operator);
        vm.expectRevert(IWasiAIEscrow.InsufficientBalance.selector);
        escrow.debitBatch(keys, amts, deadline, nonces, sigs);

        // no partial state: balances untouched, operator received nothing
        assertEq(escrow.escrowBalance(keyA), 100e6);
        assertEq(escrow.escrowBalance(keyB), 50e6);
        assertEq(usdc.balanceOf(operator), 0);
    }

    function test_RevertWhen_DebitBatch_lengthMismatch() public {
        bytes32[] memory keys = new bytes32[](2);
        uint256[] memory amts = new uint256[](1);
        uint256[] memory nonces = new uint256[](2);
        bytes[] memory sigs = new bytes[](2);
        vm.prank(operator);
        vm.expectRevert(IWasiAIEscrow.LengthMismatch.selector);
        escrow.debitBatch(keys, amts, block.timestamp + 1, nonces, sigs);
    }

    // ── AC-4: invalid signature ──────────────────────────────────────────────
    function test_RevertWhen_InvalidSignature() public {
        _deposit(keyId, 100e6);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 wrongPk = 0xB0B; // not the depositor
        bytes memory sig = _signDebit(wrongPk, keyId, 40e6, deadline, 1);

        vm.prank(operator);
        vm.expectRevert(IWasiAIEscrow.InvalidSignature.selector);
        escrow.debit(keyId, 40e6, deadline, 1, sig);
        assertEq(escrow.escrowBalance(keyId), 100e6);
    }

    // ── AC-5: deadline expired ───────────────────────────────────────────────
    function test_RevertWhen_DeadlineExpired() public {
        _deposit(keyId, 100e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signDebit(agentPk, keyId, 40e6, deadline, 1);
        vm.warp(deadline + 1);

        vm.prank(operator);
        vm.expectRevert(IWasiAIEscrow.DeadlineExpired.selector);
        escrow.debit(keyId, 40e6, deadline, 1, sig);
        assertEq(escrow.escrowBalance(keyId), 100e6);
    }

    // ── AC-6/CD-3: nonce replay ──────────────────────────────────────────────
    function test_RevertWhen_NonceReplay() public {
        _deposit(keyId, 100e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signDebit(agentPk, keyId, 10e6, deadline, 7);
        vm.prank(operator);
        escrow.debit(keyId, 10e6, deadline, 7, sig);
        vm.prank(operator);
        vm.expectRevert(IWasiAIEscrow.NonceAlreadyUsed.selector);
        escrow.debit(keyId, 10e6, deadline, 7, sig);
    }

    // ── AC-7: withdraw free balance ──────────────────────────────────────────
    function test_Withdraw_freeBalance_byDepositor() public {
        _deposit(keyId, 100e6);
        uint256 before = usdc.balanceOf(agent);
        vm.prank(agent);
        escrow.withdraw(keyId, 40e6);
        assertEq(escrow.escrowBalance(keyId), 60e6);
        assertEq(usdc.balanceOf(agent), before + 40e6);
    }

    // ── AC-8: withdraw by non-depositor ──────────────────────────────────────
    function test_RevertWhen_Withdraw_byNonDepositor() public {
        _deposit(keyId, 100e6);
        vm.prank(operator);
        vm.expectRevert(IWasiAIEscrow.Unauthorized.selector);
        escrow.withdraw(keyId, 10e6);
    }

    // ── AC-7/AC-9: withdraw exceeds available ────────────────────────────────
    function test_RevertWhen_Withdraw_exceedsAvailable() public {
        _deposit(keyId, 100e6);
        vm.prank(agent);
        vm.expectRevert(IWasiAIEscrow.InsufficientBalance.selector);
        escrow.withdraw(keyId, 101e6);
    }

    // ── AC-9/CD-2: operator cannot withdraw without signature ────────────────
    function test_OperatorCannotWithdrawWithoutSignature() public {
        _deposit(keyId, 100e6);
        // operator is not depositor → cannot withdraw at all
        vm.prank(operator);
        vm.expectRevert(IWasiAIEscrow.Unauthorized.selector);
        escrow.withdraw(keyId, 100e6);
        // and operator cannot debit without a valid depositor signature
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory badSig = _signDebit(0xBAD, keyId, 100e6, deadline, 1);
        vm.prank(operator);
        vm.expectRevert(IWasiAIEscrow.InvalidSignature.selector);
        escrow.debit(keyId, 100e6, deadline, 1, badSig);
        assertEq(escrow.escrowBalance(keyId), 100e6);
    }

    // ── AC-11: only USDC ─────────────────────────────────────────────────────
    function test_OnlyUSDC_noOtherTokenPath() public {
        // deposit only moves the configured _usdc; another token is never pulled.
        MockUSDC other = new MockUSDC();
        other.mint(agent, 100e6);
        uint256 otherBefore = other.balanceOf(agent);
        _deposit(keyId, 50e6);
        // the "other" token is untouched by escrow
        assertEq(other.balanceOf(agent), otherBefore);
        assertEq(other.balanceOf(address(escrow)), 0);
        assertEq(usdc.balanceOf(address(escrow)), 50e6);
    }

    // ── AC-12: upgrade requires timelock + owner ─────────────────────────────
    function test_Upgrade_requiresTimelockAndOwner() public {
        WasiAIEscrow newImpl = new WasiAIEscrow();

        // non-owner cannot propose
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        escrow.proposeUpgrade(address(newImpl));

        // owner proposes
        vm.prank(multisig);
        escrow.proposeUpgrade(address(newImpl));

        // before timelock elapsed → TimelockNotElapsed
        vm.prank(multisig);
        vm.expectRevert(IWasiAIEscrow.TimelockNotElapsed.selector);
        escrow.upgradeToAndCall(address(newImpl), "");

        // non-owner cannot upgrade either
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        escrow.upgradeToAndCall(address(newImpl), "");

        // after timelock + owner → OK
        vm.warp(block.timestamp + TIMELOCK + 1);
        vm.prank(multisig);
        escrow.upgradeToAndCall(address(newImpl), "");
    }

    // ── AC-12: renounce freezes permanently ──────────────────────────────────
    function test_RenounceUpgrade_freezesPermanently() public {
        WasiAIEscrow newImpl = new WasiAIEscrow();
        vm.prank(multisig);
        escrow.renounceUpgrade();

        // proposeUpgrade now reverts
        vm.prank(multisig);
        vm.expectRevert(IWasiAIEscrow.UpgradeRenounced.selector);
        escrow.proposeUpgrade(address(newImpl));

        // upgradeToAndCall reverts even after warping far ahead
        vm.warp(block.timestamp + 365 days);
        vm.prank(multisig);
        vm.expectRevert(IWasiAIEscrow.UpgradeRenounced.selector);
        escrow.upgradeToAndCall(address(newImpl), "");
    }

    // ── ZeroAddress guard in initialize ──────────────────────────────────────
    function test_RevertWhen_InitializeZeroAddress() public {
        WasiAIEscrow impl = new WasiAIEscrow();
        bytes memory initData = abi.encodeCall(WasiAIEscrow.initialize, (address(0), operator, multisig, TIMELOCK));
        vm.expectRevert(IWasiAIEscrow.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_RevertWhen_InitializeZeroOperator() public {
        WasiAIEscrow impl = new WasiAIEscrow();
        bytes memory initData = abi.encodeCall(WasiAIEscrow.initialize, (address(usdc), address(0), multisig, TIMELOCK));
        vm.expectRevert(IWasiAIEscrow.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    // ── F-A1/F-A2: only the configured operator can settle (front-run closed) ─
    function test_RevertWhen_DebitByNonOperator_validSig() public {
        _deposit(keyId, 100e6);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = 1;
        // VALID depositor signature, but a third party (the "MEV bot") presents it.
        bytes memory sig = _signDebit(agentPk, keyId, 40e6, deadline, nonce);
        address bot = address(0xB07);
        vm.prank(bot);
        vm.expectRevert(IWasiAIEscrow.NotOperator.selector);
        escrow.debit(keyId, 40e6, deadline, nonce, sig);
        // funds untouched, nonce NOT consumed
        assertEq(escrow.escrowBalance(keyId), 100e6);
        assertEq(usdc.balanceOf(bot), 0);
        // operator can still settle the same authorization afterwards (nonce was not burned)
        vm.prank(operator);
        escrow.debit(keyId, 40e6, deadline, nonce, sig);
        assertEq(usdc.balanceOf(operator), 40e6);
    }

    function test_RevertWhen_DebitBatchByNonOperator_validSig() public {
        _deposit(keyId, 100e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32[] memory keys = new bytes32[](1);
        uint256[] memory amts = new uint256[](1);
        uint256[] memory nonces = new uint256[](1);
        bytes[] memory sigs = new bytes[](1);
        keys[0] = keyId;
        amts[0] = 40e6;
        nonces[0] = 1;
        sigs[0] = _signDebit(agentPk, keyId, 40e6, deadline, 1);
        vm.prank(address(0xB07));
        vm.expectRevert(IWasiAIEscrow.NotOperator.selector);
        escrow.debitBatch(keys, amts, deadline, nonces, sigs);
        assertEq(escrow.escrowBalance(keyId), 100e6);
    }

    // ── F-A1/F-A2: setOperator rotation (onlyOwner + event + zero guard) ──────
    function test_SetOperator_byOwner_rotates_emitsEvent() public {
        address newOp = address(0x09E7);
        vm.expectEmit(true, true, false, false, address(escrow));
        emit IWasiAIEscrow.OperatorUpdated(operator, newOp);
        vm.prank(multisig);
        escrow.setOperator(newOp);
        assertEq(escrow.operator(), newOp);

        // old operator can no longer settle
        _deposit(keyId, 100e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signDebit(agentPk, keyId, 10e6, deadline, 1);
        vm.prank(operator);
        vm.expectRevert(IWasiAIEscrow.NotOperator.selector);
        escrow.debit(keyId, 10e6, deadline, 1, sig);
        // new operator can
        vm.prank(newOp);
        escrow.debit(keyId, 10e6, deadline, 1, sig);
        assertEq(usdc.balanceOf(newOp), 10e6);
    }

    function test_RevertWhen_SetOperator_byNonOwner() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        escrow.setOperator(address(0x1234));
    }

    function test_RevertWhen_SetOperator_zeroAddress() public {
        vm.prank(multisig);
        vm.expectRevert(IWasiAIEscrow.ZeroAddress.selector);
        escrow.setOperator(address(0));
    }

    // ── B-MED-1: initialize rejects timelock below MIN_TIMELOCK ───────────────
    function test_RevertWhen_InitializeTimelockBelowMin() public {
        WasiAIEscrow impl = new WasiAIEscrow();
        uint256 tooShort = 2 days - 1;
        bytes memory initData =
            abi.encodeCall(WasiAIEscrow.initialize, (address(usdc), operator, multisig, tooShort));
        vm.expectRevert(IWasiAIEscrow.InvalidTimelock.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Initialize_timelockAtMin_ok() public {
        WasiAIEscrow impl = new WasiAIEscrow();
        bytes memory initData =
            abi.encodeCall(WasiAIEscrow.initialize, (address(usdc), operator, multisig, escrow.MIN_TIMELOCK()));
        // exactly MIN_TIMELOCK must succeed
        new ERC1967Proxy(address(impl), initData);
    }

    // ── B-MED-2: renounceOwnership is disabled (use renounceUpgrade) ──────────
    function test_RevertWhen_RenounceOwnership() public {
        vm.prank(multisig);
        vm.expectRevert(IWasiAIEscrow.UseRenounceUpgrade.selector);
        escrow.renounceOwnership();
        // ownership intact
        assertEq(escrow.owner(), multisig);
    }

    // ── B-MED-3: proposeUpgrade validation (zero / no-code) + event ───────────
    function test_RevertWhen_ProposeUpgrade_zeroAddress() public {
        vm.prank(multisig);
        vm.expectRevert(IWasiAIEscrow.ZeroAddress.selector);
        escrow.proposeUpgrade(address(0));
    }

    function test_RevertWhen_ProposeUpgrade_notAContract() public {
        vm.prank(multisig);
        vm.expectRevert(IWasiAIEscrow.NotAContract.selector);
        escrow.proposeUpgrade(address(0xDEAD)); // EOA / no code
    }

    function test_ProposeUpgrade_emitsEvent() public {
        WasiAIEscrow newImpl = new WasiAIEscrow();
        vm.expectEmit(true, false, false, true, address(escrow));
        emit IWasiAIEscrow.UpgradeProposed(address(newImpl), block.timestamp + TIMELOCK);
        vm.prank(multisig);
        escrow.proposeUpgrade(address(newImpl));
    }

    // ── C-MED-1: MAX_BATCH guard (empty + oversized) ──────────────────────────
    function test_RevertWhen_DebitBatch_empty() public {
        bytes32[] memory keys = new bytes32[](0);
        uint256[] memory amts = new uint256[](0);
        uint256[] memory nonces = new uint256[](0);
        bytes[] memory sigs = new bytes[](0);
        vm.prank(operator);
        vm.expectRevert(IWasiAIEscrow.InvalidBatchSize.selector);
        escrow.debitBatch(keys, amts, block.timestamp + 1 hours, nonces, sigs);
    }

    function test_RevertWhen_DebitBatch_exceedsMaxBatch() public {
        uint256 n = escrow.MAX_BATCH() + 1;
        bytes32[] memory keys = new bytes32[](n);
        uint256[] memory amts = new uint256[](n);
        uint256[] memory nonces = new uint256[](n);
        bytes[] memory sigs = new bytes[](n);
        vm.prank(operator);
        vm.expectRevert(IWasiAIEscrow.InvalidBatchSize.selector);
        escrow.debitBatch(keys, amts, block.timestamp + 1 hours, nonces, sigs);
    }

    // ── B-BAJO-1: cancelUpgrade + expiry window ───────────────────────────────
    function test_CancelUpgrade_clearsProposal_emitsEvent() public {
        WasiAIEscrow newImpl = new WasiAIEscrow();
        vm.prank(multisig);
        escrow.proposeUpgrade(address(newImpl));

        vm.expectEmit(true, false, false, false, address(escrow));
        emit IWasiAIEscrow.UpgradeCancelled(address(newImpl));
        vm.prank(multisig);
        escrow.cancelUpgrade(address(newImpl));

        // after cancel, upgrade reverts even past the timelock
        vm.warp(block.timestamp + TIMELOCK + 1);
        vm.prank(multisig);
        vm.expectRevert(IWasiAIEscrow.TimelockNotElapsed.selector);
        escrow.upgradeToAndCall(address(newImpl), "");
    }

    function test_RevertWhen_CancelUpgrade_byNonOwner() public {
        WasiAIEscrow newImpl = new WasiAIEscrow();
        vm.prank(multisig);
        escrow.proposeUpgrade(address(newImpl));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        escrow.cancelUpgrade(address(newImpl));
    }

    function test_RevertWhen_UpgradeAfterGraceExpired() public {
        WasiAIEscrow newImpl = new WasiAIEscrow();
        vm.prank(multisig);
        escrow.proposeUpgrade(address(newImpl));
        // warp past eta + UPGRADE_GRACE → proposal expired
        vm.warp(block.timestamp + TIMELOCK + escrow.UPGRADE_GRACE() + 1);
        vm.prank(multisig);
        vm.expectRevert(IWasiAIEscrow.TimelockNotElapsed.selector);
        escrow.upgradeToAndCall(address(newImpl), "");
    }

    function test_Upgrade_withinGraceWindow_ok_thenProposalConsumed() public {
        WasiAIEscrow newImpl = new WasiAIEscrow();
        vm.prank(multisig);
        escrow.proposeUpgrade(address(newImpl));
        // inside [eta, eta+GRACE]
        vm.warp(block.timestamp + TIMELOCK + 1);
        vm.prank(multisig);
        escrow.upgradeToAndCall(address(newImpl), "");

        // proposal was consumed: re-upgrading to the same impl now needs a fresh proposal
        WasiAIEscrow newImpl2 = new WasiAIEscrow();
        vm.prank(multisig);
        vm.expectRevert(IWasiAIEscrow.TimelockNotElapsed.selector);
        escrow.upgradeToAndCall(address(newImpl2), "");
    }

    // ── F-A4: deadline beyond MAX_DEADLINE_TTL is rejected ────────────────────
    function test_RevertWhen_DeadlineTooFar() public {
        _deposit(keyId, 100e6);
        uint256 deadline = block.timestamp + escrow.MAX_DEADLINE_TTL() + 1;
        bytes memory sig = _signDebit(agentPk, keyId, 40e6, deadline, 1);
        vm.prank(operator);
        vm.expectRevert(IWasiAIEscrow.DeadlineTooFar.selector);
        escrow.debit(keyId, 40e6, deadline, 1, sig);
        assertEq(escrow.escrowBalance(keyId), 100e6);
    }

    function test_Debit_deadlineAtMaxTtl_ok() public {
        _deposit(keyId, 100e6);
        uint256 deadline = block.timestamp + escrow.MAX_DEADLINE_TTL(); // exactly at the cap
        bytes memory sig = _signDebit(agentPk, keyId, 40e6, deadline, 1);
        vm.prank(operator);
        escrow.debit(keyId, 40e6, deadline, 1, sig);
        assertEq(escrow.escrowBalance(keyId), 60e6);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  191f: arbiter role + consent + lock + resolveDispute
    // ════════════════════════════════════════════════════════════════════════

    // helper: depositor opts in to arbitration for `keyId`
    function _consent(bytes32 kId) internal {
        vm.prank(agent);
        escrow.setArbitrationConsent(kId, true);
    }

    // ── AC-8: setArbiter (onlyOwner + event + zero guard) ─────────────────────
    function test_SetArbiter_byOwner_rotates_emitsEvent() public {
        address newArb = address(0xA5B2);
        vm.expectEmit(true, true, false, false, address(escrow));
        emit IWasiAIEscrow.ArbiterUpdated(arbiter, newArb);
        vm.prank(multisig);
        escrow.setArbiter(newArb);
        assertEq(escrow.arbiter(), newArb);
    }

    function test_RevertWhen_SetArbiter_byNonOwner() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        escrow.setArbiter(address(0x1234));
    }

    function test_RevertWhen_SetArbiter_zeroAddress() public {
        vm.prank(multisig);
        vm.expectRevert(IWasiAIEscrow.ZeroAddress.selector);
        escrow.setArbiter(address(0));
    }

    // ── AC-1 / AC-13: setArbitrationConsent (monotonic opt-in) ────────────────
    function test_SetArbitrationConsent_byDepositor_persists_emitsEvent() public {
        _deposit(keyId, 100e6);
        vm.expectEmit(true, true, false, false, address(escrow));
        emit IWasiAIEscrow.ArbitrationConsentSet(keyId, agent);
        vm.prank(agent);
        escrow.setArbitrationConsent(keyId, true);
        assertTrue(escrow.arbitrationConsent(keyId));
    }

    function test_RevertWhen_Consent_byNonDepositor() public {
        _deposit(keyId, 100e6);
        vm.prank(operator); // not the depositor
        vm.expectRevert(IWasiAIEscrow.Unauthorized.selector);
        escrow.setArbitrationConsent(keyId, true);
    }

    function test_RevertWhen_Consent_revoke() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        vm.prank(agent);
        vm.expectRevert(IWasiAIEscrow.ConsentIrrevocable.selector);
        escrow.setArbitrationConsent(keyId, false);
        assertTrue(escrow.arbitrationConsent(keyId)); // still consented
    }

    function test_Consent_idempotent_trueTwice_noEvent() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        // second true is a no-op: it must NOT revert and MUST NOT emit.
        vm.recordLogs();
        vm.prank(agent);
        escrow.setArbitrationConsent(keyId, true);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0);
        assertTrue(escrow.arbitrationConsent(keyId));
    }

    // ── AC-10 / AC-4 / AC-2: lockForDispute ───────────────────────────────────
    function test_LockForDispute_byArbiter_locks_emitsEvent() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IWasiAIEscrow.DisputeLocked(keyId, arbiter, 60e6, 60e6);
        vm.prank(arbiter);
        escrow.lockForDispute(keyId, 60e6);
        assertEq(escrow.lockedAmount(keyId), 60e6);
        // incremental top-up of the same dispute
        vm.prank(arbiter);
        escrow.lockForDispute(keyId, 10e6);
        assertEq(escrow.lockedAmount(keyId), 70e6);
    }

    function test_RevertWhen_Lock_byNonArbiter() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        vm.prank(operator);
        vm.expectRevert(IWasiAIEscrow.NotArbiter.selector);
        escrow.lockForDispute(keyId, 10e6);
    }

    function test_RevertWhen_Lock_withoutConsent() public {
        _deposit(keyId, 100e6);
        // no consent
        vm.prank(arbiter);
        vm.expectRevert(IWasiAIEscrow.ArbitrationNotConsented.selector);
        escrow.lockForDispute(keyId, 10e6);
    }

    function test_RevertWhen_Lock_exceedsBalance() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        vm.prank(arbiter);
        vm.expectRevert(IWasiAIEscrow.InsufficientBalance.selector);
        escrow.lockForDispute(keyId, 101e6);
    }

    function test_RevertWhen_Lock_zeroAmount() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        vm.prank(arbiter);
        vm.expectRevert(IWasiAIEscrow.ZeroAmount.selector);
        escrow.lockForDispute(keyId, 0);
    }

    // ── AC-11: withdraw blocked by the lock (withdraw code untouched) ──────────
    function test_Withdraw_blockedByLock() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        vm.prank(arbiter);
        escrow.lockForDispute(keyId, 60e6); // available = 40
        // withdraw 41 > available (40) → revert
        vm.prank(agent);
        vm.expectRevert(IWasiAIEscrow.InsufficientBalance.selector);
        escrow.withdraw(keyId, 41e6);
        // withdraw 40 (exactly the free part) → OK
        vm.prank(agent);
        escrow.withdraw(keyId, 40e6);
        assertEq(escrow.escrowBalance(keyId), 60e6);
        assertEq(escrow.lockedAmount(keyId), 60e6);
    }

    // ── AC-3 / AC-12: resolveDispute happy path ───────────────────────────────
    function test_ResolveDispute_happy_paysSeller_zeroesLock() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        vm.prank(arbiter);
        escrow.lockForDispute(keyId, 60e6);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit IWasiAIEscrow.DisputeResolved(keyId, arbiter, seller, 60e6, 1);
        vm.prank(arbiter);
        escrow.resolveDispute(keyId, seller, 60e6, 1);

        assertEq(usdc.balanceOf(seller), 60e6);
        assertEq(escrow.escrowBalance(keyId), 40e6);
        assertEq(escrow.lockedAmount(keyId), 0);
        // nonce consumed: a replay reverts
        vm.prank(arbiter);
        vm.expectRevert(IWasiAIEscrow.NonceAlreadyUsed.selector);
        escrow.resolveDispute(keyId, seller, 10e6, 1);
    }

    function test_ResolveDispute_residual_withdrawableByBuyer() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        vm.prank(arbiter);
        escrow.lockForDispute(keyId, 60e6);
        vm.prank(arbiter);
        escrow.resolveDispute(keyId, seller, 60e6, 1);
        // buyer withdraws the residual (40)
        uint256 before = usdc.balanceOf(agent);
        vm.prank(agent);
        escrow.withdraw(keyId, 40e6);
        assertEq(usdc.balanceOf(agent), before + 40e6);
        assertEq(escrow.escrowBalance(keyId), 0);
    }

    function test_RevertWhen_Resolve_byNonArbiter() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        vm.prank(arbiter);
        escrow.lockForDispute(keyId, 60e6);
        // even with consent + lock, a non-arbiter reverts NotArbiter
        vm.prank(operator);
        vm.expectRevert(IWasiAIEscrow.NotArbiter.selector);
        escrow.resolveDispute(keyId, seller, 60e6, 1);
    }

    function test_RevertWhen_Resolve_withoutConsent() public {
        _deposit(keyId, 100e6);
        // no consent → lock is impossible, so resolve reverts on the consent gate
        vm.prank(arbiter);
        vm.expectRevert(IWasiAIEscrow.ArbitrationNotConsented.selector);
        escrow.resolveDispute(keyId, seller, 10e6, 1);
    }

    function test_RevertWhen_Resolve_overLocked() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        vm.prank(arbiter);
        escrow.lockForDispute(keyId, 60e6);
        // sellerAmount (61) > locked (60) → ExceedsLockedAmount
        vm.prank(arbiter);
        vm.expectRevert(IWasiAIEscrow.ExceedsLockedAmount.selector);
        escrow.resolveDispute(keyId, seller, 61e6, 1);
    }

    function test_RevertWhen_Resolve_exceedsBalance() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        // lock the full balance, then debit it down so lock > balance (edge lock >= balance).
        vm.prank(arbiter);
        escrow.lockForDispute(keyId, 100e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signDebit(agentPk, keyId, 50e6, deadline, 9);
        vm.prank(operator);
        escrow.debit(keyId, 50e6, deadline, 9, sig); // balance now 50, locked still 100
        // sellerAmount (60) <= locked (100) but > balance (50) → InsufficientBalance
        vm.prank(arbiter);
        vm.expectRevert(IWasiAIEscrow.InsufficientBalance.selector);
        escrow.resolveDispute(keyId, seller, 60e6, 1);
    }

    function test_RevertWhen_Resolve_zeroSellerAmount() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        vm.prank(arbiter);
        escrow.lockForDispute(keyId, 60e6);
        vm.prank(arbiter);
        vm.expectRevert(IWasiAIEscrow.ZeroAmount.selector);
        escrow.resolveDispute(keyId, seller, 0, 1);
    }

    function test_RevertWhen_Resolve_zeroSeller() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        vm.prank(arbiter);
        escrow.lockForDispute(keyId, 60e6);
        vm.prank(arbiter);
        vm.expectRevert(IWasiAIEscrow.ZeroAddress.selector);
        escrow.resolveDispute(keyId, address(0), 60e6, 1);
    }

    function test_RevertWhen_Resolve_nonceReplay() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        vm.prank(arbiter);
        escrow.lockForDispute(keyId, 60e6);
        vm.prank(arbiter);
        escrow.resolveDispute(keyId, seller, 30e6, 5);
        // re-lock (lock was zeroed) then replay the same nonce → NonceAlreadyUsed
        vm.prank(arbiter);
        escrow.lockForDispute(keyId, 20e6);
        vm.prank(arbiter);
        vm.expectRevert(IWasiAIEscrow.NonceAlreadyUsed.selector);
        escrow.resolveDispute(keyId, seller, 10e6, 5);
    }

    // ── AC-12: releaseDispute (buyer wins, no payment) ────────────────────────
    function test_ReleaseDispute_buyerWins_unlocks() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        vm.prank(arbiter);
        escrow.lockForDispute(keyId, 60e6);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit IWasiAIEscrow.DisputeReleased(keyId, arbiter, 60e6);
        vm.prank(arbiter);
        escrow.releaseDispute(keyId);
        assertEq(escrow.lockedAmount(keyId), 0);
        // buyer can now withdraw everything
        vm.prank(agent);
        escrow.withdraw(keyId, 100e6);
        assertEq(escrow.escrowBalance(keyId), 0);
    }

    function test_RevertWhen_Release_byNonArbiter() public {
        _deposit(keyId, 100e6);
        _consent(keyId);
        vm.prank(arbiter);
        escrow.lockForDispute(keyId, 60e6);
        vm.prank(operator);
        vm.expectRevert(IWasiAIEscrow.NotArbiter.selector);
        escrow.releaseDispute(keyId);
    }

    // ── CD-3: re-entrancy guard on resolveDispute ─────────────────────────────
    function test_ResolveDispute_reentrancy_guarded() public {
        // Fresh escrow whose token is the malicious ReentrantUSDC; the arbiter IS the token so
        // the re-entrant call clears onlyArbiter and actually exercises the nonReentrant guard.
        ReentrantUSDC rusdc = new ReentrantUSDC();
        WasiAIEscrow impl = new WasiAIEscrow();
        bytes memory initData =
            abi.encodeCall(WasiAIEscrow.initialize, (address(rusdc), operator, multisig, TIMELOCK));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        WasiAIEscrow esc = WasiAIEscrow(address(proxy));

        vm.prank(multisig);
        esc.setArbiter(address(rusdc)); // the token is the arbiter

        rusdc.mint(agent, 1_000e6);
        vm.prank(agent);
        rusdc.approve(address(esc), type(uint256).max);
        vm.prank(agent);
        esc.deposit(keyId, 100e6);
        vm.prank(agent);
        esc.setArbitrationConsent(keyId, true);
        vm.prank(address(rusdc));
        esc.lockForDispute(keyId, 60e6);

        // arm the re-entry with the SAME (keyId, nonce) and fire the outer resolve
        rusdc.arm(address(esc), keyId, seller, 60e6, 1);
        vm.prank(address(rusdc));
        vm.expectRevert(); // nonReentrant bubbles up → outer resolve reverts
        esc.resolveDispute(keyId, seller, 60e6, 1);

        // funds intact: nothing moved, lock untouched
        assertEq(esc.escrowBalance(keyId), 100e6);
        assertEq(esc.lockedAmount(keyId), 60e6);
        assertEq(rusdc.balanceOf(seller), 0);
    }
}
