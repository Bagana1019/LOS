import { defineConfig } from '@playwright/test';

// Хоёр горим:
//   pnpm --filter @los/web e2e          gateway-г mock хийсэн (backend хэрэггүй), `next dev`-ийг өөрөө асаана
//   E2E_LIVE=1 pnpm --filter @los/web e2e   ажиллаж буй бодит stack (web :3000, gateway :4000, seed) — docs/00-foundation.md §1
const live = process.env.E2E_LIVE === '1';
const port = live ? 3000 : 3100;

export default defineConfig({
  testDir: './e2e',
  // Модуль бүр `e2e/<нэр>.spec.ts` нэмнэ (gateway-г `mockGateway(page, { signedIn: true, role })`-оор дуурайна); live.spec.ts зөвхөн E2E_LIVE=1
  testMatch: '**/*.spec.ts',
  testIgnore: live ? /(?<!live)\.spec\.ts$/ : /live\.spec\.ts$/,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    locale: 'mn-MN',
    trace: 'retain-on-failure',
    // Урьдчилан суулгасан Chromium-г заавал ашиглах бол: PW_CHROMIUM_PATH=/opt/pw-browsers/chromium/chrome
    launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH || undefined },
  },
  webServer: live
    ? undefined
    : { command: `pnpm exec next dev -p ${port}`, url: `http://localhost:${port}/login`, reuseExistingServer: !process.env.CI, timeout: 180_000 },
});
