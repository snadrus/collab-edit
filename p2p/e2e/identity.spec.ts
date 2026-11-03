import { expect, test, type BrowserContext, type Page } from "playwright/test";

const WALLET = "0x3333333333333333333333333333333333333333";

/** Fake wallet (eth_accounts only) and a fresh cache entry so no chain read happens. */
async function setup(ctx: BrowserContext, identity: Record<string, unknown> | null): Promise<void> {
  await ctx.addInitScript(
    ({ addr, id }) => {
      (window as unknown as { ethereum: unknown }).ethereum = { request: async () => [addr] };
      localStorage.setItem("fil-identity:v1:" + addr, JSON.stringify({ identity: id, pieceCid: id ? "bafkzcibx" : "", version: id ? "1" : "0", checkedAt: Date.now() }));
    },
    { addr: WALLET, id: identity },
  );
}

/** The pixel art fills and centers in the round frame (inside its border). */
async function expectCentered(frame: import("playwright/test").Locator): Promise<void> {
  const box = await frame.evaluate((el) => {
    const o = el.getBoundingClientRect();
    const i = el.querySelector("svg")!.getBoundingClientRect();
    const b = parseFloat(getComputedStyle(el).borderTopWidth) || 0;
    return { dx: i.x + i.width / 2 - (o.x + o.width / 2), dy: i.y + i.height / 2 - (o.y + o.height / 2), w: i.width, inner: o.width - 2 * b };
  });
  expect(Math.abs(box.dx)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(box.dy)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(box.w - box.inner)).toBeLessThanOrEqual(0.5);
}

async function openDoc(page: Page): Promise<void> {
  await page.goto("/?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __editor?: { ready: boolean } }).__editor?.ready === true && location.hash.length > 1);
}

test("FiPen: no identity -> clicking your name opens 'Configure your identity' linking to /identity/ with a return URL", async ({ browser }) => {
  const ctx = await browser.newContext();
  await setup(ctx, null);
  const page = await ctx.newPage();
  await openDoc(page);
  await expect(page.locator("#name-btn")).toHaveText(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  // No emoji: your avatar is the wallet's deterministic pixel art.
  await expect(page.locator("#avatars .avatar.self svg.fiperson-pixel")).toHaveCount(1);
  await expectCentered(page.locator("#avatars .avatar.self"));
  await page.locator("#avatars .avatar.self").screenshot({ path: test.info().outputPath("fipen-avatar.png") });
  await page.locator("#name-btn").click();
  const pop = page.locator("#identity-pop");
  await expect(pop).toContainText("Configure your identity");
  await expect(pop).toContainText("saved on Filecoin");
  const href = await page.getByTestId("identity-pop-configure").getAttribute("href");
  const url = new URL(href!);
  expect(url.pathname).toBe(new URL("../identity/", page.url()).pathname);
  expect(url.searchParams.get("return")).toBe(page.url());
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  // Self avatar opens the same pop-up.
  await page.locator("#avatars .avatar.self").click();
  await expect(pop).toContainText("Configure your identity");
  await ctx.close();
});

test("FiPen: with identity -> name and avatar come from it; pop-up shows it with Edit", async ({ browser }) => {
  const ctx = await browser.newContext();
  await setup(ctx, { v: 1, schema: "fil-identity/profile", address: WALLET, displayName: "Andy Jackson", avatar: { emoji: "🦊", color: "#1a73e8" }, bio: "Hi", updatedAt: "2026-11-02T00:00:00Z" });
  const page = await ctx.newPage();
  await openDoc(page);
  await expect(page.locator("#name-btn")).toHaveText("Andy Jackson");
  await expect(page.locator("#avatars .avatar.self")).toHaveText("🦊");
  await page.locator("#name-btn").click();
  await expect(page.getByTestId("identity-pop-name")).toHaveText("Andy Jackson");
  await expect(page.getByTestId("identity-pop-edit")).toHaveAttribute("href", /\/identity\/\?return=/);
  await ctx.close();
});

test("FiPen: a peer sees the resolved identity name", async ({ browser }) => {
  const a = await browser.newContext();
  await setup(a, { v: 1, schema: "fil-identity/profile", address: WALLET, displayName: "Andy Jackson", updatedAt: "2026-11-02T00:00:00Z" });
  const pa = await a.newPage();
  await openDoc(pa);
  const b = await browser.newContext();
  const pb = await b.newPage();
  await pb.goto(pa.url());
  await pb.waitForFunction(() => (window as unknown as { __editor?: { ready: boolean } }).__editor?.ready === true);
  await expect(pb.locator('#avatars .avatar[title="Andy Jackson"]')).toHaveCount(1);
  await a.close();
  await b.close();
});

test("FiGrid: clicking your avatar opens the identity pop-up", async ({ browser }) => {
  const ctx = await browser.newContext();
  await setup(ctx, null);
  const page = await ctx.newPage();
  await page.goto("/sheets?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __sheet?: { ready: boolean } }).__sheet?.ready === true && location.hash.length > 1);
  await expect(page.locator("[data-testid=self-avatar] svg.fiperson-pixel")).toHaveCount(1);
  await expectCentered(page.getByTestId("self-avatar"));
  await page.getByTestId("self-avatar").click();
  await expect(page.locator("#identity-pop")).toContainText("Configure your identity");
  await ctx.close();
});

test("FiPen: wallet account switch renames you in place (no reload, no prompt); chain switch keeps the doc", async ({ browser }) => {
  const OTHER = "0x4444444444444444444444444444444444444444";
  const ctx = await browser.newContext();
  await ctx.addInitScript(
    ({ a, b }) => {
      const handlers: Record<string, ((v: unknown) => void)[]> = {};
      const w = window as unknown as Record<string, unknown>;
      w.__calls = [] as string[];
      w.ethereum = {
        request: async ({ method }: { method: string }) => ((w.__calls as string[]).push(method), [a]),
        on: (e: string, f: (v: unknown) => void) => ((handlers[e] ??= []).push(f)),
      };
      w.__emit = (e: string, v: unknown) => handlers[e]?.forEach((f) => f(v));
      for (const addr of [a, b])
        localStorage.setItem("fil-identity:v1:" + addr, JSON.stringify({ identity: addr === b ? { v: 1, schema: "fil-identity/profile", address: addr, displayName: "Switched Person", updatedAt: "2026-11-03T00:00:00Z" } : null, pieceCid: "", version: "0", checkedAt: Date.now() }));
    },
    { a: WALLET, b: OTHER },
  );
  const page = await ctx.newPage();
  await openDoc(page);
  const before = await page.locator("#name-btn").innerText();
  await page.evaluate(() => ((window as any).__marker = 1));
  await page.evaluate((b) => (window as any).__emit("accountsChanged", [b]), OTHER);
  await expect(page.locator("#name-btn")).not.toHaveText(before);
  expect(await page.evaluate(() => localStorage.getItem("fifolders:wallet") ?? Object.keys(localStorage).find((k) => localStorage.getItem(k) === "0x4444444444444444444444444444444444444444"))).toBeTruthy();
  await page.evaluate(() => (window as any).__emit("chainChanged", "0x13a"));
  expect(await page.evaluate(() => (window as any).__marker)).toBe(1); // no reload
  expect(await page.evaluate(() => (window as any).__calls.filter((m: string) => m === "eth_requestAccounts" || m.startsWith("eth_sign")).length)).toBe(0);
  await ctx.close();
});
