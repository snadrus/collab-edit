import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:8787",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:8787",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { ...process.env, PORT: "8787", DATA_DIR: "data/e2e" },
  },
});
