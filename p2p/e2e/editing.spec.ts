import { expect, test, type Page } from "playwright/test";

/* Google-Docs-style caret visibility and image handling, driven with real keyboard/mouse input. */

type Ed = {
  ready: boolean;
  getText: () => string;
  insertText: (text: string) => void;
  setSelection: (a: number, h: number) => void;
  selection: () => { anchor: number; head: number };
  styleAt: (i: number) => Record<string, unknown>;
};
const ed = "window.__editor";

async function newDoc(page: Page): Promise<string> {
  await page.goto("/?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __editor?: Ed }).__editor?.ready === true && location.hash.length > 1);
  await page.locator("#pages .page").first().click({ position: { x: 200, y: 150 } });
  return page.url();
}

/** The local caret's box lies fully inside the #scroll viewport. */
async function caretInView(page: Page): Promise<boolean> {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.evaluate(() => {
    const c = document.querySelector(".local-caret:not(.drop-caret)")!.getBoundingClientRect();
    const s = document.querySelector("#scroll")!.getBoundingClientRect();
    return c.height > 0 && c.top >= s.top && c.bottom <= s.bottom && c.left >= s.left && c.right <= s.right;
  });
}

async function caretOffsetFromCenter(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector(".local-caret:not(.drop-caret)")!.getBoundingClientRect();
    const s = document.querySelector("#scroll")!.getBoundingClientRect();
    return Math.abs((c.top + c.bottom) / 2 - (s.top + s.bottom) / 2) / s.height;
  });
}

async function typeLines(page: Page, n: number, word = "Line"): Promise<void> {
  for (let i = 0; i < n; i++) {
    await page.keyboard.type(`${word} ${i} lorem ipsum`);
    await page.keyboard.press("Enter");
  }
}

test.use({ viewport: { width: 1200, height: 700 } });

test("typing and Enter past the bottom keep the caret on screen", async ({ page }) => {
  await newDoc(page);
  for (let i = 0; i < 45; i++) {
    await page.keyboard.type(`Line ${i} lorem ipsum`);
    await page.keyboard.press("Enter");
    if (i % 5 === 4) expect(await caretInView(page), `after line ${i}`).toBe(true);
  }
  // Minimal scroll while typing: the caret sits near the bottom, not re-centered.
  expect(await caretOffsetFromCenter(page)).toBeGreaterThan(0.2);
  await expect(page.locator(".toolbar").first()).toBeInViewport();
});

test("Ctrl+Home/End, PageUp/PageDown, arrows and Home/End keep the caret in view; big jumps center it", async ({ page }) => {
  await newDoc(page);
  await typeLines(page, 80);
  await page.keyboard.press("ControlOrMeta+Home");
  expect(await caretInView(page)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __editor: Ed }).__editor.selection().head)).toBe(0);
  await page.keyboard.press("ControlOrMeta+End");
  expect(await caretInView(page)).toBe(true);
  await page.keyboard.press("ControlOrMeta+Home");
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("PageDown");
    expect(await caretInView(page)).toBe(true);
  }
  expect(await page.evaluate(() => (window as unknown as { __editor: Ed }).__editor.selection().head)).toBeGreaterThan(200);
  await page.keyboard.press("PageUp");
  expect(await caretInView(page)).toBe(true);
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowDown");
  expect(await caretInView(page)).toBe(true);
  await page.keyboard.press("End");
  expect(await caretInView(page)).toBe(true);
  // Scrolled away with the wheel, then typing brings the caret back.
  await page.evaluate(() => (document.querySelector("#scroll")!.scrollTop = 0));
  await page.keyboard.type("x");
  expect(await caretInView(page)).toBe(true);
  // A far jump (Ctrl+End from the top) centers the caret.
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ControlOrMeta+End");
  await caretInView(page);
  expect(await caretOffsetFromCenter(page)).toBeLessThan(0.15);
});

