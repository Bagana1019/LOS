import { expect, test, type Page } from '@playwright/test';
import { PosQuoteRequest } from '@los/contracts';
import { expectClean, setup } from './helpers';
import { leaseId, makeDashboard, makeLease, makeLeaseWithOtp, makeQuote, paged, toListItem } from './fixtures';
import type { MockApi } from './mock-api';

// Шинэ лизингийн формын оролтууд: давхар илгээлт (n=31), төгрөгийн задлалт (n=32), барааны нэрийн шалгалт (n=35), утас/регистрийн paste (n=36), утсан дээрх 16px фонт.

const LEASE_ID = leaseId(910);
const SUBMIT = 'Код илгээж үргэлжлүүлэх';
const GOODS_NAME_ERROR = 'Барааны нэр 2–200 тэмдэгт байх ёстой';

function serve(api: MockApi) {
  const lease = makeLease({ id: LEASE_ID, leaseNo: 'POS-261028-0910', status: 'DRAFT', price: 1_500_000, down: 450_000, term: 12 });
  api.post('/merchant-portal/quotes', ({ body }) => {
    const req = PosQuoteRequest.parse(body);
    return { json: makeQuote({ planCode: req.planCode, goodsPrice: req.goodsPrice, downPayment: req.downPayment, termMonths: req.termMonths }) };
  });
  api.post('/merchant-portal/leases', () => ({ status: 201, json: makeLeaseWithOtp(lease) }));
  api.get('/merchant-portal/leases/:id', () => ({ json: lease }));
  api.get('/merchant-portal/leases', () => ({ json: paged([toListItem(lease)]) }));
  api.get('/merchant-portal/dashboard', () => ({ json: makeDashboard() }));
}

async function pickOption(page: Page, label: string, option: string) {
  await page.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: label }) }).click();
  await page.locator('.ant-select-item-option', { hasText: option }).click();
}
async function fillTerms(page: Page, o: { price?: string } = {}) {
  await pickOption(page, 'Лизингийн хөтөлбөр', 'Компьютер, утас 6–24 сар');
  await pickOption(page, 'Барааны ангилал', 'Компьютер, зөөврийн компьютер');
  await page.getByLabel('Барааны нэр, загвар').fill('Lenovo IdeaPad 3 15"');
  await page.getByLabel('Барааны үнэ').fill(o.price ?? '1500000');
  await page.getByRole('group', { name: 'Урьдчилгааны товчлол' }).getByRole('button', { name: '30%' }).click();
  await page.locator('.ant-radio-button-wrapper', { hasText: '12 сар' }).click();
}
const createCalls = (api: MockApi) => api.callsTo('POST', '/merchant-portal/leases');

