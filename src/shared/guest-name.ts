/** Friendly default names: "<Adjective> <Animal>", picked by xoshiro128++ seeded from a wallet address or browser id. */

export const ADJECTIVES = [
  "Able", "Agile", "Amber", "Amiable", "Ample", "Upbeat", "Ardent", "Artful", "Awesome", "Balanced",
  "Beaming", "Bold", "Bouncy", "Brave", "Breezy", "Bright", "Brilliant", "Bubbly", "Calm", "Candid",
  "Careful", "Charming", "Cheerful", "Chipper", "Classy", "Clever", "Comfy", "Cosmic", "Cozy", "Curious",
  "Dandy", "Daring", "Dazzling", "Dapper", "Devoted", "Diligent", "Dreamy", "Eager", "Earnest", "Easygoing",
  "Elegant", "Epic", "Fearless", "Festive", "Fiery", "Friendly", "Gallant", "Generous", "Gentle", "Genuine",
  "Gifted", "Gleeful", "Glowing", "Golden", "Graceful", "Grand", "Grateful", "Happy", "Hardy", "Helpful",
  "Heroic", "Honest", "Hopeful", "Humble", "Jolly", "Jovial", "Joyful", "Keen", "Kind", "Lively",
  "Loyal", "Lucky", "Lucid", "Magical", "Merry", "Mighty", "Mindful", "Modest", "Nimble", "Noble",
  "Optimistic", "Patient", "Peaceful", "Peppy", "Playful", "Plucky", "Polite", "Proud", "Quick", "Quiet",
  "Radiant", "Rapid", "Ready", "Serene", "Sincere", "Sparkly", "Spirited", "Steady", "Sunny", "Swift",
  "Thoughtful", "Tidy", "Trusty", "Valiant", "Vibrant", "Vivid", "Warm", "Wise", "Witty", "Zesty",
];

export const ANIMALS = [
  "Aardvark", "Albatross", "Alpaca", "Antelope", "Armadillo", "Badger", "Beaver", "Bison", "Bluebird", "Bobcat",
  "Buffalo", "Bumblebee", "Butterfly", "Camel", "Capybara", "Cardinal", "Caribou", "Cheetah", "Chickadee", "Chinchilla",
  "Chipmunk", "Cougar", "Coyote", "Crane", "Cricket", "Deer", "Dingo", "Dolphin", "Dove", "Dragonfly",
  "Duck", "Eagle", "Elephant", "Elk", "Falcon", "Ferret", "Finch", "Firefly", "Flamingo", "Fox",
  "Frog", "Gazelle", "Gecko", "Giraffe", "Goldfish", "Goose", "Gorilla", "Hamster", "Hare", "Hawk",
  "Hedgehog", "Heron", "Hippo", "Hummingbird", "Ibex", "Iguana", "Jackrabbit", "Jaguar", "Jay", "Kangaroo",
  "Kingfisher", "Kitten", "Koala", "Ladybug", "Lark", "Lemur", "Leopard", "Lion", "Llama", "Lynx",
  "Macaw", "Manatee", "Meerkat", "Mongoose", "Moose", "Narwhal", "Newt", "Ocelot", "Octopus", "Orca",
  "Otter", "Owl", "Panda", "Panther", "Parrot", "Peacock", "Pelican", "Penguin", "Puffin", "Puma",
  "Quail", "Rabbit", "Raccoon", "Raven", "Reindeer", "Robin", "Salamander", "Seahorse", "Seal", "Sparrow",
  "Squirrel", "Starfish", "Swan", "Tiger", "Toucan", "Turtle", "Walrus", "Whale", "Wombat", "Zebra",
];

/** splitmix32: expands one 32-bit seed into well-mixed words for the xoshiro state. */
export function splitmix32(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x9e3779b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/** xoshiro128++ (Blackman & Vigna), 32-bit output. */
export class Xoshiro128pp {
  private s: Uint32Array;

  constructor(state: [number, number, number, number]) {
    this.s = Uint32Array.from(state);
    if (!(this.s[0] | this.s[1] | this.s[2] | this.s[3])) this.s[0] = 1;
  }

  static fromSeed(seed: number): Xoshiro128pp {
    const next = splitmix32(seed);
    return new Xoshiro128pp([next(), next(), next(), next()]);
  }

  nextUint32(): number {
    const s = this.s;
    const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;
    const result = (rotl((s[0] + s[3]) >>> 0, 7) + s[0]) >>> 0;
    const t = (s[1] << 9) >>> 0;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 11);
    return result;
  }
}