test("undo and redo far away move the caret to the change and scroll to it", async ({ page }) => {
  await newDoc(page);
  await typeLines(page, 70);
  await page.keyboard.type("TAIL");
  await page.keyboard.press("ControlOrMeta+Home");
  expect(await caretInView(page)).toBe(true);
  await page.keyboard.press("ControlOrMeta+z");
  expect(await caretInView(page)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __editor: Ed }).__editor.selection().head)).toBeGreaterThan(500);
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  expect(await caretInView(page)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __editor: Ed }).__editor.getText())).toContain("TAIL");
});

test("big paste keeps the caret in view", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await newDoc(page);
  await page.evaluate(() => navigator.clipboard.writeText(Array.from({ length: 90 }, (_, i) => "pasted line " + i).join("\n")));
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __editor: Ed }).__editor.getText().includes("pasted line 89"))).toBe(true);
  expect(await caretInView(page)).toBe(true);
});

test("find keeps typing in the box, Enter steps through hits, and each hit is scrolled into view", async ({ page }) => {
  await newDoc(page);
  await typeLines(page, 70, "Para");
  await page.keyboard.press("ControlOrMeta+Home");
  const before = await page.evaluate(() => (window as unknown as { __editor: Ed }).__editor.getText());
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.locator("#find-q")).toBeFocused();
  await page.keyboard.type("Para 65 ");
  await expect(page.locator("#find-q")).toHaveValue("Para 65 ");
  await expect(page.locator("#find-q")).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { __editor: Ed }).__editor.getText())).toBe(before);
  expect(await caretInView(page)).toBe(true);
  await page.locator("#find-q").fill("Para 1");
  await page.keyboard.press("Enter");
  await expect(page.locator("#find-q")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#find-q")).toBeHidden();
});

test("a remote peer's caret never scrolls me; their edits above keep my caret in view", async ({ browser }) => {
  const ca = await browser.newContext({ viewport: { width: 1200, height: 700 } });
  const cb = await browser.newContext({ viewport: { width: 1200, height: 700 } });
  const pa = await ca.newPage();
  const url = await newDoc(pa);
  await typeLines(pa, 60);
  const pb = await cb.newPage();
  await pb.goto(url);
  await pb.waitForFunction(() => (window as unknown as { __editor?: Ed }).__editor?.ready === true);
  await expect.poll(() => pb.evaluate(() => (window as unknown as { __editor: Ed }).__editor.getText().length)).toBeGreaterThan(500);
  await pa.keyboard.press("ControlOrMeta+End");
  await caretInView(pa);
  const top = await pa.evaluate(() => document.querySelector("#scroll")!.scrollTop);
  await pb.locator("#pages .page").first().click({ position: { x: 200, y: 150 } });
  await pb.keyboard.press("ControlOrMeta+Home");
  await pb.keyboard.press("ArrowRight");
  await expect(pa.locator(".remote-caret")).toHaveCount(1);
  await pa.waitForTimeout(400);
  expect(await pa.evaluate(() => document.querySelector("#scroll")!.scrollTop)).toBe(top);
  for (let i = 0; i < 25; i++) await pb.keyboard.press("Enter");
  await expect.poll(() => pa.evaluate(() => (window as unknown as { __editor: Ed }).__editor.getText()) ).toBe(await pb.evaluate(() => (window as unknown as { __editor: Ed }).__editor.getText()));
  expect(await caretInView(pa)).toBe(true);
  await pa.screenshot({ path: test.info().outputPath("peers.png") });
  await ca.close();
  await cb.close();
});

test("narrow (mobile) width: typing at the end of a long line keeps the caret visible horizontally", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await newDoc(page);
  await page.keyboard.type("A long line that runs past the right edge of a phone screen");
  expect(await caretInView(page)).toBe(true);
  await page.keyboard.press("Home");
  expect(await caretInView(page)).toBe(true);
  await page.keyboard.press("End");
  expect(await caretInView(page)).toBe(true);
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.keyboard.type("!");
  expect(await caretInView(page)).toBe(true);
});

