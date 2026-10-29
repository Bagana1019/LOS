import { mkdirSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import type { MerchantRole, MerchantStatus } from '@los/contracts';
import { makeProfile } from './fixtures';
import { guardConsole, MockApi } from './mock-api';

export const SCREEN_DIR = '/tmp/claude-0/web-screens';

/** Мерчант порталын суурь API (GET /me) + консол хамгаалалт. */
export async function setup(page: Page, opts: { role?: MerchantRole; status?: MerchantStatus } = {}) {
  const api = new MockApi();
  api.get('/merchant-portal/me', () => ({ json: makeProfile(opts) }));
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard };
}

/** Back-office хуудсуудад /me шаардлагагүй. */
export async function setupBackOffice(page: Page) {
  const api = new MockApi();
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard };
}

/** Хуудас хэвтээ гүйлгэгдэхгүй (320px–1440px) эсэх. Viewport-ийг дөнгөж өөрчилсөн бол (ResizeObserver-тэй график) тогтохыг хүлээнэ. */
export async function expectNoHorizontalScroll(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), { message: 'horizontal page scroll', timeout: 3000 })
    .toBeLessThanOrEqual(0);
}

export async function shot(page: Page, name: string) {
  mkdirSync(SCREEN_DIR, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SCREEN_DIR}/${name}.png`, fullPage: true });
}

/** Тест төгсгөлд: консолд алдаа/анхааруулга, шийдэгдээгүй API дуудлага байх ёсгүй. */
export function expectClean(guard: { problems: string[] }, api: MockApi) {
  expect(api.unhandled, 'unmocked API calls').toEqual([]);
  expect(guard.problems, 'console problems').toEqual([]);
}
