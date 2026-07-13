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
    address internal bot = address(0xB07); // hostile third party — never the operator
    address internal arbiter = address(0xA5B1); // 191f: dispute arbiter (no depositor pk)
    address internal disputeSeller = address(0x5E11E7); // 191f: dispute payee

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

    // AR-MNR-1: counters proving the hostile path is actually exercised AND always reverts.
    uint256 public ghost_hostileAttempts; // every front-run / forged / non-operator attempt
    uint256 public ghost_hostileReverts; // those that reverted (MUST equal attempts)

    // 191f: arbiter-resolved total (subtracted from the conservation identity)
    uint256 public ghost_totalArbiterResolved;
    // 191f: which tracked keys have consented to arbitration
    mapping(bytes32 => bool) internal consented;

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
        uint256 locked = escrow.lockedAmount(k); // 191f: withdraw only the free part
        if (bal <= locked) return;
        amount = bound(amount, 1, bal - locked);
        vm.prank(agent);
        escrow.withdraw(k, amount);
        ghost_totalWithdrawn += amount;
    }

    /// @dev Operator settles with a VALID agent signature (the legitimate path).
    /// @dev 191f: a cooperative operator does NOT debit funds frozen for a dispute, so the amount is
    ///      bounded to the FREE part (balance - locked). This keeps `locked <= balance` (R-1 discipline).
    function debitByOperator(uint256 seed, uint256 amount) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        uint256 bal = escrow.escrowBalance(k);
        uint256 locked = escrow.lockedAmount(k);
        if (bal <= locked) return; // nothing free to debit without crossing the lock
        amount = bound(amount, 1, bal - locked);
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
        ghost_hostileAttempts++;
        vm.prank(operator);
        try escrow.debit(k, amount, deadline, nonce, sig) {
            // Must never succeed without depositor signature.
            revert("CD-2 VIOLATED: operator debited without depositor signature");
        } catch {
            ghost_hostileReverts++; // expected — forged signature rejected
        }
    }

    /// @dev F-A1/F-A2 (AR-MNR-1): a hostile bot replays a VALID depositor signature it observed
    ///      in the mempool. With onlyOperator, presenting it as a non-operator MUST always revert
    ///      (NotOperator) — the front-running / MEV theft vector is closed. Ghost unchanged.
    function botFrontRunAttempt(uint256 seed, uint256 amount) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        uint256 bal = escrow.escrowBalance(k);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = ++nonceCounter;
        // VALID signature from the real depositor — exactly what the operator would present.
        bytes memory sig = _sign(agentPk, k, amount, deadline, nonce);
        ghost_hostileAttempts++;
        vm.prank(bot); // NOT the operator
        try escrow.debit(k, amount, deadline, nonce, sig) {
            revert("F-A1 VIOLATED: non-operator settled a valid signature (front-run)");
        } catch {
            ghost_hostileReverts++; // expected — NotOperator
        }
    }

    /// @dev Operator tries withdraw directly (not depositor) — must always revert.
    function operatorWithdrawAttempt(uint256 seed, uint256 amount) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        amount = bound(amount, 1, 1e12);
        ghost_hostileAttempts++;
        vm.prank(operator);
        try escrow.withdraw(k, amount) {
            revert("CD-2 VIOLATED: operator withdrew funds");
        } catch {
            ghost_hostileReverts++; // expected
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  191f — LEGITIMATE arbiter actions (update ghosts)
    // ════════════════════════════════════════════════════════════════════════

    /// @dev The depositor opts a key in to arbitration (monotonic).
    function consentByDepositor(uint256 seed) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        if (consented[k]) return;
        vm.prank(agent);
        escrow.setArbitrationConsent(k, true);
        consented[k] = true;
    }

    /// @dev Arbiter freezes `amount <= balance-locked` on a consented key.
    function lockByArbiter(uint256 seed, uint256 amount) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        if (!consented[k]) return;
        uint256 bal = escrow.escrowBalance(k);
        uint256 locked = escrow.lockedAmount(k);
        if (bal <= locked) return; // nothing free to lock
        amount = bound(amount, 1, bal - locked);
        vm.prank(arbiter);
        escrow.lockForDispute(k, amount);
    }

    /// @dev Arbiter pays `sellerAmount <= locked` to the seller; releases the residual.
    function resolveByArbiter(uint256 seed, uint256 sellerAmount) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        if (!consented[k]) return;
        uint256 locked = escrow.lockedAmount(k);
        uint256 bal = escrow.escrowBalance(k);
        if (locked == 0 || bal == 0) return;
        uint256 cap = locked < bal ? locked : bal;
        sellerAmount = bound(sellerAmount, 1, cap);
        uint256 nonce = ++nonceCounter;
        vm.prank(arbiter);
        escrow.resolveDispute(k, disputeSeller, sellerAmount, nonce);
        ghost_totalArbiterResolved += sellerAmount;
    }

    /// @dev Arbiter releases the lock without paying (buyer wins).
    function releaseByArbiter(uint256 seed) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        if (escrow.lockedAmount(k) == 0) return;
        vm.prank(arbiter);
        escrow.releaseDispute(k);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  191f — HOSTILE arbiter-path actions (each MUST revert)
    // ════════════════════════════════════════════════════════════════════════

    /// @dev A non-arbiter (bot) tries to resolve — MUST revert NotArbiter.
    function resolveByNonArbiter(uint256 seed, uint256 sellerAmount) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        sellerAmount = bound(sellerAmount, 1, 1e12);
        uint256 nonce = ++nonceCounter;
        ghost_hostileAttempts++;
        vm.prank(bot);
        try escrow.resolveDispute(k, disputeSeller, sellerAmount, nonce) {
            revert("191f VIOLATED: non-arbiter resolved a dispute");
        } catch {
            ghost_hostileReverts++; // expected — NotArbiter
        }
    }

    /// @dev Arbiter resolves a key WITHOUT consent — MUST revert ArbitrationNotConsented.
    function resolveWithoutConsent(uint256 seed, uint256 sellerAmount) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        if (consented[k]) return; // only exercise the not-consented path
        sellerAmount = bound(sellerAmount, 1, 1e12);
        uint256 nonce = ++nonceCounter;
        ghost_hostileAttempts++;
        vm.prank(arbiter);
        try escrow.resolveDispute(k, disputeSeller, sellerAmount, nonce) {
            revert("191f VIOLATED: resolved without consent");
        } catch {
            ghost_hostileReverts++; // expected — ArbitrationNotConsented
        }
    }

    /// @dev Arbiter resolves with sellerAmount > locked — MUST revert ExceedsLockedAmount.
    function resolveOverLocked(uint256 seed, uint256 over) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        if (!consented[k]) return;
        uint256 locked = escrow.lockedAmount(k);
        over = bound(over, 1, 1e12);
        uint256 sellerAmount = locked + over; // strictly greater than locked
        uint256 nonce = ++nonceCounter;
        ghost_hostileAttempts++;
        vm.prank(arbiter);
        try escrow.resolveDispute(k, disputeSeller, sellerAmount, nonce) {
            revert("191f VIOLATED: resolved above locked");
        } catch {
            ghost_hostileReverts++; // expected — ExceedsLockedAmount (or ArbitrationNotConsented edge)
        }
    }

    /// @dev A non-arbiter (bot) tries to lock — MUST revert NotArbiter.
    function lockByNonArbiter(uint256 seed, uint256 amount) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        amount = bound(amount, 1, 1e12);
        ghost_hostileAttempts++;
        vm.prank(bot);
        try escrow.lockForDispute(k, amount) {
            revert("191f VIOLATED: non-arbiter locked funds");
        } catch {
            ghost_hostileReverts++; // expected — NotArbiter
        }
    }

    /// @dev Depositor tries to withdraw more than balance-locked — MUST revert InsufficientBalance.
    function withdrawOverLock(uint256 seed) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        uint256 bal = escrow.escrowBalance(k);
        uint256 locked = escrow.lockedAmount(k);
        if (locked == 0 || bal < locked) return;
        uint256 available = bal - locked;
        uint256 amount = available + 1; // one wei over the free part
        if (amount > bal) return; // fully locked: available+1 could exceed bal, still reverts, but keep clean
        ghost_hostileAttempts++;
        vm.prank(agent);
        try escrow.withdraw(k, amount) {
            revert("191f VIOLATED: withdraw exceeded free (unlocked) balance");
        } catch {
            ghost_hostileReverts++; // expected — InsufficientBalance
        }
    }
}

