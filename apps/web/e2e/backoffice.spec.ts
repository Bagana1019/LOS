import { expect, test, type Page } from '@playwright/test';
import { MerchantCreate, MerchantStatusChange } from '@los/contracts';
import { expectClean, expectNoHorizontalScroll, setupBackOffice, shot } from './helpers';
import { IDS, leaseId, makeAdminLease, makeMerchantView, makePlanView, makeStoreView, paged, toListItem } from './fixtures';
import { apiError, type MockApi } from './mock-api';

// Back-office: мерчант бүртгэл (/settings/merchants) ба POS лизингийн хяналт (/los/pos-leases).

const NEW_ID = '11111111-1111-4111-8111-1111111111ff';

async function pickOption(page: Page, selectLocatorHas: ReturnType<Page['locator']>, option: string) {
  await page.locator('.ant-select').filter({ has: selectLocatorHas }).click();
  await page.locator('.ant-select-item-option', { hasText: option }).click();
}

function installMerchantApi(api: MockApi, initial = makeMerchantView()) {
  const state = { merchant: initial };
  api.get('/merchants', ({ search }) => ({ json: paged([state.merchant, makeMerchantView({ id: NEW_ID, code: 'GAMEZONE', name: 'Гейм Зон ХХК', status: 'PENDING' })], Number(search.get('page') ?? 1), 20, 2) }));
  api.get('/merchants/:id', () => ({ json: state.merchant }));
  api.get('/merchants/:id/stores', () => ({ json: [makeStoreView(), makeStoreView({ id: IDS.storeB, code: 'UB-02', name: 'Зайсан салбар', isActive: false })] }));
  api.get('/pos-plans', () => ({
    json: [
      makePlanView(),
      makePlanView({ id: IDS.planGlobal, code: 'GLOBAL-STD', name: 'Стандарт глобал', merchantId: null }),
      makePlanView({ id: IDS.planGames, code: 'OTHER-SHOP', name: 'Өөр мерчантын хөтөлбөр', merchantId: '99999999-9999-4999-8999-999999999999' }),
    ],
  }));
  api.get('/pos-leases', () => ({ json: paged([toListItem(makeAdminLease({ id: leaseId(11), status: 'DELIVERED', leaseNo: 'POS-261028-0011' }))]) }));
  return state;
}

async function fillMerchantForm(page: Page) {
  await page.locator('#code').fill('newshop');
  await page.locator('#name').fill('Шинэ дэлгүүр ХХК');
  await page.locator('#branchId').fill('BR-UB-02');
  await page.locator('#contactName').fill('Бат Дорж');
  await page.locator('#phone').fill('99001122');
  await page.locator('#commissionRate').fill('2');
  await page.locator('#maxTicketAmount').fill('5000000');
  await page.locator('#settlement_bankCode').fill('khan');
  await page.locator('#settlement_accountNo').fill('5012345678');
  await page.locator('#settlement_holderName').fill('Шинэ дэлгүүр ХХК');
}

