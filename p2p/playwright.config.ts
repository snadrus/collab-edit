import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "playwright/test";

const port = process.env.P2P_PORT || "8791";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  testDir: path.join(root, "p2p/e2e"),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "node scripts/install-fil-folders.mjs && node --disable-warning=ExperimentalWarning --experimental-strip-types p2p/serve.ts",
    cwd: root,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { ...process.env, PORT: port },
  },
});
