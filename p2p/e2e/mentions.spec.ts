import { expect, test, type BrowserContext, type Page } from "playwright/test";

/* @-mentions with FiPerson: suggestions from cached club-mates, person chip, card, "Notify <name>?" sidebar, mock Slack. */

const ME = "0x3333333333333333333333333333333333333333";
const BEA = "0x5555555555555555555555555555555555555555";
const CARL = "0x6666666666666666666666666666666666666666";
const id = (address: string, displayName: string, extra: Record<string, unknown> = {}) => ({ v: 1, schema: "fil-identity/profile", address, displayName, updatedAt: "2026-11-02T00:00:00Z", ...extra });

async function setup(ctx: BrowserContext, opts: { clubs: boolean; token: boolean }): Promise<{ sent: { channel: string; text: string; token: string }[] }> {
  await ctx.addInitScript(
    ({ me, bea, carl, people, clubs, token }) => {
      (window as unknown as { ethereum: unknown }).ethereum = { request: async () => [me] };
      for (const p of people) localStorage.setItem("fil-identity:v1:" + p.address, JSON.stringify({ identity: p, pieceCid: "bafkzcibx", version: "1", checkedAt: Date.now() }));
      if (clubs)
        localStorage.setItem("fiperson:clubs:v1:" + me, JSON.stringify({ address: me, clubs: [{ id: "1", name: "Filecoin Builders", members: [me, bea, carl], admins: [bea], role: "member" }], coworkers: [bea, carl], checkedAt: Date.now() }));
      localStorage.setItem("fiperson:slack-client-id", "1111.2222");
      if (token) localStorage.setItem("fiperson:slack-tokens:v1", JSON.stringify({ T0MOCKACME: { team: "T0MOCKACME", user: "U0MOCKANDY", teamName: "Acme", domain: "acme", scope: "chat:write,im:write", plain: "xoxp-mock-andy", at: Date.now() } }));
    },
    {
      me: ME,
      bea: BEA,
      carl: CARL,
      clubs: opts.clubs,
      token: opts.token,
      people: [
        id(ME, "Andy Jackson"),
        id(BEA, "Beatrice Park", { bio: "Storage PM", avatar: { emoji: "🐙", color: "#1a73e8" }, notify: { preferred: "slack", contacts: [{ channel: "slack", team: "T0MOCKACME", user: "U0MOCKBEA", domain: "acme" }] } }),
        id(CARL, "Carl Brook", { notify: { preferred: "slack", contacts: [{ channel: "slack", team: "T0MOCKOTHER", user: "U0MOCKCARL", domain: "otherco" }] } }),
      ],
    },
  );
  // Mock Slack: simple form-encoded POSTs only (what real Slack accepts cross-origin), token in the body.
  const sent: { channel: string; text: string; token: string }[] = [];
  await ctx.route("https://slack.com/**", async (route) => {
    const req = route.request();
    const p = Object.fromEntries(new URLSearchParams(req.postData() || ""));
    const method = new URL(req.url()).pathname.split("/").pop();
    const ok = req.method() === "POST" && req.headers()["content-type"] === "application/x-www-form-urlencoded" && !req.headers()["authorization"];
    let body: Record<string, unknown> = { ok: false, error: ok ? "invalid_auth" : "mock_not_simple_request" };
    if (ok && p.token === "xoxp-mock-andy") {
      if (method === "conversations.open") body = p.users === "U0MOCKBEA" ? { ok: true, channel: { id: "D0BEA" } } : { ok: false, error: "user_not_found" };
      if (method === "chat.postMessage") {
        sent.push({ channel: p.channel!, text: p.text!, token: p.token });
        body = { ok: true, channel: p.channel, ts: "1.0" };
      }
    }
    await route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  });
  return { sent };
}

async function newDoc(page: Page): Promise<void> {
  await page.goto("/?wire=test");
  await page.locator("#blank").click();
  await page.waitForFunction(() => (window as unknown as { __editor?: { ready: boolean } }).__editor?.ready === true && location.hash.length > 1);
  await page.locator("#title").fill("Q4 storage plan");
  await page.locator("#pages .page").first().click({ position: { x: 200, y: 150 } });
}

const text = (page: Page) => page.evaluate(() => (window as unknown as { __editor: { getText: () => string } }).__editor.getText());

