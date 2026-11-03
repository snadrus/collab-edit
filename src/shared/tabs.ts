/**
 * Document tabs, like Google Docs tabs. A tab starts at a lone "\f" paragraph whose break carries
 * `tab` (id), `tn` (name) and `tl` (0 = top level, 1-2 = child tab). Everything up to the next
 * marker is that tab's body. The text before the first marker is the first tab ("Tab 1"), so an
 * old document is simply one tab. Tabs live in the one OT/CRDT body, so p2p sync, undo and saving
 * need nothing new.
 */
import { type Attrs, type Delta, type Op, PARA_KEYS, chop, compose } from "./delta.ts";
import { type Doc, applyDoc } from "./doc.ts";
import { headingsOf } from "./toc.ts";

export const FIRST_TAB_ID = "t.0";
export const MAX_TAB_LEVEL = 2;

export interface Tab {
  id: string;
  name: string;
  level: number;
  /** Index of the marker paragraph ("\f"), or -1 for an unmarked first tab. */
  marker: number;
  /** First body index. */
  from: number;
  /** Exclusive end of the body: the next marker, or the doc length. */
  end: number;
}

export interface TocEntry {
  index: number;
  level: number;
  text: string;
}

export function newTabId(): string {
  return "t." + Math.random().toString(36).slice(2, 10);
}

export function isTabMarker(doc: Doc, index: number): boolean {
  return doc.text[index] === "\f" && typeof doc.styles[index]?.tab === "string";
}

const cache = new WeakMap<Doc, Tab[]>();

export function tabsOf(doc: Doc): Tab[] {
  const hit = cache.get(doc);
  if (hit) return hit;
  const tabs: Tab[] = [];
  const n = doc.text.length;
  let open: Tab | null = null;
  for (let i = 0; i < n; i++) {
    if (doc.text[i] !== "\f") continue;
    const st = doc.styles[i];
    if (typeof st?.tab !== "string") continue;
    if (i === 0) {
      open = { id: st.tab, name: tabName(st.tn, 1), level: 0, marker: 0, from: 1, end: n };
      continue;
    }
    if (!open) open = { id: FIRST_TAB_ID, name: "Tab 1", level: 0, marker: -1, from: 0, end: i };
    open.end = i;
    tabs.push(open);
    const level = Math.max(0, Math.min(MAX_TAB_LEVEL, Number(st.tl) || 0));
    open = { id: st.tab, name: tabName(st.tn, tabs.length + 1), level, marker: i, from: i + 1, end: n };
  }
  if (!open) open = { id: FIRST_TAB_ID, name: "Tab 1", level: 0, marker: -1, from: 0, end: n };
  open.end = n;
  tabs.push(open);
  // A child cannot be deeper than one below the tab before it.
  for (let k = 0; k < tabs.length; k++) tabs[k].level = k === 0 ? 0 : Math.min(tabs[k].level, tabs[k - 1].level + 1);
  // Duplicate ids (a pasted marker): keep the first, re-key the rest so selection stays stable.
  const seen = new Set<string>();
  for (const tab of tabs) {
    if (seen.has(tab.id)) tab.id = tab.id + "@" + tab.marker;
    seen.add(tab.id);
  }
  cache.set(doc, tabs);
  return tabs;
}

function tabName(raw: unknown, ordinal: number): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  return name || "Tab " + ordinal;
}

/** Caret range inside a tab: [from, last]. `last` is the tab's final paragraph break. */
export function tabRange(tab: Tab): { from: number; last: number } {
  return { from: tab.from, last: Math.max(tab.from, tab.end - 1) };
}

export function tabAt(doc: Doc, index: number): Tab {
  const tabs = tabsOf(doc);
  for (const tab of tabs) if (index < tab.end) return tab;
  return tabs[tabs.length - 1];
}

/** Index just past this tab and its child tabs. */
export function subtreeEnd(tabs: Tab[], k: number): number {
  let j = k + 1;
  while (j < tabs.length && tabs[j].level > tabs[k].level) j++;
  return j;
}

/** H1-H3 under a tab, nested by level (1-3). Titles count as level 1, as in the Docs outline. */
export function tocOf(doc: Doc, tab: Tab): TocEntry[] {
  return headingsOf(doc)
    .filter((h) => h.index >= tab.from && h.index < tab.end && h.level <= 3)
    .map((h) => ({ index: h.index, level: Math.max(1, h.level), text: h.text }));
}

