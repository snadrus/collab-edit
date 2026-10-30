import { expect, test, type Page } from "playwright/test";

declare global {
  interface Window {
    __editor?: {
      ready: boolean;
      getText: () => string;
      setSelection: (anchor: number, head: number) => void;
      insertText: (text: string) => void;
      remoteCount: () => number;
      color: () => string;
      insertVote: (emoji: string) => void;
      toggleVote: (index: number) => void;
      voteNames: () => string[];
      addComment: (text: string) => boolean;
      reply: (id: string, text: string) => void;
      threads: () => { id: string; text: string; replies: string[]; name: string }[];
      insertTable: (rows: number, cols: number) => void;
      tableRows: () => number;
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

test("votes, comment thread, and table insert", async ({ browser, request }) => {
  const created = await request.post("/api/docs", { data: { title: "Review" } });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: string };

  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  await openDoc(pa, id, "Avery");
  await openDoc(pb, id, "Blair");

  const colors = await Promise.all([pa.evaluate(() => window.__editor!.color()), pb.evaluate(() => window.__editor!.color())]);
  expect(colors[0]).not.toBe(colors[1]);

  await pa.evaluate(() => window.__editor!.insertVote("👍"));
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText().includes("\uFFFC"))).toBe(true);
  await Promise.all([pa.evaluate(() => window.__editor!.toggleVote(0)), pb.evaluate(() => window.__editor!.toggleVote(0))]);
  await expect
    .poll(async () => {
      const left = await pa.evaluate(() => window.__editor!.voteNames().slice().sort().join(","));
      const right = await pb.evaluate(() => window.__editor!.voteNames().slice().sort().join(","));
      return left === right ? left : "";
    })
    .toBe("Avery,Blair");

  await pa.evaluate(() => window.__editor!.insertText("Please review this plan"));
  await expect.poll(() => pb.evaluate(() => window.__editor!.getText().includes("review"))).toBe(true);
  await pa.evaluate(() => {
    const text = window.__editor!.getText();
    const at = text.indexOf("review");
    window.__editor!.setSelection(at, at + "review".length);
    window.__editor!.addComment("Please check the wording");
  });
  await expect.poll(() => pb.evaluate(() => window.__editor!.threads().length)).toBe(1);
  const threadId = await pb.evaluate(() => window.__editor!.threads()[0].id);
  await pb.evaluate((tid) => window.__editor!.reply(tid, "On it"), threadId);
  await expect.poll(() => pa.evaluate(() => window.__editor!.threads()[0]?.replies[0] || "")).toBe("On it");
  await expect.poll(() => pb.evaluate(() => window.__editor!.threads()[0]?.text || "")).toBe("Please check the wording");

  await pa.evaluate(() => window.__editor!.insertTable(2, 3));
  await expect.poll(() => pb.evaluate(() => window.__editor!.tableRows())).toBe(2);
  await expect.poll(() => pa.evaluate(() => window.__editor!.tableRows())).toBe(2);

  await a.close();
  await b.close();
});
