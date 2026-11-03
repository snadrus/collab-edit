import { expect, test } from "playwright/test";

test("FiGrid keyboard like Sheets: Tab, Shift+Enter, Ctrl+Home/End/Arrow, Delete clears, typing replaces, cursor scrolls into view", async ({ page }) => {
  await page.goto("/sheets?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __sheet?: { ready: boolean } }).__sheet?.ready === true && location.hash.length > 1);
  const kb = page.keyboard;
  const nb = page.locator("#namebox");
  const raw = (r: number, c: number) => page.evaluate(([r, c]) => (window as unknown as { __sheet: { raw(r: number, c: number): string } }).__sheet.raw(r, c), [r, c]);
  await page.locator("#grid").click({ position: { x: 80, y: 40 } });
  await expect(nb).toHaveText("A1");
  await kb.type("1"); await kb.press("Tab"); await kb.type("2"); await kb.press("Tab"); await kb.type("3"); await kb.press("Enter");
  expect([await raw(0, 0), await raw(0, 1), await raw(0, 2)]).toEqual(["1", "2", "3"]);
  await kb.press("Shift+Enter");
  await expect(nb).toHaveText("C1");
  await kb.press("Shift+Tab");
  await expect(nb).toHaveText("B1");
  await kb.type("9"); await kb.press("Shift+Tab"); // typing on a filled cell replaces it
  expect(await raw(0, 1)).toBe("9");
  await kb.press("Control+ArrowRight");
  await expect(nb).toHaveText("C1");
  await kb.press("Control+Home");
  await expect(nb).toHaveText("A1");
  await kb.press("Control+End");
  await expect(nb).toHaveText("C1");
  await kb.press("Delete");
  expect(await raw(0, 2)).toBe("");
  await kb.press("Control+Home");
  for (let i = 0; i < 35; i++) await kb.press("ArrowDown");
  await expect(nb).toHaveText("A36");
  expect(await page.locator("#stage").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await kb.press("Control+ArrowUp");
  await expect(nb).toHaveText("A1");
  expect(await page.locator("#stage").evaluate((el) => el.scrollTop)).toBe(0);
});

test("FiGrid Ctrl+Z / Ctrl+Y undo and redo cell edits (values and bold), like Sheets", async ({ page }) => {
  await page.goto("/sheets?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __sheet?: { ready: boolean } }).__sheet?.ready === true && location.hash.length > 1);
  const kb = page.keyboard;
  type S = { raw(r: number, c: number): string; style(r: number, c: number): { b?: boolean } | null };
  const raw = (r: number, c: number) => page.evaluate(([r, c]) => (window as unknown as { __sheet: S }).__sheet.raw(r, c), [r, c]);
  const bold = () => page.evaluate(() => !!(window as unknown as { __sheet: S }).__sheet.style(0, 0)?.b);
  await page.locator("#grid").click({ position: { x: 80, y: 40 } });
  await kb.type("1"); await kb.press("Enter"); await kb.type("2"); await kb.press("Enter");
  await kb.press("ArrowUp"); await kb.type("3"); await kb.press("Enter"); // A2: 2 → 3
  await kb.press("Control+z");
  expect(await raw(1, 0)).toBe("2");
  await kb.press("Control+z");
  expect(await raw(1, 0)).toBe("");
  await kb.press("Control+y");
  expect(await raw(1, 0)).toBe("2");
  await kb.press("Control+Shift+z");
  expect(await raw(1, 0)).toBe("3");
  await kb.press("Control+Home");
  await kb.press("Control+b");
  expect(await bold()).toBe(true);
  await kb.press("Control+z");
  expect(await bold()).toBe(false);
  expect(await raw(0, 0)).toBe("1");
});

test("FiGrid Edit menu has Undo and Redo", async ({ page }) => {
  await page.goto("/sheets?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __sheet?: { ready: boolean } }).__sheet?.ready === true && location.hash.length > 1);
  await page.evaluate(() => (window as unknown as { __sheet: { setCell(r: number, c: number, v: string): void } }).__sheet.setCell(0, 0, "x"));
  await page.getByText("Edit", { exact: true }).first().click();
  await page.locator("[data-act=undo]").click();
  expect(await page.evaluate(() => (window as unknown as { __sheet: { raw(r: number, c: number): string } }).__sheet.raw(0, 0))).toBe("");
});
