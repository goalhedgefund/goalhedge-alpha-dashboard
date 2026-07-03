import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
  },
  webServer: [
    {
      // Demo gateway: full M7 pipeline looping a scripted trade every ~15s.
      command: 'npm run build -w @scalper/core && node core/dist/demo/demo-gateway.js',
      cwd: '..',
      port: 8787,
      reuseExistingServer: true,
      timeout: 180_000,
    },
    {
      command: 'npm run dev',
      port: 5173,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
