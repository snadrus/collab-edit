import { expect, test, type Page } from "playwright/test";

/* User story: I'm a guest editing a shared doc. The owner's computer goes to sleep. My edits can't reach them.
   After a short while FiPen quietly offers "Owner is away. Save a copy to your folders?". I save a copy into my own
   FiFolders drive; it records the original owner, document and base version. When the owner comes back, they get the
   copy too, listed for FiFolders' "Participant copies", so they can bring it into their own drive. */

type Api = { ready: boolean; getText: () => string; insertText: (t: string) => void };

async function newDoc(page: Page): Promise<string> {
  await page.goto("/?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __editor?: Api }).__editor?.ready === true && location.hash.length > 1);
  return page.url();
}

const ops = (page: Page) => page.evaluate(() => (JSON.parse(localStorage.getItem("fifolders:ops") || "{}").ops || []) as Record<string, string>[]);

test("guest with unsaved edits is offered a copy after the owner goes away; the owner receives it on return", async ({ browser }) => {
  const owner = await browser.newContext();
  const guest = await browser.newContext();
  await guest.addInitScript(() => ((window as unknown as { __p2pCopyOfferMs: number }).__p2pCopyOfferMs = 2000));
  const pa = await owner.newPage();
  const url = await newDoc(pa);
  await pa.evaluate(() => (window as unknown as { __editor: Api }).__editor.insertText("Shared plan"));
  const pb = await guest.newPage();
  await pb.goto(url);
  await pb.waitForFunction(() => (window as unknown as { __editor?: Api }).__editor?.ready === true);
  await expect.poll(() => pb.evaluate(() => (window as unknown as { __editor: Api }).__editor.getText())).toContain("Shared plan");
  // Owner present: typing is acked, no offer.
  await pb.locator("#pages .page").first().click({ position: { x: 300, y: 150 } });
  await pb.keyboard.press("ControlOrMeta+End");
  await pb.keyboard.type(" ok");
  await pb.waitForTimeout(3000);
  await expect(pb.locator("#p2p-copy")).toHaveCount(0);
  // Owner's machine drops off the network; the guest keeps typing.
  await owner.setOffline(true);
  await pb.keyboard.type(" plus my edits");
  await expect(pb.locator("#p2p-copy")).toBeVisible({ timeout: 15_000 });
  await expect(pb.locator("#p2p-copy-text")).toHaveText("Owner is away. Save a copy to your folders?");
  await pb.screenshot({ path: "/workspace/fipen-after-guest-copy-offer.png" });
  await pb.locator("#p2p-copy-save").click();
  await expect(pb.locator("#p2p-copy-open")).toBeVisible();
  const op = (await ops(pb)).find((item) => item.id?.startsWith("copy:doc:"))!;
  expect(op.kind).toBe("fel-save");
  expect(op.path).toMatch(/^\/Copies\/.*\(my copy\)\.fipen$/);
  await expect(pb.locator("#p2p-guest-status")).toContainText(/Copy (waiting|saved)/);
  const file = JSON.parse(op.content) as { snapshot: unknown; copyOf: { doc: string; baseRev: number; by: string } };
  expect(JSON.stringify(file.snapshot)).toContain("plus my edits");
  expect(file.copyOf.doc).toMatch(/^doc:/);
  expect(file.copyOf.baseRev).toBeGreaterThan(0);
  // Owner returns (reload = new hub); the guest hands over the copy.
  await owner.setOffline(false);
  await pa.reload();
  await pa.waitForFunction(() => (window as unknown as { __editor?: Api }).__editor?.ready === true);
  await expect(pa.locator("#p2p-copy-notice")).toBeVisible({ timeout: 20_000 });
  const copies = await pa.evaluate(() => JSON.parse(localStorage.getItem("fifolders:copies") || "[]") as { from: string; content: string; origin: { doc: string } }[]);
  expect(copies).toHaveLength(1);
  expect(copies[0].content).toContain("plus my edits");
  await pa.screenshot({ path: "/workspace/fipen-after-guest-copy-owner.png" });
  await owner.close();
  await guest.close();
});

test("FiGrid guest gets the same offer", async ({ browser }) => {
  const owner = await browser.newContext();
  const guest = await browser.newContext();
  await guest.addInitScript(() => ((window as unknown as { __p2pCopyOfferMs: number }).__p2pCopyOfferMs = 2000));
  const pa = await owner.newPage();
  await pa.goto("/sheets?wire=test");
  await pa.locator("#blank").click();
  await pa.waitForFunction(() => (window as unknown as { __sheet?: { ready: boolean } }).__sheet?.ready === true && location.hash.length > 1);
  const url = pa.url();
  const pb = await guest.newPage();
  await pb.goto(url);
  await pb.waitForFunction(() => (window as unknown as { __sheet?: { ready: boolean } }).__sheet?.ready === true);
  await owner.setOffline(true);
  await pb.evaluate(() => (window as unknown as { __sheet: { setCell: (r: number, c: number, v: string) => void } }).__sheet.setCell(0, 0, "guest value"));
  await expect(pb.locator("#p2p-copy")).toBeVisible({ timeout: 15_000 });
  await pb.locator("#p2p-copy-save").click();
  const op = (await ops(pb)).find((item) => item.id?.startsWith("copy:book:"))!;
  expect(op.path).toMatch(/^\/Copies\/.*\(my copy\)\.figrid$/);
  expect(op.content).toContain("guest value");
  await owner.close();
  await guest.close();
});
