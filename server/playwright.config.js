import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 3199);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'npm run start:e2e',
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 15_000,
    env: { E2E_PORT: String(port) }
  }
});
