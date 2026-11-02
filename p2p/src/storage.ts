/** Pluggable snapshot storage. Filecoin via Synapse is the default. */

export type FilecoinNetwork = "mainnet" | "calibration";

export const DEFAULT_NETWORK: FilecoinNetwork = "mainnet";

export const RPC_URLS: Record<FilecoinNetwork, string> = {
  mainnet: "https://api.node.glif.io/rpc/v1",
  calibration: "https://api.calibration.node.glif.io/rpc/v1",
};

export const TRYSTERO_APP_ID = "felarumi.collab";

export function normalizeNetwork(value: unknown): FilecoinNetwork {
  return value === "calibration" ? "calibration" : "mainnet";
}

/** Nostr relays checked reachable (Nov 2026). Trystero's default list includes dead hosts that spam reconnect errors. */
export const NOSTR_RELAYS = ["wss://nos.lol", "wss://relay.primal.net", "wss://relay.snort.social", "wss://nostr.mom", "wss://offchain.pub"];

export function trysteroOptions(secret: string): { appId: string; password: string; relayConfig: { urls: string[]; warnOnRelayFailure: boolean } } {
  return { appId: TRYSTERO_APP_ID, password: secret, relayConfig: { urls: NOSTR_RELAYS, warnOnRelayFailure: false } };
}

export interface StorageAdapter {
  put(bytes: Uint8Array): Promise<string>;
  get(id: string): Promise<Uint8Array>;
}

export interface SynapseLike {
  storage: {
    upload(data: Uint8Array): Promise<{ pieceCid: { toString(): string } | string }>;
    download(options: { pieceCid: string }): Promise<Uint8Array>;
  };
}

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export function pieceCidOf(value: { toString(): string } | string): string {
  return typeof value === "string" ? value : value.toString();
}

/** Uploads through a Synapse client. Pass `client` in tests; the live path connects a wallet or a runtime key. */
export async function synapseAdapter(opts: {
  network?: FilecoinNetwork;
  privateKey?: string;
  provider?: Eip1193Provider;
  client?: SynapseLike;
}): Promise<StorageAdapter> {
  const network = normalizeNetwork(opts.network);
  const client = opts.client ?? (await connectSynapse(network, opts.privateKey, opts.provider));
  return {
    async put(bytes: Uint8Array): Promise<string> {
      const result = await client.storage.upload(bytes);
      return pieceCidOf(result.pieceCid);
    },
    get(pieceCid: string): Promise<Uint8Array> {
      return client.storage.download({ pieceCid });
    },
  };
}

async function connectSynapse(network: FilecoinNetwork, privateKey?: string, provider?: Eip1193Provider): Promise<SynapseLike> {
  const { Synapse } = await lazy(() => import("@filoz/synapse-sdk"));
  const chains = await lazy(() => import("@filoz/synapse-core/chains"));
  const { custom, http } = await lazy(() => import("viem"));
  const chain = network === "calibration" ? chains.calibration : chains.mainnet;
  const rpc = RPC_URLS[network];
  if (privateKey) {
    const { privateKeyToAccount } = await lazy(() => import("viem/accounts"));
    const hex = (privateKey.startsWith("0x") ? privateKey : "0x" + privateKey) as `0x${string}`;
    return Synapse.create({
      account: privateKeyToAccount(hex),
      chain,
      transport: http(rpc),
      source: "felarumi",
    });
  }
  if (!provider) throw new Error("Connect a wallet or enter a key");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const address = accounts[0];
  if (!address) throw new Error("The wallet did not return an account");
  return Synapse.create({
    account: address as `0x${string}`,
    chain,
    transport: custom(provider),
    source: "felarumi",
  });
}

export const UNANCHORED = "unanchored";

export const STALE_BUILD = "FiPen was updated. Reload the page to continue.";

/** True for the browser errors a lazy chunk gives when a deploy replaced its hashed file. */
export function isChunkLoadError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported|Failed to fetch/i.test(text);
}

