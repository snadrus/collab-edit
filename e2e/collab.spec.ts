import { expect, test, type Page } from "playwright/test";

declare global {
  interface Window {
    __editor?: {
      ready: boolean;
      getText: () => string;
      setSelection: (anchor: number, head: number) => void;
      insertText: (text: string) => void;
      remoteCount: () => number;
      color: () => string;
      insertVote: (emoji: string) => void;
      toggleVote: (index: number) => void;
      voteNames: () => string[];
      addComment: (text: string) => boolean;
      reply: (id: string, text: string) => void;
      threads: () => { id: string; text: string; replies: string[]; name: string }[];
      insertTable: (rows: number, cols: number) => void;
      tableRows: () => number;
      nameVersion: (label: string) => Promise<number>;
      versions: () => { rev: number; label: string; name: string }[];
      previewVersion: (rev: number) => Promise<void>;
      restorePreview: () => void;
      undo: () => void;
      exportFelarumi: () => string;
      importFelarumi: (raw: string) => void;
      exportDocx: () => Promise<string>;
      importDocx: (b64: string) => Promise<void>;
      styleAt: (index: number) => { b?: boolean };
      toggleBold: () => void;
      dirty: () => boolean;
      headings: () => { text: string; level: number }[];
      misspelled: () => string[];
      showOutline: () => void;
      setHeading: (h: string) => void;
      page: () => { paper: string; ml: number; pageless?: boolean; footer?: string };
      setMode: (mode: "edit" | "suggest" | "view") => void;
      mode: () => string;
      suggestions: () => { id: string; kind: string; quote: string }[];
      acceptSuggestion: (id: string) => void;
      setPageless: (on: boolean) => void;
      insertFootnote: (text: string) => void;
      setColumns: (cols: 1 | 2 | 3) => void;
      insertSection: (kind: "cont" | "next") => void;
      applyCase: (mode: "lower" | "upper" | "title") => void;
      insertEquation: (src: string) => void;
      role: () => string;
    };
  }
}

async function openDoc(page: Page, id: string, name: string): Promise<void> {
  await page.addInitScript((n) => sessionStorage.setItem("felarumi-name", n), name);
  await page.goto("/d/" + id);
  await page.waitForFunction(() => window.__editor?.ready === true);
  await page.locator(".page").first().waitFor();
}

test("concurrent typing, paste, undo, and remote caret", async ({ browser, request }) => {
  const created = await request.post("/api/docs", { data: { title: "Notes" } });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };

  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  await openDoc(pa, id, "Avery");
  await openDoc(pb, id, "Blair");

  await pa.locator(".page").click();
  await pb.locator(".page").click();
  await Promise.all([pa.keyboard.type("Hello ", { delay: 20 }), pb.keyboard.type("World", { delay: 20 })]);

  const bag = (s: string) => [...s].sort().join("");
  await expect
    .poll(async () => {
      const left = await pa.evaluate(() => window.__editor!.getText());
      const right = await pb.evaluate(() => window.__editor!.getText());
      return left === right && bag(left) === bag("Hello World") ? left : "";
    })
    .not.toBe("");

  await expect(pa.locator(".remote-caret").first()).toBeVisible();

  await pa.evaluate(() => {
    const text = window.__editor!.getText();
    window.__editor!.setSelection(0, text.length);
    const dt = new DataTransfer();
    dt.setData("text/plain", "Pasted");
    dt.setData("text/html", "<p><b>Pasted</b></p>");
    document.querySelector("#input")!.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
  });
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText())).toBe("Pasted");
  await expect.poll(() => pa.evaluate(() => window.__editor!.getText())).toBe("Pasted");

  await pa.locator("#input").focus();
  await pa.keyboard.press("Control+z");
  await expect
    .poll(async () => {
      const left = await pa.evaluate(() => window.__editor!.getText());
      const right = await pb.evaluate(() => window.__editor!.getText());
      return left === right && left !== "Pasted" ? left : "";
    })
    .not.toBe("");

  await a.close();
  await b.close();
});

