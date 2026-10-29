import { expect, test } from '@playwright/test';
import { expectClean, expectNoHorizontalScroll, setup, shot } from './helpers';
import { IDS, leaseId, makeLease, paged, sampleLeases, toListItem } from './fixtures';
import { apiError } from './mock-api';

// Лизингийн жагсаалт (URL-тай синк шүүлт, серверийн хуудаслалт) ба дэлгэрэнгүй (нууцалсан худалдан авагч, дүрийн нэртэй явц).

const items = sampleLeases().map(toListItem);

test.describe('Лизингийн жагсаалт', () => {
  test('filters come from the URL and are sent to the API; controls reflect them', async ({ page }) => {
    const { api, guard } = await setup(page, { role: 'MERCHANT_ADMIN' });
    api.get('/merchant-portal/leases', ({ search }) => ({ json: paged(items.slice(0, 2), Number(search.get('page') ?? 1), Number(search.get('pageSize') ?? 20), 2) }));
    await page.goto(`/merchant/leases?status=APPROVED,REFERRED&store=${IDS.storeB}&from=2026-10-01&to=2026-10-28&page=1`);

    await expect(page.getByRole('table', { name: 'Лизингүүд' })).toContainText('POS-261028-0007');
    const call = api.lastCall('GET', '/merchant-portal/leases')!;
    expect(call.search.get('status')).toBe('APPROVED,REFERRED');
    expect(call.search.get('storeId')).toBe(IDS.storeB);
    expect(call.search.has('q')).toBe(false);
    expect(call.search.get('from')).toBe('2026-10-01T00:00:00+08:00');
    expect(call.search.get('to')).toMatch(/^2026-10-28T23:59:59(\.\d+)?\+08:00$/);

    await expect(page.getByPlaceholder(/Лизингийн №, утасны/)).toHaveValue('');
    await expect(page.getByLabel('Эхлэх огноо')).toHaveValue('2026-10-01');
    await expect(page.getByLabel('Дуусах огноо')).toHaveValue('2026-10-28');
    await expect(page.locator('.ant-select-selection-item', { hasText: 'Зайсан салбар' })).toBeVisible();
    await expect(page.locator('.ant-select-selection-overflow-item').filter({ hasText: 'Батлагдсан' })).toBeVisible();
    expectClean(guard, api);
  });

  test('changing filters rewrites the URL (and resets the page); clear removes them all', async ({ page }) => {
    const { api, guard } = await setup(page);
    api.get('/merchant-portal/leases', ({ search }) => ({ json: paged(items, Number(search.get('page') ?? 1), Number(search.get('pageSize') ?? 20), 45) }));
    await page.goto('/merchant/leases?page=2');
    await expect(page.getByRole('table', { name: 'Лизингүүд' })).toContainText('POS-261028-0007');
    expect(api.lastCall('GET', '/merchant-portal/leases')!.search.get('page')).toBe('2');

    // төлөв сонгох -> URL, page шинэчлэгдэнэ
    await page.locator('.ant-select').filter({ has: page.locator('[aria-labelledby="f-status"]') }).click();
    await page.locator('.ant-select-item-option', { hasText: 'Татгалзсан' }).click();
    await expect(page).toHaveURL(/[?&]status=DECLINED(&|$)/);
    await expect(page).not.toHaveURL(/page=/);
    await expect.poll(() => api.lastCall('GET', '/merchant-portal/leases')!.search.get('status')).toBe('DECLINED');

    // хайлт (debounce) -> зөвхөн API-ийн `q`; URL-д хэзээ ч орохгүй (регистр/утас түүх, лог, Referer-т үлдэхгүй — POS-BR-7)
    await page.getByPlaceholder(/Лизингийн №, утасны/).fill('0007');
    await expect.poll(() => api.lastCall('GET', '/merchant-portal/leases')!.search.get('q')).toBe('0007');
    expect(page.url()).not.toMatch(/[?&]q=/);

    // огноо
    await page.getByLabel('Эхлэх огноо').fill('2026-10-20');
    await expect(page).toHaveURL(/[?&]from=2026-10-20(&|$)/);
    expect(page.url()).not.toMatch(/[?&]q=/);

    await page.getByRole('button', { name: 'Шүүлт цэвэрлэх' }).first().click();
    await expect(page).toHaveURL(/\/merchant\/leases$/);
    await expect(page.getByPlaceholder(/Лизингийн №, утасны/)).toHaveValue('');
    await expect.poll(() => api.lastCall('GET', '/merchant-portal/leases')!.search.has('q')).toBe(false);
    expectClean(guard, api);
  });

  test('search text is state only: sent as API q, never written to the URL; an old ?q= link is ignored; typing resets the page (n=7)', async ({ page }) => {
    const { api, guard } = await setup(page);
    // Хайлттай үед зөвхөн нэг мөр буцаана: цэвэрлэсний дараа бүтэн жагсаалт (кэшээс ч гэсэн) харагдах ёстой (хуудаслалт хэвээр)
    api.get('/merchant-portal/leases', ({ search }) => ({ json: paged(search.get('q') ? items.slice(0, 1) : items, Number(search.get('page') ?? 1), Number(search.get('pageSize') ?? 20), 45) }));

    // Хуучин хаяг (?q=регистр) орж ирсэн ч хайлт болгон хэрэглэхгүй, API-д дамжуулахгүй
    await page.goto('/merchant/leases?q=УЕ90051500&page=2');
    await expect(page.getByRole('table', { name: 'Лизингүүд' })).toContainText('POS-261028-0007');
    await expect(page.getByPlaceholder(/Лизингийн №, утасны/)).toHaveValue('');
    expect(api.lastCall('GET', '/merchant-portal/leases')!.search.has('q')).toBe(false);
    expect(api.lastCall('GET', '/merchant-portal/leases')!.search.get('page')).toBe('2');

    // Утасны дугаараар хайх: API-д очно, хаягийн мөрөнд ХЭЗЭЭ Ч гарахгүй, хуудас 1 рүү буцна
    await page.getByPlaceholder(/Лизингийн №, утасны/).fill('99112233');
    await expect.poll(() => api.lastCall('GET', '/merchant-portal/leases')!.search.get('q')).toBe('99112233');
    await expect.poll(() => api.lastCall('GET', '/merchant-portal/leases')!.search.get('page')).toBe('1');
    await expect(page).not.toHaveURL(/page=/);
    expect(page.url()).not.toMatch(/q=|99112233|%D0%A3%D0%95/i);
    // Хайлттай хүсэлт хэзээ ч хуучин хуудасны дугаартай явахгүй (илүү хүсэлт, хоосон төлөв анивчихгүй)
    expect(api.callsTo('GET', '/merchant-portal/leases').filter((c) => c.search.has('q') && c.search.get('page') !== '1').map((c) => c.search.toString())).toEqual([]);

    // Хуудас шилжүүлэхэд хайлт хадгалагдана (state), URL-д зөвхөн page
    await page.getByRole('listitem').filter({ hasText: /^2$/ }).click();
    await expect(page).toHaveURL(/[?&]page=2(&|$)/);
    await expect.poll(() => api.lastCall('GET', '/merchant-portal/leases')!.search.get('q')).toBe('99112233');
    expect(page.url()).not.toMatch(/q=|99112233/);

    // Хоосолбол q шууд арилна
    await page.getByPlaceholder(/Лизингийн №, утасны/).fill('');
    await expect.poll(() => api.lastCall('GET', '/merchant-portal/leases')!.search.has('q')).toBe(false);

    // 2-р хуудсан дээр хайлттай үед "Шүүлт цэвэрлэх" бүгдийг (page-ийг ч) арилгана; хуучин page-ийг URL руу буцааж бичихгүй
    await page.getByPlaceholder(/Лизингийн №, утасны/).fill('0007');
    await expect.poll(() => api.lastCall('GET', '/merchant-portal/leases')!.search.get('q')).toBe('0007');
    await page.getByRole('listitem').filter({ hasText: /^2$/ }).click();
    await expect(page).toHaveURL(/[?&]page=2(&|$)/);
    await page.getByRole('button', { name: 'Шүүлт цэвэрлэх' }).first().click();
    await expect(page).toHaveURL(/\/merchant\/leases$/);
    await page.waitForTimeout(600); // нэмэлт (race) дахин бичилт ирэхгүй гэдгийг шалгана
    await expect(page).toHaveURL(/\/merchant\/leases$/);
    await expect(page.getByPlaceholder(/Лизингийн №, утасны/)).toHaveValue('');
    await expect(page.getByRole('table', { name: 'Лизингүүд' })).toContainText('POS-261028-0006'); // хайлтаар шүүгдээгүй бүтэн жагсаалт
    expectClean(guard, api);
  });

  test('server pagination and row click opens the detail', async ({ page }) => {
    const { api, guard } = await setup(page);
    api.get('/merchant-portal/leases', ({ search }) => ({ json: paged(items, Number(search.get('page') ?? 1), Number(search.get('pageSize') ?? 20), 45) }));
    api.get('/merchant-portal/leases/:id', ({ params }) => ({ json: makeLease({ id: params.id, status: 'DELIVERED' }) }));
    await page.goto('/merchant/leases');
    await expect(page.getByText('Нийт 45')).toBeVisible();
    await page.getByRole('listitem').filter({ hasText: /^2$/ }).click();
    await expect(page).toHaveURL(/[?&]page=2(&|$)/);
    await expect.poll(() => api.lastCall('GET', '/merchant-portal/leases')!.search.get('page')).toBe('2');

    await page.getByRole('row', { name: /POS-261028-0006/ }).click();
    await expect(page).toHaveURL(new RegExp(`/merchant/leases/${leaseId(2)}$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Лизинг');
    expectClean(guard, api);
  });

  test('empty states: no leases vs. nothing matches the filter', async ({ page }) => {
    const { api, guard } = await setup(page);
    api.get('/merchant-portal/leases', () => ({ json: paged([]) }));
    await page.goto('/merchant/leases');
    await expect(page.getByText('Лизинг байхгүй')).toBeVisible();
    await page.goto('/merchant/leases?status=SETTLED');
    await expect(page.getByText('Тохирох лизинг олдсонгүй')).toBeVisible();
    expectClean(guard, api);
  });

  test('error state offers retry', async ({ page }) => {
    const { api } = await setup(page);
    let fail = true;
    api.get('/merchant-portal/leases', () => (fail ? apiError(500, 'VALIDATION_FAILED') : { json: paged(items) }));
    await page.goto('/merchant/leases');
    await expect(page.getByRole('alert').filter({ hasText: 'Алдаа гарлаа' })).toBeVisible();
    fail = false;
    await page.getByRole('button', { name: 'Дахин оролдох' }).click();
    await expect(page.getByRole('table', { name: 'Лизингүүд' })).toContainText('POS-261028-0007');
  });

  test('phone: card list, no horizontal scroll at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    const { api, guard } = await setup(page);
    api.get('/merchant-portal/leases', () => ({ json: paged(items, 1, 20, 45) }));
    await page.goto('/merchant/leases');
    await expect(page.getByRole('list', { name: 'Лизингүүд' })).toBeVisible();
    await expect(page.getByRole('link', { name: /POS-261028-0007/ })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, 'leases-phone');
    expectClean(guard, api);
  });
});

test.describe('Лизингийн дэлгэрэнгүй', () => {
  test('shows summary, breakdown, masked buyer and a role-only timeline', async ({ page }) => {
    const { api, guard } = await setup(page);
    const lease = makeLease({ id: leaseId(2), leaseNo: 'POS-261028-0006', status: 'DELIVERED', serialNo: 'SN-1234' });
    api.get('/merchant-portal/leases/:id', () => ({ json: lease }));
    await page.goto(`/merchant/leases/${lease.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('POS-261028-0006');
    const main = page.locator('main');
    await expect(main).toContainText('УЕ******01');
    await expect(main).toContainText('99****12');
    await expect(main).toContainText('SN-1234');
    await expect(main).toContainText('Мерчантад олгох дүн');
    // Явц: зөвхөн дүрийн нэр, хэрэглэгчийн ID биш
    const timeline = page.locator('.ant-timeline');
    await expect(timeline).toContainText('Мерчант');
    await expect(timeline).toContainText('Худалдан авагч');
    await expect(timeline).toContainText('Систем');
    await expect(main).not.toContainText(/u-1|u-9|MERCHANT:|LENDER:/);
    // Нөхцлийн дүн нь серверийн тооцоо
    await expect(main).toContainText(lease.quote.financedAmount.toLocaleString('en-US'));
    await expect(page.getByTestId('announce')).toContainText('Бараа хүлээлгэн өгсөн');
    await shot(page, 'lease-detail-delivered');
    expectClean(guard, api);
  });

  test('404 shows the friendly not-found state', async ({ page }) => {
    const { api } = await setup(page);
    api.get('/merchant-portal/leases/:id', apiError(404, 'NOT_FOUND'));
    await page.goto(`/merchant/leases/${leaseId(404)}`);
    await expect(page.getByText('Олдсонгүй').first()).toBeVisible();
  });
});
