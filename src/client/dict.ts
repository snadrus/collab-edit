import { misspellings, suggestions, type SpellHit } from "../shared/spell.ts";

let dictionary = new Set<string>();
let ready = false;

export function dictReady(): boolean {
  return ready;
}

export function loadWordText(text: string): void {
  dictionary = new Set(text.split("\n").map((line) => line.trim().toLowerCase()).filter((word) => word.length > 1));
  ready = dictionary.size > 100;
}

export function spellHits(text: string, allowed: Set<string>): SpellHit[] {
  if (!ready) return [];
  return misspellings(text, dictionary, allowed);
}

export function spellSuggestions(word: string): string[] {
  if (!ready) return [];
  return suggestions(word, dictionary);
}

export function wordKnown(word: string): boolean {
  const key = word.trim().toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
  return !!key && dictionary.has(key);
}