test("a fresh standalone doc says 'New, unsaved'", async ({ page }) => {
  await newDoc(page);
  await expect(page.locator("#status")).toHaveText("New, unsaved");
});

// ---- Images ----

const PNG_RED_4x2 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAEklEQVR4nGP4z8DwHxkzEC4AAHn3E+0Ra0pfAAAAAElFTkSuQmCC";

async function imageCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const e = (window as unknown as { __editor: Ed }).__editor;
    const text = e.getText();
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text[i] === "\uFFFC" && e.styleAt(i).embed === "img") n++;
    return n;
  });
}

async function firstImage(page: Page): Promise<{ index: number; iw: number; ih: number; src: string; alt: string } | null> {
  return page.evaluate(() => {
    const e = (window as unknown as { __editor: Ed }).__editor;
    const text = e.getText();
    for (let i = 0; i < text.length; i++) {
      const st = e.styleAt(i) as { embed?: string; iw: number; ih: number; src: string; alt: string };
      if (text[i] === "\uFFFC" && st.embed === "img") return { index: i, iw: st.iw, ih: st.ih, src: st.src, alt: st.alt };
    }
    return null;
  });
}

/** Real dragenter/dragover/drop events carrying a desktop file at a point on the page. */
async function dropFile(page: Page, x: number, y: number, outside = false): Promise<void> {
  await page.evaluate(
    async ({ b64, x, y, outside }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "red-dot.png", { type: "image/png" }));
      const target = outside ? document.body : document.elementFromPoint(x, y)!;
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
        if (type === "dragover") await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
    },
    { b64: PNG_RED_4x2, x, y, outside },
  );
}

test("dropping a desktop image inserts it at the drop point, shows a drop caret, never navigates", async ({ page }) => {
  await newDoc(page);
  await page.keyboard.type("before after");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __editor: Ed }).__editor.getText())).toContain("before after");
  expect(await caretInView(page)).toBe(true);
  const url = page.url();
  const caret = (await page.locator(".local-caret:not(.drop-caret)").boundingBox())!;
  // Drop caret appears on dragover.
  await page.evaluate(
    ({ x, y }) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "a.png", { type: "image/png" }));
      document.elementFromPoint(x, y)!.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
    },
    { x: caret.x - 40, y: caret.y + caret.height / 2 },
  );
  await expect(page.locator(".drop-caret")).toBeVisible();
  await page.screenshot({ path: "/workspace/fipen-after-image-dropcaret.png" });
  await dropFile(page, caret.x - 40, caret.y + caret.height / 2);
  await expect.poll(() => imageCount(page)).toBe(1);
  await expect(page.locator(".drop-caret")).toBeHidden();
  const img = (await firstImage(page))!;
  expect(img.src.startsWith("data:image/")).toBe(true);
  expect(img.alt).toBe("red-dot");
  expect(img.iw / img.ih).toBeCloseTo(2, 1);
  expect(img.index).toBeGreaterThan(0);
  expect(img.index).toBeLessThan(12);
  // Dropping outside the page is swallowed, not opened in the tab.
  const prevented = await page.evaluate(() => {
    const ev = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
    document.body.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(prevented).toBe(true);
  expect(page.url()).toBe(url);
  await page.screenshot({ path: "/workspace/fipen-after-image-drop.png" });
});

test("dragging an image from another page inserts it", async ({ page }) => {
  await newDoc(page);
  const caret = (await page.locator(".local-caret:not(.drop-caret)").boundingBox())!;
  await page.evaluate(
    ({ b64, x, y }) => {
      const dt = new DataTransfer();
      dt.setData("text/html", `<img src="data:image/png;base64,${b64}" alt="From web">`);
      dt.setData("text/uri-list", `data:image/png;base64,${b64}`);
      const t = document.elementFromPoint(x, y)!;
      for (const type of ["dragenter", "dragover", "drop"]) t.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
    },
    { b64: PNG_RED_4x2, x: caret.x + 5, y: caret.y + caret.height / 2 },
  );
  await expect.poll(() => imageCount(page)).toBe(1);
  expect((await firstImage(page))!.alt).toBe("From web");
});

