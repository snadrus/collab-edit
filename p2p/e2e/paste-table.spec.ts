import { expect, test } from "playwright/test";

test("FiPen: pasting an HTML table (from Sheets/FiGrid/a web page) makes a table, like Google Docs", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await page.goto("/?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __editor?: { ready: boolean } }).__editor?.ready === true && location.hash.length > 1);
  await page.locator("#pages .page").first().click({ position: { x: 200, y: 150 } });
  await page.keyboard.insertText("Before");
  await page.evaluate(async () => {
    const html = "<table><tr><th>Name</th><th>Qty</th></tr><tr><td><b>Apples</b></td><td>3</td></tr></table>";
    await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob(["Name\tQty\nApples\t3"], { type: "text/plain" }) })]);
  });
  await page.keyboard.press("Control+v");
  const text = await page.evaluate(() => (window as unknown as { __editor: { getText(): string } }).__editor.getText());
  expect(text).toContain("Before\nName\u001cQty\u001eApples\u001c3\u001e");
  // Header cells (<th>) paste bold, like Docs; plain <td> text does not.
  const at = text.indexOf("Name");
  const bold = await page.evaluate((i) => {
    const ed = (window as unknown as { __editor: { styleAt(n: number): { b?: boolean } } }).__editor;
    return [ed.styleAt(i + 1).b, ed.styleAt(i + 17).b ?? false, ed.styleAt(i + 11).b];
  }, at);
  expect(bold).toEqual([true, false, true]);
  await page.screenshot({ path: "/workspace/overnight-fipen-paste-table.png" });
});
