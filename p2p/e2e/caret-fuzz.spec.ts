import { expect, test, type Page } from "playwright/test";

/*
 * Cursor integrity fuzz: random real typing, arrows, Home/End, clicks, mentions, images, tabs and Emacs keys
 * while a second peer types concurrently. After every step the editor's own check must find the drawn caret
 * where the model offset is, and a typed character must land exactly at the caret.
 */
type Ed = {
  ready: boolean;
  getText: () => string;
  selection: () => { anchor: number; head: number };
  checkCaret: (reason?: string) => string;
  caretStats: () => { checks: number; mismatches: number; last: string };
  insertImage?: (src: string, alt: string, w: number, h: number) => void;
};
declare global {
  interface Window { __editor?: Ed; __caretStrict?: boolean; __caretErrors?: string[] }
}

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

async function open(page: Page, url?: string): Promise<string> {
  await page.addInitScript(() => { window.__caretStrict = true; });
  if (url) await page.goto(url);
  else {
    await page.goto("/?wire=test");
    await page.locator("#blank").click();
  }
  await page.waitForFunction(() => window.__editor?.ready === true && location.hash.length > 1);
  return page.url();
}

async function clickText(page: Page, fx: number, fy: number) {
  const box = (await page.locator("#pages .page canvas").first().boundingBox())!;
  await page.mouse.click(box.x + 90 + fx * (box.width - 180), box.y + 90 + fy * Math.min(260, box.height - 180));
}

for (const seed of [7, 42, 1234]) {
  test(`caret never drifts from where typing lands (seed ${seed})`, async ({ browser }) => {
    test.setTimeout(240_000);
    const ownerCtx = await browser.newContext();
    const peerCtx = await browser.newContext();
    const a = await ownerCtx.newPage();
    const url = await open(a);
    const b = await peerCtx.newPage();
    await open(b, url);
    await a.evaluate(() => (window.__editor as unknown as { setEmacsKeys: (on: boolean) => void }).setEmacsKeys(true));
    await clickText(a, 0, 0);
    await a.keyboard.type("The quick brown fox jumps over the lazy dog.");
    await a.keyboard.press("Enter");
    await a.keyboard.type("Second line here.");
    await clickText(b, 0.5, 0);
    const r = rng(seed);
    const log: string[] = [];
    const chars = "abcdefghijklmnopqrstuvwxyz ";
    for (let step = 0; step < 120; step++) {
      const p = r();
      let typed = "";
      if (p < 0.45) {
        typed = chars[Math.floor(r() * chars.length)];
        await a.keyboard.type(typed);
      } else if (p < 0.6) await a.keyboard.press(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"][Math.floor(r() * 6)]);
      else if (p < 0.68) await clickText(a, r(), r());
      else if (p < 0.72) await a.keyboard.press("Enter");
      else if (p < 0.76) await a.keyboard.press("Backspace");
      else if (p < 0.79) { await a.keyboard.type("@"); await a.keyboard.press("Escape"); typed = ""; }
      else if (p < 0.82) await a.evaluate(() => window.__editor?.insertImage?.("data:image/gif;base64,R0lGODlhAQABAAAAACw=", "dot", 40, 20));
      else if (p < 0.86) await a.keyboard.press(["Control+a", "Control+e", "Control+b", "Control+f", "Control+p", "Control+n"][Math.floor(r() * 6)]);
      else {
        // The other peer types at its own caret.
        await b.keyboard.type(chars[Math.floor(r() * 26)] + chars[Math.floor(r() * 26)]);
        await a.waitForTimeout(120);
      }
      const state = await a.evaluate(() => {
        const e = window.__editor!;
        const problem = e.checkCaret("fuzz step");
        const { head } = e.selection();
        return { problem, head, text: e.getText(), errors: window.__caretErrors ?? [] };
      });
      log.push(`${step}: p=${p.toFixed(2)} typed=${JSON.stringify(typed)} head=${state.head}`);
      expect(state.errors, log.slice(-8).join("\n")).toEqual([]);
      expect(state.problem, log.slice(-8).join("\n")).toBe("");
      if (typed) expect(state.text[state.head - 1], `typed ${JSON.stringify(typed)} at step ${step}\n${log.slice(-8).join("\n")}`).toBe(state.text[state.head - 1].toLowerCase() === typed ? state.text[state.head - 1] : typed); // autocapitalize ok
    }
    const stats = await a.evaluate(() => window.__editor!.caretStats());
    expect(stats.checks).toBeGreaterThan(100);
    await ownerCtx.close();
    await peerCtx.close();
  });
}

/* Andy's repro: caret on the line just below an image while pressing shortcut keys. An image is exactly one
   offset unit (U+FFFC) in the model and one atomic box in the layout; every key must keep both in step. */
for (const seed of [3, 99, 2026, 5, 17, 61]) {
  test(`shortcut keys around an image keep the caret where typing lands (seed ${seed})`, async ({ page }) => {
    test.setTimeout(120_000);
    await open(page);
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.evaluate(() => (window.__editor as unknown as { setEmacsKeys: (on: boolean) => void }).setEmacsKeys(true));
    await clickText(page, 0, 0);
    await page.keyboard.type("Above the picture");
    await page.keyboard.press("Enter");
    await page.evaluate(() => window.__editor!.insertImage!("data:image/gif;base64,R0lGODlhAQABAIAAAP8AAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==", "dot", 160, 90));
    await page.keyboard.press("Enter");
    await page.keyboard.type("Below the picture");
    await page.keyboard.press("Home");
    const keys = ["Home", "End", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Control+ArrowLeft", "Control+ArrowRight",
      "Control+Home", "Control+End", "Control+a", "Control+e", "Control+p", "Control+n", "Control+b", "Control+f", "Backspace", "Delete",
      "Shift+ArrowUp", "Shift+End", "Control+z", "Meta+ArrowLeft", "Meta+ArrowRight", "Meta+ArrowUp", "Meta+ArrowDown", "Alt+ArrowLeft", "Alt+ArrowRight", "PageUp", "PageDown", "Control+k", "Control+y", "Control+h", "Control+d"];
    const r = rng(seed);
    const log: string[] = [];
    for (let step = 0; step < 300; step++) {
      let typed = "";
      if (r() < 0.3) { typed = "xyz"[Math.floor(r() * 3)]; await page.keyboard.type(typed); }
      else { const k = keys[Math.floor(r() * keys.length)]; typed = ""; log.push("press " + k); await page.keyboard.press(k); }
      const s = await page.evaluate(() => ({ p: window.__editor!.checkCaret("img fuzz"), sel: window.__editor!.selection(), t: window.__editor!.getText(), e: window.__caretErrors ?? [] }));
      log.push(`${step} head=${s.sel.head} anchor=${s.sel.anchor} typed=${typed}`);
      const ctx = log.slice(-10).join("\n");
      expect(s.e, ctx).toEqual([]);
      expect(s.p, ctx).toBe("");
      if (typed) expect(s.t[s.sel.head - 1], ctx).toBe(typed);
    }
  });
}
