import type { PieceStore } from "./types.ts";
import type { Eip1193Provider } from "./registry.ts";

export interface SynapseLike {
  storage: {
    upload(data: Uint8Array): Promise<{ pieceCid: { toString(): string } | string }>;
    download(options: { pieceCid: string }): Promise<Uint8Array>;
  };
}

export const FOLDER_RPC = {
  mainnet: "https://api.node.glif.io/rpc/v1",
  calibration: "https://api.calibration.node.glif.io/rpc/v1",
} as const;

/** Synapse piece store. Pass `client` in tests; the live path uses a wallet or a runtime key. */
export async function synapseStore(opts: {
  network?: "mainnet" | "calibration";
  privateKey?: string;
  provider?: Eip1193Provider;
  client?: SynapseLike;
} = {}): Promise<PieceStore> {
  const client = opts.client ?? (await connectSynapse(opts.network === "calibration" ? "calibration" : "mainnet", opts.privateKey, opts.provider));
  return {
    async put(bytes: Uint8Array): Promise<string> {
      const result = await client.storage.upload(bytes);
      return typeof result.pieceCid === "string" ? result.pieceCid : result.pieceCid.toString();
    },
    get(pieceCid: string): Promise<Uint8Array> {
      return client.storage.download({ pieceCid });
    },
  };
}

async function connectSynapse(network: "mainnet" | "calibration", privateKey?: string, provider?: Eip1193Provider): Promise<SynapseLike> {
  const { Synapse } = await import("@filoz/synapse-sdk");
  const chains = await import("@filoz/synapse-core/chains");
  const { custom, http } = await import("viem");
  const chain = network === "calibration" ? chains.calibration : chains.mainnet;
  const rpc = FOLDER_RPC[network];
  if (privateKey) {
    const { privateKeyToAccount } = await import("viem/accounts");
    const hex = (privateKey.startsWith("0x") ? privateKey : "0x" + privateKey) as `0x${string}`;
    return Synapse.create({ account: privateKeyToAccount(hex), chain, transport: http(rpc), source: "fil-folders" });
  }
  if (!provider) throw new Error("Connect a wallet or enter a key");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts[0]) throw new Error("The wallet did not return an account");
  return Synapse.create({
    account: accounts[0] as `0x${string}`,
    chain,
    transport: custom(provider),
    source: "fil-folders",
  });
}