test.describe('Мерчант: жагсаалт ба бүртгэл', () => {
  test('list, status filter (URL) and search', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    installMerchantApi(api);
    await page.goto('/settings/merchants');
    const table = page.getByRole('table', { name: 'Мерчант' });
    await expect(table).toContainText('TECHMALL');
    await expect(table).toContainText('GAMEZONE');
    await expect(table).toContainText('Хүлээгдэж буй');

    await pickOption(page, page.locator('[aria-labelledby="m-status"]'), 'Идэвхтэй');
    await expect(page).toHaveURL(/[?&]status=ACTIVE(&|$)/);
    await expect.poll(() => api.lastCall('GET', '/merchants')!.search.get('status')).toBe('ACTIVE');

    await page.getByPlaceholder('Код, нэр, утас').fill('tech');
    await expect(page).toHaveURL(/[?&]q=tech(&|$)/);
    await expect.poll(() => api.lastCall('GET', '/merchants')!.search.get('q')).toBe('tech');
    await page.getByRole('button', { name: 'Шүүлт цэвэрлэх' }).click();
    await expect(page).toHaveURL(/\/settings\/merchants$/);
    await shot(page, 'backoffice-merchants');
    expectClean(guard, api);
  });

  test('create drawer validates, maps a duplicate code to the field, then creates and opens the detail', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    installMerchantApi(api);
    let attempt = 0;
    api.post('/merchants', ({ body }) => {
      attempt += 1;
      if (attempt === 1) return apiError(409, 'DUPLICATE_CODE');
      const parsed = MerchantCreate.parse(body);
      return { status: 201, json: makeMerchantView({ id: NEW_ID, code: parsed.code, name: parsed.name, status: 'PENDING' }) };
    });
    await page.goto('/settings/merchants');
    await page.getByRole('button', { name: 'Мерчант бүртгэх' }).first().click();
    const drawer = page.getByRole('dialog', { name: 'Мерчант бүртгэх' });
    await expect(drawer).toBeVisible();

    // Хоосон илгээхэд заавал талбарууд улаан
    await drawer.getByRole('button', { name: 'Бүртгэх' }).click();
    await expect(drawer.getByText('Код: A–Z, 0–9, "-" (2–32 тэмдэгт)').first()).toBeVisible();
    await expect(drawer.getByText('Утасны дугаар оруулна уу')).toBeVisible();
    await expect(drawer.getByText('Банкны код оруулна уу (2–16 тэмдэгт)')).toBeVisible();
    await expect(drawer.getByText('Дансны дугаар 6–20 цифр байх ёстой')).toBeVisible();
    expect(api.callsTo('POST', '/merchants')).toHaveLength(0);
    await shot(page, 'backoffice-merchant-drawer');

    await fillMerchantForm(page);
    await drawer.getByRole('button', { name: 'Бүртгэх' }).click();
    // 409 DUPLICATE_CODE -> кодын талбарт монгол мессеж
    await expect(drawer.getByText('Энэ код өмнө нь бүртгэгдсэн байна.')).toBeVisible();
    await page.locator('#code').fill('NEWSHOP2');
    await drawer.getByRole('button', { name: 'Бүртгэх' }).click();

    await expect(page).toHaveURL(new RegExp(`/settings/merchants/${NEW_ID}$`));
    const body = api.lastCall('POST', '/merchants')!.body;
    expect(body).toEqual({
      code: 'NEWSHOP2',
      name: 'Шинэ дэлгүүр ХХК',
      contactName: 'Бат Дорж',
      phone: '99001122',
      branchId: 'BR-UB-02',
      commissionRate: 0.02,
      maxTicketAmount: 5_000_000,
      dailyLimitAmount: null,
      settlement: { bankCode: 'KHAN', accountNo: '5012345678', holderName: 'Шинэ дэлгүүр ХХК' },
    });
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Шинэ дэлгүүр ХХК');
    expectClean(guard, api);
  });
});

