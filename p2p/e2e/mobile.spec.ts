import { expect, test } from "playwright/test";

test("FiGrid on a phone: no horizontal page overflow; the grid is wider than the comments panel", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sheets?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __sheet?: { ready: boolean } }).__sheet?.ready === true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const stage = (await page.locator("#stage").boundingBox())!;
  expect(stage.width).toBeGreaterThan(300);
  const status = (await page.locator("#status").boundingBox())!;
  expect(status.x + status.width).toBeLessThanOrEqual(390);
});
