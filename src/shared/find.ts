export interface FindHit {
  start: number;
  end: number;
}

export function regexOk(query: string): boolean {
  if (!query || query.length > 200) return false;
  try {
    new RegExp(query, "u");
    return true;
  } catch {
    return false;
  }
}

/** Literal search is case-insensitive. Regex uses the pattern as written. */
export function findRanges(text: string, query: string, regex: boolean): FindHit[] {
  if (!query) return [];
  const out: FindHit[] = [];
  if (!regex) {
    const hay = text.toLowerCase();
    const needle = query.toLowerCase();
    let from = 0;
    while (from < hay.length && out.length < 500) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      out.push({ start: at, end: at + needle.length });
      from = at + Math.max(1, needle.length);
    }
    return out;
  }
  if (!regexOk(query)) return [];
  const re = new RegExp(query, "gu");
  let guard = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) && guard++ < 500) {
    const start = match.index;
    const len = match[0].length;
    if (len > 0) out.push({ start, end: start + len });
    if (len === 0) re.lastIndex = start + 1;
  }
  return out;
}

export function applyReplacement(slice: string, query: string, repl: string, regex: boolean): string {
  if (!regex) return repl;
  if (!regexOk(query)) return repl;
  try {
    return slice.replace(new RegExp(query, "u"), repl);
  } catch {
    return repl;
  }
}
