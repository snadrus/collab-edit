import { expect, test } from "playwright/test";

for (const [app, path, ready] of [["FiPen", "/?wire=test", "__editor"], ["FiGrid", "/sheets?wire=test", "__sheet"]] as const) {
  test(`${app} shows an offline chip while the browser is offline, like Docs/Sheets`, async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(path);
    await page.locator("#blank").click();
    await page.waitForFunction((k) => (window as unknown as Record<string, { ready?: boolean }>)[k]?.ready === true, ready);
    const chip = page.getByTestId("offline-chip");
    await expect(chip).toBeHidden();
    await ctx.setOffline(true);
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("You're offline");
    await ctx.setOffline(false);
    await expect(chip).toBeHidden();
  });
}
