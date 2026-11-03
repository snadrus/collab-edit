#!/usr/bin/env node
/**
 * Install packages/fil-folders and packages/fiperson (FiPerson: names, identity, avatars) from snadrus/filecoin-folders at the pinned commit.
 * The monorepo root depends on `workspace:*`, which npm cannot install, so this
 * checks out only that package, builds dist/, and leaves it in node_modules.
 * The source is not committed in this repo.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const spec = pkg.externalGitDependencies?.["fil-folders"];
const match = typeof spec === "string" ? spec.match(/^git\+https:\/\/github\.com\/snadrus\/filecoin-folders\.git#([0-9a-f]{40})$/) : null;
if (!match) {
  console.error("package.json externalGitDependencies.fil-folders must be a pinned git+https URL");
  process.exit(1);
}
const COMMIT = match[1];
const REPO = "https://github.com/snadrus/filecoin-folders.git";
const EXPECTED_ADDRESS = "0x4893FfF3611240fbB4Be68eFe4AA0Ec634279331";
const EXPECTED_BLOCK = 4207373;

if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error("fil-folders needs Node.js 22+");
  process.exit(1);
}

const dest = path.join(root, "node_modules", "fil-folders");
const stamp = path.join(dest, ".commit");
const personDest = path.join(root, "node_modules", "fiperson");
const personStamp = path.join(personDest, ".commit");
const fresh = (s, file) => fs.existsSync(s) && fs.readFileSync(s, "utf8").trim() === COMMIT && fs.existsSync(file);
if (fresh(stamp, path.join(dest, "dist", "index.js")) && fresh(personStamp, path.join(personDest, "dist", "view", "index.js"))) {
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fil-folders-"));
try {
  execFileSync("git", ["clone", "--filter=blob:none", "--sparse", "--depth", "1", REPO, tmp], { stdio: "inherit" });
  execFileSync("git", ["sparse-checkout", "set", "packages/fil-folders", "packages/fiperson", "deployments"], { cwd: tmp, stdio: "inherit" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();
  if (head !== COMMIT) {
    execFileSync("git", ["fetch", "--depth", "1", "origin", COMMIT], { cwd: tmp, stdio: "inherit" });
    execFileSync("git", ["checkout", "--detach", COMMIT], { cwd: tmp, stdio: "inherit" });
  }
  const deployment = JSON.parse(fs.readFileSync(path.join(tmp, "deployments", "calibration.json"), "utf8"));
  if (deployment.address !== EXPECTED_ADDRESS || deployment.block !== EXPECTED_BLOCK) {
    throw new Error(`deployments/calibration.json is ${deployment.address} block ${deployment.block}`);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(path.join(tmp, "packages", "fil-folders"), dest, { recursive: true });
  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(tsc)) throw new Error("typescript is not installed");
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: dest, stdio: "inherit" });
  fs.writeFileSync(stamp, COMMIT + "\n");
  fs.rmSync(personDest, { recursive: true, force: true });
  fs.cpSync(path.join(tmp, "packages", "fiperson"), personDest, { recursive: true });
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: personDest, stdio: "inherit" });
  fs.writeFileSync(personStamp, COMMIT + "\n");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
