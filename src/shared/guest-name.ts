/** Friendly default names: "<Adjective> <Animal>", picked by an MT19937 seeded from a wallet address or browser id. */

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

/** MT19937 (Matsumoto & Nishimura), 32-bit output. */
export class MersenneTwister {
  private mt = new Uint32Array(624);
  private index = 625;

  constructor(seed: number) {
    this.mt[0] = seed >>> 0;
    for (let i = 1; i < 624; i++) {
      const prev = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
      this.mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.index = 624;
  }

  nextUint32(): number {
    if (this.index >= 624) {
      for (let i = 0; i < 624; i++) {
        const y = (this.mt[i] & 0x80000000) | (this.mt[(i + 1) % 624] & 0x7fffffff);
        let next = this.mt[(i + 397) % 624] ^ (y >>> 1);
        if (y & 1) next ^= 0x9908b0df;
        this.mt[i] = next >>> 0;
      }
      this.index = 0;
    }
    let y = this.mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
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
  const rng = new MersenneTwister(seedOf(seedText));
  const adjective = ADJECTIVES[rng.nextUint32() % ADJECTIVES.length];
  const animal = ANIMALS[rng.nextUint32() % ANIMALS.length];
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

/** Name order: one typed in this editor, the FiFolders display name, then a wallet- or browser-derived guest name. */
export function resolveDisplayName(): string {
  try {
    const typed = sessionStorage.getItem("felarumi-name") || sessionStorage.getItem("folio-name");
    if (typed) return typed;
  } catch {
    // Fall through to stored names.
  }
  const local = store();
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
