// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {FilRegistry} from "../src/FilRegistry.sol";

/// @title DeployMainnet
/// @notice Deploy FilRegistry to Filecoin mainnet (chain id 314).
/// @dev This script is not run by automation. Broadcast only from an operator machine:
///      forge script script/DeployMainnet.s.sol --rpc-url mainnet --broadcast --private-key $PRIVATE_KEY
contract DeployMainnet is Script {
    function run() external returns (FilRegistry deployed) {
        require(block.chainid == 314, "Filecoin mainnet (314) only");
        vm.startBroadcast();
        deployed = new FilRegistry();
        vm.stopBroadcast();
    }
}
