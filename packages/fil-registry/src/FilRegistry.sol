// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title FilRegistry
/// @notice Compare-and-swap heads for Filecoin piece CIDs.
/// @dev One head per (owner, app, key). The contract is not upgradeable.
///      History is the `Committed` log plus the version counter stored with each head.
contract FilRegistry {
    struct Head {
        bytes pieceCid;
        uint64 version;
    }

    /// @notice Current head. Version 0 and empty bytes means the key has never been committed.
    mapping(address owner => mapping(bytes32 app => mapping(bytes32 key => Head))) private _heads;

    /// @notice Writers an owner has approved for an app. The owner can always commit.
    mapping(address owner => mapping(bytes32 app => mapping(address writer => bool))) public isWriter;

    /// @notice Emitted for every successful compare-and-swap.
    /// @param owner Slot owner. This is the caller for `commit`, or the target of `commitFor`.
    /// @param app Application namespace.
    /// @param key Record key inside the app.
    /// @param pieceCid New piece CID bytes.
    /// @param prevPieceCid Previous head that the caller matched.
    /// @param version Head version after this commit. The first commit is 1.
    /// @param timestamp Block timestamp of the commit.
    event Committed(
        address indexed owner,
        bytes32 indexed app,
        bytes32 indexed key,
        bytes pieceCid,
        bytes prevPieceCid,
        uint64 version,
        uint256 timestamp
    );

    /// @notice Emitted when an owner grants or revokes a writer for an app.
    event WriterSet(address indexed owner, bytes32 indexed app, address indexed writer, bool allowed);

    /// @notice `prevPieceCid` did not match the stored head.
    error PrevMismatch(bytes current, bytes expected);

    /// @notice The caller may not commit into this owner's slot.
    error NotAllowed(address caller, address owner);

    /// @notice Read the current piece CID and version for a slot.
    /// @param owner Slot owner.
    /// @param app Application namespace.
    /// @param key Record key.
    /// @return pieceCid Current piece CID bytes. Empty when the slot has never been committed.
    /// @return version Commit count. Zero when the slot has never been committed.
    function head(address owner, bytes32 app, bytes32 key) external view returns (bytes memory pieceCid, uint64 version) {
        Head storage current = _heads[owner][app][key];
        return (current.pieceCid, current.version);
    }

    /// @notice Compare-and-swap a piece CID into the caller's own slot.
    /// @dev Reverts with `PrevMismatch` when `prevPieceCid` is not the current head.
    ///      Pass empty `prevPieceCid` for the first commit.
    /// @param app Application namespace.
    /// @param key Record key.
    /// @param pieceCid New piece CID bytes.
    /// @param prevPieceCid Expected current head.
    function commit(bytes32 app, bytes32 key, bytes calldata pieceCid, bytes calldata prevPieceCid) external {
        _commit(msg.sender, app, key, pieceCid, prevPieceCid);
    }

    /// @notice Compare-and-swap into `owner`'s slot.
    /// @dev The owner and any writer they approved for `app` may call this.
    /// @param owner Slot owner whose head will move.
    /// @param app Application namespace.
    /// @param key Record key.
    /// @param pieceCid New piece CID bytes.
    /// @param prevPieceCid Expected current head.
    function commitFor(address owner, bytes32 app, bytes32 key, bytes calldata pieceCid, bytes calldata prevPieceCid) external {
        if (msg.sender != owner && !isWriter[owner][app][msg.sender]) revert NotAllowed(msg.sender, owner);
        _commit(owner, app, key, pieceCid, prevPieceCid);
    }

    /// @notice Grant or revoke a collaborator who may `commitFor` this owner and app.
    /// @param app Application namespace.
    /// @param writer Collaborator address.
    /// @param allowed True to approve, false to revoke.
    function setWriter(bytes32 app, address writer, bool allowed) external {
        if (writer == address(0)) revert NotAllowed(writer, msg.sender);
        isWriter[msg.sender][app][writer] = allowed;
        emit WriterSet(msg.sender, app, writer, allowed);
    }

    function _commit(address owner, bytes32 app, bytes32 key, bytes calldata pieceCid, bytes calldata prevPieceCid) internal {
        Head storage current = _heads[owner][app][key];
        if (keccak256(current.pieceCid) != keccak256(prevPieceCid)) revert PrevMismatch(current.pieceCid, prevPieceCid);
        current.pieceCid = pieceCid;
        current.version += 1;
        emit Committed(owner, app, key, pieceCid, prevPieceCid, current.version, block.timestamp);
    }
}
