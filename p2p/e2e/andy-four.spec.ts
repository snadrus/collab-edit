/**
 * Andy's four FiPen reports: spelling (Hunspell en_US), a guest's wallet save, guest highlighting, and the doc title.
 * Real typing and clicks only; every test also fails on any caret/typing-offset mismatch.
 */
import { expect, test, type Browser, type Page } from "playwright/test";

export type Ed = {
  ready: boolean;
  getText: () => string;
  misspelled: () => string[];
  caretStats: () => { checks: number; mismatches: number; last: string };
};

async function newDoc(page: Page): Promise<string> {
  await page.goto("/?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as any).__editor?.ready === true && location.hash.length > 1);
  await focusDoc(page);
  return page.url();
}

async function focusDoc(page: Page): Promise<void> {
  await page.bringToFront();
  const box = (await page.locator("#pages canvas").first().boundingBox())!;
  await page.mouse.click(box.x + 120, box.y + 120);
}

async function noCaretMismatch(page: Page): Promise<void> {
  const stats = await page.evaluate(() => (window as any).__editor.caretStats());
  expect(stats.mismatches, stats.last).toBe(0);
}

async function share(page: Page): Promise<string> {
  await page.locator("#share").click();
  await page.locator("#copy-link").click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  await page.locator("#dialog-close").click();
  return link;
}

async function pair(browser: Browser, ownerUrl?: string) {
  const perms = { permissions: ["clipboard-read", "clipboard-write"] };
  const ownerCtx = await browser.newContext(perms);
  const owner = await ownerCtx.newPage();
  if (ownerUrl) {
    await owner.goto(ownerUrl);
    await owner.waitForFunction(() => (window as any).__editor?.ready === true);
    await focusDoc(owner);
  } else await newDoc(owner);
  await owner.keyboard.type("Owner line");
  const link = await share(owner);
  const guestCtx = await browser.newContext(perms);
  const guest = await guestCtx.newPage();
  await guest.goto(link);
  await guest.waitForFunction(() => (window as any).__editor?.ready === true);
  await expect.poll(() => guest.evaluate(() => (window as any).__editor.getText()), { timeout: 30_000 }).toContain("Owner line");
  return { owner, guest, ownerCtx, guestCtx, link, close: async () => (await ownerCtx.close(), await guestCtx.close()) };
}

test("spelling: Hunspell en_US knows inflections and contractions, flags real typos, right-click fixes, Add to dictionary sticks", async ({ page }) => {
  await newDoc(page);
  // Autocorrect still fixes the classics as you type (teh → the).
  await page.keyboard.type("teh ");
  await expect.poll(() => page.evaluate(() => (window as any).__editor.getText())).toContain("the ");
  await page.keyboard.type("The children's toys were happily organized. Running quickly, she didn't realize the analyses mattered. Note anwser goverment Zorblat.");
  await expect.poll(() => page.evaluate(() => (window as any).__editor.misspelled()), { timeout: 15_000 }).toEqual(["anwser", "goverment", "Zorblat"]);
  await page.screenshot({ path: "/workspace/fipen-spell.png" });
  // Right-click the squiggled "anwser": the first suggestion is "answer".
  await page.keyboard.press("Control+End");
  for (let i = 0; i < "anwser goverment Zorblat.".length - 1; i++) await page.keyboard.press("ArrowLeft");
  const caret = (await page.locator(".local-caret").first().boundingBox())!;
  await page.mouse.click(caret.x + 2, caret.y + caret.height / 2, { button: "right" });
  const menu = page.locator("#context");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".menu-label")).toHaveText("anwser");
  await expect(menu.locator("button").first()).toHaveText("answer");
  await page.screenshot({ path: "/workspace/fipen-spell-menu.png" });
  await menu.locator("button").first().click();
  await expect.poll(() => page.evaluate(() => (window as any).__editor.getText())).toContain("Note answer goverment");
  // Tools → Spelling: fix "goverment".
  await page.locator('[data-menu="tools"]').click();
  await page.locator('[data-act="spelling"]').click();
  await page.locator("#dialog").getByRole("button", { name: "government", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__editor.getText())).toContain("Note answer government Zorblat.");
  // Add to dictionary persists across a reload.
  await page.locator('[data-menu="tools"]').click();
  await page.locator('[data-act="spelling"]').click();
  await page.locator("#dialog").getByRole("button", { name: "Add to dictionary" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__editor.misspelled())).toEqual([]);
  await noCaretMismatch(page);
  await page.reload();
  await page.waitForFunction(() => (window as any).__editor?.ready === true);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).__editor.misspelled())).toEqual([]);
  await page.screenshot({ path: "/workspace/fipen-spell-after-add.png" });
});

