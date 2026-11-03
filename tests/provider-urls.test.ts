import { test } from "node:test";
import assert from "node:assert/strict";
import { providerUrlsFrom } from "../src/shared/person.ts";

test("providerUrlsFrom reads synapse-core 0.10 { items } and 0.4 { providers }", () => {
  assert.deepEqual(providerUrlsFrom({ items: [{ pdp: { serviceURL: "https://a" } }, { pdp: {} }] }), ["https://a"]);
  assert.deepEqual(providerUrlsFrom({ providers: [{ serviceURL: "https://b" }] }), ["https://b"]);
  assert.deepEqual(providerUrlsFrom(undefined), []);
});
