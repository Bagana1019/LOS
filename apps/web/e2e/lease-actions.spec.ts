import { expect, test, type Page } from '@playwright/test';
import type { PosLeaseAction, PosLeaseView } from '@los/contracts';
import { expectClean, setup } from './helpers';
import { leaseId, makeDashboard, makeLease, makeOtp, paged, toListItem } from './fixtures';
import { apiError, type MockApi } from './mock-api';

// Лизингийн самбар: (n=18) амжилтгүй mutation-ы дараа серверийн allowedActions-тэй дахин тулгах, (n=19) allowedActions-д байхгүй үйлдлийн товчийг харуулахгүй,
// (n=22) кодын илгээлтийн хязгаарын мессеж. Самбарын бүх товч серверийн `allowedActions`-оос л хамаарна (docs/05 §4).

const ID = leaseId(950);
const NO = 'POS-261028-0950';

/** `actions` өгвөл серверийн allowedActions-ийг шууд зааж өгнө (түдгэлзсэн/идэвхгүй мерчантын төлөв). */
const lease = (o: Parameters<typeof makeLease>[0], actions?: PosLeaseAction[]): PosLeaseView => makeLease({ id: ID, leaseNo: NO, ...o, ...(actions ? { allowedActions: actions } : {}) });

function serve(api: MockApi, initial: PosLeaseView) {
  const state = { lease: initial };
  api.get('/merchant-portal/leases/:id', () => ({ json: state.lease }));
  api.get('/merchant-portal/leases', () => ({ json: paged([toListItem(state.lease)]) }));
  api.get('/merchant-portal/dashboard', () => ({ json: makeDashboard() }));
  return state;
}
const leaseGets = (api: MockApi) => api.callsTo('GET', '/merchant-portal/leases/:id').length;

async function typeOtp(page: Page, code: string) {
  await page.getByLabel('Кодын 1-р орон').click();
  await page.keyboard.type(code);
}

const OTP_HEADING = 'Худалдан авагчийн зөвшөөрлийн код';
const NOTE_HEADING = 'Энэ үйлдлийг одоо хийх боломжгүй';