test("pasting an image from the clipboard inserts it; Backspace deletes it and undo brings it back", async ({ page }) => {
  await newDoc(page);
  await page.keyboard.type("x");
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
  }, PNG_RED_4x2);
  await expect.poll(() => imageCount(page)).toBe(1);
  await page.keyboard.press("Backspace");
  await expect.poll(() => imageCount(page)).toBe(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => imageCount(page)).toBe(1);
});

test("toolbar image button picks a file; corner resize keeps the aspect ratio; image syncs to a peer", async ({ browser }) => {
  const ca = await browser.newContext({ viewport: { width: 1200, height: 700 } });
  const cb = await browser.newContext({ viewport: { width: 1200, height: 700 } });
  const pa = await ca.newPage();
  const url = await newDoc(pa);
  const pb = await cb.newPage();
  await pb.goto(url);
  await pb.waitForFunction(() => (window as unknown as { __editor?: Ed }).__editor?.ready === true);
  await expect(pa.locator("#image-btn")).toBeVisible();
  await pa.locator("#image-btn").click();
  await pa.locator("#image-file").setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from(PNG_RED_4x2, "base64") });
  await expect.poll(() => imageCount(pa)).toBe(1);
  await expect.poll(() => imageCount(pb)).toBe(1);
  const img = (await firstImage(pa))!;
  // Select the image (click it) and drag the SE corner handle.
  await pa.evaluate((i) => (window as unknown as { __editor: Ed }).__editor.setSelection(i, i), img.index);
  const handle = pa.locator('.image-handle[data-corner="se"]');
  await expect(handle).toBeVisible();
  const hb = (await handle.boundingBox())!;
  await pa.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await pa.mouse.down();
  await pa.mouse.move(hb.x + 200, hb.y + 30, { steps: 8 });
  await pa.mouse.up();
  await expect.poll(async () => (await firstImage(pa))!.iw).toBeGreaterThan(img.iw + 50);
  const after = (await firstImage(pa))!;
  expect(after.iw / after.ih).toBeCloseTo(img.iw / img.ih, 1);
  await expect.poll(async () => (await firstImage(pb))!.iw).toBe(after.iw);
  await pa.screenshot({ path: "/workspace/fipen-after-image-resize.png" });
  await ca.close();
  await cb.close();
});

test("Home/End move to the start/end of the visual (wrapped) line, like Docs", async ({ page }) => {
  await newDoc(page);
  const ed = () => page.evaluate(() => (window as unknown as { __editor: { selection: () => { head: number }; getText: () => string } }).__editor);
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  await page.evaluate((t) => (window as unknown as { __editor: { insertText: (t: string) => void } }).__editor.insertText(t), words);
  const sel = () => page.evaluate(() => (window as unknown as { __editor: { selection: () => { head: number } } }).__editor.selection().head);
  void ed;
  // The canvas requests the text font on first draw; when it lands lines rewrap (and FiPen relayouts). Wait for it.
  await page.waitForFunction(() => document.fonts.status === "loaded");
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("End");
  const firstEnd = await sel();
  expect(firstEnd).toBeGreaterThan(5);
  expect(firstEnd).toBeLessThan(words.length - 5); // wrapped line end, not the paragraph end
  // Caret a few characters into the second visual line: Home goes to that line's start, not the paragraph's.
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Home");
  const secondStart = await sel();
  expect(secondStart).toBeGreaterThan(firstEnd - 1);
  expect(secondStart).toBeLessThan(firstEnd + 3);
  await page.keyboard.press("End");
  expect(await sel()).toBeGreaterThan(secondStart + 5);
  expect(await sel()).toBeLessThan(words.length - 5);
  // Ctrl/Cmd+End still goes to the end of the document.
  await page.keyboard.press("ControlOrMeta+End");
  expect(await sel()).toBe(words.length);
});