test("votes, comment thread, and table insert", async ({ browser, request }) => {
  const created = await request.post("/api/docs", { data: { title: "Review" } });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };

  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  await openDoc(pa, id, "Avery");
  await openDoc(pb, id, "Blair");

  const colors = await Promise.all([pa.evaluate(() => window.__editor!.color()), pb.evaluate(() => window.__editor!.color())]);
  expect(colors[0]).not.toBe(colors[1]);

  await pa.evaluate(() => window.__editor!.insertVote("👍"));
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText().includes("\uFFFC"))).toBe(true);
  await Promise.all([pa.evaluate(() => window.__editor!.toggleVote(0)), pb.evaluate(() => window.__editor!.toggleVote(0))]);
  await expect
    .poll(async () => {
      const left = await pa.evaluate(() => window.__editor!.voteNames().slice().sort().join(","));
      const right = await pb.evaluate(() => window.__editor!.voteNames().slice().sort().join(","));
      return left === right ? left : "";
    })
    .toBe("Avery,Blair");

  await pa.evaluate(() => window.__editor!.insertText("Please review this plan"));
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText().includes("review"))).toBe(true);
  await pa.evaluate(() => {
    const text = window.__editor!.getText();
    const at = text.indexOf("review");
    window.__editor!.setSelection(at, at + "review".length);
    window.__editor!.addComment("Please check the wording");
  });
  await expect.poll(() => pb.evaluate(() => window.__editor!.threads().length)).toBe(1);
  const threadId = await pb.evaluate(() => window.__editor!.threads()[0].id);
  await pb.evaluate((tid) => window.__editor!.reply(tid, "On it"), threadId);
  await expect.poll(() => pa.evaluate(() => window.__editor!.threads()[0]?.replies[0] || "")).toBe("On it");
  await expect.poll(() => pb.evaluate(() => window.__editor!.threads()[0]?.text || "")).toBe("Please check the wording");

  await pa.evaluate(() => window.__editor!.insertTable(2, 3));
  await expect.poll(() => pb.evaluate(() => window.__editor!.tableRows())).toBe(2);
  await expect.poll(() => pa.evaluate(() => window.__editor!.tableRows())).toBe(2);

  await a.close();
  await b.close();
});

async function saved(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__editor!.dirty())).toBe(false);
}

test("restoring an old version converges and can be undone", async ({ browser, request }) => {
  const created = await request.post("/api/docs", { data: { title: "History" } });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };

  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  await openDoc(pa, id, "Avery");
  await openDoc(pb, id, "Blair");

  await pa.evaluate(() => window.__editor!.insertText("First draft"));
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText())).toBe("First draft");
  await saved(pa);
  const rev = await pa.evaluate(() => window.__editor!.nameVersion("First"));
  await pa.evaluate(() => window.__editor!.insertText(" MORE"));
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText())).toBe("First draft MORE");
  await expect.poll(() => pa.evaluate(() => window.__editor!.getText())).toBe("First draft MORE");
  await saved(pa);

  await pa.evaluate((n) => window.__editor!.previewVersion(n), rev);
  await expect(pa.locator("#history")).toBeVisible();
  await expect(pa.locator("#history-banner")).toContainText("Previewing");
  await pa.evaluate(() => window.__editor!.restorePreview());
  await expect.poll(() => pa.evaluate(() => window.__editor!.getText())).toBe("First draft");
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText())).toBe("First draft");

  await pa.locator("#input").focus();
  await pa.keyboard.press("Control+z");
  await expect.poll(() => pa.evaluate(() => window.__editor!.getText())).toBe("First draft MORE");
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText())).toBe("First draft MORE");

  await a.close();
  await b.close();
});

