import { expect, test, type Page } from "playwright/test";

/* Real-typing stories: comments persist (peer + save + reload), images delete like Docs, Emacs keys. */
type Ed = {
  ready: boolean;
  getText: () => string;
  selection: () => { anchor: number; head: number };
  setSelection: (a: number, b: number) => void;
  insertImage: (src: string, alt: string, w: number, h: number) => void;
  setEmacsKeys: (on: boolean) => void;
};
const E = (page: Page) => page.evaluate.bind(page);
declare global {
  interface Window { __editor?: Ed; __caretStrict?: boolean; __caretErrors?: string[] }
}
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAP8AAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";

async function start(page: Page, url = "/?wire=test"): Promise<void> {
  await page.addInitScript(() => { window.__caretStrict = true; });
  await page.goto(url);
  if (url.includes("wire=test") && !url.includes("fifolders")) await page.locator("#blank").click();
  await page.waitForFunction(() => window.__editor?.ready === true);
  await page.locator("#pages .page").first().click({ position: { x: 200, y: 150 } });
}
const text = (p: Page) => p.evaluate(() => window.__editor!.getText().replace(/\n$/, ""));
const noDesync = async (p: Page) => expect(await p.evaluate(() => window.__caretErrors ?? [])).toEqual([]);

test("a comment made with the Comment button stays, syncs to a peer, and survives Save and reload", async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  await start(a, "/?wire=test&fifolders=1&path=%2FProjects%2Fplan.fipen&name=plan.fipen");
  await a.keyboard.type("Budget looks high");
  await a.keyboard.down("Shift");
  for (let i = 0; i < 4; i++) await a.keyboard.press("ArrowLeft");
  await a.keyboard.up("Shift");
  await a.locator("#pages canvas").first().click({ button: "right", position: { x: 130, y: 110 } });
  await a.locator("#context").getByRole("button", { name: "Comment" }).click();
  await a.locator(".note textarea").last().click();
  await a.keyboard.type("Can we trim this?");
  await a.locator(".note").last().getByRole("button", { name: "Comment" }).click();
  await expect(a.locator(".note", { hasText: "Can we trim this?" })).toBeVisible();
  await a.waitForTimeout(400);
  await expect(a.locator(".note", { hasText: "Can we trim this?" })).toBeVisible();

  const b = await (await browser.newContext()).newPage();
  await b.goto(a.url());
  await b.waitForFunction(() => window.__editor?.ready === true && window.__editor.getText().includes("Budget"));
  await expect(b.locator(".note", { hasText: "Can we trim this?" })).toBeVisible();

  await a.keyboard.press("ControlOrMeta+s");
  const op = await a.evaluate(() => JSON.parse(localStorage.getItem("fifolders:ops") || "{}").ops?.[0]);
  expect(JSON.stringify(op)).toContain("Can we trim this?");
  await a.reload();
  await a.waitForFunction(() => window.__editor?.ready === true && window.__editor.getText().includes("Budget"));
  await expect(a.locator(".note", { hasText: "Can we trim this?" })).toBeVisible();
  await noDesync(a);
});

test("images: click then Delete/Backspace, Backspace after, Delete before, cut; each undoes", async ({ page }) => {
  await start(page);
  await page.keyboard.type("ab");
  const IMG = "\uFFFC";
  const putImage = async () => {
    await page.evaluate((g) => { window.__editor!.setSelection(1, 1); window.__editor!.insertImage(g, "dot", 80, 40); }, GIF);
    await expect.poll(() => text(page)).toBe("a" + IMG + "b");
  };
  const clickImage = async () => {
    await page.evaluate(() => window.__editor!.setSelection(0, 0));
    const box = await page.evaluate(() => {
      const c = document.querySelector("#pages canvas")!.getBoundingClientRect();
      return { x: c.x, y: c.y };
    });
    // Find the image by scanning for the frame after placing the caret on it.
    await page.evaluate(() => window.__editor!.setSelection(1, 1));
    const f = (await page.locator(".image-frame").boundingBox())!;
    await page.evaluate(() => window.__editor!.setSelection(0, 0));
    await page.mouse.click(f.x + f.width / 2, f.y + f.height / 2);
    void box;
    await expect(page.locator(".image-frame")).toBeVisible();
  };
  await putImage();
  for (const key of ["Delete", "Backspace"]) {
    await clickImage();
    await page.keyboard.press(key);
    expect(await text(page), key).toBe("ab");
    await page.keyboard.press("ControlOrMeta+z");
    expect(await text(page)).toBe("a" + IMG + "b");
  }
  await page.evaluate(() => window.__editor!.setSelection(2, 2));
  await page.keyboard.press("Backspace");
  expect(await text(page)).toBe("ab");
  await page.keyboard.press("ControlOrMeta+z");
  await page.evaluate(() => window.__editor!.setSelection(1, 1));
  await page.keyboard.press("Delete");
  expect(await text(page)).toBe("ab");
  await page.keyboard.press("ControlOrMeta+z");
  await clickImage();
  await page.keyboard.press("ControlOrMeta+x");
  expect(await text(page)).toBe("ab");
  await page.keyboard.press("ControlOrMeta+z");
  expect(await text(page)).toBe("a" + IMG + "b");
  await noDesync(page);
});

test("Emacs keys: Ctrl+A/E/B/F/P/N/D/H/K/Y with real typing", async ({ page }) => {
  await start(page);
  await page.evaluate(() => window.__editor!.setEmacsKeys(true));
  await page.keyboard.type("hello world");
  await page.keyboard.press("Control+a");
  await page.keyboard.type(">");
  await page.keyboard.press("Control+e");
  await page.keyboard.type("!");
  expect(await text(page)).toBe(">hello world!");
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Control+h");
  expect(await text(page)).toBe(">hello word!");
  await page.keyboard.press("Control+d");
  expect(await text(page)).toBe(">hello wor!");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+f");
  await page.keyboard.press("Control+k");
  expect(await text(page)).toBe(">");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+y");
  await page.keyboard.press("Control+p");
  await page.keyboard.type("^");
  await page.keyboard.press("Control+n");
  await page.keyboard.press("Control+e");
  await page.keyboard.type("$");
  const t = await text(page);
  expect(t.split("\n")[0]).toContain("^");
  expect(t.split("\n")[1].endsWith("$")).toBe(true);
  expect(t.replace(/[\^$]/g, "")).toBe(">\nhello wor!");
  await noDesync(page);
});
