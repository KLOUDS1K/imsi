import { defineConfig } from '@playwright/test';

// Use Playwright's installed browser by default; optionally use a system browser.
const executablePath = process.env.PW_CHROMIUM || undefined;
// Each agent/dev can pick its own port: PW_PORT=5203 npx playwright test tests/e2e/engine
const port = Number(process.env.PW_PORT ?? 5173);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      executablePath,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
