export interface PageSpec {
  w: number;
  h: number;
  ml: number;
  mr: number;
  mt: number;
  mb: number;
  paper: "letter" | "a4" | "legal";
  orient: "portrait" | "landscape";
  pageless: boolean;
  differentFirst: boolean;
  header: string;
  footer: string;
  headerFirst: string;
  footerFirst: string;
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
  pageless: false,
  differentFirst: false,
  header: "",
  footer: "",
  headerFirst: "",
  footerFirst: "",
};

function margin(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(36, Math.min(288, Math.round(n)));
}

function line(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000\r\n]/g, " ").trim().slice(0, 200);
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
    pageless: raw.pageless === true,
    differentFirst: raw.differentFirst === true,
    header: line(raw.header),
    footer: line(raw.footer),
    headerFirst: line(raw.headerFirst),
    footerFirst: line(raw.footerFirst),
  };
}

export function pageEqual(a: PageSpec, b: PageSpec): boolean {
  return (
    a.w === b.w &&
    a.h === b.h &&
    a.ml === b.ml &&
    a.mr === b.mr &&
    a.mt === b.mt &&
    a.mb === b.mb &&
    a.paper === b.paper &&
    a.orient === b.orient &&
    a.pageless === b.pageless &&
    a.differentFirst === b.differentFirst &&
    a.header === b.header &&
    a.footer === b.footer &&
    a.headerFirst === b.headerFirst &&
    a.footerFirst === b.footerFirst
  );
}

export function fillPage(template: string, page: number, pages: number): string {
  return template.replaceAll("{page}", String(page)).replaceAll("{pages}", String(pages));
}
