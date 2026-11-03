import { expect, test } from "playwright/test";

type Ed = { getText(): string; paraAt(i: number): { list?: string } };
test("FiPen autolist like Docs: '* ' / '- ' start a bulleted list, '1. ' a numbered one; not mid-line", async ({ page }) => {
  await page.goto("/?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __editor?: { ready: boolean } }).__editor?.ready === true && location.hash.length > 1);
  await page.locator("#pages .page").first().click({ position: { x: 200, y: 150 } });
  const kb = page.keyboard;
  const state = () => page.evaluate(() => { const e = (window as unknown as { __editor: Ed }).__editor; const t = e.getText(); return { t, list: e.paraAt(t.length).list ?? null }; });
  await kb.type("* apples", { delay: 20 });
  expect(await state()).toEqual({ t: "apples", list: "bullet" });
  await kb.press("Enter"); await kb.press("Enter"); // Enter on the empty item ends the list (no extra empty bullet)
  expect(await state()).toEqual({ t: "apples\n", list: null });
  await kb.type("1. first", { delay: 20 });
  expect((await state()).list).toBe("numbered");
  expect((await state()).t.endsWith("\nfirst")).toBe(true);
  await kb.press("Enter"); await kb.press("Enter");
  await kb.type("costs 1. more * stars", { delay: 20 });
  expect(await state()).toMatchObject({ list: null });
  expect((await state()).t.endsWith("costs 1. more * stars")).toBe(true);
});
