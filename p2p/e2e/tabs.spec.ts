import { expect, test, type Page } from "playwright/test";

/* User stories: Google-Docs-style document tabs with an outline under each tab, typed like a person. */

type TabInfo = { id: string; name: string; level: number; text: string };
type Ed = { ready: boolean; tabs: () => TabInfo[]; currentTab: () => string; getText: () => string };
const tabs = (page: Page) => page.evaluate(() => (window as unknown as { __editor: Ed }).__editor.tabs());
const tabNames = async (page: Page) => (await tabs(page)).map((t) => `${"  ".repeat(t.level)}${t.name}`);

test.use({ viewport: { width: 1280, height: 800 } });

async function newDoc(page: Page): Promise<string> {
  await page.goto("/?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __editor?: Ed }).__editor?.ready === true && location.hash.length > 1);
  await page.locator("#pages .page").first().click({ position: { x: 200, y: 150 } });
  return page.url();
}

async function heading(page: Page, text: string, level: 1 | 2 | 3): Promise<void> {
  await page.keyboard.press(`Control+Alt+${level}`);
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

test("S80 tabs: add, type into each tab separately, rename, outline under each tab, jump to a heading", async ({ page }) => {
  await newDoc(page);
  const panel = page.locator("#outline");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".tab-name")).toHaveText(["Tab 1"]);

  await heading(page, "Overview", 1);
  await page.keyboard.type("Intro text for the first tab.");
  await page.keyboard.press("Enter");
  await heading(page, "Goals", 2);
  await page.keyboard.type("Ship tabs.");
  await expect(panel.getByTestId("toc-entry")).toHaveText(["Overview", "Goals"]);
  // The current section is highlighted (caret is under Goals).
  await expect(panel.locator(".toc-list button.active")).toHaveText("Goals");

  await page.locator("#tab-add").click();
  await expect(panel.locator(".tab-name")).toHaveText(["Tab 1", "Tab 2"]);
  await expect(panel.locator(".tab-row.current .tab-name")).toHaveText("Tab 2");
  // A new tab is a blank page: typing goes only into it.
  await heading(page, "Budget", 1);
  await page.keyboard.type("Second tab body.");
  const after = await tabs(page);
  expect(after[0].text).toContain("Intro text for the first tab.");
  expect(after[0].text).not.toContain("Second tab body");
  expect(after[1].text).toContain("Second tab body.");
  expect(after[1].text).not.toContain("Intro text");

  // Rename by double-click, like Docs.
  await panel.locator(".tab-row", { hasText: "Tab 2" }).locator(".tab-name").dblclick();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Money");
  await page.keyboard.press("Enter");
  await expect(panel.locator(".tab-name")).toHaveText(["Tab 1", "Money"]);

  // Outline under each tab; clicking a heading in another tab switches to it and puts the caret there.
  await expect(panel.locator('li[data-tab] .toc-list').first().getByTestId("toc-entry")).toHaveText(["Overview", "Goals"]);
  await panel.getByTestId("toc-entry").filter({ hasText: "Goals" }).click();
  await expect(panel.locator(".tab-row.current .tab-name")).toHaveText("Tab 1");
  await page.screenshot({ path: "/workspace/fipen-tabs.png" });
  await page.keyboard.type("!!");
  expect((await tabs(page))[0].text).toContain("!!Goals");
  await expect(panel.locator(".toc-list button.active")).toHaveText("!!Goals");
  // Select all only covers the tab in view.
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  const cleared = await tabs(page);
  expect(cleared[0].text).toBe("");
  expect(cleared[1].text).toContain("Second tab body.");
});