function markerAttrs(id: string, name: string, level: number): Attrs {
  const a: Attrs = { tab: id, tn: name, h: "normal", align: "left" };
  if (level > 0) a.tl = level;
  return a;
}

function seq(doc: Doc, ...steps: ((d: Doc) => Delta | null)[]): Delta | null {
  let out: Delta | null = null;
  let cur = doc;
  for (const step of steps) {
    const d = step(cur);
    if (!d) continue;
    out = out ? compose(out, d) : d;
    cur = applyDoc(cur, d);
  }
  return out;
}

/** Give the unmarked first tab its own marker, so it can be renamed or moved. */
function markFirst(doc: Doc): Delta | null {
  const first = tabsOf(doc)[0];
  if (first.marker >= 0) return null;
  return chop([{ t: "i", s: "\f", a: markerAttrs(newTabId(), first.name, 0) }, { t: "r", n: doc.text.length }]);
}

/** Add a tab after `afterId`'s subtree (or at the end), as its child when `child`. */
export function addTabDelta(doc: Doc, opts: { id: string; name?: string; afterId?: string; child?: boolean }): Delta {
  const tabs = tabsOf(doc);
  const n = doc.text.length;
  const k = opts.afterId ? Math.max(0, tabs.findIndex((t) => t.id === opts.afterId)) : tabs.length - 1;
  const parent = tabs[k];
  const level = opts.child ? Math.min(MAX_TAB_LEVEL, parent.level + 1) : opts.afterId ? parent.level : 0;
  const j = opts.child ? subtreeEnd(tabs, k) : opts.afterId ? subtreeEnd(tabs, k) : tabs.length;
  const name = opts.name || "Tab " + (tabs.length + 1);
  const marker = markerAttrs(opts.id, name, level);
  if (j < tabs.length) {
    // Before the next tab's marker: the new marker, then one empty paragraph.
    const at = tabs[j].marker;
    return chop([{ t: "r", n: at }, { t: "i", s: "\f", a: marker }, { t: "i", s: "\n", a: { h: "normal", align: "left" } }, { t: "r", n: n - at }]);
  }
  // At the end: the sentinel newline stays last and becomes the new tab's body.
  const sentinel = { ...(doc.styles[n - 1] || {}) } as Attrs;
  const reset: Attrs = {};
  for (const key of PARA_KEYS) if (sentinel[key] != null) reset[key] = null;
  reset.h = "normal";
  reset.align = "left";
  return chop([
    { t: "r", n: n - 1 },
    { t: "i", s: "\n", a: sentinel },
    { t: "i", s: "\f", a: marker },
    { t: "r", n: 1, a: reset },
  ]);
}

export function renameTabDelta(doc: Doc, id: string, name: string): Delta | null {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, 100);
  if (!clean) return null;
  return seq(
    doc,
    (d) => (id === tabsOf(d)[0].id ? markFirst(d) : null),
    (d) => {
      const tabs = tabsOf(d);
      const tab = id === FIRST_TAB_ID ? tabs[0] : tabs.find((t) => t.id === id);
      if (!tab || tab.marker < 0 || tab.name === clean) return null;
      return chop([{ t: "r", n: tab.marker }, { t: "r", n: 1, a: { tn: clean } }, { t: "r", n: d.text.length - tab.marker - 1 }]);
    },
  );
}

/** Delete a tab and its child tabs. Refuses to delete the last remaining tab. */
export function deleteTabDelta(doc: Doc, id: string): Delta | null {
  const tabs = tabsOf(doc);
  const k = tabs.findIndex((t) => t.id === id);
  if (k < 0) return null;
  const j = subtreeEnd(tabs, k);
  if (k === 0 && j >= tabs.length) return null;
  const n = doc.text.length;
  if (k === 0) {
    // The next tab's marker moves to index 0 and becomes the first tab.
    const cut = tabs[j].marker;
    return chop([{ t: "d", n: cut }, { t: "r", n: n - cut }]);
  }
  const start = tabs[k].marker;
  if (j < tabs.length) {
    const stop = tabs[j].marker;
    return chop([{ t: "r", n: start }, { t: "d", n: stop - start }, { t: "r", n: n - stop }]);
  }
  // Last tabs: also drop the break before the marker, and the sentinel takes its paragraph style.
  const keep = (doc.styles[start - 1] || {}) as Attrs;
  const sentinel = (doc.styles[n - 1] || {}) as Attrs;
  const patch: Attrs = {};
  for (const key of PARA_KEYS) {
    const want = keep[key] ?? null;
    if ((sentinel[key] ?? null) !== want) patch[key] = want;
  }
  return chop([{ t: "r", n: start - 1 }, { t: "d", n: n - 1 - (start - 1) }, { t: "r", n: 1, a: Object.keys(patch).length ? patch : undefined }]);
}

