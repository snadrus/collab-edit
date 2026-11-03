import { expect, test, type Page } from "playwright/test";
import path from "node:path";

const corpus = path.join(process.cwd(), "apps/felanumio/fixtures/corpus");

type SheetWin = {
  __sheet: {
    ready: boolean;
    raw: (r: number, c: number) => string;
    display: (r: number, c: number) => string;
    sheetNames: () => string[];
    selectSheet: (name: string) => void;
    selectRange: (r1: number, c1: number, r2: number, c2: number) => void;
    style: (r: number, c: number) => { b?: boolean; fill?: string; color?: string; border?: boolean; format?: string } | null;
    note: (r: number, c: number) => string;
    link: (r: number, c: number) => string;
    freeze: () => { r: number; c: number };
    colWidth: (c: number) => number;
    merges: () => { r1: number; c1: number; r2: number; c2: number }[];
    validations: () => { list: string[] }[];
    rules: () => { kind: string; op?: string }[];
    charts: () => { kind?: string; title?: string; note?: string }[];
    scrollToRow: (r: number) => void;
    painted: () => string[];
    frameMs: () => number;
    threads: () => string[];
  };
};

async function blank(page: Page): Promise<void> {
  const created = await page.request.post("/api/books", { data: { title: "Import" } });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };
  await page.goto("/sheets/b/" + id);
  await page.waitForFunction(() => (window as unknown as SheetWin).__sheet?.ready === true);
}

async function importFile(page: Page, file: string): Promise<void> {
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.locator("#imp-convert")).toBeChecked();
  await expect(page.locator("#imp-zeros")).toBeChecked();
  await expect(page.locator("#imp-mode")).toHaveValue("replace");
  await page.locator("#imp-file").setInputFiles(path.join(corpus, file));
}

