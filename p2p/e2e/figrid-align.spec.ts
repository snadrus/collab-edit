import { expect, test } from "playwright/test";

test("FiGrid default alignment like Sheets: numbers/dates right, TRUE/FALSE center, text left; explicit Left wins", async ({ page }) => {
  await page.goto("/sheets?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __sheet?: { ready: boolean } }).__sheet?.ready === true && location.hash.length > 1);
  const kb = page.keyboard;
  await page.locator("#grid").click({ position: { x: 80, y: 40 } });
  for (const v of ["42", "=TODAY()", "TRUE", "apples", "'7", "=1>0", "=\"x\"&1"]) { await kb.type(v); await kb.press("Enter"); }
  const align = (r: number) => page.evaluate((r) => (window as unknown as { __sheet: { align(r: number, c: number): string } }).__sheet.align(r, 0), r);
  expect(await Promise.all([0, 1, 2, 3, 4, 5, 6].map(align))).toEqual(["right", "right", "center", "left", "left", "center", "left"]);
  await page.locator("#grid").click({ position: { x: 80, y: 40 } });
  await page.locator("#align").selectOption("left");
  expect(await align(0)).toBe("left");
  await page.screenshot({ path: "/workspace/overnight-figrid-align.png" });
});
