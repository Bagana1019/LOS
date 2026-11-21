import { expect, test, type Page } from '@playwright/test';
import { PaymentProviderInfo, RepaymentStatusView } from '@los/contracts';
import { guardConsole, MockApi, type MockRequest } from './mock-api';

// F2-8 (системийн): "Өөр дүн" төлөх талбар. antd InputNumber нь "5сая"→5₮, "-5"→5₮, max-аас их дүнг blur дээр max болгож, 100.555-г 100.56 болгож чимээгүй засдаг байсан —
// бодит төлбөрийн invoice-д буруу дүн явах эрсдэлтэй. Одоо бичсэн текст хэвээр үлдэж, буруу бол талбарт алдаа гарч, "Үргэлжлүүлэх" идэвхгүй, invoice үүсэхгүй.
const APP_ID = '00000000-0000-4000-8000-0000000000e1';
const INVOICES = '/payments/invoices';
const MAX = 10_000_000;

const STATUS = RepaymentStatusView.parse({
  applicationId: APP_ID, currency: 'MNT', asOf: '2026-11-21', applicationStatus: 'ACTIVE', payable: true, scheduleGeneratedAt: '2026-10-01T00:00:00.000Z',
  installments: [{
    id: 'row-1', seq: 1, dueDate: '2026-11-25', principal: 9_000_000, interest: 1_000_000, total: MAX, paidInterest: 0, paidPrincipal: 0, paidTotal: 0, outstanding: MAX, status: 'DUE', daysOverdue: 0,
  }],
  totals: { scheduled: MAX, paid: 0, outstanding: MAX, overdue: 0 }, payNowAmount: 1_000_000, nextDue: { scheduleRowId: 'row-1', dueDate: '2026-11-25', outstanding: MAX }, recentPayments: [],
});

async function openCustomAmount(page: Page): Promise<MockApi> {
  const api = new MockApi('OFFICER');
  api.get('/applications/:id/repayment-status', { json: STATUS });
  api.get('/payments/providers', { json: [PaymentProviderInfo.parse({ provider: 'QPAY', enabled: true, mode: 'mock', reason: null })] });
  api.get('/applications/:id/payments', { json: [] });
  api.post(INVOICES, { status: 422, json: { code: 'AMOUNT_OUT_OF_RANGE', message: 'mock' } }); // тест зөвхөн явсан хүсэлтийг шалгана
  await api.install(page);
  guardConsole(page);
  await page.goto(`/los/loan/${APP_ID}/payments`);
  await page.getByRole('button', { name: 'Төлөх', exact: true }).first().click();
  await page.getByRole('radio', { name: 'Өөр дүн' }).check();
  await expect(customAmount(page)).toBeVisible();
  return api;
}

const customAmount = (page: Page) => page.getByPlaceholder('Дүн оруулах', { exact: true });
const proceed = (page: Page) => page.getByRole('button', { name: 'Үргэлжлүүлэх' });
const invoicePosts = (api: MockApi): MockRequest[] => api.callsTo('POST', INVOICES);

test.describe('F2-8: "Өөр дүн" төлөх талбар', () => {
  test('"5сая" нь 5,000,000₮ болж ойлгогдож, invoice-д яг тэр дүн явна (5₮ биш)', async ({ page }) => {
    const api = await openCustomAmount(page);
    await customAmount(page).fill('5сая');
    await customAmount(page).blur();
    await expect(customAmount(page)).toHaveValue('5,000,000');
    await expect(proceed(page)).toBeEnabled();
    await proceed(page).click();
    await expect.poll(() => invoicePosts(api).length).toBe(1);
    expect(invoicePosts(api)[0]!.body).toMatchObject({ applicationId: APP_ID, provider: 'QPAY', amount: 5_000_000 });
  });

  test('"-5" нь эерэг болж хувирахгүй: алдаа гарч, товч идэвхгүй, invoice үүсэхгүй', async ({ page }) => {
    const api = await openCustomAmount(page);
    await customAmount(page).fill('-5');
    await expect(page.getByText('Дүн 0-ээс их байх ёстой')).toBeVisible();
    await expect(customAmount(page)).toHaveValue('-5');
    await expect(proceed(page)).toBeDisabled();
    expect(invoicePosts(api)).toHaveLength(0);
  });

  test('тоо биш текст ("тав") нь алдаа гаргана, чимээгүй устгагдахгүй', async ({ page }) => {
    const api = await openCustomAmount(page);
    await customAmount(page).fill('тав');
    await customAmount(page).blur();
    await expect(page.getByText('Зөвхөн тоо оруулна уу (жишээ: 1,500,000 эсвэл 5сая)')).toBeVisible();
    await expect(customAmount(page)).toHaveValue('тав');
    await expect(proceed(page)).toBeDisabled();
    expect(invoicePosts(api)).toHaveLength(0);
  });

  test('үлдэгдлээс их дүн blur дээр дээд хэмжээ болж clamp хийгдэхгүй: алдаа гарч, бичсэн дүн хэвээр', async ({ page }) => {
    const api = await openCustomAmount(page);
    await customAmount(page).fill('50сая');
    await customAmount(page).blur();
    await expect(page.getByText('Дүн 10,000,000 ₮-аас хэтрэхгүй байх ёстой')).toBeVisible();
    await expect(customAmount(page)).toHaveValue('50,000,000');
    await expect(proceed(page)).toBeDisabled();
    expect(invoicePosts(api)).toHaveLength(0);
  });

  test('3 оронтой бутархай (100.555) нь 100.56 болж дугуйрахгүй: алдаа гарна', async ({ page }) => {
    const api = await openCustomAmount(page);
    await customAmount(page).fill('100.555');
    await customAmount(page).blur();
    await expect(page.getByText('Дүн ихдээ 2 орны нарийвчлалтай байх ёстой')).toBeVisible();
    await expect(customAmount(page)).toHaveValue('100.555');
    await expect(proceed(page)).toBeDisabled();
    expect(invoicePosts(api)).toHaveLength(0);
  });
});
