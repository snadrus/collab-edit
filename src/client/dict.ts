import nspell from "nspell";
import { misspellings, type SpellHit } from "../shared/spell.ts";

// Hunspell en_US (SCOWL, via the dictionary-en package) checked with nspell. FiPen paints text on a
// canvas, and browsers do not expose their native spell-checker results to script, so a real
// Hunspell dictionary (with affix rules: plurals, tenses, -ly, contractions) is the closest match.
type Speller = { correct(word: string): boolean; suggest(word: string): string[] };
let speller: Speller | null = null;
const known = new Map<string, boolean>();
// Double-l forms that en-US Hunspell marks but US writers (and Docs) accept.
const ACCEPTED = new Set(["cancelled", "cancelling", "travelled", "travelling", "traveller", "travellers", "labelled", "labelling", "modelled", "modelling", "fuelled", "fuelling", "totalled", "signalled", "signalling"]);
const ideas = new Map<string, string[]>();

export function dictReady(): boolean {
  return !!speller;
}

export function loadHunspell(aff: string, dic: string): void {
  if (!aff || !dic) return;
  speller = nspell(aff, dic) as Speller;
  known.clear();
  ideas.clear();
}

function check(word: string): boolean {
  if (!speller) return true;
  let hit = known.get(word);
  if (hit === undefined) {
    hit = ACCEPTED.has(word.toLowerCase()) || speller.correct(word) || speller.correct(word.replace(/\u2019/g, "'"));
    if (known.size > 50_000) known.clear();
    known.set(word, hit);
  }
  return hit;
}

export function spellHits(text: string, allowed: Set<string>): SpellHit[] {
  if (!speller) return [];
  return misspellings(text, check, allowed);
}

export function spellSuggestions(word: string): string[] {
  if (!speller) return [];
  let out = ideas.get(word);
  if (!out) {
    // Typing slips (swapped neighbours, e.g. "teh") first, as Docs does, then Hunspell's own ranking.
    const swaps: string[] = [];
    for (let i = 0; i < word.length - 1; i++) {
      const swap = word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
      if (swap !== word && speller.correct(swap) && !swaps.includes(swap)) swaps.push(swap);
    }
    out = [...swaps, ...speller.suggest(word).filter((idea) => !swaps.includes(idea))].slice(0, 5);
    ideas.set(word, out);
  }
  return out;
}

export function wordKnown(word: string): boolean {
  const key = word.trim().replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "");
  return !!key && !!speller && check(key);
}
