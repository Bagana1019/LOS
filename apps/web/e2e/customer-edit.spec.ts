import { expect, test, type Page } from '@playwright/test';
import type { UserRole } from '@los/contracts';
import { defaultApplicationDetail } from './application-shell';
import { MockApi } from './mock-api';

// F1-15: харилцагчийн карт дээр засах горим + «Зээлийн хүсэлт үүсгэх» + бүртгэсний toast. F1-16: ААН-д иргэний зөвшөөрлийн код (OTP) хамаарахгүй.
const ID = '22222222-2222-4222-8222-222222222222';
const PHOTO = '33333333-3333-4333-8333-333333333333';
const APP_ID = '44444444-4444-4444-8444-444444444444';
const AT = '2026-11-03T00:00:00.000Z';
const addr = { province: 'Улаанбаатар', district: 'БЗД', khoroo: '1-р хороо', detail: 'Байр 1' };
const individual = {
  id: ID, customerType: 'INDIVIDUAL', registerNo: 'УБ90010112', lastName: 'Болд', clanName: null, civilId: null, firstName: 'Бат', gender: 'MALE', birthDate: '1990-01-01',
  phone: '99112233', email: 'bat@example.mn', photoFileId: PHOTO, familySize: 3, activitySector: 'Худалдаа', maritalStatus: 'MARRIED', segment: 'Жижиглэн', education: 'Бакалавр',
  isRelatedParty: false, isPep: false, amlRiskScore: null, officialAddress: addr, residenceAddress: addr, residenceSameAsOfficial: true, employment: { organization: 'ХХК', position: 'Менежер' },
  xypFetchedAt: AT, branchId: 'branch', createdAt: AT, updatedAt: AT, contacts: [{ id: 'c1', relation: 'PARENT', registerNo: null, lastName: 'Болд', firstName: 'Дорж', phone: '88112233' }], warnings: [], applications: [],
};

async function openCard(page: Page, role: UserRole = 'OFFICER', card: Record<string, unknown> = individual) {
  const api = new MockApi(role);
  await api.install(page);
  const state = { current: card };
  api.get(`/customers/${ID}`, () => ({ json: state.current }));
  api.put(`/customers/${ID}`, ({ body }) => { state.current = { ...state.current, ...(body as object) }; return { json: state.current }; });
  await page.goto(`/customer/${ID}`);
  return api;
}
const toast = (page: Page, text: string) => page.locator('.ant-message-notice').filter({ hasText: text });

test.describe('F1-15 · карт дээрх засвар', () => {
  test('засах горим: ХУР-ын талбар түгжээтэй, өөрчилсөн талбар л PUT-д явж, амжилтын toast гарна', async ({ page }) => {
    const api = await openCard(page);
    await page.getByTestId('customer-edit').click();
    await expect(page.locator('#phone')).toHaveValue('99112233');
    for (const id of ['#lastName', '#firstName', '#birthDate', '#officialAddress_province']) await expect(page.locator(id)).toHaveAttribute('readonly', '');
    await expect(page.locator('#email')).not.toHaveAttribute('readonly', '');

    await page.locator('#phone').fill('99887766');
    await page.getByTestId('customer-submit').click();

    await expect(toast(page, 'Харилцагчийн мэдээлэл хадгалагдлаа')).toBeVisible();
    expect(api.lastCall('PUT', `/customers/${ID}`)?.body).toEqual({ phone: '99887766' }); // регистр/төрөл/бусад талбар явахгүй
    await expect(page.getByTestId('customer-submit')).toHaveCount(0); // засах горимоос гарсан
    await expect(page.getByText('99887766')).toBeVisible();
  });

  test('өөрчлөлтгүй бол сервер рүү дуудлага явахгүй', async ({ page }) => {
    const api = await openCard(page);
    await page.getByTestId('customer-edit').click();
    await page.getByTestId('customer-submit').click();
    await expect(toast(page, 'Өөрчилсөн талбар алга')).toBeVisible();
    expect(api.callsTo('PUT', `/customers/${ID}`)).toHaveLength(0);
  });

  test('хадгалах явцад товч loading; серверийн талбарын алдаа ба 403 нь харагдана, засах горим хэвээр', async ({ page }) => {
    const api = await openCard(page);
    let n = 0;
    api.put(`/customers/${ID}`, () => {
      n += 1;
      return n === 1
        ? { delayMs: 700, status: 400, json: { code: 'VALIDATION_FAILED', message: 'bad', details: [{ path: 'email', message: 'И-мэйл серверт буруу' }] } }
        : { status: 403, json: { code: 'CUSTOMER_BRANCH_FORBIDDEN', message: 'forbidden' } };
    });
    await page.getByTestId('customer-edit').click();
    await page.locator('#phone').fill('99887766');
    await page.getByTestId('customer-submit').click();
    await expect(page.getByTestId('customer-submit')).toHaveClass(/ant-btn-loading/);
    await expect(page.getByTestId('customer-edit-error')).toContainText('Оруулсан өгөгдөл буруу эсвэл дутуу байна');
    await expect(page.getByText('И-мэйл серверт буруу')).toBeVisible();

    await page.getByTestId('customer-submit').click();
    await expect(page.getByTestId('customer-edit-error')).toContainText('зөвхөн тухайн салбар засах боломжтой');
    await expect(page.getByTestId('customer-submit')).toBeVisible();
  });

  test('болих: засах горимоос гарч, хадгалаагүй өөрчлөлт хаягдана', async ({ page }) => {
    const api = await openCard(page);
    await page.getByTestId('customer-edit').click();
    await page.locator('#phone').fill('99887766');
    await page.getByTestId('customer-edit-cancel').click();
    await expect(page.getByTestId('customer-submit')).toHaveCount(0);
    await expect(page.getByText('99112233')).toBeVisible();
    expect(api.callsTo('PUT', `/customers/${ID}`)).toHaveLength(0);
  });

  test('өөр салбарын харилцагч: засах товч идэвхгүй + шалтгаан, гэхдээ хүсэлт үүсгэж болно', async ({ page }) => {
    await openCard(page, 'OFFICER', { ...individual, branchId: 'other-branch' });
    await expect(page.getByTestId('customer-edit')).toBeDisabled();
    await expect(page.getByTestId('customer-other-branch')).toBeVisible();
    await expect(page.getByTestId('customer-start-application')).toBeEnabled();
  });

  test('засах эрхгүй дүр (батлагч): засах товч идэвхгүй + шалтгаан, хүсэлт үүсгэх товч байхгүй', async ({ page }) => {
    await openCard(page, 'APPROVER');
    await expect(page.getByTestId('customer-edit')).toBeDisabled();
    await expect(page.getByTestId('customer-edit-blocked')).toContainText('Засах эрхгүй');
    await expect(page.getByTestId('customer-start-application')).toHaveCount(0);
  });
});

