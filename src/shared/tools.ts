/** Local glossary. A network dictionary may replace these; tests use this list. */
const GLOSSARY: Record<string, string> = {
  document: "A piece of writing stored as its own file.",
  sentence: "A group of words that expresses a complete thought.",
  paragraph: "A block of sentences that develops one point.",
  citation: "A note that names the source of a fact or quotation.",
  watermark: "Faint text drawn behind the page, such as Draft or Confidential.",
  dictionary: "An alphabetical list of words and what they mean.",
  spelling: "The letters that form a word in the accepted order.",
  chart: "A drawing that compares numbers, such as a bar chart.",
  the: "The definite article, used before a specific noun.",
  and: "A conjunction that joins words or clauses.",
};

export function lookupWord(word: string): { word: string; definition: string } | null {
  const key = word.trim().toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
  if (!key || key.length > 40) return null;
  const definition = GLOSSARY[key];
  if (!definition) return null;
  return { word: key, definition };
}

export interface DiffPart {
  kind: "same" | "add" | "del";
  text: string;
}

/** Word-level diff. Whitespace is kept. Long inputs fall back to a single replacement. */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  if (a.length * b.length > 250000) {
    const parts: DiffPart[] = [];
    if (before) parts.push({ kind: "del", text: before });
    if (after) parts.push({ kind: "add", text: after });
    return parts;
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push("del", a[i]);
      i++;
    } else {
      push("add", b[j]);
      j++;
    }
  }
  while (i < n) push("del", a[i++]);
  while (j < m) push("add", b[j++]);
  return parts;
}

export interface ChartBar {
  name: string;
  value: number;
}

/** `North 10; South 40` or `North,10`. At most twelve bars. */
export function parseChart(label: string): ChartBar[] {
  const out: ChartBar[] = [];
  for (const row of label.split(/[;\n]/)) {
    const trimmed = row.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(.*?)(?:\s+|,\s*)(-?\d+(?:\.\d+)?)$/);
    if (!match) continue;
    const name = match[1].replace(/,/g, " ").trim().slice(0, 24);
    const value = Number(match[2]);
    if (!name || !Number.isFinite(value)) continue;
    out.push({ name, value });
    if (out.length >= 12) break;
  }
  return out;
}

export interface Citation {
  author: string;
  year: string;
  title: string;
}

export function citeLabel(author: string, year: string, title: string): string {
  const clean = (value: string, max: number) => value.replace(/[|\n\r]/g, " ").trim().slice(0, max);
  return `${clean(author, 80)}|${clean(year, 16)}|${clean(title, 160)}`;
}

export function parseCite(label: string): Citation {
  const [author = "", year = "", title = ""] = label.split("|");
  return { author: author.trim() || "Unknown", year: year.trim() || "n.d.", title: title.trim() || "Untitled" };
}

export function citeChip(label: string): string {
  const cite = parseCite(label);
  const last = cite.author.split(/\s+/).filter(Boolean).pop() || cite.author;
  return `(${last}, ${cite.year})`;
}

export function bibliographyLines(labels: string[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const label of labels) {
    const cite = parseCite(label);
    const line = `${cite.author} (${cite.year}). ${cite.title}.`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

/** Strokes are lists of x,y points in 0..100. */
export function parseStrokes(src: string): number[][][] {
  const strokes: number[][][] = [];
  for (const stroke of src.split(";")) {
    const points: number[][] = [];
    for (const pair of stroke.trim().split(/\s+/)) {
      const [xs, ys] = pair.split(",");
      const x = Number(xs);
      const y = Number(ys);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      points.push([Math.max(0, Math.min(100, x)), Math.max(0, Math.min(100, y))]);
      if (points.length >= 48) break;
    }
    if (points.length >= 2) strokes.push(points);
    if (strokes.length >= 8) break;
  }
  return strokes;
}

export function encodeStrokes(strokes: number[][][]): string {
  return strokes
    .slice(0, 8)
    .map((stroke) =>
      stroke
        .slice(0, 48)
        .map((p) => `${Math.round(Math.max(0, Math.min(100, p[0])))},${Math.round(Math.max(0, Math.min(100, p[1])))}`)
        .join(" "),
    )
    .filter((stroke) => stroke.includes(" "))
    .join(";");
}
