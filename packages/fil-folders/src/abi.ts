/** ABI for FilRegistry. Keep this in step with packages/fil-registry/src/FilRegistry.sol. */
export const filRegistryAbi = [
  {
    type: "function",
    name: "commit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "app", type: "bytes32" },
      { name: "key", type: "bytes32" },
      { name: "pieceCid", type: "bytes" },
      { name: "prevPieceCid", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "commitFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "app", type: "bytes32" },
      { name: "key", type: "bytes32" },
      { name: "pieceCid", type: "bytes" },
      { name: "prevPieceCid", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "head",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "app", type: "bytes32" },
      { name: "key", type: "bytes32" },
    ],
    outputs: [
      { name: "pieceCid", type: "bytes" },
      { name: "version", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "setWriter",
    stateMutability: "nonpayable",
    inputs: [
      { name: "app", type: "bytes32" },
      { name: "writer", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "isWriter",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "app", type: "bytes32" },
      { name: "writer", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "Committed",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "app", type: "bytes32", indexed: true },
      { name: "key", type: "bytes32", indexed: true },
      { name: "pieceCid", type: "bytes", indexed: false },
      { name: "prevPieceCid", type: "bytes", indexed: false },
      { name: "version", type: "uint64", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "WriterSet",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "app", type: "bytes32", indexed: true },
      { name: "writer", type: "address", indexed: true },
      { name: "allowed", type: "bool", indexed: false },
    ],
  },
  {
    type: "error",
    name: "PrevMismatch",
    inputs: [
      { name: "current", type: "bytes" },
      { name: "expected", type: "bytes" },
    ],
  },
  {
    type: "error",
    name: "NotAllowed",
    inputs: [
      { name: "caller", type: "address" },
      { name: "owner", type: "address" },
    ],
  },
] as const;