test.describe('F1-15 · Зээлийн хүсэлт үүсгэх', () => {
  const created = { ...defaultApplicationDetail(APP_ID), id: APP_ID };

  test('хүсэлт үүсгээд харилцагчийг үндсэн зээлдэгчээр холбож, хүсэлтийн wizard руу орно', async ({ page }) => {
    const api = await openCard(page);
    api.post('/applications', { status: 201, json: created });
    api.post(`/applications/${APP_ID}/borrowers`, { status: 201, json: {} });
    await page.getByTestId('customer-start-application').click();
    await expect(page).toHaveURL(new RegExp(`/los/loan-application/${APP_ID}`));
    expect(api.lastCall('POST', '/applications')?.body).toEqual({});
    expect(api.lastCall('POST', '/applications')?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{16,}$/i);
    expect(api.lastCall('POST', `/applications/${APP_ID}/borrowers`)?.body).toEqual({ customerId: ID, role: 'PRIMARY' });
  });

  test('холбох алдаатай бол хүсэлт үүссэнийг хэлж ноорог руу линк өгнө; дахин оролдоход ижил түлхүүр (давхар ноорог үүсэхгүй)', async ({ page }) => {
    const api = await openCard(page);
    api.post('/applications', { status: 201, json: created });
    let n = 0;
    api.post(`/applications/${APP_ID}/borrowers`, () => { n += 1; return n === 1 ? { status: 404, json: { code: 'CUSTOMER_NOT_FOUND', message: 'x' } } : { status: 201, json: {} }; });
    await page.getByTestId('customer-start-application').click();
    await expect(page.getByTestId('customer-start-application-error')).toContainText(created.appNo);
    await expect(page.getByTestId('customer-open-draft')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/customer/${ID}$`));

    await page.getByTestId('customer-start-application').click();
    await expect(page).toHaveURL(new RegExp(`/los/loan-application/${APP_ID}`));
    const keys = api.callsTo('POST', '/applications').map((c) => c.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
});

// F1-16: ААН (7 оронтой регистр). Сервер: бодит ХУР-ын клиент ААН-д 501, mock клиент л код хүсэлтийг нэвтрүүлдэг → иргэний зөвшөөрлийн алхмыг ААН-д харуулахгүй.
test.describe('F1-16 · байгууллага бүртгэх', () => {
  const LEGAL = '5301234';
  const NEW_ID = '55555555-5555-4555-8555-555555555555';
  const warning = { code: 'BLACKLISTED', severity: 'WARNING', listType: 'INTERNAL', listSeverity: 'BLACK', reasonCode: 'FRAUD', reasonText: 'Залилангийн түүхтэй', registeredAt: AT };
  const lookup = (over: Record<string, unknown> = {}) => ({ registerNo: LEGAL, customerType: 'LEGAL_ENTITY', exists: false, customer: null, warnings: [], ...over });

  async function setup(page: Page, lookupBody: Record<string, unknown>) {
    const api = new MockApi('OFFICER');
    await api.install(page);
    api.get('/customers/lookup', { json: lookupBody });
    // mock горимын сервер ААН-д ч код "илгээдэг" — UI үүнийг огт дуудах ёсгүй
    api.post('/customers/xyp-otp', { json: { sent: true, requestedAt: new Date().toISOString(), existing: null, warnings: [] } });
    await page.goto('/customer/new');
    await page.getByTestId('customer-register').fill(LEGAL);
    await page.getByTestId('customer-check').click();
    return api;
  }

  test('ААН: иргэний зөвшөөрлийн код/алхам байхгүй, шууд маягт + ААН-д зориулсан тайлбар; хар жагсаалтын анхааруулга харагдана', async ({ page }) => {
    const api = await setup(page, lookup({ warnings: [warning] }));
    await expect(page.getByTestId('customer-submit')).toBeVisible();
    await expect(page.getByTestId('customer-legal-note')).toBeVisible();
    await expect(page.getByTestId('xyp-otp-step')).toHaveCount(0);
    await expect(page.getByText('Иргэний зөвшөөрөл')).toHaveCount(0);
    await expect(page.getByText(/иргэний утсанд/)).toHaveCount(0);
    await expect(page.getByText(/Залилангийн түүхтэй/)).toBeVisible();
    expect(api.callsTo('POST', '/customers/xyp-otp')).toHaveLength(0);
    expect(api.lastCall('GET', '/customers/lookup')?.search.get('registerNo')).toBe(LEGAL);
  });

  test('ААН аль хэдийн бүртгэлтэй бол код хүсэлгүй бүртгэлтэй харилцагчийг нээх санал болгоно', async ({ page }) => {
    const customer = { id: NEW_ID, customerType: 'LEGAL_ENTITY', registerNoMasked: '5****34', lastName: null, firstName: 'Нэгдэл ХХК', phone: '77112233', isPep: false, isRelatedParty: false, blacklisted: false, createdAt: AT };
    const api = await setup(page, lookup({ exists: true, customer }));
    await expect(page.getByText(/аль хэдийн бүртгэлтэй: Нэгдэл ХХК/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Бүртгэлтэй харилцагчийг нээх' })).toBeVisible();
    await expect(page.getByTestId('xyp-otp-step')).toHaveCount(0);
    expect(api.callsTo('POST', '/customers/xyp-otp')).toHaveLength(0);
  });

  test('ААН-г гараар бүртгэхэд source=MANUAL (ХУР-ын token-гүй), бүртгэсний дараа toast + карт', async ({ page }) => {
    const api = await setup(page, lookup());
    const company = { ...individual, id: NEW_ID, customerType: 'LEGAL_ENTITY', registerNo: LEGAL, lastName: null, firstName: 'Нэгдэл ХХК', gender: null, birthDate: null, photoFileId: null, familySize: null, maritalStatus: null, education: null, employment: null, xypFetchedAt: null, contacts: [] };
    api.post('/customers', { status: 201, json: company });
    api.get(`/customers/${NEW_ID}`, { json: company });
    await page.locator('#firstName').fill('Нэгдэл ХХК');
    await page.locator('#phone').fill('77112233');
    await page.locator('#email').fill('info@example.mn');
    await page.locator('#activitySector').fill('Худалдаа');
    await page.locator('#segment').fill('ЖДҮ');
    for (const [k, v] of Object.entries(addr)) await page.locator(`#officialAddress_${k}`).fill(v);
    await page.getByLabel('Оршин суугаа хаяг нь албан ёсны хаягтай ижил').check();
    await page.getByTestId('customer-submit').click();

    await expect(toast(page, 'Харилцагч бүртгэгдлээ')).toBeVisible(); // карт compile удаан бол toast 3с-д арилдаг тул URL-ээс өмнө
    await expect(page).toHaveURL(new RegExp(`/customer/${NEW_ID}$`));
    await expect(page.getByTestId('customer-created-banner')).toBeVisible(); // карт дээр тогтвортой баннер
    const sent = api.lastCall('POST', '/customers')?.body as Record<string, unknown>;
    expect(sent).toMatchObject({ customerType: 'LEGAL_ENTITY', registerNo: LEGAL, source: 'MANUAL', firstName: 'Нэгдэл ХХК', phone: '77112233' });
    expect(sent).not.toHaveProperty('xypSnapshotToken');
  });

  test('иргэн (УБ…) өмнөх шигээ иргэний кодын алхамтай: lookup биш xyp-otp дуудна', async ({ page }) => {
    const api = new MockApi('OFFICER');
    await api.install(page);
    api.get('/customers/lookup', { json: lookup() });
    api.post('/customers/xyp-otp', { json: { sent: true, requestedAt: new Date().toISOString(), existing: null, warnings: [] } });
    await page.goto('/customer/new');
    await page.getByTestId('customer-register').fill('уб90010112');
    await page.getByTestId('customer-check').click();
    await expect(page.getByTestId('xyp-otp-step')).toBeVisible();
    await expect(page.getByText('Иргэний зөвшөөрөл')).toBeVisible();
    expect(api.callsTo('GET', '/customers/lookup')).toHaveLength(0);
  });
});
