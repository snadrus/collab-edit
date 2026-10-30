export interface PageSpec {
  w: number;
  h: number;
  ml: number;
  mr: number;
  mt: number;
  mb: number;
  paper: "letter" | "a4" | "legal";
  orient: "portrait" | "landscape";
}

const PAPERS: Record<PageSpec["paper"], [number, number]> = {
  letter: [816, 1056],
  a4: [794, 1123],
  legal: [816, 1344],
};

export const DEFAULT_PAGE: PageSpec = {
  w: 816,
  h: 1056,
  ml: 96,
  mr: 96,
  mt: 96,
  mb: 96,
  paper: "letter",
  orient: "portrait",
};

function margin(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(36, Math.min(288, Math.round(n)));
}

export function normalizePage(input: unknown): PageSpec {
  const raw = input && typeof input === "object" ? (input as Partial<PageSpec>) : {};
  const paper: PageSpec["paper"] = raw.paper === "a4" || raw.paper === "legal" ? raw.paper : "letter";
  const orient: PageSpec["orient"] = raw.orient === "landscape" ? "landscape" : "portrait";
  let [w, h] = PAPERS[paper];
  if (orient === "landscape") [w, h] = [h, w];
  return {
    w,
    h,
    paper,
    orient,
    ml: margin(raw.ml, DEFAULT_PAGE.ml),
    mr: margin(raw.mr, DEFAULT_PAGE.mr),
    mt: margin(raw.mt, DEFAULT_PAGE.mt),
    mb: margin(raw.mb, DEFAULT_PAGE.mb),
  };
}

export function pageEqual(a: PageSpec, b: PageSpec): boolean {
  return a.w === b.w && a.h === b.h && a.ml === b.ml && a.mr === b.mr && a.mt === b.mt && a.mb === b.mb && a.paper === b.paper && a.orient === b.orient;
}
