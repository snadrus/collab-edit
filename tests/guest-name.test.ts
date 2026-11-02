import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADJECTIVES, ANIMALS, MersenneTwister, guestName, seedOf } from "../src/shared/guest-name.ts";

describe("guest names", () => {
  it("MT19937 matches the reference output for seed 5489", () => {
    const rng = new MersenneTwister(5489);
    assert.equal(rng.nextUint32(), 3499211612);
    assert.equal(rng.nextUint32(), 581869302);
  });
  it("same wallet gives the same name, case-insensitively", () => {
    const a = guestName("0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331");
    assert.equal(a, guestName("0x4893fff3611240fbb4be68efe4aa0ec634279331"));
    assert.match(a, /^[A-Z][a-z]+ [A-Z][a-z]+$/);
    assert.equal(seedOf("ABC"), seedOf("abc"));
  });
  it("different seeds spread over the lists", () => {
    const names = new Set(Array.from({ length: 200 }, (_, i) => guestName("browser-" + i)));
    assert.ok(names.size > 150);
    assert.ok(ADJECTIVES.length >= 100 && ANIMALS.length >= 100);
  });
});
