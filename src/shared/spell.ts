export const DEFAULT_SUBS: Record<string, string> = {
  teh: "the",
  adn: "and",
  recieve: "receive",
  seperate: "separate",
  definately: "definitely",
  occured: "occurred",
  wierd: "weird",
  untill: "until",
  becuase: "because",
  wich: "which",
  "(c)": "©",
  "(r)": "®",
  "(tm)": "™",
  "...": "…",
};

const EXTRA = new Set(["felarumi", "felanumio", "fipen", "figrid"]);

export interface SpellHit {
  start: number;
  end: number;
  word: string;
}

function covered(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) spans.push([match.index, match.index + match[0].length]);
  return spans;
}

function knownWord(key: string, dictionary: Set<string>, allowed: Set<string>): boolean {
  if (dictionary.has(key) || allowed.has(key) || EXTRA.has(key)) return true;
  if (key.endsWith("n't")) return dictionary.has(key.slice(0, -3)) || allowed.has(key.slice(0, -3));
  const stem = key.split("'")[0];
  if (stem && stem !== key && (dictionary.has(stem) || allowed.has(stem))) return true;
  return false;
}

export function misspellings(text: string, dictionary: Set<string>, allowed: Set<string>): SpellHit[] {
  const hits: SpellHit[] = [];
  const skip = covered(text);
  const re = /[A-Za-z']+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const start = match.index;
    const word = match[0];
    const end = start + word.length;
    if (skip.some(([a, b]) => start < b && end > a)) continue;
    const bare = word.replace(/^'+|'+$/g, "");
    if (bare.length < 2) continue;
    if (/^[A-Z]{2,6}$/.test(bare)) continue;
    if (bare !== bare.toLowerCase() && bare !== bare[0].toUpperCase() + bare.slice(1).toLowerCase()) continue;
    const key = bare.toLowerCase();
    const hyphen = text[start - 1] === "-" || text[end] === "-";
    if (hyphen && (knownWord(key, dictionary, allowed) || key.length <= 4)) continue;
    if (knownWord(key, dictionary, allowed)) continue;
    hits.push({ start, end, word: bare });
  }
  return hits;
}

export function suggestions(word: string, dictionary: Set<string>, limit = 5): string[] {
  const key = word.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    if (seen.has(value) || out.length >= limit) return;
    if (!dictionary.has(value)) return;
    seen.add(value);
    const capped = word[0] === word[0].toUpperCase() ? value[0].toUpperCase() + value.slice(1) : value;
    out.push(capped);
  };
  const letters = "abcdefghijklmnopqrstuvwxyz'";
  for (let i = 0; i < key.length; i++) push(key.slice(0, i) + key.slice(i + 1));
  for (let i = 0; i < key.length - 1; i++) push(key.slice(0, i) + key[i + 1] + key[i] + key.slice(i + 2));
  for (let i = 0; i < key.length; i++) {
    for (const ch of letters) push(key.slice(0, i) + ch + key.slice(i + 1));
  }
  for (let i = 0; i <= key.length; i++) {
    for (const ch of letters) {
      if (out.length >= limit) return out;
      push(key.slice(0, i) + ch + key.slice(i));
    }
  }
  return out;
}

export interface AutoHit {
  start: number;
  end: number;
  value: string;
}

export function autocorrectSpan(text: string, head: number, subs: Record<string, string>): AutoHit | null {
  if (head <= 0 || head > text.length) return null;
  const keys = Object.keys(subs).sort((a, b) => b.length - a.length);
  const window = text.slice(Math.max(0, head - 16), head);
  for (const key of keys) {
    if (!/[.(]/.test(key[0])) continue;
    if (!window.endsWith(key)) continue;
    const start = head - key.length;
    if (subs[key] === key) continue;
    return { start, end: head, value: subs[key] };
  }
  const boundary = text[head - 1];
  if (!/[\s.,;:!?]/.test(boundary)) return null;
  let start = head - 1;
  while (start > 0 && /[A-Za-z']/.test(text[start - 1])) start--;
  const word = text.slice(start, head - 1);
  if (word.length < 2) return null;
  const repl = subs[word] || subs[word.toLowerCase()];
  if (!repl || repl.toLowerCase() === word.toLowerCase()) return null;
  const value = word[0] === word[0].toUpperCase() ? repl[0].toUpperCase() + repl.slice(1) : repl;
  return { start, end: head - 1, value };
}
