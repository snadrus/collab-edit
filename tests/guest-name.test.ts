import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADJECTIVES, ANIMALS, guestName, pickDisplayName } from "fiperson/view";

describe("guest names come from FiPerson, unchanged", () => {
  it("golden outputs match the pre-FiPerson implementation", () => {
    assert.deepEqual(
      ["0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331", "0x0000000000000000000000000000000000000000", "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "0x2d633437f7E2138B400AF6882bee2d79C81CF401", "a1b2c3d4e5f6a1b2c3d4e5f6", ""].map(guestName),
      ["Upbeat Peacock", "Humble Puffin", "Sparkly Raccoon", "Genuine Cricket", "Genuine Frog", "Diligent Puffin"],
    );
    assert.equal(guestName("0x4893fff3611240fbb4be68efe4aa0ec634279331"), "Upbeat Peacock");
  });
  it("spreads and keeps precedence", () => {
    assert.ok(new Set(Array.from({ length: 200 }, (_, i) => guestName("browser-" + i))).size > 150);
    assert.ok(ADJECTIVES.length >= 100 && ANIMALS.length >= 100);
    assert.equal(pickDisplayName({ identityName: "Andy", sessionName: "S", wallet: "0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331" }), "Andy");
  });
});
