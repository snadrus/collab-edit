/**
 * Wallet identity shared with FiFolders' /identity/ page (same origin).
 * Contract (see filecoin-folders docs/identity.md):
 *   localStorage["fil-identity:v1:<lowercase address>"] = { identity: { v: 1, address, displayName, avatar?, bio? }, pieceCid, version, checkedAt }
 *   chain: FolderRegistry.head(owner, keccak256("fil-identity"), keccak256("profile")) -> PieceCID of the JSON piece.
 */

export const IDENTITY_CACHE_PREFIX = "fil-identity:v1:";
export const IDENTITY_REGISTRY_CALIBRATION = "0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331";
const CALIBRATION_RPC = "https://api.calibration.node.glif.io/rpc/v1";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface WalletIdentity {
  address: string;
  displayName: string;
  avatar?: { emoji?: string; color?: string };
  bio?: string;
}

function store(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** Parse a v1 identity doc; null when it is not one for `expected`. */
export function parseIdentity(value: unknown, expected?: string): WalletIdentity | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1 || typeof raw.address !== "string" || !ADDRESS.test(raw.address)) return null;
  if (expected && raw.address.toLowerCase() !== expected.toLowerCase()) return null;
  const displayName = typeof raw.displayName === "string" ? raw.displayName.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  if (!displayName) return null;
  const avatar = raw.avatar && typeof raw.avatar === "object" ? (raw.avatar as Record<string, unknown>) : null;
  const emoji = typeof avatar?.emoji === "string" ? avatar.emoji.slice(0, 16) : "";
  const color = typeof avatar?.color === "string" && /^#[0-9a-fA-F]{6}$/.test(avatar.color) ? avatar.color : "";
  const bio = typeof raw.bio === "string" ? raw.bio.slice(0, 280) : "";
  return {
    address: raw.address.toLowerCase(),
    displayName,
    ...(emoji || color ? { avatar: { ...(emoji ? { emoji } : {}), ...(color ? { color } : {}) } } : {}),
    ...(bio ? { bio } : {}),
  };
}

/** Cached identity for an address, no network. */
export function cachedIdentity(address: string | null | undefined): WalletIdentity | null {
  if (!address || !ADDRESS.test(address)) return null;
  try {
    const raw = store()?.getItem(IDENTITY_CACHE_PREFIX + address.toLowerCase());
    return raw ? parseIdentity((JSON.parse(raw) as { identity?: unknown }).identity, address) : null;
  } catch {
    return null;
  }
}

/** Where to configure the identity, returning to this page after Save. FiPen/FiGrid live one level under the site root. */
export function identityUrl(here: string = location.href): string {
  const url = new URL("../identity/", here);
  url.searchParams.set("return", here);
  return url.href;
}

/**
 * Refresh the cache from chain (Calibration FolderRegistry) + piece. Resolves true when the cached name changed.
 * Best effort: any failure keeps the cache.
 */
export async function refreshIdentity(address: string | null | undefined): Promise<boolean> {
  if (!address || !ADDRESS.test(address)) return false;
  const network = store()?.getItem("fifolders:network");
  if (network === "mainnet") return false;
  const lower = address.toLowerCase();
  const key = IDENTITY_CACHE_PREFIX + lower;
  let previous: { pieceCid?: string; checkedAt?: number; identity?: unknown } | null = null;
  try {
    previous = JSON.parse(store()?.getItem(key) || "null");
  } catch {
    previous = null;
  }
  if (previous?.checkedAt && Date.now() - previous.checkedAt < 5 * 60_000) return false;
  try {
    const { createPublicClient, http, keccak256, stringToBytes, hexToString } = await import("viem");
    const client = createPublicClient({ transport: http(CALIBRATION_RPC) });
    const [cidHex, version] = (await client.readContract({
      address: IDENTITY_REGISTRY_CALIBRATION,
      abi: [{ type: "function", name: "head", stateMutability: "view", inputs: [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }], outputs: [{ type: "bytes" }, { type: "uint64" }] }],
      functionName: "head",
      args: [lower as `0x${string}`, keccak256(stringToBytes("fil-identity")), keccak256(stringToBytes("profile"))],
    })) as [`0x${string}`, bigint];
    const pieceCid = cidHex === "0x" ? "" : hexToString(cidHex);
    let identity: WalletIdentity | null = null;
    if (pieceCid && pieceCid === previous?.pieceCid) identity = parseIdentity(previous?.identity, lower);
    else if (pieceCid) {
      const { getPDPProviders } = await import("@filoz/synapse-core/sp-registry");
      const chains = await import("@filoz/synapse-core/chains");
      const spClient = createPublicClient({ chain: chains.calibration as never, transport: http(CALIBRATION_RPC) });
      const out = await getPDPProviders(spClient as never, { onlyActive: true, limit: 200n } as never);
      const urls = out.providers.map((p: { pdp?: { serviceURL?: string } }) => p.pdp?.serviceURL ?? "").filter(Boolean);
      identity = await Promise.any(
        urls.map(async (base: string) => {
          const res = await fetch(new URL(`/piece/${encodeURIComponent(pieceCid)}`, base), { signal: AbortSignal.timeout(20_000) });
          if (!res.ok) throw new Error(String(res.status));
          const parsed = parseIdentity(JSON.parse(await res.text()), lower);
          if (!parsed) throw new Error("not an identity");
          return parsed;
        }),
      );
    }
    const before = cachedIdentity(lower)?.displayName ?? "";
    store()?.setItem(key, JSON.stringify({ identity: identity ? { v: 1, ...identity } : null, pieceCid, version: version.toString(), checkedAt: Date.now() }));
    return (identity?.displayName ?? "") !== before;
  } catch {
    return false;
  }
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Pop-up from your own name/avatar. Without an identity it explains and links to /identity/;
 * with one it shows it with an Edit link. `onLocalRename` keeps the old per-session name override.
 */