test("guest: share link drops the owner's FiFolders context; guest Save keeps a copy in the guest's own folders", async ({ browser }) => {
  // The owner opened the doc from FiFolders (their own path, name, volume and wallet).
  const ownerUrl = "/?wire=test&fifolders=1&path=%2FFiPen%2Fplan.fipen&name=plan.fipen&volume=default&owner=0x1111111111111111111111111111111111111111";
  const { owner, guest, link, close } = await pair(browser, ownerUrl);
  const params = new URL(link).searchParams;
  for (const key of ["fifolders", "path", "name", "volume", "owner"]) expect(params.has(key), key).toBe(false);
  // The guest's wallet (mock EIP-1193) is the one that commits the guest's copy, through the guest's own FiFolders.
  await guest.evaluate(() => {
    (window as any).ethereum = { request: async (r: { method: string }) => (r.method.endsWith("ccounts") ? ["0x2222222222222222222222222222222222222222"] : "0x4cb2f") };
  });
  await focusDoc(guest);
  await guest.keyboard.press("Control+End");
  await guest.keyboard.type(" and guest");
  await expect.poll(() => owner.evaluate(() => (window as any).__editor.getText())).toContain("Owner line and guest");
  const save = guest.locator("#p2p-save");
  await expect(save).toHaveText("Save a copy");
  await save.click();
  await expect(guest.locator("#p2p-copy-text")).toContainText("Copy queued for your folders");
  const ops = await guest.evaluate(() => JSON.parse(localStorage.getItem("fifolders:ops") || "{}").ops || []);
  expect(ops).toHaveLength(1);
  expect(ops[0].kind).toBe("fel-save");
  expect(ops[0].path).toBe("/Copies/plan (my copy).fipen");
  expect(JSON.parse(ops[0].content).snapshot.text).toContain("Owner line and guest");
  // Keyboard save does the same; the owner's own row and title are untouched.
  await guest.keyboard.press("Control+s");
  expect(await owner.evaluate(() => JSON.parse(localStorage.getItem("fifolders:ops") || "{}").ops || [])).toHaveLength(0);
  await expect(owner.locator("#title")).toHaveValue("plan");
  await noCaretMismatch(guest);
  await close();
});

test("guest highlighting: named carets and selections in stable per-person colors that update live", async ({ browser }) => {
  const { owner, guest, guestCtx, link, close } = await pair(browser);
  await focusDoc(guest);
  await guest.keyboard.press("Control+Home");
  await guest.keyboard.press("Shift+End");
  const flag = owner.locator(".remote-caret");
  await expect(flag).toHaveCount(1);
  await expect(flag).toHaveAttribute("data-selection", "1");
  const guestName = (await guest.locator("#name-btn").textContent())!.trim();
  await expect(flag.locator(".remote-flag")).toHaveText(guestName);
  const color = await flag.locator(".remote-flag").evaluate((el) => getComputedStyle(el).backgroundColor);
  await expect(owner.locator("#avatars > *")).toHaveCount(2);
  const avatar = owner.locator("#avatars .avatar:not(.self)");
  await expect(avatar).toHaveAttribute("title", guestName);
  // Live rename over the wire: the label and avatar follow, the color stays.
  // (The guest sets a display name in their FiFolders tab on the same site.)
  const folders = await guestCtx.newPage();
  await folders.goto("/?wire=test");
  await folders.evaluate(() => localStorage.setItem("fifolders:display-name", "Pat Guest"));
  await folders.close();
  await expect(flag.locator(".remote-flag")).toHaveText("Pat Guest", { timeout: 15_000 });
  await expect(avatar).toHaveAttribute("title", "Pat Guest");
  expect(await flag.locator(".remote-flag").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(color);
  // Rejoining (reload) keeps the same color.
  await guest.reload();
  await guest.waitForFunction(() => (window as any).__editor?.ready === true);
  await focusDoc(guest);
  await guest.keyboard.press("Control+Home");
  await guest.keyboard.press("Shift+End");
  await expect(owner.locator(".remote-caret .remote-flag")).toHaveText("Pat Guest", { timeout: 15_000 });
  expect(await owner.locator(".remote-caret .remote-flag").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(color);
  // The guest sees the owner the same way.
  await owner.bringToFront();
  await focusDoc(owner);
  await owner.keyboard.press("Control+End");
  await expect(guest.locator(".remote-caret")).toHaveCount(1);
  await owner.locator(".remote-caret").hover();
  await owner.screenshot({ path: "/workspace/fipen-guest-highlight.png" });
  await noCaretMismatch(owner);
  await noCaretMismatch(guest);
  void link;
  await close();
});

test("title: a guest on an old link with the owner's FiFolders name does not rename the doc", async ({ browser }) => {
  const perms = { permissions: ["clipboard-read", "clipboard-write"] };
  const ownerCtx = await browser.newContext(perms);
  const owner = await ownerCtx.newPage();
  await owner.goto("/?wire=test&fifolders=1&path=%2FFiPen%2FUntitled%20document.fipen&name=Untitled%20document.fipen");
  await owner.waitForFunction(() => (window as any).__editor?.ready === true);
  await focusDoc(owner);
  await owner.keyboard.type("Body");
  await owner.locator("#title").click();
  await owner.keyboard.press("Control+a");
  await owner.keyboard.type("Budget 2027");
  await owner.keyboard.press("Enter");
  await owner.keyboard.press("Control+s");
  const ops = await owner.evaluate(() => JSON.parse(localStorage.getItem("fifolders:ops") || "{}").ops || []);
  expect(ops[0].title).toBe("Budget 2027");
  expect(JSON.parse(ops[0].content).title).toBe("Budget 2027");
  // Reload keeps the new title (the URL name follows it).
  await expect.poll(() => owner.evaluate(() => new URL(location.href).searchParams.get("name"))).toBe("Budget 2027.fipen");
  // A guest opening the pre-fix style link (owner's params still on it).
  const stale = (await owner.evaluate(() => location.href)).replace("Budget+2027.fipen", "Untitled+document.fipen");
  expect(stale).toContain("name=Untitled+document.fipen");
  const guestCtx = await browser.newContext(perms);
  const guest = await guestCtx.newPage();
  await guest.goto(stale);
  await guest.waitForFunction(() => (window as any).__editor?.ready === true);
  await expect(guest.locator("#title")).toHaveValue("Budget 2027", { timeout: 15_000 });
  await guest.waitForTimeout(2500);
  await expect(owner.locator("#title")).toHaveValue("Budget 2027");
  await owner.reload();
  await owner.waitForFunction(() => (window as any).__editor?.ready === true);
  await owner.waitForTimeout(1500);
  await expect(owner.locator("#title")).toHaveValue("Budget 2027");
  await ownerCtx.close();
  await guestCtx.close();
});