test("imports each corpus workbook", async ({ page }) => {
  await blank(page);

  await importFile(page, "small.csv");
  await expect.poll(() => page.evaluate(() => (window as unknown as SheetWin).__sheet.display(6, 3))).toBe("30.9");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.sheetNames())).toEqual(["small"]);
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(0, 0))).toBe("Item");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.display(1, 3))).toBe("1.5");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.display(6, 1))).toBe("124");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(1, 3))).toBe("=B2*C2");

  await importFile(page, "data.tsv");
  await expect.poll(() => page.evaluate(() => (window as unknown as SheetWin).__sheet.display(1, 5))).toBe("2398");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(0, 0))).toBe("Region");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(0, 1))).toBe("Q1");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(5, 0))).toBe("Note, with comma");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(5, 1))).toBe('"quoted"');

  await importFile(page, "quirks_semicolon.csv");
  await expect.poll(() => page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(1, 0))).toBe("Käse");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(2, 0))).toBe("Brot; groß");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.display(1, 2))).toBe("4.5");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.display(3, 2))).toBe("1234.56");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.display(1, 3))).toBe("01.11.2026");

  await importFile(page, "quirks_utf8.csv");
  await expect.poll(() => page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(1, 2))).toBe("02134");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(1, 0))).toBe("001");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(5, 2))).toBe("00000");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(1, 1))).toContain("😀");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(3, 1))).toBe("multi\nline cell");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.display(1, 3))).toBe("2026-11-01");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.display(5, 7))).toBe("=1+1 formula-looking");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.display(5, 4))).toBe("7/4/26 1:45 PM");

  await importFile(page, "basic.ods");
  await expect.poll(() => page.evaluate(() => (window as unknown as SheetWin).__sheet.sheetNames().join(","))).toBe("Sheet1,Second");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.display(1, 2))).toBe("180");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.display(3, 1))).toBe("165");
  await page.evaluate(() => (window as unknown as SheetWin).__sheet.selectSheet("Second"));
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.display(1, 0))).toBe("165");

  await importFile(page, "features.xlsx");
  await expect.poll(() => page.evaluate(() => (window as unknown as SheetWin).__sheet.sheetNames().join(","))).toBe("Sales,Products,Summary");
  const sales = await page.evaluate(() => {
    const api = (window as unknown as SheetWin).__sheet;
    return {
      freeze: api.freeze(),
      header: api.style(0, 0),
      note: api.note(0, 0),
      date: api.display(1, 0),
      region: api.display(1, 1),
      price: api.display(1, 4),
      revenue: api.display(1, 5),
      flag: api.display(1, 7),
      label: api.display(1, 8),
      count: api.display(23, 1),
      index: api.display(24, 1),
      merge: api.merges().some((m) => m.c1 === 10 && m.c2 === 12 && m.r1 === 0),
      merged: api.raw(0, 10),
      link: api.link(2, 10),
      inner: api.link(3, 10),
      west: api.validations().some((rule) => rule.list.includes("West")),
      cellRule: api.rules().some((rule) => rule.kind === "cell" && rule.op === "gt"),
      scale: api.rules().some((rule) => rule.kind === "scale"),
      wider: api.colWidth(0) > api.colWidth(3),
      threads: api.threads(),
    };
  });
  expect(sales.freeze.r).toBe(1);
  expect(sales.header?.b).toBe(true);
  expect(sales.header?.fill?.toLowerCase()).toBe("#4472c4");
  expect(sales.header?.color?.toLowerCase()).toBe("#ffffff");
  expect(sales.header?.border).toBe(true);
  expect(sales.note).toBe("Order date (weekly)");
  expect(sales.threads).toContain("Order date (weekly)");
  expect(sales.date).toBe("01/15/2026");
  expect(sales.region).toBe("South");
  expect(sales.price).toBe("$9.99");
  expect(sales.revenue).toBe("$279.72");
  expect(sales.flag).toBe("No");
  expect(sales.label).toBe("2026-01-15 P1");
  expect(sales.count).toBe("6");
  expect(sales.index).toBe("24.5");
  expect(sales.merge).toBe(true);
  expect(sales.merged).toBe("Merged header");
  expect(sales.link).toBe("https://www.google.com");
  expect(sales.inner).toBe("#Products!A1");
  expect(sales.west).toBe(true);
  expect(sales.cellRule).toBe(true);
  expect(sales.scale).toBe(true);
  expect(sales.wider).toBe(true);
  const drawn = await page.evaluate(() => {
    const painted = (window as unknown as SheetWin).__sheet.painted();
    const canvas = document.querySelector("#grid") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    let orange = false;
    if (ctx) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < img.length; i += 16) {
        if (img[i] > 240 && img[i + 1] > 170 && img[i + 1] < 220 && img[i + 2] < 40) orange = true;
      }
    }
    const notes = [...document.querySelectorAll("#thread-list .note")].map((el) => el.textContent || "");
    return { painted, orange, notes };
  });
  expect(drawn.painted).toContain("Merged header");
  expect(drawn.orange).toBe(true);
  expect(drawn.notes.filter((text) => text.includes("Order date (weekly)"))).toHaveLength(1);
  await page.evaluate(() => (window as unknown as SheetWin).__sheet.selectSheet("Products"));
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.display(1, 1))).toBe("$9.99");
  await page.evaluate(() => (window as unknown as SheetWin).__sheet.selectSheet("Summary"));
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.display(1, 0))).toBe("North");
  expect((await page.evaluate(() => (window as unknown as SheetWin).__sheet.display(1, 1))).replace(/[$,]/g, "")).toBe("2244.85");
  expect((await page.evaluate(() => (window as unknown as SheetWin).__sheet.display(2, 1))).replace(/[$,]/g, "")).toBe("1235.22");
  const chart = await page.evaluate(() => (window as unknown as SheetWin).__sheet.charts()[0]);
  expect(chart?.kind).toBe("bar");
  expect(chart?.title).toBe("Revenue by region");
  await expect(page.locator("#chartbox h3")).toHaveText("Revenue by region");
  await expect(page.locator("#chartbox")).toBeVisible();
  await expect(page.locator("#chart")).toHaveAttribute("data-labels", "North|South|East|West");
});