test.describe('Шинэ лизингийн формын оролт', () => {
  test('after a successful create the form stays locked until navigation: no second POST, the Idempotency-Key is kept (n=31)', async ({ page }) => {
    const { api, guard } = await setup(page);
    serve(api);
    // Навигацийн (RSC) хариуг барьж, "лизинг үүссэн ч хуудас солигдоогүй" завсрыг тогтвортой үүсгэнэ
    let held = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(/\/merchant\/leases\/[0-9a-f-]{36}\?.*_rsc=/, async (route) => {
      held += 1;
      await gate;
      await route.continue();
    });

    await page.goto('/merchant/leases/new');
    await fillTerms(page);
    await page.getByLabel('Регистрийн дугаар').fill('УБ12345678');
    await page.getByLabel('Утасны дугаар').fill('99112233');
    const submit = page.getByRole('button', { name: SUBMIT });
    await submit.click();
    await expect.poll(() => createCalls(api).length).toBe(1);
    await expect.poll(() => held, { message: 'navigation request was held' }).toBeGreaterThan(0);

    // Үүссэний дараа форм дахин нээгдэхгүй: оролтууд хаалттай, товч ачаалж байна
    await expect(page.getByLabel('Барааны үнэ')).toBeDisabled();
    await expect(page.getByLabel('Регистрийн дугаар')).toBeDisabled();
    await expect(submit).toHaveClass(/ant-btn-loading/);
    // Enter / давхар дарах / програмаар илгээх — аль нь ч хоёр дахь хүсэлт үүсгэхгүй
    await page.evaluate(() => (document.querySelector('form.mp-new-grid') as HTMLFormElement).requestSubmit());
    await submit.click({ force: true });
    await page.waitForTimeout(600);
    expect(createCalls(api), 'second POST while navigating').toHaveLength(1);

    release();
    await expect(page).toHaveURL(new RegExp(`/merchant/leases/${LEASE_ID}\\?flow=1$`));
    expect(createCalls(api)).toHaveLength(1);
    expect(createCalls(api)[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{16,}$/i);
    expectClean(guard, api);
  });

  test('a price with a decimal part is not multiplied: 2,000,000.00 stays 2,000,000 (n=32)', async ({ page }) => {
    const { api, guard } = await setup(page);
    serve(api);
    await page.goto('/merchant/leases/new');
    await fillTerms(page, { price: '2,000,000.00' });
    await expect(page.getByLabel('Барааны үнэ')).toHaveValue('2,000,000');
    await expect(page.getByLabel('Урьдчилгаа', { exact: true })).toHaveValue('600,000');
    await expect.poll(() => api.lastCall('POST', '/merchant-portal/quotes')?.body).toEqual({ planCode: 'LAPTOP', goodsCategory: 'COMPUTER', goodsPrice: 2_000_000, downPayment: 600_000, termMonths: 12 });
    expect(page.url()).not.toContain('2000000');
    expectClean(guard, api);
  });

  test('goods name is validated while typing and on submit, not when focus merely leaves the field (n=35)', async ({ page }) => {
    const { api, guard } = await setup(page);
    serve(api);
    await page.goto('/merchant/leases/new');
    const name = page.getByLabel('Барааны нэр, загвар');
    await expect(name).toBeFocused(); // autoFocus: анхны товшилт нь заавал энэ талбараас гарна
    await pickOption(page, 'Лизингийн хөтөлбөр', 'Компьютер, утас 6–24 сар');
    await expect(name).not.toBeFocused();
    await page.waitForTimeout(800); // blur-ийн шалгалтын (debounce 400мс) хугацаанаас илүү
    await expect(page.getByText(GOODS_NAME_ERROR)).toHaveCount(0);

    // Бичих явцад шалгана: 1 тэмдэгт -> алдаа, 2 тэмдэгт -> арилна
    await name.fill('a');
    await expect(page.getByText(GOODS_NAME_ERROR)).toBeVisible();
    await name.fill('ab');
    await expect(page.getByText(GOODS_NAME_ERROR)).toHaveCount(0);

    // Хоосон үлдээгээд илгээх -> заавал алдаа гарна
    await name.fill('');
    await page.getByRole('button', { name: SUBMIT }).click();
    await expect(page.getByText(GOODS_NAME_ERROR).first()).toBeVisible();
    expect(createCalls(api)).toHaveLength(0);
    expectClean(guard, api);
  });

  test('pasted phone and register formats are normalised before validation and never truncated (n=36)', async ({ page }) => {
    const { api, guard } = await setup(page);
    serve(api);
    await page.goto('/merchant/leases/new');
    await fillTerms(page);
    const register = page.getByLabel('Регистрийн дугаар');
    const phone = page.getByLabel('Утасны дугаар');

    // Бодит paste (insertText) нь input-ийн maxlength-ийг мөрддөг: зай/зураас/+976-тай дугаар тасрах ёсгүй
    await register.click();
    await page.keyboard.insertText('уе 900-515 00');
    await phone.click();
    await page.keyboard.insertText('+976 9911 2233');
    await expect(register).toHaveValue('УЕ90051500');
    await expect(phone).toHaveValue('99112233');
    await page.waitForTimeout(800); // debounce-той шалгалтын хугацаа
    await expect(page.getByText('Регистр буруу: 2 кирилл үсэг, 8 цифр (жишээ: УБ12345678)')).toHaveCount(0);
    await expect(page.getByText('Утасны дугаар буруу: 8 оронтой байх ёстой')).toHaveCount(0);

    // Өөр форматууд: 00976 угтвар, хаалт/зураас
    await phone.fill('');
    await phone.click();
    await page.keyboard.insertText('(976) 9911-2233');
    await expect(phone).toHaveValue('99112233');
    await phone.fill('');
    await phone.click();
    await page.keyboard.insertText('00976 9911 2233');
    await expect(phone).toHaveValue('99112233');

    await page.getByRole('button', { name: SUBMIT }).click();
    await expect.poll(() => createCalls(api).length).toBe(1);
    expect(createCalls(api)[0]!.body).toMatchObject({ buyer: { registerNo: 'УЕ90051500', phone: '99112233' } });
    expectClean(guard, api);
  });

  test('a genuinely wrong long phone still fails validation (nothing is silently cut to 8 digits)', async ({ page }) => {
    const { api, guard } = await setup(page);
    serve(api);
    await page.goto('/merchant/leases/new');
    await page.getByLabel('Утасны дугаар').click();
    await page.keyboard.insertText('991122334455');
    await expect(page.getByText('Утасны дугаар буруу: 8 оронтой байх ёстой')).toBeVisible();
    await expect(page.getByLabel('Утасны дугаар')).toHaveValue('991122334455');
    expect(createCalls(api)).toHaveLength(0);
    expectClean(guard, api);
  });
});

test.describe('утас: оролтын фонт 16px-ээс багагүй (iOS focus zoom үгүй)', () => {
  const smallControls = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')]
        .filter((el) => !['hidden', 'radio', 'checkbox'].includes((el as HTMLInputElement).type) && el.getClientRects().length > 0)
        .map((el) => ({ what: el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.id ?? el.className, size: parseFloat(getComputedStyle(el).fontSize) }))
        .filter((c) => c.size < 16),
    );

  for (const width of [320, 375, 767]) {
    test(`new lease form and lease list at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const { api, guard } = await setup(page, { role: 'MERCHANT_ADMIN' });
      serve(api);
      await page.goto('/merchant/leases/new');
      await fillTerms(page);
      await expect(page.getByTestId('quote-monthly')).toBeVisible();
      expect(await smallControls(page), 'new lease form controls under 16px').toEqual([]);

      await page.goto('/merchant/leases');
      await expect(page.getByRole('searchbox').or(page.getByPlaceholder(/Лизингийн №, утасны/)).first()).toBeVisible();
      expect(await smallControls(page), 'lease list filter controls under 16px').toEqual([]);
      expectClean(guard, api);
    });
  }
});
