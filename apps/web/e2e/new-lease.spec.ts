import { expect, test, type Page } from '@playwright/test';
import type { PosLeaseStatus, PosLeaseView } from '@los/contracts';
import { PosQuoteRequest } from '@los/contracts';
import { expectClean, expectNoHorizontalScroll, setup, shot } from './helpers';
import { IDS, leaseId, makeDashboard, makeLease, makeLeaseWithOtp, makeOtp, makeQuote, paged, toListItem } from './fixtures';
import { apiError, type MockApi } from './mock-api';

// Шинэ лизинг (POS-FR-1..) ба удирдамжтай урсгал: котировка -> үүсгэх -> зөвшөөрлийн OTP -> шийдвэр -> хүлээн зөвшөөрөх OTP -> хүлээлгэн өгөх.

const LEASE_ID = leaseId(900);
const REGISTER = 'УБ12345678';
const PHONE = '99112233';

/** Лизингийн серверийн төлөвийг дуурайх (нэг тестэд нэг). */
function installLeaseServer(api: MockApi, opts: { onSubmit?: PosLeaseStatus; down?: number } = {}) {
  const state = { lease: makeLease({ id: LEASE_ID, leaseNo: 'POS-261028-0900', status: 'DRAFT', price: 1_500_000, down: opts.down ?? 450_000, term: 12 }) as PosLeaseView };
  const set = (o: Parameters<typeof makeLease>[0]) => {
    state.lease = makeLease({ id: LEASE_ID, leaseNo: 'POS-261028-0900', price: 1_500_000, down: opts.down ?? 450_000, term: 12, ...o });
    return state.lease;
  };
  api.post('/merchant-portal/quotes', ({ body }) => {
    const req = PosQuoteRequest.parse(body);
    return { json: makeQuote({ planCode: req.planCode, goodsPrice: req.goodsPrice, downPayment: req.downPayment, termMonths: req.termMonths }) };
  });
  api.post('/merchant-portal/leases', () => ({ status: 201, json: makeLeaseWithOtp(state.lease) }));
  api.get('/merchant-portal/leases/:id', () => ({ json: state.lease }));
  api.post('/merchant-portal/leases/:id/submit', ({ body }) => {
    const code = (body as { otp?: string }).otp;
    if (code === '000000') return apiError(422, 'OTP_INVALID', { attemptsLeft: 2 });
    const status = opts.onSubmit ?? 'APPROVED';
    return {
      json: set({
        status,
        decision: status === 'DECLINED' ? { publicReason: 'AFFORDABILITY', suggestedMinDownPayment: 900_000 } : status === 'REFERRED' ? { publicReason: 'MANUAL_REVIEW' } : undefined,
      }),
    };
  });
  api.post('/merchant-portal/leases/:id/otp/accept', () => ({ json: makeOtp('ACCEPT') }));
  api.post('/merchant-portal/leases/:id/accept', () => ({ json: set({ status: 'ACCEPTED' }) }));
  api.post('/merchant-portal/leases/:id/deliver', ({ body }) => ({ json: set({ status: 'DELIVERED', serialNo: (body as { serialNo?: string }).serialNo ?? null }) }));
  api.post('/merchant-portal/leases/:id/cancel', ({ body }) => ({ json: set({ status: 'CANCELLED', cancelReason: (body as { reason: string }).reason }) }));
  // Идэвхтэй query-г шинэчлэх үед дуудагдаж болох жагсаалт, самбар.
  api.get('/merchant-portal/leases', () => ({ json: paged([toListItem(state.lease)]) }));
  api.get('/merchant-portal/dashboard', () => ({ json: makeDashboard() }));
  return { state, set };
}

async function pickOption(page: Page, label: string, option: string) {
  await page.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: label }) }).click();
  await page.locator('.ant-select-item-option', { hasText: option }).click();
}

async function typeOtp(page: Page, code: string) {
  await page.getByLabel('Кодын 1-р орон').click();
  await page.keyboard.type(code);
}