export function openIdentityPopup(anchor: HTMLElement, opts: { address: string | null; currentName: string; onLocalRename?: () => void }): HTMLElement {
  document.querySelector("#identity-pop")?.remove();
  const id = cachedIdentity(opts.address);
  const pop = document.createElement("div");
  pop.id = "identity-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", id ? "Your identity" : "Configure your identity");
  pop.style.cssText =
    "position:fixed;z-index:1000;width:300px;background:#fff;color:#202124;border:1px solid #dadce0;border-radius:12px;box-shadow:0 4px 16px rgba(60,64,67,.25);padding:16px;font:14px/1.45 Roboto,system-ui,sans-serif";
  const button = "display:inline-block;background:#1a73e8;color:#fff;border:0;border-radius:18px;padding:8px 18px;font:inherit;font-weight:500;cursor:pointer;text-decoration:none";
  const link = "background:none;border:0;padding:0;color:#1a73e8;font:inherit;cursor:pointer;text-decoration:none";
  if (id) {
    const glyph = id.avatar?.emoji || (id.displayName[0] || "?").toUpperCase();
    pop.innerHTML = `<div style="display:flex;gap:12px;align-items:center">
        <span style="width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-size:20px;background:${esc(id.avatar?.color || "#e8eaed")};color:${id.avatar?.color ? "#fff" : "#202124"}">${esc(glyph)}</span>
        <span><strong data-testid="identity-pop-name">${esc(id.displayName)}</strong><br><small style="color:#5f6368">${esc(id.address.slice(0, 6) + "…" + id.address.slice(-4))}</small></span></div>
      ${id.bio ? `<p style="margin:10px 0 0;color:#3c4043">${esc(id.bio)}</p>` : ""}
      <p style="margin:12px 0 0"><a data-testid="identity-pop-edit" href="${esc(identityUrl())}" style="${link}">Edit</a></p>`;
  } else {
    pop.innerHTML = `<h3 style="margin:0 0 6px;font-size:16px;font-weight:500">Configure your identity</h3>
      <p style="margin:0 0 12px;color:#3c4043">Pick one name and avatar for your wallet. It is saved on Filecoin and linked to your wallet, so FiPen, FiGrid, FiFolders — and everyone you share with — see the same name. Right now you show as <strong>${esc(opts.currentName)}</strong>.</p>
      <a data-testid="identity-pop-configure" href="${esc(identityUrl())}" style="${button}">Configure your identity</a>
      ${opts.onLocalRename ? `<p style="margin:10px 0 0"><button type="button" data-testid="identity-pop-local" style="${link};font-size:13px">Just use a different name here</button></p>` : ""}`;
  }
  pop.querySelector("[data-testid=identity-pop-local]")?.addEventListener("click", () => {
    close();
    opts.onLocalRename?.();
  });
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.top = `${Math.round(rect.bottom + 6)}px`;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 308, Math.round(rect.right - 300)))}px`;
  const onDoc = (event: Event) => {
    if (!pop.contains(event.target as Node) && event.target !== anchor) close();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  function close() {
    pop.remove();
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey);
  }
  setTimeout(() => {
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onKey);
  });
  return pop;
}