/**
 * Move a tab (with its children) one place up or down among its siblings, or to sit before
 * `beforeId` (null = the end) for drag-and-drop. Moving only reorders text; ids stay.
 */
export function moveTabDelta(doc: Doc, id: string, to: -1 | 1 | { beforeId: string | null }): Delta | null {
  return seq(doc, markFirst, (d) => {
    const tabs = tabsOf(d);
    const k = tabs.findIndex((t) => t.id === id || (id === FIRST_TAB_ID && t === tabs[0]));
    if (k < 0) return null;
    const j = subtreeEnd(tabs, k);
    let target: number; // tab index the block is inserted before (tabs.length = end)
    if (to === -1) {
      let p = k - 1;
      while (p >= 0 && tabs[p].level > tabs[k].level) p--;
      if (p < 0 || tabs[p].level < tabs[k].level) return null;
      target = p;
    } else if (to === 1) {
      if (j >= tabs.length || tabs[j].level < tabs[k].level) return null;
      target = subtreeEnd(tabs, j);
    } else {
      target = to.beforeId == null ? tabs.length : tabs.findIndex((t) => t.id === to.beforeId);
      if (target < 0 || (target >= k && target <= j)) return null;
    }
    return moveBlock(d, tabs, k, j, target);
  });
}

function moveBlock(doc: Doc, tabs: Tab[], k: number, j: number, target: number): Delta | null {
  const n = doc.text.length;
  // Blocks are [marker, next marker); the last block includes the sentinel break, so every block ends with a break.
  const bound = (t: number) => (t < tabs.length ? tabs[t].marker : n);
  const pieces: [number, number][] = [];
  const moved: [number, number] = [bound(k), bound(j)];
  for (let t = 0; t < tabs.length; t = t === k ? j : t + 1) {
    if (t === target) pieces.push(moved);
    if (t === k) continue;
    pieces.push([t === 0 ? 0 : bound(t), bound(t + 1)]);
  }
  if (target >= tabs.length) pieces.push(moved);
  let text = "";
  const styles: Attrs[] = [];
  for (const [a, b] of pieces) {
    text += doc.text.slice(a, b);
    for (let i = a; i < b; i++) styles.push((doc.styles[i] || {}) as Attrs);
  }
  if (text === doc.text && styles.every((st, i) => st === doc.styles[i])) return null;
  let pre = 0;
  while (pre < n - 1 && text[pre] === doc.text[pre] && styles[pre] === doc.styles[pre]) pre++;
  let suf = 0;
  while (suf < n - 1 - pre && text[n - 2 - suf] === doc.text[n - 2 - suf] && styles[n - 2 - suf] === doc.styles[n - 2 - suf]) suf++;
  const ops: Op[] = [{ t: "r", n: pre }, { t: "d", n: n - 1 - pre - suf }];
  for (let i = pre; i < n - 1 - suf; i++) ops.push(Object.keys(styles[i]).length ? { t: "i", s: text[i], a: { ...styles[i] } } : { t: "i", s: text[i] });
  ops.push({ t: "r", n: suf });
  const want = styles[n - 1];
  const have = (doc.styles[n - 1] || {}) as Attrs;
  const patch: Attrs = {};
  for (const key of PARA_KEYS) {
    const w = want[key] ?? null;
    if ((have[key] ?? null) !== w) patch[key] = w;
  }
  ops.push({ t: "r", n: 1, a: Object.keys(patch).length ? patch : undefined });
  return chop(ops);
}

/** Plain body text of one tab (for tests and export). */
export function tabText(doc: Doc, tab: Tab): string {
  return doc.text.slice(tab.from, tab.end).replace(/\n$/, "");
}