/** Хоёр хөтөлбөртэй профайлаас LAPTOP-ыг сонгож, барааны/нөхцөлийн талбаруудыг бөглөнө. */
async function fillTerms(page: Page, o: { price?: string; shortcut?: '20%' | '30%' | '50%' } = {}) {
  await pickOption(page, 'Лизингийн хөтөлбөр', 'Компьютер, утас 6–24 сар');
  await pickOption(page, 'Барааны ангилал', 'Компьютер, зөөврийн компьютер');
  await page.getByLabel('Барааны нэр, загвар').fill('Lenovo IdeaPad 3 15"');
  await page.getByLabel('Барааны үнэ').fill(o.price ?? '1500000');
  await page.getByRole('group', { name: 'Урьдчилгааны товчлол' }).getByRole('button', { name: o.shortcut ?? '30%' }).click();
  await page.locator('.ant-radio-button-wrapper', { hasText: '12 сар' }).click();
}
async function fillBuyer(page: Page) {
  await page.getByLabel('Регистрийн дугаар').fill(REGISTER);
  await page.getByLabel('Утасны дугаар').fill(PHONE);
}

test.describe('Шинэ лизинг', () => {
  test('happy path: quote -> create -> consent OTP -> approved -> accept OTP -> deliver', async ({ page }) => {
    const { api, guard } = await setup(page);
    installLeaseServer(api);

    await page.goto('/merchant/leases/new');
    await expect(page.getByRole('heading', { name: 'Шинэ лизинг', level: 1 })).toBeVisible();
    await expect(page.getByTestId('quote-card')).toContainText('Үнэ, урьдчилгаа, хугацаагаа оруулбал');

    await fillTerms(page);
    // Доод урьдчилгааны хувь зөвхөн харуулалт; 30% товч нь зөвхөн оролтын товчлол.
    await expect(page.getByText('Доод урьдчилгаа: 10%')).toBeVisible();
    await expect(page.getByLabel('Урьдчилгаа', { exact: true })).toHaveValue('450,000');

    // Debounce-той котировка: хүсэлт бие даасан нэг дуудлага, дүн нь серверийн хариунаас
    const expected = makeQuote({ goodsPrice: 1_500_000, downPayment: 450_000, termMonths: 12 });
    await expect(page.getByTestId('quote-monthly')).toContainText(expected.monthlyPayment.toLocaleString('en-US'));
    expect(api.callsTo('POST', '/merchant-portal/quotes').length).toBeLessThanOrEqual(3);
    expect(api.lastCall('POST', '/merchant-portal/quotes')!.body).toEqual({ planCode: 'LAPTOP', goodsCategory: 'COMPUTER', goodsPrice: 1_500_000, downPayment: 450_000, termMonths: 12 });

    await fillBuyer(page);
    await expect(page.getByText('Худалдан авагчийн зөвшөөрөл')).toBeVisible();
    await page.getByRole('button', { name: 'Код илгээж үргэлжлүүлэх' }).click();

    // Үүсгэх: Idempotency-Key + зөв бие
    await expect(page).toHaveURL(new RegExp(`/merchant/leases/${LEASE_ID}\\?flow=1$`));
    const create = api.lastCall('POST', '/merchant-portal/leases')!;
    expect(create.headers['idempotency-key']).toMatch(/^[0-9a-f-]{16,}$/i);
    expect(create.body).toEqual({
      planCode: 'LAPTOP',
      goods: { category: 'COMPUTER', name: 'Lenovo IdeaPad 3 15"', price: 1_500_000 },
      downPayment: 450_000,
      termMonths: 12,
      buyer: { registerNo: REGISTER, phone: PHONE },
    });

    // Зөвшөөрлийн OTP: 6 дахь оронд автомат илгээнэ
    await expect(page.getByRole('heading', { name: 'Худалдан авагчийн зөвшөөрлийн код' })).toBeVisible();
    await expect(page.getByText('99****12').first()).toBeVisible();
    await typeOtp(page, '123456');
    await expect.poll(() => api.lastCall('POST', '/merchant-portal/leases/:id/submit')?.body).toEqual({ otp: '123456' });

    // Батлагдсан санал
    await expect(page.getByRole('heading', { name: 'Лизинг батлагдлаа' })).toBeVisible();
    await expect(page.getByTestId('offer-monthly')).toContainText(expected.monthlyPayment.toLocaleString('en-US'));
    await expect(page.getByText(/Санал хүчинтэй: \d+:\d{2}/)).toBeVisible();
    await expect(page.getByTestId('announce')).toContainText('Лизинг батлагдлаа');
    await page.getByRole('button', { name: 'Баталгаажуулах' }).click();

    // Хүлээн зөвшөөрөх OTP
    await expect(page.getByRole('heading', { name: 'Нөхцөл хүлээн зөвшөөрөх код' })).toBeVisible();
    await typeOtp(page, '654321');
    await expect.poll(() => api.lastCall('POST', '/merchant-portal/leases/:id/accept')?.body).toEqual({ otp: '654321' });

    // Хүлээлгэн өгөх (серийн дугаартай)
    await expect(page.getByRole('heading', { name: 'Худалдан авагч нөхцөлийг баталгаажууллаа' })).toBeVisible();
    await page.getByLabel('Серийн дугаар (заавал биш)').fill('SN-778899');
    await page.getByRole('button', { name: 'Барааг хүлээлгэн өгсөн' }).click();
    await expect.poll(() => api.lastCall('POST', '/merchant-portal/leases/:id/deliver')?.body).toEqual({ serialNo: 'SN-778899' });
    await expect(page.getByRole('heading', { name: 'Бараа хүлээлгэн өгсөн' })).toBeVisible();
    await expect(page.getByTestId('announce')).toContainText('Бараа хүлээлгэн өгсөн');
    await expectNoHorizontalScroll(page);
    expectClean(guard, api);
  });

  test('wrong consent code shows the remaining attempts and clears the field', async ({ page }) => {
    const { api, guard } = await setup(page);
    installLeaseServer(api);
    await page.goto(`/merchant/leases/${LEASE_ID}`);
    await expect(page.getByRole('heading', { name: 'Худалдан авагчийн зөвшөөрлийн код' })).toBeVisible();
    await typeOtp(page, '000000');
    await expect(page.getByRole('alert').filter({ hasText: 'Код буруу байна. Үлдсэн оролдлого: 2.' })).toBeVisible();
    // Талбар цэвэрлэгдэж, дахин оруулахад бэлэн
    await expect(page.getByLabel('Кодын 1-р орон')).toHaveValue('');
    // Дахин илгээх хүлээлтийн тоологч
    await expect(page.getByRole('button', { name: /Дахин илгээх|Код дахин илгээх/ })).toBeVisible();
    expect(guard.problems.filter((p) => !/status of 422|Failed to load resource/.test(p))).toEqual([]);
    expect(api.unhandled).toEqual([]);
  });

  test('DECLINED shows only the public reason and a retry CTA prefilled with the suggested down payment', async ({ page }) => {
    const { api, guard } = await setup(page);
    installLeaseServer(api, { onSubmit: 'DECLINED' });

    await page.goto('/merchant/leases/new');
    await fillTerms(page);
    await fillBuyer(page);
    await page.getByRole('button', { name: 'Код илгээж үргэлжлүүлэх' }).click();
    await expect(page).toHaveURL(new RegExp(`/merchant/leases/${LEASE_ID}`));
    await typeOtp(page, '123456');

    await expect(page.getByRole('heading', { name: 'Энэ удаад лизинг олгох боломжгүй байна' })).toBeVisible();
    const reason = page.getByTestId('public-reason');
    await expect(reason).toHaveText('Сарын төлбөр худалдан авагчийн төлбөрийн чадамжид тохироогүй байна.');
    // Дотоод шалтгаан (DTI, ЗМС, blacklist) хэзээ ч харагдахгүй
    await expect(page.locator('main')).not.toContainText(/DTI|BLACKLIST|ЗМС-ийн|скор|score/i);
    await shot(page, 'decision-declined');

    const retry = page.getByRole('link', { name: 'Урьдчилгааг 900,000₮ болгож дахин оролдох' });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(page).toHaveURL(/\/merchant\/leases\/new\?/);
    await expect(page).toHaveURL(/[?&]down=900000(&|$)/);
    // Утас, регистр нь URL-д огт байхгүй
    expect(page.url()).not.toContain(REGISTER);
    expect(page.url()).not.toContain(PHONE);
    await expect(page.getByText('Урьдчилгаа нэмж дахин оролдох')).toBeVisible();
    await expect(page.getByLabel('Барааны нэр, загвар')).toHaveValue('Lenovo IdeaPad 3 15"');
    await expect(page.getByLabel('Барааны үнэ')).toHaveValue('1,500,000');
    await expect(page.getByLabel('Урьдчилгаа', { exact: true })).toHaveValue('900,000');
    await expect(page.locator('.ant-radio-button-wrapper-checked')).toContainText('12 сар');
    await expect(page.getByTestId('quote-monthly')).not.toContainText('—');
    expectClean(guard, api);
  });

  test('REFERRED shows a neutral panel and updates itself when the lender decides', async ({ page }) => {
    const { api, guard } = await setup(page);
    const server = installLeaseServer(api, { onSubmit: 'REFERRED' });

    await page.goto('/merchant/leases/new');
    await fillTerms(page);
    await fillBuyer(page);
    await page.getByRole('button', { name: 'Код илгээж үргэлжлүүлэх' }).click();
    await typeOtp(page, '123456');

    await expect(page.getByRole('heading', { name: 'Лизингийн байгууллага хянаж байна' })).toBeVisible();
    await expect(page.getByTestId('announce')).toContainText('Лизингийн байгууллага хянаж байна');
    // Хүлээн зөвшөөрөх/хүлээлгэн өгөх товч байхгүй; цуцлах боломжтой
    await expect(page.getByRole('button', { name: 'Баталгаажуулах' })).toHaveCount(0);
    await expect(page.locator('.mp-cancel-link')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Лизингүүд рүү' })).toBeVisible();
    await shot(page, 'decision-referred');

    // Ажилтан шийдсэний дараа (10 секундийн polling) санал харагдана
    server.set({ status: 'APPROVED' });
    await expect(page.getByRole('heading', { name: 'Лизинг батлагдлаа' })).toBeVisible({ timeout: 25_000 });
    expectClean(guard, api);
  });

  test('cancel requires a reason', async ({ page }) => {
    const { api, guard } = await setup(page);
    installLeaseServer(api);
    await page.goto(`/merchant/leases/${LEASE_ID}`);
    await page.locator('.mp-cancel-link').click();
    const dialog = page.getByRole('dialog', { name: 'Лизинг цуцлах' });
    await dialog.getByRole('button', { name: 'Цуцлах' }).click();
    await expect(dialog.getByText('Шалтгаанаа (дор хаяж 3 тэмдэгт) бичнэ үү')).toBeVisible();
    expect(api.callsTo('POST', '/merchant-portal/leases/:id/cancel')).toHaveLength(0);
    await dialog.getByLabel('Цуцлах шалтгаан').fill('Худалдан авагч татгалзсан');
    await dialog.getByRole('button', { name: 'Цуцлах' }).click();
    await expect(page.getByRole('heading', { name: 'Лизинг цуцлагдсан' })).toBeVisible();
    expect(api.lastCall('POST', '/merchant-portal/leases/:id/cancel')!.body).toEqual({ reason: 'Худалдан авагч татгалзсан' });
    expectClean(guard, api);
  });

  test('client validation: empty submit shows Mongolian messages and sends nothing', async ({ page }) => {
    const { api, guard } = await setup(page);
    installLeaseServer(api);
    await page.goto('/merchant/leases/new');
    await page.getByRole('button', { name: 'Код илгээж үргэлжлүүлэх' }).click();
    for (const msg of ['Хөтөлбөр сонгоно уу', 'Барааны ангилал сонгоно уу', 'Барааны үнийг оруулна уу', 'Хугацаа сонгоно уу', 'Регистрийн дугаар оруулна уу', 'Утасны дугаар оруулна уу']) {
      await expect(page.getByText(msg).first()).toBeVisible();
    }
    expect(api.callsTo('POST', '/merchant-portal/leases')).toHaveLength(0);

    await page.getByLabel('Регистрийн дугаар').fill('AB123');
    await page.getByLabel('Утасны дугаар').fill('1234');
    await expect(page.getByText('Регистр буруу: 2 кирилл үсэг, 8 цифр (жишээ: УБ12345678)')).toBeVisible();
    await expect(page.getByText('Утасны дугаар буруу: 8 оронтой байх ёстой')).toBeVisible();
    // Нууц мэдээлэл консолд цацагдаагүй
    expect(guard.problems.join('\n')).not.toContain('AB123');
  });

  test('server VALIDATION_FAILED maps to fields; a retried create reuses the same Idempotency-Key', async ({ page }) => {
    const { api, guard } = await setup(page);
    installLeaseServer(api);
    let attempt = 0;
    api.post('/merchant-portal/leases', () => {
      attempt += 1;
      if (attempt === 1) return { abort: true };
      if (attempt === 2) return apiError(422, 'VALIDATION_FAILED', { issues: [{ path: 'buyer.registerNo', message: 'Invalid register number' }] });
      return { status: 201, json: makeLeaseWithOtp(makeLease({ id: LEASE_ID, status: 'DRAFT', price: 1_500_000, down: 450_000, term: 12 })) };
    });

    await page.goto('/merchant/leases/new');
    await fillTerms(page);
    await fillBuyer(page);
    const submit = page.getByRole('button', { name: 'Код илгээж үргэлжлүүлэх' });

    // 1) сүлжээний тасрал -> ойлгомжтой алдаа
    await submit.click();
    await expect(page.getByRole('alert').filter({ hasText: 'Сүлжээний холболт тасарлаа' })).toBeVisible();
    // 2) серверийн талбарын алдаа -> серверийн англи мессеж биш, монгол
    await submit.click();
    await expect(page.getByText('Улаанаар тэмдэглэсэн талбаруудыг шалгана уу.')).toBeVisible();
    await expect(page.getByText('Регистр буруу: 2 кирилл үсэг, 8 цифр (жишээ: УБ12345678)')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Invalid register number');
    // 3) амжилттай
    await submit.click();
    await expect(page).toHaveURL(new RegExp(`/merchant/leases/${LEASE_ID}`));

    const keys = api.callsTo('POST', '/merchant-portal/leases').map((c) => c.headers['idempotency-key']);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size, 'нэг агуулгатай дахин оролдлого нэг Idempotency-Key ашиглана').toBe(1);
    expect(api.unhandled).toEqual([]);
    expect(guard.problems.filter((p) => !/Failed to load resource|status of 422|ERR_FAILED/.test(p))).toEqual([]);
  });

  test('inactive merchant cannot create', async ({ page }) => {
    const { api } = await setup(page, { status: 'SUSPENDED' });
    installLeaseServer(api);
    await page.goto('/merchant/leases/new');
    await expect(page.getByText('Мерчантын төлөв идэвхгүй тул шинэ лизинг үүсгэх боломжгүй.').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Код илгээж үргэлжлүүлэх' })).toBeDisabled();
  });

  test('phone layout of the form: no horizontal scroll at 320px', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    const { api, guard } = await setup(page);
    installLeaseServer(api);
    await page.goto('/merchant/leases/new');
    await fillTerms(page);
    await expect(page.getByTestId('quote-monthly')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, 'new-lease-phone');
    expectClean(guard, api);
  });
});

test('screenshots: new lease form (desktop) and approved offer', async ({ page }) => {
  const { api, guard } = await setup(page);
  const server = installLeaseServer(api);
  await page.goto('/merchant/leases/new');
  await fillTerms(page);
  await fillBuyer(page);
  await expect(page.getByTestId('quote-monthly')).toBeVisible();
  await shot(page, 'new-lease-desktop');
  server.set({ status: 'APPROVED' });
  await page.goto(`/merchant/leases/${LEASE_ID}?flow=1`);
  await expect(page.getByRole('heading', { name: 'Лизинг батлагдлаа' })).toBeVisible();
  await shot(page, 'decision-approved');
  expect(IDS.lease).toBeTruthy();
  expectClean(guard, api);
});
