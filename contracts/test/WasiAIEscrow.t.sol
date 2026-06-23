// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {WasiAIEscrow} from "../src/WasiAIEscrow.sol";
import {IWasiAIEscrow} from "../src/interfaces/IWasiAIEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract WasiAIEscrowTest is Test {
    WasiAIEscrow internal escrow;
    MockUSDC internal usdc;

    uint256 internal constant TIMELOCK = 2 days;

    // agent (depositor) — modeled with a known pk so we can vm.sign
    uint256 internal agentPk = 0xA11CE;
    address internal agent;
    address internal operator = address(0xCAFE);
    address internal multisig = address(0xBEEF);

    bytes32 internal keyId = keccak256("key-1");

    // EIP712 domain pieces (replicated for signing)
    bytes32 internal constant TYPE_HASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function setUp() public {
        agent = vm.addr(agentPk);
        usdc = new MockUSDC();

        WasiAIEscrow impl = new WasiAIEscrow();
        bytes memory initData = abi.encodeCall(WasiAIEscrow.initialize, (address(usdc), multisig, TIMELOCK));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        escrow = WasiAIEscrow(address(proxy));

        // fund agent + approve
        usdc.mint(agent, 1_000_000e6);
        vm.prank(agent);
        usdc.approve(address(escrow), type(uint256).max);
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
        bytes memory initData = abi.encodeCall(WasiAIEscrow.initialize, (address(0), multisig, TIMELOCK));
        vm.expectRevert(IWasiAIEscrow.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }
}
