// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IWasiAIEscrow} from "../../src/interfaces/IWasiAIEscrow.sol";

/// @notice Malicious USDC (6 decimals) for the re-entrancy witness only. NOT production.
/// @dev When armed, `transfer` re-enters `resolveDispute` with the same `(keyId, nonce)` BEFORE
///      completing the outbound transfer. The escrow's `nonReentrant` guard MUST revert the
///      re-entry (and, defensively, the nonce is already marked used in the Effects phase),
///      bubbling the revert up so the outer `resolveDispute` reverts and funds stay intact.
contract ReentrantUSDC is ERC20 {
    IWasiAIEscrow internal _escrow;
    bool internal _attack;
    bytes32 internal _keyId;
    address internal _seller;
    uint256 internal _amount;
    uint256 internal _nonce;

    constructor() ERC20("Reentrant USD Coin", "rUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Arm the re-entrancy: the next `transfer` re-enters `resolveDispute(keyId, seller, amount, nonce)`.
    function arm(address escrow_, bytes32 keyId, address seller, uint256 amount, uint256 nonce) external {
        _escrow = IWasiAIEscrow(escrow_);
        _keyId = keyId;
        _seller = seller;
        _amount = amount;
        _nonce = nonce;
        _attack = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (_attack) {
            _attack = false; // one-shot: prevent infinite recursion if the guard ever failed
            _escrow.resolveDispute(_keyId, _seller, _amount, _nonce); // re-enter — MUST revert
        }
        return super.transfer(to, amount);
    }
}
