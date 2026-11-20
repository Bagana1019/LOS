import { expect, test, type Page } from '@playwright/test';
import { DisbursementView, UpdateDisbursementRequest } from '@los/contracts';
import { expectClean } from './helpers';
import { guardConsole, MockApi } from './mock-api';

// Wizard-ийн «Зээл олгох хүсэлт» алхам (`/los/loan-application/:id/disburse`, FR-12). Gateway-г mock хийсэн.
// F5-3: олгох дүн / огноог арилгаад хадгалахад хоосон/0 утга чимээгүй алгасагдаж, "хадгалагдлаа" гэсэн мэдэгдэл гарсан ч сервер дээр хуучин утга үлддэг байсан.
const APP_ID = '00000000-0000-4000-8000-0000000000d5';
const URL = `/los/loan-application/${APP_ID}/disburse`;
const DISBURSEMENT = '/applications/:id/disbursement';
const SAVED_TOAST = 'Олголтын мэдээлэл хадгалагдлаа';
const AMOUNT_ERROR = 'Олгох дүн 0-ээс их байх ёстой';
const DATE_ERROR = 'Олгох огноог сонгоно уу';

function makeView(o: Partial<DisbursementView> = {}): DisbursementView {
  return DisbursementView.parse({
    id: 'dsb-1', applicationId: APP_ID, applicationStatus: 'APPROVED', status: 'DRAFT', approvedAmount: 5_000_000, disburseAmount: 5_000_000, termMonths: 12, interestRate: 28,
    repaymentType: 'ANNUITY', firstPaymentDate: '2027-01-05', disburseDate: '2026-12-05', bankCode: 'KHAN', accountNoMasked: '****5678', holderName: 'Номин Дашдорж',
    accountOwnerType: 'SELF', nameCheck: null, reconciliation: null, coreLoanId: null, checks: [], canSubmit: false, history: [], ...o,
  });
}

/** Жинхэнэ сервер шиг: PUT-д ирсэн талбаруудыг л шинэчилж, ирээгүйг хэвээр үлдээнэ (хоосон/0-ийг contract хүлээж авахгүй). */
async function setup(page: Page) {
  const api = new MockApi('OFFICER');
  const state = { view: makeView() };
  api.get(DISBURSEMENT, () => ({ json: state.view }));
  api.put(DISBURSEMENT, ({ body }) => {
    const req = UpdateDisbursementRequest.parse(body);
    state.view = makeView({ ...state.view, ...req, ...(req.accountNo ? { accountNoMasked: `****${req.accountNo.slice(-4)}` } : {}) });
    return { json: state.view };
  });
  await api.install(page);
  const guard = guardConsole(page);
  return { api, guard, state };
}

const amount = (page: Page) => page.getByTestId('disb-amount');
const date = (page: Page) => page.getByTestId('disb-date');
const save = (page: Page) => page.getByTestId('disb-save');
const puts = (api: MockApi) => api.callsTo('PUT', DISBURSEMENT);

test.describe('Олголтын хүсэлт: хадгалах (F5-3)', () => {
  test('prefilled draft shows the saved amount and date', async ({ page }) => {
    const { api, guard } = await setup(page);
    await page.goto(URL);
    await expect(amount(page)).toHaveValue('5000000'); // мянгатын таслалгүй — тусдаа асуудал (F2-8), энд хөндөхгүй
    await expect(date(page)).toHaveValue('2026-12-05');
    expectClean(guard, api);
  });

  test('clearing the amount shows a field error and sends nothing — no false "saved" toast', async ({ page }) => {
    const { api } = await setup(page);
    await page.goto(URL);
    await amount(page).fill('');
    await save(page).click();
    await expect(page.getByText(AMOUNT_ERROR)).toBeVisible();
    await expect(page.getByText(SAVED_TOAST)).toHaveCount(0);
    expect(puts(api)).toHaveLength(0);
  });

  test('an amount of 0 is rejected in the form instead of being silently dropped', async ({ page }) => {
    const { api } = await setup(page);
    await page.goto(URL);
    await amount(page).fill('0');
    await save(page).click();
    await expect(page.getByText(AMOUNT_ERROR)).toBeVisible();
    await expect(page.getByText(SAVED_TOAST)).toHaveCount(0);
    expect(puts(api)).toHaveLength(0);
  });

  test('clearing the date shows a field error and sends nothing', async ({ page }) => {
    const { api } = await setup(page);
    await page.goto(URL);
    await date(page).fill('');
    await save(page).click();
    await expect(page.getByText(DATE_ERROR)).toBeVisible();
    await expect(page.getByText(SAVED_TOAST)).toHaveCount(0);
    expect(puts(api)).toHaveLength(0);
  });

  test('a valid save sends the new amount and date, and the form then shows exactly what the server stored', async ({ page }) => {
    const { api, state } = await setup(page);
    await page.goto(URL);
    await amount(page).fill('4000000');
    await date(page).fill('2026-12-20');
    // Хоосон банк нь «өөрчлөхгүй» гэж илгээгддэггүй (contract min(1)) → хадгалсны дараа форм серверийн утгыг (KHAN) буцааж үзүүлнэ, хоосон биш
    await page.getByTestId('disb-bank').fill('');
    await page.getByTestId('disb-account').fill('5012349999');
    await save(page).click();
    await expect(page.getByText(SAVED_TOAST)).toBeVisible();
    expect(puts(api)).toHaveLength(1);
    expect(puts(api)[0]!.body).toMatchObject({ disburseAmount: 4_000_000, disburseDate: '2026-12-20' });
    expect(puts(api)[0]!.body).not.toHaveProperty('bankCode');
    expect(state.view).toMatchObject({ disburseAmount: 4_000_000, disburseDate: '2026-12-20', bankCode: 'KHAN', accountNoMasked: '****9999' });
    await expect(amount(page)).toHaveValue('4000000');
    await expect(date(page)).toHaveValue('2026-12-20');
    await expect(page.getByTestId('disb-bank')).toHaveValue('KHAN');
    await expect(page.getByTestId('disb-account')).toHaveValue(''); // шинэ дансыг сервер хадгалсан (masked) — оруулсан түүхий дугаар формд үлдэхгүй
  });
});