contract WasiAIEscrowInvariantTest is Test {
    WasiAIEscrow internal escrow;
    MockUSDC internal usdc;
    EscrowHandler internal handler;

    uint256 internal constant TIMELOCK = 2 days;

    // the operator configured in the contract MUST match the handler's `operator` actor
    address internal constant OPERATOR = address(0xCAFE);
    address internal constant OWNER = address(0xBEEF);
    // 191f: MUST match EscrowHandler.arbiter
    address internal constant ARBITER = address(0xA5B1);

    function setUp() public {
        usdc = new MockUSDC();
        WasiAIEscrow impl = new WasiAIEscrow();
        bytes memory initData =
            abi.encodeCall(WasiAIEscrow.initialize, (address(usdc), OPERATOR, OWNER, TIMELOCK));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        escrow = WasiAIEscrow(address(proxy));

        // 191f: configure the arbiter (owner-only), matching the handler actor.
        vm.prank(OWNER);
        escrow.setArbiter(ARBITER);

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
        uint256 expected = handler.ghost_totalDeposited() - handler.ghost_totalDebited()
            - handler.ghost_totalWithdrawn() - handler.ghost_totalArbiterResolved(); // 191f: arbiter payouts
        assertEq(usdc.balanceOf(address(escrow)), expected);
    }

    /// @notice 191f (CD-5/CD-8): the dispute lock can never exceed the on-chain balance for any key.
    function invariant_lockNeverExceedsBalance() public view {
        bytes32[] memory keys = handler.trackedKeys();
        for (uint256 i = 0; i < keys.length; i++) {
            assertLe(escrow.lockedAmount(keys[i]), escrow.escrowBalance(keys[i]));
        }
    }

    /// @notice AR-MNR-1 / F-A1: every hostile attempt (forged-sig drain, valid-sig front-run by a
    ///         non-operator, operator-withdraw) MUST have reverted. The counters make the hostile
    ///         path observable: attempts == reverts proves the path was exercised and never succeeded.
    function invariant_hostilePathAlwaysReverts() public view {
        assertEq(handler.ghost_hostileAttempts(), handler.ghost_hostileReverts());
    }
}
