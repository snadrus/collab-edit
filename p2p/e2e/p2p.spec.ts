import { expect, test, type Page } from "playwright/test";

declare global {
  interface Window {
    __editor?: {
      ready: boolean;
      getText: () => string;
      insertText: (text: string) => void;
      role: () => string;
    };
    __sheet?: {
      ready: boolean;
      setCell: (r: number, c: number, v: string) => void;
      display: (r: number, c: number) => string;
      role: () => string;
    };
    __p2p?: {
      network: () => string;
      setNetwork: (value: string) => void;
      exportFile: () => Promise<string>;
      loadFile: (raw: string) => Promise<void>;
      pieceCid: () => string;
    };
  }
}

const WAIT = "Waiting for the owner. This document is read-only until they are online.";

async function newDoc(page: Page): Promise<string> {
  await page.goto("/?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => window.__editor?.ready === true && location.hash.length > 1);
  return page.url();
}

test("three peers converge while the owner sequences", async ({ browser }) => {
  const owner = await browser.newContext();
  const guestB = await browser.newContext();
  const guestC = await browser.newContext();
  const pa = await owner.newPage();
  const url = await newDoc(pa);
  const pb = await guestB.newPage();
  const pc = await guestC.newPage();
  await pb.goto(url);
  await pc.goto(url);
  await pb.waitForFunction(() => window.__editor?.ready === true);
  await pc.waitForFunction(() => window.__editor?.ready === true);

  await pa.evaluate(() => window.__editor!.insertText("A"));
  await pb.evaluate(() => window.__editor!.insertText("B"));
  await pc.evaluate(() => window.__editor!.insertText("C"));

  await expect.poll(async () => {
    const texts = await Promise.all([pa, pb, pc].map((page) => page.evaluate(() => window.__editor!.getText())));
    if (!texts.every((text) => text === texts[0])) return texts.map((text) => JSON.stringify(text)).join(" | ");
    return [...texts[0]].sort().join("");
  }).toBe("ABC");

  await owner.close();
  await guestB.close();
  await guestC.close();
});

test("guests wait read-only when the owner leaves", async ({ browser }) => {
  const owner = await browser.newContext();
  const guest = await browser.newContext();
  const pa = await owner.newPage();
  const url = await newDoc(pa);
  await pa.evaluate(() => window.__editor!.insertText("Held"));
  const pb = await guest.newPage();
  await pb.goto(url);
  await pb.waitForFunction(() => window.__editor?.ready === true);
  await expect.poll(async () => pb.evaluate(() => window.__editor!.getText())).toContain("Held");

  await owner.close();
  await expect(pb.locator("#p2p-wait")).toBeVisible();
  await expect.poll(async () => pb.locator("#p2p-wait").innerText()).toContain(WAIT);
  await expect.poll(async () => pb.evaluate(() => window.__editor!.role())).toBe("view");
  const before = await pb.evaluate(() => window.__editor!.getText());
  await pb.evaluate(() => window.__editor!.insertText("nope"));
  expect(await pb.evaluate(() => window.__editor!.getText())).toBe(before);

  await guest.close();
});

test("mainnet save dialog says there is no registry", async ({ page }) => {
  await newDoc(page);
  await page.locator('[data-menu="file"]').click();
  await page.locator("#p2p-end").click();
  await expect(page.locator("#p2p-registry")).toHaveText("no registry on this network");
  await page.locator('input[name="p2p-net"][value="calibration"]').check();
  await expect(page.locator("#p2p-registry")).toContainText("0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331");
  await expect(page.locator("#p2p-registry")).toContainText("4207373");
  await page.locator('input[name="p2p-net"][value="mainnet"]').check();
  await expect(page.locator("#p2p-registry")).toHaveText("no registry on this network");
  await page.locator("#p2p-open").click();
  await expect(page.locator("#p2p-status")).toHaveText("no registry on this network");
});

test("file adapter save and load round-trips the snapshot", async ({ browser }) => {
  const owner = await browser.newContext();
  const other = await browser.newContext();
  const pa = await owner.newPage();
  await newDoc(pa);
  expect(await pa.evaluate(() => window.__p2p!.network())).toBe("mainnet");
  await pa.evaluate(() => window.__p2p!.setNetwork("calibration"));
  expect(await pa.evaluate(() => window.__p2p!.network())).toBe("calibration");
  await pa.evaluate(() => window.__p2p!.setNetwork("mainnet"));
  await pa.evaluate(() => window.__editor!.insertText("Persist me"));
  await expect.poll(async () => pa.evaluate(() => window.__editor!.getText())).toContain("Persist me");
  const raw = await pa.evaluate(() => window.__p2p!.exportFile());
  expect(await pa.evaluate(() => window.__p2p!.pieceCid())).toMatch(/^file:/);
  expect(raw).toContain("Persist me");

  const pb = await other.newPage();
  await newDoc(pb);
  await pb.evaluate((text) => window.__p2p!.loadFile(text), raw);
  await expect.poll(async () => pb.evaluate(() => window.__editor!.getText())).toContain("Persist me");
  expect(await pb.evaluate(() => window.__p2p!.pieceCid())).toMatch(/^file:/);

  await owner.close();
  await other.close();
});

test("spreadsheet edits sync through the owner", async ({ browser }) => {
  const owner = await browser.newContext();
  const guest = await browser.newContext();
  const pa = await owner.newPage();
  await pa.goto("/sheets?wire=test");
  await pa.locator("#blank").click();
  await pa.waitForFunction(() => window.__sheet?.ready === true && location.hash.length > 1);
  const url = pa.url();
  const pb = await guest.newPage();
  await pb.goto(url);
  await pb.waitForFunction(() => window.__sheet?.ready === true);
  await pa.evaluate(() => {
    window.__sheet!.setCell(0, 0, "4");
    window.__sheet!.setCell(1, 0, "5");
    window.__sheet!.setCell(2, 0, "=SUM(A1:A2)");
  });
  await expect.poll(async () => pb.evaluate(() => window.__sheet!.display(2, 0))).toBe("9");
  await owner.close();
  await expect(pb.locator("#p2p-wait")).toBeVisible();
  await expect.poll(async () => pb.evaluate(() => window.__sheet!.role())).toBe("view");
  await guest.close();
});
