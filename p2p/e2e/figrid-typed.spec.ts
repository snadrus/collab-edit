import { expect, test } from "playwright/test";

test("FiGrid typed entry like Sheets: 1,000 / $5 / 50% / 2026-01-05 are numbers (sum, date math, right-aligned)", async ({ page }) => {
  await page.goto("/sheets?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __sheet?: { ready: boolean } }).__sheet?.ready === true && location.hash.length > 1);
  await page.locator("#grid").click({ position: { x: 80, y: 40 } });
  for (const v of ["1,000", "$5", "50%", "2026-01-05", "=SUM(A1:A3)", "=A4+1", "hello"]) { await page.keyboard.type(v); await page.keyboard.press("Enter"); }
  const got = await page.evaluate(() => {
    const s = (window as unknown as { __sheet: { display(r: number, c: number): string; align(r: number, c: number): string } }).__sheet;
    return [0, 1, 2, 3, 4, 5, 6].map((r) => `${s.display(r, 0)}|${s.align(r, 0)}`);
  });
  expect(got).toEqual(["1,000|right", "$5.00|right", "50%|right", "2026-01-05|right", "1005.5|right", "2026-01-06|right", "hello|left"]);
});