test("felarumi and docx round-trip through a live document", async ({ browser, request }) => {
  const created = await request.post("/api/docs", { data: { title: "Round trip" } });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };

  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  await openDoc(pa, id, "Avery");
  await openDoc(pb, id, "Blair");

  await pa.evaluate(() => window.__editor!.insertText("Keep this"));
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText())).toBe("Keep this");
  await pa.evaluate(() => {
    const text = window.__editor!.getText();
    const at = text.indexOf("Keep");
    window.__editor!.setSelection(at, at + "Keep".length);
    window.__editor!.addComment("Please check the wording");
  });
  await expect.poll(() => pb.evaluate(() => window.__editor!.threads().length)).toBe(1);
  const file = await pa.evaluate(() => window.__editor!.exportFelarumi());
  await pa.evaluate(() => window.__editor!.insertText(" extra"));
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText())).toContain("extra");
  await pa.evaluate((raw) => window.__editor!.importFelarumi(raw), file);
  await expect.poll(() => pa.evaluate(() => window.__editor!.getText())).toBe("Keep this");
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText())).toBe("Keep this");
  await expect.poll(() => pb.evaluate(() => window.__editor!.threads().length)).toBe(1);
  await expect.poll(() => pa.evaluate(() => window.__editor!.threads()[0]?.text || "")).toBe("Please check the wording");

  await pa.evaluate(() => {
    window.__editor!.setSelection(0, window.__editor!.getText().length);
    window.__editor!.insertText("Hello");
    window.__editor!.setSelection(0, 5);
    window.__editor!.toggleBold();
  });
  await saved(pa);
  const docx = await pa.evaluate(() => window.__editor!.exportDocx());
  await pa.evaluate(() => window.__editor!.insertText(" extra"));
  await pa.evaluate((b64) => window.__editor!.importDocx(b64), docx);
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText())).toBe("Hello");
  await expect.poll(() => pa.evaluate(() => window.__editor!.styleAt(0).b)).toBe(true);
  await expect.poll(() => pb.evaluate(() => window.__editor!.styleAt(0).b)).toBe(true);

  await a.close();
  await b.close();
});

test("offline edits sync after reconnect", async ({ browser, request }) => {
  const created = await request.post("/api/docs", { data: { title: "Offline" } });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };

  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  await openDoc(pa, id, "Avery");
  await openDoc(pb, id, "Blair");

  await a.setOffline(true);
  await expect(pa.locator("#status")).toHaveText("Offline, changes will sync");
  await pa.evaluate(() => window.__editor!.insertText("Queued offline"));
  await expect.poll(() => pa.evaluate(() => window.__editor!.getText())).toBe("Queued offline");
  await a.setOffline(false);
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText())).toBe("Queued offline");
  await expect.poll(() => pa.evaluate(() => window.__editor!.getText())).toBe("Queued offline");
  await saved(pa);
  await expect(pa.locator("#status")).toHaveText("All changes saved");

  await pa.reload();
  await pa.waitForFunction(() => window.__editor?.ready === true);
  await expect.poll(() => pa.evaluate(() => window.__editor!.getText())).toBe("Queued offline");
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText())).toBe("Queued offline");

  await a.close();
  await b.close();
});

test("outline, spelling underline, and the editing menu", async ({ browser, request }) => {
  const created = await request.post("/api/docs", { data: { title: "Parity" } });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };
  const a = await browser.newContext();
  const pa = await a.newPage();
  await openDoc(pa, id, "Avery");
  await pa.evaluate(() => {
    window.__editor!.insertText("Chapter one");
    window.__editor!.setSelection(0, "Chapter one".length);
    window.__editor!.setHeading("h1");
    window.__editor!.setSelection(window.__editor!.getText().length, window.__editor!.getText().length);
    window.__editor!.insertText(" zzqxword");
    window.__editor!.showOutline();
  });
  await expect(pa.locator("#outline")).toBeVisible();
  await expect(pa.locator("#outline-list")).toContainText("Chapter one");
  await expect.poll(() => pa.evaluate(() => window.__editor!.misspelled().includes("zzqxword"))).toBe(true);
  expect(await pa.evaluate(() => window.__editor!.page().paper)).toBe("letter");
  await pa.locator(".page").click({ button: "right", position: { x: 120, y: 80 } });
  await expect(pa.locator("#context")).toContainText("Paste without formatting");
  await a.close();
});

