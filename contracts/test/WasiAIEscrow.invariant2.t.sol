// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {WasiAIEscrow} from "../src/WasiAIEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice Comprehensive invariant handler for WasiAIEscrow (chore/contract-invariants-escrow).
///
/// Differences vs the existing `WasiAIEscrow.invariant.t.sol` suite (which only modeled a single
/// depositor + a single hostile bot):
///   - MULTIPLE depositors, each owning a disjoint set of keys (true multi-tenant model). This
///     exercises the per-key `_depositor` lock and cross-tenant access control.
///   - A dedicated non-operator random actor (`bot`) and a non-depositor random actor that try to
///     debit / withdraw / settle batches and MUST always fail.
///   - Per-key nonce ledger so we can attempt to REPLAY a previously settled authorization and
///     assert it can never double-debit.
///   - An explicit "underflow witness": every legitimate debit/withdraw is bounded by the live
///     on-chain balance, and a ghost mirror of each key's balance is kept and reconciled.
///   - `debitBatch` exercised alongside single `debit`.
///   - Operator rotation via the owner, plus an attempt by a random actor to rotate the operator
///     (access control on `setOperator`) and to authorize an upgrade.
///
/// Ghost accounting lets the test-level `invariant_*` functions assert conservation, solvency,
/// per-key balance mirroring, replay-resistance and access-control without re-reading the contract
/// internals.
contract EscrowHandler2 is Test {
    WasiAIEscrow internal escrow;
    MockUSDC internal usdc;

    // ── actors ────────────────────────────────────────────────────────────────
    // depositor private keys (each owns a disjoint key-space)
    uint256[3] internal depositorPks = [uint256(0xD0501), uint256(0xD0502), uint256(0xD0503)];
    address[3] internal depositors;

    address public operatorAddr; // the configured operator (may rotate)
    address internal owner; // the proxy owner (multisig stand-in)
    address internal bot = address(0xB0B); // hostile non-operator / non-depositor
    address internal arbiter = address(0xA5B1); // 191f: dispute arbiter (no depositor pk)
    address internal disputeSeller = address(0x5E11E7); // 191f: dispute payee

    bytes32 internal constant DOMAIN_TYPE_HASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint256 internal constant MINT = 1e18;

    // ── tracked keys (5 per depositor, disjoint per owner) ─────────────────────
    bytes32[] internal keys;
    mapping(bytes32 => bool) internal known;
    mapping(bytes32 => uint256) internal keyOwnerIdx; // keyId => depositor index (0..2)

    // ── ghost accounting ───────────────────────────────────────────────────────
    uint256 public ghost_totalDeposited;
    uint256 public ghost_totalDebited;
    uint256 public ghost_totalWithdrawn;

    // per-key mirror of the expected balance (deposits - debits - withdrawals)
    mapping(bytes32 => uint256) public ghost_keyBalance;

    // monotonic nonce source for fresh authorizations
    uint256 internal nonceCounter;

    // replay ledger: a (keyId,nonce) that was already CONSUMED by a successful debit
    struct UsedAuth {
        bytes32 keyId;
        uint256 amount;
        uint256 deadline;
        uint256 nonce;
        uint256 ownerIdx;
    }

    UsedAuth[] internal usedAuths;

    // hostile / access-control witnesses (attempts MUST equal reverts)
    uint256 public ghost_hostileAttempts;
    uint256 public ghost_hostileReverts;

    // replay witnesses (attempts MUST equal reverts: a consumed nonce can never re-debit)
    uint256 public ghost_replayAttempts;
    uint256 public ghost_replayReverts;

    // underflow witness: count of debits/withdraws that were attempted with amount > balance.
    // The contract MUST reject these (InsufficientBalance); we never let the mirror go negative.
    uint256 public ghost_overDebitAttempts;
    uint256 public ghost_overDebitReverts;

    // ── 191f: arbiter accounting ─────────────────────────────────────────────
    uint256 public ghost_totalArbiterResolved; // subtracted from the conservation identity
    mapping(bytes32 => bool) internal consented; // keys opted in to arbitration

    // ledger of resolved (keyId, sellerAmount, nonce) to attempt replays
    struct ResolvedAuth {
        bytes32 keyId;
        uint256 sellerAmount;
        uint256 nonce;
    }

    ResolvedAuth[] internal resolvedAuths;

    constructor(WasiAIEscrow _escrow, MockUSDC _usdc, address _operator, address _owner) {
        escrow = _escrow;
        usdc = _usdc;
        operatorAddr = _operator;
        owner = _owner;
        for (uint256 i = 0; i < depositorPks.length; i++) {
            depositors[i] = vm.addr(depositorPks[i]);
            usdc.mint(depositors[i], MINT);
            vm.prank(depositors[i]);
            usdc.approve(address(escrow), type(uint256).max);
        }
    }

    function trackedKeys() external view returns (bytes32[] memory) {
        return keys;
    }

    function trackedKeysLength() external view returns (uint256) {
        return keys.length;
    }

    // keyId deterministically owned by depositor `ownerIdx` (disjoint key-spaces)
    function _key(uint256 seed, uint256 ownerIdx) internal returns (bytes32 k) {
        k = keccak256(abi.encode("key2", ownerIdx, seed % 5));
        if (!known[k]) {
            known[k] = true;
            keys.push(k);
            keyOwnerIdx[k] = ownerIdx;
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

    // ════════════════════════════════════════════════════════════════════════
    //  LEGITIMATE actions
    // ════════════════════════════════════════════════════════════════════════

    function deposit(uint256 seed, uint256 ownerIdx, uint256 amount) external {
        ownerIdx = ownerIdx % depositors.length;
        amount = bound(amount, 1, 1e12);
        address d = depositors[ownerIdx];
        if (usdc.balanceOf(d) < amount) return;
        bytes32 k = _key(seed, ownerIdx);
        vm.prank(d);
        escrow.deposit(k, amount);
        ghost_totalDeposited += amount;
        ghost_keyBalance[k] += amount;
    }

    function withdrawByDepositor(uint256 seed, uint256 amount) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        uint256 ownerIdx = keyOwnerIdx[k];
        uint256 bal = escrow.escrowBalance(k);
        uint256 locked = escrow.lockedAmount(k); // 191f: only the free part is withdrawable
        if (bal <= locked) return;
        amount = bound(amount, 1, bal - locked);
        vm.prank(depositors[ownerIdx]);
        escrow.withdraw(k, amount);
        ghost_totalWithdrawn += amount;
        ghost_keyBalance[k] -= amount;
    }

    /// @notice Withdraw the FULL FREE (unlocked) balance — exercises "a user can always withdraw
    ///         exactly their free remaining balance" (withdraw-safety AC). 191f: locked funds stay.
    function withdrawAll(uint256 seed) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        uint256 ownerIdx = keyOwnerIdx[k];
        uint256 bal = escrow.escrowBalance(k);
        uint256 locked = escrow.lockedAmount(k);
        if (bal <= locked) return;
        uint256 free = bal - locked;
        vm.prank(depositors[ownerIdx]);
        escrow.withdraw(k, free); // exactly the free (unlocked) balance
        ghost_totalWithdrawn += free;
        ghost_keyBalance[k] -= free;
    }

    /// @notice Operator settles a single VALID signed debit (legitimate path).
    function debitByOperator(uint256 seed, uint256 amount) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        uint256 ownerIdx = keyOwnerIdx[k];
        uint256 bal = escrow.escrowBalance(k);
        uint256 locked = escrow.lockedAmount(k); // 191f: cooperative operator does not debit locked funds
        if (bal <= locked) return;
        amount = bound(amount, 1, bal - locked);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = ++nonceCounter;
        bytes memory sig = _sign(depositorPks[ownerIdx], k, amount, deadline, nonce);
        vm.prank(operatorAddr);
        escrow.debit(k, amount, deadline, nonce, sig);
        ghost_totalDebited += amount;
        ghost_keyBalance[k] -= amount;
        usedAuths.push(UsedAuth(k, amount, deadline, nonce, ownerIdx));
    }

    /// @notice Operator settles a batch of two VALID signed debits on two distinct keys.
    /// @dev Split into helpers to keep the stack shallow (avoids "stack too deep" without via-ir).
    function debitBatchByOperator(uint256 seed) external {
        if (keys.length < 2) return;
        bytes32 k1 = keys[seed % keys.length];
        bytes32 k2 = keys[(seed + 1) % keys.length];
        if (k1 == k2) return;
        // 191f: debit only the FREE (unlocked) part of each key so the lock invariant holds.
        uint256 b1 = escrow.escrowBalance(k1) - escrow.lockedAmount(k1);
        uint256 b2 = escrow.escrowBalance(k2) - escrow.lockedAmount(k2);
        if (b1 == 0 || b2 == 0) return;
        _settleBatchOfTwo(k1, k2, b1 / 2 == 0 ? b1 : b1 / 2, b2 / 2 == 0 ? b2 : b2 / 2);
    }

    function _settleBatchOfTwo(bytes32 k1, bytes32 k2, uint256 a1, uint256 a2) internal {
        uint256 deadline = block.timestamp + 1 hours;
        uint256 n1 = ++nonceCounter;
        uint256 n2 = ++nonceCounter;

        bytes32[] memory ks = new bytes32[](2);
        uint256[] memory amts = new uint256[](2);
        uint256[] memory ns = new uint256[](2);
        bytes[] memory sigs = new bytes[](2);
        ks[0] = k1;
        ks[1] = k2;
        amts[0] = a1;
        amts[1] = a2;
        ns[0] = n1;
        ns[1] = n2;
        sigs[0] = _sign(depositorPks[keyOwnerIdx[k1]], k1, a1, deadline, n1);
        sigs[1] = _sign(depositorPks[keyOwnerIdx[k2]], k2, a2, deadline, n2);

        vm.prank(operatorAddr);
        escrow.debitBatch(ks, amts, deadline, ns, sigs);

        ghost_totalDebited += a1 + a2;
        ghost_keyBalance[k1] -= a1;
        ghost_keyBalance[k2] -= a2;
        usedAuths.push(UsedAuth(k1, a1, deadline, n1, keyOwnerIdx[k1]));
        usedAuths.push(UsedAuth(k2, a2, deadline, n2, keyOwnerIdx[k2]));
    }

    /// @notice Owner rotates the operator (legitimate governance, F-A1/F-A2 / MNR-2).
    function rotateOperator(uint256 seed) external {
        // rotate to a fresh deterministic non-zero address, then keep it configured
        address newOp = address(uint160(uint256(keccak256(abi.encode("op", seed))) | 1));
        vm.prank(owner);
        escrow.setOperator(newOp);
        operatorAddr = newOp;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  HOSTILE actions — each MUST revert; ghost accounting unchanged
    // ════════════════════════════════════════════════════════════════════════

    /// @dev REPLAY: re-present a (keyId, amount, deadline, nonce) that was already consumed by a
    ///      successful debit. Must always revert (NonceAlreadyUsed) — no double-debit.
    function replayConsumedAuth(uint256 seed) external {
        if (usedAuths.length == 0) return;
        UsedAuth memory a = usedAuths[seed % usedAuths.length];
        bytes memory sig = _sign(depositorPks[a.ownerIdx], a.keyId, a.amount, a.deadline, a.nonce);
        ghost_replayAttempts++;
        vm.prank(operatorAddr);
        try escrow.debit(a.keyId, a.amount, a.deadline, a.nonce, sig) {
            revert("REPLAY VIOLATED: consumed (keyId,nonce) re-debited");
        } catch {
            ghost_replayReverts++; // expected — NonceAlreadyUsed (or DeadlineExpired if time moved)
        }
    }

    /// @dev OVER-DEBIT: operator presents a VALID signature for amount > current balance.
    ///      Must revert (InsufficientBalance) — budget can never underflow below zero.
    function overDebitAttempt(uint256 seed, uint256 over) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        uint256 ownerIdx = keyOwnerIdx[k];
        uint256 bal = escrow.escrowBalance(k);
        over = bound(over, 1, 1e12);
        uint256 amount = bal + over; // strictly greater than balance
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = ++nonceCounter;
        bytes memory sig = _sign(depositorPks[ownerIdx], k, amount, deadline, nonce);
        ghost_overDebitAttempts++;
        vm.prank(operatorAddr);
        try escrow.debit(k, amount, deadline, nonce, sig) {
            revert("UNDERFLOW VIOLATED: debit exceeded balance");
        } catch {
            ghost_overDebitReverts++; // expected — InsufficientBalance
        }
    }

    /// @dev OVER-WITHDRAW: depositor tries to withdraw more than their remaining balance.
    ///      Must revert (InsufficientBalance) — withdraw-safety.
    function overWithdrawAttempt(uint256 seed, uint256 over) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        uint256 ownerIdx = keyOwnerIdx[k];
        uint256 bal = escrow.escrowBalance(k);
        over = bound(over, 1, 1e12);
        uint256 amount = bal + over;
        ghost_overDebitAttempts++;
        vm.prank(depositors[ownerIdx]);
        try escrow.withdraw(k, amount) {
            revert("WITHDRAW-SAFETY VIOLATED: withdrew more than balance");
        } catch {
            ghost_overDebitReverts++; // expected — InsufficientBalance
        }
    }

    /// @dev ACCESS CONTROL: a non-operator (bot) presents a VALID depositor signature.
    ///      Must revert (NotOperator) — front-run / MEV theft closed.
    function botDebitAttempt(uint256 seed) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        uint256 ownerIdx = keyOwnerIdx[k];
        uint256 bal = escrow.escrowBalance(k);
        if (bal == 0) return;
        uint256 amount = bound(uint256(keccak256(abi.encode(seed))), 1, bal);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = ++nonceCounter;
        bytes memory sig = _sign(depositorPks[ownerIdx], k, amount, deadline, nonce);
        ghost_hostileAttempts++;
        vm.prank(bot); // NOT the operator
        try escrow.debit(k, amount, deadline, nonce, sig) {
            revert("ACCESS-CONTROL VIOLATED: non-operator settled a debit");
        } catch {
            ghost_hostileReverts++; // expected — NotOperator
        }
    }

    /// @dev ACCESS CONTROL: the operator tries to debit WITHOUT any valid depositor signature
    ///      (signs with a forged key). Must revert (InvalidSignature).
    function operatorForgeAttempt(uint256 seed, uint256 forgedPk) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        forgedPk = bound(forgedPk, 1, type(uint128).max);
        uint256 ownerIdx = keyOwnerIdx[k];
        if (forgedPk == depositorPks[ownerIdx]) forgedPk += 1; // ensure NOT the real depositor
        uint256 amount = bound(uint256(keccak256(abi.encode(seed, "amt"))), 1, 1e12);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = ++nonceCounter;
        bytes memory sig = _sign(forgedPk, k, amount, deadline, nonce);
        ghost_hostileAttempts++;
        vm.prank(operatorAddr);
        try escrow.debit(k, amount, deadline, nonce, sig) {
            revert("ACCESS-CONTROL VIOLATED: operator debited without depositor signature");
        } catch {
            ghost_hostileReverts++; // expected — InvalidSignature
        }
    }

    /// @dev ACCESS CONTROL: a depositor signs a debit for a key owned by ANOTHER depositor.
    ///      The recovered signer != _depositor[keyId], so it must revert (InvalidSignature).
    function crossTenantDebitAttempt(uint256 seed) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        uint256 ownerIdx = keyOwnerIdx[k];
        uint256 wrongIdx = (ownerIdx + 1) % depositors.length;
        uint256 bal = escrow.escrowBalance(k);
        if (bal == 0) return;
        uint256 amount = bound(uint256(keccak256(abi.encode(seed, "x"))), 1, bal);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = ++nonceCounter;
        bytes memory sig = _sign(depositorPks[wrongIdx], k, amount, deadline, nonce); // wrong owner signs
        ghost_hostileAttempts++;
        vm.prank(operatorAddr);
        try escrow.debit(k, amount, deadline, nonce, sig) {
            revert("ACCESS-CONTROL VIOLATED: foreign depositor signature accepted");
        } catch {
            ghost_hostileReverts++; // expected — InvalidSignature
        }
    }

    /// @dev ACCESS CONTROL: a non-depositor (bot) tries to withdraw a key it does not own.
    ///      Must revert (Unauthorized).
    function botWithdrawAttempt(uint256 seed, uint256 amount) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        amount = bound(amount, 1, 1e12);
        ghost_hostileAttempts++;
        vm.prank(bot);
        try escrow.withdraw(k, amount) {
            revert("ACCESS-CONTROL VIOLATED: non-depositor withdrew funds");
        } catch {
            ghost_hostileReverts++; // expected — Unauthorized
        }
    }

    /// @dev ACCESS CONTROL: a random actor tries to rotate the operator (owner-only).
    ///      Must revert (OwnableUnauthorizedAccount).
    function botSetOperatorAttempt(uint256 seed) external {
        address newOp = address(uint160(uint256(keccak256(abi.encode("badop", seed))) | 1));
        ghost_hostileAttempts++;
        vm.prank(bot);
        try escrow.setOperator(newOp) {
            revert("ACCESS-CONTROL VIOLATED: non-owner rotated operator");
        } catch {
            ghost_hostileReverts++; // expected — OwnableUnauthorizedAccount
        }
    }

    /// @dev ACCESS CONTROL: a random actor tries to propose an upgrade (owner authorizes upgrades).
    ///      Must revert (OwnableUnauthorizedAccount).
    function botProposeUpgradeAttempt() external {
        address impl = address(this); // a contract with code, so only the access gate is tested
        ghost_hostileAttempts++;
        vm.prank(bot);
        try escrow.proposeUpgrade(impl) {
            revert("ACCESS-CONTROL VIOLATED: non-owner proposed an upgrade");
        } catch {
            ghost_hostileReverts++; // expected — OwnableUnauthorizedAccount
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  191f — LEGITIMATE arbiter actions (update ghosts + mirror)
    // ════════════════════════════════════════════════════════════════════════

    /// @dev The key's depositor opts in to arbitration (monotonic).
    function consentByDepositor(uint256 seed) external {
        if (keys.length == 0) return;
        bytes32 k = keys[seed % keys.length];
        if (consented[k]) return;
        vm.prank(depositors[keyOwnerIdx[k]]);
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
        if (bal <= locked) return;
        amount = bound(amount, 1, bal - locked);
        vm.prank(arbiter);
        escrow.lockForDispute(k, amount);
    }

    /// @dev Arbiter pays `sellerAmount <= locked` to the seller; mirror descuenta sellerAmount.
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
        ghost_keyBalance[k] -= sellerAmount; // mirror: resolve drains the key by sellerAmount
        resolvedAuths.push(ResolvedAuth(k, sellerAmount, nonce));
    }

    /// @dev Arbiter releases the lock without paying (buyer wins) — balance/mirror unchanged.
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
            ghost_hostileReverts++; // expected — ExceedsLockedAmount
        }
    }

    /// @dev Replay a consumed (keyId, nonce) resolve — MUST revert NonceAlreadyUsed.
    function resolveReplay(uint256 seed) external {
        if (resolvedAuths.length == 0) return;
        ResolvedAuth memory a = resolvedAuths[seed % resolvedAuths.length];
        ghost_replayAttempts++;
        vm.prank(arbiter);
        try escrow.resolveDispute(a.keyId, disputeSeller, a.sellerAmount, a.nonce) {
            revert("191f VIOLATED: consumed resolve nonce re-used");
        } catch {
            ghost_replayReverts++; // expected — NonceAlreadyUsed
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
        uint256 amount = (bal - locked) + 1; // one wei over the free part
        ghost_overDebitAttempts++;
        vm.prank(depositors[keyOwnerIdx[k]]);
        try escrow.withdraw(k, amount) {
            revert("191f VIOLATED: withdraw exceeded free (unlocked) balance");
        } catch {
            ghost_overDebitReverts++; // expected — InsufficientBalance
        }
    }
}

