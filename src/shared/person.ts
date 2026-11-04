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
  try {
    const eth = injectedWallet() as { request?: (a: { method: string }) => Promise<unknown> } | undefined;
    const request = safeGet(eth, "request");
    if (typeof request !== "function") return false;
    const accounts = (await (request as (a: { method: string }) => Promise<unknown>).call(eth, { method: "eth_accounts" })) as string[];
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

type WalletEvents = { on?: (event: string, fn: (value: unknown) => void) => void; removeListener?: (event: string, fn: (value: unknown) => void) => void };

/**
 * Read one property of a wallet provider without ever throwing. Wallet extensions inject Proxies around
 * `window.ethereum`; some break the Proxy invariants (a frozen target with a non-configurable `on` whose
 * trap returns a different function), so a plain `eth.on` throws a TypeError. Never wrap, Proxy or freeze it.
 */
export function safeGet(target: unknown, key: string): unknown {
  if (!target || (typeof target !== "object" && typeof target !== "function")) return undefined;
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** `window.ethereum`, or undefined when it is missing or its getter throws. */
export function injectedWallet(): unknown {
  try {
    return (globalThis as unknown as { ethereum?: unknown }).ethereum;
  } catch {
    return undefined;
  }
}

/**
 * Subscribe to a provider event. "ok", "none" (provider has no `on`, e.g. a request-only wallet), or
 * "broken" (reading or calling `on` threw). Never throws.
 */
export function safeOn(provider: unknown, event: string, fn: (value: unknown) => void): "ok" | "none" | "broken" {
  if (!provider || (typeof provider !== "object" && typeof provider !== "function")) return "none";
  let on: unknown;
  try {
    on = (provider as Record<string, unknown>).on;
  } catch {
    return "broken";
  }
  if (typeof on !== "function") return "none";
  try {
    on.call(provider, event, fn);
    return "ok";
  } catch {
    return "broken";
  }
}

export function safeOff(provider: unknown, event: string, fn: (value: unknown) => void): void {
  for (const name of ["removeListener", "off"]) {
    const off = safeGet(provider, name);
    if (typeof off !== "function") continue;
    try {
      off.call(provider, event, fn);
      return;
    } catch {
      /* hostile provider: ignore */
    }
  }
}

/**
 * Wallet account or network switch: restart the person in place (no reload, no prompt).
 * accountsChanged → remember the new wallet (or forget it), re-read its identity, call `onChange`.
 * chainChanged → `onChange` too (the network decides which identity registry is read). Also follows
 * another tab (FiFolders) writing the wallet key. Listens on `window.ethereum` and on every EIP-6963
 * announced provider. Never throws: a broken wallet only loses live switching. Returns a test hook
 * that applies a change directly; `.failed` is true when `window.ethereum` threw on subscribe.
 */
export function watchWallet(onChange: () => void, eth: unknown = injectedWallet()): ((accounts: string[]) => Promise<void>) & { failed?: boolean; stop?: () => void } {
  const apply = (async (accounts: string[]) => {
    const address = String((Array.isArray(accounts) ? accounts[0] : "") || "").toLowerCase();
    try {
      if (isAddress(address)) localStorage.setItem(WALLET_KEY, address);
      else localStorage.removeItem(WALLET_KEY);
    } catch {
      /* storage blocked: names fall back to guest */
    }
    onChange();
    if (await refreshIdentity(myWallet()).catch(() => false)) onChange();
  }) as ((accounts: string[]) => Promise<void>) & { failed?: boolean; stop?: () => void };
  const onAccounts = (value: unknown) => void apply(value as string[]);
  const onChain = () => {
    try {
      onChange();
    } catch {
      /* ignore */
    }
  };
  const seen = new Set<unknown>();
  const offs: Array<() => void> = [];
  const attach = (provider: unknown): boolean => {
    if (!provider || seen.has(provider)) return true;
    seen.add(provider);
    const ok = safeOn(provider, "accountsChanged", onAccounts) !== "broken" && safeOn(provider, "chainChanged", onChain) !== "broken";
    offs.push(() => {
      safeOff(provider, "accountsChanged", onAccounts);
      safeOff(provider, "chainChanged", onChain);
    });
    return ok;
  };
  if (eth && !attach(eth)) apply.failed = true;
  // EIP-6963: several wallets can each announce their own provider.
  const onAnnounce = (event: Event) => {
    try {
      attach(safeGet(safeGet(event, "detail"), "provider"));
    } catch {
      /* ignore */
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === WALLET_KEY) onChange();
  };
  try {
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  } catch {
    /* a wallet's announce handler threw */
  }
  window.addEventListener("storage", onStorage);
  apply.stop = () => {
    window.removeEventListener("eip6963:announceProvider", onAnnounce);
    window.removeEventListener("storage", onStorage);
    for (const off of offs) off();
  };
  return apply;
}