test("suggesting mode, heading 4, footnote, and pageless", async ({ browser, request }) => {
  const created = await request.post("/api/docs", { data: { title: "Suggest" } });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };
  const a = await browser.newContext();
  const pa = await a.newPage();
  await openDoc(pa, id, "Avery");
  await pa.evaluate(() => {
    window.__editor!.setMode("suggest");
    window.__editor!.insertText("Noted");
  });
  await expect(pa.locator(".suggest")).toContainText("Noted");
  const sugId = await pa.evaluate(() => window.__editor!.suggestions()[0].id);
  await pa.evaluate((sid) => window.__editor!.acceptSuggestion(sid), sugId);
  await expect.poll(() => pa.evaluate(() => window.__editor!.suggestions().length)).toBe(0);
  await expect.poll(() => pa.evaluate(() => window.__editor!.getText())).toContain("Noted");
  await pa.evaluate(() => {
    window.__editor!.setMode("edit");
    window.__editor!.insertText("\nDeep topic");
    const text = window.__editor!.getText();
    const at = text.indexOf("Deep topic");
    window.__editor!.setSelection(at, at + "Deep topic".length);
    window.__editor!.setHeading("h4");
    window.__editor!.showOutline();
    window.__editor!.setSelection(text.length, text.length);
    window.__editor!.insertFootnote("A source");
    window.__editor!.setPageless(true);
  });
  await expect(pa.locator("#outline-list")).toContainText("Deep topic");
  await expect(pa.locator("body")).toHaveClass(/pageless/);
  expect(await pa.evaluate(() => window.__editor!.page().pageless)).toBe(true);
  await a.close();
});

test("columns, capitalization, print preview, and tabs", async ({ browser, request }) => {
  const created = await request.post("/api/docs", { data: { title: "Columns" } });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };
  const a = await browser.newContext();
  const pa = await a.newPage();
  await openDoc(pa, id, "Avery");
  await pa.evaluate(() => {
    window.__editor!.insertText("Left side of the story.\nRight side follows.");
    window.__editor!.setSelection(0, 4);
    window.__editor!.applyCase("upper");
    window.__editor!.setColumns(2);
    window.__editor!.insertSection("cont");
  });
  await expect.poll(() => pa.evaluate(() => window.__editor!.getText())).toContain("LEFT");
  await pa.locator(".menu-btn[data-menu=file]").click();
  await pa.locator("[data-act=print]").click();
  await expect(pa.locator("#print-preview")).toBeVisible();
  await expect(pa.locator("#print-pages")).toContainText("pages");
  await pa.locator("#print-close").click();
  await expect(pa.locator("#tabs")).toBeVisible();
  const added = await request.post("/api/docs/" + id + "/tabs", { data: { title: "Sources" } });
  expect(added.ok()).toBeTruthy();
  await pa.reload();
  await pa.waitForFunction(() => window.__editor?.ready === true);
  await expect(pa.locator("#tabs")).toContainText("Sources");
  await a.close();
});

const LOCAL_SELECTION: [number, number, number] = [168, 199, 250];

function cssRgb(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

function blend(hex: string, alpha: number): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c * alpha + 255 * (1 - alpha));
  return [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)];
}

function dist(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

async function highlightNear(page: Page, selector: string): Promise<number[][]> {
  return page.evaluate((sel) => {
    const caret = document.querySelector(sel) as HTMLElement | null;
    const canvas = document.querySelector(".page canvas") as HTMLCanvasElement | null;
    const stack = document.querySelector("#stack") as HTMLElement | null;
    if (!caret || !canvas || !stack) return [];
    const cRect = canvas.getBoundingClientRect();
    const sRect = stack.getBoundingClientRect();
    const x = sRect.left + Number.parseFloat(caret.style.left) - cRect.left;
    const y = sRect.top + Number.parseFloat(caret.style.top) - cRect.top;
    const dpr = canvas.width / canvas.clientWidth;
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];
    const out: number[][] = [];
    for (const dx of [-6, -16, -30]) {
      for (const dy of [1, 2]) {
        const px = Math.round((x + dx) * dpr);
        const py = Math.round((y + dy) * dpr);
        if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
        const d = ctx.getImageData(px, py, 1, 1).data;
        out.push([d[0], d[1], d[2]]);
      }
    }
    return out;
  }, selector);
}

