import { defineConfig } from '@playwright/test';

// Chromium is preinstalled in the cloud dev container at /opt/pw-browsers/chromium.
// Locally, delete `executablePath` (or set PW_CHROMIUM) to use Playwright's own browser.
const executablePath = process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      executablePath,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  webServer: {
    command: 'npx vite --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
