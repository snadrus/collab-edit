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

test("FiPen on a phone: text reflows to the screen width (readable size, no sideways scroll); the page size is unchanged", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __editor?: { ready: boolean } }).__editor?.ready === true);
  await page.evaluate(() => (window as unknown as { __editor: { insertText: (t: string) => void } }).__editor.insertText("A phone should show this sentence at a normal reading size, wrapped to the screen."));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const pageBox = (await page.locator("#pages .page").first().boundingBox())!;
  expect(pageBox.width).toBeLessThanOrEqual(390);
  expect(pageBox.width).toBeGreaterThan(300);
  expect(await page.evaluate(() => document.body.classList.contains("phone-fit"))).toBe(true);
  await page.screenshot({ path: "/workspace/fipen-after-phone-reflow.png" });
  // Back to a desktop width: the real page returns.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await page.locator("#pages .page").first().boundingBox())!.width).toBeGreaterThan(700);
});
