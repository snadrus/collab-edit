import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADJECTIVES, ANIMALS, Xoshiro128pp, pickIndex, guestName, seedOf } from "../src/shared/guest-name.ts";

describe("guest names", () => {
  it("xoshiro128++ matches the reference C output for state 1,2,3,4", () => {
    const rng = new Xoshiro128pp([1, 2, 3, 4]);
    assert.deepEqual([rng.nextUint32(), rng.nextUint32(), rng.nextUint32(), rng.nextUint32()], [641, 1573767, 3222811527, 3517856514]);
  });
  it("never runs from an all-zero state and is deterministic per seed", () => {
    assert.notEqual(new Xoshiro128pp([0, 0, 0, 0]).nextUint32(), 0);
    const a = Xoshiro128pp.fromSeed(42);
    const b = Xoshiro128pp.fromSeed(42);
    for (let i = 0; i < 5; i++) assert.equal(a.nextUint32(), b.nextUint32());
  });
  it("rejection sampling redraws above the limit and stays deterministic", () => {
    const n = ADJECTIVES.length;
    const limit = 2 ** 32 - (2 ** 32 % n);
    const draws = [0xffffffff, limit, 7];
    let calls = 0;
    assert.equal(pickIndex(() => draws[calls++], n), 7 % n);
    assert.equal(calls, 3);
    assert.equal(pickIndex(() => limit - 1, n), (limit - 1) % n);
    const run = () => {
      const rng = Xoshiro128pp.fromSeed(seedOf("0xabc"));
      return Array.from({ length: 20 }, () => pickIndex(() => rng.nextUint32(), n));
    };
    assert.deepEqual(run(), run());
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
