import { expect, test, type Page } from "playwright/test";

declare global {
  interface Window {
    __editor?: {
      ready: boolean;
      getText: () => string;
      setSelection: (anchor: number, head: number) => void;
      remoteCount: () => number;
    };
  }
}

async function openDoc(page: Page, id: string, name: string): Promise<void> {
  await page.addInitScript((n) => sessionStorage.setItem("folio-name", n), name);
  await page.goto("/d/" + id);
  await page.waitForFunction(() => window.__editor?.ready === true);
  await page.locator(".page").first().waitFor();
}

test("concurrent typing, paste, undo, and remote caret", async ({ browser, request }) => {
  const created = await request.post("/api/docs", { data: { title: "Notes" } });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };

  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  await openDoc(pa, id, "Avery");
  await openDoc(pb, id, "Blair");

  await pa.locator(".page").click();
  await pb.locator(".page").click();
  await Promise.all([pa.keyboard.type("Hello ", { delay: 20 }), pb.keyboard.type("World", { delay: 20 })]);

  const bag = (s: string) => [...s].sort().join("");
  await expect
    .poll(async () => {
      const left = await pa.evaluate(() => window.__editor!.getText());
      const right = await pb.evaluate(() => window.__editor!.getText());
      return left === right && bag(left) === bag("Hello World") ? left : "";
    })
    .not.toBe("");

  await expect(pa.locator(".remote-caret").first()).toBeVisible();

  await pa.evaluate(() => {
    const text = window.__editor!.getText();
    window.__editor!.setSelection(0, text.length);
    const dt = new DataTransfer();
    dt.setData("text/plain", "Pasted");
    dt.setData("text/html", "<p><b>Pasted</b></p>");
    document.querySelector("#input")!.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt }));
  });
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText())).toBe("Pasted");
  await expect.poll(() => pa.evaluate(() => window.__editor!.getText())).toBe("Pasted");

  await pa.locator("#input").focus();
  await pa.keyboard.press("Control+z");
  await expect
    .poll(async () => {
      const left = await pa.evaluate(() => window.__editor!.getText());
      const right = await pb.evaluate(() => window.__editor!.getText());
      return left === right && left !== "Pasted" ? left : "";
    })
    .not.toBe("");

  await a.close();
  await b.close();
});
