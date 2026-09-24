import { defineConfig } from '@playwright/test';

// Chromium is preinstalled in the cloud dev container at /opt/pw-browsers/chromium.
// Locally, delete `executablePath` (or set PW_CHROMIUM) to use Playwright's own browser.
const executablePath = process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium';
// Each agent/dev can pick its own port: PW_PORT=5203 npx playwright test tests/e2e/engine
const port = Number(process.env.PW_PORT ?? 5173);

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      executablePath,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