test("@ + letters suggests club-mates by FiPerson name; chip syncs; Notify sidebar sends via (mock) Slack only on approve", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const { sent } = await setup(ctx, { clubs: true, token: true });
  const page = await ctx.newPage();
  await newDoc(page);
  await page.keyboard.type("Thanks ", { delay: 35 });
  await page.keyboard.type("@be", { delay: 90 });
  const menu = page.locator("#at-menu");
  await expect(menu).toBeVisible();
  const first = menu.locator(".at-item").first();
  await expect(first).toContainText("Beatrice Park");
  await expect(first).toContainText("Filecoin Builders");
  await expect(first.locator(".at-avatar img")).toHaveCount(1);
  await page.screenshot({ path: "/workspace/mention-suggest.png" });
  await page.keyboard.press("Enter");
  await page.keyboard.type(" for the review.", { delay: 30 });
  const st = await page.evaluate(() => {
    const e = (window as unknown as { __editor: { getText: () => string; styleAt: (i: number) => Record<string, unknown> } }).__editor;
    const i = e.getText().indexOf("\uFFFC");
    return e.styleAt(i);
  });
  expect(st).toMatchObject({ embed: "person", label: "Beatrice Park", addr: BEA });
  expect(await text(page)).toContain("Thanks \uFFFC for the review.");

  // Sidebar offers to notify; nothing was sent automatically.
  const panel = page.locator("#notify-panel");
  await expect(panel).toContainText("Notify Beatrice Park?");
  await expect(panel).toContainText("Slack (acme)");
  expect(sent).toHaveLength(0);
  const msg = page.getByTestId("notify-message");
  await expect(msg).toHaveValue("I mentioned you in “Q4 storage plan”");
  await msg.click();
  await page.keyboard.type(" — can you check the costs?", { delay: 25 });
  await page.screenshot({ path: "/workspace/mention-notify-sidebar.png" });
  await page.getByTestId("notify-send").click();
  await expect(panel).toContainText("Sent to Beatrice Park on Slack.");
  expect(sent).toEqual([{ channel: "D0BEA", token: "xoxp-mock-andy", text: `I mentioned you in “Q4 storage plan” — can you check the costs?\n${page.url()}` }]);
  await page.locator("#pages").screenshot({ path: "/workspace/mention-chip.png", clip: undefined }).catch(() => {});
  await page.getByTestId("notify-dismiss").click().catch(() => {});

  // Clicking the chip opens their card; the card links to the /person/ page.
  await page.evaluate(() => {
    const e = (window as unknown as { __editor: { getText: () => string; setSelection: (a: number, h: number) => void } }).__editor;
    const i = e.getText().indexOf("\uFFFC");
    e.setSelection(i, i);
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const caret = await page.evaluate(() => {
    const r = document.querySelector(".local-caret:not(.drop-caret)")!.getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2 };
  });
  // Human-like: move onto the chip's name, then click.
  await page.mouse.move(caret.x + 10, caret.y + 30);
  await page.mouse.move(caret.x + 40, caret.y, { steps: 6 });
  await page.mouse.down();
  await page.mouse.up();
  const card = page.getByTestId("person-card");
  await expect(card).toContainText("Beatrice Park");
  await expect(card).toContainText("Storage PM");
  await expect(card).toContainText("Filecoin Builders");
  await expect(page.getByTestId("person-card-view")).toHaveAttribute("href", `${new URL(page.url()).origin}/person/?id=${BEA}`);
  await page.screenshot({ path: "/workspace/mention-card.png" });
  await page.keyboard.press("Escape");

  // Another workspace: Notify opens Connect Slack preselecting Carl's workspace; the sender signs in to acme
  // instead (a stand-in callback page reports that), so it is explained with a copy fallback and nothing is sent.
  await ctx.route("**/slack/callback/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<script>const q=new URLSearchParams(location.search);localStorage.setItem("fiperson:slack-result:"+q.get("state"),JSON.stringify({state:q.get("state"),ok:true,team:"T0MOCKACME"}));document.write("team="+q.get("team"));setTimeout(()=>close(),300)</script>`,
    }),
  );
  await page.keyboard.press("End");
  await page.keyboard.type(" cc @car", { delay: 70 });
  await expect(page.locator("#at-menu .at-item").first()).toContainText("Carl Brook");
  await page.keyboard.press("Enter");
  await expect(panel).toContainText("Notify Carl Brook?");
  const pop = page.waitForEvent("popup");
  await page.getByTestId("notify-send").click();
  expect(new URL((await pop).url()).searchParams.get("team")).toBe("T0MOCKOTHER");
  await expect(panel).toContainText("otherco.slack.com");
  await expect(panel).toContainText("acme.slack.com");
  expect(sent).toHaveLength(1);
  await page.screenshot({ path: "/workspace/mention-other-workspace.png" });
  await ctx.close();
});