/** Loads a lazy chunk. A missing chunk means this tab predates a deploy, so say so instead of failing opaquely. */
export async function lazy<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (isChunkLoadError(err)) throw new Error(STALE_BUILD);
    throw err;
  }
}

/** Fetches the wallet, Synapse, and piece chunks while they still match this page, so signing works after a later deploy. */
export function warmSigningModules(): Promise<unknown> {
  return Promise.all([
    import("@filoz/synapse-sdk"),
    import("@filoz/synapse-core/chains"),
    import("@filoz/synapse-core/piece"),
    import("viem"),
    import("viem/accounts"),
  ]).catch(() => undefined);
}

/** Local Filecoin CommP / PieceCID. Falls back to a sentinel when the calculator cannot run. */
export async function commpOf(bytes: Uint8Array): Promise<string> {
  let piece: typeof import("@filoz/synapse-core/piece");
  try {
    piece = await lazy(() => import("@filoz/synapse-core/piece"));
  } catch (err) {
    if (err instanceof Error && err.message === STALE_BUILD) throw err;
    return UNANCHORED;
  }
  try {
    return (await piece.calculate(bytes)).toString();
  } catch {
    return UNANCHORED;
  }
}

/** File-adapter anchor: store the bytes under their PieceCID, or `unanchored` when CommP is unavailable. */
export function commpAdapter(memory: Map<string, Uint8Array> = new Map()): StorageAdapter {
  return {
    async put(bytes: Uint8Array): Promise<string> {
      const id = await commpOf(bytes);
      memory.set(id, bytes);
      return id;
    },
    async get(id: string): Promise<Uint8Array> {
      const hit = memory.get(id);
      if (!hit) throw new Error("missing file " + id);
      return hit;
    },
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Download / upload a JSON snapshot. The content id is `file:` plus the sha256. */
export function fileAdapter(memory: Map<string, Uint8Array> = new Map()): StorageAdapter {
  return {
    async put(bytes: Uint8Array): Promise<string> {
      const id = "file:" + (await sha256Hex(bytes));
      memory.set(id, bytes);
      return id;
    },
    async get(id: string): Promise<Uint8Array> {
      const hit = memory.get(id);
      if (!hit) throw new Error("missing file " + id);
      return hit;
    },
  };
}

const IPFS_UPLOAD = "https://api.web3.storage/upload";
const IPFS_READ = "https://w3s.link/ipfs/";

/** Secondary adapter. The token is supplied at runtime and is not stored in the repo. */
export function ipfsAdapter(token: string, fetchImpl: typeof fetch = fetch): StorageAdapter {
  return {
    async put(bytes: Uint8Array): Promise<string> {
      const res = await fetchImpl(IPFS_UPLOAD, {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/octet-stream" },
        body: bytes,
      });
      if (!res.ok) throw new Error("IPFS upload failed");
      const body = (await res.json()) as { cid?: string };
      if (!body.cid) throw new Error("IPFS upload returned no cid");
      return body.cid;
    },
    async get(cid: string): Promise<Uint8Array> {
      const res = await fetchImpl(IPFS_READ + encodeURIComponent(cid));
      if (!res.ok) throw new Error("IPFS read failed");
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** Public, keyless sources for a saved version: FilBeam for piece CIDs (needs the payer address), then an IPFS gateway. */
export function savedVersionUrls(cid: string, owner: string, network: FilecoinNetwork): string[] {
  const urls: string[] = [];
  if (/^0x[0-9a-fA-F]{40}$/.test(owner) && cid.startsWith("bafkzcib")) {
    urls.push(`https://${owner.toLowerCase()}.${network === "calibration" ? "calibration." : ""}filbeam.io/${cid}`);
  }
  if (/^(bafy|bafk|Qm)/.test(cid)) urls.push(`https://w3s.link/ipfs/${cid}`);
  return urls;
}

