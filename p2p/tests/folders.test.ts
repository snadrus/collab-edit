import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSupportedRuntime, openVolume } from "fil-folders";
import {
  CALIBRATION_FROM_BLOCK,
  CALIBRATION_REGISTRY,
  FELANUMIO_DIR,
  FELARUMI_DIR,
  FIGRID_DIR,
  FIPEN_DIR,
  NO_REGISTRY_NOTICE,
  VOLUME_NAME,
  listSnapshots,
  memoryVolumeParts,
  openCalibrationVolume,
  registryFor,
  saveSnapshot,
  snapshotPath,
  volumeHistory,
} from "../src/folder-save.ts";

const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("filecoin folders", () => {
  it("keeps mainnet on the session head and calibration on the deployed registry", () => {
    assert.equal(registryFor("mainnet"), null);
    assert.equal(NO_REGISTRY_NOTICE, "no registry on this network");
    const calibration = registryFor("calibration");
    assert.equal(calibration?.address, CALIBRATION_REGISTRY);
    assert.equal(calibration?.address, "0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331");
    assert.equal(calibration?.fromBlock, CALIBRATION_FROM_BLOCK);
    assert.equal(calibration?.fromBlock, 4207373n);
    assert.equal(VOLUME_NAME, "default");
    assert.doesNotThrow(() => assertSupportedRuntime());
  });

  it("saves docs and sheets on volume default and reads them back", async () => {
    assert.equal(snapshotPath("felarumi", "My/Doc"), "/FiPen/My Doc.fipen");
    assert.equal(snapshotPath("felanumio", ""), "/FiGrid/Untitled.figrid");
    const { storage, registry } = memoryVolumeParts(OWNER);
    const doc = new TextEncoder().encode('{"kind":"felarumi-p2p","contentCid":"bafyunsigned"}');
    const book = new TextEncoder().encode('{"kind":"felanumio-p2p"}');
    const saved = await saveSnapshot({ kind: "felarumi", title: "Notes", bytes: doc, owner: OWNER, storage, registry });
    const sheet = await saveSnapshot({ kind: "felanumio", title: "Budget", bytes: book, owner: OWNER, storage, registry });
    assert.equal(saved.path, "/FiPen/Notes.fipen");
    assert.equal(sheet.path, "/FiGrid/Budget.figrid");
    assert.equal(saved.version, 1n);
    assert.equal(sheet.version, 2n);
    assert.notEqual(saved.rootCid, sheet.rootCid);
    assert.equal(registry.commits, 2);

    const volume = await openCalibrationVolume({ storage, registry, owner: OWNER });
    assert.equal(volume.name, VOLUME_NAME);
    const docs = await listSnapshots(volume, FIPEN_DIR);
    const sheets = await listSnapshots(volume, FIGRID_DIR);
    assert.deepEqual(await listSnapshots(volume, FELARUMI_DIR), []);
    assert.deepEqual(await listSnapshots(volume, FELANUMIO_DIR), []);
    assert.deepEqual(docs.map((entry) => entry.path), [saved.path]);
    assert.deepEqual(sheets.map((entry) => entry.path), [sheet.path]);
    assert.equal(new TextDecoder().decode(await volume.get(saved.path)), new TextDecoder().decode(doc));
    assert.equal(new TextDecoder().decode(await volume.get(sheet.path)), new TextDecoder().decode(book));

    const history = await volumeHistory(volume);
    assert.equal(history.length, 2);
    assert.equal(history[0]?.version, 1n);
    assert.equal(history[1]?.version, 2n);
    assert.equal(history[1]?.pieceCid, sheet.rootCid);
    const noteHistory = await volumeHistory(volume, saved.path);
    assert.equal(noteHistory.length, 1);
    assert.equal(noteHistory[0]?.change, "added");

    const revised = new TextEncoder().encode('{"kind":"felarumi-p2p","contentCid":"bafyunsigned","rev":2}');
    const again = await saveSnapshot({ kind: "felarumi", title: "Notes", bytes: revised, owner: OWNER, storage, registry });
    assert.equal(again.version, 3n);
    assert.equal(new TextDecoder().decode(await volume.get(saved.path)), new TextDecoder().decode(revised));
    const updated = await volumeHistory(volume, saved.path);
    assert.equal(updated.at(-1)?.change, "updated");
  });

  it("lists an empty folder as no files", async () => {
    const { storage, registry } = memoryVolumeParts(OWNER);
    const volume = await openVolume({ storage, registry, owner: OWNER, name: VOLUME_NAME });
    assert.deepEqual(await listSnapshots(volume, FIPEN_DIR), []);
    assert.deepEqual(await listSnapshots(volume, FIGRID_DIR), []);
    assert.deepEqual(await listSnapshots(volume, FELARUMI_DIR), []);
    assert.deepEqual(await listSnapshots(volume, FELANUMIO_DIR), []);
    assert.deepEqual(await volumeHistory(volume), []);
  });
});
