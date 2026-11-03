import assert from "node:assert/strict";
import { test } from "node:test";
import { identityUrl, parseIdentity } from "../src/shared/identity.ts";

const A = "0x3333333333333333333333333333333333333333";

test("parseIdentity accepts v1 docs for the owner only", () => {
  const doc = { v: 1, address: A, displayName: "  Andy  J ", avatar: { emoji: "🦊", color: "#1a73e8" } };
  assert.deepEqual(parseIdentity(doc, A), { address: A, displayName: "Andy J", avatar: { emoji: "🦊", color: "#1a73e8" } });
  assert.equal(parseIdentity(doc, "0x" + "4".repeat(40)), null);
  assert.equal(parseIdentity({ ...doc, v: 2 }), null);
  assert.equal(parseIdentity({ ...doc, displayName: "" }), null);
});

test("identityUrl points at the site's /identity/ page and returns to the doc", () => {
  const url = new URL(identityUrl("https://fifolders.scionbase.ai/fipen/?x=1#doc"));
  assert.equal(url.pathname, "/identity/");
  assert.equal(url.searchParams.get("return"), "https://fifolders.scionbase.ai/fipen/?x=1#doc");
});
