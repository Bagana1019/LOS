import { expect, test, type Page } from '@playwright/test';
import type { CustomerPage, CustomerSummary } from '@los/contracts';
import { expectNoHorizontalScroll } from './helpers';
import { guardConsole, MockApi } from './mock-api';

// F12-6: харилцагчийн жагсаалт жижиг дэлгэцэд (360px) уншигдахуйц — хуудас хажуу тийш гүйхгүй, хүснэгт өөрөө гүйлгэгдэж, утас харагдана. gateway mock-той.

const PHONE = '99112233';

const customer = (n: number): CustomerSummary => ({
  id: `c-${n}`, customerType: 'INDIVIDUAL', registerNoMasked: `УБ9001${String(n).padStart(4, '0')}`, lastName: 'Дашдорж', firstName: `Номин${n}`,
  phone: n === 1 ? PHONE : null, isPep: false, isRelatedParty: false, blacklisted: n === 2, createdAt: '2026-11-01T03:00:00.000Z',
});
const LIST: CustomerPage = { items: [customer(1), customer(2), customer(3)], total: 3, page: 1, pageSize: 20 };

async function openList(page: Page, role: 'OFFICER' | 'ADMIN' = 'OFFICER') {
  const api = new MockApi(role);
  await api.install(page);
  const guard = guardConsole(page);
  api.on('GET', '/customers', { json: LIST });
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/customer');
  await expect(page.getByRole('link', { name: customer(1).registerNoMasked })).toBeVisible();
  return { api, guard };
}

/** Хүснэгтийн гүйлгэх хэсэг: контейнерээс өргөн контент нь зөвхөн энд гүйнэ. */
const tableBody = (page: Page) => page.locator('.ant-table-content, .ant-table-body').first();

test.describe('F12-6: харилцагчийн жагсаалт 360px-д', () => {
  test('the page itself does not scroll sideways', async ({ page }) => {
    await openList(page);
    await expectNoHorizontalScroll(page);
  });

  test('the primary action stays visible inside the viewport', async ({ page }) => {
    await openList(page, 'OFFICER');
    const add = page.getByTestId('create-customer');
    await expect(add).toBeVisible();
    const box = await add.boundingBox();
    expect(box, 'create button box').not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  });

  test('the table scrolls on its own, so the phone column can be reached instead of being cut off', async ({ page }) => {
    await openList(page);
    const phone = page.getByText(PHONE);
    await phone.scrollIntoViewIfNeeded();
    expect(await tableBody(page).evaluate((el) => el.scrollLeft), 'the table scrolled sideways inside its own box').toBeGreaterThan(0);
    await expect(phone).toBeInViewport({ ratio: 1 });
    const covered = await phone.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !top || !(el === top || el.contains(top) || top.contains(el));
    });
    expect(covered, 'the phone cell is not hidden behind the pinned register column').toBe(false);
  });

  test('the first column (register, which opens the customer) stays pinned while the table is scrolled', async ({ page }) => {
    await openList(page);
    const link = page.getByRole('link', { name: customer(1).registerNoMasked });
    const body = tableBody(page);
    await body.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    expect(await body.evaluate((el) => el.scrollLeft), 'the table scrolled sideways inside its own box').toBeGreaterThan(0);
    await expect(link).toBeInViewport({ ratio: 1 });
  });
});