test("native paste lands on A1, and copy writes TSV and HTML", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await blank(page);
  await page.locator("#formula").focus();
  await page.evaluate(async () => {
    const html = "<table><tr><td>Alpha</td><td>Be&amp;ta</td></tr><tr><td>Gamma</td><td>Delta</td></tr></table>";
    const plain = "Alpha\tBeta\nGamma\tDelta";
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
  });
  await page.keyboard.press("Control+V");
  await expect.poll(() => page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(0, 0))).toBe("Alpha");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(0, 1))).toBe("Be&ta");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(1, 0))).toBe("Gamma");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(1, 1))).toBe("Delta");

  await page.evaluate(() => {
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    const plain = '"hello\nworld"\tnext';
    Object.defineProperty(ev, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? plain : "") },
    });
    document.dispatchEvent(ev);
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(0, 0))).toBe("hello\nworld");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(0, 1))).toBe("next");

  await page.evaluate(async () => {
    await navigator.clipboard.writeText("Menu\tPaste\nSecond\tRow");
  });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(0, 0))).toBe("Menu");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(0, 1))).toBe("Paste");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(1, 0))).toBe("Second");

  await page.evaluate(() => (window as unknown as SheetWin).__sheet.selectRange(0, 0, 1, 1));
  const copied = await page.evaluate(() => {
    const ev = new Event("copy", { bubbles: true, cancelable: true });
    const store: Record<string, string> = {};
    Object.defineProperty(ev, "clipboardData", {
      value: {
        setData: (type: string, data: string) => {
          store[type] = data;
        },
        getData: (type: string) => store[type] || "",
      },
    });
    document.dispatchEvent(ev);
    return store;
  });
  expect(copied["text/plain"]).toBe("Menu\tPaste\nSecond\tRow");
  expect(copied["text/html"]).toContain(">Menu</td>");
  expect(copied["text/html"]).toContain(">Row</td>");
});

test("drag-drop imports onto the grid and download writes CSV", async ({ page }) => {
  await blank(page);
  await page.evaluate((csv) => {
    const dt = new DataTransfer();
    dt.items.add(new File([csv], "dropped.csv", { type: "text/csv" }));
    for (const type of ["dragenter", "dragover", "drop"]) {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, "dataTransfer", { value: dt });
      document.querySelector("#stage")!.dispatchEvent(ev);
    }
  }, "Item,Qty\nDropped,7\n");
  await expect.poll(() => page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(0, 0))).toBe("Item");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(1, 0))).toBe("Dropped");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(1, 1))).toBe("7");

  await importFile(page, "small.csv");
  await expect.poll(() => page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(1, 0))).toBe("Apple");
  const csvDone = page.waitForEvent("download");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("button", { name: "Download as CSV" }).click();
  const csv = await csvDone;
  const csvText = (await import("node:fs")).readFileSync(await csv.path(), "utf8");
  expect(csvText).toContain("Apple");
  expect(csvText).toContain("=B2*C2");

  const xlsxDone = page.waitForEvent("download");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("button", { name: "Download as XLSX" }).click();
  const xlsx = await xlsxDone;
  expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/);
  const xlsxBytes = (await import("node:fs")).readFileSync(await xlsx.path());
  expect(xlsxBytes.subarray(0, 2).toString()).toBe("PK");

  const odsDone = page.waitForEvent("download");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("button", { name: "Download as ODS" }).click();
  const ods = await odsDone;
  expect(ods.suggestedFilename()).toMatch(/\.ods$/);
  const odsBytes = (await import("node:fs")).readFileSync(await ods.path());
  expect(odsBytes.subarray(0, 2).toString()).toBe("PK");
});

test("a 10k-row import stays under 3s and distant rows paint", async ({ page }) => {
  test.setTimeout(90_000);
  await blank(page);
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const started = Date.now();
  await page.locator("#imp-file").setInputFiles(path.join(corpus, "large_10k_x20.csv"));
  await expect.poll(() => page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(10000, 1)), { timeout: 20_000 }).toBe("name9999");
  const ms = Date.now() - started;
  expect(ms, "import " + ms + "ms").toBeLessThan(3000);
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(0, 0))).toBe("col1");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(4999, 0))).toBe("4999");
  expect(await page.evaluate(() => (window as unknown as SheetWin).__sheet.raw(4999, 1))).toBe("name4998");

  const mid = await page.evaluate(() => {
    const api = (window as unknown as SheetWin).__sheet;
    api.scrollToRow(4999);
    api.scrollToRow(4999);
    const settled = api.frameMs();
    const painted = api.painted();
    api.scrollToRow(5003);
    return { painted, settled, step: api.frameMs(), stepped: api.painted() };
  });
  expect(mid.painted).toContain("name4998");
  expect(mid.painted).toContain("4999");
  expect(mid.settled, "settled " + mid.settled).toBeLessThan(16);
  expect(mid.stepped).toContain("name5002");
  expect(mid.step, "step " + mid.step).toBeLessThan(16);

  const end = await page.evaluate(() => {
    const api = (window as unknown as SheetWin).__sheet;
    api.scrollToRow(10000);
    api.scrollToRow(10000);
    return { painted: api.painted(), frame: api.frameMs() };
  });
  expect(end.painted).toContain("name9999");
  expect(end.painted).toContain("10000");
  expect(end.frame, "end " + end.frame).toBeLessThan(16);
});
