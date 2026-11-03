import { expect, test, type Page } from "playwright/test";
import { calculate } from "@filoz/synapse-core/piece";
import { privateKeyToAccount } from "viem/accounts";
import { type Hex } from "viem";

declare global {
  interface Window {
    __editor?: {
      ready: boolean;
      getText: () => string;
      insertText: (text: string) => void;
      forceText: (text: string) => void;
      role: () => string;
      signed: () => boolean;
      contentCid: () => string;
      signatures: () => { name: string; address: string; hash: string; signature: string; contentCid: string; verified: boolean }[];
      signatureBoxes: () => { page: number; x: number; y: number; w: number; h: number }[];
      signWithCid: (name: string, contentCid: string) => Promise<void>;
    };
    __p2p?: {
      exportFile: () => Promise<string>;
    };
    __eip1193Sign?: (raw: string) => Promise<string>;
    __mockUpload?: (b64: string) => Promise<string>;
    __mockDownload?: (cid: string) => Promise<string>;
    __synapseClient?: {
      storage: {
        upload: (data: Uint8Array) => Promise<{ pieceCid: string }>;
        download: (options: { pieceCid: string }) => Promise<Uint8Array>;
      };
    };
    ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
  }
}

const KEY_A = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const KEY_B = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const LOCK = "Signed, locked for edits";

async function signPayload(key: Hex, raw: string): Promise<string> {
  const data = JSON.parse(raw) as {
    domain: { name: string; version: string; chainId: number };
    types: { Document: { name: string; type: string }[] };
    message: {
      docId: string;
      contentHash: string;
      contentCid: string;
      signerName: string;
      signer: Hex;
      timestamp: string;
      chainId: string;
    };
  };
  const account = privateKeyToAccount(key);
  return account.signTypedData({
    domain: data.domain,
    types: { Document: data.types.Document },
    primaryType: "Document",
    message: {
      docId: data.message.docId,
      contentHash: data.message.contentHash,
      contentCid: data.message.contentCid,
      signerName: data.message.signerName,
      signer: data.message.signer,
      timestamp: BigInt(data.message.timestamp),
      chainId: BigInt(data.message.chainId),
    },
  });
}

async function installSynapse(page: Page, store: Map<string, string>, fail = false): Promise<void> {
  await page.exposeFunction("__mockUpload", async (b64: string) => {
    if (fail) throw new Error("upload failed");
    const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
    const cid = (await calculate(bytes)).toString();
    store.set(cid, b64);
    return cid;
  });
  await page.exposeFunction("__mockDownload", async (cid: string) => {
    const hit = store.get(cid);
    if (hit == null) throw new Error("missing " + cid);
    return hit;
  });
  await page.addInitScript(() => {
    const toBase64 = (data: Uint8Array): string => {
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < data.length; i += chunk) binary += String.fromCharCode(...data.subarray(i, i + chunk));
      return btoa(binary);
    };
    window.__synapseClient = {
      storage: {
        async upload(data: Uint8Array) {
          const cid = await window.__mockUpload!(toBase64(data));
          return { pieceCid: cid };
        },
        async download(options: { pieceCid: string }) {
          const b64 = await window.__mockDownload!(options.pieceCid);
          const bin = atob(b64);
          const out = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
          return out;
        },
      },
    };
  });
}

async function installWallet(page: Page, key: Hex): Promise<string> {
  const address = privateKeyToAccount(key).address;
  await page.exposeFunction("__eip1193Sign", (raw: string) => signPayload(key, raw));
  await page.addInitScript((addr: string) => {
    window.ethereum = {
      request: async (req) => {
        if (req.method === "eth_requestAccounts" || req.method === "eth_accounts") return [addr];
        if (req.method === "eth_chainId") return "0x13a";
        if (req.method === "eth_signTypedData_v4") {
          const params = req.params || [];
          return window.__eip1193Sign!(String(params[1]));
        }
        throw new Error(req.method);
      },
    };
  }, address);
  return address;
}

