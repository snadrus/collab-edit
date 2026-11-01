import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  hexToBytes,
  http,
  parseAbiItem,
  parseEventLogs,
  toHex,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { filRegistryAbi } from "./abi.ts";
import { CasConflict, normalizeAddress, type CommitArgs, type CommitEvent, type FolderRegistry, type Head } from "./types.ts";

export const filecoinMainnet: Chain = defineChain({
  id: 314,
  name: "Filecoin",
  nativeCurrency: { name: "FIL", symbol: "FIL", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.node.glif.io/rpc/v1"] } },
});

export const filecoinCalibration: Chain = defineChain({
  id: 314159,
  name: "Filecoin Calibration",
  nativeCurrency: { name: "tFIL", symbol: "tFIL", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.calibration.node.glif.io/rpc/v1"] } },
});

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface ContractRegistryOptions {
  address: Hex;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

/** FilRegistry client. Writes `commit` for the signer and `commitFor` for an approved writer. */
export function contractRegistry(options: ContractRegistryOptions): FolderRegistry {
  const address = getAddress(options.address);
  const committed = parseAbiItem(
    "event Committed(address indexed owner, bytes32 indexed app, bytes32 indexed key, bytes pieceCid, bytes prevPieceCid, uint64 version, uint256 timestamp)",
  );
  return {
    async head(owner: string, app: Hex, key: Hex): Promise<Head> {
      const result = await options.publicClient.readContract({
        address,
        abi: filRegistryAbi,
        functionName: "head",
        args: [normalizeAddress(owner), app, key],
      });
      return { pieceCid: bytesToCid(result[0]), version: result[1] };
    },
    async commit(args: CommitArgs): Promise<CommitEvent> {
      const signer = signerAddress(options.walletClient);
      const owner = normalizeAddress(args.owner);
      const piece = cidToBytes(args.pieceCid);
      const prev = cidToBytes(args.prevPieceCid);
      const writingOwn = owner === signer;
      try {
        const hash = await options.walletClient.writeContract({
          address,
          abi: filRegistryAbi,
          functionName: writingOwn ? "commit" : "commitFor",
          args: writingOwn ? [args.app, args.key, piece, prev] : [owner, args.app, args.key, piece, prev],
          account: options.walletClient.account ?? signer,
          chain: options.walletClient.chain,
        });
        const receipt = await options.publicClient.waitForTransactionReceipt({ hash });
        const logs = parseEventLogs({ abi: filRegistryAbi, eventName: "Committed", logs: receipt.logs });
        const match = logs.find((log) => log.args.owner && getAddress(log.args.owner) === owner && log.args.app === args.app && log.args.key === args.key);
        if (!match) throw new Error("commit produced no Committed event");
        return {
          owner,
          app: args.app,
          key: args.key,
          pieceCid: bytesToCid(match.args.pieceCid ?? "0x"),
          prevPieceCid: bytesToCid(match.args.prevPieceCid ?? "0x"),
          version: match.args.version ?? 0n,
          timestamp: match.args.timestamp ?? 0n,
        };
      } catch (err) {
        if (isPrevMismatch(err)) throw new CasConflict(args.prevPieceCid, args.pieceCid);
        throw err;
      }
    },
    async history(owner: string, app: Hex, key: Hex): Promise<CommitEvent[]> {
      const logs = await options.publicClient.getLogs({
        address,
        event: committed,
        args: { owner: normalizeAddress(owner), app, key },
        fromBlock: 0n,
        toBlock: "latest",
      });
      return logs.map((log) => ({
        owner: getAddress(log.args.owner ?? owner),
        app,
        key,
        pieceCid: bytesToCid(log.args.pieceCid ?? "0x"),
        prevPieceCid: bytesToCid(log.args.prevPieceCid ?? "0x"),
        version: log.args.version ?? 0n,
        timestamp: log.args.timestamp ?? 0n,
      }));
    },
    async setWriter(app: Hex, writer: string, allowed: boolean): Promise<void> {
      const hash = await options.walletClient.writeContract({
        address,
        abi: filRegistryAbi,
        functionName: "setWriter",
        args: [app, normalizeAddress(writer), allowed],
        account: options.walletClient.account ?? signerAddress(options.walletClient),
        chain: options.walletClient.chain,
      });
      await options.publicClient.waitForTransactionReceipt({ hash });
    },
  };
}

export async function registryFromWallet(opts: {
  contract: Hex;
  network?: "mainnet" | "calibration";
  privateKey?: string;
  provider?: Eip1193Provider;
}): Promise<FolderRegistry> {
  const chain = opts.network === "calibration" ? filecoinCalibration : filecoinMainnet;
  const rpc = chain.rpcUrls.default.http[0];
  const account = await accountFrom(opts.privateKey, opts.provider);
  const transport = opts.provider ? custom(opts.provider) : http(rpc);
  const walletClient = createWalletClient({ account, chain, transport });
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  return contractRegistry({ address: opts.contract, publicClient, walletClient });
}

export function cidToBytes(cid: string): Hex {
  if (!cid) return "0x";
  return toHex(new TextEncoder().encode(cid));
}

export function bytesToCid(value: Hex): string {
  if (!value || value === "0x") return "";
  return new TextDecoder().decode(hexToBytes(value));
}

async function accountFrom(privateKey?: string, provider?: Eip1193Provider): Promise<Account | Hex> {
  if (privateKey) {
    const hex = (privateKey.startsWith("0x") ? privateKey : "0x" + privateKey) as Hex;
    return privateKeyToAccount(hex);
  }
  if (!provider) throw new Error("Connect a wallet or enter a key");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts[0]) throw new Error("The wallet did not return an account");
  return getAddress(accounts[0]);
}

function signerAddress(wallet: WalletClient): Hex {
  const account = wallet.account;
  if (!account) throw new Error("wallet has no account");
  return typeof account === "string" ? getAddress(account) : getAddress(account.address);
}

function isPrevMismatch(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { message?: string; name?: string; data?: { errorName?: string }; cause?: unknown; shortMessage?: string };
    if (record.data?.errorName === "PrevMismatch") return true;
    if (record.name === "PrevMismatch") return true;
    const text = (record.shortMessage || "") + (record.message || "");
    if (text.includes("PrevMismatch")) return true;
    current = record.cause;
  }
  return false;
}
