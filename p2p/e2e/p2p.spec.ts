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

test("caret lands on empty lines and line starts after Enter and arrows", async ({ page }) => {
  await newDoc(page);
  const text = () => page.evaluate(() => window.__editor!.getText());
  await page.keyboard.type("abc");
  await page.keyboard.press("Enter");
  await page.keyboard.type("X");
  await page.keyboard.press("Home");
  await page.keyboard.type("H");
  expect(await text()).toBe("abc\nHX");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.type("E");
  expect(await text()).toBe("abc\nHX\nE\n");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("D");
  expect(await text()).toBe("abc\nHX\nE\nD");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await page.keyboard.type("R");
  expect(await text()).toBe("abc\n\nRHX\nE\nD");
});

test("outside sockets such as Nostr relays are real WebSockets", async ({ page }) => {
  await page.goto("/?wire=test");
  const native = await page.evaluate(() => {
    const ws = new WebSocket("wss://relay.example.invalid/");
    const ok = typeof (ws as WebSocket).addEventListener === "function" && ws.url.startsWith("wss://relay.example.invalid");
    ws.close();
    return ok;
  });
  expect(native).toBe(true);
});

test("FiFolders saves only on Save, Cmd+S, or the dirty-only autosave", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __p2pAutosaveMs: number }).__p2pAutosaveMs = 3000;
  });
  await page.goto("/?wire=test&fifolders=1&path=%2FFiPen%2Fnote.fipen&name=note.fipen");
  await page.waitForFunction(() => window.__editor?.ready === true);
  const status = page.locator("#status");
  const ops = () => page.evaluate(() => JSON.parse(localStorage.getItem("fifolders:ops") || "{}").ops || []);
  await expect(page.locator("#p2p-save")).toBeVisible();
  await expect(status).toHaveText("All changes saved");
  // Status and Save sit to the right of the title.
  const [title, save] = await Promise.all([page.locator("#title").boundingBox(), page.locator("#p2p-save").boundingBox()]);
  expect(save!.x).toBeGreaterThan(title!.x + title!.width - 1);
  await page.waitForTimeout(3500);
  expect(await ops()).toHaveLength(0);
  await page.evaluate(() => window.__editor!.insertText("hi"));
  await page.locator("#title").fill("Renamed note");
  await expect(status).toHaveText("Unsaved changes");
  expect(await ops()).toHaveLength(0);
  await page.keyboard.press("ControlOrMeta+s");
  const op = (await ops())[0];
  expect(op.kind).toBe("fel-save");
  expect(op.title).toBe("Renamed note");
  await expect(status).toHaveText("Saving…");
  await page.evaluate(() => localStorage.setItem("fifolders:ops", JSON.stringify({ v: 1, ops: [] })));
  await expect(status).toHaveText("Saved to Filecoin");
  await page.keyboard.press("ControlOrMeta+s");
  await page.waitForTimeout(3500);
  expect(await ops()).toHaveLength(0);
  await page.evaluate(() => window.__editor!.insertText("!"));
  await expect(status).toHaveText(/Unsaved changes|Saving…/);
  await expect.poll(async () => (await ops()).length, { timeout: 8000 }).toBe(1);
});

test("Share offers only Copy Link with the live document link", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const url = await newDoc(page);
  await page.locator("#share").click();
  const btn = page.getByRole("button", { name: "🔗 Copy Link" });
  await expect(btn).toBeVisible();
  await expect(page.getByText(/editor link|commenter link|viewer link/i)).toHaveCount(0);
  await btn.click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(copied).hash).toBe(new URL(url).hash);
  await ctx.close();
});

test("signing path loads all of its modules without 404s or import errors", async ({ page }) => {
  const bad: string[] = [];
  page.on("pageerror", (err) => bad.push("pageerror " + err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/WebSocket connection/.test(msg.text())) bad.push("console " + msg.text());
  });
  page.on("response", (res) => {
    if (res.status() >= 400 && res.url().startsWith("http://127.0.0.1")) bad.push(res.status() + " " + res.url());
  });
  await page.addInitScript(() => {
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: async ({ method }: { method: string }) => {
        if (method.endsWith("accounts") || method === "eth_requestAccounts") return ["0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331"];
        if (method === "eth_chainId") return "0x13a";
        throw new Error("wallet mock: " + method);
      },
    };
  });
  await newDoc(page);
  await page.evaluate(() => window.__editor!.insertText("sign me"));
  const outcome = await page.evaluate(async () => {
    const api = window.__p2p as unknown as { putUnsigned: (b: Uint8Array) => Promise<string>; pieceCidOf: (b: Uint8Array) => Promise<string> };
    const cid = await api.pieceCidOf(new TextEncoder().encode("x".repeat(256)));
    try {
      await api.putUnsigned(new TextEncoder().encode("x".repeat(256)));
      return cid + " | ok";
    } catch (err) {
      return cid + " | " + (err instanceof Error ? err.message : String(err));
    }
  });
  // The wallet mock refuses chain calls, so success means every chunk loaded and the SDK reached the wallet.
  expect(outcome).toMatch(/^bafkzcib/);
  expect(outcome).not.toMatch(/dynamically imported|Importing a module|was updated/);
  expect(bad).toEqual([]);
});