test.describe('Мерчантын дэлгэрэнгүй', () => {
  test('info tab: masked account only; edit sends only changed fields', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    const state = installMerchantApi(api);
    api.patch('/merchants/:id', ({ body }) => {
      state.merchant = makeMerchantView({ name: (body as { name?: string }).name ?? state.merchant.name });
      return { json: state.merchant };
    });
    await page.goto(`/settings/merchants/${IDS.merchant}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Тех Молл ХХК');
    await expect(page.locator('.ant-descriptions')).toContainText('****4821');
    await expect(page.locator('body')).not.toContainText(/5012345678/);

    await page.getByRole('button', { name: 'Засах' }).click();
    const drawer = page.getByRole('dialog', { name: 'Мерчантын мэдээлэл засах' });
    await expect(drawer.locator('#code')).toBeDisabled();
    await drawer.locator('#name').fill('Тех Молл Плюс ХХК');
    await drawer.getByRole('button', { name: 'Хадгалах' }).click();
    await expect(drawer).toBeHidden();
    // Данс өөрчлөгдөөгүй тул settlement илгээгдэхгүй, зөвхөн name
    expect(api.lastCall('PATCH', '/merchants/:id')!.body).toEqual({ name: 'Тех Молл Плюс ХХК' });
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Тех Молл Плюс ХХК');
    expectClean(guard, api);
  });

  test('status change requires a reason and applies the new status', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    const state = installMerchantApi(api);
    api.post('/merchants/:id/status', ({ body }) => {
      const change = MerchantStatusChange.parse(body);
      state.merchant = makeMerchantView({ status: change.status });
      return { json: state.merchant };
    });
    await page.goto(`/settings/merchants/${IDS.merchant}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Идэвхтэй');

    await page.getByRole('button', { name: 'Төлөв өөрчлөх' }).click();
    const modal = page.getByRole('dialog', { name: 'Төлөв өөрчлөх' });
    await expect(modal).toContainText('Одоогийн төлөв: Идэвхтэй');
    await modal.getByRole('button', { name: 'Өөрчлөх' }).click();
    await expect(modal.getByText('Төлөв сонгоно уу')).toBeVisible();
    await expect(modal.getByText('Шалтгаанаа (дор хаяж 3 тэмдэгт) бичнэ үү')).toBeVisible();
    expect(api.callsTo('POST', '/merchants/:id/status')).toHaveLength(0);

    await modal.locator('.ant-select').click();
    await page.locator('.ant-select-item-option', { hasText: 'Түр түдгэлзүүлсэн' }).click();
    await modal.getByLabel('Шалтгаан').fill('Гэрээний нөхцөл зөрчсөн');
    await modal.getByRole('button', { name: 'Өөрчлөх' }).click();
    await expect(modal).toBeHidden();
    expect(api.lastCall('POST', '/merchants/:id/status')!.body).toEqual({ status: 'SUSPENDED', reason: 'Гэрээний нөхцөл зөрчсөн' });
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Түр түдгэлзүүлсэн');
    expectClean(guard, api);
  });

  test('terminated merchant cannot change status', async ({ page }) => {
    const { api } = await setupBackOffice(page);
    installMerchantApi(api, makeMerchantView({ status: 'TERMINATED' }));
    await page.goto(`/settings/merchants/${IDS.merchant}`);
    await expect(page.getByRole('button', { name: 'Төлөв өөрчлөх' })).toBeDisabled();
  });

  test('stores tab lists stores and creates one', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    installMerchantApi(api);
    api.post('/merchants/:id/stores', ({ body }) => ({ status: 201, json: makeStoreView({ code: (body as { code: string }).code, name: (body as { name: string }).name, id: IDS.storeB }) }));
    await page.goto(`/settings/merchants/${IDS.merchant}?tab=stores`);
    const table = page.getByRole('table', { name: 'Дэлгүүрүүд' });
    await expect(table).toContainText('Сүхбаатарын талбай салбар');
    await expect(table).toContainText('Идэвхгүй');
    await page.getByRole('button', { name: 'Дэлгүүр нэмэх' }).click();
    const modal = page.getByRole('dialog', { name: 'Дэлгүүр нэмэх' });
    await modal.getByRole('button', { name: 'Нэмэх' }).click();
    await expect(modal.getByText('Хаягийн дэлгэрэнгүйг оруулна уу (2–300 тэмдэгт)')).toBeVisible();
    await modal.locator('#code').fill('ub-03');
    await modal.locator('#name').fill('Налайх салбар');
    await modal.locator('#detail').fill('Налайх дүүрэг 2-р хороо');
    await modal.getByRole('button', { name: 'Нэмэх' }).click();
    await expect(modal).toBeHidden();
    const body = api.lastCall('POST', '/merchants/:id/stores')!.body as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'UB-03', name: 'Налайх салбар', address: { detail: 'Налайх дүүрэг 2-р хороо' }, isActive: true });
    expectClean(guard, api);
  });

  test('plans tab: advanced policy is collapsed and shows system defaults as placeholders', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    installMerchantApi(api);
    api.post('/pos-plans', ({ body }) => ({ status: 201, json: makePlanView({ id: IDS.planGames, code: (body as { code: string }).code, name: (body as { name: string }).name }) }));
    await page.goto(`/settings/merchants/${IDS.merchant}?tab=plans`);
    const table = page.getByRole('table', { name: 'Лизингийн хөтөлбөрүүд' });
    await expect(table).toContainText('LAPTOP');
    await expect(table).toContainText('Глобал');
    // GET /pos-plans бүгдийг буцаадаг — өөр мерчантын хөтөлбөр клиент талд шүүгдэнэ
    await expect(table).not.toContainText('OTHER-SHOP');

    await page.getByRole('button', { name: 'Хөтөлбөр нэмэх' }).click();
    const modal = page.getByRole('dialog', { name: 'Хөтөлбөр нэмэх' });
    const policy = modal.getByRole('button', { name: /Нарийвчилсан бодлого/ });
    await expect(policy).toHaveAttribute('aria-expanded', 'false');
    await policy.click();
    await expect(policy).toHaveAttribute('aria-expanded', 'true');
    await expect(modal.getByText(/Анхдагч:/).first()).toBeVisible();
    await shot(page, 'backoffice-plan-modal');

    await modal.getByRole('button', { name: 'Нэмэх' }).click();
    await expect(modal.getByText('Дор хаяж нэг ангилал сонгоно уу')).toBeVisible();
    expect(api.callsTo('POST', '/pos-plans')).toHaveLength(0);
    expectClean(guard, api);
  });

  test('leases tab lists the merchant leases and opens the internal drawer', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    installMerchantApi(api);
    api.get('/pos-leases/:id', ({ params }) => ({ json: makeAdminLease({ id: params.id, status: 'DELIVERED', leaseNo: 'POS-261028-0011' }) }));
    await page.goto(`/settings/merchants/${IDS.merchant}?tab=leases`);
    const row = page.getByRole('row', { name: /POS-261028-0011/ });
    await expect(row).toBeVisible();
    expect(api.lastCall('GET', '/pos-leases')!.search.get('merchantId')).toBe(IDS.merchant);
    await row.click();
    await expect(page.getByRole('dialog', { name: 'Лизинг POS-261028-0011' })).toBeVisible();
    expectClean(guard, api);
  });

  test('phone: merchant list and detail do not scroll horizontally at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    const { api, guard } = await setupBackOffice(page);
    installMerchantApi(api);
    await page.goto('/settings/merchants');
    await expect(page.getByRole('list', { name: 'Мерчант' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.goto(`/settings/merchants/${IDS.merchant}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Тех Молл ХХК');
    await expectNoHorizontalScroll(page);
    await shot(page, 'backoffice-merchant-phone');
    expectClean(guard, api);
  });
});

test.describe('POS лизингийн хяналт (лизингийн байгууллага)', () => {
  const referred = makeAdminLease({ id: leaseId(21), leaseNo: 'POS-261028-0021', status: 'REFERRED', decision: { publicReason: 'MANUAL_REVIEW' } });
  const delivered = makeAdminLease({ id: leaseId(22), leaseNo: 'POS-261028-0022', status: 'DELIVERED', reasons: [] });

  test('review tab loads REFERRED only; the drawer shows internal reasons and the lender can approve with a comment', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    const state = { lease: referred };
    api.get('/pos-leases', ({ search }) => ({ json: paged(search.get('status') === 'REFERRED' ? [toListItem(state.lease)] : []) }));
    api.get('/pos-leases/:id', () => ({ json: state.lease }));
    api.post('/pos-leases/:id/review', ({ body }) => {
      const b = body as { decision: 'APPROVE' | 'DECLINE'; comment: string };
      state.lease = makeAdminLease({ id: leaseId(21), leaseNo: 'POS-261028-0021', status: b.decision === 'APPROVE' ? 'APPROVED' : 'DECLINED', comment: b.comment, decision: { decidedBy: 'REVIEWER' } });
      return { json: state.lease };
    });

    await page.goto('/los/pos-leases');
    await expect(page.getByRole('tab', { name: 'Хянах шаардлагатай' })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => api.lastCall('GET', '/pos-leases')?.search.get('status')).toBe('REFERRED');
    await page.getByRole('row', { name: /POS-261028-0021/ }).click();

    const drawer = page.getByRole('dialog', { name: 'Лизинг POS-261028-0021' });
    // Дотоод мэдээлэл back-office-д л харагдана
    await expect(drawer.getByRole('list', { name: 'Дотоод шалтгаан' })).toContainText('Хянах');
    await expect(drawer).toContainText('58.3%');
    await expect(drawer).toContainText('Санал болгох доод урьдчилгаа');
    await expect(drawer).toContainText('УЕ******01');
    await expect(drawer).not.toContainText(/u-1|u-9|MERCHANT:|LENDER:/);
    await shot(page, 'backoffice-review-drawer');

    await drawer.getByRole('button', { name: 'Шийдвэр хадгалах' }).click();
    await expect(drawer.getByText('Шийдвэрээ сонгоно уу')).toBeVisible();
    await expect(drawer.getByText('Тайлбар заавал (дор хаяж 3 тэмдэгт)')).toBeVisible();
    expect(api.callsTo('POST', '/pos-leases/:id/review')).toHaveLength(0);

    await drawer.locator('.ant-radio-button-wrapper', { hasText: 'Батлах' }).click();
    await drawer.getByLabel('Тайлбар').fill('Орлогын баримт шалгагдсан');
    await drawer.getByRole('button', { name: 'Шийдвэр хадгалах' }).click();
    await expect.poll(() => api.lastCall('POST', '/pos-leases/:id/review')?.body).toEqual({ decision: 'APPROVE', comment: 'Орлогын баримт шалгагдсан' });
    await expect(drawer.getByText('Батлагдсан').first()).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Шийдвэр хадгалах' })).toHaveCount(0);
    await expect(drawer).toContainText('Орлогын баримт шалгагдсан');
    expectClean(guard, api);
  });

  test('settle tab: lender records the transfer reference', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    const state = { lease: delivered };
    api.get('/pos-leases', ({ search }) => ({ json: paged(search.get('status') === 'DELIVERED' ? [toListItem(state.lease)] : []) }));
    api.get('/pos-leases/:id', () => ({ json: state.lease }));
    api.post('/pos-leases/:id/settle', ({ body }) => {
      state.lease = makeAdminLease({ id: leaseId(22), leaseNo: 'POS-261028-0022', status: 'SETTLED', reasons: [], settlementRef: (body as { settlementRef: string }).settlementRef });
      return { json: state.lease };
    });

    await page.goto('/los/pos-leases?tab=settle');
    await expect.poll(() => api.lastCall('GET', '/pos-leases')?.search.get('status')).toBe('DELIVERED');
    await page.getByRole('row', { name: /POS-261028-0022/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Лизинг POS-261028-0022' });
    await expect(drawer.getByRole('heading', { name: 'Төлбөр шилжүүлэх' })).toBeVisible();
    await expect(drawer).toContainText('Шалтгаан бүртгэгдээгүй');

    await drawer.getByRole('button', { name: 'Төлбөр шилжүүлсэн гэж тэмдэглэх' }).click();
    await expect(drawer.getByText('Шилжүүлгийн лавлах дугаар оруулна уу (3–100 тэмдэгт)')).toBeVisible();
    expect(api.callsTo('POST', '/pos-leases/:id/settle')).toHaveLength(0);
    await drawer.getByLabel('Шилжүүлгийн лавлах дугаар').fill('TRF-2026-000123');
    await drawer.getByRole('button', { name: 'Төлбөр шилжүүлсэн гэж тэмдэглэх' }).click();
    await expect.poll(() => api.lastCall('POST', '/pos-leases/:id/settle')?.body).toEqual({ settlementRef: 'TRF-2026-000123' });
    await expect(drawer.getByText('Төлбөр шилжсэн').first()).toBeVisible();
    await expect(drawer).toContainText('TRF-2026-000123');
    await expect(drawer.getByRole('button', { name: 'Төлбөр шилжүүлсэн гэж тэмдэглэх' })).toHaveCount(0);
    expectClean(guard, api);
  });

  test('empty review queue', async ({ page }) => {
    const { api, guard } = await setupBackOffice(page);
    api.get('/pos-leases', () => ({ json: paged([]) }));
    await page.goto('/los/pos-leases');
    await expect(page.getByText('Хянах хүсэлт алга')).toBeVisible();
    expectClean(guard, api);
  });

  test('review conflict (INVALID_TRANSITION) is explained in Mongolian', async ({ page }) => {
    const { api } = await setupBackOffice(page);
    api.get('/pos-leases', () => ({ json: paged([toListItem(referred)]) }));
    api.get('/pos-leases/:id', () => ({ json: referred }));
    api.post('/pos-leases/:id/review', apiError(409, 'INVALID_TRANSITION'));
    await page.goto('/los/pos-leases');
    await page.getByRole('row', { name: /POS-261028-0021/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Лизинг POS-261028-0021' });
    await drawer.locator('.ant-radio-button-wrapper', { hasText: 'Татгалзах' }).click();
    await drawer.getByLabel('Тайлбар').fill('Орлого батлагдаагүй');
    await drawer.getByRole('button', { name: 'Шийдвэр хадгалах' }).click();
    await expect(drawer.getByRole('alert').filter({ hasText: 'Энэ үйлдлийг одоогийн төлөвт хийх боломжгүй' })).toBeVisible();
  });
});
