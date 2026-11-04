import { expect, test, type BrowserContext, type Page } from "playwright/test";

/**
 * Regression: a wallet extension's Proxy around window.ethereum breaks the Proxy invariant for a frozen,
 * non-configurable `on`, so reading `ethereum.on` throws "'get' on proxy: property 'on' is a read-only and
 * non-configurable data property...". That threw inside mountEditor and the guest saw a blank editor.
 */
const HOSTILE = () => {
  const target = Object.freeze({
    isMetaMask: true,
    on(_e: string, _f: unknown) {
      return target;
    },
    removeListener() {},
    request: async ({ method }: { method: string }) => (method === "eth_chainId" ? "0x4cb2f" : []),
  });
  const proxy = new Proxy(target, {
    get(t, key, recv) {
      const v = Reflect.get(t, key, recv);
      // Returns a different function than the frozen one: violates the invariant and throws on access.
      return typeof v === "function" ? function (this: unknown, ...a: unknown[]) { return (v as (...x: unknown[]) => unknown).apply(this, a); } : v;
    },
  });
  Object.defineProperty(window, "ethereum", { value: proxy, configurable: false, writable: false });
  // EIP-6963 announces the same hostile provider.
  window.addEventListener("eip6963:requestProvider", () => {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info: { uuid: "x", name: "Hostile", icon: "", rdns: "test.hostile" }, provider: proxy }) }));
  });
  (window as unknown as { __hostileThrows?: boolean }).__hostileThrows = (() => {
    try {
      void proxy.on;
      return false;
    } catch (err) {
      return String(err).includes("non-configurable");
    }
  })();
};

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { __editor?: { ready: boolean } }).__editor?.ready === true);
}
const text = (page: Page) => page.evaluate(() => (window as unknown as { __editor: { getText: () => string } }).__editor.getText());

for (const mode of ["hostile", "none"] as const) {
  test(`guest sees the owner's typing with ${mode === "hostile" ? "a hostile Proxy window.ethereum" : "no wallet"}`, async ({ browser }) => {
    const errors: string[] = [];
    const ctx = async (): Promise<BrowserContext> => {
      const c = await browser.newContext();
      if (mode === "hostile") await c.addInitScript(HOSTILE);
      return c;
    };
    const owner = await ctx();
    const guest = await ctx();
    const pa = await owner.newPage();
    const pb = await guest.newPage();
    for (const p of [pa, pb]) p.on("pageerror", (e) => errors.push(e.message));
    await pa.goto("/?wire=test");
    await pa.locator("#blank").click();
    await pa.waitForFunction(() => location.hash.length > 1);
    await ready(pa);
    if (mode === "hostile") expect(await pa.evaluate(() => (window as unknown as { __hostileThrows?: boolean }).__hostileThrows)).toBe(true);
    await pb.goto(pa.url());
    await ready(pb);
    await pa.locator("#pages").click();
    await pa.keyboard.type("Hello from owner", { delay: 20 });
    await expect.poll(() => text(pb)).toContain("Hello from owner");
    await pb.locator("#pages").click();
    await pb.keyboard.press("End");
    await pb.keyboard.type(" and guest", { delay: 20 });
    await expect.poll(() => text(pa)).toContain("and guest");
    if (mode === "hostile") await expect(pb.locator("#wallet-notice")).toBeVisible();
    expect(errors.filter((e) => /proxy|ethereum|wallet/i.test(e))).toEqual([]);
    await owner.close();
    await guest.close();
  });
}

test("old-format share link (/v/<id>) opens the document, not a blank page", async ({ browser }) => {
  const owner = await browser.newContext();
  const guest = await browser.newContext();
  const pa = await owner.newPage();
  await pa.goto("/?wire=test");
  await pa.locator("#blank").click();
  await pa.waitForFunction(() => location.hash.length > 1);
  await ready(pa);
  await pa.locator("#pages").click();
  await pa.keyboard.type("Legacy link", { delay: 20 });
  const url = new URL(pa.url());
  const spa = url.searchParams.get("spa") || url.pathname;
  const id = spa.match(/\/d\/([^/?#]+)/)![1];
  if (url.searchParams.get("spa")) url.searchParams.set("spa", "/v/" + id);
  else url.pathname = url.pathname.replace(/\/d\/[^/]+/, "/v/" + id);
  const pb = await guest.newPage();
  await pb.goto(url.toString());
  await ready(pb);
  await expect.poll(() => text(pb)).toContain("Legacy link");
  await owner.close();
  await guest.close();
});
