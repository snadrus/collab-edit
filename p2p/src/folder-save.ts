import {
  NotFoundError,
  assertSupportedRuntime,
  createMemoryRegistry,
  createMemoryStorage,
  createSynapseStorage,
  createViemRegistry,
  openVolume,
  type HistoryEntry,
  type Registry,
  type Stat,
  type Storage,
  type SynapseLike,
  type Volume,
} from "fil-folders";
import type { Address, Hex } from "viem";
import { RPC_URLS, type Eip1193Provider } from "./storage.ts";

/** Volume name. The registry key is keccak256("default"). */
export const VOLUME_NAME = "default";

export const FELARUMI_DIR = "/Felarumi";
export const FELANUMIO_DIR = "/Felanumio";

/** Calibration FolderRegistry from deployments/calibration.json. Mainnet has no deployment. */
export const CALIBRATION_REGISTRY = "0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331" as const;
export const CALIBRATION_FROM_BLOCK = 4207373n;

export const NO_REGISTRY_NOTICE = "no registry on this network";

export function registryFor(network: "mainnet" | "calibration"): { address: typeof CALIBRATION_REGISTRY; fromBlock: bigint } | null {
  if (network === "calibration") return { address: CALIBRATION_REGISTRY, fromBlock: CALIBRATION_FROM_BLOCK };
  return null;
}

export function snapshotPath(kind: "felarumi" | "felanumio", title: string): string {
  const clean = title.replace(/[\\/\u0000]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled";
  const dir = kind === "felarumi" ? FELARUMI_DIR : FELANUMIO_DIR;
  const ext = kind === "felarumi" ? ".felarumi" : ".felanumio";
  return `${dir}/${clean}${ext}`;
}

export interface SaveResult {
  path: string;
  pieceCid: string;
  rootCid: string;
  version: bigint;
}

/** Write a snapshot into volume `default` and compare-and-swap the registry head. */
export async function saveSnapshot(opts: {
  kind: "felarumi" | "felanumio";
  title: string;
  bytes: Uint8Array;
  owner: Address;
  storage: Storage;
  registry: Registry;
}): Promise<SaveResult> {
  assertSupportedRuntime();
  const volume = await openVolume({
    storage: opts.storage,
    registry: opts.registry,
    owner: opts.owner,
    name: VOLUME_NAME,
  });
  const path = snapshotPath(opts.kind, opts.title);
  const mime = opts.kind === "felarumi" ? "application/vnd.felarumi+json" : "application/vnd.felanumio+json";
  const stat = await volume.put(path, opts.bytes, { mime });
  const history = await volume.history();
  const latest = history[history.length - 1];
  return {
    path,
    pieceCid: stat.pieceCid ?? "",
    rootCid: latest?.pieceCid ?? "",
    version: latest?.version ?? 0n,
  };
}

export async function listSnapshots(volume: Volume, dir: string): Promise<Stat[]> {
  try {
    return await volume.ls(dir);
  } catch (error) {
    if (error instanceof NotFoundError) return [];
    throw error;
  }
}

export async function volumeHistory(volume: Volume, path?: string): Promise<HistoryEntry[]> {
  return volume.history(path);
}

export function memoryVolumeParts(owner: Address): { storage: Storage; registry: Registry } {
  return { storage: createMemoryStorage(), registry: createMemoryRegistry(owner) };
}

/** Calibration volume. Tests pass storage, registry, and owner and never touch the network. */
export async function openCalibrationVolume(opts: {
  privateKey?: string;
  provider?: Eip1193Provider;
  synapse?: SynapseLike;
  storage?: Storage;
  registry?: Registry;
  owner?: Address;
}): Promise<Volume> {
  assertSupportedRuntime();
  if (opts.storage && opts.registry && opts.owner) {
    return openVolume({ storage: opts.storage, registry: opts.registry, owner: opts.owner, name: VOLUME_NAME });
  }
  const live = await liveCalibration(opts);
  return openVolume({
    storage: opts.storage ?? (opts.synapse ? createSynapseStorage(opts.synapse) : live.storage),
    registry: opts.registry ?? live.registry,
    owner: opts.owner ?? live.owner,
    name: VOLUME_NAME,
  });
}

async function liveCalibration(opts: { privateKey?: string; provider?: Eip1193Provider; synapse?: SynapseLike }): Promise<{
  storage: Storage;
  registry: Registry;
  owner: Address;
}> {
  const { createPublicClient, createWalletClient, custom, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const chains = await import("@filoz/synapse-core/chains");
  const { Synapse } = await import("@filoz/synapse-sdk");
  const chain = chains.calibration;
  const rpc = http(RPC_URLS.calibration);
  let account: Address | ReturnType<typeof privateKeyToAccount>;
  let transport: ReturnType<typeof http> | ReturnType<typeof custom>;
  if (opts.privateKey) {
    const hex = (opts.privateKey.startsWith("0x") ? opts.privateKey : "0x" + opts.privateKey) as Hex;
    account = privateKeyToAccount(hex);
    transport = rpc;
  } else if (opts.provider) {
    const accounts = (await opts.provider.request({ method: "eth_requestAccounts" })) as string[];
    const address = accounts[0];
    if (!address) throw new Error("The wallet did not return an account");
    account = address as Address;
    transport = custom(opts.provider);
  } else {
    throw new Error("Connect a wallet or enter a key");
  }
  const owner = (typeof account === "string" ? account : account.address) as Address;
  const publicClient = createPublicClient({ chain, transport: rpc });
  const walletClient = createWalletClient({ account, chain, transport });
  const synapse = opts.synapse
    ? opts.synapse
    : Synapse.create({
        account,
        chain,
        transport,
        source: "felarumi",
      });
  return {
    storage: createSynapseStorage(synapse),
    registry: createViemRegistry({
      address: CALIBRATION_REGISTRY,
      publicClient,
      walletClient,
      fromBlock: CALIBRATION_FROM_BLOCK,
    }),
    owner,
  };
}