test("the chip syncs to a peer and saves in the doc", async ({ browser }) => {
  const a = await browser.newContext();
  await setup(a, { clubs: true, token: false });
  const pa = await a.newPage();
  await newDoc(pa);
  await pa.keyboard.type("@bea", { delay: 60 });
  await pa.keyboard.press("Enter");
  await expect(pa.locator("#notify-panel")).toBeVisible();
  const b = await browser.newContext();
  const pb = await b.newPage();
  await pb.goto(pa.url());
  await pb.waitForFunction(() => (window as unknown as { __editor?: { ready: boolean; getText: () => string } }).__editor?.getText().includes("\uFFFC"));
  const st = await pb.evaluate(() => {
    const e = (window as unknown as { __editor: { getText: () => string; styleAt: (i: number) => Record<string, unknown> } }).__editor;
    return e.styleAt(e.getText().indexOf("\uFFFC"));
  });
  expect(st).toMatchObject({ embed: "person", label: "Beatrice Park", addr: BEA });
  await pa.reload();
  await pa.waitForFunction(() => (window as unknown as { __editor?: { ready: boolean; getText: () => string } }).__editor?.getText().includes("\uFFFC"));
  await a.close();
  await b.close();
});

test("first Notify opens Connect Slack (PKCE popup at /slack/callback/?start=1&team=…); closing it sends nothing", async ({ browser }) => {
  const ctx = await browser.newContext();
  await setup(ctx, { clubs: true, token: false });
  await ctx.route("**/slack/callback/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<p>callback</p>" }));
  const page = await ctx.newPage();
  await newDoc(page);
  await page.keyboard.type("@beat", { delay: 60 });
  await page.keyboard.press("Enter");
  const popupP = page.waitForEvent("popup");
  await page.getByTestId("notify-send").click();
  const popup = await popupP;
  const u = new URL(popup.url());
  expect(u.pathname).toBe("/slack/callback/");
  expect(u.searchParams.get("start")).toBe("1");
  expect(u.searchParams.get("team")).toBe("T0MOCKACME");
  await popup.close();
  await expect(page.locator("#notify-panel")).toContainText("Slack was not connected");
  await ctx.close();
});

test("no club-mates cached: '@' offers 'Find my club-mates' linking to FiPerson", async ({ browser }) => {
  const ctx = await browser.newContext();
  await setup(ctx, { clubs: false, token: false });
  const page = await ctx.newPage();
  await newDoc(page);
  await page.keyboard.type("@", { delay: 50 });
  const item = page.locator("#at-menu .at-item").first();
  await expect(item).toContainText("Find my club-mates");
  await page.screenshot({ path: "/workspace/mention-find-clubmates.png" });
  const popupP = page.waitForEvent("popup");
  await item.click();
  const popup = await popupP;
  expect(new URL(popup.url()).pathname).toBe("/identity/");
  expect(new URL(popup.url()).hash).toBe("#clubs");
  await ctx.close();
});

test("an @ with no matches doesn't keep the menu shut: the next @ (even on a new line) suggests again", async ({ browser }) => {
  const ctx = await browser.newContext();
  await setup(ctx, { clubs: true, token: false });
  const page = await ctx.newPage();
  await newDoc(page);
  const menu = page.locator("#at-menu");
  await page.keyboard.type("x @zzz", { delay: 40 });
  await expect(menu).toBeHidden();
  await page.keyboard.press("Enter");
  await page.keyboard.type("@car", { delay: 60 });
  await expect(menu).toBeVisible();
  await expect(menu.locator(".at-item").first()).toContainText("Carl Brook");
  await page.keyboard.press("Escape");
  await page.keyboard.type(" and @be", { delay: 60 });
  await expect(menu.locator(".at-item").first()).toContainText("Beatrice Park");
});
