/** The local caret and selection. Assigned colors are only for other people. */
export const LOCAL_CARET = "#000000";
export const LOCAL_SELECTION = "#a8c7fa";

/** Material Design 500 shades. Assigned in order so active sessions do not share a color. */
export const COLLAB_PALETTE = [
  "#f44336",
  "#2196f3",
  "#4caf50",
  "#9c27b0",
  "#ff9800",
  "#009688",
  "#e91e63",
  "#3f51b5",
  "#ffc107",
  "#00bcd4",
];

export function hexAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = Number.parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return `rgba(33,150,243,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function mix(hex: string, toward: string, t: number): string {
  const parse = (h: string) => {
    const n = Number.parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = parse(hex);
  const b = parse(toward);
  const ch = a.map((v, i) => Math.max(0, Math.min(255, Math.round(v + (b[i] - v) * t))));
  return "#" + ch.map((v) => v.toString(16).padStart(2, "0")).join("");
}

function stableIndex(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return h % COLLAB_PALETTE.length;
}

/**
 * A person's color. With a `key` (wallet, else display name, else session id) the same person gets the same color
 * every time they join, whatever the join order, unless someone already present holds it; then the next free one.
 * Past the tenth active session, step the shade so it still differs.
 */
export function assignColor(used: Iterable<string>, key = ""): string {
  const taken = new Set([...used].map((c) => c.toLowerCase()));
  const start = key ? stableIndex(key.toLowerCase()) : 0;
  for (let i = 0; i < COLLAB_PALETTE.length; i++) {
    const c = COLLAB_PALETTE[(start + i) % COLLAB_PALETTE.length];
    if (!taken.has(c)) return c;
  }
  for (let step = 1; step <= 6; step++) {
    const toward = step % 2 === 1 ? "#000000" : "#ffffff";
    for (let i = 0; i < COLLAB_PALETTE.length; i++) {
      const next = mix(COLLAB_PALETTE[(start + i) % COLLAB_PALETTE.length], toward, 0.22 * Math.ceil(step / 2));
      if (!taken.has(next)) return next;
    }
  }
  return COLLAB_PALETTE[start];
}