/** Unbiased index in [0, n): reject draws at or above the largest multiple of n below 2^32. */
export function pickIndex(next: () => number, n: number): number {
  const span = 2 ** 32;
  const limit = span - (span % n);
  let u = next() >>> 0;
  while (u >= limit) u = next() >>> 0;
  return u % n;
}

/** FNV-1a 32-bit hash of the lowercased seed text. */
export function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (const ch of text.trim().toLowerCase()) {
    hash ^= ch.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Same wallet address (or browser id) gives the same name everywhere. */
export function guestName(seedText: string): string {
  const rng = Xoshiro128pp.fromSeed(seedOf(seedText));
  const next = () => rng.nextUint32();
  const adjective = ADJECTIVES[pickIndex(next, ADJECTIVES.length)];
  const animal = ANIMALS[pickIndex(next, ANIMALS.length)];
  return `${adjective} ${animal}`;
}

export const WALLET_KEY = "fipen:wallet";
export const BROWSER_ID_KEY = "fipen:browser-id";
/** Shared with FiFolders (same origin). */
export const FIFOLDERS_NAME_KEY = "fifolders:display-name";

function store(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function identityName(local: Storage | null, wallet: string): string {
  try {
    const raw = local?.getItem("fil-identity:v1:" + wallet.toLowerCase());
    const id = raw ? (JSON.parse(raw) as { identity?: { v?: number; address?: string; displayName?: unknown } }).identity : null;
    if (id?.v !== 1 || id.address?.toLowerCase() !== wallet.toLowerCase() || typeof id.displayName !== "string") return "";
    return id.displayName.trim().slice(0, 60);
  } catch {
    return "";
  }
}

/** Name order: the wallet identity, one typed in this editor, the legacy FiFolders display name, then a wallet- or browser-derived guest name. */
export function resolveDisplayName(): string {
  const early = store();
  const w = early?.getItem(WALLET_KEY) || "";
  const own = /^0x[0-9a-fA-F]{40}$/.test(w) ? identityName(early, w) : "";
  if (own) return own;
  try {
    const typed = sessionStorage.getItem("felarumi-name") || sessionStorage.getItem("folio-name");
    if (typed) return typed;
  } catch {
    // Fall through to stored names.
  }
  const local = store();
  const wallet0 = local?.getItem(WALLET_KEY) || "";
  // Wallet identity from /identity/ (chain-backed, cached by every app on the origin).
  const identity = /^0x[0-9a-fA-F]{40}$/.test(wallet0) ? identityName(local, wallet0) : "";
  if (identity) return identity;
  const shared = local?.getItem(FIFOLDERS_NAME_KEY)?.trim();
  if (shared) return shared.slice(0, 60);
  const wallet = local?.getItem(WALLET_KEY) || "";
  if (/^0x[0-9a-fA-F]{40}$/.test(wallet)) return guestName(wallet);
  let id = local?.getItem(BROWSER_ID_KEY) || "";
  if (!id) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    local?.setItem(BROWSER_ID_KEY, id);
  }
  return guestName(id);
}

/** Reads an already-connected wallet (no prompt) and remembers it. Resolves true when the name source changed. */
export async function learnWallet(): Promise<boolean> {
  const eth = (globalThis as unknown as { ethereum?: { request?: (a: { method: string }) => Promise<unknown> } }).ethereum;
  if (!eth?.request) return false;
  try {
    const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
    const address = (accounts?.[0] || "").toLowerCase();
    const local = store();
    if (!/^0x[0-9a-f]{40}$/.test(address) || local?.getItem(WALLET_KEY) === address) return false;
    local?.setItem(WALLET_KEY, address);
    return true;
  } catch {
    return false;
  }
}
