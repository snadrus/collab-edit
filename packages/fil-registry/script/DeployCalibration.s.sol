// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {FilRegistry} from "../src/FilRegistry.sol";

/// @title DeployCalibration
/// @notice Deploy FilRegistry to Filecoin Calibration (chain id 314159).
/// @dev forge script script/DeployCalibration.s.sol --rpc-url calibration --broadcast --private-key $PRIVATE_KEY
contract DeployCalibration is Script {
    function run() external returns (FilRegistry deployed) {
        require(block.chainid == 314159, "Filecoin Calibration (314159) only");
        vm.startBroadcast();
        deployed = new FilRegistry();
        vm.stopBroadcast();
    }
}