test("S81 tabs: subtab, reorder, delete with undo; hide and show the sidebar", async ({ page }) => {
  await newDoc(page);
  const panel = page.locator("#outline");
  await page.keyboard.type("first");
  await page.locator("#tab-add").click();
  await page.keyboard.type("second");
  // Subtab from the tab menu.
  await panel.locator(".tab-row", { hasText: "Tab 2" }).hover();
  await panel.locator(".tab-row", { hasText: "Tab 2" }).locator(".tab-more").click();
  await page.getByTestId("tab-add-sub").click();
  await page.keyboard.type("child");
  expect(await tabNames(page)).toEqual(["Tab 1", "Tab 2", "  Tab 3"]);
  // Move Tab 2 (with its child) above Tab 1.
  await panel.locator(".tab-row", { hasText: "Tab 2" }).hover();
  await panel.locator(".tab-row", { hasText: "Tab 2" }).locator(".tab-more").click();
  await page.getByTestId("tab-move-up").click();
  expect(await tabNames(page)).toEqual(["Tab 2", "  Tab 3", "Tab 1"]);
  expect((await tabs(page)).map((t) => t.text)).toEqual(["second", "child", "first"]);
  // Drag Tab 1 back to the top.
  await panel.locator(".tab-row", { hasText: "Tab 1" }).dragTo(panel.locator(".tab-row", { hasText: "Tab 2" }));
  expect(await tabNames(page)).toEqual(["Tab 1", "Tab 2", "  Tab 3"]);
  // Delete Tab 2 (and its subtab), then Undo.
  await panel.locator(".tab-row", { hasText: "Tab 2" }).hover();
  await panel.locator(".tab-row", { hasText: "Tab 2" }).locator(".tab-more").click();
  await page.getByTestId("tab-delete").click();
  expect(await tabNames(page)).toEqual(["Tab 1"]);
  await expect(page.locator("#tab-undo")).toContainText('"Tab 2" deleted');
  await page.locator("#tab-undo button").click();
  expect(await tabNames(page)).toEqual(["Tab 1", "Tab 2", "  Tab 3"]);
  expect((await tabs(page)).map((t) => t.text)).toEqual(["first", "second", "child"]);
  // Collapse the sidebar; the toggle brings it back.
  await page.locator("#outline-close").click();
  await expect(panel).toBeHidden();
  await page.locator("#tabs-toggle").click();
  await expect(panel).toBeVisible();
});

test("S82 tabs: a second person edits tabs at the same time and both converge", async ({ browser }) => {
  const a = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const b = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pa = await a.newPage();
  const url = await newDoc(pa);
  const pb = await b.newPage();
  await pb.goto(url);
  await pb.waitForFunction(() => (window as unknown as { __editor?: Ed }).__editor?.ready === true);
  await pa.keyboard.type("Shared start");
  await expect.poll(() => tabs(pb).then((t) => t[0].text)).toBe("Shared start");

  // Both add a tab at once and type in it.
  await Promise.all([pa.locator("#tab-add").click(), pb.locator("#tab-add").click()]);
  await pa.keyboard.type("Avery's notes");
  await pb.keyboard.type("Blake's notes");
  await expect.poll(async () => JSON.stringify(await tabs(pa)) === JSON.stringify(await tabs(pb))).toBe(true);
  const both = await tabs(pa);
  expect(both).toHaveLength(3);
  expect(both.map((t) => t.text).sort()).toEqual(["Avery's notes", "Blake's notes", "Shared start"]);

  // B renames a tab while A types in the first tab; A sees the new name and nothing is lost.
  await pb.locator("#outline .tab-row").first().locator(".tab-name").dblclick();
  await pb.keyboard.press("Control+A");
  await pb.keyboard.type("Plan");
  await pb.keyboard.press("Enter");
  await pa.locator("#outline .tab-row").first().click();
  await pa.keyboard.press("End");
  await pa.keyboard.type(" plus more");
  await expect(pa.locator("#outline .tab-name").first()).toHaveText("Plan");
  await expect.poll(async () => JSON.stringify(await tabs(pa)) === JSON.stringify(await tabs(pb))).toBe(true);
  expect((await tabs(pb))[0]).toMatchObject({ name: "Plan", text: "Shared start plus more" });
  // A's caret stays in A's tab when B types in another tab.
  const mine = await pa.evaluate(() => (window as unknown as { __editor: Ed }).__editor.currentTab());
  await pb.locator("#outline .tab-row").nth(2).click();
  await pb.keyboard.type(" again");
  await pa.keyboard.type("!");
  await expect.poll(() => tabs(pb).then((t) => t[0].text)).toBe("Shared start plus more!");
  expect(await pa.evaluate(() => (window as unknown as { __editor: Ed }).__editor.currentTab())).toBe(mine);
  await a.close();
  await b.close();
});

test("S83 tabs on a phone: sidebar is a drawer, picking a tab closes it", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto("/?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __editor?: Ed }).__editor?.ready === true);
  await expect(page.locator("#outline")).toBeHidden();
  await page.locator("#tabs-toggle").click();
  await expect(page.locator("#outline")).toBeVisible();
  await page.locator("#tab-add").click();
  await page.locator("#outline .tab-row").first().click();
  await expect(page.locator("#outline")).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.locator("#tabs-toggle").click();
  await page.screenshot({ path: "/workspace/fipen-tabs-phone.png" });
  await ctx.close();
});
