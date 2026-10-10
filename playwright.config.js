// Tests E2E : serveur statique local (sous-chemin /spare-part/ comme GitHub Pages), Chromium, mobile.
import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

const executablePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const PORT = 4173;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}/spare-part/`,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    serviceWorkers: 'block', // les tests dédiés au hors-ligne l'autorisent explicitement
    launchOptions: { executablePath },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: false, hasTouch: true } }],
  webServer: {
    command: 'node tests/serve.js',
    url: `http://127.0.0.1:${PORT}/spare-part/`,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT) },
  },
});
