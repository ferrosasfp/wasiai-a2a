// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {WasiAIEscrow} from "../src/WasiAIEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice Handler exposing bounded actions. The "operator" actor does NOT hold
///         the depositor pk, so it can never produce a valid DebitAuthorization.
contract EscrowHandler is Test {
    WasiAIEscrow internal escrow;
    MockUSDC internal usdc;

    uint256 internal agentPk = 0xA11CE;
    address internal agent;
    address internal operator = address(0xCAFE);

    bytes32 internal constant DOMAIN_TYPE_HASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // tracked keyIds (all owned by `agent`)
    bytes32[] internal keys;
    mapping(bytes32 => bool) internal known;

    // ghost accounting
    uint256 public ghost_totalDeposited;
    uint256 public ghost_totalDebited;
    uint256 public ghost_totalWithdrawn;
    uint256 public nonceCounter;

    constructor(WasiAIEscrow _escrow, MockUSDC _usdc) {
        escrow = _escrow;
        usdc = _usdc;
        agent = vm.addr(agentPk);
        usdc.mint(agent, 1e18);
        vm.prank(agent);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function trackedKeys() external view returns (bytes32[] memory) {
        return keys;
    }

    function _key(uint256 seed) internal returns (bytes32 k) {
        k = keccak256(abi.encode("key", seed % 5));
        if (!known[k]) {
            known[k] = true;
            keys.push(k);
        }
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPE_HASH,
                keccak256(bytes("WasiAIEscrow")),
                keccak256(bytes("1")),
                block.chainid,
                address(escrow)
            )
        );
    }

    function _sign(uint256 pk, bytes32 k, uint256 amount, uint256 deadline, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(escrow.DEBIT_AUTHORIZATION_TYPEHASH(), k, amount, deadline, nonce));
        bytes32 digest = MessageHashUtils.toTypedDataHash(_domainSeparator(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── actions ──────────────────────────────────────────────────────────────
    function deposit(uint256 seed, uint256 amount) external {
        amount = bound(amount, 1, 1e12);
        bytes32 k = _key(seed);
        if (usdc.balanceOf(agent) < amount) return;
        vm.prank(agent);
        escrow.deposit(k, amount);
        ghost_totalDeposited += amount;
    }

    function withdrawByAgent(uint256 seed, uint256 amount) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        uint256 bal = escrow.escrowBalance(k);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(agent);
        escrow.withdraw(k, amount);
        ghost_totalWithdrawn += amount;
    }

    /// @dev Operator settles with a VALID agent signature (the legitimate path).
    function debitByOperator(uint256 seed, uint256 amount) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        uint256 bal = escrow.escrowBalance(k);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = ++nonceCounter;
        bytes memory sig = _sign(agentPk, k, amount, deadline, nonce);
        vm.prank(operator);
        escrow.debit(k, amount, deadline, nonce, sig);
        ghost_totalDebited += amount;
    }

    /// @dev CD-2: operator tries to drain WITHOUT a depositor signature (forged pk).
    ///      Every such attempt MUST revert; ghost accounting is unchanged.
    function operatorDrainAttempt(uint256 seed, uint256 amount, uint256 forgedPk) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        forgedPk = bound(forgedPk, 1, type(uint128).max);
        if (forgedPk == agentPk) forgedPk += 1; // ensure NOT the depositor
        amount = bound(amount, 1, 1e12);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = ++nonceCounter;
        bytes memory sig = _sign(forgedPk, k, amount, deadline, nonce);
        vm.prank(operator);
        try escrow.debit(k, amount, deadline, nonce, sig) {
            // Must never succeed without depositor signature.
            revert("CD-2 VIOLATED: operator debited without depositor signature");
        } catch {
            // expected — forged signature rejected
        }
    }

    /// @dev Operator tries withdraw directly (not depositor) — must always revert.
    function operatorWithdrawAttempt(uint256 seed, uint256 amount) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        amount = bound(amount, 1, 1e12);
        vm.prank(operator);
        try escrow.withdraw(k, amount) {
            revert("CD-2 VIOLATED: operator withdrew funds");
        } catch {
            // expected
        }
    }
}

contract WasiAIEscrowInvariantTest is Test {
    WasiAIEscrow internal escrow;
    MockUSDC internal usdc;
    EscrowHandler internal handler;

    uint256 internal constant TIMELOCK = 2 days;

    function setUp() public {
        usdc = new MockUSDC();
        WasiAIEscrow impl = new WasiAIEscrow();
        bytes memory initData = abi.encodeCall(WasiAIEscrow.initialize, (address(usdc), address(0xBEEF), TIMELOCK));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        escrow = WasiAIEscrow(address(proxy));

        handler = new EscrowHandler(escrow, usdc);
        targetContract(address(handler));
    }

    /// @notice Solvency: the contract holds at least the sum of all tracked balances.
    function invariant_solvency_balanceGteSumBalances() public view {
        bytes32[] memory keys = handler.trackedKeys();
        uint256 sum = 0;
        for (uint256 i = 0; i < keys.length; i++) {
            sum += escrow.escrowBalance(keys[i]);
        }
        assertGe(usdc.balanceOf(address(escrow)), sum);
    }

    /// @notice CD-2: conservation — escrow USDC == deposited - debited - withdrawn.
    ///         The operator-drain handlers can only reduce this via a SIGNED debit;
    ///         forged attempts revert and leave the identity intact.
    function invariant_operatorCannotDrainWithoutSig() public view {
        uint256 expected =
            handler.ghost_totalDeposited() - handler.ghost_totalDebited() - handler.ghost_totalWithdrawn();
        assertEq(usdc.balanceOf(address(escrow)), expected);
    }
}
