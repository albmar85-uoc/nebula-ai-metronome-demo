import { defineConfig, devices } from "@playwright/test";

// E2E contra un servidor propio en :3100 (modo simulado, datos temporales en /tmp) con el Chrome ya instalado.
const PORT = Number(process.env.E2E_PORT ?? 3100);
const DATA_DIR = process.env.E2E_DATA_DIR ?? "/tmp/nebula-e2e-data";
export const ADMIN_PASSWORD = "e2e-support";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    trace: "retain-on-failure",
    launchOptions: { executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: undefined } },
  ],
  webServer: {
    command: `rm -rf ${DATA_DIR} && NEXT_DIST_DIR=.next-e2e npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/config`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { DATA_DIR, ADMIN_PASSWORD, METRONOME_LIVE: "0", MOCK_AUTO_PAYMENT_WEBHOOK: "1" },
  },
});
