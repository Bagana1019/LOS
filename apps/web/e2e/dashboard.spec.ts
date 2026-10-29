import { expect, test } from '@playwright/test';
import { apiError } from './mock-api';
import { IDS, leaseId, makeDashboard, makeLease } from './fixtures';
import { expectClean, expectNoHorizontalScroll, setup, shot } from './helpers';

test.describe('Merchant Dashboard', () => {
  test('renders greeting, todo links, KPIs, chart fallback table, limits and recent leases', async ({ page }) => {
    const { api, guard } = await setup(page);
    api.get('/merchant-portal/dashboard', () => ({ json: makeDashboard() }));
    api.get('/merchant-portal/leases/:id', (r) => ({ json: makeLease({ id: r.params.id!, status: 'APPROVED' }) }));
    await page.goto('/merchant');

    await expect(page.getByRole('heading', { level: 1, name: 'Сайн байна уу, Тех Молл ХХК' })).toBeVisible();
    // header: мерчант, дэлгүүр, дүр
    await expect(page.locator('.mp-head')).toContainText('Тех Молл ХХК');
    await expect(page.locator('.mp-head')).toContainText('Сүхбаатарын талбай салбар');
    await expect(page.locator('.mp-head')).toContainText('Кассир');

    // todo cards → шүүсэн жагсаалтын холбоос
    const todo = page.getByRole('region', { name: 'Хийх ажил' }).or(page.locator('section[aria-labelledby="todo-h"]'));
    await expect(todo.getByRole('link', { name: /Код хүлээж буй/ })).toHaveAttribute('href', '/merchant/leases?status=DRAFT');
    await expect(todo.getByRole('link', { name: /Санал хүлээн авах/ })).toHaveAttribute('href', '/merchant/leases?status=APPROVED');
    await expect(todo.getByRole('link', { name: /Хүлээлгэн өгөх/ })).toHaveAttribute('href', '/merchant/leases?status=ACCEPTED');
    await expect(todo.getByRole('link', { name: /Хянагдаж буй/ })).toHaveAttribute('href', '/merchant/leases?status=REFERRED');
    await expect(todo.getByRole('link', { name: /Хүлээлгэн өгөх/ })).toContainText('3');

    // KPI
    await expect(page.getByTestId('kpi-requests')).toContainText('40');
    await expect(page.getByTestId('kpi-approved')).toContainText('27');
    await expect(page.getByTestId('kpi-approved')).toContainText('67.5%');
    await expect(page.getByTestId('kpi-conversion')).toContainText('81.5%');
    await expect(page.getByTestId('kpi-decision')).toContainText('47 сек');
    await expect(page.getByTestId('kpi-decision')).toContainText('Зорилтод хүрсэн');
    await expect(page.getByTestId('kpi-financed')).toContainText('42,600,000₮');
    await expect(page.getByTestId('kpi-sales')).toContainText('55,200,000₮');
    await expect(page.getByTestId('kpi-commission')).toContainText('852,000₮');
    await expect(page.getByTestId('kpi-awaiting')).toContainText('11,480,000₮');
    await expect(page.getByTestId('kpi-settled')).toContainText('29,100,000₮');

    // график + хүртээмжтэй хүснэгт
    await expect(page.locator('.mp-chart svg').first()).toBeVisible();
    const table = page.getByRole('table', { name: 'Өдөр тутмын хүсэлт ба санхүүжилт' });
    await expect(table).toBeAttached();
    await page.getByRole('button', { name: 'Хүснэгтээр харах' }).click();
    await expect(table).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(8); // толгой + 7 өдөр
    await page.getByRole('button', { name: 'Графикаар харах' }).click();
    await expect(page.locator('.mp-chart svg').first()).toBeVisible();

    // лимит
    await expect(page.getByText('13,400,000₮ / 20,000,000₮')).toBeVisible();
    await expect(page.getByText('8,000,000₮').first()).toBeVisible();
    // дэлгүүр / хөтөлбөрөөр
    await expect(page.getByRole('table', { name: 'Дэлгүүрээр' })).toContainText('Зайсан салбар');
    await expect(page.getByRole('table', { name: 'Хөтөлбөрөөр' })).toContainText('LAPTOP');

    await shot(page, 'dashboard-desktop');

    // сүүлийн лизинг → дэлгэрэнгүй
    const recent = page.getByRole('table', { name: 'Сүүлийн лизингүүд' });
    await expect(recent).toContainText('POS-261028-0007');
    await recent.getByRole('link', { name: 'POS-261028-0007' }).click();
    await expect(page).toHaveURL(new RegExp(`/merchant/leases/${leaseId(1)}$`));

    expectClean(guard, api);
  });

  test('range switch refetches with a new "from" and store filter is only for MERCHANT_ADMIN', async ({ page }) => {
    const { api, guard } = await setup(page, { role: 'MERCHANT_ADMIN' });
    api.get('/merchant-portal/dashboard', () => ({ json: makeDashboard() }));
    await page.goto('/merchant');
    await expect(page.getByTestId('kpi-requests')).toBeVisible();
    await expect(page.locator('.mp-head')).toContainText('Мерчантын админ');

    const initial = api.lastCall('GET', '/merchant-portal/dashboard')!;
    expect(initial.search.get('storeId')).toBeNull();
    const from7 = initial.search.get('from')!;
    expect(from7).toMatch(/T00:00:00\+08:00$/);

    const range = page.getByRole('radiogroup').filter({ hasText: '30 хоног' });
    await range.getByText('30 хоног', { exact: true }).click();
    await expect.poll(() => api.lastCall('GET', '/merchant-portal/dashboard')!.search.get('from')).not.toBe(from7);
    // 30 хоногийн эхлэл 7 хоногийнхоос өмнө (UTC+8 өдрийн эхлэл)
    const from30 = api.lastCall('GET', '/merchant-portal/dashboard')!.search.get('from')!;
    expect(new Date(from30).getTime()).toBeLessThan(new Date(from7).getTime());
    await range.getByText('Өнөөдөр', { exact: true }).click();
    await expect.poll(() => api.lastCall('GET', '/merchant-portal/dashboard')!.search.get('from')?.slice(0, 10)).toBe(new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10));

    await page.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: 'Дэлгүүр' }) }).click();
    await page.locator('.ant-select-item-option', { hasText: 'Зайсан салбар' }).click();
    await expect.poll(() => api.lastCall('GET', '/merchant-portal/dashboard')!.search.get('storeId')).toBe(IDS.storeB);
    expectClean(guard, api);
  });

  test('open dashboard rolls its window over at Ulaanbaatar midnight (n=21): new "from" is requested and the date label changes', async ({ page }) => {
    // 2026-10-28 23:58 Улаанбаатар (UTC+8) = 15:58Z — шөнө дунд хүртэл 2 минут
    await page.clock.install({ time: new Date('2026-10-28T15:58:00Z') });
    const { api, guard } = await setup(page);
    api.get('/merchant-portal/dashboard', () => ({ json: makeDashboard() }));
    await page.goto('/merchant');
    await expect(page.getByTestId('kpi-requests')).toBeVisible();
    await expect(page.getByText('Өнөөдөр 2026-10-28')).toBeVisible();
    expect(api.lastCall('GET', '/merchant-portal/dashboard')!.search.get('from')).toBe('2026-10-22T00:00:00+08:00'); // 7 хоног: өнөөдөр + өмнөх 6 өдөр

    // Төхөөрөмж нээлттэй байх зуур шөнө дунд өнгөрнө (00:01 Улаанбаатар, 29-ний өдөр)
    await page.clock.fastForward('03:00');
    await expect(page.getByText('Өнөөдөр 2026-10-29')).toBeVisible();
    await expect.poll(() => api.lastCall('GET', '/merchant-portal/dashboard')!.search.get('from')).toBe('2026-10-23T00:00:00+08:00');

    // "Өнөөдөр" цонх мөн шинэ өдрийн эхлэлээс
    const range = page.getByRole('radiogroup').filter({ hasText: '30 хоног' });
    await range.getByText('Өнөөдөр', { exact: true }).click();
    await expect.poll(() => api.lastCall('GET', '/merchant-portal/dashboard')!.search.get('from')).toBe('2026-10-29T00:00:00+08:00');
    expectClean(guard, api);
  });

  test('staff has no store filter', async ({ page }) => {
    const { api, guard } = await setup(page);
    api.get('/merchant-portal/dashboard', () => ({ json: makeDashboard() }));
    await page.goto('/merchant');
    await expect(page.getByTestId('kpi-requests')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Дэлгүүр' })).toHaveCount(0);
    expectClean(guard, api);
  });

  test('shows skeleton while loading', async ({ page }) => {
    const { api, guard } = await setup(page);
    api.get('/merchant-portal/dashboard', () => ({ json: makeDashboard(), delayMs: 1500 }));
    await page.goto('/merchant');
    await expect(page.getByTestId('dashboard-skeleton')).toBeVisible();
    await expect(page.getByTestId('kpi-requests')).toBeVisible();
    await expect(page.getByTestId('dashboard-skeleton')).toHaveCount(0);
    expectClean(guard, api);
  });

  test('empty state: no leases yet', async ({ page }) => {
    const { api, guard } = await setup(page);
    api.get('/merchant-portal/dashboard', () => ({ json: makeDashboard({ empty: true }) }));
    await page.goto('/merchant');
    await expect(page.getByText('Лизинг байхгүй')).toBeVisible();
    await expect(page.getByTestId('kpi-requests')).toContainText('0');
    await expect(page.getByTestId('kpi-decision')).toContainText('Мэдээлэл алга');
    await expect(page.getByRole('link', { name: 'Шинэ лизинг' }).first()).toBeVisible();
    expectClean(guard, api);
  });

  test('slow decision time is flagged against the one-minute target', async ({ page }) => {
    const { api, guard } = await setup(page);
    api.get('/merchant-portal/dashboard', () => ({ json: makeDashboard({ avgDecisionSeconds: 95 }) }));
    await page.goto('/merchant');
    await expect(page.getByTestId('kpi-decision')).toContainText('1 мин 35 сек');
    await expect(page.getByTestId('kpi-decision')).toContainText('Зорилтоос удаан');
    expectClean(guard, api);
  });

  test('error state with retry', async ({ page }) => {
    const { api } = await setup(page);
    let fail = true;
    api.get('/merchant-portal/dashboard', () => (fail ? apiError(500, 'VALIDATION_FAILED') : { json: makeDashboard() }));
    await page.goto('/merchant');
    await expect(page.getByRole('alert').filter({ hasText: 'Алдаа гарлаа' })).toBeVisible();
    fail = false;
    await page.getByRole('button', { name: 'Дахин оролдох' }).click();
    await expect(page.getByTestId('kpi-requests')).toBeVisible();
  });

  test('401/403 shows the friendly no-access state', async ({ page }) => {
    const { api } = await setup(page);
    api.get('/merchant-portal/me', apiError(403, 'FORBIDDEN'));
    api.get('/merchant-portal/dashboard', apiError(403, 'FORBIDDEN'));
    await page.goto('/merchant');
    await expect(page.getByRole('alert').filter({ hasText: 'Хандах эрхгүй' })).toBeVisible();
  });

  test('phone layout: bottom tab bar, no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    const { api, guard } = await setup(page);
    api.get('/merchant-portal/dashboard', () => ({ json: makeDashboard() }));
    await page.goto('/merchant');
    await expect(page.getByTestId('kpi-requests')).toBeVisible();
    await expect(page.locator('.mp-tabbar')).toBeVisible();
    await expect(page.locator('.mp-side')).toBeHidden();
    await expectNoHorizontalScroll(page);
    await shot(page, 'dashboard-phone');
    await page.setViewportSize({ width: 320, height: 700 });
    await expectNoHorizontalScroll(page);
    expectClean(guard, api);
  });
});