async function newDoc(page: Page): Promise<string> {
  await page.goto("/?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => window.__editor?.ready === true && location.hash.length > 1);
  return page.url();
}

async function signAs(page: Page, name: string): Promise<void> {
  await page.locator('[data-menu="insert"]').click();
  await page.locator('[data-act="signature"]').click();
  await page.locator("#sig-name").fill(name);
  await page.locator("#sig-sign").click();
}

test("two peers sign, lock, and show the gold signature", async ({ browser }) => {
  const owner = await browser.newContext();
  const guest = await browser.newContext();
  const pa = await owner.newPage();
  const pb = await guest.newPage();
  const addressA = await installWallet(pa, KEY_A);
  const addressB = await installWallet(pb, KEY_B);
  const pieces = new Map<string, string>();
  await installSynapse(pa, pieces);
  await installSynapse(pb, pieces);
  const url = await newDoc(pa);
  await pa.evaluate(() => window.__editor!.insertText("Hello. " + "This signed agreement has enough words to clear the Filecoin minimum piece size of one hundred twenty seven bytes. ".repeat(2)));
  await signAs(pa, "Ada Lovelace");

  await pb.goto(url);
  await pb.waitForFunction(() => window.__editor?.ready === true);
  for (const page of [pa, pb]) {
    await expect(page.locator("#sign-banner")).toHaveText(LOCK);
    await expect.poll(async () => page.evaluate(() => window.__editor!.signatures().length)).toBe(1);
    await expect.poll(async () => page.evaluate(() => window.__editor!.getText())).toContain("Hello");
  }
  const locked = await pb.evaluate(() => window.__editor!.getText());
  await pb.evaluate(() => window.__editor!.insertText("nope"));
  expect(await pb.evaluate(() => window.__editor!.getText())).toBe(locked);

  await signAs(pb, "Grace Hopper");
  for (const page of [pa, pb]) {
    await expect.poll(async () => page.evaluate(() => window.__editor!.signatures().length)).toBe(2);
    await expect(page.locator("#sign-banner")).toHaveText(LOCK);
  }
  const both = await pb.evaluate(() => window.__editor!.getText());
  expect(both).toContain("Hello");
  expect(both).not.toContain("nope");
  await pb.evaluate(() => window.__editor!.forceText("nope"));
  await expect.poll(async () => pb.evaluate(() => window.__editor!.getText())).toBe(both);
  await expect.poll(async () => pb.evaluate(() => window.__editor!.signatures().length)).toBe(2);

  const paint = await pa.evaluate(() => {
    const box = window.__editor!.signatureBoxes()[0];
    const canvas = document.querySelectorAll(".page")[box.page].querySelector("canvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    if (!ctx || !box) return null;
    const scale = canvas.width / canvas.clientWidth;
    const fill = ctx.getImageData(Math.floor((box.x + 3) * scale), Math.floor((box.y + box.h / 2) * scale), 1, 1).data;
    let border = false;
    const row = ctx.getImageData(Math.floor(box.x * scale), Math.floor((box.y + 1) * scale), Math.max(1, Math.floor(box.w * scale)), 2).data;
    for (let i = 0; i < row.length; i += 4) {
      const r = row[i];
      const g = row[i + 1];
      const b = row[i + 2];
      if (r > 140 && r > g && g > b && r - b > 40 && b < 180) border = true;
    }
    return { fill: [fill[0], fill[1], fill[2]], border, boxes: window.__editor!.signatureBoxes().length };
  });
  expect(paint).toBeTruthy();
  expect(paint!.boxes).toBe(2);
  expect(paint!.fill[0] - paint!.fill[2]).toBeGreaterThan(8);
  expect(paint!.border).toBe(true);
  expect(await pa.evaluate(async () => {
    await document.fonts.load('20px "Dancing Script"');
    return document.fonts.check('20px "Dancing Script"');
  })).toBe(true);

  const pos = await pa.evaluate(() => {
    const sigs = window.__editor!.signatures();
    const boxes = window.__editor!.signatureBoxes();
    const n = sigs.findIndex((item) => item.name === "Ada Lovelace");
    const box = boxes[n];
    const canvas = document.querySelectorAll(".page")[box.page].querySelector("canvas") as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + box.x + 8, y: rect.top + box.y + box.h / 2 };
  });
  await pa.mouse.click(pos.x, pos.y);
  await expect(pa.locator("#sig-verified")).toHaveText("Verified");
  const details = pa.locator("#sig-details");
  await expect(details).toContainText("Ada Lovelace");
  await expect(details).toContainText(addressA);
  await expect(details).toContainText("Filecoin mainnet (314)");
  const sig = await pa.evaluate(() => window.__editor!.signatures().find((item) => item.name === "Ada Lovelace")!);
  expect(sig.verified).toBe(true);
  expect(sig.address).toBe(addressA);
  await expect(details).toContainText(sig.hash);
  await expect(details).toContainText(sig.contentCid);
  await expect(details).toContainText(sig.signature);
  await expect(pa.locator("#sig-typed")).toContainText(sig.hash);
  await expect(pa.locator("#sig-typed")).toContainText(sig.contentCid);
  await expect(details.locator("button", { hasText: "Copy" })).toHaveCount(8);
  const second = await pa.evaluate(() => window.__editor!.signatures().find((item) => item.name === "Grace Hopper")!);
  expect(second.address).toBe(addressB);
  expect(second.verified).toBe(true);
  expect(second.contentCid).toBe(sig.contentCid);

  const cid = await pa.evaluate(() => window.__editor!.contentCid());
  const guestCid = await pb.evaluate(() => window.__editor!.contentCid());
  expect(cid).toBe(guestCid);
  expect(cid).not.toBe("unanchored");
  expect(cid.length).toBeGreaterThan(8);
  expect(sig.contentCid).toBe(cid);
  await pa.locator("#dialog-close").click();
  await pa.locator('[data-menu="file"]').click();
  await pa.locator('[data-act="verify-cid"]').click();
  await expect(pa.locator("#verify-cid")).toHaveValue(cid);
  await pa.locator("#verify-go").click();
  await expect(pa.locator("#verify-cid-match")).toHaveText("CID matches");
  await expect(pa.locator("#verify-signers")).toContainText("Ada Lovelace");
  await expect(pa.locator("#verify-signers")).toContainText("Grace Hopper");
  await expect(pa.locator("#verify-signers")).toContainText("Verified");
  await pa.locator("#dialog-close").click();

  const opened = new URL(pa.url());
  opened.searchParams.set("cid", cid);
  await pa.goto(opened.toString());
  await pa.waitForFunction(() => window.__editor?.ready === true && window.__editor.signatures().length === 2);
  await expect(pa.locator("#verify-cid-match")).toHaveText("CID matches");
  await expect(pa.locator("#verify-signers")).toContainText(addressA);
  await pa.locator("#dialog-close").click();

  await pa.evaluate(() => window.__editor!.signWithCid("Eve", "bafywrongcid"));
  await expect.poll(async () => pa.evaluate(() => window.__editor!.signatures().some((item) => item.name === "Eve"))).toBe(false);
  await expect.poll(async () => pa.evaluate(() => window.__editor!.signatures().length)).toBe(2);

  const raw = await pa.evaluate(() => window.__p2p!.exportFile());
  expect(raw).toContain("sig");
  expect(raw).toContain(addressA);
  expect(raw).toContain(addressB);
  expect(raw).toContain(cid);
  await pa.reload();
  await pa.waitForFunction(() => window.__editor?.ready === true && window.__editor.signatures().length === 2);
  await expect(pa.locator("#sign-banner")).toHaveText(LOCK);

  await owner.close();
  await guest.close();
});

test("a failed upload unfreezes the document", async ({ browser }) => {
  const owner = await browser.newContext();
  const page = await owner.newPage();
  await installWallet(page, KEY_A);
  await installSynapse(page, new Map(), true);
  await newDoc(page);
  await page.evaluate(() => window.__editor!.insertText("Hello. " + "This signed agreement has enough words to clear the Filecoin minimum piece size of one hundred twenty seven bytes. ".repeat(2)));
  await signAs(page, "Ada Lovelace");
  await expect(page.locator("#sig-sign")).toBeEnabled();
  await expect(page.locator("#toast")).toContainText("upload failed");
  await expect(page.locator("#sign-banner")).toBeHidden();
  expect(await page.evaluate(() => window.__editor!.contentCid())).toBe("");
  expect(await page.evaluate(() => window.__editor!.signed())).toBe(false);
  await page.evaluate(() => window.__editor!.insertText(" still"));
  await expect.poll(async () => page.evaluate(() => window.__editor!.getText())).toContain("still");
  await owner.close();
});
