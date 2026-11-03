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