function nearest(samples: number[][], target: number[]): number {
  return Math.min(...samples.map((sample) => dist(sample, target)));
}

test("local caret and selection stay neutral while the other side keeps the assigned color", async ({ browser, request }) => {
  const created = await request.post("/api/docs", { data: { title: "Presence" } });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };

  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  await openDoc(pa, id, "Avery");
  await openDoc(pb, id, "Blair");

  await pa.evaluate(() => window.__editor!.insertText("Both of us can read this shared sentence."));
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText())).toContain("shared");
  await pa.evaluate(() => {
    const text = window.__editor!.getText();
    const at = text.indexOf("shared");
    window.__editor!.setSelection(at, at + "shared".length);
  });
  await pb.evaluate(() => {
    const text = window.__editor!.getText();
    const at = text.indexOf("sentence");
    window.__editor!.setSelection(at, at + "sentence".length);
  });
  await expect.poll(() => pa.evaluate(() => document.querySelector(".remote-caret")?.getAttribute("data-selection") || "")).toBe("1");
  await expect.poll(() => pb.evaluate(() => document.querySelector(".remote-caret")?.getAttribute("data-selection") || "")).toBe("1");

  const [aColor, bColor] = await Promise.all([
    pa.evaluate(() => window.__editor!.color()),
    pb.evaluate(() => window.__editor!.color()),
  ]);
  expect(aColor).not.toBe(bColor);

  for (const page of [pa, pb]) {
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".local-caret")!).backgroundColor)).toBe("rgb(0, 0, 0)");
    const own = await highlightNear(page, ".local-caret:not(.drop-caret)");
    expect(nearest(own, LOCAL_SELECTION)).toBeLessThan(12);
    const mine = page === pa ? aColor : bColor;
    expect(nearest(own, blend(mine, 0.28))).toBeGreaterThan(24);
    const self = await page.evaluate(() => {
      const el = document.querySelector(".avatar.self") as HTMLElement;
      const style = getComputedStyle(el);
      return { bg: style.backgroundColor, color: style.color, shadow: style.boxShadow };
    });
    expect(self.bg).toBe("rgb(241, 243, 244)");
    expect(self.color).toBe("rgb(32, 33, 36)");
    expect(self.shadow).toBe("none");
  }

  const seenByBlair = await highlightNear(pb, ".remote-caret");
  expect(nearest(seenByBlair, blend(aColor, 0.28))).toBeLessThan(12);
  expect(nearest(seenByBlair, LOCAL_SELECTION)).toBeGreaterThan(24);
  expect(await pb.evaluate(() => getComputedStyle(document.querySelector(".remote-caret")!).backgroundColor)).toBe(cssRgb(aColor));
  expect(await pb.evaluate(() => getComputedStyle(document.querySelector(".remote-flag")!).backgroundColor)).toBe(cssRgb(aColor));
  expect(await pb.evaluate(() => getComputedStyle(document.querySelector(".avatar:not(.self)")!).boxShadow)).toContain(cssRgb(aColor));

  const seenByAvery = await highlightNear(pa, ".remote-caret");
  expect(nearest(seenByAvery, blend(bColor, 0.28))).toBeLessThan(12);
  expect(nearest(seenByAvery, LOCAL_SELECTION)).toBeGreaterThan(24);
  expect(await pa.evaluate(() => getComputedStyle(document.querySelector(".remote-caret")!).backgroundColor)).toBe(cssRgb(bColor));
  expect(await pa.evaluate(() => getComputedStyle(document.querySelector(".remote-flag")!).backgroundColor)).toBe(cssRgb(bColor));
  expect(await pa.evaluate(() => getComputedStyle(document.querySelector(".avatar:not(.self)")!).boxShadow)).toContain(cssRgb(bColor));

  await a.close();
  await b.close();
});
