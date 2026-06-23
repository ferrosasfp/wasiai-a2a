// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {WasiAIEscrow} from "../src/WasiAIEscrow.sol";

/// @notice Deploy WasiAIEscrow (impl + ERC1967 proxy) to Base Sepolia (84532).
/// @dev All inputs from env (CD-5: nothing hardcoded). USDC + operator + multisig + timelock + deployer pk.
contract Deploy is Script {
    function run() external {
        address usdc = vm.envAddress("USDC_BASE_SEPOLIA");
        address operator = vm.envAddress("OPERATOR_ADDRESS");
        address multisig = vm.envAddress("MULTISIG_ADDRESS");
        uint256 timelock = vm.envUint("TIMELOCK_DELAY");
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPk);
        WasiAIEscrow impl = new WasiAIEscrow();
        bytes memory initData = abi.encodeCall(WasiAIEscrow.initialize, (usdc, operator, multisig, timelock));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vm.stopBroadcast();

        console2.log("Escrow proxy:", address(proxy));
        console2.log("Escrow impl :", address(impl));
    }
}
