// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {FilRegistry} from "../src/FilRegistry.sol";

contract FilRegistryTest is Test {
    FilRegistry internal registry;
    bytes32 internal appId = keccak256("fil-folders");
    bytes32 internal key = keccak256("root");
    address internal writer = address(0xB0B);

    function setUp() public {
        registry = new FilRegistry();
    }

    function test_firstCommitAndHead() public {
        bytes memory cid = bytes("bafkzcibfirst");
        vm.expectEmit(true, true, true, true);
        emit FilRegistry.Committed(address(this), appId, key, cid, bytes(""), 1, block.timestamp);
        registry.commit(appId, key, cid, bytes(""));

        (bytes memory headCid, uint64 version) = registry.head(address(this), appId, key);
        assertEq(headCid, cid);
        assertEq(version, 1);
    }

    function test_casConflictKeepsTheHead() public {
        bytes memory first = bytes("bafkzcibfirst");
        bytes memory second = bytes("bafkzcibsecond");
        registry.commit(appId, key, first, bytes(""));

        vm.expectRevert(abi.encodeWithSelector(FilRegistry.PrevMismatch.selector, first, bytes("")));
        registry.commit(appId, key, second, bytes(""));

        (bytes memory headCid, uint64 version) = registry.head(address(this), appId, key);
        assertEq(headCid, first);
        assertEq(version, 1);

        vm.expectEmit(true, true, true, true);
        emit FilRegistry.Committed(address(this), appId, key, second, first, 2, block.timestamp);
        registry.commit(appId, key, second, first);

        (headCid, version) = registry.head(address(this), appId, key);
        assertEq(headCid, second);
        assertEq(version, 2);
    }

    function test_headsArePerOwner() public {
        registry.commit(appId, key, bytes("owner"), bytes(""));
        vm.prank(writer);
        registry.commit(appId, key, bytes("writer"), bytes(""));

        (bytes memory ownerCid, uint64 ownerVersion) = registry.head(address(this), appId, key);
        (bytes memory writerCid, uint64 writerVersion) = registry.head(writer, appId, key);
        assertEq(ownerCid, bytes("owner"));
        assertEq(ownerVersion, 1);
        assertEq(writerCid, bytes("writer"));
        assertEq(writerVersion, 1);
    }

    function test_writerCanCommitForOwner() public {
        registry.setWriter(appId, writer, true);
        assertTrue(registry.isWriter(address(this), appId, writer));

        vm.prank(writer);
        registry.commitFor(address(this), appId, key, bytes("shared"), bytes(""));

        (bytes memory headCid, uint64 version) = registry.head(address(this), appId, key);
        assertEq(headCid, bytes("shared"));
        assertEq(version, 1);

        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(FilRegistry.PrevMismatch.selector, bytes("shared"), bytes("")));
        registry.commitFor(address(this), appId, key, bytes("lost"), bytes(""));
        (headCid, version) = registry.head(address(this), appId, key);
        assertEq(headCid, bytes("shared"));
        assertEq(version, 1);
    }

    function test_unapprovedWriterIsRejected() public {
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(FilRegistry.NotAllowed.selector, writer, address(this)));
        registry.commitFor(address(this), appId, key, bytes("nope"), bytes(""));

        (bytes memory headCid, uint64 version) = registry.head(address(this), appId, key);
        assertEq(headCid, bytes(""));
        assertEq(version, 0);
    }

    function test_revokedWriterAndZeroAddress() public {
        registry.setWriter(appId, writer, true);
        vm.expectEmit(true, true, true, true);
        emit FilRegistry.WriterSet(address(this), appId, writer, false);
        registry.setWriter(appId, writer, false);

        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(FilRegistry.NotAllowed.selector, writer, address(this)));
        registry.commitFor(address(this), appId, key, bytes("revoked"), bytes(""));

        vm.expectRevert(abi.encodeWithSelector(FilRegistry.NotAllowed.selector, address(0), address(this)));
        registry.setWriter(appId, address(0), true);
    }

    function test_ownerCommitForSelf() public {
        registry.commitFor(address(this), appId, key, bytes("self"), bytes(""));
        (bytes memory headCid, uint64 version) = registry.head(address(this), appId, key);
        assertEq(headCid, bytes("self"));
        assertEq(version, 1);
    }
}