/// @notice Invariant test wiring: deploys behind an ERC1967 proxy and binds the handler.
contract WasiAIEscrowInvariant2Test is Test {
    WasiAIEscrow internal escrow;
    MockUSDC internal usdc;
    EscrowHandler2 internal handler;

    uint256 internal constant TIMELOCK = 2 days;
    address internal constant OPERATOR = address(0xCAFE);
    address internal constant OWNER = address(0xBEEF);
    // 191f: MUST match EscrowHandler2.arbiter
    address internal constant ARBITER = address(0xA5B1);

    function setUp() public {
        usdc = new MockUSDC();
        WasiAIEscrow impl = new WasiAIEscrow();
        bytes memory initData = abi.encodeCall(WasiAIEscrow.initialize, (address(usdc), OPERATOR, OWNER, TIMELOCK));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        escrow = WasiAIEscrow(address(proxy));

        // 191f: configure the arbiter (owner-only), matching the handler actor.
        vm.prank(OWNER);
        escrow.setArbiter(ARBITER);

        handler = new EscrowHandler2(escrow, usdc, OPERATOR, OWNER);
        targetContract(address(handler));
    }

    // ── SOLVENCY ───────────────────────────────────────────────────────────────
    /// @notice The contract's USDC balance is always >= the sum of all key budgets.
    ///         The operator can never debit/withdraw more than exists.
    function invariant_solvency() public view {
        bytes32[] memory keys = handler.trackedKeys();
        uint256 sum = 0;
        for (uint256 i = 0; i < keys.length; i++) {
            sum += escrow.escrowBalance(keys[i]);
        }
        assertGe(usdc.balanceOf(address(escrow)), sum, "solvency: escrow balance < sum of budgets");
    }

    // ── CONSERVATION (global) ───────────────────────────────────────────────────
    /// @notice total deposited == total in budgets + total withdrawn + total debited/settled.
    ///         No funds created or lost. Equivalently: escrowUSDC == deposited - debited - withdrawn.
    function invariant_conservation() public view {
        uint256 expected = handler.ghost_totalDeposited() - handler.ghost_totalDebited()
            - handler.ghost_totalWithdrawn() - handler.ghost_totalArbiterResolved(); // 191f: arbiter payouts
        assertEq(usdc.balanceOf(address(escrow)), expected, "conservation: escrow balance != ghost identity");
    }

    // ── PER-KEY BALANCE MIRROR (no underflow / no funds lost per key) ────────────
    /// @notice Every key's on-chain budget equals the ghost mirror (deposits - debits - withdrawals).
    ///         Because the ghost mirror is only ever decremented by amounts bounded to the live
    ///         balance, a passing equality proves no key budget underflowed below zero.
    function invariant_perKeyBalanceMirror() public view {
        bytes32[] memory keys = handler.trackedKeys();
        for (uint256 i = 0; i < keys.length; i++) {
            assertEq(
                escrow.escrowBalance(keys[i]),
                handler.ghost_keyBalance(keys[i]),
                "per-key: on-chain budget != ghost mirror"
            );
        }
    }

    // ── ACCESS CONTROL + REPLAY + WITHDRAW-SAFETY witnesses ─────────────────────
    /// @notice Every hostile action (non-operator debit, forged-sig debit, cross-tenant debit,
    ///         non-depositor withdraw, non-owner setOperator / proposeUpgrade) reverted.
    function invariant_accessControlAlwaysReverts() public view {
        assertEq(
            handler.ghost_hostileAttempts(),
            handler.ghost_hostileReverts(),
            "access-control: a hostile action succeeded"
        );
    }

    /// @notice A consumed (keyId, nonce) authorization can never be replayed (no double-debit).
    function invariant_noReplay() public view {
        assertEq(handler.ghost_replayAttempts(), handler.ghost_replayReverts(), "replay: a consumed nonce re-debited");
    }

    /// @notice No debit/withdraw above the live balance ever succeeded (no underflow, withdraw-safety).
    function invariant_noUnderflow() public view {
        assertEq(
            handler.ghost_overDebitAttempts(),
            handler.ghost_overDebitReverts(),
            "underflow: a debit/withdraw exceeded the balance"
        );
    }

    /// @notice 191f (CD-5/CD-8): the dispute lock never exceeds the on-chain balance for any key.
    function invariant_lockNeverExceedsBalance() public view {
        bytes32[] memory keys = handler.trackedKeys();
        for (uint256 i = 0; i < keys.length; i++) {
            assertLe(
                escrow.lockedAmount(keys[i]),
                escrow.escrowBalance(keys[i]),
                "191f: locked amount exceeds key balance"
            );
        }
    }
}
