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
  await page.getByTestId("self-avatar").click();
  await expect(page.locator("#identity-pop")).toContainText("Configure your identity");
  await ctx.close();
});
