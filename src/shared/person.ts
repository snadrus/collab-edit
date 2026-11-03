/** FiPen/FiGrid person wiring. All names, identity reads and avatars come from FiPerson (`fiperson/view`). */
import {
  CALIBRATION_REGISTRY,
  CALIBRATION_RPC,
  WALLET_KEY,
  cachedIdentity,
  fetchPieceFromProviders,
  identityUrl,
  isAddress,
  openIdentityPopup,
  parseIdentity,
  registryHeadReader,
  resolveDisplayName,
  resolveIdentity,
  type ResolvedIdentity,
} from "fiperson/view";

export { WALLET_KEY, avatarInnerHtml, cachedIdentity, guestName, resolveDisplayName } from "fiperson/view";

export function myWallet(): string | null {
  try {
    const w = localStorage.getItem(WALLET_KEY);
    return isAddress(w) ? w : null;
  } catch {
    return null;
  }
}

/** Reads an already-connected wallet (no prompt) and remembers it. Resolves true when it changed. */
export async function learnWallet(): Promise<boolean> {
  const eth = (globalThis as unknown as { ethereum?: { request?: (a: { method: string }) => Promise<unknown> } }).ethereum;
  if (!eth?.request) return false;
  try {
    const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
    const address = (accounts?.[0] || "").toLowerCase();
    if (!isAddress(address) || localStorage.getItem(WALLET_KEY) === address) return false;
    localStorage.setItem(WALLET_KEY, address);
    return true;
  } catch {
    return false;
  }
}

type ProviderInfo = { pdp?: { serviceURL?: string }; serviceURL?: string };
/**
 * PDP service URLs from `getPDPProviders`. synapse-core 0.10 returns `{ items }` (0.4 returned `{ providers }`);
 * reading only `.providers` threw, the catch turned it into "no providers", and saved identities showed as guest names.
 */
export function providerUrlsFrom(out: { items?: ProviderInfo[]; providers?: ProviderInfo[] } | null | undefined): string[] {
  const list = out?.items ?? out?.providers ?? [];
  return list.map((p) => p.pdp?.serviceURL ?? p.serviceURL ?? "").filter(Boolean);
}

let providers: Promise<string[]> | null = null;
async function fetchPiece(pieceCid: string): Promise<Uint8Array> {
  providers ??= (async () => {
    const [{ getPDPProviders }, chains, { createPublicClient, http }] = await Promise.all([import("@filoz/synapse-core/sp-registry"), import("@filoz/synapse-core/chains"), import("viem")]);
    const client = createPublicClient({ chain: chains.calibration as never, transport: http(CALIBRATION_RPC) });
    const out = await getPDPProviders(client as never, { onlyActive: true, limit: 200n } as never);
    return providerUrlsFrom(out);
  })().catch(() => []);
  return fetchPieceFromProviders(pieceCid, await providers, (bytes) => parseIdentity(bytes) !== null);
}

/** Refresh your identity from chain (Calibration; cached 5 min). Resolves true when your name changed. */
export async function refreshIdentity(address: string | null): Promise<boolean> {
  if (!address || localStorage.getItem("fifolders:network") === "mainnet") return false;
  const before = cachedIdentity(address).displayName;
  const after = await resolveIdentity(address, { head: registryHeadReader(CALIBRATION_RPC, CALIBRATION_REGISTRY), fetchPiece });
  return after.displayName !== before;
}

function self(): ResolvedIdentity | { address: undefined; displayName: string; source: "guest"; identity: null } {
  const w = myWallet();
  const name = resolveDisplayName();
  return w ? { ...cachedIdentity(w), displayName: cachedIdentity(w).identity ? cachedIdentity(w).displayName : name } : { address: undefined, displayName: name, source: "guest", identity: null };
}

/** Your person for avatars: identity emoji/color, else your wallet's pixel avatar, else initial. */
export function selfPerson(): { address?: string; displayName: string; avatar?: { emoji?: string; color?: string } } {
  const s = self();
  return { address: s.address, displayName: s.displayName, avatar: "avatar" in s ? s.avatar : undefined };
}

/** Pop-up from your own name/avatar: "Configure your identity" or your identity with Edit. */
export function showSelfIdentity(anchor: HTMLElement, onLocalRename?: () => void): HTMLElement {
  return openIdentityPopup(anchor, { person: self() as ResolvedIdentity, href: identityUrl(), onLocalRename });
}

type WalletEvents = { on?: (event: string, fn: (value: unknown) => void) => void };

/**
 * Wallet account or network switch: restart the person in place (no reload, no prompt).
 * accountsChanged → remember the new wallet (or forget it), re-read its identity, call `onChange`.
 * chainChanged → `onChange` too (the network decides which identity registry is read). Also follows
 * another tab (FiFolders) writing the wallet key. Returns a test hook that applies a change directly.
 */
export function watchWallet(onChange: () => void, eth: WalletEvents | undefined = (globalThis as unknown as { ethereum?: WalletEvents }).ethereum): (accounts: string[]) => Promise<void> {
  const apply = async (accounts: string[]) => {
    const address = String(accounts?.[0] || "").toLowerCase();
    try {
      if (isAddress(address)) localStorage.setItem(WALLET_KEY, address);
      else localStorage.removeItem(WALLET_KEY);
    } catch {
      /* storage blocked: names fall back to guest */
    }
    onChange();
    if (await refreshIdentity(myWallet()).catch(() => false)) onChange();
  };
  eth?.on?.("accountsChanged", (value) => void apply(value as string[]));
  eth?.on?.("chainChanged", () => onChange());
  window.addEventListener("storage", (event) => {
    if (event.key === WALLET_KEY) onChange();
  });
  return apply;
}
