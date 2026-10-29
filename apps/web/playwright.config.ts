import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;

/**
 * Урьдчилан суулгасан chromium-ийн хувилбар Playwright-ийн хүлээж буйгаас өөр байж болно (`playwright install` ажиллуулахгүй).
 * Хүлээгдэж буй бинар байвал өөрийг нь хэрэглэнэ; үгүй бол PLAYWRIGHT_BROWSERS_PATH доторх headless shell / chromium-ийг олно.
 */
function findChromium(): string | undefined {
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    /* executablePath тодорхойлогдохгүй — доор хайна */
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const dirs = readdirSync(root).sort().reverse();
  const candidates = [
    ...dirs.filter((d) => d.startsWith('chromium_headless_shell-')).map((d) => join(root, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell')),
    ...dirs.filter((d) => /^chromium-\d+$/.test(d)).map((d) => join(root, d, 'chrome-linux64', 'chrome')),
  ];
  return candidates.find((c) => existsSync(c));
}

// e2e: бүх API дуудлага `page.route`-аар тосогдоно (e2e/mock-api.ts) — gateway/origination шаардлагагүй.
// Серверийг `next dev`-ээр асаана (reuseExistingServer). Хөтөч: зөвхөн chromium (урьдчилан суулгасан; `playwright install` ажиллуулахгүй).
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  // Trace/артефактыг репо-гийн гадна (git-д орохгүй).
  outputDir: join(tmpdir(), 'los-web-e2e-results'),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'mn-MN',
    timezoneId: 'Asia/Ulaanbaatar',
    trace: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 45_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 860 }, launchOptions: { executablePath: findChromium() } } }],
  webServer: {
    command: `pnpm exec next dev -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 180_000,
    env: { NEXT_PUBLIC_GATEWAY_URL: `${BASE_URL}/api`, NEXT_TELEMETRY_DISABLED: '1' },
  },
});