test.describe('амжилтгүй үйлдлийн дараа лизингийг сервертэй дахин тулгана (n=18)', () => {
  test('screening 503 after the consent was stored: the stale OTP form is replaced by the retry-submit panel', async ({ page }) => {
    const { api, guard } = await setup(page);
    const state = serve(api, lease({ status: 'DRAFT', consentVerified: false }));
    api.post('/merchant-portal/leases/:id/submit', () => {
      state.lease = lease({ status: 'DRAFT', consentVerified: true }); // сервер зөвшөөрлийг хадгалсан, дараа нь лавлагаа унасан
      return apiError(503, 'SCREENING_UNAVAILABLE');
    });
    await page.goto(`/merchant/leases/${ID}`);
    await expect(page.getByRole('heading', { name: OTP_HEADING })).toBeVisible();
    await typeOtp(page, '123456');

    await expect(page.getByRole('heading', { name: 'Шийдвэр гаргах' })).toBeVisible();
    await expect(page.getByRole('heading', { name: OTP_HEADING })).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: 'Зээлийн лавлагаа түр боломжгүй байна' })).toBeVisible();

    // Дахин оролдох: OTP-гүй `submit`
    api.post('/merchant-portal/leases/:id/submit', () => {
      state.lease = lease({ status: 'APPROVED' });
      return { json: state.lease };
    });
    await page.getByRole('button', { name: 'Шийдвэр гаргах' }).click();
    await expect(page.getByRole('heading', { name: 'Лизинг батлагдлаа' })).toBeVisible();
    expect(api.lastCall('POST', '/merchant-portal/leases/:id/submit')!.body).toEqual({});
    expectClean(guard, api);
  });

  test('resend that hits INVALID_TRANSITION (cancelled elsewhere) refreshes the panel instead of leaving a dead OTP form', async ({ page }) => {
    const { api, guard } = await setup(page);
    const state = serve(api, lease({ status: 'DRAFT', consentVerified: false }));
    api.post('/merchant-portal/leases/:id/otp/consent', () => {
      state.lease = lease({ status: 'CANCELLED' });
      return apiError(409, 'INVALID_TRANSITION');
    });
    await page.goto(`/merchant/leases/${ID}`);
    await expect(page.getByRole('heading', { name: OTP_HEADING })).toBeVisible();
    await page.getByRole('button', { name: 'Код дахин илгээх' }).click();
    await expect(page.getByRole('heading', { name: 'Лизинг цуцлагдсан' })).toBeVisible();
    await expect(page.getByRole('heading', { name: OTP_HEADING })).toHaveCount(0);
    expectClean(guard, api);
  });

  test('a wrong code (OTP_INVALID) changes nothing on the server, so the lease is NOT refetched', async ({ page }) => {
    const { api, guard } = await setup(page);
    serve(api, lease({ status: 'DRAFT', consentVerified: false }));
    api.post('/merchant-portal/leases/:id/submit', () => apiError(422, 'OTP_INVALID', { attemptsLeft: 2 }));
    await page.goto(`/merchant/leases/${ID}`);
    await expect(page.getByRole('heading', { name: OTP_HEADING })).toBeVisible();
    const before = leaseGets(api);
    await typeOtp(page, '000000');
    await expect(page.getByRole('alert').filter({ hasText: 'Код буруу байна. Үлдсэн оролдлого: 2.' })).toBeVisible();
    await page.waitForTimeout(600); // сөрөг шалгалт: дахин татах хүсэлт ирэх хугацаа
    expect(leaseGets(api)).toBe(before);
    expectClean(guard, api);
  });

  test('accept that fails with INVALID_TRANSITION (offer expired meanwhile) re-syncs to the expired panel', async ({ page }) => {
    const { api, guard } = await setup(page);
    const state = serve(api, lease({ status: 'APPROVED' }));
    api.post('/merchant-portal/leases/:id/otp/accept', () => ({ json: makeOtp('ACCEPT') }));
    api.post('/merchant-portal/leases/:id/accept', () => {
      state.lease = lease({ status: 'EXPIRED' });
      return apiError(409, 'INVALID_TRANSITION');
    });
    await page.goto(`/merchant/leases/${ID}`);
    await page.getByRole('button', { name: 'Баталгаажуулах' }).click();
    await expect(page.getByRole('heading', { name: 'Нөхцөл хүлээн зөвшөөрөх код' })).toBeVisible();
    await typeOtp(page, '654321');
    await expect(page.getByRole('heading', { name: 'Хугацаа дууссан', exact: true })).toBeVisible();
    expectClean(guard, api);
  });

  test('deliver that fails with MERCHANT_NOT_ACTIVE (suspended meanwhile) swaps the form for the read-only explanation', async ({ page }) => {
    const { api, guard } = await setup(page);
    const state = serve(api, lease({ status: 'ACCEPTED' }));
    api.post('/merchant-portal/leases/:id/deliver', () => {
      state.lease = lease({ status: 'ACCEPTED' }, []); // мерчант идэвхгүй болсон → allowedActions хоосон
      return apiError(409, 'MERCHANT_NOT_ACTIVE');
    });
    await page.goto(`/merchant/leases/${ID}`);
    await page.getByRole('button', { name: 'Барааг хүлээлгэн өгсөн' }).click();
    await expect(page.getByRole('heading', { name: NOTE_HEADING })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Барааг хүлээлгэн өгсөн' })).toHaveCount(0);
    expectClean(guard, api);
  });

  test('cancel that fails with INVALID_TRANSITION (already delivered) closes the modal and shows the real state', async ({ page }) => {
    const { api, guard } = await setup(page);
    const state = serve(api, lease({ status: 'ACCEPTED' }));
    api.post('/merchant-portal/leases/:id/cancel', () => {
      state.lease = lease({ status: 'DELIVERED' });
      return apiError(409, 'INVALID_TRANSITION');
    });
    await page.goto(`/merchant/leases/${ID}`);
    await page.locator('.mp-cancel-link').click();
    const dialog = page.getByRole('dialog', { name: 'Лизинг цуцлах' });
    await dialog.getByLabel('Цуцлах шалтгаан').fill('Худалдан авагч татгалзсан');
    await dialog.getByRole('button', { name: 'Цуцлах' }).click();
    await expect(page.getByRole('heading', { name: 'Бараа хүлээлгэн өгсөн' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expectClean(guard, api);
  });
});

test.describe('кодын илгээлтийн хязгаар (n=22)', () => {
  test('the send limit says no new code can be requested (not "request a new code")', async ({ page }) => {
    const { api, guard } = await setup(page);
    serve(api, lease({ status: 'DRAFT', consentVerified: false }));
    api.post('/merchant-portal/leases/:id/otp/consent', () => apiError(429, 'OTP_ATTEMPTS_EXCEEDED', { reason: 'MAX_SENDS' }));
    await page.goto(`/merchant/leases/${ID}`);
    // Хуудас нэвтрэлтийн хаалганы дараа (async) ачаалдаг тул lease эхний удаа ирж дууссаны дараа л суурь тоог авна
    const resend = page.getByRole('button', { name: 'Код дахин илгээх' });
    await expect(resend).toBeVisible();
    const before = leaseGets(api);
    await resend.click();
    const alert = page.getByRole('alert').filter({ hasText: 'Кодын илгээлтийн хязгаар хэтэрсэн' });
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText('Шинэ код авна уу');
    await expect(alert).toContainText('цуцлаад шинээр үүсгэнэ үү');
    await page.waitForTimeout(400);
    expect(leaseGets(api), 'send limit does not change the lease').toBe(before);
    expectClean(guard, api);
  });
});

test.describe('allowedActions-д байхгүй үйлдлийн товчийг харуулахгүй (n=19)', () => {
  const CANCEL = '.mp-cancel-link';

  test('suspended merchant + DRAFT: no "decide" button and no OTP form, only the explanation and cancel', async ({ page }) => {
    const { api, guard } = await setup(page, { status: 'SUSPENDED' });
    serve(api, lease({ status: 'DRAFT', consentVerified: false }, ['CANCEL']));
    await page.goto(`/merchant/leases/${ID}`);
    await expect(page.getByRole('heading', { name: NOTE_HEADING })).toBeVisible();
    await expect(page.getByText('Мерчантын төлөв идэвхгүй тул энэ лизингийн дараагийн алхмыг хийх боломжгүй')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Шийдвэр гаргах' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: OTP_HEADING })).toHaveCount(0);
    await expect(page.locator(CANCEL)).toBeVisible();
    expectClean(guard, api);
  });

  test('suspended merchant + APPROVED: the offer stays readable but "confirm" is gone', async ({ page }) => {
    const { api, guard } = await setup(page, { status: 'SUSPENDED' });
    serve(api, lease({ status: 'APPROVED' }, ['CANCEL']));
    await page.goto(`/merchant/leases/${ID}`);
    await expect(page.getByRole('heading', { name: 'Лизинг батлагдлаа' })).toBeVisible();
    await expect(page.getByTestId('offer-monthly')).toBeVisible();
    await expect(page.getByRole('heading', { name: NOTE_HEADING })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Баталгаажуулах' })).toHaveCount(0);
    await expect(page.locator(CANCEL)).toBeVisible();
    expectClean(guard, api);
  });

  test('terminated merchant + ACCEPTED (no allowed actions): no deliver form, no cancel, just the explanation', async ({ page }) => {
    const { api, guard } = await setup(page, { status: 'TERMINATED' });
    serve(api, lease({ status: 'ACCEPTED' }, []));
    await page.goto(`/merchant/leases/${ID}`);
    await expect(page.getByRole('heading', { name: NOTE_HEADING })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Барааг хүлээлгэн өгсөн' })).toHaveCount(0);
    await expect(page.getByLabel('Серийн дугаар (заавал биш)')).toHaveCount(0);
    await expect(page.locator(CANCEL)).toHaveCount(0);
    await page.screenshot({ path: '/tmp/claude-0/web-screens/lease-inactive-note.png', fullPage: true });
    expectClean(guard, api);
  });

  test('suspended merchant + ACCEPTED: the server still allows DELIVER, so the form stays', async ({ page }) => {
    const { api, guard } = await setup(page, { status: 'SUSPENDED' });
    serve(api, lease({ status: 'ACCEPTED' }, ['DELIVER', 'CANCEL']));
    await page.goto(`/merchant/leases/${ID}`);
    await expect(page.getByRole('button', { name: 'Барааг хүлээлгэн өгсөн' })).toBeVisible();
    await expect(page.getByRole('heading', { name: NOTE_HEADING })).toHaveCount(0);
    expectClean(guard, api);
  });

  test('active merchant keeps every control (the gating follows allowedActions, not a blanket hide)', async ({ page }) => {
    const { api, guard } = await setup(page);
    serve(api, lease({ status: 'DRAFT', consentVerified: true }));
    await page.goto(`/merchant/leases/${ID}`);
    await expect(page.getByRole('button', { name: 'Шийдвэр гаргах' })).toBeVisible();
    await expect(page.getByRole('heading', { name: NOTE_HEADING })).toHaveCount(0);
    expectClean(guard, api);
  });
});
